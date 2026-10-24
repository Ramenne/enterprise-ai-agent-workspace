import test from 'node:test';import assert from 'node:assert/strict';import {nativeEventAuthority,PROJECT} from '../server/business/native-authority.mjs';
test('notification authority remains available without V8 metadata; next check observes actual membership withdrawal',async()=>{
 let withdrawn=false;const called=[];
 const fetcher=async(url,opts)=>{called.push(url);let v;if(url.endsWith('/get-session'))v={session:{token:'synthetic-session-test-only',expiresAt:new Date(Date.now()+60000).toISOString()}};else if(url.endsWith('/v2/me')){assert.ok(opts.headers.authorization);v={actor_id:'synthetic-A',member_label:'A'};}else if(url.endsWith('/v2/projects/members'))v={project_id:PROJECT,members:withdrawn?[]:[{actor_id:'synthetic-A',can_read:true}],next_offset:null};else throw Error('V8 or unrelated dependency is unavailable');return new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});};
 const ctx=await nativeEventAuthority('synthetic-cookie',{fetcher});assert.equal(ctx.actor_id,'synthetic-A');assert.equal(ctx.can_read,true);assert.equal(ctx.can_write,false);assert.equal(called.length,3);assert.ok(called.every(url=>url.includes('/hub2-preview/hufu/')));
 withdrawn=true;await assert.rejects(nativeEventAuthority('synthetic-cookie',{fetcher}),e=>e.status===403&&e.code==='project_read_denied');
});
