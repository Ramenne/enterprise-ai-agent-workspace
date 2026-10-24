import { lstat, readdir, unlink, realpath, rmdir } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
/** Dedicated private directory only. Mem read spools have exactly one verified-object file. */
export async function cleanReadTemps(directory: string, ttlSeconds: number, now = Date.now()) {
 if (!Number.isInteger(ttlSeconds) || ttlSeconds < 3600) throw new Error('unsafe_temp_ttl');
 const path = resolve(directory), stat = await lstat(path);
 if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path || basename(path) !== 'hub2-worker-read-temp' || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_temp_directory');
 let deleted = 0, held = 0;
 for (const entry of await readdir(path, { withFileTypes: true })) {
  if (!/^hub2-mem-read-[a-zA-Z0-9_-]+$/.test(entry.name) || entry.isSymbolicLink()) { held++; continue; }
  const child = join(path, entry.name), info = await lstat(child);
  if (info.isSymbolicLink() || now - Math.max(info.mtimeMs, info.ctimeMs) < ttlSeconds * 1000) { held++; continue; }
  if (info.isFile()) {
   if (info.nlink !== 1) { held++; continue; }
   await unlink(child); deleted++; continue;
  }
  if (!info.isDirectory() || (info.mode & 0o022) !== 0) { held++; continue; }
  const children = await readdir(child, { withFileTypes: true });
  if (children.length !== 1 || children[0]?.name !== 'verified-object' || !children[0].isFile() || children[0].isSymbolicLink()) { held++; continue; }
  const spool = join(child, 'verified-object'), file = await lstat(spool);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || now - Math.max(file.mtimeMs, file.ctimeMs) < ttlSeconds * 1000) { held++; continue; }
  const again = await lstat(child);
  if (!again.isDirectory() || again.isSymbolicLink() || again.ino !== info.ino || again.dev !== info.dev) { held++; continue; }
  await unlink(spool); await rmdir(child); deleted++;
 }
 return { state: 'completed', deleted, held, scope: 'worker_owned_read_temps_only', ttl_seconds: ttlSeconds };
}
