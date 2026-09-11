import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalize, sha256 } from "../src/core.js";
import {
  aggregateCalibrationSelectionView,
  assessCalibrationCandidate,
  calibrationBlindingAttestationPayload,
  calibrationProtocol,
  calibrationProtocolIncident,
  createCalibrationSelectionView,
  enumerateCalibrationOperations,
  selectCalibrationCandidate,
  validateCalibrationProtocol
} from "../src/calibration.js";

const parameters = JSON.parse(readFileSync(new URL("../PARAMETER_REGISTRY.spec.json", import.meta.url), "utf8"));
const protocol = calibrationProtocol();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedAttestors = { "calibration-reviewer": publicKey };

function acceptedMetrics() {
  return Object.fromEntries(protocol.metrics.map(metric => {
    const { minimum, maximum } = metric.acceptance;
    let value;
    if (minimum !== undefined && maximum !== undefined) value = (minimum + maximum) / 2;
    else if (minimum !== undefined) value = minimum + Math.max(Math.abs(minimum) * 0.1, 0.01);
    else value = maximum - Math.max(Math.abs(maximum) * 0.1, 0.01);
    return [metric.metric_id, value];
  }));
}

function manifest(seed, overrides = {}) {
  const parameterSet = { world: { map: { width: 13, height: 11 } }, status: "PROVISIONAL" };
  const result = {
    schema_version: "1.0.0",
    protocol_version: protocol.protocol_version,
    attempt_id: `attempt-${seed}`,
    implementation_commit: "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59",
    implementation_tag: "v0.1.0-pilot0",
    specification_refs: ["validation/PRE_CALIBRATION_BASELINE.json"],
    parameter_registry_version: parameters.registry_version,
    parameter_set_hash: sha256(parameterSet),
    parameter_set: parameterSet,
    seed,
    rng_provenance_ref: `rng://${seed}`,
    policy_configuration: { kind: "scripted_heterogeneous_v1" },
    model_runtime_configuration: { used: false },
    canonical_evidence_ref: `archive://${seed}`,
    metrics: acceptedMetrics(),
    disposition: "ACCEPTED",
    adjustment_reason: "registered starting set",
    treatment_blinding: "CALIBRATION_TREATMENT_BLIND_V1",
    created_at: "2026-09-10T00:00:00Z",
    ...overrides
  };
  result.blinding_attestation = overrides.blinding_attestation ?? {
    version: "1.0.0",
    attestor_key_id: "calibration-reviewer",
    algorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalize(calibrationBlindingAttestationPayload(result))), privateKey).toString("base64")
  };
  return result;
}

function selectorFact(value, { status = "OBSERVED", numerator, denominator } = {}) {
  if (status !== "OBSERVED") return { status, value: null, numerator: "0", denominator: "0", eligibility_count: "0" };
  const d = denominator ?? 1_000_000;
  const n = numerator ?? Math.round(value * d);
  return { status, value, numerator: String(n), denominator: String(d), eligibility_count: String(d) };
}

function opaqueSelectorPanel(mutator = () => {}) {
  const hash = "c".repeat(64);
  return protocol.seed_panel.seeds.map((seed, index) => {
    const metrics = Object.fromEntries(Object.entries(acceptedMetrics()).map(([id, value]) => [id, selectorFact(value)]));
    mutator(metrics, index);
    return { opaque_run_alias: `run-${index}`, opaque_seed_alias: `seed-${index}`, candidate_alias: hash,
      metrics, disposition: "UNEVALUATED", treatment_blinding: protocol.blinding.selection_view };
  });
}

test("calibration protocol is schema-valid, complete across registered calibration parameters, and non-authorizing", () => {
  assert.equal(validateCalibrationProtocol(protocol, parameters), true);
  assert.equal(protocol.authorization.empirical_calibration, false);
  assert.equal(protocol.authorization.pilot_0_research, false);
  assert.equal(protocol.authorization.confirmatory_execution, false);
  assert.equal(protocol.seed_panel.seeds.length, 24);
  assert.equal(protocol.search_procedure.manual_tuning, "PROHIBITED_OUTSIDE_NEW_PROTOCOL_VERSION");
});

test("every calibration parameter is provisional and has bounded handling or an explicit hold", () => {
  const handled = new Set(protocol.parameter_domains.map(domain => domain.registry_parameter_id));
  const held = new Set(protocol.held_constant_registry_parameters);
  for (const entry of parameters.parameters.filter(entry => entry.classification === "WORLD_CALIBRATION")) {
    assert.equal(entry.status, "PROVISIONAL", entry.parameter_id);
    assert.equal(handled.has(entry.parameter_id) || held.has(entry.parameter_id), true, entry.parameter_id);
  }
  for (const domain of protocol.parameter_domains) {
    assert.ok(domain.calibration_metrics.length > 0);
    assert.ok(Object.keys(domain.allowed_domain).length > 0);
    assert.match(domain.pathological_bounds, /.+/);
    assert.match(domain.stopping_condition, /.+/);
  }
});

test("bounded search operations are complete, deterministic, and contain no manual values", () => {
  const first = enumerateCalibrationOperations();
  const second = enumerateCalibrationOperations();
  assert.deepEqual(first, second);
  assert.equal(first[0].operation, "BASELINE");
  assert.ok(first.length > protocol.parameter_domains.length);
  assert.ok(first.length <= protocol.search_procedure.maximum_parameter_sets);
  assert.ok(first.every(operation => ["BASELINE", "SET", "SET_FIELD", "MULTIPLY_GROUP"].includes(operation.operation)));
});

test("missing domains, treatment metrics, effect access, or empirical authorization fail closed", () => {
  const cases = [
    p => p.metrics.pop(),
    p => { p.metrics[0].treatment_effect_metric = true; },
    p => { p.search_procedure.treatment_outputs_available = true; },
    p => { p.stopping_rule.effect_information_used = true; },
    p => { p.authorization.empirical_calibration = true; },
    p => { p.parameter_domains = p.parameter_domains.filter(domain => domain.registry_parameter_id !== "model.generation"); }
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(protocol);
    mutate(candidate);
    assert.throws(() => validateCalibrationProtocol(candidate, parameters));
  }
});

test("selection projection emits only blinded identifiers, pooled metrics, and opaque parameter bindings", () => {
  const raw = protocol.seed_panel.seeds.map(seed => manifest(seed, {
    policy_configuration: { kind: "experimental_agent", treatment_arm: "must-not-reach-selector" },
    model_runtime_configuration: { condition_id: "raw-provenance-only" }
  }));
  const view = createCalibrationSelectionView(raw, { trustedAttestors });
  assert.equal(view.length, 24);
  assert.doesNotMatch(JSON.stringify(view), /must-not-reach-selector|raw-provenance-only|condition_id|primary_endpoint/i);
  assert.ok(view.every(row => !Object.hasOwn(row, "canonical_evidence_ref")));
  assert.equal(new Set(view.map(row => row.blinded_run_id)).size, 24);
  assert.ok(view.every(row => row.treatment_blinding === "CALIBRATION_TREATMENT_BLIND_V1"));
});

test("calibration aggregation is fixed-point, complete-panel, reducer-locked, and order independent", () => {
  const view = createCalibrationSelectionView(protocol.seed_panel.seeds.map(seed => manifest(seed)), { trustedAttestors });
  const forward = aggregateCalibrationSelectionView(view);
  const reverse = aggregateCalibrationSelectionView([...view].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.seed_ids, [...protocol.seed_panel.seeds].sort());
  assert.equal(Object.keys(forward.aggregate_metrics).length, protocol.metrics.length);
  assert.throws(() => aggregateCalibrationSelectionView(view.slice(1)), /complete calibration selection view/);
  const mixed = structuredClone(view); mixed[0].parameter_set_hash = "f".repeat(64);
  assert.throws(() => aggregateCalibrationSelectionView(mixed), /mixes parameter sets/);
});

test("pooled rate aggregation sums exact opportunity counts instead of averaging seed ratios", () => {
  const view = opaqueSelectorPanel((metrics, index) => {
    metrics["runtime.deadline_failure_rate"] = index === 0
      ? selectorFact(0.07, { numerator: 7, denominator: 100 })
      : selectorFact(0, { numerator: 0, denominator: 1 });
  });
  const aggregate = aggregateCalibrationSelectionView(view);
  assert.equal(aggregate.aggregate_metrics["runtime.deadline_failure_rate"], 0.056911);
  assert.notEqual(aggregate.aggregate_metrics["runtime.deadline_failure_rate"], 0.002917,
    "an unweighted mean of per-seed rates would manufacture a passing panel");
  const assessment = assessCalibrationCandidate({ parameter_set_hash: "c".repeat(64), seed_ids: protocol.seed_panel.seeds,
    aggregate_metrics: aggregate.aggregate_metrics, aggregate_status: aggregate.aggregate_status });
  assert.equal(assessment.accepted, false);
  assert.ok(assessment.failures.some(failure => failure.metric_id === "runtime.deadline_failure_rate"));
});

test("selector pooled-rate DTOs fail closed when exact counts are stripped", () => {
  const view = opaqueSelectorPanel();
  delete view[0].metrics["runtime.deadline_failure_rate"].numerator;
  assert.throws(() => aggregateCalibrationSelectionView(view), /pooled metric requires exact counts/);
});

test("all-zero-opportunity conditional panels are retained as deterministic candidate failures", () => {
  const view = opaqueSelectorPanel(metrics => {
    metrics["contact.median_first_contact_turn"] = selectorFact(null, { status: "ZERO_OPPORTUNITY" });
  });
  const aggregate = aggregateCalibrationSelectionView(view);
  assert.equal(aggregate.aggregate_metrics["contact.median_first_contact_turn"], null);
  assert.deepEqual(aggregate.aggregate_status["contact.median_first_contact_turn"], {
    observed: 0, zero_opportunity: 24, censored: 0, unevaluable: 0
  });
  const assessment = assessCalibrationCandidate({ parameter_set_hash: "c".repeat(64), seed_ids: protocol.seed_panel.seeds,
    aggregate_metrics: aggregate.aggregate_metrics, aggregate_status: aggregate.aggregate_status });
  assert.equal(assessment.accepted, false);
  assert.deepEqual(assessment.failures.find(failure => failure.metric_id === "contact.median_first_contact_turn"), {
    metric_id: "contact.median_first_contact_turn", value: null, boundary: "OBSERVABLE_PANEL_METRIC", relation: "observability",
    aggregate_status: { observed: 0, zero_opportunity: 24, censored: 0, unevaluable: 0 }
  });
});

test("treatment, endpoint, significance, and arm-specific fields cannot enter calibration metrics", () => {
  for (const forbidden of ["treatment_arm", "persistence", "primary_endpoint", "effect_size", "p_value", "arm_summary", "significance"]) {
    const bad = manifest(protocol.seed_panel.seeds[0]);
    bad.metrics[forbidden] = 1;
    assert.throws(() => createCalibrationSelectionView([bad], { trustedAttestors }), /treatment-blinding violation|schema validation/);
  }
});

test("candidate acceptance requires every frozen metric and the complete common seed panel", () => {
  const candidate = {
    parameter_set_hash: "a".repeat(64),
    seed_ids: protocol.seed_panel.seeds,
    aggregate_metrics: acceptedMetrics(),
    worst_seed_metric_pass_fraction: 1,
    cross_seed_metric_variance: 0.1,
    changes_from_start: 0
  };
  assert.equal(assessCalibrationCandidate(candidate).accepted, true);
  assert.throws(() => assessCalibrationCandidate({ ...candidate, seed_ids: candidate.seed_ids.slice(1) }), /complete frozen seed panel/);
  const incomplete = { ...candidate, aggregate_metrics: { ...candidate.aggregate_metrics } };
  delete incomplete.aggregate_metrics[protocol.metrics[0].metric_id];
  assert.throws(() => assessCalibrationCandidate(incomplete), /metric set is incomplete/);
});

test("pathological bounds reject a candidate without treatment-directed exceptions", () => {
  const metrics = acceptedMetrics();
  metrics["viability.premature_absorbing_rate"] = 0.9;
  metrics["relational.zero_opportunity_run_rate"] = 0.95;
  const result = assessCalibrationCandidate({ parameter_set_hash: "b".repeat(64), seed_ids: protocol.seed_panel.seeds, aggregate_metrics: metrics });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.failures.map(f => f.metric_id).sort(), ["relational.zero_opportunity_run_rate", "viability.premature_absorbing_rate"]);
});

test("selection is maximin and deterministic with treatment-neutral tie breakers", () => {
  const base = acceptedMetrics();
  const stronger = { ...base, "economy.median_production_consumption_ratio": 1.1 };
  const a = assessCalibrationCandidate({ parameter_set_hash: "a".repeat(64), seed_ids: protocol.seed_panel.seeds, aggregate_metrics: base, worst_seed_metric_pass_fraction: 0.95, cross_seed_metric_variance: 0.2, changes_from_start: 2 });
  const b = assessCalibrationCandidate({ parameter_set_hash: "b".repeat(64), seed_ids: protocol.seed_panel.seeds, aggregate_metrics: stronger, worst_seed_metric_pass_fraction: 1, cross_seed_metric_variance: 0.1, changes_from_start: 1 });
  assert.deepEqual(selectCalibrationCandidate([a, b]), selectCalibrationCandidate([b, a]));
  const exactA = { ...a, parameter_set_hash: "0".repeat(64), selection_score: { ...a.selection_score, parameter_set_hash: "0".repeat(64) } };
  const exactB = { ...a, parameter_set_hash: "f".repeat(64), selection_score: { ...a.selection_score, parameter_set_hash: "f".repeat(64) } };
  assert.equal(selectCalibrationCandidate([exactB, exactA]).parameter_set_hash, "0".repeat(64));
  assert.throws(() => selectCalibrationCandidate([{ ...a, accepted: false }]), /STOP_CALIBRATION/);
});

test("parameter hash, baseline tag, protocol version, and seed provenance fail closed", () => {
  const seed = protocol.seed_panel.seeds[0];
  const cases = [
    { parameter_set_hash: "0".repeat(64) },
    { implementation_tag: "latest" },
    { protocol_version: "mutable" },
    { seed: "hand-picked-seed" }
  ];
  for (const change of cases) assert.throws(() => createCalibrationSelectionView([manifest(seed, change)], { trustedAttestors }));
});

test("selection accepts trusted blinding attestations and rejects forgery, mutation, and missing trust", () => {
  const good = manifest(protocol.seed_panel.seeds[0]);
  assert.equal(createCalibrationSelectionView([good], { trustedAttestors }).length, 1);
  assert.throws(() => createCalibrationSelectionView([good]), /independent calibration blinding trust required/);
  const forged = structuredClone(good); forged.blinding_attestation.signature = Buffer.alloc(64).toString("base64");
  assert.throws(() => createCalibrationSelectionView([forged], { trustedAttestors }), /invalid calibration blinding attestation/);
  const mutated = structuredClone(good); mutated.metrics[protocol.metrics[0].metric_id] += 1;
  assert.throws(() => createCalibrationSelectionView([mutated], { trustedAttestors }), /invalid calibration blinding attestation/);
});

test("accidental treatment disclosure creates an invalidating retained incident", () => {
  const incident = calibrationProtocolIncident({ disclosure: "treatment_arm_visible", affectedDecision: "candidate-4", detectedAt: "2026-09-10T00:00:00Z", authority: "calibration-security-review" });
  assert.equal(incident.incident_type, "CALIBRATION_PROTOCOL_INCIDENT");
  assert.equal(incident.disposition, "SELECTION_INVALID_REPEAT_FROM_LAST_UNEXPOSED_STATE");
  assert.equal(Object.isFrozen(incident), true);
});
