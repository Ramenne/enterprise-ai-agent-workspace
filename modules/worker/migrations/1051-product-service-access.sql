CREATE OR REPLACE FUNCTION authz.authenticate(p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE c authz.credentials; cl authz.clients; p authz.principals; base text[]; ordinary boolean; filters jsonb;
BEGIN
 base:=ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
 SELECT * INTO c FROM authz.credentials WHERE token_hash=p_hash;
 SELECT * INTO cl FROM authz.clients WHERE id=c.client_id;
 SELECT * INTO p FROM authz.principals WHERE id=cl.principal_id;
 IF p_hash IS NULL OR p.id IS NULL OR cl.id IS NULL OR c.id IS NULL OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) THEN
  RAISE EXCEPTION 'unauthenticated' USING ERRCODE='42501';
 END IF;
 ordinary:=authz.ordinary_member_client901(cl.id);
 SELECT coalesce(f.clauses,'[]'::jsonb) INTO filters FROM authz.client_filters745 f WHERE f.client_id=cl.id;
 RETURN jsonb_build_object(
  'principal_kind',p.kind,'member_role',p.role,
  'authorization_mode',CASE WHEN authz.product_service_client(cl.id) THEN 'product_service' WHEN ordinary THEN 'member_qualification' ELSE 'restricted_credential' END,
  'scope_filters',coalesce(filters,'[]'::jsonb),
  'scope_filter_semantics',CASE WHEN ordinary THEN 'informational_legacy_metadata' ELSE 'technical_restriction' END,
  'actor_id',p.id,
  'client_id',cl.id,
  'credential_id',c.id,
  'organization_id',p.organization_id,
  'member_label',p.display_name,
  'client_label',cl.label,
  'client_actions',ARRAY(SELECT DISTINCT x FROM unnest(cl.actions||CASE WHEN authz.product_service_client(cl.id) THEN authz.service_actions(ARRAY['storage','resources','context','work']) WHEN ordinary THEN base ELSE ARRAY[]::text[] END) AS x ORDER BY x),
  'expires_at',c.expires_at,
  'until_revoked',c.until_revoked,
  'is_primary',c.is_primary,
  'credential_type',CASE WHEN c.is_primary THEN 'primary_member' WHEN c.parent_credential_id IS NOT NULL THEN 'delegated_api' WHEN c.authority_source='member_issued_api' THEN 'member_api' ELSE 'unclassified' END,
  'authority_source',c.authority_source,'service_class',CASE WHEN authz.product_service_client(cl.id) THEN 'product' ELSE NULL END,'agent_work_required',NOT authz.product_service_client(cl.id),
  'parent_credential_id',c.parent_credential_id,
  'authorization_note',CASE WHEN authz.product_service_client(cl.id) THEN 'full_service_abilities_in_authorized_resource_scope;no_member_work_qualification_or_per_action_approval' WHEN ordinary THEN 'member_connection_includes_base_project_and_work_actions;project_qualification_and_special_resources_still_apply' ELSE 'restricted_credential_actions_and_scope_remain_required' END
 );
END $function$;


CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid, p_client uuid, p_project uuid, p_action text, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals; pr record; deadline timestamptz; privacy_deadline timestamptz:='infinity'; q record;
BEGIN
 -- Product services bypass Agent qualification, per-client action ceilings and
 -- public-member read defaults. The single declared resource scope is decisive.
 IF authz.product_service_client(p_client) THEN
  deadline:=authz.service_deadline(p_actor,p_client,p_project,p_action,r);
  IF deadline IS NULL THEN RAISE EXCEPTION 'service_resource_scope_required' USING ERRCODE='42501';END IF;
  RETURN deadline;
 END IF;
 IF NOT xingxiu.agent_scope(p_actor,p_project) THEN RAISE EXCEPTION 'xingxiu_member_scope_no_longer_valid' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
 IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN
  IF p_action='v8.project.create' AND (r->>'project_id')::uuid=p_project AND (r->>'organization_id')::uuid=p.organization_id AND (r->>'owner_id')::uuid=p_actor THEN
   IF coalesce(r->>'visibility','personal') NOT IN('personal','team') THEN RAISE EXCEPTION 'privacy_requires_explicit_project_mark' USING ERRCODE='42501';END IF;
   IF r->>'visibility'='team' AND(p.role<>'organization_admin' OR p.kind<>'member') THEN RAISE EXCEPTION 'team_creation_requires_supervisor' USING ERRCODE='42501';END IF;
   RETURN 'infinity';END IF;
  RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';
 END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND pr.owner_id<>p_actor THEN
  privacy_deadline:=authz.project_privacy_read_deadline(p_actor,p_project);
  IF privacy_deadline IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 END IF;
 IF p_action IN('v8.project.convert','v8.project.update') THEN
  IF pr.visibility='private' AND pr.owner_id<>p_actor THEN RAISE EXCEPTION 'privacy_owner_controls_classification' USING ERRCODE='42501';END IF;
  IF pr.owner_id=p_actor OR(pr.visibility IN('personal','team') AND p.role='organization_admin' AND p.kind='member') THEN RETURN 'infinity';END IF;
 END IF;
 IF (pr.visibility IN('personal','private') AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility IN('personal','team')) THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND privacy_deadline>clock_timestamp() THEN RETURN privacy_deadline;END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r); IF deadline IS NOT NULL THEN RETURN least(deadline,privacy_deadline); END IF;
 END LOOP;
 RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';
END $function$;


CREATE OR REPLACE FUNCTION authz.lock_resources(actor uuid, client uuid, credential uuid, resources jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE project_ids uuid[];qids uuid[];people uuid[];origin uuid;fid uuid;
BEGIN
 SELECT array_agg(DISTINCT (r->>'project_id')::uuid) INTO project_ids FROM jsonb_array_elements(resources) r;
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
END $function$;


CREATE OR REPLACE FUNCTION authz.require_client_capability(identity jsonb, capability text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE c authz.clients; p authz.principals;
BEGIN
 SELECT * INTO c FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO p FROM authz.principals WHERE id=c.principal_id;
 IF identity IS NULL OR c.id IS NULL OR c.principal_id IS DISTINCT FROM (identity->>'actor_id')::uuid OR NOT c.active OR NOT p.active THEN
 RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 IF authz.product_service_client(c.id) AND capability=ANY(authz.service_actions(ARRAY['storage','resources','context','work'])) THEN RETURN;END IF;
 IF NOT authz.ordinary_member_client901(c.id) AND (capability=ANY(c.actions)) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'restricted_credential_capability_required' USING ERRCODE='42501'; END IF;
END $function$;


CREATE OR REPLACE FUNCTION vault2.project_use_check(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$
DECLARE u vault2.project_uses;s jsonb;i jsonb;q record;deadline timestamptz;act text;software text;e vault2.entries;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu'OR b IS NULL OR jsonb_typeof(b)<>'object'OR b-ARRAY['use_id','project_id','phase']<>'{}'::jsonb OR NOT b?&ARRAY['use_id','project_id','phase']OR b->>'phase'IS NULL OR b->>'phase'NOT IN('discover','apply','start','effect','final')THEN RAISE EXCEPTION 'project_use_scope_required';END IF;
 SELECT * INTO u FROM vault2.project_uses WHERE id=(b->>'use_id')::uuid FOR SHARE;s:=vault2.use_source(u);i:=authz.vault_current_identity(proof,u.project_id);
 IF u.id IS NULL OR u.project_id IS DISTINCT FROM(b->>'project_id')::uuid OR NOT u.active OR u.expires_at<=clock_timestamp()OR(s->>'active')::boolean IS DISTINCT FROM true
 OR(s->>'provider_expires_at'IS NOT NULL AND(s->>'provider_expires_at')::timestamptz<=clock_timestamp())OR vault2.use_source_valid(u,'source')IS DISTINCT FROM true OR vault2.use_source_valid(u,'consumer')IS DISTINCT FROM true
 OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,u.project_id,(s->>'id')::uuid,s->>'name')THEN RAISE EXCEPTION 'project_use_current_scope_denied' USING ERRCODE='42501';END IF;
 act:=CASE WHEN b->>'phase'IN('discover','apply')THEN'mem.read'WHEN u.mode IN('model_proxy','asr')THEN'mem.process'ELSE'mem.read'END;
 software:=CASE WHEN u.mode='delivery'AND b->>'phase'NOT IN('discover','apply')THEN'hufu.vault.read'ELSE act END;PERFORM authz.require_client_capability(i,software);
 IF authz.product_service_client((i->>'client_id')::uuid) THEN
  deadline:=authz.service_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,u.project_id,act,jsonb_build_object('project_id',u.project_id,'area_id',u.area_id));
 ELSE
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=(i->>'actor_id')::uuid AND project_id=u.project_id LOOP
  deadline:=authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,u.project_id,act,jsonb_build_object('project_id',u.project_id,'area_id',u.area_id));IF deadline IS NOT NULL THEN EXIT;END IF;
 END LOOP;END IF;IF deadline IS NULL THEN RAISE EXCEPTION 'consumer_project_work_required' USING ERRCODE='42501';END IF;
 IF u.mode='delivery'AND b->>'phase'NOT IN('discover','apply')THEN SELECT * INTO e FROM vault2.entries WHERE id=u.entry_id;PERFORM vault2.allowed_grant(i,e);END IF;
 RETURN jsonb_build_object('state','authorized','use_id',u.id,'revision',u.revision,'mode',u.mode,'entry_id',u.entry_id,'provider_id',s->>'name','project_id',u.project_id,'management_project_id',s->>'project_id','actor_id',i->>'actor_id','client_id',i->>'client_id','credential_id',i->>'credential_id','deadline',least(deadline,u.expires_at,clock_timestamp()+interval'2 seconds'),'phase',b->>'phase','secret_returned',false);
END $function$;


CREATE OR REPLACE FUNCTION authz.provider_catalog_guard62(p_hash text, p_project uuid, p_area uuid, write_mode boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE identity jsonb;actor uuid;client uuid;credential uuid;pr record;q record;action text;allowed boolean:=false;r jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu'OR p_project IS NULL THEN RAISE EXCEPTION 'provider_catalog_forbidden' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;client:=(identity->>'client_id')::uuid;credential:=(identity->>'credential_id')::uuid;
 r:=jsonb_strip_nulls(jsonb_build_object('project_id',p_project,'area_id',p_area));PERFORM authz.lock_resources(actor,client,credential,jsonb_build_array(r));identity:=authz.authenticate(p_hash);
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 action:=CASE WHEN write_mode THEN 'resource.write'ELSE 'resource.read'END;
 IF authz.product_service_client(client) AND NOT write_mode THEN
  IF authz.service_deadline(actor,client,p_project,'resource.read',r) IS NULL THEN RAISE EXCEPTION 'service_resource_scope_required' USING ERRCODE='42501';END IF;
  RETURN identity;
 END IF;
 IF pr.id IS NULL OR pr.state IS DISTINCT FROM 'active'OR pr.organization_id IS DISTINCT FROM(identity->>'organization_id')::uuid
 OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND kind='member'AND active)
 OR NOT EXISTS(SELECT FROM authz.clients WHERE id=client AND principal_id=actor AND active AND action=ANY(actions))
 OR(p_area IS NOT NULL AND NOT EXISTS(SELECT FROM authz.resource_areas WHERE id=p_area AND project_id=p_project AND active))THEN RAISE EXCEPTION 'provider_catalog_forbidden' USING ERRCODE='42501';END IF;
 -- A real project owner/manager is current management authority, never a label.
 allowed:=actor=pr.manager_id OR(pr.visibility='personal'AND actor=pr.owner_id);
 IF NOT allowed THEN
  FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=actor AND project_id=p_project ORDER BY id LOOP
   IF write_mode THEN
    IF action=ANY(q.actions)AND authz.management_valid(q.id,actor,p_project)AND authz.selector_matches(q.resource_selector,p_project,r)THEN allowed:=true;EXIT;END IF;
   ELSIF authz.qualification_deadline(q.id,actor,p_project,action,r)IS NOT NULL THEN allowed:=true;EXIT;
   END IF;
  END LOOP;
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'provider_catalog_scope_denied' USING ERRCODE='42501';END IF;
 RETURN identity;
END $function$;


CREATE OR REPLACE FUNCTION authz.resource_execution_check(p_hash text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE identity jsonb; actor uuid; client uuid; credential uuid; project uuid; area uuid;
 a authz.resource_areas; t authz.resource_execution_targets; e authz.resource_endpoints;
 pr record; q record; expiry timestamptz; action text; check_id uuid; deadline timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object' OR
  NOT b ?& ARRAY['project_id','area_id','endpoint_id','operation','request_hash','phase'] OR
  b - ARRAY['project_id','area_id','endpoint_id','operation','environment','request_hash','phase'] <> '{}'::jsonb OR
  b->>'request_hash' !~ '^[0-9a-f]{64}$' OR b->>'phase' NOT IN('start','effect') OR
  b->>'operation' NOT IN('read','write','deploy') THEN RAISE EXCEPTION 'invalid_execution_check' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); IF NOT authz.client_resource_allowed745((identity->>'client_id')::uuid,(b->>'project_id')::uuid) THEN RAISE EXCEPTION 'software_resource_scope_denied' USING ERRCODE='42501';END IF; actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid; credential:=(identity->>'credential_id')::uuid;
 project:=(b->>'project_id')::uuid; area:=(b->>'area_id')::uuid;
 PERFORM authz.lock_resources(actor,client,credential,jsonb_build_array(jsonb_build_object('project_id',project,'area_id',area)));
 -- Reauthenticate under current authority fences, including family revocation.
 identity:=authz.authenticate(p_hash);
 action:='resource.'||(b->>'operation');
 IF NOT authz.product_service_client(client) AND NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND kind='member' AND active) THEN RAISE EXCEPTION 'member_required' USING ERRCODE='42501'; END IF;
 IF NOT authz.product_service_client(client) AND NOT EXISTS(SELECT FROM authz.clients WHERE id=client AND active AND action=ANY(actions)) THEN RAISE EXCEPTION 'client_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM authz.resource_areas WHERE id=area;
 SELECT * INTO t FROM authz.resource_execution_targets WHERE area_id=area FOR SHARE;
 SELECT * INTO e FROM authz.resource_endpoints WHERE id=t.endpoint_id FOR SHARE;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 IF a.id IS NULL OR a.project_id IS DISTINCT FROM project OR a.active IS DISTINCT FROM true OR t.active IS DISTINCT FROM true OR e.active IS DISTINCT FROM true OR
  e.id IS DISTINCT FROM (b->>'endpoint_id')::uuid OR t.environment IS DISTINCT FROM COALESCE(b->>'environment','none') OR NOT(b->>'operation'=ANY(t.operations)) OR
  pr.id IS NULL OR pr.state<>'active' OR pr.organization_id IS DISTINCT FROM (identity->>'organization_id')::uuid THEN RAISE EXCEPTION 'execution_target_forbidden' USING ERRCODE='42501'; END IF;
 -- A team-readable project does not imply OS execution permission. Require real work qualification.
 deadline:=NULL;
 IF authz.product_service_client(client) THEN
  expiry:=authz.service_deadline(actor,client,project,action,jsonb_build_object('project_id',project,'area_id',area));
  IF expiry IS NOT NULL THEN deadline:=expiry;END IF;
 ELSE
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=actor AND project_id=project AND kind='work' ORDER BY id LOOP
  expiry:=authz.qualification_deadline(q.id,actor,project,action,jsonb_build_object('project_id',project,'area_id',area));
  IF expiry IS NOT NULL THEN deadline:=expiry; EXIT; END IF;
 END LOOP;END IF;
 IF deadline IS NULL THEN RAISE EXCEPTION 'resource_scope_forbidden' USING ERRCODE='42501'; END IF;
 deadline:=least(deadline,CASE WHEN (identity->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (identity->>'expires_at')::timestamptz END,clock_timestamp()+interval '2 seconds');
 INSERT INTO authz.resource_execution_checks(actor_id,client_id,credential_id,endpoint_id,area_id,action,request_hash,phase,area_epoch,deadline)
 VALUES(actor,client,credential,e.id,area,action,b->>'request_hash',b->>'phase',a.epoch,deadline) RETURNING id INTO check_id;
 RETURN jsonb_build_object('state','authorized','actor_id',actor,'client_id',client,'credential_id',credential,
 'project_id',project,'area_id',area,'area_epoch',a.epoch,'target_epoch',t.epoch,'endpoint_id',e.id,'endpoint_epoch',e.epoch,
 'root_fingerprint',t.root_fingerprint,'environment',t.environment,'action',action,'request_hash',b->>'request_hash','phase',b->>'phase','check_id',check_id,'deadline',deadline,'effect_window_seconds',2);
END $function$;


CREATE OR REPLACE FUNCTION authz.external_owner_deadline(actor uuid, pid uuid, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals;pr record;q record;deadline timestamptz;best timestamptz;
BEGIN
 -- Lock the real owner/delegation dependencies, independent of an old login session.
 PERFORM authz.lock_resources(actor,NULL,NULL,jsonb_build_array(r));
 SELECT * INTO p FROM authz.principals WHERE id=actor;SELECT * INTO pr FROM v8.projects WHERE id=pid;
 IF p.active IS DISTINCT FROM true OR pr.id IS NULL OR pr.state<>'active'OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',pid,r)THEN RETURN NULL;END IF;
 deadline:=authz.service_deadline(actor,NULL,pid,'mem.share',r);IF deadline IS NOT NULL THEN RETURN deadline;END IF;
 IF pr.visibility IN('personal','private')AND pr.owner_id=actor THEN RETURN 'infinity';END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=actor AND project_id=pid AND kind='work'ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,actor,pid,'mem.share',r);
  IF deadline IS NOT NULL AND(best IS NULL OR deadline>best)THEN best:=deadline;END IF;
 END LOOP;RETURN best;
END $function$;

