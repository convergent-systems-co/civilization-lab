export const $ = id => document.getElementById(id);
export function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = String(text ?? "");
  if (className) node.className = className;
  return node;
}
export const entries = value => Array.isArray(value) ? value : Object.entries(value ?? {}).map(([id, item]) => typeof item === "object" && item !== null ? { id, ...item } : { id, value: item });
export const label = value => String(value).replaceAll("_", " ");
export function facts(target, data, empty = "Not available in this observation.") {
  target.replaceChildren();
  if (!data || !Object.keys(data).length) { target.append(el("p", empty, "muted")); return; }
  const list = el("dl", "", "facts");
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const detail = el("dd");
    if (value !== null && typeof value === "object") {
      const disclosure = el("details"), summary = el("summary", Array.isArray(value) ? `${value.length} entries` : "Details");
      disclosure.append(summary, el("pre", JSON.stringify(value, null, 2), "raw")); detail.append(disclosure);
    } else detail.textContent = value === null ? "None" : String(value);
    list.append(el("dt", label(key)), detail);
  }
  target.append(list);
}
export function cards(target, values, empty, fields) {
  target.replaceChildren();
  const items = entries(values);
  if (!items.length) { target.append(el("p", empty, "muted")); return; }
  for (const item of items) {
    const card = el("article", "", "item-card");
    card.append(el("h3", item.name ?? item.type ?? item.id));
    const detail = el("div");
    facts(detail, fields ? Object.fromEntries(fields.filter(k => item[k] !== undefined).map(k => [k, item[k]])) : item);
    card.append(detail); target.append(card);
  }
}

export function capabilityCards(target, values, empty, fields) {
  target.replaceChildren();
  for (const item of entries(values)) {
    const card = el("article", "", "item-card compact-card");
    card.append(el("h3", label(item.name ?? item.assignment ?? item.type ?? item.technology ?? item.id)));
    const summary = el("div"); facts(summary, Object.fromEntries(fields.filter(k => item[k] !== undefined && item[k] !== null).map(k => [k, item[k]]))); card.append(summary);
    if (item.required_progress > 0) {
      const progress = el("progress"); progress.max = item.required_progress; progress.value = item.construction_progress;
      progress.setAttribute("aria-label", `Construction: ${item.construction_progress} of ${item.required_progress}`); card.append(progress);
    }
    const details = el("details"), content = el("div"); facts(content, item); details.append(el("summary", "More details"), content); card.append(details); target.append(card);
  }
  if (!target.children.length) target.append(el("p", empty, "muted"));
}

// Text, including authenticated sender names, remains inert application content.
// The bearer credential lives in this closure only, never in URL/storage/history.
export function sessionClient(onClear) {
  let token = null, epoch = 0;
  return {
    open(value) { token = value; epoch++; },
    clear() { token = null; epoch++; onClear(); },
    async request(path, options = {}) {
      const started = epoch;
      const response = await fetch(path, { ...options, cache: "no-store", credentials: "omit", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
      if (epoch !== started) throw new Error("stale_session");
      if (response.status === 401) { this.clear(); throw new Error("unauthorized"); }
      const data = await response.json();
      if (epoch !== started) throw new Error("stale_session");
      if (!response.ok) throw Object.assign(new Error(data.error ?? "request_failed"), { data });
      return data;
    }
  };
}
