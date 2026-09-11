import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../src/server.js";
import { makeWorld, resolveTurn } from "../src/world.js";
import {discoverPolity} from '../src/world-map.js';
import { ActionLedger, commitTurn, projectWorld } from "../src/contracts.js";
import { verifyEvidenceIntegrity, reconstructRun } from "../src/replay.js";
import { recordSecurityIncident, recordBreachDisposition, recordRedaction } from "../src/forensics.js";
import { SignedArchive, archiveKeyId } from "../src/archive.js";
import { RunService } from "../src/run-service.js";
import { AgentRuntime } from "../src/agent.js";
import { Qwen35BaseAdapter } from "../src/model-adapter.js";
import { Confidant } from "../src/confidant.js";

// BUILD conformance only: fresh synthetic worlds, temporary archives and an
// injected completion transport. No native model, live endpoint or calibration.
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const world = options.runService?.world ?? options.world ?? makeWorld({ runId: "ui-second-review", seed: "ui-conformance" });
  const app = createApplication({ world, allowSyntheticExecution: true, ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  t.after(async () => { await context.close(); await new Promise(resolve => app.server.close(resolve)); assert.deepEqual(errors, []); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const issue = (principalId = "polity-1", domain = "participant_projection", extra = {}) => app.auth.issue({ runId: world.runId, principalId, domain, ttlMs: 60000, ...extra });
  const request = (path, token, body) => fetch(url + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, world, page, url, issue, request };
}
async function login(f, observer = false, principal = "polity-1") {
  await f.page.goto(f.url + (observer ? "/observer" : "/"));
  await f.page.getByLabel(observer ? "Research access credential" : "Participant access credential").fill(f.issue(principal, observer ? "research_observation" : "participant_projection"));
  await f.page.getByRole("button", { name: observer ? "Open research view" : "Open session" }).click();
  await f.page.locator(observer ? "#research" : "#game").waitFor({ state: "visible" });
}
function turn(world, orders = {}) {
  const ledger = new ActionLedger(world.evidence);
  const validated = Object.keys(world.polities).map(actorId => {
    const submitted = ledger.submit({ runId: world.runId, turnId: `turn-${world.turn}`, actorId,
      actor: { persistent_identity_id: actorId, session_id: `fixture-session-${actorId}`, invocation_id: `fixture-${world.turn}-${actorId}` },
      actions: (orders[actorId] ?? [{ type: "wait" }]).map((a, i) => ({ action_id: `fixture-${actorId}-${i}`, ...a })), projection: projectWorld(world, actorId) });
    const result = ledger.validate(submitted, world); assert.equal(result.submission.status, "validated"); return result;
  });
  resolveTurn(world, commitTurn(world, ledger, validated));
}
function stop(world, executionStatus = "invalid") {
  const detectorRef = world.evidence.putPayload({ detector: "synthetic-review-detector" });
  const incident = recordSecurityIncident(world.evidence, { breachType: "synthetic_containment_fixture", detectorRef,
    firstAffectedEvent: world.evidence.events[0].event_id, lastAffectedEvent: world.evidence.events.at(-1).event_id,
    runDispositionRef: "BREACH_POLICY.spec.json", evidenceRefs: [world.evidence.events[0].payload.payload_ref] });
  return recordBreachDisposition(world.evidence, { incidentRef: incident.event_id, executionStatus });
}

test("Observer gates reject corrupt evidence on every research route without returning raw contents", async t => {
  const f = await fixture(t), token = f.issue("researcher", "research_observation");
  const clean = f.world.evidence.bundle(); verifyEvidenceIntegrity(clean);
  const healthy = await (await f.request("/api/observer", token)).json(); assert.equal(healthy.gates.integrity_verified, true);
  const damaged = structuredClone(clean), ref = damaged.events[0].payload.payload_ref;
  damaged.payloads[ref].bytes = "CORRUPT_OBSERVER_PAYLOAD_CANARY";
  assert.throws(() => verifyEvidenceIntegrity(damaged), /payload content address mismatch/);
  f.world.evidence.bundle = () => damaged;
  for (const path of ["/api/observer", "/api/observer/export", "/api/observer/analysis", "/api/observer/replay?turn=0"]) {
    const response = await f.request(path, token), body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.gates.status, "EVIDENCE_INTEGRITY_FAILED");
    assert.equal(body.gates.state_replay, false); assert.equal(body.gates.integrity_verified, false);
    assert.equal(body.world, undefined); assert.equal(body.evidence, undefined);
    assert.doesNotMatch(JSON.stringify(body), /CANARY|payload digest mismatch|evt_/);
  }
  const response = await f.request("/api/observer", f.issue()); assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("Observer redaction takes precedence over integrity and never returns retained bytes", async t => {
  const f = await fixture(t), token = f.issue("researcher", "research_observation");
  const ref = f.world.evidence.putPayload("RETAINED_REDACTION_CANARY");
  recordRedaction(f.world.evidence, { artifactRef: ref, fieldOrRange: "*", reason: "synthetic privacy fixture", authority: "synthetic-operator" });
  const bundle = f.world.evidence.bundle(); bundle.payloads[bundle.events[0].payload.payload_ref].bytes = "also corrupt";
  for (const path of ["/api/observer", "/api/observer/export", "/api/observer/analysis", "/api/observer/replay?turn=0"]) {
    const response = await f.request(path, token), body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.gates.status, "REPLAY_INCOMPLETE_REDACTED");
    assert.equal(body.gates.state_replay, false); assert.doesNotMatch(JSON.stringify(body), /CANARY|also corrupt/);
  }
});

test("Observer clears prior DOM and accessibility contents and prominently reports integrity/redaction failure", async t => {
  for (const kind of ["integrity", "redaction"]) await t.test(kind, async t => {
    const f = await fixture(t); await login(f, true);
    if (kind === "integrity") {
      const bundle = f.world.evidence.bundle(); bundle.payloads[bundle.events[0].payload.payload_ref].bytes = "CORRUPT_BROWSER_CANARY";
    } else {
      const ref = f.world.evidence.putPayload("RETAINED_BROWSER_CANARY");
      recordRedaction(f.world.evidence, { artifactRef: ref, fieldOrRange: "*", reason: "synthetic privacy fixture", authority: "synthetic-operator" });
    }
    await f.page.getByRole("button", { name: "Refresh evidence" }).click();
    await f.page.locator("#error").waitFor({ state: "visible" });
    assert.equal(await f.page.locator("#research").isVisible(), false);
    assert.equal(await f.page.locator("#events tr").count(), 0);
    assert.equal(await f.page.locator("#map [role=button]").count(), 0);
    assert.match(await f.page.locator("#error").textContent(), kind === "integrity" ? /EVIDENCE_INTEGRITY_FAILED/ : /REPLAY_INCOMPLETE_REDACTED/);
    assert.doesNotMatch(await f.page.locator("body").ariaSnapshot(), /CANARY|Research authorized|Canonical events/);
    // A fresh login gets the same explicit failure, never the earlier dashboard.
    await f.page.getByLabel("Research access credential").fill(f.issue("researcher", "research_observation"));
    await f.page.getByRole("button", { name: "Open research view" }).click();
    await f.page.locator("#error").waitFor({ state: "visible" });
    assert.match(await f.page.locator("#error").textContent(), kind === "integrity" ? /EVIDENCE_INTEGRITY_FAILED/ : /REPLAY_INCOMPLETE_REDACTED/);
  });
});

test("Observer atomically clears evidence when redaction lands between state and analysis requests", async t => {
  const world = makeWorld({ runId: "review-observer-analysis-race", seed: "ui-conformance" });
  const answer = "CONFIDANT_PRIVACY_RACE_CANARY";
  const model = new Qwen35BaseAdapter({ synthetic: true, model: "Qwen/Qwen3.5-9B-Base", revision: "a".repeat(40), backend: "mlx",
    artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64),
    transport: async () => ({ status: 200, body: JSON.stringify({ model: "Qwen/Qwen3.5-9B-Base", hf_revision: "a".repeat(40),
      artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64), choices: [{ text: answer, finish_reason: "stop" }] }) }) });
  const runtime = new AgentRuntime({ world, actorId: "polity-1", model, now: () => 0 }); turn(world);
  const reports = await new Confidant({ world, now: () => 0 }).interviewAll([runtime]); assert.equal(reports[0].status, "recorded");
  const interview = world.evidence.events.findLast(e => e.event_type === "InterviewResponse");
  const f = await fixture(t, { world });
  let analysisStarted, releaseAnalysis;
  const started = new Promise(resolve => { analysisStarted = resolve; });
  const release = new Promise(resolve => { releaseAnalysis = resolve; });
  let analysisStatus = null;
  await f.page.route("**/api/observer/analysis", async route => {
    analysisStarted(); await release;
    recordRedaction(world.evidence, { artifactRef: interview.payload.response_payload_ref, fieldOrRange: "*",
      reason: "synthetic between-request privacy race", authority: "synthetic-operator" });
    const response = await route.fetch(); analysisStatus = response.status(); await route.fulfill({ response });
  });
  await f.page.goto(f.url + "/observer");
  const token = f.issue("researcher", "research_observation");
  await f.page.getByLabel("Research access credential").fill(token);
  await f.page.getByRole("button", { name: "Open research view" }).click();
  await started;
  await f.page.waitForFunction(value => document.querySelector("#interviews").textContent.includes(value), answer);
  await f.page.locator("#interviews").getByRole("button", { name: interview.event_id }).click();
  await f.page.getByRole("button", { name: `Raw payload ${interview.payload.response_payload_ref}`, exact: true }).click();
  assert.match(await f.page.locator("body").textContent(), new RegExp(answer));
  assert.match(await f.page.locator("#raw-payload").textContent(), /base64/);
  releaseAnalysis();
  await f.page.locator("#error").waitFor({ state: "visible" });
  assert.equal(analysisStatus, 409);
  assert.equal(await f.page.locator("#research").isVisible(), false);
  assert.equal(await f.page.locator("#events tr").count(), 0);
  assert.equal(await f.page.locator("#interviews tr").count(), 0);
  assert.equal(await f.page.locator("#map [role=button]").count(), 0);
  assert.equal(await f.page.locator("#raw-event").textContent(), "");
  assert.equal(await f.page.locator("#raw-payload").textContent(), "");
  assert.equal(await f.page.locator("#replay-turn").getAttribute("max"), "0");
  assert.equal(await f.page.locator("#status").textContent(), "Signed out");
  assert.equal(await f.page.locator("#error").getAttribute("role"), "alert");
  assert.match(await f.page.locator("#error").textContent(), /REPLAY_INCOMPLETE_REDACTED/);
  const dom = await f.page.locator("body").evaluate(node => node.outerHTML), accessibility = await f.page.locator("body").ariaSnapshot();
  for (const retained of [answer, world.runId, interview.event_id, interview.payload.response_payload_ref]) {
    assert.equal(dom.includes(retained), false, `DOM retained ${retained}`);
    assert.equal(accessibility.includes(retained), false, `accessibility tree retained ${retained}`);
  }
  assert.doesNotMatch(accessibility, /Research authorized|Canonical events|Parallel confidant responses/);
  assert.match(accessibility, /REPLAY_INCOMPLETE_REDACTED/);
  assert.deepEqual(await f.page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  let authorization;
  f.page.once("request", request => { if (request.url().endsWith("/api/observer")) authorization = request.headers().authorization; });
  const unauthorized = f.page.waitForResponse(response => response.url().endsWith("/api/observer"));
  await f.page.locator("#refresh").evaluate(button => button.click());
  assert.equal((await unauthorized).status(), 401);
  assert.equal(authorization, "Bearer null");
});

test("Observer keeps verified evidence visible when only the analysis manifest is absent", async t => {
  const f = await fixture(t), response = f.page.waitForResponse(r => r.url().endsWith("/api/observer/analysis")); await login(f, true);
  assert.equal((await response).status(), 409);
  assert.equal(await f.page.locator("#research").isVisible(), true);
  assert.equal(await f.page.locator("#status").textContent(), "Research authorized");
  assert.equal(await f.page.locator("#error").isVisible(), false);
  assert.match(await f.page.locator("#analysis").textContent(), /No versioned statistical output supplied/);
});

test("native broadcast producer has the correct visible and accessible audience label", async t => {
  const world = makeWorld({ runId: "review-native-broadcast", seed: "ui-conformance" });
  // Establish only the identity knowledge needed for a valid private message;
  // then emit both records through the real committed reducer in one turn.
  discoverPolity(world,world.polities['polity-1'],'polity-2','synthetic_ui_fixture');
  discoverPolity(world,world.polities['polity-2'],'polity-1','synthetic_ui_fixture');
  turn(world, { "polity-1": [{ type: "broadcast", text: "NATIVE_PUBLIC_CANARY" }],
    "polity-2": [{ type: "message",to:'polity-1', text: "NATIVE_PRIVATE_CANARY" }] });
  assert.equal(world.polities["polity-2"].messages.find(m => m.text === "NATIVE_PUBLIC_CANARY").broadcast, true);
  assert.equal(world.polities["polity-2"].messages.find(m => m.text === "NATIVE_PUBLIC_CANARY").channel_id, null);
  // The reducer advances authoritative T+1 before consequence presentation. The
  // production phase service supplies the completed logical-T projection; model
  // that exact adapter boundary while retaining the native producer's records.
  const logical={...world,turn:world.turn-1};
  const runService={world,participantState:async principalId=>({projection:projectWorld(logical,principalId),controls:{}})};
  const f = await fixture(t, { world,runService }); await login(f, false, "polity-2");
  assert.match(await f.page.locator("#messages article").filter({ hasText: "NATIVE_PUBLIC_CANARY" }).textContent(), /Public broadcast/);
  assert.match(await f.page.locator("#messages article").filter({ hasText: "NATIVE_PRIVATE_CANARY" }).textContent(), /Private/);
  const ax = await f.page.locator("#messages").ariaSnapshot(); assert.match(ax, /Public broadcast/); assert.match(ax, /Private/);
  verifyEvidenceIntegrity(world.evidence.bundle());
});

test("human reconnaissance accepts unknown coordinates through the same validator without enumerating hidden hexes", async t => {
  const f = await fixture(t); f.world.polities["polity-1"].technologies.push("satellites");
  const projection = projectWorld(f.world, "polity-1"), known = projection.fields.find(x => x.path === "public.known_map").value;
  const target = Object.keys(f.world.hexes).find(id => !Object.hasOwn(known, id)); assert(target);
  assert.equal(f.world.validateAction("polity-1", { type: "reconnaissance", action_id: "fixture", hex_id: target }).ok, true);
  await login(f); assert.equal(await f.page.locator(`#map [data-hex-id="${target}"]`).count(), 0);
  await f.page.locator("#action-type").selectOption("reconnaissance");
  const input = f.page.getByLabel("Target hex coordinate (known or unknown, hex-q-r)");
  assert.equal(await input.getAttribute("type"), "text"); assert.equal(await input.getAttribute("list"), null);
  await input.fill(target); await f.page.getByRole("button", { name: "Add to draft" }).click();
  const sent = f.page.waitForResponse(r => r.url().endsWith("/api/action")); await f.page.locator("#submit-actions").click();
  assert.equal((await sent).status(), 200);
  const event = f.world.evidence.events.findLast(e => e.event_type === "ActionSubmitted");
  assert.equal(event.payload.actions[0].hex_id, target);
});

test("out-of-bounds reconnaissance still follows canonical action rejection", async t => {
  const f = await fixture(t); f.world.polities["polity-1"].technologies.push("satellites");
  const response = await f.request("/api/action", f.issue(), { type: "reconnaissance", hex_id: "hex-9999-9999" });
  assert.equal(response.status, 422); assert.equal((await response.json()).error, "action_rejected");
});

test("stopped synthetic fallback disables controls and rejects mutations without new actions", async t => {
  for (const status of ["invalid", "contaminated", "interrupted", "incomplete"]) await t.test(status, async t => {
    const f = await fixture(t), token = f.issue(), disposition = stop(f.world, status), before = f.world.evidence.events.length;
    const state = await (await f.request("/api/state", token)).json();
    assert.equal(state.controls.execution_enabled, false); assert.equal(state.controls.can_submit, false);
    assert.doesNotMatch(JSON.stringify(state), new RegExp(disposition.event_id));
    const response = await f.request("/api/action", token, { type: "wait" });
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: "submission_unavailable" });
    assert.equal(f.world.evidence.events.length, before);
  });
});

test("attributable domain and identity denials are private canonical Violations, not breaches", async t => {
  const f = await fixture(t), participant = f.issue(), observer = f.issue("researcher", "research_observation");
  const stateBefore = await (await f.request("/api/state", participant)).json(), hash = f.world.stateHash();
  for (const [path, token] of [["/api/observer", participant], ["/api/state", observer]]) {
    const response = await f.request(path, token); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
  const forged = await f.request("/api/action", participant, { type: "wait", actor_id: "polity-2", session_id: "UNTRUSTED_SESSION_CANARY" });
  assert.equal(forged.status, 400); assert.deepEqual(await forged.json(), { error: "invalid_action_request" });
  const violations = f.world.evidence.events.filter(e => e.event_type === "Violation"); assert.equal(violations.length, 3);
  for (const event of violations) {
    assert.equal(event.catalogue_entry_ref, "EVENT_CATALOGUE.spec.json#Violation"); assert.equal(event.payload_schema_ref, "generic-event-payload.schema.json");
    assert.equal(event.visibility.acl_ref, "observer"); assert.equal(event.payload.containment.breach, false);
    assert.equal(event.payload.containment.status, "denied"); assert.equal(event.payload.measurement_status, "not_measured");
    assert(f.world.evidence.payloads.has(event.payload.policy_ref));
    assert(event.causality.causation_ids.every(ref => f.world.evidence.events.some(e => e.event_id === ref && e.sequence < event.sequence)));
    assert.deepEqual(event.lineage.session_ids, []);
  }
  assert.deepEqual(violations.map(e => e.participants), [["polity-1"], ["researcher"], ["polity-1"]]);
  assert.doesNotMatch(JSON.stringify(f.world.evidence.bundle()), new RegExp(`${participant}|${observer}|UNTRUSTED_SESSION_CANARY`));
  assert.equal(f.world.evidence.events.some(e => ["SecurityIncident", "RunDisposition", "ActionSubmitted"].includes(e.event_type)), false);
  assert.equal(f.world.stateHash(), hash); assert.deepEqual(await (await f.request("/api/state", participant)).json(), stateBefore);
  verifyEvidenceIntegrity(f.world.evidence.bundle()); reconstructRun(f.world.evidence.bundle());
  const count = f.world.evidence.events.length, revoked = f.issue(); f.app.auth.revoke(revoked);
  for (const token of ["bogus", revoked, f.issue("polity-1", "participant_projection", { runId: "foreign-run" })]) assert.equal((await f.request("/api/observer", token)).status, 401);
  assert.equal(f.world.evidence.events.length, count);
});

test("concurrent authenticated denials use durable security checkpoints and survive restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "civlab-ui-second-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), runId = "ui-denial-durability";
  const binding = { directory, runId, ...keys, keyId: archiveKeyId(keys.publicKey) }, archive = new SignedArchive(binding);
  const service = await RunService.create({ world: makeWorld({ runId }), archive, allowSyntheticExecution: true });
  const f = await fixture(t, { runService: service }), token = f.issue(), before = service.world.stateHash();
  const responses = await Promise.all([f.request("/api/observer", token), f.request("/api/action", token, { type: "wait", actor_id: "polity-2" })]);
  assert.deepEqual(responses.map(r => r.status), [401, 400]);
  const restarted = await RunService.recover({ archive: new SignedArchive(binding), allowSyntheticExecution: true });
  assert.equal(restarted.world.evidence.events.filter(e => e.event_type === "Violation").length, 2);
  assert.equal(restarted.world.stateHash(), before);
  assert.equal(restarted.world.evidence.events.some(e => e.event_type === "RunDisposition"), false);
  const loaded = await archive.load(); assert.equal(loaded.service_state.requests.filter(r => r.kind === "security").length, 2);
  assert.doesNotMatch(JSON.stringify(loaded), new RegExp(token));
  assert.equal((await restarted.participantState("polity-1")).controls.can_submit, true);
});

test("invalid-run disposition is prominent, accessible, and links to its canonical source", async t => {
  const f = await fixture(t), event = stop(f.world); await login(f, true);
  const notice = f.page.locator("#run-disposition"); assert.equal(await notice.isVisible(), true);
  assert.equal(await notice.getAttribute("role"), "alert");
  assert.match(await notice.textContent(), /Run INVALID.*Confirmatory eligible: false.*Primary endpoint eligible: false/s);
  await notice.getByRole("button", { name: event.event_id }).click();
  assert.match(await f.page.locator("#raw-event").textContent(), /"execution_status": "invalid"/);
  assert.match(await f.page.locator("body").ariaSnapshot(), /Run INVALID/);
  await f.page.getByRole("button", { name: "Clear session" }).click(); assert.equal(await notice.textContent(), "");
});

test("truth-to-knowledge replay retains one keyboard map entry when the old hex disappears", async t => {
  const world = makeWorld({ runId: "review-map-focus", seed: "ui-conformance" }); turn(world);
  const f = await fixture(t, { world }); await login(f, true);
  const known = projectWorld(world, "polity-1").fields.find(f => f.path === "public.known_map").value;
  const unknown = Object.keys(world.hexes).find(id => !Object.hasOwn(known, id)); assert(unknown);
  await f.page.locator(`#map [data-hex-id="${unknown}"]`).click();
  await f.page.locator("#replay-view").selectOption("knowledge"); await f.page.locator("#replay-principal").selectOption("polity-1");
  await f.page.getByRole("button", { name: "Reconstruct completed turn" }).click();
  await f.page.waitForFunction(() => document.querySelector("#replay-status").textContent.includes("STATE_RECONSTRUCTED"));
  assert.equal(await f.page.locator(`#map [data-hex-id="${unknown}"]`).count(), 0);
  const entry = f.page.locator('#map [tabindex="0"]'); assert.equal(await entry.count(), 1);
  await entry.focus(); await f.page.keyboard.press("Enter"); assert.match(await f.page.locator("#tile-detail").textContent(), /hex-/);
  await f.page.getByRole("button", { name: "Refresh evidence" }).click();
  await f.page.waitForFunction(() => document.querySelector("#replay-status").textContent === "Current state");
  assert.equal(await f.page.locator("#view-badge").textContent(), "Observer truth");
});

test("native Confidant envelopes decode exact Unicode as inert text and reject invalid raw hashes at ingestion", async t => {
  const world = makeWorld({ runId: "review-confidant-envelope" }), answer = 'Résumé 🌍 <svg onload="alert(1)">Synthetic private answer.</svg>';
  const model = new Qwen35BaseAdapter({ synthetic: true, model: "Qwen/Qwen3.5-9B-Base", revision: "a".repeat(40), backend: "mlx",
    artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64),
    transport: async () => ({ status: 200, body: JSON.stringify({ model: "Qwen/Qwen3.5-9B-Base", hf_revision: "a".repeat(40),
      artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64), choices: [{ text: answer, finish_reason: "stop" }] }) }) });
  const runtime = new AgentRuntime({ world, actorId: "polity-1", model, now: () => 0 }); turn(world);
  const reports = await new Confidant({ world, now: () => 0 }).interviewAll([runtime]); assert.equal(reports[0].status, "recorded");
  const interview = world.evidence.events.findLast(e => e.event_type === "InterviewResponse");
  const envelope = JSON.parse(world.evidence.payloads.get(interview.payload.response_payload_ref).bytes); assert.equal(envelope.encoding, "base64");
  // A malformed envelope must fail closed before it can enter canonical
  // evidence; the valid native envelope remains an inert UI text fixture.
  assert.throws(() => world.evidence.putPayload({ ...envelope, raw_sha256: "0".repeat(64) }), /raw evidence digest mismatch/);
  verifyEvidenceIntegrity(world.evidence.bundle());
  const f = await fixture(t, { world }); await login(f, true);
  await f.page.waitForFunction(() => document.querySelector("#interviews").textContent.includes("Résumé"));
  assert.equal(await f.page.locator("#interviews tr").first().locator("pre").textContent(), answer);
  assert.equal(await f.page.locator("#interviews svg").count(), 0);
  assert.match(await f.page.locator("#interviews").ariaSnapshot(), /Résumé/);
  await f.page.locator("#interviews tr").first().getByRole("button", { name: interview.event_id }).click();
  await f.page.getByRole("button", { name: `Raw payload ${interview.payload.response_payload_ref}`, exact: true }).click();
  assert.equal(JSON.parse(await f.page.locator("#raw-payload").textContent()).data, envelope.data);
});
