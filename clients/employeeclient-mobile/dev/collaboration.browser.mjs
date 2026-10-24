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
export const state=reactive({writes:[],offline:false,uncertain:false,purged:false,delay:0});
const commands=new Map();
export const collaboration={
 computers:async()=>({computers:session.user.username==='account-a'?[{id:'mac-a',name:'办公 Mac',online:!state.offline},{id:'mac-b',name:'另一台 Mac',online:true}]:[]}),
 pair:async()=>({id:'mac-a'}),revoke:async()=>{},
 submit:async(cid,id,request)=>{state.writes.push({cid,id,request});commands.set(id,{cid,request});return{}},
 command:async id=>{const c=commands.get(id);if(state.delay)await new Promise(r=>setTimeout(r,state.delay));const op=c.request.operation;
  if(op==='send'&&state.purged)return{id,state:'purged'};
  if(op==='send'&&state.uncertain)return{id,state:'unconfirmed'};
  const result=op==='list'?{threads:[{id:'thread-'+c.cid,title:c.cid==='mac-a'?'完善协作连接':'另一台电脑的任务',cwd:'/work/project'}],cursor:null}:op==='history'?{turns:[{id:'turn-1',messages:[{id:'message-1',role:'assistant',text:'这是电脑原任务的回复，保留上下文。'}]}],cursor:null}:op==='control'?{status:'completed',turn_id:'turn-1',turns:[],requests:[]}:{notice:'已提交原任务'};
  return{id,state:'done',result:{ok:true,...result}};
 }
};
window.fixture={session,state};`;
const styles=[];
const result=await build({stdin:{contents:`import {createApp} from 'vue';import View from '@/ui/views/CollaborationView.vue';createApp(View).mount('#app');`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\./,namespace:'sfc'},a=>({path:resolve(dirname(a.importer),a.path)+(a.path.endsWith('.vue')?'':'.ts'),namespace:a.path.endsWith('.vue')?'sfc':'file'}));
 b.onResolve({filter:/^(@\/session\/store|@\/collaboration\/api)$/},()=>({path:'fixture',namespace:'fixture'}));
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
 await page.getByRole('button',{name:/办公 Mac.*在线/}).click();await page.locator('.task-row').filter({hasText:'完善协作连接'}).click();
 await page.getByText('本轮执行结束',{exact:false}).waitFor();
 await page.locator('#agent-input').fill('继续完善，保留原任务设置');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.writes.some(w=>w.request.operation==='send'));
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length)!==1)throw Error('duplicate send');
 await page.waitForFunction(()=>document.querySelector('#agent-input').value==='');
 await page.getByRole('button',{name:'连接电脑',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.locator('.overlay').click({position:{x:2,y:2}});if(await page.getByRole('dialog').count())throw Error('outside click failed');
 mkdirSync('artifacts/collaboration',{recursive:true});
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('overflow '+width);if(width===390||width===1440)await page.screenshot({path:'artifacts/collaboration/phone-'+width+'.png',fullPage:true});}
 await page.evaluate(()=>window.fixture.state.uncertain=true);await page.locator('#agent-input').fill('只执行一次');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'核对原操作'}).waitFor();
 await page.waitForTimeout(150);if(await page.getByRole('button',{name:'发送',exact:true}).isEnabled())throw Error('uncertain send enabled');
 if(!await page.evaluate(()=>localStorage.getItem('employeeclient:collaboration:pending:account-a')))throw Error('pending missing');
 await page.evaluate(()=>window.fixture.state.purged=true);
 await page.getByRole('button',{name:'核对原操作',exact:true}).click();
 await page.waitForTimeout(100);
 if(await page.getByRole('button',{name:'发送',exact:true}).isEnabled())throw Error('purged receipt unlocked sending');
 await page.getByText('在 Mac 核对后恢复',{exact:true}).click();
 if(await page.getByRole('button',{name:'解除限制，不重发'}).isEnabled())throw Error('manual confirmation missing');
 const sendsBefore=await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length);
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'解除限制，不重发'}).click();
 if(await page.evaluate(()=>window.fixture.state.writes.filter(w=>w.request.operation==='send').length)!==sendsBefore)throw Error('manual recovery resent command');
 if(await page.evaluate(()=>localStorage.getItem('employeeclient:collaboration:pending:account-a')))throw Error('manual recovery not persisted');
 await page.evaluate(()=>{window.fixture.state.purged=false;window.fixture.state.uncertain=true;});
 await page.locator('#agent-input').fill('第二次核验');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'核对原操作'}).waitFor();
 await page.evaluate(()=>window.fixture.session.user={username:'account-b'});await page.waitForTimeout(100);
 if(await page.getByText('这是电脑原任务的回复，保留上下文。').count())throw Error('cross-account history');
 if(await page.getByRole('button',{name:'核对原操作'}).count())throw Error('cross-account receipt');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('PASS: real Vue + command runner; send once, uncertainty retained, account isolation, popup dismissal, four widths. Fixture only.');
}finally{await browser.close();}
