import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createServer} from 'node:http';
import {createFoundationNotifications} from '../server/business/hub-notifications.mjs';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const tick=()=>new Promise(r=>setTimeout(r,10));
const frame=(type,data)=>new TextEncoder().encode('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n');
function foundation(){let feeder;const stream=new ReadableStream({start(c){feeder=c;},cancel(){}});feeder.enqueue(frame('ready',{project_id:PROJECT}));feeder.enqueue(frame('snapshot',{project_id:PROJECT,complete_projection:true,aggregates:[]}));return {identity:{actor_id:'synthetic-service',directory:async()=>[],stream:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})},feeder};}
test('a temporary identity dependency failure recovers independently and close cancels future attempts',async()=>{
 let calls=0,applied=0;const f=foundation();const states=[];
 const supervisor=createFoundationNotifications(async()=>{if(++calls===1)throw Object.assign(Error(),{status:503,code:'foundation_temporary'});return f.identity;},{apply(){applied++;return {created:0};}},{retryMs:5,status:s=>states.push(s.state)});
 try{for(let i=0;i<20&&supervisor.snapshot().state!=='live';i++)await tick();assert.ok(states.includes('unavailable'));assert.equal(supervisor.snapshot().state,'live');assert.equal(applied,1);assert.deepEqual(await supervisor.directory(),[]);}
 finally{supervisor.close();}const stoppedCalls=calls;await tick();assert.equal(calls,stoppedCalls);assert.equal(supervisor.snapshot().state,'stopped');
});
test('explicit service authorization rejection stops the subscription rather than retrying unauthorized reads',async()=>{
 let calls=0;const supervisor=createFoundationNotifications(async()=>{calls++;throw Object.assign(Error(),{status:403,code:'foundation_rejected'});},{apply(){throw Error('must not persist');}},{retryMs:1});
 try{await tick();await tick();assert.equal(calls,1);assert.equal(supervisor.snapshot().state,'unauthorized');await assert.rejects(supervisor.directory(),e=>e.status===503);}
 finally{supervisor.close();}
});
test('a temporary foundation failure does not terminate current member chat or misreport subscription readiness',async()=>{
 const db=new DatabaseSync(':memory:');const context={project_id:PROJECT,actor_id:'synthetic-member',display_name:'Test',can_read:true,can_write:true};
 const handler=createRuntimeHandler(db,{foundationLoader:async()=>{throw Object.assign(Error(),{status:503,code:'foundation_temporary'});},sessionFactory:async()=>({context,directory:async()=>[context],rpc:async()=>{throw Error('unused');}})});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const boot=await (await fetch(base+'/business/v1/bootstrap',{headers:{cookie:'synthetic-local'}})).json();assert.equal(boot.capabilities.chat,true);assert.equal(boot.foundation_subscription.state,'unavailable');assert.equal((await fetch(base+'/business/v1/messages',{headers:{cookie:'synthetic-local'}})).status,200);}
 finally{handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});
