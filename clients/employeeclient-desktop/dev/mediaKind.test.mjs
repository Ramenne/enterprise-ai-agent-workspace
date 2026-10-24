import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/chat/mediaKind.ts'],bundle:true,write:false,format:'esm'});
const {isVoiceMessage,voiceBubbleWidth}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('recordings and uploaded audio documents are distinct, including exact legacy filename',()=>{
 const old={name:'语音-2026-09-21T06-00-00-000Z.m4a',mime:'audio/mp4'};
 assert.equal(isVoiceMessage(old),true);
 assert.equal(isVoiceMessage({...old,purpose:'file'}),false);
 assert.equal(isVoiceMessage({name:'会议.mp3',mime:'audio/mpeg'}),false);
 assert.equal(isVoiceMessage({name:'other.webm',mime:'audio/webm',purpose:'voice'}),true);
 assert.equal(isVoiceMessage({...old,mime:'application/pdf'}),false);
});
test('compact voice width increases with duration, capped and safe for invalid metadata',()=>{
 assert.equal(voiceBubbleWidth(0),104);assert.equal(voiceBubbleWidth(4),120);
 assert.ok(voiceBubbleWidth(30)>voiceBubbleWidth(4));assert.equal(voiceBubbleWidth(600),224);
 assert.equal(voiceBubbleWidth(Infinity),104);assert.equal(voiceBubbleWidth(-1),104);
});
