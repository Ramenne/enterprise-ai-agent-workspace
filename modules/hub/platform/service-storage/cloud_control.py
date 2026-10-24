"""Controlled Tencent API/COS client. Responses stay in memory; no secret logging."""
import datetime, hashlib, hmac, json, pathlib, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

PRIVATE = pathlib.Path('/Users/developer/.local/share/workspace-hub2-runtime')

def account():
    value=json.loads((PRIVATE/'cos-account.private.json').read_text())
    if not value.get('SecretId') or not value.get('SecretKey'):
        raise RuntimeError('Controlled COS account file is incomplete')
    return value

def safe_error(value, credentials):
    text=str(value)
    for key in ['SecretId','SecretKey','Token','SessionToken']:
        if credentials.get(key):text=text.replace(credentials[key],'[redacted]')
    return text[:1200]

def request(url, method='GET', headers=None, data=None):
    req=urllib.request.Request(url,data=data,headers=headers or {},method=method)
    try:
        with urllib.request.urlopen(req,timeout=45) as r:
            return r.status,dict(r.headers),r.read()
    except urllib.error.HTTPError as e:
        return e.code,dict(e.headers),e.read()

def api(credentials, service, action, payload, version, region=None):
    host=service+'.tencentcloudapi.com';body=json.dumps(payload,separators=(',',':')).encode()
    timestamp=int(time.time());date=datetime.datetime.fromtimestamp(timestamp,datetime.timezone.utc).strftime('%Y-%m-%d')
    content_type='application/json; charset=utf-8'
    canonical='POST\n/\n\ncontent-type:'+content_type+'\nhost:'+host+'\n\ncontent-type;host\n'+hashlib.sha256(body).hexdigest()
    scope=date+'/'+service+'/tc3_request'
    string='TC3-HMAC-SHA256\n'+str(timestamp)+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
    key=hmac.new(('TC3'+credentials['SecretKey']).encode(),date.encode(),hashlib.sha256).digest()
    key=hmac.new(key,service.encode(),hashlib.sha256).digest();key=hmac.new(key,b'tc3_request',hashlib.sha256).digest()
    signature=hmac.new(key,string.encode(),hashlib.sha256).hexdigest()
    headers={'Content-Type':content_type,'Host':host,'X-TC-Action':action,'X-TC-Version':version,'X-TC-Timestamp':str(timestamp),
        'Authorization':'TC3-HMAC-SHA256 Credential='+credentials['SecretId']+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature}
    if region:headers['X-TC-Region']=region
    if credentials.get('Token') or credentials.get('SessionToken'):headers['X-TC-Token']=credentials.get('Token',credentials.get('SessionToken'))
    status,headers,body=request('https://'+host,method='POST',headers=headers,data=body)
    return status,json.loads(body)['Response']

def cos(credentials, host, method='GET', path='/', query=None, headers=None, data=None):
    query=query or {};headers={k.lower():str(v) for k,v in (headers or {}).items()};headers['host']=host
    enc=lambda s:urllib.parse.quote(str(s),safe='-_.~')
    params={str(k).lower():str(v) for k,v in query.items()}
    canonical_params='&'.join(enc(k)+'='+enc(v) for k,v in sorted(params.items()))
    canonical_headers='&'.join(enc(k)+'='+enc(v) for k,v in sorted(headers.items()))
    now=int(time.time());keytime=str(now-60)+';'+str(now+300)
    key=hmac.new(credentials['SecretKey'].encode(),keytime.encode(),hashlib.sha1).hexdigest()
    http=method.lower()+'\n'+path+'\n'+canonical_params+'\n'+canonical_headers+'\n'
    string='sha1\n'+keytime+'\n'+hashlib.sha1(http.encode()).hexdigest()+'\n'
    signature=hmac.new(key.encode(),string.encode(),hashlib.sha1).hexdigest()
    headers['authorization']='q-sign-algorithm=sha1&q-ak='+credentials['SecretId']+'&q-sign-time='+keytime+'&q-key-time='+keytime+'&q-header-list='+';'.join(sorted(headers))+'&q-url-param-list='+';'.join(sorted(params))+'&q-signature='+signature
    if credentials.get('Token') or credentials.get('SessionToken'):headers['x-cos-security-token']=credentials.get('Token',credentials.get('SessionToken'))
    url='https://'+host+urllib.parse.quote(path,safe='/~')
    if query:url+='?'+urllib.parse.urlencode(query)
    return request(url,method,headers,data)

def xml(body):
    root=ET.fromstring(body)
    for node in root.iter():node.tag=node.tag.split('}')[-1]
    return root
