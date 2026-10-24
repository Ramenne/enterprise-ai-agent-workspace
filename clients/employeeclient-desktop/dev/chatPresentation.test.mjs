import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/chat/presentation.ts'],bundle:true,write:false,format:'esm'});
const {conversationTime,messageSnippet}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const stamp=(y,m,d,h=0,min=0)=>new Date(y,m-1,d,h,min).getTime();

test('conversation previews keep short times without shortening chat history timestamps',()=>{
 const now=stamp(2026,10,14,15); // Wednesday
 assert.equal(conversationTime(stamp(2026,10,14,9,5),now),'09:05');
 assert.equal(conversationTime(stamp(2026,10,13,23,59),now),'昨天');
 assert.equal(conversationTime(stamp(2026,10,12,11),now),'星期一');
 assert.equal(conversationTime(stamp(2026,10,11),now),'10/11');
 assert.equal(conversationTime(stamp(2025,12,30),now),'2025/12/30');
 assert.equal(conversationTime(NaN,now),'');
});
test('yesterday survives Monday, leap days and year changes',()=>{
 assert.equal(conversationTime(stamp(2025,12,31,23,59),stamp(2026,1,1)),'昨天');
 assert.equal(conversationTime(stamp(2024,2,29,23,59),stamp(2024,3,1)),'昨天');
 assert.equal(conversationTime(stamp(2026,10,11,23,59),stamp(2026,10,12)),'昨天');
});
test('snapshot quotations without attachments and media previews use the same description',()=>{
 assert.equal(messageSnippet({body:'第一行\n第二行'}),'第一行 第二行');
 assert.equal(messageSnippet({body:''}),'');
 const attachment=(mime,name,purpose='file')=>({mime,name,purpose});
 assert.equal(messageSnippet({body:'',attachments:[attachment('audio/wav','record.wav','voice')]}),'[语音]');
 assert.equal(messageSnippet({body:'',attachments:[attachment('audio/mp4','会议.m4a')]}),'[文件] 会议.m4a');
 assert.equal(messageSnippet({body:'',attachments:[attachment('image/png','图.png'),attachment('video/mp4','视频.mp4'),attachment('application/pdf','合同.pdf')]}),'[图片] [视频] [文件] 合同.pdf');
});
