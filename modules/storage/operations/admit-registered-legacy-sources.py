"""Root operational repair: admit only pinned, registered candidate source versions.
The manifest is metadata from current-authorized native lifecycle candidates. Full
source SHA verification and fresh authorization still precede every native COPY.
"""
import os,sys,json,pathlib,hashlib,importlib.util,fcntl,uuid
sys.dont_write_bytecode=True
if os.getuid()!=0:raise SystemExit('authorized_root_operator_required')
manifest=pathlib.Path(sys.argv[1]);expected=sys.argv[2];raw=manifest.read_bytes()
if hashlib.sha256(raw).hexdigest()!=expected:raise SystemExit('pinned_manifest_required')
rows=[json.loads(l) for l in raw.decode().splitlines() if l];base=pathlib.Path('/var/lib/hub2-legacy-source770');path=base/'admitted.json'
spec=importlib.util.spec_from_file_location('legacy_scope_broker','/srv/workspace');broker=importlib.util.module_from_spec(spec);spec.loader.exec_module(broker)
existing=json.loads(path.read_text());known={(r['bucket'],r['key'],r['versionId']):r for r in existing};added=[];skipped=[]
for r in rows:
 loc=(r['bucket'],r['key'],r['versionId'])
 if loc in known:continue
 if r['bucket']!='mengstore-1316920087' or not r.get('version_id') or not r.get('material_id') or not r.get('project_id') or len(r.get('sha256',''))!=64 or not r['versionId'] or r['versionId'] in ('null','undefined'):raise RuntimeError('registered_fixed_source_required')
 try:
  with broker.cos_request('HEAD',r['key'],r['versionId'],temporary_key=False) as response:
   size=int(response.headers.get('Content-Length','-1'));version=response.headers.get('x-cos-version-id');request_id=response.headers.get('x-cos-request-id')
  if size!=r['size'] or version!=r['versionId']:raise RuntimeError('fixed_cloud_head_mismatch')
 except broker.SourceError as e:
  skipped.append({'version_id':r['version_id'],'error':e.code});continue
 row={k:r[k] for k in ('bucket','key','versionId','sha256','size')};row.update(file_id='native-fixed:'+r['version_id'],legacy_version=None)
 added.append((row,{'version_id':r['version_id'],'head_status':200,'size':size,'versionId':version,'request_id':request_id}));known[loc]=row
# Do not hold the local registry lock over cloud I/O. Existing exact entries stay intact.
with (base/'admission.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX);current=json.loads(path.read_text());now={(r['bucket'],r['key'],r['versionId']):r for r in current}
 for row,_ in added:
  loc=(row['bucket'],row['key'],row['versionId'])
  if loc in now:
   if now[loc]['size']!=row['size'] or now[loc]['sha256']!=row['sha256']:raise RuntimeError('exact_source_identity_conflict')
  else:current.append(row);now[loc]=row
 temp=path.with_name(path.name+'.'+str(uuid.uuid4()));fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
 try:
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(json.dumps(current,separators=(',',':')).encode());f.flush();os.fsync(fd)
  os.fchown(fd,0,path.stat().st_gid)
 finally:os.close(fd)
 os.replace(temp,path)
print(json.dumps({'state':'updated','manifest_sha256':expected,'previous_entries':len(existing),'current_entries':len(current),'added':len(added),'head_proofs':[x[1] for x in added],'skipped':skipped}))
