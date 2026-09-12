import { CalibrationArchive, PhaseACalibrationRunner } from "../../src/calibration-runner.js";
import { syntheticAttestationKeys } from "./calibration-fixture.js";
import { sha256 } from "../../src/core.js";

const [mode, directory, point, kind] = process.argv.slice(2);
const trust = syntheticAttestationKeys();
if (mode === "publish") {
  const archive = await CalibrationArchive.open(directory, trust);
  archive.trust.fault = async stage => { if (stage === point) process.kill(process.pid, "SIGKILL"); };
  const next = structuredClone(archive.state);
  const path = `evidence/transport-${kind}.json`;
  const key = `transport-${kind}`, request = { synthetic_transport_fixture: true, kind };
  next.execution_intents.push({ key, attempt_id: key, request, request_hash: sha256(request), status: "SUCCEEDED" });
  const executionAttemptId = `transport-execution-${kind}`;
  next.execution_attempts.push({ execution_attempt_id: executionAttemptId, key, logical_attempt_id: key,
    parent_execution_attempt_id: null, request_hash: sha256(request), transitions: [
      { sequence: 0, state: "PENDING", boundary: "FIXTURE_CREATED", recorded_at: null, turn: null },
      { sequence: 1, state: "DISPATCHING", boundary: "FIXTURE_DISPATCH", recorded_at: null, turn: null },
      { sequence: 2, state: "RUNNING", boundary: "FIXTURE_RUNNING", recorded_at: null, turn: null },
      { sequence: 3, state: "SUCCEEDED", boundary: "FIXTURE_ARCHIVED", recorded_at: null, turn: null }
    ], preflight: { status: "SYNTHETIC_CONFORMANCE", authorization_hash: null, release_descriptor_hash: null },
    failure_record_path: null, failure_record_hash: null, execution_record_path: path,
    recovery_eligibility: "NOT_APPLICABLE", next_execution_attempt_id: null });
  next.executions.push({ key, attempt_id: key, execution_attempt_id: executionAttemptId, path });
  // These are publication-transport fixtures, never admissible run evidence.
  await archive._exclusive(() => archive._publish(next, archive.head.digest, [{ path, value: { synthetic_transport_fixture: true, kind } }]));
} else if (mode === "hold") {
  const archive = await CalibrationArchive.open(directory, trust);
  await archive._exclusive(async () => {
    process.send("locked");
    await new Promise(resolve => process.once("message", resolve));
  });
} else if (mode === "update") {
  const archive = await CalibrationArchive.open(directory, trust);
  process.send("loaded");
  await new Promise(resolve => process.once("message", resolve));
  try { await archive.update(s => { s.current_round++; return s; }); process.send("published"); }
  catch (error) { process.send({ rejected: error.message }); }
} else if (mode === "execute") {
  const runner = new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE",
    implementationCommit: "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59", attestor: trust,
    executor: async () => {
      // An unresolved Promise alone does not keep Node alive. Hold an IPC
      // listener so the competing runner tests a live lease owner.
      const release = new Promise(resolve => process.once("message", resolve));
      process.send("executing"); await release;
    } });
  await runner.run({ maximumCandidates: 1 });
}
