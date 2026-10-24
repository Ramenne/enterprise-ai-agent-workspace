import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalScenario} from './reconstruction-local.mjs';
import {authorizedProjects,numberLabel} from '../src/native/discovery.mjs';
import {userError} from '../src/domain/userError.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const ctx=(actor,write=true)=>({actor_id:actor,display_name:actor,project_id:PROJECT,can_read:actor!=='sim-u',can_write:write});
test('current authorized directory retains public personal and explicitly granted private entries; denial stays hidden',()=>{
 const rows=[{project_id:'team',visibility:'team'},{project_id:'own',visibility:'private',owner_id:'a'},{project_id:'public',visibility:'personal',owner_id:'b'},{project_id:'granted',visibility:'private',owner_id:'b',can_read:true},{project_id:'denied',visibility:'team',can_read:false}];
 assert.deepEqual(authorizedProjects(rows,'a').map(p=>p.project_id),['team','own','public','granted']);assert.equal(numberLabel(undefined),'');assert.equal(numberLabel(1000172),'#1000172');
});
test('direct announcement reads are recipient-scoped and do not mark read; own reading works for a read-only member',()=>{
 const s=createLocalScenario();try{
  const id=s.receipt.announcement_id,ann=s.repository.announcement(ctx('sim-a',false),id);assert.match(ann.body,/模拟公告正文/);assert.equal(ann.read_at,null);
  assert.throws(()=>s.repository.announcement(ctx('sim-b'),id),e=>e.status===404);
  assert.equal(s.repository.announcements(ctx('sim-m')).announcements[0].id,id);
  s.repository.notificationAction(ctx('sim-a',false),ann.notification_id,'read',{},'read-only-member');
  assert.ok(s.repository.announcement(ctx('sim-a'),id).read_at);
  assert.equal(s.repository.notifications(ctx('sim-b')).notifications.some(n=>n.object_id===id),false);
 }finally{s.close();}
});
test('date window searches server history and attachment filenames without consuming the unfiltered cursor',()=>{
 const s=createLocalScenario();try{
  const before=s.repository.messages(ctx('sim-a')),time=before.messages[0].created_at;
  assert.equal(s.repository.messages(ctx('sim-a'),{created_from:time,created_until:time+10000}).messages.length,before.messages.length);
  assert.equal(s.repository.messages(ctx('sim-a'),{created_from:time+10000,created_until:time+20000}).messages.length,0);
  assert.equal(s.repository.files(ctx('sim-a'),{q:'员工客户端本地验证.txt'}).files.length,1);
  assert.equal(s.repository.messages(ctx('sim-a')).sync_cursor,before.sync_cursor);
  assert.throws(()=>s.repository.messages(ctx('sim-u'),{}),e=>e.status===403);
  assert.throws(()=>s.repository.messages(ctx('sim-a'),{created_from:'bad'}),e=>e.code==='invalid_date_filter');
 }finally{s.close();}
});
test('transport errors preserve content language instead of claiming the login expired',()=>{
 assert.match(userError({status:503,code:'authority_request_rejected'}),/连接暂时/);
 assert.match(userError({status:401}),/身份.*重试连接/);assert.doesNotMatch(userError({status:401}),/已过期|退出登录/);assert.match(userError({status:403}),/权限/);
 assert.doesNotMatch(userError(Error('authority_request_rejected')),/authority_request_rejected/);
});
import {readNotificationBatch} from '../src/domain/readNotifications.mjs';
test('bulk read stops on the first failure, cleans gone rows and never reports unattempted rows read',async()=>{
 const calls=[];const result=await readNotificationBatch([1,2,3,4,5],async n=>{calls.push(n);return n===1?true:n===2?'gone':false;},()=>true);
 assert.deepEqual(calls,[1,2,3]);assert.equal(result.read,1);assert.equal(result.gone,1);assert.equal(result.failed,1);assert.equal(result.remaining,3);
});
test('account switch cancels batch without using old-account completion as new-account success',async()=>{
 let valid=true;const result=await readNotificationBatch([1,2],async()=>{valid=false;return true;},()=>valid);assert.equal(result.cancelled,true);assert.equal(result.read,0);
});
