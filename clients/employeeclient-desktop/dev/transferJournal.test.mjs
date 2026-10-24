import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import ts from 'typescript';
const digestBuild=await build({entryPoints:['src/files/uploadReceipts.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {fileDigest}=await import('data:text/javascript;base64,'+Buffer.from(digestBuild.outputFiles[0].text).toString('base64'));
const source=await readFile(new URL('../src/files/transferJournal.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
const {prepareTransfer,verifyTransferSource,validate}=new Function('fileDigest',code+';return {prepareTransfer,verifyTransferSource,validate};')(fileDigest);
const file=bytes=>new File([bytes],'original.bin',{type:'application/octet-stream',lastModified:42});
test('large reselected file is fully hashed, preserves original presentation and rejects a changed middle',async()=>{
 const bytes=new Uint8Array(9*1024*1024).fill(7),original=file(bytes),record=await prepareTransfer('a','b','key',{body:'',attachment_ids:[]},original,'file',undefined,false,()=>{},()=>{});
 assert.equal(record.source,undefined);const wrong=bytes.slice();wrong[wrong.length/2]=8;
 await assert.rejects(verifyTransferSource(record,new File([wrong],'same-edges.bin'),()=>{}),/与原待发内容不一致/);
 const verified=await verifyTransferSource(record,new File([bytes],'copy.bin'),()=>{});assert.equal(verified.name,'original.bin');assert.equal(verified.lastModified,42);assert.equal(verified.type,'application/octet-stream');
});
test('unconfirmed recovery cannot contain uploaded attachment or a completed receipt',async()=>{
 const r=await prepareTransfer('a','','key',{body:'',attachment_ids:[]},file(new Uint8Array([1])),'file',undefined,true,()=>{},()=>{});
 assert.equal(validate({...r,sendConfirmed:false}).sendConfirmed,false);assert.equal(validate(r),r,'old records without the optional flag remain compatible');
 assert.throws(()=>validate({...r,sendConfirmed:false,attachment:{id:'fixed'}}),/确认状态/);assert.throws(()=>validate({...r,sendConfirmed:'yes'}),/确认状态/);
});
