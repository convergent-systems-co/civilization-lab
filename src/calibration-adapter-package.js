import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { assert } from './core.js';

const ENTRY = 'src/calibration-production-entrypoint.js';
const RESOURCE_FILES = Object.freeze([
  'PILOT_0_CALIBRATION_PROTOCOL.spec.json', 'PARAMETER_REGISTRY.spec.json', 'PRIMARY_ENDPOINT.spec.json',
  'ENDPOINT_CODEBOOK.spec.md', 'PROJECTION_POLICY.spec.json', 'package.json',
  'validation/PRE_CALIBRATION_BASELINE.json',
  'scripts/calibration-selector.js', 'src/huggingface-runtime.py'
]);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const importSpecifiers = source => [...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
  ...source.matchAll(/\bimport\s+['"](\.[^'"]+)['"]/g)].map(match => match[1]);

async function sourceGraph(root) {
  const files = new Set(), visit = async name => {
    if (files.has(name)) return;
    assert(name.startsWith('src/') && name.endsWith('.js'), `adapter source graph escaped: ${name}`);
    files.add(name);
    const source = await readFile(resolve(root, name), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      let imported = relative(root, resolve(root, dirname(name), specifier));
      if (!imported.endsWith('.js')) imported += '.js';
      await visit(imported);
    }
  };
  await visit(ENTRY);
  return files;
}

async function treeFiles(root, directory) {
  const files = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `adapter package resource symlink forbidden: ${name}`);
    if (entry.isDirectory()) files.push(...await treeFiles(root, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

/** Build a closed package for scripts/calibration-adapter-worker.js. The caller
 * signs the returned declaration; no empirical authority is created here. */
export async function buildPhaseAAdapterPackage({ repositoryRoot, destination, evidenceAuthorityEndpoint,
  workerTimeoutMs = 120_000, evidenceAuthorityTimeoutMs = 15_000,
  allowInsecureLoopbackForConformance = false }) {
  const root = resolve(repositoryRoot), target = resolve(destination);
  const endpoint = new URL(evidenceAuthorityEndpoint);
  const conformanceLoopback = allowInsecureLoopbackForConformance && endpoint.protocol === 'http:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname);
  assert((endpoint.protocol === 'https:' || conformanceLoopback) && endpoint.username === '' && endpoint.password === '' && !endpoint.hash,
    'production adapter requires an exact credential-free HTTPS evidence-authority endpoint');
  await mkdir(target, { recursive: false, mode: 0o700 });
  const files = new Set([...await sourceGraph(root), ...RESOURCE_FILES,
    ...await treeFiles(root, 'config'), ...await treeFiles(root, 'schemas')]);
  for (const name of [...files].sort()) {
    const output = resolve(target, name);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await cp(resolve(root, name), output);
  }
  const authorityResource = 'config/calibration-evidence-authority.json';
  assert(Number.isSafeInteger(workerTimeoutMs) && workerTimeoutMs > 0 && workerTimeoutMs <= 300_000 &&
    Number.isSafeInteger(evidenceAuthorityTimeoutMs) && evidenceAuthorityTimeoutMs > 0 && evidenceAuthorityTimeoutMs <= 300_000,
  'adapter deadlines must be explicit bounded integers');
  await writeFile(resolve(target, authorityResource), JSON.stringify({ version: 'phase-a-evidence-authority-client-1.1.0',
    request_version: 'phase-a-evidence-authority-request-1.1.0', endpoint: endpoint.href,
    request_timeout_ms: evidenceAuthorityTimeoutMs, worker_timeout_ms: workerTimeoutMs,
    transport: conformanceLoopback ? 'INSECURE_LOOPBACK_CONFORMANCE_ONLY' : 'HTTPS_PRODUCTION' }) + '\n', { mode: 0o600 });
  files.add(authorityResource);
  const wrapper = "export { calibrationAdapter } from './src/calibration-production-entrypoint.js';\n";
  await writeFile(resolve(target, 'adapter.mjs'), wrapper, { mode: 0o600 });
  files.add('adapter.mjs');
  const baselineReceipt = 'validation/BASELINE_TAG_RESOLUTION.json';
  await writeFile(resolve(target, baselineReceipt), JSON.stringify({ tag: 'v0.1.0-pilot0',
    commit: '8f06baae4cda7d6fbd9d61924b5c615f4a45ba59' }) + '\n', { mode: 0o600 });
  files.add(baselineReceipt);
  const hashes = {};
  for (const name of [...files].sort()) hashes[name] = digest(await readFile(resolve(target, name)));
  return Object.freeze({ entrypoint: basename('adapter.mjs'), files: hashes, permissions: {
    child_process: false,
    environment: ['CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN'],
    fs_read: [], fs_write: [], network: [endpoint.host], worker: false, worker_timeout_ms: workerTimeoutMs
  }});
}
