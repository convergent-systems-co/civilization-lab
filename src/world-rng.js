import { AddressableRng } from './rng.js';
import { sha256 } from './core.js';

/** The base addressed algorithm, with resolvable seed and input evidence. */
export class WorldRng extends AddressableRng {
  constructor(seed,evidence,{deferred=false}={}) {
    super(seed,null);this.worldEvidence=evidence;this.deferred=deferred;this.eventRefs=new Map();
  }
  draw(input) {
    super.draw(input);const address=this.address(input),record=this.draws.get(address);
    if(input.phase==='setup' && input.subsystem==='geography') {
      // The address still binds the actual run. Geography uses the master seed and
      // semantic field coordinates, so a new run ID cannot change a matched world.
      const digest=sha256([this.seed,input.phase,input.subsystem,input.eventOrActionId,input.purpose,input.streamNamespace??'world',input.drawOrdinal??0]);
      record.draw_value=Number.parseInt(digest.slice(0,12),16)/0x1000000000000;
      record.algorithm_version='sha256-seeded-geography-v1';
    }
    record.seed_or_state_ref=this.worldEvidence.putPayload({seed:this.seed},'rng_seed');
    if(!this.deferred)this.emit(record,input.inputRefs??[]);
    return record.draw_value;
  }
  emit(record,inputRefs=[]) {
    const event=this.worldEvidence.append({eventType:'RNGDraw',turn:record.turn,phase:record.phase,payload:record,provenance:{input_refs:[record.seed_or_state_ref,...inputRefs]},rng:{address:record.address,value:record.draw_value}});
    this.eventRefs.set(record.address,event.event_id);this.lastEventRef=event.event_id;
  }
  flush() {for(const record of this.draws.values())if(!this.eventRefs.has(record.address))this.emit(record);this.deferred=false;}
}
