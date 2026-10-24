import test from 'node:test';import assert from 'node:assert/strict';import {createMemberTasksHandler} from '../server/business/member-tasks.mjs';
const member='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',caller='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const context={actor_id:caller,can_read:true,member_roster:[{actor_id:member,can_read:true}]};
async function read(handler,kind='tasks'){let result;const res={writeHead(){},end(v){result=JSON.parse(v);}};assert.equal(await handler({url:'/business/v1/members/'+member+'/'+kind,method:'GET',headers:{cookie:'synthetic'}},res),true);return result;}
test('member task projection uses target owner, not viewer my_claim, and exposes no financial fields',async()=>{
 const h=createMemberTasksHandler(async()=>({context,rpc:async(name,args)=>{assert.equal(name,'board.tasks.read');assert.equal(args.owner_id,member);return {items:[{id:'t',title:'Task',execution_state:'claimed',owner:{member_id:member},my_claim:null,terms:{cash_cents:999}}],next_cursor:null};}}));
 const r=await read(h);assert.equal(r.actor_id,member);assert.equal(r.items[0].title,'Task');assert.equal(r.items[0].terms,undefined);
});
test('forbidden public balance stays unavailable rather than fabricated as zero',async()=>{
 const h=createMemberTasksHandler(async()=>({context,rpc:async()=>{throw Object.assign(Error('forbidden'),{status:403});}}));assert.equal((await read(h,'points')).balance_points,null);
});
test('nonmember and membership withdrawal cannot return target data',async()=>{
 const h=createMemberTasksHandler(async()=>({context:{...context,member_roster:[]}}));await assert.rejects(read(h),e=>e.status===404);
 let calls=0;const changed=createMemberTasksHandler(async()=>({context:++calls===1?context:{...context,member_roster:[]},rpc:async()=>({items:[],next_cursor:null})}));await assert.rejects(read(changed),e=>e.status===403);
});
test('public balance strips account entries and refuses mismatched target',async()=>{
 const h=createMemberTasksHandler(async()=>({context,rpc:async()=>({member_id:member,unit:'point;1 point=1 CNY',balance_points:123,entries:[{private:true}],cash_due_cny:55})}));assert.deepEqual(await read(h,'points'),{actor_id:member,balance_points:123});
 const mismatch=createMemberTasksHandler(async()=>({context,rpc:async()=>({member_id:caller,unit:'point;1 point=1 CNY',balance_points:123})}));await assert.rejects(read(mismatch,'points'),e=>e.code==='member_points_identity_mismatch');
});

test('balance units and numeric values are verified, not guessed or replaced by zero',async()=>{
 for(const page of [{member_id:member,unit:'cents',balance_points:1500},{member_id:member,unit:'point;1 point=1 CNY',balance_points:'15'},{member_id:member,unit:'point;1 point=1 CNY',balance_points:null}]){
  const h=createMemberTasksHandler(async()=>({context,rpc:async()=>page}));await assert.rejects(read(h,'points'),e=>e.code==='member_points_invalid');
 }
 const decimal=createMemberTasksHandler(async()=>({context,rpc:async()=>({member_id:member,unit:'point;1 point=1 CNY',balance_points:15.25})}));assert.equal((await read(decimal,'points')).balance_points,15.25);
});
