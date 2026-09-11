import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, canonicalize, sha256 } from "../src/core.js";
import { EvidenceStore } from "../src/evidence.js";
import { makeWorld, cloneWorld, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn } from "../src/contracts.js";
import { createAuthorizationContext, reconstructRun, replay } from "../src/replay.js";
import { SignedArchive, archiveKeyId } from "../src/archive.js";
import { RunService } from "../src/run-service.js";

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
async function trustedParentBinding(t, world, name) {
  const directory = await mkdtemp(join(tmpdir(), "civlab-parent-" + name + "-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), keyId = archiveKeyId(keys.publicKey);
  const archive = new SignedArchive({ directory, runId: world.runId, ...keys, keyId });
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  const exported = await archive.export({ authorizationContext: { domain: "trusted_replay", principal: "test" }, authorize: () => true });
  return { exported, trust: { runId: world.runId, publicKey: keys.publicKey, keyId, trustedHead: head } };
}
function replayOptions(world, parentArchiveBinding = null) {
  return { expectedRunId: world.runId, authorizationContext: createAuthorizationContext("trusted_replay"), parentArchiveBinding };
}

test("a branch independently replays from its inherited authoritative genesis", () => {
  const parent = makeWorld({ runId: "replay-parent", seed: "branch-replay" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const branch = cloneWorld(parent, { branchRunId: "replay-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  const rebuilt = reconstructRun(branch.evidence.bundle());
  assert.equal(rebuilt.world.runId, "replay-branch");
  assert.equal(rebuilt.resolvedTurns, 1);
  assert.equal(canonicalize(rebuilt.world.authoritativeState()), canonicalize(branch.authoritativeState()));
  assert.equal(rebuilt.world.evidence.previousHash, branch.evidence.previousHash);
});

test("a rehashed branch cannot substitute its claimed parent-state binding", () => {
  const parent = makeWorld({ runId: "bound-parent", seed: "bound-parent" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const branch = cloneWorld(parent, { branchRunId: "bound-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  const bundle = branch.evidence.bundle(), genesis = bundle.events[0];
  genesis.payload.parent_state_hash = "f".repeat(64);
  assert.throws(() => reconstructRun(rehash(bundle)), /branch parent state binding mismatch/);
});

test("a rehashed branch cannot bind a different parent state to the archived branch genesis", () => {
  const parent = makeWorld({ runId: "substituted-parent", seed: "substituted-parent" });
  const branch = cloneWorld(parent, { branchRunId: "substituted-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  const bundle = branch.evidence.bundle(), genesis = bundle.events[0];
  const substituted = JSON.parse(bundle.payloads[genesis.payload.parent_state_ref].bytes);
  substituted.polities["polity-1"].credits += 1;
  const payloads = new EvidenceStore(bundle.run_id), ref = payloads.putPayload(substituted, "authoritative_parent_state");
  bundle.payloads[ref] = payloads.payloads.get(ref);
  genesis.payload.parent_state_ref = ref;
  genesis.payload.parent_state_hash = sha256(substituted);
  assert.throws(() => reconstructRun(rehash(bundle)), /branch initial state differs from bound parent state/);
});

test("a branch without an external parent archive binding cannot claim exact replay", () => {
  const parent = makeWorld({ runId: "unbound-parent", seed: "unbound-parent" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const branch = cloneWorld(parent, { branchRunId: "unbound-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  assert.equal(reconstructRun(branch.evidence.bundle()).resolvedTurns, 1);
  assert.throws(() => replay(branch.evidence.bundle(), replayOptions(branch)), /externally authenticated parent archive/);
});

test("a valid externally trusted parent archive binding permits exact branch replay", async t => {
  const parent = makeWorld({ runId: "trusted-parent", seed: "trusted-parent" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const parentArchiveBinding = await trustedParentBinding(t, parent, "valid");
  const branch = cloneWorld(parent, { branchRunId: "trusted-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  const result = replay(branch.evidence.bundle(), replayOptions(branch, parentArchiveBinding));
  assert.equal(result.status, "EXACT_REPLAY");
  assert.equal(result.parent_archive_authenticity, "EXTERNAL_ED25519_BINDING_VERIFIED");
  assert.equal(result.parent_run_id, parent.runId);
  assert.equal(result.parent_event_head, parent.evidence.previousHash);
});

test("an altered parent event head is rejected after the child is fully rehashed", async t => {
  const parent = makeWorld({ runId: "head-parent", seed: "head-parent" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const parentArchiveBinding = await trustedParentBinding(t, parent, "head");
  const branch = cloneWorld(parent, { branchRunId: "head-branch" });
  resolveTurn(branch, commitTurn(branch, new ActionLedger(branch.evidence), []));
  const bundle = branch.evidence.bundle();
  bundle.events[0].payload.parent_event_head = "f".repeat(64);
  const forged = rehash(bundle);
  assert.equal(reconstructRun(forged).resolvedTurns, 1);
  assert.throws(() => replay(forged, replayOptions(branch, parentArchiveBinding)), /parent event head binding mismatch/);
});

test("wrong parent run and parent state bindings cannot certify a branch", async t => {
  const parent = makeWorld({ runId: "state-parent", seed: "state-parent" });
  resolveTurn(parent, commitTurn(parent, new ActionLedger(parent.evidence), []));
  const parentArchiveBinding = await trustedParentBinding(t, parent, "state");
  const other = makeWorld({ runId: "other-parent", seed: "other-parent" });
  resolveTurn(other, commitTurn(other, new ActionLedger(other.evidence), []));
  const otherBinding = await trustedParentBinding(t, other, "other");

  const ordinaryBranch = cloneWorld(parent, { branchRunId: "wrong-run-branch" });
  resolveTurn(ordinaryBranch, commitTurn(ordinaryBranch, new ActionLedger(ordinaryBranch.evidence), []));
  assert.throws(() => replay(ordinaryBranch.evidence.bundle(), replayOptions(ordinaryBranch, otherBinding)), /parent archive run binding mismatch/);

  parent.polities["polity-1"].credits += 1;
  const stateBranch = cloneWorld(parent, { branchRunId: "wrong-state-branch" });
  resolveTurn(stateBranch, commitTurn(stateBranch, new ActionLedger(stateBranch.evidence), []));
  assert.throws(() => replay(stateBranch.evidence.bundle(), replayOptions(stateBranch, parentArchiveBinding)), /inherited state does not match authenticated parent head/);
});

test("TurnResolved hashes the authoritative state actually published to callers", () => {
  const world = makeWorld({ runId: "published-state-boundary", seed: "published-state-boundary" });
  resolveTurn(world, commitTurn(world, new ActionLedger(world.evidence), []));
  const resolved = world.evidence.events.find(event => event.event_type === "TurnResolved");
  const archived = JSON.parse(world.evidence.payloads.get(resolved.payload.authoritative_state_ref).bytes);
  assert.equal(resolved.payload.resulting_state_hash, world.stateHash());
  assert.equal(resolved.payload.resulting_state_hash, sha256(archived));
  assert.equal(resolved.payload.published_turn, world.turn);
  assert.equal(resolved.payload.published_phase, world.phase);
  assert.equal(canonicalize(archived), canonicalize(world.authoritativeState()));
});

test("evidence verification rejects a TurnResolved published lifecycle substitution", () => {
  const world = makeWorld({ runId: "published-state-substitution", seed: "published-state-substitution" });
  resolveTurn(world, commitTurn(world, new ActionLedger(world.evidence), []));
  const bundle = world.evidence.bundle(), resolved = bundle.events.find(event => event.event_type === "TurnResolved");
  resolved.payload.published_turn += 1;
  assert.throws(() => reconstructRun(rehash(bundle)), /resolved published lifecycle mismatch/);
});

test("a rehashed standalone interview cannot be certified as exact replay", () => {
  const world = makeWorld({ runId: "forged-interview", seed: "forged-interview" });
  resolveTurn(world, commitTurn(world, new ActionLedger(world.evidence), []));
  const snapshot = world.snapshots.at(-1), projection = world.projectWorldState("polity-1");
  const projectionRef = world.evidence.putPayload(projection), snapshotRef = world.evidence.putPayload(snapshot.state);
  world.evidence.append({ eventType: "InterviewResponse", turn: snapshot.turn, phase: "interview", participants: ["polity-1"],
    lineage: { persistent_identity_ids: ["polity-1"], session_ids: ["forged-session"], invocation_ids: ["forged-invocation"] },
    payload: { schema_version: "1.0.0", response_id: "forged-response", question_version: "forged", projection_ref: projectionRef,
      session_id: "forged-session", invocation_id: "forged-invocation", response_payload_ref: world.evidence.putPayload("fabricated"),
      isolation_proof_ref: world.evidence.putPayload({ snapshot_ref: snapshotRef, authorized_projection_ref: projectionRef,
        interview_session: "forged-session", cross_interview_input: false, prior_answers_available: false, writeback: [], qualitative_only: true }),
      qualitative_only: true } });
  assert.throws(() => reconstructRun(rehash(world.evidence.bundle())), /matching completed model invocation/);
});

test("a rehashed fabricated coding record cannot ride through exact world replay", () => {
  const world = makeWorld({ runId: "forged-coding", seed: "forged-coding" });
  resolveTurn(world, commitTurn(world, new ActionLedger(world.evidence), []));
  const dummy = world.evidence.putPayload({ fabricated: true }, "forged");
  const rules = world.evidence.putPayload("invented rules", "forged");
  world.evidence.append({ eventType: "BehaviorCoded", turn: 0, phase: "analysis", source: "blinded_coder",
    visibility: { classification: "private_research", acl_ref: "observer" },
    payload: { schema_version: "1.0.0", run_id: world.runId, packet_ref: dummy, mapping_ref: dummy, codebook_ref: rules,
      coder: { id: "attacker", version: "forged", mode: "blinded_human", rules_ref: rules, prompt_ref: null },
      annotations: [], reviewed_refs: [], supersedes: null, coverage_complete: true } });
  assert.throws(() => reconstructRun(rehash(world.evidence.bundle())), /coding rules|codebook|packet|mapping/);
});

test("RunService facades return detached state and deny evidence mutation authority", async t => {
  const directory = await mkdtemp(join(tmpdir(), "civlab-readonly-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), runId = "readonly-service";
  const archive = new SignedArchive({ directory, runId, ...keys, keyId: archiveKeyId(keys.publicKey) });
  const service = await RunService.create({ world: makeWorld({ runId }), archive });
  const before = (await service.participantState("polity-1")).projection;
  const polities = service.world.polities;
  assert.throws(() => { polities["polity-1"].credits += 1; }, TypeError);
  const payloads = service.world.evidence.payloads; payloads.clear();
  assert.throws(() => service.world.evidence.putPayload("forbidden"), /private to RunService/);
  assert.deepEqual((await service.participantState("polity-1")).projection, before);
  service.world.evidence.verify();
});
