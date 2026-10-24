// Synthetic HTTP routing checks; real authorization is tested by rollback SQL separately.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as identityServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createServer} from '../dist/apps/v8/src/server.js';
const pid='c0de5759-c805-4177-a492-c53e16c0625d',hid='100f788f-25a3-45f0-abc1-a4a3c4fb8d7f';
const calls=[],decisions=[];
const identity=identityServer(async(req,res)=>{let bytes=[];for await(const x of req)bytes.push(x);decisions.push(JSON.parse(Buffer.concat(bytes)));res.writeHead(403,{'content-type':'application/json'});res.end('{"error_code":"forbidden"}');});
await new Promise(r=>identity.listen(0,'127.0.0.1',r));
const pool={async query(sql,args){if(sql.includes('evidence.record_usage'))return{rows:[{result:{state:'recorded'}}]};calls.push({sql,args});return{rows:[{result:{state:'saved',handoff_id:hid,revision:2,handling_state:'waiting_external',effect:'coordination_status_only;no_authorization_or_deployment'}}]};}};
const app=createServer({pool,databaseUrl:'',hufuUrl:'http://127.0.0.1:'+identity.address().port,serviceKey:'synthetic-transport',audience:'v8'});
await app.ready();after(async()=>{await app.close();await new Promise(r=>identity.close(r));});
const headers={authorization:'Bearer synthetic-reply-token'};
const body={project_id:pid,handoff_id:hid,expected_revision:1,handling_state:'waiting_external',summary:'synthetic reply',idempotency_key:'synthetic-route-reply'};
test('existing reply URL uses directed member authority, preserving digest and CAS',async()=>{
calls.length=0;decisions.length=0;const r=await app.inject({method:'POST',url:'/v2/handoffs/progress',headers,payload:body});
assert.equal(r.statusCode,200);assert.equal(r.json().revision,2);assert.equal(decisions.length,0);
const c=calls.find(x=>x.sql.includes('v8.handoff_progress_member'));assert.ok(c);
assert.equal(c.args[0],createHash('sha256').update('synthetic-reply-token').digest('hex'));
assert.equal(c.args[1],createHash('sha256').update(c.args[2]).digest('hex'));
assert.equal(JSON.parse(c.args[2]).expected_revision,1);assert.equal(c.args[3],null);
});
test('cannot inject a different actor, owner or project-write action into reply',async()=>{
for(const extra of [{actor_id:hid},{to_actor_id:hid},{action:'mem.write'}]){
calls.length=0;const r=await app.inject({method:'POST',url:'/v2/handoffs/progress',headers,payload:{...body,...extra}});
assert.equal(r.statusCode,400);assert.equal(calls.filter(x=>x.sql.includes('handoff_progress_member')).length,0);}
});
test('reply still requires a member bearer',async()=>{
calls.length=0;const r=await app.inject({method:'POST',url:'/v2/handoffs/progress',payload:body});assert.equal(r.statusCode,401);
assert.equal(calls.filter(x=>x.sql.includes('handoff_progress_member')).length,0);
});
test('work mutation retains original project authority path',async()=>{
decisions.length=0;const r=await app.inject({method:'POST',url:'/v2/work-items/save',headers,payload:{project_id:pid,work_item_id:'7c113238-736b-47b6-acf7-26dff77b70e3',expected_revision:1,summary:'synthetic unrelated write',outputs:[],idempotency_key:'synthetic-unrelated-write'}});
assert.equal(r.statusCode,403);assert.equal(decisions.at(-1).action,'v8.work.commit');
});
