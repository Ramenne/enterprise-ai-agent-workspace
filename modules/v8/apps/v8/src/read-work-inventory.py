import json,sys,sqlite3
q=json.load(sys.stdin);owner=q['legacy_subject'];pid=q.get('legacy_project_id');cursor=q.get('cursor');limit=q.get('limit',10)
c=sqlite3.connect('file:/srv/workspace',uri=True);c.row_factory=sqlite3.Row
meta=dict(c.execute('SELECT key,value FROM meta'))
def fail(code):print(json.dumps({'state':'failed','error_code':code}));sys.exit(0)
if pid and not c.execute('SELECT 1 FROM projects WHERE id=? AND owner=?',(pid,owner)).fetchone():fail('original_personal_project_not_owned')
if cursor and not c.execute('SELECT 1 FROM projects WHERE id=? AND owner=?',(cursor,owner)).fetchone():fail('cursor_not_visible')
total=c.execute('SELECT count(*) FROM projects WHERE owner=? AND (? IS NULL OR id=?)',(owner,pid,pid)).fetchone()[0]
rows=c.execute('SELECT * FROM projects WHERE owner=? AND (? IS NULL OR id=?) AND (? IS NULL OR id>?) ORDER BY id LIMIT ?',(owner,pid,pid,cursor,cursor,limit+1)).fetchall();more=len(rows)>limit;rows=rows[:limit];items=[]
def linked(v,ids):
 if isinstance(v,dict):
  return any((k in ['project_id','task_id','work_item_id']and str(x)in ids)or(k in ['project','task','work_item']and isinstance(x,dict)and str(x.get('id'))in ids)or linked(x,ids)for k,x in v.items())
 if isinstance(v,list):return any(linked(x,ids)for x in v)
 return False
for r in rows:
 project=json.loads(r['payload']);tasks=[json.loads(x['payload'])for x in c.execute('SELECT payload FROM tasks WHERE project_id=? ORDER BY id',(r['id'],))];ids={r['id']}|{t['id']for t in tasks};related=[];plans=[]
 for x in c.execute('SELECT kind,payload FROM related WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?)',(r['id'],)):related.append({'kind':x['kind'],'record':json.loads(x['payload'])})
 planids=set()
 for x in c.execute("SELECT * FROM plans WHERE kind='plan_items'"):
  v=json.loads(x['payload'])
  if v.get('task_id')in ids or v.get('approved_project_id')==r['id']or v.get('proposed_project_id')==r['id']:plans.append({'kind':x['kind'],'record':v});planids.add(x['plan_id'])
 for pl in planids:
  for x in c.execute("SELECT * FROM plans WHERE plan_id=? AND kind!='plan_items'",(pl,)):
   v=json.loads(x['payload'])
   if x['owner']==owner:plans.append({'kind':x['kind'],'record':v})
   else:plans.append({'kind':x['kind'],'reference_only':{k:v.get(k)for k in ['id','plan_id','version_no','address']if k in v},'source_content_access':'not_asserted'})
 events=[]
 for x in c.execute('SELECT * FROM events WHERE project_id=? OR task_id IN(SELECT id FROM tasks WHERE project_id=?)',(r['id'],r['id'])):
  if x['owner']==owner or x['visibility']in ['team','public']:events.append(json.loads(x['payload']))
 receipts=[]
 for x in c.execute('SELECT * FROM receipts WHERE actor=?',(owner,)):
  try:v=json.loads(x['payload'])
  except(ValueError,TypeError):continue
  if linked(v,ids):receipts.append({'operation':x['operation'],'idempotency_key':x['key'],'original_receipt':v})
 items.append({'project':project,'tasks':tasks,'activities':events,'related_records':related,'plans':plans,'receipts':receipts,'state_semantics':'unchanged_source_status_and_completed_at;not_inferred_from_artifacts','references_semantics':'original_addresses_and_versions_not_verified_current_delivery'})
print(json.dumps({'state':'read','items':items,'total_projects':total,'returned_count':len(items),'next_cursor':rows[-1]['id']if more and rows else None,'complete':not more,'source':meta,'new_grant':False,'engineering_permission_required':False,'original_member_credential_required':False},ensure_ascii=False));c.close()
