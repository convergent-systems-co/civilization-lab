#!/usr/bin/env node
import nodeAssert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert, canonicalize, sha256 } from '../src/core.js';
import { makeWorld } from '../src/world.js';
import { calibrationProtocol } from '../src/calibration.js';
import { calibrationPolicyRequestBinding } from '../src/calibration-policy.js';
import { createPhaseAProductionAdapter } from '../src/calibration-production-adapter.js';
import { assertEmpiricalCapability, materializeCalibrationRuntime,
  startingCalibrationParameterSet } from '../src/calibration-runner.js';
import { createEvidenceAuthorityClient } from '../src/calibration-evidence-authority-client.js';
import {
  createCalibrationEvidenceAuthority,
  createCalibrationEvidenceAuthorityHttpsServer,
  createEvidenceHeadAnchor,
  verifyCalibrationEvidenceAuthority
} from '../src/calibration-evidence-authority-service.js';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
};
const deployment = resolve(option('--deployment-root') ?? '');
const iterations = Number(option('--iterations') ?? '2');
const fullSized = args.includes('--full-sized');
assert(deployment.length > 1 && Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 10,
  'usage: calibration-evidence-commit-probe --deployment-root ABSOLUTE_PATH [--iterations 1..10]');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const capability = await json(join(deployment, 'private/phase-a-authorization-capability.json'));
const policyPath = join(deployment, 'adapter-package/config/calibration-trust-policy.json');
const policyBytes = await readFile(policyPath), policy = JSON.parse(policyBytes);
assert(createHash('sha256').update(policyBytes).digest('hex') === capability.adapter_executable.files['config/calibration-trust-policy.json'],
  'deployment trust-policy snapshot is not signed by the adapter capability');
const releaseDescriptor = await json(join(deployment, 'public/calibration-release-descriptor.json'));
const revocationRegistry = await json(join(deployment, 'public/calibration-revocations.json'));
const authorizationTrust = await readFile(join(deployment, 'public/calibration_authorization-public.pem'), 'utf8');
const releaseTrust = await readFile(join(deployment, 'public/release-public.pem'), 'utf8');
assertEmpiricalCapability(capability, { archiveDirectory: join(deployment, 'archive'), authorizationTrust,
  releaseDescriptor, releaseTrust, trustPolicy: policy, revocationRegistry, historicalDistribution: true });

const authorityConfig = await json(join(deployment, 'private/calibration-evidence-authority-config.json'));
const credential = (await readFile(authorityConfig.credential_path, 'utf8')).trim();
const evidencePrivateKey = await readFile(authorityConfig.evidence_private_key_path, 'utf8');
const evidenceHeadPrivateKey = await readFile(authorityConfig.evidence_head_private_key_path, 'utf8');
const evidencePublicKey = await readFile(join(deployment, 'public/evidence-public.pem'), 'utf8');
const evidenceHeadPublicKey = await readFile(join(deployment, 'public/evidence_head-public.pem'), 'utf8');
const tlsPrivateKey = await readFile(authorityConfig.tls_private_key_path);
const tlsCertificate = await readFile(authorityConfig.tls_certificate_path);
const tlsCa = await readFile(join(deployment, 'public/tls-ca-certificate.pem'));
const headPublic = createPublicKey(evidenceHeadPublicKey);

async function fullSizedDiagnosticBundle() {
  const protocol = calibrationProtocol(), seed = protocol.seed_panel.seeds[0];
  const parameterSet = startingCalibrationParameterSet();
  const adapter = createPhaseAProductionAdapter({ executionMode: 'SYNTHETIC_CONFORMANCE' });
  const calibrationRunId = 'nonempirical-full-commit-probe';
  const attemptId = `nonempirical-attempt-${sha256(parameterSet).slice(0, 24)}`;
  const request = { schema_version: 'phase-a-execution-request-1.0.0', mode: 'SYNTHETIC_CONFORMANCE',
    calibrationRunId, attemptId, idempotencyKey: `nonempirical-intent-${sha256(parameterSet).slice(0, 24)}`,
    seed, parameterSet, runtimeConfiguration: materializeCalibrationRuntime(parameterSet), maxTurns: 20,
    objectiveTerminalPredicates: parameterSet['world.termination.objective_predicates'],
    policyBinding: calibrationPolicyRequestBinding({ participant_ids: ['polity-1', 'polity-2', 'polity-3'],
      seed, seed_panel: protocol.seed_panel.seeds }), adapterContractHash: sha256(adapter.contract),
    adapterPackageHash: null, neutralPolicyManifest: null, modelRuntimeLock: null };
  return adapter.execute(request);
}

const diagnosticBundle = fullSized ? await fullSizedDiagnosticBundle() : null;

function signed(body, envelope) {
  return envelope?.body?.mode === 'NON_EMPIRICAL_DIAGNOSTIC' && canonicalize(envelope.body) === canonicalize(body) &&
    verify(null, Buffer.from(canonicalize(envelope.body)), headPublic, Buffer.from(envelope.signature, 'base64'));
}

async function probe(iteration) {
  const root = await mkdtemp(join(tmpdir(), 'civilizationlab-nonempirical-commit-probe-'));
  await chmod(root, 0o700);
  const storage = join(root, 'storage'), anchor = join(root, 'anchor');
  await mkdir(anchor, { mode: 0o700 });
  await writeFile(join(anchor, 'evidence-head-anchor.json'), canonicalize(createEvidenceHeadAnchor({
    authorityId: authorityConfig.authority_id, evidenceHeadPrivateKey, head: null
  })), { flag: 'wx', mode: 0o600 });
  const intent = `nonempirical-commit-probe-${iteration}`;
  const authorizeRequest = async ({ execution_intent_id }) => assert(execution_intent_id === intent,
    'diagnostic authority intent outside probe scope');
  const authorizeFinalization = async input => assert(input.request?.mode === 'NON_EMPIRICAL_DIAGNOSTIC' &&
    input.request.idempotencyKey === intent && input.bundle?.run_id ===
      (diagnosticBundle?.run_id ?? `nonempirical-run-${iteration}`),
  'diagnostic finalization outside probe scope');
  const create = () => createCalibrationEvidenceAuthority({ directory: storage, credential, evidencePrivateKey,
    evidenceHeadPrivateKey, authorityId: authorityConfig.authority_id, trustedHeadDirectory: anchor,
    authorizeRequest, authorizeFinalization, receiptMode: 'NON_EMPIRICAL_DIAGNOSTIC' });
  let service;
  try {
    const authority = create();
    service = createCalibrationEvidenceAuthorityHttpsServer({ authority, certificate: tlsCertificate,
      privateKey: tlsPrivateKey, host: '127.0.0.1', port: 0 });
    const endpoint = await service.start();
    const configuration = { version: 'phase-a-evidence-authority-client-1.1.0',
      request_version: 'phase-a-evidence-authority-request-1.1.0', endpoint,
      request_timeout_ms: 300_000, worker_timeout_ms: 300_000, transport: 'HTTPS_PRODUCTION',
      observation_public_key: evidenceHeadPublicKey, tls_ca_resource: 'config/diagnostic-ca.pem',
      tls_ca_sha256: sha256(tlsCa.toString('utf8')) };
    const client = createEvidenceAuthorityClient({ configuration, credential, certificateAuthority: tlsCa });
    assert((await client.observeIntent(intent)).observation.body.state === 'ABSENT', 'probe intent did not start absent');
    const bundle = diagnosticBundle ??
      makeWorld({ runId: `nonempirical-run-${iteration}`, seed: 'synthetic-diagnostic-seed' }).evidence.bundle();
    const request = { mode: 'NON_EMPIRICAL_DIAGNOSTIC', idempotencyKey: intent, seed: 'synthetic-diagnostic-seed' };
    const input = { execution_intent_id: intent, request_hash: sha256(request), bundle, request,
      binding: { calibration_parameter_set_hash: 'a'.repeat(64), policy_manifest_hash: 'b'.repeat(64) },
      adapterHash: 'c'.repeat(64), adapterPackageDigest: 'd'.repeat(64) };
    const first = await client.finalize(input);
    assert(signed(first.evidence_head_receipt.body, first.evidence_head_receipt) &&
      signed(first.adapter_execution_receipt.body, first.adapter_execution_receipt), 'client received invalid signed receipt');
    assert((await readdir(join(storage, 'evidence-objects'))).length === 1 &&
      (await readdir(join(storage, 'finalizations'))).length === 1 &&
      (await readdir(join(storage, 'authority-heads'))).length === 1, 'durable commit inventory incomplete');
    assert(canonicalize(await client.finalize(structuredClone(input))) === canonicalize(first), 'duplicate was not idempotent');
    await nodeAssert.rejects(client.finalize({ ...input, adapterHash: 'e'.repeat(64) }),
      /authorization\/request rejected|service unavailable/, 'conflicting duplicate was accepted');
    await service.stop(); service = null;

    const restarted = create();
    service = createCalibrationEvidenceAuthorityHttpsServer({ authority: restarted, certificate: tlsCertificate,
      privateKey: tlsPrivateKey, host: '127.0.0.1', port: 0 });
    const restartedEndpoint = await service.start();
    const restartedClient = createEvidenceAuthorityClient({ configuration: { ...configuration, endpoint: restartedEndpoint },
      credential, certificateAuthority: tlsCa });
    const observation = (await restartedClient.observeIntent(intent)).observation.body;
    assert(observation.state === 'FINALIZED' && observation.request_hash === input.request_hash &&
      canonicalize(observation.result) === canonicalize(first), 'restart reconciliation did not return committed request');
    const verified = await verifyCalibrationEvidenceAuthority({ directory: storage, evidencePublicKey,
      evidenceHeadPublicKey, authorityId: authorityConfig.authority_id, trustedHead: { generation: 0,
        digest: sha256(observation.authority_head) } });
    assert(verified.finalized_count === 1 && verified.head.generation === 0, 'probe head/finalization count invalid');
    assert((await stat(join(storage, 'finalizations', intent + '.json'))).isFile(), 'finalization record missing');
    const requestBytes = Buffer.byteLength(canonicalize({ version: configuration.request_version,
      operation: 'FINALIZE_EXECUTION_INTENT', execution_intent_id: intent, input }));
    return { request_bytes: requestBytes, request_accepted: true, durable_evidence_stored: true, finalization_recorded: true,
      evidence_head_advanced: true, signed_receipt_returned: true, client_validated_receipt: true,
      restart_preserved_state: true, reconciliation_committed: true, duplicate_idempotent: true,
      conflicting_duplicate_rejected: true };
  } finally {
    if (service) await service.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (let index = 0; index < iterations; index += 1) results.push(await probe(index));
console.log(JSON.stringify({ status: 'PASS', evidence_class: 'NON_EMPIRICAL_DIAGNOSTIC', iterations,
  full_sized_frozen_20_turn_bundle: fullSized, empirical_calibration_executed: false, results }));
