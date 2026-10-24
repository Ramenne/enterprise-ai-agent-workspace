import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const adapters={
 '@/api/client':`export function captureApiLease(){const f=globalThis.draftTest,a=f.account,e=f.epoch;return {account:a,valid:()=>f.account===a&&f.epoch===e}}`,
 '@/session/db':`export const metaByPrefix=(...a)=>globalThis.draftTest.load(...a);export const metaSet=(...a)=>globalThis.draftTest.write(false,...a);export const metaRemove=(a,k,valid)=>globalThis.draftTest.write(true,a,k,null,valid);`,
};
const built=await build({stdin:{contents:`export * from './src/chat/drafts.ts';export {createPinia,setActivePinia} from 'pinia';`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'draft-ports',setup(b){b.onResolve({filter:/^@\//},a=>adapters[a.path]?{path:a.path,namespace:'adapter'}:{path:resolve('src',a.path.slice(2)+'.ts')});b.onLoad({filter:/.*/,namespace:'adapter'},a=>({contents:adapters[a.path],loader:'js'}));}}]});
const {useComposerDraftStore,createPinia,setActivePinia,normalizeDraft,draftPreview}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const snapshot=(body='')=>({body,mentions:[],reply:null,attachments:[],selectedContext:null,contextExplicit:false,updatedAt:123});
function fixture(){
 const records=new Map(),calls=[];
 const f=globalThis.draftTest={account:'a',epoch:1,load:async()=>({}),write:async(remove,a,k,v,valid)=>{calls.push({remove,a,k,v});if(valid()){if(remove)records.delete(a+':'+k);else records.set(a+':'+k,v);}}};
 setActivePinia(createPinia());const store=useComposerDraftStore();store.setAccount('a');return {f,store,records,calls};
}
test('legacy drafts normalize safely; explicit association, quote and attachment survive',()=>{
 const legacy={body:'旧草稿',mentions:['b'],reply:null,attachments:[]};assert.equal(normalizeDraft(legacy).contextExplicit,false);
 assert.equal(normalizeDraft({...legacy,body:42}),null);assert.equal(normalizeDraft({...legacy,attachments:[{}]}),null);
 const context={project_id:'p',project_title:'项目',work_item_id:'w',work_title:'结论'};
 const d={...snapshot(),selectedContext:context,contextExplicit:true};assert.deepEqual(normalizeDraft(d),d);assert.equal(draftPreview(d),'关联：结论');
});
test('late hydration cannot replace current edits; ordered clear follows in-flight first write',async()=>{
 const {store,f,records}=fixture();let finish;f.load=()=>new Promise(resolve=>finish=resolve);
 const load=store.load('a');await store.save('a','b',snapshot('当前输入'));finish({b:snapshot('旧缓存')});await load;assert.equal(store.entries.b.body,'当前输入');
 let release;f.write=async(remove,a,k,v,valid)=>{if(!remove)await new Promise(resolve=>release=resolve);if(valid()){if(remove)records.delete(a+':'+k);else records.set(a+':'+k,v);}};
 const send=store.save('a','c',snapshot('刚输入')),clear=store.save('a','c',snapshot());await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([send,clear]);assert.equal(records.has('a:composer:c'),false);assert.equal(store.entries.c,undefined);
});
test('group, private and helper stay separate; completed send clears only its draft',async()=>{
 const {store,records}=fixture();for(const peer of ['', 'b','a'])await store.save('a',peer,snapshot('草稿-'+peer));
 await store.save('a','b',snapshot());assert.equal(records.has('a:composer:b'),false);assert.equal(records.get('a:composer:').body,'草稿-');assert.equal(records.get('a:composer:a').body,'草稿-a');
});
test('failed persistence remains visible and can retry without pretending optimistic state is durable',async()=>{
 const {store,f}=fixture();const write=f.write;f.write=async()=>{throw Error('quota')};await assert.rejects(store.save('a','b',snapshot('不能丢')));
 assert.equal(store.entries.b.body,'不能丢');assert.match(store.errors.b,/尚未保存/);assert.equal(store.isSaved('b',snapshot('不能丢')),false);
 f.write=write;await store.save('a','b',snapshot('不能丢'));assert.equal(store.errors.b,undefined);assert.equal(store.isSaved('b',snapshot('不能丢')),true);
});
test('a rejected draft read can retry the durable draft without writing an empty replacement',async()=>{
 const {store,f,calls}=fixture();let attempts=0;
 const saved={...snapshot('未发送\n继续编辑'),mentions:['b'],selectedContext:{project_id:'p',work_item_id:'w'},contextExplicit:true};
 f.load=async()=>{if(++attempts===1)throw Error('temporary read failure');return {'':saved};};
 await assert.rejects(store.load('a'),/temporary read failure/);
 assert.equal(calls.length,0);await store.load('a');
 assert.equal(attempts,2);assert.deepEqual(store.entries[''],saved);assert.equal(calls.length,0);
 assert.equal(store.isSaved('',saved),true);
});
test('identity renewal invalidates queued persistence; a fresh lease can save unchanged content',async()=>{
 const {store,f,records}=fixture();let release;const write=f.write;f.write=async(...args)=>{await new Promise(resolve=>release=resolve);return write(...args)};
 const first=store.save('a','b',snapshot('保留'));await new Promise(resolve=>setImmediate(resolve));f.epoch++;release();await first;assert.equal(records.has('a:composer:b'),false);assert.equal(store.isSaved('b',snapshot('保留')),false);
 f.write=write;await store.save('a','b',snapshot('保留'));assert.equal(records.get('a:composer:b').body,'保留');
});
test('account change fences late read/write and never shows the old account drafts',async()=>{
 const {store,f,records}=fixture();let release,finish;f.load=()=>new Promise(resolve=>finish=resolve);const read=store.load('a');
 const write=f.write;f.write=async(...args)=>{await new Promise(resolve=>release=resolve);return write(...args)};const save=store.save('a','b',snapshot('A 私有内容'));await new Promise(resolve=>setImmediate(resolve));
 f.account='other';store.setAccount('other');finish({b:snapshot('旧账号')});release();await Promise.all([read,save]);assert.deepEqual({...store.entries},{});assert.equal(records.size,0);
});
