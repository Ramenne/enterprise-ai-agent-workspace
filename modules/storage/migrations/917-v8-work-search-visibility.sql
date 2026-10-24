BEGIN;
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.work_search_ref_visible(actor uuid,client uuid,ref jsonb)RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE v mem.content_versions;s record;disclosed boolean;
BEGIN
 SELECT * INTO v FROM mem.content_versions WHERE id=(ref->>'version_id')::uuid AND material_id=(ref->>'material_id')::uuid AND sha256=ref->>'sha256';
 IF v.id IS NULL OR NOT mem.version_visible(actor,v.id)THEN RETURN false;END IF;
 disclosed:=EXISTS(SELECT FROM mem.disclosures d WHERE d.output_version_id=v.id AND d.state='active'AND d.manifest->>'continued_source_access'='not_required');
 BEGIN
  FOR s IN SELECT cv.id,cv.material_id,cv.sha256,m.project_id FROM mem.source_closure(v.id)cl JOIN mem.content_versions cv ON cv.id=cl.version_id JOIN mem.materials m ON m.id=cv.material_id WHERE NOT disclosed OR cl.version_id=v.id LOOP
   PERFORM authz.resource_deadline(actor,client,s.project_id,'mem.read',jsonb_build_object('project_id',s.project_id,'material_id',s.material_id,'version_id',s.id,'sha256',s.sha256));
  END LOOP;
 EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION mem.work_search_ref_visible(uuid,uuid,jsonb)FROM PUBLIC,hub2_mem,hub2_v8,hub2_hufu;
GRANT EXECUTE ON FUNCTION mem.work_search_ref_visible(uuid,uuid,jsonb)TO hub2_v8_owner;
RESET ROLE;
COMMIT;
