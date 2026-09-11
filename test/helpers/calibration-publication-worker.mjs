import { CalibrationArchive, PhaseACalibrationRunner } from "../../src/calibration-runner.js";
import { syntheticAttestationKeys } from "./calibration-fixture.js";

const [mode, directory, point, kind] = process.argv.slice(2);
const trust = syntheticAttestationKeys();
if (mode === "publish") {
  const archive = await CalibrationArchive.open(directory, trust);
  archive.trust.fault = async stage => { if (stage === point) process.kill(process.pid, "SIGKILL"); };
  const next = structuredClone(archive.state);
  let path;
  if (kind === "evidence") { path = "evidence/transport.json"; next.executions.push({ key: "transport", path }); }
  if (kind === "attempt") { path = "attempts/transport/manifest.json"; next.attempts.push({ attempt_id: "transport" }); }
  if (kind === "candidate") { path = "candidates/transport.json"; next.candidates.push({ path }); }
  if (kind === "result") path = "CALIBRATION_RESULT.json";
  if (kind === "configuration") path = "PILOT_0_WORLD_CONFIGURATION.json";
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
    executor: async () => { process.send("executing"); await new Promise(() => {}); } });
  await runner.run({ maximumCandidates: 1 });
}
