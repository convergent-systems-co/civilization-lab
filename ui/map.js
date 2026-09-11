import { el, entries, label } from "./common.js";
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, text) => { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };

export function mapData(own, visible) {
  const unpack = value => entries(value).map(item => item.value && typeof item.value === "object" ? { ...item.value, age: item.age, observed_turn: item.observed_turn, provenance: item.provenance, currently_visible:item.currently_visible } : item);
  const known = visible.known ?? {};
  const hexes = entries(visible.hexes ?? visible.map?.hexes ?? visible.map ?? own.hexes).map(h => {
    const observed = known.hexes?.[h.id ?? h.hex_id], deposits = known.deposits?.[h.id ?? h.hex_id];
    return { ...h, ...(observed ? { age: observed.age, observed_turn: observed.observed_turn, provenance: observed.provenance } : {}), ...(deposits ? { deposits: deposits.value, deposit_age: deposits.age } : {}), ...(own.capital_hex_id === (h.id ?? h.hex_id) ? { capital: true } : {}) };
  });
  // Older snapshots contain territory IDs but no geography. Display only those
  // disclosed IDs, never synthesize a world boundary or undiscovered positions.
  if (!hexes.length) for (const id of own.territory ?? []) hexes.push({ id, territory_id: id, owner_id: own.id });
  const unique = items => [...new Map(items.map(item => [item.id, item])).values()];
  return { hexes, territories: entries(visible.territories ?? own.territories), facilities: unique(unpack(visible.facilities ?? known.facilities).concat(entries(own.facilities))), units: unique(unpack(visible.units ?? known.units).concat(entries(own.units))), neutralUnits: unique(unpack(visible.neutral_units ?? known.neutral_units)), populations: unique(unpack(visible.unaffiliated_population ?? known.unaffiliated_population)), ownId: own.id };
}

export function drawMap(container, data, { onSelect = () => {}, layer = "terrain", zoom = 1, rules = {}, entity = null, technologies = [] } = {}) {
  const prior = container.querySelector('[tabindex="0"]')?.dataset.hexId;
  const hadFocus = container.contains(document.activeElement);
  container.replaceChildren();
  if (!data.hexes.length) { container.append(el("p", "No mapped hexes in this observation.", "map-empty")); return; }
  const tiles = data.hexes.map((h, index) => {
    const id = h.hex_id ?? h.id;
    const parsed = /^hex-(-?\d+)-(-?\d+)$/.exec(id ?? "");
    const q = Number(h.q ?? h.x ?? parsed?.[1] ?? index), r = Number(h.r ?? h.y ?? parsed?.[2] ?? 0);
    return { ...h, id, q, r, cx: Math.sqrt(3) * 29 * (q + r / 2), cy: 29 * 1.5 * r };
  });
  const distance = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
  const origin = entity && tiles.find(t => t.id === entity.hex_id);
  const specification = rules.units?.[entity?.type], domain = specification?.domain ?? "land";
  const cost = new Map();
  if (origin && !entity.training && !entity.embarked_on) {
    cost.set(origin.id, 0); const queue = [origin];
    const budget = specification?.movement ?? (entity.assignment === "Explorer" ? rules.explorerMovement : rules.citizenMovement) ?? 0;
    while (queue.length) {
      queue.sort((a, b) => cost.get(a.id) - cost.get(b.id)); const from = queue.shift();
      for (const to of tiles.filter(t => distance(from, t) === 1)) {
        if (domain === "land" && to.terrain === "water" || domain === "sea" && to.terrain !== "water") continue;
        const next = cost.get(from.id) + (domain === "air" ? 1 : rules.terrain?.[to.terrain]?.movement ?? Infinity);
        if (next <= budget && next < (cost.get(to.id) ?? Infinity)) { cost.set(to.id, next); queue.push(to); }
      }
    }
  }
  const minX = Math.min(...tiles.map(h => h.cx)) - 38, minY = Math.min(...tiles.map(h => h.cy)) - 38;
  const width = Math.max(200, Math.max(...tiles.map(h => h.cx)) - minX + 38), height = Math.max(160, Math.max(...tiles.map(h => h.cy)) - minY + 38);
  const scene = svg("svg", { viewBox: `${minX} ${minY} ${width} ${height}`, role: "group", "aria-label": "Known hexes. Arrow keys navigate; Enter or Space inspects.", class: `hex-map zoom-${zoom}` });
  const buttons = [];
  const entryId = tiles.some(tile => tile.id === prior) ? prior : tiles[0].id;
  const territoryById = new Map(data.territories.map(t => [t.territory_id ?? t.id, t]));
  tiles.forEach((tile, index) => {
    const territory = territoryById.get(tile.territory_id) ?? tile;
    const contested = String(territory.status).toLowerCase() === "contested";
    const own = data.ownId !== null && territory.owner_id === data.ownId && !contested;
    const stale = tile.stale === true || tile.age > 0 || tile.last_observed_turn !== undefined && tile.current === false;
    const terrain = ["water", "ocean", "coast", "forest", "mountain", "hills", "plains", "desert"].includes(tile.terrain) ? tile.terrain : "unknown";
    const population = tile.population ?? tile.citizens;
    const facilities = data.facilities.filter(f => (f.hex_ids ?? f.occupied_hexes ?? [f.hex_id]).includes(tile.id));
    const units = data.units.filter(u => (u.hex_id ?? u.territory_id) === tile.id);
    const neutralUnits = (data.neutralUnits ?? []).filter(u => u.hex_id === tile.id);
    const populations = (data.populations ?? []).filter(g => g.hex_id === tile.id);
    const unclaimedFacilities = facilities.filter(f => f.owner_id === null && !f.destroyed);
    const unaffiliatedCount = populations.reduce((sum, group) => sum + (Number(group.count) || 0), 0);
    const detectionBonus = technologies.reduce((sum, technology) => sum + (rules.technologies?.[technology]?.detectionBonus ?? 0), 0);
    const detectionRange = Math.max(0, (specification?.detection ?? rules.contactRadius ?? 0) + detectionBonus - (rules.terrain?.[tile.terrain]?.detectionPenalty ?? 0));
    const inRange = origin && !entity.embarked_on && (layer === "movement" ? cost.has(tile.id) : layer === "detection" ? distance(origin, tile) <= detectionRange : layer === "combat" ? specification && distance(origin, tile) <= specification.range : false);
    const rangeText = inRange ? layer === "movement" ? `Within movement budget; path cost ${cost.get(tile.id)}` : `${layer === "combat" ? "Attack" : "Detection"} range; known terrain only` : null;
    const description = [tile.id, label(terrain), tile.territory_id && `territory ${tile.territory_id}`, contested ? "Contested; no exclusive owner" : own ? "Your territory" : territory.owner_id ? `Owner ${territory.owner_id}` : "Ownership unknown or unclaimed", territory.controller_id && `Controller ${territory.controller_id}`, stale ? `Last known; age ${tile.age ?? "unknown"} turns` : "Observed", tile.capital ? "Capital" : null, facilities.length ? `${facilities.length} facilities` : null, unclaimedFacilities.length ? `${unclaimedFacilities.length} unclaimed facilities` : null, units.length ? `${units.length} active units` : null, neutralUnits.length ? `${neutralUnits.length} inactive neutral units` : null, unaffiliatedCount ? `${unaffiliatedCount} unaffiliated residents in ${populations.length} groups` : null, population ? `Population ${typeof population === "object" ? JSON.stringify(population) : population}` : null, rangeText].filter(Boolean).join("; ");
    const group = svg("g", { role: "button", tabindex: tile.id === entryId ? 0 : -1, "aria-label": description, "aria-pressed": "false", class: `map-tile ${terrain}${own ? " owned" : ""}${contested ? " contested" : ""}${stale ? " stale" : ""}`, "data-hex-id": tile.id });
    const points = Array.from({ length: 6 }, (_, i) => { const a = (60 * i - 30) * Math.PI / 180; return `${tile.cx + 27 * Math.cos(a)},${tile.cy + 27 * Math.sin(a)}`; }).join(" ");
    group.append(svg("polygon", { points }), svg("title", {}, description));
    if (inRange) group.append(svg("circle", { cx: tile.cx, cy: tile.cy, r: 21, class: "range-ring", "aria-hidden": "true" }));
    let glyph = terrain === "water" || terrain === "ocean" ? "≈" : terrain === "forest" ? "♣" : terrain === "mountain" ? "△" : "·";
    if (tile.capital) glyph = "★";
    if (facilities.length) glyph = "▣";
    if (populations.length) glyph = "●";
    if (units.length || neutralUnits.length) glyph = "◆";
    if (contested) glyph = "≠";
    group.append(svg("text", { x: tile.cx, y: tile.cy + 5, "text-anchor": "middle", "aria-hidden": "true", class: "tile-glyph" }, glyph));
    if (stale) group.append(svg("text", { x: tile.cx + 13, y: tile.cy - 10, "aria-hidden": "true", class: "tile-age" }, `${tile.age ?? "?"}t`));
    const overlay = layer === "resources" ? tile.resources ?? tile.deposits : inRange && layer === "movement" ? cost.get(tile.id) : null;
    if (overlay !== undefined && overlay !== null) group.append(svg("text", { x: tile.cx, y: tile.cy + 19, "text-anchor": "middle", "aria-hidden": "true", class: "tile-age" }, typeof overlay === "object" ? Object.keys(overlay).join(" · ") : overlay));
    const select = () => {
      buttons.forEach(b => { b.setAttribute("tabindex", "-1"); b.setAttribute("aria-pressed", "false"); });
      group.setAttribute("tabindex", "0"); group.setAttribute("aria-pressed", "true"); group.focus();
      onSelect({ ...tile, territory, facilities, units, neutral_units: neutralUnits, unaffiliated_population: populations, description });
    };
    group.addEventListener("click", select);
    group.addEventListener("keydown", event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(); return; }
      if (event.key === "Home" || event.key === "End") { event.preventDefault(); const next = event.key === "Home" ? buttons[0] : buttons.at(-1); buttons.forEach(b => b.setAttribute("tabindex", "-1")); next.setAttribute("tabindex", "0"); next.focus(); return; }
      const direction = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      const next = tiles.map((h, i) => ({ i, dx: h.cx - tile.cx, dy: h.cy - tile.cy })).filter(h => h.dx * direction[0] + h.dy * direction[1] > 1).sort((a, b) => (Math.hypot(a.dx, a.dy) + Math.abs(a.dx * direction[1] - a.dy * direction[0]) * 2) - (Math.hypot(b.dx, b.dy) + Math.abs(b.dx * direction[1] - b.dy * direction[0]) * 2))[0];
      if (next) { buttons.forEach(b => b.setAttribute("tabindex", "-1")); buttons[next.i].setAttribute("tabindex", "0"); buttons[next.i].focus(); }
    });
    buttons.push(group); scene.append(group);
  });
  container.append(scene);
  if (hadFocus) container.querySelector('[tabindex="0"]')?.focus();
}
