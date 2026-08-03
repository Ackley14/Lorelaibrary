/* ══════════════════════════════════════════════════════════════════════════
   Change detection.

   The app only sees the world when it is open, so "what changed" is computed
   by diffing a record against a snapshot stored the last time we looked. Two
   rules make that trustworthy, and they are ported from MovieTrak unchanged
   because they are what stopped the feature being dead on arrival there:

   1. COLD-SNAPSHOT RULE. If there is no previous snapshot, store one and emit
      ZERO alerts. Without it, importing a 200-book library produces 600 alerts
      on first run, and following an author with 190 works floods the feed with
      her entire backlist.

   2. CONTENT-ADDRESSED IDS. An alert's identity comes from what the world
      says, never from when we noticed: fnv1a(subject|type|from|to). Two
      browsers observing the same change independently derive the same id, so
      merging exports is idempotent. Including `from` is deliberate — a genuine
      A→B→A revert produces two distinct alerts, because "the date moved back"
      really is news, while re-observing one transition dedupes.

   WHAT IS HONEST TO SAY ABOUT A BOOK. Open Library has no concept of a
   forthcoming or announced title: there is no "coming soon" flag, no street
   date, no publisher feed. Its dates are year-granularity far more often than
   not, and `first_publish_year` is a computed minimum over a work's editions
   that one mis-catalogued reprint drags back decades — The Alloy of Law,
   published 2011, reports 2001. So this file never claims a book is "coming
   out". It says two smaller, true things: a date we hold changed, and a work
   appeared in a catalogue we are watching that was not there last time. The
   second one does catch new books, and it also catches reprints, translations
   and backlist titles a volunteer has only just catalogued. Every string
   emitted here is written so that reading it literally is never wrong.

   ── THE FOLLOW HALF IS NO LONGER A POLLER ─────────────────────────────────
   This module used to fetch a followed author's catalogue itself, on its own
   schedule, and diff it against its own `knownWorkIds`. The Following page did
   the same thing independently for its own strip. Two fetchers, two schedules,
   two ideas of "what I last saw" — which is exactly why the feature "behaved
   strangely": the feed and the page could report different things about the
   same author on the same afternoon, and neither could see the other's work.

   70-follows.js now owns one cached catalogue per follow, one serialized
   refresher, and the diff. This file's job is smaller and clearer: turn that
   diff into feed rows. `recordFollowDiff` is the whole of it, and it is called
   by the refresher after every successful check — including the one at startup
   — so a change cannot be observed without also being reported.

   WHAT THE FEED MAY SAY ABOUT A FOLLOW, now that it can say two things:

     author.newWork      a work id appeared in a catalogue that did not list it
                         before. Literally that, and nothing about release.
     author.dateChanged  a work we already held now carries a different year.
                         This one was IMPOSSIBLE under the old arrangement, not
                         merely absent: `knownWorkIds` is a bag of ids and holds
                         no dates, so there was nothing to compare against. It
                         is the half that makes this a news feed rather than a
                         list of ids.

   WHAT WAS DROPPED FROM MOVIETRAK, and why:

     status.cancelled  a book is not cancelled, it is simply never published,
                       and Open Library has no record of the difference.
     season.new /      no book equivalent. The next volume of a series is a
     episode.next      different WORK with its own record, not a field on this
                       one.
     provider.added    there is no streaming layer for a book.
     release.pulled    STRUCTURALLY IMPOSSIBLE here, which is better than
                       unlikely. BT.normalize.pickRelease refuses a payload
                       that would replace a dated release with an undated one
                       (`if (!fDated && eDated) return keep(existing)`), so a
                       stored date can never be lost to a merge and the alert
                       could only ever be a false positive.
     scanLocal         MovieTrak fired "out today" and "booking window" off
                       pure date arithmetic. Neither survives contact with a
                       book library: precision is year for most of the shelf,
                       so "today" is a fiction, and there are no tickets. The
                       zero-network pass that replaced it is scanStored below,
                       which diffs what other code has already written.
   ══════════════════════════════════════════════════════════════════════════ */

BT.alerts = (function () {

  const SEVERITY = { high: 'high', normal: 'normal', low: 'low' };

  /* A ceiling on the zero-network item pass, so a pathological library cannot
     make "Check now" feel like a hang. The `since` filter does the real work;
     this is only a backstop. */
  const ITEM_SCAN_CAP = 800;

  /* How far into the past a subject can be and still count as news. A date
     recorded for a book published last month is worth a line; the same event on
     a 1965 novel is a cataloguing improvement, and saying "Dune has a
     publication date" in 2026 is worse than saying nothing. Rows past this are
     still written — to the ledger and to the feed — but land archived, so they
     are recoverable under "Show archived" and invisible by default. */
  const STALE_DAYS = 90;

  /* A work newly appearing in a followed catalogue with a publication year
     older than this many years is a backlist title someone has just catalogued,
     not a release. Same treatment: recorded, archived, not shouted about.
     One year of slack because Open Library's years are coarse and cataloguing
     routinely lags publication by months. */
  const BACKLIST_YEARS = 1;

  let sweeping = false;
  let cancelled = false;

  /* ── The snapshot ──────────────────────────────────────────────────────
     Only a whitelist of fields enters. Cover ids, subjects, descriptions,
     edition counts and ISBN lists are deliberately EXCLUDED: they churn every
     time a volunteer touches a record and generate nothing anyone wants to be
     told. `isbnsCandidate` alone reaches 310 entries on a classic and changes
     constantly. That single decision removes most of the false-positive
     surface.

     Note the shape MUST carry `uid`: the snapshots store's keyPath is 'uid',
     and BT.ui.addItem writes `Object.assign({ baseline: 1 }, snapshotOf(item))`
     straight to BT.repo.putSnapshot. It is also called on a freshly-built stub
     that may have no release and no user block yet, so every read here is
     defended.

     WIDE WHITELIST, NARROW ALERTING. `pageCount` and `publishers` are recorded
     but nothing below diffs them, and that is on purpose rather than an
     oversight. Adding a field to the snapshot LATER means every stored snapshot
     lacks it, so the first diff after the upgrade sees `undefined → 412` on
     every book in the library and fires a false alert on all of them — the
     cold-snapshot problem again, at field granularity. Recording early is the
     cheap half of shipping a rule later. */
  function snapshotOf(item) {
    item = item || {};
    const rel = item.release || {};
    return {
      uid: item.uid,
      kind: item.kind || 'book',
      checkedAt: Date.now(),
      fields: {
        title: item.title || '',
        sortKey: rel.sortKey == null ? BT.util.SK_UNKNOWN : rel.sortKey,
        precision: rel.precision || 'unknown',
        status: rel.status || 'unannounced',
        /* Which question the date answers: a work's first-recorded year or a
           specific edition's own imprint date. A move between the two is a
           correction rather than a slip, and the diff says so. */
        basis: rel.basis || 'none',
        raw: rel.raw || '',
        pageCount: item.pageCount == null ? null : item.pageCount,
        publishers: publisherFingerprint(item),
      },
    };
  }

  /* Folded exactly the way 12-repo.js folds its facet keys, so the two cannot
     disagree about whether 'Chilton Books' and 'Chilton books.' are the same
     imprint. */
  function publisherFingerprint(item) {
    const raw = [].concat(item.publishers || [],
                          (item.edition && item.edition.publishers) || []);
    const keys = [];
    for (const p of raw) {
      const name = typeof p === 'string' ? p : (p && p.name);
      if (!name) continue;
      const key = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (key && keys.indexOf(key) < 0) keys.push(key);
    }
    return keys.sort().join('|');
  }

  /* `subject` is a uid for an item alert and `follow:{id}` for a follow alert.
     It is not called `uid` because the follow case has no item to name. */
  function alertId(subject, type, from, to) {
    return BT.util.fnv1a(
      `${subject}|${type}|${from == null ? '' : from}|${to == null ? '' : to}`);
  }

  /* ── The diff ──────────────────────────────────────────────────────────
     Returns a list of CANDIDATE alerts. Persisting them — and therefore
     deduping them — is `commit`'s job. */
  function diff(prev, next, item) {
    const out = [];

    /* THE COLD-SNAPSHOT RULE, enforced here so no caller can forget it. First
       sighting of anything is a baseline only; without this, an import or a
       first follow generates hundreds of false alerts. */
    if (!prev) return out;

    const a = prev.fields;
    const b = next && next.fields;

    /* A second, real cold case. 50-ui-core.js has shipped since M1 with a
       fallback baseline of `{ baseline: 1, uid }` and NO `fields` block, for
       every add made while this file did not exist yet. Those snapshots are in
       users' databases right now. Treating a missing `fields` as "everything
       changed" would announce the title, the date and the page count of every
       book added before M4 the first time a sweep ran. */
    if (!a || !b) return out;

    const UNK = BT.util.SK_UNKNOWN;
    const wasDated = Number.isFinite(a.sortKey) && a.sortKey < UNK;
    const isDated  = Number.isFinite(b.sortKey) && b.sortKey < UNK;
    const rank = { unknown: 0, tba: 0, year: 1, quarter: 2, month: 3, day: 4 };
    const rel = (item && item.release) || {};

    if (!wasDated && isDated) {
      /* A date appearing where there was none. For a forthcoming title this is
         the most valuable event in the app; for a backlist novel whose record
         was simply improved it is not news at all, which is what the staleness
         check in `commit` is for. */
      const ahead = BT.util.daysUntil(b.sortKey);
      out.push({
        type: 'release.dated',
        severity: ahead >= -STALE_DAYS ? SEVERITY.high : SEVERITY.low,
        from: null, to: String(b.sortKey),
        title: `${item.title} — publication date recorded`,
        body: dateBody(rel, b.precision),
        payload: { toPrecision: b.precision },
      });

    } else if (wasDated && isDated) {
      /* REFINEMENT IS NOT MOVEMENT, and separating the two is the single
         book-specific change to this diff.

         MovieTrak could test `sortKey !== sortKey` first and treat a precision
         gain as the leftover case, because every TMDB date is a full date and
         the two conditions never overlapped. Here they overlap almost always: a
         year-precision key ANCHORS to January 1 (BT.util.sortKeyOf), so the
         moment a hydrate turns "1991" into "September 1991" the key moves from
         19910101 to 19910901 — and the naive rule announces "publication date
         changed · 1991 → Sep 1991" for a book whose date did not change at all.
         Most of a real library is year-precision and gets hydrated exactly once,
         so that misreading would have been the DOMINANT row in the feed.

         The honest test is containment: if the new date falls inside the window
         the old precision described, we learned something rather than something
         moved. Only a value that leaves that window is a change. */
      const finer  = (rank[b.precision] || 0) > (rank[a.precision] || 0);
      const inside = withinWindow(a.sortKey, a.precision, b.sortKey);

      if (finer && inside) {
        out.push({
          type: 'release.precision',
          severity: SEVERITY.normal,
          from: `${a.precision}:${a.sortKey}`, to: `${b.precision}:${b.sortKey}`,
          title: `${item.title} — date firmed up`,
          body: `Now ${rel.display || fmtKey(b.sortKey, b.precision)}`,
          payload: { fromPrecision: a.precision, toPrecision: b.precision },
        });
      } else if (a.sortKey !== b.sortKey) {
        out.push(movedAlert(a, b, item));
      }
    }

    /* No `wasDated && !isDated` branch. See the header: pickRelease makes it
       unreachable, and a branch for an unreachable state is a branch nobody
       will ever be able to test. */
    return out;
  }

  function movedAlert(a, b, item) {
    const delta = BT.util.daysBetweenSortKeys(a.sortKey, b.sortKey);
    const basisChanged = a.basis !== b.basis && b.basis === 'edition-published';
    const span = `${fmtKey(a.sortKey, a.precision)} → ${fmtKey(b.sortKey, b.precision)}`;
    return {
      type: 'release.moved',
      /* Judged on WHERE THE BOOK LANDS, not on how far it travelled. MovieTrak
         keyed severity off a 14-day threshold because a film that slips a
         fortnight is news; here most movement is a backlist record being
         corrected from a work's first-recorded year to a specific edition's
         imprint date, which is housekeeping. What actually matters is whether
         the reader is still waiting for the book. */
      severity: BT.util.daysUntil(b.sortKey) >= 0 ? SEVERITY.high : SEVERITY.normal,
      from: String(a.sortKey), to: String(b.sortKey),
      title: `${item.title} — publication date changed`,
      /* A basis change is a CORRECTION, not a slip, and saying which is which
         is the difference between "your preorder moved" and "we found the
         edition you own". Both are worth a line; conflating them is not. */
      body: basisChanged ? `${span} · now taken from this edition rather than the work` : span,
      payload: { deltaDays: delta, fromPrecision: a.precision, toPrecision: b.precision },
    };
  }

  /* Does `other` fall inside the window `sk` described at `precision`? A
     year-precision key is a whole year, a month-precision key a whole month —
     the anchoring to the 1st is a SORT position, not a claim about the day, and
     reading it as one is what turns every hydrate into a false "date changed". */
  function withinWindow(sk, precision, other) {
    const x = BT.util.sortKeyToParts(sk);
    const y = BT.util.sortKeyToParts(other);
    if (!x || !y || x.y !== y.y) return false;
    if (precision === 'year' || precision === 'unknown' || precision === 'tba') return true;
    if (precision === 'quarter') return BT.util.quarterOf(x.m) === BT.util.quarterOf(y.m);
    if (precision === 'month') return x.m === y.m;
    return sk === other;                       // day precision names one day
  }

  /* Never prints a segment the record does not hold. MovieTrak's equivalent
     hard-coded 'day' precision when rendering a stored sort key, which was
     harmless there because TMDB dates are always full dates. Doing the same
     here would print "1965-01-01" for a year-only book and break the one rule
     the whole date grammar rests on — a month-precision book must never
     display a day, on any screen. */
  function fmtKey(sk, precision) {
    const p = BT.util.sortKeyToParts(sk);
    return p ? BT.util.displayRelease(p, precision || 'year') : 'no date';
  }

  function dateBody(rel, precision) {
    const shown = rel.display || 'a date';
    if (precision === 'year') return `${shown} — year only; no month is recorded`;
    if (precision === 'month') return `${shown} — no day is recorded`;
    return shown;
  }

  /* ── Commit ────────────────────────────────────────────────────────────
     Ledger insert, feed upsert and snapshot write happen together per item, so
     a tab closed mid-sweep loses at most one item's work — and, critically, the
     snapshot can never advance past an alert that was not persisted, which
     would swallow the change for ever.

     The ledger is written FIRST and the feed second, so the failure mode is a
     lost feed row rather than a duplicated one. A feed row that never appears
     is invisible; a duplicate is a bug the user can see. */
  async function commit(item, candidates, nextSnapshot) {
    const emitted = [];
    for (const c of candidates) {
      const id = alertId(item.uid, c.type, c.from, c.to);

      /* alertSeen ADDS to the append-only ledger and reports whether the id was
         already there — one round trip, and atomic against a second tab because
         IndexedDB answers the duplicate with a ConstraintError. */
      if (await BT.repo.alertSeen(id)) continue;

      const subjectKey = Number(c.to);
      const stale = Number.isFinite(subjectKey) && subjectKey < BT.util.SK_UNKNOWN &&
                    BT.util.daysUntil(subjectKey) < -STALE_DAYS;

      emitted.push(await BT.repo.pushFeedItem({
        alertId: id,
        uid: item.uid,
        kind: item.kind || 'book',
        type: c.type,
        severity: c.severity || SEVERITY.normal,
        title: c.title,
        body: c.body || '',
        from: c.from, to: c.to,
        payload: c.payload || null,
        archivedFlag: stale ? 1 : 0,
        lastAt: Date.now(),
      }));
    }
    await BT.repo.putSnapshot(nextSnapshot);
    return emitted;
  }

  /* Full check for one item: snapshot → diff → commit. This is the entry point
     for whoever refreshes a record — BT.ui.hydrate today, 48-sync.js's item
     refresher when it lands — and it must be called AFTER the merged record has
     been written, so the snapshot it stores matches what is on the shelf. */
  async function checkItem(item) {
    if (!item || !item.uid) return [];
    const prev = await BT.repo.getSnapshot(item.uid);
    const next = snapshotOf(item);
    if (!prev || !prev.fields) {                       // cold-snapshot rule
      await BT.repo.putSnapshot(Object.assign({ baseline: 1 }, next));
      return [];
    }
    return commit(item, diff(prev, next, item), next);
  }

  /* ── The local pass ────────────────────────────────────────────────────
     Zero network. Diffs every stored item against its own stored snapshot.

     This exists because of a real hole: BT.ui.hydrate merges a fresh Open
     Library record into an item and writes it through BT.repo.putItem WITHOUT
     telling this module. So a search-added stub that arrives with
     `first_publish_year: 2001` and is hydrated ten seconds later to the
     edition's real "August 1, 1990" changed its publication date under the
     reader's nose, and nothing ever said so. Adding a checkItem call inside
     hydrate would have been the tidier fix and was not available — 50-ui-core
     is not this agent's file — but it would also have been the wrong shape:
     hydrate runs unawaited on every add, and the diff belongs on a sweep, not
     in the hot path of adding a book.

     `since` skips items untouched since the last sweep, which is exact rather
     than approximate: if nothing has written the record, its snapshot is still
     current and the diff is guaranteed empty. On the first ever sweep `since`
     is 0, so everything is visited and everything gets a baseline. */
  async function scanStored(opts) {
    opts = opts || {};
    const since = opts.since || 0;
    const items = await BT.repo.allItems();
    const due = items
      .filter(it => touchedAt(it) >= since)
      .sort((x, y) => touchedAt(y) - touchedAt(x))
      .slice(0, opts.cap || ITEM_SCAN_CAP);

    const out = [];
    for (const it of due) {
      if (cancelled) break;
      try {
        for (const row of await checkItem(it)) out.push(row);
      } catch (e) {
        console.warn('[alerts] item check failed', it.uid, e && e.message);
      }
    }
    return { emitted: out, checked: due.length };
  }

  /* Three separate clocks write to an item and only one of them is `user`.
     putItemQuiet — the background-refresh path — deliberately does NOT bump
     user.updatedAt, so keying on that alone would make every quietly-refreshed
     book invisible to the pass above, which is exactly the set of books most
     likely to have changed. */
  function touchedAt(item) {
    const u = item.user || {}, m = item.meta || {}, t = item.tracking || {};
    return Math.max(u.updatedAt || 0, m.detailsFetchedAt || 0, t.lastRefreshAt || 0);
  }

  /* ══ FOLLOWS — turning one diff into feed rows ═════════════════════════
     Watching a followed AUTHOR rather than each tracked book is the only way a
     book that is not in the library yet can ever be discovered: one query
     covers a whole bibliography, and there is no other endpoint that answers
     "what is new from this person" at all.

     NOTHING HERE FETCHES ANYTHING. That is the change. 70-follows.js holds one
     cached catalogue per follow, refreshes it on one serialized queue, and
     computes the diff; this is the sink it hands the diff to. So the Activity
     feed is now a LOG of the list the Following page is showing, rather than a
     second opinion about it derived from a second request on a second schedule.

     Called after every successful check, including the startup pass, which is
     what makes "diff on every check" true rather than aspirational — there is
     one place a follow can be refreshed and one place its result is recorded,
     and they are the same call. */

  /* -> the feed rows written, [] if the change was already known.

     `out` is 70-follows.js's refreshOne() answer:
       { row, cold, added: [work], changed: [{ work, from, to }], error }

     A COLD diff never reaches here — the refresher returns empty `added` and
     `changed` for a first sighting — so the 190-alert flood that follows
     following a prolific author is structurally impossible rather than guarded
     against twice. */
  async function recordFollowDiff(out) {
    const row = out && out.row;
    if (!row || !row.id || out.error) return [];
    const emitted = [];
    for (const w of (out.added || [])) {
      const e = await pushNewWork(row, w);
      if (e) emitted.push(e);
    }
    for (const c of (out.changed || [])) {
      const e = await pushDateChange(row, c);
      if (e) emitted.push(e);
    }
    return emitted;
  }

  /* A work id appeared in a catalogue that did not list it before.

     The wording is the whole point and it is deliberately not "new release".
     Open Library holds no forthcoming titles and no announcements; it
     catalogues books that exist. "Newly listed" is exactly what was observed
     and is never wrong when read literally, which "new from an author you
     follow" would be for every reprint, translation and backlist title a
     volunteer has only just typed in. */
  async function pushNewWork(row, w) {
    const year = yearOf(w);
    const id = alertId(`follow:${row.id}`, 'author.newWork', null, w.workId);
    if (await BT.repo.alertSeen(id)) return null;

    /* A work carrying a year from well before now is a backlist title somebody
       has just catalogued, not a release. Recorded honestly and archived on
       ingest rather than dropped, because "a 1978 novel of hers we did not know
       about" is a real thing a reader might want to find — just not at the top
       of a feed. */
    const thisYear = new Date().getFullYear();
    const backlist = year != null && year < thisYear - BACKLIST_YEARS;

    return BT.repo.pushFeedItem({
      alertId: id,
      /* The work's own uid, so the row opens in the inspector even though the
         book is not on the shelves — BT.inspector.show falls back to a
         read-only transient fetch and offers to add it. */
      uid: BT.normalize.uidOf('openlibrary', w.workId),
      kind: 'book',
      type: 'author.newWork',
      severity: backlist ? SEVERITY.low : SEVERITY.high,
      title: `${row.name}: ${w.title || 'Untitled work'}`,
      body: year
        ? `Newly listed in this catalogue — recorded ${year}`
        : 'Newly listed in this catalogue — no publication date recorded',
      from: null, to: w.workId,
      payload: { followId: row.id, followType: 'author', workOlid: w.workId,
                 coverId: w.coverId, year },
      archivedFlag: backlist ? 1 : 0,
      lastAt: Date.now(),
    });
  }

  /* A work we already held now carries a different year.

     THIS IS THE ROW THE OLD ARRANGEMENT COULD NOT PRODUCE, and it is worth
     being precise about why: the follow baseline was `knownWorkIds`, a bag of
     work OLIDs with no dates in it at all. There was nothing to compare a year
     against, so a catalogue correction — the commonest real change in an Open
     Library bibliography — was invisible by construction. The stored window in
     70-follows.js carries the years, so the comparison is now possible.

     THE BODY NEVER SAYS "MOVED TO". Open Library's dates are YEARS, and the two
     ends of this row are years: a volunteer re-catalogued the record, or a
     newer printing was added and max(publish_year) rose with it. Both are
     "the year we hold changed", and neither is a publisher announcing a date.
     Anything stronger would be this file lying on the catalogue's behalf. */
  async function pushDateChange(row, c) {
    const w = c.work || {};
    const id = alertId(`follow:${row.id}`, 'author.dateChanged',
                       String(c.from), String(c.to));
    if (await BT.repo.alertSeen(id)) return null;

    const thisYear = new Date().getFullYear();
    /* Judged on WHERE IT LANDS, not on how far it travelled. A record corrected
       from 1978 to 1979 is housekeeping; one that now reads next year is the
       reason somebody follows an author at all. */
    const ahead = c.to >= thisYear;
    return BT.repo.pushFeedItem({
      alertId: id,
      uid: BT.normalize.uidOf('openlibrary', w.workId),
      kind: 'book',
      type: 'author.dateChanged',
      severity: ahead ? SEVERITY.high : SEVERITY.low,
      title: `${row.name}: ${w.title || 'Untitled work'}`,
      body: `The publication year recorded for this work changed — ${c.from} → ${c.to}`,
      from: String(c.from), to: String(c.to),
      payload: { followId: row.id, followType: 'author', workOlid: w.workId,
                 coverId: w.coverId, year: c.to, fromYear: c.from },
      archivedFlag: ahead ? 0 : 1,
      lastAt: Date.now(),
    });
  }

  /* max(publish_year) where there is one — the newest printing anyone has
     catalogued, and the only field in a search doc that can ever be ahead of
     today. `firstYear` is the fallback rather than the preference: it is a
     computed minimum over every edition and is frequently decades early (The
     Alloy of Law, published 2011, reports 2001; verified). */
  const yearOf = w => (w && (w.latestYear || w.firstYear)) || null;

  /* Refresh ONE follow and record what changed.

     Kept as an export because the Activity screen, the console and any future
     per-author button all want "check this one now", and because it states in
     one line where the boundary is: 70-follows refreshes and diffs, this file
     records. It is a delegation, not a second implementation — there is no
     fetch, no baseline and no cooldown here to drift out of step.

     THREE ANSWERS, and callers must tell them apart:
       []      asked, nothing new
       [rows]  asked, here is what changed
       null    COULD NOT ASK

     The third used to be spelled `[]` as well, and that was a real bug: a
     follow check that failed on the network was counted as a healthy one, so a
     reader pressing "Check now" during an Open Library outage was told
     "Checked 3 · 0 updates" — the app stating that their followed authors have
     published nothing when it had not managed to look. */
  async function checkFollow(row) {
    const f = BT.follows;
    if (!row || !row.id || row.muted) return [];
    if (!f || typeof f.refreshOne !== 'function') return null;
    /* No `force` option: refreshOne is unconditional by construction. The
       cooldown belongs to the queue worker, and passing a flag that does
       nothing is how a reader of this line comes away believing there is a
       cached path through it. */
    const out = await f.refreshOne(row);
    if (!out || out.error) return null;
    /* refreshOne has ALREADY recorded the diff — it announces from inside
       itself, so that no route to a refresh can produce a cache update without
       the matching news. Calling recordFollowDiff again here would be harmless
       (alertSeen is content-addressed and would dedupe every row) but it would
       also be a second place that has to remember, which is how the two halves
       of this feature drifted apart in the first place. */
    return out.emitted || [];
  }

  /* ── The sweep ─────────────────────────────────────────────────────────
     Two halves that used to be one loop, and separating them is what makes the
     whole feature coherent:

       the LOCAL pass    zero requests. Diffs every stored item against its own
                         stored snapshot. Owned here, entirely.
       the FOLLOW pass   HANDED TO 70-follows.js. It owns the queue, the
                         cooldown, the cache and the diff; this file only
                         receives what changed, through recordFollowDiff.

     THE FOLLOW CAP IS GONE, AND ITS ABSENCE IS NOT A RELAXATION OF THE RATE
     LIMIT. Open Library grants roughly 3 req/s to clients that identify
     themselves with a contact User-Agent and roughly 1 to everyone else, and a
     browser is structurally incapable of setting a User-Agent — so BT.net's
     token bucket refills at 1/s for this source (SUSTAINED_RPS.openlibrary in
     05-net.js), and their terms ask that the API not be used for high-traffic
     backend work at all. That limiter caps the instantaneous RATE; VOLUME was
     this function's job, and it did it with `FOLLOWS_PER_SWEEP = {auto: 3}`.

     Three per four hours is what made the feature feel unpredictable. A reader
     with twelve authors had each of them checked about twice a day, so "what is
     coming up" was answered from a roster where two thirds of the rows were a
     day stale and nothing on screen said which. The refresher answers volume a
     better way: a PER-FOLLOW cooldown, so a pass over a roster refreshed an
     hour ago costs zero requests rather than three; one at a time, never fanned
     out; and yielding to interactive work so a walk cannot make the search box
     feel dead. Total requests per day go DOWN, and every follow is current.

     ── SEAM ────────────────────────────────────────────────────────────────
     The cooldown key is `alerts.lastSweepAt`, NOT `sync.lastSweepAt`. That
     second key belongs to 48-sync.js's item-refresh sweeper, which is a
     different job on a different budget; two writers on one key means whichever
     ran last erases the other's meaning, and the first symptom is a cooldown
     that silently never expires.

     Note the follow half is NOT behind that cooldown any more, and must not be.
     `alerts.lastSweepAt` gates the ITEM pass, which is a full library scan; the
     follows have their own per-row clock, and gating them on a shared one as
     well was half of why a newly-followed author sat empty for four hours. */
  async function sweep(opts) {
    opts = opts || {};
    if (sweeping) return { skipped: 'already-running', checked: 0, alerts: 0 };

    const last = (await BT.repo.metaGet('alerts.lastSweepAt')) || 0;
    const localDue = opts.manual || (Date.now() - last >= BT.SWEEP.cooldownMs);

    sweeping = true;
    cancelled = false;
    const report = { checked: 0, alerts: 0, errors: 0, follows: 0, started: Date.now() };

    try {
      /* The local pass first: zero requests, so it still reports something
         useful when the network is down or Open Library is having a bad day.
         A manual check re-reads everything, because the user pressed a button
         and is entitled to a complete answer; an automatic one only visits what
         has been written since it last looked. */
      if (localDue) {
        const local = await scanStored({ since: opts.manual ? 0 : last });
        report.alerts += local.emitted.length;
        report.checked += local.checked;
        await BT.repo.metaSet('alerts.lastSweepAt', Date.now());
      } else {
        report.skipped = 'cooldown';
        report.nextAt = last + BT.SWEEP.cooldownMs;
      }

      const f = BT.follows;
      if (f && typeof f.refreshAll === 'function' && !cancelled) {
        /* `force` on a manual check only. An automatic pass leans on the
           per-follow cooldown, so opening the app twice in an hour costs
           nothing; a reader who pressed a button is entitled to a real answer
           from every author on the roster.

           The alerts this produces are counted by the refresher's own sink, not
           here — recordFollowDiff writes them as each follow lands, so a tab
           closed halfway through has already persisted what it learned. */
        const before = await unreadishCount();
        const res = await f.refreshAll({ force: !!opts.manual, reason: opts.manual ? 'manual' : 'startup' });
        report.follows = res.ok || 0;
        report.checked += res.checked || 0;
        report.errors += res.failed || 0;
        report.alerts += Math.max(0, (await unreadishCount()) - before);
      }

      report.finished = Date.now();
      BT.repo.emit('alerts:sweep', report);
      return report;
    } finally {
      sweeping = false;
      cancelled = false;
    }
  }

  /* How many feed rows exist right now, read either side of the follow pass so
     the report can say how many it produced.

     Counted rather than returned, because the rows are written by the
     refresher's sink one follow at a time — which is the durability property
     worth keeping: a tab closed mid-walk has persisted every diff it saw, and
     the price is that the count has to be observed instead of accumulated. */
  async function unreadishCount() {
    try { return (await BT.repo.feedItems({ includeArchived: true })).length; }
    catch (_) { return 0; }
  }

  function cancel() {
    cancelled = true;
    /* The follow half is not ours to stop from in here any more. Cancelling the
       item pass while the refresher carried on would leave "Check now" looking
       like it had stopped while requests were still going out. */
    if (BT.follows && typeof BT.follows.cancelRefresh === 'function') BT.follows.cancelRefresh();
  }
  const isSweeping = () =>
    sweeping || !!(BT.follows && BT.follows.isRefreshing && BT.follows.isRefreshing());

  return {
    snapshotOf, diff, commit, alertId,
    checkItem, scanStored, checkFollow,
    /* The sink 70-follows.js hands its diff to. This is the whole of the follow
       half of this module now — see the header. */
    recordFollowDiff,
    sweep, cancel, isSweeping,
    SEVERITY,
    /* EXPORTED SO THERE IS ONE CONTAINMENT RULE, not two — the same argument
       38-normalize.js makes for exporting its precision ladder.

       48-sync.js records date DRIFT on the item (`release.history`, which is
       what BT.ui.driftBadge and the inspector's "Date history" block draw). It
       has to answer the identical question this file answers above: did the
       date move, or did we merely learn a finer version of the date we already
       had? A year-precision key anchors to January 1, so the moment a hydrate
       turns "1991" into "September 1991" the sort key jumps 243 days without
       anything about the book changing. A private copy of this test in the
       sweeper would be free to drift out of step with the one the feed uses,
       and then the badge and the activity row would disagree about the same
       event — with the badge, being wordless, having no way to explain itself. */
    withinWindow,
  };
})();
