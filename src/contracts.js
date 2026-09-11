import { assert, clone, sha256, stableId, EVENT_CATALOGUE_VERSION } from "./core.js";
import { projectWorldState } from "./world-map.js";
import { PUBLIC_ACTION_CONTRACT } from "./action-contract.js";
const publicActionContract=PUBLIC_ACTION_CONTRACT;
export const ACTION_CONTRACT_HASH=sha256(publicActionContract);

export const PROJECTION_POLICY = Object.freeze({
  policy_version: "pilot-0.1",
  participant_fields: ["own.polity_state", "public.discovered_world_state", "own.knowledge", "public.known_map", "public.known_territories", "public.rules", "own.intelligence", "authorized.messages", "authorized.channels", "own.memory", "own.available_actions", "public_safe.validation_results"],
  denied: ["true_world_state", "undiscovered.foreign_state", "unauthorized.private_channels", "observer_truth", "security_audit", "raw_other_agent_memory", "redacted_content", "debug_authority_data"]
});

export function projectionDigest(projection) { const stable = clone(projection); if (stable.logical_time) stable.logical_time.event_head = null; for (const field of stable.fields ?? []) field.source_event_refs = []; return sha256(stable); }

export function publicRules(world) {
  const c=world.config;
  // Pure public mechanics, never start allocation, roster, seeds or model arm.
  assert(c.unitTypes && c.facilityTypes && c.technologies,"public rules configuration missing");
  return {version:c.version,rules:{units:clone(c.unitTypes),facilities:clone(c.facilityTypes),technologies:clone(c.technologies),
    assignments:Object.fromEntries(Object.entries(c.assignments).map(([key,{starting,...rule}])=>[key,clone(rule)])),
    terrain:clone(c.geography.terrain),contactRadius:c.map.contactRadius,citizenMovement:c.dynamics.citizenMovement,
    explorerMovement:c.dynamics.explorerMovement,defaultUnit:c.dynamics.defaultUnit,foodPerCitizen:c.economy.foodPerCitizen,conditionMaximum:c.dynamics.conditionMaximum,
    action_contract:clone(publicActionContract),action_contract_hash:ACTION_CONTRACT_HASH,action_limit:c.phases.actionLimit}};
}

export function projectWorld(world, actorId) {
  const actor = world.polities[actorId];
  assert(actor, "unknown projection principal");
  // Knowledge of an identity is not live access to its state. The world projection
  // returns only observed facts, their age, and the principal's authorized state.
  const view = projectWorldState(world, actorId);
  const visiblePolities = Object.fromEntries(Object.entries(view.known.polities).map(([id,fact]) => [id, clone(fact.value)]));
  const values = { "own.polity_state": view.own, "public.discovered_world_state": visiblePolities,
    "own.knowledge": [...actor.knowledge].sort(), "public.known_map": view.map, "public.known_territories": view.territories,
    "own.intelligence": { facts: view.known, reports: view.reports }, "authorized.messages": view.messages,
    "authorized.channels": view.channels, "own.available_actions": view.available_actions, "public.rules": publicRules(world) };
  const sourceEventRefs = []; // Participant observations never expose global event sequence metadata.
  return { schema_version: "1.0.0", projection_id: stableId("projection", world.runId, world.turn, actorId, sha256(values)), run_id: world.runId, principal: { principal_id: actorId, principal_type: "polity", acl_version: PROJECTION_POLICY.policy_version }, logical_time: { turn: world.turn, phase: world.phase, event_head: null }, source_state_hash: sha256(values), fields: Object.entries(values).map(([path,value]) => ({path,value,source_event_refs:sourceEventRefs,audience:actorId})), redactions: PROJECTION_POLICY.denied.map((path) => ({ path, reason: "deny_by_default" })), surface_policy: { prompt: "projection_only", memory: "projection_only", api: "projection_only", ui: "projection_only", accessibility: "projection_only", replay: "projection_only", debug: "projection_only" }, cache_policy: { principal_bound: true, logical_time_bound: true, version_bound: true }, export_policy: { audience: actorId, retention_class: "participant", disclosure_rule: "explicit" } };
}

export class ActionLedger {
  constructor(evidence) { this.evidence = evidence; this.submissions = new Map(); this.accepted = new Map(); this.sequence = 0; }

  submit({ runId, turnId, actorId, actor, actions, projection, phase = "actions", priorSubmissionId = null }) {
    assert(runId === projection.run_id && projection.principal?.principal_id === actorId, "submission projection is not bound to actor/run");
    assert(projection.logical_time?.turn === Number.parseInt(String(turnId).replace(/^turn-/, ""), 10), "submission projection is stale");
    assert(actor?.persistent_identity_id === actorId && actor.session_id && actor.invocation_id, "incomplete actor lineage");
    const submissionId = stableId("submission", runId, turnId, actorId, this.sequence++);
    // Attempt identity preserves arrival/retry lineage. Causal action identity
    // does not use another actor's arrival position or the global attempt count.
    const submittedActions = clone(actions);
    const actionList = submittedActions.map(({action_id: participantLabel, ...action}, i) => ({ ...action, action_id: stableId("action", runId, turnId, actorId, i, sha256(action)) }));
    // Preserve the literal submission as restricted evidence, never as a persistent
    // participant-visible state identifier or a source of simultaneous precedence.
const record = { schema_version: "1.0.0", submission_id: submissionId, run_id: runId, turn_id: turnId, actor_id: actorId, actor: clone(actor), phase, projection_id: projection.projection_id, projection_version_ref: projection.schema_version, projection_hash: projectionDigest(projection), submitted_actions: submittedActions, actions: actionList, action_hash: sha256(actionList), status: "submitted", validation: { projection_scoped: true, deterministic: true, public_safe_errors: true }, atomicity: { turn_committed_ref: null, immutable_after_commit: false }, catalogue_version: EVENT_CATALOGUE_VERSION, prior_submission_id: priorSubmissionId };
    this.submissions.set(submissionId, record);
    this.evidence.append({ eventType: "ActionSubmitted", turn: Number.parseInt(String(turnId).replace(/^turn-/, ""), 10), phase, payload: record, participants: [actorId], lineage: { persistent_identity_ids: [actorId], session_ids: [actor.session_id], invocation_ids: [actor.invocation_id] } });
    return clone(record);
  }

  validate(submission, world) {
    assert(this.submissions.has(submission.submission_id), "submission not issued by ledger");
    submission = clone(this.submissions.get(submission.submission_id));
    assert(submission.run_id === world.runId && submission.turn_id === `turn-${world.turn}` && submission.status === "submitted", "submission is not valid for this turn");
    const currentProjection = projectWorld(world, submission.actor_id);
    assert(currentProjection.projection_id === submission.projection_id && projectionDigest(currentProjection) === submission.projection_hash, "submission projection mismatch");
    const accepted = [];
    const errors = [];
    if(submission.actions.length>world.config.phases.actionLimit)errors.push({code:'action_limit_exceeded'});
    for (const action of submission.actions) {
      const valid = world.validateAction(submission.actor_id, action);
      if (valid.ok) accepted.push(action); else errors.push({ action_id: action.action_id, code: valid.code });
    }
    submission.status = errors.length ? "rejected" : "validated";
    submission.validation = { projection_scoped: true, deterministic: true, public_safe_errors: true, errors };
    this.submissions.set(submission.submission_id, clone(submission));
    this.evidence.append({ eventType: errors.length ? "ActionRejected" : "ActionValidated", turn: world.turn, phase: world.phase, payload: { submission_id: submission.submission_id, accepted_action_ids: accepted.map((a) => a.action_id), errors }, causality: { causation_ids: [world.evidence.events.find(e => e.event_type === "ActionSubmitted" && e.payload.submission_id === submission.submission_id).event_id] }, participants: [submission.actor_id] });
    return { submission, accepted };
  }
}

export function commitTurn(world, ledger, validatedByActor) {
  assert(Array.isArray(validatedByActor), "validation set required");
  const seenActors = new Set();
  for (const item of validatedByActor) { const stored = ledger.submissions.get(item.submission.submission_id); assert(stored, "unissued submission at commit"); assert(stored.run_id === world.runId && stored.turn_id === `turn-${world.turn}` && stored.status === "validated", "only validated submissions may commit"); assert(item.submission.actor_id === stored.actor_id && item.submission.run_id === stored.run_id && item.submission.turn_id === stored.turn_id, "submission lineage mismatch"); assert(sha256(stored.actions) === sha256(item.accepted), "accepted actions do not match validated submission"); assert(!seenActors.has(stored.actor_id), "duplicate actor submission"); seenActors.add(stored.actor_id); }
  const acceptedActions = validatedByActor.flatMap(({ submission }) => { const stored = ledger.submissions.get(submission.submission_id); return stored.actions.map((action) => ({ ...action, actor_id: stored.actor_id, submission_id: stored.submission_id, session_id: stored.actor.session_id, invocation_id: stored.actor.invocation_id })); }).sort((a, b) => a.action_id.localeCompare(b.action_id));
  assert(new Set(acceptedActions.map((action) => action.action_id)).size === acceptedActions.length, "duplicate action_id at commit");
  const claimedUnits = new Set();
  for (const action of acceptedActions.filter((item) => ["move", "attack"].includes(item.type))) {
    assert(!claimedUnits.has(action.unit_id), "unit may participate in only one simultaneous action");
    claimedUnits.add(action.unit_id);
  }
  const committedId = stableId("committed", world.runId, world.turn, sha256(acceptedActions));
  const record = { schema_version: "1.0.0", turn_committed_id: committedId, run_id: world.runId, turn_id: `turn-${world.turn}`, turn: world.turn, input_state_hash: world.stateHash(), accepted_submission_ids: validatedByActor.map((x) => x.submission.submission_id).sort(), accepted_action_ids: acceptedActions.map((x) => x.action_id).sort(), actor_action_refs: acceptedActions.map((x) => `${x.actor_id}:${x.action_id}`).sort(), projection_version_refs: validatedByActor.map((x) => x.submission.projection_version_ref).sort(), configuration_hash: sha256(world.config), rng_provenance_root_ref: sha256(world.rng.seed), rng_provenance_refs: [], lineage_refs: acceptedActions.flatMap((x) => [x.actor_id, x.session_id, x.invocation_id]).sort(), action_set_hash: sha256(acceptedActions), commit_event_id: stableId("evt", world.runId, world.evidence.events.length + validatedByActor.length), catalogue_version: EVENT_CATALOGUE_VERSION, immutable_after_commit: true, acceptedActions };
  for (const item of validatedByActor) { const stored = clone(ledger.submissions.get(item.submission.submission_id)); stored.status = "accepted"; stored.atomicity = { turn_committed_ref: committedId, immutable_after_commit: true }; ledger.submissions.set(stored.submission_id, stored); world.evidence.append({ eventType: "ActionAccepted", turn: world.turn, phase: "commit", payload: { submission_id: stored.submission_id, accepted_action_ids: stored.actions.map((a) => a.action_id), turn_committed_id: committedId, actor_id: stored.actor_id }, causality: { causation_ids: [world.evidence.events.find(e => e.event_type === "ActionValidated" && e.payload.submission_id === stored.submission_id).event_id] }, participants: [stored.actor_id], lineage: { persistent_identity_ids: [stored.actor_id], session_ids: [stored.actor.session_id], invocation_ids: [stored.actor.invocation_id] } }); }
  const eventPayload = clone(record); delete eventPayload.acceptedActions;
  world.evidence.append({ eventType: "TurnCommitted", turn: world.turn, phase: "commit", payload: eventPayload, participants: record.lineage_refs, causality: { causation_ids: world.evidence.events.filter(e => e.event_type === "ActionAccepted" && e.payload.turn_committed_id === committedId).map(e => e.event_id) } });
  world.committedRecords ??= new Map(); world.committedRecords.set(committedId, clone(record));
  return record;
}
