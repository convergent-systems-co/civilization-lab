import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignedArchive,archiveKeyId} from '../src/archive.js';
import {makeWorld} from '../src/world.js';

test('independent publishers cannot recreate prohibited objects across the complete privacy purge boundary',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'civlab-purge-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const world=makeWorld({runId:'synthetic-purge-race',seed:'synthetic'}),keys=generateKeyPairSync('ed25519');
  const binding={directory,runId:world.runId,...keys,keyId:archiveKeyId(keys.publicKey),authorizeRedaction:async()=>true};
  const publisher=new SignedArchive(binding);
  const message=world.evidence.append({eventType:'MessageSent',turn:0,phase:'communication',payload:{from:'polity-1',to:'polity-2',text:'PROHIBITED_SYNTHETIC_CANARY'}});
  const original=await publisher.publish(world.evidence.bundle(),{expectedHead:null});
  world.evidence.append({eventType:'MessageSent',turn:0,phase:'communication',payload:{from:'polity-2',to:'polity-1',text:'unrelated synthetic message'}});
  // Separate module-local queues model separate processes, while the actual
  // SQLite file lock is shared. No mock filesystem or fake mutex is used.
  const independent=await import('../src/archive.js?independent-purge-writer');
  const purger=new independent.SignedArchive(binding);
  let release,entered;
  const reached=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const writing=publisher.publish(world.evidence.bundle(),{expectedHead:original.digest,fault:async point=>{if(point==='before_persistence'){entered();await gate;}}});
  await reached;
  const request={artifactRef:message.payload.payload_ref,fieldOrRange:'text',reason:'synthetic-consent-withdrawal',authority:'test-policy',effectiveLogicalTime:{turn:0,phase:'security'},affectedDerivations:[]};
  try {await assert.rejects(purger.redact(request,{expectedHead:original.digest}),/already claimed/);}finally{release();}
  const published=await writing;
  const redacted=await purger.redact(request,{expectedHead:published.digest});assert.equal(redacted.status,'REPLAY_INCOMPLETE_REDACTED');
  await assert.rejects(publisher.publish(world.evidence.bundle(),{expectedHead:published.digest}),/stale|redacted/);
  const objects=await readdir(join(directory,'objects'));assert.equal(objects.length,1);
  for(const name of objects)assert.equal((await readFile(join(directory,'objects',name),'utf8')).includes('PROHIBITED_SYNTHETIC_CANARY'),false);
  assert.equal((await purger.load()).status,'REPLAY_INCOMPLETE_REDACTED');
});
