#!/usr/bin/env python3
"""Install only a fresh independent 2.0 executor and harmless demo unit. Registry authority is operator work."""
import argparse, hashlib, json, os, pathlib, pwd, re, shutil, subprocess, sys
from resource_executor import canonical, root_fingerprint

FILES=('resource_executor.py','resource_barrier.py','daemon.py','forced_command.py','demo_service.py')
def run(args):subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
def install(spec,apply=False,start=False):
    required={'account','prefix','state','configuration','endpoint_id','project_id','area_id','environment','service_key_source','authority_url','daemon_port','demo_port','unit_prefix'}
    if set(spec)!=required:raise ValueError('exact_installer_spec_required')
    account=spec['account'];unit=spec['unit_prefix']
    if not re.fullmatch('h2r[a-z0-9]{5,20}',account) or not re.fullmatch('hub2-resource-[a-z0-9-]{3,40}',unit):raise ValueError('independent_names_required')
    for name in ('endpoint_id','project_id','area_id'):
        if not re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}',spec[name]):raise ValueError('uuid_required')
    for name in ('prefix','state','configuration'):
        value=spec[name]
        if not isinstance(value,str) or not value.startswith('/') or os.path.normpath(value)!=value or not re.fullmatch('/[A-Za-z0-9_./-]+',value):raise ValueError('canonical_install_path_required')
        if pathlib.Path(value).exists():raise ValueError('fresh_owned_install_destination_required')
    if not re.fullmatch('[A-Za-z0-9_-]{1,80}',spec['environment']):raise ValueError('fixed_environment_required')
    if any(not isinstance(spec[k],int) or not 1024<=spec[k]<=65535 for k in ('daemon_port','demo_port')) or spec['daemon_port']==spec['demo_port']:raise ValueError('independent_high_ports_required')
    source=pathlib.Path(__file__).resolve().parent
    metadata=dict(state='prepared',endpoint_id=spec['endpoint_id'],project_id=spec['project_id'],area_id=spec['area_id'],environment=spec['environment'],operations=['read','write','deploy'],actions=['resource.read','resource.write','resource.deploy'],required_qualification_kind='work',resource_selector={'version':1,'kind':'set','areas':[spec['area_id']]},daemon_port=spec['daemon_port'],demo_port=spec['demo_port'],file_limit_bytes=2*1024*1024,installed_source_sha256={name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in FILES})
    if not apply:return metadata
    if os.geteuid()!=0:raise ValueError('installer_operator_root_required')
    try:pwd.getpwnam(account);raise ValueError('existing_account_forbidden')
    except KeyError:pass
    prefix=pathlib.Path(spec['prefix']);state=pathlib.Path(spec['state']);configuration=pathlib.Path(spec['configuration']);units=[pathlib.Path('/etc/systemd/system')/(unit+'-'+role+'.service') for role in ('executor','demo')]
    if any(p.exists() for p in units):raise ValueError('existing_unit_forbidden')
    secretfd=os.open(spec['service_key_source'],os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(secretfd) as stream:
        info=os.fstat(stream.fileno())
        if info.st_uid!=0 or info.st_mode&0o077 or info.st_size>65536:raise ValueError('protected_operator_key_required')
        key=stream.read().strip()
    if len(key)<32:raise ValueError('machine_key_required')
    # All destinations must be fresh; never change an existing service account, unit or area.
    run(['useradd','--system','--no-create-home','--home-dir',str(state),'--shell','/usr/sbin/nologin',account]);person=pwd.getpwnam(account)
    for path in (prefix,state,configuration):path.mkdir(mode=0o755,parents=True);path.chmod(0o755)
    for name in FILES:shutil.copyfile(source/name,prefix/name);os.chmod(prefix/name,0o644)
    for name in ('region','journal','runtime'):
        path=state/name;path.mkdir(mode=0o700);os.chown(path,person.pw_uid,person.pw_gid)
    keyfile=configuration/'machine-check-key';keyfile.write_text(key+'\n');os.chown(keyfile,0,person.pw_gid);keyfile.chmod(0o640)
    root=str(state/'region');fingerprint=root_fingerprint(root);python=os.path.realpath(sys.executable)
    runner=[python,str(prefix/'demo_service.py'),'apply','--root',root,'--runtime',str(state/'runtime'),'--environment',spec['environment'],'--port',str(spec['demo_port'])]
    area=dict(root=root,project_id=spec['project_id'],epoch=1,target_epoch=1,endpoint_epoch=1,environment=spec['environment'],root_fingerprint=fingerprint,runner=dict(id=unit+'-demo',argv=runner,idempotent=True,timeout_seconds=5))
    config=dict(areas={spec['area_id']:area},journal=str(state/'journal'),endpoint_id=spec['endpoint_id'],authority_url=spec['authority_url'],service_key_file=str(keyfile))
    configpath=configuration/'executor.json';configpath.write_text(json.dumps(config,indent=2));os.chown(configpath,0,person.pw_gid);configpath.chmod(0o640)
    commands=[[python,str(prefix/'daemon.py'),'--config',str(configpath),'--port',str(spec['daemon_port'])],[python,str(prefix/'demo_service.py'),'serve','--root',root,'--runtime',str(state/'runtime'),'--environment',spec['environment'],'--port',str(spec['demo_port'])]]
    for path,argv in zip(units,commands):
        path.write_text('[Unit]\nDescription=Original Hub2 2.0 independent resource '+path.stem+'\nAfter=network.target\n[Service]\nType=simple\nUser='+account+'\nGroup='+account+'\nExecStart='+ ' '.join(argv)+'\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths='+str(state)+'\nKillMode=control-group\nTimeoutStopSec=10\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n');path.chmod(0o644)
    metadata.update(state='installed',account=account,uid=person.pw_uid,registered_root=root,root_fingerprint=fingerprint,area_epoch=1,target_epoch=1,endpoint_epoch=1,units=[p.name for p in units],configuration=str(configpath),journal=str(state/'journal'),runner_id=area['runner']['id'],formal_registry_applied=False,current_member_authority_granted=False,hufu_machine_key_binding_required=True,daemon_url='http://127.0.0.1:'+str(spec['daemon_port'])+'/execute')
    (configuration/'installation.json').write_text(json.dumps(metadata,indent=2));(configuration/'installation.json').chmod(0o644)
    run(['systemctl','daemon-reload'])
    if start:
        run(['systemctl','enable','--now',*[p.name for p in units]]);metadata['units_started']=True
    return metadata

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--spec',required=True);parser.add_argument('--apply',action='store_true');parser.add_argument('--start',action='store_true');args=parser.parse_args()
    if args.start and not args.apply:raise ValueError('start_requires_apply')
    with open(args.spec) as stream:spec=json.load(stream)
    print(json.dumps(install(spec,args.apply,args.start),ensure_ascii=False,indent=2))
