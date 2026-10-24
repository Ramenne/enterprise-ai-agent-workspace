-- Small candidate: standard primary defaults + normal OAuth scope, not a Vault grant.
BEGIN;SET ROLE hub2_authz_owner;
DO $vault_default$DECLARE before text;after text;anchor text;BEGIN
 before:=pg_get_functiondef('authz.authn_session_fence()'::regprocedure);
 anchor:='''member-browser'',ARRAY[';
 IF position(anchor in before)=0 THEN RAISE EXCEPTION 'reviewed_standard_primary_shape_changed';END IF;
 IF position('''hufu.vault.read'''in before)=0 THEN
  after:=replace(before,anchor,'''member-browser'',ARRAY[''hufu.vault.read'',');EXECUTE after;
 END IF;
 before:=pg_get_functiondef('authz.oauth_access_fence()'::regprocedure);
 anchor:='actions:=(SELECT COALESCE(array_agg(a ORDER BY a),ARRAY[]::text[]) FROM unnest(actions) a CROSS JOIN authz.clients pc WHERE pc.id=parent.client_id AND a=ANY(pc.actions));';
 IF position(anchor in before)=0 THEN RAISE EXCEPTION 'reviewed_current_parent_intersection_missing';END IF;
 IF position('''hufu.vault.read'''in before)=0 THEN
  after:=replace(before,anchor,E'IF NEW.scopes?''hub2.read'' OR NEW.scopes?''hub2.work'' THEN actions:=actions||ARRAY[''hufu.vault.read''];END IF;\n'||anchor);EXECUTE after;
 END IF;
END $vault_default$;
-- Only already authenticated genuine standard member-browser parents; never widen old API/operator/OAuth children.
UPDATE authz.clients c SET actions=(SELECT array_agg(DISTINCT a ORDER BY a)FROM unnest(c.actions||ARRAY['hufu.vault.read'])a)
WHERE c.active AND NOT 'hufu.vault.read'=ANY(c.actions)AND EXISTS(
 SELECT FROM authz.credentials k JOIN authn."session"s ON k.token_hash=encode(public.digest(s.token,'sha256'),'hex') JOIN authz.member_accounts m ON m.authn_user_id=s."userId"JOIN authz.principals p ON p.id=m.principal_id
 WHERE k.client_id=c.id AND m.principal_id=c.principal_id AND p.active AND p.kind='member'AND k.is_primary AND k.authority_source IN('authn_session','wechat_verified_standard_session')AND k.revoked_at IS NULL AND s."expiresAt">clock_timestamp()AND authz.family_valid(k.id)
);
RESET ROLE;COMMIT;
