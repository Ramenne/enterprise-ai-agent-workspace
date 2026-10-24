CREATE TABLE authz.wechat_members(app_id text NOT NULL,open_id text NOT NULL,principal_id uuid NOT NULL REFERENCES authz.principals,provenance text NOT NULL CHECK(length(provenance)>0),active boolean NOT NULL DEFAULT true,PRIMARY KEY(app_id,open_id));
ALTER TABLE authz.wechat_members OWNER TO hub2_authz_owner;
CREATE TABLE authz.wechat_states(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[0-9a-f]{64}$'),app_id text NOT NULL,client_label text NOT NULL CHECK(client_label IN('codex','qoder','chatgpt','browser')),expires_at timestamptz NOT NULL,claimed_at timestamptz,completed_at timestamptz,claim_id uuid UNIQUE,code_hash text UNIQUE CHECK(code_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE authz.wechat_states OWNER TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.wechat_begin(p_state_hash text,p_app_id text,p_client_label text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.wechat_states;
BEGIN
 IF session_user<>'hub2_hufu' OR p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' OR COALESCE(p_app_id,'')='' OR p_client_label IS NULL OR p_client_label NOT IN('codex','qoder','chatgpt','browser') THEN RAISE EXCEPTION 'invalid_wechat_state' USING ERRCODE='42501';END IF;
 INSERT INTO authz.wechat_states(state_hash,app_id,client_label,expires_at) VALUES(p_state_hash,p_app_id,p_client_label,clock_timestamp()+interval '5 minutes') RETURNING * INTO s;
 RETURN jsonb_build_object('state_id',s.id,'expires_at',s.expires_at);
END $$;
CREATE FUNCTION authz.wechat_claim(p_state_hash text,p_code_hash text,p_app_id text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.wechat_states;claim uuid:=gen_random_uuid();
BEGIN
 IF session_user<>'hub2_hufu' OR p_state_hash IS NULL OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR COALESCE(p_app_id,'')='' THEN RAISE EXCEPTION 'invalid_wechat_claim' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM authz.wechat_states WHERE state_hash=p_state_hash AND app_id=p_app_id FOR UPDATE;
 IF s.id IS NULL OR s.claimed_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'wechat_state_expired_or_replayed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM authz.wechat_states WHERE code_hash=p_code_hash) THEN RAISE EXCEPTION 'wechat_code_replayed' USING ERRCODE='42501';END IF;
 UPDATE authz.wechat_states SET claimed_at=clock_timestamp(),claim_id=claim,code_hash=p_code_hash WHERE id=s.id;
 RETURN claim;
END $$;
CREATE FUNCTION authz.wechat_finish(p_claim uuid,p_app_id text,p_open_id text,p_access_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.wechat_states;p authz.principals;cid uuid;credential uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_claim IS NULL OR COALESCE(p_app_id,'')='' OR COALESCE(p_open_id,'')='' OR p_access_hash IS NULL OR p_access_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_wechat_identity' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 SELECT * INTO s FROM authz.wechat_states WHERE claim_id=p_claim AND app_id=p_app_id FOR UPDATE;
 IF s.id IS NULL OR s.completed_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.claimed_at IS NULL THEN RAISE EXCEPTION 'wechat_claim_expired_or_replayed' USING ERRCODE='42501';END IF;
 SELECT actor.* INTO p FROM authz.wechat_members mapping JOIN authz.principals actor ON actor.id=mapping.principal_id WHERE mapping.app_id=p_app_id AND mapping.open_id=p_open_id AND mapping.active;
 IF p.id IS NULL OR p.active IS DISTINCT FROM true OR p.kind<>'member' THEN RAISE EXCEPTION 'wechat_membership_unverified' USING ERRCODE='42501';END IF;
 INSERT INTO authz.clients(principal_id,label,actions) VALUES(p.id,s.client_label,ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']) RETURNING id INTO cid;
 INSERT INTO authz.credentials(client_id,token_hash,until_revoked,wechat_app_id,wechat_open_id) VALUES(cid,p_access_hash,true,p_app_id,p_open_id) RETURNING id INTO credential;
 UPDATE authz.wechat_states SET completed_at=clock_timestamp() WHERE id=s.id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(p.id,cid,'authz','wechat.login',credential,jsonb_build_object('trusted_mapping',true,'state_id',s.id));
 RETURN jsonb_build_object('state','authenticated','actor_id',p.id,'client_id',cid,'credential_id',credential,'until_revoked',true);
END $$;
REVOKE ALL ON FUNCTION authz.wechat_begin(text,text,text),authz.wechat_claim(text,text,text),authz.wechat_finish(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.wechat_begin(text,text,text),authz.wechat_claim(text,text,text),authz.wechat_finish(uuid,text,text,text) TO hub2_hufu;
RESET ROLE;
ALTER TABLE authz.credentials ADD wechat_app_id text;
ALTER TABLE authz.credentials ADD wechat_open_id text;
ALTER TABLE authz.credentials ADD CONSTRAINT credential_wechat_pair CHECK((wechat_app_id IS NULL)=(wechat_open_id IS NULL));
ALTER TABLE authz.credentials ADD FOREIGN KEY(wechat_app_id,wechat_open_id) REFERENCES authz.wechat_members(app_id,open_id);
SET ROLE hub2_authz_owner;
CREATE TRIGGER wechat_members_security_lock BEFORE UPDATE OR DELETE ON authz.wechat_members FOR EACH STATEMENT EXECUTE FUNCTION authz.lock_security_mutation();
CREATE FUNCTION authz.wechat_membership_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.app_id IS DISTINCT FROM OLD.app_id OR NEW.open_id IS DISTINCT FROM OLD.open_id THEN RAISE EXCEPTION 'provider_identity_immutable' USING ERRCODE='42501';END IF;
 IF NEW.active=false AND OLD.active=true THEN UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE wechat_app_id=OLD.app_id AND wechat_open_id=OLD.open_id AND revoked_at IS NULL;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wechat_membership_fence BEFORE UPDATE ON authz.wechat_members FOR EACH ROW EXECUTE FUNCTION authz.wechat_membership_fence();
REVOKE ALL ON FUNCTION authz.wechat_membership_fence() FROM PUBLIC;
RESET ROLE;
