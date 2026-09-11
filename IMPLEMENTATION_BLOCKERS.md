# Implementation boundary record — 2026-09-10

## P0 research-semantic blockers: resolved

No HUMAN DECISION REQUIRED marker remains for Pilot 0 implementation.

### Endpoint temporal attribution — RESOLVED

The ratified rule is component-specific. Commitment formation remains at
`formation_turn`; a commitment outcome belongs to its `due_or_evaluable_turn` and
retains separate formation, due/evaluable and disposition turns. Repair
opportunities belong to `rupture_turn` and retain separate attempt and disposition
turns. Reciprocity remains attributed to its initiating action. Analytical windows
are projections over continuous canonical history, so causal links may cross window
boundaries. Insufficient follow-up is `CENSORED`, never silently converted to an
observed failure.

Authority and implementation:

- `PRIMARY_ENDPOINT.spec.json` temporal contract
- `ENDPOINT_CODEBOOK.spec.md`
- `src/analysis.js` `WINDOW_ATTRIBUTION` and `temporal_episodes`
- endpoint conformance, adversarial and clean-room regeneration tests

### Closed cyclic conquest succession — RESOLVED

All threshold-qualified members of a closed conquest cycle are eliminated
simultaneously from the immutable committed-state decision set. No cycle member
inherits another member's estate and no ID, submission order, iteration order or
arbitrary RNG chooses a successor.

- Former territory ownership becomes unclaimed. Surviving external physical
  control may remain explicit; control never silently becomes ownership.
- Population becomes unaffiliated at its physical location and remains people,
  not transferable property.
- Unit crews return to unaffiliated population; surviving equipment becomes
  inactive neutral equipment with no polity controller.
- Surviving facilities become unclaimed. Acquisition remains an explicit later
  transition.
- Physically located resources remain at their location; nonphysical polity
  balances and projects are extinguished without a beneficiary.
- Historical communication and commitment evidence remains canonical. Later
  coding applies UNEVALUABLE/censoring semantics when elimination makes an
  obligation impossible.

The reducer emits actual same-run canonical asset-transition IDs and a
`closed_conquest_cycle` summary containing cycle membership and every frozen
elimination predicate. Branch-based clean-room replay re-executes the reducer and
reproduces the estate result exactly. Two-, three-, four-member, external-controller,
facility, population, unit, resource, commitment and ordering cases are covered by
`test/conquest-cycle.test.js` and `test/world-second-review.test.js`.

## Remaining boundaries

There are no remaining P0/P1 research-semantic implementation blockers known at
this stage. Confirmatory horizon selection remains `DEFERRED_BY_DESIGN —
PILOT_0_CALIBRATION`; #112 cannot freeze until authorized empirical Pilot 0 is
complete and the horizon and confirmatory artifacts are selected by the ratified
procedure.

Empirical Pilot 0 execution and confirmatory execution remain unauthorized.
