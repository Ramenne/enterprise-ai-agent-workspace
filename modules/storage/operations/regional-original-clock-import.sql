BEGIN;
CREATE OR REPLACE FUNCTION mem.regional_register770(b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'mem'
AS $function$
#variable_conflict use_column
DECLARE src jsonb:=b->'source';t jsonb:=b->'target';x jsonb;rowref jsonb;
 actor uuid:=(b->>'operator_actor_id')::uuid;client uuid:=(b->>'operator_client_id')::uuid;
 owner uuid:=(src->>'mapped_owner_actor_id')::uuid;mid uuid;vid uuid;oid uuid;
 m mem.materials;pr v8.projects;v mem.content_versions;obj mem.verified_objects;
 system_name text:='legacy-mengstore-regional770';aliases jsonb:='[]';readers jsonb;
 fid text:=src->>'id';visibility text;project_id uuid;current_ref jsonb;receipt_key text;
 person authz.principals;reader uuid;work_actions text[];rid uuid;created boolean:=false; previous_result jsonb; result jsonb;
BEGIN
 IF session_user<>'postgres' THEN RAISE EXCEPTION 'controlled_operational_ingest_only' USING ERRCODE='42501';END IF;
 IF fid IS NULL OR fid !~ '^[A-Za-z0-9_-]{1,100}$' OR src->>'status'<>'active'
  OR owner IS NULL OR NOT EXISTS(SELECT FROM authz.principals WHERE id=owner AND active)
  OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active)
  OR NOT EXISTS(SELECT FROM authz.clients WHERE id=client AND principal_id=actor AND active)
  OR(jsonb_array_length(coalesce(b->'versions','[]'))<1 AND NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(b->'source_observations','[]'))x WHERE x->>'provider_version_id'='null'AND(x->>'legacy_version')::bigint=(src->>'current_ver')::bigint AND x->>'sha256'=src->>'sha256'AND(x->>'size')::bigint=(src->>'size')::bigint)) THEN RAISE EXCEPTION 'source_owner_or_input_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('regional770:'||fid,0));
 receipt_key:='regional770:'||fid||':'||(b->>'source_snapshot_sha256');
 SELECT r.result INTO previous_result FROM mem.command_receipts r WHERE r.actor_id=actor AND r.action='regional770'AND r.idempotency_key=receipt_key;
 IF previous_result IS NOT NULL THEN RETURN previous_result;END IF;
 SELECT * INTO person FROM authz.principals WHERE id=actor;
 IF EXISTS(SELECT FROM authz.principals WHERE id=owner AND organization_id<>person.organization_id)THEN RAISE EXCEPTION 'source_organization_mismatch';END IF;
 -- Direct stable identity lookup precedes all material creation.
 SELECT target_material_id INTO mid FROM mem.legacy_reference_bindings
  WHERE source_system=system_name AND source_id=fid AND field_path='latest' LIMIT 1;
 IF t IS NOT NULL AND t->>'material_id' IS NOT NULL THEN
  IF mid IS NOT NULL AND mid<>(t->>'material_id')::uuid THEN RAISE EXCEPTION 'stable_material_conflict';END IF;
  mid:=(t->>'material_id')::uuid;
 END IF;
 IF mid IS NULL THEN
  project_id:=(b->>'project_id')::uuid;
  SELECT * INTO pr FROM v8.projects WHERE id=project_id FOR UPDATE;
  IF pr.id IS NULL THEN
   IF src->>'space'='personal' THEN visibility:='personal';
   ELSIF src->>'source_read_subject'='all' THEN visibility:='team';
   ELSIF src->>'source_read_subject'='grant' THEN visibility:='personal';
   ELSE RAISE EXCEPTION 'source_scope_mapping_required';END IF;
   INSERT INTO v8.projects(id,organization_id,kind,visibility,owner_id,manager_id,title)
    VALUES(project_id,person.organization_id,'project',visibility,
     CASE WHEN src->>'space'='personal' THEN owner ELSE actor END,
     CASE WHEN src->>'space'='personal' THEN owner ELSE actor END,b->>'project_title') RETURNING * INTO pr;
   created:=true;
  END IF;
  IF src->>'space'='personal' AND (pr.visibility<>'personal' OR pr.owner_id<>owner)THEN RAISE EXCEPTION 'private_source_target_mismatch';END IF;
  IF src->>'source_read_subject'='grant' AND pr.visibility<>'personal' THEN RAISE EXCEPTION 'restricted_source_target_mismatch';END IF;
  -- Work grants are limited to this imported storage compartment; no client or role expansion.
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(src->'access_actors','[]')) LOOP
   reader:=(x->>'principal_id')::uuid;
   IF NOT EXISTS(SELECT FROM authz.principals WHERE id=reader AND active AND organization_id=pr.organization_id)THEN CONTINUE;END IF;
   work_actions:=ARRAY['mem.read','mem.discover','mem.read_history','v8.project.read'];
   IF x->>'write'='true' THEN work_actions:=work_actions||ARRAY['mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct'];END IF;
   IF reader<>pr.owner_id AND NOT EXISTS(SELECT FROM authz.qualifications WHERE principal_id=reader AND project_id=pr.id AND kind='work' AND active AND actions @> work_actions)THEN
    INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,expires_at,until_revoked,source_project_revision)
     VALUES(reader,pr.id,work_actions,pr.manager_id,'work',0,NULL,true,pr.revision);
   END IF;
  END LOOP;
  mid:=(b->>'material_id')::uuid;
  INSERT INTO mem.materials(id,project_id,owner_id,properties,origin_kind,producer)
   VALUES(mid,pr.id,owner,jsonb_build_object('legacy_source_file_id',fid,'legacy_source_space',src->>'space','original_owner_label',src->>'owner','original_owner_basis',src->>'original_owner_basis'),'legacy_import','authorized_regional_copy770') RETURNING * INTO m;
  INSERT INTO mem.placements(material_id,project_id,logical_path)VALUES(mid,pr.id,src->>'path');
  x:=b->'current_object';
  IF x->>'bucket'<>'hub2-data-1316920087' OR x->>'provider_version_id' IS NULL OR x->>'provider_version_id' IN('null','undefined')
   OR x->>'sha256'<>src->>'sha256' OR (x->>'size')::bigint<>(src->>'size')::bigint THEN RAISE EXCEPTION 'current_copy_integrity_required';END IF;
  oid:=(x->>'object_id')::uuid;vid:=(x->>'version_id')::uuid;
  INSERT INTO mem.verified_objects(id,provider,bucket,object_key,provider_version_id,sha256,size,verification_run)
   VALUES(oid,'s3-compatible',x->>'bucket',x->>'key',x->>'provider_version_id',x->>'sha256',(x->>'size')::bigint,oid);
  INSERT INTO mem.content_versions(id,material_id,object_id,sha256,size,actor_id,reason)
   VALUES(vid,mid,oid,x->>'sha256',(x->>'size')::bigint,actor,'actual_verified_current_regional_copy');
  UPDATE mem.materials SET current_version_id=vid,content_revision=1,event_revision=1 WHERE id=mid RETURNING * INTO m;
 ELSE
  SELECT * INTO m FROM mem.materials WHERE id=mid FOR UPDATE;
  SELECT * INTO pr FROM v8.projects WHERE id=m.project_id FOR SHARE;
  IF m.id IS NULL OR m.owner_id<>owner OR pr.organization_id<>person.organization_id THEN RAISE EXCEPTION 'target_owner_or_organization_mismatch';END IF;
  IF src->>'space'='personal' AND (pr.visibility<>'personal' OR pr.owner_id<>owner)THEN RAISE EXCEPTION 'private_source_target_mismatch';END IF;
  IF src->>'source_read_subject'='grant' AND pr.visibility<>'personal' THEN RAISE EXCEPTION 'restricted_source_target_mismatch';END IF;
  IF t IS NOT NULL AND NOT EXISTS(SELECT FROM mem.content_versions WHERE id=(t->>'version_id')::uuid AND material_id=mid AND sha256=t->>'sha256' AND size=(t->>'size')::bigint)THEN RAISE EXCEPTION 'existing_target_fixed_reference_mismatch';END IF;
  IF NOT EXISTS(SELECT FROM mem.legacy_reference_bindings WHERE source_system=system_name AND source_id=fid AND field_path='latest')
   AND m.current_version_id IS DISTINCT FROM (t->>'version_id')::uuid THEN RAISE EXCEPTION 'target_head_changed';END IF;
 END IF;
 visibility:=CASE WHEN src->>'source_read_subject'='owner' THEN 'actor' ELSE 'project' END;
 SELECT * INTO v FROM mem.content_versions WHERE id=m.current_version_id AND material_id=m.id;
 current_ref:=jsonb_build_object('material_id',m.id,'version_id',v.id,'sha256',v.sha256,'size',v.size);
 FOR x IN SELECT value FROM jsonb_array_elements(b->'versions') LOOP
  IF (x->>'ver')::bigint<1 OR x->>'bucket'<>'mengstore-1316920087' OR x->>'provider_version_id' IS NULL OR x->>'provider_version_id' IN('null','undefined')
   OR x->>'sha256'!~'^[a-f0-9]{64}$' OR (x->>'size')::bigint<0 THEN RAISE EXCEPTION 'exact_remote_version_metadata_required';END IF;
  vid:=(x->>'version_id')::uuid;oid:=(x->>'object_id')::uuid;
  SELECT * INTO v FROM mem.content_versions WHERE id=vid;
  IF v.id IS NULL THEN
   INSERT INTO mem.verified_objects(id,provider,bucket,object_key,provider_version_id,sha256,size,verification_run)
    VALUES(oid,'cos-legacy-shanghai',x->>'bucket',x->>'cos_key',x->>'provider_version_id',x->>'sha256',(x->>'size')::bigint,oid)
    ON CONFLICT(provider,bucket,object_key,provider_version_id)DO NOTHING;
   SELECT * INTO obj FROM mem.verified_objects WHERE provider='cos-legacy-shanghai' AND bucket=x->>'bucket' AND object_key=x->>'cos_key' AND provider_version_id=x->>'provider_version_id';
   IF obj.sha256<>x->>'sha256' OR obj.size<>(x->>'size')::bigint THEN RAISE EXCEPTION 'remote_locator_integrity_conflict';END IF;
   INSERT INTO mem.content_versions(id,material_id,object_id,sha256,size,actor_id,reason,created_at)
    VALUES(vid,m.id,obj.id,x->>'sha256',(x->>'size')::bigint,actor,'legacy_ledger_digest_bound_to_actual_COS_fixed_version;bytes_verified_before_each_delivery',coalesce((x->>'created_at')::timestamptz,clock_timestamp()));
  ELSE
   IF v.material_id<>m.id OR v.sha256<>x->>'sha256' OR v.size<>(x->>'size')::bigint THEN RAISE EXCEPTION 'remote_logical_version_conflict';END IF;
  END IF;
  INSERT INTO mem.legacy_reference_bindings(project_id,actor_id,source_system,visibility,category,source_id,field_path,original_address,legacy_version,reference_kind,target_material_id,target_version_id,target_sha256,target_size,source_record_sha256,original_content_sha256,declaration,created_client_id)
   VALUES(pr.id,owner,system_name,visibility,'file_alias',fid,'version:'||(x->>'ver'),'https://mengchu.example.invalid/f/'||fid||'/'||(x->>'ver'),(x->>'ver')::bigint,'fixed',m.id,vid,x->>'sha256',(x->>'size')::bigint,b->>'source_snapshot_sha256',x->>'sha256',jsonb_build_object('source_region','ap-shanghai','source_physical_key',x->>'cos_key','source_provider_version',x->>'provider_version_id','original_owner',src->>'owner','operator_mode','authorized_SSH_root_migration;not_owner_impersonation'),client)
   ON CONFLICT(project_id,actor_id,source_system,category,source_id,field_path)DO NOTHING;
  IF NOT EXISTS(SELECT FROM mem.legacy_reference_bindings WHERE project_id=pr.id AND actor_id=owner AND source_system=system_name AND source_id=fid AND field_path='version:'||(x->>'ver') AND target_material_id=m.id AND target_version_id=vid AND target_sha256=x->>'sha256')THEN RAISE EXCEPTION 'numeric_alias_conflict';END IF;
  aliases:=aliases||jsonb_build_array(jsonb_build_object('file_id',fid,'selection','fixed','legacy_version',(x->>'ver')::bigint,'material_id',m.id,'version_id',vid,'sha256',x->>'sha256','size',(x->>'size')::bigint,'writer_fenced',true));
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(coalesce(b->'source_observations','[]'))obs WHERE obs->>'provider_version_id'='null'AND(obs->>'legacy_version')::bigint=(src->>'current_ver')::bigint)THEN
  IF current_ref->>'sha256'<>src->>'sha256'OR(current_ref->>'size')::bigint<>(src->>'size')::bigint THEN RAISE EXCEPTION 'current_fixed_copy_required_for_null_source';END IF;
  INSERT INTO mem.legacy_reference_bindings(project_id,actor_id,source_system,visibility,category,source_id,field_path,original_address,legacy_version,reference_kind,target_material_id,target_version_id,target_sha256,target_size,source_record_sha256,original_content_sha256,declaration,created_client_id)
   VALUES(pr.id,owner,system_name,visibility,'file_alias',fid,'version:'||(src->>'current_ver'),'https://mengchu.example.invalid/f/'||fid||'/'||(src->>'current_ver'),(src->>'current_ver')::bigint,'fixed',m.id,(current_ref->>'version_id')::uuid,current_ref->>'sha256',(current_ref->>'size')::bigint,b->>'source_snapshot_sha256',current_ref->>'sha256',jsonb_build_object('source_region','ap-shanghai','source_provider_version','null','read_preference','verified_guangzhou_fixed_copy','not_latest',true,'original_owner',src->>'owner'),client)
   ON CONFLICT(project_id,actor_id,source_system,category,source_id,field_path)DO NOTHING;
  aliases:=aliases||jsonb_build_array(jsonb_build_object('file_id',fid,'selection','fixed','legacy_version',(src->>'current_ver')::bigint,'material_id',m.id,'version_id',current_ref->>'version_id','sha256',current_ref->>'sha256','size',(current_ref->>'size')::bigint,'writer_fenced',true));
 END IF;
 INSERT INTO mem.legacy_reference_bindings(project_id,actor_id,source_system,visibility,category,source_id,field_path,original_address,reference_kind,target_material_id,source_record_sha256,declaration,created_client_id)
  VALUES(pr.id,owner,system_name,visibility,'file_alias',fid,'latest','https://mengchu.example.invalid/f/'||fid,'latest',m.id,b->>'source_snapshot_sha256',jsonb_build_object('current_region','ap-guangzhou','history_region','ap-shanghai','source_head_ver',src->'current_ver','original_owner',src->>'owner','operator_mode','authorized_SSH_root_migration'),client)
  ON CONFLICT(project_id,actor_id,source_system,category,source_id,field_path)DO NOTHING;
 aliases:=aliases||jsonb_build_array(jsonb_build_object('file_id',fid,'selection','latest','legacy_version',NULL,'material_id',m.id,'version_id',NULL,'sha256',NULL,'size',NULL,'writer_fenced',true));
 UPDATE mem.materials SET properties=properties||jsonb_build_object('legacy_source_file_id',fid,'legacy_source_space',src->>'space','original_owner_label',src->>'owner','original_owner_basis',src->>'original_owner_basis','current_hash_evidence',src->'current_hash_evidence','legacy_ledger_current_sha256',src->'legacy_ledger_current_sha256','source_provider_observations',coalesce(b->'source_observations','[]'::jsonb)),metadata_revision=metadata_revision+1,event_revision=event_revision+1 WHERE id=m.id RETURNING * INTO m;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,revision,operation_id,details)VALUES(actor,client,'mem','material.legacy_migrated',m.id,m.event_revision,gen_random_uuid(),jsonb_build_object('execution_authority','explicitly_authorized_OS_root_migration','ordinary_handle_claimed',false,'material_id',m.id,'fixed_refs',jsonb_build_array(current_ref),'source_coverage','actual_legacy_ledger_and_provider_heads;on_read_byte_verification'));
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)VALUES('mem',m.id,m.event_revision,'material.legacy_migrated',pr.id,jsonb_build_object('material_id',m.id,'fixed_refs',jsonb_build_array(current_ref),'execution_authority','authorized_operational_import'));

 -- Copying legacy bytes is maintenance, not business access; retain original clocks.
 INSERT INTO mem.storage_source_clocks(version_id,source_system,source_id,original_created_at,original_last_used_at,evidence_sha256,observed_at)
 SELECT cv.id,system_name,fid,mem.storage_source_epoch(src->>'created_at'),mem.storage_source_epoch(src->>'last_access_at'),b->>'source_snapshot_sha256',clock_timestamp()
 FROM mem.content_versions cv WHERE cv.material_id=m.id AND (cv.id=(current_ref->>'version_id')::uuid OR cv.id IN(SELECT (value->>'version_id')::uuid FROM jsonb_array_elements(b->'versions')))
 AND coalesce(mem.storage_source_epoch(src->>'last_access_at'),mem.storage_source_epoch(src->>'created_at')) IS NOT NULL
 ON CONFLICT(version_id)DO UPDATE SET original_created_at=EXCLUDED.original_created_at,original_last_used_at=greatest(mem.storage_source_clocks.original_last_used_at,EXCLUDED.original_last_used_at),evidence_sha256=EXCLUDED.evidence_sha256,observed_at=EXCLUDED.observed_at;
 result:=jsonb_build_object('state','registered','file_id',fid,'project_id',pr.id,'material_id',m.id,'current_fixed_ref',current_ref,'aliases',aliases,'history_versions_registered',jsonb_array_length(b->'versions'),'source_owner_label_preserved',true,'original_owner_verified',coalesce((src->>'original_owner_verified')::boolean,false),'source_snapshot_sha256',b->>'source_snapshot_sha256','project_created',created,'current_region','ap-guangzhou','history_region','ap-shanghai');
 INSERT INTO mem.command_receipts(actor_id,action,idempotency_key,fingerprint,result)VALUES(actor,'regional770',receipt_key,encode(public.digest(b::text,'sha256'),'hex'),result);
 RETURN result;
END $function$;



COMMIT;
