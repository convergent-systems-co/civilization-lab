# Hugging Face native runtime conformance

2026-09-10: PASS. One fixed arithmetic prompt, one output token, no world state,
no calibration, no research evidence. The production adapter loaded the pinned
unquantized Hugging Face Qwen/Qwen3.5-9B-Base artifact and verified its native
runtime/artifact attestations. The one-token cap produced `finish_reason: length`;
the adapter correctly preserved the bytes and rejected the partial output.

- HF revision: `68c46c4b3498877f3ef123c856ecfde50c39f404`
- Runtime hash: `7ec89ee0098059839540d5d72c8a1acc3779b786f88ee363fb2359a1ff382549`
- Fixture hash: `a068a76b376b481278a8352b744728411f0e48f680d76ccdcc15ec486a0220c2`
- Request hash: `f9535e074ba10f067d22e1e05bac827db3782878de2e48c5a472879b86410893e`
- Response hash: `999ab48224ff84e6d858e9d7ffb12c607800e18edccd5f11387657bf56f7b958`

Reproduce with `node scripts/native-runtime-smoke.js --non-empirical-smoke`.
The explicit test-only configuration is `config/runtime-conformance.json`.
It overrides only output length to test the partial-output boundary; it does not
change the world experiment's registered generation settings or freeze #112.
Metal requires sandbox escalation on this host. HF_TOKEN was not printed.

This validates native loading, generation transport, attestation and partial-output
handling, not strategic behavior, action validity rates, throughput adequacy,
calibration, full apparatus acceptance or confirmatory reproducibility.

## Actual configured generation and timeout path

A subsequent non-empirical check used `--production-parameters`, with no sampling
or output-limit override: temperature 0.7, top-p 0.9, maximum 512 tokens, seed 0,
context budget 262144, and the registered 120000 ms attempt timeout. The same
fixed arithmetic prompt completed with `finish_reason: stop` in 21859 ms.

- Request hash: `0d97cf36812d05ab5b5f4479d99ebae384121e6b3d12c0315f57d06daa53ac2d`
- Response hash: `cf797208517319618056e43ab71500691164fff9bee10c7f7fbaa6ff1f2d178a`

The previous 1000 ms attempt/phase defaults were shorter than artifact inspection
alone. The provisional registry now records a 120000 ms attempt budget and a
360000 ms shared phase budget, identically across conditions. This engineering
fixture establishes an executable path, not adequate latency for every possible
world context or participant. Later treatment-blind feasibility calibration must
assess those provisional budgets; no empirical calibration occurred here.
