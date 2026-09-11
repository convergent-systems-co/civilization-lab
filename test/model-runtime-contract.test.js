import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Qwen35BaseAdapter, loadPilotModelConfiguration, PROVISIONAL_MODEL_PARAMETERS } from "../src/model-adapter.js";
import { AgentRuntime, PILOT_0_AGENT_CONDITIONS, assertAgentCondition } from "../src/agent.js";
import { assertValidSchema } from "../src/schema.js";
import { makeWorld } from "../src/world.js";
import { parameterRegistry } from "../src/parameters.js";
import { sha256 } from "../src/core.js";

const config = loadPilotModelConfiguration();

test("HF contract: production files have no forbidden runtime dependencies or endpoints", () => {
  const root = resolve(import.meta.dirname, "..");
  const files = ["package.json", ...["src", "scripts", "config"].flatMap(dir => readdirSync(resolve(root, dir)).filter(f => /\.(js|py|json)$/.test(f)).map(f => `${dir}/${f}`))];
  for (const file of files) {
    const contents = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(contents, /ollama|11434|\/api\/generate|\/api\/chat|qwen[\d.]*:/i, file);
  }
});

test("HF contract: configured repository and immutable commit are explicit and schema-validated", () => {
  assert.equal(assertValidSchema(config, "hf-model-config.schema.json"), true);
  assert.match(config.repository, /^Qwen\/Qwen3\.5-.*-Base$/);
  assert.match(config.revision, /^[a-f0-9]{40}$/);
  assert.equal(config.source, "huggingface");
  assert.equal(config.quantization, "none");
  assert.equal(config.confirmatory_frozen, false);
});

for (const [field, value] of [
  ["source", "other-provider"], ["revision", "main"], ["revision", "shortsha"],
  ["repository", "Qwen/Qwen3.5-9B-Instruct"], ["repository", "Qwen/Qwen3-8B-Base"],
  ["quantization", "int4"], ["model_artifact_hash", "not-a-hash"]
]) test(`HF contract: configuration schema rejects ${field}=${value}`, () => {
  assert.throws(() => assertValidSchema({ ...config, [field]: value }, "hf-model-config.schema.json"), /schema validation/);
});

test("HF contract: numeric schema constraints reject invalid generation parameters", () => {
  for (const generation of [{ ...config.generation, top_p: 0 }, { ...config.generation, top_p: 2 }, { ...config.generation, temperature: 9 }]) {
    assert.throws(() => assertValidSchema({ ...config, generation }, "hf-model-config.schema.json"), /schema validation/);
  }
});

test("HF contract: model configuration mutations cannot masquerade as the frozen condition", () => {
  for (const field of ["model_artifact_hash", "tokenizer_hash", "runtime_hash", "template_hash", "sampling"]) {
    const changed = structuredClone(PILOT_0_AGENT_CONDITIONS.persistent);
    changed.model_runtime[field] = field === "sampling" ? { ...changed.model_runtime.sampling, temperature: 1.1 } : "f".repeat(64);
    assert.throws(() => assertAgentCondition(changed), /condition mismatch/);
  }
});

test("HF contract: same-name different-revision runtime cannot enter another arm of a run", () => {
  const world = makeWorld({ runId: "synthetic-artifact-parity" });
  const common = { configuration: config, backend: "mlx", synthetic: true, transport: async () => { throw new Error("must not invoke"); } };
  const [first, second] = Object.keys(world.polities);
  new AgentRuntime({ world, actorId: first, model: new Qwen35BaseAdapter(common), condition: PILOT_0_AGENT_CONDITIONS.persistent });
  assert.throws(() => new AgentRuntime({ world, actorId: second,
    model: new Qwen35BaseAdapter({ ...common, revision: "e".repeat(40) }),
    condition: PILOT_0_AGENT_CONDITIONS.nonpersistent }), /invariant mismatch/);
});

test("HF contract: shared provisional inference values exist in the parameter registry", () => {
  const entries = new Map(parameterRegistry().parameters.map(x => [x.parameter_id, x]));
  assert.deepEqual(entries.get("model.generation").value, config.generation);
  assert.equal(entries.get("model.context_budget").value, config.context_budget);
  assert.deepEqual(entries.get("model.retry").value, { max_attempts: config.max_attempts, attempt_timeout_ms: config.attempt_timeout_ms });
  for (const key of ["model.generation", "model.context_budget", "model.retry", "world.phase.action_budget"]) {
    assert.equal(entries.get(key).classification, "WORLD_CALIBRATION");
    assert.equal(entries.get(key).status, "PROVISIONAL");
    assert.match(entries.get(key).sensitivity_requirements, /PILOT_0_CALIBRATION_REQUIRED/);
  }
  assert.deepEqual(PROVISIONAL_MODEL_PARAMETERS.sampling, config.generation);
});

test("HF contract: recorded local artifact and runtime inventory reproduce configured hashes", () => {
  const lock = config.artifact_manifest;
  assert.ok(lock);
  assert.equal(sha256(lock.runtime_manifest), config.runtime_hash);
  assert.equal(sha256({ weights: lock.artifacts.weights, configuration: lock.artifacts.configuration }), config.model_artifact_hash);
  assert.equal(sha256(lock.artifacts.tokenizer), config.tokenizer_hash);
  assert.equal(lock.runtime_manifest.repository, config.repository);
  assert.equal(lock.runtime_manifest.revision, config.revision);
  assert.equal(lock.runtime_manifest.runner_hash, sha256(readFileSync(resolve(import.meta.dirname, "../src/huggingface-runtime.py"), "utf8")));
  assert.equal(lock.runtime_manifest.hardware.accelerator.verified, true);
  assert.equal(lock.generation_performed, false);
  assert.equal(config.confirmatory_frozen, false);
});
