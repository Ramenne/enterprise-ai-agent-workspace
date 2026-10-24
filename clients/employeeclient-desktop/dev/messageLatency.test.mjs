import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createBusinessHandler} from '../server/business/http.mjs';
test('local message commit uses one current authorization; remote references revalidate after resolving',async t=>{
 let auths=0,deny=false,sends=0,clock=0;const ctx={actor_id:'a',can_write:true,member_roster:[{actor_id:'a',can_read:true}]};
 const handler=createBusinessHandler({authorize:async()=>{auths++;if(deny)throw Object.assign(Error(),{status:403});return ctx;},directory:async()=>{throw Error('duplicate directory');},resolveReference:async(_c,b)=>{if(b.work_item_id){deny=true;clock=6000;}return null;},resolveAttachments:async()=>[],now:()=>clock,repository:{send:()=>{sends++;return {message:{attachments:[]}};}}});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const send=body=>fetch('http://127.0.0.1:'+server.address().port+'/business/v1/messages',{method:'POST',headers:{cookie:'member','content-type':'application/json'},body:JSON.stringify({attachment_ids:[],...body})});
 assert.equal((await send({body:'text'})).status,201);assert.equal(auths,1);assert.equal(sends,1);
 assert.equal((await send({body:'',work_item_id:'remote'})).status,403);assert.equal(auths,3);assert.equal(sends,1);
 assert.equal((await send({body:'text'})).status,403);assert.equal(sends,1);
});
