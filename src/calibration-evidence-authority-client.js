import { createHash, createPublicKey, verify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { assert, canonicalize, clone, sha256 } from './core.js';
import { CalibrationExecutionError, authorityAuthorization, authorityProtocol,
  infrastructureAuthority, infrastructureDeadline } from './calibration-errors.js';
import { assertValidSchema } from './schema.js';

const POSITIVE_TIMEOUT = value => Number.isSafeInteger(value) && value > 0 && value <= 300_000;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 768 * 1024 * 1024;
const keyIdentifier = key => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');

function validateObservationState(body) {
  const absent = body.state === 'ABSENT';
  const stored = body.state === 'INTENT_STORED';
  const pending = body.state === 'FINALIZATION_PENDING';
  const finalized = body.state === 'FINALIZED';
  assert(absent ? body.request_hash === null && body.result === null && body.finalization_hash === null
    : stored ? body.request_hash !== null && body.result === null && body.finalization_hash === null
      : pending ? body.request_hash !== null && body.result === null && body.finalization_hash !== null
        : finalized && body.request_hash !== null && body.result !== null && body.finalization_hash !== null,
  'authority observation state fields conflict');
}

export function validateEvidenceAuthorityConfiguration(configuration) {
  assert(configuration?.version === 'phase-a-evidence-authority-client-1.1.0' &&
    configuration.request_version === 'phase-a-evidence-authority-request-1.1.0' &&
    POSITIVE_TIMEOUT(configuration.request_timeout_ms) && POSITIVE_TIMEOUT(configuration.worker_timeout_ms),
  'invalid signed evidence-authority deadline configuration');
  const endpoint = new URL(configuration.endpoint);
  const transportValid = configuration.transport === 'HTTPS_PRODUCTION' && endpoint.protocol === 'https:' ||
    configuration.transport === 'INSECURE_LOOPBACK_CONFORMANCE_ONLY' && endpoint.protocol === 'http:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname);
  assert(transportValid && endpoint.username === '' && endpoint.password === '' && !endpoint.hash,
    'invalid signed evidence-authority endpoint');
  if (configuration.tls_ca_resource !== undefined || configuration.tls_ca_sha256 !== undefined) {
    assert(configuration.transport === 'HTTPS_PRODUCTION' &&
      typeof configuration.tls_ca_resource === 'string' && /^config\/[A-Za-z0-9._-]+\.pem$/.test(configuration.tls_ca_resource) &&
      typeof configuration.tls_ca_sha256 === 'string' && /^[a-f0-9]{64}$/.test(configuration.tls_ca_sha256),
    'invalid signed evidence-authority CA pin');
  }
  return Object.freeze({ ...clone(configuration), host: endpoint.host });
}

function pinnedHttpsFetch(certificateAuthority) {
  assert(certificateAuthority, 'signed evidence-authority CA certificate unavailable');
  return (url, options) => new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const request = httpsRequest(endpoint, {
      method: options.method,
      ca: certificateAuthority,
      headers: options.headers,
      signal: options.signal
    }, response => {
      const chunks = []; let size = 0, exceeded = false;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { exceeded = true; request.destroy(new Error('authority response exceeds limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (exceeded) return;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          async json() { return JSON.parse(body); } });
      });
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

export function createEvidenceAuthorityClient({ configuration, credential, fetchImplementation = null,
  certificateAuthority = null }) {
  const locked = validateEvidenceAuthorityConfiguration(configuration);
  if (locked.transport === 'HTTPS_PRODUCTION' && fetchImplementation === null) {
    assert(locked.tls_ca_sha256 && certificateAuthority &&
      createHash('sha256').update(certificateAuthority).digest('hex') === locked.tls_ca_sha256,
      'signed evidence-authority CA certificate digest mismatch');
    fetchImplementation = pinnedHttpsFetch(certificateAuthority);
  }
  if (locked.transport === 'INSECURE_LOOPBACK_CONFORMANCE_ONLY' && fetchImplementation === null)
    fetchImplementation = globalThis.fetch;
  assert(typeof fetchImplementation === 'function', 'evidence authority fetch implementation unavailable');
  const receiptKey = () => {
    let key;
    try { key = createPublicKey(locked.observation_public_key); }
    catch { throw authorityProtocol('signed authority receipt trust key unavailable'); }
    if (key.asymmetricKeyType !== 'ed25519') throw authorityProtocol('signed authority receipt trust key invalid');
    return key;
  };
  const token = typeof credential === 'function' ? credential : () => credential;
  async function request(operation, input) {
    let bearer;
    try { bearer = token(); }
    catch { throw authorityAuthorization('evidence authority credential resolution failed'); }
    if (typeof bearer !== 'string' || bearer.length === 0)
      throw authorityAuthorization('evidence authority credential unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), locked.request_timeout_ms);
    try {
      const response = await fetchImplementation(locked.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
        body: canonicalize({ version: locked.request_version, operation, execution_intent_id: input.execution_intent_id, input }) });
      if (!response || typeof response.ok !== 'boolean' || !Number.isSafeInteger(response.status))
        throw authorityProtocol('evidence authority returned an invalid HTTP response');
      if (!response.ok) {
        if (response.status >= 500) throw infrastructureAuthority('evidence authority service unavailable');
        throw authorityAuthorization('evidence authority authorization/request rejected');
      }
      let result;
      try { result = await response.json(); }
      catch { throw authorityProtocol('evidence authority returned malformed JSON'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.execution_intent_id !== input.execution_intent_id)
        throw authorityProtocol('evidence authority response intent binding invalid');
      const bound = clone(result);
      delete bound.execution_intent_id;
      return bound;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError')
        throw infrastructureDeadline('evidence authority request deadline exceeded');
      if (error instanceof CalibrationExecutionError) throw error;
      // Fetch deliberately collapses DNS, connection refusal and TLS failures
      // into implementation-specific TypeErrors. Never forward their messages,
      // causes, host details or credential-bearing request data.
      throw infrastructureAuthority('evidence authority transport unavailable');
    } finally { clearTimeout(timer); }
  }
  const observeIntent = async execution_intent_id => {
    const result = await request('OBSERVE_EXECUTION_INTENT', { execution_intent_id });
    const observation = result.observation;
    let key;
    try { key = createPublicKey(locked.observation_public_key); }
    catch { throw authorityProtocol('signed authority-observation trust key unavailable'); }
    try {
      assert(key.asymmetricKeyType === 'ed25519', 'authority observation key must be Ed25519');
      assert(observation && canonicalize(Object.keys(observation).sort()) === canonicalize(['body','signature']),
        'authority observation envelope malformed');
      assertValidSchema(observation.body, 'calibration-evidence-authority-observation.schema.json');
      validateObservationState(observation.body);
      assert(observation.body.execution_intent_id === execution_intent_id,
        'authority observation intent mismatch');
      assert(verify(null, Buffer.from(canonicalize(observation.body)), key,
        Buffer.from(observation.signature ?? '', 'base64')), 'authority observation signature invalid');
      if (observation.body.authority_head !== null) {
        const head = observation.body.authority_head;
        assert(canonicalize(Object.keys(head).sort()) === canonicalize(['body','signature']),
          'authority head envelope malformed');
        assertValidSchema(head.body, 'calibration-evidence-authority-head.schema.json');
        assert(head.body.authority_id === observation.body.authority_id &&
          head.body.evidence_head_key_id === keyIdentifier(key) && verify(null, Buffer.from(canonicalize(head.body)), key,
            Buffer.from(head.signature ?? '', 'base64')), 'authority observation head identity invalid');
      }
    } catch { throw authorityProtocol('signed authority observation invalid'); }
    return { observation: clone(observation) };
  };
  const finalize = async input => {
    const result = await request('FINALIZE_EXECUTION_INTENT', input), key = receiptKey();
    try {
      const verifyEnvelope = (value, label) => {
        assert(value && canonicalize(Object.keys(value).sort()) === canonicalize(['body','signature']),
          `${label} envelope malformed`);
        assert(verify(null, Buffer.from(canonicalize(value.body)), key,
          Buffer.from(value.signature ?? '', 'base64')), `${label} signature invalid`);
        return value.body;
      };
      const head = verifyEnvelope(result.evidence_head_receipt, 'evidence-head receipt');
      const adapter = verifyEnvelope(result.adapter_execution_receipt, 'adapter execution receipt');
      assert(result.bundle?.run_id === input.bundle?.run_id &&
        canonicalize(result.bundle) === canonicalize(input.bundle), 'authority finalized bundle mismatch');
      assert(head.version === 'phase-a-evidence-head-1.0.0' && head.run_id === input.bundle.run_id &&
        head.adapter_hash === input.adapterHash && HASH.test(head.evidence_key_id) &&
        Number.isSafeInteger(head.head?.generation) && HASH.test(head.head?.digest),
      'evidence-head receipt binding invalid');
      assert(adapter.version === 'phase-a-adapter-execution-receipt-1.0.0' &&
        adapter.mode === head.mode && adapter.run_id === input.bundle.run_id && adapter.seed === input.request.seed &&
        adapter.parameter_set_hash === input.binding.calibration_parameter_set_hash &&
        adapter.execution_request_hash === sha256(input.request) &&
        adapter.policy_manifest_hash === input.binding.policy_manifest_hash && adapter.adapter_hash === input.adapterHash &&
        adapter.adapter_executable_hash === input.adapterPackageDigest &&
        adapter.adapter_package_digest === input.adapterPackageDigest && adapter.evidence_hash === sha256(input.bundle),
      'adapter execution receipt binding invalid');
    } catch (error) {
      if (error instanceof CalibrationExecutionError) throw error;
      throw authorityProtocol('signed authority finalization receipt invalid');
    }
    return result;
  };
  return Object.freeze({ configuration: locked, request,
    finalize,
    getIntent: execution_intent_id => request('GET_EXECUTION_INTENT', { execution_intent_id }),
    observeIntent,
    putIntent: (execution_intent_id, record) => request('PUT_EXECUTION_INTENT', { execution_intent_id, record }),
    package_binding_hash: sha256(configuration) });
}
