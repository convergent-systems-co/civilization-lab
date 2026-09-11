import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EvidenceStore, loadEvidence } from "../src/evidence.js";
import { canonicalize, clone, sha256, EVENT_CATALOGUE_VERSION } from "../src/core.js";
import { prepareCodingPacket, prepareCodingCandidate, prepareSyntheticCodingPacket, blindingReviewKeyId, recordCoding, archivedCoding, validateAnnotations } from "../src/coding.js";
import { deriveEndpoint, fixedFixtureReference, WINDOW_ATTRIBUTION } from "../src/analysis.js";

// Hand-authored, nonempirical event fixtures. Commits satisfy their real schema
// and resolutions cite them; these fixtures do not claim world-reducer replay.
function fixture() {
  const store = new EvidenceStore("synthetic-endpoint-adversarial");
  store.append({ eventType: "RunCreated", turn: 0, phase: "setup", participants: ["a", "b", "c"],
    payload: { run_id: store.runId, synthetic: true, evidence_class: "SYNTHETIC_CONFORMANCE" } });
  const messages = [
    [1, "a", "b", "I will return the resource by turn 2."],
    [2, "b", "a", "Received it; I provide assistance in return."],
    [3, "a", "b", "We dispute our arrangement."],
    [4, "b", "a", "I acknowledge the harm and undertake compensation."],
    [5, "a", "b", "I accept the offered repair."],
    [6, "b", "a", "I retaliate in response to the turn 1 action."],
    [16, "a", "b", "I will return the resource by turn 17."],
    [17, "b", "a", "The promised resource was not returned."],
  ];
  for (let turn = 0; turn < 20; turn++) {
    for (const [at, from, to, text] of messages.filter(([at]) => at === turn + 1)) {
      store.append({ eventType: "MessageSent", turn: at - 1, phase: "communication",
        participants: [from, to], payload: { from, to, text } });
    }
    const turnId = `synthetic-commit-${turn}`;
    const commit = store.append({ eventType: "TurnCommitted", turn, phase: "commit", payload: {
      schema_version: "1.0.0", turn_committed_id: turnId, run_id: store.runId,
      turn_id: `turn-${turn}`, turn, input_state_hash: sha256(["fixture-state", turn]),
      accepted_submission_ids: [], accepted_action_ids: [], actor_action_refs: [], projection_version_refs: [],
      configuration_hash: sha256("synthetic-fixture"), rng_provenance_root_ref: sha256("no-fixture-draws"),
      rng_provenance_refs: [], lineage_refs: [], action_set_hash: sha256([]),
      commit_event_id: store.nextEventId(), catalogue_version: EVENT_CATALOGUE_VERSION, immutable_after_commit: true,
    } });
    store.append({ eventType: "TurnResolved", turn, phase: "resolution",
      causality: { causation_ids: [commit.event_id] }, payload: { turn_committed_id: turnId, synthetic: true } });
  }
  const packet = prepareSyntheticCodingPacket(store);
  const ref = turn => packet.input.observations.find(o => o.type === "MessageSent" && o.turn === turn).ref;
  const base = (id, kind, turn) => ({ id, kind, source: ref(turn), actor: "subject-1", counterparty: "subject-2",
    eligibility: "ELIGIBLE", observation_status: "OBSERVED", confidence: 1, ambiguity: null });
  const commitment = (id = "early", turn = 1, evaluation = 2, outcome = "FULFILLED") => ({
    ...base(id, "commitment", turn), undertaking: "return resource", future_condition: "by the following turn",
    due_turn: turn + 1, due_basis_refs: [ref(turn)], outcome, evaluation_ref: ref(evaluation), evaluable: true,
  });
  const reciprocity = () => ({ ...base("reciprocity", "reciprocity", 1), category: "resource_assistance_exchange",
    responses: [{ source: ref(2), actor: "subject-2", counterparty: "subject-1", polarity: "POSITIVE", category: "resource_assistance_exchange" }] });
  const repair = () => ({ ...base("repair", "repair", 3), rupture_kind: "explicit_relational_conflict",
    acts: [{ source: ref(4), kind: "acknowledgment_with_corrective_undertaking" }],
    outcome: "REPAIR_ACCEPTED", sufficient_opportunity: true, evaluation_ref: ref(5) });
  const options = { runId: store.runId, manifest: { version: "adversarial-fixture-v1", purpose: "conformance",
    horizon: 20, experimental_unit: "run", window_attribution: { ...WINDOW_ATTRIBUTION },
    reference: fixedFixtureReference() } };
  const code = (annotations, coder = { id: "fixture-coder", version: "1", mode: "synthetic_fixture" }) => recordCoding(store, packet, {
    annotations, coder, reviewedRefs: packet.input.observations.map(o => o.ref),
    supersedes: store.events.filter(e => e.event_type === "BehaviorCoded").at(-1)?.event_id ?? null,
  });
  const derive = () => deriveEndpoint(store.bundle(), options);
  return { store, packet, ref, commitment, reciprocity, repair, options, code, derive };
}

// Rebuild signatures and hashes so a failed assertion cannot be satisfied merely
// by a corrupt digest. Event identity and ordering remain unchanged.
function rewriteCoding(bundle, mutate) {
  const store = new EvidenceStore(bundle.run_id);
  store.payloads = new Map(Object.entries(clone(bundle.payloads)));
  let codingIndex = 0;
  for (const original of bundle.events) {
    const event = clone(original), payload = clone(event.payload);
    delete payload.payload_ref;
    if (event.event_type === "BehaviorCoded") mutate(payload, event, store, codingIndex++);
    store.append({ eventType: event.event_type, turn: event.turn, phase: event.phase, payload,
      participants: event.participants, visibility: event.visibility, causality: event.causality,
      lineage: event.lineage, provenance: event.provenance, rng: event.rng, source: event.provenance.source });
  }
  assert.equal(store.verify(), true);
  return store.bundle();
}

test("adversarial fixture has valid canonical coverage and a valid three-stage adjudication", () => {
  const f = fixture();
  const first = f.code([f.commitment()]);
  const second = f.code([{ ...f.commitment(), confidence: 0.8 }]);
  const third = f.code([{ ...f.commitment(), confidence: 0.9 }]);
  assert.equal(second.payload.supersedes, first.event_id);
  assert.equal(third.payload.supersedes, second.event_id);
  assert.equal(archivedCoding(f.store.bundle()).event.event_id, third.event_id);
  assert.equal(f.derive().components.A.fulfillment.value, 1);
  assert.equal(f.store.events.filter(e => e.event_type === "TurnResolved").length, 20);
});

const provenanceMutations = [
  ["wrong codebook", (p, e, s) => { p.codebook_ref = s.putPayload("invented codebook"); }, /rules|codebook/i],
  ["wrong coder rules", (p, e, s) => { p.coder.rules_ref = s.putPayload("invented rules"); }, /rules|codebook/i],
  ["empty coder identity", p => { p.coder.id = ""; }, /coder|version/i],
  ["blank coder version", p => { p.coder.version = "  "; }, /coder|version/i],
  ["automated coder without prompt", p => { p.coder.mode = "blinded_automated"; p.coder.prompt_ref = null; }, /prompt/i],
  ["automated coder with blank prompt", (p, e, s) => { p.coder.mode = "blinded_automated"; p.coder.prompt_ref = s.putPayload("  "); }, /prompt/i],
  ["wrong canonical mapping", (p, e, s) => {
    const mapping = JSON.parse(s.payloads.get(p.mapping_ref).bytes);
    mapping.refs = { fabricated_event: "observation-1" };
    p.mapping_ref = s.putPayload(mapping);
  }, /mapping|canonical/i],
  ["incomplete reviewed coverage", p => { p.reviewed_refs.pop(); }, /coverage/i],
  ["altered blinded packet", (p, e, s) => {
    const input = JSON.parse(s.payloads.get(p.packet_ref).bytes);
    input.observations[0].facts.text = "Replacement evidence invented after coding.";
    p.packet_ref = s.putPayload(input);
  }, /packet|canonical|coverage/i],
  ["missing canonical source parents", (p, e) => { e.causality.causation_ids = p.supersedes ? [p.supersedes] : []; }, /parent|source|canonical/i],
];

for (const [name, mutate, reason] of provenanceMutations) {
  test(`archive rejects ${name} in the final coding record`, () => {
    const f = fixture(); f.code([f.commitment()]);
    assert.throws(() => archivedCoding(rewriteCoding(f.store.bundle(), mutate)), reason);
  });
  test(`valid final adjudication cannot conceal ${name} in an earlier record`, () => {
    const f = fixture(); f.code([f.commitment()]); f.code([f.commitment()]); f.code([f.commitment()]);
    const forged = rewriteCoding(f.store.bundle(), (p, e, s, index) => { if (index === 0) mutate(p, e, s); });
    assert.throws(() => archivedCoding(forged), reason);
  });
}

for (const [name, mutate] of [
  ["reset supersession", p => { p.supersedes = null; }],
  ["skipped predecessor", (p, e, s) => { p.supersedes = s.events.find(x => x.event_type === "BehaviorCoded").event_id; }],
  ["missing predecessor causal edge", (p, e) => { e.causality.causation_ids = e.causality.causation_ids.filter(id => id !== p.supersedes); }],
]) test(`archive rejects ${name} within a three-stage adjudication`, () => {
  const f = fixture(); f.code([]); f.code([]); f.code([]);
  const forged = rewriteCoding(f.store.bundle(), (p, e, s, index) => { if (index === 2) mutate(p, e, s); });
  assert.throws(() => archivedCoding(forged), /adjudication|supersed|predecessor|chain/i);
});

test("a valid final annotation cannot conceal an invalid earlier annotation", () => {
  const f = fixture(); f.code([f.commitment()]); f.code([f.commitment()]);
  const forged = rewriteCoding(f.store.bundle(), (p, e, s, index) => {
    if (index === 0) p.annotations[0].evaluation_ref = p.annotations[0].source;
  });
  assert.throws(() => archivedCoding(forged), /itself|initiating|temporal|evaluation/i);
});

test("renamed coder and reference labels cannot promote synthetic genesis to empirical evidence", () => {
  const f = fixture();
  assert.throws(()=>f.code([f.commitment()], { id: "declared-reviewer", version: "1", mode: "blinded_human" }),/cannot be promoted/);
  f.code([f.commitment()]);
  assert.equal(f.derive().evidence_class, "SYNTHETIC_CONFORMANCE");
  f.options.manifest.purpose = "pilot0";
  f.options.manifest.reference.purpose = "renamed-reference";
  assert.throws(() => f.derive(), /#112_NOT_FROZEN/);
});

test("direct and paraphrased treatment/runtime disclosures fail closed before blind certification", () => {
  const disclosures=[
    "My assigned treatment is persistent memory; model runtime is Qwen 3.5 Base. I will send food next turn.",
    "I was assigned to remember everything between turns; I will send food next turn.",
    "Unlike the others, I retain prior conversations; I will send food next turn.",
    "My history carries over every round; I will send food next turn.",
  ];
  for(const [index,text] of disclosures.entries()) {
    const store = new EvidenceStore("synthetic-blinding-self-disclosure-"+index);
    store.append({ eventType: "MessageSent", turn: 0, phase: "diplomacy", participants: ["a", "b"],payload: { from: "a", to: "b", text } });
    assert.throws(()=>prepareSyntheticCodingPacket(store),/CODING_PACKET_REQUIRES_BLINDING_REVIEW/);
    assert.equal(store.events[0].payload.text,text,"canonical participant language must remain unchanged");
  }
});

test("ordinary relational memory language remains available after disclosure screening", () => {
  const store = new EvidenceStore("synthetic-blinding-self-disclosure");
  store.append({ eventType: "MessageSent", turn: 0, phase: "diplomacy", participants: ["a", "b"],
    payload: { from: "a", to: "b", text: "I remember our alliance and will send food next turn." } });
  const packet = prepareSyntheticCodingPacket(store);
  const text = packet.input.observations[0].facts.text;
  assert.equal(text,"I remember our alliance and will send food next turn.");
  assert.equal(packet.input.treatment_blind,false);
  assert.deepEqual(packet.input.defense_in_depth_screen,{version:"treatment-disclosure-screen-v1",status:"NO_REGEX_FLAGS",flagged_observations:[]});
});

function signedBlindingReview(store,{status="NO_TREATMENT_OR_RUNTIME_DISCLOSURE_DETECTED",keys=generateKeyPairSync("ed25519")}={}) {
  const candidate=prepareCodingCandidate(store),keyId=blindingReviewKeyId(keys.publicKey);
  const trust={publicKey:keys.publicKey,keyId,authorityId:"independent-review-board"};
  const body={schema_version:"1.0.0",review_type:"INDEPENDENT_BLINDING_REVIEW",candidate_packet_hash:candidate.candidateHash,
    disclosure_status:status,authority_id:trust.authorityId,key_id:keyId,review_id:"review-1",reviewer_id:"reviewer-1"};
  return {candidate,trust,attestation:{body,signature:sign(null,Buffer.from(canonicalize(body)),keys.privateKey).toString("base64")}};
}

test("raw paraphrased participant-language candidates are never automatically certified treatment-blind",()=>{
  const store=new EvidenceStore("synthetic-paraphrase-review-boundary");
  const text="I have perfect recall from one period to the next.";
  store.append({eventType:"MessageSent",turn:0,phase:"diplomacy",participants:["a","b"],payload:{from:"a",to:"b",text}});
  const candidate=prepareCodingCandidate(store);
  assert.equal(candidate.input.treatment_blind,false);
  assert.equal(candidate.input.defense_in_depth_screen.status,"NO_REGEX_FLAGS");
  assert.equal(candidate.input.observations[0].facts.text,text);
  assert.throws(()=>prepareCodingPacket(store),/externally trusted blinding-review authority/);
  const review=signedBlindingReview(store);
  const packet=prepareCodingPacket(store,review);
  assert.equal(packet.input.treatment_blind,true);
  assert.equal(packet.input.blinding_review.candidate_packet_hash,candidate.candidateHash);
  recordCoding(store,packet,{annotations:[],reviewedRefs:packet.input.observations.map(o=>o.ref),coder:{id:"independent-coder",version:"1",mode:"blinded_human"}});
  assert.equal(archivedCoding(store.bundle(),review.trust).input.treatment_blind,true);
  assert.throws(()=>archivedCoding(store.bundle()),/externally trusted blinding-review authority/);
});

test("forged, disclosure-positive, and packet-substituted blinding reviews fail closed",()=>{
  const makeStore=id=>{const store=new EvidenceStore(id);store.append({eventType:"MessageSent",turn:0,phase:"diplomacy",participants:["a","b"],payload:{from:"a",to:"b",text:"I remember our agreement."}});return store;};
  const forgedStore=makeStore("synthetic-forged-review"),review=signedBlindingReview(forgedStore),attacker=generateKeyPairSync("ed25519");
  const forged={...review,attestation:{body:review.attestation.body,signature:sign(null,Buffer.from(canonicalize(review.attestation.body)),attacker.privateKey).toString("base64")}};
  assert.throws(()=>prepareCodingPacket(forgedStore,forged),/signature invalid/);
  const positiveStore=makeStore("synthetic-positive-review"),positive=signedBlindingReview(positiveStore,{status:"DISCLOSURE_DETECTED"});
  assert.throws(()=>prepareCodingPacket(positiveStore,positive),/disclosure-positive/);
  const changedStore=makeStore("synthetic-substituted-candidate"),stale=signedBlindingReview(changedStore);
  changedStore.append({eventType:"MessageSent",turn:1,phase:"diplomacy",participants:["b","a"],payload:{from:"b",to:"a",text:"A newly added coding candidate."}});
  assert.throws(()=>prepareCodingPacket(changedStore,stale),/mismatched/);
});

test("synthetic review packets require synthetic coders and cannot claim treatment blindness",()=>{
  const f=fixture();
  assert.equal(f.packet.input.treatment_blind,false);
  assert.equal(f.packet.input.blinding_review.promotable_to_empirical,false);
  assert.throws(()=>recordCoding(f.store,f.packet,{annotations:[],reviewedRefs:f.packet.input.observations.map(o=>o.ref),coder:{id:"human",version:"1",mode:"blinded_human"}}),/cannot be promoted/);
});

test("orthographic variants cannot duplicate one commitment opportunity", () => {
  const f = fixture(), row = f.commitment();
  const duplicate = { ...clone(row), id: "orthographic-duplicate",
    undertaking: `  ${row.undertaking.toUpperCase()}  `,
    future_condition: ` ${row.future_condition.toUpperCase().replaceAll(" ", "  ")} ` };
  assert.throws(() => validateAnnotations([row, duplicate], f.packet.input), /duplicate|opportunity/i);
});

for (const kind of ["commitment", "reciprocity", "repair"]) {
  test(`changing the annotation ID cannot duplicate a ${kind} opportunity`, () => {
    const f = fixture(), row = f[kind]();
    assert.equal(validateAnnotations([row], f.packet.input), true);
    assert.throws(() => validateAnnotations([row, { ...clone(row), id: "duplicate" }], f.packet.input), /duplicate|opportunity/i);
  });
  test(`${kind} cannot use its initiating evidence as its own outcome`, () => {
    const f = fixture(), row = f[kind]();
    if (kind === "reciprocity") row.responses[0].source = row.source;
    else if (kind === "repair") row.acts[0].source = row.source;
    else row.evaluation_ref = row.source;
    assert.throws(() => validateAnnotations([row], f.packet.input), /itself|initiating|temporal/i);
  });
}

test("a recipient listed among participants cannot be recoded as the response sender", () => {
  const f = fixture(), row = f.reciprocity(); row.responses[0].source = f.ref(3);
  assert.throws(() => validateAnnotations([row], f.packet.input), /roles|sender|directed/i);
});

test("breach requires the stated due turn even when evaluation is later than initiation", () => {
  const f = fixture(), row = f.commitment(); row.outcome = "BREACHED"; row.due_turn = 5;
  assert.throws(() => validateAnnotations([row], f.packet.input), /due|premature/i);
});

test("commitment due attribution requires canonical basis evidence", () => {
  const f=fixture(),row=f.commitment();delete row.due_basis_refs;
  assert.throws(()=>validateAnnotations([row],f.packet.input),/fields missing|basis references/);
  row.due_basis_refs=["observation-does-not-exist"];
  assert.throws(()=>validateAnnotations([row],f.packet.input),/formation evidence|dangling/);
});

test("commitment outcome evidence must involve its actor and counterparty", () => {
  const store=new EvidenceStore("synthetic-unrelated-commitment-evidence");
  store.append({eventType:"MessageSent",turn:0,phase:"communication",participants:["a","b"],payload:{from:"a",to:"b",text:"I will return it by turn 2."}});
  store.append({eventType:"MessageSent",turn:1,phase:"communication",participants:["c","d"],payload:{from:"c",to:"d",text:"An unrelated exchange."}});
  const packet=prepareSyntheticCodingPacket(store),[source,evaluation]=packet.input.observations;
  const row={id:"commitment",kind:"commitment",source:source.ref,actor:"subject-1",counterparty:"subject-2",eligibility:"ELIGIBLE",observation_status:"OBSERVED",confidence:1,ambiguity:null,undertaking:"return it",future_condition:"by turn 2",due_turn:2,due_basis_refs:[source.ref],outcome:"FULFILLED",evaluation_ref:evaluation.ref,evaluable:true};
  assert.throws(()=>validateAnnotations([row],packet.input),/evaluation parties absent/);
});

for (const status of ["MISSING_DUE_TO_BREACH", "MISSING_DUE_TO_SYSTEM_FAILURE"]) {
  for (const outcome of ["ONGOING_AT_HORIZON", "UNEVALUABLE", "AMBIGUOUS"]) {
    test(`${status} survives ${outcome} without becoming an observed denominator`, () => {
      const f = fixture(), row = { ...f.commitment(), outcome, evaluable: false, evaluation_ref: null,
        observation_status: status, eligibility: outcome === "AMBIGUOUS" ? "AMBIGUOUS" : "ELIGIBLE",
        ambiguity: outcome === "AMBIGUOUS" ? "Evidence unavailable for adjudication." : null };
      f.code([row]);
      const cell = f.derive().components.A.fulfillment;
      assert.equal(cell.denominator, 0); assert.equal(cell.value, null);
      assert.equal(cell.status_counts[status], 1);
      assert.notEqual(cell.status, "OBSERVED");
      if (outcome === "AMBIGUOUS") assert.equal(cell.ambiguity_count, 1);
    });
  }
}

test("unevaluable repair is preserved as unavailable, never an observed failed repair", () => {
  const f = fixture(), row = { ...f.repair(), outcome: "UNEVALUABLE", observation_status: "UNEVALUABLE",
    acts: [], sufficient_opportunity: false, evaluation_ref: null };
  f.code([row]);
  const cell = f.derive().components.C.restorative_act;
  assert.equal(cell.denominator, 0); assert.equal(cell.value, null);
  assert.equal(cell.status_counts.UNEVALUABLE, 1);
});

test("contradictory repair evaluability cannot produce observed zero performance", () => {
  const f = fixture(), row = { ...f.repair(), outcome: "UNEVALUABLE", acts: [], evaluation_ref: null };
  // Rejection or preserving an unavailable value are both safe contract outcomes.
  let result;
  try { f.code([row]); result = f.derive(); }
  catch (error) { assert.match(error.message, /unevaluable|opportunity|outcome|evaluation|status/i); return; }
  const cell = result.components.C.restorative_act;
  assert.equal(cell.value, null); assert.equal(cell.denominator, 0); assert.notEqual(cell.status, "OBSERVED");
});

test("an ambiguity-only early window cannot make a null D coordinate OBSERVED", () => {
  const f = fixture();
  f.code([{ ...f.commitment(), outcome: "AMBIGUOUS", eligibility: "AMBIGUOUS", ambiguity: "Unclear undertaking.",
    evaluable: false, evaluation_ref: null }, f.commitment("late", 16, 17, "BREACHED")]);
  const result = f.derive(), early = result.windows.early.components.A.fulfillment, change = result.components.D["A.fulfillment"];
  assert.equal(early.ambiguity_count, 1); assert.equal(early.value, null); assert.notEqual(early.status, "OBSERVED");
  assert.equal(change.value, null); assert.notEqual(change.status, "OBSERVED");
  assert.ok(change.missingness_reasons.includes(early.status)); assert.equal(change.imputed, false);
});

test("D retains distinct unavailable reasons from both windows", () => {
  const f = fixture();
  f.code([{ ...f.commitment(), observation_status: "MISSING_DUE_TO_BREACH" },
    { ...f.commitment("late", 16, 17), observation_status: "MISSING_DUE_TO_SYSTEM_FAILURE" }]);
  const change = f.derive().components.D["A.fulfillment"];
  assert.equal(change.value, null); assert.notEqual(change.status, "OBSERVED");
  assert.deepEqual(new Set(change.missingness_reasons), new Set(["MISSING_DUE_TO_BREACH", "MISSING_DUE_TO_SYSTEM_FAILURE"]));
});

test("mixed missingness is deterministic and D retains every reason regardless of annotation order", () => {
  const deriveOrder=reverse=>{
    const f=fixture();
    const breach={...f.commitment("breach-missing",1,2),undertaking:"first undertaking",observation_status:"MISSING_DUE_TO_BREACH"};
    const system={...f.commitment("system-missing",1,2),undertaking:"second undertaking",observation_status:"MISSING_DUE_TO_SYSTEM_FAILURE"};
    const late=f.commitment("late-observed",16,17);
    f.code([...(reverse?[system,breach]:[breach,system]),late]);
    const result=f.derive();return {early:result.windows.early.components.A.fulfillment,change:result.components.D["A.fulfillment"]};
  };
  const first=deriveOrder(false),second=deriveOrder(true);
  assert.equal(first.early.status,"MISSING_DUE_TO_BREACH","canonical status priority must not depend on annotation insertion order");
  assert.equal(second.early.status,first.early.status);
  assert.deepEqual(first.early.contributing_statuses,["MISSING_DUE_TO_BREACH","MISSING_DUE_TO_SYSTEM_FAILURE"]);
  assert.deepEqual(second.early.contributing_statuses,first.early.contributing_statuses);
  assert.deepEqual(first.change.missingness_reasons,["MISSING_DUE_TO_BREACH","MISSING_DUE_TO_SYSTEM_FAILURE"]);
  assert.deepEqual(second.change.missingness_reasons,first.change.missingness_reasons);
});

test("analysis manifests cannot replace the ratified component-specific temporal attribution", () => {
  const f = fixture(), row = f.commitment(); f.code([row]);
  f.options.manifest.window_attribution.commitment_outcome = "formation_turn";
  assert.throws(() => f.derive(), /ratified temporal attribution/);
});

test("unevaluable repair remains in its rupture window while an undued commitment is unattributed", () => {
  const f = fixture(), commitment = { ...f.commitment("undued", 3, 4), outcome: "ONGOING_AT_HORIZON", evaluable: false, evaluation_ref: null, due_turn: 21 };
  const repair = { ...f.repair(), outcome: "UNEVALUABLE", observation_status: "UNEVALUABLE", acts: [], sufficient_opportunity: false, evaluation_ref: null };
  f.code([commitment, repair]); const result=f.derive();
  assert.ok(result.windows.early.components.A.unattributed.some(item=>item.id===commitment.id));
  assert.equal(result.windows.early.components.C.outcomes.UNEVALUABLE,1);
  assert.equal(result.windows.late.components.C.outcomes.UNEVALUABLE,undefined);
});

test("independent archive loading still verifies the unmodified fixture", () => {
  const f = fixture(); f.code([f.commitment()]);
  assert.equal(loadEvidence(f.store.bundle()).verify(), true);
  assert.equal(f.derive().confirmatory_eligible, false);
});
