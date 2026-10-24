import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeClient} from '../src/native/client.mjs';
import {userError} from '../src/domain/userError.mjs';
import {createServer} from 'node:http';
const json=value=>new Response(JSON.stringify(value));
const pendingAbort=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));

test('native control timeout is a network timeout, not a user pause',async()=>{
 const client=new NativeClient({fetcher:pendingAbort});client.partition='original-member';
 await assert.rejects(client.request('rpc',{name:'mem.upload.put_status'},'original-key',undefined,10),error=>{
  assert.equal(error.name,'TimeoutError');assert.equal(userError(error),'连接长时间没有进展，请稍后重试');return true;
 });
 assert.equal(client.partition,'original-member');assert.equal(client.controllers.size,0);
});
test('user pause keeps the caller reason and rejects a non-cooperative late response',async()=>{
 const ctl=new AbortController();let release;
 const client=new NativeClient({fetcher:()=>new Promise(resolve=>release=resolve)});
 const pending=client.request('rpc',{name:'mem.upload.publish'},'same-operation',ctl.signal);
 const reason=new DOMException('主动暂停','AbortError');ctl.abort(reason);release(json({state:'published'}));
 await assert.rejects(pending,error=>error===reason);assert.equal(client.controllers.size,0);
});
test('late permission rejection after pause cannot revoke the current session',async()=>{
 const ctl=new AbortController();let release,revoked=0;
 const client=new NativeClient({fetcher:()=>new Promise(resolve=>release=resolve),onUnauthorized:()=>revoked++});client.partition='original-member';
 const pending=client.request('rpc',{name:'mem.upload.put_status'},'original-key',ctl.signal);
 ctl.abort();release(new Response(JSON.stringify({error:'login_required'}),{status:401}));
 await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(revoked,0);assert.equal(client.partition,'original-member');
});
test('an adapter returning after the timeout cannot turn the timed-out operation into success',async()=>{
 const client=new NativeClient({fetcher:(_url,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(json({state:'published'})),{once:true}))});
 await assert.rejects(client.request('rpc',{name:'mem.upload.publish'},'original-key',undefined,10),error=>error.name==='TimeoutError');
});
test('timeout recovery reuses the exact upload control operation and idempotency key',async()=>{
 const calls=[];let first=true;
 const client=new NativeClient({fetcher:async(url,options)=>{
  calls.push({url,body:options.body,key:options.headers['idempotency-key']});
  if(first){first=false;return pendingAbort(url,options);}return json({state:'published'});
 }});
 const body={name:'mem.upload.publish',arguments:{project_id:'project',operation_id:'original-operation'}};
 await assert.rejects(client.request('rpc',body,'original-key',undefined,10),error=>error.name==='TimeoutError');
 assert.equal((await client.request('rpc',body,'original-key')).state,'published');assert.deepEqual(calls[0],calls[1]);
});
test('real HTTP timeout can query the original upload operation after recovery',async t=>{
 const calls=[];let release;const first=new Promise(resolve=>release=resolve);
 const server=createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;
  calls.push({body:JSON.parse(text),key:req.headers['idempotency-key']});
  if(calls.length===1){release();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({state:'published'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const client=new NativeClient({base:'http://127.0.0.1:'+server.address().port});
 const body={name:'mem.upload.publish',arguments:{project_id:'project',operation_id:'original-operation'}};
 const rejected=assert.rejects(client.request('rpc',body,'original-key',undefined,100),error=>error.name==='TimeoutError');
 await first;await rejected;
 assert.equal((await client.request('rpc',body,'original-key')).state,'published');assert.deepEqual(calls[0],calls[1]);
});
test('late upload receipt body after pause cannot trigger permission recovery',async()=>{
 const ctl=new AbortController();let release,reading,revoked=0;
 const started=new Promise(resolve=>reading=resolve);
 const client=new NativeClient({signal:ctl.signal,onUnauthorized:()=>revoked++,fetcher:async()=>({ok:false,status:401,json:()=>{reading();return new Promise(resolve=>release=resolve);}})});
 const work=client.putContent({project_id:'p',operation_id:'original'},new Blob(['bytes']));await started;
 ctl.abort();release({error_code:'login_required'});await assert.rejects(work,error=>error.name==='AbortError');assert.equal(revoked,0);
});
