BEGIN;
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION vault2.delivery_register_prepare(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$
DECLARE i jsonb;p authz.principals;r authz.principals;d vault2.delivery_items;key text;new_id uuid;expiry timestamptz; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;
 SELECT * INTO r FROM authz.principals WHERE id=(b->>'recipient_id')::uuid;
 IF NOT vault2.delivery_request_manager(i) OR p.role<>'organization_admin' OR r.id IS NULL OR NOT r.active OR r.kind<>'member' OR r.organization_id<>p.organization_id
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 expiry:=(b->>'expires_at')::timestamptz;
 IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'expiry_required' USING ERRCODE='22023'; END IF;
 key:='api:'||(i->>'actor_id')||':'||(b->>'idempotency_key');
 SELECT * INTO d FROM vault2.delivery_items WHERE source=key;
 IF d.id IS NOT NULL THEN
  IF d.recipient_id<>r.id OR d.filename<>b->>'filename' OR (b->>'application_id' IS NOT NULL AND d.request_id IS DISTINCT FROM (b->>'application_id')::uuid) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
  IF d.scope?'closed_at' THEN RETURN jsonb_build_object('state','closed','item_id',d.id,'reason','manual_close_protected');END IF;
  IF d.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('state','expired','item_id',d.id,'reason','original_expiry_preserved');END IF;
  IF d.active THEN RETURN jsonb_build_object('state','ready','item_id',d.id,'replayed',true);END IF;
 END IF;
 IF b->>'application_id' IS NOT NULL THEN
 IF NOT EXISTS(SELECT FROM vault2.delivery_requests WHERE id=(b->>'application_id')::uuid AND applicant_id=r.id AND organization_id=p.organization_id AND state='pending') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 END IF;

 IF d.scope?'closed_at' THEN RETURN jsonb_build_object('state','closed','item_id',d.id,'reason','manual_close_protected');END IF; IF d.id IS NULL THEN
 new_id:=gen_random_uuid();
 INSERT INTO vault2.delivery_items(id,title,recipient_id,secret_ref,secret_version,filename,expires_at,scope,source,active)
 VALUES(new_id,b->>'title',r.id,'bao:hub2/hufu/vault2/operations/'||new_id,1,b->>'filename',expiry,coalesce(b->'scope','{}'::jsonb),key,false) RETURNING * INTO d;
 END IF;
 IF d.recipient_id<>r.id OR d.filename<>b->>'filename' THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 IF b->>'application_id' IS NOT NULL THEN UPDATE vault2.delivery_items SET request_id=(b->>'application_id')::uuid WHERE id=d.id AND NOT active; END IF;
 RETURN jsonb_build_object('item_id',d.id,'state',CASE WHEN d.active THEN 'ready' ELSE 'pending' END,'secret_ref',d.secret_ref);
END $function$


RESET ROLE;
COMMIT;
