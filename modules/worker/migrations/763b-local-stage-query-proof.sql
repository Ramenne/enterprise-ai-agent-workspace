SET ROLE hub2_authz_owner;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('authz.provider_management_receipt(jsonb)'::regprocedure);
 definition:=replace(definition,$match$IF v_receipt->>'outcome'='known_failed'AND s.effect_authorized_at IS NOT NULL THEN$match$,
 $replace$IF v_receipt->>'outcome'='known_failed'AND s.effect_authorized_at IS NOT NULL AND NOT(r.provider_kind='cam_user_key'AND s.kind='stage'AND v_receipt->'provider_effect_sent'='false'::jsonb AND v_receipt->'consumer_local_effect_sent'='false'::jsonb) THEN$replace$);
 EXECUTE definition;
END $$;
RESET ROLE;
