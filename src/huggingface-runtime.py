"""Pinned Hugging Face Base runner. One JSON request on stdin, one result on stdout.

`probe` inspects packages/cache only. `generate` is a separate explicit operation.
The cache must already contain the pinned snapshot; this runner never downloads.
"""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
from pathlib import Path
import re
import sys


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate_identity(request):
    if not re.fullmatch(r"Qwen/Qwen3\.5-\d+(?:\.\d+)?B(?:-A\d+(?:\.\d+)?B)?-Base", request.get("model") or ""):
        raise ValueError("qwen_base_model_not_configured_or_invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", request.get("revision") or ""):
        raise ValueError("huggingface_commit_pin_required")


def packages():
    result = {}
    for name in ("torch", "transformers", "huggingface_hub", "tokenizers", "mlx", "mlx_lm"):
        try:
            result[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            result[name] = None
    return result


def validate_snapshot_configuration(root):
    forbidden = {"model_file", "auto_map", "custom_pipelines", "code_revision", "_auto_class",
                 "trust_remote_code", "chat_template_type", "tool_parser_type"}

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in forbidden:
                    raise ValueError("dynamic_checkpoint_code_forbidden")
                if key in ("quantization", "quantization_config", "quantize_activations") and child is not None and child is not False:
                    raise ValueError("implicit_checkpoint_quantization_forbidden")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for name in ("config.json", "tokenizer_config.json", "generation_config.json"):
        path = root / name
        if path.exists():
            visit(json.loads(path.read_text()))
    configuration = json.loads((root / "config.json").read_text())
    if configuration.get("model_type") not in ("qwen3_5", "qwen3_5_moe"):
        raise ValueError("checkpoint_architecture_mismatch")
    return configuration


def inspect_snapshot(path):
    """Hash exact cached files; never import checkpoint code or load weights."""
    root = Path(path)
    # MLX's model_file bypasses tokenizer trust_remote_code. Reject all dynamic
    # selectors recursively before any load_model/load_tokenizer call.
    validate_snapshot_configuration(root)
    weights, tokenizer, config = {}, {}, {}
    for file in sorted(root.rglob("*")):
        if not file.is_file():
            continue
        name = file.relative_to(root).as_posix()
        group = weights if name.endswith(".safetensors") or name.endswith(".safetensors.index.json") else (
            tokenizer if file.name in ("tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json") else
            config if file.name in ("config.json", "generation_config.json") else None)
        if group is not None:
            with file.open("rb") as handle:
                group[name] = hashlib.file_digest(handle, "sha256").hexdigest()
    if not weights or "tokenizer.json" not in tokenizer or "config.json" not in config:
        raise ValueError("incomplete_huggingface_snapshot")
    for index in root.glob("*.safetensors.index.json"):
        referenced = set(json.loads(index.read_text())["weight_map"].values())
        if not referenced or any(name not in weights for name in referenced):
            raise ValueError("incomplete_huggingface_weight_shards")
    return {"weights": weights, "tokenizer": tokenizer, "configuration": config,
            "model_artifact_hash": digest({"weights": weights, "configuration": config}),
            "tokenizer_hash": digest(tokenizer)}


def cached_snapshot(request):
    from huggingface_hub.constants import HF_HUB_CACHE
    # A cache populated with only generation artifacts may omit repository docs;
    # recent Hub clients reject that as an incomplete *repository* snapshot.
    # Bind the exact cached commit here; inspect_snapshot verifies all model shards.
    cached = Path(HF_HUB_CACHE) / ("models--" + request["model"].replace("/", "--")) / "snapshots" / request["revision"]
    if cached.is_dir():
        return str(cached)
    from huggingface_hub import snapshot_download
    return snapshot_download(repo_id=request["model"], revision=request["revision"],
                             token=os.environ.get("HF_TOKEN"), local_files_only=True)


def runtime_manifest(request):
    local = Path(cached_snapshot(request))
    validate_snapshot_configuration(local)
    config_bytes = (local / "config.json").read_bytes()
    configuration = json.loads(config_bytes)
    dtypes = set()
    for shard in sorted(local.glob("*.safetensors")):
        with shard.open("rb") as handle:
            size = int.from_bytes(handle.read(8), "little")
            if size > 100_000_000:
                raise ValueError("invalid_safetensors_header")
            header = json.loads(handle.read(size))
            dtypes.update(tensor["dtype"] for name, tensor in header.items() if name != "__metadata__")
    accelerator = {"verified": False, "reason": "backend_device_not_inspected"}
    if request.get("backend") == "mlx":
        import mlx.core as mx
        if not mx.metal.is_available() or mx.default_device().type != mx.gpu:
            raise ValueError("configured_metal_device_unavailable")
        accelerator = {"verified": True, "verification": "mlx_device_info", "default_device": str(mx.default_device()),
                       "descriptor": mx.device_info(mx.gpu)}
    return {"packages": packages(), "runner_hash": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dtype": request.get("dtype"), "device": request.get("device"), "backend": request.get("backend", "transformers"),
            "source": "huggingface", "repository": request["model"], "revision": request["revision"],
            "tokenizer_repository": request["model"], "tokenizer_revision": request["revision"],
            "model_type": configuration.get("model_type"), "architectures": configuration.get("architectures"),
            "text_model_type": configuration.get("text_config", {}).get("model_type"),
            "config_sha256": hashlib.sha256(config_bytes).hexdigest(), "weight_dtypes": sorted(dtypes),
            "checkpoint_dtype": configuration.get("dtype", configuration.get("text_config", {}).get("dtype")),
            "hardware": {"system": platform.system(), "machine": platform.machine(), "processor": platform.processor(),
                         "release": platform.release(), "mac_version": platform.mac_ver()[0], "python": platform.python_version(),
                         "accelerator": accelerator},
            "trust_remote_code": False, "quantization": "none", "chat_template": False,
            "token_accounting": "exact_tokenizer_ids_no_added_special_tokens", "adapters": [], "dynamic_weights": False}


def probe(request):
    installed = packages()
    result = {"available": False, "classification": "infrastructure", "live_validated": False,
              "weights_loaded": False, "generation_performed": False, "packages": installed}
    try:
        validate_identity(request)
        required = ("mlx", "mlx_lm", "transformers", "huggingface_hub", "tokenizers") if request.get("backend") == "mlx" else ("torch", "transformers", "huggingface_hub", "tokenizers")
        if not all(installed[name] for name in required):
            result["reason"] = "packages_missing_in_selected_interpreter"
            return result
        snapshot = cached_snapshot(request)
        result["runtime_manifest"] = runtime_manifest(request)
        result["runtime_hash"] = digest(result["runtime_manifest"])
        # Full hashes are opt-in read-only inspection; ordinary probes stay cheap.
        if request.get("inspect_artifacts"):
            result["artifacts"] = inspect_snapshot(snapshot)
        result.update(available=True, classification="cached_runtime_unloaded", reason="pinned_snapshot_cached")
    except Exception as error:
        result["reason"] = str(error) if isinstance(error, ValueError) else "pinned_snapshot_not_available_in_selected_cache"
    return result


def generate(request):
    validate_identity(request)
    if request.get("quantization") != "none":
        raise ValueError("native_quantization_not_supported_no_fallback")
    backend = request.get("backend", "transformers")
    if backend not in ("mlx", "transformers"):
        raise ValueError("unknown_native_backend")
    if backend == "transformers" and (request.get("dtype") not in ("float32", "float16", "bfloat16") or not re.fullmatch(r"cpu|mps|cuda(?::\d+)?", request.get("device") or "")):
        raise ValueError("explicit_dtype_and_device_required")
    if backend == "mlx" and (request.get("dtype") != "checkpoint" or request.get("device") != "metal"):
        raise ValueError("mlx_requires_checkpoint_dtype_and_metal")
    if not isinstance(request.get("prompt"), str):
        raise ValueError("raw_text_prompt_required")
    local = cached_snapshot(request)
    artifacts = inspect_snapshot(local)
    for key in ("model_artifact_hash", "tokenizer_hash"):
        if request.get(key) != artifacts[key]:
            raise ValueError(key + "_mismatch")
    runtime = runtime_manifest(request)
    if request.get("runtime_hash") != digest(runtime):
        raise ValueError("runtime_hash_mismatch")
    if backend == "mlx":
        return generate_mlx(request, local, artifacts, runtime)
    import torch
    from transformers import AutoConfig, AutoTokenizer, Qwen3_5ForCausalLM, Qwen3_5TextConfig, GenerationConfig, set_seed
    if "-A" in request["model"]:
        raise ValueError("native_moe_requires_explicit_supported_runner")
    configuration = AutoConfig.from_pretrained(local, trust_remote_code=False, local_files_only=True)
    if configuration.model_type not in ("qwen3_5", "qwen3_5_text"):
        raise ValueError("checkpoint_architecture_mismatch")
    text_configuration = getattr(configuration, "text_config", configuration)
    if not isinstance(text_configuration, Qwen3_5TextConfig):
        raise ValueError("checkpoint_text_configuration_mismatch")
    tokenizer = AutoTokenizer.from_pretrained(local, trust_remote_code=False, local_files_only=True)
    inputs = tokenizer(request["prompt"], return_tensors="pt", add_special_tokens=False)
    if inputs.input_ids.shape[-1] + request["max_tokens"] > min(request["context_budget"], text_configuration.max_position_embeddings):
        raise ValueError("context_capacity_exceeded")
    model = Qwen3_5ForCausalLM.from_pretrained(local, config=text_configuration, trust_remote_code=False,
        local_files_only=True, use_safetensors=True, dtype=getattr(torch, request["dtype"]), attn_implementation="eager")
    model.to(request["device"])
    model.eval()
    inputs = inputs.to(request["device"])
    set_seed(request["seed"])
    # Explicit generation configuration prevents checkpoint sampling defaults from
    # silently changing the frozen condition. No chat template is applied.
    config = GenerationConfig(max_new_tokens=request["max_tokens"], do_sample=request["temperature"] > 0,
        temperature=request["temperature"] if request["temperature"] > 0 else 1.0,
        top_p=request["top_p"], top_k=0, num_beams=1, repetition_penalty=1.0,
        eos_token_id=tokenizer.eos_token_id, pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id)
    with torch.inference_mode():
        generated = model.generate(**inputs, generation_config=config)
    tokens = generated[0, inputs.input_ids.shape[-1]:].tolist()
    eos = tokenizer.eos_token_id
    stopped = bool(tokens and tokens[-1] == eos)
    content_tokens = tokens[:-1] if stopped else tokens
    text = tokenizer.decode(content_tokens, skip_special_tokens=False, clean_up_tokenization_spaces=False)
    return {"model": request["model"], "hf_revision": request["revision"], "artifacts": artifacts,
            "runtime_hash": digest(runtime), "runtime_manifest": runtime,
            "input_token_ids": inputs.input_ids[0].tolist(), "output_token_ids": tokens, "eos_removed_from_text": stopped,
            "choices": [{"text": text, "finish_reason": "stop" if stopped else "length"}]}


def generate_mlx(request, local, artifacts, runtime):
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler
    model, tokenizer, configuration = load(local, revision=request["revision"],
        tokenizer_config={"trust_remote_code": False, "local_files_only": True}, adapter_path=None,
        lazy=False, return_config=True)
    model.eval()
    # Pass explicit token IDs to prevent MLX's string-prompt BOS inference.
    prompt_tokens = tokenizer.encode(request["prompt"], add_special_tokens=False)
    limit = configuration.get("text_config", configuration).get("max_position_embeddings", request["context_budget"])
    if len(prompt_tokens) + request["max_tokens"] > min(limit, request["context_budget"]):
        raise ValueError("context_capacity_exceeded")
    mx.random.seed(request["seed"])
    sampler = make_sampler(temp=request["temperature"], top_p=request["top_p"], top_k=0, min_p=0.0)
    tokens, finish = [], None
    for item in stream_generate(model, tokenizer, prompt=prompt_tokens, max_tokens=request["max_tokens"],
                                sampler=sampler, kv_bits=None, prompt_cache=None):
        tokens.append(item.token)
        finish = item.finish_reason
    stopped = finish == "stop"
    content_tokens = tokens[:-1] if stopped else tokens
    text = tokenizer.decode(content_tokens, skip_special_tokens=False, clean_up_tokenization_spaces=False)
    return {"model": request["model"], "hf_revision": request["revision"], "artifacts": artifacts,
            "runtime_hash": digest(runtime), "runtime_manifest": runtime, "output_token_ids": tokens, "input_token_ids": prompt_tokens,
            "eos_removed_from_text": stopped, "choices": [{"text": text, "finish_reason": finish}]}


def main():
    try:
        request = json.load(sys.stdin)
        if request.get("command") == "probe":
            result = probe(request)
        elif request.get("command") == "generate":
            result = generate(request)
        else:
            raise ValueError("unknown_runner_command")
    except Exception as error:
        # Never serialize exception messages from third-party clients: they can
        # contain authorization data or local paths. Our own codes are fixed.
        result = {"error": {"classification": "infrastructure", "code": str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z_]+", str(error)) else "huggingface_runtime_failure"}}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
