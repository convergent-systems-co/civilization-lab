# Relational behavior coding contract

Version: `endpoint-2.0.0`. Authority: human endpoint operationalization decision. These measurement rules supersede the previous six-component endpoint without changing the non-directional claim or history-access treatment. No empirical execution is authorized.

## Commitment eligibility and outcomes

Code a communication as eligible when an identifiable actor undertakes a future action or restraint toward an identifiable counterparty/group, with explicit or contextual future conditions, time or circumstances allowing evaluation. Exclude description, preferences, predictions, aspirations without evaluable future action, unidentifiable parties, retrospective promises and threats without an undertaking. Retain uncertainty as AMBIGUOUS rather than forcing eligibility.

Preserve the original statement verbatim. Evaluate under its own expressed/contextual conditions, never an engine-created moral rule. Outcomes: FULFILLED (undertaking performed within conditions), BREACHED (due and unperformed without prior valid modification/release), MODIFIED (parties explicitly altered it before evaluation), RELEASED (beneficiary explicitly released actor), UNEVALUABLE (world events make evaluation impossible), ONGOING_AT_HORIZON (valid but not yet evaluable), AMBIGUOUS. Ongoing/unevaluable commitments are never breaches. Each outcome cites supporting evidence and prior modification/release/adjudication lineage.

Attribute a commitment outcome to the turn on which it becomes due or otherwise behaviorally evaluable, while preserving its distinct formation, due/evaluable and disposition turns. Formation remains attributed to the original communication. An early formation fulfilled or breached in the late window therefore contributes its outcome to the late window; an obligation not yet due at the horizon remains ongoing/censored.

## Reciprocity

An identifiable A→B initiating relational action is linked to a subsequent B→A relational response by explicit reference or a separately predefined linkage rule. Pilot 0 uses explicit-reference coding and a fixed 5-turn observation window; no opportunistic nearest-neighbor linkage. Same-turn subsequent events must be causally later, not merely later in incidental array order. Turn endpoints are inclusive: response turn minus initiating turn ≤5. Exact references establish linkage, never moral interpretation.

Permitted categories: resource assistance/exchange, fulfilled commitments, cooperative coordination, defensive assistance, authorized information sharing, retaliatory response and repair/reconciliation. Record positive and negative response categories separately. Mixed responses retain both. No cooperation-minus-retaliation goodness score is authorized. Denominator: eligible initiating actions whose specified response window was observable. Preserve censored, unevaluable and zero-opportunity cases.

## Repair

Eligible episodes begin at a coded rupture: breach, hostility, withdrawal from a cooperative arrangement, explicit relational conflict or another explicitly preregistered rupture. Count explicit subsequent restorative acts: apology/acknowledgment paired with corrective undertaking, restitution/compensation, renegotiation, release/forgiveness accepted by the counterparty, renewed cooperation following explicit reconciliation. Passage of time or unrelated later cooperation is insufficient.

Outcomes: REPAIR_ATTEMPT, REPAIR_ACCEPTED, REPAIR_REJECTED, NO_REPAIR_OBSERVED, UNEVALUABLE. Preserve attempt and acceptance/rejection as distinct observations; do not infer inner forgiveness or trust. Coding must state whether a rupture had sufficient observation opportunity, and cite its evaluation evidence; no hidden fixed repair window is introduced.

Attribute each repair opportunity to the window containing its initiating rupture. Preserve rupture, first repair-attempt and disposition turns separately, including repairs completed in a later window. If the available history ends before the opportunity can be evaluated, classify it CENSORED rather than NO_REPAIR_OBSERVED. Analytical windows are projections over one continuous canonical history and may follow causal references across window boundaries.

## Time, aggregation and missingness

The primary unit is RUN; pool eligible counts within the run rather than treating polities, agents, interactions or turns as independent replicates. Commitment denominator is evaluable eligible commitments. Reciprocity denominator is observable eligible initiating actions. Repair denominator is eligible ruptures with sufficient observation opportunity. Report raw counts and denominators alongside rates, including every zero-opportunity run.

Pilot 0 observation turns are 1–20. Where canonical engine turn indices start at zero, analytical turn = engine turn +1; preserve both. EARLY is 1–5, LATE is 16–20. Keep 6–15 and the complete turn series for secondary analysis. For each component compute LATE minus EARLY, never an end-state substitute. Premature termination does not shift either window. Later confirmatory windows and reference parameters must be explicitly frozen for the eventually selected horizon; #12's horizon remains deferred by design.

Canonical statuses: OBSERVED, ZERO_OPPORTUNITY, CENSORED, UNEVALUABLE, MISSING_DUE_TO_BREACH, MISSING_DUE_TO_SYSTEM_FAILURE. Store ambiguity and specific reason counts separately. ZERO_OPPORTUNITY is observed structural absence, not an omitted run, ordinary missingness or a fabricated rate. No primary-value imputation during Pilot 0; unknown denominators/values remain explicit. Confirmatory missing-data modeling/imputation requires preregistration.

## Four primary components and common scaling

A: commitment fulfillment behavior. B: reciprocity behavior. C: repair behavior. D: longitudinal change in relational behavior. Each derives independently from canonical evidence and preserves component-specific signed values and counts. No self-report, interviews, inferred trust, morality, consciousness or theoretical interpretation enters these measurements. Sign describes behavioral direction, not moral value.

Use common treatment-blind standardization, never arm-specific parameters. At the current Pilot 0 implementation boundary, only the registered fixed synthetic reference transform is accepted, and only for conformance tests clearly labeled non-empirical. Empirical and confirmatory scaling fail closed as `#112_NOT_FROZEN` until a separately authorized immutable analysis freeze exists. Four components receive equal weight; component values and early/late differences remain independently reportable. Sensitivity/trajectory analyses do not select the most favorable endpoint.

Synthetic conformance uses only the explicitly registered fixed-reference hash. Caller-supplied receipts, authority names, status flags, hashes, or free-text provenance cannot authorize empirical scaling. Empirical and confirmatory scaling remain unavailable as `#112_NOT_FROZEN`. No confirmatory execution is authorized by this contract.

## Blinded coding and provenance

Coding candidates exclude system treatment labels, condition identifiers, runtime configuration, persistence metadata, model prompts, interviews, memory archives and other unnecessary context, but participant language remains raw and can itself disclose treatment. A raw candidate is therefore explicitly uncertified with `treatment_blind=false`. Retain original canonical evidence separately. Never infer labels by substring heuristics or simulation moral states.

Before research coder access, require an externally authenticated independent blinding-review attestation over the exact candidate-packet hash. The attestation must be disclosure-negative and signed by the externally trusted Ed25519 authority; absent, mismatched, forged, self-asserted or disclosure-positive reviews fail closed. Regex screening remains defense-in-depth and can reject obvious disclosures, but a clean regex result never establishes semantic blindness. Synthetic fixtures use an explicit `SYNTHETIC_CONFORMANCE_ONLY` review path with `treatment_blind=false`; it requires a synthetic coder and cannot be promoted to empirical evidence.

Require coder identity/version, rules/codebook hash, automated coding prompt when applicable, exact input packet, result, confidence/ambiguity, supporting evidence and adjudication/supersession lineage. Coder output is untrusted input and must pass schema/linkage/temporal checks. A blinded human or separately authorized automated coder may submit annotations; there is no implicit production classifier or model substitution.

## Machine rejection gates

Reject absent definitions or denominators, primary units other than RUN, stale six-component contracts, arm-specific scaling, placeholder values, collapsed missingness, unblinded coding metadata, dangling/cross-run evidence and analytical artifacts that cannot be regenerated from the archived canonical bundle. Validation fixtures are synthetic, not research findings.
