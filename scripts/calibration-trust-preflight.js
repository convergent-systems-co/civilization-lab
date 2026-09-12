#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../src/core.js';
import { createEvidenceAuthorityClient } from '../src/calibration-evidence-authority-client.js';
import { loadCalibrationExecutionModule } from '../src/calibration-runner.js';

const deployment = resolve(process.argv[2] ?? '');
assert(process.argv.length === 3 && deployment.length > 1,
  'usage: node scripts/calibration-trust-preflight.js /absolute/deployment/root');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const capability = await json(resolve(deployment, 'private/phase-a-authorization-capability.json'));
const releaseDescriptor = await json(resolve(deployment, 'public/calibration-release-descriptor.json'));
const revocationRegistry = await json(resolve(deployment, 'public/calibration-revocations.json'));
const trustPolicy = await json(new URL('../config/calibration-trust-policy.json', import.meta.url));
const authorizationTrust = await readFile(resolve(deployment, 'public/calibration_authorization-public.pem'), 'utf8');
const releaseTrust = await readFile(resolve(deployment, 'public/release-public.pem'), 'utf8');
await loadCalibrationExecutionModule(resolve(deployment, 'adapter-package/adapter.mjs'), capability, {
  archiveDirectory: resolve(deployment, 'archive'), authorizationTrust, releaseDescriptor,
  releaseTrust, trustPolicy, revocationRegistry, now: Date.now()
});
await loadCalibrationExecutionModule(resolve(deployment, 'adapter-package/adapter.mjs'), capability, {
  archiveDirectory: resolve(deployment, 'archive'), authorizationTrust, releaseDescriptor,
  releaseTrust, trustPolicy, revocationRegistry, now: Date.now()
});

const configuration = await json(resolve(deployment, 'adapter-package/config/calibration-evidence-authority.json'));
const certificateAuthority = await readFile(resolve(deployment, 'adapter-package/config/calibration-evidence-authority-ca.pem'));
const credential = (await readFile(resolve(deployment, 'private/evidence-authority-credential.txt'), 'utf8')).trim();
const client = createEvidenceAuthorityClient({ configuration, credential, certificateAuthority });
assert(JSON.stringify(await client.getIntent('nonempirical-authority-preflight')) === '{"record":null}',
  'non-empirical authority preflight encountered unexpected evidence');
let unauthorizedRejected = false;
try {
  await client.finalize({ execution_intent_id: 'nonempirical-unauthorized-finalization',
    request: { idempotencyKey: 'nonempirical-unauthorized-finalization', seed: 'unauthorized' },
    request_hash: '0'.repeat(64), binding: { calibration_parameter_set_hash: '0'.repeat(64),
      policy_manifest_hash: '0'.repeat(64) }, adapterHash: '0'.repeat(64),
    adapterPackageDigest: '0'.repeat(64), bundle: { run_id: 'not-a-run', events: [] } });
} catch { unauthorizedRejected = true; }
assert(unauthorizedRejected, 'finalization outside the fixed campaign authorization was accepted');
const evidenceConfig = await json(resolve(deployment, 'private/calibration-evidence-authority-config.json'));
const heads = await readdir(resolve(evidenceConfig.storage_directory, 'authority-heads'));
const finalized = await readdir(resolve(evidenceConfig.storage_directory, 'finalizations'));
assert(heads.length === 0 && finalized.length === 0,
  'non-empirical trust preflight must not create canonical evidence or an evidence head');
console.log(JSON.stringify({ status: 'PASS', signed_distribution: true, pinned_https: true,
  unauthorized_finalization_rejected: true, empirical_calibration_executed: false }));
