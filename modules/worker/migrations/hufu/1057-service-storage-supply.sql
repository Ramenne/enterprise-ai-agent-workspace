-- Platform resource supply, not app file operations. Root stays in service RAM.
CREATE OR REPLACE FUNCTION authz.service_storage_supply_prepare(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;p authz.service_resource_packages;item jsonb;grants jsonb;locator jsonb;result jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object' OR b-ARRAY['package_id','item_id','mode','source_key']<>'{}' OR b->>'mode' IS NULL OR b->>'mode' NOT IN('bootstrap','supply') THEN RAISE EXCEPTION 'invalid_storage_supply_input' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);
 IF i->>'principal_kind'<>'member' OR i->>'member_role'<>'organization_admin' THEN RAISE EXCEPTION 'organization_storage_manager_required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.service_resource_packages WHERE id=(b->>'package_id')::uuid FOR SHARE;
 IF p.id IS NULL OR p.state NOT IN('approved','partially_delivered','delivered') OR p.organization_id<>(i->>'organization_id')::uuid THEN RAISE EXCEPTION 'approved_storage_package_required' USING ERRCODE='42501';END IF;
 PERFORM authz.service_manager(proof,p.project_id);
 SELECT value INTO item FROM jsonb_array_elements(p.resources) WHERE value->>'item_id'=b->>'item_id';
 IF item IS NULL OR item->>'kind'<>'storage' OR item->'requirements'->>'mode'<>'object_namespace' THEN RAISE EXCEPTION 'approved_object_storage_item_required' USING ERRCODE='42501';END IF;
 grants:=authz.service_authorizations_read(proof,jsonb_build_object('project_id',p.project_id,'service_id',p.service_id));
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(grants->'items') g WHERE g->>'effective_now'='true' AND g->'capabilities'?'storage' AND g->'application_project_id'='null'::jsonb) THEN RAISE EXCEPTION 'effective_application_storage_grant_required' USING ERRCODE='42501';END IF;
 IF b->>'mode'='bootstrap' THEN
  IF b->>'source_key' IS DISTINCT FROM 'server.zgc.manage' THEN RAISE EXCEPTION 'registered_storage_bootstrap_source_required' USING ERRCODE='42501';END IF;
  -- Reuse existing real owner/manager confirmation checks. The additional
  -- package check authorizes only this new platform storage supply purpose.
  locator:=vault2.cloud_managed_parent_prepare(proof,jsonb_build_object('key',b->>'source_key'));
 ELSE
  IF b?'source_key' THEN RAISE EXCEPTION 'ordinary_supply_does_not_read_root' USING ERRCODE='22023';END IF;
 END IF;
 result:=jsonb_build_object('state','storage_supply_authorized','mode',b->>'mode','actor_id',i->>'actor_id','client_id',i->>'client_id','organization_id',p.organization_id,'project_id',p.project_id,'service_id',p.service_id,'package_id',p.id,'package_revision',p.revision,'item',item,'approved_package',jsonb_build_object('package_id',p.id,'project_id',p.project_id,'service_id',p.service_id,'state',p.state,'resources',p.resources),'parent_locator',locator,'supplier_config','fixed_platform_owned_issuer_only','parent_plaintext_member_delivery',false,'application_permission_scope','approved_project_bucket_only','agent_work_required_for_objects',false,'per_object_approval_required',false);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','service.storage_supply.prepare',p.id,result-'parent_locator');
 RETURN result;
END $f$;
ALTER FUNCTION authz.service_storage_supply_prepare(text,jsonb) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.service_storage_supply_prepare(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.service_storage_supply_prepare(text,jsonb) TO hub2_hufu;
