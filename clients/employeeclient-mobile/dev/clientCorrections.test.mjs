import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, computed } from 'vue';

async function load(path, deps, from) {
  let source=await readFile(new URL('../src/'+path,import.meta.url),'utf8');
  if(from) source=source.slice(source.indexOf(from));
  const esm=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  return new Function(...Object.keys(deps),esm+'\nreturn {'+(path.includes('projections')?'companySubmitters,reviewedTasks':path.includes('taskProjection')?'projectInbox,countAction,archivedPersonalProjectIds':'reconcilePushBinding')+'};')(...Object.values(deps));
}
class ApiError extends Error {constructor(code,hint,status){super(hint);Object.assign(this,{code,status});}}
test('submitter projection reads all status pages; review history uses real review records including completed/cancelled',async()=>{
  const calls=[]; const tasks=['completed','cancelled','pending','unreviewed'].map(id=>({id}));
  const api=await load('api/projections.ts',{
    ApiError,company:{issues:async q=>{calls.push(q);return q.cursor?{issues:[{submitter_username:'resolved-only'}],next_cursor:null}:{issues:[{submitter_username:'first'}],next_cursor:'next'};}},
    control:{tasks:async q=>{assert.equal(q,undefined);return {tasks};},taskContext:async id=>({task:{id},reviews:id==='unreviewed'?[]:[{created_at:tasks.findIndex(t=>t.id===id)}]})}
  });
  assert.deepEqual(await api.companySubmitters(),[{username:'first'},{username:'resolved-only'}]);
  assert.ok(calls.every(q=>q.status==='all'));assert.equal(calls.length,2);
  assert.deepEqual((await api.reviewedTasks()).map(t=>t.id),['pending','cancelled','completed']);
});
test('personal project archive hides daily tasks/counts but preserves completed history and restores immediately',async()=>{
  const p=await load('ui/taskProjection.ts',{done:t=>t.main_state==='completed',awaiting:()=>false});
  const projects=[{id:'p',scope:'personal',status:'archived'}];
  const tasks=[{id:'t',project_id:'p',scope_at_creation:'personal',main_state:'incomplete',current_node:'awaiting_code',assignee_username:'a'},{id:'h',project_id:'p',scope_at_creation:'personal',main_state:'completed'}];
  const ctx={username:'a',isMainControl:false,archivedProjectIds:p.archivedPersonalProjectIds(projects)};
  assert.equal(p.projectInbox(tasks,ctx,'action').length,0);assert.equal(p.countAction(tasks,ctx),0);
  assert.equal(p.projectInbox(tasks,ctx,'history')[0].id,'h');
  projects[0].status='active';ctx.archivedProjectIds=p.archivedPersonalProjectIds(projects);
  assert.equal(p.countAction(tasks,ctx),1);assert.equal(tasks[0].main_state,'incomplete');
  ctx.isMainControl=true;
  assert.equal(p.countAction(tasks,ctx),1,'main control retains responsibility for own private tasks');
  assert.equal(p.projectInbox(tasks,ctx,'action').length,1);
});
test('push reconciliation updates active qn1 installation without Hufu fallback; revocation and retry are respected',async()=>{
  let active=true,fail=false,puts=0;
  const p=await load('platform/device.ts',{ApiError,isAndroidNative:()=>false,ANDROID_NO_PUSH_SUBSCRIPTION:'',newIdempotencyKey:()=> 'key',lastPushAvailability:()=>({reason:'unconfigured'}),getPushSubscription:async prompt=>{assert.equal(prompt,false);return {platform:'ios_pwa',subscription:{endpoint:'existing'}};},me:{devices:async()=>({devices:[{installation_id:'d',status:active?'active':'revoked'}]}),putDevice:async(...args)=>{puts++;assert.equal(args.length,3);if(fail)throw new ApiError('network','offline',0);return {status:'active'};}}},'export async function reconcilePushBinding');
  assert.equal((await p.reconcilePushBinding('d',()=>true)).bound,true);
  active=false;await assert.rejects(p.reconcilePushBinding('d',()=>true));assert.equal(puts,1);
  active=true;fail=true;await assert.rejects(p.reconcilePushBinding('d',()=>true));
  fail=false;assert.equal((await p.reconcilePushBinding('d',()=>true)).bound,true);
  await assert.rejects(p.reconcilePushBinding('d',()=>false));assert.equal(puts,3);
});
test('actual TaskMore component does not grant assigned employee urge rights absent from server actions',async()=>{
  const file=await readFile(new URL('../src/ui/components/TaskMoreOverlay.vue',import.meta.url),'utf8');
  const js=ts.transpileModule(file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1],{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
  for(const actions of [[],['urge_review']]) {
    const hooks=[];let opened=0;
    const task={id:'t',scope_at_creation:'company',current_node:'awaiting_code_review',creator_username:'a',assignee_username:'b'};
    const deps={ref,computed,onMounted:f=>hooks.push(f),onBeforeUnmount:()=>{},useSessionStore:()=>({isMainControl:false,user:{username:'b'}}),useDataStore:()=>({tasks:[task],captureLease:()=>({valid:()=>true}),loadTaskContext:async()=>({task,allowed_actions:actions})}),useUiStore:()=>({overlayProps:{taskId:'t'},openOverlay:()=>opened++})};
    const c=new Function(...Object.keys(deps),js+'\nreturn {canUrge,urge};')(...Object.values(deps));
    await Promise.all(hooks.map(f=>f()));assert.equal(c.canUrge.value,actions.length>0);c.urge();assert.equal(opened,actions.length?1:0);
  }
});
test('main-control TaskMore can read uncached private task through me namespace',async()=>{
  const file=await readFile(new URL('../src/ui/components/TaskMoreOverlay.vue',import.meta.url),'utf8');
  const js=ts.transpileModule(file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1],{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
  const hooks=[],calls=[];
  const deps={ref,computed,onMounted:f=>hooks.push(f),onBeforeUnmount:()=>{},useSessionStore:()=>({isMainControl:true}),useDataStore:()=>({tasks:[],captureLease:()=>({valid:()=>true}),loadTaskContext:async(id,ns)=>{calls.push(ns);assert.equal(ns,'me');return {task:{id,scope_at_creation:'personal'},allowed_actions:[]};}}),useUiStore:()=>({overlayProps:{taskId:'private'}})};
  const c=new Function(...Object.keys(deps),js+'\nreturn {task,canUrge};')(...Object.values(deps));
  await Promise.all(hooks.map(f=>f()));assert.equal(c.task.value.id,'private');assert.equal(c.canUrge.value,false);assert.deepEqual(calls,['me']);
});
