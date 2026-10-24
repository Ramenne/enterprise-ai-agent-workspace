-- Better Auth 1.7.7 core schema, derived from installed getSchema({}). No public registration.
SET ROLE hub2_authz_owner;
CREATE TABLE authn."user"(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,"emailVerified" boolean NOT NULL DEFAULT false,image text,"createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL);
CREATE TABLE authn."session"(id text PRIMARY KEY,"expiresAt" timestamptz NOT NULL,token text NOT NULL UNIQUE,"createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL,"ipAddress" text,"userAgent" text,"userId" text NOT NULL REFERENCES authn."user" ON DELETE CASCADE);
CREATE INDEX authn_session_user ON authn."session"("userId");
CREATE TABLE authn.account(id text PRIMARY KEY,"accountId" text NOT NULL,"providerId" text NOT NULL,"userId" text NOT NULL REFERENCES authn."user" ON DELETE CASCADE,"accessToken" text,"refreshToken" text,"idToken" text,"accessTokenExpiresAt" timestamptz,"refreshTokenExpiresAt" timestamptz,scope text,password text,"createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL);
CREATE INDEX authn_account_user ON authn.account("userId");
CREATE TABLE authn.verification(id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,"expiresAt" timestamptz NOT NULL,"createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL);
CREATE INDEX authn_verification_identifier ON authn.verification(identifier);
CREATE TABLE authz.member_accounts(authn_user_id text PRIMARY KEY REFERENCES authn."user" ON DELETE CASCADE,principal_id uuid NOT NULL UNIQUE REFERENCES authz.principals,provenance text NOT NULL CHECK(length(provenance)>0));
CREATE FUNCTION authz.authn_session_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid; cid uuid; h text;
BEGIN
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF actor IS NULL THEN RAISE EXCEPTION 'untrusted_member_account' USING ERRCODE='42501'; END IF;
 PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 IF TG_OP='DELETE' THEN
  h:=encode(public.digest(OLD.token,'sha256'),'hex');
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  RETURN OLD;
 END IF;
 h:=encode(public.digest(NEW.token,'sha256'),'hex');
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active) THEN RAISE EXCEPTION 'disabled_member' USING ERRCODE='42501'; END IF;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,'member-browser',ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,expires_at) VALUES(cid,h,NEW."expiresAt");
  INSERT INTO authz.sessions(principal_id,token_hash,expires_at,refresh_expires_at) VALUES(actor,h,NEW."expiresAt",NEW."expiresAt");
 ELSE
  IF NEW.token IS DISTINCT FROM OLD.token OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'session_identity_immutable'; END IF;
  UPDATE authz.credentials SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER authn_session_fence BEFORE INSERT OR UPDATE OR DELETE ON authn."session" FOR EACH ROW EXECUTE FUNCTION authz.authn_session_fence();
CREATE FUNCTION authz.authn_account_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.password IS NOT DISTINCT FROM OLD.password AND NEW."providerId" IS NOT DISTINCT FROM OLD."providerId" THEN RETURN NEW; END IF;
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=actor;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=actor);
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=actor;
 DELETE FROM authn."session" WHERE "userId"=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER authn_account_fence BEFORE UPDATE OR DELETE ON authn.account FOR EACH ROW EXECUTE FUNCTION authz.authn_account_fence();
REVOKE ALL ON FUNCTION authz.authn_session_fence(),authz.authn_account_fence() FROM PUBLIC;
GRANT USAGE ON SCHEMA authn TO hub2_hufu;
GRANT SELECT,INSERT,UPDATE,DELETE ON authn."user",authn."session",authn.account,authn.verification TO hub2_hufu;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.principal_state_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF NEW.active IS DISTINCT FROM OLD.active THEN NEW.epoch:=greatest(NEW.epoch,OLD.epoch+1); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER principal_state_fence BEFORE UPDATE ON authz.principals FOR EACH ROW EXECUTE FUNCTION authz.principal_state_fence();
REVOKE ALL ON FUNCTION authz.principal_state_fence() FROM PUBLIC;
RESET ROLE;
