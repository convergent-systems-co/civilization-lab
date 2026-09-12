import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalize, sha256 } from '../src/core.js';
import { assertValidSchema } from '../src/schema.js';
import { calibrationProtocol } from '../src/calibration.js';
import { parameterRegistry } from '../src/parameters.js';
import { PHASE_A_POLICY_MANIFEST, PHASE_A_POLICY_PACKAGE, PHASE_A_POLICY_PACKAGE_HASH } from '../src/calibration-policy.js';
import { PHASE_A_MODEL_RUNTIME_LOCK_HASH } from '../src/calibration-runtime.js';
import { assertCalibrationRevocationStatus, calibrationKeyId } from '../src/calibration-runner.js';
import {
  AUTHORITY_ROLES,
  createCalibrationDeploymentArtifacts,
  provisionCalibrationAuthorities,
  writeCalibrationEvidenceAuthorityConfiguration
} from '../src/calibration-trust-provisioning.js';

const root = resolve(import.meta.dirname, '..');
const baseline = '8f06baae4cda7d6fbd9d61924b5c615f4a45ba59';
const toolingHead = 'abfd80144db2fd85549447cc5638fabfb70053ba';
const toolingImplementation = 'f00f30cd5763253e140925562ab5e340ef59046d';
const protocolPreparation = 'fd74a15291e98478264cc6565b196e1e8af0304e';

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'civilizationlab-trust-'));
  const privateDirectory = join(parent, 'private');
  const publicDirectory = join(parent, 'public');
  const archiveDirectory = join(parent, 'archive');
  await mkdir(archiveDirectory, { mode: 0o700 });
  const provisioned = await provisionCalibrationAuthorities({
    repositoryRoot: root,
    privateDirectory,
    publicDirectory,
    tls: { commonName: 'civilizationlab-phase-a.local', dnsNames: ['civilizationlab-phase-a.local', 'localhost'], ipAddresses: ['127.0.0.1'] },
    createdAt: '2026-09-11T12:00:00.000Z'
  });
  return { parent, privateDirectory, publicDirectory, archiveDirectory, provisioned };
}

test('provisions six distinct Ed25519 authorities and a local TLS identity without exposing secrets', async () => {
  const { privateDirectory, publicDirectory, provisioned } = await fixture();
  const canonicalPrivate = await realpath(privateDirectory), canonicalPublic = await realpath(publicDirectory);
  assert.deepEqual(Object.keys(provisioned.authorities).sort(), [...AUTHORITY_ROLES].sort());
  const ids = Object.values(provisioned.authorities).map(authority => authority.key_id);
  assert.equal(new Set(ids).size, 6);
  for (const [role, authority] of Object.entries(provisioned.authorities)) {
    assert.equal(calibrationKeyId(createPublicKey(await readFile(authority.public_key_path, 'utf8'))), authority.key_id, role);
    assert.equal((await stat(authority.private_key_path)).mode & 0o777, 0o600);
    assert.equal((await stat(authority.public_key_path)).mode & 0o777, 0o644);
    assert.ok(authority.private_key_path.startsWith(canonicalPrivate));
    assert.ok(authority.public_key_path.startsWith(canonicalPublic));
  }
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(provisioned.tls.ca_private_key_path)).mode & 0o777, 0o600);
  assert.equal((await stat(provisioned.tls.server_private_key_path)).mode & 0o777, 0o600);
  const server = new X509Certificate(await readFile(provisioned.tls.server_certificate_path));
  const ca = new X509Certificate(await readFile(provisioned.tls.ca_certificate_path));
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(server.checkHost('civilizationlab-phase-a.local'), 'civilizationlab-phase-a.local');
  assert.equal(server.checkHost('localhost'), 'localhost');
  assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(JSON.stringify(provisioned.public_manifest).includes('PRIVATE KEY'), false);
  assertValidSchema(provisioned.public_manifest, 'calibration-deployment-manifest.schema.json');
});

test('refuses private material inside the repository or a pre-existing output directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'civilizationlab-trust-refusal-'));
  await assert.rejects(provisionCalibrationAuthorities({ repositoryRoot: root,
    privateDirectory: join(root, 'forbidden-private-keys'), publicDirectory: join(parent, 'public') }), /outside the repository/);
  const existing = join(parent, 'existing'); await mkdir(existing, { mode: 0o700 });
  await assert.rejects(provisionCalibrationAuthorities({ repositoryRoot: root,
    privateDirectory: existing, publicDirectory: join(parent, 'public-2') }), /must not already exist/);
  const escape = join(parent, 'repository-link'); await symlink(root, escape);
  await assert.rejects(provisionCalibrationAuthorities({ repositoryRoot: root,
    privateDirectory: join(escape, 'escaped-private'), publicDirectory: join(parent, 'public-3') }), /outside the repository/);
});

test('generates schema-valid signed release and narrowly scoped Phase A capability bound to the complete distribution', async () => {
  const { archiveDirectory, provisioned } = await fixture();
  const protocol = calibrationProtocol(), registry = parameterRegistry();
  const adapterDeclaration = { entrypoint: 'adapter.mjs', files: { 'adapter.mjs': 'a'.repeat(64) },
    permissions: { child_process: false, environment: ['CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN'], fs_read: [], fs_write: [],
      network: ['civilizationlab-phase-a.local:9443'], worker: false, worker_timeout_ms: 120000 } };
  const adapterContract = { version: 'phase-a-production-adapter-1.0.0', mode: 'EMPIRICAL_CALIBRATION', treatment_neutral: true,
    model_use_declared: false, seed_panel_hash: sha256(protocol.seed_panel.seeds), max_turns: 20,
    policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST), policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    model_runtime_lock_hash: PHASE_A_MODEL_RUNTIME_LOCK_HASH, worker_timeout_ms: 120000,
    evidence_authority_timeout_ms: 15000, execution_recovery: 'IDEMPOTENT_RECOVER_BY_EXECUTION_INTENT',
    assignment_algorithm: PHASE_A_POLICY_PACKAGE.assignment.algorithm, evidence_authority: 'EXTERNAL_ISOLATED' };
  const artifacts = await createCalibrationDeploymentArtifacts({ repositoryRoot: root, provisioned,
    archiveDirectory, adapterDeclaration, adapterContract, evidenceEndpoint: 'https://civilizationlab-phase-a.local:9443/v1/execution-intents',
    campaignId: 'phase-a-world-calibration-2026-09', calibrationRunId: 'phase-a-campaign-primary',
    notBeforeMs: Date.parse('2026-09-11T00:00:00Z'), expiresAtMs: Date.parse('2026-10-11T00:00:00Z'),
    baselineCommit: baseline, baselineTag: 'v0.1.0-pilot0', protocolPreparationCommit: protocolPreparation,
    calibrationToolingCommit: toolingHead, calibrationToolingImplementationCommit: toolingImplementation });

  assertValidSchema(artifacts.trust_policy, 'calibration-deployment-trust-policy.schema.json');
  assertValidSchema(artifacts.release_descriptor, 'calibration-deployment-release.schema.json');
  assertValidSchema(artifacts.authorization_capability, 'calibration-deployment-capability.schema.json');
  assert.equal(artifacts.trust_policy.status, 'PROVISIONED');
  assert.equal(artifacts.release_descriptor.baseline_tag_commit, baseline);
  assert.equal(artifacts.release_descriptor.protocol_preparation_commit, protocolPreparation);
  assert.equal(artifacts.release_descriptor.calibration_tooling_commit, toolingHead);
  assert.equal(artifacts.release_descriptor.calibration_tooling_implementation_commit, toolingImplementation);
  assert.equal(artifacts.release_descriptor.event_catalogue_hash.length, 64);
  assert.equal(artifacts.release_descriptor.schema_distribution_hash.length, 64);
  assert.equal(artifacts.release_descriptor.policy_package_hash, PHASE_A_POLICY_PACKAGE_HASH);
  assert.equal(artifacts.release_descriptor.parameter_registry_hash, sha256(registry));
  assert.equal(artifacts.authorization_capability.execution_scope, 'PHASE_A_WORLD_CALIBRATION');
  assert.equal(artifacts.authorization_capability.max_turns, 20);
  assert.equal(artifacts.authorization_capability.policy_manifest.model_use_declared, false);
  assert.deepEqual(artifacts.authorization_capability.prohibited_scopes.toSorted(), [
    'CONFIRMATORY_RESEARCH', 'HUMAN_SESSIONS', 'ORGANIZATION_MECHANICS', 'PILOT_0_RESEARCH',
    'PERSISTENCE_TREATMENT_ANALYSIS', 'QWEN_ECOLOGICAL_VALIDATION', 'STATISTICAL_FREEZE_112'
  ].sort());
  assert.equal(artifacts.authorization_capability.archive_destination_hash, sha256(await realpath(archiveDirectory)));
  assert.equal(artifacts.authorization_capability.seed_panel_hash, sha256(protocol.seed_panel.seeds));
  assert.equal(artifacts.authorization_capability.parameter_domain_hash, sha256(protocol.parameter_domains));
  assert.ok(artifacts.authorization_capability.expires_at_ms > artifacts.authorization_capability.not_before_ms);
  assert.equal(artifacts.authorization_capability.revocation.status, 'NOT_REVOKED_AT_ISSUANCE');
  assert.throws(() => artifacts.authorization_capability.prohibited_scopes.sort(), TypeError);
  for (const [artifact, role] of [[artifacts.release_descriptor, 'release'], [artifacts.authorization_capability, 'calibration_authorization']]) {
    const body = structuredClone(artifact); delete body.signature; delete body.public_key;
    const key = createPublicKey(artifact.public_key);
    assert.equal(calibrationKeyId(key), provisioned.authorities[role].key_id);
    assert.equal(verify(null, Buffer.from(canonicalize(body)), key, Buffer.from(artifact.signature, 'base64')), true);
  }
  const authorizationTrust = await readFile(provisioned.authorities.calibration_authorization.public_key_path, 'utf8');
  assert.equal(assertCalibrationRevocationStatus(artifacts.authorization_capability, artifacts.revocations,
    authorizationTrust, provisioned.authorities.release.key_id), true);
  assert.throws(() => assertCalibrationRevocationStatus(artifacts.authorization_capability,
    { ...artifacts.revocations, signature: artifacts.revocations.signature.slice(0, -4) + 'AAAA' },
    authorizationTrust, provisioned.authorities.release.key_id), /binding mismatch|signature invalid/);
  const successorBody = { version: 'phase-a-revocation-registry-1.0.0', generation: 1,
    parent_registry_hash: sha256(artifacts.revocations),
    ancestor_registry_hashes: [sha256(artifacts.revocations)],
    generated_at: new Date(Date.parse(artifacts.authorization_capability.issued_at) + 1000).toISOString(),
    authority_key_id: artifacts.revocations.authority_key_id, revoked_key_ids: [],
    revoked_capability_hashes: [sha256(artifacts.authorization_capability)] };
  const authorizationPrivate = createPrivateKey(await readFile(
    provisioned.authorities.calibration_authorization.private_key_path));
  const successor = { ...successorBody, public_key: artifacts.revocations.public_key,
    signature: sign(null, Buffer.from(canonicalize(successorBody)), authorizationPrivate).toString('base64') };
  assertValidSchema(successor, 'calibration-deployment-revocations.schema.json');
  assert.throws(() => assertCalibrationRevocationStatus(artifacts.authorization_capability, successor,
    authorizationTrust, provisioned.authorities.release.key_id), /revoked/);
});

test('rejects expired, malformed, or authority-collapsed deployment requests', async () => {
  const { archiveDirectory, provisioned } = await fixture();
  const common = { repositoryRoot: root, provisioned, archiveDirectory,
    adapterDeclaration: { entrypoint: 'adapter.mjs', files: { 'adapter.mjs': 'a'.repeat(64) }, permissions: {} },
    adapterContract: { version: 'x' }, evidenceEndpoint: 'https://localhost:9443/v1/execution-intents', campaignId: 'campaign',
    calibrationRunId: 'run', baselineCommit: baseline, baselineTag: 'v0.1.0-pilot0', protocolPreparationCommit: protocolPreparation,
    calibrationToolingCommit: toolingHead, calibrationToolingImplementationCommit: toolingImplementation };
  await assert.rejects(createCalibrationDeploymentArtifacts({ ...common, notBeforeMs: 20, expiresAtMs: 10 }), /validity interval/);
  const collapsed = { ...provisioned, authorities: { ...provisioned.authorities,
    evidence_head: provisioned.authorities.evidence } };
  await assert.rejects(createCalibrationDeploymentArtifacts({ ...common, provisioned: collapsed, notBeforeMs: 10, expiresAtMs: 20 }), /distinct/);
  await assert.rejects(createCalibrationDeploymentArtifacts({ ...common, notBeforeMs: 10, expiresAtMs: 20,
    evidenceEndpoint: 'http://localhost:9443/v1/execution-intents' }), /HTTPS/);
  await assert.rejects(createCalibrationDeploymentArtifacts({ ...common, notBeforeMs: 10, expiresAtMs: 20,
    evidenceEndpoint: 'https://not-authorized.local:9443/v1/execution-intents' }), /TLS server identity/);
  await assert.rejects(createCalibrationDeploymentArtifacts({ ...common, notBeforeMs: 10, expiresAtMs: 20,
    calibrationToolingCommit: '0'.repeat(40) }), /ratified immutable/);
});

test('writes commit-safe public artifacts and keeps the signed capability owner-only', async () => {
  const { publicDirectory, privateDirectory } = await fixture();
  const artifacts = { release_descriptor: { public_key: 'PUBLIC', signature: 'signature' },
    authorization_capability: { public_key: 'PUBLIC', signature: 'signature' }, revocations: { revoked_key_ids: [] },
    schema_distribution: { 'example.schema.json': 'a'.repeat(64) }, trust_policy: { status: 'PROVISIONED' } };
  const { writeCalibrationDeploymentArtifacts } = await import('../src/calibration-trust-provisioning.js');
  const outputs = await writeCalibrationDeploymentArtifacts({ artifacts, publicDirectory, privateDirectory });
  for (const [name, path] of Object.entries(outputs)) {
    const expectedMode = name === 'authorization_capability' ? 0o600 : 0o644;
    assert.equal((await stat(path)).mode & 0o777, expectedMode);
    assert.equal((await readFile(path, 'utf8')).includes('PRIVATE KEY'), false);
  }
});

test('writes an owner-only evidence service credential/config and signed public runtime descriptor', async () => {
  const { parent, privateDirectory, provisioned } = await fixture();
  const storageDirectory = join(parent, 'evidence-storage');
  const result = await writeCalibrationEvidenceAuthorityConfiguration({ repositoryRoot: root, provisioned,
    evidenceEndpoint: 'https://127.0.0.1:9443/v1/execution-intents', storageDirectory,
    archiveDirectory: join(parent, 'archive'), revocationRegistry: { generation: 0,
      revoked_key_ids: [], revoked_capability_hashes: [] } });
  assert.equal((await stat(result.config_path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(privateDirectory, 'evidence-authority-credential.txt'))).mode & 0o777, 0o600);
  assert.equal((await stat(storageDirectory)).mode & 0o777, 0o700);
  const config = JSON.parse(await readFile(result.config_path, 'utf8'));
  assert.equal((await stat(join(config.trusted_head_directory, 'evidence-head-anchor.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(config.trusted_head_directory, 'calibration-revocation-anchor.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result.runtime_descriptor).includes(privateDirectory), false);
  assert.equal(result.runtime_descriptor.evidence_key_id, provisioned.authorities.evidence.key_id);
  assert.equal(result.runtime_descriptor.evidence_head_key_id, provisioned.authorities.evidence_head.key_id);
  assertValidSchema(result.runtime_descriptor, 'calibration-evidence-authority-runtime.schema.json');
  const body = structuredClone(result.runtime_descriptor); delete body.public_key; delete body.signature;
  assert.equal(verify(null, Buffer.from(canonicalize(body)), createPublicKey(result.runtime_descriptor.public_key),
    Buffer.from(result.runtime_descriptor.signature, 'base64')), true);
});
