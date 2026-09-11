import { assert, canonicalize, clone, sha256, stableId } from './core.js';
import { assertValidSchema } from './schema.js';
import { makeWorld } from './world.js';
import { ActionLedger } from './contracts.js';
import { executeTurnPhaseCommand } from './turn-phases.js';
import { reconstructRun } from './replay.js';
import { calibrationProtocol } from './calibration.js';
import { PHASE_A_MODEL_RUNTIME_LOCK_HASH, materializePhaseARuntime } from './calibration-runtime.js';
import {
  PHASE_A_NEUTRAL_CONDITION, PHASE_A_POLICY_MANIFEST, PHASE_A_POLICY_PACKAGE, PHASE_A_POLICY_PACKAGE_HASH,
  assertPhaseANeutralCondition, assignCalibrationPolicies, calibrationPolicyRequestBinding, decideCalibrationActions, validatePhaseAPolicyPackage
} from './calibration-policy.js';

const VERSION = 'phase-a-production-adapter-1.0.0';
const PROTOCOL_HASH = sha256(calibrationProtocol());
const REQUEST_FIELDS = Object.freeze(['schema_version','mode','calibrationRunId','attemptId','idempotencyKey','seed','parameterSet',
  'runtimeConfiguration','maxTurns','objectiveTerminalPredicates','neutralPolicyManifest','modelRuntimeLock','policyBinding',
  'adapterContractHash','adapterPackageHash']);
const DIPLOMACY = new Set(['message','promise','broadcast','channel_create','channel_invite','channel_leave']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const field = (projection, path) => projection.fields.find(item => item.path === path)?.value;

function validateRequest(request, executionMode) {
  assert(request && canonicalize(Object.keys(request).sort()) === canonicalize([...REQUEST_FIELDS].sort()), 'closed execution request input contract violated; prohibited fields present');
  assert(request.schema_version === 'phase-a-execution-request-1.0.0' && request.mode === executionMode, 'execution request mode/version mismatch');
  assert(request.maxTurns === 20, 'Phase A execution requires exactly 20 turns');
  const protocol = calibrationProtocol();
  assert(protocol.seed_panel.seeds.includes(request.seed), 'seed outside frozen seed panel');
  const materialized = materializePhaseARuntime(request.parameterSet);
  assert(canonicalize(materialized) === canonicalize(request.runtimeConfiguration), 'runtime configuration differs from registered parameter materialization');
  assert(canonicalize(request.objectiveTerminalPredicates) === canonicalize(request.parameterSet['world.termination.objective_predicates']), 'terminal predicates differ from registered parameter set');
  const participants = Object.keys(materialized.effective_configuration.startingProfiles).map((_, index) => `polity-${index + 1}`);
  const expectedPolicyBinding = calibrationPolicyRequestBinding({ participant_ids: participants, seed: request.seed,
    seed_panel: protocol.seed_panel.seeds });
  assert(canonicalize(request.policyBinding) === canonicalize(expectedPolicyBinding), 'execution request policy package/assignment binding mismatch');
  if (executionMode === 'SYNTHETIC_CONFORMANCE') assert(request.neutralPolicyManifest === null && request.modelRuntimeLock === null, 'policy/model substitution prohibited in synthetic conformance');
  else {
    assert(request.neutralPolicyManifest && canonicalize(request.neutralPolicyManifest) === canonicalize(PHASE_A_POLICY_MANIFEST), 'execution request policy manifest mismatch');
    assert(request.modelRuntimeLock && sha256(request.modelRuntimeLock) === PHASE_A_MODEL_RUNTIME_LOCK_HASH,
      'execution request model runtime lock mismatch');
  }
  return materialized;
}

function executionBinding(request, materialized, assignment, adapterHash, adapterPackageDigest) {
  const assignmentHash = sha256(assignment), requestHash = sha256(request);
  const binding = { schema_version: 'phase-a-execution-binding-1.0.0', calibration_run_id: request.calibrationRunId,
    attempt_id: request.attemptId, execution_intent_id: request.idempotencyKey, execution_request_hash: requestHash,
    execution_mode: request.mode, synthetic: request.mode === 'SYNTHETIC_CONFORMANCE',
    calibration_parameter_set_hash: materialized.parameter_set_hash,
    effective_configuration_hash: materialized.effective_configuration_hash,
    protocol_hash: PROTOCOL_HASH,
    adapter_version: VERSION, adapter_package_hash: adapterPackageDigest ?? adapterHash,
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH, assignment_algorithm: PHASE_A_POLICY_PACKAGE.assignment.algorithm,
    assignment, assignment_hash: assignmentHash, calibration_policy_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST), model_runtime_lock_hash: PHASE_A_MODEL_RUNTIME_LOCK_HASH,
    model_use_declared: false, objective_terminal_predicates: clone(request.objectiveTerminalPredicates), max_turns: 20, seed: request.seed };
  assertValidSchema(binding, 'phase-a-execution-binding.schema.json');
  return freeze(binding);
}

function actorLineage(world, actorId) {
  return { persistent_identity_id: actorId, session_id: stableId('phase-a-policy-session', world.runId, actorId),
    invocation_id: stableId('phase-a-policy-decision', world.runId, world.turn, world.phase, actorId) };
}

function runCommand(context, operation, input = {}, at = context.at) {
  const result = executeTurnPhaseCommand({ world: context.world, ledger: context.ledger, state: context.state,
    bindings: context.bindings, command: { operation, input }, at, conditionValidator: assertPhaseANeutralCondition });
  context.state = result.phaseState; context.at = at; return result.result;
}

function policyProjection(context, actorId) {
  const projection = runCommand(context, 'projection', { actorId });
  const applicable = field(projection, 'public.rules');
  const actions = decideCalibrationActions({ projection, policy_id: context.assignment[actorId], applicable_configuration: applicable });
  return { projection, actions };
}

function executeLifecycleTurn(context) {
  runCommand(context, 'begin', { budgetsMs: context.phaseBudgets }, context.at);
  while (!context.state.closed) {
    const phase = context.state.phase;
    const active = Object.keys(context.assignment).filter(id => context.world.polities[id]?.alive).sort();
    if (['observation','private_planning','diplomacy','final_planning','consequence_reveal'].includes(phase)) {
      for (const actorId of active) {
        const { actions } = policyProjection(context, actorId);
        if (phase === 'diplomacy') {
          const command = actions.find(item => DIPLOMACY.has(item.type));
          if (command) runCommand(context, 'diplomacy', { actorId, actor: actorLineage(context.world, actorId),
            requestId: stableId('phase-a-diplomacy', context.world.runId, context.state.turn, actorId), command });
        }
        if (phase === 'final_planning') runCommand(context, 'submit', { actorId,
          actor: actorLineage(context.world, actorId), actions: actions.filter(item => !DIPLOMACY.has(item.type)) });
        runCommand(context, 'ready', { actorId });
      }
      runCommand(context, 'advance');
    } else if (phase === 'interview') {
      runCommand(context, 'complete_interviews', {}, context.state.deadline_at);
      runCommand(context, 'advance', {}, context.state.deadline_at);
    } else runCommand(context, 'advance');
  }
}

class MemoryIntentJournal {
  #records = new Map();
  async get(key) { return this.#records.has(key) ? clone(this.#records.get(key)) : null; }
  async put(key, value) { const prior = this.#records.get(key); if (prior) assert(sha256(prior) === sha256(value), 'execution intent result mutation'); else this.#records.set(key, clone(value)); }
}

export function createPhaseAProductionAdapter({ executionMode = 'EMPIRICAL_CALIBRATION', journal = null,
  evidenceAuthority = null, workerTimeoutMs = null, evidenceAuthorityTimeoutMs = null, fault = async () => {} } = {}) {
  assert(['SYNTHETIC_CONFORMANCE','EMPIRICAL_CALIBRATION'].includes(executionMode), 'invalid Phase A adapter mode');
  validatePhaseAPolicyPackage(PHASE_A_POLICY_PACKAGE);
  if (executionMode === 'SYNTHETIC_CONFORMANCE' && journal === null) journal = new MemoryIntentJournal();
  if (executionMode === 'EMPIRICAL_CALIBRATION') {
    assert(journal?.durable === true && typeof journal.get === 'function' && typeof journal.put === 'function', 'empirical adapter requires durable intent journal infrastructure');
    assert(evidenceAuthority?.trustDomain === 'EXTERNAL_EVIDENCE_AUTHORITY' && typeof evidenceAuthority.finalize === 'function',
      'empirical adapter requires an isolated evidence authority infrastructure');
    assert(Number.isSafeInteger(workerTimeoutMs) && workerTimeoutMs > 0 && Number.isSafeInteger(evidenceAuthorityTimeoutMs) && evidenceAuthorityTimeoutMs > 0,
      'empirical adapter requires signed deterministic deadlines');
  }
  let adapterHash = null;
  async function execute(request, workerContext = {}) {
    const materialized = validateRequest(request, executionMode), prior = await journal.get(request.idempotencyKey);
    if (prior) { assert(prior.request_hash === sha256(request), 'execution request changed for existing intent'); return clone(prior.result); }
    assert(request.adapterContractHash === adapterHash, 'execution request does not bind this adapter contract');
    if (executionMode === 'EMPIRICAL_CALIBRATION') assert(request.adapterPackageHash === workerContext.adapterPackageDigest &&
      /^[a-f0-9]{64}$/.test(request.adapterPackageHash), 'execution request does not bind the signed adapter package');
    else assert(request.adapterPackageHash === null, 'synthetic execution cannot claim an empirical adapter package');
    const participants = Object.keys(materialized.effective_configuration.startingProfiles).map((_, index) => `polity-${index + 1}`);
    const assignment = assignCalibrationPolicies({ participant_ids: participants, seed: request.seed, seed_panel: calibrationProtocol().seed_panel.seeds });
    assert(sha256(assignment) === request.policyBinding.assignment_hash, 'adapter assignment differs from authorized request binding');
    const binding = executionBinding(request, materialized, assignment, adapterHash, workerContext.adapterPackageDigest);
    const runId = stableId('phase-a-world-run', request.calibrationRunId, request.attemptId, request.seed);
    const world = makeWorld({ runId, seed: request.seed, config: materialized.effective_configuration, executionBinding: binding });
    const bindings = Object.keys(world.polities).sort().map(actorId => ({ actorId,
      sessionId: stableId('phase-a-policy-session', world.runId, actorId), condition: clone(PHASE_A_NEUTRAL_CONDITION) }));
    const context = { world, ledger: new ActionLedger(world.evidence), bindings, assignment, state: null, at: 0,
      phaseBudgets: materialized.phase_budget_overrides };
    while (world.turn < 20 && !world.evidence.events.some(event => event.event_type === 'RunDisposition')) executeLifecycleTurn(context);
    const objectiveReasons = new Set(request.objectiveTerminalPredicates);
    assert(world.terminal && (world.turn === 20 && world.terminationReason === 'pilot_cap' ||
      world.turn < 20 && objectiveReasons.has(world.terminationReason)),
    'Phase A adapter did not reach the fixed cap or an authorized objective absorbing state');
    assert(world.evidence.events.at(-1)?.event_type === 'RunDisposition', 'final lifecycle must end in canonical disposition');
    assert(!world.evidence.events.some(event => event.event_type === 'ModelInvocation'), 'Qwen/model invocation prohibited in initial Phase A');
    const bundle = world.evidence.bundle();
    const replayed = reconstructRun(bundle, { conditionValidator: assertPhaseANeutralCondition });
    assert(replayed.world.stateHash() === world.stateHash() && replayed.resolvedTurns === world.turn, 'independent Phase A replay mismatch');
    await fault('after_exact_replay_before_seal', { execution_intent_id: request.idempotencyKey, evidence_hash: sha256(bundle) });
    let result = bundle;
    if (executionMode === 'EMPIRICAL_CALIBRATION') {
      const finalized = await evidenceAuthority.finalize({ execution_intent_id: request.idempotencyKey,
        request_hash: sha256(request), bundle: clone(bundle), request: clone(request), binding: clone(binding), adapterHash,
        adapterPackageDigest: workerContext.adapterPackageDigest });
      // The authority client verifies and strips its transport-level intent
      // binding before exposing the closed adapter-result payload.
      result = clone(finalized);
    }
    await fault('after_authority_finalize', { execution_intent_id: request.idempotencyKey, evidence_hash: sha256(bundle) });
    if (executionMode !== 'EMPIRICAL_CALIBRATION') await journal.put(request.idempotencyKey, { request_hash: sha256(request), result });
    await fault('after_journal', { execution_intent_id: request.idempotencyKey, evidence_hash: sha256(bundle) });
    return clone(result);
  }

  async function recover(request, workerContext = {}) {
    validateRequest(request, executionMode);
    const prior = await journal.get(request.idempotencyKey);
    if (prior) { assert(prior.request_hash === sha256(request), 'execution request changed for existing intent'); return clone(prior.result); }
    return execute(request, workerContext);
  }
  const contract = freeze({ version: VERSION, mode: executionMode, treatment_neutral: true, model_use_declared: false,
    seed_panel_hash: sha256(calibrationProtocol().seed_panel.seeds), max_turns: 20,
    execute_sha256: sha256(execute.toString()),
    policy_manifest_hash: sha256(PHASE_A_POLICY_MANIFEST), policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id, policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    model_runtime_lock_hash: PHASE_A_MODEL_RUNTIME_LOCK_HASH,
    worker_timeout_ms: workerTimeoutMs, evidence_authority_timeout_ms: evidenceAuthorityTimeoutMs,
    execution_recovery: 'IDEMPOTENT_RECOVER_BY_EXECUTION_INTENT',
    assignment_algorithm: PHASE_A_POLICY_PACKAGE.assignment.algorithm, evidence_authority: 'EXTERNAL_ISOLATED' });
  adapterHash = sha256(contract);
  return Object.freeze({ contract, execute, recover, durableIntentConformance: true });
}
