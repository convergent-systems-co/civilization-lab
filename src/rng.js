import { createHash } from "node:crypto";
import { assert, canonicalize, sha256 } from "./core.js";

export class AddressableRng {
  constructor(seed, evidence = null) {
    this.seed = String(seed);
    this.evidence = evidence;
    this.draws = new Map();
  }

  address({ runId, turnId, phase, subsystem, eventOrActionId, purpose, streamNamespace = "world", drawOrdinal = 0 }) {
    return canonicalize([runId, turnId, phase, subsystem, eventOrActionId, purpose, streamNamespace, drawOrdinal]);
  }

  draw(input) {
    const address = this.address(input);
    const digest = createHash("sha256").update(`${this.seed}|${address}`).digest("hex");
    const value = Number.parseInt(digest.slice(0, 12), 16) / 0x1000000000000;
    assert(!this.draws.has(address), `duplicate RNG address: ${address}`);
    const turn = Number.isInteger(input.turnId) ? input.turnId : Number.parseInt(String(input.turnId).replace(/^turn-/, ""), 10);
    assert(Number.isInteger(turn) && turn >= 0, "RNG turn must be a nonnegative integer");
    const record = { schema_version: "1.0.0", run_id: input.runId, turn, phase: input.phase, subsystem: input.subsystem, event_or_action_id: input.eventOrActionId, purpose: input.purpose, stream_namespace: input.streamNamespace ?? "world", algorithm_version: "sha256-address-v1", address, seed_or_state_ref: sha256(this.seed), draw_value: value };
    this.draws.set(address, record);
    if (this.evidence) {
      record.seed_or_state_ref = this.evidence.putPayload({ seed: this.seed }, "rng_seed");
      const addressRef = this.evidence.putPayload({ address, input }, "rng_address");
      this.evidence.append({ eventType: "RNGDraw", turn, phase: input.phase, sequence: input.drawOrdinal, payload: record,
        provenance: { input_refs: [record.seed_or_state_ref, addressRef] }, rng: { address, value } });
    }
    return value;
  }

  replayRecord(address) { return this.draws.get(address); }
  manifest() { return [...this.draws.values()].map((x) => ({ ...x })); }
}
