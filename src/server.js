import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import * as worldModule from "./world.js";
import { projectWorld, ActionLedger, commitTurn, PROJECTION_POLICY, publicRules } from "./contracts.js";
import { stableId, assert, clone } from "./core.js";
import { assertValidSchema } from "./schema.js";
import { AuthService } from "./auth.js";
import { reconstructRun, verifyEvidenceIntegrity } from "./replay.js";
import { deriveEndpoint } from "./analysis.js";
import { SERVER_OWNED_ACTION_FIELDS } from "./action-contract.js";

const root = resolve(fileURLToPath(new URL("../ui", import.meta.url)));
const assets = new Set(["/index.html", "/app.js", "/common.js", "/action-meta.js", "/map.js", "/style.css", "/observer.html", "/observer.js"]);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const reserved = SERVER_OWNED_ACTION_FIELDS;
const allowedProjectionFields = new Set(PROJECTION_POLICY.participant_fields);

async function readJson(req) {
  assert(req.headers["content-type"]?.split(";")[0].trim() === "application/json", "JSON required");
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 65536, "request too large"); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  assert(body && typeof body === "object" && !Array.isArray(body), "object required");
  return body;
}
function scopedProjection(world, principalId) {
  const projection = projectWorld(world, principalId);
  checkProjection(projection, world.runId, principalId);
  return projection;
}
function checkProjection(projection, runId, principalId) {
  assertValidSchema(projection, "authorized-projection.schema.json");
  assert(projection.principal?.principal_id === principalId && projection.run_id === runId, "projection binding mismatch");
  assert(Object.keys(projection.principal).every(k => ["principal_id", "principal_type", "acl_version"].includes(k)), "unrecognized principal metadata");
  assert(Object.keys(projection.logical_time).every(k => ["turn", "phase", "event_head"].includes(k)) && projection.logical_time.event_head === null, "unrecognized logical-time metadata");
  assert(new Set(projection.fields.map(f => f.path)).size === projection.fields.length, "duplicate projection field");
  assert(projection.fields.every(field => allowedProjectionFields.has(field.path) && field.audience === principalId && Object.keys(field).every(k => ["path", "value", "source_event_refs", "audience"].includes(k))), "unrecognized projection field");
}
function ownControls(world, principalId, { enabled, pending, deadline = null } = {}) {
  const running = !world.terminal && !world.evidence.events.some(event => event.event_type === "RunDisposition" &&
    ["invalid", "contaminated", "interrupted", "incomplete", "complete"].includes(event.payload.execution_status));
  return { execution_enabled: enabled === true && running, can_submit: enabled === true && running && world.polities[principalId]?.alive !== false && world.phase === "actions" && !pending.has(principalId), submission_status: pending.get(principalId)?.rejected ? "rejected" : pending.has(principalId) ? "submitted" : "none", deadline_at: deadline };
}
function researchGate(bundle) {
  const redacted = bundle.redaction_status === "REPLAY_INCOMPLETE_REDACTED" || bundle.removed_payload_refs?.length ||
    bundle.events.some(event => event.event_type === "RedactionTombstone" || event.payload?.redacted === true);
  return { status: redacted ? "REPLAY_INCOMPLETE_REDACTED" : "RECORDED_EVIDENCE", exact_reproducibility: false, state_replay: !redacted, experiential_replay: false, resident_continuation: false, recovery: false, fork: false, independent_sample: false, authorization_domain: "research_observation" };
}

/**
 * Optional durable RunService adapter (trusted server object, not an HTTP input):
 * world; participantState(principalId) -> {projection, controls};
 * submitParticipantActions({principalId, actions, turn, projectionId}) -> receipt.
 * The HTTP execution gate applies before calling the adapter. Production worker
 * scheduling, phase deadlines and persistence are owned by RunService.
 */
export function createApplication({ world = null, auth = new AuthService(), allowSyntheticExecution = false, runService = null, analysisManifest = null } = {}) {
  world ??= runService?.world ?? worldModule.makeWorld();
  // Fixed public mechanics metadata, captured once from the run's ruleset.
  // Never include starts, generation draws, roster, state or model conditions.
  const actionMeta = publicRules(world);
  const ledger = new ActionLedger(world.evidence), pending = new Map(), inFlight = new Set();
  // Only verified, current-run claims are attributable. Never store credentials,
  // client labels, arbitrary URLs, submitted values, or fabricated session refs.
  const recordDenial = async (claims, operation, resource) => {
    const identity = { principal_id: claims.principalId, authorization_domain: claims.domain,
      attempted_operation: operation, denied_resource: resource };
    const mutate = candidate => {
      const prior = candidate.evidence.events.at(-1);
      const policyRef = candidate.evidence.putPayload({ invariant_ref: "INVARIANTS.spec.md#security-and-privacy",
        projection_policy_ref: "PROJECTION_POLICY.spec.json", catalogue_ref: "EVENT_CATALOGUE.spec.json#Violation" });
      const event = candidate.evidence.append({ eventType: "Violation", turn: candidate.turn, phase: "security",
        source: "validation_monitor", participants: [claims.principalId],
        visibility: { classification: "private_research", acl_ref: "observer" },
        causality: { causation_ids: prior ? [prior.event_id] : [] },
        lineage: { persistent_identity_ids: [claims.principalId] }, provenance: { input_refs: [policyRef] },
        payload: { schema_version: "1.0.0", run_id: candidate.runId, ...identity,
          logical_time: { turn: candidate.turn, phase: "security" }, policy_ref: policyRef,
          containment: { status: "denied", breach: false },
          opportunity_cost: null, elapsed_ms: null, measurement_status: "not_measured" } });
      return { event_id: event.event_id };
    };
    if (runService) {
      assert(typeof runService.checkpoint === "function", "security checkpoint required");
      await runService.checkpoint({ requestId: "http-denial:" + randomUUID(), kind: "security", identity, mutate });
    } else mutate(world);
  };
  const auditDenial = async (...args) => {
    try { await recordDenial(...args); }
    catch { console.error("Canonical HTTP denial checkpoint failed; request remains denied."); }
  };
  // No inference, calibration, human session or empirical launch route exists.
  const stateFor = async principalId => {
    if (runService?.participantState) {
      const data = await runService.participantState(principalId);
      checkProjection(data.projection, world.runId, principalId);
      const c = data.controls ?? {};
      return { projection_policy: "projection-only", projection: data.projection, controls: { execution_enabled: allowSyntheticExecution && c.execution_enabled === true, can_submit: allowSyntheticExecution && c.can_submit === true,
        can_communicate: allowSyntheticExecution && c.can_communicate === true, can_ready: allowSyntheticExecution && c.can_ready === true,
        ready: c.ready === true, submission_status: ["none", "submitted", "rejected", "validated", "accepted", "resolved"].includes(c.submission_status) ? c.submission_status : "none", deadline_at: c.deadline_at ?? null } };
    }
    return { projection_policy: "projection-only", projection: scopedProjection(world, principalId), controls: ownControls(world, principalId, { enabled: allowSyntheticExecution, pending }) };
  };
  const server = createServer(async (req, res) => {
    // Durable transactions replace the world object; never keep a stale head.
    if (runService) world = runService.world;
    res.setHeader("cache-control", "no-store"); res.setHeader("vary", "Authorization");
    res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(value)); };
    const method = expected => { if (req.method === expected) return true; res.setHeader("allow", expected); json(405, { error: "method_not_allowed" }); return false; };
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return json(400, { error: "invalid_request" }); }
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      const observerRoute = path === "/api/observer" || path.startsWith("/api/observer/");
      let claims;
      const authorization = req.headers.authorization;
      const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
      try {
        claims = auth.authenticate(token, { runId: world.runId, domain: observerRoute ? "research_observation" : "participant_projection" });
        if (!observerRoute) assert(Object.hasOwn(world.polities, claims.principalId), "unknown principal");
      } catch {
        // Re-authenticate only against supported domains, never trust a decoded
        // or submitted identity. Expired, revoked, foreign-run and bogus tokens
        // cannot create an attributed event in this run.
        if (!claims) for (const domain of ["participant_projection", "research_observation", "trusted_replay", "security_audit", "public_release"]) {
          try { claims = auth.authenticate(token, { runId: world.runId, domain }); break; } catch { /* not this domain */ }
        }
        if (claims) await auditDenial(claims, "access_authorization_domain", observerRoute ? "research_observation" : "participant_projection");
        return json(401, { error: "unauthorized" });
      }
      const allowedFields = async (value, allowed, operation) => {
        if (Object.keys(value).every(key => allowed.includes(key))) return;
        await auditDenial(claims, operation, "server_owned_envelope_fields");
        assert(false, "reserved envelope field");
      };
      const noReservedFields = async (value, operation) => {
        const pending = [value];
        let found = false;
        while (pending.length && !found) {
          const current = pending.pop();
          if (Array.isArray(current)) pending.push(...current);
          else if (current && typeof current === "object") {
            found = reserved.some(key => Object.hasOwn(current, key));
            pending.push(...Object.values(current));
          }
        }
        if (!found) return;
        await auditDenial(claims, operation, "server_owned_identity_fields");
        assert(false, "reserved action field");
      };
      try {
        if (path === "/api/state") {
          if (!method("GET")) return;
          if (url.search) return json(400, { error: "invalid_request" });
          return json(200, await stateFor(claims.principalId));
        }
        if (path === "/api/action-meta") {
          if (!method("GET")) return;
          return json(200, actionMeta);
        }
        if (observerRoute) {
          if (!method("GET")) return;
          const bundle = world.evidence.bundle(), gates = researchGate(bundle);
          // Retained pre-redaction payloads must not leak through research views.
          // Until a domain-specific redaction service is supplied, deny contents.
          if (gates.status === "REPLAY_INCOMPLETE_REDACTED") return json(409, { error: "redacted_evidence_unavailable", gates });
          try { verifyEvidenceIntegrity(bundle); }
          catch { return json(409, { error: "research_evidence_integrity_failed", gates: { ...gates,
            status: "EVIDENCE_INTEGRITY_FAILED", integrity_verified: false, state_replay: false } }); }
          gates.integrity_verified = true;
          if (path === "/api/observer") return json(200, { authorization_domain: "research_observation", world: world.authoritativeState(), evidence: bundle, gates, interpretation: "Build / nonempirical conformance. No research result.", evidence_levels: ["Raw observation", "Deterministic measurement", "Coded interpretation", "Theoretical interpretation"] });
          if (path === "/api/observer/export") {
            return json(200, { authorization_domain: "research_observation", evidence: bundle, manifest: { schema_version: "1.0.0", run_id: world.runId, event_head: world.evidence.previousHash, exploratory_only: true, nonempirical: true, independent_sample: false }, gates });
          }
          if (path === "/api/observer/analysis") {
            if (!analysisManifest) return json(409, { error: "analysis_manifest_required" });
            return json(200, { authorization_domain: "research_observation", analysis: deriveEndpoint(bundle, { runId: world.runId, manifest: analysisManifest }) });
          }
          if (path === "/api/observer/replay") {
            const turnText = url.searchParams.get("turn"), view = url.searchParams.get("view") ?? "truth", principal = url.searchParams.get("principal");
            if (!/^\d+$/.test(turnText ?? "") || !["truth", "knowledge"].includes(view) || [...url.searchParams.keys()].some(k => !["turn", "view", "principal"].includes(k))) return json(400, { error: "invalid_replay_request" });
            const rebuilt = reconstructRun(bundle);
            const snapshot = rebuilt.world.snapshots.findLast(item => item.turn === Number(turnText));
            if (!snapshot) return json(409, { error: "completed_snapshot_unavailable", gates });
            // The authoritative reducer snapshot is the state actually published
            // for the next input boundary (turn N+1). Historical replay labels the
            // observation period by the completed turn N. Override only the
            // projection clock; the projected facts remain those from the
            // content-addressed published snapshot.
            const historical = { ...rebuilt.world, ...clone(snapshot.state), runId: world.runId,
              turn: snapshot.turn, phase: "actions" };
            const replayGates = { ...gates, status: "STATE_RECONSTRUCTED", exact_reproducibility: true, logical_time: { turn: snapshot.turn, phase: snapshot.state.phase }, independent_sample: false };
            if (view === "knowledge") {
              if (!principal || !Object.hasOwn(historical.polities, principal)) return json(400, { error: "invalid_replay_request" });
              return json(200, { authorization_domain: "research_observation", projection: scopedProjection(historical, principal), gates: replayGates });
            }
            return json(200, { authorization_domain: "research_observation", world: snapshot.state, gates: replayGates });
          }
          return json(404, { error: "not_found" });
        }
        if (["/api/diplomacy", "/api/phase/ready"].includes(path)) {
          if (!method("POST")) return;
          if (!allowSyntheticExecution) return json(403, { error: "execution_not_authorized" });
          if (!runService) return json(409, { error: "phase_service_required" });
          const body = await readJson(req), diplomacy = path === "/api/diplomacy";
          await allowedFields(body, ["turn", "phase", "projection_id", "request_id", ...(diplomacy ? ["command"] : [])], diplomacy ? "send_communication" : "complete_phase");
          assert(Number.isSafeInteger(body.turn) && typeof body.phase === "string" && typeof body.projection_id === "string", "invalid phase observation");
          if (diplomacy) {
            assert(body.command && typeof body.command === "object" && !Array.isArray(body.command), "invalid communication command");
            await noReservedFields(body.command, "send_communication");
            assert(typeof body.request_id === "string" && body.request_id.length > 0, "communication request identity required");
          }
          const input = { principalId: claims.principalId, turn: body.turn, phase: body.phase, projectionId: body.projection_id,
            ...(body.request_id ? { requestId: body.request_id } : {}) };
          const result = diplomacy ? await runService.participantDiplomacy({ ...input, command: body.command }) : await runService.participantReady(input);
          // No engine/controller state, roster, private errors or foreign readiness.
          return json(result.status === "rejected" ? 422 : 200, diplomacy ? { status: result.status,
            ...(result.channel_id ? { channel_id: result.channel_id } : {}) } : { status: "ready" });
        }
        if (path === "/api/action") {
          if (!method("POST")) return;
          if (!allowSyntheticExecution) return json(403, { error: "execution_not_authorized" });
          const principal = claims.principalId;
          if (inFlight.has(principal)) return json(409, { error: "submission_unavailable" });
          inFlight.add(principal);
          try {
            const body = await readJson(req);
            const batch = Object.hasOwn(body, "actions");
            if (batch) await allowedFields(body, ["actions", "turn", "phase", "projection_id"], "submit_actions");
            const actions = batch ? body.actions : [body];
            assert(Array.isArray(actions) && (actions.length > 0 || batch && runService?.phaseState?.phase === "final_planning") && actions.length <= world.config.phases.actionLimit, "invalid action set");
            for (const action of actions) {
              assert(action && typeof action === "object" && !Array.isArray(action), "invalid action");
              await noReservedFields(action, "submit_actions");
              // Structurally representable invalid actions go through the same
              // canonical rejection path as AI actions and consume the turn.
            }
            const state = await stateFor(principal);
            if (!state.controls.can_submit) return json(409, { error: "submission_unavailable" });
            const projection = state.projection;
            if (batch && (body.turn !== projection.logical_time.turn || body.projection_id !== projection.projection_id ||
              runService?.phaseState && body.phase !== projection.logical_time.phase)) return json(409, { error: "stale_observation" });
            if (runService) {
              assert(typeof runService.submitParticipantActions === "function", "service submission interface unavailable");
              const result = await runService.submitParticipantActions({ principalId: principal, actions, turn: projection.logical_time.turn,
                ...(runService.phaseState ? { phase: projection.logical_time.phase } : {}), projectionId: projection.projection_id });
              // Adapter internals, state and foreign submission counts never pass through.
              if (result.status === "rejected") return json(422, { error: "action_rejected" });
              return json(200, { status: "submitted", submission_id: result.submission_id });
            }
            const invocationId = stableId("human-invocation", world.runId, principal, world.turn, ledger.sequence);
            const submitted = ledger.submit({ runId: world.runId, turnId: "turn-" + world.turn, actorId: principal, actor: { persistent_identity_id: principal, session_id: stableId("human-session", world.runId, principal), invocation_id: invocationId }, actions, projection });
            const validated = ledger.validate(submitted, world);
            // A rejected attempt consumes its opportunity. It cannot be corrected.
            if (validated.submission.status !== "validated") pending.set(principal, { rejected: true });
            else pending.set(principal, validated);
            const alive = Object.values(world.polities).filter(p => p.alive).map(p => p.id);
            if (alive.every(id => pending.has(id))) {
              const accepted = alive.map(id => pending.get(id)).filter(item => !item.rejected);
              // An all-rejected turn is left for the durable phase service; never
              // fabricate accepted wait actions or an undocumented transition.
              worldModule.resolveTurn(world, commitTurn(world, ledger, accepted)); pending.clear();
            }
            if (validated.submission.status !== "validated") return json(422, { error: "action_rejected", validation: validated.submission.validation });
            return json(200, { status: "submitted", submission_id: submitted.submission_id });
          } catch { return json(400, { error: "invalid_action_request" }); }
          finally { inFlight.delete(principal); }
        }
        return json(404, { error: "not_found" });
      } catch { return json(409, { error: observerRoute ? "research_evidence_unavailable" : "observation_unavailable" }); }
    }
    if (!method("GET")) return;
    const asset = path === "/" ? "/index.html" : path === "/observer" ? "/observer.html" : path;
    if (!assets.has(asset)) return json(404, { error: "not_found" });
    try { const body = await readFile(resolve(root, "." + asset)); res.setHeader("content-type", types[extname(asset)]); res.end(body); }
    catch { return json(404, { error: "not_found" }); }
  });
  return { server, auth, get world() { return runService?.world ?? world; } };
}
export const application = createApplication();
export const server = application.server;
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(0, "127.0.0.1", () => console.log("CivilizationLab build preview ready; credential issuance is a trusted operator operation."));
