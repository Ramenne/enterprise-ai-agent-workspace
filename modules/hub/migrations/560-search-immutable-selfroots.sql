-- Request-local fast path for fixed nonpending versions without input edges.
-- Their complete source closure is exactly their own fixed version. No material
-- lock or disclosure waiver is required; current source auth/TTL/final remain.
SET ROLE hub2_mem_owner;
DO $$
DECLARE body text;needle text:='before_graph:=mem.search_source_snapshot(refs);';fast text:=$fast$
 -- All refs were validated above. Existing nonpending versions never receive
 -- input edges in a later business transaction (publication creates new refs).
 IF NOT EXISTS(
  SELECT FROM jsonb_array_elements(refs)r JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid
  WHERE cv.provenance_state='pending' OR EXISTS(SELECT FROM mem.source_edges e WHERE e.output_version_id=cv.id)
 ) THEN
  SELECT coalesce(jsonb_agg(resource ORDER BY resource::text),'[]') INTO resources FROM(
   SELECT DISTINCT jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256) resource
   FROM jsonb_array_elements(refs)r JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid JOIN mem.materials m ON m.id=cv.material_id
  ) fixed_self_roots;
  -- Full current authority/selector/deadline binding; all reentrant locks use
  -- the reviewed NOWAIT algorithm. Caller still executes original assert_effect.
  PERFORM authz.bind_search_sources_current_nowait(h,resources);
  -- Recheck the complete eligibility and exact locked root resources in one
  -- post-lock SQL snapshot. If a publication/finish or resource move changed
  -- the selected fixed source set, roll back; never return an unbound root.
  IF EXISTS(
   SELECT FROM jsonb_array_elements(refs)r
   LEFT JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid
    AND cv.material_id=(r->>'material_id')::uuid AND cv.sha256=r->>'sha256'
   LEFT JOIN mem.materials m ON m.id=cv.material_id
   WHERE cv.id IS NULL OR m.id IS NULL OR cv.provenance_state='pending'
    OR EXISTS(SELECT FROM mem.source_edges e WHERE e.output_version_id=cv.id)
    OR NOT resources @> jsonb_build_array(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256))
  ) THEN RAISE EXCEPTION 'search_self_roots_changed_retry' USING ERRCODE='55P03';END IF;
  RETURN;
 END IF;
$fast$;
BEGIN
 SELECT pg_get_functiondef('mem.bind_search_result_sources(uuid,jsonb,uuid)'::regprocedure) INTO body;
 IF length(body)-length(replace(body,needle,''))<>length(needle) THEN RAISE EXCEPTION 'search560_baseline_mismatch';END IF;
 EXECUTE replace(body,needle,fast||needle);
END $$;
RESET ROLE;
