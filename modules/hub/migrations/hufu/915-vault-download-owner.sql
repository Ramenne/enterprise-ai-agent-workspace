-- Apply as current wrapper owner (postgres/bootstrap), not as a member.
-- Existing NOLOGIN authz owner must call the authenticated wrapper during consume.
GRANT EXECUTE ON FUNCTION vault2.delivery_download_prepare(text,uuid) TO hub2_authz_owner;
