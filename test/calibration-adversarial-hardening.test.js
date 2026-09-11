import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { canonicalize, sha256 } from "../src/core.js";
import { EvidenceStore, loadEvidence } from "../src/evidence.js";
import {
  CalibrationArchive,
  collectCalibrationObservations,
  verifyAdapterExecutionReceipt
} from "../src/calibration-runner.js";
import {
  aggregateCalibrationSelectionView,
  assessCalibrationCandidate,
  calibrationProtocol,
  selectCalibrationCandidate
} from "../src/calibration.js";
import {
  syntheticAttestationKeys,
  syntheticCanonicalEvidence,
  withTempArchive
} from "./helpers/calibration-fixture.js";

const protocol = calibrationProtocol();
const implementationCommit = "8f06baae4cda7d6fbd9d61924b5c615f4a45ba59";

async function initializedArchive(directory, trust = syntheticAttestationKeys()) {
  return new CalibrationArchive(directory, trust).initialize({
    protocolVersion: protocol.protocol_version,
    implementationCommit,
    executionMode: "SYNTHETIC_CONFORMANCE"
  });
}

test("exact trusted final head rejects a valid appended generation", async () => {
  await withTempArchive(async directory => {
    const trust = syntheticAttestationKeys();
    const archive = await initializedArchive(directory, trust);
    const retainedFinalHead = structuredClone(archive.head);

    await archive.update(state => ({ ...state, status: "RUNNING" }));

    await assert.rejects(
      () => CalibrationArchive.open(directory, {
        ...trust,
        trustedHead: retainedFinalHead,
        exactTrustedHead: true
      }),
      /extends beyond externally retained final head/
    );
  });
});

test("archive rejects nested orphan files and an unsigned results directory", async t => {
  await t.test("nested orphan under attempts", async () => {
    await withTempArchive(async directory => {
      const trust = syntheticAttestationKeys();
      await initializedArchive(directory, trust);
      await mkdir(`${directory}/attempts/orphan/deep`, { recursive: true });
      await writeFile(`${directory}/attempts/orphan/deep/forged.json`, "{}\n");
      await assert.rejects(() => CalibrationArchive.open(directory, trust), /orphan|missing retained attempt/);
    });
  });

  await t.test("legacy or attacker-created results directory", async () => {
    await withTempArchive(async directory => {
      const trust = syntheticAttestationKeys();
      await initializedArchive(directory, trust);
      await mkdir(`${directory}/results`);
      await assert.rejects(() => CalibrationArchive.open(directory, trust), /results directory is forbidden/);
    });
  });
});

function appendExistingEvent(store, event) {
  const { payload_ref: _payloadRef, ...payload } = event.payload;
  return store.append({
    eventType: event.event_type,
    turn: event.turn,
    phase: event.phase,
    payload,
    participants: event.participants,
    visibility: event.visibility,
    causality: event.causality,
    lineage: event.lineage,
    provenance: event.provenance,
    rng: event.rng,
    source: event.provenance.source
  });
}

function syntheticEvidenceWithModelInvocation() {
  const source = loadEvidence(syntheticCanonicalEvidence());
  const rebuilt = new EvidenceStore(source.runId);
  for (const record of source.payloads.values())
    rebuilt.putPayload(JSON.parse(record.bytes), record.classification);

  const terminal = source.events.at(-1);
  assert.equal(terminal.event_type, "RunDisposition");
  for (const event of source.events.slice(0, -1)) appendExistingEvent(rebuilt, event);

  const inputRef = rebuilt.putPayload("synthetic input", "model_input");
  const outputRef = rebuilt.putPayload("synthetic output", "model_output");
  const runtimeRef = rebuilt.putPayload({ synthetic: true }, "model_runtime_manifest");
  const projectionRef = rebuilt.putPayload({
    run_id: rebuilt.runId,
    logical_time: { turn: 19, phase: "archive" },
    principal: { principal_id: "a" }
  }, "authorized_projection");
  rebuilt.append({
    eventType: "ModelInvocation",
    turn: 19,
    phase: "archive",
    participants: ["a"],
    payload: {
      schema_version: "1.0.0",
      invocation_id: "synthetic-calibration-model-invocation",
      session_id: "synthetic-calibration-session",
      run_id: rebuilt.runId,
      condition_id: "neutral-calibration-policy",
      context_segments: [],
      rendered_input_ref: inputRef,
      rendered_output_ref: outputRef,
      model_runtime_hash: runtimeRef,
      parser_hash: "synthetic-parser",
      projection_ref: projectionRef,
      memory_refs: [],
      tool_result_refs: [],
      action_ref: null,
      attempt: 1,
      retry_of: null
    },
    lineage: {
      persistent_identity_ids: ["a"],
      session_ids: ["synthetic-calibration-session"],
      invocation_ids: ["synthetic-calibration-model-invocation"]
    }
  });
  appendExistingEvent(rebuilt, terminal);
  return rebuilt.bundle();
}

test("synthetic conformance rejects canonical ModelInvocation evidence", () => {
  const bundle = syntheticEvidenceWithModelInvocation();
  assert.throws(
    () => collectCalibrationObservations(bundle, { mode: "SYNTHETIC_CONFORMANCE" }),
    /model invocation|blinding|condition_id/i
  );
});

for (const [name, leaked] of [
  ["camelCase treatment keys", { treatmentArm: "masked" }],
  ["text-bearing base64 envelopes", { encoding: "base64", data: Buffer.from(JSON.stringify({ cohort: "persistent_arm" })).toString("base64") }],
  ["nested base64 without an envelope", Buffer.from(Buffer.from("persistent_arm").toString("base64")).toString("base64")],
  ["hex without an envelope", Buffer.from("nonpersistent_arm").toString("hex")],
  ["encoded payload hidden under an opaque field", { opaquePayload: Buffer.from("treatmentArm").toString("base64") }],
  ["untyped encoded envelope", { encoding: "gzip", data: Buffer.from("persistent_arm").toString("base64") }],
  ["encoding nesting beyond the inspection bound", Array.from({ length: 5 }).reduce(value => Buffer.from(value).toString("base64"), "persistent_arm")]
]) test(`treatment blindness rejects ${name} in dereferenced canonical payloads`, () => {
  const store = loadEvidence(syntheticCanonicalEvidence());
  store.putPayload(leaked, "model_input");
  assert.throws(() => collectCalibrationObservations(store.bundle(), { mode: "SYNTHETIC_CONFORMANCE" }), /blinding|encoded/i);
});

function observedFact(value = 0) {
  return {
    status: "OBSERVED",
    value,
    scaled_value: String(Math.round(value * protocol.metric_numeric_policy.scale)),
    numerator: "0",
    denominator: "1",
    eligibility_count: "1"
  };
}

test("dominant action share pools category counts rather than averaging seed maxima", () => {
  const candidate = "a".repeat(64);
  const view = protocol.seed_panel.seeds.map((seed, index) => ({
    candidate_alias: candidate,
    opaque_seed_alias: `seed-${index}`,
    opaque_run_alias: `run-${index}`,
    disposition: "COMPLETE",
    metrics: Object.fromEntries(protocol.metrics.map(metric => [metric.metric_id, observedFact()]))
  }));
  view[0].metrics["conflict.dominant_action_share"] = {
    ...observedFact(1), numerator: "9", denominator: "9", eligibility_count: "9", category_counts: { move: 9 }
  };
  for (const row of view.slice(1)) row.metrics["conflict.dominant_action_share"] = {
    ...observedFact(1), numerator: "1", denominator: "1", eligibility_count: "1", category_counts: { attack: 1 }
  };

  const result = aggregateCalibrationSelectionView(view, protocol);
  assert.equal(result.aggregate_metrics["conflict.dominant_action_share"], 0.71875);
  assert.notEqual(result.aggregate_metrics["conflict.dominant_action_share"], 1,
    "mean-of-seed maxima would conceal the pooled action distribution");
});

function aggregateAtAcceptedBoundaries() {
  return Object.fromEntries(protocol.metrics.map(metric => [
    metric.metric_id,
    metric.acceptance.minimum ?? metric.acceptance.maximum
  ]));
}

test("a candidate with a null required metric cannot displace an accepted incumbent", () => {
  const incumbentMetrics = aggregateAtAcceptedBoundaries();
  const incumbent = assessCalibrationCandidate({
    parameter_set_hash: "1".repeat(64),
    seed_ids: protocol.seed_panel.seeds,
    aggregate_metrics: incumbentMetrics
  });
  assert.equal(incumbent.accepted, true);

  const missingMetrics = structuredClone(incumbentMetrics);
  const missingMetricId = protocol.metrics[0].metric_id;
  missingMetrics[missingMetricId] = null;
  const incomplete = assessCalibrationCandidate({
    parameter_set_hash: "2".repeat(64),
    seed_ids: protocol.seed_panel.seeds,
    aggregate_metrics: missingMetrics,
    aggregate_status: {
      [missingMetricId]: { observed: 23, zero_opportunity: 0, censored: 1, unevaluable: 0 }
    }
  });
  assert.equal(incomplete.accepted, false);
  assert.equal(selectCalibrationCandidate([incomplete, incumbent]).parameter_set_hash, incumbent.parameter_set_hash);
});

test("execution receipt is bound to the immutable archived request hash", () => {
  const bundle = syntheticCanonicalEvidence();
  const signer = generateKeyPairSync("ed25519");
  const authority = {
    headPublicKey: signer.publicKey.export({ type: "spki", format: "pem" }),
    policyManifestHash: "a".repeat(64),
    adapterHash: "b".repeat(64),
    executableHash: "c".repeat(64)
  };
  const executionRequest = {
    schema_version: "phase-a-execution-request-1.0.0",
    seed: protocol.seed_panel.seeds[0],
    runtime_configuration: { parameter_set_hash: "d".repeat(64) }
  };
  const context = {
    expected_seed: executionRequest.seed,
    expected_parameter_set_hash: executionRequest.runtime_configuration.parameter_set_hash,
    execution_request: structuredClone(executionRequest),
    execution_request_hash: sha256(executionRequest),
    adapter_package_digest: authority.executableHash
  };
  const body = {
    version: "phase-a-adapter-execution-receipt-1.0.0",
    mode: "EMPIRICAL_CALIBRATION",
    run_id: bundle.run_id,
    seed: context.expected_seed,
    parameter_set_hash: context.expected_parameter_set_hash,
    execution_request_hash: context.execution_request_hash,
    policy_manifest_hash: authority.policyManifestHash,
    adapter_hash: authority.adapterHash,
    adapter_executable_hash: authority.executableHash,
    adapter_package_digest: authority.executableHash,
    evidence_hash: sha256(bundle)
  };
  context.adapter_execution_receipt = {
    body,
    signature: sign(null, Buffer.from(canonicalize(body)), signer.privateKey).toString("base64")
  };

  assert.doesNotThrow(() => verifyAdapterExecutionReceipt(bundle, context, authority));

  const requestMutatedAfterReceipt = structuredClone(context);
  requestMutatedAfterReceipt.execution_request.runtime_configuration.parameter_set_hash = "e".repeat(64);
  assert.throws(
    () => verifyAdapterExecutionReceipt(bundle, requestMutatedAfterReceipt, authority),
    /request\/hash mismatch/
  );

  const rehashedWithoutNewReceipt = structuredClone(context);
  rehashedWithoutNewReceipt.execution_request.runtime_configuration.parameter_set_hash = "e".repeat(64);
  rehashedWithoutNewReceipt.execution_request_hash = sha256(rehashedWithoutNewReceipt.execution_request);
  assert.throws(
    () => verifyAdapterExecutionReceipt(bundle, rehashedWithoutNewReceipt, authority),
    /receipt binding mismatch/
  );
});
