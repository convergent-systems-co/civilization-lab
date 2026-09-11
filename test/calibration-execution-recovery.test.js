import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableId, sha256 } from "../src/core.js";
import { calibrationProtocol } from "../src/calibration.js";
import { CalibrationArchive, PhaseACalibrationRunner, materializeCalibrationRuntime, startingCalibrationParameterSet } from "../src/calibration-runner.js";
import { syntheticAttestationKeys, syntheticCanonicalEvidence } from "./helpers/calibration-fixture.js";
import { calibrationPolicyRequestBinding } from "../src/calibration-policy.js";

const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";

test("a durable pending seed intent resumes through adapter recovery without redispatch", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "calibration-intent-recovery-"));
  const trust = syntheticAttestationKeys(), protocol = calibrationProtocol();
  const archive = await new CalibrationArchive(directory, trust).initialize({
    protocolVersion: protocol.protocol_version, implementationCommit: implementation, executionMode: "SYNTHETIC_CONFORMANCE"
  });
  const parameterSet = startingCalibrationParameterSet(), parameterHash = sha256(parameterSet), seed = protocol.seed_panel.seeds[0];
  const attemptId = stableId("calibration-attempt", protocol.protocol_version, parameterHash, seed);
  const request = { schema_version: "phase-a-execution-request-1.0.0", mode: "SYNTHETIC_CONFORMANCE",
    calibrationRunId: archive.state.calibration_run_id, attemptId,
    idempotencyKey: stableId("calibration-execution-intent", archive.state.calibration_run_id, parameterHash, seed), seed,
    parameterSet, runtimeConfiguration: materializeCalibrationRuntime(parameterSet), maxTurns: 20,
    objectiveTerminalPredicates: parameterSet["world.termination.objective_predicates"],
    policyBinding: calibrationPolicyRequestBinding({ participant_ids: ["polity-1", "polity-2", "polity-3"], seed,
      seed_panel: protocol.seed_panel.seeds }), adapterContractHash: null, adapterPackageHash: null,
    neutralPolicyManifest: null, modelRuntimeLock: null };
  await archive.recordExecutionIntent({ attemptId, parameterSetHash: parameterHash, seed, request });

  let dispatched = 0, recovered = 0;
  const executor = {
    durableIntentConformance: true,
    async execute(value) { dispatched++; return syntheticCanonicalEvidence({ seed: value.seed, runtimeConfiguration: value.runtimeConfiguration }); },
    async recover(value) { recovered++; assert.equal(value.idempotencyKey, request.idempotencyKey); return syntheticCanonicalEvidence({ seed: value.seed, runtimeConfiguration: value.runtimeConfiguration }); }
  };
  await new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor, attestor: trust }).run({ maximumCandidates: 1 });
  assert.equal(recovered, 1);
  assert.equal(dispatched, protocol.seed_panel.seeds.length - 1);
  const reopened = await CalibrationArchive.open(directory, trust);
  const intent = reopened.state.execution_intents.find(item => item.key === `${parameterHash}:${seed}`);
  assert.equal(intent.status, "EVIDENCE_PERSISTED");
  assert.equal(reopened.state.executions.filter(item => item.key === intent.key).length, 1);
});

test("adapter-returned bytes are quarantined before post-return evidence validation can fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calibration-return-quarantine-"));
  const trust = syntheticAttestationKeys();
  const executor = { durableIntentConformance: true, async execute() { return {
    bundle: { run_id: "returned-invalid-evidence", events: [{ fabricated: true }] }, archive_export: { raw: true },
    evidence_head_receipt: { raw: true }, adapter_execution_receipt: { raw: true }
  }; } };
  await assert.rejects(new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
    implementationCommit: implementation, executor, attestor: trust }).run({ maximumCandidates: 1 }));
  const reopened = await CalibrationArchive.open(directory, trust);
  assert.equal(reopened.state.quarantined_results.length, 1);
  const item = reopened.state.quarantined_results[0];
  const raw = JSON.parse(await readFile(join(directory, item.path), "utf8"));
  assert.equal(raw.result.bundle.run_id, "returned-invalid-evidence");
  const manifest = await reopened.manifest(item.attempt_id);
  assert.equal(manifest.canonical_evidence_ref, item.path);
  assert.notEqual(manifest.canonical_evidence_ref.startsWith("unavailable://"), true);
});
