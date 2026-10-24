-- Root registered external targets; member release facts; original processing-run dispatch.
-- No model key, endpoint, credential, permission grant or parallel processing truth here.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.external_owner_deadline(actor uuid,pid uuid,r jsonb)RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals;pr record;q record;deadline timestamptz;best timestamptz;
BEGIN
 -- Lock the real owner/delegation dependencies, independent of an old login session.
 PERFORM authz.lock_resources(actor,NULL,NULL,jsonb_build_array(r));
 SELECT * INTO p FROM authz.principals WHERE id=actor;SELECT * INTO pr FROM v8.projects WHERE id=pid;
 IF p.active IS DISTINCT FROM true OR pr.id IS NULL OR pr.state<>'active'OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',pid,r)THEN RETURN NULL;END IF;
 IF pr.visibility='personal'AND pr.owner_id=actor THEN RETURN 'infinity';END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=actor AND project_id=pid AND kind='work'ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,actor,pid,'mem.share',r);
  IF deadline IS NOT NULL AND(best IS NULL OR deadline>best)THEN best:=deadline;END IF;
 END LOOP;RETURN best;
END $$;
CREATE FUNCTION authz.external_selector_deadline(actor uuid,pid uuid,s jsonb)RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE field text;x text;r jsonb;deadline timestamptz;until_at timestamptz:='infinity';
BEGIN
 IF NOT authz.valid_selector(s)THEN RAISE EXCEPTION 'external_selector_invalid' USING ERRCODE='42501';END IF;
 IF s->>'kind'='project'THEN until_at:=authz.external_owner_deadline(actor,pid,jsonb_build_object('project_id',pid));
 ELSE
  FOREACH field IN ARRAY ARRAY['materials','collections','areas']LOOP
   FOR x IN SELECT jsonb_array_elements_text(coalesce(s->field,'[]'))LOOP
    IF field='materials'AND NOT EXISTS(SELECT FROM mem.materials WHERE id=x::uuid AND project_id=pid)THEN RAISE EXCEPTION 'external_selector_binding_invalid' USING ERRCODE='42501';END IF;
    r:=jsonb_build_object('project_id',pid,CASE field WHEN'materials'THEN'material_id'WHEN'collections'THEN'collection_id'ELSE'area_id'END,x);
    deadline:=authz.external_owner_deadline(actor,pid,r);IF deadline IS NULL THEN RAISE EXCEPTION 'external_share_scope_forbidden' USING ERRCODE='42501';END IF;until_at:=least(until_at,deadline);
   END LOOP;
  END LOOP;
 END IF;
 IF until_at IS NULL OR until_at<=clock_timestamp()THEN RAISE EXCEPTION 'external_share_scope_forbidden' USING ERRCODE='42501';END IF;RETURN until_at;
END $$;
REVOKE ALL ON FUNCTION authz.external_owner_deadline(uuid,uuid,jsonb),authz.external_selector_deadline(uuid,uuid,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.external_owner_deadline(uuid,uuid,jsonb),authz.external_selector_deadline(uuid,uuid,jsonb),authz.selector_matches(jsonb,uuid,jsonb),authz.valid_selector(jsonb)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE TABLE mem.external_model_targets(
 id text PRIMARY KEY CHECK(length(id)BETWEEN 1 AND 200),organization_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),descriptor_hash text NOT NULL CHECK(descriptor_hash~'^[a-f0-9]{64}$'),
 recipe jsonb NOT NULL CHECK(jsonb_typeof(recipe)='object'AND recipe?&ARRAY['provider','model','version']AND jsonb_typeof(recipe->'version')='string'),
 active boolean NOT NULL DEFAULT false,public_facts jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE mem.external_model_releases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,provider_target_id text NOT NULL REFERENCES mem.external_model_targets,
 resource_selector jsonb NOT NULL CHECK(authz.valid_selector(resource_selector)),fixed_constraints jsonb NOT NULL DEFAULT '[]'CHECK(jsonb_typeof(fixed_constraints)='array'),
 purpose text NOT NULL DEFAULT 'audio_transcription',actor_id uuid NOT NULL,client_id uuid NOT NULL,authority_basis jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'active'CHECK(state IN('active','revoked')),
 until_revoked boolean NOT NULL DEFAULT false,expires_at timestamptz,reason jsonb,evidence jsonb,
 CHECK(until_revoked OR expires_at IS NOT NULL));
CREATE TABLE mem.external_model_release_history(release_id uuid NOT NULL REFERENCES mem.external_model_releases,revision bigint NOT NULL,snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(release_id,revision));
CREATE TABLE mem.external_model_dispatches(
 run_id uuid PRIMARY KEY REFERENCES mem.processing_runs,fact_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),project_id uuid NOT NULL,actor_id uuid NOT NULL,created_client_id uuid NOT NULL,
 provider_target_id text NOT NULL,request_hash text NOT NULL,input_refs jsonb NOT NULL,source_refs jsonb NOT NULL,dispatch_state text NOT NULL DEFAULT 'prepared'CHECK(dispatch_state IN('prepared','intent','known','unknown')),
 permit jsonb,intent_id uuid,consumed_tuple jsonb,provider_task_id text,provider_request_id text,outcome jsonb,
 revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(provider_target_id,provider_task_id));
REVOKE ALL ON mem.external_model_targets,mem.external_model_releases,mem.external_model_release_history,mem.external_model_dispatches FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
RESET ROLE;
GRANT SELECT ON mem.external_model_releases TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
-- Keep the old resource function and its action rules byte-for-byte, inserting only the typed share branch.
DO $$DECLARE def text;marker text:=' IF (pr.state';replacement text;BEGIN
 def:=pg_get_functiondef('authz.resource_deadline(uuid,uuid,uuid,text,jsonb)'::regprocedure);
 IF position(marker IN def)=0 THEN RAISE EXCEPTION 'resource_deadline_extension_anchor_missing';END IF;
 replacement:=E' IF p_action=''mem.share'' AND (r?''external_release_selector'' OR r?''release_id'') THEN\n  IF r?''release_id'' THEN SELECT resource_selector INTO r FROM mem.external_model_releases WHERE id=(r->>''release_id'')::uuid AND project_id=p_project;ELSE r:=r->''external_release_selector'';END IF;\n  RETURN authz.external_selector_deadline(p_actor,p_project,r);\n END IF;\n'||marker;
 EXECUTE replace(def,marker,replacement);
END $$;
-- A real handle deadline includes the entire current credential family, not its brief Hufu ticket TTL.
CREATE FUNCTION authz.external_permit_deadline(hid uuid)RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;bound_deadline timestamptz;family_until timestamptz;refresh_until timestamptz;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF authz.runtime_role()IS DISTINCT FROM'hub2_mem'OR h.action IS DISTINCT FROM'mem.process'OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()THEN RAISE EXCEPTION 'external_permit_guard_required' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(hid);
 WITH RECURSIVE f AS(SELECT id,parent_credential_id,expires_at,until_revoked FROM authz.credentials WHERE id=h.credential_id UNION SELECT p.id,p.parent_credential_id,p.expires_at,p.until_revoked FROM authz.credentials p JOIN f ON p.id=f.parent_credential_id)
 SELECT min(CASE WHEN until_revoked THEN'infinity'::timestamptz ELSE expires_at END)INTO family_until FROM f;
 SELECT least(f.expires_at,CASE WHEN o.until_revoked THEN'infinity'::timestamptz ELSE o.expires_at END)INTO refresh_until FROM authz.credentials cc JOIN authz.refresh_families f ON f.id=cc.family_id JOIN authz.credentials o ON o.id=f.origin_credential_id WHERE cc.id=h.credential_id;family_until:=least(family_until,coalesce(refresh_until,'infinity'));
 bound_deadline:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,'mem.process',coalesce(h.resource->'resolved_resource',h.resource));
 SELECT least(bound_deadline,coalesce(min(s.deadline),'infinity'))INTO bound_deadline FROM authz.handle_sources s WHERE handle_id=hid;
 RETURN least(clock_timestamp()+interval '30 seconds',family_until,bound_deadline);
END $$;
REVOKE ALL ON FUNCTION authz.external_permit_deadline(uuid)FROM PUBLIC;GRANT EXECUTE ON FUNCTION authz.external_permit_deadline(uuid)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.external_release_create(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;replay jsonb;r mem.external_model_releases;t mem.external_model_targets;deadline timestamptz;ref jsonb;v mem.content_versions;src record;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.share',d,b);replay:=mem.replay_command(c,'external_release_create',b,d);IF replay IS NOT NULL THEN RETURN replay;END IF;
 SELECT * INTO t FROM mem.external_model_targets WHERE id=b->>'provider_target_id'FOR SHARE;
 IF t.id IS NULL OR NOT t.active OR t.organization_id IS DISTINCT FROM(SELECT organization_id FROM v8.projects WHERE id=(c->>'project_id')::uuid)THEN RAISE EXCEPTION 'external_target_unavailable' USING ERRCODE='42501';END IF;
 deadline:=authz.external_selector_deadline((c->>'actor_id')::uuid,(c->>'project_id')::uuid,b->'external_release_selector');
 FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(b->'fixed_constraints','[]'))LOOP
  SELECT * INTO v FROM mem.content_versions WHERE id=(ref->>'version_id')::uuid AND sha256=ref->>'sha256';
  IF v.id IS NULL OR NOT authz.selector_matches(b->'external_release_selector',(c->>'project_id')::uuid,jsonb_build_object('project_id',c->>'project_id','material_id',v.material_id))OR v.material_id IS DISTINCT FROM(ref->>'material_id')::uuid THEN RAISE EXCEPTION 'external_fixed_constraint_invalid' USING ERRCODE='42501';END IF;
  PERFORM mem.assert_version_sources(h,v.id,'mem.share');
 END LOOP;
 IF b->'until_revoked'IS DISTINCT FROM'true'::jsonb AND((b->>'expires_at')::timestamptz IS NULL OR(b->>'expires_at')::timestamptz<=clock_timestamp())THEN RAISE EXCEPTION 'external_release_expiry_required';END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.external_model_releases(project_id,provider_target_id,resource_selector,fixed_constraints,purpose,actor_id,client_id,authority_basis,until_revoked,expires_at,reason,evidence)
 VALUES((c->>'project_id')::uuid,t.id,b->'external_release_selector',coalesce(b->'fixed_constraints','[]'),coalesce(b->>'purpose','audio_transcription'),(c->>'actor_id')::uuid,(c->>'client_id')::uuid,jsonb_build_object('kind','current_mem_share_recomputed_at_effect','authorized_until',deadline,'target_revision',t.revision),coalesce((b->>'until_revoked')::boolean,false),(b->>'expires_at')::timestamptz,b->'reason',b->'evidence')RETURNING * INTO r;
 INSERT INTO mem.external_model_release_history VALUES(r.id,r.revision,to_jsonb(r),clock_timestamp());
 PERFORM mem.emit(c,'external_release.created',r.id,r.revision,NULL,jsonb_build_object('provider_target_id',t.id,'release_id',r.id));PERFORM authz.assert_effect(h);
 RETURN mem.remember_command(c,'external_release_create',b,d,jsonb_build_object('state','active','release_id',r.id,'release_revision',r.revision,'external_release',to_jsonb(r)));
END $$;
CREATE FUNCTION mem.external_release_revoke(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.external_model_releases;replay jsonb;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.share',d,b);
 replay:=mem.replay_command(c,'external_release_revoke',b,d);IF replay IS NOT NULL THEN RETURN replay;END IF;
 SELECT * INTO r FROM mem.external_model_releases WHERE id=(b->>'release_id')::uuid AND project_id=(c->>'project_id')::uuid FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'external_release_forbidden' USING ERRCODE='42501';END IF;
 IF r.state='active'THEN UPDATE mem.external_model_releases SET state='revoked',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
 INSERT INTO mem.external_model_release_history VALUES(r.id,r.revision,to_jsonb(r),clock_timestamp());PERFORM mem.emit(c,'external_release.revoked',r.id,r.revision,NULL,jsonb_build_object('release_id',r.id));END IF;
 PERFORM authz.assert_effect(h);RETURN mem.remember_command(c,'external_release_revoke',b,d,jsonb_build_object('state',r.state,'release_id',r.id,'release_revision',r.revision));
END $$;
CREATE FUNCTION mem.external_job_view(runid uuid)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT jsonb_build_object('job_id',r.id,'run_id',r.id,'project_id',r.project_id,'actor_id',r.actor_id,'created_client_id',r.client_id,'recipe',r.recipe,'input_fixed_ref',jsonb_build_object('project_id',r.project_id,'material_id',cv.material_id,'version_id',cv.id,'sha256',cv.sha256,'size',cv.size),'provider_target_id',x.provider_target_id,'dispatch_state',x.dispatch_state,'intent_id',x.intent_id,'permit_id',x.permit->'permit_id','attempt',r.attempt,'fencing_token',r.fencing_token,'provider_task_id',x.provider_task_id,'provider_request_id',x.provider_request_id,'technical_state',r.technical_state,'outputs',r.outputs,'revision',x.revision)
 FROM mem.processing_runs r JOIN mem.external_model_dispatches x ON x.run_id=r.id JOIN mem.content_versions cv ON cv.id=(r.inputs->0->>'version_id')::uuid WHERE r.id=runid $$;
CREATE FUNCTION mem.external_recipe(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;t mem.external_model_targets;r mem.processing_runs;x mem.external_model_dispatches;recipe jsonb;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.process',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'processing_key';
 IF r.id IS NOT NULL THEN SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=r.id;
  IF r.project_id IS DISTINCT FROM(c->>'project_id')::uuid OR r.declaration->>'external_target_id'IS DISTINCT FROM b->>'provider_target_id'OR r.declaration->>'external_request_hash'IS DISTINCT FROM b->>'request_hash'OR(x.run_id IS NOT NULL AND(x.project_id IS DISTINCT FROM(c->>'project_id')::uuid OR x.request_hash IS DISTINCT FROM b->>'request_hash'))THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='40001';END IF;
  PERFORM authz.assert_effect(h);IF x.run_id IS NULL THEN RETURN jsonb_build_object('state','existing_unbound','run_id',r.id);END IF;RETURN jsonb_build_object('state','existing','job',mem.external_job_view(r.id));END IF;
 SELECT * INTO t FROM mem.external_model_targets WHERE id=b->>'provider_target_id'AND organization_id=(SELECT organization_id FROM v8.projects WHERE id=(c->>'project_id')::uuid);
 -- Unknown targets remain useful declarations/drafts, and never authorize a send.
 recipe:=jsonb_build_object('name','unknown','version','unknown','provider','unknown','model','unknown')||coalesce(t.recipe,jsonb_build_object('provider','unregistered','model',b->>'provider_target_id','version','unregistered'))||jsonb_build_object('parameters',coalesce(b->'parameters','{}'));
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','recipe','recipe',recipe,'target_available',coalesce(t.active,false));
END $$;
CREATE FUNCTION mem.external_bind(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.processing_runs;x mem.external_model_dispatches;added integer;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.process',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR jsonb_array_length(r.inputs)<>1 OR r.declaration->>'external_target_id'IS DISTINCT FROM b->>'provider_target_id'OR r.declaration->>'external_request_hash'IS DISTINCT FROM b->>'request_hash'THEN RAISE EXCEPTION 'external_run_binding_invalid' USING ERRCODE='42501';END IF;
 INSERT INTO mem.external_model_dispatches(run_id,project_id,actor_id,created_client_id,provider_target_id,request_hash,input_refs,source_refs)VALUES(r.id,r.project_id,r.actor_id,r.client_id,b->>'provider_target_id',b->>'request_hash',r.inputs,coalesce((SELECT jsonb_agg(jsonb_build_object('version_id',cl.version_id))FROM mem.source_closure((r.inputs->0->>'version_id')::uuid)cl),'[]'))ON CONFLICT(run_id)DO NOTHING;GET DIAGNOSTICS added=ROW_COUNT;
 SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=r.id;
 IF x.request_hash IS DISTINCT FROM b->>'request_hash'OR x.provider_target_id IS DISTINCT FROM b->>'provider_target_id'THEN RAISE EXCEPTION 'external_run_binding_changed' USING ERRCODE='40001';END IF;
 IF added=1 THEN PERFORM mem.emit(c,'external_dispatch.prepared',x.fact_id,1,NULL,jsonb_build_object('run_id',r.id,'provider_target_id',x.provider_target_id));END IF;PERFORM authz.assert_effect(h);RETURN mem.external_job_view(r.id);
END $$;
CREATE FUNCTION mem.external_current(h uuid,c jsonb,runid uuid,source_delivery boolean DEFAULT false)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE r mem.processing_runs;x mem.external_model_dispatches;t mem.external_model_targets;rel mem.external_model_releases;v mem.content_versions;src record;closure jsonb;deadline timestamptz;rd timestamptz;resource jsonb;share_until timestamptz;matched boolean:=false;
BEGIN
 SELECT * INTO r FROM mem.processing_runs WHERE id=runid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR SHARE;
 SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=r.id;
 IF r.id IS NULL OR x.run_id IS NULL OR r.technical_state='cancelled'OR jsonb_array_length(r.inputs)<>1 THEN RAISE EXCEPTION 'external_job_forbidden' USING ERRCODE='42501';END IF;
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(r.inputs->0->>'version_id')::uuid AND cv.sha256=r.inputs->0->>'sha256'AND m.project_id=r.project_id;
 IF v.id IS NULL OR mem.gc_physical_state(v.object_id)IS DISTINCT FROM'retained'OR EXISTS(SELECT FROM mem.verified_objects WHERE id=v.object_id AND availability IS DISTINCT FROM'available')THEN RAISE EXCEPTION 'external_fixed_input_unavailable' USING ERRCODE='42501';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 -- Full actual closure is bound even when an old disclosure permits reading the output alone.
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256,'size',cv.size)ORDER BY m.project_id,cv.id),'[]')INTO closure FROM mem.source_closure(v.id)cl JOIN mem.content_versions cv ON cv.id=cl.version_id JOIN mem.materials m ON m.id=cv.material_id;
 PERFORM authz.assert_sources(h,closure,'mem.read');
 IF x.dispatch_state<>'prepared'AND(x.consumed_tuple->'input_fixed_ref'IS DISTINCT FROM mem.external_job_view(r.id)->'input_fixed_ref'OR x.consumed_tuple->>'parameter_hash'IS DISTINCT FROM encode(public.digest(r.recipe::text,'sha256'),'hex')OR(x.consumed_tuple->>'attempt')::bigint IS DISTINCT FROM r.attempt OR(x.consumed_tuple->>'fencing_token')::uuid IS DISTINCT FROM r.fencing_token)THEN RETURN mem.external_job_view(r.id)||jsonb_build_object('state','processing_binding_changed','next_step','retain_original_intent;do_not_resubmit');END IF;
 IF x.dispatch_state IN('intent','known','unknown')AND NOT source_delivery THEN
  RETURN mem.external_job_view(r.id)||jsonb_build_object('state','continuation_authorized','client_id',c->>'client_id','send_authorized',false,'source_delivery_authorized',false,'consumed_permit',x.consumed_tuple,'next_step','query_existing_intent_or_known_task;never_submit_again');
 END IF;
 SELECT * INTO t FROM mem.external_model_targets WHERE id=x.provider_target_id FOR SHARE;
 IF t.id IS NULL OR NOT t.active OR t.organization_id IS DISTINCT FROM(SELECT organization_id FROM v8.projects WHERE id=r.project_id)OR(r.recipe-'parameters')IS DISTINCT FROM((jsonb_build_object('name','unknown','version','unknown','provider','unknown','model','unknown')||t.recipe)-'parameters')THEN RETURN mem.external_job_view(r.id)||jsonb_build_object('state','target_unavailable','next_step','retain_original_run;register_matching_target_or_prepare_new_declaration');END IF;
 deadline:=authz.external_permit_deadline(h);
 FOR rel IN SELECT * FROM mem.external_model_releases WHERE project_id=r.project_id AND provider_target_id=t.id AND state='active'AND(until_revoked OR expires_at>clock_timestamp())ORDER BY id FOR SHARE LOOP
  resource:=jsonb_build_object('project_id',r.project_id,'material_id',v.material_id);
  IF NOT authz.selector_matches(rel.resource_selector,r.project_id,resource)THEN CONTINUE;END IF;
  IF jsonb_array_length(rel.fixed_constraints)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(rel.fixed_constraints)f WHERE(f->>'material_id')::uuid=v.material_id AND(f->>'version_id')::uuid=v.id AND f->>'sha256'=v.sha256)THEN CONTINUE;END IF;
  rd:=CASE WHEN rel.until_revoked THEN'infinity'::timestamptz ELSE rel.expires_at END;matched:=true;
  FOR src IN SELECT value ref FROM jsonb_array_elements(closure)LOOP
   -- No external share of unresolved provenance; no extra semantic/narrative requirement.
   IF EXISTS(SELECT FROM mem.content_versions WHERE id=(src.ref->>'version_id')::uuid AND provenance_state='pending')THEN matched:=false;EXIT;END IF;
   share_until:=authz.external_owner_deadline(rel.actor_id,(src.ref->>'project_id')::uuid,src.ref);
   IF share_until IS NULL OR share_until<=clock_timestamp()THEN matched:=false;EXIT;END IF;rd:=least(rd,share_until);
  END LOOP;
  IF matched THEN RETURN mem.external_job_view(r.id)||jsonb_build_object('state','authorized','send_authorized',x.dispatch_state='prepared','source_delivery_authorized',true,'client_id',c->>'client_id','provider_target_id',t.id,'target_revision',t.revision,'descriptor_hash',t.descriptor_hash,'release_id',rel.id,'release_revision',rel.revision,'parameter_hash',encode(public.digest(r.recipe::text,'sha256'),'hex'),'source_closure_hash',encode(public.digest(closure::text,'sha256'),'hex'),'deadline',least(deadline,rd),'source_closure',closure);END IF;
 END LOOP;
 RETURN mem.external_job_view(r.id)||jsonb_build_object('state','scope_needed','next_step','retain_draft;authorized_owner_can_use_mem.disclosure.create_with_provider_target_id_and_resource_selector');
END $$;
CREATE FUNCTION mem.external_check(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;result jsonb;
BEGIN IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);result:=mem.external_current(h,c,(b->>'run_id')::uuid,coalesce(b->>'usage','continuation')='source');PERFORM authz.assert_effect(h);RETURN result;END $$;
CREATE FUNCTION mem.external_permit(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.processing_runs;x mem.external_model_dispatches;result jsonb;new_permit jsonb;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.process',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid FOR UPDATE;SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=r.id FOR UPDATE;
 result:=mem.external_current(h,c,r.id);
 IF result->>'state'<>'authorized'THEN RETURN result;END IF;
 IF x.dispatch_state<>'prepared'THEN RETURN result||jsonb_build_object('state',CASE WHEN x.dispatch_state='intent'THEN'already_intent'ELSE x.dispatch_state END);END IF;
 IF r.technical_state<>'prepared'OR r.lease_until<=clock_timestamp()THEN RAISE EXCEPTION 'external_processing_not_prepared' USING ERRCODE='40001';END IF;
 new_permit:=(result-ARRAY['state','next_step','recipe','technical_state','outputs','revision','dispatch_state','provider_task_id','provider_request_id','intent_id','source_closure','send_authorized','source_delivery_authorized'])||jsonb_build_object('permit_id',gen_random_uuid(),'deadline',least((result->>'deadline')::timestamptz,r.lease_until),'attempt',r.attempt,'fencing_token',r.fencing_token);
 PERFORM authz.assert_effect(h);UPDATE mem.external_model_dispatches SET permit=new_permit,updated_at=clock_timestamp()WHERE run_id=r.id;
 RETURN new_permit||jsonb_build_object('state','authorized');
END $$;
CREATE FUNCTION mem.external_consume(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.processing_runs;x mem.external_model_dispatches;current_result jsonb;expected jsonb;intent uuid;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.process',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid FOR UPDATE;SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=r.id FOR UPDATE;
 current_result:=mem.external_current(h,c,r.id);
 IF x.dispatch_state<>'prepared'THEN
  IF current_result->>'state'IS DISTINCT FROM'continuation_authorized'OR b IS DISTINCT FROM x.consumed_tuple THEN RAISE EXCEPTION 'external_continuation_tuple_changed' USING ERRCODE='42501';END IF;
  RETURN mem.external_job_view(r.id)||jsonb_build_object('state',CASE WHEN x.dispatch_state='intent'THEN'already_intent'ELSE x.dispatch_state END,'send_authorized',false,'consumed_permit',x.consumed_tuple);
 END IF;
 IF current_result->>'state'IS DISTINCT FROM'authorized'THEN RAISE EXCEPTION 'external_release_not_current' USING ERRCODE='42501';END IF;
 expected:=x.permit;
 IF expected IS NULL OR b IS DISTINCT FROM expected OR(expected->>'deadline')::timestamptz<=clock_timestamp()OR(expected->>'client_id')::uuid IS DISTINCT FROM(c->>'client_id')::uuid
 OR(expected->>'target_revision')::bigint IS DISTINCT FROM(current_result->>'target_revision')::bigint OR(expected->>'release_id')::uuid IS DISTINCT FROM(current_result->>'release_id')::uuid OR(expected->>'release_revision')::bigint IS DISTINCT FROM(current_result->>'release_revision')::bigint
 OR expected->>'descriptor_hash'IS DISTINCT FROM current_result->>'descriptor_hash'OR expected->>'parameter_hash'IS DISTINCT FROM current_result->>'parameter_hash'OR expected->>'source_closure_hash'IS DISTINCT FROM current_result->>'source_closure_hash'
 OR expected->'input_fixed_ref'IS DISTINCT FROM current_result->'input_fixed_ref'OR(expected->>'attempt')::bigint IS DISTINCT FROM r.attempt OR(expected->>'fencing_token')::uuid IS DISTINCT FROM r.fencing_token OR r.technical_state<>'prepared'OR r.lease_until<=clock_timestamp()THEN RAISE EXCEPTION 'external_permit_changed' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);intent:=gen_random_uuid();UPDATE mem.external_model_dispatches SET dispatch_state='intent',intent_id=intent,consumed_tuple=expected,revision=revision+1,updated_at=clock_timestamp()WHERE run_id=r.id;
 PERFORM mem.emit(c,'external_dispatch.intent',x.fact_id,x.revision+1,NULL,jsonb_build_object('intent_id',intent,'provider_target_id',x.provider_target_id,'attempt',r.attempt));PERFORM authz.assert_effect(h);
 RETURN mem.external_job_view(r.id)||jsonb_build_object('state','consumed','permit',expected);
END $$;
-- Called only by the target-scoped protected holder endpoint. No new effect/read/publication authority.
CREATE FUNCTION mem.external_outcome(payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;x mem.external_model_dispatches;receipt jsonb:=b->'outcome';
BEGIN
 IF authz.runtime_role()IS DISTINCT FROM'hub2_mem'THEN RAISE EXCEPTION 'external_holder_role_forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO x FROM mem.external_model_dispatches WHERE run_id=(b->>'run_id')::uuid FOR UPDATE;
 IF x.run_id IS NULL OR x.project_id IS DISTINCT FROM(b->>'project_id')::uuid OR x.provider_target_id IS DISTINCT FROM b->>'provider_target_id'OR x.intent_id IS DISTINCT FROM(b->>'intent_id')::uuid OR x.consumed_tuple IS DISTINCT FROM b->'permit'OR x.dispatch_state NOT IN('intent','known','unknown')OR receipt->>'state'IS NULL OR receipt->>'state'NOT IN('known','unknown')THEN RAISE EXCEPTION 'external_outcome_tuple_invalid' USING ERRCODE='42501';END IF;
 IF x.dispatch_state='known'THEN
  IF receipt->>'state'='known'AND x.provider_task_id IS DISTINCT FROM receipt->>'provider_task_id'THEN RAISE EXCEPTION 'external_known_task_changed' USING ERRCODE='40001';END IF;RETURN mem.external_job_view(x.run_id);END IF;
 IF receipt->>'state'='known'AND(length(coalesce(receipt->>'provider_task_id',''))NOT BETWEEN 1 AND 500)THEN RAISE EXCEPTION 'external_task_id_required';END IF;
 UPDATE mem.external_model_dispatches SET dispatch_state=receipt->>'state',provider_task_id=CASE WHEN receipt->>'state'='known'THEN receipt->>'provider_task_id'ELSE provider_task_id END,provider_request_id=receipt->>'provider_request_id',outcome=receipt,revision=revision+1,updated_at=clock_timestamp()WHERE run_id=x.run_id;
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)SELECT'mem',fact_id,revision,'external_dispatch.outcome',project_id,jsonb_build_object('intent_id',intent_id,'dispatch_state',dispatch_state,'provider_task_id',provider_task_id)FROM mem.external_model_dispatches WHERE run_id=x.run_id;
 RETURN mem.external_job_view(x.run_id);
END $$;
-- Explicit dispatch typed refs share the original run lifecycle; no UUID extraction from notes.
DO $$DECLARE def text;marker text:=' -- Dedicated live lease table';BEGIN
 def:=pg_get_functiondef('mem.gc_fact_keys(text,text,jsonb)'::regprocedure);
 IF position(marker IN def)=0 THEN RAISE EXCEPTION 'gc_typed_dispatch_extension_anchor_missing';END IF;
 EXECUTE replace(def,marker,E' IF sch=''mem''AND tbl=''external_model_dispatches''THEN IF EXISTS(SELECT FROM mem.processing_runs pr WHERE pr.id=(rowvalue->>''run_id'')::uuid AND pr.technical_state NOT IN(''succeeded'',''cancelled''))THEN RETURN QUERY SELECT * FROM mem.gc_reference_keys(jsonb_build_array(rowvalue->''input_refs'',rowvalue->''source_refs''));END IF;RETURN;END IF;\n'||marker);
END $$;
-- Only live processing inputs consume bytes. Historical target/release/audit facts retain IDs, not bytes.
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['external_model_targets','external_model_releases','external_model_release_history','external_model_dispatches']LOOP
 EXECUTE format('CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE ON mem.%I FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence()',name);
 INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,shape_hash)VALUES('mem',name,'ledger',mem.gc_relation_shape(('mem.'||name)::regclass));
 END LOOP;UPDATE mem.gc_reference_contracts SET kind='reference',json_fields=ARRAY['input_refs','source_refs']WHERE schema_name='mem'AND table_name='external_model_dispatches';END $$;
REVOKE ALL ON FUNCTION mem.external_release_create(uuid,text,text),mem.external_release_revoke(uuid,text,text),mem.external_job_view(uuid),mem.external_recipe(uuid,text,text),mem.external_bind(uuid,text,text),mem.external_current(uuid,jsonb,uuid,boolean),mem.external_check(uuid,text,text),mem.external_permit(uuid,text,text),mem.external_consume(uuid,text,text),mem.external_outcome(text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.external_release_create(uuid,text,text),mem.external_release_revoke(uuid,text,text),mem.external_recipe(uuid,text,text),mem.external_bind(uuid,text,text),mem.external_check(uuid,text,text),mem.external_permit(uuid,text,text),mem.external_consume(uuid,text,text),mem.external_outcome(text)TO hub2_mem;
RESET ROLE;
