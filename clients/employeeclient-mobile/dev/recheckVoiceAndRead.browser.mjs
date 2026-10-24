import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
import {startMediaForwardPreview} from './mediaForward.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const until=async(fn)=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('condition not reached');};
const origin='http://ui-notices.localhost:5260',server=startMediaForwardPreview(5260,{host:'ui-notices.localhost'});await new Promise(r=>server.listening?r():server.once('listening',r));
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'}),checks=[];
try{
 const ctx=await browser.newContext({viewport:{width:390,height:780},serviceWorkers:'block'}),b=await ctx.newPage();b.setDefaultTimeout(30000);
 await b.goto(origin+'/simulation/sim-b');await b.locator('.message-input').waitFor();
 // Clear only synthetic initial fixtures so this case has exactly one new unread.
 const initial=await (await b.request.get(origin+'/business/v1/notifications')).json();
 for(const n of initial.notifications)await b.request.post(origin+'/business/v1/notifications/'+n.id+'/read',{headers:{origin,'idempotency-key':'initial-'+n.id},data:{}});
 await b.goto(origin+'/#/work');
 const other=await browser.newContext(),a=await other.newPage();a.setDefaultTimeout(30000);await a.goto(origin+'/simulation/sim-a');await a.locator('.message-input').waitFor();
 const send=await a.request.post(origin+'/business/v1/messages',{headers:{origin,'idempotency-key':'read-recovery'},data:{body:'已读恢复目标',mention_usernames:[],attachment_ids:[]}});assert.ok(send.ok(),await send.text());
 await b.getByLabel('新聊天消息',{exact:true}).getByText('已读恢复目标',{exact:true}).waitFor();
 const notes=(await(await b.request.get(origin+'/business/v1/notifications')).json()).notifications,note=notes.find(n=>n.summary==='已读恢复目标');assert.ok(note);assert.equal(note.read_at,null);
 server.qaReadFailures.id=note.id;server.qaReadFailures.remaining=2;
 await b.goto(origin+'/#/chat');await b.locator('[data-message-id="'+note.object_id+'"]').waitFor();
 await until(()=>!!server.qaState().notifications.find(n=>n.id===note.id)?.read_at);
 assert.equal(server.qaReadFailures.rejected,2);await b.goto(origin+'/#/messages');await b.locator('.conversation-row').first().waitFor();
 assert.equal(await b.locator('.conversation-row').filter({hasText:'公司工作群'}).locator('.count-badge').count(),0);
 checks.push('PWA visible message survives two HTTP503 read failures, automatically confirms read without reentry; conversation badge clears (OS notification check unavailable: headless browser denies permission)');
 // A real, decodable half-second PCM WAV, forwarded as voice rather than a file.
 const wav=Buffer.alloc(44+8000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(8000,40);
 const seed=await a.request.post(origin+'/simulation/seed-file',{data:{name:'转发语音.wav',mime:'audio/wav',purpose:'voice',duration_ms:500,base64:wav.toString('base64')}});assert.ok(seed.ok(),await seed.text());const voice=(await seed.json()).message;
 await a.reload();const bubble=a.locator('[data-message-id="'+voice.id+'"] .chat-bubble');await bubble.scrollIntoViewIfNeeded();await a.waitForTimeout(300);await bubble.dispatchEvent('contextmenu');await a.getByRole('button',{name:'转发消息',exact:true}).press('Enter');
 const dialog=a.getByRole('dialog',{name:'转发给'});await dialog.getByRole('button',{name:'模拟成员 B',exact:true}).click();await dialog.getByRole('button',{name:'发送',exact:true}).click();await dialog.waitFor({state:'hidden'});
 let rows=(await(await b.request.get(origin+'/business/v1/messages?peer=sim-a')).json()).messages;assert.equal(rows.length,1);const copy=rows[0].attachments[0];assert.equal(copy.purpose,'voice');assert.equal(copy.duration_ms,500);
 const bytes=await b.request.get(origin+'/business/v1/private-attachments/'+copy.id.slice(8)+'/file');assert.deepEqual(await bytes.body(),wav);
 await b.goto(origin+'/#/chat?peer=sim-a');const card=b.locator('[data-message-id="'+rows[0].id+'"]');await card.locator('.voice-bubble').click();await card.getByLabel('语音消息音频',{exact:true}).waitFor({state:'attached'});await b.waitForFunction(id=>{const el=document.querySelector('[data-message-id="'+id+'"] audio');return el&&el.readyState>=1&&el.duration>0;},rows[0].id);
 checks.push('voice forwarded as an actual playable voice bubble with original bytes and 500ms duration on independent recipient');
 // Mixed selection sends the voice and text in their original chronological order.
 const text=await a.request.post(origin+'/business/v1/messages',{headers:{origin,'idempotency-key':'mixed-voice-text'},data:{body:'和语音一起转发',mention_usernames:[],attachment_ids:[]}});assert.ok(text.ok(),await text.text());const textMessage=(await text.json()).message;
 await a.reload();await bubble.scrollIntoViewIfNeeded();await a.waitForTimeout(200);await bubble.dispatchEvent('contextmenu');await a.getByRole('button',{name:'多选消息',exact:true}).press('Enter');await a.locator('[data-message-id="'+textMessage.id+'"] .message-select').click();await a.getByRole('button',{name:'逐条转发（2）',exact:true}).click();await dialog.getByRole('button',{name:'模拟成员 B',exact:true}).click();await dialog.getByRole('button',{name:'发送',exact:true}).click();await dialog.waitFor({state:'hidden'});
 rows=(await(await b.request.get(origin+'/business/v1/messages?peer=sim-a')).json()).messages;assert.equal(rows.length,3);assert.equal(rows[1].attachments[0].purpose,'voice');assert.equal(rows[1].attachments[0].duration_ms,500);assert.equal(rows[2].body,'和语音一起转发');checks.push('mixed voice and text multi-select forwarding commits both messages in order');
 await other.close();await ctx.close();
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync('/Users/developer/Downloads/超强学习/research/employeeclient-chain-research-20261015/ui-review/v138-recheck-voice-read.json',JSON.stringify({checks},null,2));console.log(checks);}
