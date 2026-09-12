#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert, canonicalize, sha256 } from '../src/core.js';
import { calibrationProtocol } from '../src/calibration.js';
import { assertEmpiricalCapability, inspectCalibrationRevocationStatus,
  validateCalibrationParameterSet } from '../src/calibration-runner.js';
import { assertValidSchema } from '../src/schema.js';
import { createCalibrationEvidenceAuthority,
  createCalibrationEvidenceAuthorityHttpsServer,
  reconcileRevocationAnchor } from '../src/calibration-evidence-authority-service.js';

function usage() {
  return 'usage: node scripts/calibration-evidence-authority.js /absolute/path/to/deployment-config.json';
}

async function ownerOnly(path, label) {
  const value = await lstat(path);
  assert(value.isFile() && !value.isSymbolicLink() && (value.mode & 0o077) === 0, `${label} must be an owner-only regular file`);
  return readFile(path);
}

async function main() {
  assert(process.argv.length === 3, usage());
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse((await ownerOnly(configPath, 'authority deployment configuration')).toString('utf8'));
  assertValidSchema(config, 'calibration-evidence-authority-config.schema.json');
  const credential = (await ownerOnly(resolve(config.credential_path), 'authority credential')).toString('utf8').trim();
  const evidencePrivateKey = await ownerOnly(resolve(config.evidence_private_key_path), 'evidence private key');
  const evidenceHeadPrivateKey = await ownerOnly(resolve(config.evidence_head_private_key_path), 'evidence-head private key');
  const tlsPrivateKey = await ownerOnly(resolve(config.tls_private_key_path), 'TLS private key');
  const certificate = await readFile(resolve(config.tls_certificate_path));
  const authorizationCapability = JSON.parse((await ownerOnly(resolve(config.authorization_capability_path),
    'authorization capability')).toString('utf8'));
  const releaseDescriptor = JSON.parse(await readFile(resolve(config.release_descriptor_path), 'utf8'));
  const trustPolicy = JSON.parse(await readFile(resolve(config.trust_policy_path), 'utf8'));
  const authorizationTrust = await readFile(resolve(config.authorization_public_key_path), 'utf8');
  const releaseTrust = await readFile(resolve(config.release_public_key_path), 'utf8');
  const protocol = calibrationProtocol();
  const authorizationOptions = async () => ({ archiveDirectory: resolve(config.archive_directory), authorizationTrust,
    releaseDescriptor, releaseTrust, trustPolicy,
    revocationRegistry: JSON.parse(await readFile(resolve(config.revocation_registry_path), 'utf8')) });
  const assertCurrentAuthorization = async () => {
    // The fixed deployment path is reread for every pre-execution request so a
    // signed successor registry takes effect without service or package replacement.
    const options = await authorizationOptions();
    const registry = inspectCalibrationRevocationStatus(authorizationCapability,
      options.revocationRegistry, authorizationTrust);
    await reconcileRevocationAnchor({ trustedHeadDirectory: resolve(config.trusted_head_directory),
      authorityId: config.authority_id, evidenceHeadPrivateKey,
      registry: { ...registry, parent_registry_hash: registry.parent_registry_hash } });
    assertEmpiricalCapability(authorizationCapability, { ...options, now: Date.now() });
  };
  await assertCurrentAuthorization();
  const authorizeRequest = assertCurrentAuthorization;
  const authorizeFinalization = async input => {
    await assertCurrentAuthorization();
    const request = input?.request;
    assert(request?.schema_version === 'phase-a-execution-request-1.0.0' && request.mode === 'EMPIRICAL_CALIBRATION' &&
      request.calibrationRunId === authorizationCapability.calibration_run_id && request.maxTurns === 20 &&
      protocol.seed_panel.seeds.includes(request.seed), 'evidence finalization is outside the authorized campaign/seed/horizon');
    validateCalibrationParameterSet(request.parameterSet);
    assert(input.binding?.calibration_parameter_set_hash === sha256(request.parameterSet) &&
      input.binding?.policy_manifest_hash === authorizationCapability.policy_manifest_hash &&
      canonicalize(request.neutralPolicyManifest) === canonicalize(authorizationCapability.policy_manifest),
    'evidence finalization parameter/policy binding mismatch');
    const packageDigest = sha256(authorizationCapability.adapter_executable);
    assert(input.adapterHash === authorizationCapability.adapter_hash && input.adapterPackageDigest === packageDigest &&
      request.adapterContractHash === authorizationCapability.adapter_hash && request.adapterPackageHash === packageDigest,
    'evidence finalization adapter authorization mismatch');
  };
  const authority = createCalibrationEvidenceAuthority({ directory: resolve(config.storage_directory), credential,
    evidencePrivateKey, evidenceHeadPrivateKey, authorityId: config.authority_id,
    trustedHeadDirectory: resolve(config.trusted_head_directory), authorizeRequest, authorizeFinalization });
  const service = createCalibrationEvidenceAuthorityHttpsServer({ authority, certificate, privateKey: tlsPrivateKey,
    host: config.listen_host, port: config.listen_port });
  const endpoint = await service.start();
  // This contains no credential or private-key material. Operators can bind the
  // exact HTTPS endpoint into the separately signed adapter package/release.
  process.stdout.write(JSON.stringify({ version: authority.version, authority_id: authority.authorityId,
    evidence_key_id: authority.evidenceKeyId, evidence_head_key_id: authority.evidenceHeadKeyId, endpoint }) + '\n');
  const shutdown = async () => { await service.stop(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

main().catch(() => {
  // Fail closed without echoing paths, credentials, key material, request data,
  // or lower-level TLS diagnostics into shared process logs.
  process.stderr.write('production calibration evidence authority failed to initialize\n');
  process.exitCode = 1;
});
