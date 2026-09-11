import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SignedArchive, archiveKeyId, verifyArchiveExport } from "../src/archive.js";
import { DurableJournal } from "../src/recovery.js";
import { makeWorld } from "../src/world.js";
import { recordSecurityIncident, recordBreachDisposition } from "../src/forensics.js";
import { canonicalize, sha256 } from "../src/core.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "civlab-signed-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const runId = "synthetic-signed-archive";
  const binding = { directory, runId, ...keys, keyId: archiveKeyId(keys.publicKey) };
  const archive = new SignedArchive(binding), world = makeWorld({ runId, seed: "synthetic-archive-fixture" });
  return { directory, binding, archive, world };
}
function incident(world) {
  const affected = world.evidence.events.at(-1), detectorRef = world.evidence.putPayload({ detector: "fixture-detector" });
  const event = recordSecurityIncident(world.evidence, { breachType: "synthetic_canary", detectorRef,
    firstAffectedEvent: affected.event_id, lastAffectedEvent: affected.event_id,
    runDispositionRef: "BREACH_POLICY.spec.json", evidenceRefs: [affected.payload.payload_ref] });
  recordBreachDisposition(world.evidence, { incidentRef: event.event_id });
  return event;
}

test("external Ed25519 binding authenticates a complete breached run", async t => {
  const { archive, world, binding } = await fixture(t);
  const first = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  incident(world);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: first.digest });
  const reader = new SignedArchive({ ...binding, privateKey: undefined, trustedHead: head });
  const loaded = await reader.load();
  assert.equal(loaded.authenticity, "EXTERNAL_ED25519_BINDING_VERIFIED");
  assert.deepEqual(loaded.bundle, world.evidence.bundle());
  assert.equal(loaded.bundle.events.at(-1).payload.security_eligibility.security_analysis_eligible, true);
  assert.equal(loaded.exact_reproducibility, false);
  await assert.rejects(reader.publish(loaded.bundle, { expectedHead: head.digest }), /signing authority/);
});

test("trusted keys, run identity, changed objects, signed heads and rollback anchors fail closed", async t => {
  const { archive, world, binding, directory } = await fixture(t);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => new SignedArchive({ ...binding, publicKey: other.publicKey }), /binding mismatch/);
  await assert.rejects(new SignedArchive({ ...binding, ...other, keyId: archiveKeyId(other.publicKey) }).load(), /authority/);
  await assert.rejects(new SignedArchive({ ...binding, runId: "substituted-run" }).load(), /authority/);
  await assert.rejects(new SignedArchive({ ...binding, trustedHead: { generation: 1, digest: head.digest } }).load(), /rollback/);
  const file = join(directory, "generations", "000000000000.json");
  const manifest = JSON.parse(await readFile(file));
  const objectFile = join(directory, "objects", manifest.body.object_hash + ".json");
  await writeFile(objectFile, "{}");
  await assert.rejects(archive.load(), /digest/);
});

test("a correctly HMAC-rehashed replacement cannot replace signed event history", async t => {
  const { archive, world } = await fixture(t);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  const substitute = makeWorld({ runId: world.runId, seed: "forged-new-history" });
  await assert.rejects(archive.publish(substitute.evidence.bundle(), { expectedHead: head.digest }), /substitution/);
  await assert.rejects(archive.publish(world.evidence.bundle()), /compare-and-swap/);
  await assert.rejects(archive.publish(world.evidence.bundle(), { expectedHead: null }), /stale/);
});

for (const point of ["before_persistence", "after_generation_fsync", "before_pointer_publish", "after_pointer_publish"]) {
  test("signed publication crash: " + point, async t => {
    const { archive, world, binding } = await fixture(t);
    const before = await archive.publish(world.evidence.bundle(), { expectedHead: null });
    const priorCount = world.evidence.events.length;
    incident(world);
    await assert.rejects(archive.publish(world.evidence.bundle(), { expectedHead: before.digest,
      fault: stage => { if (stage === point) throw new Error("injected crash"); } }), /injected crash/);
    const recovered = await new SignedArchive(binding).load();
    assert.equal(recovered.bundle.events.length, point === "after_pointer_publish" ? world.evidence.events.length : priorCount);
  });
}

test("two competing writers cannot publish two children of one signed generation", async t => {
  const { archive, world, binding } = await fixture(t);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  incident(world);
  const results = await Promise.allSettled([archive.publish(world.evidence.bundle(), { expectedHead: head.digest }),
    new SignedArchive(binding).publish(world.evidence.bundle(), { expectedHead: head.digest })]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.match(results.find(item => item.status === "rejected").reason.message, /stale/);
});

for (const point of ["after_privacy_journal", "after_privacy_publish", "after_privacy_purge"]) {
  test("privacy crash resumes purge without retaining prohibited text: " + point, async t => {
    const { archive, world, binding, directory } = await fixture(t);
    const secret = "PRIVACY_CANARY_do_not_retain_80437";
    const ref = world.evidence.putPayload({ text: secret }, "private_memory");
    world.evidence.putPayload({ text: "copy " + secret, artifact_ref: ref }, "derived_memory");
    world.evidence.putPayload({ encoding: "base64", data: Buffer.from("rendered prompt " + secret).toString("base64") }, "model_io");
    world.evidence.append({ eventType: "Violation", turn: 0, phase: "security", payload: { text: secret, artifact_ref: ref } });
    incident(world);
    const head = await archive.publish(world.evidence.bundle(), { expectedHead: null, serviceState: { cached_output: secret } });
    const writer = new SignedArchive({ ...binding, authorizeRedaction: request => request.authority === "authorized-fixture" });
    await assert.rejects(writer.redact({ artifactRef: ref, fieldOrRange: "text", reason: "consent_withdrawal", authority: "authorized-fixture" },
      { expectedHead: head.digest, fault: stage => { if (stage === point) throw new Error("privacy crash"); } }), /privacy crash/);
    const reader = new SignedArchive({ ...binding, privateKey: undefined });
    const recovered = await reader.load();
    assert.equal(recovered.status, "REPLAY_INCOMPLETE_REDACTED");
    assert.equal(recovered.service_state, null);
    assert.equal(canonicalize(recovered).includes(secret), false);
    assert(recovered.bundle.events.some(event => event.event_type === "SecurityIncident" && !event.payload.redacted));
    assert(recovered.bundle.events.some(event => event.event_type === "RedactionTombstone"));
    for (const folder of ["objects", "generations"]) for (const name of await readdir(join(directory, folder))) {
      assert.equal((await readFile(join(directory, folder, name), "utf8")).includes(secret), false);
    }
    await assert.rejects(writer.publish(world.evidence.bundle(), { expectedHead: recovered.head.digest }), /redacted/);
  });
}

test("authority text alone cannot authorize privacy deletion", async t => {
  const { archive, world } = await fixture(t);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  await assert.rejects(archive.redact({ authority: "I am authorized" }, { expectedHead: head.digest }), /not authorized/);
  assert.equal((await archive.load()).head.digest, head.digest);
});

test("legacy DurableJournal optionally upgrades to external signed authority", async t => {
  const { directory, binding, world } = await fixture(t);
  const journal = new DurableJournal(directory, world.runId, binding);
  await journal.persist(world.evidence.bundle());
  assert.equal((await journal.recover()).world.stateHash(), world.stateHash());
  const head = await journal.archive.head();
  assert.equal(typeof head.digest, "string");
  assert.equal(sha256((await journal.load()).events), sha256(world.evidence.events));
});

test("portable exports require external trust, explicit domain and authorization", async t => {
  const { archive, world, binding } = await fixture(t);
  const head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  await assert.rejects(archive.export(), /explicit/);
  await assert.rejects(archive.export({ authorizationContext: { domain: "participant_projection" }, authorize: () => true }), /explicit/);
  await assert.rejects(archive.export({ authorizationContext: { domain: "security_audit" } }), /not authorized/);
  const exported = await archive.export({ authorizationContext: { domain: "security_audit", principal: "fixture-auditor" }, authorize: () => true });
  assert.deepEqual(verifyArchiveExport(exported, { ...binding, trustedHead: head }).head, head);
  exported.object.service_state = { substituted: true };
  assert.throws(() => verifyArchiveExport(exported, binding), /digest/);
});

test("external verification rejects a correctly signed archive containing noncanonical base64 evidence", async t => {
  const { archive, world, binding } = await fixture(t);
  await archive.publish(world.evidence.bundle(), { expectedHead: null });
  const exported = await archive.export({ authorizationContext: { domain: "security_audit" }, authorize: () => true });
  const malformed = { encoding: "base64", data: Buffer.from([0xff, 0x00, 0x41]).toString("base64url") };
  const bytes = canonicalize(malformed), ref = sha256(bytes);
  exported.object.bundle.payloads[ref] = { digest: ref, classification: "legacy_malformed_private", bytes };
  const envelope = exported.manifests.at(-1);
  envelope.body.object_hash = sha256(exported.object);
  envelope.signature = sign(null, Buffer.from(canonicalize(envelope.body)), binding.privateKey).toString("base64");
  assert.throws(() => verifyArchiveExport(exported, binding), /canonical standard Base64/);
});

test("successive authorized redactions retain tombstones and reject exact recovery", async t => {
  const { world, binding } = await fixture(t);
  const archive = new SignedArchive({ ...binding, authorizeRedaction: () => true });
  const first = world.evidence.putPayload({ text: "first-consent-canary" }), second = world.evidence.putPayload({ text: "second-consent-canary" });
  let head = await archive.publish(world.evidence.bundle(), { expectedHead: null });
  for (const ref of [first, second]) head = await archive.redact({ artifactRef: ref, fieldOrRange: "text", reason: "consent_withdrawal", authority: "fixture-policy" }, { expectedHead: head.digest });
  const exported = await archive.export({ authorizationContext: { domain: "security_audit" }, authorize: () => true });
  assert.equal(verifyArchiveExport(exported, binding).status, "REPLAY_INCOMPLETE_REDACTED");
  assert.equal(exported.object.bundle.tombstone_refs.length, 2);
  assert.equal(canonicalize(exported).includes("consent-canary"), false);
});

test("separate processes racing identical publication receive exactly one winner", { timeout: 15000 }, async t => {
  const { binding, world } = await fixture(t);
  const source = `
    import { SignedArchive } from ${JSON.stringify(new URL("../src/archive.js", import.meta.url).href)};
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    const { binding, bundle } = JSON.parse(input);
    try {
      await new SignedArchive(binding).publish(bundle, { expectedHead: null, fault: point => {
        if (point === "before_pointer_publish") return new Promise(resolve => {
          process.once("message", () => resolve()); process.send("ready");
        });
      } }); process.exit(0);
    } catch (error) { process.exit(/already claimed/.test(error.message) ? 92 : 93); }
  `;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", code => code===92?resolve('blocked_by_exclusive_writer'):reject(new Error("publisher exited before barrier: " + code)));
    });
    const done = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    child.stdin.end(JSON.stringify({ binding: { ...binding,
      publicKey: binding.publicKey.export({ type: "spki", format: "pem" }), privateKey: binding.privateKey.export({ type: "pkcs8", format: "pem" }) }, bundle: world.evidence.bundle() }));
    return { child, ready, done };
  });
  const readiness=await Promise.all(children.map(item => item.ready));
  assert.deepEqual(readiness.sort(),['blocked_by_exclusive_writer','ready']);
  children.forEach(item => {if(item.child.connected)item.child.send("publish");});
  assert.deepEqual((await Promise.all(children.map(item => item.done))).sort((a, b) => a - b), [0, 92]);
});

test("queued archive publication snapshots caller-owned input before verification", async t => {
  const { archive, world } = await fixture(t);
  const bundle = world.evidence.bundle();
  const publishing = archive.publish(bundle, { expectedHead: null });
  bundle.events[0].payload.seed = "changed-after-call";
  await publishing;
  assert.deepEqual((await archive.load()).bundle, world.evidence.bundle());
});
