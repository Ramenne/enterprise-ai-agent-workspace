import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function fixture(privateFile=false,fast=false){
 const saved=new Map(),receipts=new Map(),requests=[];let current='a',counter=0,loseResponse=false,hold;
 const storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
 const chat={acceptSent:()=>true,account:'a',peer:'private-person',pending:null,error:'',refresh:async()=>{},setAccount:async()=>{throw Error('forward must not change composer');},send:async()=>{throw Error('forward must not consume composer pending');}};
 const communication={send:async(body,key)=>{
  const owner=current;if(hold)await hold;if(current!==owner)throw Error('账号已切换，文件未发送');
  const op={body,key};requests.push(op);
  if(loseResponse){loseResponse=false;receipts.set(op.key,{id:'delivered-once',attachments:[{id:op.body.attachment_ids[0]}]});throw Error('response lost');}
  const message=receipts.get(op.key)||{id:'new-message',attachments:[{id:op.body.attachment_ids[0]}]};receipts.set(op.key,message);return {message};
 }};
 const forbidden=()=>{throw Error('existing group reference must not download, upload or resolve cloud');};
 const privateOps=[],original=new Blob(['private source']);
 const cached={uploadSource:original,cacheAs:async(a)=>privateOps.push({alias:a.id}),dispose(){}};
 const deps={canSendSmallMedia:()=>fast,sendSmallMedia:async(file,body,_peer,_purpose,_duration,key)=>{assert.equal(await(await file.readPart(0,file.size)).text(),'private source');privateOps.push({fast:key});return communication.send({...body,attachment_ids:['public-fixed-original']},key);},uploadChatFile:privateFile?async(file,key)=>{assert.equal(await(await file.readPart(0,file.size)).text(),'private source');privateOps.push({upload:key});return {id:'public-fixed-original',sha256:'hash',size:original.size,ver:1,name:'report.xlsx'};}:forbidden,findAttachment:privateFile?async()=>cached:forbidden,cachedCloudFile:()=>undefined,cloudFileAttachment:forbidden,cloudFileContext:forbidden,shareCloudFile:forbidden,getAcquisition:forbidden,startAcquisition:privateFile?()=>({promise:Promise.resolve()}):forbidden,startCloudJob:forbidden,
  sourceIdentity:(a,c)=>[c.account,c.computer,c.provider,c.thread,a.id,a.version],cacheLease:a=>()=>a===current,useChatStore:()=>chat,communication,newIdempotencyKey:()=> 'operation-'+(++counter),localStorage:storage,window:{dispatchEvent(){}},CustomEvent:globalThis.CustomEvent};
 const source=await readFile(new URL('../src/files/groupSend.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
 const engine=new Function(...Object.keys(deps),code+';return {startGroupSend,beginNewGroupSend};')(...Object.values(deps));
 const attachment={id:privateFile?'private:original':'fixed-original',version:'1:hash',name:'report.xlsx',kind:'file',mime:'application/octet-stream',groupAttachment:{id:privateFile?'private:original':'fixed-original',name:'report.xlsx',sha256:'hash',size:17,ver:1}},context={account:'a',computer:'cloud',provider:'company',thread:'group'};
 return {privateOps,engine,attachment,context,saved,requests,chat,receipts,failOnce:()=>loseResponse=true,switchAccount:()=>current='b',pause:()=>{let resolve;hold=new Promise(r=>resolve=r);return resolve;}};
}
test('group forward sends empty-text reference directly, double taps share one operation, no cloud or draft path',async()=>{
 const f=await fixture();const one=f.engine.startGroupSend(f.attachment,f.context,'');const two=f.engine.startGroupSend(f.attachment,f.context,'');assert.equal(one,two);
 const result=await one.promise;assert.equal(result.state,'complete');assert.deepEqual(f.requests[0].body,{body:'',attachment_ids:['fixed-original'],mention_usernames:[]});assert.equal(f.requests.length,1);
 assert.equal([...f.saved.keys()].some(k=>k.startsWith('qn.forward:')),false);
});
test('lost response retries the same intent and does not create a second group message',async()=>{
 const f=await fixture();f.failOnce();await assert.rejects(f.engine.startGroupSend(f.attachment,f.context,'').promise,/response lost/);
 const key=f.requests[0].key;const retried=await f.engine.startGroupSend(f.attachment,f.context,'').promise;assert.equal(retried.messageId,'delivered-once');assert.equal(f.requests[1].key,key);assert.equal(f.receipts.size,1);
});
test('another pending message is preserved and an account change cannot send to the new account',async()=>{
 const f=await fixture(),prior={key:'prior',body:{body:'unsent text',attachment_ids:[],mention_usernames:[]}};f.chat.pending=prior;
 await f.engine.startGroupSend(f.attachment,f.context,'').promise;assert.equal(f.chat.pending,prior);assert.equal(f.chat.peer,'private-person');assert.equal(f.requests.length,1);
 const g=await fixture(),resume=g.pause(),job=g.engine.startGroupSend(g.attachment,g.context,'');g.switchAccount();resume();await assert.rejects(job.promise,/账号已切换/);assert.equal(g.requests.length,0);
});

test('private forwarding explicitly publishes a group copy without exposing the private reference or consuming the direct composer',async()=>{
 const f=await fixture(true),prior={key:'private-composer',body:{body:'unfinished'}};f.chat.pending=prior;
 const sent=await f.engine.startGroupSend(f.attachment,f.context,'').promise;assert.equal(sent.state,'complete');assert.deepEqual(f.requests[0].body.attachment_ids,['public-fixed-original']);assert.equal(f.chat.pending,prior);assert.equal(f.chat.peer,'private-person');assert.equal(f.privateOps.filter(x=>x.upload).length,1);assert.deepEqual(f.privateOps.filter(x=>x.alias),[{alias:'public-fixed-original'}]);
});
test('small private forward uses one public-copy submission and retains its original key after lost receipt',async()=>{
 const f=await fixture(true,true);f.failOnce();const first=f.engine.startGroupSend(f.attachment,f.context,'');await assert.rejects(first.promise);const sent=await f.engine.startGroupSend(f.attachment,f.context,'').promise;assert.equal(sent.messageId,'delivered-once');assert.equal(f.privateOps.filter(x=>x.upload).length,0);assert.equal(f.requests.length,2);assert.equal(f.requests[0].key,f.requests[1].key);assert.deepEqual(f.requests[0].body.attachment_ids,['public-fixed-original']);assert.equal(f.receipts.size,1);
});
