import assert from 'node:assert/strict';

// Runs against the real router, views, overlays, stores and persisted intents.
// Only the transport/platform edges are isolated in uiAudit.fixture.ts.
export async function auditInteractions(page, report, geometry) {
 const mark = name => report.interactions.push({name,passed:true});
 const go = async (path,state='normal',role='member') => {await page.evaluate(([p,s,r])=>window.audit.go(p,s,r),[path,state,role]);await page.waitForTimeout(60)};
 const open = async (kind,props={}) => {await page.evaluate(([k,p])=>window.audit.open(k,p),[kind,props]);await page.getByRole('dialog').last().waitFor()};
 const close = async () => {await page.evaluate(()=>window.audit.ui.closeOverlay());await page.waitForTimeout(10)};
 const online = () => page.evaluate(()=>{window.audit.scenario.name='normal';window.audit.session.status='online'});
 const clean = () => page.evaluate(()=>localStorage.clear());
 await page.setViewportSize({width:390,height:844});await clean();
 await go('/projects');await page.getByRole('button',{name:/员工客户端体验改进/}).click();
 await page.waitForURL('**/#/project/p-personal');
 await page.getByRole('button',{name:'问题与想法',exact:true}).click();
 await page.getByRole('button',{name:'策划想法',exact:true}).click();
 assert.ok(await page.getByText('项目资料按工作阶段整理',{exact:true}).isVisible());
 await page.getByRole('button',{name:'已结束',exact:true}).click();
 assert.ok(await page.getByText('还没有已结束的记录',{exact:true}).isVisible());
 await page.getByRole('button',{name:'个人项目',exact:true}).click();
 await page.waitForURL('**/#/projects');mark('project list → detail → filters/history → back');

 await go('/task/t-company');
 for(const tab of ['策划','代码 / 结论','完整过程','概览']) {await page.locator('.detail-tabs button').filter({hasText:tab}).click();await geometry('task-tab-'+tab)}
 assert.equal(await page.getByRole('button',{name:'审核',exact:true}).count(),0);
 await go('/reviews');assert.ok(await page.getByText('此处仅对主控账号开放').isVisible());
 await go('/task/t-company','normal','control');assert.ok(await page.getByRole('button',{name:'审核',exact:true}).isVisible());mark('task tabs and main-control review gate');

 for(const path of ['/task/t-company','/issue/i-company','/company']) {
  await go(path,'error');assert.ok(await page.getByRole('button',{name:/重试/}).count()>0);
  await online();await page.getByRole('button',{name:'重试读取',exact:true}).first().click();await page.waitForTimeout(60);
  assert.ok((await page.locator('main').innerText()).includes(path.includes('task')?'完善语音':'语音上传'),path+' should recover after retry');
 }
 await go('/work','error','control');await open('review',{taskId:'t-company'});
 assert.ok(await page.getByText('暂时无法读取待审对象').isVisible());
 assert.equal(await page.getByText('正在读取待审对象').count(),0);
 await online();await page.getByRole('button',{name:'重试读取',exact:true}).click();await page.locator('#qn-rev-reason').waitFor();await close();mark('initial read failure is visible; route and review retry recover');

 await go('/work');await open('create',{scope:'personal',project:'p-personal'});
 await page.locator('#qn-issue-title').fill('从新建项目返回后必须保留的记录');
 await page.locator('#qn-issue-detail').fill('附带说明也要保留');
 await page.getByRole('button',{name:'先建一个项目'}).click();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await page.locator('#qn-issue-title').inputValue(),'从新建项目返回后必须保留的记录');
 assert.equal(await page.locator('#qn-issue-detail').inputValue(),'附带说明也要保留');
 await page.getByRole('button',{name:'先建一个项目'}).click();
 await page.locator('#qn-proj-name').fill('临时验收项目');
 await page.getByRole('button',{name:'创建项目',exact:true}).click();
 assert.equal(await page.locator('#qn-issue-title').inputValue(),'从新建项目返回后必须保留的记录');mark('create project cancel and success return to intact issue draft');

 await page.locator('#qn-issue-sev').click();assert.equal(await page.getByRole('listbox').count(),1);
 await page.getByRole('option',{name:'严重',exact:true}).focus();await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('listbox').count(),0);assert.equal(await page.getByRole('dialog').count(),1);
 await page.locator('.choice').filter({hasText:'公司'}).click();
 assert.equal(await page.getByRole('dialog').count(),2);
 await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.querySelector('#confirm-layer')?.contains(document.activeElement)),true);
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'');mark('nested confirmation focus, dropdown Escape and scroll-lock restoration');

 await clean();await go('/company');await open('create',{scope:'company'});
 await page.locator('#qn-issue-title').fill('隔离测试：提交前需公开确认');
 await page.getByRole('button',{name:'提交记录',exact:true}).click();
 assert.equal((await page.evaluate(()=>window.audit.scenario.writes)).length,0);
 await page.keyboard.press('Escape');assert.equal((await page.evaluate(()=>window.audit.scenario.writes)).length,0);
 await page.getByRole('button',{name:'提交记录',exact:true}).click();
 await page.getByRole('button',{name:'确认公司范围并提交',exact:true}).click();
 await page.waitForTimeout(40);assert.equal((await page.evaluate(()=>window.audit.scenario.writes)).length,1);mark('company visibility confirmation precedes the one write');

 await clean();await go('/work','normal','control');await open('review',{taskId:'t-company'});
 await page.locator('#qn-rev-reason').fill('已核对语音与更新协议');
 await page.evaluate(()=>window.audit.scenario.name='stale');
 await page.getByRole('button',{name:'确认审核',exact:true}).click();
 await page.getByText('模拟连接失败',{exact:true}).waitFor();
 const first=(await page.evaluate(()=>window.audit.scenario.writes))[0];
 assert.equal(await page.locator('#qn-rev-reason').isDisabled(),true);
 await close();await online();await open('review',{taskId:'t-company'});
 assert.equal(await page.locator('#qn-rev-reason').inputValue(),'已核对语音与更新协议');
 await page.getByRole('button',{name:'重试确认审核',exact:true}).click();await page.waitForTimeout(40);
 const last=(await page.evaluate(()=>window.audit.scenario.writes)).at(-1);
 assert.deepEqual(last,first);mark('ambiguous review closes/reopens and retries the same immutable body and key');

 const recoveries=[
  ['projectForm',{},'#qn-proj-name','恢复项目','创建项目'],
  ['claim',{issueId:'i-company'},'#qn-claim-note','恢复处理声明','告知开始处理'],
  ['supplement',{issueId:'i-company',scope:'company',expectedVersion:1},'#qn-sup','恢复补充说明','提交补充'],
  ['urge',{taskId:'t-company'},'#qn-urge-msg','恢复催促说明','设为优先并通知'],
 ];
 for(const [kind,props,input,text,button] of recoveries){
  await clean();await go('/work');await open(kind,props);await page.locator(input).fill(text);
  await page.evaluate(()=>window.audit.scenario.name='stale');await page.getByRole('button',{name:button,exact:true}).click();await page.getByText('模拟连接失败',{exact:true}).waitFor();
  const sent=(await page.evaluate(()=>window.audit.scenario.writes))[0];await close();await online();await open(kind,props);
  assert.equal(await page.locator(input).inputValue(),text);await page.getByRole('button',{name:button,exact:true}).click();await page.waitForTimeout(40);
  assert.deepEqual((await page.evaluate(()=>window.audit.scenario.writes)).at(-1),sent);mark(kind+' lost response recovery keeps original intent');
 }
 await clean();await go('/personal','offline');await open('create',{scope:'personal',project:'p-personal'});
 await page.locator('#qn-issue-title').fill('离线草稿内容');await page.getByRole('button',{name:'提交记录',exact:true}).click();
 assert.equal((await page.evaluate(()=>window.audit.scenario.writes)).length,0);await close();await go('/drafts');
 assert.ok(await page.getByText('离线草稿内容',{exact:true}).isVisible());mark('offline create saves a local draft, never sends a network write');

 await go('/work');await page.getByRole('button',{name:'搜索我的工作',exact:true}).click();
 await page.locator('#global-search').fill('完善语音');await page.locator('.search-result').first().click();
 await page.waitForURL('**/#/task/t-company');assert.equal(await page.getByRole('dialog').count(),0);mark('global search opens actual task context');
 await page.emulateMedia({reducedMotion:'no-preference'});await open('projectForm');await page.waitForTimeout(250);await geometry('settled-standard-motion-modal');await close();await page.emulateMedia({reducedMotion:'reduce'});
 await page.setViewportSize({width:320,height:380});await open('create',{scope:'personal',project:'p-personal'});await page.waitForTimeout(30);await geometry('keyboard-height-form');
 const footer=await page.locator('.modal-footer').boundingBox();assert.ok(footer&&footer.y+footer.height<=381);await close();mark('normal animation settles and short keyboard viewport preserves form footer');
 await page.setViewportSize({width:390,height:844});
 await open('create',{scope:'personal',project:'p-personal'});
 await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>360});Object.defineProperty(window.visualViewport,'offsetTop',{configurable:true,get:()=>80});window.visualViewport.dispatchEvent(new Event('resize'))});await page.waitForTimeout(30);
 const visualFooter=await page.locator('.modal-footer').boundingBox();assert.ok(visualFooter&&visualFooter.y>=80&&visualFooter.y+visualFooter.height<=441);
 await page.evaluate(()=>{delete window.visualViewport.height;delete window.visualViewport.offsetTop;window.visualViewport.dispatchEvent(new Event('resize'))});await close();mark('visualViewport keyboard resize works even when layout viewport remains tall');
 for(const path of ['/task/t-company','/issue/i-company']){
  await go(path);const title=await page.locator('.detail-title h2').innerText();
  await page.evaluate(()=>{window.audit.scenario.name='stale';window.audit.data.lastSyncedAt++});await page.waitForTimeout(60);
  assert.equal(await page.locator('.detail-title h2').innerText(),title);assert.ok(await page.locator('main').getByRole('alert').isVisible());
  await page.evaluate(()=>{window.audit.scenario.name='restricted';window.audit.data.lastSyncedAt++});await page.waitForTimeout(60);
  assert.equal(await page.locator('.detail-title').count(),0);
 }
 mark('refresh network error preserves detail; permission denial clears it');
 await go('/profile');await page.evaluate(()=>{window.auditNative=true});await open('about');
 assert.ok((await page.getByRole('dialog').innerText()).includes('1.38-test（39）'));
 await page.getByRole('button',{name:'检查更新',exact:true}).click();
 assert.ok((await page.getByRole('dialog').innerText()).includes('1.39-test（40）'));
 await page.evaluate(()=>{window.auditUpdateFault='update_hash_mismatch'});await page.getByRole('button',{name:'下载并安装',exact:true}).click();
 assert.ok(await page.getByText('安装包校验失败，已丢弃损坏文件，请重试。',{exact:true}).isVisible());
 await page.evaluate(()=>{window.auditUpdateFault=''});await page.getByRole('button',{name:'下载并安装',exact:true}).click();
 assert.ok(await page.getByRole('button',{name:'继续安装',exact:true}).isVisible());await close();
 await page.evaluate(()=>{window.auditNative=false});mark('Android update UI consumes real-version contract and handles hash failure/install permission (simulated bridge)');
}
