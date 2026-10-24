import test from 'node:test';import assert from 'node:assert/strict';
import {createStoragePersistence} from '../src/session/persistentStorage.mjs';
test('concurrent and repeated startup requests share one persistence request',async()=>{
 let reads=0,requests=0;const ensure=createStoragePersistence({storage:{persisted:async()=>{reads++;return false;},persist:async()=>{requests++;return true;}}});
 assert.deepEqual(await Promise.all([ensure(),ensure(),ensure()]),Array(3).fill({state:'granted'}));await ensure();assert.equal(reads,1);assert.equal(requests,1);
});
test('already persistent origin never requests permission again',async()=>{
 const ensure=createStoragePersistence({storage:{persisted:async()=>true,persist:async()=>{throw Error('must not request');}}});assert.deepEqual(await ensure(),{state:'granted'});
});
test('browser refusal is a bounded non-fatal result',async()=>{
 let n=0;const ensure=createStoragePersistence({storage:{persist:async()=>{n++;return false;}}});assert.deepEqual(await ensure(),{state:'denied'});await ensure();assert.equal(n,1);
});
test('unsupported or insecure contexts do not invoke persistence',async()=>{
 assert.deepEqual(await createStoragePersistence()(),{state:'unsupported'});
 assert.deepEqual(await createStoragePersistence({secure:false,storage:{persist:()=>{throw Error('must not request');}}})(),{state:'unsupported'});
});
test('browser exceptions never reject the login workflow',async()=>{
 assert.deepEqual(await createStoragePersistence({storage:{persisted:async()=>{throw Error('blocked');},persist:async()=>true}})(),{state:'unavailable'});
});
