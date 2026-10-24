import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,stat } from 'node:fs/promises';
import { VerifiedByteCache } from '../source/apps/mem/src/verified-cache.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('fixed bytes are verified once for three sequential or simultaneous chunk leases',async()=>{
 const bytes=Buffer.alloc(1024*1024,65);let reads=0;
 const adapter={mode:'real',copyToImmutable:async()=>{},read:async()=>{reads++;return(async function*(){yield bytes;})();}};
 const cache=new VerifiedByteCache(adapter);const ref={provider:'synthetic-fixture',bucket:'test',key:'fixed',versionId:'v1'};const expected={sha256:hash(bytes),size:bytes.length};
 try{const leases=await Promise.all([cache.acquire(ref,expected),cache.acquire(ref,expected),cache.acquire(ref,expected)]);
  assert.equal(reads,1);assert.equal((await stat(leases[0].path)).mode&0o777,0o600);assert.deepEqual(await readFile(leases[0].path),bytes);
  for(const lease of leases)await lease.cleanup();
  const next=await cache.acquire(ref,expected);assert.equal(reads,1);assert.equal(next.cache_hit,true);await next.cleanup();
 }finally{await cache.close();}
});
test('changed cached bytes are not trusted and fixed versions remain separate',async()=>{
 const bytes=Buffer.from('original fixed bytes');let reads=0;
 const adapter={mode:'real',copyToImmutable:async()=>{},read:async()=>{reads++;return(async function*(){yield bytes;})();}};
 const cache=new VerifiedByteCache(adapter);const ref={provider:'synthetic-fixture',bucket:'test',key:'fixed',versionId:'v1'};const expected={sha256:hash(bytes),size:bytes.length};
 try{const first=await cache.acquire(ref,expected);await first.cleanup();await writeFile(first.path,'altered');
  const repaired=await cache.acquire(ref,expected);assert.equal(reads,2);assert.deepEqual(await readFile(repaired.path),bytes);await repaired.cleanup();
  const newer=await cache.acquire({...ref,versionId:'v2'},expected);assert.equal(reads,3);await newer.cleanup();
 }finally{await cache.close();}
});
test('a corrupt provider cannot warm the cache',async()=>{
 const adapter={mode:'real',copyToImmutable:async()=>{},read:async()=>async function*(){yield Buffer.from('wrong');}()};
 const cache=new VerifiedByteCache(adapter);
 try{await assert.rejects(cache.acquire({provider:'fixture',bucket:'test',key:'fixed',versionId:'v1'},{sha256:hash('right'),size:5}),e=>e.code==='object_integrity_mismatch');}
 finally{await cache.close();}
});

test('idle timer prunes expired bytes without another request and preserves active readers',async()=>{
 const bytes=Buffer.from('timer cleanup fixture');
 const adapter={mode:'real',copyToImmutable:async()=>{},read:async()=>async function*(){yield bytes;}()};
 const cache=new VerifiedByteCache(adapter,1024,20);
 const ref={provider:'fixture',bucket:'test',key:'fixed',versionId:'v1'},expected={sha256:hash(bytes),size:bytes.length};
 try{const held=await cache.acquire(ref,expected);await new Promise(r=>setTimeout(r,80));assert.deepEqual(await readFile(held.path),bytes);
 await held.cleanup();await new Promise(r=>setTimeout(r,100));await assert.rejects(stat(held.path),{code:'ENOENT'});
 }finally{await cache.close();}
});
