# Pilot 0 implementation checkpoint — 2026-09-10

Status: **Pilot 0 implementation and non-empirical conformance pass complete.**
No empirical Pilot 0, parameter calibration, human research session,
confirmatory-horizon selection, #112 freeze or confirmatory execution occurred.

## Verified result

`npm run check` on Node 26.8.2:

- contract validation: PASS — 39 schema documents, 25 canonical event types;
- tests: 557 total, 557 passed, 0 failed, 0 skipped/cancelled/TODO;
- build: PASS;
- `git diff --check`: PASS;
- immutable baseline binding: annotated tag `v0.1.0-pilot0`; its target commit
  is the authoritative SHA recorded by Git and `validation/PRE_CALIBRATION_BASELINE.json`.

The suite covers the typed action catalogue and world mechanics; deterministic
simultaneous resolution and addressed RNG; independent reducer and phase-command
re-execution; immutable submissions/TurnCommitted/action lineage; external signed
archives; process and publication crash recovery; privacy purge/redaction;
projection-only participant/model/UI/accessibility surfaces; authorization-domain
separation; identity/session/retry lineage; phase-bound memory; isolated Confidant
interviews; four-block endpoint coding/derivation and clean-room regeneration;
production Hugging Face artifact/runtime locks; and human/AI typed-action parity.

The final specialist synthesis found and closed all P1 defects. Branch
replay now starts from its content-addressed inherited genesis before independently
executing later reducers; InterviewResponse evidence must bind to the completed
model invocation, exact output, snapshot and authorized projection; and RunService
returns detached world/ledger state while withholding evidence mutation/signing
authority. Further adversarial regressions enforce archive trust, recursive evidence
redaction, canonical Base64, recursive embarked-unit causality, server-owned action
identifiers, observer fail-closed refresh, treatment-blind coding attestations and
fixed conformance-only scaling. A final integrated rerun covers every correction.

The native Hugging Face adapter also passed a fixed arithmetic-only software check
using the actual registered generation configuration and timeout. A separate
one-token boundary check completed in 17054 ms.
That is not world behavior, calibration or research evidence. See
`validation/NATIVE_RUNTIME_SMOKE.md`.

## Closed research-semantic boundaries

The two former P0 boundaries are ratified and implemented. Closed conquest cycles
atomically eliminate every qualifying member without a successor and transition
each estate asset class under explicit unclaimed, unaffiliated, inactive-neutral
or extinguishment rules. Commitment outcomes use due/evaluable-turn attribution;
repair opportunities use rupture-turn attribution; both retain cross-window
causal and disposition history. `IMPLEMENTATION_BLOCKERS.md` contains the decision
record and `validation/SPECIALIST_CONFLICT_REGISTER.json` contains the synthesis.

## Acceptance status

| Gate | Status |
| --- | --- |
| Build and schema/catalogue validation | PASS |
| Implemented-path conformance suite | PASS |
| Independent reducer replay and exact state/event comparison | PASS |
| Evidence/provenance, archive, breach and redaction | PASS |
| Projection/ACL and participant authentication | PASS |
| Endpoint operationalization and clean-room derivation | PASS |
| Crash/recovery and phase orchestration | PASS |
| Full Player/Observer UI and accessibility | PASS for implemented specified paths |
| Qwen 3.5 Base Hugging Face adapter | PASS for artifact/runtime and fixed non-empirical smoke |
| World semantics for cyclic simultaneous eliminations | PASS |
| Final apparatus acceptance | PASS |

## Authorization boundary

- Pilot 0 implementation ready: **YES** for the implemented apparatus and non-empirical validation boundary.
- Empirical Pilot 0 execution authorized: **NO**.
- Confirmatory execution authorized: **NO**.

The implementation pass stops here. A separate human authorization is required
before empirical Pilot 0 execution. Confirmatory horizon selection and #112 remain
deferred until the approved Pilot 0 calibration procedure has produced its inputs.
