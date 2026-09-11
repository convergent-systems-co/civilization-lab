import test from "node:test";
import assert from "node:assert/strict";
import { clone, sha256 } from "../src/core.js";
import { EvidenceStore } from "../src/evidence.js";
import { makeWorld, PILOT_0_CONFIG, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { replay, reconstructRun, verifyEvidenceIntegrity, createAuthorizationContext } from "../src/replay.js";
import { MemoryStore } from "../src/memory.js";

const scope = runId => ({ expectedRunId: runId, authorizationContext: createAuthorizationContext("trusted_replay") });
function fixture() {
  const config = clone(PILOT_0_CONFIG); config.combat.defense = 0;
  // Synthetic range fixture: initial citizens still cannot see other starts;
  // recruited units have explicitly configured detection/range for this test.
  config.unitTypes.infantry.detection = 20; config.unitTypes.infantry.range = 20;
  const world = makeWorld({ runId: "synthetic-replay-fixture", seed: "fixed-replay-seed", config });
  const ledger = new ActionLedger(world.evidence);
  for (let turn = 0; turn < 3; turn++) {
    const records = Object.keys(world.polities).map(id => {
      const action = { action_id: `${turn}:${id}`, type: turn === 0 ? "recruit" : "wait" };
      if (turn === 1 && id === "polity-1") Object.assign(action, { type: "attack", unit_id: world.polities[id].units[0].id, target_unit_id: world.polities["polity-2"].units[0].id });
      const submission = ledger.submit({ runId: world.runId, turnId: `turn-${turn}`, actorId: id, actor: { persistent_identity_id: id, session_id: `session:${id}`, invocation_id: `invocation:${turn}:${id}` }, actions: [action], projection: projectWorld(world,id) });
      return ledger.validate(submission,world);
    });
    resolveTurn(world,commitTurn(world,ledger,records));
  }
  return world;
}

// Deliberately give an adversary the public hashing and toy signing algorithm.
// Passing integrity alone must never suffice to establish reducer conformance.
function rehash(bundle) {
  const store = new EvidenceStore(bundle.run_id);
  store.payloads = new Map(Object.entries(clone(bundle.payloads)));
  for (const event of bundle.events) {
    const payload = clone(event.payload); delete payload.payload_ref;
    store.append({ eventType: event.event_type, turn: event.turn, phase: event.phase, payload, participants: event.participants, visibility: event.visibility, causality: event.causality, lineage: event.lineage, provenance: event.provenance, rng: event.rng, source: event.provenance.source });
  }
  return store.bundle();
}

test("valid archived inputs independently reproduce all reducer events and final authoritative state", () => {
  const world = fixture(), bundle = world.evidence.bundle();
  assert.equal(verifyEvidenceIntegrity(bundle).exact_reproducibility,false);
  const result = replay(bundle,scope(world.runId));
  assert.equal(result.status,"EXACT_REPLAY"); assert.equal(result.resolved_turns,3);
  assert.deepEqual(result.authoritative_state,world.authoritativeState()); assert.equal(result.state_digest,world.stateHash());
  assert.equal(result.event_head,world.evidence.previousHash);
});

test("fully rehashed fabricated intermediate and final states fail independent replay", () => {
  const world = fixture(), bundle = world.evidence.bundle();
  for (const event of bundle.events.filter(e=>e.event_type === "SnapshotCreated")) {
    const state = JSON.parse(bundle.payloads[event.payload.state_ref].bytes); state.polities["polity-1"].credits += 999;
    const store = new EvidenceStore(world.runId), ref = store.putPayload(state);
    bundle.payloads[ref] = store.payloads.get(ref); event.payload.state_ref = ref; event.payload.state_hash = ref;
    const resolution = bundle.events.find(e=>e.turn===event.turn && e.event_type === "TurnResolved");
    resolution.payload.authoritative_state_ref = ref; resolution.payload.resulting_state_hash = ref;
  }
  const forged = rehash(bundle); assert.equal(verifyEvidenceIntegrity(forged).status,"EVIDENCE_INTEGRITY_VERIFIED");
  assert.throws(()=>replay(forged,scope(world.runId)),/re-execution canonical event mismatch/);
});

for (const [name, mutate] of [
  ["modified actions", b => { const e = b.events.find(e=>e.event_type==="ActionSubmitted"); e.payload.actions[0].type="wait"; e.payload.action_hash=sha256(e.payload.actions); }],
  ["modified RNG provenance", b => { const e=b.events.find(e=>e.event_type==="RNGDraw"); e.payload.draw_value = 0.123; e.rng.value=0.123; }],
  ["modified frozen configuration", b => { b.events[0].payload.config_hash="a".repeat(64); }],
  ["modified registry", b => { const e=b.events[0], old=JSON.parse(b.payloads[e.payload.parameter_registry_ref].bytes); old.parameters[0].value=19; const s=new EvidenceStore(b.run_id), ref=s.putPayload(old); b.payloads[ref]=s.payloads.get(ref); e.payload.parameter_registry_ref=ref; }],
  ["modified initial state", b => { const e=b.events[0], old=JSON.parse(b.payloads[e.payload.initial_state_ref].bytes); old.polities["polity-1"].credits++; const s=new EvidenceStore(b.run_id), ref=s.putPayload(old); b.payloads[ref]=s.payloads.get(ref); e.payload.initial_state_ref=ref; }]
]) test(`reducer replay rejects ${name} even after all event hashes are recomputed`,()=>{
  const world=fixture(), bundle=world.evidence.bundle(); mutate(bundle); const altered=rehash(bundle);
  verifyEvidenceIntegrity(altered); assert.throws(()=>replay(altered,scope(world.runId)));
});

test("omitted and reordered causal events cannot be certified",()=>{
  const world=fixture(), original=world.evidence.bundle();
  const omitted=clone(original); omitted.events.splice(omitted.events.findIndex(e=>e.event_type==="ConflictResolved"),1);
  assert.throws(()=>replay(rehash(omitted),scope(world.runId)));
  const reordered=clone(original), index=reordered.events.findIndex(e=>e.event_type==="ActionValidated");
  [reordered.events[index],reordered.events[index-1]]=[reordered.events[index-1],reordered.events[index]];
  assert.throws(()=>replay(rehash(reordered),scope(world.runId)));
});

test("payload transition references address real emitted events in the same run",()=>{
  const world=fixture(), events=world.evidence.events, ids=new Set(events.map(e=>e.event_id));
  for (const e of events) for (const ref of [e.payload.canonical_event_ref, e.payload.commit_event_id, ...(e.payload.canonical_event_refs??[]), ...(e.payload.outcome_event_ids??[])].filter(Boolean)) assert.ok(ids.has(ref),ref);
});

test("a committed unresolved journal can be reconstructed and resolved without duplicate action effects",()=>{
  const world=fixture(), bundle=world.evidence.bundle();
  const finalCommit=bundle.events.filter(e=>e.event_type==="TurnCommitted").at(-1);
  bundle.events=bundle.events.slice(0,finalCommit.sequence+1);
  const recovered=reconstructRun(bundle,{allowPendingCommit:true}); assert.ok(recovered.pendingCommit);
  resolveTurn(recovered.world,recovered.pendingCommit);
  assert.equal(recovered.world.evidence.previousHash,world.evidence.previousHash);
  assert.deepEqual(recovered.world.authoritativeState(),world.authoritativeState());
  assert.throws(()=>resolveTurn(recovered.world,recovered.pendingCommit));
});

test("deleting raw memory evidence never receives an exact replay certificate",()=>{
  const world=fixture();
  const memory=new MemoryStore({runId:world.runId,identityId:"polity-1",evidence:world.evidence,sessionId:"memory-session"});
  memory.write("verbatim private synthetic record","memory-session","memory-invocation",world.turn);
  const bundle=world.evidence.bundle(), operation=bundle.events.at(-1);
  assert.equal(replay(bundle,scope(world.runId)).status,"EXACT_REPLAY");
  for(const ref of [...operation.payload.input_refs,operation.payload.output_ref,operation.payload.availability_ref]) {
    const altered=clone(bundle); delete altered.payloads[ref];
    assert.throws(()=>replay(altered,scope(world.runId)),/missing or corrupt external input evidence/);
  }
});
