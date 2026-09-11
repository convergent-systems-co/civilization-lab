import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, clone, sha256, stableId } from "../src/core.js";
import { EvidenceStore } from "../src/evidence.js";
import { makeWorld, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { recordSecurityIncident, recordBreachDisposition, recordRedaction, redactBundle } from "../src/forensics.js";
import { createAuthorizationContext, reconstructRun, replay, verifyEvidenceIntegrity } from "../src/replay.js";

function fresh() {
  const world = makeWorld({ runId: "synthetic-replay-boundaries", seed: "synthetic-boundary-fixture" });
  return { world, ledger: new ActionLedger(world.evidence) };
}
function submit(world, ledger, actorId, type = "wait") {
  const submission = ledger.submit({ runId: world.runId, turnId: "turn-" + world.turn, actorId,
    actor: { persistent_identity_id: actorId, session_id: "synthetic-session-" + actorId,
      invocation_id: "synthetic-invocation-" + world.turn + actorId },
    actions: [{ action_id: "synthetic-action-" + world.turn + actorId, type }], projection: projectWorld(world, actorId) });
  return ledger.validate(submission, world);
}
function emptyTurn(world, ledger) {
  const committed = commitTurn(world, ledger, []);
  resolveTurn(world, committed);
  return committed;
}
function breach(world) {
  const dispositionId = stableId("evt", world.runId, world.evidence.events.length + 1);
  const detectorRef = world.evidence.putPayload({ detector: "synthetic-boundary-monitor" });
  const incident = recordSecurityIncident(world.evidence, { breachType: "synthetic_boundary_probe", detectorRef,
    runDispositionRef: dispositionId, firstAffectedEvent: world.evidence.events[0].event_id,
    lastAffectedEvent: world.evidence.events.at(-1).event_id, evidenceRefs: [world.evidence.events[0].payload.payload_ref] });
  return recordBreachDisposition(world.evidence, { incidentRef: incident.event_id });
}
const scope = world => ({ expectedRunId: world.runId, authorizationContext: createAuthorizationContext("trusted_replay") });

// Adversarial fixtures have fully recomputed run-derived HMACs and payload
// hashes. They remain incapable of substituting for actual reducer execution.
function rehash(bundle) {
  const store = new EvidenceStore(bundle.run_id);
  store.payloads = new Map(Object.entries(clone(bundle.payloads)));
  for (const event of bundle.events) {
    const payload = clone(event.payload); delete payload.payload_ref;
    store.append({ eventType: event.event_type, turn: event.turn, phase: event.phase, payload,
      participants: event.participants, visibility: event.visibility, causality: event.causality,
      lineage: event.lineage, provenance: event.provenance, rng: event.rng, source: event.provenance.source });
  }
  return store.bundle();
}

test("all-rejected turn reexecutes the actual empty commit and world tick", () => {
  const { world, ledger } = fresh();
  for (const id of Object.keys(world.polities)) assert.equal(submit(world, ledger, id, "not_an_enabled_action").submission.status, "rejected");
  const initialState = world.stateHash(), committed = emptyTurn(world, ledger);
  assert.deepEqual(committed.acceptedActions, []);
  assert.equal(world.evidence.events.filter(event => event.event_type === "ActionAccepted").length, 0);
  assert.notEqual(world.stateHash(), initialState);
  const restored = reconstructRun(world.evidence.bundle());
  assert.equal(restored.resolvedTurns, 1);
  assert.equal(restored.world.stateHash(), world.stateHash());
  assert.equal(canonicalize(restored.world.evidence.events), canonicalize(world.evidence.events));
  assert.equal(replay(world.evidence.bundle(), scope(world)).status, "EXACT_REPLAY");
});

test("empty committed journal recovers pending input and resolves exactly once", () => {
  const { world, ledger } = fresh();
  const committed = commitTurn(world, ledger, []), pendingBundle = world.evidence.bundle();
  const restored = reconstructRun(pendingBundle, { allowPendingCommit: true });
  assert.equal(restored.pendingCommit.turn_committed_id, committed.turn_committed_id);
  assert.equal(restored.resolvedTurns, 0);
  assert.throws(() => reconstructRun(pendingBundle), /unresolved committed turn/);
  resolveTurn(restored.world, restored.pendingCommit); resolveTurn(world, committed);
  assert.equal(restored.world.evidence.previousHash, world.evidence.previousHash);
  assert.equal(restored.world.stateHash(), world.stateHash());
  assert.throws(() => resolveTurn(restored.world, restored.pendingCommit));
});

for (const [name, mutate] of [
  ["nonempty acceptance omission", p => { p.accepted_submission_ids = ["unaccepted-submission"]; }],
  ["action set substitution", p => { p.action_set_hash = sha256(["fabricated-action"]); }],
  ["input state substitution", p => { p.input_state_hash = "1".repeat(64); }],
  ["configuration substitution", p => { p.configuration_hash = "2".repeat(64); }],
  ["RNG root substitution", p => { p.rng_provenance_root_ref = "3".repeat(64); }]
]) test("empty commit rejects " + name + " after complete rehashing", () => {
  const { world, ledger } = fresh(); emptyTurn(world, ledger);
  const bundle = world.evidence.bundle(); mutate(bundle.events.find(event => event.event_type === "TurnCommitted").payload);
  const forged = rehash(bundle);
  assert.equal(verifyEvidenceIntegrity(forged).status, "EVIDENCE_INTEGRITY_VERIFIED");
  assert.throws(() => reconstructRun(forged), /canonical event mismatch|lacks canonical action acceptance/);
});

test("empty-turn archived snapshots cannot replace actual world reduction", () => {
  const { world, ledger } = fresh(); emptyTurn(world, ledger);
  const bundle = world.evidence.bundle(), snapshot = bundle.events.find(event => event.event_type === "SnapshotCreated");
  const state = JSON.parse(bundle.payloads[snapshot.payload.state_ref].bytes); state.polities["polity-1"].credits++;
  const payloadStore = new EvidenceStore(world.runId), ref = payloadStore.putPayload(state);
  bundle.payloads[ref] = payloadStore.payloads.get(ref); snapshot.payload.state_ref = ref; snapshot.payload.state_hash = ref;
  const resolved = bundle.events.find(event => event.event_type === "TurnResolved");
  resolved.payload.authoritative_state_ref = ref; resolved.payload.resulting_state_hash = ref;
  const forged = rehash(bundle); verifyEvidenceIntegrity(forged);
  assert.throws(() => reconstructRun(forged), /canonical event mismatch/);
});

test("authorized security disposition preserves evidence without inventing world effects", () => {
  const { world, ledger } = fresh(); emptyTurn(world, ledger);
  const state = world.stateHash(); breach(world);
  const restored = reconstructRun(world.evidence.bundle());
  assert.equal(restored.executionStopped, true); assert.equal(restored.world.stateHash(), state);
  assert.equal(restored.world.evidence.previousHash, world.evidence.previousHash);
  assert.equal(replay(world.evidence.bundle(), scope(world)).status, "EXACT_REPLAY");
  assert.equal(restored.world.evidence.events.at(-1).payload.security_eligibility.security_analysis_eligible, true);
});

test("security stop after a sealed empty commit preserves its unresolved boundary", () => {
  const { world, ledger } = fresh(), before = world.stateHash();
  const commit = commitTurn(world, ledger, []); breach(world);
  const restored = reconstructRun(world.evidence.bundle());
  assert.equal(restored.executionStopped, true); assert.equal(restored.resolvedTurns, 0);
  assert.equal(restored.pendingCommit.turn_committed_id, commit.turn_committed_id);
  assert.equal(restored.world.stateHash(), before);
  assert.equal(restored.world.evidence.events.some(event => event.event_type === "TurnResolved"), false);
});

for (const [name, mutate] of [
  ["world completion spoof", e => { e.payload.execution_status = "complete"; }],
  ["world archive phase spoof", e => { e.phase = "archive"; }],
  ["participant append source", e => { e.provenance.source = "participant"; }],
  ["untrusted recorder", e => { e.provenance.recorded_by = "participant"; }],
  ["missing incident causality", e => { e.causality.causation_ids = []; }],
  ["unrelated incident reference", e => { e.payload.replacement_policy.incident_ref = "absent-incident"; }],
  ["undeclared policy", e => { e.payload.replacement_policy.policy_ref = "unapproved-policy"; }],
  ["primary endpoint eligibility", e => { e.payload.endpoint_eligibility.primary_confirmatory = true; }],
  ["security evidence exclusion", e => { e.payload.security_eligibility.security_analysis_eligible = false; }],
  ["missing preservation", e => { e.payload.evidence_completeness.preserve_run = false; }],
  ["incorrect logical time", e => { e.turn += 2; }]
]) test("security disposition rejects " + name, () => {
  const { world } = fresh(); breach(world);
  const bundle = world.evidence.bundle(); mutate(bundle.events.at(-1));
  const forged = rehash(bundle); verifyEvidenceIntegrity(forged);
  assert.throws(() => reconstructRun(forged), /disposition|security/);
});

test("security incident must bind the disposition or its declared policy", () => {
  const { world } = fresh(); breach(world);
  const bundle = world.evidence.bundle();
  bundle.events.find(event => event.event_type === "SecurityIncident").payload.run_disposition_ref = "other-disposition";
  assert.throws(() => reconstructRun(rehash(bundle)), /disposition binding/);
});

for (const [name, mutate, pattern] of [
  ["detector evidence", event => { event.payload.detector_ref = "e".repeat(64); event.provenance.input_refs.push(event.payload.detector_ref); }, /external input evidence/],
  ["incident evidence", event => { event.payload.evidence_refs = ["f".repeat(64)]; event.provenance.input_refs.push(event.payload.evidence_refs[0]); }, /external input evidence/],
  ["affected-event boundary", event => { event.payload.first_affected_event = "evt_ffffffffffffffffffff"; }, /affected-event scope/],
  ["reversed affected-event range", (event, bundle) => { event.payload.first_affected_event = bundle.events[1].event_id; event.payload.last_affected_event = bundle.events[0].event_id; }, /affected-event scope/]
]) test("security incident rejects fabricated " + name + " after complete rehashing", () => {
  const { world, ledger } = fresh(); emptyTurn(world, ledger); breach(world);
  const bundle = world.evidence.bundle(), event = bundle.events.find(item => item.event_type === "SecurityIncident");
  mutate(event, bundle);
  const forged = rehash(bundle);
  assert.throws(() => verifyEvidenceIntegrity(forged), pattern);
});

test("action submission and actual world resolution cannot continue after a security stop", () => {
  const first = fresh(); breach(first.world); submit(first.world, first.ledger, "polity-1");
  assert.throws(() => reconstructRun(first.world.evidence.bundle()), /security stop/);
  const second = fresh(), commit = commitTurn(second.world, second.ledger, []); breach(second.world);
  resolveTurn(second.world, commit); // Deliberately bypass the production coordinator in this adversarial fixture.
  assert.throws(() => reconstructRun(second.world.evidence.bundle()), /security stop/);
});

test("normal horizon completion is certified only as actual reducer output", () => {
  const { world, ledger } = fresh();
  for (let turn = 0; turn < world.config.maxTurns; turn++) emptyTurn(world, ledger);
  const result = replay(world.evidence.bundle(), scope(world));
  assert.equal(result.resolved_turns, 20); assert.equal(result.authoritative_state.terminal, true);
  assert.equal(result.event_head, world.evidence.previousHash);
});

test("purged tombstone exports classify incomplete without claiming hash integrity or authenticity", () => {
  const { world } = fresh();
  const ref = world.evidence.putPayload({ text: "synthetic-redaction-canary" });
  recordRedaction(world.evidence, { artifactRef: ref, fieldOrRange: "text", reason: "consent_withdrawal", authority: "fixture-policy" });
  for (const bundle of [world.evidence.bundle(), redactBundle(world.evidence.bundle())]) {
    const result = verifyEvidenceIntegrity(bundle);
    assert.equal(result.status, "REPLAY_INCOMPLETE_REDACTED");
    assert.equal(result.integrity_verified, false); assert.equal(result.authenticity_verified, false);
    assert.equal(replay(bundle, scope(world)).exact_reproducibility, false);
    assert.throws(() => reconstructRun(bundle), /REPLAY_INCOMPLETE_REDACTED/);
    assert.throws(() => replay(bundle, { expectedRunId: world.runId, authorizationContext: createAuthorizationContext("participant_projection", "polity-1") }), /projection-scoped/);
  }
});

test("a redaction label without a tombstone cannot suppress evidence validation", () => {
  const { world } = fresh(), bundle = world.evidence.bundle();
  bundle.redaction_status = "REPLAY_INCOMPLETE_REDACTED";
  assert.throws(() => verifyEvidenceIntegrity(bundle), /tombstone/);
  delete bundle.redaction_status; bundle.events[0].payload.seed = "altered";
  assert.throws(() => verifyEvidenceIntegrity(bundle), /digest/);
});
