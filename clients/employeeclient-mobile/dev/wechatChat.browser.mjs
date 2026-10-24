// Exercises the built product against the loopback-only simulated runtime.
// This is browser/layout evidence, not real-account or Android acceptance.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {startWechatChatPreview} from './wechatChat.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=Number(process.env.QN_CHAT_TEST_PORT||5246),origin='http://127.0.0.1:'+port;
const preview=startWechatChatPreview(port);
await new Promise(resolve=>preview.listening?resolve():preview.once('listening',resolve));
const output=process.env.QN_CHAT_PREVIEW_OUTPUT||'/tmp/employeeclient-wechat-chat-v1';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const report={scope:'local-simulated-members-and-memory-database',checks:[],runtimeErrors:[],blockedOrigins:[]};
try {
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.runtimeErrors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();report.blockedOrigins.push(url.origin);return route.abort();});
 await page.goto(origin+'/simulation/sim-a');await page.locator('.chat-page').waitFor();
 for(const width of [320,390,430,1024]){
  await page.setViewportSize({width,height:844});
  const geometry=await page.locator('.chat-page').evaluate(el=>({avatar:el.querySelector('.chat-avatar')?.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth+1,headingOverflow:el.querySelector('.chat-heading').scrollWidth>el.querySelector('.chat-heading').clientWidth+1}));
  assert.ok(geometry.avatar<=44&&!geometry.overflow&&!geometry.headingOverflow,JSON.stringify(geometry));
 }
 report.checks.push('chat avatars and heading remain bounded on mobile and desktop');
 await page.evaluate(()=>location.hash='/messages');await page.locator('.conversation-row').first().waitFor();
 for(const width of [320,390,430,1024]){
  await page.setViewportSize({width,height:844});
  const geometry=await page.locator('.conversation-row').first().evaluate(el=>({row:el.getBoundingClientRect().height,avatar:el.querySelector('.conversation-avatar').getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth+1}));
  assert.ok(!geometry.overflow&&geometry.row>=64&&geometry.row<=80&&geometry.avatar<=52,JSON.stringify(geometry));
 }
 report.checks.push('conversation rows keep mobile proportions on narrow and desktop widths');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/conversations-390.png'});
 await page.locator('.conversation-row').filter({hasText:'文件传输助手'}).click();await page.locator('.member-count').getByText('文件传输助手',{exact:true}).waitFor();
 const input=page.getByRole('textbox',{name:'私聊消息输入'});await input.waitFor({state:'visible'});
 const text='本地验证：回执丢失后按原提交键重试。 '+new Date().toLocaleTimeString();let lose=true,attempts=[];
 await page.route('**/business/v1/messages',async route=>{
  const request=route.request();if(request.method()!=='POST')return route.continue();
  attempts.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});
  if(lose){lose=false;const receipt=await route.fetch();assert.ok(receipt.ok());return route.abort('connectionfailed');}
  return route.continue();
 });
 await input.fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();
 const retry=page.getByRole('button',{name:'重试发送这条消息'});await retry.waitFor();
 assert.equal(await retry.locator('span').innerText(),'!');assert.doesNotMatch(await page.locator('.send-failure').innerText(),/business_transport_failed/);await retry.scrollIntoViewIfNeeded();await page.screenshot({path:output+'/retry-390.png'});
 await retry.click();await page.locator('.pending-message').waitFor({state:'hidden'});
 assert.equal(attempts.length,2);assert.ok(attempts[0].key);assert.deepEqual(attempts[0],attempts[1]);
 assert.equal(await page.locator('.chat-message:not(.pending-message) .chat-bubble p').filter({hasText:text}).count(),1);
 report.checks.push('lost response shows retry; same body/key yields one committed message');
 assert.equal(await page.locator('.chat-meta').count(),0);
 const original=page.locator('.chat-bubble').filter({hasText:text});await original.scrollIntoViewIfNeeded();
 for(const width of [320,390,430]){
  await page.setViewportSize({width,height:844});await original.scrollIntoViewIfNeeded();await page.waitForTimeout(150);await original.dispatchEvent('contextmenu');
  const menu=page.getByRole('dialog',{name:'消息操作'});await menu.waitFor();await page.waitForTimeout(100);assert.ok(await menu.isVisible());
  const box=await menu.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=844,JSON.stringify(box));
  assert.equal(await menu.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(51, 51, 51)');
  if(width===390)await page.screenshot({path:output+'/message-menu-390.png'});
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
 }
 report.checks.push('dark message actions stay inside 320/390/430 viewports and Escape dismisses');
 await page.setViewportSize({width:390,height:844});await original.dispatchEvent('contextmenu');await page.getByRole('button',{name:'引用回复',exact:true}).click();
 await page.locator('.chat-quote').waitFor();await input.fill('这是本地引用回复');await page.getByRole('button',{name:'发送',exact:true}).click();
 const quote=page.getByRole('button',{name:'查看引用的原消息'});await quote.waitFor();await quote.click();await page.locator('.highlighted').waitFor();
 assert.equal(await page.locator('.highlighted .chat-bubble p').innerText(),text);
 report.checks.push('quotation locates and highlights its original message');
 await original.dispatchEvent('contextmenu');await page.getByRole('button',{name:'撤回',exact:true}).click();
 await original.waitFor({state:'hidden'});await quote.getByText(/引用内容已撤回/).waitFor();await quote.click();
 await page.getByText('引用内容已撤回',{exact:true}).waitFor();await page.screenshot({path:output+'/quoted-recall-390.png'});
 report.checks.push('recalled original is not displayed; quotation reports its unavailable state');
 await input.fill('第一行\n第二行\n第三行');
 const height=await input.evaluate(el=>el.getBoundingClientRect().height);assert.ok(height>40&&height<=112,String(height));
 await page.getByRole('button',{name:'切换语音输入'}).click();await page.getByRole('button',{name:'切换文字输入'}).click();assert.equal(await input.inputValue(),'第一行\n第二行\n第三行');
 report.checks.push('multiline input resizes and voice/text switching preserves text');
 await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').first().waitFor();
 await page.locator('.conversation-row').first().dispatchEvent('contextmenu');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 report.checks.push('return to conversations and close row actions');
 assert.deepEqual(report.runtimeErrors,[]);
 console.log(JSON.stringify(report));
} finally {writeFileSync(output+'/browser-report.json',JSON.stringify(report,null,2));await browser.close();preview.closeAllConnections();await new Promise(resolve=>preview.close(resolve));}
