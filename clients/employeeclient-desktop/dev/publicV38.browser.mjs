// Read-only production boot, service worker and manifest check. No login or writes.
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://employeeclient.dominolif.com/',{waitUntil:'networkidle'});
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload({waitUntil:'networkidle'});
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const result=await page.evaluate(async()=>({script:document.querySelector('script[type=module]')?.getAttribute('src'),controlled:!!navigator.serviceWorker.controller,manifest:await fetch('/updates/android/latest.json',{cache:'no-store'}).then(r=>r.json())}));
 assert.equal(result.manifest.versionCode,38);assert.equal(result.manifest.versionName,'1.37-test');
 assert.equal(result.manifest.packageName,'com.workspace.employeeclient');assert.equal(result.controlled,true);
 assert.equal(new URL(result.script,'https://employeeclient.dominolif.com/').pathname,'/assets/index-BG3iOUMQ.js');assert.equal(errors.length,0);
 await page.screenshot({path:'/tmp/qn-v38-verification/public-boot-390.png',fullPage:true});
 const report={...result,errors,updateAvailableFrom37:result.manifest.versionCode>37,nativeDeviceChecked:false};
 writeFileSync('/tmp/qn-v38-verification/public-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
