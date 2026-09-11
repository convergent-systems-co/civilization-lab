import { mkdir, cp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "ui"), resolve(dist, "ui"), { recursive: true });
await cp(resolve(root, "schemas"), resolve(dist, "schemas"), { recursive: true });
await cp(resolve(root, "src"), resolve(dist, "src"), { recursive: true });
await mkdir(resolve(dist, "scripts"), { recursive: true });
await cp(resolve(root, "scripts/calibration-cli.js"), resolve(dist, "scripts/calibration-cli.js"));
await cp(resolve(root, "scripts/calibration-selector.js"), resolve(dist, "scripts/calibration-selector.js"));
await cp(resolve(root, "scripts/calibration-adapter-worker.js"), resolve(dist, "scripts/calibration-adapter-worker.js"));
// Package-root assets the copied modules read at module load. Without them the
// packaged CLI throws before it can dispatch a verb, so they are part of the
// runtime, not documentation: config/ backs src/model-adapter.js and src/world.js,
// the codebook backs src/coding.js, the endpoint contract backs src/analysis.js and
// the pre-calibration baseline backs src/calibration-runner.js. validation/ is
// copied file by file so that no other review or report artifact ships with it.
await cp(resolve(root, "config"), resolve(dist, "config"), { recursive: true });
await mkdir(resolve(dist, "validation"), { recursive: true });
await cp(resolve(root, "validation/PRE_CALIBRATION_BASELINE.json"), resolve(dist, "validation/PRE_CALIBRATION_BASELINE.json"));
for (const name of ["PILOT_0_CALIBRATION_PROTOCOL.spec.json", "PARAMETER_REGISTRY.spec.json",
  "PRIMARY_ENDPOINT.spec.json", "ENDPOINT_CODEBOOK.spec.md", "PROJECTION_POLICY.spec.json", "package.json", "package-lock.json"]) await cp(resolve(root, name), resolve(dist, name));
const tag = "v0.1.0-pilot0";
const receipt = existsSync(resolve(root, ".git")) ? {
  tag, commit: execFileSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], { cwd: root, encoding: "utf8" }).trim()
} : JSON.parse(readFileSync(resolve(root, "validation/BASELINE_TAG_RESOLUTION.json"), "utf8"));
if (receipt.tag !== tag || receipt.commit !== "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59")
  throw new Error("validated baseline tag resolution mismatch");
const { commit } = receipt;
await writeFile(resolve(dist, "validation/BASELINE_TAG_RESOLUTION.json"), JSON.stringify({ tag, commit }) + "\n");
console.log(`built ${dist}`);
