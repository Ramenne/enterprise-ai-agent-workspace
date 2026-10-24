import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {mergeChatMessages} from '../src/chat/projection.ts';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('const replyChecking=ref('),source.indexOf('watch([()=>reply.value?.id,composerLoaded]')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const message=(extra={})=>({id:'old',seq:1,body:'原话',change_version:1,reply_to:null,...extra});
function setup(){
 let resolve,reject;const requests=[],toasts=[],gate=new Promise((a,b)=>{resolve=a;reject=b;});
 const deps={ref:value=>({value}),contextExplicit:{value:false},selectedContext:{value:{project_id:'implicit'}},body:{value:'独立正文'},reply:{value:message()},composerLoaded:{value:true},messageMap:{value:new Map()},quoteMap:{value:new Map()},threadGeneration:1,session:{user:{username:'a'}},peer:{value:''},route:{name:'chat'},communication:{message:(id,signal)=>{requests.push({id,signal});return gate;}},assertContextScope:(m,peer)=>{if((m.conversation_peer||'')!==peer)throw Error('wrong scope');},mergeContextMessages:mergeChatMessages,ui:{toast:t=>toasts.push(t)}};
 const api=new Function(...Object.keys(deps),code+';return {refreshDraftReply,cancelReplyCheck,replyChecking,replyCheckError};')(...Object.values(deps));
 return {api,deps,requests,toasts,resolve:m=>resolve({message:m}),reject};
}
test('off-window hidden reply is removed while independent input state is untouched',async()=>{
 const f=setup(),run=f.api.refreshDraftReply();f.resolve(message({hidden:true,body:'',change_version:8}));await run;assert.equal(f.deps.reply.value,null);assert.equal(f.api.replyChecking.value,false);assert.equal(f.toasts.length,1);assert.equal(f.deps.body.value,'独立正文');assert.equal(f.deps.selectedContext.value,null);
});
test('late authoritative response cannot clear a replacement reply',async()=>{
 const f=setup(),run=f.api.refreshDraftReply();f.deps.reply.value=message({id:'new'});f.resolve(message({hidden:true}));await run;assert.equal(f.deps.reply.value.id,'new');
});
test('account and conversation changes fence late reply responses',async()=>{
 for(const field of ['account','peer']){const f=setup(),run=f.api.refreshDraftReply();if(field==='account')f.deps.session.user.username='b';else f.deps.peer.value='b';f.resolve(message({hidden:true}));await run;assert.equal(f.deps.reply.value.id,'old');assert.equal(f.toasts.length,0);}
});
test('failed or mismatched lookup preserves reply with explicit retry state',async()=>{
 for(const mode of ['network','id','peer']){const f=setup(),run=f.api.refreshDraftReply();if(mode==='network')f.reject(Error('503'));else f.resolve(message(mode==='id'?{id:'other'}:{conversation_peer:'b'}));await run;assert.equal(f.deps.reply.value.id,'old');assert.match(f.api.replyCheckError.value,/重试/);assert.equal(f.api.replyChecking.value,false);}
});
test('lookup is single flight and cancellation ignores the old result',async()=>{
 const f=setup(),run=f.api.refreshDraftReply();await f.api.refreshDraftReply();assert.equal(f.requests.length,1);f.api.cancelReplyCheck();f.resolve(message({recalled:true}));await run;assert.equal(f.deps.reply.value.id,'old');assert.equal(f.requests[0].signal.aborted,true);
});
test('known loaded roots and embedded quotes do not start extra lookups',async()=>{
 for(const field of ['messageMap','quoteMap']){const f=setup();f.deps[field].value.set('old',message());await f.api.refreshDraftReply();assert.equal(f.requests.length,0);}
});
test('authoritative valid reply keeps newer snapshot and never adds history rows',async()=>{
 const f=setup(),run=f.api.refreshDraftReply();f.resolve(message({body:'新快照',change_version:8}));await run;assert.equal(f.deps.reply.value.body,'新快照');assert.equal(f.deps.messageMap.value.size,0);
});

test('explicit work association survives unavailable reply removal',async()=>{
 const f=setup();f.deps.contextExplicit.value=true;const run=f.api.refreshDraftReply();f.resolve(message({recalled:true}));await run;assert.deepEqual(f.deps.selectedContext.value,{project_id:'implicit'});assert.equal(f.deps.body.value,'独立正文');
});
