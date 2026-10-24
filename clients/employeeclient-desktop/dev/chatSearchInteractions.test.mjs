import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const view=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const action=ts.transpileModule(view.slice(view.indexOf('function chooseHistoryCategory('),view.indexOf('function openChatSearch(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(peerValue=''){
 const filter={value:{peer:peerValue,q:'原词',kind:'files',author:'b',related:'mentions',created_from:123}},searchText={value:'原词'},peer={value:peerValue},historyDate={value:'2026-10-15'},historyNote={value:'日期'};
 const clearFilter=()=>{filter.value=peer.value?{peer:peer.value}:{};searchText.value='';historyDate.value='';historyNote.value='';};
 const deps={filter,searchText,peer,clearFilter,dismissQuoteInspection(){},memberFilterOpen:{value:false},historyOpen:{value:false},chat:{members:[],refreshMembers(){}}};
 return {...deps,choose:new Function(...Object.keys(deps),action+';return chooseHistoryCategory;')(...Object.values(deps))};
}
test('switching back to all preserves the current keyword and original conversation while removing constraints',()=>{
 for(const peer of ['','self','other']){const f=fixture(peer);f.choose('all','  本次关键词  ');assert.equal(f.searchText.value,'  本次关键词  ');assert.equal(f.filter.value.q,'本次关键词');assert.equal(f.filter.value.peer||'',peer);assert.equal(f.filter.value.kind,undefined);assert.equal(f.filter.value.author,undefined);assert.equal(f.filter.value.created_from,undefined);assert.equal(f.filter.value.related,undefined);}
});
test('explicit clear still clears keyword and constraints without widening the conversation',()=>{const f=fixture('self');f.choose('all','关键词');f.clearFilter();assert.equal(f.searchText.value,'');assert.deepEqual(f.filter.value,{peer:'self'});});
test('all category is selected for a keyword-only query and not for a constrained query',()=>{
 const panel=readFileSync(new URL('../src/ui/components/ChatSearchPanel.vue',import.meta.url),'utf8');const fn=ts.transpileModule(panel.slice(panel.indexOf('function selected('),panel.indexOf('function search(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const props={filter:{peer:'self',q:'关键词'}};const selected=new Function('props',fn+';return selected;')(props);assert.equal(selected('all'),true);
 for(const constraint of [{kind:'files'},{author:'b'},{related:'replies'},{created_from:123}]){props.filter={peer:'self',q:'关键词',...constraint};assert.equal(selected('all'),false);}
});
