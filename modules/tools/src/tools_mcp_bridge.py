"""Original thin bridge over CURRENT caller-authorized public MCP contracts.
No guessed UUID/path mapping; search/get/upload/trash/restore resolve in gateway.
"""
import asyncio,base64,json,urllib.request,urllib.error,urllib.parse,uuid,io
from caller_context import CURRENT_CALLER

def call(tool,args):
    c=CURRENT_CALLER.get()
    if not c:raise RuntimeError('current_caller_required')
    body={'jsonrpc':'2.0','id':str(uuid.uuid4()),'method':'tools/call','params':{'name':'hub.invoke','arguments':{'tool':tool,'arguments':args}}}
    req=urllib.request.Request('https://hufu.example.invalid/mcp',data=json.dumps(body).encode(),headers={'Authorization':c['token'],'Content-Type':'application/json','Accept':'application/json, text/event-stream'},method='POST')
    with urllib.request.urlopen(req,timeout=90) as response:packet=json.load(response)
    if 'error' in packet:raise RuntimeError('current_mcp_call_failed')
    result=packet.get('result',{});value=result.get('structuredContent')
    if value is None:
        for block in result.get('content',[]):
            if block.get('type')=='text':
                try:value=json.loads(block['text'])
                except ValueError:pass
    if result.get('isError') or not isinstance(value,dict) or value.get('error_code'):raise RuntimeError('current_mcp_effect_not_confirmed')
    return value

def upload_stream(args,content,size):
    c=CURRENT_CALLER.get()
    if not c:raise RuntimeError('current_caller_required')
    marker='stream_'+uuid.uuid4().hex
    body={'jsonrpc':'2.0','id':str(uuid.uuid4()),'method':'tools/call','params':{'name':'hub.invoke','arguments':{'tool':'mengchu_upload','arguments':{**args,'content_base64':marker}}}}
    encoded=json.dumps(body).encode();needle=json.dumps(marker).encode()
    if encoded.count(needle)!=1:raise RuntimeError('upload_envelope_conflict')
    before,after=encoded.split(needle);prefix=before+b'"';suffix=b'"'+after
    source=io.BytesIO(content) if isinstance(content,bytes) else content
    def chunks():
        yield prefix
        total=0
        while True:
            data=source.read(49152)
            if not data:break
            total+=len(data);yield base64.b64encode(data)
        if total!=size:raise RuntimeError('upload_source_length_changed')
        yield suffix
    length=len(prefix)+4*((size+2)//3)+len(suffix)
    req=urllib.request.Request('https://hufu.example.invalid/mcp',data=chunks(),headers={'Authorization':c['token'],'Content-Type':'application/json','Accept':'application/json, text/event-stream','Content-Length':str(length)},method='POST')
    with urllib.request.urlopen(req,timeout=900) as response:packet=json.load(response)
    result=packet.get('result',{});value=result.get('structuredContent')
    if value is None:
        for block in result.get('content',[]):
            if block.get('type')=='text':
                try:value=json.loads(block['text'])
                except ValueError:pass
    if 'error' in packet or result.get('isError') or not isinstance(value,dict) or value.get('error_code'):raise RuntimeError('current_upload_effect_not_confirmed')
    return value

def view_file(item,space):
    c=CURRENT_CALLER.get();result=dict(item)
    if space=='personal' and not result.get('path','').startswith(c['legacy_subject']+'/'):
        result['path']=c['legacy_subject']+'/'+result.get('path','')
    result['space']=space
    return result

def relative(path,space):
    c=CURRENT_CALLER.get();prefix=c['legacy_subject']+'/'
    return path[len(prefix):] if space=='personal' and path.startswith(prefix) else path

async def metadata(file_id,space,path):
    result=await asyncio.to_thread(call,'mengchu_search',{'space':space,'scope':'files','q':relative(path,space),'limit':200})
    for item in result.get('files',result.get('items',[])):
        row=view_file(item,space)
        if row.get('file_id',row.get('id'))==file_id and row.get('path')==path:return row
    raise RuntimeError('current_file_identity_or_location_changed')

def install():
    from web import mengspace
    from fastapi import HTTPException, Request
    from fastapi.routing import APIRoute
    from fastapi.responses import StreamingResponse
    import mimetypes
    old_api=mengspace._api
    async def api(base,path,*,method='GET',token=None,params=None,body=None):
        if base==mengspace.MENG and path=='/api/files':
            space=(params or {}).get('space','personal');q=relative((params or {}).get('q',''),space)
            result=await asyncio.to_thread(call,'mengchu_search',{'space':space,'scope':'files','q':q,'limit':min(int((params or {}).get('limit',200)),200)})
            return {**result,'files':[view_file(x,space) for x in result.get('files',result.get('items',[]))]}
        if base==mengspace.MENG and path in ('/api/files/trash','/api/admin/restore'):
            return await asyncio.to_thread(call,'mengchu_trash' if path.endswith('/trash') else 'mengchu_restore',{'file_id':body['file_id']})
        return await old_api(base,path,method=method,token=token,params=params,body=body)
    async def upload(s,path,content,size,digest,note=''):
        relative_path=mengspace._path(path,s['username']);parent=relative_path.rsplit('/',1)[0] if '/' in relative_path else ''
        # Preserve the old create-not-overwrite semantics using current source list.
        listing=await mengspace._list(s,'personal',parent)
        full=s['username']+'/'+relative_path
        if listing['partial']:raise HTTPException(409,'目录列表不完整，请进入更具体的子目录')
        if any(x['path']==full or x['path'].startswith(full+'/') for x in listing['files']):raise HTTPException(409,'同名文件已存在，请先改名')
        args={'space':'personal','path':relative_path,'note':note,'apply_month_prefix':False}
        out=await asyncio.to_thread(upload_stream,args,content,size)
        file_id=out.get('file_id',out.get('id'))
        if not file_id:raise HTTPException(502,'当前上传效果未确认，请按原路径查询后接续')
        return {**out,'file_id':file_id,'path':full}
    async def current(s,file_id,space,path,version=None):
        if not mengspace._scope(space,path,s['username']):raise HTTPException(403,'不能访问当前空间以外的文件')
        row=await metadata(file_id,space,path)
        if version is not None and row.get('ver')!=version:raise HTTPException(409,'文件版本已变化，请刷新后重试')
        # Current head is proven; absence of a history enumeration is stated.
        return {'file_id':file_id,'space':space,'path':path,'current_ver':row.get('ver'),'versions':[{'ver':row.get('ver'),'size':row.get('size'),'source_version':row.get('source_version')}],'history_coverage':'current_head_only'}
    async def download(request: Request,file_id: str,space: str,path: str,version: int | None=None,attachment: bool=False,preview: bool=False):
        s=await mengspace._session(request);await current(s,file_id,space,path)
        args={'file_id':file_id}
        if version is not None:args['ver']=version
        # First get rechecks actual ownership and fixed registered history.
        out=await asyncio.to_thread(call,'mengchu_get',args)
        # A full fixed MCP payload is already an authorized byte source.
        data=None
        if isinstance(out.get('text'),str):data=out['text'].encode('utf-8')
        elif isinstance(out.get('content_base64'),str):data=base64.b64decode(out['content_base64'],validate=True)
        if data is not None and len(data)==out.get('size') and out.get('whole_fixed_integrity') in (True,'verified'):
            media=out.get('content_type') or mimetypes.guess_type(path)[0] or 'application/octet-stream'
            if media in ('text/html','image/svg+xml','application/javascript'):media='text/plain; charset=utf-8'
            disposition='attachment' if attachment else 'inline';name=path.rsplit('/',1)[-1]
            return StreamingResponse(iter([data]),media_type=media,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':disposition+"; filename*=UTF-8''"+urllib.parse.quote(name)})
        c=CURRENT_CALLER.get();fixed=out.get('fixed_ref')
        if isinstance(fixed,dict) and all(isinstance(fixed.get(k),str) for k in ('project_id','material_id','version_id')):
            # Actual registered fixed reference from the authorized getter; no path/UUID guess.
            body={k:fixed[k] for k in ('project_id','material_id','version_id')}
            req=urllib.request.Request('https://hufu.example.invalid/hub2-preview/mem/v2/files/read',data=json.dumps(body).encode(),method='POST',headers={'Authorization':c['token'],'Content-Type':'application/json'})
        else:
            # Registered legacy small stream route; authorization remains current caller.
            url='https://hufu.example.invalid/files/'+urllib.parse.quote(file_id,safe='')
            if version is not None:url+='?ver='+str(version)
            req=urllib.request.Request(url,headers={'Authorization':c['token']})
        try:remote=await asyncio.to_thread(urllib.request.urlopen,req,timeout=30)
        except urllib.error.HTTPError as error:
            if error.code==403:raise HTTPException(403,'当前软件或个人资料范围不足，请使用本人已有资料软件')
            raise HTTPException(502,'受控文件流暂不可用；按原文件编号查询后接续')
        async def stream():
            try:
                while True:
                    chunk=await asyncio.to_thread(remote.read,1024*1024)
                    if not chunk:break
                    yield chunk
            finally:remote.close()
        media=out.get('content_type') or mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if media in ('text/html','image/svg+xml','application/javascript'):media='text/plain; charset=utf-8'
        disposition='attachment' if attachment else 'inline'
        name=path.rsplit('/',1)[-1]
        return StreamingResponse(stream(),media_type=media,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':disposition+"; filename*=UTF-8''"+urllib.parse.quote(name)})
    mengspace._api=api;mengspace._upload=upload;mengspace._current=current
    from web.server import app
    for router in (mengspace.router,app.router):
        for index,route in enumerate(router.routes):
            if isinstance(route,APIRoute) and route.path=='/api/mengspace/download/{file_id}':
                # Modern FastAPI includes routers lazily; adapt the source router too.
                router.routes[index]=APIRoute(route.path,download,methods=route.methods,name=route.name,response_model=route.response_model,response_class=route.response_class,status_code=route.status_code,dependencies=route.dependencies)

    from tools_file_navigation import install as install_navigation
    install_navigation()
