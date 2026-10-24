import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createGateway} from '../server/gateway.mjs';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {createNotificationEvents} from '../server/business/notification-events.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {createChatRepository} from '../server/business/chat-repository.mjs';
const a={project_id:PROJECT,actor_id:'a',display_name:'A',can_read:true,can_write:true};
const b={...a,actor_id:'b',display_name:'B'};
async function server(t,handler){const s=createGateway({publicOrigin:'https://test.invalid',businessHandler:handler});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return 'http://127.0.0.1:'+s.address().port;}
test('runtime uses native directory/current work and fixed Mem refs; recipient can read',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const calls=[];
 const sessionFactory=async cookie=>({context:cookie==='b'?b:a,directory:async()=>[a,b],rpc:async(name,args)=>{calls.push(name);if(name==='v8.project.read')return {project:{id:PROJECT,title:'project',visibility:'team'}};if(name==='v8.work.read')return {work_item:{id:args.work_item_id,project_id:PROJECT,goal:'current work',short_no:100}};if(name==='mem.version.read')return {fixed_ref:{project_id:PROJECT,material_id:args.material_id,version_id:args.version_id,size:5,sha256:'fixed'}};if(name==='mem.material.head')return {properties:{employeeclient:{name:'voice.webm',mime:'audio/webm',purpose:'voice'}},placements:[]};throw Error('unexpected');}});
 const base=await server(t,createRuntimeHandler(db,{sessionFactory}));
 const post=await fetch(base+'/business/v1/messages',{method:'POST',headers:{cookie:'a',origin:'https://test.invalid','content-type':'application/json','idempotency-key':'message-1'},body:JSON.stringify({body:'hello',project_id:PROJECT,work_item_id:'work',attachment_ids:['cfe3f0af-af84-4c63-a0d6-2d0677caaddd:8662ae87-2e86-405e-aa76-c2b6e807b0b1']})});
 assert.equal(post.status,201);const sent=await post.json();assert.equal(sent.message.context.work_title,'current work');assert.equal(sent.message.attachments[0].purpose,'voice');
 const received=await (await fetch(base+'/business/v1/notifications',{headers:{cookie:'b'}})).json();assert.equal(received.notifications.length,1);assert.equal(received.notifications[0].recipient_actor,'b');
 const forged=await fetch(base+'/business/v1/messages',{method:'POST',headers:{cookie:'a',origin:'https://test.invalid','content-type':'application/json','idempotency-key':'forged'},body:JSON.stringify({actor_id:'b',body:'x',attachment_ids:[]})});assert.equal(forged.status,400);
 assert.ok(calls.includes('mem.version.read'));assert.ok(calls.includes('v8.work.read'));
});
test('initial message watermark uses change ledger rather than message count',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const r=createChatRepository(db);const sent=r.send(a,{body:'first',attachment_ids:[]},'m',{members:[a,b]});r.change(a,sent.message_id,'hide','hide');
 assert.equal(r.messages(a).sync_cursor,2);assert.equal(r.messages(b).sync_cursor,1);
});
test('SSE current identity is confirmed; actual project revocation closes without exposing bodies',async t=>{
 let denied=false;const events=createNotificationEvents(async()=>{if(denied)throw Object.assign(Error('project_read_denied'),{code:'project_read_denied',status:403});return a;},{notifications(){return {notifications:[],sync_version:0,has_more:false};}},{heartbeatMs:10000});
 const base=await server(t,async(req,res)=>events.handle(req,res));
 const ctl=new AbortController();t.after(()=>ctl.abort());const response=await fetch(base+'/business/v1/events',{signal:ctl.signal});assert.equal(response.status,200);
 const reader=response.body.getReader(),decoder=new TextDecoder();const ready=decoder.decode((await reader.read()).value);assert.match(ready,/"actor_id":"a"/);
 denied=true;events.changed();let closed='';for(let i=0;i<3&&!closed.includes('event: auth');i++){const part=await reader.read();if(part.done)break;closed+=decoder.decode(part.value);}assert.match(closed,/event: auth/);assert.match(closed,/"status":403/);assert.equal((await reader.read()).done,true);
});
test('native file relays authenticated verified stream, not a public object ticket',async t=>{
 const calls=[];const gateway=createGateway({publicOrigin:'https://test.invalid',fetcher:async(url,opts)=>{calls.push({url,opts});if(url.endsWith('/get-session'))return new Response(JSON.stringify({session:{token:'fixture-only',expiresAt:new Date(Date.now()+60000).toISOString()}}),{headers:{'content-type':'application/json'}});return new Response('verified bytes',{headers:{'content-type':'application/octet-stream','x-hub-read-receipt':'receipt'}});}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{gateway.closeAllConnections();gateway.close();});const q=new URLSearchParams({project_id:PROJECT,material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',name:'原文.txt'});
 const response=await fetch('http://127.0.0.1:'+gateway.address().port+'/native/file?'+q,{headers:{cookie:'fixture-cookie'}});assert.equal(await response.text(),'verified bytes');assert.ok(calls[1].url.endsWith('/mem/v2/files/read'));assert.equal(calls[1].opts.headers.cookie,undefined);assert.equal(calls[1].opts.redirect,'error');assert.equal(response.headers.get('x-hub-read-receipt'),'receipt');
});

test('quick reference resolution reuses request authority and reads metadata in parallel',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let sessions=0,directories=0;const calls=[];let releaseProject,workStarted;
 const projectGate=new Promise(r=>releaseProject=r),workGate=new Promise(r=>workStarted=r);
 const handler=createRuntimeHandler(db,{sessionFactory:async()=>{sessions++;return {context:{...a,member_roster:[a,b]},directory:async()=>{directories++;return [a,b];},rpc:async(name,args)=>{calls.push(name);if(name==='v8.project.read'){await projectGate;return {project:{id:PROJECT,title:'员工客户端',visibility:'team'}};}if(name==='v8.work.read'){workStarted();return {work_item:{id:args.work_item_id,project_id:PROJECT,goal:'work',short_no:1000172}};}throw Error('unexpected RPC');}};}});t.after(()=>handler.close());const base=await server(t,handler);
 const send=(body,key)=>fetch(base+'/business/v1/messages',{method:'POST',headers:{cookie:'a',origin:'https://test.invalid','content-type':'application/json','idempotency-key':key},body:JSON.stringify({body:'message',attachment_ids:[],...body})});
 const ordinary=await send({},'ordinary');assert.equal(ordinary.status,201);assert.equal(sessions,1);assert.equal(directories,0);assert.deepEqual(calls,[]);
 const pending=send({project_id:PROJECT,work_item_id:'work'},'reference');await workGate;releaseProject();const r=await pending;assert.equal(r.status,201);assert.equal((await r.json()).message.context.short_no,1000172);assert.equal(sessions,1,'sequential message/reference writes reuse the verified device lease');assert.equal(directories,0);assert.deepEqual(calls,['v8.project.read','v8.work.read']);
});
