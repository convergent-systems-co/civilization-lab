import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EvidenceStore, loadEvidence } from '../src/evidence.js';
import { canonicalize, clone, sha256 } from '../src/core.js';
import { prepareSyntheticCodingPacket, recordCoding, archivedCoding, validateAnnotations } from '../src/coding.js';
import { makeWorld } from '../src/world.js';
import { ActionLedger } from '../src/contracts.js';
import { executeTurnPhaseCommand } from '../src/turn-phases.js';
import { PILOT_0_AGENT_CONDITIONS } from '../src/agent.js';

const coder = { id: 'synthetic-research-validity', version: '1', mode: 'synthetic_fixture' };
function code(store, packet, annotations) {
  return recordCoding(store, packet, { annotations, reviewedRefs: packet.input.observations.map(o => o.ref), coder });
}
function transition(store, mechanic, participants = ['a', 'b'], detail = {}) {
  const state = store.putPayload({ synthetic: true });
  return { eventType: 'WorldTransition', turn: 1, phase: 'resolve', participants,
    payload: { schema_version: '1.0.0', run_id: store.runId, mechanic, action_ids: [], actor_ids: participants,
      before_state_ref: state, after_state_ref: state, detail } };
}

// Literal communications are synthetic annotation fixtures, not world-replay or
// research results. Every ref is issued by the real packet/archive pipeline.
function repairFixture({ actFrom = 'b', actTo = 'a', evaluationFrom = 'a', evaluationTo = 'b',
  actTurn = 1, evaluationTurn = 2, causalEvaluation = false, mechanical = false } = {}) {
  const store = new EvidenceStore('synthetic-repair-validity');
  const message = (from, to, text, turn, parents = []) => store.append({ eventType: 'MessageSent', turn,
    phase: 'diplomacy', participants: [from, to], payload: { from, to, text }, causality: { causation_ids: parents } });
  const source = message('a', 'b', 'We dispute our arrangement.', 0);
  message('c', 'd', 'We are separate counterparties.', 0);
  let act, evaluation;
  const appendAct = () => {
    act = mechanical ? store.append({ ...transition(store, 'transfer', [actFrom, actTo],
      { from: actFrom, to: actTo, resource: 'food', amount: 1 }), turn: actTurn }) :
      message(actFrom, actTo, 'I acknowledge the harm and undertake compensation.', actTurn);
  };
  const appendEvaluation = () => { evaluation = message(evaluationFrom, evaluationTo, 'I accept the offered repair.', evaluationTurn,
    causalEvaluation ? [act.event_id] : []); };
  if (evaluationTurn < actTurn) { appendEvaluation(); appendAct(); }
  else { appendAct(); appendEvaluation(); }
  const packet = prepareSyntheticCodingPacket(store);
  const refs = Object.fromEntries(store.events.map((event, index) => [event.event_id, packet.input.observations[index].ref]));
  const row = { id: 'repair', kind: 'repair', source: refs[source.event_id], actor: 'subject-1', counterparty: 'subject-2',
    eligibility: 'ELIGIBLE', observation_status: 'OBSERVED', confidence: 1, ambiguity: null,
    rupture_kind: 'explicit_relational_conflict', acts: [{ source: refs[act.event_id],
      kind: mechanical ? 'restitution_compensation' : 'acknowledgment_with_corrective_undertaking' }],
    outcome: 'REPAIR_ACCEPTED', sufficient_opportunity: true, evaluation_ref: refs[evaluation.event_id] };
  return { store, packet, row };
}

for (const [name, options, reason] of [
  ['unrelated C/D restorative message', { actFrom: 'c', actTo: 'd' }, /restorative act parties/],
  ['episode actor addressing an outsider', { actFrom: 'a', actTo: 'c' }, /restorative act parties/],
  ['outsider addressing an episode actor', { actFrom: 'c', actTo: 'a' }, /restorative act parties/],
  ['unrelated mechanical transfer', { actFrom: 'c', actTo: 'd', mechanical: true }, /restorative act parties/],
  ['unrelated evaluation', { evaluationFrom: 'c', evaluationTo: 'd' }, /evaluation parties/],
  ['restorative act after evaluation', { actTurn: 3, evaluationTurn: 2 }, /after repair evaluation/],
  ['incidental same-turn evaluation order', { actTurn: 1, evaluationTurn: 1 }, /causal predecessor/],
]) test(`repair rejects ${name} before it can enter an endpoint`, () => {
  const f = repairFixture(options);
  assert.throws(() => code(f.store, f.packet, [f.row]), reason);
  assert.equal(f.store.events.some(e => e.event_type === 'BehaviorCoded'), false);
});

test('the original combined cross-party/future-act falsification is rejected', () => {
  const f = repairFixture({ actFrom: 'c', actTo: 'd', actTurn: 6, evaluationTurn: 4 });
  assert.throws(() => code(f.store, f.packet, [f.row]), /parties|after repair evaluation/);
});

test('repair cannot invent a counterparty absent from the rupture', () => {
  const f = repairFixture(); f.row.counterparty = 'subject-3';
  assert.throws(() => validateAnnotations([f.row], f.packet.input), /rupture parties/);
});

for (const [name, options] of [
  ['counterparty undertaking', {}],
  ['actor undertaking', { actFrom: 'a', actTo: 'b' }],
  ['canonical mechanical compensation', { mechanical: true }],
  ['same-turn causally subsequent evaluation', { actTurn: 1, evaluationTurn: 1, causalEvaluation: true }],
  ['long follow-up without an invented repair window', { evaluationTurn: 19 }],
]) test(`repair preserves ${name} through archived coding regeneration`, () => {
  const f = repairFixture(options); code(f.store, f.packet, [f.row]);
  assert.deepEqual(archivedCoding(JSON.parse(JSON.stringify(f.store.bundle()))).event.payload.annotations, [f.row]);
});

test('an attempt may itself supply evaluation evidence; acceptance is not required', () => {
  const f = repairFixture(); f.row.outcome = 'REPAIR_ATTEMPT'; f.row.evaluation_ref = f.row.acts[0].source;
  code(f.store, f.packet, [f.row]);
  assert.equal(archivedCoding(f.store.bundle()).event.payload.annotations[0].outcome, 'REPAIR_ATTEMPT');
});

test('group repair and explicitly unavailable evaluation retain their existing meanings', () => {
  const f = repairFixture(); f.row.counterparty = ['subject-2', 'subject-3'];
  assert.equal(validateAnnotations([f.row], f.packet.input), true);
  f.row.observation_status = 'UNEVALUABLE'; f.row.outcome = 'UNEVALUABLE';
  f.row.sufficient_opportunity = false; f.row.evaluation_ref = null;
  assert.equal(validateAnnotations([f.row], f.packet.input), true);
});

test('repair rejection is unchanged by permutation of incidental packet array order', () => {
  const f = repairFixture({ actTurn: 1, evaluationTurn: 1 });
  const input = clone(f.packet.input); input.observations.reverse();
  assert.throws(() => validateAnnotations([f.row], input), /causal predecessor/);
});

test('closed taxonomy excludes phantom fixtures, non-emitting action names and invented outcomes', () => {
  const store = new EvidenceStore('synthetic-mechanic-rejection');
  for (const mechanic of ['UNREGISTERED_RESEARCH_INTERVENTION', 'fixture', 'fixture_transition', 'wait', 'attack',
    'reconnaissance', 'spatial_observation', 'intelligence_outcome']) {
    assert.throws(() => store.append(transition(store, mechanic)), /mechanic.*not permitted/);
  }
  assert.equal(store.events.length, 0);
});

test('rehashed unknown mechanics fail archive schema validation rather than just integrity checks', () => {
  const store = new EvidenceStore('synthetic-rehashed-mechanic');
  store.append(transition(store, 'transfer'));
  const event = store.events[0], payload = clone(event.payload); delete payload.payload_ref;
  payload.mechanic = 'UNREGISTERED_RESEARCH_INTERVENTION';
  event.payload = { payload_ref: store.putPayload(payload), ...payload };
  event.integrity.signature = null; event.integrity.canonical_bytes_hash = null;
  event.integrity.signature = createHmac('sha256', store.signingSecret).update(canonicalize(event)).digest('base64');
  event.integrity.canonical_bytes_hash = sha256(event);
  assert.throws(() => loadEvidence(store.bundle()), /mechanic.*not permitted/);
  assert.throws(() => prepareSyntheticCodingPacket(store), /mechanic.*not permitted/);
});

test('all three canonical controller mechanics remain valid but cannot enter coder coverage', () => {
  const store = new EvidenceStore('synthetic-controller-filter');
  store.append({ eventType: 'MessageSent', turn: 0, phase: 'diplomacy', participants: ['a', 'b'],
    payload: { from: 'a', to: 'b', text: 'Behavioral evidence only.' } });
  for (const mechanic of ['turn_phase_state', 'turn_phase_command', 'turn_memory_archive']) {
    const event = transition(store, mechanic, [], { controller_secret: 'SECRET_CONTROL_METADATA' });
    event.payload.after_state_ref = store.putPayload({ bindings: 'SECRET_CONTROL_METADATA', ready: ['a'], deadline_at: 123 });
    store.append(event);
  }
  assert.equal(store.verify(), true);
  const packet = prepareSyntheticCodingPacket(store);
  assert.equal(packet.input.observations.length, 1);
  assert.equal(JSON.stringify(packet.input).includes('SECRET_CONTROL_METADATA'), false);
  code(store, packet, []);
  assert.equal(archivedCoding(store.bundle()).input.observations.length, 1);
});

test('actual phase commands preserve messages and channel withdrawal without controller metadata', () => {
  const world = makeWorld({ runId: 'synthetic-phase-coding-taxonomy', seed: 'phase-conformance-v1' });
  const ledger = new ActionLedger(world.evidence);
  const bindings = Object.keys(world.polities).map(actorId => ({ actorId, sessionId: 'session-' + actorId,
    condition: PILOT_0_AGENT_CONDITIONS.nonpersistent }));
  let state = null;
  const run = (operation, input = {}) => {
    const out = executeTurnPhaseCommand({ world, ledger, bindings, state, command: { operation, input }, at: 100 });
    state = out.phaseState; return out.result;
  };
  const send = (actorId, requestId, command) => run('diplomacy', { actorId, requestId, command,
    actor: { persistent_identity_id: actorId, session_id: 'session-' + actorId, invocation_id: 'synthetic-' + requestId } });
  run('begin');
  assert.deepEqual(prepareSyntheticCodingPacket(world.evidence).input.observations, []);
  for (let i = 0; i < 2; i++) {
    for (const { actorId } of bindings) { run('projection', { actorId }); run('ready', { actorId }); }
    run('advance');
  }
  send('polity-1', 'contact-a', { type: 'broadcast', text: 'I offer coordination.' });
  send('polity-2', 'contact-b', { type: 'broadcast', text: 'I acknowledge your offer.' });
  const channel = send('polity-1', 'create', { type: 'channel_create', members: ['polity-2'] });
  assert.equal(channel.status, 'resolved');
  send('polity-2', 'leave', { type: 'channel_leave', channel_id: channel.channel_id });
  const packet = prepareSyntheticCodingPacket(world.evidence), observations = packet.input.observations;
  assert.equal(observations.length, 4, 'two communications and two membership changes, no duplicate wrappers');
  assert.equal(observations.filter(o => o.type === 'MessageSent').length, 2);
  const withdrawal = observations.find(o => o.facts.action_type === 'channel_leave');
  assert.ok(withdrawal);
  assert.deepEqual(Object.values(withdrawal.facts.before_state.channels)[0].members, ['subject-1', 'subject-2']);
  assert.deepEqual(Object.values(withdrawal.facts.after_state.channels)[0].members, ['subject-1']);
  assert.equal(validateAnnotations([{ id: 'withdrawal', kind: 'repair', source: withdrawal.ref,
    actor: 'subject-2', counterparty: 'subject-1', eligibility: 'ELIGIBLE', observation_status: 'UNEVALUABLE',
    confidence: 1, ambiguity: null, rupture_kind: 'cooperative_withdrawal', acts: [], outcome: 'UNEVALUABLE',
    sufficient_opportunity: false, evaluation_ref: null }], packet.input), true);
  for (const token of ['turn_phase_state', 'turn_phase_command', 'deadline_at', 'bindings', 'session-', 'request_id', 'configuration'])
    assert.equal(JSON.stringify(observations).includes(token), false, token);
  code(world.evidence, packet, []);
  assert.deepEqual(archivedCoding(world.evidence.bundle()).input, packet.input);
});
