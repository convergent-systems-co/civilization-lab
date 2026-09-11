import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { clone, assert, sha256, stableId } from './core.js';
import { EvidenceStore } from './evidence.js';
import { parameterRegistry, assertPilotConfigRegistered } from './parameters.js';
import { WorldRng } from './world-rng.js';
import { generateMap, validateWorldStarts, sortedActors, sortedValues, territoryHexes, observeWorld, projectWorldState } from './world-map.js';
import { ACTION_TYPES, validateAction } from './world-actions.js';
import { assertWorldState, resolveApparatus } from './world-resolution.js';

function freeze(value) {if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const PILOT_0_CONFIG=freeze(JSON.parse(readFileSync(new URL('../config/pilot0-world.json',import.meta.url),'utf8')));
export { projectWorldState, validateAction, assertWorldState, validateWorldStarts };
export { hexDistance, hexId, findPath, contiguous } from './world-map.js';
export { conflictComponents } from './world-actions.js';

function actorState(p) {
  // Authoritative state includes exact knowledge, pending work, crew, and economy.
  return clone(p);
}
export function authoritativeState(world) {
  return {run_id:world.runId,seed:world.seed,turn:world.turn,phase:world.phase,config:clone(world.config),
    polities:Object.fromEntries(sortedActors(world).map(p=>[p.id,actorState(p)])),hexes:clone(world.hexes),
    territories:clone(world.territories),facilities:clone(world.facilities),channels:clone(world.channels),
    unaffiliated_population:clone(world.unaffiliatedPopulation),neutral_units:clone(world.neutralUnits),
    terminal:world.terminal,termination_reason:world.terminationReason??null};
}
/** A principal is mandatory for participant state. Global world truth is Observer-only. */
export function publicState(world,actorId) {
  if(actorId)return projectWorldState(world,actorId);
  return {runId:world.runId,turn:world.turn,phase:world.phase};
}
export function stateHash(world) {return sha256(authoritativeState(world));}
function bind(world) {
  world.stateHash=()=>stateHash(world);world.publicState=actorId=>publicState(world,actorId);
  world.authoritativeState=()=>authoritativeState(world);world.validateAction=(id,action)=>validateAction(world,id,action);
  world.projectWorldState=id=>projectWorldState(world,id);
  return world;
}
function validateConfiguration(config) {
  assertPilotConfigRegistered(config);
  assert(config.maxTurns===20 && config.organizations.enabled===false && config.supply.enabled===false && config.dynamics.unrestEnabled===false,'Pilot 0 feature/horizon boundary');
  assert(config.geography.starts.length===3 && config.startingProfiles.length===3,'Pilot 0 requires three starts');
  assert(Object.values(config.assignments).reduce((n,g)=>n+g.starting,0)===config.population.starting,'starting assignments must conserve population');
  assert(config.dynamics.numericScale===1000,'unsupported fixed-point scale');
  assert(config.worldCalibration.classification==='WORLD_CALIBRATION' && config.worldCalibration.status==='PROVISIONAL_NONEMPIRICAL_DEFAULTS','unclassified world apparatus');
  for(const [name,spec]of Object.entries(config.unitTypes))assert(config.facilityTypes[spec.facility] && spec.citizens>0 && spec.prerequisites.every(t=>config.technologies[t]),'invalid unit specification '+name);
  for(const spec of Object.values(config.facilityTypes))assert(spec.hexes>0 && spec.prerequisites.every(t=>config.technologies[t]),'invalid facility specification');
  function numbers(value,path='config') {
    if(typeof value==='number')assert(Number.isFinite(value)&&value>=0&&value<=config.dynamics.maxQuantity,'invalid numeric configuration '+path);
    else if(value && typeof value==='object')for(const [key,item]of Object.entries(value))numbers(item,path+'.'+key);
  }
  numbers(config);
}
export function makeWorld({runId=`run-${randomUUID()}`,seed=`seed-${randomUUID()}`,config=PILOT_0_CONFIG,evidence=new EvidenceStore(runId)}={}) {
  validateConfiguration(config);assert(evidence.runId===runId,'world evidence run mismatch');
  const world=bind({runId,seed,config:clone(config),turn:0,phase:'actions',polities:{},hexes:{},territories:{},facilities:{},channels:{},
    unaffiliatedPopulation:[],neutralUnits:[],
    evidence,rng:new WorldRng(seed,evidence,{deferred:true}),actionTypes:clone(ACTION_TYPES),lastTurnCommit:null,snapshots:[],
    committedRecords:new Map(),resolvedCommits:new Set(),terminal:false,terminationReason:null});
  generateMap(world);
  for(const start of world.starts) {
    const profile=config.startingProfiles[start.profile],id=start.actorId,territoryId=world.hexes[start.id].territory_id;
    const home=territoryHexes(world,territoryId).filter(h=>h.terrain!=='water');
    const siteOrder=[world.hexes[start.id],...home.filter(h=>h.id!==start.id)];
    assert(siteOrder.length>=config.initialFacilityTypes.length,'initial facility footprint insufficient');
    const facilityByType={};
    for(const [i,type]of config.initialFacilityTypes.entries()) {
      const spec=config.facilityTypes[type],fid=stableId('initial-facility',runId,id,type);
      assert(spec.hexes===1 && spec.prerequisites.length===0,'initial facility needs explicit technology/construction provenance');
      world.facilities[fid]={id:fid,owner_id:id,type,hex_ids:[siteOrder[i].id],size:spec.hexes,capacity:spec.capacity,condition:config.dynamics.conditionMaximum,
        prerequisites:[],construction_progress:spec.progress,required_progress:spec.progress,level:1,automation:true,captured_from:null};
      facilityByType[type]=world.facilities[fid];
    }
    const locations={Civilian:start.id,Farmer:facilityByType.agriculture.hex_ids[0],Builder:facilityByType.industrial.hex_ids[0],
      Scientist:facilityByType.research.hex_ids[0],Soldier:facilityByType.ground_military.hex_ids[0],Explorer:facilityByType.training.hex_ids[0]};
    const citizens=Object.entries(config.assignments).filter(([,g])=>g.starting>0).map(([assignment,g])=>({
      id:stableId('citizens',runId,id,assignment),assignment,count:g.starting,hex_id:locations[assignment],
      territory_id:world.hexes[locations[assignment]].territory_id,training:null,embarked_on:null,mortality_progress:0
    })).sort((a,b)=>a.id.localeCompare(b.id));
    world.polities[id]={id,name:null,territory:[territoryId],capital_hex_id:start.id,population:config.population.starting,citizens,
      food:config.economy.startingFood+profile.foodBonus,credits:config.economy.startingCredits+profile.creditBonus,resources:clone(profile.resources),
      units:[],technologies:[],projects:[],knowledge:[id],facts:{hexes:{},territories:{},units:{},facilities:{},polities:{},deposits:{},unaffiliated_population:{},neutral_units:{}},
      messages:[],reports:[],memory:[],alive:true,shortage:0,growth_progress:0,takeover:null,advantages:clone(profile.advantages),disadvantages:clone(profile.disadvantages)};
  }
  for(const p of sortedActors(world))observeWorld(world,p.id);
  const startValidation=validateWorldStarts(world);assertWorldState(world);
  for(const p of sortedActors(world))assert(p.knowledge.length===1,'starting placement reveals another polity');
  const initialStateRef=evidence.putPayload(authoritativeState(world),'authoritative_research');
  evidence.append({eventType:'RunCreated',turn:0,phase:'setup',participants:Object.keys(world.polities),payload:{
    run_id:runId,config_hash:sha256(config),configuration_ref:evidence.putPayload(world.config,'configuration'),
    parameter_registry_ref:evidence.putPayload(parameterRegistry(world.config),'parameter_registry'),initial_state_ref:initialStateRef,
    engine_version:'pilot-0.2',world_mechanics_version:'world-v2',seed,start_validation_ref:evidence.putPayload(startValidation,'nonempirical_world_constraints')
  }});
  // Generation draws are canonical after RunCreated so existing replay can discover genesis.
  world.rng.flush();return world;
}

/** Restore a branch genesis from its content-addressed authoritative state.
 * A branch intentionally inherits parent-derived entity identifiers, so it
 * cannot be regenerated by running the root-world map generator with the new
 * branch run_id. The archived state is an input boundary; all later turns are
 * still independently reduced and compared event-for-event during replay. */
export function makeBranchWorld({runId,seed,config,initialState,parentState,genesis,evidence=new EvidenceStore(runId)}={}) {
  validateConfiguration(config);assert(evidence.runId===runId,'world evidence run mismatch');
  assert(genesis?.parent_run_id && genesis.parent_state_hash && genesis.parent_state_ref && genesis.parent_event_head,'branch genesis requires authenticated parent lineage');
  assert(parentState?.run_id===genesis.parent_run_id&&sha256(parentState)===genesis.parent_state_hash,'branch parent state binding mismatch');
  assert(sha256({...clone(parentState),run_id:runId})===sha256(initialState),'branch initial state differs from bound parent state');
  assert(initialState?.run_id===runId && initialState.seed===seed && sha256(initialState.config)===sha256(config),'branch initial state/config mismatch');
  const world=bind({runId,seed,config:clone(config),turn:initialState.turn,phase:initialState.phase,
    polities:clone(initialState.polities),hexes:clone(initialState.hexes),territories:clone(initialState.territories),
    facilities:clone(initialState.facilities),channels:clone(initialState.channels),
    unaffiliatedPopulation:clone(initialState.unaffiliated_population??[]),neutralUnits:clone(initialState.neutral_units??[]),evidence,
    rng:new WorldRng(seed,evidence,{deferred:true}),actionTypes:clone(ACTION_TYPES),lastTurnCommit:null,snapshots:[],
    committedRecords:new Map(),resolvedCommits:new Set(),terminal:initialState.terminal,
    terminationReason:initialState.termination_reason??null});
  assertWorldState(world);
  assert(evidence.putPayload(config,'configuration')===genesis.configuration_ref &&
    evidence.putPayload(initialState,'authoritative_research')===genesis.initial_state_ref &&
    evidence.putPayload(parentState,'authoritative_parent_state')===genesis.parent_state_ref &&
    evidence.putPayload(parameterRegistry(config),'parameter_registry')===genesis.parameter_registry_ref,
  'branch genesis content references mismatch');
  const payload=clone(genesis);delete payload.payload_ref;
  evidence.append({eventType:'RunCreated',turn:initialState.turn,phase:'branch',payload});
  return world;
}

function stagingWorld(world) {
  const evidence=new EvidenceStore(world.runId);evidence.events=clone(world.evidence.events);evidence.payloads=new Map(world.evidence.payloads);
  evidence.previousHash=world.evidence.previousHash;evidence.signingSecret=world.evidence.signingSecret;
  const stage=bind({...world,config:clone(world.config),polities:clone(world.polities),hexes:clone(world.hexes),territories:clone(world.territories),
    facilities:clone(world.facilities),channels:clone(world.channels),unaffiliatedPopulation:clone(world.unaffiliatedPopulation),
    neutralUnits:clone(world.neutralUnits),snapshots:clone(world.snapshots),evidence,rng:new WorldRng(world.seed,evidence),
    committedRecords:new Map(world.committedRecords),resolvedCommits:new Set(world.resolvedCommits)});
  stage.rng.draws=new Map([...world.rng.draws].map(([id,r])=>[id,clone(r)]));stage.rng.eventRefs=new Map(world.rng.eventRefs);
  return stage;
}
export function resolveTurn(world,committed,{fault=()=>{}}={}) {
  assert(committed?.immutable_after_commit,'cannot resolve mutable turn');
  const sealed=world.committedRecords?.get(committed.turn_committed_id);
  assert(sealed && sha256(sealed)===sha256(committed),'commit is not the sealed canonical record');
  assert(committed.run_id===world.runId && committed.turn===world.turn,'commit does not match current run/turn');
  assert(committed.input_state_hash===world.stateHash(),'stale commit input state');
  assert(committed.configuration_hash===sha256(world.config),'committed configuration mismatch');
  assert(!world.resolvedCommits.has(committed.turn_committed_id),'turn already resolved');
  assert(world.turn<world.config.maxTurns && !world.terminal,'pilot 0 turn cap reached');
  // Evidence, draws and all state effects are staged together. A thrown validation leaves
  // the live world and canonical append head exactly at the committed boundary.
  fault('before_resolution',{turn:world.turn,turn_committed_id:committed.turn_committed_id});
  const stage=stagingWorld(world),append=stage.evidence.append.bind(stage.evidence);
  stage.evidence.append=event=>{
    fault('before_event',{event_type:event.eventType,turn:event.turn});
    const result=append(event);fault('after_event',{event_type:event.eventType,event_id:result.event_id,turn:event.turn});return result;
  };
  stage.lastTurnCommit=clone(committed);resolveApparatus(stage,committed);assertWorldState(stage);
  const resolvedTurn=stage.turn;
  if(resolvedTurn+1>=stage.config.maxTurns) {
    stage.terminal=true;stage.terminationReason='pilot_cap';
  }
  stage.turn=resolvedTurn+1;stage.phase='actions';
  const state=authoritativeState(stage),stateRef=stage.evidence.putPayload(state,'authoritative_research');
  const snapshot=stage.evidence.append({eventType:'SnapshotCreated',turn:resolvedTurn,phase:'archive',payload:{run_id:stage.runId,turn:resolvedTurn,state_ref:stateRef,state_hash:sha256(state),authoritative:true}});
  stage.evidence.append({eventType:'TurnResolved',turn:resolvedTurn,phase:'resolve',causality:{causation_ids:[committed.commit_event_id,snapshot.event_id]},payload:{turn_committed_id:committed.turn_committed_id,resulting_state_hash:sha256(state),authoritative_state_ref:stateRef,published_turn:stage.turn,published_phase:stage.phase}});
  stage.snapshots.push({turn:resolvedTurn,state,state_hash:sha256(state)});stage.resolvedCommits.add(committed.turn_committed_id);
  if(stage.terminal) {
    stage.evidence.append({eventType:'RunDisposition',turn:resolvedTurn,phase:'archive',payload:{schema_version:'1.0.0',run_id:stage.runId,execution_status:'complete',
      evidence_validity:{canonical_record_accurate:true},experimental_validity:{confirmatory_eligible:false},endpoint_eligibility:{primary_confirmatory:false},
      security_eligibility:{security_analysis_eligible:true},exploratory_only:true,replacement_policy:{reason:'pilot_cap'},evidence_completeness:{status:'complete'}}});
  }
  fault('before_publish',{turn:world.turn,state_hash:stage.stateHash(),event_head:stage.evidence.previousHash});
  const evidence=world.evidence;evidence.events=stage.evidence.events;evidence.payloads=stage.evidence.payloads;evidence.previousHash=stage.evidence.previousHash;
  Object.assign(world,stage,{evidence});world.rng.worldEvidence=evidence;bind(world);
  fault('after_publish',{turn:world.turn,state_hash:world.stateHash(),event_head:evidence.previousHash});return world;
}
export function cloneWorld(world,{branchRunId=`${world.runId}:branch:${stableId('branch',world.turn,world.stateHash())}`}={}) {
  const parentState=authoritativeState(world),parentStateHash=sha256(parentState),parentEventHead=world.evidence.previousHash;
  const branch=stagingWorld(world);branch.runId=branchRunId;branch.evidence=new EvidenceStore(branchRunId);branch.rng=new WorldRng(world.seed,branch.evidence);
  branch.committedRecords=new Map();branch.resolvedCommits=new Set();bind(branch);
  branch.evidence.append({eventType:'RunCreated',turn:branch.turn,phase:'branch',payload:{run_id:branchRunId,parent_run_id:world.runId,parent_state_hash:parentStateHash,parent_state_ref:branch.evidence.putPayload(parentState,'authoritative_parent_state'),parent_event_head:parentEventHead,
    config_hash:sha256(world.config),configuration_ref:branch.evidence.putPayload(branch.config),initial_state_ref:branch.evidence.putPayload(authoritativeState(branch)),
    parameter_registry_ref:branch.evidence.putPayload(parameterRegistry(branch.config)),engine_version:'pilot-0.2',world_mechanics_version:'world-v2',seed:world.seed}});
  return branch;
}
