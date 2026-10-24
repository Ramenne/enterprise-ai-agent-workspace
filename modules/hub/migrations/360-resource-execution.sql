-- Candidate only. Additive: does not replace 350 canonical resolver or 330 writer.
-- Registry configuration comes from privileged installation, never ordinary Agent input.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.resource_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL,
 transport text NOT NULL CHECK(transport IN('local','restricted_ssh')),
 active boolean NOT NULL DEFAULT true, epoch bigint NOT NULL DEFAULT 1);
CREATE TABLE authz.resource_execution_targets (
 area_id uuid PRIMARY KEY REFERENCES authz.resource_areas(id),
 endpoint_id uuid NOT NULL REFERENCES authz.resource_endpoints(id),
 environment text NOT NULL DEFAULT 'none',
 operations text[] NOT NULL CHECK(cardinality(operations)>0 AND operations<@ARRAY['read','write','deploy']::text[]),
 root_fingerprint text NOT NULL, active boolean NOT NULL DEFAULT true, epoch bigint NOT NULL DEFAULT 1);
CREATE TABLE authz.resource_execution_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL, client_id uuid NOT NULL,
 credential_id uuid NOT NULL, endpoint_id uuid NOT NULL, area_id uuid NOT NULL,
 action text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 phase text NOT NULL CHECK(phase IN('start','effect')), area_epoch bigint NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(), deadline timestamptz NOT NULL);
CREATE FUNCTION authz.resource_execution_check(p_hash text, b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb; actor uuid; client uuid; credential uuid; project uuid; area uuid;
 a authz.resource_areas; t authz.resource_execution_targets; e authz.resource_endpoints;
 pr record; q record; expiry timestamptz; action text; check_id uuid; deadline timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object' OR
  NOT b ?& ARRAY['project_id','area_id','endpoint_id','operation','request_hash','phase'] OR
  b - ARRAY['project_id','area_id','endpoint_id','operation','environment','request_hash','phase'] <> '{}'::jsonb OR
  b->>'request_hash' !~ '^[0-9a-f]{64}$' OR b->>'phase' NOT IN('start','effect') OR
  b->>'operation' NOT IN('read','write','deploy') THEN RAISE EXCEPTION 'invalid_execution_check' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid; credential:=(identity->>'credential_id')::uuid;
 project:=(b->>'project_id')::uuid; area:=(b->>'area_id')::uuid;
 PERFORM authz.lock_resources(actor,client,credential,jsonb_build_array(jsonb_build_object('project_id',project,'area_id',area)));
 -- Reauthenticate under current authority fences, including family revocation.
 identity:=authz.authenticate(p_hash);
 action:='resource.'||(b->>'operation');
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND kind='member' AND active) THEN RAISE EXCEPTION 'member_required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM authz.clients WHERE id=client AND active AND action=ANY(actions)) THEN RAISE EXCEPTION 'client_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM authz.resource_areas WHERE id=area;
 SELECT * INTO t FROM authz.resource_execution_targets WHERE area_id=area FOR SHARE;
 SELECT * INTO e FROM authz.resource_endpoints WHERE id=t.endpoint_id FOR SHARE;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 IF a.id IS NULL OR a.project_id IS DISTINCT FROM project OR a.active IS DISTINCT FROM true OR t.active IS DISTINCT FROM true OR e.active IS DISTINCT FROM true OR
  e.id IS DISTINCT FROM (b->>'endpoint_id')::uuid OR t.environment IS DISTINCT FROM COALESCE(b->>'environment','none') OR NOT(b->>'operation'=ANY(t.operations)) OR
  pr.id IS NULL OR pr.state<>'active' OR pr.organization_id IS DISTINCT FROM (identity->>'organization_id')::uuid THEN RAISE EXCEPTION 'execution_target_forbidden' USING ERRCODE='42501'; END IF;
 -- A team-readable project does not imply OS execution permission. Require real work qualification.
 deadline:=NULL;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=actor AND project_id=project AND kind='work' ORDER BY id LOOP
  expiry:=authz.qualification_deadline(q.id,actor,project,action,jsonb_build_object('project_id',project,'area_id',area));
  IF expiry IS NOT NULL THEN deadline:=expiry; EXIT; END IF;
 END LOOP;
 IF deadline IS NULL THEN RAISE EXCEPTION 'resource_scope_forbidden' USING ERRCODE='42501'; END IF;
 deadline:=least(deadline,CASE WHEN (identity->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (identity->>'expires_at')::timestamptz END,clock_timestamp()+interval '2 seconds');
 INSERT INTO authz.resource_execution_checks(actor_id,client_id,credential_id,endpoint_id,area_id,action,request_hash,phase,area_epoch,deadline)
 VALUES(actor,client,credential,e.id,area,action,b->>'request_hash',b->>'phase',a.epoch,deadline) RETURNING id INTO check_id;
 RETURN jsonb_build_object('state','authorized','actor_id',actor,'client_id',client,'credential_id',credential,
 'project_id',project,'area_id',area,'area_epoch',a.epoch,'target_epoch',t.epoch,'endpoint_id',e.id,'endpoint_epoch',e.epoch,
 'root_fingerprint',t.root_fingerprint,'environment',t.environment,'action',action,'request_hash',b->>'request_hash','phase',b->>'phase','check_id',check_id,'deadline',deadline,'effect_window_seconds',2);
END $$;
REVOKE ALL ON authz.resource_endpoints,authz.resource_execution_targets,authz.resource_execution_checks FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
REVOKE ALL ON FUNCTION authz.resource_execution_check(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resource_execution_check(text,jsonb) TO hub2_hufu;
RESET ROLE;
