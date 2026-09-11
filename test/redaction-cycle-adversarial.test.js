import test from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceStore} from '../src/evidence.js';
import {recordRedaction,redactBundle} from '../src/forensics.js';

function worldTransition(store,{mechanic,before,after,participants=['polity-1'],detail={},causationIds=[]}) {
  return store.append({eventType:'WorldTransition',turn:1,phase:'resolve',participants,
    causality:{causation_ids:causationIds},provenance:{input_refs:[before]},payload:{schema_version:'1.0.0',run_id:store.runId,
      mechanic,action_ids:[],actor_ids:participants,before_state_ref:before,after_state_ref:after,
      detail:{mechanic_version:'world-v2',...detail}}});
}

test('non-string redaction follows world-transition provenance into event and state outputs',()=>{
  const store=new EvidenceStore('redaction-numeric-world');
  const before=store.putPayload({population:[{id:'resident-1',sensitive_score:987654321}]},'human_private');
  const after=store.putPayload({unaffiliated_population:[{id:'resident-1',sensitive_score:987654321}]},'authoritative_research');
  const event=worldTransition(store,{mechanic:'resource_extinguishment',before,after});
  recordRedaction(store,{artifactRef:before,fieldOrRange:'/population/0/sensitive_score',reason:'consent withdrawal',authority:'privacy-officer'});
  const redacted=redactBundle(store.bundle());
  for(const ref of [before,after,event.payload.payload_ref])assert.equal(redacted.payloads[ref],undefined,ref);
  assert.equal(redacted.events.find(item=>item.event_id===event.event_id).payload.redacted,true);
  assert.equal(redacted.redaction_status,'REPLAY_INCOMPLETE_REDACTED');
});

test('population/unit causal payload references fail closed when archived content is absent',()=>{
  const store=new EvidenceStore('missing-population-evidence');
  const before=store.putPayload({population:1}),after=store.putPayload({population:0});
  const eventId=store.nextEventId();
  store.append({eventType:'PopulationUnitTransition',turn:1,phase:'resolve',participants:['polity-1'],payload:{
    schema_version:'1.0.0',transition_id:'transition-1',run_id:store.runId,turn:1,transition:'estate_disposition',
    population_before_ref:before,population_after_ref:after,unit_before_refs:[],unit_after_refs:[],
    resource_input_refs:[],canonical_event_ref:eventId}});
  store.payloads.delete(after);
  assert.throws(()=>store.verify(),/missing or corrupt external input evidence/);
});

test('closed-cycle summaries fail closed on dangling canonical asset references',()=>{
  const store=new EvidenceStore('cycle-reference-validation');
  const before=store.putPayload({territories:{}}),after=store.putPayload({territories:{}});
  worldTransition(store,{mechanic:'closed_conquest_cycle',before,after,participants:['polity-1','polity-2'],detail:{
    cycle_members:['polity-1','polity-2'],elimination_predicates:[
      {polity_id:'polity-1',eliminate:true,conquered:true},{polity_id:'polity-2',eliminate:true,conquered:true}],
    asset_transition_event_ids:['evt_does_not_exist'],elimination_event_ids:['evt_elimination_1','evt_elimination_2'],
    resolution:'simultaneous_no_successor'}});
  assert.throws(()=>store.verify(),/invalid cyclic estate transition reference/);
});

test('redacting an asset transition purges its causal closed-cycle summary',()=>{
  const store=new EvidenceStore('cycle-causal-redaction');
  const facilityBefore=store.putPayload({facility:{id:'facility-1',sensitive_capacity:73}},'human_private');
  const facilityAfter=store.putPayload({facility:{id:'facility-1',owner_id:null,sensitive_capacity:73}});
  const asset=worldTransition(store,{mechanic:'facility_unclaimed',before:facilityBefore,after:facilityAfter});
  const cycleBefore=store.putPayload({facilities:['facility-1']}),cycleAfter=store.putPayload({facilities:['facility-1'],unaffiliated_population:[]});
  const summary=worldTransition(store,{mechanic:'closed_conquest_cycle',before:cycleBefore,after:cycleAfter,participants:['polity-1','polity-2'],
    causationIds:[asset.event_id],detail:{cycle_members:['polity-1','polity-2'],elimination_predicates:[],
      asset_transition_event_ids:[asset.event_id],elimination_event_ids:[],resolution:'simultaneous_no_successor'}});
  // Deliberately transform the protected numeric value so textual/key-value
  // matching cannot discover this derivative. Canonical transition provenance
  // must still taint the authoritative same-turn snapshot.
  const snapshotState=store.putPayload({aggregate_private_measure:146});
  const snapshot=store.append({eventType:'SnapshotCreated',turn:1,phase:'archive',payload:{run_id:store.runId,turn:1,
    state_ref:snapshotState,state_hash:snapshotState,authoritative:true}});
  recordRedaction(store,{artifactRef:facilityBefore,fieldOrRange:'/facility/sensitive_capacity',reason:'privacy correction',authority:'privacy-officer'});
  const redacted=redactBundle(store.bundle());
  for(const ref of [facilityBefore,facilityAfter,asset.payload.payload_ref,cycleAfter,summary.payload.payload_ref,snapshotState,snapshot.payload.payload_ref])assert.equal(redacted.payloads[ref],undefined,ref);
});
