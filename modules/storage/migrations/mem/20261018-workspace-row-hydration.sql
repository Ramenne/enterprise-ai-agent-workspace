SET ROLE hub2_mem_owner;DO $$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='mem.workspace_query(uuid,text,text)'::regprocedure))IS DISTINCT FROM'cd72c39e99384849221133fe3d69e6a5'THEN RAISE EXCEPTION 'workspace_query_source_changed_review_required';END IF;END$$;
CREATE OR REPLACE FUNCTION mem.workspace_query(h uuid,d text,payload text)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $function$
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
 c:=mem.guard(h,'mem.read',d,b);pid:=(b->>'project_id')::uuid;
 IF pid IS DISTINCT FROM(c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT title,visibility INTO pr FROM v8.projects WHERE id=pid;
 -- Order structural candidates before authorization. No raw-candidate LIMIT is
 -- mistaken for complete search: every yielded scan returns its continuation.
 FOR r IN
  SELECT m.id material_id,v.id version_id,v.sha256,v.size,m.file_no,m.content_revision,m.metadata_revision,m.event_revision,m.properties,m.origin_kind,m.producer,
   CASE WHEN ordering='importance'THEN CASE WHEN m.properties#>>'{governance,special_designation,active}'='true'THEN 0 ELSE coalesce(m.importance_level,4)END ELSE 0 END rank,
   CASE WHEN ordering IN('importance','recent')THEN round(extract(epoch FROM v.created_at)*1000000)ELSE 0 END time_us
  FROM mem.materials m JOIN mem.content_versions v ON v.id=m.current_version_id AND v.material_id=m.id
  WHERE m.project_id=pid AND m.state='active'AND(mode<>'rows'OR m.id IN(SELECT value::uuid FROM jsonb_array_elements_text(b->'material_ids')))AND(m.provenance_state<>'pending'OR v.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)
   AND(NOT(b?'after')OR(
    CASE WHEN ordering='importance'THEN CASE WHEN m.properties#>>'{governance,special_designation,active}'='true'THEN 0 ELSE coalesce(m.importance_level,4)END ELSE 0 END,
    CASE WHEN ordering IN('importance','recent')THEN -round(extract(epoch FROM v.created_at)*1000000)ELSE 0 END,m.file_no::numeric,m.id
   )>((b#>>'{after,rank}')::integer,-(b#>>'{after,time_us}')::numeric,(b#>>'{after,file_no}')::numeric,(b#>>'{after,id}')::uuid))
  ORDER BY rank,time_us DESC,m.file_no,m.id LIMIT 101
 LOOP
  IF inspected=100 THEN done:=false;EXIT;END IF;
  inspected:=inspected+1;last_key:=jsonb_build_object('rank',r.rank,'time_us',r.time_us::text,'file_no',r.file_no::text,'id',r.material_id);
  IF(mem.version_visible((c->>'actor_id')::uuid,r.version_id)AND authz.vector_candidate_readable(h,r.version_id))IS DISTINCT FROM true THEN CONTINUE;END IF;
  item:=to_jsonb(r)-ARRAY['rank','time_us'];
  item:=item||jsonb_build_object('project_id',pid,'project_name',pr.title,'visibility',pr.visibility,'attributes',coalesce(r.properties->'attributes','{}'),'governance',coalesce(r.properties->'governance','{}'),'sort_key',last_key,
   'placements',(SELECT coalesce(jsonb_agg(jsonb_build_object('placement_id',p.id,'logical_path',p.logical_path,'revision',p.revision)ORDER BY p.id),'[]')FROM mem.placements p WHERE p.material_id=r.material_id AND p.project_id=pid AND p.active));
  item:=mem.material_display_info(h,c,item);
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
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',refs),(c->>'actor_id')::uuid,'mem.read');PERFORM authz.assert_effect(h);
 counts:=jsonb_set(counts,'{total}',to_jsonb(visible));
 RETURN jsonb_build_object('state','workspace_scan','items',rows,'returned_count',jsonb_array_length(rows),'metrics_batch',counts,'matched_count_batch',matched,'inspected_count',inspected,'scan_complete',done,'next_scan_cursor',CASE WHEN done THEN NULL ELSE last_key END,'observed_at',clock_timestamp(),'coverage',jsonb_build_object('scope','current_authorized_active_materials_in_project','scan_complete',done,'metrics_scope','this_scan_only','consistency','current_each_request;refresh_after_concurrent_changes'),'contract_version','mem-workspace-scan-v1');
END $function$;
RESET ROLE;
