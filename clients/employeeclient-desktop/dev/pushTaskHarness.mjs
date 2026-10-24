// Supply the actual task orchestration to older isolated module fixtures. Their
// storage doubles model the adapter only; atomic IndexedDB claims are tested in browser.
import {readFileSync} from 'node:fs';import ts from 'typescript';import {waitForOperation} from '../src/platform/operationDeadline.mjs';
const compiled=ts.transpileModule(readFileSync(new URL('../src/platform/pushTask.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const wakeCode=ts.transpileModule(readFileSync(new URL('../src/platform/workerRecoveryWake.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const {scheduleRecoveryWake}=new Function('waitForOperation',wakeCode+';return {scheduleRecoveryWake};')(waitForOperation);
export function pushTaskHarness(deps){
 const clock=deps.Date||{now:()=>Date.now()};
 const claimPushRenewal=async(account,owner,leaseMs,valid=()=>true)=>{
  const identity=await deps.readPushIdentity(),old=await deps.readPendingPushRenewal();if(!valid()||identity?.account!==account)return {pending:null,waitUntil:0};
  const until=Math.max(old?.retryAt||0,old?.lease?.until||0);if(until>clock.now())return {pending:null,waitUntil:until};
  const pending={...old,identity,lease:{owner,until:clock.now()+leaseMs}};
  if(!await deps.savePushRenewal(pending,undefined,valid,old||'create'))return {pending:null,waitUntil:0};return {pending,waitUntil:0};
 };
 return {scheduleRecoveryWake,...new Function('claimPushRenewal','savePushRenewal','waitForOperation','Date',compiled+';return {claimPushTask,failPushTask};')(claimPushRenewal,deps.savePushRenewal,waitForOperation,clock)};
}
