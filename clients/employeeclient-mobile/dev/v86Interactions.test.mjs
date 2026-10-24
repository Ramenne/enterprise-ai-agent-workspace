import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {ref,computed,nextTick} from 'vue';
import {fullDate,fullDateTime} from '../src/ui/date.mjs';
import {isWorkNotice,isAnnouncementNotice,memberDisplayName} from '../src/domain/noticeChannel.mjs';
test('full dates distinguish years without changing source values or separators',()=>{
 for(const year of [2026,2027]){const value=new Date(year,9,9,13,4);assert.equal(fullDate(value),`${year}/10/9`);assert.equal(fullDateTime(value),`${year}/10/9 13:04`);}
 assert.equal(fullDate('broken'),'');assert.equal(fullDate(null),'');
});
test('work and announcement channels stay distinct and opaque account identifiers never become names',()=>{
 for(const kind of ['announcement','announcement_reply']){assert.ok(isAnnouncementNotice({kind}));assert.equal(isWorkNotice({kind}),false);}
 assert.ok(isWorkNotice({kind:'review_result'}));assert.equal(isWorkNotice({kind:'chat_message'}),false);
 const id='46b19322-b0f9-490c-ad90-47989799fd74';assert.equal(memberDisplayName(id), '成员信息暂缺');assert.equal(memberDisplayName('historical-unresolved:abc'), '历史发布者');assert.equal(memberDisplayName(id,[{username:id,nickname:'杰'}]),'杰');
});
async function pullFixture(){
 const props={refresh:async()=>{calls++;},error:'',busy:false};let calls=0;
 const file=await readFile(new URL('../src/ui/components/PullToRefresh.vue',import.meta.url),'utf8'),script=file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]+\n/gm,'');
 const code=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const doc={scrollingElement:{scrollTop:0}},deps={defineProps:()=>props,ref,computed,nextTick,onDeactivated:()=>{},document:doc,getComputedStyle:()=>({overflowY:'visible'})};
 const view=new Function(...Object.keys(deps),code+';return {begin,move,end,cancel,refresh,distance,running,failed};')(...Object.values(deps));
 const event=(x,y)=>({touches:[{clientX:x,clientY:y}],target:{closest:()=>null},cancelable:true,preventDefault(){}});
 return {props,view,event,doc,get calls(){return calls;}};
}
test('pull refresh only triggers from the top; horizontal and small drags do not reload; failure is retryable',async()=>{
 const f=await pullFixture();f.view.begin(f.event(0,0));f.view.move(f.event(2,120));f.view.end();await nextTick();await nextTick();assert.equal(f.calls,1);
 f.doc.scrollingElement.scrollTop=5;f.view.begin(f.event(0,0));f.view.move(f.event(0,200));f.view.end();assert.equal(f.calls,1);
 f.doc.scrollingElement.scrollTop=0;f.view.begin(f.event(0,0));f.view.move(f.event(80,10));f.view.end();assert.equal(f.calls,1);
 f.view.begin(f.event(0,0));f.view.move(f.event(0,40));f.view.end();assert.equal(f.calls,1);
 f.props.error='offline';await f.view.refresh();assert.equal(f.view.failed.value,true);f.props.error='';await f.view.refresh();assert.equal(f.view.failed.value,false);
});
