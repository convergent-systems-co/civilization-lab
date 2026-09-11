import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld,resolveTurn } from "../src/world.js";
import { ActionLedger,commitTurn,projectWorld } from "../src/contracts.js";
import { DurableJournal } from "../src/recovery.js";

async function prepare(t) {
  const dir=await mkdtemp(join(tmpdir(),"civlab-recovery-")); t.after(()=>rm(dir,{recursive:true,force:true}));
  const world=makeWorld({runId:"synthetic-crash",seed:"crash-fixture"}), ledger=new ActionLedger(world.evidence), journal=new DurableJournal(dir,world.runId);
  return {world,ledger,journal};
}
function submit(world,ledger) { const id="polity-1"; return ledger.submit({runId:world.runId,turnId:"turn-0",actorId:id,actor:{persistent_identity_id:id,session_id:"session-1",invocation_id:"invocation-1"},actions:[{action_id:"recruit-1",type:"recruit"}],projection:projectWorld(world,id)}); }

test("process restart reconstructs before submission, after submission, and after validation",async t=>{
  const {world,ledger,journal}=await prepare(t);
  await journal.persist(world.evidence.bundle()); assert.equal((await journal.recover()).ledger.submissions.size,0);
  const sub=submit(world,ledger); await journal.persist(world.evidence.bundle());
  assert.equal((await journal.recover()).ledger.submissions.get(sub.submission_id).status,"submitted");
  ledger.validate(sub,world); await journal.persist(world.evidence.bundle());
  assert.equal((await journal.recover()).ledger.submissions.get(sub.submission_id).status,"validated");
});

for(const stage of ["before_persistence","after_generation_fsync","before_pointer_publish","after_pointer_publish"]) test("durable generation is atomic across crash at "+stage,async t=>{
  const {world,ledger,journal}=await prepare(t);
  await journal.persist(world.evidence.bundle()); const oldHead=world.evidence.previousHash;
  const sub=submit(world,ledger), valid=ledger.validate(sub,world), commit=commitTurn(world,ledger,[valid]);
  const committedHead=world.evidence.previousHash;
  await assert.rejects(journal.persist(world.evidence.bundle(),{fault:point=>{if(point===stage) throw new Error("injected crash");}}),/injected crash/);
  const recovered=await journal.recover();
  assert.equal(recovered.world.evidence.previousHash,stage==="after_pointer_publish"?committedHead:oldHead);
  if(recovered.pendingCommit) { resolveTurn(recovered.world,recovered.pendingCommit); resolveTurn(world,commit); assert.equal(recovered.world.stateHash(),world.stateHash()); }
});

test("crash after reducer begins emitting recovers exactly once from durable TurnCommitted",async t=>{
  const {world,ledger,journal}=await prepare(t), sub=submit(world,ledger), commit=commitTurn(world,ledger,[ledger.validate(sub,world)]);
  await journal.persist(world.evidence.bundle());
  const committedHead=world.evidence.previousHash;
  assert.throws(()=>resolveTurn(world,commit,{fault:(point,detail)=>{if(point==='after_event' && detail.event_type==='PopulationUnitTransition')throw new Error('process crashed during resolution');}}),/process crashed/);
  // Staged publication is atomic: the half-resolved events never enter the live
  // canonical bundle. The last durable commit remains a valid recovery boundary.
  assert.equal(world.evidence.previousHash,committedHead);
  await journal.persist(world.evidence.bundle());
  const recovered=await journal.recover(); resolveTurn(recovered.world,recovered.pendingCommit);
  assert.equal(recovered.world.polities["polity-1"].units.length,1);
  await journal.persist(recovered.world.evidence.bundle());
  const restarted=await journal.recover(); assert.equal(restarted.pendingCommit,null);
  assert.equal(restarted.world.evidence.previousHash,recovered.world.evidence.previousHash);
  assert.equal(restarted.world.polities["polity-1"].units.length,1);
});
