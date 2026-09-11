// Adversarial verification of the Phase A calibration search: that it is the frozen bounded
// deterministic coordinate grid, that its hard bounds halt rather than widen the search, and
// that the parameter registry is the single source of every candidate parameter set.
//
// This suite drives only exports that already exist — it adds no runtime surface.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sha256, canonicalize } from "../src/core.js";
import { calibrationProtocol, enumerateCalibrationOperations } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import {
  PhaseACalibrationRunner,
  assertCalibrationTransition,
  reconstructCalibrationSearch,
  startingCalibrationParameterSet,
  validateCalibrationParameterSet
} from "../src/calibration-runner.js";
import { syntheticCanonicalEvidence, withTempArchive } from "./helpers/calibration-fixture.js";

const protocol = calibrationProtocol();
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const specification = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

// The frozen protocol declares each domain's grid with these metadata keys; every other key of
// an `allowed_domain` is a selector field whose declared value array drives enumeration order.
const DOMAIN_METADATA = new Set(["kind", "minimum", "maximum", "step", "multipliers", "rounding", "must_equal",
  "fixed_fields", "preserve_profile_permutation_balance", "preserve_targets_prerequisites_domains",
  "permille_minimum", "permille_maximum", "positive_integer_minimum", "success_permille_minimum",
  "success_permille_maximum", "turn_minimum"]);

// Registry parameters the runner keeps in lockstep through `synchronizeAliases`. A single frozen
// operation may touch several identifiers inside one group — `world.phase.action_budget`,
// `world.phase.budgets` and `world.configuration.phases.actionBudgetMs` are the same knob under
// three registered names — so "exactly one change" is measured per group, not per identifier.
const ALIAS_GROUPS = [
  ["world.map.geometry", "world.configuration.map"],
  ["world.economy.resource_production", "world.economy.consumption", "world.economy.starting_credits", "world.configuration.economy"],
  ["world.population.unit_conversion", "world.configuration.population"],
  ["world.combat.coefficients", "world.configuration.combat"],
  ["world.memory.capacity", "world.configuration.memory"],
  ["world.phase.action_budget", "world.phase.budgets", "world.configuration.phases"]
];

function changedGroups(incumbent, candidate) {
  const changed = Object.keys(incumbent).filter(id => canonicalize(incumbent[id]) !== canonicalize(candidate[id]));
  return new Set(changed.map(id => {
    const group = ALIAS_GROUPS.findIndex(members => members.includes(id));
    return group === -1 ? id : `alias-group:${group}`;
  }));
}

function operation(domainId, predicate) {
  const found = enumerateCalibrationOperations().find(item => item.domain_id === domainId && predicate(item));
  assert.ok(found, `frozen grid no longer declares the operation this test drives: ${domainId}`);
  return found;
}

/** The starting set with one already-synchronized edit applied, as `applyOperation` would leave it. */
function edited(mutate) {
  const candidate = startingCalibrationParameterSet();
  mutate(candidate);
  return candidate;
}

const passingMetric = metric => metric.acceptance.minimum !== undefined ? metric.acceptance.minimum : metric.acceptance.maximum;
const violatingMetric = metric => metric.acceptance.minimum !== undefined ? metric.acceptance.minimum - 1 : metric.acceptance.maximum + 1;
const metricsWith = overrides => Object.fromEntries(protocol.metrics.map(metric =>
  [metric.metric_id, Object.hasOwn(overrides, metric.metric_id) ? overrides[metric.metric_id] : passingMetric(metric)]));

/**
 * One real bounded run of the frozen search, shared by every test below. A synthetic executor
 * records each distinct parameter set the runner asks for, in the order the runner asks for it.
 * Memoized: a run costs a full seed panel per candidate, and sharing it means the frontier
 * fixtures below are the search's own candidates rather than a second implementation of
 * candidate generation that would have to be re-pinned whenever an operation's semantics move.
 */
let boundedRunPromise = null;
function boundedRun() {
  boundedRunPromise ??= withTempArchive(directory => {
    const evaluated = [];
    return new PhaseACalibrationRunner({
      directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
      executor: async ({ seed, parameterSet, runtimeConfiguration }) => {
        if (sha256(evaluated.at(-1) ?? null) !== sha256(parameterSet)) evaluated.push(parameterSet);
        return syntheticCanonicalEvidence({ seed, runtimeConfiguration });
      }
    }).run({ maximumCandidates: 3 }).then(result => ({ evaluated, result }));
  });
  return boundedRunPromise;
}

/**
 * Two archived records for the first two candidates the frozen search actually evaluates: the
 * baseline (the registered starting set) and the first generated candidate, both taken from
 * `boundedRun` rather than recomputed here, so no fixture encodes one operation's semantics.
 * `reconstructCalibrationSearch` re-derives both transitions itself, so it rejects these records
 * outright if the enumeration order or the operation semantics ever change.
 */
async function frontierRecords({ baselineMetrics, candidateMetrics }) {
  const operations = enumerateCalibrationOperations();
  const [start, generated] = (await boundedRun()).evaluated.map(item => structuredClone(item));
  assert.equal(sha256(start), sha256(startingCalibrationParameterSet()),
    "the search did not evaluate the registered starting set first, so these records are not the real frontier");
  assert.equal(assertCalibrationTransition(start, generated, operations[1]), true,
    "the search's own first generated candidate is not the first generated frozen operation applied to the starting set");
  const record = (parameterSet, index, item, metrics) => ({
    round: 0, candidate_index: index, operation: item, parent_parameter_set_hash: sha256(start),
    parameter_set: parameterSet, parameter_set_hash: sha256(parameterSet),
    assessment: { parameter_set_hash: sha256(parameterSet), accepted: false, failures: [], aggregate_metrics: metrics }
  });
  return { start, generated, records: [record(start, 0, operations[0], baselineMetrics), record(generated, 1, operations[1], candidateMetrics)] };
}

test("calibration search is the frozen bounded deterministic coordinate grid", () => {
  assert.equal(protocol.search_procedure.algorithm, "BOUNDED_DETERMINISTIC_COORDINATE_GRID");
  assert.equal(protocol.search_procedure.maximum_parameter_sets, 512);
  assert.equal(protocol.search_procedure.maximum_rounds, 12);
  assert.equal(protocol.search_procedure.manual_tuning, "PROHIBITED_OUTSIDE_NEW_PROTOCOL_VERSION");
  assert.equal(protocol.search_procedure.treatment_outputs_available, false);
  assert.ok(enumerateCalibrationOperations().length <= protocol.search_procedure.maximum_parameter_sets);
});

test("the registered starting parameter set is evaluated before any generated candidate", async () => {
  const operations = enumerateCalibrationOperations();
  const start = startingCalibrationParameterSet();
  assert.deepEqual(operations[0], { operation: "BASELINE", domain_id: null, selector: null, value: null });
  assert.equal(operations.filter(item => item.operation === "BASELINE").length, 1);
  assert.equal(assertCalibrationTransition(start, start, operations[0]), true);
  assert.deepEqual(start, Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, entry.value])));

  const { evaluated, result } = await boundedRun();
  assert.equal(sha256(evaluated[0]), sha256(start), "the first evaluated parameter set is not the registered starting set");

  // The candidate bound halts the search: three of the frozen grid's 42-plus operations were
  // evaluated, in order, and the run stopped there rather than widening to the whole grid.
  assert.equal(evaluated.length, 3);
  assert.equal(result.attempted_parameter_vectors, 3);

  // Stopping at the bound is recorded, never silently successful. The runner publishes a
  // selection only when the stopping rule is satisfied by an accepted candidate; otherwise it
  // returns the exhausted frontier with its recorded reason. Both outcomes are pinned, because
  // whether the frozen panel accepts a candidate is a property of the evidence, not of the bound.
  const published = result.selected_parameter_set_hash !== undefined;
  assert.equal(result.stopping_rule_satisfied, published,
    "the bound-halted run published a selection without satisfying the stopping rule, or satisfied it without publishing one");
  if (published)
    assert.ok(new Set(evaluated.map(candidate => sha256(candidate))).has(result.selected_parameter_set_hash),
      "the bound-halted search selected a parameter set it never evaluated");
  else {
    assert.equal(result.status, "PROTOCOL_SEARCH_EXHAUSTED");
    assert.ok(result.failure_classification, "the halted search recorded no reason");
    assert.equal(result.assessments.at(0).parameter_set_hash, sha256(start), "the halted frontier does not begin at the registered starting set");
    assert.equal(result.assessments.length, evaluated.length, "the halted frontier widened beyond the candidate bound");
  }

  // Every evaluated candidate is exactly one frozen operation applied to an already-evaluated
  // parameter set, and changes at most one alias-grouped knob relative to the starting set.
  for (const [index, candidate] of evaluated.entries()) {
    assert.equal(validateCalibrationParameterSet(candidate), true, `evaluated candidate ${index} is out of domain`);
    const parents = evaluated.slice(0, index + 1).filter(parent => operations.some(item => {
      try { return assertCalibrationTransition(parent, candidate, item); } catch { return false; }
    }));
    assert.ok(parents.length > 0, `evaluated candidate ${index} is not a frozen operation applied to an evaluated incumbent`);
    assert.ok(changedGroups(start, candidate).size <= 1, `evaluated candidate ${index} changes more than one frozen knob`);
  }
  assert.equal(new Set(evaluated.map(candidate => sha256(candidate))).size, evaluated.length, "the search re-evaluated a parameter set");
});

test("candidate generation is deterministic and follows the frozen declaration order", () => {
  assert.deepEqual(enumerateCalibrationOperations(), enumerateCalibrationOperations());
  assert.deepEqual(enumerateCalibrationOperations(), enumerateCalibrationOperations(calibrationProtocol()));

  // Declaration order read straight from the frozen files: parameter-domain order from
  // PILOT_0_CALIBRATION_PROTOCOL.spec.json `parameter_domains`, then field insertion order
  // inside each `allowed_domain`, then declared value order inside each field's array
  // (`multipliers` for the multiplier grids, `minimum`/`step`/`maximum` for integer domains).
  const declared = [{ operation: "BASELINE", domain_id: null, selector: null, value: null }];
  for (const domain of specification("PILOT_0_CALIBRATION_PROTOCOL.spec.json").parameter_domains) {
    const allowed = domain.allowed_domain;
    if (["alias", "alias_group"].includes(allowed.kind)) continue;
    if (allowed.kind === "integer")
      for (let value = allowed.minimum; value <= allowed.maximum; value += allowed.step)
        declared.push({ operation: "SET", domain_id: domain.domain_id, selector: domain.selector, value });
    else if (Array.isArray(allowed.multipliers))
      for (const value of allowed.multipliers)
        declared.push({ operation: "MULTIPLY_GROUP", domain_id: domain.domain_id, selector: domain.selector, value });
    else for (const [selector, values] of Object.entries(allowed))
      if (!DOMAIN_METADATA.has(selector) && Array.isArray(values))
        for (const value of values) declared.push({ operation: "SET_FIELD", domain_id: domain.domain_id, selector, value });
  }
  assert.deepEqual(enumerateCalibrationOperations(), declared);

  // The registry's own declared order is the parameter-set key order, so a reordered or
  // extended registry cannot silently reshuffle candidate identity (the set is hashed).
  assert.deepEqual(Object.keys(startingCalibrationParameterSet()),
    specification("PARAMETER_REGISTRY.spec.json").parameters.map(entry => entry.parameter_id));
  assert.deepEqual(Object.keys(startingCalibrationParameterSet()), parameterRegistry().parameters.map(entry => entry.parameter_id));
});

test("each generated candidate differs from its incumbent by exactly one frozen operation", () => {
  const start = startingCalibrationParameterSet();

  // One case per alias family the runner synchronizes. Each candidate is written out by hand,
  // including the alias fields `synchronizeAliases` maintains, and `assertCalibrationTransition`
  // then proves it is byte-identical to what the frozen operation produces — so an extra,
  // missing or divergent alias write fails here.
  const cases = [
    { label: "integer domain with a three-name alias family",
      item: operation("action_budget", item => item.value === 120000),
      candidate: edited(candidate => {
        candidate["world.phase.action_budget"] = 120000;
        candidate["world.configuration.phases"] = { ...candidate["world.configuration.phases"], actionBudgetMs: 120000 };
      }) },
    { label: "integer domain with a scalar alias",
      item: operation("memory_capacity", item => item.value === 256),
      candidate: edited(candidate => {
        candidate["world.memory.capacity"] = 256;
        candidate["world.configuration.memory"] = { ...candidate["world.configuration.memory"], capacity: 256 };
      }) },
    { label: "integer domain inside the economy alias group",
      item: operation("starting_credits", item => item.value === 100),
      candidate: edited(candidate => {
        candidate["world.economy.starting_credits"] = 100;
        candidate["world.configuration.economy"] = { ...candidate["world.configuration.economy"], startingCredits: 100 };
      }) },
    { label: "fixed-grid field with a renamed alias field",
      item: operation("map_geometry", item => item.selector === "width" && item.value === 11),
      candidate: edited(candidate => {
        candidate["world.map.geometry"] = { ...candidate["world.map.geometry"], width: 11 };
        candidate["world.configuration.map"] = { ...candidate["world.configuration.map"], width: 11 };
      }) },
    { label: "fixed-grid field with a renamed alias field in the population family",
      item: operation("population_conversion", item => item.selector === "population_per_unit" && item.value === 5),
      candidate: edited(candidate => {
        candidate["world.population.unit_conversion"] = { ...candidate["world.population.unit_conversion"], population_per_unit: 5 };
        candidate["world.configuration.population"] = { ...candidate["world.configuration.population"], unitSize: 5 };
      }) },
    { label: "multiplier grid over the phase-budget group",
      item: operation("phase_budgets", item => item.value === 0.5),
      candidate: edited(candidate => {
        candidate["world.phase.budgets"] = Object.fromEntries(Object.entries(candidate["world.phase.budgets"]).map(([phase, value]) => [phase, value * 0.5]));
      }) }
  ];

  for (const { label, item, candidate } of cases) {
    assert.equal(assertCalibrationTransition(start, candidate, item), true, `frozen transition rejected: ${label}`);
    assert.equal(validateCalibrationParameterSet(candidate), true, `generated candidate is out of domain: ${label}`);
    assert.deepEqual([...changedGroups(start, candidate)].length, 1, `candidate changes more than one frozen knob: ${label}`);
    assert.deepEqual(Object.keys(candidate), Object.keys(start), `candidate added or dropped a registered parameter: ${label}`);
  }

  // `synchronizeAliases` deliberately does not treat the per-phase budget override as an alias
  // of the shared fallback action budget: scaling `phase_budgets` leaves `world.phase.action_budget`
  // and `world.configuration.phases` alone, while a SET on `action_budget` overwrites every phase
  // budget. Both directions are asserted so a change to either rule fails here.
  const byLabel = label => cases.find(item => item.label === label).candidate;
  const scaled = byLabel("multiplier grid over the phase-budget group");
  assert.equal(scaled["world.phase.action_budget"], start["world.phase.action_budget"]);
  assert.deepEqual(scaled["world.configuration.phases"], start["world.configuration.phases"]);
  assert.deepEqual(byLabel("integer domain with a three-name alias family")["world.phase.budgets"], start["world.phase.budgets"]);

  // A candidate that is not exactly the frozen operation applied to the incumbent is a manual
  // substitution, whatever its values are, and an operation outside the frozen grid is refused.
  const substituted = edited(candidate => {
    candidate["world.memory.capacity"] = 256;
    candidate["world.configuration.memory"] = { ...candidate["world.configuration.memory"], capacity: 256 };
    candidate["world.economy.starting_credits"] = 100;
    candidate["world.configuration.economy"] = { ...candidate["world.configuration.economy"], startingCredits: 100 };
  });
  assert.throws(() => assertCalibrationTransition(start, substituted, operation("memory_capacity", item => item.value === 256)),
    /unauthorized manual calibration parameter substitution/);
  assert.throws(() => assertCalibrationTransition(start, start, { operation: "SET", domain_id: "memory_capacity", selector: "value", value: 250 }),
    /not an exact frozen operation/);
});

// The canonical action-budget grid and the phase-configuration grid overlap but are not identical.
// Alias synchronization accepts their frozen union while operation verification still prevents
// values that were not generated by one of the two declared grids.
test("every action-budget value on the frozen grid yields a candidate the validator accepts", () => {
  const start = startingCalibrationParameterSet();
  for (const value of [180000, 300000, 420000, 540000]) {
    const candidate = edited(item => {
      item["world.phase.action_budget"] = value;
      item["world.configuration.phases"] = { ...item["world.configuration.phases"], actionBudgetMs: value };
    });
    assert.equal(assertCalibrationTransition(start, candidate, operation("action_budget", item => item.value === value)), true);
    // The acceptance this test is named for: the validator's action-budget / phase-configuration
    // grid union has to admit the value, not merely the transition check.
    assert.equal(validateCalibrationParameterSet(candidate), true, `frozen action-budget value rejected by the validator: ${value}`);
    assert.deepEqual([...changedGroups(start, candidate)].length, 1);
  }
});

test("the hard bounds halt the search instead of widening it", async () => {
  const { records } = await frontierRecords({ baselineMetrics: metricsWith({}), candidateMetrics: metricsWith({}) });

  // Reconstruction refuses any bound above the frozen 512 and refuses an archive that ran past
  // the bound it was given: the bound stops the search, it is never raised to fit the archive.
  assert.throws(() => reconstructCalibrationSearch(records, { maximumCandidates: protocol.search_procedure.maximum_parameter_sets + 1 }),
    /invalid archived search bound/);
  assert.throws(() => reconstructCalibrationSearch(records, { maximumCandidates: 0 }), /invalid archived search bound/);
  assert.throws(() => reconstructCalibrationSearch(records, { maximumCandidates: 1 }), /exceeds frozen candidate bound/);

  // A bound-limited run halts with a recorded frontier rather than silently succeeding.
  const halted = reconstructCalibrationSearch(records.slice(0, 1));
  assert.equal(halted.complete, false);
  assert.equal(halted.incumbent_parameter_set_hash, records[0].parameter_set_hash);

  await withTempArchive(async directory => {
    const executor = async ({ seed }) => syntheticCanonicalEvidence({ seed });
    await assert.rejects(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, executor })
      .run({ maximumCandidates: protocol.search_procedure.maximum_parameter_sets + 1 }), /candidate bound violates protocol/);
    await assert.rejects(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, executor })
      .run({ maximumCandidates: 0 }), /candidate bound violates protocol/);
  });

  // The round index is re-derived from the frozen loop and never read back from the archive, so a
  // record claiming a round the bound does not allow cannot be replayed at all.
  const pastBound = structuredClone(records);
  pastBound[1].round = protocol.search_procedure.maximum_rounds;
  assert.throws(() => reconstructCalibrationSearch(pastBound), /archived candidate skipped\/substituted a frozen search transition/);

  // Both bounds are read from the frozen protocol at their guards, never scaled or relaxed. Two
  // round loops exist — the runner's own labelled `search:` loop and the replay loop inside
  // `reconstructCalibrationSearch` — and each is pinned separately, so relaxing one alone still
  // fails here. A 13th round cannot be driven behaviourally: reaching it costs twelve improving
  // sweeps of the whole frozen grid, which is why the guard itself is asserted.
  const runnerSource = readFileSync(new URL("../src/calibration-runner.js", import.meta.url), "utf8");
  const roundLoops = runnerSource.match(/for \(let round = [^;]*;[^)]*\)/g) ?? [];
  assert.equal(roundLoops.length, 2, "the runner no longer has exactly the two round loops this test pins");
  for (const loop of roundLoops) assert.match(loop, /round < protocol\.search_procedure\.maximum_rounds/);
  assert.match(runnerSource, /search:\s*for \(let round = [^;]*; round < protocol\.search_procedure\.maximum_rounds;/);
  assert.match(runnerSource, /candidateIndex\s*>=\s*maximumCandidates/);
  assert.doesNotMatch(runnerSource, /maximum_rounds\s*[+*]/);
  assert.doesNotMatch(runnerSource, /maximum_parameter_sets\s*[+*]/);
});

test("a candidate is promoted only when it improves the violation vector without breaking a passing metric", async () => {
  const [first, second] = protocol.metrics.filter(metric => metric.acceptance.minimum !== undefined);

  // Lexicographically smaller on the first protocol-ordered metric and no regression anywhere.
  const promoted = await frontierRecords({
    baselineMetrics: metricsWith({ [first.metric_id]: violatingMetric(first) }),
    candidateMetrics: metricsWith({})
  });
  assert.equal(reconstructCalibrationSearch(promoted.records).incumbent_parameter_set_hash, sha256(promoted.generated));

  // Same lexicographic improvement, but it breaks a metric the incumbent passed: rejected.
  const rejected = await frontierRecords({
    baselineMetrics: metricsWith({ [first.metric_id]: violatingMetric(first) }),
    candidateMetrics: metricsWith({ [second.metric_id]: violatingMetric(second) })
  });
  assert.equal(reconstructCalibrationSearch(rejected.records).incumbent_parameter_set_hash, sha256(rejected.start));

  // A strictly worse candidate never displaces the incumbent either.
  const worse = await frontierRecords({
    baselineMetrics: metricsWith({}),
    candidateMetrics: metricsWith({ [first.metric_id]: violatingMetric(first) })
  });
  assert.equal(reconstructCalibrationSearch(worse.records).incumbent_parameter_set_hash, sha256(worse.start));
});

test("parameter-set validation rejects unregistered, out-of-domain, and manually substituted values", () => {
  const start = startingCalibrationParameterSet();
  assert.equal(validateCalibrationParameterSet(start), true);

  assert.throws(() => validateCalibrationParameterSet(edited(candidate => { candidate["world.invented.parameter"] = 1; })),
    /unauthorized or missing calibration parameter/);
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => { delete candidate["world.memory.capacity"]; })),
    /unauthorized or missing calibration parameter/);

  // Outside the declared integer domain (128..1024 step 128) and off its declared step.
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => {
    candidate["world.memory.capacity"] = 2048;
    candidate["world.configuration.memory"] = { ...candidate["world.configuration.memory"], capacity: 2048 };
  })), /out-of-domain calibration parameter: memory_capacity/);
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => {
    candidate["world.memory.capacity"] = 300;
    candidate["world.configuration.memory"] = { ...candidate["world.configuration.memory"], capacity: 300 };
  })), /out-of-domain calibration parameter: memory_capacity/);

  // A hand-picked value that the fixed grid never declares.
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => {
    candidate["world.map.geometry"] = { ...candidate["world.map.geometry"], width: 12 };
    candidate["world.configuration.map"] = { ...candidate["world.configuration.map"], width: 12 };
  })), /out-of-domain calibration field: map_geometry\.width/);
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => {
    candidate["world.configuration.phases"] = { ...candidate["world.configuration.phases"], actionLimit: 65 };
  })), /out-of-domain calibration field: world_phase_config\.actionLimit/);

  // An alias written on one side only is a manual substitution, not a synchronized operation.
  assert.throws(() => validateCalibrationParameterSet(edited(candidate => {
    candidate["world.memory.capacity"] = 256;
  })), /memory calibration alias divergence/);
});

test("every held-constant registry parameter is individually immutable during calibration", () => {
  const held = protocol.held_constant_registry_parameters;
  assert.equal(held.length, 13);
  for (const id of ["model.generation", "model.context_budget", "model.retry"])
    assert(held.includes(id), `no-Qwen Phase A does not hold ${id}`);
  assert.deepEqual([...new Set(held)], held);

  const start = startingCalibrationParameterSet();
  for (const id of held) {
    assert.ok(Object.hasOwn(start, id), `held calibration parameter is not registered: ${id}`);
    const mutated = edited(candidate => {
      const value = candidate[id];
      candidate[id] = typeof value === "number" ? value + 1
        : typeof value === "string" ? `${value}-mutated`
        : typeof value === "boolean" ? !value
        : Array.isArray(value) ? [...value, "mutated"]
        : { ...value, mutated: true };
    });
    assert.notEqual(canonicalize(mutated[id]), canonicalize(start[id]), `held parameter fixture did not mutate: ${id}`);
    assert.throws(() => validateCalibrationParameterSet(mutated), new RegExp(`held calibration parameter changed: ${id.replace(/\./g, "\\.")}`),
      `held calibration parameter is mutable: ${id}`);
  }

  // No held-constant parameter is reachable through the frozen grid either.
  const reachable = new Set(protocol.parameter_domains.map(domain => domain.registry_parameter_id));
  for (const id of held) assert.equal(reachable.has(id), false, `held parameter has a calibration domain: ${id}`);
});

test("the registry is the only source of a calibration parameter set", () => {
  assert.deepEqual(startingCalibrationParameterSet(),
    Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, entry.value])));
  const first = startingCalibrationParameterSet();
  first["world.memory.capacity"] = 999;
  assert.notEqual(startingCalibrationParameterSet()["world.memory.capacity"], 999, "the starting set leaks shared state");

  // Scan scope: every `.js` file shipped under `src/` and `scripts/`, walked recursively so a
  // literal hidden in a future subdirectory is still seen — the complete non-test JavaScript
  // surface of the calibration tooling. A parameter-set literal is an object literal keyed by
  // registered parameter identifiers; only the registry read path may produce one.
  const shippedSources = ["src", "scripts"].flatMap(directory =>
    readdirSync(new URL(`../${directory}`, import.meta.url), { recursive: true })
      .filter(entry => entry.endsWith(".js"))
      .map(entry => ({ where: `${directory}/${entry}`, source: readFileSync(new URL(`../${directory}/${entry}`, import.meta.url), "utf8") })));
  assert.ok(shippedSources.length > 0, "the parameter-set scan found no shipped JavaScript to scan");

  const registered = parameterRegistry().parameters.map(entry => entry.parameter_id);
  const offenders = [];
  for (const { where, source } of shippedSources) {
    const keys = registered.filter(id => new RegExp(`["'\`]${id.replace(/\./g, "\\.")}["'\`]\\s*:`).test(source));
    if (keys.length) offenders.push({ where, keys });
  }
  // `src/parameters.js` carries the run-configuration alias overlay: eight identifiers whose
  // values come from the supplied configuration, never a starting set of its own.
  assert.deepEqual(offenders.map(item => item.where), ["src/parameters.js"]);
  assert.ok(offenders[0].keys.length < registered.length / 2, "a source file declares values for most of the registry");

  // Exactly one definition of the starting-set builder exists across that same recursive scope.
  const definitions = shippedSources.filter(item => /function\s+startingParameterSet\b/.test(item.source)).map(item => item.where);
  assert.deepEqual(definitions, ["src/calibration-runner.js"]);
});
