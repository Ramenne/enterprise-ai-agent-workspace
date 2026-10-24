-- v5.1: preserve existing work domain; fix candidate query and publish current stage separately from legacy initial brief.
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.related_candidates(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); ref jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.related_candidates',d,b);
FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(b->'fixed_refs','[]'::jsonb)) LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(candidate_row)),'[]') INTO r FROM (
 SELECT w.id AS work_item_id,w.short_no,w.goal,w.revision,
 EXISTS(SELECT 1 FROM v8.results rr JOIN jsonb_array_elements(coalesce(b->'fixed_refs','[]'::jsonb)) f ON rr.material_id=(f->>'material_id')::uuid AND rr.version_id=(f->>'version_id')::uuid AND rr.sha256=f->>'sha256' WHERE rr.work_item_id=w.id AND mem.version_visible((c->>'actor_id')::uuid,rr.version_id)) AS shared_fixed_reference,
 EXISTS(SELECT 1 FROM v8.work_relations rel WHERE ((rel.from_work_id=w.id AND rel.to_work_id=(b->>'work_item_id')::uuid) OR (rel.to_work_id=w.id AND rel.from_work_id=(b->>'work_item_id')::uuid)) AND rel.state='active' AND NOT EXISTS(SELECT 1 FROM v8.work_relations n WHERE n.supersedes=rel.id)) AS direct_relation
 FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND w.id IS DISTINCT FROM (b->>'work_item_id')::uuid AND authz.can_read((c->>'actor_id')::uuid,w.project_id)
 AND (b->>'since' IS NULL OR w.created_at>=(b->>'since')::timestamptz) AND (b->>'until' IS NULL OR w.created_at<=(b->>'until')::timestamptz)
 AND (jsonb_array_length(coalesce(b->'participants','[]'::jsonb))=0 OR w.actor_id IN(SELECT value::uuid FROM jsonb_array_elements_text(coalesce(b->'participants','[]'::jsonb))))
 AND (COALESCE(b->>'query','')='' OR w.goal ILIKE '%'||(b->>'query')||'%')
 ORDER BY shared_fixed_reference DESC,direct_relation DESC,w.updated_at DESC,w.id LIMIT LEAST(COALESCE((b->>'limit')::integer,10),50) OFFSET COALESCE((b->>'cursor')::integer,0)) candidate_row;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','candidates','items',r,'next_cursor',CASE WHEN jsonb_array_length(r)=COALESCE((b->>'limit')::integer,10) THEN COALESCE((b->>'cursor')::integer,0)+jsonb_array_length(r) ELSE NULL END,'coverage','current_authorized_candidates','next_step','agent_select_and_supply_direct_basis');
END $function$;
CREATE OR REPLACE FUNCTION v8.work_search(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb;c jsonb;item record;ref record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;blocked boolean; note record; stage_summary jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('project_id','query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR item IN SELECT w.* FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'cursor' IS NULL OR w.id>(b->>'cursor')::uuid) ORDER BY w.id LOOP
  blocked:=NOT v8.authorized_statement(h,c,item.explanation);
  FOR ref IN SELECT jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256) AS value FROM v8.results WHERE work_item_id=item.id LOOP
   IF NOT v8.authorized_ref(h,c,ref.value) THEN blocked:=true;END IF;
  END LOOP;
  stage_summary:=NULL;
  FOR note IN SELECT u.* FROM v8.work_updates u WHERE u.work_item_id=item.id AND u.work_revision<=item.revision AND jsonb_typeof(u.payload->'summary')='string' AND length(u.payload->>'summary')>0 ORDER BY u.work_revision DESC LOOP
   IF v8.authorized_statement(h,c,note.payload) THEN
    stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,'actor_id',note.actor_id,'coverage','latest_currently_authorized_declared_summary_at_view_revision','truncated',length(note.payload->>'summary')>2000);
    EXIT;
   END IF;
  END LOOP;
  IF q<>'' AND strpos(lower(item.goal),lower(q))=0 AND (blocked OR strpos(lower(item.description),lower(q))=0) AND strpos(lower(coalesce(stage_summary->>'text','')),lower(q))=0 THEN CONTINUE;END IF;
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
REVOKE ALL ON FUNCTION v8.related_candidates(uuid,text,text),v8.work_search(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.related_candidates(uuid,text,text),v8.work_search(uuid,text,text) TO hub2_v8;
RESET ROLE;
