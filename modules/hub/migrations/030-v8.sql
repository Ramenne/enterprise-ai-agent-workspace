-- Original V8 infrastructure model. Stable identity and fixed evidence are independent of presentation.
GRANT REFERENCES ON mem.content_versions TO hub2_v8_owner;
SET ROLE hub2_v8_owner;
CREATE TABLE v8.projects (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('project','dialogue')),
  visibility text NOT NULL CHECK(visibility IN ('personal','team')),
  owner_id uuid NOT NULL, manager_id uuid NOT NULL, title text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  event_revision bigint NOT NULL DEFAULT 1 CHECK(event_revision>0),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE SEQUENCE v8.work_short_no START 1000000 NO CYCLE;
CREATE TABLE v8.work_items (
  id uuid PRIMARY KEY, short_no bigint NOT NULL UNIQUE DEFAULT nextval('v8.work_short_no'),
  project_id uuid NOT NULL REFERENCES v8.projects(id), actor_id uuid NOT NULL, client_id uuid NOT NULL,
  source_context_id uuid, goal text NOT NULL, description text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','in_progress','completed','cancelled')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),event_revision bigint NOT NULL DEFAULT 1 CHECK(event_revision>0),
  related_evaluated boolean NOT NULL DEFAULT false, completed_receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE v8.results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),
  material_id uuid NOT NULL,version_id uuid NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  role text NOT NULL, explanation jsonb NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id)
);
CREATE TABLE v8.work_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),from_work_id uuid NOT NULL REFERENCES v8.work_items(id),
  to_work_id uuid NOT NULL REFERENCES v8.work_items(id),basis jsonb NOT NULL,
  actor_id uuid NOT NULL,source_context_id uuid, supersedes uuid REFERENCES v8.work_relations(id),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn','corrected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(from_work_id<>to_work_id)
);
CREATE INDEX work_relations_from ON v8.work_relations(from_work_id);
CREATE INDEX work_relations_to ON v8.work_relations(to_work_id);
CREATE TABLE v8.adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),
  material_id uuid NOT NULL,version_id uuid NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  role text NOT NULL,reason text NOT NULL,revision bigint NOT NULL CHECK(revision>0),
  actor_id uuid NOT NULL,source_context_id uuid,supersedes uuid REFERENCES v8.adoptions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(work_item_id,role,revision),FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id)
);
CREATE TABLE v8.operations (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL,client_id uuid NOT NULL,project_id uuid NOT NULL REFERENCES v8.projects(id),
  idempotency_key text NOT NULL,fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),
  action text NOT NULL,state text NOT NULL CHECK(state IN ('committed','conflict','rejected')),
  result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key)
);
CREATE TABLE v8.context_manifests (
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES v8.projects(id),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),
  work_revision bigint NOT NULL,actor_id uuid NOT NULL,source_context_id uuid,
  manifest jsonb NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
  source_coverage text NOT NULL CHECK(source_coverage IN ('raw_export','user_attachment','agent_summary','partial','unknown')),
  state text NOT NULL DEFAULT 'current' CHECK(state IN ('current','stale','invalid')),
  stale_reason text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE v8.context_sources (
  context_id uuid NOT NULL REFERENCES v8.context_manifests(id),material_id uuid NOT NULL,version_id uuid NOT NULL,
  sha256 text NOT NULL,role text NOT NULL,
  PRIMARY KEY(context_id,material_id,version_id,role),FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id)
);
CREATE TABLE v8.context_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),context_id uuid NOT NULL REFERENCES v8.context_manifests(id),
  actor_id uuid NOT NULL,client_id uuid NOT NULL,source_context_id uuid,returned_view jsonb NOT NULL,
  coverage jsonb NOT NULL,acknowledged_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE v8.handoffs (
  id uuid PRIMARY KEY,work_item_id uuid NOT NULL REFERENCES v8.work_items(id),context_id uuid NOT NULL REFERENCES v8.context_manifests(id),
  from_actor_id uuid NOT NULL,to_actor_id uuid NOT NULL,from_source_context_id uuid,to_source_context_id uuid,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','accepted','continued','declined')),
  rationale text NOT NULL,next_actions jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE v8.experiences (
  id uuid PRIMARY KEY,work_item_id uuid NOT NULL REFERENCES v8.work_items(id),material_id uuid NOT NULL,version_id uuid NOT NULL,
  sha256 text NOT NULL,conditions jsonb NOT NULL,evidence jsonb NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','published','stale','superseded','withdrawn')),
  revision bigint NOT NULL DEFAULT 1,supersedes uuid REFERENCES v8.experiences(id),actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id)
);
CREATE TABLE v8.experience_feedback (
  id uuid PRIMARY KEY,experience_id uuid NOT NULL REFERENCES v8.experiences(id),work_item_id uuid REFERENCES v8.work_items(id),
  actor_id uuid NOT NULL,source_context_id uuid,kind text NOT NULL CHECK(kind IN ('used','counterexample','correction','inapplicable')),
  explanation text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE v8.legacy_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_system text NOT NULL,source_kind text NOT NULL,
  source_id text NOT NULL,original_address text NOT NULL,reference_kind text NOT NULL CHECK(reference_kind IN ('fixed','latest','unknown')),
  target_material_id uuid,target_version_id uuid,verification_state text NOT NULL DEFAULT 'pending',
  evidence jsonb NOT NULL DEFAULT '{}',UNIQUE(source_system,source_kind,source_id,original_address)
);
REVOKE ALL ON ALL TABLES IN SCHEMA v8 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA v8 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
RESET ROLE;
GRANT SELECT ON v8.projects TO hub2_authz_owner,hub2_mem_owner;
-- PostgreSQL row-locking SELECT needs UPDATE privilege on at least one column.
-- Only the internal authorization owner receives the shared authorization fence column.
GRANT UPDATE(epoch) ON v8.projects TO hub2_authz_owner;
GRANT SELECT(id,sha256,size,availability) ON mem.verified_objects TO hub2_v8_owner;

SET ROLE hub2_v8_owner;
ALTER TABLE v8.work_items ADD COLUMN explanation jsonb;
ALTER TABLE v8.experiences ADD COLUMN event_revision bigint NOT NULL DEFAULT 1 CHECK(event_revision>0);
ALTER TABLE v8.context_manifests ADD COLUMN refreshes_context_id uuid REFERENCES v8.context_manifests(id);
ALTER TABLE v8.experience_feedback ADD COLUMN material_id uuid, ADD COLUMN version_id uuid, ADD COLUMN sha256 text;
ALTER TABLE v8.experience_feedback ADD FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id);
CREATE TABLE v8.work_read_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),work_revision bigint NOT NULL,actor_id uuid NOT NULL,client_id uuid NOT NULL,source_context_id uuid,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','sent','acknowledged')),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE v8.work_executions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_item_id uuid NOT NULL REFERENCES v8.work_items(id),actor_id uuid NOT NULL,client_id uuid NOT NULL,source_context_id uuid,context_view_id uuid REFERENCES v8.context_views(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON v8.work_read_receipts,v8.work_executions FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
RESET ROLE;
