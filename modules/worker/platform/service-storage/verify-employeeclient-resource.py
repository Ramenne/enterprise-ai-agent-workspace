"""Synthetic direct COS use by the actual application UID and mount namespace."""
import importlib.util,json,pathlib,os,uuid
assert os.getuid()==899
spec=importlib.util.spec_from_file_location('cloud','/usr/local/libexec/workspace-service-storage/cloud_control_check.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=pathlib.Path('/srv/workspace-services/357b97c5-380c-4017-a332-c747385a7011/private-config/585efc9d-95dd-4c7b-aaa0-cfc4912300eb/resource-585efc9d-95dd-4c7b-aaa0-cfc4912300eb.private')
c=json.loads(p.read_text());assert c['credential_strategy']=='existing_resource'
credentials={'SecretId':c['access_key_id'],'SecretKey':c['secret_access_key']}
host=c['endpoint'].split('://',1)[1];path='/_platform_delivery_check/'+str(uuid.uuid4())+'.txt'
data=b'EmployeeClient direct use of delivered existing COS resource 2026-10-08.'
r={'uid':os.getuid(),'bucket':c['bucket'],'configuration_path':str(p),'credential_strategy':c['credential_strategy'],'checks':{},'mcp_used_for_object_calls':False,'new_CAM_user_created':False,'secret_values_in_output':False}
s,h,b=m.cos(credentials,host,'PUT',path,headers={'content-type':'text/plain'},data=data);r['checks']['upload']=s
if s==200:
 try:
  s,h,b=m.cos(credentials,host,'GET',path);r['checks'].update(download=s,bytes_match=b==data)
  s,h,b=m.cos(credentials,host,'GET',path,headers={'range':'bytes=0-4'});r['checks'].update(range=s,range_bytes_match=b==data[:5])
  s,h,b=m.cos(credentials,host,'GET',query={'prefix':path.lstrip('/')});r['checks']['list']=s
 finally:
  s,h,b=m.cos(credentials,host,'DELETE',path);r['checks']['cleanup']=s
  s,h,b=m.cos(credentials,host,'HEAD',path);r['checks']['cleanup_confirmed']=s
r['passed']=all([r['checks'].get('upload')==200,r['checks'].get('download')==200,r['checks'].get('bytes_match'),r['checks'].get('range')==206,r['checks'].get('range_bytes_match'),r['checks'].get('list')==200,r['checks'].get('cleanup')==204,r['checks'].get('cleanup_confirmed')==404])
print(json.dumps(r))
assert r['passed'],'direct_existing_resource_verification_failed'
