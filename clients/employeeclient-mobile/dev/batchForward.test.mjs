import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex'),bytes=Buffer.from('original file bytes');
const adapters={
 '@/api/client':`export const newIdempotencyKey=()=> 'batch-'+(++globalThis.batchTest.keys);export function captureApiLease(){const f=globalThis.batchTest,a=f.account,e=f.epoch;return {account:a,valid:()=>f.account===a&&f.epoch===e}}`,
 '@/api/endpoints':`export const communication={send:(...a)=>globalThis.batchTest.send(...a)};`,
 '@/store/chat':`export const useChatStore=()=>({acceptSent:(...a)=>globalThis.batchTest.accepted.push(a)});`,
 '@/platform/chatEvents':`export const notifyChatWake=()=>{};`,
 '@/collaboration/media':`export const findAttachment=async()=>({cached:true,uploadSource:new Blob([globalThis.batchTest.bytes]),dispose(){},cacheAs:async()=>{}});`,
 '@/files/acquisition':`export const getAcquisition=()=>undefined;export const startAcquisition=()=>({promise:Promise.resolve()});`,
 '@/files/smallMedia':`export const canSendSmallMedia=()=>globalThis.batchTest.small;export const sendSmallMedia=(...a)=>globalThis.batchTest.smallSend(...a);`,
 '@/files/uploadReceipts':`export const fileDigest=async file=>globalThis.batchTest.hash(await(await file.readPart(0,file.size)).arrayBuffer());`,
 './files':`export const getChatDownload=()=>({download_url:'https://unused.invalid'});export const uploadChatFile=(...a)=>globalThis.batchTest.upload(...a);`,
};
const built=await build({stdin:{contents:`export * from './src/chat/batchForward.ts';export {readMediaForward,prepareMediaForward} from './src/chat/mediaForward.ts';`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'batch-ports',setup(b){b.onResolve({filter:/.*/},a=>adapters[a.path]?{path:a.path,namespace:'adapter'}:a.path.startsWith('@/')?{path:resolve('src',a.path.slice(2)+(/\.[a-z]+$/.test(a.path)?'':'.ts'))}:undefined);b.onLoad({filter:/.*/,namespace:'adapter'},a=>({contents:adapters[a.path],loader:'js'}));}}]});
let generation=0;const fresh=()=>import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64')+'#'+(++generation));
const attachment={id:'public:source',name:'原文件.txt',mime:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'file',ver:1};
const message=(id,seq,text,media=false)=>({id,seq,body:text,attachments:media?[attachment]:[],mention_usernames:['old'],reply_to:{id:'old'},context:{work_item_id:'old'}});
async function fixture(){
 const storage=new Map(),receipts=new Map();
 const f=globalThis.batchTest={account:'a',epoch:1,keys:0,bytes,small:true,accepted:[],texts:[],confirmations:[],media:[],uploads:[],hash:b=>digest(Buffer.from(b)),failSave:()=>false};
 f.put=(k,v)=>{if(f.failSave(JSON.parse(v)))throw Error('quota');storage.set(k,v)};
 globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>f.put(k,v),removeItem:k=>storage.delete(k)};
 const receipt=(key,body,files=[])=>{if(!receipts.has(key))receipts.set(key,{message:{id:key,author_username:'a',conversation_peer:body.recipient_username||'',body:body.body,attachments:files}});return receipts.get(key)};
 f.send=async(body,key)=>{(body.attachment_ids?.length?f.confirmations:f.texts).push({body,key});return receipt(key,body,(body.attachment_ids||[]).map(id=>({...attachment,id,owner_username:'a',private_peer:body.recipient_username||''})))};
 f.smallSend=async(file,body,peer,_purpose,_duration,key)=>{f.media.push({key,peer,name:file.name,body});return receipt(key,body,[{...attachment,id:'private:'+key,owner_username:'a',private_peer:peer}])};
 f.upload=async(_file,key,_p,_s,_purpose,_duration,peer)=>{f.uploads.push({key,peer});return {...attachment,id:'private:'+key,owner_username:'a',private_peer:peer}};
 return {f,storage,receipts,m:await fresh()};
}
test('mixed selection freezes chronological order and rejects unavailable/oversized or corrupt progress',async()=>{
 const {m}=await fixture(),a=message('a',1,'first'),b=message('b',2,'file',true),intent=m.prepareBatchForward('a','b',[b,a,a]);a.body='changed';assert.deepEqual(intent.body.items.map(i=>i.text),['first','file']);assert.equal(intent.body.confirmed,0);
 await fixture();const n=await fresh();for(const bad of [{...b,recalled:true}])assert.throws(()=>n.prepareBatchForward('a','b',[bad]));assert.throws(()=>n.prepareBatchForward('a','b',Array.from({length:21},(_,i)=>message('n'+i,i,'x'))));
 const good=n.prepareBatchForward('a','b',[b]);good.body.confirmed=2;localStorage.setItem('qn.pending-writes.a',JSON.stringify({'chat-batch-forward':good}));assert.throws(()=>n.readBatchForward('a'));
});
test('partial media response loss skips confirmed text and resumes original child protocol/key before later text',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchForward('a','b',[message('3',3,'last'),message('2',2,'file',true),message('1',1,'first')]);let lose=true;const send=f.smallSend;f.smallSend=async(...args)=>{const r=await send(...args);if(lose){lose=false;throw Error('lost')}return r};
 assert.equal(await m.startBatchForward(intent).promise,false);assert.equal(m.readBatchForward('a').body.confirmed,1);assert.equal(m.readMediaForward('a','batch').body.smallMedia,true);f.small=false;
 const reboot=await fresh();assert.equal(await reboot.startBatchForward(reboot.readBatchForward('a')).promise,3);assert.equal(f.uploads.length,0);assert.deepEqual(f.media[0],f.media[1]);assert.deepEqual(f.texts.map(r=>r.body.body),['first','last']);assert.equal(receipts.size,3);assert.equal(reboot.readBatchForward('a'),null);assert.equal(reboot.readMediaForward('a','batch'),null);
 assert.deepEqual(f.texts[0].body,{body:'first',mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null,recipient_username:'b'});
});
test('crash/quota after child success retains its copy/protocol until parent progress is durable',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchForward('a','b',[message('file',1,'caption',true)]);f.failSave=all=>all['chat-batch-forward']?.body.confirmed===1;
 assert.equal(await m.startBatchForward(intent).promise,false);assert.equal(m.readBatchForward('a').body.confirmed,0);assert.ok(m.readMediaForward('a','batch').body.prepared);assert.equal(receipts.size,1);
 f.failSave=()=>false;f.small=false;const reboot=await fresh();assert.equal(await reboot.startBatchForward(reboot.readBatchForward('a')).promise,1);assert.equal(f.media.length,1);assert.equal(f.confirmations.length,1);assert.equal(f.confirmations[0].key,f.media[0].key);assert.deepEqual(f.confirmations[0].body.attachment_ids,['private:'+f.media[0].key]);assert.equal(receipts.size,1);assert.equal(f.uploads.length,0);
});
test('crash after parent advancement cleans only its preceding child and does not replay confirmed media',async()=>{
 const {m,f}=await fixture(),intent=m.prepareBatchForward('a','b',[message('file',1,'caption',true),message('text',2,'next')]);f.failSave=all=>all['chat-batch-forward']?.body.confirmed===1&&!all['chat-batch-media-forward'];assert.equal(await m.startBatchForward(intent).promise,false);assert.equal(m.readBatchForward('a').body.confirmed,1);assert.ok(m.readMediaForward('a','batch'));
 f.failSave=()=>false;const reboot=await fresh();assert.equal(await reboot.startBatchForward(reboot.readBatchForward('a')).promise,2);assert.equal(f.media.length,1);assert.equal(f.texts.length,1);
});
test('account change after receipt stops remaining messages and merge; restoration reuses the original key',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchForward('a','b',[message('t',1,'text'),message('f',2,'file',true)]),send=f.send;let change=true;f.send=async(...args)=>{const r=await send(...args);if(change){change=false;f.account='other';f.epoch++}return r};assert.equal(await m.startBatchForward(intent).promise,false);assert.equal(f.media.length,0);assert.equal(f.accepted.length,0);assert.equal(m.readBatchForward('other'),null);
 f.account='a';f.epoch++;const reboot=await fresh();assert.equal(await reboot.startBatchForward(reboot.readBatchForward('a')).promise,2);assert.deepEqual(f.texts[0],f.texts[1]);assert.equal(receipts.size,2);
});
test('explicit pause retains intent and stops later media until same-operation retry',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchForward('a','b',[message('t',1,'text'),message('f',2,'file',true)]),send=f.send;let release;f.send=async(...args)=>{const r=await send(...args);await new Promise(resolve=>release=resolve);return r};const job=m.startBatchForward(intent);await new Promise(resolve=>setImmediate(resolve));job.cancel();release();assert.equal(await job.promise,false);assert.equal(f.media.length,0);
 f.send=send;const reboot=await fresh();assert.equal(await reboot.startBatchForward(reboot.readBatchForward('a')).promise,2);assert.equal(receipts.size,2);
});
test('foreign child intent or initial storage failure prevents every request; single-media slot stays separate',async()=>{
 const {m,f}=await fixture(),msg=message('f',1,'file',true),intent=m.prepareBatchForward('a','b',[msg]);m.prepareMediaForward('a','c',msg,{key:'foreign-0'});assert.equal(await m.startBatchForward(intent).promise,false);assert.equal(f.media.length,0);assert.equal(f.texts.length,0);
 const {m:n,f:g}=await fixture();g.failSave=()=>true;assert.throws(()=>n.prepareBatchForward('a','b',[msg]));assert.equal(g.media.length,0);
 const {m:p}=await fixture(),single=p.prepareMediaForward('a','c',msg),batch=p.prepareBatchForward('a','b',[msg]);assert.equal(await p.startBatchForward(batch).promise,1);assert.equal(p.readMediaForward('a').key,single.key);
});
