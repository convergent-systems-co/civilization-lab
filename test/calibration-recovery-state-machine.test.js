import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, stableId } from "../src/core.js";
import { calibrationProtocol } from "../src/calibration.js";
import { calibrationPolicyRequestBinding } from "../src/calibration-policy.js";
import {
  CALIBRATION_EXECUTION_STATES,
  CALIBRATION_FAILURES,
  CalibrationArchive,
  materializeCalibrationRuntime,
  startingCalibrationParameterSet
} from "../src/calibration-runner.js";
import { syntheticAttestationKeys, syntheticCanonicalEvidence, withTempArchive } from "./helpers/calibration-fixture.js";

const protocol = calibrationProtocol();
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";

function requestFor(runId, seed = protocol.seed_panel.seeds[0], parameterSet = startingCalibrationParameterSet()) {
  const parameterSetHash = sha256(parameterSet);
  const attemptId = stableId("calibration-attempt", protocol.protocol_version, parameterSetHash, seed);
  return { parameterSetHash, attemptId, request: {
    schema_version: "phase-a-execution-request-1.0.0", mode: "SYNTHETIC_CONFORMANCE",
    calibrationRunId: runId, attemptId,
    idempotencyKey: stableId("calibration-execution-intent", runId, parameterSetHash, seed), seed,
    parameterSet, runtimeConfiguration: materializeCalibrationRuntime(parameterSet), maxTurns: 20,
    objectiveTerminalPredicates: parameterSet["world.termination.objective_predicates"],
    policyBinding: calibrationPolicyRequestBinding({ participant_ids: ["polity-1", "polity-2", "polity-3"],
      seed, seed_panel: protocol.seed_panel.seeds }),
    adapterContractHash: null, adapterPackageHash: null, neutralPolicyManifest: null, modelRuntimeLock: null
  }};
}

async function archiveFixture(directory) {
  const trust = syntheticAttestationKeys();
  const archive = await new CalibrationArchive(directory, trust)
    .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  return { archive, trust };
}

test("original regression: infrastructure failure cannot poison completed_keys while intent remains recoverable", async () => {
  await withTempArchive(async directory => {
    const { archive, trust } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const first = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: first.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "authority unavailable",
      boundary: "BEFORE_DISPATCH_AUTHORITY_RECONCILIATION" });

    assert.deepEqual(archive.state.completed_keys, []);
    assert.deepEqual(archive.state.attempts, []);
    assert.equal(archive.state.execution_intents[0].status, CALIBRATION_EXECUTION_STATES.FAILED_RETRYABLE);
    assert.equal(archive.state.execution_attempts[0].transitions.at(-1).state, CALIBRATION_EXECUTION_STATES.FAILED_RETRYABLE);

    const reopened = await CalibrationArchive.open(directory, trust);
    const second = await reopened.beginExecutionAttempt({ ...args, seed: args.request.seed, recovering: true });
    assert.notEqual(second.execution_attempt_id, first.execution_attempt_id);
    assert.equal(second.parent_execution_attempt_id, first.execution_attempt_id);
    assert.equal(reopened.state.execution_attempts[0].next_execution_attempt_id, second.execution_attempt_id);
    await reopened.recordEvidence({ attemptId: args.attemptId, executionAttemptId: second.execution_attempt_id,
      parameterSetHash: args.parameterSetHash, seed: args.request.seed,
      bundle: syntheticCanonicalEvidence({ seed: args.request.seed }), executionContext: {
        adapter_execution_receipt: null, adapter_package_digest: null, archive_export: null, evidence_head_receipt: null,
        execution_request: args.request, execution_request_hash: sha256(args.request),
        expected_parameter_set_hash: args.parameterSetHash, expected_seed: args.request.seed
      } });
    assert.equal(reopened.state.executions.length, 1);
    assert.equal(reopened.state.completed_keys.length, 0,
      "successful execution evidence alone does not bypass frozen calibration assessment");
  });
});

test("failed-attempt evidence is explicit, canonical, and sufficient for recovery disposition", async () => {
  await withTempArchive(async directory => {
    const { archive } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[1]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const attempt = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: attempt.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "response lost after commit",
      boundary: "EVIDENCE_COMMIT_ACKNOWLEDGEMENT_UNCERTAIN" });
    const indexed = archive.state.execution_attempts[0];
    const failure = JSON.parse(await readFile(join(directory, indexed.failure_record_path), "utf8"));
    assert.equal(sha256(failure), indexed.failure_record_hash);
    assert.equal(failure.calibration_key, `${args.parameterSetHash}:${args.request.seed}`);
    assert.equal(failure.seed, args.request.seed);
    assert.equal(failure.policy_assignment_hash, args.request.policyBinding.assignment_hash);
    assert.equal(failure.failure_boundary, "EVIDENCE_COMMIT_ACKNOWLEDGEMENT_UNCERTAIN");
    assert.equal(failure.last_successful_boundary, "EXACT_REPLAY_COMPLETED_AUTHORITY_COMMIT_UNCONFIRMED");
    assert.deepEqual(failure.evidence_head_receipts, []);
    assert.deepEqual(failure.partial_canonical_evidence, { status: "ABSENT_NOT_EMITTED", event_refs: [] });
    assert.equal(failure.recovery_eligibility, "AUTHORITY_RECONCILIATION_REQUIRED");
  });
});

test("retry preserves seed, vector, policy, protocol, RNG intent, and rejects every substitution", async () => {
  await withTempArchive(async directory => {
    const { archive } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[2]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const first = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: first.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "unavailable" });
    const mutations = [
      { ...args.request, seed: protocol.seed_panel.seeds[3] },
      { ...args.request, parameterSet: { ...args.request.parameterSet, "world.map.width": 99 } },
      { ...args.request, policyBinding: { ...args.request.policyBinding, assignment_hash: "0".repeat(64) } }
    ];
    for (const request of mutations)
      await assert.rejects(() => archive.beginExecutionAttempt({ ...args, seed: args.request.seed, request, recovering: true }),
        /immutable logical intent/);
    assert.equal(archive.state.execution_attempts.length, 1);
    assert.deepEqual(archive.state.completed_keys, []);
  });
});

test("corrupted or missing failed-attempt evidence fails closed", async () => {
  await withTempArchive(async directory => {
    const { archive, trust } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[4]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const attempt = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: attempt.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "unavailable" });
    const path = join(directory, archive.state.execution_attempts[0].failure_record_path);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, evidence_head_receipts: undefined }) + "\n");
    await assert.rejects(() => CalibrationArchive.open(directory, trust), /hash mismatch|schema validation/);
  });
});

test("simultaneous recovery workers are serialized and cannot create two accepted outcomes", async () => {
  await withTempArchive(async directory => {
    const { archive, trust } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[5]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const first = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: first.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "unavailable" });
    const a = await CalibrationArchive.open(directory, trust), b = await CalibrationArchive.open(directory, trust);
    const settled = await Promise.allSettled([
      a.beginExecutionAttempt({ ...args, seed: args.request.seed, recovering: true }),
      b.beginExecutionAttempt({ ...args, seed: args.request.seed, recovering: true })
    ]);
    assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter(item => item.status === "rejected").length, 1);
    const reopened = await CalibrationArchive.open(directory, trust);
    assert.equal(reopened.state.execution_attempts.length, 2);
    assert.equal(reopened.state.executions.length, 0);
    assert.equal(reopened.state.completed_keys.length, 0);
  });
});

test("repeated retry and duplicate delivery are idempotent while one execution attempt is active", async () => {
  await withTempArchive(async directory => {
    const { archive } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[6]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const first = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    const duplicate = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed, recovering: true });
    assert.equal(duplicate.execution_attempt_id, first.execution_attempt_id);
    assert.equal(archive.state.execution_attempts.length, 1);
    assert.equal(archive.state.executions.length, 0);
    assert.deepEqual(archive.state.completed_keys, []);
  });
});

test("failed-attempt snapshot remains immutable when signed state links a retry", async () => {
  await withTempArchive(async directory => {
    const { archive } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[7]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const first = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    await archive.recordExecutionAttemptFailure({ executionAttemptId: first.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "unavailable",
      boundary: "BEFORE_DISPATCH_AUTHORITY_RECONCILIATION" });
    const snapshotPath = join(directory, archive.state.execution_attempts[0].failure_record_path);
    const before = await readFile(snapshotPath, "utf8");
    const retry = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed, recovering: true });
    assert.equal(await readFile(snapshotPath, "utf8"), before);
    assert.equal(archive.state.execution_attempts[0].next_execution_attempt_id, retry.execution_attempt_id);
    assert.equal(JSON.parse(before).parent_execution_attempt_id, null);
  });
});

test("post-finalization failure records the authoritative success boundary and available receipts", async () => {
  await withTempArchive(async directory => {
    const { archive } = await archiveFixture(directory);
    const args = requestFor(archive.state.calibration_run_id, protocol.seed_panel.seeds[8]);
    await archive.recordExecutionIntent({ ...args, seed: args.request.seed });
    const attempt = await archive.beginExecutionAttempt({ ...args, seed: args.request.seed });
    const receipts = [{ body: { kind: "evidence-head" }, signature: "retained" },
      { body: { kind: "adapter" }, signature: "retained" }];
    const failure = await archive.recordExecutionAttemptFailure({ executionAttemptId: attempt.execution_attempt_id,
      classification: CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE,
      errorCode: "CALIBRATION_INFRASTRUCTURE_AUTHORITY", errorMessage: "acknowledgement lost",
      boundary: "AFTER_AUTHORITY_FINALIZE_BEFORE_RUNNER_ACK", evidenceHeadReceipts: receipts });
    assert.equal(failure.last_successful_boundary, "AUTHORITATIVE_FINALIZATION_COMPLETED");
    assert.deepEqual(failure.evidence_head_receipts, receipts);
    assert.equal(failure.root_cause.structured_context.evidence_head_receipt_count, 2);
  });
});
