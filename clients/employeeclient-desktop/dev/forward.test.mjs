import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('only legacy drafts are recoverable; new forward writers are removed',async()=>{
 const data=new Map(),oldStorage=globalThis.localStorage,oldWindow=globalThis.window;
 globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 globalThis.window={dispatchEvent(){}};
 try{
  const bundle=await build({entryPoints:['src/files/forward.ts'],bundle:true,write:false,format:'esm',platform:'node'});
  const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  assert.equal(api.stageForward,undefined);assert.equal(api.stageCloudForward,undefined);
  const {pendingForwards,removeForwards,updateForward,replaceForward,clearForwards}=api;
  const seed=(owner,files)=>data.set('qn.forward:'+owner,JSON.stringify(files));
  const file=id=>({id,file_id:'cloud-'+id,name:id+'.txt'});
  seed('alice',[file('one'),file('two')]);seed('bob',[file('private')]);
  assert.deepEqual(pendingForwards('alice',1).map(x=>x.id),['one']);
  assert.deepEqual(pendingForwards('alice',1).map(x=>x.id),['one'],'re-entering chat must keep unsent draft');
  removeForwards('alice',['one']);
  assert.deepEqual(pendingForwards('alice',1).map(x=>x.id),['two']);
  assert.deepEqual(pendingForwards('bob',6).map(x=>x.id),['private']);
  data.set('qn.forward:alice',JSON.stringify(file('legacy')));
  assert.deepEqual(pendingForwards('alice',6).map(x=>x.id),['legacy']);
  removeForwards('alice',['legacy']);
  seed('alice',[{...file('same'),name:'updated.txt'}]);
  updateForward('alice',{...file('same'),name:'renamed.txt'});
  assert.deepEqual(pendingForwards('alice',6).map(x=>x.name),['renamed.txt']);
  const privateFile={id:'cl_1',file_id:'private-1',ver:1,sha256:'a'.repeat(64),name:'个人原件.txt',mime:'text/plain',size:43,state:'ready'};
  const draft={id:'cloud-draft:cl_1',file_id:'private-1',name:'群里名字.txt',cloud_file:privateFile};
  seed('alice',[draft]);
  assert.equal(draft.cloud_file.file_id,'private-1');
  assert.equal(pendingForwards('alice',6).at(-1).name,'群里名字.txt');
  assert.equal(pendingForwards('alice',6).at(-1).id,draft.id);
  replaceForward('alice',draft.id,{...file('public-1'),name:draft.name});
  assert.equal(pendingForwards('alice',6).at(-1).id,'public-1');
  seed('alice',[file('logout')]);clearForwards('alice');
  assert.deepEqual(pendingForwards('alice',6),[]);
  globalThis.localStorage={...globalThis.localStorage,setItem:()=>{throw Error('quota');}};
  seed('alice',[file('blocked')]);
  assert.throws(()=>updateForward('alice',{...file('blocked'),name:'保留原稿.txt'}),/无法更新待发送群附件/);
 }finally{globalThis.localStorage=oldStorage;globalThis.window=oldWindow;}
});
