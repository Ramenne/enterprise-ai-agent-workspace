"""Fixed platform receiver: secret stdin to existing Baize UID 0600 file."""
import sys,json,pathlib,os,pwd,urllib.request
p=json.load(sys.stdin);assert p['actor_id']=='9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3';assert set(p['actions'])=={'mem.process','mem.read','mem.upload','v8.project.read'}
token=p['token'];assert token.startswith('hub2_')and not any(c.isspace()for c in token)
r=urllib.request.Request('https://hufu.example.invalid/v2/me',headers={'authorization':'Bearer '+token});me=json.loads(urllib.request.urlopen(r,timeout=20).read());assert me['actor_id']==p['actor_id']and me['credential_id']==p['credential_id']and me['parent_credential_id']=='035360c8-6dec-4456-a138-cbb41746f7b6'and set(me['client_actions'])==set(p['actions'])
d=pathlib.Path('/etc/workspace-hub2/baize-processing');d.mkdir(parents=True,exist_ok=True);a=pwd.getpwnam('baize');os.chown(d,a.pw_uid,a.pw_gid);os.chmod(d,0o700);f=d/'worker-token.private';tmp=d/'worker-token.private.new';tmp.write_text(token+'\n');os.chown(tmp,a.pw_uid,a.pw_gid);os.chmod(tmp,0o600);os.replace(tmp,f)
print(json.dumps({'state':'installed_and_identity_verified','actor_id':p['actor_id'],'client_id':p['client_id'],'credential_id':p['credential_id'],'actions':p['actions'],'file':str(f),'uid':a.pw_uid,'mode':'0600','token_logged':False}))
