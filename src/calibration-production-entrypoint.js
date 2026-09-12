import { readFileSync } from 'node:fs';
import { createPhaseAProductionAdapter } from './calibration-production-adapter.js';
import { createEvidenceAuthorityClient, validateEvidenceAuthorityConfiguration } from './calibration-evidence-authority-client.js';

const authorityConfiguration = JSON.parse(readFileSync(new URL('../config/calibration-evidence-authority.json', import.meta.url), 'utf8'));
validateEvidenceAuthorityConfiguration(authorityConfiguration);
const certificateAuthority = authorityConfiguration.transport === 'HTTPS_PRODUCTION'
  ? readFileSync(new URL(`../${authorityConfiguration.tls_ca_resource}`, import.meta.url)) : null;

// The adapter holds no evidence or head signing key. It can submit exactly one
// idempotent intent-bound request to the HTTPS authority baked into the signed
// package. Parent-side signature verification is the authority boundary; output
// credential scanning is defense in depth only.
const client = createEvidenceAuthorityClient({ configuration: authorityConfiguration,
  credential: () => process.env.CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN, certificateAuthority });
const evidenceAuthority = Object.freeze({ trustDomain: 'EXTERNAL_EVIDENCE_AUTHORITY',
  finalize: input => client.finalize(input) });
const executionJournal = Object.freeze({
  durable: true,
  async get(key) { return (await client.getIntent(key)).record; },
  async put(key, value) { const response = await client.putIntent(key, value);
    if (response.status !== 'STORED_IDEMPOTENT') throw new Error('external execution journal rejected immutable record'); }
});

export const calibrationAdapter = createPhaseAProductionAdapter({
  executionMode: 'EMPIRICAL_CALIBRATION', evidenceAuthority, journal: executionJournal,
  workerTimeoutMs: authorityConfiguration.worker_timeout_ms,
  evidenceAuthorityTimeoutMs: authorityConfiguration.request_timeout_ms
});
