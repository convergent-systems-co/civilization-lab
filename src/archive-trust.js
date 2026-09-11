import { createHash, createPublicKey, verify } from "node:crypto";
import { assert, canonicalize, sha256 } from "./core.js";

export const ARCHIVE_VERSION = "pilot0-ed25519-archive-v1";
export const ARCHIVE_HASH = /^[a-f0-9]{64}$/;

/** Verify only the externally anchored Ed25519 archive chain and its binding to
 * the exported object. Domain-specific evidence verification remains with the
 * caller so this trust primitive does not depend on the replay reducer. */
export function verifyArchiveTrust(exported, { runId, publicKey, keyId, trustedHead = null }) {
  assert(runId && publicKey && keyId, "external run/key trust binding required");
  if (trustedHead) assert(Number.isSafeInteger(trustedHead.generation) && trustedHead.generation >= 0 && ARCHIVE_HASH.test(trustedHead.digest), "invalid trusted head");
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  const derivedKeyId = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  assert(derivedKeyId === keyId, "trusted public key binding mismatch");
  assert(exported?.version === ARCHIVE_VERSION && exported.manifests?.length, "unsupported archive export");
  let previous = null;
  for (const [index, envelope] of exported.manifests.entries()) {
    const body = envelope.body;
    assert(body.version === ARCHIVE_VERSION && body.run_id === runId && body.key_id === keyId &&
      body.generation === index && body.parent === previous, "export authority/lineage mismatch");
    assert(verify(null, Buffer.from(canonicalize(body)), key, Buffer.from(envelope.signature, "base64")), "export signature invalid");
    previous = sha256(envelope);
    if (trustedHead?.generation === index) assert(previous === trustedHead.digest, "export trusted head substitution");
  }
  if (trustedHead) assert(exported.manifests.length > trustedHead.generation, "export rollback");
  const head = exported.manifests.at(-1).body, object = exported.object;
  assert(object?.bundle?.run_id === runId && sha256(object) === head.object_hash, "archive object/run/digest mismatch");
  assert(object.bundle.events.length === head.event_count &&
    object.bundle.events.at(-1)?.integrity.canonical_bytes_hash === head.event_head, "archive event head mismatch");
  return { run_id: runId, status: head.status, authenticity: "EXTERNAL_ED25519_BINDING_VERIFIED", exact_reproducibility: false,
    head: { generation: head.generation, digest: previous } };
}
