import { DomainError } from '../../../packages/platform/src/http.js';
export interface Source { provider: string; native_key: string | null; envelope: Record<string, unknown>; }
export function normalizeSource(value: unknown): Source {
 if(value === undefined || value === null) return {provider:'unknown',native_key:null,envelope:{provider:'unknown',assurance:'unknown'}};
 if(typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid_source');
 const o=value as Record<string,unknown>;
 for(const key of ['actor_id','member_id','client_id','principal_id']) if(key in o) throw new DomainError('source_identity_forbidden');
 const provider=o['provider']; if(typeof provider!=='string'||!provider||provider.length>80) throw new DomainError('invalid_source');
 const field=provider.toLowerCase()==='codex'?'native_thread_id':'native_session_id';
 const key=o[field]; if(key!==undefined&&(typeof key!=='string'||key.length>512||!key)) throw new DomainError('invalid_source');
 return {provider,native_key:typeof key==='string'?key:null,envelope:{...o,assurance:typeof key==='string'?'self_reported':'unknown'}};
}
