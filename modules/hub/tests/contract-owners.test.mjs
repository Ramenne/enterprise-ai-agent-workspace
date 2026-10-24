import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inputFor,businessInput,domainOriginFor,domainMinimumFor} from '../dist/contract-check/apps/mcp/src/schemas.js';
import {projectPrivacySchemas} from '../dist/contract-check/apps/hufu/src/project-privacy-contracts.js';
const before=JSON.parse(await readFile(new URL('./fixtures/contract-owner-before.json',import.meta.url),'utf8'));
test('original direct, payload and mixed inputs keep their parsed body and request fingerprint',()=>{
 for(const item of before){let result;try{result={ok:true,body:businessInput(inputFor(item.name).parse(item.input))};}catch{result={ok:false};}assert.deepEqual(result,item.ok?{ok:true,body:item.body}:{ok:false},item.label);}
});
test('privacy domain is the sole field owner, with no newly injected defaults',()=>{
 const id='16f05f01-4a43-4e96-a16b-d8ed69eff77d';
 assert.deepEqual(domainMinimumFor('hufu.project.privacy.requests'),[]);
 assert.deepEqual(domainMinimumFor('hufu.project.privacy.apply'),['project_id','idempotency_key']);
 assert.deepEqual(inputFor('hufu.project.privacy.requests').parse({}),{});
 for(const b of [{project_id:id,expires_at:'not-a-date',idempotency_key:'synthetic'},{project_id:id,purpose:'x'.repeat(4001),idempotency_key:'synthetic'}]){
  assert.equal(projectPrivacySchemas.apply.safeParse(b).success,false);
  assert.equal(inputFor('hufu.project.privacy.apply').safeParse(b).success,false);
 }
 for(const command of Object.keys(projectPrivacySchemas))assert.equal(domainOriginFor('hufu.project.privacy.'+command).path,'apps/hufu/src/project-privacy-contracts.ts');
});
test('legacy normalization is published by actual Mem owner and real mixed changes still conflict',()=>{
 const item=before.find(x=>x.label==='legacy-direct'),input=item.input;
 assert.equal(domainOriginFor(item.name).path,'source/apps/mem/src/legacy-contracts.mjs');
 assert.equal(domainOriginFor(item.name).projection,'legacy-domain-defaults-v1');
 assert.deepEqual(new Set(domainMinimumFor(item.name)),new Set(['project_id','import_scope_id','source_system','items','idempotency_key']));
 assert.throws(()=>businessInput(inputFor(item.name).parse({...input,payload:{...input,source_system:'different'}})),/mixed_input_conflict/);
 assert.equal(businessInput(inputFor(item.name).parse(input)).items[0].original_address,'');
});
