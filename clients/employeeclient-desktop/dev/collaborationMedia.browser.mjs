import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import {designCss} from './designCss.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fixture=`import {reactive} from 'vue';export const session=reactive({user:{username:'account-a'}});export const useSessionStore=()=>session;window.session=session;`;
const styles=[];
const result=await build({stdin:{contents:`import {createApp,reactive,h} from 'vue';import View from '@/ui/components/CollaborationMessage.vue';window.items=reactive([]);window.mediaContext=reactive({account:'account-a',computer:'mac',provider:'codex',thread:'thread'});createApp({setup(){return()=>window.items.map(m=>h(View,{message:m,providerName:'Codex',mediaContext:window.mediaContext}));}}).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',define:{'import.meta.env':'{}'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>({path:resolve(dirname(a.importer),a.path)+(a.path.endsWith('.vue')?'':'.ts'),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onResolve({filter:/^(@\/session\/store|@\/collaboration\/api|@\/store\/data|@\/store\/ui)$/},()=>({path:'fixture',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,loader:'ts',resolveDir:process.cwd()}));
 b.onResolve({filter:/^@\//},a=>({path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onLoad({filter:/.*/,namespace:'sfc'},a=>{const{descriptor}=parse(readFileSync(a.path,'utf8'));const id='data-v-'+createHash('sha1').update(a.path).digest('hex').slice(0,8);styles.push(...descriptor.styles.map(s=>compileStyle({source:s.content,filename:a.path,id,scoped:s.scoped}).code));return{contents:compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const view =')+'\nview.__scopeId='+JSON.stringify(id)+';export default view;',loader:'ts',resolveDir:dirname(a.path)};});
 // Relative api import from real commands.ts must share the same fixture.
 
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const files=new Map(),commands=new Map();let requests=0,bad=false,slow=false;
 files.set('image',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64'));
 files.set('text',Buffer.from('完整正文\n'.repeat(10000)));
 const pdfObjects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  '<< /Length 43 >>\nstream\nBT /F1 18 Tf 40 100 Td (EmployeeClient PDF) Tj ET\nendstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 ];
 let pdf='%PDF-1.4\n';const offsets=[0];
 for(const [i,object] of pdfObjects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 pdf+=`trailer << /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 files.set('pdf',Buffer.from(pdf));
 const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);files.set('audio',wav);
 files.set('large',Buffer.alloc(1100000,42));files.set('cancel',Buffer.alloc(1100000,43));
 await page.route('https://collab.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/commands')){const body=route.request().postDataJSON();commands.set(body.id,body.request);return route.fulfill({json:{}});}
  if(path.includes('/commands/')){requests++;const r=commands.get(path.split('/').at(-1)),data=files.get(r.attachment_id);if(slow)await new Promise(r=>setTimeout(r,800));
   const block=data.subarray(r.offset,r.offset+524288);return route.fulfill({json:{state:'done',result:{ok:true,id:r.attachment_id,offset:r.offset,next_offset:r.offset+block.length,size:data.length,eof:r.offset+block.length===data.length,data:block.toString('base64'),sha256:bad?'bad':createHash('sha256').update(block).digest('hex')}}});}
  return route.fulfill({contentType:'text/html',body:'<main id="app" style="padding:16px"></main>'});
 });
 await page.goto('https://collab.test/');await page.evaluate(()=>{window.showSaveFilePicker=undefined;});await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 const video=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const c=canvas.getContext('2d');c.fillStyle='#215db0';c.fillRect(0,0,160,90);
  const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),parts=[];
  return await new Promise(resolve=>{recorder.ondataavailable=e=>parts.push(e.data);recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(parts).arrayBuffer())));};recorder.start();let x=0;const t=setInterval(()=>{c.fillStyle=x++%2?'white':'blue';c.fillRect(0,0,160,90);},40);setTimeout(()=>{clearInterval(t);recorder.stop();},350);});
 });files.set('video',Buffer.from(video));
 await page.evaluate(()=>window.items.push({id:'m',role:'assistant',text:'**交付附件**',phase:'final',attachments:[{id:'image',name:'预览.png',kind:'image',mime:'image/png'},{id:'video',name:'演示.webm',kind:'video',mime:'video/webm'},{id:'audio',name:'录音.wav',kind:'audio',mime:'audio/wav'},{id:'pdf',name:'说明.pdf',kind:'file',mime:'application/pdf'},{id:'text',name:'完整记录.txt',kind:'file',mime:'text/plain'},{id:'large',name:'文件.zip',kind:'file',mime:'application/zip'}]}));
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);
 await page.getByRole('button',{name:'查看原图 预览.png'}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'关闭'}).click();
 const videoCard=page.locator('.collab-attachment').filter({hasText:'演示.webm'});await videoCard.getByRole('button',{name:'播放视频'}).click();
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth===160);await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();});await page.waitForFunction(()=>document.querySelector('video').currentTime>0);
 let streamed=0;await page.route('https://stream.test/video.webm',route=>{streamed++;return route.fulfill({status:200,body:files.get('video'),contentType:'video/webm',headers:{'Access-Control-Allow-Origin':'*','Accept-Ranges':'bytes'}});});
 await page.evaluate(()=>window.items[0].attachments.push({id:'stream-video',name:'在线播放.webm',kind:'video',mime:'video/webm',url:'https://stream.test/video.webm'}));
 const streamCard=page.locator('.collab-attachment').filter({hasText:'在线播放.webm'}),commandsBeforeStream=requests;
 await streamCard.getByRole('button',{name:'播放视频'}).click();await streamCard.getByText('在线播放 · 尚未下载完整文件').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('video')[1]?.videoWidth===160);
 if(!streamed||requests!==commandsBeforeStream)throw Error('remote video preview downloaded whole file through collaboration commands');
 const downloadFrom=async(card,cancelled=false)=>{await card.getByRole('button',{name:'保存或分享文件'}).click();await page.getByRole('button',{name:'下载到本机',exact:true}).click();await page.getByRole('button',{name:'确认保存'}).click();const dialog=page.getByRole('dialog');if(cancelled)await page.waitForTimeout(80);else await page.waitForFunction(()=>{const d=document.querySelector('[role="dialog"]');return !!d&&(/完成/.test(d.querySelector('button.primary')?.textContent||'')||!!d.querySelector('[role="alert"]'));});if(await dialog.getByRole('button',{name:'完成',exact:true}).count())await dialog.getByRole('button',{name:'完成',exact:true}).click();else await dialog.getByRole('button',{name:'关闭',exact:true}).click();};
 const videoDownload=page.waitForEvent('download');await downloadFrom(videoCard);const savedVideo=await videoDownload;if(!readFileSync(await savedVideo.path()).equals(files.get('video')))throw Error('video download differs');
 const audioCard=page.locator('.collab-attachment').filter({hasText:'录音.wav'});await audioCard.getByRole('button',{name:'播放音频'}).click();await page.waitForFunction(()=>document.querySelector('audio')?.duration===1);await page.locator('audio').evaluate(async a=>{a.muted=true;await a.play();});
 const pdfCard=page.locator('.collab-attachment').filter({hasText:'说明.pdf'});await pdfCard.getByRole('button',{name:'打开文件'}).click();await page.locator('.pdf-preview').waitFor();
 if(!String(await page.locator('.pdf-preview').getAttribute('src')).startsWith('blob:'))throw Error('PDF did not use verified local bytes');
 await page.getByRole('button',{name:'关闭'}).click();
 const textCard=page.locator('.collab-attachment').filter({hasText:'完整记录.txt'});await textCard.getByRole('button',{name:'打开文件'}).click();await page.locator('.full-text').waitFor();if((await page.locator('.full-text').textContent()).length!==50000)throw Error('text truncated');await page.getByRole('button',{name:'关闭'}).click();
 const large=page.locator('.collab-attachment').filter({hasText:'文件.zip'});
 bad=true;await downloadFrom(large);await large.getByRole('alert').filter({hasText:'校验失败'}).waitFor();bad=false;
 const download=page.waitForEvent('download');await downloadFrom(large);const file=await download;const saved=readFileSync(await file.path());if(!saved.equals(files.get('large')))throw Error('download differs');
 const pdfDownload=page.waitForEvent('download');await downloadFrom(pdfCard);if(!readFileSync(await(await pdfDownload).path()).equals(files.get('pdf')))throw Error('PDF download differs from opened bytes');
 await large.getByRole('status').filter({hasText:'已交给浏览器下载'}).waitFor();
 const networkBefore=requests;
 await page.evaluate(()=>{window.savedItems=JSON.parse(JSON.stringify(window.items));window.items.splice(0);});
 await page.waitForTimeout(25);await page.evaluate(()=>window.items.push(...window.savedItems));
 await large.getByRole('status').filter({hasText:'已交给浏览器'}).waitFor();
 if(requests!==networkBefore)throw Error('remount refetched durable attachments');
 await large.getByRole('button',{name:'保存或分享文件'}).click();
 await page.getByRole('button',{name:'打开应用内文件'}).waitFor();
 if(await page.getByRole('button',{name:'下载到本机',exact:true}).count())throw Error('browser handoff offered an accidental duplicate download');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 const remountItems=await page.evaluate(()=>JSON.parse(JSON.stringify(window.items)));
 await page.reload();await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(items=>window.items.push(...items),remountItems);
 const restored=page.locator('.collab-attachment').filter({hasText:'文件.zip'});
 await restored.getByRole('button',{name:'保存或分享文件'}).click();
 await page.getByRole('button',{name:'再次保存到设备'}).waitFor();
 if(await page.getByRole('button',{name:'下载到本机',exact:true}).count())throw Error('browser handoff was forgotten after reload');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 // A real filesystem-capable browser must wait for the write, close and readback.
 await page.evaluate(()=>{window.savedBytes=null;window.showSaveFilePicker=async()=>({name:'文件.zip',createWritable:async()=>({write:async blob=>{window.savedBytes=await blob.arrayBuffer();},close:async()=>{},abort:async()=>{}}),getFile:async()=>new File([window.savedBytes],'文件.zip')});});
 await restored.getByRole('button',{name:'保存或分享文件'}).click();await page.getByRole('button',{name:'再次保存到设备'}).click();await page.getByRole('button',{name:'确认保存'}).click();await page.getByRole('button',{name:'完成',exact:true}).click();await restored.getByRole('status').filter({hasText:'已保存本机'}).waitFor();
 if(await page.evaluate(()=>window.savedBytes.byteLength)!==files.get('large').length)throw Error('filesystem write incomplete');
 await restored.getByRole('button',{name:'保存或分享文件'}).click();
 await page.getByRole('button',{name:'打开应用内文件'}).waitFor();
 if(await page.getByRole('button',{name:'下载到本机',exact:true}).count())throw Error('verified local save still offered another download');
 const beforeCachedOpen=requests;
 await page.evaluate(()=>{window.savedOpen=window.open;window.open=()=>{window.cachedOpen={url:''};return {opener:null,document:{title:'',body:{textContent:''}},location:{replace:url=>{window.cachedOpen.url=url;}},close:()=>{}};};});
 await page.getByRole('button',{name:'打开应用内文件'}).click();
 await restored.getByRole('status').filter({hasText:'已交给浏览器打开，请在新标签页确认'}).waitFor();
 const cachedOpen=await page.evaluate(()=>{window.open=window.savedOpen;return window.cachedOpen;});
 if(!cachedOpen?.url?.startsWith('blob:')||requests!==beforeCachedOpen)throw Error('cached open refetched bytes or claimed more than browser handoff');
 await page.evaluate(()=>window.items[0].attachments.push({id:'bad-save',name:'另一个文件.zip',kind:'file',mime:'application/zip'}));
 files.set('bad-save',files.get('large'));
 const badSave=page.locator('.collab-attachment').filter({hasText:'另一个文件.zip'});
 await page.evaluate(()=>{window.showSaveFilePicker=async()=>({name:'文件.zip',createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}}),getFile:async()=>new File(['bad'],'文件.zip')});});
 await downloadFrom(badSave);await badSave.getByRole('alert').filter({hasText:'保存结果不完整'}).waitFor();
 await page.evaluate(()=>{window.showSaveFilePicker=async()=>{throw new DOMException('cancel','AbortError');};});
 await downloadFrom(badSave,true);await page.waitForTimeout(30);
 if(await badSave.getByRole('alert').count())throw Error('cancelled picker reported as error');
 await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
 // A cold file must be prepared before the browser's gesture-gated share call.
 files.set('share-file',Buffer.from('share to another app'));
 await page.evaluate(()=>{
  window.shareCalls=[];window.clickGesture=false;
  document.addEventListener('click',()=>{window.clickGesture=true;setTimeout(()=>{window.clickGesture=false;},0);},true);
  Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
  Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
   window.shareCalls.push({gesture:window.clickGesture,name:data.files?.[0]?.name,body:await data.files?.[0]?.text()});
   if(!window.shareCalls.at(-1).gesture)throw new DOMException('Share requires a gesture','NotAllowedError');
  }});
  window.items[0].attachments.push({id:'share-file',name:'发给微信.txt',kind:'file',mime:'text/plain'});
 });
 const shareCard=page.locator('.collab-attachment').filter({hasText:'发给微信.txt'});
 await shareCard.getByRole('button',{name:'保存或分享文件'}).click();
 await page.getByRole('button',{name:'用其他应用分享',exact:true}).click();
 await page.getByRole('dialog').getByRole('status').filter({hasText:'文件已准备好，可交给其他应用'}).waitFor();
 const preparedStatusIsErrorColor=await page.getByRole('dialog').getByRole('status').evaluate(element=>{
  const probe=document.createElement('span');probe.style.color='var(--red)';document.body.appendChild(probe);
  const same=getComputedStyle(element).color===getComputedStyle(probe).color;probe.remove();return same;
 });
 if(preparedStatusIsErrorColor)throw Error('normal file preparation is styled as an error');
 if(await page.evaluate(()=>window.shareCalls.length)!==0)throw Error('browser shared after the user gesture expired');
 const preparedRequests=requests;
 await page.getByRole('button',{name:'用其他应用分享已准备好的文件'}).click();
 await page.waitForFunction(()=>window.shareCalls.length===1);
 await shareCard.getByRole('status').filter({hasText:'已交给系统分享方式，请在目标应用确认'}).waitFor();
 const calls=await page.evaluate(()=>window.shareCalls);
 if(calls.length!==1||!calls[0].gesture||calls[0].name!=='发给微信.txt'||calls[0].body!=='share to another app'||requests!==preparedRequests)throw Error('prepared browser file was not shared from a fresh gesture and cache: '+JSON.stringify({calls,requests,preparedRequests,card:await shareCard.innerText(),errors}));
 files.set('open-file',Buffer.from('open from verified cache'));
 await page.evaluate(()=>{
  window.originalOpen=window.open;window.previewCalls=[];
  window.open=()=>{
   const call={gesture:window.clickGesture,url:''};window.previewCalls.push(call);
   return {opener:null,document:{title:'',body:{textContent:''}},location:{replace:url=>{call.url=url;}},close:()=>{call.closed=true;}};
  };
  window.items[0].attachments.push({id:'open-file',name:'直接打开.zip',kind:'file',mime:'application/zip'});
 });
 const openCard=page.locator('.collab-attachment').filter({hasText:'直接打开.zip'});
 await openCard.getByRole('button',{name:'打开文件'}).click();
 await page.waitForFunction(()=>!!window.previewCalls[0]?.url);
 const opened=await page.evaluate(()=>window.previewCalls);
 if(opened.length!==1||!opened[0].gesture||!opened[0].url.startsWith('blob:')||opened[0].closed)throw Error('browser preview was not reserved from the file click');
 await page.evaluate(()=>{window.open=window.originalOpen;});
 // A deliberate tap on an uncached image must open the full image when its
 // in-flight lazy load finishes, without a second tap or an automatic popup.
 files.set('image-slow',files.get('image'));slow=true;
 await page.evaluate(()=>window.items[0].attachments.push({id:'image-slow',name:'新图片.png',kind:'image',mime:'image/png'}));
 const coldImage=page.locator('.collab-attachment').filter({hasText:'新图片.png'});
 await coldImage.getByRole('button',{name:'查看图片'}).click();
 await page.getByRole('dialog').getByRole('img',{name:'新图片.png'}).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();slow=false;
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('horizontal overflow');
 const imageBefore=requests;
 await page.evaluate(()=>{window.mediaContext.thread='other-thread';});
 await page.locator('.collab-attachment').filter({hasText:'预览.png'}).scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);
 if(requests<=imageBefore)throw Error('changed context did not rebuild lazy image observer');
 await page.screenshot({path:'artifacts/collaboration/local-media-preview.png',fullPage:true});
 // New transfer: cancellation and logout must not leak its blob into a new account.
 await page.evaluate(()=>window.items[0].attachments.push({id:'cancel',name:'取消.zip',kind:'file',mime:'application/zip'}));
 const cancel=page.locator('.collab-attachment').filter({hasText:'取消.zip'});slow=true;await cancel.getByRole('button',{name:'保存或分享文件'}).click();await page.getByRole('button',{name:'下载到本机',exact:true}).click();await page.getByRole('button',{name:'确认保存'}).click();await cancel.locator('.file-progress').waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await cancel.getByRole('button',{name:'取消获取',exact:true}).click();await page.evaluate(()=>session.user={username:'account-b'});await page.waitForTimeout(900);
 if(await cancel.getByRole('button',{name:'取消获取',exact:true}).count())throw Error('transfer not cancelled');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('PASS: real Vue image preview, playable generated WebM, PDF opened from verified bytes and downloaded identically, full text, checked multi-chunk download, checksum error, verified filesystem receipt, cancelled picker, fresh-gesture external share and open, browser handoff, observer context reset, cancel/account switch, phone width. Isolated transport fixture.');
}finally{await browser.close();}
