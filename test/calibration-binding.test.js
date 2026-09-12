import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalize, sha256 } from "../src/core.js";
import { calibrationProtocol } from "../src/calibration.js";
import { parameterRegistry } from "../src/parameters.js";
import {
  CALIBRATION_FAILURES,
  CALIBRATION_TOOLING_VERSION,
  CalibrationArchive,
  PhaseACalibrationRunner,
  assertCalibrationReleaseTrust,
  buildCalibrationResult,
  calibrationDeploymentTrustPolicy,
  calibrationKeyId,
  calibrationToolingDistributionDigest,
  resolvedCalibrationBaselineTag
} from "../src/calibration-runner.js";

const root = resolve(import.meta.dirname, "..");
const IMPLEMENTATION_COMMIT = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const IMPLEMENTATION_TAG = "v0.1.0-pilot0";
const PROTOCOL_VERSION = "pilot-0-calibration-1.1.0";
const TOOLING_VERSION = "phase-a-calibration-tooling-1.1.0";
const protocol = calibrationProtocol();
const runnerSource = readFileSync(join(root, "src/calibration-runner.js"), "utf8");
const pem = key => key.export({ type: "spki", format: "pem" });
const signed = (body, pair) => ({ ...body, public_key: pem(pair.publicKey),
  signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString("base64") });
const mustNotExecute = () => { throw new Error("executor must never run once a binding check fails"); };

// The validator reads the baseline record, the protocol specification and the runner's tooling
// constant from disk, so its checks can only be proved by running it over drifted content. This is
// a throwaway copy of the repository that a test may mutate; the worktree itself is never touched.
// Only what the validator loads is copied, so a concurrent task writing elsewhere in the shared
// worktree cannot make the copy fail or change its result.
const FIXTURE_ENTRIES = ["scripts", "src", "schemas", "config", "ui", "validation", "package.json", "package-lock.json"];

function validatorFixture() {
  const repo = join(mkdtempSync(join(tmpdir(), "calibration-binding-validator-")), "repo");
  const entries = [...FIXTURE_ENTRIES, ...readdirSync(root).filter(name => /\.spec\.(json|md)$/.test(name))];
  for (const entry of entries) cpSync(join(root, entry), join(repo, entry), { recursive: true });
  // The copy is not a git checkout. The runner's packaged-resolution receipt keeps baseline tag
  // resolution deterministic there, so the fixture's failure set isolates the mutation under test.
  writeFileSync(join(repo, "validation/BASELINE_TAG_RESOLUTION.json"),
    JSON.stringify({ tag: IMPLEMENTATION_TAG, commit: IMPLEMENTATION_COMMIT }));
  return repo;
}

function runValidator(cwd, options = {}) {
  const result = spawnSync(process.execPath, [join(cwd, "scripts/validate-contracts.js")], { cwd, encoding: "utf8", ...options });
  const stderr = result.stderr ?? "";
  return { status: result.status, stderr, stdout: result.stdout ?? "",
    failures: stderr.split("\n").filter(line => line.startsWith("FAIL ")) };
}

function releaseContext(overrides = {}) {
  const releasePair = generateKeyPairSync("ed25519"), authority = generateKeyPairSync("ed25519");
  const body = { version: "phase-a-calibration-release-1.0.0", tooling_version: CALIBRATION_TOOLING_VERSION,
    tooling_distribution_digest: calibrationToolingDistributionDigest(), baseline_tag: IMPLEMENTATION_TAG,
    baseline_tag_commit: IMPLEMENTATION_COMMIT, protocol_hash: sha256(protocol),
    parameter_registry_hash: sha256(parameterRegistry()), authorization_key_id: calibrationKeyId(authority.publicKey),
    approved_adapter_package_digest: sha256('binding-test-adapter-package'),
    deployment_trust_policy_hash: sha256(calibrationDeploymentTrustPolicy()),
    ...overrides };
  return { descriptor: signed(body, releasePair), trust: pem(releasePair.publicKey) };
}

test("runner binds the frozen implementation commit, baseline tag, and protocol version", () => {
  // Baseline tag -> commit resolution and the release-trust check are the runner's public surface
  // for its pinned BASELINE_TAG / BASELINE_COMMIT; the module does not export the constants.
  assert.equal(resolvedCalibrationBaselineTag(), IMPLEMENTATION_COMMIT);
  assert.equal(protocol.protocol_version, PROTOCOL_VERSION);

  const bound = releaseContext();
  assert.equal(assertCalibrationReleaseTrust(bound.descriptor, bound.trust).baseline_tag_commit, IMPLEMENTATION_COMMIT);
  const wrongTag = releaseContext({ baseline_tag: "v9.9.9-not-the-baseline" });
  assert.throws(() => assertCalibrationReleaseTrust(wrongTag.descriptor, wrongTag.trust), /baseline tag resolution mismatch/);
  const wrongCommit = releaseContext({ baseline_tag_commit: "0".repeat(40) });
  assert.throws(() => assertCalibrationReleaseTrust(wrongCommit.descriptor, wrongCommit.trust), /baseline tag resolution mismatch/);
});

test("commit mismatch and protocol-version mismatch each fail the runner closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calibration-binding-commit-"));
  const runner = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
    implementationCommit: "0".repeat(40), executor: mustNotExecute });
  await assert.rejects(() => runner.run(), /implementation baseline mismatch/);
  // Fails closed: no signed state generation is published for a run bound to the wrong commit.
  assert.deepEqual((await readdir(directory)).filter(name => name === "state.json" || name === "generations"), []);

  const archiveDirectory = await mkdtemp(join(tmpdir(), "calibration-binding-protocol-"));
  await assert.rejects(() => new CalibrationArchive(archiveDirectory).initialize({
    protocolVersion: "pilot-0-calibration-0.9.0", implementationCommit: IMPLEMENTATION_COMMIT
  }), /calibration protocol version mismatch/);
  // Both axes are checked at the archive level as well as through run(). The runner's own commit
  // guard fires first during a run, so without this the archive's commit guard could be removed
  // without any test noticing.
  const archiveCommitDirectory = await mkdtemp(join(tmpdir(), "calibration-binding-archive-commit-"));
  await assert.rejects(() => new CalibrationArchive(archiveCommitDirectory).initialize({
    protocolVersion: PROTOCOL_VERSION, implementationCommit: "0".repeat(40)
  }), /implementation baseline mismatch/);
  assert.deepEqual(await readdir(archiveCommitDirectory), [], "a mismatched archive initialize wrote to its directory");

  assert.throws(() => buildCalibrationResult({ candidates: [], manifests: [], protocolVersion: "pilot-0-calibration-0.9.0",
    implementationCommit: IMPLEMENTATION_COMMIT, incidents: [] }), /result baseline\/protocol mismatch/);
  assert.throws(() => buildCalibrationResult({ candidates: [], manifests: [], protocolVersion: PROTOCOL_VERSION,
    implementationCommit: "0".repeat(40), incidents: [] }), /result baseline\/protocol mismatch/);
});

test("baseline and protocol mismatches carry the failure classification the runner actually raises", async () => {
  // Verified against the runner, not assumed: both mismatches are raised as plain Errors carrying
  // only a message. The runner attaches a CALIBRATION_FAILURES class to a returned search outcome
  // (PROTOCOL_SEARCH_EXHAUSTED -> PROTOCOL_VIOLATION), never to these fail-closed throws. Asserting
  // the observed shape here so that adding a class later is a deliberate, reviewed change.
  const unclassified = (error, message) => {
    // The message is asserted alongside the absent classification so the assertion cannot be
    // satisfied by an unrelated error escaping from somewhere else in the run.
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.equal(error.failure_classification, undefined);
    assert.equal(error.classification, undefined);
    assert.ok(!Object.values(CALIBRATION_FAILURES).includes(error.code));
  };

  const directory = await mkdtemp(join(tmpdir(), "calibration-binding-class-"));
  unclassified(await new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
    implementationCommit: "0".repeat(40), executor: mustNotExecute }).run().then(() => null, error => error),
    /implementation baseline mismatch/);

  const archiveDirectory = await mkdtemp(join(tmpdir(), "calibration-binding-class-protocol-"));
  unclassified(await new CalibrationArchive(archiveDirectory).initialize({
    protocolVersion: "pilot-0-calibration-0.9.0", implementationCommit: IMPLEMENTATION_COMMIT
  }).then(() => null, error => error), /calibration protocol version mismatch/);

  assert.throws(() => buildCalibrationResult({ candidates: [], manifests: [], protocolVersion: "pilot-0-calibration-0.9.0",
    implementationCommit: IMPLEMENTATION_COMMIT, incidents: [] }),
    error => { unclassified(error, /result baseline\/protocol mismatch/); return true; });
});

test("failure taxonomy is exactly the seven frozen classes", () => {
  assert.equal(Object.keys(CALIBRATION_FAILURES).length, 7);
  assert.deepEqual(Object.keys(CALIBRATION_FAILURES).sort(), [
    "ACCEPTED_CONFIGURATION", "BLINDING_BREACH", "IMPLEMENTATION_DEFECT", "INFRASTRUCTURE_FAILURE",
    "PARAMETER_FAILURE", "PROTOCOL_VIOLATION", "RESEARCH_DESIGN_BLOCKER"
  ].sort());
  assert.deepEqual(Object.values(CALIBRATION_FAILURES).sort(), Object.keys(CALIBRATION_FAILURES).sort());
});

test("tooling version is frozen in code and declared identically in the tooling document", () => {
  assert.equal(CALIBRATION_TOOLING_VERSION, TOOLING_VERSION);
  const document = readFileSync(join(root, "docs/PHASE_A_CALIBRATION_TOOLING.md"), "utf8");
  // The document's declared-version line specifically, not a mention anywhere in it: a changelog
  // entry or historical note naming the frozen string must not stand in for the declaration. Scoping
  // to the declaration line also leaves the rest of the prose free to name other versions, which an
  // earlier set-equality check over every phase-a-calibration-tooling-X.Y.Z string in the document
  // forbade while the document itself is owned by a different task.
  const declared = document.match(/^Version: `(.+)`$/m);
  assert.ok(declared, "tooling document has no `Version: `…`` declaration line");
  assert.equal(declared[1], TOOLING_VERSION, "tooling document declares a version other than the frozen one");
});

test("contract validation fails closed when the baseline tag, protocol version, tooling version, or failure taxonomy drifts", () => {
  // Behavioural proof, not a source grep: each frozen value is drifted inside a copy of the
  // repository and the real validator is run over it. Failures are compared against the unmutated
  // copy's own failure set, so only the line the drift causes has to be attributable to the drift.
  const repo = validatorFixture();
  try {
    const baseline = runValidator(repo);
    // A fixture too incomplete to run the validator would report no FAIL lines at all, which must not
    // be mistaken for a check that never fires.
    assert.ok(baseline.status === 0 || baseline.failures.length > 0, baseline.stderr || "the fixture validator did not run");
    const drift = (file, from, to, expected) => {
      const path = join(repo, file);
      const original = readFileSync(path, "utf8");
      assert.equal(original.split(from).length - 1, 1, `fixture ${file} does not contain exactly one ${from}`);
      writeFileSync(path, original.replace(from, to));
      try {
        const mutated = runValidator(repo);
        assert.equal(mutated.status, 1, mutated.stderr || mutated.stdout);
        assert.deepEqual(mutated.failures.filter(line => !baseline.failures.includes(line)), [expected]);
      } finally { writeFileSync(path, original); }
    };
    drift("validation/PRE_CALIBRATION_BASELINE.json", `"tag": "${IMPLEMENTATION_TAG}"`, '"tag": "v9.9.9-not-the-baseline"',
      "FAIL frozen implementation baseline tag drifted");
    drift("PILOT_0_CALIBRATION_PROTOCOL.spec.json", `"protocol_version": "${PROTOCOL_VERSION}"`,
      '"protocol_version": "pilot-0-calibration-0.9.0"', "FAIL bound calibration protocol version drifted");
    drift("src/calibration-runner.js", `CALIBRATION_TOOLING_VERSION = "${TOOLING_VERSION}"`,
      'CALIBRATION_TOOLING_VERSION = "phase-a-calibration-tooling-9.9.9"', "FAIL calibration tooling version is not frozen");
    // Dropping a failure class leaves the taxonomy at six, which the validator must reject on its
    // own: the taxonomy assertion in this file reads the constant in-process and so cannot prove the
    // validator still carries the check.
    drift("src/calibration-runner.js", `  ACCEPTED_CONFIGURATION: "ACCEPTED_CONFIGURATION"\n`, "",
      "FAIL calibration failure taxonomy is incomplete");
    assert.deepEqual(runValidator(repo).failures, baseline.failures, "a drift was left in the fixture");
  } finally { rmSync(dirname(repo), { recursive: true, force: true }); }
});

test("contract validation reports no frozen-binding drift for this repository", () => {
  // Scoped to the four bindings this task added checks for. Whether the validator passes overall is
  // `npm run validate` at bundle verification, and a contract owned by another task failing there
  // must not be reported as a binding failure here.
  const validation = runValidator(root);
  const bindings = validation.failures.filter(line =>
    /baseline tag|calibration protocol version drifted|tooling version is not frozen|failure taxonomy/.test(line));
  assert.deepEqual(bindings, [], validation.stderr);
});

test("a clone that cannot resolve the baseline tag fails validation readably, not with a stack trace", async () => {
  // Baseline resolution shells out to git; shadowing git with a failing stub reproduces a clone
  // fetched without the v0.1.0-pilot0 annotated tag.
  const stubDirectory = await mkdtemp(join(tmpdir(), "calibration-binding-no-tag-"));
  writeFileSync(join(stubDirectory, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const validation = runValidator(root, { env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` } });
  assert.equal(validation.status, 1, validation.stderr || validation.stdout);
  assert.match(validation.stderr, /^FAIL calibration runner baseline tag does not resolve to the frozen implementation commit: /m);
  assert.doesNotMatch(validation.stderr, /AssertionError|^\s+at /m);
});

test("production trust provisioning changes no authoritative research specifications", () => {
  const specs = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.spec\./.test(entry.name) && !entry.parentPath.includes("node_modules") && !entry.parentPath.includes(".git"))
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  assert.ok(specs.includes("PILOT_0_CALIBRATION_PROTOCOL.spec.json") && specs.includes("PARAMETER_REGISTRY.spec.json"));

  // The comparison base is resolved locally rather than assuming a current origin/main. Falling back
  // to main covers a clone with no remote, and reducing the trunk to the fork point means a trunk
  // that has advanced past this branch does not have its own specification edits blamed on us.
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const trunk = ["origin/main", "main"].find(ref => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status === 0);
  assert.ok(trunk, "neither origin/main nor main resolves locally, so the frozen-specification base cannot be established");
  const base = git("merge-base", "HEAD", trunk).stdout.trim();
  assert.match(base, /^[0-9a-f]{40}$/, `cannot resolve a merge base between HEAD and ${trunk}`);

  // The merged Phase A baseline already contains the ratified no-Qwen 1.1.0
  // protocol. Production trust provisioning must not alter any research spec.
  const protocolAtBase = git("show", `${base}:PILOT_0_CALIBRATION_PROTOCOL.spec.json`);
  assert.equal(protocolAtBase.status, 0, `comparison base ${base} (${trunk}) predates the calibration protocol freeze`);
  assert.equal(JSON.parse(protocolAtBase.stdout).protocol_version, PROTOCOL_VERSION);
  assert.equal(JSON.parse(readFileSync(join(root, "PILOT_0_CALIBRATION_PROTOCOL.spec.json"), "utf8")).protocol_version, PROTOCOL_VERSION);

  const diff = git("diff", "--name-only", base, "--", ...specs);
  assert.equal(diff.status, 0, diff.stderr);
  assert.deepEqual(diff.stdout.split("\n").filter(Boolean), [], "this branch modifies an unrelated frozen specification");
});

test("artifact version constants stay as frozen, including the manifest-version anomaly", () => {
  const constant = name => runnerSource.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];
  assert.equal(constant("STATE_VERSION"), "phase-a-calibration-state-2.0.0");
  assert.equal(constant("ATTESTATION_VERSION"), "phase-a-calibration-attestation-1.0.0");
  // Spec assumption 6: the manifest schema version is 2.0.0 while state and attestation are 1.0.0.
  // Confirmed and deliberately left as-is by task T2 (reported as an informational finding for a
  // reviewer to decide); this assertion pins the anomaly so it cannot drift unnoticed either way.
  assert.equal(constant("MANIFEST_VERSION"), "phase-a-calibration-manifest-2.0.0");
});
