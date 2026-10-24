import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {canonical} from '../dist/contract-check/packages/platform/src/canonical.js';
import {inputFor,businessInput,domainOriginFor} from '../dist/contract-check/apps/mcp/src/schemas.js';
import {urlImportSchemas,urlImportRoutes} from '../dist/contract-check/apps/mem/src/url-import-contracts.js';
import {independentInputCases} from './fixtures/independent-input-cases.mjs';
const mcpBefore=JSON.parse(await readFile(new URL('./fixtures/independent-mcp-before.json',import.meta.url),'utf8'));
const urlBefore=JSON.parse(await readFile(new URL('./fixtures/independent-url-before.json',import.meta.url),'utf8'));
test('old independent endpoint inputs preserve acceptance and normalized request bytes',()=>{
 for(const[label,name,input]of independentInputCases){let result;try{result={label,ok:true,body_sha256:createHash('sha256').update(canonical(businessInput(inputFor(name).parse(input)))).digest('hex')};}catch{result={label,ok:false};}assert.deepEqual(result,mcpBefore.find(x=>x.label===label),label);}
});
test('URL HTTP contract trees remain identical to the verified original source',()=>{
 for(const name of Object.keys(urlBefore))assert.deepEqual(z.toJSONSchema(urlImportSchemas[name],{io:'input'}),urlBefore[name],name);
 assert.deepEqual(urlImportRoutes,{begin:'/import',resume:'/resume',status:'/status'});
});
test('independent schemas retain their endpoint owner and never become Mem-main contracts',()=>{
 for(const name of ['mem.url.import','mem.url.resume','mem.url.status']){assert.equal(domainOriginFor(name).owner,'url_import');assert.equal(domainOriginFor(name).endpoint_key,'url_import');assert.equal(domainOriginFor(name).path,'apps/mem/src/url-import-contracts.ts');}
 for(const name of ['mem.semantic.query','mem.semantic.index_fixed']){assert.equal(domainOriginFor(name).owner,'semantic');assert.equal(domainOriginFor(name).endpoint_key,'semantic');assert.equal(domainOriginFor(name).path,'packages/semantic-service/source/input_contracts.py');}
 const item=independentInputCases.find(x=>x[0]==='semantic-direct');assert.deepEqual(businessInput(inputFor(item[1]).parse({payload:item[2]})),item[2]);
});
