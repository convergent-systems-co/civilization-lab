import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ActionLedger, commitTurn, PROJECTION_POLICY, projectWorld } from "../src/contracts.js";
import { EvidenceStore } from "../src/evidence.js";
import { DeterministicModel, AgentRuntime, PILOT_0_AGENT_CONDITION, PILOT_0_AGENT_CONDITIONS } from "../src/agent.js";
import { MemoryStore } from "../src/memory.js";
import { replay, createAuthorizationContext } from "../src/replay.js";
import { AddressableRng } from "../src/rng.js";
import { cloneWorld, makeWorld, PILOT_0_CONFIG, resolveTurn } from "../src/world.js";
import { observeWorld } from "../src/world-map.js";
import { application, server } from "../src/server.js";
import { deriveEndpoint } from "../src/analysis.js";
import { recordRedaction, recordSecurityIncident } from "../src/forensics.js";

const root = resolve(import.meta.dirname, "..");
const actor = (id) => ({ persistent_identity_id: id, session_id: `session-${id}`, invocation_id: `invocation-${id}` });
function contestedFixture(world) {
  // Synthetic reducer fixture, not a replay genesis or empirical world sample.
  const site=Object.values(world.hexes).find(h=>world.territories[h.territory_id].status==='unclaimed' && h.terrain!=='water');
  for(const id of ['polity-1','polity-2']){ const group=world.polities[id].citizens.find(g=>g.assignment==='Explorer'); group.hex_id=site.id;group.territory_id=site.territory_id; }
  for(const id of Object.keys(world.polities))observeWorld(world,id);
  return site.territory_id;
}

test("contract registry and catalogue are machine-readable", async () => {
  const catalogue = JSON.parse(await readFile(resolve(root, "EVENT_CATALOGUE.spec.json"), "utf8"));
  const endpoint = JSON.parse(await readFile(resolve(root, "PRIMARY_ENDPOINT.spec.json"), "utf8"));
  const horizon = JSON.parse(await readFile(resolve(root, "HORIZON_POLICY.spec.json"), "utf8"));
  assert.equal(catalogue.unknown_event_policy, "fail_closed");
  assert.equal(endpoint.experimental_unit, "run");
  assert.equal(endpoint.components.length, 4);
  assert.equal(horizon.pilot_0_max_turns, 20);
  assert.equal(horizon.confirmatory_status, "DEFERRED_BY_DESIGN — PILOT_0_CALIBRATION");
});

test("identical committed inputs produce identical world state and evidence", () => {
  const run = (first, second) => {
    const world = makeWorld({ runId: "run-deterministic", seed: "seed-deterministic" });
    const target=contestedFixture(world);
    const ledger = new ActionLedger(world.evidence);
    const actions = [[first, "polity-1"], [second, "polity-2"]].map(([action, id]) => {
      const projection = projectWorld(world, id);
      const submission = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [{...action,territory_id:target}], projection });
      return ledger.validate(submission, world);
    });
    const committed = commitTurn(world, ledger, actions);
    resolveTurn(world, committed);
    world.evidence.verify();
    return { state: world.authoritativeState(), target, events: world.evidence.snapshot() };
  };
  const a = run({ action_id: "action-a", type: "claim", territory_id: "hex-1-2" }, { action_id: "action-b", type: "claim", territory_id: "hex-1-2" });
  const b = run({ action_id: "action-a", type: "claim", territory_id: "hex-1-2" }, { action_id: "action-b", type: "claim", territory_id: "hex-1-2" });
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.state.territories[a.target].status, "contested");
  assert.equal(a.state.territories[a.target].owner_id, null);
});

test("same-turn conflict resolution is order-independent", () => {
  const run = (actions) => {
    const world = makeWorld({ runId: "run-order", seed: "seed-order" });
    const target=contestedFixture(world); actions=actions.map(([id,action])=>[id,{...action,territory_id:target}]);
    const ledger = new ActionLedger(world.evidence);
    const records = actions.map(([id, action]) => { const sub = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [action], projection: projectWorld(world, id) }); return ledger.validate(sub, world); });
    resolveTurn(world, commitTurn(world, ledger, records));
    return world.stateHash();
  };
  const a = ["polity-1", "polity-2"].map((id, i) => [id, { action_id: `a-${i}`, type: "claim", territory_id: "hex-3-2" }]);
  assert.equal(run(a), run([...a].reverse()));
});

test("addressable RNG is independent of unrelated draws", () => {
  const input = { runId: "run-rng", turnId: "turn-0", phase: "resolve", subsystem: "combat", eventOrActionId: "battle-1", purpose: "hit", streamNamespace: "world", drawOrdinal: 0 };
  const a = new AddressableRng("seed");
  const b = new AddressableRng("seed");
  const expected = a.draw(input);
  b.draw({ ...input, eventOrActionId: "other", purpose: "noise" });
  assert.equal(b.draw(input), expected);
  assert.equal(a.replayRecord(a.address(input)).algorithm_version, "sha256-address-v1");
});

test("projection is deny-by-default and contains no authoritative hidden state", () => {
  const world = makeWorld();
  const projection = projectWorld(world, "polity-1");
  const serialized = JSON.stringify(projection.fields);
  assert.match(serialized, /own\.polity_state/);
  assert.doesNotMatch(serialized, /true_world_state|observer_truth|raw_other_agent_memory/);
  assert.equal(projection.logical_time.event_head, null);
  assert.equal(PROJECTION_POLICY.policy_version, "pilot-0.1");
});

test("action lifecycle preserves rejected submissions and committed lineage", () => {
  const world = makeWorld(); const ledger = new ActionLedger(world.evidence);
  const sub = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: "polity-1", actor: actor("polity-1"), actions: [{ action_id: "bad", type: "secret_action" }], projection: projectWorld(world, "polity-1") });
  const rejected = ledger.validate(sub, world);
  assert.equal(rejected.submission.status, "rejected");
  assert.equal(rejected.submission.validation.errors[0].code, "action_type_not_enabled");
  const good = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: "polity-1", actor: actor("polity-1"), actions: [{ action_id: "good", type: "wait" }], projection: projectWorld(world, "polity-1"), priorSubmissionId: sub.submission_id });
  const valid = ledger.validate(good, world);
  const commit = commitTurn(world, ledger, [valid]);
  assert.equal(commit.accepted_action_ids[0], good.actions[0].action_id);
  assert.equal(good.submitted_actions[0].action_id, 'good');
  assert.equal(commit.accepted_submission_ids.includes(sub.submission_id), false);
  assert.equal(ledger.submissions.get(sub.submission_id).status, "rejected");
});

test("population and units remain distinct and recruitment is explicit", () => {
  const world = makeWorld(); const ledger = new ActionLedger(world.evidence); const id = "polity-1";
  const sub = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [{ action_id: "recruit", type: "recruit" }], projection: projectWorld(world, id) });
  const valid = ledger.validate(sub, world); resolveTurn(world, commitTurn(world, ledger, [valid]));
  assert.equal(world.polities[id].units.length, 1);
  const recruitment=world.evidence.events.find(e=>e.event_type==='PopulationUnitTransition' && e.payload.transition==='recruitment');
  const recruitedState=JSON.parse(world.evidence.payloads.get(recruitment.payload.population_after_ref).bytes);
  assert.equal(recruitedState.population, PILOT_0_CONFIG.population.starting - PILOT_0_CONFIG.population.unitSize);
  assert.ok(world.evidence.events.some((e) => e.event_type === "PopulationUnitTransition"));
});

test("memory is bounded and records availability evidence", () => {
  const evidence = new EvidenceStore("run-memory"); const memory = new MemoryStore({ runId: "run-memory", identityId: "polity-1", evidence, capacity: 10, sessionId: "session-1" });
  memory.write("hello", "session-1", "invocation-1"); assert.throws(() => memory.write("12345678901", "session-1", "invocation-2"), /memory_capacity_exceeded/);
  assert.ok(evidence.events.some((e) => e.event_type === "MemoryOperation")); evidence.verify();
});

test("redacted replay is explicit and never exact", () => {
  const evidence = new EvidenceStore("run-replay"); evidence.append({ eventType: "RunCreated", turn: 0, phase: "setup", payload: { secret: "redact-me" } });
  const redacted = replay(evidence.bundle(), { expectedRunId: "run-replay", redacted: true, authorizationContext: createAuthorizationContext("trusted_replay") });
  assert.equal(redacted.status, "REPLAY_INCOMPLETE_REDACTED"); assert.equal(redacted.exact_reproducibility, false);
  assert.throws(() => replay(evidence.bundle(), { expectedRunId: "run-replay", redacted: true, authorizationContext: createAuthorizationContext("participant_projection", "polity-1") }), /participant replay/);
});

test("agent runtime retains experimental identity across session invocations", () => {
  const world = makeWorld({ runId: "run-agent" }); const runtime = new AgentRuntime({ world, actorId: "polity-1", model: new DeterministicModel("test"), condition: PILOT_0_AGENT_CONDITION });
  const first = runtime.invoke(); const second = runtime.invoke();
  assert.equal(first.projection.principal.principal_id, "polity-1"); assert.notEqual(first.invocationId, second.invocationId); assert.equal(runtime.experimentalIdentityId, "polity-1");
});

test("UI exposes projection-only wording and accessible map semantics", async () => {
  const html = await readFile(resolve(root, "ui/index.html"), "utf8");
  assert.match(html, /Authorized projected world map/); assert.match(html, /aria-label/);
});

test("evidence rejects malformed payloads and replay rejects tampering", () => {
  const evidence = new EvidenceStore("run-integrity");
  assert.throws(() => evidence.append({ eventType: "RNGDraw", turn: 0, phase: "test", payload: { schema_version: "1.0.0", run_id: "run-integrity", turn: "wrong" } }), /schema validation failed/);
  evidence.append({ eventType: "RunCreated", turn: 0, phase: "setup", payload: { run_id: "run-integrity" } });
  const bundle = evidence.bundle(); const tampered = structuredClone(bundle); tampered.events[0].payload.run_id = "other";
  assert.throws(() => replay(tampered, { expectedRunId: "run-integrity", authorizationContext: createAuthorizationContext("trusted_replay") }), /digest mismatch|hash chain/);
  assert.throws(() => replay({ events: [], payloads: {} }, { expectedRunId: "run-integrity", authorizationContext: createAuthorizationContext("trusted_replay") }), /empty replay/);
});

test("authoritative state hash covers hidden simulation state", () => {
  const world = makeWorld({ runId: "run-authoritative" }); const before = world.stateHash(); world.polities["polity-1"].credits += 1; assert.notEqual(world.stateHash(), before);
});

test("mixed rejected submissions cannot cross the commit boundary", () => {
  const world = makeWorld({ runId: "run-rejected" }); const ledger = new ActionLedger(world.evidence); const id = "polity-1"; const submission = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [{ action_id: "good", type: "wait" }, { action_id: "bad", type: "secret_action" }], projection: projectWorld(world, id) }); const result = ledger.validate(submission, world); assert.equal(result.submission.status, "rejected"); assert.throws(() => commitTurn(world, ledger, [result]), /only validated/);
});

test("battle resolution is explicit, simultaneous, and replay-evidenced", () => {
const config=structuredClone(PILOT_0_CONFIG); config.unitTypes.infantry.detection=20; config.unitTypes.infantry.range=20; config.unitTypes.infantry.health=1; config.dynamics.combatMinimumHitPermille=1000; config.dynamics.combatMaximumHitPermille=1000; const world = makeWorld({ runId: "run-battle", seed: "battle-seed", config }); const recruitLedger = new ActionLedger(world.evidence); const recruitments = ["polity-1", "polity-2"].map((id) => { const submission = recruitLedger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [{ action_id: `recruit-${id}`, type: "recruit" }], projection: projectWorld(world, id) }); return recruitLedger.validate(submission, world); }); resolveTurn(world, commitTurn(world, recruitLedger, recruitments)); const attacker = world.polities["polity-1"].units[0]; const target = world.polities["polity-2"].units[0]; assert.ok(target); const attackLedger = new ActionLedger(world.evidence); const attack = attackLedger.submit({ runId: world.runId, turnId: "turn-1", actorId: "polity-1", actor: actor("polity-1"), actions: [{ action_id: "attack", type: "attack", unit_id: attacker.id, target_unit_id: target.id }], projection: projectWorld(world, "polity-1") }); resolveTurn(world, commitTurn(world, attackLedger, [attackLedger.validate(attack, world)])); assert.ok(world.evidence.events.some((event) => event.event_type === "BattleResolved")); assert.ok(world.evidence.events.some((event) => event.event_type === "PopulationUnitTransition" && event.payload.transition === "destruction")); world.evidence.verify();
});

test("persistent and nonpersistent conditions expose different history surfaces", () => {
  const world = makeWorld({ runId: "run-treatment" }); const persistent = new AgentRuntime({ world, actorId: "polity-1", condition: PILOT_0_AGENT_CONDITIONS.persistent, model: new DeterministicModel() }); persistent.memory.write("prior relational record", persistent.sessionId, "setup", 0); const nonpersistent = new AgentRuntime({ world, actorId: "polity-2", condition: PILOT_0_AGENT_CONDITIONS.nonpersistent, model: new DeterministicModel() }); persistent.invoke(); nonpersistent.invoke(); const invocations = world.evidence.events.filter((e) => e.event_type === "ModelInvocation").map((e) => e.payload); assert.ok(invocations.some((x) => x.condition_id === "pilot0-history-access" && x.memory_refs.length === 1)); assert.ok(invocations.some((x) => x.condition_id === "pilot0-history-inaccessible" && x.memory_refs.length === 0));
});

test("HTTP participant surface returns only a projection and blocks traversal", async () => {
  const token = application.auth.issue({ runId: application.world.runId, principalId: "polity-1", domain: "participant_projection", ttlMs: 60000 });
  const listening = await new Promise((resolve) => { const instance = server.listen(0, () => resolve(instance)); }); const port = listening.address().port; const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`); assert.equal(unauthorized.status, 401); const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "authorization": "Bearer " + token } }); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(response.headers.get("vary"), /Authorization/); const state = await response.json(); assert.equal(state.projection_policy, "projection-only"); assert.ok(state.projection); assert.equal(state.state, undefined); const method = await fetch(`http://127.0.0.1:${port}/api/state`, { method: "POST", headers: { "authorization": "Bearer " + token } }); assert.equal(method.status, 405); const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/etc/passwd`); assert.equal(traversal.status, 404); await new Promise((resolve) => listening.close(resolve));
});

test("endpoint derivation fails closed instead of manufacturing behavioral measurements", () => {
  const evidence = new EvidenceStore("run-endpoint");
  evidence.append({ eventType: "MessageSent", turn: 1, phase: "actions", payload: { from: "polity-1", to: "polity-2", text: "promise", promise: true, status: "formed" } });
  evidence.append({ eventType: "MessageSent", turn: 2, phase: "actions", payload: { from: "polity-2", to: "polity-1", text: "not a coded behavioral outcome" } });
  assert.throws(() => deriveEndpoint(evidence.snapshot(), { runId: "run-endpoint" }), /canonical bundle/);
  assert.throws(() => deriveEndpoint(evidence.bundle(), { runId: "run-endpoint" }), /analysis manifest required/);
});

test("branch lineage is isolated from the parent commit ledger", () => {
  const parent = makeWorld({ runId: "run-parent" }); const branch = cloneWorld(parent, { branchRunId: "run-branch" });
  assert.notEqual(parent.committedRecords, branch.committedRecords); assert.equal(branch.committedRecords.size, 0); assert.equal(branch.evidence.events[0].payload.parent_run_id, parent.runId);
});

test("agent conditions and memory stores fail closed across research boundaries", () => {
  const world = makeWorld({ runId: "run-condition" });
  assert.throws(() => new AgentRuntime({ world, actorId: "polity-1", condition: { condition_id: "invented", history_mode: "persistent" } }), /unknown Pilot 0 agent condition/);
  const foreign = new MemoryStore({ runId: "other-run", identityId: "polity-1", evidence: world.evidence, sessionId: "session-1" });
  assert.throws(() => new AgentRuntime({ world, actorId: "polity-1", memory: foreign }), /memory is not bound/);
});

test("a unit cannot submit multiple simultaneous world actions", () => {
  const world = makeWorld({ runId: "run-unit-conflict" }); const ledger = new ActionLedger(world.evidence); const id = "polity-1";
  const recruit = ledger.submit({ runId: world.runId, turnId: "turn-0", actorId: id, actor: actor(id), actions: [{ action_id: "recruit", type: "recruit" }], projection: projectWorld(world, id) }); resolveTurn(world, commitTurn(world, ledger, [ledger.validate(recruit, world)]));
  const unit = world.polities[id].units[0]; const attackLedger = new ActionLedger(world.evidence); const other = world.polities["polity-2"];
  const sub = attackLedger.submit({ runId: world.runId, turnId: "turn-1", actorId: id, actor: actor(id), actions: [{ action_id: "a1", type: "move", unit_id: unit.id, hex_id: "hex-2-2" }, { action_id: "a2", type: "move", unit_id: unit.id, hex_id: "hex-1-2" }], projection: projectWorld(world, id) });
  assert.throws(() => commitTurn(world, attackLedger, [attackLedger.validate(sub, world)]), /only one simultaneous action/);
});

test("breach and redaction preserve auditable evidence without claiming exact replay", () => {
  const evidence = new EvidenceStore("run-forensics"); const original = evidence.append({ eventType: "RunCreated", turn: 0, phase: "setup", payload: { run_id: "run-forensics", secret: "private" } });
  const detectorRef = evidence.putPayload({ detector: "test-detector" });
  const incident = recordSecurityIncident(evidence, { breachType: "projection_probe", detectorRef, firstAffectedEvent: original.event_id, lastAffectedEvent: original.event_id, runDispositionRef: "disposition-pending", evidenceRefs: [original.payload.payload_ref] });
  const tombstone = recordRedaction(evidence, { artifactRef: original.payload.payload_ref, fieldOrRange: "secret", reason: "consent", authority: "test-policy", effectiveLogicalTime: { turn: 0, phase: "security" }, affectedDerivations: [incident.event_id] });
  assert.equal(tombstone.event_type, "RedactionTombstone"); assert.equal(incident.payload.analytical_eligibility.confirmatory_eligible, false); evidence.verify();
  assert.equal(replay(evidence.bundle(), { expectedRunId: evidence.runId, authorizationContext: createAuthorizationContext("trusted_replay") }).status, "REPLAY_INCOMPLETE_REDACTED");
});
