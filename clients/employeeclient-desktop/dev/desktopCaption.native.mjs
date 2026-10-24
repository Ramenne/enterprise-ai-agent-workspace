import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {mkdirSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {startMediaForwardPreview} from './mediaForward.preview.mjs';
const {_electron}=createRequire(import.meta.url)('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');const out='../window-chrome-20261021';mkdirSync(out,{recursive:true});const server=startMediaForwardPreview(5379);await new Promise(r=>server.listening?r():server.once('listening',r));const origin='http://127.0.0.1:5379';const result={scope:'real macOS windows with simulated local accounts; system captures include native caption controls',cases:[]};
try{for(const version of ['0.2.7','0.2.8']){let app;try{
 app=await _electron.launch({executablePath:fileURLToPath(new URL(`../../delivery/${version}-arm64/员工客户端.app/Contents/MacOS/Electron`,import.meta.url)),env:{...process.env,EMPLOYEECLIENT_DESKTOP_QA_ORIGIN:origin}});await app.evaluate(async({session})=>session.defaultSession.cookies.set({url:'http://127.0.0.1:5379',name:'simulation_member',value:'sim-a'}));const page=await app.firstWindow();await page.goto(origin);await page.locator('.sidebar-account').click();await page.locator('.profile-page').waitFor();
 for(const zoom of version==='0.2.7'?[.9]:[1,.9]){
  await app.evaluate(({BrowserWindow},z)=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z),zoom);
  await page.waitForFunction(({fixed,z})=>!fixed||Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--desktop-rail-width'))-Math.max(72,72/z))<.1,{fixed:version==='0.2.8',z:zoom});
  const metrics=await page.locator('.sidebar').evaluate(e=>{const b=e.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width,dragWidth:parseFloat(getComputedStyle(e,'::before').width)};});
  const id=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getMediaSourceId());const image=`${out}/${version}-settings-${zoom}.png`;execFileSync('/usr/sbin/screencapture',['-x','-o','-l',id.split(':')[1],image]);
  result.cases.push({version,zoom,metrics,image,nativeRailRight:metrics.right*zoom});if(version==='0.2.8'){assert.ok(metrics.right*zoom>=71.9);assert.ok(Math.abs(metrics.width-metrics.dragWidth)<.1);}
 }
 if(version==='0.2.8'){
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setZoomFactor(1);w.setSize(800,650);});await page.getByRole('button',{name:'消息',exact:true}).first().click();await page.locator('.desktop-conversations .conversation-row').filter({hasText:'文件传输助手'}).click();await page.locator('.message-input:not([disabled])').waitFor();const input=page.locator('.desktop-conversations .conversation-search input');await input.click();assert.ok(await input.evaluate(e=>document.activeElement===e));assert.ok(await page.locator('.chat-page').evaluate(e=>e.clientWidth>300));result.searchStillClickable=true;result.narrowWindow=true;
 }
 }finally{await app?.close();}}
 result.completed=true;
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync(out+'/native-caption-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
