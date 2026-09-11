import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceAuthorityClient } from '../src/calibration-evidence-authority-client.js';

const configuration = { version: 'phase-a-evidence-authority-client-1.1.0', request_version: 'phase-a-evidence-authority-request-1.1.0',
  endpoint: 'https://evidence-authority.invalid/v1/execution-intents', request_timeout_ms: 15, worker_timeout_ms: 100,
  transport: 'HTTPS_PRODUCTION' };

test('signed evidence-authority deadline fails with typed infrastructure status', async () => {
  const fetchImplementation = (_url, options) => new Promise((_resolve, reject) =>
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const client = createEvidenceAuthorityClient({ configuration, credential: 'synthetic-token', fetchImplementation });
  await assert.rejects(client.finalize({ execution_intent_id: 'intent-1' }), error =>
    error.code === 'CALIBRATION_INFRASTRUCTURE_DEADLINE' && error.calibrationClassification === 'INFRASTRUCTURE_FAILURE');
});

test('authority protocol binds every response to the execution intent', async () => {
  const client = createEvidenceAuthorityClient({ configuration, credential: 'synthetic-token',
    fetchImplementation: async () => ({ ok: true, status: 200, async json() { return { execution_intent_id: 'other' }; } }) });
  await assert.rejects(client.finalize({ execution_intent_id: 'intent-1' }), error =>
    error.code === 'CALIBRATION_AUTHORITY_PROTOCOL' && error.calibrationClassification === 'PROTOCOL_VIOLATION');
});

test('DNS, connection, TLS, and service failures are closed typed infrastructure errors without diagnostic leakage', async () => {
  for (const diagnostic of ['getaddrinfo ENOTFOUND private-host', 'connect ECONNREFUSED secret-token', 'certificate private-key failure']) {
    const client = createEvidenceAuthorityClient({ configuration, credential: 'credential-must-not-leak',
      fetchImplementation: async () => { throw new TypeError(diagnostic); } });
    await assert.rejects(client.finalize({ execution_intent_id: 'intent-transport' }), error => {
      assert.equal(error.code, 'CALIBRATION_INFRASTRUCTURE_AUTHORITY');
      assert.equal(error.calibrationClassification, 'INFRASTRUCTURE_FAILURE');
      assert.equal(error.message.includes(diagnostic), false);
      assert.equal(error.message.includes('credential-must-not-leak'), false);
      return true;
    });
  }
  const service = createEvidenceAuthorityClient({ configuration, credential: 'credential-must-not-leak',
    fetchImplementation: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(service.finalize({ execution_intent_id: 'intent-service' }), error =>
    error.code === 'CALIBRATION_INFRASTRUCTURE_AUTHORITY' && error.calibrationClassification === 'INFRASTRUCTURE_FAILURE');
});

test('credential and HTTP authorization rejection are typed protocol failures without secret leakage', async () => {
  const rejected = createEvidenceAuthorityClient({ configuration, credential: 'credential-must-not-leak',
    fetchImplementation: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(rejected.finalize({ execution_intent_id: 'intent-auth' }), error => {
    assert.equal(error.code, 'CALIBRATION_AUTHORITY_AUTHORIZATION');
    assert.equal(error.calibrationClassification, 'PROTOCOL_VIOLATION');
    assert.equal(error.message.includes('credential-must-not-leak'), false);
    return true;
  });
  for (const credential of ['', () => { throw new Error('credential-resolution-secret'); }]) {
    const client = createEvidenceAuthorityClient({ configuration, credential,
      fetchImplementation: async () => { throw new Error('must not fetch'); } });
    await assert.rejects(client.finalize({ execution_intent_id: 'intent-credential' }), error =>
      error.code === 'CALIBRATION_AUTHORITY_AUTHORIZATION' &&
      error.calibrationClassification === 'PROTOCOL_VIOLATION' &&
      !error.message.includes('credential-resolution-secret'));
  }
});

test('malformed HTTP and authority payloads fail with typed authority protocol status', async () => {
  const cases = [
    async () => null,
    async () => ({ ok: true, status: 200, async json() { throw new Error('malformed-secret'); } }),
    async () => ({ ok: true, status: 200, async json() { return 'not-an-object'; } }),
    async () => ({ ok: true, status: 200, async json() { return { execution_intent_id: 'wrong' }; } })
  ];
  for (const fetchImplementation of cases) {
    const client = createEvidenceAuthorityClient({ configuration, credential: 'synthetic-token', fetchImplementation });
    await assert.rejects(client.finalize({ execution_intent_id: 'intent-protocol' }), error =>
      error.code === 'CALIBRATION_AUTHORITY_PROTOCOL' &&
      error.calibrationClassification === 'PROTOCOL_VIOLATION' &&
      !error.message.includes('malformed-secret'));
  }
});
