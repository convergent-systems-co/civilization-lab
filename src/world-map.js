import { assert, clone, sha256 } from './core.js';

export const hexId = (q, r) => `hex-${q}-${r}`;
export const hexDistance = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const directions = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
export const neighbors = (hexes, h) => directions.map(([q,r]) => hexes[hexId(h.q+q,h.r+r)]).filter(Boolean);
export const sortedValues = obj => Object.keys(obj).sort().map(k => obj[k]);
export const sortedActors = world => sortedValues(world.polities);
export const territoryHexes = (world, id) => sortedValues(world.hexes).filter(h => h.territory_id === id);
export function contiguous(hexes, ids) {
  if (!ids.length || ids.some(id => !hexes[id]) || new Set(ids).size !== ids.length) return false;
  const seen = new Set([ids[0]]), queue = [hexes[ids[0]]];
  while (queue.length) for (const h of neighbors(hexes, queue.shift())) if (ids.includes(h.id) && !seen.has(h.id)) { seen.add(h.id); queue.push(h); }
  return seen.size === ids.length;
}

/** Dijkstra over known physical hexes; the unknown portion is never a path oracle. */
export function findPath(hexes, fromId, toId, domain, config, maximum = Infinity) {
  if (!hexes[fromId] || !hexes[toId]) return null;
  const costs = new Map([[fromId,0]]), paths = new Map([[fromId,[fromId]]]), pending = new Set([fromId]);
  while (pending.size) {
    const id = [...pending].sort((a,b) => costs.get(a)-costs.get(b) || a.localeCompare(b))[0]; pending.delete(id);
    if (id === toId) return { path: paths.get(id), cost: costs.get(id) };
    for (const h of neighbors(hexes,hexes[id])) {
      if (domain === 'land' && h.terrain === 'water' || domain === 'sea' && h.terrain !== 'water') continue;
      const cost = costs.get(id) + (domain === 'air' ? 1 : config.geography.terrain[h.terrain].movement);
      if (cost <= maximum && cost < (costs.get(h.id) ?? Infinity)) { costs.set(h.id,cost); paths.set(h.id,[...paths.get(id),h.id]); pending.add(h.id); }
    }
  }
  return null;
}

export function generateMap(world) {
  const { config: c } = world, scale = c.dynamics.numericScale;
  const draw = (id,purpose) => world.rng.draw({runId:world.runId,turnId:0,phase:'setup',subsystem:'geography',eventOrActionId:id,purpose,streamNamespace:'generation',drawOrdinal:0});
  assert(c.geography.landmassModes.includes(c.geography.landmass),'unknown landmass mode');
  const rotation = Math.floor(draw('starts','profile_rotation') * c.startingProfiles.length);
  world.hexes = {}; world.territories = {};
  const starts = c.geography.starts.map(([q,r],i) => ({q,r,id:hexId(q,r),actorId:`polity-${i+1}`,profile:(i+rotation)%c.startingProfiles.length}));
  const anchors = starts.map(s => ({q:s.q,r:s.r,id:`territory-capital-${s.q}-${s.r}`,owner:s.actorId}));
  if (c.geography.neutralLand) for (let r=0;r<c.map.height;r+=c.geography.neutralTerritoryStride) for (let q=0;q<c.map.width;q+=c.geography.neutralTerritoryStride) {
    if (starts.every(s => hexDistance(s,{q,r}) > c.geography.startRadius*2)) anchors.push({q,r,id:`territory-${q}-${r}`,owner:null});
  }
  for (let r=0;r<c.map.height;r++) for (let q=0;q<c.map.width;q++) {
    const id=hexId(q,r), point={q,r}, n=Math.floor(draw(id,'terrain')*scale);
    const start = starts.find(s => hexDistance(s,point)<=c.geography.startRadius);
    // Guaranteed land corridors preserve viable starts/contact in both landmass families.
    const corridor = starts.some(s => s.q===q || s.r===r);
    const edge=q===0 || r===0 || q===c.map.width-1 || r===c.map.height-1;
    let terrain = n < c.geography.mountainPermille ? 'mountain' : n < c.geography.mountainPermille+c.geography.forestPermille ? 'forest':'plains';
    if (edge || !corridor && !start && (n<c.geography.waterPermille || c.geography.landmass==='archipelago' && q%c.geography.neutralTerritoryStride===0)) terrain='water';
    if (start || corridor && !edge) terrain='plains';
    const anchor = start ? anchors.find(a=>a.owner===start.actorId) : [...anchors].sort((a,b)=>hexDistance(a,point)-hexDistance(b,point)||a.q-b.q||a.r-b.r)[0];
    const nResource=draw(id,'deposit'), resourceTypes=Object.keys(c.startingProfiles[0].resources).sort();
    const resourceIndex=Math.floor(nResource*resourceTypes.length), resource=resourceTypes[resourceIndex];
    const localProfile=start && c.startingProfiles[start.profile];
    const allowed=!localProfile || localProfile.resources[resource]>0;
    const deposits=terrain!=='water' && allowed && Math.floor((nResource*resourceTypes.length%1)*scale)<c.geography.depositPermille ? {[resource]:c.geography.depositMinimum+Math.floor(nResource*c.geography.depositVariation)}:{};
    world.hexes[id]={id,q,r,terrain,coast:false,territory_id:anchor.id,deposits};
    world.territories[anchor.id] ??= {schema_version:'1.0.0',territory_id:anchor.id,status:anchor.owner?'controlled':'unclaimed',owner_id:anchor.owner,controller_id:anchor.owner,exclusive_claimant_id:anchor.owner,claim_refs:[],transition_event_refs:[],contested_since_turn:null,contested_reason:null,resolution_policy_ref:'territory-v2'};
  }
  for (const h of sortedValues(world.hexes)) h.coast=h.terrain!=='water' && neighbors(world.hexes,h).some(n=>n.terrain==='water');
  // Every starting reserve also has a finite domestic source; missing resources stay absent.
  for (const s of starts) {
    const profile=c.startingProfiles[s.profile], domestic=territoryHexes(world,anchors.find(a=>a.owner===s.actorId).id);
    for (const h of domestic) for (const type of Object.keys(h.deposits)) if (!profile.resources[type]) delete h.deposits[type];
    world.hexes[s.id].deposits=Object.fromEntries(Object.entries(profile.resources).filter(([,v])=>v>0).map(([k,v])=>[k,v+c.geography.depositMinimum]));
  }
  world.starts=starts;
}

export function validateWorldStarts(world) {
  const c=world.config, checks=[];
  for (const actor of sortedActors(world)) {
    const h=world.hexes[actor.capital_hex_id], population=actor.citizens.reduce((n,g)=>n+g.count,0);
    assert(h && h.terrain!=='water' && population===c.population.starting,'nonviable starting population/land');
    assert(actor.food>=population*c.economy.foodPerCitizen,'nonviable starting food');
    assert(Object.values(actor.resources).some(v=>v===0) && Object.values(actor.resources).some(v=>v>0),'missing strategic resource asymmetry');
    assert(territoryHexes(world,h.territory_id).filter(x=>x.terrain!=='water').length>=c.initialFacilityTypes.length,'insufficient initial facility land');
    const contacts=[];
    for (const other of sortedActors(world).filter(p=>p.id!==actor.id)) {
      const target=world.hexes[other.capital_hex_id];
      assert(hexDistance(h,target)>c.map.contactRadius,'initial foreign detection');
      const path=findPath(world.hexes,h.id,target.id,'land',c);
      assert(path && path.cost<=c.geography.contactTurns*c.dynamics.explorerMovement+c.map.contactRadius,'Pilot contact path exceeds limit');
      contacts.push({target:other.id,path_cost:path.cost});
    }
    checks.push({actor_id:actor.id,viable:true,contacts});
  }
  return checks;
}

const publicHex = h => ({id:h.id,q:h.q,r:h.r,terrain:h.terrain,coast:h.coast,territory_id:h.territory_id});
const publicTerritory = t => ({territory_id:t.territory_id,status:t.status,owner_id:t.owner_id,controller_id:t.controller_id,exclusive_claimant_id:t.exclusive_claimant_id});
const publicUnit = (u,id) => ({id:u.id,owner_id:id,type:u.type,hex_id:u.hex_id,territory_id:u.territory_id});
const publicFacility = f => ({id:f.id,owner_id:f.owner_id,type:f.type,hex_ids:[...f.hex_ids],size:f.size,condition:f.condition,construction_progress:f.construction_progress});
const publicUnaffiliatedPopulation = g => ({id:g.id,affiliation_status:'unaffiliated',assignment:g.assignment,count:g.count,hex_id:g.hex_id,territory_id:g.territory_id});
const publicNeutralUnit = u => ({id:u.id,status:'inactive_neutral',controller_id:null,type:u.type,hex_id:u.hex_id,territory_id:u.territory_id,health:u.health});
function fact(value,turn,source) { return {value:clone(value),observed_turn:turn,provenance:{source,observation_ref:sha256({value,turn,source})}}; }
export function recordFact(actor,kind,id,value,turn,source) { actor.facts[kind]??={};actor.facts[kind][id]=fact(value,turn,source); }
export function recordFacilityDestruction(actor,facility,turn) {
  recordFact(actor,'facilities',facility.id,{...publicFacility(facility),destroyed:true,condition:0},turn,'own_destruction');
}
export function discoverPolity(world,actor,id,source) {
  if (!id || id===actor.id || !world.polities[id]) return;
  actor.knowledge=[...new Set([...actor.knowledge,id])].sort();
  recordFact(actor,'polities',id,{id,name:world.polities[id].name},world.turn,source);
}

/** Explicit mechanic: callers archive the before/after knowledge transition. */
export function observeWorld(world,actorId,{scanHexIds=[],source='spatial_observation',extend=false}={}) {
  const actor=world.polities[actorId]; if (!actor?.alive) return;
  const bonus=actor.technologies.reduce((n,t)=>n+(world.config.technologies[t]?.detectionBonus??0),0);
  const sensors=[...actor.citizens.filter(g=>!g.embarked_on && g.count>0).map(g=>({hex_id:g.hex_id,detection:world.config.map.contactRadius})),...actor.units.filter(u=>!u.embarked_on).map(u=>({hex_id:u.hex_id,detection:world.config.unitTypes[u.type].detection}))];
  const visible=new Set([...(extend?actor.visible_hex_ids??[]:[]),...scanHexIds]);
  for (const h of sortedValues(world.hexes)) if (sensors.some(s=>hexDistance(world.hexes[s.hex_id],h)<=Math.max(0,s.detection+bonus-world.config.geography.terrain[h.terrain].detectionPenalty))) visible.add(h.id);
  actor.visible_hex_ids=[...visible].sort();
  actor.visible_facility_ids=sortedValues(world.facilities).filter(f=>f.hex_ids.every(site=>visible.has(site))).map(f=>f.id);
  // A formerly observed mobile target is never extrapolated to its new location.
  for (const entry of Object.values(actor.facts.units)) { entry.value.hex_id=null; entry.value.territory_id=null; entry.value.current_location_known=false; }
  // A cached owner is historical knowledge, never authority to inspect a remote site.
  // Explicit own destruction is recorded by the action that actually destroys it.
  for (const [id,entry] of Object.entries(actor.facts.facilities)) if (!entry.value.destroyed && !world.facilities[id] && entry.value.hex_ids.every(id=>visible.has(id))) {
    recordFact(actor,'facilities',id,{...entry.value,destroyed:true,condition:0},world.turn,source);
  }
  // Orphaned entities are disclosed only by direct authorized visibility. A
  // prior observation is removed once its disclosed location is re-observed
  // without the entity; stale knowledge must not become an acquisition oracle.
  for (const kind of ['unaffiliated_population','neutral_units']) for (const [id,entry] of Object.entries(actor.facts[kind]??{})) {
    const collection=kind==='unaffiliated_population'?world.unaffiliatedPopulation:world.neutralUnits;
    if(!visible.has(entry.value.hex_id) || !collection.some(entity=>entity.id===id && entity.hex_id===entry.value.hex_id))delete actor.facts[kind][id];
  }
  for (const id of [...visible].sort()) {
    const h=world.hexes[id]; if (!h) continue;
    recordFact(actor,'hexes',id,publicHex(h),world.turn,source);
    const t=world.territories[h.territory_id]; recordFact(actor,'territories',t.territory_id,publicTerritory(t),world.turn,source);
    discoverPolity(world,actor,t.owner_id,source); discoverPolity(world,actor,t.controller_id,source);
    for (const p of sortedActors(world)) {
      for (const u of p.units.filter(u=>!u.embarked_on && u.hex_id===id && p.id!==actorId)) { discoverPolity(world,actor,p.id,source); recordFact(actor,'units',u.id,{...publicUnit(u,p.id),current_location_known:true},world.turn,source); }
      if (p.id!==actorId && p.citizens.some(g=>!g.embarked_on && g.hex_id===id && g.count>0)) discoverPolity(world,actor,p.id,source);
    }
    for (const f of sortedValues(world.facilities).filter(f=>f.hex_ids.includes(id) && f.hex_ids.every(site=>visible.has(site)))) recordFact(actor,'facilities',f.id,publicFacility(f),world.turn,source);
    for (const g of world.unaffiliatedPopulation.filter(g=>!g.embarked_on && g.hex_id===id).sort((a,b)=>a.id.localeCompare(b.id))) recordFact(actor,'unaffiliated_population',g.id,publicUnaffiliatedPopulation(g),world.turn,source);
    for (const u of world.neutralUnits.filter(u=>!u.embarked_on && u.hex_id===id).sort((a,b)=>a.id.localeCompare(b.id))) recordFact(actor,'neutral_units',u.id,publicNeutralUnit(u),world.turn,source);
  }
}

/** Pure allow-list projection. No foreign lookup uses mere contact as authorization. */
export function projectWorldState(world,actorId) {
  const p=world.polities[actorId]; assert(p,'unknown projection principal');
  const own={id:p.id,name:p.name,alive:p.alive,territory:[...p.territory].sort(),capital_hex_id:p.capital_hex_id,population:p.population,citizens:clone(p.citizens),units:clone(p.units),food:p.food,credits:p.credits,resources:clone(p.resources),technologies:[...p.technologies].sort(),projects:clone(p.projects),shortage:p.shortage,growth_progress:p.growth_progress,advantages:clone(p.advantages),disadvantages:clone(p.disadvantages),takeover:clone(p.takeover),facilities:sortedValues(world.facilities).filter(f=>f.owner_id===actorId).map(clone)};
  const known=clone(p.facts);
  for (const facts of Object.values(known)) for (const entry of Object.values(facts)) entry.age=Math.max(0,world.turn-entry.observed_turn);
  for(const [id,entry] of Object.entries(known.facilities??{}))entry.currently_visible=(p.visible_facility_ids??[]).includes(id);
  const map=Object.fromEntries(Object.entries(known.hexes).map(([id,f])=>[id,clone(f.value)]));
  const territories=Object.fromEntries(Object.entries(known.territories).map(([id,f])=>[id,clone(f.value)]));
  for (const h of sortedValues(world.hexes)) if (world.territories[h.territory_id].owner_id===actorId) { map[h.id]=publicHex(h); territories[h.territory_id]=publicTerritory(world.territories[h.territory_id]); }
  return {own,map,territories,known,channels:sortedValues(world.channels).filter(c=>c.members.includes(actorId)).map(c=>({id:c.id,members:[...c.members]})),messages:clone(p.messages.filter(m=>m.turn===world.turn)),reports:clone(p.reports.filter(r=>r.turn===world.turn)),available_actions:p.alive?clone(world.actionTypes):[]};
}
