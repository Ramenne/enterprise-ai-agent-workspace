-- Original bounded identity bridge. Existing 2.0 principals only, no role/org/qualification import.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.legacy_member_maps(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),issuer text NOT NULL DEFAULT 'service.example.invalid/access-verify' CHECK(issuer='service.example.invalid/access-verify'),
 subject_kind text NOT NULL DEFAULT 'username' CHECK(subject_kind='username'),legacy_subject text NOT NULL CHECK(length(legacy_subject) BETWEEN 1 AND 256),
 principal_id uuid NOT NULL REFERENCES authz.principals,client_actions text[] NOT NULL CHECK(cardinality(client_actions) BETWEEN 1 AND 80 AND array_position(client_actions,NULL) IS NULL),
 active boolean NOT NULL DEFAULT true,epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),registered_by text NOT NULL CHECK(length(registered_by)>0),registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(issuer,subject_kind,legacy_subject));
CREATE TABLE authz.legacy_bridge_challenges(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash~'^[a-f0-9]{64}$'),audience text NOT NULL CHECK(audience='hub2'),
 client_label text NOT NULL CHECK(length(client_label) BETWEEN 1 AND 80),requested_actions text[] NOT NULL CHECK(cardinality(requested_actions)<=80 AND array_position(requested_actions,NULL) IS NULL),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '5 minutes'),
 completed_at timestamptz,legacy_map_id uuid REFERENCES authz.legacy_member_maps,credential_id uuid REFERENCES authz.credentials,
 CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '5 minutes 1 second'));
ALTER TABLE authz.credentials ADD legacy_map_id uuid REFERENCES authz.legacy_member_maps;
REVOKE ALL ON authz.legacy_member_maps,authz.legacy_bridge_challenges FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;

CREATE FUNCTION authz.legacy_bridge_begin(nonce text,aud text,label text,acts text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.legacy_bridge_challenges;
BEGIN
 IF session_user<>'hub2_hufu' OR nonce IS NULL OR nonce !~ '^[a-f0-9]{64}$' OR aud IS DISTINCT FROM 'hub2' OR label IS NULL OR length(label) NOT BETWEEN 1 AND 80 OR acts IS NULL OR cardinality(acts)>80 OR array_position(acts,NULL) IS NOT NULL THEN RAISE EXCEPTION 'invalid_legacy_bridge_challenge' USING ERRCODE='42501';END IF;
 INSERT INTO authz.legacy_bridge_challenges(nonce_hash,audience,client_label,requested_actions)VALUES(nonce,aud,label,acts)RETURNING * INTO c;
 RETURN jsonb_build_object('state','challenge','challenge_id',c.id,'expires_at',c.expires_at,'audience',c.audience,'client_label',c.client_label,'client_actions',c.requested_actions);
END $$;
CREATE FUNCTION authz.legacy_bridge_check(challenge uuid,nonce text,aud text,label text,acts text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.legacy_bridge_challenges;
BEGIN
 IF session_user<>'hub2_hufu' OR challenge IS NULL OR nonce IS NULL OR aud IS NULL OR label IS NULL OR acts IS NULL THEN RAISE EXCEPTION 'invalid_legacy_bridge_binding' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM authz.legacy_bridge_challenges WHERE id=challenge;
 IF c.id IS NULL OR c.nonce_hash IS DISTINCT FROM nonce OR c.audience IS DISTINCT FROM aud OR aud<>'hub2' OR c.client_label IS DISTINCT FROM label OR c.requested_actions IS DISTINCT FROM acts OR c.completed_at IS NOT NULL OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'legacy_bridge_expired_replayed_or_wrong_binding' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','binding_checked','challenge_id',c.id,'expires_at',c.expires_at);
END $$;
CREATE FUNCTION authz.legacy_bridge_finish(challenge uuid,nonce text,aud text,label text,acts text[],subject text,proof_expiry timestamptz,access_hash text,old_role_metadata text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.legacy_bridge_challenges;m authz.legacy_member_maps;p authz.principals;cid uuid;cred uuid;selected text[];expiry timestamptz;
BEGIN
 IF session_user<>'hub2_hufu' OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 256 OR proof_expiry IS NULL OR NOT isfinite(proof_expiry) OR proof_expiry<=clock_timestamp() OR access_hash IS NULL OR access_hash !~ '^[a-f0-9]{64}$' OR (old_role_metadata IS NOT NULL AND length(old_role_metadata)>100) THEN RAISE EXCEPTION 'invalid_legacy_verified_identity' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 SELECT * INTO m FROM authz.legacy_member_maps WHERE issuer='service.example.invalid/access-verify' AND subject_kind='username' AND legacy_subject=subject FOR SHARE;
 IF m.id IS NULL OR NOT m.active THEN RAISE EXCEPTION 'legacy_membership_mapping_required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.principals WHERE id=m.principal_id FOR SHARE;
 IF p.id IS NULL OR p.active IS DISTINCT FROM true OR p.kind<>'member' THEN RAISE EXCEPTION 'legacy_new_membership_inactive' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM authz.legacy_bridge_challenges WHERE id=challenge FOR UPDATE;
 PERFORM authz.legacy_bridge_check(challenge,nonce,aud,label,acts);
 selected:=CASE WHEN cardinality(acts)=0 THEN m.client_actions ELSE acts END;
 IF cardinality(selected)=0 OR NOT selected<@m.client_actions THEN RAISE EXCEPTION 'legacy_client_scope_expansion' USING ERRCODE='42501';END IF;
 -- Verification is a current identity proof. This new 8h member ticket has the
 -- same finite-login purpose as standard authn; long API keys use existing240.
 expiry:=clock_timestamp()+interval '8 hours';
 INSERT INTO authz.clients(principal_id,label,actions)VALUES(p.id,c.client_label,selected)RETURNING id INTO cid;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,is_primary,authority_source,legacy_map_id)VALUES(cid,access_hash,expiry,true,'legacy_hufu_verified',m.id)RETURNING id INTO cred;
 INSERT INTO authz.sessions(principal_id,token_hash,expires_at,refresh_expires_at)VALUES(p.id,access_hash,expiry,expiry);
 UPDATE authz.legacy_bridge_challenges SET completed_at=clock_timestamp(),legacy_map_id=m.id,credential_id=cred WHERE id=c.id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)VALUES(p.id,cid,'authz','legacy.identity_bridge',cred,jsonb_build_object('challenge_id',c.id,'mapping_id',m.id,'proof_source','old_hufu_access_verify','proof_expires_at',proof_expiry,'old_role_metadata',old_role_metadata,'role_imported',false,'qualification_imported',false,'primary_source','legacy_hufu_verified'));
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,payload)VALUES('authz',cred,1,'legacy.identity_bridged',jsonb_build_object('credential_id',cred,'member_id',p.id,'identity_mapping_id',m.id,'authorization','current_2_qualification_only'));
 IF c.expires_at<=clock_timestamp() OR proof_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'legacy_bridge_expired_before_effect' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','authenticated','actor_id',p.id,'client_id',cid,'credential_id',cred,'expires_at',expiry,'until_revoked',false,'is_primary',true,'credential_type','primary_member','role_imported',false,'qualification_imported',false,'client_actions',selected);
END $$;
CREATE FUNCTION authz.legacy_mapping_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF (NEW.issuer,NEW.subject_kind,NEW.legacy_subject,NEW.principal_id) IS DISTINCT FROM (OLD.issuer,OLD.subject_kind,OLD.legacy_subject,OLD.principal_id) THEN RAISE EXCEPTION 'legacy_mapping_identity_immutable';END IF;
 IF (NEW.active,NEW.client_actions) IS DISTINCT FROM (OLD.active,OLD.client_actions) THEN
  NEW.epoch:=greatest(NEW.epoch,OLD.epoch+1);
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE legacy_map_id=OLD.id AND revoked_at IS NULL;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER legacy_mapping_fence BEFORE UPDATE ON authz.legacy_member_maps FOR EACH ROW EXECUTE FUNCTION authz.legacy_mapping_fence();
REVOKE ALL ON FUNCTION authz.legacy_bridge_begin(text,text,text,text[]),authz.legacy_bridge_check(uuid,text,text,text,text[]),authz.legacy_bridge_finish(uuid,text,text,text,text[],text,timestamptz,text,text),authz.legacy_mapping_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.legacy_bridge_begin(text,text,text,text[]),authz.legacy_bridge_check(uuid,text,text,text,text[]),authz.legacy_bridge_finish(uuid,text,text,text,text[],text,timestamptz,text,text) TO hub2_hufu;
RESET ROLE;
