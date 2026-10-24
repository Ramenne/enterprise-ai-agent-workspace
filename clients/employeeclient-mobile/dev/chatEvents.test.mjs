import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/platform/chatEvents.ts',import.meta.url),'utf8');
const result=await build({stdin:{contents:source,loader:'ts'},write:false,format:'esm'});
const {notifyChatWake,onChatWake}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('wake is domain-scoped and unsubscribe removes listener',t=>{const calls=[];const stop=onChatWake(e=>calls.push(e));t.after(stop);notifyChatWake('a','live',[]);notifyChatWake('a','live',[{kind:'task_progress'}]);assert.equal(calls.length,0);notifyChatWake('a','live',[{kind:'announcement_reply',object_id:'reply-1',snapshot:{announcement_id:'ann-1'}}]);notifyChatWake('b','catchup',[]);assert.deepEqual(calls,[{account:'a',mode:'live',kinds:['announcement_reply'],announcementIds:['ann-1'],conversationPeers:[],groupFilesChanged:undefined},{account:'b',mode:'catchup',kinds:[],announcementIds:[],conversationPeers:[],groupFilesChanged:undefined}]);stop();notifyChatWake('a','live',[{kind:'chat_message'}]);assert.equal(calls.length,2);});
test('ordinary text does not invalidate group files; real file changes do',()=>{
 const calls=[],stop=onChatWake(e=>calls.push(e));
 notifyChatWake('a','live',[{kind:'chat_message',snapshot:{has_group_files:false}}]);
 notifyChatWake('a','live',[{kind:'chat_message',snapshot:{has_group_files:true,message_change:'recall'}}]);
 assert.deepEqual(calls.map(e=>e.groupFilesChanged),[false,true]);stop();
});
