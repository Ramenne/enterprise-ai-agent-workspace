-- REVIEW ONLY: no migration number assigned, never applied to formal instance.
-- Client work capability ceiling is not a qualification or target permission.
DO $reviewed_current_defaults$
DECLARE definition text;before text;pattern text;updated text;
BEGIN
 before:=pg_get_functiondef('authz.authn_session_fence()'::regprocedure);
 IF before NOT LIKE '%||ARRAY[''hufu.qualification.manage''%' THEN RAISE EXCEPTION 'reviewed_primary_default_shape_changed';END IF;
 definition:=replace(before,'||ARRAY[''hufu.qualification.manage''','||ARRAY[''resource.read'',''resource.write'',''resource.deploy'']||ARRAY[''hufu.qualification.manage''');
 EXECUTE definition;
 -- Keep latest reviewed OAuth guards; add work capabilities, then intersect
 -- with its actual originating session client ceiling before issuance.
 before:=pg_get_functiondef('authz.oauth_access_fence()'::regprocedure);
 pattern:='(actions:=CASE WHEN NEW.scopes\?''hub2.work'' THEN ARRAY\[[^]]*\])( ELSE ARRAY\[[^]]*\])( END;)';
 updated:=regexp_replace(before,pattern,E'\\1||ARRAY[''resource.read'',''resource.write'',''resource.deploy'']\\2||ARRAY[''resource.read'']\\3');
 IF updated=before THEN RAISE EXCEPTION 'reviewed_oauth_default_shape_changed';END IF;
 updated:=replace(updated,'INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,''oauth:''',E'actions:=(SELECT COALESCE(array_agg(a ORDER BY a),ARRAY[]::text[]) FROM unnest(actions) a CROSS JOIN authz.clients pc WHERE pc.id=parent.client_id AND a=ANY(pc.actions));\n INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,''oauth:''');
 EXECUTE updated;
END $reviewed_current_defaults$;
-- Existing genuine live browser primaries only, never API/OAuth/delegated children,
-- copied WeChat fields, client labels or old admin names. Root reviews this backfill.
UPDATE authz.clients c SET actions=(SELECT array_agg(DISTINCT a ORDER BY a) FROM unnest(c.actions||ARRAY['resource.read','resource.write','resource.deploy']) a)
WHERE EXISTS(SELECT FROM authz.credentials k JOIN authn."session" s ON k.token_hash=encode(public.digest(s.token,'sha256'),'hex') JOIN authz.member_accounts m ON m.authn_user_id=s."userId"
 WHERE k.client_id=c.id AND m.principal_id=c.principal_id AND k.is_primary AND k.authority_source IN('authn_session','wechat_verified_standard_session') AND k.revoked_at IS NULL AND s."expiresAt">clock_timestamp() AND c.active AND EXISTS(SELECT FROM authz.principals p WHERE p.id=c.principal_id AND p.active) AND authz.family_valid(k.id));
