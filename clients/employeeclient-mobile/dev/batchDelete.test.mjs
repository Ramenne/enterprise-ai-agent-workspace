import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
const adapters={
 '@/api/client':`export const newIdempotencyKey=()=> 'delete-'+(++globalThis.deleteTest.keys);export function captureApiLease(){const f=globalThis.deleteTest,a=f.account,e=f.epoch;return {account:a,valid:()=>f.account===a&&f.epoch===e}}`,
 '@/api/endpoints':`export const communication={changeMessage:(...a)=>globalThis.deleteTest.change(...a)};`,
 '@/store/chat':`export const useChatStore=()=>({mutationPending:globalThis.deleteTest.singlePending,acceptChange:(...a)=>globalThis.deleteTest.accepted.push(a)});`,
 '@/platform/chatEvents':`export const notifyChatWake=()=>{};`
};
const built=await build({entryPoints:['src/chat/batchDelete.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/^@\//},args=>adapters[args.path]?{path:args.path,namespace:'ports'}:undefined);b.onLoad({filter:/.*/,namespace:'ports'},args=>({contents:adapters[args.path],loader:'js'}));}}]});
let version=0;const fresh=()=>import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text+'\n//'+version++).toString('base64'));
const row=(id,seq,body='text',peer='')=>({id,seq,body,conversation_peer:peer,hidden:false,recalled:false,allowed_actions:['hide'],attachments:[]});
async function fixture(){
 const map=new Map(),receipts=new Map();globalThis.localStorage={getItem:k=>map.get(k)||null,setItem:(k,v)=>{if(globalThis.deleteTest.failSave(JSON.parse(v)))throw Error('quota');map.set(k,v);}};
 const f=globalThis.deleteTest={keys:0,account:'a',epoch:1,requests:[],accepted:[],failSave:()=>false,singlePending:null};
 f.change=async(id,action,key)=>{f.requests.push({id,action,key});if(!receipts.has(key))receipts.set(key,{message:{...row(id,1),hidden:true}});return receipts.get(key)};
 return {m:await fresh(),f,map,receipts};
}
test('all visible messages selectable, text copy stable chronology, deletion requires allowed action and same peer',async()=>{
 const {m}=await fixture();assert.equal(m.canSelectMessage({...row('voice',1),attachments:[{purpose:'voice'}]}),true);assert.equal(m.selectionText([row('b',2,'second\nline'),row('a',1,'first')]),'first\n\nsecond\nline');assert.throws(()=>m.selectionText([row('empty',1,'')]));assert.throws(()=>m.prepareBatchDelete('a','',[{...row('x',1),allowed_actions:[]}])) ;assert.throws(()=>m.prepareBatchDelete('a','',[row('x',1,'text','b')]));
});
test('response loss persists confirmed prefix; reload retries same hide key without repeating confirmed prefix',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchDelete('a','',[row('3',3),row('1',1),row('2',2)]),change=f.change;let lose=true;
 f.change=async(...a)=>{const r=await change(...a);if(a[0]==='2'&&lose){lose=false;throw Error('lost')}return r};assert.equal(await m.startBatchDelete(intent).promise,false);assert.equal(m.readBatchDelete('a').body.confirmed,1);
 const reboot=await fresh();assert.equal(await reboot.startBatchDelete(reboot.readBatchDelete('a')).promise,3);assert.deepEqual(f.requests.map(r=>r.id),['1','2','2','3']);assert.deepEqual(f.requests[1],f.requests[2]);assert.equal(receipts.size,3);assert.equal(reboot.readBatchDelete('a'),null);
});
test('progress save failure after server success retains original id/key for recovery',async()=>{
 const {m,f,receipts}=await fixture(),intent=m.prepareBatchDelete('a','',[row('1',1)]);f.failSave=all=>all['chat-batch-delete']?.body.confirmed===1;assert.equal(await m.startBatchDelete(intent).promise,false);assert.equal(m.readBatchDelete('a').body.confirmed,0);f.failSave=()=>false;const reboot=await fresh();assert.equal(await reboot.startBatchDelete(reboot.readBatchDelete('a')).promise,1);assert.deepEqual(f.requests[0],f.requests[1]);assert.equal(receipts.size,1);
});
test('account change during response prevents local merge and remaining deletes; own account can recover',async()=>{
 const {m,f}=await fixture(),intent=m.prepareBatchDelete('a','',[row('1',1),row('2',2)]),change=f.change;f.change=async(...a)=>{const r=await change(...a);f.account='b';f.epoch++;return r};assert.equal(await m.startBatchDelete(intent).promise,false);assert.equal(f.requests.length,1);assert.equal(f.accepted.length,0);assert.equal(m.readBatchDelete('b'),null);f.account='a';f.epoch++;f.change=change;const reboot=await fresh();assert.equal(await reboot.startBatchDelete(reboot.readBatchDelete('a')).promise,2);assert.deepEqual(f.requests[0],f.requests[1]);
});
test('pause stops next request, single pending operation/storage failure/corrupt recovery block work',async()=>{
 const {m,f}=await fixture(),intent=m.prepareBatchDelete('a','',[row('1',1),row('2',2)]),change=f.change;let release;f.change=async(...a)=>{const r=await change(...a);await new Promise(resolve=>release=resolve);return r};const job=m.startBatchDelete(intent);await new Promise(r=>setImmediate(r));job.cancel();release();assert.equal(await job.promise,false);assert.equal(f.requests.length,1);f.change=change;assert.equal(await m.startBatchDelete(m.readBatchDelete('a')).promise,2);
 const {m:n,f:g,map}=await fixture();g.singlePending={id:'x'};assert.throws(()=>n.prepareBatchDelete('a','',[row('1',1)]));g.singlePending=null;g.failSave=()=>true;assert.throws(()=>n.prepareBatchDelete('a','',[row('1',1)]));assert.equal(g.requests.length,0);map.set('qn.pending-writes.a',JSON.stringify({'chat-batch-delete':{key:'bad',scope:'company',body:{peer:'',ids:['x','x'],confirmed:0}}}));assert.throws(()=>n.readBatchDelete('a'));
});
