"""Original wrappers around shared legacy authentication points; no old code copy.
For launch: PYTHONPATH=/srv/workspace<old paths> uvicorn
application_loaders:baize or :tools, with HUFU_APPLICATION_GATE_CONFIG set.
Replacing production ExecStart requires separate controlled service integration.
"""
import json,os
from application_gate import ProjectGate

def config(application):
    c=json.load(open(os.environ['HUFU_APPLICATION_GATE_CONFIG']))
    if c['application']!=application:raise RuntimeError('wrong_application_gate_config')
    return c

def tools():
    from web.server import app
    from web.mengspace import _session, COOKIE
    from starlette.requests import Request
    async def legacy(scope,receive):
        request=Request(scope,receive)
        if not request.cookies.get(COOKIE):return {'subject':scope['_hufu_decision'].get('legacy_subject'),'role':scope['_hufu_decision'].get('current_role')}
        session=await _session(request,write=False);return {'subject':session['username'],'role':session.get('role')}
    from native_identity_bridge import tools_install
    tools_install()
    from tools_resource_bridge import install
    install()
    from tools_mcp_bridge import install as install_mcp
    install_mcp()
    from tools_h3_cloud import install as install_h3
    install_h3()
    return ProjectGate(app,{**config('tools'),'legacy_cookie_names':[COOKIE]},legacy)
