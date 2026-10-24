import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const adapters={
 '@/api/client':`export const captureApiLease=()=>{const account=globalThis.forwardTest.account;return {account,valid:()=>globalThis.forwardTest.account===account}};export const newIdempotencyKey=()=> 'forward-'+(++globalThis.forwardTest.keys);`,
 '@/api/endpoints':`export const communication={send:(...args)=>globalThis.forwardTest.send(...args)};`,
 '@/store/chat':`export const useChatStore=()=>({acceptSent:(...args)=>globalThis.forwardTest.accepted.push(args)});`,
 '@/platform/chatEvents':`export const notifyChatWake=()=>{};`,
};
const built=await build({entryPoints:['src/chat/forward.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'test-ports',setup(b){b.onResolve({filter:/^@\//},a=>adapters[a.path]?{path:a.path,namespace:'adapter'}:{path:resolve('src',a.path.slice(2)+(/\.[a-z]+$/.test(a.path)?'':'.ts'))});b.onLoad({filter:/.*/,namespace:'adapter'},a=>({contents:adapters[a.path],loader:'js'}));}}]});
const {prepareTextForward,sendTextForward,readTextForward,canForwardText}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
function fixture(){const values=new Map();globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};globalThis.forwardTest={account:'a',keys:0,accepted:[],send:async body=>({message:{id:'saved',body:body.body}})};return globalThis.forwardTest;}
const message=(id,seq,body)=>({id,seq,body,attachments:[],mention_usernames:['old'],reply_to:{id:'old'},context:{work_item_id:'old'}});
test('text selection rejects recalled, hidden and media messages before persistence',()=>{
 fixture();const m=message('m1',1,'hello');for(const bad of [{...m,recalled:true},{...m,hidden:true},{...m,attachments:[{id:'file'}]},{...m,body:'x'.repeat(20001)}]){assert.equal(canForwardText(bad),false);assert.throws(()=>prepareTextForward('a','b',[bad]));}
 assert.equal(readTextForward('a'),null);
});
test('batch keeps chronological order, strips old mentions/context and locks recipient/body across partial failure',async()=>{
 const f=fixture(),requests=[];let fail=true;
 f.send=async(body,key)=>{requests.push({body,key});if(body.body==='second'&&fail){fail=false;throw Error('response lost');}return {message:{id:key,body:body.body}};};
 const source=[message('2',2,'second'),message('1',1,'first')],intent=prepareTextForward('a','b',source);
 source[0].body='edited';await assert.rejects(sendTextForward(intent,new AbortController().signal));
 assert.equal(readTextForward('a').body.peer,'b');assert.equal(readTextForward('other'),null);
 assert.throws(()=>prepareTextForward('a','other',[message('3',3,'new')]));
 assert.equal(await sendTextForward(readTextForward('a'),new AbortController().signal),2);
 assert.deepEqual(requests[0],requests[2]);assert.deepEqual(requests[1],requests[3]);
 assert.deepEqual(requests[0].body,{body:'first',mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null,recipient_username:'b'});assert.equal(readTextForward('a'),null);
});
test('storage failure prevents every send; account invalidation stops subsequent messages and receipt merge',async()=>{
 const f=fixture();globalThis.localStorage.setItem=()=>{throw Error('storage full')};assert.throws(()=>prepareTextForward('a','',[message('1',1,'first')]));assert.equal(f.accepted.length,0);
 fixture();const intent=prepareTextForward('a','b',[message('1',1,'first'),message('2',2,'second')]);let calls=0;
 globalThis.forwardTest.send=async()=>{calls++;globalThis.forwardTest.account='other';return {message:{id:'late'}};};
 await assert.rejects(sendTextForward(intent,new AbortController().signal));assert.equal(calls,1);assert.equal(globalThis.forwardTest.accepted.length,0);assert.ok(readTextForward('a'));assert.equal(readTextForward('other'),null);
});
test('cancel retains original operation for retry and corrupt recovery never sends',async()=>{
 const f=fixture(),intent=prepareTextForward('a','a',[message('1',1,'self')]),controller=new AbortController();controller.abort();await assert.rejects(sendTextForward(intent,controller.signal));assert.ok(readTextForward('a'));
 globalThis.localStorage.setItem('qn.pending-writes.a',JSON.stringify({'chat-text-forward':{scope:'company',key:'bad',body:{peer:'b',items:[{sourceId:'x',text:null}]}}}));assert.throws(()=>readTextForward('a'));assert.equal(f.accepted.length,0);
});

 test('existing chat messages up to the server 20000 character limit remain forwardable',async()=>{
 fixture();
 const row={id:'long',seq:1,body:'长'.repeat(20000),attachments:[]};
 assert.equal(canForwardText(row),true);
 assert.equal(canForwardText({...row,body:row.body+'长'}),false);
 const saved=prepareTextForward('a','b',[row]);
 assert.equal(saved.body.items[0].text,row.body);
 });
