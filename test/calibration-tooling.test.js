import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sha256 } from "../src/core.js";
import {
  CALIBRATION_FAILURES,
  calibrationToolingDistributionDigest,
  CalibrationArchive,
  PhaseACalibrationRunner,
  attestCalibrationAttempt,
  buildCalibrationResult,
  calibrationSelectionProjection,
  collectCalibrationObservations,
  materializeCalibrationMetrics,
  runCalibrationSelectorSandbox,
  assertCalibrationTransition,
  startingCalibrationParameterSet,
  validateCalibrationParameterSet,
  verifyCalibrationAttestation
} from "../src/calibration-runner.js";
import { calibrationProtocol } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import { syntheticAttestationKeys, syntheticCanonicalEvidence } from "./helpers/calibration-fixture.js";

const protocol = calibrationProtocol();
const baseline = JSON.parse(readFileSync(new URL("../validation/PRE_CALIBRATION_BASELINE.json", import.meta.url), "utf8"));
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";

function acceptedMetricFixture() {
  return Object.fromEntries(protocol.metrics.map(metric => [metric.metric_id,
    metric.acceptance.minimum !== undefined && metric.acceptance.maximum !== undefined
      ? (metric.acceptance.minimum + metric.acceptance.maximum) / 2
      : metric.acceptance.minimum !== undefined ? metric.acceptance.minimum : metric.acceptance.maximum]));
}

test("canonical-evidence collector is deterministic and rejects treatment-bearing evidence", () => {
  const bundle = syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[0] });
  assert.deepEqual(collectCalibrationObservations(bundle), collectCalibrationObservations(structuredClone(bundle)));
  assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed: "leak", treatmentLeak: true })), /blinding/i);
});

test("panel materialization emits every frozen metric from complete canonical evidence", () => {
  const observations = protocol.seed_panel.seeds.map(seed => collectCalibrationObservations(syntheticCanonicalEvidence({ seed })));
  const rows = materializeCalibrationMetrics(observations);
  assert.equal(rows.length, 24);
  assert.deepEqual(Object.keys(rows[0].metrics).sort(), protocol.metrics.map(x => x.metric_id).sort());
  assert.throws(() => materializeCalibrationMetrics(observations.slice(1)), /complete frozen seed panel/);
});

test("archive preserves attempts immutably and resumes without double-counting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-calibration-"));
  const archive = new CalibrationArchive(directory);
  await archive.initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  const parameterSet = startingCalibrationParameterSet();
  const attempt = { schema_version: "phase-a-calibration-manifest-2.0.0", tooling_version: "phase-a-calibration-tooling-1.1.0", calibration_run_id: archive.state.calibration_run_id, attempt_id: "attempt-1",
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: implementation, release_descriptor_hash: null,
    implementation_commit: implementation, implementation_tag: "v0.1.0-pilot0", protocol_version: protocol.protocol_version,
    specification_versions: baseline.specification_sha256,
    parameter_registry_version: parameterRegistry().registry_version, parameter_set: parameterSet, parameter_set_hash: sha256(parameterSet),
    parameter_classifications: Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, entry.classification])), seed: "calibration-seed-00", seeds: ["calibration-seed-00"],
    rng_provenance_ref: "rng://seed", policy_configuration: {}, model_runtime_configuration: { used: false }, runtime_environment: {},
    canonical_evidence_ref: "content://evidence", metrics: {}, treatment_blinding: "CALIBRATION_TREATMENT_BLIND_V1",
    failure_classification: CALIBRATION_FAILURES.PARAMETER_FAILURE, status: CALIBRATION_FAILURES.PARAMETER_FAILURE,
    stopping_rule_hash: sha256(protocol.stopping_rule), evidence_hashes: ["c".repeat(64)], metric_artifact_hash: "d".repeat(64),
    reason: "synthetic rejection", created_at: "1970-01-01T00:00:00.000Z", attestation: {} };
  await archive.recordAttempt(attempt, { evidence: { synthetic: true }, metrics: { synthetic: true } });
  await assert.rejects(() => archive.recordAttempt({ ...attempt, status: CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION }, { evidence: {}, metrics: {} }), /immutable|already/i);
  const resumed = await CalibrationArchive.open(directory);
  assert.equal(resumed.state.attempts.length, 1);
  assert.equal(resumed.state.completed_keys.length, 1);
});

test("attestation binds baseline, protocol, domains, evidence, metrics, seeds, and blinding", () => {
  const { privateKey, publicKey, keyId } = syntheticAttestationKeys();
  const parameterSet = startingCalibrationParameterSet();
  const attempt = {
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: implementation, release_descriptor_hash: null,
    schema_version: "2.0.0", tooling_version: "phase-a-calibration-tooling-1.1.0", calibration_run_id: "cal-run", attempt_id: "attempt-1",
    implementation_commit: implementation, implementation_tag: "v0.1.0-pilot0",
    protocol_version: protocol.protocol_version, parameter_registry_version: "pilot-0.3-world-endpoint",
    specification_versions: baseline.specification_sha256, parameter_set: parameterSet, parameter_set_hash: sha256(parameterSet),
    parameter_classifications: Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, entry.classification])),
    policy_configuration: { kind: "synthetic" }, model_runtime_configuration: { used: false }, runtime_environment: { node: process.version },
    seeds: [...protocol.seed_panel.seeds], evidence_hashes: protocol.seed_panel.seeds.map(() => "a".repeat(64)), metric_artifact_hash: "b".repeat(64),
    treatment_blinding: "CALIBRATION_TREATMENT_BLIND_V1", stopping_rule_hash: sha256(protocol.stopping_rule),
    failure_classification: CALIBRATION_FAILURES.ACCEPTED_CONFIGURATION
  };
  const attestation = attestCalibrationAttempt(attempt, { privateKey, keyId });
  assert.equal(verifyCalibrationAttestation(attempt, attestation, { [keyId]: publicKey }), true);
  assert.throws(() => verifyCalibrationAttestation({ ...attempt, metric_artifact_hash: "c".repeat(64) }, attestation, { [keyId]: publicKey }), /attestation/i);
  assert.throws(() => verifyCalibrationAttestation(attempt, { ...attestation, signature: Buffer.alloc(64).toString("base64") }, { [keyId]: publicKey }), /attestation/i);
});

test("synthetic runner evaluates every seed, writes manifests, and is crash-resumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-runner-"));
  let calls = 0;
  const runner = new PhaseACalibrationRunner({
    directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async request => {
      calls++;
      assert.equal(Object.hasOwn(request, "protocol"), false);
      assert.equal(Object.hasOwn(request, "metrics"), false);
      assert.equal(Object.hasOwn(request, "stoppingRule"), false);
      assert.deepEqual(Object.keys(request).sort(), ["adapterContractHash", "adapterPackageHash", "attemptId", "calibrationRunId", "idempotencyKey", "maxTurns", "mode", "modelRuntimeLock", "neutralPolicyManifest", "objectiveTerminalPredicates", "parameterSet", "policyBinding", "runtimeConfiguration", "schema_version", "seed"].sort());
      return syntheticCanonicalEvidence({ seed: request.seed, runtimeConfiguration: request.runtimeConfiguration });
    }
  });
  const result = await runner.run({ maximumCandidates: 1 });
  assert.equal(result.attempted_parameter_vectors, 1);
  assert.equal(result.evaluated_seeds.length, 24);
  assert.equal(result.calibration_execution_authorized, false);
  assert.equal(result.pilot0_research_authorized, false);
  assert.equal(result.confirmatory_authorized, false);
  assert.equal(Object.hasOwn(result, "empirical_authorization"), false);
  assert.equal(calls, 24);
  assert.equal(result.stopping_rule_satisfied, true);
  const resumed = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async () => { throw new Error("must not rerun completed seed"); } });
  const second = await resumed.run({ maximumCandidates: 1 });
  assert.equal(second.evaluated_seeds.length, 24);
});

test("runner fails closed for empirical execution and protocol/baseline mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-guard-"));
  const executor = async ({ seed }) => syntheticCanonicalEvidence({ seed });
  await assert.rejects(() => new PhaseACalibrationRunner({ directory, mode: "EMPIRICAL_CALIBRATION", implementationCommit: implementation, executor }).run(), /authorization|authenticated production/i);
  await assert.rejects(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: "0".repeat(40), executor }).run({ maximumCandidates: 1 }), /implementation baseline/i);
});

test("failure classes are closed and selection result is reproducible", () => {
  assert.deepEqual(Object.keys(CALIBRATION_FAILURES).sort(), ["ACCEPTED_CONFIGURATION", "BLINDING_BREACH", "IMPLEMENTATION_DEFECT", "INFRASTRUCTURE_FAILURE", "PARAMETER_FAILURE", "PROTOCOL_VIOLATION", "RESEARCH_DESIGN_BLOCKER"].sort());
  const metric = acceptedMetricFixture();
  const candidates = [{ value: 2 }, { value: 1 }].map(parameter_set => ({
    parameter_set, parameter_set_hash: sha256(parameter_set), accepted: true, failures: [], aggregate_metrics: metric,
    candidate_attestation_hash: "c".repeat(64),
    selection_score: { minimum_normalized_boundary_distance: 1, worst_seed_metric_pass_fraction: 1,
      negative_cross_seed_metric_variance: 0, negative_changes_from_start: 0, parameter_set_hash: sha256(parameter_set) }
  }));
  const result = buildCalibrationResult({ candidates, manifests: protocol.seed_panel.seeds.map(seed => ({ seed })), protocolVersion: protocol.protocol_version,
    implementationCommit: implementation, incidents: [] });
  assert.equal(result.selected_parameter_set_hash, candidates.map(item => item.parameter_set_hash).sort()[0]);
  assert.equal(result.stopping_rule_satisfied, true);
});

test("corrupted state, fabricated metrics, duplicate seeds, and treatment queries fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-corrupt-"));
  const archive = new CalibrationArchive(directory);
  await archive.initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  await writeFile(join(directory, "state.json"), "{}\n");
  await assert.rejects(() => CalibrationArchive.open(directory), /state|schema|integrity/i);
  const observations = protocol.seed_panel.seeds.map(seed => collectCalibrationObservations(syntheticCanonicalEvidence({ seed })));
  observations[1] = structuredClone(observations[0]);
  assert.throws(() => materializeCalibrationMetrics(observations), /seed.*exactly once|complete frozen/i);
});

test("selector capability rejects treatment fields and exposes no evidence-loader authority", () => {
  const observations = protocol.seed_panel.seeds.map(seed => collectCalibrationObservations(syntheticCanonicalEvidence({ seed })));
  const rows = materializeCalibrationMetrics(observations);
  const aliases = { aliasSecret: Buffer.alloc(32, 7) };
  const view = calibrationSelectionProjection(rows, "a".repeat(64), aliases);
  assert.doesNotMatch(JSON.stringify(view), /canonical_evidence|evidence_hash|rng_provenance|parameter_set|treatment_arm|endpoint|effect_size|calibration-seed/i);
  assert.deepEqual(Object.keys(view[0]).sort(), ["candidate_alias", "disposition", "metrics", "opaque_run_alias", "opaque_seed_alias", "treatment_blinding"].sort());
  assert.throws(() => calibrationSelectionProjection(rows.map((row, index) => index ? row : { ...row, treatment_arm: "x" }), "a".repeat(64), aliases), /unauthorized field/);
});

test("selector process has OS-enforced filesystem, network, child-process and write denial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-selector-probe-"));
  const secret = join(directory, "forbidden-evidence.json"), probe = join(directory, "probe.mjs");
  await writeFile(secret, "treatment-arm-secret\n");
  await writeFile(probe, `import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const denied = {};
try { readFileSync(${JSON.stringify(secret)}); denied.read = false; } catch { denied.read = true; }
try { writeFileSync(${JSON.stringify(join(directory, "write"))}, "x"); denied.write = false; } catch { denied.write = true; }
try { spawnSync(process.execPath, ["--version"]); denied.child = false; } catch { denied.child = true; }
denied.network = process.permission.has("net") === false;
process.stdout.write(JSON.stringify(denied));
`);
  const child = runCalibrationSelectorSandbox(probe, "");
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { read: true, write: true, child: true, network: true });
});

test("parameter registry rejects unknown, held, out-of-domain, and manual substitutions", () => {
  const starting = startingCalibrationParameterSet();
  assert.equal(validateCalibrationParameterSet(starting), true);
  assert.throws(() => validateCalibrationParameterSet({ ...starting, invented: 1 }), /unauthorized or missing/);
  assert.throws(() => validateCalibrationParameterSet({ ...starting, "pilot_0.max_turns": 19 }), /held calibration parameter/);
  assert.throws(() => validateCalibrationParameterSet({ ...starting, "world.economy.consumption": 9 }), /out-of-domain/);
  const hiddenMemoryMutation = structuredClone(starting);
  hiddenMemoryMutation["world.configuration.memory"].retrieval = "operator_chosen_strategy";
  assert.throws(() => validateCalibrationParameterSet(hiddenMemoryMutation), /fixed calibration field|unselected calibration field/);
  assert.throws(() => assertCalibrationTransition(starting, { ...starting, "world.economy.consumption": 2 }, { operation: "BASELINE", domain_id: null, selector: null, value: null }), /manual calibration parameter substitution/);
  assert.throws(() => assertCalibrationTransition(starting, starting, { operation: "BASELINE", domain_id: null, selector: null, value: "invented" }), /exact frozen operation/);
});

test("collector rejects unbound parameter vectors and malformed turn/terminal histories", () => {
  const starting = startingCalibrationParameterSet();
  assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[0] }), { expectedParameterSet: starting }), /parameter set differs/);
  for (const mutate of [
    bundle => { bundle.events = bundle.events.filter(event => !(event.event_type === "TurnResolved" && event.turn === 5)); },
    bundle => { bundle.events.push(structuredClone(bundle.events.find(event => event.event_type === "TurnResolved" && event.turn === 5))); },
    bundle => { bundle.events.at(-1).turn = 20; },
    bundle => { bundle.events = bundle.events.filter(event => !(event.event_type === "SnapshotCreated" && event.turn >= 10)); }
  ]) {
    const bundle = syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[0] }); mutate(bundle);
    assert.throws(() => collectCalibrationObservations(bundle), /integrity|digest|contiguous|duplicate|turn cap|absorbing|order/i);
  }
});

test("crash after evidence checkpoint resumes without rerunning the completed seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-crash-resume-"));
  let crashed = false, firstCalls = 0;
  const first = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async ({ seed, runtimeConfiguration }) => { firstCalls++; return syntheticCanonicalEvidence({ seed, runtimeConfiguration }); },
    fault: point => { if (point === "after_evidence_persisted" && !crashed) { crashed = true; throw new Error("synthetic crash"); } } });
  await assert.rejects(() => first.run({ maximumCandidates: 1 }), /synthetic crash/);
  assert.equal(firstCalls, 1);
  let resumedCalls = 0;
  const resumed = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async ({ seed, runtimeConfiguration }) => { resumedCalls++; return syntheticCanonicalEvidence({ seed, runtimeConfiguration }); } });
  await resumed.run({ maximumCandidates: 1 });
  assert.equal(resumedCalls, 23);
});

test("archive verification detects fabricated metrics and validates trusted candidate attestation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-attested-"));
  const { privateKey, publicKey, keyId } = syntheticAttestationKeys();
  const attestor = { privateKey, publicKey, keyId };
  const runner = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async ({ seed, runtimeConfiguration }) => syntheticCanonicalEvidence({ seed, runtimeConfiguration }), attestor });
  await runner.run({ maximumCandidates: 1 });
  const archive = await CalibrationArchive.open(directory, attestor);
  assert.equal(await archive.verify({ trustedKeys: { [attestor.keyId]: publicKey } }), true);
  const manifest = await archive.manifest(archive.state.attempts[0].attempt_id);
  await writeFile(join(directory, manifest.metric_artifact), JSON.stringify({ fabricated: 1 }) + "\n");
  await assert.rejects(() => archive.verify({ trustedKeys: { [attestor.keyId]: publicKey } }), /artifact content hash mismatch/);
});

test("implementation failures are retained as execution attempts and never complete calibration keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-failure-class-"));
  const runner = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async () => { throw new Error("reducer exploded"); } });
  await assert.rejects(() => runner.run({ maximumCandidates: 1 }), /reducer exploded/);
  const archive = await CalibrationArchive.open(directory);
  assert.equal(archive.state.attempts.length, 0);
  assert.equal(archive.state.completed_keys.length, 0);
  assert.equal(archive.state.execution_attempts.length, 1);
  assert.equal(archive.state.execution_attempts[0].transitions.at(-1).state, "FAILED_TERMINAL");
  assert.equal(archive.state.status, "FAILED");
  let retries = 0;
  const resumed = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async () => { retries++; return syntheticCanonicalEvidence(); } });
  await assert.rejects(() => resumed.run({ maximumCandidates: 1 }), /terminally failed/);
  assert.equal(retries, 0, "terminal failed seed must never be re-executed under the same attempt identity");
});

test("treatment disclosure is retained as a signed blinding incident", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-blinding-incident-"));
  const runner = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async ({ seed, runtimeConfiguration }) => syntheticCanonicalEvidence({ seed, runtimeConfiguration, treatmentLeak: true }) });
  await assert.rejects(() => runner.run({ maximumCandidates: 1 }), /calibration blinding/);
  const archive = await CalibrationArchive.open(directory);
  assert.equal(archive.state.status, "FAILED");
  assert.equal(archive.state.attempts.length, 0);
  assert.equal(archive.state.completed_keys.length, 0);
  assert.equal(archive.state.execution_attempts[0].transitions.at(-1).state, "FAILED_TERMINAL");
  assert.equal(archive.state.incidents.length, 1);
  assert.equal(archive.state.incidents[0].disposition, "SELECTION_INVALID_REPEAT_FROM_LAST_UNEXPOSED_STATE");
});

test("signed state generations enforce cross-process lock and expected-head CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-calibration-cas-"));
  const first = await new CalibrationArchive(directory).initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  const second = await CalibrationArchive.open(directory);
  const staleHead = second.head.digest;
  await first.update(state => { state.status = "RUNNING"; return state; });
  await assert.rejects(() => second.update(state => state, { expectedHead: staleHead }), /stale calibration archive head/);
  const holder = first.update(async state => { await new Promise(resolve => setTimeout(resolve, 40)); return state; });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(() => second.update(state => state), /claimed by another writer|locked|busy/);
  await holder;
});

test("trusted head detects rollback and startup rejects orphan artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civilization-calibration-rollback-"));
  const { privateKey, publicKey, keyId } = syntheticAttestationKeys();
  const trust = { privateKey, publicKey, keyId, trustScope: "SYNTHETIC_CONFORMANCE" };
  const archive = await new CalibrationArchive(directory, trust).initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  await archive.update(state => { state.status = "RUNNING"; return state; });
  const trustedHead = structuredClone(archive.head);
  const names = (await readdir(join(directory, "generations"))).sort();
  await unlink(join(directory, "generations", names.at(-1)));
  // A retained signed journal can restore the exact committed generation.
  // A rollback attack must remove that durable copy as well.
  await unlink(join(directory, "transactions", names.at(-1)));
  const priorName = names.at(-2), priorEnvelope = JSON.parse(await readFile(join(directory, "generations", priorName), "utf8"));
  await writeFile(join(directory, "state.json"), JSON.stringify({ generation: priorEnvelope.body.generation, digest: sha256(priorEnvelope), key_id: keyId }) + "\n");
  await assert.rejects(() => CalibrationArchive.open(directory, { publicKey, keyId, trustedHead }), /rollback|trusted-head/);

  const clean = await mkdtemp(join(tmpdir(), "civilization-calibration-orphan-"));
  await new CalibrationArchive(clean).initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  await writeFile(join(clean, "evidence", "orphan.json"), "{}\n");
  await assert.rejects(() => CalibrationArchive.open(clean), /orphan calibration evidence/);

  for (const filename of ["CALIBRATION_RESULT.json", "PILOT_0_WORLD_CONFIGURATION.json"]) {
    const rootOutput = await mkdtemp(join(tmpdir(), "civilization-calibration-root-output-"));
    await new CalibrationArchive(rootOutput).initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
    await writeFile(join(rootOutput, filename), "{}\n");
    await assert.rejects(() => CalibrationArchive.open(rootOutput), /orphan calibration result\/world-configuration/);
  }
});

test("stopping proof cannot be emitted without an accepted candidate", () => {
  const parameter_set = startingCalibrationParameterSet();
  const aggregate_metrics = Object.fromEntries(protocol.metrics.map(metric => [metric.metric_id, metric.acceptance.maximum !== undefined ? metric.acceptance.maximum + 1 : (metric.acceptance.minimum ?? 0) - 1]));
  assert.throws(() => buildCalibrationResult({ candidates: [{ parameter_set, parameter_set_hash: sha256(parameter_set), aggregate_metrics, accepted: false, selection_score: {}, candidate_attestation_hash: "a".repeat(64) }],
    manifests: [], protocolVersion: protocol.protocol_version, implementationCommit: implementation, incidents: [] }), /STOP_CALIBRATION/);
});

test("result builder recomputes acceptance and rejects forged maximin/stopping claims", () => {
  const parameter_set = startingCalibrationParameterSet();
  const aggregate_metrics = Object.fromEntries(protocol.metrics.map(metric => [metric.metric_id, 1_000_000_000]));
  const forged = { parameter_set, parameter_set_hash: sha256(parameter_set), aggregate_metrics,
    accepted: true, failures: [], candidate_attestation_hash: "a".repeat(64),
    selection_score: { minimum_normalized_boundary_distance: 1_000_000_000,
      worst_seed_metric_pass_fraction: 1, negative_cross_seed_metric_variance: 0,
      negative_changes_from_start: 0, parameter_set_hash: sha256(parameter_set) } };
  assert.throws(() => buildCalibrationResult({ candidates: [forged], manifests: protocol.seed_panel.seeds.map(seed => ({ seed })),
    protocolVersion: protocol.protocol_version, implementationCommit: implementation, incidents: [] }), /STOP_CALIBRATION/);
});

test("CLI exposes frozen plan and has no empirical execution path", () => {
  const plan = spawnSync(process.execPath, [new URL("../scripts/calibration-cli.js", import.meta.url).pathname, "plan"], { encoding: "utf8" });
  assert.equal(plan.status, 0);
  const parsed = JSON.parse(plan.stdout);
  assert.equal(parsed.protocol_version, protocol.protocol_version);
  assert.equal(parsed.frozen_seed_count, 24);
  assert.equal(parsed.empirical_calibration_authorized, false);
  const run = spawnSync(process.execPath, [new URL("../scripts/calibration-cli.js", import.meta.url).pathname, "run"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /empirical calibration is not authorized/);
});

test("incomplete and over-horizon canonical evidence fail before metric selection", () => {
  const bundle = syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[0] });
  bundle.events = bundle.events.filter(event => event.event_type !== "SnapshotCreated");
  assert.throws(() => collectCalibrationObservations(bundle), /evidence|snapshot|integrity|order/i);
  const valid = syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[0] });
  const snapshot = valid.events.find(event => event.event_type === "SnapshotCreated");
  snapshot.turn = 20;
  assert.throws(() => collectCalibrationObservations(valid), /integrity|digest|turn cap|order/i);
});

// Shared deterministic calibration fixture helper (T1). The helper is loaded through a
// dynamic import so that its absence fails only these contract tests rather than the whole
// file, and so the helper's own module identity can be inspected from a child process.
const fixtureHelper = new URL("./helpers/calibration-fixture.js", import.meta.url);

test("fixture helper exports the frozen synthetic seed panel", async () => {
  const { syntheticSeedPanel } = await import(fixtureHelper.href);
  const panel = syntheticSeedPanel();
  assert.equal(panel.length, 24);
  assert.equal(panel[0], "calibration-seed-00");
  assert.equal(panel[23], "calibration-seed-23");
  assert.deepEqual(panel, [...protocol.seed_panel.seeds]);
  const again = syntheticSeedPanel();
  assert.deepEqual(again, panel);
  assert.notEqual(again, panel, "each call must return a fresh array so callers cannot mutate the frozen panel");
});

test("fixture helper builds deterministic canonical evidence that fails closed on treatment leakage", async () => {
  const { syntheticCanonicalEvidence } = await import(fixtureHelper.href);
  const seed = protocol.seed_panel.seeds[0];
  assert.deepEqual(syntheticCanonicalEvidence({ seed }), syntheticCanonicalEvidence({ seed }));
  const observations = collectCalibrationObservations(syntheticCanonicalEvidence({ seed }));
  assert.deepEqual(observations, collectCalibrationObservations(syntheticCanonicalEvidence({ seed })));
  assert.notDeepEqual(observations, collectCalibrationObservations(syntheticCanonicalEvidence({ seed: protocol.seed_panel.seeds[1] })));
  assert.doesNotThrow(() => collectCalibrationObservations(syntheticCanonicalEvidence()));
  assert.throws(() => collectCalibrationObservations(syntheticCanonicalEvidence({ seed: "leak", treatmentLeak: true })), /blinding/i);
});

test("fixture helper adapter drives a full synthetic run and counts executor invocations", async () => {
  const { syntheticAdapter, syntheticCanonicalEvidence, withTempArchive } = await import(fixtureHelper.href);
  const adapter = syntheticAdapter();
  assert.equal(typeof adapter.executor, "function");
  assert.equal(adapter.calls, 0);
  // A non-default panel seed, so this comparison distinguishes an adapter that forwards its
  // seed argument from one that silently falls back to the helper's own default seed.
  const seed = protocol.seed_panel.seeds[3];
  assert.notEqual(seed, protocol.seed_panel.seeds[0]);
  assert.deepEqual(await adapter.executor({ seed }), syntheticCanonicalEvidence({ seed }));
  // Construction options must reach every executor call, not just the first, otherwise the
  // documented syntheticAdapter(options?) signature is silently inert.
  const leakAdapter = syntheticAdapter({ treatmentLeak: true });
  const leaked = await leakAdapter.executor({ seed });
  assert.throws(() => collectCalibrationObservations(leaked), /blinding/i);
  const result = await withTempArchive(directory => new PhaseACalibrationRunner({
    directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, executor: adapter.executor
  }).run({ maximumCandidates: 1 }));
  assert.equal(result.evaluated_seeds.length, 24);
  assert.equal(result.stopping_rule_satisfied, true);
  assert.equal(adapter.calls, 25);
});

test("fixture helper attestation keypair is a deterministic ed25519 identity", async () => {
  const { syntheticAttestationKeys } = await import(fixtureHelper.href);
  const keys = syntheticAttestationKeys();
  assert.equal(typeof keys.keyId, "string");
  assert.equal(keys.privateKey.asymmetricKeyType, "ed25519");
  assert.equal(keys.publicKey.asymmetricKeyType, "ed25519");
  const publicDer = key => key.export({ type: "spki", format: "der" }).toString("hex");
  assert.equal(keys.keyId, createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
    "keyId must be the SPKI digest the calibration archive derives, not an arbitrary stable constant");
  assert.equal(publicDer(syntheticAttestationKeys().publicKey), publicDer(keys.publicKey));
  const message = Buffer.from("phase-a-calibration-attestation");
  assert.equal(verify(null, message, keys.publicKey, sign(null, message, keys.privateKey)), true);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { syntheticAttestationKeys } from ${JSON.stringify(fixtureHelper.href)};\n` +
    `const k = syntheticAttestationKeys();\n` +
    `process.stdout.write(k.keyId + " " + k.publicKey.export({ type: "spki", format: "der" }).toString("hex"));`
  ], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, `${keys.keyId} ${publicDer(keys.publicKey)}`,
    "the keypair must be derived from a frozen seed, not generated per process");
});

test("fixture helper temp archive root is isolated, returned, and always removed", async () => {
  const { withTempArchive } = await import(fixtureHelper.href);
  let first = null;
  const returned = await withTempArchive(async directory => {
    first = directory;
    assert.equal(typeof directory, "string");
    assert.equal(existsSync(directory), true);
    await writeFile(join(directory, "state.json"), "{}\n");
    return "archive-sentinel";
  });
  assert.equal(returned, "archive-sentinel");
  assert.equal(existsSync(first), false);
  let second = null;
  await withTempArchive(async directory => { second = directory; });
  assert.notEqual(second, first);
  let failed = null;
  await assert.rejects(() => withTempArchive(async directory => { failed = directory; throw new Error("fixture boom"); }), /fixture boom/);
  assert.equal(existsSync(failed), false);
});

test("calibration tooling suite consumes the shared fixture helper instead of inline definitions", async () => {
  const helperSource = await readFile(fixtureHelper, "utf8");
  assert.doesNotMatch(helperSource, /node:test/, "the helper must not register tests of its own");
  assert.doesNotMatch(helperSource, /Math\.random/);
  assert.doesNotMatch(helperSource, /Date\.now/);
  assert.doesNotMatch(helperSource, /new Date\(/);
  assert.doesNotMatch(helperSource, /process\.env/);
  const suiteSource = await readFile(new URL("./calibration-tooling.test.js", import.meta.url), "utf8");
  assert.match(suiteSource, /from "\.\/helpers\/calibration-fixture\.js"/);
  // Forbid the constructs the helper owns rather than particular identifier names, so a
  // reinserted inline fixture under renamed locals is still caught. Each pattern below
  // carries a character class so the assertion source cannot satisfy its own match.
  assert.doesNotMatch(suiteSource, /from "\.\.\/src\/evidence\.js"/, "evidence bundles must be built by the shared helper");
  assert.doesNotMatch(suiteSource, /new Evidence[S]tore\s*\(/, "evidence bundles must be built by the shared helper");
  assert.doesNotMatch(suiteSource, /\.put[P]ayload\s*\(/, "evidence bundles must be built by the shared helper");
  assert.doesNotMatch(suiteSource, /event[T]ype:/, "canonical events must be appended by the shared helper");
  assert.doesNotMatch(suiteSource, /generateKeyPair[S]ync|create[P]rivateKey|create[P]ublicKey/, "attestation keys must be derived by the shared helper");
  assert.doesNotMatch(suiteSource, /302e020100300506032b65[7]0/, "the ed25519 pkcs8 seed prefix belongs to the shared helper");
  assert.doesNotMatch(suiteSource, /function synthetic[A-Za-z]*\s*\(/, "fixture builders must not be redefined inline");
  assert.doesNotMatch(suiteSource, /const synthetic[A-Za-z]*\s*=/, "fixture builders must not be redefined inline");
});
