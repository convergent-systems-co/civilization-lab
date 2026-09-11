import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verify } from "node:crypto";
import { assert, canonicalize, clone, sha256 } from "./core.js";
import { assertValidSchema } from "./schema.js";
import { divideHalfEven } from "./calibration-metrics.js";

const protocol = JSON.parse(readFileSync(resolve(import.meta.dirname, "../PILOT_0_CALIBRATION_PROTOCOL.spec.json"), "utf8"));

const normalized = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function walkKeys(value, visit, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((child, index) => walkKeys(child, visit, `${path}[${index}]`));
  for (const [key, child] of Object.entries(value)) {
    visit(key, `${path}.${key}`);
    walkKeys(child, visit, `${path}.${key}`);
  }
}

export function assertTreatmentBlind(value, activeProtocol = protocol) {
  const forbidden = new Set([...activeProtocol.blinding.forbidden_input_fields, ...activeProtocol.blinding.forbidden_outputs].map(normalized));
  walkKeys(value, (key, path) => assert(!forbidden.has(normalized(key)), `calibration treatment-blinding violation at ${path}`));
  return true;
}

export function validateCalibrationProtocol(activeProtocol = protocol, parameterRegistry) {
  assertValidSchema(activeProtocol, "calibration-protocol.schema.json");
  assert(activeProtocol.phases.map(p => p.phase_id).join(",") === "A_WORLD_CALIBRATION,B_FROZEN_PILOT_0", "calibration phase order is not frozen");
  assert(activeProtocol.authorization.empirical_calibration === false, "protocol cannot authorize empirical calibration");
  assert(activeProtocol.search_procedure.treatment_outputs_available === false && activeProtocol.stopping_rule.effect_information_used === false, "treatment effects are available to calibration selection");

  const metricIds = new Set(activeProtocol.metrics.map(metric => metric.metric_id));
  assert(metricIds.size === activeProtocol.metrics.length, "duplicate calibration metric identifiers");
  assert(canonicalize([...metricIds].sort()) === canonicalize(protocol.metrics.map(metric => metric.metric_id).sort()), "frozen calibration metric set changed without a protocol version");
  assert(canonicalize(Object.keys(activeProtocol.metric_aggregation_registry).sort()) === canonicalize([...metricIds].sort()), "calibration aggregation registry is incomplete or contains extras");
  const requiredDomains = new Set(["WORLD_VIABILITY", "CONTACT", "ECONOMY", "TECHNOLOGY", "POPULATION_UNITS", "CONFLICT", "INFORMATION", "INTERACTION_BANDWIDTH", "RELATIONAL_MEASUREMENT_OPPORTUNITY", "COMPUTATIONAL_FEASIBILITY"]);
  for (const metric of activeProtocol.metrics) {
    requiredDomains.delete(metric.domain);
    assert(metric.treatment_effect_metric === false, `treatment-effect metric forbidden: ${metric.metric_id}`);
    assert(Object.hasOwn(metric.acceptance, "minimum") || Object.hasOwn(metric.acceptance, "maximum"), `metric lacks acceptance range: ${metric.metric_id}`);
    if (Object.hasOwn(metric.acceptance, "minimum") && Object.hasOwn(metric.acceptance, "maximum")) assert(metric.acceptance.minimum <= metric.acceptance.maximum, `invalid metric range: ${metric.metric_id}`);
  }
  assert(requiredDomains.size === 0, `missing calibration metric domains: ${[...requiredDomains].join(",")}`);

  const domainIds = new Set();
  for (const domain of activeProtocol.parameter_domains) {
    assert(!domainIds.has(domain.domain_id), `duplicate calibration parameter domain: ${domain.domain_id}`);
    domainIds.add(domain.domain_id);
    for (const metricId of domain.calibration_metrics) assert(metricIds.has(metricId), `unknown linked calibration metric: ${metricId}`);
    assert(Object.keys(domain.allowed_domain).length > 0, `empty calibration domain: ${domain.domain_id}`);
  }
  assert(canonicalize([...domainIds].sort()) === canonicalize(protocol.parameter_domains.map(domain => domain.domain_id).sort()), "frozen parameter-domain set changed without a protocol version");

  if (parameterRegistry) {
    const covered = new Set(activeProtocol.parameter_domains.map(domain => domain.registry_parameter_id));
    const held = new Set(activeProtocol.held_constant_registry_parameters);
    for (const entry of parameterRegistry.parameters) {
      if (entry.classification === "WORLD_CALIBRATION") assert(covered.has(entry.parameter_id) || held.has(entry.parameter_id), `unclassified calibration handling: ${entry.parameter_id}`);
      if (covered.has(entry.parameter_id)) assert(entry.status === "PROVISIONAL", `calibration domain is not provisional: ${entry.parameter_id}`);
    }
    for (const id of covered) assert(parameterRegistry.parameters.some(entry => entry.parameter_id === id), `calibration domain references unknown registry parameter: ${id}`);
  }
  return true;
}

export function calibrationProtocol() { return clone(protocol); }

export function enumerateCalibrationOperations(activeProtocol = protocol) {
  const operations = [{ operation: "BASELINE", domain_id: null, selector: null, value: null }];
  const metadata = new Set(["kind", "minimum", "maximum", "step", "multipliers", "rounding", "must_equal", "fixed_fields", "preserve_profile_permutation_balance", "preserve_targets_prerequisites_domains", "permille_minimum", "permille_maximum", "positive_integer_minimum", "success_permille_minimum", "success_permille_maximum", "turn_minimum"]);
  for (const domain of activeProtocol.parameter_domains) {
    const allowed = domain.allowed_domain;
    if (["alias", "alias_group"].includes(allowed.kind)) continue;
    if (allowed.kind === "integer") {
      for (let value = allowed.minimum; value <= allowed.maximum; value += allowed.step) operations.push({ operation: "SET", domain_id: domain.domain_id, selector: domain.selector, value });
    } else if (Array.isArray(allowed.multipliers)) {
      for (const value of allowed.multipliers) operations.push({ operation: "MULTIPLY_GROUP", domain_id: domain.domain_id, selector: domain.selector, value });
    } else {
      for (const [selector, values] of Object.entries(allowed)) if (!metadata.has(selector) && Array.isArray(values))
        for (const value of values) operations.push({ operation: "SET_FIELD", domain_id: domain.domain_id, selector, value });
    }
  }
  assert(operations.length <= activeProtocol.search_procedure.maximum_parameter_sets, "declared calibration grid exceeds frozen attempt bound");
  return clone(operations);
}

export function calibrationBlindingAttestationPayload(manifest) {
  return {
    declaration: "TREATMENT_FIELDS_REMOVED_NO_ARM_COMPARISONS_COMPUTED_SELECTOR_HAS_NO_RAW_EVIDENCE_ACCESS",
    protocol_version: manifest.protocol_version,
    attempt_id: manifest.attempt_id,
    parameter_set_hash: manifest.parameter_set_hash,
    seed: manifest.seed,
    canonical_evidence_ref: manifest.canonical_evidence_ref,
    metrics_hash: sha256(manifest.metrics),
    disposition: manifest.disposition
  };
}

export function createCalibrationSelectionView(manifests, { activeProtocol = protocol, trustedAttestors } = {}) {
  assert(Array.isArray(manifests) && manifests.length > 0, "calibration manifests required");
  assert(trustedAttestors && typeof trustedAttestors === "object", "independent calibration blinding trust required");
  return manifests.map(manifest => {
    assertValidSchema(manifest, "calibration-run-manifest.schema.json");
    assert(manifest.protocol_version === activeProtocol.protocol_version, "calibration protocol version mismatch");
    assert(activeProtocol.seed_panel.seeds.includes(manifest.seed), "seed outside frozen calibration panel");
    assert(manifest.parameter_set_hash === sha256(manifest.parameter_set), "calibration parameter set hash mismatch");
    assertTreatmentBlind(manifest.metrics, activeProtocol);
    assert(canonicalize(Object.keys(manifest.metrics).sort()) === canonicalize(activeProtocol.metrics.map(metric => metric.metric_id).sort()), "run calibration metric set is incomplete or contains extras");
    const attestation = manifest.blinding_attestation;
    const publicKey = trustedAttestors[attestation.attestor_key_id];
    assert(publicKey, "untrusted calibration blinding attestor");
    assert(verify(null, Buffer.from(canonicalize(calibrationBlindingAttestationPayload(manifest))), publicKey, Buffer.from(attestation.signature, "base64")), "invalid calibration blinding attestation");
    return {
      blinded_run_id: sha256({ protocol: activeProtocol.protocol_version, attempt: manifest.attempt_id, seed: manifest.seed }),
      seed: manifest.seed,
      parameter_set_hash: manifest.parameter_set_hash,
      metrics: clone(manifest.metrics),
      disposition: manifest.disposition,
      treatment_blinding: activeProtocol.blinding.selection_view
    };
  });
}

function fixed(value, activeProtocol) {
  assert(typeof value === "number" && Number.isFinite(value), "invalid calibration metric value");
  const text = String(value); assert(!/[eE]/.test(text), "exponential calibration metric forbidden");
  const negative = text.startsWith("-"), [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt((whole || "0") + fraction) * (negative ? -1n : 1n);
  return divideHalfEven(numerator * BigInt(activeProtocol.metric_numeric_policy.scale), denominator);
}

export function aggregateCalibrationSelectionView(view, activeProtocol = protocol) {
  assert(Array.isArray(view) && view.length === activeProtocol.seed_panel.seeds.length, "complete calibration selection view required");
  assertTreatmentBlind(view, activeProtocol);
  const hashes = new Set(view.map(row => row.candidate_alias));
  assert(hashes.size === 1, "selection view mixes parameter sets");
  assert(new Set(view.map(row => row.opaque_seed_alias)).size === activeProtocol.seed_panel.seeds.length, "selection view does not contain each frozen seed exactly once");
  assert(view.every(row => row.disposition !== "PROTOCOL_INCIDENT"), "protocol incident invalidates candidate aggregation");
  const aggregate = {};
  const aggregate_status = {};
  const conditionalMedians = new Set(["contact.median_first_contact_turn", "technology.median_first_completion_turn", "information.median_discovery_turn"]);
  for (const metric of activeProtocol.metrics) {
    const facts = view.map(row => row.metrics[metric.metric_id]);
    assert(facts.every(fact => fact && ["OBSERVED", "ZERO_OPPORTUNITY", "CENSORED", "UNEVALUABLE"].includes(fact.status)), `selector metric status invalid: ${metric.metric_id}`);
    const included = conditionalMedians.has(metric.metric_id) ? facts.filter(fact => fact.status === "OBSERVED") : facts;
    const values = included.map(fact => fixed(fact.value ?? 0, activeProtocol)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    aggregate_status[metric.metric_id] = { observed: facts.filter(fact => fact.status === "OBSERVED").length,
      zero_opportunity: facts.filter(fact => fact.status === "ZERO_OPPORTUNITY").length,
      censored: facts.filter(fact => fact.status === "CENSORED").length,
      unevaluable: facts.filter(fact => fact.status === "UNEVALUABLE").length };
    if (!values.length) { aggregate[metric.metric_id] = null; continue; }
    const reducer = activeProtocol.metric_aggregation_registry[metric.metric_id];
    let result;
    if (reducer === "MAXIMUM") result = values.at(-1);
    else if (reducer === "MEDIAN") result = values.length % 2 ? values[(values.length - 1) / 2] : divideHalfEven(values[values.length / 2 - 1] + values[values.length / 2], 2n);
    else if (reducer === "MEAN") result = divideHalfEven(values.reduce((sum, value) => sum + value, 0n), BigInt(values.length));
    else assert(false, `unknown calibration reducer: ${reducer}`);
    const numeric = Number(result) / activeProtocol.metric_numeric_policy.scale;
    assert(Number.isFinite(numeric), "calibration aggregate overflow"); aggregate[metric.metric_id] = numeric;
  }
  return { candidate_alias: [...hashes][0], seed_aliases: view.map(row => row.opaque_seed_alias).sort(), aggregate_metrics: aggregate, aggregate_status };
}

export function assessCalibrationCandidate({ parameter_set_hash, seed_ids, aggregate_metrics, worst_seed_metric_pass_fraction = 0, cross_seed_metric_variance = 0, changes_from_start = 0 }, activeProtocol = protocol) {
  assertTreatmentBlind({ aggregate_metrics }, activeProtocol);
  assert(/^[0-9a-f]{64}$/.test(parameter_set_hash), "invalid parameter set hash");
  assert(canonicalize([...seed_ids].sort()) === canonicalize([...activeProtocol.seed_panel.seeds].sort()), "candidate did not use the complete frozen seed panel");
  const expected = new Set(activeProtocol.metrics.map(metric => metric.metric_id));
  assert(Object.keys(aggregate_metrics).length === expected.size, "calibration metric set is incomplete or contains extras");
  let minimumMargin = Infinity;
  const failures = [];
  for (const metric of activeProtocol.metrics) {
    assert(Object.hasOwn(aggregate_metrics, metric.metric_id), `missing calibration metric: ${metric.metric_id}`);
    const value = aggregate_metrics[metric.metric_id];
    assert(typeof value === "number" && Number.isFinite(value), `invalid calibration metric value: ${metric.metric_id}`);
    const { minimum, maximum } = metric.acceptance;
    if (minimum !== undefined && value < minimum) failures.push({ metric_id: metric.metric_id, value, boundary: minimum, relation: "minimum" });
    if (maximum !== undefined && value > maximum) failures.push({ metric_id: metric.metric_id, value, boundary: maximum, relation: "maximum" });
    const margins = [];
    if (minimum !== undefined) margins.push((value - minimum) / Math.max(Math.abs(minimum), 1));
    if (maximum !== undefined) margins.push((maximum - value) / Math.max(Math.abs(maximum), 1));
    minimumMargin = Math.min(minimumMargin, ...margins);
  }
  return {
    parameter_set_hash,
    accepted: failures.length === 0,
    failures,
    selection_score: {
      minimum_normalized_boundary_distance: minimumMargin,
      worst_seed_metric_pass_fraction,
      negative_cross_seed_metric_variance: -cross_seed_metric_variance,
      negative_changes_from_start: -changes_from_start,
      parameter_set_hash
    }
  };
}

export function selectCalibrationCandidate(assessments) {
  const accepted = assessments.filter(candidate => candidate.accepted);
  assert(accepted.length > 0, protocol.stopping_rule.failure);
  const fields = ["minimum_normalized_boundary_distance", "worst_seed_metric_pass_fraction", "negative_cross_seed_metric_variance", "negative_changes_from_start"];
  return clone(accepted.sort((a, b) => {
    for (const field of fields) if (a.selection_score[field] !== b.selection_score[field]) return b.selection_score[field] - a.selection_score[field];
    return a.parameter_set_hash.localeCompare(b.parameter_set_hash);
  })[0]);
}

export function calibrationProtocolIncident({ disclosure, affectedDecision, detectedAt, authority }) {
  assert(typeof disclosure === "string" && disclosure.length > 0, "incident disclosure class required");
  return Object.freeze({
    incident_type: "CALIBRATION_PROTOCOL_INCIDENT",
    protocol_version: protocol.protocol_version,
    disclosure_class: disclosure,
    affected_decision: affectedDecision,
    detected_at: detectedAt,
    authority,
    disposition: "SELECTION_INVALID_REPEAT_FROM_LAST_UNEXPOSED_STATE"
  });
}
