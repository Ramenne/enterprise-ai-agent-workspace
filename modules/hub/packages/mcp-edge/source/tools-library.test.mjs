import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeToolsLibrary,toolsLibraryTool} from './tools-library.mjs';
const schema={type:'object',properties:{id:{type:'string'},revision:{type:'integer'},body:{type:'string'}},required:['body'],additionalProperties:false};
const catalog={identity:{actorId:'alice'},operations:[
 {name:'knowledge_save',agentAvailable:true,write:true,inputSchema:schema},
 {name:'knowledge_read',agentAvailable:true,inputSchema:{type:'object'}},
 {name:'knowledge_list',agentAvailable:true,inputSchema:{type:'object'}},
 {name:'account_password_read',agentAvailable:true,inputSchema:schema},
 {name:'secret_new',agentAvailable:true,sensitive:true,inputSchema:schema},
 {name:'not_for_agents',agentAvailable:false,inputSchema:schema},
]};
function backend({actor='alice',drop=false}={}){
 const calls=[],receipts=new Map();let writes=0;
 const fetcher=async(url,options)=>{calls.push({url,options});
  assert.equal(options.headers.authorization,'Bearer hub2_fixture');assert.equal(options.redirect,'error');
  if(url.endsWith('/capabilities'))return Response.json({...catalog,identity:{actorId:actor}});
  if(url.includes('/operations/'))return Response.json({result:receipts.get(decodeURIComponent(url.split('/operations/')[1]))||{state:'not_registered'}});
  const body=JSON.parse(options.body);
  if(body.operation==='knowledge_list')return Response.json({result:{items:[
   {id:'current',category:'项目实践',tags:'项目:员工客户端,场景:聊天,有效性:当前'},
   {id:'superseded',category:'项目实践',tags:'项目:员工客户端,有效性:被替代'},
   {id:'other',category:'项目实践',tags:'项目:欧印'},
   {id:'reference',category:'外部参考',tags:'项目:员工客户端'},
  ]}});
  if(body.operation==='knowledge_read')return Response.json({result:{document:{body:'method'}}});
  const key=options.headers['idempotency-key'];
  if(!receipts.has(key)){writes++;receipts.set(key,{state:'completed',result:{state:'published',item:{id:'stable'}}});}
  if(drop)throw Error('lost response with private details');
  return Response.json({result:receipts.get(key).result});
 };
 return {fetcher,calls,get writes(){return writes;}};
}
test('single tool exposes only current agent-safe operations',async()=>{
 const b=backend();const r=await invokeToolsLibrary({action:'help'},'hub2_fixture',b);
 assert.equal(toolsLibraryTool.name,'tools.library');assert.deepEqual(r.operations.map(o=>o.name),['knowledge_save','knowledge_read','knowledge_list']);
});
test('caller identity mismatch blocks before operations',async()=>{
 const b=backend();await assert.rejects(invokeToolsLibrary({action:'call',operation:'knowledge_read'},'hub2_fixture',{...b,expectedActorId:'bob'}),/identity_mismatch/);assert.equal(b.calls.length,1);
});
test('write retains metadata and key; replay and original status remain same effect',async()=>{
 const b=backend(),args={action:'call',operation:'knowledge_save',arguments:{id:'stable',revision:2,body:'method'},idempotency_key:'knowledge-revision-01'};
 const r=await invokeToolsLibrary(args,'hub2_fixture',b);await invokeToolsLibrary(args,'hub2_fixture',b);
 assert.equal(b.writes,1);assert.equal(r.item.id,'stable');
 assert.deepEqual(JSON.parse(b.calls.find(x=>x.url.endsWith('/call')).options.body).arguments,args.arguments);
 const status=await invokeToolsLibrary({action:'operation',idempotency_key:args.idempotency_key},'hub2_fixture',b);assert.equal(status.state,'completed');
});
test('lost response exposes recoverable error without leaking upstream details',async()=>{
 const b=backend({drop:true});await assert.rejects(invokeToolsLibrary({action:'call',operation:'knowledge_save',arguments:{body:'method'},idempotency_key:'loss-original-01'},'hub2_fixture',b),/tools_result_unknown_query_original_key/);
 const status=await invokeToolsLibrary({action:'operation',idempotency_key:'loss-original-01'},'hub2_fixture',b);assert.equal(status.state,'completed');assert.equal(b.writes,1);
});
test('missing key, unknown field and sensitive operation never reach call',async()=>{
 for(const input of [
  {action:'call',operation:'knowledge_save',arguments:{body:'method'}},
  {action:'call',operation:'knowledge_save',arguments:{body:'method',actor:'bob'},idempotency_key:'not-allowed-01'},
  {action:'call',operation:'account_password_read',arguments:{body:'method'}},
 ]){const b=backend();await assert.rejects(invokeToolsLibrary(input,'hub2_fixture',b));assert.equal(b.calls.length,1);}
});
test('project and category filter excludes replaced knowledge and other product',async()=>{
 const b=backend();const r=await invokeToolsLibrary({action:'knowledge_search',business_project:'员工客户端',category:'项目实践',tags:['场景:聊天'],limit:1},'hub2_fixture',b);
 assert.deepEqual(r.items.map(x=>x.id),['current']);assert.equal(r.coverage.complete,true);assert.match(r.coverage.upstream,/no_pagination/);
});
test('finite view reports truncation honestly',async()=>{
 const b=backend();const r=await invokeToolsLibrary({action:'knowledge_search',limit:1},'hub2_fixture',b);assert.equal(r.items.length,1);assert.equal(r.truncated,true);assert.equal(r.coverage.complete,false);
});
test('forbidden is not retried and malformed responses stay failures',async()=>{
 let calls=0;await assert.rejects(invokeToolsLibrary({action:'help'},'hub2_fixture',{fetcher:async()=>{calls++;return Response.json({ok:false,error:{message:'private'}},{status:403});}}),/tools_forbidden/);assert.equal(calls,1);
 await assert.rejects(invokeToolsLibrary({action:'help'},'hub2_fixture',{fetcher:async()=>new Response('html')}),/tools_response_invalid/);
});
test('unconfirmed write response never appears as a safe fresh submission',async()=>{
 let calls=0;
 await assert.rejects(invokeToolsLibrary({action:'call',operation:'knowledge_save',arguments:{body:'method'},idempotency_key:'invalid-response-01'},'hub2_fixture',{fetcher:async(url)=>{calls++;return url.endsWith('/capabilities')?Response.json(catalog):new Response('gateway invalid body',{status:502});}}),/tools_result_unknown_query_original_key/);
 assert.equal(calls,2);
});
