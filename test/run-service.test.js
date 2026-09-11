import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SignedArchive, archiveKeyId } from "../src/archive.js";
import { RunService } from "../src/run-service.js";
import { makeWorld } from "../src/world.js";
import { projectWorld } from "../src/contracts.js";
import { MemoryStore } from "../src/memory.js";
import { canonicalize } from "../src/core.js";
import { AgentRuntime } from "../src/agent.js";
import { Qwen35BaseAdapter } from "../src/model-adapter.js";
import { Confidant } from "../src/confidant.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "civlab-run-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), runId = "synthetic-service-fixture";
  const binding = { directory, runId, ...keys, keyId: archiveKeyId(keys.publicKey) };
  const archive = new SignedArchive(binding);
  const service = await RunService.create({ world: makeWorld({ runId, seed: "synthetic-service" }), archive });
  return { service, archive, binding, restart: () => RunService.recover({ archive: new SignedArchive(binding) }) };
}
function submission(actorId = "polity-1", type = "wait") {
  return { requestId: "submit-" + actorId, actorId, actor: { persistent_identity_id: actorId, session_id: "session-" + actorId,
    invocation_id: "invocation-" + actorId }, actions: [{ action_id: "action-" + actorId, type }], turnId: "turn-0" };
}
async function prepareTurn(service) {
  const validated = await Promise.all(Object.keys(service.world.polities).map(id => service.submitAndValidate(submission(id))));
  return validated.map(item => item.submission.submission_id);
}
function interviewModel() {
  return new Qwen35BaseAdapter({ synthetic: true, model: "Qwen/Qwen3.5-9B-Base", revision: "a".repeat(40), backend: "mlx",
    artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64),
    transport: async () => ({ status: 200, body: JSON.stringify({ model: "Qwen/Qwen3.5-9B-Base", hf_revision: "a".repeat(40),
      artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64),
      choices: [{ text: "Synthetic interview recovery fixture.", finish_reason: "stop" }] }) }) });
}

test("service persists submitted/validated/accepted/committed/resolved state and caches retry responses", async t => {
  const f = await fixture(t);
  let service = f.service;
  const ids = await prepareTurn(service);
  const submittedCount = service.world.evidence.events.filter(event => event.event_type === "ActionSubmitted").length;
  service = await f.restart();
  const serverWorld = service.world;
  assert.equal(service.ledger.submissions.size, 3);
  const duplicate = await service.submitAndValidate(submission());
  assert(ids.includes(duplicate.submission.submission_id));
  assert.equal(service.world.evidence.events.filter(event => event.event_type === "ActionSubmitted").length, submittedCount);
  const commit = await service.commit({ requestId: "commit-0", submissionIds: ids });
  service = await f.restart();
  assert.equal(service.pendingCommit.turn_committed_id, commit.turn_committed_id);
  assert([...service.ledger.submissions.values()].every(item => item.status === "accepted"));
  const result = await service.resolve({ requestId: "resolve-0", committedId: commit.turn_committed_id });
  assert.equal(serverWorld.turn, 0); // this facade belongs to the earlier service instance
  const bytes = canonicalize(service.world.evidence.bundle());
  service = await f.restart();
  assert.equal(service.pendingCommit, null);
  assert.deepEqual(await service.resolve({ requestId: "resolve-0", committedId: commit.turn_committed_id }), result);
  assert.equal(canonicalize(service.world.evidence.bundle()), bytes);
  assert.equal(service.world.turn, 1);
});

test("server facade follows committed transactions and participant controls stay principal scoped", async t => {
  const { service } = await fixture(t);
  const serverWorld = service.world;
  assert.equal((await service.participantState("polity-1")).controls.execution_enabled, false);
  assert.throws(() => service.submitParticipantActions({}), /not enabled/);
  service.allowSyntheticExecution = true;
  const state = await service.participantState("polity-1");
  const receipt = await service.submitParticipantActions({ principalId: "polity-1", actions: [{ action_id: "ui-action", type: "wait" }],
    turn: state.projection.logical_time.turn, projectionId: state.projection.projection_id });
  assert.equal(receipt.status, "submitted");
  assert.equal((await service.participantState("polity-1")).controls.can_submit, false);
  assert.equal((await service.participantState("polity-2")).controls.submission_status, "none");
  const others = await Promise.all(["polity-2", "polity-3"].map(id => service.submitAndValidate(submission(id))));
  const commit = await service.commit({ requestId: "ui-commit", submissionIds: [receipt.submission_id, ...others.map(item => item.submission.submission_id)] });
  await service.resolve({ requestId: "ui-resolve", committedId: commit.turn_committed_id });
  assert.equal(serverWorld.turn, 1);
  assert.equal(service.world, serverWorld);
});

test("duplicate concurrent submissions are exactly once; conflicting request reuse fails", async t => {
  const { service } = await fixture(t);
  const [first, second] = await Promise.all([service.submit(submission()), service.submit(submission())]);
  assert.deepEqual(first, second);
  assert.equal(service.ledger.submissions.size, 1);
  await assert.rejects(service.submit({ ...submission(), actions: [{ action_id: "substitution", type: "wait" }] }), /different input/);
});

test("queued submission snapshots caller-owned action bytes", async t => {
  const { service } = await fixture(t), input = submission();
  const submitting = service.submit(input);
  input.actions[0].type = "substituted-after-call";
  assert.equal((await submitting).actions[0].type, "wait");
});

test("live privacy purge quarantines captured server facades and recovery", async t => {
  const { service, archive, restart } = await fixture(t);
  archive.authorizeRedaction = () => true;
  const worldView = service.world, capturedSnapshot = worldView.authoritativeState;
  await service.checkpoint({ requestId: "private-memory", kind: "memory", identity: { synthetic: true }, mutate: world => {
    new MemoryStore({ runId: world.runId, identityId: "polity-1", evidence: world.evidence, sessionId: "privacy-session" })
      .write("private-memory-canary", "privacy-session", "privacy-invocation");
  } });
  const memory = service.world.evidence.events.find(event => event.event_type === "MemoryOperation");
  await service.redact({ artifactRef: memory.payload.output_ref, fieldOrRange: "text", reason: "consent_withdrawal", authority: "fixture-policy" });
  assert.throws(() => worldView.evidence, /REPLAY_INCOMPLETE_REDACTED/);
  assert.throws(capturedSnapshot, /REPLAY_INCOMPLETE_REDACTED/);
  assert.equal(service.status.status, "REPLAY_INCOMPLETE_REDACTED");
  await assert.rejects(restart(), /REPLAY_INCOMPLETE_REDACTED/);
  assert.equal(canonicalize(await archive.load()).includes("private-memory-canary"), false);
});

test("commit refuses partial actor sets and rejected actions remain canonical evidence", async t => {
  const { service, restart } = await fixture(t);
  const invalid = await service.submitAndValidate(submission("polity-1", "nonexistent_action"));
  assert.equal(invalid.submission.status, "rejected");
  let recovered = await restart();
  assert(recovered.world.evidence.events.some(event => event.event_type === "ActionRejected"));
  await assert.rejects(recovered.submitAndValidate({ ...submission(), requestId: "retry", priorSubmissionId: invalid.submission.submission_id }), /corrective retry/);
  const valid = await recovered.submitAndValidate(submission("polity-2"));
  await assert.rejects(recovered.commit({ requestId: "partial", submissionIds: [valid.submission.submission_id] }), /complete active actor/);
  recovered = await restart();
  assert.equal(recovered.pendingCommit, null);
});

for (const boundary of ["before_submission", "after_submission", "submission:after_generation_fsync", "submission:before_pointer_publish", "submission:after_pointer_publish", "after_submission_persist"]) {
  test("submission crash/retry: " + boundary, async t => {
    const { service, restart } = await fixture(t);
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.submit(submission()), /crash/);
    const recovered = await restart();
    await recovered.submit(submission());
    assert.equal(recovered.ledger.submissions.size, 1);
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "ActionSubmitted").length, 1);
  });
}

for (const boundary of ["before_commit", "before_event:ActionAccepted", "after_event:ActionAccepted", "before_event:TurnCommitted", "after_event:TurnCommitted", "after_commit", "commit:after_generation_fsync", "commit:before_pointer_publish", "commit:after_pointer_publish", "after_commit_persist"]) {
  test("commit crash preserves the atomic complete accepted set: " + boundary, async t => {
    const { service, restart } = await fixture(t);
    const ids = await prepareTurn(service);
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.commit({ requestId: "commit", submissionIds: ids }), /crash/);
    const recovered = await restart();
    await recovered.commit({ requestId: "commit", submissionIds: ids });
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "TurnCommitted").length, 1);
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "ActionAccepted").length, 3);
  });
}

for (const boundary of ["before_validation", "after_validation", "before_event:ActionValidated", "after_event:ActionValidated", "validation:before_pointer_publish", "validation:after_pointer_publish"]) {
  test("validation crash is idempotent: " + boundary, async t => {
    const { service, restart } = await fixture(t);
    const submitted = await service.submit(submission());
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.validate({ requestId: "validate", submissionId: submitted.submission_id }), /crash/);
    const recovered = await restart();
    await recovered.validate({ requestId: "validate", submissionId: submitted.submission_id });
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "ActionValidated").length, 1);
  });
}

for (const kind of ["memory", "projection", "interview"]) for (const stage of ["before", "after", "before_publish", "after_publish"]) {
  test(kind + " checkpoint crash: " + stage, async t => {
    const { service, restart } = await fixture(t);
    if (kind === "interview") {
      const commit = await service.commit({ requestId: "interview-commit", submissionIds: await prepareTurn(service) });
      await service.resolve({ requestId: "interview-resolve", committedId: commit.turn_committed_id });
    }
    const options = { requestId: "checkpoint-" + kind, kind, identity: { synthetic: true }, mutate: async world => {
      if (kind === "memory") {
        new MemoryStore({ runId: world.runId, identityId: "polity-1", evidence: world.evidence, sessionId: "session" })
          .write("synthetic memory", "session", "invocation");
      } else if (kind === "projection") world.evidence.append({ eventType: "ProjectionIssued", turn: world.turn, phase: "actions", payload: projectWorld(world, "polity-1") });
      else {
        const runtime = new AgentRuntime({ world, actorId: "polity-1", model: interviewModel(), now: () => 0 });
        const reports = await new Confidant({ world, now: () => 0 }).interviewAll([runtime]);
        assert.equal(reports[0].status, "recorded");
      }
    } };
    const boundary = { before: "before_" + kind, after: "after_" + kind, before_publish: kind + ":before_pointer_publish", after_publish: kind + ":after_pointer_publish" }[stage];
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.checkpoint(options), /crash/);
    const recovered = await restart();
    await recovered.checkpoint(options);
    const type = { memory: "MemoryOperation", projection: "ProjectionIssued", interview: "InterviewResponse" }[kind];
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === type).length, 1);
  });
}

for (const point of ["after_event:SnapshotCreated", "resolution:after_generation_fsync", "resolution:after_pointer_publish"]) {
  test("OS process exit recovers durable resolution: " + point, async t => {
    const { service, binding, restart } = await fixture(t);
    const commit = await service.commit({ requestId: "commit", submissionIds: await prepareTurn(service) });
    const source = `
      import { SignedArchive } from ${JSON.stringify(new URL("../src/archive.js", import.meta.url).href)};
      import { RunService } from ${JSON.stringify(new URL("../src/run-service.js", import.meta.url).href)};
      let input = ""; for await (const chunk of process.stdin) input += chunk;
      const { binding, point, committedId } = JSON.parse(input);
      const service = await RunService.recover({ archive: new SignedArchive(binding), fault: stage => { if (stage === point) process.exit(91); } });
      await service.resolve({ requestId: "resolve", committedId });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code)); });
    // Key material travels through a private pipe, never process argv or files.
    child.stdin.end(JSON.stringify({ binding: { ...binding, publicKey: binding.publicKey.export({ type: "spki", format: "pem" }),
      privateKey: binding.privateKey.export({ type: "pkcs8", format: "pem" }) }, point, committedId: commit.turn_committed_id }));
    assert.equal(await done, 91, errors);
    const recovered = await restart();
    await recovered.resolve({ requestId: "resolve", committedId: commit.turn_committed_id });
    assert.equal(recovered.world.turn, 1);
    const resolved = recovered.world.evidence.events.filter(event => event.event_type === "TurnResolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].payload.resulting_state_hash, recovered.world.stateHash());
    // Exercise the first event after the recovered publication boundary. This
    // catches a replay that retained completed-turn state while accepting a
    // next-turn ActionSubmitted envelope.
    const next = submission("polity-1");
    next.requestId = "post-recovery-submit:" + point;
    next.turnId = "turn-1";
    next.actor.invocation_id = "post-recovery-invocation:" + point;
    const submitted = await recovered.submit(next);
    assert.equal(submitted.turn_id, "turn-1");
    const restarted = await restart();
    assert.equal(restarted.world.turn, 1);
    assert.equal(restarted.world.evidence.events.filter(event => event.event_type === "ActionSubmitted").length, 4);
  });
}

for (const boundary of ["before_resolution", "after_event:ConflictResolved", "before_event:SnapshotCreated", "after_event:SnapshotCreated", "after_event:TurnResolved", "after_resolution", "resolution:after_generation_fsync", "resolution:after_pointer_publish"]) {
  test("resolution crash reexecutes once from durable commit: " + boundary, async t => {
    const { service, restart } = await fixture(t);
    const commit = await service.commit({ requestId: "commit", submissionIds: await prepareTurn(service) });
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.resolve({ requestId: "resolve", committedId: commit.turn_committed_id }), /crash/);
    const recovered = await restart();
    await recovered.resolve({ requestId: "resolve", committedId: commit.turn_committed_id });
    assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "TurnResolved").length, 1);
    assert.equal(recovered.world.turn, 1);
  });
}

test("memory and projection checkpoints preserve raw evidence through restart", async t => {
  const { service, restart } = await fixture(t);
  await service.checkpoint({ requestId: "projection", kind: "projection", identity: { actor: "polity-1" }, mutate: world => {
    world.evidence.append({ eventType: "ProjectionIssued", turn: 0, phase: "actions", payload: projectWorld(world, "polity-1") });
  } });
  await service.checkpoint({ requestId: "memory", kind: "memory", identity: { text: "synthetic memory" }, mutate: world => {
    const memory = new MemoryStore({ runId: world.runId, identityId: "polity-1", evidence: world.evidence, sessionId: "memory-session" });
    memory.write("synthetic memory", "memory-session", "memory-invocation");
  } });
  const recovered = await restart();
  assert.equal(canonicalize(recovered.world.evidence.bundle()), canonicalize(service.world.evidence.bundle()));
});

function modelCallbacks(counter) {
  const invocationId = "synthetic-model-call";
  function append(world, output) {
    const evidence = world.evidence, projection = projectWorld(world, "polity-1");
    const inputRef = evidence.putPayload({ synthetic: true, projection }), outputRef = evidence.putPayload(output);
    evidence.append({ eventType: "ModelInvocation", turn: world.turn, phase: "actions", participants: ["polity-1"],
      lineage: { persistent_identity_ids: ["polity-1"], session_ids: ["synthetic-session"], invocation_ids: [invocationId] },
      payload: { schema_version: "1.0.0", invocation_id: invocationId, session_id: "synthetic-session", run_id: world.runId,
        condition_id: "synthetic-validation", context_segments: [], rendered_input_ref: inputRef, rendered_output_ref: outputRef,
        model_runtime_hash: evidence.putPayload({ synthetic: true, live_validated: false }), parser_hash: "synthetic-parser",
        projection_ref: evidence.putPayload(projection), memory_refs: [], tool_result_refs: [], action_ref: null, attempt: 1, retry_of: null } });
  }
  return { requestId: "model", invocationId, identity: { synthetic: true },
    prepare: world => { append(world, { status: "dispatch" }); return { synthetic: true, input: "projection fixture" }; },
    invoke: async request => { assert.equal(request.synthetic, true); counter.calls++; return { output: "synthetic-result" }; },
    complete: (world, output) => { append(world, output); return output; } };
}

test("concurrent model requests invoke once and completion survives restart", async t => {
  const { service, restart } = await fixture(t), counter = { calls: 0 }, options = modelCallbacks(counter);
  const [a, b] = await Promise.all([service.invokeModel(options), service.invokeModel(options)]);
  assert.deepEqual(a, b); assert.equal(counter.calls, 1);
  const recovered = await restart();
  assert.deepEqual(await recovered.invokeModel(options), a);
  assert.equal(counter.calls, 1);
  assert.equal(recovered.world.evidence.events.filter(event => event.event_type === "ModelInvocation").length, 2);
});

for (const boundary of ["model_dispatch:after_pointer_publish", "before_model_call", "after_model_call", "before_model_completion", "model_completion:after_generation_fsync", "model_completion:after_pointer_publish"]) {
  test("model crash never silently repeats an uncertain external call: " + boundary, async t => {
    const { service, restart } = await fixture(t), counter = { calls: 0 }, options = modelCallbacks(counter);
    service.fault = point => { if (point === boundary) throw new Error("crash"); };
    await assert.rejects(service.invokeModel(options), /crash/);
    const calls = counter.calls, recovered = await restart();
    if (boundary === "model_completion:after_pointer_publish") await recovered.invokeModel(options);
    else {
      await assert.rejects(recovered.invokeModel(options), /MODEL_OUTCOME_UNKNOWN/);
      await assert.rejects(recovered.submit(submission()), /MODEL_OUTCOME_UNKNOWN/);
      await recovered.reconcileInvocation({ requestId: "provider-reconciliation", invocationId: options.invocationId,
        output: { output: "synthetic-provider-confirmed-result" }, complete: options.complete });
      assert.equal(recovered.status.unresolved_invocations.length, 0);
    }
    assert.equal(counter.calls, calls);
  });
}
