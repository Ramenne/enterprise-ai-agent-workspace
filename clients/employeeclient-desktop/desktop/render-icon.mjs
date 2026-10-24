import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
try{
 const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
 await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block}</style>'+readFileSync(new URL('./assets/app-icon.svg',import.meta.url),'utf8'));
 await page.screenshot({path:fileURLToPath(new URL('./assets/app-icon.png',import.meta.url)),omitBackground:true});
}finally{await browser.close();}
