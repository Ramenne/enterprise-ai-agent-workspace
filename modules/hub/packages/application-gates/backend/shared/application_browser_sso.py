"""Product cookie transport for the same existing Portal member; fixed app binding.
No user identity/software credential creation. Never use cookie as generic bearer.
"""
import json,pathlib,urllib.request,urllib.error,secrets,datetime
from http.cookies import SimpleCookie
from urllib.parse import urlencode
TARGETS={'baize':('baize_hufu2','service.example.invalid'),'tools':('tools_hufu2','service.example.invalid')}
COOKIE='__Host-hufu2_session';STATE='__Host-hufu2_state'
PORTAL='https://hufu.example.invalid/hub2-preview/hufu/portal'
class BrowserDenied(Exception):
    def __init__(self,code,status=401):self.code=code;self.status=status
class BrowserSession:
    def __init__(self,config):
        self.application=config['application'];self.target,self.host=TARGETS[self.application]
        self.key=pathlib.Path(config['browser_sso']['consumer_key_file'])
        if self.key!=pathlib.Path('/etc/workspace-hub2/application-gates/'+self.application+'.consumer.private'):raise ValueError('fixed_application_consumer_key_required')
    def cookies(self,headers):
        c=SimpleCookie()
        try:c.load(headers.get(b'cookie',''))
        except Exception:raise BrowserDenied('application_cookie_invalid')
        return {k:v.value for k,v in c.items()}
    def call(self,endpoint,body):
        req=urllib.request.Request(PORTAL+endpoint,data=json.dumps({'target':self.target,**body}).encode(),headers={'Content-Type':'application/json','x-hub-consumer-key':self.key.read_text().strip()},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=12) as r:return json.load(r)
        except urllib.error.HTTPError as e:raise BrowserDenied('current_browser_session_or_authority_required',401 if e.code==401 else 403)
        except (OSError,ValueError):raise BrowserDenied('browser_session_authority_unavailable',503)
    def current(self,headers,method,path,query=b''):
        value=self.cookies(headers).get(COOKIE)
        if not value:raise BrowserDenied('browser_login_required')
        collecting=self.application=='tools' and method=='GET' and path=='/' and bool(query)
        if method not in ('GET','HEAD','OPTIONS') or collecting:
            origin=headers.get(b'origin')
            if origin!='https://'+self.host and not (collecting and not origin and headers.get(b'sec-fetch-site')=='same-origin'):raise BrowserDenied('same_origin_browser_request_required',403)
        return self.call('/api/application-sso/check',{'cookie':value,'method':method,'route':path,'side_effect_query':collecting})
    def start(self):
        state=secrets.token_urlsafe(32)
        return PORTAL+'/sso/start?'+urlencode({'target':self.target,'host':self.host,'state':state,'next':'/hufu2/'}),STATE+'='+state+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=120'
    def callback(self,headers,query):
        state=self.cookies(headers).get(STATE);ticket=query.get('ticket',[''])[0];given=query.get('state',[''])[0]
        if not state or not secrets.compare_digest(state,given) or not ticket:raise BrowserDenied('browser_handoff_state_invalid')
        return self.call('/api/sso/exchange',{'ticket':ticket,'state':state})
    def response_cookie(self,result):
        value=result['session_cookie']
        if not isinstance(value,str) or not value or len(value)>6000 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in value):
            raise BrowserDenied('application_cookie_invalid',503)
        expiry=datetime.datetime.fromisoformat(result['expires_at'].replace('Z','+00:00'))
        ttl=max(0,int((expiry-datetime.datetime.now(datetime.timezone.utc)).total_seconds()))
        limit=31536000 if result.get('session_until_revoked') is True and self.application=='baize' else 28800
        return COOKIE+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+str(min(ttl,limit))
