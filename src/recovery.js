import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assert, canonicalize, sha256 } from "./core.js";
import { verifyEvidenceIntegrity, reconstructRun } from "./replay.js";
import { SignedArchive } from "./archive.js";

// A durable checkpoint publishes only a complete journal generation. A process
// crash during reducer evaluation leaves the preceding committed input journal.
// No partial transition output is advertised as canonical durable evidence.
export class DurableJournal {
  constructor(directory, runId, trust = null) {
    this.directory=resolve(directory); this.runId=runId;
    // The two-argument legacy journal remains integrity-only. Production callers
    // supply an external trust binding or use RunService/SignedArchive directly.
    this.archive = trust ? new SignedArchive({ ...trust, directory, runId }) : null;
    this.archiveHead = undefined;
  }
  async persist(bundle, { fault = () => {} } = {}) {
    assert(bundle.run_id===this.runId,"journal run mismatch"); verifyEvidenceIntegrity(bundle);
    // Never supersede a recoverable generation with a partial reducer emission.
    reconstructRun(bundle,{allowPendingCommit:true});
    if (this.archive) {
      if (this.archiveHead === undefined) this.archiveHead = (await this.archive.head())?.digest ?? null;
      const head = await this.archive.publish(bundle, { expectedHead: this.archiveHead, fault });
      this.archiveHead = head.digest;
      return head.digest;
    }
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const bytes=canonicalize(bundle), hash=sha256(bytes), file=resolve(this.directory,hash+".json");
    await fault("before_persistence");
    try { const handle=await open(file,"wx",0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch(error) { if(error.code!=="EEXIST") throw error; assert(sha256(await readFile(file,"utf8"))===hash,"immutable journal collision"); }
    await fault("after_generation_fsync");
    const temporary=resolve(this.directory,"pointer-"+randomUUID()+".tmp");
    const handle=await open(temporary,"wx",0o600);
    try { await handle.writeFile(canonicalize({run_id:this.runId,bundle_hash:hash})); await handle.sync(); } finally { await handle.close(); }
    await fault("before_pointer_publish");
    await rename(temporary,resolve(this.directory,"CURRENT"));
    const dir=await open(this.directory,"r"); try { await dir.sync(); } finally { await dir.close(); }
    await fault("after_pointer_publish"); return hash;
  }
  async load() {
    if (this.archive) {
      const loaded = await this.archive.load();
      assert(loaded.status === "COMPLETE", "REPLAY_INCOMPLETE_REDACTED: recovery unavailable");
      this.archiveHead = loaded.head.digest;
      return loaded.bundle;
    }
    const pointer=JSON.parse(await readFile(resolve(this.directory,"CURRENT"),"utf8"));
    assert(pointer.run_id===this.runId && /^[a-f0-9]{64}$/.test(pointer.bundle_hash),"invalid journal pointer");
    const bytes=await readFile(resolve(this.directory,pointer.bundle_hash+".json"),"utf8");
    assert(sha256(bytes)===pointer.bundle_hash,"durable journal digest mismatch");
    const bundle=JSON.parse(bytes); verifyEvidenceIntegrity(bundle); return bundle;
  }
  async recover() { return reconstructRun(await this.load(),{allowPendingCommit:true}); }
}
