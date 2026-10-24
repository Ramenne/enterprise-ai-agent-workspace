-- REVIEW CANDIDATE: Root assigns final number. No canonical content identity rewrite.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.fixed_object_copies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_id uuid NOT NULL,provider text NOT NULL,bucket text NOT NULL,object_key text NOT NULL,provider_version_id text NOT NULL CHECK(provider_version_id NOT IN('','null','undefined')),sha256 text NOT NULL,size bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(object_id,provider,bucket,object_key,provider_version_id),FOREIGN KEY(object_id,sha256,size)REFERENCES mem.verified_objects(id,sha256,size));
CREATE TABLE mem.object_storage_state(object_id uuid PRIMARY KEY REFERENCES mem.verified_objects,revision bigint NOT NULL DEFAULT 1);
CREATE TABLE mem.object_probe_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,object_id uuid NOT NULL REFERENCES mem.verified_objects,version_id uuid NOT NULL REFERENCES mem.content_versions,idempotency_key text NOT NULL,fingerprint text NOT NULL,command text NOT NULL CHECK(command IN('probe','import_copy')),expected_revision bigint NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','committed')),judgment jsonb NOT NULL DEFAULT '{}',source_ref jsonb,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));
CREATE TABLE mem.object_observations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES mem.object_probe_runs,object_id uuid NOT NULL REFERENCES mem.verified_objects,locator jsonb NOT NULL,status text NOT NULL CHECK(status IN('verified','not_found','forbidden','timeout','integrity_mismatch','provider_error')),observed_hash text,observed_size bigint,provider_code text,observed_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON mem.fixed_object_copies,mem.object_storage_state,mem.object_probe_runs,mem.object_observations FROM PUBLIC,hub2_mem,hub2_worker;
CREATE FUNCTION mem.fixed_object_locator(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT coalesce((SELECT jsonb_build_object('provider',provider,'bucket',bucket,'key',object_key,'version_id',provider_version_id) FROM mem.fixed_object_copies cp WHERE object_id=oid AND coalesce((SELECT x.status FROM mem.object_observations x WHERE x.object_id=oid AND x.locator->>'key'=cp.object_key AND x.locator->>'version_id'=cp.provider_version_id ORDER BY x.observed_at DESC,x.id DESC LIMIT 1),'verified')NOT IN('not_found','integrity_mismatch') ORDER BY created_at DESC,id DESC LIMIT 1),(SELECT jsonb_build_object('provider',provider,'bucket',bucket,'key',object_key,'version_id',provider_version_id) FROM mem.verified_objects WHERE id=oid));
$$;
CREATE FUNCTION mem.object_probe_prepare(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;o mem.verified_objects;r mem.object_probe_runs;rev bigint;a text;source_version mem.content_versions;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR b->>'command' NOT IN('probe','import_copy') OR coalesce(b->>'idempotency_key','')='' THEN RAISE EXCEPTION 'invalid_probe_request' USING ERRCODE='42501';END IF;
 a:=CASE WHEN b->>'command'='import_copy' THEN 'mem.write' ELSE 'mem.read' END;c:=mem.guard(h,a,d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 IF b->'source_ref'IS NOT NULL THEN
  SELECT cv.* INTO source_version FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->'source_ref'->>'version_id')::uuid AND cv.material_id=(b->'source_ref'->>'material_id')::uuid AND m.project_id=(b->'source_ref'->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
  IF source_version.id IS NULL THEN RAISE EXCEPTION 'source_fixed_ref_forbidden' USING ERRCODE='42501';END IF;PERFORM mem.assert_version_sources(h,source_version.id,'mem.read');
 END IF;
 SELECT * INTO o FROM mem.verified_objects WHERE id=v.object_id;INSERT INTO mem.object_storage_state(object_id)VALUES(o.id)ON CONFLICT DO NOTHING;SELECT revision INTO rev FROM mem.object_storage_state WHERE object_id=o.id;
 SELECT * INTO r FROM mem.object_probe_runs WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key' FOR UPDATE;
 IF r.id IS NOT NULL THEN IF r.fingerprint<>d THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;IF r.state='committed' THEN PERFORM authz.assert_effect(h);RETURN r.result||jsonb_build_object('replayed',true);END IF;UPDATE mem.object_probe_runs SET expected_revision=rev WHERE id=r.id RETURNING * INTO r;
 ELSE INSERT INTO mem.object_probe_runs(actor_id,object_id,version_id,idempotency_key,fingerprint,command,expected_revision,judgment,source_ref)VALUES((c->>'actor_id')::uuid,o.id,v.id,b->>'idempotency_key',d,b->>'command',rev,coalesce(b->'judgment','{}'),b->'source_ref') RETURNING * INTO r;END IF;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('operation_id',r.id,'state','prepared','object_id',o.id,'storage_revision',rev,'sha256',o.sha256,'size',o.size,'availability',o.availability,'locators',jsonb_build_array(jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'version_id',o.provider_version_id))||coalesce((SELECT jsonb_agg(jsonb_build_object('provider',provider,'bucket',bucket,'key',object_key,'version_id',provider_version_id))FROM mem.fixed_object_copies WHERE object_id=o.id),'[]'));
END $$;
CREATE FUNCTION mem.object_probe_finish(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.object_probe_runs;o mem.verified_objects;x jsonb;revision bigint;desired_availability text;valid boolean:=false;forbidden boolean:=false;uncertain boolean:=false;receipt jsonb;a text;material mem.materials;source_version mem.content_versions;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;a:=CASE WHEN b->>'command'='import_copy' THEN 'mem.write' ELSE 'mem.read' END;c:=mem.guard(h,a,d,b);
 SELECT * INTO r FROM mem.object_probe_runs WHERE id=(b->>'operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR r.command<>b->>'command' OR r.fingerprint IS DISTINCT FROM b->>'original_request_hash' OR r.version_id IS DISTINCT FROM (b->>'version_id')::uuid THEN RAISE EXCEPTION 'invalid_probe_run' USING ERRCODE='42501';END IF;IF NOT EXISTS(SELECT FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=r.version_id AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id))THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM mem.assert_version_sources(h,r.version_id,'mem.read');IF r.state='committed' THEN PERFORM authz.assert_effect(h);RETURN r.result;END IF;
 IF r.source_ref IS DISTINCT FROM b->'source_ref' THEN RAISE EXCEPTION 'repair_source_identity_changed' USING ERRCODE='42501';END IF;
 IF r.source_ref IS NOT NULL THEN
  SELECT cv.* INTO source_version FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(r.source_ref->>'version_id')::uuid AND cv.material_id=(r.source_ref->>'material_id')::uuid AND m.project_id=(r.source_ref->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
  IF source_version.id IS NULL THEN RAISE EXCEPTION 'source_fixed_ref_forbidden' USING ERRCODE='42501';END IF;PERFORM mem.assert_version_sources(h,source_version.id,'mem.read');
 END IF;
 SELECT * INTO o FROM mem.verified_objects WHERE id=r.object_id;SELECT s.revision INTO revision FROM mem.object_storage_state s WHERE object_id=o.id FOR UPDATE;IF revision<>r.expected_revision THEN RAISE EXCEPTION 'probe_revision_conflict' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(b->'observations')IS DISTINCT FROM 'array' OR jsonb_array_length(b->'observations')=0 THEN RAISE EXCEPTION 'missing_provider_observation';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'observations') LOOP
  IF x->'locator'->>'provider'<>o.provider OR x->'locator'->>'bucket'<>o.bucket OR coalesce(x->'locator'->>'version_id','') IN('','null','undefined') OR x->>'status' NOT IN('verified','not_found','forbidden','timeout','integrity_mismatch','provider_error') THEN RAISE EXCEPTION 'invalid_provider_observation';END IF;
  IF x->>'status'='verified' THEN IF x->>'sha256'IS DISTINCT FROM o.sha256 OR (x->>'size')::bigint IS DISTINCT FROM o.size THEN RAISE EXCEPTION 'same_hash_size_required';END IF;valid:=true;
   IF r.command='import_copy' THEN INSERT INTO mem.fixed_object_copies(object_id,provider,bucket,object_key,provider_version_id,sha256,size)VALUES(o.id,o.provider,o.bucket,x->'locator'->>'key',x->'locator'->>'version_id',o.sha256,o.size)ON CONFLICT DO NOTHING;END IF;
  END IF;forbidden:=forbidden OR x->>'status'='forbidden';uncertain:=uncertain OR x->>'status' IN('timeout','provider_error');
  INSERT INTO mem.object_observations(run_id,object_id,locator,status,observed_hash,observed_size,provider_code)VALUES(r.id,o.id,x->'locator',x->>'status',x->>'sha256',(x->>'size')::bigint,x->>'provider_code');
 END LOOP;
 IF r.command='import_copy' AND NOT valid THEN desired_availability:=o.availability;
 ELSIF valid THEN desired_availability:='available';ELSIF forbidden THEN desired_availability:=o.availability;ELSIF uncertain THEN desired_availability:='suspect';ELSE desired_availability:='unavailable';END IF;
 IF r.command='probe' AND NOT valid AND NOT forbidden AND NOT uncertain AND jsonb_array_length(b->'observations')<>(SELECT 1+count(*) FROM mem.fixed_object_copies WHERE object_id=o.id)THEN RAISE EXCEPTION 'incomplete_probe_cannot_assert_unavailable';END IF;
 PERFORM authz.assert_effect(h);UPDATE mem.verified_objects SET availability=desired_availability WHERE id=o.id;UPDATE mem.object_storage_state SET revision=mem.object_storage_state.revision+1 WHERE object_id=o.id;
 receipt:=jsonb_build_object('operation_id',r.id,'state',CASE WHEN r.command='import_copy' AND valid THEN 'repaired' WHEN r.command='import_copy' THEN 'copy_rejected' ELSE 'observed' END,'version_id',r.version_id,'object_id',o.id,'sha256',o.sha256,'size',o.size,'availability',desired_availability,'provider_access_required',forbidden,'observations',b->'observations','logical_identity_unchanged',true,'unrecoverable_asserted',false);
 UPDATE mem.materials SET event_revision=event_revision+1 WHERE id=(SELECT material_id FROM mem.content_versions WHERE id=r.version_id) RETURNING * INTO material;PERFORM mem.emit(c,'object.availability.observed',material.id,material.event_revision,r.id,receipt);
 UPDATE mem.object_probe_runs SET state='committed',result=receipt WHERE id=r.id;PERFORM authz.assert_effect(h);RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION mem.fixed_object_locator(uuid),mem.object_probe_prepare(uuid,text,text),mem.object_probe_finish(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.object_probe_prepare(uuid,text,text),mem.object_probe_finish(uuid,text,text)TO hub2_mem;
DO $fixed_read_locator$ DECLARE signature text;before text;after text;needle text:='jsonb_build_object(''provider'',v.provider,''bucket'',v.bucket,''key'',v.object_key,''version_id'',v.provider_version_id)';BEGIN FOREACH signature IN ARRAY ARRAY['mem.read_version(uuid,text,text)','mem.read_range(uuid,text,text)']LOOP before:=pg_get_functiondef(signature::regprocedure);after:=replace(before,needle,'mem.fixed_object_locator(v.object_id)');IF after=before THEN RAISE EXCEPTION 'fixed_locator_base_changed';END IF;EXECUTE after;END LOOP;END $fixed_read_locator$;
RESET ROLE;
SET ROLE hub2_mem_owner;
DO $worker_fixed_copy_locator$
DECLARE before text;after text;needle text:='jsonb_build_object(''provider'',o.provider,''bucket'',o.bucket,''key'',o.object_key,''versionId'',o.provider_version_id)';
BEGIN
 before:=pg_get_functiondef('mem.index_publication_scope(jsonb)'::regprocedure);
 after:=replace(before,needle,'jsonb_set(mem.fixed_object_locator(o.id)-''version_id'',''{versionId}'',mem.fixed_object_locator(o.id)->''version_id'')');
 IF before=after THEN RAISE EXCEPTION 'worker_fixed_locator_base_changed';END IF;EXECUTE after;
END $worker_fixed_copy_locator$;
RESET ROLE;
