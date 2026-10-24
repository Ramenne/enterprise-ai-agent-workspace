# Native Vault entry registration and first custody

The existing metadata routes are /v2/vault/entries/register, update, disable.
GET /v2/vault/entries/help makes their contracts discoverable.

New /v2/vault/secret/initialize accepts entry_id, expected_revision,
idempotency_key and value over authenticated HTTPS. Use only native newly
registered entries whose private ref is still uninitialized.
The current manager, software ceiling and project/resource filters are checked.
Sensitive entries additionally require an existing live management confirmation.
No grants or cloud permissions are minted.

The private writer is restricted to the existing OpenBao operations namespace.
Value fingerprints bind retries; values never enter SQL, receipts or logs.
initialize_status and initialize_reconcile use the original operation_id.
Unknown writes are read back and reconciled, never blindly reissued.
Concurrent metadata/content changes retain the private candidate and return conflict.
Existing ordinary rotate and native member claim flows retain their boundaries.

Migration: migrations/hufu/826-initial-secret-custody.sql
Checks: node packages/vault/next/src/initial-secret-service.test.mjs
