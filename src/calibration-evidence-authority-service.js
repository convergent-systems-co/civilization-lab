import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual, verify } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, canonicalize, clone, sha256 } from './core.js';
import { verifyEvidenceIntegrity } from './replay.js';
import { assertValidSchema } from './schema.js';

const REQUEST_VERSION = 'phase-a-evidence-authority-request-1.1.0';
const SERVICE_VERSION = 'phase-a-production-evidence-authority-1.0.0';
// Complete frozen 20-turn Phase A evidence is about 158 MB before receipts.
// The former 64 MiB ceiling rejected valid requests during body ingestion.
export const EVIDENCE_AUTHORITY_MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const INTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HEAD_NAME = generation => String(generation).padStart(20, '0') + '.json';

export function evidenceAuthorityRequestRejected(message = 'evidence authority request rejected') {
  const error = new Error(message); error.code = 'EVIDENCE_AUTHORITY_REQUEST_REJECTED'; return error;
}

function keyId(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  assert(publicKey.asymmetricKeyType === 'ed25519', 'evidence authority requires Ed25519 keys');
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function envelope(body, privateKey) {
  return { body, signature: sign(null, Buffer.from(canonicalize(body)), privateKey).toString('base64') };
}

export function createEvidenceHeadAnchor({ authorityId, evidenceHeadPrivateKey, head = null }) {
  const key = createPrivateKey(evidenceHeadPrivateKey);
  assert(key.asymmetricKeyType === 'ed25519', 'evidence-head anchor requires an Ed25519 private key');
  const evidenceHeadKeyId = keyId(createPublicKey(key));
  assert(typeof authorityId === 'string' && authorityId.length > 0, 'evidence-head anchor authority required');
  assert(head === null || Number.isSafeInteger(head?.generation) && head.generation >= 0 && HASH.test(head.digest),
    'evidence-head anchor value malformed');
  return envelope({ version: 'phase-a-evidence-head-anchor-1.0.0', authority_id: authorityId,
    evidence_head_key_id: evidenceHeadKeyId, head }, key);
}

export function createRevocationAnchor({ authorityId, evidenceHeadPrivateKey, registry }) {
  const key = evidenceHeadPrivateKey?.type === 'private' ? evidenceHeadPrivateKey : createPrivateKey(evidenceHeadPrivateKey);
  assert(key.asymmetricKeyType === 'ed25519', 'revocation anchor requires an Ed25519 evidence-head key');
  assert(registry && Number.isSafeInteger(registry.generation) && registry.generation >= 0 && HASH.test(registry.registry_hash),
    'revocation anchor registry status malformed');
  const body = { version: 'phase-a-revocation-anchor-1.0.0', authority_id: authorityId,
    evidence_head_key_id: keyId(createPublicKey(key)), generation: registry.generation,
    registry_hash: registry.registry_hash, revoked_key_ids: [...registry.revoked_key_ids].sort(),
    revoked_capability_hashes: [...registry.revoked_capability_hashes].sort() };
  assertValidSchema(body, 'calibration-revocation-anchor.schema.json');
  return envelope(body, key);
}

export async function reconcileRevocationAnchor({ trustedHeadDirectory, authorityId,
  evidenceHeadPrivateKey, registry }) {
  const directory = resolve(trustedHeadDirectory), path = join(directory, 'calibration-revocation-anchor.json');
  await privateDirectory(directory);
  const key = createPrivateKey(evidenceHeadPrivateKey), publicKey = createPublicKey(key);
  const raw = await bytesIfPresent(path);
  assert(raw !== null, 'provisioned revocation anchor is missing');
  const value = JSON.parse(raw);
  assert(canonicalize(value) === raw, 'revocation anchor is not canonical');
  const anchored = verifyEnvelope(value, publicKey, 'revocation anchor');
  assertValidSchema(anchored, 'calibration-revocation-anchor.schema.json');
  assert(anchored.authority_id === authorityId && anchored.evidence_head_key_id === keyId(publicKey),
    'revocation anchor authority mismatch');
  if (registry.generation === anchored.generation) {
    assert(registry.registry_hash === anchored.registry_hash &&
      canonicalize([...registry.revoked_key_ids].sort()) === canonicalize(anchored.revoked_key_ids) &&
      canonicalize([...registry.revoked_capability_hashes].sort()) === canonicalize(anchored.revoked_capability_hashes),
    'revocation registry rollback or same-generation conflict');
    return anchored;
  }
  assert(registry.generation === anchored.generation + 1 && registry.parent_registry_hash === anchored.registry_hash,
    'revocation registry skips or rolls back the anchored generation');
  assert(anchored.revoked_key_ids.every(id => registry.revoked_key_ids.includes(id)) &&
    anchored.revoked_capability_hashes.every(id => registry.revoked_capability_hashes.includes(id)),
  'revocation registry removed a prior revocation');
  const next = createRevocationAnchor({ authorityId, evidenceHeadPrivateKey: key, registry });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(canonicalize(next)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); await syncDirectory(directory);
  return next.body;
}

function verifyEnvelope(value, publicKey, label) {
  assert(value && Object.keys(value).sort().join(',') === 'body,signature', `${label} envelope malformed`);
  assert(verify(null, Buffer.from(canonicalize(value.body)), publicKey, Buffer.from(value.signature, 'base64')),
    `${label} signature invalid`);
  return value.body;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateDirectory(directory) {
  let value;
  try { value = await lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    value = await lstat(directory);
  }
  assert(value.isDirectory() && !value.isSymbolicLink() && (value.mode & 0o077) === 0,
    'evidence authority directory must be owner-only');
}

async function bytesIfPresent(path) {
  try {
    const value = await lstat(path);
    assert(value.isFile() && !value.isSymbolicLink(), 'authority record must be a regular file');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function immutable(path, bytes) {
  const existing = await bytesIfPresent(path);
  if (existing !== null) {
    assert(existing === bytes, 'immutable authority record mutation or conflicting update');
    return false;
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert(await readFile(path, 'utf8') === bytes, 'immutable authority record mutation or conflicting update');
  } finally { await unlink(temporary).catch(() => {}); }
  await syncDirectory(resolve(path, '..'));
  return true;
}

function safeIntent(value) {
  assert(typeof value === 'string' && INTENT.test(value), 'malformed execution intent identifier');
  return value;
}

function authenticate(expected, supplied) {
  assert(typeof supplied === 'string' && supplied.length > 0, 'unauthorized evidence authority request');
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  assert(left.length === right.length && timingSafeEqual(left, right), 'unauthorized evidence authority request');
}

function validateFinalize(input) {
  const keys = ['adapterHash','adapterPackageDigest','binding','bundle','execution_intent_id','request','request_hash'];
  assert(input && Object.keys(input).sort().join(',') === keys.sort().join(','), 'malformed finalization input');
  safeIntent(input.execution_intent_id);
  assert(input.request?.idempotencyKey === input.execution_intent_id && sha256(input.request) === input.request_hash,
    'request provenance/hash mismatch');
  assert(HASH.test(input.adapterHash) && HASH.test(input.adapterPackageDigest) &&
    HASH.test(input.binding?.calibration_parameter_set_hash) && HASH.test(input.binding?.policy_manifest_hash),
  'malformed finalization provenance');
  assert(input.bundle?.run_id && Array.isArray(input.bundle.events) && input.bundle.events.length > 0,
    'malformed canonical evidence bundle');
  verifyEvidenceIntegrity(input.bundle);
}

export function createCalibrationEvidenceAuthority({ directory, credential, evidencePrivateKey,
  evidenceHeadPrivateKey, authorityId, trustedHeadDirectory = null, authorizeRequest = null,
  authorizeFinalization = null, receiptMode = 'EMPIRICAL_CALIBRATION', fault = async () => {} }) {
  assert(typeof credential === 'string' && credential.length >= 16, 'evidence authority credential is unavailable');
  assert(typeof authorityId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(authorityId),
    'invalid evidence authority identity');
  directory = resolve(directory);
  const evidenceKey = createPrivateKey(evidencePrivateKey), headKey = createPrivateKey(evidenceHeadPrivateKey);
  assert(evidenceKey.asymmetricKeyType === 'ed25519' && headKey.asymmetricKeyType === 'ed25519',
    'evidence authority requires Ed25519 private keys');
  const evidencePublicKey = createPublicKey(evidenceKey), headPublicKey = createPublicKey(headKey);
  const evidenceKeyId = keyId(evidencePublicKey), headKeyId = keyId(headPublicKey);
  assert(evidenceKeyId !== headKeyId, 'evidence and evidence-head authorities must be cryptographically distinct');
  const paths = Object.freeze({ intents: join(directory, 'execution-intents'), claims: join(directory, 'finalization-claims'),
    objects: join(directory, 'evidence-objects'),
    finalizations: join(directory, 'finalizations'), pending: join(directory, 'pending-finalizations'),
    heads: join(directory, 'authority-heads') });
  const anchorDirectory = trustedHeadDirectory === null ? null : resolve(trustedHeadDirectory);
  const anchorPath = anchorDirectory === null ? null : join(anchorDirectory, 'evidence-head-anchor.json');
  let queue = Promise.resolve(), initialized = false;

  async function latestHead() {
    const names = (await readdir(paths.heads)).filter(name => /^\d{20}\.json$/.test(name)).sort();
    let prior = null;
    for (let index = 0; index < names.length; index += 1) {
      assert(names[index] === HEAD_NAME(index), 'evidence authority head sequence gap or rollback');
      const raw = await readFile(join(paths.heads, names[index]), 'utf8');
      const value = JSON.parse(raw);
      assert(canonicalize(value) === raw, 'evidence authority head is not canonical');
      const body = verifyEnvelope(value, headPublicKey, 'evidence authority head');
      assertValidSchema(body, 'calibration-evidence-authority-head.schema.json');
      assert(body.authority_id === authorityId && body.evidence_key_id === evidenceKeyId &&
        body.evidence_head_key_id === headKeyId && body.generation === index && body.parent === prior,
      'evidence authority head chain conflict or rollback');
      prior = sha256(value);
    }
    return names.length ? { generation: names.length - 1, digest: prior } : null;
  }

  async function readAnchor() {
    if (anchorPath === null) return undefined;
    const raw = await bytesIfPresent(anchorPath);
    if (raw === null) return { present: false, head: null };
    const value = JSON.parse(raw);
    assert(canonicalize(value) === raw, 'evidence-head external anchor is not canonical');
    const body = verifyEnvelope(value, headPublicKey, 'evidence-head external anchor');
    assert(body.version === 'phase-a-evidence-head-anchor-1.0.0' && body.authority_id === authorityId &&
      body.evidence_head_key_id === headKeyId && (body.head === null ||
        Number.isSafeInteger(body.head.generation) && HASH.test(body.head.digest)),
    'evidence-head external anchor malformed');
    return { present: true, head: body.head };
  }

  async function writeAnchor(head) {
    if (anchorPath === null) return;
    const value = envelope({ version: 'phase-a-evidence-head-anchor-1.0.0', authority_id: authorityId,
      evidence_head_key_id: headKeyId, head }, headKey);
    const temporary = anchorPath + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonicalize(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, anchorPath);
    await syncDirectory(anchorDirectory);
  }

  async function reconcileAnchor(actual) {
    if (anchorPath === null) return;
    const anchor = await readAnchor();
    assert(anchor.present, 'provisioned evidence-head external anchor is missing');
    const anchored = anchor.head;
    if (anchored === undefined) return;
    if (anchored !== null) {
      assert(actual !== null && actual.generation >= anchored.generation,
        'evidence authority rollback precedes externally anchored head');
      const anchoredRaw = await readFile(join(paths.heads, HEAD_NAME(anchored.generation)), 'utf8');
      assert(sha256(JSON.parse(anchoredRaw)) === anchored.digest,
        'evidence authority history conflicts from externally anchored head');
    }
    if (canonicalize(anchored) !== canonicalize(actual)) await writeAnchor(actual);
  }

  async function completePending(pending) {
    const current = await latestHead();
    const expectedGeneration = (current?.generation ?? -1) + 1;
    if (pending.authority_head.body.generation > expectedGeneration)
      throw new Error('evidence authority pending head skips monotonic generation');
    if (pending.authority_head.body.generation === expectedGeneration) {
      assert(pending.authority_head.body.parent === (current?.digest ?? null), 'evidence authority conflicting/stale head update');
      await immutable(join(paths.heads, HEAD_NAME(expectedGeneration)), canonicalize(pending.authority_head));
      await fault('after_evidence_head_advanced_before_finalization', {
        execution_intent_id: pending.execution_intent_id, generation: expectedGeneration });
    } else {
      const published = await readFile(join(paths.heads, HEAD_NAME(pending.authority_head.body.generation)), 'utf8');
      assert(published === canonicalize(pending.authority_head), 'evidence authority conflicting finalized head');
    }
    await immutable(join(paths.finalizations, pending.execution_intent_id + '.json'), canonicalize(pending.finalization));
    await fault('after_finalization_before_head_acknowledgement', {
      execution_intent_id: pending.execution_intent_id, generation: pending.authority_head.body.generation });
    await reconcileAnchor(await latestHead());
  }

  async function initialize() {
    await privateDirectory(directory);
    if (anchorDirectory !== null) await privateDirectory(anchorDirectory);
    for (const path of Object.values(paths)) await privateDirectory(path);
    await syncDirectory(directory);
    await latestHead();
    const pendings = (await readdir(paths.pending)).filter(name => INTENT.test(name.slice(0, -5)) && name.endsWith('.json')).sort();
    for (const name of pendings) {
      const raw = await readFile(join(paths.pending, name), 'utf8'), pending = JSON.parse(raw);
      assert(canonicalize(pending) === raw && pending.execution_intent_id === name.slice(0, -5),
        'malformed pending authority transaction');
      await completePending(pending);
    }
    await verifyCalibrationEvidenceAuthority({ directory, evidencePublicKey, evidenceHeadPublicKey: headPublicKey, authorityId });
    await reconcileAnchor(await latestHead());
    initialized = true;
    return { version: SERVICE_VERSION, authority_id: authorityId, evidence_key_id: evidenceKeyId,
      evidence_head_key_id: headKeyId, head: await latestHead() };
  }

  const serialized = work => {
    const result = queue.then(async () => {
      await privateDirectory(directory);
      // SQLite's OS-backed write lock is automatically released on process
      // death. A killed authority therefore cannot strand a persistent lease.
      const lockPath = join(directory, 'authority-operation-lock.sqlite');
      const database = new DatabaseSync(lockPath);
      await chmod(lockPath, 0o600);
      try {
        database.exec('PRAGMA busy_timeout=0');
        try { database.exec('BEGIN IMMEDIATE'); }
        catch (error) {
          if (/locked|busy/i.test(error.message)) {
            const busy = new Error('evidence authority operation already claimed by another process');
            busy.code = 'EVIDENCE_AUTHORITY_BUSY'; throw busy;
          }
          throw error;
        }
        try { if (!initialized) await initialize(); return await work(); }
        finally { database.exec('ROLLBACK'); }
      } finally { database.close(); }
    });
    queue = result.catch(() => {});
    return result;
  };

  async function getIntent(executionIntentId) {
    return serialized(async () => {
      const finalizedRaw = await bytesIfPresent(join(paths.finalizations, safeIntent(executionIntentId) + '.json'));
      if (finalizedRaw !== null) {
        const finalized = JSON.parse(finalizedRaw);
        assert(canonicalize(finalized) === finalizedRaw && finalized.execution_intent_id === executionIntentId,
          'durable finalized execution intent tampered');
        return { request_hash: finalized.request_hash, result: clone(finalized.result) };
      }
      const raw = await bytesIfPresent(join(paths.intents, safeIntent(executionIntentId) + '.json'));
      if (raw === null) return null;
      const stored = JSON.parse(raw), recordBytes = canonicalize(stored.record);
      assert(canonicalize(stored) === raw && stored.execution_intent_id === executionIntentId &&
        stored.record_hash === sha256(recordBytes), 'durable execution intent content address mismatch');
      return clone(stored.record);
    });
  }

  async function observeIntent(executionIntentId) {
    return serialized(async () => {
      const id = safeIntent(executionIntentId);
      let pendingRaw = await bytesIfPresent(join(paths.pending, id + '.json'));
      if (pendingRaw !== null && await bytesIfPresent(join(paths.finalizations, id + '.json')) === null) {
        const pending = JSON.parse(pendingRaw);
        assert(canonicalize(pending) === pendingRaw && pending.execution_intent_id === id,
          'durable pending execution intent tampered');
        await completePending(pending);
        pendingRaw = await bytesIfPresent(join(paths.pending, id + '.json'));
      }
      const finalizedRaw = await bytesIfPresent(join(paths.finalizations, id + '.json'));
      const intentRaw = await bytesIfPresent(join(paths.intents, id + '.json'));
      let state = 'ABSENT', requestHash = null, result = null, finalizationHash = null;
      if (finalizedRaw !== null) {
        const finalized = JSON.parse(finalizedRaw);
        assert(canonicalize(finalized) === finalizedRaw && finalized.execution_intent_id === id,
          'durable finalized execution intent tampered');
        state = 'FINALIZED'; requestHash = finalized.request_hash;
        result = clone(finalized.result); finalizationHash = sha256(finalized);
      } else if (pendingRaw !== null) {
        const pending = JSON.parse(pendingRaw);
        assert(canonicalize(pending) === pendingRaw && pending.execution_intent_id === id,
          'durable pending execution intent tampered');
        state = 'FINALIZATION_PENDING'; requestHash = pending.finalization.request_hash;
        finalizationHash = sha256(pending.finalization);
      } else if (intentRaw !== null) {
        const stored = JSON.parse(intentRaw);
        assert(canonicalize(stored) === intentRaw && stored.execution_intent_id === id &&
          stored.record_hash === sha256(canonicalize(stored.record)), 'durable execution intent content address mismatch');
        state = 'INTENT_STORED'; requestHash = stored.record.request_hash ?? null;
      }
      const head = await latestHead();
      const headEnvelope = head === null ? null : JSON.parse(await readFile(join(paths.heads, HEAD_NAME(head.generation)), 'utf8'));
      const body = { version: 'phase-a-evidence-authority-observation-1.0.0', authority_id: authorityId,
        execution_intent_id: id, state, request_hash: requestHash, result,
        finalization_hash: finalizationHash, authority_head: headEnvelope };
      assertValidSchema(body, 'calibration-evidence-authority-observation.schema.json');
      return envelope(body, headKey);
    });
  }

  async function putIntent(executionIntentId, record) {
    return serialized(async () => {
      safeIntent(executionIntentId);
      assert(record && typeof record === 'object' && !Array.isArray(record), 'malformed execution intent record');
      const recordBytes = canonicalize(record), stored = { execution_intent_id: executionIntentId,
        record: clone(record), record_hash: sha256(recordBytes) };
      // Hash only the immutable payload, not the containing record.
      await immutable(join(paths.intents, executionIntentId + '.json'), canonicalize(stored));
      return { status: 'STORED_IDEMPOTENT' };
    });
  }

  async function finalize(input) {
    return serialized(async () => {
      assert(typeof authorizeFinalization === 'function', 'production evidence authority lacks campaign authorization');
      await authorizeFinalization(input);
      validateFinalize(input);
      const id = input.execution_intent_id, intentRaw = await bytesIfPresent(join(paths.intents, id + '.json'));
      if (intentRaw === null) {
        const record = { request_hash: input.request_hash, request: clone(input.request), binding: clone(input.binding),
          adapter_hash: input.adapterHash, adapter_package_digest: input.adapterPackageDigest };
        const stored = { execution_intent_id: id, record, record_hash: sha256(canonicalize(record)) };
        await immutable(join(paths.intents, id + '.json'), canonicalize(stored));
      } else {
        const intent = JSON.parse(intentRaw).record;
        if (intent.request_hash !== undefined) assert(intent.request_hash === input.request_hash, 'execution intent request provenance conflict');
      }
      const priorRaw = await bytesIfPresent(join(paths.finalizations, id + '.json'));
      if (priorRaw !== null) {
        const prior = JSON.parse(priorRaw);
        assert(prior.input_hash === sha256(input), 'finalization mutation/conflict for execution intent');
        return clone(prior.result);
      }
      const bundle = clone(input.bundle), object = { bundle, service_state: null, analysis_package: null };
      const objectBytes = canonicalize(object), objectHash = sha256(objectBytes);
      const claim = { version: 'phase-a-evidence-finalization-claim-1.0.0', execution_intent_id: id,
        request_hash: input.request_hash, request: clone(input.request), binding: clone(input.binding),
        adapter_hash: input.adapterHash, adapter_package_digest: input.adapterPackageDigest,
        finalization_input_hash: sha256(input), evidence_object_hash: objectHash };
      await immutable(join(paths.claims, id + '.json'), canonicalize(claim));
      await fault('before_evidence_object_commit', { execution_intent_id: id, event_count: bundle.events.length });
      await immutable(join(paths.objects, objectHash + '.json'), objectBytes);
      await fault('after_evidence_object_commit_before_attestation', { execution_intent_id: id,
        event_count: bundle.events.length, evidence_object_hash: objectHash });
      const eventHead = bundle.events.at(-1).integrity.canonical_bytes_hash;
      const archiveBody = { version: 'pilot0-ed25519-archive-v1', run_id: bundle.run_id, key_id: evidenceKeyId,
        generation: 0, parent: null, object_hash: objectHash, event_count: bundle.events.length,
        event_head: eventHead, status: 'COMPLETE', payload_classification_changes: [] };
      const archiveEnvelope = envelope(archiveBody, evidenceKey);
      const archiveHead = { generation: 0, digest: sha256(archiveEnvelope) };
      const evidenceHeadReceipt = envelope({ version: 'phase-a-evidence-head-1.0.0', mode: receiptMode,
        run_id: bundle.run_id, evidence_key_id: evidenceKeyId, adapter_hash: input.adapterHash, head: archiveHead }, headKey);
      const adapterReceipt = envelope({ version: 'phase-a-adapter-execution-receipt-1.0.0', mode: receiptMode,
        run_id: bundle.run_id, seed: input.request.seed, parameter_set_hash: input.binding.calibration_parameter_set_hash,
        execution_request_hash: sha256(input.request), policy_manifest_hash: input.binding.policy_manifest_hash,
        adapter_hash: input.adapterHash, adapter_executable_hash: input.adapterPackageDigest,
        adapter_package_digest: input.adapterPackageDigest, evidence_hash: sha256(bundle) }, headKey);
      const result = { bundle, archive_export: { version: 'pilot0-ed25519-archive-v1', authorization_domain: 'trusted_replay',
        manifests: [archiveEnvelope], object }, evidence_head_receipt: evidenceHeadReceipt,
        adapter_execution_receipt: adapterReceipt };
      const finalization = { version: SERVICE_VERSION, execution_intent_id: id, run_id: bundle.run_id,
        request_hash: input.request_hash, input_hash: sha256(input), evidence_object_hash: objectHash, result };
      const current = await latestHead(), generation = (current?.generation ?? -1) + 1;
      const authorityHeadBody = { version: 'phase-a-evidence-authority-head-1.0.0', authority_id: authorityId,
        generation, parent: current?.digest ?? null, execution_intent_id: id, run_id: bundle.run_id,
        finalized_record_hash: sha256(finalization), evidence_object_hash: objectHash,
        evidence_key_id: evidenceKeyId, evidence_head_key_id: headKeyId };
      assertValidSchema(authorityHeadBody, 'calibration-evidence-authority-head.schema.json');
      const pending = { execution_intent_id: id, finalization, authority_head: envelope(authorityHeadBody, headKey) };
      await fault('during_final_attempt_attestation', { execution_intent_id: id, generation });
      await immutable(join(paths.pending, id + '.json'), canonicalize(pending));
      await fault('after_finalization_staged_before_head_update', { execution_intent_id: id, generation });
      await completePending(pending);
      return clone(result);
    });
  }

  async function handle({ credential: supplied, operation, execution_intent_id, input }) {
    try {
      authenticate(credential, supplied);
      safeIntent(execution_intent_id);
      assert(input?.execution_intent_id === execution_intent_id, 'request intent binding malformed');
      assert(['GET_EXECUTION_INTENT','OBSERVE_EXECUTION_INTENT','PUT_EXECUTION_INTENT','FINALIZE_EXECUTION_INTENT'].includes(operation),
        'unsupported evidence authority operation');
      if (operation === 'PUT_EXECUTION_INTENT') assert(input.record && typeof input.record === 'object' && !Array.isArray(input.record),
        'malformed execution intent record');
      if (operation === 'FINALIZE_EXECUTION_INTENT') validateFinalize(input);
    } catch { throw evidenceAuthorityRequestRejected(); }
    if (typeof authorizeRequest === 'function') await authorizeRequest({ operation, execution_intent_id, input });
    if (operation === 'GET_EXECUTION_INTENT') return { record: await getIntent(execution_intent_id) };
    if (operation === 'OBSERVE_EXECUTION_INTENT') return { observation: await observeIntent(execution_intent_id) };
    if (operation === 'PUT_EXECUTION_INTENT') return putIntent(execution_intent_id, input.record);
    if (operation === 'FINALIZE_EXECUTION_INTENT') return finalize(input);
    throw new Error('unsupported evidence authority operation');
  }

  const initializeSerialized = () => serialized(async () => ({ version: SERVICE_VERSION, authority_id: authorityId,
    evidence_key_id: evidenceKeyId, evidence_head_key_id: headKeyId, head: await latestHead() }));
  return Object.freeze({ version: SERVICE_VERSION, trustDomain: 'EXTERNAL_EVIDENCE_AUTHORITY',
    authorizationScoped: typeof authorizeRequest === 'function' && typeof authorizeFinalization === 'function', initialize: initializeSerialized,
    authenticateRequest(supplied) { try { authenticate(credential, supplied); return true; }
      catch { throw evidenceAuthorityRequestRejected(); } },
    getIntent, observeIntent, putIntent, finalize, handle, evidenceKeyId, evidenceHeadKeyId: headKeyId, authorityId, directory });
}

export async function verifyCalibrationEvidenceAuthority({ directory, evidencePublicKey, evidenceHeadPublicKey, authorityId,
  trustedHead = undefined }) {
  directory = resolve(directory);
  const evidenceKey = evidencePublicKey?.type === 'public' ? evidencePublicKey : createPublicKey(evidencePublicKey);
  const headKey = evidenceHeadPublicKey?.type === 'public' ? evidenceHeadPublicKey : createPublicKey(evidenceHeadPublicKey);
  const evidenceKeyId = keyId(evidenceKey), headKeyId = keyId(headKey);
  const headsDirectory = join(directory, 'authority-heads'), finalizations = join(directory, 'finalizations');
  const claimsDirectory = join(directory, 'finalization-claims'), objectsDirectory = join(directory, 'evidence-objects');
  const names = (await readdir(headsDirectory)).filter(name => /^\d{20}\.json$/.test(name)).sort();
  let prior = null;
  for (let index = 0; index < names.length; index += 1) {
    assert(names[index] === HEAD_NAME(index), 'authority head sequence gap or rollback');
    const raw = await readFile(join(headsDirectory, names[index]), 'utf8'), value = JSON.parse(raw);
    assert(canonicalize(value) === raw, 'authority head is not canonical');
    const body = verifyEnvelope(value, headKey, 'authority head');
    assertValidSchema(body, 'calibration-evidence-authority-head.schema.json');
    assert(body.authority_id === authorityId && body.generation === index && body.parent === prior &&
      body.evidence_key_id === evidenceKeyId && body.evidence_head_key_id === headKeyId,
    'authority head chain/key conflict or rollback');
    const finalizedRaw = await readFile(join(finalizations, body.execution_intent_id + '.json'), 'utf8');
    const finalized = JSON.parse(finalizedRaw);
    assert(canonicalize(finalized) === finalizedRaw && sha256(finalized) === body.finalized_record_hash,
      'authority finalized record hash mismatch');
    const archive = finalized.result.archive_export.manifests[0], archiveBody = verifyEnvelope(archive, evidenceKey, 'evidence archive');
    assert(archiveBody.key_id === evidenceKeyId && archiveBody.run_id === body.run_id &&
      archiveBody.object_hash === body.evidence_object_hash && sha256(archive) === finalized.result.evidence_head_receipt.body.head.digest,
    'signed evidence archive provenance mismatch');
    const receiptBody = verifyEnvelope(finalized.result.evidence_head_receipt, headKey, 'evidence head receipt');
    const adapterReceipt = verifyEnvelope(finalized.result.adapter_execution_receipt, headKey, 'adapter execution receipt');
    assert(receiptBody.run_id === body.run_id && receiptBody.evidence_key_id === evidenceKeyId &&
      receiptBody.head.generation === 0 && receiptBody.head.digest === sha256(archive) && adapterReceipt.run_id === body.run_id,
    'signed evidence-head provenance mismatch');
    assert(finalized.evidence_object_hash === body.evidence_object_hash && finalized.run_id === body.run_id,
      'authority provenance linkage mismatch');
    const objectRaw = await readFile(join(directory, 'evidence-objects', body.evidence_object_hash + '.json'), 'utf8');
    assert(sha256(objectRaw) === body.evidence_object_hash && canonicalize(JSON.parse(objectRaw)) === objectRaw,
      'authority content-addressed evidence tampered');
    const object = JSON.parse(objectRaw);
    assert(canonicalize(finalized.result.archive_export.object) === canonicalize(object) &&
      canonicalize(finalized.result.bundle) === canonicalize(object.bundle), 'authority archive/result object mismatch');
    verifyEvidenceIntegrity(object.bundle);
    const claimRaw = await readFile(join(claimsDirectory, body.execution_intent_id + '.json'), 'utf8');
    const claim = JSON.parse(claimRaw);
    assert(canonicalize(claim) === claimRaw && claim.execution_intent_id === body.execution_intent_id &&
      claim.request_hash === finalized.request_hash && claim.evidence_object_hash === finalized.evidence_object_hash &&
      claim.finalization_input_hash === finalized.input_hash &&
      claim.finalization_input_hash === sha256({ execution_intent_id: claim.execution_intent_id,
        request_hash: claim.request_hash, bundle: object.bundle, request: claim.request, binding: claim.binding,
        adapterHash: claim.adapter_hash, adapterPackageDigest: claim.adapter_package_digest }),
    'authority finalized record lacks its exact immutable finalization claim');
    prior = sha256(value);
  }
  const finalizedNames = (await readdir(finalizations)).filter(name => name.endsWith('.json')).sort();
  assert(finalizedNames.length === names.length, 'authority finalized inventory conflicts with monotonic head history');
  const objectNames = (await readdir(objectsDirectory)).filter(name => name.endsWith('.json')).sort();
  let claimNames, claimsDirectoryPresent = true;
  try { claimNames = (await readdir(claimsDirectory)).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; claimsDirectoryPresent = false; claimNames = []; }
  assert(claimsDirectoryPresent || names.length === 0 && finalizedNames.length === 0 && objectNames.length === 0,
    'legacy authority store lacks finalization claims for nonempty evidence');
  const claimedObjects = new Set();
  for (const name of claimNames) {
    const raw = await readFile(join(claimsDirectory, name), 'utf8'), claim = JSON.parse(raw);
    assert(canonicalize(claim) === raw && canonicalize(Object.keys(claim).sort()) === canonicalize([
      'adapter_hash','adapter_package_digest','binding','evidence_object_hash','execution_intent_id',
      'finalization_input_hash','request','request_hash','version'].sort()) &&
      claim.version === 'phase-a-evidence-finalization-claim-1.0.0' &&
      name === claim.execution_intent_id + '.json' && HASH.test(claim.request_hash) && HASH.test(claim.finalization_input_hash) &&
      HASH.test(claim.evidence_object_hash), 'authority finalization claim malformed');
    claimedObjects.add(claim.evidence_object_hash);
  }
  assert(objectNames.every(name => claimedObjects.has(name.slice(0, -5))),
    'authority evidence object lacks an immutable finalization claim');
  const actualHead = names.length ? { generation: names.length - 1, digest: prior } : null;
  if (trustedHead !== undefined) assert(canonicalize(actualHead) === canonicalize(trustedHead),
    'authority rollback differs from externally retained trusted head');
  return { version: SERVICE_VERSION, authority_id: authorityId, finalized_count: names.length,
    head: actualHead };
}

export function createCalibrationEvidenceAuthorityHttpsServer({ authority, certificate, privateKey, host = '127.0.0.1', port = 0,
  maxRequestBytes = EVIDENCE_AUTHORITY_MAX_REQUEST_BYTES, maxConcurrentRequests = 1,
  diagnostic = () => {}, transportFault = async () => {} }) {
  assert(authority?.version === SERVICE_VERSION, 'production evidence authority service required');
  assert(certificate && privateKey, 'TLS certificate and private key are required');
  assert(Number.isSafeInteger(maxRequestBytes) && maxRequestBytes > 0, 'evidence authority request limit invalid');
  assert(Number.isSafeInteger(maxConcurrentRequests) && maxConcurrentRequests > 0 && maxConcurrentRequests <= 16,
    'evidence authority concurrency limit invalid');
  let server, endpoint, activeRequests = 0;
  return Object.freeze({
    get endpoint() { return endpoint; },
    async start() {
      assert(!server, 'HTTPS evidence authority already started');
      await authority.initialize();
      server = createHttpsServer({ cert: certificate, key: privateKey }, async (request, response) => {
        let envelopeValidated = false, admitted = false;
        try {
          assert(request.method === 'POST' && request.url === '/v1/execution-intents', 'malformed authority route');
          const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1];
          authority.authenticateRequest(token);
          if (activeRequests >= maxConcurrentRequests) {
            const error = new Error('authority request concurrency limit reached');
            error.code = 'EVIDENCE_AUTHORITY_BUSY'; error.boundary = 'REQUEST_ADMISSION'; throw error;
          }
          const declaredLength = Number(request.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
            const error = new Error('authority request exceeds configured byte limit');
            error.code = 'EVIDENCE_AUTHORITY_REQUEST_TOO_LARGE'; error.boundary = 'REQUEST_BODY_INGESTION'; throw error;
          }
          activeRequests += 1; admitted = true;
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > maxRequestBytes) {
              const error = new Error('authority request exceeds configured byte limit');
              error.code = 'EVIDENCE_AUTHORITY_REQUEST_TOO_LARGE';
              error.boundary = 'REQUEST_BODY_INGESTION';
              throw error;
            }
            chunks.push(chunk);
          }
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert(message.version === REQUEST_VERSION && message.execution_intent_id === message.input?.execution_intent_id,
            'malformed authority request envelope');
          envelopeValidated = true;
          const result = await authority.handle({ credential: token, operation: message.operation,
            execution_intent_id: message.execution_intent_id, input: message.input });
          await transportFault('after_authority_commit_before_acknowledgement', {
            execution_intent_id: message.execution_intent_id, operation: message.operation });
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(canonicalize({ execution_intent_id: message.execution_intent_id, ...result }));
        } catch (error) {
          try { diagnostic(Object.freeze({ code: typeof error?.code === 'string' ? error.code : 'EVIDENCE_AUTHORITY_INTERNAL',
            boundary: error?.boundary ?? (envelopeValidated ? 'AUTHORIZED_REQUEST_PROCESSING' : 'REQUEST_BODY_INGESTION') })); }
          catch { /* diagnostics cannot alter the closed authority response */ }
          response.writeHead(error?.code === 'EVIDENCE_AUTHORITY_BUSY' ? 503 : !envelopeValidated ? 400
            : error?.code === 'EVIDENCE_AUTHORITY_REQUEST_REJECTED' ? 400 : 500,
            { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end('{"error":"rejected"}');
        } finally { if (admitted) activeRequests -= 1; }
      });
      await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(port, host, resolveStart); });
      const address = server.address();
      endpoint = `https://${host.includes(':') ? `[${host}]` : host}:${address.port}/v1/execution-intents`;
      return endpoint;
    },
    async stop() {
      if (!server) return;
      await new Promise((resolveStop, reject) => server.close(error => error ? reject(error) : resolveStop()));
      server = null; endpoint = undefined;
    }
  });
}
