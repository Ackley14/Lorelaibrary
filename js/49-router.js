/* ══════════════════════════════════════════════════════════════════════════
   Hash router.

   Hash routing rather than the History API, because GitHub Pages returns a
   real HTTP 404 for any path it has no file for. The usual SPA workaround
   (a 404.html that re-serves the app) is a genuine hack we don't need — and
   on file:// the History API is unusable anyway.
   ══════════════════════════════════════════════════════════════════════════ */

BT.router = (function () {
  const routes = [];
  let current = null;
  let currentToken = 0;

  /* ── Suspension ──────────────────────────────────────────────────────────
     On iOS, a standalone home-screen PWA revokes camera permission the moment
     `location.hash` changes (WebKit bug 215884, still open — no fix, no
     workaround from our side). The barcode scanner therefore runs as an
     overlay rather than a screen, and it needs a hard guarantee that nothing
     touches the hash while a MediaStream is live: one stray go() and the
     video track dies mid-scan, with a permission prompt the user cannot
     re-grant without leaving the app.

     So the scanner calls suspend() before getUserMedia and resume() after the
     tracks are stopped. A navigation raised while suspended is REMEMBERED,
     not dropped — deferring it means "scan a book, tap through to it" still
     works; dropping it would silently swallow the tap. */
  let suspended = false;
  let pendingHash = null;
  let pendingResolve = false;

  function on(pattern, handler) {
    /* '#/item/:uid' → captures everything after the prefix, including colons,
       because a uid is `book:openlibrary:OL27482W`. */
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ pattern, parts, handler });
  }

  function parse(hash) {
    const raw = (hash || location.hash || '#/').replace(/^#/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segs = pathPart.split('/').filter(Boolean);
    const query = {};
    if (queryPart) {
      for (const kv of queryPart.split('&')) {
        const [k, v] = kv.split('=');
        query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    return { segs, query, path: pathPart || '/' };
  }

  function match(segs) {
    for (const r of routes) {
      if (r.parts.length !== segs.length) {
        /* A trailing :rest param swallows everything left over. */
        const last = r.parts[r.parts.length - 1];
        if (!(last && last.startsWith(':') && segs.length > r.parts.length)) continue;
      }
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          params[p.slice(1)] = i === r.parts.length - 1
            ? decodeURIComponent(segs.slice(i).join('/'))
            : decodeURIComponent(segs[i]);
        } else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  /* The app scrolls inside #viewScroll, not the window: html and body are
     overflow:hidden so the three panes can size themselves. Anything reading
     window.scrollY or calling window.scrollTo here is a no-op. */
  const scroller = () => document.getElementById('viewScroll');

  const routeId = (path, query) => path + '?' +
    Object.keys(query || {}).sort().map(k => `${k}=${query[k]}`).join('&');

  async function resolve() {
    /* Saving an item calls resolve(), and scanning saves items — so without
       this the whole view would rebuild underneath a live scanner overlay,
       once per barcode. Coalesce them into a single resolve on resume. */
    if (suspended) { pendingResolve = true; return; }

    const { segs, query, path } = parse();
    const hit = match(segs);
    const token = ++currentToken;

    /* Re-resolving the SAME screen is a refresh, not a navigation, and must
       not throw away the reader's place. This happens more than it looks:
       adding an item saves, a save can merge, and a merge calls resolve().
       Without this, adding three things in a row from a long list means
       scrolling back down twice. */
    const el = scroller();
    const sameRoute = current && routeId(current.path, current.query) === routeId(path, query);
    const keepTop = sameRoute && el ? el.scrollTop : 0;

    const view = document.getElementById('view');
    highlightNav(segs[0] || '');
    /* The index tree carries the real navigation, and its selection is derived
       from the route — so it has to be re-marked here. Leaving it to the
       tree's own refresh meant the highlight only moved when the LIBRARY
       changed, so it sat on whatever screen you were on the last time you
       added something. */
    if (BT.tree && BT.tree.markRoute) BT.tree.markRoute();

    if (!hit) {
      view.innerHTML = BT.ui.emptyState({
        title: 'Nothing here',
        body: `No screen matches <span class="num">#${BT.util.escapeHtml(path)}</span>.`,
        actions: '<a class="btn" href="#/">Go home</a>',
      });
      return;
    }

    current = { path, params: hit.params, query };
    try {
      await hit.route.handler(hit.params, query, () => token === currentToken);
    } catch (e) {
      console.error('[router] view failed', e);
      /* An error boundary: one broken screen must not take the shell down. */
      view.innerHTML = BT.ui.errorBox(
        'This screen could not be displayed',
        (e && e.message) || String(e));
    }
    /* Restoring has to survive the content briefly collapsing: a handler that
       replaces #view empties the scroller, the browser clamps scrollTop to 0,
       and only then are rows painted back. Setting it once after the handler
       and once more on the next frame covers both orderings. */
    const back = scroller();
    if (back) {
      if (keepTop) {
        back.scrollTop = keepTop;
        requestAnimationFrame(() => {
          if (token === currentToken && back.scrollTop !== keepTop) back.scrollTop = keepTop;
        });
      } else {
        back.scrollTop = 0;
      }
    }
  }

  function highlightNav(section) {
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function go(hash) {
    /* Hold the navigation rather than perform it — see the suspension note
       above. Last one wins: a burst of scans should land you on the screen
       the user asked for last, not replay every intermediate hop. */
    if (suspended) { pendingHash = hash; return; }
    if (location.hash === hash) resolve();
    else location.hash = hash;
  }

  /* Called by the scanner overlay around a live MediaStream. suspend() is
     safe to call twice; resume() only replays if something was actually
     deferred. */
  function suspend() { suspended = true; }

  function resume() {
    if (!suspended) return;
    suspended = false;
    const hash = pendingHash;
    const wanted = pendingResolve;
    pendingHash = null;
    pendingResolve = false;
    if (hash !== null) go(hash);
    else if (wanted) resolve();
  }

  function start() {
    window.addEventListener('hashchange', () => {
      /* If the hash moved while suspended — a back gesture, a link from
         outside, anything we don't control — the camera is already gone, so
         the guard has nothing left to protect. Clear it instead of leaving
         the router wedged with a stale deferred navigation. */
      if (suspended) { suspended = false; pendingHash = null; pendingResolve = false; }
      const { path } = parse();
      void path;
      resolve();
    });
    const el = scroller();
    if (el) {
      /* Prefixed like every other stored key: sessionStorage is scoped to the
         ORIGIN, which BookTrak shares with MovieTrak. */
      el.addEventListener('scroll', BT.util.debounce(() => {
        if (current) sessionStorage.setItem('bt.scroll:' + current.path, String(el.scrollTop));
      }, 250), { passive: true });
    }
    if (!location.hash) location.hash = '#/';
    resolve();
  }

  return {
    on, go, start, resolve, parse, suspend, resume,
    get suspended() { return suspended; },
    get current() { return current; },
  };
})();
