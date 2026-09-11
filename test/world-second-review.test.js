import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, resolveTurn, PILOT_0_CONFIG, assertWorldState, hexDistance } from '../src/world.js';
import { ActionLedger, commitTurn, projectWorld } from '../src/contracts.js';
import { observeWorld, discoverPolity, recordFact } from '../src/world-map.js';
import { canonicalize } from '../src/core.js';
import { prepareSyntheticCodingPacket } from '../src/coding.js';

// NONEMPIRICAL adversarial fixtures. No model invocation, file output, or empirical run.
const fixture = (name, config = PILOT_0_CONFIG) => makeWorld({
  runId: 'nonempirical-second-review-' + name, seed: 'adversarial-fixture-fixed', config
});
const facility = (w, id, type) => Object.values(w.facilities).find(f => f.owner_id === id && f.type === type);
const group = (w, id, assignment) => w.polities[id].citizens.find(g => g.assignment === assignment);
function locate(w, entity, id) { entity.hex_id = id; entity.territory_id = w.hexes[id].territory_id; }
function refresh(w) { for (const p of Object.values(w.polities)) observeWorld(w, p.id); }
function commit(w, orders = { 'polity-3': [{ type: 'wait' }] }) {
  const ledger = new ActionLedger(w.evidence);
  const validated = Object.entries(orders).map(([id, actions]) => {
    const submission = ledger.submit({ runId: w.runId, turnId: 'turn-' + w.turn, actorId: id,
      actor: { persistent_identity_id: id, session_id: 'session-' + id, invocation_id: 'invocation-' + id },
      actions: actions.map((a, i) => ({ action_id: `${w.turn}:${id}:${i}`, ...a })), projection: projectWorld(w, id) });
    const result = ledger.validate(submission, w);
    assert.equal(result.submission.status, 'validated', JSON.stringify(result.submission.validation));
    return result;
  });
  return commitTurn(w, ledger, validated);
}
function turn(w, orders) { resolveTurn(w, commit(w, orders)); assertWorldState(w); }
function control(w, territoryId, owner, status = 'controlled') {
  Object.assign(w.territories[territoryId], { status, owner_id: owner, controller_id: owner, exclusive_claimant_id: owner });
  for (const p of Object.values(w.polities)) p.territory = Object.values(w.territories).filter(t => t.owner_id === p.id).map(t => t.territory_id);
}

test('agriculture capacity is shared across citizen groups and the complete facility footprint', () => {
  const outputs = [];
  for (const layout of ['one-group', 'split-group', 'split-hexes']) {
    const w = fixture('capacity'), id = 'polity-1', p = w.polities[id], g = group(w, id, 'Farmer');
    const f = facility(w, id, 'agriculture');
    g.count = layout === 'one-group' ? 16 : 8;
    if (layout !== 'one-group') {
      const extra = { ...structuredClone(g), id: 'second-farmer-group' };
      if (layout === 'split-hexes') {
        const h = Object.values(w.hexes).find(h => h.terrain === 'plains' && h.territory_id === g.territory_id && hexDistance(w.hexes[g.hex_id], h) === 1);
        for (const other of Object.values(w.facilities)) if (other.id !== f.id && other.hex_ids.includes(h.id)) delete w.facilities[other.id];
        f.hex_ids.push(h.id); f.size = 2; locate(w, extra, h.id);
      }
      p.citizens.push(extra);
    }
    p.population = p.citizens.reduce((n, g) => n + g.count, 0);
    turn(w);
    const event = w.evidence.events.find(e => e.event_type === 'WorldTransition' && e.payload.mechanic === 'economy' && e.payload.actor_ids.includes(id));
    outputs.push(event.payload.detail.production.food);
  }
  assert.deepEqual(outputs, [56, 56, 56]);
});

for (const type of ['research', 'reverse_engineer', 'train', 'reassign', 'recruit', 'demobilize', 'resume_construction', 'upgrade', 'repair', 'destroy', 'transfer_facility']) {
  test(`contested territory denies ${type} despite retained facility ownership`, () => {
    const w = fixture('permission-' + type), id = 'polity-1', p = w.polities[id];
    let action = { action_id: 'probe', type };
    if (['research', 'reverse_engineer'].includes(type)) {
      action = { ...action, technology: 'agronomy', facility_id: facility(w, id, 'research').id };
      if (type === 'reverse_engineer') {
        const artifact = facility(w, id, 'agriculture'); artifact.prerequisites = ['agronomy']; artifact.captured_from = 'polity-2'; action.artifact_id = artifact.id;
      }
    } else if (['train', 'reassign'].includes(type)) {
      const g = group(w, id, 'Civilian'), f = facility(w, id, 'training'); locate(w, g, f.hex_ids[0]);
      action = { ...action, citizen_id: g.id, assignment: 'Soldier', count: 1, facility_id: f.id };
    } else if (type === 'demobilize') {
      turn(w, { [id]: [{ type: 'recruit' }] }); const u = w.polities[id].units[0], f = facility(w, id, 'training'); locate(w, u, f.hex_ids[0]);
      action = { ...action, unit_id: u.id, facility_id: f.id };
    } else if (type !== 'recruit') {
      const f = facility(w, id, 'industrial'); locate(w, group(w, id, 'Builder'), f.hex_ids[0]); action.facility_id = f.id;
      if (type === 'resume_construction') f.construction_progress--;
      if (type === 'transfer_facility') { discoverPolity(w, w.polities[id], 'polity-2', 'fixture'); action.to = 'polity-2'; }
    }
    refresh(w); assert.equal(w.validateAction(id, action).ok, true, 'positive permission control');
    control(w, w.hexes[p.capital_hex_id].territory_id, null, 'contested'); refresh(w);
    assert.equal(w.validateAction(id, action).ok, false);
  });
}

test('a contested hex anywhere in the research footprint suspends facility permission', () => {
  const w = fixture('research-footprint'), id = 'polity-1', f = facility(w, id, 'research');
  const extra = Object.values(w.hexes).find(h => w.territories[h.territory_id].status === 'unclaimed');
  f.hex_ids.push(extra.id); f.size = 2; recordFact(w.polities[id], 'hexes', extra.id, extra, w.turn, 'fixture');
  recordFact(w.polities[id], 'territories', extra.territory_id, w.territories[extra.territory_id], w.turn, 'fixture');
  assert.equal(w.validateAction(id, { type: 'research', action_id: 'research', technology: 'agronomy', facility_id: f.id }).ok, true);
  control(w, extra.territory_id, null, 'contested');
  recordFact(w.polities[id], 'territories', extra.territory_id, w.territories[extra.territory_id], w.turn, 'fixture');
  assert.equal(w.validateAction(id, { type: 'research', action_id: 'research', technology: 'agronomy', facility_id: f.id }).ok, false);
});

test('contested training and research retain remaining work and resume only after control returns', () => {
  const c = structuredClone(PILOT_0_CONFIG); c.technologies.agronomy.successPermille = 1000;
  const w = fixture('project-permissions', c), id = 'polity-1', p = w.polities[id], g = group(w, id, 'Civilian');
  const training = facility(w, id, 'training'), research = facility(w, id, 'research'); locate(w, g, training.hex_ids[0]); refresh(w);
  turn(w, { [id]: [{ type: 'train', citizen_id: g.id, count: 1, assignment: 'Soldier', facility_id: training.id },
    { type: 'research', technology: 'agronomy', facility_id: research.id }] });
  const trainingId = w.polities[id].citizens.find(g => g.training).id, territoryId = w.hexes[p.capital_hex_id].territory_id;
  control(w, territoryId, null, 'contested'); refresh(w);
  const before = structuredClone(w.polities[id].projects);
  turn(w); turn(w);
  assert.deepEqual(w.polities[id].projects, before);
  assert.equal(w.polities[id].citizens.find(g => g.id === trainingId).training.remaining, 1);
  assert.deepEqual(w.polities[id].technologies, []);
  assert.equal(w.evidence.events.filter(e => e.event_type === 'RNGDraw' && e.payload.subsystem === 'research').length, 0);
  control(w, territoryId, id); refresh(w); turn(w); turn(w);
  assert.equal(w.polities[id].citizens.find(g => g.id === trainingId).training, null);
  assert.deepEqual(w.polities[id].technologies, ['agronomy']);
});

test('zero-survivor extinction disposes every estate class without a beneficiary', () => {
  const w=fixture('zero-survivor-estate'),id='polity-1',recipient='polity-2',p=w.polities[id];
  discoverPolity(w,p,recipient,'fixture');refresh(w);
  const territoryIds=[...p.territory],facilityIds=Object.values(w.facilities).filter(f=>f.owner_id===id).map(f=>f.id).sort();
  const physicalResources=structuredClone(Object.fromEntries(Object.entries(w.hexes).map(([hexId,h])=>[hexId,h.deposits])));
  turn(w,{[id]:p.citizens.map(g=>({type:'transfer_population',citizen_id:g.id,count:g.count,to:recipient}))});
  const dead=w.polities[id];assert.equal(dead.alive,false);assert.equal(dead.population,0);assert.equal(dead.food,0);assert.equal(dead.credits,0);
  assert.ok(Object.values(dead.resources).every(n=>n===0));assert.deepEqual(dead.territory,[]);
  for(const territoryId of territoryIds)assert.equal(w.territories[territoryId].owner_id,null);
  for(const facilityId of facilityIds)assert.equal(w.facilities[facilityId].owner_id,null);
  assert.deepEqual(Object.fromEntries(Object.entries(w.hexes).map(([hexId,h])=>[hexId,h.deposits])),physicalResources);
  const estate=w.evidence.events.filter(e=>e.turn===0&&e.participants.includes(id)&&(
    e.event_type==='TerritoryTransition'||e.event_type==='PopulationUnitTransition'&&e.payload.transition==='estate_disposition'||
    e.event_type==='WorldTransition'&&['facility_unclaimed','resource_extinguishment'].includes(e.payload.mechanic)));
  const elimination=w.evidence.events.find(e=>e.turn===0&&e.event_type==='WorldTransition'&&e.payload.mechanic==='polity_elimination'&&e.participants.includes(id));
  assert.ok(estate.length>=facilityIds.length+3);for(const event of estate)assert.ok(elimination.causality.causation_ids.includes(event.event_id));
  w.evidence.verify();
});

test('attack of a simultaneously transferred target attributes pre-owner and post-transfer bearer canonically', () => {
  const c=structuredClone(PILOT_0_CONFIG);c.dynamics.combatMinimumHitPermille=1000;c.dynamics.combatMaximumHitPermille=1000;c.dynamics.combatDamage=100;
  const w=fixture('attack-transferred-target',c);turn(w,{'polity-1':[{type:'recruit'}],'polity-2':[{type:'recruit'}]});
  const attacker=w.polities['polity-1'].units[0],target=w.polities['polity-2'].units[0];locate(w,attacker,target.hex_id);
  discoverPolity(w,w.polities['polity-2'],'polity-3','fixture');refresh(w);
  turn(w,{'polity-1':[{type:'attack',unit_id:attacker.id,target_unit_id:target.id}],
    'polity-2':[{type:'transfer_unit',unit_id:target.id,to:'polity-3'}]});
  const transfer=w.evidence.events.find(e=>e.turn===1&&e.event_type==='WorldTransition'&&e.payload.mechanic==='transfer_unit');
  const destruction=w.evidence.events.find(e=>e.turn===1&&e.event_type==='PopulationUnitTransition'&&e.payload.transition==='destruction');
  const battle=w.evidence.events.find(e=>e.turn===1&&e.event_type==='BattleResolved'),outcome=JSON.parse(w.evidence.payloads.get(battle.payload.outcome_ref).bytes);
  assert.deepEqual(battle.participants,['polity-1','polity-2','polity-3']);assert.deepEqual(destruction.participants,['polity-2','polity-3']);
  assert.deepEqual(outcome.battleInputs[0].ownership,{attacker:'polity-1',target_pre_owner:'polity-2',target_post_bearer:'polity-3'});
  for(const eventId of [transfer.event_id,destruction.event_id])assert.ok(battle.causality.causation_ids.includes(eventId));
  assert.ok(destruction.causality.causation_ids.includes(transfer.event_id));
  const packet=prepareSyntheticCodingPacket(w.evidence).input,battleObservation=packet.observations.find(o=>o.type==='BattleResolved');
  const transferObservation=packet.observations.find(o=>o.type==='WorldTransition'&&o.facts.mechanic==='transfer_unit');
  const destructionObservation=packet.observations.find(o=>o.type==='PopulationUnitTransition'&&o.facts.transition==='destruction');
  assert.equal(new Set(battleObservation.actors).size,3);assert.equal(new Set(Object.values(battleObservation.facts.outcome.battleInputs[0].ownership)).size,3);
  for(const observation of [transferObservation,destructionObservation])assert.ok(battleObservation.causal_predecessors.includes(observation.ref));
});

test('attack of nested cargo attributes its root carrier transfer to every casualty record', () => {
  const c=structuredClone(PILOT_0_CONFIG);c.dynamics.combatMinimumHitPermille=1000;c.dynamics.combatMaximumHitPermille=1000;c.dynamics.combatDamage=100;
  const w=fixture('attack-nested-cargo-transfer',c);turn(w,{'polity-1':[{type:'recruit'}],'polity-2':[{type:'recruit'}]});
  const attacker=w.polities['polity-1'].units[0],target=w.polities['polity-2'].units[0],owner=w.polities['polity-2'];attacker.type='bomber';
  const water=Object.values(w.hexes).find(h=>h.terrain==='water');locate(w,attacker,water.id);locate(w,target,water.id);
  const makeCarrier=(id,embarkedOn)=>({id,type:'transport',hex_id:water.id,territory_id:water.territory_id,health:100,strength:3,fortified:false,embarked_on:embarkedOn,crew:target.crew.map((group,index)=>({...structuredClone(group),id:`${id}-crew-${index}`})),prerequisites:['navigation'],captured_from:null});
  const root=makeCarrier('root-carrier',null),inner=makeCarrier('inner-carrier',root.id);target.embarked_on=inner.id;owner.units.push(root,inner);owner.units.sort((a,b)=>a.id.localeCompare(b.id));
  discoverPolity(w,owner,'polity-3','fixture');refresh(w);
  recordFact(w.polities['polity-1'],'units',target.id,{id:target.id,owner_id:owner.id,type:target.type,hex_id:target.hex_id,territory_id:target.territory_id,current_location_known:true},w.turn,'adversarial_committed_target');assertWorldState(w);
  turn(w,{'polity-1':[{type:'attack',unit_id:attacker.id,target_unit_id:target.id}],
    'polity-2':[{type:'transfer_unit',unit_id:root.id,to:'polity-3'}]});
  const transfer=w.evidence.events.find(e=>e.turn===1&&e.event_type==='WorldTransition'&&e.payload.mechanic==='transfer_unit');
  const destruction=w.evidence.events.find(e=>e.turn===1&&e.event_type==='PopulationUnitTransition'&&e.payload.transition==='destruction');
  const battle=w.evidence.events.find(e=>e.turn===1&&e.event_type==='BattleResolved'),outcome=JSON.parse(w.evidence.payloads.get(battle.payload.outcome_ref).bytes),input=outcome.battleInputs[0],casualty=outcome.casualties[0];
  const expected={pre_bearer:'polity-2',post_bearer:'polity-3',transfer_action_id:transfer.payload.action_ids[0],transfer_event_ref:transfer.event_id,transferred_unit_id:root.id,embarked_path:[target.id,inner.id,root.id]};
  assert.deepEqual(input.ownership,{attacker:'polity-1',target_pre_owner:'polity-2',target_post_bearer:'polity-3'});assert.deepEqual(input.bearer_transition,expected);assert.deepEqual(casualty.bearer_transition,expected);
  assert.ok(battle.causality.causation_ids.includes(transfer.event_id));assert.ok(destruction.causality.causation_ids.includes(transfer.event_id));assert.deepEqual(destruction.participants,['polity-2','polity-3']);
  assert.ok(w.polities['polity-3'].units.some(unit=>unit.id===root.id));assert.ok(w.polities['polity-3'].units.some(unit=>unit.id===inner.id));assert.equal(w.polities['polity-2'].units.length,0);
  const packet=prepareSyntheticCodingPacket(w.evidence).input,battleObservation=packet.observations.find(o=>o.type==='BattleResolved'),transferObservation=packet.observations.find(o=>o.type==='WorldTransition'&&o.facts.mechanic==='transfer_unit'),destructionObservation=packet.observations.find(o=>o.type==='PopulationUnitTransition'&&o.facts.transition==='destruction');
  assert.ok(battleObservation.causal_predecessors.includes(transferObservation.ref));assert.ok(battleObservation.causal_predecessors.includes(destructionObservation.ref));w.evidence.verify();
});

test('cyclic embarked relationships fail closed', () => {
  const w=fixture('cyclic-embarkation');turn(w,{'polity-1':[{type:'recruit'}]});const p=w.polities['polity-1'],a=p.units[0],b={...structuredClone(a),id:'cyclic-unit',crew:a.crew.map((group,index)=>({...structuredClone(group),id:`cyclic-crew-${index}`}))};p.units.push(b);a.embarked_on=b.id;b.embarked_on=a.id;
  assert.throws(()=>assertWorldState(w),/cyclic or disconnected embarked unit relationship/);
});

test('siegeDamagePerTurn applies one fixed increment on each capital-hold turn', () => {
  const w=fixture('siege-per-turn'),victim='polity-2',captor='polity-1',capital=w.polities[victim].capital_hex_id;
  const territoryId=w.hexes[capital].territory_id,facilityId=Object.values(w.facilities).find(f=>f.hex_ids.includes(capital)).id;
  control(w,territoryId,captor);const conditions=[];
  for(let turnIndex=0;turnIndex<3;turnIndex++){turn(w);conditions.push(w.facilities[facilityId].condition);}
  assert.deepEqual(conditions,[95,90,85]);assert.equal(w.polities[victim].alive,false);
});

function transportFixture(name) {
  const w = fixture(name), id = 'polity-1', p = w.polities[id], f = facility(w, id, 'ground_military');
  p.technologies = ['navigation']; p.resources = { metal: 100, fuel: 100, crystal: 100 }; p.credits = 1000;
  f.type = 'naval_shipyard'; f.hex_ids = ['hex-1-2'];
  for (const assignment of ['Soldier', 'Explorer']) locate(w, group(w, id, assignment), 'hex-1-2');
  discoverPolity(w, p, 'polity-2', 'fixture'); refresh(w);
  turn(w, { [id]: [{ type: 'recruit', unit_type: 'transport', facility_id: f.id, hex_id: 'hex-0-2' }] });
  return w;
}

test('embark plus carrier gift rejects both commitments independently of action IDs', () => {
  for (const embarkFirst of [true, false]) {
    const w = transportFixture('carrier-conflict'), id = 'polity-1', ship = w.polities[id].units[0], g = group(w, id, 'Explorer');
    const orders = [{ type: 'embark', action_id: embarkFirst ? 'a' : 'z', carrier_id: ship.id, citizen_id: g.id },
      { type: 'transfer_unit', action_id: embarkFirst ? 'z' : 'a', unit_id: ship.id, to: 'polity-2' }];
    if (!embarkFirst) orders.reverse();
    const committed = commit(w, { [id]: orders });
    resolveTurn(w, committed); assertWorldState(w);
    assert.equal(w.polities[id].units[0].id, ship.id); assert.equal(group(w, id, 'Explorer').embarked_on, null);
    assert.equal(w.polities['polity-2'].units.length, 0);
    const rejected = w.evidence.events.filter(e => e.event_type === 'WorldTransition' && e.payload.mechanic === 'simultaneous_reservation_conflict');
    assert.deepEqual(rejected.flatMap(e => e.payload.action_ids).sort(), [...committed.accepted_action_ids].sort()); w.evidence.verify();
  }
});

test('multiple embarkations can share capacity while their carrier moves', () => {
  const w = transportFixture('ordinary-embark'), id = 'polity-1', ship = w.polities[id].units[0], g = group(w, id, 'Explorer');
  g.count = 1; const extra = { ...structuredClone(g), id: 'second-explorer' }; w.polities[id].citizens.push(extra);
  turn(w, { [id]: [g, extra].map(g => ({ type: 'embark', carrier_id: ship.id, citizen_id: g.id })).concat({ type: 'move', unit_id: ship.id, hex_id: 'hex-0-3' }) });
  for (const original of [g, extra]) { const after = w.polities[id].citizens.find(g => g.id === original.id); assert.equal(after.embarked_on, ship.id); assert.equal(after.hex_id, 'hex-0-3'); }
});

test('stale self-ownership never reveals foreign destruction fourteen hexes away', () => {
  const views = [];
  for (const destroyed of [false, true]) {
    const w = fixture('hidden-destruction'), id = 'polity-1', p = w.polities[id], f = facility(w, 'polity-2', 'research');
    f.hex_ids = ['hex-10-8']; for (const g of p.citizens) locate(w, g, 'hex-2-2');
    assert.equal(hexDistance(w.hexes['hex-2-2'], w.hexes[f.hex_ids[0]]), 14);
    recordFact(p, 'facilities', f.id, { id: f.id, owner_id: id, type: f.type, hex_ids: [...f.hex_ids], condition: 100 }, 0, 'prior_ownership');
    const cached = structuredClone(p.facts.facilities[f.id]); if (destroyed) delete w.facilities[f.id];
    w.turn = 1; observeWorld(w, id); assert.deepEqual(p.facts.facilities[f.id], cached);
    views.push(canonicalize(projectWorld(w, id)));
    if (destroyed) { observeWorld(w, id, { scanHexIds: f.hex_ids }); assert.equal(p.facts.facilities[f.id].value.destroyed, true); }
  }
  assert.equal(views[0], views[1]);
});

test('explicit destruction of a remote owned facility remains known to its actor', () => {
  const w = fixture('own-destruction'), id = 'polity-1', f = facility(w, id, 'industrial'); f.hex_ids = ['hex-10-8'];
  control(w, w.hexes[f.hex_ids[0]].territory_id, id);
  turn(w, { [id]: [{ type: 'destroy', facility_id: f.id }] });
  assert.equal(w.facilities[f.id], undefined); assert.equal(w.polities[id].facts.facilities[f.id].value.destroyed, true);
});

function conquests(w, edges, held = 2) {
  for (const [id, captor] of edges) {
    const p = w.polities[id]; control(w, w.hexes[p.capital_hex_id].territory_id, captor);
    p.takeover = { controller_id: captor, held_turns: held };
  }
  refresh(w); assertWorldState(w);
}

for (const edges of [[['polity-1', 'polity-2'], ['polity-2', 'polity-1']],
  [['polity-3', 'polity-2'], ['polity-2', 'polity-3']],
  [['polity-1', 'polity-2'], ['polity-2', 'polity-3'], ['polity-3', 'polity-1']]]) {
  test('cyclic conquest eliminates every member without a successor: ' + edges.map(e => e.join('->')).join(', '), () => {
    const w = fixture('cyclic-conquest'); conquests(w, edges); turn(w);
    const members=new Set(edges.map(([id])=>id));
    for(const id of members){assert.equal(w.polities[id].alive,false);assert.equal(w.polities[id].population,0);assert.equal(w.polities[id].food,0);assert.equal(w.polities[id].credits,0);}
    assert.ok(w.unaffiliatedPopulation.length>0);assert.ok(Object.values(w.territories).filter(t=>members.has(t.owner_id)).length===0);
    const event=w.evidence.events.find(e=>e.event_type==='WorldTransition'&&e.payload.mechanic==='closed_conquest_cycle');
    assert.deepEqual(event.payload.detail.cycle_members,[...members].sort());assert.ok(event.payload.detail.asset_transition_event_ids.length);w.evidence.verify();assertWorldState(w);
  });
}

for (const edges of [[['polity-1', 'polity-2'], ['polity-2', 'polity-3']],
  [['polity-3', 'polity-2'], ['polity-2', 'polity-1']],
  [['polity-1', 'polity-3'], ['polity-2', 'polity-3']]]) {
  test('noncyclic conquest honors every precomputed elimination: ' + edges.map(e => e.join('->')).join(', '), () => {
    const w = fixture('noncyclic-conquest'); conquests(w, edges); const losers = new Set(edges.map(([id]) => id));
    const survivor = Object.keys(w.polities).find(id => !losers.has(id)); turn(w);
    for (const id of losers) { assert.equal(w.polities[id].alive, false); assert.equal(w.polities[id].population, 0); }
    assert.equal(w.polities[survivor].alive, true);
    for (const p of Object.values(w.polities)) assert.equal(w.territories[w.hexes[p.capital_hex_id].territory_id].owner_id, survivor);
    assert.equal(w.polities[survivor].population, 75); w.evidence.verify();
  });
}

test('reciprocal occupations below the hold threshold continue without choosing a successor', () => {
  const w = fixture('below-threshold'); conquests(w, [['polity-1', 'polity-2'], ['polity-2', 'polity-1']], 1); turn(w);
  for (const id of ['polity-1', 'polity-2']) { assert.equal(w.polities[id].alive, true); assert.equal(w.polities[id].takeover.held_turns, 2); }
});
