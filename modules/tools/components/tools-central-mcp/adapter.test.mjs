import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolsAdapter} from './adapter.mjs';

const alice={authorization:'Bearer alice-synthetic-token',actorId:'alice'};
const bob={authorization:'Bearer bob-synthetic-token',actorId:'bob'};
const doc={projectId:'fixture',title:'Fixture',body:'Fixture body',sourceName:'Synthetic fixture',mcpRequestId:'same-intent-001'};
function fixture(){
 const calls=[],receipts=new Map();let writes=0,denyWrite=false,lost=false,revoke=false;
 const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,opts)=>{
  const actor=opts.headers.authorization===alice.authorization?'alice':opts.headers.authorization===bob.authorization?'bob':null;
  calls.push({actor,url,opts});await Promise.resolve();
  if(!actor||revoke)return json({ok:false},401);
  if(url.endsWith('/capabilities'))return json({identity:{actorId:actor},modules:[{id:'knowledge'}],operations:[
   {name:'identity',agentAvailable:true,inputSchema:{type:'object',properties:{}}},
   {name:'knowledge_save',agentAvailable:!denyWrite,write:true,inputSchema:{type:'object',properties:{body:{type:'string'}},required:['body']}},
   {name:'account_password_read',agentAvailable:true,inputSchema:{type:'object'}},
   {name:'hidden',agentAvailable:false,inputSchema:{type:'object'}},
   {name:'secret',agentAvailable:true,sensitive:true,inputSchema:{type:'object'}}]});
  const key=actor+'\0'+(opts.headers['idempotency-key']??decodeURIComponent(url.split('/operations/')[1]??''));
  if(url.includes('/operations/'))return receipts.has(key)?json({ok:true,result:{state:'completed',result:receipts.get(key).value}}):json({ok:false},404);
  const b=JSON.parse(opts.body);
  if(b.operation==='identity')return json({ok:true,result:{identity:{actorId:actor}}});
  if(b.operation==='knowledge_save'){
   if(denyWrite)return json({ok:false},403);
   if('owner' in b.arguments||!b.arguments.sourceName)return json({ok:false},400);
   const old=receipts.get(key);
   if(old&&old.body!==opts.body)return json({ok:false},409);
   if(old)return json({ok:true,result:{...old.value,replayed:true}});
   const value={state:'published',item:{id:'fixture-'+(++writes),owner:actor}};receipts.set(key,{body:opts.body,value});
   if(lost){lost=false;throw Error('synthetic transport loss');}
   return json({ok:true,result:value});
  }
  return json({ok:false},404);
 };
 return{fetchImpl,calls,get writes(){return writes;},deny(){denyWrite=true;},lose(){lost=true;},revoke(){revoke=true;}};
}
test('catalog uses native schemas and removes sensitive operations and local file tools',async()=>{
 const f=fixture(),a=createToolsAdapter(f),d=await a.catalog(alice),names=d.tools.map(x=>x.name);
 assert(names.includes('tools.api.knowledge_save'));assert(!names.some(x=>/password|hidden|secret|upload_file/.test(x)));
 assert(d.tools.find(x=>x.name==='tools.api.knowledge_save').inputSchema.required.includes('mcpRequestId'));
 assert.equal(d.localFileAccess,false);
});
test('missing caller never falls back to a configured member or forwards credentials from arguments',async()=>{
 const f=fixture(),a=createToolsAdapter(f);
 for(const ctx of [{},{authorization:alice.authorization},{...alice,authorization:'Bearer bad token'}])assert((await a.invoke(ctx,'tools.api.identity',{authorization:alice.authorization,actorId:'alice'})).isError);
 assert.equal(f.calls.length,0);
});
test('simultaneous callers remain isolated in identity, writes, and receipts',async()=>{
 const f=fixture(),a=createToolsAdapter(f);
 const [x,y]=await Promise.all([a.invoke(alice,'tools.api.knowledge_save',doc),a.invoke(bob,'tools.api.knowledge_save',doc)]);
 assert.equal(x.value.item.owner,'alice');assert.equal(y.value.item.owner,'bob');assert.notEqual(x.value.item.id,y.value.item.id);
 const status=await a.invoke(bob,'tools.api.request_status',{mcpRequestId:doc.mcpRequestId});assert.equal(status.value.result.item.owner,'bob');
});
test('replay survives adapter restarts and conflicting payload is rejected by original API',async()=>{
 const f=fixture(),a=createToolsAdapter(f),first=await a.invoke(alice,'tools.api.knowledge_save',doc);
 const b=createToolsAdapter(f),again=await b.invoke(alice,'tools.api.knowledge_save',doc);
 assert.equal(first.value.item.id,again.value.item.id);assert.equal(f.writes,1);
 const changed=await b.invoke(alice,'tools.api.knowledge_save',{...doc,body:'Changed'});assert.equal(changed.value.httpStatus,409);assert.equal(f.writes,1);
});
test('unknown write response is pending; status and original replay recover without duplicate',async()=>{
 const f=fixture(),a=createToolsAdapter(f);f.lose();
 const pending=await a.invoke(alice,'tools.api.knowledge_save',doc);assert(pending.isError);assert.equal(pending.value.state,'pending');
 const status=await a.invoke(alice,'tools.api.request_status',{mcpRequestId:doc.mcpRequestId});assert.equal(status.value.state,'completed');
 const retry=await a.invoke(alice,'tools.api.knowledge_save',doc);assert(!retry.isError);assert.equal(f.writes,1);
});
test('current permissions and authentication are checked again after discovery',async()=>{
 const f=fixture(),a=createToolsAdapter(f);await a.catalog(alice);f.deny();
 const r=await a.invoke(alice,'tools.api.knowledge_save',doc);assert.equal(r.value.httpStatus,403);assert.equal(f.writes,0);
 f.revoke();assert.equal((await a.invoke(alice,'tools.api.identity',{})).value.httpStatus,401);
});
test('identity mismatch is rejected; credentials are never echoed in API errors',async()=>{
 const f=fixture(),a=createToolsAdapter(f),r=await a.invoke({...alice,actorId:'bob'},'tools.api.identity',{});
 assert.equal(r.value.error_code,'upstream_member_identity_mismatch');assert(!JSON.stringify(r).includes('synthetic-token'));
});
test('write requires stable request ID and forwards original source/ownership validation to API',async()=>{
 const f=fixture(),a=createToolsAdapter(f);
 for(const args of [{...doc,mcpRequestId:undefined},{...doc,mcpRequestId:'x'},{...doc,owner:'bob'},{...doc,sourceName:''}])assert((await a.invoke(alice,'tools.api.knowledge_save',args)).isError);
 assert.equal(f.writes,0);
});
test('request status does not leak another member receipt or replay writes',async()=>{
 const f=fixture(),a=createToolsAdapter(f);await a.invoke(alice,'tools.api.knowledge_save',doc);
 const r=await a.invoke(bob,'tools.api.request_status',{mcpRequestId:doc.mcpRequestId});assert.equal(r.value.httpStatus,404);assert.equal(f.writes,1);
});
test('production origin is fixed; model arguments cannot select a remote API host',()=>{
 assert.throws(()=>createToolsAdapter({apiBase:'https://attacker.invalid/agent/v1'}));
 assert.throws(()=>createToolsAdapter({apiBase:'http://localhost/agent/v1'}));
});
test('the current bearer cannot be accidentally saved as document content',async()=>{
 const f=fixture(),a=createToolsAdapter(f),r=await a.invoke(alice,'tools.api.knowledge_save',{...doc,body:alice.authorization});
 assert.equal(r.value.error_code,'credential_in_arguments_forbidden');assert.equal(f.writes,0);
});
