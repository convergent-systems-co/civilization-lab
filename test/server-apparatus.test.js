import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.js";
import { makeWorld } from "../src/world.js";
import { SignedArchive, archiveKeyId } from "../src/archive.js";
import { RunService } from "../src/run-service.js";
import { ACTION_META, CATALOGUE } from "../ui/action-meta.js";
import { SERVER_OWNED_ACTION_FIELDS } from "../src/action-contract.js";

async function setup(t, options = {}) {
  const app = createApplication({ world: makeWorld({ runId: "synthetic-apparatus", seed: "apparatus-conformance" }), ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const issue = (principalId = "polity-1", domain = "participant_projection") => app.auth.issue({ runId: app.world.runId, principalId, domain, ttlMs: 60000 });
  const request = (path, token, body) => fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { app, url, issue, request };
}

test("presentation action controls cover the entire typed schema without invented fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/action-api.schema.json", import.meta.url)));
  assert.deepEqual(Object.keys(ACTION_META).sort(), [...schema.properties.type.enum].sort());
  for (const conditional of schema.allOf) {
    const type = conditional.if.properties.type.const, fields = ACTION_META[type].fields;
    for (const required of conditional.then.required) assert(fields.some(f => f.key === required && !f.optional), `${type} missing required ${required}`);
    for (const f of fields) assert(Object.hasOwn(conditional.then.properties, f.key), `${type} has unsupported ${f.key}`);
  }
  const config = JSON.parse(await readFile(new URL("../config/pilot0-world.json", import.meta.url)));
  assert.deepEqual(CATALOGUE.unit_types, Object.keys(config.unitTypes));
  assert.deepEqual(CATALOGUE.facility_types, Object.keys(config.facilityTypes));
  assert.deepEqual(CATALOGUE.technology_types, Object.keys(config.technologies));
  assert.doesNotMatch(JSON.stringify(ACTION_META), /fulfill_commitment|breach_commitment|trust_score|betrayal|organization/);
});

test("build default denies execution and exposes no launch, fork or participant replay capability", async t => {
  const f = await setup(t), token = f.issue(), before = f.app.world.stateHash();
  const state = await (await f.request("/api/state", token)).json();
  assert.equal(state.controls.execution_enabled, false); assert.equal(state.controls.can_submit, false);
  assert.equal((await f.request("/api/action", token, { type: "wait" })).status, 403);
  for (const path of ["/api/start", "/api/calibrate", "/api/replay", "/api/fork"]) assert.equal((await f.request(path, token)).status, 404);
  assert.equal(f.app.world.stateHash(), before);
  const observer = f.issue("researcher", "research_observation");
  for (const path of ["/api/observer", "/api/observer/export", "/api/observer/replay?turn=0"]) assert.equal((await f.request(path, token)).status, 401);
  assert.equal((await f.request("/api/action", observer, { type: "wait" })).status, 401);
  assert.equal((await f.request("/api/state?principal=polity-2", token)).status, 400);
});

test('all-rejected HTTP turn commits an empty set and advances without fabricating accepted waits',async t=>{
  const f=await setup(t,{allowSyntheticExecution:true});
  for(const id of Object.keys(f.app.world.polities))assert.equal((await f.request('/api/action',f.issue(id),{type:'invalid-world-action'})).status,422);
  assert.equal(f.app.world.turn,1);
  const commit=f.app.world.evidence.events.find(e=>e.event_type==='TurnCommitted');
  assert.deepEqual(commit.payload.accepted_action_ids,[]);assert.equal(f.app.world.evidence.events.filter(e=>e.event_type==='ActionAccepted').length,0);
});

test('human mechanics metadata is identical to the typed rules supplied in the AI projection',async t=>{
  const f=await setup(t),token=f.issue();
  const state=await(await f.request('/api/state',token)).json();
  const rules=await(await f.request('/api/action-meta',token)).json();
  assert.deepEqual(state.projection.fields.find(field=>field.path==='public.rules').value,rules);
  assert.equal(rules.rules.action_limit,f.app.world.config.phases.actionLimit);
  const visit=value=>{
    if(Array.isArray(value)){for(const child of value)visit(child);return;}
    if(!value||typeof value!=='object')return;
    if(value.properties)for(const key of SERVER_OWNED_ACTION_FIELDS)assert.equal(Object.hasOwn(value.properties,key),false,`advertised server-owned field ${key}`);
    if(value.required)for(const key of SERVER_OWNED_ACTION_FIELDS)assert.equal(value.required.includes(key),false,`required server-owned field ${key}`);
    for(const child of Object.values(value))visit(child);
  };
  visit(rules.rules.action_contract);
});

test('human action endpoint rejects every server-owned field without creating a submission',async t=>{
  const f=await setup(t,{allowSyntheticExecution:true}),token=f.issue();
  for(const key of SERVER_OWNED_ACTION_FIELDS){
    for (const action of [{type:'wait',[key]:'forged'}, {type:'message',text:'x',metadata:{nested:[{[key]:'forged'}]}}]) {
      const response=await f.request('/api/action',token,action);
      assert.equal(response.status,400,key);
    }
  }
  assert.equal(f.app.world.evidence.events.some(event=>event.event_type==='ActionSubmitted'),false);
});

test("participant bytes remain identical after hidden roster, resource, message and memory mutations", async t => {
  const f = await setup(t), token = f.issue();
  const before = await (await f.request("/api/state", token)).text();
  const metadataBefore = await (await f.request("/api/action-meta", token)).text();
  assert.doesNotMatch(metadataBefore, /polity-|startingProfiles|"starts"|"seed"|model|memory/);
  const foreign = f.app.world.polities["polity-2"];
  foreign.name = "HIDDEN-NAME-CANARY"; foreign.credits = 123456; foreign.memory.push("HIDDEN-MEMORY-CANARY");
  foreign.messages.push({ text: "HIDDEN-PRIVATE-CHANNEL-CANARY", turn: 0 });
  const hidden = Object.values(f.app.world.hexes).find(h => !f.app.world.polities["polity-1"].facts.hexes[h.id]);
  hidden.deposits = { "HIDDEN-DEPOSIT-CANARY": 99 };
  f.app.world.unaffiliatedPopulation.push({id:'HIDDEN-ORPHAN-CANARY',assignment:'Civilian',count:9,hex_id:hidden.id,territory_id:hidden.territory_id,affiliation_status:'unaffiliated'});
  f.app.world.neutralUnits.push({id:'HIDDEN-NEUTRAL-CANARY',type:'infantry',hex_id:hidden.id,territory_id:hidden.territory_id,status:'inactive_neutral',controller_id:null,crew:[],health:1});
  const after = await (await f.request("/api/state", token)).text();
  assert.equal(after, before); assert.doesNotMatch(after, /HIDDEN-|123456|polity-2|polity-3/);
  assert.equal(await (await f.request("/api/action-meta", token)).text(), metadataBefore);
});

test("stale batches, concurrent duplicates and rejected action corrections fail safely", async t => {
  const f = await setup(t, { allowSyntheticExecution: true }), token = f.issue();
  const { projection } = await (await f.request("/api/state", token)).json();
  const envelope = { actions: [{ type: "wait" }], turn: 0, projection_id: projection.projection_id };
  assert.equal((await f.request("/api/action", token, { ...envelope, turn: 99 })).status, 409);
  const responses = await Promise.all([f.request("/api/action", token, envelope), f.request("/api/action", token, envelope)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.app.world.evidence.events.filter(e => e.event_type === "ActionSubmitted").length, 1);
  const second = f.issue("polity-2");
  assert.equal((await f.request("/api/action", second, { type: "attack", unit_id: "not-owned", target_unit_id: "not-known" })).status, 422);
  assert.equal((await f.request("/api/action", second, { type: "wait" })).status, 409);
  assert.equal((await (await f.request("/api/state", second)).json()).controls.submission_status, "rejected");
  const third = f.issue("polity-3");
  assert.equal((await f.request("/api/action", third, { type: "not-a-world-action" })).status, 422);
  assert.equal((await f.request("/api/action", third, { type: "wait" })).status, 200);
  // The valid third request belongs to the next resolved turn. The rejected
  // malformed action remains canonical and never becomes a corrected order.
  assert(f.app.world.evidence.events.some(e => e.event_type === "ActionRejected"));
});

test("HTTP static serving is allowlisted and responses cannot enable external text resources", async t => {
  const f = await setup(t);
  for (const path of ["/src/auth.js", "/config/pilot0-model.json", "/../package.json", "/%2e%2e/package.json", "/ui/INTEGRATION.md"]) assert.equal((await fetch(f.url + path)).status, 404);
  for (const path of ["/", "/observer", "/app.js", "/observer.js", "/map.js", "/style.css"]) {
    const response = await fetch(f.url + path); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy"), /object-src 'none'.*frame-ancestors 'none'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("research replay is verified at historical time and redacted contents fail closed", async t => {
  const f = await setup(t, { allowSyntheticExecution: true }), observer = f.issue("researcher", "research_observation");
  assert.equal((await f.request("/api/observer/replay?turn=0", observer)).status, 409);
  for (const id of Object.keys(f.app.world.polities)) assert.equal((await f.request("/api/action", f.issue(id), { type: "wait" })).status, 200);
  const response = await f.request("/api/observer/replay?turn=0&view=knowledge&principal=polity-1", observer);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.projection.logical_time.turn, 0); assert.equal(result.gates.exact_reproducibility, true); assert.equal(result.gates.independent_sample, false);
  assert.equal(result.gates.logical_time.turn, 0);
  assert.equal(result.world, undefined); assert.equal(result.projection.principal.principal_id, "polity-1");
  const truth = await (await f.request("/api/observer/replay?turn=0", observer)).json();
  assert.equal(truth.gates.logical_time.turn, 0); assert.equal(truth.world.turn, 1);
  const bundle = f.app.world.evidence.bundle();
  f.app.world.evidence.bundle = () => ({ ...bundle, events: [...bundle.events, { event_type: "RedactionTombstone", payload: { text: "REDACTED-CANARY" } }] });
  for (const path of ["/api/observer", "/api/observer/export", "/api/observer/replay?turn=0"]) {
    const r = await f.request(path, observer); assert.equal(r.status, 409); const text = await r.text();
    assert.match(text, /REPLAY_INCOMPLETE_REDACTED/); assert.doesNotMatch(text, /REDACTED-CANARY|initial_state_ref/);
  }
});

test("durable RunService HTTP adapter publishes orders and follows the replaced world after resolution", async t => {
  const directory = await mkdtemp(join(tmpdir(), "civlab-http-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), world = makeWorld({ runId: "synthetic-http-durable", seed: "apparatus-durable" });
  const archive = new SignedArchive({ directory, runId: world.runId, ...keys, keyId: archiveKeyId(keys.publicKey) });
  const service = await RunService.create({ world, archive, allowSyntheticExecution: true });
  const f = await setup(t, { world, runService: service, allowSyntheticExecution: true });
  const submissions = [];
  for (const id of Object.keys(world.polities)) {
    const token = f.issue(id), state = await (await f.request("/api/state", token)).json();
    const r = await f.request("/api/action", token, { turn: 0, projection_id: state.projection.projection_id, actions: [{ type: "wait" }] });
    assert.equal(r.status, 200); submissions.push((await r.json()).submission_id);
  }
  const committed = await service.commit({ requestId: "http-fixture-commit", submissionIds: submissions });
  await service.resolve({ requestId: "http-fixture-resolve", committedId: committed.turn_committed_id });
  const state = await (await f.request("/api/state", f.issue())).json();
  assert.equal(state.projection.logical_time.turn, 1); assert.equal(f.app.world, service.world);
  const observed = await (await f.request("/api/observer", f.issue("researcher", "research_observation"))).json();
  assert.equal(observed.world.turn, 1);
  assert.equal(observed.evidence.events.at(-1).event_type, service.world.evidence.events.at(-1).event_type);
});
