import { clone } from './core.js';
import { assertValidSchema } from './schema.js';
import { projectWorldState, hexDistance, contiguous, findPath } from './world-map.js';

export const ACTION_TYPES = ['wait','name','move','move_population','explore','attack','fortify','recruit','demobilize','reassign','train','build','resume_construction','upgrade','repair','destroy','research','reverse_engineer','prospect','intelligence','reconnaissance','transfer','transfer_unit','transfer_population','transfer_facility','incorporate_population','reactivate_unit','acquire_facility','share_technology','claim','annex','abandon','exchange_territory','channel_create','channel_invite','channel_leave','message','promise','broadcast','embark','disembark'];
export const unitById = (world,id) => { for (const p of Object.values(world.polities)) { const unit=p.units.find(u=>u.id===id); if(unit)return {polity:p,unit}; } return null; };
export const populationTotal = p => p.citizens.reduce((n,g)=>n+g.count,0);
function embarkationIndex(polity) {
  const units=[...polity.units].sort((a,b)=>a.id.localeCompare(b.id)),citizens=[...polity.citizens].sort((a,b)=>a.id.localeCompare(b.id));
  const unitById=new Map(units.map(unit=>[unit.id,unit])),entityById=new Map();
  for(const entity of [...units,...citizens]){if(entityById.has(entity.id))return null;entityById.set(entity.id,entity);}
  for(const entity of entityById.values())if(entity.embarked_on&&!unitById.has(entity.embarked_on))return null;
  for(const unit of units){
    const seen=new Set([unit.id]);let carrierId=unit.embarked_on;
    while(carrierId){if(seen.has(carrierId))return null;seen.add(carrierId);carrierId=unitById.get(carrierId).embarked_on;}
  }
  return {units,citizens,unitById,entityById};
}
export function embarkationPath(polity,entityId) {
  const index=embarkationIndex(polity),entity=index?.entityById.get(entityId);if(!index||!entity)return null;
  const path=[entity.id];let carrierId=entity.embarked_on;
  while(carrierId){path.push(carrierId);carrierId=index.unitById.get(carrierId).embarked_on;}
  return path;
}
export function embarkedCargo(polity,carrierId) {
  const index=embarkationIndex(polity);if(!index?.unitById.has(carrierId))return null;
  const units=[],citizens=[],queue=[carrierId];
  while(queue.length){
    const parent=queue.shift();
    for(const unit of index.units.filter(candidate=>candidate.embarked_on===parent)){units.push(unit);queue.push(unit.id);}
    for(const group of index.citizens.filter(candidate=>candidate.embarked_on===parent))citizens.push(group);
  }
  return {units,citizens};
}
export const hasTech = (actor, prerequisites=[]) => prerequisites.every(t=>actor.technologies.includes(t));
export const activeFacility = f => f && f.condition>0 && f.construction_progress>=f.required_progress;
// Validation passes only the authorized map; completion passes its settled snapshot.
export const facilityPermitted = (f,actorId,hexes,territories) => Boolean(f && f.owner_id===actorId && f.hex_ids.length && f.hex_ids.every(id=>{
  const t=territories[hexes[id]?.territory_id];
  // Retain existing action-specific territorial rules; contested owner-only
  // permissions are suspended even when facility ownership itself is retained.
  return t?.status==='controlled' || t?.status==='unclaimed';
}));
const ownedFacility = (view,id,type) => view.own.facilities.find(f=>(!id || f.id===id) && (!type || f.type===type) && activeFacility(f) && facilityPermitted(f,view.own.id,view.map,view.territories));
const knownActor = (view,id) => id!==view.own.id && Boolean(view.known.polities[id]);
const enough = (p,cost) => p.credits>=cost.credits && p.food>=(cost.food??0) && Object.entries(cost.resources).every(([k,v])=>(p.resources[k]??0)>=v);
const failure = code => ({ok:false,code});

/** Return only public-safe validation plus a private deterministic execution plan. */
export function planAction(world,actorId,action) {
  const actor=world.polities[actorId]; if(!actor?.alive || world.terminal)return failure('actor_unavailable');
  if(!action || !ACTION_TYPES.includes(action.type))return failure('action_type_not_enabled');
  try { assertValidSchema(action,'action-api.schema.json'); } catch { return failure('malformed_action'); }
  if (!action.action_id || Object.hasOwn(action,'actor_id') && action.actor_id!==actorId) return failure('malformed_action');
  const view=projectWorldState(world,actorId), p=view.own, c=world.config, d=c.dynamics;
  const plan={ok:true,action:clone(action),actorId,cost:{credits:0,food:0,resources:{}},reservations:[],path:null};
  const reserve=(key,count=1,capacity=1)=>plan.reservations.push({key,count,capacity});
  const cost = spec => {plan.cost.credits=spec.credits??0;plan.cost.resources=clone(spec.resources??{});};
  const unit=p.units.find(u=>u.id===action.unit_id), group=p.citizens.find(g=>g.id===action.citizen_id);
  for(const key of ['citizen_ids','builder_ids','scientist_ids'])if(action[key]?.some(id=>!p.citizens.some(g=>g.id===id)))return failure('population_required');
  const facility=p.facilities.find(f=>f.id===action.facility_id);
  const workers=(assignment,hexes,ids)=>p.citizens.filter(g=>g.assignment===assignment && !g.training && !g.embarked_on && hexes.includes(g.hex_id) && (!ids || ids.includes(g.id)));
  const useWorkers=(groups,count)=>{let left=count;plan.workers=[];for(const g of [...groups].sort((a,b)=>a.id.localeCompare(b.id))){const n=Math.min(left,g.count);if(n){reserve(`citizen:${g.id}`,n,g.count);plan.workers.push({id:g.id,count:n});left-=n;}}return left===0;};
  const hex=action.hex_id && view.map[action.hex_id], territory=view.territories[action.territory_id];
  const owned=t=>t?.status==='controlled' && t.owner_id===actorId && t.controller_id===actorId;
  switch(action.type) {
    case 'wait': break;
    case 'name':
      if(p.name!==null || !action.name.trim() || action.name.length>d.nameMaxLength || /[\p{C}]/u.test(action.name))return failure('invalid_name');
      reserve(`name:${actorId}`);break;
    case 'move': case 'move_population': case 'explore': {
      const entity=action.type==='move'?unit:group;
      if(!entity || entity.embarked_on || entity.training)return failure('entity_unavailable');
      if(action.type==='explore' && entity.assignment!=='Explorer')return failure('assignment_required');
      const domain=unit && action.type==='move'?c.unitTypes[unit.type].domain:'land';
      const budget=unit && action.type==='move'?c.unitTypes[unit.type].movement:entity.assignment==='Explorer'?d.explorerMovement:d.citizenMovement;
      // Unknown adjacent hexes may be explored only by a declared step. No hidden pathfinding.
      let map=view.map;
      if(action.type==='explore' && !hex) {
        const match=/^hex-([0-9]+)-([0-9]+)$/.exec(action.hex_id);
        if(!match)return failure('invalid_destination');
        const q=Number(match[1]),r=Number(match[2]);
        if(q<0 || r<0 || q>=c.map.width || r>=c.map.height || hexDistance(map[entity.hex_id],{q,r})!==1)return failure('invalid_destination');
        plan.unknownStep=true;map={...map,[action.hex_id]:{id:action.hex_id,q,r,terrain:'plains'}};
      }
      plan.path=findPath(map,entity.hex_id,action.hex_id,domain,c,budget);
      if(!plan.path)return failure('invalid_destination');
      reserve(unit && action.type==='move'?`unit:${entity.id}`:`citizen:${entity.id}`,unit && action.type==='move'?1:entity.count,unit && action.type==='move'?1:entity.count);
      break;
    }
    case 'attack': {
      const target=view.known.units[action.target_unit_id]?.value;
      if(!unit || unit.embarked_on)return failure('unit_unavailable');
      if(!target?.current_location_known || !view.map[target.hex_id])return failure('invalid_attack_target');
      const spec=c.unitTypes[unit.type], enemy=c.unitTypes[target.type];
      if(!enemy || !spec.targets.includes(enemy.domain) || hexDistance(view.map[unit.hex_id],view.map[target.hex_id])>spec.range)return failure('invalid_attack_target');
      reserve(`unit:${unit.id}`);plan.target=clone(target);break;
    }
    case 'fortify': case 'demobilize':
      if(!unit || unit.embarked_on)return failure('unit_unavailable');
      if(action.type==='demobilize' && !ownedFacility(view,action.facility_id,'training')?.hex_ids.includes(unit.hex_id))return failure('facility_required');
      reserve(`unit:${unit.id}`);break;
    case 'recruit': {
      const type=action.unit_type??d.defaultUnit,spec=c.unitTypes[type]; if(!spec || !hasTech(p,spec.prerequisites))return failure('prerequisite_required');
      const f=ownedFacility(view,action.facility_id,spec.facility); if(!f)return failure('facility_required');
      const soldiers=workers('Soldier',f.hex_ids,action.citizen_ids);
      if(!useWorkers(soldiers,spec.citizens))return failure('population_required');
      if(!owned(view.territories[view.map[f.hex_ids[0]].territory_id]))return failure('control_required');
      plan.unit_type=type;plan.facility_id=f.id;plan.spawn=action.hex_id??f.hex_ids[0];
      if(spec.domain==='sea' && (!view.map[plan.spawn] || view.map[plan.spawn].terrain!=='water' || !f.hex_ids.some(id=>hexDistance(view.map[id],view.map[plan.spawn])<=1)))return failure('invalid_destination');
      if(spec.domain!=='sea' && !f.hex_ids.includes(plan.spawn))return failure('invalid_destination');
      cost(spec);reserve(`facility-capacity:${f.id}`,1,f.capacity);break;
    }
    case 'reassign': case 'train': {
      const spec=c.assignments[action.assignment];if(!group || group.training || group.embarked_on || !spec || !hasTech(p,spec.prerequisites) || action.count>group.count)return failure('population_required');
      const f=ownedFacility(view,action.facility_id,spec.facility);if(!f || !f.hex_ids.includes(group.hex_id))return failure('facility_required');
      plan.cost.credits=spec.cost*action.count;plan.facility_id=f.id;reserve(`citizen:${group.id}`,action.count,group.count);reserve(`facility-capacity:${f.id}`,action.count,f.capacity);break;
    }
    case 'build': {
      const spec=c.facilityTypes[action.facility_type], ids=action.hex_ids;
      if(!spec || !hasTech(p,spec.prerequisites))return failure('prerequisite_required');
      if(ids.length!==spec.hexes || !contiguous(view.map,ids) || ids.some(id=>!owned(view.territories[view.map[id].territory_id]) || view.map[id].terrain==='water') || spec.domain==='coast' && !ids.some(id=>view.map[id].coast))return failure('invalid_site');
      if([...p.facilities,...Object.values(view.known.facilities).map(f=>f.value)].some(f=>f.hex_ids.some(id=>ids.includes(id)) && !f.destroyed))return failure('invalid_site');
      const builders=workers('Builder',ids,action.builder_ids);if(!useWorkers(builders,builders.reduce((n,g)=>n+g.count,0)) || !plan.workers.length)return failure('builders_required');
      for(const id of ids)reserve(`site:${id}`);cost(spec);break;
    }
    case 'resume_construction': case 'upgrade': case 'repair': case 'destroy': {
      if(!facility)return failure('facility_unavailable');
      if(!facility.hex_ids.every(id=>owned(view.territories[view.map[id].territory_id])))return failure('control_required');
      if(action.type==='destroy'){reserve(`facility:${facility.id}`);break;}
      const spec=c.facilityTypes[facility.type];if(!hasTech(p,spec.prerequisites))return failure('prerequisite_required');
      const builders=workers('Builder',facility.hex_ids,action.builder_ids);useWorkers(builders,builders.reduce((n,g)=>n+g.count,0));if(!plan.workers.length)return failure('builders_required');
      if(action.type==='resume_construction' && activeFacility(facility))return failure('facility_unavailable');
      if(action.type==='upgrade' && (!activeFacility(facility) || facility.level>=d.maximumFacilityLevel))return failure('facility_unavailable');
      if(action.type==='upgrade')plan.cost.credits=facility.capacity*d.upgradeCreditPerCapacity;
      if(action.type==='repair')plan.cost.credits=plan.workers.reduce((n,g)=>n+g.count,0)*d.repairCreditPerBuilder;
      reserve(`facility:${facility.id}`);break;
    }
    case 'research': case 'reverse_engineer': {
      const spec=c.technologies[action.technology];if(!spec || p.technologies.includes(action.technology) || p.projects.some(j=>j.technology===action.technology) || !hasTech(p,spec.prerequisites))return failure('prerequisite_required');
      const f=ownedFacility(view,action.facility_id,'research');if(!f)return failure('facility_required');
      if(action.type==='reverse_engineer') { const artifact=p.facilities.find(f=>f.id===action.artifact_id)??p.units.find(u=>u.id===action.artifact_id);if(!artifact || !artifact.captured_from || !(artifact.prerequisites??c.unitTypes[artifact.type]?.prerequisites??[]).includes(action.technology))return failure('artifact_required'); }
      const scientists=workers('Scientist',f.hex_ids,action.scientist_ids).filter(g=>!p.projects.some(j=>j.worker_ids?.includes(g.id)));
      if(!useWorkers(scientists,spec.scientists))return failure('scientists_required');
      plan.facility_id=f.id;cost(spec);reserve(`technology:${actorId}:${action.technology}`);reserve(`facility-capacity:${f.id}`,spec.scientists,f.capacity);break;
    }
    case 'prospect':
      if(!group || group.assignment!=='Explorer' || group.training || group.embarked_on || !hex || group.hex_id!==hex.id)return failure('explorer_required');
      reserve(`citizen:${group.id}`,group.count,group.count);break;
    case 'intelligence':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      plan.cost.credits=d.intelligenceCredits;break;
    case 'reconnaissance': {
      const match=/^hex-([0-9]+)-([0-9]+)$/.exec(action.hex_id),point=hex??(match?{q:Number(match[1]),r:Number(match[2])}:null);
      if(!point || point.q>=c.map.width || point.r>=c.map.height)return failure('invalid_destination');
      if(!p.technologies.includes('satellites') && (!unit || unit.embarked_on || !['air','sea'].includes(c.unitTypes[unit.type].domain) || hexDistance(view.map[unit.hex_id],point)>c.unitTypes[unit.type].range))return failure('reconnaissance_unavailable');
      if(unit)reserve(`unit:${unit.id}`);plan.cost.credits=d.reconCredits;break;
    }
    case 'transfer':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      if(action.resource==='credits')plan.cost.credits=action.amount;
      else if(action.resource==='food')plan.cost.food=action.amount;
      else if(Object.hasOwn(p.resources,action.resource))plan.cost.resources[action.resource]=action.amount;
      else return failure('invalid_resource');
      break;
    case 'share_technology':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      if(!p.technologies.includes(action.technology))return failure('prerequisite_required');break;
    case 'transfer_unit':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      if(!unit || unit.embarked_on)return failure('unit_unavailable');
      {const cargo=embarkedCargo(p,unit.id);if(!cargo)return failure('unit_unavailable');
      plan.cargo_unit_ids=cargo.units.map(item=>item.id);plan.cargo_citizen_ids=cargo.citizens.map(item=>item.id);reserve(`unit:${unit.id}`);
      // A carrier gift reserves its entire cargo capacity from the same prestate.
      // Any simultaneous embarkation then conflicts with the gift, regardless of IDs.
      if(c.unitTypes[unit.type].capacity)reserve(`cargo:${unit.id}`,c.unitTypes[unit.type].capacity,c.unitTypes[unit.type].capacity);
      for(const id of plan.cargo_unit_ids)reserve(`unit:${id}`);
      for(const id of plan.cargo_citizen_ids){const cargoGroup=p.citizens.find(group=>group.id===id);reserve(`citizen:${id}`,cargoGroup.count,cargoGroup.count);}break;}
    case 'transfer_population':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      if(!group || group.embarked_on || group.training || action.count>group.count)return failure('population_required');
      reserve(`citizen:${group.id}`,action.count,group.count);break;
    case 'transfer_facility':
      if(!knownActor(view,action.to))return failure('invalid_recipient');
      if(!facility || !facility.hex_ids.every(id=>owned(view.territories[view.map[id].territory_id])))return failure('facility_unavailable');
      reserve(`facility:${facility.id}`);break;
    case 'incorporate_population': {
      const observed=view.known.unaffiliated_population?.[action.unaffiliated_population_id];
      const orphan=observed?.value,site=orphan && view.map[orphan.hex_id];
      if(!orphan || action.count>orphan.count || !site)return failure('estate_unavailable');
      if(!owned(view.territories[site.territory_id]) || !p.citizens.some(g=>!g.embarked_on && g.count>0 && g.hex_id===site.id))return failure('presence_required');
      plan.orphan=clone(orphan);reserve(`unaffiliated_population:${orphan.id}`);break;
    }
    case 'reactivate_unit': {
      const observed=view.known.neutral_units?.[action.neutral_unit_id],neutral=observed?.value,site=neutral && view.map[neutral.hex_id];
      if(!neutral || !site || !c.unitTypes[neutral.type])return failure('estate_unavailable');
      if(!owned(view.territories[site.territory_id]))return failure('control_required');
      const soldiers=workers('Soldier',[site.id],action.citizen_ids);
      if(!useWorkers(soldiers,c.unitTypes[neutral.type].citizens))return failure('population_required');
      plan.neutral=clone(neutral);reserve(`neutral_unit:${neutral.id}`);break;
    }
    case 'acquire_facility': {
      const observed=view.known.facilities?.[action.facility_id],unclaimed=observed?.value;
      if(!unclaimed || observed.currently_visible!==true || unclaimed.owner_id!==null || unclaimed.destroyed)return failure('estate_unavailable');
      if(!unclaimed.hex_ids.every(id=>view.map[id] && owned(view.territories[view.map[id].territory_id])) || !p.citizens.some(g=>!g.embarked_on && g.count>0 && unclaimed.hex_ids.includes(g.hex_id)))return failure('presence_required');
      plan.unclaimedFacility=clone(unclaimed);reserve(`unclaimed_facility:${unclaimed.id}`);break;
    }
    case 'claim': case 'annex':
      if(!territory || !p.citizens.some(g=>!g.embarked_on && view.map[g.hex_id]?.territory_id===action.territory_id && g.count>0))return failure('presence_required');
      if(action.type==='annex' && territory.status==='contested')return failure('control_required');
      reserve(`claim:${actorId}:${action.territory_id}`);break;
    case 'abandon': case 'exchange_territory':
      if(!owned(territory))return failure('control_required');
      if(action.type==='exchange_territory' && !knownActor(view,action.to))return failure('invalid_recipient');
      reserve(`ownership:${action.territory_id}`);break;
    case 'channel_create':
      if(action.members.includes(actorId) || !action.members.every(id=>knownActor(view,id)))return failure('invalid_recipient');break;
    case 'channel_invite': case 'channel_leave':
      if(!view.channels.some(ch=>ch.id===action.channel_id))return failure('channel_unavailable');
      if(action.type==='channel_invite' && !knownActor(view,action.to))return failure('invalid_recipient');break;
    case 'message': case 'promise':
      if(action.channel_id ? !view.channels.some(ch=>ch.id===action.channel_id) : !knownActor(view,action.to))return failure('invalid_recipient');
      if(action.text.length>d.messageMaxLength)return failure('message_too_long');break;
    case 'broadcast':if(action.text.length>d.messageMaxLength)return failure('message_too_long');break;
    case 'embark': case 'disembark': {
      const carrier=p.units.find(u=>u.id===action.carrier_id), entity=unit??group;
      if(!carrier || !entity || carrier.id===entity.id || !c.unitTypes[carrier.type].capacity)return failure('transport_unavailable');
      const capacity=c.unitTypes[carrier.type].capacity, weight=unit?(c.unitTypes[unit.type].citizens):group.count;
      if(action.type==='embark') {
        if(entity.embarked_on || group?.training || carrier.embarked_on || hexDistance(view.map[entity.hex_id],view.map[carrier.hex_id])>1 || carrier.type==='carrier' && (!unit || c.unitTypes[unit.type].domain!=='air'))return failure('transport_unavailable');
        const load=p.citizens.filter(g=>g.embarked_on===carrier.id).reduce((n,g)=>n+g.count,0)+p.units.filter(u=>u.embarked_on===carrier.id).reduce((n,u)=>n+c.unitTypes[u.type].citizens,0);
        reserve(`cargo:${carrier.id}`,weight,capacity-load);
      } else if(entity.embarked_on!==carrier.id || !hex || hexDistance(view.map[carrier.hex_id],hex)>1 || (unit?c.unitTypes[unit.type].domain==='land':true) && hex.terrain==='water')return failure('invalid_destination');
      reserve(unit?`unit:${unit.id}`:`citizen:${group.id}`,unit?1:group.count,unit?1:group.count);break;
    }
  }
  if(!enough(p,plan.cost))return failure('insufficient_resources');
  if([plan.cost.credits,plan.cost.food,...Object.values(plan.cost.resources)].some(v=>!Number.isSafeInteger(v) || v<0 || v>d.maxQuantity))return failure('invalid_quantity');
  return plan;
}

export function validateAction(world,actorId,action) { const result=planAction(world,actorId,action);return result.ok?{ok:true}:result; }

/** Read/write overlap defines connected components; ordering only serializes evidence. */
export function actionFootprint(world,plan) {
  const a=plan.action, keys=new Set([`actor:${plan.actorId}`,...plan.reservations.map(r=>r.key)]);
  if(a.to)keys.add(`actor:${a.to}`);
  for(const id of [a.unit_id,a.target_unit_id,a.carrier_id,a.neutral_unit_id].filter(Boolean))keys.add(`unit:${id}`);
  if(a.unaffiliated_population_id)keys.add(`population:${a.unaffiliated_population_id}`);
  for(const id of [...(plan.path?.path??[]),...(a.hex_ids??[]),a.hex_id].filter(Boolean)){keys.add(`hex:${id}`);if(world.hexes[id])keys.add(`territory:${world.hexes[id].territory_id}`);}
  for(const id of [a.territory_id,a.channel_id,a.facility_id].filter(Boolean))keys.add(`target:${id}`);
  if(a.territory_id)keys.add(`territory:${a.territory_id}`);
  const unit=unitById(world,a.unit_id)?.unit,target=unitById(world,a.target_unit_id)?.unit;
  for(const u of [unit,target].filter(Boolean)){keys.add(`hex:${u.hex_id}`);keys.add(`territory:${u.territory_id}`);}
  return [...keys].sort();
}
export function conflictComponents(world,plans) {
  const groups=[];
  for(const plan of [...plans].sort((a,b)=>a.action.action_id.localeCompare(b.action.action_id))){
    const keys=new Set(actionFootprint(world,plan)), overlaps=groups.filter(g=>g.keys.some(k=>keys.has(k)));
    const members=[plan,...overlaps.flatMap(g=>g.plans)];for(const group of overlaps)for(const key of group.keys)keys.add(key);
    for(const group of overlaps)groups.splice(groups.indexOf(group),1);
    groups.push({plans:members.sort((a,b)=>a.action.action_id.localeCompare(b.action.action_id)),keys:[...keys].sort()});
  }
  return groups.sort((a,b)=>a.plans[0].action.action_id.localeCompare(b.plans[0].action.action_id));
}
