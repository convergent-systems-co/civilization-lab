#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { assertCalibrationReleaseTrust, CalibrationArchive, CALIBRATION_TOOLING_VERSION, PhaseACalibrationRunner,
  assertSecureCalibrationArchiveDirectory, assertSecureCalibrationPrivateKeyPath,
  calibrationDeploymentTrustPolicy, calibrationKeyId, loadCalibrationExecutionModule } from "../src/calibration-runner.js";
import { calibrationProtocol, enumerateCalibrationOperations } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import { sha256 } from "../src/core.js";

const protocol = calibrationProtocol();
// The Pilot 0 turn bound is read from the frozen registry rather than restated
// here, so the printed plan cannot drift from the parameter it reports.
const registeredValue = parameterId => {
  const entry = parameterRegistry().parameters.find(parameter => parameter.parameter_id === parameterId);
  if (!entry) throw new Error(`${parameterId} is not registered`);
  return entry.value;
};
const [command = "plan", ...args] = process.argv.slice(2);
// This tooling commit carries no empirical authorization, so the only provenance it
// can vouch for is deterministic synthetic conformance — software evidence. An
// archive attempt that declares any other policy configuration, or declares model
// runtime use, claims empirical provenance this commit cannot attest. Such an
// archive is refused by class instead of being reported as a passing verification,
// so a correctly signed synthetic fixture cannot be promoted into an empirical one.
const SOFTWARE_EVIDENCE_POLICY = "deterministic_synthetic_conformance";
class SoftwareEvidenceProvenanceViolation extends Error {
  constructor(message) { super(message); this.name = "SoftwareEvidenceProvenanceViolation"; }
}
const assertSoftwareEvidenceProvenance = async archive => {
  if (archive.state.execution_mode !== "SYNTHETIC_CONFORMANCE" || archive.state.authorization_hash !== null ||
    archive.state.authorization_key_id !== null || archive.state.campaign_id !== null)
    throw new SoftwareEvidenceProvenanceViolation("software evidence verification requires an unambiguously synthetic archive state");
  for (const indexed of archive.state.attempts) {
    const manifest = await archive.manifest(indexed.attempt_id);
    const declared = manifest.policy_configuration?.kind;
    const modelRuntimeUsed = manifest.model_runtime_configuration?.used;
    if (declared === SOFTWARE_EVIDENCE_POLICY && modelRuntimeUsed === false) continue;
    throw new SoftwareEvidenceProvenanceViolation(
      `attempt ${indexed.attempt_id} declares policy ${declared} with model runtime use ${modelRuntimeUsed}; ` +
      `this tooling commit attests ${SOFTWARE_EVIDENCE_POLICY} software evidence only and cannot verify it as an empirical archive`);
  }
  if (archive.state.status === "COMPLETE") {
    const result = JSON.parse(await readFile(resolve(archive.directory, "CALIBRATION_RESULT.json"), "utf8"));
    const world = JSON.parse(await readFile(resolve(archive.directory, "PILOT_0_WORLD_CONFIGURATION.json"), "utf8"));
    if (result.execution_mode !== "SYNTHETIC_CONFORMANCE" || result.result_type !== "CALIBRATION_CONFORMANCE_RESULT" ||
      result.evidence_class !== "SYNTHETIC_SOFTWARE_CONFORMANCE" || world.execution_mode !== "SYNTHETIC_CONFORMANCE" ||
      world.evidence_class !== "SYNTHETIC_SOFTWARE_CONFORMANCE" || world.status !== "SYNTHETIC_CONFORMANCE_ONLY_NOT_A_WORLD_PROPOSAL")
      throw new SoftwareEvidenceProvenanceViolation("synthetic archive result/evidence class mismatch");
  }
};
// A flag consumes the next argument only when that argument is a value: a dangling
// `--archive --public-key key.pem` must fail rather than silently bind the archive
// path to the next flag name.
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const assertProvisionedTrustRoots = async (releasePublicKey, authorizationPublicKey) => {
  const registry = calibrationDeploymentTrustPolicy();
  if (registry.status !== "PROVISIONED" ||
    !registry.approved_release_key_ids?.includes(calibrationKeyId(releasePublicKey)) ||
    !registry.approved_authorization_key_ids?.includes(calibrationKeyId(authorizationPublicKey)))
    throw new Error("empirical release/authorization authority is absent from the distribution-pinned deployment trust policy");
  return registry;
};

// Every verb reports a refusal as one operator-readable line on stderr with a
// non-zero exit status, rather than as an escaping stack trace.
try {
  if (command === "plan") {
    const operations = enumerateCalibrationOperations();
    console.log(JSON.stringify({
      tooling_version: CALIBRATION_TOOLING_VERSION,
      protocol_version: protocol.protocol_version,
      protocol_hash: sha256(protocol),
      frozen_seed_count: protocol.seed_panel.seeds.length,
      candidate_operations: operations.length,
      maximum_parameter_sets: protocol.search_procedure.maximum_parameter_sets,
      maximum_rounds: protocol.search_procedure.maximum_rounds,
      pilot_0_max_turns: registeredValue("pilot_0.max_turns"),
      empirical_calibration_authorized: false,
      next_action: "A separate empirical authorization and execution adapter are required."
    }, null, 2));
  } else if (command === "verify") {
    const verifyMode = option("--mode") ?? "synthetic";
    if (!["synthetic", "empirical"].includes(verifyMode)) throw new Error("--mode must be synthetic or empirical");
    const directory = option("--archive"), publicKeyPath = option("--archive-public-key") ?? option("--public-key"),
      keyId = option("--archive-key-id") ?? option("--key-id"), trustedHeadPath = option("--trusted-head"),
      attestorPublicPath = option("--attestor-public-key") ?? (verifyMode === "synthetic" ? publicKeyPath : null),
      attestorKeyId = option("--attestor-key-id") ?? (verifyMode === "synthetic" ? keyId : null);
    if (!directory || !publicKeyPath || !keyId || !trustedHeadPath) throw new Error("verify requires --archive, --public-key, --key-id, and --trusted-head");
    if (!attestorPublicPath || !attestorKeyId) throw new Error("empirical verify requires an independent --attestor-public-key and --attestor-key-id");
    const publicKey = createPublicKey(await readFile(resolve(publicKeyPath), "utf8"));
    const attestorPublicKey = createPublicKey(await readFile(resolve(attestorPublicPath), "utf8"));
    const trustedHead = JSON.parse(await readFile(resolve(trustedHeadPath), "utf8"));
    if (!Number.isSafeInteger(trustedHead?.generation) || !/^[a-f0-9]{64}$/.test(trustedHead?.digest ?? "")) throw new Error("invalid externally retained trusted head");
    // Trust is supplied entirely by the caller: the archive's state envelopes,
    // final head and attestations are never authorized by archive-local material.
    let trust = { publicKey, keyId, trustedHead, exactTrustedHead: true,
      attestationAuthority: { publicKey: attestorPublicKey, keyId: attestorKeyId } };
    if (verifyMode === "empirical") {
      const authorizationPath = option("--authorization"), authorizationPublicPath = option("--authorization-public-key"),
        releasePath = option("--release-descriptor"), releasePublicPath = option("--release-public-key"),
        adapterPath = option("--adapter-module"), evidencePublicPath = option("--evidence-public-key"),
        evidenceHeadPublicPath = option("--evidence-head-public-key"), revocationsPath = option("--revocations");
      if (!authorizationPath || !authorizationPublicPath || !releasePath || !releasePublicPath || !adapterPath || !evidencePublicPath || !evidenceHeadPublicPath || !revocationsPath)
        throw new Error("empirical verify requires signed authorization/release, authorized adapter, and independent evidence/evidence-head trust");
      const authorization = JSON.parse(await readFile(resolve(authorizationPath), "utf8"));
      const revocationRegistry = JSON.parse(await readFile(resolve(revocationsPath), "utf8"));
      const releaseDescriptor = JSON.parse(await readFile(resolve(releasePath), "utf8"));
      const authorizationPublicKey = createPublicKey(await readFile(resolve(authorizationPublicPath), "utf8"));
      const releaseTrust = await readFile(resolve(releasePublicPath), "utf8");
      const trustPolicy = await assertProvisionedTrustRoots(createPublicKey(releaseTrust), authorizationPublicKey);
      const archiveDirectory = assertSecureCalibrationArchiveDirectory(directory);
      const evidencePublicKey = await readFile(resolve(evidencePublicPath), "utf8"), headPublicKey = await readFile(resolve(evidenceHeadPublicPath), "utf8");
      await loadCalibrationExecutionModule(adapterPath, authorization, { archiveDirectory,
        authorizationTrust: authorizationPublicKey.export({ type: "spki", format: "pem" }), releaseDescriptor, releaseTrust,
        trustPolicy, revocationRegistry });
      const releaseBinding = assertCalibrationReleaseTrust(releaseDescriptor, releaseTrust, trustPolicy);
      if (keyId !== authorization.archive_key_id || attestorKeyId !== authorization.attestor_key_id ||
        calibrationKeyId(createPublicKey(evidencePublicKey)) !== authorization.evidence_key_id ||
        calibrationKeyId(createPublicKey(headPublicKey)) !== authorization.evidence_head_key_id)
        throw new Error("empirical verifier authorities differ from signed authorization");
      const codingPublicPath = option("--coding-public-key"), codingKeyId = option("--coding-key-id"), codingAuthorityId = option("--coding-authority-id");
      if ([codingPublicPath, codingKeyId, codingAuthorityId].some(Boolean) && [codingPublicPath, codingKeyId, codingAuthorityId].some(value => !value))
        throw new Error("coding trust requires --coding-public-key, --coding-key-id, and --coding-authority-id together");
      trust = { ...trust, trustScope: "EMPIRICAL_ARCHIVE", releaseBinding,
        executionBinding: { authorization_hash: sha256(authorization), authorization_key_id: authorization.key_id,
          campaign_id: authorization.campaign_id, calibration_run_id: authorization.calibration_run_id,
          attestor_key_id: authorization.attestor_key_id },
        evidenceAuthority: { evidencePublicKey, headPublicKey, adapterHash: authorization.adapter_hash,
          executableHash: sha256(authorization.adapter_executable), policyManifestHash: authorization.policy_manifest_hash,
          policyId: authorization.policy_manifest.policy_id, modelUseDeclared: authorization.policy_manifest.model_use_declared },
        ...(codingPublicPath ? { codingTrust: { publicKey: await readFile(resolve(codingPublicPath), "utf8"), keyId: codingKeyId,
          authorityId: codingAuthorityId } } : {}) };
    }
    const archive = await CalibrationArchive.open(resolve(directory), trust);
    await archive.verify({ trustedKeys: { [keyId]: publicKey, [attestorKeyId]: attestorPublicKey } });
    if (verifyMode === "synthetic") await assertSoftwareEvidenceProvenance(archive);
    else if (archive.state.execution_mode !== "EMPIRICAL_CALIBRATION") throw new Error("empirical verifier refuses a synthetic archive");
    if (archive.state.status !== "COMPLETE" || archive.state.result_ref !== "CALIBRATION_RESULT.json")
      throw new Error("release verification requires a complete calibration result archive");
    console.log(JSON.stringify({ status: "PASS", archive: resolve(directory), protocol_version: protocol.protocol_version,
      execution_mode: archive.state.execution_mode,
      evidence_class: archive.state.execution_mode === "SYNTHETIC_CONFORMANCE" ? "SYNTHETIC_SOFTWARE_CONFORMANCE" : "EMPIRICAL_CALIBRATION_EVIDENCE" }));
} else if (command === "run") {
  const authorizationPath = option("--authorization"), authorizationPublicKeyPath = option("--authorization-public-key");
  const adapterPath = option("--adapter-module"), directory = option("--archive");
  const releasePath = option("--release-descriptor"), releasePublicPath = option("--release-public-key");
  const revocationsPath = option("--revocations");
  const attestorPrivatePath = option("--attestor-private-key"), attestorPublicPath = option("--attestor-public-key");
  const archivePrivatePath = option("--archive-private-key"), archivePublicPath = option("--archive-public-key");
  const evidencePublicPath = option("--evidence-public-key"), evidenceHeadPublicPath = option("--evidence-head-public-key");
  if (!authorizationPath || !authorizationPublicKeyPath || !adapterPath || !directory || !attestorPrivatePath || !attestorPublicPath ||
    !archivePrivatePath || !archivePublicPath || !releasePath || !releasePublicPath || !revocationsPath)
    throw new Error("empirical calibration is not authorized without authorization, release, revocation registry, adapter, archive destination, independent archive-signer keys, and attestor keys");
  const authorization = JSON.parse(await readFile(resolve(authorizationPath), "utf8"));
  const releaseDescriptor = JSON.parse(await readFile(resolve(releasePath), "utf8"));
  const revocationRegistry = JSON.parse(await readFile(resolve(revocationsPath), "utf8"));
  const releaseTrust = await readFile(resolve(releasePublicPath), "utf8");
  const authorizationPublicKey = createPublicKey(await readFile(resolve(authorizationPublicKeyPath), "utf8"));
  const releasePublicKey = createPublicKey(releaseTrust);
  const trustPolicy = await assertProvisionedTrustRoots(releasePublicKey, authorizationPublicKey);
  const archiveDirectory = assertSecureCalibrationArchiveDirectory(directory);
  const embedded = createPublicKey(authorization.public_key);
  if (calibrationKeyId(embedded) !== calibrationKeyId(authorizationPublicKey)) throw new Error("authorization capability is not bound to the external authorization trust root");
  if (!evidencePublicPath || !evidenceHeadPublicPath) throw new Error("external --evidence-public-key and --evidence-head-public-key are required");
  const adapter = await loadCalibrationExecutionModule(adapterPath, authorization, { archiveDirectory,
    authorizationTrust: authorizationPublicKey.export({ type: "spki", format: "pem" }), releaseDescriptor,
    releaseTrust, trustPolicy, revocationRegistry });
  const secureAttestorPrivatePath = assertSecureCalibrationPrivateKeyPath(attestorPrivatePath, { archiveDirectory, adapterPath });
  const secureArchivePrivatePath = assertSecureCalibrationPrivateKeyPath(archivePrivatePath, { archiveDirectory, adapterPath });
  const privateKey = createPrivateKey(await readFile(secureAttestorPrivatePath, "utf8"));
  const publicKey = createPublicKey(await readFile(resolve(attestorPublicPath), "utf8"));
  const keyId = calibrationKeyId(publicKey);
  const archivePrivateKey = createPrivateKey(await readFile(secureArchivePrivatePath, "utf8"));
  const archivePublicKey = createPublicKey(await readFile(resolve(archivePublicPath), "utf8"));
  const archiveKeyId = calibrationKeyId(archivePublicKey);
  const runner = new PhaseACalibrationRunner({ directory: archiveDirectory, mode: "EMPIRICAL_CALIBRATION",
    implementationCommit: "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59", executor: adapter, authorization, revocationRegistry,
    authorizationTrust: authorizationPublicKey.export({ type: "spki", format: "pem" }), releaseDescriptor, releaseTrust, trustPolicy,
    evidencePublicKey: await readFile(resolve(evidencePublicPath), "utf8"), evidenceHeadPublicKey: await readFile(resolve(evidenceHeadPublicPath), "utf8"),
    archiveSigner: { privateKey: archivePrivateKey, publicKey: archivePublicKey, keyId: archiveKeyId, trustScope: "EMPIRICAL_ARCHIVE" },
    attestor: { privateKey, publicKey, keyId, trustScope: "EMPIRICAL_ATTESTATION" } });
  const result = await runner.run();
  console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error(`unknown calibration command: ${command}`);
  }
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
