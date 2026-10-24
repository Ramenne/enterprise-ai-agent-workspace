BEGIN;
SET ROLE hub2_v8_owner;
-- Filter candidates without growing handle_sources. This is private metadata
-- selection only; page-returned narrative refs are sealed together below.
CREATE OR REPLACE FUNCTION v8.work_search_ref_visible(c jsonb,ref jsonb)RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$SELECT mem.work_search_ref_visible((c->>'actor_id')::uuid,(c->>'client_id')::uuid,ref)$$;
CREATE OR REPLACE FUNCTION v8.work_search_statement_visible(c jsonb,statement jsonb,cache jsonb)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE ref jsonb;k text;allowed boolean;BEGIN
 FOR ref IN SELECT DISTINCT value FROM v8.ref_inputs(statement)value LOOP
  k:=jsonb_build_array(ref->>'material_id',ref->>'version_id',ref->>'sha256')::text;
  IF cache?k THEN allowed:=(cache->>k)::boolean;ELSE allowed:=v8.work_search_ref_visible(c,ref);cache:=cache||jsonb_build_object(k,allowed);END IF;
  IF NOT allowed THEN RETURN jsonb_build_object('visible',false,'cache',cache);END IF;
 END LOOP;
 RETURN jsonb_build_object('visible',true,'cache',cache);
END $$;
CREATE OR REPLACE FUNCTION v8.work_search(h uuid,d text,p text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;item record;ref record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;blocked boolean;note record;stage_summary jsonb;stage_match boolean;number_match bigint;page_refs jsonb:='[]';item_refs jsonb;stage_refs jsonb;visible boolean;visibility_cache jsonb:='{}';decision jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b)key WHERE key NOT IN('project_id','query','limit','cursor'))THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=coalesce((b->>'limit')::integer,20);q:=coalesce(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 IF q~*'^(W-|#)[0-9]{1,19}$'THEN number_match:=regexp_replace(q,'^(W-|#)','','i')::bigint;END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR item IN SELECT w.* FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND(b->>'cursor'IS NULL OR w.id>(b->>'cursor')::uuid)
 AND((number_match IS NOT NULL AND w.short_no=number_match)OR(number_match IS NULL AND(q=''OR strpos(lower(w.goal),lower(q))>0 OR strpos(lower(w.description),lower(q))>0 OR EXISTS(SELECT FROM v8.work_updates stage WHERE stage.work_item_id=w.id AND stage.work_revision<=w.revision AND strpos(lower(coalesce(stage.payload->>'summary','')),lower(q))>0))))ORDER BY w.id LOOP
  decision:=v8.work_search_statement_visible(c,item.explanation,visibility_cache);visibility_cache:=decision->'cache';blocked:=NOT(decision->>'visible')::boolean;
  SELECT coalesce(jsonb_agg(value),'[]')INTO item_refs FROM(SELECT DISTINCT jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256)AS value FROM v8.results WHERE work_item_id=item.id)refs;
  IF NOT blocked THEN decision:=v8.work_search_statement_visible(c,jsonb_build_object('outputs',item_refs),visibility_cache);visibility_cache:=decision->'cache';blocked:=NOT(decision->>'visible')::boolean;END IF;
  stage_summary:=NULL;stage_match:=false;stage_refs:='[]';
  FOR note IN SELECT u.* FROM v8.work_updates u WHERE u.work_item_id=item.id AND u.work_revision<=item.revision AND jsonb_typeof(u.payload->'summary')='string'AND length(u.payload->>'summary')>0 ORDER BY u.work_revision DESC LOOP
   decision:=v8.work_search_statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
   IF(decision->>'visible')::boolean THEN
    stage_match:=strpos(lower(note.payload->>'summary'),lower(q))>0;
    stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,'actor_id',note.actor_id,'coverage','latest_currently_authorized_declared_summary_at_view_revision','truncated',length(note.payload->>'summary')>2000);
    SELECT coalesce(jsonb_agg(value),'[]')INTO stage_refs FROM v8.ref_inputs(note.payload)value;EXIT;
   END IF;
  END LOOP;
  IF number_match IS NULL AND q<>''AND strpos(lower(item.goal),lower(q))=0 AND(blocked OR strpos(lower(item.description),lower(q))=0)AND NOT stage_match THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  IF NOT blocked THEN SELECT item_refs||coalesce(jsonb_agg(value),'[]')INTO item_refs FROM v8.ref_inputs(item.explanation)value;page_refs:=page_refs||item_refs;END IF;
  page_refs:=page_refs||stage_refs;
  items:=items||jsonb_build_array(jsonb_build_object('work_item_id',item.id,'short_no',item.short_no,'goal',item.goal,'summary',CASE WHEN blocked THEN NULL ELSE item.description END,'work_description',CASE WHEN blocked THEN NULL ELSE item.description END,'current_summary',stage_summary,'summary_semantics','legacy_summary_is_work_description;current_summary_is_latest_authorized_stage','state',item.state,'revision',item.revision,'related_assessment',item.related_assessment,'narrative_coverage',CASE WHEN blocked THEN'restricted_and_omitted'ELSE'current_authorized'END));
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO page_refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(page_refs))unique_refs;
 IF jsonb_array_length(page_refs)>0 THEN PERFORM mem.bind_search_result_sources(h,page_refs,(c->>'actor_id')::uuid);END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,'summary_semantics','legacy_summary_is_work_description;current_summary_is_latest_authorized_stage','coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_work_after_cursor','snapshot',false,'truncated',more,'narrative','current_authorized_only'),'next_step',CASE WHEN more THEN'continue_with_next_cursor'ELSE'read_selected_work_item'END);
END $$;
REVOKE ALL ON FUNCTION v8.work_search_ref_visible(jsonb,jsonb),v8.work_search_statement_visible(jsonb,jsonb,jsonb)FROM PUBLIC,hub2_v8,hub2_hufu,hub2_mem;
GRANT EXECUTE ON FUNCTION v8.work_search_ref_visible(jsonb,jsonb),v8.work_search_statement_visible(jsonb,jsonb,jsonb)TO hub2_v8_owner;
REVOKE ALL ON FUNCTION v8.work_search(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_search(uuid,text,text)TO hub2_v8;
RESET ROLE;
COMMIT;
