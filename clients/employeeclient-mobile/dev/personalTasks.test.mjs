import test from 'node:test';import assert from 'node:assert/strict';
import {createPersonalTasksHandler} from '../server/business/personal-tasks.mjs';
import {nativeRoute,TOOLS} from '../server/native-routes.mjs';
import {businessRequest} from '../src/native/business-transport.mjs';
function fixture(rpc,contexts=[{actor_id:'a',can_read:true}]){let n=0;return createPersonalTasksHandler(async()=>({context:contexts[Math.min(n++,contexts.length-1)],rpc}));}
async function call(handler,path='/business/v1/me/points',method='GET'){let value;const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){value=JSON.parse(body);}};await handler({url:path,method,headers:{cookie:'synthetic'}},res);return {res,value};}
test('points are actual account balance and cannot target another member',async()=>{
 let calls=0;const h=fixture(async(name,args)=>{calls++;assert.equal(name,'board.member.balance');assert.deepEqual(args,{member_id:'a'});return {member_id:'a',unit:'point;1 point=1 CNY',balance_points:0,reserved_cny:12};});
 assert.deepEqual((await call(h)).value,{actor_id:'a',balance_points:0});
 await assert.rejects(call(h,'/business/v1/me/points?member_id=b'),e=>e.status===400);assert.equal(calls,1);
 await assert.rejects(call(h,undefined,'POST'),e=>e.status===405);
 await assert.rejects(call(fixture(async()=>({member_id:'b',unit:'point;1 point=1 CNY',balance_points:10}))),e=>e.code==='member_points_identity_mismatch');
});
test('task owner is server-derived; pagination and claim terms remain distinct from wallet',async()=>{
 const h=fixture(async(name,args)=>{assert.equal(name,'board.tasks.read');assert.deepEqual(args,{owner_id:'a',limit:50,cursor:'next'});return {items:[{id:'t',title:'Work',description:'Details',owner:{member_id:'a'},my_claim:{member_id:'a',terms:{base_points_cents:1500}},execution_state:'claimed'}],next_cursor:'last'};});
 const {value}=await call(h,'/business/v1/me/tasks?cursor=next');assert.equal(value.next_cursor,'last');assert.equal(value.items[0].terms.base_points_cents,1500);assert.equal(value.items[0].execution_state,'claimed');assert.equal(value.balance_points,undefined);
 await assert.rejects(call(h,'/business/v1/me/tasks?owner_id=b'),e=>e.status===400);
 const other=fixture(async()=>({items:[{owner:{member_id:'b'},my_claim:{member_id:'b'}}]}));await assert.rejects(call(other,'/business/v1/me/tasks'),e=>e.status===403);
});
test('revocation or actor change while reading prevents returning financial data',async()=>{
 for(const context of [{actor_id:'b',can_read:true},{actor_id:'a',can_read:false}]){
  const h=fixture(async()=>({member_id:'a',unit:'point;1 point=1 CNY',balance_points:10}),[{actor_id:'a',can_read:true},context]);await assert.rejects(call(h),e=>e.status===403);
 }
});
test('narrow board read adapters never expose generic financial tools to browser RPC',()=>{
 assert.equal(TOOLS.has('board.account.read'),false);assert.equal(TOOLS.has('board.tasks.read'),false);
 assert.equal(nativeRoute('board.account.read',{}),null);assert.equal(nativeRoute('board.member.balance',{member_id:'a'}).path,'/hub2-preview/v8/v2/points/member-balance');
 assert.equal(nativeRoute('points.award',{}),null);
});
test('client permits only exact own-account GET routes; finance writes remain blocked',async()=>{
 let count=0;const options={lease:{valid:()=>true},fetcher:async()=>{count++;return new Response(JSON.stringify({actor_id:'a'}),{headers:{'content-type':'application/json'}});}};
 for(const path of ['/business/v1/me/points','/business/v1/me/tasks'])await businessRequest('http://localhost','GET',path,options);
 for(const [method,path] of [['POST','/business/v1/me/points'],['GET','/business/v1/me/awards']])await assert.rejects(businessRequest('http://localhost',method,path,options),e=>e.code==='retired_or_unknown_business_route');
 assert.equal(count,2);
});
test('transient read transport failure recovers once, without retrying permission rejection',async()=>{
 let calls=0;const h=fixture(async()=>{if(++calls===1)throw new TypeError('fetch failed');return {member_id:'a',unit:'point;1 point=1 CNY',balance_points:3};});
 assert.equal((await call(h)).value.balance_points,3);assert.equal(calls,2);
 let deniedCalls=0;const denied=fixture(async()=>{deniedCalls++;throw Object.assign(Error('denied'),{status:403,code:'authority_request_rejected'});});
 await assert.rejects(call(denied),e=>e.status===403);assert.equal(deniedCalls,1);
 let failedCalls=0;const broken=fixture(async()=>{failedCalls++;throw new TypeError('fetch failed');});await assert.rejects(call(broken));assert.equal(failedCalls,2);
});
