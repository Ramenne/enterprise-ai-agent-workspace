"""Fixed Baize public-entry publisher. Static bytes and typed policy only; no root code execution."""
import base64,datetime,fcntl,hashlib,json,os,pathlib,re,subprocess,urllib.request
PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42'
BASE=pathlib.Path('/srv/workspace')
VHOST=pathlib.Path('/etc/nginx/conf.d/baize.conf')
DIST=pathlib.Path('/opt/baize/web/dist')
ALLOWED={'.html','.js','.mjs','.css','.json','.txt','.map','.svg','.png','.ico','.jpg','.jpeg','.gif','.webp','.woff','.woff2','.ttf','.eot','.wasm'}
PAGES=['login','today','interim-summaries','transcripts','meetings','workdays','runs','grants','about']
def digest(b):return hashlib.sha256(b).hexdigest()
def validate_policy(p):
 if not isinstance(p,dict) or set(p)!={'mode','home_path','retire_legacy_scripts'} or p['mode'] not in ['legacy','native_email'] or p['home_path']!='/hufu2/' or type(p['retire_legacy_scripts'])is not bool:raise ValueError('fixed_baize_public_entry_policy_required')
 return p
def render(base,p):
 validate_policy(p)
 if p['mode']=='legacy':return base
 if base.count('server_name service.example.invalid;')!=2 or 'location ^~ /hufu2/' not in base:raise ValueError('fixed_baize_vhost_required')
 # Replace only the old exact login location. All API/audio/upload/download/TLS locations remain.
 old='    location = /login { return 302 /hub-sso/start; }'
 if base.count(old)!=1:raise ValueError('original_login_location_changed')
 text=base.replace(old,'')
 routes=['    # managed Baize public-entry; fixed component only','    location = / { add_header Cache-Control "no-store" always; return 302 /hufu2/; }']
 for path in PAGES:routes.append('    location = /'+path+' { add_header Cache-Control "no-store" always; return 302 /hufu2/'+path+'; }')
 for path in ['start','callback']:routes.append('    location = /hub-sso/'+path+' { add_header Cache-Control "no-store" always; add_header Referrer-Policy "no-referrer" always; return 303 /hufu2/login; }')
 if p['retire_legacy_scripts']:
  for path in ['hub-login.js','baize-hub-return.js']:routes.append('    location = /'+path+' { return 410; }')
 index=text.rfind('}')
 return text[:index]+'\n'+'\n'.join(routes)+'\n'+text[index:]
def run(args):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
 return {'exit_code':p.returncode,'output':p.stdout.decode('utf8','replace')[-6000:]}
def atomic(p,data):
 temp=p.with_name(p.name+'.public-entry-next');temp.write_bytes(data);temp.chmod(0o644);os.replace(temp,p)
def switch(target):
 temp=DIST.with_name('dist.public-entry-next');temp.unlink(missing_ok=True);temp.symlink_to(target);os.replace(temp,DIST)
def load_state():return json.loads((BASE/'state.json').read_text())
def execute(request,identity):
 if request['project_id']!=PROJECT or identity.get('project_id')!=PROJECT or identity.get('application_release_component')!='public-entry':raise PermissionError('fixed_baize_public_entry_required')
 if datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):raise PermissionError('engineering_permit_expired')
 p=request['parameters'];phase=p['phase']
 if identity.get('application_release_phase')!=phase or phase not in ['deploy','rollback','status']:raise PermissionError('current_public_entry_phase_required')
 with (BASE/'publish.lock').open('a')as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);s=load_state()
  if phase=='status':return {'state':'read','component':'public-entry','vhost':str(VHOST),'web_root':str(DIST),'current_web':str(DIST.resolve()),'current':s.get('current'),'previous_available':bool(s.get('previous')),'current_vhost_sha256':digest(VHOST.read_bytes()),'policy':s.get('policy'),'protected_routes':'API/audio/upload/download/TLS retained','service_effect':'nginx_reload_only'}
  if digest(VHOST.read_bytes())!=s['active_vhost_sha256'] or str(DIST.resolve())!=s['active_web']:raise ValueError('public_entry_changed_outside_component;refresh_current_state')
  original_config=VHOST.read_bytes();original_web=DIST.resolve();old=s.get('current')
  if phase=='deploy':
   artifact=p.get('artifact',{});policy=validate_policy(artifact.get('policy'));files=artifact.get('files');commit=artifact.get('commit')
   if artifact.get('project_id')!=PROJECT or not re.fullmatch('[a-f0-9]{40}',commit or '') or not isinstance(files,dict) or not 1<=len(files)<=1000 or 'index.html'not in files:raise ValueError('bounded_public_web_artifact_required')
   if len(json.dumps(artifact).encode())>24*1024*1024:raise ValueError('public_artifact_size_limit')
   material={};total=0
   for name,b64 in files.items():
    path=pathlib.PurePosixPath(name)
    if not isinstance(name,str) or path.is_absolute() or '..'in path.parts or any(x.startswith('.')for x in path.parts) or not re.fullmatch(r'[A-Za-z0-9_./@-]+',name) or path.suffix.lower()not in ALLOWED or not isinstance(b64,str):raise ValueError('public_static_file_required')
    data=base64.b64decode(b64,validate=True);total+=len(data)
    if len(data)>4*1024*1024 or total>16*1024*1024:raise ValueError('public_static_size_limit')
    material[name]=data
   h=digest(json.dumps(artifact,sort_keys=True).encode());release=BASE/'releases'/(commit[:12]+'-'+h[:12]);release.mkdir(parents=True,exist_ok=True,mode=0o755)
   for name,data in material.items():
    dest=release/'web'/name;dest.parent.mkdir(parents=True,exist_ok=True);atomic(dest,data)
   config=render((BASE/'baseline.conf').read_text(),policy).encode();atomic(release/'vhost.conf',config)
   candidate={'release':str(release),'web':str(release/'web'),'config':str(release/'vhost.conf'),'policy':policy,'commit':commit}
  else:
   candidate=s.get('previous')
   if not candidate:raise ValueError('previous_public_entry_missing')
   config=pathlib.Path(candidate['config']).read_bytes();release=pathlib.Path(candidate['release']);policy=candidate['policy'];commit=candidate.get('commit')
  try:
   atomic(VHOST,config);test=run(['/usr/sbin/nginx','-t'])
   if test['exit_code']:raise ValueError('nginx_config_validation_failed:'+test['output'])
   switch(pathlib.Path(candidate['web']))
   reload_=run(['/usr/bin/systemctl','reload','nginx.service'])
   if reload_['exit_code']:raise ValueError('nginx_reload_failed')
  except Exception:
   atomic(VHOST,original_config);switch(original_web);run(['/usr/sbin/nginx','-t']);run(['/usr/bin/systemctl','reload','nginx.service']);raise
  s.update(current=candidate,previous=old,active_vhost_sha256=digest(config),active_web=str(pathlib.Path(candidate['web']).resolve()),policy=policy)
  atomic(BASE/'state.json',(json.dumps(s,indent=2)+'\n').encode())
  return {'exit_code':0,'component':'public-entry','release':str(release),'commit':commit,'policy':policy,'nginx_test':test,'reload':'completed','vhost_sha256':digest(config),'web_files':len(material)if phase=='deploy'else None,'rollback_available':bool(old),'service':'nginx.service','protected_routes':'API/audio/upload/download/TLS retained','business_processes_restarted':False}
