import { readFile } from 'node:fs/promises';
import { createCalibrationEvidenceAuthority,
  createCalibrationEvidenceAuthorityHttpsServer } from '../../src/calibration-evidence-authority-service.js';

if (process.argv[2]) {
  const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const authority = createCalibrationEvidenceAuthority({ directory: configuration.directory,
    credential: configuration.credential, evidencePrivateKey: await readFile(configuration.evidence_private_key, 'utf8'),
    evidenceHeadPrivateKey: await readFile(configuration.evidence_head_private_key, 'utf8'),
    authorityId: configuration.authority_id, trustedHeadDirectory: configuration.trusted_head_directory,
    authorizeRequest: async () => true, authorizeFinalization: async () => true,
    fault: async point => { if (point === configuration.crash_boundary) process.kill(process.pid, 'SIGKILL'); } });
  const server = createCalibrationEvidenceAuthorityHttpsServer({ authority,
    certificate: await readFile(configuration.tls_certificate), privateKey: await readFile(configuration.tls_private_key),
    host: '127.0.0.1', port: 0 });
  console.log(await server.start());
}
