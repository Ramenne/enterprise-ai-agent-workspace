"""Explicit supervisor deploy for the tools H3 component on the current hub node.
Only this service/route is changed; the legacy whole-tools profile stays separate.
Run as root on Jiaxin after committing the intended tools source paths.
"""
import io,json,os,pathlib,subprocess,tarfile,time,urllib.request
P=pathlib.Path
repo=P('/srv/workspace')
root=P('/srv/workspace')
def git(*args):
    return subprocess.check_output(['runuser','-u','hubeng-tools','--','git','-C',str(repo),*args])
if git('status','--porcelain').strip():raise RuntimeError('commit_current_source_before_deploy')
commit=git('rev-parse','HEAD').decode().strip()
paths=['src/tools_visual.py','src/visual_queue.py','src/visual-contract.json','src/visual_routing_policy.py','src/tools_krea2_loras.py','src/tools_minimax_audio.py','src/tools_krea2_cloud.py','src/tools_h3_cloud.py','src/tools_h3_server.py','src/requirements-h3-cloud.txt','deployment/h3-cloud']
archive=git('archive','HEAD',*paths)
release=root/'releases'/commit
release.mkdir(parents=True,exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive)) as package:
    package.extractall(release,filter='data')
python=root/'venv/bin/python'
subprocess.run(['runuser','-u','hubeng-tools','--',str(python),'-c',"import ast,pathlib,sys; [ast.parse(p.read_text(),filename=str(p)) for p in pathlib.Path(sys.argv[1]).glob('*.py')]",str(release/'src')],check=True)
subprocess.run(['runuser','-u','hubeng-tools','--',str(python),'-m','pip','check'],check=True)
subprocess.run(['runuser','-u','hubeng-tools','--','env','PYTHONDONTWRITEBYTECODE=1','PYTHONPATH='+str(release/'src'),str(python),'-m','unittest','discover','-s',str(release/'deployment/h3-cloud'),'-p','test_*.py'],check=True)
unit=P('/etc/systemd/system/hub2-tools-h3-cloud.service')
unit.write_bytes((release/'deployment/h3-cloud/h3-cloud.service').read_bytes())
previous=os.readlink(root/'current') if (root/'current').is_symlink() else None
if previous:
    temp=root/'previous.next';temp.unlink(missing_ok=True);temp.symlink_to(previous);temp.replace(root/'previous')
nextlink=root/'current.next';nextlink.unlink(missing_ok=True);nextlink.symlink_to(release);nextlink.replace(root/'current')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','hub2-tools-h3-cloud.service'],check=True)
subprocess.run(['systemctl','restart','hub2-tools-h3-cloud.service'],check=True)
for _ in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:18292/ready',timeout=2) as r:
            if r.status==200:break
    except OSError:time.sleep(.5)
else:raise RuntimeError('component_not_ready;public_route_not_changed')
route=P('/etc/nginx/hub2-ingress/h3-cloud.conf')
route.write_bytes((release/'deployment/h3-cloud/h3-cloud.nginx.conf').read_bytes())
vhost=P('/etc/nginx/conf.d/hufu-jiaxin.conf');original=vhost.read_text()
include=' include /etc/nginx/hub2-ingress/h3-cloud.conf;'
if include not in original:
    anchor=' include /etc/nginx/hub2-ingress/email-otp-gateway20261003.conf;'
    if original.count(anchor)!=1:raise RuntimeError('vhost_anchor_unexpected')
    backup=root/'hufu-vhost.before-h3.conf'
    if not backup.exists():backup.write_text(original)
    vhost.write_text(original.replace(anchor,anchor+'\n'+include))
try:subprocess.run(['nginx','-t'],check=True)
except Exception:
    vhost.write_text(original);raise
subprocess.run(['systemctl','reload','nginx'],check=True)
result={'state':'deployed','component':'tools-h3-cloud','source_commit':commit,'release':str(release),'service':'hub2-tools-h3-cloud.service','local_ready_http':200,'endpoint':'https://hufu.example.invalid/api/h3-cloud','deployment_method':'explicit_supervisor_SSH_component_release','old_engineering_deploy_operation':'54dcd652-fc04-491d-a296-b72062f65d57','old_operation_preserved':'failed','paid_generation_submitted':False,'previous':previous}
(root/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
