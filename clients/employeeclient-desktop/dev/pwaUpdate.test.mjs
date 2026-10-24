import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const result=await build({stdin:{contents:await readFile(new URL('../src/platform/pwaUpdate.ts',import.meta.url),'utf8'),loader:'ts'},write:false,format:'esm'});
const {bindPwaUpdates}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const settle=()=>new Promise(r=>setImmediate(r));
test('startup and foreground/online events check updates without periodic reload',async()=>{const page=new EventTarget(),host=new EventTarget();page.visibilityState='visible';let calls=0;const stop=bindPwaUpdates({update:async()=>{calls++}},page,host);await settle();assert.equal(calls,1);page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(calls,1);page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));await settle();host.dispatchEvent(new Event('online'));await settle();assert.equal(calls,3);stop();host.dispatchEvent(new Event('pageshow'));await settle();assert.equal(calls,3);});
test('concurrent update checks coalesce and offline failure permits event retry',async()=>{const page=new EventTarget(),host=new EventTarget();page.visibilityState='visible';let calls=0,reject;const stop=bindPwaUpdates({update:()=>{calls++;return new Promise((r,j)=>reject=j)}},page,host);host.dispatchEvent(new Event('online'));assert.equal(calls,1);reject(Error('offline'));await settle();host.dispatchEvent(new Event('pageshow'));assert.equal(calls,2);stop();reject(Error('offline'));await settle();});
