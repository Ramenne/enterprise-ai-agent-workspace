import { apiRequest } from "@/api/client";
const base = "/api/employeeclient/collaboration";
export interface Computer {
  id: string;
  name: string;
  online: boolean;
  seen: number | null;
  revoked: number | null;
}
export interface Command {
  id: string;
  computer_id: string;
  state:
    | "queued"
    | "claimed"
    | "unconfirmed"
    | "expired"
    | "cancelled"
    | "done"
    | "purged";
  result: unknown;
  wait_deferred?: boolean;
  wait_supported?: boolean;
}
export const collaboration = {
  computers: (signal: AbortSignal) =>
    apiRequest<{ computers: Computer[] }>("GET", base + "/computers", {
      signal,
    }),
  watch: (id:string, watchId:string, provider:string, thread:string|null, signal:AbortSignal) =>
    apiRequest<{revision:number}>('POST',base+'/computers/'+encodeURIComponent(id)+'/watch',{
      body:{watch_id:watchId,provider,thread_id:thread},signal}),
  events: (id:string, watchId:string, after:number, signal:AbortSignal) =>
    apiRequest<{revision:number;changed:boolean;wait_deferred?:boolean;watch_active?:boolean}>('GET',base+'/computers/'+encodeURIComponent(id)+'/events',{
      query:{watch_id:watchId,after,wait:15},signal,timeoutMs:20000}),
  pair: (code: string, signal: AbortSignal) =>
    apiRequest<Computer>("POST", base + "/pairings/confirm", {
      body: { code },
      signal,
    }),
  revoke: (id: string, signal: AbortSignal) =>
    apiRequest("DELETE", base + "/computers/" + encodeURIComponent(id), {
      signal,
    }),
  submit: (
    computerId: string,
    id: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ) =>
    apiRequest<Command>(
      "POST",
      base + "/computers/" + encodeURIComponent(computerId) + "/commands",
      { body: { id, request }, signal },
    ),
  command: (id: string, signal: AbortSignal, after?:string) =>
    apiRequest<Command>("GET", base + "/commands/" + encodeURIComponent(id), {
      signal, query:{wait:15,after}, timeoutMs:20000,
    }),
};
