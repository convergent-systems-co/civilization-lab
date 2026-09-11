import test from "node:test";
import assert from "node:assert/strict";
import { calibrationProtocol } from "../src/calibration.js";
import { makeWorld } from "../src/world.js";
import { projectWorld } from "../src/contracts.js";
import { assertParticipantActionPayload } from "../src/action-contract.js";
import {
  PHASE_A_POLICY_PACKAGE,
  PHASE_A_POLICY_PACKAGE_HASH,
  assignCalibrationPolicies,
  decideCalibrationActions,
  validatePhaseAPolicyPackage,
  validateSyntheticPolicyCoverage
} from "../src/calibration-policy.js";

const expectedRoles = [
  "EXPANSION_EXPLORATION", "ECONOMIC_DEVELOPMENT", "TECHNOLOGY_DEVELOPMENT", "DEFENSIVE_SECURITY",
  "COMPETITIVE_AGGRESSIVE", "COOPERATIVE_EXCHANGE", "OPPORTUNISTIC_MIXED", "CONSERVATIVE_LOW_ACTIVITY"
];

test("the frozen Phase A package is closed, versioned, eight-role, treatment neutral, and no-model", () => {
  assert.equal(validatePhaseAPolicyPackage(PHASE_A_POLICY_PACKAGE), true);
  assert.deepEqual(PHASE_A_POLICY_PACKAGE.roles.map(role => role.policy_id), expectedRoles);
  assert.equal(PHASE_A_POLICY_PACKAGE.model_use, "PROHIBITED");
  assert.equal(PHASE_A_POLICY_PACKAGE.treatment_allocation, "NONE");
  assert.match(PHASE_A_POLICY_PACKAGE_HASH, /^[a-f0-9]{64}$/);
  for (const forbidden of ["authoritative_world_state", "treatment_labels", "endpoint_scores", "llm_inference"])
    assert(PHASE_A_POLICY_PACKAGE.prohibited_inputs.includes(forbidden));
});

test("assignment is deterministic, vector/iteration invariant, and exactly balanced over the frozen seed panel", () => {
  const seeds = calibrationProtocol().seed_panel.seeds;
  const participant_ids = ["polity-3", "polity-1", "polity-2"];
  const counts = Object.fromEntries(expectedRoles.map(role => [role, 0]));
  for (const seed of seeds) {
    const first = assignCalibrationPolicies({ participant_ids, seed, seed_panel: seeds });
    const second = assignCalibrationPolicies({ participant_ids: [...participant_ids].reverse(), seed, seed_panel: seeds });
    assert.deepEqual(first, second);
    for (const role of Object.values(first)) counts[role]++;
  }
  assert.deepEqual(Object.values(counts), Array(8).fill(9));
  assert.throws(() => assignCalibrationPolicies({ participant_ids, seed: seeds[0], seed_panel: seeds, parameter_vector: {} }), /closed input/);
  assert.throws(() => assignCalibrationPolicies({ participant_ids, seed: "unregistered", seed_panel: seeds }), /frozen seed panel/);
});

test("policy decisions accept only authorized projections and emit complete participant action payloads", () => {
  const world = makeWorld({ runId: "synthetic-policy-projection", seed: "calibration-seed-00" });
  const projection = projectWorld(world, "polity-1");
  const applicable_configuration = projection.fields.find(field => field.path === "public.rules").value;
  for (const policy_id of expectedRoles) {
    const first = decideCalibrationActions({ projection, policy_id, applicable_configuration });
    const second = decideCalibrationActions({ projection: structuredClone(projection), policy_id,
      applicable_configuration: structuredClone(applicable_configuration) });
    assert.deepEqual(first, second);
    assert(first.length > 0);
    for (const action of first) assert.equal(assertParticipantActionPayload(action), true);
  }
  assert.throws(() => decideCalibrationActions({ projection, policy_id: expectedRoles[0], applicable_configuration,
    authoritative_world_state: world.authoritativeState() }), /closed input|prohibited/);
  assert.throws(() => decideCalibrationActions({ projection: { ...projection, observer_truth: {} }, policy_id: expectedRoles[0], applicable_configuration }), /schema validation/);
});

test("hidden authoritative changes cannot influence deterministic policy decisions", () => {
  const world = makeWorld({ runId: "synthetic-policy-noninterference", seed: "calibration-seed-00" });
  const before = projectWorld(world, "polity-1");
  const applicableBefore = before.fields.find(item => item.path === "public.rules").value;
  const decisionBefore = decideCalibrationActions({ projection: before, policy_id: "EXPANSION_EXPLORATION",
    applicable_configuration: applicableBefore });
  world.polities["polity-3"].credits += 999999;
  world.polities["polity-3"].resources.crystal += 999999;
  const after = projectWorld(world, "polity-1");
  const applicableAfter = after.fields.find(item => item.path === "public.rules").value;
  assert.deepEqual(after, before);
  assert.deepEqual(decideCalibrationActions({ projection: after, policy_id: "EXPANSION_EXPLORATION",
    applicable_configuration: applicableAfter }), decisionBefore);
});

test("coverage cannot pass from the package's declarative claims or fabricated actions", () => {
  assert.throws(() => validateSyntheticPolicyCoverage(), /closed input|evidence stores/);
  assert.throws(() => validateSyntheticPolicyCoverage({ evidence_stores: [] }), /reducer-backed evidence stores/);
});
