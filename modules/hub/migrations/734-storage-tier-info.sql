SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.storage_tier_info(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;s mem.storage_primary_locations;t mem.storage_tier_copies;r mem.storage_physical_retirements;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'invalid_request';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 SELECT * INTO s FROM mem.storage_primary_locations WHERE version_id=v.id;
 SELECT * INTO t FROM mem.storage_tier_copies WHERE copy_id=s.copy_id;
 SELECT * INTO r FROM mem.storage_physical_retirements WHERE operation_id=s.operation_id;
 RETURN jsonb_build_object('state','storage_info','version_id',v.id,'primary_tier',coalesce(t.tier,'standard'),'operation_id',s.operation_id,'retirement_state',r.state,'retirement_reason',r.reason,'hot_deleted',coalesce(r.state='retired',false),'logical_identity_unchanged',true,'provider_readability','check_on_read_or_restore_status');
END $$;
REVOKE ALL ON FUNCTION mem.storage_tier_info(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_tier_info(uuid,text,text)TO hub2_mem;
RESET ROLE;
