// Executes the actual component submission path with isolated transport and write journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, ref } from 'vue';
const source = readFileSync(new URL('../src/ui/components/AnnouncementFormOverlay.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const js = ts.transpileModule(script, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\r?\n/gm,'');
function setup() {
  const calls=[];
  const pending=ref(null);
  const communication={publishAnnouncement:async(body,key)=>{calls.push({body,key});return {recipient_count:1}}};
  const factory=new Function('ref','computed','onMounted','communication','ApiError','usePendingWrite','useDataStore','useUiStore','useSessionStore',js+'\nreturn {title,body,selected,submit};');
  const form=factory(ref,computed,()=>{},communication,Error,()=>({pending,valid:()=>true,account:'sender',start:body=>({body,key:'stable-key'}),finish(){}}),()=>({syncAll:async()=>{}}),()=>({closeOverlay(){},toast(){}}),()=>({user:{username:'sender'},status:'online'}));
  form.body.value='  本周联调安排  ';form.selected.value=['recipient'];
  return {form,calls};
}
test('optional empty or whitespace title submits a valid company announcement title',async()=>{
  for(const title of ['', '   ']) {const {form,calls}=setup();form.title.value=title;await form.submit();assert.equal(calls.length,1);assert.equal(calls[0].body.title,'公司公告');assert.equal(calls[0].body.body,'本周联调安排');assert.deepEqual(calls[0].body.recipient_usernames,['recipient']);}
});
test('explicit announcement title is trimmed and preserved',async()=>{const {form,calls}=setup();form.title.value='  联调提醒  ';await form.submit();assert.equal(calls[0].body.title,'联调提醒');});
test('missing body or recipients still prevents submission',async()=>{for(const missing of ['body','recipients']){const {form,calls}=setup();if(missing==='body')form.body.value=' ';else form.selected.value=[];await form.submit();assert.equal(calls.length,0);}});
