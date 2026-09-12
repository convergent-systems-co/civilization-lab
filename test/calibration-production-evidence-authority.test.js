import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, sha256 } from '../src/core.js';
import { makeWorld } from '../src/world.js';
import { verifyArchiveTrust } from '../src/archive-trust.js';
import {
  createCalibrationEvidenceAuthority,
  createCalibrationEvidenceAuthorityHttpsServer,
  createEvidenceHeadAnchor,
  EVIDENCE_AUTHORITY_MAX_REQUEST_BYTES,
  createRevocationAnchor,
  reconcileRevocationAnchor,
  verifyCalibrationEvidenceAuthority,
} from '../src/calibration-evidence-authority-service.js';
import { createEvidenceAuthorityClient } from '../src/calibration-evidence-authority-client.js';

const pem = (key, type) => key.export({ format: 'pem', type });
const authorizeFinalization = async () => true;
const post = ({ endpoint, ca, token, body }) => new Promise((resolve, reject) => {
  const request = httpsRequest(endpoint, { method: 'POST', ca, servername: 'localhost',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.once('error', reject); request.end(canonicalize(body));
});

async function fixture(t, authorizationCheck = authorizeFinalization, requestCheck = null, fault = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'civilization-lab-evidence-authority-'));
  await chmod(directory, 0o700);
  const trustedHeadDirectory = join(directory, 'external-head-anchor');
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })); });
  const evidence = generateKeyPairSync('ed25519');
  const head = generateKeyPairSync('ed25519');
  await mkdir(trustedHeadDirectory, { mode: 0o700 });
  await writeFile(join(trustedHeadDirectory, 'evidence-head-anchor.json'), canonicalize(createEvidenceHeadAnchor({
    authorityId: 'phase-a-local-authority-test', evidenceHeadPrivateKey: pem(head.privateKey, 'pkcs8'), head: null
  })), { mode: 0o600 });
  const authority = createCalibrationEvidenceAuthority({
    directory,
    credential: 'synthetic-authority-credential',
    evidencePrivateKey: pem(evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(head.privateKey, 'pkcs8'),
    authorityId: 'phase-a-local-authority-test', authorizeRequest: requestCheck,
    authorizeFinalization: authorizationCheck, trustedHeadDirectory, fault,
  });
  await authority.initialize();
  return { directory, trustedHeadDirectory, authority, evidence, head };
}

function finalizationInput(intent = 'intent-authority-0001') {
  const world = makeWorld({ runId: `run-${intent}`, seed: 'cal-seed-0001' });
  const bundle = world.evidence.bundle();
  const request = { idempotencyKey: intent, seed: 'cal-seed-0001' };
  return {
    execution_intent_id: intent,
    request_hash: sha256(request),
    bundle,
    request,
    binding: { calibration_parameter_set_hash: 'a'.repeat(64), policy_manifest_hash: 'b'.repeat(64) },
    adapterHash: 'c'.repeat(64),
    adapterPackageDigest: 'd'.repeat(64),
  };
}

test('durable authority stores immutable intents owner-only and survives restart', async t => {
  const f = await fixture(t);
  await f.authority.putIntent('intent-authority-0001', { state: 'DISPATCH_PENDING', sequence: 1 });
  await f.authority.putIntent('intent-authority-0001', { state: 'DISPATCH_PENDING', sequence: 1 });
  await assert.rejects(f.authority.putIntent('intent-authority-0001', { state: 'MUTATED', sequence: 2 }), /immutable|mutation/);
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await restarted.initialize();
  assert.deepEqual(await restarted.getIntent('intent-authority-0001'), { state: 'DISPATCH_PENDING', sequence: 1 });
  assert.equal((await stat(f.directory)).mode & 0o077, 0);
});

test('authority refuses a pre-existing storage root with group or world access', async t => {
  const f = await fixture(t);
  const insecure = await mkdtemp(join(tmpdir(), 'civilization-lab-insecure-authority-'));
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(insecure, { recursive: true, force: true })); });
  await chmod(insecure, 0o755);
  const authority = createCalibrationEvidenceAuthority({ directory: insecure,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await assert.rejects(authority.initialize(), /owner-only/);
});

test('read-only verifier accepts an empty legacy store without creating a claims directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'civilization-lab-legacy-empty-authority-'));
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })); });
  for (const name of ['authority-heads', 'finalizations', 'evidence-objects']) await mkdir(join(directory, name), { mode: 0o700 });
  const evidence = generateKeyPairSync('ed25519'), head = generateKeyPairSync('ed25519');
  const before = (await readdir(directory)).sort();
  const result = await verifyCalibrationEvidenceAuthority({ directory,
    evidencePublicKey: pem(evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(result.finalized_count, 0); assert.equal(result.head, null);
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test('FINALIZE is idempotent, content-addressed, signed by distinct keys, and restart durable', async t => {
  const f = await fixture(t), input = finalizationInput();
  const first = await f.authority.finalize(input);
  assert.deepEqual(await f.authority.finalize(structuredClone(input)), first);
  assert.equal(first.archive_export.manifests[0].body.key_id, f.authority.evidenceKeyId);
  assert.notEqual(f.authority.evidenceKeyId, f.authority.evidenceHeadKeyId);
  const trusted = verifyArchiveTrust(first.archive_export, { runId: input.bundle.run_id,
    publicKey: pem(f.evidence.publicKey, 'spki'), keyId: first.archive_export.manifests[0].body.key_id,
    trustedHead: first.evidence_head_receipt.body.head });
  assert.equal(trusted.status, 'COMPLETE');
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await restarted.initialize();
  assert.deepEqual(await restarted.finalize(structuredClone(input)), first);
  assert.deepEqual((await restarted.getIntent(input.execution_intent_id)).result, first);
  await assert.rejects(restarted.finalize({ ...input, adapterHash: 'e'.repeat(64) }), /mutation|conflict/);
});

test('signed authority observations distinguish absent, stored, pending, and finalized intent state', async t => {
  let crashAtHead = false;
  const f = await fixture(t, authorizeFinalization, null, async point => {
    if (crashAtHead && point === 'after_evidence_head_advanced_before_finalization') {
      crashAtHead = false; throw new Error('head response lost');
    }
  });
  const id = 'intent-observation-0001';
  const check = (envelope, state) => {
    assert.equal(envelope.body.state, state);
    assert.equal(envelope.body.execution_intent_id, id);
    assert.equal(verify(null, Buffer.from(canonicalize(envelope.body)), f.head.publicKey,
      Buffer.from(envelope.signature, 'base64')), true);
  };
  check(await f.authority.observeIntent(id), 'ABSENT');
  const input = finalizationInput(id);
  await f.authority.putIntent(id, { request_hash: input.request_hash });
  check(await f.authority.observeIntent(id), 'INTENT_STORED');
  crashAtHead = true;
  await assert.rejects(() => f.authority.finalize(input), /head response lost/);
  // Observation is also the recovery trigger: authoritative pending state is
  // completed idempotently without requiring a process restart.
  check(await f.authority.observeIntent(id), 'FINALIZED');
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test',
    authorizeFinalization, trustedHeadDirectory: f.trustedHeadDirectory });
  await restarted.initialize();
  check(await restarted.observeIntent(id), 'FINALIZED');
});

test('pending transaction recovers after a crash between signed head and finalized publication', async t => {
  const f = await fixture(t), input = finalizationInput();
  const result = await f.authority.finalize(input);
  await unlink(join(f.directory, 'finalizations', input.execution_intent_id + '.json'));
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await restarted.initialize();
  assert.deepEqual((await restarted.getIntent(input.execution_intent_id)).result, result);
  // The same immutable pending transaction also repairs a crash before either
  // the head or finalized record became durable.
  await unlink(join(f.directory, 'authority-heads', '00000000000000000000.json'));
  await unlink(join(f.directory, 'finalizations', input.execution_intent_id + '.json'));
  const restartedEarlier = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await restartedEarlier.initialize();
  assert.deepEqual((await restartedEarlier.getIntent(input.execution_intent_id)).result, result);
});

test('faults at every evidence commit boundary recover from authoritative state without duplicate heads', async t => {
  for (const [index, boundary] of [
    'before_evidence_object_commit',
    'after_evidence_object_commit_before_attestation',
    'during_final_attempt_attestation',
    'after_finalization_staged_before_head_update',
    'after_evidence_head_advanced_before_finalization',
    'after_finalization_before_head_acknowledgement'
  ].entries()) {
    let injected = false;
    const f = await fixture(t, authorizeFinalization, null, async point => {
      if (!injected && point === boundary) { injected = true; throw new Error(`crash:${boundary}`); }
    });
    const input = finalizationInput(`intent-boundary-${String(index).padStart(4, '0')}`);
    await assert.rejects(() => f.authority.finalize(input), new RegExp(`crash:${boundary}`));
    const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
      credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
      evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test',
      authorizeFinalization, trustedHeadDirectory: f.trustedHeadDirectory });
    await restarted.initialize();
    const result = await restarted.finalize(structuredClone(input));
    assert.equal(result.bundle.run_id, input.bundle.run_id);
    const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
      evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
      authorityId: 'phase-a-local-authority-test' });
    assert.equal(verified.head.generation, 0, `${boundary} must produce exactly one authoritative disposition`);
  }
});

test('pre-finalization claim rejects divergent retry and accounts for the originally committed object', async t => {
  let fail = true;
  const f = await fixture(t, authorizeFinalization, null, async point => {
    if (fail && point === 'after_evidence_object_commit_before_attestation') {
      fail = false; throw new Error('crash:after-object');
    }
  });
  const input = finalizationInput('intent-claimed-object-0001');
  await assert.rejects(f.authority.finalize(input), /crash:after-object/);
  await assert.rejects(f.authority.finalize({ ...structuredClone(input),
    binding: { ...input.binding, policy_manifest_hash: 'e'.repeat(64) } }), /mutation|conflict/);
  const divergent = structuredClone(input);
  divergent.bundle = makeWorld({ runId: input.bundle.run_id, seed: 'different-valid-world-seed' }).evidence.bundle();
  await assert.rejects(f.authority.finalize(divergent), /mutation|conflict/);
  const result = await f.authority.finalize(structuredClone(input));
  assert.equal(result.bundle.run_id, input.bundle.run_id);
  assert.equal((await readdir(join(f.directory, 'finalization-claims'))).length, 1);
  assert.equal((await readdir(join(f.directory, 'evidence-objects'))).length, 1);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.finalized_count, 1);
});

test('authority verification rejects a missing or substituted finalized claim', async t => {
  for (const [index, mutation] of ['missing', 'substituted'].entries()) {
    const f = await fixture(t), input = finalizationInput(`intent-claim-tamper-${index}`);
    await f.authority.finalize(input);
    const path = join(f.directory, 'finalization-claims', input.execution_intent_id + '.json');
    if (mutation === 'missing') await unlink(path);
    else {
      const claim = JSON.parse(await readFile(path, 'utf8'));
      claim.adapter_hash = 'f'.repeat(64); await writeFile(path, canonicalize(claim));
    }
    await assert.rejects(verifyCalibrationEvidenceAuthority({ directory: f.directory,
      evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
      authorityId: 'phase-a-local-authority-test' }), mutation === 'missing' ? /ENOENT|no such file/ : /exact immutable finalization claim/);
  }
});

test('real HTTPS SIGKILL at every commit boundary restarts and reconciles one finalization', async t => {
  for (const [index, crashBoundary] of [
    'before_evidence_object_commit', 'after_evidence_object_commit_before_attestation',
    'during_final_attempt_attestation', 'after_finalization_staged_before_head_update',
    'after_evidence_head_advanced_before_finalization', 'after_finalization_before_head_acknowledgement'
  ].entries()) {
  const f = await fixture(t), input = finalizationInput(`intent-real-process-crash-${index}`);
  const tls = join(f.directory, `tls-process-crash-${index}`); await mkdir(tls, { mode: 0o700 });
  const tlsKey = join(tls, 'server-key.pem'), tlsCert = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', tlsCert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const evidenceKey = join(f.directory, 'crash-evidence-private.pem');
  const headKey = join(f.directory, 'crash-head-private.pem');
  await writeFile(evidenceKey, pem(f.evidence.privateKey, 'pkcs8'), { mode: 0o600 });
  await writeFile(headKey, pem(f.head.privateKey, 'pkcs8'), { mode: 0o600 });
  const childConfig = join(f.directory, 'crash-child.json');
  await writeFile(childConfig, canonicalize({ directory: f.directory, credential: 'synthetic-authority-credential',
    evidence_private_key: evidenceKey, evidence_head_private_key: headKey, authority_id: 'phase-a-local-authority-test',
    trusted_head_directory: f.trustedHeadDirectory, tls_certificate: tlsCert, tls_private_key: tlsKey,
    crash_boundary: crashBoundary }), { mode: 0o600 });
  const child = spawn(process.execPath, ['test/fixtures/calibration-evidence-authority-crash-child.mjs', childConfig],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  const childExit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    child.once('error', reject); child.stdout.once('data', chunk => resolveEndpoint(chunk.toString().trim()));
  });
  const certificate = await readFile(tlsCert), configuration = {
    version: 'phase-a-evidence-authority-client-1.1.0', request_version: 'phase-a-evidence-authority-request-1.1.0',
    endpoint, request_timeout_ms: 5000, worker_timeout_ms: 10000, transport: 'HTTPS_PRODUCTION',
    tls_ca_resource: 'config/calibration-evidence-authority-ca.pem', tls_ca_sha256: sha256(certificate.toString('utf8')),
    observation_public_key: pem(f.head.publicKey, 'spki') };
  const crashedClient = createEvidenceAuthorityClient({ configuration, credential: 'synthetic-authority-credential',
    certificateAuthority: certificate });
  await assert.rejects(crashedClient.finalize(input), error => error.code === 'CALIBRATION_INFRASTRUCTURE_AUTHORITY');
  assert.deepEqual(await childExit, { code: null, signal: 'SIGKILL' });
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test',
    authorizeRequest: async () => true, authorizeFinalization, trustedHeadDirectory: f.trustedHeadDirectory });
  const restartedServer = createCalibrationEvidenceAuthorityHttpsServer({ authority: restarted,
    certificate, privateKey: await readFile(tlsKey), host: '127.0.0.1', port: 0 });
  const restartedEndpoint = await restartedServer.start(); t.after(() => restartedServer.stop());
  const client = createEvidenceAuthorityClient({ configuration: { ...configuration, endpoint: restartedEndpoint },
    credential: 'synthetic-authority-credential', certificateAuthority: certificate });
  let observation = (await client.observeIntent(input.execution_intent_id)).observation.body;
  const recovered = observation.state === 'FINALIZED' ? observation.result : await client.finalize(structuredClone(input));
  observation = (await client.observeIntent(input.execution_intent_id)).observation.body;
  assert.equal(observation.state, 'FINALIZED', crashBoundary);
  assert.deepEqual(recovered, observation.result);
  assert.deepEqual(await client.finalize(structuredClone(input)), observation.result);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.finalized_count, 1, crashBoundary); assert.equal(verified.head.generation, 0, crashBoundary);
  }
});

test('two authority processes cannot allocate competing dispositions for one global head', async t => {
  const f = await fixture(t);
  const peer = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test',
    authorizeFinalization, trustedHeadDirectory: f.trustedHeadDirectory });
  await peer.initialize();
  const first = finalizationInput('intent-cross-process-lock-0001');
  const second = finalizationInput('intent-cross-process-lock-0002');
  const settled = await Promise.allSettled([f.authority.finalize(first), peer.finalize(second)]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  const rejected = settled.find(item => item.status === 'rejected');
  assert.match(rejected.reason.message, /already claimed|stale-lock recovery/);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.head.generation, 0);
});

test('client rejects a malformed or forged recovery observation before it can authorize replay', async () => {
  const head = generateKeyPairSync('ed25519');
  const configuration = { version: 'phase-a-evidence-authority-client-1.1.0',
    request_version: 'phase-a-evidence-authority-request-1.1.0', endpoint: 'http://127.0.0.1:1/seal',
    request_timeout_ms: 2000, worker_timeout_ms: 5000, transport: 'INSECURE_LOOPBACK_CONFORMANCE_ONLY',
    observation_public_key: pem(head.publicKey, 'spki') };
  const client = createEvidenceAuthorityClient({ configuration, credential: 'credential', fetchImplementation: async (_url, options) => {
    const request = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { execution_intent_id: request.execution_intent_id,
      observation: { body: { version: 'phase-a-evidence-authority-observation-1.0.0', authority_id: 'forged',
        execution_intent_id: request.execution_intent_id, state: 'ABSENT', request_hash: 'a'.repeat(64),
        result: null, finalization_hash: null, authority_head: null }, signature: 'AAAA' } }; } };
  } });
  await assert.rejects(client.observeIntent('intent-forged-observation-0001'), /signed authority observation invalid/);
});

test('external trusted head detects a complete local rollback', async t => {
  const f = await fixture(t), input = finalizationInput();
  await f.authority.finalize(input);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  await unlink(join(f.directory, 'authority-heads', '00000000000000000000.json'));
  await unlink(join(f.directory, 'finalizations', input.execution_intent_id + '.json'));
  await assert.rejects(verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test', trustedHead: verified.head }), /rollback/);
});

test('production startup rejects evidence-store rollback behind its separate durable head anchor', async t => {
  const f = await fixture(t), input = finalizationInput();
  await f.authority.finalize(input);
  await unlink(join(f.directory, 'authority-heads', '00000000000000000000.json'));
  await unlink(join(f.directory, 'finalizations', input.execution_intent_id + '.json'));
  await unlink(join(f.directory, 'pending-finalizations', input.execution_intent_id + '.json'));
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await assert.rejects(restarted.initialize(), /rollback.*anchored head/);
});

test('production startup rejects deletion of both durable history and its provisioned anchor', async t => {
  const f = await fixture(t), input = finalizationInput();
  await f.authority.finalize(input);
  await unlink(join(f.directory, 'authority-heads', '00000000000000000000.json'));
  await unlink(join(f.directory, 'finalizations', input.execution_intent_id + '.json'));
  await unlink(join(f.directory, 'pending-finalizations', input.execution_intent_id + '.json'));
  await unlink(join(f.trustedHeadDirectory, 'evidence-head-anchor.json'));
  const restarted = createCalibrationEvidenceAuthority({ directory: f.directory,
    credential: 'synthetic-authority-credential', evidencePrivateKey: pem(f.evidence.privateKey, 'pkcs8'),
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), authorityId: 'phase-a-local-authority-test', authorizeFinalization,
    trustedHeadDirectory: f.trustedHeadDirectory });
  await assert.rejects(restarted.initialize(), /provisioned.*anchor.*missing/);
});

test('revocation anchor rejects registry rollback, skipped generations, and removed revocations', async t => {
  const f = await fixture(t), path = join(f.trustedHeadDirectory, 'calibration-revocation-anchor.json');
  const initial = { generation: 0, registry_hash: 'a'.repeat(64), parent_registry_hash: null,
    revoked_key_ids: [], revoked_capability_hashes: [] };
  await writeFile(path, canonicalize(createRevocationAnchor({ authorityId: 'phase-a-local-authority-test',
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8'), registry: initial })), { flag: 'wx', mode: 0o600 });
  const options = { trustedHeadDirectory: f.trustedHeadDirectory, authorityId: 'phase-a-local-authority-test',
    evidenceHeadPrivateKey: pem(f.head.privateKey, 'pkcs8') };
  await reconcileRevocationAnchor({ ...options, registry: initial });
  const successor = { generation: 1, registry_hash: 'b'.repeat(64), parent_registry_hash: initial.registry_hash,
    revoked_key_ids: ['c'.repeat(64)], revoked_capability_hashes: ['d'.repeat(64)] };
  await reconcileRevocationAnchor({ ...options, registry: successor });
  await assert.rejects(reconcileRevocationAnchor({ ...options, registry: initial }), /rollback|rolls back|conflict/);
  await assert.rejects(reconcileRevocationAnchor({ ...options, registry: { ...successor, generation: 3,
    registry_hash: 'e'.repeat(64), parent_registry_hash: successor.registry_hash } }), /skips|rollback/);
  await assert.rejects(reconcileRevocationAnchor({ ...options, registry: { generation: 2,
    registry_hash: 'f'.repeat(64), parent_registry_hash: successor.registry_hash,
    revoked_key_ids: [], revoked_capability_hashes: successor.revoked_capability_hashes } }), /removed/);
});

test('signed monotonic authority head rejects rollback, conflicts, and durable tampering', async t => {
  const f = await fixture(t);
  for (const id of ['intent-authority-0001', 'intent-authority-0002']) {
    const input = finalizationInput(id);
    await f.authority.putIntent(id, { request_hash: input.request_hash });
    await f.authority.finalize(input);
  }
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.finalized_count, 2);
  assert.equal(verified.head.generation, 1);
  const headPath = join(f.directory, 'authority-heads', '00000000000000000001.json');
  const original = await readFile(headPath, 'utf8');
  await chmod(headPath, 0o600);
  await writeFile(headPath, canonicalize({ forged: true }), { mode: 0o600 });
  await assert.rejects(verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' }), /head|schema|signature|chain/);
  await writeFile(headPath, original, { mode: 0o600 });
});

test('authority rejects malformed, unauthenticated, and provenance-conflicting operations', async t => {
  const f = await fixture(t), input = finalizationInput();
  await assert.rejects(f.authority.handle({ credential: 'wrong', operation: 'GET_EXECUTION_INTENT',
    execution_intent_id: input.execution_intent_id, input: { execution_intent_id: input.execution_intent_id } }), /request rejected/);
  await assert.rejects(f.authority.handle({ credential: 'synthetic-authority-credential', operation: 'UNKNOWN',
    execution_intent_id: input.execution_intent_id, input: { execution_intent_id: input.execution_intent_id } }), /request rejected/);
  await f.authority.putIntent(input.execution_intent_id, { request_hash: '0'.repeat(64) });
  await assert.rejects(f.authority.finalize({ ...input, request_hash: 'f'.repeat(64) }), /request.*hash|provenance/);
});

test('current authorization is checked before every production request, including the pre-execution read', async t => {
  let revoked = false;
  const f = await fixture(t, authorizeFinalization, async () => assert.equal(revoked, false, 'campaign capability revoked'));
  const id = 'intent-authority-revocation-check';
  assert.deepEqual(await f.authority.handle({ credential: 'synthetic-authority-credential',
    operation: 'GET_EXECUTION_INTENT', execution_intent_id: id, input: { execution_intent_id: id } }), { record: null });
  revoked = true;
  await assert.rejects(f.authority.handle({ credential: 'synthetic-authority-credential',
    operation: 'GET_EXECUTION_INTENT', execution_intent_id: id, input: { execution_intent_id: id } }), /revoked/);
});

test('evidence signer rejects a structurally valid bundle outside its fixed campaign authorization', async t => {
  const f = await fixture(t, async input => {
    if (input.request.seed !== 'authorized-seed') throw new Error('campaign scope rejected');
  });
  await assert.rejects(f.authority.finalize(finalizationInput()), /campaign scope rejected/);
  assert.equal((await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' })).finalized_count, 0);
});

test('production endpoint is HTTPS-only with bearer authentication and no plaintext server mode', async t => {
  const f = await fixture(t);
  const tls = join(f.directory, 'tls');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(tls, { mode: 0o700 }));
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  await chmod(keyPath, 0o600); await chmod(certPath, 0o600);
  assert.throws(() => createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority }), /certificate|TLS/);
  const server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate: await readFile(certPath), privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0 });
  await server.start(); t.after(() => server.stop());
  const endpoint = server.endpoint;
  assert.match(endpoint, /^https:\/\//);
  const message = { version: 'phase-a-evidence-authority-request-1.1.0', operation: 'GET_EXECUTION_INTENT',
    execution_intent_id: 'intent-authority-0001', input: { execution_intent_id: 'intent-authority-0001' } };
  const accepted = await post({ endpoint, ca: await readFile(certPath), token: 'synthetic-authority-credential', body: message });
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), { execution_intent_id: 'intent-authority-0001', record: null });
  const denied = await post({ endpoint, ca: await readFile(certPath), token: 'wrong-credential', body: message });
  assert.equal(denied.status, 400); assert.equal(denied.body, '{"error":"rejected"}');
  await assert.rejects(fetch(endpoint), /fetch failed/);
});

test('production request ceiling admits a measured full Phase A bundle and diagnoses ingestion rejection', async t => {
  assert(EVIDENCE_AUTHORITY_MAX_REQUEST_BYTES > 157_895_011,
    'production request ceiling regressed below the measured frozen 20-turn request');
  const diagnostics = [], f = await fixture(t);
  const tls = join(f.directory, 'tls-size-boundary');
  await mkdir(tls, { mode: 0o700 });
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath);
  const server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate, privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0, maxRequestBytes: 128,
    diagnostic: record => diagnostics.push(record) });
  await server.start(); t.after(() => server.stop());
  const message = { version: 'phase-a-evidence-authority-request-1.1.0', operation: 'GET_EXECUTION_INTENT',
    execution_intent_id: 'intent-size-boundary-0001', input: { execution_intent_id: 'intent-size-boundary-0001' },
    padding: 'x'.repeat(512) };
  await post({ endpoint: server.endpoint, ca: certificate, token: 'synthetic-authority-credential', body: message }).catch(() => null);
  assert.deepEqual(diagnostics, [{ code: 'EVIDENCE_AUTHORITY_REQUEST_TOO_LARGE', boundary: 'REQUEST_BODY_INGESTION' }]);
  assert.equal((await readdir(join(f.directory, 'finalizations'))).length, 0);
  assert.equal((await readdir(join(f.directory, 'authority-heads'))).length, 0);
});

test('HTTPS reports internal authority/storage failure as retryable infrastructure, not protocol rejection', async t => {
  let authorizationDependencyDown = true;
  const f = await fixture(t, authorizeFinalization, async () => {
    if (authorizationDependencyDown) throw new Error('synthetic revocation registry I/O outage');
  }, async point => {
    if (point === 'before_evidence_object_commit') throw new Error('synthetic internal storage outage');
  });
  const tls = join(f.directory, 'tls-internal-failure');
  await mkdir(tls, { mode: 0o700 });
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath);
  const server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate, privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0 });
  await server.start(); t.after(() => server.stop());
  const client = createEvidenceAuthorityClient({ configuration: {
    version: 'phase-a-evidence-authority-client-1.1.0', request_version: 'phase-a-evidence-authority-request-1.1.0',
    endpoint: server.endpoint, request_timeout_ms: 2000, worker_timeout_ms: 5000, transport: 'HTTPS_PRODUCTION',
    tls_ca_resource: 'config/calibration-evidence-authority-ca.pem', tls_ca_sha256: sha256(certificate.toString('utf8')),
    observation_public_key: pem(f.head.publicKey, 'spki')
  }, credential: 'synthetic-authority-credential', certificateAuthority: certificate });
  await assert.rejects(client.getIntent('intent-https-authorization-io-0001'), error =>
    error.code === 'CALIBRATION_INFRASTRUCTURE_AUTHORITY' && error.calibrationClassification === 'INFRASTRUCTURE_FAILURE');
  authorizationDependencyDown = false;
  await assert.rejects(client.finalize(finalizationInput('intent-https-internal-failure-0001')), error =>
    error.code === 'CALIBRATION_INFRASTRUCTURE_AUTHORITY' && error.calibrationClassification === 'INFRASTRUCTURE_FAILURE');
});

test('HTTPS acknowledgement loss reconciles to one committed finalization and one head', async t => {
  const f = await fixture(t); let drop = true;
  const tls = join(f.directory, 'tls-ack-loss');
  await mkdir(tls, { mode: 0o700 });
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath);
  const server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate, privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0,
    transportFault: async point => { if (drop && point === 'after_authority_commit_before_acknowledgement') {
      drop = false; throw new Error('synthetic acknowledgement loss');
    } } });
  await server.start(); t.after(() => server.stop());
  const client = createEvidenceAuthorityClient({ configuration: {
    version: 'phase-a-evidence-authority-client-1.1.0', request_version: 'phase-a-evidence-authority-request-1.1.0',
    endpoint: server.endpoint, request_timeout_ms: 2000, worker_timeout_ms: 5000, transport: 'HTTPS_PRODUCTION',
    tls_ca_resource: 'config/calibration-evidence-authority-ca.pem', tls_ca_sha256: sha256(certificate.toString('utf8')),
    observation_public_key: pem(f.head.publicKey, 'spki')
  }, credential: 'synthetic-authority-credential', certificateAuthority: certificate });
  const input = finalizationInput('intent-https-ack-loss-0001');
  await assert.rejects(client.finalize(input), error => error.code === 'CALIBRATION_INFRASTRUCTURE_AUTHORITY');
  const observation = (await client.observeIntent(input.execution_intent_id)).observation.body;
  assert.equal(observation.state, 'FINALIZED');
  assert.equal(observation.request_hash, input.request_hash);
  assert.deepEqual(await client.finalize(structuredClone(input)), observation.result);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.finalized_count, 1);
  assert.equal(verified.head.generation, 0);
});

test('client disconnect after acknowledgement begins reconciles to the committed authoritative result', async t => {
  const f = await fixture(t), tls = join(f.directory, 'tls-client-disconnect');
  await mkdir(tls, { mode: 0o700 });
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath), server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate, privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0 });
  const endpoint = await server.start(); t.after(() => server.stop());
  const input = finalizationInput('intent-client-disconnect-0001');
  await new Promise((resolveDisconnect, reject) => {
    const request = httpsRequest(endpoint, { method: 'POST', ca: certificate, servername: 'localhost',
      headers: { authorization: 'Bearer synthetic-authority-credential', 'content-type': 'application/json' } }, response => {
      response.once('data', () => { response.destroy(); resolveDisconnect(); });
    });
    request.once('error', error => { if (error.code === 'ECONNRESET') resolveDisconnect(); else reject(error); });
    request.end(canonicalize({ version: 'phase-a-evidence-authority-request-1.1.0',
      operation: 'FINALIZE_EXECUTION_INTENT', execution_intent_id: input.execution_intent_id, input }));
  });
  const client = createEvidenceAuthorityClient({ configuration: { version: 'phase-a-evidence-authority-client-1.1.0',
    request_version: 'phase-a-evidence-authority-request-1.1.0', endpoint, request_timeout_ms: 2000,
    worker_timeout_ms: 5000, transport: 'HTTPS_PRODUCTION', tls_ca_resource: 'config/ca.pem',
    tls_ca_sha256: sha256(certificate.toString('utf8')), observation_public_key: pem(f.head.publicKey, 'spki') },
    credential: 'synthetic-authority-credential', certificateAuthority: certificate });
  const observation = (await client.observeIntent(input.execution_intent_id)).observation.body;
  assert.equal(observation.state, 'FINALIZED');
  assert.deepEqual(await client.finalize(structuredClone(input)), observation.result);
  const verified = await verifyCalibrationEvidenceAuthority({ directory: f.directory,
    evidencePublicKey: pem(f.evidence.publicKey, 'spki'), evidenceHeadPublicKey: pem(f.head.publicKey, 'spki'),
    authorityId: 'phase-a-local-authority-test' });
  assert.equal(verified.finalized_count, 1); assert.equal(verified.head.generation, 0);
});

test('production client accepts only its signed pinned CA and rejects substitution', async t => {
  const f = await fixture(t);
  const tls = join(f.directory, 'pinned-tls');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(tls, { mode: 0o700 }));
  const keyPath = join(tls, 'server-key.pem'), certPath = join(tls, 'server-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath), server = createCalibrationEvidenceAuthorityHttpsServer({ authority: f.authority,
    certificate, privateKey: await readFile(keyPath), host: '127.0.0.1', port: 0 });
  await server.start(); t.after(() => server.stop());
  const configuration = { version: 'phase-a-evidence-authority-client-1.1.0',
    request_version: 'phase-a-evidence-authority-request-1.1.0', endpoint: server.endpoint,
    request_timeout_ms: 2000, worker_timeout_ms: 5000, transport: 'HTTPS_PRODUCTION',
    tls_ca_resource: 'config/calibration-evidence-authority-ca.pem',
    tls_ca_sha256: sha256(certificate.toString('utf8')) };
  // core.sha256 hashes strings as bytes, matching the PEM file bytes.
  const client = createEvidenceAuthorityClient({ configuration, credential: 'synthetic-authority-credential',
    certificateAuthority: certificate });
  assert.deepEqual(await client.getIntent('intent-pinned-0001'), { record: null });
  assert.throws(() => createEvidenceAuthorityClient({ configuration, credential: 'synthetic-authority-credential',
    certificateAuthority: Buffer.from('wrong certificate') }), /digest mismatch/);
});
