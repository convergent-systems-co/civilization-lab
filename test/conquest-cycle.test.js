import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorld,cloneWorld,resolveTurn,assertWorldState} from '../src/world.js';
import {ActionLedger,commitTurn,projectWorld} from '../src/contracts.js';
import {observeWorld,discoverPolity} from '../src/world-map.js';
import {reconstructRun} from '../src/replay.js';
import {canonicalize,sha256} from '../src/core.js';
import {verifyEvidenceIntegrity} from '../src/replay.js';
import {createHmac} from 'node:crypto';

function rehash(bundle) {
  let previous=null;
  for(const event of bundle.events){
    const payload=structuredClone(event.payload);delete payload.payload_ref;
    const bytes=canonicalize(payload),payloadRef=sha256(bytes);
    bundle.payloads[payloadRef]={digest:payloadRef,classification:'research',bytes};event.payload={payload_ref:payloadRef,...payload};
    event.integrity.previous_hash=previous;event.integrity.canonical_bytes_hash=null;event.integrity.signature=null;
    event.integrity.signature=createHmac('sha256','pilot0-evidence:'+bundle.run_id).update(canonicalize(event)).digest('base64');
    event.integrity.canonical_bytes_hash=sha256(event);previous=event.integrity.canonical_bytes_hash;
  }
  return bundle;
}

function control(world,territoryId,owner,controller=owner) {
  Object.assign(world.territories[territoryId],{status:controller?'controlled':'unclaimed',owner_id:owner,controller_id:controller,exclusive_claimant_id:owner});
  for(const p of Object.values(world.polities))p.territory=Object.values(world.territories).filter(t=>t.owner_id===p.id).map(t=>t.territory_id).sort();
}
function prepareCycle(world,edges) {
  for(const [id,captor] of edges){const p=world.polities[id],territoryId=world.hexes[p.capital_hex_id].territory_id;control(world,territoryId,id,captor);p.takeover={controller_id:captor,held_turns:2};}
  for(const p of Object.values(world.polities))observeWorld(world,p.id);
  assertWorldState(world);
}
function commit(world,actorOrder=Object.keys(world.polities),promise=false) {
  const ledger=new ActionLedger(world.evidence),records=[];
  for(const id of actorOrder){
    if(!world.polities[id].alive)continue;
    const actions=promise&&id===actorOrder[0]?[{action_id:`promise-${id}`,type:'promise',to:actorOrder[1],text:'I will preserve this commitment after the current conflict.'}]:[{action_id:`wait-${id}`,type:'wait'}];
    const submission=ledger.submit({runId:world.runId,turnId:'turn-'+world.turn,actorId:id,actor:{persistent_identity_id:id,session_id:'session-'+id,invocation_id:'invocation-'+id},actions,projection:projectWorld(world,id)});
    const validated=ledger.validate(submission,world);assert.equal(validated.submission.status,'validated',JSON.stringify(validated.submission.validation));records.push(validated);
  }
  return commitTurn(world,ledger,records);
}
function branchedCycle(name,edges,mutate=()=>{}) {
  const root=makeWorld({runId:'cycle-root-'+name,seed:'cycle-fixed-seed'});mutate(root);prepareCycle(root,edges);
  return cloneWorld(root,{branchRunId:'cycle-branch-'+name});
}

test('closed two-polity cycle orphans every asset class, preserves commitments, and independently replays',()=>{
  const edges=[['polity-1','polity-2'],['polity-2','polity-1']];
  const world=branchedCycle('assets',edges,root=>{
    const p=root.polities['polity-1'],soldiers=p.citizens.find(g=>g.assignment==='Soldier'),crew={...structuredClone(soldiers),id:'cycle-crew',count:2};
    soldiers.count-=2;p.population=p.citizens.reduce((n,g)=>n+g.count,0);p.units.push({id:'cycle-unit',type:'infantry',hex_id:soldiers.hex_id,territory_id:soldiers.territory_id,health:root.config.unitTypes.infantry.health,strength:root.config.unitTypes.infantry.attack,fortified:false,embarked_on:null,crew:[crew],prerequisites:[],captured_from:null});
    discoverPolity(root,p,'polity-2','fixture');discoverPolity(root,root.polities['polity-2'],'polity-1','fixture');
    const external=root.hexes[root.polities['polity-3'].capital_hex_id].territory_id;control(root,external,'polity-1','polity-3');
  });
  const physicalResourceHexes=Object.fromEntries(['polity-1','polity-2'].map(id=>[id,Object.values(world.hexes)
    .filter(hex=>world.territories[hex.territory_id].owner_id===id).map(hex=>hex.id).sort()]));
  const physicalResources=sha256(Object.fromEntries(Object.entries(world.hexes).map(([id,h])=>[id,h.deposits])));
  resolveTurn(world,commit(world,['polity-1','polity-2','polity-3'],true));assertWorldState(world);
  for(const id of ['polity-1','polity-2']){const p=world.polities[id];assert.equal(p.alive,false);assert.equal(p.population,0);assert.equal(p.food,0);assert.equal(p.credits,0);assert.ok(Object.values(p.resources).every(n=>n===0));}
  assert.ok(world.unaffiliatedPopulation.some(g=>g.former_polity_id==='polity-1'));
  assert.ok(world.neutralUnits.some(u=>u.id==='cycle-unit'&&u.status==='inactive_neutral'&&u.controller_id===null));
  assert.ok(Object.values(world.facilities).filter(f=>['polity-1','polity-2'].includes(f.former_owner_id)).every(f=>f.owner_id===null));
  const external=world.territories[world.hexes[world.polities['polity-3'].capital_hex_id].territory_id];assert.equal(external.owner_id,null);assert.equal(external.controller_id,'polity-3');
  assert.equal(sha256(Object.fromEntries(Object.entries(world.hexes).map(([id,h])=>[id,h.deposits]))),physicalResources);
  const message=world.evidence.events.find(e=>e.event_type==='MessageSent'&&e.payload.participant_label==='promise');assert.ok(message);assert.ok(world.polities['polity-1'].messages.length);
  const summary=world.evidence.events.find(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='closed_conquest_cycle');
  for(const id of summary.payload.detail.asset_transition_event_ids)assert.ok(world.evidence.events.some(e=>e.event_id===id&&e.run_id===world.runId));
  const eliminationEvents=world.evidence.events.filter(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='polity_elimination'&&['polity-1','polity-2'].some(id=>e.participants.includes(id)));
  assert.deepEqual(summary.payload.detail.elimination_event_ids,eliminationEvents.map(e=>e.event_id).sort());
  for(const id of summary.payload.detail.elimination_event_ids)assert.ok(summary.causality.causation_ids.includes(id));
  const resourceEvents=world.evidence.events.filter(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='resource_extinguishment');
  assert.equal(resourceEvents.length,2);const seen=new Set();
  for(const event of resourceEvents){
    const actor=event.participants[0],before=JSON.parse(world.evidence.payloads.get(event.payload.before_state_ref).bytes),hexes=Object.keys(before.physically_located).sort();
    assert.deepEqual(hexes,physicalResourceHexes[actor]);assert.deepEqual(event.payload.detail.physical_resource_hex_ids,hexes);
    assert.equal(event.payload.detail.former_owner_id,actor);
    for(const hex of hexes){assert.equal(seen.has(hex),false,'physical resource hex was attributed to multiple eliminated polities');seen.add(hex);}
  }
  const result=reconstructRun(world.evidence.bundle());
  assert.equal(result.resolvedTurns,1);assert.equal(canonicalize(result.world.authoritativeState()),canonicalize(world.authoritativeState()));
});

test('three-polity cycle has no successor and is independent of submission and collection order',()=>{
  const edges=[['polity-1','polity-2'],['polity-2','polity-3'],['polity-3','polity-1']];
  const a=branchedCycle('order-a',edges),b=branchedCycle('order-b',edges);
  b.polities=Object.fromEntries(Object.entries(b.polities).reverse());b.territories=Object.fromEntries(Object.entries(b.territories).reverse());b.facilities=Object.fromEntries(Object.entries(b.facilities).reverse());
  resolveTurn(a,commit(a,['polity-1','polity-2','polity-3']));resolveTurn(b,commit(b,['polity-3','polity-1','polity-2']));
  const normalize=world=>({polities:Object.fromEntries(Object.entries(world.polities).sort().map(([id,p])=>[id,{alive:p.alive,population:p.population,food:p.food,credits:p.credits}])),territories:Object.values(world.territories).map(t=>({id:t.territory_id,owner:t.owner_id,controller:t.controller_id})).sort((x,y)=>x.id.localeCompare(y.id)),unaffiliated_count:world.unaffiliatedPopulation.reduce((n,g)=>n+g.count,0),neutral_count:world.neutralUnits.length});
  assert.deepEqual(normalize(a),normalize(b));assert.ok(Object.values(a.polities).every(p=>!p.alive));assert.ok(Object.values(a.territories).every(t=>t.owner_id===null));
});

test('a four-polity closed cycle is eliminated atomically without an ID-selected beneficiary',()=>{
  const root=makeWorld({runId:'cycle-root-four',seed:'cycle-fixed-seed'}),source=root.polities['polity-3'],sourceHex=root.hexes[source.capital_hex_id],sourceTerritory=root.territories[sourceHex.territory_id];
  const hexId='hex-cycle-four',territoryId='territory-cycle-four';root.hexes[hexId]={...structuredClone(sourceHex),id:hexId,territory_id:territoryId};
  root.territories[territoryId]={...structuredClone(sourceTerritory),territory_id:territoryId,owner_id:'polity-4',controller_id:'polity-4',exclusive_claimant_id:'polity-4'};
  const p4=structuredClone(source);p4.id='polity-4';p4.capital_hex_id=hexId;p4.territory=[territoryId];p4.knowledge=['polity-4'];p4.facts={hexes:{},territories:{},units:{},facilities:{},polities:{},deposits:{}};p4.messages=[];p4.reports=[];
  p4.citizens=p4.citizens.map((g,i)=>({...g,id:'p4-citizen-'+i,hex_id:hexId,territory_id:territoryId}));root.polities[p4.id]=p4;
  prepareCycle(root,[['polity-1','polity-2'],['polity-2','polity-3'],['polity-3','polity-4'],['polity-4','polity-1']]);
  const world=cloneWorld(root,{branchRunId:'cycle-branch-four'});resolveTurn(world,commit(world,['polity-4','polity-2','polity-1','polity-3']));
  assert.ok(Object.values(world.polities).every(p=>!p.alive));assert.ok(Object.values(world.territories).every(t=>t.owner_id===null));assert.equal(world.unaffiliatedPopulation.reduce((n,g)=>n+g.count,0),100);
  const summary=world.evidence.events.find(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='closed_conquest_cycle');assert.deepEqual(summary.payload.detail.cycle_members,['polity-1','polity-2','polity-3','polity-4']);
});

test('a crash while cyclic estate events are staged publishes no partial succession and recovers exactly once',()=>{
  const edges=[['polity-1','polity-2'],['polity-2','polity-1']],world=branchedCycle('crash',edges),committed=commit(world,['polity-2','polity-1','polity-3']);
  const state=canonicalize(world.authoritativeState()),events=canonicalize(world.evidence.events),payloadCount=world.evidence.payloads.size;
  // This fixture submits only waits, so its first TerritoryTransition is the
  // cycle estate transition. Crash after it was appended to the staging store:
  // recovery must discard both the partial event and its state/payload effects.
  assert.throws(()=>resolveTurn(world,committed,{fault:(point,context)=>{if(point==='after_event'&&context.event_type==='TerritoryTransition')throw new Error('synthetic cycle crash');}}),/synthetic cycle crash/);
  assert.equal(canonicalize(world.authoritativeState()),state);assert.equal(canonicalize(world.evidence.events),events);assert.equal(world.evidence.payloads.size,payloadCount);
  resolveTurn(world,committed);assert.equal(world.evidence.events.filter(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='closed_conquest_cycle').length,1);
  assert.equal(reconstructRun(world.evidence.bundle()).resolvedTurns,1);
});

test('cyclic estate archives reject a missing referenced asset input payload',()=>{
  const world=branchedCycle('missing-estate-input',[['polity-1','polity-2'],['polity-2','polity-1']]);
  resolveTurn(world,commit(world));const bundle=world.evidence.bundle();
  const estate=bundle.events.find(event=>event.event_type==='PopulationUnitTransition'&&event.payload.transition==='estate_disposition');
  const missing=estate.payload.resource_input_refs[0];assert.ok(bundle.payloads[missing]);delete bundle.payloads[missing];
  assert.throws(()=>verifyEvidenceIntegrity(bundle),/missing or corrupt external input evidence/);
});

test('cyclic estate archives reject an elimination reference omitted from canonical causality',()=>{
  const world=branchedCycle('elimination-causality',[['polity-1','polity-2'],['polity-2','polity-1']]);
  resolveTurn(world,commit(world));const bundle=world.evidence.bundle();
  const summary=bundle.events.find(event=>event.event_type==='WorldTransition'&&event.payload.mechanic==='closed_conquest_cycle');
  assert.equal(summary.payload.detail.elimination_event_ids.length,2);
  summary.causality.causation_ids=summary.causality.causation_ids.filter(id=>id!==summary.payload.detail.elimination_event_ids[0]);
  assert.throws(()=>verifyEvidenceIntegrity(rehash(bundle)),/elimination.*canonical causal predecessor/);
});

test('cyclic estate archives reject duplicate physical-resource attribution across eliminated polities',()=>{
  const world=branchedCycle('resource-overlap',[['polity-1','polity-2'],['polity-2','polity-1']]);
  resolveTurn(world,commit(world));const bundle=world.evidence.bundle();
  const resources=bundle.events.filter(event=>event.event_type==='WorldTransition'&&event.payload.mechanic==='resource_extinguishment');
  assert.equal(resources.length,2);
  const firstState=JSON.parse(bundle.payloads[resources[0].payload.before_state_ref].bytes),secondState=JSON.parse(bundle.payloads[resources[1].payload.before_state_ref].bytes);
  const duplicateHex=Object.keys(firstState.physically_located)[0];assert.ok(duplicateHex);
  secondState.physically_located[duplicateHex]=structuredClone(firstState.physically_located[duplicateHex]);
  const bytes=canonicalize(secondState),ref=sha256(bytes);bundle.payloads[ref]={digest:ref,classification:'world_mechanic_input',bytes};
  resources[1].payload.before_state_ref=ref;resources[1].payload.detail.physical_resource_hex_ids.push(duplicateHex);
  resources[1].payload.detail.physical_resource_hex_ids.sort();
  assert.throws(()=>verifyEvidenceIntegrity(rehash(bundle)),/physical resource hex attributed to multiple cyclic estates/);
});
