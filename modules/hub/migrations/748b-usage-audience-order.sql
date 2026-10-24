-- Original2.0 additive repair: retained events survive expired handle metadata.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.usage_context(hid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE h authz.handles;audience text;p jsonb;s record;resources jsonb:='[]';owner_only boolean:=false;draft uuid;operation uuid;source_state text:='unknown';
BEGIN
 audience:=CASE authz.runtime_role() WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 IF audience IS NULL THEN RAISE EXCEPTION 'domain_usage_required' USING ERRCODE='42501';END IF;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 -- Historical observation may outlive handle retention. Keep it unknown, never fabricate an Actor.
 IF h.id IS NULL THEN RETURN NULL;END IF;
 IF h.audience IS DISTINCT FROM audience THEN RAISE EXCEPTION 'usage_audience_mismatch' USING ERRCODE='42501';END IF;
 IF h.consumed_at IS NULL THEN RETURN NULL;END IF;
 p:=COALESCE(h.resource->'resolved_resource',h.resource);
 IF audience='mem' THEN
  SELECT id INTO draft FROM mem.text_drafts WHERE actor_id=h.principal_id AND project_id=h.project_id AND (id::text=p->>'resume_id' OR fingerprint=h.request_digest) LIMIT 1;
  owner_only:=draft IS NOT NULL OR p->>'processing_run_id' IS NOT NULL OR p->>'run_id' IS NOT NULL;
  IF p->>'material_id' IS NULL THEN SELECT material_id INTO operation FROM mem.operations WHERE actor_id=h.principal_id AND project_id=h.project_id AND (id::text=p->>'operation_id' OR fingerprint=h.request_digest) LIMIT 1;END IF;
 END IF;
 resources:=jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role','primary','domain',audience,'project_id',h.project_id,'material_id',COALESCE(p->>'material_id',operation::text),'version_id',p->>'version_id','collection_id',p->>'collection_id','area_id',p->>'area_id','work_item_id',p->>'work_item_id')));
 FOR s IN SELECT resource FROM authz.handle_sources WHERE handle_id=hid LOOP
  resources:=resources||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role','source','domain','mem','project_id',s.resource->'project_id','material_id',s.resource->'material_id','version_id',s.resource->'version_id','collection_id',s.resource->'collection_id','area_id',s.resource->'area_id')));
 END LOOP;
 IF h.source_context_id IS NOT NULL AND EXISTS(SELECT FROM authz.source_contexts WHERE id=h.source_context_id AND provider<>'unknown') THEN source_state:='source_context_bound';END IF;
 RETURN jsonb_build_object('actor_id',h.principal_id,'client_id',h.client_id,'project_id',h.project_id,'source_context_id',h.source_context_id,'source_state',source_state,'resources',resources,'owner_only',owner_only);
END $function$;

RESET ROLE;
