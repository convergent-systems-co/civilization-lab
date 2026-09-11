import { nowIso, assert, sha256, stableId, clone, canonicalize } from "./core.js";
import { assertValidSchema } from "./schema.js";

// Purge scanning accepts both standard and URL-safe alphabets, with or without
// canonical padding. Ingestion still accepts only canonical standard Base64.
function defensiveBase64Bytes(data) {
  if (typeof data !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) return null;
  const body = data.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const normalizedBody = body.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = normalizedBody + "=".repeat((4 - normalizedBody.length % 4) % 4);
  const bytes = Buffer.from(normalized, "base64");
  return bytes.toString("base64").replace(/=+$/, "") === normalizedBody ? bytes : null;
}

export function recordSecurityIncident(store, { breachType, exposureScope, detectorRef, firstAffectedEvent, lastAffectedEvent, runDispositionRef, evidenceRefs = [] }) {
  assert(store?.runId && breachType && detectorRef && firstAffectedEvent && lastAffectedEvent && runDispositionRef, "incomplete security incident");
  const events = new Map(store.events.map(event => [event.event_id, event]));
  const first = events.get(firstAffectedEvent), last = events.get(lastAffectedEvent);
  assert(first?.run_id === store.runId && last?.run_id === store.runId && first.sequence <= last.sequence,
    "security incident affected-event scope must resolve in same-run order");
  for (const ref of [detectorRef, ...evidenceRefs]) {
    const record = store.payloads.get(ref);
    assert(record && record.digest === ref && sha256(record.bytes) === ref,
      "security incident evidence reference must resolve in the same run: " + ref);
  }
  const payload = { schema_version: "1.0.0", incident_id: stableId("incident", store.runId, breachType, firstAffectedEvent, lastAffectedEvent), run_id: store.runId, logical_time: { turn: store.events.at(-1)?.turn ?? 0, phase: "security" }, detector_ref: detectorRef, breach_type: breachType, exposure_scope: exposureScope ?? { classification: "unknown" }, first_affected_event: firstAffectedEvent ?? "none", last_affected_event: lastAffectedEvent ?? "none", containment: { status: "recorded", action: "preserve_evidence" }, run_disposition_ref: runDispositionRef, analytical_eligibility: { security_analysis_eligible: true, confirmatory_eligible: false, policy_ref: "BREACH_POLICY.spec.json" }, evidence_refs: [...evidenceRefs].sort() };
  assertValidSchema(payload, "security-incident.schema.json");
  return store.append({ eventType: "SecurityIncident", turn: payload.logical_time.turn, phase: "security", payload,
    provenance: { input_refs: [...new Set([detectorRef, ...evidenceRefs])].sort() }, source: "security_monitor" });
}

export function recordRedaction(store, { artifactRef, fieldOrRange, dataClass, reason, authority, effectiveLogicalTime, affectedDerivations = [], completenessImpact }) {
  assert(store?.runId && artifactRef && fieldOrRange && reason && authority, "incomplete redaction request");
  const original = store.payloads.get(artifactRef); assert(original, "redaction artifact is not present");
  const payload = { schema_version: "1.0.0", tombstone_id: stableId("tombstone", store.runId, artifactRef, fieldOrRange), artifact_ref: artifactRef, field_or_range: fieldOrRange, pre_redaction_digest: sha256(original.bytes), data_class: dataClass ?? original.classification, reason, authority, recorded_at: nowIso(), effective_logical_time: effectiveLogicalTime ?? { turn: store.events.at(-1)?.turn ?? 0, phase: "security" }, replay_behavior: { participant_view: "redacted", authorized_research_view: "metadata_only", analysis_status: "affected_by_redaction", incomplete_status: "REPLAY_INCOMPLETE_REDACTED" }, affected_derivations: [...affectedDerivations].sort(), completeness_impact: completenessImpact ?? { analysis_artifacts: [], claim_eligibility: "evaluate_under_preregistered_policy", replacement_or_exclusion_rule: "record_and_classify" } };
  assertValidSchema(payload, "redaction-tombstone.schema.json");
  return store.append({ eventType: "RedactionTombstone", turn: payload.effective_logical_time.turn ?? 0, phase: "security", payload });
}

// Decode the representations used by the raw evidence contract. JSON strings
// may themselves contain JSON requests or the DATA section of a rendered prompt.
// Visit object keys as well: participant text can also be used as a map key.
function evidenceStrings(value, visit, seen = new Set()) {
  if (typeof value === "string") {
    if (seen.has(value)) return;
    seen.add(value); visit(value);
    let decoded;
    try { decoded = JSON.parse(value); } catch { /* ordinary text */ }
    if (decoded !== undefined && decoded !== value) evidenceStrings(decoded, visit, seen);
    const start = value.indexOf("\nDATA="), end = value.lastIndexOf("\nCONTINUATION");
    if (start >= 0 && end > start) evidenceStrings(value.slice(start + 6, end), visit, seen);
  } else if (value && typeof value === "object") {
    if (value.encoding === "base64" && typeof value.data === "string") {
      const bytes = defensiveBase64Bytes(value.data);
      if (bytes) evidenceStrings(bytes.toString("utf8"), visit, seen);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(value)) visit(key);
      evidenceStrings(child, visit, seen);
    }
  }
}

// Directed provenance, independent of storage classification or textual
// similarity. A context taints its generated artifacts, never unrelated shared
// instructions/runtime manifests. Dispatch/completion records share invocation
// identity, so all recorded representations of an attempt are covered.
function redactionDependencies(bundle, payloads) {
  const edges = new Map(), invocations = new Map(), memoryOrigins = new Map();
  const eventsById = new Map(bundle.events.map(event => [event.event_id, event]));
  const refs = values => values.filter(ref => {
    if (typeof ref !== "string" || !payloads.has(ref)) return false;
    const payload = payloads.get(ref);
    // Pending attempts all address the same empty output. It carries no private
    // bytes and must not connect otherwise independent invocation histories.
    return !(payload?.encoding === "base64" && payload.data === "");
  });
  function link(sources, derivatives) {
    for (const source of refs(sources)) {
      if (!edges.has(source)) edges.set(source, new Set());
      for (const target of refs(derivatives)) if (source !== target) edges.get(source).add(target);
    }
  }
  // Isolated interviews and retries need not perform a fresh MemoryOperation
  // read. Bind their record source IDs AND exact text to archived memory states.
  for (const event of bundle.events) {
    if (event.event_type !== "MemoryOperation" || event.payload.redacted) continue;
    for (const ref of refs([...(event.payload.input_refs ?? []), event.payload.output_ref])) {
      for (const record of payloads.get(ref)?.records ?? []) {
        if (typeof record.id !== "string" || typeof record.text !== "string") continue;
        const key = JSON.stringify([record.id, sha256(record.text)]);
        if (!memoryOrigins.has(key)) memoryOrigins.set(key, new Set());
        memoryOrigins.get(key).add(ref);
      }
    }
  }
  for (const event of bundle.events) {
    if (event.event_type !== "ModelInvocation" || event.payload.redacted) continue;
    const p = event.payload, key = JSON.stringify([event.run_id, p.session_id, p.invocation_id]);
    if (!invocations.has(key)) invocations.set(key, { sources: [], memory: [], inputs: [], outputs: [] });
    const group = invocations.get(key);
    group.memory.push(...(p.memory_refs ?? []));
    group.sources.push(p.projection_ref, ...(p.memory_refs ?? []), ...(p.tool_result_refs ?? []),
      ...(p.context_segments ?? []).flatMap(segment => [segment.content_ref, segment.source_ref]));
    for (const segment of p.context_segments ?? []) {
      link([segment.source_ref], [segment.content_ref]);
      if (segment.class !== "memory_record") continue;
      const raw = payloads.get(segment.content_ref);
      const text = raw?.encoding === "base64" ? Buffer.from(raw.data, "base64").toString("utf8") : raw;
      if (typeof text === "string") link([...(memoryOrigins.get(JSON.stringify([segment.source_ref, sha256(text)])) ?? [])], [segment.content_ref]);
    }
    group.inputs.push(p.rendered_input_ref);
    group.outputs.push(p.rendered_output_ref, p.action_ref);
    for (const ref of event.provenance?.input_refs ?? []) {
      const diagnostic = payloads.get(ref);
      if (!diagnostic || !["dispatch", "complete"].includes(diagnostic.stage)) continue;
      group.inputs.push(diagnostic.request_ref);
      group.outputs.push(diagnostic.response_ref, diagnostic.parsed_output_ref);
    }
  }
  for (const group of invocations.values()) {
    link(group.sources, group.inputs);
    link(group.inputs, [...group.inputs, ...group.outputs]);
    link(group.outputs, group.outputs);
  }
  for (const event of bundle.events) {
    const p = event.payload;
    if (p.redacted) continue;
    const eventPayload=p.payload_ref;
    const parentPayloads=[...(event.causality?.causation_ids??[]),...(event.lineage?.parent_event_ids??[])]
      .map(id=>eventsById.get(id)?.payload?.payload_ref).filter(Boolean);
    const provenance=[...(event.provenance?.input_refs??[])];
    // Canonical event payloads and state outputs are derivatives of their
    // declared inputs even when the protected value is numeric/boolean/null.
    // Text scanning is only defense in depth; provenance drives the purge.
    // SecurityIncident is canonical audit metadata about already-recorded scope,
    // not a content derivative of the evidence it names. Its fields are still
    // subjected to the text and byte scans below.
    if (event.event_type !== "SecurityIncident") link([...parentPayloads,...provenance],[eventPayload]);
    if(event.event_type==='WorldTransition'){
      link([p.before_state_ref,...provenance,...parentPayloads],[eventPayload,p.after_state_ref]);
      link([eventPayload],[p.after_state_ref]);
      if(p.mechanic==='closed_conquest_cycle'){
        const assets=(p.detail?.asset_transition_event_ids??[]).map(id=>eventsById.get(id)?.payload?.payload_ref).filter(Boolean);
        link(assets,[eventPayload,p.after_state_ref]);
      }
    }
    if(event.event_type==='PopulationUnitTransition'){
      const before=[p.population_before_ref,...(p.unit_before_refs??[]),...(p.resource_input_refs??[]),...provenance,...parentPayloads];
      const after=[p.population_after_ref,...(p.unit_after_refs??[])];
      link(before,[eventPayload,...after]);link([eventPayload],after);
    }
    if(event.event_type==='BattleResolved'){
      const before=[p.pre_resolution_state_ref,...(p.participating_force_refs??[]),p.terrain_ref,p.supply_ref,p.defensive_state_ref,...(p.declared_action_refs??[]),...(p.modifier_refs??[]),...(p.rng_draw_refs??[]),...provenance,...parentPayloads];
      link(before,[eventPayload,p.outcome_ref]);link([eventPayload],[p.outcome_ref]);
    }
    if(event.event_type==='SnapshotCreated'){
      // Reducer snapshots are authoritative derivatives of every same-turn world
      // transition, including the final cycle join. The raw reducer snapshot is
      // intentionally emitted without an event-causality edge, so recover that
      // content dependency from canonical sequence and logical time.
      const worldOutputs=bundle.events.filter(candidate=>candidate.sequence<event.sequence&&candidate.turn===event.turn&&
        candidate.event_type==='WorldTransition'&&!candidate.payload.redacted)
        .flatMap(candidate=>[candidate.payload.payload_ref,candidate.payload.after_state_ref]);
      link([...worldOutputs,...parentPayloads,p.memory_archive_ref].filter(Boolean),[eventPayload,p.state_ref]);
      link([eventPayload],[p.state_ref]);
    }
    if (event.event_type === "MemoryOperation") {
      link([...(p.input_refs ?? []), p.availability_ref], [p.output_ref]);
      if (p.operation === "read") {
        const group = invocations.get(JSON.stringify([event.run_id, p.session_ref, p.invocation_ref]));
        if (group) link([p.output_ref, p.availability_ref], [...group.memory, ...group.inputs]);
      }
    } else if (event.event_type === "InterviewResponse") {
      link([p.projection_ref, p.isolation_proof_ref], [p.response_payload_ref]);
    }
  }
  return edges;
}

// Produces an explicitly incomplete derivative. Original hashes and canonical
// tombstones survive; replaced event payloads are never re-signed as raw events.
// Archive authorization happens before this pure transformation is called.
export function redactBundle(bundle) {
  const result = clone(bundle);
  const tombstones = result.events.filter(event => event.event_type === "RedactionTombstone");
  assert(tombstones.length > 0, "redaction requires canonical tombstones");
  const protectedRefs = new Set(tombstones.map(event => event.payload.payload_ref));
  const auditMetadataRefs = new Set(result.events.filter(event => event.event_type === "SecurityIncident")
    .map(event => event.payload.payload_ref));
  const removed = new Set(result.removed_payload_refs ?? []), needles = new Set(), rawNeedles = new Map(), pairNeedles=[];
  const payloads = new Map(Object.entries(result.payloads).map(([ref, payload]) => [ref, JSON.parse(payload.bytes)]));
  const dependencies = redactionDependencies(result, payloads);
  const addRawNeedle = bytes => { if (bytes.length) rawNeedles.set(bytes.toString("hex"), bytes); };
  function decodedEvidenceBytes(value, visit, seen = new Set()) {
    if (typeof value === "string") {
      visit(Buffer.from(value, "utf8"));
      if (seen.has(value)) return;
      seen.add(value);
      let decoded;
      try { decoded = JSON.parse(value); } catch { /* ordinary text */ }
      if (decoded !== undefined && decoded !== value) decodedEvidenceBytes(decoded, visit, seen);
      const start = value.indexOf("\nDATA="), end = value.lastIndexOf("\nCONTINUATION");
      if (start >= 0 && end > start) decodedEvidenceBytes(value.slice(start + 6, end), visit, seen);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.encoding === "base64" && typeof value.data === "string") {
      const bytes = defensiveBase64Bytes(value.data);
      if (bytes) visit(bytes);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(value)) visit(Buffer.from(key, "utf8"));
      decodedEvidenceBytes(child, visit, seen);
    }
  }
  const containsRawNeedle = value => {
    let matched = false;
    decodedEvidenceBytes(value, bytes => {
      if (!matched && [...rawNeedles.values()].some(needle => bytes.indexOf(needle) >= 0)) matched = true;
    });
    return matched;
  };
  function strings(value) {
    // Field names are structure, not redaction targets. Keep the entire selected
    // string as the target; decoding copies happens when examining artifacts.
    if (typeof value === "string" && value.length) { needles.add(value); addRawNeedle(Buffer.from(value, "utf8")); }
    else if (value?.encoding === "base64" && typeof value.data === "string") {
      const bytes = defensiveBase64Bytes(value.data);
      if (bytes) strings(bytes.toString("utf8"));
    }
    else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child);
  }
  for (const event of tombstones) {
    const t = event.payload;
    const raw = result.payloads[t.artifact_ref];
    for (const ref of t.affected_derivations) {
      assert(result.payloads[ref] || removed.has(ref), "redaction derivative must identify a content-addressed artifact"); removed.add(ref);
    }
    if (!raw && removed.has(t.artifact_ref)) continue; // authenticated earlier tombstone
    assert(raw && sha256(raw.bytes) === t.pre_redaction_digest, "tombstone original digest mismatch");
    removed.add(t.artifact_ref);
    const parsed = JSON.parse(raw.bytes);
    if (["*", "/", "$"].includes(t.field_or_range)) strings(parsed);
    else {
      const path = t.field_or_range.startsWith("/")
        ? t.field_or_range.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"))
        : t.field_or_range.replace(/^\$\./, "").split(".");
      let field = parsed, parent = null;
      for (const key of path) { assert(field && Object.hasOwn(field, key), "redaction field is absent"); parent = field; field = field[key]; }
      pairNeedles.push({key:path.at(-1),value:canonicalize(field)});
      strings(field);
      if (path.at(-1) === "data" && parent?.encoding === "base64" && typeof field === "string") {
        const bytes = defensiveBase64Bytes(field);
        assert(bytes, "redaction raw evidence encoding is invalid");
        addRawNeedle(bytes);
      }
    }
  }
  const decodedStrings = new Map();
  for (const [ref, payload] of payloads) {
    const values = new Set(); evidenceStrings(payload, value => values.add(value)); decodedStrings.set(ref, values);
  }
  let changed;
  do {
    changed = false;
    for (const ref of removed) for (const derivative of dependencies.get(ref) ?? []) {
      assert(!protectedRefs.has(derivative), "redaction cannot erase canonical tombstones");
      if (!removed.has(derivative)) { removed.add(derivative); changed = true; }
    }
    for (const [ref, values] of decodedStrings) {
      if (removed.has(ref) || protectedRefs.has(ref)) continue;
      const embedsRemovedReference = !auditMetadataRefs.has(ref) && [...values].some(value => removed.has(value));
      const embedsProhibitedText = [...values].some(value => [...needles].some(text => value.includes(text)));
      if (embedsRemovedReference || embedsProhibitedText) {
        removed.add(ref); changed = true;
      }
    }
    for (const [ref, payload] of payloads) {
      if (!removed.has(ref) && !protectedRefs.has(ref) && containsRawNeedle(payload)) { removed.add(ref); changed = true; }
    }
    for(const [ref,payload] of payloads){
      if(removed.has(ref)||protectedRefs.has(ref))continue;
      let matched=false;
      const visit=value=>{if(matched||!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(pairNeedles.some(item=>item.key===key&&item.value===canonicalize(child))){matched=true;return;}visit(child);}};
      visit(payload);if(matched){removed.add(ref);changed=true;}
    }
  } while (changed);
  assert([...protectedRefs].every(ref => !removed.has(ref)), "redaction cannot erase canonical tombstones");
  // Tombstone metadata itself must not repeat the content being erased.
  for (const event of tombstones) {
    const t = event.payload;
    evidenceStrings(t, value => {
      for (const text of needles) assert(!value.includes(text), "tombstone metadata repeats prohibited content");
    });
  }
  for (const ref of removed) delete result.payloads[ref];
  for (const event of result.events) {
    if (removed.has(event.payload.payload_ref)) event.payload = { payload_ref: event.payload.payload_ref, redacted: true,
      original_event_digest: event.integrity.canonical_bytes_hash };
  }
  result.redaction_status = "REPLAY_INCOMPLETE_REDACTED";
  result.exact_reproducibility = false;
  result.tombstone_refs = tombstones.map(event => event.event_id);
  result.removed_payload_refs = [...removed].sort();
  evidenceStrings(result, value => {
    for (const text of needles) assert(!value.includes(text), "redaction scope leaves prohibited content in metadata");
  });
  for (const [ref, record] of Object.entries(result.payloads)) {
    const parsed = JSON.parse(record.bytes);
    assert(!containsRawNeedle(parsed), "redaction byte closure leaves prohibited content in retained payload: " + ref);
  }
  assert(!containsRawNeedle({ ...result, payloads: {} }), "redaction byte closure leaves prohibited content in metadata");
  return result;
}

// A breach changes eligibility, never the existence of the run's evidence.
export function recordBreachDisposition(store, { incidentRef, executionStatus = "invalid", reason = "containment_breach" }) {
  assert(store.events.some(event => event.event_type === "SecurityIncident" && event.event_id === incidentRef), "disposition requires a canonical incident");
  return store.append({ eventType: "RunDisposition", turn: store.events.at(-1).turn, phase: "security",
    causality: { causation_ids: [incidentRef] }, payload: { schema_version: "1.0.0", run_id: store.runId,
      execution_status: executionStatus, evidence_validity: { canonical_record_accurate: true },
      experimental_validity: { confirmatory_eligible: false }, endpoint_eligibility: { primary_confirmatory: false },
      security_eligibility: { security_analysis_eligible: true }, exploratory_only: true,
      replacement_policy: { reason, policy_ref: "BREACH_POLICY.spec.json", incident_ref: incidentRef },
      evidence_completeness: { status: "complete", preserve_run: true } } });
}
