"""Private fixed-path reader. Owner is supplied by the authenticated server, not API input."""
import json,sys,sqlite3
q=json.load(sys.stdin);owner=q['legacy_subject'];limit=q.get('limit',100);cursor=q.get('cursor')
c=sqlite3.connect('file:/srv/workspace',uri=True);c.row_factory=sqlite3.Row
meta=dict(c.execute('SELECT key,value FROM meta'))
if cursor and not c.execute('SELECT 1 FROM files WHERE owner=? AND id=?',(owner,cursor)).fetchone():
 print(json.dumps({'state':'failed','error_code':'cursor_not_visible','next_step':'read_first_page'}));sys.exit(0)
total=c.execute('SELECT count(*) FROM files WHERE owner=?',(owner,)).fetchone()[0]
version_total=c.execute('SELECT count(*) FROM versions v JOIN files f ON f.id=v.file_id WHERE f.owner=?',(owner,)).fetchone()[0]
rows=c.execute('SELECT id,path,current_ver,status,created_at,updated_at,category,native_material_id FROM files WHERE owner=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?',(owner,cursor,cursor,limit+1)).fetchall()
more=len(rows)>limit;rows=rows[:limit];items=[]
for row in rows:
 item=dict(row);item['legacy_file_id']=item.pop('id')
 versions=[dict(v) for v in c.execute('SELECT ver,size,sha256,storage_class,ts FROM versions WHERE file_id=? ORDER BY ver',(item['legacy_file_id'],))]
 for v in versions:v['reference']={'file_id':item['legacy_file_id'],'ver':v['ver'],'sha256':v['sha256'],'kind':'original_version_metadata_reference','byte_delivery':'not_asserted'}
 item['versions']=versions;item['read_scope']='metadata_only;current_native_material_access_separately_checked';items.append(item)
projects=[dict(p) for p in c.execute('SELECT p.name,p.title,p.status,p.created_at FROM projects p WHERE p.owner_username=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_name=p.name AND m.username=?) ORDER BY p.name',(owner,owner))]
out={'state':'read','items':items,'source':meta,'total_files':total,'total_versions':version_total,'returned_count':len(items),'next_cursor':items[-1]['legacy_file_id']if more and items else None,'complete':not more,'projects':projects,'project_metadata_semantics':'original_owned_or_member_projects;not_new_native_qualification','engineering_permission_required':False,'new_grant':False}
c.close();print(json.dumps(out,ensure_ascii=False))
