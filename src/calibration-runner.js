import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { readFileSync, readdirSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { platform, arch, release, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { assert, canonicalize, clone, sha256, stableId } from "./core.js";
import { evidenceManifest, loadEvidence, readEvidencePayload } from "./evidence.js";
import { reconstructRun, verifyEvidenceIntegrity } from "./replay.js";
import { verifyArchiveTrust } from "./archive-trust.js";
import { assertValidSchema } from "./schema.js";
import {
  assessCalibrationCandidate,
  assertTreatmentBlind,
  calibrationProtocolIncident,
  calibrationProtocol,
  enumerateCalibrationOperations,
  selectCalibrationCandidate,
  validateCalibrationProtocol
} from "./calibration.js";
import { parameterRegistry } from "./parameters.js";
import { archivedCoding } from "./coding.js";
import { ACTION_CONTRACT_HASH } from "./contracts.js";
import { assertMetricArtifact, CALIBRATION_METRIC_DEFINITION_HASH, decimalToScaled, deriveCalibrationMetricFacts, fixedRatio, metricFact } from "./calibration-metrics.js";
import { PHASE_A_NEUTRAL_CONDITION, PHASE_A_POLICY_PACKAGE, PHASE_A_POLICY_PACKAGE_HASH, calibrationPolicyRequestBinding } from "./calibration-policy.js";
import { PHASE_A_MODEL_RUNTIME_LOCK, PHASE_A_MODEL_RUNTIME_LOCK_HASH, materializePhaseARuntime } from "./calibration-runtime.js";
import { CalibrationExecutionError, calibrationFailureClassification, implementationDefect, infrastructureDeadline } from "./calibration-errors.js";
import { validateEvidenceAuthorityConfiguration } from "./calibration-evidence-authority-client.js";

const protocol = calibrationProtocol();
const baseline = JSON.parse(readFileSync(new URL("../validation/PRE_CALIBRATION_BASELINE.json", import.meta.url), "utf8"));
const deploymentTrustPolicy = JSON.parse(readFileSync(new URL("../config/calibration-trust-policy.json", import.meta.url), "utf8"));
const BASELINE_COMMIT = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const BASELINE_TAG = "v0.1.0-pilot0";
const STATE_VERSION = "phase-a-calibration-state-1.0.0";
const MANIFEST_VERSION = "phase-a-calibration-manifest-2.0.0";
const ATTESTATION_VERSION = "phase-a-calibration-attestation-1.0.0";
const PROTOCOL_HASH = sha256(protocol);
const REGISTRY_HASH = sha256(parameterRegistry());
export const CALIBRATION_DEPLOYMENT_TRUST_POLICY_HASH = sha256(deploymentTrustPolicy);
const PROJECTION_CONTRACT_HASH = sha256(JSON.parse(readFileSync(new URL("../PROJECTION_POLICY.spec.json", import.meta.url), "utf8")));
export const CALIBRATION_MODEL_RUNTIME_LOCK = PHASE_A_MODEL_RUNTIME_LOCK;
export const CALIBRATION_MODEL_RUNTIME_LOCK_HASH = PHASE_A_MODEL_RUNTIME_LOCK_HASH;
const HASH = /^[a-f0-9]{64}$/;
const TOOLING_DISTRIBUTION_FILES = Object.freeze([
  "../src/calibration.js", "../src/calibration-metrics.js", "../src/calibration-runner.js",
  "../scripts/calibration-cli.js", "../scripts/calibration-selector.js", "../scripts/calibration-adapter-worker.js",
  "../scripts/calibration-trust-provision.js", "../scripts/calibration-evidence-authority.js",
  "../scripts/calibration-trust-preflight.js",
  "../PILOT_0_CALIBRATION_PROTOCOL.spec.json", "../PARAMETER_REGISTRY.spec.json",
  "../schemas/calibration-attestation.schema.json", "../schemas/calibration-execution-manifest.schema.json",
  "../schemas/calibration-metric-artifact.schema.json", "../schemas/calibration-result.schema.json",
  "../schemas/calibration-search-state.schema.json", "../schemas/pilot0-world-configuration.schema.json"
]);

export function calibrationToolingDistributionManifest() {
  const root = resolve(import.meta.dirname, "..");
  const files = new Set(TOOLING_DISTRIBUTION_FILES.map(path => path.replace(/^\.\.\//, "")));
  const walk = path => { for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const name = `${path}/${entry.name}`;
    assert(!entry.isSymbolicLink(), "release distribution contains a symbolic link");
    if (entry.isDirectory()) walk(name); else if (entry.isFile()) files.add(name);
  } };
  for (const path of ["src", "schemas", "config", "ui"]) walk(path);
  for (const path of ["package.json", "package-lock.json", "PRIMARY_ENDPOINT.spec.json", "ENDPOINT_CODEBOOK.spec.md", "validation/PRE_CALIBRATION_BASELINE.json"])
    files.add(path);
  return Object.freeze(Object.fromEntries([...files].sort().map(path => [path,
    createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])));
}

export function resolvedCalibrationBaselineTag() {
  const root = resolve(import.meta.dirname, "..");
  if (existsSync(join(root, ".git"))) {
    const result = spawnSync("git", ["rev-parse", "--verify", `${BASELINE_TAG}^{commit}`], { cwd: root, encoding: "utf8" });
    assert(result.status === 0, "cannot resolve validated baseline tag");
    return result.stdout.trim();
  }
  const receipt = JSON.parse(readFileSync(join(root, "validation/BASELINE_TAG_RESOLUTION.json"), "utf8"));
  assert(receipt.tag === BASELINE_TAG, "packaged baseline tag mismatch");
  return receipt.commit;
}

let cachedToolingDistributionDigest = null;
export function calibrationToolingDistributionDigest({ refresh = false } = {}) {
  if (refresh || cachedToolingDistributionDigest === null)
    cachedToolingDistributionDigest = sha256(calibrationToolingDistributionManifest());
  return cachedToolingDistributionDigest;
}

function releaseDescriptorBody(descriptor) {
  const body = clone(descriptor); delete body.signature; delete body.public_key;
  return body;
}

export function assertCalibrationReleaseTrust(descriptor, pinnedPublicKey, trustPolicy = deploymentTrustPolicy) {
  if (descriptor?.issued_at !== undefined) assertValidSchema(descriptor, "calibration-deployment-release.schema.json");
  assert(descriptor?.public_key && descriptor?.signature && pinnedPublicKey, "externally pinned calibration release trust required");
  const embedded = createPublicKey(descriptor.public_key), pinned = createPublicKey(pinnedPublicKey);
  assert(calibrationKeyId(embedded) === calibrationKeyId(pinned), "calibration release descriptor is not signed by pinned release trust");
  const body = releaseDescriptorBody(descriptor);
  assert(body.version === "phase-a-calibration-release-1.0.0" && body.tooling_version === CALIBRATION_TOOLING_VERSION,
    "calibration release descriptor version mismatch");
  assert(body.tooling_distribution_digest === calibrationToolingDistributionDigest(), "calibration tooling distribution digest mismatch");
  assert(body.baseline_tag === BASELINE_TAG && body.baseline_tag_commit === BASELINE_COMMIT && resolvedCalibrationBaselineTag() === body.baseline_tag_commit,
    "calibration release baseline tag resolution mismatch");
  assert(body.protocol_hash === PROTOCOL_HASH && body.parameter_registry_hash === REGISTRY_HASH,
    "calibration release protocol/registry mismatch");
  assert(body.deployment_trust_policy_hash === sha256(trustPolicy),
    "calibration release deployment trust-policy mismatch");
  assert(HASH.test(body.authorization_key_id), "calibration release authorization trust is not pinned");
  assert(HASH.test(body.approved_adapter_package_digest), "calibration release does not pin an approved adapter package");
  assert(verify(null, Buffer.from(canonicalize(body)), pinned, Buffer.from(descriptor.signature, "base64")),
    "calibration release descriptor signature invalid");
  return Object.freeze({ descriptor_hash: sha256(descriptor), authorization_key_id: body.authorization_key_id,
    tooling_distribution_digest: body.tooling_distribution_digest, baseline_tag_commit: body.baseline_tag_commit,
    deployment_trust_policy_hash: body.deployment_trust_policy_hash,
    release_key_id: calibrationKeyId(embedded), approved_adapter_package_digest: body.approved_adapter_package_digest });
}

export function calibrationDeploymentTrustPolicy() { return clone(deploymentTrustPolicy); }
function assertDeploymentTrustPolicy(policy, releaseKeyId, authorizationKeyId) {
  assert(policy && policy.version === "phase-a-deployment-trust-policy-1.0.0" && policy.status === "PROVISIONED" &&
    canonicalize(Object.keys(policy).sort()) === canonicalize(["approved_authorization_key_ids", "approved_release_key_ids", "status", "version"]) &&
    Array.isArray(policy.approved_release_key_ids) && Array.isArray(policy.approved_authorization_key_ids) &&
    policy.approved_release_key_ids.includes(releaseKeyId) && policy.approved_authorization_key_ids.includes(authorizationKeyId),
  "empirical calibration trust roots are not approved by the immutable deployment trust policy");
  return sha256(policy);
}

function canonicalArchiveDestination(directory) {
  const absolute = resolve(directory), parts = absolute.split("/").filter(Boolean);
  let current = "/", existing = "/";
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) break;
    existing = current;
  }
  const canonicalExisting = realpathSync(existing);
  return join(canonicalExisting, relative(existing, absolute));
}

export function assertSecureCalibrationArchiveDirectory(directory) {
  const canonical = canonicalArchiveDestination(directory);
  assert(existsSync(canonical) && !lstatSync(canonical).isSymbolicLink() && lstatSync(canonical).isDirectory(),
    "calibration archive destination must be a real directory");
  const metadata = statSync(canonical);
  if (typeof process.getuid === "function") assert(metadata.uid === process.getuid(), "calibration archive destination owner mismatch");
  assert((metadata.mode & 0o077) === 0, "calibration archive destination must deny group/world access");
  return realpathSync(canonical);
}

export function assertSecureCalibrationPrivateKeyPath(path, { archiveDirectory, adapterPath }) {
  const lexical = resolve(path), metadata = lstatSync(lexical);
  assert(!metadata.isSymbolicLink() && metadata.isFile() && (metadata.mode & 0o077) === 0,
    "private signing key must be a restrictive regular non-symlink file");
  if (typeof process.getuid === "function") assert(metadata.uid === process.getuid(), "private signing key owner mismatch");
  const actual = realpathSync(lexical), archive = assertSecureCalibrationArchiveDirectory(archiveDirectory), adapterRoot = dirname(realpathSync(resolve(adapterPath)));
  const inside = (parent, child) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  assert(!inside(archive, actual) && !inside(adapterRoot, actual), "private signing key is inside archive or adapter-readable storage");
  return actual;
}

export const CALIBRATION_FAILURES = Object.freeze({
  PARAMETER_FAILURE: "PARAMETER_FAILURE",
  IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT",
  PROTOCOL_VIOLATION: "PROTOCOL_VIOLATION",
  BLINDING_BREACH: "BLINDING_BREACH",
  INFRASTRUCTURE_FAILURE: "INFRASTRUCTURE_FAILURE",
  RESEARCH_DESIGN_BLOCKER: "RESEARCH_DESIGN_BLOCKER",
  ACCEPTED_CONFIGURATION: "ACCEPTED_CONFIGURATION"
});

const failureSet = new Set(Object.values(CALIBRATION_FAILURES));
const forbidden = new Set([...protocol.blinding.forbidden_input_fields, ...protocol.blinding.forbidden_outputs]
  .map(key => key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")));

export class CalibrationBlindingBreach extends CalibrationExecutionError {
  constructor(message) { super("CALIBRATION_BLINDING_BREACH", CALIBRATION_FAILURES.BLINDING_BREACH, message); this.name = "CalibrationBlindingBreach"; }
}

const blindName = value => String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const blindingFailure = message => { throw new CalibrationBlindingBreach(message); };
const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function authorizationBody(capability) {
  const body = clone(capability); delete body.signature; delete body.public_key;
  return body;
}

export function inspectCalibrationRevocationStatus(capability, registry, pinnedAuthorizationTrust, releaseKeyId = null) {
  const authorization = authorizationBody(capability);
  if (authorization.revocation === undefined) return Object.freeze({ required: false, revoked: false });
  assertValidSchema(capability, "calibration-deployment-capability.schema.json");
  assertValidSchema(registry, "calibration-deployment-revocations.schema.json");
  assert(registry?.public_key && registry?.signature && pinnedAuthorizationTrust,
    "signed calibration revocation registry required at dispatch");
  const pinned = pinnedAuthorizationTrust?.type === "public" ? pinnedAuthorizationTrust : createPublicKey(pinnedAuthorizationTrust);
  const embedded = createPublicKey(registry.public_key);
  assert(calibrationKeyId(embedded) === calibrationKeyId(pinned) &&
    registry.authority_key_id === calibrationKeyId(pinned), "calibration revocation registry authority mismatch");
  const body = clone(registry); delete body.public_key; delete body.signature;
  assert(body.version === "phase-a-revocation-registry-1.0.0" &&
    Number.isSafeInteger(body.generation) && body.generation >= 0 &&
    (body.parent_registry_hash === null || HASH.test(body.parent_registry_hash)) && Array.isArray(body.ancestor_registry_hashes) &&
    Array.isArray(body.revoked_key_ids) && Array.isArray(body.revoked_capability_hashes),
  "calibration revocation registry malformed");
  const registryHash = sha256(registry), issuanceHash = authorization.revocation.registry_hash;
  assert(Number.isFinite(Date.parse(body.generated_at)) && Date.parse(body.generated_at) >= Date.parse(authorization.issued_at),
    "calibration revocation registry predates authorization issuance");
  assert((registryHash === issuanceHash && body.generation === 0 ||
    body.generation > 0 && body.ancestor_registry_hashes.includes(issuanceHash)) &&
    authorization.revocation.registry_ref === "calibration-revocations.json" &&
    authorization.revocation.checked_at_dispatch === true,
  "calibration revocation registry binding mismatch");
  assert(body.generation === 0 ? body.parent_registry_hash === null && body.ancestor_registry_hashes.length === 0 :
    HASH.test(body.parent_registry_hash) && body.ancestor_registry_hashes.includes(body.parent_registry_hash),
  "calibration revocation registry lineage malformed");
  assert(verify(null, Buffer.from(canonicalize(body)), pinned, Buffer.from(registry.signature, "base64")),
    "calibration revocation registry signature invalid");
  const revoked = body.revoked_key_ids.includes(authorization.key_id) ||
    (releaseKeyId !== null && body.revoked_key_ids.includes(releaseKeyId)) ||
    body.revoked_capability_hashes.includes(sha256(capability));
  return Object.freeze({ required: true, revoked, registry_hash: registryHash, generation: body.generation,
    parent_registry_hash: body.parent_registry_hash, revoked_key_ids: Object.freeze([...body.revoked_key_ids]),
    revoked_capability_hashes: Object.freeze([...body.revoked_capability_hashes]) });
}

export function assertCalibrationRevocationStatus(capability, registry, pinnedAuthorizationTrust, releaseKeyId = null) {
  const status = inspectCalibrationRevocationStatus(capability, registry, pinnedAuthorizationTrust, releaseKeyId);
  assert(!status.revoked, "calibration authorization or release has been revoked");
  return true;
}

function assertNeutralPolicyManifest(manifest, modelUseDeclared) {
  const keys = ["action_contract_hash", "calibration_objectives_exposed", "context_contract_hash", "model_use_declared", "persistence_history_access", "policy_class", "policy_id", "policy_package_hash", "policy_package_id", "policy_package_version", "treatment_allocation", "treatment_labels_exposed", "treatment_neutral", "version"];
  assert(manifest && canonicalize(Object.keys(manifest).sort()) === canonicalize(keys.sort()),
    `signed treatment-neutral policy manifest is incomplete or contains extras (${Object.keys(manifest ?? {}).sort().join(",")})`);
  assert(manifest.version === "phase-a-neutral-policy-1.0.0" && /^[a-z0-9][a-z0-9._-]+$/.test(manifest.policy_id), "neutral policy identity/version mismatch");
  assert(!/(?:treatment|persistent|nonpersistent|history[_-]?(?:access|enabled|disabled)|condition[_-]?arm)/i.test(manifest.policy_id),
    "neutral policy identity discloses treatment semantics");
  assert(["DETERMINISTIC_TEST_POLICY", "SCRIPTED_HETEROGENEOUS_POLICY", "TREATMENT_NEUTRAL_AGENT"].includes(manifest.policy_class), "calibration policy class is not allow-listed");
  assert(manifest.treatment_neutral === true && manifest.treatment_allocation === "NONE" && manifest.persistence_history_access === "NONE" &&
    manifest.treatment_labels_exposed === false && manifest.calibration_objectives_exposed === false, "calibration policy is treatment or objective contaminated");
  assert(manifest.model_use_declared === modelUseDeclared && manifest.context_contract_hash === PROJECTION_CONTRACT_HASH &&
    manifest.action_contract_hash === ACTION_CONTRACT_HASH, "neutral policy contract/model binding mismatch");
  assert(manifest.policy_id === PHASE_A_POLICY_PACKAGE.package_id && manifest.policy_package_id === PHASE_A_POLICY_PACKAGE.package_id &&
    manifest.policy_package_version === PHASE_A_POLICY_PACKAGE.package_version && manifest.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH,
  "neutral policy manifest is not bound to the frozen Phase A policy package");
  return manifest;
}

export function assertNeutralReplayCondition(condition, policyId) {
  assert(condition?.condition_id === policyId, "calibration replay condition differs from the signed neutral policy");
  assert(condition.memory?.mode === "state_only" && condition.memory?.persistence === "none" &&
    condition.identity?.persistence_treatment_policy === "none" &&
    Array.isArray(condition.declared_treatments) && condition.declared_treatments.length === 0,
  "calibration replay condition exposes persistence treatment or relational history");
  assert(Number.isSafeInteger(condition.retry?.max_attempts) && condition.retry.max_attempts > 0,
    "calibration replay condition lacks deterministic retry bounds");
  return condition;
}

export function assertEmpiricalCapability(capability, {
  archiveDirectory = null, now = Date.now(), authorizationTrust = null, releaseDescriptor = null, releaseTrust = null,
  trustPolicy = deploymentTrustPolicy, revocationRegistry = null
} = {}) {
  assert(capability?.public_key && capability?.signature, "empirical calibration requires a separately signed external authorization capability");
  const publicKey = createPublicKey(capability.public_key), body = authorizationBody(capability);
  const release = assertCalibrationReleaseTrust(releaseDescriptor, releaseTrust, trustPolicy);
  assert(authorizationTrust, "separately pinned empirical authorization trust required");
  const pinnedAuthorization = createPublicKey(authorizationTrust);
  const trustPolicyHash = assertDeploymentTrustPolicy(trustPolicy,
    calibrationKeyId(createPublicKey(releaseDescriptor.public_key)), calibrationKeyId(pinnedAuthorization));
  assert(calibrationKeyId(publicKey) === calibrationKeyId(pinnedAuthorization) && calibrationKeyId(publicKey) === release.authorization_key_id,
    "empirical authorization is not signed by separately pinned deployment authority");
  assert(body.version === "phase-a-empirical-authorization-1.0.0" && body.mode === "EMPIRICAL_CALIBRATION", "empirical authorization mode/version mismatch");
  assert(body.implementation_commit === BASELINE_COMMIT && body.implementation_tag === BASELINE_TAG && body.tooling_version === CALIBRATION_TOOLING_VERSION &&
    body.protocol_hash === PROTOCOL_HASH && body.parameter_registry_hash === REGISTRY_HASH &&
    body.tooling_distribution_digest === release.tooling_distribution_digest && body.release_descriptor_hash === release.descriptor_hash &&
    body.baseline_tag_commit === release.baseline_tag_commit, "empirical authorization baseline/protocol/registry/release mismatch");
  assert(body.deployment_trust_policy_hash === trustPolicyHash, "empirical authorization deployment trust-policy mismatch");
  assert(body.execution_scope === "PHASE_A_WORLD_CALIBRATION" && body.seed_panel_hash === sha256(protocol.seed_panel.seeds) && body.max_turns === 20,
    "empirical authorization scope/seed/horizon mismatch");
  if (body.revocation !== undefined) {
    assert(body.parameter_domain_hash === sha256(protocol.parameter_domains) &&
      canonicalize([...body.prohibited_scopes].sort()) === canonicalize([
        "PILOT_0_RESEARCH", "QWEN_ECOLOGICAL_VALIDATION", "HUMAN_SESSIONS", "PERSISTENCE_TREATMENT_ANALYSIS",
        "CONFIRMATORY_RESEARCH", "ORGANIZATION_MECHANICS", "STATISTICAL_FREEZE_112"].sort()),
    "empirical authorization parameter domain or prohibited scope mismatch");
  }
  assert(body.model_runtime_lock_hash === CALIBRATION_MODEL_RUNTIME_LOCK_HASH, "empirical authorization model-runtime lock mismatch");
  assertNeutralPolicyManifest(body.policy_manifest, body.policy_manifest?.model_use_declared);
  assert(body.policy_manifest_hash === sha256(body.policy_manifest), "empirical authorization policy-manifest hash mismatch");
  assert(Number.isSafeInteger(body.not_before_ms) && Number.isSafeInteger(body.expires_at_ms) && now >= body.not_before_ms && now <= body.expires_at_ms,
    "empirical authorization is outside its validity interval");
  if (archiveDirectory) {
    const requested = assertSecureCalibrationArchiveDirectory(archiveDirectory);
    assert(body.archive_destination_hash === sha256(requested), "empirical authorization archive destination mismatch");
  }
  assert(body.key_id === calibrationKeyId(publicKey), "empirical authorization key binding mismatch");
  assert(typeof body.campaign_id === "string" && body.campaign_id.length > 0 && typeof body.calibration_run_id === "string" && body.calibration_run_id.length > 0 &&
    HASH.test(body.archive_key_id) && HASH.test(body.attestor_key_id), "empirical campaign/run and independent archive/attestor authorities must be pinned");
  assert(HASH.test(body.evidence_key_id) && HASH.test(body.evidence_head_key_id), "external evidence and trusted-head authorities must be pinned");
  assert(new Set([release.release_key_id, body.key_id, body.archive_key_id, body.attestor_key_id, body.evidence_key_id, body.evidence_head_key_id]).size === 6,
    "release, empirical authorization, archive, attestation, evidence, and evidence-head authorities must be pairwise distinct");
  assert(release.approved_adapter_package_digest === sha256(body.adapter_executable),
    "empirical authorization adapter package differs from release-approved digest");
  assert(verify(null, Buffer.from(canonicalize(body)), publicKey, Buffer.from(capability.signature, "base64")), "empirical authorization signature invalid");
  assertCalibrationRevocationStatus(capability, revocationRegistry, pinnedAuthorization, release.release_key_id);
  return release;
}

const loadedExecutionModules = new WeakMap();
function adapterSourceImports(source, sourceName = "adapter source") {
  assert(!/\bimport\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/.test(source), "dynamic adapter imports are forbidden");
  assert(!/\b(?:require|createRequire|compileFunction|runInThisContext|SourceTextModule|SyntheticModule|eval|WebAssembly)\s*\(/.test(source),
    `${sourceName} contains a runtime code-loading bypass`);
  assert(!/\bprocess\s*\[\s*["'](?:getBuiltinModule|binding)["']\s*\]/.test(source),
    `${sourceName} contains a runtime code-loading bypass`);
  assert(!/\bprocess\s*\[|get\s*["'+\s]*BuiltinModule|\bbinding\s*["']?\s*\+/.test(source),
    `${sourceName} contains a computed runtime code-loading bypass`);
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index], next = source[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "/" && next === "/") { index += 2; while (index < source.length && source[index] !== "\n") index++; continue; }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2); assert(end >= 0, "unterminated adapter source comment"); index = end + 2; continue;
    }
    // Imports and loader calls are rejected from the raw source above, including
    // interpolations. Skip template text here so diagnostic prose such as
    // "import.meta" cannot masquerade as executable syntax.
    if (char === "`") {
      index++;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") index += 2; else index++;
      }
      assert(source[index] === "`", `${sourceName} contains an unterminated template literal`); index++; continue;
    }
    if (char === "\"" || char === "'") {
      const quote = char; let value = "", escaped = false; index++;
      while (index < source.length && source[index] !== quote) {
        assert(source[index] !== "\n" && source[index] !== "\r", `${sourceName} contains an unterminated string literal`);
        if (source[index] === "\\") { escaped = true; value += source[index++]; assert(index < source.length, `${sourceName} contains an unterminated escape`); }
        value += source[index++];
      }
      assert(source[index] === quote, `${sourceName} contains an unterminated string literal`); index++;
      tokens.push({ type: "string", value, escaped }); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = char; index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) value += source[index++];
      tokens.push({ type: "identifier", value }); continue;
    }
    tokens.push({ type: "punctuation", value: char }); index++;
  }
  const specifiers = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (token.value !== "import" && token.value !== "export") continue;
    if (token.value === "import") {
      assert(tokens[index + 1]?.value !== "(", "dynamic adapter imports are forbidden");
      if (tokens[index + 1]?.value === ".")
        assert(tokens[index + 2]?.value === "meta" && tokens[index + 3]?.value === "." && ["url", "dirname"].includes(tokens[index + 4]?.value),
          `${sourceName} import.meta use is limited to signed-package resource URLs`);
      if (tokens[index + 1]?.value === ".") continue;
    }
    if (token.value === "export" && ["const", "let", "var", "function", "class", "async", "default"].includes(tokens[index + 1]?.value)) continue;
    let cursor = index + 1, specifier = null, sawFrom = false;
    while (cursor < tokens.length && tokens[cursor].value !== ";") {
      if (tokens[cursor].type === "identifier" && tokens[cursor].value === "from") sawFrom = true;
      if (tokens[cursor].type === "string" && (token.value === "import" && (cursor === index + 1 || sawFrom) || token.value === "export" && sawFrom)) {
        assert(tokens[cursor].escaped !== true, `${sourceName} import specifiers must be unescaped literals`);
        specifier = tokens[cursor].value; break;
      }
      cursor++;
    }
    if (token.value === "import" || sawFrom) assert(specifier !== null, "adapter imports must use the strict static literal grammar");
    if (specifier !== null) specifiers.push(specifier);
  }
  return specifiers;
}

function executableBytes(modulePath, declaration) {
  assert(declaration?.entrypoint === modulePath.split(/[\\/]/).at(-1) && declaration.files &&
    HASH.test(declaration.files[declaration.entrypoint]), "authorized adapter executable manifest required");
  const permissions = declaration.permissions ?? {};
  const permissionKeys = ["child_process", "environment", "fs_read", "fs_write", "network", "worker", "worker_timeout_ms"];
  assert(canonicalize(Object.keys(permissions).sort()) === canonicalize(permissionKeys.sort()) &&
    ["child_process", "worker"].every(key => typeof permissions[key] === "boolean") &&
    Number.isSafeInteger(permissions.worker_timeout_ms) && permissions.worker_timeout_ms > 0 && permissions.worker_timeout_ms <= 300_000 &&
    Array.isArray(permissions.network) && permissions.network.every(endpoint => typeof endpoint === "string" &&
      /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::[0-9]+)?$/i.test(endpoint)) &&
    ["fs_read", "fs_write"].every(key => Array.isArray(permissions[key]) && permissions[key].every(path => typeof path === "string" && isAbsolute(path))) &&
    Array.isArray(permissions.environment) && permissions.environment.every(name => /^[A-Z][A-Z0-9_]+$/.test(name)),
  "adapter executable permissions must be explicit and closed");
  assert(permissions.child_process === false,
    "empirical calibration adapters cannot spawn descendants without a descendant-constraining OS sandbox");
  assert(permissions.fs_read.length === 0 && permissions.fs_write.length === 0,
    "empirical calibration adapters cannot access mutable files outside their signed package");
  const root = dirname(modulePath);
  const actual = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), "adapter executable symlink forbidden");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else { assert(entry.isFile(), "adapter package contains non-file executable input"); actual.push(relative(root, path)); }
    }
  };
  walk(root);
  assert(canonicalize(actual.sort()) === canonicalize(Object.keys(declaration.files).sort()), "adapter executable package inventory mismatch");
  for (const [name, hash] of Object.entries(declaration.files)) {
    const path = resolve(root, name), rel = relative(root, path);
    assert(!isAbsolute(name) && rel !== ".." && !rel.startsWith("../") && name === rel && HASH.test(hash), "invalid adapter executable path");
    for (let parent = path; parent !== root; parent = dirname(parent)) assert(!lstatSync(parent).isSymbolicLink(), "adapter executable symlink forbidden");
    assert(lstatSync(path).isFile() && createHash("sha256").update(readFileSync(path)).digest("hex") === hash, "adapter executable digest mismatch");
    if (/\.(?:[cm]?js|ts)$/.test(name)) {
      const source = readFileSync(path, "utf8");
      const specifiers = adapterSourceImports(source, name);
      for (const specifier of specifiers) {
        if (specifier.startsWith("node:")) {
          assert(!["node:module", "node:vm"].includes(specifier), "adapter can load only its signed static module graph");
          continue;
        }
        assert(specifier.startsWith("./") || specifier.startsWith("../"),
          `${name} bare-package imports are outside the signed executable package: ${specifier}`);
        const imported = resolve(dirname(path), specifier);
        const importedRelative = relative(root, imported);
        assert(importedRelative !== ".." && !importedRelative.startsWith("../") && !isAbsolute(importedRelative),
          "adapter import escapes the signed executable package");
        const candidates = [importedRelative, `${importedRelative}.js`, `${importedRelative}.mjs`, `${importedRelative}.cjs`, join(importedRelative, "index.js")];
        assert(candidates.some(candidate => Object.hasOwn(declaration.files, candidate)), "adapter import is absent from signed executable inventory");
      }
      assert(!/\b(?:process\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\.\s*(?:getBuiltinModule|binding)|\[)|get\s*["'+\s]*BuiltinModule|createRequire|eval\s*\(|new\s+Function\b)/.test(source),
        "adapter source contains a runtime code-loading bypass");
    }
  }
  return sha256(declaration);
}

function signedEvidenceAuthorityConfiguration(modulePath, declaration) {
  const resource = "config/calibration-evidence-authority.json";
  assert(Object.hasOwn(declaration.files, resource), "signed evidence-authority configuration is absent from adapter package");
  const path = resolve(dirname(modulePath), resource);
  const configuration = JSON.parse(readFileSync(path, "utf8"));
  assert(createHash("sha256").update(readFileSync(path)).digest("hex") === declaration.files[resource],
    "signed evidence-authority configuration digest mismatch");
  const validated = validateEvidenceAuthorityConfiguration(configuration);
  if (validated.transport === "HTTPS_PRODUCTION") {
    assert(typeof validated.tls_ca_resource === "string" && Object.hasOwn(declaration.files, validated.tls_ca_resource),
      "signed evidence-authority CA certificate is absent from adapter package");
    const caPath = resolve(dirname(modulePath), validated.tls_ca_resource);
    const caDigest = createHash("sha256").update(readFileSync(caPath)).digest("hex");
    assert(caDigest === validated.tls_ca_sha256 && caDigest === declaration.files[validated.tls_ca_resource],
      "signed evidence-authority CA certificate digest mismatch");
  }
  return validated;
}

function assertNoModelAdapterPermissions(modulePath, declaration, contract = null) {
  const configuration = signedEvidenceAuthorityConfiguration(modulePath, declaration), permissions = declaration.permissions;
  assert(canonicalize(permissions.environment) === canonicalize(["CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN"]),
    "no-model Phase A adapter environment permission must be exactly the evidence authority token");
  assert(canonicalize(permissions.network) === canonicalize([configuration.host]),
    "no-model Phase A adapter network permission must be exactly the signed evidence-authority endpoint");
  assert(permissions.worker_timeout_ms === configuration.worker_timeout_ms,
    "adapter worker deadline differs from signed evidence-authority configuration");
  if (contract) assert(contract.worker_timeout_ms === configuration.worker_timeout_ms &&
    contract.evidence_authority_timeout_ms === configuration.request_timeout_ms,
  "production adapter deadlines differ from signed package configuration");
  return configuration;
}

function adapterWorker(modulePath, declaration, operation, executionRequest = null) {
  const expectedPackageDigest = executableBytes(modulePath, declaration);
  const root = resolve(import.meta.dirname, "..");
  const permissions = declaration.permissions;
  const args = ["--permission", "--disallow-code-generation-from-strings",
    `--allow-fs-read=${resolve(root, "scripts/calibration-adapter-worker.js")}`,
    `--allow-fs-read=${dirname(modulePath)}`, ...permissions.fs_read.map(path => `--allow-fs-read=${path}`),
    ...permissions.fs_write.map(path => `--allow-fs-write=${path}`)];
  if (permissions.network.length) args.push(`--allow-net=${permissions.network.join(",")}`);
  if (permissions.worker) args.push("--allow-worker");
  args.push(resolve(root, "scripts/calibration-adapter-worker.js"));
  const allowedEnvironment = Object.fromEntries(permissions.environment.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const child = spawnSync(process.execPath, args, { cwd: dirname(modulePath), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: permissions.worker_timeout_ms,
    input: canonicalize({ operation, module_path: modulePath, package_hash: expectedPackageDigest,
      package_declaration: declaration, execution_request: executionRequest }),
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_NO_WARNINGS: "1", ...allowedEnvironment } });
  if (child.error?.code === "ETIMEDOUT" || child.signal === "SIGTERM")
    throw infrastructureDeadline("calibration adapter worker deadline exceeded");
  let result;
  try { result = JSON.parse(child.stdout); }
  catch { throw implementationDefect(`isolated calibration adapter emitted invalid protocol output (${sha256(child.stdout ?? "")})`); }
  if (result && canonicalize(Object.keys(result).sort()) === canonicalize(["worker_error"])) {
    const error = result.worker_error;
    const safe = {
      CALIBRATION_INFRASTRUCTURE_DEADLINE: "INFRASTRUCTURE_FAILURE",
      CALIBRATION_INFRASTRUCTURE_AUTHORITY: "INFRASTRUCTURE_FAILURE",
      CALIBRATION_AUTHORITY_AUTHORIZATION: "PROTOCOL_VIOLATION",
      CALIBRATION_AUTHORITY_PROTOCOL: "PROTOCOL_VIOLATION",
      CALIBRATION_IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT",
      CALIBRATION_PROTOCOL_VIOLATION: "PROTOCOL_VIOLATION",
      CALIBRATION_BLINDING_BREACH: "BLINDING_BREACH",
      CALIBRATION_RESEARCH_DESIGN_BLOCKER: "RESEARCH_DESIGN_BLOCKER"
    };
    if (!(error && canonicalize(Object.keys(error).sort()) === canonicalize(["calibration_classification","code","reason","version"]) &&
      error.version === "phase-a-adapter-worker-error-1.0.0" && safe[error.code] === error.calibration_classification && error.reason === error.code))
      throw implementationDefect("isolated calibration adapter emitted invalid safe error metadata");
    throw new CalibrationExecutionError(error.code, error.calibration_classification, `isolated adapter failure: ${error.code}`);
  }
  if (child.status !== 0 || child.stderr) throw implementationDefect(
    `isolated calibration adapter failed (status ${child.status}; diagnostic ${sha256(child.stderr ?? "")})`);
  const workerKeys = operation === "INSPECT"
    ? ["contract", "execute_source_hash", "package_digest", "recover_supported"]
    : ["execute_source_hash", "package_digest", "result"];
  assert(canonicalize(Object.keys(result).sort()) === canonicalize(workerKeys.sort()), "isolated calibration adapter protocol contains unknown fields");
  assert(result.package_digest === expectedPackageDigest && executableBytes(modulePath, declaration) === expectedPackageDigest,
    "authorized adapter package changed across worker operation");
  const serialized = canonicalize(result);
  const encodings = secret => {
    const values = new Set([secret]); let current = secret;
    for (let depth = 0; depth < 3; depth++) { current = Buffer.from(current).toString("base64"); values.add(current); }
    values.add(Buffer.from(secret).toString("hex")); return values;
  };
  for (const secret of Object.values(allowedEnvironment)) if (secret)
    for (const encoded of encodings(secret)) assert(!serialized.includes(encoded), "calibration adapter attempted to emit a credential");
  return result;
}

function assertAdapterExecutionResult(result) {
  assert(result && typeof result === "object" && !Array.isArray(result) &&
    canonicalize(Object.keys(result).sort()) === canonicalize(["adapter_execution_receipt", "archive_export", "bundle", "evidence_head_receipt"]),
  "calibration adapter result schema is not closed");
  assert(result.bundle?.run_id && result.archive_export && result.evidence_head_receipt && result.adapter_execution_receipt,
    "calibration adapter result lacks required evidence/trust artifacts");
  return result;
}

// Authorization is verified before importing any externally supplied executable.
// Its full packaged source inventory and loaded execute export remain pinned.
export async function loadCalibrationExecutionModule(modulePath, capability, options) {
  assertEmpiricalCapability(capability, options);
  const path = realpathSync(resolve(modulePath)), declaration = capability.adapter_executable;
  executableBytes(path, declaration);
  const inspected = adapterWorker(path, declaration, "INSPECT");
  const loadRecord = { path, declaration: clone(declaration), execute: null,
    executeSourceHash: inspected.execute_source_hash, packageDigest: inspected.package_digest,
    lastPackageDigest: null, recoverSupported: inspected.recover_supported };
  const invoke = async (operation, request) => {
    assertEmpiricalCapability(capability, { ...options, now: Date.now() });
    const response = adapterWorker(path, declaration, operation, request);
    try {
      assert(response.execute_source_hash === loadRecord.executeSourceHash, "adapter execute export changed across worker operation");
      assertAdapterExecutionResult(response.result);
      scanForbidden(response.result, "$adapter_result", new Set([capability.policy_manifest.policy_id]));
    } catch (error) {
      if (response.result !== undefined) Object.defineProperty(error, "calibrationRawResult", { value: clone(response.result) });
      throw error;
    }
    loadRecord.lastPackageDigest = response.package_digest;
    return response.result;
  };
  const execute = request => invoke("EXECUTE", request);
  const recover = request => invoke("RECOVER", request);
  loadRecord.execute = execute;
  executableBytes(path, declaration);
  const bound = Object.freeze({ contract: Object.freeze(clone(inspected.contract)), execute,
    ...(inspected.recover_supported ? { recover } : {}) });
  loadedExecutionModules.set(bound, loadRecord);
  assertEmpiricalCalibrationAuthorization(capability, bound, options);
  return bound;
}

export function assertEmpiricalCalibrationAuthorization(capability, adapter, options = {}) {
  const release = assertEmpiricalCapability(capability, options), body = authorizationBody(capability);
  assert(adapter && typeof adapter.execute === "function" && adapter.contract?.version === "phase-a-production-adapter-1.0.0", "authenticated production execution adapter required");
  const loaded = loadedExecutionModules.get(adapter);
  assert(loaded && loaded.execute === adapter.execute && canonicalize(loaded.declaration) === canonicalize(body.adapter_executable), "production adapter executable was not loaded through authorized source verification");
  executableBytes(loaded.path, loaded.declaration);
  if (adapter.contract.model_use_declared === false) {
    const authorityConfiguration = assertNoModelAdapterPermissions(loaded.path, loaded.declaration, adapter.contract);
    if (body.evidence_endpoint !== undefined) assert(body.evidence_endpoint === authorityConfiguration.endpoint,
      "signed capability and adapter evidence endpoints differ");
  }
  assert(adapter.contract.execute_sha256 === loaded.executeSourceHash, "loaded adapter execute export differs from pinned executable identity");
  assert(adapter.contract.mode === "EMPIRICAL_CALIBRATION" && adapter.contract.treatment_neutral === true && typeof adapter.contract.model_use_declared === "boolean" &&
    adapter.contract.seed_panel_hash === sha256(protocol.seed_panel.seeds) && adapter.contract.max_turns === 20 &&
    adapter.contract.model_runtime_lock_hash === CALIBRATION_MODEL_RUNTIME_LOCK_HASH &&
    adapter.contract.execution_recovery === "IDEMPOTENT_RECOVER_BY_EXECUTION_INTENT" && loaded.recoverSupported && typeof adapter.recover === "function",
  "production adapter contract violates calibration policy");
  assert(adapter.contract.policy_package_id === PHASE_A_POLICY_PACKAGE.package_id &&
    adapter.contract.policy_package_version === PHASE_A_POLICY_PACKAGE.package_version &&
    adapter.contract.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH,
  "production adapter is not bound to the frozen policy package");
  assertNeutralPolicyManifest(body.policy_manifest, adapter.contract.model_use_declared);
  assert(adapter.contract.policy_manifest_hash === body.policy_manifest_hash, "production adapter is not bound to the signed neutral policy manifest");
  assert(body.adapter_hash === sha256(adapter.contract), "empirical authorization does not bind production adapter");
  return release;
}

export function assertCalibrationEvidenceTrust(bundle, exported, trust) {
  assert(trust?.trustedHead && trust.runId === bundle.run_id, "external signed archive and exact trusted head required");
  const authenticated = verifyArchiveTrust(exported, trust);
  assert(canonicalize(authenticated.head) === canonicalize(trust.trustedHead), "archive differs from externally trusted final head");
  assert(authenticated.status === "COMPLETE" && canonicalize(exported.object.bundle) === canonicalize(bundle), "authenticated archive does not bind metric evidence");
  return authenticated;
}

function executionEvidenceTrust(bundle, context, authority) {
  assert(authority?.evidencePublicKey && authority?.headPublicKey, "external empirical evidence trust required");
  const receipt = context?.evidence_head_receipt, key = createPublicKey(authority.headPublicKey);
  const body = receipt?.body;
  assert(receipt && canonicalize(Object.keys(receipt).sort()) === canonicalize(["body", "signature"]), "evidence head receipt envelope contains unknown fields");
  assert(body && canonicalize(Object.keys(body).sort()) === canonicalize(["adapter_hash", "evidence_key_id", "head", "mode", "run_id", "version"]),
    "evidence head receipt body contains unknown fields");
  assert(body?.version === "phase-a-evidence-head-1.0.0" && body.mode === "EMPIRICAL_CALIBRATION" && body.run_id === bundle.run_id &&
    body.evidence_key_id === calibrationKeyId(createPublicKey(authority.evidencePublicKey)) && body.adapter_hash === authority.adapterHash,
    "external evidence head receipt binding mismatch");
  assert(verify(null, Buffer.from(canonicalize(body)), key, Buffer.from(receipt.signature, "base64")), "external evidence head receipt signature invalid");
  return { runId: bundle.run_id, publicKey: authority.evidencePublicKey, keyId: body.evidence_key_id, trustedHead: body.head };
}

export function verifyAdapterExecutionReceipt(bundle, context, authority) {
  const receipt = context?.adapter_execution_receipt, body = receipt?.body;
  assert(receipt && canonicalize(Object.keys(receipt).sort()) === canonicalize(["body", "signature"]), "adapter execution receipt envelope contains unknown fields");
  assert(body && canonicalize(Object.keys(body).sort()) === canonicalize(["adapter_executable_hash", "adapter_hash", "adapter_package_digest",
    "evidence_hash", "execution_request_hash", "mode", "parameter_set_hash", "policy_manifest_hash", "run_id", "seed", "version"]),
  "adapter execution receipt body contains unknown fields");
  assert(context?.execution_request && sha256(context.execution_request) === context.execution_request_hash,
    "archived adapter execution request/hash mismatch");
  assert(body?.version === "phase-a-adapter-execution-receipt-1.0.0" && body.mode === "EMPIRICAL_CALIBRATION" &&
    body.run_id === bundle.run_id && body.seed === context.expected_seed && body.parameter_set_hash === context.expected_parameter_set_hash &&
    body.execution_request_hash === context.execution_request_hash && body.policy_manifest_hash === authority.policyManifestHash &&
    body.adapter_hash === authority.adapterHash && body.adapter_executable_hash === authority.executableHash &&
    body.adapter_package_digest === authority.executableHash && context.adapter_package_digest === body.adapter_package_digest &&
    body.evidence_hash === sha256(bundle),
  "adapter execution receipt binding mismatch");
  const key = createPublicKey(authority.headPublicKey);
  assert(verify(null, Buffer.from(canonicalize(body)), key, Buffer.from(receipt.signature ?? "", "base64")), "adapter execution receipt signature invalid");
  return { execution_request_hash: body.execution_request_hash, policy_manifest_hash: body.policy_manifest_hash };
}

function decodedText(value, encoding) {
  try {
    const bytes = Buffer.from(value, encoding);
    if (encoding === "base64" && bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return null;
    if (encoding === "hex" && bytes.toString("hex") !== value.toLowerCase()) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

function scanForbidden(value, path = "$", allowedConditionIds = new Set(), depth = 0) {
  if (Array.isArray(value)) return value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, allowedConditionIds));
  if (typeof value === "string") {
    assert(Buffer.byteLength(value, "utf8") <= 4 * 1024 * 1024, `calibration decision value exceeds bounded inspection size at ${path}`);
    const normalized = blindName(value);
    const compact = normalized.replaceAll("_", "");
    if (/(^|_)(pilot0_history_access|pilot0_history_inaccessible|persistence_treatment|persistent|nonpersistent|persistent_arm|nonpersistent_arm|history_enabled|history_disabled|treatment_arm|primary_endpoint|effect_size|statistical_significance)(_|$)/.test(normalized) ||
      /(pilot0historyaccess|pilot0historyinaccessible|persistencetreatment|persistentarm|nonpersistentarm|historyenabled|historydisabled|treatmentarm|primaryendpoint|effectsize|statisticalsignificance)/.test(compact))
      blindingFailure(`calibration blinding value disclosure at ${path}`);
    const base64Like = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8 && value.length % 4 === 0;
    const hexLike = /^[a-fA-F0-9]+$/.test(value) && value.length >= 8 && value.length % 2 === 0;
    if (depth < 4) {
      if (base64Like) {
        const decoded = decodedText(value, "base64");
        if (decoded !== null && decoded !== value) scanForbidden(decoded, `${path}.decoded_base64`, allowedConditionIds, depth + 1);
      }
      if (hexLike) {
        const decoded = decodedText(value, "hex");
        if (decoded !== null && decoded !== value) scanForbidden(decoded, `${path}.decoded_hex`, allowedConditionIds, depth + 1);
      }
    } else if (base64Like || hexLike) blindingFailure(`encoded calibration value exceeds inspection depth at ${path}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  // Raw canonical replay evidence retains the exact no-treatment condition
  // contract. Only that frozen object is exempt; any altered condition falls
  // through to the fail-closed key/value scan.
  if (canonicalize(value) === canonicalize(PHASE_A_NEUTRAL_CONDITION)) return;
  if (Object.hasOwn(value, "encoding") || Object.hasOwn(value, "data")) {
    assert(["base64", "hex"].includes(value.encoding) && typeof value.data === "string",
      `untyped or unsupported encoded calibration blob at ${path}`);
    const allowedEnvelopeKeys = new Set(["encoding", "data", "byte_length", "raw_sha256"]);
    assert(Object.keys(value).every(key => allowedEnvelopeKeys.has(key)), `encoded calibration envelope contains opaque fields at ${path}`);
  }
  if (value.encoding === "base64" && typeof value.data === "string") {
    let decoded;
    try {
      const bytes = Buffer.from(value.data, "base64");
      assert(bytes.toString("base64").replace(/=+$/, "") === value.data.replace(/=+$/, ""), "invalid base64 evidence envelope");
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof CalibrationBlindingBreach) throw error;
      decoded = null;
    }
    if (decoded !== null) scanForbidden(decoded, `${path}.decoded_base64`, allowedConditionIds, depth + 1);
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = blindName(key);
    const compact = normalized.replaceAll("_", "");
    if (normalized === "condition_id" && typeof child === "string" && allowedConditionIds.has(child)) continue;
    if (forbidden.has(normalized) || /(^|_)(treatment|condition_id|primary_endpoint|effect_size)(_|$)/.test(normalized) ||
      /(treatmentarm|conditionid|primaryendpoint|effectsize|statisticalsignificance)/.test(compact))
      blindingFailure(`calibration blinding violation at ${path}.${key}`);
    scanForbidden(child, `${path}.${key}`, allowedConditionIds, depth);
  }
}

const EXECUTION_CONTEXT_KEYS = Object.freeze(["adapter_execution_receipt", "adapter_package_digest", "archive_export",
  "evidence_head_receipt", "execution_request", "execution_request_hash", "expected_parameter_set_hash", "expected_seed"]);
function assertExecutionContext(context) {
  assert(context && typeof context === "object" && !Array.isArray(context) &&
    canonicalize(Object.keys(context).sort()) === canonicalize([...EXECUTION_CONTEXT_KEYS].sort()),
  "calibration execution context contains unknown or missing fields");
  assert(context.execution_request_hash === sha256(context.execution_request), "calibration execution context request/hash mismatch");
  scanForbidden({ archive_export: context.archive_export, evidence_head_receipt: context.evidence_head_receipt,
    adapter_execution_receipt: context.adapter_execution_receipt }, "$execution_context.adapter_outputs",
  new Set(context.execution_request?.neutralPolicyManifest?.policy_id ? [context.execution_request.neutralPolicyManifest.policy_id] : []));
  return context;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : 0; }
function decimalRatio(value) {
  assert(typeof value === "number" && Number.isFinite(value), "non-finite fixed-point input");
  const text = String(value);
  assert(!/[eE]/.test(text), "exponential numeric form is not permitted for calibrated arithmetic");
  const negative = text.startsWith("-"), unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const denominator = 10n ** BigInt(fraction.length), numerator = BigInt((whole || "0") + fraction) * (negative ? -1n : 1n);
  return { numerator, denominator };
}
function divideRoundHalfEvenBigInt(numerator, denominator) {
  assert(denominator > 0n, "fixed-point denominator must be positive");
  const sign = numerator < 0n ? -1n : 1n, absolute = numerator < 0n ? -numerator : numerator;
  let quotient = absolute / denominator; const remainder = absolute % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n === 1n)) quotient += 1n;
  return quotient * sign;
}
function quantize(value) {
  const scale = BigInt(protocol.metric_numeric_policy.scale), fraction = decimalRatio(value);
  const fixed = divideRoundHalfEvenBigInt(fraction.numerator * scale, fraction.denominator);
  assert(fixed <= BigInt(Number.MAX_SAFE_INTEGER) && fixed >= BigInt(Number.MIN_SAFE_INTEGER), "calibration metric fixed-point overflow");
  return Number(fixed) / Number(scale);
}
function payload(event) { const { payload_ref: ignored, ...body } = event.payload ?? {}; return body; }

/**
 * Produce treatment-blind run observations from verified canonical evidence.
 * This layer deliberately returns no raw event, actor, arm, endpoint, or archive
 * access. Panel aggregation is the only consumer of this projection.
 */
export function collectCalibrationObservations(bundle, { mode = "SYNTHETIC_CONFORMANCE", expectedParameterSet = null, expectedSeed = null, archiveExport = null, archiveTrust = null, codingTrust = null, neutralPolicyId = null, modelUseDeclared = null } = {}) {
  assert(["SYNTHETIC_CONFORMANCE", "EMPIRICAL_CALIBRATION"].includes(mode), "invalid calibration collection mode");
  const store = loadEvidence(bundle);
  const genesis = store.events.find(event => event.event_type === "RunCreated");
  assert(genesis, "calibration evidence lacks RunCreated");
  const genesisPayload = payload(genesis);
  const seed = genesisPayload.seed;
  const runConfig = genesisPayload.configuration_ref ? readEvidencePayload(store, genesisPayload.configuration_ref) : {};
  const executionBinding = genesisPayload.calibration_execution_binding_ref
    ? readEvidencePayload(store, genesisPayload.calibration_execution_binding_ref) : runConfig;
  if (genesisPayload.calibration_execution_binding_ref)
    assert(sha256(executionBinding) === genesisPayload.calibration_execution_binding_hash, "calibration execution binding content mismatch");
  if (genesisPayload.calibration_execution_binding_ref) {
    assertValidSchema(executionBinding, "phase-a-execution-binding.schema.json");
    assert(executionBinding.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH &&
      executionBinding.policy_package_id === PHASE_A_POLICY_PACKAGE.package_id &&
      executionBinding.policy_package_version === PHASE_A_POLICY_PACKAGE.package_version,
    "canonical evidence is not bound to the frozen Phase A policy package");
    assert(executionBinding.assignment_hash === sha256(executionBinding.assignment),
      "canonical policy assignment hash mismatch");
    assert(genesisPayload.calibration_policy_package_hash === executionBinding.policy_package_hash &&
      genesisPayload.calibration_policy_package_version === executionBinding.policy_package_version,
    "RunCreated policy package shortcut differs from content-addressed binding");
  }
  const syntheticConformance = executionBinding.synthetic === true;
  assert(mode === "SYNTHETIC_CONFORMANCE" ? syntheticConformance : executionBinding.synthetic === false && executionBinding.execution_mode === "EMPIRICAL_CALIBRATION",
    "synthetic evidence cannot enter empirical collector; evidence execution mode mismatch");
  // Screening is required in both modes and includes dereferenced payloads,
  // not merely the inline event envelope. Authentication proves what ran; it
  // does not prove that the execution was treatment-neutral.
  // Scan parsed canonical material rather than serialized payload-record bytes:
  // persistent_identity_id is legitimate provenance, while the frozen treatment
  // IDs and treatment/endpoint fields remain prohibited everywhere.
  const policyId = neutralPolicyId ?? executionBinding.calibration_policy_id;
  const invocations = store.events.filter(event => event.event_type === "ModelInvocation");
  if (invocations.length) assert(typeof policyId === "string" && invocations.every(event => payload(event).condition_id === policyId),
    "model invocation condition is not bound to the treatment-neutral calibration policy");
  if (invocations.length) assert(invocations.every(event => Array.isArray(payload(event).memory_refs) && payload(event).memory_refs.length === 0 &&
    Array.isArray(payload(event).context_segments) && payload(event).context_segments.every(segment =>
      segment.class !== "memory_record" && segment.class !== "relational_history" && segment.persistence_history !== true)),
  "treatment-neutral calibration model invocation received persistent relational memory");
  if (modelUseDeclared !== null) assert(modelUseDeclared === (invocations.length > 0),
    "model invocation evidence disagrees with the signed neutral-policy model-use declaration");
  const allowedConditions = new Set(policyId ? [policyId] : []);
  scanForbidden(store.events.map(event => ({ event_type: event.event_type, payload: payload(event), lineage: event.lineage, provenance: event.provenance })), "$", allowedConditions);
  for (const record of store.payloads.values()) scanForbidden(JSON.parse(record.bytes), "$", allowedConditions);
  assert(protocol.seed_panel.seeds.includes(seed), "evidence seed outside frozen calibration panel");
  if (expectedSeed !== null) assert(seed === expectedSeed, "canonical evidence seed differs from requested calibration seed");
  if (expectedParameterSet) {
    const materialized = materializeCalibrationRuntime(expectedParameterSet);
    assert(executionBinding.calibration_parameter_set_hash === materialized.parameter_set_hash, "RunCreated parameter set differs from claimed calibration vector");
    assert(executionBinding.effective_configuration_hash === materialized.effective_configuration_hash &&
      canonicalize(executionBinding.world_configuration ?? runConfig) === canonicalize(materialized.effective_configuration), "RunCreated effective configuration differs from calibration materialization");
    if (mode === "EMPIRICAL_CALIBRATION") assertCalibrationPhaseBudgetEvidence(store, materialized.phase_budget_overrides);
  }
  let replayProof = null;
  if (syntheticConformance) verifyEvidenceIntegrity(bundle);
  else {
    assert(archiveExport && archiveTrust, "external signed archive evidence required before calibration metrics");
    const authenticated = assertCalibrationEvidenceTrust(bundle, archiveExport, archiveTrust);
    const replayed = reconstructRun(bundle, { conditionValidator: condition => assertNeutralReplayCondition(condition, policyId) });
    assert(replayed?.world && replayed.pendingCommit === null, "independent reducer replay failed before metric derivation");
    replayProof = { archive_head: authenticated.head, archive_key_id: archiveTrust.keyId,
      exact_replay_state_hash: replayed.world.stateHash(), resolved_turns: replayed.resolvedTurns };
    if (store.events.some(event => event.event_type === "BehaviorCoded")) {
      assert(codingTrust, "external blinding-review trust required for empirical coded behavior");
      archivedCoding(bundle, codingTrust);
    }
    for (const event of store.events.filter(item => item.event_type === "ModelInvocation")) {
      const manifest = readEvidencePayload(store, payload(event).model_runtime_hash);
      const expected = CALIBRATION_MODEL_RUNTIME_LOCK;
      assert((manifest.repository ?? manifest.model) === expected.repository && manifest.revision === expected.revision &&
        manifest.source === expected.source && manifest.model_kind === expected.model_kind &&
        manifest.tokenizer_repository === expected.tokenizer_repository && manifest.tokenizer_revision === expected.tokenizer_revision &&
        manifest.source_configuration_hash === expected.source_configuration_hash &&
        canonicalize(manifest.source_configuration) === canonicalize(expected.source_configuration) &&
        manifest.model_artifact_hash === expected.model_artifact_hash && manifest.tokenizer_hash === expected.tokenizer_hash &&
        manifest.runtime_hash === expected.runtime_hash && manifest.dtype === expected.dtype && manifest.device === expected.device &&
        manifest.backend === expected.backend && manifest.runner_hash === expected.runner_hash &&
        manifest.source_configuration?.artifact_manifest?.runtime_manifest?.config_sha256 === expected.config_sha256 &&
        manifest.trust_remote_code === expected.trust_remote_code && canonicalize(manifest.adapters) === canonicalize(expected.adapters) &&
        manifest.dynamic_weights === expected.dynamic_weights && manifest.quantization === expected.quantization &&
        manifest.context_budget === expected.context_budget &&
        canonicalize(manifest.sampling ?? manifest.generation) === canonicalize(expected.generation),
      "model invocation differs from the authorization-locked Hugging Face runtime");
    }
  }
  const allSnapshots = store.events.filter(event => event.event_type === "SnapshotCreated");
  const lifecycleSnapshots = allSnapshots.filter(event => payload(event).snapshot_class === "POST_MEMORY_LIFECYCLE");
  const selectedSnapshots = lifecycleSnapshots.length ? lifecycleSnapshots : allSnapshots.filter(event =>
    payload(event).snapshot_class === "WORLD_REDUCER" || payload(event).snapshot_class === undefined);
  const snapshots = selectedSnapshots
    .map(event => ({ event, state: readEvidencePayload(store, payload(event).state_ref) }))
    .sort((a, b) => a.event.turn - b.event.turn);
  assert(snapshots.length > 0 && snapshots.length <= 20, "canonical evidence must contain one to twenty snapshots");
  assert(new Set(snapshots.map(item => item.event.turn)).size === snapshots.length, "duplicate canonical snapshot turn");
  assert(snapshots.every(item => item.event.turn >= 0 && item.event.turn < 20), "calibration evidence exceeds Pilot 0 turn cap");
  assert(store.events.every(event => event.turn >= 0 && event.turn < 20), "canonical activity exists beyond Pilot 0 turn cap");
  const committedTurns = store.events.filter(event => event.event_type === "TurnCommitted").map(event => event.turn);
  const resolvedTurns = store.events.filter(event => event.event_type === "TurnResolved").map(event => event.turn);
  assert(new Set(committedTurns).size === committedTurns.length && new Set(resolvedTurns).size === resolvedTurns.length, "duplicate committed/resolved calibration turn");
  const expectedTurns = Array.from({ length: snapshots.length }, (_, index) => index);
  assert(canonicalize(committedTurns.sort((a, b) => a - b)) === canonicalize(expectedTurns) && canonicalize(resolvedTurns.sort((a, b) => a - b)) === canonicalize(expectedTurns), "calibration turn history is not contiguous committed/resolved execution");
  const dispositions = store.events.filter(event => event.event_type === "RunDisposition");
  const terminalReasons = new Set(["insufficient_surviving_distinct_participants", "all_remaining_permanently_action_incapable"]);
  if (snapshots.length < 20) {
    assert(dispositions.length === 1 && terminalReasons.has(payload(dispositions[0]).replacement_policy?.reason), "incomplete calibration run lacks an approved objective irreversible absorbing-state predicate");
    const finalAlive = Object.values(snapshots.at(-1).state.polities ?? {}).filter(polity => polity.alive !== false);
    if (payload(dispositions[0]).replacement_policy.reason === "insufficient_surviving_distinct_participants")
      assert(finalAlive.length < 2, "terminal predicate proof does not match authoritative final state");
    else assert(finalAlive.every(polity => polity.permanently_action_incapable === true), "terminal incapacity predicate proof does not match authoritative final state");
  }
  if (snapshots.length === 20 && dispositions.length) assert(payload(dispositions[0]).replacement_policy?.reason === "pilot_cap", "20-turn calibration disposition must use the fixed Pilot 0 cap");
  if (dispositions.length) assert(store.events.at(-1).event_id === dispositions.at(-1).event_id, "canonical activity appears after terminal disposition");
  const events = store.events, worldConfiguration = executionBinding.world_configuration ?? runConfig;
  assert(worldConfiguration?.phases && worldConfiguration?.dynamics && worldConfiguration?.unitTypes, "calibration evidence lacks evidence-bound metric parameters");
  const rngProvenanceHash = sha256(events.filter(event => event.event_type === "RNGDraw").map(event => ({ event_id: event.event_id, payload: payload(event), rng: event.rng })));
  const metrics = deriveCalibrationMetricFacts({ store, snapshots, configuration: worldConfiguration, synthetic: syntheticConformance });
  return Object.freeze({
    schema_version: "2.0.0", seed,
    opaque_source_id: sha256({ protocol_hash: PROTOCOL_HASH, run_id: store.runId, evidence_head: events.at(-1)?.integrity?.canonical_bytes_hash }),
    evidence_hash: sha256(bundle), evidence_manifest_hash: sha256(evidenceManifest(store)), rng_provenance_hash: rngProvenanceHash,
    trajectory_hash: sha256(snapshots.map(item => payload(item.event).state_hash)), metrics,
    trust_proof: syntheticConformance ? { mode: "SYNTHETIC_CONFORMANCE", integrity: "VERIFIED" } : {
      mode: "EXTERNAL_SIGNED_ARCHIVE_EXACT_REPLAY", ...replayProof
    }
  });
}

export function assertCalibrationPhaseBudgetEvidence(storeOrBundle, expectedOverrides) {
  const store = storeOrBundle?.run_id ? loadEvidence(storeOrBundle) : storeOrBundle;
  const phaseEvents = store.events.filter(event => event.event_type === "WorldTransition" &&
    ["turn_phase_state", "turn_phase_command"].includes(payload(event).mechanic));
  assert(phaseEvents.length > 0, "empirical evidence lacks canonical phase-budget evidence");
  for (const event of phaseEvents) {
    const manifestRef = (event.provenance?.input_refs ?? []).find(ref => store.payloads.get(ref)?.classification === "phase_budget_manifest");
    assert(manifestRef, "canonical phase transition lacks phase-budget manifest");
    const manifest = readEvidencePayload(store, manifestRef);
    assert(canonicalize(manifest?.value) === canonicalize(expectedOverrides),
      "canonical phase-budget evidence differs from calibrated override vector");
  }
  return true;
}

export function materializeCalibrationMetrics(observations, activeProtocol = protocol) {
  assert(Array.isArray(observations) && observations.length === activeProtocol.seed_panel.seeds.length, "complete frozen seed panel required");
  assert(canonicalize(observations.map(row => row.seed).sort()) === canonicalize([...activeProtocol.seed_panel.seeds].sort()), "each frozen seed must appear exactly once");
  const trajectoryCounts = new Map();
  for (const row of observations) trajectoryCounts.set(row.trajectory_hash, (trajectoryCounts.get(row.trajectory_hash) ?? 0) + 1);
  return observations.map(row => {
    const metrics = clone(row.metrics);
    const trajectory = metricFact({ numerator: 1, denominator: trajectoryCounts.get(row.trajectory_hash), eligibility: observations.length });
    metrics["viability.distinct_state_trajectory_rate"] = { ...trajectory,
      definition_hash: metrics["viability.distinct_state_trajectory_rate"].definition_hash };
    assertMetricArtifact(metrics, activeProtocol);
    return { schema_version: "2.0.0", seed: row.seed, opaque_source_id: row.opaque_source_id,
      evidence_hash: row.evidence_hash, rng_provenance_hash: row.rng_provenance_hash,
      metric_definition_registry_hash: CALIBRATION_METRIC_DEFINITION_HASH, metrics, trust_proof: clone(row.trust_proof) };
  });
}

function opaqueAlias(secret, kind, value) {
  assert((typeof secret === "string" && secret.length >= 32) || Buffer.isBuffer(secret), "selector alias secret required");
  return createHmac("sha256", secret).update(canonicalize({ kind, value })).digest("hex");
}

/** Closed one-way selector DTO. It contains no raw IDs, evidence/RNG hashes,
 * paths, provenance, archive handle, or loader capability. */
export function calibrationSelectionProjection(rows, parameterSetHash, { aliasSecret } = {}) {
  assert(Array.isArray(rows) && rows.length === protocol.seed_panel.seeds.length, "selector requires complete frozen seed panel");
  const allowed = ["schema_version", "seed", "opaque_source_id", "evidence_hash", "rng_provenance_hash", "metric_definition_registry_hash", "metrics", "trust_proof"];
  const candidate_alias = opaqueAlias(aliasSecret, "candidate_candidate", parameterSetHash);
  return rows.map(row => {
    assert(canonicalize(Object.keys(row).sort()) === canonicalize(allowed.sort()), "selector projection contains an unauthorized field");
    assertMetricArtifact(row.metrics, protocol);
    const metrics = Object.fromEntries(Object.entries(row.metrics).map(([id, fact]) => [id, {
      value: fact.value, scaled_value: fact.scaled_value, status: fact.status, numerator: fact.numerator,
      denominator: fact.denominator, eligibility_count: fact.eligibility_count,
      ...(fact.category_counts ? { category_counts: clone(fact.category_counts) } : {})
    }]));
    assertTreatmentBlind(metrics, protocol); scanForbidden(metrics);
    return { opaque_run_alias: opaqueAlias(aliasSecret, "run", row.opaque_source_id),
      opaque_seed_alias: opaqueAlias(aliasSecret, "seed", row.seed), candidate_alias,
      metrics, disposition: "UNEVALUATED", treatment_blinding: protocol.blinding.selection_view };
  });
}

export function runCalibrationSelectorSandbox(scriptPath, input) {
  const root = resolve(import.meta.dirname, "..");
  const entrypoint = realpathSync(resolve(scriptPath));
  const readable = [entrypoint, resolve(root, "src"), resolve(root, "schemas"), resolve(root, "config"),
    resolve(root, "PILOT_0_CALIBRATION_PROTOCOL.spec.json"), resolve(root, "package.json")];
  const privateCwd = mkdtempSync(join(tmpdir(), "civilization-selector-"));
  try {
    return spawnSync(process.execPath, ["--permission", ...readable.map(path => `--allow-fs-read=${path}`), entrypoint], {
      cwd: privateCwd, input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_NO_WARNINGS: "1" }
    });
  } finally {
    rmSync(privateCwd, { recursive: true, force: true });
  }
}

export function aggregateThroughSelectorProcess(view) {
  const script = new URL("../scripts/calibration-selector.js", import.meta.url);
  const child = runCalibrationSelectorSandbox(script.pathname, canonicalize({ rows: view }));
  assert(child.status === 0 && !child.stderr, `isolated calibration selector failed: ${child.stderr || child.status}`);
  try {
    const result = JSON.parse(child.stdout);
    const allowed = ["aggregate_metrics", "aggregate_status", "candidate_alias", "seed_aliases"];
    if (canonicalize(Object.keys(result).sort()) !== canonicalize(allowed.sort())) blindingFailure("selector returned an unauthorized output capability");
    scanForbidden(result);
    return result;
  } catch (error) { if (error instanceof CalibrationBlindingBreach) throw error; throw new Error(`selector returned invalid JSON: ${error.message}`); }
}

export function panelDiagnostics(rows) {
  const scale = 1_000_000n;
  const scaled = fact => fact.status === "ZERO_OPPORTUNITY" ? 0n :
    /^-?\d+$/.test(fact.scaled_value ?? "") ? BigInt(fact.scaled_value) : BigInt(decimalToScaled(fact.value ?? 0));
  let worstPasses = protocol.metrics.length;
  for (const row of rows) {
    let passes = 0;
    for (const metric of protocol.metrics) {
      const value = row.metrics[metric.metric_id].value;
      const valueScaled = value === null ? null : BigInt(decimalToScaled(value));
      if (valueScaled !== null && (metric.acceptance.minimum === undefined || valueScaled >= BigInt(decimalToScaled(metric.acceptance.minimum))) &&
        (metric.acceptance.maximum === undefined || valueScaled <= BigInt(decimalToScaled(metric.acceptance.maximum)))) passes++;
    }
    worstPasses = Math.min(worstPasses, passes);
  }
  let varianceNumerator = 0n;
  const n = BigInt(rows.length);
  for (const metric of protocol.metrics) {
    const minimum = metric.acceptance.minimum, maximum = metric.acceptance.maximum;
    const width = minimum !== undefined && maximum !== undefined
      ? decimalToScaled(maximum) - decimalToScaled(minimum)
      : decimalToScaled(Math.max(Math.abs(minimum ?? maximum ?? 1), 1));
    assert(width > 0n, `metric variance normalization scale is invalid: ${metric.metric_id}`);
    const values = rows.map(row => divideRoundHalfEvenBigInt(scaled(row.metrics[metric.metric_id]) * scale, width));
    const total = values.reduce((a, b) => a + b, 0n), squares = values.reduce((a, b) => a + b * b, 0n);
    varianceNumerator += squares * n - total * total;
  }
  const varianceDenominator = BigInt(protocol.metrics.length) * n * n * scale * scale;
  return { worst_seed_metric_pass_fraction: fixedRatio(worstPasses, protocol.metrics.length),
    cross_seed_metric_variance: fixedRatio(varianceNumerator, varianceDenominator) };
}

function attestationPayload(attempt) {
  const subject = clone(attempt); delete subject.attestation;
  return { version: ATTESTATION_VERSION,
    declaration: "TREATMENT_FIELDS_REMOVED_NO_ARM_COMPARISONS_COMPUTED_SELECTOR_HAS_NO_RAW_EVIDENCE_ACCESS",
    subject_hash: sha256(subject), protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH };
}

function assertAttestationSubject(attempt) {
  assert(attempt.tooling_version === CALIBRATION_TOOLING_VERSION && attempt.implementation_commit === BASELINE_COMMIT && attempt.implementation_tag === BASELINE_TAG, "calibration attestation baseline mismatch");
  assert(attempt.tooling_distribution_digest === calibrationToolingDistributionDigest() && attempt.baseline_tag_commit === BASELINE_COMMIT,
    "calibration attestation tooling distribution or baseline-tag binding mismatch");
  assert(attempt.protocol_version === protocol.protocol_version && attempt.parameter_registry_version === parameterRegistry().registry_version, "calibration attestation protocol/registry mismatch");
  assert((attempt.protocol_hash ?? PROTOCOL_HASH) === PROTOCOL_HASH && (attempt.parameter_registry_hash ?? REGISTRY_HASH) === REGISTRY_HASH, "calibration attestation protocol/registry content mismatch");
  assert(canonicalize(attempt.specification_versions) === canonicalize(baseline.specification_sha256), "calibration attestation specification baseline mismatch");
  assert(attempt.parameter_set_hash === sha256(attempt.parameter_set), "calibration attestation parameter hash mismatch");
  validateCalibrationParameterSet(attempt.parameter_set);
  const classifications = Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, entry.classification]));
  assert(canonicalize(attempt.parameter_classifications) === canonicalize(classifications), "calibration attestation parameter classification mismatch");
  assert(attempt.stopping_rule_hash === sha256(protocol.stopping_rule) && attempt.treatment_blinding === protocol.blinding.selection_view, "calibration attestation stopping/blinding mismatch");
  assert(failureSet.has(attempt.failure_classification) && Array.isArray(attempt.seeds) && new Set(attempt.seeds).size === attempt.seeds.length && attempt.seeds.every(seed => protocol.seed_panel.seeds.includes(seed)), "calibration attestation seed/status mismatch");
  if (attempt.attestation_scope === "COMPLETE_PARAMETER_VECTOR") assert(canonicalize([...attempt.seeds].sort()) === canonicalize([...protocol.seed_panel.seeds].sort()), "complete candidate attestation lacks frozen seed panel");
  assert(Array.isArray(attempt.evidence_hashes) && attempt.evidence_hashes.length === attempt.seeds.length && attempt.evidence_hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)), "calibration attestation evidence binding mismatch");
  return true;
}

export function attestCalibrationAttempt(attempt, { privateKey, keyId }) {
  assert(privateKey, "independent calibration attestor required");
  const derived = calibrationKeyId(createPublicKey(privateKey));
  if (keyId !== undefined) assert(keyId === derived, "attestor key id must derive from public key");
  assertAttestationSubject(attempt);
  const body = attestationPayload(attempt);
  return { schema_version: "1.0.0", attestation_version: ATTESTATION_VERSION, key_id: derived,
    payload_hash: sha256(body), signature: sign(null, Buffer.from(canonicalize(body)), privateKey).toString("base64") };
}

export function verifyCalibrationAttestation(attempt, attestation, trustedKeys) {
  assertAttestationSubject(attempt);
  const body = attestationPayload(attempt), key = trustedKeys?.[attestation?.key_id];
  assert(attestation?.attestation_version === ATTESTATION_VERSION && key, "untrusted calibration attestation");
  assert(attestation.payload_hash === sha256(body) && verify(null, Buffer.from(canonicalize(body)), key, Buffer.from(attestation.signature, "base64")), "calibration attestation invalid");
  return true;
}

function attestArtifact(value, artifactType, trust) {
  trust = attestationAuthority(trust);
  const subject = clone(value); delete subject.artifact_attestation;
  const body = { version: ATTESTATION_VERSION, artifact_type: artifactType, subject_hash: sha256(subject), protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH };
  return { key_id: trust.keyId, body, signature: sign(null, Buffer.from(canonicalize(body)), trust.privateKey).toString("base64") };
}
function verifyArtifact(value, artifactType, trust) {
  trust = attestationAuthority(trust);
  const attestation = value.artifact_attestation, subject = clone(value); delete subject.artifact_attestation;
  const expected = { version: ATTESTATION_VERSION, artifact_type: artifactType, subject_hash: sha256(subject), protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH };
  assert(attestation?.key_id === trust.keyId && canonicalize(attestation.body) === canonicalize(expected) &&
    verify(null, Buffer.from(canonicalize(expected)), trust.publicKey, Buffer.from(attestation.signature, "base64")), `signed ${artifactType} attestation invalid`);
  return true;
}

async function immutable(path, value) {
  const bytes = canonicalize(value) + "\n";
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert(await readFile(path, "utf8") === bytes, "immutable calibration artifact already exists with different content");
  } finally { await unlink(temporary); }
  const directory = await open(resolve(path, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return sha256(bytes);
}

async function atomicPointer(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(canonicalize(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(resolve(path, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

const conformancePair = generateKeyPairSync("ed25519");
const CONFORMANCE_TRUST = Object.freeze({ privateKey: conformancePair.privateKey, publicKey: conformancePair.publicKey, trustScope: "SYNTHETIC_CONFORMANCE" });
export function calibrationKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  assert(key.asymmetricKeyType === "ed25519", "calibration archive requires Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function normalizeTrust(trust = CONFORMANCE_TRUST) {
  assert(trust?.publicKey, "external calibration archive trust required");
  const publicKey = trust.publicKey?.type === "public" ? trust.publicKey : createPublicKey(trust.publicKey);
  const keyId = calibrationKeyId(publicKey);
  if (trust.keyId !== undefined) assert(trust.keyId === keyId, "calibration archive key identifier must derive from public key");
  return { ...trust, publicKey, keyId };
}

function attestationAuthority(trust) { return trust.attestationAuthority ?? trust; }

function assertRetainedHistory(prior, next) {
  if (!prior) return;
  for (const key of ["calibration_run_id", "protocol_version", "protocol_hash", "parameter_registry_hash", "implementation_commit",
    "implementation_tag", "tooling_distribution_digest", "baseline_tag_commit", "release_descriptor_hash", "authorization_hash",
    "authorization_key_id", "campaign_id", "attestor_key_id", "execution_mode"])
    assert(canonicalize(next[key]) === canonicalize(prior[key]), `calibration state invariant changed: ${key}`);
  const retained = (field, identity) => {
    const current = new Map((next[field] ?? []).map(item => [identity(item), item]));
    for (const item of prior[field] ?? []) assert(current.has(identity(item)) && canonicalize(current.get(identity(item))) === canonicalize(item),
      `signed calibration history deleted or mutated retained ${field}`);
  };
  retained("executions", item => item.key);
  retained("quarantined_results", item => item.key);
  retained("attempts", item => item.attempt_id);
  retained("assessments", item => item.parameter_set_hash);
  retained("candidates", item => item.parameter_set_hash);
  retained("incidents", item => sha256(item));
  for (const field of ["completed_keys", "visited_parameter_set_hashes"])
    assert((prior[field] ?? []).every(item => (next[field] ?? []).includes(item)), `signed calibration history deleted retained ${field}`);
  const intents = new Map((next.execution_intents ?? []).map(item => [item.key, item]));
  for (const item of prior.execution_intents ?? []) {
    const current = intents.get(item.key);
    assert(current && current.attempt_id === item.attempt_id && current.request_hash === item.request_hash &&
      canonicalize(current.request) === canonicalize(item.request) &&
      (current.status === item.status || (item.status === "DISPATCH_PENDING" && current.status === "EVIDENCE_PERSISTED")),
    "signed calibration history deleted or mutated retained execution intent");
  }
  assert(prior.result_ref === null || next.result_ref === prior.result_ref, "signed calibration history removed or changed result reference");
}

export class CalibrationArchive {
  constructor(directory, trust = CONFORMANCE_TRUST) {
    this.trust = normalizeTrust(trust);
    this.directory = this.trust.trustScope === "EMPIRICAL_ARCHIVE" ? canonicalArchiveDestination(directory) : resolve(directory);
    this.state = null; this.head = null;
    this.distributionDigest = calibrationToolingDistributionDigest();
  }
  async _initializeDirectories() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.trust.trustScope === "EMPIRICAL_ARCHIVE") {
      const info = await lstat(this.directory);
      assert(!info.isSymbolicLink() && info.isDirectory() && (info.mode & 0o077) === 0 &&
        (typeof process.getuid !== "function" || info.uid === process.getuid()) && realpathSync(this.directory) === this.directory,
      "empirical archive root must be a secure caller-owned canonical directory");
    }
    for (const name of ["generations", "transactions", "evidence", "quarantine", "attempts", "candidates"]) await mkdir(join(this.directory, name), { recursive: true, mode: 0o700 });
  }
  async _exclusive(work) {
    await this._initializeDirectories();
    const database = new DatabaseSync(join(this.directory, "calibration-publication-lock.sqlite"));
    try {
      database.exec("PRAGMA busy_timeout=0");
      try { database.exec("BEGIN IMMEDIATE"); }
      catch (error) { if (/locked|busy/i.test(error.message)) throw new Error("calibration publication already claimed by another writer"); throw error; }
      try { return await work(); } finally { database.exec("ROLLBACK"); }
    } finally { database.close(); }
  }
  _seal(body) {
    assert(this.trust.privateKey, "calibration state signing authority required");
    return { body, signature: sign(null, Buffer.from(canonicalize(body)), this.trust.privateKey).toString("base64") };
  }
  _verifyEnvelope(envelope) {
    assert(envelope?.body?.key_id === this.trust.keyId && typeof envelope.signature === "string", "calibration state trust binding mismatch");
    assert(verify(null, Buffer.from(canonicalize(envelope.body)), this.trust.publicKey, Buffer.from(envelope.signature, "base64")), "calibration state signature invalid");
    return envelope.body;
  }
  _generationPath(generation) { return join(this.directory, "generations", String(generation).padStart(12, "0") + ".json"); }
  async _history() {
    const names = (await readdir(join(this.directory, "generations"))).filter(name => /^\d{12}\.json$/.test(name)).sort();
    const history = [];
    const currentDistribution = this.distributionDigest;
    for (const [index, name] of names.entries()) {
      assert(name === String(index).padStart(12, "0") + ".json", "calibration state generation gap or fork");
      const bytes = await readFile(this._generationPath(index), "utf8"), envelope = JSON.parse(bytes);
      assert(canonicalize(envelope) + "\n" === bytes, "noncanonical calibration state generation");
      const body = this._verifyEnvelope(envelope);
      const prior = history.at(-1);
      assert(body.generation === index && body.parent_generation_digest === (prior?.digest ?? null), "calibration state parent substitution");
      assert(body.version === STATE_VERSION && body.protocol_hash === PROTOCOL_HASH && body.parameter_registry_hash === REGISTRY_HASH, "calibration state protocol/registry content mismatch");
      assert(body.tooling_distribution_digest === currentDistribution && body.baseline_tag_commit === BASELINE_COMMIT,
        "calibration state tooling distribution or baseline-tag binding mismatch");
      if (this.trust.releaseBinding?.descriptor_hash)
        assert(body.release_descriptor_hash === this.trust.releaseBinding.descriptor_hash, "calibration state release descriptor mismatch");
      const binding = this.trust.executionBinding;
      if (binding) assert(body.authorization_hash === binding.authorization_hash && body.authorization_key_id === binding.authorization_key_id &&
        body.campaign_id === binding.campaign_id && body.calibration_run_id === binding.calibration_run_id && body.attestor_key_id === binding.attestor_key_id,
      "calibration state empirical authorization/campaign binding mismatch");
      assertRetainedHistory(prior?.body, body);
      assertValidSchema(body, "calibration-search-state.schema.json");
      history.push({ body, digest: sha256(envelope) });
    }
    if (this.trust.trustedHead) {
      const anchored = history[this.trust.trustedHead.generation];
      assert(anchored?.digest === this.trust.trustedHead.digest, "calibration archive rollback or trusted-head substitution");
      if (this.trust.exactTrustedHead) assert(history.at(-1)?.digest === this.trust.trustedHead.digest &&
        history.at(-1)?.body.generation === this.trust.trustedHead.generation, "calibration archive extends beyond externally retained final head");
    }
    return history;
  }
  async _loadLocked({ skipOrphans = false } = {}) {
    await this._recoverTransaction();
    const history = await this._history();
    assert(history.length, "calibration archive has no state generation");
    const latest = history.at(-1);
    const pointer = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"));
    assert(pointer.generation === latest.body.generation && pointer.digest === latest.digest && pointer.key_id === this.trust.keyId, "calibration state pointer mismatch or rollback");
    this.state = clone(latest.body); this.head = { generation: latest.body.generation, digest: latest.digest };
    if (!skipOrphans) await this._assertNoOrphans();
    return this;
  }
  async _assertNoOrphans() {
    const files = async (root, prefix) => {
      const found = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink(), "calibration archive contains a symbolic link");
        const path = join(root, entry.name), relativePath = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) found.push(...await files(path, relativePath));
        else { assert(entry.isFile(), "calibration archive contains a non-file artifact"); found.push(relativePath); }
      }
      return found.sort();
    };
    const indexedEvidence = new Set(this.state.executions.map(item => item.path));
    const actualEvidence = (await readdir(join(this.directory, "evidence"))).filter(name => name.endsWith(".json")).map(name => `evidence/${name}`);
    assert(actualEvidence.every(path => indexedEvidence.has(path)) && [...indexedEvidence].every(path => actualEvidence.includes(path)),
      "orphan calibration evidence or missing retained evidence detected; recovery fails closed");
    const indexedQuarantine = new Set((this.state.quarantined_results ?? []).map(item => item.path));
    const actualQuarantine = (await readdir(join(this.directory, "quarantine"))).filter(name => name.endsWith(".json")).map(name => `quarantine/${name}`);
    assert(actualQuarantine.every(path => indexedQuarantine.has(path)) && [...indexedQuarantine].every(path => actualQuarantine.includes(path)),
      "orphan or missing quarantined adapter result detected; recovery fails closed");
    const intentKeys = new Set(this.state.execution_intents.map(item => item.key));
    assert(intentKeys.size === this.state.execution_intents.length && this.state.execution_intents.every(item =>
      item.request_hash === sha256(item.request) && (item.status === "DISPATCH_PENDING" ||
        (item.status === "EVIDENCE_PERSISTED" && this.state.executions.some(execution => execution.key === item.key)))),
    "calibration execution intent lineage is inconsistent");
    assert(this.state.executions.every(execution => this.state.execution_intents.some(intent => intent.key === execution.key && intent.status === "EVIDENCE_PERSISTED")),
      "calibration evidence lacks its execution intent");
    const indexedAttempts = new Set(this.state.attempts.map(item => item.attempt_id));
    const actualAttempts = (await readdir(join(this.directory, "attempts"), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
    assert(actualAttempts.every(id => indexedAttempts.has(id)) && [...indexedAttempts].every(id => actualAttempts.includes(id)),
      "orphan calibration attempt or missing retained attempt detected; recovery fails closed");
    const completed = new Set(this.state.completed_keys);
    assert(this.state.attempts.every(item => completed.has(item.key)) && this.state.completed_keys.every(key => this.state.attempts.some(item => item.key === key)),
      "completed-key index differs from retained calibration attempts");
    const breachAttempts = this.state.attempts.filter(item => item.status === CALIBRATION_FAILURES.BLINDING_BREACH);
    assert(breachAttempts.every(item => this.state.incidents.some(incident => incident.affected_decision === item.attempt_id)) &&
      (!breachAttempts.length || this.state.status === "FAILED"), "blinding breach lacks its atomic protocol incident/failure disposition");
    for (const attempt of this.state.attempts) {
      const manifestPath = join(this.directory, "attempts", attempt.attempt_id, "manifest.json");
      assert((await lstat(manifestPath)).isFile(), "retained calibration attempt manifest is missing");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      for (const path of [manifest.evidence_artifact, manifest.metric_artifact])
        assert(typeof path === "string" && (await lstat(join(this.directory, path))).isFile(), "retained calibration attempt artifact is missing");
    }
    const expectedAttemptFiles = this.state.attempts.flatMap(item => [
      `attempts/${item.attempt_id}/canonical-evidence.json`, `attempts/${item.attempt_id}/metrics.json`, `attempts/${item.attempt_id}/manifest.json`
    ]).sort();
    assert(canonicalize(await files(join(this.directory, "attempts"), "attempts")) === canonicalize(expectedAttemptFiles),
      "orphan or missing file inside calibration attempt archive");
    const indexedCandidates = new Set(this.state.candidates.map(item => item.path));
    const actualCandidates = (await readdir(join(this.directory, "candidates"))).filter(name => name.endsWith(".json")).map(name => `candidates/${name}`);
    assert(actualCandidates.every(path => indexedCandidates.has(path)) && [...indexedCandidates].every(path => actualCandidates.includes(path)),
      "orphan calibration candidate or missing retained candidate detected; recovery fails closed");
    assert(!existsSync(join(this.directory, "results")), "unsigned calibration results directory is forbidden");
    const resultExists = existsSync(join(this.directory, "CALIBRATION_RESULT.json"));
    const worldExists = existsSync(join(this.directory, "PILOT_0_WORLD_CONFIGURATION.json"));
    if (this.state.status === "COMPLETE" || this.state.result_ref !== null)
      assert(this.state.status === "COMPLETE" && this.state.result_ref === "CALIBRATION_RESULT.json" && resultExists && worldExists,
        "complete calibration archive lacks its exact signed result pair");
    else assert(!resultExists && !worldExists, "orphan calibration result/world-configuration output detected");
  }
  async _recoverTransaction() {
    const names = (await readdir(join(this.directory, "transactions"))).filter(name => /^\d{12}\.json$/.test(name)).sort();
    if (!names.length) return;
    const transaction = JSON.parse(await readFile(join(this.directory, "transactions", names.at(-1)), "utf8"));
    const body = this._verifyEnvelope(transaction), next = this._verifyEnvelope(body.generation_envelope);
    assert(body.kind === "CALIBRATION_PUBLICATION" && next.generation === Number(names.at(-1).slice(0, 12)), "invalid calibration publication journal");
    assert(next.tooling_distribution_digest === this.distributionDigest, "publication tooling distribution mismatch");
    const generations = (await readdir(join(this.directory, "generations"))).filter(name => /^\d{12}\.json$/.test(name)).sort();
    assert(generations.length === next.generation || generations.length === next.generation + 1, "publication journal generation gap/rollback");
    if (next.generation > 0) {
      const prior = JSON.parse(await readFile(this._generationPath(next.generation - 1), "utf8")); this._verifyEnvelope(prior);
      assert(next.parent_generation_digest === sha256(prior), "publication journal parent mismatch");
    }
    const pointerPath = join(this.directory, "state.json");
    let pointer = null;
    try { pointer = JSON.parse(await readFile(pointerPath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const digest = sha256(body.generation_envelope);
    if (pointer?.generation === next.generation && pointer.digest === digest) return;
    assert(pointer === null || (pointer.generation === next.generation - 1 && pointer.digest === next.parent_generation_digest), "calibration state pointer mismatch or rollback");
    for (const artifact of body.artifacts) {
      assert(/^(evidence\/[^/]+\.json|quarantine\/[^/]+\.json|attempts\/[^/]+\/(canonical-evidence|metrics|manifest)\.json|candidates\/[^/]+\.json|CALIBRATION_RESULT\.json|PILOT_0_WORLD_CONFIGURATION\.json)$/.test(artifact.path) && !artifact.path.includes(".."), "unsafe calibration publication path");
      await immutable(join(this.directory, artifact.path), artifact.value);
    }
    await immutable(this._generationPath(next.generation), body.generation_envelope);
    await atomicPointer(pointerPath, { generation: next.generation, digest, key_id: this.trust.keyId });
  }
  async _publish(next, expectedHead, artifacts = []) {
    assert((this.head?.digest ?? null) === expectedHead, "stale calibration archive head");
    next.generation = (this.head?.generation ?? -1) + 1;
    next.parent_generation_digest = this.head?.digest ?? null;
    next.key_id = this.trust.keyId; next.protocol_hash = PROTOCOL_HASH; next.parameter_registry_hash = REGISTRY_HASH;
    next.tooling_distribution_digest = this.distributionDigest;
    next.baseline_tag_commit = BASELINE_COMMIT;
    next.release_descriptor_hash = this.trust.releaseBinding?.descriptor_hash ?? null;
    next.authorization_hash = this.trust.executionBinding?.authorization_hash ?? null;
    next.authorization_key_id = this.trust.executionBinding?.authorization_key_id ?? null;
    next.campaign_id = this.trust.executionBinding?.campaign_id ?? null;
    if (this.trust.executionBinding?.calibration_run_id) next.calibration_run_id = this.trust.executionBinding.calibration_run_id;
    next.attestor_key_id = attestationAuthority(this.trust).keyId;
    assertValidSchema(next, "calibration-search-state.schema.json");
    const envelope = this._seal(next), digest = sha256(envelope);
    const fault = this.trust.fault ?? (() => {});
    const context = { generation: next.generation, artifact_paths: artifacts.map(item => item.path) };
    await fault("before_journal", context);
    await immutable(join(this.directory, "transactions", String(next.generation).padStart(12, "0") + ".json"),
      this._seal({ kind: "CALIBRATION_PUBLICATION", key_id: this.trust.keyId, generation_envelope: envelope, artifacts }));
    await fault("after_journal", context);
    for (const artifact of artifacts) { await immutable(join(this.directory, artifact.path), artifact.value); await fault("after_artifact", { ...context, path: artifact.path }); }
    await fault("before_generation", context);
    await immutable(this._generationPath(next.generation), envelope);
    await fault("after_generation", context);
    await fault("before_pointer", context);
    await atomicPointer(join(this.directory, "state.json"), { generation: next.generation, digest, key_id: this.trust.keyId });
    await fault("after_pointer", context);
    this.state = clone(next); this.head = { generation: next.generation, digest };
    return clone(next);
  }
  async initialize({ protocolVersion, implementationCommit, executionMode = "SYNTHETIC_CONFORMANCE" }) {
    assert(["SYNTHETIC_CONFORMANCE", "EMPIRICAL_CALIBRATION"].includes(executionMode), "invalid archive execution mode");
    assert(protocolVersion === protocol.protocol_version, "calibration protocol version mismatch");
    assert(implementationCommit === BASELINE_COMMIT, "implementation baseline mismatch");
    return this._exclusive(async () => {
      await this._initializeDirectories();
      try { await stat(join(this.directory, "state.json")); return this._loadLocked(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      this.state = { version: STATE_VERSION, generation: -1, parent_generation_digest: null, key_id: this.trust.keyId,
        calibration_run_id: this.trust.executionBinding?.calibration_run_id ?? `calibration-${randomUUID()}`, protocol_version: protocolVersion, protocol_hash: PROTOCOL_HASH,
        parameter_registry_hash: REGISTRY_HASH, implementation_commit: implementationCommit, implementation_tag: BASELINE_TAG,
        tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT,
        release_descriptor_hash: this.trust.releaseBinding?.descriptor_hash ?? null,
        authorization_hash: this.trust.executionBinding?.authorization_hash ?? null,
        authorization_key_id: this.trust.executionBinding?.authorization_key_id ?? null,
        campaign_id: this.trust.executionBinding?.campaign_id ?? null,
        attestor_key_id: attestationAuthority(this.trust).keyId,
        status: "READY", execution_mode: executionMode, round_improved: false, current_round: 0, incumbent_parameter_set_hash: null,
        search_cursor: { round: 0, operation_index: 0, candidate_index: 0 }, visited_parameter_set_hashes: [], assessments: [],
        execution_intents: [], executions: [], quarantined_results: [], attempts: [], candidates: [], completed_keys: [], incidents: [], result_ref: null };
      this.head = null;
      return this._publish(this.state, null).then(() => this);
    });
  }
  static async open(directory, trust = CONFORMANCE_TRUST) {
    const archive = new CalibrationArchive(directory, trust);
    await stat(join(archive.directory, "generations"));
    return archive._exclusive(() => archive._loadLocked());
  }
  async update(mutator, { expectedHead = this.head?.digest ?? null } = {}) {
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true });
      assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      const next = clone(await mutator(clone(this.state)) ?? this.state);
      assert(next.version === STATE_VERSION && next.protocol_version === protocol.protocol_version && next.implementation_commit === BASELINE_COMMIT, "calibration state invariant mutation");
      return this._publish(next, expectedHead);
    });
  }
  async recordIncident({ disclosure, affectedDecision }) {
    const expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true });
      assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      const incident = calibrationProtocolIncident({ disclosure, affectedDecision,
        detectedAt: new Date(0).toISOString(), authority: this.trust.keyId });
      const next = clone(this.state); next.incidents.push(incident); next.status = "FAILED";
      await this._publish(next, expectedHead); return incident;
    });
  }
  async recordExecutionIntent({ attemptId, parameterSetHash, seed, request }) {
    const key = `${parameterSetHash}:${seed}`, requestHash = sha256(request), expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true });
      assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE" && this.state.status !== "FAILED", "terminal calibration archive cannot dispatch execution");
      const existing = this.state.execution_intents.find(item => item.key === key);
      if (existing) {
        assert(existing.attempt_id === attemptId && existing.request_hash === requestHash && canonicalize(existing.request) === canonicalize(request),
          "calibration execution intent mutation or idempotency-key collision");
        return clone(existing);
      }
      const intent = { key, attempt_id: attemptId, request: clone(request), request_hash: requestHash, status: "DISPATCH_PENDING" };
      const next = clone(this.state); next.execution_intents.push(intent);
      await this._publish(next, expectedHead); return clone(intent);
    });
  }
  async recordEvidence({ attemptId, parameterSetHash, seed, bundle, executionContext = null }) {
    const expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true });
      assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      assertExecutionContext(executionContext);
      const key = `${parameterSetHash}:${seed}`, existing = this.state.executions.find(item => item.key === key);
      if (existing) {
        const saved = JSON.parse(await readFile(join(this.directory, existing.path), "utf8"));
        assert(sha256(saved) === existing.record_hash && sha256(saved.bundle) === existing.evidence_hash, "checkpointed calibration evidence is corrupt"); return saved.bundle;
      }
      if (executionContext !== null) {
        const expectedKeys = ["adapter_execution_receipt", "adapter_package_digest", "archive_export", "evidence_head_receipt",
          "execution_request", "execution_request_hash", "expected_parameter_set_hash", "expected_seed"];
        assert(canonicalize(Object.keys(executionContext).sort()) === canonicalize(expectedKeys.sort()),
          "calibration execution context contains an unregistered field");
        scanForbidden(executionContext, "$execution_context", new Set(this.trust.evidenceAuthority?.policyId ? [this.trust.evidenceAuthority.policyId] : []));
      }
      const store = loadEvidence(bundle);
      let intent = this.state.execution_intents.find(item => item.key === key);
      if (!intent) {
        assert(executionContext?.execution_request && executionContext.execution_request_hash === sha256(executionContext.execution_request),
          "canonical evidence lacks its execution request lineage");
        intent = { key, attempt_id: attemptId, request: clone(executionContext.execution_request),
          request_hash: executionContext.execution_request_hash, status: "EVIDENCE_PERSISTED" };
      } else assert(intent.attempt_id === attemptId && intent.request_hash === sha256(intent.request),
        "canonical evidence lacks its durable execution intent");
      const genesis = store.events.find(event => event.event_type === "RunCreated");
      assert(store.runId && genesis && protocol.seed_panel.seeds.includes(seed) && payload(genesis).seed === seed,
        "invalid calibration evidence checkpoint or requested-seed substitution");
      const path = `evidence/${attemptId}.json`, evidenceHash = sha256(bundle);
      const record = { schema_version: "1.0.0", bundle: clone(bundle), execution_context: clone(executionContext) };
      const next = clone(this.state);
      if (!next.execution_intents.some(item => item.key === key)) next.execution_intents.push(clone(intent));
      next.executions.push({ key, attempt_id: attemptId, path, evidence_hash: evidenceHash, record_hash: sha256(record) });
      next.execution_intents.find(item => item.key === key).status = "EVIDENCE_PERSISTED";
      await this._publish(next, expectedHead, [{ path, value: record }]); return clone(bundle);
    });
  }
  async quarantineAdapterResult({ attemptId, parameterSetHash, seed, result }) {
    const expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true });
      assert(this.head.digest === expectedHead && this.state.status !== "COMPLETE", "cannot quarantine against stale or complete archive");
      const key = `${parameterSetHash}:${seed}`, hash = sha256(result), existing = (this.state.quarantined_results ?? []).find(item => item.key === key);
      if (existing) { assert(existing.result_hash === hash, "quarantined adapter result mutation"); return clone(existing); }
      const path = `quarantine/${attemptId}.json`, record = { schema_version: "phase-a-quarantined-adapter-result-1.0.0",
        attempt_id: attemptId, execution_intent_id: this.state.execution_intents.find(item => item.key === key)?.request?.idempotencyKey ?? null,
        result: clone(result), result_hash: hash };
      const item = { key, attempt_id: attemptId, path, result_hash: hash, record_hash: sha256(record) };
      const next = clone(this.state); next.quarantined_results ??= []; next.quarantined_results.push(item);
      await this._publish(next, expectedHead, [{ path, value: record }]); return clone(item);
    });
  }
  async evidence(parameterSetHash, seed) {
    const item = this.state.executions.find(entry => entry.key === `${parameterSetHash}:${seed}`);
    if (!item) return null;
    const saved = JSON.parse(await readFile(join(this.directory, item.path), "utf8"));
    assert(sha256(saved) === item.record_hash && sha256(saved.bundle) === item.evidence_hash, "checkpointed calibration evidence is corrupt");
    loadEvidence(saved.bundle); return saved.bundle;
  }
  async executionRecord(parameterSetHash, seed) {
    const item = this.state.executions.find(entry => entry.key === `${parameterSetHash}:${seed}`);
    if (!item) return null;
    const saved = JSON.parse(await readFile(join(this.directory, item.path), "utf8"));
    assert(sha256(saved) === item.record_hash && sha256(saved.bundle) === item.evidence_hash, "checkpointed calibration execution record is corrupt");
    return saved;
  }
  async manifest(attemptId) {
    const indexed = this.state.attempts.find(item => item.attempt_id === attemptId);
    if (!indexed) return null;
    const manifest = JSON.parse(await readFile(join(this.directory, "attempts", attemptId, "manifest.json"), "utf8"));
    assert(indexed.manifest_hash === sha256(manifest), "calibration manifest index mismatch");
    assertValidSchema(manifest, "calibration-execution-manifest.schema.json");
    return manifest;
  }
  async verify({ trustedKeys = {} } = {}) {
    assert(Object.keys(trustedKeys).length > 0, "external trust binding required for every calibration archive");
    const freshDistribution = calibrationToolingDistributionDigest({ refresh: true });
    assert(freshDistribution === this.distributionDigest, "calibration tooling changed during archive verification");
    const opened = await CalibrationArchive.open(this.directory, this.trust);
    const empirical = opened.state.execution_mode === "EMPIRICAL_CALIBRATION";
    if (empirical) {
      assert(this.trust.trustScope === "EMPIRICAL_ARCHIVE" && this.trust.releaseBinding?.descriptor_hash &&
        this.trust.executionBinding?.authorization_hash && this.trust.evidenceAuthority?.evidencePublicKey &&
        this.trust.evidenceAuthority?.headPublicKey && attestationAuthority(this.trust).keyId !== this.trust.keyId,
      "empirical archive verification requires full independent release, authorization, evidence, archive, and attestor trust");
    } else assert(opened.state.execution_mode === "SYNTHETIC_CONFORMANCE" &&
      opened.state.authorization_hash === null && opened.state.authorization_key_id === null && opened.state.campaign_id === null,
    "synthetic archive carries empirical authorization semantics");
    const verifiedCandidates = [];
    for (const execution of opened.state.executions) await opened.evidence(...execution.key.split(":", 2));
    for (const attempt of opened.state.attempts) {
      const directory = join(this.directory, "attempts", attempt.attempt_id);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      assertValidSchema(manifest, "calibration-execution-manifest.schema.json");
      if (empirical) assert(manifest.policy_configuration?.kind === "authorized_empirical_adapter" &&
        manifest.model_runtime_configuration?.used === this.trust.evidenceAuthority.modelUseDeclared,
      "empirical manifest policy/model evidence class mismatch");
      else assert(manifest.policy_configuration?.kind === "deterministic_synthetic_conformance" &&
        manifest.model_runtime_configuration?.used === false,
      "synthetic manifest policy/model evidence class mismatch");
      const expectedAssignment = calibrationPolicyRequestBinding({ participant_ids:
        Object.keys(materializeCalibrationRuntime(manifest.parameter_set).effective_configuration.startingProfiles)
          .map((_, index) => `polity-${index + 1}`),
        seed: manifest.seed, seed_panel: protocol.seed_panel.seeds });
      assert(manifest.policy_configuration.policy_package_id === PHASE_A_POLICY_PACKAGE.package_id &&
        manifest.policy_configuration.policy_package_version === PHASE_A_POLICY_PACKAGE.package_version &&
        manifest.policy_configuration.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH &&
        manifest.policy_configuration.assignment_algorithm === expectedAssignment.assignment_algorithm &&
        manifest.policy_configuration.assignment_hash === expectedAssignment.assignment_hash,
      "calibration manifest policy package/assignment binding mismatch");
      const intent = opened.state.execution_intents.find(item => item.key === `${manifest.parameter_set_hash}:${manifest.seed}`);
      if (intent) assert(manifest.execution_intent_id === intent.request.idempotencyKey && manifest.execution_request_hash === intent.request_hash,
        "calibration manifest differs from its durable execution intent");
      const evidenceBytes = await readFile(join(directory, "canonical-evidence.json"), "utf8");
      const metricBytes = await readFile(join(directory, "metrics.json"), "utf8");
      assert(sha256(evidenceBytes) === manifest.evidence_artifact_hash && sha256(metricBytes) === manifest.metric_artifact_hash, "calibration artifact content hash mismatch");
      const bundle = JSON.parse(evidenceBytes), metrics = JSON.parse(metricBytes);
      const executionRecord = await opened.executionRecord(manifest.parameter_set_hash, manifest.seed);
      const executionContext = executionRecord?.execution_context ?? {};
      const observation = failureSet.has(manifest.failure_classification) &&
        ![CALIBRATION_FAILURES.PARAMETER_FAILURE, CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION].includes(manifest.failure_classification)
        ? null : collectCalibrationObservations(bundle, { expectedParameterSet: manifest.parameter_set, expectedSeed: manifest.seed,
          ...opened.collectionOptions(bundle, executionContext) });
      assert((observation === null || observation.seed === manifest.seed) && canonicalize(metrics) === canonicalize(manifest.metrics), "metric/evidence manifest binding mismatch");
      verifyCalibrationAttestation(manifest, manifest.attestation, trustedKeys);
      assert(attempt.manifest_hash === sha256(manifest), "calibration manifest index mismatch");
    }
    for (const indexed of opened.state.candidates) {
      const candidate = await opened.candidate(indexed.parameter_set_hash);
      assert(Object.keys(trustedKeys).length > 0, "external trust binding required to verify calibration candidate attestations");
      verifyCalibrationAttestation(candidate, candidate.attestation, trustedKeys);
      const parent = candidate.parent_parameter_set_hash === sha256(startingParameterSet()) ? startingParameterSet() : await opened.candidate(candidate.parent_parameter_set_hash).then(value => value?.parameter_set);
      assert(parent, "candidate search parent is unavailable");
      assertCalibrationTransition(parent, candidate.parameter_set, candidate.operation);
      assert(canonicalize([...candidate.seeds].sort()) === canonicalize([...protocol.seed_panel.seeds].sort()), "candidate seed panel mismatch");
      const manifests = await Promise.all(candidate.manifest_refs.map(ref => opened.manifest(ref.attempt_id)));
      assert(manifests.every((manifest, index) => sha256(manifest) === candidate.manifest_refs[index].manifest_hash), "candidate manifest reference mismatch");
      assert(canonicalize(manifests.map(m => m.seed).sort()) === canonicalize([...protocol.seed_panel.seeds].sort()) &&
        manifests.every(m => m.parameter_set_hash === candidate.parameter_set_hash && m.calibration_run_id === opened.state.calibration_run_id), "candidate manifests substitute vector/run/seed");
      assert(candidate.policy_configuration?.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH &&
        canonicalize(candidate.policy_configuration.assignment_hashes) ===
          canonicalize(manifests.map(manifest => manifest.policy_configuration.assignment_hash).sort()),
      "candidate policy package/assignment aggregation mismatch");
      const observations = await Promise.all(manifests.map(async manifest => {
        const record = await opened.executionRecord(manifest.parameter_set_hash, manifest.seed), context = record?.execution_context ?? {};
        const bundle = JSON.parse(await readFile(join(this.directory, manifest.evidence_artifact), "utf8"));
        return collectCalibrationObservations(bundle, { expectedParameterSet: manifest.parameter_set, expectedSeed: manifest.seed, ...opened.collectionOptions(bundle, context) });
      }));
      const regenerated = materializeCalibrationMetrics(observations);
      for (const row of regenerated) {
        const manifest = manifests.find(item => item.seed === row.seed);
        assert(manifest && canonicalize(manifest.metrics) === canonicalize(row.metrics), "calibration metrics do not regenerate from canonical evidence");
      }
      const metricRows = manifests.map(manifest => ({ schema_version: "2.0.0", seed: manifest.seed,
        opaque_source_id: manifest.attempt_id, evidence_hash: manifest.evidence_hashes[0],
        rng_provenance_hash: manifest.rng_provenance_ref.replace("content://", ""),
        metric_definition_registry_hash: CALIBRATION_METRIC_DEFINITION_HASH, metrics: manifest.metrics,
        trust_proof: manifest.evidence_trust_proof }));
      const view = calibrationSelectionProjection(metricRows, candidate.parameter_set_hash, { aliasSecret: Buffer.alloc(32, 1) });
      const regeneratedAggregate = aggregateThroughSelectorProcess(view);
      assert(canonicalize(regeneratedAggregate.aggregate_metrics) === canonicalize(candidate.aggregate_metrics), "candidate aggregate does not regenerate from manifests");
      const assessment = assessCalibrationCandidate({ parameter_set_hash: candidate.parameter_set_hash, seed_ids: candidate.seeds,
        aggregate_metrics: regeneratedAggregate.aggregate_metrics, aggregate_status: regeneratedAggregate.aggregate_status,
        ...panelDiagnostics(regenerated), changes_from_start: calibrationStructuralDistance(candidate.parameter_set) });
      assessment.aggregate_metrics = regeneratedAggregate.aggregate_metrics; assessment.aggregate_status = regeneratedAggregate.aggregate_status;
      assessment.parameter_set = clone(candidate.parameter_set);
      assert(canonicalize(candidate.assessment) === canonicalize(assessment), "candidate assessment/score does not regenerate from canonical evidence");
      assert(canonicalize(candidate.aggregate_status) === canonicalize(regeneratedAggregate.aggregate_status), "candidate missingness status mismatch");
      verifiedCandidates.push(candidate);
    }
    assert(canonicalize(opened.state.candidates.map(item => item.parameter_set_hash).sort()) === canonicalize(verifiedCandidates.map(item => item.parameter_set_hash).sort()), "calibration candidate history is incomplete");
    assert(canonicalize(opened.state.assessments.map(item => item.parameter_set_hash).sort()) === canonicalize(verifiedCandidates.map(item => item.parameter_set_hash).sort()), "signed search assessment history is incomplete");
    const reconstructedAssessments = verifiedCandidates.map(c => ({ ...clone(c.assessment), aggregate_status: clone(c.aggregate_status), candidate_attestation_hash: sha256(c) }));
    assert(canonicalize(opened.state.assessments) === canonicalize(reconstructedAssessments), "signed search assessments differ from regenerated assessments");
    const search = reconstructCalibrationSearch(verifiedCandidates, { maximumCandidates: opened.state.search_bound ?? protocol.search_procedure.maximum_parameter_sets });
    assert(search.incumbent_parameter_set_hash === opened.state.incumbent_parameter_set_hash, "search incumbent does not reconstruct");
    if (opened.state.result_ref) {
      const result = JSON.parse(await readFile(join(this.directory, opened.state.result_ref), "utf8"));
      assertValidSchema(result, "calibration-result.schema.json");
      assert(result.execution_mode === opened.state.execution_mode &&
        result.result_type === (empirical ? "CALIBRATION_RESULT" : "CALIBRATION_CONFORMANCE_RESULT") &&
        result.evidence_class === (empirical ? "EMPIRICAL_CALIBRATION_EVIDENCE" : "SYNTHETIC_SOFTWARE_CONFORMANCE"),
      "calibration result execution/evidence class mismatch");
      verifyArtifact(result, result.result_type, this.trust);
      assert(search.complete, "result published before frozen search frontier completed");
      const expectedResult = buildCalibrationResult({ candidates: reconstructedAssessments,
        manifests: await Promise.all(opened.state.attempts.map(item => opened.manifest(item.attempt_id))),
        protocolVersion: protocol.protocol_version, implementationCommit: BASELINE_COMMIT, incidents: opened.state.incidents,
        releaseDescriptorHash: opened.state.release_descriptor_hash, executionMode: opened.state.execution_mode,
        trustPolicyHash: opened.state.execution_mode === "EMPIRICAL_CALIBRATION"
          ? this.trust.releaseBinding.deployment_trust_policy_hash : CALIBRATION_DEPLOYMENT_TRUST_POLICY_HASH });
      expectedResult.protocol_hash = PROTOCOL_HASH; expectedResult.parameter_registry_hash = REGISTRY_HASH;
      const unsigned = clone(result); delete unsigned.artifact_attestation;
      assert(canonicalize(unsigned) === canonicalize(expectedResult), "complete calibration result does not regenerate from archived records");
      assert(result.selected_parameter_set_hash === sha256(result.selected_parameter_vector), "selected calibration vector hash mismatch");
      assert(canonicalize([...result.evaluated_seeds].sort()) === canonicalize([...protocol.seed_panel.seeds].sort()), "calibration result seed panel mismatch");
      const selected = await opened.candidate(result.selected_parameter_set_hash);
      assert(selected?.assessment?.accepted === true && result.candidate_attestation_hashes.includes(sha256(selected)), "calibration result lacks an accepted attested candidate");
      const regenerated = selectCalibrationCandidate(verifiedCandidates.map(candidate => ({ ...clone(candidate.assessment), candidate_attestation_hash: sha256(candidate) })));
      assert(regenerated.parameter_set_hash === result.selected_parameter_set_hash && canonicalize(regenerated.aggregate_metrics) === canonicalize(result.acceptance_metrics), "calibration result does not reproduce maximin selection");
      assert(canonicalize(result.all_attempt_manifest_hashes) === canonicalize(opened.state.attempts.map(item => item.manifest_hash).sort()), "calibration result omits or substitutes attempt history");
      assert(canonicalize(result.rejected_configurations.sort()) === canonicalize(verifiedCandidates.filter(item => !item.assessment.accepted).map(item => item.parameter_set_hash).sort()), "calibration result rejected history mismatch");
      assert(canonicalize(result.search_history) === canonicalize(verifiedCandidates.map(item => ({ parameter_set_hash: item.parameter_set_hash, accepted: item.assessment.accepted, failures: clone(item.assessment.failures) }))), "calibration result search history mismatch");
      const proposed = JSON.parse(await readFile(join(this.directory, "PILOT_0_WORLD_CONFIGURATION.json"), "utf8"));
      assertValidSchema(proposed, "pilot0-world-configuration.schema.json");
      assert(proposed.execution_mode === opened.state.execution_mode && proposed.evidence_class === result.evidence_class &&
        proposed.status === (empirical ? "PROPOSED_NOT_RESEARCH_AUTHORIZED" : "SYNTHETIC_CONFORMANCE_ONLY_NOT_A_WORLD_PROPOSAL"),
      "world-configuration execution/evidence class mismatch");
      verifyArtifact(proposed, "PILOT_0_WORLD_CONFIGURATION", this.trust);
      assert(proposed.parameter_set_hash === result.selected_parameter_set_hash && canonicalize(proposed.parameter_set) === canonicalize(result.selected_parameter_vector), "proposed world configuration differs from selected result");
      assert(proposed.policy_package_hash === result.policy_package_hash &&
        canonicalize(proposed.policy_assignment_hashes) === canonicalize(result.policy_assignment_hashes),
      "proposed world configuration differs from selected policy package/assignments");
    }
    return true;
  }
  collectionOptions(bundle, context = {}) {
    const mode = this.state.execution_mode;
    const archiveTrust = mode === "EMPIRICAL_CALIBRATION" ? executionEvidenceTrust(bundle, context, this.trust.evidenceAuthority) : null;
    if (mode === "EMPIRICAL_CALIBRATION") {
      const store = loadEvidence(bundle), genesis = payload(store.events.find(e => e.event_type === "RunCreated"));
      assert(genesis.calibration_execution_binding_ref && genesis.calibration_execution_binding_hash,
        "evidence does not bind authorized adapter executable");
      const binding = readEvidencePayload(store, genesis.calibration_execution_binding_ref);
      assert(genesis.calibration_execution_binding_hash === sha256(binding) &&
        binding.adapter_package_hash === this.trust.evidenceAuthority.executableHash,
      "evidence does not bind authorized adapter executable");
      assert(binding.policy_manifest_hash === this.trust.evidenceAuthority.policyManifestHash,
        "evidence does not bind the signed treatment-neutral policy manifest");
      assert(binding.calibration_policy_id === this.trust.evidenceAuthority.policyId,
        "evidence does not bind the authorized treatment-neutral policy identity");
      assert(binding.model_runtime_lock_hash === CALIBRATION_MODEL_RUNTIME_LOCK_HASH,
        "evidence does not bind the frozen Hugging Face model-runtime lock");
      verifyAdapterExecutionReceipt(bundle, context, this.trust.evidenceAuthority);
    }
    return { mode, archiveExport: context.archive_export, archiveTrust, codingTrust: this.trust.codingTrust,
      neutralPolicyId: this.trust.evidenceAuthority?.policyId ?? null,
      modelUseDeclared: this.trust.evidenceAuthority?.modelUseDeclared ?? null };
  }
  async recordAttempt(attempt, artifacts, { incident = null } = {}) {
    assert(attempt.attempt_id && attempt.seed && /^[a-f0-9]{64}$/.test(attempt.parameter_set_hash) && failureSet.has(attempt.status), "invalid calibration attempt record");
    const key = `${attempt.parameter_set_hash}:${attempt.seed}`;
    assert(!this.state.completed_keys.includes(key), "calibration attempt already recorded; records are immutable");
    const expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true }); assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      assert(!this.state.completed_keys.includes(key), "calibration attempt already recorded; records are immutable");
      const directory = join(this.directory, "attempts", attempt.attempt_id);
      const evidenceHash = sha256(canonicalize(artifacts.evidence) + "\n");
      const metricHash = sha256(canonicalize(artifacts.metrics) + "\n");
      const manifest = { ...clone(attempt), protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH,
        evidence_artifact: `attempts/${attempt.attempt_id}/canonical-evidence.json`, evidence_artifact_hash: evidenceHash,
        metric_artifact: `attempts/${attempt.attempt_id}/metrics.json`, metric_artifact_hash: metricHash };
      manifest.attestation = attestCalibrationAttempt(manifest, attestationAuthority(this.trust));
      assertValidSchema(manifest, "calibration-execution-manifest.schema.json");
      const next = clone(this.state); next.attempts.push({ attempt_id: attempt.attempt_id, key, manifest_hash: sha256(manifest), status: attempt.status }); next.completed_keys.push(key);
      if (attempt.status === CALIBRATION_FAILURES.BLINDING_BREACH) {
        assert(incident?.affected_decision === attempt.attempt_id, "blinding breach attempt requires its matching protocol incident");
        next.incidents.push(clone(incident)); next.status = "FAILED";
      } else assert(incident === null, "protocol incident may accompany only a blinding breach attempt");
      await this._publish(next, expectedHead, [
        { path: manifest.evidence_artifact, value: artifacts.evidence }, { path: manifest.metric_artifact, value: artifacts.metrics },
        { path: `attempts/${attempt.attempt_id}/manifest.json`, value: manifest }
      ]); return manifest;
    });
  }
  async recordCandidate(candidate) {
    assert(candidate.seeds.length === protocol.seed_panel.seeds.length && canonicalize([...candidate.seeds].sort()) === canonicalize([...protocol.seed_panel.seeds].sort()), "candidate attestation requires complete frozen seed panel");
    assert(candidate.manifest_refs.length === protocol.seed_panel.seeds.length, "candidate attestation requires every seed manifest");
    const expectedHead = this.head?.digest ?? null;
    return this._exclusive(async () => {
      await this._loadLocked({ skipOrphans: true }); assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      const finalized = { ...clone(candidate), protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH };
      finalized.attestation = attestCalibrationAttempt(finalized, attestationAuthority(this.trust));
      const path = `candidates/${candidate.parameter_set_hash}.json`;
      if (!this.state.candidates.some(item => item.parameter_set_hash === candidate.parameter_set_hash)) {
        const next = clone(this.state); next.candidates.push({ parameter_set_hash: candidate.parameter_set_hash, path, candidate_hash: sha256(finalized) });
        await this._publish(next, expectedHead, [{ path, value: finalized }]);
      }
      return clone(finalized);
    });
  }
  async candidate(parameterSetHash) {
    const indexed = this.state.candidates.find(item => item.parameter_set_hash === parameterSetHash);
    if (!indexed) return null;
    const candidate = JSON.parse(await readFile(join(this.directory, indexed.path), "utf8"));
    assert(indexed.candidate_hash === sha256(candidate), "calibration candidate index mismatch");
    return candidate;
  }
  async recordResult(result, worldConfiguration) {
    const expectedHead = this.head.digest;
    return this._exclusive(async () => {
      await this._loadLocked(); assert(this.head.digest === expectedHead, "stale calibration archive head");
      assert(this.state.status !== "COMPLETE", "completed calibration archive is immutable");
      const next = clone(this.state); next.status = "COMPLETE"; next.result_ref = "CALIBRATION_RESULT.json";
      await this._publish(next, expectedHead, [{ path: "CALIBRATION_RESULT.json", value: result },
        { path: "PILOT_0_WORLD_CONFIGURATION.json", value: worldConfiguration }]);
    });
  }
}

function startingParameterSet() {
  const registry = parameterRegistry();
  return Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, clone(entry.value)]));
}
export function startingCalibrationParameterSet() { return clone(startingParameterSet()); }

export function materializeCalibrationRuntime(candidate) {
  validateCalibrationParameterSet(candidate);
  const runtime = materializePhaseARuntime(candidate);
  assert(runtime.protocol_hash === PROTOCOL_HASH && runtime.parameter_registry_hash === REGISTRY_HASH,
    "shared Phase A runtime materialization binding mismatch");
  return runtime;
}

function synchronizeAliases(next, changedId) {
  const assign = (target, fields) => { next[target] = { ...next[target], ...fields }; };
  if (changedId === "world.map.geometry") assign("world.configuration.map", { width: next[changedId].width, height: next[changedId].height, contactRadius: next[changedId].contact_radius });
  if (changedId === "world.configuration.map") next["world.map.geometry"] = { width: next[changedId].width, height: next[changedId].height, contact_radius: next[changedId].contactRadius };
  if (["world.economy.resource_production", "world.economy.consumption", "world.economy.starting_credits"].includes(changedId))
    assign("world.configuration.economy", { startingFood: next["world.economy.resource_production"].starting_food,
      foodProductionPerFarmer: next["world.economy.resource_production"].farmer_food_per_turn,
      foodPerCitizen: next["world.economy.consumption"], startingCredits: next["world.economy.starting_credits"] });
  if (changedId === "world.configuration.economy") {
    next["world.economy.resource_production"] = { farmer_food_per_turn: next[changedId].foodProductionPerFarmer, starting_food: next[changedId].startingFood };
    next["world.economy.consumption"] = next[changedId].foodPerCitizen; next["world.economy.starting_credits"] = next[changedId].startingCredits;
  }
  if (changedId === "world.population.unit_conversion") assign("world.configuration.population", { unitSize: next[changedId].population_per_unit, recruitmentCost: next[changedId].recruitment_credit_cost });
  if (changedId === "world.configuration.population") next["world.population.unit_conversion"] = { population_per_unit: next[changedId].unitSize, recruitment_credit_cost: next[changedId].recruitmentCost };
  if (changedId === "world.combat.coefficients") assign("world.configuration.combat", { attack: next[changedId].attack, defense: next[changedId].defense, terrainModifier: next[changedId].terrain_modifier, drawThreshold: next[changedId].draw_threshold });
  if (changedId === "world.configuration.combat") next["world.combat.coefficients"] = { attack: next[changedId].attack, defense: next[changedId].defense, terrain_modifier: next[changedId].terrainModifier, draw_threshold: next[changedId].drawThreshold };
  if (changedId === "world.memory.capacity") assign("world.configuration.memory", { capacity: next[changedId] });
  if (changedId === "world.configuration.memory") next["world.memory.capacity"] = next[changedId].capacity;
  if (changedId === "world.phase.action_budget") assign("world.configuration.phases", { actionBudgetMs: next[changedId] });
  // world.phase.budgets is an explicit phase-command override (registry rationale
  // and turn-phases.js), not an alias of the shared fallback action budget.
  if (changedId === "world.configuration.phases") next["world.phase.action_budget"] = next[changedId].actionBudgetMs;
  return next;
}

export function validateCalibrationParameterSet(candidate) {
  const baseline = startingParameterSet(), registry = parameterRegistry();
  const assertUnselectedLeavesEqual = (value, original, selected, label, path = []) => {
    assert(value && original && typeof value === "object" && typeof original === "object" && Array.isArray(value) === Array.isArray(original), `calibration structure changed: ${label}`);
    assert(canonicalize(Object.keys(value).sort()) === canonicalize(Object.keys(original).sort()), `calibration fields changed: ${label}`);
    for (const key of Object.keys(original)) {
      const child = value[key], prior = original[key], childPath = [...path, key];
      if (child && prior && typeof child === "object" && typeof prior === "object") assertUnselectedLeavesEqual(child, prior, selected, label, childPath);
      else if (!selected(path, key)) assert(canonicalize(child) === canonicalize(prior), `unselected calibration field changed: ${label}.${childPath.join(".")}`);
    }
  };
  assert(canonicalize(Object.keys(candidate).sort()) === canonicalize(Object.keys(baseline).sort()), "unauthorized or missing calibration parameter");
  for (const id of protocol.held_constant_registry_parameters) assert(canonicalize(candidate[id]) === canonicalize(baseline[id]), `held calibration parameter changed: ${id}`);
  for (const domain of protocol.parameter_domains) {
    const value = candidate[domain.registry_parameter_id], allowed = domain.allowed_domain;
    if (canonicalize(value) === canonicalize(baseline[domain.registry_parameter_id])) continue;
    if (allowed.kind === "integer") assert(canonicalize(value) === canonicalize(baseline[domain.registry_parameter_id]) ||
      (Number.isInteger(value) && value >= allowed.minimum && value <= allowed.maximum && (value - allowed.minimum) % allowed.step === 0), `out-of-domain calibration parameter: ${domain.domain_id}`);
    else if (allowed.kind === "fixed_grid") {
      for (const [field, values] of Object.entries(allowed)) if (field !== "kind")
        {
          let permittedValues = values;
          // The frozen protocol exposes the shared action budget both as its
          // canonical scalar and inside the world-phase configuration. A SET
          // on either registered surface must keep the aliases equal. Accept
          // the union of both frozen grids for that one aliased field; this
          // does not widen either search operation or permit manual values.
          if (domain.domain_id === "world_phase_config" && field === "actionBudgetMs") {
            const budget = protocol.parameter_domains.find(item => item.domain_id === "action_budget")?.allowed_domain;
            const scalarGrid = [];
            if (budget?.kind === "integer") {
              for (let item = budget.minimum; item <= budget.maximum; item += budget.step) scalarGrid.push(item);
            }
            permittedValues = [...new Set([...values, ...scalarGrid])];
          }
          assert(Array.isArray(permittedValues) && permittedValues.some(permitted => canonicalize(value?.[field]) === canonicalize(permitted)), `out-of-domain calibration field: ${domain.domain_id}.${field}`);
        }
      const selectedFields = new Set(Object.keys(allowed).filter(field => field !== "kind"));
      assertUnselectedLeavesEqual(value, baseline[domain.registry_parameter_id], (_path, key) => selectedFields.has(key), domain.domain_id);
    } else if (["integer_multiplier_grid", "bounded_multiplier_grid"].includes(allowed.kind)) {
      const patterns = domain.selector.split(",").map(item => item.trim());
      const selected = (path, key) => domain.selector === "*" || patterns.some(pattern => pattern === "*.resources.*" ? path.includes("resources") : pattern.split(".").at(-1) === key);
      let selectedCount = 0;
      const inspect = (item, path = []) => {
        if (Array.isArray(item)) return item.forEach((child, index) => inspect(child, [...path, String(index)]));
        if (!item || typeof item !== "object") return;
        for (const [key, child] of Object.entries(item)) {
          if (typeof child === "number" && selected(path, key)) {
            selectedCount++; assert(Number.isSafeInteger(child) && child >= 0, `non-integer multiplier-grid value: ${domain.domain_id}.${[...path, key].join(".")}`);
            if (allowed.minimum !== undefined) assert(child >= allowed.minimum, `below calibration domain minimum: ${domain.domain_id}`);
            if (allowed.maximum !== undefined) assert(child <= allowed.maximum, `above calibration domain maximum: ${domain.domain_id}`);
            if (/Permille$/.test(key)) {
              if (allowed.permille_minimum !== undefined) assert(child >= allowed.permille_minimum, `below permille minimum: ${domain.domain_id}`);
              if (allowed.permille_maximum !== undefined) assert(child <= allowed.permille_maximum, `above permille maximum: ${domain.domain_id}`);
              if (allowed.success_permille_minimum !== undefined) assert(child >= allowed.success_permille_minimum, `below success permille minimum: ${domain.domain_id}`);
              if (allowed.success_permille_maximum !== undefined) assert(child <= allowed.success_permille_maximum, `above success permille maximum: ${domain.domain_id}`);
            }
            if (key === "turns" && allowed.turn_minimum !== undefined) assert(child >= allowed.turn_minimum, `below turn minimum: ${domain.domain_id}`);
            if (allowed.positive_integer_minimum !== undefined && !/Permille$/.test(key)) assert(child >= allowed.positive_integer_minimum, `below positive minimum: ${domain.domain_id}`);
          } else inspect(child, [...path, key]);
        }
      };
      inspect(value); assert(selectedCount > 0, `multiplier calibration selector matches no values: ${domain.domain_id}`);
      assertUnselectedLeavesEqual(value, baseline[domain.registry_parameter_id], selected, domain.domain_id);
    } else {
      assert(["alias", "alias_group"].includes(allowed.kind), `unknown calibration domain kind: ${allowed.kind}`);
      for (const [field, expected] of Object.entries(allowed.fixed_fields ?? {}))
        assert(canonicalize(value?.[field]) === canonicalize(expected), `fixed calibration field changed: ${domain.domain_id}.${field}`);
    }
  }
  assert(candidate["world.configuration.map"].width === candidate["world.map.geometry"].width &&
    candidate["world.configuration.map"].height === candidate["world.map.geometry"].height &&
    candidate["world.configuration.map"].contactRadius === candidate["world.map.geometry"].contact_radius, "map calibration alias divergence");
  assert(candidate["world.configuration.economy"].startingFood === candidate["world.economy.resource_production"].starting_food &&
    candidate["world.configuration.economy"].foodProductionPerFarmer === candidate["world.economy.resource_production"].farmer_food_per_turn &&
    candidate["world.configuration.economy"].foodPerCitizen === candidate["world.economy.consumption"] &&
    candidate["world.configuration.economy"].startingCredits === candidate["world.economy.starting_credits"], "economy calibration alias divergence");
  assert(candidate["world.configuration.population"].unitSize === candidate["world.population.unit_conversion"].population_per_unit &&
    candidate["world.configuration.population"].recruitmentCost === candidate["world.population.unit_conversion"].recruitment_credit_cost, "population calibration alias divergence");
  assert(candidate["world.configuration.combat"].attack === candidate["world.combat.coefficients"].attack &&
    candidate["world.configuration.combat"].defense === candidate["world.combat.coefficients"].defense &&
    candidate["world.configuration.combat"].terrainModifier === candidate["world.combat.coefficients"].terrain_modifier &&
    candidate["world.configuration.combat"].drawThreshold === candidate["world.combat.coefficients"].draw_threshold, "combat calibration alias divergence");
  assert(candidate["world.configuration.memory"].capacity === candidate["world.memory.capacity"], "memory calibration alias divergence");
  assert(candidate["world.configuration.phases"].actionBudgetMs === candidate["world.phase.action_budget"], "phase calibration alias divergence");
  assert(registry.parameters.every(entry => Object.hasOwn(candidate, entry.parameter_id)), "parameter registry coverage incomplete");
  return true;
}

function runtimeFingerprint() { return { node: process.version, platform: platform(), architecture: arch(), release: release() }; }

function vectorViolation(metrics) {
  return protocol.metrics.map(metric => {
    const value = metrics[metric.metric_id], minimum = metric.acceptance.minimum, maximum = metric.acceptance.maximum;
    if (value === null) return 1;
    if (minimum !== undefined && value < minimum) return fixedRatio(decimalToScaled(minimum) - decimalToScaled(value), decimalToScaled(Math.max(Math.abs(minimum), 1)));
    if (maximum !== undefined && value > maximum) return fixedRatio(decimalToScaled(value) - decimalToScaled(maximum), decimalToScaled(Math.max(Math.abs(maximum), 1)));
    return 0;
  });
}

function betterCandidate(candidate, incumbent) {
  const a = vectorViolation(candidate.aggregate_metrics), b = vectorViolation(incumbent.aggregate_metrics);
  if (b.some((value, index) => value === 0 && a[index] > 0)) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// Reconstruct the candidate frontier solely from ordered archived records and the
// frozen operation enumeration. No saved cursor or saved incumbent is trusted.
export function reconstructCalibrationSearch(records, { maximumCandidates = protocol.search_procedure.maximum_parameter_sets } = {}) {
  assert(Number.isSafeInteger(maximumCandidates) && maximumCandidates > 0 && maximumCandidates <= protocol.search_procedure.maximum_parameter_sets, "invalid archived search bound");
  const seen = new Set(), operations = enumerateCalibrationOperations();
  let incumbent = startingParameterSet(), assessment = null, cursor = 0;
  let progress = { search_cursor: { round: 0, operation_index: 0, candidate_index: 0 }, round_improved: false };
  const result = complete => ({ complete, incumbent_parameter_set_hash: assessment?.parameter_set_hash ?? null, ...clone(progress) });
  for (let round = 0; round < protocol.search_procedure.maximum_rounds; round++) {
    let improved = false;
    for (const [operationIndex, operation] of (round === 0 ? operations : operations.slice(1)).entries()) {
      const candidate = applyOperation(incumbent, operation), hash = sha256(candidate);
      if (seen.has(hash)) continue;
      if (cursor >= maximumCandidates) {
        assert(cursor === records.length, "archive exceeds frozen candidate bound");
        return result(true);
      }
      const record = records[cursor];
      if (!record) return result(false);
      assert(record.round === round && record.candidate_index === cursor && record.parent_parameter_set_hash === sha256(incumbent) &&
        record.parameter_set_hash === hash && canonicalize(record.parameter_set) === canonicalize(candidate) && canonicalize(record.operation) === canonicalize(operation), "archived candidate skipped/substituted a frozen search transition");
      seen.add(hash); cursor++;
      if (!assessment || betterCandidate(record.assessment, assessment)) { incumbent = candidate; assessment = record.assessment; improved = true; }
      progress = { search_cursor: { round, operation_index: operationIndex + 1, candidate_index: cursor }, round_improved: improved };
    }
    if (records.slice(0, cursor).some(record => record.assessment.accepted) || !improved) {
      assert(cursor === records.length, "archive continued beyond stopping frontier");
      return result(true);
    }
  }
  assert(cursor === records.length, "archive exceeds frozen round bound");
  return result(true);
}

export function calibrationStructuralDistance(candidate, start = startingParameterSet()) {
  const aliasGroups = [
    ["world.map.geometry", "world.configuration.map"],
    ["world.economy.resource_production", "world.economy.consumption", "world.economy.starting_credits", "world.configuration.economy"],
    ["world.population.unit_conversion", "world.configuration.population"],
    ["world.combat.coefficients", "world.configuration.combat"],
    ["world.memory.capacity", "world.configuration.memory"],
    ["world.phase.action_budget", "world.phase.budgets", "world.configuration.phases"]
  ];
  const grouped = new Set(aliasGroups.flat()), leafDistance = (a, b) => {
    if (canonicalize(a) === canonicalize(b)) return 0;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return 1;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((sum, key) => sum + leafDistance(a[key], b[key]), 0);
  };
  let distance = aliasGroups.reduce((sum, group) => sum + (group.some(id => canonicalize(candidate[id]) !== canonicalize(start[id])) ? 1 : 0), 0);
  for (const id of Object.keys(start)) if (!grouped.has(id)) distance += leafDistance(candidate[id], start[id]);
  return distance;
}

function applyOperation(base, operation) {
  const next = clone(base);
  if (operation.operation === "BASELINE") return next;
  const domain = protocol.parameter_domains.find(item => item.domain_id === operation.domain_id);
  assert(domain && Object.hasOwn(next, domain.registry_parameter_id), "operation references unregistered parameter");
  const value = clone(next[domain.registry_parameter_id]), allowed = domain.allowed_domain;
  if (operation.operation === "SET") next[domain.registry_parameter_id] = operation.value;
  else if (operation.operation === "SET_FIELD") {
    assert(value && typeof value === "object", "calibration selector requires a structured parameter");
    let changed = 0;
    const set = item => { if (!item || typeof item !== "object") return; for (const [key, child] of Object.entries(item)) {
      if (key === operation.selector) { item[key] = operation.value; changed++; } else set(child);
    }};
    if (Object.hasOwn(value, operation.selector)) { value[operation.selector] = operation.value; changed++; } else set(value);
    assert(changed > 0, "calibration selector does not address a registered field");
    next[domain.registry_parameter_id] = value;
  }
  else if (operation.operation === "MULTIPLY_GROUP") {
    const patterns = domain.selector.split(",").map(item => item.trim());
    const selected = (path, key) => domain.selector === "*" || patterns.some(pattern => {
      const pieces = pattern.split(".");
      if (pattern === "*.resources.*") return path.includes("resources");
      return pieces.at(-1) === key;
    });
    const bounded = (number, key) => {
      assert(Number.isSafeInteger(number), "multiplier grids require integer registered values");
      const multiplier = decimalRatio(operation.value);
      const rounded = divideRoundHalfEvenBigInt(BigInt(number) * multiplier.numerator, multiplier.denominator);
      assert(rounded <= BigInt(Number.MAX_SAFE_INTEGER) && rounded >= BigInt(Number.MIN_SAFE_INTEGER), "calibration multiplier overflow");
      let result = Math.max(0, Number(rounded));
      if (allowed.minimum !== undefined) result = Math.max(allowed.minimum, result);
      if (allowed.maximum !== undefined) result = Math.min(allowed.maximum, result);
      if (/Permille$/.test(key)) {
        if (allowed.permille_minimum !== undefined) result = Math.max(allowed.permille_minimum, result);
        if (allowed.permille_maximum !== undefined) result = Math.min(allowed.permille_maximum, result);
        if (allowed.success_permille_minimum !== undefined) result = Math.max(allowed.success_permille_minimum, result);
        if (allowed.success_permille_maximum !== undefined) result = Math.min(allowed.success_permille_maximum, result);
      }
      if (key === "turns" && allowed.turn_minimum !== undefined) result = Math.max(allowed.turn_minimum, result);
      if (allowed.positive_integer_minimum !== undefined && !/Permille$/.test(key)) result = Math.max(allowed.positive_integer_minimum, result);
      return result;
    };
    const multiply = (item, path = []) => {
      if (Array.isArray(item)) return item.map((child, index) => multiply(child, [...path, String(index)]));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) =>
        [key, typeof child === "number" && selected(path, key) ? bounded(child, key) : multiply(child, [...path, key])]));
      return item;
    };
    next[domain.registry_parameter_id] = multiply(value);
  } else assert(false, "unknown calibration operation");
  return synchronizeAliases(next, domain.registry_parameter_id);
}

export function assertCalibrationTransition(current, candidate, operation) {
  assert(enumerateCalibrationOperations().some(item => canonicalize(item) === canonicalize(operation)), "calibration transition operation is not an exact frozen operation");
  const expected = applyOperation(current, operation);
  assert(canonicalize(candidate) === canonicalize(expected), "unauthorized manual calibration parameter substitution");
  validateCalibrationParameterSet(candidate); return true;
}

export function buildCalibrationResult({ candidates, manifests, protocolVersion, implementationCommit, incidents, releaseDescriptorHash = null,
  executionMode = "SYNTHETIC_CONFORMANCE", trustPolicyHash = CALIBRATION_DEPLOYMENT_TRUST_POLICY_HASH }) {
  assert(protocolVersion === protocol.protocol_version && implementationCommit === BASELINE_COMMIT, "result baseline/protocol mismatch");
  assert((incidents ?? []).length === 0, "calibration incidents prevent result selection");
  const regeneratedCandidates = candidates.map(candidate => {
    assert(candidate.parameter_set && candidate.parameter_set_hash === sha256(candidate.parameter_set), "candidate parameter vector/hash mismatch");
    const regenerated = assessCalibrationCandidate({ parameter_set_hash: candidate.parameter_set_hash,
      seed_ids: protocol.seed_panel.seeds, aggregate_metrics: candidate.aggregate_metrics,
      aggregate_status: candidate.aggregate_status ?? {},
      worst_seed_metric_pass_fraction: candidate.selection_score?.worst_seed_metric_pass_fraction ?? 0,
      cross_seed_metric_variance: -(candidate.selection_score?.negative_cross_seed_metric_variance ?? 0),
      changes_from_start: -(candidate.selection_score?.negative_changes_from_start ?? 0) });
    regenerated.aggregate_metrics = clone(candidate.aggregate_metrics); regenerated.aggregate_status = clone(candidate.aggregate_status ?? {});
    regenerated.parameter_set = clone(candidate.parameter_set); regenerated.candidate_attestation_hash = candidate.candidate_attestation_hash;
    return regenerated;
  });
  const selected = selectCalibrationCandidate(regeneratedCandidates);
  assert(selected.parameter_set && selected.parameter_set_hash === sha256(selected.parameter_set), "selected candidate parameter vector/hash mismatch");
  const evaluatedSeeds = [...new Set(manifests.flatMap(item => item.seeds ?? [item.seed]).filter(Boolean))].sort();
  assert(canonicalize(evaluatedSeeds) === canonicalize([...protocol.seed_panel.seeds].sort()), "calibration result requires the complete frozen seed panel");
  assert(selected.candidate_attestation_hash && /^[a-f0-9]{64}$/.test(selected.candidate_attestation_hash), "calibration result requires a verified candidate attestation");
  assert(["SYNTHETIC_CONFORMANCE", "EMPIRICAL_CALIBRATION"].includes(executionMode), "invalid calibration result execution mode");
  const synthetic = executionMode === "SYNTHETIC_CONFORMANCE";
  const participantIds = Object.keys(materializeCalibrationRuntime(startingParameterSet()).effective_configuration.startingProfiles)
    .map((_, index) => `polity-${index + 1}`);
  const policyAssignmentHashes = evaluatedSeeds.map(seed => calibrationPolicyRequestBinding({ participant_ids: participantIds,
    seed, seed_panel: protocol.seed_panel.seeds }).assignment_hash);
  for (const manifest of manifests) if (manifest.policy_configuration?.assignment_hash) {
    const index = evaluatedSeeds.indexOf(manifest.seed);
    assert(index >= 0 && manifest.policy_configuration.policy_package_hash === PHASE_A_POLICY_PACKAGE_HASH &&
      manifest.policy_configuration.assignment_hash === policyAssignmentHashes[index],
    "calibration result contains an unbound policy package/assignment");
  }
  return { schema_version: "1.0.0", result_type: synthetic ? "CALIBRATION_CONFORMANCE_RESULT" : "CALIBRATION_RESULT",
    execution_mode: executionMode, evidence_class: synthetic ? "SYNTHETIC_SOFTWARE_CONFORMANCE" : "EMPIRICAL_CALIBRATION_EVIDENCE",
    protocol_version: protocolVersion,
    implementation_commit: implementationCommit, implementation_tag: BASELINE_TAG,
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT,
    release_descriptor_hash: releaseDescriptorHash,
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    policy_assignment_hashes: policyAssignmentHashes,
    selected_parameter_vector: clone(selected.parameter_set ?? {}),
    selected_parameter_set_hash: selected.parameter_set_hash, all_attempt_manifest_hashes: manifests.map(sha256).sort(),
    candidate_attestation_hashes: regeneratedCandidates.map(item => item.candidate_attestation_hash).filter(Boolean).sort(),
    attempted_parameter_vectors: new Set(regeneratedCandidates.map(item => item.parameter_set_hash)).size,
    evaluated_seeds: evaluatedSeeds,
    acceptance_metrics: clone(selected.aggregate_metrics ?? {}), thresholds_hash: sha256(protocol.metrics.map(metric => ({ id: metric.metric_id, acceptance: metric.acceptance }))),
    stopping_rule_hash: sha256(protocol.stopping_rule), stopping_rule_satisfied: true,
    stopping_rule_proof: { all_ranges_pass: selected.accepted === true, complete_seed_panel: true, selection_rule: protocol.stopping_rule.selection },
    search_history: regeneratedCandidates.map(item => ({ parameter_set_hash: item.parameter_set_hash, accepted: item.accepted, failures: clone(item.failures) })),
    rejected_configurations: regeneratedCandidates.filter(item => !item.accepted).map(item => item.parameter_set_hash),
    provenance: { implementation_commit: implementationCommit, baseline_tag_commit: BASELINE_COMMIT,
      tooling_distribution_digest: calibrationToolingDistributionDigest(), protocol_version: protocolVersion,
      parameter_registry_version: parameterRegistry().registry_version, deployment_trust_policy_hash: trustPolicyHash },
    blinding_attestation: "CANDIDATE_ATTESTATIONS_VERIFIED", incidents: [],
    calibration_execution_authorized: !synthetic, pilot0_research_authorized: false, confirmatory_authorized: false };
}

export class PhaseACalibrationRunner {
  constructor({ directory, mode, implementationCommit, executor, attestor = null, archiveSigner = null, authorization = null,
    authorizationTrust = null, releaseDescriptor = null, releaseTrust = null, trustPolicy = deploymentTrustPolicy,
    revocationRegistry = null, evidencePublicKey = null, evidenceHeadPublicKey = null, codingTrust = null, fault = () => {} }) {
    assert(typeof executor === "function" || typeof executor?.execute === "function", "calibration executor required");
    this.directory = directory; this.mode = mode; this.implementationCommit = implementationCommit; this.executor = executor; this.attestor = attestor;
    this.archiveSigner = archiveSigner;
    this.authorization = authorization; this.authorizationTrust = authorizationTrust; this.releaseDescriptor = releaseDescriptor;
    this.releaseTrust = releaseTrust; this.trustPolicy = clone(trustPolicy);
    this.revocationRegistry = revocationRegistry === null ? null : clone(revocationRegistry); this.fault = fault;
    this.evidencePublicKey = evidencePublicKey; this.evidenceHeadPublicKey = evidenceHeadPublicKey; this.codingTrust = codingTrust;
  }
  async run({ maximumCandidates = protocol.search_procedure.maximum_parameter_sets } = {}) {
    calibrationToolingDistributionDigest({ refresh: true });
    assert(["SYNTHETIC_CONFORMANCE", "EMPIRICAL_CALIBRATION"].includes(this.mode), "unsupported calibration mode");
    if (this.mode === "EMPIRICAL_CALIBRATION") assertEmpiricalCalibrationAuthorization(this.authorization, this.executor, {
      archiveDirectory: this.directory, authorizationTrust: this.authorizationTrust, releaseDescriptor: this.releaseDescriptor,
      releaseTrust: this.releaseTrust, trustPolicy: this.trustPolicy, revocationRegistry: this.revocationRegistry
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lease = new DatabaseSync(join(this.directory, "calibration-execution-lock.sqlite"));
    try {
      lease.exec("PRAGMA busy_timeout=0");
      try { lease.exec("BEGIN IMMEDIATE"); } catch { throw new Error("calibration execution already claimed by another runner"); }
      try { return await this._run({ maximumCandidates }); } finally { lease.exec("ROLLBACK"); }
    } finally { lease.close(); }
  }
  async _run({ maximumCandidates = protocol.search_procedure.maximum_parameter_sets } = {}) {
    assert(["SYNTHETIC_CONFORMANCE", "EMPIRICAL_CALIBRATION"].includes(this.mode), "unsupported calibration mode");
    const verifiedRelease = this.mode === "EMPIRICAL_CALIBRATION"
      ? assertEmpiricalCalibrationAuthorization(this.authorization, this.executor, { archiveDirectory: this.directory,
        authorizationTrust: this.authorizationTrust, releaseDescriptor: this.releaseDescriptor, releaseTrust: this.releaseTrust,
        trustPolicy: this.trustPolicy, revocationRegistry: this.revocationRegistry })
      : null;
    if (this.mode === "EMPIRICAL_CALIBRATION") assert(maximumCandidates === protocol.search_procedure.maximum_parameter_sets, "empirical search bound cannot be manually overridden");
    assert(this.implementationCommit === BASELINE_COMMIT, "implementation baseline mismatch");
    assert(Number.isInteger(maximumCandidates) && maximumCandidates > 0 && maximumCandidates <= protocol.search_procedure.maximum_parameter_sets, "candidate bound violates protocol");
    const registry = parameterRegistry(); validateCalibrationProtocol(protocol, registry);
    const releaseBinding = verifiedRelease ?? { descriptor_hash: null, tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT };
    let evidenceAuthority = null;
    if (this.mode === "EMPIRICAL_CALIBRATION") {
      assert(this.evidencePublicKey && this.evidenceHeadPublicKey &&
        calibrationKeyId(createPublicKey(this.evidencePublicKey)) === this.authorization.evidence_key_id &&
        calibrationKeyId(createPublicKey(this.evidenceHeadPublicKey)) === this.authorization.evidence_head_key_id, "empirical evidence authorities differ from signed authorization");
      evidenceAuthority = { evidencePublicKey: this.evidencePublicKey, headPublicKey: this.evidenceHeadPublicKey,
        adapterHash: this.authorization.adapter_hash, executableHash: sha256(this.authorization.adapter_executable),
        policyManifestHash: this.authorization.policy_manifest_hash, policyId: this.authorization.policy_manifest.policy_id,
        modelUseDeclared: this.authorization.policy_manifest.model_use_declared };
    }
    const archiveAuthority = this.mode === "EMPIRICAL_CALIBRATION" ? this.archiveSigner : (this.archiveSigner ?? this.attestor ?? CONFORMANCE_TRUST);
    const attestationTrust = normalizeTrust(this.attestor ?? CONFORMANCE_TRUST);
    assert(archiveAuthority, "empirical calibration requires a separately authenticated archive signer");
    const normalizedArchiveAuthority = normalizeTrust(archiveAuthority);
    if (this.mode === "EMPIRICAL_CALIBRATION") {
      assert(normalizedArchiveAuthority.keyId === this.authorization.archive_key_id && attestationTrust.keyId === this.authorization.attestor_key_id &&
        normalizedArchiveAuthority.keyId !== attestationTrust.keyId, "empirical archive and attestation authorities are not independently authorization-bound");
    }
    const executionBinding = this.mode === "EMPIRICAL_CALIBRATION" ? { authorization_hash: sha256(this.authorization),
      authorization_key_id: this.authorization.key_id, campaign_id: this.authorization.campaign_id,
      calibration_run_id: this.authorization.calibration_run_id, attestor_key_id: this.authorization.attestor_key_id } : null;
    const archiveTrust = normalizeTrust({ ...normalizedArchiveAuthority, releaseBinding, evidenceAuthority, codingTrust: this.codingTrust,
      fault: this.fault, attestationAuthority: attestationTrust, executionBinding });
    assert(this.mode === "SYNTHETIC_CONFORMANCE" || archiveTrust.trustScope !== "SYNTHETIC_CONFORMANCE", "empirical calibration requires externally authenticated archive trust");
    let archive;
    try { archive = await CalibrationArchive.open(this.directory, archiveTrust); }
    catch (error) { if (error.code !== "ENOENT") throw error; archive = await new CalibrationArchive(this.directory, archiveTrust).initialize({ protocolVersion: protocol.protocol_version, implementationCommit: this.implementationCommit, executionMode: this.mode }); }
    assert(archive.state.execution_mode === this.mode, "archive execution mode cannot change on resume");
    if (archive.state.status === "FAILED" || archive.state.incidents.length)
      throw new Error("calibration archive is terminally failed by a retained protocol incident; start a separately authorized new archive");
    if (archive.state.status === "COMPLETE") {
      assert(archive.state.result_ref === "CALIBRATION_RESULT.json", "complete calibration archive lacks signed result reference");
      await archive.verify({ trustedKeys: { [archiveTrust.keyId]: archiveTrust.publicKey, [attestationTrust.keyId]: attestationTrust.publicKey } });
      return JSON.parse(await readFile(join(this.directory, archive.state.result_ref), "utf8"));
    }
    const operations = enumerateCalibrationOperations();
    const history = await Promise.all(archive.state.candidates.map(item => archive.candidate(item.parameter_set_hash)));
    // A RUNNING archive is not trusted merely because its mutable search head
    // was signed by the archive writer. Independently verify every retained
    // candidate and seed manifest before any of them can influence recovery.
    for (const candidate of history) {
      verifyCalibrationAttestation(candidate, candidate.attestation, { [attestationTrust.keyId]: attestationTrust.publicKey });
      assert(candidate.manifest_refs.length === protocol.seed_panel.seeds.length, "recovery candidate lacks complete seed manifests");
      const retained = await Promise.all(candidate.manifest_refs.map(ref => archive.manifest(ref.attempt_id)));
      const regeneratedObservations = [];
      const archivedMetricsBySeed = new Map();
      for (const [index, manifest] of retained.entries()) {
        assert(manifest && sha256(manifest) === candidate.manifest_refs[index].manifest_hash &&
          manifest.parameter_set_hash === candidate.parameter_set_hash && manifest.calibration_run_id === archive.state.calibration_run_id,
        "recovery candidate manifest binding mismatch");
        verifyCalibrationAttestation(manifest, manifest.attestation, { [attestationTrust.keyId]: attestationTrust.publicKey });
        const record = await archive.executionRecord(manifest.parameter_set_hash, manifest.seed);
        const evidenceBytes = await readFile(join(archive.directory, manifest.evidence_artifact), "utf8");
        const metricBytes = await readFile(join(archive.directory, manifest.metric_artifact), "utf8");
        assert(sha256(evidenceBytes) === manifest.evidence_artifact_hash &&
          sha256(metricBytes) === manifest.metric_artifact_hash,
        "recovery attempt artifact hash mismatch");
        const archivedBundle = JSON.parse(evidenceBytes), archivedMetrics = JSON.parse(metricBytes);
        assert(canonicalize(archivedBundle) === canonicalize(record.bundle),
          "recovery canonical evidence artifact differs from its execution checkpoint");
        const regenerated = collectCalibrationObservations(record.bundle, { expectedParameterSet: manifest.parameter_set,
          expectedSeed: manifest.seed, ...archive.collectionOptions(record.bundle, record.execution_context) });
        assert(canonicalize(archivedMetrics) === canonicalize(manifest.metrics),
          "recovery metric artifact differs from its signed manifest");
        archivedMetricsBySeed.set(manifest.seed, archivedMetrics);
        regeneratedObservations.push(regenerated);
      }
      const regeneratedRows = materializeCalibrationMetrics(regeneratedObservations);
      for (const row of regeneratedRows) assert(canonicalize(row.metrics) === canonicalize(archivedMetricsBySeed.get(row.seed)),
        "recovery metric artifact does not regenerate from canonical evidence");
      const aggregate = aggregateThroughSelectorProcess(calibrationSelectionProjection(regeneratedRows,
        candidate.parameter_set_hash, { aliasSecret: Buffer.alloc(32, 1) }));
      const assessment = assessCalibrationCandidate({ parameter_set_hash: candidate.parameter_set_hash,
        seed_ids: candidate.seeds, aggregate_metrics: aggregate.aggregate_metrics, aggregate_status: aggregate.aggregate_status,
        ...panelDiagnostics(regeneratedRows), changes_from_start: calibrationStructuralDistance(candidate.parameter_set) });
      assessment.aggregate_metrics = aggregate.aggregate_metrics; assessment.aggregate_status = aggregate.aggregate_status;
      assessment.parameter_set = clone(candidate.parameter_set);
      assert(canonicalize(candidate.aggregate_metrics) === canonicalize(aggregate.aggregate_metrics) &&
        canonicalize(candidate.aggregate_status) === canonicalize(aggregate.aggregate_status) &&
        canonicalize(candidate.assessment) === canonicalize(assessment),
      "recovery candidate assessment does not regenerate from canonical evidence");
    }
    const restored = reconstructCalibrationSearch(history, { maximumCandidates });
    const restoredAssessments = history.map(candidate => ({ ...clone(candidate.assessment), aggregate_status: clone(candidate.aggregate_status), candidate_attestation_hash: sha256(candidate) }));
    // A candidate publication may precede its progress publication. Reconstruct
    // this cursor and admission flag from signed candidates, including that tail.
    await archive.update(state => {
      state.search_cursor = restored.search_cursor; state.round_improved = restored.round_improved;
      state.current_round = restored.search_cursor.round; state.incumbent_parameter_set_hash = restored.incumbent_parameter_set_hash;
      state.visited_parameter_set_hashes = history.map(candidate => candidate.parameter_set_hash);
      state.assessments = restoredAssessments; return state;
    });
    let incumbent = startingParameterSet(), incumbentAssessment = null;
    const assessments = clone(archive.state.assessments ?? []), manifests = [];
    if (archive.state.incumbent_parameter_set_hash) {
      const savedIncumbent = await archive.candidate(archive.state.incumbent_parameter_set_hash);
      assert(savedIncumbent, "calibration incumbent is absent from signed history");
      incumbent = clone(savedIncumbent.parameter_set); incumbentAssessment = assessments.find(item => item.parameter_set_hash === archive.state.incumbent_parameter_set_hash) ?? null;
    }
    const manifestAttestor = attestationTrust;
    const policyConfiguration = this.mode === "SYNTHETIC_CONFORMANCE" ? { kind: "deterministic_synthetic_conformance",
      policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
      policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH }
      : { kind: "authorized_empirical_adapter", adapter_hash: this.authorization.adapter_hash,
        executable_hash: sha256(this.authorization.adapter_executable), policy_manifest_hash: this.authorization.policy_manifest_hash,
        policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
        policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH };
    const modelRuntimeConfiguration = { used: this.mode === "EMPIRICAL_CALIBRATION" && this.executor.contract.model_use_declared,
      frozen_artifact: baseline.runtime.hugging_face_repository, frozen_revision: baseline.runtime.hugging_face_revision,
      runtime_lock_hash: CALIBRATION_MODEL_RUNTIME_LOCK_HASH, runtime_lock: clone(CALIBRATION_MODEL_RUNTIME_LOCK) };
    if (archive.state.search_bound !== undefined) assert(archive.state.search_bound === maximumCandidates, "resume cannot change the search bound");
    await archive.update(state => { state.status = "RUNNING"; state.search_bound = maximumCandidates; return state; });
    let candidateIndex = archive.state.search_cursor?.candidate_index ?? 0;
    let qualifyingFrontierComplete = true;
    const invocationCandidates = new Set(archive.state.visited_parameter_set_hashes ?? []);
    const resumeCursor = clone(archive.state.search_cursor ?? { round: 0, operation_index: 0, candidate_index: 0 });
    search: for (let round = resumeCursor.round; round < protocol.search_procedure.maximum_rounds; round++) {
      let improvedThisRound = round === resumeCursor.round && archive.state.round_improved === true;
      const roundOperations = round === 0 ? operations : operations.slice(1);
      await archive.update(state => {
        if (state.search_cursor.round !== round) {
          state.search_cursor = { round, operation_index: 0, candidate_index: candidateIndex };
          state.round_improved = false;
        }
        state.current_round = round; return state;
      });
      for (const [operationIndex, operation] of roundOperations.entries()) {
      if (round === resumeCursor.round && operationIndex < resumeCursor.operation_index) continue;
      if (candidateIndex >= maximumCandidates) {
        if (this.mode === "EMPIRICAL_CALIBRATION") qualifyingFrontierComplete = false;
        break search;
      }
      const parameterSet = applyOperation(incumbent, operation); assertCalibrationTransition(incumbent, parameterSet, operation);
      const parentParameterHash = sha256(incumbent), parameterHash = sha256(parameterSet), observations = [], bundles = new Map();
      if (invocationCandidates.has(parameterHash)) continue;
      invocationCandidates.add(parameterHash);
      const index = candidateIndex++;
      assert(index < protocol.search_procedure.maximum_parameter_sets, "search bound exceeded");
      for (const seed of protocol.seed_panel.seeds) {
        const key = `${parameterHash}:${seed}`, attemptId = stableId("calibration-attempt", protocol.protocol_version, parameterHash, seed);
        if (archive.state.completed_keys.includes(key)) {
          const completed = await archive.manifest(attemptId);
          assert(completed, "completed calibration seed lacks immutable manifest");
          if (![CALIBRATION_FAILURES.PARAMETER_FAILURE, CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION].includes(completed.status))
            throw new Error(`retained ${completed.status} calibration attempt prevents silent retry`);
        }
        const loadedAdapter = loadedExecutionModules.get(this.executor);
        const adapterContractHash = this.executor?.contract ? sha256(this.executor.contract) : null;
        const executionRequest = deepFreeze({ schema_version: "phase-a-execution-request-1.0.0", mode: this.mode,
          calibrationRunId: archive.state.calibration_run_id, attemptId,
          idempotencyKey: stableId("calibration-execution-intent", archive.state.calibration_run_id, parameterHash, seed), seed,
          parameterSet: clone(parameterSet), runtimeConfiguration: materializeCalibrationRuntime(parameterSet), maxTurns: 20,
          objectiveTerminalPredicates: clone(parameterSet["world.termination.objective_predicates"]),
          policyBinding: calibrationPolicyRequestBinding({
            participant_ids: Object.keys(materializeCalibrationRuntime(parameterSet).effective_configuration.startingProfiles)
              .map((_, participantIndex) => `polity-${participantIndex + 1}`),
            seed, seed_panel: protocol.seed_panel.seeds
          }),
          adapterContractHash,
          adapterPackageHash: this.mode === "EMPIRICAL_CALIBRATION" ? loadedAdapter?.packageDigest ?? null : null,
          neutralPolicyManifest: this.mode === "EMPIRICAL_CALIBRATION" ? clone(this.authorization.policy_manifest) : null,
          modelRuntimeLock: this.mode === "EMPIRICAL_CALIBRATION" ? clone(CALIBRATION_MODEL_RUNTIME_LOCK) : null });
        const pendingIntent = archive.state.execution_intents.find(item => item.key === key && item.status === "DISPATCH_PENDING");
        const executionRequestHash = sha256(executionRequest);
        if (this.mode === "EMPIRICAL_CALIBRATION" || this.executor?.durableIntentConformance === true)
          await archive.recordExecutionIntent({ attemptId, parameterSetHash: parameterHash, seed, request: executionRequest });
        const checkpoint = await archive.executionRecord(parameterHash, seed);
        if (checkpoint) {
          const context = checkpoint.execution_context ?? {};
          bundles.set(seed, checkpoint.bundle); observations.push(collectCalibrationObservations(checkpoint.bundle, {
            expectedParameterSet: parameterSet, expectedSeed: seed, ...archive.collectionOptions(checkpoint.bundle, context)
          })); continue;
        }
        let bundle, observation, executionContext = null, returnedExecution = null, classification = CALIBRATION_FAILURES.PARAMETER_FAILURE;
        try {
          if (this.mode === "EMPIRICAL_CALIBRATION") assertEmpiricalCapability(this.authorization, {
            archiveDirectory: this.directory, authorizationTrust: this.authorizationTrust,
            releaseDescriptor: this.releaseDescriptor, releaseTrust: this.releaseTrust, trustPolicy: this.trustPolicy,
            revocationRegistry: this.revocationRegistry, now: Date.now()
          });
          const execute = pendingIntent && typeof this.executor?.recover === "function"
            ? this.executor.recover.bind(this.executor)
            : typeof this.executor === "function" ? this.executor : this.executor.execute.bind(this.executor);
          assert(execute, "empirical adapter cannot recover a durable execution intent after restart");
          if (this.mode === "EMPIRICAL_CALIBRATION") assertEmpiricalCalibrationAuthorization(this.authorization, this.executor, {
            archiveDirectory: this.directory, authorizationTrust: this.authorizationTrust, releaseDescriptor: this.releaseDescriptor,
            releaseTrust: this.releaseTrust, trustPolicy: this.trustPolicy,
            revocationRegistry: this.revocationRegistry, now: Date.now()
          });
          const execution = await execute(executionRequest); returnedExecution = clone(execution);
          const packageDigest = loadedExecutionModules.get(this.executor)?.lastPackageDigest ?? null;
          bundle = execution?.bundle ?? execution;
          executionContext = { archive_export: execution?.archive_export ?? null,
            evidence_head_receipt: execution.evidence_head_receipt ?? null, adapter_execution_receipt: execution.adapter_execution_receipt ?? null,
            adapter_package_digest: packageDigest,
            execution_request: clone(executionRequest), execution_request_hash: executionRequestHash,
            expected_seed: seed, expected_parameter_set_hash: parameterHash };
          observation = collectCalibrationObservations(bundle, { expectedParameterSet: parameterSet, expectedSeed: seed,
            ...archive.collectionOptions(bundle, executionContext ?? {}) });
        }
        catch (error) {
          classification = calibrationFailureClassification(error, CALIBRATION_FAILURES.IMPLEMENTATION_DEFECT);
          const rawResult = error.calibrationRawResult ?? returnedExecution;
          const quarantined = rawResult === null ? null : await archive.quarantineAdapterResult({ attemptId,
            parameterSetHash: parameterHash, seed, result: rawResult });
          const failureEvidence = { classification, error_code: error.code ?? "CALIBRATION_IMPLEMENTATION_DEFECT",
            error_digest: sha256(String(error.message)), seed, parameter_set_hash: parameterHash,
            quarantined_adapter_result_ref: quarantined?.path ?? null, quarantined_adapter_result_hash: quarantined?.result_hash ?? null };
          const failureMetrics = {};
          const failure = { schema_version: MANIFEST_VERSION, tooling_version: CALIBRATION_TOOLING_VERSION, calibration_run_id: archive.state.calibration_run_id, attempt_id: attemptId,
            implementation_commit: BASELINE_COMMIT, implementation_tag: BASELINE_TAG,
            tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT,
            release_descriptor_hash: releaseBinding.descriptor_hash, protocol_version: protocol.protocol_version,
            specification_versions: baseline.specification_sha256,
            parameter_registry_version: registry.registry_version, parameter_set: parameterSet, parameter_set_hash: parameterHash,
            parameter_classifications: Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, entry.classification])),
            seed, seeds: [seed], execution_intent_id: executionRequest.idempotencyKey, execution_request_hash: executionRequestHash,
            rng_provenance_ref: `addressed-rng://${seed}`, policy_configuration: policyConfiguration,
            model_runtime_configuration: modelRuntimeConfiguration, runtime_environment: runtimeFingerprint(),
            canonical_evidence_ref: quarantined ? quarantined.path : `unavailable://${classification}`,
            metrics: failureMetrics, treatment_blinding: protocol.blinding.selection_view, failure_classification: classification, status: classification,
            stopping_rule_hash: sha256(protocol.stopping_rule), evidence_hashes: [sha256(failureEvidence)], metric_artifact_hash: sha256(canonicalize(failureMetrics) + "\n"),
            reason: `execution failed: ${classification}`, created_at: new Date(0).toISOString() };
          failure.attestation = attestCalibrationAttempt(failure, manifestAttestor);
          const incident = classification === CALIBRATION_FAILURES.BLINDING_BREACH ? calibrationProtocolIncident({
            disclosure: error.message, affectedDecision: attemptId, detectedAt: new Date(0).toISOString(), authority: archiveTrust.keyId
          }) : null;
          await archive.recordAttempt(failure, { evidence: failureEvidence, metrics: failureMetrics }, { incident });
          throw error;
        }
        bundle = await archive.recordEvidence({ attemptId, parameterSetHash: parameterHash, seed, bundle, executionContext });
        await this.fault("after_evidence_persisted", { parameter_set_hash: parameterHash, seed, attempt_id: attemptId });
        observations.push(observation); bundles.set(seed, bundle);
      }
      let rows, aggregate, assessment;
      const candidateManifests = [];
      try {
        rows = materializeCalibrationMetrics(observations);
        const aliasSecret = sign(null, Buffer.from(canonicalize({ purpose: "calibration-selector-aliases", calibration_run_id: archive.state.calibration_run_id })), archiveTrust.privateKey);
        const view = calibrationSelectionProjection(rows, parameterHash, { aliasSecret });
        const blindedAggregate = aggregateThroughSelectorProcess(view);
        aggregate = { parameter_set_hash: parameterHash, seed_ids: [...protocol.seed_panel.seeds].sort(),
          aggregate_metrics: blindedAggregate.aggregate_metrics, aggregate_status: blindedAggregate.aggregate_status,
          selector_proof: { candidate_alias: blindedAggregate.candidate_alias, seed_alias_count: blindedAggregate.seed_aliases.length } };
        assessment = assessCalibrationCandidate({ ...aggregate, ...panelDiagnostics(rows), changes_from_start: calibrationStructuralDistance(parameterSet) });
      } catch (error) {
        if (error instanceof CalibrationBlindingBreach)
          await archive.recordIncident({ disclosure: error.message, affectedDecision: parameterHash });
        throw error;
      }
      assessment.aggregate_metrics = aggregate.aggregate_metrics; assessment.aggregate_status = aggregate.aggregate_status;
      assessment.parameter_set = clone(parameterSet);
      const classification = assessment.accepted ? CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION : CALIBRATION_FAILURES.PARAMETER_FAILURE;
      for (const row of rows) {
        const attemptId = stableId("calibration-attempt", protocol.protocol_version, parameterHash, row.seed), key = `${parameterHash}:${row.seed}`;
        if (archive.state.completed_keys.includes(key)) { const saved = await archive.manifest(attemptId); manifests.push(saved); candidateManifests.push(saved); continue; }
        const intent = archive.state.execution_intents.find(item => item.key === `${parameterHash}:${row.seed}`);
        assert(intent?.request?.policyBinding?.assignment_hash, "calibration attempt lacks durable policy assignment binding");
        const attemptPolicyConfiguration = { ...clone(policyConfiguration),
          assignment_algorithm: intent.request.policyBinding.assignment_algorithm,
          assignment_hash: intent.request.policyBinding.assignment_hash };
        const attempt = {
          schema_version: MANIFEST_VERSION, tooling_version: CALIBRATION_TOOLING_VERSION, calibration_run_id: archive.state.calibration_run_id, attempt_id: attemptId,
          implementation_commit: BASELINE_COMMIT, implementation_tag: BASELINE_TAG,
          tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT,
          release_descriptor_hash: releaseBinding.descriptor_hash, protocol_version: protocol.protocol_version,
          specification_versions: baseline.specification_sha256,
          parameter_registry_version: registry.registry_version, parameter_set: parameterSet, parameter_set_hash: parameterHash,
          parameter_classifications: Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, entry.classification])),
          seed: row.seed, seeds: [row.seed],
          execution_intent_id: intent.request.idempotencyKey,
          execution_request_hash: intent.request_hash,
          rng_provenance_ref: `content://${row.rng_provenance_hash}`, policy_configuration: attemptPolicyConfiguration,
          model_runtime_configuration: modelRuntimeConfiguration,
          runtime_environment: { ...runtimeFingerprint(), package_lock_sha256: baseline.runtime.package_lock_sha256 }, canonical_evidence_ref: `content://${row.evidence_hash}`,
          metrics: row.metrics, metric_definition_registry_hash: row.metric_definition_registry_hash,
          evidence_trust_proof: row.trust_proof,
          treatment_blinding: protocol.blinding.selection_view, failure_classification: classification,
          status: classification, stopping_rule_hash: sha256(protocol.stopping_rule), evidence_hashes: [row.evidence_hash],
          metric_artifact_hash: sha256(canonicalize(row.metrics) + "\n"), reason: assessment.accepted ? "all frozen thresholds pass" : "one or more frozen thresholds failed", created_at: new Date(0).toISOString()
        };
        attempt.attestation = attestCalibrationAttempt(attempt, manifestAttestor);
        verifyCalibrationAttestation(attempt, attempt.attestation, { [manifestAttestor.keyId]: manifestAttestor.publicKey });
        const manifest = await archive.recordAttempt(attempt, { evidence: bundles.get(row.seed), metrics: row.metrics });
        manifests.push(manifest); candidateManifests.push(manifest);
      }
      let candidateRecord = await archive.candidate(parameterHash);
      if (!candidateRecord) candidateRecord = {
        schema_version: "1.0.0", tooling_version: CALIBRATION_TOOLING_VERSION, specification_versions: baseline.specification_sha256,
        attestation_scope: "COMPLETE_PARAMETER_VECTOR", calibration_run_id: archive.state.calibration_run_id,
        attempt_id: stableId("calibration-candidate", protocol.protocol_version, parameterHash), implementation_commit: BASELINE_COMMIT,
        implementation_tag: BASELINE_TAG, tooling_distribution_digest: calibrationToolingDistributionDigest(),
        baseline_tag_commit: BASELINE_COMMIT, release_descriptor_hash: releaseBinding.descriptor_hash,
        protocol_version: protocol.protocol_version, parameter_registry_version: registry.registry_version,
        parameter_set: clone(parameterSet), parameter_set_hash: parameterHash, seeds: [...protocol.seed_panel.seeds],
        operation: clone(operation), parent_parameter_set_hash: parentParameterHash, round, candidate_index: index,
        parameter_classifications: Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, entry.classification])),
        policy_configuration: { ...clone(policyConfiguration), assignment_algorithm: PHASE_A_POLICY_PACKAGE.assignment.algorithm,
          assignment_hashes: candidateManifests.map(manifest => manifest.policy_configuration.assignment_hash).sort() },
        model_runtime_configuration: modelRuntimeConfiguration, runtime_environment: runtimeFingerprint(),
        evidence_hashes: rows.map(row => row.evidence_hash).sort(), metric_artifact_hash: sha256(aggregate.aggregate_metrics),
        treatment_blinding: protocol.blinding.selection_view, stopping_rule_hash: sha256(protocol.stopping_rule),
        failure_classification: classification, manifest_refs: candidateManifests.map(manifest => ({ attempt_id: manifest.attempt_id, manifest_hash: sha256(manifest) })).sort((a, b) => a.attempt_id.localeCompare(b.attempt_id)),
        aggregate_metrics: aggregate.aggregate_metrics, aggregate_status: aggregate.aggregate_status,
        metric_definition_registry_hash: CALIBRATION_METRIC_DEFINITION_HASH, assessment: clone(assessment)
      };
      if (!candidateRecord.attestation) {
        candidateRecord.attestation = attestCalibrationAttempt(candidateRecord, manifestAttestor);
        verifyCalibrationAttestation(candidateRecord, candidateRecord.attestation, { [manifestAttestor.keyId]: manifestAttestor.publicKey });
        candidateRecord = await archive.recordCandidate(candidateRecord);
      }
      assessment.candidate_attestation_hash = sha256(candidateRecord);
      assessments.push(assessment);
      const admitted = !incumbentAssessment || betterCandidate(assessment, incumbentAssessment);
      await archive.update(state => {
        state.visited_parameter_set_hashes = [...new Set([...state.visited_parameter_set_hashes, parameterHash])];
        state.assessments = clone(assessments); state.search_cursor = { round, operation_index: operationIndex + 1, candidate_index: candidateIndex };
        if (admitted) state.incumbent_parameter_set_hash = parameterHash;
        state.round_improved = improvedThisRound || admitted;
        return state;
      });
      if (admitted) {
        incumbent = parameterSet; incumbentAssessment = assessment; improvedThisRound = true;
      }
      await this.fault("after_search_progress", { round, operation_index: operationIndex + 1, candidate_index: candidateIndex });
      }
      if (assessments.some(item => item.accepted)) break;
      if (!improvedThisRound) break;
    }
    const accepted = assessments.filter(item => item.accepted);
    const evaluatedSeeds = protocol.seed_panel.seeds.filter(seed => archive.state.completed_keys.some(key => key.endsWith(`:${seed}`)));
    if (!accepted.length || !qualifyingFrontierComplete) return { status: "PROTOCOL_SEARCH_EXHAUSTED",
      attempted_parameter_vectors: assessments.length, evaluated_seeds: evaluatedSeeds, stopping_rule_satisfied: false,
      failure_classification: CALIBRATION_FAILURES.PROTOCOL_VIOLATION,
      assessments };
    const completeManifests = await Promise.all(archive.state.attempts.map(item => archive.manifest(item.attempt_id)));
    const result = buildCalibrationResult({ candidates: assessments, manifests: completeManifests, protocolVersion: protocol.protocol_version,
      implementationCommit: BASELINE_COMMIT, incidents: archive.state.incidents, releaseDescriptorHash: releaseBinding.descriptor_hash,
      executionMode: this.mode, trustPolicyHash: this.mode === "EMPIRICAL_CALIBRATION"
        ? releaseBinding.deployment_trust_policy_hash : CALIBRATION_DEPLOYMENT_TRUST_POLICY_HASH });
    result.protocol_hash = PROTOCOL_HASH; result.parameter_registry_hash = REGISTRY_HASH;
    result.artifact_attestation = attestArtifact(result, result.result_type, archiveTrust);
    assertValidSchema(result, "calibration-result.schema.json");
    const selectedHash = result.selected_parameter_set_hash;
    const worldConfiguration = { schema_version: "1.0.0",
      status: this.mode === "SYNTHETIC_CONFORMANCE" ? "SYNTHETIC_CONFORMANCE_ONLY_NOT_A_WORLD_PROPOSAL" : "PROPOSED_NOT_RESEARCH_AUTHORIZED",
      execution_mode: this.mode,
      evidence_class: this.mode === "SYNTHETIC_CONFORMANCE" ? "SYNTHETIC_SOFTWARE_CONFORMANCE" : "EMPIRICAL_CALIBRATION_EVIDENCE",
      implementation_commit: BASELINE_COMMIT, implementation_tag: BASELINE_TAG, protocol_version: protocol.protocol_version,
      tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: BASELINE_COMMIT,
      release_descriptor_hash: releaseBinding.descriptor_hash,
      policy_package_id: PHASE_A_POLICY_PACKAGE.package_id,
      policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
      policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
      policy_assignment_hashes: clone(result.policy_assignment_hashes),
      protocol_hash: PROTOCOL_HASH, parameter_registry_hash: REGISTRY_HASH,
      parameter_set_hash: selectedHash, parameter_set: assessments.find(item => item.parameter_set_hash === selectedHash)?.parameter_set ?? null };
    worldConfiguration.artifact_attestation = attestArtifact(worldConfiguration, "PILOT_0_WORLD_CONFIGURATION", archiveTrust);
    assertValidSchema(worldConfiguration, "pilot0-world-configuration.schema.json");
    await archive.recordResult(result, worldConfiguration);
    return result;
  }
}

export const CALIBRATION_TOOLING_VERSION = "phase-a-calibration-tooling-1.0.0";
