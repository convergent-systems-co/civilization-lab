import { readFileSync } from "node:fs";
import { deriveEndpoint, deriveArchivedEndpoint } from "../src/analysis.js";

// Trusted local research tool. No participant endpoint, current world or model
// runtime is consulted. Input contains the archive and versioned analysis plan.
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const signed = Object.hasOwn(request, "exported") || Object.hasOwn(request, "trust");
  if (signed && !(request.exported && request.trust)) throw new Error("signed regeneration requires exported archive and explicit trust binding");
  const result = signed
    ? deriveArchivedEndpoint(request.exported, request.trust, request.options)
    : deriveEndpoint(request.bundle, request.options);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write("Endpoint regeneration rejected: " + error.message + "\n");
  process.exitCode = 1;
}
