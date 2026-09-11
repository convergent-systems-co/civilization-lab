import { assert, canonicalize, clone, sha256 } from './core.js';
import { CalibrationExecutionError, authorityAuthorization, authorityProtocol,
  infrastructureAuthority, infrastructureDeadline } from './calibration-errors.js';

const POSITIVE_TIMEOUT = value => Number.isSafeInteger(value) && value > 0 && value <= 300_000;

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
  return Object.freeze({ ...clone(configuration), host: endpoint.host });
}

export function createEvidenceAuthorityClient({ configuration, credential, fetchImplementation = globalThis.fetch }) {
  const locked = validateEvidenceAuthorityConfiguration(configuration);
  assert(typeof fetchImplementation === 'function', 'evidence authority fetch implementation unavailable');
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
  return Object.freeze({ configuration: locked, request,
    finalize: input => request('FINALIZE_EXECUTION_INTENT', input),
    getIntent: execution_intent_id => request('GET_EXECUTION_INTENT', { execution_intent_id }),
    putIntent: (execution_intent_id, record) => request('PUT_EXECUTION_INTENT', { execution_intent_id, record }),
    package_binding_hash: sha256(configuration) });
}
