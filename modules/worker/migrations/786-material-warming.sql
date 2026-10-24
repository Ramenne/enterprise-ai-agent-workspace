BEGIN;
SET ROLE hub2_mem_owner;
CREATE TABLE mem.storage_warm_operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,material_id uuid NOT NULL REFERENCES mem.materials,version_id uuid NOT NULL REFERENCES mem.content_versions,object_id uuid NOT NULL REFERENCES mem.verified_objects,actor_id uuid NOT NULL,idempotency_key text NOT NULL,locator jsonb NOT NULL,target_key text,state text NOT NULL DEFAULT 'prepared'CHECK(state IN('prepared','dispatched','unknown','verified')),receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));
REVOKE ALL ON mem.storage_warm_operations FROM PUBLIC,hub2_mem,hub2_worker;
CREATE FUNCTION mem.storage_warm_control(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;o mem.verified_objects;r mem.storage_warm_operations;phase text:=b->>'phase';cp uuid;receipt jsonb;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR coalesce(phase,'')NOT IN('prepare','dispatch','report','unknown')THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.write',d,b);
 SELECT cv.*INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');SELECT *INTO o FROM mem.verified_objects WHERE id=v.object_id;
 IF phase='prepare' THEN
  IF coalesce(b->>'idempotency_key','')=''OR length(b->>'idempotency_key')>170 THEN RAISE EXCEPTION 'idempotency_key_required';END IF;
  INSERT INTO mem.storage_warm_operations(project_id,material_id,version_id,object_id,actor_id,idempotency_key,locator)VALUES((c->>'project_id')::uuid,v.material_id,v.id,o.id,(c->>'actor_id')::uuid,b->>'idempotency_key',mem.fixed_object_locator_for_version(v.id))ON CONFLICT DO NOTHING;
  SELECT *INTO r FROM mem.storage_warm_operations WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key'FOR UPDATE;
  IF r.material_id<>v.material_id OR r.version_id<>v.id THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 ELSE
  SELECT *INTO r FROM mem.storage_warm_operations WHERE id=(b->>'operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid AND version_id=v.id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
  IF phase='dispatch' THEN
   IF r.state<>'prepared'OR coalesce(b->>'target_key','')=''THEN RAISE EXCEPTION 'warm_already_dispatched';END IF;
   IF NOT EXISTS(SELECT FROM mem.gc_use_leases WHERE id=(b->>'read_receipt_id')::uuid AND object_id=o.id AND actor_id=r.actor_id AND expires_at>clock_timestamp())THEN RAISE EXCEPTION 'live_read_lease_required';END IF;
   UPDATE mem.storage_warm_operations SET state='dispatched',target_key=b->>'target_key'WHERE id=r.id RETURNING *INTO r;
  ELSIF phase='unknown' THEN
   UPDATE mem.storage_warm_operations SET state='unknown'WHERE id=r.id AND state='dispatched'RETURNING *INTO r;
  ELSE
   IF r.state<>'verified' THEN
    receipt:=b->'receipt';
    IF r.state NOT IN('dispatched','unknown')OR receipt->>'storage_class'IS DISTINCT FROM 'STANDARD'OR(receipt->>'size')::bigint IS DISTINCT FROM o.size OR receipt->'locator'->>'key'IS DISTINCT FROM r.target_key OR receipt->'locator'->>'bucket'IS DISTINCT FROM r.locator->>'bucket'OR coalesce(receipt->'locator'->>'version_id','')IN('','null','undefined')THEN RAISE EXCEPTION 'invalid_warm_receipt';END IF;
    INSERT INTO mem.fixed_object_copies(object_id,provider,bucket,object_key,provider_version_id,sha256,size)VALUES(o.id,r.locator->>'provider',r.locator->>'bucket',r.target_key,receipt->'locator'->>'version_id',o.sha256,o.size)ON CONFLICT(object_id,provider,bucket,object_key,provider_version_id)DO UPDATE SET sha256=excluded.sha256 RETURNING id INTO cp;
    -- The new registered standard copy becomes the normal locator; no original version identity changes.
    DELETE FROM mem.storage_primary_locations WHERE version_id=v.id;
    UPDATE mem.storage_warm_operations SET state='verified',receipt=jsonb_build_object('copy_id',cp,'primary_tier','standard','source_archive_retained',true,'fixed_identity_unchanged',true)WHERE id=r.id RETURNING *INTO r;
    UPDATE mem.object_storage_state SET revision=revision+1 WHERE object_id=o.id;
   END IF;
  END IF;
 END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state',r.state,'operation_id',r.id,'tier','standard','locator',r.locator,'target_key',r.target_key,'sha256',o.sha256,'size',o.size,'receipt',r.receipt);
END $$;
REVOKE ALL ON FUNCTION mem.storage_warm_control(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_warm_control(uuid,text,text)TO hub2_mem;
CREATE FUNCTION mem.warm_gc_fence()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$BEGIN IF NEW.state<>'open'AND EXISTS(SELECT FROM mem.storage_warm_operations WHERE object_id=NEW.object_id AND state IN('dispatched','unknown'))THEN RAISE EXCEPTION 'warm_copy_pending_holds_gc';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION mem.warm_gc_fence()FROM PUBLIC;
CREATE TRIGGER warm_gc_fence BEFORE INSERT OR UPDATE ON mem.gc_objects FOR EACH ROW EXECUTE FUNCTION mem.warm_gc_fence();
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields)VALUES('mem','storage_warm_operations','ledger','{}','{}'),('mem','material_use_events','ledger','{}','{}');
RESET ROLE;
COMMIT;
