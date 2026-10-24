import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex');
const adapters={
 '@/api/client':`export const newIdempotencyKey=()=> 'media-key';export function captureApiLease(){const f=globalThis.mediaTest,a=f.account,e=f.epoch;return {account:a,valid:()=>f.account===a&&f.epoch===e}}`,
 '@/api/endpoints':`export const communication={send:(...a)=>globalThis.mediaTest.send(...a)};`,
 '@/store/chat':`export const useChatStore=()=>({acceptSent:(...a)=>globalThis.mediaTest.accepted.push(a)});`,
 '@/platform/chatEvents':`export const notifyChatWake=()=>{};`,
 '@/collaboration/media':`export const findAttachment=(...a)=>globalThis.mediaTest.find(...a);`,
 '@/files/acquisition':`export const getAcquisition=()=>undefined;export const startAcquisition=()=>({promise:globalThis.mediaTest.acquire()});`,
 '@/files/smallMedia':`export const canSendSmallMedia=()=>globalThis.mediaTest.small;export const sendSmallMedia=(...a)=>globalThis.mediaTest.smallSend(...a);`,
 '@/files/uploadReceipts':`export const fileDigest=(...a)=>globalThis.mediaTest.hash(...a);`,
 './files':`export const getChatDownload=()=>({download_url:'https://unused.invalid'});export const uploadChatFile=(...a)=>globalThis.mediaTest.upload(...a);`,
};
const built=await build({entryPoints:['src/chat/mediaForward.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'media-ports',setup(b){b.onResolve({filter:/.*/},a=>adapters[a.path]?{path:a.path,namespace:'adapter'}:a.path.startsWith('@/')?{path:resolve('src',a.path.slice(2)+(/\.[a-z]+$/.test(a.path)?'':'.ts'))}:undefined);b.onLoad({filter:/.*/,namespace:'adapter'},a=>({contents:adapters[a.path],loader:'js'}));}}]});
const {canForwardMedia,prepareMediaForward,readMediaForward,startMediaForward,pauseMediaForward}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const original=Buffer.from('same original bytes'),source={id:'private:old',name:'原文件.txt',mime:'text/plain',size:original.length,sha256:digest(original),purpose:'file',ver:1};
const message={id:'source-message',seq:1,body:'原附言',attachments:[source],mention_usernames:['old'],reply_to:{id:'old'},context:{work_item_id:'old'}};
function fixture(){const values=new Map();globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const f=globalThis.mediaTest={account:'a',epoch:1,small:false,accepted:[],uploads:[],sends:[],acquire:async()=>{},hash:async()=>source.sha256,find:async()=>({cached:true,uploadSource:new Blob([original]),dispose(){},cacheAs:async()=>{}})};
 f.attachment=peer=>({...source,id:peer?'private:new-'+peer:'new:public',owner_username:'a',private_peer:peer});
 f.receipt=(peer,a)=>({message:{id:'sent-'+peer,author_username:'a',conversation_peer:peer,attachments:[a]}});
 f.upload=async(_file,key,_p,_s,_purpose,_duration,peer)=>{f.uploads.push({key,peer});return f.attachment(peer)};
 f.send=async(body,key)=>{f.sends.push({body,key});return f.receipt(body.recipient_username||'',f.attachment(body.recipient_username||''))};
 f.smallSend=async(_file,body,peer,_p,_d,key)=>{f.sends.push({body,key});return f.receipt(peer,f.attachment(peer))};return f;
}
test('media selection rejects invalid voice metadata, recalled/hidden/unavailable and missing integrity',()=>{fixture();assert.equal(canForwardMedia(message),true);for(const m of [{...message,recalled:true},{...message,hidden:true},{...message,attachments:[{...source,purpose:'voice'}]},{...message,attachments:[{...source,sha256:''}]},{...message,attachments:[{...source,source_unavailable:true}]}]){assert.equal(canForwardMedia(m),false);assert.throws(()=>prepareMediaForward('a','b',m));}});
test('prepared private copy persists across response loss; retry uses original peer/caption/key without reupload',async()=>{
 const f=fixture(),intent=prepareMediaForward('a','b',message);let lose=true;const send=f.send;f.send=async(...args)=>{const result=await send(...args);if(lose){lose=false;throw Error('lost receipt')}return result};
 assert.equal(await startMediaForward(intent).promise,false);const saved=readMediaForward('a');assert.equal(saved.body.prepared.id,'private:new-b');assert.throws(()=>prepareMediaForward('a','c',message));
 const find=f.find;f.find=async attachment=>{assert.equal(attachment.id,'private:new-b');return find(attachment)};
 assert.equal(await startMediaForward(saved).promise,true);assert.equal(f.uploads.length,1);assert.deepEqual(f.sends[0],f.sends[1]);assert.deepEqual(f.sends[0].body,{body:'原附言',mention_usernames:[],attachment_ids:['private:new-b'],project_id:null,work_item_id:null,recipient_username:'b'});assert.equal(readMediaForward('a'),null);
});
test('small protocol choice survives failure and never falls back to a different upload or recipient',async()=>{
 const f=fixture();f.small=true;const intent=prepareMediaForward('a','a',message),send=f.smallSend;let lose=true;f.smallSend=async(...args)=>{const r=await send(...args);if(lose){lose=false;throw Error('lost')}return r};assert.equal(await startMediaForward(intent).promise,false);f.small=false;assert.equal(await startMediaForward(readMediaForward('a')).promise,true);assert.equal(f.uploads.length,0);assert.deepEqual(f.sends[0],f.sends[1]);
});
test('corrupted original or storage failure prevents publication and send',async()=>{
 const f=fixture();f.hash=async()=>digest('corrupt');assert.equal(await startMediaForward(prepareMediaForward('a','b',message)).promise,false);assert.equal(f.uploads.length,0);assert.equal(f.sends.length,0);
 fixture();globalThis.localStorage.setItem=()=>{throw Error('quota')};assert.throws(()=>prepareMediaForward('a','b',message));assert.equal(globalThis.mediaTest.sends.length,0);
});
test('pause or account renewal stops a queued acquisition; retry uses a fresh lease and same fixed intent',async()=>{
 const f=fixture();let finish;f.find=()=>new Promise(resolve=>finish=resolve);const intent=prepareMediaForward('a','b',message),job=startMediaForward(intent);pauseMediaForward('a');finish(undefined);assert.equal(await job.promise,false);assert.equal(job.state,'paused');assert.equal(f.uploads.length,0);
 f.epoch++;f.find=async()=>({cached:true,uploadSource:new Blob([original]),dispose(){}});assert.equal(await startMediaForward(readMediaForward('a')).promise,true);assert.equal(f.uploads[0].key,intent.key+'-file');
});
test('cross-account late upload cannot send or merge receipt; wrong target copy is rejected',async()=>{
 const f=fixture();f.upload=async()=>{f.account='other';return f.attachment('b')};assert.equal(await startMediaForward(prepareMediaForward('a','b',message)).promise,false);assert.equal(f.sends.length,0);assert.equal(f.accepted.length,0);assert.equal(readMediaForward('other'),null);
 const g=fixture();g.upload=async()=>g.attachment('c');assert.equal(await startMediaForward(prepareMediaForward('a','b',message)).promise,false);assert.equal(g.sends.length,0);
});
test('retrying a persisted target copy confirms its message even when file reads are unavailable',async()=>{
 const f=fixture(),intent=prepareMediaForward('a','b',message);let lose=true;const send=f.send;
 f.send=async(...args)=>{const receipt=await send(...args);if(lose){lose=false;throw Error('receipt lost');}return receipt;};
 assert.equal(await startMediaForward(intent).promise,false);const saved=readMediaForward('a');assert.ok(saved.body.prepared);
 f.find=async()=>{throw Error('file reads currently unavailable');};f.hash=async()=>{throw Error('must not hash again');};f.upload=async()=>{throw Error('must not copy again');};
 assert.equal(await startMediaForward(saved).promise,true);assert.equal(f.sends.length,2);assert.deepEqual(f.sends[0],f.sends[1]);assert.equal(f.uploads.length,1);
});
test('a confirmed fast-media target surviving cleanup failure can recover without changing its message key',async()=>{
 const f=fixture();f.small=true;const intent=prepareMediaForward('a','a',message),write=localStorage.setItem;
 localStorage.setItem=(key,value)=>{if(!JSON.parse(value)['chat-media-forward'])throw Error('cleanup temporarily unavailable');write(key,value);};assert.equal(await startMediaForward(intent).promise,false);
 const saved=readMediaForward('a');assert.ok(saved.body.prepared);assert.equal(saved.body.smallMedia,true);
 localStorage.setItem=write;f.find=async()=>{throw Error('cache reclaimed');};f.smallSend=async()=>{throw Error('do not upload fast media again');};
 assert.equal(await startMediaForward(saved).promise,true);assert.equal(f.sends.length,2);assert.equal(f.sends[0].key,f.sends[1].key);assert.equal(readMediaForward('a'),null);
});

test('two attachments remain one immutable message and resume after missing message receipt without another upload',async()=>{
 const f=fixture(),other={...source,id:'private:other',name:'另一个文件.txt'},copies=[];
 f.upload=async(file,key,_progress,_signal,_purpose,_duration,peer)=>{f.uploads.push(key);const copy={...source,id:'private:'+key,name:file.name,owner_username:'a',private_peer:peer};copies.push(copy);return copy;};
 let lose=true;f.send=async(body,key)=>{f.sends.push({body,key});if(lose){lose=false;throw Error('lost');}return {message:{id:'one',author_username:'a',conversation_peer:'b',body:body.body,attachments:copies}};};
 const intent=prepareMediaForward('a','b',{...message,attachments:[source,other]});assert.equal(await startMediaForward(intent).promise,false);assert.equal(readMediaForward('a').body.preparedItems.length,2);assert.equal(f.uploads.length,2);
 assert.equal(await startMediaForward(readMediaForward('a')).promise,true);assert.equal(f.uploads.length,2);assert.deepEqual(f.sends[0],f.sends[1]);assert.equal(f.sends[1].body.attachment_ids.length,2);assert.equal(f.accepted.length,1);
});

 test('voice forwarding preserves purpose, duration and exact retry receipt on both upload protocols',async()=>{
 for(const small of [false,true]){
 const f=fixture(),voice={...source,name:'语音.webm',mime:'audio/webm',purpose:'voice',duration_ms:4800};f.small=small;
 const copy={...voice,id:'private:voice',owner_username:'a',private_peer:'b'};let calls=0;
 f.upload=async(_file,_key,_progress,_signal,purpose,duration,peer)=>{calls++;assert.equal(purpose,'voice');assert.equal(duration,4800);assert.equal(peer,'b');return copy;};
 f.smallSend=async(_file,_body,peer,purpose,duration)=>{calls++;assert.equal(purpose,'voice');assert.equal(duration,4800);return f.receipt(peer,copy);};
 f.send=async()=>f.receipt('b',copy);
 assert.equal(canForwardMedia({...message,attachments:[voice]}),true);assert.equal(await startMediaForward(prepareMediaForward('a','b',{...message,attachments:[voice]})).promise,true);assert.equal(calls,1);assert.equal(f.accepted[0][2].attachments[0].purpose,'voice');
 }
 });
