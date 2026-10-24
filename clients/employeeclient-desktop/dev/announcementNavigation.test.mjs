import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, ref } from 'vue';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('persistent announcement opens its actual detail and remains unread until explicit acknowledgement', () => {
  const script=source('../src/ui/components/FloatingNotices.vue').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  const js=ts.transpileModule(script,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\r?\n/gm,'');
  const calls={overlay:[],route:[]},data=ref({floatingNotices:[{id:'n2',kind:'announcement',object_id:'a2',created_at:20},{id:'n1',kind:'announcement',object_id:'a1',created_at:10}]});
  const model=new Function('computed','useRouter','useDataStore','useUiStore',js+';return {open,queue};')(computed,()=>({push:t=>calls.route.push(t)}),()=>data.value,()=>({openOverlay:(...args)=>calls.overlay.push(args)}));
  model.open();assert.deepEqual(calls.overlay,[['announcement',{announcementId:'a1'}]]);assert.equal(calls.route.length,0);assert.equal(model.queue.value.length,2);
  data.value.floatingNotices=data.value.floatingNotices.filter(n=>n.id!=='n1');model.open();assert.deepEqual(calls.overlay[1],['announcement',{announcementId:'a2'}]);assert.equal(model.queue.value.length,1);
});

test('small mobile pages are bundled with the shell so an update cannot drop lazy route chunks', () => {
  const router = source('../src/app/router.ts');
  assert.doesNotMatch(router, /component:\s*\(\)\s*=>\s*import\(/);
  assert.match(router, /name: 'announcements', component: AnnouncementsView/);
});
