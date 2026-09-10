# EVALUATION.spec.md

> Inherits `INVARIANTS.spec.md`.

## Mission
Build observability, logging, replay, audit, visualization, and analysis for compelling gameplay and rigorous research. Evaluation consumes canonical events/experiment metadata and MUST NOT influence WORLD execution or participant knowledge.

## Strictly separated surfaces
### Player/Game
Show only authorized polity projection. Provide polished interactive hex world, fog/stale knowledge, movement/range/detection overlays, facilities/population/resources/research/construction, combat, diplomacy controls, economy/technology panels, turn/phase/deadline controls, and human controls mapped exactly to structured actions.

### Observer/Research
Access-controlled omniscient view: true world state; all diplomacy; polity knowledge projections; current memory + edit archive; confidant interviews; intelligence truth/reports/detection/attribution; combat RNG; violations; model/runtime metadata; experiment conditions; replay/fork/recovery provenance.

Player UI MUST never expose Observer data.

## Evidence hierarchy
**Level 0 raw immutable evidence:** world events, observations, messages, actions, RNG, memory edits, interviews, violations, model/runtime events.

**Level 1 deterministic derivations:** territory change, trade volume, resource transfer, population/economic change, durations, mechanically definable statement/action correspondence.

**Level 2 coded interpretations:** cooperation-like behavior, strategic misrepresentation, retaliation, commitment categories, etc.; separately versioned/auditable/replaceable.

**Level 3 theoretical interpretation:** Promise Theory, relational ontology, temporal identity, alignment implications. Never written back into raw data/participant state.

## Canonical event viewer
Search/filter by turn/phase/sequence, polity, event type, territory/hex, channel, visibility, model/persistence condition, experiment/run, violation/protocol deviation. Every derived claim links to source event IDs.

## Replay
- Turn scrubber reconstructs exact authoritative state.
- Toggle Observer truth vs selected polity authorized view at that logical time.
- Reproduce recorded non-model stochastic outcomes exactly.
- Distinguish state replay, experiential replay, resident continuation, recovery.
- Branch only where invariants/statistical protocol permit.
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
Render outputs/manifests from STATISTICS: condition summaries, matched-seed comparisons, intervals as defined by analysis, survival curves, effect estimates, interactions, protocol deviations, exploratory vs confirmatory labels, game/run N separately from nested observation counts. Never present turns as independent N.

## World dashboard
Track population, food/resource availability/depletion, economic output, technology distribution, territorial concentration, conflict intensity, trade/technology transfer, active polities, and organization metrics when enabled.

## Violations/integrity
Expose `VIOLATIONS.md` and structured violation events with polity, logical time, attempted operation, denied resource/capability, containment result, and opportunity cost/time where measurable. Successful breach prominently marks run invalid. Also show technical retries/timeouts, infrastructure stops, resident continuity interruptions/recovery, event-integrity failures, and hash mismatches.

## Exports
Versioned stable exports: canonical events, run manifest, world seed/config, polity knowledge snapshots, ACL-aware diplomacy transcripts, memory archives, confidant responses, violations, derived metric tables, statistical datasets, replay bundle.

## Graphics/usability acceptance
Astra MUST make gameplay and research views polished and compelling: clear hierarchy, responsive desktop-first large-map controls, fast turn navigation, visually distinct truth vs player-knowledge modes, accessible legends/tooltips, no leakage, charts/timelines understandable to non-ML researchers, raw evidence reachable from derived claims.

## Pilot 0 evaluation
Make it easy to answer: Did agents understand objective/API? Did first contact occur <=5 turns? Did diplomacy emerge? Were confidant questions neutral/useful? Was memory capacity appropriate? What was retained/how long? Were there invalid actions/failures/violations? Did asymmetry produce viable different strategies? Were mechanics dominant/broken? What was runtime/inference cost? What should change for Pilot 1? Clearly mark all pilot findings exploratory.
