SET ROLE hub2_authz_owner;
ALTER TABLE authz.provider_management_registrations DROP CONSTRAINT provider_management_registrations_provider_kind_check;
ALTER TABLE authz.provider_management_registrations ADD CONSTRAINT provider_management_registrations_provider_kind_check CHECK(provider_kind IN('bao_db_lease','fixed_policy_sts','cam_user_key'));
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('authz.provider_management_scope_supported(uuid,jsonb,text[])'::regprocedure);
 definition:=replace(definition,$match$ IF scope?'ttl_seconds'THEN$match$,E' IF r.provider_kind=''cam_user_key'' THEN RETURN scope=''{}''::jsonb AND r.scope_facts->>''target_uin''=''100053416782'' AND r.consumer_ids=ARRAY[''mail-gateway-SES'']::text[];END IF;\n IF scope?''ttl_seconds''THEN');
 EXECUTE definition;
END $$;
RESET ROLE;
