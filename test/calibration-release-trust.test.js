import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalize, sha256 } from "../src/core.js";
import { parameterRegistry } from "../src/parameters.js";
import { calibrationProtocol } from "../src/calibration.js";
import { assertCalibrationReleaseTrust, assertEmpiricalCalibrationAuthorization, calibrationKeyId,
  calibrationToolingDistributionDigest, calibrationToolingDistributionManifest, resolvedCalibrationBaselineTag,
  CALIBRATION_TOOLING_VERSION, PhaseACalibrationRunner, panelDiagnostics, loadCalibrationExecutionModule } from "../src/calibration-runner.js";

const baseline = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const pem = key => key.export({ type: "spki", format: "pem" });
const signed = (body, pair) => ({ ...body, public_key: pem(pair.publicKey), signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString("base64") });
async function context() {
  const releasePair = generateKeyPairSync("ed25519"), authority = generateKeyPairSync("ed25519");
  const protocol = calibrationProtocol();
  const releaseBody = { version: "phase-a-calibration-release-1.0.0", tooling_version: CALIBRATION_TOOLING_VERSION,
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag: "v0.1.0-pilot0", baseline_tag_commit: baseline,
    protocol_hash: sha256(protocol), parameter_registry_hash: sha256(parameterRegistry()), authorization_key_id: calibrationKeyId(authority.publicKey) };
  const releaseDescriptor = signed(releaseBody, releasePair);
  const executeSource = 'async function execute() { throw new Error("MUST NEVER EXECUTE"); }';
  const policyManifest = { version: "phase-a-neutral-policy-1.0.0", policy_id: "synthetic-neutral-policy-v1",
    policy_class: "DETERMINISTIC_TEST_POLICY", treatment_neutral: true, treatment_allocation: "NONE",
    persistence_history_access: "NONE", treatment_labels_exposed: false, calibration_objectives_exposed: false,
    model_use_declared: false, context_contract_hash: "3".repeat(64), action_contract_hash: "4".repeat(64) };
  const contract = { version: "phase-a-production-adapter-1.0.0", mode: "EMPIRICAL_CALIBRATION", treatment_neutral: true,
    model_use_declared: false, seed_panel_hash: sha256(protocol.seed_panel.seeds), max_turns: 20, execute_sha256: sha256(executeSource),
    policy_manifest_hash: sha256(policyManifest) };
  const directory = await mkdtemp(join(tmpdir(), "calibration-adapter-preflight-")), modulePath = join(directory, "adapter.mjs");
  const source = `${executeSource}\nexport const calibrationAdapter = { contract: ${JSON.stringify(contract)}, execute };\n`;
  await writeFile(modulePath, source);
  const body = { version: "phase-a-empirical-authorization-1.0.0", mode: "EMPIRICAL_CALIBRATION", implementation_commit: baseline,
    implementation_tag: "v0.1.0-pilot0", tooling_version: CALIBRATION_TOOLING_VERSION, protocol_hash: sha256(protocol),
    parameter_registry_hash: sha256(parameterRegistry()), tooling_distribution_digest: releaseBody.tooling_distribution_digest,
    release_descriptor_hash: sha256(releaseDescriptor), baseline_tag_commit: baseline, execution_scope: "PHASE_A_WORLD_CALIBRATION",
    seed_panel_hash: sha256(protocol.seed_panel.seeds), max_turns: 20, not_before_ms: 0, expires_at_ms: 1,
    key_id: calibrationKeyId(authority.publicKey), adapter_hash: sha256(contract),
    policy_manifest: policyManifest, policy_manifest_hash: sha256(policyManifest),
    evidence_key_id: calibrationKeyId(authority.publicKey), evidence_head_key_id: calibrationKeyId(releasePair.publicKey),
    adapter_executable: { entrypoint: "adapter.mjs", files: { "adapter.mjs": createHash("sha256").update(source).digest("hex") } } };
  const options = { now: 0, authorizationTrust: pem(authority.publicKey), releaseTrust: pem(releasePair.publicKey), releaseDescriptor };
  const capability = signed(body, authority);
  const adapter = await loadCalibrationExecutionModule(modulePath, capability, options);
  return { releasePair, authority, releaseBody, releaseDescriptor, adapter, body, capability, options, modulePath, source };
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

test("externally signed release binds actual distribution and resolved tag", async () => {
  const c = await context();
  assert.equal(assertCalibrationReleaseTrust(c.releaseDescriptor, c.options.releaseTrust).tooling_distribution_digest, calibrationToolingDistributionDigest());
  for (const changes of [{ tooling_distribution_digest: "0".repeat(64) }, { baseline_tag_commit: "1".repeat(40) }, { protocol_hash: "2".repeat(64) }])
    assert.throws(() => assertCalibrationReleaseTrust(signed({ ...c.releaseBody, ...changes }, c.releasePair), c.options.releaseTrust), /mismatch/);
  assert.throws(() => assertCalibrationReleaseTrust(c.releaseDescriptor, pem(generateKeyPairSync("ed25519").publicKey)), /pinned/);
});

test("direct library authorization requires separate release and authorization trust", async () => {
  const c = await context();
  assert.equal(assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, c.options).descriptor_hash, sha256(c.releaseDescriptor));
  for (const absent of ["releaseTrust", "releaseDescriptor", "authorizationTrust"])
    assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, { ...c.options, [absent]: null }), /trust|authority/);
  const substitute = generateKeyPairSync("ed25519");
  assert.throws(() => assertEmpiricalCalibrationAuthorization(signed({ ...c.body, key_id: calibrationKeyId(substitute.publicKey) }, substitute), c.adapter,
    { ...c.options, authorizationTrust: pem(substitute.publicKey) }), /pinned deployment authority/);
  await assert.rejects(new PhaseACalibrationRunner({ directory: "/must-not-be-created-calibration", mode: "EMPIRICAL_CALIBRATION",
    implementationCommit: baseline, executor: c.adapter, authorization: c.capability }).run(), /release trust/);
});

test("adapter code, export and pre-import authority are pinned independently of its claimed contract", async () => {
  const c = await context();
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, { contract: c.adapter.contract, execute: c.adapter.execute }, c.options), /executable/);
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, { contract: c.adapter.contract, execute() {} }, c.options), /executable/);
  await writeFile(c.modulePath, c.source + "\nthrow new Error('UNAUTHORIZED MODULE IMPORTED');\n");
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, c.capability, c.options), /executable digest mismatch/);
  assert.throws(() => assertEmpiricalCalibrationAuthorization(c.capability, c.adapter, c.options), /executable digest mismatch/);
  const tampered = { ...c.capability, adapter_executable: { entrypoint: "adapter.mjs", files: { "adapter.mjs": "0".repeat(64) } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, tampered, c.options), /signature invalid/);
});

test("adapter imports cannot escape or bypass the signed executable package", async () => {
  const c = await context();
  const outside = join(c.modulePath, "..", "..", "outside-adapter-dependency.mjs");
  await writeFile(outside, "export const hidden = true;\n");
  const escapingSource = `import { hidden } from "../outside-adapter-dependency.mjs";\n${c.source}\nvoid hidden;\n`;
  await writeFile(c.modulePath, escapingSource);
  const escapingBody = { ...c.body, adapter_executable: { entrypoint: "adapter.mjs", files: {
    "adapter.mjs": createHash("sha256").update(escapingSource).digest("hex")
  } } };
  const escapingCapability = signed(escapingBody, c.authority);
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, escapingCapability, c.options), /escapes the signed executable package/);

  const bareSource = `import "unlisted-runtime";\n${c.source}`;
  await writeFile(c.modulePath, bareSource);
  const bareBody = { ...c.body, adapter_executable: { entrypoint: "adapter.mjs", files: {
    "adapter.mjs": createHash("sha256").update(bareSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(bareBody, c.authority), c.options), /bare-package imports/);

  const dynamicSource = `${c.source}\nexport async function hiddenLoad() { return import("node:fs"); }\n`;
  await writeFile(c.modulePath, dynamicSource);
  const dynamicBody = { ...c.body, adapter_executable: { entrypoint: "adapter.mjs", files: {
    "adapter.mjs": createHash("sha256").update(dynamicSource).digest("hex")
  } } };
  await assert.rejects(loadCalibrationExecutionModule(c.modulePath, signed(dynamicBody, c.authority), c.options), /dynamic adapter imports/);
});

test("seed diagnostics use independently calculated fixed-point population variance", () => {
  const metrics = calibrationProtocol().metrics;
  const rows = [0, 2].map(value => ({ metrics: Object.fromEntries(metrics.map(m => [m.metric_id, { value }])) }));
  // Every component has mean 1 and population variance ((0-1)^2+(2-1)^2)/2 = 1.
  assert.equal(panelDiagnostics(rows).cross_seed_metric_variance, 1);
  assert.deepEqual(panelDiagnostics(rows), panelDiagnostics([...rows].reverse()));
});
