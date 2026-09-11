import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, sha256 } from "../src/core.js";
import { deriveCalibrationMetricFacts, divideHalfEven, decimalToScaled, assertMetricArtifact } from "../src/calibration-metrics.js";
import { calibrationProtocol } from "../src/calibration.js";
import { makeWorld, resolveTurn } from "../src/world.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { readEvidencePayload } from "../src/evidence.js";

// Hand-constructed metric inputs. No world reducers, model calls, or calibration
// search runs. Expected counts below were calculated independently of the collector.
function fixture(enriched = false) {
  const store = { events: [], payloads: new Map() };
  const put = value => { const bytes = canonicalize(value), ref = sha256(bytes); store.payloads.set(ref, { bytes }); return ref; };
  const emit = (type, turn, payload = {}, participants = [], extra = {}) => {
    const event = { event_type: type, turn, sequence: store.events.length, event_id: `e${store.events.length}`, payload, participants, ...extra };
    store.events.push(event); return event;
  };
  const configuration = { phases: { actionLimit: 4 }, dynamics: { maxQuantity: 10000 }, initialFacilityTypes: [],
    unitTypes: { infantry: { facility: "barracks", citizens: 4, credits: 3, resources: { iron: 1 }, prerequisites: [] } },
    facilityTypes: {}, technologies: {} };
  const snapshots = Array.from({ length: 20 }, (_, turn) => ({ event: { turn }, state: {
    polities: Object.fromEntries(["a", "b"].map(id => [id, { id, alive: true, credits: 10, food: 10, resources: { iron: 5 },
      citizens: [{ count: enriched ? 30 : 100 }], units: enriched ? [{ crew: [{ count: 70 }] }] : [], technologies: enriched && turn >= 4 ? ["t1"] : [],
      knowledge: enriched && turn >= 5 ? [id === "a" ? "b" : "a"] : [],
      reports: enriched && id === "a" && turn >= 6 ? [{ source: "activity_detection", id: "d1" }] : [] }])),
    facilities: { f1: { owner_id: "a", type: "barracks" }, f2: { owner_id: "b", type: "barracks" } }
  } }));
  emit("RunCreated", 0, { initial_state_ref: put(structuredClone(snapshots[0].state)) });
  for (let turn = 0; turn < 20; turn++) {
    emit("TurnCommitted", turn, { turn_committed_id: `commit-${turn}` });
    emit("TurnResolved", turn);
  }
  if (enriched) {
    emit("MessageSent", 1, { from: "a", to: "b", relational_category: "exchange", participant_label: "promise", future_evaluable: true }, ["a", "b"]);
    emit("MessageSent", 4, { from: "b", to: "a", relational_category: "retaliation" }, ["b", "a"]);
    emit("BattleResolved", 5, {}, ["a", "b"]);
    emit("WorldTransition", 2, { mechanic: "economy", detail: { production: { food: 10 }, consumption: 20 } });
    emit("WorldTransition", 4, { mechanic: "research_outcome", before_state_ref: put({ technologies: [] }), after_state_ref: put({ technologies: ["t1"] }) });
    const loss = emit("PopulationUnitTransition", 6, { transition: "loss" }, ["a"]);
    emit("PopulationUnitTransition", 7, { transition: "loss" }, ["b"]);
    emit("PopulationUnitTransition", 8, { transition: "demobilization" }, ["a"], { causality: { causation_ids: [loss.event_id] } });
    const canonicalActions = [{ action_id: "a1", type: "move" }, { action_id: "a2", type: "move" }, { action_id: "a3", type: "wait" }, { action_id: "rejected", type: "attack" }];
    emit("ActionSubmitted", 0, { submitted_actions: canonicalActions.map(({ type }) => ({ type })), actions: canonicalActions });
    emit("ActionAccepted", 0, { accepted_action_ids: ["a1", "a2", "a3"] });
    emit("ActionRejected", 0, { errors: [{ code: "action_limit_exceeded" }], submitted_action_count: 1 });
    emit("WorldTransition", 0, { mechanic: "turn_phase_state", detail: {
      reason: "phase_advanced", deadline_reached: true, missing_actor_ids: ["a"] } });
    emit("WorldTransition", 1, { mechanic: "turn_phase_state", detail: {
      reason: "phase_advanced", deadline_reached: false, missing_actor_ids: [] } });
  }
  return { store, snapshots, configuration, synthetic: true, emit, put };
}

// [empty-world value, enriched-world value, enriched numerator, denominator].
// null denotes structural ZERO_OPPORTUNITY; never an imputed observed zero.
const ORACLE = {
  "viability.median_continuation_turn": [20, 20, 20, 1],
  "viability.premature_absorbing_rate": [0, 0, 0, 1],
  "viability.distinct_state_trajectory_rate": [1, 1, 1, 1],
  "contact.median_first_contact_turn": [null, 2, 2, 1],
  "contact.mean_post_contact_events_per_turn": [null, 0.157895, 3, 19],
  "contact.meaningful_multi_polity_run_rate": [0, 1, 1, 1],
  "economy.median_production_consumption_ratio": [null, 0.5, 10, 20],
  "economy.insolvency_or_collapse_rate": [0, 0, 0, 1],
  "economy.unused_resource_saturation_rate": [0, 0, 0, 40],
  "technology.median_first_completion_turn": [null, 5, 5, 1],
  "technology.no_completion_rate": [1, 0, 0, 1],
  "technology.trivial_completion_rate": [0, 0, 0, 1],
  "population.recruitment_feasible_run_rate": [1, 1, 1, 1],
  "population.depletion_rate": [0, 0, 0, 1],
  "population.unit_saturation_rate": [0, 1, 40, 40],
  "population.casualty_recovery_rate": [null, 0.5, 1, 2],
  "conflict.mean_battles_per_run": [0, 1, 1, 1],
  "conflict.annihilation_rate": [0, 0, 0, 1],
  "conflict.perpetual_conflict_rate": [0, 0, 0, 1],
  "conflict.dominant_action_share": [null, 1, 2, 2],
  "information.median_discovery_turn": [null, 6, 6, 1],
  "information.detection_event_rate": [0, 0.05, 1, 20],
  "information.early_saturation_rate": [0, 0, 0, 1],
  "information.permanent_isolation_rate": [1, 0, 0, 1],
  "bandwidth.action_budget_utilization": [0, 0.0125, 2, 160],
  "bandwidth.phase_limit_block_rate": [null, 0.25, 1, 4],
  "runtime.deadline_failure_rate": [null, 0.5, 1, 2],
  "relational.median_commitment_opportunities": [0, 30, 30, 1],
  "relational.median_reciprocity_opportunities": [0, 3, 3, 1],
  "relational.rupture_opportunity_run_rate": [0, 1, 1, 1],
  "relational.repeated_interaction_density": [null, 0.105263, 2, 19],
  "relational.zero_opportunity_run_rate": [1, 0, 0, 1]
};
assert.deepEqual(Object.keys(ORACLE).sort(), calibrationProtocol().metrics.map(m => m.metric_id).sort());
for (const [id, [empty, rich, numerator, denominator]] of Object.entries(ORACLE)) {
  for (const enriched of [false, true]) test(`independent oracle: ${id} / ${enriched ? "opportunity" : "empty"}`, () => {
    const facts = deriveCalibrationMetricFacts(fixture(enriched)), fact = facts[id], expected = enriched ? rich : empty;
    assertMetricArtifact(facts, calibrationProtocol());
    assert.equal(fact.value, expected);
    assert.equal(fact.status, expected === null ? "ZERO_OPPORTUNITY" : "OBSERVED");
    if (enriched) { assert.equal(fact.numerator, String(numerator)); assert.equal(fact.denominator, String(denominator)); }
    if (expected === null) { assert.equal(fact.denominator, "0"); assert.equal(fact.eligibility_count, "0"); }
  });
}

test("failed research and non-economic elimination cannot fabricate completion or economy collapse", () => {
  const f = fixture();
  f.emit("WorldTransition", 1, { mechanic: "research" });
  f.emit("WorldTransition", 2, { mechanic: "research_outcome", before_state_ref: f.put({ technologies: [] }), after_state_ref: f.put({ technologies: [] }) });
  f.emit("WorldTransition", 3, { mechanic: "polity_elimination" });
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["technology.no_completion_rate"].value, 1);
  assert.equal(m["economy.insolvency_or_collapse_rate"].value, 0);
  assert.equal(m["conflict.annihilation_rate"].value, 1);
});

test("economy ratio compares food production with food consumption and ignores unlike outputs", () => {
  const f = fixture();
  f.emit("WorldTransition", 2, { mechanic: "economy", actor_ids: ["a"], detail: {
    production: { food: 10, credits: 500, resources: { iron: 700 } }, consumption: 20, deficit: 10
  } });
  const fact = deriveCalibrationMetricFacts(f)["economy.median_production_consumption_ratio"];
  assert.equal(fact.numerator, "10"); assert.equal(fact.denominator, "20"); assert.equal(fact.value, 0.5);
});

for (const [turn, expected] of [[14, 1], [15, 0], [16, 0]]) test(`annihilation and depletion before turn 16: engine index ${turn}`, () => {
  const f = fixture();
  f.emit("WorldTransition", turn, { mechanic: "polity_elimination" });
  for (const p of Object.values(f.snapshots[turn].state.polities)) p.citizens = [{ count: 25 }];
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["conflict.annihilation_rate"].value, expected);
  assert.equal(m["population.depletion_rate"].value, expected);
});

test("a run absorbed at turn 16 is not prematurely absorbed before turn 16", () => {
  const f = fixture(); f.snapshots.length = 16; f.store.events = f.store.events.filter(e => e.turn < 16);
  f.emit("RunDisposition", 15, { replacement_policy: { reason: "insufficient_surviving_distinct_participants" } });
  assert.equal(deriveCalibrationMetricFacts(f)["viability.premature_absorbing_rate"].value, 0);
});

test("economy collapse is reconstructed from production-shaped transitions and objective disposition", () => {
  const f = fixture(); f.configuration.dynamics.maxQuantity = 11;
  f.configuration.facilityTypes = { replacement: { credits: 0, food: 0, resources: {}, prerequisites: [] } };
  f.snapshots[4].state.polities.a.food = 11;
  f.snapshots[4].state.polities.b.food = 11;
  for (const polity of Object.values(f.snapshots.at(-1).state.polities)) {
    polity.citizens = []; polity.units = []; polity.population = 0; polity.permanently_action_incapable = true;
    f.emit("WorldTransition", 19, { mechanic: "economy", actor_ids: [polity.id],
      before_state_ref: f.put({ ...polity, citizens: [{ count: 1 }], population: 1 }), after_state_ref: f.put(polity),
      detail: { production: { food: 0, credits: 0, resources: {} }, consumption: 10, deficit: 10 } });
  }
  f.emit("RunDisposition", 19, { replacement_policy: { reason: "all_remaining_permanently_action_incapable" } });
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["economy.insolvency_or_collapse_rate"].value, 1);
  assert.equal(m["economy.median_production_consumption_ratio"].value, 0);
  assert.equal(m["economy.unused_resource_saturation_rate"].value, 0.05);
});

test("recruitment requires free population and an existing facility", () => {
  const f = fixture(true);
  for (const s of f.snapshots) for (const p of Object.values(s.state.polities)) p.citizens = [{ count: 0 }];
  assert.equal(deriveCalibrationMetricFacts(f)["population.recruitment_feasible_run_rate"].value, 0);
  for (const s of f.snapshots) { s.state.facilities = {}; for (const p of Object.values(s.state.polities)) p.citizens = [{ count: 100 }]; }
  f.configuration.initialFacilityTypes = ["barracks"];
  assert.equal(deriveCalibrationMetricFacts(f)["population.recruitment_feasible_run_rate"].value, 0);
});

test("unrelated recovery, rejected strategic actions and waits do not inflate denominators", () => {
  const f = fixture(true);
  f.emit("PopulationUnitTransition", 10, { transition: "recovery" }, [], { causality: { causation_ids: [] } });
  f.emit("ActionRejected", 1, { errors: [{ code: "action_limit_exceeded" }, { code: "invalid_action" }] });
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["population.casualty_recovery_rate"].value, 0.5);
  assert.equal(m["conflict.dominant_action_share"].denominator, "2");
  assert.equal(m["bandwidth.phase_limit_block_rate"].denominator, "4");
});

test("action utilization uses pre-resolution actors when an acting polity is eliminated", () => {
  const f = fixture(true);
  // RunCreated retains both eligible actors. The turn-0 post-resolution state
  // eliminates b, so only a is eligible from turn 1 onward.
  for (const snapshot of f.snapshots) snapshot.state.polities.b.alive = false;
  const fact = deriveCalibrationMetricFacts(f)["bandwidth.action_budget_utilization"];
  assert.equal(fact.numerator, "2");
  assert.equal(fact.denominator, "84"); // turn 0: 2*4; turns 1-19: 1*4
  assert.equal(fact.value, 0.02381);
  assert.notEqual(fact.denominator, "80", "post-resolution survivors must not define turn-0 capacity");
});

test("eight battle turns in final ten qualify, seven do not; short run is censored", () => {
  const f = fixture(); for (let t = 10; t < 17; t++) f.emit("BattleResolved", t, {}, ["a", "b"]);
  assert.equal(deriveCalibrationMetricFacts(f)["conflict.perpetual_conflict_rate"].value, 0);
  f.emit("BattleResolved", 17, {}, ["a", "b"]);
  assert.equal(deriveCalibrationMetricFacts(f)["conflict.perpetual_conflict_rate"].value, 1);
  f.store.events = f.store.events.filter(e => e.turn < 9); f.snapshots.length = 9;
  assert.equal(deriveCalibrationMetricFacts(f)["conflict.perpetual_conflict_rate"].status, "CENSORED");
});

test("reciprocity opportunity uses canonical cross-polity affordances and a full five-turn window", () => {
  const f = fixture();
  for (const [turn, category] of [[14, "exchange"], [15, "exchange"], [2, "chatter"]])
    f.emit("MessageSent", turn, { from: "a", to: "b", relational_category: category }, ["a", "b"]);
  f.emit("BattleResolved", 15, {}, ["a", "b"]);
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["relational.median_reciprocity_opportunities"].value, 2);
  assert.equal(m["relational.rupture_opportunity_run_rate"].value, 0);
  assert.equal(m["relational.zero_opportunity_run_rate"].value, 0);
});

test("all signed half-even ties use exact integer arithmetic", () => {
  assert.equal(divideHalfEven(5, 2), 2n); assert.equal(divideHalfEven(7, 2), 4n);
  assert.equal(divideHalfEven(-5, 2), -2n); assert.equal(divideHalfEven(-7, 2), -4n);
  assert.equal(decimalToScaled(1.0000005), 1000000n);
  assert.equal(decimalToScaled(1.0000015), 1000002n);
});

test("first-turn population loss is compared with RunCreated, including unit crews", () => {
  const f = fixture();
  for (const snapshot of f.snapshots) for (const polity of Object.values(snapshot.state.polities)) polity.citizens = [{ count: 25 }];
  assert.equal(deriveCalibrationMetricFacts(f)["population.depletion_rate"].value, 1);
  for (const polity of Object.values(f.snapshots[0].state.polities)) polity.citizens = [{ count: 26 }];
  for (const snapshot of f.snapshots.slice(1)) for (const polity of Object.values(snapshot.state.polities)) polity.citizens = [{ count: 100 }];
  assert.equal(deriveCalibrationMetricFacts(f)["population.depletion_rate"].value, 0);
});

test("turn-1 discovery and detection use initial knowledge and count reports once", () => {
  const f = fixture();
  for (const snapshot of f.snapshots) {
    snapshot.state.polities.a.knowledge = ["b"];
    snapshot.state.polities.a.reports = [{ source: "activity_detection", id: "turn-one" }];
  }
  const m = deriveCalibrationMetricFacts(f);
  assert.equal(m["information.median_discovery_turn"].value, 1);
  assert.equal(m["information.detection_event_rate"].numerator, "1");
  assert.equal(m["information.detection_event_rate"].denominator, "20");
  const initial = structuredClone(f.snapshots[0].state);
  f.store.events.find(e => e.event_type === "RunCreated").payload.initial_state_ref = f.put(initial);
  const prior = deriveCalibrationMetricFacts(f);
  assert.equal(prior["information.median_discovery_turn"].status, "ZERO_OPPORTUNITY");
  assert.equal(prior["information.detection_event_rate"].numerator, "0");
});

test("production-shaped accepted actions resolve through canonical action IDs", () => {
  const world = makeWorld({ runId: "calibration-production-action-lineage", seed: "production-action-lineage" });
  const actorId = "polity-1", ledger = new ActionLedger(world.evidence);
  const submission = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId,
    actor: { persistent_identity_id: actorId, session_id: "session-1", invocation_id: "invocation-1" },
    actions: [{ type: "wait" }], projection: projectWorld(world, actorId), phase: "actions" });
  const validated = ledger.validate(submission, world);
  resolveTurn(world, commitTurn(world, ledger, [validated]));
  const snapshots = world.evidence.events.filter(event => event.event_type === "SnapshotCreated")
    .map(event => ({ event, state: readEvidencePayload(world.evidence, event.payload.state_ref) }));
  const facts = deriveCalibrationMetricFacts({ store: world.evidence, snapshots, configuration: world.config, synthetic: true });
  assert.equal(facts["conflict.dominant_action_share"].status, "ZERO_OPPORTUNITY");
  assert.equal(facts["bandwidth.action_budget_utilization"].numerator, "0");
});

test("endpoint coding cannot alter treatment-neutral calibration opportunity counts", () => {
  const f = fixture(true), messages = f.store.events.filter(event => event.event_type === "MessageSent");
  const before = deriveCalibrationMetricFacts(f)["relational.median_reciprocity_opportunities"];
  const mappingRef = f.put({ refs: { [messages[0].event_id]: "observation-1", [messages[1].event_id]: "observation-2" } });
  const row = { id: "reciprocity-1", kind: "reciprocity", source: "observation-1", actor: "subject-1",
    counterparty: "subject-2", eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null,
    category: "resource_assistance_exchange", responses: [{ source: "observation-2", actor: "subject-2",
      counterparty: "subject-1", polarity: "POSITIVE", category: "retaliatory_response" }] };
  const prior = f.emit("BehaviorCoded", 18, { mapping_ref: mappingRef, annotations: [{ ...row, id: "superseded" }, row], supersedes: null });
  f.emit("BehaviorCoded", 19, { mapping_ref: mappingRef, annotations: [row], supersedes: prior.event_id });
  const after = deriveCalibrationMetricFacts(f)["relational.median_reciprocity_opportunities"];
  assert.deepEqual(after, before);
});

test("channel membership is canonical contact even when transition participants list only the initiator", () => {
  const f = fixture();
  f.emit("WorldTransition", 2, { mechanic: "channels", before_state_ref: f.put({}),
    after_state_ref: f.put({ channel: { id: "channel", members: ["a", "b"] } }), actor_ids: ["a"] }, ["a"]);
  const facts = deriveCalibrationMetricFacts(f);
  assert.equal(facts["contact.median_first_contact_turn"].value, 3);
  assert.equal(facts["contact.meaningful_multi_polity_run_rate"].value, 0);
});
