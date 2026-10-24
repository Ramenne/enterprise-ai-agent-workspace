-- Internal exact indexed locator for current Mem only. No new tables/global scan.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.fixed_reference_project_internal(material uuid,version uuid)RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE project uuid;
BEGIN
 IF NOT pg_has_role(session_user,'hub2_mem','MEMBER')THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT m.project_id INTO project FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id
 WHERE v.id=version AND v.material_id=material AND m.id=material;
 RETURN project;
END $$;
REVOKE ALL ON FUNCTION mem.fixed_reference_project_internal(uuid,uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.fixed_reference_project_internal(uuid,uuid)TO hub2_mem;
RESET ROLE;
