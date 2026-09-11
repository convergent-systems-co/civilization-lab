import { readFileSync } from 'node:fs';
import { assert, canonicalize, clone, sha256 } from './core.js';
import { calibrationProtocol } from './calibration.js';
import { assertPilotConfigRegistered, parameterRegistry } from './parameters.js';

const model = JSON.parse(readFileSync(new URL('../config/pilot0-model.json', import.meta.url), 'utf8'));
export const PHASE_A_MODEL_RUNTIME_LOCK = Object.freeze({
  source: model.source, repository: model.repository, revision: model.revision, model_kind: model.model_kind,
  tokenizer_repository: model.repository, tokenizer_revision: model.revision, source_configuration: clone(model),
  source_configuration_hash: sha256(model), model_artifact_hash: model.model_artifact_hash,
  tokenizer_hash: model.tokenizer_hash, runtime_hash: model.runtime_hash, runtime: model.runtime, dtype: model.dtype,
  backend: model.artifact_manifest.runtime_manifest.backend, runner_hash: model.artifact_manifest.runtime_manifest.runner_hash,
  config_sha256: model.artifact_manifest.runtime_manifest.config_sha256,
  trust_remote_code: model.artifact_manifest.runtime_manifest.trust_remote_code,
  adapters: clone(model.artifact_manifest.runtime_manifest.adapters),
  dynamic_weights: model.artifact_manifest.runtime_manifest.dynamic_weights, device: model.device,
  quantization: model.quantization, generation: clone(model.generation), context_budget: model.context_budget,
  max_attempts: model.max_attempts, attempt_timeout_ms: model.attempt_timeout_ms, chat_template: model.chat_template
});
export const PHASE_A_MODEL_RUNTIME_LOCK_HASH = sha256(PHASE_A_MODEL_RUNTIME_LOCK);

export function materializePhaseARuntime(candidate) {
  const registry = parameterRegistry(), expected = registry.parameters.map(entry => entry.parameter_id).sort();
  assert(candidate && canonicalize(Object.keys(candidate).sort()) === canonicalize(expected),
    'unauthorized or missing calibration parameter');
  const effective_configuration = {
    version: candidate['world.configuration.version'], executionMode: candidate['world.configuration.executionMode'],
    maxTurns: candidate['world.configuration.maxTurns'], map: clone(candidate['world.configuration.map']),
    economy: clone(candidate['world.configuration.economy']), population: clone(candidate['world.configuration.population']),
    combat: clone(candidate['world.configuration.combat']), memory: clone(candidate['world.configuration.memory']),
    phases: clone(candidate['world.configuration.phases']), geography: clone(candidate['world.configuration.geography']),
    assignments: clone(candidate['world.configuration.assignments']), dynamics: clone(candidate['world.configuration.dynamics']),
    startingProfiles: clone(candidate['world.configuration.startingProfiles']), facilityTypes: clone(candidate['world.configuration.facilityTypes']),
    technologies: clone(candidate['world.configuration.technologies']), unitTypes: clone(candidate['world.configuration.unitTypes']),
    initialFacilityTypes: clone(candidate['world.configuration.initialFacilityTypes']), organizations: clone(candidate['world.configuration.organizations']),
    supply: clone(candidate['world.configuration.supply']), worldCalibration: clone(candidate['world.configuration.worldCalibration'])
  };
  assertPilotConfigRegistered(effective_configuration);
  return Object.freeze({ parameter_set_hash: sha256(candidate), effective_configuration,
    effective_configuration_hash: sha256(effective_configuration), phase_budget_overrides: clone(candidate['world.phase.budgets']),
    protocol_hash: sha256(calibrationProtocol()), parameter_registry_hash: sha256(registry) });
}
