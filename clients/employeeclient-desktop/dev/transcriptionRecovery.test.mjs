import test from 'node:test';import assert from 'node:assert/strict';import {recoverTranscript} from '../src/chat/transcription-recovery.mjs';
test('re-entry reads the existing completed job without any model write',async()=>{const calls=[];const result=await recoverTranscript(async(...args)=>{calls.push(args);return {state:'completed',result:{text:'测试结果'}};},{job:'original'});assert.equal(result.text,'测试结果');assert.deepEqual(calls.map(x=>[x[0],x[1],x[2].query.job_id]),[['GET','status','original']]);});
test('missing or unfinished job never starts or prepares ASR',async()=>{let called=0;const request=async()=>{called++;return {state:'prepared'};};await assert.rejects(recoverTranscript(request,null));assert.equal(called,0);await assert.rejects(recoverTranscript(request,{job:'original'}),/尚未完成/);assert.equal(called,1);});
test('changed account cannot display a completed response',async()=>{await assert.rejects(recoverTranscript(async()=>({state:'completed',result:{text:'private'}}),{job:'original'},{valid:()=>false}),{name:'AbortError'});});
test('no-speech restores as an empty recognition result without preparing or retrying a paid task',async()=>{
 const calls=[];const result=await recoverTranscript(async(method,action)=>{calls.push([method,action]);return {state:'no_speech'};},{job:'original'});
 assert.equal(result.noSpeech,true);assert.equal(result.text,'');assert.deepEqual(calls,[['GET','status']]);
});
test('explicit conversion of a saved no-speech job returns terminal result without another start',async()=>{
 const {transcribeOperation}=await import('../src/chat/transcription-operation.mjs');const calls=[],input={project_id:'project',material_id:'material',version_id:'version',sha256:'hash'};
 const result=await transcribeOperation(async(method,action)=>{calls.push([method,action]);return {state:'no_speech'};},input,{load:()=>({identity:JSON.stringify(['project','material','version','hash']),job:'original'})});
 assert.equal(result.noSpeech,true);assert.equal(result.text,'');assert.deepEqual(calls,[['GET','status']]);
});
