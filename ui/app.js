import { $, el, entries, facts, cards, capabilityCards, sessionClient, label } from "./common.js";
import { ACTION_META, ASSIGNMENTS, CATALOGUE } from "./action-meta.js";
import { drawMap, mapData } from "./map.js";

let projection = null, own = {}, visible = {}, available = {}, controls = {}, rules = {}, drafts = [], currentMap = null, zoom = 1, busy = false, turnKey = null;
const client = sessionClient(clearView);
const field = path => projection?.fields?.find(f => f.path === path)?.value;
const unpack = value => entries(value).map(item => item.value && typeof item.value === "object" ? { ...item.value, age: item.age, observed_turn: item.observed_turn, provenance: item.provenance, currently_visible:item.currently_visible } : item);
const contacts = () => unpack(visible.polities ?? visible.known?.polities ?? visible).filter(p => p.id !== own.id && p.name !== undefined);
function clearView() {
  projection = null; own = {}; visible = {}; available = {}; controls = {}; rules = {}; drafts = []; currentMap = null; turnKey = null;
  $("credential").value = ""; $("game").hidden = true; $("login").hidden = false;
  $("logout").hidden = true; $("refresh").hidden = true; $("error").hidden = true;
  for (const id of ["resources", "advantages", "polities", "map", "tile-detail", "tile-facts", "action-type", "draft", "population", "units", "facilities", "technology", "channels", "messages", "memory", "knowledge", "validation", "action-status", "turn", "phase", "deadline", "execution-status", "range-entity"]) $(id).replaceChildren();
  $("action-fields").replaceChildren(el("legend", "Action details"));
  $("status").textContent = "Signed out"; $("world-title").textContent = "A world to discover.";
  $("subtitle").textContent = "Shape the future of your civilization.";
  document.title = "CivilizationLab · Your world";
}
function showError(message) { $("error").textContent = message; $("error").hidden = false; }
function normalizedAvailable(value) {
  const list = Array.isArray(value) ? value : value?.actions ?? value?.types ?? value?.action_types;
  if (Array.isArray(list)) return Object.fromEntries(list.map(a => typeof a === "string" ? [a, {}] : [a.type, a]));
  return value && typeof value === "object" ? value : {};
}
function renderMap() {
  $("range-controls").hidden = !["movement", "detection", "combat"].includes($("map-layer").value);
  const entity = entries(own.units).concat(entries(own.citizens)).find(e => e.id === $("range-entity").value);
  drawMap($("map"), currentMap, { layer: $("map-layer").value, zoom, rules, entity, technologies: own.technologies ?? [], onSelect(tile) {
    $("tile-detail").textContent = tile.description; $("tile-inspector").open = true;
    const { cx, cy, description, ...detail } = tile; facts($("tile-facts"), detail);
    for (const key of ["hex_id", "territory_id"]) { const input = document.getElementById(`order-${key}`); const value = key === "hex_id" ? tile.id : tile.territory_id; if (input && (!input.options || [...input.options].some(o => o.value === value))) input.value = value; }
  } });
}
function render(data) {
  projection = data.projection; controls = data.controls ?? {};
  own = field("own.polity_state") ?? {}; visible = field("public.discovered_world_state") ?? {};
  visible = { ...visible, ...(field("public.known_map") ? { map: field("public.known_map") } : {}), ...(field("public.known_territories") ? { territories: field("public.known_territories") } : {}) };
  if (field("own.intelligence")?.facts) visible.known = field("own.intelligence").facts;
  if (!visible.known && field("own.knowledge") && !Array.isArray(field("own.knowledge"))) visible = { ...visible, known: field("own.knowledge") };
  const nextKey = `${projection.run_id}:${projection.logical_time.turn}:${projection.principal.principal_id}`;
  if (turnKey !== nextKey) { drafts = []; $("tile-detail").textContent = "Select a hex to inspect its observation."; $("tile-facts").replaceChildren(); }
  turnKey = nextKey;
  $("game").hidden = false; $("login").hidden = true; $("logout").hidden = false; $("refresh").hidden = false;
  $("world-title").textContent = own.name || "Your civilization";
  $("subtitle").textContent = "Your observed world. Your next decision.";
  $("status").textContent = own.alive === false ? "Civilization eliminated" : "Session active";
  $("turn").textContent = `Turn ${projection.logical_time.turn}`;
  $("phase").textContent = label(projection.logical_time.phase);
  $("deadline").textContent = controls.deadline_at ? new Date(controls.deadline_at).toLocaleTimeString() : "No active deadline";
  $("execution-status").textContent = !controls.execution_enabled ? "Build preview · execution disabled"
    : controls.can_communicate ? "Diplomacy is open. Communications are delivered now, before final planning."
    : controls.ready ? "Phase complete. Awaiting the next phase."
    : controls.submission_status === "submitted" ? "Orders recorded. Finish this phase when ready."
    : projection.logical_time.phase === "consequence_reveal" ? "Review this turn’s consequences before memory updates and interviews."
    : "Follow the current phase and its shared deadline.";
  document.title = `CivilizationLab · ${own.name || "Your world"} · turn ${projection.logical_time.turn}`;
  facts($("resources"), { ...Object.fromEntries(["population", "food", "credits", "shortage", "takeover"].filter(k => own[k] !== undefined).map(k => [k, own[k]])), ...own.resources, ...(rules.foodPerCitizen !== undefined ? { food_demand: own.population * rules.foodPerCitizen } : {}) });
  facts($("advantages"), { ...(own.advantages !== undefined ? { advantages: own.advantages } : {}), ...(own.disadvantages !== undefined ? { disadvantages: own.disadvantages } : {}) }, "");
  cards($("polities"), contacts(), "No other polities have been discovered.", ["id", "observed_turn", "age", "provenance"]);
  currentMap = mapData(own, visible);
  const previousEntity = $("range-entity").value; $("range-entity").replaceChildren();
  for (const entity of entries(own.units).concat(entries(own.citizens))) { const option = el("option", `${label(entity.assignment ?? entity.type)} · ${entity.hex_id}`); option.value = entity.id; $("range-entity").append(option); }
  if ([...$("range-entity").options].some(o => o.value === previousEntity)) $("range-entity").value = previousEntity;
  renderMap();
  capabilityCards($("population"), own.population_groups ?? own.citizens ?? own.assignments, "No assignment details in this observation.", ["count", "hex_id", "training"]);
  capabilityCards($("units"), own.units, "No operational units.", ["hex_id", "health", "strength", "embarked_on"]);
  capabilityCards($("facilities"), own.facilities, "No facilities in this observation.", ["capacity", "condition", "level"]);
  $("technology").replaceChildren(el("p", own.technologies?.length ? own.technologies.map(label).join(" · ") : "No completed technologies yet.", "muted"));
  const projects = el("div"); capabilityCards(projects, own.research ?? own.research_projects ?? own.projects, "No active research projects.", ["progress", "remaining_turns", "status"]); $("technology").append(projects);
  const communication = field("authorized.messages") ?? [];
  cards($("channels"), field("authorized.channels") ?? communication.channels ?? visible.channels ?? [], "No private rooms in this observation.");
  $("messages").replaceChildren();
  for (const message of entries(communication.messages ?? communication)) {
    const card = el("article", "", "message");
    card.append(el("p", `${message.broadcast === true || message.broadcast === undefined && (message.channel_id === "public" || message.public === true || message.visibility === "public") ? "Public broadcast" : "Private"} · ${message.from ?? message.sender_id ?? "Sender"} · turn ${message.turn ?? projection.logical_time.turn}`, "eyebrow"), el("p", message.text ?? message.content ?? ""));
    $("messages").append(card);
  }
  if (!$("messages").children.length) $("messages").append(el("p", "No messages in this observation.", "muted"));
  const memory = field("own.memory"); $("memory").textContent = memory === undefined ? "No retained notes in this observation." : typeof memory === "string" ? memory : JSON.stringify(memory, null, 2);
  const knowledge = field("own.knowledge"); facts($("knowledge"), { ...(Array.isArray(knowledge) ? { facts: knowledge } : knowledge), reports: field("own.intelligence") ?? [] });
  facts($("validation"), field("public_safe.validation_results"), "");
  available = normalizedAvailable(field("own.available_actions"));
  const previousType = $("action-type").value; $("action-type").replaceChildren();
  for (const [type, meta] of Object.entries(ACTION_META)) {
    const option = el("option", `${meta.group} / ${meta.label}`); option.value = type;
    option.disabled = !Object.hasOwn(available, type) || available[type]?.enabled === false;
    $("action-type").append(option);
  }
  const enabled = [...$("action-type").options].filter(o => !o.disabled);
  $("action-type").value = enabled.some(o => o.value === previousType) ? previousType : enabled[0]?.value ?? "wait";
  renderFields(); renderDraft();
}
function choices(source) {
  const catalogue = field("own.available_actions")?.catalogue ?? own.catalogue ?? visible.catalogue ?? {};
  const values = {
    units: own.units, hexes: currentMap?.hexes, territories: currentMap?.territories?.length ? currentMap.territories : own.territory,
    facilities: own.facilities, population_groups: own.population_groups ?? own.citizens,
    contacts: contacts(),
    foreign_units: unpack(visible.units ?? visible.known?.units).filter(u => u.current_location_known !== false && u.hex_id),
    channels: field("authorized.channels") ?? field("authorized.messages")?.channels ?? visible.channels,
    resources: Object.keys({ ...own.resources, ...(own.food !== undefined ? { food: own.food } : {}), ...(own.credits !== undefined ? { credits: own.credits } : {}) }),
    assignments: ASSIGNMENTS, technologies: own.technologies ?? own.tech,
    unit_types: catalogue.unit_types ?? catalogue.units ?? (rules.units ? Object.keys(rules.units) : CATALOGUE.unit_types), facility_types: catalogue.facility_types ?? catalogue.facilities ?? (rules.facilities ? Object.keys(rules.facilities) : CATALOGUE.facility_types),
    technology_types: catalogue.technology_types ?? catalogue.technologies ?? (rules.technologies ? Object.keys(rules.technologies) : CATALOGUE.technology_types),
    builders: entries(own.citizens).filter(g => g.assignment === "Builder"), scientists: entries(own.citizens).filter(g => g.assignment === "Scientist"), soldiers: entries(own.citizens).filter(g => g.assignment === "Soldier"),
    unaffiliated_population: unpack(visible.known?.unaffiliated_population).filter(g => g.affiliation_status === "unaffiliated"),
    neutral_units: unpack(visible.known?.neutral_units).filter(u => u.status === "inactive_neutral"),
    unclaimed_facilities: unpack(visible.known?.facilities).filter(f => f.currently_visible === true && f.owner_id === null && !f.destroyed),
    artifacts: entries(own.facilities).concat(entries(own.units)).filter(a => a.captured_from), carriers: entries(own.units).filter(u => ["transport", "carrier"].includes(u.type))
  };
  const value = values[source] ?? [];
  return (Array.isArray(value) ? value : entries(value)).map(v => typeof v === "string" ? { value: v, label: label(v) } : { value: v.id ?? v.territory_id ?? v.hex_id ?? v.type, label: v.name ?? [v.assignment ?? v.type, v.id ?? v.territory_id ?? v.hex_id, v.count !== undefined ? `${v.count} citizens` : ""].filter(Boolean).join(" · ") }).filter(v => v.value !== undefined);
}
function fieldsFor(type) {
  const provided = available[type]?.fields;
  return Array.isArray(provided) ? provided.filter(f => typeof f.key === "string" && /^[a-z_]+$/.test(f.key) && ["text", "textarea", "select", "multi", "number"].includes(f.kind)) : ACTION_META[type]?.fields ?? [];
}
function renderFields() {
  const type = $("action-type").value;
  $("action-fields").replaceChildren(el("legend", ACTION_META[type]?.label ?? "Action details"));
  for (const f of fieldsFor(type)) {
    const id = `order-${f.key}`, caption = el("label", f.label); caption.htmlFor = id;
    let input;
    if (["select", "multi"].includes(f.kind)) {
      input = el("select"); input.multiple = f.kind === "multi";
      if (!input.multiple) { const placeholder = el("option", "Choose…"); placeholder.value = ""; input.append(placeholder); }
      for (const item of Array.isArray(f.options) ? f.options.map(value => ({ value, label: label(value) })) : choices(f.source)) { const option = el("option", item.label); option.value = item.value; input.append(option); }
      if (input.multiple) { input.size = 4; caption.append(el("span", " (select one or more)", "muted small")); }
    } else if (f.kind === "textarea") { input = el("textarea"); input.rows = 4; input.maxLength = 8000; }
    else { input = el("input"); input.type = f.kind === "number" ? "number" : "text"; if (input.type === "number") { input.step = "1"; input.min = "1"; } else input.maxLength = 500; }
    input.id = id; input.name = f.key; input.required = !f.optional;
    $("action-fields").append(caption, input);
  }
  const details = el("details"); details.id = "action-rule-details";
  const ruleContent = el("div"); ruleContent.id = "action-rule-content"; details.append(el("summary", "Costs & requirements"), ruleContent); $("action-fields").append(details);
  renderRules();
  updateControls();
}
function renderRules() {
  const type = $("action-type").value;
  const value = key => document.getElementById(`order-${key}`)?.value;
  let specification;
  if (type === "recruit") specification = rules.units?.[value("unit_type") || rules.defaultUnit];
  else if (["research", "reverse_engineer"].includes(type)) specification = rules.technologies?.[value("technology")];
  else if (["reassign", "train"].includes(type)) specification = rules.assignments?.[value("assignment")];
  else if (type === "build") specification = rules.facilities?.[value("facility_type")];
  else if (["move", "attack", "fortify"].includes(type)) specification = rules.units?.[entries(own.units).find(u => u.id === value("unit_id"))?.type];
  $("action-rule-details").hidden = !["recruit", "research", "reverse_engineer", "reassign", "train", "build", "move", "attack", "fortify"].includes(type);
  facts($("action-rule-content"), specification, "Select an option to see its rules.");
}
function canSubmit() { return projection && controls.execution_enabled === true && controls.can_submit === true && own.alive !== false && !busy; }
function canCommunicate() { return projection && controls.execution_enabled === true && controls.can_communicate === true && own.alive !== false && !busy; }
function updateControls() {
  $("add-action").disabled = !(canSubmit() || canCommunicate()) || !Object.hasOwn(available, $("action-type").value);
  $("add-action").textContent = controls.can_communicate ? "Send communication now" : "Add to draft";
  $("phase-ready").disabled = busy || !controls.execution_enabled || !controls.can_ready;
  $("submit-actions").disabled = !canSubmit() || drafts.length === 0 && projection?.logical_time.phase !== "final_planning";
  $("submit-actions").textContent = projection?.logical_time.phase === "final_planning" ? drafts.length ? "Submit orders" : "Submit no orders" : "Commit orders";
  $("clear-draft").disabled = busy || drafts.length === 0;
  $("action-type").disabled = busy; $("action-fields").disabled = busy; $("compose").disabled = !projection;
}
function renderDraft() {
  $("draft").replaceChildren();
  drafts.forEach((action, index) => {
    const item = el("li"), remove = el("button", "Remove"); remove.type = "button"; remove.setAttribute("aria-label", `Remove order ${index + 1}`); remove.disabled = busy;
    remove.addEventListener("click", () => { drafts.splice(index, 1); renderDraft(); });
    item.append(el("strong", ACTION_META[action.type]?.label ?? action.type), el("pre", JSON.stringify(action, null, 2), "raw"), remove); $("draft").append(item);
  }); updateControls();
}
async function refresh() { const [data, metadata] = await Promise.all([client.request("/api/state"), client.request("/api/action-meta")]); rules = metadata.rules; render(data); }
$("session").addEventListener("submit", async event => {
  event.preventDefault(); const token = $("credential").value; client.clear(); client.open(token); $("credential").value = "";
  try { await refresh(); $("map-heading").focus(); } catch (error) { if (error.message !== "stale_session") { client.clear(); showError("Unable to open session. Check your credential and connection."); } }
});
$("logout").addEventListener("click", () => { client.clear(); $("credential").focus(); });
$("refresh").addEventListener("click", async () => { $("error").hidden = true; try { await refresh(); } catch (error) { if (error.message !== "stale_session") showError("Observation could not be refreshed. Check your connection or open a new session."); } });
$("action-type").addEventListener("change", renderFields);
$("action-fields").addEventListener("change", renderRules);
$("action-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!(canSubmit() || canCommunicate())) return;
  const type = $("action-type").value, action = { type };
  for (const f of fieldsFor(type)) {
    const input = $(`order-${f.key}`);
    const value = f.kind === "multi" ? [...input.selectedOptions].map(o => o.value) : f.kind === "number" ? Number(input.value) : input.value;
    if (f.optional && (input.value === "" || Array.isArray(value) && !value.length)) continue;
    action[f.key] = value;
  }
  if (canCommunicate()) {
    busy = true; updateControls();
    try {
      const result = await client.request("/api/diplomacy", { method: "POST", body: JSON.stringify({ command: action,
        turn: projection.logical_time.turn, phase: projection.logical_time.phase, projection_id: projection.projection_id, request_id: crypto.randomUUID() }) });
      $("action-status").textContent = `Communication ${result.status}.`; await refresh();
    } catch (error) { if (error.message !== "stale_session") $("action-status").textContent = "Communication not confirmed. Refresh before continuing."; }
    finally { busy = false; updateControls(); }
    return;
  }
  drafts.push(action); renderDraft(); $("action-status").textContent = "Draft order added. Nothing has been submitted yet.";
});
$("phase-ready").addEventListener("click", async () => {
  if (busy || !controls.can_ready || !controls.execution_enabled) return;
  busy = true; updateControls();
  try {
    await client.request("/api/phase/ready", { method: "POST", body: JSON.stringify({ turn: projection.logical_time.turn, phase: projection.logical_time.phase, projection_id: projection.projection_id }) });
    await refresh();
  } catch (error) { if (error.message !== "stale_session") showError("Phase completion was not confirmed. Refresh your observation."); }
  finally { busy = false; updateControls(); }
});
$("clear-draft").addEventListener("click", () => { drafts = []; renderDraft(); });
$("submit-actions").addEventListener("click", async () => {
  if (!canSubmit() || !drafts.length && projection.logical_time.phase !== "final_planning") return;
  busy = true; renderDraft(); $("action-status").textContent = "Submitting orders…";
  try {
    const result = await client.request("/api/action", { method: "POST", body: JSON.stringify({ actions: drafts, turn: projection.logical_time.turn, phase: projection.logical_time.phase, projection_id: projection.projection_id }) });
    drafts = []; $("action-status").textContent = `Submission recorded · ${result.submission_id ?? result.status}.`; await refresh();
  } catch (error) {
    if (error.message === "stale_session") return;
    $("action-status").textContent = error.message === "execution_not_authorized" ? "Execution is disabled for this build." : error.message === "action_rejected" ? "Submission rejected and recorded. The action opportunity is lost." : "Submission was not confirmed. Refresh the observation before continuing.";
    controls.can_submit = false;
    if (error.message === "action_rejected") drafts = [];
  } finally { busy = false; renderDraft(); }
});
$("compose").addEventListener("click", () => { const type = ["message", "broadcast", "channel_message"].find(t => Object.hasOwn(available, t)); if (type) { $("action-type").value = type; renderFields(); $("action-type").focus(); } });
$("map-layer").addEventListener("change", renderMap);
$("range-entity").addEventListener("change", renderMap);
$("zoom-in").addEventListener("click", () => { zoom = Math.min(3, zoom + 1); renderMap(); });
$("zoom-out").addEventListener("click", () => { zoom = Math.max(1, zoom - 1); renderMap(); });
window.addEventListener("pagehide", () => client.clear());
