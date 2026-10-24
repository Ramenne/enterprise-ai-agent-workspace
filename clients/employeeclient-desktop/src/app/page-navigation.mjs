// Page hierarchy, independent of the browser's log of query changes and tab clicks.
export const primaryPages = new Set(['conversations', 'work', 'profile']);
export function pageKey(route) {
  if (route.name === 'chat') return 'chat:' + String(route.query.peer || 'group');
  return String(route.name) + ':' + String(route.params.id || route.params.actor || '') + (['work-detail','material-detail'].includes(route.name) ? ':' + String(route.query.project || '') : '');
}
export function safePageReturn(router, input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
  const target = router.resolve(input);
  return target.matched.length && target.name && target.name !== 'connect' && !target.matched.some(record => record.redirect) ? target.fullPath : null;
}
export function createPageTrail(router) {
  let pages = [];
  const isPrimary = route => primaryPages.has(route.name) && !safePageReturn(router, route.query.returnTo);
  function record(to) {
    if (!to.name || to.name === 'connect') { pages = []; return; }
    const entry = { key: pageKey(to), path: to.fullPath };
    if (isPrimary(to)) { pages = [entry]; return; }
    const index = pages.findIndex(page => page.key === entry.key);
    if (index >= 0) pages = pages.slice(0, index);
    pages.push(entry);
  }
  function parent(route) {
    const explicit = safePageReturn(router, route.query.returnTo);
    if (explicit && explicit !== route.fullPath && pageKey(router.resolve(explicit)) !== pageKey(route)) return explicit;
    if (isPrimary(route)) return null;
    const index = pages.findIndex(page => page.key === pageKey(route));
    if (index > 0) return pages[index - 1].path;
    // Direct links and reloads have no in-memory origin. Use the established section.
    const fallback = { chat:'/messages', member:'/messages', 'group-files':'/chat', announcements:'/messages', inspiration:'/profile', feedback:'/profile', search:'/work', files:'/work', notifications:'/work', 'work-detail':'/work', 'material-detail':'/files', collaboration:'/messages' };
    return fallback[route.name] || null;
  }
  return { record, parent, isPrimary, reset(route) { pages = []; record(route); }, contains: route => pages.some(page => page.key === pageKey(route)) };
}

export function installPageNavigation(router, history) {
  const trail = createPageTrail(router);
  let backing = false;
  let traversal = false, closeSurface = () => false;
  // Registered before Vue Router's listener so the guard can distinguish browser
  // Back/Forward from an ordinary push, including a pop to an old filter URL.
  history.listen((_to, _from, info) => { traversal = info.direction === 'back'; });
  const push = router.push.bind(router);
  router.push = target => {
    const to = router.resolve(target), from = router.currentRoute.value;
    // Same-page filters/anchors and explicit returns never create a page layer.
    return pageKey(to) === pageKey(from) || trail.isPrimary(to) || trail.contains(to)
      ? router.replace(target) : push(target);
  };
  router.beforeEach((to, from) => {
    if (!traversal || !from.name || from.name === 'connect') return true;
    traversal = false;
    if (closeSurface()) return false;
    const target = trail.parent(from);
    if (!target) return false; // A first-level page is the current navigation boundary.
    if (to.fullPath !== target) return { path: target, replace: true };
    return true;
  });
  router.afterEach((to, _from, failure) => { traversal = false; if (!failure) trail.record(to); });
  return {
    setSurfaceCloser(close) { closeSurface = close; return () => { if (closeSurface === close) closeSurface = () => false; }; },
    async back() {
      if (backing) return true;
      backing = true;
      try {
        if (closeSurface()) return true;
        const target = trail.parent(router.currentRoute.value);
        if (!target) return false;
        await router.replace(target); return true;
      } finally { backing = false; }
    },
    reset() { trail.reset(router.currentRoute.value); },
    primary(target) { return router.replace(target); },
    parent: () => trail.parent(router.currentRoute.value),
  };
}
