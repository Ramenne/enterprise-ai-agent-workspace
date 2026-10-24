BEGIN;
SET ROLE hub2_authz_owner;
CREATE TABLE vault2.initial_secret_operations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entry_id uuid NOT NULL REFERENCES vault2.entries,
 actor_id uuid NOT NULL,client_id uuid NOT NULL,idempotency_key text NOT NULL,fingerprint text NOT NULL,
 expected_revision bigint NOT NULL,target_ref text NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','intent','known','unknown','conflict')),
 provider_version bigint,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));
REVOKE ALL ON vault2.initial_secret_operations FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
ALTER TABLE vault2.initial_secret_operations ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION vault2.initial_secret_authority(proof text,e vault2.entries) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;
BEGIN
 i:=authz.vault_current_identity(proof,e.project_id);
 IF e.id IS NULL OR NOT e.active OR NOT vault2.manager(i,e)
 OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,e.project_id,e.id,e.name)
 OR NOT EXISTS(SELECT FROM vault2.legacy_registry WHERE entry_id=e.id AND authority='vault2' AND source_metadata->>'source'='native_entry')
 THEN RAISE EXCEPTION 'native_current_secret_manager_required' USING ERRCODE='42501';END IF;
 IF vault2.high_sensitive(e) AND authz.management_context_valid(i,e.project_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'confirmed_sensitive_custody_manager_required' USING ERRCODE='42501';END IF;
 RETURN i;
END$$;
CREATE FUNCTION vault2.initial_secret_prepare(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE e vault2.entries;i jsonb;o vault2.initial_secret_operations;fp text:=encode(public.digest(b::text,'sha256'),'hex');
BEGIN
 IF b IS NULL OR b-ARRAY['entry_id','expected_revision','idempotency_key','value_fingerprint']<>'{}'::jsonb
 OR coalesce(b->>'value_fingerprint','')!~'^[a-f0-9]{64}$'
 OR coalesce(length(b->>'idempotency_key'),0)NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'initial_secret_input_invalid' USING ERRCODE='22023';END IF;
 SELECT * INTO e FROM vault2.entries WHERE id=(b->>'entry_id')::uuid FOR SHARE;
 i:=vault2.initial_secret_authority(proof,e);
 PERFORM pg_advisory_xact_lock(hashtextextended('initial-secret:'||(i->>'actor_id')||':'||(b->>'idempotency_key'),0));
 SELECT * INTO o FROM vault2.initial_secret_operations WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key' FOR UPDATE;
 IF o.id IS NOT NULL THEN
  IF o.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'initial_secret_idempotency_conflict' USING ERRCODE='23505';END IF;
 ELSE
  IF e.secret_ref IS DISTINCT FROM 'bao:hub2/hufu/vault2/entries/'||e.id
  OR e.revision IS DISTINCT FROM (b->>'expected_revision')::bigint
  THEN RAISE EXCEPTION 'initial_secret_requires_uninitialized_entry_CAS' USING ERRCODE='40001';END IF;
  INSERT INTO vault2.initial_secret_operations(entry_id,actor_id,client_id,idempotency_key,fingerprint,expected_revision,target_ref)
  VALUES(e.id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'idempotency_key',fp,e.revision,'')RETURNING * INTO o;
  UPDATE vault2.initial_secret_operations SET target_ref='bao:hub2/hufu/vault2/operations/'||o.id WHERE id=o.id RETURNING * INTO o;
 END IF;
 RETURN to_jsonb(o)-'fingerprint';
END$$;
CREATE FUNCTION vault2.initial_secret_consume(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE e vault2.entries;i jsonb;o vault2.initial_secret_operations;
BEGIN
 SELECT * INTO o FROM vault2.initial_secret_operations WHERE id=(b->>'operation_id')::uuid FOR UPDATE;
 SELECT * INTO e FROM vault2.entries WHERE id=o.entry_id FOR SHARE;i:=vault2.initial_secret_authority(proof,e);
 IF o.id IS NULL OR o.actor_id IS DISTINCT FROM(i->>'actor_id')::uuid THEN RAISE EXCEPTION 'original_initial_secret_operator_required' USING ERRCODE='42501';END IF;
 IF o.state='prepared' THEN
  IF e.revision<>o.expected_revision OR e.secret_ref IS DISTINCT FROM 'bao:hub2/hufu/vault2/entries/'||e.id THEN RAISE EXCEPTION 'initial_secret_CAS_required' USING ERRCODE='40001';END IF;
  UPDATE vault2.initial_secret_operations SET state='intent'WHERE id=o.id RETURNING * INTO o;
  RETURN to_jsonb(o)||jsonb_build_object('send_authorized',true);
 END IF;
 RETURN to_jsonb(o)||jsonb_build_object('send_authorized',false);
END$$;
CREATE FUNCTION vault2.initial_secret_finish(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE e vault2.entries;i jsonb;o vault2.initial_secret_operations;n bigint;result jsonb;
BEGIN
 SELECT * INTO o FROM vault2.initial_secret_operations WHERE id=(b->>'operation_id')::uuid;
 SELECT * INTO e FROM vault2.entries WHERE id=o.entry_id FOR UPDATE;i:=vault2.initial_secret_authority(proof,e);
 IF o.id IS NULL OR o.actor_id IS DISTINCT FROM(i->>'actor_id')::uuid THEN RAISE EXCEPTION 'original_initial_secret_operator_required' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM vault2.initial_secret_operations WHERE id=o.id FOR UPDATE;
 IF o.state='known'THEN RETURN o.receipt;END IF;
 IF o.state NOT IN('intent','unknown')THEN RAISE EXCEPTION 'initial_secret_operation_state_conflict' USING ERRCODE='40001';END IF;
 IF b->>'outcome'='unknown'THEN UPDATE vault2.initial_secret_operations SET state='unknown'WHERE id=o.id;RETURN jsonb_build_object('state','unknown','operation_id',o.id,'automatic_write_retry',false);END IF;
 n:=(b->>'provider_version')::bigint;
 IF b->>'outcome'IS DISTINCT FROM'known'OR n IS NULL OR n<1 THEN RAISE EXCEPTION 'verified_initial_secret_version_required' USING ERRCODE='22023';END IF;
 IF e.revision<>o.expected_revision OR e.secret_ref IS DISTINCT FROM 'bao:hub2/hufu/vault2/entries/'||e.id THEN
  UPDATE vault2.initial_secret_operations SET state='conflict',provider_version=n WHERE id=o.id;
  RETURN jsonb_build_object('state','conflict','operation_id',o.id,'candidate_private_value_retained',true);
 END IF;
 UPDATE vault2.entries SET secret_ref=o.target_ref||'?version='||n,value_field='value',revision=revision+1 WHERE id=e.id RETURNING * INTO e;
 result:=jsonb_build_object('state','initialized','operation_id',o.id,'entry_id',e.id,'revision',e.revision,'provider_version',n,'member_grant_created',false,'provider_IAM_changed',false);
 UPDATE vault2.initial_secret_operations SET state='known',provider_version=n,receipt=result WHERE id=o.id;
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'secret_initialized',e.id,result);
 RETURN result;
END$$;
CREATE FUNCTION vault2.initial_secret_status(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE e vault2.entries;i jsonb;o vault2.initial_secret_operations;
BEGIN
 SELECT * INTO o FROM vault2.initial_secret_operations WHERE id=(b->>'operation_id')::uuid;
 SELECT * INTO e FROM vault2.entries WHERE id=o.entry_id;
 i:=vault2.initial_secret_authority(proof,e);
 IF o.id IS NULL OR o.actor_id IS DISTINCT FROM(i->>'actor_id')::uuid THEN RAISE EXCEPTION 'original_initial_secret_operator_required' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(o)-'fingerprint';
END$$;
REVOKE ALL ON FUNCTION vault2.initial_secret_authority(text,vault2.entries),vault2.initial_secret_prepare(text,jsonb),vault2.initial_secret_consume(text,jsonb),vault2.initial_secret_finish(text,jsonb),vault2.initial_secret_status(text,jsonb) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION vault2.initial_secret_prepare(text,jsonb),vault2.initial_secret_consume(text,jsonb),vault2.initial_secret_finish(text,jsonb),vault2.initial_secret_status(text,jsonb)TO hub2_hufu;
RESET ROLE;
COMMIT;
