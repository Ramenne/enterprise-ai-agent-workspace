BEGIN;
CREATE OR REPLACE FUNCTION authz.engineering_manage(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;effective text;pid uuid;actor uuid;parent uuid;command text;payload jsonb;acts jsonb;
BEGIN
 IF b->>'operation' IN('freeze','unfreeze','restore') THEN RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';END IF;
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;pid:=(b->>'project_id')::uuid;effective:=authz.engineering_management_proof(proof,pid);
 IF b->>'operation'='delegate' THEN
  command:='management.delegate';
  acts:='["mem.upload","mem.read","mem.write","mem.delete","mem.share","mem.process","mem.correct","v8.project.read","v8.project.update","v8.project.convert","v8.work.open","v8.work.read","v8.work.commit","v8.work.related_candidates","v8.adoption.set","v8.adoption.read","v8.context.prepare","v8.context.materialize","v8.context.read","v8.handoff.record","v8.handoff.read","v8.experience.publish","v8.experience.feedback","v8.experience.read","resource.read","resource.write","resource.deploy"]'::jsonb;
  payload:=jsonb_build_object('project_id',pid,'principal_id',(b->>'principal_id')::uuid,'actions',acts,'expires_at',(b->>'expires_at')::timestamptz);
  IF (b->>'expires_at')::timestamptz<=clock_timestamp() OR (b->>'expires_at')::timestamptz>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE='22023';END IF;
 ELSIF b->>'operation' IN('freeze','unfreeze','revoke') THEN
  command:='qualification.'||(b->>'operation');payload:=jsonb_build_object('project_id',pid,'qualification_id',(b->>'qualification_id')::uuid);
  IF NOT EXISTS(SELECT FROM v8.projects p JOIN authz.principals a ON a.id=actor WHERE p.id=pid AND (p.manager_id=actor OR (a.role='organization_admin' AND a.organization_id=p.organization_id))) THEN
   SELECT id INTO parent FROM authz.qualifications q WHERE q.project_id=pid AND q.principal_id=actor AND q.kind='management' AND authz.management_valid(q.id,actor,pid) ORDER BY depth LIMIT 1;
   IF parent IS NULL THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501';END IF;
   payload:=payload||jsonb_build_object('parent_id',parent);
  END IF;
 ELSE RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023';END IF;
 RETURN authz.manage(effective,command,payload,b->>'idempotency_key',encode(public.digest(payload::text,'sha256'),'hex'));
END $function$
;
CREATE OR REPLACE FUNCTION authz.authorization_change(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;effective text;r jsonb;command text;key text;payload jsonb;
BEGIN
 IF b->>'operation' IN('freeze','unfreeze','restore') THEN RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);IF NOT authz.engineering_can_manage(proof,(b->>'project_id')::uuid) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'operation' NOT IN('revoke','freeze','unfreeze','delegate') THEN RAISE EXCEPTION 'operation_required' USING ERRCODE='22023';END IF;
 effective:=authz.engineering_management_proof(proof,(b->>'project_id')::uuid);command:=CASE WHEN b->>'operation'='delegate' THEN 'management.delegate' ELSE 'qualification.'||(b->>'operation') END;
 key:=b->>'idempotency_key';payload:=b-ARRAY['operation','idempotency_key'];
 -- Keep the original software's project fence before using this same-member verified management context.
 r:=authz.manage(effective,command,payload,key,encode(public.digest(payload::text,'sha256'),'hex'));
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','authorization.'||(b->>'operation'),(b->>'project_id')::uuid,r);
 RETURN r||jsonb_build_object('original_client_id',i->>'client_id');
END $function$
;
CREATE OR REPLACE FUNCTION authz.application_legacy_grant_change(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE d jsonb;actor uuid;g authz.application_legacy_grants;
BEGIN
 IF b->>'operation' IN('freeze','unfreeze','restore') THEN RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';END IF;
 d:=authz.authorization_application_decision(proof,jsonb_build_object('application_id','baize','action','read'));actor:=(d->>'actor_id')::uuid;
 SELECT * INTO g FROM authz.application_legacy_grants WHERE application_id='baize' AND source IN('hufu1.dual_grants','hufu2.baize-grant') AND source_id=b->>'source_id' FOR UPDATE;
 IF g.source_id IS NULL THEN RAISE EXCEPTION 'grant_not_available' USING ERRCODE='42501';END IF;
 IF actor IS DISTINCT FROM g.owner_id AND actor IS DISTINCT FROM g.grantee_id THEN PERFORM authz.baize_grant_manager_source(proof,g.project_id);END IF;
 IF g.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 IF b->>'operation' NOT IN('revoke','freeze') OR b->>'operation' IS NULL THEN RAISE EXCEPTION 'private_grant_operation_required' USING ERRCODE='22023';END IF;
 UPDATE authz.application_legacy_grants SET status=CASE WHEN b->>'operation'='revoke' THEN 'revoked' ELSE 'frozen' END,revoked_at=CASE WHEN b->>'operation'='revoke' THEN clock_timestamp() ELSE revoked_at END,revision=revision+1 WHERE application_id=g.application_id AND source=g.source AND source_id=g.source_id RETURNING * INTO g;
 IF g.source='hufu2.baize-grant' THEN UPDATE authz.baize_grant_requests SET state=g.status,revision=revision+1 WHERE id=(g.source_id)::uuid;END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(d->>'client_id')::uuid,'authz','baize.grant.'||(b->>'operation'),g.project_id,jsonb_build_object('source_id',g.source_id,'revision',g.revision));
 RETURN jsonb_build_object('state','completed','source_id',g.source_id,'status',g.status,'revision',g.revision,'effect','next_central_private_grant_check_denied');
END $function$
;
CREATE OR REPLACE FUNCTION authz.manage(p_hash text, p_command text, p_body jsonb, p_key text, p_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
#variable_conflict use_variable
DECLARE identity jsonb; actor uuid; client uuid; old authz.operations; result jsonb; pid uuid; pr record; parent authz.qualifications; q authz.qualifications; target uuid; actions text[]; expiry timestamptz; unlimited boolean; cid uuid; cred uuid; event_id uuid; event_revision bigint;q_credential authz.credentials;family_id uuid;filter_clause jsonb;inherited_filters jsonb;
BEGIN
 IF p_command IN('qualification.freeze','qualification.unfreeze','qualification.restore') THEN RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';END IF;
 IF p_hash IS NULL OR p_command IS NULL OR p_body IS NULL OR p_key IS NULL OR p_digest IS NULL OR authz.runtime_role()<>'hub2_hufu' OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id IN(SELECT owner_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) OR id IN(SELECT manager_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid FOR SHARE;
 identity:=authz.authenticate(p_hash);

 IF p_command='credential.create' THEN filter_clause:=authz.normalize_client_filter745(p_body);SELECT clauses INTO inherited_filters FROM authz.client_filters745 WHERE client_id=client; END IF;
 IF p_command IN('qualification.grant','qualification.revoke','qualification.freeze','qualification.unfreeze','management.delegate') AND NOT authz.client_resource_allowed745(client,(p_body->>'project_id')::uuid) THEN RAISE EXCEPTION 'software_resource_scope_denied' USING ERRCODE='42501';END IF;
 IF p_command IN('credential.rotate','credential.revoke') AND EXISTS(SELECT FROM authz.client_filters745 WHERE client_id=client AND clauses<>'[]') AND NOT EXISTS(SELECT FROM authz.credentials WHERE id=(p_body->>'credential_id')::uuid AND client_id=client) THEN RAISE EXCEPTION 'filtered_software_cannot_manage_foreign_client' USING ERRCODE='42501';END IF;
 IF (p_command<>'credential.create' AND p_body?|ARRAY['allowed_entries','qualification_ids']) OR (p_command NOT IN('credential.create','qualification.grant','management.delegate') AND p_body?'resource_selector') THEN RAISE EXCEPTION 'filter_only_at_credential_creation' USING ERRCODE='22023';END IF;
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
  IF coalesce(inherited_filters,'[]')<>'[]' OR filter_clause<>'{}' THEN INSERT INTO authz.client_filters745(client_id,clauses) VALUES(cid,coalesce(inherited_filters,'[]')||CASE WHEN filter_clause='{}' THEN '[]'::jsonb ELSE jsonb_build_array(filter_clause) END); END IF;
  result:=jsonb_build_object('client_id',cid,'credential_id',cred,'state','committed','until_revoked',unlimited,'expires_at',expiry,'effective_scope_filters',coalesce(inherited_filters,'[]')||CASE WHEN filter_clause='{}' THEN '[]'::jsonb ELSE jsonb_build_array(filter_clause)END);
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
  UPDATE authz.credentials c SET revoked_at=clock_timestamp(),epoch=c.epoch+1 FROM authz.clients cl WHERE c.id=(p_body->>'credential_id')::uuid AND cl.id=c.client_id AND cl.principal_id=actor RETURNING c.id INTO cred;
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
 IF p_command='management.delegate' THEN result:=result||jsonb_build_object('source_qualification_id',parent.id,'self_scope_withdrawal_id',CASE WHEN (p_body->>'principal_id')::uuid=actor THEN parent.id ELSE NULL END);END IF;
result:=result||jsonb_build_object('operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 IF p_command IN('credential.create','credential.rotate') THEN INSERT INTO authz.credential_receipts VALUES(actor,p_key,(identity->>'credential_id')::uuid,cred);END IF;
 event_id:=coalesce((result->>'qualification_id')::uuid,(result->>'credential_id')::uuid);
 SELECT epoch INTO event_revision FROM authz.qualifications WHERE id=event_id;
 IF event_revision IS NULL THEN SELECT epoch INTO event_revision FROM authz.credentials WHERE id=event_id; END IF;
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',event_id,event_revision,p_command,pid,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,client,'authz',p_command,coalesce(pid,cred),result);
 RETURN result;
END $function$
;

CREATE OR REPLACE FUNCTION authz.database_grant_change(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF b->>'operation' IN('freeze','unfreeze','restore') THEN RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';END IF;
 IF b->>'operation' IS DISTINCT FROM 'revoke' THEN RAISE EXCEPTION 'unsupported_database_grant_operation' USING ERRCODE='22023';END IF;
 RETURN authz.database_revoke(proof,jsonb_build_object('permission_id',b->>'permission_id'));
END $$;
CREATE OR REPLACE FUNCTION authz.database_role_suspension(p_permission uuid,want_frozen boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 RAISE EXCEPTION 'permission_freezing_removed;request_new_authorization_after_revoke' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION authz.database_role_suspension(uuid,boolean) FROM PUBLIC,hub2_hufu,hub2_authz_owner;
COMMIT;
