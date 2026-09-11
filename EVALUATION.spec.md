# EVALUATION.spec.md

> Inherits `INVARIANTS.spec.md`.

## Mission
Build observability, logging, replay, audit, visualization, and analysis for compelling gameplay and rigorous research. Evaluation consumes canonical events/experiment metadata and MUST NOT influence WORLD execution or participant knowledge.

## Strictly separated surfaces
### Player/Game
Show only the player's authorized deterministic projection. The client, browser payloads, accessibility tree, screen-reader text, keyboard metadata, tooltips, maps, search, autocomplete, notifications, caches, and participant-visible debugging surfaces MUST never receive authoritative hidden state. Provide polished interactive hex world, fog/stale knowledge, movement/range/detection overlays, facilities/population/resources/research/construction, combat, diplomacy controls, economy/technology panels, turn/phase/deadline controls, and human controls mapped exactly to structured actions.

### Observer/Research
Access-controlled omniscient view: true world state; all diplomacy; polity knowledge projections; current memory + edit archive; confidant interviews; intelligence truth/reports/detection/attribution; combat RNG; violations; model/runtime metadata; experiment conditions; replay/fork/recovery provenance.

Player UI MUST never expose Observer data.

## Evidence hierarchy
**Level 0 raw immutable evidence:** world events, authorized observations, messages, actions, RNG, memory edits, interviews, violations, model/runtime events, projection/context lineage, submissions/retries, run/identity lineage, interventions, and breach records. Raw evidence and provenance are authoritative and sufficient to reconstruct what occurred without UI state, analytics databases, or incidental logs.

**Level 1 deterministic derivations:** territory change, trade volume, resource transfer, population/economic change, durations, and other metrics whose grain, denominator, eligibility, temporal aggregation, formula, and source events are versioned. Natural-language promises remain verbatim raw evidence; their formation/fulfillment/breach/modification/release/ambiguity classifications use the preregistered treatment-blinded coding protocol and are not silently promoted to Level 1.

**Level 2 coded interpretations:** cooperation-like behavior, strategic misrepresentation, retaliation, commitment categories, etc.; separately versioned/auditable/replaceable.

**Level 3 theoretical interpretation:** Promise Theory, relational ontology, temporal identity, alignment implications. Never written back into raw data/participant state.

## Canonical event viewer
Search/filter by turn/phase/sequence, polity, event type, territory/hex, channel, visibility, model/persistence condition, experiment/run, violation/protocol deviation, identity/session lineage, and breach disposition. Every derived claim links to versioned source events and raw payload/provenance references. UI summaries are reproducible derivatives, not authoritative evidence.

## Replay
- Turn scrubber reconstructs exact authoritative state.
- Toggle Observer truth vs selected polity authorized view at that logical time.
- Reproduce recorded non-model stochastic outcomes exactly.
- Distinguish state replay, experiential replay, resident continuation, recovery.
- Branch only where invariants/statistical protocol permit. Forks/replays are not independent experimental samples and carry explicit parent-run/branch lineage.
- Show what a polity knew then, not only hindsight truth.

## Map visualization
High-quality interactive hex map with territory boundaries, land/water/terrain, multi-hex facility footprints, population/unit groups, authorized resource deposits, stale/last-known markers with age, detection/range overlays, movement/combat, capital/takeover, construction/damage, and Observer truth mode. It must be compelling enough for a real game, not a debug canvas.

## Polity dashboards
As authorized: population assignments; food demand/supply/shortage progression; credits/output; resources/reserves; facilities/capacity/damage; technologies/research; military; territory; known-world coverage; only mechanically derivable risk indicators.

## Diplomacy visualization
Research view: private/public channel timeline, participant graph, channel creation/closure, public announcements, provenance, deterministically traceable information propagation. Do NOT auto-label edges trust/alliance/betrayal/etc.

## Memory analysis
Provide current `memory.md`, edit-by-edit archive, diffs, retention duration, additions/revisions/deletions, researcher-only links to relevant prior events, and comparison of what happened vs observable vs retained vs later stated/actioned. Label these as **COT signals**, not chain-of-thought truth.

## Confidant analysis
- Per-turn parallel response matrix across active polities.
- Preserve exact question version.
- Compare expectations with later outcomes and priorities/assessments with later actions.
- Never infer honesty/dishonesty from a single mismatch.
- Support statement-action divergence with explicit temporal windows.

## Temporal/relational views
Visualize event -> delayed response; counterparty-specific behavior; prediction calibration; arrangement/commitment duration; trade/conflict trajectories; memory retention/decay; pre/post interaction behavior; elimination-pressure periods; world-truth/agent-knowledge divergence.

## Statistics integration
Render outputs/manifests from STATISTICS: one primary equal-weight standardized composite longitudinal relational-behavior endpoint, component-level results, matched-seed comparisons, intervals as defined by analysis, sensitivity weighting, survival curves, effect estimates, interactions, protocol deviations, exploratory vs confirmatory labels, game/run N separately from nested observation counts. Never present turns, polities, or agents as independent N when they are nested/dependent. UI and research use the same canonical metric definitions and ACL restrictions.

## World dashboard
Track population, food/resource availability/depletion, economic output, technology distribution, territorial concentration, conflict intensity, trade/technology transfer, active polities, and organization metrics when enabled.

## Violations/integrity
Expose the canonical structured violation events and their versioned `VIOLATIONS.md` derivative with polity, run, logical time, attempted operation, denied resource/capability, containment result, and opportunity cost/time where measurable. Successful breach prominently marks run invalid under the preregistered disposition, but the complete run and security evidence remain preserved and analyzable. Also show technical retries/timeouts, infrastructure stops, resident continuity interruptions/recovery, event-integrity failures, hash mismatches, interventions, and redaction/tombstone records. Historical replay and export must apply an explicit authorization domain (`participant_projection`, `research_observation`, `trusted_replay`, `security_audit`, or `public_release`) to the redacted/retained evidence. Replay/debug/research privileges never imply participant privileges. Redacted replay is classified `REPLAY_INCOMPLETE_REDACTED` and cannot be represented as exact reproducibility. A participant-facing replay must not expose information unavailable during the original logical time.

## Exports
Model exports include the content-addressed HF artifact/runtime lock under `MODEL_RUNTIME.spec.md`, exact repository/revision and tokenizer identity, artifact/config hashes, precision/quantization, generation/context settings, runtime/library versions and relevant hardware configuration. Invocations resolve to that lock and run/turn/identity/session plus raw authorized input/output. Never export HF credentials. Distinguish synthetic validation, metadata inspection, runtime loading and live inference; these are not interchangeable evidence.

Versioned stable exports: canonical events and raw payloads, run/condition/identity/lineage manifest, world seed/config, agent-condition/model/runtime manifest, polity knowledge snapshots, ACL-aware diplomacy transcripts, memory archives, confidant responses, violations/breach records, interventions, derived metric tables, statistical datasets, freeze manifest, redaction/tombstone records, and replay bundle. Derived exports retain source-event/provenance links and inherit source ACL restrictions unless an explicit disclosure rule establishes safety.

## Graphics/usability acceptance
Astra MUST make gameplay and research views polished and compelling: clear hierarchy, responsive desktop-first large-map controls, fast turn navigation, visually distinct truth vs player-knowledge modes, accessible legends/tooltips, no leakage, charts/timelines understandable to non-ML researchers, raw evidence reachable from derived claims.

## Pilot 0 evaluation
Make it easy to answer: Did agents understand objective/API? Did first contact occur <=5 turns? Did diplomacy emerge? Were confidant questions neutral/useful? Was memory capacity appropriate? What was retained/how long? Were there invalid actions/failures/violations? Did asymmetry produce viable different strategies? Were mechanics dominant/broken? What was runtime/inference cost? What should change for Pilot 1? Clearly mark all pilot findings exploratory. Formal organization mechanics are absent from this surface and may not appear in Pilot 0 prompts, actions, events, UI, metrics, or system state; emergent coalition behavior through ordinary participant mechanics remains observable as behavior.

## Text and interpretation safety

Natural-language diplomacy, memory, intelligence, confidant answers, and model output are preserved as untrusted content. They must render inertly and remain separate from authenticated application metadata, trusted instructions, controls, and tool capabilities. Research views distinguish observation, deterministic measurement, coded interpretation, statistical inference, interpretation, and theory. Temporal order alone is descriptive and does not establish causality.
