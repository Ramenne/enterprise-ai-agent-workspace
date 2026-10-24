#!/usr/bin/env python3
"""Original 2.0 physical reader. Exact admitted COS objects, RAM-only 15m STS.
The member-facing Mem service performs current qualification/Source checks.
No old application, MCP or bucket listing. Tier capabilities use exact source/version and operation-owned targets; issuer keys never leave this process.
"""
import os,json,time,hmac,hashlib,datetime,urllib.request,urllib.parse,urllib.error
import pathlib,socket,struct,threading,socketserver,http.server,sys,re

BASE=pathlib.Path('/var/lib/hub2-legacy-source770')
SOCKET='/run/hub2-legacy-source770/reader.sock'
BUCKET='mengstore-1316920087'; REGION='ap-shanghai'; APPID='1316920087'
class SourceError(Exception):
 def __init__(self,code,status=503):self.code,self.status=code,status
def issuer():
 d=json.loads(pathlib.Path('/etc/workspace-hub2/legacy-source770/issuer.private.json').read_text())
 if not d.get('secret_id') or not d.get('secret_key'):raise SourceError('source_issuer_unavailable')
 return d
def issue(key):
 policy={'version':'2.0','statement':[{'effect':'allow','action':['name/cos:GetObject'],'resource':[f'qcs::cos:{REGION}:uid/{APPID}:{BUCKET}/{key}']}]}
 return federation(policy,'hub2-exact-legacy-read')
def federation(policy,name):
 c=issuer()
 body=json.dumps({'Name':name,'DurationSeconds':900,'Policy':json.dumps(policy,separators=(',',':'))},separators=(',',':'))
 host='sts.tencentcloudapi.com';ts=int(time.time());date=datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).strftime('%Y-%m-%d');scope=date+'/sts/tc3_request'
 sha=lambda s:hashlib.sha256(s.encode()).hexdigest();hm=lambda k,s:hmac.new(k,s.encode(),hashlib.sha256).digest()
 canonical='POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:'+host+'\n\ncontent-type;host\n'+sha(body)
 signing=hm(hm(hm(('TC3'+c['secret_key']).encode(),date),'sts'),'tc3_request')
 signature=hmac.new(signing,('TC3-HMAC-SHA256\n'+str(ts)+'\n'+scope+'\n'+sha(canonical)).encode(),hashlib.sha256).hexdigest()
 headers={'Content-Type':'application/json; charset=utf-8','Authorization':'TC3-HMAC-SHA256 Credential='+c['secret_id']+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature,'X-TC-Action':'GetFederationToken','X-TC-Version':'2018-08-13','X-TC-Timestamp':str(ts),'X-TC-Region':REGION}
 with urllib.request.urlopen(urllib.request.Request('https://'+host+'/',data=body.encode(),headers=headers),timeout=15) as response:d=json.loads(response.read())['Response']
 if d.get('Error'):raise SourceError('source_temporary_credential_unavailable')
 v=d['Credentials'];return {'secret_id':v['TmpSecretId'],'secret_key':v['TmpSecretKey'],'session_token':v['Token'],'expires':d['ExpiredTime']}
cache={};cache_lock=threading.Lock()
def temporary(key):
 with cache_lock:
  c=cache.get(key)
  if not c or c['expires']<=time.time()+30:c=issue(key);cache[key]=c
  for k in list(cache):
   if cache[k]['expires']<=time.time():cache.pop(k,None)
  return c
def cos_request(method,key,version=None,temporary_key=True):
 c=temporary(key) if temporary_key else issuer();host=f'{BUCKET}.cos.{REGION}.myqcloud.com'
 path='/'+urllib.parse.quote(key,safe='/');params={'versionId':version} if version else {}
 query='&'.join(urllib.parse.quote(k.lower(),safe='')+'='+urllib.parse.quote(v,safe='') for k,v in sorted(params.items()))
 kt=str(int(time.time())-30)+';'+str(min(int(time.time())+240,int(c.get('expires',time.time()+300))))
 sk=hmac.new(c['secret_key'].encode(),kt.encode(),hashlib.sha1).hexdigest()
 canonical=method.lower()+'\n'+path+'\n'+query+'\nhost='+urllib.parse.quote(host,safe='')+'\n'
 sig=hmac.new(sk.encode(),('sha1\n'+kt+'\n'+hashlib.sha1(canonical.encode()).hexdigest()+'\n').encode(),hashlib.sha1).hexdigest()
 auth='q-sign-algorithm=sha1&q-ak='+c['secret_id']+'&q-sign-time='+kt+'&q-key-time='+kt+'&q-header-list=host&q-url-param-list='+('versionid' if version else '')+'&q-signature='+sig
 headers={'Host':host,'Authorization':auth}
 if c.get('session_token'):headers['x-cos-security-token']=c['session_token']
 url='https://'+host+path+('?' + urllib.parse.urlencode(params) if params else '')
 try:return urllib.request.urlopen(urllib.request.Request(url,headers=headers,method=method),timeout=30)
 except urllib.error.HTTPError as e:
  raw=e.read(4096)
  if e.code==403 and b'InvalidObjectState' in raw:raise SourceError('restore_required',409)
  if e.code==404:raise SourceError('source_fixed_object_unavailable',503)
  raise SourceError('source_provider_refused',503)
def admit_rows():
 return json.loads((BASE/'admitted.json').read_text())
ARCHIVE_PREFIX='hub2-archive/'
UUID_PATTERN=r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
def tier_policy(b):
 if set(b)-{'locator','operation','operation_id','reconcile_target'}:raise SourceError('invalid_tier_scope',400)
 loc=b.get('locator',{})
 if not isinstance(loc,dict):raise SourceError('invalid_tier_scope',400)
 op=b.get('operation');key=loc.get('key');version=loc.get('version_id')
 if not isinstance(loc,dict) or loc.get('provider')!='cos-legacy-shanghai' or loc.get('bucket')!=BUCKET or not isinstance(key,str) or not isinstance(version,str) or version in ('','null','undefined') or op not in ('head','read','copy','restore','retire_hot'):raise SourceError('invalid_tier_scope',400)
 managed=re.fullmatch(re.escape(ARCHIVE_PREFIX)+UUID_PATTERN,key) is not None
 if not managed and not any(x['bucket']==BUCKET and x['key']==key and x['versionId']==version for x in admit_rows()):raise SourceError('source_object_not_admitted',403)
 base=f'qcs::cos:{REGION}:uid/{APPID}:{BUCKET}/'
 statement=[]
 def rule(actions,target,exact=False):
  row={'effect':'allow','action':['name/cos:'+x for x in actions],'resource':[base+target]}
  if exact:row['condition']={'string_equal':{'cos:versionid':version}}
  statement.append(row)
 if op=='copy' or b.get('reconcile_target'):
  operation_id=b.get('operation_id','')
  if not isinstance(operation_id,str) or not re.fullmatch(UUID_PATTERN,operation_id):raise SourceError('invalid_tier_operation',400)
  destination=ARCHIVE_PREFIX+operation_id
  if destination==key:raise SourceError('invalid_tier_operation',400)
  if op=='copy':
   rule(['GetObject','GetObjectVersion','HeadObject'],key)
   rule(['PutObject','PutObjectCopy','GetObject','HeadObject'],destination)
  elif op=='head':rule(['GetObject','HeadObject'],destination)
  else:raise SourceError('invalid_tier_scope',400)
 elif op in ('head','read'):rule(['GetObject','GetObjectVersion','HeadObject'],key,True)
 elif op=='restore':rule(['PostObjectRestore'],key,True)
 elif op=='retire_hot':rule(['DeleteObject'],key,True)
 prefix=key.rsplit('/',1)[0]+'/' if '/' in key else ''
 return {'version':'2.0','statement':statement},{'provider':'cos','scope_verified':True,'bucket':BUCKET,'region':REGION,'source_prefixes':[prefix] if prefix else [],'archive_prefix':ARCHIVE_PREFIX,'actions':[op],'verify_source_bytes':not managed}
tier_cache={};tier_locks={}
def tier_session(b):
 policy,bag=tier_policy(b);cache_key=hashlib.sha256(json.dumps(policy,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 with cache_lock:
  for old in list(tier_locks):
   if old!=cache_key and not tier_locks[old].locked() and (tier_cache.get(old,{}).get('expires',0)<=time.time() or len(tier_locks)>=512):
    tier_cache.pop(old,None);tier_locks.pop(old,None)
  lock=tier_locks.setdefault(cache_key,threading.Lock())
 with lock:
  c=tier_cache.get(cache_key)
  if not c or c['expires']<=time.time()+30:
   c=federation(policy,'hub2-fixed-legacy-tier');tier_cache[cache_key]=c
 return dict(bag,access_key_id=c['secret_id'],secret_access_key=c['secret_key'],session_token=c['session_token'],valid_until=datetime.datetime.fromtimestamp(c['expires'],datetime.timezone.utc).isoformat())

class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def error(self,code,status=503):
  b=json.dumps({'error_code':code}).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.send_header('Connection','close');self.end_headers();self.wfile.write(b)
 def do_POST(self):
  self.stream_started=False
  try:
   pid,uid,gid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
   if uid not in (0,int(os.environ['MEM_UID'])):raise SourceError('source_peer_refused',403)
   length=int(self.headers.get('Content-Length','0'))
   if not 1<=length<=8192:raise SourceError('invalid_source_request',400)
   b=json.loads(self.rfile.read(length))
   if self.path=='/tier-session':
    out=json.dumps(tier_session(b)).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(out)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(out);return
   if self.path=='/head' and uid==0 and set(b)=={'bucket','key'}:
    row=next((x for x in admit_rows() if x['bucket']==b['bucket'] and x['key']==b['key']),None)
    if not row or b['bucket']!=BUCKET:raise SourceError('source_object_not_admitted',403)
    with cos_request('HEAD',row['key'],temporary_key=False) as response:
     version=response.headers.get('x-cos-version-id');size=int(response.headers.get('Content-Length','-1'))
     if not version or version in ('null','undefined') or size!=row['size']:raise SourceError('source_fixed_head_mismatch')
     out=json.dumps({'bucket':BUCKET,'key':row['key'],'versionId':version,'size':size,'state':'provider_head_observed','whole_byte_verification':'on_read_before_member_delivery'}).encode()
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(out)));self.end_headers();self.wfile.write(out);return
   if self.path!='/read' or set(b)!= {'bucket','key','versionId'}:raise SourceError('invalid_source_request',400)
   row=next((x for x in admit_rows() if x['bucket']==b['bucket'] and x['key']==b['key'] and x['versionId']==b['versionId']),None)
   if not row or b['bucket']!=BUCKET or not b['versionId']:raise SourceError('source_object_not_admitted',403)
   with cos_request('GET',row['key'],row['versionId']) as response:
    if response.headers.get('x-cos-version-id')!=row['versionId'] or int(response.headers.get('Content-Length','-1'))!=row['size']:raise SourceError('source_locator_mismatch')
    self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(row['size']));self.send_header('Connection','close');self.end_headers();self.stream_started=True
    size=0;h=hashlib.sha256()
    while True:
     part=response.read(65536)
     if not part:break
     size+=len(part)
     if size>row['size']:raise SourceError('source_integrity_mismatch')
     h.update(part);self.wfile.write(part)
    if size!=row['size'] or h.hexdigest()!=row['sha256']:raise SourceError('source_integrity_mismatch')
   print(json.dumps({'event':'source_fixed_read','provider':'COS','region':REGION,'bytes':size,'fixed_version_verified':True,'whole_sha_verified':True,'STS_scope':'one_exact_key_GetObject','member_understanding':'not_inferred'}),flush=True)
  except SourceError as e:
   # A byte stream can fail after headers; Mem verifies all bytes before member delivery.
   try:
    if self.stream_started:self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR)
    else:self.error(e.code,e.status)
   except:pass
  except (BrokenPipeError,ConnectionResetError):pass
  except Exception:
   try:
    if self.stream_started:self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR)
    else:self.error('source_reader_unavailable')
   except:pass
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
if __name__=='__main__':
 os.umask(0o007)
 if os.path.exists(SOCKET):os.unlink(SOCKET)
 server=Server(SOCKET,Handler);os.chown(SOCKET,-1,int(os.environ['MEM_GID']));os.chmod(SOCKET,0o660)
 print(json.dumps({'state':'ready','source_bucket':BUCKET,'read_only_original_interface':True,'scoped_tier_capabilities':True,'exact_admission':True}),flush=True);server.serve_forever()
