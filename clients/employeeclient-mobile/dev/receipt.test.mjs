import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/collaboration/receipt.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const module=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const {findNativeMessageReceipt}=module;
let calls=0;
const found=await findNativeMessageReceipt('exact-id',async cursor=>{
  calls++;
  if(!cursor)return{turns:[{messages:[{role:'user',client_id:'other-id'}]}],cursor:'older'};
  return{turns:[{messages:[{role:'user',client_id:'exact-id'}]}],cursor:null};
});
assert.equal(found,true);
assert.equal(calls,2);
assert.equal(await findNativeMessageReceipt('exact-id',async()=>({turns:[{messages:[{role:'assistant',client_id:'exact-id'}]}],cursor:null})),false);
let cycle=0;
assert.equal(await findNativeMessageReceipt('exact-id',async()=>{cycle++;return{turns:[],cursor:'same'};}),false);
assert.equal(cycle,2);
console.log('PASS: old uncertain write settles only on exact native user ID in paged history; no text or assistant false receipt, cursor cycles terminate.');
