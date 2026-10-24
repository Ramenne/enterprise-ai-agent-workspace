// Check deployed app-shell updates on lifecycle events, never on a polling timer.
export function bindPwaUpdates(registration: Pick<ServiceWorkerRegistration, 'update'>,
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
  host: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  let running = false, disposed = false;
  const check = async () => {
    if (disposed || running || page.visibilityState === 'hidden') return;
    running = true;
    try { await registration.update(); } catch { /* Offline: retry on next resume/online event. */ }
    finally { running = false; }
  };
  page.addEventListener('visibilitychange', check);
  host.addEventListener('pageshow', check);
  host.addEventListener('online', check);
  void check();
  return () => {
    disposed = true; page.removeEventListener('visibilitychange', check);
    host.removeEventListener('pageshow', check); host.removeEventListener('online', check);
  };
}
