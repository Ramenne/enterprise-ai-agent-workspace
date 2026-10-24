-- Search-specific stable source snapshot. Baseline52 plus500; no shared cache.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.lock_resources_search_nowait(actor uuid,client uuid,credential uuid,resources jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE project_ids uuid[];qids uuid[];people uuid[];origin uuid;fid uuid;
BEGIN
 SELECT array_agg(DISTINCT (r->>'project_id')::uuid) INTO project_ids FROM jsonb_array_elements(resources) r;
 SELECT array_agg(id),array_agg(DISTINCT person) INTO qids,people FROM (
  WITH RECURSIVE dependencies AS(SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q WHERE q.project_id=ANY(project_ids) AND q.principal_id=actor UNION SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q JOIN dependencies d ON q.id=d.parent_id)
  SELECT d.id,x.person FROM dependencies d CROSS JOIN LATERAL(VALUES(d.source_actor_id),(d.principal_id)) x(person)) selected;
 SELECT family_id INTO fid FROM authz.credentials WHERE id=credential;
 SELECT origin_credential_id INTO origin FROM authz.refresh_families WHERE id=fid;
 PERFORM id FROM authz.security_state FOR SHARE NOWAIT;
 PERFORM id FROM authz.principals WHERE id=actor OR id=ANY(people) OR id IN(SELECT owner_id FROM v8.projects WHERE id=ANY(project_ids)) OR id IN(SELECT manager_id FROM v8.projects WHERE id=ANY(project_ids)) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM authz.clients WHERE id=client OR id IN(SELECT client_id FROM authz.credentials WHERE id=origin) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM authz.credentials WHERE id=credential OR id=origin ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM authz.refresh_families WHERE id=fid FOR SHARE NOWAIT;
 PERFORM id FROM v8.projects WHERE id=ANY(project_ids) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM authz.qualifications WHERE id=ANY(qids) ORDER BY id FOR SHARE NOWAIT;
 PERFORM d.id FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (r->>'version_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'version_id' ~* '^[0-9a-f-]{36}$') ORDER BY d.id FOR SHARE NOWAIT;
 PERFORM id FROM authz.resource_areas WHERE id IN(SELECT (r->>'area_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'area_id' ~ '^[0-9a-f-]{36}$') ORDER BY id FOR SHARE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION authz.lock_resources_search_nowait(uuid,uuid,uuid,jsonb) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker,hub2_mem_owner;
CREATE FUNCTION authz.bind_search_sources_current_nowait(hid uuid,resources jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;p authz.principals;cl authz.clients;r jsonb;pr v8.projects;last_project uuid;pid uuid;deadline timestamptz;bound_deadline timestamptz;unlimited boolean;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR authz.runtime_role()<>'hub2_mem' OR h.audience<>'mem' OR h.action<>'mem.read' OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR jsonb_typeof(resources)IS DISTINCT FROM'array' THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;
 -- Ordered current authority locks, request-local only. No cross-request allow result is retained.
 PERFORM authz.lock_resources_search_nowait(h.principal_id,h.client_id,h.credential_id,resources);
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
REVOKE ALL ON FUNCTION authz.bind_search_sources_current_nowait(uuid,jsonb) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.bind_search_sources_current_nowait(uuid,jsonb) TO hub2_mem_owner;
RESET ROLE;

SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.lock_search_source_snapshot(hid uuid,resources jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR authz.runtime_role()<>'hub2_mem' OR h.audience<>'mem' OR h.action<>'mem.read' OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR jsonb_typeof(resources) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;
 -- Same ordered authority/disclosure locks as the existing current binder.
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,resources);
END $$;
REVOKE ALL ON FUNCTION authz.lock_search_source_snapshot(uuid,jsonb) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.lock_search_source_snapshot(uuid,jsonb) TO hub2_mem_owner;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.search_source_snapshot(refs jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 WITH RECURSIVE graph(root,id) AS(
  SELECT (r->>'version_id')::uuid,(r->>'version_id')::uuid FROM jsonb_array_elements(refs)r
  UNION SELECT g.root,e.input_version_id FROM graph g JOIN mem.source_edges e ON e.output_version_id=g.id
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('root_version_id',g.root,'pending_material_id',CASE WHEN cv.provenance_state='pending' THEN cv.material_id END,'resource',jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256)) ORDER BY g.root,g.id),'[]')
 FROM graph g JOIN mem.content_versions cv ON cv.id=g.id JOIN mem.materials m ON m.id=cv.material_id
$$;
REVOKE ALL ON FUNCTION mem.search_source_snapshot(jsonb) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;

CREATE OR REPLACE FUNCTION mem.bind_search_result_sources(h uuid,refs jsonb,actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE before_graph jsonb;after_graph jsonb;resources jsonb;before_disclosure_ids jsonb;locked_disclosures jsonb;after_disclosure_ids jsonb;
BEGIN
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(refs)r LEFT JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid AND cv.material_id=(r->>'material_id')::uuid AND cv.sha256=r->>'sha256' LEFT JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id IS NULL OR m.id IS NULL OR(cv.provenance_state='pending' AND cv.actor_id IS DISTINCT FROM actor AND m.owner_id IS DISTINCT FROM actor)) THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
 before_graph:=mem.search_source_snapshot(refs);
 SELECT coalesce(jsonb_agg(d.id ORDER BY d.id),'[]') INTO before_disclosure_ids FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (g->'resource'->>'version_id')::uuid FROM jsonb_array_elements(before_graph)g);
 SELECT coalesce(jsonb_agg(resource ORDER BY resource::text),'[]') INTO resources FROM(SELECT DISTINCT value->'resource' resource FROM jsonb_array_elements(before_graph))r;
 -- All authority and disclosure locks precede any material lock. Disclosures
 -- are deliberately not used to prune the lock candidates before being locked.
 PERFORM authz.lock_search_source_snapshot(h,resources);
 -- finish_processing takes these materials FOR UPDATE before appending edges.
 -- NOWAIT avoids a cycle with its caller-ordered multi-output material locks.
 -- Existing HTTP maps55P03 to dependency_busy/503/retry_same_request.
 PERFORM m.id FROM mem.materials m WHERE m.id IN(
  SELECT (g->>'pending_material_id')::uuid FROM jsonb_array_elements(before_graph)g WHERE g->>'pending_material_id' IS NOT NULL
 ) ORDER BY m.id FOR SHARE OF m NOWAIT;
 after_graph:=mem.search_source_snapshot(refs);
 -- Row locks cannot lock absence. A newly inserted disclosure is never used
 -- unless it belonged to this lock set; retry if its ID appeared meanwhile.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'output_version_id',d.output_version_id,'state',d.state,'not_required',d.manifest->>'continued_source_access'='not_required') ORDER BY d.id),'[]') INTO locked_disclosures FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (g->'resource'->>'version_id')::uuid FROM jsonb_array_elements(after_graph)g);
 SELECT coalesce(jsonb_agg(x->'id' ORDER BY x->>'id'),'[]') INTO after_disclosure_ids FROM jsonb_array_elements(locked_disclosures)x;
 IF after_disclosure_ids IS DISTINCT FROM before_disclosure_ids THEN RAISE EXCEPTION 'search_disclosure_changed_retry' USING ERRCODE='55P03';END IF;
 IF after_graph IS DISTINCT FROM before_graph THEN
  -- Retry a new transaction; never expand authority locks after materials.
  RAISE EXCEPTION 'search_source_changed_retry' USING ERRCODE='55P03';
 END IF;
 -- Revalidate pending ownership after the lock boundary as well.
 IF EXISTS(SELECT FROM jsonb_array_elements(refs)r JOIN mem.content_versions cv ON cv.id=(r->>'version_id')::uuid JOIN mem.materials m ON m.id=cv.material_id WHERE cv.provenance_state='pending' AND cv.actor_id IS DISTINCT FROM actor AND m.owner_id IS DISTINCT FROM actor) THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(resource ORDER BY resource::text),'[]') INTO resources FROM(
  SELECT DISTINCT g->'resource' resource FROM jsonb_array_elements(after_graph)g
  WHERE g->>'root_version_id'=g->'resource'->>'version_id' OR NOT EXISTS(
   SELECT FROM jsonb_array_elements(locked_disclosures)d WHERE d->>'output_version_id'=g->>'root_version_id' AND d->>'state'='active' AND d->>'not_required'='true'
  )
 )r;
 -- Re-enter current locks only with NOWAIT, including any live-added authority
 -- or ancestor disclosure. Never create a blocking lock expansion here.
 -- Preserve current permissions/TTL and the
 -- caller's original final assert_effect in its original transaction.
 PERFORM authz.bind_search_sources_current_nowait(h,resources);
END $$;
REVOKE ALL ON FUNCTION mem.bind_search_result_sources(uuid,jsonb,uuid) FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
RESET ROLE;
