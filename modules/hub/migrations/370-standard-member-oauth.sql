-- Derived from pinned official getSchema; opaque OAuth only, no second issuer.
SET ROLE hub2_authz_owner;
CREATE TABLE authn."oauthClient"(id text PRIMARY KEY,"clientId" text NOT NULL UNIQUE,"clientSecret" text,"clientDiscoveryId" text,"disabled" boolean,"skipConsent" boolean,"enableEndSession" boolean,"subjectType" text,"scopes" jsonb,"clientCredentialsScopes" jsonb,"userId" text REFERENCES authn."user"("id"),"createdAt" timestamptz,"updatedAt" timestamptz,"name" text,"uri" text,"icon" text,"contacts" jsonb,"tos" text,"policy" text,"softwareId" text,"softwareVersion" text,"softwareStatement" text,"redirectUris" jsonb NOT NULL,"postLogoutRedirectUris" jsonb,"backchannelLogoutUri" text,"backchannelLogoutSessionRequired" boolean,"tokenEndpointAuthMethod" text,"applicationType" text,"jwks" text,"jwksUri" text,"grantTypes" jsonb,"responseTypes" jsonb,"requirePKCE" boolean,"dpopBoundAccessTokens" boolean,"referenceId" text,"metadata" jsonb);
CREATE INDEX "authn_oauthClient_userId" ON authn."oauthClient"("userId");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthClient" TO hub2_hufu;
CREATE TABLE authn."oauthResource"(id text PRIMARY KEY,"identifier" text NOT NULL UNIQUE,"name" text NOT NULL,"accessTokenTtl" bigint,"refreshTokenTtl" bigint,"signingAlgorithm" text,"signingKeyId" text,"allowedScopes" jsonb,"customClaims" jsonb,"dpopBoundAccessTokensRequired" boolean,"disabled" boolean,"createdAt" timestamptz,"updatedAt" timestamptz,"policyVersion" bigint,"metadata" jsonb);
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthResource" TO hub2_hufu;
CREATE TABLE authn."oauthClientResource"(id text PRIMARY KEY,"clientId" text NOT NULL REFERENCES authn."oauthClient"("clientId") ON DELETE CASCADE,"resourceId" text NOT NULL REFERENCES authn."oauthResource"("identifier") ON DELETE CASCADE,"metadata" jsonb,"createdAt" timestamptz);
CREATE INDEX "authn_oauthClientResource_clientId" ON authn."oauthClientResource"("clientId");
CREATE INDEX "authn_oauthClientResource_resourceId" ON authn."oauthClientResource"("resourceId");
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON authn."oauthClientResource"("clientId","resourceId");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthClientResource" TO hub2_hufu;
CREATE TABLE authn."oauthRefreshToken"(id text PRIMARY KEY,"token" text NOT NULL UNIQUE,"clientId" text NOT NULL REFERENCES authn."oauthClient"("clientId"),"sessionId" text REFERENCES authn."session"("id") ON DELETE SET NULL,"userId" text NOT NULL REFERENCES authn."user"("id"),"referenceId" text,"authorizationCodeId" text,"resources" jsonb,"requestedUserInfoClaims" jsonb,"expiresAt" timestamptz,"createdAt" timestamptz,"revoked" timestamptz,"rotatedAt" timestamptz,"rotationReplayResponse" text,"rotationReplayExpiresAt" timestamptz,"authTime" timestamptz,"confirmation" jsonb,"scopes" jsonb NOT NULL);
CREATE INDEX "authn_oauthRefreshToken_clientId" ON authn."oauthRefreshToken"("clientId");
CREATE INDEX "authn_oauthRefreshToken_sessionId" ON authn."oauthRefreshToken"("sessionId");
CREATE INDEX "authn_oauthRefreshToken_userId" ON authn."oauthRefreshToken"("userId");
CREATE INDEX "authn_oauthRefreshToken_authorizationCodeId" ON authn."oauthRefreshToken"("authorizationCodeId");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthRefreshToken" TO hub2_hufu;
CREATE TABLE authn."oauthAccessToken"(id text PRIMARY KEY,"token" text UNIQUE,"clientId" text NOT NULL REFERENCES authn."oauthClient"("clientId"),"sessionId" text REFERENCES authn."session"("id") ON DELETE SET NULL,"userId" text REFERENCES authn."user"("id"),"referenceId" text,"authorizationCodeId" text,"resources" jsonb,"requestedUserInfoClaims" jsonb,"refreshId" text REFERENCES authn."oauthRefreshToken"("id"),"expiresAt" timestamptz,"createdAt" timestamptz,"revoked" timestamptz,"confirmation" jsonb,"scopes" jsonb NOT NULL);
CREATE INDEX "authn_oauthAccessToken_clientId" ON authn."oauthAccessToken"("clientId");
CREATE INDEX "authn_oauthAccessToken_sessionId" ON authn."oauthAccessToken"("sessionId");
CREATE INDEX "authn_oauthAccessToken_userId" ON authn."oauthAccessToken"("userId");
CREATE INDEX "authn_oauthAccessToken_authorizationCodeId" ON authn."oauthAccessToken"("authorizationCodeId");
CREATE INDEX "authn_oauthAccessToken_refreshId" ON authn."oauthAccessToken"("refreshId");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthAccessToken" TO hub2_hufu;
CREATE TABLE authn."oauthConsent"(id text PRIMARY KEY,"clientId" text NOT NULL REFERENCES authn."oauthClient"("clientId"),"userId" text REFERENCES authn."user"("id"),"referenceId" text,"resources" jsonb,"requestedUserInfoClaims" jsonb,"scopes" jsonb NOT NULL,"createdAt" timestamptz,"updatedAt" timestamptz);
CREATE INDEX "authn_oauthConsent_clientId" ON authn."oauthConsent"("clientId");
CREATE INDEX "authn_oauthConsent_userId" ON authn."oauthConsent"("userId");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthConsent" TO hub2_hufu;
CREATE TABLE authn."oauthClientAssertion"(id text PRIMARY KEY,"expiresAt" timestamptz NOT NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."oauthClientAssertion" TO hub2_hufu;
CREATE TABLE authn."passkey"(id text PRIMARY KEY,"name" text,"publicKey" text NOT NULL,"userId" text NOT NULL REFERENCES authn."user"("id"),"credentialID" text NOT NULL,"counter" bigint NOT NULL,"deviceType" text NOT NULL,"backedUp" boolean NOT NULL,"transports" text,"createdAt" timestamptz,"aaguid" text);
CREATE INDEX "authn_passkey_userId" ON authn."passkey"("userId");
CREATE INDEX "authn_passkey_credentialID" ON authn."passkey"("credentialID");
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."passkey" TO hub2_hufu;
CREATE TABLE authz.oauth_policy(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),issuer text NOT NULL,resource text NOT NULL);
REVOKE ALL ON authz.oauth_policy FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE TABLE authz.oauth_credentials(access_id text PRIMARY KEY REFERENCES authn."oauthAccessToken" ON DELETE CASCADE,credential_id uuid NOT NULL UNIQUE REFERENCES authz.credentials,session_id text NOT NULL,issuer text NOT NULL,resource text NOT NULL);
REVOKE ALL ON authz.oauth_credentials FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.register_member_account(proof text,uid text,email text,name text,aid text,password_hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR uid IS NULL OR email IS NULL OR name IS NULL OR aid IS NULL OR password_hash IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 i:=authz.authenticate(proof);
 IF (i->>'is_primary')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'primary_authentication_required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM authz.member_accounts WHERE principal_id=actor) THEN RAISE EXCEPTION 'member_account_already_registered';END IF;
 INSERT INTO authn."user" VALUES(uid,name,email,false,NULL,clock_timestamp(),clock_timestamp());
 INSERT INTO authz.member_accounts VALUES(uid,actor,'current_primary_credential_verified_email_pending');
 INSERT INTO authn.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES(aid,uid,'credential',uid,password_hash,clock_timestamp(),clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION authz.register_member_account(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.register_member_account(text,text,text,text,text,text) TO hub2_hufu;
CREATE FUNCTION authz.oauth_access_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid;parent authz.credentials;client uuid;credential uuid;p authz.oauth_policy;actions text[];raw_session authn."session";
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id IN(SELECT credential_id FROM authz.oauth_credentials WHERE access_id=OLD.id);RETURN OLD;
 END IF;
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=NEW."userId";
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 IF TG_OP='UPDATE' THEN
  IF NEW.token IS DISTINCT FROM OLD.token OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW.resources IS DISTINCT FROM OLD.resources OR NEW.scopes IS DISTINCT FROM OLD.scopes OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" AND NEW."sessionId" IS NOT NULL THEN RAISE EXCEPTION 'oauth_token_identity_immutable';END IF;
  IF NEW.revoked IS NOT NULL OR NEW."sessionId" IS NULL THEN UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id IN(SELECT credential_id FROM authz.oauth_credentials WHERE access_id=NEW.id);END IF;RETURN NEW;
 END IF;
 SELECT * INTO p FROM authz.oauth_policy;
 IF actor IS NULL OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active) OR p.issuer IS NULL OR NEW.resources IS DISTINCT FROM jsonb_build_array(p.resource) OR NEW.token !~ '^[a-f0-9]{64}$' OR NEW.revoked IS NOT NULL OR NOT NEW.scopes<@'["hub2.read","hub2.work","offline_access"]'::jsonb THEN RAISE EXCEPTION 'oauth_member_resource_scope_invalid' USING ERRCODE='42501';END IF;
 SELECT * INTO raw_session FROM authn."session" WHERE id=NEW."sessionId" AND "userId"=NEW."userId";
 SELECT * INTO parent FROM authz.credentials WHERE token_hash=encode(public.digest(raw_session.token,'sha256'),'hex');
 IF raw_session.id IS NULL OR raw_session."expiresAt"<=clock_timestamp() OR parent.id IS NULL OR NOT authz.family_valid(parent.id) OR parent.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'oauth_current_primary_session_required' USING ERRCODE='42501';END IF;
 actions:=CASE WHEN NEW.scopes?'hub2.work' THEN ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read'] ELSE ARRAY['mem.read','v8.project.read','v8.work.read','v8.adoption.read','v8.context.read','v8.handoff.read','v8.experience.read'] END;
 INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,'oauth:'||NEW."clientId",actions) RETURNING id INTO client;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,parent_credential_id,authority_source) VALUES(client,NEW.token,NEW."expiresAt",parent.id,'standard_oauth') RETURNING id INTO credential;
 INSERT INTO authz.sessions(principal_id,token_hash,expires_at,refresh_expires_at) VALUES(actor,NEW.token,NEW."expiresAt",NEW."expiresAt");
 INSERT INTO authz.oauth_credentials VALUES(NEW.id,credential,raw_session.id,p.issuer,p.resource);RETURN NEW;
END $$;
CREATE TRIGGER oauth_access_fence AFTER INSERT OR UPDATE ON authn."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION authz.oauth_access_fence();
CREATE TRIGGER oauth_access_delete_fence BEFORE DELETE ON authn."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION authz.oauth_access_fence();
CREATE FUNCTION authz.oauth_refresh_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.revoked IS NOT NULL THEN UPDATE authn."oauthAccessToken" SET revoked=clock_timestamp() WHERE "refreshId"=OLD.id AND revoked IS NULL;END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER oauth_refresh_fence BEFORE UPDATE OR DELETE ON authn."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION authz.oauth_refresh_fence();
CREATE FUNCTION authz.oauth_session_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 UPDATE authn."oauthRefreshToken" SET revoked=clock_timestamp() WHERE "sessionId"=OLD.id AND revoked IS NULL;
 UPDATE authn."oauthAccessToken" SET revoked=clock_timestamp() WHERE "sessionId"=OLD.id AND revoked IS NULL;RETURN OLD;
END $$;
CREATE TRIGGER oauth_session_stop BEFORE DELETE ON authn."session" FOR EACH ROW EXECUTE FUNCTION authz.oauth_session_stop();
REVOKE ALL ON FUNCTION authz.oauth_access_fence(),authz.oauth_refresh_fence(),authz.oauth_session_stop() FROM PUBLIC;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.oauth_policy_match(issuer text,resource text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$SELECT authz.runtime_role()='hub2_hufu' AND EXISTS(SELECT FROM authz.oauth_policy p WHERE p.issuer=$1 AND p.resource=$2)$$;
REVOKE ALL ON FUNCTION authz.oauth_policy_match(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.oauth_policy_match(text,text) TO hub2_hufu;
RESET ROLE;

-- Candidate addition to uninstalled 370. Existing primary identity is enough to
-- bootstrap a browser session and Passkey; the mailbox remains unverified.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.member_primary_session(proof text,sid text,raw_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;u authn."user";s authn."session";
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR proof IS NULL OR sid IS NULL OR raw_token IS NULL OR length(raw_token)<32 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 i:=authz.authenticate(proof);
 IF (i->>'is_primary')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'primary_authentication_required' USING ERRCODE='42501';END IF;
 SELECT usr.* INTO u FROM authn."user" usr JOIN authz.member_accounts m ON m.authn_user_id=usr.id WHERE m.principal_id=actor;
 IF u.id IS NULL THEN RAISE EXCEPTION 'member_account_required' USING ERRCODE='42501';END IF;
 INSERT INTO authn."session"(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES(sid,clock_timestamp()+interval '8 hours',raw_token,clock_timestamp(),clock_timestamp(),u.id) RETURNING * INTO s;
 RETURN jsonb_build_object('user',to_jsonb(u),'session',to_jsonb(s));
END $$;
REVOKE ALL ON FUNCTION authz.member_primary_session(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.member_primary_session(text,text,text) TO hub2_hufu;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE TABLE authz.member_entry_bootstrap(token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),principal_id uuid NOT NULL REFERENCES authz.principals,authn_user_id text NOT NULL REFERENCES authn."user",origin_credential_id uuid NOT NULL REFERENCES authz.credentials,origin_token_hash text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON authz.member_entry_bootstrap FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.member_entry_bootstrap_issue(proof text,bootstrap_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;uid text;expiry timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR bootstrap_hash IS NULL OR bootstrap_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;i:=authz.authenticate(proof);
 IF (i->>'is_primary')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'primary_authentication_required' USING ERRCODE='42501';END IF;
 SELECT authn_user_id INTO uid FROM authz.member_accounts WHERE principal_id=actor;
 IF uid IS NULL THEN RAISE EXCEPTION 'member_account_required' USING ERRCODE='42501';END IF;
 expiry:=least(clock_timestamp()+interval '5 minutes',(i->>'expires_at')::timestamptz);
 INSERT INTO authz.member_entry_bootstrap(token_hash,principal_id,authn_user_id,origin_credential_id,origin_token_hash,expires_at) VALUES(bootstrap_hash,actor,uid,(i->>'credential_id')::uuid,proof,expiry);
 RETURN jsonb_build_object('expires_at',expiry,'actor_id',actor);
END $$;
CREATE FUNCTION authz.member_entry_bootstrap_consume(bootstrap_hash text,sid text,raw_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE b authz.member_entry_bootstrap;origin_hash text;result jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO b FROM authz.member_entry_bootstrap WHERE token_hash=bootstrap_hash;
 IF b.token_hash IS NULL THEN RAISE EXCEPTION 'invalid_bootstrap' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=b.principal_id FOR UPDATE;
 SELECT * INTO b FROM authz.member_entry_bootstrap WHERE token_hash=bootstrap_hash FOR UPDATE;
 IF b.consumed_at IS NOT NULL OR b.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT FROM authz.member_accounts WHERE principal_id=b.principal_id AND authn_user_id=b.authn_user_id) THEN RAISE EXCEPTION 'invalid_bootstrap' USING ERRCODE='42501';END IF;
 SELECT token_hash INTO origin_hash FROM authz.credentials WHERE id=b.origin_credential_id;
 IF origin_hash IS DISTINCT FROM b.origin_token_hash THEN RAISE EXCEPTION 'invalid_bootstrap' USING ERRCODE='42501';END IF;
 result:=authz.member_primary_session(origin_hash,sid,raw_token);
 IF result->'user'->>'id' IS DISTINCT FROM b.authn_user_id THEN RAISE EXCEPTION 'invalid_bootstrap' USING ERRCODE='42501';END IF;
 UPDATE authz.member_entry_bootstrap SET consumed_at=clock_timestamp() WHERE token_hash=bootstrap_hash;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION authz.member_entry_bootstrap_issue(text,text),authz.member_entry_bootstrap_consume(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.member_entry_bootstrap_issue(text,text),authz.member_entry_bootstrap_consume(text,text,text) TO hub2_hufu;
RESET ROLE;
