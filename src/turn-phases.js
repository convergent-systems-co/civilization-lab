import { assert, clone, sha256, stableId } from './core.js';
import { ActionLedger, commitTurn, projectWorld } from './contracts.js';
import { authoritativeState, resolveTurn } from './world.js';
import { discoverPolity } from './world-map.js';
import { validateAction } from './world-actions.js';
import { EvidenceStore } from './evidence.js';
import { MemoryStore, MEMORY_PARSER_HASH, parseMemoryOperation } from './memory.js';
import { Confidant } from './confidant.js';
import { assertAgentCondition } from './agent.js';
import { parameterRegistry } from './parameters.js';

export const TURN_PHASE_VERSION = 'pilot0-turn-phases-v1';
// INVARIANTS wins over the old numbered WORLD prose: validate BEFORE acceptance.
export const TURN_PHASES = Object.freeze(['observation', 'private_planning', 'diplomacy', 'final_planning',
  'validation', 'accepted_commit', 'resolution', 'consequence_reveal', 'memory_update',
  'memory_archive', 'snapshot', 'interview', 'close']);
export const DIPLOMACY_COMMANDS = Object.freeze(['message', 'promise', 'broadcast', 'channel_create', 'channel_invite', 'channel_leave']);
// Aliases preserve the phase API while sharing Descartes's exact production parser.
export const PHASE_MEMORY_PARSER_HASH = MEMORY_PARSER_HASH;
export const parsePhaseMemoryOutput = parseMemoryOperation;
const INTERACTIVE = new Set(['observation', 'private_planning', 'diplomacy', 'final_planning', 'consequence_reveal', 'memory_update']);
const POST = new Set(['consequence_reveal', 'memory_update', 'memory_archive', 'snapshot', 'interview', 'close']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const content = (evidence, ref) => { const record = evidence.payloads.get(ref); assert(record && sha256(record.bytes) === ref, 'missing or corrupt phase evidence'); return JSON.parse(record.bytes); };

/** Explicit provisional values and their effective registered provenance. */
export function phaseBudgetManifest(world, overrides = {}) {
  assert(Object.keys(overrides).every(key => TURN_PHASES.includes(key)), 'unknown phase budget');
  const value = Object.fromEntries(TURN_PHASES.map(phase => [phase, overrides[phase] ?? world.config.phases.actionBudgetMs]));
  assert(Object.values(value).every(n => Number.isSafeInteger(n) && n > 0), 'phase budgets must be positive integer milliseconds');
  const entry=parameterRegistry(world.config).parameters.find(p=>p.parameter_id==='world.phase.budgets');
  assert(entry && Object.keys(entry.value).sort().join(',')===[...TURN_PHASES].sort().join(','),'unregistered phase budget');
  const differs=Object.keys(value).some(phase=>value[phase]!==entry.value[phase]);
  entry.value=clone(value);
  if(differs)entry.provenance+='; explicit canonical phase-command override, not empirically calibrated or confirmatory frozen';
  return freeze({ version: TURN_PHASE_VERSION, classification: 'WORLD_CALIBRATION', status: 'PROVISIONAL_NONEMPIRICAL_DEFAULTS',
    value, registry_entry:entry, provenance: 'Explicit phase budgets; unspecified values inherit config.phases.actionBudgetMs', freeze_stage: 'before_confirmation' });
}

function communicationState(world) { return { polities: clone(world.polities), channels: clone(world.channels) }; }
function copyEvidence(evidence) {
  const copy = new EvidenceStore(evidence.runId); copy.events = clone(evidence.events); copy.payloads = new Map(evidence.payloads);
  copy.previousHash = evidence.previousHash; copy.signingSecret = evidence.signingSecret; return copy;
}

/** Trusted orchestration, never a participant capability. Persist commands and
 * phase state through RunService transactions; do not keep this object across a
 * service candidate replacement. exportState() contains Observer-only metadata.
 *
 * world.turn stays untouched except for resolveTurn's existing T -> T+1 change.
 * Participant projections and memory/interview evidence keep logical turn T
 * until close. The reducer snapshot is retained; a distinct lifecycle snapshot
 * follows the actual MemoryOperation archives.
 */
export class TurnPhases {
  #world; #ledger; #runtimes; #now; #state; #budget; #inFlight = false;
  constructor({ world, runtimes, ledger = new ActionLedger(world.evidence), budgetsMs = {}, now = Date.now, state = null }) {
    assert(world?.evidence && ledger instanceof ActionLedger && ledger.evidence === world.evidence, 'phase engine requires the actual world ledger');
    assert(Array.isArray(runtimes), 'explicit condition-bound runtimes required');
    assert(new Set(runtimes.map(r => r.actorId)).size === runtimes.length, 'duplicate phase principal');
    for (const runtime of runtimes) {
      assert(world.polities[runtime.actorId] && runtime.world === world, 'runtime/world principal mismatch');
      assertAgentCondition(runtime.condition);
      assert(runtime.memory instanceof MemoryStore && runtime.memory.evidence === world.evidence && runtime.memory.identityId === runtime.actorId, 'condition memory store mismatch');
    }
    assert(Object.values(world.polities).filter(p => p.alive).every(p => runtimes.some(r => r.actorId === p.id)), 'phase runtimes must cover active actors');
    this.#world = world; this.#ledger = ledger; this.#runtimes = runtimes; this.#now = now; this.#budget = phaseBudgetManifest(world, budgetsMs);
    if (state) {
      assert(state.version === TURN_PHASE_VERSION && state.run_id === world.runId && sha256(state.budgets) === sha256(this.#budget), 'phase recovery contract mismatch');
      const event = world.evidence.events.find(e => e.event_id === state.head_event_id);
      assert(event?.event_type === 'WorldTransition' && event.payload.mechanic === 'turn_phase_state', 'phase state lacks canonical recovery authority');
      const archived = content(world.evidence, event.payload.after_state_ref);
      assert(sha256({ ...state, head_event_id: null }) === sha256(archived), 'phase recovery state substitution');
      assert(world.evidence.events.filter(e => e.event_type === 'WorldTransition' && e.payload.mechanic === 'turn_phase_state').at(-1)?.event_id === event.event_id, 'stale phase recovery state');
      assert(Object.values(state.submissions).every(item => ledger.submissions.has(item.submission_id)), 'phase recovery requires reconstructed action ledger');
      this.#state = clone(state); this.#assertTurn();
    } else {
      assert(!world.terminal && world.turn < world.config.maxTurns, 'cannot begin a terminal turn');
      const prior = world.evidence.events.filter(e => e.event_type === 'WorldTransition' && e.payload.mechanic === 'turn_phase_state').at(-1);
      if (prior) assert(content(world.evidence, prior.payload.after_state_ref).closed, 'existing lifecycle must be recovered before starting another');
      const opened = this.#time();
      this.#state = { version: TURN_PHASE_VERSION, run_id: world.runId, turn: world.turn, phase: 'observation',
        budgets: clone(this.#budget), opened_at: opened, deadline_at: opened + this.#budget.value.observation,
        ready: [], projections: {}, submissions: {}, commands: {}, memory_operations: [], memory_archive_ref: null,
        snapshot_ref: null, snapshot_event_id: null, committed_id: null, interview_results: null, closed: false, head_event_id: null };
      this.#save(clone(this.#state), 'begin_turn');
    }
  }
  get phase() { return this.#state.phase; }
  get logicalTurn() { return this.#state.turn; }
  get deadline() { return this.#state.deadline_at; }
  get ledger() { return this.#ledger; }
  /** Trusted agent/replay adapter only: detached logical-time view, not state mutation. */
  worldView() { this.#assertTurn(); return this.#view(); }
  exportState() { return clone(this.#state); }
  #time() { const n = this.#now(); assert(Number.isSafeInteger(n) && n >= 0, 'invalid phase clock'); return n; }
  #assertTurn() {
    const expected = this.#state.turn + (POST.has(this.phase) || this.#state.closed ? 1 : 0);
    const recoveringResolution = this.phase === 'resolution' && this.#world.turn === this.#state.turn + 1 && this.#world.resolvedCommits.has(this.#state.committed_id);
    assert(this.#world.turn === expected || recoveringResolution, 'world turn drift; lifecycle does not reindex reducer state');
  }
  #guard(phase, actorId = null, { timely = true } = {}) {
    this.#assertTurn(); assert(!this.#state.closed && !this.#inFlight && this.phase === phase, 'operation unavailable in current phase');
    if (actorId !== null) assert(this.#world.polities[actorId]?.alive && this.#runtimes.some(r => r.actorId === actorId), 'actor unavailable');
    const now = this.#time(); assert(now >= this.#state.opened_at, 'phase clock moved backwards');
    if (timely) assert(now < this.deadline, 'phase deadline exceeded');
  }
  #active() { return this.#runtimes.filter(r => this.#world.polities[r.actorId]?.alive).map(r => r.actorId).sort(); }
  #expected() { return this.phase === 'memory_update' ? this.#active().filter(id => this.#runtime(id).condition.memory.mode !== 'state_only') : this.#active(); }
  #runtime(id) { const runtime = this.#runtimes.find(r => r.actorId === id); assert(runtime, 'actor unavailable'); return runtime; }
  #view(phase = this.phase) {
    const types = this.#world.actionTypes.filter(type => DIPLOMACY_COMMANDS.includes(type) === (phase === 'diplomacy'));
    return { ...this.#world, turn: this.logicalTurn, phase, actionTypes: types };
  }
  #event(mechanic, before, after, detail = {}, actors = [], evidence = this.#world.evidence, phase = this.phase) {
    const beforeRef = evidence.putPayload(before, 'turn_phase_observer'), afterRef = evidence.putPayload(after, 'turn_phase_observer');
    return evidence.append({ eventType: 'WorldTransition', turn: this.logicalTurn, phase, participants: actors,
      causality: { causation_ids: this.#state.head_event_id ? [this.#state.head_event_id] : [] },
      provenance: { input_refs: [beforeRef, evidence.putPayload(this.#budget, 'phase_budget_manifest')] },
      payload: { schema_version: '1.0.0', run_id: this.#world.runId, mechanic, action_ids: [], actor_ids: actors,
        before_state_ref: beforeRef, after_state_ref: afterRef, detail: { phase_contract_version: TURN_PHASE_VERSION, ...detail } } });
  }
  #save(next, reason, detail = {}) {
    const before = { ...clone(this.#state), head_event_id: null }, after = { ...clone(next), head_event_id: null };
    const event = this.#event('turn_phase_state', before, after, { reason, reducer_turn: this.#world.turn, ...detail }, [], this.#world.evidence, next.phase);
    this.#state = { ...after, head_event_id: event.event_id }; return event;
  }
  /** Principal-scoped service/UI response; contains no other actor's readiness. */
  controls(actorId) {
    assert(this.#world.polities[actorId], 'actor unavailable');
    const active = this.#world.polities[actorId].alive && !this.#state.closed && !this.#inFlight && this.#time() < this.deadline;
    return { turn: this.logicalTurn, phase: this.phase, deadline_at: this.deadline,
      can_submit: active && this.phase === 'final_planning' && !this.#state.submissions[actorId],
      can_communicate: active && this.phase === 'diplomacy' && !this.#state.ready.includes(actorId),
      can_update_memory: active && this.phase === 'memory_update' && this.#runtime(actorId).condition.memory.mode !== 'state_only' && !this.#state.ready.includes(actorId),
      can_ready: active && INTERACTIVE.has(this.phase) && !this.#state.ready.includes(actorId) && (this.phase !== 'final_planning' || !!this.#state.submissions[actorId]),
      ready: this.#state.ready.includes(actorId), submission_status: this.#state.submissions[actorId]?.status ?? 'none' };
  }
  projection(actorId, { record = true } = {}) {
    this.#guard(this.phase, actorId);
    assert(INTERACTIVE.has(this.phase), 'participant projection unavailable in internal phase');
    const projection = projectWorld(this.#view(), actorId);
    if (record) {
      const event = this.#world.evidence.append({ eventType: 'ProjectionIssued', turn: this.logicalTurn, phase: this.phase, participants: [actorId], payload: projection });
      const next = clone(this.#state); next.projections[actorId] = event.event_id; this.#save(next, 'authorized_projection', { actor_id: actorId });
    }
    return freeze(clone(projection));
  }
  /** Explicit participant completion; no invented planning text or model output. */
  ready(actorId) {
    this.#guard(this.phase, actorId); assert(INTERACTIVE.has(this.phase), 'internal phase cannot be acknowledged');
    if (this.#state.ready.includes(actorId)) return this.controls(actorId);
    assert(this.#state.projections[actorId] || this.phase === 'memory_update' && this.#runtime(actorId).condition.memory.mode === 'state_only', 'observe the authorized phase input before completion');
    if (this.phase === 'final_planning') assert(this.#state.submissions[actorId], 'final planning requires an explicit submission, possibly empty');
    const next = clone(this.#state); next.ready = [...next.ready, actorId].sort(); this.#save(next, 'participant_phase_complete', { actor_id: actorId });
    return this.controls(actorId);
  }
  /** Immediate authenticated communication, not a deferred strategic order.
   * Requests and safe validation results are immutable command evidence. Each
   * command observes its current room membership; it never resolves economics,
   * invokes TurnCommitted, or grants arrival priority to strategic actions. */
  diplomacy({ actorId, actor, requestId, command }) {
    assert(typeof requestId === 'string' && requestId.length > 0, 'stable diplomacy requestId required');
    assert(actor?.persistent_identity_id === actorId && actor.session_id && actor.invocation_id, 'authenticated communication lineage required');
    assert(actor.session_id === this.#runtime(actorId).sessionId, 'communication session does not own this principal');
    const key = stableId('phase-command', this.#world.runId, this.logicalTurn, actorId, requestId), hash = sha256({ actorId, actor, command });
    const prior = this.#state.commands[key];
    if (prior) { assert(prior.input_hash === hash, 'diplomacy idempotency key reused'); return clone(prior.result); }
    this.#guard('diplomacy', actorId); assert(!this.#state.ready.includes(actorId), 'diplomacy opportunity closed');
    const action = { ...clone(command), action_id: key };
    const validation = DIPLOMACY_COMMANDS.includes(action.type) ? validateAction(this.#view(), actorId, action) : { ok: false, code: 'command_not_available_in_diplomacy' };
    const before = communicationState(this.#world), evidence = copyEvidence(this.#world.evidence);
    const stage = { ...this.#world, ...clone(before), evidence, turn: this.logicalTurn, phase: 'diplomacy' };
    const projectionRef = evidence.putPayload(projectWorld(this.#view(), actorId), 'participant_projection');
    const result = { command_id: key, status: validation.ok ? 'resolved' : 'rejected', ...(validation.ok ? {} : { code: validation.code }) };
    if (validation.ok) {
      if (action.type === 'channel_create') {
        const id = stableId('channel', stage.runId, key); stage.channels[id] = { id, members: [...new Set([actorId, ...action.members])].sort() }; result.channel_id = id;
      } else if (action.type === 'channel_invite') stage.channels[action.channel_id].members = [...new Set([...stage.channels[action.channel_id].members, action.to])].sort();
      else if (action.type === 'channel_leave') stage.channels[action.channel_id].members = stage.channels[action.channel_id].members.filter(id => id !== actorId);
      else {
        const recipients = action.type === 'broadcast' ? this.#active() : action.channel_id ? [...stage.channels[action.channel_id].members] : [actorId, action.to];
        const message = { from: actorId, to: action.to ?? null, channel_id: action.channel_id ?? null, text: action.text, action_id: key,
          run_id: stage.runId, turn: this.logicalTurn, broadcast: action.type === 'broadcast', participant_label: action.type === 'promise' ? 'promise' : null };
        // Link only what this sender was actually issued, including projections
        // issued by the real agent dispatcher. Chronological/global messages are
        // not evidence of exposure. These edges establish observed precedence,
        // not a reciprocal/moral interpretation of the participant's words.
        const observation = evidence.events.findLast(e => e.event_type === 'ProjectionIssued' && e.turn === this.logicalTurn &&
          e.phase === 'diplomacy' && e.participants.includes(actorId) && e.payload.principal?.principal_id === actorId);
        const observedMessages = observation?.payload.fields.find(field => field.path === 'authorized.messages')?.value ?? [];
        const messageRefs = new Set(observedMessages.map(item => item.message_ref));
        const predecessors = evidence.events.filter(e => e.event_type === 'MessageSent' && e.participants.includes(actorId) &&
          messageRefs.has(e.payload.payload_ref)).map(e => e.event_id);
        evidence.append({ eventType: 'MessageSent', turn: this.logicalTurn, phase: 'diplomacy', participants: [...new Set(recipients)],
          causality: { causation_ids: [...(observation ? [observation.event_id] : []), ...predecessors] },
          visibility: { acl_ref: action.type === 'broadcast' ? 'active_polities' : 'participants:' + [...new Set(recipients)].sort().join(',') },
          lineage: { persistent_identity_ids: [actorId], session_ids: [actor.session_id], invocation_ids: [actor.invocation_id] },
          provenance: { input_refs: [projectionRef, ...(observation ? [observation.payload.payload_ref] : []), evidence.putPayload(action, 'diplomacy_command')] }, payload: message });
        for (const id of new Set(recipients)) { stage.polities[id].messages.push({ ...clone(message), message_ref: evidence.putPayload(message, 'message') }); discoverPolity(stage, stage.polities[id], actorId, action.type === 'broadcast' ? 'public_broadcast' : 'diplomacy'); }
      }
      // Membership itself is authorized diplomacy evidence, visible only within its room.
      const changedChannel = result.channel_id ?? action.channel_id;
      if (changedChannel && stage.channels[changedChannel]) for (const member of stage.channels[changedChannel].members) for (const id of stage.channels[changedChannel].members) discoverPolity(stage, stage.polities[member], id, 'channel_membership');
    }
    this.#event('diplomacy_phase_command', before, communicationState(stage), { request: clone(command), command: action, actor: clone(actor), request_id: requestId,
      input_hash: hash, validation, result, projection_ref: projectionRef, strategic_action_commit: false }, [actorId], evidence);
    const next = clone(this.#state); next.commands[key] = { input_hash: hash, result };
    const beforePhase = { ...clone(this.#state), head_event_id: null }, afterPhase = { ...clone(next), head_event_id: null };
    const receipt = this.#event('turn_phase_state', beforePhase, afterPhase, { reason: 'diplomacy_command_receipt' }, [], evidence);
    // Publish communication state and its complete canonical batch together.
    this.#world.polities = stage.polities; this.#world.channels = stage.channels;
    this.#world.evidence.events = evidence.events; this.#world.evidence.payloads = evidence.payloads; this.#world.evidence.previousHash = evidence.previousHash;
    this.#state = { ...afterPhase, head_event_id: receipt.event_id }; return clone(result);
  }
  submit({ actorId, actor, actions }) {
    this.#guard('final_planning', actorId); assert(!this.#state.submissions[actorId], 'action opportunity already submitted');
    assert(actor?.session_id === this.#runtime(actorId).sessionId, 'submission session does not own this principal');
    assert(Array.isArray(actions), 'structured action array required');
    // Commands belong to the live diplomacy phase. Rejection consumes the attempt
    // during ordinary validation, just like any other invalid action.
    const submission = this.#ledger.submit({ runId: this.#world.runId, turnId: 'turn-' + this.logicalTurn, actorId, actor,
      actions, projection: projectWorld(this.#view(), actorId), phase: 'final_planning' });
    const next = clone(this.#state); next.submissions[actorId] = { submission_id: submission.submission_id, status: 'submitted' };
    this.#save(next, 'structured_action_submitted', { actor_id: actorId, submission_id: submission.submission_id }); return submission;
  }
  submitModelResult({ actorId, result }) {
    this.#guard('final_planning', actorId);
    const runtime = this.#runtime(actorId), event = this.#world.evidence.events.find(e => e.event_id === result?.eventId);
    assert(event?.event_type === 'ModelInvocation' && event.turn === this.logicalTurn && event.phase === 'final_planning' &&
      event.participants.includes(actorId) && event.payload.invocation_id === result.invocationId && event.payload.session_id === runtime.sessionId,
    'model action result lacks current final-planning lineage');
    assert(Array.isArray(result.actions), 'normalized model .actions array required');
    assert(event.payload.action_ref, 'model result lacks parsed action evidence');
    const parsed = content(this.#world.evidence, event.payload.action_ref);
    assert(sha256(result.actions) === sha256(parsed.actions ?? [parsed]), 'normalized model actions differ from canonical parsed output');
    assert(event.provenance.input_refs.some(ref => {
      const diagnostic = content(this.#world.evidence, ref); return diagnostic?.stage === 'complete' && diagnostic.classification === 'success';
    }), 'model action result is not a successful completed invocation');
    return this.submit({ actorId, actor: { persistent_identity_id: actorId, session_id: runtime.sessionId, invocation_id: result.invocationId }, actions: result.actions });
  }
  #validate() {
    const next = clone(this.#state), originalEvidence = this.#ledger.evidence;
    // Validation uses the exact final-planning projection. Its canonical event's
    // temporal phase is validation; no world clock/phase is temporarily rewound.
    this.#ledger.evidence = { append: event => this.#world.evidence.append({ ...event, phase: 'validation' }) };
    try {
      const source = this.#view('final_planning');
      for (const id of Object.keys(next.submissions).sort()) {
        const item = next.submissions[id], submitted = this.#ledger.submissions.get(item.submission_id);
        source.validateAction = (id, action) => submitted.actions.length > this.#world.config.phases.actionLimit ? { ok: false, code: 'action_limit_exceeded' }
          : DIPLOMACY_COMMANDS.includes(action.type) ? { ok: false, code: 'communication_requires_diplomacy_phase' } : validateAction(source, id, action);
        if (submitted.status === 'submitted') this.#ledger.validate(submitted, source);
        item.status = this.#ledger.submissions.get(item.submission_id).status;
        assert(['validated', 'rejected'].includes(item.status), 'invalid phase validation status');
      }
    } finally { this.#ledger.evidence = originalEvidence; }
    this.#save(next, 'validation_complete');
  }
  #commit() {
    const selected = Object.keys(this.#state.submissions).sort().filter(id => ['validated', 'accepted'].includes(this.#state.submissions[id].status));
    const ids = selected.map(id => this.#state.submissions[id].submission_id).sort();
    const prior = [...this.#world.committedRecords.values()].filter(c => c.turn === this.logicalTurn);
    assert(prior.length <= 1, 'multiple canonical commitments for one logical turn');
    if (prior.length) assert(sha256(prior[0].accepted_submission_ids) === sha256(ids), 'existing commitment differs from phase accepted set');
    const results = selected.map(id => this.#ledger.submissions.get(this.#state.submissions[id].submission_id)).map(s => ({ submission: clone(s), accepted: clone(s.actions) }));
    const committed = prior[0] ?? commitTurn(this.#world, this.#ledger, results), next = clone(this.#state); next.committed_id = committed.turn_committed_id;
    for (const id of selected) next.submissions[id].status = 'accepted';
    this.#save(next, 'accepted_set_committed', { commit_event_id: committed.commit_event_id });
  }
  #resolve(fault) {
    const committed = this.#world.committedRecords.get(this.#state.committed_id); assert(committed, 'phase lacks sealed committed set');
    if (!this.#world.resolvedCommits.has(committed.turn_committed_id)) resolveTurn(this.#world, committed, { fault });
    assert(this.#world.turn === this.logicalTurn + 1, 'unexpected reducer turn increment');
    const next = clone(this.#state); for (const item of Object.values(next.submissions)) if (item.status === 'accepted') item.status = 'resolved';
    this.#save(next, 'committed_actions_resolved');
  }
  updateMemory(actorId, request, { invocationId, inputRefs = [] } = {}) {
    this.#guard('memory_update', actorId); assert(!this.#state.ready.includes(actorId), 'memory opportunity closed');
    const runtime = this.#runtime(actorId); assert(runtime.condition.memory.mode !== 'state_only', 'memory history inaccessible in this condition');
    const source = this.#world.evidence.events.findLast(e => e.event_type === 'ModelInvocation' && e.turn === this.logicalTurn &&
      e.phase === 'memory_update' && e.participants.includes(actorId) && e.payload.invocation_id === invocationId && e.payload.session_id === runtime.sessionId);
    assert(source, 'memory edit requires same-turn memory-phase invocation provenance');
    const diagnostic = source.provenance.input_refs.map(ref => content(this.#world.evidence, ref)).find(record => record?.stage === 'complete');
    assert(diagnostic?.classification === 'success' && diagnostic.parsed_output_ref && source.payload.parser_hash === PHASE_MEMORY_PARSER_HASH,
      'memory edit requires a completed successful memory-parser invocation');
    assert(sha256(content(this.#world.evidence, diagnostic.parsed_output_ref)) === sha256(request), 'memory request differs from canonical parsed output');
    const raw = content(this.#world.evidence, source.payload.rendered_output_ref);
    assert(raw?.encoding === 'base64', 'memory edit requires exact archived model output bytes');
    assert(sha256(parsePhaseMemoryOutput(Buffer.from(raw.data, 'base64').toString('utf8'), { records: runtime.memory.records, capacity: runtime.memory.capacity })) === sha256(request), 'memory request differs from exact model output');
    const refs = [...new Set([...inputRefs, source.payload.rendered_input_ref, source.payload.rendered_output_ref, source.payload.projection_ref, ...source.payload.memory_refs])];
    assert(!this.#state.memory_operations.some(id => this.#world.evidence.events.find(e => e.event_id === id)?.payload.invocation_ref === invocationId), 'memory completion already consumed');
    const context = { sessionId: runtime.sessionId, invocationId, turn: this.logicalTurn, inputRefs: refs };
    const result = request.operation === 'READ' ? runtime.memory.read(context) : runtime.memory.apply(request, context);
    const operation = this.#world.evidence.events.at(-1), next = clone(this.#state); next.memory_operations.push(operation.event_id);
    this.#save(next, 'memory_operation_archived', { actor_id: actorId, operation_event_id: operation.event_id }); return result;
  }
  #archiveMemory() {
    const archives = {};
    for (const id of this.#active()) {
      const runtime = this.#runtime(id), enabled = runtime.condition.memory.mode !== 'state_only';
      assert(enabled || runtime.memory.records.length === 0, 'state-only condition contains experiential memory');
      archives[id] = { enabled, current_memory_ref: this.#world.evidence.putPayload({ records: enabled ? runtime.memory.records : [] }, 'agent_memory_archive'),
        operation_event_refs: this.#state.memory_operations.filter(ref => this.#world.evidence.events.find(e => e.event_id === ref)?.participants.includes(id)) };
    }
    const archiveRef = this.#world.evidence.putPayload(archives, 'post_turn_memory_archive');
    this.#event('turn_memory_archive', { operation_event_refs: this.#state.memory_operations }, { archive_ref: archiveRef }, {}, this.#active());
    const next = clone(this.#state); next.memory_archive_ref = archiveRef; this.#save(next, 'memory_archive_complete');
  }
  #snapshot() {
    assert(this.#state.memory_archive_ref, 'snapshot requires completed memory archive');
    const state = { ...authoritativeState(this.#world), turn: this.logicalTurn, phase: 'snapshot', memory_archive_ref: this.#state.memory_archive_ref };
    const stateRef = this.#world.evidence.putPayload(state, 'authoritative_research');
    const event = this.#world.evidence.append({ eventType: 'SnapshotCreated', turn: this.logicalTurn, phase: 'snapshot',
      causality: { causation_ids: [this.#state.head_event_id] }, payload: { run_id: this.#world.runId, turn: this.logicalTurn,
        state_ref: stateRef, state_hash: sha256(state), authoritative: true, lifecycle_version: TURN_PHASE_VERSION,
        reducer_turn: this.#world.turn, memory_archive_ref: this.#state.memory_archive_ref } });
    this.#world.snapshots.push({ turn: this.logicalTurn, state, state_hash: sha256(state) });
    const next = clone(this.#state); next.snapshot_ref = stateRef; next.snapshot_event_id = event.event_id; this.#save(next, 'post_memory_snapshot_complete');
  }
  /** Uses the existing actual isolated Confidant dispatcher, never a response
   * generator or a default test double. Missing/failed calls remain explicit. */
  async interviewAll() {
    this.#guard('interview'); assert(!this.#state.interview_results, 'interview round already attempted');
    const snapshot = this.#world.snapshots.at(-1); assert(sha256(snapshot.state) === this.#state.snapshot_ref, 'interview snapshot drift');
    const before = sha256({ world: authoritativeState(this.#world), rng: this.#world.rng.manifest(),
      memory: this.#runtimes.map(r => r.memory.records), ledger: [...this.#ledger.submissions] });
    this.#inFlight = true;
    try {
      const results = await new Confidant({ world: this.#world, now: this.#now }).interviewAll(this.#runtimes.filter(r => this.#world.polities[r.actorId].alive), { snapshot, deadline: this.deadline });
      assert(before === sha256({ world: authoritativeState(this.#world), rng: this.#world.rng.manifest(),
        memory: this.#runtimes.map(r => r.memory.records), ledger: [...this.#ledger.submissions] }), 'interview isolation violated');
      const next = clone(this.#state); next.interview_results = clone(results); this.#save(next, 'isolated_interviews_complete');
      return clone(results); // Observer-only; never forward responses to participants.
    } finally { this.#inFlight = false; }
  }
  /** Durable adapters dispatch interviews outside transactions. Seal only actual
   * canonical, independently validated responses bound to this frozen snapshot.
   * This method neither supplies responses nor accepts caller-provided results. */
  completeInterviews() {
    this.#guard('interview', null, { timely: false });
    assert(!this.#state.interview_results, 'interview round already attempted');
    const results = this.#active().map(actorId => {
      const matches = this.#world.evidence.events.filter(e => e.event_type === 'InterviewResponse' && e.turn === this.logicalTurn && e.participants.includes(actorId) &&
        content(this.#world.evidence, e.payload.isolation_proof_ref).snapshot_ref === this.#state.snapshot_ref);
      assert(matches.length <= 1, 'duplicate phase interview response');
      if (matches.length) {
        const event = matches[0];
        return { actorId, status: 'recorded', eventId: event.event_id, responseRef: event.payload.response_payload_ref, qualitativeOnly: true };
      }
      assert(this.#time() >= this.deadline, 'isolated interviews not completed');
      return { actorId, status: 'missing', qualitativeOnly: true };
    });
    const next = clone(this.#state); next.interview_results = results; this.#save(next, 'isolated_interviews_complete');
    return clone(results);
  }
  /** Trusted scheduler only. Readiness closes interactive phases early; deadlines
   * close their opportunities without fabricating actions or responses. Mandatory
   * archive/snapshot/commit work is never skipped because its budget expired. */
  advance({ fault = () => {} } = {}) {
    this.#guard(this.phase, null, { timely: false });
    const now = this.#time(), missing = this.#expected().filter(id => !this.#state.ready.includes(id));
    if (INTERACTIVE.has(this.phase)) assert(!missing.length || now >= this.deadline, 'phase still has open participant opportunities');
    else if (this.phase !== 'interview') assert(now < this.deadline, 'mandatory phase budget exhausted; stop affected chain');
    if (this.phase === 'validation') this.#validate();
    if (this.phase === 'accepted_commit') this.#commit();
    if (this.phase === 'resolution') this.#resolve(fault);
    if (this.phase === 'memory_archive') this.#archiveMemory();
    if (this.phase === 'snapshot') this.#snapshot();
    if (this.phase === 'interview') assert(this.#state.interview_results || now >= this.deadline, 'isolated interviews not completed');
    const next = clone(this.#state), priorPhase = this.phase;
    if (priorPhase === 'close') next.closed = true;
    else {
      next.phase = TURN_PHASES[TURN_PHASES.indexOf(priorPhase) + 1]; next.opened_at = now; next.deadline_at = now + this.#budget.value[next.phase];
      next.ready = []; next.projections = {};
    }
    this.#save(next, priorPhase === 'close' ? 'turn_closed' : 'phase_advanced', {
      from_phase: priorPhase, to_phase: next.closed ? null : next.phase,
      deadline_reached: now >= this.#state.deadline_at,
      missing_actor_ids: INTERACTIVE.has(priorPhase) ? missing : priorPhase === 'interview' && !this.#state.interview_results ? this.#active() : [],
      missing_output_policy: 'record_absence_without_fabricating_output', authoritative_logical_turn: this.logicalTurn });
    return this.exportState();
  }
}

export const PHASE_COMMAND_MECHANIC = 'turn_phase_command';
const COMMANDS = new Set(['begin', 'projection', 'ready', 'diplomacy', 'submit', 'submit_model', 'update_memory', 'complete_interviews', 'advance']);

/** Restore actual condition-bound memory from independently reduced evidence.
 * Bindings are run-controller inputs, never participant-controlled HTTP fields. */
export function phaseRuntimes(world, bindings) {
  assert(Array.isArray(bindings) && bindings.length > 0, 'explicit phase bindings required');
  return bindings.map(binding => {
    assert(Object.keys(binding).every(k => ['actorId', 'sessionId', 'condition'].includes(k)), 'unknown phase binding field');
    const { actorId, sessionId, condition } = binding;
    assert(typeof sessionId === 'string' && sessionId.length > 0 && world.polities[actorId], 'invalid phase binding');
    assertAgentCondition(condition);
    const memory = new MemoryStore({ runId: world.runId, identityId: actorId, evidence: world.evidence,
      sessionId, capacity: world.config.memory.capacity, isActive: () => world.polities[actorId].alive });
    memory.bindRuntime({ enabled: condition.memory.mode !== 'state_only', isActive: () => world.polities[actorId].alive });
    return { world, actorId, sessionId, condition: clone(condition), memory };
  });
}

/** Durable command adapter. Run on a private RunService candidate; exceptions
 * discard that candidate. All reads of wall time within one command share its
 * captured `at`. No model/provider effect is performed by this function. */
export function executeTurnPhaseCommand({ world, ledger, state = null, bindings, command, at, fault = () => {} }) {
  assert(Number.isSafeInteger(at) && at >= 0, 'recorded phase command clock required');
  assert(command && COMMANDS.has(command.operation) && Object.keys(command).every(k => ['operation', 'input'].includes(k)), 'unknown phase command');
  const input = clone(command.input ?? {}), operation = command.operation;
  const fields = { begin: ['budgetsMs'], projection: ['actorId'], ready: ['actorId'], diplomacy: ['actorId', 'actor', 'requestId', 'command'],
    submit: ['actorId', 'actor', 'actions'], submit_model: ['actorId', 'result'], update_memory: ['actorId', 'request', 'context'], complete_interviews: [], advance: [] }[operation];
  assert(Object.keys(input).every(k => fields.includes(k)), 'unknown phase command input');
  assert(operation === 'begin' ? !state || state.closed : state && !state.closed, 'phase command lifecycle mismatch');
  const runtimes = phaseRuntimes(world, bindings), start = world.evidence.events.length;
  const before = { world: authoritativeState(world), phase: clone(state), bindings: clone(bindings) };
  const beforeRef = world.evidence.putPayload(before, 'turn_phase_observer');
  const commandInput = { operation, input }, inputRef = world.evidence.putPayload({ command: commandInput, at, bindings }, 'phase_controller_input');
  const mark = (stage, afterRef, detail) => world.evidence.append({ eventType: 'WorldTransition',
    turn: operation === 'begin' ? before.world.turn : state.turn, phase: operation === 'begin' ? 'observation' : state.phase,
    provenance: { input_refs: [inputRef, beforeRef] },
    payload: { schema_version: '1.0.0', run_id: world.runId, mechanic: PHASE_COMMAND_MECHANIC,
      action_ids: [], actor_ids: [], before_state_ref: beforeRef, after_state_ref: afterRef,
      detail: { phase_contract_version: TURN_PHASE_VERSION, stage, command_ref: inputRef, ...detail } } });
  const intent = mark('input', beforeRef, {});
  const phases = new TurnPhases({ world, ledger, runtimes, now: () => at,
    budgetsMs: operation === 'begin' ? input.budgetsMs ?? {} : state.budgets.value, state: operation === 'begin' ? null : state });
  let result;
  if (operation === 'begin') result = { turn: phases.logicalTurn, phase: phases.phase };
  else if (operation === 'projection') result = phases.projection(input.actorId);
  else if (operation === 'ready') result = phases.ready(input.actorId);
  else if (operation === 'diplomacy') result = phases.diplomacy(input);
  else if (operation === 'submit') result = phases.submit(input);
  else if (operation === 'submit_model') result = phases.submitModelResult({ actorId: input.actorId, result: input.result });
  else if (operation === 'update_memory') result = phases.updateMemory(input.actorId, input.request, input.context);
  else if (operation === 'complete_interviews') result = phases.completeInterviews();
  else result = phases.advance({ fault });
  const phaseState = phases.exportState(), afterRef = world.evidence.putPayload({ world: authoritativeState(world), phase: phaseState, bindings }, 'turn_phase_observer');
  mark('complete', afterRef, { input_event_id: intent.event_id, result_ref: world.evidence.putPayload(result, 'phase_command_result') });
  return { phaseState, phaseBindings: clone(bindings), result: clone(result), eventCount: world.evidence.events.length - start };
}

/** Descartes/replay integration: call at the INPUT marker before generic world
 * reducers. Only the command, clock and controller bindings are archived inputs.
 * Every phase/communication/battle/memory/snapshot output is freshly generated
 * and byte-compared. Never hydrate from either archived state reference.
 * Caller owns external ModelInvocation verification and advances by eventCount. */
export function replayTurnPhaseCommand({ world, ledger, archive, cursor, state = null, bindings = null }) {
  const event = archive.events[cursor], p = event?.payload;
  assert(event?.event_type === 'WorldTransition' && p.mechanic === PHASE_COMMAND_MECHANIC && p.detail.stage === 'input', 'phase replay requires command input marker');
  const recorded = content(archive, p.detail.command_ref);
  assert(Object.keys(recorded).sort().join(',') === 'at,bindings,command', 'invalid recorded phase command');
  if (bindings) assert(sha256(bindings) === sha256(recorded.bindings), 'phase controller binding substitution');
  const start = world.evidence.events.length;
  assert(start === cursor, 'phase replay cursor mismatch');
  const generated = executeTurnPhaseCommand({ world, ledger, state, bindings: bindings ?? recorded.bindings,
    command: recorded.command, at: recorded.at });
  for (let index = start; index < world.evidence.events.length; index++) {
    assert(archive.events[index] && sha256(world.evidence.events[index]) === sha256(archive.events[index]), 'phase command re-execution canonical event mismatch at ' + index);
  }
  return generated;
}
