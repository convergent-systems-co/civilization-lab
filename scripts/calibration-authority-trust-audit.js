#!/usr/bin/env node
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assert, canonicalize, sha256 } from '../src/core.js';
import { assertEmpiricalCapability, calibrationKeyId } from '../src/calibration-runner.js';

const args = process.argv.slice(2), optionIndex = args.indexOf('--deployment-root');
assert(optionIndex >= 0 && args[optionIndex + 1] && !args[optionIndex + 1].startsWith('--'),
  'usage: calibration-authority-trust-audit --deployment-root ABSOLUTE_PATH');
const deployment = resolve(args[optionIndex + 1]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const publicPath = name => join(deployment, 'public', name);

const [capability, release, manifest, runtime, revocations, adapterConfiguration] = await Promise.all([
  json(join(deployment, 'private/phase-a-authorization-capability.json')),
  json(publicPath('calibration-release-descriptor.json')),
  json(publicPath('calibration-deployment-manifest.json')),
  json(publicPath('calibration-evidence-authority-runtime.json')),
  json(publicPath('calibration-revocations.json')),
  json(join(deployment, 'adapter-package/config/calibration-evidence-authority.json'))
]);
const policyPath = join(deployment, 'adapter-package/config/calibration-trust-policy.json');
const policy = await json(policyPath), policyBytes = await readFile(policyPath), keys = {};
assert(createHash('sha256').update(policyBytes).digest('hex') === capability.adapter_executable.files['config/calibration-trust-policy.json'],
  'deployment trust-policy snapshot is not signed by the adapter capability');
for (const [role, filename] of Object.entries({
  release: 'release-public.pem', authorization: 'calibration_authorization-public.pem',
  archive: 'archive-public.pem', attestation: 'attestation-public.pem', evidence: 'evidence-public.pem',
  evidence_head: 'evidence_head-public.pem'
})) keys[role] = await readFile(publicPath(filename), 'utf8');

assertEmpiricalCapability(capability, { archiveDirectory: join(deployment, 'archive'),
  authorizationTrust: keys.authorization, releaseDescriptor: release, releaseTrust: keys.release,
  trustPolicy: policy, revocationRegistry: revocations, historicalDistribution: true });

const fingerprints = Object.fromEntries(Object.entries(keys).map(([role, pem]) =>
  [role, calibrationKeyId(createPublicKey(pem))]));
for (const [role, manifestRole] of Object.entries({ release: 'release', authorization: 'calibration_authorization',
  archive: 'archive', attestation: 'attestation', evidence: 'evidence', evidence_head: 'evidence_head' })) {
  assert(manifest.authorities[manifestRole].key_id === fingerprints[role], `${role} manifest key mismatch`);
  assert(manifest.authorities[manifestRole].revocation_status === 'ACTIVE', `${role} manifest key is not active`);
  assert(manifest.authorities[manifestRole].public_key_sha256 === sha256(keys[role]), `${role} PEM digest mismatch`);
}
assert(policy.approved_release_key_ids.includes(fingerprints.release), 'release key absent from trust policy');
assert(policy.approved_authorization_key_ids.includes(fingerprints.authorization),
  'authorization key absent from trust policy');
assert(release.authorization_key_id === fingerprints.authorization, 'release authorization key mismatch');
assert(capability.key_id === fingerprints.authorization, 'capability authorization key mismatch');
assert(capability.evidence_key_id === fingerprints.evidence, 'capability evidence key mismatch');
assert(capability.evidence_head_key_id === fingerprints.evidence_head, 'capability evidence-head key mismatch');
assert(capability.archive_key_id === fingerprints.archive, 'capability archive key mismatch');
assert(capability.attestor_key_id === fingerprints.attestation, 'capability attestation key mismatch');
assert(runtime.evidence_key_id === fingerprints.evidence && runtime.evidence_head_key_id === fingerprints.evidence_head,
  'runtime authority key mismatch');
assert(runtime.deployment_id === manifest.deployment_id, 'runtime deployment identity mismatch');
assert(capability.evidence_endpoint === runtime.endpoint && runtime.endpoint === adapterConfiguration.endpoint,
  'authority endpoint mismatch');
assert(release.deployment_trust_policy_hash === sha256(policy) &&
  capability.deployment_trust_policy_hash === sha256(policy), 'trust-policy digest mismatch');

const [caPem, serverPem] = await Promise.all([
  readFile(publicPath(manifest.tls.ca_certificate_file), 'utf8'),
  readFile(publicPath(manifest.tls.server_certificate_file), 'utf8')
]);
assert(manifest.tls.ca_certificate_sha256 === sha256(caPem), 'TLS CA digest mismatch');
assert(manifest.tls.server_certificate_sha256 === sha256(serverPem), 'TLS server certificate digest mismatch');
assert(adapterConfiguration.tls_ca_sha256 === sha256(caPem) && runtime.tls_ca_sha256 === sha256(caPem),
  'TLS CA client/runtime binding mismatch');
assert(runtime.tls_server_certificate_sha256 === sha256(serverPem), 'TLS runtime server binding mismatch');
const ca = new X509Certificate(caPem), server = new X509Certificate(serverPem);
assert(server.verify(ca.publicKey), 'TLS server certificate is not signed by the configured CA');
for (const name of manifest.tls.dns_names) assert(server.checkHost(name), `TLS DNS identity mismatch: ${name}`);
for (const address of manifest.tls.ip_addresses) assert(server.checkIP(address), `TLS IP identity mismatch: ${address}`);

console.log(canonicalize({ status: 'PASS', deployment_id: manifest.deployment_id,
  campaign_id: capability.campaign_id, calibration_run_id: capability.calibration_run_id,
  authority_id: runtime.authority_id, endpoint: runtime.endpoint, trust_policy_hash: sha256(policy), fingerprints,
  tls: { ca_sha256: sha256(caPem), server_certificate_sha256: sha256(serverPem),
    dns_names: manifest.tls.dns_names, ip_addresses: manifest.tls.ip_addresses, verified: true },
  private_material_emitted: false }));
