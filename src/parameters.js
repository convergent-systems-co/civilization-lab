import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, clone, canonicalize } from "./core.js";
import { assertValidSchema } from "./schema.js";

const registry = JSON.parse(readFileSync(resolve(import.meta.dirname, "../PARAMETER_REGISTRY.spec.json"), "utf8"));
assertValidSchema(registry, "parameter-registry.schema.json");
const required = new Set(["world.map.geometry", "world.economy.resource_production", "world.economy.consumption", "world.economy.starting_credits", "world.population.unit_conversion", "world.combat.coefficients", "world.memory.capacity", "world.phase.action_budget"]);
export function parameterRegistry(config) {
  const result=clone(registry);
  if(config) for(const entry of result.parameters) {
    if(entry.parameter_id==='world.phase.budgets')entry.value=Object.fromEntries(Object.keys(entry.value).map(phase=>[phase,config.phases.actionBudgetMs]));
    if(entry.parameter_id.startsWith("world.configuration.")) {
      const key=entry.parameter_id.slice("world.configuration.".length);
      assert(Object.hasOwn(config,key), "missing configured parameter "+key);
      if(canonicalize(entry.value)!==canonicalize(config[key])) entry.provenance += "; explicit run configuration override (not confirmatory frozen)";
      entry.value=clone(config[key]);
    }
    const aliases={"world.economy.resource_production":{farmer_food_per_turn:config.economy.foodProductionPerFarmer,starting_food:config.economy.startingFood},"world.map.geometry":{width:config.map.width,height:config.map.height,contact_radius:config.map.contactRadius},"world.economy.starting_credits":config.economy.startingCredits,"world.economy.consumption":config.economy.foodPerCitizen,"world.population.unit_conversion":{population_per_unit:config.population.unitSize,recruitment_credit_cost:config.population.recruitmentCost},"world.combat.coefficients":{attack:config.combat.attack,defense:config.combat.defense,terrain_modifier:config.combat.terrainModifier,draw_threshold:config.combat.drawThreshold},"world.memory.capacity":config.memory.capacity,"world.phase.action_budget":config.phases.actionBudgetMs};
    if(Object.hasOwn(aliases,entry.parameter_id)) entry.value=clone(aliases[entry.parameter_id]);
  }
  return result;
}
export function assertPilotConfigRegistered(config) {
  assert(['synthetic','empirical'].includes(config.executionMode),'explicit registered evidence execution mode required');
  assert(config.version.startsWith("pilot-0.1"), "unversioned Pilot 0 configuration");
  assert(config.maxTurns===20 && config.organizations?.enabled===false && config.supply?.enabled===false, "Pilot 0 disabled-feature boundary violated");
  const sections=new Map(registry.parameters.filter(p=>p.parameter_id.startsWith("world.configuration.")).map(p=>[p.parameter_id.slice("world.configuration.".length),p]));
  assert([...sections.keys()].sort().join(",")===Object.keys(config).sort().join(","), "unregistered or missing config sections");
  function shape(value, template, path) {
    assert(value!==undefined && value!==null, "missing parameter "+path);
    if(Array.isArray(template)) { assert(Array.isArray(value),"parameter type mismatch "+path); return; }
    if(template && typeof template==="object") {
      assert(value && typeof value==="object" && !Array.isArray(value),"parameter type mismatch "+path);
      assert(Object.keys(value).sort().join(",")===Object.keys(template).sort().join(","),"unregistered or missing config fields: "+path);
      for(const key of Object.keys(template))shape(value[key],template[key],path+"."+key);
    } else assert(typeof value===typeof template,"parameter type mismatch "+path);
  }
  for(const [key,entry]of sections)shape(config[key],entry.value,key);
  const ids=new Set(registry.parameters.map(p=>p.parameter_id));
  for(const id of required)assert(ids.has(id),"active parameter is not registered: "+id);
  assert(ids.size===registry.parameters.length,"duplicate parameter identifiers");
  assertValidSchema(parameterRegistry(config),"parameter-registry.schema.json"); return true;
}
