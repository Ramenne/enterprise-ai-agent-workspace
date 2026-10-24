"""Original ASGI global project gate, preserving legacy identity/privacy checks.
Install by wrapping existing app object, not copying or editing legacy source.
All HTTP routes require the current caller's Hufu credential. Legacy identity
resolver is supplied by loader, authenticated by existing app functions.
"""
import asyncio, hashlib, json, pathlib, urllib.request, urllib.error
from urllib.parse import parse_qs
from application_browser_sso import BrowserSession,BrowserDenied,COOKIE,STATE

class Denied(Exception):
    def __init__(self,code,status=403):self.code=code;self.status=status

def decide(config,token,method,path,query=b''):
    url=config['decision_url']
    if url not in ('http://127.0.0.1:4611/v2/authorization/decision','http://127.0.0.1:14611/v2/authorization/decision','https://hufu.example.invalid/v2/authorization/decision'):
        raise Denied('registered_hufu_authority_required',503)
    if config['application'] not in ('baize','tools','jiling'):raise Denied('application_not_registered',503)
    grant_workflow=config['application']=='baize' and (path=='/api/v1/dual-grants' or path.startswith('/api/v1/dual-grants/'))
    collecting=config['application']=='tools' and method=='GET' and path=='/' and bool(query)
    body={'application_id':config['application'],'action':'read' if grant_workflow or (method in ('GET','HEAD','OPTIONS') and not collecting) else 'write','resource':{'route':path,'method':method}}
    req=urllib.request.Request(url,data=json.dumps(body).encode(),method='POST',headers={'Content-Type':'application/json','Authorization':token})
    try:
        with urllib.request.urlopen(req,timeout=8) as result:out=json.load(result)
    except urllib.error.HTTPError as e:raise Denied('current_project_authority_required',401 if e.code==401 else 403)
    except (OSError,ValueError):raise Denied('hufu_authority_unavailable',503)
    profile=out.get('member_profile',{})
    out['legacy_subject']=out.get('legacy_subject') or profile.get('legacy_subject')
    out['current_role']=out.get('current_role') or profile.get('current_role')
    if out.get('project_id')!=config['project_id'] or not out.get('actor_id') or not out.get('client_id') or not out.get('deadline'):raise Denied('invalid_authority_decision',503)
    import datetime
    if out['deadline']!='until_revoked' and datetime.datetime.fromisoformat(out['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):raise Denied('current_project_authority_expired')
    return out

class ProjectGate:
    def __init__(self,app,config,legacy_identity):
        self.app=app;self.config=config;self.legacy_identity=legacy_identity
        self.browser=BrowserSession(config) if config.get('browser_sso') else None
    async def __call__(self,scope,receive,send):
        if scope['type']!='http':
            # WS requires gate at handshake + repeated checks; generic ASGI wrapper fails closed.
            if scope['type']=='websocket':return await send({'type':'websocket.close','code':4403})
            return await self.app(scope,receive,send)
        headers={k.lower():v.decode('latin1') for k,v in scope.get('headers',[])}
        try:
            path=scope.get('path','')
            if self.browser and path in ('/start','/callback'):
                if headers.get(b'host','').split(':')[0]!=self.browser.host:raise Denied('application_host_required',400)
                if scope['method']!='GET':raise Denied('browser_handoff_GET_required',405)
                if path=='/start':
                    location,state_cookie=self.browser.start()
                    await send({'type':'http.response.start','status':302,'headers':[(b'location',location.encode()),(b'set-cookie',state_cookie.encode()),(b'cache-control',b'no-store')]});return await send({'type':'http.response.body','body':b''})
                result=await asyncio.to_thread(self.browser.callback,headers,parse_qs(scope.get('query_string',b'').decode()))
                verified=await asyncio.to_thread(self.browser.call,'/api/application-sso/check',{'cookie':result['session_cookie'],'method':'GET','route':'/callback'})
                d=await asyncio.to_thread(decide,self.config,verified['authorization'],'GET','/callback')
                probe={**scope,'_hufu_decision':d,'_hufu_caller_token':verified['authorization']}
                invalid_old_cookie=False
                try:
                    old=await self.legacy_identity(probe,receive)
                except Exception as e:
                    if getattr(e,'status_code',None)!=401:raise
                    invalid_old_cookie=True
                    old=None # No valid old identity; current native subject is authoritative.
                if old and (old.get('subject') if isinstance(old,dict) else old)!=d.get('legacy_subject'):raise Denied('legacy_and_hufu_identity_binding_required')
                cookies=[self.browser.response_cookie(result),STATE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']
                # Once the authenticated subjects agree, retire only this product's old cookie.
                for name in self.config.get('legacy_cookie_names',[]) if invalid_old_cookie else []:
                    if name not in (COOKIE,STATE) and name.replace('_','').replace('-','').isalnum():cookies.append(name+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0')
                await send({'type':'http.response.start','status':302,'headers':[(b'location',result['next'].encode()),(b'cache-control',b'no-store'),*[(b'set-cookie',c.encode()) for c in cookies]]});return await send({'type':'http.response.body','body':b''})
            browser_used=False
            token=headers.get(b'x-hufu-authorization') or headers.get(b'authorization','')
            if not token and self.browser:
                if headers.get(b'host','').split(':')[0]!=self.browser.host:raise Denied('application_host_required',400)
                current=await asyncio.to_thread(self.browser.current,headers,scope['method'],path,scope.get('query_string',b''))
                token=current['authorization'];browser_used=True
            if not token.startswith('Bearer ') or len(token)>4096:raise Denied('current_caller_hufu_credential_required',401)
            decision=await asyncio.to_thread(decide,self.config,token,scope['method'],scope.get('path',''),scope.get('query_string',b''))
            renewal_cookie=None
            if browser_used and current.get('session_cookie'):
                if current.get('decision',{}).get('actor_id')!=decision.get('actor_id'):
                    raise Denied('application_session_actor_changed')
                renewal_cookie=self.browser.response_cookie(current)
            # Legacy username/session comes from actual old authentication, never X-User input.
            scope={**scope,'_hufu_decision':decision,'_hufu_caller_token':token}
            legacy=await self.legacy_identity(scope,receive)
            legacy_subject=legacy.get('subject') if isinstance(legacy,dict) else legacy
            if not legacy_subject or legacy_subject!=decision.get('legacy_subject'):raise Denied('legacy_and_hufu_identity_binding_required')
            if scope['method'] not in ('GET','HEAD','OPTIONS') and any(scope.get('path','').startswith(p) for p in self.config.get('blocked_legacy_grant_prefixes',[])):
                raise Denied('legacy_independent_grant_mutation_requires_hufu_migration')
            # Preserve Authorization and Cookie; old app continues all personal content checks.
            clean={**scope,'headers':[(k,v) for k,v in scope.get('headers',[]) if k.lower() not in (b'x-hufu-authorization',b'x-actor-id',b'x-member-id',b'x-principal-id',b'x-hub-authorized')]}
            # Explicit current bearer without browser cookies is not cookie CSRF.
            # Adapt only this authenticated CLI case to the original same-origin middleware.
            if browser_used:
                remaining='; '.join(k+'='+v for k,v in self.browser.cookies(headers).items() if k not in (COOKIE,STATE))
                clean['headers']=[(k,v) for k,v in clean['headers'] if k.lower()!=b'cookie']+([(b'cookie',remaining.encode())] if remaining else [])
            if self.config['application']=='tools' and not headers.get(b'cookie') and not headers.get(b'origin'):
                clean['headers']=clean['headers']+[(b'origin',b'https://tools.example.invalid/')]
        except BrowserDenied as e:
            data=json.dumps({'error_code':e.code,'login_path':'/hufu2/start'}).encode();await send({'type':'http.response.start','status':e.status,'headers':[(b'content-type',b'application/json'),(b'cache-control',b'no-store')]});await send({'type':'http.response.body','body':data})
        except Denied as e:
            data=json.dumps({'error_code':e.code}).encode();await send({'type':'http.response.start','status':e.status,'headers':[(b'content-type',b'application/json'),(b'cache-control',b'no-store')]});await send({'type':'http.response.body','body':data})
        except Exception:
            data=b'{"error_code":"legacy_identity_unavailable"}';await send({'type':'http.response.start','status':503,'headers':[(b'content-type',b'application/json')]});await send({'type':'http.response.body','body':data})
        else:
            if browser_used and scope['method']=='GET' and path=='/' and not scope.get('query_string'):
                title='白泽' if self.config['application']=='baize' else '工具'
                data=('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+title+' · 身份权限服务接入</title><body style="font:16px system-ui;max-width:38rem;margin:3rem auto;padding:1rem"><h1>'+title+'已接入本人身份权限服务会话</h1><p>当前会话可用于已获准的应用接口。原正式产品入口仍保留。</p><p><a href="/">进入原正式产品</a> · <a href="https://hufu.example.invalid/hub2-preview/hufu/portal">返回中枢工作入口</a></p></body></html>').encode()
                await send({'type':'http.response.start','status':200,'headers':[(b'content-type',b'text/html; charset=utf-8'),(b'cache-control',b'no-store')]});return await send({'type':'http.response.body','body':data})
            from caller_context import CURRENT_CALLER
            mark=CURRENT_CALLER.set({'token':token,'legacy_subject':decision.get('legacy_subject'),'decision':decision})
            async def renewed_send(message):
                if renewal_cookie and message['type']=='http.response.start':
                    # Preserve product logout or explicit replacement from the business app.
                    existing=message.get('headers',[])
                    owns_cookie=any(k.lower()==b'set-cookie' and v.decode('latin1').startswith(COOKIE+'=') for k,v in existing)
                    if not owns_cookie:
                        message={**message,'headers':[*existing,(b'set-cookie',renewal_cookie.encode('ascii'))]}
                await send(message)
            try:return await self.app(clean,receive,renewed_send)
            finally:CURRENT_CALLER.reset(mark)
