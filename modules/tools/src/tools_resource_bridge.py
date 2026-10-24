"""Thin current API routing for the retired legacy project discovery endpoint.
Never invent legacy file paths or substitute a service/admin caller.
"""
import json,asyncio,urllib.request
from caller_context import CURRENT_CALLER

def install():
    from web import mengspace
    old=mengspace._api
    async def api(base,path,*,method='GET',token=None,params=None,body=None):
        if base==mengspace.MENG and path=='/api/projects/list':
            caller=CURRENT_CALLER.get()
            if not caller:raise RuntimeError('current_caller_required')
            def fetch():
                req=urllib.request.Request('https://hufu.example.invalid/hub2-preview/v8/v2/projects/search',data=b'{"limit":100}',headers={'Authorization':caller['token'],'Content-Type':'application/json'},method='POST')
                with urllib.request.urlopen(req,timeout=12) as r:return json.load(r)
            out=await asyncio.to_thread(fetch)
            return {'projects':[{**item,'name':item.get('name',item.get('title')),'status':item.get('status',item.get('state'))} for item in out.get('items',[])],'coverage':out.get('coverage'),'next_cursor':out.get('next_cursor')}
        # Original storage/version actions keep real existing semantics. A retired
        # upstream stays an explicit unavailable result; no fabricated success.
        return await old(base,path,method=method,token=token,params=params,body=body)
    mengspace._api=api
