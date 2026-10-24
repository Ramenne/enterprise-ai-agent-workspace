"""Durable pre-submission queue. Provider reservation is irreversible after claim.
Caller credentials remain in request context, never in SQLite. After a service restart
an authenticated job.get resumes waiting work; already claimed work is observe-only.
"""
import json
import time
from tools_krea2_cloud import connection, Fault

WAIT_SECONDS = 0

def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS visual_waiting (
      owner TEXT,id TEXT,actor TEXT,request TEXT,created REAL,deadline REAL,
      state TEXT,provider TEXT,result TEXT,error TEXT,worker TEXT,
      PRIMARY KEY(owner,id))''')
    db.execute('CREATE TABLE IF NOT EXISTS visual_slots (worker TEXT PRIMARY KEY,owner TEXT,id TEXT)')

def get(owner, jid):
    with connection() as db:
        schema(db)
        db.row_factory = __import__('sqlite3').Row
        row = db.execute('SELECT * FROM visual_waiting WHERE owner=? AND id=?',(owner,jid)).fetchone()
    if row:
        d = dict(row)
        d['request'] = json.loads(d['request'])
        d['result'] = json.loads(d['result']) if d['result'] else None
        return d

def enqueue(owner, jid, actor, request, now=None):
    now = time.time() if now is None else now
    with connection() as db:
        schema(db)
        db.execute('BEGIN IMMEDIATE')
        if not db.execute('SELECT 1 FROM visual_waiting WHERE owner=? AND id=?',(owner,jid)).fetchone():
            if db.execute("SELECT COUNT(*) FROM visual_waiting WHERE owner=? AND state='waiting'",(owner,)).fetchone()[0]>=16:
                raise Fault(429,'too_many_waiting_image_jobs')
            db.execute('INSERT INTO visual_waiting VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (owner,jid,actor,json.dumps(request),now,now+WAIT_SECONDS,'waiting',None,None,None,None))
    return get(owner,jid)

def claim(owner,jid,autodl_ready=False,worker=None,now=None):
    """Claim new or never-submitted legacy image work for Cloud immediately.
    Historical claimed providers remain pinned; this never submits to AutoDL.
    """
    with connection() as db:
        schema(db);db.execute('BEGIN IMMEDIATE')
        r=db.execute('SELECT state FROM visual_waiting WHERE owner=? AND id=?',(owner,jid)).fetchone()
        if not r or r[0]!='waiting':return None
        db.execute("UPDATE visual_waiting SET state='submitting',provider='comfy_cloud',worker=NULL WHERE owner=? AND id=?",(owner,jid))
        db.execute("UPDATE visual_jobs SET provider='comfy_cloud' WHERE owner=? AND id=?",(owner,jid))
        return 'comfy_cloud'

def result(owner,jid,value=None,error=None):
    with connection() as db:
        schema(db)
        db.execute('UPDATE visual_waiting SET state=?,result=?,error=? WHERE owner=? AND id=?',
            ('submission_unknown' if error else 'accepted',json.dumps(value) if value is not None else None,error,owner,jid))

def slot(worker):
    with connection() as db:
        schema(db)
        return db.execute('SELECT owner,id FROM visual_slots WHERE worker=?',(worker,)).fetchone()

def release(owner,jid):
    # Only call after positive supplier terminal evidence, never on network timeout.
    with connection() as db:
        schema(db);db.execute('DELETE FROM visual_slots WHERE owner=? AND id=?',(owner,jid))

def public(row):
    return {'id':row['id'],'state':'queued' if row['state']=='waiting' else row['state'],
        'provider':row['provider'] or 'pending','queued_at':row['created'],
        'fallback_at':None,'max_autodl_wait_seconds':0,'routing_policy':'comfy_cloud_only',
        'job':row['result'] or {'state':'queued' if row['state']=='waiting' else row['state']},
        'error':row['error'],'resubmitted':False}


def unclaim(owner,jid):
    """Only a positively rejected/no-effect worker response permits returning to queue."""
    with connection() as db:
        schema(db);db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT provider,state FROM visual_waiting WHERE owner=? AND id=?',(owner,jid)).fetchone()
        if row!=('autodl','submitting'):raise Fault(409,'cannot_unclaim_possible_effect')
        db.execute("UPDATE visual_waiting SET state='waiting',provider=NULL,worker=NULL WHERE owner=? AND id=?",(owner,jid))
        db.execute("UPDATE visual_jobs SET provider='pending' WHERE owner=? AND id=?",(owner,jid))
        db.execute('DELETE FROM visual_slots WHERE owner=? AND id=?',(owner,jid))
