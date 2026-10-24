-- Root assigns final migration number. Requires current 450 + 580 contracts.
-- No content/material/version rewrite, no automatic source deletion.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.storage_tier_operations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,project_id uuid NOT NULL,
 material_id uuid NOT NULL REFERENCES mem.materials,version_id uuid NOT NULL REFERENCES mem.content_versions,
 object_id uuid NOT NULL REFERENCES mem.verified_objects,idempotency_key text NOT NULL,fingerprint text NOT NULL,
 command text NOT NULL CHECK(command IN('archive_copy','restore')),tier text,days integer,retrieval text,
 locator jsonb NOT NULL,target_key text,expected_revision bigint NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','dispatched','unknown','copy_created','restore_requested','restoring','verified')),
 receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,idempotency_key));
CREATE TABLE mem.storage_tier_copies(
 copy_id uuid PRIMARY KEY REFERENCES mem.fixed_object_copies,object_id uuid NOT NULL REFERENCES mem.verified_objects,
 operation_id uuid NOT NULL UNIQUE REFERENCES mem.storage_tier_operations,tier text NOT NULL CHECK(tier IN('archive','deep_archive')),
 target_sha256_verified boolean NOT NULL DEFAULT false,verified_at timestamptz);
REVOKE ALL ON mem.storage_tier_operations,mem.storage_tier_copies FROM PUBLIC,hub2_mem,hub2_worker;

-- A cold copy is retained for GC's exact physical inventory immediately, but 450 must
-- not prefer it as a readable copy until its own fixed GET fullSHA has been verified.
CREATE OR REPLACE FUNCTION mem.fixed_object_locator(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT coalesce((SELECT jsonb_build_object('provider',cp.provider,'bucket',cp.bucket,'key',cp.object_key,'version_id',cp.provider_version_id)
 FROM mem.fixed_object_copies cp WHERE cp.object_id=oid
 AND NOT EXISTS(SELECT FROM mem.storage_tier_copies t WHERE t.copy_id=cp.id AND NOT t.target_sha256_verified)
 AND coalesce((SELECT x.status FROM mem.object_observations x WHERE x.object_id=oid AND x.locator->>'key'=cp.object_key
 AND x.locator->>'version_id'=cp.provider_version_id ORDER BY x.observed_at DESC,x.id DESC LIMIT 1),'verified')NOT IN('not_found','integrity_mismatch')
 ORDER BY cp.created_at DESC,cp.id DESC LIMIT 1),
 (SELECT jsonb_build_object('provider',provider,'bucket',bucket,'key',object_key,'version_id',provider_version_id)FROM mem.verified_objects WHERE id=oid));
$$;

CREATE FUNCTION mem.storage_tier_command(h uuid,d text,payload text)RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;o mem.verified_objects;
 r mem.storage_tier_operations;loc jsonb;rev bigint;event_rev bigint;action text;phase text:=b->>'phase';cp uuid;result jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR coalesce(phase,'') NOT IN('prepare','status','dispatch','report')
 THEN RAISE EXCEPTION 'invalid_tier_request' USING ERRCODE='42501';END IF;
 action:=CASE WHEN b->>'command'='archive_copy'AND phase<>'status' THEN 'mem.write' ELSE 'mem.read' END;
 IF coalesce(b->>'command','')NOT IN('archive_copy','restore')THEN RAISE EXCEPTION 'invalid_tier_command';END IF;
 c:=mem.guard(h,action,d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id
 WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid
 AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');SELECT * INTO o FROM mem.verified_objects WHERE id=v.object_id;
 IF mem.gc_physical_state(o.id)<>'retained' THEN RAISE EXCEPTION 'gc_object_destroying_or_destroyed' USING ERRCODE='55000';END IF;
 INSERT INTO mem.object_storage_state(object_id)VALUES(o.id)ON CONFLICT DO NOTHING;
 SELECT revision INTO rev FROM mem.object_storage_state WHERE object_id=o.id FOR UPDATE;
 IF phase='prepare' THEN
  IF coalesce(b->>'idempotency_key','')='' OR length(b->>'idempotency_key')>200 THEN RAISE EXCEPTION 'invalid_idempotency_key';END IF;
  SELECT * INTO r FROM mem.storage_tier_operations WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key' FOR UPDATE;
  IF r.id IS NOT NULL THEN
   IF r.fingerprint<>d THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
   IF r.state='prepared' THEN UPDATE mem.storage_tier_operations SET expected_revision=rev WHERE id=r.id RETURNING * INTO r;END IF;
  ELSE
   IF b->>'command'='archive_copy'AND coalesce(b->>'tier','')NOT IN('archive','deep_archive')THEN RAISE EXCEPTION 'invalid_tier';END IF;
   IF b->>'command'='restore'AND(coalesce((b->>'days')::integer,0) NOT BETWEEN 1 AND 365 OR coalesce(b->>'retrieval','')NOT IN('Standard','Bulk','Expedited'))THEN RAISE EXCEPTION 'invalid_restore_request';END IF;
   loc:=mem.fixed_object_locator(o.id);
   IF b->>'copy_id'IS NOT NULL THEN
    SELECT jsonb_build_object('provider',p.provider,'bucket',p.bucket,'key',p.object_key,'version_id',p.provider_version_id)
     INTO loc FROM mem.fixed_object_copies p JOIN mem.storage_tier_copies t ON t.copy_id=p.id WHERE p.id=(b->>'copy_id')::uuid AND p.object_id=o.id;
    IF loc IS NULL OR b->>'command'<>'restore' THEN RAISE EXCEPTION 'unregistered_tier_copy';END IF;
   END IF;
   INSERT INTO mem.storage_tier_operations(actor_id,project_id,material_id,version_id,object_id,idempotency_key,fingerprint,command,tier,days,retrieval,locator,expected_revision)
   VALUES((c->>'actor_id')::uuid,(c->>'project_id')::uuid,v.material_id,v.id,o.id,b->>'idempotency_key',d,b->>'command',b->>'tier',(b->>'days')::integer,b->>'retrieval',loc,rev)RETURNING * INTO r;
  END IF;
 ELSE
  SELECT * INTO r FROM mem.storage_tier_operations WHERE id=(b->>'operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid
   AND project_id=(c->>'project_id')::uuid AND material_id=v.material_id AND version_id=v.id FOR UPDATE;
  IF r.id IS NULL OR r.command<>b->>'command' THEN RAISE EXCEPTION 'invalid_tier_operation' USING ERRCODE='42501';END IF;
  IF phase IN('dispatch','report')AND r.fingerprint IS DISTINCT FROM b->>'original_request_hash' THEN RAISE EXCEPTION 'tier_request_changed';END IF;
  IF phase='dispatch' THEN
   IF r.state<>'prepared' THEN RAISE EXCEPTION 'tier_already_dispatched_query_only' USING ERRCODE='40001';END IF;
   IF r.expected_revision<>rev THEN RAISE EXCEPTION 'tier_revision_conflict' USING ERRCODE='40001';END IF;
   IF r.command='archive_copy'AND coalesce(b->>'target_key','')='' THEN RAISE EXCEPTION 'archive_target_key_required';END IF;
   -- Existing gc read lease acquired/renewed by HTTP flow protects this dispatch.
   IF NOT EXISTS(SELECT FROM mem.gc_use_leases l WHERE l.id=(b->>'read_receipt_id')::uuid AND l.object_id=o.id
    AND l.actor_id=r.actor_id AND l.expires_at>clock_timestamp())THEN RAISE EXCEPTION 'tier_live_read_lease_required';END IF;
   PERFORM authz.assert_effect(h);
   UPDATE mem.storage_tier_operations SET state='dispatched',target_key=b->>'target_key',updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
  ELSIF phase='report' THEN
   IF r.state='verified' THEN RETURN r.receipt||jsonb_build_object('operation_id',r.id,'state',r.state);END IF;
   IF b->>'outcome'='no_effect' THEN
    IF r.state<>'dispatched' THEN RAISE EXCEPTION 'invalid_tier_transition';END IF;
    UPDATE mem.storage_tier_operations SET state='prepared',target_key=NULL,expected_revision=rev,updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
   ELSIF b->>'outcome'='unknown' THEN
    IF r.state NOT IN('dispatched','unknown')THEN RAISE EXCEPTION 'invalid_tier_transition';END IF;
    UPDATE mem.storage_tier_operations SET state='unknown',updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
   ELSIF b->>'outcome'='copy_created' THEN
    loc:=b->'receipt'->'locator';
    IF r.command<>'archive_copy' OR r.state NOT IN('dispatched','unknown') OR loc->>'provider'IS DISTINCT FROM r.locator->>'provider'
     OR loc->>'bucket'IS DISTINCT FROM r.locator->>'bucket' OR loc->>'key'IS DISTINCT FROM r.target_key
     OR coalesce(loc->>'version_id','')IN('','null','undefined') OR (b->'receipt'->>'size')::bigint IS DISTINCT FROM o.size
     OR b->'receipt'->>'storage_class'IS DISTINCT FROM (CASE r.tier WHEN 'archive'THEN 'ARCHIVE'ELSE 'DEEP_ARCHIVE'END)
     THEN RAISE EXCEPTION 'invalid_archive_copy_receipt';END IF;
    INSERT INTO mem.fixed_object_copies(object_id,provider,bucket,object_key,provider_version_id,sha256,size)
     VALUES(o.id,loc->>'provider',loc->>'bucket',loc->>'key',loc->>'version_id',o.sha256,o.size)
     ON CONFLICT(object_id,provider,bucket,object_key,provider_version_id)DO UPDATE SET sha256=excluded.sha256 RETURNING id INTO cp;
    INSERT INTO mem.storage_tier_copies(copy_id,object_id,operation_id,tier)VALUES(cp,o.id,r.id,r.tier)ON CONFLICT(copy_id)DO NOTHING;
    result:=jsonb_build_object('copy_id',cp,'physical_tier',r.tier,'target_sha256_verified',false,'standard_source_retained',true);
    UPDATE mem.storage_tier_operations SET state='copy_created',receipt=result,updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
    UPDATE mem.object_storage_state SET revision=revision+1 WHERE object_id=o.id;
   ELSIF b->>'outcome'IN('restore_requested','restoring')THEN
    IF r.command<>'restore' OR r.state NOT IN('prepared','dispatched','unknown','restore_requested','restoring')THEN RAISE EXCEPTION 'invalid_tier_transition';END IF;
    result:=jsonb_build_object('temporary_copy',true,'target_sha256_verified',false);
    UPDATE mem.storage_tier_operations SET state=b->>'outcome',receipt=result,updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
   ELSIF b->>'outcome'='verified' THEN
    IF r.command<>'restore' OR b->'receipt'->>'sha256'IS DISTINCT FROM o.sha256 OR (b->'receipt'->>'size')::bigint IS DISTINCT FROM o.size
     THEN RAISE EXCEPTION 'target_integrity_not_verified';END IF;
    UPDATE mem.storage_tier_copies t SET target_sha256_verified=true,verified_at=clock_timestamp()
     FROM mem.fixed_object_copies p WHERE p.id=t.copy_id AND p.object_id=o.id AND p.object_key=r.locator->>'key'AND p.provider_version_id=r.locator->>'version_id';
    result:=jsonb_build_object('sha256',o.sha256,'size',o.size,'restore_expires_at',b->'receipt'->>'restore_expires_at','temporary_copy',true,'target_sha256_verified',true);
    UPDATE mem.storage_tier_operations SET state='verified',receipt=result,updated_at=clock_timestamp()WHERE id=r.id RETURNING * INTO r;
    UPDATE mem.object_storage_state SET revision=revision+1 WHERE object_id=o.id;
   ELSE RAISE EXCEPTION 'invalid_tier_outcome';END IF;
   PERFORM authz.assert_effect(h);
   UPDATE mem.materials SET event_revision=event_revision+1 WHERE id=v.material_id RETURNING event_revision INTO event_rev;
   PERFORM mem.emit(c,'object.storage_tier.observed',v.material_id,event_rev,r.id,jsonb_build_object('operation_id',r.id,'version_id',v.id,'state',r.state,'receipt',r.receipt));
  END IF;
 END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('operation_id',r.id,'state',r.state,'command',r.command,'locator',r.locator,'tier',r.tier,
  'days',r.days,'retrieval',r.retrieval,'original_request_hash',r.fingerprint,'sha256',o.sha256,'size',o.size,
  'receipt',r.receipt,'target_key',r.target_key,'logical_identity_unchanged',true,'standard_source_retained',true);
END $$;
REVOKE ALL ON FUNCTION mem.storage_tier_command(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_tier_command(uuid,text,text)TO hub2_mem;

-- Unknown provider COPY may have created another physical version. Hold destruction
-- until exact journal reconciliation registers the target; never omit it from GC.
CREATE FUNCTION mem.storage_tier_gc_fence()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF NEW.state<>'open'AND EXISTS(SELECT FROM mem.storage_tier_operations WHERE object_id=NEW.object_id AND state IN('dispatched','unknown'))
 THEN RAISE EXCEPTION 'unreconciled_tier_effect_holds_gc' USING ERRCODE='40001';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mem.storage_tier_gc_fence()FROM PUBLIC;
CREATE TRIGGER storage_tier_gc_fence BEFORE INSERT OR UPDATE ON mem.gc_objects FOR EACH ROW EXECUTE FUNCTION mem.storage_tier_gc_fence();
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields)
 VALUES('mem','storage_tier_operations','ledger','{}','{}'),('mem','storage_tier_copies','mutation',ARRAY['object_id'],'{}');
RESET ROLE;

-- After storage-tiers-candidate.sql. Explicitly preserve archived content availability.
SET ROLE hub2_mem_owner;
ALTER TABLE mem.object_observations DROP CONSTRAINT object_observations_status_check;
ALTER TABLE mem.object_observations ADD CONSTRAINT object_observations_status_check
 CHECK(status IN('verified','not_found','forbidden','timeout','integrity_mismatch','provider_error','restore_required','restoring'));
DO $restore_observation$
DECLARE before text;after text;
BEGIN
 before:=pg_get_functiondef('mem.object_probe_finish(uuid,text,text)'::regprocedure);
 IF position('uncertain boolean:=false;'in before)=0 OR position('ELSIF forbidden THEN desired_availability:=o.availability;'in before)=0
 THEN RAISE EXCEPTION 'availability450_base_changed_review_required';END IF;
 after:=replace(before,'''verified'',''not_found'',''forbidden'',''timeout'',''integrity_mismatch'',''provider_error''',
  '''verified'',''not_found'',''forbidden'',''timeout'',''integrity_mismatch'',''provider_error'',''restore_required'',''restoring''');
 after:=replace(after,'uncertain boolean:=false;','uncertain boolean:=false;cold boolean:=false;');
 after:=replace(after,'forbidden:=forbidden OR x->>''status''=''forbidden'';',
  'cold:=cold OR x->>''status'' IN(''restore_required'',''restoring'');forbidden:=forbidden OR x->>''status''=''forbidden'';');
 after:=replace(after,'ELSIF forbidden THEN desired_availability:=o.availability;',
  'ELSIF forbidden OR cold THEN desired_availability:=o.availability;');
 after:=replace(after,'AND NOT forbidden AND NOT uncertain','AND NOT forbidden AND NOT uncertain AND NOT cold');
 after:=replace(after,'''provider_access_required'',forbidden,','''provider_access_required'',forbidden,''restore_required'',cold,');
 IF after=before THEN RAISE EXCEPTION 'availability450_patch_not_applied';END IF;
 EXECUTE after;
END $restore_observation$;
RESET ROLE;
