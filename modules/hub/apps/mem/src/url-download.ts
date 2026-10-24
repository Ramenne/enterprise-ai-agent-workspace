/** Public-only, bounded URL material acquisition. No caller credentials or network options. */
import {DomainError} from '../../../packages/platform/src/http.js';
import type {IOBudget,BudgetLease} from '../../../packages/platform/src/machine-budget.js';
import {createHash, randomUUID} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {createWriteStream} from 'node:fs';
import {link, open, rm} from 'node:fs/promises';
import {Agent as HttpAgent, request as httpRequest, type IncomingMessage} from 'node:http';
import {Agent as HttpsAgent, request as httpsRequest} from 'node:https';
import {isIP, connect as netConnect, type Socket} from 'node:net';
import {isAbsolute,dirname} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {checkServerIdentity, connect as tlsConnect, type TLSSocket} from 'node:tls';

const MAX_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_KEYS = new Set([
  'accesskey', 'accesskeyid', 'accesssecret', 'accesstoken', 'apikey', 'apisecret',
  'auth', 'authorization', 'authtoken', 'authkey', 'bearer', 'clientkey', 'clientsecret', 'code', 'cookie', 'credential',
  'credentials', 'idtoken', 'jwt', 'key', 'pass', 'passwd', 'password', 'privatekey', 'pwd', 'refreshtoken', 'secret', 'secretkey',
  'session', 'sessionid', 'sessiontoken', 'sig', 'signature', 'token', 'awsaccesskeyid',
  'xamzcredential', 'xamzsecuritytoken', 'xamzsignature', 'xgoogcredential', 'xgoogsignature',
]);
export type UrlDownloadErrorCode =
  | 'url_invalid' | 'url_protocol_forbidden' | 'url_credentials_forbidden'
  | 'url_address_forbidden' | 'url_dns_failed' | 'url_socket_mismatch'
  | 'url_tls_invalid' | 'url_network_failed' | 'url_redirect_limit'
  | 'url_redirect_invalid' | 'url_http_status' | 'url_content_encoding'
  | 'url_too_large' | 'url_timeout' | 'url_storage_failed';

/** Deliberately contains no raw URL, response header, low-level error, or cause. */
export class UrlDownloadError extends Error {
  readonly code: UrlDownloadErrorCode;
  constructor(code: UrlDownloadErrorCode) {
    super(code);
    this.name = 'UrlDownloadError';
    this.code = code;
  }
}
export function urlDownloadErrorCode(error: unknown): UrlDownloadErrorCode {
  return error instanceof UrlDownloadError ? error.code : 'url_network_failed';
}

export interface UrlDownloadResult {
  sha256: string;
  size: number;
  source_url_redacted: string;
  redirect_count: number;
  content_type: string | null;
}

function parseSourceUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8192 || /[\u0000-\u0020\u007f]/u.test(rawUrl)) {
    throw new UrlDownloadError('url_invalid');
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new UrlDownloadError('url_invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlDownloadError('url_protocol_forbidden');
  // Even empty userinfo is rejected. URL canonicalization also catches numeric/hex IPv4 forms.
  const authority = /^[a-z]+:\/\/([^/?#]*)/iu.exec(rawUrl)?.[1];
  if (url.username || url.password || authority?.includes('@')) throw new UrlDownloadError('url_credentials_forbidden');
  if (!url.hostname || url.hostname.includes('%')) throw new UrlDownloadError('url_invalid');
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (key.includes('%') || CREDENTIAL_KEYS.has(normalized) || /(?:token|password|passwd|secret|credential|authorization|signature|cookie)$/u.test(normalized)) {
      throw new UrlDownloadError('url_credentials_forbidden');
    }
  }
  url.hash = '';
  return url;
}

/** Input fingerprint retains query distinctions without persisting the query. Fragment is not sent. */
export function canonicalFingerprint(rawUrl: string): string {
  return createHash('sha256').update(parseSourceUrl(rawUrl).href).digest('hex');
}
export function redactSourceUrl(rawUrl: string): string {
  const url = parseSourceUrl(rawUrl);
  url.search = '';
  url.hash = '';
  return url.href;
}

function ipv4Value(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}
function ipv6Value(address: string): bigint {
  let hex = address.toLowerCase();
  if (hex.includes('.')) {
    const split = hex.lastIndexOf(':');
    const v4 = ipv4Value(hex.slice(split + 1));
    hex = `${hex.slice(0, split)}:${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = hex.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}
function inPrefix(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  return (value >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));
}

// IANA special-purpose ranges, plus multicast. Conservative exclusions include transition
// mechanisms and special protocol destinations; these are not ordinary public material hosts.
const V4_FORBIDDEN: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['168.63.129.16', 32], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_FORBIDDEN: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
];
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    return !V4_FORBIDDEN.some(([base, prefix]) => inPrefix(value, ipv4Value(base), prefix, 32));
  }
  if (family === 6) {
    const value = ipv6Value(address);
    // Excludes mapped/compatible v4, ULA, loopback, link-local, multicast, NAT64, and reserved space.
    return inPrefix(value, ipv6Value('2000::'), 3, 128)
      && !V6_FORBIDDEN.some(([base, prefix]) => inPrefix(value, ipv6Value(base), prefix, 128));
  }
  return false;
}
function normalizedAddress(address: string): string {
  if (isIP(address) === 4) return `4:${ipv4Value(address)}`;
  if (isIP(address) === 6) {
    const value = ipv6Value(address);
    // Kernels can report an IPv4 connection as IPv4-mapped IPv6. Only remote normalization uses this.
    if ((value >> 32n) === 0xffffn) return `4:${value & 0xffffffffn}`;
    return `6:${value}`;
  }
  return '';
}
function hostnameOf(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}
interface ApprovedAddress { address: string; family: 4 | 6 }

// Cancellation must settle our wait even when a native stream has not emitted its final close.
function waitBounded<T>(work: Promise<T>, signal: AbortSignal, lateResult?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new UrlDownloadError('url_timeout'));
    };
    signal.addEventListener('abort', abort, {once: true});
    work.then(value => {
      signal.removeEventListener('abort', abort);
      if (settled) { lateResult?.(value); return; }
      settled = true;
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

async function resolveApproved(url: URL, signal: AbortSignal): Promise<ApprovedAddress> {
  signal.throwIfAborted();
  const hostname = hostnameOf(url);
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname)) throw new UrlDownloadError('url_address_forbidden');
    return {address: hostname, family: literalFamily as 4 | 6};
  }
  const resolver = new Resolver({timeout: 1000, tries: 2});
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, {once: true});
  try {
    const settled = await waitBounded(Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]), signal);
    signal.throwIfAborted();
    const addresses: ApprovedAddress[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      if (result.status === 'rejected') {
        const code = (result.reason as {code?: unknown} | null)?.code;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw new UrlDownloadError('url_dns_failed');
      } else {
        for (const address of result.value) {
          if (isIP(address) !== (i === 0 ? 4 : 6) || !isPublicAddress(address)) throw new UrlDownloadError('url_address_forbidden');
          addresses.push({address, family: i === 0 ? 4 : 6});
        }
      }
    }
    if (addresses.length === 0 || addresses.length > 256) throw new UrlDownloadError('url_dns_failed');
    // One vetted address is pinned. No second lookup, address fallback, proxy, or pooled socket.
    return addresses[0]!;
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}
function verifyRemote(socket: Socket, approved: ApprovedAddress): void {
  const remote = socket.remoteAddress;
  if (!remote || normalizedAddress(remote) !== normalizedAddress(approved.address)) throw new UrlDownloadError('url_socket_mismatch');
  // The pinned address already passed the public policy; exact equality prevents rebinding.
}
function sanitizedNetworkError(error: unknown, signal: AbortSignal): UrlDownloadError {
  if (signal.aborted) return new UrlDownloadError('url_timeout');
  if (error instanceof UrlDownloadError) return error;
  const code = String((error as {code?: unknown} | null)?.code ?? '');
  return new UrlDownloadError(/(?:CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO)/u.test(code) ? 'url_tls_invalid' : 'url_network_failed');
}
interface HopResponse { response: IncomingMessage; agent: HttpAgent | HttpsAgent }

function requestPinned(url: URL, approved: ApprovedAddress, signal: AbortSignal): Promise<HopResponse> {
  const secure = url.protocol === 'https:';
  const hostname = hostnameOf(url);
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const agent = secure
    ? new HttpsAgent({keepAlive: false, maxSockets: 1, proxyEnv: {}})
    : new HttpAgent({keepAlive: false, maxSockets: 1, proxyEnv: {}});
  // The asynchronous Agent callback receives the socket only after IP pin verification.
  agent.createConnection = (_options, callback) => {
    let socket: Socket | TLSSocket;
    const onAbort = () => socket.destroy(new UrlDownloadError('url_timeout'));
    let completed = false;
    const done = (error?: unknown) => {
      if (completed) return;
      completed = true;
      socket.removeListener('error', done);
      signal.removeEventListener('abort', onAbort);
      if (error) {
        socket.destroy();
        callback?.(sanitizedNetworkError(error, signal), socket);
        return;
      }
      try { verifyRemote(socket, approved); }
      catch (failure) { socket.destroy(); callback?.(sanitizedNetworkError(failure, signal), socket); return; }
      callback?.(null, socket);
    };
    const transport = netConnect({host: approved.address, port, family: approved.family, autoSelectFamily: false});
    socket = transport;
    if (secure) {
      transport.once('connect', () => {
        if (completed || signal.aborted) { transport.destroy(); return; }
        try { verifyRemote(transport, approved); }
        catch (failure) { done(failure); return; }
        transport.removeListener('error', done);
        socket = tlsConnect({
          socket: transport,
          ...(isIP(hostname) ? {} : {servername: hostname}),
          rejectUnauthorized: true,
          checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
          ALPNProtocols: ['http/1.1'],
        });
        socket.once('secureConnect', () => done());
        socket.once('error', done);
      });
    } else {
      transport.once('connect', () => done());
    }
    transport.once('error', done);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
    return undefined as unknown as Socket;
  };
  return waitBounded(new Promise<HopResponse>((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname, port,
      path: `${url.pathname}${url.search}`,
      method: 'GET', agent, signal,
      maxHeaderSize: 8192,
      headers: {
        Host: url.host,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Workspace-Hub2-URL-Importer/2.0',
        Connection: 'close',
      },
    }, response => resolve({response, agent}));
    request.once('error', error => { agent.destroy(); reject(sanitizedNetworkError(error, signal)); });
    request.end();
  }), signal, ({response, agent: abandonedAgent}) => { response.destroy(); abandonedAgent.destroy(); });
}
function contentType(response: IncomingMessage): string | null {
  const raw = response.headers['content-type'];
  if (typeof raw !== 'string') return null;
  const type = raw.split(';', 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) && type.length <= 127 ? type : null;
}

/** Writes one verified local file; failure removes partial bytes and any target created by this call. */
export class RestrictedDownloader {
  async download(rawUrl: string, targetPath: string,options:{budget?:IOBudget;deadline?:number;beforeRead?:()=>Promise<void>}={}): Promise<UrlDownloadResult> {
    let current = parseSourceUrl(rawUrl);
    if (typeof targetPath !== 'string' || !isAbsolute(targetPath) || targetPath.includes('\0')) throw new UrlDownloadError('url_storage_failed');
    const source_url_redacted = redactSourceUrl(rawUrl);
    const partialPath = `${targetPath}.partial-${randomUUID()}`;
    const controller = new AbortController();
    const signal = controller.signal;
    const deadline=Math.min(Date.now()+DEADLINE_MS,options.deadline??Infinity);const timer = setTimeout(() => controller.abort(), Math.max(1,deadline-Date.now()));let capacity:BudgetLease|undefined;
    let targetOwned = false;
    try {
      capacity=await options.budget?.acquire('verify',MAX_BYTES,{signal,deadline});await options.beforeRead?.();signal.throwIfAborted();
      for (let redirect_count = 0; ; redirect_count++) {
        const approved = await resolveApproved(current, signal);
        const {response, agent} = await requestPinned(current, approved, signal);
        try {
          const status = response.statusCode ?? 0;
          if (REDIRECT_STATUSES.has(status)) {
            const location = response.headers.location;
            response.destroy();
            if (redirect_count >= MAX_REDIRECTS) throw new UrlDownloadError('url_redirect_limit');
            if (typeof location !== 'string' || location.length === 0 || location.length > 8192) throw new UrlDownloadError('url_redirect_invalid');
            let next: URL;
            try { next = new URL(location, current); } catch { throw new UrlDownloadError('url_redirect_invalid'); }
            current = parseSourceUrl(next.href);
            // HTTPS-to-HTTP is allowed only through the same URL, DNS, and pinned-IP checks.
            continue;
          }
          if (status < 200 || status > 299) throw new UrlDownloadError('url_http_status');
          const encoding = response.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') throw new UrlDownloadError('url_content_encoding');
          const length = response.headers['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) throw new UrlDownloadError('url_too_large');
          const hash = createHash('sha256');
          let size = 0;
          let rejectLimit: (error: UrlDownloadError) => void;
          const limitFailure = new Promise<never>((_resolve, reject) => { rejectLimit = reject; });
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              if (size > MAX_BYTES) {
                const failure = new UrlDownloadError('url_too_large');
                rejectLimit(failure);
                callback(failure);
                return;
              }
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          const writer = createWriteStream(partialPath, {flags: 'wx', mode: 0o600});
          const writerClosed = new Promise<void>(resolve => writer.once('close', resolve));
          let storageFailed = false;
          writer.once('error', error => {
            const code = String((error as {code?: unknown}).code ?? '');
            if (/^(?:EACCES|ENOENT|ENOSPC|EIO|EROFS|EDQUOT|EEXIST|EMFILE|ENFILE|EBADF|EPERM)$/u.test(code)) storageFailed = true;
          });
          const source=capacity?await capacity.meter(response,false):response;const transfer = pipeline(source, meter, writer, {signal});
          try {
            await waitBounded(Promise.race([transfer, limitFailure]), signal);
          } catch (error) {
            response.destroy();
            meter.destroy();
            writer.destroy();
            // Wait for any pending file open and close before removing partial bytes.
            await writerClosed;
            if (storageFailed) throw new UrlDownloadError('url_storage_failed');
            throw sanitizedNetworkError(error, signal);
          }
          if (!response.complete) throw new UrlDownloadError('url_network_failed');
          signal.throwIfAborted();
          const result: UrlDownloadResult = {sha256: hash.digest('hex'), size, source_url_redacted, redirect_count, content_type: contentType(response)};
          const file = await open(partialPath, 'r');
          try { await file.sync(); } finally { await file.close(); }
          signal.throwIfAborted();
          await link(partialPath, targetPath); // Atomic publication without overwriting an existing target.
          targetOwned = true;
          await rm(partialPath);const dir=await open(dirname(targetPath),'r');try{await dir.sync();}finally{await dir.close();}
          signal.throwIfAborted();
          return result;
        } finally {
          response.destroy();
          agent.destroy();
        }
      }
    } catch (error) {
      await rm(partialPath, {force: true}).catch(() => undefined);
      if (targetOwned) await rm(targetPath, {force: true}).catch(() => undefined);
      if (signal.aborted) throw new UrlDownloadError('url_timeout');
      if (error instanceof UrlDownloadError||error instanceof DomainError) throw error;
      throw new UrlDownloadError('url_storage_failed');
    } finally { clearTimeout(timer);await capacity?.release(); }
  }
}
