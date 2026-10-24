#!/usr/bin/python3
"""PDD project release provider. Root-owned data operations, never caller shell/code."""
import base64,datetime,fcntl,hashlib,io,json,os,pathlib,re,shutil,stat,subprocess,sys,tempfile,time,uuid,zipfile

PROJECT='2b6594cc-3866-4862-a4cf-a46ed0dbba61'
SOURCE=pathlib.Path('/opt/pdd-lab/source')
STATE=pathlib.Path('/srv/workspace')
EXPIRY=datetime.datetime.fromisoformat('2026-10-28T23:59:59+08:00')
SERVICES={'backend':'pdd-lab-backend.service','websocket':'pdd-lab-websocket.service'}
ROOTS={'backend','websocket','frontend','common'}
DENY={'.git','.venv','venv','node_modules','private','data','logs','uploads','__pycache__','browser-profile','browser-data','playwright-data','user_data'}
EXT={'.py','.js','.mjs','.cjs','.json','.vue','.html','.css','.scss','.ts','.txt','.md','.svg','.png','.jpg','.webp','.woff','.woff2','.ico','.map'}
SHA=re.compile(r'[a-f0-9]{64}')

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(b):return hashlib.sha256(b).hexdigest()
def atomic_json(p,b):
    tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(b,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(p)
def window():
    if datetime.datetime.now(datetime.timezone.utc)>=EXPIRY:raise PermissionError('production_window_expired')
def release_path(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',value):raise ValueError('invalid_release_id')
    p=STATE/'releases'/value;p.mkdir(parents=True,exist_ok=True,mode=0o700);return p
def source_path(name,root=None):
    root=root or SOURCE
    if not isinstance(name,str) or '\\' in name or '\x00' in name:raise ValueError('invalid_project_path')
    p=pathlib.PurePosixPath(name)
    if p.as_posix()!=name or p.is_absolute() or not p.parts or p.parts[0] not in ROOTS or any(x in DENY or x.startswith('.') or x in ('..','.') for x in p.parts):raise ValueError('project_source_path_required')
    ordinary_token_source=name=='websocket/channel_pdd/core/pdd_token.py'
    if p.suffix.lower() not in EXT or (not ordinary_token_source and any(re.search(r'(?i)(?:^|[-_.])(credentials?|secrets?|cookies?|storage_state|auth_state|tokens?)(?:[-_.]|$)',x) for x in p.parts)):raise ValueError('source_file_type_not_allowed')
    q=root.joinpath(*p.parts)
    for a in [q,*q.parents]:
        if a==root:break
        if a.is_symlink():raise ValueError('source_symlink_not_allowed')
    if not q.resolve().is_relative_to(root.resolve()):raise ValueError('path_outside_project')
    if q.exists() and not q.is_file():raise ValueError('regular_source_file_required')
    return q
def file_sha(p):return digest(p.read_bytes()) if p.is_file() else None
def inventory():
    out=[]
    for top in sorted(ROOTS):
        base=SOURCE/top
        for root,dirs,files in os.walk(base):
            dirs[:]=sorted(d for d in dirs if d not in DENY and not d.startswith('.') and not (pathlib.Path(root)/d).is_symlink())
            for n in sorted(files):
                p=pathlib.Path(root)/n;rel=p.relative_to(SOURCE).as_posix()
                try:source_path(rel)
                except ValueError:continue
                if p.stat().st_size<=8*1024*1024:out.append({'path':rel,'size':p.stat().st_size,'sha256':file_sha(p)})
    return out
def inspect_bundle(release_id,expected_archive=None):
    d=release_path(release_id);archive=d/'bundle.zip'
    if not archive.is_file() or archive.stat().st_size>24*1024*1024:raise ValueError('bundle_missing_or_too_large')
    archive_sha=file_sha(archive)
    if expected_archive is not None and archive_sha!=expected_archive:raise ValueError('archive_hash_mismatch')
    with zipfile.ZipFile(archive) as z:
        names=z.namelist()
        if len(names)!=len(set(names)) or 'manifest.json' not in names:raise ValueError('unique_manifest_required')
        if z.getinfo('manifest.json').file_size>500000:raise ValueError('manifest_size_limit')
        m=json.loads(z.read('manifest.json'));rows=m.get('files')
        if not isinstance(rows,list) or not 1<=len(rows)<=1000:raise ValueError('release_files_required')
        if not isinstance(m.get('services',[]),list) or len(m.get('services',[]))>2 or len(set(m.get('services',[])))!=len(m.get('services',[])) or any(x not in SERVICES for x in m.get('services',[])):raise ValueError('only_pdd_backend_websocket_services')
        seen=set();changed=[];total=0
        for row in rows:
            if not isinstance(row,dict) or set(row)!={'path','sha256','expected_sha256'}:raise ValueError('exact_file_hash_manifest_required')
            path=row['path'];source_path(path)
            if path in seen or not isinstance(row['sha256'],str) or not SHA.fullmatch(row['sha256']):raise ValueError('invalid_file_manifest')
            if row['expected_sha256'] is not None and (not isinstance(row['expected_sha256'],str) or not SHA.fullmatch(row['expected_sha256'])):raise ValueError('invalid_expected_hash')
            seen.add(path);item=z.getinfo('files/'+path);total+=item.file_size
            if total>80*1024*1024 or item.file_size>8*1024*1024 or stat.S_ISLNK(item.external_attr>>16):raise ValueError('unsafe_archive_member')
            if digest(z.read(item))!=row['sha256']:raise ValueError('candidate_file_hash_mismatch')
            current=file_sha(source_path(path))
            changed.append({**row,'current_sha256':current,'conflict':current!=row['expected_sha256'],'unchanged':current==row['sha256']})
        if set(names)!={'manifest.json',*('files/'+p for p in seen)}:raise ValueError('bundle_contains_unlisted_files')
    plan={'release_id':release_id,'archive_sha256':archive_sha,'files':changed,'services':m.get('services',[]),'conflicts':[r['path'] for r in changed if r['conflict']]}
    plan['plan_sha256']=digest(json.dumps(plan,sort_keys=True,separators=(',',':')).encode())
    return plan

def restore(backup,source=None):
    source=source or SOURCE
    meta=json.loads((backup/'backup.json').read_text())
    for row in meta['files']:
        current=file_sha(source_path(row['path'],source))
        if current not in (row.get('sha256'),row['deployed_sha256']):raise ValueError('new_production_changes_preserved_manual_reconciliation_required')
    for row in meta['files']:
        p=source_path(row['path'],source)
        if row['existed']:
            tmp=p.with_name('.pdd-restore-'+uuid.uuid4().hex)
            shutil.copy2(backup/'files'/row['path'],tmp);os.chown(tmp,row['uid'],row['gid']);tmp.replace(p)
        elif p.exists():p.unlink()
    return meta
def restart(names):
    for name in names:
        subprocess.run(['/usr/bin/systemctl','restart',SERVICES[name]],capture_output=True,timeout=60,check=True)
        check=subprocess.run(['/usr/bin/systemctl','is-active',SERVICES[name]],capture_output=True,text=True,timeout=8)
        if check.stdout.strip()!='active':raise RuntimeError('service_not_active')
    # Verify backend HTTP without authentication, customer messages or side effects.
    import urllib.request
    for port in [8189,8190]:
        if (port==8189 and 'backend' not in names) or (port==8190 and 'websocket' not in names):continue
        deadline=time.monotonic()+30
        while True:
            try:
                urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/openapi.json',timeout=3).close();break
            except urllib.error.HTTPError as e:
                if e.code in (401,403,404):break
            except (OSError,TimeoutError):pass
            if time.monotonic()>=deadline:raise RuntimeError('service_http_probe_failed')
            time.sleep(1)
    return {'active':names,'http_reachability':'checked;not_business_acceptance'}
def apply_release(p,source=None,restart_fn=None):
    source=source or SOURCE;restart_fn=restart_fn or restart
    plan=inspect_bundle(p['release_id'],p['archive_sha256'])
    if plan['conflicts'] or plan['plan_sha256']!=p['plan_sha256']:raise ValueError('production_changed_replan_required')
    backup=STATE/'backups'/p['release_id']
    if backup.exists():raise ValueError('release_already_has_backup_use_original_operation')
    backup.mkdir(parents=True,mode=0o700);meta={'release_id':p['release_id'],'files':[],'services':plan['services'],'created_at':now()}
    for row in plan['files']:
        f=source_path(row['path'],source);item={'path':row['path'],'existed':f.is_file(),'deployed_sha256':row['sha256']}
        if f.is_file():
            s=f.stat();item.update(uid=s.st_uid,gid=s.st_gid,sha256=file_sha(f));b=backup/'files'/row['path'];b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,b)
        meta['files'].append(item)
    atomic_json(backup/'backup.json',meta)
    try:
        with zipfile.ZipFile(release_path(p['release_id'])/'bundle.zip') as z:
            for row in plan['files']:
                f=source_path(row['path'],source)
                if file_sha(f)!=row['expected_sha256']:raise ValueError('production_changed_during_apply')
                f.parent.mkdir(parents=True,exist_ok=True)
                old=f.stat() if f.exists() else None;tmp=f.with_name('.pdd-release-'+uuid.uuid4().hex)
                tmp.write_bytes(z.read('files/'+row['path']));tmp.chmod(stat.S_IMODE(old.st_mode) if old else 0o644)
                if source==SOURCE:
                    import pwd
                    user=pwd.getpwnam('ubuntu');os.chown(tmp,old.st_uid if old else user.pw_uid,old.st_gid if old else user.pw_gid)
                tmp.replace(f)
        health=restart_fn(plan['services'])
        return {'state':'completed','release_id':p['release_id'],'backup_id':p['release_id'],'files_updated':len(plan['files']),'health':health,'database_rollback':'not_automatic;approved_additive_schema_preserved'}
    except Exception:
        restore(backup,source);restart_fn(plan['services'])
        return {'state':'failed','error_code':'release_failed_previous_files_restored','backup_id':p['release_id']}

MIGRATION_PROGRAM=r'''
import json,sys,pymysql
b=json.load(sys.stdin);e=b['env'];mode=b['mode'];db=b.get('database',e['MYSQL_DATABASE'])
c=pymysql.connect(host=e['MYSQL_HOST'],port=int(e['MYSQL_PORT']),user=e['MYSQL_USER'],password=e['MYSQL_PASSWORD'],database=db,cursorclass=pymysql.cursors.DictCursor,connect_timeout=5,read_timeout=30,write_timeout=30,autocommit=True)
try:
 with c.cursor() as q:
  q.execute("SELECT GET_LOCK('workspace_pdd_product_sync_v1',5) AS acquired")
  if q.fetchone()['acquired']!=1:raise RuntimeError('migration_lock_unavailable')
  q.execute('SET SESSION lock_wait_timeout=5')
  q.execute("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE TABLE_SCHEMA=%s AND TABLE_NAME IN ('pdd_product','pdd_product_sync_job')",(db,));before=q.fetchall()
  cols={r['COLUMN_NAME']:r for r in before if r['TABLE_NAME']=='pdd_product'}
  job={r['COLUMN_NAME']:r for r in before if r['TABLE_NAME']=='pdd_product_sync_job'}
  types={'synced_at':'datetime','specs_updated_at':'datetime','specs_checked_at':'datetime','specs_error':'varchar(256)'}
  for n,t in types.items():
   if n in cols and (cols[n]['DATA_TYPE']!=t.split('(')[0] or cols[n]['IS_NULLABLE']!='YES' or n=='specs_error' and cols[n]['CHARACTER_MAXIMUM_LENGTH']!=256):raise ValueError('existing_column_type_conflict')
  if job:
   expected={'id':'bigint','shop_pk':'bigint','product_id':'bigint','kind':'varchar','state':'varchar','run_token':'varchar','owner_user_id':'bigint','revision':'int','total':'int','completed':'int','failed':'int','message':'text','finished_at':'datetime','created_at':'datetime','updated_at':'datetime','created_by':'bigint'}
   if any(n not in job or job[n]['DATA_TYPE']!=t for n,t in expected.items()):raise ValueError('existing_sync_job_schema_conflict')
  ddl=[]
  if not job:ddl.append('CREATE TABLE pdd_product_sync_job (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, shop_pk BIGINT NOT NULL UNIQUE, product_id BIGINT NULL, kind VARCHAR(24) NOT NULL, state VARCHAR(24) NOT NULL, run_token VARCHAR(64) NOT NULL, owner_user_id BIGINT NULL, revision INT NOT NULL, total INT NOT NULL, completed INT NOT NULL, failed INT NOT NULL, message TEXT NULL, finished_at DATETIME NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, created_by BIGINT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
  for n,t in types.items():
   if n not in cols:ddl.append('ALTER TABLE pdd_product ADD COLUMN `'+n+'` '+t+' NULL')
  if mode=='apply':
   for sql in ddl:q.execute(sql)
  q.execute("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE FROM information_schema.columns WHERE TABLE_SCHEMA=%s AND TABLE_NAME IN ('pdd_product','pdd_product_sync_job')",(db,));after=q.fetchall()
  q.execute('SHOW GRANTS');grants=' '.join(str(x) for x in q.fetchall()).upper()
  permission={name:bool('ALL PRIVILEGES' in grants or name in grants) for name in ['CREATE','ALTER','SELECT']}
  print(json.dumps({'state':'completed' if mode=='apply' else 'validated','migration':'product-sync-v1','database':db,'planned_statements':ddl,'executed_count':len(ddl) if mode=='apply' else 0,'identity_privileges':permission,'schema':after,'destructive_operations':False},default=str))
  q.execute("SELECT RELEASE_LOCK('workspace_pdd_product_sync_v1')")
finally:c.close()
'''
def migration(mode,database=None):
    # Project credentials stay on the production host; never return raw failures.
    sys.path.insert(0,'/usr/local/libexec')
    import importlib.util
    spec=importlib.util.spec_from_file_location('pdd_reader','/usr/local/libexec/workspace-pdd-readonly.py');reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
    e=reader.env_values();request={'env':{k:e[k] for k in ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE']},'mode':mode}
    if database:request['database']=database
    r=subprocess.run(['/usr/sbin/runuser','-u','ubuntu','--',str(SOURCE/'.venv/bin/python'),'-I','-c',MIGRATION_PROGRAM],input=json.dumps(request),capture_output=True,text=True,timeout=90,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    if r.returncode:return {'state':'failed','error_code':'project_migration_validation_or_execution_failed','details_withheld':True}
    return json.loads(r.stdout)

def worker(job_id):
    p=STATE/'operations'/(job_id+'.json');job=json.loads(p.read_text())
    with (STATE/'project.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        job['state']='running';atomic_json(p,job)
        try:
            op=job['parameters']['operation'];args=job['parameters'];window()
            if op=='apply':out=apply_release(args)
            elif op=='migrate':
                before=migration('validate');atomic_json(STATE/'operations'/(job_id+'-schema-before.json'),before)
                out=migration('apply') if before.get('state')=='validated' else before
            elif op=='verify':
                with tempfile.TemporaryDirectory(prefix='provision-check-',dir=STATE/'backups') as t:
                    sample=pathlib.Path(t)/'probe.txt';sample.write_bytes(b'PDD isolated resource verification')
                    copy=pathlib.Path(t)/'backup.txt';shutil.copy2(sample,copy)
                    if sample.read_bytes()!=copy.read_bytes():raise RuntimeError('backup_io_failed')
                out={'state':'completed','verification':'isolated_staging_and_backup_io','production_changed':False,'migration_executed':False,'services_restarted':False}
            elif op=='rollback':
                backup=STATE/'backups'/args['release_id'];meta=restore(backup);out={'state':'completed','restored':args['release_id'],'health':restart(meta['services']),'database':'additive_changes_preserved'}
            else:raise ValueError('unsupported_effect')
        except Exception:out={'state':'failed','error_code':'production_effect_failed_query_original_operation','secrets_withheld':True}
        job.update(state=out['state'],result=out,finished_at=now());atomic_json(p,job)
def submit(b):
    key=b.get('idempotency_key')
    if not isinstance(key,str) or not 1<=len(key)<=200:raise ValueError('stable_idempotency_key_required')
    keyhash=digest(key.encode());index=STATE/'keys'/(keyhash+'.json');bodyhash=digest(json.dumps(b,sort_keys=True).encode())
    with (STATE/'submission.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if index.exists():
            old=json.loads(index.read_text())
            if old['request_sha256']!=bodyhash:raise ValueError('idempotency_payload_conflict')
            return public_job(json.loads((STATE/'operations'/(old['operation_id']+'.json')).read_text()))
        job_id=str(uuid.uuid4());job={'operation_id':job_id,'project_id':PROJECT,'state':'queued','parameters':b['parameters'],'origin':b.get('origin',{}),'created_at':now()}
        atomic_json(STATE/'operations'/(job_id+'.json'),job)
        atomic_json(index,{'operation_id':job_id,'request_sha256':bodyhash})
        subprocess.Popen(['/usr/bin/python3','-I',__file__,'--worker',job_id],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
        return public_job(job)
def public_job(job):return {k:v for k,v in job.items() if k!='parameters'}
def validate(b):
    if not isinstance(b,dict) or set(b)-{'action','parameters','idempotency_key','origin'}:raise ValueError('invalid_request')
    a,p=b.get('action'),b.get('parameters',{})
    if not isinstance(p,dict):raise ValueError('parameters_required')
    if a=='status':
        if p:raise ValueError('unexpected_status_parameters')
    elif a=='read':
        if p.get('kind') not in ['manifest','file','dependencies','migration_plan','plan','error_log']:raise ValueError('read_kind_required')
        if p['kind']=='file':source_path(p.get('path'))
        if p['kind']=='plan':release_path(p.get('release_id'))
    elif a=='command':
        if p.get('operation')!='upload_chunk':raise ValueError('no_shell_upload_only')
        release_path(p.get('release_id'))
        if not isinstance(p.get('data_base64'),str) or len(p['data_base64'])>45000 or type(p.get('offset'))is not int or not 0<=p['offset']<=24*1024*1024:raise ValueError('chunk_size_or_offset_limit')
    elif a=='service':
        if p.get('operation') not in ['apply','migrate','rollback','verify']:raise ValueError('release_effect_required')
        if p['operation']=='migrate' and p.get('migration')!='product-sync-v1':raise ValueError('approved_migration_only')
        if p['operation'] in ['apply','rollback']:release_path(p.get('release_id'))
        if p['operation']=='apply' and any(not isinstance(p.get(n),str) or not SHA.fullmatch(p[n]) for n in ['archive_sha256','plan_sha256']):raise ValueError('fixed_plan_hashes_required')
    elif a=='operation':
        if not isinstance(p.get('operation_id'),str) or str(uuid.UUID(p['operation_id']))!=p['operation_id']:raise ValueError('operation_id_required')
    else:raise ValueError('unsupported_action')
    return a,p
def execute(b):
    window();a,p=validate(b)
    if a=='status':return {'state':'ready','project_id':PROJECT,'source_root':str(SOURCE),'operations':['manifest','file','dependencies','upload_chunk','plan','apply','product-sync-v1','rollback','operation'],'expires_at':EXPIRY.isoformat(),'effects_async':True}
    if a=='operation':return public_job(json.loads((STATE/'operations'/(p['operation_id']+'.json')).read_text()))
    if a=='service':return submit(b)
    if a=='command':
        d=release_path(p['release_id']);f=d/'bundle.zip';raw=base64.b64decode(p['data_base64'],validate=True)
        if len(raw)>32768:raise ValueError('chunk_too_large')
        with (d/'upload.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            size=f.stat().st_size if f.exists() else 0;offset=p['offset']
            if size<offset:raise ValueError('contiguous_upload_required')
            if size>offset:
                with f.open('rb') as old:old.seek(offset);same=old.read(len(raw))==raw
                if not same:raise ValueError('upload_replay_mismatch')
            else:
                with f.open('ab') as out:out.write(raw);out.flush();os.fsync(out.fileno())
        return {'state':'staged','release_id':p['release_id'],'next_offset':offset+len(raw),'bytes_uploaded':f.stat().st_size,'chunk_sha256':digest(raw),'production_changed':False}
    kind=p['kind']
    if kind=='manifest':
        rows=inventory();offset=max(0,int(p.get('offset',0)));limit=max(1,min(int(p.get('limit',80)),100))
        return {'state':'read','manifest_sha256':digest(json.dumps(rows,sort_keys=True).encode()),'files':rows[offset:offset+limit],'total':len(rows),'next_offset':offset+limit if offset+limit<len(rows) else None}
    if kind=='file':
        f=source_path(p['path']);offset=max(0,int(p.get('offset',0)));raw=f.read_bytes();part=raw[offset:offset+16384]
        return {'state':'read','path':p['path'],'sha256':digest(raw),'size':len(raw),'bytes_base64':base64.b64encode(part).decode(),'next_offset':offset+len(part) if offset+len(part)<len(raw) else None}
    if kind=='dependencies':
        code='import importlib.metadata,json;print(json.dumps(sorted([{\"name\":x.metadata[\"Name\"],\"version\":x.version} for x in importlib.metadata.distributions()],key=lambda x:x[\"name\"])))'
        r=subprocess.run(['/usr/sbin/runuser','-u','ubuntu','--',str(SOURCE/'.venv/bin/python'),'-I','-c',code],capture_output=True,text=True,timeout=15)
        if r.returncode:raise RuntimeError('dependency_metadata_unavailable')
        return {'state':'read','python_distributions':json.loads(r.stdout)}
    if kind=='error_log':
        service=p.get('service','backend')
        if service not in SERVICES:raise ValueError('only_pdd_backend_websocket_services')
        lines=max(1,min(int(p.get('lines',100)),200))
        r=subprocess.run(['/usr/bin/journalctl','-u',SERVICES[service],'-n',str(lines),'--no-pager','-o','short-iso'],capture_output=True,text=True,timeout=8)
        events=[]
        for line in r.stdout.splitlines():
            timestamp=line.split(' ',1)[0]
            error=re.search(r'\b(TimeoutError|ConnectTimeout|ReadTimeout|HTTPStatusError|ConnectError|RuntimeError|RequestException|OperationalError|IntegrityError|TypeError|ValueError)\b',line)
            frame=re.search(r'File "(/opt/pdd-lab/source/(?:backend|common|websocket)/[^"\n]+\.py)", line (\d+)',line)
            http=re.search(r'"(GET|POST) (/api/(?:v1/)?[^? "\\]*(?:product|goods)[^? "\\]*)(?:\?[^ "\\]*)? HTTP/[0-9.]+" (\d{3})',line)
            if error:events.append({'timestamp':timestamp,'error_type':error[1],'message_withheld':True})
            elif frame:events.append({'timestamp':timestamp,'file':frame[1],'line':int(frame[2])})
            elif http:events.append({'timestamp':timestamp,'method':http[1],'path':http[2],'http_status':int(http[3])})
            elif 'ERROR' in line or 'Traceback' in line:events.append({'timestamp':timestamp,'event':'error_present','message_withheld':True})
        return {'state':'read','service':service,'scanned_lines':lines,'events':events,'coverage':'bounded_error_types_project_stack_frames_and_product_http_metadata;messages_bodies_queries_and_secrets_withheld'}
    if kind=='migration_plan':return migration('validate')
    return {'state':'planned',**inspect_bundle(p['release_id'],p.get('archive_sha256')),'production_changed':False}
def main():
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    for n in ['releases','backups','operations','keys']:(STATE/n).mkdir(exist_ok=True,mode=0o700)
    if len(sys.argv)==3 and sys.argv[1]=='--worker':worker(str(uuid.UUID(sys.argv[2])));return
    try:
        raw=os.environ.get('SSH_ORIGINAL_COMMAND','')
        if len(raw)>64000:raise ValueError('request_size_limit')
        out=execute(json.loads(raw))
    except PermissionError as e:out={'state':'denied','error_code':str(e)}
    except (ValueError,KeyError,TypeError) as e:out={'state':'failed','error_code':str(e) if re.fullmatch('[a-z_]+',str(e)) else 'invalid_release_input'}
    except Exception:out={'state':'failed','error_code':'project_release_dependency_unavailable','secret_error_details_withheld':True}
    out.update(project_id=PROJECT,observed_at=now());print(json.dumps(out,ensure_ascii=False))
if __name__=='__main__':main()
