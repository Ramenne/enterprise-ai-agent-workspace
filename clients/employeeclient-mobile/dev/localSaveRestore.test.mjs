import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

test('Android rechecks a saved file after reopening and allows saving again if the system copy was removed',async()=>{
 const source=await readFile(new URL('../src/files/localSave.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}})
  .outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'');
 const actions=[];
 const media=()=>({saved:false,localName:'report.txt',save:async()=>{actions.push('system-save');return {state:'saved',message:'已保存到下载/员工客户端'};},dispose(){}});
 const deps={findAttachment:async()=>media(),acquisitionKey:()=> 'same-file',startAcquisition:()=>({promise:Promise.resolve()}),
  prepareBrowserSave(){throw Error('native save must not open browser picker');},Capacitor:{isNativePlatform:()=>true},cacheLease:()=>()=>true,
  captureApiLease:()=>({account:'a',valid:()=>true}),localStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
 const key='__qn_local_save_'+Math.random().toString(36).slice(2),oldWindow=globalThis.window;
 globalThis[key]=deps;globalThis.window=new EventTarget();
 try{
  const mod=await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+code).toString('base64'));
  const a={id:'report',name:'report.txt',mime:'text/plain',kind:'file'},ctx={account:'a',computer:'mac',provider:'codex',thread:'task'};
  await (await mod.startLocalSave(a,ctx,a.name,async()=>a)).promise;
  assert.equal(mod.getLocalSave(a,ctx)?.state,'complete');
  assert.equal(mod.reconcileLocalSave(a,ctx,{saved:false}),undefined);
  assert.equal(mod.getLocalSave(a,ctx),undefined);
  await (await mod.startLocalSave(a,ctx,a.name,async()=>a)).promise;
  assert.deepEqual(actions,['system-save','system-save']);
  assert.equal(mod.reconcileLocalSave(a,ctx,{saved:true})?.state,'complete');
 }finally{globalThis.window=oldWindow;delete globalThis[key];}
});
