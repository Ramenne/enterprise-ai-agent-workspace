import test from 'node:test';
import assert from 'node:assert/strict';
import {isRelevantNotice} from '../src/domain/notificationAudience.mjs';
import {isSilentWebPush} from '../src/platform/webPushState.ts';
test('human actions notify other recipients, while own actions need an explicit reminder',()=>{
 const notice={kind:'work_update',actor_username:'a',snapshot:{}};
 assert.equal(isRelevantNotice(notice,'a'),false);
 assert.equal(isRelevantNotice(notice,'b'),true);
 assert.equal(isRelevantNotice({...notice,snapshot:{reminder:true}},'a'),true);
 assert.equal(isRelevantNotice({...notice,kind:'device_alert'},'a'),true);
});
test('anonymous project revisions remain synchronization data, never inbox badges or alerts',()=>{
 const notice={kind:'hub_update',actor_username:'service',snapshot:{source:'authorized_project_commit_snapshot',silent:false}};
 assert.equal(isRelevantNotice(notice,'a'),false);
 assert.equal(isSilentWebPush({...notice,priority:'normal'}),true);
 assert.equal(isRelevantNotice({...notice,snapshot:{...notice.snapshot,reminder:true}},'a'),true,'an explicit snooze reminder remains deliverable');
 assert.equal(isRelevantNotice({kind:'announcement',actor_username:'b',snapshot:{}},'a'),true);
});
