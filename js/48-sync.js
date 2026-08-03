/* ══════════════════════════════════════════════════════════════════════════
   Refresh scheduling and the sweep runner.

   NOT CLOUD SYNC, despite the name. The name is inherited from MovieTrak,
   where this file has always been the item-refresh scheduler; the encrypted
   GitHub sync lives in 15-crypto.js and 16-cloud.js. Renaming it here would
   break the seams that already reference it by name — 50-ui-core.js and
   39-scan.js both call `BT.sync.retier`, and 90-boot.js calls
   `BT.sync.sweep` — so the name stays and this paragraph is the correction.

   A static page has no background worker, so "keeping up to date" means: when
   the app is open, spend a bounded number of requests on whatever is most
   stale and most likely to have changed. The tier table (BT.TIERS) decides how
   often a book is worth re-checking; the urgency queue decides what to spend
   today's budget on.

   ── WHAT THIS SWEEPER DOES NOT DO, AND WHO DOES IT ───────────────────────
   Two sweepers hang off one trigger in 90-boot.js and they must not overlap.
   The division is deliberate and each half is documented on the other side:

     45-alerts.js   the local diff pass (scanStored) and the FOLLOWS poll.
                    Cooldown key `alerts.lastSweepAt`.
     here           refreshing stale item records from Open Library.
                    Cooldown key `sync.lastSweepAt`.

   So this file never calls scanStored and never touches a follow. Polling
   follows from two places would double-spend a one-request-per-second
   allowance and, worse, both would stamp `lastCheckedAt` — the field the
   round-robin sorts on — so the roster would rotate twice as fast as either
   sweeper believed and some follows would never be reached.

   ── AND IT NEVER SPENDS THE GOOGLE BOOKS BUDGET ──────────────────────────
   BT.SWEEP.autoBudget declares a `googlebooks` allowance, and this sweeper
   deliberately leaves it alone. That key is the reader's own, metered at about
   a thousand requests a day, and the Settings screen makes two promises in
   print: that dates are sharpened "lazily, one book at a time, as you open
   it — never in bulk on startup", and that the bulk pass is a button you press.
   A background sweeper quietly spending it would make both statements false.
   The allowance exists for the manual pass in 69-view-settings.js, which is
   where it is spent.

   `covers` is untouched for a duller reason: nothing in this app ever fetches
   a cover through BT.net. Covers are `<img src>` URLs built by
   BT.openlibrary.coverUrl and fetched by the browser, so there is no covers
   budget to spend from JavaScript at all.
   ══════════════════════════════════════════════════════════════════════════ */

BT.sync = (function () {
  let sweeping = false;
  let abort = null;

  /* ── Tiering ───────────────────────────────────────────────────────────
     Most of a book library lives in T4 forever, and that is the point. A 1965
     novel is a finished, frozen object: its record changes when a volunteer
     improves the cataloguing, which is worth noticing twice a year and not
     twice a day.

     THE ONE PLACE THIS DIVERGES FROM MOVIETRAK is the treatment of dates, and
     for the same reason 45-alerts.js needed its own `withinWindow`: a
     year-precision publication date ANCHORS to January 1 (BT.util.sortKeyOf),
     so "1965" and "January 1965" and "1 January 1965" all carry sortKey
     19650101. Reading days-until off that key and putting anything inside a
     fortnight into the fastest tier would file every book recorded as "this
     year" into T0 every January, and re-poll a settled backlist on a twelve-
     hour cycle for no possible gain. So the fast tiers are available only to
     records that actually state a month or a day; a bare year is judged on the
     year alone. */
  function tierOf(item) {
    const t = item.tracking || {};
    if (t.mutedFlag) return 'T5';

    const rel = item.release || {};
    const status = (item.user && item.user.status) || '';

    /* Being read RIGHT NOW earns T1 whatever the date says. This is the one
       record the reader looks at daily, its page count is the denominator of
       the progress bar, and a wrong extent is the most visible error the app
       can make. BT.TIERS spells T1 as "publishes soon, or currently reading". */
    if (status === 'reading') return 'T1';

    const dated = Number.isFinite(rel.sortKey) && rel.sortKey < BT.util.SK_UNKNOWN;
    /* Only these two precisions describe a real point in the calendar. Anything
       coarser is a window, and BT.util.daysUntil on a window's anchor is an
       arithmetic fact about the anchor, not about the book. */
    const precise = rel.precision === 'day' || rel.precision === 'month';
    const days = dated ? BT.util.daysUntil(rel.sortKey) : null;

    if (dated && precise) {
      /* A dated book about to appear, or one that just did. Open Library has no
         street dates, so this only ever fires on records a Google Books lookup
         sharpened — which is exactly the set worth watching closely. */
      if (days >= -7 && days <= 30) return 'T0';
      if (days > 30 && days <= 120) return 'T1';
    }

    if (dated) {
      const parts = BT.util.sortKeyToParts(rel.sortKey);
      const year = parts ? parts.y : null;
      const thisYear = new Date().getFullYear();
      /* Published last year, this year, or still ahead: the record is young,
         the cataloguing is still settling and new printings are arriving. One
         year of slack because Open Library's years are coarse and cataloguing
         routinely lags publication by months — the same slack 45-alerts.js
         gives its backlist test, and for the same reason. */
      if (year != null && year >= thisYear - 1) return 'T2';
    }

    /* Asked to be told when a new printing or format appears — the paperback
       drop. That is the one thing about a published book that still moves, and
       it moves in the EDITIONS list rather than in the work record, so it is
       worth a fortnightly look even on an old title. */
    if (t.watchEditionsFlag || t.watchReleaseFlag) return 'T2';

    /* No date at all. Open Library holds no forthcoming data, so an undated
       work is usually just a thin record rather than an announced book — but it
       is also the only state a date can arrive INTO, which is the single most
       valuable thing this app can notice about a book. Monthly. */
    if (!dated) return 'T3';

    return 'T4';
  }

  function retier(item) {
    const tier = tierOf(item);
    item.tracking = item.tracking || {};
    item.tracking.tier = tier;
    const ttl = BT.TIERS[tier].ttl;
    item.tracking.refreshDueAt = ttl === Infinity
      ? Number.MAX_SAFE_INTEGER
      : (item.tracking.lastRefreshAt || 0) + ttl;
    return item;
  }

  /* Urgency ages automatically: an item skipped this sweep has a larger
     staleness ratio next time, so it rises without any explicit fairness pass. */
  function urgency(item) {
    const t = item.tracking || {};
    const tier = BT.TIERS[t.tier || 'T2'];
    if (!tier || !tier.weight) return 0;
    const age = Date.now() - (t.lastRefreshAt || 0);
    const ratio = tier.ttl === Infinity ? 0 : age / tier.ttl;
    let affinity = 1;
    /* Ratings are out of ten here (56-inspector draws ten ticks). `priority` is
       carried in the shape and written by nothing yet; it stays in the sum so
       the day a "next up" control lands it needs no change here. */
    const u = item.user || {};
    if (u.rating >= 8 || u.priority > 0) affinity = 1.3;
    return ratio * tier.weight * affinity;
  }

  /* ── The sweep ─────────────────────────────────────────────────────── */

  async function sweep(opts) {
    opts = opts || {};
    if (sweeping) return { skipped: 'already-running', checked: 0, alerts: 0 };

    const last = (await BT.repo.metaGet('sync.lastSweepAt')) || 0;
    if (!opts.manual && Date.now() - last < BT.SWEEP.cooldownMs) {
      return { skipped: 'cooldown', nextAt: last + BT.SWEEP.cooldownMs, checked: 0, alerts: 0 };
    }

    sweeping = true;
    abort = new AbortController();
    /* Copied, never mutated in place: BT.SWEEP is shared config and a sweep
       that decremented it would permanently shrink every later run's
       allowance. */
    const budget = Object.assign({}, opts.manual ? BT.SWEEP.manualBudget : BT.SWEEP.autoBudget);
    const report = { checked: 0, alerts: 0, errors: 0, skipped: 0, started: Date.now() };

    try {
      const all = await BT.repo.allItems();
      for (const it of all) retier(it);

      /* A record that has never been refreshed has `lastRefreshAt: 0`, so its
         refreshDueAt lands in 1970 and it is due immediately whatever its tier
         says. THAT IS THE INTENDED BEHAVIOUR AND IT IS ALSO THE FIRST SWEEP
         AFTER A SIGN-IN: every item that arrives from the encrypted library is
         marked `meta.partial` by BT.normalize.leanForSync, because subjects,
         descriptions and candidate ISBNs are stripped for transport. So the
         first sweep on a new device spends its whole budget putting back
         exactly what was left out, oldest-first, which is the work it should be
         doing.

         It does not produce a feed full of noise, and the reason is worth
         knowing: `snapshots` is deliberately absent from BT.repo's SYNC_STORES,
         so a fresh device has none, and 45-alerts' cold-snapshot rule turns
         every one of those first diffs into a silent baseline. Sync that
         restored snapshots would announce forty "date firmed up" rows the first
         time a new phone was used. */
      const due = all
        .filter(it => (it.tracking.tier !== 'T5') &&
                      (it.tracking.refreshDueAt || 0) <= Date.now())
        .map(it => ({ it, u: urgency(it) }))
        .sort((a, b) => b.u - a.u);

      /* The budget counts BOOKS, not requests, and one book costs one or two
         upstream calls — a work record, plus an edition record when the reader
         has pinned the copy they own. The editions LIST is deliberately not
         asked for (`editions: false` in refreshItem), which is what keeps a
         sweep of forty books off the half-megabyte responses a classic's
         edition list returns. BT.net's token bucket paces whatever this queue
         hands it at one request a second, so the ceiling that matters for
         politeness is already enforced a layer down; this one is about total
         volume. */
      const cap = Math.min(due.length, Math.max(0, budget.openlibrary || 0));

      for (let i = 0; i < due.length; i++) {
        if (abort.signal.aborted) break;
        if (budget.openlibrary <= 0) { report.skipped++; continue; }
        const item = due[i].it;
        budget.openlibrary--;

        try {
          const fresh = await refreshItem(item, { signal: abort.signal });
          if (fresh) {
            /* 45-alerts owns what counts as news. Called AFTER the merged
               record is written, which is the contract stated in that file:
               the snapshot it stores has to match what is on the shelf, or the
               next sweep re-announces the change it just recorded. */
            const emitted = (BT.alerts && BT.alerts.checkItem)
              ? await BT.alerts.checkItem(fresh) : [];
            report.alerts += emitted.length;
          }
          report.checked++;
        } catch (e) {
          if (e && e.kind === 'abort') break;
          report.errors++;
          item.tracking.consecutiveFetchErrors = (item.tracking.consecutiveFetchErrors || 0) + 1;
          /* AN UPSTREAM 404 IS NEVER ALLOWED TO DELETE USER DATA. Open Library
             records are edited by volunteers and works do get merged and
             re-keyed, so a missing work id means "this OLID moved" at least as
             often as it means anything else. It earns a `missSince` stamp and
             a refreshed clock so the book stops being retried every sweep, and
             nothing more; the book, its rating, its notes and its reading
             history stay exactly where they are. */
          if (e && e.kind === 'notfound') {
            if (!item.tracking.missSince) item.tracking.missSince = Date.now();
            item.tracking.lastRefreshAt = Date.now();
            await BT.repo.putItemQuiet(retier(item));
          }
        }
        BT.repo.emit('sweep:progress', { phase: 'remote', done: i + 1, total: cap });
      }

      await BT.repo.metaSet('sync.lastSweepAt', Date.now());
      report.finished = Date.now();
      BT.repo.emit('sweep:done', report);
      return report;
    } finally {
      sweeping = false;
      abort = null;
    }
  }

  /* Refresh a single book from Open Library and merge.

     There is no per-item source switch. MovieTrak had three catalogues and had
     to pick one; here Open Library is the only source that can answer "what is
     this work now", and Google Books is a date-sharpening pass that the reader
     opts into by supplying a key. */
  async function refreshItem(item, opts) {
    opts = opts || {};
    const ol = BT.openlibrary;
    if (!ol || typeof ol.hydrate !== 'function') return null;
    if (!item || !item.ids || !(item.ids.olWork || item.ids.olEdition || item.ids.isbn13)) return null;

    /* `editions: false` — the candidate-ISBN list is a nicety filled on add and
        when a book is opened, and asking for it here would turn a forty-book
        sweep into forty fifty-row responses for a list nobody is reading. See
        the budget note above. */
    const fresh = await ol.hydrate(item, { fresh: true, editions: false, signal: opts.signal });
    if (!fresh) return null;

    /* RE-READ BEFORE MERGING, for the reason 50-ui-core.js documents at length
       on its own hydrate path: an Open Library round trip is one to three
       seconds, and everything the reader did to this book in that window is
       already committed to the database and missing from the copy in hand.
       mergeItem's rule is "user-authored state always wins", but it can only
       mean "wins over the record it was GIVEN" — hand it a pre-request snapshot
       and it faithfully writes the stale user block back over the fresh one.

       A MISSING ROW ENDS THE WRITE for the same reason: the window covers a
       delete, and merging into the copy we still hold would put the book
       straight back, tombstone and all. */
    const current = await BT.repo.getItem(item.uid);
    if (!current) return null;

    const merged = BT.normalize.mergeItem(current, fresh);
    if (!merged) return null;

    recordDrift(current, merged);

    merged.meta = merged.meta || {};
    merged.meta.partial = 0;
    merged.meta.detailsFetchedAt = Date.now();
    merged.tracking = merged.tracking || {};
    merged.tracking.lastRefreshAt = Date.now();
    merged.tracking.consecutiveFetchErrors = 0;
    /* A record that answered is not missing any more, whatever it did last
       month. Leaving the stamp behind would let one bad Tuesday mark a book
       "may have been removed" for ever. */
    delete merged.tracking.missSince;
    retier(merged);
    BT.repo.dfObserve(merged.uid, Object.keys((merged.rec && merged.rec.terms) || {}));
    await BT.repo.putItemQuiet(merged);
    return merged;
  }

  /* Record date drift on the item, so the list can draw "← 243d" and the
     inspector can show a Date history. Both of those renderers already exist
     (BT.ui.driftBadge, 56-inspector's driftHistory) and nothing has been
     filling the ledger they read.

     REFINEMENT IS NOT MOVEMENT, and this is the whole reason the function is
     more than two lines. Most of a book library is year-precision, a year
     anchors to January 1, and the first Google-sharpened or edition-pinned
     hydrate therefore moves the sort key by up to 364 days without the book's
     publication date having changed at all. A naive port of MovieTrak's
     `sortKey !== sortKey` test — correct there, because every TMDB date is a
     full date — would have stamped a drift badge on most of the shelf the
     first time this swept, and a badge has no room to explain itself.

     The containment test is 45-alerts.js's, ASKED FOR rather than copied, so
     the badge and the activity row can never disagree about one event. If that
     module is absent or failed to parse, nothing is recorded: an empty ledger
     costs a badge, a wrong one costs trust. */
  function recordDrift(before, after) {
    const a = before && before.release;
    const b = after && after.release;
    if (!a || !b) return;
    if (!Number.isFinite(a.sortKey) || !Number.isFinite(b.sortKey)) return;
    if (a.sortKey === b.sortKey) return;
    if (a.sortKey >= BT.util.SK_UNKNOWN || b.sortKey >= BT.util.SK_UNKNOWN) return;

    const within = BT.alerts && typeof BT.alerts.withinWindow === 'function';
    if (!within) return;
    if (BT.alerts.withinWindow(a.sortKey, a.precision, b.sortKey)) return;   // refined, not moved

    /* pickRelease carries `history` forward from the incumbent, so this appends
       to whatever the merge preserved rather than to the pre-merge copy. */
    b.history = (b.history || []).concat([{
      observedAt: Date.now(),
      from: { raw: a.raw, precision: a.precision, sortKey: a.sortKey },
      to: { raw: b.raw, precision: b.precision, sortKey: b.sortKey },
      deltaDays: BT.util.daysBetweenSortKeys(a.sortKey, b.sortKey),
    }]).slice(-BT.LIMITS.driftHistory);
  }

  function cancel() { if (abort) abort.abort(); }
  const isSweeping = () => sweeping;

  return {
    tierOf, retier, urgency, sweep, refreshItem, cancel, isSweeping,
  };
})();
