import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dir='/tmp/employeeclient-connect.iconset';mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});await page.setContent('<style>body{margin:0;background:transparent}</style>'+readFileSync('connector-mac/assets/员工客户端连接.svg','utf8'));await page.screenshot({path:dir+'/base.png',omitBackground:true});}finally{await browser.close()}
for(const n of [16,32,128,256,512])for(const scale of [1,2])execFileSync('/usr/bin/sips',['-z',String(n*scale),String(n*scale),dir+'/base.png','--out',dir+`/icon_${n}x${n}${scale===2?'@2x':''}.png`],{stdio:'ignore'});
execFileSync('/usr/bin/iconutil',['-c','icns',dir,'-o','connector-mac/assets/员工客户端连接.icns']);
console.log('Rendered existing EmployeeClient vector mark with connection badge to macOS icon');
