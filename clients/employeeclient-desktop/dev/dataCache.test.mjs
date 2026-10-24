// Exercise the actual data store with real Vue/Pinia; network and persistence are controlled adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createPinia, defineStore } from 'pinia';
import { ref, computed, watch, onScopeDispose } from 'vue';
const text = await readFile(new URL('../src/store/data.ts', import.meta.url),'utf8');
const compiled = ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
class ApiError extends Error {
  constructor(code,hint,status) { super(hint); Object.assign(this,{code,status}); }
  get retryable(){return ['network','upstream_unavailable','provider_unavailable'].includes(this.code);}
  get needsAuth(){return this.code==='unauthenticated';}
}
async function fixture(t) {
  const meta=new Map(), entities=new Map();
  const denied=new Set();const faults={marker:false,drafts:false,clear:false};let draftPurges=0;
  const isPersonalRecord=r=>!!r&&(r.scope==='personal'||r.scope_at_creation==='personal'||r.snapshot?.scope==='personal');
  const db={
    metaRemove:async(a,k)=>{meta.delete(a+':'+k);},
    clearPersonalScope:async(a)=>{
      for(const [k,v] of meta) if(k.startsWith(a+':')&&Array.isArray(v)) meta.set(k,k===a+':list:projects'?[]:v.filter(x=>!isPersonalRecord(x)));
      for(const [k,v] of entities) if(k.startsWith(a+':')) entities.set(k,v.filter(x=>!isPersonalRecord(x)));
    },
    metaGet:async(a,k)=>structuredClone(meta.get(a+':'+k)??null),
    metaSet:async(a,k,v)=>{meta.set(a+':'+k,structuredClone(v));},
    getAllByAccount:async(s,a)=>structuredClone(entities.get(a+':'+s)||[]),
    clearAccount:async(a)=>{if(faults.clear)throw Error('idb unavailable');for(const k of meta.keys())if(k.startsWith(a+':'))meta.delete(k);},
  };
  db.withLease = valid => ({metaSet:async(...args)=>{if(valid())return db.metaSet(...args);}});
  const me={tasks:async()=>({tasks:[]}),personalProjects:async()=>({projects:[]}),announcements:async()=>({announcements:[]}), taskContext:async()=>({task:{id:'t'}}),issueDetail:async()=>({issue:{id:'i'}})};
  const company={issues:async()=>({issues:[]}),projectOptions:async()=>({projects:[]}),issueDetail:async()=>({issue:{id:'i'}})};
  const control={tasks:async()=>({tasks:[]}),taskContext:async()=>({task:{id:'t'}})};
  const key='__cache_test_'+Math.random().toString(36).slice(2);
  globalThis[key]={defineStore,ref,computed,watch,onScopeDispose,me,company,control,ApiError,isOnline:()=>true,db,
    personalDenied:a=>denied.has(a),holdPersonal:a=>denied.add(a),denyPersonal:a=>{denied.add(a);if(faults.marker)throw Error('quota');},allowPersonal:a=>denied.delete(a),isPersonalRecord,clearPersonalDrafts:()=>{draftPurges++;if(faults.drafts)throw Error('storage denied');},
    isNewArrival:()=>false,isCursorRestartHint:()=>false,isFloatingEligible:()=>false,ghostIdsToEvict:()=>[],isAwaitingReview:()=>true,reconcileTaskArchives:()=>{}};
  const mod=await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(globalThis[key]).join(',')}}=globalThis[${JSON.stringify(key)}];\n`+compiled).toString('base64'));
  const stores=[];
  const create=()=>{const s=mod.useDataStore(createPinia());stores.push(s);return s;};
  t.after(()=>{for(const s of stores)s.$dispose();delete globalThis[key];});
  return {store:create(),create,meta,entities,me,company,control,faults,denied,get draftPurges(){return draftPurges;}};
}
for(const [method,endpoint] of [['loadTaskContext','taskContext'],['loadMeIssue','issueDetail'],['loadCompanyIssue','issueDetail']]) {
  test(method+': old A request cannot populate B or a new A session; authorization denial never falls back',async t=>{
    const f=await fixture(t),s=f.store,api=method==='loadCompanyIssue'?f.company:f.me;
    s.setAccount('a');let finish;api[endpoint]=()=>new Promise(r=>finish=r);
    const old=s[method]('same','me');const rejected=assert.rejects(old,e=>e instanceof ApiError&&e.status===401);
    s.setAccount('b');s.setAccount('a');finish({secret:'old session'});await rejected;
    api[endpoint]=async()=>{throw new ApiError('network','offline',0);};
    await assert.rejects(s[method]('same','me'));
    api[endpoint]=async()=>({secret:'current'});await s[method]('same','me');
    for(const status of [401,403,404]) {
      api[endpoint]=async()=>{throw new ApiError('not_found','denied',status);};
      await assert.rejects(s[method]('same','me'),e=>e.status===status);
    }
    s.setAccount('b');api[endpoint]=async()=>{throw new ApiError('network','offline',0);};await assert.rejects(s[method]('same','me'));
  });
}
test('task namespace caches remain separate; only transient network failure may reuse current cache',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');await s.loadTaskContext('t','me');
  f.me.taskContext=async()=>{throw new ApiError('network','offline',0);};assert.equal((await s.loadTaskContext('t','me')).task.id,'t');
  f.control.taskContext=f.me.taskContext;await assert.rejects(s.loadTaskContext('t','control'));
});
test('scope denial purges personal projections and blocks delayed details without clearing company account',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');
  f.me.tasks=async()=>({tasks:[{id:'private',scope_at_creation:'personal'},{id:'company',scope_at_creation:'company'}]});
  f.me.personalProjects=async()=>({projects:[{id:'p',scope:'personal'}]});
  await s.syncLists('a');
  let finish;f.me.taskContext=()=>new Promise(r=>finish=r);
  const old=s.loadTaskContext('private','me');const rejected=assert.rejects(old);
  f.me.personalProjects=async()=>{throw new ApiError('forbidden_scope','personal_principal_required',403);};
  await s.syncLists('a');finish({task:{id:'private'}});await rejected;
  assert.equal(s.account,'a');assert.equal(s.personalBlocked,true);
  assert.deepEqual(s.tasks.map(x=>x.id),['company']);assert.deepEqual(s.personalProjects,[]);
  assert.deepEqual(f.meta.get('a:list:tasks').map(x=>x.id),['company']);
  const reboot=f.create();await reboot.hydrateFromCache('a');
  assert.equal(reboot.personalBlocked,true);assert.deepEqual(reboot.tasks.map(x=>x.id),['company']);
  f.me.personalProjects=async()=>({projects:[{id:'p',scope:'personal'}]});
  await reboot.syncLists('a');assert.equal(reboot.personalBlocked,false);assert.equal(reboot.personalProjects.length,1);
});
test('temporary personal network failure preserves content; old-session denial cannot revoke new session',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');s.personalProjects=[{id:'p',scope:'personal'}];
  f.me.personalProjects=async()=>{throw new ApiError('network','offline',0);};
  await assert.rejects(s.syncLists('a'));assert.equal(s.personalProjects.length,1);assert.equal(s.personalBlocked,false);
  let reject;f.me.personalProjects=()=>new Promise((_,r)=>reject=r);
  const old=s.syncLists('a');s.setAccount('b');s.setAccount('a');
  reject(new ApiError('forbidden_scope','personal_principal_required',403));await old;
  assert.equal(s.personalBlocked,false);
});
test('scope denial purges re-fetchable cache but never original local drafts, even when marker write fails',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');
  f.meta.set('a:list:projects',[{id:'p',scope:'personal'}]);f.faults.marker=true;f.faults.drafts=true;
  await s.revokePersonal();assert.deepEqual(f.meta.get('a:list:projects'),[]);assert.ok(s.personalCleanupError);assert.equal(f.draftPurges,0);
  f.denied.clear();f.meta.set('a:list:projects',[{id:'residue',scope:'personal'}]);
  const reboot=f.create();await reboot.hydrateFromCache('a');
  assert.deepEqual(reboot.personalProjects,[]);assert.equal(reboot.personalBlocked,true);
});
test('successful list snapshots (including empty) survive offline rehydrate without resurrecting old entities',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');
  f.entities.set('a:tasks',[{id:'old'}]);f.entities.set('a:issues',[{id:'old-issue'}]);
  await s.syncLists('a');assert.deepEqual(s.tasks,[]);
  const next=f.create();await next.hydrateFromCache('a');assert.deepEqual(next.tasks,[]);assert.deepEqual(next.companyIssues,[]);
  assert.equal(f.entities.get('a:issues').length,1,'window snapshot is not authority to delete entities');
});

test('200-row window is cached as window, not global deletion; failed composite Task fetch preserves previous snapshot',async t=>{
  const f=await fixture(t),s=f.store;s.setAccount('a');
  f.entities.set('a:issues',[{id:'outside-page'}]);f.company.issues=async()=>({issues:Array.from({length:200},(_,i)=>({id:String(i)}))});
  f.me.tasks=async()=>({tasks:[{id:'mine'}]});s.setMainControl(true);f.control.tasks=async()=>({tasks:[{id:'review'}]});
  await s.syncLists('a');f.control.tasks=async()=>{throw new ApiError('network','offline',0);};f.me.tasks=async()=>({tasks:[]});
  await assert.rejects(s.syncLists('a'));assert.equal(s.tasks.length,2);
  const next=f.create();await next.hydrateFromCache('a');assert.equal(next.tasks.length,2);assert.equal(next.companyIssues.length,200);
  assert.equal(f.entities.get('a:issues')[0].id,'outside-page');
});
