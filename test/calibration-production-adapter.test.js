import test from "node:test";
import assert from "node:assert/strict";
import { calibrationProtocol } from "../src/calibration.js";
import { collectCalibrationObservations, materializeCalibrationRuntime, startingCalibrationParameterSet } from "../src/calibration-runner.js";
import { verifyEvidenceIntegrity } from "../src/replay.js";
import { sha256, stableId } from "../src/core.js";
import { PHASE_A_POLICY_MANIFEST, PHASE_A_POLICY_PACKAGE_HASH, calibrationPolicyRequestBinding } from "../src/calibration-policy.js";
import { PHASE_A_MODEL_RUNTIME_LOCK } from "../src/calibration-runtime.js";
import { createPhaseAProductionAdapter } from "../src/calibration-production-adapter.js";

const request = seed => {
  const parameterSet = startingCalibrationParameterSet();
  const runtimeConfiguration = materializeCalibrationRuntime(parameterSet);
  const calibrationRunId = "synthetic-production-adapter-conformance";
  const attemptId = stableId("calibration-attempt", calibrationProtocol().protocol_version, sha256(parameterSet), seed);
  const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE" });
  return { schema_version: "phase-a-execution-request-1.0.0", mode: "SYNTHETIC_CONFORMANCE",
    calibrationRunId, attemptId, idempotencyKey: stableId("calibration-execution-intent", calibrationRunId, sha256(parameterSet), seed),
    seed, parameterSet, runtimeConfiguration, maxTurns: 20,
    objectiveTerminalPredicates: parameterSet["world.termination.objective_predicates"],
    policyBinding: calibrationPolicyRequestBinding({ participant_ids: ["polity-1", "polity-2", "polity-3"], seed,
      seed_panel: calibrationProtocol().seed_panel.seeds }),
    adapterContractHash: sha256(adapter.contract), adapterPackageHash: null,
    neutralPolicyManifest: null, modelRuntimeLock: null };
};

test("production Phase A adapter executes actual Pilot 0 reducers for at most 20 turns with no Qwen", async () => {
  const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE" });
  const value = request(calibrationProtocol().seed_panel.seeds[0]); value.adapterContractHash = sha256(adapter.contract);
  const result = await adapter.execute(value);
  const bundle = result.bundle ?? result;
  assert.equal(verifyEvidenceIntegrity(bundle).status, "EVIDENCE_INTEGRITY_VERIFIED");
  assert.equal(bundle.events.filter(event => event.event_type === "TurnResolved").length, 20);
  assert(bundle.events.some(event => event.event_type === "ActionSubmitted"));
  assert(bundle.events.some(event => event.event_type === "TurnCommitted"));
  assert(bundle.events.some(event => event.event_type === "WorldTransition"));
  assert.equal(bundle.events.filter(event => event.event_type === "SnapshotCreated").length, 20);
  assert(bundle.events.filter(event => event.event_type === "SnapshotCreated")
    .every(event => event.payload.snapshot_class === "POST_MEMORY_LIFECYCLE"));
  assert.equal(bundle.events.some(event => event.event_type === "ModelInvocation"), false);
  const runCreated = bundle.events.find(event => event.event_type === "RunCreated");
  const recordedConfiguration = JSON.parse(bundle.payloads[runCreated.payload.configuration_ref].bytes);
  const executionBinding = JSON.parse(bundle.payloads[runCreated.payload.calibration_execution_binding_ref].bytes);
  assert.equal(recordedConfiguration.calibration_policy_package_hash, undefined);
  assert.equal(executionBinding.policy_package_hash, PHASE_A_POLICY_PACKAGE_HASH);
  assert.equal(executionBinding.policy_package_version, "phase-a-policy-panel-1.0.0");
  assert.equal(adapter.contract.max_turns, 20);
  assert.equal(adapter.contract.model_use_declared, false);
  const observations = collectCalibrationObservations(bundle, { mode: "SYNTHETIC_CONFORMANCE",
    expectedParameterSet: request(calibrationProtocol().seed_panel.seeds[0]).parameterSet,
    expectedSeed: calibrationProtocol().seed_panel.seeds[0] });
  assert.equal(observations.seed, calibrationProtocol().seed_panel.seeds[0]);
  assert.equal(Object.keys(observations.metrics).length, calibrationProtocol().metrics.length);
});

test("recover-by-execution-intent is byte-identical and rejects intent mutation", async () => {
  const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE" });
  const value = request(calibrationProtocol().seed_panel.seeds[1]);
  value.adapterContractHash = sha256(adapter.contract);
  const first = await adapter.execute(value);
  const recovered = await adapter.recover(structuredClone(value));
  assert.deepEqual(recovered, first);
  await assert.rejects(adapter.recover({ ...value, maxTurns: 19 }), /execution request|20 turns/);
  await assert.rejects(adapter.execute({ ...value, treatment_arm: "persistent" }), /closed execution request|prohibited/);
});

test("adapter rejects an unknown seed, parameter/runtime drift, and hidden policy substitution", async () => {
  const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE" });
  const valid = request(calibrationProtocol().seed_panel.seeds[2]);
  valid.adapterContractHash = sha256(adapter.contract);
  await assert.rejects(adapter.execute({ ...valid, seed: "cherry-picked" }), /frozen seed panel/);
  await assert.rejects(adapter.execute({ ...valid, runtimeConfiguration: { ...valid.runtimeConfiguration,
    effective_configuration_hash: "0".repeat(64) } }), /runtime configuration/);
  await assert.rejects(adapter.execute({ ...valid, neutralPolicyManifest: { policy_id: "substitute" } }), /substitution prohibited/);
  const substituted = structuredClone(valid);
  substituted.policyBinding.assignment["polity-1"] = "CONSERVATIVE_LOW_ACTIVITY";
  substituted.policyBinding.assignment_hash = sha256(substituted.policyBinding.assignment);
  await assert.rejects(adapter.execute(substituted), /policy package\/assignment binding/);
});

test("empirical adapter construction fails closed without separately durable journal and evidence trust domains", () => {
  const deadlines = { workerTimeoutMs: 120000, evidenceAuthorityTimeoutMs: 15000 };
  assert.throws(() => createPhaseAProductionAdapter({ executionMode: "EMPIRICAL_CALIBRATION", ...deadlines }), /durable intent journal/);
  assert.throws(() => createPhaseAProductionAdapter({ executionMode: "EMPIRICAL_CALIBRATION",
    ...deadlines, journal: { durable: true, async get() { return null; }, async put() {} }, evidenceAuthority: { async finalize() {} } }),
  /isolated evidence authority/);
});

test("recovery after the replay/publication boundary regenerates one byte-identical canonical run", { timeout: 120000 }, async () => {
  let injected = false;
  const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE", fault: async stage => {
    if (!injected && stage === "after_exact_replay_before_seal") { injected = true; throw new Error("synthetic process crash"); }
  } });
  const value = request(calibrationProtocol().seed_panel.seeds[3]); value.adapterContractHash = sha256(adapter.contract);
  await assert.rejects(adapter.execute(value), /synthetic process crash/);
  const recovered = await adapter.recover(value);
  const fresh = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE" });
  const comparison = structuredClone(value); comparison.adapterContractHash = sha256(fresh.contract);
  assert.deepEqual(recovered, await fresh.execute(comparison));
  assert.equal(recovered.events.filter(event => event.event_type === "RunDisposition").length, 1);
});

test("dispatch and pre-commit world fault boundaries are explicit and never publish a result", async () => {
  for (const [stage, boundary] of [
    ["after_dispatch_before_world_execution", "AFTER_DISPATCH_BEFORE_WORLD_EXECUTION"],
    ["after_first_canonical_event", "AFTER_FIRST_CANONICAL_EVENT"],
    ["during_world_execution", "DURING_WORLD_EXECUTION"]
  ]) {
    let injected = false;
    const adapter = createPhaseAProductionAdapter({ executionMode: "SYNTHETIC_CONFORMANCE", fault: async point => {
      if (!injected && point === stage) { injected = true; throw new Error(`crash:${stage}`); }
    } });
    const value = request(calibrationProtocol().seed_panel.seeds[4]);
    value.adapterContractHash = sha256(adapter.contract);
    await assert.rejects(adapter.execute(value), error => error.calibrationBoundary === boundary);
    assert.equal(injected, true);
  }
});

test("recovery consults authority once, retains that observation on a later failure, and does not redispatch blindly", async () => {
  let reads = 0;
  const observation = { body: { execution_intent_id: "placeholder", state: "ABSENT", request_hash: null }, signature: "signed-upstream" };
  const journal = { durable: true, async get(key) { reads += 1; observation.body.execution_intent_id = key;
    return { authority_observation: structuredClone(observation) }; }, async put() {} };
  const adapter = createPhaseAProductionAdapter({ executionMode: "EMPIRICAL_CALIBRATION", journal,
    evidenceAuthority: { trustDomain: "EXTERNAL_EVIDENCE_AUTHORITY", async finalize() { throw new Error("must not finalize"); } },
    workerTimeoutMs: 5000, evidenceAuthorityTimeoutMs: 1000, fault: async stage => {
      if (stage === "after_dispatch_before_world_execution") throw new Error("post-reconciliation outage");
    } });
  const value = request(calibrationProtocol().seed_panel.seeds[5]);
  Object.assign(value, { mode: "EMPIRICAL_CALIBRATION", adapterContractHash: sha256(adapter.contract),
    adapterPackageHash: "a".repeat(64), neutralPolicyManifest: PHASE_A_POLICY_MANIFEST,
    modelRuntimeLock: PHASE_A_MODEL_RUNTIME_LOCK });
  await assert.rejects(adapter.recover(value, { adapterPackageDigest: "a".repeat(64) }), error => {
    assert.equal(error.calibrationBoundary, "AFTER_DISPATCH_BEFORE_WORLD_EXECUTION");
    assert.equal(error.calibrationAuthorityObservation.body.state, "ABSENT"); return true;
  });
  assert.equal(reads, 1);
});

test("lost runner acknowledgement after authoritative finalization is retryable and returns the exact finalized result", { timeout: 120000 }, async () => {
  let state = "ABSENT", finalized = null, injected = false;
  const journal = { durable: true, async get(key) { return { authority_observation: { body: {
    execution_intent_id: key, state, request_hash: state === "FINALIZED" ? sha256(value) : null,
    result: state === "FINALIZED" ? finalized : null }, signature: "signed-upstream" } }; }, async put() {} };
  const evidenceAuthority = { trustDomain: "EXTERNAL_EVIDENCE_AUTHORITY", async finalize(input) {
    finalized = { bundle: input.bundle, archive_export: {}, evidence_head_receipt: {}, adapter_execution_receipt: {} };
    state = "FINALIZED"; return structuredClone(finalized);
  } };
  const adapter = createPhaseAProductionAdapter({ executionMode: "EMPIRICAL_CALIBRATION", journal, evidenceAuthority,
    workerTimeoutMs: 120000, evidenceAuthorityTimeoutMs: 15000, fault: async stage => {
      if (!injected && stage === "after_authority_finalize") { injected = true; throw new Error("runner response lost"); }
    } });
  const value = request(calibrationProtocol().seed_panel.seeds[6]);
  Object.assign(value, { mode: "EMPIRICAL_CALIBRATION", adapterContractHash: sha256(adapter.contract),
    adapterPackageHash: "b".repeat(64), neutralPolicyManifest: PHASE_A_POLICY_MANIFEST,
    modelRuntimeLock: PHASE_A_MODEL_RUNTIME_LOCK });
  await assert.rejects(adapter.execute(value, { adapterPackageDigest: "b".repeat(64) }), error => {
    assert.equal(error.code, "CALIBRATION_INFRASTRUCTURE_AUTHORITY");
    assert.equal(error.calibrationBoundary, "AFTER_AUTHORITY_FINALIZE_BEFORE_RUNNER_ACK");
    assert.deepEqual(error.calibrationRawResult, finalized);
    assert.equal(error.calibrationEvidenceHeadReceipts.length, 2);
    return true;
  });
  assert.deepEqual(await adapter.recover(structuredClone(value), { adapterPackageDigest: "b".repeat(64) }), finalized);
});
