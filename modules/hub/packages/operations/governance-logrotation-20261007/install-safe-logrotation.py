#!/usr/bin/env python3
"""Install scoped log rotation; preserve 14-day file audit history and durable effects.
No secret-bearing file content is printed. No recovery/database directories are touched.
"""
from pathlib import Path
import fcntl, fnmatch, gzip, json, os, re, ssl, subprocess, sys, time, urllib.request, urllib.error
SOURCE = Path(__file__).resolve().parent
STATE = Path('/srv/workspace')
LOGS = ['/var/log/messages', '/var/log/secure', '/var/log/cron', '/var/log/workspace-hub2/bao/audit.jsonl']
CONFIGS = {'system-logs.conf':'/etc/logrotate.d/workspace-governance-system', 'bao-audit.conf':'/etc/logrotate.d/workspace-governance-bao', 'journald.conf':'/etc/systemd/journald.conf.d/workspace-governance.conf'}

def command(args, timeout=45):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if p.returncode: raise RuntimeError('command_failed:' + args[0] + ':' + p.stderr[-600:])
    return p.stdout.strip()
def unit(name):
    s=command(['systemctl','show',name,'-p','ActiveState','-p','MainPID'])
    return dict(x.split('=',1) for x in s.splitlines() if '=' in x)
def meta(path):
    p=Path(path)
    if not p.exists(): return None
    s=p.stat();return {'path':str(p),'bytes':s.st_size,'inode':s.st_ino,'uid':s.st_uid,'gid':s.st_gid,'mtime':s.st_mtime}
def snapshot():
    v=os.statvfs('/');return {'observed_at':command(['date','-Is']),'disk_available':v.f_bavail*v.f_frsize,'units':{n:unit(n)for n in ['hub2-bao.service','rsyslog.service','systemd-journald.service']},'logs':[meta(x)for x in LOGS],'journal_usage':command(['journalctl','--disk-usage'])}
def bao_support():
    u=unit('hub2-bao.service');assert u['ActiveState']=='active'
    pid=u['MainPID'];exe=os.readlink('/proc/'+pid+'/exe');version=command([exe,'version'])
    assert Path(exe).name=='bao' and 'OpenBao v2.7.' in version,'unverified_bao_executable_version'
    status=Path('/proc/'+pid+'/status').read_text();caught=int(re.search(r'^SigCgt:\s+(\w+)',status,re.M).group(1),16)
    assert caught&1,'HUP_not_caught'
    current=Path(LOGS[-1]).stat().st_ino
    fds=[str(f)for f in Path('/proc/'+pid+'/fd').iterdir()if f.is_symlink()and f.stat().st_ino==current]
    assert fds,'actual_Bao_does_not_hold_audit_file'
    return {'pid':pid,'executable':exe,'version':version,'hup_caught':True,'file_audit_fd_count':len(fds),'support_basis':'OpenBao v2.7 file-audit documented SIGHUP close/reopen; matched actual executable and fd'}
def open_inode(pid,inode):
    for f in Path('/proc/'+pid+'/fd').iterdir():
        try:
            if f.is_symlink() and f.stat().st_ino==inode:return True
        except OSError:pass
    return False

def finish_observation(result):
    assert unit('hub2-bao.service')['MainPID']==result['bao_support']['pid'],'Bao_PID_changed'
    audit=Path(LOGS[-1]);result['audit_fd_reopened']=open_inode(result['bao_support']['pid'],audit.stat().st_ino)
    assert result['audit_fd_reopened']
    # The actual Bao listener is TLS. Trust its public certificate; retain hostname validation.
    context=ssl.create_default_context(cafile='/etc/workspace-hub2/bao/tls.crt')
    start=audit.stat().st_size
    try:
        with urllib.request.urlopen('https://127.0.0.1:8200/v1/sys/audit',context=context,timeout=5)as response:probe=response.status
    except urllib.error.HTTPError as e:probe=e.code
    for _ in range(20):
        if audit.stat().st_size>start:break
        time.sleep(.1)
    result['audit_append_probe']={'unauthenticated_read_http':probe,'before_bytes':start,'after_bytes':audit.stat().st_size,'appended':audit.stat().st_size>start,'secret_content_returned':False}
    assert result['audit_append_probe']['appended'],'audit_append_not_observed'
    with urllib.request.urlopen('https://127.0.0.1:8200/v1/sys/health?standbyok=true',context=context,timeout=5)as response:
        health=json.loads(response.read());result['bao_health']={'http':response.status,'initialized':health.get('initialized'),'sealed':health.get('sealed'),'standby':health.get('standby'),'tls_chain_and_hostname_verified':True}
    assert result['bao_health']['initialized']and not result['bao_health']['sealed']
    result['effective_journal_config']=command(['systemd-analyze','cat-config','systemd/journald.conf'])[-1000:]
    result['after']=snapshot();result['available_delta']=result['after']['disk_available']-result['before']['disk_available'];result['observations_complete']=True

STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
with open(STATE/'lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    receipt=STATE/'receipt.json'
    if receipt.exists():
        previous=json.loads(receipt.read_text())
        if '--observe-existing' in sys.argv and previous.get('phase')=='rotation_completed':
            finish_observation(previous);previous['phase']='completed';previous['recovery']='original_effects_retained;HTTPS_observation_only_no_new_rotation_or_HUP'
            temporary=STATE/'receipt.tmp';temporary.write_text(json.dumps(previous,indent=2));temporary.chmod(0o600);temporary.replace(receipt);print(json.dumps(previous));raise SystemExit(0)
        print(json.dumps({'state':'existing_operation','phase':previous.get('phase'),'receipt':str(receipt),'next_step':'read_original_receipt_before_any_new_rotation'}));raise SystemExit(0)
    result={'phase':'preparing','before':snapshot(),'bao_support':bao_support(),'policy':{'file_logs_retain_days':14,'rotation_count_limit':None,'journal_max_bytes':'2G','journal_keep_free':'8G','journal_max_age':'14day','size_vacuum':False},'configs':{},'compressed':[]}
    def save():
        temp=STATE/'receipt.tmp';temp.write_text(json.dumps(result,indent=2));temp.chmod(0o600);temp.replace(receipt)
    save()
    # A duplicate existing wildcard is also prohibited; exclude only our own exact target rules.
    for f in Path('/etc/logrotate.d').iterdir():
        if not f.is_file()or str(f)in CONFIGS.values():continue
        for line in f.read_text().splitlines():
            if line.lstrip().startswith('#'):continue
            for pattern in re.findall(r'/var/[^\s{}]+',line):
                assert not any(fnmatch.fnmatch(x,pattern)for x in LOGS),'duplicate_logrotate_target:'+str(f)
    for src,destination in CONFIGS.items():
        dest=Path(destination);dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists():
            backup=STATE/(src+'.before');backup.write_bytes(dest.read_bytes());backup.chmod(0o600)
        temp=dest.with_name('.'+dest.name+'.governance-new');temp.write_bytes((SOURCE/src).read_bytes());temp.chmod(0o644);temp.replace(dest)
        result['configs'][str(dest)]={'installed':True,'source':src}
    # Whole configured catalog detects duplicate rules without rotating anything.
    command(['logrotate','-d','-s','/dev/null','/etc/logrotate.conf'])
    result['phase']='configs_installed';save()
    # The actual Bao file-audit process was verified before enabling this supported signal.
    assert unit('hub2-bao.service')['MainPID']==result['bao_support']['pid'],'Bao_changed_during_preflight'
    result['phase']='rotation_dispatching';save()
    command(['logrotate','-f','-s',str(STATE/'logrotate.state'),CONFIGS['system-logs.conf'],CONFIGS['bao-audit.conf']])
    command(['systemctl','restart','systemd-journald.service'])
    command(['journalctl','--rotate'])
    result['journal_vacuum']=command(['journalctl','--vacuum-time=14d'])
    result['phase']='rotation_completed';save()
    assert unit('hub2-bao.service')['MainPID']==result['bao_support']['pid'],'Bao_PID_changed_after_HUP'
    for u in ['hub2-bao.service','rsyslog.service','systemd-journald.service']:assert unit(u)['ActiveState']=='active',u+'_not_active'
    # Wait briefly for file audit and syslog writers to close the renamed inode before compression.
    for old in result['before']['logs']:
        if old is None:continue
        name=Path(old['path']);writer='hub2-bao.service'if old['path']==LOGS[-1]else'rsyslog.service';pid=unit(writer)['MainPID']
        for _ in range(40):
            if not open_inode(pid,old['inode']):break
            time.sleep(.1)
        assert not open_inode(pid,old['inode']),'old_rotated_file_still_open'
        choices=[x for x in name.parent.glob(name.name+'-*')if x.is_file()and x.stat().st_ino==old['inode']]
        assert len(choices)==1,'renamed_inode_not_unique'
        rotated=choices[0]
        command(['gzip','-1','-k','--',str(rotated)])
        zipped=Path(str(rotated)+'.gz');command(['gzip','-t',str(zipped)])
        # Same bytes remain in the validated compressed log; no retained event is discarded.
        rotated.unlink();result['compressed'].append({'original_path':old['path'],'rotated_gzip':str(zipped),'uncompressed_bytes':old['bytes'],'gzip_bytes':zipped.stat().st_size,'gzip_crc_verified':True});save()
    finish_observation(result)
    result['phase']='completed';save();print(json.dumps(result))
