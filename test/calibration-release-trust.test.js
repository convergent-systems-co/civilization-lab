import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalize, sha256 } from "../src/core.js";
import { parameterRegistry } from "../src/parameters.js";
import { calibrationProtocol } from "../src/calibration.js";
import { ACTION_CONTRACT_HASH } from "../src/contracts.js";
import { PHASE_A_POLICY_PACKAGE, PHASE_A_POLICY_PACKAGE_HASH } from "../src/calibration-policy.js";
import { assertCalibrationReleaseTrust, assertEmpiricalCalibrationAuthorization, CalibrationArchive, calibrationKeyId,
  calibrationToolingDistributionDigest, calibrationToolingDistributionManifest, resolvedCalibrationBaselineTag,
  CALIBRATION_TOOLING_VERSION, CALIBRATION_MODEL_RUNTIME_LOCK, CALIBRATION_MODEL_RUNTIME_LOCK_HASH,
  PhaseACalibrationRunner, panelDiagnostics, loadCalibrationExecutionModule, assertNeutralReplayCondition,
  assertSecureCalibrationArchiveDirectory, assertSecureCalibrationPrivateKeyPath } from "../src/calibration-runner.js";

const baseline = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const projectionContractHash = sha256(JSON.parse(readFileSync(new URL("../PROJECTION_POLICY.spec.json", import.meta.url), "utf8")));
const pem = key => key.export({ type: "spki", format: "pem" });
const signed = (body, pair) => ({ ...body, public_key: pem(pair.publicKey), signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString("base64") });
async function context() {
  const releasePair = generateKeyPairSync("ed25519"), authority = generateKeyPairSync("ed25519"),
    archivePair = generateKeyPairSync("ed25519"), attestorPair = generateKeyPairSync("ed25519"),
    evidencePair = generateKeyPairSync("ed25519"), evidenceHeadPair = generateKeyPairSync("ed25519");
  const protocol = calibrationProtocol();
  const trustPolicy = { version: "phase-a-deployment-trust-policy-1.0.0", status: "PROVISIONED",
    approved_release_key_ids: [calibrationKeyId(releasePair.publicKey)], approved_authorization_key_ids: [calibrationKeyId(authority.publicKey)] };
  const executeSource = 'async function execute() { throw new Error("MUST NEVER EXECUTE"); }';
  const recoverSource = 'async function recover() { throw new Error("MUST NEVER RECOVER"); }';
  const policyManifest = { version: "phase-a-neutral-policy-1.0.0", policy_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    policy_class: "SCRIPTED_HETEROGENEOUS_POLICY", treatment_neutral: true, treatment_allocation: "NONE",
    persistence_history_access: "NONE", treatment_labels_exposed: false, calibration_objectives_exposed: false,
    model_use_declared: false, context_contract_hash: projectionContractHash, action_contract_hash: ACTION_CONTRACT_HASH };
  const contract = { version: "phase-a-production-adapter-1.0.0", mode: "EMPIRICAL_CALIBRATION", treatment_neutral: true,
    model_use_declared: false, seed_panel_hash: sha256(protocol.seed_panel.seeds), max_turns: 20, execute_sha256: sha256(executeSource),
    policy_manifest_hash: sha256(policyManifest), model_runtime_lock_hash: CALIBRATION_MODEL_RUNTIME_LOCK_HASH,
    execution_recovery: "IDEMPOTENT_RECOVER_BY_EXECUTION_INTENT", policy_package_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_package_version: PHASE_A_POLICY_PACKAGE.package_version, policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    worker_timeout_ms: 5000, evidence_authority_timeout_ms: 1000 };
  const directory = await mkdtemp(join(tmpdir(), "calibration-adapter-preflight-")), modulePath = join(directory, "adapter.mjs");
  const source = `${executeSource}\n${recoverSource}\nexport const calibrationAdapter = { contract: ${JSON.stringify(contract)}, execute, recover };\n`;
  await writeFile(modulePath, source);
  await mkdir(join(directory, "config"));
  const authorityCaBytes = "-----BEGIN CERTIFICATE-----\nSYNTHETIC-CONFORMANCE-ONLY\n-----END CERTIFICATE-----\n";
  const authorityCaHash = createHash("sha256").update(authorityCaBytes).digest("hex");
  const authorityConfigBytes = JSON.stringify({ version: "phase-a-evidence-authority-client-1.1.0",
    request_version: "phase-a-evidence-authority-request-1.1.0", endpoint: "https://evidence-authority.invalid/v1/execution-intents",
    request_timeout_ms: 1000, worker_timeout_ms: 5000, transport: "HTTPS_PRODUCTION",
    tls_ca_resource: "config/calibration-evidence-authority-ca.pem", tls_ca_sha256: authorityCaHash }) + "\n";
  await writeFile(join(directory, "config/calibration-evidence-authority.json"), authorityConfigBytes);
  await writeFile(join(directory, "config/calibration-evidence-authority-ca.pem"), authorityCaBytes);
  const declaration = { entrypoint: "adapter.mjs", files: {
    "adapter.mjs": createHash("sha256").update(source).digest("hex"),
    "config/calibration-evidence-authority.json": createHash("sha256").update(authorityConfigBytes).digest("hex"),
    "config/calibration-evidence-authority-ca.pem": authorityCaHash },
    permissions: { child_process: false, environment: ["CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN"], fs_read: [], fs_write: [],
      network: ["evidence-authority.invalid"], worker: false, worker_timeout_ms: 5000 } };
  const releaseBody = { version: "phase-a-calibration-release-1.0.0", tooling_version: CALIBRATION_TOOLING_VERSION,
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag: "v0.1.0-pilot0", baseline_tag_commit: baseline,
    protocol_hash: sha256(protocol), parameter_registry_hash: sha256(parameterRegistry()), authorization_key_id: calibrationKeyId(authority.publicKey),
    deployment_trust_policy_hash: sha256(trustPolicy), approved_adapter_package_digest: sha256(declaration) };
  const releaseDescriptor = signed(releaseBody, releasePair);
  const body = { version: "phase-a-empirical-authorization-1.0.0", mode: "EMPIRICAL_CALIBRATION", implementation_commit: baseline,
    implementation_tag: "v0.1.0-pilot0", tooling_version: CALIBRATION_TOOLING_VERSION, protocol_hash: sha256(protocol),
    parameter_registry_hash: sha256(parameterRegistry()), tooling_distribution_digest: releaseBody.tooling_distribution_digest,
    release_descriptor_hash: sha256(releaseDescriptor), baseline_tag_commit: baseline, execution_scope: "PHASE_A_WORLD_CALIBRATION",
    seed_panel_hash: sha256(protocol.seed_panel.seeds), max_turns: 20, not_before_ms: 0, expires_at_ms: Number.MAX_SAFE_INTEGER,
    model_runtime_lock_hash: CALIBRATION_MODEL_RUNTIME_LOCK_HASH, deployment_trust_policy_hash: sha256(trustPolicy),
    key_id: calibrationKeyId(authority.publicKey), adapter_hash: sha256(contract),
    policy_manifest: policyManifest, policy_manifest_hash: sha256(policyManifest),
    evidence_key_id: calibrationKeyId(evidencePair.publicKey), evidence_head_key_id: calibrationKeyId(evidenceHeadPair.publicKey),
    campaign_id: "synthetic-authorization-preflight", archive_key_id: calibrationKeyId(archivePair.publicKey),
    calibration_run_id: "calibration-authorized-preflight", attestor_key_id: calibrationKeyId(attestorPair.publicKey),
    adapter_executable: declaration };
  const options = { now: 0, authorizationTrust: pem(authority.publicKey), releaseTrust: pem(releasePair.publicKey), releaseDescriptor, trustPolicy };
  const capability = signed(body, authority);
  const adapter = await loadCalibrationExecutionModule(modulePath, capability, options);
  return { releasePair, authority, archivePair, attestorPair, evidencePair, evidenceHeadPair, releaseBody, releaseDescriptor, adapter, body, capability, options, modulePath, source, trustPolicy };
}

function authorizeDeclaration(c, declaration, contract = c.adapter.contract, signer = c.authority) {
  const releaseBody = { ...c.releaseBody, approved_adapter_package_digest: sha256(declaration) };
  const releaseDescriptor = signed(releaseBody, c.releasePair);
  const body = { ...c.body, key_id: calibrationKeyId(signer.publicKey), adapter_hash: sha256(contract), adapter_executable: declaration,
    release_descriptor_hash: sha256(releaseDescriptor), deployment_trust_policy_hash: sha256(c.trustPolicy) };
  return { capability: signed(body, signer), options: { ...c.options, releaseDescriptor }, releaseDescriptor, body };
}

test("release hashes actual bytes of reducers, evidence, schemas, contracts, configuration and lockfile", () => {
  const manifest = calibrationToolingDistributionManifest();
  for (const file of ["src/world-resolution.js", "src/evidence.js", "src/replay.js", "src/calibration-runner.js", "config/pilot0-world.json", "package-lock.json", "schemas/calibration-metric-fact.schema.json"]) {
    const expected = createHash("sha256").update(readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex");
    assert.equal(manifest[file], expected, file);
  }
  assert.equal(calibrationToolingDistributionDigest(), sha256(manifest));
  assert.equal(resolvedCalibrationBaselineTag(), baseline);
});

test("calibration runtime lock binds complete Hugging Face model, tokenizer, runtime and source configuration", () => {
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.source, "huggingface");
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.model_kind, "base");
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.repository, CALIBRATION_MODEL_RUNTIME_LOCK.tokenizer_repository);
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.revision, CALIBRATION_MODEL_RUNTIME_LOCK.tokenizer_revision);
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.source_configuration_hash, sha256(CALIBRATION_MODEL_RUNTIME_LOCK.source_configuration));
  for (const field of ["model_artifact_hash", "tokenizer_hash", "runtime_hash", "runner_hash", "config_sha256", "backend", "dtype", "device", "quantization", "generation", "context_budget", "max_attempts", "attempt_timeout_ms"])
    assert.notEqual(CALIBRATION_MODEL_RUNTIME_LOCK[field], undefined, `missing runtime lock field: ${field}`);
  assert.deepEqual(CALIBRATION_MODEL_RUNTIME_LOCK.adapters, []);
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.dynamic_weights, false);
  assert.equal(CALIBRATION_MODEL_RUNTIME_LOCK.trust_remote_code, false);
});

test("neutral calibration replay accepts only state-only non-treatment conditions", () => {
  const condition = { condition_id: "neutral-policy-v1", memory: { mode: "state_only", persistence: "none" },
    identity: { persistence_treatment_policy: "none" }, declared_treatments: [], retry: { max_attempts: 2 } };
  assert.equal(assertNeutralReplayCondition(condition, "neutral-policy-v1"), condition);
  assert.throws(() => assertNeutralReplayCondition({ ...condition, memory: { mode: "bounded_log", persistence: "run" } }, "neutral-policy-v1"), /persistence treatment/);
  assert.throws(() => assertNeutralReplayCondition(condition, "different-policy"), /signed neutral policy/);
});

test("externally signed release binds actual distribution and resolved tag", async () => {
  const c = await context();
  assert.equal(assertCalibrationReleaseTrust(c.releaseDescriptor, c.options.releaseTrust, c.trustPolicy).tooling_distribution_digest, calibrationToolingDistributionDigest());
  for (const changes of [{ tooling_distribution_digest: "0".repeat(64) }, { baseline_tag_commit: "1".repeat(40) }, { protocol_hash: "2".repeat(64) }])
    assert.throws(() => assertCalibrationReleaseTrust(signed({ ...c.releaseBody, ...changes }, c.releasePair), c.options.releaseTrust, c.trustPolicy), /mismatch/);
  assert.throws(() => assertCalibrationReleaseTrust(c.releaseDescriptor, pem(generateKeyPairSync("ed25519").publicKey), c.trustPolicy), /pinned/);
});

test("direct library authorization requires separate release and authorization trust", async () => {
  const c = await context();
  assert.equal(assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, c.options).descriptor_hash, sha256(c.releaseDescriptor));
  for (const absent of ["releaseTrust", "releaseDescriptor", "authorizationTrust"])
    assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, { ...c.options, [absent]: null }), /trust|authority/);
  const substitute = generateKeyPairSync("ed25519");
  assert.throws(() => assertEmpiricalCalibrationAuthorization(signed({ ...c.body, key_id: calibrationKeyId(substitute.publicKey) }, substitute), c.adapter,
    { ...c.options, authorizationTrust: pem(substitute.publicKey) }), /trust roots|pinned deployment authority/);
  const collapsedRoles = signed({ ...c.body, evidence_key_id: c.body.archive_key_id }, c.authority);
  assert.throws(() => assertEmpiricalCalibrationAuthorization(collapsedRoles, c.adapter, c.options), /pairwise distinct/);
  const sameAuthorityPolicy = { ...c.trustPolicy, approved_authorization_key_ids: [calibrationKeyId(c.releasePair.publicKey)] };
  const sameReleaseBody = { ...c.releaseBody, authorization_key_id: calibrationKeyId(c.releasePair.publicKey),
    deployment_trust_policy_hash: sha256(sameAuthorityPolicy) };
  const sameReleaseDescriptor = signed(sameReleaseBody, c.releasePair);
  const sameBody = { ...c.body, key_id: calibrationKeyId(c.releasePair.publicKey),
    deployment_trust_policy_hash: sha256(sameAuthorityPolicy), release_descriptor_hash: sha256(sameReleaseDescriptor) };
  assert.throws(() => assertEmpiricalCalibrationAuthorization(signed(sameBody, c.releasePair), c.adapter, {
    ...c.options, authorizationTrust: pem(c.releasePair.publicKey), releaseTrust: pem(c.releasePair.publicKey),
    releaseDescriptor: sameReleaseDescriptor, trustPolicy: sameAuthorityPolicy }), /pairwise distinct/);
  await assert.rejects(new PhaseACalibrationRunner({ directory: "/must-not-be-created-calibration", mode: "EMPIRICAL_CALIBRATION",
    implementationCommit: baseline, executor: c.adapter, authorization: c.capability }).run(), /release trust/);
});

test("signed empirical authority fixes campaign and calibration run identity for archive lifetime", async () => {
  const c = await context(), directory = await realpath(await mkdtemp(join(tmpdir(), "calibration-run-binding-")));
  const archiveTrust = { privateKey: c.archivePair.privateKey, publicKey: c.archivePair.publicKey,
    keyId: c.body.archive_key_id, trustScope: "EMPIRICAL_ARCHIVE",
    releaseBinding: { descriptor_hash: sha256(c.releaseDescriptor) },
    attestationAuthority: { privateKey: c.attestorPair.privateKey, publicKey: c.attestorPair.publicKey,
      keyId: c.body.attestor_key_id },
    executionBinding: { authorization_hash: sha256(c.capability), authorization_key_id: c.body.key_id,
      campaign_id: c.body.campaign_id, calibration_run_id: c.body.calibration_run_id,
      attestor_key_id: c.body.attestor_key_id } };
  const archive = await new CalibrationArchive(directory, archiveTrust).initialize({
    protocolVersion: calibrationProtocol().protocol_version, implementationCommit: baseline,
    executionMode: "EMPIRICAL_CALIBRATION"
  });
  assert.equal(archive.state.calibration_run_id, c.body.calibration_run_id);
  assert.equal(archive.state.campaign_id, c.body.campaign_id);
  await assert.rejects(CalibrationArchive.open(directory, { ...archiveTrust,
    executionBinding: { ...archiveTrust.executionBinding, calibration_run_id: "replacement-run" } }),
  /authorization\/campaign binding mismatch/);
});

test("adapter code, export and pre-import authority are pinned independently of its claimed contract", async () => {
  const c = await context();
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, { contract: c.adapter.contract, execute: c.adapter.execute }, c.options), /executable/);
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, { contract: c.adapter.contract, execute() {} }, c.options), /executable/);
  await writeFile(c.modulePath, c.source + "\nthrow new Error('UNAUTHORIZED MODULE IMPORTED');\n");
  await assert.rejects(c.adapter.execute({}), /executable digest mismatch|adapter package changed/,
    "a package changed after load must fail before execution");
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, c.capability, c.options), /executable digest mismatch/);
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, c.options), /executable digest mismatch/);
  const tampered = { ...c.capability, adapter_executable: { entrypoint: "adapter.mjs", files: { "adapter.mjs": "0".repeat(64) } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, tampered, c.options), /release-approved digest|signature invalid/);
});

test("empirical adapter child processes fail closed without a descendant-constraining OS sandbox", async () => {
  const c = await context();
  const body = { ...c.body, adapter_executable: { ...c.body.adapter_executable,
    permissions: { ...c.body.adapter_executable.permissions, child_process: true } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(body, c.authority), c.options),
    /release-approved digest|descendant-constraining OS sandbox/);
});

test("empirical authorization expiry is rechecked immediately before adapter dispatch", async () => {
  const c = await context();
  const expiring = signed({ ...c.body, expires_at_ms: 1 }, c.authority);
  const adapter = await loadCalibrationExecutionModule(c.modulePath, expiring, { ...c.options, now: 0 });
  await assert.rejects(adapter.execute({}), /validity interval/);
});

test("signed worker deadline fails with a typed infrastructure status and recovery remains callable", async () => {
  const c = await context();
  const executeSource = 'async function execute() { const end = Date.now() + 3000; while (Date.now() < end) {} }';
  const recoverSource = 'async function recover() { return { bundle: { run_id: "recovered" }, archive_export: { ok: true }, evidence_head_receipt: { ok: true }, adapter_execution_receipt: { ok: true } }; }';
  const contract = { ...c.adapter.contract, execute_sha256: sha256(executeSource), worker_timeout_ms: 1000 };
  const source = `${executeSource}\n${recoverSource}\nexport const calibrationAdapter = { contract: ${JSON.stringify(contract)}, execute, recover };\n`;
  await writeFile(c.modulePath, source);
  const configBytes = JSON.stringify({ version: "phase-a-evidence-authority-client-1.1.0",
    request_version: "phase-a-evidence-authority-request-1.1.0", endpoint: "https://evidence-authority.invalid/v1/execution-intents",
    request_timeout_ms: 1000, worker_timeout_ms: 1000, transport: "HTTPS_PRODUCTION",
    tls_ca_resource: "config/calibration-evidence-authority-ca.pem",
    tls_ca_sha256: c.body.adapter_executable.files["config/calibration-evidence-authority-ca.pem"] }) + "\n";
  await writeFile(join(c.modulePath, "../config/calibration-evidence-authority.json"), configBytes);
  const declaration = { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(source).digest("hex"),
    "config/calibration-evidence-authority.json": createHash("sha256").update(configBytes).digest("hex"),
    "config/calibration-evidence-authority-ca.pem": c.body.adapter_executable.files["config/calibration-evidence-authority-ca.pem"] },
    permissions: { ...c.body.adapter_executable.permissions, worker_timeout_ms: 1000 } };
  const authorized = authorizeDeclaration(c, declaration, contract);
  const adapter = await loadCalibrationExecutionModule(c.modulePath, authorized.capability, authorized.options);
  await assert.rejects(adapter.execute({ intent: "synthetic-timeout" }), error =>
    error.code === "CALIBRATION_INFRASTRUCTURE_DEADLINE" && error.calibrationClassification === "INFRASTRUCTURE_FAILURE");
  assert.equal((await adapter.recover({ intent: "synthetic-timeout" })).bundle.run_id, "recovered");
});

test("isolated worker preserves closed typed failure classification without forwarding diagnostics or credentials", async () => {
  const c = await context();
  const priorToken = process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
  process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = "worker-boundary-credential-must-not-leak";
  try {
    for (const [code, classification] of [
      ["CALIBRATION_INFRASTRUCTURE_AUTHORITY", "INFRASTRUCTURE_FAILURE"],
      ["CALIBRATION_AUTHORITY_AUTHORIZATION", "PROTOCOL_VIOLATION"],
      ["CALIBRATION_AUTHORITY_PROTOCOL", "PROTOCOL_VIOLATION"],
      ["CALIBRATION_IMPLEMENTATION_DEFECT", "IMPLEMENTATION_DEFECT"]
    ]) {
      const executeSource = `async function execute() { const error = new Error("private transport diagnostic worker-boundary-credential-must-not-leak"); error.code = ${JSON.stringify(code)}; error.calibrationClassification = ${JSON.stringify(classification)}; throw error; }`;
      const recoverSource = 'async function recover() { return execute(); }';
      const contract = { ...c.adapter.contract, execute_sha256: sha256(executeSource) };
      const source = `${executeSource}\n${recoverSource}\nexport const calibrationAdapter = { contract: ${JSON.stringify(contract)}, execute, recover };\n`;
      await writeFile(c.modulePath, source);
      const declaration = { ...c.body.adapter_executable, files: { ...c.body.adapter_executable.files,
        "adapter.mjs": createHash("sha256").update(source).digest("hex") } };
      const authorized = authorizeDeclaration(c, declaration, contract);
      const adapter = await loadCalibrationExecutionModule(c.modulePath, authorized.capability, authorized.options);
      await assert.rejects(adapter.execute({ synthetic: true }), error => {
        assert.equal(error.code, code);
        assert.equal(error.calibrationClassification, classification);
        assert.equal(error.message.includes("private transport diagnostic"), false);
        assert.equal(error.message.includes("worker-boundary-credential-must-not-leak"), false);
        return true;
      });
    }
  } finally {
    if (priorToken === undefined) delete process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
    else process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = priorToken;
  }
});

test("evidence-authority transport classifications survive the complete client-worker-parent boundary", async () => {
  const c = await context();
  const priorToken = process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
  process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = "end-to-end-authority-secret";
  try {
    await mkdir(join(c.modulePath, "../src"));
    const dependencyNames = ["core.js", "calibration-errors.js", "calibration-evidence-authority-client.js"];
    const dependencyFiles = {};
    for (const name of dependencyNames) {
      const bytes = readFileSync(new URL(`../src/${name}`, import.meta.url));
      await writeFile(join(c.modulePath, `../src/${name}`), bytes);
      dependencyFiles[`src/${name}`] = createHash("sha256").update(bytes).digest("hex");
    }
    const executeSource = `async function execute(request) {
  const credential = request.scenario === "credential" ? () => { throw new Error("credential-resolution-private"); } : () => process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
  const fetchImplementation = async () => {
    if (["dns","connection","tls"].includes(request.scenario)) throw new TypeError(request.scenario + " private transport diagnostic");
    if (request.scenario === "http_auth") return { ok:false, status:401 };
    if (request.scenario === "http_service") return { ok:false, status:503 };
    if (request.scenario === "malformed") return { ok:true, status:200, async json() { throw new Error("malformed private response"); } };
    return { ok:true, status:200, async json() { return { execution_intent_id:"wrong" }; } };
  };
  const client = createEvidenceAuthorityClient({ configuration: authorityConfiguration, credential, fetchImplementation });
  return client.getIntent("typed-boundary-intent");
}`;
    const recoverSource = 'async function recover(request) { return execute(request); }';
    const contract = { ...c.adapter.contract, execute_sha256: sha256(executeSource) };
    const source = `import { createEvidenceAuthorityClient } from "./src/calibration-evidence-authority-client.js";\nconst authorityConfiguration = ${JSON.stringify({
      version: "phase-a-evidence-authority-client-1.1.0", request_version: "phase-a-evidence-authority-request-1.1.0",
      endpoint: "https://evidence-authority.invalid/v1/execution-intents", request_timeout_ms: 1000,
      worker_timeout_ms: 5000, transport: "HTTPS_PRODUCTION" })};\n${executeSource}\n${recoverSource}\nexport const calibrationAdapter = { contract: ${JSON.stringify(contract)}, execute, recover };\n`;
    await writeFile(c.modulePath, source);
    const declaration = { ...c.body.adapter_executable, files: { ...c.body.adapter_executable.files, ...dependencyFiles,
      "adapter.mjs": createHash("sha256").update(source).digest("hex") } };
    const authorized = authorizeDeclaration(c, declaration, contract);
    const adapter = await loadCalibrationExecutionModule(c.modulePath, authorized.capability, authorized.options);
    const expected = {
      dns: ["CALIBRATION_INFRASTRUCTURE_AUTHORITY", "INFRASTRUCTURE_FAILURE"],
      connection: ["CALIBRATION_INFRASTRUCTURE_AUTHORITY", "INFRASTRUCTURE_FAILURE"],
      tls: ["CALIBRATION_INFRASTRUCTURE_AUTHORITY", "INFRASTRUCTURE_FAILURE"],
      http_service: ["CALIBRATION_INFRASTRUCTURE_AUTHORITY", "INFRASTRUCTURE_FAILURE"],
      credential: ["CALIBRATION_AUTHORITY_AUTHORIZATION", "PROTOCOL_VIOLATION"],
      http_auth: ["CALIBRATION_AUTHORITY_AUTHORIZATION", "PROTOCOL_VIOLATION"],
      malformed: ["CALIBRATION_AUTHORITY_PROTOCOL", "PROTOCOL_VIOLATION"]
    };
    for (const [scenario, [code, classification]] of Object.entries(expected))
      await assert.rejects(adapter.execute({ scenario }), error => {
        assert.equal(error.code, code); assert.equal(error.calibrationClassification, classification);
        assert.equal(error.message.includes("private"), false);
        assert.equal(error.message.includes("end-to-end-authority-secret"), false);
        return true;
      });
  } finally {
    if (priorToken === undefined) delete process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
    else process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = priorToken;
  }
});

test("adapter imports cannot escape or bypass the signed executable package", async () => {
  const c = await context();
  const outside = join(c.modulePath, "..", "..", "outside-adapter-dependency.mjs");
  await writeFile(outside, "export const hidden = true;\n");
  const escapingSource = `import { hidden } from "../outside-adapter-dependency.mjs";\n${c.source}\nvoid hidden;\n`;
  await writeFile(c.modulePath, escapingSource);
  const escapingBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(escapingSource).digest("hex")
  } } };
  const escapingCapability = signed(escapingBody, c.authority);
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, escapingCapability, c.options), /release-approved digest|escapes the signed executable package/);

  const bareSource = `import "unlisted-runtime";\n${c.source}`;
  await writeFile(c.modulePath, bareSource);
  const bareBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(bareSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(bareBody, c.authority), c.options), /release-approved digest|bare-package imports/);

  const dynamicSource = `${c.source}\nexport async function hiddenLoad() { return import("node:fs"); }\n`;
  await writeFile(c.modulePath, dynamicSource);
  const dynamicBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(dynamicSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(dynamicBody, c.authority), c.options), /release-approved digest|dynamic adapter imports/);

  const commentBypassSource = `${c.source}\nexport async function hiddenLoad() { return import/*gap*/("node:fs"); }\n`;
  await writeFile(c.modulePath, commentBypassSource);
  const commentBypassBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(commentBypassSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(commentBypassBody, c.authority), c.options), /release-approved digest|dynamic adapter imports/);

  const externalReadBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable,
    permissions: { ...c.body.adapter_executable.permissions, fs_read: [outside] } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(externalReadBody, c.authority), c.options), /release-approved digest|mutable files outside/);

  const builtinBypass = `${c.source}\nexport function bypass() { return process.getBuiltinModule("fs"); }\n`;
  await writeFile(c.modulePath, builtinBypass);
  const bypassBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(builtinBypass).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(bypassBody, c.authority), c.options), /release-approved digest|code-loading bypass/);

  const commentedBuiltinBypass = `${c.source}\nexport function bypass() { return process/*gap*/.getBuiltinModule("fs"); }\n`;
  await writeFile(c.modulePath, commentedBuiltinBypass);
  const commentedBypassBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(commentedBuiltinBypass).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(commentedBypassBody, c.authority), c.options), /release-approved digest|code-loading bypass/);

  const bracketBuiltinBypass = `${c.source}\nexport function bypass() { return process["getBuiltinModule"]("fs"); }\n`;
  await writeFile(c.modulePath, bracketBuiltinBypass);
  const bracketBypassBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(bracketBuiltinBypass).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(bracketBypassBody, c.authority), c.options), /release-approved digest|code-loading bypass/);

  const computedBuiltinBypass = `${c.source}\nexport function bypass() { const key = "get" + "BuiltinModule"; return process[key]("fs"); }\n`;
  await writeFile(c.modulePath, computedBuiltinBypass);
  const computedDeclaration = { ...c.body.adapter_executable, files: { ...c.body.adapter_executable.files,
    "adapter.mjs": createHash("sha256").update(computedBuiltinBypass).digest("hex") } };
  const computed = authorizeDeclaration(c, computedDeclaration);
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, computed.capability, computed.options), /computed runtime code-loading bypass|code-loading bypass/);
});

test("signed adapters execute only inside the declared Node permission boundary", async () => {
  const c = await context();
  const deniedSource = `import { readFileSync } from "node:fs";\nreadFileSync("/etc/passwd");\n${c.source}`;
  await writeFile(c.modulePath, deniedSource);
  const deniedBody = { ...c.body, adapter_executable: { ...c.body.adapter_executable, files: {
    "adapter.mjs": createHash("sha256").update(deniedSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(deniedBody, c.authority), c.options), /release-approved digest|Access to this API has been restricted|isolated calibration adapter failed/);
});

test("no-model adapter permissions reject Hugging Face/cache environment and non-authority network access", async () => {
  const c = await context();
  for (const permissions of [
    { ...c.body.adapter_executable.permissions, environment: ["CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN", "HF_TOKEN"] },
    { ...c.body.adapter_executable.permissions, network: ["evidence-authority.invalid", "huggingface.co"] }
  ]) {
    const declaration = { ...c.body.adapter_executable, permissions };
    const authorized = authorizeDeclaration(c, declaration);
    await assert.rejects(loadCalibrationExecutionModule(c.modulePath, authorized.capability, authorized.options),
      /must be exactly the evidence authority token|must be exactly the signed evidence-authority endpoint/);
  }
});

test("archive and private signing-key paths fail closed on redirection, weak modes, and co-location", async () => {
  const root = await mkdtemp(join(tmpdir(), "calibration-path-isolation-"));
  const archive = join(root, "archive"), adapterDirectory = join(root, "adapter"), externalKey = join(root, "signing.pem");
  await Promise.all([mkdir(archive, { mode: 0o700 }), mkdir(adapterDirectory, { mode: 0o700 })]);
  const adapterPath = join(adapterDirectory, "adapter.mjs");
  await writeFile(adapterPath, "export {};\n");
  await writeFile(externalKey, "private fixture\n", { mode: 0o600 });
  assert.equal(assertSecureCalibrationArchiveDirectory(archive), await realpath(archive));
  assert.equal(assertSecureCalibrationPrivateKeyPath(externalKey, { archiveDirectory: archive, adapterPath }), await realpath(externalKey));
  await chmod(externalKey, 0o644);
  assert.throws(() => assertSecureCalibrationPrivateKeyPath(externalKey, { archiveDirectory: archive, adapterPath }), /restrictive/);
  await chmod(externalKey, 0o600);
  const linked = join(root, "linked-key.pem"); await symlink(externalKey, linked);
  assert.throws(() => assertSecureCalibrationPrivateKeyPath(linked, { archiveDirectory: archive, adapterPath }), /non-symlink/);
  const colocated = join(archive, "private.pem"); await writeFile(colocated, "private fixture\n", { mode: 0o600 });
  assert.throws(() => assertSecureCalibrationPrivateKeyPath(colocated, { archiveDirectory: archive, adapterPath }), /inside archive/);
});

test("seed diagnostics use independently calculated fixed-point population variance", () => {
  const metrics = calibrationProtocol().metrics;
  const normalizationWidth = metric => metric.acceptance.minimum !== undefined && metric.acceptance.maximum !== undefined
    ? metric.acceptance.maximum - metric.acceptance.minimum
    : Math.max(Math.abs(metric.acceptance.minimum ?? metric.acceptance.maximum ?? 1), 1);
  const rows = [0, 2].map(multiplier => ({ metrics: Object.fromEntries(metrics.map(metric =>
    [metric.metric_id, { value: multiplier * normalizationWidth(metric) }])) }));
  // Every dimension is normalized to [0, 2], hence each has population variance 1.
  assert.equal(panelDiagnostics(rows).cross_seed_metric_variance, 1);
  assert.deepEqual(panelDiagnostics(rows), panelDiagnostics([...rows].reverse()));
});
