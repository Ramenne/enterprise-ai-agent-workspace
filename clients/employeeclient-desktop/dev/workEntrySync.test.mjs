// Exercise the real Pinia data store with isolated transport/IndexedDB adapters.
// This proves local failure handling, not a production network or browser result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const mocks = {
  '@/platform/localNotify': `export const presentCatchUp=async()=>{};export const presentLive=async()=>{};`,
  '@/api/endpoints': `import {ApiError} from '@/api/client';const state=()=>globalThis.__qnWorkEntry;
    const list=(name,key)=>async()=>{if(state().failed===name)throw new ApiError('network','test_transport_failure',0);return {[key]:[]}};
    export const me={tasks:list('tasks','tasks'),personalProjects:list('projects','projects'),announcements:list('announcements','announcements'),notifications:async()=>{if(state().failed==='notifications')throw new ApiError('network','test_transport_failure',0);return {notifications:[],unread_count:0,sync_version:0,has_more:false,next_cursor:null}}};
    export const company={issues:list('issues','issues'),projectOptions:list('options','projects')};export const control={tasks:list('control','tasks')};`,
  '@/api/client': `export class ApiError extends Error{constructor(code,hint,status){super(hint);this.code=code;this.hint=hint;this.status=status}get needsAuth(){return this.code==='unauthenticated'}}export const isOnline=()=>true;`,
  '@/session/db': `export const getAllByAccount=async()=>[];export const metaGet=async()=>undefined;export const metaRemove=async()=>{};export const putMany=async()=>{};export const clearAccount=async()=>{};export const metaSet=async(a,key,value)=>{globalThis.__qnWorkEntry.writes.push({key,value})};export const clearPersonalScope=async()=>{};export const removeById=async()=>{};export const withLease=valid=>Object.fromEntries(Object.entries({getAllByAccount,metaGet,metaRemove,putMany,clearAccount,metaSet,removeById}).map(([k,fn])=>[k,async(...args)=>valid()?fn(...args):undefined]));`,
};
const compiled = await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia'; export {useDataStore} from './src/store/data.ts';",resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'test-adapters',setup(b){b.onResolve({filter:/^@\//},args=>mocks[args.path]?{path:args.path,namespace:'test-mock'}:{path:resolve(root,'src',args.path.slice(2)+(args.path.endsWith('.mjs')?'':'.ts'))});b.onLoad({filter:/.*/,namespace:'test-mock'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
const {createPinia,setActivePinia,useDataStore}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function fixture(failed){globalThis.__qnWorkEntry={failed,writes:[]};setActivePinia(createPinia());const store=useDataStore();store.setAccount('member-a');return store}
test('successful cursor-backed message sync stamps its own real completion time even when no new messages exist',async()=>{const store=fixture('');await store.syncNotifications('member-a');assert.equal(store.syncError,'');assert.ok(store.lastSyncedAt>0);assert.equal(globalThis.__qnWorkEntry.writes.find(x=>x.key==='notification_synced_at').value,store.lastSyncedAt);});
test('failed message synchronization preserves prior successful time and reports a recoverable error',async()=>{const store=fixture('notifications');store.lastSyncedAt=123;await assert.rejects(store.syncNotifications('member-a'));assert.equal(store.syncError,'network');assert.equal(store.lastSyncedAt,123);assert.equal(globalThis.__qnWorkEntry.writes.some(x=>x.key==='notification_synced_at'),false);});
test('unrelated member hints never claim a message synchronization or query another domain',async()=>{const store=fixture('notifications');store.lastSyncedAt=123;await store.syncNotifications('member-a',false,'live',{kinds:['member_presence']});assert.equal(store.lastSyncedAt,123);assert.equal(globalThis.__qnWorkEntry.writes.length,0);});
