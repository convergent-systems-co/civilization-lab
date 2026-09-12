#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPhaseAProductionAdapter } from '../src/calibration-production-adapter.js';
import { buildPhaseAAdapterPackage } from '../src/calibration-adapter-package.js';
import { loadCalibrationExecutionModule } from '../src/calibration-runner.js';
import {
  calibrationTrustPolicyFor,
  createCalibrationDeploymentArtifacts,
  provisionCalibrationAuthorities,
  writeCalibrationEvidenceAuthorityConfiguration,
  writeCalibrationDeploymentArtifacts
} from '../src/calibration-trust-provisioning.js';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const required = name => {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const integer = name => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

let trustPolicyRollback = null;
try {
  if ((args[0] ?? 'provision') !== 'provision') throw new Error('only the provision command is supported');
  const repositoryRoot = resolve(option('--repository-root') ?? resolve(import.meta.dirname, '..'));
  const privateDirectory = resolve(required('--private-dir'));
  const publicDirectory = resolve(required('--public-dir'));
  const archiveDirectory = resolve(required('--archive-dir'));
  const adapterPackageDirectory = resolve(required('--adapter-package-dir'));
  const evidenceEndpoint = required('--evidence-endpoint');
  const evidenceStorageDirectory = resolve(required('--evidence-storage-dir'));
  const trustPolicyPath = resolve(required('--trust-policy-path'));
  const expectedPolicyPath = resolve(repositoryRoot, 'config/calibration-trust-policy.json');
  if (trustPolicyPath !== expectedPolicyPath) throw new Error('--trust-policy-path must identify the distribution-pinned calibration trust policy');

  const provisioned = await provisionCalibrationAuthorities({ repositoryRoot, privateDirectory, publicDirectory,
    tls: { commonName: option('--tls-common-name') ?? 'civilizationlab-phase-a.local',
      dnsNames: (option('--tls-dns-names') ?? 'civilizationlab-phase-a.local,localhost').split(',').filter(Boolean),
      ipAddresses: (option('--tls-ip-addresses') ?? '127.0.0.1').split(',').filter(Boolean) } });

  // The public key allowlist is written before package/digest creation so both
  // the signed package and release digest bind the provisioned policy bytes.
  const trustPolicy = calibrationTrustPolicyFor(provisioned);
  trustPolicyRollback = { path: trustPolicyPath, bytes: await readFile(trustPolicyPath) };
  await writeFile(trustPolicyPath, `${JSON.stringify(trustPolicy, null, 2)}\n`, { mode: 0o644 });
  const adapterDeclaration = await buildPhaseAAdapterPackage({ repositoryRoot, destination: adapterPackageDirectory,
    evidenceAuthorityEndpoint: evidenceEndpoint,
    evidenceAuthorityCaCertificate: provisioned.tls.ca_certificate_path,
    workerTimeoutMs: integer('--worker-timeout-ms'),
    evidenceAuthorityTimeoutMs: integer('--evidence-timeout-ms') });
  const adapterContract = createPhaseAProductionAdapter({ executionMode: 'EMPIRICAL_CALIBRATION',
    journal: { durable: true, async get() { return null; }, async put() {} },
    evidenceAuthority: { trustDomain: 'EXTERNAL_EVIDENCE_AUTHORITY', async finalize() { throw new Error('provisioning does not execute evidence'); } },
    workerTimeoutMs: integer('--worker-timeout-ms'), evidenceAuthorityTimeoutMs: integer('--evidence-timeout-ms') }).contract;
  const artifacts = await createCalibrationDeploymentArtifacts({ repositoryRoot, provisioned, archiveDirectory,
    adapterDeclaration, adapterContract, evidenceEndpoint, campaignId: required('--campaign-id'),
    calibrationRunId: required('--calibration-run-id'), notBeforeMs: integer('--not-before-ms'),
    expiresAtMs: integer('--expires-at-ms'), baselineCommit: required('--baseline-commit'), baselineTag: required('--baseline-tag'),
    protocolPreparationCommit: required('--protocol-preparation-commit'), calibrationToolingCommit: required('--calibration-tooling-commit'),
    calibrationToolingImplementationCommit: required('--calibration-tooling-implementation-commit') });
  // Preflight the exact signed package/capability using the production verifier.
  // This validates trust-policy pinning and code distribution without executing
  // a reducer, model, policy, seed, or calibration attempt.
  await loadCalibrationExecutionModule(resolve(adapterPackageDirectory, adapterDeclaration.entrypoint), artifacts.authorization_capability, {
    archiveDirectory,
    authorizationTrust: await readFile(provisioned.authorities.calibration_authorization.public_key_path, 'utf8'),
    releaseDescriptor: artifacts.release_descriptor,
    revocationRegistry: artifacts.revocations,
    releaseTrust: await readFile(provisioned.authorities.release.public_key_path, 'utf8'),
    trustPolicy: artifacts.trust_policy,
    now: Math.max(Date.now(), artifacts.authorization_capability.not_before_ms)
  });
  await writeCalibrationDeploymentArtifacts({ artifacts, publicDirectory, privateDirectory });
  const evidenceRuntime = await writeCalibrationEvidenceAuthorityConfiguration({ repositoryRoot, provisioned,
    evidenceEndpoint, storageDirectory: evidenceStorageDirectory, archiveDirectory,
    revocationRegistry: artifacts.revocations });

  // stdout is deliberately a public-only receipt. It contains no paths to
  // private keys and no private bytes.
  console.log(JSON.stringify({ status: 'PROVISIONED', deployment_id: provisioned.public_manifest.deployment_id,
    trust_policy_path: trustPolicyPath, public_directory: publicDirectory, adapter_package_directory: adapterPackageDirectory,
    release_descriptor_hash: artifacts.authorization_capability.release_descriptor_hash,
    authorization_capability_hash: (await import('../src/core.js')).sha256(artifacts.authorization_capability),
    evidence_runtime_descriptor_hash: (await import('../src/core.js')).sha256(evidenceRuntime.runtime_descriptor),
    evidence_endpoint: evidenceEndpoint, empirical_calibration_executed: false }, null, 2));
  trustPolicyRollback = null;
} catch (error) {
  if (trustPolicyRollback) {
    try { await writeFile(trustPolicyRollback.path, trustPolicyRollback.bytes, { mode: 0o644 }); }
    catch { /* Preserve the original provisioning failure as the operator signal. */ }
  }
  console.error(`CalibrationTrustProvisioningError: ${error.message}`);
  process.exitCode = 1;
}
