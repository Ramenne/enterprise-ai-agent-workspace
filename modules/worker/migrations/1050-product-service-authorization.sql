-- Product services use explicit resource authorization, independently of Agent work qualifications.
CREATE TABLE authz.service_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 service_id uuid NOT NULL REFERENCES authz.principals(id),
 project_id uuid NOT NULL REFERENCES v8.projects(id),
 capabilities text[] NOT NULL,
 resource_selector jsonb NOT NULL DEFAULT '{"version":1,"kind":"project"}',
 source_actor_id uuid NOT NULL REFERENCES authz.principals(id),
 expires_at timestamptz,
 until_revoked boolean NOT NULL DEFAULT true,
 active boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(service_id,project_id),
 CHECK(cardinality(capabilities)>0 AND capabilities<@ARRAY['storage','resources','context','work']::text[] AND array_position(capabilities,NULL) IS NULL),
 CHECK(authz.valid_selector(resource_selector)),
 CHECK((expires_at IS NULL)=until_revoked AND (expires_at IS NULL OR isfinite(expires_at)))
);
CREATE TABLE authz.service_clients (
 client_id uuid PRIMARY KEY REFERENCES authz.clients(id),
 service_id uuid NOT NULL REFERENCES authz.principals(id),
 project_ids uuid[] NOT NULL CHECK(cardinality(project_ids)>0),
 issued_by uuid NOT NULL REFERENCES authz.principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON authz.service_authorizations,authz.service_clients FROM PUBLIC;

CREATE FUNCTION authz.service_actions(capabilities text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $f$
 SELECT ARRAY(SELECT DISTINCT action FROM (
 SELECT unnest(ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.correct','mem.discover','mem.read_history']) action WHERE 'storage'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['mem.process','resource.read','resource.write','resource.deploy','hufu.vault.read']) WHERE 'resources'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['v8.project.read','v8.context.read','v8.context.prepare','v8.context.materialize','hufu.baize.members.read']) WHERE 'context'=ANY(capabilities)
 UNION ALL SELECT unnest(ARRAY['v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.handoff.read','v8.handoff.record','v8.experience.publish','v8.experience.read','v8.experience.feedback']) WHERE 'work'=ANY(capabilities)
 ) actions ORDER BY action)
$f$;

CREATE FUNCTION authz.product_service_client(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,authz AS $f$
 SELECT EXISTS(SELECT FROM authz.service_clients sc JOIN authz.clients c ON c.id=sc.client_id JOIN authz.principals p ON p.id=sc.service_id WHERE sc.client_id=cid AND c.principal_id=sc.service_id AND p.kind='service' AND c.active AND p.active)
$f$;

CREATE FUNCTION authz.service_deadline(actor uuid, client uuid, project uuid, action text, resource jsonb)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE g authz.service_authorizations;p authz.principals;pr record;issuer authz.principals;deadline timestamptz;
BEGIN
 IF client IS NOT NULL AND NOT EXISTS(SELECT FROM authz.service_clients sc JOIN authz.clients c ON c.id=sc.client_id WHERE sc.client_id=client AND sc.service_id=actor AND c.principal_id=actor AND c.active AND project=ANY(sc.project_ids)) THEN RETURN NULL;END IF;
 SELECT * INTO p FROM authz.principals WHERE id=actor;
 SELECT * INTO g FROM authz.service_authorizations WHERE service_id=actor AND project_id=project;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 SELECT * INTO issuer FROM authz.principals WHERE id=g.source_actor_id;
 IF p.kind IS DISTINCT FROM 'service' OR NOT p.active OR g.id IS NULL OR NOT g.active OR pr.id IS NULL OR pr.state<>'active' OR pr.organization_id<>p.organization_id OR issuer.active IS DISTINCT FROM true OR issuer.organization_id<>p.organization_id OR NOT action=ANY(authz.service_actions(ARRAY['storage','resources','context','work'])) OR NOT authz.selector_matches(g.resource_selector,project,resource) THEN RETURN NULL;END IF;
 deadline:=CASE WHEN g.until_revoked THEN 'infinity'::timestamptz ELSE g.expires_at END;
 IF deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF pr.visibility='private' AND pr.owner_id<>actor THEN deadline:=least(deadline,authz.project_privacy_read_deadline(actor,project));IF authz.project_privacy_read_deadline(actor,project) IS NULL THEN RETURN NULL;END IF;END IF;
 RETURN deadline;
END $f$;

CREATE FUNCTION authz.service_manager(proof text, project uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;p authz.principals;pr record;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'service_management_runtime_required' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;
 PERFORM authz.require_client_capability(i,'hufu.qualification.manage');
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,project) THEN RAISE EXCEPTION 'manager_project_scope_required' USING ERRCODE='42501';END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 IF p.kind<>'member' OR pr.id IS NULL OR pr.state<>'active' OR pr.organization_id<>p.organization_id OR NOT(p.role='organization_admin' OR p.id=pr.manager_id OR pr.visibility IN('personal','private') AND p.id=pr.owner_id) THEN RAISE EXCEPTION 'service_project_manager_required' USING ERRCODE='42501';END IF;
 IF pr.visibility='private' AND pr.owner_id<>p.id AND authz.project_privacy_read_deadline(p.id,project) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 RETURN i;
END $f$;

CREATE FUNCTION authz.service_authorize(proof text,b jsonb,p_key text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;actor uuid;sid uuid;pid uuid;caps text[];expiry timestamptz;unlimited boolean;g authz.service_authorizations;old authz.operations;result jsonb;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['project_id','service_id','name','resource_selector','expires_at','until_revoked']<>'{}'::jsonb OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_service_authorization' USING ERRCODE='22023';END IF;
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
 caps:=ARRAY['storage','resources','context','work'];
 expiry:=(b->>'expires_at')::timestamptz;unlimited:=coalesce((b->>'until_revoked')::boolean,expiry IS NULL);
 IF caps IS NULL OR cardinality(caps)=0 OR NOT caps<@ARRAY['storage','resources','context','work']::text[] OR (expiry IS NULL)<>unlimited OR expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp()) OR NOT authz.valid_selector(coalesce(b->'resource_selector','{"version":1,"kind":"project"}')) THEN RAISE EXCEPTION 'invalid_service_scope' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT FROM v8.projects WHERE id=pid AND visibility='private' AND owner_id<>sid) AND authz.project_privacy_read_deadline(sid,pid) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.principals WHERE id IN(actor,sid) ORDER BY id FOR UPDATE;
 PERFORM id FROM v8.projects WHERE id=pid FOR SHARE;
 i:=authz.service_manager(proof,pid);
 INSERT INTO authz.service_authorizations(service_id,project_id,capabilities,resource_selector,source_actor_id,expires_at,until_revoked) VALUES(sid,pid,caps,coalesce(b->'resource_selector','{"version":1,"kind":"project"}'),actor,expiry,unlimited)
 ON CONFLICT(service_id,project_id) DO UPDATE SET capabilities=EXCLUDED.capabilities,resource_selector=EXCLUDED.resource_selector,source_actor_id=EXCLUDED.source_actor_id,expires_at=EXCLUDED.expires_at,until_revoked=EXCLUDED.until_revoked,active=true,revision=authz.service_authorizations.revision+1,updated_at=clock_timestamp() RETURNING * INTO g;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=sid;
 result:=jsonb_build_object('state','authorized','service_id',sid,'project_id',pid,'authorization_id',g.id,'revision',g.revision,'capabilities',to_jsonb(caps),'actions',to_jsonb(authz.service_actions(caps)),'resource_selector',g.resource_selector,'expires_at',expiry,'until_revoked',unlimited,'authorization_mode','product_service','agent_work_required',false,'operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(i->>'client_id')::uuid,'authz','service.authorize',g.id,result);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',g.id,g.revision,'service.authorize',pid,result);
 RETURN result;
END $f$;

CREATE FUNCTION authz.service_credential_issue(proof text,b jsonb,p_key text,p_digest text,p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;actor uuid;sid uuid;pid uuid;pids uuid[];actions text[];expiry timestamptz;unlimited boolean;cid uuid;cred uuid;old authz.operations;result jsonb;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['service_id','project_ids','label','expires_at','until_revoked']<>'{}'::jsonb OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[a-f0-9]{64}$' OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_service_credential' USING ERRCODE='22023';END IF;
 sid:=(b->>'service_id')::uuid;
 SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO pids FROM jsonb_array_elements_text(b->'project_ids');
 IF pids IS NULL OR cardinality(pids) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'service_projects_required' USING ERRCODE='22023';END IF;
 FOREACH pid IN ARRAY pids LOOP
  i:=authz.service_manager(proof,pid);
  IF NOT EXISTS(SELECT FROM authz.service_authorizations g JOIN authz.principals p ON p.id=g.service_id WHERE g.service_id=sid AND g.project_id=pid AND g.active AND (g.until_revoked OR g.expires_at>clock_timestamp()) AND p.kind='service' AND p.active AND p.organization_id=(i->>'organization_id')::uuid) THEN RAISE EXCEPTION 'service_authorization_required' USING ERRCODE='42501';END IF;
 END LOOP;
 actor:=(i->>'actor_id')::uuid;PERFORM authz.require_client_capability(i,'hufu.credential.manage');
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_key,1050));
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF old.principal_id IS NOT NULL THEN
  IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='40001';END IF;
  IF NOT EXISTS(SELECT FROM authz.credentials WHERE id=(old.result->>'credential_id')::uuid AND revoked_at IS NULL AND (until_revoked OR expires_at>clock_timestamp())) THEN RETURN old.result||'{"credential_delivery":"unavailable"}'::jsonb;END IF;
  RETURN old.result||'{"credential_delivery":"available"}'::jsonb;
 END IF;
 SELECT ARRAY(SELECT DISTINCT a FROM authz.service_authorizations g CROSS JOIN LATERAL unnest(authz.service_actions(g.capabilities)) a WHERE g.service_id=sid AND g.project_id=ANY(pids) AND g.active ORDER BY a) INTO actions;
 expiry:=(b->>'expires_at')::timestamptz;unlimited:=coalesce((b->>'until_revoked')::boolean,expiry IS NULL);
 IF (expiry IS NULL)<>unlimited OR expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp()) OR coalesce(length(b->>'label'),0)>200 THEN RAISE EXCEPTION 'invalid_service_credential_lifetime' USING ERRCODE='22023';END IF;
 PERFORM id FROM authz.principals WHERE id IN(actor,sid) ORDER BY id FOR UPDATE;
 PERFORM id FROM v8.projects WHERE id=ANY(pids) ORDER BY id FOR SHARE;
 FOREACH pid IN ARRAY pids LOOP
  i:=authz.service_manager(proof,pid);
  IF NOT EXISTS(SELECT FROM authz.service_authorizations WHERE service_id=sid AND project_id=pid AND active AND (until_revoked OR expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'service_authorization_required' USING ERRCODE='42501';END IF;
 END LOOP;
 INSERT INTO authz.clients(principal_id,label,actions) VALUES(sid,coalesce(b->>'label','Product service foundation access'),actions) RETURNING id INTO cid;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,until_revoked,is_primary,authority_source) VALUES(cid,p_token_hash,expiry,unlimited,false,'product_service_authorized') RETURNING id INTO cred;
 INSERT INTO authz.client_filters745(client_id,clauses) VALUES(cid,jsonb_build_array(jsonb_build_object('project_ids',to_jsonb(pids))));
 INSERT INTO authz.service_clients(client_id,service_id,project_ids,issued_by) VALUES(cid,sid,pids,actor);
 result:=jsonb_build_object('state','issued','service_id',sid,'client_id',cid,'credential_id',cred,'project_ids',to_jsonb(pids),'actions',to_jsonb(actions),'until_revoked',unlimited,'expires_at',expiry,'authorization_mode','product_service','credential_delivery','available','operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(i->>'client_id')::uuid,'authz','service.credential.issue',cred,result);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,payload) VALUES('authz',cred,1,'service.credential.issue',result);
 RETURN result;
END $f$;

CREATE FUNCTION authz.service_authorization_revoke(proof text,b jsonb,p_key text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE g authz.service_authorizations;i jsonb;actor uuid;old authz.operations;result jsonb;
BEGIN
 IF b IS NULL OR b-ARRAY['authorization_id','expected_revision']<>'{}'::jsonb OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_service_revoke' USING ERRCODE='22023';END IF;
 SELECT * INTO g FROM authz.service_authorizations WHERE id=(b->>'authorization_id')::uuid;
 IF g.id IS NULL THEN RAISE EXCEPTION 'service_authorization_not_found' USING ERRCODE='42501';END IF;
 i:=authz.service_manager(proof,g.project_id);actor:=(i->>'actor_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_key,1050));
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF old.principal_id IS NOT NULL THEN IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='40001';END IF;RETURN old.result;END IF;
 PERFORM id FROM authz.principals WHERE id IN(actor,g.service_id) ORDER BY id FOR UPDATE;
 PERFORM id FROM v8.projects WHERE id=g.project_id FOR SHARE;
 i:=authz.service_manager(proof,g.project_id);
 SELECT * INTO g FROM authz.service_authorizations WHERE id=g.id FOR UPDATE;
 IF g.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'service_revision_conflict' USING ERRCODE='40001';END IF;
 UPDATE authz.service_authorizations SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=g.id RETURNING * INTO g;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=g.service_id;
 result:=jsonb_build_object('state','revoked','authorization_id',g.id,'service_id',g.service_id,'project_id',g.project_id,'revision',g.revision,'original_member_and_work_permissions','unchanged','operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(i->>'client_id')::uuid,'authz','service.revoke',g.id,result);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',g.id,g.revision,'service.revoke',g.project_id,result);
 RETURN result;
END $f$;

CREATE FUNCTION authz.service_authorizations_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;items jsonb;pid uuid;sid uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR b-ARRAY['project_id','service_id']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_service_query' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
 IF pid IS NOT NULL AND (i->>'principal_kind')<>'service' THEN i:=authz.service_manager(proof,pid);
 ELSIF (i->>'principal_kind')<>'service' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin' AND kind='member') THEN RAISE EXCEPTION 'service_query_manager_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('authorization_id',g.id,'service_id',g.service_id,'service_name',p.display_name,'project_id',g.project_id,'capabilities',to_jsonb(g.capabilities),'actions',to_jsonb(authz.service_actions(g.capabilities)),'resource_selector',g.resource_selector,'active',g.active,'effective_now',g.active AND (g.until_revoked OR g.expires_at>clock_timestamp()),'revision',g.revision,'expires_at',g.expires_at,'until_revoked',g.until_revoked) ORDER BY g.created_at),'[]') INTO items FROM authz.service_authorizations g JOIN authz.principals p ON p.id=g.service_id WHERE (pid IS NULL OR g.project_id=pid) AND (sid IS NULL OR g.service_id=sid) AND ((i->>'principal_kind')<>'service' OR g.service_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id));
 RETURN jsonb_build_object('state','read','authorization_mode','product_service','items',items,'agent_work_required',false);
END $f$;

REVOKE ALL ON FUNCTION authz.service_actions(text[]),authz.product_service_client(uuid),authz.service_deadline(uuid,uuid,uuid,text,jsonb),authz.service_manager(text,uuid),authz.service_authorize(text,jsonb,text,text),authz.service_credential_issue(text,jsonb,text,text,text),authz.service_authorization_revoke(text,jsonb,text,text),authz.service_authorizations_read(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.service_actions(text[]),authz.product_service_client(uuid),authz.service_deadline(uuid,uuid,uuid,text,jsonb) TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.service_authorize(text,jsonb,text,text),authz.service_credential_issue(text,jsonb,text,text,text),authz.service_authorization_revoke(text,jsonb,text,text),authz.service_authorizations_read(text,jsonb) TO hub2_hufu;
