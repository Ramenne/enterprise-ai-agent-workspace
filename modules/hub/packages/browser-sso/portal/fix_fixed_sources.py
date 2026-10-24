from pathlib import Path
import sys
if sys.argv[1]=='receiver':
 p=Path('/srv/workspace');s=p.read_text().replace("'native_identity_bridge.py','caller_context.py'", "'native_identity_bridge.py','caller_context.py','application_browser_sso.py'");p.write_text(s)
else:
 r=Path('/srv/workspace');p=r/'packages/application-gates/backend/control/application_release.py';s=p.read_text().replace("'native_identity_bridge.py','caller_context.py'", "'native_identity_bridge.py','caller_context.py','application_browser_sso.py'");p.write_text(s)
 p=Path('/srv/workspace');s=p.read_text()
 if "['baize2'," not in s:s=s.replace("['tools','工具集与梦空间'", "['baize2','白泽 2.0','本人身份权限服务会话接入录音与会议','https://baize.example.invalid/hufu2/start','MEETINGS'],['tools2','工具 2.0','本人身份权限服务会话接入采集与资料工具','https://tools.example.invalid/hufu2/start','TOOLS'],['tools','工具集与梦空间'")
 s=s.replace('i.append(icon(id));', "i.append(icon(id==='baize2'?'baize':id==='tools2'?'tools':id));");p.write_text(s)
 (r/'packages/browser-sso/portal/app.js').write_text(s)
