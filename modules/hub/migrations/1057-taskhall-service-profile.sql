SET ROLE hub2_authz_owner;
-- Existing services retain their original capabilities. This profile is opt-in.
ALTER TABLE authz.service_authorizations DROP CONSTRAINT IF EXISTS service_authorizations_capabilities_check;
ALTER TABLE authz.service_authorizations ADD CONSTRAINT service_authorizations_capabilities_check CHECK(cardinality(capabilities)>0 AND capabilities<@ARRAY['storage','resources','context','work','task_board']::text[] AND array_position(capabilities,NULL) IS NULL);
CREATE OR REPLACE FUNCTION authz.service_actions(capabilities text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $f$
 SELECT ARRAY(SELECT DISTINCT action FROM (
 SELECT unnest(ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.correct','mem.discover','mem.read_history']) action WHERE 'storage'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['mem.process','resource.read','resource.write','resource.deploy','hufu.vault.read']) WHERE 'resources'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['v8.project.read','v8.context.read','v8.context.prepare','v8.context.materialize','hufu.baize.members.read']) WHERE 'context'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.handoff.read','v8.handoff.record','v8.experience.publish','v8.experience.read','v8.experience.feedback']) WHERE 'work'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['hufu.taskhall.sso','v8.board.read','v8.board.claim','v8.board.receipt']) WHERE 'task_board'=ANY(capabilities)
 ) actions ORDER BY action)
$f$;

CREATE OR REPLACE FUNCTION authz.service_authorize(proof text, b jsonb, p_key text, p_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;actor uuid;sid uuid;pid uuid;caps text[];expiry timestamptz;unlimited boolean;g authz.service_authorizations;old authz.operations;result jsonb;app_pid uuid;owner uuid;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['project_id','service_id','name','resource_selector','expires_at','until_revoked','application_project_id','profile']<>'{}'::jsonb OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_service_authorization' USING ERRCODE='22023';END IF;
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
 IF b ? 'profile' AND b->>'profile' NOT IN('full_foundation','task_hall') THEN RAISE EXCEPTION 'invalid_service_profile' USING ERRCODE='22023';END IF;
 caps:=CASE WHEN b->>'profile'='task_hall' THEN ARRAY['task_board'] ELSE ARRAY['storage','resources','context','work'] END;
 expiry:=(b->>'expires_at')::timestamptz;unlimited:=coalesce((b->>'until_revoked')::boolean,expiry IS NULL);
 IF caps IS NULL OR cardinality(caps)=0 OR NOT caps<@ARRAY['storage','resources','context','work','task_board']::text[] OR (expiry IS NULL)<>unlimited OR expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp()) OR NOT authz.valid_selector(coalesce(b->'resource_selector','{"version":1,"kind":"project"}')) THEN RAISE EXCEPTION 'invalid_service_scope' USING ERRCODE='22023';END IF;
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


CREATE OR REPLACE FUNCTION authz.service_authorizations_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;items jsonb;pid uuid;sid uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR b-ARRAY['project_id','service_id']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_service_query' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
 IF pid IS NOT NULL AND (i->>'principal_kind')<>'service' THEN PERFORM authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
 ELSIF (i->>'principal_kind')<>'service' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin' AND kind='member') THEN RAISE EXCEPTION 'service_query_manager_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('application_project_id',g.application_project_id,'data_owner_id',g.data_owner_id,'business_authorization',CASE WHEN g.application_project_id IS NULL THEN 'hub_scope' ELSE 'application_managed' END,'authorization_id',g.id,'service_id',g.service_id,'service_name',p.display_name,'project_id',g.project_id,'capabilities',to_jsonb(g.capabilities),'actions',to_jsonb(authz.service_actions(g.capabilities)),'resource_selector',g.resource_selector,'active',g.active,'effective_now',g.active AND (g.until_revoked OR g.expires_at>clock_timestamp()) AND CASE WHEN 'task_board'=ANY(g.capabilities) THEN p.active AND EXISTS(SELECT FROM authz.principals src JOIN v8.projects pr ON pr.id=g.project_id WHERE src.id=g.source_actor_id AND src.active AND src.organization_id=p.organization_id AND pr.organization_id=p.organization_id AND pr.state='active' AND (src.role='organization_admin' OR src.id=pr.manager_id)) ELSE true END,'revision',g.revision,'expires_at',g.expires_at,'until_revoked',g.until_revoked) ORDER BY g.created_at),'[]') INTO items FROM authz.service_authorizations g JOIN authz.principals p ON p.id=g.service_id WHERE (pid IS NULL OR g.project_id=pid) AND (sid IS NULL OR g.service_id=sid) AND ((i->>'principal_kind')<>'service' OR g.service_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id));
 RETURN jsonb_build_object('state','read','authorization_mode','product_service','items',items,'agent_work_required',false);
END $f$;
RESET ROLE;
