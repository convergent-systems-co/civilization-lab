import { createHash, randomBytes } from "node:crypto";

// Match the authorization vocabulary used by replay. Domains are disjoint:
// research_observation (Observer) never implies participant_projection access.
const DOMAINS = new Set([
  "participant_projection", "research_observation", "trusted_replay",
  "security_audit", "public_release"
]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ISSUE_FIELDS = new Set(["runId", "principalId", "domain", "ttlMs"]);
const AUTH_FIELDS = new Set(["runId", "principalId", "domain"]);
const digest = (token) => createHash("sha256").update(token, "utf8").digest("hex");
const identifier = (value) => typeof value === "string" && value.trim().length > 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const validToken = (token) => typeof token === "string" && TOKEN_PATTERN.test(token);
const validFields = (value, fields) => value !== null && typeof value === "object"
  && !Array.isArray(value)
  && Reflect.ownKeys(value).every((key) => fields.has(key));

function unauthorized() {
  return Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED", statusCode: 401 });
}

/**
 * In-memory bearer sessions. The trusted server owns issuance; never expose
 * issue() as an unauthenticated endpoint or accept a domain chosen by a client.
 * Route handlers supply the expected run/domain and, when targeting an actor,
 * principalId. Authenticate on every request; returned claims are not credentials.
 *
 * Tokens use OS cryptographic randomness, independently of simulation RNG and
 * experimental identity. Only SHA-256 digests and immutable claims are retained.
 * Tokens must not enter projections, canonical evidence, logs, or identity fields.
 * Restarting this service invalidates all sessions; it performs no I/O.
 */
export class AuthService {
  #clock;
  #sessions = new Map();

  /** clock() returns wall-clock milliseconds; this is separate from logical time. */
  constructor({ clock = Date.now } = {}) {
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#clock = clock;
  }

  /** Return a new opaque token string. ttlMs must be an explicit positive integer. */
  issue(options) {
    if (!validFields(options, ISSUE_FIELDS)
      || !["runId", "principalId", "domain", "ttlMs"].every((key) => Object.hasOwn(options, key))
      || !identifier(options.runId) || !identifier(options.principalId)
      || !DOMAINS.has(options.domain)
      || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new TypeError("invalid session parameters");
    }
    const issuedAt = this.#clock();
    const expiresAt = issuedAt + options.ttlMs;
    if (!timestamp(issuedAt) || !timestamp(expiresAt)) {
      throw new TypeError("invalid session time");
    }
    let token;
    let hash;
    do {
      token = randomBytes(32).toString("base64url");
      hash = digest(token);
    } while (this.#sessions.has(hash) || token === options.runId || token === options.principalId);
    this.#sessions.set(hash, Object.freeze({
      runId: options.runId, principalId: options.principalId, domain: options.domain,
      issuedAt, expiresAt
    }));
    return token;
  }

  /** Return frozen, credential-free claims; all authentication denials are identical. */
  authenticate(token, context) {
    try {
      if (!validToken(token) || !validFields(context, AUTH_FIELDS)
        || !Object.hasOwn(context, "runId") || !Object.hasOwn(context, "domain")
        || !identifier(context.runId) || !DOMAINS.has(context.domain)
        || (Object.hasOwn(context, "principalId") && !identifier(context.principalId))) {
        throw unauthorized();
      }
      const hash = digest(token);
      const session = this.#sessions.get(hash);
      const now = this.#clock();
      if (!session || !timestamp(now)) throw unauthorized();
      if (now < session.issuedAt || now >= session.expiresAt) {
        this.#sessions.delete(hash);
        throw unauthorized();
      }
      if (session.runId !== context.runId || session.domain !== context.domain
        || (Object.hasOwn(context, "principalId") && session.principalId !== context.principalId)) {
        throw unauthorized();
      }
      return Object.freeze({ ...session });
    } catch {
      // Do not reveal token existence, scope, lifecycle, or clock/internal errors.
      throw unauthorized();
    }
  }

  /** Idempotent, silent revocation; reveals no token-existence information. */
  revoke(token) {
    if (validToken(token)) this.#sessions.delete(digest(token));
  }
}
