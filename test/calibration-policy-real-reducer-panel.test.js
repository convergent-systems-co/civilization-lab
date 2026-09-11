import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationProtocol } from '../src/calibration.js';
import { startingCalibrationParameterSet, materializeCalibrationRuntime } from '../src/calibration-runner.js';
import { assignCalibrationPolicies, decideCalibrationActions, PHASE_A_POLICY_PACKAGE, validateSyntheticPolicyCoverage } from '../src/calibration-policy.js';
import { makeWorld, resolveTurn, PILOT_0_CONFIG } from '../src/world.js';
import { ActionLedger, commitTurn, projectWorld } from '../src/contracts.js';
import { clone, stableId } from '../src/core.js';
import { discoverPolity, observeWorld, territoryHexes } from '../src/world-map.js';

const actor = (world, actorId) => ({ persistent_identity_id: actorId,
  session_id: stableId('coverage-session', world.runId, actorId),
  invocation_id: stableId('coverage-decision', world.runId, world.turn, actorId) });
const relocate = (world, entity, hexId) => { entity.hex_id = hexId; entity.territory_id = world.hexes[hexId].territory_id; };
const refresh = world => Object.keys(world.polities).forEach(id => observeWorld(world, id));
const group = (world, id, assignment) => world.polities[id].citizens.find(item => item.assignment === assignment);
const facility = (world, id, type) => Object.values(world.facilities).find(item => item.owner_id === id && item.type === type);
const know = (world, a, b) => { discoverPolity(world, world.polities[a], b, 'synthetic_coverage_setup'); observeWorld(world, a); };

function policyActions(world, actorId, role) {
  const projection = projectWorld(world, actorId);
  const applicable_configuration = projection.fields.find(item => item.path === 'public.rules').value;
  return { projection, actions: decideCalibrationActions({ projection, policy_id: role, applicable_configuration }) };
}

function policyTurn(world, roles) {
  const ledger = new ActionLedger(world.evidence), validated = [], chosen = {};
  for (const [actorId, role] of Object.entries(roles).sort()) {
    const { projection, actions } = policyActions(world, actorId, role); chosen[actorId] = actions;
    const submitted = ledger.submit({ runId: world.runId, turnId: `turn-${world.turn}`, actorId,
      actor: actor(world, actorId), actions, projection, phase: world.phase });
    const result = ledger.validate(submitted, world);
    assert.equal(result.submission.status, 'validated', `${role}: ${JSON.stringify(result.submission.validation)}`);
    validated.push(result);
  }
  resolveTurn(world, commitTurn(world, ledger, validated));
  return chosen;
}

const coverageWorld = (name, config = PILOT_0_CONFIG) => makeWorld({ runId: `synthetic-policy-coverage-${name}`,
  seed: 'calibration-seed-00', config });

test('all 24 frozen seeds execute the fixed balanced panel through real projection, ledger, commit, and reducers',
  { timeout: 120000 }, () => {
    const seeds = calibrationProtocol().seed_panel.seeds;
    const configuration = materializeCalibrationRuntime(startingCalibrationParameterSet()).effective_configuration;
    const seen = new Set();
    for (const seed of seeds) {
      const world = makeWorld({ runId: 'synthetic-panel-reducer-' + seed, seed, config: configuration });
      const actors = Object.keys(world.polities).sort();
      const assignment = assignCalibrationPolicies({ participant_ids: actors, seed, seed_panel: seeds });
      const ledger = new ActionLedger(world.evidence), validated = [];
      for (const actorId of actors) {
        seen.add(assignment[actorId]);
        const projection = projectWorld(world, actorId);
        const rules = projection.fields.find(item => item.path === 'public.rules').value;
        const actions = decideCalibrationActions({ projection, policy_id: assignment[actorId], applicable_configuration: rules });
        const actor = { persistent_identity_id: actorId, session_id: stableId('panel-session', seed, actorId),
          invocation_id: stableId('panel-decision', seed, actorId) };
        const submitted = ledger.submit({ runId: world.runId, turnId: 'turn-0', actorId, actor, actions, projection });
        const result = ledger.validate(submitted, world);
        assert.equal(result.submission.status, 'validated', JSON.stringify(result.submission.validation));
        validated.push(result);
      }
      resolveTurn(world, commitTurn(world, ledger, validated));
      assert.equal(world.turn, 1);
      assert.equal(world.evidence.events.filter(event => event.event_type === 'TurnCommitted').length, 1);
      assert.equal(world.evidence.events.filter(event => event.event_type === 'TurnResolved').length, 1);
      assert.equal(world.evidence.events.some(event => event.event_type === 'ModelInvocation'), false);
    }
    assert.equal(seen.size, 8);
  });

test('constructed policy fixtures activate every advertised mechanic through actual reducers and canonical evidence',
  { timeout: 120000 }, () => {
    const stores = [];

    const exploration = coverageWorld('exploration');
    assert.equal(policyTurn(exploration, { 'polity-1': 'EXPANSION_EXPLORATION' })['polity-1'][0].type, 'explore');
    stores.push(exploration.evidence);

    const building = coverageWorld('building');
    const builder = group(building, 'polity-1', 'Builder'); builder.count = 1;
    group(building, 'polity-1', 'Explorer').count = 0;
    const openSite = territoryHexes(building, building.polities['polity-1'].territory[0]).find(hex => hex.terrain !== 'water' &&
      !Object.values(building.facilities).some(item => item.hex_ids.includes(hex.id)));
    relocate(building, builder, openSite.id); building.polities['polity-1'].credits = 100;
    building.polities['polity-1'].resources.metal = 100; refresh(building);
    assert.equal(policyTurn(building, { 'polity-1': 'ECONOMIC_DEVELOPMENT' })['polity-1'][0].type, 'build');
    stores.push(building.evidence);

    const technology = coverageWorld('technology');
    assert.equal(policyTurn(technology, { 'polity-1': 'TECHNOLOGY_DEVELOPMENT' })['polity-1'][0].type, 'research');
    policyTurn(technology, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY' });
    policyTurn(technology, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY' });
    stores.push(technology.evidence);

    const security = coverageWorld('security');
    know(security, 'polity-1', 'polity-2');
    assert.equal(policyTurn(security, { 'polity-1': 'DEFENSIVE_SECURITY' })['polity-1'][0].type, 'recruit');
    assert.equal(policyTurn(security, { 'polity-1': 'DEFENSIVE_SECURITY' })['polity-1'][0].type, 'fortify');
    assert.equal(policyTurn(security, { 'polity-1': 'DEFENSIVE_SECURITY' })['polity-1'][0].type, 'intelligence');
    policyTurn(security, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY' });
    policyTurn(security, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY' });
    stores.push(security.evidence);

    const exchange = coverageWorld('exchange'); know(exchange, 'polity-1', 'polity-2');
    assert.equal(policyTurn(exchange, { 'polity-1': 'COOPERATIVE_EXCHANGE' })['polity-1'][0].type, 'transfer');
    stores.push(exchange.evidence);

    const discovery = coverageWorld('discovery'); discovery.phase = 'diplomacy';
    assert.equal(policyTurn(discovery, { 'polity-1': 'COOPERATIVE_EXCHANGE' })['polity-1'][0].type, 'broadcast');
    assert(discovery.polities['polity-2'].knowledge.includes('polity-1'), 'broadcast reducer did not create authorized discovery');
    stores.push(discovery.evidence);

    const peaceful = coverageWorld('peaceful'); know(peaceful, 'polity-1', 'polity-2'); peaceful.phase = 'diplomacy';
    assert.equal(policyTurn(peaceful, { 'polity-1': 'COOPERATIVE_EXCHANGE' })['polity-1'][0].type, 'message');
    peaceful.phase = 'diplomacy';
    assert.equal(policyTurn(peaceful, { 'polity-1': 'COOPERATIVE_EXCHANGE' })['polity-1'][0].type, 'message');
    stores.push(peaceful.evidence);

    const contested = coverageWorld('contested');
    const unclaimed = Object.values(contested.hexes).find(hex => hex.terrain !== 'water' && contested.territories[hex.territory_id].status === 'unclaimed');
    for (const id of ['polity-1','polity-2']) relocate(contested, group(contested, id, 'Explorer'), unclaimed.id);
    refresh(contested);
    const claims = policyTurn(contested, { 'polity-1': 'EXPANSION_EXPLORATION', 'polity-2': 'EXPANSION_EXPLORATION' });
    assert.deepEqual(Object.values(claims).map(actions => actions[0].type), ['claim','claim']);
    assert.equal(contested.territories[unclaimed.territory_id].status, 'contested'); stores.push(contested.evidence);

    const battleConfig = clone(PILOT_0_CONFIG); battleConfig.dynamics.combatMinimumHitPermille = 1000;
    battleConfig.dynamics.combatMaximumHitPermille = 1000; battleConfig.dynamics.combatDamage = 100;
    const battle = coverageWorld('battle', battleConfig);
    for (const id of ['polity-1','polity-2']) relocate(battle, group(battle, id, 'Soldier'), facility(battle, id, 'ground_military').hex_ids[0]);
    refresh(battle);
    const recruits = policyTurn(battle, { 'polity-1': 'DEFENSIVE_SECURITY', 'polity-2': 'DEFENSIVE_SECURITY' });
    assert.deepEqual(Object.values(recruits).map(actions => actions[0].type), ['recruit','recruit']);
    const [u1,u2] = ['polity-1','polity-2'].map(id => battle.polities[id].units[0]);
    relocate(battle, u1, 'hex-4-2'); relocate(battle, u2, 'hex-6-2'); refresh(battle);
    const advance = policyTurn(battle, { 'polity-1': 'COMPETITIVE_AGGRESSIVE' })['polity-1'][0];
    assert.equal(advance.type, 'move', 'aggressive role must move toward an observed out-of-range target');
    const [attacker,targetUnit] = ['polity-1','polity-2'].map(id => battle.polities[id].units[0]);
    relocate(battle, attacker, 'hex-5-2'); relocate(battle, targetUnit, 'hex-6-2'); refresh(battle);
    const attacks = policyTurn(battle, { 'polity-1': 'COMPETITIVE_AGGRESSIVE', 'polity-2': 'COMPETITIVE_AGGRESSIVE' });
    assert.deepEqual(Object.values(attacks).map(actions => actions[0].type), ['attack','attack']); stores.push(battle.evidence);

    const conquest = coverageWorld('conquest');
    const invader = group(conquest, 'polity-1', 'Explorer'), target = conquest.polities['polity-2'];
    invader.count = target.population + 1; conquest.polities['polity-1'].population = conquest.polities['polity-1'].citizens.reduce((n, item) => n + item.count, 0);
    relocate(conquest, invader, target.capital_hex_id); refresh(conquest);
    assert.equal(policyTurn(conquest, { 'polity-1': 'EXPANSION_EXPLORATION' })['polity-1'][0].type, 'claim');
    for (let turn = 1; turn < conquest.config.dynamics.capitalHoldTurns; turn++)
      policyTurn(conquest, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY', 'polity-2': 'CONSERVATIVE_LOW_ACTIVITY' });
    assert.equal(conquest.polities['polity-2'].alive, false); stores.push(conquest.evidence);

    const report = validateSyntheticPolicyCoverage({ evidence_stores: stores });
    assert.equal(report.status, 'PASS');
    assert.deepEqual(report.covered_mechanics, [...PHASE_A_POLICY_PACKAGE.expected_mechanics_coverage].sort());
    assert.equal(report.qwen_invocations, 0); assert.equal(report.endpoint_metrics_computed, 0);
    assert.equal(report.evidence_class, 'SYNTHETIC_REDUCER_BACKED_FIXTURE');
  });

test('specialized roles emit and execute their state-dependent advertised actions', () => {
  const populationMove = coverageWorld('population-move');
  for (const citizen of populationMove.polities['polity-1'].citizens) if (citizen.assignment !== 'Civilian') citizen.count = 0;
  populationMove.polities['polity-1'].population = group(populationMove, 'polity-1', 'Civilian').count;
  const ownedIds = new Set(populationMove.polities['polity-1'].territory);
  const edge = Object.values(populationMove.hexes).find(hex => ownedIds.has(hex.territory_id) && hex.terrain !== 'water' &&
    Object.values(populationMove.hexes).some(other => other.terrain !== 'water' && other.territory_id !== hex.territory_id &&
      Math.max(Math.abs(hex.q-other.q), Math.abs(hex.r-other.r), Math.abs((hex.q+hex.r)-(other.q+other.r))) === 1));
  relocate(populationMove, group(populationMove, 'polity-1', 'Civilian'), edge.id); refresh(populationMove);
  assert.equal(policyTurn(populationMove, { 'polity-1': 'EXPANSION_EXPLORATION' })['polity-1'][0].type, 'move_population');

  const annex = coverageWorld('annex'), annexActor = annex.polities['polity-1'];
  const annexSite = Object.values(annex.hexes).find(hex => hex.terrain !== 'water' && annex.territories[hex.territory_id].owner_id === 'polity-2');
  const annexTerritory = annex.territories[annexSite.territory_id]; annexTerritory.controller_id = annexActor.id; annexTerritory.status = 'controlled';
  relocate(annex, group(annex, annexActor.id, 'Explorer'), annexSite.id); refresh(annex);
  assert.equal(policyTurn(annex, { [annexActor.id]: 'EXPANSION_EXPLORATION' })[annexActor.id][0].type, 'annex');

  const reassignment = coverageWorld('reassign'), reassignmentActor = reassignment.polities['polity-1'];
  group(reassignment, reassignmentActor.id, 'Explorer').count = 0; group(reassignment, reassignmentActor.id, 'Builder').count = 0;
  const civilian = group(reassignment, reassignmentActor.id, 'Civilian'), farm = facility(reassignment, reassignmentActor.id, 'agriculture');
  relocate(reassignment, civilian, farm.hex_ids[0]); reassignmentActor.food = 0; refresh(reassignment);
  assert.equal(policyTurn(reassignment, { [reassignmentActor.id]: 'ECONOMIC_DEVELOPMENT' })[reassignmentActor.id][0].type, 'reassign');

  const reverse = coverageWorld('reverse-engineer'), reverseActor = reverse.polities['polity-1'];
  const artifact = facility(reverse, reverseActor.id, 'agriculture'); artifact.captured_from = 'polity-2'; artifact.prerequisites = ['agronomy'];
  reverseActor.credits = 100; refresh(reverse);
  assert.equal(policyTurn(reverse, { [reverseActor.id]: 'TECHNOLOGY_DEVELOPMENT' })[reverseActor.id][0].type, 'reverse_engineer');

  const reconnaissance = coverageWorld('reconnaissance'), reconnaissanceActor = reconnaissance.polities['polity-1'];
  reconnaissanceActor.technologies = ['satellites']; reconnaissanceActor.credits = 100; refresh(reconnaissance);
  assert.equal(policyTurn(reconnaissance, { [reconnaissanceActor.id]: 'DEFENSIVE_SECURITY' })[reconnaissanceActor.id][0].type, 'recruit');
  assert.equal(policyTurn(reconnaissance, { [reconnaissanceActor.id]: 'DEFENSIVE_SECURITY' })[reconnaissanceActor.id][0].type, 'fortify');
  assert.equal(policyTurn(reconnaissance, { [reconnaissanceActor.id]: 'DEFENSIVE_SECURITY' })[reconnaissanceActor.id][0].type, 'reconnaissance');

  const opportunistic = coverageWorld('opportunistic');
  assert.equal(policyActions(opportunistic, 'polity-1', 'OPPORTUNISTIC_MIXED').actions[0].type, 'explore');
  opportunistic.polities['polity-1'].food = 0; refresh(opportunistic);
  assert.equal(policyActions(opportunistic, 'polity-1', 'OPPORTUNISTIC_MIXED').actions[0].type, 'prospect');
  opportunistic.polities['polity-1'].food = 100; know(opportunistic, 'polity-1', 'polity-2');
  assert.equal(policyActions(opportunistic, 'polity-1', 'OPPORTUNISTIC_MIXED').actions[0].type, 'transfer');
});

test('ordinary-state role sequencing reaches investment, readiness, sharing, and low-activity behavior', () => {
  const economic = coverageWorld('ordinary-economic-sequence');
  const ordinaryBuilder = group(economic, 'polity-1', 'Builder');
  const ordinarySite = territoryHexes(economic, economic.polities['polity-1'].territory[0]).find(hex => hex.terrain !== 'water' &&
    !Object.values(economic.facilities).some(item => item.hex_ids.includes(hex.id)));
  relocate(economic, ordinaryBuilder, ordinarySite.id); refresh(economic);
  const economicActions = [];
  for (let turn = 0; turn < 6; turn++)
    economicActions.push(policyTurn(economic, { 'polity-1': 'ECONOMIC_DEVELOPMENT' })['polity-1'][0].type);
  assert.equal(economicActions[0], 'prospect');
  assert(economicActions.includes('build'), `productive construction starved: ${economicActions}`);
  assert(economicActions.includes('upgrade'), `productive upgrade starved: ${economicActions}`);

  const defense = coverageWorld('ordinary-defense-readiness');
  know(defense, 'polity-1', 'polity-2');
  assert.equal(policyTurn(defense, { 'polity-1': 'DEFENSIVE_SECURITY' })['polity-1'][0].type, 'recruit',
    'an under-defended polity must establish operational readiness before discretionary intelligence');

  const conservative = coverageWorld('ordinary-conservative-threshold');
  know(conservative, 'polity-1', 'polity-2');
  conservative.polities['polity-1'].technologies = ['satellites']; refresh(conservative);
  assert.equal(policyTurn(conservative, { 'polity-1': 'CONSERVATIVE_LOW_ACTIVITY' })['polity-1'][0].type, 'wait',
    'a low-activity role must not delegate ordinary behavior to intelligence-capable defense');

  const sharing = coverageWorld('ordinary-technology-sharing');
  know(sharing, 'polity-1', 'polity-2');
  sharing.polities['polity-1'].technologies = Object.keys(sharing.config.technologies).sort(); refresh(sharing);
  assert.equal(policyTurn(sharing, { 'polity-1': 'TECHNOLOGY_DEVELOPMENT' })['polity-1'][0].type, 'share_technology');
  assert(sharing.polities['polity-2'].technologies.length > 0, 'technology-sharing action did not execute through reducer');
});
