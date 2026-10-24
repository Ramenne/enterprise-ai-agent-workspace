import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {randomUUID,createHash} from 'node:crypto';import {EventEmitter} from 'node:events';
import {createChatRepository} from '../server/business/chat-repository.mjs';import {createPrivateAttachments} from '../server/business/private-attachments.mjs';import {PROJECT} from '../server/business/native-authority.mjs';import {encryptedSource} from '../shared/private-media.mjs';
const a={actor_id:'a',display_name:'A',project_id:PROJECT,can_read:true,can_write:true},b={...a,actor_id:'b',display_name:'B'},members=[a,b];
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,r:createChatRepository(db,{now:()=>1000})};}
test('assistant persists only self messages, without leaking private chats, changes, files or notifications',t=>{
 const {db,r}=setup(t);const other=r.send(a,{body:'private with B',recipient_username:'b'},'other',{members}).message;
 const m=r.send(a,{body:'file assistant',recipient_username:'a'},'self',{members}).message;
 assert.equal(m.conversation_peer,'a');assert.equal(r.send(a,{body:'file assistant',recipient_username:'a'},'self',{members}).message.id,m.id);
 assert.deepEqual(r.messages(a,{peer:'a'}).messages.map(m=>m.id),[m.id]);assert.deepEqual(r.changes(a,0,100,'a').changes.map(c=>c.message.id),[m.id]);
 assert.equal(r.messages(b,{peer:'a'}).messages.length,1);assert.equal(r.messages(b,{peer:'b'}).messages.length,0);assert.throws(()=>r.get(b,m.id),e=>e.status===404);
 assert.equal(r.messages(a).messages.length,0);assert.equal(r.files(a).files.length,0);assert.equal(r.notifications(a).notifications.length,0);assert.equal(r.notifications(b).notifications.length,1);
 assert.throws(()=>r.send(a,{body:'cross quote',recipient_username:'a',reply_to_id:other.id},'quote-other',{members}),e=>e.code==='reply_unavailable');
 const reply=r.send(a,{body:'self quote',recipient_username:'a',reply_to_id:m.id},'quote-self',{members}).message;assert.equal(reply.reply_to.id,m.id);
 r.conversationAction(a,{peer:'a',action:'pin',pinned:true},'pin-self',members);r.conversationAction(a,{peer:'a',action:'clear_preview'},'clear-self',members);
 const reopened=createChatRepository(db);assert.equal(reopened.conversations(a,members).conversations.find(c=>c.peer==='a').message,null);assert.equal(reopened.messages(a,{peer:'a'}).messages.length,2);assert.equal(reopened.conversations(b,members).conversations.find(c=>c.peer==='b').message,null);
});
test('assistant video is encrypted, downloadable after reopening, and forwards only as a separate public file',async t=>{
 const {db,r}=setup(t),p=createPrivateAttachments(db),plain=Buffer.from('video-original-fixture'),sha=b=>createHash('sha256').update(b).digest('hex');
 const f=new File([plain],'测试视频.mp4',{type:'video/mp4'}),grant=p.prepare(a,{peer:'a',name:f.name,mime:f.type,size:f.size,sha256:sha(plain),purpose:'file'},'video',members);
 const source=await encryptedSource(f,grant,()=>{}),cipher=Buffer.from(await(await source.readPart(0,source.size)).arrayBuffer()),fixed={material_id:randomUUID(),version_id:randomUUID(),size:cipher.length,sha256:sha(cipher)};
 const session={rpc:async()=>({fixed_ref:fixed}),fileStream:async()=>new Response(cipher)};const {attachment}=await p.bind(a,grant.id,{fixed_ref:fixed},session);
 const m=r.send(a,{body:'',recipient_username:'a'},'self-video',{members,attachments:[attachment]}).message;assert.equal(m.attachments[0].mime,'video/mp4');
 assert.throws(()=>p.head(b,grant.id),e=>e.status===404);assert.throws(()=>r.send(a,{body:''},'unsafe-forward',{members,attachments:[attachment]}),e=>e.code==='attachment_audience_mismatch');
 const res=new EventEmitter(),parts=[];res.writeHead=()=>{};res.write=v=>{parts.push(v);return true;};res.end=()=>{};
 await createPrivateAttachments(db).stream(a,grant.id,session,res,new AbortController().signal);assert.deepEqual(Buffer.concat(parts),plain);
 const publicAttachment={...attachment,id:'public:video',fixed_ref:{project_id:PROJECT,material_id:randomUUID(),version_id:randomUUID()}};
 const forwarded=r.send(a,{body:''},'safe-forward',{members,attachments:[publicAttachment]}).message;assert.equal(r.get(b,forwarded.id).attachments[0].mime,'video/mp4');assert.equal(r.files(a).files.length,1);
});
test('member filter combines author and text and paginates without mixing private or other authors',t=>{
 const {r}=setup(t);for(let n=0;n<5;n++){r.send(a,{body:'match '+n},'a'+n,{members});r.send(b,{body:'match '+n},'b'+n,{members});}
 r.send(a,{body:'match private',recipient_username:'b'},'private-filter',{members});
 const first=r.messages(a,{author:'b',q:'match',limit:2});assert.equal(first.messages.length,2);assert.ok(first.messages.every(m=>m.author_username==='b'&&!m.conversation_peer));
 const second=r.messages(a,{author:'b',q:'match',before:first.oldest_cursor,limit:2});assert.equal(second.messages.length,2);assert.ok(second.messages.every(m=>m.author_username==='b'&&m.seq<first.oldest_cursor));
 assert.equal(r.messages(a,{author:'none'}).messages.length,0);
});
