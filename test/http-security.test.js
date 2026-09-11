import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.js";
import { makeWorld } from "../src/world.js";
import { replay,createAuthorizationContext } from "../src/replay.js";

async function setup(t) {
  const app=createApplication({world:makeWorld({runId:"synthetic-http",seed:"http-seed"}),allowSyntheticExecution:true});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const url="http://127.0.0.1:"+app.server.address().port;
  const issue=(principalId,domain="participant_projection")=>app.auth.issue({runId:app.world.runId,principalId,domain,ttlMs:60000});
  const request=(path,token,options={})=>fetch(url+path,{...options,headers:{authorization:"Bearer "+token,"content-type":"application/json"}});
  return {...app,url,issue,request};
}
test("HTTP domains reject cross-participant, cross-run, and observer privilege confusion",async t=>{
  const app=await setup(t), first=app.issue("polity-1"), second=app.issue("polity-2"), observer=app.issue("researcher","research_observation");
  const state=await app.request("/api/state",first); assert.equal(state.status,200);
  const data=await state.json(); assert.equal(data.projection.principal.principal_id,"polity-1");
  assert.equal((await app.request("/api/observer",first)).status,401);
  assert.equal((await app.request("/api/state",observer)).status,401);
  assert.equal((await app.request("/api/observer",observer)).status,200);
  const another=await (await app.request("/api/state",second)).json(); assert.equal(another.projection.principal.principal_id,"polity-2");
  const foreign=app.auth.issue({runId:"other-run",principalId:"polity-1",domain:"participant_projection",ttlMs:60000});
  assert.equal((await app.request("/api/state",foreign)).status,401);
  assert.equal((await app.request("/api/state","pilot0-local-polity-1")).status,401);
  assert.equal(state.headers.get("cache-control"),"no-store");
  assert.doesNotMatch(JSON.stringify(data),new RegExp(first));
});
test("synthetic complete HTTP turn uses the same canonical ledger and replay reducers",async t=>{
  const app=await setup(t);
  for(const id of Object.keys(app.world.polities)) {
    const response=await app.request("/api/action",app.issue(id),{method:"POST",body:JSON.stringify({type:"wait"})}); assert.equal(response.status,200);
  }
  assert.equal(app.world.turn,1);
  const result=replay(app.world.evidence.bundle(),{expectedRunId:app.world.runId,authorizationContext:createAuthorizationContext("trusted_replay")});
  assert.equal(result.state_digest,app.world.stateHash());
});
test("forged actor fields cannot reach another participant ledger",async t=>{
  const app=await setup(t), before=app.world.evidence.events.length;
  const response=await app.request("/api/action",app.issue("polity-1"),{method:"POST",body:JSON.stringify({type:"wait",actor_id:"polity-2"})});
  assert.equal(response.status,400); assert.equal(app.world.evidence.events.length,before+1);
  const violation=app.world.evidence.events.at(-1);
  assert.equal(violation.event_type,'Violation');assert.deepEqual(violation.participants,['polity-1']);
  assert.equal(violation.payload.denied_resource,'server_owned_identity_fields');
  assert.equal(violation.payload.containment.breach,false);
  assert.equal(app.world.evidence.events.some(e=>e.sequence>=before&&e.event_type==='ActionSubmitted'),false);
  assert.doesNotMatch(JSON.stringify(violation),/Bearer|credential|polity-2/);
});
test("served player markup and scripts contain neither undiscovered roster nor static credentials",async t=>{
  const app=await setup(t);
  const markup=await fetch(app.url).then(r=>r.text()), script=await fetch(app.url+"/app.js").then(r=>r.text());
  for(const content of [markup,script]) assert.doesNotMatch(content,/Aster|Boreal|Cyrene|pilot0-local-polity|localStorage|innerHTML/);
  assert.match(markup,/type="password"/); assert.match(markup,/aria-label/);
});
