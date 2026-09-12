# Phase A calibration tooling

Version: `phase-a-calibration-tooling-1.1.0`

This apparatus implements the frozen `pilot-0-calibration-1.1.0` protocol. It
does not authorize empirical calibration, Pilot 0 research, model inference, or
confirmatory execution.

## Boundary and flow

The runner binds the validated `v0.1.0-pilot0` implementation target
`8f06baae4cda7d6fbd9d61924b5c615f4a45ba59`, the frozen protocol, complete
parameter registry, 20-turn cap, and 24-seed common panel. An execution adapter
must be supplied through a separately signed, provenance-locked package; the
repository contains neither a hidden default policy nor a production
authorization bypass.

For each generated parameter vector the runner:

1. derives the vector from a registered baseline and one frozen operation;
2. verifies the transition and held parameters;
3. publishes one durable logical execution intent and an append-only execution
   attempt before every seed dispatch, then executes or reconciles the intent
   through the injected adapter;
4. checkpoints each verified canonical evidence bundle immutably;
5. regenerates treatment-neutral observations and all frozen metrics;
6. presents only a closed blinded DTO to aggregation and selection;
7. applies every threshold and compares the complete deterministic qualifying
   frontier before applying the frozen maximin selection rule;
8. writes immutable per-seed manifests and a complete-panel signed candidate;
9. records all rejected and failed candidates; and
10. emits `CALIBRATION_RESULT` and a separate proposed
    `PILOT_0_WORLD_CONFIGURATION` only when the stopping rule passes.

Crash recovery reads signed execution intents, append-only attempt lineage,
content-addressed evidence, and immutable manifests before dispatching work. A
retry preserves the logical intent, seed, vector, RNG, policy assignment, and
protocol identity while creating a distinct child execution-attempt ID. The
signed adapter reconciles the stable idempotency key against authoritative
evidence state before executing. `completed_keys` indexes only a valid terminal
calibration disposition; an infrastructure or implementation failure is never
a completed seed. A completed parameter/seed key cannot be counted twice.

Execution attempts use the explicit states `PENDING`, `DISPATCHING`, `RUNNING`,
`SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `QUARANTINED`, and
`RECOVERING`. Uncertain authority failures are quarantined with explicit absent
evidence, last-known boundary, authority identity, preflight, error, receipt,
and lineage fields. Recovery is forbidden until the authority is reconciled;
its durable finalization and monotonic evidence head override runner-local
assumptions. Terminal implementation, protocol, blinding, or research-design
failures stop the campaign and require the applicable authorization boundary.
Corruption, unknown fields, missing seeds, unregistered values, protocol drift,
baseline drift, blinding disclosures, and invalid signatures fail closed.

## Authorization domains

Raw evidence is available only to the trusted metric collector and immutable
archive. Externally supplied adapter code is imported only by a subprocess
running under Node's permission model. Its complete static package and explicit
filesystem, network, environment, child-process, and worker permissions are
signed by the external authorization. The complete authorized package is
hashed immediately before and after every execute or recover operation in both
the parent and worker, and the returned package digest is bound into the
receipt. Empirical child-process capability fails closed because the current
runtime does not provide a descendant-constraining OS sandbox. Environment
access is limited to the exact signed allowlist. The selector receives seed
aliases, an opaque parameter hash, normalized treatment-neutral metric values,
and the frozen metric inventory. It receives neither raw evidence references
nor a loader capability. External Ed25519 trust is supplied by the verifier; a
key inside an archive is never its own authority.

Empirical deployment uses distinct authorization, archive-signing,
attestation, evidence, and evidence-head authorities. The signed archive state
binds its predetermined calibration run ID, campaign ID, and authorization
hash. Authority key IDs are pairwise distinct. The archive signer cannot forge
the independently signed per-attempt, candidate, result, or world-configuration
attestations. Empirical verification validates the signed authorization,
release, complete adapter package, evidence receipts and head, archive head,
attestor trust, and execution receipts; no archive key is accepted as an
attestor fallback.

Release and authorization roots are additionally constrained by
`config/calibration-trust-policy.json`, which is hashed into the tooling
distribution and bound by both signed release and authorization records. It is
provisioned only through the production trust workflow. An unprovisioned checkout
remains `UNPROVISIONED_FAIL_CLOSED`; a campaign checkout records the immutable
release and calibration-authorization key IDs in the policy. No calibration CLI
argument can declare or replace those trust roots. Empirical
archives must be pre-created as canonical, non-symlink, owner-only directories;
signing keys must be owner-only regular files outside both the archive and the
signed adapter package.

The production-equivalent local trust deployment uses six distinct Ed25519
identities: release, calibration authorization, archive, attestation, evidence,
and evidence-head. Private keys and bearer credentials remain outside Git in
owner-only storage. The evidence authority is an HTTPS-only durable service with
a campaign CA pinned inside the signed adapter package. It persists immutable
content-addressed evidence, signed archive receipts, and a signed monotonic head;
restart recovery verifies the entire durable chain before accepting requests.
The archive and attestation keys remain separate from both service keys.
Provisioning creates a signed null evidence-head anchor before first startup;
an established deployment never recreates a missing anchor. The evidence
service rereads the fixed signed revocation registry before every production
request, so a signed successor registry can revoke the campaign capability
before world execution without rebuilding the adapter package. Successor
registries must retain the signed issuance-registry ancestry.

The deterministic synthetic fixture used by tests is software evidence only.
It requires `SYNTHETIC_CONFORMANCE` provenance and matching synthetic evidence
and result classes. It is not a calibration parameter evaluation and cannot be
promoted to or verified as an empirical archive.

## Recovery and failure evidence

`completed_keys` indexes only a frozen terminal calibration disposition
(`PARAMETER_FAILURE` or `ACCEPTED_CONFIGURATION`). Execution intents and their
at-least-once attempts are separate signed state. A retry retains the same
calibration key, seed, parameter vector, policy assignment, RNG inputs,
protocol, and authorized apparatus, while receiving a new attempt ID linked in
the signed state. Each failed-attempt artifact is an immutable snapshot; its
parent is fixed at failure time and later successor linkage is append-only in
the signed state generations.

The authority boundary matrix is fail-closed:

| Failure boundary | Attempt disposition | Retry condition | Source of truth |
|---|---|---|---|
| Before dispatch | `FAILED_RETRYABLE` | A fresh authorization preflight passes | Signed runner intent and archive head |
| After dispatch, before world | `QUARANTINED` | Signed authority observation establishes absence or the stored intent | Evidence authority observation |
| During world, before commit | `QUARANTINED` | Signed observation establishes no finalization; deterministic replay retains the same request | Evidence authority observation |
| During multi-event/object commit | `QUARANTINED` | Pending transaction is completed or absence is authoritatively established | Durable authority pending/object records |
| Commit complete, response lost | `QUARANTINED` until reconciled | `FINALIZED` returns the exact retained result | Signed finalization and monotonic authority head |
| Head advanced, runner unaware | `QUARANTINED` until reconciled | Pending/finalized state is recovered without allocating another head | Signed authority head and pending transaction |
| Final attestation interrupted | `QUARANTINED` | Authority completes the immutable pending transaction | Durable pending transaction |

Every recovery observation is schema-validated and signed by the pinned
evidence-head key. It is preserved in the failed-attempt record even if a later
retry boundary also fails. Archive reopening independently revalidates its
signature, intent binding, state/nullability relationships, and any nested
authority-head identity. Cross-process authority operations use an owner-only
storage lock; an ambiguous stale lock requires operator recovery and cannot
allocate a competing head.

A replacement campaign capability may carry a signed
`PREDECESSOR_FAILED_CAMPAIGN` reference. It imports no completed keys, seeds, or
parameter-vector outcomes. The replacement archive starts empty and preserves
the defective campaign only by immutable identity and digest.

## Metric and selection integrity

Calibration metrics derive from canonical evidence. Economy balance compares
dimensionally matched food production with food consumption; economy collapse
is reconstructed from canonical production transitions, terminal disposition,
and authoritative state rather than an unrelated resource balance. Cross-seed
dispersion is normalized with deterministic fixed-point arithmetic against each
metric's frozen treatment-neutral accepted/pathological scale before metrics
with heterogeneous units are compared.

The maximin selector evaluates the complete deterministic qualifying frontier.
A first passing baseline or earlier search-order candidate cannot terminate the
search or become the selected configuration merely by position. Search bounds
that prevent frontier completion leave selection incomplete rather than
certifying a provisional winner.

The model runtime lock includes the model-use declaration, complete Hugging
Face model/tokenizer/source/runtime configuration, generation settings, and
artifact identities. Neutral calibration model context rejects persistence
history and relational-memory inputs. Blinding validation normalizes compact
and camelCase names, inspects treatment-bearing string values, and decodes
text-bearing base64 evidence envelopes before selector admission.

## Commands

- `npm run calibration:plan` prints the frozen search and authorization state.
- `npm run calibration:verify -- --mode synthetic --archive PATH --archive-public-key PATH
  --archive-key-id ID --attestor-public-key PATH --attestor-key-id ID
  --trusted-head PATH` verifies a complete synthetic-conformance archive against
  separate external archive and attestation trust plus an externally retained
  exact final head.
- `npm run calibration:verify -- --mode empirical ...` fails closed unless the
  full signed authorization, release, adapter, evidence, evidence-head, archive,
  and independent attestor trust package is supplied. See `--help` for the
  required paths and identifiers.
- `npm run calibration:trust:provision -- ...` creates distinct authority
  identities, a local campaign CA, a signed release, a narrowly scoped Phase A
  capability, a pinned adapter package, and an owner-only evidence-service
  configuration. Output directories must be new and outside the repository.
- `npm run calibration:evidence:serve -- /absolute/path/to/calibration-evidence-authority-config.json`
  starts the provisioned HTTPS evidence authority. Its configuration, keys,
  credential, storage, and empirical archive are external deployment state and
  must never be committed.
  Empirical dispatch also requires the signed `calibration-revocations.json`
  produced by provisioning; absence, substitution, signature failure, or a
  listed authority/capability fails closed. A successor registry is accepted
  only when signed by the fixed calibration-authorization authority and when
  it names the issuance registry in its ancestor chain. The evidence service
  rereads this fixed deployment record before the pre-execution intent lookup
  as well as finalization, so revocation takes effect without replacing the
  signed adapter package.
- `node scripts/calibration-cli.js run` remains dormant unless a later,
  separately signed authorization, provenance-locked adapter/release, external
  evidence trust roots, distinct archive-signing and attestation keys are
  supplied. This repository
  state does not itself authorize empirical calibration.
- `npm run check` validates schemas, tests adversarial behavior, and builds the
  distributable runtime.

Generated calibration records belong under ignored `calibration/runs/`; they
must not be committed as repository source.

## Verification status

Validation status is recorded only by the release workflow after the complete
suite and independent recovery review have passed. This document does not turn
an implementation checkout into empirical authority.
