import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EvidenceStore } from "../src/evidence.js";
import { clone, sha256 } from "../src/core.js";
import { assertValidSchema } from "../src/schema.js";
import { ActionLedger, projectWorld } from "../src/contracts.js";
import { AgentRuntime, DeterministicModel, PILOT_0_AGENT_CONDITIONS, verifyConditionExposure, participantModelProjection } from "../src/agent.js";
import { MemoryStore } from "../src/memory.js";
import { Qwen35BaseAdapter, putRawPayload, PROVISIONAL_MODEL_PARAMETERS } from "../src/model-adapter.js";
import { Confidant, CONFIDANT_QUESTIONS } from "../src/confidant.js";
import { PILOT_0_CONFIG } from "../src/world.js";

// Every completion in this file is fabricated by an injected transport. No live
// endpoint, subprocess, weight loading, model sampling or calibration is used.
const MODEL = "Qwen/Qwen3.5-9B-Base";
const REVISION = "a".repeat(40);
function model(transport = async () => response(), options = {}) {
  return new Qwen35BaseAdapter({ model: MODEL, revision: REVISION, backend: "hf_endpoint", baseUrl: "https://synthetic.invalid/v1",
    artifactHash: "1".repeat(64), tokenizerHash: "2".repeat(64), runtimeHash: "3".repeat(64), synthetic: true, transport, ...options });
}
function response(text = ' {"type":"wait"} \n', options = {}) {
  return { status: 200, body: Buffer.from(JSON.stringify({ model: MODEL, hf_revision: REVISION,
    artifacts: { model_artifact_hash: "1".repeat(64), tokenizer_hash: "2".repeat(64) }, runtime_hash: "3".repeat(64),
    choices: [{ text, finish_reason: "stop" }], ...options })) };
}
function world(id = "synthetic-runtime") {
  const polities = Object.fromEntries(["p1", "p2"].map((id) => [id, { id, name: id, territory: [], population: 10,
    capital_hex_id:null,citizens:[],food:100,credits:50,resources:{},technologies:[],projects:[],shortage:0,growth_progress:0,advantages:[],disadvantages:[],takeover:null,
    facts:{hexes:{},territories:{},units:{},facilities:{},polities:{},deposits:{}},messages:[],reports:[],
    units: [], knowledge: [id], alive: true, memory: [], commitments: {} }]));
  const result = { runId: id, turn: 0, phase: "actions", polities, evidence: new EvidenceStore(id),
    config: clone(PILOT_0_CONFIG), snapshots: [],hexes:{},territories:{},facilities:{},channels:{},actionTypes:["wait"] };
  result.stateHash = () => sha256({ polities: result.polities, turn: result.turn });
  return result;
}
function runtime(w, m = model(), condition = PILOT_0_AGENT_CONDITIONS.persistent, actorId = "p1", options = {}) {
  return new AgentRuntime({ world: w, actorId, model: m, condition, now: () => 0, ...options });
}
function payload(evidence, ref) { const record = evidence.payloads.get(ref); assert.ok(record, `missing ${ref}`); assert.equal(sha256(record.bytes), ref); return JSON.parse(record.bytes); }
function raw(evidence, ref) { const data = payload(evidence, ref); const bytes = Buffer.from(data.data, "base64"); assert.equal(data.byte_length, bytes.length); assert.equal(data.raw_sha256, createHash("sha256").update(bytes).digest("hex")); return bytes; }
function diagnostics(evidence, event) { return event.provenance.input_refs.map((ref) => payload(evidence, ref)).find((item) => item.stage); }
function completed(w) { return w.evidence.events.filter((event) => event.event_type === "ModelInvocation" && diagnostics(w.evidence, event).stage === "complete"); }

test("synthetic: Base-only selection rejects instruct and other families", () => {
  for (const name of ["Qwen/Qwen3.5-9B", "Qwen/Qwen3-9B-Base", "Qwen/Qwen3.5-9B-Instruct", "other/model"]) assert.throws(() => model(undefined, { model: name }), /BASE required/);
  assert.equal(PROVISIONAL_MODEL_PARAMETERS.model, null);
});

test('synthetic: AI can submit the same atomic action batches as the human interface',async()=>{
  const w=world(), actions=[{type:'name',name:'Cedar'},{type:'wait'}];
  const result=await runtime(w,model(async()=>response(JSON.stringify({actions})))).invoke();
  assert.deepEqual(result.actions,actions);
  const invocation=w.evidence.events.findLast(event=>event.event_type==='ModelInvocation');
  assert.deepEqual(payload(w.evidence,invocation.payload.action_ref),{actions});
  assert.equal(result.projection.fields.find(f=>f.path==='public.rules').value.rules.action_limit,w.config.phases.actionLimit);
  const excessive=Array.from({length:w.config.phases.actionLimit+1},()=>({type:'wait'}));
  await assert.rejects(runtime(world('too-many'),model(async()=>response(JSON.stringify({actions:excessive})))).invoke(),/invalid_model_action/);
});

test('synthetic: identical human and AI payloads omit action_id and receive the same ledger-owned identity',async()=>{
  const input={type:'wait'};
  const canonical=async(ai)=>{
    const w=world('parity-ledger'),ledger=new ActionLedger(w.evidence),actorId='p1';
    const actions=ai?(await runtime(w,model(async()=>response(JSON.stringify(input)))).invoke()).actions:[input];
    return ledger.submit({runId:w.runId,turnId:'turn-0',actorId,actor:{persistent_identity_id:actorId,session_id:'s',invocation_id:'i'},actions,projection:projectWorld(w,actorId)});
  };
  const human=await canonical(false),ai=await canonical(true);
  assert.deepEqual(human.submitted_actions,[input]); assert.deepEqual(ai.submitted_actions,[input]);
  assert.equal(ai.actions[0].action_id,human.actions[0].action_id);
  assert.equal(ai.actions[0].action_id.startsWith('action_'),true);
});

test('synthetic: AI action parser rejects extra and server-owned fields at every payload depth',async()=>{
  const invalid=[{type:'wait',unexpected:true},{type:'wait',action_id:'forged'},{type:'wait',session_id:'forged'},
    {type:'message',text:'x',metadata:{invocation_id:'forged'}},
    {type:'message',text:'x',metadata:{nested:[{action_id:'forged'}]}}];
  for(const [index,action] of invalid.entries()){
    const w=world('invalid-action-'+index);
    await assert.rejects(runtime(w,model(async()=>response(JSON.stringify(action)))).invoke(),/invalid_model_action/);
    const event=w.evidence.events.findLast(item=>item.event_type==='ModelInvocation');
    assert.equal(event.payload.action_ref,null); assert.equal(raw(w.evidence,event.payload.rendered_output_ref).toString(),JSON.stringify(action));
  }
});

test("synthetic: missing model or immutable HF commit fails before transport", async () => {
  let calls = 0;
  const m = model(async () => { calls++; return response(); }, { model: null });
  await assert.rejects(m.complete({ prompt: "x", deadline: 100, now: () => 0 }), /not_configured/);
  await assert.rejects(model(undefined, { revision: "main" }).complete({ prompt: "x", deadline: 100, now: () => 0 }), /commit_pin/);
  assert.equal(calls, 0);
});

test("synthetic: exact prompt, HTTP request, raw envelope and output resolve", async () => {
  const w = world(); let sent;
  const exact = ' \n{"type":"name","name":"é 雪"}\r\n';
  const envelope = response(exact);
  const rt = runtime(w, model(async (request) => { sent = request; return envelope; }));
  const result = await rt.invoke();
  assert.deepEqual(result.action, { type: "name", name: "é 雪" });
  assert.equal(raw(w.evidence, result.requestRef).toString(), sent.body);
  assert.equal(raw(w.evidence, result.inputRef).toString(), JSON.parse(sent.body).prompt);
  assert.deepEqual(raw(w.evidence, result.responseRef), envelope.body);
  assert.equal(raw(w.evidence, result.outputRef).toString(), exact);
  assert.equal(JSON.parse(sent.body).messages, undefined);
  assert.match(sent.url, /\/completions$/);
  assert.equal(completed(w).length, 1); w.evidence.verify();
});

test("synthetic: raw evidence preserves invalid UTF8 without replacement", () => {
  const evidence = new EvidenceStore("raw"); const bytes = Buffer.from([0, 255, 254, 13, 10]);
  assert.deepEqual(raw(evidence, putRawPayload(evidence, bytes)), bytes);
});

test("synthetic: retries retain identical input, new invocation IDs and causal lineage", async () => {
  const w = world(); let calls = 0; const requests = [];
  const rt = runtime(w, model(async (request) => { requests.push(request.body); return ++calls === 1 ? { status: 503, body: Buffer.from("unavailable") } : response(); }));
  await rt.invoke(); const events = completed(w);
  assert.equal(events.length, 2); assert.equal(events[1].payload.retry_of, events[0].payload.invocation_id);
  assert.notEqual(events[0].payload.invocation_id, events[1].payload.invocation_id);
  assert.equal(requests[0], requests[1]); assert.equal(events[1].payload.attempt, 2); w.evidence.verify();
});

test("synthetic: technical failure retry cap is enforced", async () => {
  const w = world(); let calls = 0;
  await assert.rejects(runtime(w, model(async () => { calls++; throw new Error("socket"); })).invoke(), /transport_failure/);
  assert.equal(calls, PROVISIONAL_MODEL_PARAMETERS.max_attempts); assert.equal(completed(w).length, calls); w.evidence.verify();
});

test("synthetic: expired deadline submits no transport request", async () => {
  const w = world(); let calls = 0;
  await assert.rejects(runtime(w, model(async () => { calls++; return response(); })).invoke({ deadline: 0 }), /deadline/);
  assert.equal(calls, 0); assert.equal(completed(w).length, 1);
});

test("synthetic: late output is archived and lost with no retry", async () => {
  const w = world(); let clock = 0; let calls = 0;
  const rt = runtime(w, model(async () => { calls++; clock = w.config.phases.actionBudgetMs + 1; return response(); }), undefined, "p1", { now: () => clock });
  await assert.rejects(rt.invoke(), /late_model_output/); assert.equal(calls, 1);
  const event = completed(w)[0]; const diagnostic = diagnostics(w.evidence, event);
  assert.ok(raw(w.evidence, diagnostic.response_ref).length > 0); assert.equal(event.payload.action_ref, null); w.evidence.verify();
});

test("synthetic: uncooperative HTTP transport cannot exceed the phase deadline", async () => {
  const w = world(); let calls = 0, clock = 0;
  // Freeze fixture time during synchronous evidence preparation; this test
  // targets the real abort timer after dispatch, not scheduler-dependent setup.
  const rt = runtime(w, model(({signal}) => { calls++; signal.addEventListener('abort',()=>{clock=15;},{once:true}); return new Promise(() => {}); }), undefined, "p1", { now: () => clock });
  await assert.rejects(rt.invoke({ deadline: 15 }), /timeout|deadline/);
  assert.equal(calls, 1); w.evidence.verify();
});

test("synthetic: malformed or partial actions are never repaired or retried", async () => {
  for (const completion of [response("```json\n{}\n```"), response("{}"), response('{"type":"wait"}', { choices: [{ text: '{"type":"wait"}', finish_reason: "length" }] })]) {
    const w = world(); let calls = 0;
    await assert.rejects(runtime(w, model(async () => { calls++; return completion; })).invoke(), /invalid_model_action|partial_model_output/);
    assert.equal(calls, 1); assert.equal(completed(w)[0].payload.action_ref, null); w.evidence.verify();
  }
});

test("synthetic: served model and revision substitutions fail closed", async () => {
  for (const extra of [{ model: "Qwen/Qwen3.5-9B" }, { hf_revision: "b".repeat(40) }]) {
    const w = world(); await assert.rejects(runtime(w, model(async () => response(undefined, extra))).invoke(), /mismatch/);
    assert.equal(completed(w).length, 1);
  }
});

test("synthetic: probe uses GET only and never claims generation validation", async () => {
  const requests = []; const m = model(async (request) => { requests.push(request); return { status: 200, body: JSON.stringify({ data: [{ id: MODEL }] }) }; });
  const result = await m.probe(); assert.equal(result.available, true); assert.equal(result.live_validated, false);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, "GET"); assert.equal(requests[0].body, undefined);
});

test("synthetic: condition objects conform and deep mutation is rejected", () => {
  for (const condition of Object.values(PILOT_0_AGENT_CONDITIONS)) assertValidSchema(condition, "agent-condition.schema.json");
  assert.throws(() => { PILOT_0_AGENT_CONDITIONS.persistent.identity.history_access_policy = "other"; }, TypeError);
  const changed = clone(PILOT_0_AGENT_CONDITIONS.persistent); changed.retry.max_attempts++;
  assert.throws(() => runtime(world(), model(), changed), /frozen/);
});

test("synthetic: run invariants reject different model sampling and memory capacity", () => {
  const w = world(); runtime(w);
  assert.throws(() => runtime(w, model(undefined, { sampling: { ...PROVISIONAL_MODEL_PARAMETERS.sampling, temperature: 0.5 } }), undefined, "p2"), /invariant/);
  w.config.memory.capacity++;
  assert.throws(() => runtime(w, model(), undefined, "p2"), /invariant/);
});

test("synthetic: empty persistent memory is valid; nonpersistent memory never enters prompts", async () => {
  const w = world(); const prompts = []; const transport = async (request) => { prompts.push(JSON.parse(request.body).prompt); return response(); };
  const p = runtime(w, model(transport)); const n = runtime(w, model(transport), PILOT_0_AGENT_CONDITIONS.nonpersistent, "p2");
  await p.invoke(); p.memory.write("retained-experience-canary", p.sessionId, "synthetic-edit"); await p.invoke(); await n.invoke();
  assert.match(prompts[1], /retained-experience-canary/); assert.doesNotMatch(prompts[2], /retained-experience-canary/);
  assert.throws(() => n.memory.write("x", n.sessionId, "edit"), /inaccessible/);
  verifyConditionExposure(completed(w).map((event) => event.payload)); w.evidence.verify();
});

test("synthetic: deterministic explicitly injected model retains synchronous interface", () => {
  const w = world(); const rt = runtime(w, new DeterministicModel("test"));
  const first = rt.invoke(); const second = rt.invoke(); assert.ok(first.action); assert.notEqual(first.invocationId, second.invocationId); w.evidence.verify();
});

test("synthetic: reset preserves experimental identity and archives recovery lineage", async () => {
  for (const condition of Object.values(PILOT_0_AGENT_CONDITIONS)) {
    const w = world(); const rt = runtime(w, model(), condition); const before = rt.sessionId;
    rt.reset({ reason: "synthetic_crash", recoveryOf: "synthetic-parent-session" });
    assert.notEqual(rt.sessionId, before); assert.equal(rt.experimentalIdentityId, "p1");
    await rt.invoke(); assert.ok(w.evidence.events.some((event) => event.event_type === "MemoryOperation" && event.payload.operation === "recover")); w.evidence.verify();
  }
});

test("synthetic: eliminated actors cannot invoke, edit memory or reset", () => {
  const w = world(); const rt = runtime(w); w.polities.p1.alive = false;
  assert.throws(() => rt.invoke(), /eliminated/); assert.throws(() => rt.reset(), /eliminated/);
  assert.throws(() => rt.memory.write("x", rt.sessionId, "edit"), /eliminated/);
});

test("synthetic: projection rejects unknown fields and foreign audience", () => {
  const w = world(); const p = projectWorld(w, "p1"); p.fields.push({ path: "observer_truth", value: "secret", source_event_refs: [], audience: "p1" });
  assert.throws(() => participantModelProjection(p, { runId: w.runId, actorId: "p1", turn: 0 }), /unauthorized/);
  p.fields.pop(); p.fields[0].audience = "p2";
  assert.throws(() => participantModelProjection(p, { runId: w.runId, actorId: "p1", turn: 0 }), /unauthorized/);
});

function memory(capacity = 80) { const evidence = new EvidenceStore("synthetic-memory"); return new MemoryStore({ runId: evidence.runId, identityId: "p1", evidence, capacity, sessionId: "s" }); }
test("synthetic: remember/edit/revise/forget/compress/clear preserve exact requests", () => {
  const m = memory(); const a = m.write("alpha", "s", "i1"); const b = m.write("beta", "s", "i2");
  m.edit(a, "alpha!", "s", "i3"); m.revise(b, "β", "s", "i4");
  const c = m.compress([a, b], "  compact\r\n", "s", "i5"); assert.equal(m.currentText, "  compact\r\n");
  m.forget(c, "s", "i6"); assert.equal(m.currentText, ""); m.clear("s", "i7"); m.read({ sessionId: "s", invocationId: "i8" });
  for (const event of m.evidence.events) for (const ref of [...event.payload.input_refs, event.payload.output_ref, event.payload.availability_ref]) payload(m.evidence, ref);
  m.evidence.verify();
});

test("synthetic: UTF8 and newline capacity rejects overflow atomically", () => {
  const m = memory(5); const id = m.write("é", "s", "i1"); m.write("é", "s", "i2");
  const before = clone(m.records); const events = m.evidence.events.length;
  assert.throws(() => m.write("", "s", "i3"), /capacity/); assert.throws(() => m.revise(id, "longer", "s", "i4"), /capacity/);
  assert.deepEqual(m.records, before); assert.equal(m.evidence.events.length, events);
});

test("synthetic: archive failure cannot commit a memory edit", () => {
  const m = memory(); const append = m.evidence.append.bind(m.evidence); m.evidence.append = () => { throw new Error("synthetic archive failure"); };
  assert.throws(() => m.write("lost", "s", "i"), /archive failure/); assert.equal(m.records.length, 0); assert.equal(m.sequence, 0);
  m.evidence.append = append; m.write("kept", "s", "i2"); m.evidence.verify();
});

test("synthetic: memory validates sessions, selection, types, and immutable copies", () => {
  const m = memory(); const id = m.write("a", "s", "i");
  assert.throws(() => m.write({}, "s", "i"), /exact string/); assert.throws(() => m.read({ sessionId: "other", invocationId: "i" }), /unauthorized/);
  assert.throws(() => m.compress([id, id], "b", "s", "i"), /selection/); assert.throws(() => m.forget("unknown", "s", "i"), /unknown/);
  assert.throws(() => { m.records[0].text = "injected"; }, TypeError); assert.equal(m.currentText, "a");
});

test("synthetic: memory recovery requires exact current hash and revokes old session", () => {
  const m = memory(); m.write("retained", "s", "i");
  assert.throws(() => m.recover({ sessionId: "s", nextSessionId: "new", invocationId: "r", expectedHash: "bad" }), /hash mismatch/);
  m.recover({ sessionId: "s", nextSessionId: "new", invocationId: "r", expectedHash: sha256(m.records) });
  assert.throws(() => m.read({ sessionId: "s", invocationId: "r2" }), /unauthorized/);
  assert.equal(m.read({ sessionId: "new", invocationId: "r3" })[0].text, "retained"); m.evidence.verify();
});

function snapshot(w) { const state = { run_id: w.runId, turn: w.turn, phase: w.phase, polities: clone(w.polities) }; const item = { turn: w.turn, state, state_hash: sha256(state) }; w.snapshots.push(item); return item; }
test("synthetic: confidant shares one snapshot with no cross-answer or gameplay writeback", async () => {
  const w = world(); const prompts = []; let calls = 0;
  const transport = async (request) => { prompts.push(JSON.parse(request.body).prompt); calls++; await Promise.resolve(); return response(`private-answer-canary-${calls}`); };
  const p1 = runtime(w, model(transport)); const p2 = runtime(w, model(transport), PILOT_0_AGENT_CONDITIONS.nonpersistent, "p2"); snapshot(w);
  const before = { state: w.stateHash(), memory: sha256(p1.memory.records), sequence: p1.memory.sequence, session: p1.sessionId, invocations: p1.invocationCount };
  const reports = await new Confidant({ world: w, now: () => 0 }).interviewAll([p1, p2]);
  assert.ok(reports.every((report) => report.status === "recorded")); assert.equal(calls, 2);
  for (const prompt of prompts) { assert.doesNotMatch(prompt, /private-answer-canary|observer_truth|source_state_hash/); for (const question of CONFIDANT_QUESTIONS.questions) assert.ok(prompt.includes(question)); }
  assert.doesNotMatch(prompts[0], /"p2"/); assert.doesNotMatch(prompts[1], /"p1"/);
  assert.deepEqual({ state: w.stateHash(), memory: sha256(p1.memory.records), sequence: p1.memory.sequence, session: p1.sessionId, invocations: p1.invocationCount }, before);
  const interviews = w.evidence.events.filter((event) => event.event_type === "InterviewResponse");
  assert.equal(interviews.length, 2); for (const event of interviews) { assert.equal(event.visibility.acl_ref, "observer"); payload(w.evidence, event.payload.isolation_proof_ref); raw(w.evidence, event.payload.response_payload_ref); }
  w.evidence.verify();
});

test("synthetic: confidant rejects missing snapshot, eliminated and duplicate principals", async () => {
  const w = world(); const rt = runtime(w); const interviewer = new Confidant({ world: w, now: () => 0 });
  await assert.rejects(interviewer.interviewAll([rt]), /snapshot/); snapshot(w);
  await assert.rejects(interviewer.interviewAll([rt, rt]), /duplicate/); w.polities.p1.alive = false;
  await assert.rejects(interviewer.interviewAll([rt]), /eliminated/);
});

test("synthetic: empirical mode rejects both deterministic and injected model doubles", () => {
  for (const m of [new DeterministicModel(), model()]) {
    const w = world(); w.executionMode = "empirical"; w.config.executionMode='empirical';
    assert.throws(() => runtime(w, m), /synthetic model prohibited/);
  }
});

test("synthetic: phase budget cannot be renewed by another invocation", async () => {
  const w = world(); let clock = 0; let calls = 0;
  const rt = runtime(w, model(async () => { calls++; return response(); }), undefined, "p1", { now: () => clock });
  await rt.invoke(); clock = w.config.phases.actionBudgetMs + 1;
  await assert.rejects(rt.invoke(), /deadline/); assert.equal(calls, 1);
});

test("synthetic: hidden foreign mutation leaves actual model request unchanged", async () => {
  const prompts = [];
  for (const hidden of ["secret-one", "secret-two"]) {
    const w = world(); w.polities.p2.name = hidden;
    await runtime(w, model(async (request) => { prompts.push(request.body); return response(); })).invoke();
  }
  assert.equal(prompts[0], prompts[1]); assert.doesNotMatch(prompts[0], /secret-one|secret-two|observer_truth/);
});

test("synthetic: same model name with another HF revision violates run invariants", () => {
  const w = world(); runtime(w);
  assert.throws(() => runtime(w, model(undefined, { revision: "b".repeat(40) }), undefined, "p2"), /invariant/);
});

test("synthetic: runtime detects configuration changes after construction", () => {
  const w = world(); const rt = runtime(w); w.config.phases.actionBudgetMs += 1;
  assert.throws(() => rt.invoke(), /frozen runtime configuration changed/);
});

test("synthetic: memory retrieval and edits link to the exact gameplay invocation inputs", async () => {
  const w = world(); w.phase='memory_update';
  const request={operation:'REMEMBER',text:'chosen'};
  const rt = runtime(w,model(async()=>response(JSON.stringify(request)))); const result = await rt.invoke();
  const read = w.evidence.events.find((event) => event.event_type === "MemoryOperation" && event.payload.operation === "read");
  assert.equal(read.payload.invocation_ref, result.invocationId);
  assert.deepEqual(result.memoryOperation,request);
  rt.applyMemoryOperation(result.memoryOperation, { invocationId: result.invocationId });
  const edit = w.evidence.events.at(-1); assert.ok(edit.payload.input_refs.includes(result.inputRef));
  assert.ok(edit.payload.input_refs.includes(result.outputRef));
  assert.throws(() => rt.applyMemoryOperation({ operation: "REMEMBER", text: "unattributed" }, { invocationId: "unknown" }), /provenance/);
  w.evidence.verify();
});

test("synthetic: caller cannot override authoritative empirical mode or change it after construction", () => {
  const w = world(); w.executionMode = "empirical";
  assert.throws(() => runtime(w, new DeterministicModel(), undefined, "p1", { executionMode: "synthetic" }), /authoritative world mode/);
  delete w.executionMode; w.config.executionMode = "empirical";
  assert.throws(() => runtime(w, model(), undefined, "p1", { executionMode: "synthetic" }), /authoritative world mode/);
  delete w.config.executionMode; const rt = runtime(w); w.executionMode = "empirical";
  assert.throws(() => rt.invoke(), /authoritative world mode/);
});

test("synthetic: empirical admission rejects missing locks before emitting or dispatching", () => {
  const w = world(); w.executionMode = "empirical"; w.config.executionMode='empirical';
  const rt = new AgentRuntime({ world: w, actorId: "p1", model: new Qwen35BaseAdapter({ artifactHash: null }) });
  const before = w.evidence.events.length;
  assert.throws(() => rt.invoke(), /missing_model_artifact_hash|configuration_drift/);
  assert.equal(w.evidence.events.length, before);
});
