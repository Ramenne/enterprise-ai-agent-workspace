// Real local HTTP/repository and built Vue UI; no production or phone evidence.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const {chromium}=createRequire(import.meta.url)('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=Number(process.env.QN_QUOTE_TEST_PORT||5261),origin='http://127.0.0.1:'+port;
const {server,original}=startQuoteReturnPreview(port);
await new Promise(r=>server.listening?r():server.once('listening',r));
const output=process.env.QN_QUOTE_TEST_OUTPUT||'/tmp/employeeclient-quote-return-v6';mkdirSync(output,{recursive:true});
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
try{
 const p=await pageReady();await p.locator('.message-input').fill('保留的草稿');await quote(p).scrollIntoViewIfNeeded();await p.waitForTimeout(180);const before=await point(p);
 assert.equal(await p.locator(`[data-message-id="${original.id}"]`).count(),0);
 await quote(p).click();await p.locator('.highlighted').waitFor();assert.equal(await p.locator('.highlighted').getAttribute('data-message-id'),original.id);
 await p.screenshot({path:output+'/original-390.png'});await p.getByRole('button',{name:'返回刚才的位置'}).click();await p.locator('.quote-inspection').waitFor({state:'hidden'});await p.waitForTimeout(180);await samePoint(p,before);assert.equal(await p.locator('.message-input').inputValue(),'保留的草稿');
 report.checks.push('cross-page quote loads original then returns stable row/offset and draft');
 const nested=p.locator('.chat-message').filter({has:p.locator('.chat-bubble p').filter({hasText:'嵌套引用验证'})}).getByRole('button',{name:'查看引用的原消息'});
 await nested.scrollIntoViewIfNeeded();await p.waitForTimeout(180);const nestedPoint=await point(p);await nested.click();await p.locator('.highlighted').waitFor();await quote(p).click();await p.waitForFunction(id=>document.querySelector('.highlighted')?.dataset.messageId===id,original.id);
 for(const width of [320,390,430]){await p.setViewportSize({width,height:844});assert.ok(await p.locator('.quote-inspection').evaluate(e=>e.scrollWidth<=e.clientWidth&&document.documentElement.scrollWidth<=innerWidth+1));}await p.setViewportSize({width:390,height:844});
 await p.getByRole('button',{name:'返回刚才的位置'}).click();await p.waitForTimeout(180);await samePoint(p,nestedPoint);report.checks.push('nested quotes retain earliest origin; inspection bar fits 320/390/430');
 const hidden=p.locator('.chat-message').filter({has:p.locator('.chat-bubble p').filter({hasText:'不可见引用验证'})}).getByRole('button',{name:'查看引用的原消息'});assert.ok(await hidden.isDisabled());report.checks.push('hidden original is unavailable and cannot start a jump');
 await search(p,'引用返回验证');let queries=0;p.on('request',r=>{if(r.url().includes('/business/v1/messages?')&&new URL(r.url()).searchParams.has('q'))queries++;});
 await p.waitForTimeout(180);const filteredBefore=await point(p),count=await p.locator('.chat-message').count(),queryBefore=queries;
 await quote(p).click();await p.locator('.highlighted').waitFor();assert.equal(await p.locator('.chat-search').count(),0);
 await p.getByRole('button',{name:'返回查找结果'}).click();await p.locator('.chat-search').waitFor();await p.waitForTimeout(180);assert.equal(await p.locator('.chat-search input').inputValue(),'引用返回验证');assert.equal(await p.locator('.chat-message').count(),count);await samePoint(p,filteredBefore);assert.equal(queries,queryBefore);
 await p.screenshot({path:output+'/search-return-390.png'});report.checks.push('keyword query/results/anchor survive inspection without resetting query');
 await quote(p).click();await p.locator('.quote-inspection').waitFor();await p.getByRole('button',{name:'更多群聊入口'}).click();await p.getByRole('button',{name:'日期',exact:true}).click();await p.getByRole('dialog',{name:'按日期查找'}).waitFor();await p.keyboard.press('Escape');await p.getByRole('dialog',{name:'按日期查找'}).waitFor({state:'hidden'});assert.ok(await p.locator('.quote-inspection').isVisible());await p.keyboard.press('Escape');await p.locator('.chat-search').waitFor();
 report.checks.push('Escape closes newer date modal before returning from quote');
 await p.getByRole('button',{name:'清除筛选'}).click();await p.getByRole('button',{name:'更多群聊入口'}).click();await p.getByRole('button',{name:'日期',exact:true}).click();
 const today=new Date(),date=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');await p.getByRole('button',{name:date,exact:true}).click();await quote(p).scrollIntoViewIfNeeded();await p.waitForTimeout(180);const datePoint=await point(p);
 await quote(p).click();await p.locator('.highlighted').waitFor();await p.getByRole('button',{name:'返回查找结果'}).click();await p.locator('.chat-query-summary').waitFor();assert.match(await p.locator('.chat-query-summary').innerText(),new RegExp(date));await p.waitForTimeout(180);await samePoint(p,datePoint);
 report.checks.push('date view returns from original outside date range');
 await quote(p).click();await p.locator('.highlighted').waitFor();await p.getByRole('button',{name:/回到最新/}).click();await p.locator('.quote-inspection').waitFor({state:'hidden'});assert.equal(await p.locator('.chat-query-summary').count(),0);
 report.checks.push('explicit latest clears inspection and filter');
 const recalled=p.locator('.chat-message').filter({has:p.locator('.chat-bubble p').filter({hasText:'撤回引用验证'})}).getByRole('button',{name:'查看引用的原消息'});
 await recalled.scrollIntoViewIfNeeded();await p.waitForTimeout(180);const recallPoint=await point(p);await recalled.click();await p.getByText('引用内容已撤回',{exact:true}).waitFor();assert.equal(await p.locator('.quote-inspection').count(),0);await p.waitForTimeout(180);await samePoint(p,recallPoint);
 report.checks.push('recalled quote auto returns without leaving inspection active');
 // Hold an actual older page response while user returns. Use a fresh cache.
 const c=await pageReady();await quote(c).scrollIntoViewIfNeeded();await c.waitForTimeout(180);const cancelPoint=await point(c);let release,heldResolve;const held=new Promise(r=>heldResolve=r),gate=new Promise(r=>release=r);
 await c.route('**/business/v1/messages?*',async r=>{const url=new URL(r.request().url());if(url.searchParams.has('before')){heldResolve();await gate;}await r.continue();});
 await quote(c).click();await held;await c.getByRole('button',{name:'返回刚才的位置'}).click();await c.locator('.quote-inspection').waitFor({state:'hidden'});release();await c.waitForTimeout(650);await samePoint(c,cancelPoint);assert.equal(await c.locator('.highlighted').count(),0);
 report.checks.push('cancel pending pagination keeps origin after delayed response; no stale highlight');
 const g=await pageReady();await quote(g).scrollIntoViewIfNeeded();let releaseGesture,heldGestureResolve;const heldGesture=new Promise(r=>heldGestureResolve=r),gestureGate=new Promise(r=>releaseGesture=r);
 await g.route('**/business/v1/messages?*',async r=>{if(new URL(r.request().url()).searchParams.has('before')){heldGestureResolve();await gestureGate;}await r.continue();});
 await quote(g).click();await heldGesture;await g.getByRole('button',{name:'返回刚才的位置'}).click();await g.locator('.quote-inspection').waitFor({state:'hidden'});await g.locator('.chat-stream').dispatchEvent('wheel',{deltaY:-120});await g.locator('.chat-stream').evaluate(e=>e.scrollTop-=160);await g.waitForTimeout(180);const gesturePoint=await point(g);releaseGesture();await g.waitForTimeout(650);await samePoint(g,gesturePoint);report.checks.push('user scrolling after cancellation owns position when old page arrives');
 const s=await pageReady();await quote(s).scrollIntoViewIfNeeded();let releaseSwitch,heldSwitchResolve;const heldSwitch=new Promise(r=>heldSwitchResolve=r),switchGate=new Promise(r=>releaseSwitch=r);
 await s.route('**/business/v1/messages?*',async r=>{if(new URL(r.request().url()).searchParams.has('before')){heldSwitchResolve();await switchGate;}await r.continue();});
 await quote(s).click();await heldSwitch;await s.getByRole('button',{name:'返回会话列表'}).click();await s.locator('.conversation-row').filter({hasText:'文件传输助手'}).click();await s.getByRole('textbox',{name:'私聊消息输入'}).waitFor();releaseSwitch();await s.waitForTimeout(650);assert.equal(await s.locator('.quote-inspection').count(),0);assert.equal(await s.locator('.highlighted').count(),0);assert.equal(await s.locator(`[data-message-id="${original.id}"]`).count(),0);
 report.checks.push('switch conversation during delayed lookup cannot restore/highlight old conversation');
 assert.deepEqual(report.runtimeErrors,[]);console.log(JSON.stringify(report));
}finally{writeFileSync(output+'/browser-report.json',JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
