-- Full return-ref fences with equivalent request-local owner source binding.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.bind_search_sources_current(hid uuid,resources jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;p authz.principals;cl authz.clients;r jsonb;pr v8.projects;last_project uuid;pid uuid;deadline timestamptz;bound_deadline timestamptz;unlimited boolean;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR authz.runtime_role()<>'hub2_mem' OR h.audience<>'mem' OR h.action<>'mem.read' OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR jsonb_typeof(resources)IS DISTINCT FROM'array' THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;
 -- Ordered current authority locks, request-local only. No cross-request allow result is retained.
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,resources);
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
 IF p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR cl.principal_id IS DISTINCT FROM p.id OR NOT('mem.read'=ANY(cl.actions))THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 bound_deadline:=h.expires_at;
 FOR r IN SELECT value FROM jsonb_array_elements(resources)ORDER BY value->>'project_id',value::text LOOP
  pid:=(r->>'project_id')::uuid;
  IF last_project IS DISTINCT FROM pid THEN
   SELECT * INTO pr FROM v8.projects WHERE id=pid;
   unlimited:=pr.id IS NOT NULL AND pr.kind IN('project','dialogue')AND pr.organization_id=p.organization_id AND(pr.owner_id=p.id OR pr.visibility='team');last_project:=pid;
  END IF;
  -- Project/material/collection/area membership is still checked for every actual resource.
  IF unlimited AND authz.selector_matches('{"version":1,"kind":"project"}',pid,r) THEN deadline:=h.expires_at;
  ELSE deadline:=least(h.expires_at,authz.resource_deadline(h.principal_id,h.client_id,pid,'mem.read',r));END IF;
  INSERT INTO authz.handle_sources(handle_id,project_id,action,resource,project_revision,deadline)VALUES(hid,pid,'mem.read',r,pr.revision,deadline)ON CONFLICT(handle_id,project_id,action,resource)DO UPDATE SET deadline=least(authz.handle_sources.deadline,EXCLUDED.deadline);
  bound_deadline:=least(bound_deadline,deadline);
 END LOOP;
 UPDATE authz.handles SET expires_at=least(expires_at,bound_deadline)WHERE id=hid;
END $$;
REVOKE ALL ON FUNCTION authz.bind_search_sources_current(uuid,jsonb)FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.bind_search_sources_current(uuid,jsonb)TO hub2_mem_owner;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.bind_search_result_sources(h uuid,refs jsonb,actor uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE ref jsonb;output mem.content_versions;resources jsonb:='[]';part jsonb;disclosed boolean;
BEGIN
 -- Same version/provenance/disclosure rules as assert_version_sources; this helper accepts only server-selected full refs.
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  SELECT * INTO output FROM mem.content_versions WHERE id=(ref->>'version_id')::uuid AND material_id=(ref->>'material_id')::uuid AND sha256=ref->>'sha256';
  IF output.id IS NULL OR(output.provenance_state='pending'AND output.actor_id IS DISTINCT FROM actor AND NOT EXISTS(SELECT FROM mem.materials m WHERE m.id=output.material_id AND m.owner_id=actor))THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
  disclosed:=EXISTS(SELECT FROM mem.disclosures d WHERE d.output_version_id=output.id AND d.state='active' AND d.manifest->>'continued_source_access'='not_required');
  SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256)ORDER BY m.project_id,m.id,cv.id),'[]') INTO part FROM mem.source_closure(output.id)cl JOIN mem.content_versions cv ON cv.id=cl.version_id JOIN mem.materials m ON m.id=cv.material_id WHERE NOT disclosed OR cl.version_id=output.id;
  IF jsonb_array_length(part)=0 THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
  resources:=resources||part;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO resources FROM(SELECT DISTINCT value FROM jsonb_array_elements(resources)) unique_resources;
 PERFORM authz.bind_search_sources_current(h,resources);
END $$;
REVOKE ALL ON FUNCTION mem.bind_search_result_sources(uuid,jsonb,uuid) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.search_materials(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb:='[]';candidate record;maximum integer;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 maximum:=LEAST(500,GREATEST(1,COALESCE((b->>'limit')::integer,100)));
 FOR candidate IN SELECT m.id material_id,m.current_version_id version_id,m.content_revision,m.metadata_revision,p.logical_path,cv.sha256 FROM mem.materials m JOIN mem.content_versions cv ON cv.id=m.current_version_id AND cv.material_id=m.id JOIN mem.placements p ON p.material_id=m.id AND p.active
  WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active'
   AND (m.provenance_state<>'pending' OR EXISTS(SELECT 1 FROM mem.content_versions own WHERE own.id=m.current_version_id AND (own.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)))
   AND m.current_version_id IS NOT NULL
   AND (cv.provenance_state<>'pending' OR cv.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)
   AND (COALESCE(b->>'query','')='' OR position(lower(b->>'query') IN lower(p.logical_path))>0 OR EXISTS(SELECT 1 FROM mem.text_index ti WHERE ti.version_id=m.current_version_id AND ti.recipe='zh-character-bigram-v1' AND ti.tokens @@ plainto_tsquery('simple',b->>'token_text')))
   AND m.properties @> COALESCE(b->'properties','{}') ORDER BY m.id LOOP
  IF NOT EXISTS(SELECT 1 FROM mem.source_edges e WHERE e.output_version_id=candidate.version_id) OR mem.search_version_visible((c->>'actor_id')::uuid,candidate.version_id) THEN items:=items||jsonb_build_array(to_jsonb(candidate));IF jsonb_array_length(items)>=maximum THEN EXIT;END IF;END IF;
 END LOOP;
 PERFORM mem.bind_search_result_sources(h,items,(c->>'actor_id')::uuid);
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('items',items,'coverage','ranked_query_not_enumeration','recipe','literal-name-json-zh-character-bigram-v1','processing_pending',true);
END $$;
REVOKE ALL ON FUNCTION mem.search_materials(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.search_materials(uuid,text,text) TO hub2_mem;
RESET ROLE;
