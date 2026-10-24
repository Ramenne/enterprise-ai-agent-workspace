import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {importSharedCommunication,importOwnerProjection} from '../server/business/legacy-import.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const a={actor_id:'a',project_id:PROJECT,display_name:'A',can_read:true,can_write:true};
const b={...a,actor_id:'b'};
test('shared import preserves IDs and provenance, never fabricates missing attachments or new alerts',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db);
 const packet={project_id:PROJECT,member_mapping:[{legacy_username:'old-a',actor_id:'a'}],messages:[{id:'old-message',seq:8,author_username:'old-a',author_name:'A',body:'history',mention_usernames:'[]',attachments_json:JSON.stringify([{id:'old-attachment',name:'voice',size:5}]),created_at:1}],reference_gaps:[{legacy_id:'old-attachment'}]};
 const fixed={project_id:PROJECT,material_id:'source',version_id:'fixed',sha256:'fixed-hash'};
 assert.equal(importSharedCommunication(db,a,packet,fixed).shared_messages,1);
 assert.equal(importSharedCommunication(db,b,packet,fixed).replayed,true);
 const message=repo.messages(a).messages[0];assert.equal(message.id,'old-message');assert.equal(message.author_username,'a');assert.equal(message.attachments[0].source_unavailable,true);
 assert.equal(repo.notifications(b).notifications.length,0);
 assert.equal(db.prepare('SELECT actor_id FROM receipts').get().actor_id,'a');
});
test('owner projections remain owner-only and retired notifications become inert history',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db);const mapping=new Map([['old-a','a'],['old-b','b']]);
 const packet={owner_actor_id:'a',announcements:[{id:'old-ann',publisher_username:'old-b',title:'private',body:'for A',created_at:1}],notifications:[{id:'old-note',recipient_username:'old-a',kind:'review_pending',object_id:'old-task',title:'old task',summary:'old content',created_at:1}]};
 assert.throws(()=>importOwnerProjection(db,b,packet,mapping,Buffer.from('source')),e=>e.code==='legacy_projection_owner_mismatch');
 const result=importOwnerProjection(db,a,packet,mapping,Buffer.from('source'));assert.equal(result.owner_notifications,1);
 assert.equal(repo.notifications(a).notifications[0].kind,'legacy_notice');assert.equal(repo.notifications(a).notifications[0].deep_link,'');
 assert.equal(repo.notifications(b).notifications.length,0);assert.equal(repo.announcements(b).announcements.length,0);assert.equal(repo.messages(b).messages.length,0);
});
