-- Original controlled legacy relationship import. No writer handoff/role grant/DNS effect.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.legacy_import_scopes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,actor_id uuid NOT NULL,
 source_system text NOT NULL,visibility text NOT NULL DEFAULT 'actor'CHECK(visibility IN('actor','project')),categories text[] NOT NULL,active boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,source_inventory jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_inventory)='array'),revision bigint NOT NULL DEFAULT 1);
CREATE TABLE mem.legacy_reference_bindings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,actor_id uuid NOT NULL,
 source_system text NOT NULL,visibility text NOT NULL DEFAULT 'actor'CHECK(visibility IN('actor','project')),category text NOT NULL CHECK(category IN('file_alias','plan_versions','code_versions','artifact_addresses','issue_sources','supplement_sources','activity_sources','personal_archive','group_attachment')),
 source_id text NOT NULL,field_path text NOT NULL,original_address text NOT NULL,
 legacy_version bigint,reference_kind text NOT NULL CHECK(reference_kind IN('fixed','latest','unknown','unfinished')),
 target_material_id uuid,target_version_id uuid,target_sha256 text,target_size bigint,
 source_record_sha256 text,original_content_sha256 text,revision bigint NOT NULL DEFAULT 1,
 declaration jsonb NOT NULL DEFAULT '{}',created_client_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,actor_id,source_system,category,source_id,field_path),
 FOREIGN KEY(target_material_id,target_version_id)REFERENCES mem.content_versions(material_id,id),
 CHECK((reference_kind='fixed'AND target_material_id IS NOT NULL AND target_version_id IS NOT NULL AND target_sha256 IS NOT NULL AND target_size IS NOT NULL AND legacy_version>0 AND original_content_sha256=target_sha256)OR(reference_kind='latest'AND target_material_id IS NOT NULL AND target_version_id IS NULL)OR(reference_kind IN('unknown','unfinished')AND target_material_id IS NULL AND target_version_id IS NULL)),
 CHECK(reference_kind='fixed'OR(target_sha256 IS NULL AND target_size IS NULL)));
REVOKE ALL ON mem.legacy_import_scopes,mem.legacy_reference_bindings FROM PUBLIC,hub2_mem,hub2_hufu,hub2_v8,hub2_worker;
CREATE FUNCTION mem.legacy_reference_import(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;old mem.legacy_reference_bindings;r mem.legacy_reference_bindings;scope mem.legacy_import_scopes;v mem.content_versions;item jsonb;result jsonb:='[]';replay jsonb;kind text;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);SELECT * INTO scope FROM mem.legacy_import_scopes WHERE id=(b->>'import_scope_id')::uuid FOR SHARE;
 IF scope.id IS NULL OR scope.active IS DISTINCT FROM true OR scope.expires_at<=clock_timestamp()OR scope.project_id IS DISTINCT FROM(c->>'project_id')::uuid OR scope.actor_id IS DISTINCT FROM(c->>'actor_id')::uuid OR scope.source_system IS DISTINCT FROM b->>'source_system'THEN RAISE EXCEPTION 'legacy_import_scope_required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b->'items')IS DISTINCT FROM'array'OR jsonb_array_length(b->'items')NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_legacy_import_batch';END IF;
 replay:=mem.replay_command(c,'legacy_reference_import',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 -- Serialize creation and CAS in the exact actor/project/import namespace; no global lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(scope.project_id::text||':'||scope.actor_id::text||':'||scope.source_system,0));
 FOR item IN SELECT value FROM jsonb_array_elements(b->'items')LOOP
  kind:=item->>'reference_kind';IF NOT(item->>'category'=ANY(scope.categories))OR kind IS NULL OR kind NOT IN('fixed','latest','unknown','unfinished')OR length(coalesce(item->>'source_id',''))NOT BETWEEN 1 AND 256 OR length(coalesce(item->>'field_path',''))NOT BETWEEN 1 AND 1024 OR length(coalesce(item->>'original_address',''))>8192 THEN RAISE EXCEPTION 'legacy_binding_invalid';END IF;
  SELECT * INTO old FROM mem.legacy_reference_bindings WHERE project_id=scope.project_id AND actor_id=scope.actor_id AND source_system=scope.source_system AND category=item->>'category'AND source_id=item->>'source_id'AND field_path=item->>'field_path'FOR UPDATE;
  IF coalesce(old.revision,0)IS DISTINCT FROM(item->>'expected_revision')::bigint THEN RAISE EXCEPTION 'legacy_mapping_revision_conflict' USING ERRCODE='40001';END IF;
  IF kind='fixed'THEN
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(scope.source_inventory)e WHERE e->>'category'=item->>'category'AND e->>'source_id'=item->>'source_id'AND e->>'field_path'=item->>'field_path'AND e->>'original_address'=item->>'original_address'AND e->>'target_material_id'=item->'fixed_ref'->>'material_id'AND e->>'source_record_sha256'=item->>'source_record_sha256'AND e->>'original_content_sha256'=item->>'original_content_sha256'AND(e->>'legacy_version')::bigint=(item->>'legacy_version')::bigint)THEN RAISE EXCEPTION 'legacy_historical_source_inventory_required' USING ERRCODE='42501';END IF;
   SELECT * INTO v FROM mem.content_versions WHERE id=(item->'fixed_ref'->>'version_id')::uuid AND material_id=(item->'fixed_ref'->>'material_id')::uuid AND sha256=item->'fixed_ref'->>'sha256'AND size=(item->'fixed_ref'->>'size')::bigint;
   IF v.id IS NULL OR NOT EXISTS(SELECT FROM mem.materials WHERE id=v.material_id AND project_id=scope.project_id)OR item->>'original_content_sha256'IS DISTINCT FROM v.sha256 OR(item->>'legacy_version')::bigint IS NULL OR(item->>'legacy_version')::bigint<=0 OR coalesce((item->>'source_record_sha256')~'^[a-f0-9]{64}$',false)IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM jsonb_array_elements(b->'verified_fixed_refs')x WHERE x->>'version_id'=v.id::text AND x->>'sha256'=v.sha256 AND(x->>'size')::bigint=v.size)THEN RAISE EXCEPTION 'legacy_fixed_proof_required' USING ERRCODE='42501';END IF;
   PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),scope.actor_id);
  ELSIF kind='latest'THEN
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(scope.source_inventory)e WHERE e->>'category'=item->>'category'AND e->>'source_id'=item->>'source_id'AND e->>'field_path'=item->>'field_path'AND e->>'original_address'=item->>'original_address'AND e->>'source_record_sha256'=item->>'source_record_sha256'AND e->>'target_material_id'=item->>'material_id')THEN RAISE EXCEPTION 'legacy_latest_identity_inventory_required' USING ERRCODE='42501';END IF;
   SELECT cv.* INTO v FROM mem.materials m JOIN mem.content_versions cv ON cv.id=m.current_version_id WHERE m.id=(item->>'material_id')::uuid AND m.project_id=scope.project_id;
   IF v.id IS NULL THEN RAISE EXCEPTION 'legacy_latest_material_unpublished';END IF;PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),scope.actor_id);
  ELSE IF item?'fixed_ref'OR item?'material_id'THEN RAISE EXCEPTION 'unknown_cannot_be_fixed';END IF;END IF;
  PERFORM authz.assert_effect(h);
  INSERT INTO mem.legacy_reference_bindings(project_id,actor_id,source_system,visibility,category,source_id,field_path,original_address,legacy_version,reference_kind,target_material_id,target_version_id,target_sha256,target_size,source_record_sha256,original_content_sha256,declaration,created_client_id)
  VALUES(scope.project_id,scope.actor_id,scope.source_system,CASE WHEN item->>'category'='personal_archive'THEN'actor'ELSE scope.visibility END,item->>'category',item->>'source_id',item->>'field_path',coalesce(item->>'original_address',''),(item->>'legacy_version')::bigint,kind,CASE WHEN kind IN('fixed','latest')THEN v.material_id END,CASE WHEN kind='fixed'THEN v.id END,CASE WHEN kind='fixed'THEN v.sha256 END,CASE WHEN kind='fixed'THEN v.size END,item->>'source_record_sha256',item->>'original_content_sha256',coalesce(item->'declaration','{}'),(c->>'client_id')::uuid)
  ON CONFLICT(project_id,actor_id,source_system,category,source_id,field_path)DO UPDATE SET visibility=excluded.visibility,original_address=excluded.original_address,legacy_version=excluded.legacy_version,reference_kind=excluded.reference_kind,target_material_id=excluded.target_material_id,target_version_id=excluded.target_version_id,target_sha256=excluded.target_sha256,target_size=excluded.target_size,source_record_sha256=excluded.source_record_sha256,original_content_sha256=excluded.original_content_sha256,declaration=excluded.declaration,revision=mem.legacy_reference_bindings.revision+1,updated_at=clock_timestamp()RETURNING * INTO r;
  result:=result||jsonb_build_array(jsonb_build_object('binding_id',r.id,'revision',r.revision,'reference_kind',kind,'state',CASE WHEN kind='unknown'THEN'needs_mapping'WHEN kind='unfinished'THEN'unfinished'ELSE'bound'END));
 END LOOP;
 IF scope.expires_at<=clock_timestamp()THEN RAISE EXCEPTION 'legacy_import_scope_expired' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);
 RETURN mem.remember_command(c,'legacy_reference_import',b,d,jsonb_build_object('state','imported','items',result,'writer_cutover',false,'GC_registered',true));
END $$;
CREATE FUNCTION mem.legacy_reference_resolve(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.legacy_reference_bindings;v mem.content_versions;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO r FROM mem.legacy_reference_bindings WHERE id=(b->>'binding_id')::uuid AND project_id=(c->>'project_id')::uuid AND(actor_id=(c->>'actor_id')::uuid OR visibility='project');
 IF r.id IS NULL THEN RAISE EXCEPTION 'legacy_binding_not_found' USING ERRCODE='42501';END IF;
 IF r.reference_kind IN('fixed','latest')THEN SELECT cv.* INTO v FROM mem.content_versions cv WHERE cv.material_id=r.target_material_id AND cv.id=CASE WHEN r.reference_kind='fixed'THEN r.target_version_id ELSE(SELECT current_version_id FROM mem.materials WHERE id=r.target_material_id)END;
  IF v.id IS NULL THEN RAISE EXCEPTION 'legacy_binding_unavailable';END IF;PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),(c->>'actor_id')::uuid);
 END IF;PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('binding_id',r.id,'revision',r.revision,'reference_kind',r.reference_kind,'original_address',CASE WHEN r.reference_kind IN('unknown','unfinished')AND r.actor_id IS DISTINCT FROM(c->>'actor_id')::uuid THEN NULL ELSE r.original_address END,'original_address_redacted',r.reference_kind IN('unknown','unfinished')AND r.actor_id IS DISTINCT FROM(c->>'actor_id')::uuid,'state',CASE WHEN r.reference_kind='unknown'THEN'needs_mapping'WHEN r.reference_kind='unfinished'THEN'unfinished'ELSE'available'END,'fixed_ref',CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('project_id',r.project_id,'material_id',v.material_id,'version_id',v.id,'sha256',v.sha256,'size',v.size)END,'selection',CASE WHEN r.reference_kind='latest'THEN'latest_at_request'ELSE r.reference_kind END);
END $$;
-- Typed authoritative GC fact: fixed keeps exact old version; latest keeps only real current head.
DO $$DECLARE def text;marker text:=' -- Dedicated live lease table';BEGIN
 def:=pg_get_functiondef('mem.gc_fact_keys(text,text,jsonb)'::regprocedure);IF position(marker IN def)=0 THEN RAISE EXCEPTION 'legacy_GC_anchor_missing';END IF;
 EXECUTE replace(def,marker,E' IF sch=''mem''AND tbl=''legacy_reference_bindings''THEN IF rowvalue->>''reference_kind''=''fixed''THEN RETURN QUERY SELECT ''version:''||(rowvalue->>''target_version_id'');ELSIF rowvalue->>''reference_kind''=''latest''THEN RETURN QUERY SELECT ''version:''||m.current_version_id::text FROM mem.materials m WHERE m.id=(rowvalue->>''target_material_id'')::uuid AND m.current_version_id IS NOT NULL;END IF;RETURN;END IF;\n'||marker);
END $$;
CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE ON mem.legacy_reference_bindings FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence();
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,shape_hash)VALUES('mem','legacy_reference_bindings','reference',ARRAY['target_version_id','target_material_id'],mem.gc_relation_shape('mem.legacy_reference_bindings'::regclass)),('mem','legacy_import_scopes','ledger','{}',mem.gc_relation_shape('mem.legacy_import_scopes'::regclass));
REVOKE ALL ON FUNCTION mem.legacy_reference_import(uuid,text,text),mem.legacy_reference_resolve(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.legacy_reference_import(uuid,text,text),mem.legacy_reference_resolve(uuid,text,text)TO hub2_mem;
RESET ROLE;
