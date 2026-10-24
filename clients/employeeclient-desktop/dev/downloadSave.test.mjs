import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {sha256} from '@noble/hashes/sha2.js';
import {consumeDownloadStream,fetchDownloadResponse} from '../src/native/download-stream.mjs';
const digest=b=>Array.from(sha256(b),v=>v.toString(16).padStart(2,'0')).join('');
async function moduleWith(path,deps){deps={desktopBridge:()=>undefined,isDesktopNative:()=>false,consumeDownloadStream,fetchDownloadResponse,captureApiLease:()=>({account:'a',valid:()=>true}),...deps};const code=ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'');const key='__download_'+Math.random().toString(36).slice(2);globalThis[key]=deps;try{return await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+code).toString('base64'));}finally{delete globalThis[key];}}
const context={account:'a',computer:'cloud',provider:'company',thread:'group'};
test('PWA fixed attachment saves without IndexedDB or acquisition and can explicitly save again',async()=>{
 let acquires=0,saves=0;const prevWindow=globalThis.window;globalThis.window=new EventTarget();
 const mod=await moduleWith('../src/files/localSave.ts',{findAttachment:async()=>undefined,acquisitionKey:()=> 'same-fixed-file',startAcquisition:()=>{acquires++;throw Error('cache must not gate a download');},prepareBrowserSave:async()=>({save(){},cancel(){}}),saveRemoteAttachment:async()=>{saves++;return {state:'saved',message:'已保存'};},Capacitor:{isNativePlatform:()=>false},cacheLease:()=>()=>true});
 try{const a={id:'fixed',name:'report.txt'};await (await mod.startLocalSave(a,context,a.name,async()=>a)).promise;await (await mod.startLocalSave(a,context,a.name,async()=>a,undefined,true)).promise;assert.equal(acquires,0);assert.equal(saves,2);}finally{globalThis.window=prevWindow;}
});
test('Android explicit repeat passes new save intent and name without renaming the previous download',async()=>{
 const calls=[],oldWindow=globalThis.window;globalThis.window=new EventTarget();const media={localName:'original.txt',rename(){throw Error('must not rename the old system copy');},save:async(_target,options)=>{calls.push(options);return {state:'saved',message:'ok'};},dispose(){}};
 const mod=await moduleWith('../src/files/localSave.ts',{findAttachment:async()=>media,acquisitionKey:()=> 'native-file',startAcquisition(){throw Error('reuse verified bytes');},prepareBrowserSave(){throw Error('not browser');},Capacitor:{isNativePlatform:()=>true},cacheLease:()=>()=>true});
 try{await (await mod.startLocalSave({id:'a',name:'original.txt'},context,'copy.txt',async()=>{},undefined,true)).promise;assert.deepEqual(calls,[{repeat:true,name:'copy.txt'}]);}finally{globalThis.window=oldWindow;}
});
test('stream writer validates bytes before commit and aborts mismatches or identity changes',async()=>{
 const original=new Uint8Array([1,2,3]),oldWindow=globalThis.window;let committed=[],aborts=0,writes=0,valid=true;
 globalThis.window={showSaveFilePicker:async()=>({name:'report.txt',createWritable:async()=>({write:async b=>{writes++;committed.push(new Uint8Array(b));},close:async()=>{},abort:async()=>{aborts++;committed=[];}}),getFile:async()=>new Blob(committed)})};
 const mod=await moduleWith('../src/platform/saveFile.ts',{sha256});
 try{
  const target=await mod.prepareBrowserSave('report.txt');const receipt=await target.saveStream(new Blob([original]).stream(),{size:3,sha256:digest(original)},()=>valid,new AbortController().signal);assert.equal(receipt.state,'saved');assert.equal(writes,1);
  committed=[];const bad=await mod.prepareBrowserSave('report.txt');await assert.rejects(bad.saveStream(new Blob([original]).stream(),{size:3,sha256:'0'.repeat(64)},()=>true,new AbortController().signal),/校验失败/);assert.equal(aborts,1);assert.equal(committed.length,0);
  const cancelled=await mod.prepareBrowserSave('report.txt');const before=writes;valid=false;await assert.rejects(cancelled.saveStream(new Blob([original]).stream(),{size:3,sha256:digest(original)},()=>valid,new AbortController().signal),e=>e.name==='AbortError');assert.equal(writes,before);
 }finally{globalThis.window=oldWindow;}
});
test('exact own fixed URL may be handed to browser, but foreign URLs cannot skip integrity reading',async()=>{
 let handoffs=0,reads=0;const bytes=new Uint8Array([1]);const mod=await moduleWith('../src/files/download.ts',{isNativeFileUrl:u=>u==='https://own.test/native/file',safeRemote:u=>u,loadAttachment:async()=>{reads++;return {save:async()=>({state:'saved'}),dispose(){}}}});
 const a={id:'a',url:'https://own.test/native/file',size:1,sha256:digest(bytes)};const target={saveURL:async()=>{handoffs++;return {state:'handed_off'};},save(){}};
 assert.equal((await mod.saveRemoteAttachment(a,context,target,new AbortController().signal,()=>true)).state,'handed_off');await mod.saveRemoteAttachment({...a,url:'https://foreign.test/file'},context,target,new AbortController().signal,()=>true);assert.equal(handoffs,1);assert.equal(reads,1);
});
test('identity change during a streamed write aborts the uncommitted output',async()=>{
 let valid=true,closed=false,aborted=false;const oldWindow=globalThis.window;
 globalThis.window={showSaveFilePicker:async()=>({name:'report.txt',createWritable:async()=>({write:async()=>{valid=false;},close:async()=>{closed=true;},abort:async()=>{aborted=true;}}),getFile(){throw Error('must not read committed output');}})};
 try{const mod=await moduleWith('../src/platform/saveFile.ts',{sha256}),target=await mod.prepareBrowserSave('report.txt'),bytes=new Uint8Array([1,2]);await assert.rejects(target.saveStream(new Blob([bytes]).stream(),{size:2,sha256:digest(bytes)},()=>valid,new AbortController().signal),e=>e.name==='AbortError');assert.equal(closed,false);assert.equal(aborted,true);}finally{globalThis.window=oldWindow;}
});
test('current user HTTP denials never reach a file writer or retry through another identity',async()=>{
 const oldFetch=globalThis.fetch;let saves=0,calls=0;const mod=await moduleWith('../src/files/download.ts',{isNativeFileUrl:()=>true,safeRemote:u=>u,loadAttachment(){throw Error('no fallback');}});
 globalThis.fetch=async(_url,options)=>{calls++;assert.equal(options.credentials,'include');return new Response('',{status:403});};
 try{await assert.rejects(mod.saveRemoteAttachment({url:'https://own.test/native/file',size:1,sha256:'a'.repeat(64)},context,{saveStream:async()=>{saves++;},save(){}},new AbortController().signal,()=>true),/没有读取/);assert.equal(saves,0);assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;}
});

test('confirmed browser save retains its local bytes for sharing without another transfer',async()=>{
 let retained=0,downloads=0;const oldWindow=globalThis.window;globalThis.window=new EventTarget();const saved=new Blob(['verified local save']);
 const mod=await moduleWith('../src/files/localSave.ts',{findAttachment:async()=>undefined,retainLocalAttachment:async(a,c,source)=>{assert.equal(source,saved);assert.equal(a.id,'fixed-result');assert.equal(c.account,'a');retained++;},acquisitionKey:()=> 'save-then-share',startAcquisition(){throw Error('must not download to cache');},prepareBrowserSave:async()=>({readSaved:async()=>saved,cancel(){}}),saveRemoteAttachment:async()=>{downloads++;return {state:'saved',message:'ok'};},Capacitor:{isNativePlatform:()=>false},cacheLease:()=>()=>true});
 try{await (await mod.startLocalSave({id:'fixed-result',name:'report.txt'},context,'report.txt',async()=>({}))).promise;assert.equal(downloads,1);assert.equal(retained,1);}finally{globalThis.window=oldWindow;}
});
test('cancelling the save target interrupts a stalled body and aborts the temporary file',async()=>{
 const previous=globalThis.window;let aborted=false,cancelled=false;
 globalThis.window={showSaveFilePicker:async()=>({name:'file',createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{aborted=true;}})})};
 try{const mod=await moduleWith('../src/platform/saveFile.ts',{sha256}),target=await mod.prepareBrowserSave('file');
 const stream=new ReadableStream({cancel(){cancelled=true;}}),work=target.saveStream(stream,{size:1,sha256:'a'.repeat(64)},()=>true,new AbortController().signal);
 await new Promise(resolve=>setImmediate(resolve));target.cancel();
 const outcome=await Promise.race([work.then(()=> 'saved',e=>e.name),new Promise(resolve=>setTimeout(()=>resolve('hung'),30))]);
 assert.equal(outcome,'AbortError');assert.equal(aborted,true);assert.equal(cancelled,true);
 }finally{globalThis.window=previous;}
});
test('a stalled file body times out without committing incomplete output',async t=>{
 const previous=globalThis.window;let aborted=false,closed=false;
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());
 globalThis.window={showSaveFilePicker:async()=>({name:'file',createWritable:async()=>({write:async()=>{},close:async()=>{closed=true;},abort:async()=>{aborted=true;}})})};
 try{const mod=await moduleWith('../src/platform/saveFile.ts',{sha256}),target=await mod.prepareBrowserSave('file');
 const ctl=new AbortController(),work=target.saveStream(new ReadableStream(),{size:1,sha256:'a'.repeat(64)},()=>true,ctl.signal);
 const outcome=work.then(()=> 'saved',e=>e.name);await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(120000);await new Promise(resolve=>setImmediate(resolve));
 ctl.abort();assert.equal(await outcome,'TimeoutError');assert.equal(aborted,true);assert.equal(closed,false);
 }finally{globalThis.window=previous;}
});
test('cancellation while opening a blob destination cannot write or report success',async()=>{
 const previous=globalThis.window;let open,writes=0,aborts=0;
 globalThis.window={showSaveFilePicker:async()=>({name:'file',createWritable:()=>new Promise(resolve=>open=resolve),getFile:async()=>new Blob(['x'])})};
 try{const mod=await moduleWith('../src/platform/saveFile.ts',{sha256}),target=await mod.prepareBrowserSave('file'),work=target.save(new Blob(['x']));target.cancel();open({write:async()=>writes++,close:async()=>{},abort:async()=>aborts++});await assert.rejects(work,e=>e.name==='AbortError');assert.equal(writes,0);assert.equal(aborts,1);}finally{globalThis.window=previous;}
});
test('cleared destination preparation cannot return later and create a new save job',async()=>{
 const previous=globalThis.window;globalThis.window=new EventTarget();let choose,cancelled=0,saves=0;
 const mod=await moduleWith('../src/files/localSave.ts',{findAttachment:async()=>undefined,acquisitionKey:()=> 'pending-picker',cacheLease:()=>()=>true,Capacitor:{isNativePlatform:()=>false},prepareBrowserSave:()=>new Promise(resolve=>choose=resolve),saveRemoteAttachment:async()=>{saves++;return {state:'saved'};}});
 try{const work=mod.startLocalSave({id:'file',name:'file'},context,'file',async()=>({}));mod.clearLocalSaves('a');choose({cancel:()=>cancelled++});await assert.rejects(work,e=>e.name==='AbortError');assert.equal(saves,0);assert.equal(cancelled,1);}finally{globalThis.window=previous;}
});
test('old save cleanup cannot remove its replacement cancellation controller',async()=>{
 const previous=globalThis.window;globalThis.window=new EventTarget();let lookup,finishNew,readCount=0,saveCount=0,newSignal;
 const mod=await moduleWith('../src/files/localSave.ts',{findAttachment:()=>++readCount===1?new Promise(resolve=>lookup=resolve):Promise.resolve(undefined),acquisitionKey:()=> 'replace-save',cacheLease:()=>()=>true,Capacitor:{isNativePlatform:()=>false},prepareBrowserSave:async()=>({cancel(){}}),saveRemoteAttachment:async(_a,_c,_t,signal)=>{if(++saveCount===1){newSignal=signal;return new Promise(resolve=>finishNew=resolve);}return {state:'saved'};}});
 let replacement;
 try{
  const old=await mod.startLocalSave({id:'file',name:'file'},context,'file',async()=>({}));mod.clearLocalSaves('a');replacement=await mod.startLocalSave({id:'file',name:'file'},context,'file',async()=>({}));await new Promise(resolve=>setImmediate(resolve));
  const outcome=old.promise.then(()=> 'complete',e=>e.name);lookup(undefined);await outcome;mod.clearLocalSaves('a');assert.equal(newSignal.aborted,true);
 }finally{mod.clearLocalSaves('a');finishNew?.({state:'saved'});await replacement?.promise.catch(()=>{});globalThis.window=previous;}
});
test('a completed save projection cannot be reused under a replaced identity',async()=>{
 const previous=globalThis.window;globalThis.window=new EventTarget();let account='a';
 const mod=await moduleWith('../src/files/localSave.ts',{captureApiLease:()=>{const own=account;return{account:own,valid:()=>own===account};},findAttachment:async()=>({save:async()=>({state:'saved'}),dispose(){}}),acquisitionKey:()=> 'completed-save',cacheLease:()=>()=>true,Capacitor:{isNativePlatform:()=>true}});
 try{await (await mod.startLocalSave({id:'file'},context,'file',async()=>({}))).promise;account='b';await assert.rejects(mod.startLocalSave({id:'file'},context,'file',async()=>({})),e=>e.name==='AbortError');}finally{globalThis.window=previous;}
});
