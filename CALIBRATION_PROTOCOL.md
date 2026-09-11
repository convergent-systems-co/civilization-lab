# Pilot 0 calibration protocol

Status: **frozen preparation; empirical calibration is not authorized.**

The authoritative machine contract is
`PILOT_0_CALIBRATION_PROTOCOL.spec.json` version
`pilot-0-calibration-1.0.0`. It is bound to the validated implementation baseline
tag `v0.1.0-pilot0` (commit
`8f06baae4cda7d6fbd9d61924b5c615f4a45ba59`). Existing world and model values
remain `PROVISIONAL`; this protocol does not promote them to calibrated values.

## Separation of phases

Phase A is world calibration. It evaluates mechanics, feasibility, dynamic range,
and opportunity to observe registered relational behaviors. It cannot calculate,
display, or select on treatment-arm differences. Every declared candidate uses the
same frozen 24-seed panel. Every accepted, rejected, failed, and incident-affected
attempt is retained.

Phase B starts only after a successful Phase A selection is frozen into a new,
versioned Pilot 0 manifest. Phase B is the exploratory Pilot 0. Parameters may not
be silently retuned while interpreting that dataset. A world-breaking defect
invalidates the affected version and requires protocol-versioned recalibration.

Pilot 0 remains capped at 20 turns. Confirmatory-horizon selection remains a later,
treatment-blind procedure and #112 remains open.

## Frozen search and stopping rules

The search begins with the registered provisional values. It then generates only
the bounded scalar, field, or group-multiplier operations declared by the protocol,
in deterministic protocol order. It applies one operation to the current incumbent
per candidate, evaluates every candidate on the complete common seed panel, and
retains every attempt. At most 512 parameter sets and 12 rounds are permitted.

A candidate is acceptable only when every frozen calibration metric is inside its
acceptance range. If several candidates pass, selection maximizes the minimum
normalized distance from pathological boundaries, then uses the frozen
treatment-neutral robustness, variance, parsimony, and hash tie-breakers. If no
candidate passes within the bound, calibration stops. Manual extension requires a
new protocol version; it is not an invitation to choose an attractive run.

## Treatment-blind selection boundary

Raw canonical evidence remains authoritative in the research archive. It may carry
treatment provenance, so the calibration selector cannot read it. A separate
authorized projection process emits only fixed metric keys, seed, parameter-set
hash, disposition, and a blinded run identifier. It omits raw evidence references,
identity, condition, history-access, endpoint, effect, significance, and arm fields.

An independent Ed25519 attestor signs the exact metric hash, seed, parameter-set
hash, raw evidence binding, disposition, and no-comparison declaration. The selector
holds only trusted public keys. Missing trust, changed metrics, forged signatures,
extra metrics, incomplete seeds, mixed parameter sets, and treatment-bearing fields
fail closed. Disclosure creates a retained `CALIBRATION_PROTOCOL_INCIDENT` and
invalidates the affected selection decision.

## Metrics and arithmetic

The protocol freezes 32 treatment-neutral metrics spanning world viability,
contact, economy, technology, population/units, conflict, information, interaction
bandwidth, computational feasibility, and relational measurement opportunity.
Each metric has a declared unit, denominator/aggregation statement, acceptance
boundary, pathology, and executable reducer (`MEAN`, `MEDIAN`, or `MAXIMUM`).

Aggregation uses signed fixed-point integers at scale 1,000,000 with round-half-even
and fail-closed overflow/precision checks. It never estimates a separate value by
treatment arm. Relational metrics count opportunities and observation density;
they are not treatment effects and do not assign moral value.

## Provenance and retention

Every later calibration attempt must satisfy
`schemas/calibration-run-manifest.schema.json` and preserve the baseline commit/tag,
specification references, parameter registry and complete parameter set, addressed
RNG seed/provenance, policy and model/runtime configuration, canonical evidence
binding, all frozen metrics, disposition, adjustment reason, protocol version, and
independent blinding attestation. `calibration/runs/` is intentionally ignored so
empirical/private artifacts cannot be accidentally committed.

## Validation and review

`npm run validate:calibration` exercises protocol completeness, registry coverage,
bounded search, fixed reducers, seed completeness, deterministic selection,
treatment/endpoint leakage rejection, signed blinding, provenance binding, and
incident handling. The specialist synthesis is recorded in
`validation/CALIBRATION_PROTOCOL_REVIEW.json`.

No command in this preparation starts world runs, model generation, calibration,
human sessions, Pilot 0 research, horizon selection, or confirmatory execution.
