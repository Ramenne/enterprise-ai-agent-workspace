-- Additive over already installed735. No schema/roles/secret-value changes.
BEGIN;SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION vault2.registry(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;pr v8.projects;old vault2.commands;result jsonb;created boolean:=false;owner_grant vault2.grants;owner_deadline timestamptz;creation_ceiling timestamptz;command_key text:=b->>'idempotency_key';fp text:=encode(public.digest(b::text,'sha256'),'hex');BEGIN
 IF b?'value'OR b?'secret_ref'OR b?'actor'OR b?'owner_id'THEN RAISE EXCEPTION 'invalid_registry_metadata';END IF;i:=vault2.identity(proof);IF coalesce(length(command_key),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 IF b->>'entry_id'IS NOT NULL THEN SELECT * INTO e FROM vault2.entries WHERE id=(b->>'entry_id')::uuid FOR UPDATE;ELSE SELECT * INTO pr FROM v8.projects WHERE id=(b->>'project_id')::uuid;e.project_id:=pr.id;e.organization_id:=pr.organization_id;e.area_id:=(b->>'area_id')::uuid;e.owner_id:=(i->>'actor_id')::uuid;END IF;
 i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':vaultregistry:'||command_key,0));SELECT * INTO old FROM vault2.commands WHERE actor_id=(i->>'actor_id')::uuid AND key=command_key;IF old.key IS NOT NULL THEN IF old.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 IF e.id IS NOT NULL AND EXISTS(SELECT FROM vault2.legacy_registry WHERE entry_id=e.id AND authority<>'vault2')THEN RAISE EXCEPTION 'vault_migration_authority_pending' USING ERRCODE='42501';END IF;IF e.area_id IS NOT NULL AND NOT EXISTS(SELECT FROM authz.resource_areas WHERE id=e.area_id AND project_id=e.project_id AND active)THEN RAISE EXCEPTION 'area_scope_mismatch' USING ERRCODE='42501';END IF;IF e.id IS NULL THEN
  IF(b->>'expected_revision')::bigint IS DISTINCT FROM 0 OR b->>'kind'NOT IN('model_api','service_login','generic','server_manage','dns_manage','cos_manage')THEN RAISE EXCEPTION 'invalid_input';END IF;
  created:=true;e.id:=gen_random_uuid();INSERT INTO vault2.entries(id,organization_id,project_id,area_id,name,label,description,kind,visibility,owner_id,secret_ref,execution_channel,manual)VALUES(e.id,e.organization_id,e.project_id,e.area_id,b->>'name',coalesce(b->>'label',b->>'name'),coalesce(b->>'description',''),b->>'kind',coalesce(b->>'visibility','organization'),e.owner_id,'bao:hub2/hufu/vault2/entries/'||e.id,coalesce(b->'execution_channel','{}'),b->'manual')RETURNING * INTO e;
 ELSE
  IF e.revision IS DISTINCT FROM(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
  -- Sensitivity/identity/ref cannot be downgraded or redirected by a metadata update.
  UPDATE vault2.entries SET label=coalesce(b->>'label',label),description=coalesce(b->>'description',description),visibility=coalesce(b->>'visibility',visibility),manual=CASE WHEN b?'manual'THEN b->'manual'ELSE manual END,active=coalesce((b->>'active')::boolean,active),revision=revision+1 WHERE id=e.id RETURNING * INTO e;
 END IF;
 i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;
 -- Native catalog creation is authoritative here; do not shadow an existing legacy identity.
 IF created THEN
  INSERT INTO vault2.legacy_registry(organization_id,legacy_key_id,entry_id,legacy_subject,principal_id,authority,source_metadata)
  VALUES(e.organization_id,e.name,e.id,NULL,e.owner_id,'vault2',jsonb_build_object('source','native_entry','registered_actor_id',i->>'actor_id','creation_client_id',i->>'client_id'));
 END IF;
 -- Creating a normal owned resource includes its owner's initial use; it is not approving an application.
 IF created AND NOT vault2.high_sensitive(e)THEN
  creation_ceiling:=vault2.manager_deadline(i,e);IF creation_ceiling IS NULL OR creation_ceiling<=clock_timestamp()THEN RAISE EXCEPTION 'current_creation_authority_required' USING ERRCODE='42501';END IF;
  owner_deadline:=least(creation_ceiling,coalesce(e.provider_expires_at,'infinity'::timestamptz));
  IF owner_deadline IS NULL THEN RAISE EXCEPTION 'current_creation_authority_required' USING ERRCODE='42501';END IF;
  INSERT INTO vault2.grants(entry_id,principal_id,client_id,issued_by,until_revoked,expires_at,reason)
  VALUES(e.id,e.owner_id,NULL,(i->>'actor_id')::uuid,NOT isfinite(owner_deadline),CASE WHEN isfinite(owner_deadline)THEN owner_deadline ELSE NULL END,jsonb_build_object('basis','owned_resource_creation','application_self_approval',false))RETURNING * INTO owner_grant;
  INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'owner_initial_grant',e.id,owner_grant.id,jsonb_build_object('basis','owned_resource_creation','owner_person_scope',true,'creation_client_id',i->>'client_id','until_revoked',owner_grant.until_revoked,'expires_at',owner_grant.expires_at));
 END IF;
 result:=jsonb_build_object('state',CASE WHEN e.active THEN'registered'ELSE'disabled'END,'entry_id',e.id,'name',e.name,'revision',e.revision,'secret_value_ready','not_inferred','owner_initial_grant_id',owner_grant.id,'owner_grant_scope',CASE WHEN owner_grant.id IS NOT NULL THEN'owner_person_with_current_client_ceiling'ELSE NULL END,'owner_grant_expires_at',owner_grant.expires_at,'owner_grant_until_revoked',owner_grant.until_revoked);INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'registry',e.id,result);INSERT INTO vault2.commands VALUES((i->>'actor_id')::uuid,command_key,fp,result);i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;RETURN result;
END$$;
RESET ROLE;COMMIT;
