"""Native current identity into existing application request data models.
No password login, no made-up legacy account, and no administrator token fallback.
"""
import datetime
from caller_context import CURRENT_CALLER

def role(decision):
    current=decision.get('current_role')
    return 'admin' if current=='organization_admin' else 'member'

def baize_install():
    from app.main import app
    from app import deps
    from app.services.auth_service import WebSession
    from app.services.hufu import HufuUser
    from starlette.requests import Request
    def current():
        value=CURRENT_CALLER.get()
        if not value or not value.get('legacy_subject'):raise RuntimeError('current_authenticated_legacy_subject_required')
        return value
    def web_session():
        c=current();d=c['decision'];profile=d.get('member_profile',{}).get('profile',{}) or {};now=datetime.datetime.now(datetime.timezone.utc)
        expiry=now+datetime.timedelta(minutes=30) if d['deadline']=='until_revoked' else datetime.datetime.fromisoformat(d['deadline'].replace('Z','+00:00'))
        r=role(d)
        return WebSession(session_id='hufu2:'+d['actor_id'],hufu_user_id=c['legacy_subject'],name=profile.get('nickname') or c['legacy_subject'],department=profile.get('department'),roles=[r],is_admin=r=='admin',is_supervisor=False,aliases=profile.get('aliases') or [],created_at=now,expires_at=expiry)
    async def current_web(request:Request):return web_session()
    async def current_optional(request:Request):return web_session()
    async def current_client():
        c=current();d=c['decision'];p=d.get('member_profile',{}).get('profile',{}) or {}
        return HufuUser(username=c['legacy_subject'],nickname=p.get('nickname') or c['legacy_subject'],department=p.get('department') or '',role=role(d),real_name=p.get('real_name') or '',aliases=p.get('aliases') or [])
    app.dependency_overrides[deps.get_web_session]=current_web
    app.dependency_overrides[deps.get_optional_web_session]=current_optional
    app.dependency_overrides[deps.get_client_user]=current_client

def tools_install():
    from web import mengspace
    old=mengspace._session
    async def current_session(request,*,write=False):
        c=CURRENT_CALLER.get()
        if not c or not c.get('legacy_subject'):raise RuntimeError('current_authenticated_legacy_subject_required')
        # Keep an existing authenticated original session for old API protocol use,
        # but its subject must match the current Hufu actor; role comes from Hufu.
        if request.cookies.get(mengspace.COOKIE):
            result=await old(request,write=write)
            if result['username']!=c['legacy_subject']:raise RuntimeError('subject_mismatch')
            return {**result,'role':role(c['decision'])}
        # New direct caller. Downstream legacy Mengstore protocol compatibility
        # still needs its own adapter; never replace this caller with a service token.
        return {'username':c['legacy_subject'],'nickname':c['legacy_subject'],'role':role(c['decision']),'token':c['token'],'expires':float('inf'),'token_until':float('inf'),'csrf':None}
    mengspace._session=current_session
