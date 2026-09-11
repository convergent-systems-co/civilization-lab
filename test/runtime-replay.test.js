import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, resolveTurn } from "../src/world.js";
import { Qwen35BaseAdapter } from "../src/model-adapter.js";
import { AgentRuntime } from "../src/agent.js";
import { Confidant } from "../src/confidant.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { replay, createAuthorizationContext } from "../src/replay.js";

function syntheticModel(actorId) {
  return new Qwen35BaseAdapter({ synthetic: true, model: "Qwen/Qwen3.5-9B-Base", revision: "a".repeat(40),
    backend: "mlx", artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64),
    transport: async request => ({ status: 200, body: JSON.stringify({ model: "Qwen/Qwen3.5-9B-Base", hf_revision: "a".repeat(40),
      artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64),
      choices: [{ text: JSON.parse(request.body).prompt.includes("private qualitative self-report") ? "Synthetic interview only." : JSON.stringify({ type: "wait" }), finish_reason: "stop" }] }) }) });
}

test("synthetic full turn plus isolated interviews regenerates identical reducer state and evidence", async () => {
  const world = makeWorld({ runId: "synthetic-runtime-replay" });
  const runtimes = Object.keys(world.polities).map(actorId => new AgentRuntime({ world, actorId, model: syntheticModel(actorId), now: () => 0 }));
  const ledger = new ActionLedger(world.evidence);
  const validated = [];
  for (const rt of runtimes) {
    const result = await rt.invoke();
    const submission = ledger.submit({ runId: world.runId, turnId: `turn-${world.turn}`, actorId: rt.actorId,
      actor: { persistent_identity_id: rt.actorId, session_id: rt.sessionId, invocation_id: result.invocationId },
      actions: [result.action], projection: projectWorld(world, rt.actorId) });
    validated.push(ledger.validate(submission, world));
  }
  resolveTurn(world, commitTurn(world, ledger, validated));
  assert.equal(world.snapshots.at(-1).state.turn, world.snapshots.at(-1).turn + 1,
    "reducer snapshot must preserve the published post-resolution turn");
  const stateBefore = world.stateHash();
  const reports = await new Confidant({ world, now: () => 0 }).interviewAll(runtimes);
  assert.ok(reports.every(report => report.status === "recorded"));
  assert.equal(world.stateHash(), stateBefore);
  const result = replay(world.evidence.bundle(), { expectedRunId: world.runId, authorizationContext: createAuthorizationContext("trusted_replay") });
  assert.equal(result.status, "EXACT_REPLAY");
  assert.equal(result.event_head, world.evidence.previousHash);
  assert.equal(result.state_digest, stateBefore);
  for (const event of world.evidence.events.filter(event => event.event_type === "InterviewResponse")) {
    const proof = JSON.parse(world.evidence.payloads.get(event.payload.isolation_proof_ref).bytes);
    for (const ref of [event.payload.response_payload_ref, event.payload.isolation_proof_ref, proof.snapshot_ref, proof.authorized_projection_ref]) {
      const damaged = world.evidence.bundle(); delete damaged.payloads[ref];
      // Content deduplication can detect a shared snapshot/projection earlier.
      assert.throws(() => replay(damaged, { expectedRunId: world.runId, authorizationContext: createAuthorizationContext("trusted_replay") }), /missing (or corrupt|payload evidence)|snapshot content mismatch/);
    }
  }
});
