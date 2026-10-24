-- Proposal owned by email-otp-entry. Root assigns final migration number.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.email_otp_member_current(p_email text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
 SELECT authz.runtime_role()='hub2_hufu' AND EXISTS(SELECT FROM authn."user" u JOIN authz.member_accounts m ON m.authn_user_id=u.id JOIN authz.principals p ON p.id=m.principal_id
 WHERE lower(u.email)=lower(p_email) AND p.active AND p.kind='member');
$$;
REVOKE ALL ON FUNCTION authz.email_otp_member_current(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.email_otp_member_current(text) TO hub2_hufu;
-- Pinned Better Auth 1.7.7 creates this server-only cleanup lock only after
-- consuming valid sign-in OTP, before deleting unproven account links/sessions.
-- Ordinary clients cannot create it: create/getVerificationOTP are server-only.
-- Runtime auth adapter is trusted to write verification rows, as before.
-- Retain independent external identity/Agent keys. Normal authn session DELETE
-- still stops browser credentials, their scoped descendants and OAuth grants.
-- A verified-account deletion, password update or provider change follows the
-- unchanged strong fence. No request body flag or client label changes authority.
CREATE OR REPLACE FUNCTION authz.authn_account_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.password IS NOT DISTINCT FROM OLD.password AND NEW."providerId" IS NOT DISTINCT FROM OLD."providerId" THEN RETURN NEW; END IF;
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 IF TG_OP='DELETE' AND authz.runtime_role()='hub2_hufu' AND EXISTS(
  SELECT FROM authn."user" u JOIN authz.member_accounts m ON m.authn_user_id=u.id JOIN authz.principals p ON p.id=m.principal_id JOIN authn.verification v ON v.identifier='revoke-unproven-account-access:'||u.id AND v.value=u.id
  WHERE u.id=OLD."userId" AND NOT u."emailVerified" AND p.active AND p.kind='member' AND v."expiresAt">clock_timestamp() AND v."createdAt">clock_timestamp()-interval '5 seconds'
 ) THEN RETURN OLD; END IF;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=actor;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=actor);
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=actor;
 DELETE FROM authn."session" WHERE "userId"=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.authn_account_fence() FROM PUBLIC;
RESET ROLE;
