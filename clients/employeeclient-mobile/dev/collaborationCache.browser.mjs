import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const bundle=await build({stdin:{contents:"import * as cache from './src/collaboration/readCache.ts';window.cache=cache;",resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const context=await browser.newContext();
 await context.route('https://cache.test/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));
 async function open(){const p=await context.newPage();await p.goto('https://cache.test');await p.addScriptTag({content:bundle.outputFiles[0].text});return p;}
 const first=await open();
 await first.evaluate(async()=>{
  const c=window.cache;
  for(let i=0;i<40;i++)c.writeCache(c.cacheKey('a','mac','codex','thread:'+i),{text:'长历史'.repeat(100000),id:i});
  c.writeCache(c.cacheKey('b','mac','codex','thread:0'),{text:'other account'});
  // A cache miss waits for pending writes, so this is also a durability barrier.
  await c.readCache(c.cacheKey('a','mac','codex','missing'));
 });
 await first.close();
 const second=await open();
 await second.evaluate(async()=>{
  const c=window.cache;
  for(let i=0;i<40;i++){
   const r=await c.readCache(c.cacheKey('a','mac','codex','thread:'+i));
   if(r?.value.text.length!==300000||r.value.id!==i)throw Error('persisted history was evicted/truncated '+i);
  }
  const removed=c.cacheKey('a','mac','codex','thread:39');c.writeCache(removed,{text:'stale pending save'});c.removeReadCache(removed);
  if(await c.readCache(removed))throw Error('pending save resurrected deleted history');
  c.clearReadCache('a');await c.readCache('barrier');
 });
 const third=await open();
 await third.evaluate(async()=>{
  const c=window.cache;
  if(await c.readCache(c.cacheKey('a','mac','codex','thread:0')))throw Error('logout retained account cache');
  if(!(await c.readCache(c.cacheKey('b','mac','codex','thread:0'))))throw Error('logout erased another account');
 });
 console.log('PASS: 40 conversations / 12 million characters survive fresh page; ordered deletion and account clearing.');
}finally{await browser.close();}
