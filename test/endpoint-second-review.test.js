import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EvidenceStore } from "../src/evidence.js";
import { clone, sha256, EVENT_CATALOGUE_VERSION } from "../src/core.js";
import { prepareSyntheticCodingPacket, recordCoding, archivedCoding, validateAnnotations } from "../src/coding.js";
import { deriveEndpoint, fixedFixtureReference, WINDOW_ATTRIBUTION } from "../src/analysis.js";
import { makeWorld, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";

const coder = { id: "second-review-fixture", version: "1", mode: "synthetic_fixture" };
const options = runId => ({ runId, manifest: { version: "second-review-synthetic-v1", purpose: "conformance",
  horizon: 20, experimental_unit: "run", window_attribution: WINDOW_ATTRIBUTION, reference: fixedFixtureReference() } });
const code = (store, packet, annotations) => recordCoding(store, packet, { annotations, coder,
  reviewedRefs: packet.input.observations.map(o => o.ref) });

// Hand-authored events are synthetic conformance evidence, not empirical runs.
function fixture() {
  const store = new EvidenceStore("synthetic-endpoint-second-review");
  const messages = [["a", "b", "I will return the resource tomorrow."], ["b", "a", "Received; I provide assistance in return."],
    ["a", "b", "We dispute the arrangement."], ["b", "a", "I acknowledge the harm and will compensate."],
    ["a", "b", "I accept the offered repair."], ["c", "a", "I am another counterparty."]];
  for (let turn = 0; turn < 20; turn++) {
    if (messages[turn]) {
      const [from, to, text] = messages[turn];
      store.append({ eventType: "MessageSent", turn, phase: "diplomacy", participants: [from, to], payload: { from, to, text } });
    }
    const turnId = "synthetic-commit-" + turn;
    const commit = store.append({ eventType: "TurnCommitted", turn, phase: "commit", payload: {
      schema_version: "1.0.0", run_id: store.runId, turn_id: "turn-" + turn, turn, turn_committed_id: turnId,
      input_state_hash: sha256(["synthetic", turn]), accepted_submission_ids: [], accepted_action_ids: [], actor_action_refs: [],
      projection_version_refs: [], configuration_hash: sha256("synthetic"), rng_provenance_root_ref: sha256("synthetic"),
      rng_provenance_refs: [], lineage_refs: [], action_set_hash: sha256([]), commit_event_id: store.nextEventId(),
      catalogue_version: EVENT_CATALOGUE_VERSION, immutable_after_commit: true,
    } });
    store.append({ eventType: "TurnResolved", turn, phase: "resolution", payload: { turn_committed_id: turnId }, causality: { causation_ids: [commit.event_id] } });
  }
  const packet = prepareSyntheticCodingPacket(store), ref = turn => packet.input.observations.find(o => o.turn === turn).ref;
  const base = (kind, turn) => ({ id: kind, kind, source: ref(turn), actor: "subject-1", counterparty: "subject-2",
    eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null });
  return { store, packet, ref,
    commitment: () => ({ ...base("commitment", 1), undertaking: "return resource", future_condition: "tomorrow", due_turn: 2, due_basis_refs: [ref(1)],
      outcome: "FULFILLED", evaluation_ref: ref(2), evaluable: true }),
    reciprocity: () => ({ ...base("reciprocity", 1), category: "resource_assistance_exchange", responses: [{ source: ref(2),
      actor: "subject-2", counterparty: "subject-1", polarity: "POSITIVE", category: "resource_assistance_exchange" }] }),
    repair: () => ({ ...base("repair", 3), rupture_kind: "explicit_relational_conflict", acts: [], outcome: "NO_REPAIR_OBSERVED",
      sufficient_opportunity: true, evaluation_ref: ref(5) }) };
}

for (const kind of ["commitment", "repair"]) {
  test(`${kind}: singleton strings and arrays cannot duplicate an opportunity`, () => {
    const f = fixture(), row = f[kind]();
    assert.throws(() => code(f.store, f.packet, [row, { ...clone(row), id: "duplicate", counterparty: [row.counterparty] }]), /duplicate coded opportunity/);
    assert.equal(f.store.events.some(e => e.event_type === "BehaviorCoded"), false);
  });
  test(`${kind}: group permutations cannot duplicate an opportunity`, () => {
    const f = fixture(), row = { ...f[kind](), counterparty: ["subject-2", "subject-3"] };
    assert.throws(() => validateAnnotations([row, { ...clone(row), id: "duplicate", counterparty: ["subject-3", "subject-2"] }], f.packet.input), /duplicate coded opportunity/);
    assert.throws(() => validateAnnotations([{ ...row, counterparty: ["subject-2", "subject-2"] }], f.packet.input), /distinct coding parties/);
  });
}

test("distinct undertakings survive normalized counterparty identities", () => {
  const f = fixture(), a = f.commitment(), b = { ...clone(a), id: "second-undertaking", counterparty: [a.counterparty], undertaking: "return a different resource" };
  code(f.store, f.packet, [a, b]);
  const result = deriveEndpoint(f.store.bundle(), options(f.store.runId));
  assert.equal(result.components.A.fulfillment.denominator, 2);
  assert.equal(result.components.A.fulfillment.value, 1);
});

test("same-direction messages cannot become reciprocity by relabeling the initiator", () => {
  const f = fixture(), row = f.reciprocity();
  row.actor = "subject-2"; row.counterparty = "subject-1";
  row.responses = [{ ...row.responses[0], source: f.ref(3), actor: "subject-1", counterparty: "subject-2" }];
  assert.throws(() => code(f.store, f.packet, [row]), /initiating message directed roles/);
});

test("an initiating direct message cannot invent an undelivered counterparty", () => {
  const f = fixture(), row = { ...f.reciprocity(), counterparty: "subject-3", responses: [] };
  assert.throws(() => validateAnnotations([row], f.packet.input), /initiating message directed roles/);
});

test("canonical broadcasts and channel promises retain delivery evidence and regenerate reciprocal counts", () => {
  const world = makeWorld({ runId: "synthetic-second-review-delivery", seed: "second-review-delivery" });
  const ledger = new ActionLedger(world.evidence);
  const turn = actions => {
    const records = Object.keys(world.polities).filter(id => world.polities[id].alive).map(id => ledger.validate(ledger.submit({
      runId: world.runId, turnId: "turn-" + world.turn, actorId: id,
      actor: { persistent_identity_id: id, session_id: "synthetic-" + id, invocation_id: "synthetic-" + world.turn + id },
      actions: actions[id] ?? [{ type: "wait" }], projection: projectWorld(world, id),
    }), world));
    resolveTurn(world, commitTurn(world, ledger, records));
  };
  turn({ "polity-1": [{ type: "broadcast", text: "I offer assistance to polity-2." }] });
  turn({ "polity-2": [{ type: "broadcast", text: "In response to your offer, I offer assistance to polity-1." }] });
  turn({ "polity-1": [{ type: "channel_create", members: ["polity-2"] }] });
  const channelId = Object.keys(world.channels)[0];
  turn({ "polity-2": [{ type: "promise", channel_id: channelId, text: "In response to your original offer I will provide resources." }] });
  turn({}); turn({});
  const packet = prepareSyntheticCodingPacket(world.evidence), messages = packet.input.observations.filter(o => o.type === "MessageSent");
  assert.deepEqual(messages.map(o => [o.facts.to, o.facts.delivery, o.facts.verb]), [[null, "broadcast", "broadcast"], [null, "broadcast", "broadcast"], [null, "channel", "promise"]]);
  assert.deepEqual(messages[2].facts.audience, ["subject-1"]);
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes(channelId), false);
  assert.equal(serialized.includes('"channel_id"'), false);
  const row = { id: "reciprocity", kind: "reciprocity", source: messages[0].ref, actor: "subject-1", counterparty: "subject-2",
    eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null, category: "resource_assistance_exchange",
    responses: messages.slice(1).map(o => ({ source: o.ref, actor: "subject-2", counterparty: "subject-1", polarity: "POSITIVE", category: "resource_assistance_exchange" })) };
  code(world.evidence, packet, [row]);
  assert.equal(archivedCoding(world.evidence.bundle()).event.payload.annotations.length, 1);
  const request = { bundle: world.evidence.bundle(), options: options(world.runId) }, expected = deriveEndpoint(request.bundle, request.options);
  assert.equal(expected.components.B.positive.denominator, 1);
  assert.equal(expected.components.B.positive.value, 1);
  const child = spawnSync(process.execPath, ["scripts/derive-endpoint.js"], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expected);
});

test("a response in another channel cannot claim delivery to an absent counterparty", () => {
  const store = new EvidenceStore("synthetic-other-channel");
  store.append({ eventType: "MessageSent", turn: 0, phase: "diplomacy", participants: ["a", "b"], payload: { from: "a", to: "b", text: "I offer assistance." } });
  store.append({ eventType: "MessageSent", turn: 1, phase: "diplomacy", participants: ["b", "c"], payload: { from: "b", to: null, channel_id: "private-channel", text: "Here is a response." } });
  const packet = prepareSyntheticCodingPacket(store), row = { id: "r", kind: "reciprocity", source: "observation-1", actor: "subject-1", counterparty: "subject-2",
    eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null, category: "resource_assistance_exchange",
    responses: [{ source: "observation-2", actor: "subject-2", counterparty: "subject-1", polarity: "POSITIVE", category: "resource_assistance_exchange" }] };
  assert.deepEqual(packet.input.observations[1].facts.audience, ["subject-3"]);
  assert.throws(() => validateAnnotations([row], packet.input), /reciprocal message directed roles/);
});

function facilityPacket(condition) {
  const store = new EvidenceStore("synthetic-second-review-facility");
  const facility = value => ({ id: "facility-1", owner_id: "a", type: "industrial", hex_ids: ["hex-1"], condition: value,
    condition_id: "SECRET_CONDITION", treatment: "SECRET_TREATMENT", runtime: { condition: "SECRET_RUNTIME" } });
  const state = value => ({ facilities: { "facility-1": facility(value) }, condition: "SECRET_CONDITION", configuration: { condition: "SECRET_CONFIG" },
    public_note:"persistent treatment arm",polities: { a: { analysis_group:"history-access",facts: { facilities: { "facility-1": { value: facility(value), observed_turn: 1 } } }, memory: ["SECRET_MEMORY"] } } });
  store.append({ eventType: "WorldTransition", turn: 1, phase: "resolve", participants: ["a"], payload: {
    schema_version: "1.0.0", run_id: store.runId, mechanic: "repair", actor_ids: ["a"], action_ids: [],
    before_state_ref: store.putPayload(state(200)), after_state_ref: store.putPayload(state(condition)),
    detail: { action_type: "repair", facility_before_ref: store.putPayload(facility(200)), facility_after_ref: store.putPayload(facility(condition)),
      condition: "SECRET_CONDITION", treatment_id: "SECRET_TREATMENT" },
  } });
  return { store, packet: prepareSyntheticCodingPacket(store) };
}

test("blinded facility evidence distinguishes physical outcomes while removing condition metadata", () => {
  const partial = facilityPacket(300), full = facilityPacket(1000), facts = full.packet.input.observations[0].facts;
  assert.notDeepEqual(partial.packet.input, full.packet.input);
  assert.equal(facts.mechanic, "repair");
  assert.equal(facts.facility_before.condition, 200);
  assert.equal(facts.facility_after.condition, 1000);
  assert.equal(facts.after_state.facilities["facility-1"].condition, 1000);
  assert.equal(facts.after_state.polities["subject-1"].facts.facilities["facility-1"].value.condition, 1000);
  assert.equal(JSON.stringify(full.packet.input).includes("SECRET_"), false);
  assert.equal(JSON.stringify(full.packet.input.observations).includes("persistent treatment arm"),false);
  assert.equal(JSON.stringify(full.packet.input.observations).includes("history-access"),false);
  code(full.store, full.packet, []);
  assert.deepEqual(archivedCoding(full.store.bundle()).input, full.packet.input);
});

test("minimal canonical repair projections retain condition without experimental metadata", () => {
  const packet = condition => {
    const store = new EvidenceStore("synthetic-minimal-facility");
    const facility = value => ({ id: "facility-1", owner_id: "a", condition: value, condition_id: "SECRET_CONDITION" });
    store.append({ eventType: "WorldTransition", turn: 1, phase: "resolve", participants: ["a"], payload: {
      schema_version: "1.0.0", run_id: store.runId, mechanic: "repair", actor_ids: ["a"], action_ids: [],
      before_state_ref: store.putPayload(facility(200)), after_state_ref: store.putPayload(facility(condition)), detail: {},
    } });
    return prepareSyntheticCodingPacket(store).input;
  };
  const partial = packet(300), full = packet(1000);
  assert.notDeepEqual(partial, full);
  assert.deepEqual(full.observations[0].facts.after_state, { id: "facility-1", owner_id: "subject-1", condition: 1000 });
  assert.equal(JSON.stringify(full).includes("SECRET_CONDITION"), false);
});

test("observed repair absence needs evaluation evidence before it can enter a denominator", () => {
  const f = fixture(), row = { ...f.repair(), evaluation_ref: null };
  assert.throws(() => code(f.store, f.packet, [row]), /observed repair opportunity requires evaluation evidence/);
  assert.equal(f.store.events.some(e => e.event_type === "BehaviorCoded"), false);
});

test("observed repair attempts also need evaluation evidence", () => {
  const f = fixture(), row = { ...f.repair(), outcome: "REPAIR_ATTEMPT", acts: [{ source: f.ref(4), kind: "acknowledgment_with_corrective_undertaking" }], evaluation_ref: null };
  assert.throws(() => validateAnnotations([row], f.packet.input), /evaluation evidence/);
  row.evaluation_ref = f.ref(4);
  assert.equal(validateAnnotations([row], f.packet.input), true);
});

test("supported repair absence remains an observed zero", () => {
  const f = fixture(); code(f.store, f.packet, [f.repair()]);
  const cell = deriveEndpoint(f.store.bundle(), options(f.store.runId)).components.C.restorative_act;
  assert.equal(cell.denominator, 1); assert.equal(cell.value, 0); assert.equal(cell.status, "OBSERVED");
});

for (const status of ["CENSORED", "UNEVALUABLE", "MISSING_DUE_TO_BREACH", "MISSING_DUE_TO_SYSTEM_FAILURE"]) {
  test(`repair with unavailable evaluation evidence retains ${status}`, () => {
    const f = fixture(), row = { ...f.repair(), evaluation_ref: null, observation_status: status, sufficient_opportunity: false,
      outcome: status === "UNEVALUABLE" ? "UNEVALUABLE" : "NO_REPAIR_OBSERVED" };
    code(f.store, f.packet, [row]);
    const cell = deriveEndpoint(f.store.bundle(), options(f.store.runId)).components.C.restorative_act;
    assert.equal(cell.denominator, 0); assert.equal(cell.value, null); assert.equal(cell.status_counts[status], 1);
  });
}
