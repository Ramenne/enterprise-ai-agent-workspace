BEGIN;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.infer_placement_format782()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF NEW.active THEN UPDATE mem.materials SET file_format=lower(substring(NEW.logical_path from '\.([A-Za-z0-9]{1,16})$'))WHERE id=NEW.material_id AND properties#>>'{core,file_format}'IS NULL;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mem.infer_placement_format782()FROM PUBLIC;
CREATE TRIGGER infer_placement_format782 AFTER INSERT OR UPDATE OF logical_path ON mem.placements FOR EACH ROW EXECUTE FUNCTION mem.infer_placement_format782();
CREATE FUNCTION mem.lookup_file_no782(no text)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$SELECT jsonb_build_object('material_id',id,'project_id',project_id)FROM mem.materials WHERE file_no::text=no$$;
REVOKE ALL ON FUNCTION mem.lookup_file_no782(text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.lookup_file_no782(text)TO hub2_mem;
RESET ROLE;
COMMIT;
