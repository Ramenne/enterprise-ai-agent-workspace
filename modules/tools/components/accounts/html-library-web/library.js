const $=id=>document.getElementById(id);
let items=[],project='',fileContent='',filename='',saving=false,generation=0,pollTimer=null,cloudJob=null,uploadId='',submitted='',uploadProjects=[],canManage=false;
const date=value=>!value?'日期未登记':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error)};
const node=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e};
const link=(text,href)=>{const a=node('a','button',text);a.href=href;a.target='_blank';a.rel='noopener';return a};
async function api(path,body){
 const r=await fetch('/html/api/'+path,{credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 if(r.status===401){items=[];render();$('preview').close();location.assign('/login');throw Error('登录已失效，请重新登录')}
 const data=await r.json().catch(()=>({error:'服务响应无效，请稍后重试'}));
 if(!r.ok)throw Object.assign(Error(data.error||'操作未完成，请稍后重试'),{status:r.status});return data;
}
function preview(row){
 $('preview-title').textContent=row.title;$('preview-meta').textContent=row.project+' · '+(row.versionLabel||'HTML 成果');$('preview-open').href=row.fileHref;$('frame').src=row.fileHref;$('frame').title=row.title+' · 预览';$('preview').showModal();
}
function render(){
 $('active-count').textContent=items.length;
 const groups=[...new Set(items.map(row=>row.project))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 $('projects').replaceChildren();for(const name of ['',...groups]){const btn=node('button');btn.type='button';btn.setAttribute('aria-current',project===name);btn.append(node('span','',name||'全部成果'),node('span','',items.filter(row=>!name||row.project===name).length));btn.onclick=()=>{project=name;render()};$('projects').append(btn)}
 const q=$('search').value.trim().toLocaleLowerCase();
 const shown=items.filter(row=>(!project||row.project===project)&&(!$('kind').value||row.kind===$('kind').value)&&(!q||[row.title,row.project,row.note,row.versionLabel,row.filename,row.source].join(' ').toLocaleLowerCase().includes(q)));
 shown.sort((a,b)=>$('sort').value==='title'?a.title.localeCompare(b.title,'zh-CN'):String(($('sort').value==='created'?b.createdAt:b.updatedAt)||'').localeCompare(($('sort').value==='created'?a.createdAt:a.updatedAt)||''));
 $('result-count').textContent=(project||'全部成果')+' · '+shown.length+' 项';$('items').replaceChildren();
 for(const row of shown){
  const card=node('article','item'),info=node('div','item-info'),h=node('h2','item-title'),title=node('button','title-button',row.title);title.onclick=()=>preview(row);h.append(title);
  const meta=node('div','item-meta');meta.append(node('span','tag'+(row.kind==='作品'?' work':''),row.kind),node('span','',row.project));if(row.versionLabel)meta.append(node('span','',row.versionLabel));meta.append(node('span','',size(row.size)),node('span','',row.updatedAt?date(row.updatedAt)+' 更新':'资料存储服务当前版本'));
  info.append(h,meta);if(row.note)info.append(node('p','item-note',row.note));info.append(node('p','item-source','资料存储服务 · '+(row.fileNo?row.fileNo+' · ':'')+row.source));
  const actions=node('div','item-actions'),view=node('button','preview-button','预览');view.onclick=()=>preview(row);actions.append(view,link('打开 ↗',row.fileHref),link('下载',row.fileHref+'?download=1'));
  card.append(node('div','file-icon','HTML'),info,actions);$('items').append(card);
 }
 $('empty').hidden=shown.length>0;$('empty-title').textContent=items.length?'没有匹配的成果':'当前未显示 HTML';$('empty-description').textContent=items.length?'试试其他关键词、项目或类型。':'请查看上方读取进度；也可以上传 HTML 到资料存储服务。';
}
async function openEditor(){
 fileContent='';filename='';uploadId=crypto.randomUUID();submitted='';$('form').reset();$('editor-error').textContent='';$('editor-title').textContent='上传到资料存储服务';$('save').textContent='保存到资料存储服务';$('file-note').textContent='选择可独立打开的 .html 或 .htm 文件';$('upload-project').replaceChildren(new Option('正在读取项目…',''));$('save').disabled=true;$('editor').showModal();
 try{const data=await api('cloud/projects');uploadProjects=data.items;$('upload-project').replaceChildren(new Option('请选择项目',''),...uploadProjects.map(p=>new Option(p.title,p.projectId)));const selected=uploadProjects.find(p=>p.title===project);if(selected)$('upload-project').value=selected.projectId;if(!uploadProjects.length)$('editor-error').textContent='当前没有可访问项目';}
 catch(e){$('editor-error').textContent=e.message}
 finally{$('save').disabled=false}
}
$('file').addEventListener('change',async()=>{
 fileContent='';filename='';const file=$('file').files[0];if(!file)return;$('editor-error').textContent='';$('save').disabled=true;
 try{if(file.size>2*1024*1024)throw Error('单个 HTML 文件最大 2 MB');if(!/\.html?$/i.test(file.name))throw Error('请选择 .html 或 .htm 文件');const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());if($('file').files[0]!==file)return;fileContent=content;filename=file.name;if(!$('form').elements.title.value)$('form').elements.title.value=file.name.replace(/\.html?$/i,'').slice(0,180);$('form').elements.path.value='HTML成果/'+file.name;$('file-note').textContent=file.name+' · '+size(file.size)}
 catch(e){$('editor-error').textContent=e instanceof TypeError?'文件须采用 UTF-8 编码，请转换后上传。':e.message}
 finally{$('save').disabled=false}
});
$('form').addEventListener('submit',async event=>{
 event.preventDefault();if(saving)return;if(!fileContent){$('editor-error').textContent='请选择有效的 HTML 文件';return}
 saving=true;$('save').disabled=true;$('editor-error').textContent='正在保存到资料存储服务…';
 const b={...Object.fromEntries(new FormData($('form'))),filename,content:fileContent,projectTitle:$('upload-project').selectedOptions[0]?.textContent||''};b.path=b.path.trim();
 const fingerprint=JSON.stringify(b);if(submitted&&submitted!==fingerprint)uploadId=crypto.randomUUID();submitted=fingerprint;
 try{const result=await api('cloud/upload',{...b,uploadId});if(result.state!=='published'){$('editor-error').textContent=result.message;$('save').textContent='再次核对保存结果';return}$('editor').close();await loadDirectory();status(result.reused?'资料存储服务已存在相同文件，已核验':'HTML 已保存到资料存储服务')}
 catch(e){$('editor-error').textContent=e.message+(e.status>=500||!e.status?'；请保留表单并再次核对保存结果。':'');$('save').textContent='再次保存／核对'}
 finally{saving=false;$('save').disabled=false}
});
document.querySelectorAll('[data-close]').forEach(btn=>btn.onclick=()=>{if(saving&&btn.dataset.close==='editor')return;$(btn.dataset.close).close()});
$('editor').addEventListener('cancel',event=>{if(saving)event.preventDefault()});
$('preview').addEventListener('close',()=>{$('frame').removeAttribute('src')});
$('search').oninput=render;$('kind').onchange=render;$('sort').onchange=render;$('refresh').onclick=loadDirectory;$('add').onclick=openEditor;
const syncTime=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
async function loadDirectory(){
 const requestGeneration=++generation;clearTimeout(pollTimer);$('cloud-error').hidden=true;
 try{
  const data=await api('cloud/index');if(requestGeneration!==generation)return;
  canManage=data.me?.isAdmin===true;$('add').hidden=!canManage;$('sync').hidden=!canManage;if(data.me?.name)$('member-name').textContent=data.me.name;
  if(data.state!=='ready'){status(data.message);$('cloud-progress').textContent=data.message;return}
  items=data.items||[];if(data.me?.name)$('member-name').textContent=data.me.name;render();
  $('cloud-progress').textContent='中枢统一目录 · '+items.length+' 个 HTML · 目录更新 '+syncTime(data.lastUpdatedAt||data.lastSyncedAt)+(data.pendingProjectCount?' · '+data.pendingProjectCount+' 个项目待后台核验':data.coverage?.complete===false?' · 后台继续核对其余项目':'')+(data.syncing?' · 正在后台更新':'');status('目录已就绪');
 }catch(error){if(requestGeneration!==generation)return;status(error.message,true);$('cloud-error').textContent=error.message;$('cloud-error').hidden=false}
}
async function syncDirectory(){
 const requestGeneration=++generation;clearTimeout(pollTimer);cloudJob=null;status('正在后台更新目录…');$('cloud-error').hidden=true;
 const show=async data=>{
  if(requestGeneration!==generation)return;cloudJob=data.jobId;
  // Keep the completed directory visible until the replacement is fully ready.
  if(data.state==='complete'){items=data.items||[];if(data.me?.name)$('member-name').textContent=data.me.name;render();$('cloud-progress').textContent='中枢统一目录 · '+items.length+' 个 HTML · 目录已更新';status('目录已更新');return}
  if(data.state!=='running'){await loadDirectory();status('已更新核验完成的项目；未完成项目保留原目录');return}
  $('cloud-progress').textContent='正在后台更新统一目录，已有成果可以继续查看。';status('后台更新中…');
  if(data.state==='running')pollTimer=setTimeout(poll,1500);
 };
 const poll=async()=>{try{await show(await api('cloud/status?job='+encodeURIComponent(cloudJob)))}catch(e){status(e.message,true)}};
 try{await show(await api('cloud/start',{force:true}))}catch(e){status(e.message,true);$('cloud-error').textContent=e.message;$('cloud-error').hidden=false}
}
$('sync').onclick=syncDirectory;
window.addEventListener('pagehide',()=>{generation++;clearTimeout(pollTimer)});
loadDirectory();
