import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { mkdir, open, readFile, readdir, link, unlink, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { assert, canonicalize, clone, sha256 } from "./core.js";
import { verifyEvidenceIntegrity } from "./replay.js";
import { EvidenceStore, assertCanonicalBase64Evidence, loadEvidence } from "./evidence.js";
import { recordRedaction, redactBundle } from "./forensics.js";
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_HASH, ARCHIVE_VERSION, verifyArchiveTrust } from "./archive-trust.js";

const VERSION = ARCHIVE_VERSION;
const HASH = ARCHIVE_HASH;
const queues = new Map();

function verifyPayloads(bundle) {
  for (const [ref, record] of Object.entries(bundle.payloads)) {
    assert(HASH.test(ref) && record.digest === ref && typeof record.bytes === "string" && sha256(record.bytes) === ref, "archive payload content address mismatch");
    assertCanonicalBase64Evidence(JSON.parse(record.bytes));
  }
}
function verifyAnalysisPackage(pkg,runId) {
  if(pkg===null || pkg===undefined)return;
  assert(pkg.schema_version==='2.0.0'&&pkg.run_id===runId&&pkg.assets&&pkg.hashes,"invalid endpoint analysis package");
  assert(pkg.package_hash===sha256(pkg.assets),"endpoint analysis package digest mismatch");
  for(const [key,value] of Object.entries(pkg.assets))assert(typeof value==='string'&&pkg.hashes[key]===sha256(value),"endpoint analysis asset digest mismatch");
}

function verifyObject(object, head, runId) {
  assert(object.bundle?.run_id === runId && sha256(object) === head.object_hash, "archive object/run/digest mismatch");
  const bundle = object.bundle, events = bundle.events;
  assert(events.length === head.event_count && events.at(-1).integrity.canonical_bytes_hash === head.event_head, "archive event head mismatch");
  verifyPayloads(bundle);
  verifyAnalysisPackage(object.analysis_package,runId);
  if (head.status === "COMPLETE") verifyEvidenceIntegrity(bundle);
  else {
    assert(head.status === "REPLAY_INCOMPLETE_REDACTED" && bundle.redaction_status === head.status && bundle.exact_reproducibility === false, "unknown archive evidence status");
    let previous = null;
    const removed = new Set(bundle.removed_payload_refs);
    for (const event of events) {
      assert(event.run_id === runId && event.integrity.previous_hash === previous, "redacted event chain mismatch");
      if (event.payload.redacted) assert(removed.has(event.payload.payload_ref) && event.payload.original_event_digest === event.integrity.canonical_bytes_hash, "invalid redacted event proof");
      else {
        const copy = clone(event); copy.integrity.canonical_bytes_hash = null;
        assert(sha256(copy) === event.integrity.canonical_bytes_hash, "retained event digest mismatch");
        const payload = clone(event.payload); delete payload.payload_ref;
        assert(bundle.payloads[event.payload.payload_ref]?.bytes === canonicalize(payload), "retained payload mismatch");
      }
      previous = event.integrity.canonical_bytes_hash;
    }
    assert(bundle.tombstone_refs.length > 0 && bundle.tombstone_refs.every(id => events.some(e => e.event_id === id && e.event_type === "RedactionTombstone" && !e.payload.redacted)), "missing canonical tombstone");
  }
}

/** Portable, read-only clean-room verifier. The trust argument must be obtained
 * outside the exported archive. Authenticity does not itself certify replay.
 */
export function verifyArchiveExport(exported, { runId, publicKey, keyId, trustedHead = null }) {
  const authenticated = verifyArchiveTrust(exported, { runId, publicKey, keyId, trustedHead });
  const head = exported.manifests.at(-1).body;
  verifyObject(exported.object, head, runId);
  return authenticated;
}

// Serialize callers within a process; immutable numbered publication slots are
// the cross-process compare-and-swap. A competing writer fails, never overwrites.
export class RunCoordinator {
  constructor(key = randomUUID()) { this.key = key; }
  run(work) {
    const previous = queues.get(this.key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    queues.set(this.key, result);
    result.finally(() => { if (queues.get(this.key) === result) queues.delete(this.key); }).catch(() => {});
    return result;
  }
}

export function archiveKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  assert(key.asymmetricKeyType === "ed25519", "archive requires Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function regularBytes(path) {
  assert((await lstat(path)).isFile(), "archive path must be a regular file");
  return readFile(path, "utf8");
}
async function immutable(path, bytes, { allowExisting = true } = {}) {
  // Never publish a partially written file, including after a real process exit.
  const temporary = path + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert(allowExisting, "archive publication already claimed by another writer");
    assert(await regularBytes(path) === bytes, "archive fork or immutable object substitution");
  } finally { await unlink(temporary); }
  await syncDirectory(resolve(path, ".."));
}

/** Trust comes from the caller's binding, never from a key shipped in an export.
 * trustedHead is an externally retained {generation, digest} rollback anchor.
 * Keep the directory private; load() is a trusted infrastructure API, not a route.
 */
export class SignedArchive {
  constructor({ directory, runId, publicKey, keyId, privateKey, trustedHead = null, authorizeRedaction = null }) {
    assert(runId && publicKey && keyId, "external run/key trust binding required");
    this.directory = resolve(directory); this.runId = runId;
    this.publicKey = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    assert(archiveKeyId(this.publicKey) === keyId, "trusted public key binding mismatch");
    this.keyId = keyId;
    this.privateKey = privateKey ? (privateKey.type === "private" ? privateKey : createPrivateKey(privateKey)) : null;
    if (this.privateKey) assert(archiveKeyId(createPublicKey(this.privateKey)) === keyId, "signing key does not match trusted binding");
    if (trustedHead) assert(Number.isSafeInteger(trustedHead.generation) && trustedHead.generation >= 0 && HASH.test(trustedHead.digest), "invalid trusted head");
    this.trustedHead = clone(trustedHead);
    this.authorizeRedaction = authorizeRedaction;
    this.coordinator = new RunCoordinator("archive:" + this.directory);
  }
  async #initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.directory);
    assert(rootStat.isDirectory() && (rootStat.mode & 0o077) === 0, "archive directory must be private and cannot be a symlink");
    for (const name of ["objects", "generations"]) {
      const path = join(this.directory, name);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      assert(stat.isDirectory() && (stat.mode & 0o077) === 0, "archive subdirectory must be private and cannot be a symlink");
    }
    await syncDirectory(this.directory);
    await syncDirectory(resolve(this.directory, ".."));
  }
  async #exclusive(work) {
    await this.#initialize();
    // OS-backed SQLite locks span *all* object writes, publication and privacy
    // purge. They are released by the OS on process death, unlike a PID lease.
    // This database contains no research content: it is only a process mutex.
    const path=join(this.directory,'publication-lock.sqlite');
    if(await exists(path))assert((await lstat(path)).isFile(),'archive lock must be a regular file');
    const database=new DatabaseSync(path);
    try {
      database.exec('PRAGMA busy_timeout=0');
      try {database.exec('BEGIN IMMEDIATE');}
      catch(error) {if(/locked|busy/i.test(error.message))throw new Error('archive publication already claimed by another writer');throw error;}
      try {return await work();}
      finally {database.exec('ROLLBACK');}
    } finally {database.close();}
  }
  #seal(body) {
    assert(this.privateKey, "archive signing authority required");
    const signature = sign(null, Buffer.from(canonicalize(body)), this.privateKey).toString("base64");
    return { body, signature };
  }
  #verify(envelope) {
    const b = envelope?.body;
    assert(b?.version === VERSION && b.run_id === this.runId && b.key_id === this.keyId, "archive authority/run/version mismatch");
    assert(typeof envelope.signature === "string" && verify(null, Buffer.from(canonicalize(b)), this.publicKey, Buffer.from(envelope.signature, "base64")), "archive signature invalid");
    return b;
  }
  #slot(generation) { return join(this.directory, "generations", String(generation).padStart(12, "0") + ".json"); }
  async #history() {
    await this.#initialize();
    const names = (await readdir(join(this.directory, "generations"))).filter(name => !name.endsWith(".tmp")).sort();
    const history = [];
    for (const [index, name] of names.entries()) {
      assert(name === String(index).padStart(12, "0") + ".json", "archive generation gap or fork");
      const bytes = await regularBytes(this.#slot(index));
      const envelope = JSON.parse(bytes), body = this.#verify(envelope);
      assert(canonicalize(envelope) === bytes, "noncanonical archive manifest");
      assert(body.generation === index && body.parent === (history.at(-1)?.digest ?? null), "archive parent substitution");
      assert(HASH.test(body.object_hash) && Number.isSafeInteger(body.event_count) && body.event_count > 0, "invalid archive manifest");
      history.push({ ...clone(body), digest: sha256(bytes), envelope });
    }
    if (this.trustedHead) assert(history[this.trustedHead.generation]?.digest === this.trustedHead.digest, "archive rollback or trusted head substitution");
    if (history.length) this.trustedHead = { generation: history.at(-1).generation, digest: history.at(-1).digest };
    return history;
  }
  async #object(head) {
    const bytes = await regularBytes(join(this.directory, "objects", head.object_hash + ".json"));
    assert(sha256(bytes) === head.object_hash, "archive content digest mismatch");
    const object = JSON.parse(bytes);
    assert(canonicalize(object) === bytes && object.bundle?.run_id === this.runId, "archive object/run mismatch");
    verifyObject(object, head, this.runId);
    return object;
  }
  async head() {
    return this.coordinator.run(() => this.#exclusive(async () => {
      await this.#finishPrivacy();
      const head = (await this.#history()).at(-1);
      return head ? { generation: head.generation, digest: head.digest } : null;
    }));
  }
  async load() {
    return this.coordinator.run(() => this.#exclusive(async () => {
      await this.#finishPrivacy();
      const head = (await this.#history()).at(-1);
      assert(head, "archive has no published generation");
      const object = await this.#object(head);
      return { ...object, head: { generation: head.generation, digest: head.digest }, status: head.status,
        authenticity: "EXTERNAL_ED25519_BINDING_VERIFIED", exact_reproducibility: false };
    }));
  }
  async export({ authorizationContext, authorize } = {}) {
    assert(["research_observation", "trusted_replay", "security_audit"].includes(authorizationContext?.domain), "raw archive export requires an explicit research/replay/security domain");
    assert(typeof authorize === "function" && await authorize({ ...clone(authorizationContext), runId: this.runId }) === true, "archive export not authorized");
    return this.coordinator.run(() => this.#exclusive(async () => {
      await this.#finishPrivacy();
      const history = await this.#history();
      assert(history.length, "archive has no published generation");
      const object = await this.#object(history.at(-1));
      return { version: VERSION, authorization_domain: authorizationContext.domain,
        manifests: history.map(item => item.envelope), object };
    }));
  }
  async publish(bundle, { expectedHead, serviceState = null, analysisPackage = null, fault = () => {} } = {}) {
    bundle = clone(bundle); serviceState = clone(serviceState);analysisPackage=clone(analysisPackage);
    return this.coordinator.run(() => this.#exclusive(async () => {
      assert(this.privateKey, "archive signing authority required");
      assert(expectedHead !== undefined, "explicit archive compare-and-swap head required");
      assert(bundle.run_id === this.runId, "archive run mismatch");
      verifyEvidenceIntegrity(bundle);
      verifyPayloads(bundle);
      assert(!bundle.events.some(e => e.event_type === "RedactionTombstone"), "use authorized archive redaction transaction");
      await this.#finishPrivacy();
      const history = await this.#history(), prior = history.at(-1);
      assert((prior?.digest ?? null) === expectedHead, "stale archive head or fork");
      const classificationChanges = [];
      if (prior) {
        assert(prior.status === "COMPLETE", "redacted run cannot resume exact execution");
        const previousObject=await this.#object(prior),previous=previousObject.bundle;
        if(analysisPackage===null)analysisPackage=clone(previousObject.analysis_package??null);
        else assert(previousObject.analysis_package===null || previousObject.analysis_package===undefined || canonicalize(analysisPackage)===canonicalize(previousObject.analysis_package),"endpoint analysis package substitution");
        assert(bundle.events.length >= previous.events.length && canonicalize(bundle.events.slice(0, previous.events.length)) === canonicalize(previous.events), "canonical history substitution or truncation");
        for (const [ref, payload] of Object.entries(previous.payloads)) {
          const next = bundle.payloads[ref];
          assert(next?.bytes === payload.bytes && next.digest === payload.digest, "archived payload removed or substituted");
          // EvidenceStore can label identical bytes as a snapshot and later as
          // confidant input. Preserve this metadata change explicitly; access
          // remains governed by canonical event ACLs, never this storage label.
          if (next.classification !== payload.classification) classificationChanges.push({ payload_ref: ref,
            previous_classification_hash: sha256(payload.classification), classification_hash: sha256(next.classification) });
        }
      }
      verifyAnalysisPackage(analysisPackage,this.runId);
      await fault("before_persistence");
      const object = { bundle: clone(bundle), service_state: clone(serviceState), analysis_package: clone(analysisPackage) };
      const bytes = canonicalize(object), hash = sha256(bytes);
      await immutable(join(this.directory, "objects", hash + ".json"), bytes);
      await fault("after_generation_fsync");
      const envelope = this.#seal({ version: VERSION, run_id: this.runId, key_id: this.keyId,
        generation: history.length, parent: prior?.digest ?? null, object_hash: hash,
        event_count: bundle.events.length, event_head: bundle.events.at(-1).integrity.canonical_bytes_hash,
        status: "COMPLETE", payload_classification_changes: classificationChanges });
      await fault("before_pointer_publish");
      assert(!await exists(join(this.directory, "PRIVACY_PENDING")), "privacy transaction pending");
      await immutable(this.#slot(history.length), canonicalize(envelope), { allowExisting: false });
      await fault("after_pointer_publish");
      return { generation: history.length, digest: sha256(envelope) };
    }));
  }
  /** Authorization callback must validate authority, reason, and scope against
   * the application's privacy policy. A caller-supplied authority string alone
   * cannot authorize deletion. Removes whole artifacts and declared derivatives.
   */
  async redact(request, { expectedHead, fault = () => {} } = {}) {
    request = clone(request);
    return this.coordinator.run(() => this.#exclusive(async () => {
      assert(this.privateKey, "archive signing authority required");
      assert(typeof this.authorizeRedaction === "function" && await this.authorizeRedaction(clone(request)) === true, "redaction not authorized");
      await this.#finishPrivacy();
      const history = await this.#history(), prior = history.at(-1);
      assert(prior && expectedHead === prior.digest, "stale redaction head");
      const original = (await this.#object(prior)).bundle;
      let store;
      if (prior.status === "COMPLETE") store = loadEvidence(original);
      else {
        store = new EvidenceStore(this.runId);
        store.events = clone(original.events); store.payloads = new Map(Object.entries(clone(original.payloads)));
        store.previousHash = original.events.at(-1).integrity.canonical_bytes_hash;
      }
      recordRedaction(store, request);
      const bundle = redactBundle({ ...original, ...store.bundle() });
      // Request/result caches can duplicate any erased text; discard their bytes.
      const object = { bundle, service_state: null };
      const bytes = canonicalize(object), hash = sha256(bytes);
      await immutable(join(this.directory, "objects", hash + ".json"), bytes);
      const envelope = this.#seal({ version: VERSION, run_id: this.runId, key_id: this.keyId,
        generation: history.length, parent: prior.digest, object_hash: hash,
        event_count: bundle.events.length, event_head: bundle.events.at(-1).integrity.canonical_bytes_hash,
        status: "REPLAY_INCOMPLETE_REDACTED", tombstone_refs: bundle.tombstone_refs,
        purged_generations: history.map(h => ({ generation: h.generation, digest: h.digest, object_hash: h.object_hash })) });
      await fault("before_privacy_journal");
      await immutable(join(this.directory, "PRIVACY_PENDING"), canonicalize(envelope));
      await fault("after_privacy_journal");
      await this.#finishPrivacy(fault);
      return { generation: history.length, digest: sha256(envelope), status: "REPLAY_INCOMPLETE_REDACTED" };
    }));
  }
  async #finishPrivacy(fault = () => {}) {
    const marker = join(this.directory, "PRIVACY_PENDING");
    if (!await exists(marker)) return;
    const bytes = await regularBytes(marker), envelope = JSON.parse(bytes), body = this.#verify(envelope);
    assert(body.status === "REPLAY_INCOMPLETE_REDACTED", "invalid privacy journal");
    const history = await this.#history();
    assert(history.length === body.generation || (history.length === body.generation + 1 && history.at(-1).digest === sha256(bytes)), "privacy journal fork");
    assert(body.parent === history[body.generation - 1]?.digest, "privacy journal parent mismatch");
    await this.#object(body);
    await immutable(this.#slot(body.generation), bytes);
    await fault("after_privacy_publish");
    // The dedicated object directory also contains unadvertised crash remnants.
    // Delete all predecessors and remnants, retaining signed manifests/digests.
    for (const name of await readdir(join(this.directory, "objects"))) {
      assert(/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name), "unknown file in private archive object directory");
      if (name !== body.object_hash + ".json") await unlink(join(this.directory, "objects", name));
    }
    await syncDirectory(join(this.directory, "objects"));
    await fault("after_privacy_purge");
    await unlink(marker); await syncDirectory(this.directory);
  }
}
