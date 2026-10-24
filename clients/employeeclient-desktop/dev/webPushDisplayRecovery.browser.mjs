import assert from 'node:assert/strict';import {build} from 'esbuild';import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';import {startMediaForwardPreview} from './mediaForward.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const compiled=await build({entryPoints:['src/platform/webPushState.ts'],bundle:true,write:false,format:'esm'}),moduleUrl='data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64');
const server=startMediaForwardPreview(5261);await new Promise(r=>server.listening?r():server.once('listening',r));const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5261/health');
 const result=await page.evaluate(async url=>{
  const p=await import(url),shown=[],hidden=[],message={id:'notice',recipient_username:'a',installation_id:'device-a',update_version:1,kind:'chat_message',priority:'normal'};
  await p.setPushIdentity({account:'a',installationId:'device-a'});const show=async n=>shown.push(n.id),hide=async tag=>hidden.push(tag);
  await p.receiveWebPush(message,show);await p.retireWebPush([message],hide);await p.receiveWebPush(message,show);
  await p.retireWebPush([{...message,recipient_username:'b',installation_id:'device-b'}],hide);
  await p.receiveWebPush({...message,id:'next'},show);
  const identity={account:'a',installationId:'device-a'},newer={endpoint:'synthetic-newer'};
  await p.savePushRenewal({identity,subscription:newer});
  const staleSaved=await p.savePushRenewal({identity,subscription:{endpoint:'synthetic-late'}},undefined,()=>true,true);
  const retained=(await p.readPendingPushRenewal()).subscription.endpoint;
  const canceled=await p.savePushRenewal({identity},undefined,()=>false);
  return {shown,hidden,staleSaved,retained,canceled};
 },moduleUrl);
 assert.deepEqual(result.shown,['notice','next']);assert.equal(result.hidden.length,1);assert.ok(result.hidden[0].includes('notice'));assert.equal(result.staleSaved,false);assert.equal(result.retained,'synthetic-newer');assert.equal(result.canceled,false);
 writeFileSync('/Users/developer/Downloads/超强学习/research/employeeclient-chain-research-20261015/ui-review/v131-push-journal-result.json',JSON.stringify({checks:['real browser IndexedDB: read retirement closes matching tag, suppresses late duplicate, cannot retire another account, allows new notification'],result},null,2));console.log(result);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
