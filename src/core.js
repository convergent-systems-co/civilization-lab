import { createHash } from "node:crypto";

export const PILOT_0_MAX_TURNS = 20;

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function ref(id, type = "record") { return { id, type }; }

export function stableId(prefix, ...parts) { return `${prefix}_${sha256(parts.join("|"),).slice(0, 20)}`; }

export function nowIso() { return new Date().toISOString(); }

export const EVENT_CATALOGUE_VERSION = "pilot-0.2";

export const EVENT_TYPES = new Set([
  "WorldTransition", "BehaviorCoded",
  "RunCreated", "ActionSubmitted", "ActionValidated", "ActionRejected", "ActionAccepted",
  "TurnCommitted", "ConflictResolved", "BattleResolved", "TerritoryTransition",
  "PopulationUnitTransition", "RNGDraw", "ModelInvocation", "MemoryOperation", "MessageSent",
  "CommitmentCoded", "ProjectionIssued", "InterviewResponse", "SecurityIncident", "RunDisposition",
  "RedactionTombstone", "SnapshotCreated", "TurnResolved", "Violation"
]);

export const PAYLOAD_SCHEMA_BY_EVENT = Object.freeze({
  WorldTransition: "world-transition.schema.json", BehaviorCoded: "behavior-coded.schema.json",
  ActionSubmitted: "action-submission.schema.json", ActionValidated: "generic-event-payload.schema.json", ActionRejected: "generic-event-payload.schema.json", ActionAccepted: "generic-event-payload.schema.json", TurnCommitted: "turn-committed.schema.json", ConflictResolved: "conflict-resolution.schema.json", BattleResolved: "battle-resolution.schema.json", TerritoryTransition: "territory-state.schema.json", PopulationUnitTransition: "population-unit-transition.schema.json", RNGDraw: "rng-draw.schema.json", ModelInvocation: "model-invocation.schema.json", MemoryOperation: "memory-operation.schema.json", CommitmentCoded: "commitment-codebook-entry.schema.json", ProjectionIssued: "authorized-projection.schema.json", InterviewResponse: "interview-response.schema.json", SecurityIncident: "security-incident.schema.json", RunDisposition: "run-disposition.schema.json", RedactionTombstone: "redaction-tombstone.schema.json", MessageSent: "generic-event-payload.schema.json", RunCreated: "generic-event-payload.schema.json", SnapshotCreated: "generic-event-payload.schema.json", TurnResolved: "generic-event-payload.schema.json", Violation: "generic-event-payload.schema.json"
});

export function eventTypeIsKnown(eventType) { return EVENT_TYPES.has(eventType); }
