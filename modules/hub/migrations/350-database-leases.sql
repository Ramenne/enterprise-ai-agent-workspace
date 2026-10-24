-- Additive dynamic DB LOGIN lifecycle. Preserve all existing fixed runtime passwords.
-- Applied by deployment identity only; OpenBao manager itself has no CREATEROLE.
CREATE ROLE hub2_db_issuer_owner NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE hub2_bao_db_manager LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE hub2_db_expiry_guard LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE SCHEMA db_secrets AUTHORIZATION hub2_db_issuer_owner;
GRANT hub2_hufu,hub2_mem,hub2_v8,hub2_worker TO hub2_db_issuer_owner WITH ADMIN TRUE,INHERIT FALSE,SET FALSE;
GRANT USAGE ON SCHEMA db_secrets TO hub2_bao_db_manager,hub2_db_expiry_guard,hub2_authz_owner;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO hub2_db_issuer_owner WITH GRANT OPTION',current_database());END $$;
SET ROLE hub2_db_issuer_owner;
CREATE TABLE db_secrets.logins(username text PRIMARY KEY,domain text NOT NULL CHECK(domain IN('hufu','mem','v8','worker')),runtime_role text NOT NULL,expires_at timestamptz NOT NULL,issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz);
REVOKE ALL ON db_secrets.logins FROM PUBLIC;
GRANT SELECT ON db_secrets.logins TO hub2_authz_owner;
CREATE FUNCTION db_secrets.issue(domain text,name text,secret text,expiration timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,db_secrets AS $$
DECLARE target text;previous text;
BEGIN
 IF session_user<>'hub2_bao_db_manager' OR domain NOT IN('hufu','mem','v8','worker') OR domain IS NULL OR name IS NULL OR name !~ format('^h2d_%s_[A-Za-z0-9]{18}_[0-9]{10,12}$',domain) OR secret IS NULL OR secret='' OR expiration IS NULL OR NOT isfinite(expiration) OR expiration<=clock_timestamp() OR expiration>clock_timestamp()+interval '24 hours 1 minute' THEN RAISE EXCEPTION 'db_issuance_scope_rejected' USING ERRCODE='42501';END IF;
 target:='hub2_'||domain;previous:=current_setting('createrole_self_grant');PERFORM set_config('createrole_self_grant','inherit',true);
 EXECUTE format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 24 PASSWORD %L VALID UNTIL %L',name,secret,expiration);
 EXECUTE format('GRANT %I TO %I WITH ADMIN FALSE,INHERIT TRUE,SET FALSE',target,name);
 -- PG's native creator grant inherits only its own created LOGIN, allowing targeted termination.
 PERFORM set_config('createrole_self_grant',previous,true);
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),name);
 INSERT INTO db_secrets.logins(username,domain,runtime_role,expires_at) VALUES(name,domain,target,expiration);
 RETURN 'issued';
END $$;
CREATE FUNCTION db_secrets.renew(name text,expiration timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,db_secrets AS $$
DECLARE r db_secrets.logins;
BEGIN
 IF session_user<>'hub2_bao_db_manager' OR expiration IS NULL OR NOT isfinite(expiration) OR expiration<=clock_timestamp() OR expiration>clock_timestamp()+interval '24 hours 1 minute' THEN RAISE EXCEPTION 'db_renewal_scope_rejected' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM db_secrets.logins WHERE username=name FOR UPDATE;
 IF r.username IS NULL OR r.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'db_lease_absent' USING ERRCODE='42501';END IF;
 EXECUTE format('ALTER ROLE %I VALID UNTIL %L',name,expiration);UPDATE db_secrets.logins SET expires_at=expiration WHERE username=name;RETURN 'renewed';
END $$;
CREATE FUNCTION db_secrets.revoke(name text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,db_secrets AS $$
DECLARE r db_secrets.logins;p record;
BEGIN
 IF session_user NOT IN('hub2_bao_db_manager','hub2_db_expiry_guard') THEN RAISE EXCEPTION 'db_revocation_scope_rejected' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM db_secrets.logins WHERE username=name FOR UPDATE;
 IF r.username IS NULL THEN RAISE EXCEPTION 'db_revocation_scope_rejected' USING ERRCODE='42501';END IF;
 IF r.revoked_at IS NOT NULL THEN RETURN 'already_revoked';END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=name) THEN
  EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL',name);
  FOR p IN SELECT pid FROM pg_stat_activity WHERE usename=name AND pid<>pg_backend_pid() LOOP IF NOT pg_terminate_backend(p.pid,2000) THEN RAISE EXCEPTION 'db_owned_session_not_terminated';END IF;END LOOP;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),name);
  EXECUTE format('DROP ROLE %I',name);
 END IF;
 UPDATE db_secrets.logins SET revoked_at=clock_timestamp() WHERE username=name;RETURN 'revoked';
END $$;
CREATE FUNCTION db_secrets.expire() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,db_secrets AS $$
DECLARE r record;n bigint:=0;
BEGIN
 IF session_user<>'hub2_db_expiry_guard' THEN RAISE EXCEPTION 'db_expiry_guard_required' USING ERRCODE='42501';END IF;
 FOR r IN SELECT username FROM db_secrets.logins WHERE revoked_at IS NULL AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 LOOP
  PERFORM db_secrets.revoke(r.username);n:=n+1;
 END LOOP;RETURN n;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA db_secrets FROM PUBLIC;
GRANT EXECUTE ON FUNCTION db_secrets.issue(text,text,text,timestamptz),db_secrets.renew(text,timestamptz),db_secrets.revoke(text) TO hub2_bao_db_manager;
GRANT EXECUTE ON FUNCTION db_secrets.expire() TO hub2_db_expiry_guard;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.runtime_role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE r db_secrets.logins;native text:=session_user;
BEGIN
 IF native IN('hub2_hufu','hub2_mem','hub2_v8','hub2_worker') THEN RETURN native;END IF;
 SELECT * INTO r FROM db_secrets.logins WHERE username=native AND revoked_at IS NULL AND expires_at>clock_timestamp();
 IF r.username IS NULL OR NOT pg_has_role(native,r.runtime_role,'MEMBER') OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=native AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication) THEN RETURN native;END IF;
 RETURN r.runtime_role;
END $$;
REVOKE ALL ON FUNCTION authz.runtime_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.runtime_role() TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker,hub2_mem_owner,hub2_v8_owner,hub2_evidence_owner;
RESET ROLE;
-- Preserve original bodies/owners/grants, changing only trusted runtime-role resolution.
-- Native session_user stays independently observable; no SET ROLE or claim supplied by a client.
DO $adapt$
DECLARE r record;body text;
BEGIN
 FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.prokind='f' AND n.nspname IN('authz','mem','v8','evidence','coord') AND owner.rolname IN('hub2_authz_owner','hub2_mem_owner','hub2_v8_owner','hub2_evidence_owner') AND p.proname<>'runtime_role' AND p.prosrc~'\msession_user\M' LOOP
  body:=pg_get_functiondef(r.oid);body:=regexp_replace(body,'\msession_user\M','authz.runtime_role()','g');EXECUTE body;
 END LOOP;
END $adapt$;
