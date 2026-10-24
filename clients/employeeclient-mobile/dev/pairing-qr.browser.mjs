import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import {designCss} from './designCss.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const styles=[];
const result=await build({stdin:{contents:`import {createApp} from 'vue';import View from '@/ui/components/PairScanner.vue';createApp(View,{disabled:false,onScanned:value=>window.scanned=value}).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>({path:resolve(dirname(a.importer),a.path)+(a.path.endsWith('.vue')?'':'.ts'),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onResolve({filter:/^@\//},a=>({path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onLoad({filter:/.*/,namespace:'sfc'},a=>{const{descriptor}=parse(readFileSync(a.path,'utf8'));const id='data-v-'+createHash('sha1').update(a.path).digest('hex').slice(0,8);styles.push(...descriptor.styles.map(s=>compileStyle({source:s.content,filename:a.path,id,scoped:s.scoped}).code));return{contents:compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const view =')+'\nview.__scopeId='+JSON.stringify(id)+';export default view;',loader:'ts',resolveDir:dirname(a.path)};});
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.route('https://scan.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
 await page.goto('https://scan.test/');
 await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(()=>{window.stopped=0;window.calls=0;Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{window.calls++;throw new DOMException('denied','NotAllowedError');},configurable:true});});
 await page.getByRole('button',{name:'扫码连接 Mac'}).click();
 await page.getByRole('alert').filter({hasText:'相机权限未开启'}).waitFor();
 await page.evaluate(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>new Promise(resolve=>window.deliver=resolve),configurable:true});});
 await page.getByRole('button',{name:'扫码连接 Mac'}).click();
 await page.getByRole('button',{name:'取消扫码'}).click();
 await page.evaluate(()=>window.deliver({getTracks:()=>[{stop:()=>window.stopped++}]}));
 await page.waitForFunction(()=>window.stopped===1);
 // Real encoded QR frames through a video stream, not a stubbed decoder.
 const qrBundle=await build({stdin:{contents:"import QRCode from 'qrcode';window.makeQR=QRCode.toCanvas;",resolveDir:process.cwd()},bundle:true,write:false});
 await page.addScriptTag({content:qrBundle.outputFiles[0].text});
 await page.evaluate(async()=>{const c=document.createElement('canvas');await window.makeQR(c,'employeeclient-pair:v1:0123456789ABCDEF',{width:400,margin:4});window.qrCanvas=c;Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const stream=c.captureStream(10);window.stream=stream;setInterval(()=>{c.getContext('2d').drawImage(c,0,0);},100);return stream;},configurable:true});});
 await page.getByRole('button',{name:'扫码连接 Mac'}).click();
 await page.waitForFunction(()=>window.scanned==='0123456789ABCDEF');
 if(!await page.evaluate(()=>window.stream.getTracks().every(t=>t.readyState==='ended')))throw new Error('camera left running');
 console.log('PASS camera denial, cancellation during permission request, QR video decoding and stream release');
} finally { await browser.close(); }
