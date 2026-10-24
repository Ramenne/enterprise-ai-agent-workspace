import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {startWechatChatPreview} from './wechatChat.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=Number(process.env.QN_FORWARD_TEST_PORT||5248),origin='http://127.0.0.1:'+port,server=startWechatChatPreview(port);
await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
const output=process.env.QN_FORWARD_TEST_OUTPUT||'/tmp/employeeclient-forward-v2';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const report={scope:'simulated-members-and-memory-database',checks:[],runtimeErrors:[],blocked:[]};
try{
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});page.setDefaultTimeout(8000);
 const observe=async p=>{p.on('pageerror',e=>report.runtimeErrors.push(e.message));await p.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(report.blocked.push(route.request().url()),route.abort()));};await observe(page);
 await page.goto(origin+'/simulation/sim-a');await page.locator('.chat-page').waitFor();
 const input=page.locator('textarea[aria-label="群消息"]'),first='本地转发验证：第一条文字',second='本地转发验证：第二条文字';
 for(const text of [first,second]){await input.fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.pending-message').waitFor({state:'hidden'});await page.locator('.chat-bubble p').getByText(text,{exact:true}).waitFor();}
 const draft='保留这段未发送的输入';await input.fill(draft);
 const firstBubble=page.locator('.chat-bubble').filter({hasText:first});await firstBubble.scrollIntoViewIfNeeded();await page.waitForTimeout(100);await firstBubble.dispatchEvent('contextmenu');
 await page.getByRole('button',{name:'多选消息',exact:true}).click();
 assert.match(await page.locator('.chat-selection-heading').innerText(),/已选择 1 条/);
 await page.getByRole('button',{name:'选择消息：'+second,exact:true}).click();assert.match(await page.locator('.chat-selection-heading').innerText(),/已选择 2 条/);
 await page.screenshot({path:output+'/multi-select-390.png'});assert.equal(await input.inputValue(),draft);assert.equal(await input.isVisible(),false);
 await page.getByRole('button',{name:'逐条转发（2）',exact:true}).click();const dialog=page.getByRole('dialog',{name:'转发给'});await dialog.waitFor();
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
 await page.screenshot({path:output+'/forward-picker-unselected-390.png'});await dialog.getByRole('button',{name:'模拟成员 B',exact:true}).click();await page.screenshot({path:output+'/forward-picker-390.png'});
 report.checks.push('inline text selection and recipient confirmation preserve the source composer');
 const attempts=[];let lose=true;
 await page.route('**/business/v1/messages',async route=>{
  const request=route.request();if(request.method()!=='POST'||request.postDataJSON().recipient_username!=='sim-b')return route.continue();
  const body=request.postDataJSON();attempts.push({body,key:request.headers()['idempotency-key']});
  if(body.body===second&&lose){lose=false;const response=await route.fetch();assert.ok(response.ok());return route.abort('connectionfailed');}
  return route.continue();
 });
 await dialog.getByRole('button',{name:'发送',exact:true}).click();await dialog.getByRole('alert').waitFor();
 assert.match(await dialog.getByRole('alert').innerText(),/保留|连接|重试/);await page.screenshot({path:output+'/forward-partial-failure-390.png'});
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'');await page.keyboard.press('Escape');await page.locator('.chat-selection-heading').waitFor({state:'hidden'});assert.equal(await input.inputValue(),draft);
 await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').first().waitFor();
 await page.locator('.conversation-row').filter({has:page.getByText('模拟成员 B',{exact:true})}).click();await page.getByRole('textbox',{name:'私聊消息输入'}).waitFor();
 await page.reload();await page.getByRole('textbox',{name:'私聊消息输入'}).waitFor();
 await page.getByRole('button',{name:'继续转发',exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByRole('textbox',{name:'搜索转发联系人'}).count(),0);assert.match(await dialog.locator('.forward-recovery').innerText(),/模拟成员 B/);
 await dialog.getByRole('button',{name:'继续转发',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(attempts.length,4);assert.deepEqual(attempts[0],attempts[2]);assert.deepEqual(attempts[1],attempts[3]);assert.equal(await page.getByRole('button',{name:'继续转发',exact:true}).count(),0);
 report.checks.push('partial response loss survives page reload and retries the original recipient/body/keys');
 const receiver=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});receiver.setDefaultTimeout(8000);await observe(receiver);await receiver.goto(origin+'/simulation/sim-b');await receiver.locator('.chat-page').waitFor();
 await receiver.getByRole('button',{name:'返回会话列表',exact:true}).click();await receiver.locator('.conversation-row').filter({has:receiver.getByText('模拟成员 A',{exact:true})}).click();await receiver.getByRole('textbox',{name:'私聊消息输入'}).waitFor();
 for(const text of [first,second]){await receiver.locator('.chat-bubble p').getByText(text,{exact:true}).waitFor();assert.equal(await receiver.locator('.chat-bubble p').getByText(text,{exact:true}).count(),1);}
 assert.equal(await receiver.getByRole('button',{name:'继续转发',exact:true}).count(),0);await receiver.screenshot({path:output+'/forward-receiver-390.png'});
 report.checks.push('the second isolated member receives exactly one copy of each message and no sender recovery intent');
 await page.getByRole('button',{name:'查找聊天记录',exact:true}).click();const search=page.getByRole('dialog',{name:'查找聊天记录'});await search.waitFor();
 assert.equal(await search.getByRole('button',{name:'群成员',exact:true}).count(),0);assert.equal(await search.getByRole('button',{name:'群公告',exact:true}).count(),0);assert.equal(await search.getByRole('button',{name:'日期',exact:true}).count(),1);
 await search.getByRole('searchbox',{name:'搜索聊天记录'}).fill(first);await search.getByRole('searchbox',{name:'搜索聊天记录'}).press('Enter');await search.waitFor({state:'hidden'});
 await page.waitForFunction(text=>[...document.querySelectorAll('.chat-bubble p')].some(el=>el.textContent===text),first);assert.equal(await page.locator('.chat-message').count(),1);
 await page.screenshot({path:output+'/private-search-390.png'});await page.getByRole('button',{name:'清除筛选',exact:true}).click();await page.locator('.chat-bubble p').getByText(second,{exact:true}).waitFor();
 report.checks.push('private history search stays in the current peer and can clear its filter');
 await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').filter({hasText:'文件传输助手'}).click();await page.getByRole('button',{name:'查找聊天记录',exact:true}).click();await search.waitFor();await page.keyboard.press('Escape');await search.waitFor({state:'hidden'});
 report.checks.push('file helper exposes history search with an explicit cancel/Escape path');
 await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').filter({has:page.getByText('模拟成员 B',{exact:true})}).click();
 const single=page.locator('.chat-bubble').filter({hasText:first});await single.waitFor();await single.scrollIntoViewIfNeeded();await page.waitForTimeout(100);await single.dispatchEvent('contextmenu');await page.getByRole('button',{name:'转发消息',exact:true}).click();await dialog.waitFor();
 await dialog.getByRole('button',{name:'文件传输助手',exact:true}).click();await dialog.getByRole('button',{name:'发送',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').filter({has:page.getByText('文件传输助手',{exact:true})}).click();await page.locator('.chat-bubble p').getByText(first,{exact:true}).waitFor();assert.equal(await page.locator('.chat-bubble p').getByText(first,{exact:true}).count(),1);
 report.checks.push('one private text forwards to the owner-only file helper through the same confirmed pipeline');
 await page.getByRole('button',{name:'查找聊天记录',exact:true}).click();await search.waitFor();await search.getByRole('button',{name:'日期',exact:true}).click();const calendar=page.getByRole('dialog',{name:'按日期查找'});await calendar.waitFor();
 const today=await page.evaluate(()=>{const date=new Date();return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')});await calendar.getByRole('button',{name:today,exact:true}).click();await calendar.waitFor({state:'hidden'});await page.getByRole('button',{name:'清除筛选',exact:true}).waitFor();await page.getByRole('button',{name:'清除筛选',exact:true}).click();
 report.checks.push('file helper date search uses the existing calendar and has a clear-filter exit');

 assert.deepEqual(report.runtimeErrors,[]);assert.deepEqual(report.blocked,[]);console.log(JSON.stringify(report));
}finally{writeFileSync(output+'/forward-browser-report.json',JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
