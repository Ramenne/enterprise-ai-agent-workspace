import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
const a={actor_id:'a',display_name:'A',project_id:PROJECT,can_read:true,can_write:true},b={...a,actor_id:'b',display_name:'B'},c={...a,actor_id:'c',display_name:'C'},members=[a,b,c];
const body={body:'private hello',mention_usernames:[],attachment_ids:[],recipient_username:'b'};
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return createChatRepository(db,{now:()=>1000});}
test('direct messages and quotes exclude third members, group history, changes and files',t=>{
 const r=setup(t),m=r.send(a,body,'private',{members}).message;assert.equal(m.conversation_peer,'b');assert.equal(r.messages(b,{peer:'a'}).messages[0].id,m.id);
 assert.equal(r.messages(c,{peer:'a'}).messages.length,0);assert.equal(r.messages(a).messages.length,0);assert.equal(r.files(a).files.length,0);
 assert.equal(r.changes(c).changes.length,0);assert.equal(r.changes(a).changes.length,0);assert.equal(r.changes(b,0,100,'a').changes[0].message.id,m.id);
 assert.throws(()=>r.get(c,m.id),e=>e.status===404);assert.throws(()=>r.change(c,m.id,'hide','hide'),e=>e.status===404);
 assert.throws(()=>r.send(c,{...body,recipient_username:'a',reply_to_id:m.id},'crossreply',{members}),e=>e.code==='reply_unavailable');
 assert.throws(()=>r.send(a,{...body,recipient_username:undefined,reply_to_id:m.id},'groupquote',{members}),e=>e.code==='reply_unavailable');
 assert.equal(r.notifications(c).notifications.length,0);assert.equal(r.notifications(a).notifications.length,0);assert.equal(r.notifications(b).notifications[0].snapshot.conversation_peer,'a');
 const conv=r.conversations(b).conversations.find(row=>row.peer==='a');assert.equal(conv.unread_count,1);assert.equal(r.conversations(c).conversations.length,1);
});
test('direct retries retain recipient, reply, recall and per-person read visibility',t=>{
 const r=setup(t),m=r.send(a,body,'one',{members}).message;assert.equal(r.send(a,body,'one',{members}).message.id,m.id);
 assert.throws(()=>r.send(a,{...body,recipient_username:'c'},'one',{members}),e=>e.code==='idempotency_conflict');
 const reply=r.send(b,{body:'reply',recipient_username:'a',reply_to_id:m.id},'reply',{members}).message;assert.equal(reply.reply_to.id,m.id);
 r.change(a,m.id,'recall','recall');assert.equal(r.get(b,reply.id).reply_to.body,'');assert.equal(r.changes(c,0,100,'a').changes.length,0);
 assert.throws(()=>r.send(a,{...body,recipient_username:'missing'},'bad',{members}),e=>e.code==='recipient_unavailable');
 assert.throws(()=>r.send(a,body,'file',{members,attachments:[{id:'teamfile'}]}),e=>e.code==='attachment_audience_mismatch');
});
test('personal inspiration keeps text, images and audio owner isolated across saved retries',t=>{
 const r=setup(t),payload={text:'private idea',media:[{name:'voice',mime:'audio/webm',bytes_base64:Buffer.from('audio fixture').toString('base64')},{name:'image',mime:'image/png',bytes_base64:Buffer.from('image fixture').toString('base64')}]};
 const saved=r.inspirations.submit(a,payload,'idea');assert.equal(r.inspirations.submit(a,payload,'idea').id,saved.id);const row=r.inspirations.list(a).records[0];assert.equal(row.body,'private idea');assert.equal(row.media.length,2);assert.equal(r.inspirations.list(b).records.length,0);
 assert.throws(()=>r.inspirations.media(b,row.media[0].id),e=>e.status===404);assert.equal(Buffer.from(r.inspirations.media(a,row.media[0].id).bytes).toString(),'audio fixture');
 assert.throws(()=>r.inspirations.list({...a,can_read:false}),e=>e.status===403);assert.throws(()=>r.inspirations.submit(a,{text:'x',media:[{mime:'text/html',bytes_base64:'YWJj'}]},'html'),e=>e.code==='invalid_inspiration_media');
 assert.throws(()=>r.inspirations.submit(a,{text:'x',media:[{mime:'audio/webm',bytes_base64:'bad!'}]},'base64'),e=>e.code==='invalid_inspiration_media');
});

test('native transport permits the actual new conversation and personal-record routes',async()=>{const {businessRequest}=await import('../src/native/business-transport.mjs');const paths=[];for(const path of ['/business/v1/conversations','/business/v1/inspirations']){const r=await businessRequest('http://127.0.0.1', 'GET',path,{lease:{valid:()=>true},fetcher:async url=>{paths.push(new URL(url).pathname);return Response.json({state:'read'});}});assert.equal(r.state,'read');}assert.deepEqual(paths,['/business/v1/conversations','/business/v1/inspirations']);});
