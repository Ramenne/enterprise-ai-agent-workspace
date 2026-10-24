SET ROLE hub2_mem_owner;
DO $precondition$
BEGIN
 IF to_regprocedure('mem.find_material_paths(uuid,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'exact_path_function_already_exists_review_required';END IF;
 IF to_regprocedure('mem.guard(uuid,text,text,jsonb)') IS NULL OR to_regprocedure('mem.version_visible(uuid,uuid)') IS NULL OR to_regprocedure('mem.bind_request_sources(uuid,jsonb,uuid,text)') IS NULL OR to_regprocedure('authz.assert_effect(uuid)') IS NULL THEN RAISE EXCEPTION 'exact_path_authority_dependencies_missing';END IF;
 IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('mem.placements_active_path') AND indisunique AND indisvalid)THEN RAISE EXCEPTION 'exact_path_unique_index_missing';END IF;
END $precondition$;
CREATE FUNCTION mem.find_material_paths(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb;pid uuid;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b)IS DISTINCT FROM'object' OR b-ARRAY['project_id','paths']<>'{}'::jsonb OR jsonb_typeof(b->'paths')IS DISTINCT FROM'array' THEN RAISE EXCEPTION 'invalid_input';END IF;
 IF jsonb_array_length(b->'paths')NOT BETWEEN 1 AND 2 OR EXISTS(SELECT FROM jsonb_array_elements(b->'paths') x WHERE jsonb_typeof(x)IS DISTINCT FROM'string' OR length(x#>>'{}')NOT BETWEEN 1 AND 1024)THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);pid:=(b->>'project_id')::uuid;
 IF pid IS DISTINCT FROM(c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(candidate)-'path_ordinal' ORDER BY candidate.path_ordinal),'[]') INTO items FROM(
  SELECT m.id material_id,v.id version_id,v.sha256,v.size,m.content_revision,m.metadata_revision,p.logical_path,min(w.ordinality)path_ordinal
  FROM jsonb_array_elements_text(b->'paths')WITH ORDINALITY w(path,ordinality)
  JOIN mem.placements p ON p.project_id=pid AND p.logical_path=w.path AND p.active
  JOIN mem.materials m ON m.id=p.material_id AND m.project_id=pid AND m.state='active'
  JOIN mem.content_versions v ON v.id=m.current_version_id AND v.material_id=m.id
  WHERE(m.provenance_state<>'pending' OR v.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)
   AND mem.version_visible((c->>'actor_id')::uuid,v.id)
  GROUP BY m.id,v.id,p.logical_path
 )candidate;
 -- The same source closure and final credential/qualification fences used by domain reads.
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',items),(c->>'actor_id')::uuid,'mem.read');
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('items',items,'returned_count',jsonb_array_length(items),'coverage','complete_requested_exact_active_paths','processing_pending',false);
END $function$;
REVOKE ALL ON FUNCTION mem.find_material_paths(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.find_material_paths(uuid,text,text)TO hub2_mem;
DO $postcondition$
BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='mem.find_material_paths(uuid,text,text)'::regprocedure AND p.prosecdef AND p.proowner='hub2_mem_owner'::regrole AND EXISTS(SELECT FROM unnest(p.proconfig)x WHERE replace(x,' ','')='search_path=pg_catalog,mem')) THEN RAISE EXCEPTION 'exact_path_owner_or_search_path_invalid';END IF;
 IF EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid='mem.find_material_paths(uuid,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')THEN RAISE EXCEPTION 'exact_path_public_execute';END IF;
END $postcondition$;
RESET ROLE;
