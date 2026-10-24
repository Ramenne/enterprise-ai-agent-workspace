// Public, read-only release smoke test. Does not log in or create production records.
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const dir=process.argv[2];
if(!dir)throw Error('usage: node dev/publicRelease.browser.cjs RELEASE_DIRECTORY');
const manifest=JSON.parse(fs.readFileSync(dir+'/latest.json'));
const freeze=JSON.parse(fs.readFileSync(dir+'/发布冻结清单.json'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const response=await page.goto('https://employeeclient.dominolif.com/',{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.getByRole('button',{name:'通过身份权限服务连接',exact:true}).waitFor();
  const script=await page.locator('script[type=module]').getAttribute('src');
  assert.ok(Object.keys(freeze.static_files).includes(script.replace(/^\.\//,'')));
  const live=await page.evaluate(async()=>{const r=await fetch('/updates/android/latest.json',{cache:'no-store'});if(!r.ok)throw Error('manifest HTTP '+r.status);return r.json()});
  assert.deepEqual(live,manifest);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.evaluate(()=>!!navigator.serviceWorker.controller),true);
  await page.getByRole('button',{name:'通过身份权限服务连接',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  await page.screenshot({path:dir+'/Public-v'+manifest.versionCode+'-login.png'});
  console.log(JSON.stringify({versionCode:live.versionCode,versionName:live.versionName,script,publicBoot:'passed',publicManifest:'matched',serviceWorkerControlled:true,runtimeErrors:errors,scope:'anonymous read-only smoke; not authenticated or physical-device acceptance'}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
