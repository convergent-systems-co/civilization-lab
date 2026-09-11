import { assert, clone, sha256, stableId } from './core.js';
import { sortedActors, sortedValues, hexDistance, territoryHexes, recordFact, recordFacilityDestruction, observeWorld, discoverPolity } from './world-map.js';
import { planAction, conflictComponents, populationTotal, unitById, activeFacility, facilityPermitted, hasTech, embarkationPath, embarkedCargo } from './world-actions.js';
import { mulDiv } from './world-numeric.js';

const ref=(w,value)=>w.evidence.putPayload(value,'world_mechanic_input');
function transition(w,mechanic,before,after,actions=[],actors=[],detail={},causalEventIds=[]) {
  const beforeRef=ref(w,before),afterRef=ref(w,after);
  return w.evidence.append({eventType:'WorldTransition',turn:w.turn,phase:'resolve',participants:actors,causality:{causation_ids:[...(w.lastTurnCommit?[w.lastTurnCommit.commit_event_id]:[]),...causalEventIds]},provenance:{input_refs:[beforeRef,ref(w,w.config),...(detail.input_refs??[])]},payload:{schema_version:'1.0.0',run_id:w.runId,mechanic,action_ids:actions,actor_ids:actors,before_state_ref:beforeRef,after_state_ref:afterRef,detail:{mechanic_version:'world-v2',...detail}}});
}
function populationEvent(w,before,after,kind,inputs=[],causalEventIds=[],participants=[after.id]) {
  const eventId=w.evidence.nextEventId();
  return w.evidence.append({eventType:'PopulationUnitTransition',turn:w.turn,phase:'resolve',participants:[...new Set(participants)].sort(),causality:{causation_ids:[...(w.lastTurnCommit?[w.lastTurnCommit.commit_event_id]:[]),...causalEventIds]},payload:{schema_version:'1.0.0',transition_id:stableId('population-transition',eventId),run_id:w.runId,turn:w.turn,transition:kind,population_before_ref:ref(w,{citizens:before.citizens,population:before.population}),population_after_ref:ref(w,{citizens:after.citizens,population:after.population}),unit_before_refs:before.units.map(u=>ref(w,u)),unit_after_refs:after.units.map(u=>ref(w,u)),resource_input_refs:inputs,canonical_event_ref:eventId}});
}
function estatePopulationEvent(w,actorId,before,kind,inputs=[]) {
  const eventId=w.evidence.nextEventId(),afterPopulation=w.unaffiliatedPopulation.filter(g=>g.former_polity_id===actorId),afterUnits=w.neutralUnits.filter(u=>u.former_polity_id===actorId);
  return w.evidence.append({eventType:'PopulationUnitTransition',turn:w.turn,phase:'resolve',participants:[actorId],causality:{causation_ids:w.lastTurnCommit?[w.lastTurnCommit.commit_event_id]:[]},payload:{schema_version:'1.0.0',transition_id:stableId('population-transition',eventId),run_id:w.runId,turn:w.turn,transition:kind,population_before_ref:ref(w,{citizens:before.citizens,population:before.population}),population_after_ref:ref(w,{affiliation_status:'unaffiliated',citizens:afterPopulation,population:afterPopulation.reduce((n,g)=>n+g.count,0)}),unit_before_refs:before.units.map(u=>ref(w,u)),unit_after_refs:afterUnits.map(u=>ref(w,u)),resource_input_refs:inputs,canonical_event_ref:eventId}});
}
function draw(w,id,purpose,subsystem,inputRefs=[]) {
  const value=w.rng.draw({runId:w.runId,turnId:w.turn,phase:'resolve',subsystem,eventOrActionId:id,purpose,streamNamespace:'world',drawOrdinal:0,inputRefs});
  return {value,eventRef:w.rng.lastEventRef};
}
function deduct(p,cost) {p.credits-=cost.credits;p.food-=cost.food??0;for(const [k,n]of Object.entries(cost.resources))p.resources[k]-=n;}
function syncPopulation(p) {p.citizens=p.citizens.filter(g=>g.count>0).sort((a,b)=>a.id.localeCompare(b.id));p.population=populationTotal(p);p.units.sort((a,b)=>a.id.localeCompare(b.id));}
function addCitizens(p,group) {p.citizens.push(group);syncPopulation(p);}
function mechanicState(w) {return {polities:clone(w.polities),hexes:clone(w.hexes),territories:clone(w.territories),facilities:clone(w.facilities),channels:clone(w.channels),unaffiliated_population:clone(w.unaffiliatedPopulation),neutral_units:clone(w.neutralUnits)};}
function reservePlans(pre,plans) {
  const invalid=new Set(),reservations=new Map();
  for(const plan of plans)for(const r of plan.reservations){const group=reservations.get(r.key)??[];group.push({plan,...r});reservations.set(r.key,group);}
  for(const group of reservations.values())if(group.reduce((n,r)=>n+r.count,0)>Math.min(...group.map(r=>r.capacity)))for(const r of group)invalid.add(r.plan.action.action_id);
  for(const p of sortedActors(pre)){
    const orders=plans.filter(x=>x.actorId===p.id),total={credits:0,food:0,resources:{}};
    for(const o of orders){total.credits+=o.cost.credits;total.food+=o.cost.food;for(const [k,n]of Object.entries(o.cost.resources))total.resources[k]=(total.resources[k]??0)+n;}
    if(total.credits>p.credits || total.food>p.food || Object.entries(total.resources).some(([k,n])=>n>(p.resources[k]??0)))for(const o of orders)if(o.cost.credits || o.cost.food || Object.values(o.cost.resources).some(Boolean))invalid.add(o.action.action_id);
  }
  // Duplicate simultaneous self-names all fail. No identity-based winner.
  const names=new Map();for(const o of plans.filter(o=>o.action.type==='name')){const key=o.action.name.normalize('NFKC').trim().toLocaleLowerCase('en-US');const g=names.get(key)??[];g.push(o);names.set(key,g);}
  for(const [key,group]of names)if(group.length>1 || sortedActors(pre).some(p=>p.name?.normalize('NFKC').trim().toLocaleLowerCase('en-US')===key))for(const o of group)invalid.add(o.action.action_id);
  return invalid;
}

function resolveLocal(w,pre,plan) {
  const a=plan.action,p=w.polities[plan.actorId],old=pre.polities[plan.actorId],c=w.config,d=c.dynamics;
  const before=clone(p),facilityBefore=a.facility_id?clone(w.facilities[a.facility_id]??null):null;
  const unit=p.units.find(u=>u.id===a.unit_id),group=p.citizens.find(g=>g.id===a.citizen_id);
  if(a.type==='demobilize' && !unit)return transition(w,'demobilization_unavailable',before,before,[a.action_id],[p.id],{unit_id:a.unit_id,reason:'no_surviving_unit'});
  const workerCount=(plan.workers??[]).reduce((n,g)=>n+g.count,0);
  const busyWorkers=new Set(old.projects.flatMap(j=>j.worker_ids??[]));
  if((plan.workers??[]).some(g=>busyWorkers.has(g.id)) || group && busyWorkers.has(group.id))return transition(w,'action_unavailable',before,before,[a.action_id],[p.id],{reason:'dedicated_population'});
  deduct(p,plan.cost);
  switch(a.type){
    case 'name':p.name=a.name.normalize('NFKC').trim();break;
    case 'move':case 'move_population':case 'explore':{
      const entity=a.type==='move'?unit:group,domain=a.type==='move'?c.unitTypes[entity.type].domain:'land';
      // Unknown exploration attempts can reveal an obstruction without consuming people.
      const blocked=domain==='land' && w.hexes[a.hex_id].terrain==='water';
      if(!blocked){entity.hex_id=a.hex_id;entity.territory_id=w.hexes[a.hex_id].territory_id;if(unit)unit.fortified=false;}
      if(plan.unknownStep)recordFact(p,'hexes',a.hex_id,((h)=>({id:h.id,q:h.q,r:h.r,terrain:h.terrain,coast:h.coast,territory_id:h.territory_id}))(w.hexes[a.hex_id]),w.turn,'exploration');
      if(unit){const cargo=embarkedCargo(p,unit.id);assert(cargo,'invalid embarked relationship');for(const entity of [...cargo.units,...cargo.citizens]){entity.hex_id=unit.hex_id;entity.territory_id=unit.territory_id;}}
      break;
    }
    case 'fortify':unit.fortified=true;break;
    case 'recruit':{
      const spec=c.unitTypes[plan.unit_type],source=[];
      for(const worker of plan.workers){const g=p.citizens.find(g=>g.id===worker.id);source.push({...clone(g),id:stableId('unit-crew',w.runId,a.action_id,g.id),source_citizen_group_id:g.id,count:worker.count});g.count-=worker.count;}
      p.units.push({id:stableId('unit',w.runId,w.turn,a.action_id),type:plan.unit_type,hex_id:plan.spawn,territory_id:w.hexes[plan.spawn].territory_id,health:spec.health,strength:spec.attack,fortified:false,embarked_on:null,crew:source,prerequisites:clone(spec.prerequisites),captured_from:null});
      syncPopulation(p);populationEvent(w,before,p,'recruitment',[ref(w,plan.cost),ref(w,source),ref(w,spec)]);break;
    }
    case 'demobilize':{
      p.units=p.units.filter(u=>u.id!==unit.id);
      for(const [i,g]of unit.crew.entries())addCitizens(p,{...clone(g),id:stableId('citizens',a.action_id,i),hex_id:unit.hex_id,territory_id:unit.territory_id,embarked_on:null});
      populationEvent(w,before,p,'demobilization',[ref(w,unit)]);populationEvent(w,before,p,'return_to_population',[ref(w,unit.crew)]);break;
    }
    case 'reassign':case 'train':{
      const spec=c.assignments[a.assignment];group.count-=a.count;
      addCitizens(p,{...clone(group),id:stableId('training-group',w.runId,a.action_id),count:a.count,training:{assignment:a.assignment,remaining:spec.turns,facility_id:plan.facility_id,started_turn:w.turn}});break;
    }
    case 'build':{
      const spec=c.facilityTypes[a.facility_type],id=stableId('facility',w.runId,a.action_id);
      w.facilities[id]={id,owner_id:p.id,type:a.facility_type,hex_ids:[...a.hex_ids].sort(),size:spec.hexes,capacity:spec.capacity,condition:d.conditionMaximum,prerequisites:clone(spec.prerequisites),construction_progress:Math.min(spec.progress,workerCount*d.constructionPerBuilder),required_progress:spec.progress,level:1,automation:true,captured_from:null};break;
    }
    case 'resume_construction':w.facilities[a.facility_id].construction_progress=Math.min(facilityBefore.required_progress,facilityBefore.construction_progress+workerCount*d.constructionPerBuilder);break;
    case 'upgrade':{
      const f=w.facilities[a.facility_id];f.level++;f.capacity+=c.facilityTypes[f.type].capacity;f.required_progress+=facilityBefore.capacity*d.upgradeProgressPerCapacity;break;
    }
    case 'repair':w.facilities[a.facility_id].condition=Math.min(d.conditionMaximum,facilityBefore.condition+workerCount*d.repairPerBuilder);break;
    case 'destroy':recordFacilityDestruction(p,w.facilities[a.facility_id],w.turn);delete w.facilities[a.facility_id];break;
    case 'research':case 'reverse_engineer':{
      const spec=c.technologies[a.technology];p.projects.push({id:stableId('project',w.runId,a.action_id),kind:a.type,technology:a.technology,remaining:spec.turns,progress:0,facility_id:plan.facility_id,worker_ids:plan.workers.map(g=>g.id),workers:clone(plan.workers),artifact_id:a.artifact_id??null,action_id:a.action_id,started_turn:w.turn});break;
    }
    case 'prospect':recordFact(p,'deposits',a.hex_id,clone(pre.hexes[a.hex_id].deposits),w.turn,'prospecting');break;
    case 'intelligence':p.projects.push({id:stableId('intelligence',w.runId,a.action_id),kind:'intelligence',to:a.to,remaining:d.intelligenceTurns,action_id:a.action_id,started_turn:w.turn});break;
    case 'transfer':{
      const target=w.polities[a.to];if(a.resource==='food' || a.resource==='credits')target[a.resource]+=a.amount;else target.resources[a.resource]+=a.amount;break;
    }
    case 'share_technology':w.polities[a.to].technologies=[...new Set([...w.polities[a.to].technologies,a.technology])].sort();break;
    case 'transfer_unit':{
      const recipient=w.polities[a.to],cargo=embarkedCargo(p,unit.id);assert(cargo,'invalid embarked relationship');
      assert(JSON.stringify(cargo.units.map(item=>item.id))===JSON.stringify(plan.cargo_unit_ids)&&JSON.stringify(cargo.citizens.map(item=>item.id))===JSON.stringify(plan.cargo_citizen_ids),'committed carrier cargo changed');
      const units=[unit,...cargo.units],citizens=cargo.citizens;
      p.units=p.units.filter(u=>!units.includes(u));p.citizens=p.citizens.filter(g=>!citizens.includes(g));
      for(const e of [...units,...citizens])e.transferred_turn=w.turn;
      recipient.units.push(...units);recipient.citizens.push(...citizens);syncPopulation(recipient);break;
    }
    case 'transfer_population':{
      const recipient=w.polities[a.to],transferred={...clone(group),id:stableId('transferred-citizens',w.runId,a.action_id),count:a.count,transferred_turn:w.turn};group.count-=a.count;addCitizens(recipient,transferred);break;
    }
    case 'transfer_facility':w.facilities[a.facility_id].owner_id=a.to;w.facilities[a.facility_id].transferred_turn=w.turn;break;
    case 'incorporate_population': {
      const estateBefore={unaffiliated_population:clone(w.unaffiliatedPopulation),polity:clone(p)};
      const orphan=w.unaffiliatedPopulation.find(g=>g.id===a.unaffiliated_population_id);assert(orphan&&a.count<=orphan.count,'committed unaffiliated population unavailable');
      const incorporated={...clone(orphan),id:a.count===orphan.count?orphan.id:stableId('incorporated-population',w.runId,a.action_id),count:a.count,affiliation_status:'affiliated',incorporated_by:p.id,incorporated_turn:w.turn};
      delete incorporated.former_polity_id;delete incorporated.unaffiliated_turn;
      orphan.count-=a.count;if(orphan.count===0)w.unaffiliatedPopulation=w.unaffiliatedPopulation.filter(g=>g.id!==orphan.id);
      addCitizens(p,incorporated);populationEvent(w,before,p,'incorporation',[ref(w,estateBefore.unaffiliated_population),ref(w,a)]);
      transition(w,'population_incorporation',estateBefore,{unaffiliated_population:clone(w.unaffiliatedPopulation),polity:clone(p)},[a.action_id],[p.id],{unaffiliated_population_id:a.unaffiliated_population_id,count:a.count,hex_id:incorporated.hex_id,input_refs:[ref(w,a)]});break;
    }
    case 'reactivate_unit': {
      const estateBefore={neutral_units:clone(w.neutralUnits),polity:clone(p)};
      const neutral=w.neutralUnits.find(u=>u.id===a.neutral_unit_id);assert(neutral,'committed neutral unit unavailable');
      const crew=[];for(const worker of plan.workers){const g=p.citizens.find(g=>g.id===worker.id);crew.push({...clone(g),id:stableId('reactivated-unit-crew',w.runId,a.action_id,g.id),source_citizen_group_id:g.id,count:worker.count});g.count-=worker.count;}
      w.neutralUnits=w.neutralUnits.filter(u=>u.id!==neutral.id);
      const active={...clone(neutral),crew,controller_id:p.id,status:'active',reactivated_turn:w.turn,reactivated_by:p.id,embarked_on:null};
      delete active.former_polity_id;delete active.neutralized_turn;p.units.push(active);syncPopulation(p);
      populationEvent(w,before,p,'reactivation',[ref(w,estateBefore.neutral_units),ref(w,crew),ref(w,a)]);
      transition(w,'neutral_unit_reactivation',estateBefore,{neutral_units:clone(w.neutralUnits),polity:clone(p)},[a.action_id],[p.id],{neutral_unit_id:a.neutral_unit_id,hex_id:active.hex_id,input_refs:[ref(w,a)]});break;
    }
    case 'acquire_facility': {
      const estateBefore={facility:clone(w.facilities[a.facility_id]),polity_id:p.id};
      w.facilities[a.facility_id].owner_id=p.id;w.facilities[a.facility_id].acquired_turn=w.turn;w.facilities[a.facility_id].acquired_by=p.id;
      transition(w,'facility_acquisition',estateBefore,{facility:clone(w.facilities[a.facility_id]),polity_id:p.id},[a.action_id],[p.id],{facility_id:a.facility_id,input_refs:[ref(w,a)]});break;
    }
    case 'embark':(unit??group).embarked_on=a.carrier_id;(unit??group).hex_id=old.units.find(u=>u.id===a.carrier_id).hex_id;(unit??group).territory_id=old.units.find(u=>u.id===a.carrier_id).territory_id;break;
    case 'disembark':(unit??group).embarked_on=null;(unit??group).hex_id=a.hex_id;(unit??group).territory_id=pre.hexes[a.hex_id].territory_id;break;
  }
  syncPopulation(p);
  // Every local action result is additionally covered by the atomic complete-world transition.
  if(!['wait','attack','claim','annex','abandon','exchange_territory','channel_create','channel_invite','channel_leave','message','promise','broadcast','reconnaissance','incorporate_population','reactivate_unit','acquire_facility'].includes(a.type))return transition(w,a.type,before,p,[a.action_id],[p.id,...(a.to?[a.to]:[])],{action_type:a.type,from:p.id,to:a.to??null,resource:a.resource??null,amount:a.amount??null,unit_id:a.unit_id??null,citizen_id:a.citizen_id??null,count:a.count??null,facility_id:a.facility_id??null,technology:a.technology??null,mechanical_outcome:'applied',input_refs:[ref(w,a),ref(w,plan.cost)],facility_before_ref:ref(w,facilityBefore),facility_after_ref:ref(w,a.facility_id?w.facilities[a.facility_id]??null:null)});
  return null;
}

function battles(w,pre,plans,commit,preRef,localEventRefs) {
  const attacks=plans.filter(p=>p.action.type==='attack'),damage=new Map(),contributors=new Map(),battleInputs=[];
  const d=w.config.dynamics,scale=d.numericScale;
  // All hit, retaliation, and retreat decisions read the committed force state.
  for(const plan of attacks){
    const a=plan.action,attacker=unitById(pre,a.unit_id),target=unitById(pre,a.target_unit_id);if(!attacker || !target)continue;
    const spec=w.config.unitTypes[attacker.unit.type],enemy=w.config.unitTypes[target.unit.type],terrain=pre.hexes[target.unit.hex_id];
    const types=new Set(attacks.filter(p=>p.action.target_unit_id===target.unit.id).map(p=>unitById(pre,p.action.unit_id).unit.type));
    const strength=mulDiv(spec.attack,scale+(types.size-1)*d.combinedArmsBonusPermille,scale);
    const defense=mulDiv(mulDiv(enemy.defense,w.config.geography.terrain[terrain.terrain].defensePermille,scale),target.unit.fortified?d.fortifyDefensePermille:scale,scale);
    const chance=Math.max(d.combatMinimumHitPermille,Math.min(d.combatMaximumHitPermille,mulDiv(strength,scale,Math.max(1,strength+defense))));
    const hit=draw(w,a.action_id,'attack_hit','combat',[preRef,ref(w,a)]),retaliate=draw(w,a.action_id,'retaliation_hit','combat',[preRef,ref(w,a)]);
    const canReturn=enemy.targets.includes(spec.domain) && hexDistance(pre.hexes[attacker.unit.hex_id],terrain)<=enemy.range;
    const attackDamage=Math.floor(hit.value*scale)<chance?d.combatDamage:0;
    const returnDamage=canReturn && Math.floor(retaliate.value*scale)<scale-chance?mulDiv(d.combatDamage,d.retaliationPermille,scale):0;
    damage.set(target.unit.id,(damage.get(target.unit.id)??0)+attackDamage);damage.set(attacker.unit.id,(damage.get(attacker.unit.id)??0)+returnDamage);
    const group=contributors.get(target.unit.id)??new Set();group.add(attacker.polity.id);contributors.set(target.unit.id,group);
    const embarkedPath=embarkationPath(target.polity,target.unit.id);assert(embarkedPath,'invalid attacked-unit embarkation chain');
    const transfers=plans.filter(p=>p.action.type==='transfer_unit'&&embarkedPath.includes(p.action.unit_id));assert(transfers.length<=1,'ambiguous attacked-unit carrier transfer');
    const transfer=transfers[0]??null,postTarget=unitById(w,target.unit.id);assert(postTarget,'attacked unit missing before combat');
    const postBearer=postTarget.polity.id,transferEventRef=transfer?localEventRefs.get(transfer.action.action_id)??null:null;
    if(transfer){assert(transferEventRef&&postBearer===transfer.action.to,'attacked-unit carrier transfer lacks canonical effect');}else assert(postBearer===target.polity.id,'attacked-unit ownership changed without canonical transfer');
    const bearerTransition=transfer?{pre_bearer:target.polity.id,post_bearer:postBearer,transfer_action_id:transfer.action.action_id,transfer_event_ref:transferEventRef,transferred_unit_id:transfer.action.unit_id,embarked_path:embarkedPath}:null;
    battleInputs.push({action:a,attacker:clone(attacker.unit),target:clone(target.unit),ownership:{attacker:attacker.polity.id,target_pre_owner:target.polity.id,target_post_bearer:postBearer},bearer_transition:bearerTransition,transfer_event_ref:transferEventRef,terrain:clone(terrain),defense,chance,attackDamage,returnDamage,rng:[hit.eventRef,retaliate.eventRef]});
  }
  const casualties=[],retreats=[],destroyed=new Set(),populationEventRefs=[],effectCausalRefs=new Map();
  for(const input of battleInputs)if(input.transfer_event_ref){const refs=effectCausalRefs.get(input.target.id)??new Set();refs.add(input.transfer_event_ref);effectCausalRefs.set(input.target.id,refs);}
  for(const [id,loss]of [...damage].sort(([a],[b])=>a.localeCompare(b))){
    const original=unitById(pre,id),current=unitById(w,id);if(!current)continue;
    const before=clone(current.polity);current.unit.health=Math.max(0,original.unit.health-loss);
    if(current.unit.health===0){const bearerTransition=clone(battleInputs.find(input=>input.target.id===id)?.bearer_transition??null),casualty={unit_id:id,damage:loss,crew:clone(original.unit.crew),pre_owner:original.polity.id,post_transfer_bearer:current.polity.id,bearer_transition:bearerTransition};destroyed.add(id);current.polity.units=current.polity.units.filter(u=>u.id!==id);casualties.push(casualty);populationEventRefs.push(populationEvent(w,before,current.polity,'destruction',[ref(w,original.unit),ref(w,casualty)],[...(effectCausalRefs.get(id)??[])],[original.polity.id,current.polity.id]).event_id);}
    else if(loss>0 && current.unit.health<=d.retreatHealth){
      const possible=sortedValues(pre.hexes).filter(h=>hexDistance(h,pre.hexes[original.unit.hex_id])===1 && pre.territories[h.territory_id].controller_id===original.polity.id && (w.config.unitTypes[original.unit.type].domain==='sea'?h.terrain==='water':h.terrain!=='water'));
      // No arbitrary retreat tie: a unique nearest friendly-capital destination only.
      const capital=pre.hexes[original.polity.capital_hex_id],distance=Math.min(...possible.map(h=>hexDistance(h,capital))),nearest=possible.filter(h=>hexDistance(h,capital)===distance);
      if(nearest.length===1){current.unit.hex_id=nearest[0].id;current.unit.territory_id=nearest[0].territory_id;retreats.push({unit_id:id,hex_id:nearest[0].id});}
    }
  }
  for(const p of sortedActors(w)){
    const lossCarrierByEntity=new Map(),lostByDestroyedCarrier=entity=>{const seen=new Set([entity.id]);let carrierId=entity.embarked_on;while(carrierId){if(seen.has(carrierId))assert(false,'cyclic embarked relationship during casualty resolution');seen.add(carrierId);if(destroyed.has(carrierId)){lossCarrierByEntity.set(entity.id,carrierId);return true;}const carrier=p.units.find(u=>u.id===carrierId);assert(carrier,'missing embarked carrier during casualty resolution');carrierId=carrier.embarked_on;}return false;};
    const before=clone(p),lostUnits=p.units.filter(u=>lostByDestroyedCarrier(u)),lostCitizens=p.citizens.filter(g=>lostByDestroyedCarrier(g));
    if(lostUnits.length || lostCitizens.length){const causal=[...new Set([...lostUnits,...lostCitizens].flatMap(e=>[...(effectCausalRefs.get(lossCarrierByEntity.get(e.id))??[])]))];p.units=p.units.filter(u=>!lostUnits.includes(u));p.citizens=p.citizens.filter(g=>!lostCitizens.includes(g));syncPopulation(p);populationEventRefs.push(populationEvent(w,before,p,'loss',[ref(w,{lostUnits,lostCitizens})],causal).event_id);}
    const roots=p.units.filter(unit=>!unit.embarked_on);for(const carrier of roots){const cargo=embarkedCargo(p,carrier.id);assert(cargo,'invalid embarked relationship after combat');for(const entity of [...cargo.units,...cargo.citizens]){entity.hex_id=carrier.hex_id;entity.territory_id=carrier.territory_id;}}
  }
  const battleControl={};
  for(const [targetId,actors]of contributors){
    if(!destroyed.has(targetId) || actors.size!==1)continue;
    const actor=[...actors][0],h=pre.hexes[unitById(pre,targetId).unit.hex_id];
    const surviving=sortedActors(w).flatMap(p=>p.units.filter(u=>u.territory_id===h.territory_id && !u.embarked_on).map(u=>({actor:p.id,unit:u})));
    if(surviving.length && surviving.every(s=>s.actor===actor))battleControl[h.territory_id]=actor;
  }
  if(attacks.length){
    const id=stableId('battle',commit.turn_committed_id,sha256(attacks.map(p=>p.action.action_id))),eventId=w.evidence.nextEventId();
    const transferEventRefs=[...new Set(battleInputs.map(b=>b.transfer_event_ref).filter(Boolean))].sort();
    const participants=[...new Set(battleInputs.flatMap(b=>[b.ownership.attacker,b.ownership.target_pre_owner,b.ownership.target_post_bearer]))].sort();
    w.evidence.append({eventType:'BattleResolved',turn:w.turn,phase:'resolve',participants,causality:{causation_ids:[commit.commit_event_id,...transferEventRefs,...populationEventRefs,...battleInputs.flatMap(b=>b.rng)]},payload:{schema_version:'1.0.0',battle_id:id,run_id:w.runId,turn_committed_ref:commit.turn_committed_id,pre_resolution_state_ref:preRef,participating_force_refs:[...new Set(battleInputs.flatMap(b=>[ref(w,b.attacker),ref(w,b.target)]))].sort(),terrain_ref:ref(w,battleInputs.map(b=>b.terrain)),supply_ref:ref(w,w.config.supply),defensive_state_ref:ref(w,battleInputs.map(b=>({target:b.target.id,defense:b.defense}))),declared_action_refs:attacks.map(p=>ref(w,p.action)),modifier_refs:[ref(w,w.config.unitTypes),ref(w,w.config.geography.terrain),ref(w,d)],rng_draw_refs:battleInputs.flatMap(b=>b.rng),resolution_function_version:'combined-arms-v2',outcome_ref:ref(w,{battleInputs,damage:Object.fromEntries(damage),casualties,retreats,control:battleControl,population_event_refs:populationEventRefs,transfer_event_refs:transferEventRefs}),canonical_event_refs:[...populationEventRefs,eventId]}});
  }
  return battleControl;
}

function setTerritory(w,id,{owner,controller=owner,reason,claims=[],contested=false}) {
  const t=w.territories[id],before=clone(t);
  Object.assign(t,{status:contested?'contested':controller?'controlled':'unclaimed',owner_id:owner,controller_id:controller,exclusive_claimant_id:owner,claim_refs:claims.sort(),contested_since_turn:contested?w.turn:null,contested_reason:contested?reason:null});
  const eventId=w.evidence.nextEventId();t.transition_event_refs=[eventId];
  w.evidence.append({eventType:'TerritoryTransition',turn:w.turn,phase:'resolve',participants:[before.owner_id,owner].filter(Boolean),causality:{causation_ids:[w.lastTurnCommit.commit_event_id]},provenance:{input_refs:[ref(w,before)]},payload:{...clone(t),transition:reason}});
}
function captureResidents(w,pre,territoryId,newOwner,actions) {
  if(!newOwner)return;
  const before=mechanicState(w),newPolity=w.polities[newOwner];
  for(const p of sortedActors(w))if(p.id!==newOwner){
    const residents=p.citizens.filter(g=>g.territory_id===territoryId && !g.embarked_on && g.transferred_turn!==w.turn);
    p.citizens=p.citizens.filter(g=>!residents.includes(g));for(const g of residents){g.captured_from=p.id;g.training=null;newPolity.citizens.push(g);}syncPopulation(p);
    // Only equipment still physically resident after the simultaneous action effects transfers.
    const units=p.units.filter(u=>u.territory_id===territoryId && !u.embarked_on && u.transferred_turn!==w.turn);
    const carrierIds=new Set(units.map(u=>u.id)),cargoUnits=p.units.filter(u=>carrierIds.has(u.embarked_on)),cargoCitizens=p.citizens.filter(g=>carrierIds.has(g.embarked_on));
    p.units=p.units.filter(u=>!units.includes(u) && !cargoUnits.includes(u));p.citizens=p.citizens.filter(g=>!cargoCitizens.includes(g));
    for(const u of [...units,...cargoUnits]){u.captured_from=p.id;newPolity.units.push(u);}for(const g of cargoCitizens){g.captured_from=p.id;newPolity.citizens.push(g);}syncPopulation(p);
  }
  for(const f of sortedValues(w.facilities))if(f.transferred_turn!==w.turn && f.hex_ids.some(id=>w.hexes[id].territory_id===territoryId)){
    const controllers=new Set(f.hex_ids.map(id=>w.territories[w.hexes[id].territory_id].controller_id));
    if(controllers.size===1 && controllers.has(newOwner)){if(f.owner_id!==newOwner)f.captured_from=f.owner_id;f.owner_id=newOwner;}
  }
  syncPopulation(newPolity);transition(w,'resident_and_equipment_capture',before,mechanicState(w),actions,[newOwner],{territory_id:territoryId,input_refs:[ref(w,pre.territories[territoryId])]});
}
function territories(w,pre,plans,battleControl) {
  const claims=new Map();
  for(const plan of plans.filter(p=>['claim','annex','abandon','exchange_territory'].includes(p.action.type))){const id=plan.action.territory_id,list=claims.get(id)??[];list.push(plan);claims.set(id,list);}
  for(const [id,list]of [...claims].sort(([a],[b])=>a.localeCompare(b))){
    const old=pre.territories[id],claimants=list.filter(p=>['claim','annex'].includes(p.action.type));
    const incumbentCombat=plans.some(p=>p.action.type==='attack' && p.actorId===old.owner_id && unitById(pre,p.action.unit_id)?.unit.territory_id===id);
    if(!claimants.length){const p=list[0];setTerritory(w,id,{owner:p.action.type==='exchange_territory'?p.action.to:null,reason:p.action.type,claims:list.map(p=>p.action.action_id)});if(p.action.to)captureResidents(w,pre,id,p.action.to,list.map(p=>p.action.action_id));continue;}
    const candidates=new Set([...claimants.map(p=>p.actorId),...(old.owner_id?[old.owner_id]:[])]),presence=new Map([...candidates].map(actor=>[actor,pre.polities[actor].citizens.filter(g=>g.territory_id===id && !g.embarked_on).reduce((n,g)=>n+g.count,0)]));
    const max=Math.max(...presence.values()),leaders=[...presence].filter(([,n])=>n===max).map(([id])=>id),winner=leaders.length===1?leaders[0]:null;
    const validWinner=winner && claimants.some(p=>p.actorId===winner) && (!incumbentCombat || battleControl[id]===winner);
    if(validWinner){setTerritory(w,id,{owner:winner,reason:old.owner_id?'capture':'claim',claims:list.map(p=>p.action.action_id)});if(old.owner_id!==winner)captureResidents(w,pre,id,winner,list.map(p=>p.action.action_id));}
    else if(winner && winner===old.owner_id && !incumbentCombat){transition(w,'claim_not_established',old,old,list.map(p=>p.action.action_id),[...candidates],{presence:Object.fromEntries(presence)});}
    else {
      const refs=list.map(p=>p.action.action_id);if(refs.length<2)refs.push(ref(w,{incumbent:old.owner_id,prior_claims:old.claim_refs,presence:Object.fromEntries(presence)}));
      setTerritory(w,id,{owner:null,controller:battleControl[id]??null,contested:true,reason:'unresolved_claims',claims:refs});
    }
  }
  for(const p of sortedActors(w))p.territory=sortedValues(w.territories).filter(t=>t.owner_id===p.id).map(t=>t.territory_id);
}

function communications(w,pre,plans) {
  const before=clone(w.channels),changes=plans.filter(p=>['channel_create','channel_invite','channel_leave'].includes(p.action.type));
  for(const plan of changes){const a=plan.action;if(a.type==='channel_create'){const id=stableId('channel',w.runId,a.action_id);w.channels[id]={id,members:[...new Set([plan.actorId,...a.members])].sort()};}}
  for(const channel of sortedValues(pre.channels)){
    const leave=new Set(changes.filter(p=>p.action.channel_id===channel.id && p.action.type==='channel_leave').map(p=>p.actorId)),join=changes.filter(p=>p.action.channel_id===channel.id && p.action.type==='channel_invite').map(p=>p.action.to);
    w.channels[channel.id].members=[...new Set([...channel.members,...join])].filter(id=>!leave.has(id)).sort();
  }
  for(const ch of sortedValues(w.channels))for(const member of ch.members)for(const id of ch.members)discoverPolity(w,w.polities[member],id,'channel_membership');
  if(changes.length)transition(w,'channels',before,w.channels,changes.map(p=>p.action.action_id),[...new Set(changes.map(p=>p.actorId))]);
  for(const plan of plans.filter(p=>['message','promise','broadcast'].includes(p.action.type))){
    const a=plan.action,recipients=a.type==='broadcast'?sortedActors(pre).filter(p=>p.alive).map(p=>p.id):a.channel_id?pre.channels[a.channel_id].members:[plan.actorId,a.to];
    const record={from:plan.actorId,to:a.to??null,channel_id:a.channel_id??null,text:a.text,action_id:a.action_id,run_id:w.runId,turn:w.turn,broadcast:a.type==='broadcast',participant_label:a.type==='promise'?'promise':null};
    // The label is the participant's choice of speech act, never a coded moral outcome.
    const event=w.evidence.append({eventType:'MessageSent',turn:w.turn,phase:'diplomacy',participants:[...new Set(recipients)],visibility:{acl_ref:a.type==='broadcast'?'active_polities':`participants:${[...new Set(recipients)].sort().join(',')}`},causality:{causation_ids:[w.lastTurnCommit.commit_event_id]},payload:record});
    for(const id of [...new Set(recipients)]){w.polities[id].messages.push({...clone(record),message_ref:ref(w,record)});discoverPolity(w,w.polities[id],plan.actorId,a.type==='broadcast'?'public_broadcast':'diplomacy');}
    assert(event.event_id,'message lacks canonical evidence');
  }
}

function completeProjects(w,pre) {
  const d=w.config.dynamics,scale=d.numericScale;
  for(const p of sortedActors(w)){
    const before=clone(p);
    for(const g of p.citizens.filter(g=>g.training && g.training.started_turn<w.turn)){
      const f=w.facilities[g.training.facility_id];
      if(!activeFacility(f) || !facilityPermitted(f,p.id,w.hexes,w.territories) || !f.hex_ids.includes(g.hex_id))continue;
      if(--g.training.remaining<=0){g.assignment=g.training.assignment;g.training=null;}
    }
    const finished=new Set();
    for(const j of p.projects.filter(j=>j.started_turn<w.turn)){
      if(j.kind==='intelligence'){
        if(--j.remaining>0)continue;
        const target=pre.polities[j.to],inputs=[ref(w,j),ref(w,{population:target.population,credits:target.credits,technologies:target.technologies,units:target.units.map(u=>u.type)})];
        const quality=draw(w,j.id,'collection_quality','intelligence',inputs),detection=draw(w,j.id,'detection','intelligence',inputs),attribution=draw(w,j.id,'attribution','intelligence',inputs);
        const q=Math.floor(quality.value*scale);let report;
        if(q<d.intelligenceAccuratePermille)report={population:target.population,credits:target.credits,technologies:clone(target.technologies)};
        else if(q<d.intelligenceAccuratePermille+d.intelligenceIncompletePermille)report={population:target.population};
        else {const error=draw(w,j.id,'estimate_error','intelligence',inputs);report={population:mulDiv(target.population,d.intelligenceErrorMinimumPermille+Math.floor(error.value*d.intelligenceErrorSpreadPermille),scale)};}
        p.reports.push({turn:w.turn,to:j.to,report,source:'intelligence'});
        if(Math.floor(detection.value*scale)<d.intelligenceDetectionPermille){const attributed=Math.floor(attribution.value*scale)<d.intelligenceAttributionPermille;w.polities[j.to].reports.push({turn:w.turn,source:'activity_detection',actor_id:attributed?p.id:null});if(attributed)discoverPolity(w,w.polities[j.to],p.id,'attributed_intelligence');}
        finished.add(j.id);continue;
      }
      const f=w.facilities[j.facility_id],spec=w.config.technologies[j.technology];
      if(!activeFacility(f) || !facilityPermitted(f,p.id,w.hexes,w.territories) || !hasTech(p,spec.prerequisites) || !j.workers.every(worker=>p.citizens.some(g=>g.id===worker.id && g.count>=worker.count && g.assignment==='Scientist' && f.hex_ids.includes(g.hex_id))))continue;
      if(--j.remaining>0)continue;
      const result=draw(w,j.id,'research_success','research',[ref(w,j),ref(w,spec)]);
      if(Math.floor(result.value*scale)<spec.successPermille){j.progress+=d.researchProgress;p.technologies=[...new Set([...p.technologies,j.technology])].sort();}
      finished.add(j.id);
      transition(w,j.kind+'_outcome',before,p,[j.action_id],[p.id],{progress:j.progress,rng_draw_refs:[result.eventRef],sunk_cost:true});
    }
    p.projects=p.projects.filter(j=>!finished.has(j.id));if(sha256(before)!==sha256(p))transition(w,'population_training_and_projects',before,p,[],[p.id]);
  }
}

function economy(w) {
  const c=w.config,d=c.dynamics,scale=d.numericScale;
  // This fixed end-of-turn tick reads one settled action-state for every polity.
  const input=mechanicState(w),production=new Map();
  for(const p of sortedActors(input)){
    if(!p.alive)continue;
    let food=0,credits=0;const resources={},deposits={},farmers=new Map();
    for(const g of p.citizens){
      const h=input.hexes[g.hex_id],t=input.territories[h.territory_id];if(g.embarked_on || g.training || t.status==='contested' || t.owner_id!==p.id || t.controller_id!==p.id)continue;
      if(g.assignment!=='Civilian')credits+=g.count*d.creditPerProductiveCitizen;
      if(g.assignment==='Farmer'){
        const tech=p.technologies.reduce((n,t)=>n+(c.technologies[t].foodBonus??0),0);
        food+=g.count*c.economy.foodProductionPerFarmer*c.geography.terrain[h.terrain].fertility+g.count*tech;
        farmers.set(h.id,(farmers.get(h.id)??0)+g.count);
      }
    }
    for(const f of sortedValues(input.facilities).filter(f=>activeFacility(f) && hasTech(p,f.prerequisites) && facilityPermitted(f,p.id,input.hexes,input.territories) && f.hex_ids.every(id=>input.territories[input.hexes[id].territory_id].owner_id===p.id && input.territories[input.hexes[id].territory_id].controller_id===p.id))){
      if(f.type==='agriculture'){
        const count=f.hex_ids.reduce((n,id)=>n+(farmers.get(id)??0),0),capacity=mulDiv(f.capacity,f.condition,d.conditionMaximum);
        food+=Math.min(count,capacity)*d.agricultureFoodBonus;
      }
      if(f.type==='extraction')for(const id of f.hex_ids)for(const [type,amount]of Object.entries(input.hexes[id].deposits)){
        if(!p.facts.deposits[id]?.value[type])continue;
        const n=Math.min(amount,mulDiv(f.capacity*d.extractionPerCapacity,f.condition,d.conditionMaximum));resources[type]=(resources[type]??0)+n;deposits[id]??={};deposits[id][type]=n;
      }
      if(f.type==='refining' || f.type==='industrial')credits+=mulDiv(f.capacity,f.condition,d.conditionMaximum);
    }
    production.set(p.id,{food,credits,resources,deposits});
  }
  for(const p of sortedActors(w)){
    if(!p.alive)continue;
    const before=clone(p),out=production.get(p.id),crew=p.units.reduce((n,u)=>n+u.crew.reduce((m,g)=>m+g.count,0),0),need=(p.population+crew)*c.economy.foodPerCitizen,available=p.food+out.food,deficit=Math.max(0,need-available);
    p.food=Math.max(0,available-need);p.credits+=out.credits;
    for(const [type,n]of Object.entries(out.resources))p.resources[type]+=n;
    for(const [id,types]of Object.entries(out.deposits))for(const [type,n]of Object.entries(types)){w.hexes[id].deposits[type]-=n;recordFact(p,'deposits',id,w.hexes[id].deposits,w.turn,'extraction');}
    p.shortage=deficit>0?Math.min(d.maximumShortage,p.shortage+1):Math.max(0,p.shortage-d.shortageRecovery);
    if(deficit){
      const mortality=Math.min(scale,mulDiv(mulDiv(deficit,scale,Math.max(1,need)),p.shortage*d.shortageMortalityPermille,scale));
      for(const g of p.citizens){g.mortality_progress=(g.mortality_progress??0)+mulDiv(g.count,mortality,1);const deaths=Math.min(g.count,Math.floor(g.mortality_progress/scale));g.count-=deaths;g.mortality_progress%=scale;}
      for(const u of p.units)for(const g of u.crew){g.mortality_progress=(g.mortality_progress??0)+mulDiv(g.count,mortality,1);const deaths=Math.min(g.count,Math.floor(g.mortality_progress/scale));g.count-=deaths;g.mortality_progress%=scale;}
      const emptyCarriers=new Set(p.units.filter(u=>!u.crew.some(g=>g.count>0)).map(u=>u.id));
      p.units=p.units.filter(u=>u.crew.some(g=>g.count>0) && !emptyCarriers.has(u.embarked_on));
      p.citizens=p.citizens.filter(g=>!emptyCarriers.has(g.embarked_on));
    }
    if(!p.shortage && p.food>=p.population*c.economy.foodPerCitizen*d.growthFoodReserve){
      const civilians=p.citizens.filter(g=>g.assignment==='Civilian' && !g.training && !g.embarked_on),count=civilians.reduce((n,g)=>n+g.count,0);p.growth_progress+=count*d.growthPermille;
      const births=Math.floor(p.growth_progress/scale);p.growth_progress%=scale;
      if(births && civilians.length)addCitizens(p,{id:stableId('births',w.runId,w.turn,p.id),assignment:'Civilian',count:births,hex_id:p.capital_hex_id,territory_id:w.hexes[p.capital_hex_id].territory_id,training:null,embarked_on:null,mortality_progress:0});
    }
    syncPopulation(p);populationEvent(w,before,p,'consumption',[ref(w,{need,available,deficit,production:out})]);
    if(p.population<before.population || p.units.length<before.units.length)populationEvent(w,before,p,'death',[ref(w,{shortage:p.shortage,deficit})]);
    if(p.population>before.population)populationEvent(w,before,p,'growth',[ref(w,{growthPermille:d.growthPermille})]);
    transition(w,'economy',before,p,[],[p.id],{input_refs:[ref(w,input)],production:out,consumption:need,deficit});
  }
}

function disposeNoBeneficiaryEstate(w,input,memberIds,reason) {
  const members=[...memberIds].sort(),memberSet=new Set(members),assetEventIds=[];
  const estateBefore={polities:Object.fromEntries(members.map(id=>[id,clone(w.polities[id])])),territories:{},facilities:{},unaffiliated_population:clone(w.unaffiliatedPopulation),neutral_units:clone(w.neutralUnits)};
  for(const territory of sortedValues(w.territories).filter(t=>memberSet.has(t.owner_id))){
    estateBefore.territories[territory.territory_id]=clone(territory);
    const survivingController=territory.controller_id && !memberSet.has(territory.controller_id) && w.polities[territory.controller_id]?.alive?territory.controller_id:null;
    setTerritory(w,territory.territory_id,{owner:null,controller:survivingController,reason:reason==='closed_conquest_cycle'?'cyclic_conquest_estate_unclaimed':'no_successor_estate_unclaimed'});
    assetEventIds.push(...territory.transition_event_refs);
  }
  for(const facility of sortedValues(w.facilities).filter(f=>memberSet.has(f.owner_id))){
    const before=clone(facility);estateBefore.facilities[facility.id]=before;facility.owner_id=null;facility.unclaimed_turn=w.turn;facility.former_owner_id=before.owner_id;
    assetEventIds.push(transition(w,'facility_unclaimed',before,facility,[],[before.owner_id],{reason}).event_id);
  }
  for(const id of members){
    const p=w.polities[id],before=clone(p),populationBefore={citizens:clone(p.citizens),population:p.population},unitsBefore=clone(p.units);
    for(const group of p.citizens)w.unaffiliatedPopulation.push({...clone(group),affiliation_status:'unaffiliated',former_polity_id:id,unaffiliated_turn:w.turn,embarked_on:null});
    for(const unit of p.units){
      for(const group of unit.crew)w.unaffiliatedPopulation.push({...clone(group),hex_id:unit.hex_id,territory_id:unit.territory_id,affiliation_status:'unaffiliated',former_polity_id:id,unaffiliated_turn:w.turn,embarked_on:null});
      w.neutralUnits.push({...clone(unit),crew:[],controller_id:null,former_polity_id:id,status:'inactive_neutral',neutralized_turn:w.turn,embarked_on:unit.embarked_on&&p.units.some(u=>u.id===unit.embarked_on)?unit.embarked_on:null});
    }
    w.unaffiliatedPopulation.sort((a,b)=>a.id.localeCompare(b.id));w.neutralUnits.sort((a,b)=>a.id.localeCompare(b.id));
    const abstractBalances={food:p.food,credits:p.credits,resources:clone(p.resources),projects:clone(p.projects)};
    const territoryIds=Object.values(estateBefore.territories).filter(t=>t.owner_id===id).map(t=>t.territory_id).sort();
    const territorySet=new Set(territoryIds),physicalResources=Object.fromEntries(sortedValues(w.hexes).filter(h=>territorySet.has(h.territory_id)).map(h=>[h.id,clone(h.deposits)]));
    const physicalResourceHexIds=Object.keys(physicalResources).sort();
    p.citizens=[];p.units=[];p.population=0;p.food=0;p.credits=0;p.resources=Object.fromEntries(Object.keys(p.resources).sort().map(k=>[k,0]));p.projects=[];p.territory=[];
    const estateInput={...before,citizens:populationBefore.citizens,population:populationBefore.population,units:unitsBefore};
    assetEventIds.push(estatePopulationEvent(w,id,estateInput,'estate_disposition',[ref(w,abstractBalances),ref(w,unitsBefore)]).event_id);
    assetEventIds.push(transition(w,'resource_extinguishment',{abstract:abstractBalances,physically_located:physicalResources},{abstract:{food:0,credits:0,resources:clone(p.resources),projects:[]},physically_located:physicalResources},[],[id],{reason,former_owner_id:id,territory_ids:territoryIds,physical_resource_hex_ids:physicalResourceHexIds,physical_resources_remain_at_location:true}).event_id);
  }
  const estateAfter={polities:Object.fromEntries(members.map(id=>[id,clone(w.polities[id])])),territories:Object.fromEntries(Object.keys(estateBefore.territories).map(id=>[id,clone(w.territories[id])])),facilities:Object.fromEntries(Object.keys(estateBefore.facilities).map(id=>[id,clone(w.facilities[id])])),unaffiliated_population:clone(w.unaffiliatedPopulation),neutral_units:clone(w.neutralUnits)};
  return {members,estateBefore,estateAfter,assetEventIds:[...assetEventIds].sort()};
}

function takeover(w) {
  // Freeze every eligibility decision before any conquest changes another capital.
  const input=mechanicState(w),decisions=new Map();
  for(const p of sortedActors(input).filter(p=>p.alive)){
    const territoryId=w.hexes[p.capital_hex_id].territory_id,t=input.territories[territoryId];
    const controller=t.status==='controlled'?t.controller_id:null;
    const next=controller && controller!==p.id?{controller_id:controller,held_turns:p.takeover?.controller_id===controller?p.takeover.held_turns+1:1}:null;
    const conquered=Boolean(next && next.held_turns>=w.config.dynamics.capitalHoldTurns);
    decisions.set(p.id,{polity_id:p.id,capital_territory_id:territoryId,takeover:next,conquered,eliminate:conquered || !p.population && !p.units.length && !next});
  }
  // Only genuine succession dependencies order transfers: a victim's estate goes
  // to its captor before that captor's estate is transferred. IDs serialize peers.
  const pending=new Set([...decisions.values()].filter(d=>d.conquered).map(d=>d.polity_id)),order=[];
  let cycles=[];
  while(pending.size){
    const recipients=new Set([...pending].map(id=>decisions.get(id).takeover.controller_id));
    const ready=[...pending].filter(id=>!recipients.has(id));
    if(!ready.length){
      const visited=new Set();
      for(const start of pending){
        if(visited.has(start))continue;
        const path=[];let id=start;
        while(!path.includes(id)){path.push(id);visited.add(id);id=decisions.get(id).takeover.controller_id;}
        cycles.push(path.slice(path.indexOf(id)));
      }
      break;
    }
    for(const id of ready){pending.delete(id);order.push(id);}
  }
  // Apply the already-decided lifecycle changes together, then compose effects.
  const siegeDamage=new Map();
  for(const [id,decision]of decisions){
    const p=w.polities[id];p.takeover=clone(decision.takeover);p.alive=!decision.eliminate;
    if(p.takeover)for(const f of sortedValues(input.facilities).filter(f=>f.hex_ids.includes(p.capital_hex_id))){
      siegeDamage.set(f.id,(siegeDamage.get(f.id)??0)+w.config.dynamics.siegeDamagePerTurn);
    }
  }
  for(const [id,damage]of siegeDamage)w.facilities[id].condition=Math.max(0,input.facilities[id].condition-damage);
  for(const id of order){
    const p=w.polities[id],controller=decisions.get(id).takeover.controller_id;
    for(const territory of sortedValues(w.territories).filter(t=>t.owner_id===id)){
      setTerritory(w,territory.territory_id,{owner:controller,reason:'conquest_completed'});
      captureResidents(w,input,territory.territory_id,controller,[]);
    }
    const winner=w.polities[controller];winner.citizens.push(...p.citizens);winner.units.push(...p.units);
    p.citizens=[];p.units=[];p.projects=[];p.territory=[];syncPopulation(p);syncPopulation(winner);
  }
  // Closed succession cycles have no surviving beneficiary. Resolve all cycle
  // members from the same frozen decision set and atomically orphan each asset
  // class; neither IDs nor iteration order can manufacture a successor.
  const cycleRecords=[],estateEventIdsByPolity=new Map();
  for(const cycle of cycles){
    const record=disposeNoBeneficiaryEstate(w,input,cycle,'closed_conquest_cycle');
    for(const id of record.members)estateEventIdsByPolity.set(id,record.assetEventIds);
    cycleRecords.push({...record,eliminationPredicates:record.members.map(id=>clone(decisions.get(id)))});
  }
  for(const decision of decisions.values())if(decision.eliminate&&!decision.conquered){
    const record=disposeNoBeneficiaryEstate(w,input,[decision.polity_id],'no_surviving_population_or_units');
    estateEventIdsByPolity.set(decision.polity_id,record.assetEventIds);
  }
  const eliminationEventIds=new Map();
  for(const [id,decision]of decisions){
    const before=input.polities[id],p=w.polities[id];
    if(decision.eliminate || sha256(before.takeover)!==sha256(p.takeover)){
      const event=transition(w,p.alive?'capital_takeover':'polity_elimination',before,p,[],[id],{
        reason:p.takeover?'capital_hold':'no_surviving_population_or_units',input_refs:[ref(w,input)],decision:clone(decision)
      },estateEventIdsByPolity.get(id)??[]);
      if(decision.eliminate)eliminationEventIds.set(id,event.event_id);
    }
  }
  // The cycle decision is the final canonical join over both estate transitions
  // and the concrete polity-elimination events. This makes every consequence
  // traversable through real prior event IDs without forward or synthetic refs.
  for(const record of cycleRecords){
    const eliminated=record.members.map(id=>{const eventId=eliminationEventIds.get(id);assert(eventId,'closed cycle lacks canonical polity elimination');return eventId;}).sort();
    transition(w,'closed_conquest_cycle',record.estateBefore,record.estateAfter,[],record.members,{cycle_members:record.members,elimination_predicates:record.eliminationPredicates,asset_transition_event_ids:record.assetEventIds,elimination_event_ids:eliminated,resolution:'simultaneous_no_successor'},[...record.assetEventIds,...eliminated]);
  }
  for(const p of sortedActors(w))p.territory=sortedValues(w.territories).filter(t=>t.owner_id===p.id).map(t=>t.territory_id);
}

export function resolveApparatus(w,committed) {
  const pre={...w,...mechanicState(w)},preState=mechanicState(w),preRef=ref(w,preState),plans=[];
  for(const action of [...committed.acceptedActions].sort((a,b)=>a.action_id.localeCompare(b.action_id))){const plan=planAction(pre,action.actor_id,action);assert(plan.ok,'sealed action no longer validates: '+(plan.code??''));plans.push(plan);}
  const conflicts=conflictComponents(pre,plans),invalid=reservePlans(pre,plans),valid=plans.filter(p=>!invalid.has(p.action.action_id));
  for(const plan of plans.filter(p=>invalid.has(p.action.action_id)))transition(w,'simultaneous_reservation_conflict',pre.polities[plan.actorId],pre.polities[plan.actorId],[plan.action.action_id],[plan.actorId],{reason:'overlapping_commitments_or_insufficient_combined_inputs'});
  // Effect composition: declared local effects; common-snapshot combat; explicit capture;
  // then the shared tick. No plan is derived from another actor's already-mutated state.
  const localEventRefs=new Map();
  for(const plan of valid.filter(p=>p.action.type!=='demobilize')){const event=resolveLocal(w,pre,plan);if(event)localEventRefs.set(plan.action.action_id,event.event_id);}
  const control=battles(w,pre,valid,committed,preRef,localEventRefs);
  // Demobilization returns only crew that survives this committed turn's combat.
  for(const plan of valid.filter(p=>p.action.type==='demobilize'))resolveLocal(w,pre,plan);
  territories(w,pre,valid,control);communications(w,pre,valid);completeProjects(w,pre);economy(w);takeover(w);
  for(const p of sortedActors(w)){
    const before=clone(p.facts);observeWorld(w,p.id);
    const scans=new Set();
    for(const plan of valid.filter(x=>x.actorId===p.id && x.action.type==='reconnaissance')){
      const center=w.hexes[plan.action.hex_id],radius=pre.polities[p.id].technologies.includes('satellites')?w.config.dynamics.satelliteRadius:w.config.dynamics.reconRadius;
      for(const h of sortedValues(w.hexes).filter(h=>hexDistance(center,h)<=radius))scans.add(h.id);
    }
    if(scans.size)observeWorld(w,p.id,{scanHexIds:[...scans].sort(),source:'deliberate_reconnaissance',extend:true});
    if(sha256(before)!==sha256(p.facts))transition(w,'authorized_observation',before,p.facts,[],[p.id]);
  }
  const after=mechanicState(w),aggregate=transition(w,'atomic_committed_turn',preState,after,plans.map(p=>p.action.action_id),sortedActors(w).map(p=>p.id),{input_refs:[preRef,ref(w,committed)],composition_version:'simultaneous-effects-v2',rejected_action_ids:[...invalid].sort()});
  for(const component of conflicts){
    const actions=component.plans.map(p=>p.action),ids=actions.map(a=>a.action_id);
    w.evidence.append({eventType:'ConflictResolved',turn:w.turn,phase:'resolve',causality:{causation_ids:[committed.commit_event_id,aggregate.event_id]},payload:{schema_version:'1.0.0',conflict_set_id:stableId('conflict',committed.turn_committed_id,sha256(ids)),run_id:w.runId,turn:w.turn,turn_committed_ref:committed.turn_committed_id,pre_resolution_state_hash:committed.input_state_hash,accepted_action_ids:ids,canonical_order_rule_ref:'action_ids_for_evidence_only_simultaneous_effects_v2',conflict_membership_ref:ref(w,{footprints:component.keys,action_ids:ids}),resolution_inputs_ref:preRef,action_set_hash:sha256(actions),resolution_function_version:'simultaneous-effects-v2',rng_draw_refs:w.evidence.events.filter(e=>e.event_type==='RNGDraw' && e.turn===w.turn && e.phase==='resolve').map(e=>e.event_id),outcome_event_ids:[aggregate.event_id],post_resolution_state_hash:sha256(after)}});
  }
}

export function assertWorldState(world) {
  const ids=new Set(),c=world.config;
  for(const p of sortedActors(world)){
    assert(p.population===populationTotal(p),'population aggregate mismatch');
    for(const n of [p.population,p.food,p.credits,p.shortage,p.growth_progress,...Object.values(p.resources)])assert(Number.isSafeInteger(n)&&n>=0&&n<=c.dynamics.maxQuantity,'world quantity overflow/underflow');
    for(const e of [...p.citizens,...p.units]){assert(!ids.has(e.id),'duplicate population/unit identity');ids.add(e.id);assert(world.hexes[e.hex_id]?.territory_id===e.territory_id,'invalid entity physical location');}
    for(const g of p.citizens)assert(Number.isSafeInteger(g.count)&&g.count>0 && Object.hasOwn(c.assignments,g.assignment),'invalid citizen assignment/count');
    for(const u of p.units)assert(u.crew.length && u.crew.some(g=>g.count>0) && u.health>0 && c.unitTypes[u.type],'unit without explicit surviving recruitment population');
    for(const e of [...p.citizens,...p.units].filter(e=>e.embarked_on))assert(p.units.some(u=>u.id===e.embarked_on),'embarked entity without owned carrier');
    const roots=p.units.filter(unit=>!unit.embarked_on),covered=new Set(roots.map(unit=>unit.id));
    for(const root of roots){const cargo=embarkedCargo(p,root.id);assert(cargo,'invalid embarked relationship');for(const unit of cargo.units)covered.add(unit.id);for(const entity of [...cargo.units,...cargo.citizens])assert(entity.hex_id===root.hex_id&&entity.territory_id===root.territory_id,'embarked entity location differs from root carrier');}
    assert(covered.size===p.units.length,'cyclic or disconnected embarked unit relationship');
  }
  for(const t of sortedValues(world.territories))if(t.status==='contested')assert(t.owner_id===null&&t.exclusive_claimant_id===null,'contested territory acquired arbitrary owner');
  for(const g of world.unaffiliatedPopulation){assert(!ids.has(g.id),'duplicate unaffiliated population identity');ids.add(g.id);assert(g.affiliation_status==='unaffiliated'&&Number.isSafeInteger(g.count)&&g.count>0,'invalid unaffiliated population');assert(world.hexes[g.hex_id]?.territory_id===g.territory_id,'invalid unaffiliated population location');}
  for(const u of world.neutralUnits){assert(!ids.has(u.id),'duplicate neutral unit identity');ids.add(u.id);assert(u.status==='inactive_neutral'&&u.controller_id===null&&u.crew.length===0,'invalid neutral unit');assert(world.hexes[u.hex_id]?.territory_id===u.territory_id,'invalid neutral unit location');}
  for(const h of sortedValues(world.hexes))for(const n of Object.values(h.deposits))assert(Number.isSafeInteger(n)&&n>=0,'invalid deposit balance');
  return true;
}
