/* ══════════════════════════════════════════════════════════════════════════
   Boot: routes, storage probe, background refresh, global error handling.

   M3 note — /scan now has a real view (BT.viewScan, in 75-view-scan.js) and
   the mechanism below did what it was built to do a second time: the route
   line did not have to change at all. Every route is still registered exactly
   once, here, and the ones whose views are not written yet (/up, /stats,
   /unlock) go on rendering a short placeholder naming the milestone they
   arrive in.

   Resolution happens at NAVIGATION time rather than at registration, which is
   why adding a view is a one-word change: the day the module lands on the page
   it simply wins. Keep it that way — a handler that captures BT.viewX at
   registration pins whatever was there when startApp() ran.

   The name each view file actually exports is CHECKED against this file when
   the view lands, not assumed. M2 shipped with `viewList` written here and
   `viewLibrary` implemented, which does not throw — it silently left the
   placeholder on the front door. `viewOr` now takes a list for that route, and
   the rule for every future milestone is to open the file and read the
   `BT.x = (function ()` line rather than trusting the plan.
   ══════════════════════════════════════════════════════════════════════════ */

BT.boot = (function () {
  const signedIn = () => !!(BT.crypto && BT.crypto.isUnlocked && BT.crypto.isUnlocked());

  /* ── Placeholders ──────────────────────────────────────────────────────
     A missing screen is a promise, not an error. Each stub sets the same
     breadcrumb and pane actions the real view will set, so navigating around
     the shell already feels like the finished app and the tree's selection
     logic is exercised for real.

     They outlive the milestone they name. Once a view exists its stub becomes
     the answer to "that file failed to parse" — the route still renders a
     sentence instead of a blank pane and a TypeError. */
  function stub(crumb, title, milestone, body, actions) {
    return function () {
      BT.ui.crumb(crumb);
      BT.ui.paneActions('');
      const view = document.getElementById('view');
      if (!view) return;
      view.innerHTML = BT.ui.emptyState({
        title,
        body: `${body} <span class="num">${milestone}</span>`,
        actions: actions || '',
      });
    };
  }

  /* Resolve the module on EVERY navigation, not once when the route is
     registered. Registration happens inside startApp(), which can run before a
     library has finished arriving from anywhere else, and a handler captured
     at that moment would pin the placeholder in place for the rest of the
     session even after the real view existed. Reading BT[name] per call costs
     one property lookup and removes the whole class of problem.

     `names` may be a list, and one route uses that: the list view is
     `BT.viewList` here, but it is a port of MovieTrak's `MT.viewLibrary` and
     the older name is the one this file shipped against in M1. Accepting both
     costs an array scan and closes the one failure that would be invisible —
     a renamed export does not throw, it just leaves the M2 placeholder on the
     front door for ever.

     /scan is a single name because it was verified rather than guessed:
     75-view-scan.js opens `BT.viewScan = (function () {`. Adding aliases on
     spec would only make the next mismatch harder to see. */
  function viewOr(names, fallback) {
    const list = Array.isArray(names) ? names : [names];
    return function (params, query, alive) {
      let mod = null;
      for (const n of list) { if (BT[n] && BT[n].render) { mod = BT[n]; break; } }
      const render = (mod && mod.render) || fallback;
      return render.call(mod || null, params, query, alive);
    };
  }

  function routes() {
    /* Library is the front door. There is no separate "home" — the index tree
       is always visible, so a dashboard would just be a second navigation. */
    const library = viewOr(['viewList', 'viewLibrary'], stub(
      ['Library', 'All books'], 'The library goes here', 'M2',
      'Every book you are tracking, filtered by whichever shelf you picked in the index — status, genre, format, pile or tag. Arrives in'));

    BT.router.on('/',         library);
    BT.router.on('/library',  library);

    BT.router.on('/up', viewOr('viewUp', stub(
      ['Shelf', 'Coming up'], 'Coming up', 'M4',
      'Books with a publication date still ahead of them, plotted on one timeline where precision becomes width: a known day is a pin, a known month is a month wide. Arrives in')));

    BT.router.on('/search', viewOr('viewSearch', stub(
      ['Discover', 'Search'], 'Search', 'M2',
      'Open Library needs no key and no signup, so search will work the moment this view exists — there is nothing for you to configure first. Arrives in')));

    /* Scanning is discovery through a different door. A barcode names ONE
       edition, so what it adds is scope `closed`; search adds the work itself
       and leaves the edition open. That distinction is the whole of
       12-repo.js's pinned-vs-candidate split, and it is why this is a route of
       its own rather than a button on /search.

       The route is all that lives here. The CAMERA does not: it is an overlay
       (58-scanner.js) that the view opens without navigating, because iOS
       standalone PWAs revoke camera permission on a location.hash change
       (WebKit 215884). Routing to a scanner would close the scanner. */
    BT.router.on('/scan', viewOr('viewScan', stub(
      ['Discover', 'Scan'], 'Scan a barcode', 'M3',
      'Point a scanner or a camera at an ISBN and BookTrak adds that exact printing — publisher, page count and cover — rather than the work in general. Arrives in')));

    /* Both of these are REAL views now, and both names were read off the file
       rather than taken from the plan — `66-view-alerts.js` opens
       `BT.viewAlerts = (function () {` and `67-view-people.js` opens
       `BT.viewPeople = (function () {`. That check is the whole reason this
       file has a paragraph about `viewList`/`viewLibrary` at the top: a name
       that does not match does not throw, it silently leaves a placeholder
       promising a milestone that already shipped.

       The stubs stay behind them on purpose. They are no longer a promise —
       they are now the answer to "that view file failed to parse", which is a
       sentence in the pane instead of a blank screen and a TypeError. */
    BT.router.on('/alerts', viewOr('viewAlerts', stub(
      ['Shelf', 'Activity'], 'Activity', 'M4',
      'What changed since you last looked: dates that moved, and works that appeared in the catalogue of an author or publisher you follow. Arrives in')));

    BT.router.on('/people', viewOr('viewPeople', stub(
      ['Discover', 'Following'], 'Following', 'M4',
      'Authors and publishers you follow, and what has turned up in their catalogues that is not in your library yet. Arrives in')));

    BT.router.on('/stats', viewOr('viewStats', stub(
      ['Shelf', 'Stats'], 'Stats', 'M4',
      'Pages read, genres by share, how long books sit on the want shelf before you start them. Arrives in')));

    /* Real as of M5, and the name was READ OFF THE FILE rather than taken from
       the plan: `69-view-settings.js` opens `BT.viewSettings = (function () {`.
       That check is the whole reason this file has a paragraph about
       viewList/viewLibrary at the top — a name that does not match does not
       throw, it silently leaves a placeholder promising a milestone that has
       already shipped.

       The stub behind it is no longer a promise; it is now the answer to "that
       view file failed to parse". Its wording is kept honest for that job: it
       describes what the screen offers, not what it will offer one day.
       "Which genre buckets to show" came out of it because the real screen
       deliberately does not have that control — BT.config.genres exists but
       nothing reads it, and a switch that visibly does nothing is worse than no
       switch. It gains one with the code that honours it. */
    BT.router.on('/settings', viewOr('viewSettings', stub(
      ['System', 'Settings'], 'Settings', 'M5',
      'Recalculate genres after a rules change, an optional Google Books key, region and language, diagnostics, and Export / Import. Part of')));

    BT.router.on('/unlock', viewOr('viewUnlock', stub(
      ['System', 'Sync'], 'Sign in', 'M5',
      'A passphrase encrypts your library in this browser and publishes it to a GitHub repository you own, so another device can pick it up. Arrives in')));

    /* An item is not a page. It selects into the inspector and leaves the list
       underneath it intact — the route survives only so that links still
       work. */
    BT.router.on('/item/:uid', async p => {
      await library({}, {});
      BT.inspector.show(p.uid);
    });
  }

  /* The only place saving is ever mentioned. There is nothing to press. */
  async function refreshFooter(state) {
    try {
      const el = document.getElementById('footMeta');
      if (!el) return;
      /* TWO sweep clocks, and the footer reports the later of them.
         `sync.lastSweepAt` belongs to the item-refresh sweeper in 48-sync.js
         (M5); `alerts.lastSweepAt` belongs to the follow-activity sweep in
         45-alerts.js, which exists today. 45-alerts.js keeps them apart
         deliberately — two writers on one key means whichever ran last erases
         the other's cooldown — so reading only the first one made the footer
         say "checked never" for ever, on an app that had just spent a request
         budget checking. Read both, show the freshest. */
      const sweeps = await Promise.all([
        BT.repo.metaGet('sync.lastSweepAt'),
        BT.repo.metaGet('alerts.lastSweepAt'),
      ]);
      const sweep = Math.max(sweeps[0] || 0, sweeps[1] || 0) || null;
      const saved = await BT.repo.metaGet('cloud.lastPushAt');
      const bits = [];
      if (signedIn()) {
        bits.push(state === 'saving' ? 'Saving…'
          : state === 'error' ? 'Could not save — see Settings'
          : saved ? `Saved ${BT.util.timeAgo(saved)}` : 'Not saved yet');
      }
      bits.push(`checked ${BT.util.timeAgo(sweep)}`);
      el.textContent = bits.join(' · ');
      el.className = 'mono' + (state === 'error' ? ' field__state--bad' : '');
    } catch (_) {}
  }

  async function probeStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
    try {
      await BT.repo.metaSet('boot.probe', Date.now());
      if (!(await BT.repo.metaGet('boot.probe'))) throw new Error('write did not round-trip');
    } catch (e) {
      BT.ui.banner('This browser is not letting BookTrak store data reliably. Your library may vanish when you close the tab — export often.');
      console.error('[boot] storage probe failed', e);
    }
  }

  /* file:// and any hosted copy are separate browser origins, so they hold
     separate libraries. Saying so once prevents a confusing "where did my
     shelf go?" later. */
  async function noteOriginOnce() {
    if (location.protocol !== 'file:') return;
    if (await BT.repo.metaGet('boot.toldAboutFileOrigin')) return;
    if ((await BT.repo.countItems()) === 0) return;
    await BT.repo.metaSet('boot.toldAboutFileOrigin', true);
    BT.ui.banner('You are running the local copy. Browsers treat file:// as its own origin, so this library is separate from the one on your published site — move between them with Export and Import.');
  }

  /* Opportunistic background refresh: never on route change, only on a cold
     start and after the tab has been hidden a while. The sweep enforces its
     own cooldown and request budget on top of this.

     There is no key check here, and that is not an omission. Open Library is
     keyless, so there is no "not configured yet" state that would make a sweep
     pointless — the catalogue is reachable for every user from the first boot.
     The guard is on the sweeper module instead, because it is not part of the
     M1 shell.

     TWO sweepers hang off this one trigger, and they are separate jobs on
     separate budgets and separate cooldown keys:

       BT.alerts.sweep  — 45-alerts.js. Re-reads stored items for dates that
                          moved, then polls a HANDFUL of follows (three) for
                          works that were not in the catalogue last time.
       BT.sync.sweep    — 48-sync.js, M5. Refreshes stale item metadata.

     Each is called only if it exists, and each is called with `{}` so its own
     cooldown decides whether it actually does anything. The previous shape of
     this function was `if (!BT.sync || !BT.sync.sweep) return;` on the first
     line, which was correct while nothing else swept and became a silent
     no-op the moment alerts landed: 48-sync.js does not exist yet, so the
     guard returned before the sweeper that DID exist was ever reached, and
     the activity feed would only ever have filled when someone pressed
     "Check now" by hand.

     Failures are warnings, never throws. A sweep is opportunistic background
     work; Open Library being unreachable is a normal Tuesday and must not
     surface as an uncaught rejection in the console of a working app. */
  function scheduleSweeps() {
    const sweepers = () => [
      BT.alerts && BT.alerts.sweep && (() => BT.alerts.sweep({})),
      BT.sync && BT.sync.sweep && (() => BT.sync.sweep({})),
    ].filter(Boolean);

    const kick = async () => {
      const runs = sweepers();
      if (!runs.length) return;
      let alerts = 0;
      /* Serialized, not Promise.all. Both sweepers draw on the same ~1 req/sec
         Open Library allowance through BT.net, and firing them together only
         means the queue behind them is twice as deep while the user is trying
         to search for a book. */
      for (const run of runs) {
        try {
          const r = await run();
          if (r && r.alerts) alerts += r.alerts;
        } catch (e) { console.warn('[boot] sweep failed', e && e.message); }
      }
      if (alerts) {
        /* The tree also refreshes itself on the repo's `feed:change`, so this
           is redundant on the happy path and deliberately kept: a sweep that
           coalesced into existing feed rows can raise the count without
           emitting a new one. */
        BT.tree.refresh();
        BT.ui.toast(`${alerts} update${alerts === 1 ? '' : 's'} since last time`, {
          actionLabel: 'See', onAction: () => BT.router.go('#/alerts'),
        });
      }
      refreshFooter();
    };

    if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 6000 });
    else setTimeout(kick, 2500);

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > BT.SWEEP.hiddenMsBeforeRecheck) kick();
    });
  }

  /* ── Encrypted publish · M5 SEAM ──────────────────────────────────────
     Deliberately inert until M5. The shape it will take is settled and worth
     writing down now, because half of it is a rate-limit argument that is easy
     to get wrong twice:

       Saves must feel immediate, but every one is a git commit, and GitHub's
       binding limit here is the SECONDARY one — 80 content-generating requests
       a minute, not the 5,000/hour primary. So: fire quickly after a change
       (about 900ms), but never closer together than a 4s floor. A burst of
       edits coalesces into one commit; a single edit lands in about a second.
       A pagehide listener flushes anything still pending, or closing the tab
       straight after an edit loses it.

     Two call sites re-attach in M5 and nowhere else: the repo subscription in
     startApp(), and the pagehide flush. Until then this is exported as a no-op
     so that any caller written against it is already correct — a half-wired
     save path that sometimes publishes is far worse than one that never
     does. */
  function schedulePush() { /* M5 */ }

  /* ── Boot in two stages ────────────────────────────────────────────────
     The repository holds the library, so nothing renders until there is a
     dataset to render against. From M5 the encryption gate sits between the
     two stages: start() prepares storage, the gate decrypts, and startApp()
     runs only once there is a decrypted library (or the visitor has explicitly
     chosen to work offline). Splitting it this way means no view ever renders
     against a half-populated store — which is why the seam exists from M1,
     even though today the two halves run back to back. */
  async function start() {
    window.addEventListener('error', e => console.error('[uncaught]', e.error || e.message));
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      /* An aborted request is a cancelled intention, not a fault: the net
         layer rejects with kind 'abort' when a newer search supersedes an
         older one, and every one of those would otherwise be a red line in
         the console for behaviour that is working exactly as designed. */
      if (r && r.kind === 'abort') { e.preventDefault(); return; }
      console.error('[unhandled promise]', r);
    });

    BT.theme.init();
    await BT.db.open();
    await probeStorage();

    /* Open Library's data is openly licensed and carries no retention limit,
       so unlike a TMDB-backed app this purge is hygiene rather than
       compliance: BT.TTL.HARD_TTL exists to guarantee that nothing outlives a
       schema change. It still runs on every boot, because the cheapest moment
       to drop a stale row is before anything has read it. */
    BT.repo.cachePurge().then(n => n && console.info(`[boot] purged ${n} expired cache rows`));

    /* M5 SEAM — the gate opens here. It will resume a remembered device key,
       pull the encrypted library down, and only then call startApp(); if there
       is no repository configured the app stays local and starts as it does
       now. Nothing about the call below changes. */
    await startApp();
  }

  /* Everything from here needs a populated store. */
  let appStarted = false;
  async function startApp() {
    if (appStarted) return;
    appStarted = true;

    routes();
    BT.tree.init();
    BT.inspector.init();
    await BT.tree.refresh();

    BT.repo.subscribe((ev, detail) => {
      /* M5 SEAM — item:put / item:delete / follow:change / feed:change call
         schedulePush() from here. Until the cloud is wired there is nothing to
         push, and the tree already refreshes itself on those same events. */

      /* A merge happened during a save: say so plainly and refresh what is on
         screen, because the library just changed underneath the reader. */
      if (ev === 'sync:merged') {
        const s2 = detail || {};
        const bits = [];
        if (s2.added) bits.push(`${s2.added} added`);
        if (s2.updated) bits.push(`${s2.updated} updated`);
        if (s2.removed) bits.push(`${s2.removed} removed`);
        BT.ui.toast(
          bits.length
            ? `Changes from another device merged in — ${bits.join(', ')}.`
            : 'Changes from another device merged in.',
          { ms: 6000 });
        BT.tree.refresh();
        BT.router.resolve();
      }
    });

    BT.router.start();
    refreshFooter();
    noteOriginOnce();
    scheduleSweeps();

    /* The origin is on this line on purpose. BookTrak ships to
       ackley14.github.io/Lorelaibrary and MovieTrak to /entertainmentwatch —
       the same origin, different paths — so when something looks like it is
       reading the wrong library, the first two questions are which origin this
       is and which database opened. */
    console.info('%cBookTrak', 'color:#EDB556;font-weight:600',
      `theme=${BT.theme.current()} storage=${BT.db.mode} signedIn=${signedIn()} origin=${location.protocol}//${location.host || '(file)'}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { refreshFooter, schedulePush, start, startApp };
})();
