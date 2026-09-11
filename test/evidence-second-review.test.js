import test from "node:test";
import assert from "node:assert/strict";
import { clone, sha256 } from "../src/core.js";
import { EvidenceStore, modelDiagnostic } from "../src/evidence.js";
import { makeWorld, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn } from "../src/contracts.js";
import { AgentRuntime, DeterministicModel, PILOT_0_AGENT_CONDITIONS } from "../src/agent.js";
import { MemoryStore, reconstructMemoryState, MEMORY_CONTRACT, MEMORY_PARSER_HASH, MEMORY_PHASE_INSTRUCTION, parseMemoryOperation } from "../src/memory.js";
import { Qwen35BaseAdapter } from "../src/model-adapter.js";
import { reconstructRun, replay, createAuthorizationContext, verifyEvidenceIntegrity } from "../src/replay.js";
import { executeTurnPhaseCommand } from "../src/turn-phases.js";

// Explicitly synthetic: no weights, model process, network, or empirical runs.
function fixture() {
  const world = makeWorld({ runId: "synthetic-evidence-second-review", seed: "evidence-second-review" });
  resolveTurn(world, commitTurn(world, new ActionLedger(world.evidence), []));
  const model = new DeterministicModel("evidence-second-review");
  const runtime = new AgentRuntime({ world, actorId: "polity-1", model, now: () => 0 });
  const result = runtime.invoke();
  return { world, model, runtime, result };
}
function certify(bundle) {
  return replay(bundle, { expectedRunId: bundle.run_id, authorizationContext: createAuthorizationContext("trusted_replay") });
}
function append(store, event) {
  const payload = clone(event.payload); delete payload.payload_ref;
  return store.append({ eventType: event.event_type, turn: event.turn, phase: event.phase, payload,
    participants: event.participants, visibility: event.visibility, causality: event.causality,
    lineage: event.lineage, provenance: event.provenance, rng: event.rng, source: event.provenance.source });
}
function rehash(bundle) {
  const store = new EvidenceStore(bundle.run_id);
  store.payloads = new Map(Object.entries(clone(bundle.payloads)));
  for (const event of bundle.events) append(store, event);
  return store.bundle();
}
function put(bundle, value) {
  const store = new EvidenceStore(bundle.run_id), ref = store.putPayload(value);
  bundle.payloads[ref] = store.payloads.get(ref); return ref;
}

test("recovery restores persistent memory, counters and head before a canonical session transfer", () => {
  const { world, model, runtime, result } = fixture();
  runtime.memory.write("retained relational-history canary", runtime.sessionId, "synthetic-seed", world.turn);
  const saved = { records: runtime.memory.records, sequence: runtime.memory.sequence, head: runtime.memory.headEventId, session: runtime.sessionId };
  const recovered = reconstructRun(world.evidence.bundle(), { allowPendingCommit: true });
  assert.deepEqual(recovered.memories.get("polity-1").records, saved.records);
  const resumed = new AgentRuntime({ world: recovered.world, actorId: "polity-1", model, now: () => 0 });
  assert.deepEqual(resumed.memory.records, saved.records);
  assert.equal(resumed.memory.sequence, saved.sequence + 1);
  assert.notEqual(resumed.sessionId, saved.session);
  const transfer = recovered.world.evidence.events.at(-1);
  assert.equal(transfer.payload.operation, "recover");
  assert.deepEqual(transfer.lineage.parent_event_ids, [saved.head]);
  const request = JSON.parse(recovered.world.evidence.payloads.get(transfer.payload.input_refs[1]).bytes);
  assert.equal(request.previous_session, saved.session); assert.equal(request.next_session, resumed.sessionId);
  assert.equal(request.expected_hash, sha256(saved.records));
  resumed.invoke();
  const last = recovered.world.evidence.events.at(-1);
  assert.equal(last.payload.condition_id, "pilot0-history-access");
  assert.equal(last.payload.memory_refs.length, 1);
  const ids = recovered.world.evidence.events.filter(e => e.event_type === "MemoryOperation").map(e => e.payload.operation_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(certify(recovered.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("recovery rejects a changed treatment or runtime manifest", () => {
  const { world, model } = fixture();
  const recovered = reconstructRun(world.evidence.bundle());
  assert.throws(() => new AgentRuntime({ world: recovered.world, actorId: "polity-1", model,
    condition: PILOT_0_AGENT_CONDITIONS.nonpersistent }), /treatment/);
  assert.throws(() => new AgentRuntime({ world: recovered.world, actorId: "polity-1", model: new DeterministicModel("substituted") }), /configuration mismatch/);
});

test("state-only recovery remains empty and records session transfer", () => {
  const { world, model } = fixture();
  const actorId = "polity-2", condition = PILOT_0_AGENT_CONDITIONS.nonpersistent;
  const first = new AgentRuntime({ world, actorId, model, condition, now: () => 0 }); first.invoke();
  const recovered = reconstructRun(world.evidence.bundle());
  const next = new AgentRuntime({ world: recovered.world, actorId, model, condition, now: () => 0 }); next.invoke();
  assert.deepEqual(next.memory.records, []); assert.notEqual(next.sessionId, first.sessionId);
  assert.throws(() => next.memory.write("forbidden", next.sessionId, "edit"), /inaccessible/);
  assert.equal(certify(recovered.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("all memory requests independently reconstruct their state and reject stale live writers", () => {
  const evidence = new EvidenceStore("synthetic-memory-second-review"), identityId = "p1";
  const m = new MemoryStore({ evidence, runId: evidence.runId, identityId, sessionId: "s" });
  const a = m.write("alpha", "s", "i1"), b = m.write("beta", "s", "i2");
  m.edit(a, "alpha edited", "s", "i3"); m.revise(b, "β", "s", "i4");
  const c = m.compress([a, b], "compact", "s", "i5"); m.read({ sessionId: "s", invocationId: "i6" });
  m.forget(c, "s", "i7"); m.clear("s", "i8"); m.write("survivor", "s", "i9");
  m.recover({ sessionId: "s", nextSessionId: "next", invocationId: "i10", expectedHash: sha256(m.records) });
  const restored = new MemoryStore({ evidence, runId: evidence.runId, identityId });
  assert.deepEqual(restored.records, m.records); assert.equal(restored.sequence, m.sequence);
  assert.equal(restored.headEventId, m.headEventId); assert.equal(restored.ownerSessionId, "next");
  restored.write("new", "next", "i11");
  assert.throws(() => m.write("stale", "next", "i12"), /stale memory/);
  assert.deepEqual(reconstructMemoryState(evidence, identityId).records, restored.records); evidence.verify();
});

for (const [name, mutate] of [
  ["READ changes memory", (b, e) => { e.payload.output_ref = put(b, { records: [], text: "fabricated" }); }],
  ["duplicate operation counter", (_b, e) => { e.payload.operation_id = "duplicate"; }],
  ["disconnected head", (_b, e) => { e.lineage.parent_event_ids = []; }],
  ["wrong owner", (_b, e) => { e.payload.session_ref = "unowned"; }],
  ["incorrect capacity", (_b, e) => { e.payload.capacity_after.used_bytes++; }],
  ["forged current input", (b, e) => { e.payload.input_refs[0] = put(b, { records: [], text: "not current" }); }]
]) test("canonical memory rejects " + name + " after complete rehashing", () => {
  const { world, runtime, result } = fixture();
  runtime.memory.write("original", runtime.sessionId, "synthetic-seed", world.turn);
  runtime.memory.read({ sessionId: runtime.sessionId, invocationId: "synthetic-read", turn: world.turn });
  const bundle = world.evidence.bundle(); mutate(bundle, bundle.events.at(-1));
  assert.throws(() => certify(rehash(bundle)), /memory/);
});

test("missing parsed action is rejected even with untouched signed event bytes", () => {
  const { world } = fixture(), bundle = world.evidence.bundle();
  delete bundle.payloads[bundle.events.at(-1).payload.action_ref];
  assert.throws(() => verifyEvidenceIntegrity(bundle), /missing or corrupt external input evidence/);
  assert.throws(() => certify(bundle), /missing or corrupt external input evidence/);
});

for (const field of ["request_ref", "response_ref", "configuration_ref", "parsed_output_ref", "runtime_attestation_ref", "artifact_attestation_ref"])
  test("typed model diagnostic closure rejects missing " + field, () => {
    const { world } = fixture(), bundle = world.evidence.bundle(), event = bundle.events.at(-1);
    const original = modelDiagnostic(world.evidence, event), diagnostic = clone(original);
    diagnostic[field] = "a".repeat(64);
    // Match structurally, independent of canonical object-key order.
    const index = event.provenance.input_refs.findIndex(ref => JSON.parse(bundle.payloads[ref].bytes).stage === "complete");
    assert(index >= 0); event.provenance.input_refs[index] = put(bundle, diagnostic);
    assert.throws(() => certify(rehash(bundle)), /missing or corrupt external input evidence/);
  });

for (const [name, mutate] of [
  ["future turn", e => { e.turn = 9000; }],
  ["another principal", e => { e.participants = ["polity-3"]; }],
  ["session disagreement", e => { e.lineage.session_ids = ["unrelated"]; }],
  ["invocation disagreement", e => { e.lineage.invocation_ids = ["unrelated"]; }],
  ["missing envelope lineage", e => { e.lineage.session_ids = []; }],
  ["missing retry", e => { e.payload.retry_of = "absent"; e.payload.attempt = 2; }],
  ["completion input change", e => { e.payload.rendered_input_ref = e.payload.rendered_output_ref; }]
]) test("invocation rejects " + name + " after complete rehashing", () => {
  const { world } = fixture(), bundle = world.evidence.bundle(); mutate(bundle.events.at(-1));
  assert.throws(() => certify(rehash(bundle)), /invocation|completion|projection/);
});

test("dispatch-only recovery remains pending and cannot certify exact replay", () => {
  const { world } = fixture(), bundle = world.evidence.bundle(); bundle.events.pop();
  const recovered = reconstructRun(bundle, { allowPendingCommit: true });
  assert.equal([...recovered.invocations.values()].at(-1).stage, "dispatch");
  assert.throws(() => certify(bundle), /unresolved model invocation/);
});

test("missing dispatch and duplicate completions cannot be certified", () => {
  const { world } = fixture(), bundle = world.evidence.bundle();
  const dispatch = bundle.events.findLast(e => e.event_type === "ModelInvocation" &&
    e.payload.action_ref === null);
  dispatch.event_type = "Violation"; dispatch.payload = { synthetic: true };
  assert.throws(() => certify(rehash(bundle)), /completion without/);
  append(world.evidence, world.evidence.events.at(-1));
  assert.throws(() => certify(world.evidence.bundle()), /completion without/);
});

function phaseFixture() {
  const world = makeWorld({ runId: "synthetic-phase-second-review", seed: "phase-replay" });
  const ledger = new ActionLedger(world.evidence);
  const bindings = Object.keys(world.polities).map(actorId => ({ actorId, sessionId: "phase-session-" + actorId,
    condition: clone(PILOT_0_AGENT_CONDITIONS.nonpersistent) }));
  let state = null;
  const command = (operation, input = {}, at = state?.opened_at ?? 0) => {
    const result = executeTurnPhaseCommand({ world, ledger, state, bindings, command: { operation, input }, at });
    state = result.phaseState; return result;
  };
  command("begin");
  while (!state.closed) {
    if (state.phase === "diplomacy") command("diplomacy", { actorId: "polity-1",
      actor: { persistent_identity_id: "polity-1", session_id: bindings[0].sessionId, invocation_id: "synthetic-human-command" },
      requestId: "broadcast", command: { type: "broadcast", text: "Immediate synthetic diplomacy." } });
    const deadlinePhase = ["observation", "private_planning", "diplomacy", "final_planning", "consequence_reveal", "memory_update", "interview"].includes(state.phase);
    command("advance", {}, deadlinePhase ? state.deadline_at : state.opened_at);
  }
  return { world, state, bindings };
}

test("phase commands independently regenerate immediate diplomacy, empty commitment and post-memory snapshot", () => {
  const { world, state, bindings } = phaseFixture();
  const recovered = reconstructRun(world.evidence.bundle());
  assert.equal(recovered.resolvedTurns, 1); assert.equal(recovered.pendingCommit, null);
  assert.deepEqual(recovered.phaseState, state); assert.deepEqual(recovered.phaseBindings, bindings);
  assert.deepEqual(recovered.world.authoritativeState(), world.authoritativeState());
  assert.equal(recovered.world.evidence.previousHash, world.evidence.previousHash);
  const message = world.evidence.events.find(e => e.event_type === "MessageSent");
  assert(message.sequence < world.evidence.events.find(e => e.event_type === "TurnCommitted").sequence);
  assert.equal(certify(world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("phase replay rejects fully rehashed fabricated outputs and invalid recorded clocks", () => {
  const { world } = phaseFixture();
  const changed = world.evidence.bundle();
  changed.events.find(e => e.payload.mechanic === "turn_phase_state").payload.detail.reason = "fabricated_phase";
  assert.throws(() => reconstructRun(rehash(changed)), /phase command re-execution/);
  const badClock = world.evidence.bundle(), event = badClock.events.find(e => e.payload.mechanic === "turn_phase_command");
  const input = JSON.parse(badClock.payloads[event.payload.detail.command_ref].bytes); input.at = -1;
  event.payload.detail.command_ref = put(badClock, input);
  assert.throws(() => reconstructRun(rehash(badClock)), /clock/);
});

test("truncated phase command output cannot become a recoverable generation", () => {
  const { world } = phaseFixture(), bundle = world.evidence.bundle(); bundle.events.pop();
  assert.throws(() => reconstructRun(bundle, { allowPendingCommit: true }), /phase command re-execution/);
});

function phaseAgentFixture(operation = { operation: "REMEMBER", text: "chosen exact memory" }, { failFirst = false } = {}) {
  const world = makeWorld({ runId: "synthetic-agent-phase-review", seed: "phase-agent" });
  const ledger = new ActionLedger(world.evidence), prompts = [];
  let state = null, clock = 0, completion = operation;
  const model = new Qwen35BaseAdapter({ model: "Qwen/Qwen3.5-9B-Base", revision: "a".repeat(40),
    backend: "hf_endpoint", baseUrl: "https://synthetic.invalid/v1", artifactHash: "1".repeat(64),
    tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64), synthetic: true,
    transport: async request => {
      const prompt = JSON.parse(request.body).prompt; prompts.push(prompt);
      if (failFirst && prompts.length === 1) return { status: 503, body: Buffer.from("synthetic infrastructure failure") };
      const text = JSON.stringify(prompt.startsWith(MEMORY_PHASE_INSTRUCTION) ? completion : { type: "wait" });
      return { status: 200, body: Buffer.from(JSON.stringify({ model: "Qwen/Qwen3.5-9B-Base", hf_revision: "a".repeat(40),
        artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64),
        choices: [{ text, finish_reason: "stop" }] })) };
    } });
  const runtime = new AgentRuntime({ world, actorId: "polity-1", model, now: () => clock });
  const bindings = Object.keys(world.polities).map(actorId => ({ actorId,
    sessionId: actorId === runtime.actorId ? runtime.sessionId : "phase-session-" + actorId,
    condition: clone(actorId === runtime.actorId ? runtime.condition : PILOT_0_AGENT_CONDITIONS.nonpersistent) }));
  const command = (operation, input = {}, at = state?.opened_at ?? 0) => {
    clock = at;
    const result = executeTurnPhaseCommand({ world, ledger, state, bindings, command: { operation, input }, at });
    state = result.phaseState; return result;
  };
  const advance = () => command("advance", {}, ["observation", "private_planning", "diplomacy", "final_planning", "consequence_reveal", "memory_update", "interview"].includes(state.phase) ? state.deadline_at : state.opened_at);
  const until = phase => { while (state.phase !== phase && !state.closed) advance(); };
  command("begin");
  return { world, runtime, prompts, command, advance, until, state: () => state,
    setClock: at => { clock = at; }, setCompletion: value => { completion = value; } };
}

test("actual AgentRuntime uses canonical final-planning and post-resolution memory clocks; phase commands reexecute", async () => {
  const f = phaseAgentFixture(); f.until("final_planning");
  const action = await f.runtime.invoke();
  assert.equal(action.projection.logical_time.phase, "final_planning");
  assert.equal(f.world.phase, "actions");
  f.command("submit_model", { actorId: f.runtime.actorId, result: action });
  f.until("memory_update");
  const memory = await f.runtime.invoke();
  assert.equal(memory.projection.logical_time.turn, f.world.turn - 1);
  assert.equal(memory.action, null); assert.equal(memory.actions, null);
  assert.deepEqual(memory.memoryOperation, { operation: "REMEMBER", text: "chosen exact memory" });
  const invocation = f.world.evidence.events.at(-1);
  assert.equal(invocation.payload.parser_hash, MEMORY_PARSER_HASH);
  assert.equal(modelDiagnostic(f.world.evidence, invocation).deadline, f.state().deadline_at);
  f.command("update_memory", { actorId: f.runtime.actorId, request: memory.memoryOperation,
    context: { invocationId: memory.invocationId } });
  while (!f.state().closed) f.advance();
  const reconstructed = reconstructRun(f.world.evidence.bundle());
  assert.equal(reconstructed.memories.get(f.runtime.actorId).records[0].text, "chosen exact memory");
  assert.equal(certify(f.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("memory phase exposes stable handles, schema and atomic capacity policy; exact EDIT replays", async () => {
  const f = phaseAgentFixture();
  const id = f.runtime.memory.write("original", f.runtime.sessionId, "synthetic-seed", f.world.turn);
  f.until("memory_update"); f.setCompletion({ operation: "EDIT", id, text: "exact replacement" });
  const result = await f.runtime.invoke();
  const prompt = f.prompts.at(-1), data = JSON.parse(prompt.split("\nDATA=")[1].split("\nCONTINUATION")[0]);
  const contract = data.projection.memory_interface;
  assert.deepEqual(contract.records, [{ id, text: "original" }]);
  assert.equal(contract.capacity.bytes, f.world.config.memory.capacity);
  assert.equal(contract.overflow_policy, "reject_atomically");
  assert.deepEqual(contract.operation_schema.EDIT.required, ["operation", "id", "text"]);
  assert.equal(contract.operation_schema.EDIT.additionalProperties, false);
  f.command("update_memory", { actorId: f.runtime.actorId, request: result.memoryOperation, context: { invocationId: result.invocationId } });
  while (!f.state().closed) f.advance();
  assert.equal(certify(f.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("wait completion cannot authorize unrelated memory through either runtime or memory store", () => {
  const { runtime, result } = fixture(), request = { operation: "REMEMBER", text: "fictional" };
  assert.throws(() => runtime.applyMemoryOperation(request, { invocationId: result.invocationId }), /memory_update/);
  assert.throws(() => runtime.memory.apply(request, { sessionId: runtime.sessionId, invocationId: result.invocationId }), /phase-memory completion/);
  assert.deepEqual(runtime.memory.records, []);
});

test("memory completion cannot authorize different text or be consumed twice", async () => {
  const f = phaseAgentFixture(); f.until("memory_update"); const result = await f.runtime.invoke();
  const before = f.world.evidence.events.length;
  assert.throws(() => f.runtime.applyMemoryOperation({ ...result.memoryOperation, text: "fabricated" }, { invocationId: result.invocationId }), /exact parsed completion/);
  assert.equal(f.world.evidence.events.length, before);
  f.runtime.applyMemoryOperation(result.memoryOperation, { invocationId: result.invocationId });
  assert.throws(() => f.runtime.applyMemoryOperation(result.memoryOperation, { invocationId: result.invocationId }), /already consumed/);
  f.world.evidence.verify();
  const bundle = f.world.evidence.bundle(), operation = bundle.events.at(-1);
  const changedRequest = { ...result.memoryOperation, text: "forged" };
  operation.payload.input_refs[1] = put(bundle, changedRequest);
  assert.throws(() => verifyEvidenceIntegrity(rehash(bundle)), /exact parsed completion/);
});

test("memory parser rejects action output, unknown handles, overflow and extra fields without retries", async () => {
  for (const request of [{ action_id: "wait", type: "wait" }, { operation: "EDIT", id: "unknown", text: "x" },
    { operation: "REMEMBER", text: "x".repeat(100000) }, { operation: "CLEAR", hidden: "extra" }]) {
    const f = phaseAgentFixture(request); f.until("memory_update");
    await assert.rejects(f.runtime.invoke(), /invalid_memory_operation/);
    assert.equal(f.prompts.length, 1); assert.deepEqual(f.runtime.memory.records, []);
    const event = f.world.evidence.events.at(-1);
    assert.equal(modelDiagnostic(f.world.evidence, event).classification, "agent_output");
    assert.equal(event.payload.action_ref, null);
    assert.throws(() => parseMemoryOperation(JSON.stringify(request), { records: [], capacity: 240 }));
  }
});

test("late memory invocation retains controller deadline and cannot write memory", async () => {
  const f = phaseAgentFixture(); f.until("memory_update"); f.setClock(f.state().deadline_at);
  await assert.rejects(f.runtime.invoke(), /phase_deadline_exceeded/);
  assert.equal(f.prompts.length, 0); assert.deepEqual(f.runtime.memory.records, []);
});

test("runtime refreshes the phase controller's canonical memory head before its next invocation", async () => {
  const f = phaseAgentFixture(); f.until("memory_update");
  const first = await f.runtime.invoke();
  f.command("update_memory", { actorId: f.runtime.actorId, request: first.memoryOperation, context: { invocationId: first.invocationId } });
  const state = reconstructMemoryState(f.world.evidence, f.runtime.actorId);
  f.setCompletion({ operation: "EDIT", id: state.records[0].id, text: "second exact operation" });
  const second = await f.runtime.invoke();
  assert.equal(f.runtime.memory.records[0].text, "chosen exact memory");
  assert.equal(f.runtime.memory.sequence, state.sequence + 1);
  f.command("update_memory", { actorId: f.runtime.actorId, request: second.memoryOperation, context: { invocationId: second.invocationId } });
  while (!f.state().closed) f.advance();
  assert.equal(reconstructRun(f.world.evidence.bundle()).memories.get(f.runtime.actorId).records[0].text, "second exact operation");
  assert.equal(certify(f.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("explicit READ is a bound phase completion, preserves state and cannot be consumed twice", async () => {
  const request = { operation: "READ", retrieval: MEMORY_CONTRACT.retrieval };
  const f = phaseAgentFixture(request); f.until("memory_update");
  const result = await f.runtime.invoke();
  f.runtime.applyMemoryOperation(request, { invocationId: result.invocationId });
  assert.throws(() => f.runtime.applyMemoryOperation(request, { invocationId: result.invocationId }), /already consumed/);
  f.world.evidence.verify();
  while (!f.state().closed) f.advance();
  assert.equal(certify(f.world.evidence.bundle()).status, "EXACT_REPLAY");
});

test("actual infrastructure retry independently replays and rejects an ineligible predecessor", async () => {
  const f = phaseAgentFixture(undefined, { failFirst: true }); f.until("final_planning");
  const result = await f.runtime.invoke(); assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[0], f.prompts[1]);
  f.command("submit_model", { actorId: f.runtime.actorId, result });
  while (!f.state().closed) f.advance();
  assert.equal(certify(f.world.evidence.bundle()).status, "EXACT_REPLAY");
  const bundle = f.world.evidence.bundle(), event = bundle.events.find(e => e.event_type === "ModelInvocation" &&
    modelDiagnostic(f.world.evidence, e)?.classification === "infrastructure");
  const index = event.provenance.input_refs.findIndex(ref => JSON.parse(bundle.payloads[ref].bytes).stage === "complete");
  const diagnostic = JSON.parse(bundle.payloads[event.provenance.input_refs[index]].bytes);
  diagnostic.retryable = false; event.provenance.input_refs[index] = put(bundle, diagnostic);
  assert.throws(() => certify(rehash(bundle)), /invalid invocation retry predecessor/);
});

for (const [name, mutate] of [
  ["late success", d => { d.recorded_at = d.deadline; }],
  ["clock reversal", d => { d.recorded_at = -1; }],
  ["renewed deadline", d => { d.deadline += 1; }]
]) test("invocation rejects fully rehashed " + name, () => {
  const { world } = fixture(), bundle = world.evidence.bundle(), event = bundle.events.at(-1);
  const index = event.provenance.input_refs.findIndex(ref => JSON.parse(bundle.payloads[ref].bytes).stage === "complete");
  const diagnostic = JSON.parse(bundle.payloads[event.provenance.input_refs[index]].bytes);
  mutate(diagnostic); event.provenance.input_refs[index] = put(bundle, diagnostic);
  assert.throws(() => certify(rehash(bundle)), /invocation|deadline/);
});
