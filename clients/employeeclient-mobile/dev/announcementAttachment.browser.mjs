// Runs the actual notification/search/modal SFCs. Backend fixtures do not prove deployment.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mocks = {
 'vue-router': `export const useRouter=()=>({push:async()=>{}});`,
 '@/store/data': `import {reactive} from 'vue';const store=reactive({account:'me',notifications:[{id:'notice'}],announcements:[{id:'a1',title:'公司公告',body:'正文',publisher_username:'boss',created_at:1,expires_at:null,notification_id:'notice',read_at:null,recipient_count:2,read_count:1,unread_count:1,audience:[{username:'alice',read_at:5},{username:'bob',read_at:null}]}],syncLists:async()=>{}});export const useDataStore=()=>store;`,
 '@/store/chat': `export const useChatStore=()=>({account:'me',members:[{username:'boss',nickname:'负责人'},{username:'alice',nickname:'小艾'},{username:'bob',nickname:'小波'}]});`,
 '@/session/store': `import {reactive} from 'vue';const session=reactive({user:{username:'me'},status:'online'});window.switchAccount=()=>session.user.username='other';export const useSessionStore=()=>session;`,
 '@/store/ui': `export const useUiStore=()=>({overlayProps:{announcementId:'a1'},closeOverlay(){},toast(){}});`,
 '@/store/actions': `export const markRead=async()=>{window.reads++;return true};`,
 '@/api/endpoints': `export const communication={replies:async()=>({replies:[],has_more:false,next_cursor:0}),reply:async()=>{}};`,
 '@/ui/usePendingWrite': `import {ref} from 'vue';export const usePendingWrite=()=>({pending:ref(null),valid:()=>true,account:'me'});`,
 '@/platform/chatEvents': `export const onChatWake=()=>()=>{};`,
 '@/chat/files': `export const getChatDownload=async()=>({download_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='});export const getChatVoiceDuration=async()=>({attachment:{duration_ms:1000}});export const renameChatFile=async()=>{};`,
 '@/platform/openFile': `export const openFilePage=async()=>{};export const openResolvedFilePage=async resolve=>openFilePage(await resolve());`,
 '@capacitor/core': `export const Capacitor={isNativePlatform:()=>false};export const registerPlugin=()=>({});`,
 '@capacitor/app': `export const App={};`,
};
const result = await build({stdin:{contents:`import {createApp,h} from 'vue';import Announcement from '@/ui/components/AnnouncementOverlay.vue';import Attachment from '@/ui/components/ChatAttachmentView.vue';window.reads=0;createApp({setup:()=>()=>h('div',[h(Announcement),h(Attachment,{attachment:{id:'f1',name:'image.png',size:100,mime:'image/png'}})])}).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,plugins:[{name:'sfc',setup(b){
  b.onResolve({filter:/^(vue-router|@\/|@capacitor\/)/},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:{path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts'))});
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'ts',resolveDir:process.cwd()}));
  b.onLoad({filter:/\.vue$/},a=>{const {descriptor}=parse(readFileSync(a.path,'utf8'));return {contents:compileScript(descriptor,{id:a.path,inlineTemplate:true}).content,loader:'ts',resolveDir:dirname(a.path)}});
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
 const page=await browser.newPage();await page.setContent('<div id="app"></div>');
 await page.evaluate(()=>{window.copies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copies.push(text)}})});
 await page.addStyleTag({content:'svg{width:20px;height:20px}.overlay{position:fixed;inset:0;background:white;overflow:auto}.modal{padding:20px}'});
 await page.addScriptTag({content:result.outputFiles[0].text});
 await page.getByRole('button',{name:'已读 1 人',exact:true}).click();if(await page.locator('.audience-names').innerText()!=='小艾')throw Error('read audience nickname mismatch');
 await page.getByRole('button',{name:'未读 1 人',exact:true}).click();if(await page.locator('.audience-names').innerText()!=='小波')throw Error('unread audience mismatch');
 if(await page.evaluate(()=>window.reads)!==0)throw Error('view auto read');
 await page.getByRole('button',{name:'我已阅读',exact:true}).click();if(await page.evaluate(()=>window.reads)!==1)throw Error('explicit read failed');
 if(!await page.locator('.modal-header').innerText().then(s=>s.includes('负责人发布')))throw Error('publisher nickname missing');
 await page.locator('.chat-file img').waitFor();
 await page.locator('.image-preview-trigger').evaluate(e=>e.click());await page.locator('.full-image-preview').waitFor();
 await page.keyboard.press('Escape');if(await page.locator('.full-image-preview').count())throw Error('image Escape failed');
 await page.evaluate(()=>window.switchAccount());if(await page.locator('.chat-file img').count())throw Error('attachment leaked on account switch');
 console.log('PASS actual announcement/attachment SFC: audience names, nickname mapping, no auto read, explicit read, image preview Escape and account cleanup. Fixture APIs only.');
} finally {await browser.close()}
