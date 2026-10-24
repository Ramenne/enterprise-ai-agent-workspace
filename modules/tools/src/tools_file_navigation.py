"""File actions use original current caller, exact authorized refs and native CAS.
Native history ordinals are resolved through the authorized UUID history page;
no native ordinal is forwarded as a legacy version or silently changed to head.
"""
import asyncio,json,urllib.request,urllib.error,urllib.parse,base64,io
from caller_context import CURRENT_CALLER

def native(system,path,body):
    c=CURRENT_CALLER.get()
    if not c:raise RuntimeError('current_caller_required')
    req=urllib.request.Request('https://hufu.example.invalid/hub2-preview/'+system+path,data=json.dumps(body).encode(),headers={'Authorization':c['token'],'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=90)as r:out=json.load(r)
    if out.get('state')=='failed' or out.get('error_code'):raise RuntimeError('current_native_file_operation_refused')
    return out

async def native_call(system,path,body):return await asyncio.to_thread(native,system,path,body)

def install():
    from tools_mcp_bridge import call,relative,view_file,metadata
    from web import mengspace
    from fastapi import HTTPException,Request
    from fastapi.routing import APIRoute
    old_api=mengspace._api
    async def reference(row,file_id):
        ref=next((r for r in (row.get('fixed_ref'),row.get('source_version'))if isinstance(r,dict)and all(isinstance(r.get(k),str)for k in ('project_id','material_id','version_id'))),None)
        if not isinstance(ref,dict)or not all(isinstance(ref.get(k),str)for k in ('project_id','material_id','version_id')):
            out=await asyncio.to_thread(call,'mengchu_get',{'file_id':file_id});ref=next((r for r in (out.get('fixed_ref'),out.get('source_version'))if isinstance(r,dict)and all(isinstance(r.get(k),str)for k in ('project_id','material_id','version_id'))),None)
        if not isinstance(ref,dict)or not all(isinstance(ref.get(k),str)for k in ('project_id','material_id','version_id')):raise HTTPException(409,'文件尚无可用的已登记固定版本')
        return ref
    async def history_rows(ref):
        rows=[];cursor=None
        while True:
            page=await native_call('mem','/v2/materials/history',{'project_id':ref['project_id'],'material_id':ref['material_id'],'limit':200,**({'cursor':cursor}if cursor else{})})
            rows.extend(page.get('items',[]));next_cursor=page.get('next_cursor')
            if not next_cursor:break
            if next_cursor==cursor:raise HTTPException(502,'历史分页未能推进')
            cursor=next_cursor
        return rows
    async def api(base,path,*,method='GET',token=None,params=None,body=None):
        if base==mengspace.MENG and path=='/api/admin/rename':
            file_id=body['file_id'];destination=relative(body['path'],'personal')
            out=await asyncio.to_thread(call,'mengchu_move',{'file_id':file_id,'space':'personal','path':destination})
            if out.get('file_id')!=file_id or out.get('state')!='updated':raise HTTPException(502,'改名效果未确认，请查询原文件编号')
            return {**out,'id':file_id,'path':body['path']}
        if base==mengspace.MENG and path in ('/api/files/trash','/api/admin/restore'):
            restoring=path.endswith('/restore');file_id=body['file_id'];out=await asyncio.to_thread(call,'mengchu_restore'if restoring else'mengchu_trash',{'file_id':file_id})
            if out.get('file_id')!=file_id or out.get('state')!=('active'if restoring else'trashed'):raise HTTPException(502,'文件状态未确认，请查询原文件编号')
            return {**out,**({'id':file_id}if restoring else{'trashed':file_id})}
        if base==mengspace.MENG and path=='/api/admin/trash-list':
            c=CURRENT_CALLER.get();actor=c['decision']['actor_id'];projects=[];cursor=None
            while True:
                page=await native_call('v8','/v2/projects/search',{'limit':100,**({'cursor':cursor}if cursor else{})})
                for p in page.get('items',[]):
                    if p.get('visibility')not in (None,'personal'):continue
                    if p.get('owner_id')is None or p.get('visibility')is None:
                        try:p=(await native_call('v8','/v2/projects/read',{'project_id':p.get('project_id',p.get('id'))}))['project']
                        except urllib.error.HTTPError as e:
                            if e.code==403:continue
                            raise
                    if p.get('visibility')=='personal'and p.get('owner_id')==actor:projects.append(p)
                cursor=page.get('next_cursor')
                if not cursor:break
            rows=[]
            for p in projects:
                pid=p.get('project_id',p.get('id'));cursor=None
                while True:
                    page=await native_call('mem','/v2/materials/trash-list',{'project_id':pid,'limit':200,**({'cursor':cursor}if cursor else{})})
                    for m in page.get('items',[]):
                        file_id='m2p_'+pid+'_'+m['material_id']
                        for placement in m.get('placements',[]):rows.append(view_file({'id':file_id,'file_id':file_id,'path':placement['logical_path'],'size':m['size'],'current_ver':None,'fixed_ref':{k:m[k]for k in ('project_id','material_id','version_id','sha256','size')}},'personal'))
                    cursor=page.get('next_cursor')
                    if not cursor:break
            return {'trashed':rows,'coverage':'current_authorized_owned_personal_trash;inactive_current_project_placements','physical_delete':False}
        out=await old_api(base,path,method=method,token=token,params=params,body=body)
        if base==mengspace.MENG and path=='/api/files':
            for row in out.get('files',[]):
                row['id']=row.get('id',row.get('file_id'))
                try:ref=await reference(row,row['id'])
                except HTTPException as e:
                    if e.status_code!=409:raise
                    row['history_coverage']='fixed_reference_not_registered';row.setdefault('current_ver',row.get('ver'));continue
                history=await history_rows(ref);current=next((x for x in history if x['version_id']==ref['version_id']),None);row['current_ver']=current['version_ordinal']if current else None
        return out
    async def current(s,file_id,space,path,version=None):
        if not mengspace._scope(space,path,s['username']):raise HTTPException(403,'不能访问当前空间以外的文件')
        row=await metadata(file_id,space,path);ref=await reference(row,file_id);history=await history_rows(ref);head=next((x for x in history if x['version_id']==ref['version_id']),None)
        current_ver=head['version_ordinal']if head else None
        if version is not None and current_ver!=version:raise HTTPException(409,'文件版本已变化，请刷新后重试')
        return {'file_id':file_id,'space':space,'path':path,'current_ver':current_ver,'fixed_ref':ref,'versions':[{**x,'ver':x['version_ordinal']}for x in history],'history_coverage':'all_current_authorized_native_history_pages;unregistered_legacy_versions_not_inferred','snapshot_complete':False}
    async def history_endpoint(request:Request,file_id:str,space:str,path:str):
        s=await mengspace._session(request);result=await current(s,file_id,space,path);return {k:result[k]for k in ('versions','current_ver','history_coverage','snapshot_complete')}
    old_download=next(r.endpoint for r in mengspace.router.routes if isinstance(r,APIRoute)and r.path=='/api/mengspace/download/{file_id}')
    async def download(request:Request,file_id:str,space:str,path:str,version:int|None=None,attachment:bool=False,preview:bool=False):
        if version is None:return await old_download(request,file_id,space,path,None,attachment,preview)
        s=await mengspace._session(request);result=await current(s,file_id,space,path);chosen=next((x for x in result['versions']if x['ver']==version),None)
        if not chosen:raise HTTPException(409,'所选历史版本未获准或尚未登记')
        located=await native_call('mem','/v2/materials/locate',{'material_id':result['fixed_ref']['material_id'],'version_id':chosen['version_id']});ref=located.get('fixed_ref');ref={**ref,'project_id':located.get('project_id',ref.get('project_id'))}if isinstance(ref,dict)else None
        if not ref or ref.get('project_id')!=result['fixed_ref']['project_id']or ref['version_id']!=chosen['version_id']or ref.get('sha256')!=chosen['sha256']:raise HTTPException(409,'历史固定版本已变化')
        from fastapi.responses import StreamingResponse
        c=CURRENT_CALLER.get();req=urllib.request.Request('https://hufu.example.invalid/hub2-preview/mem/v2/files/read',data=json.dumps({k:ref[k]for k in ('project_id','material_id','version_id')}).encode(),method='POST',headers={'Authorization':c['token'],'Content-Type':'application/json'});remote=await asyncio.to_thread(urllib.request.urlopen,req,timeout=90)
        async def stream():
            try:
                while True:
                    chunk=await asyncio.to_thread(remote.read,1024*1024)
                    if not chunk:break
                    yield chunk
            finally:remote.close()
        import mimetypes
        media=mimetypes.guess_type(path)[0]or'application/octet-stream'
        if media in ('text/html','image/svg+xml','application/javascript'):media='text/plain; charset=utf-8'
        return StreamingResponse(stream(),media_type=media,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':('attachment'if attachment else'inline')+"; filename*=UTF-8''"+urllib.parse.quote(path.rsplit('/',1)[-1])})
    mengspace._api=api;mengspace._current=current
    from web.server import app
    endpoints={'/api/mengspace/history/{file_id}':history_endpoint,'/api/mengspace/download/{file_id}':download}
    for router in (mengspace.router,app.router):
        for i,r in enumerate(router.routes):
            if isinstance(r,APIRoute)and r.path in endpoints:router.routes[i]=APIRoute(r.path,endpoints[r.path],methods=r.methods,name=r.name,response_model=r.response_model,response_class=r.response_class,status_code=r.status_code,dependencies=r.dependencies)
