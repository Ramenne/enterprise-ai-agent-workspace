import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const mocks = {
  '@/api/endpoints': `export const communication={members:async()=>globalThis.__chat.members?globalThis.__chat.members():({members:[]}),message:(...args)=>globalThis.__chat.message(...args),messages:(...args)=>globalThis.__chat.messages(...args),send:(...args)=>globalThis.__chat.send(...args),changes:(...args)=>globalThis.__chat.changes(...args),changeMessage:(...args)=>globalThis.__chat.changeMessage(...args)};`,
  '@/api/client': `export class ApiError extends Error {constructor(code,hint,status){super(hint);this.status=status}}let seq=0;export const newIdempotencyKey=()=>String(++seq);`,
  '@/session/db': `export const metaGet=async(a,k)=>globalThis.__chat.get?globalThis.__chat.get(a,k):globalThis.__chat.cache.get(a+':'+k)||null;export const metaSet=async(a,k,v)=>{globalThis.__chat.cache.set(a+':'+k,structuredClone(v));};`,
};
const compiled=await build({stdin:{contents:"export {createPinia,setActivePinia} from 'pinia';export {ApiError} from '@/api/client';export {useChatStore} from './src/store/chat.ts';",resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'transport',setup(b){b.onResolve({filter:/^@\//},args=>mocks[args.path]?{path:args.path,namespace:'adapters'}:{path:resolve(root,'src',args.path.slice(2)+(args.path.endsWith('.mjs')?'':'.ts'))});b.onLoad({filter:/.*/,namespace:'adapters'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
const {createPinia,setActivePinia,useChatStore,ApiError}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const message=seq=>({id:'m'+seq,seq,body:'message '+seq,author_username:'a',author_name:'A',mention_usernames:[],reply_to:null,attachments:[],created_at:seq});
async function fixture(){globalThis.__chat={cache:new Map(),messages:async()=>({messages:[],next_cursor:0,has_more:false}),send:async()=>({message:message(1)})};setActivePinia(createPinia());const store=useChatStore();await store.setAccount('a');return store;}
test('off-window recalled original updates loaded quotes and survives recreation without old text',async()=>{
 const s=await fixture(),original={...message(1),change_version:1},quoted={...message(100),reply_to:original,change_version:2};s.messages=[quoted];s.acceptChange('a','',{...original,body:'',recalled:true,change_version:10});assert.equal(s.messages.length,1);assert.equal(s.messages[0].reply_to.recalled,true);assert.equal(s.messages[0].reply_to.body,'');await new Promise(r=>setImmediate(r));setActivePinia(createPinia());const restored=useChatStore();await restored.setAccount('a');assert.equal(restored.messages[0].reply_to.recalled,true);assert.equal(restored.messages[0].reply_to.body,'');
});
test('old snapshots with consumed recall cursors revalidate unique quote IDs without dropping loaded pages',async()=>{
 let s=await fixture();const cache=globalThis.__chat.cache,quote={...message(1),change_version:1},rows=Array.from({length:120},(_,i)=>({...message(100+i),reply_to:i%2?quote:null,change_version:i+2}));cache.set('a:chat_snapshot',{schema:3,messages:rows,cursor:219,changeCursor:999,canLoadOlder:true});
 const reads=[];globalThis.__chat.message=async id=>{reads.push(id);return {message:{...quote,body:'',recalled:true,change_version:900}};};globalThis.__chat.messages=async q=>{assert.equal(q.after,219);return {messages:[],next_cursor:219,has_more:false};};globalThis.__chat.changes=async()=>({changes:[],next_change_cursor:999,has_more:false});
 setActivePinia(createPinia());s=useChatStore();await s.setAccount('a');await s.refresh();assert.equal(s.messages.length,120);assert.equal(s.messages.filter(m=>m.reply_to).every(m=>m.reply_to.recalled&&m.reply_to.body===''),true);assert.deepEqual(reads,['m1']);assert.equal(cache.get('a:chat_snapshot').quoteProjection,1);await s.refresh();assert.equal(reads.length,1);
});
test('ambiguous send persists and retries immutable body with same key',async()=>{const s=await fixture();const calls=[];globalThis.__chat.send=async(b,k)=>{calls.push({b,k});if(calls.length===1)throw Error('connection lost');return {message:message(8)}};assert.equal(await s.send({body:'original',mention_usernames:[],attachment_ids:['file']}),false);assert.ok(s.pending);assert.equal((await s.send({body:'changed',mention_usernames:[],attachment_ids:[]})).id,'m8');assert.equal(calls[0].k,calls[1].k);assert.equal(calls[1].b.body,'original');assert.equal(s.pending,null);assert.equal(s.cursor,0);assert.equal(s.messages.length,1);assert.ok(globalThis.__chat.cache.get('a:chat_snapshot'));});
test('incremental paging follows all pages and deduplicates message ids',async()=>{const s=await fixture();s.initialized=true;s.cursor=2;s.messages=[message(2)];globalThis.__chat.messages=async q=>q.after===2?{messages:[message(2),message(3)],next_cursor:3,has_more:true}:{messages:[message(4)],next_cursor:4,has_more:false};await s.refresh();assert.deepEqual(s.messages.map(m=>m.seq),[2,3,4]);assert.equal(s.cursor,4);});
test('late account-A response cannot populate account-B view or cache',async()=>{const s=await fixture();let resolvePage;globalThis.__chat.messages=()=>new Promise(r=>resolvePage=r);const first=s.refresh();await new Promise(r=>setTimeout(r,0));await s.setAccount('b');resolvePage({messages:[message(9)],next_cursor:9,has_more:false});await first;assert.equal(s.account,'b');assert.deepEqual(s.messages,[]);assert.equal(s.cursor,0);assert.equal(globalThis.__chat.cache.has('b:chat_snapshot'),false);});
test('failed refresh retains visible records and cursor with explicit error',async()=>{const s=await fixture();s.messages=[message(5)];s.cursor=5;s.initialized=true;globalThis.__chat.messages=async()=>{throw Error('unavailable')};await s.refresh();assert.equal(s.messages[0].seq,5);assert.equal(s.cursor,5);assert.match(s.error,/unavailable/);});
test('transient conversation read keeps cache, retries silently, and cannot retry into another peer',async()=>{
 mock.timers.enable({apis:['setTimeout']});
 try{
  const s=await fixture();s.messages=[message(5)];s.cursor=5;s.initialized=true;let calls=0;
  globalThis.__chat.messages=async()=>{calls++;if(calls===1)throw new ApiError('network','正在重新连接',503);return {messages:[message(6)],next_cursor:6,has_more:false};};
  await s.refresh();assert.equal(s.error,'');assert.equal(s.messages[0].seq,5);assert.equal(calls,1);
  mock.timers.tick(2000);await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(s.messages.at(-1).seq,6);
  globalThis.__chat.messages=async()=>{calls++;throw new ApiError('network','连接暂时不可用',0);};
  await s.refresh();const before=calls;await s.setAccount('a','different-peer');mock.timers.tick(60000);await new Promise(r=>setImmediate(r));assert.equal(calls,before);
 }finally{mock.timers.reset();}
});
test('permission denial remains explicit and is not silently retried',async()=>{
 mock.timers.enable({apis:['setTimeout']});try{const s=await fixture();let calls=0;globalThis.__chat.messages=async()=>{calls++;throw new ApiError('forbidden','无权读取会话',403);};await s.refresh();assert.match(s.error,/无权/);mock.timers.tick(60000);await new Promise(r=>setImmediate(r));assert.equal(calls,1);}finally{mock.timers.reset();}
});
test('pending operation survives recreation and remains account scoped',async()=>{let s=await fixture();globalThis.__chat.send=async()=>{throw Error('timeout')};await s.send({body:'persisted',mention_usernames:[],attachment_ids:[]});const key=s.pending.key;setActivePinia(createPinia());s=useChatStore();await s.setAccount('b');assert.equal(s.pending,null);await s.setAccount('a');assert.equal(s.pending.key,key);assert.equal(s.pending.body.body,'persisted');});
test('wake during in-flight fetch drains another page without polling',async()=>{const s=await fixture();let resolvePage,calls=0;globalThis.__chat.messages=async()=>{calls++;if(calls===1)return await new Promise(r=>resolvePage=r);return {messages:[message(2)],next_cursor:2,has_more:false}};const first=s.refresh();await new Promise(r=>setTimeout(r,0));await s.refresh({changed:true});await s.refresh({changed:true});resolvePage({messages:[message(1)],next_cursor:1,has_more:false});await first;assert.equal(calls,2);assert.deepEqual(s.messages.map(m=>m.seq),[1,2]);await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);});
test('queued old-account wake cannot refresh new account',async()=>{const s=await fixture();let resolvePage,calls=0;globalThis.__chat.messages=()=>{calls++;return new Promise(r=>resolvePage=r)};const first=s.refresh();await new Promise(r=>setTimeout(r,0));await s.refresh();await s.setAccount('b');resolvePage({messages:[message(1)],next_cursor:1,has_more:false});await first;assert.equal(calls,1);assert.deepEqual(s.messages,[]);});

test('startup network waits for hydration and cannot be overwritten by delayed old cache',async()=>{
 const s=await fixture();await s.setAccount('');let release;globalThis.__chat.get=(a,k)=>k==='chat_snapshot'?new Promise(r=>release=r):null;
 let requests=0;globalThis.__chat.messages=async q=>{requests++;assert.equal(q.after,undefined);return {messages:[message(1),message(2)],next_cursor:2,has_more:false}};
 const hydration=s.setAccount('a');const refresh=s.refresh();await new Promise(r=>setTimeout(r,0));assert.equal(requests,0);
 release({messages:[message(1)],cursor:1});await hydration;await refresh;assert.deepEqual(s.messages.map(m=>m.seq),[1,2]);assert.equal(s.cursor,2);
});
test('persisted empty cache with advanced cursor cannot hide existing server history on reload',async()=>{
 const s=await fixture();await s.setAccount('');globalThis.__chat.cache.set('a:chat_snapshot',{messages:[],cursor:50});await s.setAccount('a');let query;
 globalThis.__chat.messages=async q=>{query=q;return {messages:[message(5)],next_cursor:5,has_more:false}};
 await s.refresh();assert.equal(query.after,undefined);assert.equal(s.messages[0].id,'m5');assert.equal(s.cursor,5);
});

test('slow member directory does not block history and late account result stays isolated',async()=>{
 const s=await fixture(); let resolveMembers;
 globalThis.__chat.members=()=>new Promise(r=>resolveMembers=r);
 globalThis.__chat.messages=async()=>({messages:[message(1)],next_cursor:1,has_more:false});
 await s.refresh(); assert.equal(s.messages.length,1); assert.equal(s.loading,false);
 await s.setAccount('b'); resolveMembers({members:[{username:'a',nickname:'A'}]});
 await Promise.resolve(); assert.deepEqual(s.members,[]);
});

test('nonadjacent startup cache cannot skip the middle history window',async()=>{
 const s=await fixture();s.messages=Array.from({length:50},(_,i)=>message(i+1));
 const queries=[];globalThis.__chat.messages=async q=>{queries.push(q);const start=q.before?Math.max(1,q.before-50):101;const end=q.before?q.before-1:150;return {messages:Array.from({length:end-start+1},(_,i)=>message(start+i)),next_cursor:end,has_more:false,has_more_old:start>1}};
 await s.refresh();assert.equal(s.messages[0].seq,101);await s.older();await s.older();
 assert.equal(queries[1].before,101);assert.equal(queries[2].before,51);
 assert.deepEqual(s.messages.map(m=>m.seq),Array.from({length:150},(_,i)=>i+1));
});
test('startup window keeps a concurrently acknowledged newer send',async()=>{
 const s=await fixture();let release;globalThis.__chat.messages=()=>new Promise(r=>release=r);
 const refresh=s.refresh();await new Promise(r=>setTimeout(r,0));
 globalThis.__chat.send=async()=>({message:message(3)});await s.send({body:'new',mention_usernames:[],attachment_ids:[]});
 release({messages:[message(1),message(2)],next_cursor:2,has_more:false});await refresh;
 assert.deepEqual(s.messages.map(m=>m.seq),[1,2,3]);assert.equal(s.cursor,2);
});

test('old message changes update loaded rows without creating an unpageable old prefix',async()=>{
 const s=await fixture();s.initialized=true;s.cursor=100;s.messages=[message(100)];
 globalThis.__chat.messages=async()=>({messages:[],next_cursor:100,sync_cursor:8,has_more:false});let after;
 globalThis.__chat.changes=async cursor=>{after=cursor;return {changes:[{change_seq:7,message:{...message(1),recalled:true,body:'',change_version:7}},{change_seq:8,message:{...message(100),recalled:true,body:'',change_version:8}}],next_change_cursor:8,has_more:false}};
 await s.refresh();assert.equal(after,0);assert.equal(s.messages.length,1);assert.equal(s.messages[0].body,'');assert.equal(s.messages[0].recalled,true);
 globalThis.__chat.messages=async()=>({messages:[message(100)],next_cursor:100,sync_cursor:8,has_more:false});await s.refresh();assert.equal(s.messages[0].recalled,true);
});
test('ambiguous recall retries the same persisted operation and never substitutes another message',async()=>{
 const s=await fixture();s.messages=[message(1)];const calls=[];
 globalThis.__chat.changeMessage=async(id,action,key)=>{calls.push({id,action,key});if(calls.length===1)throw Error('response lost');return {message:{...message(1),recalled:true,body:'',change_version:3}}};
 assert.equal(await s.changeMessage('m1','recall'),false);assert.equal(await s.changeMessage('m2','hide'),false);assert.equal(calls.length,1);
 assert.equal(await s.changeMessage(),true);assert.equal(calls[0].key,calls[1].key);assert.equal(s.mutationPending,null);assert.equal(s.messages[0].body,'');
});
test('restart retains all read pages and resumes message/change cursors without first-page reload',async()=>{
 let s=await fixture();const all=Array.from({length:450},(_,i)=>message(i+1));
 globalThis.__chat.messages=async()=>({messages:all,next_cursor:450,sync_cursor:19,has_more:false,has_more_old:true});
 globalThis.__chat.changes=async()=>({changes:[],next_change_cursor:19,has_more:false});await s.refresh();
 setActivePinia(createPinia());s=useChatStore();await s.setAccount('a');assert.equal(s.messages.length,450);assert.equal(s.canLoadOlder,true);
 globalThis.__chat.messages=async q=>{assert.equal(q.after,450);assert.equal(q.before,undefined);return {messages:[message(451)],next_cursor:451,sync_cursor:20,has_more:false}};
 globalThis.__chat.changes=async c=>{assert.equal(c,19);return {changes:[{message:{...message(1),recalled:true,body:'',change_version:20}}],next_change_cursor:20,has_more:false}};
 await s.refresh();assert.equal(s.messages.length,451);assert.equal(s.messages[0].recalled,true);assert.equal(globalThis.__chat.cache.get('a:chat_snapshot').changeCursor,20);
});

test('switching conversations shares the member request and retains its eventual result',async()=>{
 const s=await fixture();let calls=0,release;
 globalThis.__chat.members=()=>{calls++;return new Promise(r=>release=r);};
 const first=s.refreshMembers();await new Promise(r=>setImmediate(r));
 await s.setAccount('a','peer-one');const second=s.refreshMembers();
 await s.setAccount('a','peer-two');const third=s.refreshMembers();
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(s.memberLoading,true);
 release({members:[{username:'member',nickname:'Member'}]});await Promise.all([first,second,third]);
 assert.equal(s.members[0].username,'member');assert.equal(s.memberLoading,false);
 await s.refreshMembers();assert.equal(calls,1);
});

test('sent attachment receipt displays without reading history and stays scoped to account and peer',async()=>{
 const s=await fixture();await s.setAccount('a','b');let reads=0;globalThis.__chat.messages=()=>{reads++;throw Error('unnecessary read');};
 assert.equal(s.acceptSent('a','b',{...message(3),conversation_peer:'b'}),true);assert.equal(reads,0);assert.equal(s.messages[0].id,'m3');assert.equal(s.cursor,0);
 assert.equal(s.acceptSent('a','other',message(4)),false);assert.equal(s.acceptSent('other','b',message(4)),false);assert.equal(s.messages.length,1);
});
test('initialized refresh starts history and changes together rather than waiting for history',async()=>{
 const s=await fixture();globalThis.__chat.messages=async()=>({messages:[],next_cursor:0,sync_cursor:0,has_more:false});globalThis.__chat.changes=async()=>({changes:[],next_change_cursor:0,has_more:false});await s.refresh();
 let release,changesStarted=false;globalThis.__chat.messages=()=>new Promise(r=>release=r);globalThis.__chat.changes=async()=>{changesStarted=true;return {changes:[],next_change_cursor:0,has_more:false};};
 const run=s.refresh();await new Promise(r=>setTimeout(r,0));assert.equal(changesStarted,true);release({messages:[],next_cursor:0,has_more:false});await run;
});

test('file transfer assistant restores cached history offline and resumes only new messages and changes',async()=>{
 let s=await fixture();await s.setAccount('a','a');const rows=Array.from({length:120},(_,i)=>({...message(i+1),conversation_peer:'a'}));
 globalThis.__chat.messages=async q=>{assert.equal(q.peer,'a');return {messages:rows,next_cursor:120,sync_cursor:7,has_more:false,has_more_old:false};};
 globalThis.__chat.changes=async(_cursor,_signal,peer)=>{assert.equal(peer,'a');return {changes:[],next_change_cursor:7,has_more:false};};await s.refresh();
 const before=globalThis.__chat.cache.get('a:chat_snapshot:direct:a');assert.equal(before.messages.length,120);
 setActivePinia(createPinia());s=useChatStore();await s.setAccount('a','a');assert.equal(s.messages.length,120);
 globalThis.__chat.messages=async()=>{throw Error('offline')};globalThis.__chat.changes=async()=>{throw Error('offline')};await s.refresh();assert.equal(s.messages.length,120);assert.equal(s.cursor,120);
 const calls=[];globalThis.__chat.messages=async q=>{calls.push(q);assert.equal(q.peer,'a');assert.equal(q.after,120);assert.equal(q.before,undefined);return {messages:[{...message(121),conversation_peer:'a'}],next_cursor:121,sync_cursor:8,has_more:false};};
 globalThis.__chat.changes=async(c,_signal,peer)=>{assert.equal(c,7);assert.equal(peer,'a');return {changes:[{message:{...rows[0],recalled:true,body:'',change_version:8}}],next_change_cursor:8,has_more:false};};await s.refresh();
 assert.equal(calls.length,1);assert.equal(s.messages.length,121);assert.equal(s.messages[0].recalled,true);assert.equal(new Set(s.messages.map(m=>m.id)).size,121);
 const saved=globalThis.__chat.cache.get('a:chat_snapshot:direct:a');assert.equal(saved.cursor,121);assert.equal(saved.changeCursor,8);
 setActivePinia(createPinia());s=useChatStore();await s.setAccount('a','a');assert.equal(s.messages.length,121);assert.equal(s.messages[0].recalled,true);
});
test('new assistant device loads history automatically and never reuses another conversation cache',async()=>{
 let s=await fixture();const cache=globalThis.__chat.cache;cache.set('a:chat_snapshot',{schema:3,quoteProjection:1,messages:[message(900)],cursor:900,changeCursor:99});
 await s.setAccount('a','a');assert.equal(s.messages.length,0);let reads=0;
 globalThis.__chat.messages=async q=>{reads++;assert.equal(q.peer,'a');assert.equal(q.after,undefined);return {messages:[{...message(1),conversation_peer:'a'}],next_cursor:1,sync_cursor:1,has_more:false,has_more_old:false};};globalThis.__chat.changes=async()=>({changes:[],next_change_cursor:1,has_more:false});await s.refresh();
 assert.equal(reads,1);assert.equal(s.messages[0].id,'m1');assert.equal(cache.get('a:chat_snapshot').cursor,900);assert.equal(cache.get('a:chat_snapshot:direct:a').cursor,1);
});
