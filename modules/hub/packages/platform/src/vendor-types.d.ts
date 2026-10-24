// Better Auth's cross-runtime public option type imports bun:sqlite even for PostgreSQL.
// Load the complete pinned upstream SQLite module declaration without Bun's incompatible
// global runtime overrides. This Node service does not execute the Bun database adapter.
/// <reference path="../../../node_modules/bun-types/sqlite.d.ts" />
