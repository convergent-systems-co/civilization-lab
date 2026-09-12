import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, sha256 } from '../src/core.js';
import { makeWorld } from '../src/world.js';
import { verifyArchiveTrust } from '../src/archive-trust.js';
import {
  createCalibrationEvidenceAuthority,
  createCalibrationEvidenceAuthorityHttpsServer,
  createEvidenceHeadAnchor,
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

async function fixture(t, authorizationCheck = authorizeFinalization, requestCheck = null) {
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
    authorizeFinalization: authorizationCheck, trustedHeadDirectory,
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
    execution_intent_id: input.execution_intent_id, input: { execution_intent_id: input.execution_intent_id } }), /unauthorized/);
  await assert.rejects(f.authority.handle({ credential: 'synthetic-authority-credential', operation: 'UNKNOWN',
    execution_intent_id: input.execution_intent_id, input: { execution_intent_id: input.execution_intent_id } }), /operation/);
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
