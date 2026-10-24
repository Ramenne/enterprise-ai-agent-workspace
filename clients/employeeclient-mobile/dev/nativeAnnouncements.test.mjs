import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const ctx=id=>({project_id:PROJECT,actor_id:id,display_name:id,can_read:true,can_write:true,can_publish_announcement:id==='manager'});
test('targeted announcement, reply and receipt remain in exact audience; no fake group message',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db,{now:()=>1000});
 const members=['manager','a','b'].map(actor_id=>({actor_id,can_read:true}));
 const result=repo.publishAnnouncement(ctx('manager'),{title:'公告',body:'只给 A',recipient_usernames:['a'],priority:'normal'},'announce',members);
 assert.equal(repo.announcements(ctx('a')).announcements[0].id,result.announcement_id);
 assert.equal(repo.announcements(ctx('b')).announcements.length,0);// The publisher can review their own sent announcement and read receipts,
 // without receiving an unread notification or an ordinary group message.
 assert.equal(repo.announcements(ctx('manager')).announcements[0].id,result.announcement_id);
 assert.equal(repo.notifications(ctx('manager')).notifications.length,0);
 assert.equal(repo.messages(ctx('a')).messages.length,0);
 assert.throws(()=>repo.get(ctx('b'),result.announcement_id),e=>e.code==='message_not_found');
 assert.throws(()=>repo.send(ctx('a'),{body:'不能公开引用私人公告',reply_to_id:result.announcement_id},'bad',{members}),e=>e.code==='reply_unavailable');
 assert.throws(()=>repo.publishAnnouncement(ctx('a'),{title:'bad',body:'bad',recipient_usernames:['b']},'bad',members),e=>e.code==='announcement_publish_denied');
 repo.replyAnnouncement(ctx('a'),result.announcement_id,'收到','reply');
 assert.equal(repo.notifications(ctx('manager')).notifications[0].kind,'announcement_reply');
 assert.equal(repo.notifications(ctx('b')).notifications.length,0);
});
test('notification pagination has persistent continuation cursor and final watermark',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db);const members=['a','b'].map(actor_id=>({actor_id}));
 for(let i=0;i<3;i++)repo.send(ctx('a'),{body:'message '+i},'send-'+i,{members});
 const first=repo.notifications(ctx('b'),0,2);assert.equal(first.has_more,true);assert.ok(first.next_cursor);assert.equal(first.sync_version,null);
 const last=repo.notifications(ctx('b'),first.next_cursor,2);assert.equal(last.has_more,false);assert.equal(last.next_cursor,'');assert.equal(last.notifications.length,1);assert.ok(last.sync_version>0);
});
test('new announcement detail and sender receipt statistics reflect real recipient reads; outsiders cannot read names',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db,{now:()=>1000}),members=['manager','a','b','outsider'].map(actor_id=>({actor_id,can_read:true}));
 const result=repo.publishAnnouncement(ctx('manager'),{title:'可读公告',body:'完整正文',recipient_usernames:['manager','a','a','b'],priority:'normal'},'new-announce',members);
 const id=result.announcement_id,before=repo.announcement(ctx('manager'),id);assert.equal(before.recipient_count,2);assert.equal(before.read_count,0);assert.equal(before.unread_count,2);assert.equal(before.audience.length,2);
 const recipient=repo.announcement(ctx('a'),id);assert.equal(recipient.body,'完整正文');assert.equal(recipient.audience,undefined);
 repo.notificationAction(ctx('a'),recipient.notification_id,'read',{},'read-a');const after=repo.announcement(ctx('manager'),id);assert.equal(after.read_count,1);assert.equal(after.unread_count,1);assert.equal(after.audience.find(x=>x.username==='a').read_at,1000);
 assert.throws(()=>repo.announcement(ctx('outsider'),id),e=>e.status===404);assert.throws(()=>repo.announcement(ctx('a'),'missing'),e=>e.status===404);
 assert.equal(repo.announcements(ctx('manager')).announcements[0].read_count,1);
});
