-- Project engineering: reuse native qualifications; bindings are software capabilities.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.engineering_projects(
 project_id uuid PRIMARY KEY REFERENCES v8.projects(id),title text NOT NULL,
 descriptor jsonb NOT NULL,ready boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 1);
CREATE TABLE authz.engineering_contexts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES authz.principals(id),
 client_id uuid NOT NULL REFERENCES authz.clients(id),credential_id uuid NOT NULL REFERENCES authz.credentials(id),
 primary_proof text NOT NULL,project_id uuid REFERENCES v8.projects(id),
 authority_source text NOT NULL CHECK(authority_source IN('verified_email_otp','explicit_user_approved_operator')),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE authz.engineering_bindings(
 project_id uuid NOT NULL REFERENCES authz.engineering_projects(project_id),client_id uuid NOT NULL REFERENCES authz.clients(id),
 qualification_id uuid NOT NULL REFERENCES authz.qualifications(id),expires_at timestamptz NOT NULL,
 approved_actor_id uuid NOT NULL REFERENCES authz.principals(id),PRIMARY KEY(project_id,client_id));
CREATE TABLE authz.engineering_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES authz.engineering_projects(project_id),
 actor_id uuid NOT NULL REFERENCES authz.principals(id),client_id uuid NOT NULL REFERENCES authz.clients(id),
 purpose text NOT NULL,requested_until timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','approved','rejected')),
 revision bigint NOT NULL DEFAULT 1,qualification_id uuid REFERENCES authz.qualifications(id),decided_by uuid REFERENCES authz.principals(id),
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));

CREATE FUNCTION authz.engineering_context_register(proof text,primary_proof text,p_project uuid,p_source text,p_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p jsonb;id uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_source NOT IN('verified_email_otp','explicit_user_approved_operator') OR p_until>clock_timestamp()+interval '3 hours' OR p_until<=clock_timestamp() THEN RAISE EXCEPTION 'invalid_management_context' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);p:=authz.authenticate(primary_proof);
 IF i->>'actor_id' IS DISTINCT FROM p->>'actor_id' OR p->>'is_primary'<>'true' THEN RAISE EXCEPTION 'same_current_primary_required' USING ERRCODE='42501';END IF;
 -- The operator variant is installed only by the server administrator, not exposed publicly.
 INSERT INTO authz.engineering_contexts(actor_id,client_id,credential_id,primary_proof,project_id,authority_source,expires_at)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,primary_proof,p_project,p_source,p_until) RETURNING engineering_contexts.id INTO id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.context',id,jsonb_build_object('source',p_source,'project_id',p_project,'expires_at',p_until,'email_verification_claimed',p_source='verified_email_otp'));
 RETURN jsonb_build_object('state','management_ready','context_id',id,'expires_at',p_until,'authority_source',p_source);
END $$;

CREATE FUNCTION authz.engineering_catalog(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',e.project_id,'title',e.title,'ready',e.ready,'resources',e.descriptor,'revision',e.revision)),'[]') INTO items
 FROM authz.engineering_projects e JOIN v8.projects p ON p.id=e.project_id WHERE p.organization_id=(i->>'organization_id')::uuid AND (p.visibility='team' OR p.owner_id=(i->>'actor_id')::uuid) AND authz.client_resource_allowed745((i->>'client_id')::uuid,p.id);
 RETURN jsonb_build_object('state','read','items',items);
END $$;

CREATE FUNCTION authz.engineering_management_proof(proof text,p_project uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;c authz.engineering_contexts;p jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF (i->>'is_primary')::boolean OR 'hufu.qualification.manage'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions'))) THEN RETURN proof;END IF;
 SELECT * INTO c FROM authz.engineering_contexts WHERE actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid AND expires_at>clock_timestamp() AND (project_id IS NULL OR project_id=p_project) ORDER BY created_at DESC LIMIT 1;
 IF c.id IS NULL THEN RAISE EXCEPTION 'management_verification_required' USING ERRCODE='42501';END IF;
 p:=authz.authenticate(c.primary_proof);
 IF p->>'actor_id' IS DISTINCT FROM i->>'actor_id' OR p->>'is_primary'<>'true' THEN RAISE EXCEPTION 'management_verification_required' USING ERRCODE='42501';END IF;
 RETURN c.primary_proof;
END $$;

CREATE FUNCTION authz.engineering_access(proof text,p_project uuid,p_operation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;b authz.engineering_bindings;q authz.qualifications;pr authz.engineering_projects;d timestamptz;act text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_operation NOT IN('read','write','deploy') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);act:='resource.'||p_operation;
 SELECT * INTO pr FROM authz.engineering_projects WHERE project_id=p_project;
 SELECT * INTO b FROM authz.engineering_bindings WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
 IF b.client_id IS NULL THEN
  -- A newly issued ordinary work client inherits this member's existing full-project grant.
  FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=(i->>'actor_id')::uuid AND project_id=p_project AND kind='work' AND actions@>ARRAY['resource.read','resource.write','resource.deploy'] LOOP
   d:=authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
   IF d IS NOT NULL AND d>clock_timestamp() THEN
    INSERT INTO authz.engineering_bindings VALUES(p_project,(i->>'client_id')::uuid,q.id,d,q.source_actor_id) ON CONFLICT DO NOTHING;
    SELECT * INTO b FROM authz.engineering_bindings WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
    EXIT;
   END IF;
  END LOOP;
 END IF;
 IF pr.ready IS DISTINCT FROM true OR b.client_id IS NULL OR b.expires_at<=clock_timestamp() OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) THEN RAISE EXCEPTION 'engineering_project_access_required' USING ERRCODE='42501';END IF;
 IF NOT('mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';END IF;
 d:=authz.qualification_deadline(b.qualification_id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
 IF d IS NULL THEN RAISE EXCEPTION 'engineering_qualification_expired_or_revoked' USING ERRCODE='42501';END IF;
 RETURN i||jsonb_build_object('project_id',p_project,'deadline',least(d,b.expires_at),'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',b.qualification_id);
END $$;

CREATE FUNCTION authz.engineering_grant(proof text,p_project uuid,p_principal uuid,p_until timestamptz,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE effective text;i jsonb;r jsonb;qid uuid;acts jsonb;client record;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_until<=clock_timestamp() OR p_until>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_engineering_grant' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);effective:=authz.engineering_management_proof(proof,p_project);
 IF NOT EXISTS(SELECT FROM authz.engineering_projects WHERE project_id=p_project AND ready) THEN RAISE EXCEPTION 'engineering_resources_not_ready' USING ERRCODE='42501';END IF;
 acts:='["mem.upload","mem.read","mem.write","mem.delete","mem.share","mem.process","mem.correct","v8.project.read","v8.work.open","v8.work.read","v8.work.commit","v8.work.related_candidates","v8.adoption.set","v8.adoption.read","v8.context.prepare","v8.context.materialize","v8.context.read","v8.handoff.record","v8.handoff.read","v8.experience.publish","v8.experience.feedback","v8.experience.read","resource.read","resource.write","resource.deploy"]'::jsonb;
 r:=authz.manage(effective,'qualification.grant',jsonb_build_object('project_id',p_project,'principal_id',p_principal,'actions',acts,'expires_at',p_until),p_key,encode(public.digest(jsonb_build_object('project_id',p_project,'principal_id',p_principal,'actions',acts,'expires_at',p_until)::text,'sha256'),'hex'));
 qid:=(r->>'qualification_id')::uuid;
 FOR client IN SELECT id FROM authz.clients WHERE principal_id=p_principal AND active AND 'mem.write'=ANY(actions) AND authz.client_resource_allowed745(id,p_project) LOOP
  INSERT INTO authz.engineering_bindings VALUES(p_project,client.id,qid,p_until,(i->>'actor_id')::uuid)
  ON CONFLICT(project_id,client_id) DO UPDATE SET qualification_id=EXCLUDED.qualification_id,expires_at=EXCLUDED.expires_at,approved_actor_id=EXCLUDED.approved_actor_id;
 END LOOP;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.resources.granted',qid,jsonb_build_object('project_id',p_project,'principal_id',p_principal,'expires_at',p_until,'resources_ready',true));
 RETURN r||jsonb_build_object('resources_ready',true,'project_id',p_project,'expires_at',p_until,'qualification_scope','whole_registered_project','software_binding','current_work_capable_project_allowed_clients');
END $$;

CREATE FUNCTION authz.engineering_request(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.engineering_requests;
BEGIN
 i:=authz.authenticate(proof);
 IF NOT EXISTS(SELECT FROM authz.engineering_projects WHERE project_id=(b->>'project_id')::uuid) OR length(b->>'purpose') NOT BETWEEN 1 AND 4000 OR length(b->>'idempotency_key') NOT BETWEEN 1 AND 200 OR (b->>'requested_until')::timestamptz<=clock_timestamp() OR (b->>'requested_until')::timestamptz>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 INSERT INTO authz.engineering_requests(project_id,actor_id,client_id,purpose,requested_until,idempotency_key) VALUES((b->>'project_id')::uuid,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'purpose',(b->>'requested_until')::timestamptz,b->>'idempotency_key') ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
 SELECT * INTO r FROM authz.engineering_requests WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.project_id<>(b->>'project_id')::uuid OR r.purpose<>b->>'purpose' OR r.requested_until<>(b->>'requested_until')::timestamptz THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r));
END $$;
CREATE FUNCTION authz.engineering_requests_read(proof text,p_view text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF p_view='pending' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin') THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF p_view NOT IN('mine','pending') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC),'[]') INTO items FROM authz.engineering_requests r WHERE (p_view='mine' AND actor_id=(i->>'actor_id')::uuid) OR (p_view='pending' AND state='pending' AND project_id IN(SELECT id FROM v8.projects WHERE organization_id=(i->>'organization_id')::uuid));
 RETURN jsonb_build_object('state','read','items',items);
END $$;
CREATE FUNCTION authz.engineering_decide(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.engineering_requests;grant_result jsonb;effective text;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.engineering_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR r.revision<>(b->>'expected_revision')::bigint OR r.state<>'pending' THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,r.project_id);
 IF NOT EXISTS(SELECT FROM v8.projects p JOIN authz.principals actor ON actor.id=(i->>'actor_id')::uuid WHERE p.id=r.project_id AND (p.manager_id=actor.id OR (actor.role='organization_admin' AND p.organization_id=actor.organization_id))) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision'='approve' THEN
  grant_result:=authz.engineering_grant(proof,r.project_id,r.actor_id,least(r.requested_until,coalesce((b->>'expires_at')::timestamptz,r.requested_until)),'engineering-approval:'||r.id);
 ELSIF b->>'decision'<>'reject' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 UPDATE authz.engineering_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,qualification_id=(grant_result->>'qualification_id')::uuid WHERE id=r.id RETURNING * INTO r;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'actual_resources',grant_result);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA authz FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.engineering_context_register(text,text,uuid,text,timestamptz),authz.engineering_management_proof(text,uuid),authz.engineering_access(text,uuid,text),authz.engineering_grant(text,uuid,uuid,timestamptz,text),authz.engineering_request(text,jsonb),authz.engineering_requests_read(text,text),authz.engineering_decide(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_context_register(text,text,uuid,text,timestamptz),authz.engineering_management_proof(text,uuid),authz.engineering_access(text,uuid,text),authz.engineering_grant(text,uuid,uuid,timestamptz,text),authz.engineering_request(text,jsonb),authz.engineering_requests_read(text,text),authz.engineering_decide(text,jsonb) TO hub2_hufu;
REVOKE ALL ON FUNCTION authz.engineering_catalog(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_catalog(text) TO hub2_hufu;
CREATE FUNCTION authz.engineering_member_email(proof text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;email text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 SELECT u.email INTO email FROM authz.member_accounts m JOIN authn."user" u ON u.id=m.authn_user_id WHERE m.principal_id=(i->>'actor_id')::uuid AND u."emailVerified";
 IF email IS NULL THEN RAISE EXCEPTION 'verified_member_email_required' USING ERRCODE='42501';END IF;
 RETURN email;
END $$;
REVOKE ALL ON FUNCTION authz.engineering_member_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_member_email(text) TO hub2_hufu;
RESET ROLE;
