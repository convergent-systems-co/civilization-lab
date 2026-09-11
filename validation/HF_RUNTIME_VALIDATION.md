# HF runtime validation checkpoint — 2026-09-10

Historical artifact-loading checkpoint. Subsequent fixed arithmetic-only native
generation checks, including the actual configured production generation and
timeout path, are recorded in [NATIVE_RUNTIME_SMOKE.md](NATIVE_RUNTIME_SMOKE.md).
The old endpoint missing-codebook blocker below was superseded and resolved by
the human operational definitions; current boundaries are in
`IMPLEMENTATION_BLOCKERS.md`. Historical test totals below are not current totals.

Scope: non-empirical artifact and loading validation only. No generation, world execution, calibration, human sessions, horizon selection or confirmatory freeze occurred.

## Verified environment

- Repository: `Qwen/Qwen3.5-9B-Base`.
- Commit: `68c46c4b3498877f3ef123c856ecfde50c39f404`.
- Existing runtime: MLX-LM `0.31.3`, MLX `0.32.2`, Transformers `5.16.1`, Hugging Face Hub `1.30.0`.
- Native model loading succeeded through MLX-LM with `trust_remote_code=False`, `local_files_only=True`, `adapter_path=None`, `lazy=False`, and the explicit cached revision. No chat template was applied.
- Loaded class: `mlx_lm.models.qwen3_5.Model`; model type `qwen3_5`.
- Tokenizer raw encoding succeeded with `add_special_tokens=False`.
- Active model memory reported: 17,907,614,216 bytes.
- Accelerator: Apple M5 Max, `applegpu_g17s`, 137,438,953,472 bytes unified memory. No GPU generation occurred.

The sandbox cannot initialize Metal. The approved external load check succeeded; this is not a missing-runtime or missing-token infrastructure blocker.

## Artifact inspection

All four cached safetensors shard SHA-256 hashes and the tokenizer.json hash matched authenticated Hugging Face metadata at the immutable commit. HF credential values were not printed, stored or added to configuration. Config/tokenizer auxiliary files are included in the content-addressed inspection lock; verification uses the pinned HF metadata, never a moving branch name.

## Scope limits

Loading weights and encoding a fixed synthetic string are not inference conformance or empirical Pilot 0. Production generation has not been performed. Mocked transport tests check admission, raw provenance, context boundaries and error handling; their output is synthetic. The full apparatus remains implementation-incomplete, including world/UI coverage and the endpoint operational-definition blocker in `IMPLEMENTATION_BLOCKERS.md`.

Independent reviews identified implementation defects in artifact-lock binding, remote attestation, credential reflection, empirical-mode override, custom checkpoint code and runtime fingerprint completeness. All were fixed and regression-tested. Both reviewers independently rechecked their findings and reported no remaining P0/P1 in this runtime scope. Production remote serving is rejected, not trusted on self-reported hashes; the configured native HF/MLX path is supported.

The final recorded artifact/runtime inspection is embedded in `config/pilot0-model.json`. Runtime hash: `7ec89ee0098059839540d5d72c8a1acc3779b786f88ee363fb2359a1ff382549`. Artifact hash: `f300d6172dd4f852e3f1e47d3d33275e0a6c62075dfd5c567ec412f839a22c59`. Tokenizer hash: `09f36fad5128ba0d2cf24a8c47373c279766f7981baa23d0862caf4bacb6060b`. Validation rejects a runner-source change without a matching refreshed lock. Tokenizers `0.23.2`, actual checkpoint BF16/F32 tensor dtypes, accelerator identity and verified execution device are included in the fingerprint.

Final `npm run check`: 120 tests, 120 passed, zero failed/cancelled/skipped/TODO; 36 schema documents and 23 catalogue entries inspected, build passed. This is the currently implemented suite, not a claim that all required apparatus tests have been implemented. The integrated synthetic fixture also replays a complete turn with model invocations and isolated interviews, and rejects missing interview evidence.
