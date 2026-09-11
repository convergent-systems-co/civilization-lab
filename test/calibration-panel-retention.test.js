// T4 — panel completeness (criterion 8), full retention (criterion 9), and the 20-turn
// horizon cap (criterion 10), attacked independently of test/calibration-tooling.test.js.
//
// Two instruments let this suite prove that a rejection happened *before* metrics were
// computed, rather than only that some error was thrown:
//
//   1. `instrumentMetricReads` replaces each observation row's `metrics` property with a
//      getter that records every read. A panel violation must throw with an empty read log.
//   2. `metricTripwireRuntime` builds an effective world configuration whose
//      `dynamics.maxQuantity` is unusable. Nothing outside `deriveCalibrationMetricFacts`
//      reads that field, so evidence carrying it throws a recognisable metric-path error if
//      and only if metric derivation is reached. A control assertion in each test proves the
//      tripwire is live before the same evidence is used to prove the metric path was skipped.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../src/core.js";
import { loadEvidence } from "../src/evidence.js";
import {
  CALIBRATION_FAILURES,
  CalibrationArchive,
  PhaseACalibrationRunner,
  buildCalibrationResult,
  calibrationSelectionProjection,
  calibrationToolingDistributionDigest,
  collectCalibrationObservations,
  materializeCalibrationMetrics,
  materializeCalibrationRuntime,
  startingCalibrationParameterSet
} from "../src/calibration-runner.js";
import { assessCalibrationCandidate, calibrationProtocol, calibrationProtocolIncident } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import {
  syntheticAdapter,
  syntheticAttestationKeys,
  syntheticCanonicalEvidence,
  syntheticSeedPanel,
  withTempArchive
} from "./helpers/calibration-fixture.js";

const protocol = calibrationProtocol();
const registry = parameterRegistry();
const baseline = JSON.parse(readFileSync(new URL("../validation/PRE_CALIBRATION_BASELINE.json", import.meta.url), "utf8"));
const frozenProtocol = JSON.parse(readFileSync(new URL("../PILOT_0_CALIBRATION_PROTOCOL.spec.json", import.meta.url), "utf8"));
const horizonPolicy = JSON.parse(readFileSync(new URL("../HORIZON_POLICY.spec.json", import.meta.url), "utf8"));
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const panel = syntheticSeedPanel();
const MAX_TURNS = horizonPolicy.pilot_0_max_turns;

let panelObservations = null;
/** The complete frozen panel of canonical observations, derived once and shared read-only. */
function completePanelObservations() {
  panelObservations ??= panel.map(seed => collectCalibrationObservations(syntheticCanonicalEvidence({ seed })));
  return panelObservations;
}

/** Replace each row's `metrics` with a read-recording getter, preserving the row's data. */
function instrumentMetricReads(rows, reads) {
  return rows.map(row => Object.defineProperty({ ...row }, "metrics", {
    enumerable: true, configurable: true,
    get() { reads.push(row.seed); return row.metrics; }
  }));
}

/** An effective configuration that makes the metric path, and only the metric path, throw. */
function metricTripwireRuntime() {
  const runtime = materializeCalibrationRuntime(startingCalibrationParameterSet());
  return {
    parameter_set_hash: runtime.parameter_set_hash,
    effective_configuration_hash: runtime.effective_configuration_hash,
    effective_configuration: { ...runtime.effective_configuration,
      dynamics: { ...runtime.effective_configuration.dynamics, maxQuantity: null } }
  };
}
const TRIPWIRE = /registered maximum quantity/;

/** Canonical evidence extended by one more authoritative turn, keeping the hash chain valid. */
function withExtraTurn(bundle) {
  const store = loadEvidence(bundle);
  const last = store.events.filter(event => event.event_type === "SnapshotCreated").at(-1);
  const { payload_ref: ignored, ...body } = last.payload;
  store.append({ eventType: "SnapshotCreated", turn: MAX_TURNS, phase: "archive", payload: { ...body, turn: MAX_TURNS } });
  return store.bundle();
}

/** A retained attempt manifest for a parameter vector the bounded search never visits. */
function retainedAttempt({ calibrationRunId, seed, status, reason }) {
  const start = startingCalibrationParameterSet();
  const parameterSet = { ...start, "world.economy.consumption": 2,
    "world.configuration.economy": { ...start["world.configuration.economy"], foodPerCitizen: 2 } };
  return {
    schema_version: "phase-a-calibration-manifest-2.0.0", tooling_version: "phase-a-calibration-tooling-1.0.0",
    calibration_run_id: calibrationRunId, attempt_id: `retained-${status}-${seed}`,
    implementation_commit: implementation, implementation_tag: "v0.1.0-pilot0",
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: implementation,
    release_descriptor_hash: null, protocol_version: protocol.protocol_version,
    specification_versions: baseline.specification_sha256, parameter_registry_version: registry.registry_version,
    parameter_set: parameterSet, parameter_set_hash: sha256(parameterSet),
    parameter_classifications: Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, entry.classification])),
    seed, seeds: [seed], rng_provenance_ref: `addressed-rng://${seed}`,
    policy_configuration: { kind: "deterministic_synthetic_conformance" }, model_runtime_configuration: { used: false },
    runtime_environment: {}, canonical_evidence_ref: `unavailable://${status}`, metrics: {},
    treatment_blinding: protocol.blinding.selection_view, failure_classification: status, status,
    stopping_rule_hash: sha256(protocol.stopping_rule), evidence_hashes: [sha256({ seed, status })],
    metric_artifact_hash: sha256("{}\n"), reason, created_at: "1970-01-01T00:00:00.000Z"
  };
}

/** Aggregate metric values sitting inside every frozen acceptance range. */
function acceptedAggregateMetrics() {
  return Object.fromEntries(protocol.metrics.map(metric => [metric.metric_id,
    metric.acceptance.minimum !== undefined && metric.acceptance.maximum !== undefined
      ? (metric.acceptance.minimum + metric.acceptance.maximum) / 2
      : metric.acceptance.minimum !== undefined ? metric.acceptance.minimum : metric.acceptance.maximum]));
}

test("the frozen panel is exactly the 24 calibration-seed identifiers", () => {
  const expected = Array.from({ length: 24 }, (_, index) => `calibration-seed-${String(index).padStart(2, "0")}`);
  assert.equal(protocol.seed_panel.seeds.length, 24);
  assert.deepEqual(new Set(protocol.seed_panel.seeds), new Set(expected), "panel set equality against the frozen identifiers");
  assert.deepEqual([...protocol.seed_panel.seeds], expected, "panel order is frozen as well as its membership");
  assert.equal(new Set(protocol.seed_panel.seeds).size, protocol.seed_panel.seeds.length, "the frozen panel carries no duplicate seed");
  // The in-process protocol must be the frozen file, not a copy that drifted from it.
  assert.deepEqual([...frozenProtocol.seed_panel.seeds], expected);
  assert.equal(frozenProtocol.seed_panel.method, "FROZEN_COMMON_SEED_PANEL");
  assert.deepEqual(panel, expected, "the shared fixture panel is the frozen panel");
});

test("a missing, duplicated, or extra panel seed fails before any metric is computed", () => {
  const observations = completePanelObservations();
  const cases = [
    ["one seed missing", observations.slice(1)],
    ["one seed duplicated", observations.map((row, index) => (index === 1 ? observations[0] : row))],
    ["one extra seed", [...observations, observations[0]]]
  ];
  for (const [label, rows] of cases) {
    const reads = [];
    assert.throws(() => materializeCalibrationMetrics(instrumentMetricReads(rows, reads)),
      /complete frozen seed panel|exactly once/, label);
    assert.deepEqual(reads, [], `${label}: metric computation must never be reached`);
  }
  // Control: the complete panel does reach the metric path, so an empty read log above is
  // evidence of an early rejection rather than of an inert instrument.
  const reads = [];
  const rows = materializeCalibrationMetrics(instrumentMetricReads(observations, reads));
  assert.equal(rows.length, 24);
  assert.equal(reads.length, 24);
  assert.deepEqual(new Set(rows.map(row => row.seed)), new Set(panel));
});

test("canonical evidence for an off-panel seed fails before metric derivation", () => {
  const runtimeConfiguration = metricTripwireRuntime();
  // Control: on a panel seed the tripwire evidence reaches metric derivation and says so.
  assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed: panel[0], runtimeConfiguration })), TRIPWIRE);
  for (const seed of ["calibration-seed-24", "calibration-seed-99", "seed-00"]) {
    assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed, runtimeConfiguration })),
      error => /outside frozen calibration panel/.test(error.message) && !TRIPWIRE.test(error.message),
      `${seed} must be rejected as off-panel before metric derivation`);
  }
});

test("the complete panel is enforced at the metric boundary, the selector, and the candidate assessment", () => {
  const observations = completePanelObservations();
  const rows = materializeCalibrationMetrics(observations);
  const aliases = { aliasSecret: Buffer.alloc(32, 4) };
  for (const [label, projected] of [["one seed missing", rows.slice(1)], ["one extra seed", [...rows, rows[0]]]]) {
    const reads = [];
    assert.throws(() => calibrationSelectionProjection(instrumentMetricReads(projected, reads), "a".repeat(64), aliases),
      /selector requires complete frozen seed panel/, label);
    assert.deepEqual(reads, [], `${label}: the selector must not read metrics from an incomplete panel`);
  }
  // `calibrationSelectionProjection` guards row count, not membership, so a 24-row panel
  // carrying a duplicated seed would pass it. That panel is unreachable in the pipeline
  // because `materializeCalibrationMetrics` — the only producer of selector rows — rejects
  // the duplicate first, and does so before any metric on any row is read.
  const duplicatedReads = [];
  assert.throws(() => materializeCalibrationMetrics(
    instrumentMetricReads(observations.map((row, index) => (index === 1 ? observations[0] : row)), duplicatedReads)),
  /each frozen seed must appear exactly once/, "one seed duplicated");
  assert.deepEqual(duplicatedReads, [], "one seed duplicated: metric computation must never be reached");

  const aggregate_metrics = acceptedAggregateMetrics();
  const parameter_set_hash = sha256({ candidate: "panel-check" });
  assert.equal(assessCalibrationCandidate({ parameter_set_hash, seed_ids: panel, aggregate_metrics }).accepted, true);
  const duplicatedSeeds = panel.map((seed, index) => (index === 1 ? panel[0] : seed));
  assert.equal(duplicatedSeeds.length, panel.length, "the duplicated-seed list is a membership violation, not a cardinality one");
  for (const [label, seed_ids] of [
    ["one seed missing", panel.slice(1)],
    ["one seed duplicated", duplicatedSeeds],
    ["one extra seed", [...panel, panel[0]]],
    ["one off-panel seed", [...panel.slice(1), "calibration-seed-24"]]
  ]) {
    assert.throws(() => assessCalibrationCandidate({ parameter_set_hash, seed_ids, aggregate_metrics }),
      /candidate did not use the complete frozen seed panel/, label);
  }
});

test("canonical evidence carrying 21 turns fails before metric derivation", () => {
  assert.equal(MAX_TURNS, 20, "the frozen horizon policy caps Pilot 0 at 20 turns");
  assert.equal(registry.parameters.find(entry => entry.parameter_id === "pilot_0.max_turns").value, MAX_TURNS);
  assert.ok(protocol.held_constant_registry_parameters.includes("pilot_0.max_turns"), "the horizon is a held-constant parameter");

  const within = syntheticCanonicalEvidence({ seed: panel[0] });
  assert.equal(within.events.filter(event => event.event_type === "SnapshotCreated").length, MAX_TURNS);
  assert.equal(collectCalibrationObservations(within).seed, panel[0]);

  const over = withExtraTurn(within);
  assert.equal(over.events.filter(event => event.event_type === "SnapshotCreated").length, MAX_TURNS + 1);
  assert.equal(loadEvidence(over).events.length, within.events.length + 1, "the over-horizon bundle is internally valid evidence");
  assert.throws(() => collectCalibrationObservations(over), /one to twenty snapshots|turn cap/);

  // Same instrument as the panel checks: the tripwire proves metric derivation was skipped.
  const runtimeConfiguration = metricTripwireRuntime();
  assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed: panel[0], runtimeConfiguration })), TRIPWIRE);
  assert.throws(() => collectCalibrationObservations(withExtraTurn(syntheticCanonicalEvidence({ seed: panel[0], runtimeConfiguration }))),
    error => /one to twenty snapshots|turn cap/.test(error.message) && !TRIPWIRE.test(error.message),
    "over-horizon evidence must be rejected before metric derivation");
});

test("over-horizon evidence stops the runner before metric selection and the failure is retained", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const runner = new PhaseACalibrationRunner({
      directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, attestor,
      executor: async ({ seed, runtimeConfiguration }) => withExtraTurn(syntheticCanonicalEvidence({ seed, runtimeConfiguration }))
    });
    await assert.rejects(() => runner.run({ maximumCandidates: 1 }), /one to twenty snapshots|turn cap/);
    const archive = await CalibrationArchive.open(directory, attestor);
    assert.equal(archive.state.candidates.length, 0, "no candidate may be scored from over-horizon evidence");
    assert.equal(archive.state.assessments.length, 0, "metric selection must never have run");
    assert.equal(archive.state.result_ref, null);
    assert.equal(archive.state.executions.length, 0, "over-horizon evidence is never checkpointed");
    assert.equal(archive.state.attempts.length, 1, "the rejected attempt is still retained");
    const manifest = await archive.manifest(archive.state.attempts[0].attempt_id);
    assert.equal(manifest.status, CALIBRATION_FAILURES.IMPLEMENTATION_DEFECT);
    assert.deepEqual(Object.keys(manifest.metrics), [], "a retained over-horizon failure carries no computed metrics");
  });
});

test("accepted, rejected, failed, and incident-affected attempts are all retained with dispositions intact", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    const dispositions = [
      [panel[0], CALIBRATION_FAILURES.PARAMETER_FAILURE, "rejected by a frozen threshold"],
      [panel[1], CALIBRATION_FAILURES.IMPLEMENTATION_DEFECT, "execution failed"],
      [panel[2], CALIBRATION_FAILURES.PROTOCOL_VIOLATION, "affected by a protocol incident"]
    ];
    for (const [seed, status, reason] of dispositions) {
      await archive.recordAttempt(retainedAttempt({ calibrationRunId: archive.state.calibration_run_id, seed, status, reason }),
        { evidence: { retained: status, seed }, metrics: {} });
    }

    const adapter = syntheticAdapter();
    const result = await new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
      implementationCommit: implementation, executor: adapter.executor, attestor }).run({ maximumCandidates: 1 });
    assert.deepEqual(new Set(result.evaluated_seeds), new Set(panel), "the accepted candidate used the complete panel");

    const reopened = await CalibrationArchive.open(directory, attestor);
    const retained = Object.fromEntries(reopened.state.attempts.map(item => [item.attempt_id, item.status]));
    assert.equal(reopened.state.attempts.length, 27, "24 accepted seeds plus three retained non-accepted attempts");
    for (const [seed, status] of dispositions) assert.equal(retained[`retained-${status}-${seed}`], status, `${status} disposition is intact`);
    assert.equal(Object.values(retained).filter(status => status === CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION).length, 24);
    const manifests = await Promise.all(reopened.state.attempts.map(item => reopened.manifest(item.attempt_id)));
    assert.ok(manifests.every(manifest => manifest !== null), "every retained attempt still has its immutable manifest");
    for (const [seed, status, reason] of dispositions) {
      const manifest = manifests.find(item => item.attempt_id === `retained-${status}-${seed}`);
      assert.equal(manifest.failure_classification, status);
      assert.equal(manifest.reason, reason);
      assert.equal(manifest.seed, seed);
    }

    // Reporting retains what execution retained: the published result covers every attempt,
    // not only the accepted panel.
    assert.deepEqual([...result.all_attempt_manifest_hashes].sort(), manifests.map(sha256).sort(),
      "the published result reports every retained attempt");

    // An incident-affected attempt stays in the record and blocks any later result.
    const incident = calibrationProtocolIncident({ disclosure: "TREATMENT_LABEL_DISCLOSED",
      affectedDecision: `retained-${CALIBRATION_FAILURES.PROTOCOL_VIOLATION}-${panel[2]}`,
      detectedAt: "1970-01-01T00:00:00.000Z", authority: "calibration-protocol-authority" });
    await assert.rejects(reopened.recordIncident({ disclosure: "TREATMENT_LABEL_DISCLOSED",
      affectedDecision: incident.affected_decision }), /completed calibration archive is immutable/);
    assert.throws(() => buildCalibrationResult({ candidates: reopened.state.assessments, manifests,
      protocolVersion: protocol.protocol_version, implementationCommit: implementation,
      incidents: [incident] }), /incidents prevent result selection/);

    // Re-reading the archive returns the same complete attempt set.
    const thirdRead = await CalibrationArchive.open(directory, attestor);
    assert.deepEqual(thirdRead.state.attempts, reopened.state.attempts);
    assert.deepEqual(thirdRead.state.completed_keys.sort(), reopened.state.completed_keys.sort());
  });
});

test("rejected candidates are reported in the result, never dropped from it", () => {
  const acceptedSet = { candidate: "accepted" }, rejectedSet = { candidate: "rejected" };
  const bounded = protocol.metrics.find(metric => metric.acceptance.maximum !== undefined);
  const acceptedMetrics = acceptedAggregateMetrics();
  const rejectedMetrics = { ...acceptedAggregateMetrics(), [bounded.metric_id]: bounded.acceptance.maximum + 1 };
  const accepted = assessCalibrationCandidate({ parameter_set_hash: sha256(acceptedSet), seed_ids: panel,
    aggregate_metrics: acceptedMetrics, worst_seed_metric_pass_fraction: 1 });
  const rejected = assessCalibrationCandidate({ parameter_set_hash: sha256(rejectedSet), seed_ids: panel,
    aggregate_metrics: rejectedMetrics });
  assert.equal(accepted.accepted, true);
  assert.equal(rejected.accepted, false);
  accepted.parameter_set = acceptedSet; accepted.aggregate_metrics = acceptedMetrics;
  accepted.aggregate_status = {}; accepted.candidate_attestation_hash = "a".repeat(64);
  rejected.parameter_set = rejectedSet; rejected.aggregate_metrics = rejectedMetrics;
  rejected.aggregate_status = {}; rejected.candidate_attestation_hash = "b".repeat(64);
  const result = buildCalibrationResult({ candidates: [accepted, rejected], manifests: panel.map(seed => ({ seed })),
    protocolVersion: protocol.protocol_version, implementationCommit: implementation, incidents: [] });
  assert.equal(result.selected_parameter_set_hash, accepted.parameter_set_hash);
  assert.deepEqual(result.rejected_configurations, [rejected.parameter_set_hash], "the rejected vector is reported, not dropped");
  assert.deepEqual(result.search_history.map(item => item.parameter_set_hash).sort(),
    [accepted.parameter_set_hash, rejected.parameter_set_hash].sort());
  assert.equal(result.search_history.find(item => item.parameter_set_hash === rejected.parameter_set_hash).accepted, false);
  assert.ok(result.search_history.find(item => item.parameter_set_hash === rejected.parameter_set_hash).failures.length > 0,
    "the rejected candidate keeps its recorded threshold failures");
});

test("no public API drops, filters, or replaces a retained attempt", async () => {
  const forbidden = /^(delete|remove|drop|prune|purge|discard|filter|retract|exclude|replace|rewrite|forget)/i;
  const surface = Object.getOwnPropertyNames(CalibrationArchive.prototype).filter(name => !name.startsWith("_"));
  assert.deepEqual(surface.filter(name => forbidden.test(name)), [], "the archive exposes no attempt-removal verb");
  const runnerModule = await import("../src/calibration-runner.js");
  assert.deepEqual(Object.keys(runnerModule).filter(name => forbidden.test(name) && /attempt|candidate|seed|record/i.test(name)), []);

  // An immutable record cannot be re-recorded under a different disposition.
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    const runId = archive.state.calibration_run_id;
    const failed = retainedAttempt({ calibrationRunId: runId, seed: panel[0], status: CALIBRATION_FAILURES.IMPLEMENTATION_DEFECT, reason: "execution failed" });
    await archive.recordAttempt(failed, { evidence: { retained: "failed" }, metrics: {} });
    await assert.rejects(() => archive.recordAttempt({ ...failed, status: CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION,
      failure_classification: CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION }, { evidence: {}, metrics: {} }), /immutable|already recorded/i);
    const reopened = await CalibrationArchive.open(directory, attestor);
    assert.equal(reopened.state.attempts.length, 1);
    assert.equal(reopened.state.attempts[0].status, CALIBRATION_FAILURES.IMPLEMENTATION_DEFECT);
  });

  // A state mutation that drops a retained attempt from the index must not survive reopening.
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    const runId = archive.state.calibration_run_id;
    for (const seed of [panel[0], panel[1]]) {
      await archive.recordAttempt(retainedAttempt({ calibrationRunId: runId, seed,
        status: CALIBRATION_FAILURES.PARAMETER_FAILURE, reason: "rejected by a frozen threshold" }),
      { evidence: { retained: seed }, metrics: {} });
    }
    const victim = archive.state.attempts[0].attempt_id;
    await archive.update(state => { state.attempts = state.attempts.filter(item => item.attempt_id !== victim); return state; });
    await assert.rejects(() => CalibrationArchive.open(directory, attestor),
      /signed calibration history deleted or mutated retained attempts|orphan calibration attempt or missing retained attempt detected/);
  });

});

// A state mutation that drops a completed key leaves the index claiming fewer completed
// attempts than it retains, which is the precondition for a silent retry.
//
test("a completed-key index that no longer covers every retained attempt fails closed", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    const runId = archive.state.calibration_run_id;
    await archive.recordAttempt(retainedAttempt({ calibrationRunId: runId, seed: panel[0],
      status: CALIBRATION_FAILURES.PARAMETER_FAILURE, reason: "rejected by a frozen threshold" }),
    { evidence: { retained: panel[0] }, metrics: {} });
    const key = archive.state.completed_keys[0];
    await archive.update(state => { state.completed_keys = state.completed_keys.filter(item => item !== key); return state; });
    await assert.rejects(() => CalibrationArchive.open(directory, attestor),
      /signed calibration history deleted retained completed_keys|completed-key index differs from retained calibration attempts/,
      "a completed-key index that no longer covers every retained attempt must fail closed");
  });

});

test("a signer cannot erase both a retained attempt index and its artifact directory", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    const attempt = retainedAttempt({ calibrationRunId: archive.state.calibration_run_id, seed: panel[0],
      status: CALIBRATION_FAILURES.PARAMETER_FAILURE, reason: "retained rejected vector" });
    await archive.recordAttempt(attempt, { evidence: { retained: panel[0] }, metrics: {} });
    await archive.update(state => {
      state.attempts = [];
      state.completed_keys = [];
      return state;
    });
    await rm(join(directory, "attempts", attempt.attempt_id), { recursive: true });
    await assert.rejects(() => CalibrationArchive.open(directory, attestor), /signed calibration history deleted or mutated retained attempts/,
      "a newly signed generation must not authenticate deletion of retained failed evidence");
  });
});

for (const [field, retained, rejection] of [
  ["attempts", { attempt_id: "retained-attempt" }, /retained attempts/],
  ["completed_keys", "retained-key", /retained completed_keys/],
  ["executions", { key: "retained-execution" }, /retained executions/],
  ["assessments", { parameter_set_hash: "a".repeat(64) }, /retained assessments/],
  ["candidates", { parameter_set_hash: "b".repeat(64) }, /retained candidates/],
  ["incidents", { incident_type: "retained-incident" }, /retained incidents/],
  ["execution_intents", { key: "retained-intent", attempt_id: "attempt", request: {}, request_hash: "c".repeat(64), status: "DISPATCH_PENDING" }, /retained execution intent/]
]) test(`a later archive-signer generation cannot delete ${field}`, async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const archive = await new CalibrationArchive(directory, attestor)
      .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    await archive.update(state => { state[field].push(structuredClone(retained)); return state; });
    await archive.update(state => { state[field] = []; return state; });
    await assert.rejects(() => CalibrationArchive.open(directory, attestor), rejection);
  });
});

/** Initialize an archive holding exactly one retained attempt; returns its artifact directory. */
async function archiveWithOneRetainedAttempt(directory, attestor) {
  const archive = await new CalibrationArchive(directory, attestor)
    .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  await archive.recordAttempt(retainedAttempt({ calibrationRunId: archive.state.calibration_run_id, seed: panel[0],
    status: CALIBRATION_FAILURES.PARAMETER_FAILURE, reason: "rejected by a frozen threshold" }),
  { evidence: { retained: panel[0] }, metrics: {} });
  return join(directory, "attempts", archive.state.attempts[0].attempt_id);
}

// Gutting a retained attempt in place — its manifest or an artifact the manifest points at —
// leaves the attempt directory both indexed and present on disk, so the orphan-directory guard
// stays silent. Only the per-attempt manifest and artifact checks can catch it, and each is
// pinned to its own message here so neither can be satisfied by an unrelated fail-closed path.
//
test("a retained attempt whose metric artifact was removed fails closed when the archive is opened", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const attemptDirectory = await archiveWithOneRetainedAttempt(directory, attestor);
    // Control: the archive opens cleanly while the attempt's artifacts are intact.
    assert.equal((await CalibrationArchive.open(directory, attestor)).state.attempts.length, 1);
    await rm(join(attemptDirectory, "metrics.json"));
    assert.ok(existsSync(attemptDirectory) && existsSync(join(attemptDirectory, "manifest.json")),
      "the attempt stays indexed and present, so the orphan-directory guard cannot be what fires");
    // Deleting the file outright surfaces as a stat failure naming that exact artifact path,
    // which no other fail-closed guard in the open path can produce.
    await assert.rejects(() => CalibrationArchive.open(directory, attestor),
      error => error.code === "ENOENT" && error.path === join(attemptDirectory, "metrics.json"),
      "a retained attempt whose metric artifact is gone must fail closed on open");
  });

  // Substituting a directory for the artifact lets the stat succeed, so the guard's own
  // message is what rejects, and this case pins that message exactly.
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const attemptDirectory = await archiveWithOneRetainedAttempt(directory, attestor);
    await rm(join(attemptDirectory, "metrics.json"));
    await mkdir(join(attemptDirectory, "metrics.json"));
    await assert.rejects(() => CalibrationArchive.open(directory, attestor),
      /retained calibration attempt artifact is missing/,
      "a retained attempt whose metric artifact is not a readable file must fail closed on open");
  });
});

test("a retained attempt whose manifest is no longer a file fails closed when the archive is opened", async () => {
  await withTempArchive(async directory => {
    const attestor = syntheticAttestationKeys();
    const attemptDirectory = await archiveWithOneRetainedAttempt(directory, attestor);
    await rm(join(attemptDirectory, "manifest.json"));
    await mkdir(join(attemptDirectory, "manifest.json"));
    await assert.rejects(() => CalibrationArchive.open(directory, attestor),
      /retained calibration attempt manifest is missing/,
      "a retained attempt whose manifest is not a readable file must fail closed on open");
  });
});
