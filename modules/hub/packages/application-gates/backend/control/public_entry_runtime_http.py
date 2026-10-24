#!/usr/bin/env python3
"""Loopback trusted relay. Live authorization is checked by Hufu before every call.
Long-running work never re-authorizes itself; a queued job rechecks its deadline.
"""
import hashlib, hmac, json, pathlib, sqlite3, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import runtime_adapter as adapter
KEY = pathlib.Path('/etc/workspace-hub2/runtime/relay.private')
DB = '/srv/workspace'
LOCKS = {}; DBLOCK = threading.Lock()

def connect():
    c=sqlite3.connect(DB,timeout=15)
    c.execute('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, actor TEXT, client TEXT, project TEXT, idem TEXT, digest TEXT, record TEXT, UNIQUE(actor,client,idem))')
    return c

def job(oid,r,i):
    with LOCKS.setdefault(r['parameters']['runtime_target'], threading.Lock()):
        record={'operation_id':oid,'project_id':r['project_id'],'action':r['action']}
        try:
            result=adapter.execute(r,i)
            record.update(state='completed' if result.get('exit_code',0)==0 else 'failed',result=result)
        except Exception as e: record.update(state='failed',error_code=str(e)[:200],next_step='inspect_actual_effect_before_retry')
        with connect() as c: c.execute('UPDATE operations SET record=? WHERE id=?',(json.dumps(record),oid))

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,obj,status=200):
        data=json.dumps(obj,ensure_ascii=False).encode(); self.send_response(status)
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        try:
            if self.path!='/execute' or not hmac.compare_digest(self.headers.get('x-hub-resource-key',''),KEY.read_text().strip()): return self.reply({'error_code':'trusted_hufu_relay_required'},403)
            n=int(self.headers.get('Content-Length',0))
            if not 0<n<=32*1024*1024: return self.reply({'error_code':'size_limit'},400)
            packet=json.loads(self.rfile.read(n));r=packet['request'];i=packet['identity']
            if n>1048576 and not (r.get('action')=='application_release' and r.get('parameters',{}).get('component')=='public-entry' and r.get('project_id')=='3527ac31-0643-4f89-a6bd-b1e9768b2e42'):return self.reply({'error_code':'size_limit'},400)
            if r['action']=='application_release':
                from application_release import execute
                return self.reply(execute(r,i))
            if r['action']=='database_sqlite':
                from sqlite_runner import execute
                return self.reply(execute(r['parameters'],i))
            if r['action']=='operation':
                if r['project_id']!=i['project_id']: raise PermissionError('project_mismatch')
                # Operation polling needs current runtime status scope and deadline too.
                probe={**r,'action':'status'};adapter.authorize(probe,i,json.loads(adapter.CONF.read_text()))
                with connect() as c: row=c.execute('SELECT actor,client,project,record FROM operations WHERE id=?',(r['parameters']['operation_id'],)).fetchone()
                if not row or tuple(row[:3])!=(i['actor_id'],i['client_id'],r['project_id']): raise PermissionError('operation_unavailable')
                return self.reply(json.loads(row[3]))
            adapter.authorize(r,i,json.loads(adapter.CONF.read_text()))
            if r['action'] not in ('command','service'): return self.reply(adapter.execute(r,i))
            idem=r.get('idempotency_key')
            if not isinstance(idem,str) or not 1<=len(idem)<=200: raise ValueError('idempotency_key_required')
            digest=hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest();oid=str(uuid.uuid4())
            record={'state':'queued','operation_id':oid,'project_id':r['project_id'],'action':r['action']}
            with DBLOCK, connect() as c:
                old=c.execute('SELECT digest,record FROM operations WHERE actor=? AND client=? AND idem=?',(i['actor_id'],i['client_id'],idem)).fetchone()
                if old: return self.reply(json.loads(old[1]) if old[0]==digest else {'error_code':'idempotency_conflict'},200 if old[0]==digest else 409)
                c.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',(oid,i['actor_id'],i['client_id'],r['project_id'],idem,digest,json.dumps(record)))
            threading.Thread(target=job,args=(oid,r,i),daemon=True).start();self.reply(record,202)
        except PermissionError as e: self.reply({'error_code':str(e)},403)
        except Exception as e: self.reply({'error_code':str(e)[:200]},400)

if __name__=='__main__':
    with connect() as c:
        for oid,raw in c.execute('SELECT id,record FROM operations').fetchall():
            r=json.loads(raw)
            if r['state']=='queued':
                r.update(state='interrupted',next_step='inspect_actual_effect_before_retry');c.execute('UPDATE operations SET record=? WHERE id=?',(json.dumps(r),oid))
    ThreadingHTTPServer(('127.0.0.1',4629),Handler).serve_forever()
