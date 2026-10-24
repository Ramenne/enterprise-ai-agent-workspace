// Actual Chromium MediaRecorder + rendered product components; synthetic audio device/API.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import {designCss} from './designCss.mjs';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output='/Users/developer/Downloads/超强学习/research/employeeclient-chain-research-20261015/ux-current';mkdirSync(output,{recursive:true});
const mocks={
 '@/api/client':`export const captureApiLease=()=>({account:'qa',valid:()=>true});export const newIdempotencyKey=()=> 'voice-experience';`,
 '@/files/chatTransfers':`export const startChatTransfer=()=>{throw Error('unexpected automatic transfer')};export const stageChatTransfer=()=>{throw Error('unexpected file stage')};`,
 '@/chat/files':`export const MAX_CHAT_FILE_BYTES=32*1024**2;export const uploadChatFile=async(file,key)=>{window.attempts.push({size:file.size,key});if(window.failUpload){window.failUpload=false;throw Error('网络中断，请重试');}window.sent++;return {id:'qa',ver:1,sha256:'a'.repeat(64)};};`,
 '@/chat/share':`export const pendingSharedFiles=async()=>[];export const clearSharedFiles=async()=>{};export const readSharedFile=()=>{};export const acknowledgeSharedFile=async()=>{};`,
 '@/session/store':`export const useSessionStore=()=>({user:{username:'qa'}});`
};let styles='';
const plugin={name:'actual-components',setup(b){
 b.onResolve({filter:/^@\//},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:{path:resolve('src',a.path.slice(2)+(extname(a.path)?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'});
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>{const path=resolve(dirname(a.importer),a.path);return {path:path+(extname(path)?'':'.ts'),namespace:path.endsWith('.vue')?'sfc':'file'};});
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'ts'}));
 b.onLoad({filter:/\.vue$/,namespace:'sfc'},a=>{const {descriptor}=parse(readFileSync(a.path,'utf8'));for(const style of descriptor.styles)styles+=compileStyle({source:style.content,filename:a.path,id:'qa',scoped:false}).code;return {contents:compileScript(descriptor,{id:'qa',inlineTemplate:true}).content,loader:'ts',resolveDir:dirname(a.path)};});
}};
const bundle=await build({stdin:{contents:`import {createApp,h,ref} from 'vue';import Picker from '@/ui/components/ChatAttachmentPicker.vue';const picker=ref();window.attempts=[];window.sent=0;window.record=()=>picker.value.record();window.app=createApp({setup:()=>()=>h(Picker,{ref:picker})});window.app.mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[plugin]});
const base=designCss;
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${base}${styles}body{margin:0;background:white}#app{padding:12px}</style><div id="app"></div>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const report={synthetic_audio:true,scenes:[]};
try{
 const context=await browser.newContext({permissions:['microphone'],viewport:{width:320,height:640}}),page=await context.newPage();page.setDefaultTimeout(5000);
 await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>{window.realCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=()=>new Promise(r=>window.allowCapture=r);void window.record();});
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.evaluate(async()=>{const s=await window.realCapture({audio:true});window.lateStream=s;window.allowCapture(s);});await page.waitForFunction(()=>window.lateStream.getTracks().every(t=>t.readyState==='ended'));
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=window.realCapture;});await page.evaluate(()=>window.record());await page.waitForTimeout(1200);await page.getByRole('button',{name:'完成录音'}).click();await page.getByRole('button',{name:'发送语音',exact:true}).waitFor();
 await page.screenshot({path:output+'/voice-320.png'});
 await page.addStyleTag({content:(base+styles).replace(/(font-size\s*:\s*)([\d.]+)px/g,(_,a,n)=>a+(Number(n)*1.5)+'px')});
 for(const width of [320,390]){await page.setViewportSize({width,height:640});const geometry=await page.locator('.voice-draft-actions').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,buttons:[...el.querySelectorAll('button')].map(b=>({text:b.textContent,height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width}))}));if(geometry.scroll>geometry.client+1)throw Error('voice action overflow');report.scenes.push({width,text_scale:150,geometry});await page.screenshot({path:output+'/voice-'+width+'-150.png'});}
 await page.evaluate(()=>window.failUpload=true);await page.getByRole('button',{name:'发送语音',exact:true}).click();await page.getByRole('button',{name:'重试发送',exact:true}).click();await page.waitForFunction(()=>window.sent===1);const attempts=await page.evaluate(()=>window.attempts);if(attempts.length!==2||JSON.stringify(attempts[0])!==JSON.stringify(attempts[1]))throw Error('voice retry changed original');
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async c=>{window.activeStream=await window.realCapture(c);return window.activeStream;};});await page.evaluate(()=>window.record());await page.waitForTimeout(200);await page.evaluate(()=>window.activeStream.getTracks().forEach(t=>t.stop()));await page.getByRole('alert').filter({hasText:'录音中断'}).waitFor();if(await page.locator('.voice-draft').count()||await page.evaluate(()=>window.sent)!==1)throw Error('interrupted microphone created/sent draft');
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});await page.evaluate(()=>window.record());await page.getByRole('alert').waitFor();await page.screenshot({path:output+'/voice-denied.png'});
 await context.close();report.result='passed';writeFileSync(output+'/voice-result.json',JSON.stringify(report,null,2));console.log('PASS actual MediaRecorder, permission wait cancel + late stream release, preview, same-file/key failed-send retry, denied permission, 320/390 large-text rendered actions');
}finally{await browser.close();server.close();}
