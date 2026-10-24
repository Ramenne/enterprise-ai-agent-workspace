import test from 'node:test';import assert from 'node:assert/strict';
import {createHubCache} from '../src/native/hub-cache.mjs';
import {myProjects} from '../src/native/discovery.mjs';
import {reactive} from 'vue';
import {jsonSnapshot} from '../src/session/jsonSnapshot.mjs';
function setup(){const db=new Map();let clock=1;const cache=createHubCache({get:async(a,k)=>db.get(a+k),put:async(a,k,v,valid)=>{if(valid())db.set(a+k,structuredClone(v));},remove:async(a,k)=>db.delete(a+k),now:()=>clock});return {cache,db,advance:()=>clock+=1000};}
const lease=a=>({account:a,epoch:1,valid:()=>true});
test('parallel navigation shares a real read and later entry uses its snapshot',async()=>{
 const f=setup();let calls=0,release;const wait=new Promise(r=>release=r);const load=async()=>{calls++;await wait;return ['actual'];};
 const reads=[f.cache.read(lease('a'),'works',load),f.cache.read(lease('a'),'works',load)];await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();await Promise.all(reads);
 const seen=[];assert.deepEqual(await f.cache.read(lease('a'),'works',load,{onSnapshot:v=>seen.push(v)}),['actual']);assert.equal(calls,1);assert.deepEqual(seen,[['actual']]);
});
test('temporary background errors retain the visible snapshot, explicit denial removes it',async()=>{
 const f=setup();await f.cache.read(lease('a'),'works',async()=>['actual']);const seen=[];
 await assert.rejects(f.cache.read(lease('a'),'works',async()=>{throw Object.assign(Error('temporary'),{status:503});},{force:true,onSnapshot:v=>seen.push(v)}));assert.deepEqual(seen,[['actual']]);
 assert.deepEqual(await f.cache.read(lease('a'),'works',async()=>['wrong']),['actual']);
 await assert.rejects(f.cache.read(lease('a'),'works',async()=>{throw Object.assign(Error('denied'),{status:403});},{force:true}));assert.equal(f.db.size,0);
 assert.deepEqual(await f.cache.read(lease('a'),'works',async()=>[]),[]);
});
test('account switch blocks a late write and never returns another member snapshot',async()=>{
 const f=setup();await f.cache.read(lease('a'),'works',async()=>['A']);assert.deepEqual(await f.cache.read(lease('b'),'works',async()=>['B']),['B']);
 let active=true,release;const read=f.cache.read({account:'a',epoch:2,valid:()=>active},'detail',()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));active=false;release('late');await assert.rejects(read,/session_changed/);assert.equal([...f.db.keys()].some(k=>k.includes('detail')),false);
});
test('my projects include current authorized teams and own personal, never foreign public personal',()=>{
 const rows=[{project_id:'mine',visibility:'personal',owner_id:'a'},{project_id:'foreign',visibility:'personal',owner_id:'b'},{project_id:'team',visibility:'team',owner_id:'b',_member_related:true},{project_id:'private',visibility:'private',owner_id:'a'},{project_id:'unrelated-team',visibility:'team',owner_id:'b'}];
 assert.deepEqual(myProjects(rows,'a').map(p=>p.project_id),['mine','team','private']);
});

test('a new app instance restores the same member snapshot before delayed refresh, never another member cache',async()=>{
 const db=new Map(),make=()=>createHubCache({get:async(a,k)=>db.get(a+k),put:async(a,k,v)=>db.set(a+k,structuredClone(v)),remove:async(a,k)=>db.delete(a+k),now:()=>1000000});
 await make().read(lease('a'),'catalog:search:p',async()=>({rows:[{short_no:1000133}],complete:true}));
 const seen=[];let finish;const refresh=make().read(lease('a'),'catalog:search:p',()=>new Promise(r=>finish=r),{force:true,onSnapshot:x=>seen.push(x)});
 await new Promise(r=>setImmediate(r));assert.equal(seen[0].rows[0].short_no,1000133);finish({rows:[{short_no:1000172}],complete:true});await refresh;
 const other=[];await make().read(lease('b'),'catalog:search:p',async()=>({rows:[],complete:true}),{onSnapshot:x=>other.push(x)});assert.equal(other.length,0);
});

test('reactive project attributes persist across a cold app replacement, without another full read',async()=>{
 const db=new Map(),make=()=>createHubCache({get:async(a,k)=>db.get(a+k),put:async(a,k,v)=>db.set(a+k,structuredClone(v)),remove:async(a,k)=>db.delete(a+k)});
 const project=reactive({properties:{attributes:{category:'工作协作'}}});let calls=0;
 const load=async()=>{calls++;return {rows:[{short_no:1000133,projectProperties:project.properties}],complete:true};};
 await make().read(lease('a'),'catalog:work:p',load);
 assert.equal(db.size,1,'must actually commit a structured-cloneable snapshot');
 project.properties.attributes.category='changed after save';
 const restored=await make().read(lease('a'),'catalog:work:p',load);
 assert.equal(restored.rows[0].projectProperties.attributes.category,'工作协作');
 assert.equal(calls,1);
});

test('view filters and nested cached entities have plain JSON values for IndexedDB',()=>{
 const selected=reactive({'properties.attributes.work_no':'1000133'});
 const view=structuredClone(jsonSnapshot({project:'p',query:'#1000133',selected}));
 selected['properties.attributes.work_no']='1000172';
 assert.deepEqual(view,{project:'p',query:'#1000133',selected:{'properties.attributes.work_no':'1000133'}});
});
