-- Apply as current postgres/bootstrap owner. Only existing NOLOGIN authz owner.
-- Retain original entry/item grant, actor/client/credential and scope guards.
GRANT EXECUTE ON FUNCTION vault2.entry_claim_guard(text,uuid) TO hub2_authz_owner;
