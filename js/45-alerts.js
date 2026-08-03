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

  /* How many follows one sweep may poll. Small on purpose — see the note on
     the Open Library rate limit above `sweep`. */
  const FOLLOWS_PER_SWEEP = { auto: 3, manual: 8 };

  /* A ceiling on the zero-network item pass, so a pathological library cannot
     make "Check now" feel like a hang. The `since` filter does the real work;
     this is only a backstop. */
  const ITEM_SCAN_CAP = 800;

  /* The known-works baseline is unioned rather than replaced (see checkFollow),
     so it only grows. Set far above any real bibliography — the most prolific
     author in Open Library does not reach four figures of works, and EVICTION
     IS THE FAILURE MODE this number exists to avoid: an id dropped from the
     baseline re-alerts as new the next time it appears. */
  const KNOWN_WORK_CAP = 2000;

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

  /* ── Follows ───────────────────────────────────────────────────────────
     Polling a followed AUTHOR rather than each tracked book is the only way a
     book that is not in the library yet can ever be discovered: one query
     covers a whole bibliography, and there is no other endpoint that answers
     "what is new from this person" at all.

     The bibliography itself is fetched by BT.follows.worksOf, which owns the
     source-specific part: authors are keyed on OLID via /search/authors.json
     because `search.json?author=gwendolyn+kiste` verifiably returns Laird
     Barron's books, and publishers have no id at all and match on a name token.
     This module only diffs what it is handed. */
  async function worksOf(row) {
    const f = BT.follows;
    if (!f || typeof f.worksOf !== 'function') {
      /* Same seam discipline as BT.ui's guard around this module: a missing
         neighbour means "nothing to check", never a thrown sweep. */
      return null;
    }
    const res = await f.worksOf(row, { fresh: true });
    if (Array.isArray(res)) return res;

    /* `works` FIRST, because that is what 70-follows.js actually returns:
       `{ works, numFound, approximate, source }`. This adapter originally knew
       only about `docs` — which is BT.openlibrary.authorWorks's shape, one
       layer further down — and the mismatch was completely silent.

       Silent, and total. Every call landed on the `return null` below,
       checkFollow read that as "we could not ask", returned [] without
       emitting, without writing a baseline and without stamping
       lastCheckedAt — and the sweep reported `follows: 1, alerts: 0,
       errors: 0`, which is indistinguishable from a healthy sweep of an author
       who has published nothing. The whole follow half of this module was dead
       and every diagnostic in the app said it was fine.

       The second-order damage was worse than the missing alerts: sweep() and
       due() both rotate the roster by `lastCheckedAt`, so a field that is never
       written means the sort is over a column of zeroes. The same three follows
       would have been re-polled on every sweep for ever while the fourth was
       never reached once.

       `docs` is kept below it, unchanged, for exactly the reason it was written
       — a thinner wrapper may hand the catalogue response straight through.
       Two accepted shapes is cheap; guessing at one is what cost this. */
    if (res && Array.isArray(res.works)) return res.works;
    if (res && Array.isArray(res.docs)) return res.docs;
    return null;
  }

  /* Accepts a raw Open Library search doc or an already-normalised row, because
     the shape crossing this seam is not this file's to fix. `key` arrives as
     '/works/OL27482W' from search.json and bare from /search/authors.json;
     BT.util.olid handles both, and every id in `knownWorkIds` is run through it
     on the way in too, so a baseline written in one shape still matches. */
  function workRef(w) {
    if (!w || typeof w !== 'object') return { id: '', title: '', year: null, coverId: null };
    const id = BT.util.olid(w.olid || w.workOlid || w.id || w.key || w.work_key || '');

    /* A row from BT.follows.worksOf is a NORMALISED row with the raw search doc
       parked underneath it as `doc` — so the snake_case fields this function was
       written against are one level down, not absent. Reading only the top level
       left `year` null on every followed work, and a null year is not a harmless
       gap here: `backlist` is computed from it, so every reprint and translation
       that turned up in an author's catalogue would have been filed at
       SEVERITY.high and announced at the top of the feed as though it were a new
       novel. That is precisely the dishonesty this feature is supposed to avoid.

       Falls back to `w` itself so a bare search doc still works unchanged. */
    const d = (w.doc && typeof w.doc === 'object') ? w.doc : w;

    /* `firstYear` is 70-follows' spelling of first_publish_year, and it means
       the same thing — the earliest recorded publication, not the latest. Its
       sibling `latestYear` is deliberately NOT consulted: a 2025 reprint of a
       2022 novel must not read as a 2025 book. */
    let year = w.year != null ? w.year
      : (w.firstYear != null ? w.firstYear : d.first_publish_year);
    if (year == null && Array.isArray(d.publish_year) && d.publish_year.length) {
      /* The MINIMUM, matching what first_publish_year means. Taking the max
         would read a 2019 reprint as the publication of a 1965 novel. */
      const ys = d.publish_year.map(Number).filter(Number.isFinite);
      if (ys.length) year = Math.min.apply(null, ys);
    }
    year = Number.isFinite(Number(year)) ? Number(year) : null;

    const coverId = w.coverId != null ? w.coverId
      : (d.cover_i != null ? d.cover_i : null);

    return { id, title: w.title || w.name || d.title || '', year, coverId };
  }

  async function checkFollow(row) {
    if (!row || !row.id || row.muted) return [];

    let works;
    try {
      works = await worksOf(row);
    } catch (e) {
      console.warn('[alerts] follow check failed', row.name, e && e.message);
      return [];
    }
    /* null means we could not ask. The baseline and lastCheckedAt are left
       exactly as they were, so the follow stays at the head of the queue and is
       retried next sweep rather than being silently marked as checked. */
    if (!works) return [];

    const known = new Set();
    for (const k of (row.knownWorkIds || [])) {
      const n = BT.util.olid(k);
      if (n) known.add(n);
    }
    const cold = known.size === 0;
    const type = row.type === 'publisher' ? 'publisher.newWork' : 'author.newWork';
    const approx = row.type === 'publisher';
    const thisYear = new Date().getFullYear();
    const seenNow = [];
    const out = [];

    for (const w of works) {
      const ref = workRef(w);
      if (!ref.id) continue;
      seenNow.push(ref.id);

      /* First sight of this follow is a baseline and emits NOTHING. Following
         a prolific author would otherwise post her entire catalogue at once. */
      if (cold || known.has(ref.id)) continue;

      const id = alertId(`follow:${row.id}`, type, null, ref.id);
      if (await BT.repo.alertSeen(id)) continue;

      /* A work that turns up carrying a publication year from well before now
         is a backlist title somebody has just catalogued, not a release. It is
         recorded honestly and archived on ingest rather than dropped, because
         "a 1978 novel of hers we did not know about" is a real thing a reader
         might want to find — just not at the top of a feed. */
      const backlist = ref.year != null && ref.year < thisYear - BACKLIST_YEARS;

      out.push(await BT.repo.pushFeedItem({
        alertId: id,
        /* The work's own uid, so the row opens in the inspector even though the
           book is not on the shelves — BT.inspector.show falls back to a
           read-only transient fetch and offers to add it. */
        uid: BT.normalize.uidOf('openlibrary', ref.id),
        kind: 'book',
        type,
        /* A publisher match is a name token, not an identity, so it never gets
           the loud severity an author match does. */
        severity: approx ? SEVERITY.normal
          : (backlist ? SEVERITY.low : SEVERITY.high),
        title: `${row.name}: ${ref.title || 'Untitled work'}`,
        body: newWorkBody(ref, approx),
        from: null, to: ref.id,
        payload: {
          followId: row.id, followType: row.type || 'author',
          workOlid: ref.id, coverId: ref.coverId, year: ref.year,
          approximate: approx ? 1 : 0,
        },
        archivedFlag: backlist ? 1 : 0,
        lastAt: Date.now(),
      }));
    }

    /* UNION, NOT REPLACE — and this is the one place BookTrak had to diverge
       from MovieTrak's checkFollow.

       MovieTrak overwrote knownWorkIds with whatever the poll returned, which
       was safe because TMDB's combined_credits is a COMPLETE list. Open Library
       has no such endpoint: the bibliography is `search.json?author={OLID}
       &sort=new&limit=60`, a WINDOW over a result set whose ordering moves
       every time a volunteer edits a publication year. Replacing the baseline
       with that window means a work that slides out of the top 60 is forgotten,
       and the day it slides back in it is announced as new. Union also makes an
       empty or partial response harmless: a poll that returns nothing cannot
       shrink what we know. */
    for (const id of seenNow) known.add(id);
    row.knownWorkIds = Array.from(known).slice(-KNOWN_WORK_CAP);
    row.lastCheckedAt = Date.now();
    await BT.repo.putFollow(row);
    return out;
  }

  function newWorkBody(ref, approx) {
    const bits = [ref.year
      ? `Newly listed in this catalogue — first recorded ${ref.year}`
      : 'Newly listed in this catalogue — no publication date recorded'];
    /* Said on the row itself, not only in the sidebar, because a publisher row
       is the one that will be wrong often enough to matter. `publisher=tor`
       collapses Tor, Tor.com, Tor Science Fiction and "A Tom Doherty Associates
       Book" into one bucket, and there is no id to disambiguate them with. */
    if (approx) bits.push('publisher matching is by name, so this may be a different imprint');
    return bits.join(' · ');
  }

  /* ── The sweep ─────────────────────────────────────────────────────────
     Serialized, cooldown-gated, and deliberately small.

     THE RATE LIMIT IS NOT A GUESS. Open Library grants roughly 3 req/s to
     clients that identify themselves with a contact User-Agent and roughly 1
     to everyone else, and a browser is structurally incapable of setting a
     User-Agent — so BT.net's token bucket refills at 1/s for this source
     (SUSTAINED_RPS.openlibrary in 05-net.js). Their terms also ask that the
     API not be used for high-traffic backend work at all.

     That limiter caps the instantaneous RATE. It does nothing about total
     VOLUME, which is what this function is responsible for: follows are polled
     in a serialized loop, never fanned out with Promise.all, and only a handful
     per run. Twenty follows checked in one burst would be twenty seconds of
     queued requests and a visibly stuck app even before it became rude; three
     per sweep on a four-hour cooldown walks the whole list within a day of
     normal use and is invisible.

     ── SEAM ────────────────────────────────────────────────────────────────
     The cooldown key is `alerts.lastSweepAt`, NOT `sync.lastSweepAt`. That
     second key belongs to 48-sync.js's item-refresh sweeper, which is a
     different job on a different budget; two writers on one key means whichever
     ran last erases the other's meaning, and the first symptom is a cooldown
     that silently never expires. */
  async function sweep(opts) {
    opts = opts || {};
    if (sweeping) return { skipped: 'already-running', checked: 0, alerts: 0 };

    const last = (await BT.repo.metaGet('alerts.lastSweepAt')) || 0;
    if (!opts.manual && Date.now() - last < BT.SWEEP.cooldownMs) {
      return { skipped: 'cooldown', nextAt: last + BT.SWEEP.cooldownMs, checked: 0, alerts: 0 };
    }

    sweeping = true;
    cancelled = false;
    const report = { checked: 0, alerts: 0, errors: 0, follows: 0, started: Date.now() };

    try {
      /* The local pass first: zero requests, so it still reports something
         useful when the network is down or Open Library is having a bad day.
         A manual check re-reads everything, because the user pressed a button
         and is entitled to a complete answer; an automatic one only visits what
         has been written since it last looked. */
      const local = await scanStored({ since: opts.manual ? 0 : last });
      report.alerts += local.emitted.length;
      report.checked += local.checked;

      const follows = (await BT.repo.allFollows())
        .filter(f => f && !f.muted)
        /* Round-robin by staleness, so one roster of authors cannot starve the
           rest and every follow is reached eventually. */
        .sort((x, y) => (x.lastCheckedAt || 0) - (y.lastCheckedAt || 0))
        .slice(0, opts.manual ? FOLLOWS_PER_SWEEP.manual : FOLLOWS_PER_SWEEP.auto);

      for (const f of follows) {
        if (cancelled) break;
        try {
          report.alerts += (await checkFollow(f)).length;
          report.follows++;
          report.checked++;
        } catch (e) {
          report.errors++;
          console.warn('[alerts] follow sweep error', f && f.name, e && e.message);
        }
      }

      await BT.repo.metaSet('alerts.lastSweepAt', Date.now());
      report.finished = Date.now();
      BT.repo.emit('alerts:sweep', report);
      return report;
    } finally {
      sweeping = false;
      cancelled = false;
    }
  }

  function cancel() { cancelled = true; }
  const isSweeping = () => sweeping;

  return {
    snapshotOf, diff, commit, alertId,
    checkItem, scanStored, checkFollow,
    sweep, cancel, isSweeping,
    SEVERITY,
  };
})();
