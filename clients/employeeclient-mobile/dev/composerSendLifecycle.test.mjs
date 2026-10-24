import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {sameComposerScope} from '../src/chat/composerScope.mjs';
const draftSource=readFileSync(new URL('../src/chat/drafts.ts',import.meta.url),'utf8');
const draftCode=ts.transpileModule(draftSource.slice(draftSource.indexOf('export function sameDraftContent'),draftSource.indexOf('export function draftPreview')).replace('export function','function'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const sameDraftContent=new Function(draftCode+';return sameDraftContent;')();
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function send() {'),source.indexOf('async function loadOlder() {')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function setup(){
 let resolve;const gate=new Promise(r=>resolve=r),calls=[];
 const ref=value=>({value}),body=ref('原始正文'),attachments=ref([{id:'cloud-old',cloud_file:{id:'fixed',mime:'text/plain'},name:'one.txt'}]),mentions=ref(['b']),reply=ref(null),selectedContext=ref(null),contextExplicit=ref(false),peer=ref('');
 const deps={body,attachments,mentions,reply,selectedContext,contextExplicit,peer,
  chat:{sending:false,pending:null,account:'a',peer:'',send:async value=>{calls.push({peer:peer.value,...value});return {id:'confirmed',attachments:value.attachment_ids.map(id=>({id}))};}},session:{user:{username:'a'}},online:ref(true),belongs:ref(true),uploading:ref(false),composerLoaded:ref(true),viewActive:ref(true),route:{name:'chat'},threadGeneration:1,
  replyChecking:ref(false),replyCheckError:ref(''),pendingAttachment:ref(null),fileStage:ref(''),attachmentPicker:ref(null),filterActive:ref(false),query:{refresh:async()=>{}},
  sameComposerScope,sameDraftContent,isCloudForward:a=>!!a.cloud_file,shareCloudFile:()=>gate,cloudFileAttachment:()=>({}),cloudFileContext:()=>({}),findAttachment:async()=>undefined,replaceForward:()=>{},removeForwards:()=>{},acceptForward:()=>{},returnToLatest:()=>{},ui:{toast:()=>{}},
  composerSnapshot:()=>structuredClone({body:body.value,mentions:mentions.value,reply:reply.value,attachments:attachments.value,selectedContext:selectedContext.value,contextExplicit:contextExplicit.value,updatedAt:1}),
 };
 const api=new Function(...Object.keys(deps),code+';return {send,switchPeer(value){peer.value=value;chat.peer=value;threadGeneration++;body.value="另一会话草稿";attachments.value=[];}};')(...Object.values(deps));
 return {api,deps,calls,ready:()=>resolve({id:'prepared',name:'one.txt'})};
}
test('leaving the conversation during source preparation cannot send the next conversation draft',async()=>{
 const f=setup(),sending=f.api.send();f.api.switchPeer('self');f.ready();await sending;
 assert.equal(f.calls.length,0);assert.equal(f.deps.body.value,'另一会话草稿');
});
test('edits during source preparation do not replace submitted content or get cleared by its receipt',async()=>{
 const f=setup(),sending=f.api.send();f.deps.body.value='后续新编辑';f.ready();await sending;
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,'原始正文');assert.equal(f.deps.body.value,'后续新编辑');
 assert.deepEqual(f.deps.attachments.value,[]);
});
test('confirmation removes only unchanged confirmed files and keeps a newly added selection',async()=>{
 const f=setup(),sending=f.api.send();f.deps.body.value='后续新编辑';
 const next={id:'next-file',name:'next.txt',mime:'text/plain'};f.deps.attachments.value.push(next);
 f.ready();await sending;assert.deepEqual(f.deps.attachments.value,[next]);assert.equal(f.deps.body.value,'后续新编辑');
});
test('confirmation preserves edits made to the prepared file before the receipt',async()=>{
 const f=setup();let confirm;f.deps.chat.send=value=>{f.calls.push(value);return new Promise(resolve=>confirm=resolve);};
 const sending=f.api.send();f.ready();await new Promise(resolve=>setImmediate(resolve));
 f.deps.attachments.value[0].name='新的附件名.txt';
 confirm({id:'confirmed',attachments:[{id:'prepared'}]});await sending;
 assert.equal(f.deps.attachments.value[0].name,'新的附件名.txt');
});
test('leaving and returning to the same peer still invalidates the old submission',async()=>{
 const f=setup(),sending=f.api.send();f.api.switchPeer('self');f.api.switchPeer('');f.ready();await sending;assert.equal(f.calls.length,0);
});
test('late old preparation cannot clear a new conversation upload indicator',async()=>{
 const f=setup(),sending=f.api.send();f.api.switchPeer('self');f.deps.uploading.value=true;f.deps.fileStage.value='新会话正在准备文件';f.ready();await sending;
 assert.equal(f.deps.uploading.value,true);assert.equal(f.deps.fileStage.value,'新会话正在准备文件');
});
test('unchanged submitted draft is cleared after confirmation',async()=>{
 const f=setup(),sending=f.api.send();f.ready();await sending;
 assert.equal(f.calls[0].body,'原始正文');assert.deepEqual(f.calls[0].attachment_ids,['prepared']);assert.equal(f.deps.body.value,'');assert.deepEqual(f.deps.attachments.value,[]);
});
test('association edited during preparation belongs to the next draft, not the old submission',async()=>{
 const f=setup();f.deps.contextExplicit.value=true;f.deps.selectedContext.value={project_id:'p',work_item_id:'old'};
 const sending=f.api.send();f.deps.selectedContext.value={project_id:'p',work_item_id:'new'};f.ready();await sending;
 assert.equal(f.calls[0].work_item_id,'old');assert.equal(f.deps.selectedContext.value.work_item_id,'new');assert.equal(f.deps.body.value,'原始正文');
});

test('unverified reply blocks a new send without clearing input or preparing files',async()=>{
 for(const state of ['checking','failed']){const f=setup();f.deps.reply.value={id:'old'};if(state==='checking')f.deps.replyChecking.value=true;else f.deps.replyCheckError.value='请重试';await f.api.send();assert.equal(f.calls.length,0);assert.equal(f.deps.body.value,'原始正文');assert.equal(f.deps.attachments.value[0].id,'cloud-old');}
});
