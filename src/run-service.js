import { assert, clone, sha256, stableId } from "./core.js";
import { commitTurn, projectWorld } from "./contracts.js";
import { resolveTurn } from "./world.js";
import { reconstructRun } from "./replay.js";
import { RunCoordinator, SignedArchive } from "./archive.js";
import { TurnPhases, phaseRuntimes, executeTurnPhaseCommand } from "./turn-phases.js";

const VERSION = "pilot0-run-service-v1";
function restore(bundle) {
  const recovered = reconstructRun(bundle, { allowPendingCommit: true });
  // The replay reducer may not need every captured raw payload, but the archive
  // must retain them (including failed calls, discarded output, and memory I/O).
  for (const [ref, payload] of Object.entries(bundle.payloads)) recovered.world.evidence.payloads.set(ref, clone(payload));
  return recovered;
}
function emptyState() { return { version: VERSION, requests: [], invocations: [] }; }
function assertRunning(world) {
  assert(!world.terminal && !world.evidence.events.some(event => event.event_type === "RunDisposition" &&
    ["invalid", "contaminated", "interrupted", "incomplete", "complete"].includes(event.payload.execution_status)), "run execution is stopped");
}
function assertPhaseRunning(world, phaseState) {
  assert(!world.evidence.events.some(event => event.event_type === "RunDisposition" &&
    ["invalid", "contaminated", "interrupted", "incomplete"].includes(event.payload.execution_status)), "run execution is stopped");
  // The raw reducer closes execution before consequence/memory/interview phases.
  if (world.terminal) assert(phaseState && !phaseState.closed && phaseState.turn === world.turn - 1 &&
    ["consequence_reveal", "memory_update", "memory_archive", "snapshot", "interview", "close"].includes(phaseState.phase), "run execution is stopped");
}
function phasesFor(candidate, now) {
  assert(candidate.phaseState && candidate.phaseBindings, "phase replay integration is required");
  return new TurnPhases({ world: candidate.world, ledger: candidate.ledger, state: candidate.phaseState,
    budgetsMs: candidate.phaseState.budgets.value, runtimes: phaseRuntimes(candidate.world, candidate.phaseBindings), now });
}
function modelPhaseContext(candidate, now) {
  if (!candidate.phaseState) return null;
  const phases = phasesFor(candidate, now);
  return { phase: phases.phase, logicalTurn: phases.logicalTurn, deadline: phases.deadline,
    worldView: phases.worldView(), bindings: clone(candidate.phaseBindings) };
}
function detached(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, detached(item)]));
  if (Array.isArray(value)) return Object.freeze(value.map(detached));
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detached(item)]));
  return Object.freeze(copy);
}

/** Trusted server/worker coordinator; authenticate principals before calling.
 * All mutations await durable publication before returning. world is a stable
 * read-through facade for server consumers; use transaction callbacks for writes.
 * Ledger/other nested references must not be retained across transactions.
 * No model is loaded by this service.
 */
export class RunService {
  #failed = false;
  #state;
  #recovered;
  #worldView;
  #evidenceView;
  #privacyBlocked = false;
  constructor({ archive, recovered, serviceState, head, fault = () => {}, allowSyntheticExecution = false, now = Date.now }) {
    assert(archive instanceof SignedArchive, "RunService requires externally authenticated SignedArchive");
    assert(serviceState.version === VERSION && Array.isArray(serviceState.requests) && Array.isArray(serviceState.invocations), "unsupported service journal");
    this.archive = archive; this.#recovered = recovered; this.#state = clone(serviceState); this.head = clone(head);
    this.#evidenceView = new Proxy({}, {
      get: (_target, key) => {
        assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED: live evidence unavailable");
        const evidence = this.#recovered.world.evidence;
        if (key === "bundle" || key === "snapshot") return (...args) => detached(evidence[key](...args));
        if (key === "verify") return (...args) => evidence.verify(...args);
        if (["append", "putPayload", "nextEventId", "signingSecret"].includes(key))
          throw new Error("evidence writes and signing authority are private to RunService transactions");
        return detached(evidence[key]);
      },
      set: () => { throw new Error("evidence writes require a RunService transaction"); },
      defineProperty: () => false, deleteProperty: () => false
    });
    this.#worldView = new Proxy({}, {
      get: (_target, key) => {
        if (key === "runId") return this.archive.runId;
        assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED: live evidence unavailable");
        if (key === "evidence") return this.#evidenceView;
        const value = this.#recovered.world[key];
        if (typeof value !== "function") return detached(value);
        return (...args) => { assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED: live evidence unavailable"); return detached(this.#recovered.world[key](...args)); };
      },
      has: (_target, key) => !this.#privacyBlocked && key in this.#recovered.world,
      ownKeys: () => this.#privacyBlocked ? [] : Reflect.ownKeys(this.#recovered.world),
      getOwnPropertyDescriptor: (_target, key) => !this.#privacyBlocked && Object.hasOwn(this.#recovered.world, key)
        ? { enumerable: true, configurable: true, value: key === "evidence" ? this.#evidenceView : detached(this.#recovered.world[key]) } : undefined,
      set: () => { throw new Error("world writes require a RunService transaction"); },
      defineProperty: () => false, deleteProperty: () => false
    });
    this.fault = fault; this.coordinator = new RunCoordinator("service:" + archive.directory);
    this.allowSyntheticExecution = allowSyntheticExecution === true;
    this.now = now;
  }
  static async create({ world, archive, fault = () => {}, allowSyntheticExecution = false, now = Date.now }) {
    assert(world?.runId === archive.runId, "service run mismatch");
    const recovered = restore(world.evidence.bundle()), serviceState = emptyState();
    const head = await archive.publish(recovered.world.evidence.bundle(), { expectedHead: null, serviceState });
    return new RunService({ archive, recovered, serviceState, head, fault, allowSyntheticExecution, now });
  }
  static async recover({ archive, fault = () => {}, allowSyntheticExecution = false, now = Date.now }) {
    const loaded = await archive.load();
    assert(loaded.status === "COMPLETE", "REPLAY_INCOMPLETE_REDACTED: run cannot resume");
    assert(loaded.service_state, "archive has no RunService journal");
    return new RunService({ archive, recovered: restore(loaded.bundle), serviceState: loaded.service_state, head: loaded.head, fault, allowSyntheticExecution, now });
  }
  get world() { return this.#worldView; }
  get ledger() { assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED"); return detached({ submissions: this.#recovered.ledger.submissions }); }
  get pendingCommit() { assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED"); return clone(this.#recovered.pendingCommit); }
  get phaseState() { assert(!this.#privacyBlocked, "REPLAY_INCOMPLETE_REDACTED"); return clone(this.#recovered.phaseState ?? null); }
  get status() {
    if (this.#privacyBlocked) return { run_id: this.archive.runId, status: "REPLAY_INCOMPLETE_REDACTED", needs_restart: true, exact_reproducibility: false };
    return { run_id: this.archive.runId, turn: this.world.turn, needs_restart: this.#failed,
      pending_commit_id: this.#recovered.pendingCommit?.turn_committed_id ?? null,
      unresolved_invocations: this.#state.invocations.filter(item => item.status !== "completed").map(item => ({ invocation_id: item.invocation_id, status: item.status })),
      archive_head: clone(this.head) };
  }
  #phase(candidate, command, bindings = candidate.phaseBindings) {
    assertPhaseRunning(candidate.world, candidate.phaseState);
    const out = executeTurnPhaseCommand({ world: candidate.world, ledger: candidate.ledger,
      state: candidate.phaseState ?? null, bindings, command, at: this.now(),
      fault: (point, detail) => candidate.crashHook(["before_event", "after_event"].includes(point) ? point + ":" + detail.event_type : "world:" + point) });
    candidate.phaseState = out.phaseState; candidate.phaseBindings = out.phaseBindings;
    return out.result;
  }
  /** Trusted controller entry point; all inputs are canonical and independently
   * replayed before durable publication. Never accepts an archived phase state. */
  phaseCommand({ requestId, command, bindings }) {
    return this.#transaction("phase", requestId, { command, ...(bindings ? { bindings } : {}) }, candidate => {
      if (candidate.phaseBindings && bindings) assert(sha256(bindings) === sha256(candidate.phaseBindings), "phase binding substitution");
      return this.#phase(candidate, command, bindings ?? candidate.phaseBindings);
    });
  }
  beginPhases({ requestId, bindings, budgetsMs = {} }) {
    return this.phaseCommand({ requestId, bindings, command: { operation: "begin", input: { budgetsMs } } });
  }
  advancePhase({ requestId }) { return this.phaseCommand({ requestId, command: { operation: "advance" } }); }
  async #transaction(kind, requestId, input, apply, { allowUncertain = false } = {}) {
    assert(typeof requestId === "string" && requestId.length > 0, "stable requestId required");
    input = clone(input);
    return this.coordinator.run(async () => {
      assert(!this.#failed, "service requires restart after failed transaction");
      assert((await this.archive.head())?.digest === this.head.digest, "service archive head is stale; restart required");
      const hash = sha256(input);
      const prior = this.#state.requests.find(item => item.request_id === requestId);
      if (prior) {
        assert(prior.kind === kind && prior.input_hash === hash, "idempotency key reused with different input");
        return clone(prior.result);
      }
      assert(allowUncertain || this.#state.invocations.every(item => item.status === "completed"), "MODEL_OUTCOME_UNKNOWN: reconcile the durable invocation before continuing");
      const candidate = restore(this.world.evidence.bundle()), state = clone(this.#state);
      let publicationAttempted = false;
      try {
        await this.fault("before_" + kind);
        const eventStart = candidate.world.evidence.events.length, observedEvents = new Set(), stagedEventCounts = new Map();
        candidate.crashHook = point => {
          if (point.startsWith("after_event:")) {
            const type = point.slice("after_event:".length);
            stagedEventCounts.set(type, (stagedEventCounts.get(type) ?? 0) + 1);
          }
          const result = this.fault(point);
          assert(!result?.then, "staged reducer crash hook must be synchronous");
          return result;
        };
        const append = candidate.world.evidence.append.bind(candidate.world.evidence);
        candidate.world.evidence.append = event => {
          const before = this.fault("before_event:" + event.eventType);
          assert(!before?.then, "event fault hook must be synchronous");
          const result = append(event);
          observedEvents.add(result.event_id);
          const after = this.fault("after_event:" + event.eventType);
          assert(!after?.then, "event fault hook must be synchronous");
          return result;
        };
        let result;
        try { result = await apply(candidate, state); } finally { candidate.world.evidence.append = append; }
        // Atomic world reducers may use their own private EvidenceStore and
        // swap the completed batch into the candidate. Exercise each event's
        // service acceptance boundary before publishing that staged batch.
        for (const event of candidate.world.evidence.events.slice(eventStart)) {
          if (observedEvents.has(event.event_id)) continue;
          if ((stagedEventCounts.get(event.event_type) ?? 0) > 0) {
            stagedEventCounts.set(event.event_type, stagedEventCounts.get(event.event_type) - 1); continue;
          }
          await this.fault("before_event:" + event.event_type);
          await this.fault("after_event:" + event.event_type);
        }
        await this.fault("after_" + kind);
        // Independent replay rejects partial acceptance, reducer, or snapshot
        // emissions before any of them can become the durable published state.
        const verified = restore(candidate.world.evidence.bundle());
        state.requests.push({ request_id: requestId, kind, input_hash: hash, result: clone(result) });
        await this.fault("before_" + kind + "_persist");
        publicationAttempted = true;
        const head = await this.archive.publish(candidate.world.evidence.bundle(), { expectedHead: this.head.digest,
          serviceState: state, fault: point => this.fault(kind + ":" + point) });
        this.#recovered = verified; this.#state = state; this.head = head;
        await this.fault("after_" + kind + "_persist");
        return clone(result);
      } catch (error) { if (publicationAttempted) this.#failed = true; throw error; }
    });
  }
  submit({ requestId, ...input }) {
    input = clone(input);
    return this.#transaction("submission", requestId, input, candidate => {
      const { world, ledger, pendingCommit } = candidate;
      assert(!candidate.phaseState, "orchestrated submissions require phaseCommand");
      assertRunning(world); assert(!pendingCommit, "turn is closed for submissions");
      const { actorId, actor, actions, priorSubmissionId = null } = input;
      assert(world.polities[actorId]?.alive, "actor unavailable");
      assert(input.runId === undefined || input.runId === world.runId, "submission run mismatch");
      assert(input.turnId === undefined || input.turnId === "turn-" + world.turn, "late submission");
      if (priorSubmissionId) {
        const prior = ledger.submissions.get(priorSubmissionId);
        assert(prior?.actor_id === actorId && prior.turn_id === "turn-" + world.turn && prior.status === "rejected", "invalid retry lineage");
        assert(sha256(actions) === sha256(prior.submitted_actions), "rejected actions are lost; corrective retry is prohibited");
      }
      if (!priorSubmissionId) assert(![...ledger.submissions.values()].some(item => item.actor_id === actorId && item.turn_id === "turn-" + world.turn && item.status === "rejected"), "rejected action opportunity is consumed");
      assert(![...ledger.submissions.values()].some(item => item.actor_id === actorId && item.turn_id === "turn-" + world.turn && ["submitted", "validated", "accepted"].includes(item.status)), "actor already has a pending submission");
      return ledger.submit({ runId: world.runId, turnId: "turn-" + world.turn, actorId, actor, actions,
        projection: input.projection ?? projectWorld(world, actorId), phase: world.phase, priorSubmissionId });
    });
  }
  validate({ requestId, submissionId }) {
    return this.#transaction("validation", requestId, { submissionId }, candidate => {
      const { world, ledger, pendingCommit } = candidate;
      assert(!candidate.phaseState, "orchestrated validation requires advancePhase");
      assert(!pendingCommit, "turn already committed");
      const submission = ledger.submissions.get(submissionId); assert(submission, "unknown submission");
      return ledger.validate(submission, world);
    });
  }
  async submitAndValidate({ requestId, ...input }) {
    assert(typeof requestId === "string" && requestId.length > 0, "stable requestId required");
    const submission = await this.submit({ requestId: requestId + ":submit", ...input });
    return this.validate({ requestId: requestId + ":validate", submissionId: submission.submission_id });
  }
  commit({ requestId, submissionIds }) {
    const ids = [...submissionIds].sort();
    return this.#transaction("commit", requestId, { submissionIds: ids }, candidate => {
      const { world, ledger, validated, pendingCommit } = candidate;
      assert(!candidate.phaseState, "orchestrated commits require advancePhase");
      assertRunning(world); assert(!pendingCommit, "turn already committed or run terminal");
      assert(new Set(ids).size === ids.length, "duplicate committed submission");
      const selected = ids.map(id => { const item = validated.get(id); assert(item?.submission.status === "validated", "commit requires validated submissions"); return item; });
      const actors = selected.map(item => item.submission.actor_id);
      const active = Object.values(world.polities).filter(actor => actor.alive).map(actor => actor.id).sort();
      const rejected = [...ledger.submissions.values()].filter(item => item.turn_id === "turn-" + world.turn && item.status === "rejected").map(item => item.actor_id);
      assert(new Set(actors).size === actors.length && sha256([...new Set([...actors, ...rejected])].sort()) === sha256(active), "commit must account for the complete active actor set");
      return commitTurn(world, ledger, selected);
    });
  }
  resolve({ requestId, committedId }) {
    return this.#transaction("resolution", requestId, { committedId }, candidate => {
      const { world, pendingCommit, crashHook } = candidate;
      assert(!candidate.phaseState, "orchestrated resolution requires advancePhase");
      assertRunning(world);
      assert(pendingCommit?.turn_committed_id === committedId, "no matching pending committed turn");
      resolveTurn(world, pendingCommit, { fault: (point, detail) => crashHook(
        ["before_event", "after_event"].includes(point) ? point + ":" + detail.event_type : "world:" + point) });
      return { turn_committed_id: committedId, state_digest: world.stateHash(), event_head: world.evidence.previousHash, turn: world.turn };
    });
  }
  /** A trusted adapter records memory/interview/projection/security evidence in
   * one transaction. identity contains stable command data, never a function.
   * mutate receives a private candidate; it must not perform external effects.
   */
  checkpoint({ requestId, kind, identity, mutate }) {
    assert(["memory", "interview", "projection", "snapshot", "security"].includes(kind), "unknown checkpoint boundary");
    return this.#transaction(kind, requestId, identity, async ({ world }) => {
      const before = world.evidence.events.length;
      const result = await mutate(world);
      assert(world.evidence.events.length > before, "checkpoint requires canonical evidence");
      return result ?? { event_head: world.evidence.previousHash };
    }, { allowUncertain: kind === "security" });
  }
  /** prepare(world) records a schema-valid ModelInvocation dispatch event and
   * returns the detached authorized transport request. invoke(request, metadata)
   * receives no world/Observer authority. complete(world, output) records exact
   * output and its ModelInvocation event. These are trusted adapter callbacks.
   * External effects are never automatically repeated after an uncertain crash.
   */
  invokeModel(options) {
    return new RunCoordinator("model:" + this.archive.directory).run(() => this.#invokeModel(options));
  }
  async #invokeModel({ requestId, invocationId, identity, prepare, invoke, complete }) {
    assert(!this.#failed, "service requires restart after failed transaction");
    assert((await this.archive.head())?.digest === this.head.digest, "service archive head is stale; restart required");
    const existing = this.#state.invocations.find(item => item.invocation_id === invocationId);
    if (existing?.status === "completed") {
      assert(existing.request_id === requestId && existing.identity_hash === sha256(identity), "invocation identity substitution");
      return clone(existing.result);
    }
    if (existing) throw new Error("MODEL_OUTCOME_UNKNOWN: provider reconciliation required; invocation will not be repeated");
    const request = await this.#transaction("model_dispatch", requestId + ":dispatch", { invocationId, identity }, async (candidate, state) => {
      const { world } = candidate, context = modelPhaseContext(candidate, this.now);
      if (context) {
        assertPhaseRunning(world, candidate.phaseState);
        assert(["private_planning", "diplomacy", "final_planning", "memory_update", "interview"].includes(context.phase) && this.now() < context.deadline, "model dispatch unavailable in current phase");
      } else assertRunning(world);
      assert(!state.invocations.some(item => item.invocation_id === invocationId), "invocation ID already journaled");
      const before = world.evidence.events.length;
      const request = await prepare(world, context);
      assert(world.evidence.events.slice(before).some(event => event.event_type === "ModelInvocation" && event.payload.invocation_id === invocationId), "model dispatch requires canonical invocation evidence");
      if (context) assert(world.evidence.events.slice(before).filter(e => e.event_type === "ModelInvocation").every(e =>
        e.turn === context.logicalTurn && e.phase === context.phase), "model invocation bypassed phase logical time");
      state.invocations.push({ invocation_id: invocationId, request_id: requestId, identity_hash: sha256(identity), status: "outcome_unknown", result: null });
      return request;
    });
    await this.fault("before_model_call");
    const output = await invoke(clone(request), Object.freeze({ invocationId, idempotencyKey: invocationId }));
    await this.fault("after_model_call");
    return this.reconcileInvocation({ requestId: requestId + ":complete", invocationId, output, complete });
  }
  reconcileInvocation({ requestId, invocationId, output, complete }) {
    return this.#transaction("model_completion", requestId, { invocationId, output }, async (candidate, state) => {
      const { world } = candidate;
      const invocation = state.invocations.find(item => item.invocation_id === invocationId);
      assert(invocation && invocation.status === "outcome_unknown", "no unresolved invocation");
      const before = world.evidence.events.length;
      const result = await complete(world, clone(output), modelPhaseContext(candidate, this.now));
      assert(world.evidence.events.slice(before).some(event => event.event_type === "ModelInvocation" && event.payload.invocation_id === invocationId), "model completion requires canonical invocation evidence");
      invocation.status = "completed"; invocation.result = result ?? { invocation_id: invocationId, event_head: world.evidence.previousHash };
      return invocation.result;
    }, { allowUncertain: true });
  }
  /** Use this method for a live run so its server facade is quarantined while
   * the archive's authorized purge executes. Already delivered copies remain
   * subject to the application's separately managed retention policy.
   */
  redact(request, options = {}) {
    request = clone(request);
    return this.coordinator.run(async () => {
      this.#privacyBlocked = true; this.#failed = true;
      try {
        const result = await this.archive.redact(request, { ...options, expectedHead: this.head.digest });
        this.head = { generation: result.generation, digest: result.digest };
        return result;
      } finally {
        // Failed/uncertain purges also deny access; recovery checks the archive.
        this.#recovered = null; this.#state = null;
      }
    });
  }
  async participantState(principalId) {
    return this.coordinator.run(async () => {
      assert((await this.archive.head())?.digest === this.head.digest, "service archive head is stale");
      const world = this.world;
      assert(world.polities[principalId], "unknown projection principal");
      if (this.#recovered.phaseState) {
        const phases = phasesFor(this.#recovered, this.now), controls = phases.controls(principalId);
        let running = true; try { assertPhaseRunning(world, this.#recovered.phaseState); } catch { running = false; }
        const enabled = this.allowSyntheticExecution && !this.#failed && running && this.#state.invocations.every(item => item.status === "completed");
        return { projection: projectWorld(phases.worldView(), principalId), controls: { ...controls, execution_enabled: this.allowSyntheticExecution,
          can_submit: enabled && controls.can_submit, can_communicate: enabled && controls.can_communicate,
          can_ready: enabled && controls.can_ready, can_update_memory: enabled && controls.can_update_memory } };
      }
      const own = [...this.ledger.submissions.values()].filter(item => item.actor_id === principalId && item.turn_id === "turn-" + world.turn);
      const rejected = own.some(item => item.status === "rejected");
      let running = true; try { assertRunning(world); } catch { running = false; }
      return { projection: projectWorld(world, principalId), controls: {
        execution_enabled: this.allowSyntheticExecution,
        can_submit: this.allowSyntheticExecution && running && !this.#failed && world.polities[principalId].alive &&
          !this.#recovered.pendingCommit && !own.length && this.#state.invocations.every(item => item.status === "completed"),
        submission_status: rejected ? "rejected" : own.length ? "submitted" : "none", deadline_at: null } };
    });
  }
  /** Synthetic HTTP adapter. Caller authenticates principalId; this method never
   * authorizes human/empirical execution. A worker explicitly commits/resolves
   * once all opportunities are accounted for, using the methods above.
   */
  submitParticipantActions({ principalId, actions, turn, phase, projectionId, requestId }) {
    assert(this.allowSyntheticExecution, "synthetic participant execution not enabled");
    actions = clone(actions);
    const id = requestId ?? stableId("participant-request", this.archive.runId, principalId, turn, phase ?? 'actions', projectionId, sha256(actions));
    if (this.#recovered.phaseState) return this.#participantPhase({ principalId, turn, phase, projectionId, requestId: id, operation: "submit", actions });
    return new RunCoordinator("participant:" + this.archive.directory).run(async () => {
      const previous = this.#state.requests.find(item => item.request_id === id + ":submit");
      if (!previous) {
        const state = await this.participantState(principalId);
        assert(state.controls.can_submit && state.projection.logical_time.turn === turn && state.projection.projection_id === projectionId, "submission unavailable or stale observation");
      }
      const result = await this.submitAndValidate({ requestId: id, actorId: principalId, actions, turnId: "turn-" + turn,
        actor: { persistent_identity_id: principalId, session_id: stableId("synthetic-participant-session", this.archive.runId, principalId),
          invocation_id: stableId("synthetic-participant-invocation", id) } });
      return { status: result.submission.status === "rejected" ? "rejected" : "submitted", submission_id: result.submission.submission_id };
    });
  }
  #participantPhase(input) {
    assert(this.allowSyntheticExecution, "synthetic participant execution not enabled");
    return this.#transaction("participant_phase", input.requestId, input, candidate => {
      const phases = phasesFor(candidate, this.now), projection = projectWorld(phases.worldView(), input.principalId);
      assert(projection.logical_time.turn === input.turn && projection.logical_time.phase === input.phase && projection.projection_id === input.projectionId, "phase request unavailable or stale observation");
      const binding = candidate.phaseBindings.find(b => b.actorId === input.principalId); assert(binding, "actor unavailable");
      const actor = { persistent_identity_id: input.principalId, session_id: binding.sessionId, invocation_id: stableId("synthetic-phase-invocation", input.requestId) };
      // Record the exact current observation acknowledged by this request.
      this.#phase(candidate, { operation: "projection", input: { actorId: input.principalId } });
      const commandInput = input.operation === "submit" ? { actorId: input.principalId, actor, actions: input.actions }
        : input.operation === "diplomacy" ? { actorId: input.principalId, actor, requestId: input.requestId, command: input.command }
        : { actorId: input.principalId };
      const result = this.#phase(candidate, { operation: input.operation, input: commandInput });
      return input.operation === "submit" ? { status: "submitted", submission_id: result.submission_id } : result;
    });
  }
  participantDiplomacy({ principalId, command, turn, phase, projectionId, requestId }) {
    assert(typeof requestId === "string" && requestId.length > 0, "stable communication requestId required");
    return this.#participantPhase({ principalId, command: clone(command), turn, phase, projectionId, requestId, operation: "diplomacy" });
  }
  participantReady({ principalId, turn, phase, projectionId, requestId }) {
    const id = requestId ?? stableId("participant-ready", this.archive.runId, principalId, turn, phase, projectionId);
    return this.#participantPhase({ principalId, turn, phase, projectionId, requestId: id, operation: "ready" });
  }
}
