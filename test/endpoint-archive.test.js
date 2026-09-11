import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {makeWorld,resolveTurn} from '../src/world.js';
import {ActionLedger,commitTurn,projectWorld} from '../src/contracts.js';
import {prepareSyntheticCodingPacket,recordCoding} from '../src/coding.js';
import {deriveEndpoint,deriveArchivedEndpoint,endpointAnalysisPackage,verifyEndpointAnalysisPackage,fixedFixtureReference,WINDOW_ATTRIBUTION} from '../src/analysis.js';
import {sha256} from '../src/core.js';
import {SignedArchive,archiveKeyId} from '../src/archive.js';
import {replay,createAuthorizationContext} from '../src/replay.js';

test('actual reducer archive independently replays and regenerates all endpoint blocks through external signature verification',async t=>{
  const w=makeWorld({runId:'synthetic-endpoint-archive',seed:'endpoint-clean-room'}),ledger=new ActionLedger(w.evidence);
  for(let turn=0;turn<20;turn++){
    const records=Object.keys(w.polities).filter(id=>w.polities[id].alive).map(id=>ledger.validate(ledger.submit({runId:w.runId,turnId:'turn-'+turn,actorId:id,actor:{persistent_identity_id:id,session_id:'synthetic-session-'+id,invocation_id:'synthetic-call-'+turn+'-'+id},actions:[{type:'wait'}],projection:projectWorld(w,id)}),w));
    resolveTurn(w,commitTurn(w,ledger,records));
  }
  const packet=prepareSyntheticCodingPacket(w.evidence);
  assert.ok(packet.input.observations.some(o=>o.type==='WorldTransition' && o.facts.before_state && o.facts.after_state));
  assert.equal(JSON.stringify(packet.input.observations).includes('"polity-1"'),false);
  recordCoding(w.evidence,packet,{annotations:[],reviewedRefs:packet.input.observations.map(o=>o.ref),coder:{id:'synthetic-no-relational-opportunities',version:'1',mode:'synthetic_fixture'}});
  const options={runId:w.runId,manifest:{version:'synthetic-archive-analysis-v1',purpose:'conformance',horizon:20,experimental_unit:'run',window_attribution:WINDOW_ATTRIBUTION,reference:fixedFixtureReference()}};
  const expected=deriveEndpoint(w.evidence.bundle(),options);
  assert.equal(replay(w.evidence.bundle(),{expectedRunId:w.runId,authorizationContext:createAuthorizationContext('trusted_replay')}).status,'EXACT_REPLAY');
  const directory=await mkdtemp(join(tmpdir(),'civlab-endpoint-export-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const keys=generateKeyPairSync('ed25519'),trust={runId:w.runId,publicKey:keys.publicKey,keyId:archiveKeyId(keys.publicKey)},archive=new SignedArchive({directory,...trust,privateKey:keys.privateKey});
  const head=await archive.publish(w.evidence.bundle(),{expectedHead:null,analysisPackage:endpointAnalysisPackage(options)});
  const exported=await archive.export({authorizationContext:{domain:'research_observation',principal:'synthetic-researcher'},authorize:async()=>true});
  assert.equal(exported.object.analysis_package.package_hash,endpointAnalysisPackage(options).package_hash);
  assert.ok(exported.object.analysis_package.assets['file:src/analysis.js'].includes('deriveEndpoint'));
  assert.equal(JSON.parse(exported.object.analysis_package.assets.analysis_manifest).version,options.manifest.version);
  const actual=deriveArchivedEndpoint(JSON.parse(JSON.stringify(exported)),{...trust,trustedHead:head});
  assert.equal(actual.provenance.archive_authenticity.authenticity,'EXTERNAL_ED25519_BINDING_VERIFIED');delete actual.provenance.archive_authenticity;
  assert.deepEqual(actual,expected);assert.equal(actual.independent_replicates,1);assert.equal(actual.confirmatory_eligible,false);
  const portableTrust={runId:w.runId,keyId:trust.keyId,trustedHead:head,
    publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
  const materialized=await mkdtemp(join(tmpdir(),'civlab-endpoint-materialized-'));t.after(()=>rm(materialized,{recursive:true,force:true}));
  const runtime=JSON.parse(exported.object.analysis_package.assets.runtime_manifest);
  for(const required of ['src/analysis.js','src/archive-trust.js','schemas/canonical-event.schema.json','package.json','package-lock.json'])assert.ok(runtime.files.includes(required),required);
  for(const path of runtime.files){const target=join(materialized,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,exported.object.analysis_package.assets['file:'+path]);}
  const child=spawnSync(process.execPath,[join(materialized,runtime.entrypoint)],{
    cwd:materialized,
    input:JSON.stringify({exported,trust:portableTrust}),encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(child.status,0,child.stderr);const cleanRoom=JSON.parse(child.stdout);
  assert.equal(cleanRoom.provenance.archive_authenticity.authenticity,'EXTERNAL_ED25519_BINDING_VERIFIED');
  delete cleanRoom.provenance.archive_authenticity;assert.deepEqual(cleanRoom,expected);
  const omitted=structuredClone(exported.object.analysis_package);delete omitted.assets['file:src/core.js'];delete omitted.hashes['file:src/core.js'];omitted.package_hash=sha256(omitted.assets);
  assert.throws(()=>verifyEndpointAnalysisPackage(omitted,w.runId),/transitive asset set incomplete/);
  const mutated=structuredClone(exported.object.analysis_package);mutated.assets['file:src/core.js']+='\n// mutation';mutated.hashes['file:src/core.js']=sha256(mutated.assets['file:src/core.js']);mutated.package_hash=sha256(mutated.assets);
  assert.throws(()=>verifyEndpointAnalysisPackage(mutated,w.runId),/transitive endpoint dependency differs/);
  const wrong=generateKeyPairSync('ed25519');assert.throws(()=>deriveArchivedEndpoint(exported,{...trust,publicKey:wrong.publicKey,keyId:archiveKeyId(wrong.publicKey)}));
  const altered=structuredClone(options);altered.manifest.reference.version='substituted';assert.throws(()=>deriveArchivedEndpoint(exported,trust,altered),/provenance lock/);
  const bareDirectory=await mkdtemp(join(tmpdir(),'civlab-endpoint-bare-'));t.after(()=>rm(bareDirectory,{recursive:true,force:true}));
  const bareKeys=generateKeyPairSync('ed25519'),bareTrust={runId:w.runId,publicKey:bareKeys.publicKey,keyId:archiveKeyId(bareKeys.publicKey)};
  const bareArchive=new SignedArchive({directory:bareDirectory,...bareTrust,privateKey:bareKeys.privateKey});
  const bareHead=await bareArchive.publish(w.evidence.bundle(),{expectedHead:null});
  const bareExport=await bareArchive.export({authorizationContext:{domain:'research_observation',principal:'synthetic-researcher'},authorize:async()=>true});
  assert.throws(()=>deriveArchivedEndpoint(bareExport,{...bareTrust,trustedHead:bareHead}),/self-contained endpoint analysis package/);
});
