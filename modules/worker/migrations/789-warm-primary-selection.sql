BEGIN;
SET ROLE hub2_mem_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.storage_warm_control(uuid,text,text)'::regprocedure);
 s:=replace(s,'DELETE FROM mem.storage_primary_locations WHERE version_id=v.id;', 'UPDATE mem.storage_primary_locations SET copy_id=cp,basis=''standard_copy:''||r.id::text,selected_at=clock_timestamp() WHERE version_id=v.id;');EXECUTE s;
END $patch$;
-- Reconcile the two successful copies made during this affected flow. No byte deletion.
UPDATE mem.storage_primary_locations p SET copy_id=(w.receipt->>'copy_id')::uuid,basis='standard_copy:'||w.id::text,selected_at=clock_timestamp() FROM mem.storage_warm_operations w WHERE p.version_id=w.version_id AND w.state='verified'AND w.id=(SELECT x.id FROM mem.storage_warm_operations x WHERE x.version_id=p.version_id AND x.state='verified'ORDER BY x.created_at DESC,x.id DESC LIMIT 1);
ALTER FUNCTION mem.storage_tier_info(uuid,text,text)RENAME TO storage_tier_info_before_warming;
REVOKE ALL ON FUNCTION mem.storage_tier_info_before_warming(uuid,text,text)FROM PUBLIC,hub2_mem;
CREATE FUNCTION mem.storage_tier_info(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE result jsonb;s mem.storage_primary_locations;w mem.storage_warm_operations;
BEGIN
 result:=mem.storage_tier_info_before_warming(h,d,payload);SELECT *INTO s FROM mem.storage_primary_locations WHERE version_id=((payload::jsonb)->>'version_id')::uuid;
 IF s.basis LIKE 'standard_copy:%'THEN SELECT *INTO w FROM mem.storage_warm_operations WHERE id=substring(s.basis from 15)::uuid AND state='verified';IF w.id IS NOT NULL THEN result:=result||jsonb_build_object('primary_tier','standard','operation_id',w.id,'hot_deleted',false,'retirement_state',NULL,'retirement_reason',NULL,'previous_storage_copy_retained',true);END IF;END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION mem.storage_tier_info(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_tier_info(uuid,text,text)TO hub2_mem;
RESET ROLE;
COMMIT;
