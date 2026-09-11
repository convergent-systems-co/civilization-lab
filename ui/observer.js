import { $, el, entries, facts, cards, sessionClient } from "./common.js";
import { drawMap, mapData } from "./map.js";
let state = null, replayEpoch = 0;
const client = sessionClient(clear);
function clear() {
  state = null; replayEpoch++; $("research").hidden = true; $("login").hidden = false; $("refresh").hidden = true; $("logout").hidden = true;
  $("credential").value = ""; $("status").textContent = "Signed out"; $("error").hidden = true;
  for (const id of ["summary", "map", "tile-detail", "tile-facts", "gates", "run-manifest", "replay-principal", "replay-status", "events", "event-count", "raw-event", "raw-payload", "payload-links", "diplomacy", "memory-current", "memory-events", "interviews", "intelligence", "integrity-events", "runtime-events", "analysis", "polity-dashboards", "export-status"]) $(id).replaceChildren();
  $("filters").reset();
  $("run-disposition").replaceChildren();
  for (const id of ["filter-phase", "filter-type", "filter-polity", "filter-visibility"]) while ($(id).options.length > 1) $(id).remove(1);
  $("event-title").textContent = "Raw event & provenance"; $("raw-payload").hidden = true; $("events-empty").hidden = true;
  $("replay-turn").max = "0"; $("replay-turn").value = "0"; $("replay-turn-label").textContent = "0";
  $("replay-view").value = "truth"; $("replay").disabled = true; $("view-badge").textContent = "Observer truth";
  document.title = "CivilizationLab · Observer";
}
function error(message) { $("error").textContent = message; $("error").hidden = false; }
function evidenceFailure(e, fallback) {
  if (e.data?.gates?.status === "REPLAY_INCOMPLETE_REDACTED") return "REPLAY_INCOMPLETE_REDACTED — research contents withheld. Exact reconstruction is unavailable.";
  if (e.data?.gates?.status === "EVIDENCE_INTEGRITY_FAILED") return "EVIDENCE_INTEGRITY_FAILED — evidence hash or integrity validation failed. Research content has been withheld; replay and export are unavailable.";
  if (e.message === "research_evidence_unavailable") return "RESEARCH_EVIDENCE_UNAVAILABLE — evidence access was invalidated or quarantined. Research content and session have been cleared.";
  return fallback;
}
function sourceButton(event) {
  const button = el("button", event.event_id, "source-button"); button.type = "button";
  button.addEventListener("click", () => inspect(event)); return button;
}
function inspect(event) {
  $("event-title").textContent = `${event.event_type} · sequence ${event.sequence}`;
  $("raw-event").textContent = JSON.stringify(event, null, 2); $("payload-links").replaceChildren(); $("raw-payload").hidden = true; $("raw-payload").textContent = "";
  const serialized = JSON.stringify(event);
  for (const [digest, payload] of Object.entries(state.evidence.payloads ?? {})) {
    if (!serialized.includes(digest)) continue;
    const button = el("button", `Raw payload ${digest}`, "source-button"); button.type = "button";
    button.addEventListener("click", () => { $("raw-payload").hidden = false; $("raw-payload").textContent = payload.bytes; }); $("payload-links").append(button);
  }
  $("event-title").focus(); $("event-detail").scrollIntoView({ block: "start" });
}
function timeline(target, pattern) {
  target.replaceChildren();
  for (const event of state.evidence.events.filter(e => pattern.test(e.event_type))) {
    const row = el("article", "", "timeline-row"), content = el("div");
    const detail = el("details"), summary = el("summary", "Recorded payload"); detail.append(summary, el("pre", JSON.stringify(event.payload, null, 2), "raw"));
    content.append(el("strong", event.event_type), event.payload.text !== undefined ? el("p", event.payload.text) : el("p", event.participants.join(" · "), "muted small"), sourceButton(event), detail);
    row.append(el("span", `Turn ${event.turn}`, "muted small"), content); target.append(row);
  }
  if (!target.children.length) target.append(el("p", "No recorded events of this kind.", "muted"));
}
function payload(ref) {
  const stored = state.evidence.payloads?.[ref];
  if (!stored) return null;
  try { return JSON.parse(stored.bytes); } catch { return null; }
}
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
async function responseText(ref, evidence) {
  const stored = evidence.payloads?.[ref];
  if (!stored || await digest(new TextEncoder().encode(stored.bytes)) !== ref) throw new Error("invalid payload");
  const value = JSON.parse(stored.bytes);
  if (value?.encoding !== "base64") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const raw = atob(value.data), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (btoa(raw) !== value.data || bytes.length !== value.byte_length || await digest(bytes) !== value.raw_sha256) throw new Error("invalid raw envelope");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function memoryArchive() {
  const events = state.evidence.events.filter(e => e.event_type === "MemoryOperation"), latest = new Map(), birth = new Map();
  $("memory-events").replaceChildren();
  for (const event of events) {
    const before = payload(event.payload.input_refs?.[0]), after = payload(event.payload.output_ref);
    if (!before?.records || !after?.records) continue;
    latest.set(event.payload.identity_ref, { event, after });
    const prior = new Map(before.records.map(r => [r.id, r])), next = new Map(after.records.map(r => [r.id, r]));
    const changes = [];
    for (const record of after.records) {
      if (!prior.has(record.id)) { birth.set(record.id, event.turn); changes.push(`Added: ${record.text}`); }
      else if (prior.get(record.id).text !== record.text) changes.push(`Revised from: ${prior.get(record.id).text}\nRevised to: ${record.text}`);
    }
    for (const record of before.records) if (!next.has(record.id)) changes.push(`Removed${birth.has(record.id) ? ` after ${event.turn - birth.get(record.id)} turns` : ""}: ${record.text}`);
    const details = el("details"); details.append(el("summary", `Turn ${event.turn} · ${event.payload.identity_ref} · ${event.payload.operation}`), el("pre", changes.length ? changes.join("\n\n") : "No textual change.", "raw"), sourceButton(event));
    $("memory-events").append(details);
  }
  $("memory-current").replaceChildren();
  for (const [identity, { event, after }] of latest) {
    const card = el("article", "", "item-card"); card.append(el("h3", identity), el("pre", after.text, "prose"), el("p", `Latest committed memory · turn ${event.turn}`, "muted small"), sourceButton(event)); $("memory-current").append(card);
  }
  if (!latest.size) $("memory-current").append(el("p", "No committed memory archive in the supplied evidence.", "muted"));
}
function renderMap(data) {
  let map;
  if (data.projection) {
    const fields = data.projection.fields;
    const field = path => fields.find(f => f.path === path)?.value;
    map = mapData(field("own.polity_state") ?? {}, { ...(field("public.discovered_world_state") ?? {}), ...(field("public.known_map") ? { map: field("public.known_map") } : {}), ...(field("public.known_territories") ? { territories: field("public.known_territories") } : {}), known: field("own.intelligence")?.facts ?? field("own.knowledge") ?? {} });
    $("view-badge").textContent = "Historical polity knowledge";
  } else {
    const world = data.world;
    map = { hexes: entries(world.hexes ?? world.map?.hexes ?? world.territories), territories: entries(world.territories), facilities: entries(world.facilities).concat(Object.values(world.polities).flatMap(p => entries(p.facilities))), units: Object.values(world.polities).flatMap(p => entries(p.units)), neutralUnits: entries(world.neutral_units), populations: entries(world.unaffiliated_population), ownId: null };
    $("view-badge").textContent = "Observer truth";
  }
  $("tile-facts").replaceChildren(); $("tile-detail").textContent = "Select a hex to inspect.";
  drawMap($("map"), map, { onSelect(tile) { $("tile-detail").textContent = tile.description; const { cx, cy, description, ...detail } = tile; facts($("tile-facts"), detail); } });
}
function filterOptions(id, values) {
  const previous = $(id).value; while ($(id).options.length > 1) $(id).remove(1);
  for (const value of [...new Set(values)].filter(Boolean).sort()) { const option = el("option", value); option.value = value; $(id).append(option); } $(id).value = previous;
}
function renderAnalysis(analysis) {
  const target = $("analysis"); target.replaceChildren();
  if (!analysis) { target.append(el("p", "No versioned statistical output supplied. No endpoint estimates are inferred from the UI.", "muted")); return; }
  const manifest = el("div"); facts(manifest, { evidence_class: analysis.evidence_class, experimental_unit: analysis.experimental_unit, independent_runs: analysis.independent_replicates, representation: analysis.representation, confirmatory_eligible: analysis.confirmatory_eligible }); target.append(manifest);
  const wrap = el("div", "", "table-wrap"), table = el("table"), head = el("thead"), row = el("tr"), body = el("tbody");
  table.append(el("caption", "Four-block endpoint: A fulfillment · B reciprocity · C repair · D late–early change"));
  for (const title of ["Block / coordinate", "Value", "Numerator / denominator", "Status", "Weighted value", "Canonical sources"]) { const th = el("th", title); th.scope = "col"; row.append(th); } head.append(row); table.append(head, body);
  for (const block of ["A", "B", "C", "D"]) for (const [coordinate, cell] of Object.entries(analysis.components?.[block] ?? {})) {
    if (coordinate === "outcomes") continue;
    const tr = el("tr"), refs = el("td");
    const sourceIds = [...new Set(cell.source_event_refs ?? [...(cell.early?.source_event_refs ?? []), ...(cell.late?.source_event_refs ?? [])])];
    for (const id of sourceIds) { const event = state.evidence.events.find(e => e.event_id === id); refs.append(event ? sourceButton(event) : el("span", `${id} (source unavailable in this view)`)); }
    tr.append(el("td", `${block} / ${coordinate}`), el("td", cell.value ?? "Unavailable"), el("td", cell.numerator === undefined ? "Paired run windows" : `${cell.numerator} / ${cell.denominator}`), el("td", cell.status), el("td", analysis.primary_endpoint_value?.[block]?.[coordinate] ?? "Unavailable"), refs); body.append(tr);
  }
  wrap.append(table); target.append(wrap);
  const details = el("details"), content = el("div"); facts(content, { windows: analysis.windows, turn_series: analysis.turn_series, provenance: analysis.provenance }); details.append(el("summary", "Windows, missingness & analysis provenance"), content); target.append(details);
  if (analysis.provenance?.coding_event_id) { const source = state.evidence.events.find(e => e.event_id === analysis.provenance.coding_event_id); if (source) target.append(sourceButton(source)); }
}
function render(data) {
  state = data; $("research").hidden = false; $("login").hidden = true; $("refresh").hidden = false; $("logout").hidden = false; $("status").textContent = "Research authorized";
  const world = data.world, polities = Object.values(world.polities), events = data.evidence.events;
  const disposition = events.findLast(e => e.event_type === "RunDisposition" && ["invalid", "contaminated", "interrupted", "incomplete"].includes(e.payload.execution_status)) ?? events.findLast(e => e.event_type === "RunDisposition");
  const notice = $("run-disposition"), adverse = disposition && disposition.payload.execution_status !== "complete";
  notice.className = adverse ? "notice danger" : "notice"; notice.setAttribute("role", adverse ? "alert" : "status");
  notice.replaceChildren();
  if (disposition) {
    const p = disposition.payload;
    notice.append(el("strong", `Run ${p.execution_status.toUpperCase()}`), el("p", `Confirmatory eligible: ${p.experimental_validity.confirmatory_eligible}. Primary endpoint eligible: ${p.endpoint_eligibility.primary_confirmatory}. Evidence remains available for authorized review.`), sourceButton(disposition));
  } else notice.append(el("p", "No run disposition recorded. Research authorization does not establish experimental eligibility."));
  document.title = `CivilizationLab · Observer · ${world.run_id}`;
  $("summary").replaceChildren();
  const affiliatedPopulation=polities.reduce((sum,p)=>sum+(typeof p.population==="number"?p.population:0),0),unaffiliatedPopulation=entries(world.unaffiliated_population).reduce((sum,g)=>sum+(Number(g.count)||0),0);
  for (const [name, value] of [["Current turn", world.turn], ["Active polities", polities.filter(p => p.alive).length], ["Total population", affiliatedPopulation+unaffiliatedPopulation], ["Unaffiliated population", unaffiliatedPopulation], ["Inactive neutral units", entries(world.neutral_units).length], ["Canonical events", events.length]]) { const item = el("div"); item.append(el("span", name, "eyebrow"), el("strong", value)); $("summary").append(item); }
  facts($("gates"), data.gates);
  facts($("run-manifest"), { run: world.run_id, seed: world.seed, phase: world.phase, configuration: world.config, evidence_head: events.at(-1)?.integrity?.canonical_bytes_hash });
  const snapshotTurns = events.filter(e => e.event_type === "SnapshotCreated").map(e => e.turn);
  $("replay-turn").max = String(Math.max(0, ...snapshotTurns)); $("replay-turn").value = $("replay-turn").max; $("replay-turn-label").textContent = $("replay-turn").value;
  $("replay").disabled = !snapshotTurns.length || !data.gates?.state_replay;
  $("replay-principal").replaceChildren();
  for (const p of polities) { const option = el("option", `${p.name} · ${p.id}`); option.value = p.id; $("replay-principal").append(option); }
  renderMap(data);
  $("replay-status").textContent = "Current state";
  $("replay-view").value = "truth";
  filterOptions("filter-type", events.map(e => e.event_type)); filterOptions("filter-phase", events.map(e => e.phase)); filterOptions("filter-polity", events.flatMap(e => e.participants)); filterOptions("filter-visibility", events.map(e => e.visibility.classification));
  renderEvents();
  timeline($("diplomacy"), /Message|Broadcast|Channel/);
  memoryArchive();
  $("interviews").replaceChildren();
  for (const event of events.filter(e => e.event_type === "InterviewResponse")) {
    const row = el("tr"), body = el("td"), response = el("pre", "Verifying response payload…", "raw");
    body.append(el("p", event.payload.question_version), response); const source = el("td"); source.append(sourceButton(event));
    row.append(el("td", event.turn), el("td", event.participants.join(" · ")), body, source); $("interviews").append(row);
    responseText(event.payload.response_payload_ref, data.evidence).then(text => {
      if (state === data && row.isConnected) response.textContent = text;
    }, () => { if (state === data && row.isConnected) response.textContent = "Response payload unavailable or invalid. Inspect raw evidence for provenance."; });
  }
  timeline($("intelligence"), /Intelligence|Reconnaissance|Detection|Attribution|Battle|Conflict|Rng|RNG/);
  timeline($("integrity-events"), /Violation|Security|Breach|Disposition|Retry|Timeout|Recovery|Intervention|Redaction|Continuity|Failure|Stop/);
  timeline($("runtime-events"), /Model|Runtime|Invocation|ProjectionIssued/);
  renderAnalysis(data.analysis);
  const coded = el("div"); timeline(coded, /CommitmentCoded|Metric|Analysis/); $("analysis").append(coded);
  cards($("polity-dashboards"), polities, "No polity state.");
}
function renderEvents() {
  if (!state) return;
  const term = id => $(id).value.trim().toLowerCase();
  const events = state.evidence.events.filter(event => {
    const raw = JSON.stringify(event).toLowerCase();
    return (!term("filter-turn") || String(event.turn) === term("filter-turn")) && (!term("filter-sequence") || String(event.sequence) === term("filter-sequence")) && (!term("filter-phase") || event.phase.toLowerCase() === term("filter-phase")) && (!term("filter-type") || event.event_type.toLowerCase() === term("filter-type")) && (!term("filter-polity") || event.participants.some(p => p.toLowerCase() === term("filter-polity"))) && (!term("filter-visibility") || event.visibility.classification.toLowerCase() === term("filter-visibility")) && ["filter-search", "filter-channel", "filter-lineage", "filter-condition", "filter-integrity", "filter-run"].every(id => !term(id) || raw.includes(term(id)));
  });
  $("events").replaceChildren(); $("event-count").textContent = `${events.length} / ${state.evidence.events.length} events`; $("events-empty").hidden = events.length > 0;
  for (const event of events) { const row = el("tr"), source = el("td"); source.append(sourceButton(event)); row.append(el("td", event.sequence), el("td", `${event.turn} / ${event.phase}`), el("td", event.event_type), el("td", event.participants.join(" · ")), el("td", event.visibility.classification), source); $("events").append(row); }
}
async function refresh() {
  const data = await client.request("/api/observer"); replayEpoch++; render(data);
  try { const result = await client.request("/api/observer/analysis"); if (state === data) renderAnalysis(result.analysis); }
  catch (e) {
    // A missing analysis manifest is an expected request-shape requirement: the
    // verified Observer evidence remains valid and visible without statistics.
    // Every other failure may mean the evidence was redacted, corrupted,
    // quarantined, or made run-invalid after the first response. Propagate it so
    // the session handler clears the credential and all already-rendered bytes.
    if (e.message !== "analysis_manifest_required") throw e;
  }
}
$("session").addEventListener("submit", async event => { event.preventDefault(); const token = $("credential").value; client.clear(); client.open(token); $("credential").value = ""; try { await refresh(); $("research-heading").focus(); } catch (e) { if (e.message !== "stale_session") { client.clear(); error(evidenceFailure(e, "Unable to open research view. Check your credential and evidence availability.")); } } });
$("logout").addEventListener("click", () => { client.clear(); $("credential").focus(); });
$("refresh").addEventListener("click", async () => { try { await refresh(); } catch (e) { if (e.message !== "stale_session") { client.clear(); error(evidenceFailure(e, "Evidence refresh failed. Research content has been cleared.")); } } });
$("filters").addEventListener("submit", event => event.preventDefault()); $("filters").addEventListener("input", renderEvents);
$("replay-turn").addEventListener("input", () => { $("replay-turn-label").textContent = $("replay-turn").value; });
$("replay").addEventListener("click", async () => {
  const epoch = ++replayEpoch;
  const query = new URLSearchParams({ turn: $("replay-turn").value, view: $("replay-view").value, principal: $("replay-principal").value });
  $("replay-status").textContent = "Verifying and reconstructing recorded state…";
  try { const result = await client.request(`/api/observer/replay?${query}`); if (epoch !== replayEpoch) return; renderMap(result); facts($("gates"), result.gates); $("replay-status").textContent = `${result.gates.status} · completed turn ${result.gates.logical_time.turn} · not an independent sample`; }
  catch (e) { if (epoch !== replayEpoch || e.message === "stale_session") return;
    if (e.data?.gates) { client.clear(); error(evidenceFailure(e, "Reconstruction unavailable. Research content has been cleared.")); return; }
    if (state) { renderMap(state); facts($("gates"), state.gates); }
    $("replay-status").textContent = "Reconstruction unavailable. Showing current state; no exact replay claim is made."; }
});
$("live").addEventListener("click", () => { replayEpoch++; if (state) { renderMap(state); facts($("gates"), state.gates); $("replay-status").textContent = "Current state"; } });
$("export").addEventListener("click", async () => {
  try { const result = await client.request("/api/observer/export"); const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), link = el("a"); link.href = url; link.download = "civilizationlab-research-evidence.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $("export-status").textContent = "Authorized evidence exported with domain and provenance."; }
  catch (e) { if (e.message !== "stale_session") {
    if (e.data?.gates) { client.clear(); error(evidenceFailure(e, "Export unavailable. Research content has been cleared.")); }
    else $("export-status").textContent = "Export unavailable; no incomplete evidence was presented as exact.";
  } }
});
window.addEventListener("pagehide", () => client.clear());
