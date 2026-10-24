"""Fixed Baize background release receiver; never executes project code as root."""
import base64,datetime,fcntl,hashlib,json,os,pathlib,pwd,re,subprocess,time,urllib.request,uuid
PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42'
ACTOR='9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3'
COMPONENT='background-directory'
ROOT=pathlib.Path('/srv/workspace')
CONTINUOUS='baize-continuous.service'
DAILY='baize-worker-oneshot.service'
UNITS=(CONTINUOUS,DAILY)
TOKEN=pathlib.Path('/etc/workspace-hub2/baize-directory/worker-token.private')
LOCK=pathlib.Path('/opt/baize/runtime/temp/processing.lock')
PYTHON='/opt/baize/app/.venv/bin/python'
ENTRY='baize_background_entry.py'
def run(args,timeout=30):return subprocess.run(args,cwd='/opt/baize/app',text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
def active(unit):return run(['/usr/bin/systemctl','is-active',unit]).stdout.strip()
def switch(link,destination):
    next_path=link.with_name(link.name+'.next');next_path.unlink(missing_ok=True);next_path.symlink_to(destination);os.replace(next_path,link)
def read_api(token,path,body=None):
    request=urllib.request.Request('https://hufu.example.invalid/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='GET'if body is None else'POST')
    with urllib.request.urlopen(request,timeout=8)as response:
        raw=response.read(65537)
        if len(raw)>65536:raise RuntimeError('service_directory_response_too_large')
    return json.loads(raw)
def install_token(profile):
    if profile.get('actor_id')!=ACTOR:raise PermissionError('existing_baize_service_required')
    token=profile.get('token')
    if not isinstance(token,str)or not token.startswith('hub2_')or len(token)>512 or any(c.isspace()for c in token):raise ValueError('bare_fixed_service_credential_required')
    for name in ('client_id','credential_id'):uuid.UUID(profile[name])
    identity=read_api(token,'/v2/me')
    if identity.get('principal_kind')!='service'or identity.get('actor_id')!=ACTOR or identity.get('client_id')!=profile['client_id']or identity.get('credential_id')!=profile['credential_id']or identity.get('client_actions')!=['hufu.baize.members.read']:raise PermissionError('actual_directory_service_identity_required')
    directory=read_api(token,'/v2/applications/baize/members',{})
    if directory.get('project_id')!=PROJECT or directory.get('coverage')!='complete_active_members':raise PermissionError('actual_complete_service_directory_required')
    parent=TOKEN.parent
    if parent.exists()and(parent.is_symlink()or parent.stat().st_uid!=0 or parent.stat().st_mode&0o022):raise ValueError('root_owned_fixed_credential_parent_required')
    parent.mkdir(mode=0o755,exist_ok=True);os.chmod(parent,0o755)
    account=pwd.getpwnam('baize');temp=parent/'worker-token.private.next'
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'w')as handle:handle.write(token+'\n');handle.flush();os.fsync(handle.fileno())
        os.chown(temp,account.pw_uid,account.pw_gid);os.chmod(temp,0o600);os.replace(temp,TOKEN)
    finally:temp.unlink(missing_ok=True)
    return {'members':len(directory['members']),'coverage':directory['coverage'],'actor_id':ACTOR,'client_id':profile['client_id'],'credential_id':profile['credential_id'],'file_uid':account.pw_uid,'file_mode':'0600','token_logged':False}
def execute(request,identity):
    if os.geteuid()!=0 or request.get('project_id')!=PROJECT or identity.get('project_id')!=PROJECT:raise PermissionError('fixed_baize_project_required')
    parameters=request['parameters'];phase=parameters.get('phase')
    if parameters.get('component')!=COMPONENT or identity.get('application_release_component')!=COMPONENT or identity.get('application_release_phase')!=phase:raise PermissionError('fixed_background_component_permit_required')
    if datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):raise PermissionError('engineering_permit_expired')
    if phase=='status':return {'state':'read','component':COMPONENT,'services':{u:active(u)for u in UNITS},'daily_timer':active('baize-worker.timer'),'release':str((ROOT/'current').resolve())if(ROOT/'current').exists()else None}
    if phase=='logs':
        # Return dependency metadata only, never audio/transcript/log bodies.
        lines=run(['/usr/bin/journalctl','-u',CONTINUOUS,'-n','200','--no-pager','-o','cat']).stdout.splitlines()
        return {'state':'read','component':COMPONENT,'directory_read_lines':sum('Current native service directory read:'in l for l in lines),'legacy_login_410_lines':sum('login: unexpected_http_410'in l for l in lines),'scope':'last200_metadata_counts_only'}
    if phase!='deploy':raise ValueError('background_component_build_deploy_status_logs_only')
    artifact=parameters['artifact'];commit=artifact.get('commit','');files=artifact.get('files')
    if not re.fullmatch('[a-f0-9]{40}',commit)or artifact.get('project_id')!=PROJECT or not isinstance(files,dict)or ENTRY not in files or len(files)>50 or len(json.dumps(files).encode())>650000:raise ValueError('bounded_current_baize_artifact_required')
    for name,text in files.items():
        if not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*[.]py',name)or name in ('application_gate.py','native_identity_bridge.py','caller_context.py')or not isinstance(text,str):raise ValueError('plain_project_python_artifact_only')
    info=LOCK.lstat();account=pwd.getpwnam('baize')
    if LOCK.is_symlink()or not LOCK.is_file()or info.st_uid!=account.pw_uid:raise ValueError('existing_baize_pipeline_lock_required')
    lock_fd=os.open(LOCK,os.O_RDWR|os.O_NOFOLLOW)
    try:
        try:fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'exit_code':1,'error_code':'live_pipeline_busy','effect':'no_worker_service_stop_or_business_database_change;retry_after_actual_job_finishes','retained_directory_registration':{k:parameters['private_directory_credential'][k]for k in ('actor_id','client_id','credential_id')}}
        # With the ORIGINAL cross-process lock held, no paid job is interrupted
        # and meetings only waits normally; its service is never stopped.
        private=install_token(parameters['private_directory_credential'])
        digest=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest();release=ROOT/(commit[:12]+'-'+digest[:12]);ROOT.mkdir(parents=True,exist_ok=True)
        if ROOT.is_symlink()or ROOT.stat().st_uid!=0:raise ValueError('root_owned_fixed_release_parent_required')
        os.chmod(ROOT,0o755)
        if not release.exists():
            release.mkdir(mode=0o755)
            for name,text in files.items():(release/name).write_text(text);os.chmod(release/name,0o644)
            (release/'manifest.json').write_text(json.dumps({'project_id':PROJECT,'component':COMPONENT,'commit':commit,'actor_id':identity['actor_id'],'client_id':identity['client_id'],'sha256':digest}))
        os.chmod(release,0o755)
        current=ROOT/'current';prior=str(current.resolve())if current.exists()else None
        dropins={u:pathlib.Path('/etc/systemd/system')/(u+'.d')/'40-native-directory.conf'for u in UNITS}
        previous={str(p):p.read_text()if p.exists()else None for p in dropins.values()}
        checked=run(['/usr/sbin/runuser','-u','baize','--',PYTHON,str(release/ENTRY),'directory-check'])
        if checked.returncode:return {'exit_code':1,'error_code':'project_UID_directory_check_failed','effect':'no_worker_service_stop','directory_identity':private}
        probe=json.loads(checked.stdout)
        if probe.get('coverage')!='complete_active_members'or probe.get('members')!=private['members']:raise ValueError('project_UID_directory_count_mismatch')
        (ROOT/'previous-install.json').write_text(json.dumps({'release':prior,'dropins':previous}))
        stopped=run(['/usr/bin/systemctl','stop',CONTINUOUS])
        if stopped.returncode:raise RuntimeError('idle_continuous_stop_failed')
        try:
            if prior:switch(ROOT/'previous',prior)
            switch(current,release)
            for unit,path in dropins.items():
                path.parent.mkdir(exist_ok=True);mode='continuous'if unit==CONTINUOUS else'daily'
                path.write_text('[Service]\nExecStart=\nExecStart='+PYTHON+' '+str(current/ENTRY)+' '+mode+'\n')
            run(['/usr/bin/systemctl','daemon-reload'])
            started=run(['/usr/bin/systemctl','start',CONTINUOUS])
            if started.returncode or active(CONTINUOUS)!='active':raise RuntimeError('background_candidate_not_active')
        except Exception:
            for name,text in previous.items():
                path=pathlib.Path(name)
                if text is None:path.unlink(missing_ok=True)
                else:path.write_text(text)
            if prior:switch(current,prior)
            run(['/usr/bin/systemctl','daemon-reload']);run(['/usr/bin/systemctl','start',CONTINUOUS]);raise RuntimeError('background_candidate_failed_previous_config_restored')from None
        return {'exit_code':0,'component':COMPONENT,'commit':commit,'release':str(release),'services':{u:active(u)for u in UNITS},'ready':'current_service_directory_200;project_UID_directory_check;continuous_active','directory_identity':private,'daily_effect':'entry_updated_only;original_timer_retained;not_started','meetings_effect':'untouched','database_and_checkpoints':'retained;no_state_mutation_or_paid_test'}
    finally:os.close(lock_fd)
