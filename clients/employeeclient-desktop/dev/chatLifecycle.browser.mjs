import {designCss} from './designCss.mjs';
// Actual Vue component/store lifecycle; transport/session are test fixtures, no production writes.
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {descriptor}=parse(readFileSync('src/ui/views/ChatView.vue','utf8'));
const component=compileScript(descriptor,{id:'chat-lifecycle',inlineTemplate:true}).content;
const {descriptor:iconDescriptor}=parse(readFileSync('src/ui/components/AppIcon.vue','utf8'));
const iconComponent=compileScript(iconDescriptor,{id:'chat-icon',inlineTemplate:true}).content;
const {descriptor:inputDescriptor}=parse(readFileSync('src/ui/components/MessageInput.vue','utf8'));
const inputComponent=compileScript(inputDescriptor,{id:'chat-input',inlineTemplate:true}).content;
const mocks={
 '@/chat/readVisible':`export const useVisibleChatReads=()=>{};`,
 'vue-router':`import {reactive} from 'vue';export const route=reactive({query:{}});window.testRoute=route;export const useRoute=()=>route;export const useRouter=()=>({push:async()=>{},replace:async()=>{}});`,
 '@/store/data':`export const useDataStore=()=>({captureLease:()=>({account:'test',valid:()=>window.testSession?.user?.username==='test'})});`,
 '@/session/store':`import {reactive} from 'vue';export const session=reactive({status:'offline',isAuthenticated:true,user:{username:'test'},link:{state:'backoff',networkUp:true}});window.testSession=session;export const useSessionStore=()=>session;`,
 '@/api/endpoints':`export const communication={members:async()=>({members:[]}),messages:async()=>{window.requests++;return {messages:[{id:'m1',seq:1,body:'existing history',author_username:'test',author_name:'Test',mention_usernames:[],attachments:[],created_at:1}],next_cursor:1,has_more:false,has_more_old:false}},send:async()=>{throw Error('not used')}};`,
 '@/api/client':`export const isOnline=()=>true;export class ApiError extends Error {} export const newIdempotencyKey=()=> 'test';export const apiConfig={getToken:()=> 'test'};export const apiRequest=async()=>{throw Error('unexpected API request in chat lifecycle fixture')};`,
 '@/session/db':`export const metaGet=async()=>null;export const metaSet=async()=>{};`,
 '@/store/ui':`export const useUiStore=()=>({openOverlay(){},toast(){},confirm:async()=>true});`,
 '@/platform/chatEvents':`export const onChatWake=()=>()=>{};`,
 '@/ui/format':`export const ago=()=>'';`
};
const code=`import {createApp,h,ref,nextTick,watch} from 'vue';import {createPinia} from 'pinia';import Chat from 'test-chat';import {useChatViewport} from '@/platform/chatViewport';import {useChatStore} from '@/store/chat';window.requests=0;const revision=ref(0);window.remount=async()=>{revision.value++;await nextTick()};createApp({setup(){window.chat=useChatStore();watch(()=>window.testSession.user?.username||'',a=>{void window.chat.setAccount(a)},{immediate:true,flush:'sync'});const viewport=useChatViewport();return ()=>h('div',{class:['shell','shell-chat',viewport.keyboard.value?'chat-keyboard':''],style:{height:viewport.height.value+'px',top:viewport.top.value+'px'}},[h('div',{class:'workspace'},[h('div',{class:'topbar'},'员工客户端'),h('main',{class:'content'},[h(Chat,{key:revision.value})])]),h('nav',{class:'bottom-nav'},[h('button',{class:'active'},'群聊'),h('button','工作'),h('button','文件'),h('button','个人')])])}}).use(createPinia()).component('RouterLink',{template:'<a><slot/></a>'}).mount('#app');`;
const result=await build({stdin:{contents:code,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^(test-chat|vue-router|@\/)/},a=>a.path==='test-chat'||mocks[a.path]||a.path.endsWith('.vue')?{path:a.path,namespace:'fixture'}:{path:resolve('src',a.path.slice(2)+'.ts')});b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='test-chat'?component:a.path==='@/ui/components/AppIcon.vue'?iconComponent:a.path==='@/ui/components/MessageInput.vue'?inputComponent:mocks[a.path]||`export default {template:'<span></span>'}`,loader:'ts',resolveDir:process.cwd()}));}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});await page.setContent('<div id="app"></div>');await page.addStyleTag({content:descriptor.styles.map(s=>s.content).join('\n')+'\n'+designCss});await page.addScriptTag({content:result.outputFiles[0].text});await page.getByText('existing history',{exact:true}).waitFor();
 await page.evaluate(()=>window.remount());await page.waitForTimeout(50);
 const state=await page.evaluate(()=>({account:window.chat.account,initialized:window.chat.initialized,loading:window.chat.loading,requests:window.requests,text:document.body.innerText}));
 if(process.argv.includes('--expect-broken')) {if(state.account!==''||!state.text.includes('正在连接工作群'))throw Error('did not reproduce');console.log('REPRODUCED: keyed view replacement cleared account after new view setup; permanent connecting, no request:',JSON.stringify(state));}
 else {if(state.account!=='test'||!state.initialized||!state.text.includes('existing history'))throw Error(JSON.stringify(state));for (const size of [{width:320,height:568},{width:390,height:844},{width:430,height:932}]) {await page.setViewportSize(size);await page.waitForTimeout(30);const box=await page.getByRole('textbox',{name:'群消息',exact:true}).boundingBox();const nav=await page.locator('.bottom-nav').boundingBox();if(!box||!nav||box.y+box.height>nav.y||box.x<0||box.x+box.width>size.width)throw Error('composer outside viewport '+JSON.stringify({size,box,nav}));const composer=await page.locator('.chat-composer').boundingBox();if(composer.height>70)throw Error('composer not compact '+composer.height);}
 await page.getByRole('button',{name:'更多消息工具'}).click();if(await page.getByRole('button',{name:'更多消息工具'}).getAttribute('aria-expanded')!=='true')throw Error('tools did not expand');await page.getByRole('textbox',{name:'群消息',exact:true}).focus();
 await page.screenshot({path:'/tmp/employeeclient-compact-composer.png'});
 await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>400});window.visualViewport.dispatchEvent(new Event('resize'))});await page.waitForTimeout(30);
 if(await page.locator('.bottom-nav').isVisible())throw Error('keyboard did not release bottom nav space');
 await page.getByRole('textbox',{name:'群消息',exact:true}).fill('键盘弹起时仍可发送');
 const sendBox=await page.getByRole('button',{name:'发送',exact:true}).boundingBox();if(!sendBox||sendBox.y+sendBox.height>400)throw Error('send hidden behind keyboard');
 await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'))});await page.waitForTimeout(30);
 if(!await page.locator('.bottom-nav').isVisible())throw Error('nav did not restore after keyboard');

 await page.getByRole('textbox',{name:'群消息',exact:true}).blur();
 const bubble=page.locator('.chat-bubble').first();
 await bubble.dispatchEvent('pointerdown',{button:0,clientX:100,clientY:100});await bubble.dispatchEvent('pointermove',{clientX:100,clientY:140});await page.waitForTimeout(480);
 if(await page.getByRole('dialog',{name:'消息操作'}).count())throw Error('scroll opened long press menu');
 await bubble.dispatchEvent('pointerdown',{button:0,clientX:100,clientY:100});await page.getByRole('dialog',{name:'消息操作'}).waitFor();await bubble.dispatchEvent('pointerup',{});
 await page.getByRole('button',{name:'引用回复',exact:true}).click();
 if(!await page.locator('.chat-quote').isVisible())throw Error('quote missing');
 if(!await page.getByRole('textbox',{name:'群消息',exact:true}).evaluate(el=>el===document.activeElement))throw Error('quote did not focus composer');

 const quoteStyle=await page.getByRole('button',{name:'取消引用'}).evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,background:s.backgroundColor}});
 if(quoteStyle.border!=='0px'||quoteStyle.background!=='rgba(0, 0, 0, 0)')throw Error('quote cancel still has native box');
 await page.getByRole('button',{name:'取消引用'}).click(); await page.getByRole('dialog',{name:'消息操作'}).waitFor({state:'hidden'});
 await page.evaluate(()=>{window.chat.messages.push({id:'m2',seq:2,body:'reply message',author_username:'test',author_name:'Test',mention_usernames:[],attachments:[],created_at:Date.now(),reply_to:{id:'m1',body:'existing history',author_username:'test',author_name:'Test'}})});
 if(await page.locator('.chat-bubble .chat-reply-link').count())throw Error('quoted context must be outside the message bubble');
 await page.locator('.chat-reply-link').focus();await page.keyboard.press('Enter');
 await page.locator('[data-message-id="m1"].highlighted').waitFor();
 if(await page.getByRole('dialog',{name:'消息操作'}).count())throw Error('quote keyboard navigation opened menu');
 await page.screenshot({path:'/tmp/employeeclient-chat-interaction.png'});
 await page.setViewportSize({width:320,height:568});

 await page.evaluate(()=>{const node=document.querySelector('.chat-bubble p').firstChild;const r=document.createRange();r.selectNodeContents(node);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r)});
 await bubble.dispatchEvent('contextmenu');await page.getByRole('dialog',{name:'消息操作'}).waitFor();await page.waitForTimeout(160);
 if(await page.evaluate(()=>window.getSelection().rangeCount))throw Error('old native selection not cleared');
 const focusShadow=await page.getByRole('button',{name:'引用回复',exact:true}).evaluate(el=>getComputedStyle(el).boxShadow);if(focusShadow!=='none')throw Error('touch menu has focus box');
 const compact=await page.getByRole('dialog',{name:'消息操作'}).boundingBox();if(compact.width>200||compact.height>70)throw Error('three-action menu too large '+JSON.stringify(compact));
 await page.screenshot({path:'/tmp/employeeclient-compact-actions-v18.png'});
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'消息操作'}).waitFor({state:'hidden'});
 await page.evaluate(()=>{window.chat.messages[0].allowed_actions=['hide','recall']});
 await bubble.dispatchEvent('contextmenu');
 const menu=page.getByRole('dialog',{name:'消息操作'});await menu.waitFor();await page.waitForTimeout(160);
 if(await menu.locator('time,.message-action-close').count())throw Error('menu still has timestamp or close button');
 const unselectable=await menu.evaluate(el=>getComputedStyle(el).userSelect);if(unselectable!=='none')throw Error('menu text selectable');
 const navLine=await page.locator('.bottom-nav button.active').evaluate(el=>getComputedStyle(el,'::after').content);if(!['none','normal'].includes(navLine))throw Error('navigation floating line remains');

 let menuBox=await menu.boundingBox(),bubbleBox=await bubble.boundingBox();
 if(!menuBox||menuBox.x<10||menuBox.x+menuBox.width>310||menuBox.y<0||menuBox.y+menuBox.height>568)throw Error('anchored menu clipped on narrow phone '+JSON.stringify(menuBox));
 if(Math.min(Math.abs(menuBox.y+menuBox.height-bubbleBox.y),Math.abs(menuBox.y-(bubbleBox.y+bubbleBox.height)))>15)throw Error('menu detached from bubble');
 if(await menu.getByRole('button',{name:'撤回',exact:true}).count()!==1)throw Error('recall action missing');
 await page.screenshot({path:'/tmp/employeeclient-anchored-actions.png'});
 await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
 await page.evaluate(()=>{document.querySelector('[data-message-id="m1"]').style.marginTop='120px';document.querySelector('.chat-stream').scrollTop=0});
 await bubble.dispatchEvent('contextmenu');await menu.waitFor();await page.waitForTimeout(160);
 menuBox=await menu.boundingBox();bubbleBox=await bubble.boundingBox();
 if(!menuBox||menuBox.y+menuBox.height>bubbleBox.y)throw Error('menu did not move above lower bubble');
 await page.evaluate(()=>document.querySelector('.chat-stream').dispatchEvent(new Event('scroll')));await menu.waitFor({state:'hidden'});
 await page.evaluate(()=>{document.querySelector('[data-message-id="m1"]').style.marginTop='';Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>400});window.visualViewport.dispatchEvent(new Event('resize'))});
 await bubble.dispatchEvent('contextmenu');await menu.waitFor();await page.waitForTimeout(160);menuBox=await menu.boundingBox();
 if(!menuBox||menuBox.y+menuBox.height>400)throw Error('menu hidden by visual keyboard');
 await page.locator('.message-actions-mask').click({position:{x:4,y:4}});await menu.waitFor({state:'hidden'});
 await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'))});


 await page.evaluate(()=>{window.testSession.link.networkUp=false;window.chat.messages[0].body='';window.chat.messages[0].allowed_actions=[]});
 await bubble.dispatchEvent('contextmenu');await menu.waitFor();await page.waitForTimeout(50);await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
 await page.evaluate(()=>{window.chat.messages[0].body='existing history';window.testSession.link.networkUp=true});
 await page.evaluate(()=>window.testSession.status='offline');await page.getByRole('textbox',{name:'群消息',exact:true}).fill('retain while reconnecting');await page.evaluate(()=>window.testSession.status='online');if(await page.getByRole('textbox',{name:'群消息',exact:true}).inputValue()!=='retain while reconnecting')throw Error('lost draft');await page.evaluate(()=>{window.testSession.user=null;window.testSession.isAuthenticated=false});await page.waitForTimeout(20);if(await page.getByText('existing history',{exact:true}).count())throw Error('history leaked after invalidation');console.log('PASS actual Vue/store: initial HTTP works during stream backoff; keyed replacement retains history; reconnect typing; account invalidation clears history. Mock transport, not phone acceptance.');}
} finally {await browser.close();}
