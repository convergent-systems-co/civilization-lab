import {readFileSync} from 'node:fs';
import {Qwen35BaseAdapter,loadPilotModelConfiguration,ModelRuntimeError} from '../src/model-adapter.js';
import {sha256,assert} from '../src/core.js';

assert(process.argv.includes('--non-empirical-smoke'),'explicit non-empirical smoke flag required');
const fixture=JSON.parse(readFileSync(new URL('../config/runtime-conformance.json',import.meta.url),'utf8'));
const configuration=loadPilotModelConfiguration();
const productionParameters=process.argv.includes('--production-parameters');
if(!productionParameters)configuration.generation={...configuration.generation,...fixture.generation_override};
const timeout=productionParameters?configuration.attempt_timeout_ms:fixture.timeout_ms;
const model=new Qwen35BaseAdapter({configuration,sampling:configuration.generation});
assert(!model.manifest.synthetic && model.manifest.source==='huggingface','native HF adapter required');
let capture;
const started=Date.now();
try {capture=await model.complete({prompt:fixture.prompt,deadline:Date.now()+timeout,timeoutMs:timeout});}
catch(error) {
  // The one-token fixture deliberately reaches the output cap. Production must
  // preserve the native output and reject it, never repair a partial action.
  if(!(error instanceof ModelRuntimeError) || error.code!=='partial_model_output')throw error;
  capture=error;
}
assert(capture.responseReceived && capture.rawResponse?.length,'native output not captured');
const response=JSON.parse(capture.rawResponse.toString('utf8'));
assert(response.model===configuration.repository && response.hf_revision===configuration.revision,'artifact substitution');
assert(response.artifacts.model_artifact_hash===configuration.model_artifact_hash && response.runtime_hash===configuration.runtime_hash,'provenance mismatch');
console.log(JSON.stringify({status:'PASS',purpose:fixture.purpose,research_evidence:false,world_inputs:false,
  production_parameters:productionParameters,elapsed_ms:Date.now()-started,timeout_ms:timeout,
  model:configuration.repository,revision:configuration.revision,runtime_hash:configuration.runtime_hash,
  fixture_hash:sha256(fixture),request_hash:sha256(capture.requestBody),response_hash:sha256(response),
  finish_reason:response.choices[0].finish_reason,partial_output_rejected:capture.code==='partial_model_output',
  generation_configuration:configuration.generation,context_budget:configuration.context_budget},null,2));
