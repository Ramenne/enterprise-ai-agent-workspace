import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createChatRepository} from '../server/business/chat-repository.mjs';import {PROJECT} from '../server/business/native-authority.mjs';import {orderGroupFiles} from '../src/chat/groupFiles.mjs';
const actor={project_id:PROJECT,actor_id:'a',display_name:'a',can_read:true,can_write:true};
test('group files page by actual latest date with stable tie order even when historical files are imported last; chat remains oldest-to-newest',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let clock=100;const repo=createChatRepository(db,{now:()=>clock});
 function send(id,time){clock=time;const a={id,name:id+'.txt',mime:'text/plain',purpose:'file',fixed_ref:{project_id:PROJECT,material_id:id,version_id:'v1'}};return repo.send(actor,{body:id,attachment_ids:[id]},id,{members:[actor],attachments:[a]}).message;}
 send('old',200);send('new',1000);send('historical-import',100);send('same-time-1',1000);send('same-time-2',1000);send('middle',500);
 let cursor,files=[],pages=0;do{const page=repo.files(actor,{limit:2,before:cursor});files.push(...page.files);cursor=page.next_cursor;assert.ok(++pages<10);}while(cursor);
 assert.deepEqual(files.map(f=>f.id),['same-time-2','same-time-1','new','middle','old','historical-import']);
 assert.deepEqual(repo.files(actor,{q:'new',limit:2}).files.map(f=>f.id),['new']);
 assert.deepEqual(repo.messages(actor).messages.map(m=>m.body),['old','new','historical-import','same-time-1','same-time-2','middle']);
 assert.throws(()=>repo.files({...actor,can_read:false}),/project_read_denied/);
 const first=repo.messages(actor).messages[0];assert.ok(repo.files(actor,{before:String(first.seq+1)}).files.every(f=>f.message_seq<first.seq+1));
});
test('group-file cache sorts oldest cache snapshots and keeps the newest occurrence of a shared fixed attachment',()=>{
 const current={id:'a',created_at:1000,message_seq:10,name:'new'},old={id:'a',created_at:100,message_seq:1,name:'old'};
 const rows=orderGroupFiles([{id:'b',created_at:200,message_seq:2},current,old,{id:'c',created_at:1000,message_seq:12}]);assert.deepEqual(rows.map(r=>r.id),['c','a','b']);assert.equal(rows[1].name,'new');
});
