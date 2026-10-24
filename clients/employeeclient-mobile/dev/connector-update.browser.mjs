import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const update={current:48,state:'available',latest:48,message:'发现新版 V48'};
const state={enabled:true,connected:true,owner:'test-account',name:'办公 Mac',error:'',name_synced:false,update};
const calls=[];
try {
 const page=await browser.newPage({viewport:{width:840,height:950}});
 await page.route('http://connector.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/state')return route.fulfill({json:state});
  if(route.request().method()==='POST') {
   calls.push(path);
   if(path==='/rename')state.name=route.request().postDataJSON().name;
   if(path==='/update/download')Object.assign(update,{state:'downloading',message:'正在下载',percent:30,downloaded:3*1048576,total:10*1048576});
   if(path==='/update/install')Object.assign(update,{state:'waiting',message:'等待当前手机请求结束，随后自动安装…'});
   return route.fulfill({json:{ok:true}});
  }
  return route.fulfill({contentType:path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html',body:readFileSync('connector-mac/web/'+(path==='/'?'index.html':path.slice(1)))});
 });
 await page.goto('http://connector.test/#local-test-token');
 await page.getByLabel('电脑名称').fill('新的 Mac 名称');await page.getByRole('button',{name:'保存名称',exact:true}).click();
 await page.getByRole('button',{name:'已保存',exact:true}).waitFor();
 if(state.name!=='新的 Mac 名称')throw Error('name not submitted');
 state.name_synced=true;await page.getByText('已保存并同步',{exact:true}).waitFor();
 await page.getByRole('button',{name:'下载更新',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('progress').value===30);
 if(!await page.getByText('30% · 3.0 / 10.0 MB',{exact:true}).isVisible())throw Error('progress missing');
 Object.assign(update,{state:'ready',percent:100,message:'下载并校验完成，可以安装',destination:'/Users/developer/Applications/EmployeeClientConnector.app'});
 await page.getByRole('button',{name:'安装并重启',exact:true}).waitFor();
 mkdirSync('artifacts/collaboration',{recursive:true});await page.screenshot({path:'artifacts/collaboration/v48-mac-update.png'});
 await page.getByRole('button',{name:'安装并重启',exact:true}).click();
 await page.getByText('等待当前手机请求结束，随后自动安装…',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'检查更新',exact:true}).isEnabled())throw Error('waiting allows competing update');
 if(await page.getByRole('button',{name:'安装并重启',exact:true}).isVisible())throw Error('waiting asks for second install click');
 state.credential_state='loading';state.owner=null;
 await page.getByText('正在读取已有配对 · 请留意 macOS 钥匙串授权提示',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'显示配对二维码',exact:true}).isVisible())throw Error('loading credentials must not offer re-pairing');
 state.credential_state='error';state.credential_error='请允许钥匙串';
 await page.getByRole('button',{name:'重新读取配对',exact:true}).waitFor();
 await page.getByRole('button',{name:'重新读取配对',exact:true}).click();
 if(!calls.includes('/credentials/retry'))throw Error('retry not wired');
 Object.assign(update,{state:'restarting',message:'正在安装并重启'});
 await page.getByText('正在安装并重启',{exact:true}).waitFor();
 if(calls.filter(p=>p==='/update/install').length!==1)throw Error('install repeated');
 console.log('PASS connector UI: rename saved/synced feedback, progress bytes/percent, ready/install/restart. Fixture only.');
} finally {await browser.close()}
