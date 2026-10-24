import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {startWechatChatPreview} from './wechatChat.preview.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const port=Number(process.env.QN_DRAFT_TEST_PORT||5249),origin='http://127.0.0.1:'+port,server=startWechatChatPreview(port);
await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
const output=process.env.QN_DRAFT_TEST_OUTPUT||'/tmp/employeeclient-drafts-v3';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const report={scope:'local-current-dist-real-IndexedDB-simulated-members-memory-business-database',checks:[],runtimeErrors:[],blocked:[]};
try{
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});page.setDefaultTimeout(8000);
 const observe=async p=>{p.on('pageerror',e=>report.runtimeErrors.push(e.message));await p.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(report.blocked.push(r.request().url()),r.abort()));};await observe(page);
 const waitInput=async(pending=false)=>{const input=page.getByRole('textbox',{name:/群消息|私聊消息输入/});await input.waitFor();if(!pending)await page.waitForFunction(()=>{const el=document.querySelector('.message-input');return el&&!el.disabled});return input;};
 const persisted=async(peer,text)=>page.waitForFunction(async({peer,text})=>{
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('employeeclient-cache');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
   const v=await new Promise(resolve=>{const r=db.transaction('meta').objectStore('meta').get('sim-a:composer:'+peer);r.onsuccess=()=>resolve(r.result?.value)});db.close();return text===null?!v:v?.body===text;
 },{peer,text});
 const list=async()=>{await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await page.locator('.conversation-row').first().waitFor();};
 const open=async title=>{await page.locator('.conversation-row').filter({has:page.getByText(title,{exact:true})}).click();return waitInput();};
 await page.goto(origin+'/simulation/sim-a');let input=await waitInput();
 const source=page.locator('.chat-bubble').filter({hasText:'这条消息引用了工作，点击编号查看。'});await source.scrollIntoViewIfNeeded();await page.waitForTimeout(150);await source.dispatchEvent('contextmenu');await page.getByRole('button',{name:'引用回复',exact:true}).click();
 const group='群里未发的第一行\n第二行保持原样';await input.fill(group);await persisted('',group);await page.reload();input=await waitInput();assert.equal(await input.inputValue(),group);assert.match(await page.locator('.chat-quote').first().innerText(),/这条消息引用了工作/);assert.match(await page.locator('.selected-context').innerText(),/员工客户端查询、工作、消息重构/);
 report.checks.push('reload in the current chat restores exact multiline input, quotation and inherited work association');
 await list();const groupRow=page.locator('.conversation-row').filter({has:page.getByText('公司工作群',{exact:true})});assert.match(await groupRow.innerText(),/\[草稿\].*群里未发的第一行/);
 input=await open('模拟成员 B');const privateText='只给 B 的未发送内容';await input.fill(privateText);await persisted('sim-b',privateText);await list();input=await open('文件传输助手');const helper='留给自己的备忘草稿';await input.fill(helper);await persisted('sim-a',helper);await page.reload();input=await waitInput();assert.equal(await input.inputValue(),helper);await list();
 for(const title of ['公司工作群','模拟成员 B','文件传输助手'])assert.equal(await page.locator('.conversation-row').filter({has:page.getByText(title,{exact:true})}).locator('.draft-label').count(),1);
 await page.screenshot({path:output+'/draft-list-390.png'});input=await open('公司工作群');assert.equal(await input.inputValue(),group);await page.screenshot({path:output+'/draft-quote-restored-390.png'});
 report.checks.push('group, private and file-helper drafts stay separate and the list previews each without sending');
 await input.fill('');await page.getByRole('button',{name:'取消引用',exact:true}).click();await persisted('',null);await page.reload();input=await waitInput();assert.equal(await input.inputValue(),'');assert.equal(await page.locator('.chat-quote').count(),0);await list();assert.equal(await groupRow.locator('.draft-label').count(),0);
 report.checks.push('clearing text and quotation removes the durable draft; reload does not resurrect it');
 input=await open('模拟成员 B');assert.equal(await input.inputValue(),privateText);let lose=true;const attempts=[];
 await page.route('**/business/v1/messages',async route=>{if(route.request().method()!=='POST')return route.continue();const body=route.request().postDataJSON();if(body.body!==privateText)return route.continue();attempts.push({body,key:route.request().headers()['idempotency-key']});if(lose){lose=false;const response=await route.fetch();assert.ok(response.ok());return route.abort('connectionfailed');}return route.continue();});
 await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'重试发送这条消息',exact:true}).waitFor();await persisted('sim-b',privateText);await page.reload();input=await waitInput(true);await page.waitForFunction(text=>document.querySelector('.message-input')?.value===text,privateText);assert.equal(await input.inputValue(),privateText);await page.getByRole('button',{name:'重试发送这条消息',exact:true}).click();await page.locator('.pending-message').waitFor({state:'hidden'});await persisted('sim-b',null);assert.equal(await input.inputValue(),'');assert.deepEqual(attempts[0],attempts[1]);
 await page.reload();input=await waitInput();assert.equal(await input.inputValue(),'');assert.equal(await page.locator('.chat-bubble p').getByText(privateText,{exact:true}).count(),1);await list();assert.equal(await page.locator('.conversation-row').filter({has:page.getByText('模拟成员 B',{exact:true})}).locator('.draft-label').count(),0);
 report.checks.push('response loss keeps the draft and original pending key; retry confirms one message and clears only that peer draft');
 // Same browser storage, different simulated identity: no private composer leaks.
 await page.goto(origin+'/simulation/sim-b');input=await waitInput();assert.equal(await input.inputValue(),'');await list();assert.equal(await page.locator('.draft-label').count(),0);input=await open('模拟成员 A');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('.chat-bubble p').getByText(privateText,{exact:true}).count(),1);
 await page.goto(origin+'/simulation/sim-a');await waitInput();await list();input=await open('文件传输助手');assert.equal(await input.inputValue(),helper);
 report.checks.push('switching identity in the same storage hides A drafts; the receiver has one message and A helper draft remains recoverable');
 for(const width of [320,430]){await page.setViewportSize({width,height:844});await list();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/draft-list-'+width+'.png'});input=await open('文件传输助手');assert.equal(await input.inputValue(),helper);}
 report.checks.push('320/390/430 phone widths keep list previews and restored input within the viewport');
 assert.deepEqual(report.runtimeErrors,[]);assert.deepEqual(report.blocked,[]);console.log(JSON.stringify(report));
}catch(e){report.failure=String(e);for(const p of browser.contexts().flatMap(c=>c.pages()))await p.screenshot({path:output+'/failure.png'}).catch(()=>{});throw e;}finally{writeFileSync(output+'/draft-browser-report.json',JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
