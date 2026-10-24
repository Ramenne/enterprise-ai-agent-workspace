import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {legacyImportSchema} from '../source/apps/mem/src/legacy-contracts.mjs';
import {registerLegacyFlow} from '../source/apps/mem/src/legacy-flow.js';
import bundle from '../generated/mcp/mem-input.json' with {type:'json'};
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',version_id='cbd510d3-162f-4a62-a3e3-9648cd067297';
const input={project_id,import_scope_id:project_id,source_system:'synthetic-contract-owner',idempotency_key:'synthetic-original-legacy-key',items:[{category:'file_alias',source_id:'synthetic',field_path:'synthetic.address',reference_kind:'latest',expected_revision:0}]};
const request=body=>({headers:{authorization:'Bearer synthetic-contract-test'},body});
test('published legacy schema preserves historical defaults and rejects forged server fields',()=>{
 const record=bundle.contracts.find(x=>x.path==='/v2/legacy/references/import'),transport=z.fromJSONSchema(record.input_schema);
 assert.equal(record.origin.path,'source/apps/mem/src/legacy-contracts.mjs');
 assert.equal(record.origin.projection,'legacy-domain-defaults-v1');
 assert.deepEqual(transport.parse(input),legacyImportSchema.parse(input));
 for(const schema of [transport,legacyImportSchema])assert.equal(schema.safeParse({...input,verified_fixed_refs:[]}).success,false);
});
test('real legacy handler consumes the shared contract and preserves server authority',async()=>{
 const routes=new Map(),calls=[],app={post:(path,fn)=>routes.set(path,fn)};
 registerLegacyFlow(app,async(token,source,name,action,body)=>{calls.push({name,action,body});return{state:'synthetic-accepted'};});
 await routes.get('/v2/legacy/references/import')(request(input));
 assert.equal(calls[0].name,'legacy_reference_import');assert.equal(calls[0].action,'mem.process');
 assert.deepEqual(calls[0].body,{...legacyImportSchema.parse(input),verified_fixed_refs:[]});
 await assert.rejects(routes.get('/v2/legacy/references/import')(request({...input,verified_fixed_refs:[{forged:true}]})),e=>e.code==='invalid_input');
 assert.equal(calls.length,1);
});
test('fixed reference proof is still checked before registering a binding',async()=>{
 const routes=new Map(),calls=[],app={post:(path,fn)=>routes.set(path,fn)};
 registerLegacyFlow(app,async(token,source,name,action,body)=>{calls.push(name);return name==='read_version'?{fixed_ref:{...body,sha256:'b'.repeat(64),size:3},read_receipt_id:project_id}:{};});
 const fixed={...input,items:[{...input.items[0],reference_kind:'fixed',legacy_version:1,source_record_sha256:'c'.repeat(64),original_content_sha256:'a'.repeat(64),fixed_ref:{material_id:project_id,version_id,sha256:'a'.repeat(64),size:3}}]};
 await assert.rejects(routes.get('/v2/legacy/references/import')(request(fixed)),e=>e.code==='legacy_fixed_integrity_mismatch');
 assert.deepEqual(calls,['read_version','gc_read_lease']);
});
