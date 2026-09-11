import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assert, clone, sha256, canonicalize } from "./core.js";
import { assertValidSchema } from "./schema.js";
import { archivedCoding, CODEBOOK_HASH, CODEBOOK_TEXT } from "./coding.js";
import { verifyArchiveExport } from "./archive.js";
import { reconstructRun } from "./replay.js";

export const ENDPOINT_CONTRACT = JSON.parse(readFileSync(new URL("../PRIMARY_ENDPOINT.spec.json", import.meta.url), "utf8"));
export const PRIMARY_COMPONENTS = Object.freeze(["A", "B", "C", "D"]);
export const BASE_COORDINATES = Object.freeze(["A.fulfillment", "B.positive", "B.negative", "C.restorative_act"]);
export const STATUSES = Object.freeze(["OBSERVED", "ZERO_OPPORTUNITY", "CENSORED", "UNEVALUABLE", "MISSING_DUE_TO_BREACH", "MISSING_DUE_TO_SYSTEM_FAILURE"]);
export const WINDOW_ATTRIBUTION = Object.freeze({commitment_formation:"formation_turn",commitment_outcome:"due_or_evaluable_turn",reciprocity_opportunity:"initiating_action_turn",repair_opportunity:"rupture_turn",repair_outcome:"disposition_turn"});
const sourceHash = sha256(readFileSync(new URL("./analysis.js", import.meta.url), "utf8"));
const codingSource = readFileSync(new URL("./coding.js", import.meta.url), "utf8");
const codingSourceHash = sha256(codingSource);
const PACKAGE_ROOT=resolve(import.meta.dirname,"..");
const PACKAGE_STATIC_FILES=Object.freeze([
  "scripts/derive-endpoint.js","config/pilot0-world.json","config/pilot0-model.json","package.json","package-lock.json",
  "PRIMARY_ENDPOINT.spec.json","ENDPOINT_CODEBOOK.spec.md","PARAMETER_REGISTRY.spec.json","EVENT_CATALOGUE.spec.json","BREACH_POLICY.spec.json","PROJECTION_POLICY.spec.json",
]);
export const ENDPOINT_PACKAGE_FILES=Object.freeze([...PACKAGE_STATIC_FILES,
  ...readdirSync(resolve(PACKAGE_ROOT,"src")).filter(name=>/\.(?:js|py)$/.test(name)).map(name=>"src/"+name),
  ...readdirSync(resolve(PACKAGE_ROOT,"schemas")).filter(name=>name.endsWith(".json")).map(name=>"schemas/"+name)].sort());
function endpointRuntimeManifest() {
  const pkg=JSON.parse(readFileSync(resolve(PACKAGE_ROOT,"package.json"),"utf8"));
  return {schema_version:"1.0.0",entrypoint:"scripts/derive-endpoint.js",files:[...ENDPOINT_PACKAGE_FILES],
    runtime:{node_engine:pkg.engines?.node??null,node_version:process.version,platform:process.platform,architecture:process.arch,
      builtins:["node:child_process","node:crypto","node:fs","node:fs/promises","node:http","node:path","node:sqlite","node:url"]},
    package_metadata_files:["package.json","package-lock.json"]};
}

const FIXED_CONFORMANCE_REFERENCE=Object.freeze({version:"fixture-reference-v1",purpose:"synthetic_conformance",treatment_blind:true,arm_specific:false,
  provenance:"explicit fixed zero-mean unit-scale transform; no empirical data",confirmatory_frozen:false,
  parameters:Object.fromEntries([...BASE_COORDINATES,...BASE_COORDINATES.map(k=>"D."+k)].map(k=>[k,{mean:0,sd:1}]))});
export const FIXED_CONFORMANCE_REFERENCE_HASH=sha256(FIXED_CONFORMANCE_REFERENCE);
export function scalingReferenceArtifactHash(reference) {
  const artifact=clone(reference);delete artifact.freeze_artifact_hash;return sha256(artifact);
}
export function validateScalingReference(reference,{purpose,runId,trustedReceipt=null}={}) {
  assert(reference?.treatment_blind===true&&reference.arm_specific===false&&reference.version&&reference.provenance,"common treatment-blind reference required");
  if(purpose==='conformance') {
    assert(reference.registry_hash===FIXED_CONFORMANCE_REFERENCE_HASH,"unregistered conformance scaling reference");
    const registered={...clone(FIXED_CONFORMANCE_REFERENCE),registry_hash:FIXED_CONFORMANCE_REFERENCE_HASH};
    assert(canonicalize(reference)===canonicalize(registered),"conformance scaling reference differs from registered fixed transform");
    return {kind:"REGISTERED_SYNTHETIC_CONFORMANCE",artifact_hash:reference.registry_hash};
  }
  if(["pilot0","confirmatory"].includes(purpose))throw new Error('#112_NOT_FROZEN: empirical/confirmatory scaling requires a separately authorized immutable analysis freeze');
  throw new Error('unknown scaling reference purpose');
}

export function deriveArchivedEndpoint(exported,trust,options) {
  const verified=verifyArchiveExport(exported,trust);
  assert(verified.status==='COMPLETE',"ANALYSIS_INCOMPLETE_REDACTED");
  options=lockedArchiveOptions(exported,options);
  const bundle=clone(exported.object.bundle);
  const {world}=reconstructRun(bundle);
  if(options.manifest?.purpose==='pilot0'||options.manifest?.purpose==='confirmatory')validateScalingReference(options.manifest.reference,{purpose:options.manifest.purpose,runId:bundle.run_id});
  const result=deriveEndpoint(bundle,options);
  result.provenance.archive_authenticity=verified; return result;
}

export function validateEndpointContract(contract) {
  assertValidSchema(contract, "primary-endpoint.schema.json");
  for(const component of contract.components)assertValidSchema(component,"primary-endpoint-component.schema.json");
  assert(canonicalize(contract.components.map(c => c.component_id)) === canonicalize(PRIMARY_COMPONENTS), "four ordered primary components required");
  assert(contract.components.every(c => c.grain === "run" && c.denominator && c.definition && !/placeholder|TODO|predeclared_component_function/i.test(c.definition)), "missing endpoint definition/denominator or placeholder");
  assert(contract.experimental_unit === "run" && contract.interference_assumption === "interacting_polities_are_not_independent_replicates", "run-level interference contract required");
  assert(contract.standardization.arm_specific === false && contract.coding.treatment_blind === true, "unblinded coding or arm-specific scaling forbidden");
  assert(canonicalize(contract.missingness.statuses) === canonicalize(STATUSES) && contract.missingness.imputation === "forbidden_in_pilot_0", "missingness classes cannot be collapsed");
  assert(PRIMARY_COMPONENTS.every(key => contract.weighting.weights[key] === 0.25), "four equal component weights required");
  assert(contract.temporal.reciprocity_window_turns === 5 && canonicalize(contract.temporal.early) === "[1,5]" && canonicalize(contract.temporal.late) === "[16,20]", "fixed Pilot 0 temporal contract changed");
  assert(canonicalize(contract.temporal.window_attribution)===canonicalize(WINDOW_ATTRIBUTION),"endpoint temporal attribution differs from ratified contract");
  assert(contract.aggregation.representation === "four_block_weighted_vector", "unratified scalar reduction forbidden");
  assert(sha256(contract)===sha256(ENDPOINT_CONTRACT),"endpoint differs from authoritative versioned contract");
  return true;
}

export function fixedFixtureReference() {
  return {...clone(FIXED_CONFORMANCE_REFERENCE),registry_hash:FIXED_CONFORMANCE_REFERENCE_HASH};
}
export function endpointAnalysisPackage(options) {
  assert(options?.runId && options.manifest,"endpoint package requires run and frozen manifest");
  validateScalingReference(options.manifest.reference,{purpose:options.manifest.purpose,runId:options.runId,
    trustedReceipt:options.manifest.purpose==='conformance'?null:options.referenceFreezeReceipt});
  const assets={runtime_manifest:canonicalize(endpointRuntimeManifest()),analysis_manifest:canonicalize(options.manifest)};
  for(const path of ENDPOINT_PACKAGE_FILES)assets["file:"+path]=readFileSync(resolve(PACKAGE_ROOT,path),"utf8");
  return {schema_version:"2.0.0",run_id:options.runId,assets,
    hashes:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,sha256(value)])),package_hash:sha256(assets)};
}
function lockedArchiveOptions(exported,provided) {
  const pkg=exported.object.analysis_package;
  const locked=verifyEndpointAnalysisPackage(pkg,exported.object.bundle.run_id);
  if(provided)assert(provided.runId===locked.runId&&canonicalize(provided.manifest)===canonicalize(locked.manifest)&&
    (!provided.contract||canonicalize(provided.contract)===canonicalize(locked.contract)),"external endpoint options differ from archived provenance lock");
  return locked;
}
export function verifyEndpointAnalysisPackage(pkg,runId) {
  assert(pkg?.schema_version==='2.0.0'&&pkg.run_id===runId,"self-contained endpoint analysis package required");
  assert(pkg.package_hash===sha256(pkg.assets),"endpoint analysis package digest mismatch");
  assert(canonicalize(Object.keys(pkg.hashes??{}).sort())===canonicalize(Object.keys(pkg.assets??{}).sort()),"endpoint analysis asset hash set mismatch");
  for(const [key,value] of Object.entries(pkg.assets))assert(pkg.hashes[key]===sha256(value),"endpoint analysis asset digest mismatch");
  const runtime=JSON.parse(pkg.assets.runtime_manifest??"null"),expectedRuntime=endpointRuntimeManifest();
  assert(canonicalize(runtime)===canonicalize(expectedRuntime),"endpoint package runtime/dependency manifest incomplete");
  const expectedKeys=["analysis_manifest","runtime_manifest",...ENDPOINT_PACKAGE_FILES.map(path=>"file:"+path)].sort();
  assert(canonicalize(Object.keys(pkg.assets).sort())===canonicalize(expectedKeys),"endpoint package transitive asset set incomplete");
  for(const path of ENDPOINT_PACKAGE_FILES)assert(pkg.assets["file:"+path]===readFileSync(resolve(PACKAGE_ROOT,path),"utf8"),"installed transitive endpoint dependency differs from archived provenance lock: "+path);
  assert(pkg.assets["file:src/analysis.js"]===readFileSync(new URL("./analysis.js",import.meta.url),"utf8")&&pkg.hashes["file:src/analysis.js"]===sourceHash,"installed analysis implementation differs from archived provenance lock");
  assert(pkg.assets["file:src/coding.js"]===codingSource&&pkg.hashes["file:src/coding.js"]===codingSourceHash,"installed coding implementation differs from archived provenance lock");
  const locked={runId:pkg.run_id,manifest:JSON.parse(pkg.assets.analysis_manifest),contract:JSON.parse(pkg.assets["file:PRIMARY_ENDPOINT.spec.json"])};
  return locked;
}
export function standardize(value, reference) {
  assert(reference && Number.isFinite(reference.mean) && Number.isFinite(reference.sd) && reference.sd > 0, "invalid common standardization reference");
  assert(value === null || Number.isFinite(value), "invalid raw endpoint value");
  return value === null ? null : (value - reference.mean) / reference.sd;
}
function cell(numerator, denominator, reasons, ambiguity, refs) {
  const present = STATUSES.filter(status=>(reasons[status]??0)>0);
  const status = denominator > 0 ? "OBSERVED" : present.find(item=>item!=="OBSERVED") ?? (ambiguity>0?"UNEVALUABLE":"ZERO_OPPORTUNITY");
  const contributingStatuses=STATUSES.filter(item=>item==="ZERO_OPPORTUNITY"?status==="ZERO_OPPORTUNITY":
    item==="UNEVALUABLE"?present.includes(item)||ambiguity>0:present.includes(item)||item==="OBSERVED"&&denominator>0);
  return { numerator, denominator, value: denominator ? numerator / denominator : null, status,
    structurally_observed: status === "ZERO_OPPORTUNITY", ambiguity_count: ambiguity,
    contributing_statuses:contributingStatuses,status_counts: Object.fromEntries(STATUSES.map(s => [s, reasons[s] ?? 0])), source_event_refs: [...new Set(refs)].sort() };
}
function temporalEpisode(row, observations, aliases) {
  const source=observations.get(row.source),evaluation=row.evaluation_ref?observations.get(row.evaluation_ref):null;
  if(row.kind==='commitment') {
    const dispositionTurn=evaluation?.turn??null;
    const evaluableTurn=row.outcome==='BREACHED'?(row.due_turn??dispositionTurn):
      ['FULFILLED','MODIFIED','RELEASED'].includes(row.outcome)?dispositionTurn:row.due_turn;
    return {id:row.id,kind:row.kind,formation_turn:source.turn,due_turn:row.due_turn,evaluable_turn:evaluableTurn,
      disposition_turn:dispositionTurn,disposition_status:row.outcome,source_event_ref:aliases[row.source],
      due_basis_event_refs:row.due_basis_refs.map(ref=>aliases[ref]),evaluation_event_ref:row.evaluation_ref?aliases[row.evaluation_ref]:null,window_attribution_turn:evaluableTurn};
  }
  if(row.kind==='repair') {
    const attemptTurns=row.acts.map(act=>observations.get(act.source).turn);
    return {id:row.id,kind:row.kind,rupture_turn:source.turn,repair_attempt_turn:attemptTurns.length?Math.min(...attemptTurns):null,
      repair_disposition_turn:evaluation?.turn??null,repair_status:row.outcome,source_event_ref:aliases[row.source],
      restorative_event_refs:row.acts.map(act=>aliases[act.source]).sort(),evaluation_event_ref:row.evaluation_ref?aliases[row.evaluation_ref]:null,
      window_attribution_turn:source.turn};
  }
  return {id:row.id,kind:row.kind,initiation_turn:source.turn,response_turns:row.responses.map(response=>observations.get(response.source).turn),
    source_event_ref:aliases[row.source],response_event_refs:row.responses.map(response=>aliases[response.source]).sort(),window_attribution_turn:source.turn};
}
function summarize(rows, observations, mapping, endTurn, bounds) {
  const groups = { A: [], B: [], C: [] }, unattributed={A:[],B:[],C:[]};
  const aliases = Object.fromEntries(Object.entries(mapping.refs).map(([canonical, alias]) => [alias, canonical]));
  for (const row of rows) {
    const component = { commitment: "A", reciprocity: "B", repair: "C" }[row.kind];
    const episode=temporalEpisode(row,observations,aliases);
    const full=bounds[0]===1 && bounds[1]===20;
    const turn=episode.window_attribution_turn;
    if(!full && turn===null) {unattributed[component].push({id:row.id,source_event_ref:aliases[row.source],reason:'no_evaluable_window_location',status:row.observation_status});continue;}
    if(!full && turn>endTurn) {unattributed[component].push({id:row.id,source_event_ref:aliases[row.source],reason:'after_observation_horizon',status:row.observation_status});continue;}
    if (full || turn >= bounds[0] && turn <= bounds[1]) groups[component].push(row);
  }
  const result = {};
  for (const [component, members] of Object.entries(groups)) {
    let denominator = 0, primary = 0, negative = 0, ambiguity = 0;
    const reasons = {}, refs = [], outcomes = {};
    for (const row of members) {
      refs.push(aliases[row.source]); const outcome = row.outcome ?? row.eligibility;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (row.eligibility === "INELIGIBLE") continue;
      if (row.eligibility === "AMBIGUOUS" || row.outcome === "AMBIGUOUS") { ambiguity++; if(row.observation_status!=='OBSERVED')reasons[row.observation_status]=(reasons[row.observation_status]??0)+1; continue; }
      let status = row.observation_status;
      if (status==='OBSERVED' && row.kind === "commitment" && row.outcome === "ONGOING_AT_HORIZON") status = "CENSORED";
      if (row.kind === "repair" && !row.sufficient_opportunity && status === "OBSERVED") status = "CENSORED";
      if (status==='OBSERVED' && row.outcome === "UNEVALUABLE") status = "UNEVALUABLE";
      if (row.kind === "reciprocity" && observations.get(row.source).turn + 5 > endTurn && status === "OBSERVED") status = "CENSORED";
      if (status !== "OBSERVED") { reasons[status] = (reasons[status] ?? 0) + 1; continue; }
      if (row.kind === "commitment" && !row.evaluable) { reasons.UNEVALUABLE = (reasons.UNEVALUABLE ?? 0) + 1; continue; }
      denominator++; reasons.OBSERVED = (reasons.OBSERVED ?? 0) + 1;
      if (component === "A") { primary += Number(row.outcome === "FULFILLED"); if (row.evaluation_ref) refs.push(aliases[row.evaluation_ref]); }
      if (component === "B") {
        primary += Number(row.responses.some(r => r.polarity === "POSITIVE"));
        negative += Number(row.responses.some(r => r.polarity === "NEGATIVE"));
        refs.push(...row.responses.map(r => aliases[r.source]));
      }
      if (component === "C") { primary += Number(row.acts.length > 0); refs.push(...row.acts.map(a => aliases[a.source])); }
    }
    // An early run boundary must make an otherwise empty component explicitly
    // censored, but it is not an additional opportunity and must not double-count
    // rows already classified as censored.
    if (endTurn < bounds[1] && !reasons.CENSORED) reasons.CENSORED = 1;
    result[component] = component === "B" ? { positive: cell(primary, denominator, reasons, ambiguity, refs), negative: cell(negative, denominator, reasons, ambiguity, refs), outcomes } :
      { [component === "A" ? "fulfillment" : "restorative_act"]: cell(primary, denominator, reasons, ambiguity, refs), outcomes };
    result[component].unattributed=unattributed[component];
  }
  return result;
}
const coordinate = (blocks, key) => { const [b, m] = key.split("."); return blocks[b][m]; };

// All inputs come from a canonical archive and an explicit versioned manifest;
// no mutable world, UI cache, interviews, or model state participates.
export function deriveEndpoint(bundle, { runId, manifest, contract = ENDPOINT_CONTRACT } = {}) {
  assert(runId && bundle?.run_id === runId && Array.isArray(bundle.events), "endpoint requires canonical bundle and matching run_id");
  validateEndpointContract(contract);
  assert(manifest && manifest.version, "explicit analysis manifest required");
  if(manifest.purpose==='pilot0'||manifest.purpose==='confirmatory')validateScalingReference(manifest.reference,{purpose:manifest.purpose,runId});
  assert(manifest.purpose==='conformance', "only synthetic conformance endpoint derivation is currently authorized");
  assert(manifest.horizon === 20 && manifest.experimental_unit === "run", "fixed run-level Pilot 0 analysis required");
  assert(canonicalize(manifest.window_attribution)===canonicalize(WINDOW_ATTRIBUTION),"analysis manifest must use ratified temporal attribution");
  const reference = manifest.reference;
  const referenceReceipt=validateScalingReference(reference,{purpose:manifest.purpose,runId});
  const { store, event: coding, input, mapping } = archivedCoding(bundle);
  assert(manifest.purpose === "conformance" || coding.payload.coder.mode !== "synthetic_fixture", "synthetic coding is not empirical evidence");
  assert(!store.events.some(e => e.event_type === "RedactionTombstone"), "ANALYSIS_INCOMPLETE_REDACTED");
  const resolved = store.events.filter(e => e.event_type === "TurnResolved");
  assert(resolved.length, "canonical observation boundary required");
  assert(resolved.every((e,index)=>e.turn===index),"observation coverage requires contiguous unique resolved turns");
  for(const event of resolved) {
    const commit=store.events.find(e=>e.event_type==='TurnCommitted' && e.turn===event.turn && e.payload.turn_committed_id===event.payload.turn_committed_id);
    assert(commit && event.causality.causation_ids.includes(commit.event_id),"observation boundary lacks its canonical committed input");
  }
  const endTurn = Math.max(...resolved.map(e => e.turn + 1));
  assert(endTurn <= 20, "Pilot 0 horizon exceeded");
  // Accurate evidence and experimental validity are separate. A recorded breach
  // must accompany every derivative, even when an observed behavior remains
  // reconstructable. Do not invent blanket exclusion or missingness from a mere
  // incident label; preserve the canonical affected scope and coded statuses.
  const incidents=store.events.filter(e=>e.event_type==='SecurityIncident').map(e=>({event_id:e.event_id,...clone(e.payload)}));
  const dispositions=store.events.filter(e=>e.event_type==='RunDisposition').map(e=>({event_id:e.event_id,...clone(e.payload)}));
  const validity={evidence_integrity:'VERIFIED_CANONICAL_RECORD',experimental_validity:dispositions.at(-1)?.execution_status??'NOT_DISPOSITIONED',
    incident_status:incidents.length?'INCIDENT_RECORDED':'NO_RECORDED_INCIDENT',security_incidents:incidents,run_dispositions:dispositions,
    confirmatory_eligible:false,policy_ref:'BREACH_POLICY.spec.json',
    missingness_scope:'Explicit coded affected opportunities retain their statuses; a breach does not by itself erase accurately recorded behavior or imply missing data.'};
  const observations = new Map(input.observations.map(row => [row.ref, row])), rows = coding.payload.annotations;
  const full = summarize(rows, observations, mapping, endTurn, [1, 20]);
  const early = summarize(rows, observations, mapping, endTurn, [1, 5]);
  const late = summarize(rows, observations, mapping, endTurn, [16, 20]);
  const aliases=Object.fromEntries(Object.entries(mapping.refs).map(([canonical,alias])=>[alias,canonical]));
  const temporalEpisodes=rows.map(row=>temporalEpisode(row,observations,aliases));
  const change = {}, standardized = { A: {}, B: {}, C: {}, D: {} }, weighted = { A: {}, B: {}, C: {}, D: {} };
  for (const key of BASE_COORDINATES) {
    const first = coordinate(early, key), last = coordinate(late, key);
    const observed = first.value !== null && last.value !== null && endTurn >= 20;
    const missing = STATUSES.filter(status=>[first,last].filter(c=>c.value===null).some(c=>c.contributing_statuses.includes(status)));
    change[key] = { value: observed ? last.value - first.value : null, status: observed ? "OBSERVED" : endTurn < 20 ? "CENSORED" : missing[0], missingness_reasons: [...new Set(missing)],
      early: first, late: last, denominator: "paired_run_level_window_summaries", imputed: false };
    const [block, metric] = key.split(".");
    standardized[block][metric] = standardize(coordinate(full, key).value, reference.parameters?.[key]);
    standardized.D[key] = standardize(change[key].value, reference.parameters?.["D." + key]);
  }
  for (const b of PRIMARY_COMPONENTS) for (const [k, v] of Object.entries(standardized[b])) weighted[b][k] = v === null ? null : contract.weighting.weights[b] * v;
  return { schema_version: "2.0.0", run_id: runId, experimental_unit: "run", independent_replicates: 1,
    endpoint_id: contract.endpoint_id, evidence_class: manifest.purpose === "conformance" ? "SYNTHETIC_CONFORMANCE" : "EXPLORATORY_PILOT_0",
    primary_endpoint_value: weighted, representation: "four_block_weighted_vector", scalar: null,
    normativity: "sign indicates behavioral direction, not moral valence", components: { ...full, D: change }, standardized,
    windows: { early: { bounds: [1, 5], components: early }, late: { bounds: [16, 20], components: late } },
    temporal_episodes:temporalEpisodes,
    turn_series: Array.from({ length: 20 }, (_, i) => ({ turn: i + 1, components: summarize(rows, observations, mapping, endTurn, [i + 1, i + 1]) })),
    observation_end_turn: endTurn, missingness_statuses: [...STATUSES], imputed: false, confirmatory_eligible: false,
    validity,
    provenance: { canonical_bundle_hash: sha256(bundle), coding_event_id: coding.event_id, codebook_hash: CODEBOOK_HASH,
      contract_hash: sha256(contract), analysis_source_hash: sourceHash, analysis_manifest: clone(manifest),
      analysis_manifest_hash: sha256(manifest), reference_hash: sha256(reference), reference_authorization:clone(referenceReceipt),
      package_asset_manifest_hash:sha256(endpointRuntimeManifest()),acl: "private_research" } };
}
export function regenerateEndpoint(serializedBundle, options) { return deriveEndpoint(JSON.parse(serializedBundle), options); }
