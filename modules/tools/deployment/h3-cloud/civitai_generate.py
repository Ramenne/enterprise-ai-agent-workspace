"""Paste a Civitai URL to import and generate through the hosted Krea API.
Requires HUFU_TOKEN in environment. Durable receipts resume without new submits.
"""
import argparse
import json
import os
from pathlib import Path
import time
import uuid
import requests


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--url',required=True)
    p.add_argument('--prompt',required=True)
    p.add_argument('--strength',type=float,default=0.8)
    p.add_argument('--width',type=int,default=1024)
    p.add_argument('--height',type=int,default=1024)
    p.add_argument('--seed',type=int,default=42424242)
    p.add_argument('--estimated-credits',type=float,required=True)
    p.add_argument('--budget-credits',type=float,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    base='https://hufu.example.invalid/api/h3-cloud/krea2'
    token=os.environ['HUFU_TOKEN'];headers={'Authorization':token if token.startswith('Bearer ') else 'Bearer '+token}
    body={'prompt':a.prompt,'width':a.width,'height':a.height,'seed':a.seed,'lora_strength':a.strength,
          'generation_authorized':True,'estimated_credits':a.estimated_credits,'budget_credits':a.budget_credits}
    receipt=a.output.with_suffix('.receipt.json');a.output.parent.mkdir(parents=True,exist_ok=True)
    spec={'url':a.url,'body':body}
    if receipt.exists():
        state=json.loads(receipt.read_text())
        if state['spec']!=spec:raise RuntimeError('Output already bound to different input; use another output path')
    else:
        state={'spec':spec,'import_id':str(uuid.uuid4()),'job_id':str(uuid.uuid4()),'import_started':False,'generation_started':False,'started':time.time()}
    def save():receipt.write_text(json.dumps(state,indent=2,ensure_ascii=False))
    def req(method,path,data=None,ident=None):
        r=requests.request(method,base+path,headers=headers|({'Idempotency-Key':ident} if ident else {}),json=data,timeout=150)
        if r.status_code>=400:raise RuntimeError('API HTTP '+str(r.status_code)+': '+str(r.json()))
        return r.json()
    save()
    if not state['import_started']:
        state['import_started']=True;save()
        state['lora']=req('POST','/loras/import',{'url':a.url},state['import_id']);state['import_id']=state['lora']['id'];save()
    elif not state.get('lora'):
        # Same id only: server returns the durable import record if the POST had effects.
        state['lora']=req('POST','/loras/import',{'url':a.url},state['import_id']);state['import_id']=state['lora']['id'];save()
    else:
        state['lora']=req('GET','/loras/'+state['import_id']);save()
    deadline=time.monotonic()+900
    while state['lora']['state']!='ready':
        if state['lora']['state'] in ('failed','import_unknown'):raise RuntimeError('Import stopped; inspect original receipt, no automatic new import')
        if time.monotonic()>deadline:raise RuntimeError('Import still pending; rerun same command to observe original')
        time.sleep(3);state['lora']=req('GET','/loras/'+state['import_id']);save()
    body=body|{'lora_id':state['import_id']}
    if not state['generation_started']:
        state['preview']=req('POST','/preview',body);save()
        state['generation_started']=True;save()
        state['submission']=req('POST','/jobs',body,state['job_id']);save()
    deadline=time.monotonic()+900
    while True:
        state['job']=req('GET','/jobs/'+state['job_id']);save();supplier=state['job'].get('supplier',{})
        status=supplier.get('status',state['job'].get('state'));print(json.dumps({'id':state['job_id'],'state':status}),flush=True)
        if supplier.get('outputs'):
            asset=supplier['outputs'][0]['id'];r=requests.get(base+'/jobs/'+state['job_id']+'/outputs/'+asset,headers=headers,timeout=150);r.raise_for_status()
            a.output.write_bytes(r.content);state['completed']=True;state['wall_seconds']=time.time()-state['started'];save()
            print(json.dumps({'output':str(a.output.resolve()),'metrics':supplier.get('metrics'),'wall_seconds':state['wall_seconds']}));break
        if status in ('failed','cancelled','submission_unknown','rejected_payment_required'):raise RuntimeError('Generation stopped; inspect original receipt')
        if time.monotonic()>deadline:raise RuntimeError('Still pending; rerun same command to observe original')
        time.sleep(3)

if __name__=='__main__':main()
