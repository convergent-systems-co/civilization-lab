import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalibrationArchive, PhaseACalibrationRunner } from "../src/calibration-runner.js";
import { calibrationProtocol } from "../src/calibration.js";
import { syntheticAttestationKeys } from "./helpers/calibration-fixture.js";

const implementation = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";
const worker = new URL("./helpers/calibration-publication-worker.mjs", import.meta.url);
const trust = syntheticAttestationKeys();
function childMessage(child) {
  return new Promise((resolve, reject) => {
    let diagnostics = "";
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); child.stderr?.off("data", stderr); };
    const message = value => { cleanup(); resolve(value); };
    const exit = (code, signal) => { cleanup(); reject(new Error(`worker exited before IPC: ${code}/${signal} ${diagnostics}`)); };
    const error = cause => { cleanup(); reject(cause); };
    const stderr = chunk => { diagnostics += chunk; };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`worker IPC timeout: ${diagnostics}`)); }, 5000);
    child.once("message", message); child.once("exit", exit); child.once("error", error); child.stderr?.on("data", stderr);
    if (child.exitCode !== null || child.signalCode !== null) exit(child.exitCode, child.signalCode);
  });
}
async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "calibration-publication-"));
  const archive = await new CalibrationArchive(directory, trust).initialize({ protocolVersion: calibrationProtocol().protocol_version, implementationCommit: implementation });
  return { directory, archive };
}
for (const kind of ["evidence", "attempt", "candidate", "result", "configuration"]) {
  for (const point of ["before_journal", "after_journal", "after_artifact", "before_generation", "after_generation", "before_pointer", "after_pointer"]) {
    test(`SIGKILL recovery: ${kind} / ${point}`, async () => {
      const { directory, archive } = await setup(), initial = archive.head;
      const result = spawnSync(process.execPath, [worker.pathname, "publish", directory, point, kind], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.signal, "SIGKILL", result.stderr);
      const recovered = await CalibrationArchive.open(directory, { ...trust, trustedHead: initial });
      const committed = point !== "before_journal";
      assert.equal(recovered.head.generation, initial.generation + (committed ? 1 : 0));
      const again = await CalibrationArchive.open(directory, { ...trust, trustedHead: recovered.head });
      assert.deepEqual(again.head, recovered.head, "recovery must be idempotent");
      assert.equal((await readdir(join(directory, "generations"))).filter(n => n.endsWith(".json")).length, committed ? 2 : 1);
      if (committed) {
        const path = kind === "evidence" ? "evidence/transport.json" : kind === "attempt" ? "attempts/transport/manifest.json" :
          kind === "candidate" ? "candidates/transport.json" : kind === "result" ? "CALIBRATION_RESULT.json" : "PILOT_0_WORLD_CONFIGURATION.json";
        assert.deepEqual(JSON.parse(await readFile(join(directory, path), "utf8")), { synthetic_transport_fixture: true, kind });
      }
    });
  }
}

test("two processes cannot publish concurrently or overwrite a stale generation", { timeout: 15000 }, async () => {
  const { directory } = await setup();
  const a = fork(worker, ["update", directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  await childMessage(a);
  const b = fork(worker, ["update", directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    // Loading separately avoids conflating startup locking with stale CAS.
    await childMessage(b);
    const ar = childMessage(a); a.send("go"); assert.equal(await ar, "published");
    const br = childMessage(b); b.send("go"); assert.match((await br).rejected, /stale/);
    const final = await CalibrationArchive.open(directory, trust); assert.equal(final.state.current_round, 1);
  } finally { await stopWorker(a); await stopWorker(b); }
});

test("a process holding the publication lock rejects a competing writer", { timeout: 15000 }, async () => {
  const { directory, archive } = await setup();
  const child = fork(worker, ["hold", directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try { await childMessage(child); await assert.rejects(archive.update(s => s), /already claimed/); }
  finally { await stopWorker(child); }
  await CalibrationArchive.open(directory, trust);
});

test("runner lease prevents duplicate execution before evidence publication", { timeout: 15000 }, async () => {
  const { directory } = await setup();
  const child = fork(worker, ["execute", directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    assert.equal(await childMessage(child), "executing"); let invoked = false;
    await assert.rejects(new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
      attestor: trust, executor: async () => { invoked = true; } }).run({ maximumCandidates: 1 }), /execution already claimed/);
    assert.equal(invoked, false);
  } finally { await stopWorker(child); }
  // The OS releases the lease after abrupt process death; a subsequent runner
  // must reach its executor rather than inherit a permanent stale lock.
  let resumed = false;
  await assert.rejects(new PhaseACalibrationRunner({ directory, mode: "SYNTHETIC_CONFORMANCE", implementationCommit: implementation,
    attestor: trust, executor: async () => { resumed = true; throw new Error("synthetic restart probe"); } }).run({ maximumCandidates: 1 }), /synthetic restart probe/);
  assert.equal(resumed, true);
});
