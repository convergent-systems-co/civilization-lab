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
  calibrationToolingDistributionDigest,
  CALIBRATION_TOOLING_VERSION,
  CalibrationArchive,
  PhaseACalibrationRunner,
  attestCalibrationAttempt,
  calibrationKeyId,
  startingCalibrationParameterSet
} from "../src/calibration-runner.js";
import { calibrationProtocol } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import { syntheticCanonicalEvidence } from "./helpers/calibration-fixture.js";

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

/** Construct a complete synthetic-only archive for final-release CLI verification. */
function syntheticAttempt(calibrationRunId, { seed, attemptId, privateKey }) {
  const registry = parameterRegistry();
  const parameterSet = startingCalibrationParameterSet();
  const parameterSetHash = sha256(parameterSet);
  const classification = CALIBRATION_FAILURES.PARAMETER_FAILURE;
  const evidence = { classification, error_digest: sha256(attemptId), seed, parameter_set_hash: parameterSetHash };
  const metrics = {};
  const attempt = {
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag_commit: implementation, release_descriptor_hash: null,
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
  const attestor = { privateKey, publicKey, keyId, trustScope: "SYNTHETIC_CONFORMANCE" };
  await new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    executor: async ({ seed, runtimeConfiguration }) => syntheticCanonicalEvidence({ seed, runtimeConfiguration }), attestor }).run({ maximumCandidates: 1 });
  const archive = await CalibrationArchive.open(directory, attestor);
  const manifest = await archive.manifest(archive.state.attempts[0].attempt_id);
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
  const fixture = await fixtureArchive(archive, trusted);
  const { keyId } = fixture;
  const trustedPath = join(directory, "trusted.pem");
  const foreignPath = join(directory, "foreign.pem");
  const trustedHeadPath = join(directory, "trusted-head.json");
  await writeFile(trustedPath, publicKeyPem(trusted.publicKey));
  await writeFile(foreignPath, publicKeyPem(foreign.publicKey));
  await writeFile(trustedHeadPath, canonicalize(fixture.archive.head) + "\n");

  const pass = spawnSync("npm", ["run", "--silent", "calibration:verify", "--", "--archive", archive, "--public-key", trustedPath, "--key-id", keyId, "--trusted-head", trustedHeadPath], { cwd: root, encoding: "utf8" });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).status, "PASS");

  const empiricalWithoutIndependentTrust = spawnSync(process.execPath, [cli, "verify", "--mode", "empirical", "--archive", archive,
    "--public-key", trustedPath, "--key-id", keyId, "--trusted-head", trustedHeadPath], { encoding: "utf8" });
  assert.notEqual(empiricalWithoutIndependentTrust.status, 0);
  assert.match(empiricalWithoutIndependentTrust.stderr, /independent --attestor-public-key/);

  const mismatched = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", foreignPath, "--key-id", calibrationKeyId(foreign.publicKey), "--trusted-head", trustedHeadPath], { encoding: "utf8" });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /trust|attestation|key/i);

  const untrustedId = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", trustedPath, "--key-id", "some-other-key", "--trusted-head", trustedHeadPath], { encoding: "utf8" });
  assert.notEqual(untrustedId.status, 0);
  assert.match(untrustedId.stderr, /trust|attestation|key/i);

  const missingKey = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /--public-key/);

  const missingHead = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", trustedPath, "--key-id", keyId], { encoding: "utf8" });
  assert.notEqual(missingHead.status, 0);
  assert.match(missingHead.stderr, /--trusted-head/);

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
  await reboundArchive.archive._exclusive(async () => {
    await reboundArchive.archive._loadLocked();
    const expectedHead = reboundArchive.archive.head.digest;
    const state = structuredClone(reboundArchive.archive.state);
    for (const entry of state.attempts) if (entry.attempt_id === attemptId) entry.manifest_hash = sha256(foreignSigned);
    await reboundArchive.archive._publish(state, expectedHead);
  });
  const reboundHeadPath = join(directory, "rebound-trusted-head.json");
  await writeFile(reboundHeadPath, canonicalize(reboundArchive.archive.head) + "\n");
  const foreignAttestation = spawnSync(process.execPath, [cli, "verify", "--archive", rebound, "--public-key", trustedPath, "--key-id", keyId, "--trusted-head", reboundHeadPath], { encoding: "utf8" });
  assert.notEqual(foreignAttestation.status, 0);
  assert.match(foreignAttestation.stderr, /untrusted calibration attestation|(?:history removed|signed calibration history deleted or mutated).*retained attempts/);
});

test("the shipped production adapter cannot become an unauthorized implicit execution path", () => {
  const directory = join(tmpdir(), "calibration-cli-adapter-never-created");
  assert.throws(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation }),
    /calibration executor required/);
  assert.throws(() => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation, executor: null }),
    /calibration executor required/);

  // The repository intentionally ships a packageable production adapter. The
  // runner still requires an explicitly loaded, authorization-bound instance;
  // no module may silently construct a calibration runner with that adapter.
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
    assert.doesNotMatch(source, /\bdefaultExecutor\b|\bdefaultAdapter\b/, `${where} defines a default execution adapter`);
  }
  const runnerSource = readFileSync(join(root, "src/calibration-runner.js"), "utf8");
  const classBody = runnerSource.slice(runnerSource.indexOf("class PhaseACalibrationRunner"));
  const signature = classBody.split("\n").find(line => line.includes("constructor("));
  assert.ok(signature, "the calibration runner constructor was not found");
  assert.doesNotMatch(signature, /executor\s*=/, "the execution adapter carries a default value");
  assert.match(signature, /\bexecutor\b/, "the execution adapter is not a constructor parameter");
  assert.match(readFileSync(join(root, "src/calibration-production-entrypoint.js"), "utf8"), /EMPIRICAL_CALIBRATION/);
  assert.match(readFileSync(join(root, "src/calibration-adapter-package.js"), "utf8"), /evidenceAuthorityEndpoint/);
});

test("no embedded authorization bypass or execution trigger exists in the calibration surface", async () => {
  // Scan scope and its limit: the calibration surface is src/calibration-runner.js,
  // src/calibration.js and scripts/calibration-cli.js. Their transitive import closure
  // is deliberately not scanned for environment reads, because it reaches the Pilot 0
  // runtime through evidence replay and src/model-adapter.js. What binds instead
  // is the pair below: initial no-Qwen Phase A permits environment access only
  // to the signed evidence-authority credential through the adapter's closed
  // capability list, and it imports no world or model runtime module directly. The
  // behavioural assertions afterwards are the backstop the regexes cannot be.
  const surface = ["src/calibration-runner.js", "src/calibration.js", "scripts/calibration-cli.js"];
  for (const relativePath of surface) {
    const source = readFileSync(join(root, relativePath), "utf8");
    const environmentReads = [...source.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[([^\]]+)\])/g)];
    if (relativePath === "src/calibration-runner.js") {
      assert.ok(environmentReads.length > 0, "adapter environment mediation disappeared");
      assert.ok(environmentReads.every(match => match[2] === "name"), "calibration runner bypasses the signed environment-name iterator");
      assert.match(source, /["']CIVLAB_CALIBRATION_EVIDENCE_AUTH_TOKEN["']/,
        "missing exact evidence-authority environment permission");
      for (const name of ["HF_TOKEN", "HF_HOME", "HUGGINGFACE_HUB_CACHE", "QWEN_HF_PYTHON", "TRANSFORMERS_CACHE"])
        assert.doesNotMatch(source, new RegExp(`[\"']${name}[\"']`), `no-Qwen Phase A embeds forbidden model environment permission: ${name}`);
    } else assert.equal(environmentReads.length, 0, `${relativePath} reads an environment variable`);
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
  const fixture = await fixtureArchive(archive, keys);
  const { manifest, keyId } = fixture;
  assert.equal(manifest.policy_configuration.kind, "deterministic_synthetic_conformance");
  assert.equal(manifest.model_runtime_configuration.used, false);

  const keyPath = join(directory, "trusted.pem");
  const headPath = join(directory, "trusted-head.json");
  await writeFile(keyPath, publicKeyPem(keys.publicKey));
  await writeFile(headPath, canonicalize(fixture.archive.head) + "\n");
  const before = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", keyPath, "--key-id", keyId, "--trusted-head", headPath], { encoding: "utf8" });
  assert.equal(before.status, 0, before.stderr);

  // Promotion by editing the recorded manifest is refused as tampering.
  const manifestPath = join(archive, "attempts", manifest.attempt_id, "manifest.json");
  const promoted = JSON.parse(await readFile(manifestPath, "utf8"));
  promoted.policy_configuration = { kind: "empirical_execution" };
  promoted.model_runtime_configuration = { used: true, frozen_artifact: baseline.runtime.hugging_face_repository };
  await writeFile(manifestPath, canonicalize(promoted) + "\n");
  const after = spawnSync(process.execPath, [cli, "verify", "--archive", archive, "--public-key", keyPath, "--key-id", keyId, "--trusted-head", headPath], { encoding: "utf8" });
  assert.notEqual(after.status, 0);
  assert.match(after.stderr, /calibration attestation invalid|manifest index mismatch|synthetic manifest policy\/model evidence class mismatch/);

  // Promotion by recording a fresh attempt that declares empirical provenance and is
  // correctly attested with the archive's own key. Every signature and index hash
  // agrees here, so tamper evidence cannot reject it: the refusal has to come from a
  // provenance class that names the software evidence this tooling commit can attest.
  const authentic = join(directory, "authentic-promotion");
  const authenticArchive = await new CalibrationArchive(authentic, { privateKey: keys.privateKey, publicKey: keys.publicKey })
    .initialize({ protocolVersion: protocol.protocol_version, implementationCommit: implementation });
  const authenticManifest = { calibration_run_id: authenticArchive.state.calibration_run_id };
  const authenticHeadPath = join(directory, "authentic-trusted-head.json");

  const record = syntheticAttempt(authenticManifest.calibration_run_id,
    { seed: protocol.seed_panel.seeds[0], attemptId: "calibration-cli-authorization-promoted-attempt", privateKey: keys.privateKey });
  record.attempt.policy_configuration = { kind: "empirical_execution" };
  record.attempt.model_runtime_configuration = { used: true, frozen_artifact: baseline.runtime.hugging_face_repository };
  record.attempt.attestation = attestCalibrationAttempt(record.attempt, { privateKey: keys.privateKey });
  await authenticArchive.recordAttempt(record.attempt, { evidence: record.evidence, metrics: record.metrics });
  await writeFile(authenticHeadPath, canonicalize(authenticArchive.head) + "\n");

  const promotedRun = spawnSync(process.execPath, [cli, "verify", "--archive", authentic, "--public-key", keyPath, "--key-id", keyId, "--trusted-head", authenticHeadPath], { encoding: "utf8" });
  assert.notEqual(promotedRun.status, 0);
  assert.match(
    promotedRun.stderr,
    /synthetic manifest policy\/model evidence class mismatch|^SoftwareEvidenceProvenanceViolation:/m,
  );
  assert.doesNotMatch(promotedRun.stdout, /PASS/);
});

test("the build packages the CLI, sources, schemas and specs and excludes secrets and run artifacts", async () => {
  assert.equal(packageManifest.scripts.build, "node scripts/build.js");
  // The build is exercised against an isolated copy of the repository rather than
  // the shared worktree root, because scripts/build.js removes and rewrites dist/
  // and other tasks build the same tree concurrently.
  const staged = await temporaryDirectory("build");
  for (const entry of ["ui", "schemas", "src", "config", "validation", "scripts/build.js", "scripts/calibration-cli.js", "scripts/calibration-selector.js", "scripts/calibration-adapter-worker.js",
    "PILOT_0_CALIBRATION_PROTOCOL.spec.json", "PARAMETER_REGISTRY.spec.json",
    "PRIMARY_ENDPOINT.spec.json", "ENDPOINT_CODEBOOK.spec.md", "PROJECTION_POLICY.spec.json", "package.json", "package-lock.json"])
    await cp(join(root, entry), join(staged, entry), { recursive: true });
  // Resolve the real tag in the source checkout, then carry its build receipt
  // into the isolated source package (which deliberately has no .git directory).
  const tagResolution = spawnSync("git", ["rev-parse", "--verify", "v0.1.0-pilot0^{commit}"], { cwd: root, encoding: "utf8" });
  assert.equal(tagResolution.status, 0, tagResolution.stderr);
  await writeFile(join(staged, "validation/BASELINE_TAG_RESOLUTION.json"), JSON.stringify({ tag: "v0.1.0-pilot0", commit: tagResolution.stdout.trim() }));
  await writeFile(join(staged, ".env"), "CALIBRATION_ATTESTOR_KEY=must-not-ship\n");
  await writeFile(join(staged, "attestor-private-key.pem"), publicKeyPem(generateKeyPairSync("ed25519").publicKey));
  await mkdir(join(staged, "calibration/runs/run-0001"), { recursive: true });
  await writeFile(join(staged, "calibration/runs/run-0001/CALIBRATION_RESULT.json"), "{}\n");

  const build = spawnSync(process.execPath, [join(staged, "scripts/build.js")], { cwd: staged, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const dist = join(staged, "dist");
  for (const shipped of ["scripts/calibration-cli.js", "scripts/calibration-selector.js", "scripts/calibration-adapter-worker.js", "src/calibration-runner.js", "src/calibration.js",
    "schemas/calibration-execution-manifest.schema.json", "config/calibration-trust-policy.json",
    "PILOT_0_CALIBRATION_PROTOCOL.spec.json", "PARAMETER_REGISTRY.spec.json"])
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
