-- Original additive REVIEW candidate; no number assigned, not applied.
-- A client ceiling is not project/area management authority. Do not touch old API profiles.
BEGIN;
SET LOCAL ROLE hub2_authz_owner;
DO $management_entry$
DECLARE before text;updated text;anchor text;
BEGIN
 before:=pg_get_functiondef('authz.authn_session_fence()'::regprocedure);
 anchor:='||ARRAY[''resource.read'',''resource.write'',''resource.deploy'']||ARRAY[''hufu.qualification.manage''';
 IF before NOT LIKE '%'||anchor||'%' OR before LIKE '%''credential.manage''%' THEN RAISE EXCEPTION 'reviewed_primary_default_shape_changed';END IF;
 updated:=replace(before,anchor,'||ARRAY[''resource.read'',''resource.write'',''resource.deploy'',''credential.manage'']||ARRAY[''hufu.qualification.manage''');
 EXECUTE updated;
 before:=pg_get_functiondef('authz.oauth_access_fence()'::regprocedure);
 anchor:='["hub2.read","hub2.work","offline_access"]';
 IF before NOT LIKE '%'||anchor||'%' OR before LIKE '%hub2.credential.manage%' THEN RAISE EXCEPTION 'reviewed_oauth_scope_allowlist_shape_changed';END IF;
 updated:=replace(before,anchor,'["hub2.read","hub2.work","hub2.credential.manage","offline_access"]');
 anchor:='actions:=(SELECT COALESCE(array_agg(a ORDER BY a),ARRAY[]::text[]) FROM unnest(actions) a CROSS JOIN authz.clients pc WHERE pc.id=parent.client_id AND a=ANY(pc.actions));';
 IF updated NOT LIKE '%'||anchor||'%' THEN RAISE EXCEPTION 'reviewed_parent_ceiling_intersection_required';END IF;
 -- Explicit new scope only. Existing read/work scope does not acquire management.
 -- A manage-only OAuth request gets no unsolicited Mem/V8 work capabilities.
 updated:=replace(updated,anchor,E'IF NEW.scopes?''hub2.credential.manage'' THEN\n IF NOT(NEW.scopes?''hub2.read'' OR NEW.scopes?''hub2.work'') THEN actions:=ARRAY[''credential.manage'',''resource.read'']; ELSE actions:=actions||ARRAY[''credential.manage''];END IF;\n END IF;\n'||anchor);
 EXECUTE updated;

 -- Existing self-delegation creates source and receiver qualifications. Return the
 -- exact source ID so withdrawal via existing revoke API does not leave an
 -- invisible effective self scope. No new authority or direct table endpoint.
 before:=pg_get_functiondef('authz.manage(text,text,jsonb,text,text)'::regprocedure);
 anchor:='result:=result||jsonb_build_object(''operation_id'',gen_random_uuid());';
 IF before NOT LIKE '%'||anchor||'%' OR before LIKE '%self_scope_withdrawal_id%' THEN RAISE EXCEPTION 'reviewed_manage_receipt_shape_changed';END IF;
 updated:=replace(before,anchor,E'IF p_command=''management.delegate'' THEN result:=result||jsonb_build_object(''source_qualification_id'',parent.id,''self_scope_withdrawal_id'',CASE WHEN (p_body->>''principal_id'')::uuid=actor THEN parent.id ELSE NULL END);END IF;\n'||anchor);
 EXECUTE updated;
END $management_entry$;
-- Backfill genuine current standard browser primaries only, not operator/API/OAuth children.
UPDATE authz.clients c SET actions=(SELECT array_agg(DISTINCT a ORDER BY a)FROM unnest(c.actions||ARRAY['credential.manage'])a)
WHERE c.active AND EXISTS(
 SELECT FROM authz.credentials k JOIN authn."session"s ON k.token_hash=encode(public.digest(s.token,'sha256'),'hex') JOIN authz.member_accounts m ON m.authn_user_id=s."userId"
 WHERE k.client_id=c.id AND m.principal_id=c.principal_id AND k.is_primary AND k.authority_source IN('authn_session','wechat_verified_standard_session') AND k.revoked_at IS NULL AND s."expiresAt">clock_timestamp() AND authz.family_valid(k.id) AND EXISTS(SELECT FROM authz.principals p WHERE p.id=c.principal_id AND p.active AND p.kind='member')
);
RESET ROLE;
COMMIT;
