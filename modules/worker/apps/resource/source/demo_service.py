#!/usr/bin/env python3
"""Original 2.0 harmless registered unit: publish fixed bytes, never execute artifact code."""
import argparse, base64, datetime, hashlib, http.server, json, os, pathlib, time

def read(path,limit=3*1024*1024):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        data=stream.read(limit+1)
        if len(data)>limit:raise ValueError('demo_limit')
        return data

def durable(path,data):
    temporary=path.with_name('.'+path.name+'.pending')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(directory)
    finally:os.close(directory)

def apply(root,runtime,environment,port):
    artifact=pathlib.Path(os.environ['HUB2_ARTIFACT_PATH']);digest=os.environ['HUB2_ARTIFACT_HASH'];op=os.environ['HUB2_OPERATION_ID']
    if artifact.parent!=root or artifact.name!=digest+'.artifact' or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):raise ValueError('fixed_artifact_required')
    if os.environ['HUB2_ENVIRONMENT']!=environment or len(op)!=64 or any(c not in '0123456789abcdef' for c in op):raise ValueError('fixed_target_required')
    data=read(artifact,2*1024*1024)
    if hashlib.sha256(data).hexdigest()!=digest:raise ValueError('artifact_integrity')
    receipt=dict(state='executed',sha256=digest,operation_id=op,environment=environment)
    previous=runtime/(op+'.receipt')
    if previous.exists():
        if json.loads(read(previous))!=receipt:raise ValueError('operation_conflict')
        return receipt
    visible=runtime/'current.json'
    # Recover the actual atomic effect before the durable receipt was committed.
    current=json.loads(read(visible)) if visible.exists() else {}
    if any(current.get(k)!=v for k,v in receipt.items()):
        deadline=os.environ.get('HUB2_AUTHORITY_DEADLINE','')
        expiry=datetime.datetime.fromisoformat(deadline.replace('Z','+00:00')).timestamp()
        payload=json.dumps(dict(receipt,data_b64=base64.b64encode(data).decode()),separators=(',',':')).encode()
        if expiry<=time.time():raise ValueError('current_authority_expired')
        durable(visible,payload)
    # Current unit reads this exact inode publication; receipt names that effect.
    import urllib.request
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/',timeout=2) as response:
        observed=json.loads(response.read(3*1024*1024+1))
        if any(observed.get(k)!=v for k,v in receipt.items()):raise ValueError('unit_effect_unconfirmed')
    durable(previous,json.dumps(receipt,separators=(',',':')).encode())
    return receipt

def serve(runtime,port):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            data=read(runtime/'current.json') if (runtime/'current.json').exists() else b'{"state":"initial"}'
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    http.server.HTTPServer(('127.0.0.1',port),Handler).serve_forever()

if __name__=='__main__':
    os.umask(0o077)
    if os.geteuid()==0:raise ValueError('nonroot_demo_unit_required')
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['serve','apply']);parser.add_argument('--root',required=True);parser.add_argument('--runtime',required=True);parser.add_argument('--environment',required=True);parser.add_argument('--port',type=int,required=True)
    args=parser.parse_args();root=pathlib.Path(args.root);runtime=pathlib.Path(args.runtime)
    if args.mode=='serve':serve(runtime,args.port)
    else:print(json.dumps(apply(root,runtime,args.environment,args.port)))
