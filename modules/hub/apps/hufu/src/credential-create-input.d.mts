export class CredentialCreateInputError extends Error {
  code: string;
  validation_errors: Array<{path: string; requirement: unknown}>;
  constructor(code: string, issues: Array<{path: string; requirement: unknown}>);
}
export function normalizeCredentialCreate(body: Record<string, unknown>): Record<string, unknown>;
export function requestedProjectIds(body: Record<string, unknown>): string[] | null;
export function confirmsCurrentProjectScope(result: Record<string, unknown>, ids: string[] | null): boolean;
