CREATE OR REPLACE FUNCTION mem.signal_project_commit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.project_id IS NOT NULL THEN PERFORM pg_notify('hub2_project_commits',jsonb_build_object('project_id',OLD.project_id)::text); END IF;
 IF TG_OP<>'DELETE' AND NEW.project_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN PERFORM pg_notify('hub2_project_commits',jsonb_build_object('project_id',NEW.project_id)::text); END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS notify_project_commit ON mem.materials;
CREATE TRIGGER notify_project_commit AFTER INSERT OR UPDATE OR DELETE ON mem.materials FOR EACH ROW EXECUTE FUNCTION mem.signal_project_commit();
