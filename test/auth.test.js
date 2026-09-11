import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { AuthService } from "../src/auth.js";

const participant = { runId: "synthetic-run", principalId: "synthetic-polity", domain: "participant_projection" };
const domains = ["participant_projection", "research_observation", "trusted_replay", "security_audit", "public_release"];
const unknownToken = () => randomBytes(32).toString("base64url");
const denied = (operation) => assert.throws(operation, (error) => {
  assert.equal(error.constructor, Error);
  assert.equal(error.message, "unauthorized");
  assert.equal(error.code, "UNAUTHORIZED");
  assert.equal(error.statusCode, 401);
  assert.deepEqual(Object.keys(error).sort(), ["code", "statusCode"]);
  return true;
});
function fixture() {
  let now = 1_000;
  const auth = new AuthService({ clock: () => now });
  return { auth, setTime: (value) => { now = value; }, issue: (overrides = {}) => auth.issue({ ...participant, ttlMs: 100, ...overrides }) };
}

test("issues opaque independent credentials while preserving experimental identity", () => {
  const { auth, issue } = fixture();
  const tokens = Array.from({ length: 128 }, () => issue());
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.notEqual(token, participant.principalId);
    assert.ok(!token.includes(participant.runId));
    assert.deepEqual(auth.authenticate(token, participant), { ...participant, issuedAt: 1_000, expiresAt: 1_100 });
  }
  auth.revoke(tokens[0]);
  const replacement = issue();
  assert.ok(!tokens.includes(replacement));
  assert.equal(auth.authenticate(replacement, participant).principalId, participant.principalId);
});

test("stores only a credential digest with claims in private memory", (t) => {
  const { auth, issue } = fixture();
  const writes = [];
  const originalSet = Map.prototype.set;
  const spy = t.mock.method(Map.prototype, "set", function (key, value) {
    writes.push({ key, value });
    return originalSet.call(this, key, value);
  });
  const token = issue();
  spy.mock.restore();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, createHash("sha256").update(token).digest("hex"));
  assert.deepEqual(writes[0].value, { ...participant, issuedAt: 1_000, expiresAt: 1_100 });
  assert.ok(Object.isFrozen(writes[0].value));
  assert.ok(!JSON.stringify(writes).includes(token));
  assert.deepEqual(Reflect.ownKeys(auth), []);
  assert.ok(!inspect(auth, { showHidden: true }).includes(token));
});

test("authenticates with optional principal binding and immutable credential-free claims", () => {
  const { auth, issue } = fixture();
  const token = issue();
  const claims = auth.authenticate(token, { runId: participant.runId, domain: participant.domain });
  assert.equal(claims.principalId, participant.principalId);
  assert.ok(Object.isFrozen(claims));
  assert.throws(() => { claims.domain = "research_observation"; }, TypeError);
  assert.ok(!JSON.stringify(claims).includes(token));
  assert.notEqual(auth.authenticate(token, participant), claims);
  denied(() => auth.authenticate(claims, participant));
});

test("denies unknown, cross-run, cross-principal, and cross-service credentials identically", () => {
  const { auth, issue } = fixture();
  const token = issue();
  denied(() => auth.authenticate(unknownToken(), participant));
  denied(() => auth.authenticate(token, { ...participant, runId: "synthetic-other-run" }));
  denied(() => auth.authenticate(token, { ...participant, principalId: "synthetic-other-polity" }));
  denied(() => new AuthService().authenticate(token, participant));
  denied(() => auth.authenticate(participant.principalId, participant));
  const changed = (token[0] === "A" ? "B" : "A") + token.slice(1);
  denied(() => auth.authenticate(changed, participant));
  assert.equal(auth.authenticate(token, participant).principalId, participant.principalId);
});

test("every domain requires its own capability, including Observer and participant", () => {
  const { auth, issue } = fixture();
  for (const domain of domains) {
    const token = issue({ domain });
    assert.equal(auth.authenticate(token, { ...participant, domain }).domain, domain);
    for (const other of domains.filter((value) => value !== domain)) {
      denied(() => auth.authenticate(token, { ...participant, domain: other }));
    }
  }
});

test("expires exactly at the deadline and does not revive an observed expired token", () => {
  const { auth, issue, setTime } = fixture();
  const token = issue();
  setTime(1_099);
  assert.equal(auth.authenticate(token, participant).expiresAt, 1_100);
  setTime(1_100);
  denied(() => auth.authenticate(token, participant));
  setTime(1_000);
  denied(() => auth.authenticate(token, participant));
});

test("revocation is silent, idempotent, and affects only the selected session", () => {
  const { auth, issue } = fixture();
  const token = issue();
  const second = issue();
  for (const value of [token, token, unknownToken(), undefined, null, {}, participant.principalId]) {
    assert.equal(auth.revoke(value), undefined);
  }
  denied(() => auth.authenticate(token, participant));
  assert.equal(auth.authenticate(second, participant).principalId, participant.principalId);
});

test("malformed credentials and missing, unknown, or inherited request fields fail closed", () => {
  const { auth, issue } = fixture();
  const token = issue();
  for (const value of [undefined, null, "", 42, {}, [], Buffer.from(token), `${token}=`, `${token}\n`, `Bearer ${token}`, "x".repeat(10_000)]) {
    denied(() => auth.authenticate(value, participant));
  }
  for (const context of [undefined, null, [], {}, Object.create(participant),
    { runId: participant.runId }, { domain: participant.domain },
    { ...participant, domain: "unknown" }, { ...participant, domain: "toString" },
    { ...participant, runId: " " }, { ...participant, principalId: undefined },
    { ...participant, principalId: null }, { ...participant, principalId: "" },
    { ...participant, observer: true }, { ...participant, [Symbol("authority")]: true }]) {
    denied(() => auth.authenticate(token, context));
  }
});

test("issuance validates explicit scope and finite positive millisecond lifetime", () => {
  const { auth, issue } = fixture();
  for (const options of [undefined, null, [], {}, Object.create({ ...participant, ttlMs: 1 })]) {
    assert.throws(() => auth.issue(options), TypeError);
  }
  for (const ttlMs of [undefined, null, 0, -1, 0.5, NaN, Infinity, "100", Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => issue({ ttlMs }), TypeError);
  }
  for (const overrides of [{ runId: "" }, { principalId: " " }, { principalId: 42 },
    { domain: undefined }, { domain: "observer" }, { domain: "toString" }, { extra: true }]) {
    assert.throws(() => issue(overrides), TypeError);
  }
  assert.throws(() => new AuthService({ clock: 0 }), TypeError);
});

test("clock failures fail closed without leaking internal details", () => {
  const { auth, issue, setTime } = fixture();
  const token = issue();
  for (const now of [NaN, Infinity, undefined, "1000", -1, 1_000.5]) {
    setTime(now);
    denied(() => auth.authenticate(token, participant));
    assert.throws(() => issue(), TypeError);
  }
  setTime(999);
  denied(() => auth.authenticate(token, participant));
  setTime(1_000);
  denied(() => auth.authenticate(token, participant));
  let broken = false;
  const service = new AuthService({ clock: () => {
    if (broken) throw new Error("synthetic internal clock detail");
    return 0;
  } });
  const credential = service.issue({ ...participant, ttlMs: 1 });
  broken = true;
  denied(() => service.authenticate(credential, participant));
});

test("default clock issues usable sessions without configuration", () => {
  const auth = new AuthService();
  const before = Date.now();
  const token = auth.issue({ ...participant, ttlMs: 60_000 });
  const claims = auth.authenticate(token, participant);
  assert.ok(claims.issuedAt >= before && claims.issuedAt <= Date.now());
  assert.equal(claims.expiresAt - claims.issuedAt, 60_000);
});
