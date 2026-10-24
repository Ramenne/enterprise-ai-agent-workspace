SET ROLE hub2_mem_owner;
CREATE TEMP TABLE materials(id uuid PRIMARY KEY,project_id uuid,state text,current_version_id uuid,provenance_state text,owner_id uuid,file_no bigint,content_revision bigint,metadata_revision bigint,event_revision bigint,importance_level integer DEFAULT 2,properties jsonb,origin_kind text,producer text)ON COMMIT DROP;
CREATE TEMP TABLE content_versions(id uuid,material_id uuid,sha256 text,size bigint,actor_id uuid,created_at timestamptz)ON COMMIT DROP;
CREATE TEMP TABLE placements(id uuid,material_id uuid,project_id uuid,active boolean,logical_path text,revision bigint)ON COMMIT DROP;
CREATE TEMP TABLE projects(id uuid,title text,visibility text)ON COMMIT DROP;
CREATE TEMP TABLE candidate_policy(version_id uuid,visible boolean,allowed boolean)ON COMMIT DROP;
CREATE TEMP TABLE final_policy(revoked boolean)ON COMMIT DROP;
INSERT INTO final_policy VALUES(false);
CREATE FUNCTION pg_temp.guard(uuid,text,text,jsonb)RETURNS jsonb LANGUAGE sql AS $$SELECT '{"project_id":"16f05f01-4a43-4e96-a16b-d8ed69eff77d","actor_id":"cbd510d3-162f-4a62-a3e3-9648cd067297"}'::jsonb$$;
CREATE FUNCTION pg_temp.version_visible(uuid,uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT visible FROM pg_temp.candidate_policy WHERE version_id=$2$$;
CREATE FUNCTION pg_temp.vector_candidate_readable(uuid,uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT allowed FROM pg_temp.candidate_policy WHERE version_id=$2$$;
CREATE FUNCTION pg_temp.material_display_info(uuid,jsonb,jsonb)RETURNS jsonb LANGUAGE sql AS $$SELECT $3||jsonb_build_object('importance_level',2,'description',CASE WHEN ($3->>'file_no')::bigint=110 THEN '{"state":"restricted"}'::jsonb ELSE jsonb_build_object('text','visible description')END,'index_state',CASE WHEN ($3->>'file_no')::bigint=110 THEN 'restricted'ELSE'pending_index'END,'storage',jsonb_build_object('primary_tier','standard'))$$;
CREATE FUNCTION pg_temp.bind_request_sources(uuid,jsonb,uuid,text)RETURNS void LANGUAGE plpgsql AS $$BEGIN IF EXISTS(SELECT FROM jsonb_array_elements($2->'fixed_refs')r JOIN pg_temp.candidate_policy p ON p.version_id=(r->>'version_id')::uuid WHERE(p.visible AND p.allowed)IS DISTINCT FROM true)THEN RAISE EXCEPTION 'unauthorized_reference_bound';END IF;END$$;
CREATE FUNCTION pg_temp.assert_effect(uuid)RETURNS void LANGUAGE plpgsql AS $$BEGIN IF(SELECT revoked FROM pg_temp.final_policy)THEN RAISE EXCEPTION 'synthetic_final_revoke' USING ERRCODE='42501';END IF;END$$;
DO $seed$DECLARE n integer;id uuid;pid uuid:='16f05f01-4a43-4e96-a16b-d8ed69eff77d';actor uuid:='cbd510d3-162f-4a62-a3e3-9648cd067297';BEGIN
 INSERT INTO pg_temp.projects VALUES(pid,'synthetic project','team');
 FOR n IN 1..205 LOOP
  id:=('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  INSERT INTO pg_temp.materials VALUES(id,pid,'active',id,'known',actor,n,1,1,1,2,'{"attributes":{"purpose":"global lookup"}}','member_submission','synthetic');
  INSERT INTO pg_temp.content_versions VALUES(id,id,repeat('a',64),1,actor,'2026-10-18T00:00:00Z');
  INSERT INTO pg_temp.placements VALUES(id,id,pid,true,'sample-'||n||'.txt',1);
  INSERT INTO pg_temp.candidate_policy VALUES(id,CASE WHEN n=2 THEN NULL ELSE true END,n>100);
 END LOOP;
END$seed$;
CREATE FUNCTION pg_temp.workspace_query(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;pid uuid;pr record;r record;item jsonb;rows jsonb:='[]';refs jsonb:='[]';last_key jsonb;inspected integer:=0;visible integer:=0;matched integer:=0;done boolean:=true;lim integer;mode text;ordering text;lev text;actual_tier text;matches boolean;counts jsonb:='{"total":0,"special":0,"1":0,"2":0,"3":0,"unassessed":0,"indexed":0,"archive":0}';
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b)IS DISTINCT FROM'object' OR b-ARRAY['project_id','mode','q','level','storage','index','sort','limit','after','material_ids']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input';END IF;
 mode:=coalesce(b->>'mode','page');ordering:=CASE WHEN mode IN('counts','rows')THEN'number'ELSE coalesce(b->>'sort','importance')END;lim:=coalesce((b->>'limit')::integer,25);
 IF mode NOT IN('page','counts','rows')OR ordering NOT IN('number','recent','importance')OR lim NOT BETWEEN 1 AND 100 OR length(coalesce(b->>'q',''))>512 OR coalesce(b->>'level','all')NOT IN('all','special','1','2','3','unassessed')OR coalesce(b->>'storage','all')NOT IN('all','standard','infrequent','archive','deep_archive')OR coalesce(b->>'index','all')NOT IN('all','indexed','pending','not_required','restricted')THEN RAISE EXCEPTION 'invalid_input';END IF;
 IF b?'after'AND(jsonb_typeof(b->'after')IS DISTINCT FROM'object'OR (b->'after')-ARRAY['rank','time_us','file_no','id']<>'{}'::jsonb OR NOT((b->'after')?&ARRAY['rank','time_us','file_no','id'])OR coalesce(b#>>'{after,time_us}','')!~'^[0-9]{1,20}$'OR coalesce(b#>>'{after,file_no}','')!~'^[0-9]{1,20}$'OR(b#>>'{after,rank}')::integer NOT BETWEEN 0 AND 4)THEN RAISE EXCEPTION 'invalid_cursor';END IF;
 IF mode='rows'THEN
  IF jsonb_typeof(b->'material_ids')IS DISTINCT FROM'array'OR jsonb_array_length(b->'material_ids')NOT BETWEEN 1 AND 100 OR b?'after'THEN RAISE EXCEPTION 'invalid_input';END IF;
 ELSIF b?'material_ids'THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=pg_temp.guard(h,'pg_temp.read',d,b);pid:=(b->>'project_id')::uuid;
 IF pid IS DISTINCT FROM(c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT title,visibility INTO pr FROM pg_temp.projects WHERE id=pid;
 -- Order structural candidates before authorization. No raw-candidate LIMIT is
 -- mistaken for complete search: every yielded scan returns its continuation.
 FOR r IN
  SELECT m.id material_id,v.id version_id,v.sha256,v.size,m.file_no,m.content_revision,m.metadata_revision,m.event_revision,m.properties,m.origin_kind,m.producer,
   CASE WHEN ordering='importance'THEN CASE WHEN m.properties#>>'{governance,special_designation,active}'='true'THEN 0 ELSE coalesce(m.importance_level,4)END ELSE 0 END rank,
   CASE WHEN ordering IN('importance','recent')THEN round(extract(epoch FROM v.created_at)*1000000)ELSE 0 END time_us
  FROM pg_temp.materials m JOIN pg_temp.content_versions v ON v.id=m.current_version_id AND v.material_id=m.id
  WHERE m.project_id=pid AND m.state='active'AND(mode<>'rows'OR m.id IN(SELECT value::uuid FROM jsonb_array_elements_text(b->'material_ids')))AND(m.provenance_state<>'pending'OR v.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)
   AND(NOT(b?'after')OR(
    CASE WHEN ordering='importance'THEN CASE WHEN m.properties#>>'{governance,special_designation,active}'='true'THEN 0 ELSE coalesce(m.importance_level,4)END ELSE 0 END,
    CASE WHEN ordering IN('importance','recent')THEN -round(extract(epoch FROM v.created_at)*1000000)ELSE 0 END,m.file_no::numeric,m.id
   )>((b#>>'{after,rank}')::integer,-(b#>>'{after,time_us}')::numeric,(b#>>'{after,file_no}')::numeric,(b#>>'{after,id}')::uuid))
  ORDER BY rank,time_us DESC,m.file_no,m.id LIMIT 101
 LOOP
  IF inspected=100 THEN done:=false;EXIT;END IF;
  inspected:=inspected+1;last_key:=jsonb_build_object('rank',r.rank,'time_us',r.time_us::text,'file_no',r.file_no::text,'id',r.material_id);
  IF(pg_temp.version_visible((c->>'actor_id')::uuid,r.version_id)AND pg_temp.vector_candidate_readable(h,r.version_id))IS DISTINCT FROM true THEN CONTINUE;END IF;
  item:=to_jsonb(r)-ARRAY['rank','time_us'];
  item:=item||jsonb_build_object('project_id',pid,'project_name',pr.title,'visibility',pr.visibility,'attributes',coalesce(r.properties->'attributes','{}'),'governance',coalesce(r.properties->'governance','{}'),'sort_key',last_key,
   'placements',(SELECT coalesce(jsonb_agg(jsonb_build_object('placement_id',p.id,'logical_path',p.logical_path,'revision',p.revision)ORDER BY p.id),'[]')FROM pg_temp.placements p WHERE p.material_id=r.material_id AND p.project_id=pid AND p.active));
  item:=pg_temp.material_display_info(h,c,item);
  item:=item||jsonb_build_object('path',coalesce(item#>>'{placements,0,logical_path}','未命名资料'));
  item:=item||jsonb_build_object('name',regexp_replace(item->>'path','^.*/',''));
  lev:=CASE WHEN item#>>'{governance,special_designation,active}'='true'THEN'special'ELSE coalesce(item->>'importance_level','unassessed')END;actual_tier:=coalesce(item#>>'{storage,primary_tier}','standard');
  visible:=visible+1;counts:=jsonb_set(counts,ARRAY[lev],to_jsonb(coalesce((counts->>lev)::integer,0)+1));
  IF item->>'index_state'='indexed'THEN counts:=jsonb_set(counts,'{indexed}',to_jsonb((counts->>'indexed')::integer+1));END IF;
  IF actual_tier IN('archive','deep_archive')THEN counts:=jsonb_set(counts,'{archive}',to_jsonb((counts->>'archive')::integer+1));END IF;
  matches:=(coalesce(b->>'level','all')='all'OR b->>'level'=lev)
   AND(coalesce(b->>'storage','all')='all'OR b->>'storage'=actual_tier)
   AND(coalesce(b->>'index','all')='all'OR b->>'index'=item->>'index_state'OR b->>'index'='pending'AND item->>'index_state'IN('missing_description','pending_index','unassessed'))
   AND(coalesce(b->>'q','')=''OR position(lower(b->>'q')IN lower(concat_ws(' ',item->>'file_no',item->>'name',item->>'path',pr.title,item#>>'{description,text}',(item->'attributes')::text)))>0);
  -- Counts disclose only authorized rows; all counted roots and visible descriptions
  -- participate in the same current-source/final-authority fence as returned items.
  refs:=refs||jsonb_build_array(jsonb_build_object('material_id',r.material_id,'version_id',r.version_id,'sha256',r.sha256));
  IF matches THEN matched:=matched+1;IF mode IN('page','rows')THEN rows:=rows||jsonb_build_array(item);END IF;END IF;
  IF mode='page'AND jsonb_array_length(rows)>=lim THEN done:=false;EXIT;END IF;
 END LOOP;
 PERFORM pg_temp.bind_request_sources(h,jsonb_build_object('fixed_refs',refs),(c->>'actor_id')::uuid,'pg_temp.read');PERFORM pg_temp.assert_effect(h);
 counts:=jsonb_set(counts,'{total}',to_jsonb(visible));
 RETURN jsonb_build_object('state','workspace_scan','items',rows,'returned_count',jsonb_array_length(rows),'metrics_batch',counts,'matched_count_batch',matched,'inspected_count',inspected,'scan_complete',done,'next_scan_cursor',CASE WHEN done THEN NULL ELSE last_key END,'observed_at',clock_timestamp(),'coverage',jsonb_build_object('scope','current_authorized_active_materials_in_project','scan_complete',done,'metrics_scope','this_scan_only','consistency','current_each_request;refresh_after_concurrent_changes'),'contract_version','mem-workspace-scan-v1');
END $function$;
DO $checks$DECLARE b jsonb:='{"project_id":"16f05f01-4a43-4e96-a16b-d8ed69eff77d","sort":"number","limit":2}';r jsonb;n integer:=0;v integer:=0;matched integer:=0;denied boolean:=false;BEGIN
 r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF(r->>'inspected_count')::integer<>100 OR r->'items'<>'[]'::jsonb OR(r->>'scan_complete')::boolean OR r#>>'{next_scan_cursor,file_no}'<>'100'THEN RAISE EXCEPTION 'bounded_denied_scan_or_continuation_failed';END IF;
 b:=b||jsonb_build_object('after',r->'next_scan_cursor');r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF r#>>'{items,0,file_no}'<>'101'OR r#>>'{items,1,file_no}'<>'102'OR(r->>'returned_count')::integer<>2 THEN RAISE EXCEPTION 'allowed_results_after_raw_scan_boundary_lost';END IF;
 b:=(b-'after')||'{"mode":"counts","q":"global lookup"}';
 LOOP
  r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
  IF r->'items'<>'[]'::jsonb THEN RAISE EXCEPTION 'count_mode_exports_material_rows';END IF;
  n:=n+(r->>'inspected_count')::integer;v:=v+(r#>>'{metrics_batch,total}')::integer;matched:=matched+(r->>'matched_count_batch')::integer;
  EXIT WHEN(r->>'scan_complete')::boolean;b:=b||jsonb_build_object('after',r->'next_scan_cursor');
 END LOOP;
 IF n<>205 OR v<>105 OR matched<>105 THEN RAISE EXCEPTION 'global_counts_or_end_coverage_wrong';END IF;
 b:=(b-'after')||'{"q":"secret_description_not_disclosed","after":{"rank":0,"time_us":"0","file_no":"100","id":"2aae48d1-1960-4133-a460-de588ac03df4"}}';r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);IF(r->>'matched_count_batch')::integer<>0 THEN RAISE EXCEPTION 'restricted_description_leaked';END IF;
 b:=b||'{"q":"","index":"pending"}';r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF(r->>'matched_count_batch')::integer<>99 OR(r#>>'{metrics_batch,total}')::integer<>100 THEN RAISE EXCEPTION 'pending_filter_or_unfiltered_counts_wrong';END IF;
 b:=(b-'after')||'{"mode":"page","q":"sample-200.txt","index":"all"}';
 r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);b:=b||jsonb_build_object('after',r->'next_scan_cursor');
 r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF(r->>'returned_count')::integer<>1 OR r#>>'{items,0,file_no}'<>'200'THEN RAISE EXCEPTION 'filter_match_after_first_scan_lost';END IF;
 UPDATE pg_temp.materials SET properties=jsonb_set(properties,'{governance}','{"special_designation":{"active":true}}')WHERE file_no=103;
 b:=(b-'after')||'{"q":"","sort":"importance","level":"special"}';r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF r#>>'{items,0,file_no}'<>'103'OR r#>>'{items,0,sort_key,rank}'<>'0'THEN RAISE EXCEPTION 'special_global_order_or_filter_failed';END IF;
 b:=(b-'after')||'{"mode":"rows","q":"","level":"all","material_ids":["07bee254-acd3-4c01-a81e-8a6bb06280b8","c4bfa120-9dae-47e8-add3-1dc16a257ccb","69ebec07-f9ee-4eab-a032-f43c8fd7810b"]}';
 r:=pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF(r->>'returned_count')::integer<>2 OR NOT(r->>'scan_complete')::boolean THEN RAISE EXCEPTION 'exact_rows_authority_filter_or_completeness_failed';END IF;
 b:=b||'{"project_id":"2ece6509-dc82-4d2b-a43b-4e1f04f9ba60"}';BEGIN PERFORM pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;IF NOT denied THEN RAISE EXCEPTION 'project_mismatch_accepted';END IF;
 b:=b||'{"project_id":"16f05f01-4a43-4e96-a16b-d8ed69eff77d"}';UPDATE pg_temp.final_policy SET revoked=true;denied:=false;
 BEGIN PERFORM pg_temp.workspace_query('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;IF NOT denied THEN RAISE EXCEPTION 'final_revoke_accepted';END IF;
END$checks$;
RESET ROLE;
