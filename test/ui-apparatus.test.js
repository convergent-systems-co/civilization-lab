import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApplication } from "../src/server.js";
import { makeWorld, projectWorldState } from "../src/world.js";
import { ACTION_META } from "../ui/action-meta.js";
import { assertValidSchema } from "../src/schema.js";
import { projectWorld } from "../src/contracts.js";
import { SERVER_OWNED_ACTION_FIELDS } from "../src/action-contract.js";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function projectionFixture(world) {
  const view = projectWorldState(world, "polity-1");
  view.own.name = "Verdant Reach";
  view.own.memory = undefined;
  view.own.units = [{ id: "own-infantry", type: "infantry", hex_id: view.own.capital_hex_id }, { id: "own-transport", type: "transport", hex_id: view.own.capital_hex_id }];
  view.own.technologies = ["agronomy"];
  view.own.facilities[0].captured_from = "known-contact";
  const hexes = Object.values(view.map), contested = hexes[1], stale = hexes[2];
  view.territories[contested.territory_id] = { territory_id: contested.territory_id, status: "contested", owner_id: null, controller_id: null };
  view.known.hexes[stale.id] = { value: stale, age: 3, observed_turn: 0, provenance: { source: "synthetic-observation" } };
  view.known.polities = { "known-contact": { value: { id: "known-contact", name: "<img src=x onerror=alert(1)>" }, observed_turn: 0, age: 0 } };
  view.known.units = { "visible-target": { value: { id: "visible-target", type: "infantry", hex_id: hexes[0].id, current_location_known: true }, age: 0 }, "lost-target": { value: { id: "lost-target", hex_id: null, current_location_known: false }, age: 2 } };
  view.known.unaffiliated_population = { "visible-unaffiliated": { value: { id: "visible-unaffiliated", affiliation_status: "unaffiliated", assignment: "Civilian", count: 3, hex_id: hexes[0].id, territory_id: hexes[0].territory_id }, age: 0, observed_turn: 0 } };
  view.known.neutral_units = { "visible-neutral": { value: { id: "visible-neutral", status: "inactive_neutral", controller_id: null, type: "infantry", health: 10, hex_id: hexes[0].id, territory_id: hexes[0].territory_id }, age: 0, observed_turn: 0 } };
  view.known.facilities["visible-unclaimed-facility"] = { value: { id: "visible-unclaimed-facility", owner_id: null, type: "industrial", hex_ids: [hexes[0].id], size: 1, condition: 100, construction_progress: 100 }, currently_visible: true, age: 0, observed_turn: 0 };
  const values = {
    "own.polity_state": view.own,
    "public.discovered_world_state": { "known-contact": view.known.polities["known-contact"].value },
    "public.known_map": view.map, "public.known_territories": view.territories,
    "own.knowledge": view.known, "own.intelligence": [{ text: "Report as received", source: "synthetic" }],
    "authorized.channels": [{ id: "room-visible", members: ["polity-1", "known-contact"] }],
    "authorized.messages": [{ from: "known-contact", channel_id: "room-visible", text: "<svg onload=alert(2)>Keep this promise verbatim.</svg>", turn: 0 }, { from: "known-contact", channel_id: "public", text: "A public announcement.", turn: 0 }],
    "own.memory": "My current notes, not an archive.", "own.available_actions": Object.keys(ACTION_META), "public_safe.validation_results": []
  };
  return { ...projectWorld(world, "polity-1"), projection_id: "synthetic-ui-projection", fields: Object.entries(values).map(([path, value]) => ({ path, value, audience: "polity-1", source_event_refs: [] })) };
}
async function setup(t, { fixture = true, enabled = true, mutateWorld = () => {} } = {}) {
  const world = makeWorld({ runId: "synthetic-ui-only", seed: "ui-conformance" });
  mutateWorld(world);
  let projection = projectionFixture(world), submitted = null;
  const service = {
    world,
    async participantState() { return { projection, controls: { execution_enabled: enabled, can_submit: !submitted && enabled, submission_status: submitted ? "submitted" : "none", deadline_at: null } }; },
    async submitParticipantActions(input) { for (const action of input.actions) assertValidSchema(action, "action-api.schema.json"); submitted = input; return { status: "submitted", submission_id: "synthetic-ui-receipt" }; }
  };
  const app = createApplication({ world, allowSyntheticExecution: enabled, ...(fixture ? { runService: service } : {}) });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await context.close(); await new Promise(resolve => app.server.close(resolve)); assert.deepEqual(errors, []); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const token = app.auth.issue({ runId: world.runId, principalId: "polity-1", domain: "participant_projection", ttlMs: 60000 });
  return { app, world, page, context, url, token, get submitted() { return submitted; }, get projection() { return projection; }, setProjection(value) { projection = value; } };
}
async function login(f) {
  await f.page.goto(f.url);
  await f.page.getByLabel("Participant access credential").fill(f.token);
  await f.page.getByRole("button", { name: "Open session" }).click();
  await f.page.locator("#game").waitFor({ state: "visible" });
}

test("real browser renders authorized hexes, keyboard inspection, inert messages and complete own capabilities", async t => {
  const f = await setup(t); const dialogs = []; f.page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await login(f);
  assert.equal(await f.page.title(), "CivilizationLab · Verdant Reach · turn 0");
  assert.equal(await f.page.locator("#credential").inputValue(), "");
  assert(await f.page.locator("#map [role=button]").count() > 10);
  assert(await f.page.locator("#map .contested").count() > 0);
  assert(await f.page.locator("#map .stale").count() > 0);
  await f.page.locator('#map [tabindex="0"]').focus();
  const before = await f.page.evaluate(() => document.activeElement.dataset.hexId);
  await f.page.keyboard.press("ArrowRight");
  assert.notEqual(await f.page.evaluate(() => document.activeElement.dataset.hexId), before);
  await f.page.keyboard.press("Enter");
  assert.match(await f.page.locator("#tile-detail").textContent(), /Contested; no exclusive owner/);
  assert.equal(await f.page.locator('#map [tabindex="0"]').count(), 1);
  const accessibility = await f.page.locator("body").ariaSnapshot();
  assert.match(accessibility, /Contested; no exclusive owner/); assert.match(accessibility, /Last known; age 3 turns/);
  assert.match(accessibility, /3 unaffiliated residents in 1 groups/); assert.match(accessibility, /1 inactive neutral units/); assert.match(accessibility, /1 unclaimed facilities/);
  const hexCount = await f.page.locator("#map [role=button]").count();
  await f.page.locator("#map-layer").selectOption("movement");
  assert(await f.page.locator("#map .range-ring").count() > 0);
  assert.match(await f.page.locator("#map").ariaSnapshot(), /Within movement budget; path cost/);
  await f.page.locator("#map-layer").selectOption("detection");
  assert(await f.page.locator("#map .range-ring").count() > 0);
  assert.equal(await f.page.locator("#map [role=button]").count(), hexCount);
  await f.page.locator("#map-layer").selectOption("terrain");
  assert.match(await f.page.locator("#messages").textContent(), /<svg onload=alert\(2\)>/);
  assert.equal(await f.page.locator("#messages svg, #polities img").count(), 0); assert.deepEqual(dialogs, []);
  for (const id of ["resources", "population", "units", "facilities", "technology", "channels", "memory", "knowledge"]) assert((await f.page.locator("#" + id).textContent()).length > 10, id);
  await f.page.locator("#action-type").selectOption("attack");
  const options = await f.page.locator("#order-target_unit_id").textContent();
  assert.match(options, /visible-target/); assert.doesNotMatch(options, /lost-target/);
  await f.page.screenshot({ path: "/private/tmp/civilization-player-desktop.png", fullPage: true });
});

test("all action forms submit schema-valid typed data through real DOM controls", async t => {
  const f = await setup(t); await login(f);
  for (const [type, meta] of Object.entries(ACTION_META)) {
    await f.page.locator("#action-type").selectOption(type);
    for (const field of meta.fields) {
      const input = f.page.locator(`#order-${field.key}`);
      if (field.optional) continue;
      if (["select", "multi"].includes(field.kind)) {
        const value = await input.locator("option").evaluateAll(options => options.find(o => o.value)?.value);
        assert(value, `${type}.${field.key} must have a selectable projected candidate`);
        await input.selectOption(value);
      } else await input.fill(field.kind === "number" ? "1" : field.key === "hex_id" ? "hex-1-1" : "Uncoded natural language.");
    }
    await f.page.getByRole("button", { name: "Add to draft" }).click();
  }
  assert.equal(await f.page.locator("#draft > li").count(), Object.keys(ACTION_META).length);
  await f.page.getByRole("button", { name: "Commit orders" }).click();
  await f.page.waitForFunction(() => document.querySelector("#action-status").textContent.includes("Submission recorded"));
  assert.equal(f.submitted.actions.length, Object.keys(ACTION_META).length);
  for (const action of f.submitted.actions) {
    assertValidSchema(action, "action-api.schema.json");
    for (const key of SERVER_OWNED_ACTION_FIELDS) assert.equal(Object.hasOwn(action, key), false, `${action.type}.${key}`);
  }
  assert.deepEqual(Object.keys(f.submitted).sort(), ["actions", "principalId", "projectionId", "turn"]);
  assert.equal(await f.page.getByRole("button", { name: "Commit orders" }).isDisabled(), true);
});

test("responsive player and keyboard controls fit narrow displays; preview execution stays disabled", async t => {
  const f = await setup(t, { enabled: false }); await f.page.setViewportSize({ width: 390, height: 844 }); await login(f);
  assert.equal(await f.page.getByRole("button", { name: "Commit orders" }).isDisabled(), true);
  assert.equal(await f.page.getByRole("button", { name: "Add to draft" }).isDisabled(), true);
  assert.match(await f.page.locator("#execution-status").textContent(), /execution disabled/);
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await f.page.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await f.page.screenshot({ path: "/private/tmp/civilization-player-mobile.png", fullPage: true });
});

test("hidden mutations never reach browser bytes, DOM, accessibility or storage; logout clears principal content", async t => {
  const f = await setup(t, { fixture: false, enabled: false }); await login(f);
  const dom = await f.page.locator("#game").evaluate(node => node.outerHTML), ax = await f.page.locator("body").ariaSnapshot();
  f.world.polities["polity-2"].name = "SECRET-ROSTER-CANARY"; f.world.polities["polity-2"].memory.push("SECRET-MEMORY-CANARY");
  const responsePromise = f.page.waitForResponse(r => r.url().endsWith("/api/state"));
  await f.page.getByRole("button", { name: "Refresh observation" }).click();
  const response = await responsePromise; assert.doesNotMatch(await response.text(), /SECRET-|polity-2|polity-3/);
  assert.equal(await f.page.locator("#game").evaluate(node => node.outerHTML), dom);
  assert.equal(await f.page.locator("body").ariaSnapshot(), ax);
  assert.deepEqual(await f.page.evaluate(() => ({ local: Object.keys(window.localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  await f.page.getByRole("button", { name: "Clear session" }).click();
  assert.equal(await f.page.locator("#map").textContent(), ""); assert.equal(await f.page.locator("#resources").textContent(), "");
  assert.equal(await f.page.title(), "CivilizationLab · Your world");
  assert.doesNotMatch(await f.page.locator("body").ariaSnapshot(), /polity-1|SECRET-/);
});

test("late observation response cannot restore cleared credentials or another principal's UI", async t => {
  const f = await setup(t); await login(f);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  await f.page.route("**/api/state", async route => { started(); await gate; await route.continue(); });
  await f.page.getByRole("button", { name: "Refresh observation" }).click(); await received;
  await f.page.getByRole("button", { name: "Clear session" }).click();
  const returned = f.page.waitForResponse(r => r.url().endsWith("/api/state")); release(); await returned;
  assert.equal(await f.page.locator("#game").isVisible(), false); assert.equal(await f.page.locator("#map").textContent(), "");
});

test("separate Observer browser surface filters raw events, opens payload provenance and denies participant credentials", async t => {
  const f = await setup(t, { fixture: false, mutateWorld(world) {
    const p=world.polities['polity-1'],hex=world.hexes[p.capital_hex_id];
    world.unaffiliatedPopulation.push({id:'observer-unaffiliated',assignment:'Civilian',count:4,hex_id:hex.id,territory_id:hex.territory_id,affiliation_status:'unaffiliated'});
    world.neutralUnits.push({id:'observer-neutral',type:'infantry',hex_id:hex.id,territory_id:hex.territory_id,status:'inactive_neutral',controller_id:null,crew:[],health:1});
  } });
  const token = f.app.auth.issue({ runId: f.world.runId, principalId: "researcher", domain: "research_observation", ttlMs: 60000 });
  await f.page.goto(f.url + "/observer"); await f.page.getByLabel("Research access credential").fill(f.token);
  await f.page.getByRole("button", { name: "Open research view" }).click();
  await f.page.locator("#error").waitFor({ state: "visible" }); assert.equal(await f.page.locator("#research").isVisible(), false);
  await f.page.getByLabel("Research access credential").fill(token); await f.page.getByRole("button", { name: "Open research view" }).click();
  await f.page.locator("#research").waitFor({ state: "visible" });
  assert.match(await f.page.locator("#gates").textContent(), /research_observation/);
  assert.match(await f.page.locator("#summary").textContent(), /Unaffiliated population4/);
  assert.match(await f.page.locator("#summary").textContent(), /Inactive neutral units1/);
  const observerMap=await f.page.locator("#map").ariaSnapshot();assert.match(observerMap,/4 unaffiliated residents in 1 groups/);assert.match(observerMap,/1 inactive neutral units/);
  assert.equal(await f.page.getByRole("button", { name: "Reconstruct completed turn" }).isDisabled(), true);
  await f.page.getByLabel("Event type", { exact: true }).selectOption("RunCreated");
  assert.equal(await f.page.locator("#events tr").count(), 1);
  await f.page.locator("#events button").click();
  assert.match(await f.page.locator("#raw-event").textContent(), /initial_state_ref|configuration_ref/);
  await f.page.locator("#payload-links button").first().click(); assert((await f.page.locator("#raw-payload").textContent()).length > 50);
  await f.page.getByLabel("Search raw evidence").fill("no-such-evidence-canary");
  assert.equal(await f.page.locator("#events tr").count(), 0);
  await f.page.getByLabel("Search raw evidence").fill("");
  await f.page.screenshot({ path: "/private/tmp/civilization-observer-desktop.png", fullPage: true });
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await f.page.getByRole("button", { name: "Clear session" }).click();
  assert.equal(await f.page.locator("#raw-event").textContent(), "");
  assert.equal(await f.page.locator("#filter-type option").count(), 1);
});
