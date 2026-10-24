BEGIN;
SET ROLE hub2_mem_owner;
LOCK TABLE mem.content_versions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE mem.file_version_numbers(material_id uuid NOT NULL,version_id uuid PRIMARY KEY,local_no bigint NOT NULL CHECK(local_no>0),legacy_version_no bigint NOT NULL,assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(material_id,local_no));
CREATE TABLE mem.file_version_counters(material_id uuid PRIMARY KEY,last_no bigint NOT NULL CHECK(last_no>0));
INSERT INTO mem.file_version_numbers(material_id,version_id,local_no,legacy_version_no)
 SELECT material_id,id,row_number() OVER(PARTITION BY material_id ORDER BY version_no,created_at,id),version_no FROM mem.content_versions;
INSERT INTO mem.file_version_counters SELECT material_id,max(local_no)FROM mem.file_version_numbers GROUP BY material_id;
CREATE FUNCTION mem.assign_file_version_number()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE n bigint;
BEGIN
 INSERT INTO mem.file_version_counters(material_id,last_no)VALUES(NEW.material_id,1)
 ON CONFLICT(material_id)DO UPDATE SET last_no=mem.file_version_counters.last_no+1 RETURNING last_no INTO n;
 INSERT INTO mem.file_version_numbers(material_id,version_id,local_no,legacy_version_no)VALUES(NEW.material_id,NEW.id,n,NEW.version_no);
 RETURN NEW;
END $$;
CREATE TRIGGER file_version_number AFTER INSERT ON mem.content_versions FOR EACH ROW EXECUTE FUNCTION mem.assign_file_version_number();
CREATE FUNCTION mem.file_number_format(f bigint,n bigint)RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT 'F-'||f::text||CASE WHEN n IS NULL THEN '' ELSE '-'||repeat('0',greatest(0,3-length(n::text)))||n::text END$$;
CREATE FUNCTION mem.file_number_locator_internal(no text)RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT jsonb_build_object('material_id',m.id,'project_id',m.project_id,'version_id',CASE WHEN no~'^F-[0-9]+-[0-9]+$' OR no=v.id::text THEN v.id ELSE NULL END)
 FROM mem.materials m LEFT JOIN mem.content_versions v ON v.material_id=m.id LEFT JOIN mem.file_version_numbers n ON n.version_id=v.id
 WHERE (no~'^F-[0-9]+-[0-9]+$' AND split_part(no,'-',2)=m.file_no::text AND split_part(no,'-',3)::numeric=n.local_no)
 OR (no~'^F-[0-9]+$' AND substring(no from 3)=m.file_no::text)
 OR (no~'^#?[0-9]+$' AND ltrim(no,'#')=m.file_no::text)
 OR no=m.id::text OR no=v.id::text LIMIT 1
$$;
CREATE FUNCTION mem.file_number_head(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;m mem.materials;v mem.content_versions;n bigint;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
 SELECT * INTO v FROM mem.content_versions WHERE material_id=m.id AND id=coalesce((b->>'version_id')::uuid,m.current_version_id);
 IF m.id IS NULL OR v.id IS NULL OR NOT mem.version_visible((c->>'actor_id')::uuid,v.id) OR NOT authz.can_read_resource((c->>'actor_id')::uuid,m.project_id,jsonb_build_object('project_id',m.project_id,'material_id',m.id)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT local_no INTO n FROM mem.file_version_numbers WHERE version_id=v.id;
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',jsonb_build_array(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',v.id,'sha256',v.sha256))),(c->>'actor_id')::uuid,'mem.read');PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','found','project_id',m.project_id,'material_id',m.id,'file_no',m.file_no::text,'display_no',mem.file_number_format(m.file_no,n),'file_display_no',mem.file_number_format(m.file_no,NULL),'local_version_no',n::text,'legacy_version_no',v.version_no::text,'material_state',m.state,'selection',CASE WHEN b->>'version_id'IS NULL THEN 'current_version'ELSE 'fixed_version'END,'fixed_ref',jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',v.id,'sha256',v.sha256,'size',v.size));
END $$;
CREATE FUNCTION mem.file_number_decorate(b jsonb)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE r jsonb:='{}';k text;x jsonb;f bigint;n bigint;
BEGIN
 IF jsonb_typeof(b)='array' THEN SELECT coalesce(jsonb_agg(mem.file_number_decorate(value)),'[]')INTO r FROM jsonb_array_elements(b);RETURN r;END IF;
 IF jsonb_typeof(b)<>'object' THEN RETURN b;END IF;
 FOR k,x IN SELECT * FROM jsonb_each(b) LOOP r:=r||jsonb_build_object(k,mem.file_number_decorate(x));END LOOP;
 IF b->>'material_id'~'^[0-9a-f-]{36}$' THEN
 SELECT file_no INTO f FROM mem.materials WHERE id=(b->>'material_id')::uuid;
 IF f IS NOT NULL THEN
 SELECT local_no INTO n FROM mem.file_version_numbers WHERE material_id=(b->>'material_id')::uuid AND version_id::text=b->>'version_id';
 r:=r||jsonb_build_object('file_no',f::text,'file_display_no',mem.file_number_format(f,NULL));
 IF n IS NOT NULL THEN r:=r||jsonb_build_object('display_no',mem.file_number_format(f,n),'local_version_no',n::text);END IF;
 END IF;END IF;RETURN r;
END $$;
REVOKE ALL ON mem.file_version_numbers,mem.file_version_counters FROM PUBLIC;
REVOKE ALL ON FUNCTION mem.assign_file_version_number(),mem.file_number_format(bigint,bigint),mem.file_number_locator_internal(text),mem.file_number_head(uuid,text,text),mem.file_number_decorate(jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.file_number_locator_internal(text),mem.file_number_head(uuid,text,text),mem.file_number_decorate(jsonb)TO hub2_mem;
RESET ROLE;
COMMIT;
