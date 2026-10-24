-- Original 2.0 additive candidate. Controller assigns final migration number.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.wechat_standard_entry(state_id uuid PRIMARY KEY REFERENCES authz.wechat_states(id),mode text NOT NULL CHECK(mode IN('login','bind_current_primary')),origin_credential_id uuid REFERENCES authz.credentials,origin_token_hash text,principal_id uuid REFERENCES authz.principals,oauth_query text NOT NULL DEFAULT '',CHECK((mode='login' AND origin_credential_id IS NULL AND origin_token_hash IS NULL AND principal_id IS NULL) OR (mode='bind_current_primary' AND origin_credential_id IS NOT NULL AND origin_token_hash IS NOT NULL AND principal_id IS NOT NULL)));
REVOKE ALL ON authz.wechat_standard_entry FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.wechat_standard_begin(state_hash text,app_id text,mode text,proof text,oauth_query text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;origin uuid;s jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR mode IS NULL OR mode NOT IN('login','bind_current_primary') OR oauth_query IS NULL OR length(oauth_query)>8192 THEN RAISE EXCEPTION 'invalid_wechat_entry' USING ERRCODE='42501';END IF;
 IF mode='bind_current_primary' THEN
  i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
  PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;i:=authz.authenticate(proof);
  IF (i->>'is_primary')::boolean IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.member_accounts WHERE principal_id=actor) THEN RAISE EXCEPTION 'current_primary_member_required' USING ERRCODE='42501';END IF;
  origin:=(i->>'credential_id')::uuid;
 ELSIF proof IS NOT NULL THEN RAISE EXCEPTION 'login_subject_override' USING ERRCODE='42501';END IF;
 s:=authz.wechat_begin(state_hash,app_id,'browser');
 INSERT INTO authz.wechat_standard_entry VALUES((s->>'state_id')::uuid,mode,origin,proof,actor,oauth_query);
 RETURN s;
END $$;
CREATE FUNCTION authz.wechat_standard_finish(claim uuid,app_id text,open_id text,sid text,raw_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE st authz.wechat_states;e authz.wechat_standard_entry;m authz.wechat_members;i jsonb;actor uuid;u authn."user";s authn."session";h text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR claim IS NULL OR COALESCE(app_id,'')='' OR COALESCE(open_id,'')='' OR COALESCE(sid,'')='' OR raw_token IS NULL OR length(raw_token)<32 THEN RAISE EXCEPTION 'invalid_wechat_identity' USING ERRCODE='42501';END IF;
 SELECT * INTO st FROM authz.wechat_states ws WHERE ws.claim_id=claim AND ws.app_id=wechat_standard_finish.app_id;
 SELECT * INTO e FROM authz.wechat_standard_entry WHERE state_id=st.id;
 IF e.state_id IS NULL THEN RAISE EXCEPTION 'standard_wechat_state_required' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM authz.wechat_members wm WHERE wm.app_id=wechat_standard_finish.app_id AND wm.open_id=wechat_standard_finish.open_id;
 actor:=CASE WHEN e.mode='bind_current_primary' THEN e.principal_id ELSE m.principal_id END;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id=m.principal_id ORDER BY id FOR UPDATE;
 SELECT * INTO st FROM authz.wechat_states WHERE id=st.id FOR UPDATE;
 IF st.completed_at IS NOT NULL OR st.claimed_at IS NULL OR st.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'wechat_claim_expired_or_replayed' USING ERRCODE='42501';END IF;
 IF e.mode='bind_current_primary' THEN
  i:=authz.authenticate(e.origin_token_hash);
  IF (i->>'is_primary')::boolean IS DISTINCT FROM true OR (i->>'actor_id')::uuid IS DISTINCT FROM actor OR (i->>'credential_id')::uuid IS DISTINCT FROM e.origin_credential_id THEN RAISE EXCEPTION 'current_primary_member_required' USING ERRCODE='42501';END IF;
  INSERT INTO authz.wechat_members(app_id,open_id,principal_id,provenance) VALUES(app_id,open_id,actor,'current_primary_proof_and_live_wechat_code_exchange') ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO m FROM authz.wechat_members wm WHERE wm.app_id=wechat_standard_finish.app_id AND wm.open_id=wechat_standard_finish.open_id FOR SHARE;
 IF m.principal_id IS DISTINCT FROM actor OR NOT m.active OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active AND kind='member') THEN RAISE EXCEPTION 'wechat_membership_unverified' USING ERRCODE='42501';END IF;
 SELECT usr.* INTO u FROM authn."user" usr JOIN authz.member_accounts ma ON ma.authn_user_id=usr.id WHERE ma.principal_id=actor;
 IF u.id IS NULL THEN RAISE EXCEPTION 'member_account_required' USING ERRCODE='42501';END IF;
 INSERT INTO authn."session"(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES(sid,clock_timestamp()+interval '8 hours',raw_token,clock_timestamp(),clock_timestamp(),u.id) RETURNING * INTO s;
 h:=encode(public.digest(raw_token,'sha256'),'hex');
 UPDATE authz.credentials SET wechat_app_id=app_id,wechat_open_id=open_id,authority_source='wechat_verified_standard_session' WHERE token_hash=h;
 UPDATE authz.wechat_states SET completed_at=clock_timestamp() WHERE id=st.id;
 INSERT INTO evidence.audit(actor_id,domain,action,aggregate_id,details) VALUES(actor,'authz','wechat.standard_session',st.id,jsonb_build_object('trusted_mapping',true,'mode',e.mode));
 RETURN jsonb_build_object('user',to_jsonb(u),'session',to_jsonb(s),'oauth_query',e.oauth_query);
END $$;
REVOKE ALL ON FUNCTION authz.wechat_standard_begin(text,text,text,text,text),authz.wechat_standard_finish(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.wechat_standard_begin(text,text,text,text,text),authz.wechat_standard_finish(uuid,text,text,text,text) TO hub2_hufu;
RESET ROLE;
