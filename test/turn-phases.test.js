import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnPhases, TURN_PHASES, phaseBudgetManifest, executeTurnPhaseCommand, replayTurnPhaseCommand, PHASE_MEMORY_PARSER_HASH } from '../src/turn-phases.js';
import { makeWorld } from '../src/world.js';
import { ActionLedger } from '../src/contracts.js';
import { MemoryStore } from '../src/memory.js';
import { PILOT_0_AGENT_CONDITIONS } from '../src/agent.js';
import { clone, sha256, canonicalize } from '../src/core.js';
import { assertValidSchema } from '../src/schema.js';
import { loadEvidence } from '../src/evidence.js';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunService } from '../src/run-service.js';
import { SignedArchive, archiveKeyId } from '../src/archive.js';
import { createApplication } from '../src/server.js';
import { prepareSyntheticCodingPacket, validateAnnotations } from '../src/coding.js';

// NONEMPIRICAL fixtures use the actual world, ledger, schemas, memory store and
// canonical authority. No model generation, provider transport or human session.
function fixture(name, { persistent = [] } = {}) {
  const world = makeWorld({ runId: 'nonempirical-phases-' + name, seed: 'phase-conformance-v1' });
  const clock = { value: 10000 };
  const runtimes = Object.keys(world.polities).map(actorId => {
    const sessionId = 'session-' + actorId, condition = persistent.includes(actorId) ? PILOT_0_AGENT_CONDITIONS.persistent : PILOT_0_AGENT_CONDITIONS.nonpersistent;
    const memory = new MemoryStore({ runId: world.runId, identityId: actorId, evidence: world.evidence, sessionId,
      capacity: world.config.memory.capacity, isActive: () => world.polities[actorId].alive });
    memory.bindRuntime({ enabled: condition.memory.mode !== 'state_only', isActive: () => world.polities[actorId].alive });
    return { world, actorId, sessionId, condition, memory };
  });
  const ledger = new ActionLedger(world.evidence), now = () => clock.value;
  return { world, clock, runtimes, ledger, now, phases: new TurnPhases({ world, runtimes, ledger, now }) };
}
const lineage = id => ({ persistent_identity_id: id, session_id: 'session-' + id, invocation_id: 'command-' + id });
function finishInteractive(f, actions = null) {
  for (const runtime of f.runtimes.filter(r => f.world.polities[r.actorId].alive)) {
    f.phases.projection(runtime.actorId);
    if (f.phases.phase === 'final_planning') f.phases.submit({ actorId: runtime.actorId, actor: lineage(runtime.actorId), actions: actions?.[runtime.actorId] ?? [] });
    f.phases.ready(runtime.actorId);
  }
  f.phases.advance();
}
function to(f, phase) {
  while (f.phases.phase !== phase) {
    if (['observation', 'private_planning', 'diplomacy', 'final_planning', 'consequence_reveal', 'memory_update'].includes(f.phases.phase)) finishInteractive(f);
    else if (f.phases.phase === 'interview') { f.clock.value = f.phases.deadline; f.phases.advance(); }
    else f.phases.advance();
  }
}
function communicate(f, id, requestId, command) { return f.phases.diplomacy({ actorId: id, actor: lineage(id), requestId, command }); }
const field = (projection, path) => projection.fields.find(f => f.path === path).value;

test('phase order validates before commit and preserves the reducer turn increment exactly once', () => {
  const f = fixture('order'), seen = [f.phases.phase];
  while (f.phases.phase !== 'close') {
    const prior = f.phases.phase;
    if (['observation', 'private_planning', 'diplomacy', 'final_planning', 'consequence_reveal', 'memory_update'].includes(prior)) finishInteractive(f);
    else if (prior === 'interview') { f.clock.value = f.phases.deadline; f.phases.advance(); }
    else f.phases.advance();
    seen.push(f.phases.phase);
    assert.equal(f.world.turn, TURN_PHASES.indexOf(f.phases.phase) >= TURN_PHASES.indexOf('consequence_reveal') ? 1 : 0);
    assert.equal(f.phases.logicalTurn, 0);
  }
  f.phases.advance(); assert.equal(f.phases.exportState().closed, true); assert.deepEqual(seen, TURN_PHASES);
  const events = f.world.evidence.events;
  assert.ok(events.findIndex(e => e.event_type === 'ActionValidated') < events.findIndex(e => e.event_type === 'TurnCommitted'));
  assert.equal(events.filter(e => e.event_type === 'TurnCommitted').length, 1);
  assert.equal(events.filter(e => e.event_type === 'TurnResolved').length, 1);
  const endSnapshot = events.find(e => e.event_type === 'SnapshotCreated' && e.phase === 'snapshot');
  const archive = events.find(e => e.event_type === 'WorldTransition' && e.payload.mechanic === 'turn_memory_archive');
  assert.ok(endSnapshot.sequence > archive.sequence); assert.equal(endSnapshot.turn, 0); assert.equal(endSnapshot.payload.reducer_turn, 1);
  assert.equal(f.world.snapshots.length, 2, 'reducer snapshot retained alongside later lifecycle snapshot'); f.world.evidence.verify();
});

function commandFixture(name) {
  const options = { runId: 'nonempirical-command-' + name, seed: 'command-replay' }, world = makeWorld(options), ledger = new ActionLedger(world.evidence);
  const bindings = Object.keys(world.polities).map(actorId => ({ actorId, sessionId: 'session-' + actorId, condition: PILOT_0_AGENT_CONDITIONS.nonpersistent }));
  let state = null, at = 100;
  return { world, options, ledger, bindings, get state() { return state; },
    run(operation, input = {}, time = at) { at = time; const out = executeTurnPhaseCommand({ world, ledger, state, bindings, command: { operation, input }, at }); state = out.phaseState; return out.result; } };
}
function replayCommands(f, archive = loadEvidence(f.world.evidence.bundle())) {
  const world = makeWorld(f.options), ledger = new ActionLedger(world.evidence);
  let state = null, bindings = null, cursor = world.evidence.events.length;
  while (cursor < archive.events.length) {
    const out = replayTurnPhaseCommand({ world, ledger, archive, cursor, state, bindings });
    state = out.phaseState; bindings = out.phaseBindings; cursor += out.eventCount;
  }
  return { world, state };
}

test('recorded commands independently regenerate phase, live diplomacy, commits, world outcomes and snapshots', () => {
  const f = commandFixture('full'); f.run('begin');
  while (!f.state.closed) {
    if (f.state.phase === 'diplomacy') f.run('diplomacy', { actorId: 'polity-1', actor: lineage('polity-1'), requestId: 'live', command: { type: 'broadcast', text: 'before planning' } });
    if (['observation', 'private_planning', 'diplomacy', 'final_planning', 'consequence_reveal', 'memory_update'].includes(f.state.phase)) {
      for (const { actorId } of f.bindings) {
        f.run('projection', { actorId });
        if (f.state.phase === 'final_planning') f.run('submit', { actorId, actor: lineage(actorId), actions: [{ type: 'wait' }] });
        f.run('ready', { actorId });
      }
    }
    f.run('advance', {}, f.state.phase === 'interview' ? f.state.deadline_at : f.state.opened_at);
  }
  f.world.evidence.verify(); const rebuilt = replayCommands(f);
  assert.equal(canonicalize(rebuilt.world.evidence.events), canonicalize(f.world.evidence.events));
  assert.equal(canonicalize(rebuilt.world.authoritativeState()), canonicalize(f.world.authoritativeState()));
  assert.deepEqual(rebuilt.state, f.state); assert.equal(rebuilt.world.turn, 1);
});

test('phase replay rejects claimed output substitution and incomplete command publication', () => {
  const f = commandFixture('tamper'); f.run('begin'); f.run('projection', { actorId: 'polity-1' });
  const archive = loadEvidence(f.world.evidence.bundle());
  archive.events.at(-1).payload.after_state_ref = archive.events[0].payload.initial_state_ref;
  assert.throws(() => replayCommands(f, archive), /canonical event mismatch/);
  const partial = loadEvidence(f.world.evidence.bundle()); partial.events.pop();
  assert.throws(() => replayCommands(f, partial), /canonical event mismatch/);
});

test('durable RunService executes phase commands, current-phase diplomacy and consequences across restart', async t => {
  const f = commandFixture('durable'), directory = await mkdtemp(join(tmpdir(), 'civlab-phases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519'), binding = { directory, runId: f.world.runId, ...keys, keyId: archiveKeyId(keys.publicKey) };
  let at = 10000, request = 0;
  const options = { archive: new SignedArchive(binding), now: () => at, allowSyntheticExecution: true };
  let service = await RunService.create({ ...options, world: f.world });
  await service.beginPhases({ requestId: 'begin', bindings: f.bindings });
  const advance = async () => service.advancePhase({ requestId: 'advance-' + request++ });
  await assert.rejects(service.submit({ requestId: 'bypass', actorId: 'polity-1', actor: lineage('polity-1'), actions: [] }), /phaseCommand/);
  const observed = await service.participantState('polity-1');
  await service.participantReady({ principalId: 'polity-1', turn: 0, phase: 'observation', projectionId: observed.projection.projection_id });
  at = service.phaseState.deadline_at; await advance(); // private planning
  await assert.rejects(service.participantReady({ principalId: 'polity-1', turn: 0, phase: 'observation', projectionId: observed.projection.projection_id, requestId: 'stale-phase' }), /stale/);
  const planning = await service.participantState('polity-1');
  await service.participantReady({ principalId: 'polity-1', turn: 0, phase: 'private_planning', projectionId: planning.projection.projection_id });
  at = service.phaseState.deadline_at; await advance(); // diplomacy
  let state = await service.participantState('polity-1'); assert.equal(state.controls.can_communicate, true);
  const communication = { principalId: 'polity-1', turn: 0, phase: 'diplomacy', projectionId: state.projection.projection_id, requestId: 'live-broadcast', command: { type: 'broadcast', text: 'delivered before final planning' } };
  const receipt = await service.participantDiplomacy(communication); assert.equal(receipt.status, 'resolved');
  service = await RunService.recover(options); assert.deepEqual(await service.participantDiplomacy(communication), receipt);
  at = service.phaseState.deadline_at; await advance(); // final planning
  state = await service.participantState('polity-1'); assert.equal(state.controls.can_submit, true);
  assert.ok(field(state.projection, 'authorized.messages').some(m => m.text === communication.command.text));
  const rawActions = [{ type: 'wait' }];
  await service.submitParticipantActions({ principalId: 'polity-1', actions: rawActions, turn: 0, phase: 'final_planning', projectionId: state.projection.projection_id });
  at = service.phaseState.deadline_at; await advance(); await advance(); await advance(); await advance();
  assert.equal(service.world.turn, 1); assert.equal(service.phaseState.phase, 'consequence_reveal');
  state = await service.participantState('polity-2'); assert.equal(state.projection.logical_time.turn, 0);
  assert.ok(field(state.projection, 'authorized.messages').some(m => m.text === communication.command.text));
  assert.deepEqual(service.world.evidence.events.find(e => e.event_type === 'ActionSubmitted').payload.submitted_actions, rawActions);
  service = await RunService.recover(options); assert.equal(service.phaseState.phase, 'consequence_reveal');
  at = service.phaseState.deadline_at; await advance(); await advance(); await advance(); await advance();
  assert.equal(service.phaseState.phase, 'interview');
  at = service.phaseState.deadline_at; await advance(); await advance();
  assert.equal(service.phaseState.closed, true); assert.equal(service.world.turn, 1);
  assert.equal(service.world.snapshots.at(-1).state.phase, 'snapshot');
  assert.equal(service.world.evidence.events.filter(e => e.event_type === 'TurnResolved').length, 1);
});

test('real browser uses authenticated durable phase-ready and immediate diplomacy routes', async t => {
  const f = commandFixture('browser'), directory = await mkdtemp(join(tmpdir(), 'civlab-phase-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519'), archive = new SignedArchive({ directory, runId: f.world.runId, ...keys, keyId: archiveKeyId(keys.publicKey) });
  let at = 10000;
  const service = await RunService.create({ world: f.world, archive, now: () => at, allowSyntheticExecution: true });
  await service.beginPhases({ requestId: 'begin-browser', bindings: f.bindings });
  const app = createApplication({ runService: service, allowSyntheticExecution: true });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const { chromium } = await import('playwright'), browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const token = app.auth.issue({ runId: f.world.runId, principalId: 'polity-1', domain: 'participant_projection', ttlMs: 60000 });
  await page.goto(url); await page.getByLabel('Participant access credential').fill(token); await page.getByRole('button', { name: 'Open session' }).click();
  await page.locator('#game').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Finish this phase' }).click();
  await page.waitForFunction(() => document.querySelector('#execution-status').textContent.includes('Phase complete'));
  at = service.phaseState.deadline_at; await service.advancePhase({ requestId: 'to-planning' });
  at = service.phaseState.deadline_at; await service.advancePhase({ requestId: 'to-diplomacy' });
  await page.getByRole('button', { name: 'Refresh observation' }).click();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'diplomacy');
  await page.locator('#action-type').selectOption('broadcast'); await page.locator('#order-text').fill('Immediate browser diplomacy <script>data only</script>');
  await page.getByRole('button', { name: 'Send communication now' }).click();
  await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('Immediate browser diplomacy'));
  assert.equal(service.world.turn, 0); assert.equal(service.world.evidence.events.some(e => e.event_type === 'TurnCommitted'), false);
  assert.equal(await page.locator('#messages script').count(), 0);
  at = service.phaseState.deadline_at; await service.advancePhase({ requestId: 'to-final' });
  await page.getByRole('button', { name: 'Refresh observation' }).click();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'final planning');
  await page.getByRole('button', { name: 'Submit no orders' }).click();
  await page.waitForFunction(() => document.querySelector('#execution-status').textContent.includes('Orders recorded'));
  assert.deepEqual(service.world.evidence.events.find(e => e.event_type === 'ActionSubmitted').payload.submitted_actions, []);
  assert.deepEqual(errors, []);
});

test('phase service publication failures discard private work or recover the once-published command', async t => {
  const f = commandFixture('publication'), directory = await mkdtemp(join(tmpdir(), 'civlab-phase-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519'), archive = new SignedArchive({ directory, runId: f.world.runId, ...keys, keyId: archiveKeyId(keys.publicKey) });
  let service = await RunService.create({ world: f.world, archive, now: () => 10000 });
  const input = { requestId: 'begin-once', bindings: f.bindings }, before = service.world.evidence.previousHash;
  service.fault = point => { if (point === 'after_event:WorldTransition') throw new Error('phase-stage-fault'); };
  await assert.rejects(service.beginPhases(input), /phase-stage-fault/); assert.equal(service.world.evidence.previousHash, before);
  assert.equal(service.phaseState, null);
  service.fault = point => { if (point === 'after_phase_persist') throw new Error('phase-published-fault'); };
  await assert.rejects(service.beginPhases(input), /phase-published-fault/);
  service = await RunService.recover({ archive, now: () => 99999 });
  const head = service.world.evidence.previousHash; await service.beginPhases(input);
  assert.equal(service.world.evidence.previousHash, head); assert.equal(service.phaseState.opened_at, 10000);
});

test('pre-final-planning diplomacy delivers immediately without resolving a strategic turn', () => {
  const f = fixture('live-diplomacy'); to(f, 'diplomacy');
  assert.deepEqual(field(f.phases.projection('polity-1'), 'own.knowledge'), ['polity-1']);
  const resources = Object.values(f.world.polities).map(p => ({ population: p.population, credits: p.credits, food: p.food }));
  communicate(f, 'polity-1', 'broadcast', { type: 'broadcast', text: 'I am here.' });
  const response = communicate(f, 'polity-2', 'reply', { type: 'message', to: 'polity-1', text: 'Reply before final planning.' });
  assert.equal(response.status, 'resolved'); assert.equal(f.world.turn, 0);
  assert.equal(f.world.evidence.events.some(e => e.event_type === 'TurnCommitted'), false);
  assert.deepEqual(Object.values(f.world.polities).map(p => ({ population: p.population, credits: p.credits, food: p.food })), resources);
  finishInteractive(f); assert.equal(f.phases.phase, 'final_planning');
  const projection = f.phases.projection('polity-1'); assert.ok(field(projection, 'authorized.messages').some(m => m.text === 'Reply before final planning.'));
  assert.equal(projection.logical_time.phase, 'final_planning'); assert.equal(f.world.phase, 'actions'); f.world.evidence.verify();
});

test('same-turn explicit reciprocal reply cites actual authorized offer exposure in blinded coding', () => {
  const f = fixture('reciprocal-exposure'); to(f, 'diplomacy');
  for (const id of ['polity-1', 'polity-2', 'polity-3']) communicate(f, id, 'announce', { type: 'broadcast', text: 'I am here.' });
  communicate(f, 'polity-1', 'hidden', { type: 'message', to: 'polity-3', text: 'Private to polity three only.' });
  const hidden = f.world.evidence.events.findLast(e => e.event_type === 'MessageSent');
  communicate(f, 'polity-1', 'offer', { type: 'message', to: 'polity-2', text: 'I offer to coordinate our exploration with you.' });
  const offer = f.world.evidence.events.findLast(e => e.event_type === 'MessageSent');
  communicate(f, 'polity-2', 'unobserved', { type: 'message', to: 'polity-1', text: 'Sent without a new observation.' });
  assert.ok(!f.world.evidence.events.findLast(e => e.event_type === 'MessageSent').causality.causation_ids.includes(offer.event_id));
  f.phases.projection('polity-2');
  const exposure = f.world.evidence.events.findLast(e => e.event_type === 'ProjectionIssued');
  communicate(f, 'polity-2', 'reply', { type: 'message', to: 'polity-1', text: 'I accept your offer to coordinate our exploration.' });
  const reply = f.world.evidence.events.findLast(e => e.event_type === 'MessageSent');
  assert.ok(reply.causality.causation_ids.includes(offer.event_id)); assert.ok(reply.causality.causation_ids.includes(exposure.event_id));
  assert.ok(!reply.causality.causation_ids.includes(hidden.event_id));
  const packet = prepareSyntheticCodingPacket(f.world.evidence), source = packet.input.observations.find(o => o.facts.text === offer.payload.text), response = packet.input.observations.find(o => o.facts.text === reply.payload.text);
  const annotation = { id: 'explicit-reciprocity-fixture', kind: 'reciprocity', source: source.ref, actor: source.facts.from,
    counterparty: response.facts.from, eligibility: 'ELIGIBLE', observation_status: 'OBSERVED', confidence: 1, ambiguity: null,
    category: 'cooperative_coordination', responses: [{ source: response.ref, actor: response.facts.from, counterparty: source.facts.from, polarity: 'POSITIVE', category: 'cooperative_coordination' }] };
  assert.equal(validateAnnotations([annotation], packet.input), true);
  const withoutExposure = clone(packet.input); withoutExposure.observations.find(o => o.ref === response.ref).causal_predecessors = [];
  assert.throws(() => validateAnnotations([annotation], withoutExposure), /explicit causal predecessor/);
});

test('rooms enforce current membership, verbatim promises and hidden channel existence', () => {
  const f = fixture('rooms'); to(f, 'diplomacy');
  for (const id of ['polity-1', 'polity-2', 'polity-3']) communicate(f, id, 'broadcast', { type: 'broadcast', text: 'present' });
  const room = communicate(f, 'polity-1', 'room', { type: 'channel_create', members: ['polity-2'] }).channel_id;
  const hiddenBefore = canonicalize(f.phases.projection('polity-3', { record: false }));
  const promise = '<script>data only</script> I promise these exact words.';
  communicate(f, 'polity-1', 'promise', { type: 'promise', channel_id: room, text: promise });
  assert.equal(canonicalize(f.phases.projection('polity-3', { record: false })), hiddenBefore);
  assert.ok(field(f.phases.projection('polity-2'), 'authorized.messages').some(m => m.text === promise));
  const event = f.world.evidence.events.filter(e => e.event_type === 'MessageSent').at(-1); assert.equal(event.payload.status, undefined);
  communicate(f, 'polity-2', 'leave', { type: 'channel_leave', channel_id: room });
  const bad = communicate(f, 'polity-2', 'after-leave', { type: 'message', channel_id: room, text: 'not delivered' });
  assert.equal(bad.status, 'rejected');
  const outside = communicate(f, 'polity-3', 'unknown', { type: 'message', channel_id: room, text: 'probe' });
  const nonexistent = communicate(f, 'polity-3', 'absent', { type: 'message', channel_id: 'nonexistent', text: 'probe' });
  assert.equal(outside.code, nonexistent.code); f.world.evidence.verify();
});

test('diplomacy requests are idempotent and cannot impersonate authenticated senders or spend resources', () => {
  const f = fixture('idempotency'); to(f, 'diplomacy'); const command = { type: 'broadcast', text: 'one delivery' };
  const first = communicate(f, 'polity-1', 'same', command), head = f.world.evidence.previousHash;
  assert.deepEqual(communicate(f, 'polity-1', 'same', command), first); assert.equal(f.world.evidence.previousHash, head);
  assert.throws(() => communicate(f, 'polity-1', 'same', { ...command, text: 'substitution' }), /idempotency/);
  assert.throws(() => f.phases.diplomacy({ actorId: 'polity-1', actor: lineage('polity-2'), requestId: 'spoof', command }), /authenticated/);
  assert.equal(communicate(f, 'polity-1', 'transfer', { type: 'transfer', to: 'polity-2', resource: 'credits', amount: 10 }).status, 'rejected');
  assert.equal(communicate(f, 'polity-1', 'extra', { type: 'broadcast', text: 'not delivered', from: 'polity-2' }).status, 'rejected');
});

test('phase deadlines are shared and never reset by repeated requests', () => {
  const f = fixture('deadline'); to(f, 'diplomacy'); const deadline = f.phases.deadline;
  communicate(f, 'polity-1', 'one', { type: 'broadcast', text: 'first' }); f.clock.value++;
  communicate(f, 'polity-1', 'two', { type: 'broadcast', text: 'second' }); assert.equal(f.phases.deadline, deadline);
  f.clock.value = deadline; assert.throws(() => communicate(f, 'polity-1', 'late', { type: 'broadcast', text: 'late' }), /deadline/);
  f.phases.advance(); assert.equal(f.phases.phase, 'final_planning');
  assert.ok(f.world.evidence.events.some(e => e.payload.detail?.deadline_reached && e.payload.detail.from_phase === 'diplomacy'));
});

test('invalid strategic actions are recorded and lost; diplomacy commands cannot be delivered twice', () => {
  const f = fixture('invalid'); to(f, 'final_planning');
  finishInteractive(f, { 'polity-1': [{ type: 'broadcast', text: 'wrong phase' }], 'polity-2': [{ type: 'unknown' }], 'polity-3': [{ type: 'wait' }] });
  assert.equal(f.phases.phase, 'validation'); f.phases.advance();
  assert.equal(f.phases.exportState().submissions['polity-1'].status, 'rejected');
  assert.equal(f.world.evidence.events.filter(e => e.event_type === 'ActionRejected').length, 2);
  assert.throws(() => f.phases.submit({ actorId: 'polity-1', actor: lineage('polity-1'), actions: [{ type: 'wait' }] }), /current phase/);
  f.phases.advance(); f.phases.advance(); assert.equal(f.world.turn, 1);
  assert.equal(f.world.evidence.events.some(e => e.event_type === 'MessageSent'), false);
  const accepted = f.world.lastTurnCommit.acceptedActions; assert.deepEqual(accepted.map(a => a.actor_id), ['polity-3']); f.world.evidence.verify();
});

test('missing final submissions remain missing and do not manufacture wait actions', () => {
  const f = fixture('missing'); to(f, 'final_planning'); f.clock.value = f.phases.deadline; f.phases.advance();
  f.phases.advance(); f.phases.advance(); f.phases.advance();
  assert.deepEqual(f.world.lastTurnCommit.acceptedActions, []); assert.equal(f.world.turn, 1);
  const boundary = f.world.evidence.events.find(e => e.payload.detail?.from_phase === 'final_planning');
  assert.equal(boundary.payload.detail.missing_actor_ids.length, 3); assert.equal(f.world.evidence.events.some(e => e.event_type === 'ActionSubmitted'), false);
});

test('consequence projections retain the completed logical turn and current-turn messages', () => {
  const f = fixture('consequences'); to(f, 'diplomacy'); communicate(f, 'polity-1', 'news', { type: 'broadcast', text: 'this turn' });
  to(f, 'consequence_reveal'); assert.equal(f.world.turn, 1);
  const projection = f.phases.projection('polity-2'); assert.equal(projection.logical_time.turn, 0); assert.equal(projection.logical_time.phase, 'consequence_reveal');
  assert.ok(field(projection, 'authorized.messages').some(m => m.text === 'this turn'));
  assert.throws(() => communicate(f, 'polity-1', 'late', { type: 'broadcast', text: 'wrong' }), /current phase/);
});

// This is an explicitly synthetic archived invocation fixture, not a model call.
function memoryInvocation(f, actorId, request) {
  const runtime = f.runtimes.find(r => r.actorId === actorId), evidence = f.world.evidence;
  const projection = f.phases.projection(actorId), put = v => evidence.putPayload(v, 'nonempirical_conformance_fixture');
  const invocationId = 'fixture-memory-invocation', diagnostic = put({ stage: 'complete', classification: 'success', parsed_output_ref: put(request), synthetic: true });
  const raw = Buffer.from(JSON.stringify(request)), outputRef = put({ encoding: 'base64', data: raw.toString('base64'), byte_length: raw.length,
    raw_sha256: createHash('sha256').update(raw).digest('hex') });
  evidence.append({ eventType: 'ModelInvocation', turn: f.phases.logicalTurn, phase: 'memory_update', participants: [actorId],
    provenance: { input_refs: [diagnostic] }, payload: { schema_version: '1.0.0', invocation_id: invocationId, session_id: runtime.sessionId,
      run_id: f.world.runId, condition_id: runtime.condition.condition_id, context_segments: [], rendered_input_ref: put(projection), rendered_output_ref: outputRef,
      model_runtime_hash: put({ synthetic: true, fixture: true }), parser_hash: PHASE_MEMORY_PARSER_HASH, projection_ref: put(projection),
      memory_refs: [], tool_result_refs: [], action_ref: null, attempt: 1, retry_of: null } });
  return invocationId;
}

test('memory updates require phase and condition provenance; archives precede lifecycle snapshot', () => {
  const f = fixture('memory', { persistent: ['polity-1'] }), request = { operation: 'REMEMBER', text: 'Retain exactly this.' };
  assert.throws(() => f.phases.updateMemory('polity-1', request, { invocationId: 'x' }), /current phase/);
  to(f, 'memory_update'); assert.equal(f.world.turn, 1);
  assert.throws(() => f.phases.updateMemory('polity-2', request, { invocationId: 'x' }), /inaccessible/);
  assert.throws(() => f.phases.updateMemory('polity-1', request, { invocationId: 'x' }), /provenance/);
  const invocationId = memoryInvocation(f, 'polity-1', request);
  assert.throws(() => f.phases.updateMemory('polity-1', { ...request, text: 'arbitrary replacement' }, { invocationId }), /differs/);
  f.phases.updateMemory('polity-1', request, { invocationId });
  assert.equal(f.runtimes[0].memory.currentText, request.text);
  const operation = f.world.evidence.events.find(e => e.event_type === 'MemoryOperation'); assert.equal(operation.turn, 0);
  finishInteractive(f); f.phases.advance(); f.phases.advance(); assert.equal(f.phases.phase, 'interview');
  const snapshot = f.world.snapshots.at(-1), archived = JSON.parse(f.world.evidence.payloads.get(snapshot.state.memory_archive_ref).bytes);
  assert.ok(archived['polity-1'].operation_event_refs.includes(operation.event_id)); assert.equal(archived['polity-2'].enabled, false);
  f.world.evidence.verify();
});

test('interviews require actual isolated adapter; missing responses are recorded without faking evidence', async () => {
  const f = fixture('interview'); to(f, 'interview'); const before = f.world.stateHash(), draws = canonicalize(f.world.rng.manifest());
  await assert.rejects(f.phases.interviewAll(), /isolated Qwen Base adapter/);
  assert.equal(f.world.stateHash(), before); assert.equal(canonicalize(f.world.rng.manifest()), draws);
  assert.throws(() => f.phases.advance(), /interviews not completed/);
  f.clock.value = f.phases.deadline; f.phases.advance(); assert.equal(f.phases.phase, 'close');
  assert.equal(f.world.evidence.events.some(e => e.event_type === 'InterviewResponse'), false);
  const boundary = f.world.evidence.events.find(e => e.payload.detail?.from_phase === 'interview'); assert.equal(boundary.payload.detail.missing_actor_ids.length, 3);
});

test('phase checkpoints recover exact deadline/ledger and reject substitution or stale recovery', () => {
  const f = fixture('recovery'); to(f, 'final_planning');
  f.phases.submit({ actorId: 'polity-1', actor: lineage('polity-1'), actions: [{ type: 'wait' }] });
  const state = f.phases.exportState(), recovered = new TurnPhases({ world: f.world, runtimes: f.runtimes, ledger: f.ledger, now: f.now, state });
  assert.equal(recovered.deadline, f.phases.deadline); assert.deepEqual(recovered.exportState(), state);
  assert.throws(() => new TurnPhases({ world: f.world, runtimes: f.runtimes, now: f.now, state }), /reconstructed action ledger/);
  const changed = clone(state); changed.deadline_at++;
  assert.throws(() => new TurnPhases({ world: f.world, runtimes: f.runtimes, ledger: f.ledger, now: f.now, state: changed }), /substitution/);
  recovered.projection('polity-2'); assert.throws(() => new TurnPhases({ world: f.world, runtimes: f.runtimes, ledger: f.ledger, now: f.now, state }), /stale/);
});

test('a post-publication reducer fault resumes consequences without a second turn increment', () => {
  const f = fixture('fault'); to(f, 'resolution');
  assert.throws(() => f.phases.advance({ fault: point => { if (point === 'after_publish') throw new Error('publication boundary'); } }), /publication boundary/);
  assert.equal(f.world.turn, 1); assert.equal(f.phases.phase, 'resolution');
  f.phases.advance(); assert.equal(f.phases.phase, 'consequence_reveal'); assert.equal(f.world.turn, 1);
  assert.equal(f.world.evidence.events.filter(e => e.event_type === 'TurnResolved').length, 1);
});

test('configurable provisional budgets and mandatory phase timeouts fail closed', () => {
  const f = fixture('budgets'), manifest = phaseBudgetManifest(f.world, { diplomacy: 3210 });
  assert.equal(manifest.value.diplomacy, 3210); assert.equal(manifest.classification, 'WORLD_CALIBRATION');
  assert.throws(() => phaseBudgetManifest(f.world, { mystery: 1 })); assert.throws(() => phaseBudgetManifest(f.world, { diplomacy: 0 }));
  to(f, 'validation'); f.clock.value = f.phases.deadline;
  assert.throws(() => f.phases.advance(), /mandatory phase budget exhausted/); assert.equal(f.world.evidence.events.some(e => e.event_type === 'TurnCommitted'), false);
});

test('participant controls and projection metadata do not expose readiness of other actors', () => {
  const f = fixture('controls'), before = canonicalize(f.phases.controls('polity-1'));
  f.phases.projection('polity-2'); f.phases.ready('polity-2'); assert.equal(canonicalize(f.phases.controls('polity-1')), before);
  assert.equal('actors' in f.phases.controls('polity-1'), false); assertValidSchema(f.phases.projection('polity-1'), 'authorized-projection.schema.json');
  assert.throws(() => f.phases.advance(), /open participant/);
});

test('next lifecycle starts at reducer T+1 only after the previous logical turn closes', () => {
  const f = fixture('next'); assert.throws(() => new TurnPhases({ world: f.world, runtimes: f.runtimes, ledger: f.ledger, now: f.now }), /must be recovered/);
  to(f, 'close'); f.phases.advance();
  const next = new TurnPhases({ world: f.world, runtimes: f.runtimes, ledger: f.ledger, now: f.now });
  assert.equal(next.logicalTurn, 1); assert.equal(next.phase, 'observation'); assert.equal(f.world.turn, 1);
});

test('the effective action batch limit is enforced atomically before acceptance', () => {
  const f = fixture('batch-limit'); to(f, 'final_planning');
  finishInteractive(f, { 'polity-1': Array.from({ length: f.world.config.phases.actionLimit + 1 }, () => ({ type: 'wait' })) });
  f.phases.advance(); assert.equal(f.phases.exportState().submissions['polity-1'].status, 'rejected');
  const rejection = f.world.evidence.events.find(e => e.event_type === 'ActionRejected');
  assert.ok(rejection.payload.errors.every(e => e.code === 'action_limit_exceeded'));
  f.phases.advance(); assert.deepEqual(f.world.lastTurnCommit, null);
  f.phases.advance(); assert.ok(!f.world.lastTurnCommit.acceptedActions.some(a => a.actor_id === 'polity-1'));
});

test('model submission consumes canonical normalized .actions and rejects changed output or legacy-only shape', () => {
  const f = fixture('normalized-model-result'); to(f, 'final_planning');
  const actorId = 'polity-1', runtime = f.runtimes[0], evidence = f.world.evidence, projection = f.phases.projection(actorId);
  const put = value => evidence.putPayload(value, 'nonempirical_conformance_fixture'), actions = [{ type: 'wait' }, { type: 'recruit' }];
  const actionRef = put({ actions });
  const invocationId = 'synthetic-archived-batch', diagnostic = put({ stage: 'complete', classification: 'success', parsed_output_ref: actionRef, synthetic: true });
  const event = evidence.append({ eventType: 'ModelInvocation', turn: 0, phase: 'final_planning', participants: [actorId], provenance: { input_refs: [diagnostic] },
    payload: { schema_version: '1.0.0', invocation_id: invocationId, session_id: runtime.sessionId, run_id: f.world.runId,
      condition_id: runtime.condition.condition_id, context_segments: [], rendered_input_ref: put(projection), rendered_output_ref: put({ actions }),
      model_runtime_hash: put({ synthetic: true, fixture: true }), parser_hash: sha256('synthetic-batch-fixture'), projection_ref: put(projection),
      memory_refs: [], tool_result_refs: [], action_ref: actionRef, attempt: 1, retry_of: null } });
  const result = { eventId: event.event_id, invocationId, actions, action: { type: 'obsolete-legacy-shape' } };
  assert.throws(() => f.phases.submitModelResult({ actorId, result: { ...result, actions: [{ type: 'wait' }] } }), /differ/);
  assert.throws(() => f.phases.submitModelResult({ actorId, result: { eventId: event.event_id, invocationId, action: actions[0] } }), /normalized/);
  const submission = f.phases.submitModelResult({ actorId, result }); assert.equal(submission.actions.length, 2);
  assert.deepEqual(submission.actions.map(a => a.type), ['wait', 'recruit']); evidence.verify();
});
