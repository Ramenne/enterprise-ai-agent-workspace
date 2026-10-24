BEGIN;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.material_use_candidates(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb;days integer:=coalesce((b->>'window_days')::integer,30);n integer:=coalesce((b->>'limit')::integer,30);
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR days NOT BETWEEN 1 AND 3650 OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY x.independent_read_windows DESC,x.last_used_at DESC),'[]')INTO items FROM(
 SELECT m.id material_id,m.file_no::text file_no,m.importance_level,m.file_format,m.properties->'attributes' attributes,m.current_version_id version_id,
 count(DISTINCT(u.actor_id,u.version_id,floor(extract(epoch FROM u.occurred_at)/300)))FILTER(WHERE u.kind='body_read')independent_read_windows,
 count(*)FILTER(WHERE u.kind='adopted')adoptions,count(*)FILTER(WHERE u.kind='reused')reuses,max(u.occurred_at)last_used_at
 FROM mem.materials m JOIN mem.material_use_events u ON u.material_id=m.id WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active' AND u.occurred_at>=clock_timestamp()-make_interval(days=>days) AND mem.version_visible((c->>'actor_id')::uuid,m.current_version_id)
 GROUP BY m.id ORDER BY independent_read_windows DESC,last_used_at DESC,m.id LIMIT n
 )x;
 PERFORM mem.bind_request_sources(h,items,(c->>'actor_id')::uuid,'mem.read');PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','usage_candidates','items',items,'window_days',days,'coverage','recent_instrumented_usage_ranked_top_candidates;not_all_files','automatic_importance_change',false,'next_step','Agent_assesses_actual_use_and_dependencies_then_calls_hub.material.govern;no_human_approval_needed_within_scope','independence','same_actor_version_5_minute_read_windows;not_semantic_task_count');
END $$;
REVOKE ALL ON FUNCTION mem.material_use_candidates(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.material_use_candidates(uuid,text,text)TO hub2_mem;
RESET ROLE;
COMMIT;
