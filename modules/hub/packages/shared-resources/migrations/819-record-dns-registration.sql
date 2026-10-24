SET ROLE hub2_authz_owner;
-- Register an installed record-scoped descriptor under its original manager.
-- Existing descriptors and member qualifications remain unchanged.
CREATE OR REPLACE FUNCTION authz.shared_dns_record_register(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE old authz.resource_typed_targets58;r authz.resource_regions58;i jsonb;t authz.resource_typed_targets58;BEGIN
 IF authz.runtime_role()<>'hub2_hufu'OR b IS NULL OR b-ARRAY['base_target_id','target_id','fingerprint','descriptor_hash']<>'{}'::jsonb OR NOT b?&ARRAY['base_target_id','target_id','fingerprint','descriptor_hash']OR b->>'target_id'!~'^jiaxin-dns819-[a-z-]+-records$'OR b->>'fingerprint'!~'^[a-f0-9]{64}$'OR b->>'descriptor_hash'!~'^[a-f0-9]{64}$'THEN RAISE EXCEPTION 'installed_record_scoped_DNS_descriptor_required';END IF;
 SELECT * INTO old FROM authz.resource_typed_targets58 WHERE id=b->>'base_target_id'FOR SHARE;SELECT * INTO r FROM authz.resource_regions58 WHERE id=old.region_id FOR SHARE;
 IF old.kind IS DISTINCT FROM'dnspod'OR NOT old.active OR NOT r.active OR NOT('dnspod.record.modify'=ANY(old.actions))THEN RAISE EXCEPTION 'original_DNS_source_unavailable';END IF;
 i:=authz.shared_usage_management(proof,r.project_id,old.area_id);
 SELECT * INTO t FROM authz.resource_typed_targets58 WHERE id=b->>'target_id'FOR UPDATE;
 IF t.id IS NOT NULL THEN
  IF t.kind IS DISTINCT FROM'dnspod'OR t.region_id IS DISTINCT FROM old.region_id OR t.area_id IS DISTINCT FROM old.area_id OR t.endpoint_id IS DISTINCT FROM old.endpoint_id OR t.actions IS DISTINCT FROM ARRAY['dnspod.records.describe','dnspod.record.modify']::text[]THEN RAISE EXCEPTION 'record_scoped_DNS_target_conflict';END IF;
  IF NOT t.active OR t.fingerprint IS DISTINCT FROM b->>'fingerprint' OR t.descriptor_hash IS DISTINCT FROM b->>'descriptor_hash'THEN
  UPDATE authz.resource_typed_targets58 SET fingerprint=b->>'fingerprint',descriptor_hash=b->>'descriptor_hash',epoch=epoch+1,active=true WHERE id=t.id RETURNING * INTO t;
  END IF;
 ELSE INSERT INTO authz.resource_typed_targets58(id,region_id,area_id,endpoint_id,kind,environment,actions,fingerprint,descriptor_hash,active)VALUES(b->>'target_id',old.region_id,old.area_id,old.endpoint_id,'dnspod',old.environment,ARRAY['dnspod.records.describe','dnspod.record.modify'],b->>'fingerprint',b->>'descriptor_hash',true)RETURNING * INTO t;END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'hufu','shared_DNS.record_descriptor.register',jsonb_build_object('target_id',t.id,'base_target_id',old.id,'epoch',t.epoch,'member_grant_created',false,'production_DNS_value_changed',false,'original_mutable_target_changed',false,'registered_record_scope_only',true));
 RETURN jsonb_build_object('state','record_scoped_DNS_descriptor_registered','target_id',t.id,'epoch',t.epoch,'management_project_id',r.project_id,'actions',t.actions,'member_grant_created',false,'production_DNS_value_changed',false,'original_mutable_target_changed',false,'registered_record_scope_only',true);
END $$;
REVOKE ALL ON FUNCTION authz.shared_dns_record_register(text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.shared_dns_record_register(text,jsonb)TO hub2_hufu;
RESET ROLE;
