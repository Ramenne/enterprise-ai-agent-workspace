CREATE OR REPLACE FUNCTION authz.runtime_source_register(p_hash text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE me jsonb;r authz.runtime_sources;c authz.clients;p authz.principals;target_client uuid;target_cred uuid;kind text;wc jsonb;wid uuid;pid uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 me:=authz.authenticate(p_hash);kind:=COALESCE(b->>'registration_kind','registered_client');
 IF kind NOT IN('registered_client','controller_registered_managed') OR length(b->>'public_key_pem') NOT BETWEEN 80 AND 512 OR b->>'public_key_pem' NOT LIKE '-----BEGIN PUBLIC KEY-----%' THEN RAISE EXCEPTION 'invalid_runtime_registration';END IF;
 target_client:=(me->>'client_id')::uuid;target_cred:=(me->>'credential_id')::uuid;
 IF kind='controller_registered_managed' THEN
  SELECT * INTO p FROM authz.principals WHERE id=(me->>'actor_id')::uuid;
  IF p.kind<>'member' OR p.role<>'organization_admin' THEN RAISE EXCEPTION 'controller_management_required' USING ERRCODE='42501';END IF;
  PERFORM authz.require_client_capability(me,'hufu.principal.manage');
  target_client:=(b->>'target_client_id')::uuid;target_cred:=(b->>'target_credential_id')::uuid;
  IF NOT EXISTS(SELECT FROM authz.clients cl JOIN authz.principals pr ON pr.id=cl.principal_id JOIN authz.credentials cr ON cr.client_id=cl.id WHERE cl.id=target_client AND cr.id=target_cred AND cl.active AND pr.active AND pr.organization_id=p.organization_id AND cr.revoked_at IS NULL AND authz.family_valid(cr.id) AND (cr.until_revoked OR cr.expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'invalid_managed_client' USING ERRCODE='42501';END IF;
 END IF;
 SELECT * INTO c FROM authz.clients WHERE id=target_client;wc:=COALESCE(b->'work_context','{}');
 IF wc<>'{}'::jsonb THEN
  pid:=(wc->>'project_id')::uuid;wid:=(wc->>'work_item_id')::uuid;
  IF pid IS NULL OR wid IS NULL OR NOT EXISTS(SELECT FROM v8.work_items WHERE id=wid AND project_id=pid AND actor_id=c.principal_id) THEN RAISE EXCEPTION 'owned_work_context_required' USING ERRCODE='42501';END IF;
  PERFORM authz.check_access(c.principal_id,c.id,pid,'v8.work.read');
  wc:=jsonb_build_object('project_id',pid,'work_item_id',wid);
 END IF;
 INSERT INTO authz.runtime_sources(principal_id,client_id,credential_id,registered_by,public_key_pem,registration_kind,descriptor,work_context)
 VALUES(c.principal_id,c.id,target_cred,(me->>'actor_id')::uuid,b->>'public_key_pem',kind,COALESCE(b->'descriptor','{}'),wc) RETURNING * INTO r;
 INSERT INTO authz.runtime_source_events(runtime_id,actor_id,kind)VALUES(r.id,(me->>'actor_id')::uuid,'registered');
 RETURN jsonb_build_object('runtime_id',r.id,'actor_id',r.principal_id,'client_id',r.client_id,'credential_id',r.credential_id,'registration_kind',r.registration_kind,'work_context_id',r.work_context_id,'work_context',r.work_context,'active',true,'host_verified',false);
END $function$
;
