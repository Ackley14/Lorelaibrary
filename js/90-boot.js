/* ══════════════════════════════════════════════════════════════════════════
   Boot: routes, storage probe, background refresh, global error handling.

   M1 note — the shell is complete and every destination in the index tree
   resolves, but the view modules (61–70, 75) have not been written yet. Every
   route below is registered exactly once, here, and each one renders a short
   placeholder naming the milestone it arrives in. The placeholders are chosen
   at NAVIGATION time rather than at registration, so the day a real view
   module lands on the page it simply wins — no line in this file changes.
   ══════════════════════════════════════════════════════════════════════════ */

BT.boot = (function () {
  const signedIn = () => !!(BT.crypto && BT.crypto.isUnlocked && BT.crypto.isUnlocked());

  /* ── M1 placeholders ───────────────────────────────────────────────────
     A missing screen is a promise, not an error. Each stub sets the same
     breadcrumb and pane actions the real view will set, so navigating around
     the shell already feels like the finished app and the tree's selection
     logic is exercised for real. */
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
     one property lookup and removes the whole class of problem. */
  function viewOr(name, fallback) {
    return function (params, query, alive) {
      const mod = BT[name];
      const render = (mod && mod.render) || fallback;
      return render.call(mod || null, params, query, alive);
    };
  }

  function routes() {
    /* Library is the front door. There is no separate "home" — the index tree
       is always visible, so a dashboard would just be a second navigation. */
    const library = viewOr('viewLibrary', stub(
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
       and leaves the edition open. */
    BT.router.on('/scan', viewOr('viewScan', stub(
      ['Discover', 'Scan'], 'Scan a barcode', 'M3',
      'Point a scanner or a camera at an ISBN and BookTrak adds that exact printing — publisher, page count and cover — rather than the work in general. Arrives in')));

    BT.router.on('/alerts', viewOr('viewAlerts', stub(
      ['Shelf', 'Activity'], 'Activity', 'M4',
      'What changed since you last looked: dates that moved, editions that appeared, authors you follow publishing something new. Arrives in')));

    BT.router.on('/people', viewOr('viewPeople', stub(
      ['Discover', 'Following'], 'Following', 'M4',
      'Authors you follow, and anything of theirs that has been announced but is not in your library yet. Arrives in')));

    BT.router.on('/stats', viewOr('viewStats', stub(
      ['Shelf', 'Stats'], 'Stats', 'M4',
      'Pages read, genres by share, how long books sit on the want shelf before you start them. Arrives in')));

    BT.router.on('/settings', viewOr('viewSettings', stub(
      ['System', 'Settings'], 'Settings', 'M5',
      'Language and region, which genre buckets to show, an optional Google Books key, and Export / Import. Arrives in')));

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
      const sweep = await BT.repo.metaGet('sync.lastSweepAt');
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
     M1 shell. */
  function scheduleSweeps() {
    if (!BT.sync || !BT.sync.sweep) return;
    const kick = () => {
      BT.sync.sweep({}).then(r => {
        if (r && r.alerts) {
          BT.tree.refresh();
          BT.ui.toast(`${r.alerts} update${r.alerts === 1 ? '' : 's'} since last time`, {
            actionLabel: 'See', onAction: () => BT.router.go('#/alerts'),
          });
        }
        refreshFooter();
      }).catch(e => console.warn('[boot] sweep failed', e));
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
