SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.employeeclient_member_balance(proof text,target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $fn$
DECLARE i jsonb; actor uuid; org uuid; balance bigint; qn constant uuid:='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.board_identity(proof,false,false);actor:=(i->>'actor_id')::uuid;org:=(i->>'organization_id')::uuid;
 IF NOT authz.can_read(actor,qn) OR NOT authz.can_read(target,qn) THEN RAISE EXCEPTION 'member_balance_forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.board_member(org,target);
 SELECT debt_cents INTO balance FROM v8.points_accounts WHERE organization_id=org AND member_id=target;
 RETURN jsonb_build_object('member_id',target,'balance_points',coalesce(balance,0)/100.0,'unit','point;1 point=1 CNY');
END $fn$;
REVOKE ALL ON FUNCTION v8.employeeclient_member_balance(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.employeeclient_member_balance(text,uuid) TO hub2_v8;
RESET ROLE;
