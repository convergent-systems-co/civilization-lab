# CivilizationLab specification-closure register

Status: **Historical Pilot 0 closure decisions remain ratified. The Pilot 0
implementation subsequently passed its immutable 557-test baseline gate. Phase A
calibration tooling later passed an 823-test non-empirical pre-policy baseline and a
distinct 848-test post-policy gate on 2026-09-11 after the fixed policy package and
production execution adapter were implemented. Confirmatory horizon selection remains
DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION, not a new human-decision blocker.**

## Current implementation-status addendum — 2026-09-11

This register is the specification-decision record, not the current release
attestation. Its older implementation-status phrases are retained as historical
context and are superseded by `validation/IMPLEMENTATION_CHECKPOINT.md`,
`validation/PRE_CALIBRATION_BASELINE.json`, and the current
`validation/CALIBRATION_TOOLING_REVIEW.json`.

The Phase A policy-ensemble decision is ratified: initial world
calibration uses one fixed, versioned heterogeneous deterministic eight-role policy
panel, identical across vectors, seeds, and iterations, using participant-equivalent
authorized projections and no Qwen inference. The policy package, production adapter,
manifest/attestation binding, recovery, and reducer-backed coverage gate now pass the
post-policy validation in `validation/CALIBRATION_TOOLING_REVIEW.json`. No empirical
calibration, Pilot 0 research, or confirmatory execution is authorized by this addendum.

This register records the human-ratified answers applied during specification closure. It is subordinate to `INVARIANTS.spec.md` and is itself versioned with the governing specification set. Issue comments record the corresponding GitHub update. No runtime implementation or experiment is authorized by this document.

## Runtime clarification — 2026-09-10

Human-ratified: Hugging Face is the sole Pilot 0 base-model source; Ollama is excluded as dependency, source, compatibility layer or fallback. `MODEL_RUNTIME.spec.md` governs artifact/revision locks, tokenizer/runtime/generation/hardware provenance, condition equivalence, projection-only invocation lineage, synthetic isolation and fail-closed loading. `config/pilot0-model.json` explicitly identifies the existing cached selection; it remains subject to verification before empirical execution and is not a confirmatory freeze. This updates #108, #109, #66, #40, #105 and the artifact portion of #112 without changing treatment or estimand. Current implementation blockers are in `IMPLEMENTATION_BLOCKERS.md`; historical specification resolution is not implementation acceptance.

## Authority and propagation

`INVARIANTS.spec.md` remains constitutional authority. `WORLD.spec.md`, `STATISTICS.spec.md`, `EVALUATION.spec.md`, the schemas under `schemas/`, and `VALIDATION.spec.md` must agree with it. A conflict between an issue proposal and these specifications is resolved in favor of the ratified specification decision; ASTRA may not silently select between research-relevant alternatives.

The ratified decisions establish policy and contract boundaries. World-calibration values are registered as `PILOT_0_CALIBRATION_REQUIRED`; they are not human-decision blockers. The confirmatory horizon is `DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION`, with its selection procedure frozen below; it is not a specification defect or a human-decision marker.

## Ratified decisions applied

| Issue | Applied contract | Primary specifications | Closure state |
| --- | --- | --- | --- |
| #107 | Narrow non-directional causal claim; direct behavior primary; relational constructs operationalized; no moral/consciousness claims from a positive result. | INVARIANTS, STATISTICS, EVALUATION | Resolved; identity is stable and history continuity is the treatment. |
| #6 | Run is primary unit under interaction; polity/agent observations are nested; interference-aware analysis required. | STATISTICS, EVALUATION, schemas/interference-design.schema.json, PRIMARY_ENDPOINT.spec.json | Resolved; confirmatory manifests cannot treat nested observations as independent replicates. |
| #108 | Versioned agent-condition contract; only declared treatment dimensions may differ; deviations recorded. | INVARIANTS, WORLD, EVALUATION, schemas | Resolved; experimental identity is invariant and history access is treatment-controlled. |
| #7 | Deterministic state and canonical-event sequence from identical state, actions, configuration, and RNG provenance; same-turn conflicts resolve from one immutable pre-resolution state as a simultaneous conflict set. | INVARIANTS, WORLD, VALIDATION, schemas | Resolved; contested consequences, battle evidence, and closed-cycle no-successor estate transitions are explicit and replay-tested. |
| #55 | Versioned lossless canonical events; raw evidence/provenance authoritative; analytics/UI are derivatives. | INVARIANTS, EVALUATION, EVENT_CATALOGUE.spec.json, schemas | Resolved at specification level; executable catalogue and provenance validators remain implementation work. |
| #3 | Deny-by-default deterministic projections for every participant-facing principal and surface. | INVARIANTS, WORLD, EVALUATION, VALIDATION, PROJECTION_POLICY.spec.json | Resolved at specification level; executable non-interference tests remain implementation work. |
| #112 | Complete statistical/analysis plan is immutable; post-freeze change creates a new version or exploratory status. | STATISTICS, EVALUATION, schemas | Resolved at specification level; confirmatory horizon remains deferred under #12. |
| #109 | Persistent identity, incarnation/session, and model invocation are distinct; recovery/fork/retry lineage is explicit. | INVARIANTS, WORLD, schemas | Resolved; identity, session, invocation, and history-treatment lineage are explicit. |
| #110 | Formal organization mechanics are absent from Pilot 0, while emergent cooperation and coalition behavior through ordinary participant mechanics remain allowed. | WORLD, STATISTICS, EVALUATION, VALIDATION | Resolved. |
| #111 | Future organizations are first-class persistent entities with explicit lifecycle, governance, privacy, memory, communication, publication, turns, and dissolution. | WORLD, schemas, VALIDATION | Structural contract added; exact future mechanics deferred. |
| #56 | Versioned specialist conflict register with decision provenance; unresolved research conflicts remain blocking. | INVARIANTS, STATISTICS, validation/SPECIALIST_CONFLICT_REGISTER.json | Historical specification conflicts are resolved; later implementation and calibration reviews have separate versioned validation records. |
| #4 | Human-ratified endpoint v2: four equal-weight standardized blocks, commitment fulfillment, signed reciprocity channels, repair, and signed early/late change. Six missingness statuses, five-turn reciprocity, blinded coding and canonical regeneration. | STATISTICS, ENDPOINT_CODEBOOK, PRIMARY_ENDPOINT.spec.json, schemas, src/coding.js, src/analysis.js | Resolved; commitment outcomes use due/evaluable turns, repair opportunities use rupture turns, and cross-window episode fields regenerate from canonical evidence. |
| #5 | Neutral prompts; persistence manipulation check; no instruction toward cooperation, trust, morality, or relational effects. | INVARIANTS, WORLD, STATISTICS, VALIDATION | Propagated; fixtures specified. |
| #11 | Preserve free-form promises verbatim; blinded preregistered coding for formation, fulfillment, breach, modification, release, ambiguity. | WORLD, STATISTICS, EVALUATION | Propagated; codebook contents remain required. |
| #12 | Treatment-neutral preregistered fixed/world-terminal termination only; no evidence-driven stopping. | INVARIANTS, WORLD, STATISTICS, HORIZON_POLICY.spec.json | Resolved by design; Pilot 0 is 20 turns and the confirmatory numeric value is deferred to pooled calibration evidence. |
| #14 | Resident interviews/self-reports are qualitative, preserved verbatim, and excluded from primary causal evidence. | INVARIANTS, STATISTICS, EVALUATION | Propagated. |
| #51 | Breached runs are preserved with complete provenance; inclusion/exclusion is preregistered; security remains analyzable. | INVARIANTS, STATISTICS, EVALUATION | Propagated; the later validated Pilot 0 baseline includes breach classification and preservation conformance. |
| #64 | Forks/replays are not independent samples; branch inference requires a separate preregistered design. | INVARIANTS, STATISTICS, EVALUATION | Propagated. |
| #53 | Every metric declares grain, denominator, eligibility; nested observations are not independent; UI and research share definitions. | STATISTICS, EVALUATION, schemas | Propagated; metric registry population required. |
| #62 | Longitudinal termination, censoring, missingness, ineligibility, and elimination remain explicit in denominators. | STATISTICS, EVALUATION, schemas | Propagated. |
| #63 | Derived data inherits strongest source ACL; minimum aggregation/disclosure thresholds required. | INVARIANTS, STATISTICS, EVALUATION, VALIDATION | Propagated; threshold values remain study-specific. |
| #8 | Canonical versioned action API; projection-scoped validation; atomic immutable accepted submission; deterministic nondisclosing invalidation. | INVARIANTS, WORLD, schemas, VALIDATION | Resolved; lifecycle and retry lineage are explicit. |
| #9 | Memory is explicit experimental resource; no silent transform; deterministic recorded operations and exact availability evidence. | INVARIANTS, WORLD, STATISTICS, schemas, VALIDATION | Propagated; capacities/eviction policy remain study-specific. |
| #10 | Territory ownership/control are explicit state; transitions are canonical; simultaneous claims use #7; unresolved equal claims enter explicit `CONTESTED` state without arbitrary ownership. | WORLD, EVALUATION, schemas, VALIDATION | Resolved; treatment-neutral contested consequences and cyclic-estate unclaiming preserve separate surviving external control. |
| #13 | Confidant uses the same projection/ACL boundary; unauthorized polity existence cannot be inferred through any query channel. | INVARIANTS, WORLD, EVALUATION, VALIDATION | Propagated. |
| #50 | Addressable deterministic RNG with recorded run/turn/phase/subsystem/event/purpose/address/seed provenance; no incidental-order dependence. | INVARIANTS, WORLD, schemas, VALIDATION | Resolved at specification level; address derivation is explicit and replay tests remain implementation work. |
| #52 | All player/browser/accessibility/debug surfaces consume only authorized projections; hidden state is never transmitted. | INVARIANTS, WORLD, EVALUATION, VALIDATION | Propagated. |
| #54 | Explicit immutable `TurnCommitted` boundary fixes accepted actions, input state, configuration, RNG provenance, and hashes before resolution. | INVARIANTS, WORLD, schemas, VALIDATION | Resolved; lifecycle and identifier connectivity are explicit. |
| #57 | Globally unique immutable `run_id`; forks/replays have distinct IDs and explicit parent lineage; evidence is never merged implicitly. | INVARIANTS, STATISTICS, schemas | Propagated. |
| #58 | Versioned mandatory event catalogue covers every research-relevant transition/evidence operation; unknown transitions fail validation. | INVARIANTS, EVALUATION, EVENT_CATALOGUE.spec.json, schemas, VALIDATION | Resolved at specification level; executable event registration remains implementation work. |
| #59 | Fixed/integer arithmetic and canonical collection ordering for research-relevant calculations; exact scale/rounding/overflow required. | INVARIANTS, WORLD, VALIDATION | Propagated; numeric scale remains ruleset-specific. |
| #60 | Population/citizen/labor/unit concepts are distinct; all conversion/lifecycle transitions are explicit and canonical. | WORLD, STATISTICS, EVALUATION, schemas, VALIDATION | Resolved; coefficients are `WORLD_CALIBRATION` and Pilot 0 calibration items. |
| #61 | Battle is an explicit deterministic function with recorded inputs, modifiers, addressed RNG, and no treatment-specific logic. | WORLD, EVALUATION, schemas, VALIDATION | Resolved; coefficients are `WORLD_CALIBRATION` and Pilot 0 calibration items. |
| #65 | Immutable research evidence is separated from consent/privacy; redaction uses auditable tombstones and records evidentiary impact. | INVARIANTS, STATISTICS, EVALUATION, schemas | Resolved; incomplete replay status and authorization domains are explicit. |

## Resolved marker audit history

The former markers below are retained as audit history only. The authoritative decisions above supersede them; they are not active blockers.

### RESOLVED — endpoint definition

Issue/specification: #4 / `STATISTICS.spec.md`

Unresolved decision: Which preregistered primitive relational-behavior components, standardization reference procedure, temporal functional, denominator, and exact composite formula form the single primary endpoint?

Why this cannot be inferred from ratified decisions: The decision fixes equal weighting after standardization but intentionally leaves the component registry and reference procedure to be frozen before confirmation. Choosing them changes the primary estimand.

Material alternatives: Different preregistered component sets, reference distributions, temporal functionals, and denominator policies.

ASTRA's recommended choice: Use a transparent preregistered composite of mechanically observed relational actions and commitment outcomes, standardized against a pre-confirmatory reference procedure and equally weighted without interpreting higher values as morally better.

HUMAN RESPONSE:

### RESOLVED — Pilot 0 organization boundary

Issue/specification: #110 / `WORLD.spec.md`, `STATISTICS.spec.md`

Unresolved decision: Does “no latent organization behavior” prohibit only organization primitives/entities, or also emergent informal coalitions and multi-polity coordination through ordinary diplomacy during Pilot 0?

Why this cannot be inferred from ratified decisions: The ratification excludes organization state, APIs, prompts, permissions, events, UI, and latent organization behavior, but the primary relational endpoint still observes ordinary interactions. The boundary changes the Pilot 0 environment and estimand.

Material alternatives: permit emergent coordination while disabling all organization primitives; prohibit all coalition-like coordination; or permit it but classify it as exploratory and exclude organization interpretation.

ASTRA's recommended choice: Permit ordinary emergent diplomacy but disable all organization primitives and organization-derived labels/endpoints in Pilot 0.

Consequence of each alternative: The alternatives change available interaction opportunities and whether observed coordination is part of the declared relational-behavior construct.

HUMAN RESPONSE:

### RESOLVED — contested territory and conflict consequences

Issue/specification: #7 and #10 / `WORLD.spec.md`

Unresolved decision: Exact reservation, occupation, transfer, contested-state consequences, and action-family transition rules after the simultaneous conflict set is constructed.

Why this cannot be inferred from ratified decisions: The human decision resolves same-turn precedence and equal-claim ownership policy, but does not define every downstream consequence of remaining in `CONTESTED` state or every action-family transition.

Material alternatives: Different explicit contested-state action restrictions, duration, resource/control consequences, and later-resolution rules.

ASTRA's recommended choice: Use explicit state transitions and golden fixtures; keep unresolved contested consequences out of Pilot 0 if they are not required by its declared outcomes.

HUMAN RESPONSE:

### RESOLVED — Pilot 0 termination boundary

Issue/specification: #12 / `WORLD.spec.md` and `STATISTICS.spec.md`

Unresolved decision: Exact fixed horizon and objectively defined world-terminal predicates for each study version.

Why this cannot be inferred from ratified decisions: Treatment neutrality excludes outcome-driven stopping but does not select the horizon or terminal definitions.

Material alternatives: Fixed maximum turns only; fixed maximum turns plus elimination; or fixed maximum turns plus mechanical state predicates.

ASTRA's recommended choice: Use a fixed maximum horizon plus preregistered mechanical terminal predicates that do not consume coded interpretations or analysis outputs.

HUMAN RESPONSE:

### RESOLVED — population/unit and battle semantics

Issue/specification: #60 and #61 / `WORLD.spec.md`

Unresolved decision: Exact population/unit conversion and battle-resolution functions, including numeric configuration, modifiers, and casualty/retreat outcomes.

Why this cannot be inferred from ratified decisions: The decisions define the required concepts and determinism but not the world mechanics that determine conflict, survival, and production outcomes.

Material alternatives: A minimal pilot unit model; a full first-class combined-arms model; or a deliberately noncombat Pilot 0 slice.

ASTRA's recommended choice: Choose the smallest complete model that exercises the declared Pilot 0 outcomes, then lock all values in a versioned ruleset rather than tuning toward a result.

HUMAN RESPONSE:

### RESOLVED — identity treatment

Issue/specification: #107 and #109 / `INVARIANTS.spec.md`, `STATISTICS.spec.md`, `schemas/agent-condition.schema.json`

Unresolved decision: Is `persistent_identity_id` held constant across conditions, or is identity persistence itself part of the treatment?

Why this cannot be inferred from ratified decisions: The primary claim names persistence of identity and relational history, while the condition contract separately varies session, memory, and invocation behavior. Each choice defines a different causal estimand and accountability model.

Material alternatives: hold persistent polity identity constant and manipulate experiential/relational history; add identity persistence as a separate factorial treatment; or reset identity in the nonpersistent arm as a bundled treatment.

ASTRA's recommended choice: Hold persistent polity identity constant and narrow the operational claim to experiential/relational-history persistence unless a separately specified factorial treatment is approved.

Consequence of each alternative: The alternatives change identity continuity, memory ownership, accountability, relational continuity, and the causal interpretation of the primary contrast.

HUMAN RESPONSE:

### RESOLVED — replay and redaction

Issue/specification: #65 / `EVALUATION.spec.md`, `schemas/redaction-tombstone.schema.json`, replay/export contracts

Unresolved decision: What may an authorized replay display after redaction, and how are affected analyses classified?

Why this cannot be inferred from ratified decisions: The ratified decision requires both immutable evidence discipline and legally/ethically required deletion, but it does not select the historical ACL or determine whether redacted evidence remains usable for each analysis.

Material alternatives: participant-safe replay with redacted fields; sealed privileged research replay; or invalidation of analyses that require redacted evidence, with a new experiment version where applicable.

ASTRA's recommended choice: Apply the authorized principal's historical ACL at each logical time, expose redacted placeholders rather than deleted content, permit sealed access only under explicit authority, and classify any affected confirmatory analysis as incomplete unless its preregistered evidence sufficiency rule still holds.

Consequence of each alternative: The alternatives change privacy exposure, replay reproducibility, export contents, evidentiary completeness, and whether prior confirmatory claims remain valid.

HUMAN RESPONSE:

### RESOLVED — pre-commit lifecycle

Issue/specification: #8 and #54 / `WORLD.spec.md`, action, commit, and conflict schemas

Unresolved decision: What exactly becomes immutable at `TurnCommitted`, and how do pre-commit edits, rejected actions, retries, and late submissions relate to the committed action set?

Why this cannot be inferred from ratified decisions: The ratification requires explicit submission/edit rules but does not select whether validation precedes commitment or whether a two-phase submission/acceptance protocol is used.

Material alternatives: commit candidate submissions then validate; validate first then commit only accepted actions; or use two immutable phases distinguishing submission, accepted action, and committed turn.

ASTRA's recommended choice: Use the two-phase protocol with distinct `submission_id`, `action_id`, `accepted_action_id`, and `turn_committed_id` records.

Consequence of each alternative: They change invalid-action opportunity, retry behavior, evidence completeness, and the treatment actually received.

HUMAN RESPONSE:

## DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION

Issue/specification: #12 / `WORLD.spec.md`, `STATISTICS.spec.md`

Deferred value: Select the later confirmatory fixed horizon and final objective world-terminal predicate set after Pilot 0 calibration evidence exists. The machine-readable contract is `HORIZON_POLICY.spec.json`.

Why this is deferred by design: The authoritative decision explicitly defers the confirmatory horizon until measurement adequacy, variance, attrition, computational feasibility, and game-dynamics evidence are available.

Restriction: Pilot 0 is fixed at 20 turns maximum. Confirmatory selection may not use treatment-effect direction, significance, apparent convergence, or researcher preference.

Selection procedure: Choose the shortest horizon shared by all treatment conditions that satisfies the pooled, treatment-neutral criteria: repeated-interaction opportunity; contact frequency; commitment lifecycle opportunity; post-initialization dynamics; attrition/elimination; longitudinal observation density; and computational feasibility. Record the evidence and rule application in the confirmatory freeze. Do not use treatment direction, effect size, significance, theory support, arm-specific optimization, or researcher judgment.

## PILOT_0_CALIBRATION_REQUIRED

Combat coefficients, recruitment ratios, casualty functions, resource production, technology costs/probabilities, detection/intelligence parameters, memory capacities, and other `WORLD_CALIBRATION` values are calibration items, not human-decision blockers. They require Pilot 0 calibration records, sensitivity checks, and freeze before confirmatory execution. They may not be selected for persistence-result direction.

## Closure rule

Pilot 0 specification closure is reached: its manifest, 20-turn boundary, endpoint,
identity, action lifecycle, conflict, evidence, ACL, parameter, event-catalogue, and
validation contracts are defined. The original closure snapshot predated implementation;
its statements that conformance, replay, security, provenance, and adversarial acceptance
were still outstanding were superseded by the validated 557-test Pilot 0 baseline.

The historical 823/823 result recorded on 2026-09-11 remains the non-empirical
**pre-policy** Phase A tooling baseline. The distinct 848/848 post-policy result satisfies
the policy-package and production-adapter implementation gates, but does not freeze
calibration values or authorize calibration. Confirmatory
horizon selection remains deferred by design until Pilot 0 evidence; #112 remains blocked
until that procedure is applied and all confirmatory artifacts are frozen and validated.
Historical issue counts in earlier snapshots are not current tracker status.
