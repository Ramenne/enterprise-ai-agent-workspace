import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc';
import {build} from 'esbuild';
import {designCss} from './designCss.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fixture=`import {reactive} from 'vue';
export const session=reactive({status:'online',displayName:'测试账号',user:{username:'account-a'}});
export const useSessionStore=()=>session;
export const useDataStore=()=>({account:'account-a',scopeRevision:1,tasks:[],notifications:[],personalProjects:[],companyIssues:[],unreadCount:0});
export const useUiStore=()=>({openOverlay(){}});
export const state=reactive({writes:[],offline:false,uncertain:false,purged:false,delay:0});
const commands=new Map();
let eventRevision=0,eventStamp='';const watches=new Map();
export const collaboration={
 watch:async(cid,id,provider,thread)=>{if(thread)watches.set(id,{cid,thread});else watches.delete(id);state.activeWatches=watches.size;return{revision:eventRevision};},
 events:async(_cid,_id,_after,signal)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,250);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});});state.observedRunning=!!state.nativeRunning;const stamp=JSON.stringify([state.changed,state.qoderRunning,state.nativeRunning,state.nativeQueue,state.sourceRev,state.queueSync,state.desktopQueue,state.pendingQuestion,state.questionAnswerReady,state.nativeHistoryMessage]);const changed=stamp!==eventStamp;if(changed){eventStamp=stamp;eventRevision++;}return{revision:eventRevision,changed,watch_active:true};},
 computers:async()=>{if(state.deviceFailure)throw Error('offline');if(state.deviceDelay)await new Promise(r=>setTimeout(r,state.deviceDelay));return({computers:session.user.username==='account-a'?[{id:'mac-a',name:'办公 Mac',online:!state.offline},{id:'mac-b',name:'另一台 Mac',online:true}]:[]});},
 pair:async()=>({id:'mac-a'}),revoke:async()=>{},
 submit:async(cid,id,request)=>{state.writes.push({cid,id,request});commands.set(id,{cid,request});return{}},
 command:async id=>{const c=commands.get(id);if(state.delay)await new Promise(r=>setTimeout(r,state.delay));const op=c.request.operation;
  if(op==='control'&&state.failControlOnce){state.failControlOnce=false;return{id,state:'done',result:{ok:false,error:'temporary control read failure'}};}
  if(op==='history'&&state.historyDelay)await new Promise(r=>setTimeout(r,state.historyDelay));
  if(op==='create'&&state.createDelay)await new Promise(r=>setTimeout(r,state.createDelay));
  if(op==='options')return{id,state:'done',result:{ok:true,models:[{id:'native-model',label:'当前可用模型',supported_efforts:['low','high'],default_effort:'low'},{id:'simple-model',label:'无思考档位模型'}],projects:[{id:'p1',name:'员工客户端项目'}],capabilities:{create:true,model_select:c.request.provider==='codex',effort_select:c.request.provider==='codex'}}};
  if(op==='create'&&state.createPartial)return{id,state:'done',result:{ok:false,uncertain:true,thread_id:'new-partial-thread',stage:'first_message_unconfirmed',error:'会话已创建，首条消息尚未确认'}};
  if(op==='create')return{id,state:'done',result:{ok:true,thread_id:'new-native-thread',title:c.request.message}};
  if(op==='control'&&c.request.provider==='qoder'&&state.pendingQuestion)return{id,state:'done',result:{ok:true,status:'needs_attention',turn_id:'turn-question',turns:[],requests:[{id:'question-call',turn_id:'turn-question',kind:'questions',title:'Qoder 正在等你回答',questions:[{id:'question-0',question:'测试时先做哪一步？',options:[{label:'检查界面',description:'核对选项显示。'},{label:'检查接口',description:'核对原任务状态。'}]}]}],capabilities:{send:true,queue_sync:true,native_queue:true,question_answer:!!state.questionAnswerReady}}};
  if(op==='respond'&&c.request.provider==='qoder'&&state.pendingQuestion){state.pendingQuestion=false;return{id,state:'done',result:{ok:true,state:c.request.decision==='skip'?'skipped':'answered'}};}
  if(c.request.provider==='qoder'&&state.lightControl&&['control','history'].includes(op)){
   const rev=String(state.sourceRev||0);
   if(op==='history'&&state.failHistory)return{id,state:'done',result:{ok:false,error:'history temporarily unavailable'}};
   const common={ok:true,status:'completed',source_revision:rev,turn_id:'turn-1',requests:[],capabilities:{send:true,stop_task:false,native_queue:true},presentation_version:2};
   return{id,state:'done',result:op==='control'?{...common,history_included:false}:{...common,turns:[{id:'turn-1',messages:[{id:'message-1',role:'assistant',phase:'final_answer',text:'缓存正文版本 '+rev}]}],cursor:null}};
  }
  if(op==='control'&&state.modelSettings&&!state.nativeRunning)return{id,state:'done',result:{ok:true,status:'completed',turn_id:'turn-1',turns:[],requests:[],capabilities:{send:true,model_select:true,effort_select:true}}};
  if(op.startsWith('queue_')){
   const rows=state.desktopQueue||[];let queued;
   if(op==='queue_add'){queued={id:'native-'+id,client_id:id,text:c.request.message,attachments:0,editable:true};state.desktopQueue=[...rows,queued];}
   if(op==='queue_update'){queued={...rows.find(r=>r.id===c.request.queue_id),text:c.request.message};state.desktopQueue=rows.map(r=>r.id===queued.id?queued:r);}
   if(op==='queue_steer'&&state.guideAsync){state.desktopQueue=rows.map(r=>r.id===c.request.queue_id?{...r,state:'guiding',editable:false,steerable:false,removable:false}:r);return{id,state:'done',result:{ok:true,state:'guide_pending'}};}
   if(['queue_delete','queue_steer'].includes(op))state.desktopQueue=rows.filter(r=>r.id!==c.request.queue_id);
   return{id,state:'done',result:{ok:true,queued,queue:state.desktopQueue||[]}};
  }
  if(op==='control'&&state.nativeRunning)return{id,state:'done',result:{ok:true,status:'inProgress',turn_id:'running-turn',turns:[],requests:[],queue:state.desktopQueue||[],capabilities:{send:true,queue_sync:!!state.queueSync,native_queue:!!state.nativeQueue,steer:!!state.nativeSteer,model_select:false}}};
  if(op==='stop_task'){state.qoderRunning=false;return{id,state:'done',result:{ok:true,state:'stopped'}};}
  if(op==='control'&&c.request.provider==='qoder'&&state.qoderRunning)return{id,state:'done',result:{ok:true,status:'inProgress',turn_id:'task-scope',turns:[],requests:[],capabilities:{send:false,interrupt:false,stop_task:true}}};
  if(op==='send'&&state.purged)return{id,state:'purged'};
  if(op==='send'&&state.uncertain)return{id,state:'unconfirmed'};
  if(['control','history'].includes(op)&&state.nativeHistoryMessage)return{id,state:'done',result:{ok:true,status:'completed',turn_id:'turn-native-receipt',turns:[{id:'turn-native-receipt',messages:[{id:'native-user-receipt',role:'user',text:state.nativeHistoryMessage.text,client_id:state.nativeHistoryMessage.client_id,phase:'',sequence:0}]}],requests:[],cursor:null}};
  if(op==='send'&&c.request.provider==='qoder'&&state.pendingQuestion)return{id,state:'done',result:{ok:true,state:'queued'}};
  if(state.changed&&['control','history'].includes(op)){
   const i=op==='control'?4:Number(c.request.cursor||4);
   const turn={id:'turn-'+i,started_at:i,messages:[{id:i===1?'message-1':'delta-'+i,role:'assistant',text:i===1?'**这是电脑原任务的回复，保留上下文。**':'新增第'+i+'轮',phase:'final_answer'}]};
   return{id,state:'done',result:{ok:true,status:'completed',turn_id:turn.id,turns:[turn],requests:[],cursor:op==='history'&&i>1?String(i-1):null}};
  }
  const result=op==='list'?{threads:Array.from({length:c.request.cursor?20:30},(_,i)=>({id:i===0&&!c.request.cursor?'thread-'+c.cid:'thread-'+(i+(c.request.cursor?30:0)),title:i===0&&!c.request.cursor?(c.request.archived?'已归档的测试任务':'完善协作连接'):'任务 '+(i+(c.request.cursor?30:0)),cwd:'/work/project',project_id:'p1',project_name:'员工客户端项目',actions:['pin','unpin']})),cursor:c.request.cursor?null:'next'}:op==='history'?{turns:[{id:'turn-1',messages:[{id:'message-1',role:'assistant',text:'**这是电脑原任务的回复，保留上下文。**',phase:'final_answer',sequence:0}]}],cursor:state.older?'older':null}:op==='control'?{status:'completed',turn_id:'turn-1',turns:[{id:'turn-1',messages:[{id:'progress',role:'assistant',phase:'commentary',sequence:1,text:'过程记录。'.repeat(180)},{id:'message-1',role:'assistant',phase:'final_answer',sequence:2,text:'**这是电脑原任务的回复，保留上下文。**'}]}],requests:[]}:{notice:'已提交原任务'};
  return{id,state:'done',result:{ok:true,...result}};
 }
};
window.fixture={session,state};`;
const styles=[];
const result=await build({stdin:{contents:`import {createApp} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import View from '@/ui/views/CollaborationView.vue';import Shell from '@/ui/layout/AppShell.vue';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/collaboration',name:'collaboration',component:View},{path:'/chat',name:'chat',component:{template:'<p>消息</p>'}}]});window.testRouter=router;router.push('/collaboration');router.isReady().then(()=>createApp(Shell).use(router).mount('#app'));`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>({path:resolve(dirname(a.importer),a.path)+(a.path.endsWith('.vue')?'':'.ts'),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onResolve({filter:/^(@\/session\/store|@\/collaboration\/api|@\/store\/data|@\/store\/ui)$/},()=>({path:'fixture',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,loader:'ts',resolveDir:process.cwd()}));
 b.onResolve({filter:/^@\//},a=>({path:resolve('src',a.path.slice(2)+(a.path.endsWith('.vue')?'':'.ts')),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onLoad({filter:/.*/,namespace:'sfc'},a=>{const{descriptor}=parse(readFileSync(a.path,'utf8'));const id='data-v-'+createHash('sha1').update(a.path).digest('hex').slice(0,8);styles.push(...descriptor.styles.map(s=>compileStyle({source:s.content,filename:a.path,id,scoped:s.scoped}).code));return{contents:compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const view =')+'\nview.__scopeId='+JSON.stringify(id)+';export default view;',loader:'ts',resolveDir:dirname(a.path)};});
 // Relative api import from real commands.ts must share the same fixture.
 b.onResolve({filter:/^\.\/api$/},a=>a.importer.endsWith('/collaboration/commands.ts')?{path:'fixture',namespace:'fixture'}:undefined);
}}]});
const browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://collab.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));await page.goto('https://collab.test/');
 await page.addStyleTag({content:designCss+'\n'+styles.join('\n')});await page.addScriptTag({content:result.outputFiles[0].text});
 await page.locator('.task-row').first().waitFor();
 if(await page.locator('.topbar,.bottom-nav,.collaboration-nav').count())throw Error('duplicate shell navigation');
 const sizes=await page.locator('.task-list').evaluate(e=>({height:e.clientHeight,total:e.scrollHeight}));
 if(sizes.total<=sizes.height || sizes.height>790)throw Error('task list not constrained to viewport');
 await page.locator('.task-list').evaluate(e=>e.scrollTop=e.scrollHeight);
 await page.waitForFunction(()=>document.querySelectorAll('.task-row').length===50);
 const before=await page.locator('.task-list').evaluate(e=>e.scrollTop);
 if(before<100)throw Error('task list cannot scroll');
 await page.screenshot({path:'artifacts/collaboration/local-reuse-list.png'});
 await page.getByRole('button',{name:'刷新任务',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.task-row').length===50);
 await page.locator('.task-list').evaluate(e=>e.scrollTop=0);
 await page.locator('.task-entry').first().dispatchEvent('contextmenu');
 await page.getByRole('button',{name:'置顶',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='pin'&&w.request.thread_id==='thread-mac-a'));
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'任务来源：Codex',exact:true}).click();await page.getByRole('option',{name:'Qoder CN',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.provider==='qoder'));
 await page.locator('.task-entry').first().dispatchEvent('contextmenu');
 if(await page.getByRole('button',{name:'删除会话',exact:true}).count())throw Error('Quest must not pretend archive is delete');
 await page.getByRole('button',{name:'置顶',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='pin'&&w.request.provider==='qoder'));
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.evaluate(()=>window.fixture.state.qoderRunning=true);
 await page.locator('.task-row').first().click();
 await page.getByRole('button',{name:'停止任务',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='stop_task'));
 const stop=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='stop_task'));
 if(stop.length!==1||stop[0].request.turn_id!==undefined||stop[0].request.provider!=='qoder')throw Error('Quest task stop used wrong contract');
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.getByRole('button',{name:'任务来源：Qoder CN',exact:true}).click();await page.getByRole('option',{name:'Codex',exact:true}).click();
 await page.locator('.task-entry').first().dispatchEvent('contextmenu');
 if(await page.getByRole('button',{name:'删除会话',exact:true}).count())throw Error('conversation deletion must not be offered');
 if(await page.getByRole('button',{name:'归档',exact:true}).count()||await page.getByRole('button',{name:'移出归档',exact:true}).count())throw Error('archive mutation is still offered on phone');
 await page.locator('.overlay').click({position:{x:2,y:2}});
 await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.locator('.overlay').click({position:{x:2,y:2}});if(await page.getByRole('dialog').count())throw Error('outside click failed');
 await page.locator('.task-list').evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:'artifacts/collaboration/local-reuse-list-top.png'});
 await page.locator('.task-list').evaluate(e=>e.scrollTop=200);await page.waitForTimeout(50);
 await page.locator('.task-row').filter({hasText:'任务 8'}).click();
 await page.locator('.conversation[data-execution-state=completed]').waitFor();
 await page.locator('.message-content strong').waitFor();
 if(!await page.locator('.progress .message-content').innerText())throw Error('work process must be fully visible by default');
 if(!await page.locator('.final-answer .message-content').innerText())throw Error('final answer was hidden with work process');
 if(await page.locator('.progress .message-content').evaluate(e=>e.clientHeight)<150)throw Error('work process is still truncated');
 if(await page.getByRole('button',{name:/展开工作过程|收起工作过程|展开执行过程|收起执行过程/}).count())throw Error('per-message process toggle remained');
 await page.getByRole('button',{name:'返回',exact:true}).click();
 if(await page.locator('.task-list').evaluate(e=>e.scrollTop)<100)throw Error('list position lost after back');
 await page.locator('.task-row').filter({hasText:'完善协作连接'}).click();
 await page.locator('.conversation[data-execution-state=completed]').waitFor();
 await page.locator('.message-content strong').waitFor();
 await page.locator('#agent-input').fill('继续完善，保留原任务设置');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='send'));
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length)!==1)throw Error('duplicate send');
 await page.waitForFunction(()=>document.querySelector('#agent-input').value==='');
 
 mkdirSync('artifacts/collaboration',{recursive:true});
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('overflow '+width);if(width===390||width===1440)await page.screenshot({path:'artifacts/collaboration/local-reuse-conversation-'+width+'.png'});}
 await page.setViewportSize({width:390,height:430});
 await page.locator('#agent-input').fill('手机长文本输入。'.repeat(100));await page.locator('#agent-input').focus();await page.waitForTimeout(150);
 const composer=await page.locator('.agent-composer').boundingBox();
 const content=await page.locator('.conversation-body').boundingBox();
 if(composer.y+composer.height>431 || content.height<70)throw Error('keyboard viewport hides writing area');
 await page.screenshot({path:'artifacts/collaboration/local-reuse-keyboard.png'});
 await page.waitForTimeout(250);
 const last=await page.locator('.collaboration-message').last().boundingBox();
 if(last.y+last.height>composer.y+2)throw Error('latest conclusion obscured by composer');
 const focus=await page.locator('#agent-input').evaluate(e=>({outline:getComputedStyle(e).outlineStyle,shadow:getComputedStyle(e).boxShadow}));
 if(focus.outline!=='none'||focus.shadow!=='none')throw Error('input focus ring returned '+JSON.stringify(focus));
 const typography=await page.evaluate(()=>({progress:parseFloat(getComputedStyle(document.querySelector('.progress')).fontSize),final:parseFloat(getComputedStyle(document.querySelector('.final-answer')).fontSize)}));
 if(typography.progress>=typography.final)throw Error('progress/final typography not distinct');
 const historyCount=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='history').length);
 await page.evaluate(()=>{const now=Date.now.bind(Date);Date.now=()=>now()+120000;}); // Age cache beyond the former 60-second reload.
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.locator('.task-row').filter({hasText:'完善协作连接'}).click();
 await page.waitForTimeout(250);
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='history').length)!==historyCount)throw Error('cached conversation fetched again');
 await page.evaluate(()=>window.fixture.state.changed=true);
 await page.getByText('新增第2轮',{exact:true}).waitFor({timeout:10000});
 if(!await page.getByText('新增第3轮',{exact:true}).count()||!await page.getByText('新增第4轮',{exact:true}).count())throw Error('background update skipped intervening turns');
 await page.evaluate(()=>window.fixture.state.changed=false);

 await page.evaluate(()=>window.testRouter.back());await page.waitForTimeout(100);
 if(await page.locator('#agent-input').count())throw Error('system back did not return to list');
 if(!await page.locator('.task-list').isVisible())throw Error('system back exited collaboration');
 await page.locator('.task-row').filter({hasText:'完善协作连接'}).click();
 await page.locator('.conversation[data-execution-state=completed]').waitFor();

 // Recover a failed final-state projection without requiring another source event.
 await page.evaluate(()=>{window.fixture.state.failControlOnce=true;window.fixture.state.sourceRev=1;});
 await page.locator('.response-activity.reconnecting').waitFor();
 await page.locator('.conversation[data-execution-state=completed]').waitFor({timeout:4000});
 // A source event received during failed device verification must be re-read on reconnect.
 await page.evaluate(()=>{window.fixture.state.deviceFailure=true;window.dispatchEvent(new Event('online'));});
 await page.getByRole('button',{name:'刷新设备',exact:true}).waitFor();
 const controlBeforeOffline=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='control').length);
 await page.evaluate(()=>window.fixture.state.sourceRev=2);await page.waitForTimeout(350);
 await page.evaluate(()=>{window.fixture.state.deviceFailure=false;window.dispatchEvent(new Event('online'));});
 await page.waitForFunction(n=>window.fixture.state.writes.filter(w=>w.request.operation==='control').length>n,controlBeforeOffline);
 await page.getByRole('button',{name:'刷新设备',exact:true}).waitFor({state:'hidden'});
 // Running fallback queues remain editable; native queue dispatches without waiting for completion.
 await page.evaluate(()=>{window.fixture.state.nativeRunning=true;window.fixture.state.nativeQueue=false;});
 await page.locator('.response-activity.working').waitFor();
 const queuedBefore=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length);
 await page.locator('#agent-input').fill('运行中补充，先在队列');await page.getByRole('button',{name:'加入队列',exact:true}).click();
 await page.waitForTimeout(100);
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length)!==queuedBefore)throw Error('fallback queue dispatched without native capability');
 await page.locator('.queued-followup').filter({hasText:'运行中补充，先在队列'}).getByRole('button',{name:'编辑待发消息'}).click();
 if(await page.locator('#agent-input').inputValue()!=='运行中补充，先在队列')throw Error('queue editing lost text');
 await page.getByRole('button',{name:'加入队列',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.nativeRunning=false);
 await page.waitForFunction(n=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length===n+1,queuedBefore);
 if(await page.getByRole('button',{name:'核对原操作',exact:true}).count())throw Error('normal sending showed uncertain banner');
 await page.evaluate(()=>{window.fixture.state.nativeRunning=false;window.fixture.state.delay=180;});
 await page.locator('.conversation[data-execution-state=completed]').waitFor();
 await page.locator('#agent-input').fill('即时显示发送气泡');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.locator('.outgoing-message').filter({hasText:'即时显示发送气泡'}).waitFor();
 if(await page.locator('#agent-input').inputValue())throw Error('composer not cleared immediately');
 if(await page.getByRole('button',{name:'核对原操作',exact:true}).count())throw Error('receipt waiting marked as uncertain');
 await page.waitForTimeout(500);await page.evaluate(()=>window.fixture.state.delay=0);
 // Explicit secondary history entry owns a full row and cannot touch its first message.
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.evaluate(()=>window.fixture.state.older=true);
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();await page.locator('.history-more').waitFor();
 const historyRect=await page.locator('.history-more').boundingBox(),firstRect=await page.locator('.collaboration-message').first().boundingBox();
 if(firstRect.y-historyRect.y-historyRect.height<20)throw Error('history entry touches first message');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/collaboration/local-candidate-history.png'});
 await page.getByRole('button',{name:'返回',exact:true}).click();
 // Lightweight status does not clear/read unchanged history; a changed native
 // revision refreshes text while history errors do not disable the composer.
 await page.getByRole('button',{name:'任务来源：Codex',exact:true}).click();await page.getByRole('option',{name:'Qoder CN',exact:true}).click();
 await page.evaluate(()=>{window.fixture.state.changed=false;window.fixture.state.older=false;});
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();await page.getByText('这是电脑原任务的回复，保留上下文。',{exact:true}).waitFor();
 await page.waitForTimeout(500);await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.lightControl=true);
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();
 await page.getByText(/缓存正文版本/).waitFor();await page.waitForTimeout(400);
 const qHistory=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='history').length);
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.locator('.task-row').filter({hasText:'任务 12'}).click();await page.waitForTimeout(700);
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='history').length)!==qHistory)throw Error('unchanged lightweight status reloaded history');
 await page.evaluate(()=>{window.fixture.state.sourceRev=123;window.fixture.state.failHistory=true;});await page.waitForTimeout(650);
 await page.locator('#agent-input').fill('历史失败仍可发送');
 if(!await page.getByRole('button',{name:'发送',exact:true}).isEnabled())throw Error('history failure disabled native send');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='send'&&w.request.provider==='qoder'&&w.request.thread_id==='thread-12'&&w.request.message==='历史失败仍可发送'));
 await page.evaluate(()=>{window.fixture.state.failHistory=false;window.fixture.state.sourceRev=124;});
 await page.getByText('缓存正文版本 124',{exact:true}).waitFor();
 await page.locator('#agent-input').fill('');await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.lightControl=false);
 // A missing native helper keeps the question readable without fake actions.
 await page.evaluate(()=>window.fixture.state.pendingQuestion=true);
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();
 await page.getByText('测试时先做哪一步？',{exact:true}).waitFor();
 if(await page.locator('.approval-question').getByRole('button',{name:/提交回答|跳过/}).count())throw Error('read-only Qoder question exposed a fake action');
 if(await page.locator('.response-activity').count())throw Error('duplicate approval status above question');
 await page.locator('#agent-input').fill('这条只是补充消息');
 await page.getByRole('button',{name:'加入队列',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='send'&&w.request.provider==='qoder'&&w.request.message==='这条只是补充消息'));
 await page.getByLabel('电脑已接收，等待处理').waitFor();
 if(!await page.getByText('测试时先做哪一步？',{exact:true}).count())throw Error('queued Qoder message falsely answered the native question');
 const questionGap=await page.locator('.approval-question').evaluate(e=>{const title=e.querySelector('h3').getBoundingClientRect(),option=e.querySelector('.question-options').getBoundingClientRect(),hint=e.querySelector('.question-source-note').getBoundingClientRect();return{afterTitle:option.top-title.bottom,afterOptions:hint.top-option.bottom,padding:option.left-e.getBoundingClientRect().left}});
 if(questionGap.afterTitle<12||questionGap.afterOptions<12||questionGap.padding<12)throw Error('Qoder question card has zero spacing '+JSON.stringify(questionGap));
 for(const width of [320,390]){await page.setViewportSize({width,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Qoder question overflow '+width);}
 await page.screenshot({path:'artifacts/collaboration/local-qoder-question.png'});
 // Once the connector advertises the native capability, actions use the
 // original question request instead of an ordinary queued message.
 await page.evaluate(()=>window.fixture.state.questionAnswerReady=true);
 await page.getByRole('button',{name:'提交回答',exact:true}).waitFor();
 await page.getByRole('button',{name:'检查界面',exact:false}).click();
 await page.getByRole('button',{name:'提交回答',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='respond'&&w.request.decision==='answer'));
 const answer=await page.evaluate(()=>window.fixture.state.writes.find(w=>w.request.operation==='respond'&&w.request.decision==='answer').request);
 if(answer.provider!=='qoder'||answer.thread_id!=='thread-12'||answer.turn_id!=='turn-question'||answer.request_id!=='question-call'||answer.answers?.['question-0']!=='检查界面')throw Error('Qoder answer did not address native pending question');
 await page.locator('.approval-question').waitFor({state:'detached'});
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.pendingQuestion=true);
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();
 await page.getByRole('button',{name:'跳过',exact:true}).waitFor();
 for(const width of [320,390]){await page.setViewportSize({width,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Qoder action overflow '+width);}
 await page.screenshot({path:'artifacts/collaboration/local-qoder-question-actions.png'});
 await page.getByRole('button',{name:'跳过',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='respond'&&w.request.decision==='skip'));
 const skipped=await page.evaluate(()=>window.fixture.state.writes.find(w=>w.request.operation==='respond'&&w.request.decision==='skip').request);
 if(skipped.thread_id!=='thread-12'||skipped.turn_id!=='turn-question'||skipped.request_id!=='question-call')throw Error('Qoder skip did not address native pending question');
 await page.locator('.approval-question').waitFor({state:'detached'});
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.pendingQuestion=true);
 await page.locator('.task-row').filter({hasText:'任务 12'}).click();
 await page.getByRole('button',{name:'自定义回答',exact:true}).click();
 await page.setViewportSize({width:320,height:430});
 await page.getByRole('textbox',{name:'测试时先做哪一步？：自定义回答'}).fill('先核对原任务的真实状态');
 await page.getByRole('button',{name:'提交回答',exact:true}).scrollIntoViewIfNeeded();
 const customButton=await page.getByRole('button',{name:'提交回答',exact:true}).boundingBox();
 const customComposer=await page.locator('.agent-composer').boundingBox();
 if(customButton.y+customButton.height>customComposer.y||await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Qoder custom answer obscured in short viewport');
 await page.getByRole('button',{name:'提交回答',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='respond'&&w.request.answers?.['question-0']==='先核对原任务的真实状态'));
 await page.locator('.approval-question').waitFor({state:'detached'});
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'任务来源：Qoder CN',exact:true}).click();await page.getByRole('option',{name:'Codex',exact:true}).click();
 // Native model + effort survive editing/running and reach the actual command body.
 await page.evaluate(()=>{window.fixture.state.modelSettings=true;window.fixture.state.nativeRunning=true;});
 await page.locator('.task-row').filter({hasText:'任务 14'}).click();
 await page.getByRole('button',{name:'模型 · 沿用电脑设置',exact:true}).click();
 await page.getByRole('button',{name:'模型：沿用电脑设置',exact:true}).click();await page.getByRole('option',{name:'当前可用模型',exact:true}).click();
 await page.getByRole('button',{name:'思考强度：模型默认',exact:true}).click();
 const effortBox=await page.getByRole('listbox',{name:'思考强度',exact:true}).boundingBox();
 if(effortBox.y<0||effortBox.y+effortBox.height>844)throw Error('effort menu outside viewport');
 await page.getByRole('option',{name:'高',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.observedRunning===true);await page.evaluate(()=>window.fixture.state.nativeRunning=false);await page.locator('.conversation[data-execution-state=completed]').waitFor();
 await page.locator('#agent-input').fill('使用所选模型与高思考');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.message==='使用所选模型与高思考'));
 const withEffort=await page.evaluate(()=>window.fixture.state.writes.find(w=>w.request.message==='使用所选模型与高思考').request);
 if(withEffort.model!=='native-model'||withEffort.effort!=='high')throw Error('selected model effort dropped');
 await page.getByRole('button',{name:'模型：沿用电脑设置',exact:true}).click();await page.getByRole('option',{name:'无思考档位模型',exact:true}).click();
 if(await page.getByRole('button',{name:/思考强度：/}).count())throw Error('unsupported thinking choices displayed');
 await page.locator('#agent-input').fill('模型不带思考参数');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.message==='模型不带思考参数'));
 if(await page.evaluate(()=>window.fixture.state.writes.find(w=>w.request.message==='模型不带思考参数').request.effort!==undefined))throw Error('stale effort leaked to another model');
 await page.evaluate(()=>{window.fixture.state.nativeRunning=true;window.fixture.state.nativeSteer=true;});await page.waitForTimeout(600);
 await page.getByRole('button',{name:'模型：沿用电脑设置',exact:true}).click();await page.getByRole('option',{name:'当前可用模型',exact:true}).click();
 await page.getByRole('button',{name:'思考强度：模型默认',exact:true}).click();await page.getByRole('option',{name:'高',exact:true}).click();
 await page.locator('#agent-input').fill('运行中补充要求');await page.getByRole('button',{name:'加入队列',exact:true}).click();
 await page.waitForTimeout(350);
 if(await page.evaluate(()=>window.fixture.state.writes.some(w=>w.request.message==='运行中补充要求')))throw Error('default queued message was steered without user action');
 await page.locator('.queued-followup').filter({hasText:'运行中补充要求'}).getByRole('button',{name:'调整方向',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.message==='运行中补充要求'));
 const supplement=await page.evaluate(()=>window.fixture.state.writes.find(w=>w.request.message==='运行中补充要求').request);
 if(supplement.model||supplement.effort)throw Error('supplement attempted to change active execution settings');
 if(!await page.evaluate(()=>window.fixture.state.nativeRunning))throw Error('supplement waited for turn completion');
 if((await page.locator('.collab-head').innerText()).match(/发送中|已完成|已停止|正在处理/))throw Error('execution status leaked into navigation');
 await page.locator('.response-activity.working').waitFor();
 await page.emulateMedia({reducedMotion:'reduce'});
 if(await page.locator('.activity-orbit i').first().evaluate(e=>getComputedStyle(e).animationName)!=='none')throw Error('reduced motion ignored');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.screenshot({path:'artifacts/collaboration/response-activity-0498.png',animations:'disabled'});
 // The native per-item queue is shared with Desktop; default enqueue never steers.
 await page.evaluate(()=>{window.fixture.state.queueSync=true;window.fixture.state.desktopQueue=[{id:'desktop-external',client_id:'desktop-client',text:'电脑端加入的待发消息',editable:true,attachments:0}];});
 await page.locator('.queued-followup').filter({hasText:'电脑端加入的待发消息'}).waitFor();
 await page.locator('#agent-input').fill('手机进入原生队列');await page.getByRole('button',{name:'加入队列',exact:true}).click();
 await page.locator('.queued-followup').filter({hasText:'手机进入原生队列'}).getByRole('button',{name:'编辑待发消息'}).waitFor();
 if(await page.evaluate(()=>window.fixture.state.writes.some(w=>w.request.operation==='send'&&w.request.message==='手机进入原生队列')))throw Error('queue add became direct send');
 await page.locator('.queued-followup').filter({hasText:'手机进入原生队列'}).getByRole('button',{name:'编辑待发消息'}).click();
 await page.getByRole('textbox',{name:'待发消息内容'}).fill('修改原生待发');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('.queued-followup').filter({hasText:'修改原生待发'}).waitFor();
 await page.locator('.queued-followup').filter({hasText:'修改原生待发'}).getByRole('button',{name:'调整方向',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='queue_steer'));
 await page.locator('.queued-followup').filter({hasText:'修改原生待发'}).waitFor({state:'detached'});
 if(await page.evaluate(()=>window.fixture.state.desktopQueue.length)!==1)throw Error('steer replaced unrelated Desktop queue');
 await page.locator('.queued-followup').filter({hasText:'电脑端加入的待发消息'}).getByRole('button',{name:'取消待发消息'}).click();
 await page.locator('.queued-followup').filter({hasText:'电脑端加入的待发消息'}).waitFor({state:'detached'});
 await page.evaluate(()=>{window.fixture.state.queueSync=false;window.fixture.state.desktopQueue=[];});
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.evaluate(()=>{window.fixture.state.modelSettings=false;window.fixture.state.nativeRunning=false;window.fixture.state.nativeSteer=false;});
 // Qoder pending item stays visible after asynchronous native submission.
 await page.getByRole('button',{name:'任务来源：Codex',exact:true}).click();await page.getByRole('option',{name:'Qoder CN',exact:true}).click();
 await page.evaluate(()=>{Object.assign(window.fixture.state,{nativeRunning:true,nativeQueue:true,nativeSteer:true,queueSync:true,guideAsync:true,desktopQueue:[]});});
 await page.getByText('完善协作连接',{exact:true}).click();
 await page.locator('#agent-input').fill('Qoder 引导只发一次');await page.getByRole('button',{name:'加入队列',exact:true}).click();
 const qGuide=page.locator('.native-queued').filter({hasText:'Qoder 引导只发一次'});
 await qGuide.getByRole('button',{name:'调整方向',exact:true}).click();
 await qGuide.getByText('等待接收',{exact:true}).waitFor();
 if(await qGuide.getByRole('button',{name:'调整方向',exact:true}).count())throw Error('pending guide can be sent twice');
 await page.waitForTimeout(600);
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='queue_steer'&&w.request.provider==='qoder').length)!==1)throw Error('guide replayed');
 await page.evaluate(()=>{window.fixture.state.desktopQueue=[];});await qGuide.waitFor({state:'detached'});
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>{Object.assign(window.fixture.state,{nativeRunning:false,nativeSteer:false,queueSync:false,guideAsync:false});});
 await page.getByRole('button',{name:'任务来源：Qoder CN',exact:true}).click();await page.getByRole('option',{name:'Codex',exact:true}).click();
 // New task uses actual returned model/project identifiers, with one mutation.
 await page.getByRole('button',{name:'任务来源：Codex',exact:true}).click();await page.getByRole('option',{name:'Qoder CN',exact:true}).click();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('button',{name:'模型：沿用电脑设置',exact:true}).click();await page.getByRole('option',{name:'当前可用模型',exact:true}).click();
 await page.getByRole('button',{name:'项目：独立任务',exact:true}).click();await page.getByRole('option',{name:'员工客户端项目',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.historyDelay=2500);
 await page.getByRole('textbox',{name:'新会话消息'}).fill('新建协作任务');await page.getByRole('button',{name:'开始',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='create'));
 const created=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='create'));
 if(created.length!==1||created[0].request.model!=='native-model'||created[0].request.project_id!=='p1')throw Error('new task contract mismatch');
 await page.locator('.active-task-title strong').filter({hasText:'新建协作任务'}).waitFor();
 await page.locator('.outgoing-message').filter({hasText:'新建协作任务'}).waitFor({timeout:700});
 if(await page.locator('.conversation-skeleton').count())throw Error('accepted first prompt hidden by blocking history loader');
 await page.evaluate(()=>window.fixture.state.historyDelay=0);
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.getByRole('button',{name:'任务来源：Qoder CN',exact:true}).click();await page.getByRole('option',{name:'Codex',exact:true}).click();
 // Codex creation carries explicit thinking; partial creation stays locatable and never repeats.
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('button',{name:'模型：沿用电脑设置',exact:true}).click();await page.getByRole('option',{name:'当前可用模型',exact:true}).click();
 await page.getByRole('button',{name:'思考强度：模型默认',exact:true}).click();await page.getByRole('option',{name:'高',exact:true}).click();
 await page.getByRole('textbox',{name:'新会话消息'}).fill('Codex新建采用高档位');await page.getByRole('button',{name:'开始',exact:true}).click();
 await page.locator('.active-task-title strong').filter({hasText:'Codex新建采用高档位'}).waitFor();
 const createEffort=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='create'&&w.request.message==='Codex新建采用高档位'));
 if(createEffort.length!==1||createEffort[0].request.effort!=='high'||createEffort[0].request.model!=='native-model')throw Error('create effort contract lost');
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('textbox',{name:'新会话消息'}).fill('结果待确认的新建任务');
 await page.evaluate(()=>window.fixture.state.createPartial=true);await page.getByRole('button',{name:'开始',exact:true}).click();
 await page.getByRole('button',{name:'查看已建会话',exact:true}).click();
 await page.getByRole('button',{name:'核对原操作',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'会话已创建，首条消息尚未确认'}).waitFor();
 if(await page.evaluate(()=>JSON.parse(localStorage.getItem('employeeclient:collaboration:pending:account-a')).thread)!=='new-partial-thread')throw Error('created task id not retained');
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='create'&&w.request.message==='结果待确认的新建任务').length)!==1)throw Error('uncertain create was repeated');
 await page.getByText('在 Mac 核对后恢复',{exact:true}).click();
 await page.getByRole('checkbox',{name:'我已在 Mac 核对原任务，确认可以继续'}).check();
 await page.getByRole('button',{name:'解除限制，不重发',exact:true}).click();
 await page.evaluate(()=>window.fixture.state.createPartial=false);
 await page.getByRole('button',{name:'返回',exact:true}).click();
 const listBeforeRestore=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='list').length);
 await page.evaluate(()=>{window.fixture.state.deviceDelay=800;const now=Date.now.bind(Date);Date.now=()=>now()+120000;});await page.evaluate(()=>window.testRouter.push('/chat'));await page.waitForTimeout(30);await page.evaluate(()=>window.testRouter.push('/collaboration'));
 await page.locator('.computer-choice').waitFor({timeout:500});
 if(await page.getByText('暂无已连接的电脑').count())throw Error('false empty computer flash');
 await page.waitForTimeout(900);await page.evaluate(()=>{window.fixture.state.deviceDelay=0;window.fixture.state.older=false;});
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='list').length)<=listBeforeRestore)throw Error('stale cached list never refreshed');
 await page.evaluate(()=>window.fixture.state.delay=150);await page.getByRole('button',{name:'刷新任务',exact:true}).click();await page.getByRole('checkbox',{name:'已归档',exact:true}).check();
 await page.locator('.task-row').filter({hasText:'已归档的测试任务'}).waitFor();
 await page.getByRole('checkbox',{name:'已归档',exact:true}).uncheck();await page.evaluate(()=>window.fixture.state.delay=0);
 await page.locator('.task-row').filter({hasText:'完善协作连接'}).click();await page.locator('.conversation[data-execution-state=completed]').waitFor();
 if(await page.evaluate(()=>window.fixture.state.activeWatches)>1)throw Error('retired native subscriptions leaked');

 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>window.fixture.state.uncertain=true);await page.locator('#agent-input').fill('只执行一次');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'核对原操作'}).waitFor();
 await page.waitForTimeout(150);if(await page.getByRole('button',{name:'加入队列',exact:true}).isEnabled())throw Error('uncertain send enabled');
 if(!await page.evaluate(()=>localStorage.getItem('employeeclient:collaboration:pending:account-a')))throw Error('pending missing');
 await page.evaluate(()=>window.fixture.state.purged=true);
 await page.getByRole('button',{name:'核对原操作',exact:true}).click();
 await page.waitForTimeout(100);
 if(await page.getByRole('button',{name:'加入队列',exact:true}).isEnabled())throw Error('purged receipt unlocked sending');
 await page.getByText('在 Mac 核对后恢复',{exact:true}).click();
 if(await page.getByRole('button',{name:'解除限制，不重发'}).isEnabled())throw Error('manual confirmation missing');
 const sendsBefore=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length);
 await page.getByRole('checkbox',{name:'我已在 Mac 核对原任务，确认可以继续'}).check();await page.getByRole('button',{name:'解除限制，不重发'}).click();
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length)!==sendsBefore)throw Error('manual recovery resent command');
 if(await page.evaluate(()=>localStorage.getItem('employeeclient:collaboration:pending:account-a')))throw Error('manual recovery not persisted');
 // A timed-out gateway reply is resolved by the exact desktop message ID,
 // without replaying a send or requiring the user to acknowledge an unknown.
 await page.evaluate(()=>window.fixture.state.uncertain=true);
 await page.locator('#agent-input').fill('电脑已收到但回执超时');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'核对原操作'}).waitFor();
 const exactReceipt=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send'&&w.request.message==='电脑已收到但回执超时').at(-1));
 await page.evaluate(id=>{window.fixture.state.uncertain=false;window.fixture.state.nativeHistoryMessage={client_id:id,text:'电脑已收到但回执超时'};},exactReceipt.id);
 await page.waitForFunction(()=>!document.body.innerText.includes('核对原操作'),undefined,{timeout:6000});
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.id===window.fixture.state.nativeHistoryMessage.client_id).length)!==1)throw Error('exact native receipt replayed command');
 await page.evaluate(()=>window.fixture.state.nativeHistoryMessage=null);
 await page.evaluate(()=>{window.fixture.state.purged=false;window.fixture.state.uncertain=true;});
 await page.locator('#agent-input').fill('第二次核验');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'核对原操作'}).waitFor();
 await page.evaluate(()=>window.testRouter.push('/chat'));
 await page.waitForTimeout(50);await page.evaluate(()=>window.testRouter.push('/collaboration'));
 await page.locator('.task-row').first().waitFor();
 if(await page.locator('.computer-choice').innerText()!=='办公 Mac ⌄')throw Error('device selection lost');
 await page.getByRole('button',{name:'核对原操作'}).waitFor();
 await page.evaluate(()=>window.fixture.session.user={username:'account-b'});await page.waitForTimeout(100);
 if(await page.getByText('这是电脑原任务的回复，保留上下文。').count())throw Error('cross-account history');
 if(await page.getByRole('button',{name:'核对原操作'}).count())throw Error('cross-account receipt');
 // Changing account while native creation is in flight preserves the original receipt.
 await page.evaluate(()=>{localStorage.removeItem('employeeclient:collaboration:pending:account-a');window.fixture.state.uncertain=false;window.fixture.session.user={username:'account-a'};});
 await page.locator('.task-row').first().waitFor();await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('textbox',{name:'新会话消息'}).fill('切换账号期间的新建任务');
 await page.evaluate(()=>window.fixture.state.createDelay=500);await page.getByRole('button',{name:'开始',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='create'&&w.request.message==='切换账号期间的新建任务'));
 await page.evaluate(()=>window.fixture.session.user={username:'account-b'});await page.waitForTimeout(650);
 if(!await page.evaluate(()=>localStorage.getItem('employeeclient:collaboration:pending:account-a')))throw Error('account switch discarded unconfirmed create');
 if(await page.getByRole('button',{name:'核对原操作'}).count())throw Error('old create receipt leaked into new account');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('PASS: full shell scroll/pagination/provider routing and real Vue + command runner; send once, exact native message ID settles an uncertain send without replay, unresolved writes remain blocked, account isolation, popup dismissal, four widths. Fixture only.');
}finally{await browser.close();}
