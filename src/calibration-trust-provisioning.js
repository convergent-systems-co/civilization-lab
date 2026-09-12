import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync, randomBytes,
  sign
} from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, canonicalize, clone, sha256 } from './core.js';
import { assertValidSchema } from './schema.js';
import { calibrationProtocol } from './calibration.js';
import { parameterRegistry } from './parameters.js';
import { PHASE_A_POLICY_MANIFEST, PHASE_A_POLICY_PACKAGE, PHASE_A_POLICY_PACKAGE_HASH } from './calibration-policy.js';
import { PHASE_A_MODEL_RUNTIME_LOCK_HASH } from './calibration-runtime.js';
import { createEvidenceHeadAnchor, createRevocationAnchor } from './calibration-evidence-authority-service.js';
import {
  CALIBRATION_TOOLING_VERSION,
  calibrationKeyId,
  calibrationToolingDistributionManifest
} from './calibration-runner.js';

export const AUTHORITY_ROLES = Object.freeze([
  'release',
  'calibration_authorization',
  'archive',
  'attestation',
  'evidence',
  'evidence_head'
]);

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const FROZEN_REFERENCES = Object.freeze({
  baseline: '8f06baae4cda7d6fbd9d61924b5c615f4a45ba59',
  protocol_preparation: 'fd74a15291e98478264cc6565b196e1e8af0304e',
  calibration_tooling: 'abfd80144db2fd85549447cc5638fabfb70053ba',
  calibration_tooling_implementation: 'f00f30cd5763253e140925562ab5e340ef59046d'
});
const pemPublic = key => key.export({ type: 'spki', format: 'pem' });
const pemPrivate = key => key.export({ type: 'pkcs8', format: 'pem' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

function canonicalDestination(path) {
  const absolute = resolve(path), missing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, '..');
    assert(parent !== cursor, 'cannot resolve output destination');
    missing.unshift(relative(parent, cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

async function exclusiveDirectory(path, mode) {
  assert(!existsSync(path), `output directory must not already exist: ${path}`);
  await mkdir(path, { recursive: false, mode });
  await chmod(path, mode);
}

async function restrictiveWrite(path, bytes, mode) {
  await writeFile(path, bytes, { flag: 'wx', mode });
  await chmod(path, mode);
}

function openssl(args, label) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert(result.status === 0, `${label} failed; OpenSSL production TLS support is unavailable`);
}

async function createTlsIdentity({ privateDirectory, publicDirectory, commonName, dnsNames, ipAddresses }) {
  assert(typeof commonName === 'string' && commonName.length > 0, 'TLS common name required');
  assert(Array.isArray(dnsNames) && dnsNames.length > 0 && Array.isArray(ipAddresses), 'TLS SAN identities required');
  const caKey = join(privateDirectory, 'tls-ca-private.pem');
  const serverKey = join(privateDirectory, 'tls-server-private.pem');
  const csr = join(privateDirectory, 'tls-server.csr.pem');
  const extension = join(privateDirectory, 'tls-server.ext');
  const serial = join(privateDirectory, 'tls-ca.srl');
  const caCertificate = join(publicDirectory, 'tls-ca-certificate.pem');
  const serverCertificate = join(publicDirectory, 'tls-server-certificate.pem');
  // The authority roles are Ed25519. TLS uses RSA-3072 because the macOS
  // production-equivalent environment ships LibreSSL without Ed25519 keygen.
  openssl(['genrsa', '-out', caKey, '3072'], 'TLS CA private-key generation');
  await chmod(caKey, 0o600);
  openssl(['req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '397', '-subj', '/CN=CivilizationLab Phase A Local CA', '-out', caCertificate], 'TLS CA certificate generation');
  await chmod(caCertificate, 0o644);
  openssl(['genrsa', '-out', serverKey, '3072'], 'TLS server private-key generation');
  await chmod(serverKey, 0o600);
  openssl(['req', '-new', '-key', serverKey, '-subj', `/CN=${commonName}`, '-out', csr], 'TLS server request generation');
  await chmod(csr, 0o600);
  const san = [...new Set(dnsNames)].map((value, index) => `DNS.${index + 1}=${value}`)
    .concat([...new Set(ipAddresses)].map((value, index) => `IP.${index + 1}=${value}`));
  await restrictiveWrite(extension, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=@alt_names\n[alt_names]\n${san.join('\n')}\n`, 0o600);
  openssl(['x509', '-req', '-in', csr, '-CA', caCertificate, '-CAkey', caKey,
    '-CAserial', serial, '-CAcreateserial', '-days', '397', '-sha256', '-extfile', extension,
    '-out', serverCertificate], 'TLS server certificate signing');
  await chmod(serial, 0o600);
  await chmod(serverCertificate, 0o644);
  const certificate = new X509Certificate(await readFile(serverCertificate));
  assert(certificate.ca === false && certificate.checkHost(commonName) === commonName, 'generated TLS server identity failed verification');
  return Object.freeze({
    transport: 'HTTPS_PRODUCTION_EQUIVALENT_LOCAL',
    common_name: commonName,
    dns_names: [...new Set(dnsNames)].sort(),
    ip_addresses: [...new Set(ipAddresses)].sort(),
    ca_certificate_path: caCertificate,
    ca_certificate_sha256: digest(await readFile(caCertificate)),
    ca_private_key_path: caKey,
    server_certificate_path: serverCertificate,
    server_certificate_sha256: digest(await readFile(serverCertificate)),
    server_private_key_path: serverKey,
    not_after_ms: Date.parse(certificate.validTo)
  });
}

/**
 * Create fresh authority identities. The private destination must be an absent,
 * owner-controlled directory outside the repository. This function never logs or
 * returns private key bytes; callers receive paths so they can hand them directly
 * to the separately authorized services.
 */
export async function provisionCalibrationAuthorities({
  repositoryRoot,
  privateDirectory,
  publicDirectory,
  tls = { commonName: 'civilizationlab-phase-a.local', dnsNames: ['civilizationlab-phase-a.local', 'localhost'], ipAddresses: ['127.0.0.1'] },
  createdAt = new Date().toISOString()
}) {
  const repository = realpathSync(resolve(repositoryRoot));
  const privatePath = canonicalDestination(privateDirectory), publicPath = canonicalDestination(publicDirectory);
  assert(!inside(repository, privatePath), 'private trust material must remain outside the repository');
  assert(!inside(repository, publicPath), 'generated deployment output must be staged outside the repository');
  assert(privatePath !== publicPath && !inside(privatePath, publicPath) && !inside(publicPath, privatePath), 'private and public trust stores must be isolated');
  await exclusiveDirectory(privatePath, 0o700);
  await exclusiveDirectory(publicPath, 0o755);

  const authorities = {};
  for (const role of AUTHORITY_ROLES) {
    const pair = generateKeyPairSync('ed25519');
    const privateKeyPath = join(privatePath, `${role}-private.pem`);
    const publicKeyPath = join(publicPath, `${role}-public.pem`);
    await restrictiveWrite(privateKeyPath, pemPrivate(pair.privateKey), 0o600);
    await restrictiveWrite(publicKeyPath, pemPublic(pair.publicKey), 0o644);
    authorities[role] = Object.freeze({
      role,
      algorithm: 'Ed25519',
      key_id: calibrationKeyId(pair.publicKey),
      private_key_path: privateKeyPath,
      public_key_path: publicKeyPath,
      public_key_sha256: digest(await readFile(publicKeyPath)),
      created_at: createdAt,
      revocation_status: 'ACTIVE'
    });
  }
  assert(new Set(Object.values(authorities).map(authority => authority.key_id)).size === AUTHORITY_ROLES.length,
    'calibration authorities must use six distinct cryptographic identities');
  const tlsIdentity = await createTlsIdentity({ privateDirectory: privatePath, publicDirectory: publicPath, ...tls });
  const publicManifest = {
    schema_version: '1.0.0',
    deployment_class: 'PHASE_A_PRODUCTION_EQUIVALENT_LOCAL',
    created_at: createdAt,
    authorities: Object.fromEntries(AUTHORITY_ROLES.map(role => [role, {
      role,
      algorithm: 'Ed25519',
      key_id: authorities[role].key_id,
      public_key_file: `${role}-public.pem`,
      public_key_sha256: authorities[role].public_key_sha256,
      revocation_status: 'ACTIVE'
    }])),
    tls: {
      transport: tlsIdentity.transport,
      common_name: tlsIdentity.common_name,
      dns_names: tlsIdentity.dns_names,
      ip_addresses: tlsIdentity.ip_addresses,
      ca_certificate_file: 'tls-ca-certificate.pem',
      ca_certificate_sha256: tlsIdentity.ca_certificate_sha256,
      server_certificate_file: 'tls-server-certificate.pem',
      server_certificate_sha256: tlsIdentity.server_certificate_sha256
    }
  };
  publicManifest.deployment_id = sha256(publicManifest);
  assertValidSchema(publicManifest, 'calibration-deployment-manifest.schema.json');
  await restrictiveWrite(join(publicPath, 'calibration-deployment-manifest.json'), `${JSON.stringify(publicManifest, null, 2)}\n`, 0o644);
  return Object.freeze({ repository_root: repository, private_directory: privatePath, public_directory: publicPath,
    authorities: Object.freeze(authorities), tls: tlsIdentity, public_manifest: Object.freeze(publicManifest) });
}

function signArtifact(body, authority) {
  const privateKey = createPrivateKey(readFileSync(authority.private_key_path));
  const publicKey = readFileSync(authority.public_key_path, 'utf8');
  const signed = { ...body, public_key: publicKey,
    signature: sign(null, Buffer.from(canonicalize(body)), privateKey).toString('base64') };
  return deepFreeze(signed);
}

async function schemaDistribution(repositoryRoot) {
  const directory = resolve(repositoryRoot, 'schemas');
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name).sort();
  const manifest = {};
  for (const name of entries) manifest[name] = digest(await readFile(join(directory, name)));
  return Object.freeze(manifest);
}

function assertCommit(value, label) { assert(COMMIT.test(value), `${label} must be an immutable Git commit`); }
function assertProvisioned(provisioned) {
  assert(provisioned?.authorities && AUTHORITY_ROLES.every(role => provisioned.authorities[role]), 'all six authorities are required');
  const ids = AUTHORITY_ROLES.map(role => provisioned.authorities[role].key_id);
  assert(ids.every(id => HASH.test(id)) && new Set(ids).size === six(), 'authority identities must be pairwise distinct');
}
const six = () => AUTHORITY_ROLES.length;

export function calibrationTrustPolicyFor(provisioned) {
  assertProvisioned(provisioned);
  const policy = {
    version: 'phase-a-deployment-trust-policy-1.0.0',
    status: 'PROVISIONED',
    approved_release_key_ids: [provisioned.authorities.release.key_id],
    approved_authorization_key_ids: [provisioned.authorities.calibration_authorization.key_id]
  };
  assertValidSchema(policy, 'calibration-deployment-trust-policy.schema.json');
  return Object.freeze(policy);
}

function provisionedToolingDistribution(trustPolicy) {
  const manifest = { ...calibrationToolingDistributionManifest() };
  // The trust policy is the one distribution file intentionally transitioned
  // by provisioning. Compute the prospective immutable distribution before
  // signing, so the API cannot accidentally sign the old fail-closed bytes.
  manifest['config/calibration-trust-policy.json'] = digest(Buffer.from(`${JSON.stringify(trustPolicy, null, 2)}\n`));
  return Object.freeze(manifest);
}

/** Create commit-safe policy plus signed release and authorization artifacts. */
export async function createCalibrationDeploymentArtifacts({
  repositoryRoot,
  provisioned,
  archiveDirectory,
  adapterDeclaration,
  adapterContract,
  evidenceEndpoint,
  campaignId,
  calibrationRunId,
  notBeforeMs,
  expiresAtMs,
  baselineCommit,
  baselineTag,
  protocolPreparationCommit,
  calibrationToolingCommit,
  calibrationToolingImplementationCommit,
  predecessorFailedCampaign = null,
  issuedAt = new Date().toISOString()
}) {
  assert(realpathSync(resolve(repositoryRoot)) === realpathSync(resolve(import.meta.dirname, '..')),
    'deployment artifacts must bind this checked-out calibration distribution');
  assertProvisioned(provisioned);
  for (const [value, label] of [[baselineCommit, 'baseline commit'], [protocolPreparationCommit, 'protocol preparation commit'],
    [calibrationToolingCommit, 'calibration tooling commit'], [calibrationToolingImplementationCommit, 'calibration tooling implementation commit']]) assertCommit(value, label);
  assert(baselineCommit === FROZEN_REFERENCES.baseline && protocolPreparationCommit === FROZEN_REFERENCES.protocol_preparation &&
    calibrationToolingCommit === FROZEN_REFERENCES.calibration_tooling &&
    calibrationToolingImplementationCommit === FROZEN_REFERENCES.calibration_tooling_implementation,
  'deployment request differs from the ratified immutable Phase A references');
  assert(baselineTag === 'v0.1.0-pilot0', 'validated baseline tag mismatch');
  assert(Number.isSafeInteger(notBeforeMs) && Number.isSafeInteger(expiresAtMs) && expiresAtMs > notBeforeMs, 'authorization validity interval is invalid');
  assert(typeof campaignId === 'string' && campaignId.length > 0 && typeof calibrationRunId === 'string' && calibrationRunId.length > 0,
    'campaign and calibration run identifiers are required');
  if (predecessorFailedCampaign !== null) assert(predecessorFailedCampaign.reference_type === 'PREDECESSOR_FAILED_CAMPAIGN' &&
    predecessorFailedCampaign.disposition === 'FAILED_PRE_CALIBRATION_EXECUTION' &&
    predecessorFailedCampaign.parameter_vectors_successfully_evaluated === 0 &&
    predecessorFailedCampaign.calibration_seeds_completed === 0 &&
    canonicalize(predecessorFailedCampaign.imported_completed_keys) === '[]',
  'replacement campaign predecessor reference is malformed or imports failed results');
  const endpoint = new URL(evidenceEndpoint);
  assert(endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === '' && endpoint.hash === '', 'evidence authority requires an exact credential-free HTTPS endpoint');
  const serverCertificate = new X509Certificate(await readFile(provisioned.tls.server_certificate_path));
  const endpointIdentity = endpoint.hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(endpoint.hostname)
    ? serverCertificate.checkIP(endpoint.hostname) : serverCertificate.checkHost(endpoint.hostname);
  assert(endpointIdentity !== undefined, 'evidence endpoint is not covered by the provisioned TLS server identity');
  assert(expiresAtMs <= provisioned.tls.not_after_ms, 'authorization expires after the provisioned TLS identity');
  const archive = realpathSync(resolve(archiveDirectory));
  const archiveMetadata = await stat(archive);
  assert(archiveMetadata.isDirectory() && (archiveMetadata.mode & 0o077) === 0, 'archive must be an owner-only durable directory');

  const protocol = calibrationProtocol(), registry = parameterRegistry();
  const eventCatalogue = JSON.parse(await readFile(resolve(repositoryRoot, 'EVENT_CATALOGUE.spec.json'), 'utf8'));
  const schemas = await schemaDistribution(repositoryRoot);
  const trustPolicy = calibrationTrustPolicyFor(provisioned);
  const toolingDistribution = provisionedToolingDistribution(trustPolicy);
  const releaseBody = {
    version: 'phase-a-calibration-release-1.0.0',
    issued_at: issuedAt,
    tooling_version: CALIBRATION_TOOLING_VERSION,
    tooling_distribution_digest: sha256(toolingDistribution),
    tooling_distribution_manifest_hash: sha256(toolingDistribution),
    baseline_tag: baselineTag,
    baseline_tag_commit: baselineCommit,
    protocol_preparation_commit: protocolPreparationCommit,
    calibration_tooling_commit: calibrationToolingCommit,
    calibration_tooling_implementation_commit: calibrationToolingImplementationCommit,
    protocol_version: protocol.protocol_version,
    protocol_hash: sha256(protocol),
    parameter_registry_version: registry.registry_version,
    parameter_registry_hash: sha256(registry),
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    schema_distribution_hash: sha256(schemas),
    event_catalogue_version: eventCatalogue.catalogue_version,
    event_catalogue_hash: sha256(eventCatalogue),
    deployment_manifest_hash: sha256(provisioned.public_manifest),
    deployment_trust_policy_hash: sha256(trustPolicy),
    authorization_key_id: provisioned.authorities.calibration_authorization.key_id,
    approved_adapter_package_digest: sha256(adapterDeclaration)
  };
  const releaseDescriptor = signArtifact(releaseBody, provisioned.authorities.release);
  assertValidSchema(releaseDescriptor, 'calibration-deployment-release.schema.json');

  const revocationBody = { version: 'phase-a-revocation-registry-1.0.0', generation: 0, parent_registry_hash: null,
    ancestor_registry_hashes: [], generated_at: issuedAt,
    authority_key_id: provisioned.authorities.calibration_authorization.key_id,
    revoked_key_ids: [], revoked_capability_hashes: [] };
  const revocations = signArtifact(revocationBody, provisioned.authorities.calibration_authorization);
  assertValidSchema(revocations, 'calibration-deployment-revocations.schema.json');
  const capabilityBody = {
    version: 'phase-a-empirical-authorization-1.0.0',
    mode: 'EMPIRICAL_CALIBRATION',
    issued_at: issuedAt,
    implementation_commit: baselineCommit,
    implementation_tag: baselineTag,
    baseline_tag_commit: baselineCommit,
    tooling_version: CALIBRATION_TOOLING_VERSION,
    calibration_tooling_commit: calibrationToolingCommit,
    protocol_hash: sha256(protocol),
    parameter_registry_hash: sha256(registry),
    parameter_domain_hash: sha256(protocol.parameter_domains),
    tooling_distribution_digest: releaseBody.tooling_distribution_digest,
    release_descriptor_hash: sha256(releaseDescriptor),
    deployment_trust_policy_hash: sha256(trustPolicy),
    execution_scope: 'PHASE_A_WORLD_CALIBRATION',
    prohibited_scopes: ['PILOT_0_RESEARCH', 'QWEN_ECOLOGICAL_VALIDATION', 'HUMAN_SESSIONS',
      'PERSISTENCE_TREATMENT_ANALYSIS', 'CONFIRMATORY_RESEARCH', 'ORGANIZATION_MECHANICS', 'STATISTICAL_FREEZE_112'],
    seed_panel_hash: sha256(protocol.seed_panel.seeds),
    max_turns: 20,
    not_before_ms: notBeforeMs,
    expires_at_ms: expiresAtMs,
    revocation: { status: 'NOT_REVOKED_AT_ISSUANCE', registry_ref: 'calibration-revocations.json',
      registry_hash: sha256(revocations), checked_at_dispatch: true },
    model_runtime_lock_hash: PHASE_A_MODEL_RUNTIME_LOCK_HASH,
    key_id: provisioned.authorities.calibration_authorization.key_id,
    adapter_hash: sha256(adapterContract),
    policy_manifest: PHASE_A_POLICY_MANIFEST,
    policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST),
    evidence_key_id: provisioned.authorities.evidence.key_id,
    evidence_head_key_id: provisioned.authorities.evidence_head.key_id,
    archive_key_id: provisioned.authorities.archive.key_id,
    attestor_key_id: provisioned.authorities.attestation.key_id,
    evidence_endpoint: endpoint.href,
    archive_destination_hash: sha256(archive),
    campaign_id: campaignId,
    calibration_run_id: calibrationRunId,
    ...(predecessorFailedCampaign === null ? {} : { predecessor_failed_campaign: clone(predecessorFailedCampaign) }),
    adapter_executable: adapterDeclaration
  };
  const authorizationCapability = signArtifact(capabilityBody, provisioned.authorities.calibration_authorization);
  assertValidSchema(authorizationCapability, 'calibration-deployment-capability.schema.json');
  return deepFreeze({ trust_policy: trustPolicy, release_descriptor: releaseDescriptor,
    authorization_capability: authorizationCapability, schema_distribution: schemas, revocations });
}

/** Write public records separately from the bearer-like signed capability. */
export async function writeCalibrationDeploymentArtifacts({ artifacts, publicDirectory, privateDirectory, trustPolicyPath = null }) {
  const directory = realpathSync(resolve(publicDirectory));
  const privatePath = realpathSync(resolve(privateDirectory));
  assert(((await stat(privatePath)).mode & 0o077) === 0, 'capability store must be owner-only');
  const publicOutputs = [
    ['calibration-release-descriptor.json', artifacts.release_descriptor],
    ['calibration-revocations.json', artifacts.revocations],
    ['calibration-schema-distribution.json', artifacts.schema_distribution]
  ];
  for (const [name, value] of publicOutputs) {
    assert(!canonicalize(value).includes('PRIVATE KEY'), 'private material cannot enter public deployment artifacts');
    await restrictiveWrite(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 0o644);
  }
  const capabilityPath = join(privatePath, 'phase-a-authorization-capability.json');
  await restrictiveWrite(capabilityPath, `${JSON.stringify(artifacts.authorization_capability, null, 2)}\n`, 0o600);
  if (trustPolicyPath) await writeFile(resolve(trustPolicyPath), `${JSON.stringify(artifacts.trust_policy, null, 2)}\n`, { mode: 0o644 });
  return Object.freeze({ ...Object.fromEntries(publicOutputs.map(([name]) => [name, join(directory, name)])),
    authorization_capability: capabilityPath });
}

/** Provision the bearer credential and durable service configuration separately
 * from public deployment artifacts. No secret bytes or private paths are
 * returned in the public runtime descriptor. */
export async function writeCalibrationEvidenceAuthorityConfiguration({
  repositoryRoot, provisioned, evidenceEndpoint, storageDirectory, archiveDirectory, revocationRegistry = null
}) {
  assertProvisioned(provisioned);
  const repository = realpathSync(resolve(repositoryRoot));
  const storage = canonicalDestination(storageDirectory);
  assert(!inside(repository, storage), 'empirical evidence storage must remain outside the repository');
  if (!existsSync(storage)) await exclusiveDirectory(storage, 0o700);
  const storageMetadata = await stat(storage);
  assert(storageMetadata.isDirectory() && (storageMetadata.mode & 0o077) === 0,
    'empirical evidence storage must be owner-only');
  const endpoint = new URL(evidenceEndpoint);
  assert(endpoint.protocol === 'https:' && endpoint.pathname === '/v1/execution-intents' &&
    endpoint.username === '' && endpoint.password === '' && endpoint.hash === '' && endpoint.search === '',
  'evidence authority runtime requires the exact HTTPS API endpoint');
  const port = Number(endpoint.port || 443);
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'evidence authority endpoint port invalid');
  const certificate = new X509Certificate(await readFile(provisioned.tls.server_certificate_path));
  const endpointIdentity = /^\d+(?:\.\d+){3}$/.test(endpoint.hostname)
    ? certificate.checkIP(endpoint.hostname) : certificate.checkHost(endpoint.hostname);
  assert(endpointIdentity !== undefined, 'evidence authority endpoint identity is not certificate-authorized');

  const credentialPath = join(provisioned.private_directory, 'evidence-authority-credential.txt');
  await restrictiveWrite(credentialPath, randomBytes(32).toString('base64url') + '\n', 0o600);
  const authorityId = `phase-a-evidence-${provisioned.public_manifest.deployment_id.slice(0, 24)}`;
  const trustedHeadDirectory = join(provisioned.private_directory, 'evidence-head-anchor');
  await exclusiveDirectory(trustedHeadDirectory, 0o700);
  const initialAnchor = createEvidenceHeadAnchor({ authorityId,
    evidenceHeadPrivateKey: await readFile(provisioned.authorities.evidence_head.private_key_path), head: null });
  await restrictiveWrite(join(trustedHeadDirectory, 'evidence-head-anchor.json'), canonicalize(initialAnchor), 0o600);
  const revocations = revocationRegistry ?? JSON.parse(await readFile(
    join(provisioned.public_directory, 'calibration-revocations.json'), 'utf8'));
  assert(Number.isSafeInteger(revocations.generation) && revocations.generation === 0 &&
    Array.isArray(revocations.revoked_key_ids) && Array.isArray(revocations.revoked_capability_hashes),
  'initial signed revocation registry required for evidence authority configuration');
  const initialRevocationAnchor = createRevocationAnchor({ authorityId,
    evidenceHeadPrivateKey: await readFile(provisioned.authorities.evidence_head.private_key_path),
    registry: { generation: revocations.generation, registry_hash: sha256(revocations),
      revoked_key_ids: revocations.revoked_key_ids, revoked_capability_hashes: revocations.revoked_capability_hashes } });
  await restrictiveWrite(join(trustedHeadDirectory, 'calibration-revocation-anchor.json'),
    canonicalize(initialRevocationAnchor), 0o600);
  const config = {
    version: 'phase-a-production-evidence-authority-config-1.0.0',
    authority_id: authorityId,
    listen_host: endpoint.hostname,
    listen_port: port,
    storage_directory: storage,
    tls_certificate_path: provisioned.tls.server_certificate_path,
    tls_private_key_path: provisioned.tls.server_private_key_path,
    credential_path: credentialPath,
    evidence_private_key_path: provisioned.authorities.evidence.private_key_path,
    evidence_head_private_key_path: provisioned.authorities.evidence_head.private_key_path,
    trusted_head_directory: trustedHeadDirectory,
    archive_directory: realpathSync(resolve(archiveDirectory)),
    authorization_capability_path: join(provisioned.private_directory, 'phase-a-authorization-capability.json'),
    authorization_public_key_path: provisioned.authorities.calibration_authorization.public_key_path,
    release_descriptor_path: join(provisioned.public_directory, 'calibration-release-descriptor.json'),
    release_public_key_path: provisioned.authorities.release.public_key_path,
    revocation_registry_path: join(provisioned.public_directory, 'calibration-revocations.json'),
    trust_policy_path: join(repository, 'config', 'calibration-trust-policy.json')
  };
  assertValidSchema(config, 'calibration-evidence-authority-config.schema.json');
  const configPath = join(provisioned.private_directory, 'calibration-evidence-authority-config.json');
  await restrictiveWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const runtimeBody = {
    version: 'phase-a-evidence-authority-runtime-1.0.0',
    authority_id: config.authority_id,
    service_version: 'phase-a-production-evidence-authority-1.0.0',
    endpoint: endpoint.href,
    transport: 'HTTPS_PRODUCTION_EQUIVALENT_LOCAL',
    tls_ca_sha256: provisioned.tls.ca_certificate_sha256,
    tls_server_certificate_sha256: provisioned.tls.server_certificate_sha256,
    evidence_key_id: provisioned.authorities.evidence.key_id,
    evidence_head_key_id: provisioned.authorities.evidence_head.key_id,
    storage_class: 'OWNER_ONLY_DURABLE_EXTERNAL_ARCHIVE',
    credential_scheme: 'BEARER_256_BIT_EXTERNAL_SECRET',
    deployment_id: provisioned.public_manifest.deployment_id
  };
  const runtimeDescriptor = signArtifact(runtimeBody, provisioned.authorities.evidence);
  assertValidSchema(runtimeDescriptor, 'calibration-evidence-authority-runtime.schema.json');
  const runtimePath = join(provisioned.public_directory, 'calibration-evidence-authority-runtime.json');
  await restrictiveWrite(runtimePath, `${JSON.stringify(runtimeDescriptor, null, 2)}\n`, 0o644);
  return Object.freeze({ config_path: configPath, runtime_descriptor_path: runtimePath,
    runtime_descriptor: runtimeDescriptor });
}
