import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalize, sha256 } from "../src/core.js";
import { SignedArchive, archiveKeyId } from "../src/archive.js";
import { EvidenceStore, loadEvidence } from "../src/evidence.js";
import { CalibrationArchive, assertCalibrationEvidenceTrust, assertCalibrationPhaseBudgetEvidence, collectCalibrationObservations, verifyAdapterExecutionReceipt } from "../src/calibration-runner.js";
import { calibrationProtocol } from "../src/calibration.js";
import { syntheticCanonicalEvidence, syntheticAttestationKeys } from "./helpers/calibration-fixture.js";

// All inputs are synthetic software fixtures. No empirical adapter is executed.
async function archiveFixture() {
  const bundle = syntheticCanonicalEvidence(), pair = generateKeyPairSync("ed25519"), keyId = archiveKeyId(pair.publicKey);
  const directory = await mkdtemp(join(tmpdir(), "calibration-evidence-boundary-"));
  const archive = new SignedArchive({ directory, runId: bundle.run_id, ...pair, keyId });
  const head = await archive.publish(bundle, { expectedHead: null });
  const exported = await archive.export({ authorizationContext: { domain: "trusted_replay", principal: "synthetic-test" }, authorize: () => true });
  return { bundle, exported, pair, trust: { runId: bundle.run_id, publicKey: pair.publicKey, keyId, trustedHead: head } };
}

test("collector refuses synthetic fixtures in empirical mode even with a valid external signature", async () => {
  const f = await archiveFixture();
  assert.equal(assertCalibrationEvidenceTrust(f.bundle, f.exported, f.trust).status, "COMPLETE");
  assert.throws(() => collectCalibrationObservations(f.bundle, { mode: "EMPIRICAL_CALIBRATION", archiveExport: f.exported, archiveTrust: f.trust }), /synthetic evidence cannot enter empirical/);
  assert.throws(() => collectCalibrationObservations(f.bundle, { mode: "EMPIRICAL_CALIBRATION" }), /synthetic evidence cannot enter empirical/);
  assert.doesNotThrow(() => collectCalibrationObservations(f.bundle, { mode: "SYNTHETIC_CONFORMANCE" }));
});

test("external evidence verification rejects missing, stale, substituted heads and signer keys", async () => {
  const f = await archiveFixture(), other = generateKeyPairSync("ed25519");
  for (const trust of [
    { ...f.trust, trustedHead: null },
    { ...f.trust, trustedHead: { generation: 0, digest: "0".repeat(64) } },
    { ...f.trust, trustedHead: { generation: 1, digest: f.trust.trustedHead.digest } },
    { ...f.trust, runId: "another-run" },
    { ...f.trust, publicKey: other.publicKey, keyId: archiveKeyId(other.publicKey) }
  ]) assert.throws(() => assertCalibrationEvidenceTrust(f.bundle, f.exported, trust), /head|rollback|authority|lineage/);
  const altered = structuredClone(f.exported); altered.object.bundle.run_id = "fabricated";
  assert.throws(() => assertCalibrationEvidenceTrust(f.bundle, altered, f.trust), /object\/run\/digest/);
});

test("archive never trusts an adapter-supplied evidence key or unsigned head receipt", async () => {
  const f = await archiveFixture(), headPair = generateKeyPairSync("ed25519");
  const directory = await mkdtemp(join(tmpdir(), "calibration-authority-boundary-"));
  const pem = key => key.export({ type: "spki", format: "pem" });
  const archive = await new CalibrationArchive(directory, { ...syntheticAttestationKeys(), evidenceAuthority: {
    evidencePublicKey: pem(f.pair.publicKey), headPublicKey: pem(headPair.publicKey), adapterHash: "a".repeat(64), executableHash: "b".repeat(64)
  } }).initialize({ protocolVersion: calibrationProtocol().protocol_version,
    implementationCommit: "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59", executionMode: "EMPIRICAL_CALIBRATION" });
  assert.throws(() => archive.collectionOptions(f.bundle, { archive_trust: f.trust }), /head receipt/);
  const body = { version: "phase-a-evidence-head-1.0.0", mode: "EMPIRICAL_CALIBRATION", run_id: f.bundle.run_id,
    evidence_key_id: f.trust.keyId, adapter_hash: "a".repeat(64), head: f.trust.trustedHead };
  const receipt = { body, signature: sign(null, Buffer.from(canonicalize(body)), f.pair.privateKey).toString("base64") };
  assert.throws(() => archive.collectionOptions(f.bundle, { evidence_head_receipt: receipt }), /head receipt signature/);
  receipt.signature = sign(null, Buffer.from(canonicalize(body)), headPair.privateKey).toString("base64");
  assert.throws(() => archive.collectionOptions(f.bundle, { evidence_head_receipt: receipt }), /authorized adapter executable/);
});

test("adapter execution receipt binds neutral policy, request, vector and evidence", () => {
  const bundle = syntheticCanonicalEvidence(), signer = generateKeyPairSync("ed25519");
  const authority = { headPublicKey: signer.publicKey.export({ type: "spki", format: "pem" }), policyManifestHash: "a".repeat(64),
    adapterHash: "b".repeat(64), executableHash: "c".repeat(64) };
  const executionRequest = { schema_version: "phase-a-execution-request-1.0.0", seed: calibrationProtocol().seed_panel.seeds[0] };
  const context = { expected_seed: executionRequest.seed, expected_parameter_set_hash: "d".repeat(64),
    execution_request: executionRequest, execution_request_hash: sha256(executionRequest),
    adapter_package_digest: authority.executableHash };
  const body = { version: "phase-a-adapter-execution-receipt-1.0.0", mode: "EMPIRICAL_CALIBRATION",
    run_id: bundle.run_id, seed: context.expected_seed, parameter_set_hash: context.expected_parameter_set_hash,
    execution_request_hash: context.execution_request_hash, policy_manifest_hash: authority.policyManifestHash,
    adapter_hash: authority.adapterHash, adapter_executable_hash: authority.executableHash,
    adapter_package_digest: authority.executableHash, evidence_hash: sha256(bundle) };
  context.adapter_execution_receipt = { body, signature: sign(null, Buffer.from(canonicalize(body)), signer.privateKey).toString("base64") };
  assert.deepEqual(verifyAdapterExecutionReceipt(bundle, context, authority), {
    execution_request_hash: context.execution_request_hash, policy_manifest_hash: authority.policyManifestHash });
  for (const field of ["policy_manifest_hash", "execution_request_hash", "adapter_package_digest", "evidence_hash"]) {
    const altered = structuredClone(context); altered.adapter_execution_receipt.body[field] = "f".repeat(64);
    assert.throws(() => verifyAdapterExecutionReceipt(bundle, altered, authority), /receipt binding/);
  }
});

test("canonical phase evidence must bind the calibrated per-phase overrides", () => {
  const evidence = new EvidenceStore("synthetic-phase-budget-proof"), overrides = { diplomacy: 10, final_planning: 20 };
  const stateRef = evidence.putPayload({ phase: "diplomacy" }, "turn_phase_observer");
  const budgetRef = evidence.putPayload({ value: overrides }, "phase_budget_manifest");
  evidence.append({ eventType: "WorldTransition", turn: 0, phase: "diplomacy", provenance: { input_refs: [stateRef, budgetRef] }, payload: {
    schema_version: "1.0.0", run_id: evidence.runId, mechanic: "turn_phase_state", action_ids: [], actor_ids: [],
    before_state_ref: stateRef, after_state_ref: stateRef, detail: { phase_contract_version: "synthetic" }
  } });
  const store = loadEvidence(evidence.bundle());
  assert.equal(assertCalibrationPhaseBudgetEvidence(store, overrides), true);
  assert.throws(() => assertCalibrationPhaseBudgetEvidence(store, { ...overrides, diplomacy: 11 }), /differs from calibrated override/);
});
