// Shared deterministic fixtures for the Phase A calibration tooling suites.
//
// Every construct here is a pure function of its arguments: no wall-clock reads, no
// randomness, and no ambient environment. Two calls with the same arguments — in the same
// process or in a different one — produce byte-identical evidence, metrics, and keys.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { EvidenceStore } from "../../src/evidence.js";
import { sha256 } from "../../src/core.js";
import { calibrationProtocol } from "../../src/calibration.js";
import { parameterRegistry } from "../../src/parameters.js";

const protocol = calibrationProtocol();

// PKCS#8 prefix for a raw 32-byte Ed25519 private seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ATTESTATION_KEY_SEED = "phase-a-calibration-fixture-attestation-key-v1";

/** The frozen 24-identifier synthetic seed panel, as a fresh array on every call. */
export function syntheticSeedPanel() {
  return [...protocol.seed_panel.seeds];
}

/** Deterministic canonical-evidence bundle for one (parameter-set, seed) key. */
export function syntheticCanonicalEvidence({ seed = syntheticSeedPanel()[0], treatmentLeak = false, runtimeConfiguration = null } = {}) {
  const store = new EvidenceStore(`synthetic-calibration-${seed}`);
  const values = Object.fromEntries(parameterRegistry().parameters.map(entry => [entry.parameter_id, structuredClone(entry.value)]));
  const fallbackWorld = { phases: values["world.configuration.phases"], dynamics: values["world.configuration.dynamics"],
    unitTypes: values["world.configuration.unitTypes"], initialFacilityTypes: values["world.configuration.initialFacilityTypes"] };
  const config = { maxTurns: 20, phases: { actionLimit: 64 }, synthetic: true,
    calibration_policy_id: "deterministic_synthetic_conformance",
    ...(runtimeConfiguration ? { calibration_parameter_set_hash: runtimeConfiguration.parameter_set_hash,
      effective_configuration_hash: runtimeConfiguration.effective_configuration_hash,
      world_configuration: runtimeConfiguration.effective_configuration } : { world_configuration: fallbackWorld }) };
  const initial = { run_id: store.runId, turn: 0, phase: "actions", terminal: false,
    polities: Object.fromEntries(["a", "b", "c"].map(id => [id, { id, alive: true,
      citizens: [{ id: `${id}-citizens`, count: 20 }], units: [{ id: `${id}-u`, crew: [{ count: 4 }] }],
      knowledge: [id], reports: [] }])) };
  const configRef = store.putPayload(config, "configuration");
  const initialRef = store.putPayload(initial, "authoritative_research");
  store.append({ eventType: "RunCreated", turn: 0, phase: "setup", participants: ["a", "b", "c"], payload: {
    run_id: store.runId, seed, configuration_ref: configRef, initial_state_ref: initialRef,
    ...(treatmentLeak ? { treatment_arm: "persistent" } : {})
  }});
  let lastLossEventId = null;
  for (let turn = 0; turn < 20; turn++) {
    const state = {
      run_id: store.runId, turn: turn + 1, phase: "actions", terminal: turn === 19,
      polities: Object.fromEntries(["a", "b", "c"].map((id, index) => [id, {
        alive: true, population: 24, food: 120 + turn * 2, credits: 80,
        id, resources: { metal: 20 - (turn % 4), fuel: 10, crystal: 5 },
        citizens: [{ id: `${id}-citizens`, assignment: "Civilian", count: 20, hex_id: "h1", territory_id: "t1" }],
        units: [{ id: `${id}-u`, type: "infantry", crew: [{ id: `${id}-crew`, count: 4 }], health: 100 }],
        technologies: turn >= 4 ? ["agronomy"] : [], knowledge: turn >= 5 ? ["a", "b", "c"] : [id],
        reports: turn >= 6 ? [{ turn: 5, source: "activity_detection", actor_id: id === "a" ? "b" : "a" }] : []
      }])),
      hexes: { h1: { terrain: "plains" }, h2: { terrain: turn % 2 ? "forest" : "plains" } },
      facilities: Object.fromEntries(["a", "b", "c"].map(id => [`${id}-training`, { id: `${id}-training`, owner_id: id, type: "ground_military", destroyed: false }]))
    };
    const stateRef = store.putPayload(state, "authoritative_research");
    const acceptedIds = Array.from({ length: 30 }, (_, i) => `action-${turn}-${i}`);
    for (const [actorIndex, actorId] of ["a", "b", "c"].entries()) {
      const actions = acceptedIds.filter((_, index) => index % 3 === actorIndex).map((action_id, index) => ({ action_id, type: index % 3 === 0 ? "claim" : "communicate" }));
      store.append({ eventType: "ActionSubmitted", turn, phase: "actions", participants: [actorId], payload: {
        schema_version: "1.0.0", submission_id: `submission-${turn}-${actorId}`, run_id: store.runId, turn_id: `turn-${turn}`, turn,
        actor_id: actorId, actor: { persistent_identity_id: actorId, session_id: `session-${actorId}`, invocation_id: `invocation-${turn}-${actorId}` },
        phase: "actions", projection_id: `projection-${turn}-${actorId}`, projection_version_ref: "1.0.0", projection_hash: sha256({ turn, actorId }),
        submitted_actions: actions, actions, action_hash: sha256(actions), status: "submitted",
        validation: { projection_scoped: true, deterministic: true, public_safe_errors: true }, atomicity: { turn_committed_ref: null, immutable_after_commit: false },
        catalogue_version: "pilot-0.2"
      }});
      store.append({ eventType: "ActionAccepted", turn, phase: "commit", participants: [actorId], payload: {
        submission_id: `submission-${turn}-${actorId}`, accepted_action_ids: actions.map(action => action.action_id),
        turn_committed_id: `commit-${turn}`, actor_id: actorId
      }});
    }
    const commit = store.append({ eventType: "TurnCommitted", turn, phase: "commit", payload: {
      schema_version: "1.0.0", run_id: store.runId, turn, turn_id: `turn-${turn}`,
      turn_committed_id: `commit-${turn}`, input_state_hash: sha256({ turn }),
      accepted_submission_ids: ["a", "b", "c"].map(id => `submission-${turn}-${id}`), accepted_action_ids: acceptedIds,
      actor_action_refs: acceptedIds.map((id, i) => `${["a", "b", "c"][i % 3]}:${id}`),
      projection_version_refs: [], configuration_hash: sha256(config),
      rng_provenance_root_ref: sha256(seed), rng_provenance_refs: [], lineage_refs: [],
      action_set_hash: sha256(acceptedIds), commit_event_id: store.nextEventId(),
      catalogue_version: "pilot-0.2", immutable_after_commit: true
    }});
    if (turn >= 3) store.append({ eventType: "MessageSent", turn, phase: "diplomacy", participants: ["a", "b"],
      payload: { from: turn % 2 ? "a" : "b", to: turn % 2 ? "b" : "a", text: turn % 4 === 0 ? "I will send aid next turn" : "coordinating",
        promise: turn % 4 === 0, participant_label: turn % 4 === 0 ? "promise" : null, future_evaluable: turn % 4 === 0,
        relational_category: "cooperative_coordination" }});
    if ([5, 10, 15].includes(turn)) store.append({ eventType: "BattleResolved", turn, phase: "resolve", participants: ["a", "b"], payload: {
      schema_version: "1.0.0", battle_id: `battle-${turn}`, run_id: store.runId,
      turn_committed_ref: `commit-${turn}`, pre_resolution_state_ref: stateRef,
      participating_force_refs: [], terrain_ref: stateRef, supply_ref: stateRef,
      defensive_state_ref: stateRef, declared_action_refs: [], modifier_refs: [], rng_draw_refs: [],
      resolution_function_version: "synthetic-conformance-v1", outcome_ref: stateRef, canonical_event_refs: []
    }});
    if ([4, 5, 6].includes(turn)) store.append({ eventType: "WorldTransition", turn, phase: "resolve", participants: ["a"], payload: {
      schema_version: "1.0.0", run_id: store.runId, mechanic: "authorized_observation", action_ids: [], actor_ids: ["a"],
      before_state_ref: stateRef, after_state_ref: stateRef, detail: { mechanic_version: "synthetic-conformance-v1", ...(turn === 4 ? { new_polity_id: "b" } : {}) }
    }});
    if (turn === 4) {
      const researchBefore = store.putPayload({ technologies: [] }, "world_mechanic_input");
      const researchAfter = store.putPayload({ technologies: ["agronomy"] }, "world_mechanic_input");
      store.append({ eventType: "WorldTransition", turn, phase: "resolve", participants: ["a"], payload: {
        schema_version: "1.0.0", run_id: store.runId, mechanic: "research_outcome", action_ids: [], actor_ids: ["a"],
        before_state_ref: researchBefore, after_state_ref: researchAfter, detail: { progress: 1, mechanic_version: "synthetic-conformance-v1" }
      }});
    }
    for (const actorId of ["a", "b", "c"]) store.append({ eventType: "WorldTransition", turn, phase: "resolve", participants: [actorId], payload: {
      schema_version: "1.0.0", run_id: store.runId, mechanic: "economy", action_ids: [], actor_ids: [actorId],
      before_state_ref: stateRef, after_state_ref: stateRef,
      detail: { mechanic_version: "synthetic-conformance-v1", production: { food: 24, credits: 3, resources: {} }, consumption: 24, deficit: 0 }
    }});
    if ([5, 10].includes(turn) || turn === 6) {
      const transition = turn === 6 ? "demobilization" : "loss";
      const transitionEvent = store.append({ eventType: "PopulationUnitTransition", turn, phase: "resolve", participants: ["a"],
        causality: { causation_ids: transition === "demobilization" && lastLossEventId ? [lastLossEventId] : [] }, payload: {
        schema_version: "1.0.0", transition_id: `${transition}-${turn}`, run_id: store.runId, turn, transition,
        population_before_ref: stateRef, population_after_ref: stateRef, unit_before_refs: [stateRef], unit_after_refs: [stateRef],
        resource_input_refs: [stateRef], canonical_event_ref: store.nextEventId()
      }});
      if (transition === "loss") lastLossEventId = transitionEvent.event_id;
    }
    store.append({ eventType: "SnapshotCreated", turn, phase: "archive", payload: {
      run_id: store.runId, turn, state_ref: stateRef, state_hash: sha256(state), authoritative: true
    }});
    store.append({ eventType: "TurnResolved", turn, phase: "resolve", causality: { causation_ids: [commit.event_id] }, payload: {
      turn_committed_id: `commit-${turn}`, resulting_state_hash: sha256(state), authoritative_state_ref: stateRef,
      published_turn: turn + 1, published_phase: "actions"
    }});
    if (turn === 19) store.append({ eventType: "RunDisposition", turn, phase: "archive", payload: {
      schema_version: "1.0.0", run_id: store.runId, execution_status: "complete", evidence_validity: { canonical_record_accurate: true },
      experimental_validity: { confirmatory_eligible: false }, endpoint_eligibility: { primary_confirmatory: false },
      security_eligibility: { security_analysis_eligible: true }, exploratory_only: true,
      replacement_policy: { reason: "pilot_cap" }, evidence_completeness: { status: "complete" }
    }});
  }
  return store.bundle();
}

/** Injected execution adapter returning deterministic synthetic evidence, counting calls. */
export function syntheticAdapter(options = {}) {
  const adapter = {
    calls: 0,
    executor: async ({ seed, runtimeConfiguration } = {}) => {
      adapter.calls++;
      return syntheticCanonicalEvidence({ ...options, seed, runtimeConfiguration });
    }
  };
  return adapter;
}

/**
 * Deterministic Ed25519 attestation identity derived from a frozen seed. The key identifier
 * is the SPKI digest the calibration archive derives, so the identity is accepted as trust.
 */
export function syntheticAttestationKeys() {
  const seed = createHash("sha256").update(ATTESTATION_KEY_SEED).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { privateKey, publicKey, keyId };
}

/** Run `fn` against an isolated temporary archive root, always removing it afterwards. */
export async function withTempArchive(fn) {
  const directory = await mkdtemp(join(tmpdir(), "civilization-calibration-fixture-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
