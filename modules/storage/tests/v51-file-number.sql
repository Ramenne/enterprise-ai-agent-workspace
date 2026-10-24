BEGIN;
SET ROLE hub2_mem_owner;
DO $$
DECLARE m uuid:=gen_random_uuid();p uuid:=gen_random_uuid();a uuid:=gen_random_uuid();o uuid:=gen_random_uuid();v1 uuid:=gen_random_uuid();v2 uuid:=gen_random_uuid();v3 uuid:=gen_random_uuid();f bigint;n bigint;
BEGIN
 INSERT INTO mem.materials(id,project_id,owner_id,origin_kind,producer)VALUES(m,p,a,'member_submission','synthetic v51 local number fixture')RETURNING file_no INTO f;
 INSERT INTO mem.verified_objects(id,provider,bucket,object_key,provider_version_id,sha256,size,verification_run)VALUES(o,'cos','synthetic-v51','synthetic-v51','synthetic-v51',repeat('a',64),0,gen_random_uuid());
 INSERT INTO mem.content_versions(id,material_id,version_no,object_id,sha256,size,actor_id,reason)OVERRIDING SYSTEM VALUE VALUES(v1,m,1000100,o,repeat('a',64),0,a,'synthetic'),(v2,m,1000900,o,repeat('a',64),0,a,'synthetic');
 IF (SELECT local_no FROM mem.file_version_numbers WHERE version_id=v1)<>1 OR (SELECT local_no FROM mem.file_version_numbers WHERE version_id=v2)<>2 THEN RAISE EXCEPTION 'local_number_used_global_ordinal';END IF;
 IF mem.file_number_locator_internal('F-'||f||'-001')->>'version_id'<>v1::text OR mem.file_number_locator_internal(f::text)->>'material_id'<>m::text OR mem.file_number_locator_internal(v2::text)->>'version_id'<>v2::text THEN RAISE EXCEPTION 'lookup_alias_failed';END IF;
 DELETE FROM mem.content_versions WHERE id=v2;
 UPDATE mem.materials SET state='trashed' WHERE id=m;
 INSERT INTO mem.content_versions(id,material_id,version_no,object_id,sha256,size,actor_id,reason)OVERRIDING SYSTEM VALUE VALUES(v3,m,1000999,o,repeat('a',64),0,a,'synthetic');
 IF (SELECT local_no FROM mem.file_version_numbers WHERE version_id=v3)<>3 OR (SELECT local_no FROM mem.file_version_numbers WHERE version_id=v2)<>2 THEN RAISE EXCEPTION 'delete_archive_reused_number';END IF;
 UPDATE mem.file_version_counters SET last_no=999 WHERE material_id=m;
 INSERT INTO mem.content_versions(id,material_id,version_no,object_id,sha256,size,actor_id,reason)OVERRIDING SYSTEM VALUE VALUES(gen_random_uuid(),m,1001000,o,repeat('a',64),0,a,'synthetic')RETURNING id INTO v3;
 IF mem.file_number_format(f,1000)<>'F-'||f||'-1000' OR (SELECT local_no FROM mem.file_version_numbers WHERE version_id=v3)<>1000 THEN RAISE EXCEPTION 'number_1000_truncated';END IF;
 BEGIN INSERT INTO mem.file_version_numbers(material_id,version_id,local_no,legacy_version_no)VALUES(m,gen_random_uuid(),1,123);RAISE EXCEPTION 'duplicate_local_number_accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 RAISE NOTICE 'PASS local/global separation, current/fixed/UUID/legacy aliases, deletion/archive stability, >999, unique constraints';
END $$;
ROLLBACK;
