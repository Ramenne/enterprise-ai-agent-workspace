"""Loopback runner using the caller's native Hufu bearer, never a shared identity."""
import asyncio
import contextvars
import json
import sys
import types
import urllib.request
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

CALLER = contextvars.ContextVar('native_h3_caller', default=None)


def call(tool, args):
    caller = CALLER.get()
    if not caller:
        raise RuntimeError('current_caller_required')
    envelope = {'jsonrpc': '2.0', 'id': str(uuid.uuid4()), 'method': 'tools/call',
                'params': {'name': 'hub.invoke', 'arguments': {'tool': tool, 'arguments': args}}}
    req = urllib.request.Request('https://hufu.example.invalid/mcp', method='POST',
                                 data=json.dumps(envelope).encode(),
                                 headers={'Authorization': caller['token'], 'Content-Type': 'application/json',
                                          'Accept': 'application/json, text/event-stream'})
    with urllib.request.urlopen(req, timeout=90) as response:
        packet = json.load(response)
    result = packet.get('result', {})
    data = result.get('structuredContent')
    if data is None:
        data = next((json.loads(x['text']) for x in result.get('content', []) if x.get('type') == 'text'), None)
    if 'error' in packet or result.get('isError') or not isinstance(data, dict) or data.get('error_code'):
        raise RuntimeError('current_native_call_not_confirmed')
    return data


app = FastAPI(title='Comfy Cloud H3 API', docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/ready')
def ready():
    return {'state': 'ready', 'component': 'tools-h3-cloud'}


@app.middleware('http')
async def authenticated(request: Request, next_handler):
    if request.url.path == '/ready':
        return await next_handler(request)
    authorization = request.headers.get('Authorization', '')
    if not authorization.startswith('Bearer '):
        return JSONResponse({'code': 'native_hufu_bearer_required'}, status_code=401)
    token = CALLER.set({'token': authorization})
    try:
        try:
            identity = await asyncio.to_thread(call, 'hufu_whoami', {})
            if not identity.get('actor_id'):
                raise ValueError()
        except Exception:
            return JSONResponse({'code': 'current_native_identity_not_verified'}, status_code=401)
        CALLER.set({'token': authorization, 'legacy_subject': identity['actor_id']})
        response = await next_handler(request)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
    finally:
        CALLER.reset(token)


# Reuse the exact adapter registered in the tools engineering repository.
web = types.ModuleType('web')
server = types.ModuleType('web.server')
server.app = app
sys.modules['web'] = web
sys.modules['web.server'] = server
context = types.ModuleType('caller_context')
context.CURRENT_CALLER = CALLER
sys.modules['caller_context'] = context
bridge = types.ModuleType('tools_mcp_bridge')
bridge.call = call
sys.modules['tools_mcp_bridge'] = bridge
import tools_h3_cloud
tools_h3_cloud.install()
import tools_krea2_cloud
tools_krea2_cloud.install()

import tools_minimax_audio
tools_minimax_audio.install()

import tools_visual
tools_visual.install()

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=18292, access_log=False)
