import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAdmin} from './access-control.mjs';
const endpoint='https://hufu.example.invalid/mcp';
const fail=(status,message)=>Object.assign(Error(message),{status});
const parseResult=value=>{
 if(value?.error)throw Object.assign(fail(502,'中枢调用未完成'),{code:String(value.error.code||'rpc_error')});
 const result=value?.result;
 let data=result?.structuredContent;
 if(!data){try{data=JSON.parse(result?.content?.find(x=>x.type==='text')?.text||'{}')}catch{throw fail(502,'中枢响应格式无效')}}
 if(result?.isError||data?.state==='failed'||data?.error_code){
  const code=String(data?.error_code||'').toLowerCase();
  throw Object.assign(fail(/forbidden|permission|qualification|action_not_allowed/.test(code)?403:/unauthenticated|credential.*expired/.test(code)?401:502,/forbidden|permission|qualification|action_not_allowed/.test(code)?'中枢未允许当前成员访问这个范围':/unauthenticated|credential.*expired/.test(code)?'中枢登录已失效，请重新登录':code==='dependency_busy'?'资料存储服务目录服务暂时繁忙，后台将稍后重试':'中枢暂时无法读取这份资料'),{code,retryable:data?.retryable===true||code==='dependency_busy'});
 }
 return data;
};
async function cloudRpcOnce(member,name,args){
 if(!['v8.project.search','mem.enumerate','mem.enumerate.page','mem.material.head','mem.read_full','hub.material.shared','mem.write_text'].includes(name))throw fail(400,'操作无效');
 const r=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+member.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(120000),redirect:'error'});
 if(!r.ok)throw Object.assign(fail(r.status===401?401:r.status===403?403:502,r.status===403?'中枢未允许当前成员访问这个范围':r.status===401?'中枢登录已失效，请重新登录':'中枢连接暂时不可用'),{retryable:[502,503,504].includes(r.status)});
 const reader=r.body.getReader(),decoder=new TextDecoder();let raw='';
 try{
  while(true){
   const {value,done}=await reader.read();raw+=decoder.decode(value||new Uint8Array(),{stream:!done});
   // An MCP SSE response may keep its connection alive after delivering the result.
   // Consume the completed result event rather than waiting for the stream to close.
   try{const parsed=JSON.parse(raw);if(parsed.result||parsed.error)return parseResult(parsed)}catch(e){if(e.status)throw e}
   const events=raw.split(/\r?\n\r?\n/);
   if(events.length>1){raw=events.pop();for(const event of events){const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;let parsed;try{parsed=JSON.parse(data)}catch{continue}if(parsed.result||parsed.error)return parseResult(parsed)}}
   if(done)throw fail(502,'中枢响应格式无效');
  }
 }finally{await reader.cancel().catch(()=>{})}

}
export async function cloudRpc(member,name,args){
 try{return await cloudRpcOnce(member,name,args)}catch(error){
  const readOnly=name!=='mem.write_text';
  if(!readOnly||!(error.retryable||error.name==='TimeoutError'||error.name==='AbortError'||error instanceof TypeError))throw error;
  // One same-request retry for transient read transport failures. Never retry a write this way.
  return cloudRpcOnce(member,name,args);
 }
}
const isHtml=(path,props={})=>/\.html?$/i.test(path)||['html','htm','text/html'].includes(String(props.file_format||props.attributes?.file_format||props.content_type||'').toLowerCase());
const rowFrom=(project,row,path)=>({
 id:row.material_id,title:row.properties?.attributes?.title||path.split('/').pop()||row.title||row.material_id,filename:path.split('/').pop()||'document.html',
 project:project.title,projectId:project.project_id,kind:['资料','作品','其他'].includes(row.properties?.attributes?.html_kind)?row.properties.attributes.html_kind:'资料',note:row.properties?.attributes?.description||'',
 versionLabel:row.display_no||row.local_version_no||'',source:path,sourceType:'cloud',ownerName:'资料存储服务',
 size:row.size||0,sha256:row.sha256,versionId:row.version_id,canEdit:false,archivedAt:null,
 updatedAt:row.version_created_at||row.updated_at||null,createdAt:row.created_at||null,
 fileNo:row.file_display_no||row.file_no||'',fileHref:'/html/cloud/file/'+project.project_id+'/'+row.material_id
});

async function labelProjects(projects,member){
 let names={};try{names=Object.fromEntries(JSON.parse(await readFile(new URL('./members.json',import.meta.url),'utf8')).members.map(m=>[m.actor_id,m.display_name]))}catch{}
 const counts=new Map();for(const p of projects)counts.set(p.title,(counts.get(p.title)||0)+1);
 return projects.map(p=>({...p,title:counts.get(p.title)>1?p.title+' · '+(names[p.owner_id]||p.owner_id?.slice(0,8)||p.project_id.slice(0,8)):p.title}));
}

export function createCloudLibrary({rpc=cloudRpc,now=()=>Date.now(),cache}={}){
 const jobs=new Map(),current=new Map();
 const key=member=>createHash('sha256').update(member.owner+'\0'+member.token).digest('hex');
 function cleanup(){for(const [id,job] of jobs)if(now()-job.created>30*60000){job.cancelled=true;jobs.delete(id);if(current.get(job.key)===id)current.delete(job.key)}}
 const view=job=>({jobId:job.id,state:job.state,items:job.items,projectsTotal:job.total,projectsScanned:job.scanned,materialsScanned:job.materials,warnings:job.warnings,sharedScanned:job.sharedScanned,me:{name:job.name},coverage:{complete:job.state==='complete',source:'资料存储服务当前授权项目；含迁入的共享与个人资料，含定向共享，列出当前内容版本',snapshot:'逐项目快照，非全站原子快照'},startedAt:new Date(job.created).toISOString()});
 async function run(job,member){
  try{
   const projects=[];let cursor;const seen=new Set();
   do{const page=await rpc(member,'v8.project.search',{limit:100,...(cursor?{cursor}:{})});if(!Array.isArray(page.items))throw fail(502,'中枢项目列表无效');projects.push(...page.items);cursor=page.next_cursor;if(cursor){if(seen.has(cursor))throw fail(502,'项目分页未完成');seen.add(cursor)}}while(cursor&&!job.cancelled);
   projects.splice(0,projects.length,...await labelProjects(projects,member));
   job.total=projects.length;
   let index=0;const seenMaterials=new Set();
   const worker=async()=>{
    while(index<projects.length&&!job.cancelled){
     const project=projects[index++];
     try{
      const snap=await rpc(member,'mem.enumerate',{project_id:project.project_id});
      if(typeof snap.snapshot_id!=='string'||!Number.isSafeInteger(snap.total_count))throw fail(502,'资料快照响应无效');
      let cursor=snap.next_cursor??0;const cursors=new Set(),ids=new Set(),found=[];
      if(snap.total_count>0)do{
       if(cursors.has(cursor))throw fail(502,'资料分页未完成');cursors.add(cursor);
       const page=await rpc(member,'mem.enumerate.page',{project_id:project.project_id,snapshot_id:snap.snapshot_id,cursor,limit:100});
       if(!Array.isArray(page.items))throw fail(502,'资料列表响应无效');
       for(const row of page.items){if(ids.has(row.material_id))continue;ids.add(row.material_id);seenMaterials.add(project.project_id+'/'+row.material_id);job.materials++;
        const paths=(row.placements||[]).map(p=>p.logical_path).filter(x=>typeof x==='string');
        const path=paths.find(p=>isHtml(p,row.properties))||(isHtml(row.logical_path||row.title||'',row.properties)?row.logical_path||row.title:undefined);
        if(path)found.push(rowFrom(project,row,path));
       }
       if(page.next_cursor===null||page.next_cursor===undefined){if(page.coverage!=='complete'&&page.coverage?.complete!==true)throw fail(502,'资料枚举尚未完整');cursor=null}else cursor=page.next_cursor;
      }while(cursor!==null&&!job.cancelled);
      if(!job.cancelled){if(ids.size!==snap.total_count)throw fail(502,'此项目资料数量尚未核对完整');job.items.push(...found);job.completedProjectIds.push(project.project_id)}
     }catch(error){job.warnings.push({project:project.title,projectId:project.project_id,message:error.status?error.message:'此项目读取未完成',status:error.status||502,code:error.code||error.name});if(error.status===401){job.cancelled=true;job.state='failed'}}
     job.scanned++;
    }
   };
   await Promise.all(Array.from({length:Math.min(2,projects.length)},worker));
   if(!job.cancelled){
    try{const shares=await rpc(member,'hub.material.shared',{});if(!Array.isArray(shares.items))throw fail(502,'共享资料列表无效');
     for(const share of shares.items){if(seenMaterials.has(share.project_id+'/'+share.material_id))continue;
      try{const head=await rpc(member,'mem.material.head',{project_id:share.project_id,material_id:share.material_id});const ref=head.fixed_ref||head;
       job.sharedScanned++;job.materials++;const path=head.placements?.find(p=>isHtml(p.logical_path,head.properties))?.logical_path;
       if(path){const project=projects.find(p=>p.project_id===share.project_id)||{project_id:share.project_id,title:'共享给我的资料'};job.items.push(rowFrom(project,{...head,...ref},path))}
      }catch(error){job.warnings.push({project:'共享给我的资料',message:error.status?error.message:'此共享资料读取未完成',status:error.status||502})}
     }
    }catch(error){job.warnings.push({project:'共享给我的资料',message:error.status?error.message:'共享资料列表读取未完成',status:error.status||502})}
    job.state=job.warnings.length?'partial':'complete';
    if(!job.cancelled&&cache&&(job.completedProjectIds.length||job.items.length)){
     const previous=cache.loadShared(),stamp=new Date(now()).toISOString(),completed=new Set(job.completedProjectIds);
     const merged=new Map();
     // Replace only fully verified project snapshots. Failed scopes retain their previous directory.
     for(const row of previous?.items||[])if(!completed.has(row.projectId))merged.set(row.projectId+'/'+row.id,row);
     for(const row of job.items)merged.set(row.projectId+'/'+row.id,row);
     for(const row of previous?.items||[])if(row.indexedAt&&Date.parse(row.indexedAt)>job.created)merged.set(row.projectId+'/'+row.id,row);
     const full=job.state==='complete';
     cache.saveShared({schema:3,items:[...merged.values()],projectsTotal:job.total,materialsScanned:full?job.materials:previous?.materialsScanned||0,lastSyncedAt:full?stamp:previous?.lastSyncedAt||null,lastFullSyncedAt:full?stamp:previous?.lastFullSyncedAt||previous?.lastSyncedAt||null,lastUpdatedAt:stamp,complete:full,pendingScopes:job.warnings,synchronizedProjects:job.completedProjectIds.length});
    }
   }
  }catch(error){job.state='failed';job.error=error.status?error.message:'资料存储服务读取未完成';job.warnings.push({message:job.error,status:error.status||502})}
 }
 return {
  start(member,{force=false}={}){
   cleanup();const k=key(member),existing=jobs.get(current.get(k));if(existing?.state==='running'||(!force&&existing?.state==='complete'))return view(existing);
   if(existing)existing.cancelled=true;
   const job={id:randomUUID(),key:k,created:now(),name:member.name||'成员',sharedScanned:0,state:'running',items:[],total:0,scanned:0,materials:0,warnings:[],completedProjectIds:[],cancelled:false};
   jobs.set(job.id,job);current.set(k,job.id);void run(job,member);return view(job);
  },
  status(member,id){cleanup();const job=jobs.get(id);if(!job||job.key!==key(member))throw fail(404,'读取记录已失效，请重新刷新资料存储服务');return view(job)},
  async directory(member){
   const stored=cache?.loadShared();
   if(!stored)return {state:'preparing',items:[],lastSyncedAt:null,message:'统一目录正在后台准备，请稍后刷新。',me:{name:member.name,isAdmin:isAdmin(member.owner)}};
   return {state:'ready',items:stored.items,lastSyncedAt:stored.lastSyncedAt,lastUpdatedAt:stored.lastUpdatedAt||stored.lastSyncedAt,lastFullSyncedAt:stored.lastFullSyncedAt||stored.lastSyncedAt,pendingProjectCount:stored.pendingScopes?.length||0,projectsTotal:stored.projectsTotal,materialsScanned:stored.materialsScanned,me:{name:member.name,isAdmin:isAdmin(member.owner)},coverage:{complete:stored.complete!==false,snapshot:'中枢统一HTML目录，未完成同步的项目保留已有资料'}};
  },
  async projects(member){
   const items=[],seen=new Set();let cursor;
   do{const page=await rpc(member,'v8.project.search',{limit:100,...(cursor?{cursor}:{})});if(!Array.isArray(page.items))throw fail(502,'中枢项目列表无效');items.push(...page.items);cursor=page.next_cursor;if(cursor){if(seen.has(cursor))throw fail(502,'项目分页未完成');seen.add(cursor)}}while(cursor);
   return {items:(await labelProjects(items,member)).sort((a,b)=>Number(b.owner_id===member.owner)-Number(a.owner_id===member.owner)).map(p=>({projectId:p.project_id,title:p.title}))};
  },
  async upload(member,b){
   const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
   if(!b||!uuid.test(b.projectId||'')||!uuid.test(b.uploadId||''))throw fail(400,'请选择保存项目');
   const filename=b.filename,content=b.content,path=b.path;
   if(typeof filename!=='string'||filename.length>200||/[\\/\x00-\x1f]/.test(filename)||!/\.html?$/i.test(filename))throw fail(400,'请选择单个 HTML 或 HTM 文件');
   if(typeof content!=='string'||!content.trim()||content.includes('\0')||!/<(?:!doctype\s+html|html\b|head\b|body\b|svg\b|div\b|main\b|section\b|h[1-6]\b)/i.test(content))throw fail(400,'HTML 文件内容无效');
   if(Buffer.byteLength(content)>2*1024*1024)throw fail(413,'单个上传最大 2 MB');
   if(typeof path!=='string'||path.length>500||/[\\\x00-\x1f]/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..')||! /\.html?$/i.test(path))throw fail(400,'请填写有效的 HTML 保存路径');
   for(const [key,max] of [['title',180],['note',2000]])if(typeof b[key]!=='string'||b[key].length>max||/[\x00-\x1f]/.test(b[key].replace(/[\r\n\t]/g,'')))throw fail(400,'名称或备注格式无效');
   if(!b.title.trim()||!['资料','作品','其他'].includes(b.kind))throw fail(400,'请填写名称并选择类型');
   const sha=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content);
   // Enumerate the target first. An existing path is reused only for identical bytes.
   const snap=await rpc(member,'mem.enumerate',{project_id:b.projectId});let cursor=snap.next_cursor??0;const cursors=new Set();let same;
   if(!Number.isSafeInteger(snap.total_count)||!snap.snapshot_id)throw fail(502,'保存项目读取未完成');
   if(snap.total_count>0)do{
    if(cursors.has(cursor))throw fail(502,'保存项目分页未完成');cursors.add(cursor);
    const page=await rpc(member,'mem.enumerate.page',{project_id:b.projectId,snapshot_id:snap.snapshot_id,cursor,limit:100});
    if(!Array.isArray(page.items))throw fail(502,'保存项目读取未完成');
    for(const row of page.items)if(row.placements?.some(p=>p.logical_path===path)){if(row.sha256!==sha)throw fail(409,'该路径已有不同内容，请修改保存路径；现有文件不会被覆盖');same=row}
    cursor=page.next_cursor;
    if(cursor==null&&page.coverage!=='complete'&&page.coverage?.complete!==true)throw fail(502,'保存项目读取未完成');
   }while(cursor!=null);
   let ref=same,receipt;
   if(!same){
    receipt=await rpc(member,'mem.write_text',{project_id:b.projectId,logical_path:path,text:content,properties:{file_format:'html',attributes:{title:b.title.trim(),html_kind:b.kind,description:b.note}},source:{tool:'HTML管理库'},idempotency_key:'html-upload:'+member.owner+':'+b.uploadId});
    ref=receipt.fixed_refs?.[0]||receipt.fixed_ref;
    if(receipt.state!=='published'||!ref?.material_id)return {state:'pending',operationId:receipt.operation_id||receipt.resume_id||null,message:'资料存储服务尚未确认发布。请保留当前表单，点击再次核对；不会重复创建独立文件。'};
   }
   const head=await rpc(member,'mem.material.head',{project_id:b.projectId,material_id:ref.material_id});const fixed=head.fixed_ref||head;
   if(fixed.sha256!==sha||(fixed.size!==undefined&&fixed.size!==size))throw fail(502,'保存结果尚未核验通过，请保留表单再次核对');
   const stored=cache?.loadShared(),item=rowFrom({project_id:b.projectId,title:stored?.items.find(row=>row.projectId===b.projectId)?.project||String(b.projectTitle||'资料存储服务项目').slice(0,180)},{...head,...fixed},path);
   if(stored){item.indexedAt=new Date(now()).toISOString();cache.saveShared({...stored,items:[item,...stored.items.filter(row=>row.projectId!==item.projectId||row.id!==item.id)]})}
   return {state:'published',reused:!!same,operationId:receipt?.operation_id||null,item};
  },
  async file(member,projectId,id){
   // Never read from a shared local replica: every open checks current central rights.
   const head=await rpc(member,'mem.material.head',{project_id:projectId,material_id:id});
   const ref=head.fixed_ref||head.reference||head;
   if(!ref.version_id)throw fail(502,'尚未取得这份资料的当前版本');
   const read=await rpc(member,'mem.read_full',{project_id:projectId,material_id:id,version_id:ref.version_id,...(ref.sha256?{sha256:ref.sha256}:{}),encoding:'base64'});
   const encoded=read.bytes_base64||read.content_base64;
   const text=read.text??read.content_text;
   const bytes=typeof encoded==='string'?Buffer.from(encoded,'base64'):typeof text==='string'?Buffer.from(text):null;
   if(!bytes)throw fail(502,'原件暂未返回完整内容');
   const actual=createHash('sha256').update(bytes).digest('hex'),expected=ref.sha256||read.fixed_ref?.sha256||read.sha256;
   if(!expected||actual!==expected)throw fail(502,'文件内容核验未通过，请刷新后重试');
   const path=read.logical_path||read.path||head.placements?.[0]?.logical_path||'document.html';
   const decoded=bytes.subarray(0,8192).toString('utf8');
   if(!isHtml(path,head.properties)&&!/<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(decoded))throw fail(400,'该资料不是可预览的 HTML');
   return {bytes,filename:path.split('/').pop()||'document.html',sha256:actual};
  }
 };
}
