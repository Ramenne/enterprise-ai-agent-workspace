// Real local HTTP/repository and built Vue UI; no production or phone evidence.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const {chromium}=createRequire(import.meta.url)('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=Number(process.env.QN_CONTEXT_TEST_PORT||5299),origin='http://127.0.0.1:'+port;
const {server,original}=startQuoteReturnPreview(port);
await new Promise(r=>server.listening?r():server.once('listening',r));
const output=process.env.QN_CONTEXT_TEST_OUTPUT||'/tmp/employeeclient-context-current';mkdirSync(output,{recursive:true});
const report={scope:'local-simulated-members-memory-repository',checks:[],runtimeErrors:[],blockedOrigins:[]};
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
async function pageReady(){
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>report.runtimeErrors.push(e.message));
 await page.route('**/*',r=>{const url=new URL(r.request().url());if(url.origin===origin)return r.continue();report.blockedOrigins.push(url.origin);return r.abort();});
 await page.goto(origin+'/simulation/sim-a');await page.waitForFunction(()=>document.querySelector('.message-input')&&!document.querySelector('.message-input').disabled);
 return page;
}
const quote=p=>p.locator('.chat-message').filter({has:p.locator('.chat-bubble p').filter({hasText:'引用返回验证'})}).getByRole('button',{name:'查看引用的原消息'});
async function point(p){return p.locator('.chat-stream').evaluate(e=>{const top=e.getBoundingClientRect().top,row=[...e.querySelectorAll('[data-reading-id]')].find(r=>r.getBoundingClientRect().bottom>top);return {id:row?.dataset.readingId,offset:row?.getBoundingClientRect().top-top};});}
async function samePoint(p,before){const after=await point(p);assert.equal(after.id,before.id);assert.ok(Math.abs(after.offset-before.offset)<3,JSON.stringify({before,after}));}
async function search(p,text){await p.getByRole('button',{name:'更多群聊入口'}).click();await p.locator('.chat-search-panel input').fill(text);await p.locator('.chat-search-panel form').evaluate(e=>e.requestSubmit());await p.locator('.chat-query-summary').waitFor();await quote(p).waitFor();}
let releasePending;
try{
 const p=await pageReady();await p.locator('.message-input').fill('引用定位期间保留草稿');await quote(p).scrollIntoViewIfNeeded();await p.waitForTimeout(180);const before=await point(p);
 await quote(p).dispatchEvent('contextmenu');await p.getByRole('dialog',{name:'引用原话操作'}).waitFor();await p.getByRole('button',{name:'定位到聊天位置',exact:true}).click();await p.waitForFunction(id=>document.querySelector('.highlighted')?.dataset.messageId===id,original.id);
 await p.screenshot({path:output+'/quote-menu-original.png'});await p.locator('.chat-back').click();await p.locator('.quote-inspection').waitFor({state:'hidden'});await p.waitForTimeout(180);await samePoint(p,before);assert.equal(await p.locator('.message-input').inputValue(),'引用定位期间保留草稿');assert.equal(new URL(p.url()).hash,'#/chat');report.checks.push('quoted-original menu locates actual original and hierarchical back restores row/offset/draft');
 const hidden=p.locator('.chat-message').filter({has:p.locator('.chat-bubble p').filter({hasText:'不可见引用验证'})}).getByRole('button',{name:'查看引用的原消息'});await hidden.click();await p.getByText('原消息不存在或暂不可见',{exact:true}).waitFor();await p.locator('.quote-inspection').waitFor({state:'hidden'});report.checks.push('hidden original returns an explicit unavailable result without leaving a false context view');
 await quote(p).scrollIntoViewIfNeeded();await p.waitForTimeout(180);const cancelPoint=await point(p);let started;const held=new Promise(r=>started=r),gate=new Promise(r=>releasePending=r);await p.route('**/business/v1/messages?*',async r=>{if(new URL(r.request().url()).searchParams.has('before')){started();await gate;}try{await r.continue();}catch{}});
 await quote(p).click();await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture did not intercept context request')),5000))]);await p.getByRole('button',{name:'返回刚才的位置'}).click();await p.locator('.quote-inspection').waitFor({state:'hidden'});releasePending();await p.waitForTimeout(350);await samePoint(p,cancelPoint);assert.equal(await p.locator('.highlighted').count(),0);report.checks.push('return cancels pending context pagination; late response cannot replace restored view');assert.deepEqual(report.runtimeErrors,[]);report.completed=true;console.log(JSON.stringify(report));
}finally{releasePending?.();writeFileSync(output+'/browser-report.json',JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
