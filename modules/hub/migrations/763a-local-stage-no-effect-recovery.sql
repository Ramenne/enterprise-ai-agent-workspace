SET ROLE hub2_authz_owner;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('authz.provider_management_receipt(jsonb)'::regprocedure);
 definition:=replace(definition,$match$ ELSE UPDATE authz.provider_management_operations SET state=v_receipt->>'outcome'WHERE id=o.id;END IF;$match$,
 $replace$ ELSE UPDATE authz.provider_management_operations SET state=CASE WHEN r.provider_kind='cam_user_key' AND s.kind='stage' AND v_receipt->>'outcome'='known_failed' AND v_receipt->'provider_effect_sent'='false'::jsonb AND v_receipt->'consumer_local_effect_sent'='false'::jsonb THEN 'new_created' ELSE v_receipt->>'outcome' END WHERE id=o.id;END IF;$replace$);
 EXECUTE definition;
END $$;
RESET ROLE;
