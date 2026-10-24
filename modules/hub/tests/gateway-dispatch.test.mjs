import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {documentSave,resolvedDocumentFields} from '../packages/mcp-edge/source/document-contract.mjs';
const source=await readFile(new URL('../packages/mcp-edge/source/gateway.mjs',import.meta.url),'utf8');
const text=source.slice(source.indexOf('async function dispatch('),source.indexOf('\nconst server='));
function harness(fail=false){let catalogCalls=0,identityCalls=0;const tokens=[];
 const context={canonicalToolName:x=>x,compatibilityArgs:(_n,a)=>a,fullTools:async token=>{catalogCalls++;tokens.push(token);if(fail)throw Object.assign(Error('unauthenticated'),{status:401});return[{name:'v8.work.read',description:'read',inputSchema:{}}];},nextIdentity:async token=>{identityCalls++;return{token};},call:async()=>({state:'documented_route',name:'v8.work.read'}),unwrap:x=>x,toolResult:(_id,data)=>data,cfg:{nextMcp:'synthetic'},error:message=>Error(message),dispatch:undefined};
 for(const name of ['controlTools','xingxiuTools','authorizationTools','databaseTools','serviceTools','fileNumberTools','disclosureTools'])context[name]=[];
 const fn=vm.runInNewContext('('+text+')',context);context.dispatch=fn;
 return{fn,counts:()=>({catalogCalls,identityCalls,tokens})};
}
const request={method:'tools/call',id:'test',params:{name:'hub.help',arguments:{tool:'v8.work.read'}}};
test('native help fetches one catalog per request and preserves response',async()=>{const h=harness();const r=await h.fn(request,'hub2_synthetic_a',{});assert.equal(r.state,'documented_route');assert.equal(r.name,'v8.work.read');assert.equal(h.counts().catalogCalls,1);});
test('catalog result is never reused across requests or callers',async()=>{const h=harness();await h.fn(request,'hub2_synthetic_a',{});await h.fn(request,'hub2_synthetic_b',{});assert.equal(h.counts().catalogCalls,2);assert.deepEqual(h.counts().tokens,['hub2_synthetic_a','hub2_synthetic_b']);});
test('catalog identity failures still abort the request',async()=>{const h=harness(true);await assert.rejects(h.fn(request,'hub2_synthetic_revoked',{}),{message:'unauthenticated'});assert.equal(h.counts().identityCalls,0);});
test('public document aliases cannot enter the resolved domain command',()=>{assert.equal(documentSave.inputSchema.required.join(','),'path,text');for(const alias of ['project_name','project','create_if_missing']){assert.ok(documentSave.inputSchema.properties[alias]);assert.ok(!resolvedDocumentFields.has(alias));}for(const key of ['project_id','path','text','base_revision','idempotency_key','register_work'])assert.ok(resolvedDocumentFields.has(key));assert.ok(!resolvedDocumentFields.has('actor_id'));});
