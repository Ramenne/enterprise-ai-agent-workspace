"""Platform-only provisioning: approved namespace, direct config; never executes app code."""
import json,os,pwd,stat,sys,uuid,urllib.request,urllib.error,subprocess,re
from pathlib import Path
BASE='https://hufu.example.invalid/hub2-preview/hufu'
def fail(code):
 raise RuntimeError(code)
def api(token,path,body=None):
 req=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers={'authorization':'Bearer '+token,'content-type':'application/json'},method='POST' if body is not None else 'GET')
 try:
  with urllib.request.urlopen(req,timeout=40) as r:return json.loads(r.read())
 except urllib.error.HTTPError as e:fail('configuration_authority_check_rejected_'+str(e.code))
def ensure_root_dir(path,mode=0o711):
 p=Path(path)
 if p.is_symlink():fail('configuration_directory_symlink')
 if not p.exists():p.mkdir(mode=mode)
 s=p.stat()
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0:fail('configuration_directory_owner_mismatch')
 os.chmod(p,mode)
 return p

def main():
 if os.geteuid()!=0:fail('platform_provisioner_required')
 b=json.load(sys.stdin)
 token=b['manager_token'];host=b['host_alias'];package_id=str(uuid.UUID(b['package_id']))
 if host not in('zm-jiaxin','zm-xiaochen'):fail('unsupported_registered_host')
 me=api(token,'/v2/me')
 if me.get('principal_kind')!='member' or me.get('member_role')!='organization_admin':fail('organization_resource_manager_required')
 package=api(token,'/v2/services/resource-packages/read',{'package_id':package_id})
 if package.get('state') not in('approved','partially_delivered','delivered'):fail('whole_resource_package_not_approved')
 sid=str(uuid.UUID(package['service_id']));secret_values=b.get('secret_values',{})
 defaults={
  'ad44cc0e-159e-4e0f-a5ca-73d3920240d9':{'host':'zm-jiaxin','runtime_user':'hubeng-employeeclient','runtime_service':'hub2-project-employeeclient.service'},
  '3527ac31-0643-4f89-a6bd-b1e9768b2e42':{'host':'zm-xiaochen','runtime_user':'baize'}
 }.get(package['project_id'],{})
 def needs_configuration(item):
  req=item['requirements']
  return item['kind']=='secret' or req.get('needs_secret') is True or item['kind']=='storage' and req.get('mode')=='object_namespace'

 if not isinstance(secret_values,dict):fail('invalid_private_configuration')
 for key in secret_values:
  if not any(x['item_id']==key and needs_configuration(x) for x in package['resources']):fail('private_configuration_not_in_approved_bundle')
 # Validate all targets before filesystem changes. Only server/storage-directory/secret
 # items for this host are applicable; cloud and domain effects use their own adapters.
 plans=[]
 for item in package['resources']:
  req={**defaults,**item['requirements']};kind=item['kind'];itemid=str(uuid.UUID(item['item_id']))
  if req.get('host')!=host:continue
  if needs_configuration(item):kind='secret'
  if kind not in('server','storage','secret'):continue
  if kind=='storage' and req.get('mode')!='local_directory':continue
  user=pwd.getpwnam(req['runtime_user'])
  if user.pw_uid<100 or user.pw_uid==0:fail('application_runtime_user_required')
  if kind=='secret':
   name=req.get('name',req.get('provider_target_id','resource-'+itemid))
   if not isinstance(name,str) or len(name)>120 or not name or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in name):fail('invalid_configuration_name')
   value=secret_values.get(itemid)
   if value is None:continue
   if not isinstance(value,str) or not value or len(value)>262144:fail('invalid_private_configuration_value')
   plans.append((item,kind,user,name,value))
  else:plans.append((item,kind,user,None,None))
 if b.get('prepare_only'):
  print(json.dumps({'state':'configuration_plan_ready','package_id':package_id,'items':[{'item_id':x[0]['item_id'],'kind':x[1],'uid':x[2].pw_uid} for x in plans],'external_effect':False}));return
 ensure_root_dir('/srv/workspace-services',0o755)
 base=ensure_root_dir('/srv/workspace-services/'+sid)
 private_base=ensure_root_dir(str(base/'private-config'))
 results=[]
 def bind_runtime_area(item,path,user):
  req={**defaults,**item['requirements']};unit=req.get('service',req.get('runtime_service'))
  if not unit:return {'runtime_binding':'standalone_uid;runtime_unit_not_declared'}
  if not isinstance(unit,str) or not re.fullmatch(r'[A-Za-z0-9_.@-]+[.]service',unit):fail('invalid_application_runtime_unit')
  owner=subprocess.check_output(['systemctl','show',unit,'-p','User','--value'],text=True).strip()
  if owner!=user.pw_name:fail('runtime_unit_user_mismatch')
  drop=ensure_root_dir('/etc/systemd/system/'+unit+'.d',0o755)
  target=drop/('97-resource-'+sid+'-'+item['item_id']+'.conf')
  if target.is_symlink():fail('runtime_dropin_symlink')
  text='[Service]\nBindPaths='+str(path)+'\nReadWritePaths='+str(path)+'\n'
  target.write_text(text);os.chmod(target,0o644)
  subprocess.run(['systemctl','daemon-reload'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip() or 0)
  current=False
  if pid>0:
   if Path('/proc/'+str(pid)).stat().st_uid!=user.pw_uid:fail('runtime_process_user_mismatch')
   fd=os.open(path,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW)
   try:
    subprocess.run(['nsenter','-t',str(pid),'-m','--','mount','--bind','/proc/self/fd/'+str(fd),str(path)],pass_fds=(fd,),check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['nsenter','-t',str(pid),'-m','--','mount','-o','remount,bind,rw',str(path)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    current=True
   finally:os.close(fd)
  return {'runtime_unit':unit,'runtime_unit_dropin':str(target),'runtime_binding':'approved_directory','current_process_bound':current,'application_restarted':False}
 for item,kind,user,name,value in plans:
  itemid=item['item_id']
  if kind=='secret':
   private=ensure_root_dir(str(private_base/itemid))
   fd=os.open(private,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
   try:
    temp='.'+name+'.'+str(uuid.uuid4())
    f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    try:
     data=value.encode();offset=0
     while offset<len(data):offset+=os.write(f,data[offset:])
     os.fchown(f,user.pw_uid,user.pw_gid);os.fchmod(f,0o600);os.fsync(f)
    finally:os.close(f)
    os.replace(temp,name+'.private',src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
   finally:os.close(fd)
   # Protected parents cannot be renamed by the application; it can traverse
   # them and read only its uid-owned 0600 configuration file.
   results.append({'item_id':itemid,'status':'delivered','receipt':{'host':host,'path':str(private/(name+'.private')),'uid':user.pw_uid,'mode':'0600','delivery':'direct_plaintext_runtime_configuration','value_in_receipt':False}})
  else:
   namespace=Path('/srv/workspace-services')/sid
   if namespace.is_symlink():fail('application_namespace_symlink')
   if not namespace.exists():namespace.mkdir(mode=0o755)
   # Keep the namespace root platform-owned; each approved item is app-owned.
   if namespace.stat().st_uid!=0:fail('application_namespace_owner_mismatch')
   area=namespace/itemid
   if area.is_symlink():fail('application_area_symlink')
   if not area.exists():area.mkdir(mode=0o700)
   s=area.stat()
   if not stat.S_ISDIR(s.st_mode) or s.st_uid not in(0,user.pw_uid):fail('application_area_owner_mismatch')
   os.chown(area,user.pw_uid,user.pw_gid);os.chmod(area,0o700)
   results.append({'item_id':itemid,'status':'delivered','receipt':{'host':host,'path':str(area),'uid':user.pw_uid,'mode':'0700','delivery':'application_owned_directory','autonomous_file_creation':True,**bind_runtime_area(item,area,user)}})
 print(json.dumps({'state':'configured','package_id':package_id,'host':host,'items':results,'secret_values_in_output':False}))
try:main()
except Exception as e:
 code=str(e) if isinstance(e,RuntimeError) else 'configuration_operation_failed'
 print(json.dumps({'state':'failed','error_code':code,'secret_values_in_output':False}));sys.exit(1)
