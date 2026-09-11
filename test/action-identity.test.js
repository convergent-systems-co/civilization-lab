import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorld,PILOT_0_CONFIG,resolveTurn} from '../src/world.js';
import {ActionLedger,commitTurn,projectWorld} from '../src/contracts.js';
import {participantModelProjection} from '../src/agent.js';
import {renderCompletion,PROVISIONAL_MODEL_PARAMETERS} from '../src/model-adapter.js';
import {observeWorld} from '../src/world-map.js';

test('cross-actor submission arrival cannot change default causal action IDs, addressed combat, or state',()=>{
  function run(order){
    const config=structuredClone(PILOT_0_CONFIG);config.unitTypes.infantry.detection=20;config.unitTypes.infantry.range=20;
    const w=makeWorld({runId:'nonempirical-review-arrival-order',seed:'adversarial-fixture-fixed',config}),ledger=new ActionLedger(w.evidence);
    const commitActions=(turn,actions)=>{
      const records=order.map(id=>ledger.validate(ledger.submit({runId:w.runId,turnId:'turn-'+turn,actorId:id,actor:{persistent_identity_id:id,session_id:'session-'+id,invocation_id:'invocation-'+turn+'-'+id},actions:actions(id),projection:projectWorld(w,id)}),w));
      const committed=commitTurn(w,ledger,records);resolveTurn(w,committed);return committed;
    };
    const first=commitActions(0,()=>[{type:'recruit'}]);
    const last=commitActions(1,id=>id==='polity-1'?[{type:'attack',unit_id:w.polities[id].units[0].id,target_unit_id:w.polities['polity-2'].units[0].id}]:[{type:'wait'}]);
    return {state:w.authoritativeState(),ids:[...first.accepted_action_ids,...last.accepted_action_ids],combat:w.evidence.events.filter(e=>e.event_type==='RNGDraw'&&e.rng?.subsystem==='combat').map(e=>e.payload.draw_value)};
  }
  assert.deepEqual(run(['polity-1','polity-2','polity-3']),run(['polity-3','polity-2','polity-1']));
});

test('full-map authorized observation plus rules and maximum memory fits the provisional common context budget',()=>{
  const w=makeWorld({runId:'synthetic-full-map-budget',seed:'synthetic-acl-review'});
  // Authorize all spatial observations in this input-sizing fixture only.
  w.config.map.contactRadius=100;observeWorld(w,'polity-1');
  assert.equal(Object.keys(w.polities['polity-1'].facts.hexes).length,Object.keys(w.hexes).length);
  const projection=participantModelProjection(projectWorld(w,'polity-1'),{runId:w.runId,actorId:'polity-1',turn:0});
  const bytes=Buffer.byteLength(renderCompletion({projection,memory:['x'.repeat(w.config.memory.capacity)]}));
  assert.ok(bytes+PROVISIONAL_MODEL_PARAMETERS.sampling.max_tokens<=PROVISIONAL_MODEL_PARAMETERS.context_budget,`${bytes} bytes`);
});

test('participant labels neither collide across actors nor carry arbitrary history into world state',()=>{
  const world=makeWorld({runId:'synthetic-label-isolation',seed:'label-fixture'}),ledger=new ActionLedger(world.evidence);
  const narrative='Unrelated private history that must not become an action identifier '.repeat(16);
  const records=Object.keys(world.polities).map(actorId=>{
    const submission=ledger.submit({runId:world.runId,turnId:'turn-0',actorId,actor:{persistent_identity_id:actorId,session_id:'s-'+actorId,invocation_id:'i-'+actorId},actions:[{type:'wait',action_id:narrative}],projection:projectWorld(world,actorId)});
    assert.equal(submission.submitted_actions[0].action_id,narrative);
    assert.ok(!submission.actions[0].action_id.includes('history'));
    return ledger.validate(submission,world);
  });
  const committed=commitTurn(world,ledger,records);
  assert.equal(new Set(committed.accepted_action_ids).size,records.length);
  resolveTurn(world,committed);
  assert.ok(!JSON.stringify(world.authoritativeState()).includes(narrative));
  assert.ok(!JSON.stringify(projectWorld(world,'polity-1')).includes(narrative));
});
