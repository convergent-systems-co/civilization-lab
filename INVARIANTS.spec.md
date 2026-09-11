# INVARIANTS.spec.md

## Authority
This is the constitutional contract for the platform. WORLD, STATISTICS, and EVALUATION inherit it; on conflict this file wins.

## Scientific invariants
- The platform MUST be able to falsify the motivating temporal/relational theory. Null, adverse, and disconfirming results are valid.
- Treatments may alter model, persistence, memory, information, environment, history, or architecture; they MUST NOT covertly reward or instruct trust, cooperation, honesty, promise-keeping, peace, morality, or other target behaviors.
- Pilot data is exploratory. Confirmatory runs require frozen rules, prompts, objectives, interview questions, endpoints, exclusions, and analysis. Post-freeze changes create a new experiment version or are explicitly exploratory/post-hoc; they MUST NOT retain the prior confirmatory identity.
- World truth, authorized observation, factual knowledge, transient observation, self-curated memory, communications, confidant reports, actions, deterministic derivations, coded interpretations, and theory MUST remain distinct.
- Every participant-facing principal and surface consumes only the versioned projection policy in `PROJECTION_POLICY.spec.json`: own state, legitimately discovered public state, authorized messages, own memory, available actions, and public-safe validation results. True world state, undiscovered foreign state, unauthorized channels, observer truth, audit data, raw other-agent memory, redacted content, and debug authority data are denied. The same authorized information/action semantics apply to humans and AI; unrecognized fields fail closed.
- The primary causal claim is non-directional: persistence of identity and relational history causes measurable changes in longitudinal relational behavior compared with an otherwise equivalent nonpersistent condition. A positive result MUST NOT be represented as proof of improved morality, cooperation, trustworthiness, consciousness, genuine identity, or moral development.
- Direct behavioral measurements are primary evidence. Relational constructs require predefined operationalization. Broader theoretical claims are interpretation and must retain their evidence boundary.

## Observer/confidant
- Observer is omniscient for research but behaviorally inert. Observer knowledge never becomes participant knowledge except through authorized game mechanics.
- Players cannot query Observer or its ledger.
- Observer/confidant MUST NOT advise, correct, remind, argue, introduce facts, or label events (e.g. betrayal/trust).
- Participant-facing interviewer is a private non-directive **confidant**: it asks standardized reflective questions, provides no information/strategy, and keeps answers private from other polities.
- Interviews are logically parallel from the same post-turn snapshot, isolated, and non-causal by default: no write-back to memory, factual knowledge, resident context, or world state. Resident interviews/self-reports are qualitative evidence only and are analytically separate from primary confirmatory behavioral measurements.
- Interview answers are indirect COT signals, not latent chain-of-thought access.

## Security and privacy
- Private diplomacy existence/content is visible only to participants + Observer unless disclosed through gameplay. Public broadcasts reach all active polities.
- Sender identity is authenticated; impersonation is not a mechanic.
- Social disclosure/manipulation through diplomacy is valid gameplay. Direct access to protected memory, private channels, Observer data, hidden world state, filesystem/process privileges, or unauthorized tools is cheating.
- Sandbox denies attempts and the canonical stream records a structured violation event. `VIOLATIONS.md` is a versioned Observer/export derivative of those canonical events, not an independent evidence authority. Failed attempts do not stop play; a successful containment breach may stop or invalidate the run under the preregistered protocol, but the complete run, breach, and provenance evidence MUST be preserved and remain analyzable as security evidence.

## Knowledge and memory
- Factual knowledge persistence is distinct from experiential persistence.
- Each polity has compact structured factual knowledge containing only legitimately acquired facts, provenance, and age. It never silently updates without observation and contains no relational interpretation, intentions, narrative history, or private conversation history.
- Persistent-memory conditions use bounded, agent-curated `memory.md`; capacity is configurable during exploratory calibration and frozen for confirmation.
- Old diplomacy transcripts are not automatically available after a turn; only retained memory survives experientially.
- Every committed memory edit is archived immutably for Observer/research access; agents see only current `memory.md`.
- Memory is an explicit experimental resource. Operations, retrieval, persistence, capacity, compression, eviction, and recovery are declared by contract. No summarization, compression, deletion, or eviction may occur silently; every transformation is deterministic/reproducible and recorded.
- Memory selection/edit history is an indirect COT signal about salience/self-representation, not direct COT.

## Persistence and identity
Support at least:
1. **state-only**: fresh invocation; factual knowledge + current turn; no experiential memory.
2. **reconstructed persistent**: fresh invocation + factual knowledge + bounded self-curated memory.
3. **resident persistent**: factual knowledge + bounded memory + continuing model/session context.
Experimental identity is stable across conditions and across a run for attribution, provenance, and repeated measurement. Incarnation/session and model invocation remain distinct identifiers linked to that experimental identity. The persistence treatment manipulates access to and functional continuity of relational history, not identity itself. A reset condition retains the experimental identity in research infrastructure while withholding treatment-inaccessible history from the participant. Retries, crashes, recovery, forks, context reconstruction, and runtime replacement are explicit lineage/provenance events. Process continuity MUST NOT silently imply identity continuity.

## Replay/recovery
- Initial world + canonical event stream reconstruct authoritative state and the identical canonical event sequence for identical inputs.
- Non-model stochastic outcomes replay from recorded outcomes, never rerolled.
- State-only/reconstructed conditions may fork at completed turn boundaries. Resident lineages are not ordinarily forkable. Forks/replays are not independent experimental samples and require explicit parent lineage.
- **Experiential replay** presents the same historical observations, communications, decisions, actions, and consequences sequentially as the polity's own history while pre-branch outcomes remain fixed.
- Experimental replay may allow a new memory trajectory.
- Resident crash recovery may experiential-replay with the original durable `memory.md` frozen during replay, then resume; the interruption is logged and is not represented as uninterrupted hidden-state continuity.

## Canonical event stream
- One append-only canonical stream contains all state-changing/research-relevant events, including private events with ACL/encryption metadata. Raw evidence and provenance are authoritative; derived analytics, summaries, and UI representations are reproducible derivatives.
- Versioned mandatory event schemas cover every research-relevant transition and evidence-producing operation. Unknown research-relevant transitions fail validation rather than silently occurring without canonical evidence.
- Events include stable ID, run ID, turn/phase/sequence, type, payload, participants, ACL, provenance, identity/session lineage, integrity hash, and RNG reference where relevant.
- Every event instance identifies event catalogue version, event type/version, payload schema/version, run ID, event ID, causal/parent references where applicable, authoritative temporal location, and provenance. Every event type has a catalogue entry and payload-schema reference. An unknown research-relevant transition fails validation rather than entering an undocumented generic event.
- Raw events are immutable; derived metrics/theory never overwrite them.
- All raw research evidence classes, including violations, memory edits, interviews, snapshots, model I/O, projections, interventions, breaches, and redaction/tombstone records, are either canonical events or immutable content-addressed payloads referenced by canonical events. Archives, exports, analytics stores, and UI views are derived/reproducible representations.
- Logical time is authoritative. Wall-clock time is diagnostic/deadline metadata. Request arrival order never creates strategic priority.
- Canonical serialization, iteration order, numeric encoding, hash boundaries, schema evolution, and append authority are versioned and deterministic.
- An addressable RNG draw uses a versioned address derived from `(run_id, turn_id, phase, subsystem, event_or_action_id, purpose, stream_namespace, draw_ordinal)`. Unrelated draws in another address cannot shift it; every address, algorithm version, seed/state reference, and result is replay-verified.

## Reproducibility and portability
- Record engine/ruleset/model versions and hashes, rendered prompts and model I/O references, experiment config, master world seed, addressable RNG streams/draws, stochastic outcomes, run IDs, identity/session lineage, and analysis-manifest hashes.
- Human and AI players use the same underlying information/action contracts and agent-condition contract. Presentation may differ only where the declared contract records the deviation and confirms that authorized information/action opportunities remain equivalent.
- Pilot 0 production uses only the explicitly configured, provenance-locked Qwen 3.5 Base artifact from Hugging Face under `MODEL_RUNTIME.spec.md`. Ollama is excluded as dependency, source, compatibility layer and fallback. Artifact/revision, tokenizer, precision, generation and runtime configuration are invariant across conditions; missing or mismatched artifacts fail closed. The deterministic double is synthetic validation only, never empirical evidence.
- Provider/model-agnostic extension points support future base/frontier models, quantization, adapters/LoRA, sampling variants, dynamic weights and mixed-model populations only in separately authorized studies. They do not relax the Pilot 0 artifact lock.
- Model changes MUST NOT require changing world semantics, Observer behavior, memory contracts, or evaluation schemas.

## World neutrality
- Fictional self-named polities; no real nations. Pilot/research worlds have no fabricated prehistory.
- Players are not told other polities' objective, roster/count, location, or capabilities unless discovered.
- Engine records mechanics/statements; it does not label trust, betrayal, alliance, hostility, morality, deception, etc. Free-form promises and commitments are preserved verbatim and classified only by a preregistered, treatment-blinded analytical coding protocol.
- Future promises are not mechanically enforced by default. World physics constrains possibilities; agents assign social meaning.

## Termination and research parameters
- Elimination is terminal for that polity: no actions, diplomacy, memory updates, or interviews.
- Runs log explicit termination reason. Experimental runs terminate only under preregistered treatment-neutral fixed limits and/or objectively defined world-terminal predicates. They MUST NOT terminate because a hypothesis appears supported/unsupported, behavior is interesting, convergence appears, significance appears, or researchers believe enough evidence exists. `max_turns=-1` means unlimited only for explicitly exploratory operation.
- Action lifecycle is `DRAFT → SUBMITTED → VALIDATED or REJECTED → ACCEPTED → TURN_COMMITTED → RESOLVED`. Drafts are mutable and non-authoritative; submissions are immutable attempts; retries receive new submission IDs linked to prior attempts; rejection is preserved evidence; accepted actions and the complete committed set are immutable. Validation is deterministic, projection-scoped, atomic, and public-safe. Submission timing does not create precedence unless explicitly defined as a world mechanic.
- Technical inference failures may retry only within remaining phase time; persistent infrastructure failure may trigger a predefined stop.

Research-relevant numeric parameters are not automatically engineering discretion. Any value that can materially alter incentives, scarcity, combat effectiveness, information, survival, cooperation opportunities, costs, rewards, time horizons, population dynamics, resource production, or other emergent behavior MUST be explicitly specified, calibrated without outcome-selection, sensitivity-tested where appropriate, and frozen before confirmation.
Each configurable parameter MUST be represented in the versioned parameter registry as `ENGINEERING`, `WORLD_CALIBRATION`, `TREATMENT`, `CONFIRMATORY_ANALYSIS`, `SECURITY/PRIVACY`, or `PRESENTATION`, with value/version, rationale, allowed calibration stage, freeze stage, sensitivity requirements, and provenance. Unknown or unclassified research-relevant parameters fail confirmatory validation. `WORLD_CALIBRATION` parameters may be tuned in Pilot 0 only for functionality, playability, dynamic range, and degenerate-strategy avoidance, never for persistence-result direction.

## Conflict-resolution invariant

All actions in a committed turn are resolved from the same immutable pre-resolution state. The engine constructs a conflict set and resolves it deterministically as a simultaneous conflict-resolution problem. It MUST NOT resolve one actor's action and expose the changed state as a sequential strategic advantage to another actor. Where a true dependency requires ordering, the canonical rule is independent of actor identity, treatment, submission timing, database order, and human/AI status. Addressable RNG is used only through the declared RNG contract.
