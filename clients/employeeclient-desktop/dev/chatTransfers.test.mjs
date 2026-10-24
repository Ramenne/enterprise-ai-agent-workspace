import {userError} from '../src/domain/userError.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFile} from 'node:fs/promises';
async function moduleWith(deps){deps={transferIdentity:(a,p,k)=>JSON.stringify([a,p,k]),prepareTransfer:async(a,p,k,message,file,purpose,duration,smallMedia)=>({version:1,id:JSON.stringify([a,p,k]),account:a,peer:p,requestKey:k,message,file:{...file},purpose,duration,smallMedia,state:'pending'}),putTransfer:async()=>{},readTransfers:async()=>[],removeTransfer:async()=>{},restoredTransferSource:()=>undefined,verifyTransferSource:async(_r,file)=>file,canSendSmallMedia:()=>false,sendSmallMedia:()=>{throw Error('unexpected fast media');},userError,useChatStore:()=>({acceptSent:()=>true}),...deps};const source=await readFile(new URL('../src/files/chatTransfers.ts',import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');return new Function(...Object.keys(deps),js+';return {startChatTransfer,stageChatTransfer,chatTransfers,clearChatTransfers,restoreChatTransfers};')(...Object.values(deps));}
test('file job keeps frozen recipient and idempotency when a send response is lost or the view changes',async()=>{
 let attempts=0,uploads=0,valid=true;const requests=[],wakes=[];
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>valid}),effectiveMime:()=> 'video/mp4',notifyChatWake:(...a)=>wakes.push(a),uploadChatFile:async(_f,_k,progress)=>{uploads++;progress('upload',{phase:'upload',loaded:10,total:20});return {id:'private:video'};},communication:{send:async(body,key)=>{requests.push({body,key});if(++attempts===1)throw Error('response lost');return {message:{id:'saved',attachments:[{id:'private:video'}]}};}}});
 const body={body:'',mention_usernames:['b'],reply_to_id:'r',attachment_ids:[]};const file={name:'test.mp4',type:'video/mp4',size:20};const job=mod.startChatTransfer(file,'key','b',body,'file');body.reply_to_id='new';assert.equal(await job.promise,false);assert.equal(job.state,'error');assert.equal(mod.chatTransfers('a','b')[0],job);assert.equal(mod.chatTransfers('other','b').length,0);
 assert.equal(await job.retry(),true);assert.equal(uploads,1);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[1].body.reply_to_id,'r');assert.equal(requests[1].body.recipient_username,'b');assert.equal(wakes.length,1);assert.equal(job.messageId,'saved');
 valid=false;mod.clearChatTransfers('a');assert.equal(mod.chatTransfers('a','b').length,0);
});
test('old cancelled upload cannot send after an immediate retry or account switch',async()=>{
 const pending=[],sent=[];let valid=true;
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>valid}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},uploadChatFile:()=>new Promise(resolve=>pending.push(resolve)),communication:{send:async(body)=>{sent.push(body);return {message:{id:'ok',attachments:[{id:'file'}]}};}}});
 const j=mod.startChatTransfer({name:'x',size:1},'key','a',{body:'',attachment_ids:[],mention_usernames:[]},'file');await new Promise(r=>setImmediate(r));const old=j.promise;j.cancel();const retry=j.retry();await new Promise(r=>setImmediate(r));pending[0]({id:'old'});assert.equal(await old,false);assert.equal(sent.length,0);pending[1]({id:'file'});assert.equal(await retry,true);assert.equal(sent.length,1);
 const next=mod.startChatTransfer({name:'x',size:1},'next','a',{body:'',attachment_ids:[],mention_usernames:[]},'file');await new Promise(r=>setImmediate(r));valid=false;pending[2]({id:'file'});assert.equal(await next.promise,false);assert.equal(sent.length,1);
});
test('same-account reconnect allows retry with a fresh lease, while another account cannot resume it',async()=>{
 let epoch=1,account='a',attempt=0;const requests=[];
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>{const own=account,generation=epoch;return {account:own,valid:()=>account===own&&epoch===generation};},effectiveMime:()=> 'audio/wav',notifyChatWake:()=>{},uploadChatFile:async()=>({id:'private:voice'}),communication:{send:async(body,key)=>{requests.push({body,key});if(++attempt===1){epoch++;throw Error('temporary recovery');}return {message:{id:'voice',attachments:[{id:'private:voice'}]}};}}});
 const job=mod.startChatTransfer({name:'voice.wav',type:'audio/wav',size:10},'voice','a',{body:'',mention_usernames:[],attachment_ids:[]},'voice',1000);assert.equal(await job.promise,false);assert.equal(job.state,'cancelled');assert.equal(await job.retry(),true);assert.deepEqual(requests[0],requests[1]);assert.equal(job.purpose,'voice');
 const blocked=mod.startChatTransfer({name:'voice.wav',size:10},'other','a',{body:'',mention_usernames:[],attachment_ids:[]},'voice',1000);await blocked.promise;account='b';epoch++;const count=requests.length;assert.equal(await blocked.retry(),false);assert.equal(requests.length,count);
});
test('combined private upload receipt completes the job without a second send request',async()=>{
 let sends=0,accepted=0;const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),useChatStore:()=>({acceptSent:()=>{accepted++;}}),effectiveMime:()=> 'audio/wav',notifyChatWake:()=>{},uploadChatFile:async(...args)=>{args[7].onReceipt({id:'committed',attachments:[{id:'private:voice'}]});return {id:'private:voice'};},communication:{send:async()=>{sends++;throw Error('duplicate send');}}});
 const job=mod.startChatTransfer({name:'voice.wav',size:3},'upload','b',{body:'',attachment_ids:[],mention_usernames:[]},'voice',4000);assert.equal(await job.promise,true);assert.equal(sends,0);assert.equal(accepted,1);assert.equal(job.messageId,'committed');
});
test('single-submit media freezes protocol across failed response and renewed capability',async()=>{
 let available=true,tries=0;const keys=[];const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),canSendSmallMedia:()=>available,sendSmallMedia:async(_f,_body,_p,_purpose,_duration,key)=>{keys.push(key);if(++tries===1){available=false;throw Error('response lost');}return {message:{id:'saved',attachments:[{id:'private:source'}]}};},effectiveMime:()=> 'audio/wav',notifyChatWake:()=>{},uploadChatFile:()=>{throw Error('must not change protocol');},communication:{send:()=>{throw Error('must not send twice');}}});
 const job=mod.startChatTransfer({name:'voice.wav',size:10},'key','b',{body:'',attachment_ids:[]},'voice',4000);assert.equal(await job.promise,false);assert.equal(await job.retry(),true);assert.deepEqual(keys,['key-message','key-message']);assert.equal(job.messageId,'saved');
});
test('an old fast-media job cannot upload or commit under a different identity',async()=>{
 let account='a',attempts=0;
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>{const owner=account;return {account:owner,valid:()=>owner===account};},canSendSmallMedia:()=>true,sendSmallMedia:async()=>{attempts++;throw Error('response lost');},effectiveMime:()=> 'image/png',notifyChatWake:()=>{},uploadChatFile:()=>{throw Error('wrong protocol');},communication:{send:()=>{throw Error('wrong protocol');}}});
 const job=mod.startChatTransfer({name:'x.png',size:10},'key','peer',{body:'',attachment_ids:[]},'file');await job.promise;
 account='b';assert.equal(await job.retry(),false);assert.equal(attempts,1);assert.equal(job.state,'cancelled');
});
test('local recovery write failure blocks both upload and message submission',async()=>{
 let network=0;const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},putTransfer:async()=>{throw Error('disk full');},uploadChatFile:async()=>{network++;},communication:{send:async()=>{network++;}}});
 const job=mod.startChatTransfer({name:'x',size:1},'disk','',{body:'',attachment_ids:[]},'file');assert.equal(await job.promise,false);assert.equal(network,0);assert.equal(job.state,'error');
});
test('restored confirmed attachment waits for manual retry and sends without source or reupload',async()=>{
 let sends=0,uploads=0;const rows=[{version:1,id:JSON.stringify(['a','','recover']),account:'a',peer:'',requestKey:'recover',message:{body:'caption',attachment_ids:[]},file:{name:'large',size:9000000,type:''},purpose:'file',smallMedia:false,state:'pending',attachment:{id:'fixed'}}];
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},readTransfers:async()=>rows,uploadChatFile:async()=>{uploads++;throw Error('no source');},communication:{send:async(body,key)=>{sends++;assert.equal(key,'recover-message');assert.equal(body.body,'caption');return {message:{id:'sent',attachments:[{id:'fixed'}]}};}}});
 await mod.restoreChatTransfers('a','');const job=mod.chatTransfers('a','')[0];assert.equal(sends,0);assert.equal(job.needsSource,false);assert.equal(await job.retry(),true);assert.equal(uploads,0);assert.equal(sends,1);
});
test('restore finishing after identity changes cannot recreate old-account jobs',async()=>{
 let resolve,valid=true;const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>valid}),readTransfers:()=>new Promise(r=>resolve=r)});const pending=mod.restoreChatTransfers('a','');valid=false;resolve([{id:'old'}]);await pending;assert.equal(mod.chatTransfers('a','').length,0);
});
test('late cancelled upload finishing after retry cannot overwrite confirmed attachment',async()=>{
 const pending=[];const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},uploadChatFile:()=>new Promise(r=>pending.push(r)),communication:{send:async()=>({message:{id:'sent',attachments:[{id:'new'}]}})}});
 const job=mod.startChatTransfer({name:'x',size:1},'late','',{body:'',attachment_ids:[]},'file');await new Promise(r=>setImmediate(r));const old=job.promise;job.cancel();const retry=job.retry();await new Promise(r=>setImmediate(r));pending[1]({id:'new'});assert.equal(await retry,true);pending[0]({id:'old'});await old;assert.equal(job.attachment.id,'new');assert.equal(job.state,'complete');
});
test('pause during original-file verification stops the restored task before upload',async()=>{
 let finish,uploads=0;const record={version:1,id:JSON.stringify(['a','','restore']),account:'a',peer:'',requestKey:'restore',message:{body:'',attachment_ids:[]},file:{name:'large',size:10,type:''},purpose:'file',smallMedia:false,state:'paused'};
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},readTransfers:async()=>[record],verifyTransferSource:()=>new Promise(r=>finish=r),uploadChatFile:async()=>{uploads++;return {id:'file'};},communication:{send:async()=>({message:{id:'sent',attachments:[{id:'file'}]}})}});
 await mod.restoreChatTransfers('a','');const job=mod.chatTransfers('a','')[0];const work=job.resumeWith({name:'large',size:10});job.cancel();finish({name:'large',size:10});assert.equal(await work,false);assert.equal(uploads,0);assert.equal(job.state,'cancelled');
});
test('cleared old task cannot overwrite the completed restored task journal on late response',async()=>{
 let finishOld;const stored=new Map();let uploads=0;
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},putTransfer:async record=>{stored.set(record.id,structuredClone(record));},readTransfers:async()=>[...stored.values()],restoredTransferSource:r=>({name:r.file.name,size:r.file.size}),uploadChatFile:async()=>{if(++uploads===1)return new Promise(r=>finishOld=r);return {id:'new'};},communication:{send:async()=>({message:{id:'sent',attachments:[{id:'new'}]}})}});
 const old=mod.startChatTransfer({name:'x',size:1},'same','',{body:'',attachment_ids:[]},'file');await new Promise(r=>setImmediate(r));mod.clearChatTransfers('a');await mod.restoreChatTransfers('a','');const current=mod.chatTransfers('a','')[0];assert.notEqual(current,old);assert.equal(await current.retry(),true);finishOld({id:'old'});await old.promise;const row=[...stored.values()][0];assert.equal(row.state,'complete');assert.equal(row.receipt.id,'sent');assert.equal(row.attachment.id,'new');
});
test('file selection is durable without uploading and explicit confirmation persists before any network effect',async()=>{
 const records=[],effects=[];const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},putTransfer:async record=>records.push(structuredClone(record)),uploadChatFile:async()=>{effects.push('upload');assert.equal(records.at(-1).sendConfirmed,true);return {id:'file'};},communication:{send:async()=>{effects.push('send');return {message:{id:'sent',attachments:[{id:'file'}]}};}}});
 const job=mod.stageChatTransfer({name:'chosen',size:10},'selection','',{body:'',attachment_ids:[]});await job.promise;
 assert.equal(job.needsConfirmation,true);assert.equal(records.at(-1).sendConfirmed,false);assert.deepEqual(effects,[]);
 assert.equal(await job.retry(),true);assert.equal(job.needsConfirmation,false);assert.deepEqual(effects,['upload','send']);
});
test('reentry preserves unconfirmed selection and reselecting its large original does not send',async()=>{
 let uploads=0;const stored=new Map();const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},putTransfer:async r=>stored.set(r.id,structuredClone(r)),readTransfers:async()=>[...stored.values()],uploadChatFile:async()=>{uploads++;return {id:'file'};},communication:{send:async()=>({message:{id:'sent',attachments:[{id:'file'}]}})}});
 const chosen=mod.stageChatTransfer({name:'large',size:9000000},'staged','',{body:'',attachment_ids:[]});await chosen.promise;mod.clearChatTransfers('a');await mod.restoreChatTransfers('a','');
 const restored=mod.chatTransfers('a','')[0];assert.equal(restored.needsSource,true);assert.equal(restored.needsConfirmation,true);assert.equal(uploads,0);
 assert.equal(await restored.resumeWith({name:'original-copy',size:9000000}),true);assert.equal(restored.needsSource,false);assert.equal(restored.needsConfirmation,true);assert.equal(uploads,0);
 assert.equal(await restored.retry(),true);assert.equal(uploads,1);
});
test('cancel selection removes only its unconfirmed local record and reentry cannot resurrect it',async()=>{
 const stored=new Map();const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',putTransfer:async r=>stored.set(r.id,structuredClone(r)),removeTransfer:async id=>stored.delete(id),readTransfers:async()=>[...stored.values()]});
 const job=mod.stageChatTransfer({name:'discard',size:10},'discard','',{body:'',attachment_ids:[]});await job.promise;assert.equal(await job.discard(),true);assert.equal(stored.size,0);await mod.restoreChatTransfers('a','');assert.equal(mod.chatTransfers('a','').length,0);
});
test('confirmation cannot race an in-progress selection cancellation',async()=>{
 let removed,uploads=0;const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',removeTransfer:()=>new Promise(r=>removed=r),uploadChatFile:async()=>{uploads++;return {id:'file'};}});
 const job=mod.stageChatTransfer({name:'race',size:10},'discard-race','',{body:'',attachment_ids:[]});await job.promise;const cancelling=job.discard();assert.equal(await job.retry(),false);removed();assert.equal(await cancelling,true);assert.equal(uploads,0);
});
test('a failed local confirmation write never uploads or commits the selected file',async()=>{
 let reject=false,effects=0;const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',putTransfer:async()=>{if(reject)throw Error('disk unavailable');},uploadChatFile:async()=>{effects++;return {id:'file'};}});
 const job=mod.stageChatTransfer({name:'disk',size:10},'disk','',{body:'',attachment_ids:[]});await job.promise;reject=true;assert.equal(await job.retry(),false);assert.equal(effects,0);assert.match(job.error,/本机恢复记录/);
});

// A lost receipt may already have produced a visible message on another device.
test('uncertain file receipt survives reload and confirms the original action without reupload',async()=>{
 const stored=new Map(),keys=[];let uploads=0,attempts=0;
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',notifyChatWake:()=>{},putTransfer:async r=>stored.set(r.id,structuredClone(r)),readTransfers:async()=>[...stored.values()],uploadChatFile:async()=>{uploads++;return {id:'file'};},communication:{send:async(body,key)=>{keys.push(key);if(++attempts===1)throw Error('lost receipt');return {message:{id:'committed',author_username:'a',attachments:[{id:'file'}]}};}}});
 const first=mod.startChatTransfer({name:'x',size:10},'receipt','',{body:'original',attachment_ids:[]},'file');assert.equal(await first.promise,false);assert.equal(first.receiptPending,true);assert.equal(first.stage,'发送结果待确认');assert.equal([...stored.values()][0].receiptPending,true);
 mod.clearChatTransfers('a');await mod.restoreChatTransfers('a','');const restored=mod.chatTransfers('a','')[0];assert.equal(restored.receiptPending,true);assert.equal(restored.stage,'发送结果待确认');assert.equal(await restored.retry(),true);assert.equal(restored.receiptPending,false);assert.equal(uploads,1);assert.deepEqual(keys,['receipt-message','receipt-message']);assert.equal([...stored.values()][0].receiptPending,false);
});
test('file acquisition failure before any message attempt is not an uncertain receipt',async()=>{
 const mod=await moduleWith({shallowReactive:v=>v,captureApiLease:()=>({account:'a',valid:()=>true}),effectiveMime:()=> 'text/plain',uploadChatFile:async()=>{throw Error('source unavailable');}});const job=mod.startChatTransfer({name:'x',size:10},'no-message','',{body:'',attachment_ids:[]},'file');assert.equal(await job.promise,false);assert.equal(job.receiptPending,false);assert.equal(job.stage,'发送未完成');
});
