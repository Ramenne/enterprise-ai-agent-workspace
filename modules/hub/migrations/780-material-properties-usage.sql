BEGIN;
SET ROLE hub2_mem_owner;
CREATE SEQUENCE mem.material_file_no AS bigint START 1000000 NO CYCLE;
ALTER TABLE mem.materials ADD COLUMN file_no bigint NOT NULL DEFAULT nextval('mem.material_file_no'), ADD COLUMN importance_level smallint CHECK(importance_level BETWEEN 1 AND 3), ADD COLUMN file_format text;
ALTER TABLE mem.materials ADD CONSTRAINT material_file_no_unique UNIQUE(file_no);
ALTER SEQUENCE mem.material_file_no OWNED BY mem.materials.file_no;
COMMENT ON COLUMN mem.materials.file_no IS 'Readable increasing alias; UUID remains stable canonical identity; no fixed display width.';
CREATE FUNCTION mem.sync_material_core780() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE level_text text;
BEGIN
 level_text:=NEW.properties#>>'{governance,importance_level}';
 IF level_text IS NOT NULL THEN
  IF level_text NOT IN('1','2','3') THEN RAISE EXCEPTION 'invalid_importance_level';END IF;
  NEW.importance_level:=level_text::smallint;
 ELSIF TG_OP='INSERT' OR NEW.properties#>'{governance,important}' IS DISTINCT FROM OLD.properties#>'{governance,important}' THEN
  NEW.importance_level:=CASE NEW.properties#>>'{governance,important}' WHEN 'true' THEN 1 WHEN 'false' THEN 3 ELSE NEW.importance_level END;
 END IF;
 IF NEW.importance_level IS NOT NULL THEN
  NEW.properties:=jsonb_set(NEW.properties,'{governance}',coalesce(NEW.properties->'governance','{}')||jsonb_build_object('importance_level',NEW.importance_level,'important',NEW.importance_level=1),true);
 END IF;
 IF NEW.properties#>>'{core,file_format}' IS NOT NULL THEN NEW.file_format:=lower(NEW.properties#>>'{core,file_format}');END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_material_core780 BEFORE INSERT OR UPDATE OF properties ON mem.materials FOR EACH ROW EXECUTE FUNCTION mem.sync_material_core780();
UPDATE mem.materials SET importance_level=CASE properties#>>'{governance,important}' WHEN 'true' THEN 1 WHEN 'false' THEN 3 ELSE NULL END;
UPDATE mem.materials SET properties=properties;
UPDATE mem.materials m SET file_format=lower(substring(p.logical_path from '\.([A-Za-z0-9]{1,16})$')) FROM mem.placements p WHERE p.material_id=m.id AND p.active AND m.file_format IS NULL;
CREATE TABLE mem.material_use_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), material_id uuid NOT NULL REFERENCES mem.materials(id), version_id uuid NOT NULL REFERENCES mem.content_versions(id), project_id uuid NOT NULL,
 actor_id uuid NOT NULL,client_id uuid NOT NULL, event_key text NOT NULL,kind text NOT NULL CHECK(kind IN('body_read','adopted','reused')), reason text, work_item_id uuid,
 source_context jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_id,material_id,event_key));
CREATE INDEX material_use_events_recent ON mem.material_use_events(material_id,occurred_at DESC);
REVOKE ALL ON mem.material_use_events FROM PUBLIC,hub2_mem,hub2_worker;
REVOKE ALL ON SEQUENCE mem.material_file_no FROM PUBLIC,hub2_mem,hub2_worker;
CREATE FUNCTION mem.material_use_record(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;r mem.material_use_events;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR coalesce(b->>'event_key','')='' OR length(b->>'event_key')>200 OR coalesce(b->>'kind','')NOT IN('body_read','adopted','reused') THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');PERFORM authz.assert_effect(h);
 INSERT INTO mem.material_use_events(material_id,version_id,project_id,actor_id,client_id,event_key,kind,reason,work_item_id,source_context)
 VALUES(v.material_id,v.id,(c->>'project_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,b->>'event_key',b->>'kind',left(b->>'reason',2000),(b->>'work_item_id')::uuid,coalesce(b->'source_context','{}')) ON CONFLICT DO NOTHING RETURNING * INTO r;
 IF r.id IS NULL THEN SELECT * INTO r FROM mem.material_use_events WHERE actor_id=(c->>'actor_id')::uuid AND material_id=v.material_id AND event_key=b->>'event_key';IF r.version_id<>v.id OR r.kind<>b->>'kind' THEN RAISE EXCEPTION 'usage_idempotency_conflict' USING ERRCODE='23505';END IF;END IF;
 RETURN jsonb_build_object('state','recorded','event_id',r.id,'material_id',r.material_id,'kind',r.kind,'evidence','delivery_or_Agent_declared_use;not_proof_of_understanding');
END $$;
CREATE FUNCTION mem.material_use_read(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;m mem.materials;result jsonb;days integer:=coalesce((b->>'window_days')::integer,30);
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR days NOT BETWEEN 1 AND 3650 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF m.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF m.current_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,m.current_version_id,'mem.read');END IF;
 SELECT jsonb_build_object('body_reads',count(*)FILTER(WHERE kind='body_read'),'independent_read_windows',count(DISTINCT (actor_id,version_id,floor(extract(epoch FROM occurred_at)/300)))FILTER(WHERE kind='body_read'),'adoptions',count(*)FILTER(WHERE kind='adopted'),'reuses',count(*)FILTER(WHERE kind='reused'),'last_used_at',max(occurred_at)) INTO result FROM mem.material_use_events WHERE material_id=m.id AND occurred_at>=clock_timestamp()-make_interval(days=>days);
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','usage_observed','material_id',m.id,'file_no',m.file_no::text,'importance_level',m.importance_level,'window_days',days,'usage',result,'coverage','events_since_780_deployment;no_historical_backfill','independence','same_actor_and_version_deduplicated_in_5_minute_windows;not_semantic_task_count','decision_owner','authorized_Agent_or_member','automatic_importance_change',false);
END $$;
CREATE FUNCTION mem.material_attributes(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;result jsonb;m mem.materials;pr record;
BEGIN
 result:=mem.material_head(h,d,payload);SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid;SELECT title,visibility INTO pr FROM v8.projects WHERE id=m.project_id;
 RETURN result||jsonb_build_object('core',jsonb_build_object('stable_id',m.id,'file_no',m.file_no::text,'importance_level',m.importance_level,'file_format',m.file_format,'file_format_basis',CASE WHEN m.properties#>>'{core,file_format}' IS NOT NULL THEN 'Agent_or_member_declared' ELSE 'extension_inferred;not_content_verified' END,'permission_project_id',m.project_id,'permission_project_name',pr.title,'project_visibility',pr.visibility),'attributes',coalesce(m.properties->'attributes','{}'));
END $$;
REVOKE ALL ON FUNCTION mem.material_use_record(uuid,text,text),mem.material_use_read(uuid,text,text),mem.material_attributes(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.material_use_record(uuid,text,text),mem.material_use_read(uuid,text,text),mem.material_attributes(uuid,text,text) TO hub2_mem;
-- Successful stream delivery provides transport evidence; metadata/listing never enters this table.
CREATE FUNCTION mem.record_stream_use780()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF NEW.state='sent' AND OLD.state IS DISTINCT FROM 'sent' THEN
 INSERT INTO mem.material_use_events(material_id,version_id,project_id,actor_id,client_id,event_key,kind)
 SELECT NEW.material_id,NEW.version_id,m.project_id,NEW.actor_id,NEW.client_id,'stream:'||NEW.id,'body_read' FROM mem.materials m WHERE m.id=NEW.material_id ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER record_stream_use780 AFTER UPDATE OF state ON mem.read_receipts FOR EACH ROW EXECUTE FUNCTION mem.record_stream_use780();
RESET ROLE;
COMMIT;
