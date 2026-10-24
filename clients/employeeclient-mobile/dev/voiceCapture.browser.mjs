// Real browser MediaRecorder verification. Upload/download APIs are deterministic fixtures;
// microphone capture is Chromium's fake media device, not a physical-device permission claim.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild'; import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mocks = {
  '@/api/client': `export class ApiError extends Error {constructor(code,hint,status){super(hint);this.status=status}};export const apiRequest=async()=>{throw Error('unexpected API call')};export const apiConfig={getToken:()=> 'test-token'}; export const newIdempotencyKey=()=> 'key';`,
  '@/chat/files': `export const renameChatFile=async()=>{};export const getChatVoiceDuration=async()=>({attachment:{duration_ms:0}});export const MAX_CHAT_FILE_BYTES=8*1024*1024; export const uploadChatFile=async(file,key,onStage,signal)=>{onStage('正在上传');window.uploadAttempts=window.uploadAttempts||[];window.uploadAttempts.push({key,size:file.size,name:file.name});if(window.failUpload){window.failUpload=false;throw Error('模拟网络中断，录音仍在');}window.uploaded={name:file.name,size:file.size,type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))};return {id:'a1',name:file.name,size:file.size,mime:file.type,file_id:'a1',ver:1,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join(''),address:'https://example.test/a1'};}; export const getChatDownload=async()=>({download_url:window.audioUrl});`,
  '@/chat/share': `export const pendingSharedFiles=async()=>[];export const readSharedFile=async()=>{throw Error('unused')};export const clearSharedFiles=async()=>{};export const acknowledgeSharedFile=async()=>{};`,
  '@/session/store': `export const useSessionStore=()=>({user:{username:'me'}});`,
};
function plugin() { return { name:'voice-sfc', setup(b) {
  b.onResolve({filter:/^@\//}, a => mocks[a.path] ? {path:a.path,namespace:'mock'} : {path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'});
  b.onResolve({filter:/^\./,namespace:'sfc'}, a => { const path=resolve(dirname(a.importer),a.path); return {path:path.endsWith('.vue')?path:path+'.ts',namespace:path.endsWith('.vue')?'sfc':'file'}; });
  b.onLoad({filter:/.*/,namespace:'mock'}, a=>({contents:mocks[a.path],loader:'ts',resolveDir:process.cwd()}));
  b.onLoad({filter:/\.vue$/,namespace:'sfc'}, a=>{const {descriptor}=parse(readFileSync(a.path,'utf8'));let c=compileScript(descriptor,{id:a.path,inlineTemplate:true}).content.replace('export default','const __sfc =');c += `\nexport default __sfc;`;return {contents:c,loader:'ts',resolveDir:dirname(a.path)}});
} }; }
const result = await build({stdin:{contents:`import {createApp,h,ref} from 'vue';import Picker from '@/ui/components/ChatAttachmentPicker.vue';import Attachment from '@/ui/components/ChatAttachmentView.vue';const attachment=ref(null),picker=ref(null),error=ref('');window.record=()=>picker.value.record();window.cancel=()=>picker.value.stop(true);window.send=()=>picker.value.stop(false);const app=createApp({setup:()=>()=>h('div',[h(Picker,{ref:picker,onAdded:a=>attachment.value=a}),attachment.value?h(Attachment,{attachment:attachment.value}):null])});app.mount('#app');window.unmount=()=>app.unmount();`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[plugin()]});
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<div id=\"app\"></div>')}); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser = await chromium.launch({ headless:true, executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell', args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
try {
  const context = await browser.newContext({ permissions:['microphone'] }); const page=await context.newPage(); page.setDefaultTimeout(5000);
  // Use a loopback origin: opaque setContent pages do not expose getUserMedia.
  await page.goto(`http://127.0.0.1:${port}/`); page.on('pageerror',e=>console.error('PAGE',e.message)); await page.addScriptTag({content:result.outputFiles[0].text});
  await page.evaluate(()=>{window.audioUrl='https://voice.test/sample';window.uploaded=null;});
  await page.route('https://voice.test/**',async r=>r.fulfill({contentType:await page.evaluate(()=>window.uploaded.type),body:Buffer.from(await page.evaluate(()=>window.uploaded.bytes))}));
  await page.evaluate(()=>{
    window.realCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{window.delayedStream=await window.realCapture(constraints);return new Promise(resolve=>window.finishPermission=()=>resolve(window.delayedStream));};
    void window.record();
  });
  await page.waitForFunction(()=>!!window.finishPermission);
  await page.evaluate(()=>{window.cancel();window.finishPermission();});await page.waitForTimeout(100);
  if(await page.locator('.voice-recording').count())throw Error('cancelled permission request started a hidden recording');
  if(!await page.evaluate(()=>window.delayedStream.getTracks().every(t=>t.readyState==='ended')))throw Error('late microphone stream leaked');
  await page.evaluate(()=>navigator.mediaDevices.getUserMedia=window.realCapture);
  await page.evaluate(()=>window.record()); await page.waitForTimeout(1000); await page.getByRole('status').waitFor(); await page.waitForTimeout(1100); if(!/正在录音 [1-9]\d* 秒/.test(await page.locator('.voice-recording').innerText()))throw Error('recording timer missing'); await page.getByRole('button',{name:'完成录音'}).click();
  await page.getByRole('button',{name:'发送语音',exact:true}).waitFor();
  if(!/0:0[12]$/.test(await page.locator('.voice-track small').innerText()))throw Error('preview lost captured duration');
  if(await page.evaluate(()=>window.uploaded)!==null)throw Error('preview uploaded without confirmation');
  await page.getByRole('button',{name:'播放语音',exact:true}).click();
  await page.getByRole('button',{name:'暂停语音',exact:true}).waitFor();
  await page.evaluate(()=>window.failUpload=true);
  await page.getByRole('button',{name:'发送语音',exact:true}).click();
  await page.getByRole('alert').waitFor();
  if(await page.evaluate(()=>window.uploaded)!==null)throw Error('failed upload added attachment');
  await page.getByRole('button',{name:'重试发送',exact:true}).click();
  const attempts=await page.evaluate(()=>window.uploadAttempts);if(attempts.length!==2||JSON.stringify(attempts[0])!==JSON.stringify(attempts[1]))throw Error('voice retry changed file or idempotency key');
  await page.waitForFunction(()=>window.uploaded && window.uploaded.size>0, null, {timeout:5000});
  const upload=await page.evaluate(()=>window.uploaded); if(!upload.type.startsWith('audio/') || !upload.size) throw Error('recording upload was empty/non-audio');
  await page.waitForFunction(()=>/[1-9]\d*″/.test(document.querySelector('.voice-duration')?.textContent||''));
  await page.getByRole('button',{name:/播放语音/}).click(); const audio=page.locator('audio'); await audio.waitFor({state:'attached'});
  const meta=await audio.evaluate(el=>new Promise(resolve=>{setTimeout(()=>resolve({error:'metadata timeout'}),4000);el.onloadedmetadata=()=>resolve({duration:el.duration,readyState:el.readyState});el.onerror=()=>resolve({error:true});if(el.readyState>=1)resolve({duration:el.duration,readyState:el.readyState});}));
  if(meta.error) throw Error('recorded audio metadata failed');
  await page.evaluate(()=>{window.uploaded=null;}); await page.evaluate(()=>window.record()); await page.getByRole('button',{name:'取消'}).click(); await page.waitForTimeout(300); if(await page.evaluate(()=>window.uploaded)!==null) throw Error('cancel uploaded audio');
  await page.evaluate(()=>{document.querySelector('.voice-message audio').src='bad://audio';}); await page.getByRole('alert').waitFor();
  await page.evaluate(()=>window.audioUrl='');
  await page.evaluate(()=>window.record());await page.getByRole('button',{name:'完成录音',exact:true}).waitFor();await page.evaluate(()=>{window.uploaded=null;window.unmount();});await page.waitForTimeout(100);if(await page.evaluate(()=>window.uploaded)!==null)throw Error('unmounted capture uploaded');
  await context.close();
  const denied=await browser.newContext(); await denied.grantPermissions([], {origin:`http://127.0.0.1:${port}`}).catch(()=>{}); const deniedPage=await denied.newPage(); deniedPage.setDefaultTimeout(5000); await deniedPage.goto(`http://127.0.0.1:${port}/`); await deniedPage.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};}); await deniedPage.addScriptTag({content:result.outputFiles[0].text}); await deniedPage.evaluate(()=>window.record()); await deniedPage.getByRole('alert').waitFor(); const deniedText=await deniedPage.getByRole('alert').innerText(); if(!/麦克风|不可用|权限/.test(deniedText)) throw Error('permission error was not explicit'); await denied.close();
  console.log('PASS fake-device MediaRecorder: preview requires explicit send, failed upload retains same file/key for retry, non-empty audio upload, playable metadata, cancel no upload, playback error visible, simulated permission denial explicit. Not physical-device evidence.');
} finally { await browser.close(); server.close(); }
