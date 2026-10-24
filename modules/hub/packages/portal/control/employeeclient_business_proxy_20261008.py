from pathlib import Path
import hashlib,json,subprocess,shutil,os
p=Path('/etc/nginx/conf.d/employeeclient-jiaxin.conf');before=p.read_text();assert before.count('server_name service.example.invalid;')==2
block=''' location ^~ /business/v1/ {
  proxy_pass http://127.0.0.1:8936;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Cookie $http_cookie;
  proxy_set_header Origin $http_origin;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_cache off;
  proxy_buffering off;
  proxy_read_timeout 180s;
  add_header Cache-Control "no-store" always;
  access_log off;
 }
'''
backup=Path('/srv/workspace');backup.mkdir(parents=True,mode=0o700,exist_ok=True)
if 'location ^~ /business/v1/' in before:raise RuntimeError('already_changed_read_current_before_mutation')
assert before.count(' location ^~ /native/ {')==1
(backup/'employeeclient-jiaxin.conf.before').write_text(before);after=before.replace(' location ^~ /native/ {',block+' location ^~ /native/ {');p.write_text(after)
r=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if r.returncode:
 p.write_text(before);raise RuntimeError('nginx_test_failed_original_restored:'+r.stderr)
try:subprocess.run(['systemctl','reload','nginx'],check=True)
except:p.write_text(before);subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True);raise
print(json.dumps({'state':'published','path':str(p),'backup':str(backup/'employeeclient-jiaxin.conf.before'),'before_sha256':hashlib.sha256(before.encode()).hexdigest(),'after_sha256':hashlib.sha256(after.encode()).hexdigest(),'nginx_test':r.stderr.strip(),'reload':'completed'}))
