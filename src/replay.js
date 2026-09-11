import { clone, assert, sha256, canonicalize } from "./core.js";
import { loadEvidence, modelDiagnostic } from "./evidence.js";
import { makeWorld, makeBranchWorld, resolveTurn } from "./world.js";
import { ActionLedger, commitTurn, projectWorld } from "./contracts.js";
import { parameterRegistry } from "./parameters.js";
import { assertValidSchema } from "./schema.js";
import { replayMemoryOperation, MEMORY_PARSER_HASH, MEMORY_PHASE_INSTRUCTION, memoryInterface, parseMemoryOperation } from "./memory.js";
import { assertAgentCondition, participantModelProjection, verifyConditionExposure } from "./agent.js";
import { ACTION_PARSER_HASH, parseAction, renderCompletion } from "./model-adapter.js";
import { replayTurnPhaseCommand, PHASE_COMMAND_MECHANIC, DIPLOMACY_COMMANDS } from "./turn-phases.js";
import { archivedCoding } from "./coding.js";
import { verifyArchiveTrust } from "./archive-trust.js";

const authorities = new WeakSet();
export function createAuthorizationContext(domain, principal = "system") {
  assert(["participant_projection", "research_observation", "trusted_replay", "security_audit", "public_release"].includes(domain), "unknown authorization domain");
  const context = Object.freeze({ domain, principal }); authorities.add(context); return context;
}

function redactionStatus(bundle) {
  const tombstones = bundle?.events?.filter(event => event.event_type === "RedactionTombstone") ?? [];
  const marked = bundle?.redaction_status === "REPLAY_INCOMPLETE_REDACTED" ||
    bundle?.events?.some(event => event.payload?.redacted === true) || bundle?.removed_payload_refs?.length;
  if (!marked && !tombstones.length) return null;
  assert(tombstones.length > 0, "redacted evidence requires canonical tombstone metadata");
  for (const event of tombstones) {
    assert(event.run_id === bundle.run_id && !event.payload?.redacted, "invalid redaction tombstone envelope");
    const payload = clone(event.payload); delete payload.payload_ref;
    assertValidSchema(payload, "redaction-tombstone.schema.json");
  }
  // This is a completeness classification, not a signature/integrity check.
  // The externally bound signed-archive verifier authenticates purged exports.
  return { status: "REPLAY_INCOMPLETE_REDACTED", integrity_verified: false,
    authenticity_verified: false, exact_reproducibility: false };
}

export function verifyEvidenceIntegrity(bundle) {
  const incomplete = redactionStatus(bundle);
  if (incomplete) return incomplete;
  loadEvidence(bundle);
  return { status: "EVIDENCE_INTEGRITY_VERIFIED", exact_reproducibility: false };
}

function content(store, ref) {
  const value = store.payloads.get(ref);
  assert(value && sha256(value.bytes) === ref, "missing or altered content-addressed evidence: " + ref);
  return JSON.parse(value.bytes);
}

// These archived inputs are never substituted for world transitions.
// Replaying a model response does not assert that the model was re-invoked.
const EXTERNAL = new Set(["ModelInvocation", "MemoryOperation", "ProjectionIssued", "InterviewResponse", "Violation", "SecurityIncident", "CommitmentCoded", "BehaviorCoded"]);

const same = (a, b) => canonicalize(a) === canonicalize(b);
function rawText(store, ref) {
  const value = content(store, ref);
  assert(value?.encoding === "base64", "invocation requires exact raw input/output bytes");
  return Buffer.from(value.data, "base64").toString("utf8");
}
function projectionSource(world, event, phaseState = null) {
  if (event.phase === "interview") {
    const snapshot = world.snapshots.findLast(item => item.turn === event.turn);
    assert(snapshot, "interview lacks independently reproduced post-turn snapshot");
    return { ...world, ...snapshot.state, runId: world.runId, turn: snapshot.turn, phase: "interview" };
  }
  if (phaseState && !phaseState.closed) {
    assert(event.turn === phaseState.turn && event.phase === phaseState.phase, "invocation authoritative phase lifecycle mismatch");
    return { ...world, turn: phaseState.turn, phase: phaseState.phase,
      actionTypes: world.actionTypes.filter(type => DIPLOMACY_COMMANDS.includes(type) === (phaseState.phase === "diplomacy")) };
  }
  assert(event.turn === world.turn && event.phase === world.phase, "invocation authoritative logical time/phase mismatch");
  return world;
}

// A captured output is an external input. Its identity, lifecycle and permitted
// inputs are still independently checkable without calling the model again.
function validateInvocation(event, world, archive, invocations, memories, phaseState = null) {
  const p = event.payload, actor = event.participants[0], diagnostic = modelDiagnostic(archive, event);
  assert(event.participants.length === 1 && world.polities[actor]?.alive &&
    same(event.lineage.persistent_identity_ids, [actor]) && same(event.lineage.session_ids, [p.session_id]) &&
    same(event.lineage.invocation_ids, [p.invocation_id]), "invocation envelope/payload lineage mismatch");
  const projection = content(archive, p.projection_ref), source = projectionSource(world, event, phaseState);
  assert(same(projection, projectWorld(source, actor)), "invocation differs from authorized world projection");
  const manifest = content(archive, p.model_runtime_hash);
  // The RunService transport fixture is explicitly synthetic and has a paired
  // dispatch/result record. It never represents a production model condition.
  const transportFixture = p.condition_id === "synthetic-validation" && manifest.synthetic === true && p.context_segments.length === 0;
  const stage = diagnostic?.stage ?? (transportFixture ? (content(archive, p.rendered_output_ref)?.status === "dispatch" ? "dispatch" : "complete") : null);
  assert(["dispatch", "complete"].includes(stage), "invocation requires dispatch/completion diagnostics");
  const prior = invocations.get(p.invocation_id);
  const identity = { actor, run_id: p.run_id, session_id: p.session_id, condition_id: p.condition_id, turn: event.turn, phase: event.phase,
    rendered_input_ref: p.rendered_input_ref, model_runtime_hash: p.model_runtime_hash, parser_hash: p.parser_hash,
    projection_ref: p.projection_ref, memory_refs: p.memory_refs, tool_result_refs: p.tool_result_refs,
    context_segments: p.context_segments, attempt: p.attempt, retry_of: p.retry_of, configuration_hash: event.provenance.configuration_hash };
  if (stage === "dispatch") {
    assert(!prior, "duplicate invocation dispatch or reused invocation ID");
    assert(![...invocations.values()].some(item => item.stage === "dispatch" && item.identity.session_id === p.session_id), "session already has an unresolved invocation");
    assert(p.action_ref === null, "dispatch cannot contain a parsed action");
    if (p.retry_of !== null) {
      const retry = invocations.get(p.retry_of);
      assert(retry?.stage === "complete" && retry.diagnostic?.classification === "infrastructure" &&
        retry.diagnostic?.retryable === true && p.attempt === retry.identity.attempt + 1, "invalid invocation retry predecessor");
      const retryIdentity = { ...identity, context_segments: identity.context_segments.map(({ segment_id, ...s }) => s), attempt: null, retry_of: null };
      const priorIdentity = { ...retry.identity, context_segments: retry.identity.context_segments.map(({ segment_id, ...s }) => s), attempt: null, retry_of: null };
      assert(same(retryIdentity, priorIdentity) && event.lineage.parent_event_ids.includes(retry.event.event_id), "retry input/session/parent substitution");
      assert(![...invocations.values()].some(item => item.identity.retry_of === p.retry_of), "retry predecessor already consumed");
    } else {
      assert(p.attempt === 1, "initial invocation attempt must be one");
      if (!transportFixture) assert(event.lineage.parent_event_ids.some(id => world.evidence.events.some(e =>
        e.event_id === id && e.event_type === "ProjectionIssued" && e.payload.payload_ref === p.projection_ref &&
        e.participants.includes(actor) && same(e.lineage.session_ids, [p.session_id]))), "dispatch lacks its canonical projection/session parent");
    }
  } else {
    assert(prior?.stage === "dispatch", "completion without an unresolved dispatch");
    assert(same(prior.identity, identity), "completion changed invocation inputs/lineage");
    if (!transportFixture) assert(same(event.lineage.parent_event_ids, [prior.event.event_id]), "completion lacks dispatch parent");
  }
  if (!transportFixture) {
    assert(diagnostic && diagnostic.configuration_ref && diagnostic.request_ref && diagnostic.response_ref, "incomplete invocation diagnostics");
    const config = content(archive, diagnostic.configuration_ref), condition = assertAgentCondition(config.condition);
    assert(condition.condition_id === p.condition_id && same(config.configuration.model, manifest), "invocation runtime/condition manifest mismatch");
    assert(p.attempt <= condition.retry.max_attempts && diagnostic.retry_of === p.retry_of && Number.isFinite(diagnostic.deadline) &&
      Number.isFinite(diagnostic.recorded_at) && diagnostic.recorded_at >= 0, "invocation attempt/deadline mismatch");
    if (phaseState && !phaseState.closed && event.phase !== "interview") assert(diagnostic.deadline <= phaseState.deadline_at &&
      diagnostic.deadline > phaseState.opened_at && diagnostic.recorded_at >= phaseState.opened_at, "invocation exceeds authoritative phase deadline");
    if (prior) assert(diagnostic.deadline === prior.diagnostic.deadline && diagnostic.recorded_at >= prior.diagnostic.recorded_at, "completion deadline/time substitution");
    if (p.retry_of) assert(diagnostic.deadline === invocations.get(p.retry_of).diagnostic.deadline &&
      diagnostic.recorded_at >= invocations.get(p.retry_of).diagnostic.recorded_at, "retry renewed phase deadline or reversed clock");
    verifyConditionExposure([p]);
    const priorActor = [...invocations.values()].find(item => item.identity.actor === actor && item.identity.phase !== "interview");
    if (event.phase !== "interview" && priorActor) assert(priorActor.identity.condition_id === p.condition_id, "invocation changed history-access treatment");
    const memory = memories.get(actor), records = condition.memory.mode === "state_only" ? [] : memory?.records ?? [];
    if (memory && event.phase !== "interview") assert(memory.ownerSessionId === p.session_id, "invocation lacks canonical memory session transfer");
    const memorySegments = p.context_segments.filter(s => s.class === "memory_record");
    assert(same(memorySegments.map(s => s.source_ref), records.map(r => r.id)) &&
      same(memorySegments.map(s => rawText(archive, s.content_ref)), records.map(r => r.text)) &&
      same(p.memory_refs, memorySegments.map(s => s.content_ref)), "invocation memory differs from canonical history-access state");
    const authorized = participantModelProjection(projection, { runId: world.runId, actorId: actor, turn: event.turn });
    const memoryPhase = event.phase === "memory_update";
    assert(memoryPhase ? p.parser_hash === MEMORY_PARSER_HASH && condition.memory.mode !== "state_only"
      : p.parser_hash === ACTION_PARSER_HASH || event.phase === "interview", "invocation phase/parser mismatch");
    const visible = memoryPhase ? { ...authorized, memory_interface: memoryInterface(records, world.config.memory.capacity) } : authorized;
    assert(same(p.context_segments.map(s => s.class), ["trusted_instruction", "authorized_projection", ...records.map(() => "memory_record")]), "undeclared invocation context segments");
    assert(same(content(archive, p.context_segments[1].content_ref), visible) && p.context_segments[1].source_ref === p.projection_ref,
      "invocation context projection substitution");
    const instruction = rawText(archive, p.context_segments[0].content_ref);
    if (memoryPhase) assert(instruction === MEMORY_PHASE_INSTRUCTION, "memory phase instruction substitution");
    assert(rawText(archive, p.rendered_input_ref) === renderCompletion({ instruction, projection: visible, memory: records.map(r => r.text) }), "rendered prompt differs from declared inputs");
    if (stage === "dispatch") assert(diagnostic.classification === "pending" && diagnostic.parsed_output_ref === null, "invalid dispatch diagnostics");
    else if (diagnostic.classification === "success") {
      assert(diagnostic.recorded_at < diagnostic.deadline, "successful invocation completed after phase deadline");
      assert(diagnostic.parsed_output_ref !== null, "successful invocation lacks parsed output");
      const parsed = content(archive, diagnostic.parsed_output_ref), output = rawText(archive, p.rendered_output_ref);
      if (p.parser_hash === ACTION_PARSER_HASH) assert(same(parsed, parseAction(output, { maxActions: world.config.phases.actionLimit })) && p.action_ref === diagnostic.parsed_output_ref, "parsed action differs from captured model output");
      else if (memoryPhase) assert(same(parsed, parseMemoryOperation(output, { records, capacity: world.config.memory.capacity })) &&
        p.action_ref === null, "parsed memory operation differs from captured model output");
      else if (event.phase === "interview") assert(parsed === output && p.action_ref === null, "interview parsed output mismatch");
    } else assert(p.action_ref === null && diagnostic.parsed_output_ref === null, "failed invocation contains accepted parsed output");
  }
  invocations.set(p.invocation_id, { stage, identity, diagnostic, event });
}

function validateSecurityDisposition(event, world) {
  const p = event.payload, policy = p.replacement_policy;
  assert(event.phase === "security" && ["invalid", "contaminated", "interrupted", "incomplete"].includes(p.execution_status),
    "world termination disposition must be regenerated by the reducer");
  assert(event.integrity.append_authority === "canonical-event-store" && event.provenance.recorded_by === "canonical-event-store" &&
    ["engine", "run_controller"].includes(event.provenance.source) && event.provenance.operation === "RunDisposition",
  "security disposition append authority mismatch");
  const incident = world.evidence.events.find(prior => prior.event_id === policy?.incident_ref && prior.event_type === "SecurityIncident");
  assert(incident && incident.run_id === world.runId && p.run_id === world.runId &&
    event.causality.causation_ids.includes(incident.event_id), "security disposition requires a causal same-run incident");
  assert(incident.phase === "security" && incident.integrity.append_authority === "canonical-event-store" &&
    incident.provenance.recorded_by === "canonical-event-store" && ["engine", "security_monitor"].includes(incident.provenance.source),
  "security incident append authority mismatch");
  assert(event.turn === incident.turn && event.turn <= world.turn && incident.payload.logical_time.turn === incident.turn,
    "security disposition logical time mismatch");
  assert(policy.policy_ref === "BREACH_POLICY.spec.json" &&
    incident.payload.analytical_eligibility.policy_ref === "BREACH_POLICY.spec.json", "security disposition policy authority mismatch");
  assert([event.event_id, policy.policy_ref].includes(incident.payload.run_disposition_ref), "security incident disposition binding mismatch");
  assert(p.experimental_validity.confirmatory_eligible === false && p.endpoint_eligibility.primary_confirmatory === false &&
    p.security_eligibility.security_analysis_eligible === true && p.exploratory_only === true &&
    incident.payload.analytical_eligibility.confirmatory_eligible === false && incident.payload.analytical_eligibility.security_analysis_eligible === true,
  "security disposition violates breach eligibility policy");
  assert(p.evidence_validity.canonical_record_accurate === true && p.evidence_completeness.status === "complete" &&
    p.evidence_completeness.preserve_run === true, "security disposition must preserve complete canonical evidence");
  // These checks validate the recorded authority contract. Run-derived HMACs
  // alone still do not authenticate who actually appended the external input.
}

function validateInterview(event, world, archive, invocations) {
  const p = event.payload, actor = event.participants[0];
  const invocation = invocations.get(p.invocation_id);
  assert(event.participants.length === 1 && invocation?.stage === "complete" &&
    invocation.identity.actor === actor && invocation.identity.phase === "interview" &&
    invocation.identity.session_id === p.session_id, "interview requires a matching completed model invocation");
  assert(same(event.lineage.persistent_identity_ids, [actor]) &&
    same(event.lineage.session_ids, [p.session_id]) && same(event.lineage.invocation_ids, [p.invocation_id]) &&
    same(event.lineage.parent_event_ids, [invocation.event.event_id]), "interview invocation/envelope lineage mismatch");
  assert(p.response_payload_ref === invocation.event.payload.rendered_output_ref &&
    p.projection_ref === invocation.event.payload.projection_ref,
  "interview response/projection differs from completed invocation");
  const proof = content(archive, p.isolation_proof_ref);
  const snapshot = world.snapshots.findLast(item => item.turn === event.turn);
  assert(snapshot && proof.snapshot_ref === sha256(snapshot.state) &&
    same(content(archive, proof.snapshot_ref), snapshot.state), "interview isolation snapshot mismatch");
  assert(proof.authorized_projection_ref === p.projection_ref &&
    same(content(archive, proof.authorized_projection_ref), projectWorld({ ...world, ...snapshot.state,
      runId: world.runId, turn: snapshot.turn, phase: "interview" }, actor)), "interview isolation projection mismatch");
  assert(proof.interview_session === p.session_id && proof.cross_interview_input === false &&
    proof.prior_answers_available === false && same(proof.writeback, []) && proof.qualitative_only === true,
  "interview isolation contract mismatch");
}

export function reconstructRun(bundle, { allowPendingCommit = false } = {}) {
  assert(!redactionStatus(bundle), "REPLAY_INCOMPLETE_REDACTED: exact reconstruction unavailable");
  const archive = loadEvidence(bundle);
  const events = archive.events;
  // Derived coding is external interpretation, not a world reducer output, but
  // EXACT_REPLAY certifies the complete canonical bundle. Rebuild and validate
  // its blinded packet/adjudication chain before allowing it through as an
  // external record; evidence hashes alone cannot authenticate its semantics.
  if (events.some(event => event.event_type === "BehaviorCoded")) archivedCoding(bundle);
  assert(events.length && events[0].event_type === "RunCreated", "missing canonical run creation");
  const genesis = events[0].payload;
  assert(genesis.engine_version === "pilot-0.2", "unsupported or absent replay engine version");
  const config = content(archive, genesis.configuration_ref);
  assert(sha256(config) === genesis.config_hash, "frozen configuration mismatch");
  assert(canonicalize(content(archive, genesis.parameter_registry_ref)) === canonicalize(parameterRegistry(config)), "frozen parameter registry mismatch");
  const initial = content(archive, genesis.initial_state_ref);
  const parentState=genesis.parent_run_id?content(archive,genesis.parent_state_ref):null;
  const world = genesis.parent_run_id
    ? makeBranchWorld({ runId: bundle.run_id, seed: genesis.seed, config, initialState: initial, parentState, genesis })
    : makeWorld({ runId: bundle.run_id, seed: genesis.seed, config });
  assert(canonicalize(world.authoritativeState()) === canonicalize(initial), "initial state does not match frozen generator inputs");
  const ledger = new ActionLedger(world.evidence);
  const validated = new Map();
  const memories = new Map(), invocations = new Map();
  let cursor = 0, resolvedTurns = 0, pendingCommit = null, executionStopped = false;
  let phaseState = null, phaseBindings = null;
  function compareNew() {
    for (; cursor < world.evidence.events.length; cursor++) {
      assert(cursor < events.length, "re-execution produced omitted canonical events");
      assert(canonicalize(world.evidence.events[cursor]) === canonicalize(events[cursor]), "re-execution canonical event mismatch at " + cursor + " (" + events[cursor].event_type + ")");
    }
  }
  function appendExternal(event) {
    for (const [key,value] of archive.payloads) if (!world.evidence.payloads.has(key)) world.evidence.payloads.set(key, clone(value));
    const payload = clone(event.payload); delete payload.payload_ref;
    world.evidence.append({ eventType: event.event_type, turn: event.turn, phase: event.phase, payload, participants: event.participants,
      visibility: event.visibility, causality: event.causality, lineage: event.lineage, provenance: event.provenance,
      rng: event.rng, source: event.provenance.source });
  }
  compareNew();
  while (cursor < events.length) {
    const event = events[cursor], p = event.payload;
    if (event.event_type === "WorldTransition" && p.mechanic === PHASE_COMMAND_MECHANIC && p.detail?.stage === "input") {
      assert(!executionStopped, "phase command after security stop");
      const start = world.evidence.events.length, previousTurn = world.turn;
      const generated = replayTurnPhaseCommand({ world, ledger, archive, cursor, state: phaseState, bindings: phaseBindings });
      phaseState = generated.phaseState; phaseBindings = generated.phaseBindings;
      resolvedTurns += world.turn - previousTurn;
      pendingCommit = phaseState.committed_id && !world.resolvedCommits.has(phaseState.committed_id)
        ? world.committedRecords.get(phaseState.committed_id) : null;
      for (const emitted of world.evidence.events.slice(start)) if (emitted.event_type === "MemoryOperation") {
        const id = emitted.payload.identity_ref;
        memories.set(id, replayMemoryOperation(world.evidence, emitted, memories.get(id)));
      }
      for (const submission of ledger.submissions.values()) if (submission.status === "validated")
        validated.set(submission.submission_id, { submission: clone(submission), accepted: clone(submission.actions) });
    } else if (event.event_type === "ActionSubmitted") {
      assert(!phaseState || phaseState.closed, "phase submission lacks a recorded controller command");
      assert(!pendingCommit && !executionStopped, "submission after sealed commit or security stop");
      assert(p.run_id === world.runId && p.turn_id === "turn-" + world.turn, "submission run/turn mismatch");
      ledger.submit({ runId: p.run_id, turnId: p.turn_id, actorId: p.actor_id, actor: p.actor, actions: p.submitted_actions, projection: projectWorld(world, p.actor_id), phase: p.phase, priorSubmissionId: p.prior_submission_id });
    } else if (["ActionValidated", "ActionRejected"].includes(event.event_type)) {
      assert(!pendingCommit && !executionStopped, "validation after sealed commit or security stop");
      const submitted = ledger.submissions.get(p.submission_id); assert(submitted, "validation lacks prior submission");
      const result = ledger.validate(submitted, world); validated.set(p.submission_id, result);
    } else if (["ActionAccepted", "TurnCommitted"].includes(event.event_type)) {
      assert(!pendingCommit && !executionStopped, "commit after sealed commit or security stop");
      const standalone = event.event_type === "TurnCommitted";
      const commitEvent = standalone ? event : events.slice(cursor).find(e => e.event_type === "TurnCommitted");
      assert(commitEvent, "acceptance without immutable committed turn");
      assert(!standalone || commitEvent.payload.accepted_submission_ids.length === 0,
        "nonempty commit lacks canonical action acceptance");
      const records = commitEvent.payload.accepted_submission_ids.map(id => {
        const record = validated.get(id); assert(record, "commit references unvalidated submission"); return record;
      });
      const acceptedOrder = events.slice(cursor, commitEvent.sequence).filter(e => e.event_type === "ActionAccepted").map(e => e.payload.submission_id);
      records.sort((a,b) => acceptedOrder.indexOf(a.submission.submission_id) - acceptedOrder.indexOf(b.submission.submission_id));
      // Recompute even the empty accepted set using the real commit contract.
      // No archived world transition or snapshot is ever used as reducer output.
      pendingCommit = commitTurn(world, ledger, records);
    } else if (event.event_type === "RunDisposition") {
      validateSecurityDisposition(event, world);
      appendExternal(event); executionStopped = true;
    } else if (EXTERNAL.has(event.event_type)) {
      if (event.event_type === "MemoryOperation") {
        assert(event.turn <= world.turn && world.polities[p.identity_ref]?.alive, "memory authoritative time/principal mismatch");
        const state = replayMemoryOperation(archive, event, memories.get(p.identity_ref));
        assert(state.capacity === world.config.memory.capacity, "memory capacity differs from frozen world configuration");
        memories.set(p.identity_ref, state);
      }
      if (event.event_type === "ModelInvocation") validateInvocation(event, world, archive, invocations, memories, phaseState);
      if (event.event_type === "InterviewResponse") validateInterview(event, world, archive, invocations);
      if (event.event_type === "ProjectionIssued") {
        const source = projectionSource(world, event, phaseState);
        assert(canonicalize(content(archive, p.payload_ref)) === canonicalize(projectWorld(source, p.principal.principal_id)), "archived projection differs from authorized world projection");
      }
      appendExternal(event);
    } else if (pendingCommit) {
      assert(!executionStopped, "world resolution after security stop");
      resolveTurn(world, pendingCommit); pendingCommit = null; resolvedTurns++;
    } else {
      throw new Error("unexpected or uncaused canonical transition: " + event.event_type);
    }
    compareNew();
  }
  assert(!pendingCommit || allowPendingCommit || executionStopped, "re-execution produced omitted canonical events: unresolved committed turn");
  assert(allowPendingCommit || executionStopped || [...invocations.values()].every(item => item.stage === "complete"),
    "exact replay unavailable: unresolved model invocation");
  world.evidence.verify();
  return { world, ledger, validated, pendingCommit, resolvedTurns, executionStopped, memories, invocations, phaseState, phaseBindings };
}

function verifyBranchParentArchive(bundle, parentArchiveBinding) {
  const genesis = bundle.events[0].payload;
  assert(parentArchiveBinding?.exported && parentArchiveBinding?.trust,
    "exact branch replay requires an externally authenticated parent archive/head binding");
  const { exported, trust } = parentArchiveBinding;
  assert(trust.runId === genesis.parent_run_id, "branch parent archive run binding mismatch");
  const authenticated = verifyArchiveTrust(exported, trust);
  assert(authenticated.status === "COMPLETE", "branch parent archive must contain complete evidence");
  const parentBundle = exported.object.bundle;
  assert(parentBundle.run_id === genesis.parent_run_id, "branch parent archive run mismatch");
  assert(parentBundle.events.at(-1)?.integrity.canonical_bytes_hash === genesis.parent_event_head,
    "branch parent event head binding mismatch");
  const parent = reconstructRun(parentBundle);
  assert(parent.world.evidence.previousHash === genesis.parent_event_head,
    "branch parent reconstructed head mismatch");
  const inherited = JSON.parse(bundle.payloads[genesis.parent_state_ref].bytes);
  assert(canonicalize(parent.world.authoritativeState()) === canonicalize(inherited),
    "branch inherited state does not match authenticated parent head");
  return authenticated;
}

export function replay(bundle, { expectedRunId, redacted = false, authorizationContext, parentArchiveBinding = null } = {}) {
  assert(authorities.has(authorizationContext), "replay requires an issued authorization context");
  assert(["trusted_replay", "security_audit"].includes(authorizationContext.domain), "participant replay requires a projection-scoped replay service");
  assert(bundle?.events?.length, "cannot certify empty replay");
  assert(bundle.run_id === expectedRunId, "replay run mismatch");
  const integrity = verifyEvidenceIntegrity(bundle);
  if (redacted || integrity.status === "REPLAY_INCOMPLETE_REDACTED") return {
    status: "REPLAY_INCOMPLETE_REDACTED", run_id: expectedRunId, exact_reproducibility: false,
    integrity_verified: integrity.status === "EVIDENCE_INTEGRITY_VERIFIED", authenticity_verified: false };
  const { world, resolvedTurns } = reconstructRun(bundle);
  assert(resolvedTurns > 0, "exact replay requires at least one independently re-executed turn");
  const branchParent = bundle.events[0].payload.parent_run_id
    ? verifyBranchParentArchive(bundle, parentArchiveBinding) : null;
  return { status: "EXACT_REPLAY", run_id: world.runId, exact_reproducibility: true, resolved_turns: resolvedTurns, event_count: world.evidence.events.length, event_head: world.evidence.previousHash, state_digest: world.stateHash(), authoritative_state: world.authoritativeState(), authorization_domain: authorizationContext.domain,
    ...(branchParent ? { parent_archive_authenticity: branchParent.authenticity,
      parent_run_id: bundle.events[0].payload.parent_run_id, parent_event_head: bundle.events[0].payload.parent_event_head } : {}) };
}

export function verifyReplay(bundle, expectedRunId) { return replay(bundle, { expectedRunId, authorizationContext: createAuthorizationContext("trusted_replay") }).exact_reproducibility; }
