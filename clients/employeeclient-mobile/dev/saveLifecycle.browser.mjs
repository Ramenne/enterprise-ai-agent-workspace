// Production saving code, real local HTTP and real browser OPFS file handles.
// The OS destination picker is substituted; this is not desktop Downloads acceptance.
import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';
const {chromium}=createRequire(import.meta.url)('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=fileURLToPath(new URL('../',import.meta.url)),bytes=Buffer.from('真实下载与保存的固定原件\n'),hash=createHash('sha256').update(bytes).digest('hex');
const bundle=await build({stdin:{contents:`import {prepareBrowserSave} from './src/platform/saveFile.ts';import {fetchDownloadResponse} from './src/native/download-stream.mjs';window.QNSave={prepareBrowserSave,fetchDownloadResponse};`,resolveDir:base},alias:{'@':base+'src'},bundle:true,write:false,format:'iife',platform:'browser'});
const closed=new Set(),report={scope:'actual-Chromium-OPFS-and-local-HTTP;substituted-destination-picker',checks:[],runtimeErrors:[]};
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<script src="/bundle.js"></script>');return;}
 res.on('close',()=>closed.add(path));res.setHeader('content-type','application/octet-stream');
 if(path==='/headers-stall')return;
 if(path==='/body-stall'){res.write(bytes.subarray(0,3));return;}
 res.end(path==='/corrupt'?Buffer.alloc(bytes.length):bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const page=await browser.newPage();page.on('pageerror',e=>report.runtimeErrors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin);
 await page.evaluate(async()=>{const directory=await navigator.storage.getDirectory();window.saveHandle=await directory.getFileHandle('employeeclient-owned-test-file',{create:true});window.showSaveFilePicker=async()=>window.saveHandle;});
 const expected={size:bytes.length,sha256:hash};
 const saved=await page.evaluate(async expected=>{const target=await QNSave.prepareBrowserSave('test');const response=await QNSave.fetchDownloadResponse('/file');return target.saveStream(response.body,expected,()=>true,new AbortController().signal);},expected);
 assert.equal(saved.state,'saved');assert.equal(await page.evaluate(async()=> (await saveHandle.getFile()).text()),bytes.toString());report.checks.push('original bytes verified and committed to an actual OPFS file');
 const bad=await page.evaluate(async expected=>{const target=await QNSave.prepareBrowserSave('test');const response=await QNSave.fetchDownloadResponse('/corrupt');try{await target.saveStream(response.body,expected,()=>true,new AbortController().signal);return 'unexpected success';}catch(e){return e.message;}},expected);
 assert.match(bad,/校验失败/);assert.equal(await page.evaluate(async()=> (await saveHandle.getFile()).text()),bytes.toString());report.checks.push('same-length corruption rejected before commit; previous saved file preserved');
 await page.evaluate(async expected=>{window.activeTarget=await QNSave.prepareBrowserSave('test');const response=await QNSave.fetchDownloadResponse('/body-stall');window.result=activeTarget.saveStream(response.body,expected,()=>true,new AbortController().signal).then(()=> 'saved',e=>e.name);},expected);
 await page.evaluate(()=>activeTarget.cancel());assert.equal(await page.evaluate(()=>result),'AbortError');assert.equal(await page.evaluate(async()=> (await saveHandle.getFile()).text()),bytes.toString());report.checks.push('cancel interrupts stalled HTTP reader and aborts uncommitted OPFS replacement');
 assert.equal(await page.evaluate(async()=>{try{await QNSave.fetchDownloadResponse('/headers-stall',{idleMs:100});return 'saved';}catch(e){return e.name;}}),'TimeoutError');report.checks.push('stalled HTTP headers time out without a saved receipt');
 await new Promise(resolve=>setTimeout(resolve,30));assert.ok(closed.has('/headers-stall'));assert.ok(closed.has('/body-stall'));assert.deepEqual(report.runtimeErrors,[]);
 console.log(JSON.stringify(report));
}finally{
 const output=process.env.QN_SAVE_TEST_OUTPUT;if(output){await mkdir(output,{recursive:true});await writeFile(output+'/browser-report.json',JSON.stringify(report,null,2));}
 await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
