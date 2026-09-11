import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { assert, clone, sha256, canonicalize } from "./core.js";
import { loadEvidence } from "./evidence.js";

export const CODEBOOK_TEXT = readFileSync(new URL("../ENDPOINT_CODEBOOK.spec.md", import.meta.url), "utf8");
export const CODEBOOK_HASH = sha256(CODEBOOK_TEXT);
const BEHAVIOR_TYPES = new Set(["MessageSent", "BattleResolved", "TerritoryTransition", "PopulationUnitTransition"]);
// Deliberately separate from the canonical schema: admitting a new research
// transition must not automatically expose it to blinded behavioral coding.
const BEHAVIOR_MECHANICS = new Set([
  "name", "move", "move_population", "explore", "fortify", "recruit", "demobilize", "reassign", "train",
  "build", "resume_construction", "upgrade", "repair", "destroy", "research", "reverse_engineer", "prospect",
  "intelligence", "transfer", "transfer_unit", "transfer_population", "transfer_facility", "share_technology", "embark", "disembark",
  "demobilization_unavailable", "action_unavailable", "resident_and_equipment_capture", "claim_not_established", "channels",
  "research_outcome", "reverse_engineer_outcome", "population_training_and_projects", "economy", "capital_takeover",
  "polity_elimination", "simultaneous_reservation_conflict", "authorized_observation", "atomic_committed_turn"
]);
const CHANNEL_COMMANDS = new Set(["channel_create", "channel_invite", "channel_leave"]);
function isBehavior(event) {
  if (BEHAVIOR_TYPES.has(event.event_type)) return true;
  if (event.event_type !== "WorldTransition") return false;
  if (BEHAVIOR_MECHANICS.has(event.payload.mechanic)) return true;
  // Preserve actual membership changes without treating controller receipts,
  // failed requests, or duplicate message wrappers as behavioral observations.
  return event.payload.mechanic === "diplomacy_phase_command" && event.payload.detail.validation?.ok === true &&
    CHANNEL_COMMANDS.has(event.payload.detail.command?.type);
}
const PRIVATE_FIELDS = /condition|treatment|persist|memory|model|runtime|prompt|token|session|invocation|experiment|configuration|seed|interview|run_id|schema_version|action_id|event_id|committed_id/i;
// Physical facility condition is behavioral evidence, not experimental condition
// metadata. Select its fields only within the canonical facility record shape.
const FACILITY_FIELDS = new Set(["id", "owner_id", "type", "hex_ids", "size", "capacity", "condition", "prerequisites", "construction_progress", "required_progress", "level", "automation", "captured_from", "transferred_turn", "destroyed"]);
const WORLD_DETAIL_FIELDS = Object.freeze({
  economy:new Set(["production","consumption","deficit"]),
  transfer:new Set(["action_type","from","to","resource","amount","mechanical_outcome"]),
  transfer_unit:new Set(["action_type","from","to","unit_id","mechanical_outcome"]),
  transfer_population:new Set(["action_type","from","to","citizen_id","count","mechanical_outcome"]),
  transfer_facility:new Set(["action_type","from","to","facility_id","mechanical_outcome"]),
  resident_and_equipment_capture:new Set(["territory_id","new_owner","action_ids"]),
  capital_takeover:new Set(["reason","decision"]),polity_elimination:new Set(["reason","decision"]),
  closed_conquest_cycle:new Set(["cycle_members","elimination_predicates","asset_transition_event_ids","elimination_event_ids","resolution"]),
  facility_unclaimed:new Set(["reason"]),resource_extinguishment:new Set(["reason","former_owner_id","territory_ids","physical_resource_hex_ids","physical_resources_remain_at_location"]),
  atomic_committed_turn:new Set(["composition_version","rejected_action_ids"]),
  simultaneous_reservation_conflict:new Set(["reason"]),authorized_observation:new Set([]),
});
const COMMON_ACTION_DETAIL_FIELDS=new Set(["action_type","from","to","resource","amount","unit_id","citizen_id","count","facility_id","technology","mechanical_outcome","reason","progress","sunk_cost"]);
const STATE_ROOT_FIELDS=new Set(["polities","hexes","territories","facilities","channels","unaffiliated_population","neutral_units"]);
const STATE_RECORD_FIELDS=new Set(["id","name","alive","owner_id","controller_id","exclusive_claimant_id","status","type","q","r","terrain","coast","territory_id","territory","capital_hex_id","population","count","assignment","hex_id","health","strength","fortified","embarked_on","food","credits","resources","technologies","units","citizens","members","public","size","capacity","condition","construction_progress","required_progress","level","automation","captured_from","transferred_turn","destroyed","affiliation_status","former_polity_id","facts","value","observed_turn"]);
const packets = new WeakMap();

export function blindingReviewKeyId(publicKey) {
  const key=publicKey?.type==='public'?publicKey:createPublicKey(publicKey);
  assert(key.asymmetricKeyType==='ed25519','blinding review requires Ed25519 authority');
  return createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
}

// Participant language remains authoritative in the canonical MessageSent event,
// but direct declarations of experiment-assigned condition/runtime metadata are
// not needed to code the speech act and would unblind the coder. Keep this list
// deliberately narrow: relational language such as "I remember" remains visible.
export const TREATMENT_DISCLOSURE_SCREEN_VERSION="treatment-disclosure-screen-v1";
const TREATMENT_DISCLOSURE_PATTERNS = Object.freeze([
  {code:"EXPLICIT_ASSIGNMENT",pattern:/\b(?:assigned|assignment|treatment|condition|study\s+arm|experimental?\s+arm)\b.{0,48}\b(?:memory|history|persistent|non[- ]?persistent|state[- ]?only|runtime|model|remember|forget|reset)\b/i},
  {code:"NAMED_ACCESS_MODE",pattern:/\b(?:non[- ]?persistent|persistent|state[- ]?only|reconstructed[- ]?persistent|resident[- ]?persistent)\b.{0,24}\b(?:memory|history|condition|treatment|arm|access)\b/i},
  {code:"CROSS_PERIOD_MEMORY",pattern:/\b(?:memory|history|conversation|context|I)\b.{0,32}\b(?:retain|retained|remember|recall|carry|carries|carried|persist|forget|forgot|lose|lost|reset|wipe)\w*\b.{0,32}\b(?:between|across|each|every|prior|previous|next)\b.{0,20}\b(?:turn|round|session|conversation|period)\b/i},
  {code:"COMPARATIVE_MEMORY",pattern:/\b(?:unlike|compared\s+to|different\s+from)\b.{0,36}\b(?:other|others|agent|agents|player|players|polity|polities)\b.{0,36}\b(?:memory|history|remember|retain|forget|reset|context)\b/i},
  {code:"RUNTIME_DISCLOSURE",pattern:/\b(?:model|runtime|inference\s+engine)\b\s*(?:is|=|:|called|named|uses?|running)\b/i},
]);
export function treatmentDisclosureFlags(value) {
  if(typeof value!=="string")return [];
  return TREATMENT_DISCLOSURE_PATTERNS.filter(({pattern})=>pattern.test(value.normalize("NFKC"))).map(({code})=>code).sort();
}
function normalizedCodingText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") : value;
}

function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function content(store, ref) { const item = store.payloads.get(ref); assert(item && sha256(item.bytes) === ref, "coding evidence reference missing or corrupt"); return JSON.parse(item.bytes); }
function channelChange(store, event) {
  const p = event.payload, id = p.detail.result.channel_id ?? p.detail.command.channel_id;
  return { id, before: content(store, p.before_state_ref).channels[id] ?? null,
    after: content(store, p.after_state_ref).channels[id] ?? null };
}
function cleanFacts(value, shape = "behavior") {
  if (Array.isArray(value)) return value.map(item => cleanFacts(item, shape === "facilities" ? "facility" : shape));
  if (value && typeof value === "object") {
    if (shape === "facilities") return Object.fromEntries(Object.entries(value).map(([id, record]) => [id, cleanFacts(record, record && Object.hasOwn(record, "value") ? "facility_fact" : "facility")]));
    if (typeof value.id === "string" && Object.hasOwn(value, "owner_id") && typeof value.type === "string" && Array.isArray(value.hex_ids)) shape = "facility";
    return Object.fromEntries(Object.entries(value).filter(([key, val]) => shape === "facility"
      ? FACILITY_FIELDS.has(key) && (key !== "condition" || Number.isFinite(val))
      : !PRIVATE_FIELDS.test(key) && !key.endsWith("_ref") && !key.endsWith("_refs"))
      .map(([key, val]) => [key, cleanFacts(val, key === "facilities" ? "facilities" : shape === "facility_fact" && key === "value" ? "facility" : "behavior")]));
  }
  return value;
}
function closedState(value) {
  const closedRecord=value=>{
    if(Array.isArray(value))return value.map(closedRecord);
    if(!value || typeof value!=="object")return value;
    const result={};
    for(const [key,item] of Object.entries(value)) {
      if(!STATE_RECORD_FIELDS.has(key))continue;
      if(key==='resources')result[key]=Object.fromEntries(Object.entries(item??{}).filter(([,n])=>Number.isFinite(n)));
      else if(key==='facts')result[key]={facilities:records(item?.facilities)};
      else result[key]=closedRecord(item);
    }
    return result;
  };
  const records=value=>Object.fromEntries(Object.entries(value??{}).map(([id,record])=>[id,closedRecord(record)]));
  if(!value || typeof value!=="object" || Array.isArray(value))return {};
  const result={};
  for(const [key,item] of Object.entries(value))if(STATE_ROOT_FIELDS.has(key))result[key]=records(item);
  return result;
}
function behavioralFacts(store,event) {
  const p=event.payload;
  if (event.event_type === "WorldTransition" && p.mechanic === "diplomacy_phase_command") {
    const command = p.detail.command, channel = channelChange(store, event);
    return { mechanic: p.mechanic, action_type: command.type, from: p.detail.actor.persistent_identity_id,
      to: command.to ?? null, members: clone(command.members ?? []),
      before_state: { channels: channel.before ? { [channel.id]: cleanFacts(channel.before) } : {} },
      after_state: { channels: channel.after ? { [channel.id]: cleanFacts(channel.after) } : {} } };
  }
  if(event.event_type==='MessageSent') {
    const delivery = p.broadcast === true ? "broadcast" : p.channel_id != null ? "channel" : "direct";
    const audience = delivery === "direct" ? event.participants.filter(id => id === p.to) : event.participants.filter(id => id !== p.from);
    // The verb records the participant's speech act, never an analytical label.
    return {from:p.from,to:p.to,text:p.text,verb:p.broadcast === true ? "broadcast" : p.participant_label === "promise" ? "promise" : "message",delivery,audience:[...new Set(audience)].sort()};
  }
  const detail=p.detail??p,allowed=event.event_type==='WorldTransition'?(WORLD_DETAIL_FIELDS[p.mechanic]??COMMON_ACTION_DETAIL_FIELDS):null;
  const selected=allowed?Object.fromEntries(Object.entries(detail).filter(([key])=>allowed.has(key))):detail;
  const result=cleanFacts(selected);
  if(event.event_type==='WorldTransition') {
    result.mechanic=p.mechanic;
    for(const key of ['facility_before_ref','facility_after_ref'])if(p.detail?.[key]!==undefined)result[key.replace(/_ref$/,'')]=cleanFacts(content(store,p.detail[key]),'facility');
  }
  // Resolve research evidence here, then remove condition/runtime metadata. A
  // blinded coder must see outcomes, not opaque hashes that cannot be evaluated.
  const fields=event.event_type==='WorldTransition'?['before_state_ref','after_state_ref']:
    event.event_type==='BattleResolved'?['outcome_ref','participating_force_refs','terrain_ref']:
    event.event_type==='PopulationUnitTransition'?['population_before_ref','population_after_ref','unit_before_refs','unit_after_refs']:[];
  for(const key of fields)if(p[key]!==undefined) {
    const value=Array.isArray(p[key])?p[key].map(ref=>content(store,ref)):content(store,p[key]);
    // Repair evidence can contain a facility-only projection rather than the
    // complete world state. Its mechanic and owner distinguish this record
    // from experimental metadata even when optional facility fields are absent.
    const shape=event.event_type==='WorldTransition' && p.mechanic==='repair' && typeof value?.id==='string' && Object.hasOwn(value,'owner_id') ? 'facility' : 'behavior';
    result[key.replace(/_refs?$/,'')]=event.event_type==='WorldTransition'&&['before_state_ref','after_state_ref'].includes(key)
      ? shape==='facility'?cleanFacts(value,'facility'):closedState(value):cleanFacts(value,shape);
  }
  return result;
}

// The returned coder input has no access to the mapping, store, condition or model.
// Original language remains untouched in the canonical source; the coder packet
// replaces system identifiers with neutral aliases and excludes private metadata.
function codingCandidate(store) {
  store.verify();
  const events = store.events.filter(isBehavior);
  const disclosures=events.filter(event=>event.event_type==="MessageSent").map(event=>({event_id:event.event_id,flags:treatmentDisclosureFlags(event.payload.text)})).filter(item=>item.flags.length);
  const eventActors = new Map(events.map(event => {
    if (event.payload.mechanic !== "diplomacy_phase_command") return [event.event_id, event.participants];
    const channel = channelChange(store, event);
    // A membership transition concerns both departing and remaining members,
    // although its envelope attributes execution only to the acting principal.
    return [event.event_id, [...new Set([...event.participants, ...(channel.before?.members ?? []), ...(channel.after?.members ?? [])])].sort()];
  }));
  const ids = new Set(events.flatMap(event => [...eventActors.get(event.event_id), event.payload.from, event.payload.to,
    ...(event.payload.actor_ids ?? [])]).filter(x => typeof x === "string"));
  const actors = Object.fromEntries([...ids].sort().map((id, index) => [id, `subject-${index + 1}`]));
  const refs = Object.fromEntries(events.map((event, index) => [event.event_id, `observation-${index + 1}`]));
  function alias(value) {
    if (typeof value === "string") return actors[value] ?? refs[value] ?? value;
    if (Array.isArray(value)) return value.map(alias);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [actors[key]??refs[key]??key, alias(val)]));
    return value;
  }
  const candidate = { schema_version: "1.0.0", codebook: CODEBOOK_TEXT, codebook_hash: CODEBOOK_HASH,
    treatment_blind:false, candidate_status:"UNREVIEWED_RAW_PARTICIPANT_LANGUAGE",
    defense_in_depth_screen:{version:TREATMENT_DISCLOSURE_SCREEN_VERSION,status:disclosures.length?"FLAGGED":"NO_REGEX_FLAGS",
      flagged_observations:disclosures.map(item=>({ref:refs[item.event_id],flags:item.flags}))},
    observations: events.map(event => ({ ref: refs[event.event_id], type: event.event_type, turn: event.turn + 1,
      phase: event.phase, actors: eventActors.get(event.event_id).map(id => actors[id]),
      causal_predecessors: [...event.causality.causation_ids, ...event.lineage.parent_event_ids].filter(id => refs[id]).map(id => refs[id]),
      facts: alias(behavioralFacts(store,event)) })) };
  return {candidate,disclosures,mapping:{ run_id: store.runId, source_event_ids: events.map(event => event.event_id), actors, refs, source_head: store.previousHash }};
}

export function prepareCodingCandidate(store) {
  const {candidate}=codingCandidate(store);
  return freeze({input:candidate,candidateHash:sha256(candidate)});
}

function issuePacket(store,candidate,mapping,blindingReview) {
  const input=freeze({...candidate,treatment_blind:blindingReview.mode==='EXTERNALLY_AUTHENTICATED_INDEPENDENT_REVIEW',
    candidate_status:'REVIEWED',blinding_review:blindingReview});
  const packetRef = store.putPayload(input, "blinded_coding_input");
  const mappingRef = store.putPayload(mapping, "research_only_coding_mapping");
  const result = freeze({ input, packetRef });
  packets.set(result, { store, mapping, mappingRef, reviewMode:blindingReview.mode }); return result;
}

export function prepareSyntheticCodingPacket(store) {
  const {candidate,disclosures,mapping}=codingCandidate(store);
  assert(disclosures.length===0,"CODING_PACKET_REQUIRES_BLINDING_REVIEW: defense-in-depth screen flagged participant treatment/runtime disclosure");
  return issuePacket(store,candidate,mapping,{schema_version:'1.0.0',mode:'SYNTHETIC_CONFORMANCE_ONLY',
    candidate_packet_hash:sha256(candidate),status:'SYNTHETIC_FIXTURE_REVIEW',promotable_to_empirical:false});
}

export function prepareCodingPacket(store,{attestation,trust}={}) {
  const {candidate,disclosures,mapping}=codingCandidate(store),candidateHash=sha256(candidate);
  assert(disclosures.length===0,"CODING_PACKET_REQUIRES_BLINDING_REVIEW: defense-in-depth screen flagged participant treatment/runtime disclosure");
  const publicKey=trust?.publicKey&&(trust.publicKey.type==='public'?trust.publicKey:createPublicKey(trust.publicKey));
  assert(publicKey&&trust.keyId&&trust.authorityId&&blindingReviewKeyId(publicKey)===trust.keyId,'externally trusted blinding-review authority required');
  const body=attestation?.body;
  assert(body?.schema_version==='1.0.0'&&body.review_type==='INDEPENDENT_BLINDING_REVIEW'&&body.candidate_packet_hash===candidateHash&&
    body.disclosure_status==='NO_TREATMENT_OR_RUNTIME_DISCLOSURE_DETECTED'&&body.authority_id===trust.authorityId&&body.key_id===trust.keyId&&
    typeof body.review_id==='string'&&body.review_id&&typeof body.reviewer_id==='string'&&body.reviewer_id,
    'missing, mismatched, or disclosure-positive independent blinding-review attestation');
  assert(typeof attestation.signature==='string'&&verify(null,Buffer.from(canonicalize(body)),publicKey,Buffer.from(attestation.signature,'base64')),
    'independent blinding-review attestation signature invalid');
  return issuePacket(store,candidate,mapping,{schema_version:'1.0.0',mode:'EXTERNALLY_AUTHENTICATED_INDEPENDENT_REVIEW',
    candidate_packet_hash:candidateHash,status:'PASSED',attestation:clone(attestation),authority_id:body.authority_id,key_id:body.key_id});
}

export function validateAnnotations(annotations, input) {
  assert(Array.isArray(annotations), "annotations required");
  const observations = new Map(input.observations.map(item => [item.ref, item]));
  const parties = new Set(input.observations.flatMap(item => item.actors));
  const ids = new Set(), opportunities = new Set();
  const statuses = ["OBSERVED", "CENSORED", "UNEVALUABLE", "MISSING_DUE_TO_BREACH", "MISSING_DUE_TO_SYSTEM_FAILURE"];
  const categories = ["resource_assistance_exchange", "fulfilled_commitment", "cooperative_coordination", "defensive_assistance", "authorized_information_sharing", "retaliatory_response", "repair_reconciliation"];
  const common = ["id", "kind", "source", "actor", "counterparty", "eligibility", "observation_status", "confidence", "ambiguity"];
  for (const row of annotations) {
    assert(row && typeof row === "object" && !Array.isArray(row), "invalid coding row");
    assert(typeof row.id === "string" && row.id && !ids.has(row.id), "duplicate or missing coding id"); ids.add(row.id);
    assert(["commitment", "reciprocity", "repair"].includes(row.kind), "unknown coding kind");
    const ownKeys = row.kind === "commitment" ? ["undertaking", "future_condition", "outcome", "evaluation_ref", "due_turn", "due_basis_refs", "evaluable"] : row.kind === "reciprocity" ? ["category", "responses"] : ["rupture_kind", "acts", "outcome", "sufficient_opportunity", "evaluation_ref"];
    assert(Object.keys(row).every(key => [...common, ...ownKeys].includes(key)), "unblinded or unknown coding field");
    assert(common.every(key => Object.hasOwn(row, key)) && ownKeys.every(key => Object.hasOwn(row, key)), "coding fields missing");
    const source = observations.get(row.source); assert(source, "unknown coding source");
    const counterparties = Array.isArray(row.counterparty) ? row.counterparty : [row.counterparty];
    assert(parties.has(row.actor) && counterparties.length && counterparties.every(id => parties.has(id) && id !== row.actor) && new Set(counterparties).size === counterparties.length, "identifiable distinct coding parties required");
    const opportunity=sha256([row.kind,row.source,row.actor,[...counterparties].sort(),row.kind==='commitment'?[normalizedCodingText(row.undertaking),normalizedCodingText(row.future_condition),row.due_turn]:row.kind==='repair'?row.rupture_kind:null]);
    assert(!opportunities.has(opportunity), "duplicate coded opportunity"); opportunities.add(opportunity);
    assert(source.actors.includes(row.actor) || source.facts.from === row.actor, "coding actor absent from source evidence");
    if (source.type === "MessageSent" && row.kind === "commitment") assert(source.facts.from === row.actor, "commitment undertaking attributed to wrong sender");
    assert(["ELIGIBLE", "INELIGIBLE", "AMBIGUOUS"].includes(row.eligibility), "invalid eligibility");
    assert(statuses.includes(row.observation_status), "missingness must retain its canonical class");
    assert(Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 && (row.ambiguity === null || typeof row.ambiguity === "string"), "invalid confidence or ambiguity");
    const later = (ref, maxLag = Infinity) => {
      assert(ref!==row.source, "an initiating action cannot evaluate or reciprocate itself");
      const target = observations.get(ref); assert(target, "dangling response/evaluation source");
      assert(target.turn >= source.turn && target.turn - source.turn <= maxLag, "response outside temporal contract");
      if (target.turn === source.turn && ref !== row.source) assert(target.causal_predecessors.includes(row.source), "same-turn response lacks explicit causal predecessor");
      return target;
    };
      if (row.kind === "commitment") {
      assert(source.type === "MessageSent", "commitment must preserve original communication");
      assert(["FULFILLED", "BREACHED", "MODIFIED", "RELEASED", "UNEVALUABLE", "ONGOING_AT_HORIZON", "AMBIGUOUS"].includes(row.outcome), "invalid commitment outcome");
      assert(typeof row.evaluable === "boolean", "explicit evaluability required");
      if (row.eligibility === "ELIGIBLE") assert(typeof row.undertaking === "string" && row.undertaking.trim() && typeof row.future_condition === "string" && row.future_condition.trim(), "future evaluable undertaking required");
      assert(row.due_turn === null || (Number.isInteger(row.due_turn) && row.due_turn >= source.turn), "retrospective commitment forbidden");
      const explicitDue=(()=>{const text=source.facts.text??'';const absolute=/\b(?:by|on|at|before)\s+turn\s+(\d+)\b/i.exec(text);if(absolute)return Number(absolute[1]);if(/\b(?:tomorrow|next turn|following turn)\b/i.test(text))return source.turn+1;return null;})();
      if(explicitDue!==null)assert(row.due_turn===explicitDue,"coded due turn contradicts explicit commitment evidence");
      const evaluation=row.evaluation_ref !== null?later(row.evaluation_ref):null;
      assert(Array.isArray(row.due_basis_refs) && row.due_basis_refs.length>0 && new Set(row.due_basis_refs).size===row.due_basis_refs.length,"commitment due/evaluable attribution requires unique canonical basis references");
      assert(row.due_basis_refs.includes(row.source),"commitment temporal basis must include formation evidence");
      for(const basisRef of row.due_basis_refs) {
        const basis=observations.get(basisRef);assert(basis,"dangling commitment temporal basis reference");
        if(evaluation)assert(basis.turn<=evaluation.turn,"commitment temporal basis postdates disposition");
        const linked=basis.type==='MessageSent'?(basis.facts.from===row.actor?counterparties.some(id=>basis.facts.audience.includes(id)):counterparties.includes(basis.facts.from)&&basis.facts.audience.includes(row.actor)):
          (()=>{const actors=new Set([...basis.actors,basis.facts.from,basis.facts.to]);return actors.has(row.actor)&&counterparties.some(id=>actors.has(id));})();
        assert(linked,"commitment temporal basis parties absent from evidence");
      }
      if(row.evaluable&&row.due_turn===null)assert(evaluation&&row.due_basis_refs.includes(row.evaluation_ref),"contextual commitment evaluability requires canonical evaluation evidence in its temporal basis");
      if(evaluation){
        const linked=evaluation.type==='MessageSent'?(evaluation.facts.from===row.actor?counterparties.some(id=>evaluation.facts.audience.includes(id)):counterparties.includes(evaluation.facts.from)&&evaluation.facts.audience.includes(row.actor)):
          (()=>{const actors=new Set([...evaluation.actors,evaluation.facts.from,evaluation.facts.to]);return actors.has(row.actor)&&counterparties.some(id=>actors.has(id));})();
        assert(linked,"commitment evaluation parties absent from evidence");
      }
      if (row.evaluable) assert(row.evaluation_ref && ["FULFILLED", "BREACHED", "MODIFIED", "RELEASED"].includes(row.outcome), "unevaluable/ongoing/ambiguous is not evaluable fulfillment or breach");
      if (["FULFILLED", "BREACHED", "MODIFIED", "RELEASED"].includes(row.outcome) && row.eligibility === "ELIGIBLE") assert(row.evaluable, "evaluated outcome requires evaluability");
      if (row.outcome === "BREACHED") {
        assert(row.evaluable && row.evaluation_ref, "breach requires due evaluable evidence");
        if(row.due_turn!==null)assert(observations.get(row.evaluation_ref).turn>=row.due_turn,"breach evaluated before due turn");
      }
    } else if (row.kind === "reciprocity") {
      assert(typeof row.counterparty === "string", "reciprocity requires identifiable directed actor pair");
      if(source.type==='MessageSent')assert(source.facts.from===row.actor && source.facts.audience.includes(row.counterparty),"initiating message directed roles mismatch");
      assert(categories.includes(row.category) && Array.isArray(row.responses), "invalid reciprocity category/responses");
      for (const response of row.responses) {
        assert(Object.keys(response).sort().join(",") === "actor,category,counterparty,polarity,source", "invalid reciprocity response fields");
        const actual = later(response.source, 5);
        assert(response.actor === row.counterparty && response.counterparty === row.actor, "reciprocity must reverse the parties");
        assert(actual.actors.includes(response.actor) || actual.facts.from === response.actor, "response actor absent from evidence");
        if(actual.type==='MessageSent')assert(actual.facts.from===response.actor && actual.facts.audience.includes(response.counterparty),"reciprocal message directed roles mismatch");
        assert(["POSITIVE", "NEGATIVE"].includes(response.polarity) && categories.includes(response.category), "separate signed reciprocal categories required");
      }
    } else {
      assert(["commitment_breach", "hostile_action", "cooperative_withdrawal", "explicit_relational_conflict"].includes(row.rupture_kind), "unregistered rupture kind");
      assert(["REPAIR_ATTEMPT", "REPAIR_ACCEPTED", "REPAIR_REJECTED", "NO_REPAIR_OBSERVED", "UNEVALUABLE"].includes(row.outcome), "invalid repair outcome");
      assert(typeof row.sufficient_opportunity === "boolean" && Array.isArray(row.acts), "repair opportunity/acts required");
      if(row.eligibility==='ELIGIBLE' && row.observation_status==='OBSERVED' && row.sufficient_opportunity && row.outcome!=='UNEVALUABLE')assert(row.evaluation_ref!==null,"observed repair opportunity requires evaluation evidence");
      // A coder supplies the interpretation; canonical parties and temporal
      // evidence still have to support that interpretation's episode linkage.
      const linkedParties = observation => {
        if (observation.type === "MessageSent") {
          const { from, audience } = observation.facts;
          return from === row.actor ? counterparties.some(id => audience.includes(id)) :
            counterparties.includes(from) && audience.includes(row.actor);
        }
        const actors = new Set([...observation.actors, observation.facts.from, observation.facts.to]);
        return actors.has(row.actor) && counterparties.some(id => actors.has(id));
      };
      if (row.eligibility === "ELIGIBLE") assert(linkedParties(source), "repair rupture parties absent from evidence");
      const evaluation = row.evaluation_ref === null ? null : later(row.evaluation_ref);
      if (evaluation) assert(linkedParties(evaluation), "repair evaluation parties absent from evidence");
      const causallyFollows = (target, predecessor) => {
        const pending = [...target.causal_predecessors], seen = new Set();
        while (pending.length) {
          const ref = pending.pop();
          if (ref === predecessor) return true;
          if (seen.has(ref)) continue;
          seen.add(ref); pending.push(...(observations.get(ref)?.causal_predecessors ?? []));
        }
        return false;
      };
      for (const act of row.acts) {
        assert(Object.keys(act).sort().join(",") === "kind,source", "invalid restorative act fields");
        const actual = later(act.source);
        assert(linkedParties(actual), "restorative act parties absent from repair episode evidence");
        if (evaluation) {
          assert(actual.turn <= evaluation.turn, "restorative act occurs after repair evaluation");
          if (actual.turn === evaluation.turn && act.source !== row.evaluation_ref)
            assert(causallyFollows(evaluation, act.source), "same-turn repair evaluation lacks restorative act causal predecessor");
        }
        assert(["acknowledgment_with_corrective_undertaking", "restitution_compensation", "renegotiated_commitment", "accepted_release_forgiveness", "cooperation_after_explicit_reconciliation"].includes(act.kind), "unregistered restorative act");
      }
      if (["REPAIR_ATTEMPT", "REPAIR_ACCEPTED", "REPAIR_REJECTED"].includes(row.outcome)) assert(row.acts.length > 0, "repair needs an explicit restorative act");
      if (row.outcome === "NO_REPAIR_OBSERVED") assert(row.acts.length === 0, "repair absence conflicts with restorative act");
    }
  }
  return true;
}

export function recordCoding(store, packet, { annotations, reviewedRefs, coder, supersedes = null }) {
  const registered = packets.get(packet); assert(registered?.store === store, "coding packet is not issued for this run");
  assert(canonicalize([...reviewedRefs].sort()) === canonicalize(packet.input.observations.map(o => o.ref).sort()), "coding coverage incomplete");
  validateAnnotations(annotations, packet.input);
  const prior = store.events.filter(event => event.event_type === "BehaviorCoded").at(-1);
  assert((prior?.event_id ?? null) === supersedes, "adjudication must reference preceding coding result");
  const rulesRef = store.putPayload(CODEBOOK_TEXT, "coding_rules");
  assert(coder && ["blinded_human", "blinded_automated", "synthetic_fixture"].includes(coder.mode) && coder.id && coder.version, "versioned blinded coder required");
  assert(registered.reviewMode==='SYNTHETIC_CONFORMANCE_ONLY'?coder.mode==='synthetic_fixture':coder.mode!=='synthetic_fixture',
    'synthetic blinding review and coding cannot be promoted to empirical research evidence');
  if (coder.mode === "blinded_automated") assert(typeof coder.prompt === "string" && coder.prompt, "automated coding prompt required");
  const promptRef = coder.prompt ? store.putPayload(coder.prompt, "blinded_coding_prompt") : null;
  return store.append({ eventType: "BehaviorCoded", turn: Math.max(0, ...packet.input.observations.map(o => o.turn - 1)), phase: "analysis",
    payload: { schema_version: "1.0.0", run_id: store.runId, packet_ref: packet.packetRef, mapping_ref: registered.mappingRef, codebook_ref: rulesRef,
      coder: { id: coder.id, version: coder.version, mode: coder.mode, rules_ref: rulesRef, prompt_ref: promptRef },
      annotations: clone(annotations), reviewed_refs: [...reviewedRefs], supersedes, coverage_complete: true },
    causality: { causation_ids: [...registered.mapping.source_event_ids, ...(supersedes ? [supersedes] : [])] }, visibility: { classification: "private_research", acl_ref: "observer" } });
}

export function archivedCoding(bundle,blindingTrust=null) {
  const store = loadEvidence(bundle);
  const event = store.events.filter(e => e.event_type === "BehaviorCoded").at(-1); assert(event, "canonical blinded coding coverage required");
  let preceding=null;
  for(const item of store.events.filter(e=>e.event_type==='BehaviorCoded')) {
    const p=item.payload;
    assert(p.coder.id.trim() && p.coder.version.trim(),"versioned blinded coder required");
    assert(content(store,p.codebook_ref)===CODEBOOK_TEXT && content(store,p.coder.rules_ref)===CODEBOOK_TEXT,"archived coding rules mismatch");
    if(p.coder.mode==='blinded_automated')assert(p.coder.prompt_ref && typeof content(store,p.coder.prompt_ref)==='string' && content(store,p.coder.prompt_ref).trim(),"archived automated coding prompt required");
    assert(p.supersedes===preceding && (!preceding || item.causality.causation_ids.includes(preceding)),"broken coding adjudication chain");
    const priorStore=loadEvidence({run_id:store.runId,events:store.events.slice(0,item.sequence),payloads:Object.fromEntries(store.payloads)});
    const storedInput=content(store,p.packet_ref);
    const priorPacket=storedInput.blinding_review?.mode==='SYNTHETIC_CONFORMANCE_ONLY'?prepareSyntheticCodingPacket(priorStore):
      prepareCodingPacket(priorStore,{attestation:storedInput.blinding_review?.attestation,trust:blindingTrust});
    const storedMapping=content(store,p.mapping_ref), expected=packets.get(priorPacket).mapping;
    assert(canonicalize(priorPacket.input)===canonicalize(storedInput),"archived coding packet differs from canonical source coverage");
    for(const key of ['run_id','source_event_ids','actors','refs'])assert(canonicalize(storedMapping[key])===canonicalize(expected[key]),"archived coding mapping mismatch");
    assert(canonicalize([...p.reviewed_refs].sort())===canonicalize(storedInput.observations.map(o=>o.ref).sort()),"archived coding coverage incomplete");
    assert(storedMapping.source_event_ids.every(id=>item.causality.causation_ids.includes(id)),"archived coding source parents missing");
    validateAnnotations(p.annotations,storedInput);
    preceding=item.event_id;
  }
  const input = content(store, event.payload.packet_ref), mapping = content(store, event.payload.mapping_ref);
  const synthetic=input.blinding_review?.mode==='SYNTHETIC_CONFORMANCE_ONLY';
  assert((synthetic?input.treatment_blind===false:input.treatment_blind===true)&&input.defense_in_depth_screen?.version===TREATMENT_DISCLOSURE_SCREEN_VERSION&&
    input.defense_in_depth_screen.status==="NO_REGEX_FLAGS"&&input.defense_in_depth_screen.flagged_observations.length===0&&input.codebook_hash === CODEBOOK_HASH && input.codebook === CODEBOOK_TEXT,
    "blinded codebook/review/screen mismatch");
  assert(mapping.run_id === store.runId, "coding crosses run boundary");
  const regenerated = synthetic?prepareSyntheticCodingPacket(store):prepareCodingPacket(store,{attestation:input.blinding_review.attestation,trust:blindingTrust});
  assert(canonicalize(regenerated.input) === canonicalize(input), "coding packet differs from canonical behavior or coverage is stale");
  const expectedMapping = packets.get(regenerated).mapping;
  for (const key of ["source_event_ids", "actors", "refs"]) assert(canonicalize(mapping[key]) === canonicalize(expectedMapping[key]), "coding source mapping differs from canonical evidence");
  assert(mapping.source_event_ids.every(id => event.causality.causation_ids.includes(id)), "coding missing canonical source parents");
  assert(canonicalize([...event.payload.reviewed_refs].sort()) === canonicalize(input.observations.map(o => o.ref).sort()), "coding coverage incomplete");
  validateAnnotations(event.payload.annotations, input);
  return { store, event, input, mapping };
}
