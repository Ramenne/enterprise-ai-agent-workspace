import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {startMediaForwardPreview} from './mediaForward.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const server=startMediaForwardPreview(5259);await new Promise(r=>server.listening?r():server.once('listening',r));
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const checks=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:780},serviceWorkers:'block'});page.setDefaultTimeout(12000);
 await page.goto('http://127.0.0.1:5259/simulation/sim-a');await page.locator('.message-input').waitFor();await page.waitForTimeout(300);
 let failed=0,recovered=0;
 await page.route('**/business/v1/messages?**',async route=>{
  if(route.request().method()!=='GET')return route.continue();
  if(failed===0){failed++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error_code:'upstream_unavailable',message:'正在重新连接'})});}
  recovered++;return route.continue();
 });
 await page.reload();await page.locator('.message-input').waitFor();
 await page.waitForFunction(()=>!document.querySelector('.chat-error'));await page.waitForTimeout(500);
 assert.equal(failed,1);assert.equal(await page.locator('.chat-error').count(),0);assert.equal(await page.locator('.state-bar').count(),0);
 await page.waitForTimeout(2300);assert.ok(recovered>0);assert.equal(await page.locator('.chat-error').count(),0);
 checks.push('actual PWA chat reload with HTTP503 retains chat without red reconnect error; automatically retries successfully');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync('/Users/developer/Downloads/超强学习/research/employeeclient-chain-research-20261015/conversation-reconnect-browser.json',JSON.stringify({checks},null,2));console.log(checks);}
