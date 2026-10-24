BEGIN;
ALTER FUNCTION mem.lookup_file_no782(text)RENAME TO lookup_file_no;
ALTER FUNCTION authz.material_share781(text,jsonb)RENAME TO material_share;
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.record_stream_use780()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF NEW.state='sent' AND OLD.state IS DISTINCT FROM 'sent' AND NOT EXISTS(SELECT FROM mem.material_use_events WHERE material_id=NEW.material_id AND version_id=NEW.version_id AND actor_id=NEW.actor_id AND client_id=NEW.client_id AND kind='body_read' AND occurred_at>=clock_timestamp()-interval '5 seconds')THEN
 INSERT INTO mem.material_use_events(material_id,version_id,project_id,actor_id,client_id,event_key,kind)
 SELECT NEW.material_id,NEW.version_id,m.project_id,NEW.actor_id,NEW.client_id,'stream:'||NEW.id,'body_read' FROM mem.materials m WHERE m.id=NEW.material_id ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;
END $$;
RESET ROLE;
COMMIT;
