import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeWorld } from "../src/world.js";
import { AgentRuntime, DeterministicModel, invokeRecordedModel } from "../src/agent.js";
import { projectWorld } from "../src/contracts.js";
import { putRawPayload } from "../src/model-adapter.js";
import { recordRedaction, redactBundle } from "../src/forensics.js";
import { SignedArchive, archiveKeyId, verifyArchiveExport } from "../src/archive.js";
import { canonicalize, sha256 } from "../src/core.js";

// Synthetic evidence only: no inference, model transport or empirical runs.
function fixture(secret = 'WITHDRAWN_"QUOTE"\nSECOND_LINE\\tail') {
  const world = makeWorld({ runId: "synthetic-redaction-adversarial", seed: "synthetic-acl-review" });
  const runtime = new AgentRuntime({ world, actorId: "polity-1", model: new DeterministicModel(),
    executionMode: "synthetic", now: () => 0 });
  runtime.memory.write(secret, runtime.sessionId, "synthetic-memory-write", 0);
  const artifactRef = world.evidence.events.findLast(e => e.event_type === "MemoryOperation").payload.output_ref;
  const result = runtime.invoke();
  const request = { artifactRef, fieldOrRange: "text", reason: "consent_withdrawal", authority: "synthetic-privacy-policy" };
  return { world, runtime, result, request, secret };
}

function assertPurged(bundle, refs) {
  for (const ref of refs) {
    assert(!bundle.payloads[ref], `prohibited artifact retained: ${ref}`);
    assert(bundle.removed_payload_refs.includes(ref));
  }
}

test("escaped memory redaction removes raw prompt, request, response and derived action", () => {
  const { world, result, request } = fixture();
  const invocation = world.evidence.events.findLast(e => e.event_type === "ModelInvocation");
  const other = new AgentRuntime({ world, actorId: "polity-2", model: new DeterministicModel(),
    executionMode: "synthetic", now: () => 0 }).invoke();
  const untouched = world.evidence.putPayload({ text: "unrelated public mechanics" });
  recordRedaction(world.evidence, request);
  const original = world.evidence.bundle(), redacted = redactBundle(original);
  assertPurged(redacted, [request.artifactRef, result.inputRef, result.requestRef, result.outputRef,
    result.responseRef, invocation.payload.action_ref]);
  assert.deepEqual(redacted.payloads[untouched], original.payloads[untouched]);
  assert.deepEqual(redacted.payloads[invocation.payload.model_runtime_hash], original.payloads[invocation.payload.model_runtime_hash]);
  assert.deepEqual(redacted.payloads[other.inputRef], original.payloads[other.inputRef], "unrelated participant evidence erased");
  // Content addressing intentionally aliases byte-identical outputs. If both
  // invocations emitted the same bytes, redacting that artifact removes the one
  // shared object rather than retaining an indistinguishable duplicate.
  if (other.outputRef === result.outputRef) assert.equal(redacted.payloads[other.outputRef], undefined);
  else assert.deepEqual(redacted.payloads[other.outputRef], original.payloads[other.outputRef], "unrelated participant evidence erased");
  assert.equal(redacted.events.find(e => e.event_id === invocation.event_id).payload.redacted, true);
  assert.equal(redacted.events.at(-1).event_type, "RedactionTombstone");
  assert(original.payloads[result.inputRef], "pure transformation mutated original evidence");
});

test("unreferenced JSON-escaped and nested request copies are purged", () => {
  const { world, request, secret } = fixture();
  const prompt = `instruction\nDATA=${JSON.stringify({ memory: [secret] })}\nCONTINUATION\n`;
  const copies = [
    putRawPayload(world.evidence, prompt),
    putRawPayload(world.evidence, JSON.stringify({ prompt })),
    putRawPayload(world.evidence, JSON.stringify({ request: JSON.stringify({ prompt }) })),
    world.evidence.putPayload({ rendered: JSON.stringify({ memory: [secret] }) })
  ];
  recordRedaction(world.evidence, request);
  assertPurged(redactBundle(world.evidence.bundle()), copies);
});

test("memory transformation dependencies remove changed text and later invocation outputs", () => {
  const { world, runtime, request } = fixture();
  runtime.memory.compress(runtime.memory.records.map(r => r.id), "opaque transformed memory", runtime.sessionId,
    "synthetic-compression", 0);
  const transformedRef = world.evidence.events.findLast(e => e.event_type === "MemoryOperation").payload.output_ref;
  const later = runtime.invoke();
  recordRedaction(world.evidence, request);
  assertPurged(redactBundle(world.evidence.bundle()), [transformedRef, later.inputRef, later.outputRef, later.responseRef]);
});

test("redacting model output also purges its response envelope and parsed action", () => {
  const { world, result } = fixture();
  const invocation = world.evidence.events.findLast(e => e.event_type === "ModelInvocation");
  recordRedaction(world.evidence, { artifactRef: result.outputRef, fieldOrRange: "*",
    reason: "consent_withdrawal", authority: "synthetic-privacy-policy" });
  assertPurged(redactBundle(world.evidence.bundle()), [result.outputRef, result.responseRef, invocation.payload.action_ref]);
});

test("isolated contexts inherit redaction through archived memory record origins", () => {
  const { world, runtime, request } = fixture();
  runtime.memory.compress(runtime.memory.records.map(r => r.id), "opaque interview memory", runtime.sessionId,
    "synthetic-compression", 0);
  const interview = invokeRecordedModel({ evidence: world.evidence, runId: world.runId, actorId: runtime.actorId,
    sessionId: "isolated-synthetic-session", condition: runtime.condition, model: runtime.model,
    projection: projectWorld(world, runtime.actorId), memoryRecords: runtime.memory.records,
    nextInvocationId: () => "isolated-synthetic-invocation", deadline: 1000, now: () => 0 });
  recordRedaction(world.evidence, request);
  assertPurged(redactBundle(world.evidence.bundle()), [interview.inputRef, interview.outputRef, interview.responseRef]);
});

test("opaque retry envelopes follow invocation dependencies without matching private text", () => {
  const { world, result, request } = fixture();
  const source = world.evidence.events.findLast(e => e.event_type === "ModelInvocation");
  const output = putRawPayload(world.evidence, "synthetic opaque retry response");
  const requestRef = putRawPayload(world.evidence, "synthetic opaque retry request");
  const segmentRef = putRawPayload(world.evidence, "synthetic transformed context segment");
  const diagnostic = world.evidence.putPayload({ stage: "complete", request_ref: requestRef, response_ref: output });
  const payload = structuredClone(source.payload); delete payload.payload_ref;
  payload.invocation_id = "synthetic-retry"; payload.retry_of = source.payload.invocation_id; payload.attempt = 2;
  payload.rendered_output_ref = output; payload.action_ref = null;
  payload.context_segments.push({ segment_id: "synthetic-derived-segment", class: "untrusted_world_text",
    source_ref: request.artifactRef, content_ref: segmentRef, render_policy: { authority: "data" } });
  world.evidence.append({ eventType: "ModelInvocation", turn: 0, phase: "actions", payload,
    provenance: { input_refs: [diagnostic] } });
  recordRedaction(world.evidence, request);
  assertPurged(redactBundle(world.evidence.bundle()), [result.inputRef, requestRef, output, segmentRef]);
});

test("encoded prohibited metadata fails closed instead of claiming a completed purge", () => {
  const { world, request, secret } = fixture();
  recordRedaction(world.evidence, { ...request, authority: JSON.stringify({ private: secret }) });
  assert.throws(() => redactBundle(world.evidence.bundle()), /tombstone metadata repeats prohibited content/);
});

test("raw-byte redaction removes prefixed and embedded alternate base64 framing", () => {
  const world = makeWorld({ runId: "synthetic-redaction-raw-byte-closure", seed: "raw-byte-closure" });
  const secret = Buffer.from([0xff, 0x00, 0x41, 0x42, 0x43, 0x80, 0x7f]);
  const raw = bytes => ({ encoding: "base64", data: bytes.toString("base64"), byte_length: bytes.length,
    raw_sha256: createHash("sha256").update(bytes).digest("hex") });
  const artifactRef = world.evidence.putPayload(raw(secret), "human_private");
  const prefixedRef = world.evidence.putPayload(raw(Buffer.concat([Buffer.from([1]), secret])), "derived_private");
  const embeddedRef = world.evidence.putPayload({ wrapper: raw(Buffer.concat([Buffer.from("prefix"), secret, Buffer.from("suffix")])) }, "derived_private");
  recordRedaction(world.evidence, { artifactRef, fieldOrRange: "/data", reason: "consent_withdrawal", authority: "synthetic-privacy-policy" });
  const redacted = redactBundle(world.evidence.bundle());
  assertPurged(redacted, [artifactRef, prefixedRef, embeddedRef]);
});

test("base64 evidence ingestion rejects base64url with and without padding", () => {
  const world = makeWorld({ runId: "synthetic-base64-ingestion", seed: "base64-ingestion" });
  const secret = Buffer.from([0xff, 0x00, 0x41, 0x42, 0x43, 0x80, 0x7f]);
  const unpadded = secret.toString("base64url"), padded = unpadded + "==";
  for (const data of [unpadded, padded]) {
    assert.throws(() => world.evidence.putPayload({ encoding: "base64", data }), /canonical standard Base64/);
    assert.throws(() => world.evidence.putPayload({ nested: { encoding: "base64", data } }), /canonical standard Base64/);
  }
});

test("redaction defensively purges preexisting base64url variants and byte embeddings", () => {
  const world = makeWorld({ runId: "synthetic-base64url-purge", seed: "base64url-purge" });
  const secret = Buffer.from([0xff, 0x00, 0x41, 0x42, 0x43, 0x80, 0x7f]);
  const artifactRef = world.evidence.putPayload({ encoding: "base64", data: secret.toString("base64") }, "human_private");
  recordRedaction(world.evidence, { artifactRef, fieldOrRange: "/data", reason: "consent_withdrawal", authority: "synthetic-privacy-policy" });
  const bundle = world.evidence.bundle(), variants = [
    { encoding: "base64", data: secret.toString("base64url") },
    { encoding: "base64", data: secret.toString("base64url") + "==" },
    { encoding: "base64", data: Buffer.concat([Buffer.from([1]), secret]).toString("base64url") },
    { wrapper: { encoding: "base64", data: Buffer.concat([Buffer.from("prefix"), secret, Buffer.from("suffix")]).toString("base64url") + "==" } }
  ];
  const refs = variants.map(value => {
    const bytes = canonicalize(value), ref = sha256(bytes);
    bundle.payloads[ref] = { digest: ref, classification: "legacy_malformed_private", bytes };
    return ref;
  });
  assertPurged(redactBundle(bundle), [artifactRef, ...refs]);
});

test("signed private archive and export retain no forbidden raw artifacts after redaction", async t => {
  const { world, result, request } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "civlab-redaction-adversarial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const binding = { directory, runId: world.runId, ...keys, keyId: archiveKeyId(keys.publicKey) };
  const archive = new SignedArchive({ ...binding, authorizeRedaction: () => true });
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  await archive.redact(request, { expectedHead: head.digest });
  const exported = await archive.export({ authorizationContext: { domain: "security_audit" }, authorize: () => true });
  assert.equal(verifyArchiveExport(exported, binding).status, "REPLAY_INCOMPLETE_REDACTED");
  const forbidden = [request.artifactRef, result.inputRef, result.requestRef, result.outputRef, result.responseRef];
  assertPurged(exported.object.bundle, forbidden);
  for (const name of await readdir(join(directory, "objects"))) {
    const retained = JSON.parse(await readFile(join(directory, "objects", name), "utf8"));
    assertPurged(retained.bundle, forbidden);
  }
});
