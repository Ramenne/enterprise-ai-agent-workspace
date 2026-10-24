import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {installVerifiedDeliveries} from './deliveries.mjs';

const id='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
const fixture=Buffer.from([80,75,3,4,0,255,128,10]);
function make({denyPrepare=false,denyConsume=false}={}){
 const routes=new Map(),calls=[];
 const app={get:(path,_opts,fn)=>routes.set(path,fn),post:()=>{}};
 const pool={query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('download_prepare')){
   if(denyPrepare)throw Object.assign(Error('fixture_denied'),{code:'42501'});
   return {rows:[{result:{secret_ref:'bao:hub2/hufu/vault2/fixture',secret_version:1,filename:'fixture.zip',item_id:id}}]};
  }
  if(sql.includes('download_consume')){
   if(denyConsume)throw Object.assign(Error('fixture_revoked'),{code:'42501'});
   return {rows:[{result:{receipt_id:id}}]};
  }
  throw Error('unexpected_fixture_query');
 }};
 let reads=0;
 const writer={readKV:async()=>{reads++;return {data:{content_base64:fixture.toString('base64'),filename:'fixture.zip',item_id:id}}}};
 const runtime={required:()=> 'synthetic-test-mac-key',optional:()=>null};
 installVerifiedDeliveries(app,{pool,writer,runtime});
 return {routes,calls,get reads(){return reads}};
}
async function invoke(setup,headers){
 const reply={headers:{},status:200,header(k,v){this.headers[k]=v;return this},code(v){this.status=v;return this},send(v){this.body=v;return v}};
 const result=await setup.routes.get('/v2/vault/deliveries/download/:id')({headers:{authorization:'Bearer synthetic-fixture-member',...headers},params:{id}},reply);
 return {reply,result};
}
test('MCP GET preserves bytes in a JSON envelope after prepare and consume',async()=>{
 const s=make(),{reply,result}=await invoke(s,{'content-type':'application/json'});
 assert.equal(reply.headers['content-type'],'application/json');
 assert.equal(reply.headers['cache-control'],'no-store');
 assert.equal(result.state,'downloaded');assert.equal(result.encoding,'base64');
 assert.deepEqual(Buffer.from(result.bytes_base64,'base64'),fixture);
 assert.equal(result.sha256,createHash('sha256').update(fixture).digest('hex'));
 assert.equal(result.size,fixture.length);assert.equal(result.receipt_id,id);
 assert.equal(s.calls.length,2);assert.match(s.calls[0].sql,/download_prepare/);assert.match(s.calls[1].sql,/download_consume/);
});
test('browser GET still returns the original attachment',async()=>{
 const s=make(),{reply,result}=await invoke(s,{accept:'text/html,*/*'});
 assert.equal(reply.headers['content-type'],'application/octet-stream');
 assert.equal(reply.headers['content-disposition'],'attachment; filename="fixture.zip"');
 assert.deepEqual(result,fixture);assert.equal(s.calls.length,2);
});
test('explicit Accept JSON can use the same authenticated envelope',async()=>{
 const {result}=await invoke(make(),{accept:'application/json'});
 assert.equal(result.encoding,'base64');assert.deepEqual(Buffer.from(result.bytes_base64,'base64'),fixture);
});
test('JSON negotiation cannot bypass prepare authorization',async()=>{
 const s=make({denyPrepare:true}),{reply,result}=await invoke(s,{'content-type':'application/json'});
 assert.equal(reply.status,403);assert.equal(result.error_code,'forbidden');
 assert.equal(s.reads,0);assert.equal(s.calls.length,1);assert.equal(result.bytes_base64,undefined);
});
test('revocation at final consume prevents both representations',async()=>{
 for(const headers of [{accept:'application/json'},{accept:'application/octet-stream'}]){
  const s=make({denyConsume:true}),{reply,result}=await invoke(s,headers);
  assert.equal(reply.status,403);assert.equal(result.error_code,'forbidden');assert.equal(result.bytes_base64,undefined);
  assert.equal(s.calls.length,2);
 }
});
