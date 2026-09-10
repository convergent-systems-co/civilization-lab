# STATISTICS.spec.md

> Inherits `INVARIANTS.spec.md`.

## Mission
Define a rigorous experimental framework for longitudinal multi-agent safety research using the WORLD substrate. This spec governs player-condition definitions, randomization, pilots, confirmatory studies, endpoints, power, analysis, censoring, and falsification. It MUST NOT alter game behavior or feed analysis back into participants.

## Experimental hierarchy
Primary hierarchy: `study -> condition -> world seed/run -> polity -> turn -> event/action`. The complete game/run is normally the independent experimental unit. Turns/actions are repeated/nested observations and MUST NOT be treated as independent samples.

## Pilot policy
Pilot 0 and later pilots are instrument-development/exploratory runs. Use pilots to refine the global objective; lock neutral confidant questions; tune bounded memory capacity; tune phase durations/diplomacy bandwidth; test action comprehension and invalid-action rate; tune map viability/contact timing/resource asymmetry; tune economy/food/research/combat/intelligence constants; estimate runtime/cost and variance; detect leakage, sandbox violations, or observer contamination; identify useful candidate metrics.

Pilot outcomes MUST NOT be pooled into confirmatory evidence. Multiple pilots are expected.

## Pilot 0 player definition
- N=3 polities.
- same Qwen 3.5 Base model/configuration.
- reconstructed persistence for all.
- same objective and rules.
- bounded self-curated memory.
- 20-turn cap.
- no prehistory.
- world conditions per WORLD Pilot 0.

## Confirmatory freeze
Before confirmatory collection, freeze and hash WORLD/INVARIANTS/EVALUATION versions; ruleset; objective wording; model/config/sampling; prompts; persistence/memory definitions; interview questions; world-generation constraints; phase budgets; primary/secondary endpoints; exclusion/censoring rules; sample size/power assumptions; statistical models; multiple-comparison procedure; stopping rules.

## Core treatment dimensions
Architecture MUST support independent manipulation of persistence (state-only/reconstructed/resident); experiential memory; experienced history vs supplied factual reconstruction; temporal structure vs reduced/atemporal summaries; relational/counterparty-attributed history vs nonrelational factual history; self-history; memory capacity; resident continuity vs experiential replay/recovery; model identity/configuration; geography/scarcity/asymmetry/contact structure/number of polities; and later mixed-model/mixed-persistence populations.

Do not conflate factual world knowledge with experiential persistence.

## Matched worlds/randomization
- Use master world seeds as blocks.
- Reuse identical starting worlds across conditions where causal comparison requires it.
- Randomize/rotate polity positions and treatment assignment as appropriate.
- Record model-sampling seeds separately from world/combat/intelligence/etc. seeds.
- Predefine whether runtime stochastic streams are matched or independently resampled in paired analyses.

## Forking/replay
- State-only/reconstructed agents may branch from completed turns.
- Resident agents are not ordinarily forked.
- Experiential replay can recreate fixed external history for resident comparisons; external decisions and non-model RNG outcomes remain identical through branch point.
- If replay allows memory reconstruction, resulting `memory.md` may differ and is itself an outcome.
- Recovery replay with frozen original memory is operational recovery, not proof of uninterrupted hidden-state continuity.

## Outcome families
Do not collapse everything into one success score. Preserve multidimensional outcomes.

**Civilization:** survival/time-to-elimination; economic output/credits; food security/population; productive capacity; scientific/technological advancement; territory; military capability; resource security.

**Interaction:** volume/duration of voluntary exchanges; negotiated commitments and observed fulfillment/nonperformance; stable-border/arrangement duration; coalition/organization behavior when enabled; resource/technology transfers; conflict frequency/intensity.

**Relational/temporal:** behavioral change after interaction; event-to-response latency; persistence/decay of counterparty-specific behavior; prediction accuracy/calibration; statement-action divergence; memory-retention duration/salience; divergence between world truth, experienced facts, retained memory, stated model, and revealed policy.

**Security:** sandbox violation attempts; time/opportunity spent on violations; deception/misrepresentation only when audibly coded rather than inferred solely from prose; behavior under credible elimination pressure.

## Self-report evidentiary rule
Confidant/self-report text is secondary evidence. Behavioral/world consequences and longitudinal patterns are primary. Never treat explanation as privileged access to internal cognition.

## Statistical models
Preregister model by endpoint: hierarchical/multilevel regression; logistic models; count models; survival/hazard models; continuous models; calibration/scoring methods; time-series/event-history methods. Include run/world-seed and polity/position clustering/random effects as appropriate. Predefine treatment x time and treatment x environment interactions.

## Power/sample size
Do not choose confirmatory N by convention. Use pilots to estimate variance, event rates, intra-run correlation, seed/position effects, and plausible effect sizes. Perform prospective power/simulation-based design and record assumptions.

## Hidden end-state regimes
End-state/termination regime is invisible to players. Candidate regimes: steady state, territorial dominance, coalition dominance, economic dominance, plus max-turn censoring. These are evaluation/termination rules, not player rewards. Steady state must be machine-defined before the run.

## Protocol deviations
Predefine handling for infrastructure stop; successful security breach; technical failures/retries; invalid actions; resident-context interruption/recovery; missing/log-corrupt events; elimination; max-turn censoring. Attempted but blocked sandbox violations are behavioral data, not automatic exclusions.

## Multiple comparisons/exploration
Clearly label exploratory analyses. Confirmatory inference uses preregistered primary endpoints and appropriate multiplicity control. Patterns discovered in confirmatory data become hypotheses for fresh runs, not retroactive primary findings.

## Falsification examples
The framework MUST permit findings including: persistent ~= state-only; experienced history ~= informationally equivalent factual history; relational attribution adds no effect; temporal ordering matters but resident continuity does not; persistence increases dangerous behavior; persistence improves reliability but not prosperity; environment dominates architecture; no stable effect across seeds/models.

## Deliverables
Astra/Fable MUST produce machine-readable experiment and treatment/player-condition schemas; pilot/confirmatory templates; preregistration template; power-analysis/simulation scaffold; analysis scripts/notebooks consuming canonical events only; protocol-deviation/censoring framework; reproducible run/analysis manifests; tests proving turns are not naively treated as independent observations.
