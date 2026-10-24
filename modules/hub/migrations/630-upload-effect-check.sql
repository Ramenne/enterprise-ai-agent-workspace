-- Additive pre-provider upload check. Resource admission is not authority.
-- Uses existing mem.upload current actor/client/source/writer guard; unknown source stays existing ABI.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.upload_effect_check(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;o mem.operations;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.upload',d,b);
 IF(b->>'project_id')::uuid IS DISTINCT FROM(c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.operations WHERE id=(b->>'operation_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF NOT FOUND OR o.state IS DISTINCT FROM 'verifying'OR o.attempt IS DISTINCT FROM(b->>'attempt')::bigint OR o.fencing_token IS DISTINCT FROM(b->>'fencing_token')::uuid OR o.lease_until IS NULL OR o.lease_until<=clock_timestamp()THEN RAISE EXCEPTION 'verification_current_fence_changed' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','effect_allowed','operation_id',o.id,'attempt',o.attempt,'fencing_token',o.fencing_token,'lease_until',o.lease_until,'provider_effect','not_asserted');
END $$;
REVOKE ALL ON FUNCTION mem.upload_effect_check(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.upload_effect_check(uuid,text,text)TO hub2_mem;
RESET ROLE;
