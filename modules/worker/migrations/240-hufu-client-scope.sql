-- Additive client-scope repair; no label/main inference, no new approval flow.
SET ROLE hub2_authz_owner;
ALTER TABLE authz.credentials ADD is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE authz.credentials ADD authority_source text NOT NULL DEFAULT 'unclassified';
ALTER TABLE authz.credentials ADD parent_credential_id uuid REFERENCES authz.credentials;
ALTER TABLE authz.credentials ADD CHECK(parent_credential_id IS DISTINCT FROM id);
ALTER TABLE authz.credentials ADD CHECK(NOT is_primary OR (parent_credential_id IS NULL AND authority_source<>'unclassified'));
CREATE INDEX credential_parent ON authz.credentials(parent_credential_id) WHERE parent_credential_id IS NOT NULL;
CREATE TABLE authz.credential_receipts(principal_id uuid NOT NULL,idempotency_key text NOT NULL,issuer_credential_id uuid NOT NULL REFERENCES authz.credentials,target_credential_id uuid NOT NULL REFERENCES authz.credentials,PRIMARY KEY(principal_id,idempotency_key),FOREIGN KEY(principal_id,idempotency_key) REFERENCES authz.operations(principal_id,idempotency_key));
REVOKE ALL ON authz.credential_receipts FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;

-- Only schema owners/provisioning can write these fields; runtime table rights
-- remain unchanged. Labels/WeChat-origin copies never grant primary authority.

CREATE FUNCTION authz.require_client_capability(identity jsonb,capability text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.clients;
BEGIN
 SELECT * INTO c FROM authz.clients WHERE id=(identity->>'client_id')::uuid FOR SHARE;
 IF capability IS NULL OR c.id IS NULL OR c.active IS DISTINCT FROM true OR c.principal_id IS DISTINCT FROM (identity->>'actor_id')::uuid OR NOT capability=ANY(c.actions) THEN
  RAISE EXCEPTION 'client_scope_required' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION authz.require_client_capability(jsonb,text) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;


CREATE OR REPLACE FUNCTION authz.manage(p_hash text,p_command text,p_body jsonb,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
#variable_conflict use_variable
DECLARE identity jsonb; actor uuid; client uuid; old authz.operations; result jsonb; pid uuid; pr record; parent authz.qualifications; q authz.qualifications; target uuid; actions text[]; expiry timestamptz; unlimited boolean; cid uuid; cred uuid; event_id uuid; event_revision bigint;q_credential authz.credentials;family_id uuid;
BEGIN
 IF p_hash IS NULL OR p_command IS NULL OR p_body IS NULL OR p_key IS NULL OR p_digest IS NULL OR session_user<>'hub2_hufu' OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id IN(SELECT owner_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) OR id IN(SELECT manager_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid FOR SHARE;
 identity:=authz.authenticate(p_hash);

 -- Check current client capability before principal-wide idempotent replay.
 IF p_command IN ('qualification.grant','qualification.revoke','qualification.freeze','qualification.unfreeze') THEN
  PERFORM authz.require_client_capability(identity,'hufu.qualification.manage');
 ELSIF p_command='management.delegate' THEN
  PERFORM authz.require_client_capability(identity,'hufu.management.delegate');
 ELSIF p_command IN('credential.revoke','credential.rotate') AND (p_body->>'credential_id')::uuid IS DISTINCT FROM (identity->>'credential_id')::uuid THEN
  PERFORM authz.require_client_capability(identity,'hufu.credential.manage');
 ELSIF p_command='credential.create' THEN
  -- A scoped key may issue another equally/narrowly scoped key, never recover
  -- a broader primary-client operation through principal-wide replay.
  SELECT array_agg(value) INTO actions FROM jsonb_array_elements_text(p_body->'actions');
  IF actions IS NULL OR cardinality(actions)=0 OR array_position(actions,NULL) IS NOT NULL OR NOT EXISTS(SELECT FROM authz.clients scope_client WHERE scope_client.id=client AND actions<@scope_client.actions) THEN
   RAISE EXCEPTION 'action_expansion' USING ERRCODE='42501';
  END IF;

  expiry:=(p_body->>'expires_at')::timestamptz;unlimited:=coalesce((p_body->>'until_revoked')::boolean,false);
  IF (expiry IS NULL)<>unlimited OR NOT EXISTS(SELECT FROM authz.credentials origin WHERE origin.id=(identity->>'credential_id')::uuid AND (origin.is_primary OR origin.until_revoked OR (NOT unlimited AND expiry<=origin.expires_at))) THEN
   RAISE EXCEPTION 'credential_lifetime_expansion' USING ERRCODE='42501';
  END IF;
 END IF;
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  IF p_command IN('credential.create','credential.rotate') AND NOT EXISTS(SELECT FROM authz.credential_receipts receipt WHERE receipt.principal_id=actor AND receipt.idempotency_key=p_key) THEN
   IF EXISTS(SELECT FROM authz.credentials current JOIN authz.clients channel ON channel.id=current.client_id WHERE current.id=(identity->>'credential_id')::uuid AND current.is_primary AND 'hufu.credential.manage'=ANY(channel.actions)) THEN
    RETURN old.result||jsonb_build_object('credential_delivery','unavailable','next_step','rotate_existing_logical_key_with_current_primary','retained_state','historical_receipt_without_trusted_original_delivery');
   END IF;
   RAISE EXCEPTION 'foreign_credential_receipt' USING ERRCODE='42501';
  END IF;
  IF p_command IN('credential.create','credential.rotate') AND NOT EXISTS(SELECT FROM authz.credential_receipts receipt WHERE receipt.principal_id=actor AND receipt.idempotency_key=p_key AND (receipt.issuer_credential_id=(identity->>'credential_id')::uuid OR EXISTS(SELECT FROM authz.credentials current WHERE current.id=(identity->>'credential_id')::uuid AND current.is_primary))) THEN
   RAISE EXCEPTION 'foreign_credential_receipt' USING ERRCODE='42501';
  END IF;
  IF p_command IN('credential.create','credential.rotate') THEN
   SELECT target.* INTO q_credential FROM authz.credential_receipts receipt JOIN authz.credentials target ON target.id=receipt.target_credential_id WHERE receipt.principal_id=actor AND receipt.idempotency_key=p_key;
   IF q_credential.token_hash IS DISTINCT FROM p_body->>'token_hash' OR authz.family_valid(q_credential.id) IS DISTINCT FROM true THEN
    RETURN old.result||jsonb_build_object('credential_delivery','unavailable','next_step','use_latest_rotation_receipt_or_rotate_authorized_key','retained_state','historical_receipt_and_logical_key_preserved');
   END IF;
   RETURN old.result||jsonb_build_object('credential_delivery','available');
  END IF;
  RETURN old.result;
 END IF;
 IF p_command='credential.create' THEN
  SELECT array_agg(value) INTO actions FROM jsonb_array_elements_text(p_body->'actions');
  IF actions IS NULL OR cardinality(actions)=0 OR array_position(actions,NULL) IS NOT NULL THEN RAISE EXCEPTION 'action_expansion' USING ERRCODE='42501'; END IF;
  -- Explicit alias avoids column/variable ambiguity.
  IF NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=client AND actions<@c.actions) THEN RAISE EXCEPTION 'action_expansion' USING ERRCODE='42501'; END IF;
  expiry:=(p_body->>'expires_at')::timestamptz; unlimited:=coalesce((p_body->>'until_revoked')::boolean,false);
  IF (expiry IS NULL)<>unlimited OR (expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp())) THEN RAISE EXCEPTION 'invalid_expiry'; END IF;
  IF NOT EXISTS(SELECT FROM authz.credentials origin WHERE origin.id=(identity->>'credential_id')::uuid AND (origin.is_primary OR origin.until_revoked OR (NOT unlimited AND expiry<=origin.expires_at))) THEN
   RAISE EXCEPTION 'credential_lifetime_expansion' USING ERRCODE='42501';
  END IF;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,p_body->>'label',actions) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,expires_at,until_revoked,wechat_app_id,wechat_open_id,parent_credential_id,authority_source)
  SELECT cid,p_body->>'token_hash',expiry,unlimited,origin.wechat_app_id,origin.wechat_open_id,
   CASE WHEN origin.is_primary THEN NULL ELSE COALESCE((SELECT family.origin_credential_id FROM authz.refresh_families family WHERE family.id=origin.family_id),origin.id) END,
   CASE WHEN origin.is_primary THEN 'member_issued_api' ELSE 'delegated_api' END
  FROM authz.credentials origin WHERE origin.id=(identity->>'credential_id')::uuid RETURNING id INTO cred;
  result:=jsonb_build_object('client_id',cid,'credential_id',cred,'state','committed');
 ELSIF p_command='credential.rotate' THEN
  SELECT credential.* INTO q_credential FROM authz.credentials credential JOIN authz.clients owner_client ON owner_client.id=credential.client_id
   WHERE credential.id=(p_body->>'credential_id')::uuid AND owner_client.principal_id=actor FOR UPDATE OF credential;
  IF q_credential.id IS NULL OR q_credential.family_id IS NOT NULL OR q_credential.revoked_at IS NOT NULL OR EXISTS(SELECT FROM authn."session" raw_session WHERE encode(public.digest(raw_session.token,'sha256'),'hex')=q_credential.token_hash) THEN
   RAISE EXCEPTION 'invalid_key_rotation_target' USING ERRCODE='42501';
  END IF;
  IF p_body->>'token_hash' IS NULL OR p_body->>'token_hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_rotated_key' USING ERRCODE='42501';END IF;
  FOR family_id IN SELECT id FROM authz.refresh_families WHERE origin_credential_id=q_credential.id AND active LOOP PERFORM authz.revoke_family(family_id,'origin_secret_rotated');END LOOP;
  UPDATE authz.credentials SET token_hash=p_body->>'token_hash',epoch=epoch+1 WHERE id=q_credential.id RETURNING id INTO cred;
  -- Logical credential ID is stable: existing delegated children remain bound
  -- to the same current authority, while old master secret/access family fails.
  result:=jsonb_build_object('credential_id',cred,'state','committed','child_links_preserved',true,'previous_secret_rejected',true);
 ELSIF p_command='credential.revoke' THEN
  UPDATE authz.credentials c SET revoked_at=clock_timestamp(),epoch=epoch+1 FROM authz.clients cl WHERE c.id=(p_body->>'credential_id')::uuid AND cl.id=c.client_id AND cl.principal_id=actor RETURNING c.id INTO cred;
  IF cred IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  result:=jsonb_build_object('credential_id',cred,'state','committed');
 ELSIF p_command IN ('qualification.grant','management.delegate','qualification.revoke','qualification.freeze','qualification.unfreeze') THEN
  pid:=(p_body->>'project_id')::uuid; SELECT * INTO pr FROM v8.projects WHERE id=pid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  PERFORM id FROM authz.qualifications WHERE project_id=pid ORDER BY id FOR UPDATE;
  IF p_body->>'parent_id' IS NOT NULL THEN
   SELECT * INTO parent FROM authz.qualifications WHERE id=(p_body->>'parent_id')::uuid;
   IF NOT authz.management_valid(parent.id,actor,pid) OR parent.id IS NULL OR parent.principal_id<>actor OR parent.project_id<>pid OR parent.kind<>'management' OR parent.depth>1 OR NOT parent.active OR parent.frozen OR (NOT parent.until_revoked AND parent.expires_at<=clock_timestamp()) OR (NOT(parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) AND NOT EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()))) THEN RAISE EXCEPTION 'invalid_management_source' USING ERRCODE='42501'; END IF;
  ELSIF NOT(actor=pr.manager_id OR (pr.visibility='personal' AND actor=pr.owner_id)) AND NOT EXISTS(SELECT FROM authz.principals a JOIN authz.principals o ON o.id=pr.owner_id WHERE a.id=actor AND a.role='organization_admin' AND a.organization_id=o.organization_id) THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501'; END IF;
  IF p_command IN('qualification.revoke','qualification.freeze','qualification.unfreeze') THEN
   SELECT * INTO q FROM authz.qualifications WHERE id=(p_body->>'qualification_id')::uuid AND project_id=pid;
   IF q.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
   IF parent.id IS NOT NULL AND q.parent_id IS DISTINCT FROM parent.id THEN RAISE EXCEPTION 'source_mismatch' USING ERRCODE='42501'; END IF;
   IF p_body ? 'expected_epoch' AND q.epoch IS DISTINCT FROM (p_body->>'expected_epoch')::bigint THEN RAISE EXCEPTION 'qualification_revision_conflict' USING ERRCODE='40001';END IF;
   UPDATE authz.qualifications SET active=CASE WHEN p_command='qualification.revoke' THEN false ELSE active END,frozen=CASE WHEN p_command='qualification.freeze' THEN true WHEN p_command='qualification.unfreeze' THEN false ELSE frozen END,epoch=epoch+1 WHERE id=q.id;

   result:=jsonb_build_object('qualification_id',q.id,'state','committed');
  ELSE
   target:=(p_body->>'principal_id')::uuid;
   IF NOT EXISTS(SELECT FROM authz.principals a JOIN authz.principals t ON t.id=target WHERE a.id=actor AND t.active AND a.organization_id=t.organization_id) THEN RAISE EXCEPTION 'organization_mismatch' USING ERRCODE='42501'; END IF;
   SELECT array_agg(value) INTO actions FROM jsonb_array_elements_text(p_body->'actions');
   expiry:=(p_body->>'expires_at')::timestamptz; unlimited:=coalesce((p_body->>'until_revoked')::boolean,false);
   IF actions IS NULL OR cardinality(actions)=0 OR array_position(actions,NULL) IS NOT NULL OR (expiry IS NULL)<>unlimited OR (expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp())) THEN RAISE EXCEPTION 'invalid_scope'; END IF;
   IF p_command='qualification.grant' AND actions && ARRAY['v8.project.convert','v8.project.update'] THEN RAISE EXCEPTION 'management_action_in_work_grant' USING ERRCODE='42501';END IF;
   IF NOT authz.valid_selector(COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}')) THEN RAISE EXCEPTION 'invalid_selector' USING ERRCODE='42501';END IF;
   IF parent.id IS NOT NULL AND NOT authz.selector_subset(COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),parent.resource_selector) THEN RAISE EXCEPTION 'resource_expansion' USING ERRCODE='42501';END IF;
   IF parent.id IS NOT NULL AND (NOT actions<@parent.actions OR (NOT parent.until_revoked AND (unlimited OR expiry>parent.expires_at))) THEN RAISE EXCEPTION 'scope_expansion' USING ERRCODE='42501'; END IF;
   IF p_command='management.delegate' AND parent.id IS NOT NULL THEN RAISE EXCEPTION 'delegation_depth' USING ERRCODE='42501'; END IF;
   IF p_command='management.delegate' THEN
    INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,expires_at,until_revoked,source_project_revision) VALUES(actor,pid,actions,actor,'management',0,expiry,unlimited,pr.revision) RETURNING * INTO parent;
    UPDATE authz.qualifications SET resource_selector=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),source_basis='management_appointment' WHERE id=parent.id;
    parent.resource_selector:=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}');
   END IF;
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,expires_at,until_revoked,source_project_revision)
   VALUES(target,pid,actions,actor,parent.id,CASE WHEN p_command='management.delegate' THEN 'management' ELSE 'work' END,CASE WHEN parent.id IS NULL THEN 0 ELSE 1 END,expiry,unlimited,pr.revision) RETURNING id INTO target;
   UPDATE authz.qualifications SET resource_selector=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),source_basis=CASE WHEN p_command='qualification.grant' AND parent.id IS NULL THEN 'independent_work' ELSE 'management_appointment' END WHERE id=target;
   result:=jsonb_build_object('qualification_id',target,'state','committed');
  END IF;
 ELSE RAISE EXCEPTION 'unknown_command' USING ERRCODE='42501'; END IF;
 IF p_command IN('credential.create','credential.rotate') THEN result:=result||jsonb_build_object('credential_delivery','available');END IF;
 result:=result||jsonb_build_object('operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 IF p_command IN('credential.create','credential.rotate') THEN INSERT INTO authz.credential_receipts VALUES(actor,p_key,(identity->>'credential_id')::uuid,cred);END IF;
 event_id:=coalesce((result->>'qualification_id')::uuid,(result->>'credential_id')::uuid);
 SELECT epoch INTO event_revision FROM authz.qualifications WHERE id=event_id;
 IF event_revision IS NULL THEN SELECT epoch INTO event_revision FROM authz.credentials WHERE id=event_id; END IF;
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',event_id,event_revision,p_command,pid,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,client,'authz',p_command,coalesce(pid,cred),result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION authz.stop(p_hash text,p_command text,p_target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;subject authz.principals;caller authz.principals;cid uuid;fid uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_command IS NULL OR p_target IS NULL OR p_command NOT IN('principal.disable','session.logout_all','client.disable','session.logout') THEN RAISE EXCEPTION 'invalid_stop' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor OR id=p_target OR id IN(SELECT principal_id FROM authz.clients WHERE id=p_target) ORDER BY id FOR UPDATE;PERFORM id FROM authz.clients WHERE principal_id IN(actor,p_target) OR id=p_target ORDER BY id FOR UPDATE;PERFORM id FROM authz.credentials WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id IN(actor,p_target) OR id=p_target) ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO caller FROM authz.principals WHERE id=actor;
 IF p_command='principal.disable' THEN
  PERFORM authz.require_client_capability(identity,'hufu.principal.manage');
 ELSIF p_command='session.logout_all' THEN
  PERFORM authz.require_client_capability(identity,'hufu.session.manage');
 ELSIF p_command='client.disable' AND p_target IS DISTINCT FROM (identity->>'client_id')::uuid THEN
  PERFORM authz.require_client_capability(identity,'hufu.credential.manage');
 END IF;
 -- session.logout still only terminates this credential; self-client disable
 -- and own-current-credential revoke retain low-friction self-stop capability.

 IF p_command='client.disable' THEN
  SELECT principal_id INTO cid FROM authz.clients WHERE id=p_target;
  IF cid IS DISTINCT FROM actor THEN RAISE EXCEPTION 'foreign_client' USING ERRCODE='42501';END IF;
  UPDATE authz.clients SET active=false,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id=p_target;
 ELSIF p_command='session.logout' THEN
  IF p_target IS DISTINCT FROM (identity->>'credential_id')::uuid THEN RAISE EXCEPTION 'foreign_session' USING ERRCODE='42501';END IF;
  SELECT family_id INTO fid FROM authz.credentials WHERE id=p_target;
  IF fid IS NOT NULL THEN PERFORM authz.revoke_family(fid,'session_logout');ELSE UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=p_target;END IF;
 ELSE
  SELECT * INTO subject FROM authz.principals WHERE id=p_target;
  IF subject.id IS NULL OR (actor<>subject.id AND (caller.role<>'organization_admin' OR caller.organization_id<>subject.organization_id)) THEN RAISE EXCEPTION 'foreign_principal' USING ERRCODE='42501';END IF;
  UPDATE authz.principals SET active=CASE WHEN p_command='principal.disable' THEN false ELSE active END,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=p_target);
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=p_target;
  DELETE FROM authn."session" WHERE "userId" IN(SELECT authn_user_id FROM authz.member_accounts WHERE principal_id=p_target);
 END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(identity->>'client_id')::uuid,'authz',p_command,p_target,'{}');
 RETURN jsonb_build_object('state','committed','target_id',p_target,'operation_id',gen_random_uuid());
END $$;

CREATE OR REPLACE FUNCTION authz.set_work_preset(p_hash text,project uuid,acts text[],selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;pr record;person authz.principals;parent authz.qualifications;
BEGIN
 IF session_user<>'hub2_hufu' OR project IS NULL OR acts IS NULL OR cardinality(acts)=0 OR array_position(acts,NULL) IS NOT NULL OR NOT authz.valid_selector(selector) THEN RAISE EXCEPTION 'invalid_work_preset' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;
 PERFORM authz.require_client_capability(identity,'hufu.qualification.manage');
 SELECT * INTO pr FROM v8.projects WHERE id=project FOR UPDATE;SELECT * INTO person FROM authz.principals WHERE id=actor FOR SHARE;
 IF pr.id IS NULL OR NOT(actor=pr.manager_id OR (pr.visibility='personal' AND actor=pr.owner_id) OR (person.role='organization_admin' AND person.organization_id=pr.organization_id)) THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501';END IF;
 SELECT * INTO parent FROM authz.qualifications WHERE project_id=project AND principal_id=pr.manager_id AND kind='management' AND depth=0 AND active AND NOT frozen ORDER BY id LIMIT 1;
 IF parent.id IS NOT NULL AND (NOT acts<@parent.actions OR NOT authz.selector_subset(selector,parent.resource_selector)) THEN RAISE EXCEPTION 'preset_expansion' USING ERRCODE='42501';END IF;
 IF acts && ARRAY['v8.project.create','v8.project.convert','v8.project.update'] THEN RAISE EXCEPTION 'management_action_in_work_preset' USING ERRCODE='42501';END IF;
 INSERT INTO authz.work_presets VALUES(project,acts,selector,actor,1) ON CONFLICT(project_id) DO UPDATE SET actions=EXCLUDED.actions,resource_selector=EXCLUDED.resource_selector,source_actor_id=actor,revision=authz.work_presets.revision+1 WHERE (authz.work_presets.actions,authz.work_presets.resource_selector,authz.work_presets.source_actor_id) IS DISTINCT FROM (EXCLUDED.actions,EXCLUDED.resource_selector,EXCLUDED.source_actor_id);
 RETURN jsonb_build_object('state','configured','project_id',project,'actions',acts,'resource_selector',selector);
END $$;

CREATE OR REPLACE FUNCTION authz.authn_session_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid; cid uuid; h text;
BEGIN
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF actor IS NULL THEN RAISE EXCEPTION 'untrusted_member_account' USING ERRCODE='42501'; END IF;
 PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 IF TG_OP='DELETE' THEN
  h:=encode(public.digest(OLD.token,'sha256'),'hex');
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  RETURN OLD;
 END IF;
 h:=encode(public.digest(NEW.token,'sha256'),'hex');
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active) THEN RAISE EXCEPTION 'disabled_member' USING ERRCODE='42501'; END IF;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,'member-browser',ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']||ARRAY['hufu.qualification.manage','hufu.management.delegate','hufu.credential.manage','hufu.principal.manage','hufu.session.manage']) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,expires_at,is_primary,authority_source) VALUES(cid,h,NEW."expiresAt",true,'authn_session');
  INSERT INTO authz.sessions(principal_id,token_hash,expires_at,refresh_expires_at) VALUES(actor,h,NEW."expiresAt",NEW."expiresAt");
 ELSE
  IF NEW.token IS DISTINCT FROM OLD.token OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'session_identity_immutable'; END IF;
  UPDATE authz.credentials SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authz.wechat_finish(p_claim uuid,p_app_id text,p_open_id text,p_access_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.wechat_states;p authz.principals;cid uuid;credential uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_claim IS NULL OR COALESCE(p_app_id,'')='' OR COALESCE(p_open_id,'')='' OR p_access_hash IS NULL OR p_access_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_wechat_identity' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id IN(SELECT principal_id FROM authz.wechat_members WHERE app_id=p_app_id AND open_id=p_open_id) FOR UPDATE;
 SELECT * INTO s FROM authz.wechat_states WHERE claim_id=p_claim AND app_id=p_app_id FOR UPDATE;
 IF s.id IS NULL OR s.completed_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.claimed_at IS NULL THEN RAISE EXCEPTION 'wechat_claim_expired_or_replayed' USING ERRCODE='42501';END IF;
 SELECT actor.* INTO p FROM authz.wechat_members mapping JOIN authz.principals actor ON actor.id=mapping.principal_id WHERE mapping.app_id=p_app_id AND mapping.open_id=p_open_id AND mapping.active;
 IF p.id IS NULL OR p.active IS DISTINCT FROM true OR p.kind<>'member' THEN RAISE EXCEPTION 'wechat_membership_unverified' USING ERRCODE='42501';END IF;
 INSERT INTO authz.clients(principal_id,label,actions) VALUES(p.id,s.client_label,ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']||ARRAY['hufu.qualification.manage','hufu.management.delegate','hufu.credential.manage','hufu.principal.manage','hufu.session.manage']) RETURNING id INTO cid;
 INSERT INTO authz.credentials(client_id,token_hash,until_revoked,wechat_app_id,wechat_open_id,is_primary,authority_source) VALUES(cid,p_access_hash,true,p_app_id,p_open_id,true,'wechat_verified');
 UPDATE authz.wechat_states SET completed_at=clock_timestamp() WHERE id=s.id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(p.id,cid,'authz','wechat.login',credential,jsonb_build_object('trusted_mapping',true,'state_id',s.id));
 RETURN jsonb_build_object('state','authenticated','actor_id',p.id,'client_id',cid,'credential_id',credential,'until_revoked',true);
END $$;

UPDATE authz.credentials credential SET is_primary=true,authority_source='authn_session'
WHERE EXISTS(SELECT 1 FROM authn."session" session JOIN authz.member_accounts account ON account.authn_user_id=session."userId" JOIN authz.clients client ON client.id=credential.client_id
WHERE credential.token_hash=encode(public.digest(session.token,'sha256'),'hex') AND account.principal_id=client.principal_id AND session."expiresAt">clock_timestamp());
-- Backfill only currently live raw authn sessions with a trusted member map.
-- Child keys may copy WeChat origin fields: those fields alone do NOT qualify.
UPDATE authz.clients client SET actions=(SELECT array_agg(DISTINCT a ORDER BY a) FROM unnest(client.actions||ARRAY['hufu.qualification.manage','hufu.management.delegate','hufu.credential.manage','hufu.principal.manage','hufu.session.manage']) a)
WHERE EXISTS(SELECT 1 FROM authz.credentials credential JOIN authn."session" session ON credential.token_hash=encode(public.digest(session.token,'sha256'),'hex') JOIN authz.member_accounts account ON account.authn_user_id=session."userId"
WHERE credential.client_id=client.id AND account.principal_id=client.principal_id AND credential.revoked_at IS NULL AND session."expiresAt">clock_timestamp());
REVOKE ALL ON FUNCTION authz.manage(text,text,jsonb,text,text),authz.stop(text,text,uuid),authz.set_work_preset(text,uuid,text[],jsonb),authz.authn_session_fence(),authz.wechat_finish(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.manage(text,text,jsonb,text,text),authz.stop(text,text,uuid),authz.set_work_preset(text,uuid,text[],jsonb),authz.wechat_finish(uuid,text,text,text) TO hub2_hufu;


CREATE FUNCTION authz.credential_lineage_valid(cid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE child authz.credentials;parent authz.credentials;child_client authz.clients;parent_client authz.clients;seen uuid[]:=ARRAY[]::uuid[];
BEGIN
 SELECT * INTO child FROM authz.credentials WHERE id=cid;
 LOOP
  IF child.id IS NULL OR child.id=ANY(seen) OR child.revoked_at IS NOT NULL OR (NOT child.until_revoked AND child.expires_at<=clock_timestamp()) THEN RETURN false; END IF;
  seen:=array_append(seen,child.id);SELECT * INTO child_client FROM authz.clients WHERE id=child.client_id;
  IF child_client.id IS NULL OR NOT child_client.active THEN RETURN false; END IF;
  IF child.parent_credential_id IS NULL THEN RETURN true; END IF;
  SELECT * INTO parent FROM authz.credentials WHERE id=child.parent_credential_id;SELECT * INTO parent_client FROM authz.clients WHERE id=parent.client_id;
  IF parent.id IS NULL OR parent_client.principal_id IS DISTINCT FROM child_client.principal_id OR NOT child_client.actions<@parent_client.actions THEN RETURN false; END IF;
  child:=parent;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION authz.credential_lineage_valid(uuid) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.revoke_credential_descendants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
  WITH RECURSIVE descendants AS(SELECT c.id FROM authz.credentials c WHERE c.parent_credential_id=NEW.id UNION SELECT c.id FROM authz.credentials c JOIN descendants d ON c.parent_credential_id=d.id)
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id IN(SELECT id FROM descendants) AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.revoke_credential_descendants() FROM PUBLIC;
CREATE TRIGGER credential_descendant_revoke AFTER UPDATE ON authz.credentials FOR EACH ROW EXECUTE FUNCTION authz.revoke_credential_descendants();

CREATE OR REPLACE FUNCTION authz.family_valid(cid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE c authz.credentials;f authz.refresh_families;origin authz.credentials;
BEGIN
 SELECT * INTO c FROM authz.credentials WHERE id=cid;
 IF authz.credential_lineage_valid(cid) IS DISTINCT FROM true OR c.id IS NULL OR c.revoked_at IS NOT NULL OR NOT c.until_revoked AND c.expires_at<=clock_timestamp() THEN RETURN false;END IF;
 IF c.wechat_app_id IS NOT NULL AND NOT EXISTS(SELECT FROM authz.wechat_members m WHERE m.app_id=c.wechat_app_id AND m.open_id=c.wechat_open_id AND m.active) THEN RETURN false;END IF;
 IF c.family_id IS NULL THEN RETURN true;END IF;
 SELECT * INTO f FROM authz.refresh_families WHERE id=c.family_id;
 SELECT * INTO origin FROM authz.credentials WHERE id=f.origin_credential_id;
 RETURN f.id IS NOT NULL AND f.active AND f.expires_at>clock_timestamp() AND origin.id IS NOT NULL AND origin.revoked_at IS NULL AND (origin.until_revoked OR origin.expires_at>clock_timestamp());
END $$;
CREATE OR REPLACE FUNCTION authz.session_start(p_hash text,p_access_hash text,p_refresh_hash text,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;cid uuid;origin authz.credentials;f authz.refresh_families;access authz.credentials;expiry timestamptz;old authz.operations;result jsonb;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_access_hash IS NULL OR p_refresh_hash IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_session_start' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;cid:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;PERFORM id FROM authz.clients WHERE id=cid FOR UPDATE;PERFORM id FROM authz.credentials WHERE client_id=cid ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO origin FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF old.request_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 IF origin.family_id IS NOT NULL THEN RAISE EXCEPTION 'nested_refresh_family' USING ERRCODE='42501';END IF;
 expiry:=least(clock_timestamp()+interval '7 days',CASE WHEN origin.until_revoked THEN 'infinity'::timestamptz ELSE origin.expires_at END);
 INSERT INTO authz.refresh_families(principal_id,client_id,origin_credential_id,expires_at) VALUES(actor,cid,origin.id,expiry) RETURNING * INTO f;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id,is_primary,authority_source,parent_credential_id) VALUES(cid,p_access_hash,least(expiry,clock_timestamp()+interval '15 minutes'),f.id,origin.is_primary,CASE WHEN origin.is_primary THEN 'member_session' ELSE 'api_session' END,CASE WHEN origin.is_primary THEN NULL ELSE origin.id END) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,1,p_refresh_hash,access.id,expiry,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(actor,p_access_hash,p_refresh_hash,access.expires_at,expiry);
 result:=jsonb_build_object('state','committed','family_id',f.id,'generation',1,'expires_at',access.expires_at,'refresh_expires_at',expiry,'operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);RETURN result;
END $$;
CREATE OR REPLACE FUNCTION authz.session_refresh(p_refresh_hash text,p_access_hash text,p_next_refresh_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE g authz.refresh_generations;f authz.refresh_families;p authz.principals;c authz.clients;origin authz.credentials;access authz.credentials;expiry timestamptz;
BEGIN
 IF session_user<>'hub2_hufu' OR p_refresh_hash IS NULL OR p_access_hash IS NULL OR p_next_refresh_hash IS NULL OR p_refresh_hash !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_next_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_refresh' USING ERRCODE='42501';END IF;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash;
 IF g.family_id IS NULL THEN RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id IN(SELECT principal_id FROM authz.refresh_families WHERE id=g.family_id) FOR UPDATE;PERFORM id FROM authz.clients WHERE id IN(SELECT client_id FROM authz.refresh_families WHERE id=g.family_id) FOR UPDATE;PERFORM id FROM authz.credentials WHERE family_id=g.family_id OR id IN(SELECT origin_credential_id FROM authz.refresh_families WHERE id=g.family_id) ORDER BY id FOR UPDATE;
 SELECT * INTO f FROM authz.refresh_families WHERE id=g.family_id FOR UPDATE;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash FOR UPDATE;
 IF g.used_at IS NOT NULL THEN PERFORM authz.revoke_family(f.id,'refresh_reuse');RETURN jsonb_build_object('state','rejected','error_code','refresh_reuse','family_revoked',true);END IF;
 SELECT * INTO p FROM authz.principals WHERE id=f.principal_id;SELECT * INTO c FROM authz.clients WHERE id=f.client_id;SELECT * INTO origin FROM authz.credentials WHERE id=f.origin_credential_id;
 IF f.active IS DISTINCT FROM true OR p.active IS DISTINCT FROM true OR c.active IS DISTINCT FROM true OR f.expires_at<=clock_timestamp() OR g.expires_at<=clock_timestamp() OR NOT authz.family_valid(origin.id) THEN PERFORM authz.revoke_family(f.id,'expired_or_disabled');RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 UPDATE authz.refresh_generations SET used_at=clock_timestamp() WHERE family_id=g.family_id AND generation=g.generation;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=g.credential_id;
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=(SELECT token_hash FROM authz.credentials WHERE id=g.credential_id);
 expiry:=least(f.expires_at,clock_timestamp()+interval '15 minutes');
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id,is_primary,authority_source,parent_credential_id) VALUES(c.id,p_access_hash,expiry,f.id,origin.is_primary,CASE WHEN origin.is_primary THEN 'member_session' ELSE 'api_session' END,CASE WHEN origin.is_primary THEN NULL ELSE origin.id END) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,g.generation+1,p_next_refresh_hash,access.id,f.expires_at,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(p.id,p_access_hash,p_next_refresh_hash,expiry,f.expires_at);
 RETURN jsonb_build_object('state','committed','family_id',f.id,'generation',g.generation+1,'expires_at',expiry,'refresh_expires_at',f.expires_at);
END $$;
CREATE OR REPLACE FUNCTION authz.authenticate(p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.credentials; cl authz.clients; p authz.principals;
BEGIN
 SELECT * INTO c FROM authz.credentials WHERE token_hash=p_hash;
 SELECT * INTO cl FROM authz.clients WHERE id=c.client_id;
 SELECT * INTO p FROM authz.principals WHERE id=cl.principal_id;
 IF p_hash IS NULL OR p.id IS NULL OR cl.id IS NULL OR c.id IS NULL OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',cl.id,'credential_id',c.id,'organization_id',p.organization_id,'member_label',p.display_name,'client_label',cl.label,'client_actions',cl.actions,'expires_at',c.expires_at,'until_revoked',c.until_revoked,'is_primary',c.is_primary,
 'credential_type',CASE WHEN c.is_primary THEN 'primary_member' WHEN c.parent_credential_id IS NOT NULL THEN 'delegated_api' WHEN c.authority_source='member_issued_api' THEN 'member_api' ELSE 'unclassified' END,
 'authority_source',c.authority_source,'parent_credential_id',c.parent_credential_id,
 'authorization_note','client_actions_are_capability_ceiling_current_qualification_still_applies');
END $$;
RESET ROLE;
