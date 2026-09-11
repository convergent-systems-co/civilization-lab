import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorld,resolveTurn,assertWorldState} from '../src/world.js';
import {observeWorld} from '../src/world-map.js';
import {ActionLedger,commitTurn,projectWorld} from '../src/contracts.js';

const actor=id=>({persistent_identity_id:id,session_id:`session-${id}`,invocation_id:`invocation-${id}`});
function installEstate(world) {
  const polity=world.polities['polity-1'],soldiers=polity.citizens.find(g=>g.assignment==='Soldier'),visibleHex=world.hexes[soldiers.hex_id];
  const hiddenHex=Object.values(world.hexes).find(h=>!polity.facts.hexes[h.id] && h.terrain!=='water');
  assert(hiddenHex,'fixture needs an undiscovered land hex');
  world.unaffiliatedPopulation.push({id:'visible-unaffiliated',assignment:'Civilian',count:3,hex_id:visibleHex.id,territory_id:visibleHex.territory_id,training:null,embarked_on:null,mortality_progress:0,affiliation_status:'unaffiliated',former_polity_id:'HIDDEN-FORMER-POLITY',unaffiliated_turn:0});
  world.unaffiliatedPopulation.push({id:'HIDDEN-UNAFFILIATED',assignment:'Civilian',count:7,hex_id:hiddenHex.id,territory_id:hiddenHex.territory_id,training:null,embarked_on:null,mortality_progress:0,affiliation_status:'unaffiliated',former_polity_id:'HIDDEN-OTHER-POLITY',unaffiliated_turn:0});
  const unit=type=>({id:type==='visible'?'visible-neutral':'HIDDEN-NEUTRAL',type:'infantry',hex_id:type==='visible'?visibleHex.id:hiddenHex.id,territory_id:type==='visible'?visibleHex.territory_id:hiddenHex.territory_id,health:world.config.unitTypes.infantry.health,strength:world.config.unitTypes.infantry.attack,fortified:false,embarked_on:null,crew:[],prerequisites:[],captured_from:null,controller_id:null,former_polity_id:'HIDDEN-UNIT-ORIGIN',status:'inactive_neutral',neutralized_turn:0});
  world.neutralUnits.push(unit('visible'),unit('hidden'));
  const facility=Object.values(world.facilities).find(f=>f.owner_id===polity.id && f.type==='ground_military');facility.owner_id=null;
  observeWorld(world,polity.id);
  return {polity,soldiers,visibleHex,hiddenHex,facility};
}

test('participant projection discloses orphaned estates only on authorized visible hexes',()=>{
  const world=makeWorld({runId:'orphan-projection',seed:'orphan-projection'}),{polity,hiddenHex,facility}=installEstate(world);
  const projection=projectWorld(world,'polity-1'),bytes=JSON.stringify(projection);
  const facts=projection.fields.find(field=>field.path==='own.intelligence').value.facts;
  assert.equal(facts.unaffiliated_population['visible-unaffiliated'].value.count,3);
  assert.equal(facts.neutral_units['visible-neutral'].value.status,'inactive_neutral');
  assert.equal(facts.facilities[Object.keys(facts.facilities).find(id=>facts.facilities[id].value.owner_id===null)].value.owner_id,null);
  assert.doesNotMatch(bytes,/HIDDEN-(?:UNAFFILIATED|NEUTRAL|FORMER|OTHER|UNIT)/);
  for(const action of [
    {action_id:'hidden-pop',type:'incorporate_population',unaffiliated_population_id:'HIDDEN-UNAFFILIATED',count:1},
    {action_id:'hidden-unit',type:'reactivate_unit',neutral_unit_id:'HIDDEN-NEUTRAL',citizen_ids:[world.polities['polity-1'].citizens.find(g=>g.assignment==='Soldier').id]}
  ])assert.deepEqual(world.validateAction('polity-1',action),{ok:false,code:'estate_unavailable'});
  for(const group of polity.citizens){group.hex_id=hiddenHex.id;group.territory_id=hiddenHex.territory_id;}
  observeWorld(world,polity.id);
  const refreshed=JSON.stringify(projectWorld(world,polity.id));
  assert.doesNotMatch(refreshed,/visible-(?:unaffiliated|neutral)/);
  assert.deepEqual(world.validateAction(polity.id,{action_id:'stale-facility',type:'acquire_facility',facility_id:facility.id}),{ok:false,code:'estate_unavailable'});
});

test('ordinary projected actions incorporate population, reactivate equipment, and acquire facilities canonically',()=>{
  const world=makeWorld({runId:'orphan-acquisition',seed:'orphan-acquisition'}),{polity,soldiers,facility}=installEstate(world);
  const ledger=new ActionLedger(world.evidence),actions=[
    {type:'incorporate_population',unaffiliated_population_id:'visible-unaffiliated',count:2},
    {type:'reactivate_unit',neutral_unit_id:'visible-neutral',citizen_ids:[soldiers.id]},
    {type:'acquire_facility',facility_id:facility.id}
  ];
  const submission=ledger.submit({runId:world.runId,turnId:'turn-0',actorId:polity.id,actor:actor(polity.id),actions,projection:projectWorld(world,polity.id)});
  const validated=ledger.validate(submission,world);assert.equal(validated.submission.status,'validated',JSON.stringify(validated.submission.validation));
  resolveTurn(world,commitTurn(world,ledger,[validated]));
  assert.equal(world.unaffiliatedPopulation.find(g=>g.id==='visible-unaffiliated').count,1);
  assert(world.polities[polity.id].citizens.some(g=>g.incorporated_by===polity.id&&g.count===2));
  assert.equal(world.neutralUnits.some(u=>u.id==='visible-neutral'),false);
  assert(world.polities[polity.id].units.some(u=>u.id==='visible-neutral'&&u.crew.reduce((n,g)=>n+g.count,0)===world.config.unitTypes.infantry.citizens));
  assert.equal(world.facilities[facility.id].owner_id,polity.id);
  for(const mechanic of ['population_incorporation','neutral_unit_reactivation','facility_acquisition'])assert(world.evidence.events.some(event=>event.event_type==='WorldTransition'&&event.payload.mechanic===mechanic),mechanic);
  for(const transition of ['incorporation','reactivation'])assert(world.evidence.events.some(event=>event.event_type==='PopulationUnitTransition'&&event.payload.transition===transition),transition);
  assertWorldState(world);world.evidence.verify();
});
