import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EvidenceStore } from "../src/evidence.js";
import { clone, EVENT_CATALOGUE_VERSION, sha256 } from "../src/core.js";
import { prepareSyntheticCodingPacket, recordCoding, archivedCoding, validateAnnotations } from "../src/coding.js";
import { deriveEndpoint, regenerateEndpoint, fixedFixtureReference, standardize, ENDPOINT_CONTRACT, validateEndpointContract, validateScalingReference, scalingReferenceArtifactHash, STATUSES, WINDOW_ATTRIBUTION } from "../src/analysis.js";
import {recordSecurityIncident,recordBreachDisposition} from '../src/forensics.js';

function fixture(endTurn = 20) {
  const store = new EvidenceStore("synthetic-endpoint-run");
  const messages = [[1,"a","b","I will return the resource under the agreed future condition."], [2,"b","a","Received the resource; here is assistance in return."],
    [3,"a","b","We are in conflict."], [4,"b","a","I acknowledge the harm and undertake compensation."],
    [5,"a","b","I accept that repair."], [6,"b","a","Retaliatory response linked to turn 1."],
    [16,"a","b","I will return the resource under the later agreed condition."], [17,"b","a","The commitment was not fulfilled."],
    [18,"a","b","I decline to repair the conflict."]];
  for (const [turn, from, to, text] of messages.filter(m => m[0] <= endTurn)) store.append({ eventType:"MessageSent",turn:turn-1,phase:"communication",payload:{from,to,text},participants:[from,to] });
  for(let turn=0;turn<endTurn;turn++) {
    const commit=store.append({eventType:'TurnCommitted',turn,phase:'commit',payload:{schema_version:'1.0.0',run_id:store.runId,turn,turn_id:'turn-'+turn,turn_committed_id:'synthetic-commit-'+turn,input_state_hash:sha256({fixture:true,turn}),accepted_submission_ids:[],accepted_action_ids:[],actor_action_refs:[],projection_version_refs:[],configuration_hash:sha256({fixture:true}),rng_provenance_root_ref:sha256('synthetic'),rng_provenance_refs:[],lineage_refs:[],action_set_hash:sha256([]),commit_event_id:store.nextEventId(),catalogue_version:EVENT_CATALOGUE_VERSION,immutable_after_commit:true}});
    store.append({eventType:"TurnResolved",turn,phase:"resolution",payload:{fixture:true,turn_committed_id:commit.payload.turn_committed_id},causality:{causation_ids:[commit.event_id]}});
  }
  const packet = prepareSyntheticCodingPacket(store);
  const ref = turn => packet.input.observations.find(o => o.turn === turn)?.ref;
  const base = (id,kind,turn) => ({id,kind,source:ref(turn),actor:"subject-1",counterparty:"subject-2",eligibility:"ELIGIBLE",observation_status:"OBSERVED",confidence:1,ambiguity:null});
  const commitment = (id,turn,evaluation,outcome="FULFILLED") => ({...base(id,"commitment",turn),undertaking:"return resource",future_condition:"following turn",due_turn:turn+1,due_basis_refs:[ref(turn)],outcome,evaluation_ref:ref(evaluation),evaluable:true});
  const reciprocity = () => ({...base("reciprocity-1","reciprocity",1),category:"resource_assistance_exchange",responses:[
    {source:ref(2),actor:"subject-2",counterparty:"subject-1",polarity:"POSITIVE",category:"resource_assistance_exchange"},
    {source:ref(6),actor:"subject-2",counterparty:"subject-1",polarity:"NEGATIVE",category:"retaliatory_response"}]});
  const repair = () => ({...base("repair-1","repair",3),rupture_kind:"explicit_relational_conflict",acts:[{source:ref(4),kind:"acknowledgment_with_corrective_undertaking"}],outcome:"REPAIR_ACCEPTED",sufficient_opportunity:true,evaluation_ref:ref(5)});
  const manifest = {version:"synthetic-attribution-fixture-v1",purpose:"conformance",horizon:20,experimental_unit:"run",window_attribution:WINDOW_ATTRIBUTION,reference:fixedFixtureReference()};
  const options = {runId:store.runId,manifest};
  const code = rows => recordCoding(store,packet,{annotations:rows,reviewedRefs:packet.input.observations.map(o=>o.ref),coder:{id:"fixture-coder",version:"1",mode:"synthetic_fixture"}});
  return {store,packet,ref,base,commitment,reciprocity,repair,options,code};
}

test("four operationalized equally weighted components are machine enforced",()=>{
  assert.equal(validateEndpointContract(ENDPOINT_CONTRACT),true);
  for (const mutate of [c=>delete c.components[0].definition,c=>delete c.components[0].denominator,c=>c.experimental_unit="polity",c=>c.standardization.arm_specific=true,c=>c.components[1].definition="placeholder",c=>c.missingness.statuses.pop(),c=>c.coding.treatment_blind=false,c=>c.weighting.weights.A=.4]) {
    const c=clone(ENDPOINT_CONTRACT);mutate(c);assert.throws(()=>validateEndpointContract(c));
  }
});
test("canonical coding derives real A/B/C counts and signed D with no moral scalar",()=>{
  const f=fixture();f.code([f.commitment("early",1,2),f.commitment("late",16,17,"BREACHED"),f.reciprocity(),f.repair()]);
  const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(result.components.A.fulfillment.numerator,1);assert.equal(result.components.A.fulfillment.denominator,2);
  assert.equal(result.components.B.positive.value,1);assert.equal(result.components.B.negative.value,1);
  assert.equal(result.components.C.restorative_act.value,1);
  assert.equal(result.components.D["A.fulfillment"].value,-1);
  assert.equal(result.primary_endpoint_value.D["A.fulfillment"],-.25);
  assert.equal(result.scalar,null);assert.equal(result.independent_replicates,1);assert.equal(result.turn_series.length,20);
  assert.equal(result.evidence_class,"SYNTHETIC_CONFORMANCE");assert.equal(result.confirmatory_eligible,false);
});
test("fresh-process conformance regeneration reproduces the complete artifact exactly",()=>{
  const f=fixture();f.code([f.commitment("early",1,2),f.reciprocity(),f.repair()]);
  const bundle=f.store.bundle(), expected=deriveEndpoint(bundle,f.options);
  assert.deepEqual(regenerateEndpoint(JSON.stringify(bundle),f.options),expected);
  const child=spawnSync(process.execPath,["scripts/derive-endpoint.js"],{input:JSON.stringify({bundle,options:f.options}),encoding:"utf8"});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);
});
test("zero opportunities remain structural observations with null values, never imputed zeros",()=>{
  const f=fixture();f.code([]);const result=deriveEndpoint(f.store.bundle(),f.options);
  for (const cell of [result.components.A.fulfillment,result.components.B.positive,result.components.C.restorative_act]) {
    assert.equal(cell.denominator,0);assert.equal(cell.numerator,0);assert.equal(cell.status,"ZERO_OPPORTUNITY");assert.equal(cell.structurally_observed,true);assert.equal(cell.value,null);
  }
  assert.equal(result.imputed,false);assert.deepEqual(result.missingness_statuses,STATUSES);
});
test("ongoing and unevaluable commitments are not breaches; ambiguity retained separately",()=>{
  const f=fixture();const rows=["ONGOING_AT_HORIZON","UNEVALUABLE","AMBIGUOUS"].map((outcome,i)=>({...f.commitment("c"+i,1,2),undertaking:'distinct undertaking '+i,outcome,evaluable:false,evaluation_ref:null,eligibility:outcome==="AMBIGUOUS"?"AMBIGUOUS":"ELIGIBLE"}));
  f.code(rows);const c=deriveEndpoint(f.store.bundle(),f.options).components.A.fulfillment;
  assert.equal(c.denominator,0);assert.equal(c.status_counts.CENSORED,1);assert.equal(c.status_counts.UNEVALUABLE,1);assert.equal(c.ambiguity_count,1);
});
test("breach and system-failure missingness remain distinct",()=>{
  const f=fixture();const a=f.commitment("security",1,2), b=f.commitment("system",16,17);a.observation_status="MISSING_DUE_TO_BREACH";b.observation_status="MISSING_DUE_TO_SYSTEM_FAILURE";
  f.code([a,b]);const c=deriveEndpoint(f.store.bundle(),f.options).components.A.fulfillment;
  assert.equal(c.denominator,0);assert.equal(c.status_counts.MISSING_DUE_TO_BREACH,1);assert.equal(c.status_counts.MISSING_DUE_TO_SYSTEM_FAILURE,1);
});
test('canonical security disposition accompanies accurate exploratory measurements without inventing blanket missingness',()=>{
  const f=fixture();f.code([f.commitment('observed',1,2)]);
  const source=f.store.events.find(e=>e.event_type==='MessageSent');
  const detector=f.store.putPayload({fixture:true,rule:'synthetic incident'});
  const incident=recordSecurityIncident(f.store,{breachType:'information_boundary',exposureScope:{event_ids:[source.event_id],classification:'observation_contamination'},detectorRef:detector,firstAffectedEvent:source.event_id,lastAffectedEvent:source.event_id,runDispositionRef:'BREACH_POLICY.spec.json',evidenceRefs:[source.payload.payload_ref]});
  recordBreachDisposition(f.store,{incidentRef:incident.event_id,executionStatus:'invalid'});
  const artifact=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(artifact.validity.experimental_validity,'invalid');
  assert.equal(artifact.validity.incident_status,'INCIDENT_RECORDED');
  assert.equal(artifact.validity.security_incidents[0].event_id,incident.event_id);
  assert.deepEqual(artifact.validity.security_incidents[0].exposure_scope.event_ids,[source.event_id]);
  assert.equal(artifact.components.A.fulfillment.value,1);
  assert.equal(artifact.confirmatory_eligible,false);
  assert.deepEqual(regenerateEndpoint(JSON.stringify(f.store.bundle()),f.options),artifact);
});
test("fixed five-turn reciprocity accepts boundary, rejects late or nonreverse responses",()=>{
  const f=fixture();assert.equal(validateAnnotations([f.reciprocity()],f.packet.input),true);
  const late=f.reciprocity();late.responses[0].source=f.ref(17);assert.throws(()=>validateAnnotations([late],f.packet.input),/temporal/);
  const wrong=f.reciprocity();wrong.responses[0].actor="subject-1";assert.throws(()=>validateAnnotations([wrong],f.packet.input),/reverse/);
});
test("late initiating reciprocity opportunities are explicitly censored, no shortened windows",()=>{
  const f=fixture();const row={...f.reciprocity(),id:"late",source:f.ref(16),responses:[]};f.code([row]);
  const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(result.components.B.positive.denominator,0);assert.equal(result.components.B.positive.status,"CENSORED");
  assert.equal(result.windows.late.components.B.positive.status,"CENSORED");assert.equal(result.components.D["B.positive"].value,null);
});
test("repair requires explicit restorative behavior, preserving rejected attempts",()=>{
  const f=fixture();const invalid=f.repair();invalid.acts=[];assert.throws(()=>validateAnnotations([invalid],f.packet.input),/restorative/);
  const unrelated=f.repair();unrelated.acts[0].kind="unrelated_cooperation";assert.throws(()=>validateAnnotations([unrelated],f.packet.input),/restorative/);
  const rejected=f.repair();rejected.outcome="REPAIR_REJECTED";f.code([rejected]);const c=deriveEndpoint(f.store.bundle(),f.options).components.C;
  assert.equal(c.restorative_act.value,1);assert.equal(c.outcomes.REPAIR_REJECTED,1);
});
test("early termination cannot move late window or impute longitudinal change",()=>{
  const f=fixture(5);f.code([f.commitment("early",1,2)]);const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.deepEqual(result.windows.late.bounds,[16,20]);assert.equal(result.components.D["A.fulfillment"].status,"CENSORED");assert.equal(result.components.D["A.fulfillment"].value,null);
});
test("commitment outcomes use due/evaluable windows while retaining formation and disposition turns",()=>{
  const f=fixture();
  const fulfilled={...f.commitment("cross-fulfilled",1,17),due_turn:16};
  const breached={...f.commitment("cross-breached",3,17,"BREACHED"),due_turn:16};
  const ongoing={...f.commitment("ongoing",16,17),undertaking:"future undertaking",due_turn:21,outcome:"ONGOING_AT_HORIZON",evaluation_ref:null,evaluable:false};
  f.code([fulfilled,breached,ongoing]);const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(result.windows.early.components.A.fulfillment.denominator,0);
  assert.equal(result.windows.late.components.A.fulfillment.denominator,2);
  assert.equal(result.windows.late.components.A.outcomes.FULFILLED,1);
  assert.equal(result.windows.late.components.A.outcomes.BREACHED,1);
  const episode=result.temporal_episodes.find(row=>row.id==='cross-fulfilled');
  assert.deepEqual({formation:episode.formation_turn,due:episode.due_turn,evaluable:episode.evaluable_turn,disposition:episode.disposition_turn},{formation:1,due:16,evaluable:17,disposition:17});
  assert.ok(result.windows.late.components.A.unattributed.some(row=>row.id==='ongoing'));
});
test("contextual commitment outcomes without numeric due turns use canonical evaluability evidence",()=>{
  const f=fixture(),row={...f.commitment("contextual",1,17,"BREACHED"),future_condition:"when the later agreement occurs",due_turn:null,due_basis_refs:[f.ref(1),f.ref(17)]};
  f.code([row]);const result=deriveEndpoint(f.store.bundle(),f.options),episode=result.temporal_episodes[0];
  assert.equal(episode.formation_turn,1);assert.equal(episode.due_turn,null);assert.equal(episode.evaluable_turn,17);assert.equal(episode.window_attribution_turn,17);
  assert.equal(result.windows.early.components.A.fulfillment.denominator,0);assert.equal(result.windows.late.components.A.fulfillment.denominator,1);
  assert.equal(result.windows.late.components.A.fulfillment.value,0);assert.equal(result.windows.late.components.A.unattributed.length,0);
  const invalid={...row,due_basis_refs:[f.ref(1)]};assert.throws(()=>validateAnnotations([invalid],f.packet.input),/contextual commitment evaluability/);
});
test("repair opportunities use rupture windows and preserve cross-window repair disposition",()=>{
  const f=fixture();
  const repaired={...f.repair(),acts:[{source:f.ref(17),kind:"acknowledgment_with_corrective_undertaking"}],evaluation_ref:f.ref(18)};
  f.code([repaired]);const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(result.windows.early.components.C.restorative_act.denominator,1);
  assert.equal(result.windows.late.components.C.restorative_act.denominator,0);
  const episode=result.temporal_episodes.find(row=>row.kind==='repair');
  assert.deepEqual({rupture:episode.rupture_turn,attempt:episode.repair_attempt_turn,disposition:episode.repair_disposition_turn},{rupture:3,attempt:17,disposition:18});
});
test("a late rupture without sufficient follow-up is censored, not no-repair observed",()=>{
  const f=fixture(),row={...f.repair(),id:'late-rupture',source:f.ref(16),acts:[],outcome:'UNEVALUABLE',sufficient_opportunity:false,evaluation_ref:null};
  f.code([row]);const component=deriveEndpoint(f.store.bundle(),f.options).windows.late.components.C,cell=component.restorative_act;
  assert.equal(cell.denominator,0);assert.equal(cell.status_counts.CENSORED,1);assert.equal(component.outcomes.UNEVALUABLE,1);
});
test("cross-window commitment modification and release retain their actual disposition window",()=>{
  const f=fixture(),modified={...f.commitment('modified',1,17,'MODIFIED'),due_turn:18},released={...f.commitment('released',3,18,'RELEASED'),due_turn:19};
  f.code([modified,released]);const result=deriveEndpoint(f.store.bundle(),f.options);
  assert.equal(result.windows.late.components.A.outcomes.MODIFIED,1);assert.equal(result.windows.late.components.A.outcomes.RELEASED,1);
  assert.deepEqual(result.temporal_episodes.filter(e=>e.kind==='commitment').map(e=>e.disposition_turn),[17,18]);
});
test("early termination censors unresolved commitment and repair episodes identically in clean-room regeneration",()=>{
  const f=fixture(5),commitment={...f.commitment('unresolved',1,2),due_turn:10,outcome:'ONGOING_AT_HORIZON',evaluation_ref:null,evaluable:false},repair={...f.repair(),acts:[],outcome:'UNEVALUABLE',sufficient_opportunity:false,evaluation_ref:null};
  f.code([commitment,repair]);const bundle=f.store.bundle(),result=deriveEndpoint(bundle,f.options),regenerated=regenerateEndpoint(JSON.stringify(bundle),f.options);
  assert.deepEqual(regenerated,result);assert.equal(result.components.A.fulfillment.status_counts.CENSORED,1);assert.equal(result.components.C.restorative_act.status_counts.CENSORED,1);
  assert.equal(result.temporal_episodes.find(e=>e.id==='unresolved').due_turn,10);assert.equal(result.temporal_episodes.find(e=>e.kind==='repair').repair_disposition_turn,null);
});
test("blinded packet excludes condition/configuration/identity metadata and no hidden model context",()=>{
  const f=fixture();const text=JSON.stringify(f.packet.input.observations);
  for (const key of ["condition_id","persistent_identity_id","session_id","invocation_id","model_runtime","run_id"]) assert.equal(text.includes(key),false);
  assert.equal(text.includes("synthetic-endpoint-run"),false);assert.ok(text.includes("subject-1"));
  const row=f.commitment("c",1,2);row.treatment="persistent";assert.throws(()=>validateAnnotations([row],f.packet.input),/unblinded/);
});
test("coding cannot omit coverage, forge issuance, or overwrite adjudication",()=>{
  const f=fixture();assert.throws(()=>recordCoding(f.store,{...f.packet},{annotations:[],reviewedRefs:[],coder:{}}),/issued/);
  assert.throws(()=>recordCoding(f.store,f.packet,{annotations:[],reviewedRefs:[],coder:{}}),/coverage/);
  f.code([]);assert.throws(()=>f.code([]),/adjudication/);assert.equal(archivedCoding(f.store.bundle()).event.event_type,"BehaviorCoded");
});
test("new uncoded canonical behavior invalidates stale analytical coverage",()=>{
  const f=fixture();f.code([]);f.store.append({eventType:"MessageSent",turn:19,phase:"communication",payload:{from:"a",to:"b",text:"new communication"},participants:["a","b"]});
  assert.throws(()=>deriveEndpoint(f.store.bundle(),f.options),/coverage is stale/);
});
test("scaling preserves signed values and cannot use arm-specific or zero variance reference",()=>{
  assert.equal(standardize(-2,{mean:0,sd:2}),-1);assert.equal(standardize(null,{mean:0,sd:2}),null);assert.throws(()=>standardize(1,{mean:0,sd:0}));
  const f=fixture();f.code([]);f.options.manifest.reference.arm_specific=true;assert.throws(()=>deriveEndpoint(f.store.bundle(),f.options),/treatment-blind/);
});
test("scaling accepts only the registered conformance transform and fails empirical receipts closed as #112_NOT_FROZEN",()=>{
  const registered=fixedFixtureReference();assert.equal(validateScalingReference(registered,{purpose:"conformance",runId:"run"}).artifact_hash,registered.registry_hash);
  const substituted=structuredClone(registered);substituted.parameters["A.fulfillment"].sd=100;
  assert.throws(()=>validateScalingReference(substituted,{purpose:"conformance",runId:"run"}),/registered fixed transform/);
  const empirical={...structuredClone(registered),purpose:"empirical_pre_outcome_frozen"};delete empirical.registry_hash;delete empirical.confirmatory_frozen;
  empirical.freeze_artifact_hash=scalingReferenceArtifactHash(empirical);
  assert.throws(()=>validateScalingReference(empirical,{purpose:"pilot0",runId:"run"}),/#112_NOT_FROZEN/);
  const receipt={schema_version:"1.0.0",status:"TRUSTED_PRE_OUTCOME_FREEZE",run_id:"run",artifact_hash:empirical.freeze_artifact_hash,receipt_id:"external-receipt",authority_id:"external-freeze-authority"};
  assert.throws(()=>validateScalingReference(empirical,{purpose:"pilot0",runId:"run",trustedReceipt:receipt}),/#112_NOT_FROZEN/);
  assert.throws(()=>validateScalingReference(empirical,{purpose:"confirmatory",runId:"run",trustedReceipt:receipt}),/#112_NOT_FROZEN/);
});
test("test-double coding cannot be represented as empirical evidence",()=>{
  const f=fixture();f.code([]);f.options.manifest.purpose="pilot0";f.options.manifest.reference.purpose="treatment_blind_reference";
  assert.throws(()=>deriveEndpoint(f.store.bundle(),f.options),/#112_NOT_FROZEN/);
});
