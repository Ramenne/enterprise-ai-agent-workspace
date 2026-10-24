-- Fix observed ordinary-member delivery failures. Keep item/entry grants,
-- recipient/email binding, primary proof, confirmed management and restricted profiles.
BEGIN;
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION vault2.delivery_identity(proof text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;item text;ordinary boolean;
BEGIN
 i:=authz.vault_current_identity(proof,NULL);ordinary:=coalesce(i->>'authorization_mode'='member_qualification',false);
 IF NOT coalesce((i->>'is_primary')::boolean,false)THEN PERFORM authz.require_client_capability(i,'hufu.vault.read');END IF;
 IF NOT coalesce((i->>'is_primary')::boolean,false)AND NOT ordinary AND i->'scope_filters'<>'[]'::jsonb THEN
  item:=current_setting('hufu.native_entry_claim',true);
  IF item IS NULL OR item=''THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
  PERFORM vault2.entry_claim_guard(proof,item::uuid);
 END IF;RETURN i;
END $$;
CREATE OR REPLACE FUNCTION vault2.delivery_request_manager(i jsonb)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE ordinary boolean:=coalesce(i->>'authorization_mode'='member_qualification',false);
BEGIN
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin')THEN RETURN false;END IF;
 IF coalesce((i->>'is_primary')::boolean,false)THEN RETURN true;END IF;
 IF i->'scope_filters'='[]'::jsonb AND i->'client_actions'?'hufu.credential.manage'THEN RETURN true;END IF;
 IF i->'scope_filters'='[]'::jsonb AND i->'client_actions'?'hufu.vault.decide'AND authz.management_context_valid(i,NULL)THEN RETURN true;END IF;
 IF NOT ordinary AND i->'scope_filters'<>'[]'::jsonb THEN RETURN false;END IF;
 BEGIN PERFORM authz.require_client_capability(i,'hufu.vault.read');EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
 RETURN authz.management_context_allows(i,NULL,'hufu.vault.delivery.manage');
END $$;
CREATE OR REPLACE FUNCTION vault2.delivery_request_reviewer(i jsonb)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin')THEN RETURN false;END IF;
 IF coalesce((i->>'is_primary')::boolean,false)THEN RETURN true;END IF;
 IF coalesce(i->>'authorization_mode','')<>'member_qualification'AND i->'scope_filters'<>'[]'::jsonb THEN RETURN false;END IF;
 BEGIN PERFORM authz.require_client_capability(i,'hufu.vault.read');EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION vault2.delivery_identity(text),vault2.delivery_request_manager(jsonb),vault2.delivery_request_reviewer(jsonb)FROM PUBLIC;
-- Preserve all existing specific EXECUTE grants and original function owners.
RESET ROLE;
COMMIT;
