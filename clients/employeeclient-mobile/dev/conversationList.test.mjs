import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
const a={actor_id:'a',display_name:'A',can_read:true,can_write:true,project_id:PROJECT},b={...a,actor_id:'b',display_name:'B'},c={...a,actor_id:'c',display_name:'C'},members=[a,b,c];
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=1000;const repo=createChatRepository(db,{now:()=>++time});return {db,repo};}
test('list includes every current peer as an empty conversation and includes an owner-only assistant and excludes unauthorized members',t=>{
 const {repo:r}=fixture(t),rows=r.conversations(a,[...members,{...a,actor_id:'denied',can_read:false}]).conversations;
 assert.deepEqual(rows.map(r=>r.peer),['','a','b','c']);assert.ok(rows.every(row=>row.message===null));assert.equal(rows[0].pinned,true);assert.equal(rows.find(r=>r.peer==='b').peer_name,'B');
});
test('company group defaults pinned, unpin and per-member pins survive reopening with owner isolation',t=>{
 const {db,repo:r}=fixture(t);r.send(a,{body:'group'},'g',{members});r.send(a,{body:'recent private',recipient_username:'b'},'p',{members});
 assert.equal(r.conversations(a,members).conversations[0].peer,'');
 r.conversationAction(a,{peer:'',action:'pin',pinned:false},'unpin',members);assert.equal(r.conversations(a,members).conversations[0].peer,'b');assert.equal(r.conversations(b,members).conversations[0].peer,'');
 const reopened=createChatRepository(db);assert.equal(reopened.conversations(a,members).conversations.find(x=>x.peer==='').pinned,false);
 const body={peer:'c',action:'pin',pinned:true};const receipt=r.conversationAction(a,body,'pin-c',members);assert.deepEqual(r.conversationAction(a,body,'pin-c',members),receipt);assert.equal(r.conversations(a,members).conversations[0].peer,'c');
 assert.throws(()=>r.conversationAction(a,{peer:'missing',action:'pin',pinned:true},'bad',members),e=>e.status===403);
});
test('delete only clears own preview and old badges; original history, attachments, announcements and other accounts remain',t=>{
 const {repo:r}=fixture(t);const m=r.send(b,{body:'old private',recipient_username:'a'},'old',{members}).message;
 r.send(c,{body:'other private',recipient_username:'a'},'other',{members});const pub={...b,can_publish_announcement:true};r.publishAnnouncement(pub,{body:'notice',title:'notice',recipient_usernames:['a']},'notice',members);
 const receipt=r.conversationAction(a,{peer:'b',action:'clear_preview'},'clear',members);const row=r.conversations(a,members).conversations.find(x=>x.peer==='b');assert.equal(row.message,null);assert.equal(row.unread_count,0);assert.equal(row.peer_name,'B');
 assert.equal(r.messages(a,{peer:'b'}).messages[0].id,m.id);assert.equal(r.get(a,m.id).hidden,false);assert.equal(r.conversations(b,members).conversations.find(x=>x.peer==='a').message.id,m.id);assert.equal(r.conversations(a,members).conversations.find(x=>x.peer==='c').unread_count,1);
 assert.equal(r.announcements(a).announcements.length,1);assert.equal(r.notifications(a).notifications.find(n=>n.kind==='announcement').hidden_at,null);
 const fresh=r.send(b,{body:'new private',recipient_username:'a'},'new',{members}).message;assert.deepEqual(r.conversationAction(a,{peer:'b',action:'clear_preview'},'clear',members),receipt);const current=r.conversations(a,members).conversations.find(x=>x.peer==='b');assert.equal(current.message.id,fresh.id);assert.equal(current.unread_count,1);
});
