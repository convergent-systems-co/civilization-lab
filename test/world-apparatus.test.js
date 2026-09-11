import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, resolveTurn, PILOT_0_CONFIG, projectWorldState, cloneWorld, assertWorldState, hexDistance, findPath, contiguous } from '../src/world.js';
import { ActionLedger, commitTurn, projectWorld } from '../src/contracts.js';
import { clone, canonicalize, sha256 } from '../src/core.js';
import { observeWorld, territoryHexes, sortedValues } from '../src/world-map.js';
import { planAction, conflictComponents } from '../src/world-actions.js';
import { replay, createAuthorizationContext } from '../src/replay.js';
import { assertValidSchema } from '../src/schema.js';
import { mulDiv } from '../src/world-numeric.js';
import { WorldRng } from '../src/world-rng.js';
import { EvidenceStore } from '../src/evidence.js';

// NONEMPIRICAL conformance fixtures only. All actions use the production ledger,
// schemas, addressed RNG, append authority and reducer; no transport/model doubles.
const fixture=(name,config=PILOT_0_CONFIG)=>makeWorld({runId:'nonempirical-world-'+name,seed:'frozen-world-conformance-v2',config});
const actor=id=>({persistent_identity_id:id,session_id:'session-'+id,invocation_id:'invocation-'+id});
function commit(w,orders,ledger=new ActionLedger(w.evidence)) {
  const results=Object.entries(orders).map(([id,actions])=>{
    const submitted=ledger.submit({runId:w.runId,turnId:'turn-'+w.turn,actorId:id,actor:actor(id),actions:actions.map((a,i)=>({action_id:`${w.turn}:${id}:${i}`,...a})),projection:projectWorld(w,id)});
    const result=ledger.validate(submitted,w);assert.equal(result.submission.status,'validated',JSON.stringify(result.submission.validation));return result;
  });
  return commitTurn(w,ledger,results);
}
function turn(w,orders={'polity-1':[{type:'wait'}]}) {resolveTurn(w,commit(w,orders));return w;}
function relocate(w,entity,hexId) {entity.hex_id=hexId;entity.territory_id=w.hexes[hexId].territory_id;}
function refresh(w) {for(const p of Object.values(w.polities))observeWorld(w,p.id);}
const job=(w,id,assignment)=>w.polities[id].citizens.find(g=>g.assignment===assignment);
const facility=(w,id,type)=>Object.values(w.facilities).find(f=>f.owner_id===id && f.type===type);
function contact(w) {turn(w,Object.fromEntries(Object.keys(w.polities).map(id=>[id,[{type:'broadcast',text:'hello'}]])));}
function recruitPair(w) {turn(w,{'polity-1':[{type:'recruit'}],'polity-2':[{type:'recruit'}]});const [a,b]=['polity-1','polity-2'].map(id=>w.polities[id].units[0]);relocate(w,a,'hex-5-2');relocate(w,b,'hex-6-2');refresh(w);return [a,b];}

test('world geometry, finite resources, viable asymmetric starts and hidden initial roster are deterministic',()=>{
  const a=fixture('map'),b=fixture('map');assert.equal(a.stateHash(),b.stateHash());assert.equal(canonicalize(a.evidence.events),canonicalize(b.evidence.events));
  const differentRun=fixture('same-seed-new-run');assert.deepEqual(a.hexes,differentRun.hexes);assert.deepEqual(Object.values(a.polities).map(p=>p.resources),Object.values(differentRun.polities).map(p=>p.resources));
  assert.equal(Object.keys(a.hexes).length,a.config.map.width*a.config.map.height);assert.ok(Object.keys(a.territories).length<Object.keys(a.hexes).length);
  assert.ok(Object.values(a.hexes).some(h=>h.terrain==='water'));assert.ok(Object.values(a.hexes).some(h=>h.coast));
  for(const p of Object.values(a.polities)){
    assert.deepEqual(p.knowledge,[p.id]);assert.equal(p.name,null);assert.equal(p.population,p.citizens.reduce((n,g)=>n+g.count,0));
    assert.ok(Object.values(p.resources).includes(0));assert.equal(Object.values(p.resources).reduce((n,v)=>n+v,0),45);
    const view=projectWorldState(a,p.id);assert.deepEqual(Object.keys(view.known.polities),[]);assert.equal(view.own.population,24);
    for(const t of p.territory)assert.ok(contiguous(a.hexes,territoryHexes(a,t).map(h=>h.id)));
    for(const q of Object.values(a.polities).filter(q=>q.id!==p.id)){const path=findPath(a.hexes,p.capital_hex_id,q.capital_hex_id,'land',a.config);assert.ok(path.cost<=a.config.dynamics.explorerMovement*a.config.geography.contactTurns+a.config.map.contactRadius);}
  }
  assertWorldState(a);a.evidence.verify();
});

test('the other landmass mode also satisfies the fixed Pilot start constraints',()=>{
  const config=clone(PILOT_0_CONFIG);config.geography.landmass='archipelago';const w=fixture('archipelago',config);assertWorldState(w);
  const other=fixture('archipelago');assert.notEqual(sha256(w.hexes),sha256(other.hexes));
});

test('hidden mutations cannot alter pure projection bytes or public-safe action errors',()=>{
  const w=fixture('acl'),id='polity-1',before=canonicalize(projectWorldState(w,id));
  const error=w.validateAction(id,{action_id:'probe',type:'attack',unit_id:'unknown',target_unit_id:'hidden'});
  w.polities['polity-2'].credits+=999;w.polities['polity-2'].name='SECRET';w.polities['polity-2'].memory=['CANARY'];w.channels.secret={id:'secret',members:['polity-2','polity-3'],text:'CANARY'};
  w.hexes['hex-12-10'].deposits={metal:999};
  assert.equal(canonicalize(projectWorldState(w,id)),before);assert.deepEqual(w.validateAction(id,{action_id:'probe',type:'attack',unit_id:'unknown',target_unit_id:'hidden'}),error);
  const own=projectWorldState(w,id);own.own.resources.metal=999;assert.notEqual(w.polities[id].resources.metal,999);
});

test('contact does not grant live foreign economy and observations retain age/provenance',()=>{
  const w=fixture('contact');contact(w);const p=w.polities['polity-1'];assert.equal(p.knowledge.length,3);
  const before=canonicalize(projectWorldState(w,p.id));w.polities['polity-2'].credits+=999;w.polities['polity-2'].technologies.push('satellites');assert.equal(canonicalize(projectWorldState(w,p.id)),before);
  const known=projectWorldState(w,p.id).known.polities['polity-2'];assert.equal(known.age,1);assert.ok(known.provenance.observation_ref);assert.equal(known.value.credits,undefined);
});

test('mobile units leaving spatial detection become current-location unknown without extrapolation',()=>{
  const w=fixture('detection'),[a,b]=recruitPair(w),p=w.polities['polity-1'];assert.equal(p.facts.units[b.id].value.current_location_known,true);
  const observed=p.facts.units[b.id].observed_turn;relocate(w,b,'hex-10-8');w.turn++;observeWorld(w,p.id);
  assert.equal(p.facts.units[b.id].value.hex_id,null);assert.equal(p.facts.units[b.id].observed_turn,observed);assert.equal(projectWorldState(w,p.id).known.units[b.id].age,1);
  assert.equal(w.validateAction(p.id,{action_id:'a',type:'attack',unit_id:a.id,target_unit_id:b.id}).ok,false);
});

test('physical movement respects range, terrain and domain without transferring political ownership',()=>{
  const w=fixture('movement');turn(w,{'polity-1':[{type:'recruit'}]});const p=w.polities['polity-1'],u=p.units[0],from=u.hex_id;
  const destination=Object.values(projectWorldState(w,p.id).map).find(h=>h.id!==from && h.terrain==='plains' && hexDistance(w.hexes[from],h)===1);
  const owners=Object.fromEntries(Object.entries(w.territories).map(([id,t])=>[id,t.owner_id]));turn(w,{[p.id]:[{type:'move',unit_id:u.id,hex_id:destination.id}]});
  assert.equal(w.polities[p.id].units[0].hex_id,destination.id);assert.deepEqual(Object.fromEntries(Object.entries(w.territories).map(([id,t])=>[id,t.owner_id])),owners);
  assert.equal(w.validateAction(p.id,{action_id:'far',type:'move',unit_id:u.id,hex_id:'hex-12-10'}).ok,false);
});

test('all required unit types recruit through configured crew/resource/facility transitions',()=>{
  for(const [type,spec]of Object.entries(PILOT_0_CONFIG.unitTypes)){
    const w=fixture('unit-'+type),p=w.polities['polity-1'];p.technologies=Object.keys(w.config.technologies);p.credits=1000;for(const key of Object.keys(p.resources))p.resources[key]=1000;
    const f=facility(w,p.id,'ground_military');f.type=spec.facility;f.prerequisites=clone(w.config.facilityTypes[spec.facility].prerequisites);f.capacity=100;
    const g=job(w,p.id,'Soldier');g.count=spec.citizens;relocate(w,g,f.hex_ids[0]);p.population=p.citizens.reduce((n,g)=>n+g.count,0);
    let hex=f.hex_ids[0];if(spec.domain==='sea'){const water=w.hexes['hex-0-2'],land=w.hexes['hex-1-2'];f.hex_ids=[land.id];relocate(w,g,land.id);hex=water.id;}
    refresh(w);const beforePopulation=p.population,beforeCredits=p.credits;
    turn(w,{[p.id]:[{type:'recruit',unit_type:type,facility_id:f.id,hex_id:hex}]});const after=w.polities[p.id],u=after.units[0];
    assert.equal(u.type,type);assert.equal(u.crew.reduce((n,g)=>n+g.count,0),spec.citizens);assert.ok(after.population<=beforePopulation-spec.citizens+1);
    const event=w.evidence.events.find(e=>e.event_type==='PopulationUnitTransition'&&e.payload.transition==='recruitment');assert.ok(event,type);assert.ok(w.evidence.payloads.has(event.payload.population_before_ref));assert.ok(after.credits<beforeCredits+100);
    assertWorldState(w);w.evidence.verify();
  }
});

test('demobilization returns recorded surviving crew rather than assuming unit-citizen equivalence',()=>{
  const w=fixture('demobilize');turn(w,{'polity-1':[{type:'recruit'}]});const p=w.polities['polity-1'],u=p.units[0],f=facility(w,p.id,'training');relocate(w,u,f.hex_ids[0]);refresh(w);
  const before=p.population,crew=u.crew.reduce((n,g)=>n+g.count,0);turn(w,{[p.id]:[{type:'demobilize',unit_id:u.id,facility_id:f.id}]});assert.equal(w.polities[p.id].units.length,0);assert.ok(w.polities[p.id].population>=before+crew);
  for(const kind of ['demobilization','return_to_population'])assert.ok(w.evidence.events.some(e=>e.event_type==='PopulationUnitTransition'&&e.payload.transition===kind));
});

test('training requires infrastructure, spends cost, preserves people and takes configured time',()=>{
  const w=fixture('training'),p=w.polities['polity-1'],g=job(w,p.id,'Civilian'),f=facility(w,p.id,'training');
  assert.equal(w.validateAction(p.id,{action_id:'bad',type:'reassign',citizen_id:g.id,assignment:'Soldier',count:1,facility_id:f.id}).ok,false);
  relocate(w,g,f.hex_ids[0]);refresh(w);turn(w,{[p.id]:[{type:'reassign',citizen_id:g.id,assignment:'Soldier',count:1,facility_id:f.id}]});assert.ok(w.polities[p.id].citizens.some(g=>g.training));
  turn(w);assert.ok(w.polities[p.id].citizens.some(g=>g.assignment==='Soldier'&&g.count===1&&!g.training));assertWorldState(w);
});

test('builders create persistent partial facilities and resume them only with prerequisites/control',()=>{
  const w=fixture('building'),p=w.polities['polity-1'],builder=job(w,p.id,'Builder');
  const site=territoryHexes(w,p.territory[0]).find(h=>h.terrain!=='water'&&!Object.values(w.facilities).some(f=>f.hex_ids.includes(h.id)));
  relocate(w,builder,site.id);builder.count=1;p.population=p.citizens.reduce((n,g)=>n+g.count,0);p.resources.metal=100;refresh(w);
  turn(w,{[p.id]:[{type:'build',facility_type:'extraction',hex_ids:[site.id]}]});const f=Object.values(w.facilities).find(f=>f.type==='extraction');assert.equal(f.construction_progress,2);assert.equal(f.required_progress,4);
  turn(w,{[p.id]:[{type:'resume_construction',facility_id:f.id}]});assert.equal(w.facilities[f.id].construction_progress,4);
  turn(w,{[p.id]:[{type:'upgrade',facility_id:f.id}]});assert.equal(w.facilities[f.id].level,2);assert.ok(w.facilities[f.id].construction_progress<w.facilities[f.id].required_progress);
});

test('large facility footprints require exactly the configured contiguous controlled hexes',()=>{
  const w=fixture('footprints'),p=w.polities['polity-1'];p.technologies=Object.keys(w.config.technologies);p.credits=1000;p.resources={metal:100,fuel:100,crystal:100};
  const ids=territoryHexes(w,p.territory[0]).filter(h=>h.terrain!=='water').map(h=>h.id);for(const f of Object.values(w.facilities).filter(f=>f.owner_id===p.id))delete w.facilities[f.id];
  const builder=job(w,p.id,'Builder');relocate(w,builder,ids[0]);refresh(w);
  assert.equal(w.validateAction(p.id,{action_id:'bad',type:'build',facility_type:'aircraft',hex_ids:[ids[0]]}).ok,false);
  const second=ids.find(id=>hexDistance(w.hexes[id],w.hexes[ids[0]])===1);
  assert.equal(w.validateAction(p.id,{action_id:'good',type:'build',facility_type:'aircraft',hex_ids:[ids[0],second]}).ok,true);
});

test('prospecting discovers finite deposits and extraction depletes them without random explorer deaths',()=>{
  const w=fixture('prospect'),p=w.polities['polity-1'],g=job(w,p.id,'Explorer'),site=p.capital_hex_id;relocate(w,g,site);refresh(w);
  const resource=Object.keys(w.hexes[site].deposits)[0],amount=w.hexes[site].deposits[resource],count=g.count;
  const f=facility(w,p.id,'agriculture');f.type='extraction';f.capacity=2;
  turn(w,{[p.id]:[{type:'prospect',citizen_id:g.id,hex_id:site}]});assert.ok(w.polities[p.id].facts.deposits[site]);assert.ok(w.hexes[site].deposits[resource]<amount);assert.equal(job(w,p.id,'Explorer').count,count);
  for(let i=0;i<3;i++)turn(w);assert.ok(w.hexes[site].deposits[resource]>=0);assertWorldState(w);
});

test('research has private delayed outcomes, addressed quality and non-rival sharing',()=>{
  const config=clone(PILOT_0_CONFIG);config.technologies.agronomy.successPermille=1000;const w=fixture('research',config);contact(w);
  const id='polity-1',f=facility(w,id,'research');turn(w,{[id]:[{type:'research',technology:'agronomy',facility_id:f.id}]});assert.ok(!w.polities[id].technologies.includes('agronomy'));
  for(let i=0;i<config.technologies.agronomy.turns;i++)turn(w);
  assert.ok(w.polities[id].technologies.includes('agronomy'));assert.equal(projectWorldState(w,'polity-2').known.polities[id].value.technologies,undefined);
  turn(w,{[id]:[{type:'share_technology',technology:'agronomy',to:'polity-2'}]});assert.ok(w.polities[id].technologies.includes('agronomy'));assert.ok(w.polities['polity-2'].technologies.includes('agronomy'));
  assert.ok(w.evidence.events.some(e=>e.event_type==='RNGDraw'&&e.payload.subsystem==='research'));w.evidence.verify();
});

test('reverse engineering requires captured artifact, retains sunk cost and may yield zero progress',()=>{
  const config=clone(PILOT_0_CONFIG);config.technologies.agronomy.successPermille=0;const w=fixture('reverse',config),p=w.polities['polity-1'],f=facility(w,p.id,'research'),artifact=facility(w,p.id,'agriculture');
  artifact.prerequisites=['agronomy'];artifact.captured_from='polity-2';
  turn(w,{[p.id]:[{type:'reverse_engineer',technology:'agronomy',facility_id:f.id,artifact_id:artifact.id}]});for(let i=0;i<config.technologies.agronomy.turns;i++)turn(w);
  assert.ok(!w.polities[p.id].technologies.includes('agronomy'));const event=w.evidence.events.find(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='reverse_engineer_outcome');assert.equal(event.payload.detail.progress,0);assert.equal(event.payload.detail.sunk_cost,true);
});

test('intelligence costs time/resources and recipient reports do not expose collection truth labels',()=>{
  const w=fixture('intelligence');contact(w);turn(w,{'polity-1':[{type:'intelligence',to:'polity-2'}]});assert.equal(w.polities['polity-1'].reports.length,0);turn(w);
  const reports=w.polities['polity-1'].reports;assert.equal(reports.length,1);assert.equal(reports[0].source,'intelligence');assert.equal(reports[0].quality,undefined);assert.equal(reports[0].accurate,undefined);
  for(const purpose of ['collection_quality','detection','attribution'])assert.ok(w.evidence.events.some(e=>e.event_type==='RNGDraw'&&e.payload.purpose===purpose));
});

test('simultaneous combat uses the same prestate even when both attackers are destroyed',()=>{
  const config=clone(PILOT_0_CONFIG);config.dynamics.combatMinimumHitPermille=1000;config.dynamics.combatMaximumHitPermille=1000;config.dynamics.combatDamage=100;
  const w=fixture('battle',config),[a,b]=recruitPair(w);
  turn(w,{'polity-1':[{type:'attack',unit_id:a.id,target_unit_id:b.id}],'polity-2':[{type:'attack',unit_id:b.id,target_unit_id:a.id}]});
  assert.equal(w.polities['polity-1'].units.length,0);assert.equal(w.polities['polity-2'].units.length,0);
  const e=w.evidence.events.find(e=>e.event_type==='BattleResolved');assert.ok(e);assert.equal(e.payload.rng_draw_refs.length,4);
  const losses=w.evidence.events.filter(event=>event.turn===e.turn && event.event_type==='PopulationUnitTransition' && event.payload.transition==='destruction');
  assert.equal(losses.length,2);for(const loss of losses){assert.ok(e.causality.causation_ids.includes(loss.event_id));assert.ok(e.payload.canonical_event_refs.includes(loss.event_id));}
  for(const key of ['pre_resolution_state_ref','terrain_ref','supply_ref','defensive_state_ref','outcome_ref'])assert.ok(w.evidence.payloads.has(e.payload[key]),key);
  assert.equal(JSON.parse(w.evidence.payloads.get(e.payload.supply_ref).bytes).enabled,false);
  for(const id of e.payload.rng_draw_refs)assert.ok(w.evidence.events.some(e=>e.event_id===id&&e.event_type==='RNGDraw'));w.evidence.verify();
});

test('equal citizen claims produce explicit contested ownership and suspend owner production',()=>{
  const w=fixture('claims'),site=Object.values(w.hexes).find(h=>w.territories[h.territory_id].status==='unclaimed'&&h.terrain!=='water');
  for(const id of ['polity-1','polity-2']){const g=job(w,id,'Explorer');relocate(w,g,site.id);}refresh(w);
  turn(w,{'polity-1':[{type:'claim',territory_id:site.territory_id}],'polity-2':[{type:'claim',territory_id:site.territory_id}]});const t=w.territories[site.territory_id];
  assert.equal(t.status,'contested');assert.equal(t.owner_id,null);assert.equal(t.exclusive_claimant_id,null);assert.equal(t.controller_id,null);assertValidSchema(t,'territory-state.schema.json');assertWorldState(w);
});

test('superior citizen claim captures residents and facilities without granting prerequisite technology',()=>{
  const w=fixture('capture'),target=w.polities['polity-2'],id='polity-1',t=target.territory[0];
  for(const g of target.citizens)relocate(w,g,'hex-10-8');const g=job(w,id,'Explorer');relocate(w,g,target.capital_hex_id);
  const f=facility(w,target.id,'research');f.prerequisites=['satellites'];refresh(w);
  turn(w,{[id]:[{type:'claim',territory_id:t}]});assert.equal(w.territories[t].owner_id,id);assert.equal(w.facilities[f.id].owner_id,id);assert.ok(!w.polities[id].technologies.includes('satellites'));assert.equal(w.polities[target.id].alive,true);
  for(let i=1;i<w.config.dynamics.capitalHoldTurns;i++)turn(w);assert.equal(w.polities[target.id].alive,false);assert.equal(w.validateAction(target.id,{action_id:'x',type:'wait'}).ok,false);
});

test('simultaneous transfers conserve resources and cannot spend another order\'s incoming funds',()=>{
  const w=fixture('transfers');contact(w);for(const p of Object.values(w.polities))p.resources.metal=10;
  const before=Object.values(w.polities).reduce((n,p)=>n+p.resources.metal,0);
  turn(w,{'polity-1':[{type:'transfer',to:'polity-2',resource:'metal',amount:10}],'polity-2':[{type:'transfer',to:'polity-1',resource:'metal',amount:10}]});
  assert.equal(Object.values(w.polities).reduce((n,p)=>n+p.resources.metal,0),before);
  assert.equal(w.validateAction('polity-1',{action_id:'overspend',type:'transfer',to:'polity-2',resource:'metal',amount:11}).ok,false);
  turn(w,{'polity-1':[{type:'transfer',to:'polity-2',resource:'metal',amount:7},{type:'transfer',to:'polity-3',resource:'metal',amount:7}]});assert.equal(w.polities['polity-1'].resources.metal,10);
  assert.ok(w.evidence.events.some(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='simultaneous_reservation_conflict'));
});

test('freeform channels preserve verbatim statements privately and never classify moral outcomes',()=>{
  const w=fixture('channels');contact(w);turn(w,{'polity-1':[{type:'channel_create',members:['polity-2']}]});
  const ch=Object.values(w.channels)[0];assert.equal(projectWorldState(w,'polity-3').channels.length,0);
  const text='I promise <script>not code</script> exactly this.';turn(w,{'polity-1':[{type:'promise',channel_id:ch.id,text}]});
  const e=w.evidence.events.filter(e=>e.event_type==='MessageSent').at(-1);assert.equal(e.payload.text,text);assert.equal(e.payload.status,undefined);assert.equal(w.polities['polity-1'].commitments,undefined);
  assert.ok(w.polities['polity-2'].messages.some(m=>m.text===text));assert.ok(!w.polities['polity-3'].messages.some(m=>m.text===text));
  assert.equal(w.validateAction('polity-1',{action_id:'moral',type:'fulfill_commitment',commitment_id:'x'}).ok,false);
  assert.equal(w.validateAction('polity-1',{action_id:'org',type:'organization_create'}).ok,false);
  assert.equal(projectWorldState(w,'polity-1').messages.length,0,'old turn transcripts do not enter current state');
});

test('progressive shortage and recovery feed every citizen and operational crew',()=>{
  const w=fixture('shortage');turn(w,{'polity-1':[{type:'recruit'}]});const p=w.polities['polity-1'];p.food=0;for(const g of p.citizens)g.assignment='Civilian';
  turn(w);assert.equal(w.polities[p.id].shortage,1);turn(w);assert.equal(w.polities[p.id].shortage,2);
  const consumed=w.evidence.events.filter(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='economy'&&e.payload.actor_ids.includes(p.id)).at(-1);assert.ok(consumed.payload.detail.consumption>w.polities[p.id].population);
  w.polities[p.id].food=10000;turn(w);assert.equal(w.polities[p.id].shortage,1);turn(w);assert.equal(w.polities[p.id].shortage,0);assertWorldState(w);
});

test('same committed inputs reproduce exact event bytes after actor and collection permutations',()=>{
  const a=fixture('permutation'),b=fixture('permutation');
  b.polities=Object.fromEntries(Object.entries(b.polities).reverse());b.hexes=Object.fromEntries(Object.entries(b.hexes).reverse());b.facilities=Object.fromEntries(Object.entries(b.facilities).reverse());
  const orders={'polity-1':[{type:'recruit'}],'polity-2':[{type:'recruit'}],'polity-3':[{type:'wait'}]};turn(a,orders);turn(b,orders);
  assert.equal(a.stateHash(),b.stateHash());assert.equal(canonicalize(a.evidence.events),canonicalize(b.evidence.events));
});

test('conflict components join overlapping read/write footprints transitively',()=>{
  const w=fixture('components');contact(w);const actions=[['polity-1',{type:'transfer',to:'polity-2',resource:'food',amount:1}],['polity-2',{type:'transfer',to:'polity-3',resource:'food',amount:1}],['polity-3',{type:'wait'}]];
  const plans=actions.map(([id,a],i)=>planAction(w,id,{...a,action_id:String(i)}));assert.ok(plans.every(p=>p.ok));assert.equal(conflictComponents(w,plans).length,1);
});

test('all emitted mechanic references resolve and clean-room replay reproduces actual reducer outcomes',()=>{
  const w=fixture('replay');const ledger=new ActionLedger(w.evidence);
  for(let i=0;i<3;i++)resolveTurn(w,commit(w,{'polity-1':[{type:i?'wait':'recruit'}]},ledger));
  for(const event of w.evidence.events){
    if(event.event_type==='WorldTransition')for(const key of ['before_state_ref','after_state_ref'])assert.ok(w.evidence.payloads.has(event.payload[key]),key);
    if(event.event_type==='PopulationUnitTransition')for(const reference of [event.payload.population_before_ref,event.payload.population_after_ref,...event.payload.unit_before_refs,...event.payload.unit_after_refs,...event.payload.resource_input_refs])assert.ok(w.evidence.payloads.has(reference),reference);
    if(event.event_type==='RNGDraw')assert.ok(w.evidence.payloads.has(event.payload.seed_or_state_ref));
  }
  const result=replay(w.evidence.bundle(),{expectedRunId:w.runId,authorizationContext:createAuthorizationContext('trusted_replay')});assert.equal(result.status,'EXACT_REPLAY');assert.equal(result.state_digest,w.stateHash());
});

test('failed staged resolution cannot partially append evidence or apply action outcomes',()=>{
  const w=fixture('atomic'),c=commit(w,{'polity-1':[{type:'recruit'}]});
  const before=w.stateHash(),head=w.evidence.previousHash,events=w.evidence.events.length;
  // An invalid sealed input is not accepted merely because it carries immutable=true.
  const forged=clone(c);forged.acceptedActions[0].type='unknown';assert.throws(()=>resolveTurn(w,forged));
  assert.equal(w.stateHash(),before);assert.equal(w.evidence.previousHash,head);assert.equal(w.evidence.events.length,events);
  resolveTurn(w,c);assert.equal(w.polities['polity-1'].units.length,1);assert.throws(()=>resolveTurn(w,c));
});

test('fixed twenty-turn cap remains exploratory and branches own independent apparatus state',()=>{
  const w=fixture('cap');for(let i=0;i<20;i++)turn(w);assert.equal(w.turn,20);assert.equal(w.terminal,true);assert.equal(w.terminationReason,'pilot_cap');
  const disposition=w.evidence.events.find(e=>e.event_type==='RunDisposition');assert.equal(disposition.payload.experimental_validity.confirmatory_eligible,false);
  const original=fixture('branch'),branch=cloneWorld(original,{branchRunId:'nonempirical-branch'});branch.hexes['hex-0-0'].terrain='plains';branch.polities['polity-1'].food++;
  assert.notEqual(original.hexes['hex-0-0'].terrain,branch.hexes['hex-0-0'].terrain);assert.notEqual(original.polities['polity-1'].food,branch.polities['polity-1'].food);assert.equal(branch.evidence.events[0].payload.parent_run_id,original.runId);
});

test('fixed-point multiplication obeys registry round-half-even and rejects invalid numeric state',()=>{
  assert.equal(mulDiv(99999999,99999999,1000),9999999800000);
  assert.equal(mulDiv(3,333,1000),1);assert.equal(mulDiv(3,334,1000),1);
  assert.equal(mulDiv(1,5,2),2);assert.equal(mulDiv(1,7,2),4);
  assert.throws(()=>mulDiv(0.5,1,1));assert.throws(()=>mulDiv(1,1,0));assert.throws(()=>mulDiv(Number.MAX_SAFE_INTEGER,2,1));
  const w=fixture('numbers');w.polities['polity-1'].food=-1;assert.throws(()=>assertWorldState(w),/overflow\/underflow/);
});

test('unrelated random operations cannot shift an addressed draw and seed refs resolve',()=>{
  const a=new WorldRng('seed',new EvidenceStore('draws')),b=new WorldRng('seed',new EvidenceStore('draws'));
  const input={runId:'draws',turnId:1,phase:'resolve',subsystem:'combat',eventOrActionId:'attack',purpose:'hit',streamNamespace:'world',drawOrdinal:0};
  b.draw({...input,eventOrActionId:'unrelated',subsystem:'intelligence'});assert.equal(a.draw(input),b.draw(input));
  assert.throws(()=>a.draw(input),/duplicate RNG address/);assert.ok(a.worldEvidence.payloads.has(a.manifest()[0].seed_or_state_ref));
});

test('deliberate satellite scans reveal chosen regions and never become continuous foreign tracking',()=>{
  const w=fixture('scans');turn(w,{'polity-2':[{type:'recruit'}]});const target=w.polities['polity-2'].units[0],id='polity-1';w.polities[id].technologies.push('satellites');
  assert.equal(projectWorldState(w,id).known.units[target.id],undefined);
  turn(w,{[id]:[{type:'reconnaissance',hex_id:target.hex_id}]});assert.equal(w.polities[id].facts.units[target.id].value.current_location_known,true);
  turn(w);assert.equal(w.polities[id].facts.units[target.id].value.current_location_known,false);assert.equal(w.polities[id].facts.units[target.id].value.hex_id,null);
});

test('real staged event failures preserve committed world state, payloads, RNG and append head',()=>{
  for(const point of ['before_resolution','before_event','after_event','before_publish']){
    const w=fixture('fault-'+point),c=commit(w,{'polity-1':[{type:'recruit'}]}),before=w.stateHash(),head=w.evidence.previousHash,payloads=w.evidence.payloads.size,draws=canonicalize(w.rng.manifest());
    assert.throws(()=>resolveTurn(w,c,{fault:(actual,detail)=>{if(actual===point && (!actual.endsWith('event') || detail.event_type==='PopulationUnitTransition'))throw new Error('injected boundary failure');}}),/injected boundary failure/);
    assert.equal(w.stateHash(),before);assert.equal(w.evidence.previousHash,head);assert.equal(w.evidence.payloads.size,payloads);assert.equal(canonicalize(w.rng.manifest()),draws);
    resolveTurn(w,c);w.evidence.verify();assert.equal(w.polities['polity-1'].units.length,1);
  }
  const w=fixture('fault-after'),c=commit(w,{'polity-1':[{type:'recruit'}]});assert.throws(()=>resolveTurn(w,c,{fault:point=>{if(point==='after_publish')throw new Error('post-publication failure');}}),/post-publication failure/);assert.equal(w.turn,1);assert.equal(w.polities['polity-1'].units.length,1);w.evidence.verify();assert.throws(()=>resolveTurn(w,c));
});

test('unilateral equipment, citizen and facility gifts preserve physical state and training',()=>{
  const w=fixture('gifts');contact(w);turn(w,{'polity-1':[{type:'recruit'}]});const p=w.polities['polity-1'],u=p.units[0],g=job(w,p.id,'Explorer'),f=facility(w,p.id,'research');
  turn(w,{[p.id]:[{type:'transfer_unit',unit_id:u.id,to:'polity-2'},{type:'transfer_population',citizen_id:g.id,count:1,to:'polity-2'},{type:'transfer_facility',facility_id:f.id,to:'polity-2'}]});
  assert.equal(w.polities[p.id].units.length,0);assert.equal(w.polities['polity-2'].units[0].id,u.id);assert.equal(w.polities['polity-2'].units[0].hex_id,u.hex_id);
  assert.ok(w.polities['polity-2'].citizens.some(c=>c.assignment==='Explorer'&&c.transferred_turn===w.turn-1));assert.equal(w.facilities[f.id].owner_id,'polity-2');assertWorldState(w);w.evidence.verify();
});

test('naval transport carries real citizens through embark, movement and disembark',()=>{
  const w=fixture('transport'),id='polity-1',p=w.polities[id],f=facility(w,id,'ground_military');p.technologies=['navigation'];p.resources={metal:100,fuel:100,crystal:100};p.credits=1000;
  f.type='naval_shipyard';f.hex_ids=['hex-1-2'];relocate(w,job(w,id,'Soldier'),'hex-1-2');relocate(w,job(w,id,'Explorer'),'hex-1-2');refresh(w);
  turn(w,{[id]:[{type:'recruit',unit_type:'transport',facility_id:f.id,hex_id:'hex-0-2'}]});let ship=w.polities[id].units[0],explorer=job(w,id,'Explorer');
  turn(w,{[id]:[{type:'embark',carrier_id:ship.id,citizen_id:explorer.id}]});assert.equal(job(w,id,'Explorer').embarked_on,ship.id);
  turn(w,{[id]:[{type:'move',unit_id:ship.id,hex_id:'hex-0-3'}]});assert.equal(job(w,id,'Explorer').hex_id,'hex-0-3');
  turn(w,{[id]:[{type:'disembark',carrier_id:ship.id,citizen_id:explorer.id,hex_id:'hex-1-3'}]});assert.equal(job(w,id,'Explorer').embarked_on,null);assert.equal(job(w,id,'Explorer').hex_id,'hex-1-3');assertWorldState(w);
});

test('capital takeover respects its hold duration even when all resident citizens transfer',()=>{
  const w=fixture('capital-hold'),target=w.polities['polity-2'],source=w.polities['polity-1'],g=job(w,source.id,'Explorer');g.count=target.population+1;source.population=source.citizens.reduce((n,g)=>n+g.count,0);relocate(w,g,target.capital_hex_id);refresh(w);
  turn(w,{[source.id]:[{type:'claim',territory_id:target.territory[0]}]});assert.equal(w.polities[target.id].population,0);assert.equal(w.polities[target.id].alive,true);assert.equal(w.polities[target.id].takeover.held_turns,1);
  for(let i=1;i<w.config.dynamics.capitalHoldTurns;i++)turn(w);assert.equal(w.polities[target.id].alive,false);
});

test('simultaneous demobilization cannot shield a committed combat target from destruction',()=>{
  const config=clone(PILOT_0_CONFIG);config.dynamics.combatMinimumHitPermille=1000;config.dynamics.combatMaximumHitPermille=1000;config.dynamics.combatDamage=100;
  const w=fixture('battle-demobilize',config),[a,b]=recruitPair(w),training=facility(w,'polity-2','training');training.hex_ids=[b.hex_id];refresh(w);
  const before=w.polities['polity-2'].population;
  turn(w,{'polity-1':[{type:'attack',unit_id:a.id,target_unit_id:b.id}],'polity-2':[{type:'demobilize',unit_id:b.id,facility_id:training.id}]});
  assert.equal(w.polities['polity-2'].units.length,0);assert.ok(w.polities['polity-2'].population<before+b.crew.reduce((n,g)=>n+g.count,0));assert.ok(w.evidence.events.some(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='demobilization_unavailable'));
});
