# Plan — `phase-a-calibration-apparatus`

Bundle: **Implement Phase A calibration execution apparatus**

Completion addendum — 2026-09-11: the fixed eight-role policy package, production
Phase A adapter, reducer-backed coverage, manifest/attestation, and crash-resumable
search state are implemented. The distinct post-policy suite passed 848/848 with zero
skips. Historical unchecked steps below describe the pre-policy execution plan and are
retained as planning history; they are superseded by this addendum and
`validation/CALIBRATION_TOOLING_REVIEW.json`.
Branch: `develop/phase-a-calibration-apparatus`
Base: `origin/main`
Spec: [`docs/develop/specs/phase-a-calibration-apparatus.md`](../specs/phase-a-calibration-apparatus.md)
Planned: 2026-09-10

---

## Status addendum — 2026-09-11

This plan and its unchecked boxes preserve the original work breakdown; they are not
the current completion ledger. The worktree subsequently passed a full 823/823,
zero-failure, zero-skip non-empirical suite before implementation of the newly ratified
Phase A execution-policy package. That result is the **pre-policy baseline**, not final
Phase A apparatus acceptance.

The former prohibition on a production adapter is superseded for the current bundle by
the human-ratified fixed heterogeneous deterministic policy panel. Remaining gates are:

1. implement and version all eight deterministic coverage roles and the frozen balanced
   assignment algorithm;
2. ensure policies consume only participant-equivalent authorized projections and never
   invoke Qwen;
3. implement the production Phase A adapter and bind its policy-package identity into
   manifests, attestations, recovery, and resume state;
4. demonstrate synthetic whole-panel mechanics coverage and repeat the full suite and
   adversarial review;
5. land and remotely verify the apparatus without executing empirical calibration.

No checklist item below should be read as authorizing calibration or research execution.

## Shape of the work

This was **not** greenfield when the plan was written. At that planning checkpoint the
worktree carried an uncommitted implementation whose file set matched the bundle footprint
one-for-one, and `npm run check` passed with 586 tests, 0 failed, and 0 skipped. That
historical checkpoint was later superseded by the 823/823 pre-policy baseline described
above. Per the spec's assumption 2, the work-in-progress remains this bundle's own output,
to be **verified and landed**, not rebuilt.

So the plan is an adversarial verification sweep, not a construction sequence. Each
verification task takes one group of acceptance criteria, writes an independent test file
that attacks those criteria against the existing `src/calibration-runner.js`, and leaves the
runner alone. One remediation task owns the runner and closes whatever the sweep found. One
documentation task reconciles the counts and records at the end.

### The runner is a single hub file, so it gets a single owner

Every verification task could in principle need to edit `src/calibration-runner.js` to fix a
defect it uncovers. Declaring that file in ten footprints would serialize the whole bundle
for a low-probability event. Instead:

- **T2–T11 are test-only against the runner.** They must not modify `src/calibration-runner.js`.
- If an assertion a task wants to make **fails** against the current runner, the task does
  **not** weaken the assertion and does **not** commit a red test. It leaves the assertion
  commented out in its own test file, immediately preceded by a single-line
  `// TODO(T12): <one-line defect statement>` comment, and reports the same defect in its
  `RESULT_JSON.findings`.
- **T12** greps `TODO(T12)` across `test/`, fixes the runner, un-comments each withheld
  assertion, and removes the marker. T12 must finish with zero `TODO(T12)` markers left in
  the tree.

If the sweep finds nothing, T12 is a confirmation pass: it records that no marker existed and
that `npm run check` is green. That is a legitimate outcome, not a skipped task.

### Bootstrap

`test/calibration-tooling.test.js` carries roughly 100 lines of deterministic synthetic
fixture construction before its first test. Seven new test files would each duplicate it, so
**T1** extracts it into `test/helpers/calibration-fixture.js` and re-points the existing file
at the helper. T1 is deliberately tiny — a move plus re-export, no behavior change — because
nine tasks wait behind it.

**T10** does not depend on T1: it drives the CLI as a subprocess and needs no fixture.

### Concurrency

Critical path is **T1 → T2 → T12 → T13**, length 4 against a ceiling of 7.
`schedule.py conflicts` reports **no serialized pairs**: schema files are claimed
individually rather than as `schemas/**`, and no two verification tasks share a path.

| Wave | Tasks |
| --- | --- |
| 1 | T1, T10 |
| 2 | T2, T3, T4, T5, T6, T7, T8, T9, T11 |
| 3 | T12 |
| 4 | T13 |

### Standing constraints on every task

- Never edit a `*.spec.*` file (`PILOT_0_CALIBRATION_PROTOCOL.spec.json`,
  `PARAMETER_REGISTRY.spec.json`, `PRIMARY_ENDPOINT.spec.json`, `HORIZON_POLICY.spec.json`,
  and siblings). They are read-only for this bundle.
- The historical plan prohibited a production execution adapter. The current ratified
  decision now requires a fail-closed production Phase A adapter for the fixed deterministic
  policy package. It still prohibits empirical execution without separate authority,
  authorization bypasses, Qwen use during initial Phase A, and every treatment-arm
  comparison, effect estimate, or significance computation.
- Never widen the search bounds (512 parameter sets, 12 rounds), the 24-seed panel, or the
  20-turn horizon.
- Tests must be deterministic and must not write outside a temp directory or
  `calibration/runs/`. Zero skipped tests — `{ skip: true }` and `t.skip()` are forbidden,
  because criterion 28 requires zero skips.
- Finish with `npm run check` green before reporting.

---

## Acceptance-criteria coverage map

Every numbered criterion in the spec is owned by exactly one task.

| Criteria | Task |
| --- | --- |
| 1, 2, 3, 20 | T2 |
| 4, 5, 6, 7 | T3 |
| 8, 9, 10 | T4 |
| 11, 12, 13 | T5 |
| 14, 15, 16 | T6 |
| 17, 18 | T7 |
| 19 | T8 |
| 21, 22, 23, 24 | T9 |
| 25, 26, 27 | T10 |
| 29 | T11 |
| (defect closure for all of the above) | T12 |
| 28, 30, 31 | T13 |

---

## T1 — Extract shared deterministic calibration test fixture helper

**Depends on:** _(none)_

**Files**
- `test/helpers/calibration-fixture.js` (new)
- `test/calibration-tooling.test.js` (modified)

**Interfaces** (new module `test/helpers/calibration-fixture.js`)
- `export function syntheticSeedPanel(): string[]` — the frozen 24 identifiers
  `calibration-seed-00` … `calibration-seed-23`.
- `export function syntheticCanonicalEvidence(options?): object` — deterministic
  canonical-evidence bundle for one (parameter-set, seed) key.
- `export function syntheticAdapter(options?): object` — the injected execution adapter the
  existing tests already build, returning deterministic synthetic evidence.
- `export function syntheticAttestationKeys(): { privateKey, publicKey, keyId }` — a
  deterministic Ed25519 keypair for attestation tests.
- `export async function withTempArchive(fn): Promise<any>` — creates an isolated temp
  archive root, invokes `fn(root)`, and removes it.

Export exactly the helpers the current file already constructs; do not invent new fixture
behavior in this task.

**Steps**
- [ ] Read `test/calibration-tooling.test.js` lines 1–104 and identify every setup constant,
      builder function, and keypair construction used by more than one test.
- [ ] Create `test/helpers/calibration-fixture.js` and move those constructs verbatim,
      exporting them under the signatures above. Keep determinism: no `Math.random`, no
      wall-clock values, no ambient environment reads.
- [ ] Re-point `test/calibration-tooling.test.js` at the helper via a relative import and
      delete the now-duplicated inline definitions. Do not change any assertion in the file.
- [ ] Confirm the helper file is not picked up as a test file by `node --test` (it lives in
      `test/helpers/` and does not match `*.test.js`); run `npm test` and confirm the total
      count is unchanged at the pre-task baseline and all 16 tooling tests still pass.
- [ ] Run `npm run check` and confirm it is green.

---

## T2 — Verify baseline/protocol binding, tooling version, and frozen-spec read-only invariant

**Depends on:** T1
**Covers criteria:** 1, 2, 3, 20

**Files**
- `scripts/validate-contracts.js` (modified)
- `test/calibration-binding.test.js` (new)

**Interfaces**
- No new runtime exports. `scripts/validate-contracts.js` gains additional `check(...)` calls
  only; its existing structure and output line stay as they are.

**Steps**
- [ ] Assert in `test/calibration-binding.test.js` that `src/calibration-runner.js` binds
      implementation commit `8f06baae4cda7d6fbd9d61924b5c615f4a45ba59`, tag `v0.1.0-pilot0`,
      and protocol version `pilot-0-calibration-1.1.0`, reading the bindings through the
      module's public surface rather than by regexing the source where possible.
- [ ] Assert that a **commit mismatch** and, separately, a **protocol-version mismatch** each
      cause `PhaseACalibrationRunner` to fail closed, and that each raises the
      `PROTOCOL_VIOLATION` (or, where the runner distinguishes it, the
      `IMPLEMENTATION_DEFECT`) class rather than proceeding. Verify which class the runner
      actually raises and assert that exact value; do not assume.
- [ ] Assert `CALIBRATION_TOOLING_VERSION === "phase-a-calibration-tooling-1.0.0"` and that
      `docs/PHASE_A_CALIBRATION_TOOLING.md` declares the same string, so a drift in either
      place is caught.
- [ ] Assert `Object.keys(CALIBRATION_FAILURES).length === 7` and that the key set is exactly
      `PARAMETER_FAILURE`, `IMPLEMENTATION_DEFECT`, `PROTOCOL_VIOLATION`, `BLINDING_BREACH`,
      `INFRASTRUCTURE_FAILURE`, `RESEARCH_DESIGN_BLOCKER`, `ACCEPTED_CONFIGURATION` — set
      equality, so both an added and a renamed class fail.
- [ ] In `scripts/validate-contracts.js`, extend the existing calibration block with checks
      that the runner's baseline commit, baseline tag, and bound protocol version match the
      frozen values, so drift fails `npm run validate` and not only the test suite. Keep the
      additions to `check(...)` lines beside the existing three.
- [ ] Assert the read-only invariant for frozen specs: enumerate the repository's `*.spec.*`
      files and assert `git diff --name-only origin/main -- <each>` is empty, i.e. this branch
      modifies none of them. Implement it as a single test that shells out once.
- [ ] Confirm the manifest-version anomaly noted in spec assumption 6
      (`phase-a-calibration-manifest-2.0.0` beside `…-state-1.0.0` and `…-attestation-1.0.0`).
      Do **not** change it. Report it in `RESULT_JSON.findings` at `severity: "info"` so a
      reviewer can decide, and note the decision in a code comment beside the assertion.
- [ ] Run `npm run check` and confirm it is green.

---

## T3 — Verify bounded deterministic search, hard bounds, and parameter-registry integrity

**Depends on:** T1
**Covers criteria:** 4, 5, 6, 7

**Files**
- `test/calibration-search-integrity.test.js` (new)

**Interfaces**
- No new runtime exports. Drives `enumerateCalibrationOperations`,
  `startingCalibrationParameterSet`, `validateCalibrationParameterSet`,
  `assertCalibrationTransition`, and `PhaseACalibrationRunner` as they exist.

**Steps**
- [ ] Assert the search mode constant is `BOUNDED_DETERMINISTIC_COORDINATE_GRID` and that the
      **registered starting parameter set is evaluated first**, before any generated candidate.
- [ ] Assert candidate generation order is deterministic and reproducible: run enumeration
      twice from the same incumbent and assert deep equality of the ordered candidate list;
      assert the order follows parameter-domain order, then field insertion order, then
      declared value order, by comparing against the order declared in
      `PARAMETER_REGISTRY.spec.json`. Verify the registry's declared ordering against that
      file and cite the field names in a code comment.
- [ ] Assert each generated candidate differs from its incumbent by **exactly one** frozen
      operation — compare parameter sets field-by-field and assert a single changed key
      (accounting for any alias fields the runner synchronizes; verify how
      `synchronizeAliases` behaves and comment the expectation).
- [ ] Assert the hard bounds: a search that would exceed **512** attempted parameter sets
      stops, and a search that would exceed **12** rounds stops. Assert that stopping means
      halting with a recorded reason, **not** widening the search and not silently succeeding.
      Drive this with a cheap adapter rather than 512 real evaluations if the runner allows
      injecting the counters; otherwise assert the bound constants and the guard directly.
- [ ] Assert the incumbent-replacement rule: a candidate whose protocol-ordered vector of
      normalized acceptance-bound violations is lexicographically smaller **and** that breaks
      no previously passing metric is promoted; a candidate that is lexicographically smaller
      **but** regresses a previously passing metric is **rejected**. Cover both branches.
- [ ] Assert `validateCalibrationParameterSet` rejects: an unregistered parameter key, a value
      outside its declared domain, a manually substituted value that is not a declared value,
      and a mutation to **any** of the 10 `held_constant_registry_parameters`. Enumerate the
      10 held-constant parameters from the frozen protocol and assert each individually, so a
      dropped guard on one of them fails.
- [ ] Assert no hidden default parameter set exists: scan `src/` and `scripts/` for a
      parameter-set literal other than the one the registry provides, and assert
      `startingCalibrationParameterSet()` is the only source. State the scan's scope in a
      code comment.
- [ ] Run `npm run check` and confirm it is green.

---

## T4 — Verify 24-seed panel completeness, full retention, and 20-turn horizon cap

**Depends on:** T1
**Covers criteria:** 8, 9, 10

**Files**
- `test/calibration-panel-retention.test.js` (new)

**Interfaces**
- No new runtime exports. Drives `collectCalibrationObservations`, `CalibrationArchive`, and
  `PhaseACalibrationRunner`.

**Steps**
- [ ] Assert the frozen panel is exactly the 24 identifiers `calibration-seed-00` …
      `calibration-seed-23`, as a set-equality assertion against the frozen protocol.
- [ ] Assert a candidate evaluated on a panel with **one seed missing** fails, with **one seed
      duplicated** fails, and with **one extra seed** fails.
- [ ] Assert each of those three failures occurs **before metrics are computed** — instrument
      the injected adapter or metric path so the test can prove the metric computation was
      never reached, rather than only asserting that an error was thrown.
- [ ] Assert full retention (`ALL_SEEDS_RETAINED_AND_REPORTED`): run a search in which one
      candidate is accepted, one is rejected, one fails, and one is incident-affected, then
      assert all four are present in the retained record with their dispositions intact.
- [ ] Assert there is no cherry-picking path: no public API drops, filters, or replaces a
      retained attempt. Assert that re-reading the archive returns the same complete attempt
      set.
- [ ] Assert the **20-turn** horizon cap: canonical evidence carrying 21 turns fails, and the
      failure occurs **before metric selection**, proven the same way as the panel checks.
- [ ] Run `npm run check` and confirm it is green.

---

## T5 — Verify 32-metric inventory, reducers, and fixed-point aggregation arithmetic

**Depends on:** T1
**Covers criteria:** 11, 12, 13

**Files**
- `test/calibration-metric-arithmetic.test.js` (new)
- `schemas/calibration-metric-artifact.schema.json` (modified only if a gap is found)

**Interfaces**
- No new runtime exports. Drives `materializeCalibrationMetrics` and the runner's
  aggregation path.

**Steps**
- [ ] Enumerate the **32** frozen treatment-neutral metric keys from
      `PILOT_0_CALIBRATION_PROTOCOL.spec.json` and assert `materializeCalibrationMetrics`
      emits exactly that key set for every seed — set equality, so a missing key and an extra
      key both fail closed.
- [ ] Assert each metric is reduced through its **declared** reducer. For each of `MEAN`,
      `MEDIAN`, and `MAXIMUM`, construct evidence whose three reducers would give three
      different answers and assert the declared one is the value produced. Verify each
      metric's declared reducer against the frozen protocol and cite the field path in a code
      comment.
- [ ] Assert fixed-point aggregation at scale **1,000,000**: persisted metric values are
      signed integers, and `Number.isInteger` holds for every persisted metric value in a
      full materialized artifact. Assert that **no floating-point value reaches a persisted
      metric** by walking the persisted object and failing on any non-integer number.
- [ ] Assert **round-half-even**: feed values whose scaled result lands exactly on `.5` in
      both the round-up-to-even and round-down-to-even directions and assert the banker's
      result, not the round-half-up result.
- [ ] Assert overflow and precision fail closed: a value that would exceed the safe signed
      range at scale 1,000,000, and a value whose precision cannot be represented, each raise
      rather than truncate silently.
- [ ] Assert **no metric is ever estimated by treatment arm**: no metric key, artifact field,
      or reducer output is arm-indexed, and supplying arm-partitioned evidence does not
      produce per-arm values. Assert against the schema as well as the runtime.
- [ ] Validate a materialized artifact against `schemas/calibration-metric-artifact.schema.json`
      and assert an unknown field is rejected (`additionalProperties: false`). Adjust the
      schema **only** if it fails to close a real gap; a schema change must not relax any
      existing constraint.
- [ ] Run `npm run check` and confirm it is green.

---

## T6 — Verify treatment-blind selector boundary, forbidden-key scan, and incident handling

**Depends on:** T1
**Covers criteria:** 14, 15, 16

**Files**
- `test/calibration-blinding.test.js` (new)

**Interfaces**
- No new runtime exports. Drives `calibrationSelectionProjection`, `assertTreatmentBlind`,
  `aggregateCalibrationSelectionView`, and `selectCalibrationCandidate`.

**Steps**
- [ ] Assert the blinded view is the closed `CALIBRATION_TREATMENT_BLIND_V1` shape and carries
      exactly: the fixed metric keys, seed alias, opaque parameter-set hash, disposition, and
      blinded run identifier. Assert set equality on the top-level keys, so an added field
      fails.
- [ ] Assert the view holds **no raw-evidence reference** and **no evidence-loader
      capability**: no field is a function, no field is a path or URL into the evidence store,
      and the selector cannot reach raw evidence through any property or prototype of the
      value it receives.
- [ ] Enumerate all **15** `blinding.forbidden_input_fields` from the frozen protocol and
      assert each is rejected **on presence**, individually — a loop over the frozen list with
      one assertion per field, so a guard dropped on one field fails.
- [ ] Enumerate all **7** `blinding.forbidden_outputs` and assert each is rejected on
      presence, individually.
- [ ] Assert rejection is **normalization-insensitive**: for each forbidden key, assert the
      upper-case, lower-case, `snake_case`, `camelCase`, `kebab-case`, and separator-stripped
      variants are all rejected. Verify the exact normalization the forbidden-key scan applies
      and cite it in a code comment.
- [ ] Assert nesting: a forbidden key buried inside a nested object or an array element is
      still rejected, matching `scanForbidden`'s recursive path reporting.
- [ ] Assert incident handling: an attempted or accidental disclosure is retained as a
      `CALIBRATION_PROTOCOL_INCIDENT`, **invalidates** the affected selection decision, and
      leaves the search requiring repetition from the last unexposed state. Assert all three
      consequences, not only that an incident record exists.
- [ ] Run `npm run check` and confirm it is green.

---

## T7 — Verify Ed25519 attestation subject, external trust, and distinct failure classes

**Depends on:** T1
**Covers criteria:** 17, 18

**Files**
- `test/calibration-attestation-trust.test.js` (new)
- `schemas/calibration-attestation.schema.json` (modified only if a gap is found)

**Interfaces**
- No new runtime exports. Drives `attestCalibrationAttempt`,
  `verifyCalibrationAttestation`, and the runner's `assertAttestationSubject` path.

**Steps**
- [ ] Assert the signed subject is **exactly** six elements: metric hash, seed,
      parameter-set hash, raw-evidence binding, disposition, and the no-comparison
      declaration. Assert set equality on the subject's keys so an added or removed element
      fails, and assert the signature does not cover anything else by mutating an unsigned
      field and confirming verification still passes.
- [ ] Assert the attestation is Ed25519 and that `verifyCalibrationAttestation` takes its
      trusted keys **as an argument supplied by the caller**.
- [ ] Assert a key carried **inside** an archive is never its own authority: build an archive
      whose embedded key material would verify its own signature, pass no external trust, and
      assert verification fails.
- [ ] Assert each of the six attack cases fails closed with a **distinct** failure class, and
      assert the class values are pairwise different within the test:
      missing trust, forged signature, mutated signature, changed metric inventory,
      fabricated metric value, baseline drift, protocol drift. Verify the class each case
      actually raises and assert those exact values.
- [ ] Validate a produced attestation against `schemas/calibration-attestation.schema.json`
      and assert an unknown field is rejected. Adjust the schema **only** to close a real gap
      and never to relax an existing constraint.
- [ ] Run `npm run check` and confirm it is green.

---

## T8 — Verify content-addressed archive immutability, write-once manifests, and crash recovery

**Depends on:** T1
**Covers criterion:** 19

**Files**
- `test/calibration-archive-recovery.test.js` (new)
- `schemas/calibration-execution-manifest.schema.json` (modified only if a gap is found)
- `schemas/calibration-search-state.schema.json` (modified only if a gap is found)

**Interfaces**
- No new runtime exports. Drives `CalibrationArchive` and the runner's resume path.

**Steps**
- [ ] Assert canonical evidence is **content-addressed**: the same evidence stored twice
      yields the same address, and a single-byte change yields a different address.
- [ ] Assert checkpoints are **immutable per (parameter-set, seed) key**: rewriting a
      completed key with different content is rejected rather than overwriting, and the
      original content is still readable afterwards.
- [ ] Assert manifests are **write-once**: a second write to an existing manifest path is
      rejected, with the existing manifest unchanged.
- [ ] Assert crash recovery **reads existing evidence and manifests before dispatching
      work**: instrument the injected adapter to count dispatches, crash mid-run after an
      evidence checkpoint, resume, and assert the completed key was neither re-executed nor
      re-counted. Assert the dispatch count, not only the final result.
- [ ] Assert recovery is idempotent across **two** successive crash/resume cycles, and that a
      corrupted state file fails closed rather than resuming from a partial state.
- [ ] Validate a manifest and a search-state record against their schemas and assert unknown
      fields are rejected. Adjust a schema **only** to close a real gap, never to relax a
      constraint.
- [ ] Assert every archive write in this test lands under a temp root, never in the
      repository working tree.
- [ ] Run `npm run check` and confirm it is green.

---

## T9 — Verify selection rule, tie-breakers, stopping proof, and output schema closure

**Depends on:** T1
**Covers criteria:** 21, 22, 23, 24

**Files**
- `test/calibration-outputs.test.js` (new)
- `schemas/calibration-result.schema.json` (modified only if a gap is found)
- `schemas/pilot0-world-configuration.schema.json` (modified only if a gap is found)

**Interfaces**
- No new runtime exports. Drives `selectCalibrationCandidate`,
  `assessCalibrationCandidate`, and `buildCalibrationResult`.

**Steps**
- [ ] Assert the primary selection objective: the winner **maximizes the minimum normalized
      distance from pathological boundaries**. Construct candidates where a different
      objective (for example mean distance) would pick a different winner, and assert the
      min-distance winner is chosen.
- [ ] Assert the four tie-breakers apply **in order**, with one test per tie-breaker that ties
      on every earlier criterion: (1) highest worst-seed metric pass fraction, (2) lowest
      cross-seed metric variance, (3) fewest changes from the registered starting set,
      (4) lexicographically smallest parameter-set SHA-256.
- [ ] Assert selection is **reproducible from the retained record alone**: re-running
      selection over the persisted record yields the identical winner and the identical
      tie-breaker trace.
- [ ] Assert a `CALIBRATION_RESULT` is emitted **only** when the stopping rule passes with an
      accepted candidate on the complete panel. Assert the three negative cases each refuse to
      emit a stopping proof: no accepted candidate, an incomplete panel, and a stopping rule
      that has not passed.
- [ ] Validate an emitted result against `schemas/calibration-result.schema.json` and assert
      `calibration_execution_authorized` names only Phase A execution, while
      `pilot0_research_authorized` and `confirmatory_authorized` are `false` **by
      construction** — assert the schema constrains the research fields to `false`, not
      merely that the instance happens to be `false`.
- [ ] Validate the proposed world configuration against
      `schemas/pilot0-world-configuration.schema.json` and assert `status` is the constant
      `PROPOSED_NOT_RESEARCH_AUTHORIZED`, again constrained by the schema.
- [ ] Assert the proposed configuration **promotes no `PROVISIONAL` value**: enumerate the
      `PROVISIONAL` world and model values in the frozen Pilot 0 configuration and assert none
      of them appears as a calibrated value in the output.
- [ ] Assert `additionalProperties: false` closure across **all six** calibration schemas:
      for each, validate a known-good instance, then add one unknown field and assert
      rejection. Note in a code comment that this task owns only two of the six schema files;
      the other four are read-only here.
- [ ] Assert the result contains **no treatment-arm comparison, effect estimate,
      endpoint-by-arm figure, or significance value**, in either the runtime output or the
      schema's permitted fields.
- [ ] Run `npm run check` and confirm it is green.

---

## T10 — Verify authorization boundary, CLI surface, injected adapter, and build packaging

**Depends on:** _(none)_
**Covers criteria:** 25, 26, 27

**Files**
- `scripts/calibration-cli.js` (modified only if a gap is found)
- `scripts/build.js` (modified only if a gap is found)
- `package.json` (modified only if a gap is found)
- `test/calibration-cli-authorization.test.js` (new)

**Interfaces**
- No new runtime exports. `package.json` keeps `calibration:plan` and `calibration:verify`
  exactly as they are unless a criterion proves them wrong.

**Steps**
- [ ] Assert `node scripts/calibration-cli.js run` **fails closed without the complete
      signed Phase A authority and trust package**: spawn it without that package, assert a
      non-zero exit code, assert the message names the missing authority, and assert no world
      or model execution was started. With valid authority, it may invoke only the frozen
      deterministic policy adapter and must never invoke Qwen.
- [ ] Assert `npm run calibration:plan` prints the frozen search and authorization state,
      exits zero, and starts no world or model execution. Assert the output names the 512
      parameter-set bound, the 12-round bound, the 24-seed panel, and
      `empirical_calibration: false`.
- [ ] Assert `npm run calibration:verify -- --archive PATH --public-key PATH --key-id ID`
      verifies a fixture archive against **externally supplied** trust: it succeeds for a
      matching key, and fails for a mismatched key and for a missing `--public-key`.
- [ ] **Superseded pre-policy check:** the runner formerly required a caller-injected
      adapter and prohibited a repository production adapter. Replace this with tests that
      bind the production adapter to the exact frozen policy-package version and prove that
      unauthorized or mismatched adapters fail closed.
- [ ] Assert **no embedded authorization bypass** exists: scan the runner, CLI, policy
      package, and production adapter for any environment variable, flag, or constant that
      self-authorizes calibration. Assert no path starts Qwen generation, human sessions,
      Pilot 0 research, or confirmatory execution.
- [ ] Assert the deterministic synthetic fixture is **software evidence only** and cannot be
      promoted into an empirical archive: attempt the promotion and assert it is rejected with
      a class naming the software-evidence provenance.
- [ ] Assert `npm run build` succeeds and that `dist/` contains the CLI, `src/`, `schemas/`,
      and the two spec files `scripts/build.js` copies — and that it contains no generated
      calibration run artifact, no private key, and no `.env` file.
- [ ] Verify `package.json`'s `calibration:plan` and `calibration:verify` scripts invoke
      exactly the CLI verbs criterion 25 names; change them only if they do not.
- [ ] Run `npm run check` and confirm it is green.

---

## T11 — Verify generated-artifact hygiene and `calibration/runs/` git-ignore boundary

**Depends on:** T1
**Covers criterion:** 29

**Files**
- `.gitignore` (modified only if a gap is found)
- `test/calibration-artifact-hygiene.test.js` (new)

**Interfaces**
- No new runtime exports.

**Steps**
- [ ] Assert `.gitignore` ignores `calibration/runs/`, using `git check-ignore` on a
      representative path rather than a string match on the file, so an ignore rule that is
      shadowed later in the file is caught.
- [ ] Assert **no generated calibration run artifact is tracked**: `git ls-files calibration/`
      returns nothing, and no file under `calibration/runs/` appears in
      `git status --porcelain` as an untracked candidate for commit.
- [ ] Assert the runner writes generated records under `calibration/runs/` by default:
      construct a runner with its default archive root and assert the resolved path is under
      `calibration/runs/`, without actually executing a search.
- [ ] Assert that the repository contains no committed file matching the generated-record
      naming pattern outside `calibration/runs/`, so a record cannot be laundered into
      `validation/` or `schemas/` as repository source.
- [ ] If `.gitignore` proves insufficient, add the narrowest rule that closes the gap; never
      remove or weaken an existing ignore rule.
- [ ] Run `npm run check` and confirm it is green.

---

## T12 — Close confirmed runner defects and land withheld `TODO(T12)` assertions

**Depends on:** T2, T3, T4, T5, T6, T7, T8, T9, T10, T11

**Files**
- `src/calibration-runner.js` (modified)
- `test/calibration-remediation.test.js` (new, only if a regression test does not belong in an
  existing file)

**Interfaces**
- Changes to `src/calibration-runner.js` must preserve every existing export signature listed
  in the spec's criteria. Any new export must be additive and must not create an execution
  path.

**Steps**
- [ ] Run `grep -rn "TODO(T12)" test/` and enumerate every withheld assertion left by T2–T11.
      Also read the findings T2–T11 reported, which the tech lead supplies in the brief.
- [ ] For each marker, decide: **real defect** (fix the runner) or **wrong expectation by the
      verifying task** (correct the assertion and say so explicitly in the report). Do not
      resolve a marker by deleting the assertion.
- [ ] Fix each confirmed defect in `src/calibration-runner.js` with the **narrowest** change
      that closes it. Never widen the search bounds, the seed panel, or the horizon to make a
      test pass, and never add an unauthorized execution path, an unbound adapter, or an
      authorization bypass. The newly required production adapter must remain policy-locked
      and fail closed.
- [ ] Un-comment each withheld assertion in its original test file and delete its
      `TODO(T12)` marker. Editing another task's test file is expected here and is the reason
      T12 runs alone in its wave.
- [ ] Re-run `grep -rn "TODO(T12)" test/ src/` and confirm zero matches remain.
- [ ] Re-run `npm run check` and confirm zero failures and **zero skips**.
- [ ] If the sweep produced no markers and no findings, record that explicitly: state in the
      report that the verification sweep confirmed the apparatus with no runner change, and
      that `src/calibration-runner.js` is untouched. That is a valid completion.
- [ ] Report the final test total from `npm test`, since T13 needs it.

---

## T13 — Reconcile documentation, headline test counts, and adversarial review record

**Depends on:** T12
**Covers criteria:** 28, 30, 31

**Files**
- `README.md` (modified)
- `docs/PHASE_A_CALIBRATION_TOOLING.md` (modified)
- `validation/CALIBRATION_TOOLING_REVIEW.json` (modified)

**Interfaces**
- Documentation and a validation record only. No code change.

**Steps**
- [ ] After the policy package and production adapter land, run `npm run check` and capture
      the new authoritative totals. Criterion 28 requires **zero failures and zero skips**.
      The verified 823/823 count is the pre-policy baseline and must not be presented as the
      completed policy/adapter result.
- [ ] Update `README.md` from the 823-test pre-policy baseline only after the post-policy
      full-suite total exists. Preserve the immutable Pilot 0 baseline's historical 557-test
      result where it is explicitly identified as that baseline.
- [ ] Add the post-policy full-suite result to
      `validation/CALIBRATION_TOOLING_REVIEW.json` without erasing its historical focused
      runs or the 823/823 pre-policy baseline. Mark the policy/adapter gates complete only
      after their dedicated conformance and adversarial checks pass.
- [ ] Confirm the review record names all **five** specialist domains — treatment leakage,
      search integrity, provenance and attestation, recovery, research validity — and add any
      that is missing. Record the verification sweep T2–T11 performed under the matching
      domain.
- [ ] Confirm the review record's P0 and P1 finding lists are empty, and that
      `empirical_calibration_executed` and `empirical_calibration_authorized` are both
      `false`. If T12 closed a defect that a reviewer would rate P0 or P1, record it with its
      resolution rather than leaving the list falsely empty — an emptied-by-fix list must say
      so.
- [ ] Confirm `README.md` and `docs/PHASE_A_CALIBRATION_TOOLING.md` describe the shipped
      commands (`calibration:plan`, `calibration:verify`, the fail-closed `run`) and the
      shipped state, and that both still declare tooling version
      `phase-a-calibration-tooling-1.0.0`. Correct any command or flag that drifted during
      T10.
- [ ] Assert the three numbers agree: the `npm run check` total, the `README.md` headline, and
      the review record's `test_summary.passed`. State all three in the report.
- [ ] Run `npm run check` one final time and confirm it is green.

---

## Diagnostics

- **Task count:** 13
- **Critical path:** `T1 → T2 → T12 → T13` (length 4, ceiling 7)
- **Serialized pairs:** none — `schedule.py conflicts` returns `[]`
- **Widest footprint:** T10 (four files across `scripts/`, `package.json`, `test/`); it has no
  dependencies and runs in wave 1 alongside T1.
- **Deliberate fan-in:** T12 depends on all ten verification tasks because it is the sole
  owner of `src/calibration-runner.js`. That is a real dependency, not a narrative one.
