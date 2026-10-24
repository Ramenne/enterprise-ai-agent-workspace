"""Source registration on Jiaxin; receiver profile is separate fixed-host install."""
from pathlib import Path
repo=Path('/srv/workspace')
p=Path('/srv/workspace');s=p.read_text().replace("c={**c,'blocked_legacy_grant_prefixes':[]}","c={**c,'blocked_legacy_grant_prefixes':[],'legacy_cookie_names':[settings.session_cookie_name]}");p.write_text(s)
p=Path('/srv/workspace');s=p.read_text().replace("return ProjectGate(app,config('tools'),legacy)","return ProjectGate(app,{**config('tools'),'legacy_cookie_names':[COOKIE]},legacy)");p.write_text(s)
p=repo/'packages/application-gates/backend/control/application_release.py';s=p.read_text()
if 'application_browser_sso.py' not in s:s=s.replace("'native_identity_bridge.py','caller_context.py'", "'native_identity_bridge.py','caller_context.py','application_browser_sso.py'")
p.write_text(s)
