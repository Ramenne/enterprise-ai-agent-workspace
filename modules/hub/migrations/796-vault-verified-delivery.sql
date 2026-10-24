BEGIN;
CREATE TABLE vault2.delivery_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL,
 recipient_id uuid NOT NULL REFERENCES authz.principals(id),
 secret_ref text NOT NULL CHECK(secret_ref ~ '^bao:hub2/hufu/vault2/operations/[0-9a-f-]{36}$'),
 secret_version integer NOT NULL CHECK(secret_version>0), filename text NOT NULL,
 expires_at timestamptz NOT NULL, active boolean NOT NULL DEFAULT true,
 scope jsonb NOT NULL DEFAULT '{}', source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vault2.delivery_challenges (
 id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES vault2.delivery_items(id),
 actor_id uuid NOT NULL, client_id uuid NOT NULL, credential_id uuid NOT NULL,
 email text NOT NULL, code_mac text NOT NULL, expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending_send',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON vault2.delivery_challenges(actor_id,created_at);
CREATE TABLE vault2.delivery_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge_id uuid UNIQUE NOT NULL REFERENCES vault2.delivery_challenges(id),
 item_id uuid NOT NULL REFERENCES vault2.delivery_items(id),
 actor_id uuid NOT NULL, client_id uuid NOT NULL, credential_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'ready', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vault2.delivery_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),item_id uuid NOT NULL,actor_id uuid,
 event text NOT NULL, challenge_id uuid, ticket_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON vault2.delivery_items,vault2.delivery_challenges,vault2.delivery_tickets,vault2.delivery_audit FROM PUBLIC;
CREATE UNIQUE INDEX ON vault2.delivery_items(source);
CREATE FUNCTION vault2.delivery_recipients(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;p authz.principals;r jsonb; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;
 IF NOT coalesce((i->>'is_primary')::boolean,false) OR p.role<>'organization_admin' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name) ORDER BY display_name),'[]'::jsonb) INTO r FROM authz.principals WHERE organization_id=p.organization_id AND active AND kind='member';
 RETURN jsonb_build_object('items',r);
END $$;

CREATE FUNCTION vault2.delivery_register_prepare(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;p authz.principals;r authz.principals;d vault2.delivery_items;key text;new_id uuid;expiry timestamptz; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;
 SELECT * INTO r FROM authz.principals WHERE id=(b->>'recipient_id')::uuid;
 IF NOT coalesce((i->>'is_primary')::boolean,false) OR p.role<>'organization_admin' OR r.id IS NULL OR NOT r.active OR r.kind<>'member' OR r.organization_id<>p.organization_id
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 expiry:=(b->>'expires_at')::timestamptz;
 IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'expiry_required' USING ERRCODE='22023'; END IF;
 key:='api:'||(i->>'actor_id')||':'||(b->>'idempotency_key');
 SELECT * INTO d FROM vault2.delivery_items WHERE source=key;
 IF d.id IS NULL THEN
 new_id:=gen_random_uuid();
 INSERT INTO vault2.delivery_items(id,title,recipient_id,secret_ref,secret_version,filename,expires_at,scope,source,active)
 VALUES(new_id,b->>'title',r.id,'bao:hub2/hufu/vault2/operations/'||new_id,1,b->>'filename',expiry,coalesce(b->'scope','{}'::jsonb),key,false) RETURNING * INTO d;
 END IF;
 IF d.recipient_id<>r.id OR d.filename<>b->>'filename' THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
 RETURN jsonb_build_object('item_id',d.id,'state',CASE WHEN d.active THEN 'ready' ELSE 'pending' END,'secret_ref',d.secret_ref);
END $$;
CREATE FUNCTION vault2.delivery_register_finish(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;d vault2.delivery_items; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 SELECT * INTO d FROM vault2.delivery_items WHERE id=(b->>'item_id')::uuid AND source LIKE 'api:'||(i->>'actor_id')||':%' FOR UPDATE;
 IF NOT coalesce((i->>'is_primary')::boolean,false) OR d.id IS NULL OR NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 UPDATE vault2.delivery_items SET secret_version=(b->>'secret_version')::int,active=true WHERE id=d.id;
 INSERT INTO vault2.delivery_audit(item_id,actor_id,event) VALUES(d.id,(i->>'actor_id')::uuid,'registered');
 RETURN jsonb_build_object('state','registered','item_id',d.id,'recipient_id',d.recipient_id,'expires_at',d.expires_at);
END $$;

CREATE FUNCTION vault2.delivery_identity(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 IF NOT coalesce((i->>'is_primary')::boolean,false) AND NOT(i->'client_actions' ? 'hufu.vault.read')
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 -- This first delivery scope is a direct personal grant. Project-filtered
 -- software must not silently escape its filter through a personal key.
 IF NOT coalesce((i->>'is_primary')::boolean,false) AND i->'scope_filters'<>'[]'::jsonb
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN i;
END $$;

CREATE FUNCTION vault2.delivery_list(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;result jsonb; BEGIN
 i:=vault2.delivery_identity(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'filename',filename,'expires_at',expires_at,'scope',scope) ORDER BY created_at DESC),'[]'::jsonb) INTO result
 FROM vault2.delivery_items WHERE recipient_id=(i->>'actor_id')::uuid AND active AND expires_at>clock_timestamp();
 RETURN jsonb_build_object('items',result,'verification','bound_member_email_otp');
END $$;

CREATE FUNCTION vault2.delivery_prepare(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;d vault2.delivery_items;mail text;valid_until timestamptz; BEGIN
 i:=vault2.delivery_identity(proof);
 SELECT * INTO d FROM vault2.delivery_items WHERE id=(b->>'item_id')::uuid AND active AND expires_at>clock_timestamp() AND recipient_id=(i->>'actor_id')::uuid FOR SHARE;
 IF d.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT u.email INTO mail FROM authz.member_accounts a JOIN authn."user" u ON u.id=a.authn_user_id WHERE a.principal_id=d.recipient_id AND u."emailVerified" LIMIT 1;
 IF mail IS NULL THEN RETURN jsonb_build_object('state','failed','error_code','verified_member_email_required'); END IF;
 IF (SELECT count(*) FROM vault2.delivery_challenges WHERE actor_id=d.recipient_id AND created_at>clock_timestamp()-interval '1 minute')>=3
 THEN RETURN jsonb_build_object('state','failed','error_code','otp_rate_limited'); END IF;
 valid_until:=least(d.expires_at,clock_timestamp()+interval '5 minutes');
 INSERT INTO vault2.delivery_challenges(id,item_id,actor_id,client_id,credential_id,email,code_mac,expires_at)
 VALUES((b->>'challenge_id')::uuid,d.id,d.recipient_id,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,mail,b->>'code_mac',valid_until);
 RETURN jsonb_build_object('state','pending_send','challenge_id',b->>'challenge_id','email',mail,'expires_at',valid_until);
END $$;

CREATE FUNCTION vault2.delivery_send_finish(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;c vault2.delivery_challenges; BEGIN
 i:=vault2.delivery_identity(proof);
 SELECT * INTO c FROM vault2.delivery_challenges WHERE id=(b->>'challenge_id')::uuid AND actor_id=(i->>'actor_id')::uuid AND credential_id=(i->>'credential_id')::uuid FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF c.state='pending_send' THEN UPDATE vault2.delivery_challenges SET state=CASE WHEN b->>'result'='sent' THEN 'sent' ELSE 'send_unknown' END WHERE id=c.id; END IF;
 RETURN jsonb_build_object('state',CASE WHEN b->>'result'='sent' THEN 'verification_sent' ELSE 'send_unknown' END,'challenge_id',c.id,'expires_at',c.expires_at);
END $$;

CREATE FUNCTION vault2.delivery_verify(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;c vault2.delivery_challenges;d vault2.delivery_items;t vault2.delivery_tickets; BEGIN
 i:=vault2.delivery_identity(proof);
 SELECT * INTO c FROM vault2.delivery_challenges WHERE id=(b->>'challenge_id')::uuid AND actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM vault2.delivery_items WHERE id=c.item_id AND recipient_id=c.actor_id AND active AND expires_at>clock_timestamp() FOR SHARE;
 IF d.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF c.state NOT IN('sent','send_unknown') OR c.expires_at<=clock_timestamp() OR c.attempts>=3 THEN RETURN jsonb_build_object('state','failed','error_code','verification_expired_or_used'); END IF;
 IF c.code_mac<>b->>'code_mac' THEN
 UPDATE vault2.delivery_challenges SET attempts=attempts+1 WHERE id=c.id;
 INSERT INTO vault2.delivery_audit(item_id,actor_id,event,challenge_id) VALUES(d.id,c.actor_id,'verification_failed',c.id);
 RETURN jsonb_build_object('state','failed','error_code','invalid_verification_code'); END IF;
 UPDATE vault2.delivery_challenges SET state='verified',code_mac='consumed' WHERE id=c.id;
 INSERT INTO vault2.delivery_tickets(challenge_id,item_id,actor_id,client_id,credential_id,expires_at)
 VALUES(c.id,d.id,c.actor_id,c.client_id,c.credential_id,least(d.expires_at,clock_timestamp()+interval '2 minutes')) RETURNING * INTO t;
 INSERT INTO vault2.delivery_audit(item_id,actor_id,event,challenge_id,ticket_id) VALUES(d.id,c.actor_id,'verified',c.id,t.id);
 RETURN jsonb_build_object('state','verified','delivery_id',t.id,'expires_at',t.expires_at,'filename',d.filename,'delivery','authenticated_one_time_download');
END $$;

CREATE FUNCTION vault2.delivery_download_prepare(proof text,ticket uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;t vault2.delivery_tickets;d vault2.delivery_items; BEGIN
 i:=vault2.delivery_identity(proof);
 SELECT * INTO t FROM vault2.delivery_tickets WHERE id=ticket AND actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid AND state='ready' AND expires_at>clock_timestamp();
 IF t.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM vault2.delivery_items WHERE id=t.item_id AND recipient_id=t.actor_id AND active AND expires_at>clock_timestamp() FOR SHARE;
 IF d.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('secret_ref',d.secret_ref,'secret_version',d.secret_version,'filename',d.filename,'item_id',d.id);
END $$;
CREATE FUNCTION vault2.delivery_download_consume(proof text,ticket uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE p jsonb;t vault2.delivery_tickets;r uuid; BEGIN
 p:=vault2.delivery_download_prepare(proof,ticket);
 SELECT * INTO t FROM vault2.delivery_tickets WHERE id=ticket FOR UPDATE;
 IF t.state<>'ready' OR t.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 UPDATE vault2.delivery_tickets SET state='response_prepared' WHERE id=t.id;
 INSERT INTO vault2.delivery_audit(item_id,actor_id,event,challenge_id,ticket_id) VALUES(t.item_id,t.actor_id,'response_prepared',t.challenge_id,t.id) RETURNING id INTO r;
 RETURN jsonb_build_object('state','response_prepared','receipt_id',r);
END $$;

-- Runtime may execute only the authenticated capabilities; no table access.
REVOKE ALL ON FUNCTION vault2.delivery_identity(text),vault2.delivery_list(text),vault2.delivery_prepare(text,jsonb),vault2.delivery_send_finish(text,jsonb),vault2.delivery_verify(text,jsonb),vault2.delivery_download_prepare(text,uuid),vault2.delivery_download_consume(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.delivery_list(text),vault2.delivery_prepare(text,jsonb),vault2.delivery_send_finish(text,jsonb),vault2.delivery_verify(text,jsonb),vault2.delivery_download_prepare(text,uuid),vault2.delivery_download_consume(text,uuid) TO hub2_hufu;
REVOKE ALL ON FUNCTION vault2.delivery_register_prepare(text,jsonb),vault2.delivery_register_finish(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.delivery_register_prepare(text,jsonb),vault2.delivery_register_finish(text,jsonb) TO hub2_hufu;
REVOKE ALL ON FUNCTION vault2.delivery_recipients(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.delivery_recipients(text) TO hub2_hufu;

DO $owners$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vault2' AND c.relkind='r' AND c.relname IN('delivery_items','delivery_challenges','delivery_tickets','delivery_audit') LOOP
 EXECUTE format('ALTER TABLE vault2.%I OWNER TO hub2_authz_owner',r.relname);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='vault2' AND p.proname LIKE 'delivery_%' LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO hub2_authz_owner',r.signature);
 END LOOP;
END $owners$;
COMMIT;
