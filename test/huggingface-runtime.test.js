import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Qwen35BaseAdapter, createHuggingFaceTransport, HF_RUNNER_PATH, loadPilotModelConfiguration, assertEmpiricalAdmission } from "../src/model-adapter.js";
import { DeterministicModel } from "../src/agent.js";

// Native workers are simulated. Python tests mock MLX/providers and use temporary
// synthetic byte fixtures. No actual model load, download or inference is run.
const model = "Qwen/Qwen3.5-9B-Base";
const revision = "a".repeat(40);
const pins = { model, revision, artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64), synthetic: true };
function python(body) {
  return execFileSync("python3", ["-B", "-c", `import runpy, sys, json, tempfile, pathlib, types\nns = runpy.run_path(${JSON.stringify(HF_RUNNER_PATH)})\n${body}`], { encoding: "utf8" });
}

test("synthetic: default adapter binds the explicit configured HF source and MLX launcher", () => {
  const config = loadPilotModelConfiguration(); const adapter = new Qwen35BaseAdapter();
  assert.equal(adapter.manifest.source, "huggingface"); assert.equal(adapter.manifest.model, config.repository);
  assert.equal(adapter.manifest.revision, config.revision); assert.equal(adapter.manifest.backend, "mlx");
  assert.match(adapter.manifest.python, /python/); assert.equal(adapter.manifest.quantization, "none");
  assert.equal(adapter.manifest.trust_remote_code, false); assert.equal(adapter.manifest.validation_status, "not_live_validated");
});

test("synthetic: native MLX dispatch is pinned raw text with no HTTP requirement", async () => {
  let request;
  const adapter = new Qwen35BaseAdapter({ ...pins, backend: "mlx", transport: async (wire) => {
    assert.equal(wire.url, null); request = JSON.parse(wire.body);
    return { status: 200, body: JSON.stringify({ model, hf_revision: revision,
      artifacts: { model_artifact_hash: pins.artifactHash, tokenizer_hash: pins.tokenizerHash }, runtime_hash: pins.runtimeHash,
      choices: [{ text: " exact\r\n", finish_reason: "stop" }] }) };
  } });
  const result = await adapter.complete({ prompt: "raw\n雪", deadline: 100, now: () => 0 });
  assert.equal(request.command, "generate"); assert.equal(request.backend, "mlx"); assert.equal(request.prompt, "raw\n雪");
  assert.equal(request.revision, revision); assert.equal(request.quantization, "none"); assert.equal(request.dtype, "checkpoint");
  assert.equal(result.outputText, " exact\r\n"); assert.deepEqual(adapter.fork().manifest, adapter.manifest);
});

test("synthetic: native probe invokes only inspection and forces unvalidated status", async () => {
  const adapter = new Qwen35BaseAdapter({ ...pins, backend: "mlx", transport: async (wire) => {
    const request = JSON.parse(wire.body); assert.equal(request.command, "probe"); assert.equal(request.prompt, undefined);
    return { status: 200, body: JSON.stringify({ available: true, weights_loaded: false, generation_performed: false }) };
  } });
  const result = await adapter.probe(); assert.equal(result.live_validated, false); assert.equal(result.weights_loaded, false);
});

test("synthetic: optional Transformers backend requires explicit dtype/device", async () => {
  let calls = 0;
  const adapter = new Qwen35BaseAdapter({ ...pins, backend: "transformers", dtype: null, device: null, transport: async () => { calls++; } });
  await assert.rejects(adapter.complete({ prompt: "x", deadline: 100, now: () => 0 }), /dtype_and_device/); assert.equal(calls, 0);
});

test("synthetic: native quantization and changed revision are rejected", async () => {
  await assert.rejects(new Qwen35BaseAdapter({ ...pins, backend: "mlx", quantization: "Q4" }).complete({ prompt: "x", deadline: 100, now: () => 0 }), /quantization/);
  const adapter = new Qwen35BaseAdapter({ ...pins, backend: "mlx", transport: async () => ({ status: 200, body: JSON.stringify({ model, hf_revision: "b".repeat(40), choices: [{ text: "x", finish_reason: "stop" }] }) }) });
  await assert.rejects(adapter.complete({ prompt: "x", deadline: 100, now: () => 0 }), /revision_mismatch/);
});

test("synthetic: process bridge uses argument arrays, exact stdin and aborts its child", async () => {
  let invocation; let input; let killed = false;
  function spawnProcess(command, args, options) {
    invocation = { command, args, options }; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = (body) => { input = body; queueMicrotask(() => { child.stdout.emit("data", Buffer.from("{\"available\":true}")); child.emit("close", 0); }); };
    child.kill = () => { killed = true; }; return child;
  }
  const controller = new AbortController(); const transport = createHuggingFaceTransport({ python: "/synthetic/python", spawnProcess });
  const body = '{"command":"probe","model":"literal $(not-shell)"}'; const response = await transport({ body, signal: controller.signal });
  assert.equal(input, body); assert.equal(invocation.command, "/synthetic/python"); assert.deepEqual(invocation.args, ["-B", HF_RUNNER_PATH]);
  assert.equal(invocation.options.shell, undefined); assert.equal(invocation.options.env.HF_HUB_OFFLINE, "1"); assert.equal(response.status, 200);
  controller.abort(); assert.equal(killed, false); // Abort listener is removed after child exit.
});

test("synthetic: runner validates exact Base repository and commit before loading", () => {
  python(`for request in [{'model':'Qwen/Qwen3.5-9B','revision':'a'*40}, {'model':'Qwen/Qwen3.5-9B-Base','revision':'main'}]:
    try: ns['validate_identity'](request)
    except ValueError: pass
    else: raise AssertionError('identity accepted')
ns['validate_identity']({'model':'Qwen/Qwen3.5-9B-Base','revision':'a'*40})`);
});

test("synthetic: file provenance detects changed weights/tokenizer and missing shards", () => {
  python(`with tempfile.TemporaryDirectory(prefix='civilization-hf-fixture-') as directory:
    p=pathlib.Path(directory)
    (p/'config.json').write_text('{"model_type":"qwen3_5"}')
    (p/'tokenizer.json').write_text('synthetic-tokenizer')
    (p/'model.safetensors').write_bytes(b'synthetic-weights')
    before=ns['inspect_snapshot'](p)
    (p/'model.safetensors').write_bytes(b'changed-synthetic-weights')
    after=ns['inspect_snapshot'](p)
    assert before['model_artifact_hash'] != after['model_artifact_hash']
    assert before['tokenizer_hash'] == after['tokenizer_hash']
    (p/'tokenizer.json').write_text('changed-tokenizer')
    assert ns['inspect_snapshot'](p)['tokenizer_hash'] != before['tokenizer_hash']
    (p/'model.safetensors.index.json').write_text(json.dumps({'weight_map':{'x':'missing.safetensors'}}))
    try: ns['inspect_snapshot'](p)
    except ValueError as e: assert str(e)=='incomplete_huggingface_weight_shards'
    else: raise AssertionError('missing shard accepted')`);
});

test("synthetic: native MLX implementation supplies raw tokens and disables remote code/quantization", () => {
  python(`calls={}
mx=types.ModuleType('mlx.core'); mx.random=types.SimpleNamespace(seed=lambda seed:calls.update(seed=seed))
mlx=types.ModuleType('mlx'); mlx.core=mx
sys.modules['mlx']=mlx; sys.modules['mlx.core']=mx
class Tokenizer:
    def encode(self, text, **kwargs):
        calls['encode']=(text,kwargs); return [11,12]
    def decode(self, tokens, **kwargs):
        calls['decode']=(tokens,kwargs); return ' exact\\n'
class Model:
    def eval(self): calls['eval']=True
def load(path, **kwargs):
    calls['load']=(path,kwargs); return Model(),Tokenizer(),{'max_position_embeddings':100}
def stream(model, tokenizer, **kwargs):
    calls['stream']=kwargs
    yield types.SimpleNamespace(token=42,finish_reason=None)
    yield types.SimpleNamespace(token=99,finish_reason='stop')
lm=types.ModuleType('mlx_lm'); lm.load=load; lm.stream_generate=stream
samplers=types.ModuleType('mlx_lm.sample_utils'); samplers.make_sampler=lambda **kwargs:kwargs
sys.modules['mlx_lm']=lm; sys.modules['mlx_lm.sample_utils']=samplers
request={'model':'Qwen/Qwen3.5-9B-Base','revision':'a'*40,'prompt':'raw prompt','seed':0,'context_budget':100,'max_tokens':5,'temperature':0.7,'top_p':0.9}
result=ns['generate_mlx'](request,'/synthetic/snapshot',{}, {})
assert calls['load'][1]['tokenizer_config']['trust_remote_code'] is False
assert calls['load'][1]['adapter_path'] is None
assert calls['encode']==('raw prompt',{'add_special_tokens':False})
assert calls['stream']['prompt']==[11,12] and calls['stream']['kv_bits'] is None and calls['stream']['prompt_cache'] is None
assert calls['decode'][0]==[42] and calls['decode'][1]['clean_up_tokenization_spaces'] is False
assert result['output_token_ids']==[42,99] and result['choices'][0]['text']==' exact\\n'`);
});

test("synthetic: runner probe never imports a model, loads weights or calls generation", () => {
  python(`probe=ns['probe']; scope=probe.__globals__
scope['packages']=lambda:{key:'synthetic-version' for key in ['mlx','mlx_lm','transformers','huggingface_hub','tokenizers']}
scope['cached_snapshot']=lambda request:'/synthetic/cache'
scope['runtime_manifest']=lambda request:{'synthetic':True}
scope['generate']=lambda request:(_ for _ in ()).throw(AssertionError('generation during probe'))
result=probe({'model':'Qwen/Qwen3.5-9B-Base','revision':'a'*40,'backend':'mlx'})
assert result['available'] and not result['live_validated'] and not result['weights_loaded'] and not result['generation_performed']`);
  const source = readFileSync(HF_RUNNER_PATH, "utf8"); assert.doesNotMatch(source, /apply_chat_template|trust_remote_code=True|ollama/i);
});

test("synthetic: empirical admission rejects doubles regardless of caller labeling", () => {
  assert.throws(() => assertEmpiricalAdmission(new DeterministicModel()), /synthetic/);
  assert.throws(() => assertEmpiricalAdmission(new Qwen35BaseAdapter({ ...pins, backend: "mlx" })), /synthetic/);
  assert.throws(() => assertEmpiricalAdmission({ manifest: { synthetic: false, source: "huggingface" } }), /synthetic/);
  assert.throws(() => new Qwen35BaseAdapter({ ...pins, synthetic: false, backend: "mlx", transport: async () => ({}) }), /explicitly synthetic/);
});

test("synthetic: endpoint output requires complete matching artifact attestation", async () => {
  for (const attestation of [{}, { hf_revision: revision }, { hf_revision: revision, runtime_hash: pins.runtimeHash,
    artifacts: { model_artifact_hash: "9".repeat(64), tokenizer_hash: pins.tokenizerHash } }]) {
    const adapter = new Qwen35BaseAdapter({ ...pins, backend: "hf_endpoint", baseUrl: "https://synthetic.invalid/v1",
      transport: async () => ({ status: 200, body: JSON.stringify({ model, choices: [{ text: "x", finish_reason: "stop" }], ...attestation }) }) });
    await assert.rejects(adapter.complete({ prompt: "x", deadline: 100, now: () => 0 }), /revision_mismatch|attestation_mismatch/);
  }
});

test("synthetic: production endpoint is unavailable until independently attested serving exists", () => {
  assert.throws(() => new Qwen35BaseAdapter({ ...pins, synthetic: false, backend: "hf_endpoint", baseUrl: "https://example.endpoints.huggingface.cloud/v1" }), /production_remote_serving_not_attested/);
});

test("synthetic: native and injected endpoint transports receive no authorization secrets", async () => {
  const original = process.env.HF_TOKEN; process.env.HF_TOKEN = "synthetic-secret-canary";
  try {
    for (const backend of ["mlx", "hf_endpoint"]) {
      const adapter = new Qwen35BaseAdapter({ ...pins, backend, baseUrl: backend === "hf_endpoint" ? "https://synthetic.invalid/v1" : null,
        apiKey: "synthetic-explicit-secret", transport: async (request) => {
          assert.equal(request.headers.Authorization, undefined); assert.doesNotMatch(JSON.stringify(request), /synthetic-secret-canary|synthetic-explicit-secret/);
          return { status: 200, body: JSON.stringify({ available: true, data: [{ id: model }] }) };
        } });
      await adapter.probe();
    }
    const transport = createHuggingFaceTransport({ spawnProcess(_command, _args, options) {
      assert.equal(options.env.HF_TOKEN, undefined); assert.equal(options.env.QWEN_BASE_API_KEY, undefined);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
      child.stdin.end = () => queueMicrotask(() => child.emit("close", 0)); return child;
    } });
    await transport({ body: '{"command":"probe"}' });
  } finally { if (original === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = original; }
});

test("synthetic: production admission binds every artifact and runtime field to source config", () => {
  const configuration = { ...loadPilotModelConfiguration(), repository: model, revision, runtime: "mlx-lm", dtype: "checkpoint", device: "metal",
    model_artifact_hash: pins.artifactHash, tokenizer_hash: pins.tokenizerHash, runtime_hash: pins.runtimeHash };
  const base = { ...pins, configuration, synthetic: false, backend: "mlx", dtype: "checkpoint", device: "metal" };
  for (const change of [{ artifactHash: "4".repeat(64) }, { tokenizerHash: "4".repeat(64) }, { runtimeHash: "4".repeat(64) },
    { model: "Qwen/Qwen3.5-4B-Base" }, { revision: "b".repeat(40) }, { device: "cpu" }, { dtype: "float16" }, { backend: "transformers" }]) {
    const adapter = new Qwen35BaseAdapter({ ...base, ...change });
    assert.throws(() => assertEmpiricalAdmission(adapter), /configuration_drift|requires_checkpoint|dtype_and_device/);
  }
  for (const changed of [{ tokenizer_repository: "Qwen/Qwen3.5-4B-Base" }, { tokenizer_revision: "b".repeat(40) }]) {
    assert.throws(() => assertEmpiricalAdmission(new Qwen35BaseAdapter({ ...base, configuration: { ...configuration, ...changed } })), /configuration_drift/);
  }
});

test("synthetic: checkpoint dynamic code selectors are rejected before native loading", () => {
  python(`with tempfile.TemporaryDirectory(prefix='civilization-hf-code-fixture-') as directory:
    p=pathlib.Path(directory)
    (p/'custom.py').write_text("raise AssertionError('MUST NEVER EXECUTE')")
    for extra in [{'model_file':'custom.py'}, {'text_config':{'model_file':'custom.py'}}, {'auto_map':{'AutoModel':'custom.Model'}}, {'model_type':'custom'}, {'text_config':{'quantization':{}}}]:
        (p/'config.json').write_text(json.dumps({'model_type':'qwen3_5',**extra}))
        try: ns['inspect_snapshot'](p)
        except ValueError as e: assert str(e) in ['dynamic_checkpoint_code_forbidden','checkpoint_architecture_mismatch','implicit_checkpoint_quantization_forbidden']
        else: raise AssertionError('dynamic code accepted')
    (p/'config.json').write_text('{"model_type":"qwen3_5"}')
    (p/'tokenizer_config.json').write_text('{"nested":{"chat_template_type":"custom"}}')
    try: ns['inspect_snapshot'](p)
    except ValueError as e: assert str(e)=='dynamic_checkpoint_code_forbidden'
    else: raise AssertionError('tokenizer code accepted')`);
});

test("synthetic: tokenizers version and verified accelerator identity affect runtime hash", () => {
  python(`with tempfile.TemporaryDirectory(prefix='civilization-hf-hardware-fixture-') as directory:
    p=pathlib.Path(directory); (p/'config.json').write_text('{"model_type":"qwen3_5"}')
    manifest=ns['runtime_manifest']; scope=manifest.__globals__
    scope['cached_snapshot']=lambda request:directory
    version=['synthetic-v1']; scope['packages']=lambda:{'tokenizers':version[0]}
    mx=types.ModuleType('mlx.core'); mx.gpu='gpu'
    mx.default_device=lambda:types.SimpleNamespace(type='gpu')
    mx.metal=types.SimpleNamespace(is_available=lambda:True)
    device=['Synthetic GPU A']; mx.device_info=lambda kind:{'device_name':device[0],'architecture':'synthetic-gpu'}
    mlx=types.ModuleType('mlx'); mlx.core=mx; sys.modules['mlx']=mlx; sys.modules['mlx.core']=mx
    request={'model':'Qwen/Qwen3.5-9B-Base','revision':'a'*40,'backend':'mlx','dtype':'checkpoint','device':'metal'}
    first=manifest(request); assert first['hardware']['accelerator']['verified']
    version[0]='synthetic-v2'; second=manifest(request)
    assert ns['digest'](first)!=ns['digest'](second)
    device[0]='Synthetic GPU B'; third=manifest(request)
    assert ns['digest'](second)!=ns['digest'](third)
    mx.default_device=lambda:types.SimpleNamespace(type='cpu')
    try: manifest(request)
    except ValueError as e: assert str(e)=='configured_metal_device_unavailable'
    else: raise AssertionError('device mismatch accepted')`);
});
