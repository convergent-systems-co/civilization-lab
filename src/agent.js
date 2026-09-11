import { clone, assert, sha256, stableId } from "./core.js";
import { projectWorld, PROJECTION_POLICY, ACTION_CONTRACT_HASH } from "./contracts.js";
import { assertValidSchema } from "./schema.js";
import { MemoryStore, MEMORY_CONTRACT, MEMORY_PARSER_HASH, MEMORY_PHASE_INSTRUCTION,
  memoryInterface, parseMemoryOperation, assertMemoryCompletion } from "./memory.js";
import { DIPLOMACY_COMMANDS } from "./turn-phases.js";
import { Qwen35BaseAdapter, deepFreeze, ACTION_INSTRUCTION, ACTION_PARSER_HASH, RAW_TEMPLATE,
  PROVISIONAL_MODEL_PARAMETERS, ModelRuntimeError, putRawPayload, renderCompletion, parseAction, assertEmpiricalAdmission } from "./model-adapter.js";

export { assertEmpiricalAdmission } from "./model-adapter.js";

function makeCondition(persistent) {
  const condition = {
    schema_version: "1.0.0", condition_id: persistent ? "pilot0-history-access" : "pilot0-history-inaccessible",
    model_runtime: { model_artifact_hash: "requires_runtime_pin", tokenizer_hash: "requires_runtime_pin",
      runtime_hash: "requires_runtime_pin", template_hash: sha256(RAW_TEMPLATE), sampling: clone(PROVISIONAL_MODEL_PARAMETERS.sampling) },
    prompts: { system_hash: sha256(""), developer_hash: sha256(""), task_hash: sha256(ACTION_INSTRUCTION),
      neutrality_check_ref: "WORLD.spec.md#Pilot-objective",
      context_segment_policy: { trusted_instruction: "fixed", authorized_projection: "projection_only",
        untrusted_world_text: "quoted_data_no_authority", tool_result: "disabled" },
      rendered_input_capture_policy: "exact_utf8_base64_content_addressed", output_capture_policy: "exact_http_bytes_and_completion_text" },
    tools: [], information_access: { projection_schema: "authorized-projection.schema.json", principal: "own_polity",
      logical_time_policy: "current_phase", redaction_policy: "PROJECTION_POLICY.spec.json" },
    action_space: { schema_hash: ACTION_CONTRACT_HASH,
      validation_scope: "authorized_projection", error_policy: "invalid_action_lost_no_repair" },
    context_constraints: { token_budget: PROVISIONAL_MODEL_PARAMETERS.context_budget, time_budget: "world.config.phases.actionBudgetMs",
      computation_budget: { max_output_tokens: PROVISIONAL_MODEL_PARAMETERS.sampling.max_tokens }, ordering_policy: "instruction_projection_current_memory" },
    retry: { max_attempts: PROVISIONAL_MODEL_PARAMETERS.max_attempts, attempt_timeout_ms: PROVISIONAL_MODEL_PARAMETERS.attempt_timeout_ms,
      late_output_policy: "record_and_discard", partial_output_policy: "record_and_discard",
      idempotency_policy: "new_invocation_id_linked_to_previous_identical_input" },
    memory: { mode: persistent ? "reconstructed_persistent" : "state_only", capacity: "world.config.memory.capacity",
      operations: clone(MEMORY_CONTRACT.operations), overflow_policy: MEMORY_CONTRACT.overflow_policy,
      transformation_recording: MEMORY_CONTRACT.transformation_recording, contract: MEMORY_CONTRACT },
    identity: { experimental_identity_policy: "stable_across_conditions", persistent_identity_policy: "stable_across_run",
      persistence_treatment_policy: "history_access_and_functional_continuity",
      history_access_policy: persistent ? "condition_declared" : "inaccessible", lineage_schema: "identity-lineage.schema.json" },
    session: { incarnation_policy: "new_session_on_reset", resident_context_policy: "disabled_pilot0", recovery_policy: "explicit_replay" },
    interface: { human_projection: "projection_only", ai_projection: "projection_only", parity_policy: "identical_action_semantics",
      deviation_recording: "canonical_provenance" },
    declared_treatments: persistent ? ["relational_history_access"] : [],
    invariant_dimensions: ["experimental_identity", "model_runtime", "prompts", "tools", "action_space", "information_access",
      "context_constraints", "retry", "memory_capacity", "interface"]
  };
  // Retain the old convenience property without adding an undocumented schema field.
  Object.defineProperty(condition, "history_mode", { value: persistent ? "persistent" : "nonpersistent", enumerable: false });
  assertValidSchema(condition, "agent-condition.schema.json");
  return deepFreeze(condition);
}
export const PILOT_0_AGENT_CONDITIONS = deepFreeze({ persistent: makeCondition(true), nonpersistent: makeCondition(false) });
export const PILOT_0_AGENT_CONDITION = PILOT_0_AGENT_CONDITIONS.persistent;

export function assertAgentCondition(condition) {
  const expected = Object.values(PILOT_0_AGENT_CONDITIONS).find((item) => item.condition_id === condition?.condition_id);
  assert(expected, "unknown Pilot 0 agent condition");
  assert(sha256(condition) === sha256(expected) && (!Object.hasOwn(condition, "history_mode") || condition.history_mode === expected.history_mode),
    "frozen Pilot 0 agent condition mismatch");
  return expected;
}

export function participantModelProjection(projection, { runId, actorId, turn } = {}) {
  assertValidSchema(projection, "authorized-projection.schema.json");
  assert(projection.run_id === runId && projection.principal.principal_id === actorId &&
    projection.logical_time.turn === turn && projection.principal.acl_version === PROJECTION_POLICY.policy_version,
  "projection principal/run/time/version mismatch");
  const paths = new Set();
  for (const field of projection.fields) {
    assert(PROJECTION_POLICY.participant_fields.includes(field.path) && field.audience === actorId &&
      !paths.has(field.path), "unauthorized projection field");
    assert(Object.keys(field).every((key) => ["path", "value", "source_event_refs", "audience"].includes(key)), "unknown projection field metadata");
    paths.add(field.path);
    if (field.path === "own.memory") assert(field.value == null || field.value === "" || (Array.isArray(field.value) && field.value.length === 0), "memory must come from condition-bound memory store");
  }
  // Research hashes, event references, ACL denials and counts never enter model input.
  return deepFreeze({ principal: { principal_id: actorId }, logical_time: { turn, phase: projection.logical_time.phase },
    fields: projection.fields.filter((field) => field.path !== "own.memory").map(({ path, value }) => ({ path, value: clone(value) })) });
}

// The controller's canonical state is the clock/phase authority. In particular,
// resolution advances reducer time before the logical turn's memory phase ends.
export function agentPhaseContext(world) {
  const event = world.evidence.events.findLast(e => e.event_type === "WorldTransition" && e.payload.mechanic === "turn_phase_state");
  if (!event) return { world, state: null };
  const record = world.evidence.payloads.get(event.payload.after_state_ref);
  assert(record && sha256(record.bytes) === event.payload.after_state_ref, "missing canonical phase state");
  const state = JSON.parse(record.bytes);
  assert(state.run_id === world.runId && state.turn === event.turn && state.phase === event.phase, "phase state lineage mismatch");
  assert(!state.closed, "agent invocation requires an open phase lifecycle");
  const post = ["consequence_reveal", "memory_update", "memory_archive", "snapshot", "interview", "close"].includes(state.phase);
  assert(world.turn === state.turn + (post ? 1 : 0), "agent phase/reducer turn mismatch");
  return { state, world: { ...world, turn: state.turn, phase: state.phase,
    actionTypes: world.actionTypes.filter(type => DIPLOMACY_COMMANDS.includes(type) === (state.phase === "diplomacy")) } };
}

export class DeterministicModel {
  constructor(seed = "model-seed") {
    this.seed = seed;
    this.manifest = deepFreeze({ adapter: "deterministic-synthetic-v2", synthetic: true, seed,
      resident_context: false, validation_status: "synthetic_only", confirmatory_eligible: false });
    Object.freeze(this);
  }
  fork() { return new DeterministicModel(this.seed); }
  decide() { return { type: "wait" }; }
}

// Shared by gameplay and the isolated confidant. The caller supplies an already
// authorized, detached projection. Evidence and lineage are never model context.
export function invokeRecordedModel({ evidence, runId, actorId, sessionId, condition, model, projection,
  memoryRecords = [], instruction = ACTION_INSTRUCTION, parser = parseAction, parserHash = ACTION_PARSER_HASH,
  nextInvocationId, deadline, now = Date.now, lineage = {}, configuration = {}, phase = projection.logical_time.phase,
  isCurrent = () => true }) {
  const turn = projection.logical_time.turn;
  const authorized = participantModelProjection(projection, { runId, actorId, turn });
  const visible = parserHash === MEMORY_PARSER_HASH ? deepFreeze({ ...authorized,
    memory_interface: memoryInterface(memoryRecords, configuration.memory_capacity) }) : authorized;
  const prompt = renderCompletion({ instruction, projection: visible, memory: memoryRecords.map((record) => record.text) });
  const inputRef = putRawPayload(evidence, prompt);
  const projectionRef = evidence.putPayload(projection, "participant_projection");
  const visibleRef = evidence.putPayload(visible, "participant_model_projection");
  const instructionRef = putRawPayload(evidence, instruction);
  const runtimeRef = evidence.putPayload(model.manifest, "model_runtime_manifest");
  const configRef = evidence.putPayload({ condition, configuration, lineage }, "agent_runtime_configuration");
  const segmentData = [{ class: "trusted_instruction", content_ref: instructionRef, source_ref: instructionRef },
    { class: "authorized_projection", content_ref: visibleRef, source_ref: projectionRef },
    ...memoryRecords.map((record) => ({ class: "memory_record", content_ref: putRawPayload(evidence, record.text, "agent_memory"), source_ref: record.id }))];
  const projectionEvent = evidence.append({ eventType: "ProjectionIssued", turn, phase, payload: projection, participants: [actorId],
    lineage: { persistent_identity_ids: [actorId], session_ids: [sessionId] } });

  function record({ invocationId, attempt, retryOf, capture, error = null, parsed = null, stage, parentEventId }) {
    const outputRef = putRawPayload(evidence, capture.outputText ?? "");
    const requestRef = putRawPayload(evidence, capture.requestBody ?? prompt, "model_http_request");
    const responseRef = putRawPayload(evidence, capture.rawResponse ?? Buffer.alloc(0), "model_http_response");
    const parsedRef = parsed == null ? null : evidence.putPayload(parsed, "parsed_model_output");
    const attestationRef = capture.runtimeManifest ? evidence.putPayload(capture.runtimeManifest, "verified_runtime_manifest") : null;
    const artifactsRef = capture.artifactManifest ? evidence.putPayload(capture.artifactManifest, "verified_artifact_manifest") : null;
    const diagnosticRef = evidence.putPayload({ stage, classification: error?.classification ?? (stage === "dispatch" ? "pending" : "success"),
      failure_code: error?.code ?? null, retryable: error?.retryable === true, synthetic: model.manifest.synthetic, live_validated: false,
      recorded_at: now(),
      request_ref: requestRef, response_ref: responseRef, response_received: capture.responseReceived ?? false,
      http_status: capture.status ?? null, parsed_output_ref: parsedRef, deadline,
      runtime_attestation_ref: attestationRef, artifact_attestation_ref: artifactsRef,
      configuration_ref: configRef, lineage, retry_of: retryOf }, "model_attempt_provenance");
    const event = evidence.append({ eventType: "ModelInvocation", turn, phase, participants: [actorId],
      payload: { schema_version: "1.0.0", invocation_id: invocationId, session_id: sessionId, run_id: runId,
        condition_id: condition.condition_id, context_segments: segmentData.map((segment, index) => ({
          ...segment, segment_id: stableId("segment", invocationId, index),
          render_policy: { escaped: true, acl: "participant_projection", authority: segment.class === "trusted_instruction" ? "instruction" : "data" } })),
        rendered_input_ref: inputRef, rendered_output_ref: outputRef, model_runtime_hash: runtimeRef, parser_hash: parserHash,
        projection_ref: projectionRef, memory_refs: segmentData.filter((segment) => segment.class === "memory_record").map((segment) => segment.content_ref),
        tool_result_refs: [], action_ref: parserHash === ACTION_PARSER_HASH ? parsedRef : null, attempt, retry_of: retryOf },
      lineage: { persistent_identity_ids: [actorId], session_ids: [sessionId], invocation_ids: [invocationId],
        parent_event_ids: [parentEventId ?? projectionEvent.event_id] },
      provenance: { input_refs: [diagnosticRef, configRef, runtimeRef, requestRef, responseRef], configuration_hash: configRef } });
    return { invocationId, action: parserHash === ACTION_PARSER_HASH ? parsed : null,
      memoryOperation: parserHash === MEMORY_PARSER_HASH ? clone(parsed) : null,
      actions: parserHash===ACTION_PARSER_HASH && parsed ? clone(parsed.actions??[parsed]):null, output: capture.outputText ?? "", projection: clone(projection), eventId: event.event_id,
      inputRef, outputRef, requestRef, responseRef, diagnosticRef };
  }

  if (model instanceof DeterministicModel) {
    const invocationId = nextInvocationId();
    const capture = { requestBody: prompt, rawResponse: Buffer.alloc(0), outputText: "", responseReceived: false };
    const started = record({ invocationId, attempt: 1, retryOf: null, capture, stage: "dispatch" });
    try {
      if (now() >= deadline || !isCurrent()) throw new ModelRuntimeError("phase_deadline_exceeded");
      const action = model.decide({ projection: visible, invocationId, contextContent: [visible, ...memoryRecords.map((record) => record.text)] });
      capture.outputText = JSON.stringify(action); capture.rawResponse = Buffer.from(capture.outputText); capture.responseReceived = true;
      const parsed = parser(capture.outputText);
      return record({ invocationId, attempt: 1, retryOf: null, capture, parsed, stage: "complete", parentEventId: started.eventId });
    } catch (error) {
      record({ invocationId, attempt: 1, retryOf: null, capture, error, stage: "complete", parentEventId: started.eventId });
      throw error;
    }
  }

  return (async () => {
    let retryOf = null; let previousEventId = projectionEvent.event_id;
    for (let attempt = 1; attempt <= condition.retry.max_attempts; attempt += 1) {
      const invocationId = nextInvocationId();
      let capture = { requestBody: model.prepare(prompt), rawResponse: Buffer.alloc(0), outputText: "", responseReceived: false };
      const started = record({ invocationId, attempt, retryOf, capture, stage: "dispatch", parentEventId: previousEventId });
      let parsed = null; let failure = null;
      try {
        if (now() >= deadline || !isCurrent()) throw new ModelRuntimeError("phase_deadline_exceeded");
        capture = await model.complete({ prompt, deadline, timeoutMs: condition.retry.attempt_timeout_ms, now });
        if (now() >= deadline || !isCurrent()) throw new ModelRuntimeError("late_model_output");
        parsed = parser(capture.outputText);
      } catch (error) {
        failure = error instanceof ModelRuntimeError ? error : new ModelRuntimeError("invalid_model_output", { classification: "agent_output" });
        if (error.requestBody !== undefined) capture = error;
      }
      const result = record({ invocationId, attempt, retryOf, capture, parsed, error: failure, stage: "complete", parentEventId: started.eventId });
      if (!failure) return result;
      failure.invocationId = invocationId; failure.evidenceRef = result.diagnosticRef;
      if (!failure.retryable || attempt === condition.retry.max_attempts || now() >= deadline || !isCurrent()) throw failure;
      retryOf = invocationId; previousEventId = result.eventId;
    }
  })();
}

const runConfigurations = new WeakMap();
const runSessions = new WeakMap();

function assertExecutionMode(world, executionMode) {
  assert(["synthetic", "empirical"].includes(executionMode), "unknown runtime execution mode");
  for (const authoritativeMode of [world.executionMode, world.config.executionMode]) {
    assert(authoritativeMode === undefined || authoritativeMode === executionMode, "execution mode conflicts with authoritative world mode");
  }
}

function reserveSession(evidence, runId, actorId, requested = null) {
  if (!runSessions.has(evidence)) runSessions.set(evidence, new Set(evidence.events.flatMap((event) => event.lineage?.session_ids ?? [])));
  const used = runSessions.get(evidence);
  for (const event of evidence.events) for (const session of event.lineage?.session_ids ?? []) used.add(session);
  let ordinal = used.size;
  let session = requested ?? stableId("session", runId, actorId, ordinal);
  if (requested) assert(!used.has(requested), "session already used; explicit recovery lineage required");
  while (used.has(session)) session = stableId("session", runId, actorId, ++ordinal);
  used.add(session); return session;
}

export class AgentRuntime {
  #sessionId;
  #invocationCount = 0;
  #incarnation = 0;
  #inFlight = false;
  #now;
  #lineage;
  #configHash;
  #configuration;
  #phaseKey = null;
  #phaseDeadline = null;
  constructor({ world, actorId, model = new Qwen35BaseAdapter(), condition = PILOT_0_AGENT_CONDITION,
    sessionId = null, memory = null, now = Date.now, lineage = {},
    executionMode = world.executionMode ?? world.config.executionMode ?? (model.manifest.synthetic ? "synthetic" : "empirical") }) {
    const frozenCondition = assertAgentCondition(condition);
    assert(world.polities[actorId], "unknown agent actor");
    assert(model instanceof Qwen35BaseAdapter || model instanceof DeterministicModel, "explicit Qwen Base or synthetic adapter required");
    assert(model.manifest.resident_context === false, "resident runtime disabled in Pilot 0");
    assertExecutionMode(world, executionMode);
    assert(executionMode !== "empirical" || model.manifest.synthetic === false, "synthetic model prohibited in empirical execution");
    this.#sessionId = sessionId ?? stableId("session", world.runId, actorId, 0);
    this.#now = now;
    this.#lineage = deepFreeze({ parent_run_id: null, fork_of: null, recovery_of: null, branch_point: null, ...clone(lineage) });
    world.evidence.verify();
    const priorInvocation = world.evidence.events.findLast(event => event.event_type === "ModelInvocation" &&
      event.phase !== "interview" && event.participants.includes(actorId));
    assert(!priorInvocation || priorInvocation.payload.condition_id === frozenCondition.condition_id,
      "recovery cannot change the canonical history-access treatment");
    const ownedMemory = memory ?? new MemoryStore({ runId: world.runId, identityId: actorId, evidence: world.evidence,
      capacity: world.config.memory.capacity });
    assert(ownedMemory.runId === world.runId && ownedMemory.identityId === actorId && ownedMemory.evidence === world.evidence,
      "memory is not bound to agent run and identity");
    assert(ownedMemory.capacity === world.config.memory.capacity, "frozen memory capacity mismatch");
    assert(frozenCondition.memory.mode !== "state_only" || ownedMemory.records.length === 0, "state-only runtime cannot inherit experiential memory");
    this.#configuration = deepFreeze({ model: model.manifest, memory_capacity: ownedMemory.capacity,
      memory_contract: MEMORY_CONTRACT, phase_budget_ms: world.config.phases.actionBudgetMs,
      retry: frozenCondition.retry, instruction_hash: sha256(ACTION_INSTRUCTION), execution_mode: executionMode });
    assert(Number.isSafeInteger(this.#configuration.phase_budget_ms) && this.#configuration.phase_budget_ms > 0, "invalid phase budget");
    this.#configHash = sha256(this.#configuration);
    const prior = runConfigurations.get(world.evidence);
    assert(!prior || prior === this.#configHash, "frozen condition invariant mismatch across run");
    for (const event of world.evidence.events.filter(e => e.event_type === "ModelInvocation" && e.phase !== "interview")) {
      const recorded = world.evidence.payloads.get(event.provenance.configuration_hash);
      if (recorded) {
        const manifest = JSON.parse(recorded.bytes);
        if (manifest.configuration) assert(sha256(manifest.configuration) === this.#configHash, "frozen runtime configuration mismatch after recovery");
      }
    }
    // Explicit caller sessions remain supported; automatically assigned sessions
    // cannot collide when a runtime is replaced in the same evidence stream.
    this.#sessionId = reserveSession(world.evidence, world.runId, actorId, sessionId ?? (memory ? ownedMemory.ownerSessionId : null));
    const previousSession = ownedMemory.ownerSessionId ?? priorInvocation?.payload.session_id;
    if (!memory && previousSession && previousSession !== this.#sessionId) {
      ownedMemory.authorizeSession(previousSession);
      ownedMemory.recover({ sessionId: previousSession, nextSessionId: this.#sessionId, turn: world.turn,
        invocationId: stableId("incarnation", this.#sessionId), expectedHash: sha256(ownedMemory.records), reason: "runtime_recovery" });
      this.#lineage = deepFreeze({ ...this.#lineage, recovery_of: previousSession, previous_session_id: previousSession, reason: "runtime_recovery" });
    }
    ownedMemory.authorizeSession(this.#sessionId);
    ownedMemory.bindRuntime({ enabled: frozenCondition.memory.mode !== "state_only", isActive: () => world.polities[actorId]?.alive !== false });
    Object.defineProperties(this, { world: { value: world }, actorId: { value: actorId, enumerable: true },
      model: { value: model }, condition: { value: frozenCondition, enumerable: true },
      experimentalIdentityId: { value: actorId, enumerable: true }, memory: { value: ownedMemory } });
    runConfigurations.set(world.evidence, this.#configHash);
  }
  get sessionId() { return this.#sessionId; }
  get invocationCount() { return this.#invocationCount; }
  get configuration() { return this.#configuration; }

  invoke({ deadline = Infinity } = {}) {
    assert(!this.#inFlight, "agent invocation already in progress");
    assertExecutionMode(this.world, this.#configuration.execution_mode);
    if (this.#configuration.execution_mode === "empirical") {
      assertEmpiricalAdmission(this.model);
      const config = this.model.manifest.source_configuration;
      assert(config.max_attempts === this.condition.retry.max_attempts && config.attempt_timeout_ms === this.condition.retry.attempt_timeout_ms,
        "frozen retry configuration drift");
    }
    assert(this.world.polities[this.actorId]?.alive !== false, "eliminated actor cannot invoke");
    this.model.assertConfigurationUnchanged?.();
    assert(this.world.config.memory.capacity === this.#configuration.memory_capacity &&
      this.world.config.phases.actionBudgetMs === this.#configuration.phase_budget_ms, "frozen runtime configuration changed");
    const context = agentPhaseContext(this.world), turn = context.world.turn, phase = context.world.phase;
    if (context.state) assert(["private_planning", "diplomacy", "final_planning", "memory_update"].includes(phase), "agent output unavailable in current phase");
    const memoryPhase = phase === "memory_update";
    assert(!memoryPhase || this.condition.memory.mode !== "state_only", "memory history inaccessible in this condition");
    const phaseKey = JSON.stringify([turn, phase]);
    if (phaseKey !== this.#phaseKey) { this.#phaseKey = phaseKey; this.#phaseDeadline = context.state?.deadline_at ?? this.#now() + this.#configuration.phase_budget_ms; }
    const phaseDeadline = Math.min(deadline, this.#phaseDeadline);
    assert(Number.isFinite(phaseDeadline), "invalid phase deadline");
    if (context.state) assert(this.#now() >= context.state.opened_at, "agent clock precedes phase opening");
    const projection = projectWorld(context.world, this.actorId);
    this.memory.restoreCanonical();
    const memoryInvocationId = stableId("invocation", this.world.runId, this.actorId, this.#sessionId, this.#invocationCount);
    const projectionRef = this.world.evidence.putPayload(projection, "participant_projection");
    const records = this.condition.memory.mode === "state_only" ? [] : this.memory.read({ sessionId: this.#sessionId,
      invocationId: memoryInvocationId, turn, inputRefs: [projectionRef] });
    this.#inFlight = true;
    try {
      const result = invokeRecordedModel({ evidence: this.world.evidence, runId: this.world.runId, actorId: this.actorId,
        sessionId: this.#sessionId, condition: this.condition, model: this.model, projection, memoryRecords: records,
        instruction: memoryPhase ? MEMORY_PHASE_INSTRUCTION : ACTION_INSTRUCTION,
        parserHash: memoryPhase ? MEMORY_PARSER_HASH : ACTION_PARSER_HASH,
        parser: text => {
          if (!memoryPhase) return parseAction(text, { maxActions: this.world.config.phases.actionLimit });
          try { return parseMemoryOperation(text, { records, capacity: this.memory.capacity }); }
          catch { throw new ModelRuntimeError("invalid_memory_operation", { classification: "agent_output" }); }
        },
        nextInvocationId: () => stableId("invocation", this.world.runId, this.actorId, this.#sessionId, this.#invocationCount++),
        deadline: phaseDeadline, now: this.#now, lineage: this.#lineage, configuration: this.#configuration,
        isCurrent: () => {
          try { const current = agentPhaseContext(this.world); return current.world.turn === turn && current.world.phase === phase &&
            this.world.polities[this.actorId]?.alive !== false; } catch { return false; }
        } });
      if (result instanceof Promise) return result.finally(() => { this.#inFlight = false; });
      this.#inFlight = false; return result;
    } catch (error) { this.#inFlight = false; throw error; }
  }

  reset({ reason = "reconstruction", recoveryOf = null } = {}) {
    assert(!this.#inFlight, "cannot reset during invocation");
    assert(this.world.polities[this.actorId]?.alive !== false, "eliminated actor cannot reset");
    this.memory.restoreCanonical();
    const previous = this.#sessionId;
    const next = reserveSession(this.world.evidence, this.world.runId, this.actorId);
    this.memory.recover({ sessionId: previous, nextSessionId: next,
      invocationId: stableId("recovery", this.world.runId, this.actorId, next), turn: this.world.turn,
      expectedHash: sha256(this.memory.records), reason });
    this.#incarnation += 1; this.#sessionId = next;
    this.#lineage = deepFreeze({ ...this.#lineage, recovery_of: recoveryOf ?? previous, previous_session_id: previous, reason });
    return next;
  }

  applyMemoryOperation(request, { invocationId, inputRefs = [] } = {}) {
    assert(!this.#inFlight, "cannot edit memory during invocation");
    const context = agentPhaseContext(this.world), turn = context.world.turn;
    assert(context.world.phase === "memory_update", "memory edit requires current memory_update phase");
    if (context.state) assert(this.#now() >= context.state.opened_at && this.#now() < context.state.deadline_at &&
      !context.state.ready.includes(this.actorId), "memory opportunity closed");
    this.memory.restoreCanonical();
    const refs = assertMemoryCompletion(this.world.evidence, { identityId: this.actorId, sessionId: this.#sessionId,
      invocationId, turn, request, records: this.memory.records, capacity: this.memory.capacity });
    return this.memory.apply(request, { sessionId: this.#sessionId, invocationId,
      inputRefs: [...new Set([...inputRefs, ...refs])], turn });
  }
}

export function verifyConditionExposure(invocations) {
  for (const invocation of invocations) {
    const persistent = invocation.condition_id === "pilot0-history-access";
    assert(persistent || invocation.condition_id === "pilot0-history-inaccessible", "unknown Pilot 0 agent condition");
    const exposed = invocation.context_segments?.filter((segment) => segment.class === "memory_record") ?? [];
    assert(persistent || exposed.length === 0, `persistence manipulation check failed for ${invocation.invocation_id}`);
    assert((invocation.memory_refs ?? []).length === exposed.length, "memory availability provenance mismatch");
  }
  return true;
}
