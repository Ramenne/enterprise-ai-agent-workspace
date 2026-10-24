-- Small additive direct-control function over current Vault. No identity/grant seeds.
BEGIN;SET ROLE hub2_authz_owner;
CREATE FUNCTION vault2.grant_set(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;e vault2.entries;p authz.principals;target uuid;targets uuid[];want boolean;unlimited boolean;expiry timestamptz;ceiling timestamptz;g vault2.grants;changed integer:=0;others integer:=0;result jsonb;
BEGIN
 i:=vault2.identity(proof);SELECT * INTO e FROM vault2.entries WHERE id=vault2.resolve_entry(i,b||jsonb_build_object('key',coalesce(b->>'key',b->>'key_id')))FOR UPDATE;i:=authz.vault_current_identity(proof,e.project_id);
 IF e.id IS NULL OR NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'full_vault_manager_required' USING ERRCODE='42501';END IF;
 -- Data subject is the assignment target, never the authenticated action Actor.
 IF (b->>'principal_id'IS NULL)=(b->>'username'IS NULL)THEN RAISE EXCEPTION 'principal_or_registered_username_required';END IF;
 IF b->>'principal_id'IS NOT NULL THEN target:=(b->>'principal_id')::uuid;ELSE
  SELECT array_agg(DISTINCT principal_id)INTO targets FROM(SELECT principal_id FROM authz.legacy_member_maps WHERE legacy_subject=b->>'username'AND active UNION ALL SELECT principal_id FROM vault2.service_bindings WHERE legacy_subject=b->>'username'AND active)bindings;
  IF cardinality(targets)IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'current_identity_mapping_required' USING ERRCODE='42501';END IF;target:=targets[1];
 END IF;
 SELECT * INTO p FROM authz.principals WHERE id=target FOR SHARE;
 IF p.id IS NULL OR p.organization_id IS DISTINCT FROM e.organization_id THEN RAISE EXCEPTION 'same_org_subject_required' USING ERRCODE='42501';END IF;
 IF b?'enabled'AND b?'granted'AND b->'enabled'IS DISTINCT FROM b->'granted'THEN RAISE EXCEPTION 'conflicting_grant_state';END IF;
 IF jsonb_typeof(coalesce(b->'enabled',b->'granted'))IS DISTINCT FROM'boolean'THEN RAISE EXCEPTION 'explicit_boolean_grant_state_required';END IF;want:=coalesce((b->>'enabled')::boolean,(b->>'granted')::boolean);
 IF want AND p.active IS DISTINCT FROM true THEN RAISE EXCEPTION 'current_subject_required' USING ERRCODE='42501';END IF;
 -- Serialize the former (key_id, username) state without deleting its history.
 PERFORM pg_advisory_xact_lock(hashtextextended('vaultgrantset:'||e.id::text||':'||target::text,0));PERFORM id FROM vault2.grants WHERE entry_id=e.id AND principal_id=target ORDER BY id FOR UPDATE;
 i:=authz.vault_current_identity(proof,e.project_id);ceiling:=vault2.manager_deadline(i,e);IF ceiling IS NULL OR ceiling<=clock_timestamp()THEN RAISE EXCEPTION 'current_full_manager_required' USING ERRCODE='42501';END IF;
 IF NOT want THEN
  UPDATE vault2.grants SET revoked_at=clock_timestamp(),revision=revision+1 WHERE entry_id=e.id AND principal_id=target AND revoked_at IS NULL;GET DIAGNOSTICS changed=ROW_COUNT;
  result:=jsonb_build_object('state','revoked','entry_id',e.id,'key_id',e.name,'principal_id',target,'enabled',false,'changed_grants',changed,'unchanged',changed=0);
 ELSE
  unlimited:=coalesce((b->>'until_revoked')::boolean,b->>'expires_at'IS NULL);expiry:=(b->>'expires_at')::timestamptz;
  IF NOT unlimited AND(expiry IS NULL OR NOT isfinite(expiry)OR expiry<=clock_timestamp())THEN RAISE EXCEPTION 'invalid_expiry';END IF;
  expiry:=least(CASE WHEN unlimited THEN'infinity'::timestamptz ELSE expiry END,ceiling,coalesce(e.provider_expires_at,'infinity'::timestamptz));unlimited:=NOT isfinite(expiry);IF unlimited THEN expiry:=NULL;END IF;
  SELECT * INTO g FROM vault2.grants WHERE entry_id=e.id AND principal_id=target AND client_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1;
  -- A direct owner/member assignment is person-scoped, while each caller still needs vault.read.
  IF g.id IS NULL THEN INSERT INTO vault2.grants(entry_id,principal_id,client_id,issued_by,until_revoked,expires_at,reason)VALUES(e.id,target,NULL,(i->>'actor_id')::uuid,unlimited,expiry,jsonb_build_object('basis','legacy_direct_grant_set','reason',b->'reason'))RETURNING * INTO g;changed:=1;
  ELSIF(g.until_revoked,g.expires_at)IS DISTINCT FROM(unlimited,expiry)THEN UPDATE vault2.grants SET until_revoked=unlimited,expires_at=expiry,issued_by=(i->>'actor_id')::uuid,revision=revision+1,reason=jsonb_build_object('basis','legacy_direct_grant_set','reason',b->'reason')WHERE id=g.id RETURNING * INTO g;changed:=1;END IF;
  -- One current logical assignment; supersede client-specific/duplicate rows rather than minting more.
  UPDATE vault2.grants SET revoked_at=clock_timestamp(),revision=revision+1 WHERE entry_id=e.id AND principal_id=target AND id<>g.id AND revoked_at IS NULL;GET DIAGNOSTICS others=ROW_COUNT;
  result:=jsonb_build_object('state','granted','entry_id',e.id,'key_id',e.name,'principal_id',target,'grant_id',g.id,'revision',g.revision,'enabled',true,'until_revoked',g.until_revoked,'expires_at',g.expires_at,'superseded_grants',others,'unchanged',changed=0 AND others=0);
 END IF;
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'direct_grant_set',e.id,g.id,result);
 i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_full_manager_required' USING ERRCODE='42501';END IF;RETURN result;
END$$;
REVOKE ALL ON FUNCTION vault2.grant_set(text,jsonb)FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;GRANT EXECUTE ON FUNCTION vault2.grant_set(text,jsonb)TO hub2_hufu;
-- Preserve current738 visibility/may_decide filtering; only add metadata compatibility fields.
DO $friendly_apps$DECLARE before text;after text;needle text:=$needle$'id',a.id,'entry_id',a.entry_id$needle$;BEGIN
 before:=pg_get_functiondef('vault2.applications(text,jsonb)'::regprocedure);
 after:=replace(before,needle,$fields$'id',a.id,'entry_id',a.entry_id,'application_id',a.id,'status',a.state,'key_id',(SELECT name FROM vault2.entries WHERE id=a.entry_id),'applicant',(SELECT display_name FROM authz.principals WHERE id=a.applicant_id),'applicant_username',coalesce((SELECT legacy_subject FROM authz.legacy_member_maps WHERE principal_id=a.applicant_id AND active ORDER BY registered_at,id LIMIT 1),(SELECT legacy_subject FROM vault2.service_bindings WHERE principal_id=a.applicant_id AND active ORDER BY legacy_subject LIMIT 1))$fields$);
 IF after=before THEN RAISE EXCEPTION 'reviewed_applications_shape_changed';END IF;EXECUTE after;
END $friendly_apps$;
RESET ROLE;COMMIT;
