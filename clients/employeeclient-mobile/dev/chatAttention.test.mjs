import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatAttention } from '../src/domain/chatAttention.ts';
import { routeFromTarget, notificationRoutePath, deepTargetQuery } from '../src/platform/deeplink.ts';
import { isSilentWebPush } from '../src/platform/webPushState.ts';
test('chat badge uses unread visible chat and server attention only',()=>{
 const n={id:'base',kind:'chat_message',snapshot:{attention:'normal'}};
 assert.deepEqual(chatAttention([n,{...n,id:'mention',snapshot:{attention:'mention'}},{...n,id:'reply',snapshot:{attention:'reply'},read_at:1},{...n,id:'hidden',hidden_at:2},{kind:'announcement',snapshot:{attention:'mention'}}]),{count:2,relevant:1});
});
test('notification entrypoints preserve messages and reject retired approval targets',()=>{
 assert.deepEqual(deepTargetQuery(routeFromTarget({object_type:'chat_message',object_id:'m1'})),{message:'m1'});
 assert.equal(notificationRoutePath('/api/v2/company/chat/messages/m1'),'/chat?message=m1');
 assert.equal(notificationRoutePath('/business/v1/messages/m1'),'/chat?message=m1');
 assert.equal(notificationRoutePath('/api/v2/control/tasks/t1'),'/work');
 assert.equal(notificationRoutePath('/api/v2/me/tasks/t1','review_pending'),'/work');
});
test('web push explicit silent differs from normal-priority relevant messages',()=>{
 assert.equal(isSilentWebPush({silent:true,priority:'normal'}),true);
 assert.equal(isSilentWebPush({snapshot:{silent:true}}),true);
 assert.equal(isSilentWebPush({snapshot:{attention:'mention',silent:false},priority:'normal'}),false);
 assert.equal(isSilentWebPush({silent:true,priority:'urgent'}),false);
});
