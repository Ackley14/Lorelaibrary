/* ══════════════════════════════════════════════════════════════════════════
   Boot: routes, storage probe, background refresh, global error handling.

   M3 note — /scan now has a real view (BT.viewScan, in 75-view-scan.js) and
   the mechanism below did what it was built to do a second time: the route
   line did not have to change at all. Every route is still registered exactly
   once, here, and the one whose view is not written yet (/up) goes on
   rendering a short placeholder naming the milestone it arrives in.

   M5 also puts the service worker registration in this file — see
   registerServiceWorker() below. It is boot's business rather than the
   scanner's or the router's, but index.html is what CALLS it, because offline
   access must not end up behind the encryption gate that now lands between
   start() and startApp().

   M5 note — the two seams this file has been holding open since M1 are filled:
   schedulePush() publishes the encrypted library, and start() opens the gate.
   Both are written so that a library with no sync configured takes the exact
   same path through this file that it took before either existed — see the
   comment above each. That is not politeness; it is the requirement. Sync is
   something a reader opts into, and everything it touches has to be a no-op
   until they do.

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

    /* Real as of M5, and the name was READ OFF THE FILE and not taken from the
       plan: `68-view-stats.js` opens `BT.viewStats = (function () {` and closes
       `return { render };`. The plan said `BT.viewStats` too — but M2 is the
       reason that agreement is checked rather than assumed, because the failure
       when it does not hold is silent. A single name here, not a list: aliases
       added on spec only make the next mismatch harder to see.

       The stub behind it is no longer a promise. It is the answer to "that view
       file failed to parse", so its wording describes the screen that exists —
       reading pace off the progress history, the breakdowns, and the date
       precision histogram that shows what a Google Books key would sharpen. */
    BT.router.on('/stats', viewOr('viewStats', stub(
      ['Shelf', 'Stats'], 'Stats', 'M5',
      'Pages read over time from your logged progress, counts by status, genre, author, decade and format, and how precisely the catalogue actually knows each publication date. Part of')));

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
      'Recalculate genres after a rules change, add genres of your own, an optional Google Books key, region and language, diagnostics, and Export / Import. Part of')));

    /* Real as of M5, and the name was READ OFF THE FILE rather than taken from
       the plan: `71-view-unlock.js` closes with `BT.viewUnlock = {` and a
       `render`. Seventy-ONE, because 70 is the follows logic module — the file
       carries the same note, and index.html has promised this number since M4.

       The stub behind it is no longer a promise; it is the answer to "that view
       file failed to parse". Which is a case worth thinking about here more
       than anywhere else: if 71 is broken, `canGate` in start() is false, the
       gate never opens, and the app runs local-first with this sentence on
       #/unlock. That is the right degradation — a sync layer that cannot draw
       its own screen must not be able to hold the library shut. */
    BT.router.on('/unlock', viewOr('viewUnlock', stub(
      ['System', 'Sync'], 'Sign in', 'M5',
      'A passphrase encrypts your library in this browser and publishes it to a GitHub repository you own, so another device can pick it up. Part of')));

    /* An item is not a page. It selects into the inspector and leaves the list
       underneath it intact — the route survives only so that links still
       work. */
    /* `alive` is forwarded, not dropped. This handler renders the library
       underneath the pane, and 62-view-list.js now aborts its write when the
       route has moved on — handing it nothing would opt this one route back
       out of that guard, which is exactly the route a stale link arrives on. */
    BT.router.on('/item/:uid', async (p, q, alive) => {
      await library({}, {}, alive);
      if (alive && !alive()) return;
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

  /* Ask the browser not to evict the library. Best-effort hygiene: the answer
     changes nothing this app then does, so NOTHING may wait on it.

     THE BARE `await` THIS REPLACES COST FIREFOX THE ENTIRE APP.
     navigator.storage.persist EXISTS in Firefox, so the feature detect passed
     — but Firefox answers it out of the persistent-storage permission prompt,
     and until that prompt is answered the promise is not rejected, it is
     PENDING, indefinitely. A try/catch cannot see a promise that never settles,
     so nothing threw, nothing rejected, and nothing logged: start() simply
     parked on that line, one statement before the round-trip probe and three
     before startApp(). The shell drew, `window.BT` was fully built, and there
     was no tree, no router, no view and not one line in the console — the same
     bricked app the try/catch around BT.tree.refresh() was written to prevent,
     reached one step earlier and completely silently. Measured, not assumed:
     stubbing persist() to resolve and changing nothing else took Firefox from
     0 tree rows to the same 32 Chromium draws.

     So: fire it, never await it, and say so out loud if it does not answer.
     Absent altogether on WebKit — Safari exposes no navigator.storage at all
     (checked in all three engines, not assumed) — which the guard covers. */
  function requestPersistence() {
    const store = navigator.storage;
    if (!store || typeof store.persist !== 'function') return;
    /* The point of this timer is the next engine, not this one: a persist()
       that never answers now announces itself in one console line instead of
       costing another bisect through the boot sequence. */
    const nag = setTimeout(() => {
      console.warn('[boot] navigator.storage.persist() has not answered after 5s — this browser is '
        + 'probably holding it behind a permission prompt. Boot did not wait for it, by design.');
    }, 5000);
    /* Promise.resolve().then(...) so a synchronous throw from persist() lands
       in the same rejection path as an asynchronous one. */
    Promise.resolve().then(() => store.persist()).then(ok => {
      clearTimeout(nag);
      if (!ok) console.info('[boot] storage is not persistent here; the browser may evict the library under pressure');
    }, e => {
      clearTimeout(nag);
      console.warn('[boot] could not ask for persistent storage', e);
    });
  }

  async function probeStorage() {
    requestPersistence();          // deliberately not awaited — see above
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

  /* ── Encrypted publish · M5 ───────────────────────────────────────────
     Saves must feel immediate, but every one is a git commit, and GitHub's
     binding limit here is the SECONDARY one — 80 content-generating requests a
     minute, not the 5,000/hour primary. So: fire quickly after a change
     (SAVE_DELAY), but never closer together than MIN_GAP. A burst of edits
     coalesces into one commit; a single edit lands in about a second.

     Rating a book, ticking a status and typing a page number are three writes
     in five seconds on one interaction, and the reading-progress control
     commits on every blur — so this debounce is not a nicety. Without the
     floor, a session of shelving a bag of charity-shop paperbacks would post a
     commit per book and be throttled halfway through.

     THE FIRST LINE IS THE WHOLE "SYNC IS ADDITIVE" GUARANTEE. Not unlocked, no
     write token, no repository, or the cloud module simply absent from the
     page: return, silently, having done nothing. Every mutation in the app
     calls this, so anything else here would turn a local-first library into
     one that logs errors on every edit. */
  const SAVE_DELAY = 900;
  const MIN_GAP = 4000;
  let lastPushAt = 0;
  let pendingPush = false;
  let pushTimer = null;

  function canPublish() {
    return !!(BT.cloud && BT.crypto && BT.crypto.isUnlocked() &&
              BT.cloud.hasWriteToken() && BT.cloud.configured());
  }

  function schedulePush() {
    if (!canPublish()) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    const since = Date.now() - lastPushAt;
    const wait = Math.max(SAVE_DELAY, MIN_GAP - since);
    pushTimer = setTimeout(async () => {
      lastPushAt = Date.now();
      refreshFooter('saving');
      try {
        await BT.cloud.publish();
        refreshFooter();
      } catch (e) {
        refreshFooter('error');
        /* THREE FAILURES, AND TWO OF THEM NEED A DIFFERENT SCREEN. Everything
           that reaches here stops changes being saved, but only a passing
           network failure fixes itself, so the other two get an action rather
           than a sentence the reader has to decode:

             token rejected     expired or revoked. 16-cloud maps GitHub's 401
                                and 403 to plain English before it gets here.
                                → the token screen.
             re-encrypted       somebody changed the passphrase on another
                                device, so this one holds a key that no longer
                                opens the file. 16-cloud refuses to publish over
                                it rather than silently reverting the change.
                                → drop the stale key and sign in again, which
                                  picks up the NEW salt from the new envelope.
             anything else      usually a network that will be back. Said once,
                                in the banner, not repeated per edit. */
        const msg = (e && e.message) || '';
        const dead = /token|401|rejected|expired|Bad credentials/i.test(msg);
        const rekeyed = /re-encrypted/i.test(msg);
        BT.ui.banner(
          rekeyed
            ? 'The passphrase was changed on another device, so this one can no longer save. Sign in again with the new one — nothing has been lost.'
          : dead
            ? 'Your GitHub token was rejected, so changes are no longer being saved. Enter a new one to start saving again.'
            : 'Could not save to your repository: ' + msg,
          rekeyed ? { actionLabel: 'Sign in', onAction: () => { BT.crypto.lock(); BT.gate.open(); } }
          : dead ? { actionLabel: 'Fix it', onAction: () => BT.gate.open({ mode: 'token' }) }
          : {});
      } finally {
        pendingPush = false;
      }
    }, wait);
  }

  /* Closing the tab straight after an edit would otherwise lose it: the timer
     above is still counting down when the page goes. `pagehide` rather than
     `beforeunload` because it is the one that fires on iOS, which is where a
     PWA is most likely to be dismissed mid-edit. The request is fire-and-
     forget — there is no time to await it and nothing useful to do with the
     answer — and a rejection is swallowed rather than left to surface as an
     unhandled rejection in a page that is already gone. */
  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!pendingPush || !canPublish()) return;
      clearTimeout(pushTimer);
      pendingPush = false;
      BT.cloud.publish().catch(() => {});
    });
  }

  /* ══ The service worker, and the update it is not allowed to force ═══════
     sw.js precaches the app shell so that an installed BookTrak opens in a
     bookshop basement. What lives HERE is the other half: noticing that a new
     shell has been installed, and asking before it is used.

     THE WHOLE DESIGN IS "NEVER SWAP UNDER A RUNNING TAB".
     sw.js does not call skipWaiting() and does not call clients.claim(), so a
     newly installed worker sits in `waiting` doing nothing at all. That is not
     caution for its own sake — this app has two states where a reload is
     genuinely destructive:

       a live camera   iOS revokes camera permission for a standalone PWA the
                       moment the page goes (WebKit 215884, same bug that makes
                       the scanner an overlay instead of a route), and it cannot
                       be re-granted from inside the app. An update that reloads
                       the page mid-scan costs the user their camera until they
                       find BookTrak in iOS Settings.
       a half-typed    BT.ui.setProgress writes on commit, not on keystroke.
       page number     Reloading over it loses what was typed.

     So the sequence is: worker installs → waits → we toast → the reader presses
     Reload → we message sw.js, which is the ONLY thing that ever calls
     skipWaiting() → the new worker activates → controllerchange fires → we
     reload once. Nothing in that chain happens without the press.

     And the press cannot happen mid-scan, because the toast is held back for
     as long as BT.router.suspended is true — which the router sets around
     getUserMedia and clears once every track is stopped, so it is exactly the
     window in which a MediaStream is live. Nothing in this file navigates,
     touches location.hash, or calls router.go(); the one thing it does to the
     page is location.reload(), and that is behind both guards. */

  /* Relative, always. BookTrak is served from /Lorelaibrary/ — '/sw.js' asks
     the origin root, which belongs to neither this app nor MovieTrak, and would
     404. It is also what sets the worker's SCOPE to this app's directory, so
     the registration cannot reach MovieTrak's pages next door. */
  const SW_URL = 'sw.js';
  /* A tab left open for a week never navigates, so the browser never re-checks
     sw.js on its own. Ask again on the way back in — cheap, and it is the only
     thing that makes the toast reachable for the way this app is actually used. */
  const SW_RECHECK_MS = 30 * 60 * 1000;
  /* How long to wait before re-testing whether the scanner has closed. */
  const SW_QUIET_MS = 5000;

  let swWired = false;
  let updateOffered = false;
  let updateAccepted = false;
  let reloading = false;

  const scanning = () => !!(BT.router && BT.router.suspended);

  function showUpdateToast(worker) {
    /* Hold, do not drop. A scan session ends in seconds to minutes, and the
       waiting worker is patient — there is nothing to lose by asking later and
       a camera to lose by asking now. */
    if (scanning()) { setTimeout(() => showUpdateToast(worker), SW_QUIET_MS); return; }
    if (!BT.ui || !BT.ui.toast) return;
    BT.ui.toast('A new version of BookTrak is ready.', {
      actionLabel: 'Reload',
      ms: 20000,
      onAction: () => {
        if (scanning()) return;
        updateAccepted = true;
        /* sw.js answers this by calling skipWaiting(). It is the only message
           it listens for and the only path to that call. */
        worker.postMessage({ type: 'BT_SKIP_WAITING' });
      },
    });
  }

  /* Offered once per page load, on purpose. A toast that came back every few
     minutes would be nagging, and nothing is lost by letting it go: the worker
     stays in `waiting`, and the `reg.waiting` check in registerServiceWorker()
     finds it again on the next load. */
  function offerUpdate(worker) {
    if (!worker || updateOffered) return;
    updateOffered = true;
    showUpdateToast(worker);
  }

  function registerServiceWorker() {
    /* index.html checks these before calling — that is where someone asking
       "why is there no offline here" will look first — and they are repeated
       because this is also reachable from the console.

       The file: test is not covered by isSecureContext, however much it looks
       like it should be: Chromium reports isSecureContext === true for a
       file:// document and then rejects register() with "The URL protocol of
       the current origin ('null') is not supported". Checked in a browser, not
       inferred. Without this line, every local double-click open logs a
       warning about a failure that is really just an unsupported environment,
       and the app is otherwise completely fine. Firefox needs the third test
       instead: there, navigator.serviceWorker does not exist on file:// at
       all. */
    if (!window.isSecureContext) return null;
    if (location.protocol === 'file:') return null;
    if (!('serviceWorker' in navigator)) return null;
    if (swWired) return null;
    swWired = true;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      /* sw.js never claims clients, so the ONLY way the controller changes is
         the skipWaiting we just asked for. The flag is belt and braces against
         a future worker that does claim, which would otherwise reload every
         open tab the first time it installed. */
      if (!updateAccepted || reloading || scanning()) return;
      reloading = true;
      location.reload();
    });

    return navigator.serviceWorker.register(SW_URL).then(reg => {
      /* Already waiting when the page loaded: an update was installed and the
         offer was missed — a toast timed out, or the tab was closed before it
         appeared. The controller check keeps a FIRST install quiet; there is
         no old version to replace, so there is nothing to announce. */
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          if (incoming.state !== 'installed') return;
          if (!navigator.serviceWorker.controller) return;   /* first install */
          offerUpdate(incoming);
        });
      });

      let checkedAt = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || scanning()) return;
        if (Date.now() - checkedAt < SW_RECHECK_MS) return;
        checkedAt = Date.now();
        /* Failure here is a normal offline Tuesday, not a fault. */
        reg.update().catch(() => {});
      });

      return reg;
    }).catch(e => {
      /* A warning, never a throw. Everything this app does works without a
         service worker; losing it costs offline launches and nothing else. */
      console.warn('[sw] registration failed', (e && e.message) || e);
      return null;
    });
  }

  /* ── Boot in two stages ────────────────────────────────────────────────
     The repository holds the library, so nothing renders until there is a
     dataset to render against. From M5 the encryption gate sits between the
     two stages: start() prepares storage, the gate decrypts, and startApp()
     runs only once there is a decrypted library (or the visitor has explicitly
     chosen to work offline). Splitting it this way means no view ever renders
     against a half-populated store — which is why the seam exists from M1,
     even though today the two halves run back to back. */
  /* ── The boot watchdog ────────────────────────────────────────────────
     The Firefox persist() hang was invisible for exactly one reason: a boot
     that has stopped half way looks identical to a boot that is still going.
     Nothing in start() said how far it had got, so the only way to find the
     parked await was to bisect the sequence by hand against three browsers.

     This is the line that would have found it on the first reload. Each stage
     stamps its name as it completes; if startApp() has still not run some
     seconds later, the stamp names the last stage that finished — and whatever
     comes after it in the source is the thing that never came back.

     Longer than the 10s guard inside BT.db.open(), on purpose: an IndexedDB
     open that is slow but still going to degrade cleanly at ten seconds is not
     a hang, and a watchdog that cries during normal recovery is a watchdog
     everybody learns to ignore.

     The gate is the one legitimate unbounded wait — it is holding for someone
     to type a passphrase, which may take as long as it takes — so reaching it
     disarms the watchdog rather than accusing it. */
  const BOOT_WATCHDOG_MS = 15000;
  let bootPhase = 'scripts parsed';
  let watchdog = null;
  const phase = name => { bootPhase = name; };
  function armWatchdog() {
    watchdog = setTimeout(() => {
      if (appStarted) return;
      console.error(`[boot] the app still has not started ${BOOT_WATCHDOG_MS / 1000}s after boot began. `
        + `Last stage to complete: "${bootPhase}". Whatever follows it never returned.`);
    }, BOOT_WATCHDOG_MS);
  }
  function disarmWatchdog() { clearTimeout(watchdog); watchdog = null; }

  async function start() {
    armWatchdog();
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

    phase('error handlers bound');
    BT.theme.init();
    phase('theme');
    await BT.db.open();
    phase('database open');
    await probeStorage();
    phase('storage probe');

    /* Open Library's data is openly licensed and carries no retention limit,
       so unlike a TMDB-backed app this purge is hygiene rather than
       compliance: BT.TTL.HARD_TTL exists to guarantee that nothing outlives a
       schema change. It still runs on every boot, because the cheapest moment
       to drop a stale row is before anything has read it. */
    BT.repo.cachePurge().then(n => n && console.info(`[boot] purged ${n} expired cache rows`));

    /* ── M5 · the gate ─────────────────────────────────────────────────
       Everything below decides ONE thing: does a passphrase screen come
       between storage being ready and the app being drawn?

       THE DEFAULT ANSWER IS NO, AND THAT IS THE POINT. BookTrak is a
       local-first library that offers sync; it is not an app with accounts.
       The test is BT.cloud.enrolled() — a local, synchronous "has anybody on
       THIS device ever chosen to sync?" — and deliberately NOT
       BT.cloud.configured(), which is true for every visitor to the published
       site because owner/repo can always be inferred from a github.io URL.
       Gating on `configured` would put a passphrase prompt in front of a
       stranger who followed a link, on an app that needs no signup at all.

       The whole block is also feature-detected. If 15/16/71 are missing or
       failed to parse, `BT.cloud` is undefined and this falls straight through
       to startApp() — the same shape 50-ui-core and 39-scan use around
       BT.sync.retier, and for the same reason: a missing sync layer means
       "nothing to sync", never a dead app. */
    const canGate = !!(BT.cloud && BT.crypto && BT.gate);
    if (!canGate || !BT.cloud.enrolled()) { await startApp(); return; }

    /* A device that chose "stay signed in" holds the derived key, so it can go
       straight to the current library without asking again. */
    phase('encryption gate reached');
    let resumed = false;
    let unreachable = false;
    let vanished = false;
    if (BT.crypto.available() && BT.crypto.isRemembered()) {
      try {
        if (await BT.crypto.restoreFromDevice()) {
          try {
            const down = await BT.cloud.syncDown();
            resumed = true;

            /* ── THE ONE ABSENCE WORTH INTERRUPTING SOMEBODY FOR ───────────
               syncDown() answering `absent` is normally silence, and must be:
               on the published site BT.cloud infers owner/repo straight out of
               the github.io URL, so a repository can always be NAMED and a
               library has almost never been PUBLISHED under it. A 404 there is
               the ordinary first-run state of a fresh deployment, and a banner
               for it would greet every reader with a fault that does not
               exist. It is not logged either — see BT.cloud.repoSource, and
               note that the browser's own red 404 line is why the request is
               skipped rather than merely quietened.

               All three of these have to hold before anything is said:
                 · absent          the file definitively is not there. A 500 or
                                   a dead socket throws instead and lands in the
                                   catch below, where it always has.
                 · source 'stored' a human typed this repository into Settings.
                                   An inferred name is right by construction and
                                   cannot be the thing that is wrong.
                 · everPublished   this device has read or written that file
                                   before, so we know it existed. Without this,
                                   a device that set a passphrase but never
                                   added a token — enrolled, nothing published,
                                   entirely normal — would be nagged on every
                                   launch about a file that was never meant to
                                   be there yet.

               Together they say something specific and actionable: the library
               this device was syncing with is no longer at the name it was
               told to look under. That is a typo'd repository, a renamed one,
               or a deleted file — and every one of them means saving has
               quietly stopped, which is the failure this app must never let
               pass in silence. */
            vanished = !!(down && down.absent && down.source === 'stored' && down.everPublished);
          } catch (e) {
            /* THE KEY IS IN HAND AND THE NETWORK IS NOT. Start anyway, on the
               copy this device already holds — which is the last state that
               was synced down, not a fragment. Dropping to the gate here would
               be the worst of both: it cannot reach the file either, so it
               would have nothing to sign in to, and the reader would be locked
               out of their own books by an aeroplane. The banner below says
               what happened; the next successful publish merges. */
            console.warn('[boot] library unreachable, using the local copy', e && e.message);
            resumed = true;
            unreachable = true;
          }
        }
      } catch (e) {
        console.warn('[boot] could not resume session', e);
        BT.crypto.lock();
      }
    }

    if (resumed) {
      await startApp();
      if (unreachable) {
        BT.ui.banner('Could not reach your library just now, so this is the copy stored on this device. Changes will be saved and merged as soon as it is reachable again.');
      } else if (vanished) {
        /* Deliberately not phrased as "your library is gone": it is not, the
           app is running on it. What is gone is the published copy at the name
           this device was given, and the name is the thing a reader can fix. */
        BT.ui.banner(
          `There is no library file in ${BT.cloud.repo()} any more, though this device has synced with `
          + 'one there before. Your books are safe in this browser — check the repository is still '
          + 'the right one, or sign in again to publish afresh.',
          { actionLabel: 'Settings', onAction: () => BT.router.go('#/settings') });
      }
      return;
    }
    /* Waiting on a human now, not on the browser. */
    disarmWatchdog();
    await BT.gate.open();
  }

  /* Everything from here needs a populated store. */
  let appStarted = false;
  async function startApp() {
    if (appStarted) return;
    appStarted = true;
    disarmWatchdog();

    routes();
    /* BEFORE BT.tree.init(), and the order is not cosmetic. rowNav binds its
       keydown to #view and the tree binds its own to `document`; #view is a
       descendant, so the row handler runs first and can settle Up/Down for the
       shelf without the tree's highlight also jumping. Initialising it after
       the tree would not change that — bubble order is decided by the DOM, not
       by registration — but keeping the two together here is what makes the
       relationship visible to whoever adds the third keyboard surface. */
    BT.ui.rowNav.init();
    BT.tree.init();
    BT.inspector.init();
    /* THE ROUTER MUST START. This await is the only thing between a stored
       record and every screen in the app, and it reads the whole library to
       count it — so anything the tree cannot digest used to abort startApp()
       before BT.router.start() below, leaving a blank shell with no Settings,
       no Export and no Erase: an app that can only be recovered by clearing
       site data, which is the one action that also destroys the library.
       A tree that failed to build is a navigation aid missing; a router that
       never started is the whole app missing. The error is logged rather than
       swallowed silently, and every route below still renders — including the
       ones that let the reader export or erase their way out. */
    try { await BT.tree.refresh(); }
    catch (e) { console.error('[boot] the index tree could not be built', e); }

    BT.repo.subscribe((ev, detail) => {
      /* M5 — the ONLY place a save is triggered. Four events, and the list is
         exactly the set that changes something the repository holds:
         `item:put` and `item:delete` cover the library, `follow:change` covers
         who you follow, and `feed:change` covers activity being read or
         coalesced (which matters, because "read anywhere is read everywhere"
         is only true if the read travels).

         Deliberately NOT here: `import:done`, `wipe` and `sync:merged`. Import
         and merge are followed by an explicit publish on their own path, and
         republishing from the event as well would race the write that raised
         it. `wipe` is an erase of THIS BROWSER, and turning that into a commit
         would make "clear this device" quietly mean "delete the library
         everywhere" — see the Settings copy, which promises it does not.

         schedulePush is a no-op whenever sync is not set up, so this line
         costs a function call on a local-only library and nothing else. */
      if (ev === 'item:put' || ev === 'item:delete' ||
          ev === 'follow:change' || ev === 'feed:change') schedulePush();

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
    flushOnExit();

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

  return { refreshFooter, schedulePush, registerServiceWorker, start, startApp };
})();
