// Runs the actual notification/search/modal SFCs. Backend fixtures do not prove deployment.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mocks = {
  '@/store/data': `export const useDataStore=()=>({tasks:Array.from({length:25},(_,i)=>({id:'t'+i,title:'匹配任务'+i,scope_at_creation:'company'})),companyIssues:[],personalProjects:[],inboxNotifications:[{id:'n1',title:'审核通过',worklog_id:1630,kind:'review_result',priority:'normal',created_at:1,object_id:'t1',object_type:'task'}]});`,
  '@/store/ui': `export const useUiStore=()=>({toast(){},openOverlay(){},closeOverlay(){window.closeSearch()}});`,
  'vue-router': `export const useRouter=()=>({push(){window.opens++}});`,
  '@/store/actions': `export const actOnNotification=async()=>{};`,
  '@capacitor/core': `export const Capacitor={isNativePlatform:()=>true};`,
  '@capacitor/app': `export const App={addListener:async(_,fn)=>{window.nativeBack=fn;return {remove(){window.nativeBack=null}}}};`,
};
const result = await build({stdin:{contents:`import {createApp,h,ref} from 'vue';import Notifications from '@/ui/views/NotificationsView.vue';import Search from '@/ui/components/SearchOverlay.vue';const shown=ref(false);window.opens=0;window.closeSearch=()=>shown.value=false;createApp({setup:()=>()=>h('div',[h('button',{id:'trigger',onClick:()=>shown.value=true},'搜索'),h(Notifications),shown.value?h(Search):null])}).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,plugins:[{name:'sfc',setup(b){
  b.onResolve({filter:/^(vue-router|@\/|@capacitor\/)/},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:{path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts'))});
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'ts'}));
  b.onLoad({filter:/\.vue$/},a=>{const {descriptor}=parse(readFileSync(a.path,'utf8'));return {contents:compileScript(descriptor,{id:a.path,inlineTemplate:true}).content,loader:'ts',resolveDir:dirname(a.path)}});
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
 const page=await browser.newPage();await page.setContent('<div id="app"></div>');
 await page.evaluate(()=>{window.copies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copies.push(text)}})});
 await page.addStyleTag({content:'svg{width:20px;height:20px}.overlay{position:fixed;inset:0;background:white;overflow:auto}.modal{padding:20px}'});
 await page.addScriptTag({content:result.outputFiles[0].text});
 const item=page.locator('.notif-open');const bounds=await item.boundingBox();
 await page.mouse.move(bounds.x+bounds.width-5,bounds.y+bounds.height/2);await page.mouse.down();await page.waitForTimeout(600);await page.mouse.up();
 if(await page.evaluate(()=>window.opens)!==0)throw Error('long press navigated');
 if(JSON.stringify(await page.evaluate(()=>window.copies))!=='["#1630"]')throw Error('wrong copied identifier');
 await item.click();if(await page.evaluate(()=>window.opens)!==1)throw Error('next normal tap blocked');
 await item.dispatchEvent('pointerdown',{button:0,pointerId:4,clientX:0,clientY:0});await item.dispatchEvent('pointermove',{pointerId:4,clientX:0,clientY:35});await page.waitForTimeout(550);await item.dispatchEvent('pointerup',{pointerId:4});await item.dispatchEvent('click',{detail:1});
 if(await page.evaluate(()=>window.opens)!==1 || await page.evaluate(()=>window.copies.length)!==1)throw Error('scroll triggered copy or open');
 await page.locator('#trigger').click();await page.locator('#global-search').fill('匹配');
 if(await page.locator('.search-result').count()!==20)throw Error('initial search page');
 await page.getByRole('button',{name:/显示更多结果/}).click();if(await page.locator('.search-result').count()!==25)throw Error('search results truncated');
 await page.getByRole('button',{name:'关闭',exact:true}).focus();await page.keyboard.press('Shift+Tab');
 if(!await page.evaluate(()=>document.querySelector('[role=dialog]').contains(document.activeElement)))throw Error('focus escaped modal');
 await page.keyboard.press('Escape');if(await page.getByRole('dialog').count())throw Error('escape failed');
 if(!await page.locator('#trigger').evaluate(e=>e===document.activeElement))throw Error('focus not restored');
 await page.locator('#trigger').click();await page.evaluate(()=>window.nativeBack());if(await page.getByRole('dialog').count())throw Error('native back did not close');
 console.log('PASS actual SFC: longpress copy/no navigation; next tap; scroll cancellation; full search pagination; modal focus/Escape/native-back listener. Native plugin bridge simulated, not physical Android.');
} finally {await browser.close()}
