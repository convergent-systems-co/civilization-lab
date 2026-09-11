import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { EVENT_TYPES, sha256 } from "../src/core.js";
import { PILOT_0_CONFIG } from "../src/world.js";
import { assertValidSchema, assertSupportedSchema } from "../src/schema.js";
import { validateEndpointContract } from "../src/analysis.js";

const root = resolve(import.meta.dirname, "..");
const schemasDir = resolve(root, "schemas");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const schemaFiles = (await readdir(schemasDir)).filter((f) => f.endsWith(".json"));
const schemas = new Map();
for (const file of schemaFiles) { try { schemas.set(file, await json(resolve(schemasDir, file))); } catch (error) { failures.push(`${file}: invalid JSON: ${error.message}`); } }
for(const [name,schema] of schemas) { try { assertSupportedSchema(schema); } catch(error) { failures.push(`${name}: ${error.message}`); } }
const catalogue = await json(resolve(root, "EVENT_CATALOGUE.spec.json"));
const endpoint = await json(resolve(root, "PRIMARY_ENDPOINT.spec.json"));
const parameters = await json(resolve(root, "PARAMETER_REGISTRY.spec.json"));
const projection = await json(resolve(root, "PROJECTION_POLICY.spec.json"));
const horizon = await json(resolve(root, "HORIZON_POLICY.spec.json"));
const breach = await json(resolve(root, "BREACH_POLICY.spec.json"));
const model = await json(resolve(root, "config/pilot0-model.json"));
assertValidSchema(model, "hf-model-config.schema.json");
check(model.context_budget > model.generation.max_tokens, "model output budget exhausts context");
check(model.runtime !== "mlx-lm" || (model.dtype === "checkpoint" && model.device === "metal"), "MLX loading configuration mismatch");
if (model.artifact_manifest) {
  const lock = model.artifact_manifest;
  check(sha256(lock.runtime_manifest) === model.runtime_hash && lock.runtime_hash === model.runtime_hash, "model runtime fingerprint mismatch");
  check(sha256({ weights: lock.artifacts.weights, configuration: lock.artifacts.configuration }) === model.model_artifact_hash, "model artifact inventory hash mismatch");
  check(sha256(lock.artifacts.tokenizer) === model.tokenizer_hash, "tokenizer inventory hash mismatch");
  check(lock.runtime_manifest.repository === model.repository && lock.runtime_manifest.revision === model.revision, "runtime inspection model/revision mismatch");
  check(lock.runtime_manifest.runner_hash === sha256(await readFile(resolve(root, "src/huggingface-runtime.py"), "utf8")), "HF runner changed since runtime fingerprint inspection");
  check(lock.generation_performed === false, "artifact inspection must not masquerade as inference validation");
}
assertValidSchema(parameters, "parameter-registry.schema.json");

check(catalogue.unknown_event_policy === "fail_closed", "event catalogue must fail closed");
check(catalogue.entries.length === EVENT_TYPES.size, "event catalogue is incomplete");
check(new Set(catalogue.entries.map((entry) => entry.event_type)).size === EVENT_TYPES.size, "event catalogue contains duplicate or missing event types");
for (const entry of catalogue.entries) { check(EVENT_TYPES.has(entry.event_type), `catalogue unknown event type ${entry.event_type}`); check(schemas.has(entry.payload_schema_ref), `${entry.event_type} references missing schema ${entry.payload_schema_ref}`); }
check(endpoint.experimental_unit === "run", "primary endpoint unit is not run");
check(endpoint.components.length === 4, "primary endpoint must contain four ratified components");
validateEndpointContract(endpoint);
check(endpoint.weighting.method === "equal_after_standardization", "primary endpoint weighting is not equal standardized weighting");
check(endpoint.directionality.includes("no normative"), "primary endpoint directionality is normative");
check(parameters.unknown_parameter_policy === "confirmatory_validation_fails_closed", "parameter registry is not fail closed");
for (const parameter of parameters.parameters) { check(["ENGINEERING", "WORLD_CALIBRATION", "TREATMENT", "CONFIRMATORY_ANALYSIS", "SECURITY/PRIVACY", "PRESENTATION"].includes(parameter.classification), `${parameter.parameter_id} is unclassified`); check(parameter.numeric_policy_ref === "registry.numeric_policy", `${parameter.parameter_id} lacks numeric policy provenance`); }
check(projection.fail_closed === true && projection.human_ai_parity === true, "projection policy is not fail closed and parity-bound");
check(horizon.pilot_0_max_turns === 20, "Pilot 0 horizon is not 20 turns");
check(horizon.confirmatory_status === "DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION", "confirmatory horizon status is not deferred by design");
check(horizon.shared_across_conditions === true, "confirmatory horizon is not shared across conditions");
check(PILOT_0_CONFIG.organizations.enabled === false && PILOT_0_CONFIG.supply.enabled === false, "Pilot 0 disabled-feature boundary violated");
check(breach.exploratory_only === true && breach.experimental_validity.confirmatory_eligible === false, "breach policy incorrectly permits confirmation");
for (const key of ["map", "economy", "population", "combat", "memory", "phases"]) check(PILOT_0_CONFIG[key] && Object.values(PILOT_0_CONFIG[key]).every((v) => v !== null && v !== undefined), `Pilot 0 config has missing ${key} defaults`);

if (failures.length) { console.error(failures.map((x) => `FAIL ${x}`).join("\n")); process.exitCode = 1; } else console.log(`validated ${schemas.size} schemas, ${catalogue.entries.length} catalogue entries, Pilot 0 contract`);
