import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorld,PILOT_0_CONFIG} from '../src/world.js';
import {AgentRuntime,DeterministicModel} from '../src/agent.js';
import {parameterRegistry} from '../src/parameters.js';
import {phaseBudgetManifest,TURN_PHASES} from '../src/turn-phases.js';

test('world genesis records explicit execution classification without authorizing empirical model execution',()=>{
  const synthetic=makeWorld({runId:'synthetic-mode-registry-fixture'});
  assert.equal(synthetic.config.executionMode,'synthetic');
  const config=structuredClone(PILOT_0_CONFIG);config.executionMode='empirical';
  // Declaration/admission fixture only: no turn, participant or model is run.
  const declared=makeWorld({runId:'synthetic-admission-only-fixture',config});
  assert.equal(parameterRegistry(declared.config).parameters.find(p=>p.parameter_id==='world.configuration.executionMode').value,'empirical');
  assert.throws(()=>new AgentRuntime({world:declared,actorId:'polity-1',model:new DeterministicModel('fixture')}),/synthetic model prohibited/);
  assert.throws(()=>new AgentRuntime({world:declared,actorId:'polity-1',model:new DeterministicModel('fixture'),executionMode:'synthetic'}),/execution mode conflicts/);
  config.executionMode='confirmatory';assert.throws(()=>makeWorld({config}),/execution mode/);
});
test('every effective phase budget retains its registered provisional provenance',()=>{
  const world=makeWorld({runId:'synthetic-phase-registry'});
  const manifest=phaseBudgetManifest(world,{diplomacy:700});
  assert.equal(manifest.registry_entry.parameter_id,'world.phase.budgets');
  assert.equal(manifest.registry_entry.classification,'WORLD_CALIBRATION');
  assert.equal(manifest.registry_entry.status,'PROVISIONAL');
  assert.deepEqual(manifest.registry_entry.value,manifest.value);
  assert.equal(manifest.value.diplomacy,700);
  for(const phase of TURN_PHASES.filter(p=>p!=='diplomacy'))assert.equal(manifest.value[phase],world.config.phases.actionBudgetMs);
  assert.deepEqual(phaseBudgetManifest(world,manifest.value),manifest);
  const defaults=phaseBudgetManifest(world);assert.deepEqual(phaseBudgetManifest(world,defaults.value),defaults);
});
