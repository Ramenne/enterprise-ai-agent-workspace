"""Deliver the existing approved COS configuration; no user or key creation."""
import json,pathlib,subprocess,sys

b=json.load(sys.stdin)
package='70572722-1cb8-4cb3-a6b6-11eaa235129d'
item='585efc9d-95dd-4c7b-aaa0-cfc4912300eb'
assert b['package_id']==package
p=pathlib.Path('/srv/workspace')/package/(item+'.private.json')
s=json.loads(p.read_text());c=s['application_config']
assert s['bucket_created'] and s['tags_written'] and not s.get('pending_effect')
assert c['project_id']=='ad44cc0e-159e-4e0f-a5ca-73d3920240d9'
assert c['service_id']=='357b97c5-380c-4017-a332-c747385a7011'
assert c['bucket']=='hub2-app-5e612def-1316920087' and c['credential_strategy']=='existing_resource'
b['secret_values']={item:json.dumps(c)}
r=subprocess.run(['python3','/usr/local/libexec/workspace-resource-delivery.py'],input=json.dumps(b),text=True,capture_output=True,timeout=90)
assert r.returncode==0,'approved_runtime_configuration_delivery_failed'
d=json.loads(r.stdout)
selected=next(x for x in d['items'] if x['item_id']==item)
print(json.dumps({'state':'existing_resource_configuration_delivered','package_id':package,'item':selected,'new_CAM_user_created':False,'new_access_key_created':False,'secret_values_in_output':False}))
