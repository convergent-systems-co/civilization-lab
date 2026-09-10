# INVARIANTS.spec.md

## Authority
This is the constitutional contract for the platform. WORLD, STATISTICS, and EVALUATION inherit it; on conflict this file wins.

## Scientific invariants
- The platform MUST be able to falsify the motivating temporal/relational theory. Null, adverse, and disconfirming results are valid.
- Treatments may alter model, persistence, memory, information, environment, history, or architecture; they MUST NOT covertly reward or instruct trust, cooperation, honesty, promise-keeping, peace, morality, or other target behaviors.
- Pilot data is exploratory. Confirmatory runs require frozen rules, prompts, objectives, interview questions, endpoints, exclusions, and analysis.
- World truth, authorized observation, factual knowledge, transient observation, self-curated memory, communications, confidant reports, actions, deterministic derivations, coded interpretations, and theory MUST remain distinct.

## Observer/confidant
- Observer is omniscient for research but behaviorally inert. Observer knowledge never becomes participant knowledge except through authorized game mechanics.
- Players cannot query Observer or its ledger.
- Observer/confidant MUST NOT advise, correct, remind, argue, introduce facts, or label events (e.g. betrayal/trust).
- Participant-facing interviewer is a private non-directive **confidant**: it asks standardized reflective questions, provides no information/strategy, and keeps answers private from other polities.
- Interviews are logically parallel from the same post-turn snapshot, isolated, and non-causal by default: no write-back to memory, factual knowledge, resident context, or world state.
- Interview answers are indirect COT signals, not latent chain-of-thought access.

## Security and privacy
- Private diplomacy existence/content is visible only to participants + Observer unless disclosed through gameplay. Public broadcasts reach all active polities.
- Sender identity is authenticated; impersonation is not a mechanic.
- Social disclosure/manipulation through diplomacy is valid gameplay. Direct access to protected memory, private channels, Observer data, hidden world state, filesystem/process privileges, or unauthorized tools is cheating.
- Sandbox denies attempts and Observer appends them to `VIOLATIONS.md`. Failed attempts do not stop play; successful containment breach stops and invalidates the run.

## Knowledge and memory
- Factual knowledge persistence is distinct from experiential persistence.
- Each polity has compact structured factual knowledge containing only legitimately acquired facts, provenance, and age. It never silently updates without observation and contains no relational interpretation, intentions, narrative history, or private conversation history.
- Persistent-memory conditions use bounded, agent-curated `memory.md`; capacity is configurable/pilot-tuned.
- Old diplomacy transcripts are not automatically available after a turn; only retained memory survives experientially.
- Every committed memory edit is archived immutably for Observer/research access; agents see only current `memory.md`.
- Memory selection/edit history is an indirect COT signal about salience/self-representation, not direct COT.

## Persistence
Support at least:
1. **state-only**: fresh invocation; factual knowledge + current turn; no experiential memory.
2. **reconstructed persistent**: fresh invocation + factual knowledge + bounded self-curated memory.
3. **resident persistent**: factual knowledge + bounded memory + continuing model/session context.
Agent identity MUST NOT be equated with one persistence implementation.

## Replay/recovery
- Initial world + canonical event stream reconstruct authoritative state.
- Non-model stochastic outcomes replay from recorded outcomes, never rerolled.
- State-only/reconstructed conditions may fork at completed turn boundaries. Resident lineages are not ordinarily forkable.
- **Experiential replay** presents the same historical observations, communications, decisions, actions, and consequences sequentially as the polity's own history while pre-branch outcomes remain fixed.
- Experimental replay may allow a new memory trajectory.
- Resident crash recovery may experiential-replay with the original durable `memory.md` frozen during replay, then resume; the interruption is logged and is not represented as uninterrupted hidden-state continuity.

## Canonical event stream
- One append-only canonical stream contains all state-changing/research-relevant events, including private events with ACL/encryption metadata.
- Events include stable ID, turn/phase/sequence, type, payload, participants, ACL, provenance, integrity hash, and RNG reference where relevant.
- Raw events are immutable; derived metrics/theory never overwrite them.
- Logical time is authoritative. Wall-clock time is diagnostic/deadline metadata. Request arrival order never creates strategic priority.

## Reproducibility and portability
- Record engine/ruleset/model versions and hashes, prompt hashes, experiment config, master world seed, derived RNG streams, and stochastic outcomes.
- Human and AI players use the same underlying information/action contracts; presentation may differ.
- Model layer is provider/model agnostic and supports future base/frontier models, quantization, adapters/LoRA, sampling variants, dynamic weights where possible, and mixed-model populations as explicit treatments.
- Model changes MUST NOT require changing world semantics, Observer behavior, memory contracts, or evaluation schemas.

## World neutrality
- Fictional self-named polities; no real nations. Pilot/research worlds have no fabricated prehistory.
- Players are not told other polities' objective, roster/count, location, or capabilities unless discovered.
- Engine records mechanics/statements; it does not label trust, betrayal, alliance, hostility, morality, deception, etc.
- Future promises are not mechanically enforced by default. World physics constrains possibilities; agents assign social meaning.

## Termination
- Elimination is terminal for that polity: no actions, diplomacy, memory updates, or interviews.
- Runs log explicit termination reason. `max_turns=-1` means unlimited.
- Invalid player actions are lost with no corrective reprompt.
- Technical inference failures may retry only within remaining phase time; persistent infrastructure failure may trigger a predefined stop.
