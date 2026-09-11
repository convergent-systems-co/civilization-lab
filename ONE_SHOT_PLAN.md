# CivilizationLab one-shot readiness and execution plan

Status: **BUILD + NON-EMPIRICAL VALIDATION complete. Pilot 0 implementation conformance passes; empirical Pilot 0 and confirmatory execution are not authorized.**

This plan does not itself grant execution authority. The human separately
authorized implementation and non-empirical validation. ASTRA must stop each
affected dependency chain whenever continuing requires an unspecified
research-relevant decision. See `IMPLEMENTATION_BLOCKERS.md` for cyclic-conquest
succession and explicit endpoint temporal attribution. The original endpoint
operationalization blocker is resolved by the subsequent human four-component
definitions; it is not reopened.

## Current runtime implementation amendment — 2026-09-10

The user separately authorized BUILD + NON-EMPIRICAL VALIDATION. Use `MODEL_RUNTIME.spec.md`: implement the production adapter using the explicitly configured and provenance-locked Qwen 3.5 Base artifact sourced from Hugging Face. Ollama is not part of Pilot 0. Resolve configuration → verify HF revision/artifact/tokenizer/runtime lock → validate condition equivalence → projection/memory/lineage capture → deterministic transport/adversarial tests → actual runtime conformance checks. Never silently substitute models, revisions, quantization or backends. Test doubles are synthetic only. Before empirical execution, stop for complete apparatus validation, verified model configuration and separate human execution authority. The endpoint operational-definition blocker in `IMPLEMENTATION_BLOCKERS.md` stops its dependent analysis chain; it does not reopen ratified principles. Historical readiness tables below predate this implementation checkpoint and are not proof of current acceptance.

## Historical pre-implementation decision

The repository is not currently ready for a one-shot build/test/research workflow. It is sufficiently specified to implement Pilot 0 under the validation gates below, but not to execute a confirmatory study.

Classification: **C. ITERATIVE EXECUTION REQUIRED**

The specifications provide a strong intended architecture and a useful constitutional direction, but they do not yet provide the executable contracts, frozen research design, schemas, tests, or analysis plan required for a defensible one-shot result. This is not a claim that the project is impossible. It is a finding that the project must pass staged specification, implementation, validation, and exploratory-pilot gates before any confirmatory claim is possible.

## Repository evidence

- Governing documents: `INVARIANTS.spec.md`, `WORLD.spec.md`, `STATISTICS.spec.md`, and `EVALUATION.spec.md`.
- Orientation: `README.md`.
- No implementation modules, schemas, prompt specifications, feature specifications, test suites, analysis code, or architecture package are present in the tracked repository.
- Human-ratified policy decisions have been propagated into the governing specifications, `SPECIFICATION_CLOSURE.md`, `VALIDATION.spec.md`, and structural schemas under `schemas/`.
- The confirmatory horizon is intentionally `DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION`; its selection procedure is frozen in `HORIZON_POLICY.spec.json`. World-calibration values remain staged Pilot 0 work and must not be chosen using treatment outcomes.
- The current GitHub issue tree contains 114 open issues, including unresolved P0/P1 implementation and validation work on experimental design, simulation semantics, agent contracts, UI isolation, instrumentation, data provenance, and aggregation. Post-ratification specification blockers #115–#119 are resolved and closed; their implementation acceptance criteria remain represented in the parent work.
- `WORLD.spec.md` and `STATISTICS.spec.md` explicitly define Pilot 0 as exploratory and require later freezing for confirmatory work.

## Dependency map

```text
research question / theory
        ↓
operational constructs, hypotheses, estimands, endpoint registry
        ↓
INVARIANTS ───────────────┐
        ↓                 │
WORLD + agent contract + organization scope + interaction rules
        ↓                 │
action / projection / ACL / memory / replay contracts
        ↓                 │
canonical event + provenance + snapshot + export schemas
        ↓                 │
statistical analysis plan + power/simulation + aggregation registry
        ↓                 │
implementation and UI read models
        ↓                 │
deterministic, security, provenance, UI, and statistical validation
        ↓                 │
independent adversarial review and sign-off
        ↓                 │
exploratory Pilot 0 ──────┘
        ↓
frozen confirmatory protocol → confirmatory runs → analysis → interpretation
```

`INVARIANTS` is authoritative over the other specifications. `WORLD` is the execution substrate. Agent, organization, and UI contracts must consume world projections rather than inventing alternate semantics. Instrumentation must be designed before implementation because `STATISTICS` and `EVALUATION` both require canonical-event-only analysis. Statistical analysis cannot be frozen until the world, agent, treatment, event, and validity contracts are frozen.

## Readiness review coverage

The requested specialist domains were reviewed explicitly against the four specs, README, repository inventory, and issue tree. Completed delegated reports covered all ten requested domains: experimental design, statistics, simulation/world design, agent architecture, organizations, UI/UX, instrumentation/observability, data provenance/reproducibility, security/adversarial behavior, and research interpretation. All reports are specification-level reviews: no implementation or experiment was executed.

| Domain | Readiness | Main stop condition |
| --- | --- | --- |
| Experimental design | Blocked | No complete research-question, treatment, interference, allocation, or estimand registry. |
| Statistics | Blocked | No primary endpoint/estimand, power design, multiplicity plan, missingness policy, or validated preregistration manifest. |
| Simulation/world | Blocked | Action schemas, conflict order, RNG addressing, resource timing, and many state transitions are unspecified. |
| Agent architecture | Blocked | Prompt, model artifact, context, tool, memory, persistence, and parity contracts are absent. |
| Organizations | Deferred/blocked for organization claims | Organizations are architected but disabled for Pilot 0; no executable semantics exist for organization research. |
| UI/UX | Blocked | No UI implementation or projection-safe interaction/accessibility contract; player and Observer leakage paths remain. |
| Instrumentation/observability | Blocked | Event catalogue, evidence completeness, model I/O, intervention, and projection contracts are absent. |
| Data provenance/reproducibility | Blocked | Canonical bytes, schema evolution, snapshots, lineage, signatures, environment capture, and independent replay are undefined. |
| Security/adversarial behavior | Blocked | Threat model, capability boundary, breach classifier, ACL/key model, and non-interference tests are undefined. |
| Research interpretation | Blocked | Level-2 coding, null/equivalence interpretation, endpoint traceability, and claim boundaries are not frozen. |

## Cross-spec contradiction matrix

| Area | Specification A | Specification B | Consequence | Required resolution |
| --- | --- | --- | --- | --- |
| Interviews and resident context | `INVARIANTS` requires interviews to be non-causal and never write back. | `INVARIANTS`/`WORLD` allow resident persistent sessions and post-turn interviews. | A resident context can retain the interview despite nominal non-causality. | Use an ephemeral isolated interview context or make interview exposure an explicit treatment; test context hashes before/after. |
| Evaluation termination | `EVALUATION` says evaluation must not influence WORLD execution. | `STATISTICS`/`WORLD` allow research-selected hidden termination regimes. | Analysis can become a causal intervention unless termination is a frozen world controller. | Define a pre-run, pure termination controller evaluated at a fixed phase; analysis remains read-only. |
| Free-form promises | `WORLD` makes diplomacy free-form, non-atomic, and non-enforced. | `EVALUATION` treats statement/action correspondence as Level 1 deterministic evidence; `STATISTICS` lists commitment fulfillment. | Interpretation can be mistaken for raw mechanical evidence. | Restrict Level 1 to typed commitments/actions; move prose coding to versioned Level 2 with blinding and reliability. |
| Treatment unit | `STATISTICS` names a run as the independent unit. | `STATISTICS` also supports mixed polity-level persistence/model treatments. | A treated polity changes other polities’ outcomes; own treatment and spillover are confounded. | Freeze whole-run policy effects or preregister a supported interference/saturation design with direct, spillover, total, and overall estimands. |
| Canonical evidence | `INVARIANTS` requires one canonical append-only stream. | `WORLD`/`EVALUATION` separately require memory archives, violations, interviews, snapshots, and exports. | Crash or projection lag can lose or duplicate research evidence. | Make raw evidence canonical or define transactional outboxes, source links, offsets, and deterministic regeneration. |
| Knowledge visibility | `WORLD` promises accurate own state and undisclosed foreign changes/stale knowledge. | `EVALUATION` requires dashboards, replay, map, and Observer truth modes. | Live truth queries or aggregate dashboards can silently reveal hidden changes. | Use immutable epistemic claims and audience-scoped projections; add non-interference tests. |
| Human/AI parity | `INVARIANTS` requires identical information/action semantics. | `WORLD` permits different profiles and wall-clock budgets; UI can preflight more than an AI adapter. | Interface and latency become unrecorded treatments. | Share projection-scoped validation/action contracts and record equivalent deadline/exposure events. |
| Pilot scope | `WORLD` disables logistics and organizations for Pilot 0. | `WORLD` acceptance asks for a broad compelling strategy game and `STATISTICS` asks to tune many mechanics. | Pilot scope can expand silently and consume pilot data as if it tested future mechanics. | Define a narrow Pilot 0 vertical slice and explicitly classify disabled systems as non-evaluable. |
| Analysis inputs | `EVALUATION` asks for many dashboards/views and `STATISTICS` asks for canonical-event-only analysis. | No producer/schema is defined for several views and metrics. | Researchers may recompute or invent data in the UI. | Create endpoint-to-event and view-to-schema traceability matrices; forbid UI recomputation. |

## Prioritized pre-mortem

Assume six months after execution the results are unusable. The most plausible causes are:

### P0 — The experiment has no uniquely defined causal question

The specs describe a theory and many candidate treatment dimensions/outcome families but do not freeze hypotheses, primary estimands, allocation, exposure, or a confirmatory endpoint registry. ASTRA would have to choose what “effect of persistence” or “reliability” means.

### P0 — Treatment and spillover are inseparable

Mixed polities interact, alter each other’s world, and can eliminate each other. A run-level random effect does not identify an own-treatment effect. Forks and survivor-only analysis create additional history-conditioned estimands.

### P0 — The simulation is not deterministic enough to support replay or comparison

Action conflict order, resource reservation, phase deadlines, RNG draw addressing, project lifecycles, and crash boundaries are not executable contracts. Two implementations can satisfy the prose and produce different worlds.

### P0 — The participant sees information the protocol says is hidden

Observer/player caches, global aggregates, validation errors, stale reports, DOM/accessibility surfaces, replay bundles, and private event metadata are not all covered by a single deny-by-default projection contract.

### P0 — Evidence cannot explain surprising behavior

The event envelope is not a complete catalogue/schema; prompts, model inputs/outputs, tools, retries, context state, intervention state, and derived-value provenance are not fully specified. A surprising result could not be causally reconstructed.

### P1 — Security outcomes disappear when runs are invalidated

Stopping a breached run is appropriate, but excluding the run from the security denominator can hide treatment-induced breaches and manufacture apparent safety.

### P1 — UI and timing become unrecorded treatments

Human players may receive richer preflight feedback, longer usable interaction time, scrollback, or different validation behavior than AI players.

### P1 — Aggregation changes the result

Undefined table grain, fan-out joins, active-polity denominators, copied technology, delegated assets, and invalid-run inclusion can reverse comparisons while every dashboard appears internally plausible.

### P2 — Organizations are implemented as normative social machinery

Organizations are disabled for Pilot 0, but later organization claims cannot be made without independent mechanics, privacy, governance, compliance, and asset-ownership contracts.

### P2 — “Compelling and polished” is accepted by taste

The UI/game acceptance language has insufficient task, accessibility, performance, map viability, and balance oracles. A visually impressive interface can still be a confounded experimental instrument.

## Conditional execution order and gates

Each stage is a hard dependency. “Stop” means ASTRA may not continue to downstream implementation or collection. A failed gate may continue only to remediation work, never to experimental execution.

### 0. Repository and change-control lock

- **Prerequisites:** none.
- **Inputs:** all specs, README, issue tree, repository inventory.
- **Outputs:** versioned inventory, ownership matrix, issue-to-spec map, change-control record.
- **Gate:** every normative source is enumerated; no unknown prompt/schema/test source exists.
- **Stop:** any new governing document appears after the lock or spec versions are mutable.

### 1. Research question and construct freeze

- **Prerequisites:** stage 0.
- **Inputs:** theory, falsification requirements, candidate treatment dimensions.
- **Outputs:** research questions, directional and null hypotheses, construct definitions, primary/secondary estimands, causal diagrams, interference assumptions, claim boundaries.
- **Ratified constraint:** the primary claim is non-directional and the primary confirmatory endpoint is one equal-weight standardized composite of preregistered longitudinal relational-behavior components; individual components and alternative weighting are sensitivity analyses.
- **Gate:** a reviewer can determine the intended causal comparison without consulting ASTRA’s judgment.
- **Stop:** “persistence,” “reliability,” “prosperity,” “cooperation,” or equivalent constructs remain only prose or multiple incompatible estimands remain active.

### 2. Experimental design and analysis-plan freeze

- **Prerequisites:** stage 1.
- **Inputs:** estimands and causal diagrams.
- **Outputs:** treatment/condition schema, allocation/randomization, seed/position/model sampling plan, run-level unit, interference design, endpoint registry, missingness/exclusion/censoring rules, multiplicity, alpha, effect thresholds, power/simulation plan, stopping rules, codebook and equivalence rules.
- **Ratified constraint:** interacting runs use the run as the primary unit; nested polity/agent observations require interference-aware analysis; breached runs remain preserved evidence; forks/replays are not independent samples.
- **Gate:** a preregistration validator rejects incomplete or internally inconsistent manifests.
- **Stop:** sample size, primary endpoint, treatment contrast, interference estimand, or analysis population can still be selected after observing data.

### 3. World, agent, organization, and interaction contract freeze

- **Prerequisites:** stages 1–2.
- **Inputs:** frozen estimands and treatment schema.
- **Outputs:** versioned world rules, action schemas, simultaneous conflict-set contract, logical clock, RNG addresses, resource ledger, generator predicates, agent prompt/model/context/tool/memory contracts, human/AI parity contract, and explicit organization scope (disabled or fully specified).
- **Gate:** all outcome-affecting mechanics are decidable from schemas and pure functions.
- **Stop:** ASTRA must choose action precedence, resource timing, model artifact, prompt contents, context retention, organization semantics, or termination behavior.

### 4. Projection, security, and UI contract freeze

- **Prerequisites:** stages 2–3.
- **Inputs:** principals, action/world contracts, knowledge model.
- **Outputs:** epistemic-claim schema, ACL/capability/key model, participant/Observer projections, sanitized errors, replay audiences, UI state/interaction contract, accessibility and human/AI parity requirements.
- **Gate:** canary and non-interference fixtures show that inaccessible truth cannot affect participant-visible bytes, controls, DOM, accessibility tree, timing envelope, or exports.
- **Stop:** any player route, cache, aggregate, tooltip, validation path, or replay path can reveal Observer/private data.

### 5. Canonical evidence and provenance contract freeze

- **Prerequisites:** stages 2–4.
- **Inputs:** event catalogue, projections, model adapter, analysis registry.
- **Outputs:** event schemas/versions, canonical serialization, IDs, causal ordering, transaction boundaries, snapshots, lineage, hashes/signatures, model invocation events, raw/projection boundary, export manifests, retention/consent rules, and redaction/tombstone records.
- **Gate:** crash/replay fixtures regenerate identical raw evidence and all derived artifacts with source links.
- **Stop:** any required endpoint or claim lacks a producer event, provenance link, validity status, or reproducible derivation.

### 6. Implementation architecture and minimal vertical slice

- **Prerequisites:** stages 0–5 pass.
- **Inputs:** frozen contracts and schemas.
- **Outputs:** pure world reducers, orchestrator, adapter ports, storage, projections, UI read models, analysis readers, and a narrowly scoped Pilot 0 slice.
- **Gate:** architecture tests enforce dependency direction and no evaluation/statistics code mutates world state.
- **Stop:** implementation adds a behavior not represented in the frozen contract; return to stage 3 or 4.

### 7. Deterministic, security, provenance, and statistical validation

- **Prerequisites:** stage 6 implementation slice.
- **Inputs:** fixtures and validation oracles.
- **Outputs:** passing test evidence for permutation invariance, RNG addresses, atomic recovery, ACL isolation, human/AI parity, agent context isolation, generator viability, resource conservation, event completeness, aggregation reconciliation, and power/false-positive simulation.
- **Gate:** all P0/P1 tests pass; failures are reason-coded and reproducible.
- **Stop:** any unexplained nondeterminism, leakage, missing event, invalid join, treatment asymmetry, or statistical design failure.

### 8. Independent adversarial sign-off

- **Prerequisites:** stage 7.
- **Inputs:** implementation, tests, manifests, fixtures, issue closure evidence.
- **Outputs:** signed review reports for all ten domains, contradiction matrix disposition, residual-risk register, and go/no-go decision.
- **Gate:** no open P0/P1 issue and every research-relevant choice has an owner, version, and acceptance test.
- **Stop:** reviewers disagree on a causal or experimental interpretation, even if software tests pass.

### 9. Exploratory Pilot 0

- **Prerequisites:** stages 0–8; frozen Pilot 0 manifest.
- **Inputs:** same Qwen 3.5 Base artifact/configuration as explicitly identified, three polities, reconstructed persistence, bounded memory, 20-turn cap, fixed capitals, no prehistory, and disabled systems as declared.
- **Outputs:** complete exploratory run bundle, protocol-deviation report, leakage/security report, usability/action-comprehension report, runtime/cost report, and pilot refinement proposals.
- **Gate:** all raw evidence and deviations are present; findings remain exploratory and are not pooled into confirmatory evidence.
- **Stop:** any breach, observer contamination, irreproducible state, missing evidence, undefined endpoint, or major balance/contact failure. Remediate and rerun; do not proceed to confirmatory claims.

### 10. Confirmatory freeze and execution

- **Prerequisites:** a successful Pilot 0 remediation cycle and independent sign-off.
- **Inputs:** finalized specs including `STATISTICS`, code/analysis hashes, model/runtime artifacts, prompts, configs, endpoint registry, power simulation, and stopping rules.
- **Outputs:** immutable preregistration manifest, confirmatory run bundles, protocol deviations, analysis dataset, and blinded analysis artifacts.
- **Gate:** manifest validation, environment verification, seed/position allocation, and run admissibility all pass before collection.
- **Stop:** any unplanned amendment, invalid run without preregistered handling, missing provenance, or deviation capable of changing the estimand.

### 11. Analysis and research synthesis

- **Prerequisites:** confirmatory collection and verified analysis population.
- **Inputs:** canonical events, versioned derivations, frozen analysis plan, protocol deviations, and validity manifest.
- **Outputs:** estimates with confidence intervals, multiplicity adjustments, sensitivity analyses, exploratory/confirmatory labels, null/equivalence conclusions only where supported, and raw-evidence links.
- **Gate:** independent researcher can reproduce the analysis from the raw bundle without UI recomputation or hidden data.
- **Stop:** any result depends on a post-hoc endpoint, undocumented exclusion, unversioned derivation, or unblinded coding choice.

## Required validation suite

1. Contract/schema validation for commands, events, projections, model invocations, memory, interviews, configs, manifests, and exports.
2. Event catalogue completeness: every endpoint, dashboard value, UI view, violation, and protocol deviation has a canonical producer.
3. Arrival-order and in-memory iteration permutation tests.
4. Addressable RNG and replay verification tests.
5. Crash injection around every turn, archive, snapshot, interview, and projection boundary.
6. ACL/canary/non-interference tests across APIs, caches, WebSockets, DOM, accessibility trees, logs, exports, and replay.
7. Human/AI action, validation, deadline, timeout, and observation-parity tests.
8. Agent prompt/context/memory/tool isolation and confidant write-back tests.
9. World-generator viability, balance, contact, resource, combat, territory, economy, and termination golden fixtures.
10. Organization-disabled/enabled boundary tests and explicit no-claim behavior when disabled.
11. Aggregation grain, join-cardinality, denominator, invalid-run, ownership, technology-copy, and delegated-asset reconciliation fixtures.
12. Power/false-positive simulations that preserve run clustering, interference, censoring, stochastic seeds, and multiplicity.
13. Independent clean-room replay and analysis from exported raw evidence.
14. Accessibility, usability, and player-vs-Observer leakage tests.

## Final acceptance criteria

ASTRA may not declare this project one-shot ready until:

- all P0/P1 issues are closed or formally waived by a named research authority;
- all four specs, including `STATISTICS`, are versioned and frozen for the relevant phase;
- research questions, estimands, treatment contrasts, primary endpoints, and analysis populations are explicit;
- world, agent, organization, UI, event, projection, and export contracts are machine-readable;
- deterministic replay, provenance, ACL isolation, and aggregation reconciliation pass;
- Pilot 0 is run only as exploratory validation and its findings are not used as confirmatory evidence;
- an independent researcher can reconstruct raw evidence, derivations, and claims without ASTRA or the UI;
- final interpretation distinguishes observation, measurement, statistical inference, interpretation, and theory.
