import { readFileSync } from 'node:fs';
import { assert, canonicalize, clone, sha256 } from './core.js';
import { assertValidSchema } from './schema.js';
import { assertParticipantActionPayload } from './action-contract.js';
import { ACTION_CONTRACT_HASH } from './contracts.js';
import { readEvidencePayload } from './evidence.js';

const source = JSON.parse(readFileSync(new URL('../config/phase-a-policy-package.json', import.meta.url), 'utf8'));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const PHASE_A_POLICY_PACKAGE = freeze(source);
export const PHASE_A_POLICY_PACKAGE_HASH = sha256(source);
export const PHASE_A_ROLE_IDS = Object.freeze(source.roles.map(role => role.policy_id));
export const PHASE_A_POLICY_MANIFEST = freeze({
  version: 'phase-a-neutral-policy-1.0.0', policy_id: source.package_id,
  policy_package_id: source.package_id, policy_package_version: source.package_version,
  policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
  policy_class: 'SCRIPTED_HETEROGENEOUS_POLICY', treatment_neutral: true, treatment_allocation: 'NONE',
  persistence_history_access: 'NONE', treatment_labels_exposed: false, calibration_objectives_exposed: false,
  model_use_declared: false,
  context_contract_hash: sha256(JSON.parse(readFileSync(new URL('../PROJECTION_POLICY.spec.json', import.meta.url), 'utf8'))),
  action_contract_hash: ACTION_CONTRACT_HASH
});
export const PHASE_A_NEUTRAL_CONDITION = freeze({
  schema_version: '1.0.0', condition_id: source.package_id,
  model_runtime: { model_artifact_hash: 'not-used-phase-a', tokenizer_hash: 'not-used-phase-a',
    runtime_hash: 'not-used-phase-a', template_hash: 'not-used-phase-a', sampling: {} },
  prompts: { system_hash: 'none', developer_hash: 'none', task_hash: PHASE_A_POLICY_PACKAGE_HASH,
    neutrality_check_ref: 'phase-a-policy-package.json', context_segment_policy: { trusted_instruction: 'none',
      authorized_projection: 'projection_only', untrusted_world_text: 'data_only', tool_result: 'disabled' },
    rendered_input_capture_policy: 'not_applicable_no_model', output_capture_policy: 'not_applicable_no_model' },
  tools: [], information_access: { projection_schema: 'authorized-projection.schema.json', principal: 'own_polity',
    logical_time_policy: 'current_phase', redaction_policy: 'PROJECTION_POLICY.spec.json' },
  action_space: { schema_hash: 'participant-action-contract', validation_scope: 'authorized_projection', error_policy: 'deterministic' },
  context_constraints: { token_budget: 0, time_budget: 'world.config.phases.actionBudgetMs', computation_budget: {}, ordering_policy: 'deterministic_policy' },
  retry: { max_attempts: 1, late_output_policy: 'not_applicable', partial_output_policy: 'not_applicable', idempotency_policy: 'execution_intent' },
  memory: { mode: 'state_only', persistence: 'none', capacity: 'world.config.memory.capacity', operations: [],
    overflow_policy: 'not_applicable', transformation_recording: 'none' },
  identity: { experimental_identity_policy: 'stable_across_conditions', persistent_identity_policy: 'stable_across_run',
    persistence_treatment_policy: 'none', history_access_policy: 'none', lineage_schema: 'identity-lineage.schema.json' },
  session: { incarnation_policy: 'one_deterministic_policy_session_per_run', resident_context_policy: 'disabled', recovery_policy: 'explicit_replay' },
  interface: { human_projection: 'not_applicable', ai_projection: 'projection_only', parity_policy: 'participant_action_contract', deviation_recording: 'canonical_provenance' },
  declared_treatments: [], invariant_dimensions: ['projection','action_space','policy_package']
});

export function assertPhaseANeutralCondition(condition) {
  assertValidSchema(condition, 'agent-condition.schema.json');
  assert(sha256(condition) === sha256(PHASE_A_NEUTRAL_CONDITION), 'Phase A neutral condition mismatch');
  return PHASE_A_NEUTRAL_CONDITION;
}

const exactKeys = (value, keys, label) => assert(value && !Array.isArray(value) &&
  canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort()), `${label} closed input contract violated`);

export function validatePhaseAPolicyPackage(value) {
  assertValidSchema(value, 'phase-a-policy-package.schema.json');
  assert(canonicalize(value) === canonicalize(source), 'Phase A policy package differs from frozen package');
  assert(new Set(value.roles.map(role => role.policy_id)).size === 8, 'Phase A roles must be unique');
  assert(value.model_use_declared === false && value.model_use === 'PROHIBITED', 'Phase A model use prohibited');
  return true;
}

export function assignCalibrationPolicies(input) {
  exactKeys(input, ['participant_ids', 'seed', 'seed_panel'], 'policy assignment');
  const participants = [...input.participant_ids].sort();
  assert(participants.length > 0 && new Set(participants).size === participants.length, 'unique calibration participants required');
  const seedIndex = input.seed_panel.indexOf(input.seed);
  assert(seedIndex >= 0, 'seed outside frozen seed panel');
  const assignment = {};
  for (let index = 0; index < participants.length; index++)
    assignment[participants[index]] = PHASE_A_ROLE_IDS[(seedIndex * participants.length + index) % PHASE_A_ROLE_IDS.length];
  return freeze(assignment);
}

export function calibrationPolicyRequestBinding(input) {
  exactKeys(input, ['participant_ids', 'seed', 'seed_panel'], 'policy request binding');
  const assignment = assignCalibrationPolicies(input);
  return freeze({ schema_version: 'phase-a-policy-request-binding-1.0.0',
    policy_package_id: PHASE_A_POLICY_PACKAGE.package_id,
    policy_package_version: PHASE_A_POLICY_PACKAGE.package_version,
    policy_package_hash: PHASE_A_POLICY_PACKAGE_HASH,
    assignment_algorithm: PHASE_A_POLICY_PACKAGE.assignment.algorithm,
    assignment, assignment_hash: sha256(assignment), model_use_declared: false });
}

const field = (projection, path) => projection.fields.find(item => item.path === path)?.value;
const sorted = values => [...values].sort((a, b) => String(a.id ?? a).localeCompare(String(b.id ?? b)));
const adjacent = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r))) === 1;
const action = value => { assertParticipantActionPayload(value); return value; };

function expansion(view) {
  const explorer = sorted(view.own.citizens.filter(group => group.count > 0 && group.assignment === 'Explorer' && !group.training && !group.embarked_on))[0];
  const annexable = sorted(Object.values(view.territories).filter(territory => territory.status === 'controlled' &&
    territory.controller_id === view.own.id && territory.owner_id !== view.own.id))[0];
  if (annexable) return action({ type: 'annex', territory_id: annexable.territory_id });
  const claimable = sorted(Object.values(view.territories).filter(territory => territory.owner_id !== view.own.id &&
    territory.status !== 'contested' && view.own.citizens.some(group =>
      view.map[group.hex_id]?.territory_id === territory.territory_id)))[0];
  if (claimable) return action({ type: 'claim', territory_id: claimable.territory_id });
  if (explorer) {
    const origin = view.map[explorer.hex_id];
    const destinations = sorted(Object.values(view.map).filter(hex => adjacent(origin, hex) && hex.terrain !== 'water'));
    const external = destinations.filter(hex => hex.territory_id !== explorer.territory_id);
    const choices = external.length ? external : destinations;
    if (choices.length) return action({ type: 'explore', citizen_id: explorer.id, hex_id: choices[view.turn % choices.length].id });
  }
  const mobile = sorted(view.own.citizens.filter(group => group.count > 0 && !group.training && !group.embarked_on))[0];
  if (mobile) {
    const origin = view.map[mobile.hex_id], destination = sorted(Object.values(view.map).filter(hex => adjacent(origin, hex) && hex.terrain !== 'water' && hex.territory_id !== mobile.territory_id))[0];
    if (destination) return action({ type: 'move_population', citizen_id: mobile.id, hex_id: destination.id });
  }
  return null;
}
function economy(view) {
  const builders = sorted(view.own.citizens.filter(group => group.count > 0 && group.assignment === 'Builder' && !group.training && !group.embarked_on));
  const explorer = sorted(view.own.citizens.filter(group => group.count > 0 && group.assignment === 'Explorer' && !group.training && !group.embarked_on))[0];
  const incomplete = sorted(view.own.facilities.filter(item => item.condition > 0 && item.construction_progress < item.required_progress &&
    builders.some(group => item.hex_ids.includes(group.hex_id))))[0];
  if (incomplete) return action({ type: 'resume_construction', facility_id: incomplete.id,
    builder_ids: builders.filter(group => incomplete.hex_ids.includes(group.hex_id)).map(group => group.id) });
  const population = view.own.citizens.reduce((total, item) => total + item.count, 0);
  const assignable = sorted(view.own.citizens.filter(group => group.count > 0 && !group.training && !group.embarked_on && group.assignment !== 'Farmer'))[0];
  const agriculture = sorted(view.own.facilities.filter(item => item.type === 'agriculture' && item.condition > 0 && assignable && item.hex_ids.includes(assignable.hex_id)))[0];
  if (view.own.food < population * 2 && assignable && agriculture)
    return action({ type: 'reassign', citizen_id: assignable.id, assignment: 'Farmer', count: 1, facility_id: agriculture.id });
  const knownDeposits = view.intelligence.facts.deposits ?? {};
  if (explorer && !knownDeposits[explorer.hex_id]) return action({ type: 'prospect', citizen_id: explorer.id, hex_id: explorer.hex_id });
  const buildHex = sorted(Object.values(view.map).filter(hex => hex.terrain !== 'water' &&
    view.territories[hex.territory_id]?.status === 'controlled' && view.territories[hex.territory_id]?.owner_id === view.own.id &&
    builders.some(group => group.hex_id === hex.id) && !view.own.facilities.some(item => item.hex_ids.includes(hex.id))))[0];
  if (buildHex && view.rules.facilities?.industrial) return action({ type: 'build', facility_type: 'industrial',
    hex_ids: [buildHex.id], builder_ids: builders.filter(group => group.hex_id === buildHex.id).map(group => group.id) });
  const industrial = sorted(view.own.facilities.filter(item => item.type === 'industrial' && item.condition > 0 &&
    item.construction_progress >= item.required_progress && builders.some(group => item.hex_ids.includes(group.hex_id))))[0];
  if (industrial && view.turn > 0 && view.turn % 4 === 0) return action({ type: 'upgrade', facility_id: industrial.id,
    builder_ids: builders.filter(group => industrial.hex_ids.includes(group.hex_id)).map(group => group.id) });
  // Once productive capacity has been added, keep its builders in place until
  // the deterministic upgrade cadence. Otherwise an always-available adjacent
  // movement would starve the role's declared investment/upgrade behavior.
  if (industrial && view.own.facilities.filter(item => item.type === 'industrial' && item.condition > 0).length > 1) return null;
  const builder = builders[0], origin = builder && view.map[builder.hex_id];
  const developmentSite = origin && sorted(Object.values(view.map).filter(hex => adjacent(origin, hex) && hex.terrain !== 'water' &&
    view.territories[hex.territory_id]?.status === 'controlled' && view.territories[hex.territory_id]?.owner_id === view.own.id &&
    !view.own.facilities.some(item => item.hex_ids.includes(hex.id))))[0];
  if (builder && developmentSite) return action({ type: 'move_population', citizen_id: builder.id, hex_id: developmentSite.id });
  return null;
}
function technology(view) {
  const facility = sorted(view.own.facilities.filter(item => item.type === 'research' && item.condition > 0))[0];
  const scientists = sorted(view.own.citizens.filter(group => group.count > 0 && group.assignment === 'Scientist' && !group.training && !group.embarked_on));
  const artifact = sorted([...view.own.facilities, ...view.own.units].filter(item => item.captured_from))[0];
  const reversible = artifact && Object.entries(view.rules.technologies).filter(([id, spec]) => !view.own.technologies.includes(id) &&
    spec.prerequisites.every(required => view.own.technologies.includes(required)) && (artifact.prerequisites ?? []).includes(id)).sort(([a], [b]) => a.localeCompare(b))[0];
  if (facility && scientists.length && reversible) return action({ type: 'reverse_engineer', technology: reversible[0], facility_id: facility.id,
    artifact_id: artifact.id, scientist_ids: scientists.map(group => group.id) });
  const available = Object.entries(view.rules.technologies).filter(([id, spec]) => !view.own.technologies.includes(id) &&
    spec.prerequisites.every(id => view.own.technologies.includes(id))).sort(([a], [b]) => a.localeCompare(b))[0];
  if (facility && scientists.length && available) return action({ type: 'research', technology: available[0], facility_id: facility.id,
    scientist_ids: scientists.map(group => group.id) });
  const peer = sorted(view.knowledge.filter(id => id !== view.own.id))[0];
  if (peer && view.own.technologies.length) return action({ type: 'share_technology', to: peer,
    technology: [...view.own.technologies].sort()[0] });
  return null;
}
function defense(view) {
  const peers = sorted(view.knowledge.filter(id => id !== view.own.id));
  const unit = sorted(view.own.units.filter(item => !item.embarked_on))[0];
  if (unit && unit.fortified !== true) return action({ type: 'fortify', unit_id: unit.id });
  const facility = sorted(view.own.facilities.filter(item => item.type === 'ground_military' && item.condition > 0))[0];
  const soldiers = sorted(view.own.citizens.filter(group => group.count > 0 && group.assignment === 'Soldier' && !group.training && !group.embarked_on &&
    facility?.hex_ids.includes(group.hex_id)));
  if (!unit && facility && soldiers.length) return action({ type: 'recruit', unit_type: 'infantry', facility_id: facility.id, citizen_ids: soldiers.map(group => group.id) });
  if (peers[0] && view.own.credits > 0) return action({ type: 'intelligence', to: peers[0] });
  if (view.own.technologies.includes('satellites')) {
    const target = sorted(Object.values(view.map))[0];
    if (target) return action({ type: 'reconnaissance', hex_id: target.id });
  }
  return null;
}
function conservative(view) {
  const visibleThreat = Object.values(view.intelligence.facts.units ?? {}).some(fact => fact.currently_visible !== false && fact.value?.owner_id !== view.own.id);
  const unit = sorted(view.own.units.filter(item => !item.embarked_on && item.fortified !== true))[0];
  if (visibleThreat && unit) return action({ type: 'fortify', unit_id: unit.id });
  return null;
}
function aggressive(view) {
  const unit = sorted(view.own.units.filter(item => !item.embarked_on))[0];
  const targets = sorted(Object.values(view.intelligence.facts.units ?? {}).filter(fact => fact.currently_visible !== false && fact.value?.owner_id !== view.own.id).map(fact => fact.value));
  if (unit && targets[0]) {
    const origin = view.map[unit.hex_id], destination = view.map[targets[0].hex_id];
    const range = view.rules.units?.[unit.type]?.range ?? 1;
    const distance = origin && destination ? Math.max(Math.abs(origin.q-destination.q),Math.abs(origin.r-destination.r),Math.abs((origin.q+origin.r)-(destination.q+destination.r))) : Infinity;
    if (distance <= range) return action({ type: 'attack', unit_id: unit.id, target_unit_id: targets[0].id });
    const step = sorted(Object.values(view.map).filter(hex => adjacent(origin, hex) && hex.terrain !== 'water')).filter(hex =>
      Math.max(Math.abs(hex.q-destination.q),Math.abs(hex.r-destination.r),Math.abs((hex.q+hex.r)-(destination.q+destination.r))) < distance)[0];
    if (step) return action({ type: 'move', unit_id: unit.id, hex_id: step.id });
  }
  return defense(view) ?? expansion(view);
}
function cooperative(view, diplomacy) {
  const peers = sorted(view.knowledge.filter(id => id !== view.own.id));
  if (diplomacy && peers[0]) return action({ type: 'message', to: peers[0], text: 'Phase A deterministic coverage communication.' });
  if (diplomacy) return action({ type: 'broadcast', text: 'Phase A deterministic coverage communication.' });
  if (peers[0] && view.own.technologies.length && view.turn % 3 === 2)
    return action({ type: 'share_technology', to: peers[0], technology: [...view.own.technologies].sort()[0] });
  if (peers[0] && view.own.credits > 1) return action({ type: 'transfer', to: peers[0], resource: 'credits', amount: 1 });
  return expansion(view);
}

export function decideCalibrationActions(input) {
  exactKeys(input, ['projection', 'policy_id', 'applicable_configuration'], 'policy decision');
  assertValidSchema(input.projection, 'authorized-projection.schema.json');
  assert(PHASE_A_ROLE_IDS.includes(input.policy_id), 'unknown Phase A policy identity');
  const paths = new Set(input.projection.fields.map(item => item.path));
  assert(['own.polity_state','own.knowledge','public.known_map','public.known_territories','own.intelligence','authorized.messages','authorized.channels','own.available_actions','public.rules']
    .every(path => paths.has(path)), 'authorized projection schema lacks policy fields');
  assert(canonicalize(input.applicable_configuration) === canonicalize(field(input.projection, 'public.rules')), 'policy configuration is not projection-authorized');
  const view = { turn: input.projection.logical_time.turn, own: clone(field(input.projection, 'own.polity_state')), knowledge: clone(field(input.projection, 'own.knowledge')),
    map: clone(field(input.projection, 'public.known_map')), territories: clone(field(input.projection, 'public.known_territories')),
    intelligence: clone(field(input.projection, 'own.intelligence')), rules: clone(input.applicable_configuration.rules) };
  const diplomacy = ['diplomacy'].includes(input.projection.logical_time.phase);
  let chosen = null;
  if (input.policy_id === 'EXPANSION_EXPLORATION') chosen = expansion(view);
  else if (input.policy_id === 'ECONOMIC_DEVELOPMENT') chosen = economy(view);
  else if (input.policy_id === 'TECHNOLOGY_DEVELOPMENT') chosen = technology(view);
  else if (input.policy_id === 'DEFENSIVE_SECURITY') chosen = defense(view);
  else if (input.policy_id === 'COMPETITIVE_AGGRESSIVE') chosen = aggressive(view);
  else if (input.policy_id === 'COOPERATIVE_EXCHANGE') chosen = cooperative(view, diplomacy);
  else if (input.policy_id === 'OPPORTUNISTIC_MIXED') {
    const visibleThreat = Object.values(view.intelligence.facts.units ?? {}).some(fact => fact.currently_visible !== false && fact.value?.owner_id !== view.own.id);
    const population = view.own.citizens.reduce((total, group) => total + group.count, 0);
    if (visibleThreat) chosen = aggressive(view);
    else if (view.own.food < population || view.own.credits < 2) chosen = economy(view);
    else if (view.knowledge.some(id => id !== view.own.id)) chosen = cooperative(view, diplomacy);
    else chosen = expansion(view);
  } else chosen = conservative(view);
  if (diplomacy && !['message','promise','broadcast','channel_create','channel_invite','channel_leave'].includes(chosen?.type)) return [];
  if (!diplomacy && ['message','promise','broadcast','channel_create','channel_invite','channel_leave'].includes(chosen?.type)) return [];
  return freeze([chosen ?? action({ type: 'wait' })]);
}

const COVERAGE_PREDICATES = Object.freeze({
  movement: ({actionTypes}) => ['move','move_population','explore'].some(type => actionTypes.has(type)),
  discovery_contact: ({knowledgeTransitions,actionTypes}) => knowledgeTransitions > 0 &&
    ['explore','reconnaissance','broadcast'].some(type => actionTypes.has(type)),
  economy: ({mechanics}) => mechanics.has('economy'),
  facilities: ({mechanics}) => ['build','resume_construction','upgrade'].some(type => mechanics.has(type)),
  population_transitions: ({events}) => events.some(event => event.event_type === 'PopulationUnitTransition'),
  recruitment: ({events}) => events.some(event => event.event_type === 'PopulationUnitTransition' && event.payload.transition === 'recruitment'),
  technology: ({mechanics}) => ['research','research_outcome','reverse_engineer','reverse_engineer_outcome'].some(type => mechanics.has(type)),
  detection_intelligence: ({mechanics,events}) => mechanics.has('intelligence') && events.some(event => event.event_type === 'RNGDraw' && event.payload.subsystem === 'intelligence'),
  resource_exchange: ({mechanics}) => mechanics.has('transfer') || mechanics.has('share_technology'),
  communication: ({events}) => events.some(event => event.event_type === 'MessageSent'),
  territory_claims: ({events}) => events.some(event => event.event_type === 'TerritoryTransition' && ['claim','capture'].includes(event.payload.transition)),
  contested_territory: ({events}) => events.some(event => event.event_type === 'TerritoryTransition' && event.payload.status === 'contested'),
  combat: ({events}) => events.some(event => event.event_type === 'BattleResolved'),
  casualties: ({events}) => events.some(event => event.event_type === 'PopulationUnitTransition' && ['loss','destruction','death'].includes(event.payload.transition)),
  conquest: ({events}) => events.some(event => event.event_type === 'TerritoryTransition' && event.payload.transition === 'capture'),
  elimination: ({mechanics}) => mechanics.has('polity_elimination'),
  peaceful_repeated_interaction: ({events}) => {
    const counts = new Map();
    for (const event of events.filter(event => event.event_type === 'MessageSent' && new Set(event.participants).size > 1)) {
      const key = [...new Set(event.participants)].sort().join(':'); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.values()].some(count => count >= 2);
  }
});

/**
 * Validate reducer-backed synthetic coverage. This function deliberately does
 * not manufacture actions or claim coverage from the policy declaration. Each
 * supplied store must have verified its canonical bundle, and every exercised
 * action must be both submitted and accepted in that same canonical history.
 */
export function validateSyntheticPolicyCoverage(input) {
  exactKeys(input, ['evidence_stores'], 'synthetic policy coverage');
  assert(Array.isArray(input.evidence_stores) && input.evidence_stores.length > 0, 'reducer-backed evidence stores required');
  const events = []; let knowledgeTransitions = 0;
  for (const store of input.evidence_stores) {
    assert(store && typeof store.verify === 'function' && Array.isArray(store.events), 'canonical evidence store required');
    store.verify(); events.push(...store.events);
    for (const event of store.events.filter(event => event.event_type === 'WorldTransition' && event.payload.mechanic === 'atomic_committed_turn')) {
      const before = readEvidencePayload(store, event.payload.before_state_ref), after = readEvidencePayload(store, event.payload.after_state_ref);
      for (const id of Object.keys(after.polities ?? {})) {
        const prior = new Set(before.polities?.[id]?.knowledge ?? []), next = new Set(after.polities[id]?.knowledge ?? []);
        if ([...next].some(other => other !== id && !prior.has(other))) knowledgeTransitions++;
      }
    }
  }
  assert(!events.some(event => event.event_type === 'ModelInvocation'), 'Qwen/model evidence prohibited in Phase A coverage');
  assert(!events.some(event => event.event_type === 'BehaviorCoded' || event.event_type === 'CommitmentCoded'), 'endpoint coding prohibited in Phase A coverage');
  const accepted = new Set(events.filter(event => event.event_type === 'ActionAccepted').flatMap(event => event.payload.accepted_action_ids));
  const submitted = events.filter(event => event.event_type === 'ActionSubmitted').flatMap(event => event.payload.actions ?? []);
  const exercised = submitted.filter(action => accepted.has(action.action_id));
  assert(exercised.length > 0, 'coverage requires accepted reducer actions');
  const context = { events, knowledgeTransitions, actionTypes: new Set(exercised.map(action => action.type)),
    mechanics: new Set(events.filter(event => event.event_type === 'WorldTransition').map(event => event.payload.mechanic)) };
  const covered = Object.entries(COVERAGE_PREDICATES).filter(([,predicate]) => predicate(context)).map(([id]) => id).sort();
  const missing = source.expected_mechanics_coverage.filter(id => !covered.includes(id)).sort();
  assert(missing.length === 0, `reducer-backed policy coverage missing: ${missing.join(', ')}`);
  return freeze({ status:'PASS', covered_mechanics:covered, exercised_action_types:[...context.actionTypes].sort(),
    canonical_event_count:events.length, qwen_invocations:0, endpoint_metrics_computed:0, evidence_class:'SYNTHETIC_REDUCER_BACKED_FIXTURE' });
}

validatePhaseAPolicyPackage(PHASE_A_POLICY_PACKAGE);
