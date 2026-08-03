/* ══════════════════════════════════════════════════════════════════════════
   Service worker — the app SHELL, and deliberately nothing else.

   BookTrak is installable because scanning is a phone job, and a home-screen
   app that shows a dinosaur when the platform WiFi drops out is not one. So
   this worker precaches the files that make up the program itself — the
   document, the stylesheets, the scripts, the barcode decoder and its wasm —
   and serves them from disk.

   ── WHAT IT MUST NEVER TOUCH ─────────────────────────────────────────────
   openlibrary.org, googleapis.com and api.github.com are passed straight
   through to the network, untouched, and this is the single most important
   rule in the file.

   BT.repo already owns the freshness of that data, in IndexedDB, with per-kind
   TTLs, a request budget and a circuit breaker (js/12-repo.js, js/05-net.js).
   A second HTTP cache sitting underneath it would be a SECOND opinion about
   what is stale, held by code that cannot see the first — so the app would
   compute "this record is 3 days old, refresh it", issue the request, and be
   handed the same 3-day-old bytes back by this file. The bug that produces is
   a book whose publication date will not update no matter how many times you
   press refresh, and nothing in the app would point here. The fetch handler
   below therefore does not merely decline to cache other origins; it declines
   to answer for them at all, so the browser's own cache and BT.net's headers
   behave exactly as they do with no worker installed.

   ── THE LIST BELOW IS MAINTAINED BY HAND ─────────────────────────────────
   There is no build step — that is a project constraint, not an oversight —
   so nothing generates SHELL from index.html. Two obligations follow, and
   both are on the person editing, not on any tool:

     1. ADD A FILE TO index.html  →  add it here, in the same order.
        A script tag that is missing from this list still WORKS: the fetch
        handler ignores anything it did not precache, so the browser fetches
        it normally. It just is not there offline, and it is not versioned
        with the rest of the shell — which is the more insidious half, because
        the app then boots from a mixture of two deployments.

     2. CHANGE ANY FILE IN THE LIST  →  bump VERSION.
        This is the one that bites. A cached shell is only ever replaced when
        the BYTES OF THIS FILE change, because that is the only thing the
        browser re-checks. Edit 50-ui-core.js, deploy, and every installed
        copy goes on serving the old one forever — the fix is deployed, and
        nobody receives it. Bumping VERSION is what makes a deploy a deploy.
   ══════════════════════════════════════════════════════════════════════════ */

/* Bump on EVERY shell change. See obligation 2 above.
   v2 — M5 sync: 15-crypto, 16-cloud, 48-sync and 71-view-unlock joined the
   shell, and 45-alerts, 69-view-settings, 90-boot and index.html all changed
   with them. */
const VERSION = 'v2';

/* ── The prefix is load-bearing ───────────────────────────────────────────
   Cache Storage is scoped to the ORIGIN, not to the worker's scope, and
   ackley14.github.io hosts BookTrak at /Lorelaibrary/ and MovieTrak at
   /entertainmentwatch/. caches.keys() from here therefore lists MovieTrak's
   caches too, and the usual one-line activate handler — delete every key that
   is not the current one — would silently wipe the neighbouring app's shell
   every time BookTrak shipped. Same argument as the `bt.` / `mt.` localStorage
   prefixes in index.html, with a worse blast radius.

   So: everything this file creates starts with CACHE_PREFIX, and nothing
   without that prefix is ever deleted. */
const CACHE_PREFIX = 'bt-shell-';
const CACHE = CACHE_PREFIX + VERSION;

/* ── The shell ────────────────────────────────────────────────────────────
   Derived from the <script> and <link> tags in index.html, top to bottom, in
   load order. RELATIVE paths only: BookTrak is published under the subpath
   /Lorelaibrary/, so '/js/00-config.js' is a 404 there and works only in local
   testing — the worst kind of split, because it passes every check on the
   machine it was written on. Each entry is resolved against this file's own
   URL below, which makes the whole list correct from any subpath. */
const SHELL = [
  /* The document itself, twice over. GitHub Pages serves the same bytes for
     the directory and for the explicit filename, and both are real URLs a
     person can land on — a launch from the home screen asks for './', a
     bookmark someone typed asks for 'index.html'. Caching one and not the
     other means offline works from exactly one of the two entrances. */
  './',
  'index.html',

  /* Stylesheets, in the order index.html links them. 05-responsive.css is last
     there because it carries every media query and has to win on equal
     specificity; that ordering is index.html's business, but keeping this list
     in the same sequence is how the two stay comparable by eye. */
  'css/01-tokens.css',
  'css/02-base.css',
  'css/03-components.css',
  'css/04-views.css',
  'css/05-responsive.css',

  /* The vendored decoder, loaded before BookTrak's own scripts because
     58-scanner.js reads window.BarcodeDetectionAPI while deciding which decode
     path exists. */
  'js/vendor/barcode-detector-3.2.1.min.js',

  /* THE ONLY ENTRY WITHOUT A TAG IN index.html, and it is not optional.
     BarcodeDetector does not exist on Chrome or Edge for Windows or Linux
     desktop, or in Safari — so on most machines this megabyte of wasm IS the
     scanner, not a fallback for it. 58-scanner.js fetches it lazily, by URL,
     the first time a camera opens (js/vendor/zxing_reader-3.1.1.wasm, resolved
     against document.baseURI). Leave it out and the installed app still opens
     offline and still shows the scan screen — and then fails at the one moment
     a phone-first, install-to-scan app exists for. It is worth the megabyte;
     it is fetched once, at install, and never again.

     The version is in the filename on purpose: upgrading the decoder is a
     visible diff here as well as in index.html. */
  'js/vendor/zxing_reader-3.1.1.wasm',

  /* BookTrak's own scripts, in index.html's order — which is the dependency
     graph, there being no modules to express it. Two of them are out of
     numeric sequence (70-follows.js above 45-alerts.js) and that is deliberate
     there; this list simply follows. */
  'js/00-config.js',
  'js/01-util.js',
  'js/02-theme.js',
  'js/05-net.js',
  'js/10-db.js',
  'js/12-repo.js',
  'js/15-crypto.js',
  'js/16-cloud.js',
  'js/20-openlibrary.js',
  'js/25-googlebooks.js',
  'js/38-normalize.js',
  'js/39-scan.js',
  'js/70-follows.js',
  'js/45-alerts.js',
  'js/48-sync.js',
  'js/49-router.js',
  'js/50-ui-core.js',
  'js/55-tree.js',
  'js/56-inspector.js',
  'js/58-scanner.js',
  'js/59-editions.js',
  'js/61-view-search.js',
  'js/62-view-list.js',
  'js/66-view-alerts.js',
  'js/67-view-people.js',
  'js/68-view-stats.js',
  'js/69-view-settings.js',
  'js/71-view-unlock.js',
  'js/75-view-scan.js',
  'js/90-boot.js',

  /* Icons and the manifest. Small, and the ones that are most obviously wrong
     when missing: an installed app whose icon is a broken square, or which
     re-prompts to install because the manifest would not load. */
  'favicon.svg',
  'favicon.ico',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'manifest.json',

  /* DELIBERATELY ABSENT: 'data/library.enc.json'.

     It is same-origin, in scope, and it is the one file here that must never
     be answered from a cache. It is the encrypted library, and js/16-cloud.js
     compares its `updatedAt` against what this device last wrote to decide
     whether another device has published since. Serve a cached copy and that
     comparison is made against a stale timestamp: either every save reports a
     conflict with a copy of itself, or — worse — a merge runs against
     yesterday's library and quietly republishes it over today's.

     Nothing needs to be done to keep it out beyond leaving it off this list:
     the fetch handler answers navigations and SHELL_URLS and nothing else, so
     an unlisted same-origin GET reaches the network exactly as it would with
     no worker installed. This comment exists so that the next person tidying
     the list does not "fix" the omission. */
];

/* Resolved once, against this worker's own URL, so a match is a cheap Set
   lookup on a pathname rather than string surgery per request. */
const SHELL_URLS = new Set(SHELL.map(p => new URL(p, self.location.href).pathname));
const SHELL_DOC = new URL('./', self.location.href).pathname;

/* 404.html is deliberately absent, and the navigation branch below covers its
   job instead — see the redirect there for why serving the shell at the
   mistyped path is not the same thing. */

/* ── Install ──────────────────────────────────────────────────────────────
   addAll is ATOMIC and that is the behaviour we want. If one entry 404s —
   a file renamed without updating SHELL, the exact desync the header warns
   about — the whole install fails, this worker never activates, and the app
   goes on working online precisely as it did before any of this existed. The
   alternative, caching whatever happened to succeed, produces an "offline"
   app that boots into a TypeError because one script of thirty is missing.
   Failing whole is the safe failure here.

   addAll's own rejection says almost nothing about WHICH url failed, so the
   catch re-probes them individually and names it. That is the difference
   between a five-second fix and an afternoon.

   `cache: 'reload'` bypasses the browser's HTTP cache for these fetches. Skip
   it and a deploy can precache the PREVIOUS version of a script straight out
   of the disk cache, sealing yesterday's bug into a versioned cache that by
   design will never revalidate — a bug that survives every reload and clears
   only when the user wipes site data. */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let requests;
    try {
      requests = SHELL.map(p => new Request(p, { cache: 'reload' }));
    } catch (_) {
      /* Older WebKit rejects the cache option in the Request constructor.
         Precaching a possibly-stale copy beats not installing at all. */
      requests = SHELL.slice();
    }
    try {
      await cache.addAll(requests);
    } catch (err) {
      const failed = [];
      for (const p of SHELL) {
        try {
          const r = await fetch(p, { cache: 'reload' });
          if (!r.ok) failed.push(`${p} → HTTP ${r.status}`);
        } catch (e) { failed.push(`${p} → ${e && e.message}`); }
      }
      console.error('[sw] precache failed; SHELL is out of step with the files on disk:',
        failed.length ? failed : err);
      throw err;
    }
  })());

  /* No skipWaiting() here. See the message handler at the foot of the file:
     the only route to it is a person pressing "Reload" on a toast. */
});

/* ── Activate ─────────────────────────────────────────────────────────────
   Drop BookTrak's older shells and nothing else — see the CACHE_PREFIX note.

   clients.claim() is deliberately NOT called. Claiming would put this worker
   in charge of pages that loaded without one, which means the rules by which
   requests are answered would change underneath a tab that is already running
   — including, on the very first install, underneath a live camera: the
   scanner fetches its wasm lazily, and having that request start being
   answered from a cache mid-session is a difference nobody asked for at the
   worst possible moment. Control is taken at the next navigation instead. The
   only cost is that the first visit is not offline-capable until a reload,
   which is the correct trade for an app that is holding a MediaStream. */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (!k.startsWith(CACHE_PREFIX)) return null;   /* MovieTrak's. Not ours to delete. */
      if (k === CACHE) return null;
      return caches.delete(k);
    }));
  })());
});

/* Our own cache only. The global caches.match() searches EVERY cache on the
   origin, MovieTrak's included; nothing would collide today because the paths
   differ, but a lookup that can reach into the neighbouring app is a fact
   waiting to become a bug. */
async function fromShell(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreSearch: true });
}

/* ── Fetch ────────────────────────────────────────────────────────────────
   Three decisions, in order, and the default is always "do nothing":

     cross-origin or non-GET   → not answered at all. Open Library, Google
                                 Books and GitHub reach the network exactly as
                                 they would with no worker installed. See the
                                 header.
     a navigation              → the cached document if the URL is one of the
                                 two it was cached under, otherwise a redirect
                                 to the app root. BookTrak is one document with
                                 a hash router, so every screen is this file;
                                 serving it from disk is what makes the
                                 installed app open without a network.
     a precached shell file    → cache first.
     anything else same-origin → not answered at all. Only this app's scope
                                 reaches here at all — MovieTrak's pages, on
                                 the same origin, are outside it.

   Cache-first, never stale-while-revalidate. A versioned shell is only
   coherent if all of it comes from ONE version: quietly refreshing individual
   files in the background would produce a page running this week's
   50-ui-core.js against last week's 03-components.css, which fails in ways
   that look like CSS bugs. The whole set changes together, when VERSION does,
   and the user is asked first. */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      /* The exact URL first: './' and 'index.html' are both precached, so a
         launch from the home screen and a typed link each get their own entry
         and neither has to guess. */
      const exact = await fromShell(req);
      if (exact) return exact;

      /* Anything else in scope is a mistyped or stale path — /Lorelaibrary/
         something. REDIRECT, never serve the shell body at that URL. Handing
         index.html straight back is the obvious move and it produces a blank
         white page, because every path in it is relative: at
         /Lorelaibrary/some/typo/path the browser resolves 'js/00-config.js'
         against /Lorelaibrary/some/typo/ and 404s all thirty scripts. The
         document loads, BT never exists, and there is nothing on screen to
         say why. Verified, not theorised — it is what the first version of
         this branch did.

         A redirect is also exactly what 404.html does when the site is
         reachable, so online and offline now behave the same way, and it does
         it better: the fragment survives a redirect the browser performs
         (the destination has none of its own), where 404.html's
         location.replace hardcodes '#/' and loses whichever screen the link
         was pointing at. */
      if (url.pathname !== SHELL_DOC) {
        return Response.redirect(new URL('./', self.location.href).href, 302);
      }

      /* The shell itself, missing from the cache: evicted under storage
         pressure, or an install that half-happened. Nothing to redirect TO,
         so the network is the only honest answer — and redirecting here
         instead would be an infinite loop through this same branch. */
      return fetch(req);
    })());
    return;
  }

  if (!SHELL_URLS.has(url.pathname)) return;

  event.respondWith((async () => {
    const hit = await fromShell(req);
    if (hit) return hit;
    /* Listed but not stored: only reachable if the cache was evicted under
       storage pressure. The network is the right answer, not an error page. */
    return fetch(req);
  })());
});

/* ── The update handshake ─────────────────────────────────────────────────
   skipWaiting() lives here, behind a message, and is never called on install.

   Called there it would swap the worker out from under whatever the tab is
   doing, and this app has two moments where that is genuinely destructive: a
   live camera holding a MediaStream — on iOS a standalone PWA cannot re-grant
   camera permission once it is lost (WebKit 215884) — and a half-typed page
   number in the progress field, which is not persisted until it is committed.
   "The app updated itself while I was scanning" is not a good trade for a
   version number.

   So the new worker waits, js/90-boot.js notices it and offers a toast, and
   this runs only after somebody has pressed Reload. That press is also the
   proof that no camera is open: 90-boot.js holds the toast back for as long as
   BT.router is suspended, which is exactly as long as a MediaStream is live. */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'BT_SKIP_WAITING') self.skipWaiting();
});
