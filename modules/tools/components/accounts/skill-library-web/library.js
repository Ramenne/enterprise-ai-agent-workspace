const $=id=>document.getElementById(id);
const state={items:[],category:'',status:'active',query:'',editor:null,detail:null,busy:false,detailRequest:0,listRequest:0};
const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const size=value=>value<1024?value+' B':value<1024*1024?(value/1024).toFixed(1)+' KB':(value/1024/1024).toFixed(1)+' MB';
function element(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el}
async function api(path,body){const response=await fetch('/skills/api/'+path,{credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(response.status===401){location.assign('/login');throw Error('请重新登录')}const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');return data}
function action(text,fn,cls){const button=element('button',cls,text);button.type='button';button.onclick=fn;return button}
function downloadHref(id,version){return '/skills/api/download?'+new URLSearchParams({id,...(version?{version}: {})})}
function render(){
 const archived=item=>!!item.archivedAt,filteredStatus=state.items.filter(x=>archived(x)===(state.status==='archived'));
 const categories=[...new Set(state.items.map(x=>x.category))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 $('categories').replaceChildren();for(const category of ['',...categories]){
  const button=action(category||'全部 Skill',()=>{state.category=category;render()},state.category===category?'active':'');button.append(element('span','',String(filteredStatus.filter(x=>!category||x.category===category).length)));$('categories').append(button);
 }
 $('category-options').replaceChildren(...categories.map(x=>{const option=element('option');option.value=x;return option}));
 $('active-count').textContent=state.items.filter(x=>!archived(x)).length;$('archived-count').textContent=state.items.filter(archived).length;
 document.querySelectorAll('.status').forEach(x=>x.classList.toggle('active',x.dataset.status===state.status));
 const rows=filteredStatus.filter(x=>(!state.category||x.category===state.category)&&[x.title,x.name,x.description,x.category,x.tags,x.ownerName,x.note].join(' ').toLowerCase().includes(state.query.toLowerCase()));
 $('count').textContent=rows.length+' 个 Skill';$('items').replaceChildren();
 for(const item of rows){
  const row=element('article','item'),body=element('div','item-body'),heading=element('div','item-heading');
  heading.append(action(item.title,()=>showDetail(item),'item-title'),element('span','slug',item.name),element('span','version','v'+item.currentVersion));
  body.append(heading,element('p','description',item.description));
  const meta=element('div','meta');for(const text of [item.category,item.tags,item.ownerName+' 上传',date(item.updatedAt),size(item.size)])if(text)meta.append(element('span','',text));body.append(meta);
  const actions=element('div','actions');actions.append(action('查看',()=>showDetail(item)));
  const link=element('a','button','下载');link.href=downloadHref(item.id);actions.append(link);
  if(item.canEdit){actions.append(action('编辑',()=>openEditor('edit',item)));if(!item.archivedAt)actions.append(action('更新版本',()=>openEditor('version',item)));actions.append(action(item.archivedAt?'恢复':'归档',()=>changeStatus(item)))}
  row.append(body,actions);$('items').append(row);
 }
 if(!rows.length){const empty=element('div','empty');empty.append(element('h2','',state.query?'没有匹配的 Skill':state.status==='archived'?'还没有归档的 Skill':'还没有 Skill'),element('p','',state.query?'试试其他名称、说明或标签。':'导入一个 SKILL.md 或 ZIP，开始整理团队的实践。'));if(!state.query&&state.status==='active')empty.append(action('导入 Skill',()=>openEditor('import'),'primary'));$('items').append(empty)}
}
async function refresh(message){const request=++state.listRequest;$('refresh').disabled=true;try{const data=await api('items');if(request!==state.listRequest)return;state.items=data.items;if(state.category&&!state.items.some(x=>x.category===state.category))state.category='';render();$('feedback').textContent=message||'已更新 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false})}catch(error){$('feedback').textContent=error.message}finally{if(request===state.listRequest)$('refresh').disabled=false}}
function openEditor(mode,item=null){
 if(state.busy)return;state.editor={mode,item,package:null,request:0,autoTitle:null,autoVersion:null};$('edit-form').reset();$('editor-feedback').textContent='';$('package-preview').hidden=true;$('package-files').replaceChildren();$('save').disabled=mode!=='edit';
 $('editor-title').textContent=mode==='import'?'导入 Skill':mode==='version'?'更新版本 · '+item.title:'编辑 · '+item.title;
 for(const id of ['file-label','version-label'])$(id).hidden=mode==='edit';for(const id of ['title-label','metadata-fields','note-label'])$(id).hidden=mode==='version';
 $('package').required=mode!=='edit';$('title').value=item?.title||'';$('category').value=item?.category||'';$('tags').value=item?.tags||'';$('note').value=item?.note||'';$('editor').showModal();
}
async function base64(file){if(!file)throw Error('请选择 SKILL.md 或 ZIP');if(file.size>5*1024*1024)throw Error('上传文件最大 5 MB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary)}
$('package').onchange=async()=>{
 const editor=state.editor;if(!editor||editor.mode==='edit'||state.busy)return;const request=++editor.request;editor.package=null;$('save').disabled=true;$('package-preview').hidden=true;$('editor-feedback').textContent='正在检查文件…';
 try{
  const file=$('package').files[0],payload={filename:file?.name,packageBase64:await base64(file)},preview=await api('inspect',payload);
  if(state.editor!==editor||editor.request!==request)return;
  if(editor.mode==='version'&&preview.name!==editor.item.name)throw Error('新版本的 name 须与原 Skill 一致');
  editor.package=payload;$('package-name').textContent=preview.name;$('package-description').textContent=preview.description;$('package-stats').textContent=preview.files.length+' 个文件 · '+size(preview.size);$('package-files').replaceChildren(...preview.files.map(file=>element('li','',file.path+' · '+size(file.size))));$('package-preview').hidden=false;
  if(editor.mode==='import'&&(!$('title').value.trim()||$('title').value===editor.autoTitle)){$('title').value=preview.name;editor.autoTitle=preview.name}if(!$('version-note').value.trim()||$('version-note').value===editor.autoVersion){$('version-note').value=preview.versionLabel;editor.autoVersion=preview.versionLabel}
  $('editor-feedback').textContent='';$('save').disabled=false;
 }catch(error){if(state.editor===editor&&editor.request===request)$('editor-feedback').textContent=error.message}
};
$('edit-form').onsubmit=async event=>{
 event.preventDefault();if(state.busy)return;state.busy=true;$('save').disabled=true;$('editor-feedback').textContent='';
 try{
  const {mode,item}=state.editor,body={title:$('title').value,category:$('category').value,tags:$('tags').value,note:$('note').value,versionLabel:$('version-note').value};
  if(item)Object.assign(body,{id:item.id,revision:item.revision,action:mode});
  if(mode!=='edit'){if(!state.editor.package)throw Error('请先选择并检查 Skill 文件');Object.assign(body,state.editor.package)}
  await api(mode==='import'?'items':'update',body);$('editor').close();await refresh(mode==='import'?'Skill 已导入':mode==='version'?'新版本已保存，历史版本仍可下载':'修改已保存');
 }catch(error){$('editor-feedback').textContent=error.message}finally{state.busy=false;$('save').disabled=state.editor?.mode!=='edit'&&!state.editor?.package}
};
async function changeStatus(item){if(state.busy)return;state.busy=true;try{await api('update',{id:item.id,revision:item.revision,action:item.archivedAt?'restore':'archive'});await refresh(item.archivedAt?'Skill 已恢复':'Skill 已归档，可在已归档中恢复')}catch(error){$('feedback').textContent=error.message}finally{state.busy=false}}
async function showDetail(item){state.detail={id:item.id};$('detail-title').textContent=item.title;$('detail-subtitle').textContent=item.name;$('detail-description').textContent=item.description;$('detail-note').textContent=item.note;$('detail-note').hidden=!item.note;$('content').textContent='正在读取…';$('files').replaceChildren();$('versions').replaceChildren();$('download').removeAttribute('href');$('detail-feedback').textContent='';$('detail').showModal();await loadVersion()}
async function loadVersion(version){
 const request=++state.detailRequest,detail=state.detail;if(!detail)return;$('detail-feedback').textContent='';$('content').textContent='正在读取…';$('download').removeAttribute('href');$('files').replaceChildren();
 try{const data=await api('detail?'+new URLSearchParams({id:detail.id,...(version?{version}: {})}));if(request!==state.detailRequest)return;state.detail={id:detail.id,version:data.version.version};$('detail-title').textContent=data.item.title;$('detail-subtitle').textContent=data.item.name+' · '+data.item.category;
  $('versions').replaceChildren(...data.versions.map(v=>{const option=element('option','',`v${v.version}${v.versionLabel?' · '+v.versionLabel:''}`);option.value=v.version;return option}));$('versions').value=data.version.version;
  $('detail-description').textContent=data.item.description;$('detail-note').textContent=data.item.note;$('detail-note').hidden=!data.item.note;
  $('download').href=downloadHref(detail.id,data.version.version);$('version-info').textContent=data.version.filename+' · '+data.version.files.length+' 个文件 · '+data.version.actorName+' · '+date(data.version.at)+' · '+size(data.version.size);
  $('content').textContent=data.version.content;$('file-name').textContent='SKILL.md';
  for(const file of data.version.files.sort((a,b)=>(a.path==='SKILL.md'?-1:b.path==='SKILL.md'?1:a.path.localeCompare(b.path,'zh-CN',{numeric:true})))){const button=action(file.path,()=>showFile(file.path),file.path==='SKILL.md'?'active':'');button.title=size(file.size);button.dataset.path=file.path;$('files').append(button)}
 }catch(error){if(request===state.detailRequest){$('content').textContent='';$('detail-feedback').textContent=error.message}}
}
async function showFile(path){const request=++state.detailRequest,detail={...state.detail};$('content').textContent='正在读取…';$('file-name').textContent=path;$('detail-feedback').textContent='';document.querySelectorAll('#files button').forEach(x=>x.classList.toggle('active',x.dataset.path===path));try{const result=await api('file?'+new URLSearchParams({id:detail.id,version:detail.version,path}));if(request===state.detailRequest)$('content').textContent=result.content}catch(error){if(request===state.detailRequest){$('content').textContent='';$('detail-feedback').textContent=error.message}}}
$('versions').onchange=()=>loadVersion($('versions').value);$('refresh').onclick=()=>refresh();$('import').onclick=()=>openEditor('import');$('search').oninput=()=>{state.query=$('search').value;render()};document.querySelectorAll('.status').forEach(x=>x.onclick=()=>{state.status=x.dataset.status;render()});
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{if(button.dataset.close==='editor'&&state.busy)return;$(button.dataset.close).close()});
$('editor').addEventListener('cancel',event=>{if(state.busy)event.preventDefault()});$('detail').addEventListener('close',()=>{state.detailRequest++;state.detail=null;$('content').textContent='';$('files').replaceChildren()});
$('editor').addEventListener('close',()=>{if(state.editor)state.editor.request++;state.editor=null});
refresh().then(()=>{const id=new URLSearchParams(location.search).get('id');const item=state.items.find(x=>x.id===id);if(item)showDetail(item)});
