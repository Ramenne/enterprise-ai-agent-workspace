-- Ordered candidates stop only after the requested visible result count.
-- Each source still receives a current authority check. No allow-result cache.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.search_can_read_resource(actor uuid,project uuid,r jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 -- Exact unlimited mem.read branch from resource_deadline (170): current
 -- principal/org/project/client and resource validation are retained per call.
 IF EXISTS(SELECT 1 FROM authz.principals p JOIN v8.projects pr ON pr.id=project
   WHERE p.id=actor AND p.active AND p.organization_id=pr.organization_id
    AND pr.kind IN('project','dialogue') AND (pr.owner_id=actor OR pr.visibility='team')
    AND EXISTS(SELECT 1 FROM authz.clients c WHERE c.principal_id=actor AND c.active AND 'mem.read'=ANY(c.actions))
    AND authz.selector_matches('{"version":1,"kind":"project"}',project,r)) THEN RETURN true;END IF;
 -- Finite, set, parent and management-derived grants keep their original path.
 RETURN authz.can_read_resource(actor,project,r);
END $$;
REVOKE ALL ON FUNCTION authz.search_can_read_resource(uuid,uuid,jsonb) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.search_can_read_resource(uuid,uuid,jsonb) TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.search_version_visible(actor uuid,v uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT EXISTS(SELECT 1 FROM mem.content_versions cv WHERE cv.id=v AND (cv.provenance_state<>'pending' OR cv.actor_id=actor OR EXISTS(SELECT 1 FROM mem.materials m WHERE m.id=cv.material_id AND m.owner_id=actor)))
 AND (EXISTS(SELECT 1 FROM mem.disclosures d JOIN mem.content_versions cv ON cv.id=d.output_version_id JOIN mem.materials m ON m.id=cv.material_id WHERE d.output_version_id=v AND d.state='active' AND d.audience_project_id=m.project_id AND d.manifest->>'continued_source_access'='not_required' AND authz.search_can_read_resource(actor,m.project_id,jsonb_build_object('project_id',m.project_id,'material_id',m.id)))
 OR NOT EXISTS(SELECT 1 FROM mem.source_closure(v) c JOIN mem.content_versions cv ON cv.id=c.version_id JOIN mem.materials m ON m.id=cv.material_id WHERE NOT authz.search_can_read_resource(actor,m.project_id,jsonb_build_object('project_id',m.project_id,'material_id',m.id))))
$$;
REVOKE ALL ON FUNCTION mem.search_version_visible(uuid,uuid) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE OR REPLACE FUNCTION mem.search_materials(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb:='[]';candidate record;maximum integer;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 maximum:=LEAST(500,GREATEST(1,COALESCE((b->>'limit')::integer,100)));
 FOR candidate IN SELECT m.id material_id,m.current_version_id version_id,m.content_revision,m.metadata_revision,p.logical_path FROM mem.materials m JOIN mem.placements p ON p.material_id=m.id AND p.active
  WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active'
   AND (m.provenance_state<>'pending' OR EXISTS(SELECT 1 FROM mem.content_versions own WHERE own.id=m.current_version_id AND (own.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)))
   AND m.current_version_id IS NOT NULL
   AND (COALESCE(b->>'query','')='' OR position(lower(b->>'query') IN lower(p.logical_path))>0 OR EXISTS(SELECT 1 FROM mem.text_index ti WHERE ti.version_id=m.current_version_id AND ti.recipe='zh-character-bigram-v1' AND ti.tokens @@ plainto_tsquery('simple',b->>'token_text')))
   AND m.properties @> COALESCE(b->'properties','{}') ORDER BY m.id LOOP
  IF mem.search_version_visible((c->>'actor_id')::uuid,candidate.version_id) THEN items:=items||jsonb_build_array(to_jsonb(candidate));IF jsonb_array_length(items)>=maximum THEN EXIT;END IF;END IF;
 END LOOP;
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',items),(c->>'actor_id')::uuid,'mem.read');
 PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('items',items,'coverage','ranked_query_not_enumeration','recipe','literal-name-json-zh-character-bigram-v1','processing_pending',true);
END $$;
REVOKE ALL ON FUNCTION mem.search_materials(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.search_materials(uuid,text,text) TO hub2_mem;
RESET ROLE;
