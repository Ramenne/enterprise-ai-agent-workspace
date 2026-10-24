SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.jiaxin_lighthouse_register(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE base authz.resource_typed_targets58;r authz.resource_regions58;et authz.resource_execution_targets;i jsonb;aid uuid;t authz.resource_typed_targets58;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b-ARRAY['fingerprint','descriptor_hash']<>'{}'::jsonb OR NOT b?&ARRAY['fingerprint','descriptor_hash'] OR b->>'fingerprint'!~'^[a-f0-9]{64}$' OR b->>'descriptor_hash'!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'installed_lighthouse_descriptor_required';END IF;
 SELECT * INTO base FROM authz.resource_typed_targets58 WHERE id='jiaxin-cloud743-workspace-cloud';
 SELECT * INTO r FROM authz.resource_regions58 WHERE id=base.region_id;
 i:=authz.shared_usage_management(proof,r.project_id,base.area_id);
 SELECT * INTO t FROM authz.resource_typed_targets58 WHERE id='jiaxin-lighthouse-instance';
 IF t.id IS NOT NULL THEN
  IF t.kind IS DISTINCT FROM 'lighthouse' OR t.region_id IS DISTINCT FROM r.id THEN RAISE EXCEPTION 'lighthouse_registration_conflict';END IF;
  UPDATE authz.resource_typed_targets58 SET fingerprint=b->>'fingerprint',descriptor_hash=b->>'descriptor_hash',epoch=epoch+1,actions=ARRAY['lighthouse.instance.describe','lighthouse.instance.start','lighthouse.instance.stop','lighthouse.instance.restart'] WHERE id=t.id RETURNING * INTO t;UPDATE authz.resource_execution_targets SET operations=ARRAY['read','write'] WHERE area_id=t.area_id;RETURN to_jsonb(t)||jsonb_build_object('state','updated_registration','project_id',r.project_id);END IF;
 SELECT * INTO et FROM authz.resource_execution_targets WHERE area_id=base.area_id;
 IF NOT base.active OR NOT r.active OR NOT et.active THEN RAISE EXCEPTION 'execution_source_unavailable';END IF;
 INSERT INTO authz.resource_areas(project_id,label,active)VALUES(r.project_id,'嘉兴 Lighthouse 云实例',true)RETURNING id INTO aid;
 INSERT INTO authz.resource_execution_targets(area_id,endpoint_id,environment,operations,root_fingerprint,active)VALUES(aid,et.endpoint_id,et.environment,ARRAY['read','write'],et.root_fingerprint,true);
 INSERT INTO authz.resource_typed_targets58(id,region_id,area_id,endpoint_id,kind,environment,actions,fingerprint,descriptor_hash,active)VALUES('jiaxin-lighthouse-instance',r.id,aid,base.endpoint_id,'lighthouse',base.environment,ARRAY['lighthouse.instance.describe','lighthouse.instance.start','lighthouse.instance.stop','lighthouse.instance.restart'],b->>'fingerprint',b->>'descriptor_hash',true)RETURNING * INTO t;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'hufu','lighthouse.target.register',aid,jsonb_build_object('target_id',t.id,'account_id','100048716377','instance_id','example-resource-id','member_grant_created',false));
 RETURN to_jsonb(t)||jsonb_build_object('state','registered','project_id',r.project_id);
END $$;
REVOKE ALL ON FUNCTION authz.jiaxin_lighthouse_register(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.jiaxin_lighthouse_register(text,jsonb) TO hub2_hufu;
RESET ROLE;
