export interface Failure { code: string; status: number; retryable: boolean; cause_category: string }
export interface Diagnostic { error_code: string; cause_category: string }
export function infrastructureFailure(error: Error & {code?: string}, options?: {permissionCode?: unknown}): Failure | null;
export function domainErrorCode(value: unknown, fallback: string): string;
export function infrastructureResponse(failure: Failure, requestId?: string, options?: {legacyCode?: string | undefined}): {status: number; body: {state: string; error_code: string; retryable: boolean; request_id?: string}; diagnostic: Diagnostic};
export function platformFailure(error: Error, options?: {explicit?: boolean; requestId?: string}): {status: number; body: {state: string; error_code: string; retryable: boolean; retained_state: string; next_step: string; request_id?: string}; diagnostic: Diagnostic};
