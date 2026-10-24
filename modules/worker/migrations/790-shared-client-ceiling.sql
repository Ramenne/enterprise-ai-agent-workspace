BEGIN;
SET ROLE hub2_authz_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('authz.material_share(text,jsonb)'::regprocedure);
 s:=replace(s,'IF command=''received'' THEN','IF command=''received'' THEN
  IF NOT(''mem.read''=ANY(ARRAY(SELECT jsonb_array_elements_text(i->''client_actions''))))THEN RAISE EXCEPTION ''client_action_forbidden'' USING ERRCODE=''42501'';END IF;');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
