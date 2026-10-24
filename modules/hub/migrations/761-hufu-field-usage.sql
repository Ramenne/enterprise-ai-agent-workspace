-- Original2.0 Hufu observation. Authentication metadata only, never body Actor.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.hufu_usage_contexts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL,action text NOT NULL,actor_id uuid NOT NULL,client_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(request_id,action));
REVOKE ALL ON authz.hufu_usage_contexts FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
ALTER TABLE authz.hufu_usage_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY hufu_usage_owner ON authz.hufu_usage_contexts TO hub2_authz_owner USING(true) WITH CHECK(true);
CREATE FUNCTION authz.capture_hufu_usage(proof text,request uuid,action text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.hufu_usage_contexts;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' OR request IS NULL OR action IS NULL OR length(action) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'domain_usage_required' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=(i->>'actor_id')::uuid FOR SHARE;i:=authz.authenticate(proof);
 SELECT * INTO r FROM authz.hufu_usage_contexts x WHERE x.request_id=request AND x.action=action;
 IF FOUND THEN IF r.actor_id IS DISTINCT FROM (i->>'actor_id')::uuid OR r.client_id IS DISTINCT FROM (i->>'client_id')::uuid THEN RAISE EXCEPTION 'usage_scope_identity_conflict' USING ERRCODE='23505';END IF;RETURN r.id;END IF;
 INSERT INTO authz.hufu_usage_contexts(request_id,action,actor_id,client_id)VALUES(request,action,(i->>'actor_id')::uuid,(i->>'client_id')::uuid)RETURNING * INTO r;RETURN r.id;
END $$;
CREATE FUNCTION authz.hufu_usage_context(hid uuid,request uuid,action text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE r authz.hufu_usage_contexts;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'usage_audience_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM authz.hufu_usage_contexts WHERE id=hid;
 IF r.id IS NULL THEN RETURN NULL;END IF;
 IF r.request_id IS DISTINCT FROM request OR r.action IS DISTINCT FROM action THEN RAISE EXCEPTION 'usage_request_binding_mismatch' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actor_id',r.actor_id,'client_id',r.client_id,'project_id',NULL,'source_context_id',NULL,'source_state','unknown','resources','[]'::jsonb,'owner_only',true);
END $$;
REVOKE ALL ON FUNCTION authz.capture_hufu_usage(text,uuid,text),authz.hufu_usage_context(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.capture_hufu_usage(text,uuid,text) TO hub2_hufu;
GRANT EXECUTE ON FUNCTION authz.hufu_usage_context(uuid,uuid,text) TO hub2_evidence_owner;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.record_usage_scoped(request uuid, action text, schema_version text, traffic text, success boolean, coverage text, result_count bigint, duration_ms double precision, paths jsonb, handles uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'evidence'
AS $function$
#variable_conflict use_variable
DECLARE hid uuid;c jsonb;actor uuid;client uuid;project uuid;source uuid;resources jsonb:='[]';private boolean:=false;contexts integer:=0;state text:='unknown';source_state text:='unknown';existing evidence.logical_requests;service text;
BEGIN
 IF handles IS NULL OR cardinality(handles)>200 THEN RAISE EXCEPTION 'invalid_usage_handles';END IF;
 service:=CASE authz.runtime_role() WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_hufu' THEN 'hufu' ELSE NULL END;
 IF service IS NULL THEN RAISE EXCEPTION 'domain_usage_required' USING ERRCODE='42501';END IF;
 FOREACH hid IN ARRAY handles LOOP
  IF service='hufu' THEN c:=authz.hufu_usage_context(hid,request,action);ELSE c:=authz.usage_context(hid);END IF;IF c IS NULL THEN CONTINUE;END IF;
  IF contexts=0 THEN actor:=(c->>'actor_id')::uuid;client:=(c->>'client_id')::uuid;project:=(c->>'project_id')::uuid;source:=(c->>'source_context_id')::uuid;source_state:=c->>'source_state';
  ELSIF actor IS DISTINCT FROM (c->>'actor_id')::uuid OR client IS DISTINCT FROM (c->>'client_id')::uuid OR project IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'usage_scope_identity_conflict' USING ERRCODE='23505';END IF;
  IF source IS DISTINCT FROM (c->>'source_context_id')::uuid THEN source:=NULL;source_state:='mixed_or_unknown';END IF;
  resources:=resources||(c->'resources');private:=private OR (c->>'owner_only')::boolean;contexts:=contexts+1;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]') INTO resources FROM (SELECT DISTINCT value FROM jsonb_array_elements(resources)) normalized;
 IF contexts>0 AND jsonb_array_length(resources)<=200 THEN state:='trusted';ELSE resources:='[]';state:='unknown';private:=true;END IF;
 SELECT * INTO existing FROM evidence.logical_requests lr WHERE lr.request_id=request AND lr.service=service AND lr.action=action;
 IF existing.request_id IS NOT NULL AND existing.source_context_id IS DISTINCT FROM source THEN source:=existing.source_context_id;source_state:='mixed_or_unknown';END IF;
 PERFORM evidence.record_usage(request,action,schema_version,source,traffic,success,coverage,result_count,duration_ms,paths);
 SELECT * INTO existing FROM evidence.logical_requests lr WHERE lr.request_id=request AND lr.service=service AND lr.action=action FOR UPDATE;
 IF existing.scope_state='trusted' AND state='trusted' AND (existing.actor_id,existing.client_id,existing.project_id) IS DISTINCT FROM (actor,client,project) THEN RAISE EXCEPTION 'logical_request_scope_conflict' USING ERRCODE='23505';END IF;
 IF existing.scope_state<>'trusted' OR state='trusted' THEN UPDATE evidence.logical_requests lr SET actor_id=actor,client_id=client,project_id=project,authority_resources=resources,owner_only=private,scope_state=state,source_state=source_state,success=lr.success OR success WHERE lr.request_id=request AND lr.service=service AND lr.action=action;END IF;
END $function$;


REVOKE ALL ON FUNCTION evidence.record_usage_scoped(uuid,text,text,text,boolean,text,bigint,double precision,jsonb,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.record_usage_scoped(uuid,text,text,text,boolean,text,bigint,double precision,jsonb,uuid[]) TO hub2_hufu;
RESET ROLE;
