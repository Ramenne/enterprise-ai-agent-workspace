import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {userError} from '../src/domain/userError.mjs';

const source=fs.readFileSync(new URL('../src/ui/components/ChatAttachmentPicker.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const code=ts.transpileModule(source.replace(/^import .*?;\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(read,upload=async()=>({id:'personal-file',sha256:'abc',state:'ready'}),deliver){
 let account='account-a',token='test-identity-a',mounted,unmount;const added=[],acks=[],staged=[];let uploads=0;
 const deps={
  userError,ref:value=>({value}),watch:()=>{},onMounted:fn=>mounted=fn,onBeforeUnmount:fn=>unmount=fn,
  defineProps:()=>({remaining:6,deliver}),defineExpose:()=>{},defineEmits:()=>((event,arg)=>{if(event==='added')added.push(arg);}),
  useSessionStore:()=>({user:{username:account}}),
  captureApiLease:()=>{const owner=token,actor=account;return {account:actor,valid:()=>token===owner&&account===actor};},newIdempotencyKey:()=> 'stable-test-key',MAX_CHAT_FILE_BYTES:32*1024*1024,
  uploadChatFile:async(...args)=>{uploads++;return upload(...args);},
  saveCloudFile:async(...args)=>{uploads++;return upload(...args);},
  stageCloudForward:(_owner,file,name)=>staged.push({file,name}),
  resumeIdentity:async()=> 'same-file',sha256:()=>new Uint8Array([1]),bytesToHex:()=> '01',fileDigest:async()=> 'abc',
  pendingSharedFiles:async()=>[{id:'share-a',name:'one.txt',size:3,path:'/private/test'}],readSharedFile:read,
  clearSharedFiles:async()=>{},acknowledgeSharedFile:async id=>acks.push(id),
  document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},navigator:{mediaDevices:{}},
  MediaRecorder:undefined,
 };
 const api=new Function(...Object.keys(deps),code+';return {importShared,checkShare,send,failed,shared};')(...Object.values(deps));
 return {...api,added,acks,staged,unmount:()=>unmount(),setToken:t=>token=t,setActor:a=>account=a,uploads:()=>uploads};
}
test('unmount during shared-file read aborts read and never starts upload',async()=>{
 const wait=deferred();let signal;
 const s=setup((_file,sig)=>{signal=sig;return wait.promise;});await s.checkShare();
 const run=s.importShared();s.unmount();assert.equal(signal.aborted,true);
 wait.resolve({name:'one.txt',size:3});await run;assert.equal(s.uploads(),0);assert.equal(s.added.length,0);
});
test('identity change during file read cannot upload under new identity',async()=>{
 const wait=deferred();const s=setup(()=>wait.promise);await s.checkShare();
 const run=s.importShared();s.setActor('account-b');wait.resolve({name:'one.txt',size:3});await run;
 assert.equal(s.uploads(),0);assert.deepEqual(s.acks,[]);
});
test('retrying a failed shared-file import yields one ready attachment and acknowledges once',async()=>{
 let fail=true;const file={name:'one.txt',size:3};const s=setup(async()=>file,async()=>{if(fail)throw Error('upload interrupted');return {id:'personal-file',sha256:'abc',state:'ready'};});
 await s.checkShare();await s.importShared();assert.equal(s.added.length,0);assert.deepEqual(s.acks,[]);
 fail=false;await s.send(s.failed.value,true);assert.deepEqual(s.acks,['share-a']);assert.equal(s.staged.length,0);assert.equal(s.added.length,1);assert.equal(s.shared.value.length,0);
});

test('uploaded file is sent without text and a delivery failure retries the same saved attachment',async()=>{
 let confirm=false,calls=0;const file={name:'one.txt',size:3};
 const s=setup(async()=>file,async()=>({id:'material:version',name:'one.txt',state:'ready'}),async(a,voice)=>{calls++;assert.equal(a.id,'material:version');assert.equal(voice,false);return confirm;});
 await s.send(file);assert.equal(s.uploads(),1);assert.equal(s.failed.value,file);assert.equal(s.staged.length,0);
 confirm=true;await s.send(file,true);assert.equal(calls,2);assert.equal(s.uploads(),1,'retry sends stored attachment, never uploads twice');assert.equal(s.failed.value,null);
});

test('same actor identity renewal during shared-file read can continue under a fresh lease',async()=>{
 const wait=deferred(),s=setup(()=>wait.promise);await s.checkShare();const run=s.importShared();s.setToken('renewed-same-member');wait.resolve({name:'one.txt',size:3});await run;assert.equal(s.uploads(),1);assert.deepEqual(s.acks,['share-a']);
});
