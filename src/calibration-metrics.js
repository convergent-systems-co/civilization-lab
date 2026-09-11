import { assert, canonicalize, clone, sha256 } from "./core.js";
import { readEvidencePayload } from "./evidence.js";

export const METRIC_STATUS = Object.freeze({
  OBSERVED: "OBSERVED",
  ZERO_OPPORTUNITY: "ZERO_OPPORTUNITY",
  CENSORED: "CENSORED",
  UNEVALUABLE: "UNEVALUABLE"
});

/**
 * Metrics whose panel statistic is a ratio over the pooled opportunity set.
 * Selector DTOs must retain each run fact's exact numerator, denominator, and
 * eligibility_count for these metrics; averaging already-rounded run ratios can
 * reverse a frozen acceptance decision when seed opportunity counts differ.
 */
export const POOLED_RATIO_METRIC_IDS = Object.freeze(new Set([
  "contact.mean_post_contact_events_per_turn",
  "economy.unused_resource_saturation_rate",
  "population.unit_saturation_rate",
  "population.casualty_recovery_rate",
  "information.detection_event_rate",
  "bandwidth.action_budget_utilization",
  "bandwidth.phase_limit_block_rate",
  "runtime.deadline_failure_rate",
  "relational.repeated_interaction_density"
]));

const RATIO_SCALE = 1_000_000n;

export function divideHalfEven(numerator, denominator) {
  numerator = BigInt(numerator); denominator = BigInt(denominator);
  assert(denominator > 0n, "metric denominator must be positive");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n === 1n)) quotient += 1n;
  return quotient * sign;
}

export function fixedRatio(numerator, denominator, scale = RATIO_SCALE) {
  numerator = BigInt(numerator); denominator = BigInt(denominator);
  assert(denominator > 0n, "metric denominator must be positive");
  const fixed = divideHalfEven(numerator * BigInt(scale), denominator);
  assert(fixed <= BigInt(Number.MAX_SAFE_INTEGER) && fixed >= BigInt(Number.MIN_SAFE_INTEGER), "metric fixed-point overflow");
  return Number(fixed) / Number(scale);
}

export function decimalToScaled(value, scale = RATIO_SCALE) {
  assert(typeof value === "number" && Number.isFinite(value), "metric decimal must be finite");
  const text = String(value); assert(!/[eE]/.test(text), "exponential metric decimal forbidden");
  const negative = text.startsWith("-"), [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt((whole || "0") + fraction) * (negative ? -1n : 1n);
  return divideHalfEven(numerator * BigInt(scale), denominator);
}

export function metricFact({ numerator, denominator = 1, eligibility = denominator, status = METRIC_STATUS.OBSERVED, note = null, categoryCounts = null }) {
  const n = BigInt(numerator), d = BigInt(denominator), e = BigInt(eligibility);
  assert(e >= 0n, "metric eligibility cannot be negative");
  if (status === METRIC_STATUS.OBSERVED) assert(d > 0n, "observed metric requires a positive denominator");
  else assert(d === 0n || status === METRIC_STATUS.CENSORED || status === METRIC_STATUS.UNEVALUABLE, "non-observed metric denominator/status mismatch");
  const scaled = status === METRIC_STATUS.OBSERVED ? divideHalfEven(n * RATIO_SCALE, d).toString() : null;
  return Object.freeze({
    status,
    numerator: n.toString(),
    denominator: d.toString(),
    eligibility_count: e.toString(),
    scaled_value: scaled,
    value: scaled === null ? null : Number(scaled) / Number(RATIO_SCALE),
    ...(categoryCounts ? { category_counts: Object.fromEntries(Object.entries(categoryCounts).sort()) } : {}),
    ...(note ? { note } : {})
  });
}

export function countFact(value) { return metricFact({ numerator: value, denominator: 1, eligibility: 1 }); }
export function indicatorFact(value) { return metricFact({ numerator: value ? 1 : 0, denominator: 1, eligibility: 1 }); }
export function rateFact(numerator, denominator, note = null) {
  if (denominator === 0) return metricFact({ numerator: 0, denominator: 0, eligibility: 0, status: METRIC_STATUS.ZERO_OPPORTUNITY, note });
  return metricFact({ numerator, denominator, eligibility: denominator, note });
}
export function conditionalTurnFact(turn, note) {
  return turn == null
    ? metricFact({ numerator: 0, denominator: 0, eligibility: 0, status: METRIC_STATUS.ZERO_OPPORTUNITY, note })
    : countFact(turn);
}

const definition = (metric_id, source_events, eligibility, numerator, denominator, temporal_rule, zero_rule) => Object.freeze({
  version: "phase-a-calibration-metric-definition-1.0.0", metric_id, source_events, eligibility, numerator, denominator,
  temporal_rule, zero_opportunity_rule: zero_rule, arithmetic: "INTEGER_COUNTS_THEN_BIGINT_ROUND_HALF_EVEN_1E6"
});

/**
 * Closed operational registry for the 32 frozen Phase A metrics. This registry is
 * intentionally executable metadata: every metric artifact binds its definition
 * digest, counts and status, making proxy substitutions detectable.
 */
export const CALIBRATION_METRIC_DEFINITIONS = Object.freeze(Object.fromEntries([
  definition("viability.median_continuation_turn", ["TurnResolved", "RunDisposition"], "complete contiguous resolved turns", "last resolved turn plus one", "one run", "through terminal disposition or turn 20", "UNEVALUABLE for incomplete nonterminal evidence"),
  definition("viability.premature_absorbing_rate", ["RunDisposition", "SnapshotCreated"], "one valid run", "objective absorbing disposition before turn 16", "one run", "terminal turn", "never infer absorption from missing evidence"),
  definition("viability.distinct_state_trajectory_rate", ["SnapshotCreated"], "complete seed panel", "one trajectory hash occurrence", "same-hash occurrence count", "full run", "not applicable"),
  definition("contact.median_first_contact_turn", ["MessageSent", "BattleResolved", "WorldTransition"], "runs with canonical cross-polity contact", "first contact turn", "one run", "first qualifying event", "ZERO_OPPORTUNITY and excluded from conditional median"),
  definition("contact.mean_post_contact_events_per_turn", ["MessageSent", "BattleResolved", "WorldTransition"], "observable turns from first contact", "qualifying post-contact events", "observable post-contact turns", "first contact through terminal", "ZERO_OPPORTUNITY when no contact"),
  definition("contact.meaningful_multi_polity_run_rate", ["MessageSent", "BattleResolved", "WorldTransition"], "one valid run", "at least two distinct qualifying cross-polity interactions", "one run", "full run", "observed zero"),
  definition("economy.median_production_consumption_ratio", ["WorldTransition"], "runs with positive canonical food consumption", "canonical food production", "canonical food consumption", "all economy transitions", "ZERO_OPPORTUNITY when no food consumption"),
  definition("economy.insolvency_or_collapse_rate", ["WorldTransition", "RunDisposition"], "one valid run", "explicit irreversible economy-caused incapacity", "one run", "full run", "observed zero"),
  definition("economy.unused_resource_saturation_rate", ["SnapshotCreated"], "surviving polity-turns", "eligible polity-turns at registered maximum or without consequential spend path", "surviving polity-turns", "all snapshots", "ZERO_OPPORTUNITY when no surviving polity-turn"),
  definition("technology.median_first_completion_turn", ["SnapshotCreated"], "runs with verified technology acquisition", "first acquisition turn", "one run", "first authoritative before/after technology-set gain", "ZERO_OPPORTUNITY and excluded from conditional median"),
  definition("technology.no_completion_rate", ["SnapshotCreated"], "one valid run", "no verified technology acquisition", "one run", "full run", "observed zero/one"),
  definition("technology.trivial_completion_rate", ["SnapshotCreated"], "one valid run", "verified acquisition before turn 3", "one run", "first authoritative acquisition", "observed zero"),
  definition("population.recruitment_feasible_run_rate", ["SnapshotCreated"], "one valid run", "any surviving polity-turn satisfying registered unit, facility, technology and resource prerequisites", "one run", "full run", "observed zero"),
  definition("population.depletion_rate", ["SnapshotCreated"], "one valid run", "affiliated population including unit crews falls by at least 75% before turn 16", "one run", "turns 1-15", "observed zero"),
  definition("population.unit_saturation_rate", ["SnapshotCreated"], "surviving polity-turns with affiliated population", "polity-turns with more than 60% of affiliated population in unit crews", "eligible polity-turns", "all snapshots", "ZERO_OPPORTUNITY when no affiliated population"),
  definition("population.casualty_recovery_rate", ["PopulationUnitTransition"], "canonical loss/destruction transitions", "eligible loss transitions causally followed by demobilization/recovery", "eligible losses", "full causal history", "ZERO_OPPORTUNITY when no eligible loss"),
  definition("conflict.mean_battles_per_run", ["BattleResolved"], "one valid run", "canonical battles", "one run", "full run", "observed zero"),
  definition("conflict.annihilation_rate", ["WorldTransition"], "one valid run", "polity_elimination before turn 16", "one run", "turns 1-15", "observed zero"),
  definition("conflict.perpetual_conflict_rate", ["BattleResolved", "TurnResolved"], "runs with ten observable terminal-window turns", "battle present in at least eight of final ten turns", "one run", "final ten observable turns", "CENSORED when fewer than ten turns"),
  definition("conflict.dominant_action_share", ["ActionSubmitted", "ActionAccepted", "TurnCommitted"], "accepted non-wait strategic actions", "largest accepted action-type count", "all accepted non-wait strategic actions", "full lineage", "ZERO_OPPORTUNITY when no eligible action"),
  definition("information.median_discovery_turn", ["WorldTransition", "SnapshotCreated"], "runs with verified new external-polity knowledge", "first discovery turn", "one run", "first before/after knowledge-set gain", "ZERO_OPPORTUNITY and excluded from conditional median"),
  definition("information.detection_event_rate", ["SnapshotCreated"], "surviving multi-polity run-turns", "new canonical activity-detection reports", "eligible run-turns", "snapshot deltas", "ZERO_OPPORTUNITY when detection impossible"),
  definition("information.early_saturation_rate", ["SnapshotCreated"], "one valid run", "all discoverable external polities known before turn 5", "one run", "turns 1-4", "observed zero"),
  definition("information.permanent_isolation_rate", ["SnapshotCreated"], "one valid run", "no external polity discovered by turn 12", "one run", "turns 1-12", "observed one for isolation"),
  definition("bandwidth.action_budget_utilization", ["ActionAccepted", "ActionSubmitted", "TurnCommitted", "RunCreated", "SnapshotCreated"], "registered slots for alive action-capable actors in each immutable pre-resolution committed state", "accepted non-wait actions", "pre-resolution eligible actors multiplied by the registered action limit", "each committed turn, using RunCreated state for turn 0 and the preceding turn snapshot thereafter", "ZERO_OPPORTUNITY when no eligible actors"),
  definition("bandwidth.phase_limit_block_rate", ["ActionRejected"], "otherwise-valid action attempts plus accepted actions", "otherwise-valid attempts rejected solely for action_limit_exceeded", "eligible attempts", "full run", "ZERO_OPPORTUNITY when no attempts"),
  definition("runtime.deadline_failure_rate", ["WorldTransition"], "canonical participant/controller phase opportunities", "phase transitions closed by deadline with missing required participants or outputs", "canonical interactive/interview phase closures", "full controller lineage", "ZERO_OPPORTUNITY when no phase opportunities"),
  definition("relational.median_commitment_opportunities", ["SnapshotCreated"], "identified contacted dyad-turns with a permitted communication/action affordance", "treatment-neutral commitment measurement opportunities", "one run", "full run", "observed zero; formed promises and endpoint coding are not required"),
  definition("relational.median_reciprocity_opportunities", ["MessageSent","WorldTransition","BattleResolved"], "cross-polity initiating actions with five-turn observation window", "eligible reciprocity measurement opportunities", "one run", "five-turn window", "observed zero"),
  definition("relational.rupture_opportunity_run_rate", ["BattleResolved","WorldTransition"], "one valid run", "at least one hostile rupture with sufficient repair observation", "one run", "rupture-attributed window", "observed zero"),
  definition("relational.repeated_interaction_density", ["MessageSent","WorldTransition","BattleResolved"], "observable post-contact turns", "repeated same-dyad canonical interactions", "observable post-contact turns", "full linked history", "ZERO_OPPORTUNITY when no contact window"),
  definition("relational.zero_opportunity_run_rate", ["SnapshotCreated","MessageSent","WorldTransition","BattleResolved"], "one valid run", "zero commitment-affordance, reciprocity and rupture measurement opportunities", "one run", "full run", "observed one for structural zero")
].map(item => [item.metric_id, item])));

export const CALIBRATION_METRIC_DEFINITION_HASH = sha256(CALIBRATION_METRIC_DEFINITIONS);

export function assertMetricArtifact(metrics, protocol) {
  assert(canonicalize(Object.keys(metrics).sort()) === canonicalize(protocol.metrics.map(item => item.metric_id).sort()), "metric artifact inventory mismatch");
  for (const [id, fact] of Object.entries(metrics)) {
    assert(CALIBRATION_METRIC_DEFINITIONS[id], `unknown metric definition: ${id}`);
    assert(fact && Object.values(METRIC_STATUS).includes(fact.status), `invalid metric status: ${id}`);
    assert(/^[-]?\d+$/.test(fact.numerator) && /^\d+$/.test(fact.denominator) && /^\d+$/.test(fact.eligibility_count), `invalid metric counts: ${id}`);
    assert(fact.definition_hash === sha256(CALIBRATION_METRIC_DEFINITIONS[id]), `metric definition binding mismatch: ${id}`);
    if (fact.status === METRIC_STATUS.OBSERVED) {
      assert(typeof fact.value === "number" && Number.isFinite(fact.value) && /^-?\d+$/.test(fact.scaled_value ?? "") && BigInt(fact.denominator) > 0n, `invalid observed metric: ${id}`);
      assert(BigInt(fact.scaled_value) === divideHalfEven(BigInt(fact.numerator) * RATIO_SCALE, BigInt(fact.denominator)), `metric fixed-point value mismatch: ${id}`);
    } else assert(fact.value === null && fact.scaled_value === null, `non-observed metric has a value: ${id}`);
  }
  return true;
}

export function bindMetricDefinitions(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([id, fact]) => [id, Object.freeze({
    ...clone(fact), definition_hash: sha256(CALIBRATION_METRIC_DEFINITIONS[id])
  })]));
}

const body = event => { const { payload_ref: ignored, ...value } = event.payload ?? {}; return value; };
const participants = event => new Set([...(event.participants ?? []), body(event).from, body(event).to, ...(body(event).actor_ids ?? [])].filter(Boolean));
const crossPolity = event => participants(event).size >= 2;
const sum = values => values.reduce((total, value) => total + value, 0);
const alive = polity => polity?.alive !== false;
const groups = polity => Array.isArray(polity?.citizens) ? polity.citizens : [];
const units = polity => Array.isArray(polity?.units) ? polity.units : [];
const crewCount = unit => Array.isArray(unit?.crew) ? sum(unit.crew.map(group => group.count ?? 0)) : (unit?.citizens ?? 0);
const affiliatedPopulation = polity => sum(groups(polity).map(group => group.count ?? 0)) + sum(units(polity).map(crewCount));
const totalAffiliated = state => sum(Object.values(state.polities ?? {}).map(affiliatedPopulation));
const knownPolities = polity => new Set([
  ...(polity.knowledge ?? []),
  ...Object.keys(polity.facts?.polities ?? {}),
  ...Object.keys(polity.facts?.actors ?? {})
]);

function consequentialSpendPath(polity, configuration, facilities) {
  const ownsFacility = type => Object.values(facilities ?? {}).some(item => item.owner_id === polity.id && item.type === type && item.destroyed !== true);
  const eligible = rule => (rule.prerequisites ?? []).every(id => (polity.technologies ?? []).includes(id)) &&
    (polity.credits ?? 0) >= (rule.credits ?? 0) && (polity.food ?? 0) >= (rule.food ?? 0) &&
    Object.entries(rule.resources ?? {}).every(([id, quantity]) => (polity.resources?.[id] ?? 0) >= quantity);
  return Object.values(configuration.unitTypes ?? {}).some(rule => ownsFacility(rule.facility) && (polity.population ?? affiliatedPopulation(polity)) >= rule.citizens && eligible(rule)) ||
    Object.values(configuration.facilityTypes ?? {}).some(eligible) || Object.values(configuration.technologies ?? {}).some(eligible);
}

function recruitmentAvailable(polity, configuration, facilities) {
  return Object.values(configuration.unitTypes ?? {}).some(rule => {
    const ownsRequired = Object.values(facilities ?? {}).some(item => item.owner_id === polity.id && item.type === rule.facility && item.destroyed !== true);
    return ownsRequired && (rule.prerequisites ?? []).every(id => (polity.technologies ?? []).includes(id)) &&
      sum(groups(polity).map(group => group.count ?? 0)) >= rule.citizens && (polity.credits ?? 0) >= rule.credits &&
      Object.entries(rule.resources ?? {}).every(([id, quantity]) => (polity.resources?.[id] ?? 0) >= quantity);
  });
}

function acceptedActionTypes(events) {
  const canonicalActions = new Map();
  for (const event of events.filter(item => item.event_type === "ActionSubmitted")) {
    // ActionAccepted names the canonical IDs minted by ActionLedger, never a
    // participant-supplied label from submitted_actions.
    for (const action of body(event).actions ?? []) canonicalActions.set(action.action_id, action.type);
  }
  const accepted = new Set(events.filter(item => item.event_type === "ActionAccepted").flatMap(item => body(item).accepted_action_ids ?? []));
  // Empty-submission turns legitimately have no ActionAccepted event. Never infer
  // acceptance from ActionSubmitted or database order.
  const counts = new Map();
  for (const id of accepted) {
    const type = canonicalActions.get(id); assert(type, "accepted action lacks canonical ActionSubmitted lineage");
    if (type !== "wait") counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return { counts, acceptedNonWait: sum([...counts.values()]), acceptedCount: accepted.size };
}

function relationalFacts(store, snapshots) {
  const events = store.events, lastTurn = Math.max(-1, ...events.map(event => event.turn));
  const commitments = [];
  for (const snapshot of snapshots) for (const [actorId, polity] of Object.entries(snapshot.state.polities ?? {})) {
    if (!alive(polity) || polity.permanently_action_incapable === true) continue;
    for (const other of [...knownPolities(polity)].filter(id => id !== actorId && alive(snapshot.state.polities?.[id])).sort())
      commitments.push({ actor_id: actorId, counterparty_id: other, turn: snapshot.event.turn,
        basis: "AUTHORIZED_CONTACT_AND_PARTICIPANT_ACTION_AFFORDANCE" });
  }
  const interactionEvents = events.filter(event => crossPolity(event) && (event.event_type === "MessageSent" || event.event_type === "BattleResolved" ||
    event.event_type === "WorldTransition" && ["transfer","share_technology","hostile_action","channels","diplomacy_phase_command"].includes(body(event).mechanic)));
  const interactions = interactionEvents.flatMap(event => {
    const ids = [...participants(event)].sort();
    return ids.length >= 2 ? [{ event, actor_id: body(event).from ?? ids[0], counterparty_id: body(event).to ?? ids[1] }] : [];
  });
  const reciprocity = interactions.filter(item => item.event.turn + 5 <= lastTurn);
  const ruptures = events.filter(event => (event.event_type === "BattleResolved" ||
    event.event_type === "WorldTransition" && body(event).mechanic === "hostile_action") && event.turn + 5 <= lastTurn).map(event => ({ event }));
  return { commitments, reciprocity, ruptures, interactions };
}

/** Derive all per-run metric facts from already authenticated canonical evidence. */
export function deriveCalibrationMetricFacts({ store, snapshots, configuration, synthetic }) {
  const events = store.events;
  const states = snapshots.map(item => item.state);
  const genesis = events.find(event => event.event_type === "RunCreated");
  assert(genesis?.payload?.initial_state_ref, "calibration metrics require RunCreated initial state");
  const first = readEvidencePayload(store, body(genesis).initial_state_ref), last = states.at(-1);
  const resolvedTurns = [...new Set(events.filter(event => event.event_type === "TurnResolved").map(event => event.turn))].sort((a, b) => a - b);
  const continuation = resolvedTurns.length;
  const disposition = events.filter(event => event.event_type === "RunDisposition").at(-1);
  const dispositionReason = body(disposition ?? {}).replacement_policy?.reason ?? null;
  const objectiveEarly = continuation < 16 && ["insufficient_surviving_distinct_participants", "all_remaining_permanently_action_incapable"].includes(dispositionReason);

  const contactMechanics = new Set(["transfer", "transfer_unit", "transfer_population", "share_technology", "hostile_action"]);
  const channelContact = event => {
    if (event.event_type !== "WorldTransition" || body(event).mechanic !== "channels") return false;
    const before = readEvidencePayload(store, body(event).before_state_ref);
    const after = readEvidencePayload(store, body(event).after_state_ref);
    return Object.values(after ?? {}).some(channel => {
      const prior = new Set(before?.[channel.id]?.members ?? []), members = new Set(channel.members ?? []);
      return members.size >= 2 && (!before?.[channel.id] || [...members].some(id => !prior.has(id)));
    });
  };
  const contacts = events.filter(event => (crossPolity(event) && (event.event_type === "MessageSent" || event.event_type === "BattleResolved" ||
    (event.event_type === "WorldTransition" && contactMechanics.has(body(event).mechanic)))) || channelContact(event));
  const firstContactTurn = contacts.length ? Math.min(...contacts.map(event => event.turn + 1)) : null;
  const postContactTurns = firstContactTurn == null ? 0 : continuation - firstContactTurn + 1;
  const contactKeys = new Set(contacts.map(event => `${event.event_type}:${event.event_id}`));

  const economy = events.filter(event => event.event_type === "WorldTransition" && body(event).mechanic === "economy");
  let produced = 0, consumed = 0;
  const latestEconomyByActor = new Map();
  for (const event of economy) {
    const detail = body(event).detail;
    assert(Number.isSafeInteger(detail?.consumption) && detail.consumption >= 0, "economy metric requires canonical integer consumption");
    const production = detail.production ?? {}, amount = production.food ?? 0;
    assert(Number.isSafeInteger(amount) && amount >= 0, "economy metric requires canonical integer food production");
    produced += amount; consumed += detail.consumption;
    for (const actorId of body(event).actor_ids ?? []) latestEconomyByActor.set(actorId, event);
  }
  const dispositionProvesEconomyCollapse = dispositionReason === "all_remaining_permanently_action_incapable" &&
    Object.values(last?.polities ?? {}).filter(alive).length > 0 &&
    Object.values(last.polities).filter(alive).every(polity => {
      const event = latestEconomyByActor.get(polity.id), detail = body(event ?? {}).detail;
      if (polity.permanently_action_incapable !== true || !(detail?.deficit > 0) || !body(event).after_state_ref) return false;
      const after = readEvidencePayload(store, body(event).after_state_ref);
      return affiliatedPopulation(after) === 0;
    });
  const economyCollapse = dispositionProvesEconomyCollapse;
  const maxQuantity = configuration.dynamics?.maxQuantity;
  assert(Number.isSafeInteger(maxQuantity) && maxQuantity > 0, "resource metric requires registered maximum quantity");
  let saturated = 0, resourceTurns = 0;
  for (const state of states) {
    const surviving = Object.values(state.polities ?? {}).filter(alive);
    for (const polity of surviving) {
      resourceTurns++;
      const balances = [polity.food ?? 0, polity.credits ?? 0, ...Object.values(polity.resources ?? {})];
      if (balances.some(value => value >= maxQuantity) || !consequentialSpendPath(polity, configuration, state.facilities)) saturated++;
    }
  }

  const technologyCompletions = [];
  for (let index = 0; index < snapshots.length; index++) {
    const before = index === 0 ? first : snapshots[index - 1].state, after = snapshots[index].state;
    for (const [id, polity] of Object.entries(after.polities ?? {})) {
      const prior = new Set(before.polities?.[id]?.technologies ?? []);
      if ((polity.technologies ?? []).some(technology => !prior.has(technology))) technologyCompletions.push(snapshots[index].event.turn + 1);
    }
  }
  const firstTechnology = technologyCompletions.length ? Math.min(...technologyCompletions) : null;

  const recruitmentFeasible = states.some(state => Object.values(state.polities ?? {}).some(polity => alive(polity) && recruitmentAvailable(polity, configuration, state.facilities)));
  const initialPopulation = totalAffiliated(first);
  const depletion = snapshots.some(item => item.event.turn + 1 < 16 && initialPopulation > 0 && totalAffiliated(item.state) * 4 <= initialPopulation);
  let unitSaturatedTurns = 0, unitEligibleTurns = 0;
  for (const state of states) {
    const surviving = Object.values(state.polities ?? {}).filter(alive);
    for (const polity of surviving) {
      const affiliated = affiliatedPopulation(polity); if (!affiliated) continue;
      const unitCrews = sum(units(polity).map(crewCount));
      unitEligibleTurns++; if (unitCrews * 10 > affiliated * 6) unitSaturatedTurns++;
    }
  }
  const losses = events.filter(event => event.event_type === "PopulationUnitTransition" && ["loss", "destruction", "death"].includes(body(event).transition));
  const recoveries = events.filter(event => event.event_type === "PopulationUnitTransition" && ["demobilization", "return_to_population", "recovery"].includes(body(event).transition));
  // Recovery is a later polity-level population/unit transition, not an
  // impossible claim that a destroyed crew itself demobilized. Canonical event
  // order and shared polity lineage establish the longitudinal relationship.
  const recoveredLosses = losses.filter(loss => recoveries.some(recovery => recovery.sequence > loss.sequence &&
    recovery.turn >= loss.turn && [...participants(loss)].some(id => participants(recovery).has(id)))).length;

  const battles = events.filter(event => event.event_type === "BattleResolved");
  const annihilation = events.some(event => event.event_type === "WorldTransition" && body(event).mechanic === "polity_elimination" && event.turn + 1 < 16);
  const finalTen = resolvedTurns.slice(-10), battleTurns = new Set(battles.map(event => event.turn));
  const perpetual = finalTen.length === 10 && finalTen.filter(turn => battleTurns.has(turn)).length >= 8;
  const action = acceptedActionTypes(events);
  const dominant = action.acceptedNonWait ? Math.max(...action.counts.values()) : 0;

  const discoveryTurns = [];
  for (let index = 0; index < snapshots.length; index++) {
    const previousState = index === 0 ? first : snapshots[index - 1].state;
    for (const id of Object.keys(snapshots[index].state.polities ?? {})) {
      const prior = knownPolities(previousState.polities?.[id] ?? {}), next = knownPolities(snapshots[index].state.polities?.[id] ?? {});
      if ([...next].some(other => other !== id && !prior.has(other))) discoveryTurns.push(snapshots[index].event.turn + 1);
    }
  }
  const firstDiscovery = discoveryTurns.length ? Math.min(...discoveryTurns) : null;
  let detectionEvents = 0, detectionEligibleTurns = 0;
  for (let index = 0; index < snapshots.length; index++) {
    const state = snapshots[index].state, priorState = index === 0 ? first : snapshots[index - 1].state;
    if (Object.values(state.polities ?? {}).filter(alive).length >= 2) detectionEligibleTurns++;
    for (const id of Object.keys(state.polities ?? {})) {
      const prior = new Set((priorState.polities?.[id]?.reports ?? []).filter(item => item.source === "activity_detection").map(sha256));
      detectionEvents += (state.polities[id]?.reports ?? []).filter(item => item.source === "activity_detection" && !prior.has(sha256(item))).length;
    }
  }
  const discoverableIds = Object.keys(first.polities ?? {});
  const earlySaturation = snapshots.filter(item => item.event.turn + 1 < 5).some(item => discoverableIds.every(id => {
    const polity = item.state.polities?.[id]; return !polity || discoverableIds.every(other => other === id || knownPolities(polity).has(other));
  }));
  const isolatedAt12 = discoverableIds.every(id => !snapshots.filter(item => item.event.turn < 12).some(item => [...knownPolities(item.state.polities?.[id] ?? {})].some(other => other !== id)));

  const actionLimit = configuration.phases?.actionLimit;
  assert(Number.isSafeInteger(actionLimit) && actionLimit > 0, "bandwidth metric requires registered action limit");
  const snapshotByTurn = new Map(snapshots.map(item => [item.event.turn, item.state]));
  const committedTurns = events.filter(event => event.event_type === "TurnCommitted").map(event => event.turn);
  assert(new Set(committedTurns).size === committedTurns.length, "bandwidth metric requires unique committed turns");
  const availableSlots = committedTurns.reduce((total, turn) => {
    const preResolutionState = turn === 0 ? first : snapshotByTurn.get(turn - 1);
    assert(preResolutionState, `bandwidth metric lacks canonical pre-resolution state for turn ${turn}`);
    const eligibleActors = Object.values(preResolutionState.polities ?? {})
      .filter(polity => alive(polity) && polity.permanently_action_incapable !== true).length;
    return total + eligibleActors * actionLimit;
  }, 0);
  const rejectionEvents = events.filter(event => event.event_type === "ActionRejected");
  const soleLimitBlocks = rejectionEvents.filter(event => {
    const errors = body(event).errors ?? [];
    return errors.length > 0 && errors.every(error => error.code === "action_limit_exceeded");
  }).reduce((total, event) => total + (body(event).submitted_action_count ?? body(event).actions?.length ?? 1), 0);
  const eligibleAttempts = action.acceptedCount + soleLimitBlocks;

  const phaseClosures = events.filter(event => event.event_type === "WorldTransition" && body(event).mechanic === "turn_phase_state" &&
    ["phase_advanced", "turn_closed", "isolated_interviews_complete"].includes(body(event).detail?.reason));
  const deadlineFailures = phaseClosures.filter(event => body(event).detail?.deadline_reached === true &&
    (body(event).detail?.missing_actor_ids?.length ?? 0) > 0).length;

  const relational = relationalFacts(store, snapshots);
  const dyads = new Map();
  for (const item of relational.interactions) {
    const value = item.value ?? item, from = value.from ?? value.actor_id, to = value.to ?? value.counterparty_id;
    if (!from || !to) continue; const key = [from, to].sort().join("|"); dyads.set(key, (dyads.get(key) ?? 0) + 1);
  }
  const repeated = sum([...dyads.values()].map(count => Math.max(0, count - 1)));
  const postContactObservable = firstContactTurn == null ? 0 : continuation - firstContactTurn + 1;

  return bindMetricDefinitions({
    "viability.median_continuation_turn": countFact(continuation),
    "viability.premature_absorbing_rate": indicatorFact(objectiveEarly),
    "viability.distinct_state_trajectory_rate": countFact(1),
    "contact.median_first_contact_turn": conditionalTurnFact(firstContactTurn, "NO_CANONICAL_CONTACT"),
    "contact.mean_post_contact_events_per_turn": rateFact(contactKeys.size, postContactTurns, "NO_CANONICAL_CONTACT"),
    "contact.meaningful_multi_polity_run_rate": indicatorFact(contacts.length >= 2),
    "economy.median_production_consumption_ratio": rateFact(produced, consumed, "NO_CANONICAL_CONSUMPTION"),
    "economy.insolvency_or_collapse_rate": indicatorFact(economyCollapse),
    "economy.unused_resource_saturation_rate": rateFact(saturated, resourceTurns, "NO_SURVIVING_POLITY_TURNS"),
    "technology.median_first_completion_turn": conditionalTurnFact(firstTechnology, "NO_VERIFIED_COMPLETION"),
    "technology.no_completion_rate": indicatorFact(firstTechnology == null),
    "technology.trivial_completion_rate": indicatorFact(firstTechnology != null && firstTechnology < 3),
    "population.recruitment_feasible_run_rate": indicatorFact(recruitmentFeasible),
    "population.depletion_rate": indicatorFact(depletion),
    "population.unit_saturation_rate": rateFact(unitSaturatedTurns, unitEligibleTurns, "NO_AFFILIATED_POPULATION_TURNS"),
    "population.casualty_recovery_rate": rateFact(recoveredLosses, losses.length, "NO_ELIGIBLE_LOSSES"),
    "conflict.mean_battles_per_run": countFact(battles.length),
    "conflict.annihilation_rate": indicatorFact(annihilation),
    "conflict.perpetual_conflict_rate": finalTen.length === 10 ? indicatorFact(perpetual) : metricFact({ numerator: 0, denominator: 0, eligibility: 0, status: METRIC_STATUS.CENSORED, note: "FEWER_THAN_TEN_OBSERVABLE_TURNS" }),
    "conflict.dominant_action_share": metricFact({ numerator: dominant, denominator: action.acceptedNonWait,
      eligibility: action.acceptedNonWait, status: action.acceptedNonWait ? METRIC_STATUS.OBSERVED : METRIC_STATUS.ZERO_OPPORTUNITY,
      note: action.acceptedNonWait ? null : "NO_ACCEPTED_NON_WAIT_ACTIONS", categoryCounts: Object.fromEntries(action.counts) }),
    "information.median_discovery_turn": conditionalTurnFact(firstDiscovery, "NO_EXTERNAL_POLITY_DISCOVERY"),
    "information.detection_event_rate": rateFact(detectionEvents, detectionEligibleTurns, "NO_ELIGIBLE_MULTI_POLITY_TURNS"),
    "information.early_saturation_rate": indicatorFact(earlySaturation),
    "information.permanent_isolation_rate": indicatorFact(isolatedAt12),
    "bandwidth.action_budget_utilization": rateFact(action.acceptedNonWait, availableSlots, "NO_AVAILABLE_ACTION_SLOTS"),
    "bandwidth.phase_limit_block_rate": rateFact(soleLimitBlocks, eligibleAttempts, "NO_ELIGIBLE_ACTION_ATTEMPTS"),
    "runtime.deadline_failure_rate": rateFact(deadlineFailures, phaseClosures.length, "NO_CONTROLLER_PHASE_OPPORTUNITIES"),
    "relational.median_commitment_opportunities": countFact(relational.commitments.length),
    "relational.median_reciprocity_opportunities": countFact(relational.reciprocity.length),
    "relational.rupture_opportunity_run_rate": indicatorFact(relational.ruptures.length > 0),
    "relational.repeated_interaction_density": rateFact(repeated, postContactObservable, "NO_OBSERVABLE_POST_CONTACT_TURNS"),
    "relational.zero_opportunity_run_rate": indicatorFact(relational.commitments.length === 0 && relational.reciprocity.length === 0 && relational.ruptures.length === 0)
  });
}
