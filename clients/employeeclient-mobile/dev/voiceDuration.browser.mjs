// Private production sample is optional and read-only; never copied to source/archive.
import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {parse,compileScript} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const mocks={
 '@/session/store':`import {reactive} from 'vue';export const session=reactive({user:{username:'duration-test'}});export const useSessionStore=()=>session;`,
 '@/chat/files':`export const getChatDownload=async()=>{window.downloadLookups=(window.downloadLookups||0)+1;return {download_url:window.sampleUrl}};export const getChatVoiceDuration=async()=>{window.durationLookups=(window.durationLookups||0)+1;if(window.failDurationOnce){window.failDurationOnce=false;throw Error('temporary network failure');}return {attachment:{duration_ms:window.serverDuration||0}};};`,
};
const result=await build({stdin:{contents:`import {createApp,h,ref} from 'vue';import Voice from '@/ui/components/ChatVoiceMessage.vue';import {session} from '@/session/store';import * as duration from '@/chat/voiceDuration';window.duration=duration;window.session=session;const attachment=ref(null);window.show=(mime,id,duration_ms)=>attachment.value={id,name:'recording',mime,size:window.sampleSize,file_id:id,ver:1,sha256:window.sampleSha,duration_ms};window.clear=()=>attachment.value=null;createApp({setup:()=>()=>attachment.value?h(Voice,{key:attachment.value.id,attachment:attachment.value}):null}).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[{name:'voice-duration',setup(b){
 b.onResolve({filter:/^@\//},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:{path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts'))});
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'ts',resolveDir:process.cwd()}));
 b.onLoad({filter:/\.vue$/},a=>{const{descriptor}=parse(readFileSync(a.path,'utf8'));return {contents:compileScript(descriptor,{id:a.path,inlineTemplate:true}).content,loader:'ts',resolveDir:dirname(a.path)};});
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const report={samples:[],checks:[],physicalDevice:false};
try {
 const page=await browser.newPage();page.setDefaultTimeout(10000);
 await page.route('http://127.0.0.1:4178/',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
 await page.route('https://voice.test/**',async r=>r.fulfill({contentType:await page.evaluate(()=>window.sampleMime),body:Buffer.from(await page.evaluate(()=>window.sampleBytes))}));
 await page.goto('http://127.0.0.1:4178/');await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(()=>{window.serverDuration=1700;});
 await page.evaluate(()=>{window.playCount=0;const original=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){window.playCount++;return original.call(this);};});
 for(const mime of ['audio/webm;codecs=opus','audio/mp4']){
  const sample=await page.evaluate(async mime=>{
   if(!MediaRecorder.isTypeSupported(mime))return null;
   const stream=await navigator.mediaDevices.getUserMedia({audio:true});
   const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
   recorder.ondataavailable=e=>chunks.push(e.data);
   const blob=await new Promise(resolve=>{recorder.onstop=()=>resolve(new Blob(chunks,{type:mime}));recorder.start(100);setTimeout(()=>recorder.stop(),1700);});
   stream.getTracks().forEach(t=>t.stop());window.sampleBytes=Array.from(new Uint8Array(await blob.arrayBuffer()));window.sampleSize=blob.size;window.sampleMime=mime;window.sampleSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');window.sampleUrl='https://voice.test/'+encodeURIComponent(mime);
   const audio=new Audio(URL.createObjectURL(blob));
   const native=await new Promise(resolve=>{audio.onloadedmetadata=()=>resolve(Number.isFinite(audio.duration)?audio.duration:'Infinity');});
   window.show(mime,mime);
   return {mime,native,size:blob.size};
  },mime);
  if(!sample)continue;
  await page.waitForFunction(()=>/\d+″/.test(document.querySelector('.voice-duration')?.textContent||''));
  const seconds=await page.locator('.voice-duration').innerText();assert.match(seconds,/^[12]″$/);
  assert.equal(await page.evaluate(()=>window.playCount),0);
  report.samples.push({...sample,display:seconds,decodedBeforePlay:true});
  await page.evaluate(()=>window.clear());
  const reads=await page.evaluate(()=>window.downloadLookups);await page.evaluate(mime=>window.show(mime,mime),mime);await page.waitForFunction(()=>/\d+″/.test(document.querySelector('.voice-duration')?.textContent||''));assert.equal(await page.evaluate(()=>window.downloadLookups),reads);
  await page.evaluate(()=>window.clear());
 }
 // A finite WebView metadata value must win even for MP4. Decoding the same
 // file again used to turn a playable clip into a visible duration error.
 await page.evaluate(()=>window.show('audio/mp4','finite-metadata'));
 await page.getByRole('button',{name:'播放语音'}).click();
 await page.locator('audio').waitFor({state:'attached'});
 await page.evaluate(()=>{const audio=document.querySelector('audio');Object.defineProperty(audio,'duration',{configurable:true,value:4.25});audio.dispatchEvent(new Event('loadedmetadata'));});
 await page.waitForFunction(()=>document.querySelector('.voice-duration')?.textContent==='5″');
 assert.equal(await page.evaluate(()=>window.duration.knownVoiceDuration(window.duration.durationKey('duration-test',{id:'finite-metadata',ver:1,sha256:window.sampleSha}))),4.25);
 await page.evaluate(()=>window.clear());
 // Duration survives component and full-page reload without downloading/decoding again.
 const saved=await page.evaluate(()=>({mime:window.sampleMime,size:window.sampleSize,sha:window.sampleSha,url:window.sampleUrl,bytes:window.sampleBytes}));
 await page.reload();await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(s=>{window.sampleMime=s.mime;window.sampleSize=s.size;window.sampleSha=s.sha;window.sampleUrl=s.url;window.sampleBytes=s.bytes;window.show(s.mime,s.mime);},saved);
 await page.waitForFunction(()=>/\d+″/.test(document.querySelector('.voice-duration')?.textContent||''));assert.equal(await page.evaluate(()=>window.downloadLookups||0),0);
 // A temporary server failure does not permanently strand the bubble. A
 // network-restored event retries metadata only; no audio bytes are fetched.
 await page.evaluate(()=>{window.clear();window.durationLookups=0;window.serverDuration=3500;window.failDurationOnce=true;window.show('audio/mp4','retry-duration');});
 await page.waitForFunction(()=>window.durationLookups===1);
 assert.equal(await page.locator('.voice-duration').innerText(),'…');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('.voice-duration')?.textContent==='4″');
 assert.equal(await page.evaluate(()=>window.durationLookups),2);
 assert.equal(await page.evaluate(()=>window.downloadLookups||0),0);
 await page.evaluate(()=>{window.clear();window.serverDuration=0;window.durationLookups=0;window.show('audio/mp4','push-duration');});
 await page.waitForFunction(()=>window.durationLookups===1);
 await page.evaluate(()=>window.show('audio/mp4','push-duration',5200));
 await page.waitForFunction(()=>document.querySelector('.voice-duration')?.textContent==='6″');
 assert.equal(await page.evaluate(()=>window.downloadLookups||0),0);
 await page.evaluate(()=>window.clear());
 const wrong=await page.evaluate(s=>window.duration.knownVoiceDuration(window.duration.durationKey('someone-else',{id:s.mime,ver:1,sha256:s.sha})),saved);assert.equal(wrong,0);
 await page.evaluate(()=>window.session.user.username='someone-else');await page.waitForFunction(()=>!document.querySelector('audio'));
 await page.evaluate(()=>{window.session.user.username='duration-test';window.clear();window.playCount=0;});
 const historical='/tmp/qn-history-audio/own-historical.m4a';
 if(existsSync(historical)){
  await page.evaluate(()=>{window.serverDuration=0;});
  const bytes=Array.from(readFileSync(historical));
  const decoded=await page.evaluate(async bytes=>{
   window.sampleBytes=bytes;window.sampleMime='audio/mp4';window.sampleSize=bytes.length;window.sampleSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),v=>v.toString(16).padStart(2,'0')).join('');window.sampleUrl='https://voice.test/history';
   const seconds=await window.duration.decodeVoiceDuration(new Uint8Array(bytes).buffer);
   window.show('audio/mp4','historical-own');return seconds;
  },bytes);
  await page.waitForFunction(()=>/\d+″/.test(document.querySelector('.voice-duration')?.textContent||''));
  assert.equal(await page.locator('.voice-duration').innerText(),`${Math.ceil(decoded)}″`);
  assert.equal(await page.evaluate(()=>window.playCount),0);
  report.samples.push({mime:'audio/mp4',historical:true,bytes:bytes.length,decodedSeconds:decoded,display:await page.locator('.voice-duration').innerText(),played:false});
  const reads=await page.evaluate(()=>window.duration.knownVoiceDuration(window.duration.durationKey('duration-test',{id:'historical-own',ver:1,sha256:window.sampleSha})));
  assert.equal(reads,decoded);
  const wrongAccount=await page.evaluate(()=>window.duration.knownVoiceDuration(window.duration.durationKey('someone-else',{id:'historical-own',ver:1,sha256:window.sampleSha})));
  assert.equal(wrongAccount,0);
  await page.evaluate(()=>window.session.user.username='someone-else');
  await page.waitForFunction(()=>!document.querySelector('audio'));
 }
 // Android port: the downloaded local file is authoritative, never refetch its virtual URL.
 const nativePort=await page.evaluate(async()=>{
  let reads=0,calls=0;const controller=new AbortController();
  const source={size:1024,readPart:async()=>{reads++;throw Error('must not decode');},duration:async()=>{calls++;return 7.25;}};
  const first=await window.duration.loadVoiceDuration('capacitor://local-audio','native-port',controller.signal,source);
  const second=await window.duration.loadVoiceDuration('capacitor://local-audio','native-port',controller.signal,source);
  const nativeMp4=await window.duration.loadVoiceDuration('capacitor://local-audio','native-mp4-port',controller.signal,{
   size:1024,mime:'audio/mp4',duration:async()=>{calls++;return 6.4;},readPart:async()=>{throw Error('MP4 must use native timestamps first');}
  });
  const bytes=new Uint8Array(window.sampleBytes);
  const fallback=await window.duration.loadVoiceDuration('capacitor://local-audio','native-fallback',controller.signal,{
   size:bytes.length,duration:async()=>{throw Error('old native plugin');},readPart:async(start,end)=>{reads++;return new Blob([bytes.slice(start,end)]);}
  });
  return {first,second,nativeMp4,calls,reads,fallback};
 });
 assert.equal(nativePort.first,7.25);assert.equal(nativePort.second,7.25);assert.equal(nativePort.nativeMp4,6.4);assert.equal(nativePort.calls,2);
 assert.ok(nativePort.reads>0);assert.ok(nativePort.fallback>0);
 report.nativePort=nativePort;
 // Abort queued/in-flight work and reject invalid/oversized payloads without caching.
 const guard=await page.evaluate(async()=>{
  const controller=new AbortController();controller.abort();
  let cancelled=false,invalid=false;
  try{await window.duration.loadVoiceDuration(window.sampleUrl,'aborted',controller.signal);}catch(e){cancelled=e.name==='AbortError';}
  try{await window.duration.decodeVoiceDuration(new ArrayBuffer(0));}catch{invalid=true;}
  return {cancelled,invalid,cache:window.duration.knownVoiceDuration('aborted')};
 });
 assert.deepEqual(guard,{cancelled:true,invalid:true,cache:0});
 report.checks=['finite duration before playback','remount and full-page reload reuse persistent duration without download','server duration retries only after network restoration','server duration update renders without downloading audio','raw MediaRecorder WebM and fragmented MP4','no autoplay','account-keyed cache','account change clears audio','abort does not cache','empty input rejected'];
 const output=process.env.QN_VOICE_OUTPUT || '/tmp/qn-v39-verification';mkdirSync(output,{recursive:true});writeFileSync(`${output}/voice-duration.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await browser.close();}
