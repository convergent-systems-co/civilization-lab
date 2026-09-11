# VALIDATION.spec.md

> Inherits `INVARIANTS.spec.md` and validates the contracts in `WORLD.spec.md`, `STATISTICS.spec.md`, `EVALUATION.spec.md`, `SPECIFICATION_CLOSURE.md`, and `schemas/`.

## Purpose

Pilot 0 model/runtime validation also MUST satisfy all nine gates in `MODEL_RUNTIME.spec.md`: HF-only production, explicit immutable artifact selection, provenance capture, cross-condition invariance, configuration drift rejection, projection-only context, invocation lineage, synthetic/empirical isolation and fail-closed artifact availability. Metadata probes and mocked transports are not live runtime validation. An HF token is neither logged nor evidence of model conformance.

This is a pre-implementation validation contract. It specifies deterministic, adversarial, provenance, statistical, privacy, and interpretation checks. It does not implement the engine or authorize experiment execution.

Every gate is fail-closed. A failed gate may produce remediation work and new exploratory fixtures, but downstream implementation or data collection may not proceed when the failure requires a research-relevant choice.

## Required validation gates

Endpoint v2 additionally MUST pass `test/endpoint.test.js` and `test/endpoint-adversarial.test.js`: four operationalized blocks, six missingness classes, explicit denominators, externally attested blinded research coding, entire adjudication provenance, signed reciprocity, five-turn linkage, fixed early/late windows, component-specific temporal attribution, common scaling, contiguous commit-linked coverage and clean-room regeneration. Reject duplicate opportunities, self-links, premature breaches, placeholder components, arm-specific scaling, unattested or packet-mismatched coding, forged/disclosure-positive blinding reviews, fake empirical freeze receipts and synthetic-to-empirical relabeling. See `validation/ENDPOINT_OPERATIONALIZATION.md` for ratified traceability and attribution rules.

Expanded implementation gates include `test/endpoint-second-review.test.js`,
`test/evidence-second-review.test.js`, `test/world-second-review.test.js`,
`test/turn-phases.test.js`, `test/archive-concurrency.test.js`,
`test/redaction-adversarial.test.js`, `test/execution-classification.test.js` and
`test/schema-dialect.test.js`. Require production memory-phase completion binding,
canonical session recovery, actual phase-command replay, same-turn authorized
message causality, cross-process publication/purge exclusion, and preservation of
breach dispositions in analytical artifacts. The explicit world-genesis execution
classification cannot be overridden by a caller or used to promote a synthetic
model into empirical evidence. Unknown schema constraints must fail validation,
not be silently ignored. `validation/SPECIALIST_CONFLICT_REGISTER.json` records
review coverage and unresolved dispositions; targeted test success is not full
adversarial acceptance. Synthetic arithmetic runtime checks remain non-empirical.

### V0 — Specification and manifest integrity

- Validate all governing specification hashes and the closure-register version.
- Validate every ratified decision has an authoritative specification reference.
- Reject duplicate, missing, or conflicting normative fields.
- Confirm `STATISTICS.spec.md` is included in every confirmatory freeze.

### V1 — Schema and event-catalogue completeness

- Validate commands, actions, projections, identities, sessions, invocations, RNG draws, events, metrics, organizations, exports, and freeze manifests against their versioned schemas.
- Require every research-relevant transition and evidence-producing operation to have a catalogue entry.
- Reject unknown event types or undocumented payload fields in confirmatory mode.
- Require an endpoint-to-metric-to-event-to-raw-payload traceability record.
- Require each canonical event to reference a versioned catalogue entry and payload schema; unknown research-relevant transitions fail closed.
- Reject canonical events missing catalogue version, event type/version, payload schema/version, run/turn location, causal references where applicable, or provenance.

### V2 — Projection and information-flow isolation

- Use canary facts in Observer, another polity, confidant, private channels, hidden world state, debugging data, and derived data.
- Compare participant-visible bytes, DOM, accessibility tree, autocomplete, errors, notifications, caches, replay, exports, prompts, memory, and tool results.
- Hidden mutations must not alter unauthorized projections.
- Test enumeration, yes/no, timing, metadata, repeated-query, and aggregation inference.
- Test human, AI, organization, and observer principals separately.

### V3 — Action submission and atomic commitment

- Validate actions against the actor's authorized deterministic projection.
- Invalid actions must fail deterministically without hidden-state disclosure.
- Duplicate, late, partial, retried, and reordered submissions must be idempotent or explicitly recorded as deviations.
- `TurnCommitted` must atomically identify the accepted action set, input state, configuration, RNG provenance, hashes, and lineage.
- No post-commit partial mutation is permitted.
- Validate the explicit pre-commit protocol and distinguish submission, action, accepted-action, and committed-turn identifiers.
- Verify the complete `DRAFT → SUBMITTED → VALIDATED/REJECTED → ACCEPTED → TURN_COMMITTED → RESOLVED` lifecycle; retries and supersessions retain prior identifiers.

### V4 — Deterministic world transition and replay

- Identical authoritative state, accepted actions, configuration, and RNG provenance must yield identical authoritative state and canonical event sequence.
- Permute request arrival order, actor iteration order, collection order, process restarts, and supported execution environments.
- Test simultaneous movement, transfers, construction, research, territory claims, captures, elimination, and termination.
- Test two-, three- and larger closed conquest cycles; surviving external control; unclaimed territory/facilities; unaffiliated population; neutral units; physical versus abstract resources; preserved commitments; canonical asset references; and independence from actor ID, collection order and submission order. Require independent reducer replay of the complete result.
- Replay must verify state digest, event bytes, RNG draw addresses, and all causal references.

### V5 — Fixed-point arithmetic and RNG provenance

- Validate scale, precision, rounding, overflow, underflow, and comparison semantics for each research-relevant numeric field.
- Every random draw must record run, turn, phase, subsystem, event/action, purpose, address, and seed/state provenance.
- Adding an unrelated random operation must not alter an existing addressed draw.
- Replay must detect altered draw values or missing draw records.

### V6 — Agent-condition and identity manipulation checks

- Compare treatment and invariant dimensions field by field across conditions.
- Verify neutral prompts do not instruct hypothesized behavior.
- Verify intended history/persistence is present only in the declared arm.
- Verify exact model/runtime/tool/context/computation/retry/memory/session/interface manifests.
- Verify persistent identity, incarnation/session, invocation, retry, recovery, and fork lineage are distinct.
- Verify human and AI action opportunities and projection semantics are matched or deviations are recorded.

### V7 — Memory and confidant isolation

- Exercise every memory operation, capacity boundary, retrieval, compression, eviction, deletion, and recovery case.
- No transformation may occur without deterministic output and a canonical record.
- Reconstruct exact information available before each action.
- Confidant queries must obey the same ACL as gameplay and cannot enumerate unauthorized entities.
- Interview output must not write to world, knowledge, memory, resident context, RNG, or action state.

### V8 — Canonical evidence, snapshots, and provenance

- Crash-inject before and after every world, memory, interview, snapshot, projection, model-call, archive, and `TurnCommitted` boundary.
- Preserve raw evidence and provenance independently of UI, analytics databases, and incidental logs.
- Verify content-addressed payloads, schema versions, lineage, hash chains, signatures/authority, and export manifests.
- A clean-room consumer must regenerate every derived metric, table, interval, exclusion count, and claim from exported raw evidence.
- Treat `VIOLATIONS.md` as a derivative of canonical violation events; verify content-addressed raw payload references and canonical authority are unambiguous.

### V9 — Statistical and metric validation

- Require one primary composite longitudinal relational-behavior endpoint and explicit secondary/exploratory labels.
- Validate component definitions, weights, formula, temporal aggregation, denominator, eligibility, missingness, censoring, and multiplicity before confirmation.
- Validate commitment outcome attribution by due/evaluable turn and repair opportunity attribution by rupture turn, including cross-window fulfillment, breach, modification, release, repair, censoring and early termination. Clean-room regeneration must reproduce every preserved episode turn exclusively from canonical evidence.
- Preserve run-level independence and model nested polity/agent observations; reject naive independent-observation analyses.
- Verify fork/replay branches are not counted as independent samples.
- Verify breaches, elimination, termination, ineligibility, missingness, and technical failures remain represented in the analysis population.
- Test null, equivalence, multiplicity, power, and sensitivity procedures using fixtures that preserve clustering and interference.

### V10 — Organizations and disabled-feature boundary

- Pilot 0 manifests must reject every formal organization action and expose no organization entity, organization state, prompt, permission, event, UI, metric, or system-supplied organization persistence. Ordinary emergent coalition behavior through participant actions remains permitted and must not be mislabeled as a system organization.
- Future organization schemas must cover identity, lifecycle, membership, governance, ownership/control, permissions, privacy, history, memory, communication, publication, phases, dissolution, and succession where applicable.
- Organization-enabled execution is blocked until its exact mechanics and endpoints are versioned.

### V11 — Security, breach, and safe text handling

- Treat diplomacy, memory, intelligence, model output, and user text as untrusted content unless explicitly typed otherwise.
- Test prompt injection, tool escalation, markup, external resources, identity confusables, replay abuse, cache contamination, and side-channel metadata.
- Preserve complete breached runs and classify incident scope, timing, detector, containment, disposition, and analytical eligibility.
- Never allow invalidation to delete security evidence.
- Validate machine-readable incident and run-disposition records, including analytical eligibility and evidence completeness.
- Verify trusted/untrusted context segments, rendered model I/O, tool boundaries, and prompt-injection handling are captured and policy-conformant.

### V12 — Interpretation and claim audit

- Maintain the observation → measurement → inference → interpretation → theory separation.
- Treat free-form promise coding, self-report, memory signals, and temporal relations as their declared evidence levels.
- Require an unknown/ambiguous category where intent or construct validity is unsupported.
- Reject causal language without an intervention/assignment/identification argument.
- Reject equivalence/no-effect language without margins and precision requirements.
- Scope every claim to its model, runtime, ruleset, world-seed population, horizon, and participant type.

### V13 — Replay, redaction, and historical authorization

- Evaluate replay/export access using the authorized principal and logical time, not merely current ACL state.
- Apply redaction tombstones without silently rewriting event history; verify pre-redaction digests, affected ranges, reason, authority, and downstream analytical impact.
- Reject replay or analysis that exposes redacted content or treats incomplete evidence as complete without a declared rule.
- Verify `REPLAY_INCOMPLETE_REDACTED` is never represented as exact reproducibility and that participant replay cannot use trusted-replay privileges.

### V14 — Freeze registry and parameter/endpoint closure

- Require hashes for the closure register, validation contract, event catalogue, schema registry, projection policy, redaction policy, breach disposition, coding codebook, replay contract, and parameter registry.
- Require machine-readable primary-component, interference, assignment, estimand, and run-level aggregation registries.
- Every research-relevant numeric parameter must be classified, calibrated without hypothesis-directed selection, sensitivity-tested where applicable, and frozen before confirmation.
- Reject unknown or unclassified parameters; accept `WORLD_CALIBRATION` values only with a Pilot 0 calibration record and pre-confirmatory freeze evidence.
- Validate `PRIMARY_ENDPOINT.spec.json`, `PARAMETER_REGISTRY.spec.json`, `PROJECTION_POLICY.spec.json`, and `EVENT_CATALOGUE.spec.json` against their schemas and verify every referenced event/payload schema exists in the registry.
- Reject Pilot 0 battle configurations that require active logistics/supply mechanics; use an explicit canonical disabled-supply state reference instead.
- Validate `HORIZON_POLICY.spec.json`: Pilot 0 maximum is exactly 20; confirmatory status is `DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION`; the selected post-pilot horizon is single-valued across conditions; and no prohibited outcome-directed inputs enter selection.

## Pre-Pilot calibration protocol gate

Before empirical world calibration, validate
`PILOT_0_CALIBRATION_PROTOCOL.spec.json` and both calibration schemas. Every
`WORLD_CALIBRATION` registry entry must have a bounded declared domain or an
explicit held-constant disposition while remaining `PROVISIONAL`. The complete
common seed panel, metric set, fixed-point numeric policy, aggregation reducers,
candidate-operation order, attempt/round ceilings, acceptance boundaries,
stopping rule, and treatment-neutral tie breakers are immutable within a protocol
version.

The calibration selector must fail closed on incomplete/duplicate seeds, mixed
parameter sets, undeclared or extra metrics, arm-specific fields, endpoint/effect
outputs, direct raw-evidence access, forged or missing independent blinding
attestation, out-of-grid values, silent attempt loss, manual tuning, or any attempt
to authorize empirical execution. Every disclosure is a retained protocol incident
and invalidates the affected selection decision. Calibration-only tests are
synthetic conformance evidence, never empirical calibration.

## Test artifact requirements

Each validation result must record:

- specification/contract version;
- fixture and seed identifiers;
- environment and model/runtime manifest;
- expected and observed canonical bytes/state digests;
- projection principal and logical time;
- event/lineage references;
- failure classification;
- remediation or explicit exploratory disposition.

Validation output is evidence about contract conformance. It is not itself a research result.

## Stop rule

ASTRA must stop if any gate fails because continuing would require inventing a treatment, estimand, world rule, privacy boundary, evidence interpretation, or analysis decision. The exact unresolved choice must be added to `SPECIFICATION_CLOSURE.md` as a `HUMAN DECISION REQUIRED` marker.
