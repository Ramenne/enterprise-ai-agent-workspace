import test from 'node:test';import assert from 'node:assert/strict';
import {createQueryProjection,queryIdentity} from '../src/native/query-projection.mjs';
const project={project_id:'p',properties:{attributes:{scope:'团队'}}},revision=n=>String(n).padStart(64,'0');
const work=(id,n=1)=>({work_item_id:id,goal:id,revision:1,projection_revision:revision(n),state:'in_progress'});
function fixture(){
 const db=new Map(),calls=[];let rows=[work('w1'),work('w2')],fail=false,hold;
 const deps={get:async(a,k)=>structuredClone(db.get(a+k)),put:async(a,k,v,valid)=>{if(valid())db.set(a+k,structuredClone(v));},remove:async(a,k)=>db.delete(a+k),rpc:async(name,args,signal)=>{
  calls.push({name,args});signal?.throwIfAborted();if(hold)await hold(name,args);if(fail)throw Object.assign(Error('busy'),{status:503});assert.equal(name,'v8.work.catalog');
  const all=rows.filter(r=>(!args.work_item_ids||args.work_item_ids.includes(r.work_item_id))&&(!args.q||r.goal.includes(args.q))),offset=args.after?Number(args.after.slice(1)):0;
  const selected=args.work_item_ids?all:all.slice(offset,offset+args.limit),after=!args.work_item_ids&&offset+selected.length<all.length?'p'+(offset+selected.length):null;
  return {items:selected.filter(r=>args.known?.[r.work_item_id]!==r.projection_revision),unchanged_ids:selected.filter(r=>args.known?.[r.work_item_id]===r.projection_revision).map(r=>r.work_item_id),coverage:{complete:!after},next_scan_cursor:after};
 }};
 const lease={account:'a',epoch:1,valid:()=>true,networkReady:()=>true};
 return {db,calls,deps,lease,make:()=>createQueryProjection(deps),set(v){if(v.rows)rows=v.rows;if('fail'in v)fail=v.fail;if('hold'in v)hold=v.hold;}};
}
test('first read fetches one bounded page with no whole revision index or change snapshot',async()=>{
 const f=fixture(),r=await f.make().read(f.lease,project);assert.equal(r.rows.length,2);assert.deepEqual(f.calls.map(c=>c.name),['v8.work.catalog']);assert.equal(f.calls[0].args.limit,40);assert.equal(f.calls[0].args.page_mode,true);assert.ok(!f.calls.some(c=>c.args.revisions_only));
});
test('unchanged cache paints immediately and refresh uses conditional identities; offline performs zero requests',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);f.calls.length=0;const seen=[];await p.read(f.lease,project,{onSnapshot:v=>seen.push(v)});assert.equal(seen[0].rows.length,2);assert.equal(f.calls[0].args.known.w1,revision(1));assert.deepEqual(f.calls[0].args.work_item_ids,['w1','w2']);assert.equal(f.calls.length,2);
 f.calls.length=0;assert.equal((await p.read({...f.lease,networkReady:()=>false},project)).rows.length,2);assert.equal(f.calls.length,0);
});
test('a changed authorized stage is read even when the main revision stays the same and no event feed exists',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);f.set({rows:[{...work('w1',2),goal:'new stage'},work('w2')]});const r=await p.read(f.lease,project);assert.equal(r.rows.find(r=>r.work_item_id==='w1').goal,'new stage');assert.equal(r.rows[0].revision,1);
});
test('deleted or restricted loaded records disappear without depending on filtered tombstones',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);f.set({rows:[work('w2')]});assert.deepEqual((await p.read(f.lease,project)).rows.map(r=>r.work_item_id),['w2']);
});
test('failed refresh cannot replace visible data or its traversal position',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);const before=structuredClone([...f.db.values()][0]);f.set({fail:true});await assert.rejects(p.read(f.lease,project),/busy/);assert.deepEqual([...f.db.values()][0],before);
});
test('new matches in the middle of a previously loaded window are reconciled without scanning the remaining project',async()=>{
 const f=fixture(),p=f.make(),rows=Array.from({length:190},(_,i)=>work('w'+i));f.set({rows});await p.read(f.lease,project);await p.read(f.lease,project,{more:true});f.calls.length=0;const next=[...rows];next.splice(55,0,work('new-match',3));f.set({rows:next});const result=await p.read(f.lease,project);assert.ok(result.rows.some(r=>r.work_item_id==='new-match'));assert.equal(f.calls.filter(c=>!c.args.work_item_ids).length,2);assert.ok(!f.calls.some(c=>c.args.after==='p80'));assert.equal(result.hasMore,true);
});
test('a previously complete list discovers growth and exposes the remaining pages',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);f.set({rows:Array.from({length:52},(_,i)=>work('w'+i))});let r=await p.read(f.lease,project);assert.equal(r.hasMore,true);r=await p.read(f.lease,project,{more:true});assert.equal(r.rows.length,52);assert.equal(r.hasMore,false);
});
test('query conditions isolate caches and remain server inputs',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);await p.read(f.lease,project,{query:'w1',selected:{state:'"in_progress"'}});assert.equal(f.db.size,2);assert.deepEqual(f.calls.at(-1).args.attributes,{state:'in_progress'});assert.equal(f.calls.at(-1).args.q,'w1');assert.notEqual(queryIdentity('p','work','w1'),queryIdentity('p','work','w2'));
});
test('twenty concurrent entries share one bounded read, and another account has its own cache',async()=>{
 const f=fixture(),p=f.make();await Promise.all(Array.from({length:20},()=>p.read(f.lease,project)));assert.equal(f.calls.length,1);await p.read({...f.lease,account:'b'},project);assert.equal(f.db.size,2);
});
test('late account-change or canceled responses never commit',async()=>{
 for(const abort of [false,true]){const f=fixture();let active=true,release;const controller=new AbortController();f.set({hold:async()=>{await new Promise(r=>release=r);}});const run=f.make().read({...f.lease,valid:()=>active},project,{signal:controller.signal});while(!release)await new Promise(r=>setImmediate(r));if(abort)controller.abort();else active=false;release();await assert.rejects(run);assert.equal(f.db.size,0);}
});
test('explicit permission denial clears the matching projection and current rendered snapshot',async()=>{
 const f=fixture(),p=f.make();await p.read(f.lease,project);f.set({hold:async()=>{throw Object.assign(Error('forbidden'),{status:403});}});const seen=[];await assert.rejects(p.read(f.lease,project,{onSnapshot:v=>seen.push(v)}));assert.equal(f.db.size,0);assert.deepEqual(seen.at(-1).rows,[]);
});
test('an expired page credential quietly rebuilds only the loaded window, not the entire project',async()=>{
 const f=fixture();f.set({rows:Array.from({length:120},(_,i)=>work('w'+i))});await f.make().read(f.lease,project);const base=f.deps.rpc;let expired=true;f.deps.rpc=async(n,a,s)=>{if(a.after&&expired){expired=false;throw Object.assign(Error('expired'),{code:'workspace_cursor_invalid_refresh',status:400});}return base(n,a,s);};const r=await f.make().read(f.lease,project,{more:true});assert.equal(r.rows.length,80);assert.equal(r.hasMore,true);
});
test('legacy local data is visible offline and migrates without whole project downloads',async()=>{
 const f=fixture();f.db.set('awork-projection-v1:p',{schema:1,complete:true,rows:[work('w1'),work('w2')]});const p=f.make();assert.equal((await p.read({...f.lease,networkReady:()=>false},project)).rows.length,2);assert.equal(f.calls.length,0);await p.read(f.lease,project);assert.ok(!f.calls.some(c=>/enumerate|changes/.test(c.name)||c.args.revisions_only));
});
test('file page and row modes share stable conditional signatures',async()=>{
 const f=fixture(),rows=[{material_id:'m1',name:'文件',projection_revision:revision(3)}];f.deps.rpc=async(n,a)=>{f.calls.push({name:n,args:a});assert.equal(n,'mem.workspace.query');return {items:rows.filter(r=>a.known?.[r.material_id]!==r.projection_revision),unchanged_ids:rows.filter(r=>a.known?.[r.material_id]===r.projection_revision).map(r=>r.material_id),scan_complete:true,next_scan_cursor:null};};const p=f.make();await p.read(f.lease,project,{mode:'files'});f.calls.length=0;const r=await p.read(f.lease,project,{mode:'files'});assert.equal(r.rows[0].type,'file');assert.equal(f.calls[0].args.mode,'rows');assert.deepEqual(f.calls[0].args.material_ids,['m1']);assert.equal(f.calls[0].args.known.m1,revision(3));
});
test('current query project attributes replace stale directory attributes without mutating the directory',async()=>{
 const f=fixture(),base=f.deps.rpc;f.deps.rpc=async(...args)=>({...await base(...args),project_attributes:{scope:'当前真实值'}});const result=await f.make().read(f.lease,project);assert.equal(result.rows[0].projectProperties.attributes.scope,'当前真实值');assert.equal(project.properties.attributes.scope,'团队');
});
