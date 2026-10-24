#!/usr/bin/python3
"""Fixed PDD production diagnostic reader; no arbitrary paths, SQL or shell."""
import datetime, hashlib, json, os, pathlib, re, shlex, subprocess, sys, uuid

ROOT = pathlib.Path('/opt/pdd-lab')
PROJECT = '2b6594cc-3866-4862-a4cf-a46ed0dbba61'
EXPIRY = datetime.datetime.fromisoformat('2026-10-28T23:59:59+08:00')
SERVICES = {n: 'pdd-lab-' + n + '.service' for n in ['backend', 'websocket', 'scheduler']}
DB_PROGRAM = r'''
import json,sys,pymysql
b=json.load(sys.stdin);e=b['env'];p=b['parameters'];kind=b['kind']
c=pymysql.connect(host=e['MYSQL_HOST'],port=int(e['MYSQL_PORT']),user=e['MYSQL_USER'],password=e['MYSQL_PASSWORD'],database=e['MYSQL_DATABASE'],cursorclass=pymysql.cursors.DictCursor,connect_timeout=4,read_timeout=4,write_timeout=4)
try:
 with c.cursor() as q:
  q.execute('SET SESSION TRANSACTION READ ONLY');q.execute('START TRANSACTION READ ONLY')
  if kind=='database':
   q.execute('SELECT DATABASE() AS database_name, CURRENT_USER() AS connection_identity, @@hostname AS database_host, @@port AS database_port, @@transaction_read_only AS transaction_read_only, VERSION() AS mysql_version');out=q.fetchone()
   q.execute("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('pdd_sys_user','pdd_sys_role') ORDER BY TABLE_NAME,ORDINAL_POSITION")
   out['identity_schema']=[x for x in q.fetchall() if x['COLUMN_NAME'] not in ['password_hash','password','email','qq','wechat']]
  else:
   q.execute('SELECT u.id,u.username,u.status,u.role_id,r.role_name,r.is_admin,r.status AS role_status FROM pdd_sys_user u LEFT JOIN pdd_sys_role r ON r.id=u.role_id WHERE u.username=%s LIMIT 1',(p['username'],))
   out={'username':p['username'],'accounts':q.fetchall()}
  c.rollback()
 print(json.dumps({'state':'read','kind':kind,'data':out,'read_only_transaction':True},ensure_ascii=False))
finally:c.close()
'''

def env_values():
    out = {}
    for line in (ROOT/'private/runtime.env').read_text().splitlines():
        if '=' not in line or line.startswith('#'): continue
        k,v = line.split('=',1)
        values = shlex.split(v)
        out[k] = values[0] if values else ''
    return out

def command(args, timeout=8):
    r = subprocess.run(args, capture_output=True, timeout=timeout, text=True,
                       env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
    return r.returncode, r.stdout

def validate(b):
    if not isinstance(b,dict) or set(b)-{'action','parameters'}: raise ValueError('invalid_input')
    a,p = b.get('action'),b.get('parameters',{})
    if not isinstance(p,dict): raise ValueError('invalid_parameters')
    if a == 'status':
        if p: raise ValueError('unexpected_parameters')
    elif a == 'logs':
        if set(p)-{'service','lines'} or p.get('service','backend') not in SERVICES: raise ValueError('invalid_service')
        if type(p.get('lines',40)) is not int or not 1<=p.get('lines',40)<=200: raise ValueError('invalid_lines')
    elif a == 'read':
        if set(p)-{'kind','username'} or p.get('kind') not in ['config','proxy','version','database','account']: raise ValueError('invalid_read_kind')
        if p['kind']=='account':
            if not isinstance(p.get('username'),str) or not re.fullmatch(r'[\w.@-]{1,64}',p['username']): raise ValueError('target_username_required')
        elif 'username' in p: raise ValueError('unexpected_username')
    else: raise PermissionError('read_only_action_required')
    return a,p

def execute(b):
    a,p = validate(b)
    if datetime.datetime.now(datetime.timezone.utc)>=EXPIRY: raise PermissionError('production_window_expired')
    if a=='status':
        out={}
        for name,unit in SERVICES.items():
            _,s=command(['/usr/bin/systemctl','show',unit,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ActiveEnterTimestamp'])
            out[name]=dict(l.split('=',1) for l in s.splitlines() if '=' in l)
        return {'state':'read','services':out,'host':'192.0.2.10','source_root':str(ROOT/'source'),'domain':'https://pdd.example.invalid/','backend':'127.0.0.1:8189','mysql_unit_active':command(['/usr/bin/systemctl','is-active','mysql.service'])[1].strip()=='active'}
    if a=='logs':
        unit=SERVICES[p.get('service','backend')]
        _,s=command(['/usr/bin/journalctl','-u',unit,'-n',str(p.get('lines',40)),'--no-pager','-o','short-iso'])
        events=[]
        for line in s.splitlines():
            match=re.search(r'"(GET|POST) (/api/(?:v1/)?(?:login|logout|auth(?:/[^? "\\]*)?))(?:\?[^ "\\]*)? HTTP/[0-9.]+" (\d{3})',line)
            if match: events.append({'timestamp':line.split(' ',1)[0],'method':match[1],'path':match[2],'http_status':int(match[3])})
            elif 'Traceback (most recent call last)' in line: events.append({'timestamp':line.split(' ',1)[0],'event':'traceback_present','details':'withheld'})
        return {'state':'read','service':p.get('service','backend'),'scanned_lines':p.get('lines',40),'events':events,'coverage':'bounded_login_http_events_and_traceback_presence;raw_lines_and_request_bodies_withheld'}
    kind=p['kind']
    if kind in ['database','account']:
        e=env_values()
        payload={'kind':kind,'parameters':p,'env':{k:e[k] for k in ['MYSQL_HOST','MYSQL_PORT','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD']}}
        r=subprocess.run(['/usr/sbin/runuser','-u','ubuntu','--',str(ROOT/'source/.venv/bin/python'),'-I','-c',DB_PROGRAM],input=json.dumps(payload),capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
        if r.returncode: return {'state':'failed','error_code':'production_mysql_query_failed','secret_error_details_withheld':True}
        return json.loads(r.stdout)
    if kind=='config':
        e=env_values()
        return {'state':'read','environment_variable_names':sorted(e),'database':{k:e.get(k) for k in ['MYSQL_HOST','MYSQL_PORT','MYSQL_DATABASE','MYSQL_USER']},'service_config':{k:e.get(k) for k in ['ENVIRONMENT','BACKEND_WEB_HOST','BACKEND_WEB_PORT','WEBSOCKET_HOST','WEBSOCKET_PORT','SCHEDULER_HOST','SCHEDULER_PORT']},'secret_values_included':False}
    if kind=='proxy':
        text=pathlib.Path('/etc/nginx/sites-enabled/pdd-lab').read_text()
        return {'state':'read','config_path':'/etc/nginx/sites-enabled/pdd-lab','directives':[s.strip() for s in text.splitlines() if re.match(r'\s*(server_name|root |proxy_pass|listen |location )',s)],'config_sha256':hashlib.sha256(text.encode()).hexdigest()}
    files=['backend/app/services/auth_service.py','common/core/config.py','frontend/dist/index.html']
    return {'state':'read','files':[{'path':name,'sha256':hashlib.sha256((ROOT/'source'/name).read_bytes()).hexdigest()} for name in files if (ROOT/'source'/name).is_file()],'source_root':str(ROOT/'source'),'claim':'live_file_hashes;not_a_git_commit_or_deployed_build_claim'}

def main():
    receipt=str(uuid.uuid4())
    try:
        raw=os.environ.get('SSH_ORIGINAL_COMMAND','')
        if len(raw)>4096: raise ValueError('size_limit')
        b=json.loads(raw);result=execute(b)
    except PermissionError as e: result={'state':'denied','error_code':str(e)}
    except (ValueError,TypeError,KeyError): result={'state':'failed','error_code':'invalid_diagnostic_input'}
    except Exception: result={'state':'failed','error_code':'diagnostic_dependency_unavailable','secret_error_details_withheld':True}
    result.update(receipt_id=receipt,project_id=PROJECT,observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),expires_at=EXPIRY.isoformat())
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
