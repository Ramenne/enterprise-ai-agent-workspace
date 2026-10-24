CREATE TABLE authz.refresh_families(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),principal_id uuid NOT NULL REFERENCES authz.principals,client_id uuid NOT NULL REFERENCES authz.clients,origin_credential_id uuid NOT NULL REFERENCES authz.credentials,expires_at timestamptz NOT NULL,active boolean NOT NULL DEFAULT true,epoch bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE authz.refresh_families OWNER TO hub2_authz_owner;
ALTER TABLE authz.credentials ADD family_id uuid REFERENCES authz.refresh_families;
CREATE TABLE authz.refresh_generations(family_id uuid NOT NULL REFERENCES authz.refresh_families,generation bigint NOT NULL,refresh_hash text NOT NULL UNIQUE CHECK(refresh_hash ~ '^[0-9a-f]{64}$'),credential_id uuid NOT NULL REFERENCES authz.credentials,expires_at timestamptz NOT NULL,used_at timestamptz,PRIMARY KEY(family_id,generation));
ALTER TABLE authz.refresh_generations OWNER TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.lock_security_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 PERFORM id FROM authz.clients ORDER BY id FOR UPDATE;
 PERFORM id FROM authz.credentials ORDER BY id FOR UPDATE;
 RETURN NULL;
END $$;
CREATE TRIGGER credentials_security_lock BEFORE UPDATE OR DELETE ON authz.credentials FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE TRIGGER clients_security_lock BEFORE UPDATE OR DELETE ON authz.clients FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE TRIGGER sessions_security_lock BEFORE UPDATE OR DELETE ON authz.sessions FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE TRIGGER qualifications_security_lock BEFORE UPDATE OR DELETE ON authz.qualifications FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE TRIGGER refresh_security_lock BEFORE UPDATE OR DELETE ON authz.refresh_families FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE FUNCTION authz.family_valid(cid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE c authz.credentials;f authz.refresh_families;origin authz.credentials;
BEGIN
 SELECT * INTO c FROM authz.credentials WHERE id=cid;
 IF c.id IS NULL OR c.revoked_at IS NOT NULL OR NOT c.until_revoked AND c.expires_at<=clock_timestamp() THEN RETURN false;END IF;
 IF c.wechat_app_id IS NOT NULL AND NOT EXISTS(SELECT FROM authz.wechat_members m WHERE m.app_id=c.wechat_app_id AND m.open_id=c.wechat_open_id AND m.active) THEN RETURN false;END IF;
 IF c.family_id IS NULL THEN RETURN true;END IF;
 SELECT * INTO f FROM authz.refresh_families WHERE id=c.family_id;
 SELECT * INTO origin FROM authz.credentials WHERE id=f.origin_credential_id;
 RETURN f.id IS NOT NULL AND f.active AND f.expires_at>clock_timestamp() AND origin.id IS NOT NULL AND origin.revoked_at IS NULL AND (origin.until_revoked OR origin.expires_at>clock_timestamp());
END $$;
CREATE FUNCTION authz.revoke_family(fid uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE f authz.refresh_families;
BEGIN
 SELECT * INTO f FROM authz.refresh_families WHERE id=fid;
 UPDATE authz.refresh_families SET active=false,epoch=epoch+1 WHERE id=fid AND active;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE family_id=fid AND revoked_at IS NULL;
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash IN(SELECT token_hash FROM authz.credentials WHERE family_id=fid) AND revoked_at IS NULL;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(f.principal_id,f.client_id,'authz','session.family_revoke',fid,jsonb_build_object('reason',reason));
END $$;
CREATE FUNCTION authz.origin_revoke_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE fid uuid;
BEGIN
 IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
  FOR fid IN SELECT id FROM authz.refresh_families WHERE origin_credential_id=NEW.id AND active ORDER BY id LOOP PERFORM authz.revoke_family(fid,'origin_credential_revoked');END LOOP;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER origin_revoke_fence AFTER UPDATE ON authz.credentials FOR EACH ROW EXECUTE FUNCTION authz.origin_revoke_fence();
CREATE FUNCTION authz.session_start(p_hash text,p_access_hash text,p_refresh_hash text,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;cid uuid;origin authz.credentials;f authz.refresh_families;access authz.credentials;expiry timestamptz;old authz.operations;result jsonb;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_access_hash IS NULL OR p_refresh_hash IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_session_start' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;cid:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;PERFORM id FROM authz.clients ORDER BY id FOR UPDATE;PERFORM id FROM authz.credentials ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO origin FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF old.request_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 IF origin.family_id IS NOT NULL THEN RAISE EXCEPTION 'nested_refresh_family' USING ERRCODE='42501';END IF;
 expiry:=least(clock_timestamp()+interval '7 days',CASE WHEN origin.until_revoked THEN 'infinity'::timestamptz ELSE origin.expires_at END);
 INSERT INTO authz.refresh_families(principal_id,client_id,origin_credential_id,expires_at) VALUES(actor,cid,origin.id,expiry) RETURNING * INTO f;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id) VALUES(cid,p_access_hash,least(expiry,clock_timestamp()+interval '15 minutes'),f.id) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,1,p_refresh_hash,access.id,expiry,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(actor,p_access_hash,p_refresh_hash,access.expires_at,expiry);
 result:=jsonb_build_object('state','committed','family_id',f.id,'generation',1,'expires_at',access.expires_at,'refresh_expires_at',expiry,'operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);RETURN result;
END $$;
CREATE FUNCTION authz.session_refresh(p_refresh_hash text,p_access_hash text,p_next_refresh_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE g authz.refresh_generations;f authz.refresh_families;p authz.principals;c authz.clients;origin authz.credentials;access authz.credentials;expiry timestamptz;
BEGIN
 IF session_user<>'hub2_hufu' OR p_refresh_hash IS NULL OR p_access_hash IS NULL OR p_next_refresh_hash IS NULL OR p_refresh_hash !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_next_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_refresh' USING ERRCODE='42501';END IF;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash;
 IF g.family_id IS NULL THEN RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;PERFORM id FROM authz.clients ORDER BY id FOR UPDATE;PERFORM id FROM authz.credentials ORDER BY id FOR UPDATE;
 SELECT * INTO f FROM authz.refresh_families WHERE id=g.family_id FOR UPDATE;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash FOR UPDATE;
 IF g.used_at IS NOT NULL THEN PERFORM authz.revoke_family(f.id,'refresh_reuse');RETURN jsonb_build_object('state','rejected','error_code','refresh_reuse','family_revoked',true);END IF;
 SELECT * INTO p FROM authz.principals WHERE id=f.principal_id;SELECT * INTO c FROM authz.clients WHERE id=f.client_id;SELECT * INTO origin FROM authz.credentials WHERE id=f.origin_credential_id;
 IF f.active IS DISTINCT FROM true OR p.active IS DISTINCT FROM true OR c.active IS DISTINCT FROM true OR f.expires_at<=clock_timestamp() OR g.expires_at<=clock_timestamp() OR NOT authz.family_valid(origin.id) THEN PERFORM authz.revoke_family(f.id,'expired_or_disabled');RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 UPDATE authz.refresh_generations SET used_at=clock_timestamp() WHERE family_id=g.family_id AND generation=g.generation;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=g.credential_id;
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=(SELECT token_hash FROM authz.credentials WHERE id=g.credential_id);
 expiry:=least(f.expires_at,clock_timestamp()+interval '15 minutes');
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id) VALUES(c.id,p_access_hash,expiry,f.id) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,g.generation+1,p_next_refresh_hash,access.id,f.expires_at,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(p.id,p_access_hash,p_next_refresh_hash,expiry,f.expires_at);
 RETURN jsonb_build_object('state','committed','family_id',f.id,'generation',g.generation+1,'expires_at',expiry,'refresh_expires_at',f.expires_at);
END $$;
CREATE FUNCTION authz.stop(p_hash text,p_command text,p_target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;subject authz.principals;caller authz.principals;cid uuid;fid uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_command IS NULL OR p_target IS NULL OR p_command NOT IN('principal.disable','session.logout_all','client.disable','session.logout') THEN RAISE EXCEPTION 'invalid_stop' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;PERFORM id FROM authz.clients ORDER BY id FOR UPDATE;PERFORM id FROM authz.credentials ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO caller FROM authz.principals WHERE id=actor;
 IF p_command='client.disable' THEN
  SELECT principal_id INTO cid FROM authz.clients WHERE id=p_target;
  IF cid IS DISTINCT FROM actor THEN RAISE EXCEPTION 'foreign_client' USING ERRCODE='42501';END IF;
  UPDATE authz.clients SET active=false,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id=p_target;
 ELSIF p_command='session.logout' THEN
  IF p_target IS DISTINCT FROM (identity->>'credential_id')::uuid THEN RAISE EXCEPTION 'foreign_session' USING ERRCODE='42501';END IF;
  SELECT family_id INTO fid FROM authz.credentials WHERE id=p_target;
  IF fid IS NOT NULL THEN PERFORM authz.revoke_family(fid,'session_logout');ELSE UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=p_target;END IF;
 ELSE
  SELECT * INTO subject FROM authz.principals WHERE id=p_target;
  IF subject.id IS NULL OR (actor<>subject.id AND (caller.role<>'organization_admin' OR caller.organization_id<>subject.organization_id)) THEN RAISE EXCEPTION 'foreign_principal' USING ERRCODE='42501';END IF;
  UPDATE authz.principals SET active=CASE WHEN p_command='principal.disable' THEN false ELSE active END,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=p_target);
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=p_target;
  DELETE FROM authn."session" WHERE "userId" IN(SELECT authn_user_id FROM authz.member_accounts WHERE principal_id=p_target);
 END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(identity->>'client_id')::uuid,'authz',p_command,p_target,'{}');
 RETURN jsonb_build_object('state','committed','target_id',p_target,'operation_id',gen_random_uuid());
END $$;
REVOKE ALL ON FUNCTION authz.lock_security_mutation(),authz.family_valid(uuid),authz.revoke_family(uuid,text),authz.origin_revoke_fence(),authz.session_start(text,text,text,text,text),authz.session_refresh(text,text,text),authz.stop(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.session_start(text,text,text,text,text),authz.session_refresh(text,text,text),authz.stop(text,text,uuid) TO hub2_hufu;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE TRIGGER principals_security_lock BEFORE UPDATE OR DELETE ON authz.principals FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE FUNCTION authz.principal_disable_dependents() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF NEW.active=false AND OLD.active=true THEN
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=NEW.id) AND revoked_at IS NULL;
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=NEW.id AND revoked_at IS NULL;
  DELETE FROM authn."session" WHERE "userId" IN(SELECT authn_user_id FROM authz.member_accounts WHERE principal_id=NEW.id);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER principal_disable_dependents AFTER UPDATE ON authz.principals FOR EACH ROW EXECUTE FUNCTION authz.principal_disable_dependents();
CREATE FUNCTION authz.qualification_epoch_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF (NEW.active,NEW.frozen,NEW.expires_at,NEW.until_revoked,NEW.actions,NEW.resource_selector,NEW.parent_id,NEW.source_basis) IS DISTINCT FROM (OLD.active,OLD.frozen,OLD.expires_at,OLD.until_revoked,OLD.actions,OLD.resource_selector,OLD.parent_id,OLD.source_basis) THEN
  NEW.epoch:=greatest(NEW.epoch,OLD.epoch+1);
  UPDATE authz.principals SET epoch=epoch+1 WHERE id=NEW.principal_id OR id IN(SELECT principal_id FROM authz.qualifications WHERE parent_id=NEW.id OR parent_id IN(SELECT id FROM authz.qualifications WHERE parent_id=NEW.id));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER qualification_epoch_fence BEFORE UPDATE ON authz.qualifications FOR EACH ROW EXECUTE FUNCTION authz.qualification_epoch_fence();
REVOKE ALL ON FUNCTION authz.principal_disable_dependents(),authz.qualification_epoch_fence() FROM PUBLIC;
RESET ROLE;
ALTER TABLE authz.clients ADD CONSTRAINT client_actions_no_null CHECK(cardinality(actions)>0 AND array_position(actions,NULL) IS NULL);
ALTER TABLE authz.qualifications ADD CONSTRAINT qualification_actions_no_null CHECK(cardinality(actions)>0 AND array_position(actions,NULL) IS NULL);
ALTER TABLE authz.credentials ADD CONSTRAINT credential_expiry_finite CHECK(expires_at IS NULL OR isfinite(expires_at));
ALTER TABLE authz.qualifications ADD CONSTRAINT qualification_expiry_finite CHECK(expires_at IS NULL OR isfinite(expires_at));
ALTER TABLE authz.sessions ADD CONSTRAINT session_expiry_finite CHECK(isfinite(expires_at) AND isfinite(refresh_expires_at));
