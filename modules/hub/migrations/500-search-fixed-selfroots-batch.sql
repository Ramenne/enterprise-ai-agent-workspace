-- Request-local set-based validation and collection of exact fixed self roots.
-- No shared allow cache, permission changes, or final-effect bypass.
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.bind_search_result_sources(h uuid,refs jsonb,actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE roots jsonb;resources jsonb;ref jsonb;output mem.content_versions;part jsonb;disclosed boolean;
BEGIN
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501'; END IF;
 -- Validate every selected ref in one join, including SHA and current pending
 -- producer/owner. ordinality ensures missing/duplicate refs aren't dropped.
 IF EXISTS(
  SELECT FROM jsonb_array_elements(refs) r
  LEFT JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid
   AND cv.material_id=(r->>'material_id')::uuid AND cv.sha256=r->>'sha256'
  LEFT JOIN mem.materials m ON m.id=cv.material_id
  WHERE cv.id IS NULL OR m.id IS NULL OR
   (cv.provenance_state='pending' AND cv.actor_id IS DISTINCT FROM actor AND m.owner_id IS DISTINCT FROM actor)
 ) THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
 -- With no input edge source_closure is exactly the version itself. Batch the
 -- same complete refs; edge-bearing roots retain the full original algorithm.
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256) ORDER BY m.project_id,m.id,cv.id),'[]') INTO resources
 FROM jsonb_array_elements(refs) r JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid
  JOIN mem.materials m ON m.id=cv.material_id
 WHERE NOT EXISTS(SELECT FROM mem.source_edges e WHERE e.output_version_id=cv.id);
 FOR ref IN SELECT r.value FROM jsonb_array_elements(refs)r
  WHERE EXISTS(SELECT FROM mem.source_edges e WHERE e.output_version_id=(r.value->>'version_id')::uuid) LOOP
  SELECT * INTO output FROM mem.content_versions WHERE id=(ref->>'version_id')::uuid;
  disclosed:=EXISTS(SELECT FROM mem.disclosures d WHERE d.output_version_id=output.id AND d.state='active' AND d.manifest->>'continued_source_access'='not_required');
  SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256) ORDER BY m.project_id,m.id,cv.id),'[]') INTO part
   FROM mem.source_closure(output.id)cl JOIN mem.content_versions cv ON cv.id=cl.version_id JOIN mem.materials m ON m.id=cv.material_id
   WHERE NOT disclosed OR cl.version_id=output.id;
  IF jsonb_array_length(part)=0 THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
  resources:=resources||part;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO resources
  FROM(SELECT DISTINCT value FROM jsonb_array_elements(resources)) unique_resources;
 -- Existing490 current locks/selectors/finite grant deadlines and all final
 -- source checks remain exact; no caller can execute this private helper.
 PERFORM authz.bind_search_sources_current(h,resources);
END $$;
REVOKE ALL ON FUNCTION mem.bind_search_result_sources(uuid,jsonb,uuid) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
RESET ROLE;
