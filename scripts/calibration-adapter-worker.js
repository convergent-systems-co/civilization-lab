#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const protocolWrite = process.stdout.write.bind(process.stdout);
const SAFE_ERRORS = Object.freeze({
  CALIBRATION_INFRASTRUCTURE_DEADLINE: "INFRASTRUCTURE_FAILURE",
  CALIBRATION_INFRASTRUCTURE_AUTHORITY: "INFRASTRUCTURE_FAILURE",
  CALIBRATION_AUTHORITY_AUTHORIZATION: "PROTOCOL_VIOLATION",
  CALIBRATION_AUTHORITY_PROTOCOL: "PROTOCOL_VIOLATION",
  CALIBRATION_IMPLEMENTATION_DEFECT: "IMPLEMENTATION_DEFECT",
  CALIBRATION_PROTOCOL_VIOLATION: "PROTOCOL_VIOLATION",
  CALIBRATION_BLINDING_BREACH: "BLINDING_BREACH",
  CALIBRATION_RESEARCH_DESIGN_BLOCKER: "RESEARCH_DESIGN_BLOCKER"
});
const safeError = error => {
  const code = typeof error?.code === "string" && SAFE_ERRORS[error.code] === error?.calibrationClassification
    ? error.code : "CALIBRATION_IMPLEMENTATION_DEFECT";
  return { version: "phase-a-adapter-worker-error-1.0.0", code,
    calibration_classification: SAFE_ERRORS[code], reason: code };
};

async function main() {

// This process is started with Node's permission model and a minimal
// environment. It is the only process that imports an externally supplied
// calibration adapter; the selection/archive process never imports adapter
// code into its own authority domain.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (!request || !["INSPECT", "EXECUTE", "RECOVER"].includes(request.operation) || typeof request.module_path !== "string")
  throw new Error("invalid calibration adapter worker request");

const packageDigest = () => {
  const declaration = request.package_declaration;
  if (!declaration?.files || declaration.entrypoint !== request.module_path.split(/[\\/]/).at(-1))
    throw new Error("invalid signed adapter package declaration");
  const packageRoot = dirname(request.module_path), actual = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("adapter executable symlink forbidden");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile()) throw new Error("adapter package contains non-file executable input");
        actual.push(relative(packageRoot, path));
      }
    }
  };
  walk(packageRoot);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(declaration.files).sort()))
    throw new Error("adapter executable package inventory mismatch");
  for (const [name, expected] of Object.entries(declaration.files)) {
    const path = resolve(packageRoot, name), rel = relative(packageRoot, path);
    if (isAbsolute(name) || rel === ".." || rel.startsWith("../") || name !== rel || !lstatSync(path).isFile())
      throw new Error("invalid adapter executable path");
    const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualHash !== expected) throw new Error("adapter executable digest mismatch");
  }
  return createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
};

const beforePackageDigest = packageDigest();
if (beforePackageDigest !== request.package_hash) throw new Error("signed adapter package digest mismatch");

// Keep the protocol channel private from imported adapter logging. Diagnostics
// are reduced to hashes by the parent; adapter-controlled text is never echoed.
Object.defineProperty(process.stdout, "write", { value: () => true, writable: false, configurable: false });
for (const name of ["log", "info", "debug", "warn", "error"]) Object.defineProperty(console, name,
  { value: () => {}, writable: false, configurable: false });
const loaded = await import(`${pathToFileURL(request.module_path).href}?signed_adapter=${request.package_hash}`);
const adapter = loaded.calibrationAdapter;
if (!adapter || typeof adapter.execute !== "function") throw new Error("adapter module must export calibrationAdapter with execute");
const executeSourceHash = createHash("sha256").update(Function.prototype.toString.call(adapter.execute)).digest("hex");

if (request.operation === "INSPECT") {
  const afterPackageDigest = packageDigest();
  if (afterPackageDigest !== beforePackageDigest) throw new Error("adapter package changed during inspection");
  protocolWrite(JSON.stringify({ contract: adapter.contract, execute_source_hash: executeSourceHash,
    recover_supported: typeof adapter.recover === "function", package_digest: afterPackageDigest }));
} else {
  const method = request.operation === "RECOVER" ? adapter.recover : adapter.execute;
  if (typeof method !== "function") throw new Error("adapter cannot recover a previously dispatched execution intent");
  const result = await method(request.execution_request, { adapterPackageDigest: request.package_hash });
  const afterPackageDigest = packageDigest();
  if (afterPackageDigest !== beforePackageDigest) throw new Error("adapter package changed during execution");
  protocolWrite(JSON.stringify({ result, execute_source_hash: executeSourceHash, package_digest: afterPackageDigest }));
}
}

try { await main(); }
catch (error) { protocolWrite(JSON.stringify({ worker_error: safeError(error) })); }
