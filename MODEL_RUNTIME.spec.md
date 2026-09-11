# Pilot 0 model runtime contract

Version: `pilot-0.2-hf`. Authority: human runtime correction, 2026-09-10. This refines the production runtime requirement, not the hypothesis, estimand, or history-access treatment. It inherits `INVARIANTS.spec.md`.

## Source and artifact identity

Hugging Face is the sole Pilot 0 production model source. Ollama is NOT a runtime dependency, model source, compatibility layer, fallback, or supported production assumption. Future provider-agnostic extension points do not authorize other providers in Pilot 0.

The experimental family remains Qwen 3.5 Base. `config/pilot0-model.json` declares the HF repository and exact immutable commit. The currently configured local artifact is `Qwen/Qwen3.5-9B-Base` at `68c46c4b3498877f3ef123c856ecfde50c39f404`. This records the existing cache selection; it is not a confirmatory freeze or authorization to execute empirical Pilot 0. Resolve and validate the artifact lock before empirical execution.

Never substitute an instruct model, quantized derivative, another Qwen release/model, packaged derivative, or different HF revision. A moving branch/tag such as `main` is insufficient. Missing/unavailable artifacts, mismatched hashes, wrong tokenizer, wrong architecture or quantization, and absent runtime prerequisites fail closed. Credential availability is not proof of runtime conformance. `HF_TOKEN` is a transport credential, never experimental identity and never captured in canonical inputs, output, URLs, logs, or provenance.

## Provenance lock

The content-addressed runtime manifest must include:

- source, repository/model ID, immutable commit and model/config architecture identity;
- tokenizer repository/revision, tokenizer/config hashes and relevant weight artifact hashes;
- loading backend, runtime/library versions, runtime source hash and loading configuration;
- dtype/precision, quantization (explicitly `none` for the selected artifact), adapters and dynamic-weight state;
- generation parameters including seeds, context limits, exact token accounting, raw completion template/parser identities;
- device/hardware-relevant execution configuration and unavoidable environment deviations.

All conditions in a run share one verified artifact and equivalent inference configuration. Model, tokenizer, precision, quantization, sampling, context/computation budget, template/parser, retry policy and runtime changes are not history-access treatments. The agent-condition validator detects undeclared differences, including post-construction changes. Per-invocation runtime references resolve to the exact locked manifest, not only a model name or mutable endpoint advertisement.

The native HF-backed runner loads the pinned snapshot through the explicitly configured supported library (for this existing environment, MLX-LM). It must not silently choose a different backend, dtype, device, quantization, or chat template. An OpenAI-compatible API shape is not evidence of HF artifact identity. Any future remote serving implementation must verify the same lock before accepting output; arbitrary local compatibility endpoints are not authorized.

## Invocation and information boundary

Model input consists solely of declared neutral instructions, the actor's authorized projection, declared current history/memory and authorized tool results. Never pass authoritative world objects to transport. Capture the exact rendered prompt, context segment origins/ACLs, memory availability, tool/action schema, request, returned raw output, parser result, failures and retries as content-addressed evidence.

Connect each invocation to run, authoritative turn/phase, experimental identity, incarnation/session, condition and retry/recovery lineage. Retries create new invocation IDs and preserve prior attempts; no implicit output repair or history carryover. Invalid/partial agent actions are lost according to the world contract. Technical retries remain bounded by the declared phase deadline. Interviews remain non-causal projection-only isolated contexts.

## Execution boundary

The deterministic model double is only for explicitly synthetic non-empirical conformance fixtures. Mark manifests/evidence synthetic and reject it from empirical admission. No production-to-double fallback is permitted. A valid production manifest does not itself grant execution authority.

Non-empirical checks may inspect the pinned cache, hash artifacts, inspect library metadata and exercise deterministic transports. Real model-generated world behavior, calibration, human sessions, horizon selection, #112 freeze and confirmatory research remain unauthorized in this pass.

Before empirical Pilot 0: validate the complete apparatus, resolve/verify every runtime manifest field, validate the actual loader/runtime against the configured artifact, record treatment equivalence and obtain separate execution authorization. Metadata-only probes and mocked transports must not be reported as live generation validation.

## Conformance gates

1. Production imports/configuration/dependencies require no Ollama service, API, package or model tag.
2. Configuration explicitly names a Qwen 3.5 Base HF repository and 40-hex immutable revision; mutable/mismatched selections fail closed.
3. Artifact/config/tokenizer/runtime provenance is content-addressed and referenced by invocation evidence.
4. Different artifacts across conditions are rejected, including same-name different-revision artifacts.
5. Generation, precision, context, runtime and other undeclared configuration drift is detected by the agent-condition validator.
6. Canary hidden world information cannot enter prompt, memory, tools, errors or transport request.
7. Invocations resolve to identity/session/run/turn and retry/recovery evidence.
8. Empirical admission rejects synthetic doubles regardless of caller labels.
9. Unavailable/mismatched HF artifacts cannot trigger another model/revision/runtime fallback.

Tests distinguish mocked transport conformance, local artifact inspection, actual runtime loading and live inference. Report each independently. Full-apparatus gates stay open until actually implemented and validated.
