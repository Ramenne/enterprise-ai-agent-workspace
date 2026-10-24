-- Filter candidate metadata before authorized statement expansion; actual latest stage still requires current source access.
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.work_search(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb;c jsonb;item record;ref record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;blocked boolean; note record; stage_summary jsonb; stage_match boolean;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('project_id','query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR item IN SELECT w.* FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'cursor' IS NULL OR w.id>(b->>'cursor')::uuid) AND (q='' OR strpos(lower(w.goal),lower(q))>0 OR strpos(lower(w.description),lower(q))>0 OR EXISTS(SELECT FROM v8.work_updates stage WHERE stage.work_item_id=w.id AND stage.work_revision<=w.revision AND strpos(lower(coalesce(stage.payload->>'summary','')),lower(q))>0)) ORDER BY w.id LOOP
  blocked:=NOT v8.authorized_statement(h,c,item.explanation);
  FOR ref IN SELECT jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256) AS value FROM v8.results WHERE work_item_id=item.id LOOP
   IF NOT v8.authorized_ref(h,c,ref.value) THEN blocked:=true;END IF;
  END LOOP;
  stage_summary:=NULL;stage_match:=false;
  FOR note IN SELECT u.* FROM v8.work_updates u WHERE u.work_item_id=item.id AND u.work_revision<=item.revision AND jsonb_typeof(u.payload->'summary')='string' AND length(u.payload->>'summary')>0 ORDER BY u.work_revision DESC LOOP
   IF v8.authorized_statement(h,c,note.payload) THEN
    stage_match:=strpos(lower(note.payload->>'summary'),lower(q))>0;
    stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,'actor_id',note.actor_id,'coverage','latest_currently_authorized_declared_summary_at_view_revision','truncated',length(note.payload->>'summary')>2000);
    EXIT;
   END IF;
  END LOOP;
  IF q<>'' AND strpos(lower(item.goal),lower(q))=0 AND (blocked OR strpos(lower(item.description),lower(q))=0) AND NOT stage_match THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  items:=items||jsonb_build_array(jsonb_build_object('work_item_id',item.id,'short_no',item.short_no,'goal',item.goal,'summary',CASE WHEN blocked THEN NULL ELSE item.description END,'initial_brief',CASE WHEN blocked THEN NULL ELSE item.description END,'current_summary',stage_summary,'summary_semantics','legacy_summary_is_initial_brief;current_summary_is_latest_authorized_stage','state',item.state,'revision',item.revision,'related_assessment',item.related_assessment,'narrative_coverage',CASE WHEN blocked THEN 'restricted_and_omitted' ELSE 'current_authorized' END));
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'summary_semantics','legacy_summary_is_initial_brief;current_summary_is_latest_authorized_stage',
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_work_after_cursor','snapshot',false,'truncated',more,'narrative','current_authorized_only'),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor' ELSE 'read_selected_work_item' END);
END $function$;
RESET ROLE;
