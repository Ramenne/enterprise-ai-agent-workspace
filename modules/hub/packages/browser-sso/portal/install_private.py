"""Fixed service-consumer registration only; never output service key values."""
from pathlib import Path
import json,sys,os,pwd,grp
seed=json.loads(Path(sys.argv[2]).read_text())
if sys.argv[1]=='portal':
 p=Path('/srv/workspace');x=json.loads(p.read_text());x.update(seed);p.write_text(json.dumps(x));os.chmod(p,0o600)
elif sys.argv[1]=='applications':
 for app,user in [('baize','baize'),('tools','fgb-collector-poc')]:
  key=Path('/etc/workspace-hub2/application-gates/'+app+'.consumer.private');key.write_text(seed[app+'_hufu2']);key.chmod(0o600);os.chown(key,pwd.getpwnam(user).pw_uid,grp.getgrnam(user).gr_gid)
  cfg=Path('/etc/workspace-hub2/application-gates/'+app+'.json');x=json.loads(cfg.read_text());x['browser_sso']={'consumer_key_file':str(key)};cfg.write_text(json.dumps(x))
else:raise ValueError('fixed_install_host_required')
