import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalize, sha256 } from "../src/core.js";
import {
  CALIBRATION_FAILURES,
  CALIBRATION_TOOLING_VERSION,
  CalibrationArchive,
  PhaseACalibrationRunner,
  attestCalibrationAttempt,
  calibrationKeyId,
  startingCalibrationParameterSet
} from "../src/calibration-runner.js";
import { calibrationProtocol } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const cli = join(root, "scripts/calibration-cli.js");
const protocol = calibrationProtocol();
const baseline = JSON.parse(readFileSync(join(root, "validation/PRE_CALIBRATION_BASELINE.json"), "utf8"));
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const implementationTag = "v0.1.0-pilot0";

async function temporaryDirectory(prefix) {
  return await mkdtemp(join(tmpdir(), `calibration-cli-${prefix}-`));
}

/**
 * The smallest attempt the CLI's `verify` verb can bind external trust to: an
 * attested infrastructure failure. The classification keeps the record out of
 * metric regeneration, so this constructs no synthetic world evidence and stays
 * independent of the shared fixture helper.
 */
function syntheticAttempt(calibrationRunId, { seed, attemptId, privateKey }) {
  const registry = parameterRegistry();
  const parameterSet = startingCalibrationParameterSet();
  const parameterSetHash = sha256(parameterSet);
  const classification = CALIBRATION_FAILURES.INFRASTRUCTURE_FAILURE;
  const evidence = { classification, error_digest: sha256(attemptId), seed, parameter_set_hash: parameterSetHash };
  const metrics = {};
  const attempt = {
    schema_version: "phase-a-calibration-manifest-2.0.0", tooling_version: CALIBRATION_TOOLING_VERSION,
    calibration_run_id: calibrationRunId, attempt_id: attemptId,
    implementation_commit: implementation, implementation_tag: implementationTag, protocol_version: protocol.protocol_version,
    specification_versions: baseline.specification_sha256, parameter_registry_version: registry.registry_version,
    parameter_set: parameterSet, parameter_set_hash: parameterSetHash,
    parameter_classifications: Object.fromEntries(registry.parameters.map(entry => [entry.parameter_id, entry.classification])),
    seed, seeds: [seed], rng_provenance_ref: `addressed-rng://${seed}`,
    policy_configuration: { kind: "deterministic_synthetic_conformance" }, model_runtime_configuration: { used: false },
    runtime_environment: { kind: "fixture" }, canonical_evidence_ref: `unavailable://${classification}`,
    metrics, treatment_blinding: protocol.blinding.selection_view, failure_classification: classification, status: classification,
    stopping_rule_hash: sha256(protocol.stopping_rule), evidence_hashes: [sha256(evidence)],
    metric_artifact_hash: sha256(canonicalize(metrics) + "\n"), reason: `execution failed: ${classification}`,
    created_at: new Date(0).toISOString()
  };
  attempt.attestation = attestCalibrationAttempt(attempt, { privateKey });
  return { attempt, evidence, metrics };
}

async function fixtureArchive(directory, { privateKey, publicKey }) {
  const keyId = calibrationKeyId(publicKey);
  const archive = await new CalibrationArchive(directory, { privateKey, publicKey })
    .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  const { attempt, evidence, metrics } = syntheticAttempt(archive.state.calibration_run_id,
    { seed: protocol.seed_panel.seeds[0], attemptId: "calibration-cli-authorization-fixture-attempt", privateKey });
  const manifest = await archive.recordAttempt(attempt, { evidence, metrics });
  return { archive, manifest, keyId };
}

function publicKeyPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" });
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

test("the run verb fails closed with no empirical execution path and no side effects", async () => {
  const cwd = await temporaryDirectory("run");
  const run = spawnSync(process.execPath, [cli, "run"], { cwd, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /empirical calibration is not authorized/);
  assert.match(run.stderr, /authoriz/i);
  assert.equal(run.stdout.trim(), "");
  // Nothing was executed: the failing verb wrote no archive, evidence, result or
  // world configuration into its working directory.
  assert.deepEqual(readdirSync(cwd), []);
});

test("the plan verb prints the frozen search and authorization state and starts no execution", async () => {
  assert.equal(packageManifest.scripts["calibration:plan"], "node scripts/calibration-cli.js plan");
  const cwd = await temporaryDirectory("plan");
  const plan = spawnSync("npm", ["run", "--silent", "calibration:plan"], { cwd: root, encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  const printed = JSON.parse(plan.stdout);
  assert.equal(printed.maximum_parameter_sets, 512);
  assert.equal(printed.maximum_rounds, 12);
  assert.equal(printed.frozen_seed_count, 24);
  assert.equal(printed.pilot_0_max_turns, 20);
  assert.equal(printed.protocol_version, protocol.protocol_version);
  // `empirical_calibration_authorized` is the frozen spelling of the criterion's
  // `empirical_calibration: false` field, and it is the only key in the plan output
  // that speaks to empirical authorization at all.
  assert.equal(printed.empirical_calibration_authorized, false);
  assert.deepEqual(Object.entries(printed).filter(([key]) => /empirical/i.test(key)),
    [["empirical_calibration_authorized", false]]);
  // The same verb run in an empty working directory leaves it empty: planning
  // starts no world run, no model generation and no archive.
  const isolated = spawnSync(process.execPath, [cli, "plan"], { cwd, encoding: "utf8" });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(JSON.parse(isolated.stdout), printed);
  assert.deepEqual(readdirSync(cwd), []);
});

test("the verify verb binds an archive to externally supplied trust", async () => {
  assert.equal(packageManifest.scripts["calibration:verify"], "node scripts/calibration-cli.js verify");
  const directory = await temporaryDirectory("verify");
  const trusted = generateKeyPairSync("ed25519");
  const foreign = generateKeyPairSync("ed25519");
  const archive = join(directory, "archive");
  const { keyId } = await fixtureArchive(archive, trusted);
  const trustedPath = join(directory, "trusted.pem");
  const foreignPath = join(directory, "foreign.pem");
  await writeFile(trustedPath, publicKeyPem(trusted.publicKey));
  await writeFile(foreignPath, publicKeyPem(foreign.publicKey));

  const pass = spawnSync("npm", ["run", "--silent", "calibration:verify", "--", "--archive", archive, "--public-key", trustedPath, "--key-id", keyId], { cwd: root, encoding: "utf8" });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).status, "PASS");

  const mismatched = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", foreignPath, "--key-id", calibrationKeyId(foreign.publicKey)], { encoding: "utf8" });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /trust|attestation|key/i);

  const untrustedId = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", trustedPath, "--key-id", "some-other-key"], { encoding: "utf8" });
  assert.notEqual(untrustedId.status, 0);
  assert.match(untrustedId.stderr, /trust|attestation|key/i);

  const missingKey = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /--public-key/);

  // A flag whose value is missing is rejected rather than bound to the next flag name,
  // so no archive path is ever silently read from an adjacent option.
  const dangling = spawnSync(process.execPath, [cli, "verify", "--archive", "--public-key", trustedPath, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(dangling.status, 0);
  assert.match(dangling.stderr, /--archive requires a value/);

  // An archive whose state envelopes open under the supplied key but whose attempt
  // attestation was signed by a foreign key, with the manifest index re-published so
  // that every hash still agrees. Opening the archive and parsing its options cannot
  // catch this: only running the attestation check against the caller's trusted keys
  // does, so this case fails if the verb stops binding external trust to attestations.
  const rebound = join(directory, "rebound-attestation");
  const reboundArchive = await fixtureArchive(rebound, trusted);
  const attemptId = reboundArchive.manifest.attempt_id;
  const foreignSigned = { ...reboundArchive.manifest, attestation: attestCalibrationAttempt(reboundArchive.manifest, { privateKey: foreign.privateKey }) };
  await writeFile(join(rebound, "attempts", attemptId, "manifest.json"), canonicalize(foreignSigned) + "\n");
  await reboundArchive.archive.update(state => {
    for (const entry of state.attempts) if (entry.attempt_id === attemptId) entry.manifest_hash = sha256(foreignSigned);
    return state;
  });
  const foreignAttestation = spawnSync(process.execPath, [cli, "verify", "--archive", rebound, "--public-key", trustedPath, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(foreignAttestation.status, 0);
  assert.match(foreignAttestation.stderr, /untrusted calibration attestation/);
});

test("the execution adapter is injected by the caller and the repository ships no default adapter", () => {
  const directory = join(tmpdir(), "calibration-cli-adapter-never-created");
  assert.throws(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation }),
    /calibration executor required/);
  assert.throws(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, executor: null }),
    /calibration executor required/);

  // Scan scope: every .js file under src/ and scripts/ (recursive). A default
  // adapter would show up either as a constructed runner outside the tests or as
  // an exported calibration executor/adapter symbol; the injected parameter must
  // also carry no default value.
  const scanned = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "scripts"))];
  assert.ok(scanned.length > 20);
  for (const file of scanned) {
    const source = readFileSync(file, "utf8");
    const where = relative(root, file);
    if (where !== "scripts/calibration-cli.js") assert.doesNotMatch(source, /new\s+PhaseACalibrationRunner/, `${where} instantiates a calibration runner`);
    else {
      assert.match(source, /--authorization-public-key/);
      assert.match(source, /--adapter-module/);
      assert.ok(source.indexOf("if (!authorizationPath") < source.indexOf("new PhaseACalibrationRunner"), "CLI constructs a runner before capability preflight");
    }
    assert.doesNotMatch(source, /export[^\n]*\b\w*Calibration(Executor|Adapter)\w*\b/, `${where} exports a default calibration adapter`);
    assert.doesNotMatch(source, /\bdefaultExecutor\b|\bdefaultAdapter\b/, `${where} defines a default execution adapter`);
  }
  const runnerSource = readFileSync(join(root, "src/calibration-runner.js"), "utf8");
  const classBody = runnerSource.slice(runnerSource.indexOf("class PhaseACalibrationRunner"));
  const signature = classBody.split("\n").find(line => line.includes("constructor("));
  assert.ok(signature, "the calibration runner constructor was not found");
  assert.doesNotMatch(signature, /executor\s*=/, "the execution adapter carries a default value");
  assert.match(signature, /\bexecutor\b/, "the execution adapter is not a constructor parameter");
});

test("no embedded authorization bypass or execution trigger exists in the calibration surface", async () => {
  // Scan scope and its limit: the calibration surface is src/calibration-runner.js,
  // src/calibration.js and scripts/calibration-cli.js. Their transitive import closure
  // is deliberately not scanned for environment reads, because it reaches the Pilot 0
  // runtime through evidence replay and src/model-adapter.js legitimately reads
  // QWEN_* variables for model configuration. What binds instead is the pair below:
  // the surface names no environment variable, flag or constant of its own, and it
  // imports no world or model runtime module directly — so a differently named
  // bypass would still have to appear as one of these direct imports. The behavioural
  // assertions afterwards are the backstop the regexes cannot be.
  const surface = ["src/calibration-runner.js", "src/calibration.js", "scripts/calibration-cli.js"];
  for (const relativePath of surface) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /process\.env/, `${relativePath} reads an environment variable`);
    assert.doesNotMatch(source, /empirical\w*\s*[:=]\s*true/i, `${relativePath} flips empirical calibration on`);
    assert.doesNotMatch(source, /confirmatory\w*\s*[:=]\s*true/i, `${relativePath} flips confirmatory execution on`);
    assert.doesNotMatch(source, /makeWorld\s*\(|new\s+AgentRuntime|Qwen35BaseAdapter|runService\s*\(|createServer\s*\(/,
      `${relativePath} starts a world run, model generation or a session`);
    const imported = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(match => match[1].replace(/^.*\//, ""));
    for (const runtimeModule of ["model-adapter.js", "world.js", "agent.js", "server.js"])
      assert.ok(!imported.includes(runtimeModule), `${relativePath} imports the ${runtimeModule} runtime directly`);
  }
  let started = false;
  const executor = async () => { started = true; throw new Error("executor must not run"); };
  for (const mode of ["EMPIRICAL", "CONFIRMATORY", "EMPIRICAL_CONFIRMATORY", "HUMAN_SESSION"]) {
    const runner = new PhaseACalibrationRunner({ directory: await temporaryDirectory("bypass"), mode, implementationCommit: implementation, executor });
    await assert.rejects(() => runner.run(), /calibration mode|not authorized/i, `mode ${mode} is not refused`);
  }
  // An empirical mode, if the runner declares one, runs only against a separately
  // signed external authorization: no flag, constant or default stands in for it.
  const unauthorized = new PhaseACalibrationRunner({ directory: await temporaryDirectory("bypass"), mode: "EMPIRICAL_CALIBRATION", implementationCommit: implementation, executor });
  await assert.rejects(() => unauthorized.run(), /calibration mode|authoriz/i);
  assert.equal(started, false);
});

test("the deterministic synthetic fixture is software evidence and cannot be promoted to an empirical archive", async () => {
  const directory = await temporaryDirectory("promotion");
  const keys = generateKeyPairSync("ed25519");
  const archive = join(directory, "archive");
  const { manifest, keyId } = await fixtureArchive(archive, keys);
  assert.equal(manifest.policy_configuration.kind, "deterministic_synthetic_conformance");
  assert.equal(manifest.model_runtime_configuration.used, false);

  const keyPath = join(directory, "trusted.pem");
  await writeFile(keyPath, publicKeyPem(keys.publicKey));
  const before = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", keyPath, "--key-id", keyId], { encoding: "utf8" });
  assert.equal(before.status, 0, before.stderr);

  // Promotion by editing the recorded manifest is refused as tampering.
  const manifestPath = join(archive, "attempts", manifest.attempt_id, "manifest.json");
  const promoted = JSON.parse(await readFile(manifestPath, "utf8"));
  promoted.policy_configuration = { kind: "empirical_execution" };
  promoted.model_runtime_configuration = { used: true, frozen_artifact: baseline.runtime.hugging_face_repository };
  await writeFile(manifestPath, canonicalize(promoted) + "\n");
  const after = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", keyPath, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(after.status, 0);
  assert.match(after.stderr, /calibration attestation invalid|manifest index mismatch/);

  // Promotion by recording a fresh attempt that declares empirical provenance and is
  // correctly attested with the archive's own key. Every signature and index hash
  // agrees here, so tamper evidence cannot reject it: the refusal has to come from a
  // provenance class that names the software evidence this tooling commit can attest.
  const authentic = join(directory, "authentic-promotion");
  const { archive: authenticArchive, manifest: authenticManifest } = await fixtureArchive(authentic, keys);
  const clean = spawnSync(process.execPath, [cli, "verify", "--archive", authentic, "--public-key", keyPath, "--key-id", keyId], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);

  const record = syntheticAttempt(authenticManifest.calibration_run_id,
    { seed: protocol.seed_panel.seeds[1], attemptId: "calibration-cli-authorization-promoted-attempt", privateKey: keys.privateKey });
  record.attempt.policy_configuration = { kind: "empirical_execution" };
  record.attempt.model_runtime_configuration = { used: true, frozen_artifact: baseline.runtime.hugging_face_repository };
  record.attempt.attestation = attestCalibrationAttempt(record.attempt, { privateKey: keys.privateKey });
  await authenticArchive.recordAttempt(record.attempt, { evidence: record.evidence, metrics: record.metrics });

  const promotedRun = spawnSync(process.execPath, [cli, "verify", "--archive", authentic, "--public-key", keyPath, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(promotedRun.status, 0);
  assert.match(promotedRun.stderr, /^SoftwareEvidenceProvenanceViolation:/m);
  assert.match(promotedRun.stderr, /software evidence only/);
  assert.match(promotedRun.stderr, /deterministic_synthetic_conformance/);
  assert.doesNotMatch(promotedRun.stdout, /PASS/);
});

test("the build packages the CLI, sources, schemas and specs and excludes secrets and run artifacts", async () => {
  assert.equal(packageManifest.scripts.build, "node scripts/build.js");
  // The build is exercised against an isolated copy of the repository rather than
  // the shared worktree root, because scripts/build.js removes and rewrites dist/
  // and other tasks build the same tree concurrently.
  const staged = await temporaryDirectory("build");
  for (const entry of ["ui", "schemas", "src", "config", "validation", "scripts/build.js", "scripts/calibration-cli.js", "scripts/calibration-selector.js",
    "PILOT_0_CALIBRATION_PROTOCOL.spec.json", "PARAMETER_REGISTRY.spec.json",
    "PRIMARY_ENDPOINT.spec.json", "ENDPOINT_CODEBOOK.spec.md"])
    await cp(join(root, entry), join(staged, entry), { recursive: true });
  await writeFile(join(staged, ".env"), "CALIBRATION_ATTESTOR_KEY=must-not-ship\n");
  await writeFile(join(staged, "attestor-private-key.pem"), publicKeyPem(generateKeyPairSync("ed25519").publicKey));
  await mkdir(join(staged, "calibration/runs/run-0001"), { recursive: true });
  await writeFile(join(staged, "calibration/runs/run-0001/CALIBRATION_RESULT.json"), "{}\n");

  const build = spawnSync(process.execPath, [join(staged, "scripts/build.js")], { cwd: staged, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const dist = join(staged, "dist");
  for (const shipped of ["scripts/calibration-cli.js", "scripts/calibration-selector.js", "src/calibration-runner.js", "src/calibration.js",
    "schemas/calibration-execution-manifest.schema.json", "PILOT_0_CALIBRATION_PROTOCOL.spec.json", "PARAMETER_REGISTRY.spec.json"])
    assert.ok(statSync(join(dist, shipped)).isFile(), `dist is missing ${shipped}`);

  // Presence of the entry point is not evidence that it runs: the packaged modules
  // read package-root assets at module load, so the distributable is only a runtime
  // if the packaged CLI itself dispatches a verb. Run it from the packaged tree.
  const packagedPlan = spawnSync(process.execPath, [join(dist, "scripts/calibration-cli.js"), "plan"], { cwd: dist, encoding: "utf8" });
  assert.equal(packagedPlan.status, 0, packagedPlan.stderr);
  const packagedOutput = JSON.parse(packagedPlan.stdout);
  assert.equal(packagedOutput.empirical_calibration_authorized, false);
  assert.equal(packagedOutput.protocol_hash, sha256(protocol));
  const packagedRun = spawnSync(process.execPath, [join(dist, "scripts/calibration-cli.js"), "run"], { cwd: dist, encoding: "utf8" });
  assert.notEqual(packagedRun.status, 0);
  assert.match(packagedRun.stderr, /empirical calibration is not authorized/);

  const packaged = filesUnder(dist).map(path => relative(dist, path));
  assert.ok(packaged.length > 0);
  for (const path of packaged) {
    assert.doesNotMatch(path, /(^|\/)\.env$/, `dist ships ${path}`);
    assert.doesNotMatch(path, /\.pem$|private[-_]?key/i, `dist ships ${path}`);
    // Unanchored: build.js copies whole trees, so a run directory nested inside one
    // of them must be caught wherever it appears under dist, not only at its root.
    assert.doesNotMatch(path, /(^|\/)calibration\/runs\//, `dist ships ${path}`);
    assert.doesNotMatch(path, /CALIBRATION_RESULT\.json|PILOT_0_WORLD_CONFIGURATION\.json/, `dist ships ${path}`);
  }
});
