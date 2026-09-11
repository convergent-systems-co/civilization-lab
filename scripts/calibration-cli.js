#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { CalibrationArchive, CALIBRATION_TOOLING_VERSION, PhaseACalibrationRunner, calibrationKeyId, loadCalibrationExecutionModule } from "../src/calibration-runner.js";
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
  for (const indexed of archive.state.attempts) {
    const manifest = await archive.manifest(indexed.attempt_id);
    const declared = manifest.policy_configuration?.kind;
    const modelRuntimeUsed = manifest.model_runtime_configuration?.used;
    if (declared === SOFTWARE_EVIDENCE_POLICY && modelRuntimeUsed === false) continue;
    throw new SoftwareEvidenceProvenanceViolation(
      `attempt ${indexed.attempt_id} declares policy ${declared} with model runtime use ${modelRuntimeUsed}; ` +
      `this tooling commit attests ${SOFTWARE_EVIDENCE_POLICY} software evidence only and cannot verify it as an empirical archive`);
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
    const directory = option("--archive"), publicKeyPath = option("--public-key"), keyId = option("--key-id");
    if (!directory || !publicKeyPath || !keyId) throw new Error("verify requires --archive, --public-key, and --key-id");
    const publicKey = createPublicKey(await readFile(resolve(publicKeyPath), "utf8"));
    // Trust is supplied entirely by the caller: the archive's state envelopes and its
    // attestations are both bound to the operator's key, never to a built-in default.
    const archive = await CalibrationArchive.open(resolve(directory), { publicKey, keyId });
    await archive.verify({ trustedKeys: { [keyId]: publicKey } });
    await assertSoftwareEvidenceProvenance(archive);
    console.log(JSON.stringify({ status: "PASS", archive: resolve(directory), protocol_version: protocol.protocol_version }));
} else if (command === "run") {
  const authorizationPath = option("--authorization"), authorizationPublicKeyPath = option("--authorization-public-key");
  const adapterPath = option("--adapter-module"), directory = option("--archive");
  const releasePath = option("--release-descriptor"), releasePublicPath = option("--release-public-key");
  const attestorPrivatePath = option("--attestor-private-key"), attestorPublicPath = option("--attestor-public-key");
  const evidencePublicPath = option("--evidence-public-key"), evidenceHeadPublicPath = option("--evidence-head-public-key");
  if (!authorizationPath || !authorizationPublicKeyPath || !adapterPath || !directory || !attestorPrivatePath || !attestorPublicPath || !releasePath || !releasePublicPath)
    throw new Error("empirical calibration is not authorized without --authorization, --authorization-public-key, --adapter-module, --archive, --attestor-private-key, and --attestor-public-key");
  const authorization = JSON.parse(await readFile(resolve(authorizationPath), "utf8"));
  const releaseDescriptor = JSON.parse(await readFile(resolve(releasePath), "utf8"));
  const releaseTrust = await readFile(resolve(releasePublicPath), "utf8");
  const authorizationPublicKey = createPublicKey(await readFile(resolve(authorizationPublicKeyPath), "utf8"));
  const embedded = createPublicKey(authorization.public_key);
  if (calibrationKeyId(embedded) !== calibrationKeyId(authorizationPublicKey)) throw new Error("authorization capability is not bound to the external authorization trust root");
  if (!evidencePublicPath || !evidenceHeadPublicPath) throw new Error("external --evidence-public-key and --evidence-head-public-key are required");
  const adapter = await loadCalibrationExecutionModule(adapterPath, authorization, { archiveDirectory: directory,
    authorizationTrust: authorizationPublicKey.export({ type: "spki", format: "pem" }), releaseDescriptor, releaseTrust });
  const privateKey = createPrivateKey(await readFile(resolve(attestorPrivatePath), "utf8"));
  const publicKey = createPublicKey(await readFile(resolve(attestorPublicPath), "utf8"));
  const keyId = calibrationKeyId(publicKey);
  const runner = new PhaseACalibrationRunner({ directory: resolve(directory), mode: "EMPIRICAL_CALIBRATION",
    implementationCommit: "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59", executor: adapter, authorization,
    authorizationTrust: authorizationPublicKey.export({ type: "spki", format: "pem" }), releaseDescriptor, releaseTrust,
    evidencePublicKey: await readFile(resolve(evidencePublicPath), "utf8"), evidenceHeadPublicKey: await readFile(resolve(evidenceHeadPublicPath), "utf8"),
    attestor: { privateKey, publicKey, keyId, trustScope: "EMPIRICAL_CALIBRATION" } });
  const result = await runner.run();
  console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error(`unknown calibration command: ${command}`);
  }
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
