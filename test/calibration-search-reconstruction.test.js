import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sign } from "node:crypto";
import { canonicalize, sha256 } from "../src/core.js";
import { CalibrationArchive, PhaseACalibrationRunner, attestCalibrationAttempt, reconstructCalibrationSearch } from "../src/calibration-runner.js";
import { syntheticAttestationKeys, syntheticCanonicalEvidence } from "./helpers/calibration-fixture.js";

const trust = syntheticAttestationKeys(), keys = { [trust.keyId]: trust.publicKey };
const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const execute = ({ seed, runtimeConfiguration }) => syntheticCanonicalEvidence({ seed, runtimeConfiguration });
const runner = (directory, extra = {}) => new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
  implementationCommit: implementation, attestor: trust, executor: execute, ...extra });
let baselineDirectory, baselineArchive, baselineResult;
before(async () => {
  baselineDirectory = await mkdtemp(join(tmpdir(), "calibration-search-oracle-"));
  baselineResult = await runner(baselineDirectory).run({ maximumCandidates: 2 });
  baselineArchive = await CalibrationArchive.open(baselineDirectory, trust);
  assert.equal(baselineArchive.state.candidates.length, 2);
});
async function copyArchive() {
  const directory = await mkdtemp(join(tmpdir(), "calibration-forged-search-"));
  await cp(baselineDirectory, directory, { recursive: true });
  return CalibrationArchive.open(directory, trust);
}
async function candidates(archive) { return Promise.all(archive.state.candidates.map(c => archive.candidate(c.parameter_set_hash))); }
function signArtifact(value) {
  const unsigned = structuredClone(value); delete unsigned.artifact_attestation;
  const body = { ...value.artifact_attestation.body, subject_hash: sha256(unsigned) };
  value.artifact_attestation = { key_id: trust.keyId, body, signature: sign(null, Buffer.from(canonicalize(body)), trust.privateKey).toString("base64") };
}

test("clean-room verification reconstructs every candidate and selected result from archived evidence", async () => {
  const clean = await copyArchive();
  assert.equal(await clean.verify({ trustedKeys: keys }), true);
  const search = reconstructCalibrationSearch(await candidates(clean), { maximumCandidates: 2 });
  assert.equal(search.complete, true);
  assert.deepEqual(search.search_cursor, clean.state.search_cursor);
  assert.equal(search.round_improved, clean.state.round_improved);
  assert.equal(search.incumbent_parameter_set_hash, clean.state.incumbent_parameter_set_hash);
});

for (const [name, mutate, rejection] of [
  ["skipped candidate index", c => { c.candidate_index++; }, /skipped\/substituted/],
  ["wrong search round", c => { c.round++; }, /skipped\/substituted/],
  ["forged maximin score", c => { c.assessment.selection_score.minimum_normalized_boundary_distance += 1; }, /assessment\/score/],
  ["forged seed robustness", c => { c.assessment.selection_score.worst_seed_metric_pass_fraction = 0; }, /assessment\/score/],
  ["forged acceptance", c => { c.assessment.accepted = !c.assessment.accepted; }, /assessment\/score/]
]) test(`valid signatures cannot authorize ${name}`, async () => {
  const archive = await copyArchive(), index = archive.state.candidates.at(-1), candidate = await archive.candidate(index.parameter_set_hash);
  mutate(candidate); candidate.attestation = attestCalibrationAttempt(candidate, trust);
  await writeFile(join(archive.directory, index.path), canonicalize(candidate) + "\n");
  await archive.update(state => {
    state.candidates.find(c => c.parameter_set_hash === candidate.parameter_set_hash).candidate_hash = sha256(candidate);
    state.assessments = state.assessments.map(a => a.parameter_set_hash === candidate.parameter_set_hash
      ? { ...candidate.assessment, candidate_attestation_hash: sha256(candidate) } : a);
    return state;
  });
  await assert.rejects(archive.verify({ trustedKeys: keys }), rejection);
});

for (const [name, mutate] of [
  ["stopping proof", r => { r.stopping_rule_proof.all_ranges_pass = false; }],
  ["removed search history", r => { r.search_history.pop(); }],
  ["removed attempts", r => { r.all_attempt_manifest_hashes.pop(); }],
  ["fabricated acceptance metrics", r => { r.acceptance_metrics["contact.median_first_contact_turn"] += 1; }]
]) test(`signed result rejects ${name} through complete regeneration`, async () => {
  const archive = await copyArchive(), path = join(archive.directory, archive.state.result_ref), result = JSON.parse(await readFile(path, "utf8"));
  mutate(result); signArtifact(result); await writeFile(path, canonicalize(result) + "\n");
  await assert.rejects(archive.verify({ trustedKeys: keys }), /complete calibration result does not regenerate/);
});

test("signed result cannot substitute another accepted candidate for the maximin winner", async () => {
  const archive = await copyArchive(), all = await candidates(archive);
  const alternative = all.find(c => c.parameter_set_hash !== baselineResult.selected_parameter_set_hash);
  assert.equal(alternative.assessment.accepted, true);
  const path = join(archive.directory, archive.state.result_ref), result = JSON.parse(await readFile(path, "utf8"));
  result.selected_parameter_set_hash = alternative.parameter_set_hash;
  result.selected_parameter_vector = alternative.parameter_set;
  result.acceptance_metrics = alternative.aggregate_metrics;
  signArtifact(result); await writeFile(path, canonicalize(result) + "\n");
  await assert.rejects(archive.verify({ trustedKeys: keys }), /complete calibration result does not regenerate/);
});

test("partial-round resume restores incumbent, admission flag and cursor without repeating seeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calibration-partial-round-"));
  let calls = 0;
  await assert.rejects(runner(directory, {
    executor: args => { calls++; return execute(args); },
    fault: point => { if (point === "after_search_progress") throw new Error("synthetic partial-round crash"); }
  }).run({ maximumCandidates: 2 }), /synthetic partial-round crash/);
  const partial = await CalibrationArchive.open(directory, trust);
  assert.equal(calls, 24);
  const restored = reconstructCalibrationSearch(await candidates(partial), { maximumCandidates: 2 });
  assert.equal(restored.round_improved, true);
  assert.deepEqual(restored.search_cursor, { round: 0, operation_index: 1, candidate_index: 1 });
  assert.equal(restored.incumbent_parameter_set_hash, partial.state.incumbent_parameter_set_hash);
  const result = await runner(directory, { executor: args => { calls++; return execute(args); } }).run({ maximumCandidates: 2 });
  assert.equal(calls, 48, "completed seed work must not repeat");
  const resumed = await CalibrationArchive.open(directory, trust);
  assert.deepEqual(resumed.state.search_cursor, baselineArchive.state.search_cursor);
  assert.equal(resumed.state.round_improved, baselineArchive.state.round_improved);
  assert.equal(resumed.state.incumbent_parameter_set_hash, baselineArchive.state.incumbent_parameter_set_hash);
  assert.equal(result.selected_parameter_set_hash, baselineResult.selected_parameter_set_hash);
  assert.deepEqual(result.acceptance_metrics, baselineResult.acceptance_metrics);
  assert.equal(await resumed.verify({ trustedKeys: keys }), true);
});
