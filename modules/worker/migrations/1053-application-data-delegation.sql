-- Explicit application data delegation: business consent belongs to the application.
ALTER TABLE authz.service_authorizations
 ADD COLUMN application_project_id uuid REFERENCES v8.projects(id),
 ADD COLUMN data_owner_id uuid REFERENCES authz.principals(id),
 ADD CONSTRAINT service_data_owner_binding CHECK ((application_project_id IS NULL)=(data_owner_id IS NULL) AND application_project_id IS DISTINCT FROM project_id);
CREATE INDEX service_data_application ON authz.service_authorizations(service_id,application_project_id) WHERE application_project_id IS NOT NULL;
CREATE OR REPLACE FUNCTION authz.service_deadline(actor uuid, client uuid, project uuid, action text, resource jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE g authz.service_authorizations;p authz.principals;pr record;issuer authz.principals;deadline timestamptz;base authz.service_authorizations;app record;base_issuer authz.principals;
BEGIN
 SELECT * INTO p FROM authz.principals WHERE id=actor;
 SELECT * INTO g FROM authz.service_authorizations WHERE service_id=actor AND project_id=project;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 SELECT * INTO issuer FROM authz.principals WHERE id=g.source_actor_id;
 IF client IS NOT NULL AND NOT EXISTS(SELECT FROM authz.service_clients sc JOIN authz.clients c ON c.id=sc.client_id WHERE sc.client_id=client AND sc.service_id=actor AND c.principal_id=actor AND c.active AND (project=ANY(sc.project_ids) OR g.application_project_id=ANY(sc.project_ids))) THEN RETURN NULL;END IF;
 IF g.application_project_id IS NOT NULL THEN
  SELECT * INTO base FROM authz.service_authorizations WHERE service_id=actor AND project_id=g.application_project_id;
  SELECT * INTO app FROM v8.projects WHERE id=g.application_project_id;
  SELECT * INTO base_issuer FROM authz.principals WHERE id=base.source_actor_id;
  IF pr.owner_id IS DISTINCT FROM g.data_owner_id OR NOT EXISTS(SELECT FROM authz.principals WHERE id=g.data_owner_id AND active AND organization_id=pr.organization_id) OR base.id IS NULL OR NOT base.active OR base.application_project_id IS NOT NULL OR NOT(base.until_revoked OR base.expires_at>clock_timestamp()) OR app.state IS DISTINCT FROM 'active' OR app.organization_id IS DISTINCT FROM pr.organization_id OR base_issuer.active IS DISTINCT FROM true OR base_issuer.organization_id IS DISTINCT FROM pr.organization_id THEN RETURN NULL;END IF;
 END IF;
 IF p.kind IS DISTINCT FROM 'service' OR NOT p.active OR g.id IS NULL OR NOT g.active OR pr.id IS NULL OR pr.state<>'active' OR pr.organization_id<>p.organization_id OR issuer.active IS DISTINCT FROM true OR issuer.organization_id<>p.organization_id OR NOT action=ANY(authz.service_actions(ARRAY['storage','resources','context','work'])) OR NOT authz.selector_matches(g.resource_selector,project,resource) THEN RETURN NULL;END IF;
 deadline:=CASE WHEN g.until_revoked THEN 'infinity'::timestamptz ELSE g.expires_at END;
 IF deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF g.application_project_id IS NULL AND pr.visibility='private' AND pr.owner_id<>actor THEN deadline:=least(deadline,authz.project_privacy_read_deadline(actor,project));IF authz.project_privacy_read_deadline(actor,project) IS NULL THEN RETURN NULL;END IF;END IF;
 IF g.application_project_id IS NOT NULL THEN deadline:=least(deadline,CASE WHEN base.until_revoked THEN 'infinity'::timestamptz ELSE base.expires_at END);END IF;
 RETURN deadline;
END $function$
;

CREATE OR REPLACE FUNCTION authz.client_resource_allowed745(cid uuid, pid uuid, eid uuid DEFAULT NULL::uuid, ename text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE clause jsonb; filters jsonb;scope_pid uuid;
BEGIN
 IF NOT EXISTS(SELECT FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=cid AND c.active AND p.active) THEN RETURN false; END IF;
 IF authz.ordinary_member_client901(cid) THEN RETURN true; END IF;
 scope_pid:=pid;
 IF authz.product_service_client(cid) AND NOT EXISTS(SELECT FROM authz.service_clients WHERE client_id=cid AND pid=ANY(project_ids)) THEN
  SELECT g.application_project_id INTO scope_pid FROM authz.service_authorizations g JOIN authz.service_clients sc ON sc.service_id=g.service_id WHERE sc.client_id=cid AND g.project_id=pid AND g.application_project_id=ANY(sc.project_ids) AND g.active;
  IF scope_pid IS NULL OR authz.service_deadline((SELECT principal_id FROM authz.clients WHERE id=cid),cid,pid,'mem.read',jsonb_build_object('project_id',pid)) IS NULL THEN RETURN false;END IF;
 END IF;
 SELECT clauses INTO filters FROM authz.client_filters745 WHERE client_id=cid;
 FOR clause IN SELECT value FROM jsonb_array_elements(coalesce(filters,'[]'::jsonb)) LOOP
  IF clause ? 'project_ids' AND NOT coalesce(clause->'project_ids' ? scope_pid::text,false) THEN RETURN false; END IF;
  IF clause ? 'allowed_entries' AND (eid IS NOT NULL OR ename IS NOT NULL) AND NOT(coalesce(clause->'allowed_entries' ? eid::text,false) OR coalesce(clause->'allowed_entries' ? ename,false)) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $function$
;

CREATE OR REPLACE FUNCTION authz.service_authorize(proof text, b jsonb, p_key text, p_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;actor uuid;sid uuid;pid uuid;caps text[];expiry timestamptz;unlimited boolean;g authz.service_authorizations;old authz.operations;result jsonb;app_pid uuid;owner uuid;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['project_id','service_id','name','resource_selector','expires_at','until_revoked','application_project_id']<>'{}'::jsonb OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_service_authorization' USING ERRCODE='22023';END IF;
 app_pid:=(b->>'application_project_id')::uuid;
 pid:=(b->>'project_id')::uuid;i:=authz.service_manager(proof,pid);actor:=(i->>'actor_id')::uuid;
 IF NOT b?'service_id' THEN PERFORM authz.require_client_capability(i,'hufu.principal.manage');END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_key,1050));
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF old.principal_id IS NOT NULL THEN IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='40001';END IF;RETURN old.result;END IF;
 IF b?'service_id' THEN
  sid:=(b->>'service_id')::uuid;
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=sid AND kind='service' AND active AND organization_id=(i->>'organization_id')::uuid) THEN RAISE EXCEPTION 'registered_service_identity_required' USING ERRCODE='42501';END IF;
 ELSE
  IF coalesce(length(b->>'name'),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'service_name_required' USING ERRCODE='22023';END IF;
  INSERT INTO authz.principals(organization_id,kind,display_name,role,trusted_source) VALUES((i->>'organization_id')::uuid,'service',b->>'name','member','product_service:'||pid::text||';authorized_by:'||actor::text) RETURNING id INTO sid;
 END IF;
 IF app_pid IS NOT NULL THEN
  IF app_pid=pid THEN RAISE EXCEPTION 'distinct_application_scope_required' USING ERRCODE='22023';END IF;
  PERFORM authz.service_manager(proof,app_pid);
  IF NOT EXISTS(SELECT FROM authz.service_authorizations WHERE service_id=sid AND project_id=app_pid AND application_project_id IS NULL AND active AND (until_revoked OR expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'application_service_authorization_required' USING ERRCODE='42501';END IF;
  SELECT owner_id INTO owner FROM v8.projects WHERE id=pid;
  IF EXISTS(SELECT FROM v8.projects WHERE id=pid AND visibility='private' AND owner_id<>actor) THEN RAISE EXCEPTION 'private_data_owner_delegation_required' USING ERRCODE='42501';END IF;
 END IF;
 caps:=ARRAY['storage','resources','context','work'];
 expiry:=(b->>'expires_at')::timestamptz;unlimited:=coalesce((b->>'until_revoked')::boolean,expiry IS NULL);
 IF caps IS NULL OR cardinality(caps)=0 OR NOT caps<@ARRAY['storage','resources','context','work']::text[] OR (expiry IS NULL)<>unlimited OR expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp()) OR NOT authz.valid_selector(coalesce(b->'resource_selector','{"version":1,"kind":"project"}')) THEN RAISE EXCEPTION 'invalid_service_scope' USING ERRCODE='22023';END IF;
 IF app_pid IS NULL AND EXISTS(SELECT FROM v8.projects WHERE id=pid AND visibility='private' AND owner_id<>sid) AND authz.project_privacy_read_deadline(sid,pid) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.principals WHERE id IN(actor,sid,owner) OR id IN(SELECT source_actor_id FROM authz.service_authorizations WHERE service_id=sid AND project_id=app_pid) ORDER BY id FOR UPDATE;
 PERFORM id FROM v8.projects WHERE id IN(pid,app_pid) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.service_authorizations WHERE service_id=sid AND project_id=app_pid FOR SHARE;
 i:=authz.service_manager(proof,pid);
 IF app_pid IS NOT NULL THEN
  PERFORM authz.service_manager(proof,app_pid);
  IF owner IS DISTINCT FROM (SELECT owner_id FROM v8.projects WHERE id=pid) OR NOT EXISTS(SELECT FROM authz.service_authorizations WHERE service_id=sid AND project_id=app_pid AND application_project_id IS NULL AND active AND (until_revoked OR expires_at>clock_timestamp())) OR EXISTS(SELECT FROM v8.projects WHERE id=pid AND visibility='private' AND owner_id<>actor) THEN RAISE EXCEPTION 'application_scope_changed' USING ERRCODE='40001';END IF;
 END IF;
 INSERT INTO authz.service_authorizations(service_id,project_id,capabilities,resource_selector,source_actor_id,expires_at,until_revoked,application_project_id,data_owner_id) VALUES(sid,pid,caps,coalesce(b->'resource_selector','{"version":1,"kind":"project"}'),actor,expiry,unlimited,app_pid,owner)
 ON CONFLICT(service_id,project_id) DO UPDATE SET application_project_id=EXCLUDED.application_project_id,data_owner_id=EXCLUDED.data_owner_id,capabilities=EXCLUDED.capabilities,resource_selector=EXCLUDED.resource_selector,source_actor_id=EXCLUDED.source_actor_id,expires_at=EXCLUDED.expires_at,until_revoked=EXCLUDED.until_revoked,active=true,revision=authz.service_authorizations.revision+1,updated_at=clock_timestamp() RETURNING * INTO g;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=sid;
 result:=jsonb_build_object('state','authorized','service_id',sid,'project_id',pid,'application_project_id',g.application_project_id,'data_owner_id',g.data_owner_id,'business_authorization',CASE WHEN app_pid IS NULL THEN 'hub_scope' ELSE 'application_managed' END,'authorization_id',g.id,'revision',g.revision,'capabilities',to_jsonb(caps),'actions',to_jsonb(authz.service_actions(caps)),'resource_selector',g.resource_selector,'expires_at',expiry,'until_revoked',unlimited,'authorization_mode','product_service','agent_work_required',false,'operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(i->>'client_id')::uuid,'authz','service.authorize',g.id,result);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',g.id,g.revision,'service.authorize',pid,result);
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION authz.lock_resources(actor uuid, client uuid, credential uuid, resources jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE project_ids uuid[];qids uuid[];people uuid[];origin uuid;fid uuid;
BEGIN
 SELECT array_agg(DISTINCT (r->>'project_id')::uuid) INTO project_ids FROM jsonb_array_elements(resources) r;
 SELECT array_agg(DISTINCT pid) INTO project_ids FROM(SELECT unnest(project_ids) pid UNION SELECT g.application_project_id FROM authz.service_authorizations g WHERE g.service_id=actor AND g.project_id=ANY(project_ids) AND g.application_project_id IS NOT NULL) all_projects;
 SELECT array_agg(id),array_agg(DISTINCT person) INTO qids,people FROM (
  WITH RECURSIVE dependencies AS(SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q WHERE q.project_id=ANY(project_ids) AND q.principal_id=actor UNION SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q JOIN dependencies d ON q.id=d.parent_id)
  SELECT d.id,x.person FROM dependencies d CROSS JOIN LATERAL(VALUES(d.source_actor_id),(d.principal_id)) x(person)) selected;
 SELECT array_agg(DISTINCT person) INTO people FROM(SELECT unnest(coalesce(people,'{}'::uuid[])) person UNION SELECT r.owner_approved_by FROM authz.project_privacy_requests r JOIN v8.projects p ON p.id=r.project_id WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' AND p.visibility='private' AND r.project_epoch=p.epoch UNION SELECT r.supervisor_approved_by FROM authz.project_privacy_requests r JOIN v8.projects p ON p.id=r.project_id WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' AND p.visibility='private' AND r.project_epoch=p.epoch) deps WHERE person IS NOT NULL;
 SELECT array_agg(DISTINCT person) INTO people FROM(SELECT unnest(coalesce(people,'{}'::uuid[])) person UNION SELECT g.source_actor_id FROM authz.service_authorizations g WHERE g.service_id=actor AND g.project_id=ANY(project_ids)) deps;
 SELECT family_id INTO fid FROM authz.credentials WHERE id=credential;
 SELECT origin_credential_id INTO origin FROM authz.refresh_families WHERE id=fid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id=ANY(people) OR id IN(SELECT owner_id FROM v8.projects WHERE id=ANY(project_ids)) OR id IN(SELECT manager_id FROM v8.projects WHERE id=ANY(project_ids)) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client OR id IN(SELECT client_id FROM authz.credentials WHERE id=origin) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=credential OR id=origin ORDER BY id FOR SHARE;
 PERFORM id FROM authz.refresh_families WHERE id=fid FOR SHARE;
 PERFORM id FROM v8.projects WHERE id=ANY(project_ids) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.service_authorizations WHERE service_id=actor AND project_id=ANY(project_ids) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.qualifications WHERE id=ANY(qids) ORDER BY id FOR SHARE;
 PERFORM r.id FROM authz.project_privacy_requests r WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' ORDER BY r.id FOR SHARE;
 PERFORM d.id FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (r->>'version_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'version_id' ~* '^[0-9a-f-]{36}$') ORDER BY d.id FOR SHARE;
 PERFORM id FROM authz.resource_areas WHERE id IN(SELECT (r->>'area_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'area_id' ~ '^[0-9a-f-]{36}$') ORDER BY id FOR SHARE;
END $function$
;

CREATE OR REPLACE FUNCTION authz.service_authorizations_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;items jsonb;pid uuid;sid uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR b-ARRAY['project_id','service_id']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_service_query' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
 IF pid IS NOT NULL AND (i->>'principal_kind')<>'service' THEN PERFORM authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
 ELSIF (i->>'principal_kind')<>'service' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin' AND kind='member') THEN RAISE EXCEPTION 'service_query_manager_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('application_project_id',g.application_project_id,'data_owner_id',g.data_owner_id,'business_authorization',CASE WHEN g.application_project_id IS NULL THEN 'hub_scope' ELSE 'application_managed' END,'authorization_id',g.id,'service_id',g.service_id,'service_name',p.display_name,'project_id',g.project_id,'capabilities',to_jsonb(g.capabilities),'actions',to_jsonb(authz.service_actions(g.capabilities)),'resource_selector',g.resource_selector,'active',g.active,'effective_now',g.active AND (g.until_revoked OR g.expires_at>clock_timestamp()),'revision',g.revision,'expires_at',g.expires_at,'until_revoked',g.until_revoked) ORDER BY g.created_at),'[]') INTO items FROM authz.service_authorizations g JOIN authz.principals p ON p.id=g.service_id WHERE (pid IS NULL OR g.project_id=pid) AND (sid IS NULL OR g.service_id=sid) AND ((i->>'principal_kind')<>'service' OR g.service_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id));
 RETURN jsonb_build_object('state','read','authorization_mode','product_service','items',items,'agent_work_required',false);
END $f$;
