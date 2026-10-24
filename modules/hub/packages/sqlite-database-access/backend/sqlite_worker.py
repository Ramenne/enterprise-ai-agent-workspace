#!/usr/bin/env python3
"""Controlled SQLite engine worker. Run ONLY via registered project OS UID jail.
No user SQL PRAGMA, attachment, DDL, filesystem functions, extension, or raw path.
"""
import sqlite3,json,sys,time,datetime,hashlib,base64

def fingerprint(c,table):
    row=c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()
    if not row:raise ValueError('registered_table_missing')
    return hashlib.sha256(row[0].encode()).hexdigest()

def result_value(v):return {'base64':base64.b64encode(v).decode()} if isinstance(v,bytes) else v

def execute(packet):
    permit=packet['identity'];request=packet['request'];target=packet['target']
    if permit['project_id']!=target['project_id'] or request['project_id']!=target['project_id']:raise PermissionError('database_project_mismatch')
    deadline=datetime.datetime.fromisoformat(permit['deadline'].replace('Z','+00:00'))
    if deadline<=datetime.datetime.now(datetime.timezone.utc):raise PermissionError('database_permit_expired')
    db=sqlite3.connect('file:/database/'+target['filename']+'?mode=rw',uri=True,timeout=3,isolation_level=None)
    db.enable_load_extension(False)
    allowed={}
    for x in permit['objects']:allowed.setdefault(x['table'],set()).update(x['actions'])
    try:
        cookie=db.execute('PRAGMA schema_version').fetchone()[0]
        expected={}
        for obj in permit['objects']:expected.setdefault(obj['table'],set()).add(obj['fingerprint'])
        if request['action']=='inspect':
            table=request['table']
            if table not in allowed or not (allowed[table]&{'inspect','select'}):raise PermissionError('table_inspect_not_approved')
            if expected[table]!={fingerprint(db,table)}:raise ValueError('database_object_replaced_or_catalogue_stale')
            quote='"'+table.replace('"','""')+'"'
            return {'state':'read','coverage':'structure_only','table':table,'columns':[{'name':r[1],'type':r[2],'not_null':bool(r[3]),'primary_key':r[5]} for r in db.execute('PRAGMA table_info('+quote+')')],'indexes':[{'name':r[1],'unique':bool(r[2])} for r in db.execute('PRAGMA index_list('+quote+')')],'foreign_keys':[{'table':r[2],'from':r[3],'to':r[4]} for r in db.execute('PRAGMA foreign_key_list('+quote+')')]}
        sql=request.get('sql');parameters=request.get('parameters',[])
        if not isinstance(sql,str) or not sql or len(sql)>200000 or not isinstance(parameters,(list,dict)):raise ValueError('bounded_single_statement_required')
        # Internal attachment cannot be reached by member SQL (dbname allowlist).
        db.execute("ATTACH DATABASE '/receipts/operations.sqlite' AS receipt")
        db.execute('CREATE TABLE IF NOT EXISTS receipt.effects(actor TEXT,client TEXT,idem TEXT,digest TEXT,result TEXT,PRIMARY KEY(actor,client,idem))')
        db.execute('BEGIN')
        # Read fingerprints in this transaction snapshot; only touched tables must match.
        current={r[0]:hashlib.sha256(r[1].encode()).hexdigest() for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")}
        idem=request.get('idempotency_key');digest=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if idem:
            old=db.execute('SELECT digest,result FROM receipt.effects WHERE actor=? AND client=? AND idem=?',(permit['actor_id'],permit['client_id'],idem)).fetchone()
            if old:
                if old[0]!=digest:raise ValueError('idempotency_conflict')
                db.rollback();return {**json.loads(old[1]),'replayed':True}
        writes=[];denial=[];start=time.monotonic()
        harmless={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_RECURSIVE}
        actions={sqlite3.SQLITE_READ:'select',sqlite3.SQLITE_INSERT:'insert',sqlite3.SQLITE_UPDATE:'update',sqlite3.SQLITE_DELETE:'delete'}
        def authorizer(op,a,b,name,trigger):
            if op in harmless:return sqlite3.SQLITE_OK
            if op==sqlite3.SQLITE_FUNCTION:
                fn=(b or a or '').lower()
                if fn in ('load_extension','readfile','writefile') or fn.startswith('pragma_'):denial.append('database_function_not_allowed');return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            if op in actions:
                action=actions[op]
                if name!='main' or a not in allowed or action not in allowed[a]:denial.append('table_or_action_not_approved');return sqlite3.SQLITE_DENY
                if expected[a]!={current.get(a)}:denial.append('database_object_replaced_or_catalogue_stale');return sqlite3.SQLITE_DENY
                if action=='update' and b in ('hufu_user_id','user_id','resource_owner','grantee'):
                    denial.append('ownership_or_identity_changes_require_business_API');return sqlite3.SQLITE_DENY
                if action!='select':
                    if not isinstance(idem,str) or not idem or len(idem)>200:denial.append('mutation_idempotency_key_required');return sqlite3.SQLITE_DENY
                    writes.append(action)
                return sqlite3.SQLITE_OK
            denial.append('pragma_attach_transaction_or_schema_change_not_allowed');return sqlite3.SQLITE_DENY
        db.set_authorizer(authorizer)
        db.set_progress_handler(lambda:1 if time.monotonic()-start>8 else 0,1000)
        try:
            before=db.total_changes;cursor=db.execute(sql,parameters)
            rows=cursor.fetchmany(201) if cursor.description else []
            columns=[x[0] for x in cursor.description] if cursor.description else []
            output={'state':'committed' if writes else 'read','affected_rows':db.total_changes-before,'columns':columns,'rows':[[result_value(v) for v in row] for row in rows[:200]],'coverage':'partial' if len(rows)>200 else 'statement_result','actions':sorted(set(writes) or {'select'})}
            cursor.close()
        except sqlite3.DatabaseError:
            if denial:raise PermissionError(denial[-1])
            raise ValueError('sqlite_statement_failed_or_constraint_violation')
        finally:db.set_authorizer(None);db.set_progress_handler(None,0)
        if len(json.dumps(output).encode())>1024*1024:raise ValueError('query_result_too_large;use_SQL_projection_or_pagination')
        if idem:db.execute('INSERT INTO receipt.effects VALUES(?,?,?,?,?)',(permit['actor_id'],permit['client_id'],idem,digest,json.dumps({k:v for k,v in output.items() if k not in ('rows','columns')}|{'result_rows_omitted':True})))
        db.commit();return output
    finally:
        if db.in_transaction:db.rollback()
        db.close()

if __name__=='__main__':
    try:print(json.dumps(execute(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as e:print(json.dumps({'state':'failed','error_code':str(e) if isinstance(e,(ValueError,PermissionError)) else 'sqlite_execution_dependency_unavailable'}));sys.exit(1)
