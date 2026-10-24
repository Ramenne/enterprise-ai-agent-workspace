import {requestAuthorization} from './authorization-transport.mjs';
import { DomainError } from './http.js';
import { digest } from './canonical.js';
export async function decide(config, token, action, resource, body, source) {
    return await requestAuthorization(config,token,'/internal/decision',{audience:config.audience,action,resource,request_digest:digest(body),...(source?{source_context:source}:{})},DomainError);
}
