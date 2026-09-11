import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, resolveTurn, PILOT_0_CONFIG } from "../src/world.js";
import { discoverPolity, observeWorld } from "../src/world-map.js";
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { clone } from "../src/core.js";
import { EvidenceStore } from "../src/evidence.js";
import { prepareSyntheticCodingPacket, recordCoding } from "../src/coding.js";
import { deriveCalibrationMetricFacts } from "../src/calibration-metrics.js";

const actor = id => ({ persistent_identity_id: id, session_id: `session-${id}`, invocation_id: `invocation-${id}` });
function turn(world, orders) {
  const ledger = new ActionLedger(world.evidence);
  const accepted = Object.entries(orders).map(([actorId, actions]) => {
    const submission = ledger.submit({ runId: world.runId, turnId: `turn-${world.turn}`, actorId, actor: actor(actorId),
      actions: actions.map((action, index) => ({ action_id: `participant-${world.turn}-${actorId}-${index}`, ...action })),
      projection: projectWorld(world, actorId) });
    const result = ledger.validate(submission, world);
    assert.equal(result.submission.status, "validated", JSON.stringify(result.submission.validation));
    return result;
  });
  resolveTurn(world, commitTurn(world, ledger, accepted));
}
function facts(world) {
  return deriveCalibrationMetricFacts({ store: world.evidence,
    snapshots: world.snapshots.map(snapshot => ({ event: { turn: snapshot.turn }, state: snapshot.state })),
    configuration: world.config, synthetic: true });
}

test("production ActionLedger canonical IDs drive accepted-action calibration metrics", () => {
  const world = makeWorld({ runId: "nonempirical-calibration-action-shape", seed: "metric-shape" });
  turn(world, { "polity-1": [{ type: "broadcast", text: "hello" }] });
  const result = facts(world);
  assert.equal(result["conflict.dominant_action_share"].value, 1);
  assert.equal(result["bandwidth.action_budget_utilization"].numerator, "1");
  const submitted = world.evidence.events.find(event => event.event_type === "ActionSubmitted").payload;
  assert.notEqual(submitted.submitted_actions[0].action_id, submitted.actions[0].action_id,
    "regression fixture must preserve participant and canonical action identity separation");
});

test("production channel discovery and shared technology are visible to calibration metrics", () => {
  const world = makeWorld({ runId: "nonempirical-calibration-channel-tech-shape", seed: "metric-shape" });
  const a = world.polities["polity-1"], b = world.polities["polity-2"], c = world.polities["polity-3"];
  discoverPolity(world, a, b.id, "synthetic_fixture_setup");
  discoverPolity(world, b, a.id, "synthetic_fixture_setup");
  discoverPolity(world, a, c.id, "synthetic_fixture_setup");
  a.technologies = [...new Set([...a.technologies, "agronomy"])];
  observeWorld(world, a.id); observeWorld(world, b.id);
  turn(world, { [a.id]: [{ type: "channel_create", members: [b.id] }, { type: "share_technology", technology: "agronomy", to: b.id }] });
  const channel = Object.values(world.channels)[0];
  turn(world, { [a.id]: [{ type: "channel_invite", channel_id: channel.id, to: c.id }] });
  const result = facts(world);
  assert.equal(result["contact.median_first_contact_turn"].value, 1);
  assert.equal(result["contact.meaningful_multi_polity_run_rate"].value, 1,
    "canonical channel creation and invitation are both contact events");
  assert.equal(result["technology.median_first_completion_turn"].value, 1);
  assert.equal(result["technology.no_completion_rate"].value, 0);
});

test("production battle loss followed by production demobilization creates reachable casualty recovery", () => {
  const config = clone(PILOT_0_CONFIG);
  config.unitTypes.infantry.citizens = 1;
  config.dynamics.combatMinimumHitPermille = 1000;
  config.dynamics.combatMaximumHitPermille = 1000;
  config.dynamics.combatDamage = 100;
  const world = makeWorld({ runId: "nonempirical-calibration-recovery-shape", seed: "metric-shape", config });
  turn(world, { "polity-1": [{ type: "recruit" }], "polity-2": [{ type: "recruit" }] });
  turn(world, { "polity-2": [{ type: "recruit" }] });
  const attacker = world.polities["polity-1"].units[0], target = world.polities["polity-2"].units[0];
  attacker.hex_id = "hex-5-2"; attacker.territory_id = world.hexes[attacker.hex_id].territory_id;
  target.hex_id = "hex-6-2"; target.territory_id = world.hexes[target.hex_id].territory_id;
  observeWorld(world, "polity-1"); observeWorld(world, "polity-2");
  turn(world, { "polity-1": [{ type: "attack", unit_id: attacker.id, target_unit_id: target.id }] });
  const survivor = world.polities["polity-2"].units[0];
  const training = Object.values(world.facilities).find(facility => facility.owner_id === "polity-2" && facility.type === "training");
  survivor.hex_id = training.hex_ids[0]; survivor.territory_id = world.hexes[survivor.hex_id].territory_id;
  observeWorld(world, "polity-2");
  turn(world, { "polity-2": [{ type: "demobilize", unit_id: survivor.id, facility_id: training.id }] });
  const recovery = facts(world)["population.casualty_recovery_rate"];
  assert.equal(recovery.denominator, "1");
  assert.equal(recovery.numerator, "1");
  assert.equal(recovery.value, 1);
});

test("production coding remains irrelevant to treatment-neutral reciprocity opportunity measurement", () => {
  const store = new EvidenceStore("nonempirical-calibration-coding-shape");
  const state = { polities: { a: { id: "a", alive: true, citizens: [{ count: 10 }], units: [], technologies: [], knowledge: ["a"], credits: 1, food: 1, resources: {} },
    b: { id: "b", alive: true, citizens: [{ count: 10 }], units: [], technologies: [], knowledge: ["b"], credits: 1, food: 1, resources: {} } }, facilities: {} };
  store.append({ eventType: "RunCreated", turn: 0, phase: "setup", participants: ["a", "b"], payload: { run_id: store.runId, initial_state_ref: store.putPayload(state) } });
  store.append({ eventType: "MessageSent", turn: 0, phase: "communication", participants: ["a", "b"], payload: { from: "a", to: "b", text: "I share supplies." } });
  store.append({ eventType: "MessageSent", turn: 1, phase: "communication", participants: ["b", "a"], payload: { from: "b", to: "a", text: "I reciprocate with supplies." } });
  for (let turnIndex = 0; turnIndex < 6; turnIndex++) store.append({ eventType: "TurnResolved", turn: turnIndex, phase: "resolution", payload: { synthetic: true } });
  const snapshots = Array.from({ length: 6 }, (_, turnIndex) => ({ event: { turn: turnIndex }, state: clone(state) }));
  const configuration = { phases: { actionLimit: 1 }, dynamics: { maxQuantity: 100 }, unitTypes: {}, facilityTypes: {}, technologies: {}, initialFacilityTypes: [] };
  const before = deriveCalibrationMetricFacts({ store, snapshots, configuration, synthetic: true })["relational.median_reciprocity_opportunities"];
  const packet = prepareSyntheticCodingPacket(store);
  const messages = packet.input.observations.filter(observation => observation.type === "MessageSent");
  const annotation = { id: "reciprocity", kind: "reciprocity", source: messages[0].ref, actor: "subject-1", counterparty: "subject-2",
    eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null,
    category: "resource_assistance_exchange", responses: [{ source: messages[1].ref, actor: "subject-2", counterparty: "subject-1",
      polarity: "POSITIVE", category: "resource_assistance_exchange" }] };
  const code = confidence => recordCoding(store, packet, { annotations: [{ ...annotation, confidence }],
    reviewedRefs: packet.input.observations.map(observation => observation.ref), coder: { id: "fixture", version: "1", mode: "synthetic_fixture" },
    supersedes: store.events.filter(event => event.event_type === "BehaviorCoded").at(-1)?.event_id ?? null });
  code(0.8); code(1);
  const result = deriveCalibrationMetricFacts({ store, snapshots, configuration, synthetic: true });
  assert.deepEqual(result["relational.median_reciprocity_opportunities"], before);
  assert.equal(store.events.filter(event => event.event_type === "BehaviorCoded").length, 2);
});
