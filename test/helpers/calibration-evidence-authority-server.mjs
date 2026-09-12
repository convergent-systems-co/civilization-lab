import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createServer } from 'node:http';

// Node's test discovery executes JavaScript helpers under test/ directly. Treat
// that discovery invocation as a no-op; integration tests supply all three
// isolated authority credentials when they launch this helper as a child.
const launchedAsAuthority = Boolean(
  process.env.TEST_EVIDENCE_PRIVATE_KEY &&
  process.env.TEST_HEAD_PRIVATE_KEY &&
  process.env.TEST_AUTH_TOKEN
);

if (!launchedAsAuthority) process.exit(0);

const evidenceKey = createPrivateKey(process.env.TEST_EVIDENCE_PRIVATE_KEY);
const headKey = createPrivateKey(process.env.TEST_HEAD_PRIVATE_KEY);
const token = process.env.TEST_AUTH_TOKEN;
const canonicalize = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonicalize).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalize(value)).digest('hex');
const keyId = key => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
const signed = (body, key) => ({ body, signature: sign(null, Buffer.from(canonicalize(body)), key).toString('base64') });
const records = new Map(), sealed = new Map();

const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  try {
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + token) throw new Error('unauthorized');
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.version !== 'phase-a-evidence-authority-request-1.1.0' ||
      message.execution_intent_id !== message.input.execution_intent_id) throw new Error('version or intent binding');
    let result;
    if (message.operation === 'GET_EXECUTION_INTENT') result = { record: records.get(message.execution_intent_id) ?? null };
    else if (message.operation === 'OBSERVE_EXECUTION_INTENT') {
      const finalized = sealed.get(message.execution_intent_id), stored = records.get(message.execution_intent_id);
      const body = { version: 'phase-a-evidence-authority-observation-1.0.0', authority_id: 'integration-helper-authority',
        execution_intent_id: message.execution_intent_id,
        state: finalized ? 'FINALIZED' : stored ? 'INTENT_STORED' : 'ABSENT',
        request_hash: finalized?.requestHash ?? stored?.request_hash ?? null,
        result: finalized?.result ?? null, finalization_hash: finalized ? sha256(finalized) : null, authority_head: null };
      result = { observation: signed(body, headKey) };
    }
    else if (message.operation === 'PUT_EXECUTION_INTENT') {
      const prior = records.get(message.execution_intent_id);
      if (prior && sha256(prior) !== sha256(message.input.record)) throw new Error('intent mutation');
      records.set(message.execution_intent_id, message.input.record); result = { status: 'STORED_IDEMPOTENT' };
    } else if (message.operation === 'FINALIZE_EXECUTION_INTENT') {
      const { bundle, request: executionRequest, binding, adapterHash, adapterPackageDigest } = message.input;
      const prior = sealed.get(executionRequest.idempotencyKey);
      if (prior) {
        if (prior.requestHash !== sha256(executionRequest) || prior.evidenceHash !== sha256(bundle)) throw new Error('seal mutation');
        result = prior.result;
      } else {
        const object = { bundle, service_state: null, analysis_package: null };
        const archiveBody = { version: 'pilot0-ed25519-archive-v1', run_id: bundle.run_id, key_id: keyId(evidenceKey),
          generation: 0, parent: null, object_hash: sha256(object), event_count: bundle.events.length,
          event_head: bundle.events.at(-1).integrity.canonical_bytes_hash, status: 'COMPLETE', payload_classification_changes: [] };
        const archiveEnvelope = signed(archiveBody, evidenceKey), head = { generation: 0, digest: sha256(archiveEnvelope) };
        const headBody = { version: 'phase-a-evidence-head-1.0.0', mode: 'EMPIRICAL_CALIBRATION', run_id: bundle.run_id,
          evidence_key_id: keyId(evidenceKey), adapter_hash: adapterHash, head };
        const receiptBody = { version: 'phase-a-adapter-execution-receipt-1.0.0', mode: 'EMPIRICAL_CALIBRATION',
          run_id: bundle.run_id, seed: executionRequest.seed, parameter_set_hash: binding.calibration_parameter_set_hash,
          execution_request_hash: sha256(executionRequest), policy_manifest_hash: binding.policy_manifest_hash,
          adapter_hash: adapterHash, adapter_executable_hash: adapterPackageDigest,
          adapter_package_digest: adapterPackageDigest, evidence_hash: sha256(bundle) };
        result = { bundle, archive_export: { version: 'pilot0-ed25519-archive-v1', authorization_domain: 'trusted_replay',
          manifests: [archiveEnvelope], object }, evidence_head_receipt: signed(headBody, headKey),
          adapter_execution_receipt: signed(receiptBody, headKey) };
        sealed.set(executionRequest.idempotencyKey, { requestHash: sha256(executionRequest), evidenceHash: sha256(bundle), result });
        records.set(executionRequest.idempotencyKey, { request_hash: sha256(executionRequest), result });
      }
    } else throw new Error('operation');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(canonicalize({ execution_intent_id: message.execution_intent_id, ...result }));
  } catch (error) {
    process.stderr.write(`authority rejected request: ${error.message}\n`);
    response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"rejected"}');
  }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\n'));
