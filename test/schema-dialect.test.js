import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSupportedSchema,assertValidSchema} from '../src/schema.js';
import {readdirSync,readFileSync} from 'node:fs';

test('every canonical schema uses the enforced dialect rather than silently ignored constraints',()=>{
  for(const file of readdirSync(new URL('../schemas/',import.meta.url)).filter(f=>f.endsWith('.json')))
    assert.equal(assertSupportedSchema(JSON.parse(readFileSync(new URL('../schemas/'+file,import.meta.url),'utf8'))),true,file);
});
test('unknown constraints, types, remote references and path traversal fail closed',()=>{
  for(const schema of [{type:'object',unevaluatedProperties:false},{type:'int'},{properties:{nested:{not:{const:'secret'}}}},{$ref:'https://untrusted.test/schema.json'}])
    assert.throws(()=>assertSupportedSchema(schema),/unsupported|local/);
  assert.throws(()=>assertValidSchema({},'../config/pilot0-world.json'),/invalid local/);
});
