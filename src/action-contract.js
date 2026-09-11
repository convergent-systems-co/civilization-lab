import { readFileSync } from "node:fs";
import { assert, clone } from "./core.js";
import { assertValidSchema } from "./schema.js";

export const SERVER_OWNED_ACTION_FIELDS = Object.freeze([
  "action_id", "actor_id", "run_id", "submission_id", "session_id", "invocation_id", "prior_submission_id"
]);

const serverOwned = new Set(SERVER_OWNED_ACTION_FIELDS);
const sourceContract = JSON.parse(readFileSync(new URL("../schemas/action-api.schema.json", import.meta.url), "utf8"));

function stripServerOwnedFields(value) {
  if (Array.isArray(value)) return value.map(stripServerOwnedFields);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties") {
      result[key] = Object.fromEntries(Object.entries(child)
        .filter(([field]) => !serverOwned.has(field))
        .map(([field, schema]) => [field, stripServerOwnedFields(schema)]));
    } else if (key === "required" && Array.isArray(child)) {
      result[key] = child.filter(field => !serverOwned.has(field));
    } else result[key] = stripServerOwnedFields(child);
  }
  return result;
}

export const PUBLIC_ACTION_CONTRACT = stripServerOwnedFields(clone(sourceContract));

export function assertParticipantActionPayload(action) {
  assert(action && typeof action === "object" && !Array.isArray(action), "participant action object required");
  const pending = [action];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert(!serverOwned.has(key), "server-owned action field forbidden");
        pending.push(child);
      }
    }
  }
  return assertValidSchema(action, "action-api.schema.json");
}
