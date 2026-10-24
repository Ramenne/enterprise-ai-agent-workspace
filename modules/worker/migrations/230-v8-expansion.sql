-- Bounded transport views and exact canonical expansion. Semantic JSON is untouched.
SET ROLE hub2_v8_owner;
ALTER TABLE v8.context_views ADD COLUMN canonical_text text,ADD COLUMN sha256 text;
CREATE TABLE v8.read_projections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES v8.projects(id),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),actor_id uuid NOT NULL,client_id uuid NOT NULL,body jsonb NOT NULL,canonical_text text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON v8.read_projections FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE INDEX work_updates_expansion_key ON v8.work_updates(work_item_id,created_at,id);
CREATE INDEX work_snapshots_expansion_key ON v8.work_snapshots(work_item_id,created_at,id);
CREATE INDEX impact_expansion_key ON v8.impact_judgments(work_item_id,created_at,id);

-- Internal navigation descriptor; a byte limit describes delivery, never semantic quality.
CREATE FUNCTION v8.expansion_item(kind text,id uuid,body jsonb,original text,hash text,inline_limit integer DEFAULT 4096) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb:=jsonb_build_object('statement_id',id,'kind',kind,'sha256',hash,'size',octet_length(original),'canonical_format','v8.pg-jsonb-key-order-v1');
BEGIN
 IF octet_length(body::text)+octet_length(to_jsonb(original)::text)<=inline_limit THEN RETURN r||jsonb_build_object('statement',body,'canonical_text',original,'delivery','whole_statement');END IF;
 RETURN r||jsonb_build_object('delivery','navigation_only','expand',jsonb_build_object('tool','v8.statement.read_chunk','arguments',jsonb_build_object('project_id',body->'project_id','kind',kind,'statement_id',id)));
END $$;

-- Immutable document resolver is internal. All public readers recheck its sources.
CREATE FUNCTION v8.expansion_document(c jsonb,kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE body jsonb;original text;hash text;pid uuid;wid uuid;owner uuid;client uuid;
BEGIN
 CASE kind
 WHEN 'work_update' THEN SELECT u.payload,u.canonical_text,u.sha256,w.project_id,w.id INTO body,original,hash,pid,wid FROM v8.work_updates u JOIN v8.work_items w ON w.id=u.work_item_id WHERE u.id=p_id;
 WHEN 'work_snapshot' THEN SELECT s.record,s.canonical_text,s.sha256,w.project_id,w.id INTO body,original,hash,pid,wid FROM v8.work_snapshots s JOIN v8.work_items w ON w.id=s.work_item_id WHERE s.id=p_id;
 WHEN 'impact_judgment' THEN SELECT j.payload,j.canonical_text,j.sha256,j.project_id,j.work_item_id INTO body,original,hash,pid,wid FROM v8.impact_judgments j WHERE j.id=p_id;
 WHEN 'context_manifest' THEN SELECT m.manifest,COALESCE(m.canonical_text,v8.canonical_json(m.manifest)),m.sha256,m.project_id,m.work_item_id INTO body,original,hash,pid,wid FROM v8.context_manifests m WHERE m.id=p_id;
 WHEN 'context_view' THEN SELECT v.returned_view,COALESCE(v.canonical_text,v8.canonical_json(v.returned_view)),COALESCE(v.sha256,encode(public.digest(v8.canonical_json(v.returned_view),'sha256'),'hex')),m.project_id,m.work_item_id,v.actor_id,v.client_id INTO body,original,hash,pid,wid,owner,client FROM v8.context_views v JOIN v8.context_manifests m ON m.id=v.context_id WHERE v.id=p_id;
 WHEN 'work_view' THEN SELECT x.body,x.canonical_text,x.sha256,x.project_id,x.work_item_id,x.actor_id,x.client_id INTO body,original,hash,pid,wid,owner,client FROM v8.read_projections x WHERE x.id=p_id;
 WHEN 'work_relation' THEN SELECT to_jsonb(r),v8.canonical_json(to_jsonb(r)),encode(public.digest(v8.canonical_json(to_jsonb(r)),'sha256'),'hex'),w.project_id,w.id INTO body,original,hash,pid,wid FROM v8.work_relations r JOIN v8.work_items w ON w.id=r.from_work_id WHERE r.id=p_id;
 ELSE RAISE EXCEPTION 'invalid_document_kind' USING ERRCODE='22023';
 END CASE;
 IF pid IS NULL OR pid IS DISTINCT FROM (c->>'project_id')::uuid OR (kind IN('context_view','work_view') AND (owner IS DISTINCT FROM (c->>'actor_id')::uuid OR client IS DISTINCT FROM (c->>'client_id')::uuid)) THEN RAISE EXCEPTION 'document_forbidden' USING ERRCODE='42501';END IF;
 IF encode(public.digest(original,'sha256'),'hex') IS DISTINCT FROM hash THEN RAISE EXCEPTION 'statement_integrity_mismatch' USING ERRCODE='XX001';END IF;
 RETURN jsonb_build_object('body',body,'canonical_text',original,'sha256',hash,'work_item_id',wid,'project_id',pid);
END $$;
CREATE FUNCTION v8.authorize_expansion(h uuid,c jsonb,kind text,p_id uuid,doc jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE source record;ctx uuid;other uuid;
BEGIN
 IF kind='context_manifest' THEN ctx:=p_id;
 ELSIF kind='context_view' THEN SELECT context_id INTO ctx FROM v8.context_views WHERE v8.context_views.id=p_id;
 END IF;
 -- The fixed original can only be sent with all its real sources currently authorized.
 -- A clipped view never contains the original canonical string, and has its own hash.
 IF kind='context_manifest' OR (kind='context_view' AND doc->'body'->>'manifest_canonical_text' IS NOT NULL) THEN
  FOR source IN SELECT * FROM v8.context_sources WHERE context_id=ctx LOOP
   IF NOT v8.authorized_ref(h,c,jsonb_build_object('material_id',source.material_id,'version_id',source.version_id,'sha256',source.sha256)) THEN RETURN false;END IF;
  END LOOP;
 END IF;
 IF kind='work_relation' THEN
  SELECT to_work_id INTO other FROM v8.work_relations WHERE v8.work_relations.id=p_id;
  BEGIN PERFORM authz.assert_sources(h,jsonb_build_array(jsonb_build_object('project_id',(SELECT project_id FROM v8.work_items WHERE v8.work_items.id=other))),'v8.project.read');EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
 END IF;
 RETURN v8.authorized_statement(h,c,doc->'body');
END $$;

CREATE FUNCTION v8.work_history_page_core(h uuid,c jsonb,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE kind text:=COALESCE(b->>'kind','updates');entry record;item jsonb;items jsonb:='[]';lim integer:=COALESCE((b->>'limit')::integer,20);n integer:=0;last_id uuid;more boolean:=false;cursor_id uuid:=(b->>'cursor')::uuid;cursor_time timestamptz;wid uuid:=(b->>'work_item_id')::uuid;
BEGIN
 IF kind NOT IN('updates','snapshots','impact') OR lim NOT BETWEEN 1 AND 100 OR NOT EXISTS(SELECT FROM v8.work_items WHERE id=wid AND project_id=(c->>'project_id')::uuid) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF cursor_id IS NOT NULL THEN
  CASE kind WHEN 'updates' THEN SELECT created_at INTO cursor_time FROM v8.work_updates WHERE id=cursor_id AND work_item_id=wid;
  WHEN 'snapshots' THEN SELECT created_at INTO cursor_time FROM v8.work_snapshots WHERE id=cursor_id AND work_item_id=wid;
  WHEN 'impact' THEN SELECT created_at INTO cursor_time FROM v8.impact_judgments WHERE id=cursor_id AND work_item_id=wid;
  END CASE;
  IF cursor_time IS NULL THEN RAISE EXCEPTION 'invalid_cursor' USING ERRCODE='22023';END IF;
 END IF;
 FOR entry IN SELECT * FROM (
  SELECT 'work_update'::text AS doc_kind,u.id,u.payload AS body,u.canonical_text,u.sha256,u.work_revision AS revision,u.created_at FROM v8.work_updates u WHERE kind='updates' AND u.work_item_id=wid
  UNION ALL SELECT 'work_snapshot',s.id,s.record,s.canonical_text,s.sha256,s.work_revision,s.created_at FROM v8.work_snapshots s WHERE kind='snapshots' AND s.work_item_id=wid
  UNION ALL SELECT 'impact_judgment',j.id,j.payload,j.canonical_text,j.sha256,NULL::bigint,j.created_at FROM v8.impact_judgments j WHERE kind='impact' AND j.work_item_id=wid
 ) selected WHERE cursor_time IS NULL OR (selected.created_at,selected.id)>(cursor_time,cursor_id) ORDER BY selected.created_at,selected.id LOOP
  IF NOT v8.authorized_statement(h,c,entry.body) THEN CONTINUE;END IF;
  item:=v8.expansion_item(entry.doc_kind,entry.id,entry.body,entry.canonical_text,entry.sha256)||jsonb_build_object('work_revision',entry.revision);
  IF n=lim OR octet_length(items::text)+octet_length(item::text)>65536 THEN more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(item);n:=n+1;last_id:=entry.id;
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_statements_after_cursor','snapshot',false,'truncated',more,'hidden_count','not_disclosed'),
 'expansion',jsonb_build_object('tool','v8.work.history.page','project_id',c->'project_id','work_item_id',wid,'kind',kind),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor_or_read_statement_chunk' ELSE 'read_needed_fixed_statements' END);
END $$;
CREATE FUNCTION v8.work_history_page(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);RETURN v8.work_history_page_core(h,c,b);
END $$;
CREATE OR REPLACE FUNCTION v8.work_history(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;r jsonb;items jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);r:=v8.work_history_page_core(h,c,b||jsonb_build_object('kind','snapshots','limit',20));
 SELECT COALESCE(jsonb_agg((value-'statement')||jsonb_build_object('snapshot_id',value->'statement_id')||CASE WHEN value ? 'statement' THEN jsonb_build_object('record',value->'statement') ELSE '{}' END),'[]') INTO items FROM jsonb_array_elements(r->'items');
 RETURN r||jsonb_build_object('state','historical','items',items);
END $$;

CREATE FUNCTION v8.statement_read_chunk(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;doc jsonb;original text;bytes bytea;chunk bytea;txt text;utf text;start_at integer;lim integer;end_at integer;path text[];hash text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);doc:=v8.expansion_document(c,b->>'kind',(b->>'statement_id')::uuid);
 IF NOT v8.authorize_expansion(h,c,b->>'kind',(b->>'statement_id')::uuid,doc) THEN
  RETURN jsonb_build_object('state','restricted','error_code','source_access_required','coverage',jsonb_build_object('complete',false,'returned','none'),'retained_state','fixed_original_preserved','next_step','materialize_current_clipped_view_or_choose_authorized_statement');
 END IF;
 SELECT COALESCE(array_agg(value ORDER BY ord),'{}') INTO path FROM jsonb_array_elements_text(COALESCE(b->'path','[]')) WITH ORDINALITY e(value,ord);
 IF cardinality(path)>20 THEN RAISE EXCEPTION 'invalid_path' USING ERRCODE='22023';END IF;
 IF cardinality(path)>0 THEN
  IF b->>'kind'<>'context_view' OR doc->'body'#>path IS NULL THEN RAISE EXCEPTION 'invalid_path' USING ERRCODE='22023';END IF;
  original:=v8.canonical_json(doc->'body'#>path);hash:=encode(public.digest(original,'sha256'),'hex');
 ELSE original:=doc->>'canonical_text';hash:=doc->>'sha256';END IF;
 bytes:=convert_to(original,'UTF8');start_at:=COALESCE((b->>'offset')::integer,0);lim:=COALESCE((b->>'limit')::integer,16384);
 IF start_at<0 OR start_at>octet_length(bytes) OR lim NOT BETWEEN 1 AND 32768 THEN RAISE EXCEPTION 'invalid_range' USING ERRCODE='22023';END IF;
 end_at:=least(start_at+lim,octet_length(bytes));chunk:=substring(bytes FROM start_at+1 FOR end_at-start_at);
 BEGIN txt:=convert_from(chunk,'UTF8');utf:='complete_codepoints';EXCEPTION WHEN character_not_in_repertoire THEN txt:=NULL;utf:='boundary_use_exact_base64';END;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','statement_id',b->'statement_id','kind',b->'kind','document_hash',doc->'sha256','sha256',hash,'size',octet_length(bytes),'canonical_format','v8.pg-jsonb-key-order-v1','path',COALESCE(b->'path','[]'),'bytes_base64',encode(chunk,'base64'),'text',txt,'utf8_state',utf,'chunk_sha256',encode(public.digest(chunk,'sha256'),'hex'),'range',jsonb_build_object('start',start_at,'end_exclusive',end_at),'next_offset',CASE WHEN end_at<octet_length(bytes) THEN end_at ELSE NULL END,'coverage',jsonb_build_object('complete',start_at=0 AND end_at=octet_length(bytes),'returned','exact_canonical_byte_range','understanding','not_inferred'));
END $$;

CREATE FUNCTION v8.context_view_page(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;doc jsonb;node jsonb;path text[];entry record;item jsonb;node_value jsonb;child text[];items jsonb:='[]';cursor integer;lim integer;n integer:=0;more boolean:=false;last_pos integer;node_hash text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);doc:=v8.expansion_document(c,'context_view',(b->>'view_id')::uuid);
 IF NOT v8.authorize_expansion(h,c,'context_view',(b->>'view_id')::uuid,doc) THEN
  RETURN jsonb_build_object('state','refresh_required','coverage',jsonb_build_object('complete',false,'returned','none'),'next_step','materialize_current_clipped_view_with_own_identity');
 END IF;
 SELECT COALESCE(array_agg(value ORDER BY ord),'{}') INTO path FROM jsonb_array_elements_text(COALESCE(b->'path','[]')) WITH ORDINALITY e(value,ord);
 node:=doc->'body'#>path;cursor:=COALESCE((b->>'cursor')::integer,0);lim:=COALESCE((b->>'limit')::integer,20);
 IF node IS NULL OR cardinality(path)>20 OR cursor<0 OR lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_path_or_page' USING ERRCODE='22023';END IF;
 node_hash:=encode(public.digest(v8.canonical_json(node),'sha256'),'hex');
 IF jsonb_typeof(node) NOT IN('array','object') THEN
  PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','scalar','view_id',b->'view_id','path',COALESCE(b->'path','[]'),'sha256',node_hash,'coverage',jsonb_build_object('complete',false,'returned','navigation_only'),'expansion',jsonb_build_object('tool','v8.statement.read_chunk','kind','context_view','statement_id',b->'view_id','path',COALESCE(b->'path','[]')));
 END IF;
 FOR entry IN SELECT row_number() OVER (ORDER BY position) - 1 AS pos,key_name,value FROM (
  SELECT ord AS position,(ord-1)::text AS key_name,value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(node)='array' THEN node ELSE '[]' END) WITH ORDINALITY a(value,ord)
  UNION ALL SELECT row_number() OVER (ORDER BY key COLLATE "C"),key,value FROM jsonb_each(CASE WHEN jsonb_typeof(node)='object' THEN node ELSE '{}' END)
 ) selected ORDER BY position LOOP
  IF entry.pos<cursor THEN CONTINUE;END IF;
  child:=path||entry.key_name;node_value:=entry.value;
  item:=jsonb_build_object('key',entry.key_name,'path',to_jsonb(child),'node_kind',jsonb_typeof(node_value));
  IF octet_length(node_value::text)<=2048 THEN item:=item||jsonb_build_object('value',node_value,'delivery','whole_node');
  ELSE item:=item||jsonb_build_object('delivery','navigation_only','sha256',encode(public.digest(v8.canonical_json(node_value),'sha256'),'hex'),'size',octet_length(v8.canonical_json(node_value)),'expand',CASE WHEN jsonb_typeof(node_value) IN('array','object') THEN jsonb_build_object('tool','v8.context.view.page','arguments',jsonb_build_object('project_id',b->'project_id','view_id',b->'view_id','path',to_jsonb(child))) ELSE jsonb_build_object('tool','v8.statement.read_chunk','arguments',jsonb_build_object('project_id',b->'project_id','kind','context_view','statement_id',b->'view_id','path',to_jsonb(child))) END);END IF;
  IF n=lim OR octet_length(items::text)+octet_length(item::text)>65536 THEN more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(item);n:=n+1;last_pos:=entry.pos;
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','view_id',b->'view_id','document_hash',doc->'sha256','path',COALESCE(b->'path','[]'),'sha256',node_hash,'items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_pos+1 ELSE NULL END,'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_fixed_view_node_after_cursor','snapshot',true,'truncated',more));
END $$;

-- Preserve the full stored view; bound only the actual transport representation.
ALTER FUNCTION v8.render_current_view(uuid,jsonb,v8.context_manifests,text,uuid) RENAME TO render_current_view_full_230;
CREATE FUNCTION v8.render_current_view(h uuid,c jsonb,ctx v8.context_manifests,mode text,o uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb;v jsonb;compact jsonb;delta jsonb;original text;hash text;nav jsonb;entry jsonb;preview jsonb:='[]';extra_blocked boolean;
BEGIN
 extra_blocked:=NOT v8.authorized_statement(h,c,ctx.manifest);
 IF extra_blocked AND mode='complete' THEN RETURN jsonb_build_object('state','rejected','error_code','source_access_required','retained_state','immutable_manifest_preserved','coverage',jsonb_build_object('returned_view','none','host_visible','unknown'),'next_step','use_authorized_clipped_view');END IF;
 r:=v8.render_current_view_full_230(h,c,ctx,mode,o);IF r->>'state'='rejected' THEN RETURN r;END IF;
 v:=r->'returned_view';
 IF extra_blocked THEN
  v:=jsonb_build_object('schema_version','context.v2','context_id',ctx.id,'project_id',ctx.project_id,'work_item_id',ctx.work_item_id,'goal',v->'goal','current_work',v->'current_work','fixed_refs',v->'fixed_refs','delta',r->'delta','manifest_hash',ctx.sha256,'manifest_canonical_text',NULL,'coverage',jsonb_build_object('complete',false,'returned_view','clipped','host_visible','unknown'),'limitations',jsonb_build_array('restricted_sources_and_dependent_narrative_omitted'));
  r:=r||jsonb_build_object('returned_view',v,'coverage',v->'coverage');
  PERFORM authz.assert_effect(h);UPDATE v8.context_views SET returned_view=v,coverage=v->'coverage' WHERE id=(r->>'view_id')::uuid;
 END IF;
 original:=v8.canonical_json(v);hash:=encode(public.digest(original,'sha256'),'hex');
 PERFORM authz.assert_effect(h);UPDATE v8.context_views SET canonical_text=original,sha256=hash WHERE id=(r->>'view_id')::uuid;
 nav:=jsonb_build_object('tool','v8.context.view.page','project_id',ctx.project_id,'view_id',r->'view_id');
 r:=r||jsonb_build_object('returned_view_hash',hash,'expansion',nav);
 IF octet_length(r::text)<=98304 THEN RETURN r;END IF;
 delta:=COALESCE(r->'delta','{}')-'authorized_work_updates'-'authorized_impact_judgments'-'new_version_candidates';
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(v->'delta'->'authorized_work_updates','[]')) WITH ORDINALITY u(value,ord) ORDER BY ord DESC LIMIT 3 LOOP
  preview:=preview||jsonb_build_array(v8.expansion_item('work_update',(entry->>'update_id')::uuid,entry->'statement',entry->>'canonical_text',entry->>'sha256',2048));
 END LOOP;
 compact:=jsonb_build_object('schema_version',v->'schema_version','context_id',ctx.id,'project_id',ctx.project_id,'work_item_id',ctx.work_item_id,'goal',v->'goal','current_work',v->'current_work','manifest_hash',ctx.sha256,'returned_view_hash',hash,'delta',delta,'latest_updates',preview,'expansion',nav,'coverage',COALESCE(v->'coverage','{}')||jsonb_build_object('authorization_complete',v->'coverage'->'complete','complete',false,'delivery_complete',false,'returned','bounded_navigation'));
 RETURN r-'returned_view'-'delta'-'warnings'||jsonb_build_object('returned_view',compact,'delta',delta,'warnings',jsonb_build_array(jsonb_build_object('code','view_has_more_authorized_content','next_step','expand_fixed_view_or_statement')),'coverage',COALESCE(r->'coverage','{}')||jsonb_build_object('authorization_complete',r->'coverage'->'complete','complete',false,'delivery_complete',false,'returned','bounded_navigation'),'next_step','expand_fixed_view_as_needed');
END $$;

ALTER FUNCTION v8.work_read(uuid,text,text) RENAME TO work_read_full_230;
REVOKE ALL ON FUNCTION v8.work_read_full_230(uuid,text,text) FROM PUBLIC,hub2_v8;
CREATE FUNCTION v8.work_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb;b jsonb;c jsonb;w jsonb;entry jsonb;preview jsonb:='[]';snapshot uuid;projection uuid;original text;nav jsonb;refs jsonb;rels jsonb:='[]';relation jsonb;
BEGIN
 r:=v8.work_read_full_230(h,d,p);IF octet_length(r::text)<=98304 THEN RETURN r;END IF;
 b:=p::jsonb;SELECT to_jsonb(i) INTO c FROM authz.effect_identity(h) i;c:=c||jsonb_build_object('project_id',b->'project_id');w:=r->'work_item';
 original:=v8.canonical_json(r);PERFORM authz.assert_effect(h);INSERT INTO v8.read_projections(project_id,work_item_id,actor_id,client_id,body,canonical_text,sha256) VALUES((b->>'project_id')::uuid,(b->>'work_item_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,r,original,encode(public.digest(original,'sha256'),'hex')) RETURNING id INTO projection;
 nav:=jsonb_build_object('tool','v8.work.history.page','project_id',b->'project_id','work_item_id',b->'work_item_id','kind','updates','full_read',jsonb_build_object('tool','v8.statement.read_chunk','arguments',jsonb_build_object('project_id',b->'project_id','kind','work_view','statement_id',projection)));
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(r->'updates','[]')) WITH ORDINALITY u(value,ord) ORDER BY ord DESC LIMIT 3 LOOP
  preview:=preview||jsonb_build_array(v8.expansion_item('work_update',(entry->>'update_id')::uuid,entry->'statement',entry->>'canonical_text',entry->>'sha256',2048)||jsonb_build_object('work_revision',entry->'work_revision'));
 END LOOP;
 IF octet_length(w::text)>16384 THEN
  original:=v8.canonical_json(w);PERFORM authz.assert_effect(h);
  INSERT INTO v8.work_snapshots(work_item_id,work_revision,record,canonical_text,sha256) VALUES((b->>'work_item_id')::uuid,(w->>'revision')::bigint,w,original,encode(public.digest(original,'sha256'),'hex')) ON CONFLICT DO NOTHING;
  SELECT id INTO snapshot FROM v8.work_snapshots WHERE work_item_id=(b->>'work_item_id')::uuid AND work_revision=(w->>'revision')::bigint;
  w:=w-'explanation'||jsonb_build_object('record_expansion',jsonb_build_object('tool','v8.statement.read_chunk','kind','work_snapshot','statement_id',snapshot));
 END IF;
 SELECT COALESCE(jsonb_agg(value),'[]') INTO refs FROM (SELECT value FROM jsonb_array_elements(COALESCE(r->'fixed_refs','[]')) LIMIT 10) x;
 FOR relation IN SELECT value FROM jsonb_array_elements(COALESCE(r->'relations','[]')) LIMIT 10 LOOP
  rels:=rels||jsonb_build_array(CASE WHEN octet_length(relation::text)<=4096 THEN relation ELSE relation-'basis'||jsonb_build_object('basis_expansion',jsonb_build_object('tool','v8.statement.read_chunk','kind','work_relation','statement_id',relation->'id')) END);
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN r-'work_item'-'updates'-'relations'-'fixed_refs'||jsonb_build_object('work_item',w,'updates',preview,'relations',rels,'fixed_refs',refs,'expansion',nav,'coverage',COALESCE(r->'coverage','{}')||jsonb_build_object('authorization_complete',r->'coverage'->'complete','complete',false,'delivery_complete',false,'returned','bounded_navigation'),'next_step','expand_authorized_history_or_fixed_statements');
END $$;

ALTER FUNCTION v8.context_read(uuid,text,text) RENAME TO context_read_full_230;
REVOKE ALL ON FUNCTION v8.context_read_full_230(uuid,text,text) FROM PUBLIC,hub2_v8;
CREATE FUNCTION v8.context_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb;c jsonb;b jsonb;doc jsonb;
BEGIN
 r:=v8.context_read_full_230(h,d,p);b:=p::jsonb;SELECT to_jsonb(i) INTO c FROM authz.effect_identity(h) i;c:=c||jsonb_build_object('project_id',b->'project_id');doc:=v8.expansion_document(c,'context_manifest',(b->>'context_id')::uuid);
 IF NOT v8.authorize_expansion(h,c,'context_manifest',(b->>'context_id')::uuid,doc) THEN RETURN jsonb_build_object('state','restricted','error_code','source_access_required','coverage',jsonb_build_object('complete',false,'returned','none'),'next_step','materialize_current_clipped_view');END IF;
 IF octet_length(r::text)<=98304 THEN RETURN r;END IF;
 PERFORM authz.assert_effect(h);
 RETURN r-'manifest_canonical_text'-'returned_view'||jsonb_build_object('returned_view',jsonb_build_object('context_id',r->'context_id','manifest_hash',r->'manifest_hash','goal',r->'returned_view'->'goal'),'coverage',COALESCE(r->'coverage','{}')||jsonb_build_object('authorization_complete',r->'coverage'->'complete','complete',false,'delivery_complete',false,'returned','bounded_historical_navigation'),'expansion',jsonb_build_object('tool','v8.statement.read_chunk','kind','context_manifest','statement_id',r->'context_id'),'next_step','read_fixed_original_manifest_in_chunks');
END $$;

REVOKE ALL ON FUNCTION v8.expansion_item(text,uuid,jsonb,text,text,integer),v8.expansion_document(jsonb,text,uuid),v8.authorize_expansion(uuid,jsonb,text,uuid,jsonb),v8.work_history_page_core(uuid,jsonb,jsonb),v8.render_current_view(uuid,jsonb,v8.context_manifests,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION v8.work_history_page(uuid,text,text),v8.statement_read_chunk(uuid,text,text),v8.context_view_page(uuid,text,text),v8.work_read(uuid,text,text),v8.context_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_history_page(uuid,text,text),v8.statement_read_chunk(uuid,text,text),v8.context_view_page(uuid,text,text),v8.work_read(uuid,text,text),v8.context_read(uuid,text,text) TO hub2_v8;
RESET ROLE;
