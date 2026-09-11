# Enhanced spec — `phase-a-calibration-apparatus`

Bundle: **Implement Phase A calibration execution apparatus**
Branch: `develop/phase-a-calibration-apparatus`
Base: `origin/main`
Enhanced: 2026-09-10 (spec-enhancer, pre-planning)

---

## Original content

The bundle carries no issue text — `issues` is empty in the run's `state.json`, and the
scan recorded the work source as a human authorization rather than a tracker item. The
verbatim record the bundle was formed from is:

```json
{
  "id": "phase-a-calibration-apparatus",
  "title": "Implement Phase A calibration execution apparatus",
  "issues": [],
  "branch": "develop/phase-a-calibration-apparatus",
  "footprint": [
    "src/calibration*",
    "schemas/calibration*",
    "test/calibration*",
    "scripts/*",
    "package.json",
    "validation/*"
  ],
  "status": "pending"
}
```

```json
{"type": "SCAN_DONE", "detail": {"source": "human-authorized Phase A calibration tooling implementation", "issues": []}}
```

The substantive requirements therefore live in the repository, not in the bundle record.
The authoritative sources, in precedence order:

1. `PILOT_0_CALIBRATION_PROTOCOL.spec.json` — machine contract, `protocol_id`
   `pilot-0-calibration`, version `pilot-0-calibration-1.0.0`, status
   `FROZEN_BEFORE_EMPIRICAL_CALIBRATION`.
2. `CALIBRATION_PROTOCOL.md` — the human-readable statement of the same freeze.
3. `IMPLEMENTATION_BLOCKERS.md` — the record that no P0/P1 research-semantic blocker
   remains, and that empirical and confirmatory execution stay unauthorized.
4. `docs/PHASE_A_CALIBRATION_TOOLING.md` — the apparatus description written alongside
   the in-worktree implementation, version `phase-a-calibration-tooling-1.0.0`.

### Current state of the worktree (read this before planning)

This is **not** a greenfield bundle. The working tree already contains an unstaged,
uncommitted implementation whose file set matches the bundle footprint exactly:

| Path | State |
| --- | --- |
| `src/calibration-runner.js` | new, 751 lines |
| `scripts/calibration-cli.js` | new, 38 lines |
| `test/calibration-tooling.test.js` | new, 291 lines, 16 tests |
| `schemas/calibration-{attestation,execution-manifest,metric-artifact,result,search-state}.schema.json` | new |
| `schemas/pilot0-world-configuration.schema.json` | new |
| `validation/CALIBRATION_TOOLING_REVIEW.json` | new |
| `docs/PHASE_A_CALIBRATION_TOOLING.md` | new |
| `README.md`, `package.json`, `scripts/build.js`, `scripts/validate-contracts.js` | modified |

`npm run check` was run against this tree during enhancement and passed end to end:
contract validation clean, 586 tests passed / 0 failed / 0 skipped, build emitted `dist`.
The bundle's real remaining work is verification, gap closure against the criteria below,
and landing — not re-deriving the apparatus.

---

## Clarified acceptance criteria

Each criterion is independently checkable. Criteria marked *(clarified)* were implicit in
the frozen protocol or the tooling document and are pinned to an observable value here;
the rest were already concrete in the sources.

**Binding and versioning**

1. The runner binds implementation commit `8f06baae4cda7d6fbd9d61924b5c615f4a45ba59` and
   tag `v0.1.0-pilot0`, and protocol version `pilot-0-calibration-1.0.0`. A mismatch in
   either binding fails closed rather than proceeding. *(clarified: named the exact commit,
   tag, and version strings)*
2. `CALIBRATION_TOOLING_VERSION` is `phase-a-calibration-tooling-1.0.0` and is asserted by
   `scripts/validate-contracts.js`, so a silent version drift fails `npm run validate`.
3. The frozen specification files (`PILOT_0_CALIBRATION_PROTOCOL.spec.json`,
   `PARAMETER_REGISTRY.spec.json`, `PRIMARY_ENDPOINT.spec.json`, `HORIZON_POLICY.spec.json`,
   and the other `*.spec.*` files) are read, never edited by this bundle. *(clarified)*

**Bounded search**

4. Search is `BOUNDED_DETERMINISTIC_COORDINATE_GRID`: the registered starting parameter set
   is evaluated first, then candidates are generated in parameter-domain order, field
   insertion order, and declared value order; each candidate applies exactly one frozen
   operation to the current incumbent.
5. Hard bounds are enforced: at most **512** attempted parameter sets over at most **12**
   rounds. Exceeding either bound stops calibration; it does not widen the search.
6. A candidate becomes the next incumbent only if its protocol-ordered vector of normalized
   acceptance-bound violations is lexicographically smaller **and** no previously passing
   metric starts failing.
7. Unregistered parameters, manual value substitution, and mutation of any of the 10
   `held_constant_registry_parameters` are rejected. No hidden default parameter set exists
   in the repository.

**Seed panel and retention**

8. Every candidate is evaluated on the complete frozen 24-seed panel
   (`calibration-seed-00` … `calibration-seed-23`). A missing, duplicated, or extra seed
   fails before metrics are computed. *(clarified: named the panel identifiers and the
   fail-before-metrics ordering)*
9. Every accepted, rejected, failed, and incident-affected attempt is retained; no
   cherry-picking path exists (`ALL_SEEDS_RETAINED_AND_REPORTED`).
10. Runs are capped at **20 turns**; over-horizon canonical evidence fails before metric
    selection.

**Metrics and arithmetic**

11. All **32** frozen treatment-neutral metrics are emitted for every seed, each through its
    declared reducer (`MEAN`, `MEDIAN`, or `MAXIMUM`). A missing or extra metric key fails
    closed.
12. Aggregation uses signed fixed-point integers at scale **1,000,000** with round-half-even
    rounding and fail-closed overflow and precision checks. No floating-point value reaches a
    persisted metric. *(clarified: stated the no-float persistence consequence)*
13. No metric is ever estimated separately by treatment arm.

**Treatment-blind boundary**

14. The selector receives only the closed blinded view (`CALIBRATION_TREATMENT_BLIND_V1`):
    fixed metric keys, seed alias, opaque parameter-set hash, disposition, and blinded run
    identifier. It holds no raw-evidence reference and no evidence-loader capability.
15. All 15 `blinding.forbidden_input_fields` and all 7 `blinding.forbidden_outputs` are
    rejected on presence, including under key-normalization variants (case and separator).
    *(clarified: normalization-insensitive matching, as implemented by the forbidden-key scan)*
16. Any attempted or accidental disclosure is retained as a `CALIBRATION_PROTOCOL_INCIDENT`,
    invalidates the affected selection decision, and requires repetition from the last
    unexposed state.

**Attestation and trust**

17. An independent Ed25519 attestation signs exactly: metric hash, seed, parameter-set hash,
    raw-evidence binding, disposition, and the no-comparison declaration. Trusted public keys
    are supplied externally to the verifier; a key carried inside an archive is never its own
    authority.
18. Missing trust, forged or mutated signatures, changed metric inventory, fabricated metric
    values, baseline drift, and protocol drift each fail closed with a distinct failure class.

**Archive, recovery, and failure taxonomy**

19. Canonical evidence is content-addressed and checkpointed immutably per
    (parameter-set, seed) key; manifests are write-once. Crash recovery reads existing
    evidence and manifests before dispatching work, and a completed key is never counted or
    executed twice.
20. The failure taxonomy is closed at exactly **7** classes: `PARAMETER_FAILURE`,
    `IMPLEMENTATION_DEFECT`, `PROTOCOL_VIOLATION`, `BLINDING_BREACH`,
    `INFRASTRUCTURE_FAILURE`, `RESEARCH_DESIGN_BLOCKER`, `ACCEPTED_CONFIGURATION`.
    An implementation defect is retained distinctly from a parameter failure.
    *(clarified: the count is asserted in `scripts/validate-contracts.js`)*

**Outputs**

21. Selection maximizes the minimum normalized distance from pathological boundaries, then
    applies the four frozen tie-breakers in order: highest worst-seed metric pass fraction,
    lowest cross-seed metric variance, fewest changes from the registered starting set,
    lexicographically smallest parameter-set SHA-256. Selection is reproducible from the
    retained record.
22. A `CALIBRATION_RESULT` is emitted only when the stopping rule passes with an accepted
    candidate on the complete panel; a stopping proof cannot be emitted otherwise. The
    document validates against `schemas/calibration-result.schema.json`, whose
    `empirical_authorization` and `confirmatory_authorization` are `false` by construction.
23. The proposed world configuration validates against
    `schemas/pilot0-world-configuration.schema.json` with status constant
    `PROPOSED_NOT_RESEARCH_AUTHORIZED`. It does not promote any `PROVISIONAL` value.
24. Every persisted record validates against its schema with `additionalProperties: false`;
    unknown fields fail closed.

**Authorization**

25. `node scripts/calibration-cli.js run` fails closed with no empirical execution path
    present. `npm run calibration:plan` prints the frozen search and authorization state and
    starts no world or model execution. `npm run calibration:verify -- --archive PATH
    --public-key PATH --key-id ID` verifies an archive against externally supplied trust.
26. The execution adapter is injected by the caller. The repository contains no default
    adapter, no embedded authorization bypass, and no code path that starts world runs, model
    generation, human sessions, or confirmatory execution.
27. The deterministic synthetic fixture used by tests is software evidence only and cannot be
    promoted into an empirical archive.

**Repository integration**

28. `npm run check` (validate → test → build) passes with zero failures and zero skips.
    *(clarified: the observed baseline for this tree is 586 tests passing; the criterion is
    zero failures, and the count must match whatever the tree actually produces)*
29. Generated calibration records are written under `calibration/runs/`, which stays
    git-ignored; no generated run artifact is committed as repository source.
30. `README.md` and `docs/PHASE_A_CALIBRATION_TOOLING.md` describe the shipped commands and
    state, and the headline test count in `README.md` matches the current full-suite result
    and `validation/CALIBRATION_TOOLING_REVIEW.json`. **Known inconsistency to fix:**
    `README.md` still states "557 passed" while the tree produces 586 and the review record
    records 586. *(clarified)*
31. `validation/CALIBRATION_TOOLING_REVIEW.json` records the adversarial synthesis — five
    specialist domains (treatment leakage, search integrity, provenance and attestation,
    recovery, research validity), the test totals, and empty P0/P1 finding lists — and its
    `empirical_calibration_executed` and `empirical_calibration_authorized` flags are both
    `false`.

---

## Explicitly out of scope

- **Running empirical calibration.** `authorization.empirical_calibration` is `false` in the
  frozen protocol; this bundle builds the apparatus and must leave it unable to execute.
- **Phase B / Pilot 0 research execution**, model inference runs, and human sessions.
- **Confirmatory horizon selection.** It stays `DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION`;
  issue #112 remains open and is not closed or advanced here.
- **Promoting any `PROVISIONAL` world or model value to a calibrated value.**
- **Any treatment-arm comparison, effect estimate, endpoint-by-arm figure, or significance
  computation**, in code, tests, docs, or output schemas.
- **Amending the frozen protocol or any `*.spec.*` file.** A change there requires a new
  protocol version, which is a separate, human-authorized act.
- **Extending the search bounds** (512 parameter sets, 12 rounds) or the 24-seed panel.
- **UI work** under `ui/`, and any change to the existing world/analysis engine beyond what
  the calibration apparatus imports.
- **Merging to `main`.** The run's merge policy is `never`; this bundle ends at a pull
  request.

---

## Assumptions made

1. **The bundle's spec is the frozen protocol plus the tooling document, not a tracker
   issue.** *Evidence:* `state.json` bundle record has `issues: []`; the run's `SCAN_DONE`
   event names the source as "human-authorized Phase A calibration tooling implementation";
   `CALIBRATION_PROTOCOL.md` and `PILOT_0_CALIBRATION_PROTOCOL.spec.json` are the only
   documents that state Phase A requirements.
2. **The uncommitted worktree changes are this bundle's own work-in-progress, to be verified
   and landed rather than discarded or rebuilt.** *Evidence:* the changed and untracked file
   set matches the bundle `footprint` globs one-for-one; `docs/PHASE_A_CALIBRATION_TOOLING.md`
   declares the same `phase-a-calibration-tooling-1.0.0` version that
   `scripts/validate-contracts.js` asserts; the run recorded `worktree_unchanged: true` for
   its own earlier steps, so no pipeline persona authored them.
3. **"Done" for this bundle is gated on `npm run check`, the repository's own composite
   gate.** *Evidence:* `package.json` defines `check` as `validate && test && build`, and the
   run's `state.json` `commands` block registers exactly that trio as the build, test, and
   source commands.
4. **The tooling tests run under the default `npm test` sweep rather than needing their own
   script.** *Evidence:* `npm test` is bare `node --test`, which discovers `test/*.test.js`;
   the observed 586-test run includes `test/calibration-tooling.test.js`.
   `npm run validate:calibration` remains scoped to `test/calibration-protocol.test.js`, which
   matches its name (protocol, not tooling); widening it is optional and not required by any
   criterion above.
5. **Metric and schema shapes are taken as-is from the frozen protocol and the in-tree
   schemas, not redesigned.** *Evidence:* `PILOT_0_CALIBRATION_PROTOCOL.spec.json` declares 32
   metrics, 25 parameter domains, 10 held-constant parameters, and 17 provenance requirements;
   the six new schemas already encode those requirements with `additionalProperties: false`.
6. **The manifest schema version `phase-a-calibration-manifest-2.0.0` sitting beside
   `…-state-1.0.0` and `…-attestation-1.0.0` is intentional, not a typo.** *Evidence:* the
   constant is exercised by the passing archive and attestation tests and by
   `schemas/calibration-execution-manifest.schema.json`; nothing on record describes a 1.0.0
   manifest that it would supersede. Flagged so a reviewer can correct it cheaply if it was
   accidental.

---

## Open questions

None. Every gap found by the rubric's checks was answerable from the frozen protocol, the
parameter registry, the in-tree schemas, the tooling document, or the run's own state and
event records, and each fill is recorded as an assumption above with its evidence.
