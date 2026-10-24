BEGIN;
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION vault2.delivery_close(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;d vault2.delivery_items;owner_org uuid;result jsonb;
BEGIN
 i:=vault2.delivery_request_identity(proof);
 IF NOT vault2.delivery_request_manager(i) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM vault2.delivery_items WHERE id=(b->>'item_id')::uuid FOR UPDATE;
 SELECT organization_id INTO owner_org FROM authz.principals WHERE id=d.recipient_id;
 IF d.id IS NULL OR owner_org IS DISTINCT FROM (i->>'organization_id')::uuid THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF d.scope?'closed_at' THEN RETURN jsonb_build_object('state','closed','item_id',d.id,'replayed',true);END IF;
 UPDATE vault2.delivery_items SET active=false,scope=scope||jsonb_build_object('closed_at',clock_timestamp(),'closed_by',i->>'actor_id','close_reason',left(coalesce(b->>'reason','主管关闭后续取用'),2000)) WHERE id=d.id;
 UPDATE vault2.delivery_challenges SET state='revoked' WHERE item_id=d.id AND state IN('pending_send','sent','send_unknown');
 UPDATE vault2.delivery_tickets SET state='revoked' WHERE item_id=d.id AND state='ready';
 INSERT INTO vault2.delivery_audit(item_id,actor_id,event) VALUES(d.id,(i->>'actor_id')::uuid,'closed');
 RETURN jsonb_build_object('state','closed','item_id',d.id,'future_claims_stopped',true,'already_delivered_bytes','not_recalled','secret_history_preserved',true);
END $$;
REVOKE ALL ON FUNCTION vault2.delivery_close(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.delivery_close(text,jsonb) TO hub2_hufu;
DO $m$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('vault2.delivery_register_prepare(text,jsonb)'::regprocedure);
 IF position('manual_close_protected' IN s)=0 THEN
  s:=replace(s,'IF d.id IS NULL THEN','IF d.scope?''closed_at'' THEN RETURN jsonb_build_object(''state'',''closed'',''item_id'',d.id,''reason'',''manual_close_protected'');END IF; IF d.id IS NULL THEN');
  IF position('manual_close_protected' IN s)=0 THEN RAISE EXCEPTION 'prepare_patch_missing';END IF;EXECUTE s;
 END IF;
 s:=pg_get_functiondef('vault2.delivery_register_finish(text,jsonb)'::regprocedure);
 IF position('delivery_item_closed' IN s)=0 THEN
  s:=replace(s,'UPDATE vault2.delivery_items SET secret_version=', 'IF d.scope?''closed_at'' THEN RAISE EXCEPTION ''delivery_item_closed'' USING ERRCODE=''42501'';END IF; UPDATE vault2.delivery_items SET secret_version=');
  IF position('delivery_item_closed' IN s)=0 THEN RAISE EXCEPTION 'finish_patch_missing';END IF;EXECUTE s;
 END IF;
END $m$;
RESET ROLE;
COMMIT;

