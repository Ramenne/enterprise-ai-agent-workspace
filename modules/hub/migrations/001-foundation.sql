-- Original 2.0 foundation. Applied by isolated migration identity only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_authz_owner') THEN CREATE ROLE hub2_authz_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_mem_owner') THEN CREATE ROLE hub2_mem_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_v8_owner') THEN CREATE ROLE hub2_v8_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_evidence_owner') THEN CREATE ROLE hub2_evidence_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_hufu') THEN CREATE ROLE hub2_hufu LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_mem') THEN CREATE ROLE hub2_mem LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_v8') THEN CREATE ROLE hub2_v8 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hub2_worker') THEN CREATE ROLE hub2_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; END IF;
END $roles$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hub2_authz_owner,hub2_mem_owner,hub2_v8_owner,hub2_evidence_owner;
CREATE SCHEMA IF NOT EXISTS authn AUTHORIZATION hub2_authz_owner;
CREATE SCHEMA IF NOT EXISTS authz AUTHORIZATION hub2_authz_owner;
CREATE SCHEMA IF NOT EXISTS mem AUTHORIZATION hub2_mem_owner;
CREATE SCHEMA IF NOT EXISTS v8 AUTHORIZATION hub2_v8_owner;
CREATE SCHEMA IF NOT EXISTS evidence AUTHORIZATION hub2_evidence_owner;
CREATE SCHEMA IF NOT EXISTS coord AUTHORIZATION hub2_evidence_owner;
CREATE SCHEMA IF NOT EXISTS jobs AUTHORIZATION hub2_evidence_owner;
GRANT USAGE ON SCHEMA authz TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker,hub2_mem_owner,hub2_v8_owner;
GRANT USAGE ON SCHEMA mem TO hub2_mem,hub2_v8_owner,hub2_worker;
GRANT USAGE ON SCHEMA v8 TO hub2_v8,hub2_authz_owner,hub2_mem_owner,hub2_worker;
GRANT USAGE ON SCHEMA evidence,coord TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker,hub2_authz_owner,hub2_mem_owner,hub2_v8_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE hub2_authz_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hub2_mem_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hub2_v8_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hub2_evidence_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE coord.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE evidence.audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid, client_id uuid, source_context_id uuid, domain text NOT NULL, action text NOT NULL,
 aggregate_id uuid, revision bigint, operation_id uuid, details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE evidence.outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 domain text NOT NULL, aggregate_id uuid NOT NULL, aggregate_revision bigint NOT NULL CHECK(aggregate_revision>0),
 event_type text NOT NULL, project_id uuid, payload jsonb NOT NULL DEFAULT '{}',
 group_index integer NOT NULL DEFAULT 1, group_size integer NOT NULL DEFAULT 1,
 delivered_at timestamptz, UNIQUE(domain,aggregate_id,aggregate_revision,group_index),
 CHECK(group_index>0 AND group_index<=group_size)
);
CREATE TABLE evidence.delivery_counter (id boolean PRIMARY KEY DEFAULT true CHECK(id), value bigint NOT NULL DEFAULT 0);
INSERT INTO evidence.delivery_counter DEFAULT VALUES;
CREATE TABLE evidence.delivery (
 seq bigint PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES evidence.outbox(id), delivered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE evidence.inbox (consumer text NOT NULL,event_id uuid NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(consumer,event_id));
CREATE TABLE evidence.field_usage (
 request_id uuid NOT NULL,service text NOT NULL,action text NOT NULL,path text NOT NULL,purpose text NOT NULL,
 schema_version text NOT NULL,source_context_id uuid,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,service,action,path,purpose)
);
ALTER TABLE evidence.audit OWNER TO hub2_evidence_owner;
ALTER TABLE evidence.outbox OWNER TO hub2_evidence_owner;
ALTER TABLE evidence.delivery_counter OWNER TO hub2_evidence_owner;
ALTER TABLE evidence.delivery OWNER TO hub2_evidence_owner;
ALTER TABLE evidence.inbox OWNER TO hub2_evidence_owner;
ALTER TABLE evidence.field_usage OWNER TO hub2_evidence_owner;
GRANT INSERT ON evidence.audit,evidence.outbox,evidence.field_usage TO hub2_authz_owner,hub2_mem_owner,hub2_v8_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA evidence FROM PUBLIC;
