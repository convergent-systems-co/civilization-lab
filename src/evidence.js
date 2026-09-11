import { createHash, createHmac } from "node:crypto";
import { clone, assert, canonicalize, EVENT_CATALOGUE_VERSION, EVENT_TYPES, PAYLOAD_SCHEMA_BY_EVENT, sha256, stableId } from "./core.js";
import { assertValidSchema } from "./schema.js";
import { replayMemoryOperation } from "./memory.js";

export function readEvidencePayload(store, ref) {
  const record = store.payloads.get(ref);
  assert(typeof ref === "string" && record && sha256(record.bytes) === ref,
    "missing or corrupt external input evidence: " + ref);
  const value = JSON.parse(record.bytes);
  assertCanonicalBase64Evidence(value);
  return value;
}

export function assertCanonicalBase64Evidence(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value.encoding === "base64") {
    assert(typeof value.data === "string", "base64 evidence data must be a string");
    const bytes = Buffer.from(value.data, "base64");
    assert(bytes.toString("base64") === value.data,
      "evidence labeled encoding=base64 must use canonical standard Base64");
    if (Object.hasOwn(value, "byte_length"))
      assert(Number.isSafeInteger(value.byte_length) && value.byte_length >= 0 && bytes.length === value.byte_length,
        "invalid raw evidence byte length");
    if (Object.hasOwn(value, "raw_sha256"))
      assert(value.raw_sha256 === createHash("sha256").update(bytes).digest("hex"), "raw evidence digest mismatch");
  }
  for (const child of Object.values(value)) assertCanonicalBase64Evidence(child, seen);
}

function verifyRaw(value) {
  if (value?.encoding !== "base64") return;
  assertCanonicalBase64Evidence(value);
  const bytes = Buffer.from(value.data, "base64");
  assert(bytes.length === value.byte_length, "invalid raw evidence encoding");
  // Hash the original bytes, including invalid UTF-8, without a text conversion.
  assert(value.raw_sha256 === createHash("sha256").update(bytes).digest("hex"), "raw evidence digest mismatch");
}

export function modelDiagnostic(store, event) {
  const diagnostics = event.provenance.input_refs.map(ref => readEvidencePayload(store, ref))
    .filter(value => value && typeof value === "object" && Object.hasOwn(value, "stage"));
  assert(diagnostics.length <= 1, "ambiguous invocation diagnostics");
  return diagnostics[0] ?? null;
}

function verifyModelReferences(store, event) {
  const p = event.payload;
  const refs = [p.rendered_input_ref, p.rendered_output_ref, p.model_runtime_hash, p.projection_ref,
    ...p.memory_refs, ...p.tool_result_refs, ...p.context_segments.map(segment => segment.content_ref), ...event.provenance.input_refs];
  if (p.action_ref !== null) refs.push(p.action_ref);
  for (const segment of p.context_segments) if (["trusted_instruction", "authorized_projection"].includes(segment.class)) refs.push(segment.source_ref);
  for (const ref of refs) verifyRaw(readEvidencePayload(store, ref));
  const diagnostic = modelDiagnostic(store, event);
  if (diagnostic) {
    assert(["dispatch", "complete"].includes(diagnostic.stage), "unknown invocation diagnostic stage");
    for (const field of ["request_ref", "response_ref", "parsed_output_ref", "configuration_ref", "runtime_attestation_ref", "artifact_attestation_ref"])
      if (diagnostic[field] != null) verifyRaw(readEvidencePayload(store, diagnostic[field]));
    if (diagnostic.configuration_ref != null) {
      assert(diagnostic.configuration_ref === event.provenance.configuration_hash, "invocation configuration binding mismatch");
      const config = readEvidencePayload(store, diagnostic.configuration_ref);
      assert(config.condition?.condition_id === p.condition_id && canonicalize(config.lineage) === canonicalize(diagnostic.lineage), "invocation condition/lineage configuration mismatch");
      if (diagnostic.lineage?.isolation_ref) {
        const proof = readEvidencePayload(store, diagnostic.lineage.isolation_ref);
        readEvidencePayload(store, proof.snapshot_ref); readEvidencePayload(store, proof.authorized_projection_ref);
      }
    }
    if (p.action_ref !== null) assert(diagnostic.stage === "complete" && diagnostic.classification === "success" &&
      diagnostic.parsed_output_ref === p.action_ref, "parsed action diagnostic binding mismatch");
  }
  const projection = readEvidencePayload(store, p.projection_ref);
  assert(projection.run_id === event.run_id && projection.logical_time?.turn === event.turn && projection.logical_time?.phase === event.phase &&
    event.participants.length === 1 && projection.principal?.principal_id === event.participants[0], "invocation projection principal/time mismatch");
  for (const [key, expected] of [["persistent_identity_ids", event.participants], ["session_ids", [p.session_id]], ["invocation_ids", [p.invocation_id]]])
    if (event.lineage[key].length) assert(canonicalize(event.lineage[key]) === canonicalize(expected), "invocation envelope lineage mismatch");
}

export class EvidenceStore {
  constructor(runId) {
    this.runId = runId;
    this.events = [];
    this.payloads = new Map();
    this.previousHash = null;
    this.signingSecret = `pilot0-evidence:${runId}`;
  }

  putPayload(payload, classification = "research") {
    assertCanonicalBase64Evidence(payload);
    const body = canonicalize(payload);
    const digest = sha256(body);
    this.payloads.set(digest, { digest, classification, bytes: body });
    return digest;
  }

  nextEventId() { return stableId("evt", this.runId, this.events.length); }

  append({ eventType, turn, phase, sequence = null, payload = {}, participants = [], visibility = {}, causality = {}, lineage = {}, provenance = {}, rng = null, source = "engine" }) {
    assert(EVENT_TYPES.has(eventType), `unknown event type: ${eventType}`);
    assert(!Object.hasOwn(payload, "payload_ref"), "payload_ref is reserved");
    const payloadSchemaRef = PAYLOAD_SCHEMA_BY_EVENT[eventType] ?? "generic-event-payload.schema.json";
    assertValidSchema(payload, payloadSchemaRef);
    const payloadRef = this.putPayload(payload);
    const event = {
      schema_version: "1.0.0",
      event_catalogue_version: EVENT_CATALOGUE_VERSION,
      event_id: this.nextEventId(),
      run_id: this.runId,
      turn,
      phase,
      sequence: this.events.length,
      event_type: eventType,
      event_type_version: "1.0.0",
      catalogue_entry_ref: `EVENT_CATALOGUE.spec.json#${eventType}`,
      payload_schema_ref: payloadSchemaRef,
      payload_schema_version: "1.0.0",
      payload: { payload_ref: payloadRef, ...clone(payload) },
      participants: [...participants].sort(),
      visibility: { classification: "private_research", acl_ref: visibility.acl_ref ?? "observer", encryption_ref: visibility.encryption_ref ?? "none", ...visibility },
      causality: { causation_ids: [...(causality.causation_ids ?? [])].sort(), correlation_id: causality.correlation_id ?? this.runId },
      lineage: { persistent_identity_ids: [...(lineage.persistent_identity_ids ?? [])].sort(), session_ids: [...(lineage.session_ids ?? [])].sort(), invocation_ids: [...(lineage.invocation_ids ?? [])].sort(), parent_event_ids: [...(lineage.parent_event_ids ?? [])].sort() },
      provenance: { source, operation: eventType, input_refs: [...(provenance.input_refs ?? [])].sort(), configuration_hash: provenance.configuration_hash ?? "pilot0-config", recorded_by: provenance.recorded_by ?? "canonical-event-store" },
      rng,
      integrity: { canonical_bytes_hash: null, previous_hash: this.previousHash, append_authority: "canonical-event-store" }
    };
    assertValidSchema(event, "canonical-event.schema.json");
    const unsigned = clone(event); unsigned.integrity.signature = null; event.integrity.signature = createHmac("sha256", this.signingSecret).update(canonicalize(unsigned)).digest("base64"); event.integrity.canonical_bytes_hash = sha256(event);
    this.previousHash = event.integrity.canonical_bytes_hash;
    this.events.push(event);
    return clone(event);
  }

  snapshot() { return clone(this.events); }

  verify() {
    for (const [ref, record] of this.payloads) {
      assert(typeof record?.bytes === "string" && record.digest === ref && sha256(record.bytes) === ref,
        "payload content address mismatch: " + ref);
      assertCanonicalBase64Evidence(JSON.parse(record.bytes));
    }
    let previous = null;
    const priorIds = new Set();
    const priorEvents = new Map();
    const memories = new Map();
    for (const event of this.events) {
      assert(event.run_id === this.runId, "event run mismatch");
      assert(event.sequence === priorIds.size && event.event_id === stableId("evt", this.runId, priorIds.size), "event order/identity mismatch");
      assert(event.event_catalogue_version === EVENT_CATALOGUE_VERSION && event.event_type_version === "1.0.0" && event.payload_schema_version === "1.0.0" && event.schema_version === "1.0.0", "unsupported evidence version");
      for (const id of [...event.causality.causation_ids, ...event.lineage.parent_event_ids]) assert(priorIds.has(id), `dangling or noncausal event reference: ${id}`);
      assert(event.integrity.previous_hash === previous, `event hash chain mismatch: ${event.event_id}`);
      const expected = event.integrity.canonical_bytes_hash;
      const copy = clone(event);
      copy.integrity.canonical_bytes_hash = null;
      assert(sha256(copy) === expected, `event digest mismatch: ${event.event_id}`);
      const unsigned = clone(event); const signature = unsigned.integrity.signature; unsigned.integrity.signature = null; unsigned.integrity.canonical_bytes_hash = null; const expectedSignature = createHmac("sha256", this.signingSecret).update(canonicalize(unsigned)).digest("base64"); assert(signature && signature === expectedSignature, `event signature mismatch: ${event.event_id}`);
      assert(EVENT_TYPES.has(event.event_type), `unknown event in evidence: ${event.event_type}`);
      assert(event.catalogue_entry_ref === `EVENT_CATALOGUE.spec.json#${event.event_type}`, "catalogue reference mismatch");
      assert(event.payload_schema_ref === (PAYLOAD_SCHEMA_BY_EVENT[event.event_type] ?? "generic-event-payload.schema.json"), "payload schema binding mismatch");
      const payloadRef = event.payload?.payload_ref;
      assert(typeof payloadRef === "string" && this.payloads.has(payloadRef), `missing payload evidence: ${event.event_id}`);
      assert(sha256(this.payloads.get(payloadRef).bytes) === payloadRef, `payload digest mismatch: ${event.event_id}`);
      const payload = clone(event.payload); delete payload.payload_ref;
      assert(canonicalize(payload) === this.payloads.get(payloadRef).bytes, `inline payload mismatch: ${event.event_id}`);
      if (payload.run_id !== undefined) assert(payload.run_id === this.runId, "payload run mismatch");
      const contentRefs = [];
      contentRefs.push(...event.provenance.input_refs);
      if (event.event_type === "WorldTransition") contentRefs.push(payload.before_state_ref, payload.after_state_ref);
      if (event.event_type === "PopulationUnitTransition") contentRefs.push(payload.population_before_ref, payload.population_after_ref,
        ...payload.unit_before_refs, ...payload.unit_after_refs, ...payload.resource_input_refs);
      if (event.event_type === "BehaviorCoded") contentRefs.push(payload.packet_ref, payload.mapping_ref, payload.codebook_ref, payload.coder.rules_ref, ...(payload.coder.prompt_ref ? [payload.coder.prompt_ref] : []));
      if (event.event_type === "MemoryOperation") contentRefs.push(...payload.input_refs, payload.output_ref, payload.availability_ref);
      if (event.event_type === "ModelInvocation") verifyModelReferences(this, event);
      if (event.event_type === "InterviewResponse") {
        contentRefs.push(payload.projection_ref, payload.response_payload_ref, payload.isolation_proof_ref);
        const isolation = this.payloads.get(payload.isolation_proof_ref);
        if (isolation && sha256(isolation.bytes) === payload.isolation_proof_ref) {
          const proof = JSON.parse(isolation.bytes);
          contentRefs.push(proof.snapshot_ref, proof.authorized_projection_ref);
        }
      }
      if (event.event_type === "SecurityIncident") {
        const first = priorEvents.get(payload.first_affected_event), last = priorEvents.get(payload.last_affected_event);
        assert(first?.run_id === this.runId && last?.run_id === this.runId && first.sequence <= last.sequence,
          "security incident affected-event scope must resolve in same-run order");
        const securityRefs = [payload.detector_ref, ...payload.evidence_refs];
        assert(securityRefs.every(ref => event.provenance.input_refs.includes(ref)),
          "security incident evidence is absent from canonical provenance");
        contentRefs.push(...securityRefs);
        if (Array.isArray(payload.exposure_scope?.event_ids)) for (const id of payload.exposure_scope.event_ids) {
          const affected = priorEvents.get(id);
          assert(affected?.run_id === this.runId && affected.sequence >= first.sequence && affected.sequence <= last.sequence,
            "security incident exposure event is outside the affected same-run range");
        }
      }
      for (const ref of contentRefs) {
        const record = this.payloads.get(ref);
        assert(record && sha256(record.bytes) === ref, "missing or corrupt external input evidence: " + ref);
      }
      if (payload.canonical_event_ref !== undefined) assert(payload.canonical_event_ref === event.event_id, "incorrect transition event reference");
      if (payload.commit_event_id !== undefined) assert(payload.commit_event_id === event.event_id, "incorrect committed event reference");
      for (const ref of [...(payload.canonical_event_refs ?? []), ...(payload.transition_event_refs ?? []), ...(payload.outcome_event_ids ?? [])]) assert(ref === event.event_id || priorIds.has(ref), "dangling transition/battle/outcome reference");
      if(event.event_type==='WorldTransition'&&payload.mechanic==='closed_conquest_cycle') {
        assertValidSchema(payload.detail,'closed-conquest-cycle-detail.schema.json');
        const members=new Set(payload.detail.cycle_members),allowed=new Set(['TerritoryTransition','PopulationUnitTransition','WorldTransition']);
        assert(new Set(payload.detail.asset_transition_event_ids).size===payload.detail.asset_transition_event_ids.length,
          'duplicate cyclic estate transition reference');
        const estateBefore=readEvidencePayload(this,payload.before_state_ref),resourceOwners=new Set(),physicalResourceHexes=new Set();
        for(const ref of payload.detail.asset_transition_event_ids){
          const target=this.events.find(candidate=>candidate.event_id===ref);
          assert(target&&priorIds.has(ref)&&target.run_id===this.runId&&allowed.has(target.event_type),'invalid cyclic estate transition reference');
          if(target.event_type==='PopulationUnitTransition')assert(target.payload.transition==='estate_disposition','incorrect cyclic population/unit transition reference');
          if(target.event_type==='WorldTransition'){
            assert(['facility_unclaimed','resource_extinguishment'].includes(target.payload.mechanic),'incorrect cyclic world transition reference');
            if(target.payload.mechanic==='resource_extinguishment'){
              const detail=target.payload.detail,actor=target.participants[0],before=readEvidencePayload(this,target.payload.before_state_ref);
              assert(target.participants.length===1&&members.has(actor)&&detail.former_owner_id===actor&&!resourceOwners.has(actor),'invalid cyclic resource disposition owner');
              assert(Array.isArray(detail.territory_ids)&&detail.territory_ids.every(id=>estateBefore.territories[id]?.owner_id===actor),'cyclic resource disposition crosses former ownership');
              assert(Array.isArray(detail.physical_resource_hex_ids)&&canonicalize(Object.keys(before.physically_located).sort())===canonicalize([...detail.physical_resource_hex_ids].sort()),'cyclic resource disposition hex scope mismatch');
              for(const hexId of detail.physical_resource_hex_ids){assert(!physicalResourceHexes.has(hexId),'physical resource hex attributed to multiple cyclic estates');physicalResourceHexes.add(hexId);}
              resourceOwners.add(actor);
            }
          }
          assert(target.participants.some(id=>members.has(id)),'cyclic estate transition does not concern a cycle member');
          assert(event.causality.causation_ids.includes(ref),'cyclic estate transition is not a canonical causal predecessor');
        }
        assert(resourceOwners.size===members.size&&[...members].every(id=>resourceOwners.has(id)),'cyclic resource disposition is incomplete');
        const eliminated=new Set();
        for(const ref of payload.detail.elimination_event_ids){
          const target=this.events.find(candidate=>candidate.event_id===ref),actor=target?.participants?.[0];
          assert(target&&priorIds.has(ref)&&target.run_id===this.runId&&target.event_type==='WorldTransition'&&target.payload.mechanic==='polity_elimination','invalid cyclic polity elimination reference');
          assert(target.participants.length===1&&members.has(actor)&&!eliminated.has(actor)&&target.payload.detail.decision?.eliminate===true&&target.payload.detail.decision?.conquered===true,'incorrect cyclic polity elimination reference');
          assert(event.causality.causation_ids.includes(ref),'cyclic elimination is not a canonical causal predecessor');
          eliminated.add(actor);
        }
        assert(eliminated.size===members.size&&[...members].every(id=>eliminated.has(id)),'cyclic polity elimination references are incomplete');
        assert(payload.detail.elimination_predicates.length===members.size&&payload.detail.elimination_predicates.every(item=>members.has(item.polity_id)&&item.eliminate===true&&item.conquered===true),'cyclic elimination predicate mismatch');
      }
      if (event.event_type === "SnapshotCreated") {
        const stateRecord = this.payloads.get(payload.state_ref);
        assert(stateRecord && sha256(stateRecord.bytes) === payload.state_hash, "snapshot content mismatch");
        assert(JSON.parse(stateRecord.bytes).run_id === this.runId, "cross-run snapshot reference");
      }
      if (event.event_type === "TurnResolved" && payload.authoritative_state_ref !== undefined) {
        const stateRecord = this.payloads.get(payload.authoritative_state_ref);
        assert(stateRecord && sha256(stateRecord.bytes) === payload.resulting_state_hash,
          "resolved authoritative state content mismatch");
        const resolvedState = JSON.parse(stateRecord.bytes);
        assert(resolvedState.run_id === this.runId && resolvedState.turn === payload.published_turn &&
          resolvedState.phase === payload.published_phase, "resolved published lifecycle mismatch");
      }
      assertValidSchema(payload, event.payload_schema_ref);
      assertValidSchema(event, "canonical-event.schema.json");
      if (event.event_type === "MemoryOperation") memories.set(payload.identity_ref,
        replayMemoryOperation(this, event, memories.get(payload.identity_ref)));
      previous = expected;
      priorIds.add(event.event_id);
      priorEvents.set(event.event_id, event);
    }
    return true;
  }

  bundle() { return { run_id: this.runId, events: this.snapshot(), payloads: Object.fromEntries(this.payloads) }; }
}

export function loadEvidence(bundle) {
  assert(bundle?.run_id, "evidence bundle requires run_id");
  const store = new EvidenceStore(bundle.run_id);
  store.events = clone(bundle.events); store.payloads = new Map(Object.entries(clone(bundle.payloads)));
  store.previousHash = store.events.at(-1)?.integrity.canonical_bytes_hash ?? null;
  store.verify(); return store;
}

export function evidenceManifest(store) {
  store.verify();
  return { run_id: store.runId, event_count: store.events.length, head_hash: store.previousHash, payload_count: store.payloads.size, authoritative: true };
}
