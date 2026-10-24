import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/collaboration/presentation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {mergeMessages,renderMessage}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('history and live share one chronology and reassemble complete messages',()=>{
 const turn=(id,started_at,messages)=>({id,started_at,messages});
 const m=(offset,text)=>({id:'m:part:'+offset,original_id:'m',offset,role:'assistant',text,revision:'same'});
 let list=mergeMessages([turn('new',2,[m(6,'世界')])],[turn('old',1,[{id:'old',role:'user',text:'earlier'}]),turn('new',2,[m(6,'世界')])]);
 assert.equal(list[0].text,'earlier');assert.equal(list[1].missingPrefix,true);
 list=mergeMessages([turn('new',2,[m(0,'hello '),m(6,'世界')])],[turn('new',2,[m(6,'世界')])]);
 assert.equal(list.length,1);assert.equal(list[0].text,'hello 世界');assert.equal(list[0].missingPrefix,false);
});
test('markdown formatting without executable HTML, active schemes, or automatic image loads',()=>{
 const fence=String.fromCharCode(96).repeat(3);
 const html=renderMessage('**已连接**\n\n- 一项\n\n'+fence+'js\nx < 2\n'+fence+'\n\n<script>alert(1)</script>\n[x](javascript:alert(1))\n![image](https://example.com/a.png)');
 assert.match(html,/<strong>已连接<\/strong>/);assert.match(html,/<ul>/);assert.match(html,/<pre>/);
 assert.doesNotMatch(html,/<script>|href="javascript:|<img/);
});

test('final answer remains after live progress when summary history arrived first',()=>{
 const final={id:'f',role:'assistant',text:'final',phase:'final_answer',sequence:0};
 const progress={id:'p',role:'assistant',text:'working',phase:'commentary',sequence:2};
 const merged=mergeMessages([{id:'t',messages:[final]}],[{id:'t',messages:[progress,{...final,sequence:7}]}]);
 assert.deepEqual(merged.map(m=>m.text),['working','final']);
});

test('changed text revision replaces old remaining chunks instead of mixing them',()=>{
 const m=(offset,text,revision)=>({id:'m:'+offset,original_id:'m',offset,role:'assistant',text,revision});
 const merged=mergeMessages([{id:'t',messages:[m(0,'old','one'),m(6000,'stale-tail','one')]}],[{id:'t',messages:[m(0,'new','two')]}]);
 assert.equal(merged[0].text,'new');
});

test('media-only pages preserve attachments and do not mask unloaded text prefix',()=>{
 const messages=[{id:'m:part:6000',original_id:'m',offset:6000,role:'assistant',text:'tail',revision:'r'},
 {id:'m:media:0',original_id:'m',offset:0,role:'assistant',text:'',revision:'r',attachments:[{id:'image',name:'image.png'}]}];
 const [m]=mergeMessages([{id:'t',messages}],[]);assert.equal(m.text,'tail');assert.equal(m.missingPrefix,true);assert.equal(m.attachments.length,1);
 const html=renderMessage('![image](/tmp/image.png)',true);assert.doesNotMatch(html,/本机附件|<img/);
});

test('local file references render labels without raw URI and preserve literal code',()=>{
 const html=renderMessage('[报告](file:///Users/developer/Desktop/report.md)\n\n`[报告](file:///Users/developer/Desktop/report.md)`');
 assert.match(html,/<span class="local-file">报告<\/span>/);
 assert.doesNotMatch(html,/href="file:/);
 assert.match(html,/<code>\[报告\]\(file:/);
});
test('native turn timestamps are retained without inventing per-message time',()=>{
 const [m]=mergeMessages([{id:'t',started_at:10000,completed_at:22000,messages:[{id:'f',role:'assistant',text:'done',phase:'final_answer'}]}],[]);
 assert.equal(m.started_at,10000);assert.equal(m.completed_at,22000);assert.equal(m.created_at,undefined);
});
