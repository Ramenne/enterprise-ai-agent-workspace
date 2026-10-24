import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
const code=await readFile(new URL('../src/platform/deeplink.ts',import.meta.url),'utf8'),result=await build({stdin:{contents:code,loader:'ts'},write:false,format:'esm'});const {routeFromTarget}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('private notification opens its participant conversation; group notification remains group',()=>{
 assert.deepEqual(routeFromTarget({object_type:'chat_message',object_id:'message',snapshot:{conversation_peer:'peer'}}),{name:'chat',params:{},query:{message:'message',peer:'peer'}});
 assert.deepEqual(routeFromTarget({object_type:'chat_message',object_id:'group'}),{name:'chat',params:{},query:{message:'group'}});
});
