import {requestAuthorization} from './authorization-transport.mjs';
import { DomainError } from './http.js';
import { digest } from './canonical.js';

export interface Decision { handle: string; actor_id: string; client_id: string; project_id: string; source_context_id?: string; expires_at: string; }
export interface DecisionConfig { hufuUrl: string; serviceKey: string; audience: 'mem' | 'v8' | 'worker'; }

export async function decide(config: DecisionConfig, token: string, action: string, resource: Record<string, unknown>,
  body: Record<string, unknown>, source?: unknown): Promise<Decision> {
  return await requestAuthorization(config,token,'/internal/decision',{audience:config.audience,action,resource,request_digest:digest(body),...(source?{source_context:source}:{})},DomainError) as unknown as Decision;
}
