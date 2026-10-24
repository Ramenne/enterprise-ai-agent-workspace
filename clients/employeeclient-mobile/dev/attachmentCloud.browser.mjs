import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import {designCss} from './designCss.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fixture=`import {reactive} from 'vue';export const session=reactive({user:{username:'account-a'}});export const useSessionStore=()=>session;window.session=session;`;
const styles=[];
const result=await build({stdin:{contents:`import {findAttachment,loadAttachment,sourceIdentity} from '@/collaboration/media';import {saveCloudFile,cachedCloudFile} from '@/files/cloud';import {startCloudJob} from '@/files/cloudJobs';import * as fileCache from '@/platform/attachmentCache';import {getChatDownload} from '@/chat/files';window.findAttachment=findAttachment;window.saveCloudFile=saveCloudFile;window.cachedCloudFile=cachedCloudFile;window.startCloudJob=startCloudJob;window.fileCache=fileCache;window.sourceIdentity=sourceIdentity;window.loadGroupFile=async(a,account='account-a')=>{const ctx={account,computer:'cloud',provider:'company',thread:'group'};const item={...a,kind:'file',version:a.ver+':'+a.sha256,resolveUrl:async(signal)=>(await getChatDownload(a.id,signal)).download_url};const m=await loadAttachment(item,ctx,new AbortController().signal,()=>{});const text=await m.blob.text();m.dispose();const saved=await findAttachment(item,ctx);const cached=await saved?.blob?.text();saved?.dispose();return {text,cached};};import {createApp,reactive,h} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{}},{path:'/chat',component:{}},{path:'/files',name:'files',component:{}}]});import View from '@/ui/components/CollaborationMessage.vue';window.items=reactive([]);window.mediaContext=reactive({account:'account-a',computer:'mac',provider:'codex',thread:'thread'});createApp({setup(){return()=>window.items.map(m=>h(View,{message:m,providerName:'Codex',mediaContext:window.mediaContext}));}}).use(router).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',define:{'import.meta.env':'{}'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>({path:resolve(dirname(a.importer),a.path)+(a.path.endsWith('.vue')?'':'.ts'),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onResolve({filter:/^(@\/session\/store|@\/collaboration\/api|@\/store\/data|@\/store\/ui)$/},()=>({path:'fixture',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,loader:'ts',resolveDir:process.cwd()}));
 b.onResolve({filter:/^@\/store\/chat$/},()=>({path:'chat-fixture',namespace:'chat-fixture'}));
 b.onLoad({filter:/.*/,namespace:'chat-fixture'},()=>({contents:`window.groupMessages=[];window.groupByKey={};const chat={account:'account-a',pending:null,messages:[],error:'',setAccount:async()=>{},refresh:async()=>{},send:async(body,key)=>{const value=body||chat.pending?.body;if(!value||!key)throw Error('missing group operation');if(!chat.pending)chat.pending={body:value,key};if(chat.pending.key!==key)throw Error('changed group operation');let message=window.groupByKey[key];if(!message){message={id:'group-message-'+(window.groupMessages.length+1),attachments:value.attachment_ids.map(id=>({id})),body:value.body};window.groupByKey[key]=message;window.groupMessages.push(message);chat.messages.push(message);}if(window.failSendOnce){window.failSendOnce=false;chat.error='原回执暂不可读';return false;}chat.pending=null;return message;}};export const useChatStore=()=>chat;`,loader:'ts'}));
 b.onResolve({filter:/^@\//},a=>({path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onLoad({filter:/.*/,namespace:'sfc'},a=>{const{descriptor}=parse(readFileSync(a.path,'utf8'));const id='data-v-'+createHash('sha1').update(a.path).digest('hex').slice(0,8);styles.push(...descriptor.styles.map(s=>compileStyle({source:s.content,filename:a.path,id,scoped:s.scoped}).code));return{contents:compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const view =')+'\nview.__scopeId='+JSON.stringify(id)+';export default view;',loader:'ts',resolveDir:dirname(a.path)};});
 // Relative api import from real commands.ts must share the same fixture.
 
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const bytes=Buffer.from('外部文件真实字节\n'.repeat(60000)),sha=createHash('sha256').update(bytes).digest('hex');const groupBytes=Buffer.from('test-file-43-bytes:'+'x'.repeat(24)),groupSha=createHash('sha256').update(groupBytes).digest('hex');let fetches=0,puts=0,groupGets=0,shares=0,complete=false,saved=false,resumeReady=false,failComplete=false,cloudName='',cloudOriginalName='',holdComplete=false,releaseComplete,enteredComplete,holdShare=false,releaseShare,enteredShare,holdSlow=false,releaseSlow,enteredSlow;
 let enteredCompletePromise=Promise.resolve();
 const grant={id:'U'.repeat(24),endpoint:'https://mengchu.example.invalid/api/uploads/'+'U'.repeat(24),capability:'T'.repeat(43),part_size:16*1024**2,size:bytes.length};
 const file=()=>({id:'cl1',name:cloudName,original_name:cloudOriginalName,mime:'text/plain',size:bytes.length,file_id:'cloud1',ver:1,sha256:sha,state:saved?'ready':'pending',source_key:'a'.repeat(64)});
 await page.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url()),path=u.pathname;
  if(u.hostname==='outside.test'){fetches++;if(path==='/slow.txt'&&holdSlow){enteredSlow?.();await new Promise(resolve=>{releaseSlow=resolve;});}return route.fulfill({body:path==='/new.txt'?Buffer.from('新版本内容'):bytes,contentType:'text/plain',headers:{'Access-Control-Allow-Origin':'*'}});}
  if(u.hostname==='mengstore-1316920087.cos.ap-shanghai.myqcloud.com'){if(path==='/group43'){groupGets++;return route.fulfill({status:200,body:groupBytes,contentType:'text/plain'});}if(path==='/group1'&&request.method()==='GET'){groupGets++;return route.fulfill({status:200,body:bytes,contentType:'text/plain'});}puts++;if(!request.postDataBuffer().equals(bytes))throw Error('cloud bytes differ');return route.fulfill({status:200,body:''});}
  if(path==='/api/v2/company/chat/files/test43/download')return route.fulfill({json:{attachment:{id:'test43'},download_url:'https://mengstore-1316920087.cos.ap-shanghai.myqcloud.com/group43'}});
  if(path==='/api/v2/company/chat/files/group1/download')return route.fulfill({json:{attachment:{id:'group1'},download_url:'https://mengstore-1316920087.cos.ap-shanghai.myqcloud.com/group1'}});
  if(path.includes('/api/uploads/')){const action=path.split('/').at(-1);if(action==='part')return route.fulfill({json:{size:bytes.length,url:'https://mengstore-1316920087.cos.ap-shanghai.myqcloud.com/upload',headers:{}}});if(action==='complete'){if(request.postDataJSON().sha256!==sha)throw Error('SHA mismatch');complete=true;}return route.fulfill({json:{state:complete?'complete':'uploading',sha256:complete?sha:undefined,parts:[]}});}
  if(path==='/api/v2/me/file-library'){
   if(request.method()==='GET')return route.fulfill({json:{file:resumeReady?file():null}});
   const b=request.postDataJSON();if(b.content_size!==bytes.length||b.attachment.size!==undefined)throw Error('unknown remote size not normalized '+JSON.stringify(b));if(saved)return route.fulfill({json:{file:file()}});cloudName=b.attachment.name;cloudOriginalName=cloudName;return route.fulfill({json:{file:file(),grant}});
  }
  if(path.endsWith('/cl1/rename')){cloudName=request.postDataJSON().name;return route.fulfill({json:{file:file()}});}
  if(path.endsWith('/cl1/complete')){if(holdComplete){enteredComplete?.();await new Promise(resolve=>{releaseComplete=resolve;});}if(failComplete)return route.fulfill({status:503,json:{error:'upstream_unavailable'}});saved=true;return route.fulfill({json:{file:file()}});}
  if(path.endsWith('/cl1/share')){shares++;const groupName=request.postDataJSON().name;if(holdShare){enteredShare?.();await new Promise(resolve=>{releaseShare=resolve;});}return route.fulfill({json:{attachment:{id:'group1',file_id:'public1',ver:1,sha256:sha,name:groupName,size:bytes.length,mime:'text/plain'}}});}
  if(path.includes('/commands'))throw Error('local bytes incorrectly requested Mac');
  return route.fulfill({contentType:'text/html',body:'<main id="app" style="padding:16px"></main>'});
 });
 await page.goto('https://collab.test/');await page.evaluate(()=>{window.showSaveFilePicker=undefined;});await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 const group=await page.evaluate(async a=>window.loadGroupFile(a),{id:'test43',file_id:'group43',name:'测试文件.txt',mime:'text/plain',size:groupBytes.length,ver:1,sha256:groupSha});
 if(group.text!==groupBytes.toString()||group.cached!==group.text||groupGets!==1)throw Error('published group file did not fetch verified bytes once and reopen from cache');
 const recoveredAlias=await page.evaluate(async sha=>{
  const c=window.fileCache,original={id:'source-fallback',name:'same.txt',mime:'text/plain',kind:'file'},shared={id:'test43',name:'测试文件.txt',mime:'text/plain',kind:'file',size:43,version:`1:${sha}`,sha256:sha};
  const source={account:'account-a',computer:'mac',provider:'codex',thread:'old'},group={account:'account-a',computer:'cloud',provider:'company',thread:'group'};
  const from=await c.attachmentKey(window.sourceIdentity(original,source)),to=await c.attachmentKey(window.sourceIdentity(shared,group));
  c.rememberAttachmentAlias(from,to);
  const result=await window.findAttachment(shared,group),body=await result?.blob?.text();result?.dispose();return body;
 },groupSha);
 if(recoveredAlias!==groupBytes.toString()||groupGets!==1)throw Error('stale source alias hides a verified group cache entry');
 await page.evaluate(()=>window.items.push({id:'m',role:'assistant',phase:'final',text:'附件',attachments:[{id:'remote',name:'原始文件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]}));
 const card=page.locator('.collab-attachment');const menu=async()=>card.getByRole('button',{name:'保存或分享文件'}).click();
 await menu();await page.getByRole('button',{name:'下载到本机',exact:true}).click();if(await page.getByRole('textbox',{name:'文件名称'}).count())throw Error('save opened keyboard before rename was requested');await page.getByRole('button',{name:'重命名'}).click();await page.getByRole('textbox',{name:'文件名称'}).fill('项目交接说明.txt');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'确认保存',exact:true}).click();const dl=await pending;if(dl.suggestedFilename()!=='项目交接说明.txt'||!readFileSync(await dl.path()).equals(bytes))throw Error('local name/bytes mismatch');await page.getByRole('button',{name:'完成',exact:true}).click();
 await menu();await page.getByRole('button',{name:'保存到梦空间',exact:true}).click();await page.getByRole('button',{name:'重命名'}).click();await page.getByRole('textbox',{name:'文件名称'}).fill('项目交接说明.txt');await page.getByRole('button',{name:'确认保存',exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();try{await card.getByRole('status').filter({hasText:'已存梦空间'}).waitFor({timeout:5000});}catch(e){throw Error('cloud save diagnostic: '+await page.locator('body').innerText()+'; errors='+errors.join('|')+'; '+e);}
 if(fetches!==1||puts!==1)throw Error('download/upload duplicated');
 const staleCloudReuse=await page.evaluate(async length=>{
  const old=window.items[0].attachments[0],changed=new Blob([new Uint8Array(length)],{type:'text/plain'});
  try{await window.saveCloudFile(old,window.mediaContext,new AbortController().signal,()=>{},changed);return 'accepted';}
  catch(e){return e.message;}
 },bytes.length);
 if(!staleCloudReuse.includes('内容已变化'))throw Error('existing cloud file did not reject changed bytes: '+staleCloudReuse);
 const staleKnownPage=await context.newPage();
 try{
  await staleKnownPage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main id="app"></main>'}));
  await staleKnownPage.goto('https://collab.test/');
  await staleKnownPage.addScriptTag({content:result.outputFiles[0].text});
  const staleKnownReuse=await staleKnownPage.evaluate(async length=>{
   const old={id:'remote',name:'原始文件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'},ctx={account:'account-a',computer:'mac',provider:'codex',thread:'thread'};
   const known=window.cachedCloudFile(old,ctx),changed=new Blob([new Uint8Array(length)],{type:'text/plain'});
   if(!known)return 'missing existing file';
   let rejected='accepted';
   try{await window.startCloudJob(old,ctx,changed,known,known.name).promise;}
   catch(e){rejected=e.message;}
   const verified=await window.findAttachment(old,ctx);
   try{const resumed=await window.startCloudJob(old,ctx,verified.uploadSource,known,known.name).promise;return {rejected,recovered:resumed.file?.id};}
   finally{verified?.dispose();}
  },bytes.length);
  if(!staleKnownReuse.rejected?.includes('内容已变化')||staleKnownReuse.recovered!=='cl1')throw Error('already-known cloud file failed content verification or recovery: '+JSON.stringify(staleKnownReuse));
 }finally{await staleKnownPage.close();}
 await menu();await page.getByRole('button',{name:'发送到工作群'}).click();if(await page.getByRole('button',{name:'重命名'}).count())throw Error('group send incorrectly asks for rename');await page.getByRole('textbox',{name:'附言（可选）'}).fill('请查看文件');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.groupMessages.length===1);
 await page.evaluate(()=>{const m=window.items[0];window.items.splice(0,1,{...m,id:'m-share-refreshed'});});
 await card.getByRole('button',{name:'查看群消息'}).waitFor();
 if(await page.evaluate(()=>localStorage.getItem('qn.forward:account-a')))throw Error('collaboration forward wrongly created a chat draft');
 const sent=await page.evaluate(()=>window.groupMessages[0]);if(sent.attachments[0].id!=='group1'||sent.body!=='请查看文件'||cloudName!=='项目交接说明.txt'||shares!==1)throw Error('group forward mismatch '+JSON.stringify({sent,cloudName,shares}));
 const beforeGroupOpen=groupGets;
 const forwarded=await page.evaluate((a)=>window.loadGroupFile(a),{id:'group1',file_id:'public1',name:'原始文件.txt',mime:'text/plain',size:bytes.length,ver:1,sha256:sha});
 if(forwarded.text!==bytes.toString()||groupGets!==beforeGroupOpen)throw Error('forwarded group file downloaded bytes already cached on this phone');
 // A fresh page in the same browser storage and app account must resolve the
 // persisted alias without repeating a GET after the collaboration page is gone.
 const reopened=await context.newPage();
 try{
  await reopened.route('**/*', route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='collab.test'&&u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<main id="app" style="padding:16px"></main>'});
   throw Error('fresh WebView made a network request for already cached group file: '+u.pathname);
  });
  await reopened.goto('https://collab.test/');
  await reopened.addScriptTag({content:result.outputFiles[0].text});
  const afterRestart=await reopened.evaluate((a)=>window.loadGroupFile(a),{id:'group1',file_id:'public1',name:'原始文件.txt',mime:'text/plain',size:bytes.length,ver:1,sha256:sha});
  if(afterRestart.text!==bytes.toString()||afterRestart.cached!==afterRestart.text||groupGets!==beforeGroupOpen)throw Error('forwarded group file lost its verified cache in a fresh page');
 }finally{await reopened.close();}
 // A different account identity on this device must not inherit the first account's bytes.
 const other=await page.evaluate((a)=>window.loadGroupFile(a,'account-b'),{id:'group1',file_id:'public1',name:'原始文件.txt',mime:'text/plain',size:bytes.length,ver:1,sha256:sha});
 if(other.text!==bytes.toString()||other.cached!==other.text||groupGets!==beforeGroupOpen+1)throw Error('group cache crossed account boundary or second account did not persist bytes');
 console.log('PASS identical group attachment remains isolated between account cache identities');
 // A previous local fetch remains reusable; forwarding itself must not fetch it again.
 if(fetches!==1||puts!==1||errors.length)throw Error(errors.join('\n')||'share refetched bytes');
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByRole('button',{name:'保存 / 分享',exact:true}).click();await page.getByRole('button',{name:'发送到工作群'}).waitFor();await page.getByRole('dialog').waitFor();await page.screenshot({path:'artifacts/collaboration/file-actions-0498.png',fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await page.getByRole('dialog').waitFor();
 const newSha=createHash('sha256').update('新版本内容').digest('hex');
 await page.evaluate(sha=>{Object.assign(window.items[0].attachments[0],{sha256:sha,name:'新版本.txt',url:'https://outside.test/new.txt'});},newSha);
 await page.getByRole('dialog').waitFor({state:'hidden'});await card.getByText('新版本.txt',{exact:true}).waitFor();
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await page.getByRole('dialog').getByText('新版本内容',{exact:true}).waitFor();
 if(fetches!==2)throw Error('same-id digest change did not fetch exactly one new version');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.evaluate(()=>{window.items.splice(0,1,{id:'m2',role:'assistant',phase:'final',text:'附件',attachments:[{...window.items[0].attachments[0]}]});});
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await page.getByRole('dialog').getByText('新版本内容',{exact:true}).waitFor();
 if(fetches!==2||errors.length)throw Error(errors.join('\n')||'new version refetched after remount');
 // Long filenames and reduced keyboard viewports must keep actions reachable.
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.evaluate(()=>{window.items[0].attachments[0].name='项目交接文件'.repeat(25)+'.txt';});
 for(const width of [320,390,430]){
  for(const height of [844,360]){
   await page.setViewportSize({width,height});await menu();
   const dialog=page.getByRole('dialog');
   await dialog.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished));});
   const bounds=await dialog.boundingBox();
   if(!bounds||bounds.x<0||bounds.x+bounds.width>width+1||bounds.y<0||bounds.y+bounds.height>height+1)throw Error(`dialog outside viewport ${width}x${height}: ${JSON.stringify(bounds)}`);
   const buttons=dialog.locator('.file-menu button');
   for(let i=0;i<await buttons.count();i++){
    const button=buttons.nth(i);await button.scrollIntoViewIfNeeded();
    const reachable=await button.evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.height>=44&&(el===hit||el.contains(hit));});
    if(!reachable)throw Error(`action occluded ${width}x${height}: ${await button.textContent()}`);
   }
   await dialog.getByRole('button',{name:'关闭',exact:true}).click();
   await menu();await page.getByRole('button',{name:'发送到工作群'}).click();
   const destination=page.getByRole('dialog');
   await destination.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished));});
   const destinationBounds=await destination.boundingBox();
   if(!destinationBounds||destinationBounds.x<0||destinationBounds.x+destinationBounds.width>width+1||destinationBounds.y<0||destinationBounds.y+destinationBounds.height>height+1)throw Error(`group send sheet outside viewport ${width}x${height}: ${JSON.stringify(destinationBounds)}`);
   if(await destination.getByRole('button',{name:'重命名'}).count())throw Error('group send sheet contains rename');
   for(const name of ['发送']){
    const button=destination.getByRole('button',{name,exact:true});await button.scrollIntoViewIfNeeded();
    const reachable=await button.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.height>=36&&(el===hit||el.contains(hit));});
    if(!reachable)throw Error(`group action occluded ${width}x${height}: ${name}`);
   }
   await destination.getByRole('button',{name:'关闭',exact:true}).click();
  }
 }
 // A source refresh may replace the whole message while the cloud completion
 // request is in flight. The transfer must outlive its original card.
 saved=false;complete=false;holdComplete=true;enteredCompletePromise=new Promise(resolve=>{enteredComplete=resolve;});
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{window.items.splice(0,1,{id:'m3',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote2',name:'再次生成.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]});});
 await menu();await page.getByRole('button',{name:'保存到梦空间',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();
 await enteredCompletePromise;
 await page.evaluate(()=>{const m=window.items[0];window.items.splice(0,1,{...m,id:'m4'});});
 releaseComplete();holdComplete=false;
 await card.getByRole('status').filter({hasText:/已存.*梦空间/}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).click();
 // Sending directly from collaboration uses the source name and creates a real
 // group message. Only choosing a file inside the group uses its draft composer.
 saved=false;complete=false;cloudName='';cloudOriginalName='';
 await page.evaluate(()=>{window.items.splice(0,1,{id:'m5',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote3',name:'个人原件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]});});
 await menu();await page.getByRole('button',{name:'发送到工作群'}).click();await page.getByRole('button',{name:'发送',exact:true}).click();await page.waitForFunction(()=>window.groupMessages.length===2);
 if(cloudName!=='个人原件.txt'||cloudOriginalName!==cloudName||await page.evaluate(()=>localStorage.getItem('qn.forward:account-a')))throw Error(`direct send renamed source or staged draft: ${cloudName}`);
 // A hard page reload loses component memory. The durable intent must recover
 // the same cloud source without a second byte upload when the server completed.
 saved=false;complete=false;holdComplete=true;enteredCompletePromise=new Promise(resolve=>{enteredComplete=resolve;});
 await page.evaluate(()=>{window.items.splice(0,1,{id:'reload-case',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote-reload',name:'可恢复原件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]});});
 await menu();await page.getByRole('button',{name:'保存到梦空间',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();
 await enteredCompletePromise;
 if(!await page.evaluate(()=>JSON.parse(localStorage.getItem('qn.cloud-pending:account-a')||'[]').some(item=>item.key.includes('remote-reload'))))throw Error('cloud operation has no durable intent');
 const putsBeforeReload=puts; saved=true;complete=true;resumeReady=true;
 await page.reload();releaseComplete();holdComplete=false;
 await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(()=>{window.items.push({id:'reload-case',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote-reload',name:'可恢复原件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]});});
 await card.getByRole('status').filter({hasText:/已存.*梦空间/}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).click();
 await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('qn.cloud-pending:account-a')||'[]').some(item=>item.key.includes('remote-reload')));
 if(puts!==putsBeforeReload)throw Error('hard reload repeated cloud byte upload');
 // A preview acquisition is file-owned. Moving to another message while its
 // request is in flight must not cancel it or prevent a simultaneous group send.
 saved=false;complete=false;cloudName='';cloudOriginalName='';holdSlow=true;
 const slowBefore=fetches,groupBefore=await page.evaluate(()=>window.groupMessages.length);
 const enteredSlowPromise=new Promise(resolve=>{enteredSlow=resolve;});
 await page.evaluate(()=>{window.items.splice(0,1,{id:'slow-message',role:'assistant',phase:'final',text:'慢文件',attachments:[{id:'remote-slow',name:'慢文件.txt',mime:'text/plain',kind:'file',url:'https://outside.test/slow.txt'}]});});
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await enteredSlowPromise;
 await card.getByRole('progressbar').waitFor();await menu();await page.getByRole('button',{name:'发送到工作群'}).click();await page.getByRole('textbox',{name:'附言（可选）'}).fill('并发发送');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.evaluate(()=>{const m=window.items[0];window.items.splice(0,1,{...m,id:'slow-message-refreshed'});});
 releaseSlow();holdSlow=false;
 await page.waitForFunction(before=>window.groupMessages.length>before,groupBefore);
 if(fetches!==slowBefore+1)throw Error('route change or group send restarted the same file download');
 if(await page.evaluate(()=>localStorage.getItem('qn.forward:account-a')))throw Error('concurrent group send created an intermediate draft');
 if(await page.getByRole('dialog').count())await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await card.getByRole('button',{name:'打开文件',exact:true}).click();await page.getByRole('dialog').getByText('外部文件真实字节',{exact:false}).first().waitFor();
 if(fetches!==slowBefore+1)throw Error('reopened preview refetched a completed file');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 const beforeRepeat=await page.evaluate(()=>window.groupMessages.length);
 await menu();await page.getByRole('button',{name:'发送到工作群'}).click();await page.getByRole('textbox',{name:'附言（可选）'}).fill('第二次转发');
 await page.evaluate(()=>{const m=window.items[0];window.items.splice(0,1,{...m,id:'second-forward-refreshed'});});
 await page.getByRole('dialog').getByRole('textbox',{name:'附言（可选）'}).waitFor();
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(before=>window.groupMessages.length===before+1,beforeRepeat);
 if(fetches!==slowBefore+1||await page.evaluate(()=>window.groupMessages.at(-1).body)!=='第二次转发')throw Error('explicit second send reused old message or downloaded again');
 // A server-accepted message with a lost response must keep its operation key.
 // Pressing Send again re-reads that receipt instead of publishing twice.
 await page.evaluate(()=>{window.failSendOnce=true;});
 const beforeUncertain=await page.evaluate(()=>window.groupMessages.length);
 await menu();await page.getByRole('button',{name:'发送到工作群'}).click();await page.getByRole('textbox',{name:'附言（可选）'}).fill('核对原发送');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('dialog').getByRole('alert').filter({hasText:'原回执暂不可读'}).waitFor();
 if(await page.evaluate(()=>window.groupMessages.length)!==beforeUncertain+1)throw Error('uncertain fixture did not accept the first group message');
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await menu();await page.getByRole('button',{name:'发送到工作群'}).click();
 if(await page.getByRole('textbox',{name:'附言（可选）'}).inputValue()!=='核对原发送')throw Error('uncertain group send lost its original note');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(before=>window.groupMessages.length===before+1,beforeUncertain);
 if(await page.evaluate(()=>Object.keys(window.groupByKey).length)!==beforeUncertain+1)throw Error('uncertain retry created a new group operation');
 // If the cloud bytes are complete but the V8 completion call fails, a reload
 // must retain the sheet and retry the same file without another byte upload.
 saved=false;complete=true;failComplete=true;
 await page.evaluate(()=>{window.items.splice(0,1,{id:'failed-save',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote-failed-save',name:'可恢复保存.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]});});
 const uploadsBeforeFailure=puts;
 await menu();await page.getByRole('button',{name:'保存到梦空间',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();
 await page.getByRole('dialog').getByRole('alert').waitFor();
 if(!await page.evaluate(()=>JSON.parse(localStorage.getItem('qn.cloud-pending:account-a')||'[]').some(item=>item.key.includes('remote-failed-save')&&item.state==='error')))throw Error('failed cloud intent was discarded');
 await page.reload();
 await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 await page.evaluate(()=>window.items.push({id:'failed-save',role:'assistant',phase:'final',text:'新产物',attachments:[{id:'remote-failed-save',name:'可恢复保存.txt',mime:'text/plain',kind:'file',url:'https://outside.test/file.txt'}]}));
 await page.getByRole('dialog').getByRole('alert').filter({hasText:'上次保存未完成'}).waitFor();
 if(puts!==uploadsBeforeFailure)throw Error('failed save retried byte upload during reload');
 failComplete=false;
 await page.getByRole('button',{name:'确认保存',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).waitFor();
 if(puts!==uploadsBeforeFailure)throw Error('failed save uploaded complete bytes a second time');
 await page.getByRole('button',{name:'完成',exact:true}).click();
 if(errors.length)throw Error(errors.join('\n'));
 console.log('PASS cloud transfer survives message-card replacement and restores completed state');
 console.log('PASS collaboration forward creates a real group message without a rename or intermediate draft');
 console.log('PASS published small group file fetches verified bytes once and reopens from local cache');
 console.log('PASS forwarded group file reopens from the verified cache in a fresh same-account page');
 console.log('PASS long filenames, 320/390/430px and 360px keyboard viewport: every file action reachable without overlap');
 console.log('PASS same-id digest revision invalidates old preview, reopens current content and reuses persistent cache');
 console.log('PASS optional save rename -> local download -> cached personal upload -> direct group send, original bytes/SHA, no duplicate fetch');
 console.log('PASS group-first send preserves the source name and does not create a composer draft');
 console.log('PASS hard reload resumes durable cloud intent and reconciles ready server file without duplicate byte upload');
 console.log('PASS preview acquisition survives card replacement; group send runs concurrently and reuses the same cached bytes');
 console.log('PASS explicit second send creates a new group message without refetching the file');
 console.log('PASS uncertain group reply retries the original operation key without duplicating the message');
 console.log('PASS failed cloud completion survives reload and resumes without a second byte upload');
}finally{await browser.close();}
