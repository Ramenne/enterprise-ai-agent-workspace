import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {parse,compileScript} from '@vue/compiler-sfc';import ts from 'typescript';import {ref,watch,nextTick} from 'vue';import {userError} from '../src/domain/userError.mjs';
async function picker(deps,props,events){
 const source=await readFile(new URL('../src/ui/components/ChatAttachmentPicker.vue',import.meta.url),'utf8');const {descriptor}=parse(source),compiled=compileScript(descriptor,{id:'voice-recovery'});
 const js=ts.transpileModule(compiled.content,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]*\n/gm,'').replace('export default','return');
 const imports={TransferSector:{},VoicePlayer:{},AppIcon:{},pendingSharedFiles:async()=>[],readSharedFile:()=>{},clearSharedFiles:async()=>{},acknowledgeSharedFile:async()=>{},uploadChatFile:()=>{},decodeVoiceDuration:()=>{},startChatTransfer:()=>{},stageChatTransfer:()=>{},_defineComponent:v=>v,ref,watch,onBeforeUnmount:()=>{},onMounted:()=>{},userError,captureApiLease:()=>({valid:()=>true,account:'a'}),useSessionStore:()=>({user:{username:'a'}}),newIdempotencyKey:()=> 'voice-key',stopVoicePlayback:()=>{},durationKey:()=> 'voice',rememberVoiceDuration:()=>{},MAX_CHAT_FILE_BYTES:100*1024**3,...deps};
 const component=new Function(...Object.keys(imports),js)(...Object.values(imports));let exposed;const state=component.setup(props,{expose:v=>exposed=v,emit:(...event)=>events.push(event)});return {state,exposed};
}
test('ordinary file choice stages the original file and captured association without immediate sending',async()=>{
 const staged=[],events=[];let sends=0;const body={body:'',reply_to_id:'original',mention_usernames:['b'],attachment_ids:[]};
 const {state}=await picker({stageChatTransfer:(...args)=>{staged.push(args);return {promise:Promise.resolve(false)};},startChatTransfer:()=>sends++},{peer:'b',deliveryBody:()=>body},events);
 const file=new File(['chosen bytes'],'chosen.txt',{type:'text/plain'}),input={files:[file],value:'file'};await state.choose({target:input});assert.equal(input.value,'');assert.equal(sends,0);assert.equal(staged[0][0],file);assert.equal(staged[0][2],'b');assert.equal(staged[0][3].reply_to_id,'original');assert.equal(events[0][0],'fileSource');assert.equal(state.busy.value,false);
});
test('hold release submits voice and failure leaves composer unlocked, without a duplicate local draft/error',async t=>{
 const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),originalRecorder=globalThis.MediaRecorder;let stopped=0,uploads=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stopped++}]})}}});
 globalThis.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/mp4';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['synthetic voice fixture'],{type:'audio/mp4'})});this.onstop();}};
 t.after(()=>{Object.defineProperty(globalThis,'navigator',originalNavigator);globalThis.MediaRecorder=originalRecorder;});
 const events=[],{state,exposed}=await picker({startChatTransfer:()=>{uploads++;return {state:'error',error:'连接暂时不可用，语音已保留',promise:Promise.resolve(false)};}},{peer:'a',hideVoice:true,deliveryBody:()=>({body:'',attachment_ids:[],mention_usernames:[]})},events);
 await exposed.record({autoSend:true});await nextTick();assert.equal(state.recording.value,true);exposed.stop();await new Promise(r=>setTimeout(r,10));await nextTick();
 assert.equal(uploads,1);assert.ok(stopped>=1);assert.equal(state.busy.value,false);assert.equal(state.draft.value,null);assert.equal(state.failed.value,null);assert.equal(state.error.value,'');assert.equal(events.filter(e=>e[0]==='busy').at(-1)[1],false);assert.equal(events.filter(e=>e[0]==='active').at(-1)?.[1]??false,false);
});
test('an unsent manual preview is active content, never an uploading lock',async()=>{
 const events=[],{state}=await picker({}, {peer:'a'},events);state.draft.value=new File(['voice'],'voice.m4a',{type:'audio/mp4'});await nextTick();assert.ok(!events.some(e=>e[0]==='busy'&&e[1]));assert.equal(events.find(e=>e[0]==='active')?.[1],true);
});
test('cancel while microphone permission is pending unlocks immediately and releases a late stream',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),recorder=globalThis.MediaRecorder;let resolvePermission,stopped=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(r=>resolvePermission=r)}}});globalThis.MediaRecorder=class {static isTypeSupported(){return true;}};t.after(()=>{Object.defineProperty(globalThis,'navigator',descriptor);globalThis.MediaRecorder=recorder;});
 const {state,exposed}=await picker({}, {peer:'a',hideVoice:true},[]);const starting=exposed.record({autoSend:true});await nextTick();assert.equal(state.busy.value,true);exposed.stop(true);assert.equal(state.busy.value,false);resolvePermission({getTracks:()=>[{stop:()=>stopped++}]});await starting;assert.equal(stopped,1);assert.equal(state.recording.value,false);assert.equal(state.draft.value,null);
});
test('same-account session recovery does not permanently disable capture, but another account is rejected',async t=>{
 let epoch=1,account='a',requests=0;const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),original=globalThis.MediaRecorder;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{requests++;return {getTracks:()=>[{stop:()=>{}}]};}}}});globalThis.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.onstop();}};t.after(()=>{Object.defineProperty(globalThis,'navigator',descriptor);globalThis.MediaRecorder=original;});
 const {exposed,state}=await picker({captureApiLease:()=>{const owner=account,generation=epoch;return {account:owner,valid:()=>account===owner&&epoch===generation};}},{peer:'a',hideVoice:true},[]);
 epoch++;await exposed.record({autoSend:true});assert.equal(requests,1);assert.equal(state.recording.value,true);exposed.stop(true);account='b';epoch++;await exposed.record({autoSend:true});assert.equal(requests,1);
});

test('permission denial releases capture state, reports an actionable error and creates no transfer',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),original=globalThis.MediaRecorder;let sent=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{throw new DOMException('Denied','NotAllowedError');}}}});globalThis.MediaRecorder=class{static isTypeSupported(){return true;}};
 t.after(()=>{Object.defineProperty(globalThis,'navigator',descriptor);globalThis.MediaRecorder=original;});
 const events=[],{state,exposed}=await picker({startChatTransfer:()=>{sent++;}},{peer:'b',hideVoice:true,deliveryBody:()=>({body:'',attachment_ids:[]})},events);
 await exposed.record({autoSend:true});await nextTick();assert.equal(sent,0);assert.equal(state.busy.value,false);assert.equal(state.recording.value,false);assert.equal(state.draft.value,null);assert.match(state.error.value,/麦克风权限未开启/);assert.ok(events.some(e=>e[0]==='captureError'&&/系统设置/.test(e[1])));
});

test('microphone ending outside explicit completion cannot silently send a recording',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),original=globalThis.MediaRecorder;let recorder,sent=0,stopped=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stopped++}]})}}});
 globalThis.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){recorder=this;this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['partial voice'])});this.onstop();}};
 t.after(()=>{Object.defineProperty(globalThis,'navigator',descriptor);globalThis.MediaRecorder=original;});
 const {state,exposed}=await picker({startChatTransfer:()=>{sent++;return {promise:Promise.resolve(true)};}},{peer:'b',deliveryBody:()=>({body:'',attachment_ids:[]})},[]);
 await exposed.record({autoSend:true});recorder.stop();await new Promise(r=>setImmediate(r));
 assert.equal(sent,0);assert.equal(state.draft.value,null);assert.equal(state.recording.value,false);assert.match(state.error.value,/录音中断/);assert.ok(stopped>0);
});
test('manual microphone permission has cancellable UI state and late rejection cannot overwrite a later action',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),original=globalThis.MediaRecorder;let rejectPermission;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise((_,reject)=>rejectPermission=reject)}}});globalThis.MediaRecorder=class{static isTypeSupported(){return true;}};
 t.after(()=>{Object.defineProperty(globalThis,'navigator',descriptor);globalThis.MediaRecorder=original;});
 const {state,exposed}=await picker({}, {peer:'a'},[]),work=exposed.record();
 assert.equal(state.requestingPermission?.value,true);exposed.stop(true);assert.equal(state.requestingPermission.value,false);state.error.value='later action';rejectPermission(new DOMException('Denied','NotAllowedError'));await work;assert.equal(state.error.value,'later action');assert.equal(state.busy.value,false);
});
