-- Original capture signature unchanged; bind parameters rather than identically named columns.
SET ROLE hub2_authz_owner;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('authz.capture_hufu_usage(text,uuid,text)'::regprocedure);
 definition:=replace(definition,'DECLARE i jsonb;r authz.hufu_usage_contexts;',E'#variable_conflict use_variable\nDECLARE i jsonb;r authz.hufu_usage_contexts;');
 EXECUTE definition;
END $$;
RESET ROLE;
