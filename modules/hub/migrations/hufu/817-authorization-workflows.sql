BEGIN;
CREATE TABLE IF NOT EXISTS authz.access_requests(
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),project_id uuid NOT NULL REFERENCES v8.projects(id),
 actor_id uuid NOT NULL REFERENCES authz.principals(id),client_id uuid NOT NULL,
 profile text NOT NULL CHECK(profile IN('business','resource')),purpose text NOT NULL,
 actions text[] NOT NULL,resource_selector jsonb NOT NULL DEFAULT '{"version":1,"kind":"project"}',
 requested_until timestamptz,until_revoked boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending',revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),decided_at timestamptz,
 decided_by uuid,decided_client_id uuid,decision_note text,qualification_id uuid,
 idempotency_key text NOT NULL,decision_digest text,UNIQUE(actor_id,idempotency_key));
CREATE TABLE IF NOT EXISTS authz.access_request_history(request_id uuid NOT NULL,revision bigint NOT NULL,snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(request_id,revision));
CREATE OR REPLACE FUNCTION authz.access_request_history_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$ BEGIN INSERT INTO authz.access_request_history VALUES(NEW.id,NEW.revision,to_jsonb(NEW),clock_timestamp()) ON CONFLICT DO NOTHING;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS capture_access_request_history ON authz.access_requests;
CREATE TRIGGER capture_access_request_history AFTER INSERT OR UPDATE ON authz.access_requests FOR EACH ROW EXECUTE FUNCTION authz.access_request_history_capture();
CREATE TABLE IF NOT EXISTS authz.authorization_request_links(
 source_kind text NOT NULL,source_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,
 project_id uuid NOT NULL,actor_id uuid NOT NULL,linked_by uuid NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_kind,source_id));
REVOKE ALL ON authz.access_requests,authz.authorization_request_links,authz.access_request_history FROM PUBLIC;
CREATE TABLE IF NOT EXISTS authz.application_targets(application_id text PRIMARY KEY,project_id uuid NOT NULL REFERENCES v8.projects(id),active boolean NOT NULL DEFAULT true,notes text NOT NULL DEFAULT '');
REVOKE ALL ON authz.application_targets FROM PUBLIC;
INSERT INTO authz.application_targets VALUES('baize','3527ac31-0643-4f89-a6bd-b1e9768b2e42',true,'current runtime on xiaochen'),('tools','69197d56-41b0-4c8b-ac19-181f63e87c1f',true,'current runtime on xiaochen'),('jiling','6aedbc32-3768-47cc-a1e2-ff4297be5be7',true,'personal project visibility retained') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION authz.business_actions() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.read','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
$$;
CREATE OR REPLACE FUNCTION authz.authorization_resolve(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',p.id,'title',p.title,'visibility',p.visibility,'kind',p.kind)),'[]') INTO items FROM v8.projects p
 WHERE p.organization_id=(i->>'organization_id')::uuid AND p.state='active' AND (p.visibility='team' OR p.owner_id=(i->>'actor_id')::uuid OR p.manager_id=(i->>'actor_id')::uuid OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=(i->>'actor_id')::uuid AND q.project_id=p.id AND authz.qualification_deadline(q.id,q.principal_id,p.id,'v8.project.read',jsonb_build_object('project_id',p.id))>clock_timestamp()))
 AND authz.client_resource_allowed745((i->>'client_id')::uuid,p.id)
 AND (NOT b ? 'project_id' OR p.id=(b->>'project_id')::uuid)
 AND (NOT b ? 'project' OR p.title=b->>'project' OR (b->>'project'='机灵' AND p.id='6aedbc32-3768-47cc-a1e2-ff4297be5be7'));
 IF jsonb_array_length(items)=0 THEN RETURN jsonb_build_object('state','project_not_found','candidates',items);END IF;
 IF jsonb_array_length(items)<>1 THEN RETURN jsonb_build_object('state','choose_project','candidates',items);END IF;
 RETURN jsonb_build_object('state','resolved','project',items->0);
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_catalog(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p record;e authz.engineering_projects;acts text[];a text;allowed text[];d timestamptz;items jsonb:='[]';resolved jsonb;gid uuid;
BEGIN
 i:=authz.authenticate(proof);
 IF b ? 'project' OR b ? 'project_id' THEN resolved:=authz.authorization_resolve(proof,b);IF resolved->>'state'<>'resolved' THEN RETURN resolved;END IF;gid:=(resolved->'project'->>'project_id')::uuid;END IF;
 FOR p IN SELECT * FROM v8.projects WHERE organization_id=(i->>'organization_id')::uuid AND state='active' AND (gid IS NULL OR id=gid) AND (visibility='team' OR owner_id=(i->>'actor_id')::uuid OR manager_id=(i->>'actor_id')::uuid OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=(i->>'actor_id')::uuid AND q.project_id=v8.projects.id AND authz.qualification_deadline(q.id,q.principal_id,v8.projects.id,'v8.project.read',jsonb_build_object('project_id',v8.projects.id))>clock_timestamp())) AND authz.client_resource_allowed745((i->>'client_id')::uuid,id) ORDER BY title LOOP
  SELECT * INTO e FROM authz.engineering_projects WHERE project_id=p.id;
  SELECT actions INTO acts FROM authz.work_presets WHERE project_id=p.id;acts:=coalesce(acts,authz.business_actions());allowed:='{}';
  FOREACH a IN ARRAY acts LOOP
   BEGIN d:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p.id,a,jsonb_build_object('project_id',p.id));IF d>clock_timestamp() THEN allowed:=array_append(allowed,a);END IF;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END LOOP;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',p.id,'title',p.title,'visibility',p.visibility,'can_manage',authz.engineering_can_manage(proof,p.id),
   'business',jsonb_build_object('ready',acts<@allowed,'allowed_actions',allowed,'missing_actions',ARRAY(SELECT unnest(acts) EXCEPT SELECT unnest(allowed)),'apply',jsonb_build_object('path','/v2/authorization/apply','profile','business')),
   'engineering',CASE WHEN e.project_id IS NULL THEN jsonb_build_object('state','not_registered') ELSE jsonb_build_object('registered',e.ready,'resources',e.descriptor,'apply_path','/v2/engineering/apply') END,
   'database',jsonb_build_object('domains',coalesce(e.descriptor->'database_domains','[]'),'help_path','/v2/database-access/help'),
   'routes',jsonb_build_object('credentials','/v2/vault/directory','resource_apply','/v2/authorization/apply','management_challenge','/v2/engineering/management/challenge')));
 END LOOP;
 RETURN jsonb_build_object('state','read','identity',jsonb_build_object('actor_id',i->>'actor_id','client_id',i->>'client_id'),'items',items,'coverage','currently_visible_projects_and_registered_resources;not_a_grant');
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_apply(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p record;pid uuid;acts text[];allowed text[];r authz.access_requests;unlimited boolean;expiry timestamptz;s jsonb;
BEGIN
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;
 SELECT * INTO p FROM v8.projects WHERE id=pid AND state='active' AND organization_id=(i->>'organization_id')::uuid;
 IF p.id IS NULL OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pid) OR (p.visibility='personal' AND p.owner_id<>(i->>'actor_id')::uuid AND p.manager_id<>(i->>'actor_id')::uuid AND NOT EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=(i->>'actor_id')::uuid AND q.project_id=pid AND q.active)) THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 IF b->>'profile'='business' THEN SELECT actions INTO allowed FROM authz.work_presets WHERE project_id=pid;allowed:=coalesce(allowed,authz.business_actions());acts:=allowed;
 ELSIF b->>'profile'='resource' THEN allowed:=ARRAY['resource.read','resource.write','resource.deploy'];SELECT array_agg(DISTINCT value ORDER BY value) INTO acts FROM jsonb_array_elements_text(b->'actions');
 ELSE RAISE EXCEPTION 'profile_required' USING ERRCODE='22023';END IF;
 IF acts IS NULL OR cardinality(acts)=0 OR NOT acts<@allowed THEN RAISE EXCEPTION 'invalid_request_actions' USING ERRCODE='22023';END IF;
 unlimited:=coalesce((b->>'until_revoked')::boolean,false);expiry:=(b->>'expires_at')::timestamptz;
 IF (expiry IS NULL)<>unlimited OR (expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp())) OR length(coalesce(b->>'purpose','')) NOT BETWEEN 1 AND 4000 OR length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023';END IF;
 s:=coalesce(b->'resource_selector','{"version":1,"kind":"project"}');IF NOT authz.valid_selector(s) OR (b->>'profile'='business' AND s<>'{"version":1,"kind":"project"}') THEN RAISE EXCEPTION 'invalid_request_scope' USING ERRCODE='22023';END IF;
 INSERT INTO authz.access_requests(project_id,actor_id,client_id,profile,purpose,actions,resource_selector,requested_until,until_revoked,idempotency_key) VALUES(pid,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'profile',b->>'purpose',acts,s,expiry,unlimited,b->>'idempotency_key') ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
 SELECT * INTO r FROM authz.access_requests WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.project_id<>pid OR r.profile<>b->>'profile' OR r.purpose<>b->>'purpose' OR r.actions<>acts OR r.resource_selector<>s OR r.requested_until IS DISTINCT FROM expiry OR r.until_revoked<>unlimited THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'software_ceiling_missing',ARRAY(SELECT unnest(acts) EXCEPT SELECT jsonb_array_elements_text(i->'client_actions')));
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_applications(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF coalesce(b->>'view','mine') NOT IN('mine','pending','managed') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO items FROM(SELECT to_jsonb(r)||jsonb_build_object('kind','project','request_id',r.id,'requester',a.display_name,'project_title',p.title) x FROM authz.access_requests r JOIN v8.projects p ON p.id=r.project_id JOIN authz.principals a ON a.id=r.actor_id WHERE ((coalesce(b->>'view','mine')='mine' AND r.actor_id=(i->>'actor_id')::uuid) OR (b->>'view' IN('managed','pending') AND authz.engineering_can_manage(proof,r.project_id) AND (b->>'view'='managed' OR r.state IN('pending','needs_changes')))) AND (NOT b ? 'request_id' OR r.id=(b->>'request_id')::uuid) AND authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id) ORDER BY r.created_at DESC LIMIT 200)t;
 RETURN jsonb_build_object('state','read','items',items,'coverage','bounded_current_scope');
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_decide(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.access_requests;effective text;result jsonb;acts text[];s jsonb;expiry timestamptz;unlimited boolean;parent authz.qualifications;p record;target uuid;digest text;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.access_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision' NOT IN('approve','reject','needs_changes') OR b->>'decision' IS NULL OR coalesce((b->>'expected_revision')::bigint,0)<1 THEN RAISE EXCEPTION 'decision_revision_required' USING ERRCODE='22023';END IF;
 IF r.revision<>(b->>'expected_revision')::bigint THEN
  IF r.revision=(b->>'expected_revision')::bigint+1 AND r.decided_by=(i->>'actor_id')::uuid AND r.decision_digest=encode(public.digest(b::text,'sha256'),'hex') THEN RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'replayed',true);END IF;
  RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';
 END IF;
 IF r.state NOT IN('pending','needs_changes') THEN RAISE EXCEPTION 'request_already_decided' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,r.project_id);
 IF b->>'decision'='approve' THEN
  SELECT * INTO p FROM v8.projects WHERE id=r.project_id FOR UPDATE;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO acts FROM jsonb_array_elements_text(coalesce(b->'approved_actions',to_jsonb(r.actions)));IF acts IS NULL OR NOT acts<@r.actions THEN RAISE EXCEPTION 'approval_action_expansion' USING ERRCODE='42501';END IF;
  s:=coalesce(b->'resource_selector',r.resource_selector);IF NOT authz.valid_selector(s) OR NOT authz.selector_subset(s,r.resource_selector) THEN RAISE EXCEPTION 'approval_scope_expansion' USING ERRCODE='42501';END IF;
  IF r.profile='business' AND (NOT r.actions<@acts OR s<>r.resource_selector) THEN RAISE EXCEPTION 'ordinary_project_work_is_whole_project;use_specific_resource_request' USING ERRCODE='22023';END IF;
  unlimited:=r.until_revoked AND b->>'expires_at' IS NULL;expiry:=CASE WHEN unlimited THEN NULL ELSE least(r.requested_until,coalesce((b->>'expires_at')::timestamptz,r.requested_until)) END;
  IF NOT unlimited AND (expiry IS NULL OR expiry<=clock_timestamp()) THEN RAISE EXCEPTION 'request_expired' USING ERRCODE='22023';END IF;
  IF p.manager_id<>(i->>'actor_id')::uuid AND NOT(p.visibility='personal' AND p.owner_id=(i->>'actor_id')::uuid) AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin' AND organization_id=p.organization_id AND p.visibility='team') THEN
   SELECT * INTO parent FROM authz.qualifications q WHERE q.project_id=p.id AND q.principal_id=(i->>'actor_id')::uuid AND q.kind='management' AND authz.management_valid(q.id,q.principal_id,p.id) AND acts<@q.actions AND authz.selector_subset(s,q.resource_selector) ORDER BY depth LIMIT 1;
   IF parent.id IS NULL OR (NOT parent.until_revoked AND (unlimited OR expiry>parent.expires_at)) THEN RAISE EXCEPTION 'management_source_scope_required' USING ERRCODE='42501';END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=r.actor_id AND active AND organization_id=p.organization_id) THEN RAISE EXCEPTION 'requester_inactive' USING ERRCODE='42501';END IF;
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,expires_at,until_revoked,source_project_revision,resource_selector,source_basis) VALUES(r.actor_id,r.project_id,acts,(i->>'actor_id')::uuid,parent.id,'work',CASE WHEN parent.id IS NULL THEN 0 ELSE 1 END,expiry,unlimited,p.revision,s,CASE WHEN parent.id IS NULL THEN 'independent_work' ELSE 'management_appointment' END) RETURNING id INTO target;
  result:=jsonb_build_object('qualification_id',target,'actions',acts,'resource_selector',s,'expires_at',expiry,'until_revoked',unlimited,'software_actions_unchanged',true);
 END IF;
 UPDATE authz.access_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' WHEN b->>'decision'='reject' THEN 'rejected' ELSE 'needs_changes' END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,decided_client_id=(i->>'client_id')::uuid,decided_at=clock_timestamp(),decision_note=left(b->>'approval_note',4000),qualification_id=target,decision_digest=encode(public.digest(b::text,'sha256'),'hex') WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','authorization.'||r.state,r.id,jsonb_build_object('qualification_id',target,'profile',r.profile,'scope',result));
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'effect',result,'next_step',CASE WHEN r.state='approved' THEN 'query_effective_permissions_then_work' WHEN r.state='needs_changes' THEN 'requester_revise_same_request' ELSE 'use_decision_reason_or_submit_adjusted_request' END);
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_revise(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.access_requests;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.access_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.actor_id IS DISTINCT FROM (i->>'actor_id')::uuid OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id) THEN RAISE EXCEPTION 'requester_required' USING ERRCODE='42501';END IF;
 IF r.revision<>coalesce((b->>'expected_revision')::bigint,0) OR r.state NOT IN('pending','needs_changes') THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 IF b->>'operation'='withdraw' THEN UPDATE authz.access_requests SET state='withdrawn',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
 ELSIF b->>'operation'='revise' AND length(coalesce(b->>'purpose','')) BETWEEN 1 AND 4000 THEN UPDATE authz.access_requests SET purpose=b->>'purpose',state='pending',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
 ELSE RAISE EXCEPTION 'operation_or_purpose_required' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r));
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_permissions(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;pid uuid;subject uuid;items jsonb;software jsonb;d timestamptz;
BEGIN
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;subject:=coalesce((b->>'actor_id')::uuid,(i->>'actor_id')::uuid);
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pid) OR (subject<>(i->>'actor_id')::uuid AND NOT authz.engineering_can_manage(proof,pid)) THEN RAISE EXCEPTION 'permission_view_scope_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q)||jsonb_build_object('effective_now',EXISTS(SELECT FROM unnest(q.actions) a WHERE authz.qualification_deadline(q.id,subject,pid,a,jsonb_build_object('project_id',pid))>clock_timestamp()))),'[]') INTO items FROM authz.qualifications q WHERE q.principal_id=subject AND q.project_id=pid;
 RETURN jsonb_build_object('state','read','project_id',pid,'actor_id',subject,'qualifications',items,'current_software',CASE WHEN subject=(i->>'actor_id')::uuid THEN jsonb_build_object('client_id',i->>'client_id','actions',i->'client_actions','scope_filters',i->'scope_filters') ELSE NULL END,'note','member_qualification_and_software_ceiling_are_both_required;target_operation_rechecks');
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_change(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;effective text;r jsonb;command text;key text;payload jsonb;
BEGIN
 i:=authz.authenticate(proof);IF NOT authz.engineering_can_manage(proof,(b->>'project_id')::uuid) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'operation' NOT IN('revoke','freeze','unfreeze','delegate') THEN RAISE EXCEPTION 'operation_required' USING ERRCODE='22023';END IF;
 effective:=authz.engineering_management_proof(proof,(b->>'project_id')::uuid);command:=CASE WHEN b->>'operation'='delegate' THEN 'management.delegate' ELSE 'qualification.'||(b->>'operation') END;
 key:=b->>'idempotency_key';payload:=b-ARRAY['operation','idempotency_key'];
 -- Keep the original software's project fence before using this same-member verified management context.
 r:=authz.manage(effective,command,payload,key,encode(public.digest(payload::text,'sha256'),'hex'));
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','authorization.'||(b->>'operation'),(b->>'project_id')::uuid,r);
 RETURN r||jsonb_build_object('original_client_id',i->>'client_id');
END $$;

CREATE OR REPLACE FUNCTION authz.authorization_application_decision(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;t authz.application_targets;act text;deadline timestamptz;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO t FROM authz.application_targets WHERE application_id=b->>'application_id' AND active;
 IF t.application_id IS NULL OR b->>'action' NOT IN('read','write') OR b->>'action' IS NULL THEN RAISE EXCEPTION 'application_or_action_required' USING ERRCODE='22023';END IF;
 act:=CASE WHEN b->>'action'='read' THEN 'mem.read' ELSE 'mem.write' END;
 deadline:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,t.project_id,act,jsonb_build_object('project_id',t.project_id));
 IF NOT(i->>'until_revoked')::boolean THEN deadline:=least(deadline,(i->>'expires_at')::timestamptz);END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'application_permission_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','actor_id',i->>'actor_id','client_id',i->>'client_id','project_id',t.project_id,'application_id',t.application_id,'action',b->>'action','deadline',CASE WHEN isfinite(deadline) THEN to_jsonb(deadline) ELSE to_jsonb('until_revoked'::text) END,'member_profile',authz.member_profile_self(proof),'note','application_personal_record_ownership_must_also_be_respected');
END $$;

-- The current manage function already implements scoped grants, but its earlier
-- parameter gate accidentally rejected resource_selector for those commands.
DO $patch$
DECLARE definition text;needle text:= $needle$IF p_command<>'credential.create' AND p_body?|ARRAY['resource_selector','allowed_entries','qualification_ids']THEN RAISE EXCEPTION 'filter_only_at_credential_creation' USING ERRCODE='22023';END IF;$needle$;
BEGIN
 definition:=pg_get_functiondef('authz.manage(text,text,jsonb,text,text)'::regprocedure);
 IF position(needle in definition)>0 THEN
  definition:=replace(definition,needle,$replacement$IF (p_command<>'credential.create' AND p_body?|ARRAY['allowed_entries','qualification_ids']) OR (p_command NOT IN('credential.create','qualification.grant','management.delegate') AND p_body?'resource_selector') THEN RAISE EXCEPTION 'filter_only_at_credential_creation' USING ERRCODE='22023';END IF;$replacement$);
  EXECUTE definition;
 END IF;
END $patch$;

REVOKE ALL ON FUNCTION authz.business_actions(),authz.authorization_resolve(text,jsonb),authz.authorization_catalog(text,jsonb),authz.authorization_apply(text,jsonb),authz.authorization_applications(text,jsonb),authz.authorization_decide(text,jsonb),authz.authorization_revise(text,jsonb),authz.authorization_permissions(text,jsonb),authz.authorization_change(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authorization_resolve(text,jsonb),authz.authorization_catalog(text,jsonb),authz.authorization_apply(text,jsonb),authz.authorization_applications(text,jsonb),authz.authorization_decide(text,jsonb),authz.authorization_revise(text,jsonb),authz.authorization_permissions(text,jsonb),authz.authorization_change(text,jsonb) TO hub2_hufu;
REVOKE ALL ON FUNCTION authz.authorization_application_decision(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authorization_application_decision(text,jsonb) TO hub2_hufu;
CREATE OR REPLACE FUNCTION authz.authorization_actor_labels(proof text,actor_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;
BEGIN
 i:=authz.authenticate(proof);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'label',p.display_name)) FROM authz.principals p WHERE p.id=ANY(actor_ids) AND p.organization_id=(i->>'organization_id')::uuid),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION authz.authorization_actor_labels(text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authorization_actor_labels(text,uuid[]) TO hub2_hufu;

COMMIT;
