import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildPhaseAAdapterPackage } from '../src/calibration-adapter-package.js';
import { canonicalize, sha256 } from '../src/core.js';
import { calibrationProtocol } from '../src/calibration.js';
import { parameterRegistry } from '../src/parameters.js';
import { PHASE_A_POLICY_MANIFEST, calibrationPolicyRequestBinding } from '../src/calibration-policy.js';
import { PHASE_A_MODEL_RUNTIME_LOCK } from '../src/calibration-runtime.js';
import { verifyArchiveTrust } from '../src/archive-trust.js';
import { CALIBRATION_MODEL_RUNTIME_LOCK_HASH, CALIBRATION_TOOLING_VERSION,
  calibrationKeyId, calibrationToolingDistributionDigest, loadCalibrationExecutionModule,
  materializeCalibrationRuntime, startingCalibrationParameterSet, verifyAdapterExecutionReceipt,
} from '../src/calibration-runner.js';

const BASELINE = '8f06baae4cda7d6fbd9d61924b5c615f4a45ba59';
const pem = (key, type = 'spki') => key.export({ type, format: 'pem' });
const signed = (body, pair) => ({ ...body, public_key: pem(pair.publicKey),
  signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString('base64') });

const startAuthority = ({ evidence, head, token }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL('./helpers/calibration-evidence-authority-server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, TEST_AUTH_TOKEN: token,
      TEST_EVIDENCE_PRIVATE_KEY: pem(evidence.privateKey, 'pkcs8'), TEST_HEAD_PRIVATE_KEY: pem(head.privateKey, 'pkcs8') },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let output = '';
  child.once('error', reject);
  child.once('exit', code => { if (code && !output) reject(new Error(`authority exited ${code}`)); });
  child.stdout.on('data', chunk => {
    output += chunk;
    const port = Number(output.trim());
    if (Number.isSafeInteger(port) && port > 0) resolve({ child, port });
  });
});

test('repository Phase A adapter package loads through signed isolated-worker authorization with exact external trust', { timeout: 120_000 }, async () => {
  const root = new URL('..', import.meta.url).pathname;
  const temporary = await mkdtemp(join(tmpdir(), 'phase-a-production-package-'));
  const packageRoot = join(temporary, 'package');
  try {
    const caKey = join(temporary, 'ca-key.pem'), caCertificate = join(temporary, 'ca-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCertificate,
      '-subj', '/CN=CivilizationLab Test CA', '-days', '1'], { stdio: 'ignore' });
    const declaration = await buildPhaseAAdapterPackage({ repositoryRoot: root, destination: packageRoot,
      evidenceAuthorityEndpoint: 'https://evidence-authority.invalid/v1/seal',
      evidenceAuthorityCaCertificate: caCertificate });
    assert.deepEqual(declaration.permissions.network, ['evidence-authority.invalid']);
    assert.deepEqual(declaration.permissions.environment, ['CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN']);
    assert.equal(JSON.stringify(declaration).includes('PRIVATE_KEY'), false);
    const entrypoint = join(packageRoot, declaration.entrypoint);
    const direct = (await import(`${pathToFileURL(entrypoint).href}?contract`)).calibrationAdapter;
    const release = generateKeyPairSync('ed25519'), authorization = generateKeyPairSync('ed25519');
    const archive = generateKeyPairSync('ed25519'), attestor = generateKeyPairSync('ed25519');
    const evidence = generateKeyPairSync('ed25519'), head = generateKeyPairSync('ed25519');
    const trustPolicy = { version: 'phase-a-deployment-trust-policy-1.0.0', status: 'PROVISIONED',
      approved_release_key_ids: [calibrationKeyId(release.publicKey)],
      approved_authorization_key_ids: [calibrationKeyId(authorization.publicKey)] };
    const packageDigest = sha256(declaration);
    const releaseBody = { version: 'phase-a-calibration-release-1.0.0', tooling_version: CALIBRATION_TOOLING_VERSION,
      tooling_distribution_digest: calibrationToolingDistributionDigest({ refresh: true }), baseline_tag: 'v0.1.0-pilot0',
      baseline_tag_commit: BASELINE, protocol_hash: sha256(calibrationProtocol()), parameter_registry_hash: sha256(parameterRegistry()),
      authorization_key_id: calibrationKeyId(authorization.publicKey), deployment_trust_policy_hash: sha256(trustPolicy),
      approved_adapter_package_digest: packageDigest };
    const releaseDescriptor = signed(releaseBody, release);
    const contract = direct.contract;
    const authorizationBody = { version: 'phase-a-empirical-authorization-1.0.0', mode: 'EMPIRICAL_CALIBRATION',
      implementation_commit: BASELINE, implementation_tag: 'v0.1.0-pilot0', tooling_version: CALIBRATION_TOOLING_VERSION,
      protocol_hash: sha256(calibrationProtocol()), parameter_registry_hash: sha256(parameterRegistry()),
      tooling_distribution_digest: releaseBody.tooling_distribution_digest, release_descriptor_hash: sha256(releaseDescriptor),
      baseline_tag_commit: BASELINE, execution_scope: 'PHASE_A_WORLD_CALIBRATION',
      seed_panel_hash: sha256(calibrationProtocol().seed_panel.seeds), max_turns: 20, not_before_ms: 0,
      expires_at_ms: Number.MAX_SAFE_INTEGER, model_runtime_lock_hash: CALIBRATION_MODEL_RUNTIME_LOCK_HASH,
      deployment_trust_policy_hash: sha256(trustPolicy), key_id: calibrationKeyId(authorization.publicKey),
      adapter_hash: sha256(contract), policy_manifest: PHASE_A_POLICY_MANIFEST,
      policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST), evidence_key_id: calibrationKeyId(evidence.publicKey),
      evidence_head_key_id: calibrationKeyId(head.publicKey), campaign_id: 'synthetic-worker-integration',
      archive_key_id: calibrationKeyId(archive.publicKey), calibration_run_id: 'synthetic-worker-integration-run',
      attestor_key_id: calibrationKeyId(attestor.publicKey), adapter_executable: declaration };
    const capability = signed(authorizationBody, authorization);
    const loaded = await loadCalibrationExecutionModule(entrypoint, capability, { now: 1,
      authorizationTrust: pem(authorization.publicKey), releaseDescriptor, releaseTrust: pem(release.publicKey), trustPolicy });
    assert.equal(loaded.contract.execute_sha256, contract.execute_sha256);
    assert.equal(loaded.contract.model_use_declared, false);
    assert.equal(loaded.contract.policy_manifest_hash, sha256(PHASE_A_POLICY_MANIFEST));
    assert.equal(loaded.contract.execution_recovery, 'IDEMPOTENT_RECOVER_BY_EXECUTION_INTENT');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('signed package finalizes and recovers through the exact isolated evidence-authority endpoint', { timeout: 240_000 }, async () => {
  const root = new URL('..', import.meta.url).pathname;
  const temporary = await mkdtemp(join(tmpdir(), 'phase-a-exact-authority-'));
  const packageRoot = join(temporary, 'package');
  const release = generateKeyPairSync('ed25519'), authorization = generateKeyPairSync('ed25519');
  const archive = generateKeyPairSync('ed25519'), attestor = generateKeyPairSync('ed25519');
  const evidence = generateKeyPairSync('ed25519'), head = generateKeyPairSync('ed25519');
  const token = 'synthetic-conformance-authority-token';
  const priorToken = process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
  let authority;
  try {
    authority = await startAuthority({ evidence, head, token });
    process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = token;
    const declaration = await buildPhaseAAdapterPackage({ repositoryRoot: root, destination: packageRoot,
      evidenceAuthorityEndpoint: `http://127.0.0.1:${authority.port}/seal`, workerTimeoutMs: 120_000,
      evidenceAuthorityTimeoutMs: 120_000, evidenceHeadPublicKey: pem(head.publicKey),
      allowInsecureLoopbackForConformance: true });
    const packageDigest = sha256(declaration);
    const entrypoint = join(packageRoot, declaration.entrypoint);
    const direct = (await import(`${pathToFileURL(entrypoint).href}?execute_contract`)).calibrationAdapter;
    const trustPolicy = { version: 'phase-a-deployment-trust-policy-1.0.0', status: 'PROVISIONED',
      approved_release_key_ids: [calibrationKeyId(release.publicKey)],
      approved_authorization_key_ids: [calibrationKeyId(authorization.publicKey)] };
    const releaseBody = { version: 'phase-a-calibration-release-1.0.0', tooling_version: CALIBRATION_TOOLING_VERSION,
      tooling_distribution_digest: calibrationToolingDistributionDigest({ refresh: true }), baseline_tag: 'v0.1.0-pilot0',
      baseline_tag_commit: BASELINE, protocol_hash: sha256(calibrationProtocol()), parameter_registry_hash: sha256(parameterRegistry()),
      authorization_key_id: calibrationKeyId(authorization.publicKey), deployment_trust_policy_hash: sha256(trustPolicy),
      approved_adapter_package_digest: packageDigest };
    const releaseDescriptor = signed(releaseBody, release);
    const authorizationBody = { version: 'phase-a-empirical-authorization-1.0.0', mode: 'EMPIRICAL_CALIBRATION',
      implementation_commit: BASELINE, implementation_tag: 'v0.1.0-pilot0', tooling_version: CALIBRATION_TOOLING_VERSION,
      protocol_hash: sha256(calibrationProtocol()), parameter_registry_hash: sha256(parameterRegistry()),
      tooling_distribution_digest: releaseBody.tooling_distribution_digest, release_descriptor_hash: sha256(releaseDescriptor),
      baseline_tag_commit: BASELINE, execution_scope: 'PHASE_A_WORLD_CALIBRATION',
      seed_panel_hash: sha256(calibrationProtocol().seed_panel.seeds), max_turns: 20, not_before_ms: 0,
      expires_at_ms: Number.MAX_SAFE_INTEGER, model_runtime_lock_hash: CALIBRATION_MODEL_RUNTIME_LOCK_HASH,
      deployment_trust_policy_hash: sha256(trustPolicy), key_id: calibrationKeyId(authorization.publicKey),
      adapter_hash: sha256(direct.contract), policy_manifest: PHASE_A_POLICY_MANIFEST,
      policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST), evidence_key_id: calibrationKeyId(evidence.publicKey),
      evidence_head_key_id: calibrationKeyId(head.publicKey), campaign_id: 'synthetic-exact-authority',
      archive_key_id: calibrationKeyId(archive.publicKey), calibration_run_id: 'synthetic-exact-authority-run',
      attestor_key_id: calibrationKeyId(attestor.publicKey), adapter_executable: declaration };
    const capability = signed(authorizationBody, authorization);
    const loaded = await loadCalibrationExecutionModule(entrypoint, capability, { now: 1,
      authorizationTrust: pem(authorization.publicKey), releaseDescriptor, releaseTrust: pem(release.publicKey), trustPolicy });
    const seed = calibrationProtocol().seed_panel.seeds[0];
    const parameterSet = startingCalibrationParameterSet();
    const calibrationRunId = authorizationBody.calibration_run_id;
    const attemptId = `synthetic-attempt-${sha256([seed, parameterSet]).slice(0, 16)}`;
    const executionRequest = { schema_version: 'phase-a-execution-request-1.0.0', mode: 'EMPIRICAL_CALIBRATION',
      calibrationRunId, attemptId, idempotencyKey: `synthetic-intent-${sha256([calibrationRunId, seed]).slice(0, 16)}`,
      seed, parameterSet, runtimeConfiguration: materializeCalibrationRuntime(parameterSet), maxTurns: 20,
      objectiveTerminalPredicates: parameterSet['world.termination.objective_predicates'],
      neutralPolicyManifest: PHASE_A_POLICY_MANIFEST, modelRuntimeLock: PHASE_A_MODEL_RUNTIME_LOCK,
      policyBinding: calibrationPolicyRequestBinding({ participant_ids: ['polity-1','polity-2','polity-3'], seed,
        seed_panel: calibrationProtocol().seed_panel.seeds }),
      adapterContractHash: sha256(loaded.contract), adapterPackageHash: packageDigest };
    // The production package is separately authorization-checked above. Execute
    // its identical export in-process here because the CI host applies a shorter
    // nested-child CPU ceiling than the signed 120-second worker deadline.
    const result = await direct.execute(executionRequest, { adapterPackageDigest: packageDigest });
    assert.equal(result.bundle.events.some(event => event.event_type === 'ModelInvocation'), false);
    assert.equal(result.bundle.events.filter(event => event.event_type === 'TurnResolved').length, 20);
    const trustedHead = result.evidence_head_receipt.body.head;
    const authenticated = verifyArchiveTrust(result.archive_export, { runId: result.bundle.run_id,
      publicKey: pem(evidence.publicKey), keyId: calibrationKeyId(evidence.publicKey), trustedHead });
    assert.equal(authenticated.status, 'COMPLETE');
    verifyAdapterExecutionReceipt(result.bundle, { adapter_execution_receipt: result.adapter_execution_receipt,
      execution_request: executionRequest, execution_request_hash: sha256(executionRequest), expected_seed: seed,
      expected_parameter_set_hash: sha256(parameterSet), adapter_package_digest: packageDigest },
    { headPublicKey: pem(head.publicKey), policyManifestHash: sha256(PHASE_A_POLICY_MANIFEST),
      adapterHash: sha256(loaded.contract), executableHash: packageDigest });
    assert.deepEqual(await direct.recover(structuredClone(executionRequest), { adapterPackageDigest: packageDigest }), result);
  } finally {
    authority?.child.kill('SIGTERM');
    if (priorToken === undefined) delete process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN;
    else process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN = priorToken;
    await rm(temporary, { recursive: true, force: true });
  }
});
