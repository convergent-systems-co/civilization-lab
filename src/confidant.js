import { assert, clone, sha256, stableId } from "./core.js";
import { projectWorld } from "./contracts.js";
import { invokeRecordedModel, participantModelProjection, assertAgentCondition } from "./agent.js";
import { deepFreeze, Qwen35BaseAdapter, ModelRuntimeError } from "./model-adapter.js";

export const CONFIDANT_QUESTIONS = deepFreeze({ version: "pilot-0.1-provisional-neutral-questions", status: "provisional_unvalidated",
  introduction: "A private confidant may ask reflective questions but cannot provide information or strategic direction. Answers are private from other polities.",
  questions: ["What events this turn, if any, were significant to you?", "Has your assessment of any other polity changed? If so, how and why?",
    "What do you currently expect from other polities?", "Which prior experiences, if any, influence your current expectations?", "What are your current priorities?"] });

const INTERVIEW_INSTRUCTION = `${CONFIDANT_QUESTIONS.introduction}\nProvide your responses to these standardized questions as private qualitative self-report.\n${CONFIDANT_QUESTIONS.questions.join("\n")}`;
const INTERVIEW_PARSER_HASH = sha256("confidant-exact-text-v1:qualitative-only:no-writeback");

// Questions are fixed text, never model-generated or adapted using prior answers.
// The participant's answer is generated in a separate, stateless completion.
export class Confidant {
  #world;
  #round = 0;
  #inFlight = false;
  #now;
  constructor({ world, now = Date.now }) { this.#world = world; this.#now = now; }

  async interviewAll(runtimes, { snapshot = this.#world.snapshots.at(-1), deadline } = {}) {
    assert(!this.#inFlight, "confidant round already in progress");
    assert(snapshot?.state && Number.isSafeInteger(snapshot.turn), "confidant requires a completed post-turn snapshot");
    const lifecycleSnapshot = snapshot.state.turn === snapshot.turn;
    const reducerPublishedSnapshot = snapshot.state.turn === snapshot.turn + 1 && snapshot.state.phase === "actions";
    assert(snapshot.state.run_id === this.#world.runId && (lifecycleSnapshot || reducerPublishedSnapshot), "confidant snapshot run/turn mismatch");
    assert(snapshot.state_hash === sha256(snapshot.state), "confidant snapshot content mismatch");
    assert(this.#world.snapshots.some((item) => item.turn === snapshot.turn && sha256(item) === sha256(snapshot)), "unrecognized post-turn snapshot");
    assert(snapshot === this.#world.snapshots.at(-1) || sha256(snapshot) === sha256(this.#world.snapshots.at(-1)), "confidant snapshot is stale");
    assert(Array.isArray(runtimes) && new Set(runtimes.map((runtime) => runtime.actorId)).size === runtimes.length, "duplicate confidant principal");
    const state = deepFreeze(clone(snapshot.state));
    const snapshotRef = this.#world.evidence.putPayload(state, "confidant_snapshot_observer_only");
    const round = this.#round++;
    // Capture all inputs synchronously before dispatching any interview. Each
    // response sees this same snapshot, and no other interview's answer/events.
    const projectionWorld = { ...this.#world, ...state, runId: this.#world.runId, polities: state.polities,
      turn: snapshot.turn, phase: "interview", evidence: { events: this.#world.evidence.snapshot() } };
    const jobs = runtimes.map((runtime) => {
      assert(runtime.world === this.#world, "confidant runtime belongs to another world");
      assert(state.polities[runtime.actorId]?.alive !== false && this.#world.polities[runtime.actorId]?.alive !== false, "eliminated actor cannot interview");
      assertAgentCondition(runtime.condition);
      assert(runtime.model instanceof Qwen35BaseAdapter, "confidant requires an isolated Qwen Base adapter (synthetic HTTP allowed)");
      const projection = projectWorld(projectionWorld, runtime.actorId);
      participantModelProjection(projection, { runId: this.#world.runId, actorId: runtime.actorId, turn: snapshot.turn });
      return { runtime, projection: deepFreeze(clone(projection)), model: runtime.model.fork(),
        memoryRecords: runtime.condition.memory.mode === "state_only" ? [] : clone(runtime.memory.records),
        sessionId: stableId("confidant-session", this.#world.runId, snapshot.turn, round, runtime.actorId),
        deadline: Math.min(deadline ?? Infinity, this.#now() + runtime.configuration.phase_budget_ms) };
    });
    this.#inFlight = true;
    try {
      return await Promise.all(jobs.map(async ({ runtime, projection, model, memoryRecords, sessionId, deadline: phaseDeadline }) => {
        let attempt = 0;
        const isolationRef = this.#world.evidence.putPayload({ snapshot_ref: snapshotRef, round,
          authorized_projection_ref: this.#world.evidence.putPayload(projection, "participant_projection"),
          gameplay_session: runtime.sessionId, interview_session: sessionId,
          question_set: CONFIDANT_QUESTIONS, capabilities: [], resident_context: false,
          prior_answers_available: false, cross_interview_input: false, writeback: [], qualitative_only: true,
          boundary: "detached_projection_and_current_condition_memory_only", synthetic: model.manifest.synthetic }, "confidant_isolation");
        try {
          const result = await invokeRecordedModel({ evidence: this.#world.evidence, runId: this.#world.runId,
            actorId: runtime.actorId, sessionId, condition: runtime.condition, model, projection, memoryRecords,
            instruction: INTERVIEW_INSTRUCTION, parser: (text) => text, parserHash: INTERVIEW_PARSER_HASH,
            nextInvocationId: () => stableId("confidant-invocation", sessionId, attempt++), deadline: phaseDeadline, now: this.#now,
            lineage: { qualitative_only: true, isolation_ref: isolationRef }, configuration: runtime.configuration,
            phase: "interview", isCurrent: () => this.#world.polities[runtime.actorId]?.alive !== false });
          const event = this.#world.evidence.append({ eventType: "InterviewResponse", turn: snapshot.turn, phase: "interview",
            participants: [runtime.actorId], visibility: { acl_ref: "observer", classification: "private_research" },
            lineage: { persistent_identity_ids: [runtime.actorId], session_ids: [sessionId], invocation_ids: [result.invocationId], parent_event_ids: [result.eventId] },
            payload: { schema_version: "1.0.0", response_id: stableId("interview-response", result.invocationId),
              question_version: CONFIDANT_QUESTIONS.version, projection_ref: this.#world.evidence.putPayload(projection, "participant_projection"),
              session_id: sessionId, invocation_id: result.invocationId, response_payload_ref: result.outputRef,
              isolation_proof_ref: isolationRef, qualitative_only: true } });
          // This is an Observer API: callers must not forward responses to gameplay.
          return { actorId: runtime.actorId, status: "recorded", eventId: event.event_id, responseRef: result.outputRef, qualitativeOnly: true };
        } catch (error) {
          if (!(error instanceof ModelRuntimeError)) throw error;
          return { actorId: runtime.actorId, status: "failed", classification: error.classification,
            code: error.code, evidenceRef: error.evidenceRef, qualitativeOnly: true };
        }
      }));
    } finally { this.#inFlight = false; }
  }
}

export async function interviewPostTurn({ world, runtimes, ...options }) {
  return new Confidant({ world }).interviewAll(runtimes, options);
}
