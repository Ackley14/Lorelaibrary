/* ══════════════════════════════════════════════════════════════════════════
   Following authors — the id scheme, the CACHED CATALOGUE, and the one
   serialized refresher that maintains it.

   This file touches no DOM. 67-view-people.js draws what is stored here,
   61-view-search.js and 56-inspector.js offer the Follow button, 45-alerts.js
   turns the diff this file computes into feed rows.

   ── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING ─────────────────
   THE FOLLOW ROW IS THE CACHE. `row.works` is one page of the author's
   catalogue exactly as Open Library last handed it over, and it is the ONLY
   copy of that answer the app keeps. The Following page renders from it with
   zero requests, the diff is computed against it, and the alerts feed is a log
   of how it changed.

   That is a deliberate replacement of an arrangement that was reported as
   "behaves strangely", and the reason is worth stating because the old shape
   looked perfectly reasonable:

     · The Following page fetched a catalogue to draw its strip.
     · The alerts sweep fetched the SAME catalogue to diff against
       `knownWorkIds`.
     · Neither wrote what it saw anywhere the other could see it.

   So there were two schedules, two ideas of "what I last saw", and the only
   durable store was BT.net's URL-keyed HTTP cache — which is excluded from
   SYNC_STORES (12-repo.js), hard-expires, and is wiped by "Clear cache". The
   visible symptom was a roster that said "never checked · not checked yet"
   underneath a screen that was at that moment displaying the author's
   catalogue. The user read their own roster and it told them nothing was
   cached, which was true.

   Now there is one store, one writer, and one schedule. `refreshAll()` below
   is that writer, and NOTHING else may write `works`, `worksAt`,
   `knownWorkIds` or `news`.

   ── FOUR RULES, each measured, each fails quietly ─────────────────────────

   1. AN AUTHOR FOLLOW IS AN OLID. NEVER A NAME.

      Not a preference for stable identifiers — a bug report. Verified live:

          search.json?author=gwendolyn+kiste   →   Occultation
                                                   Swift to Chase
                                                   The Beautiful Thing That
                                                     Awaits Us All

      Those are LAIRD BARRON'S books. HTTP 200, a confident bibliography, for
      the wrong writer. `author=` with a name is fuzzy matching over a name
      index and nothing in the response says so.

      So `toggleAuthor` REFUSES a follow it has no OLID for and returns null
      rather than inventing one from the name. `/search/authors.json?q=` is
      where an OLID comes from, and it is the ONE endpoint in the API that
      returns a BARE id ('OL1394865A') instead of a path. BT.util.olid() eats
      both; nothing here slices a key by hand.

   2. PUBLISHER FOLLOWING IS GONE, and this is where it was.

      Open Library has no publisher records, no publisher ids and no publisher
      index, so a publisher follow was a hand-rolled slug over free text that
      collapsed Tor, Tor.com and Tor Science Fiction into one bucket while
      missing "Tom Doherty Associates" entirely. It was honest about being
      approximate and it was still the wrong feature: the user's words were
      "lets drop publisher support as i think it's a bit too shoehorned in".

      PUBLISHER SURVIVES AS A FACET, and it is worth naming the surfaces
      exactly, because the vaguer version of this note ("the list view filters
      on it and Stats counts it") was WRONG — neither file mentions publishers
      at all — and it was the stated justification for keeping the index. A
      reader who checked it, found nothing, and concluded the index was dead
      would delete the two lines below and take the edition picker's filter with
      them. What actually reads a publisher today:

        12-repo.js    writes `idx.publisherKeys` on every put
        10-db.js      keeps the `by_publisher` multiEntry index over it
        59-editions.js filters the edition picker across publisher, year and
                      ISBN — its box is labelled "Publisher, year or ISBN…"
        56-inspector.js shows Publisher on the Edition block

      The stored index has no reader yet; it is the queryable half of the facet
      and is kept deliberately, so a publisher filter on the list view is a
      query away rather than a migration away. What is gone is only the ability
      to FOLLOW one.

      `retirePublisherFollows()` at the bottom of this file removes the rows,
      and it copies them into `meta` first rather than deleting outright — see
      the note there. `all()` also filters them defensively, so a row that has
      not been retired yet (a sync arriving from a device still on the old
      build) can never reach a screen.

   3. THE FIRST SIGHTING OF A FOLLOW EMITS NOTHING.

      Following an author with 190 works must store 190 ids and say nothing.
      Without that rule the act of following someone IS a flood of 190 "new
      release" alerts, and the feature is dead on the day it ships because the
      first thing every user does is follow five people at once. `cold` below
      is that rule expressed as data instead of left to each caller.

   4. THE BASELINE IS UNIONED, THE WINDOW IS REPLACED, AND THEY ARE DIFFERENT
      THINGS.

      `search.json?author={OLID}&sort=new&limit=60` is a WINDOW over a result
      set whose ordering moves whenever a volunteer edits a publication year.

        row.works        the window. REPLACED every refresh. It is what the
                         page draws and what a date diff compares against.
        row.knownWorkIds the union of every work id ever seen. ONLY GROWS.
                         It answers "have we ever seen this work?", so a title
                         that slides out of the top 60 and back in again is
                         not announced twice.

      Collapsing those two into one list breaks in whichever direction you
      collapse it: replace-only re-announces old books, union-only can never
      notice that a date changed.

   ── Rate limit ────────────────────────────────────────────────────────────
   Open Library sustains about one request a second and asks not to be used as
   a backend for automated traffic. EVERY path here is ONE request per follow,
   and refreshAll() is a single serialized worker — there is no second queue
   and no Promise.all anywhere in this file. See the comment above pump().
   ══════════════════════════════════════════════════════════════════════════ */

BT.follows = (function () {

  /* 'openlibrary' is a real catalogue identity, stored on the row so an export
     can never present a guess and a fact as equals. It is the only source now
     that publisher slugs are gone. */
  const AUTHOR_SOURCE = 'openlibrary';

  /* How long a stored catalogue is treated as current.

     BT.SWEEP.cooldownMs is REUSED rather than a fresh number invented, because
     it is already this app's answer to "how often is it worth re-asking what is
     in a follow's catalogue?". One number, one meaning, and no way for the
     background schedule and this one to drift apart.

     An explicit refresh — the buttons on #/people, "Check now" on Activity —
     passes `force` and ignores this entirely. It is a floor on AUTOMATIC work
     only, which is what stops a reader who opens the Following page four times
     in an afternoon paying four times for the same answer. */
  const WORKS_TTL = (BT.SWEEP && BT.SWEEP.cooldownMs) || 4 * 3600e3;

  /* One page. This is not a display cap — it is the size of the answer Open
     Library gives us (BT.LIMITS.authorWorks), stated here so the stored row can
     never grow past what one request returns. The whole page is kept: the
     Following page shows everything that passes its bands, and truncating the
     STORE to make a screen shorter is how "showing 12 of 60, silently" comes
     back. */
  const WORKS_CAP = BT.LIMITS.authorWorks;

  /* Ceiling on the union baseline. The most prolific author in Open Library
     does not reach four figures of works, so this is unreachable in normal use
     — it exists so a decade of imported exports cannot grow a row without
     bound. EVICTION IS THE FAILURE MODE it avoids: an id dropped here re-reads
     as new the next time it appears. 16-cloud.js reads this constant when it
     merges two devices' baselines, so there is one owner of the number. */
  const KNOWN_CAP = 4000;

  /* How many news entries one follow keeps. This is the per-author feed the
     Following page shows and the sidebar badge counts, so it is a reading
     length rather than a storage bound: forty is far more than anyone scrolls
     and small enough that the row stays cheap to sync. Oldest fall off. */
  const NEWS_CAP = 40;

  /* Longest the refresher will wait for an interactive lookup to finish before
     carrying on regardless. A hold that leaks — a search that threw between
     hold() and release() — must cost seconds, never the whole refresh. */
  const HOLD_MAX_MS = 20000;

  /* ══ IDS ════════════════════════════════════════════════════════════════
     `author:openlibrary:OL1394865A`. The shape is `{type}:{source}:{sourceId}`,
     matching the uid scheme in 38-normalize.js, so a row is legible in a
     database viewer and an export needs no lookup table to be understood.

     Returns '' rather than a partial id when there is nothing usable, so every
     caller branches on the id and never on the input. */
  function authorId(olid) {
    const id = BT.util.olid(olid);
    return id ? `author:${AUTHOR_SOURCE}:${id}` : '';
  }

  /* ══ PERSISTENCE ════════════════════════════════════════════════════════
     Everything goes through BT.repo, which owns the store and emits
     'follow:change' — that event is what re-counts the Following row in the
     index tree, so nothing here calls BT.db and nothing here repaints. */

  /* Publisher rows are filtered on the way OUT as well as being retired on
     disk. A device still running the old build can sync one in at any moment,
     and a row whose `worksOf` branch no longer exists would render as an author
     with a permanently empty catalogue — a follow that looks broken rather than
     one that was removed. */
  const isAuthorRow = f => !!(f && f.type === 'author');

  async function all() {
    return (await BT.repo.allFollows()).filter(isAuthorRow);
  }
  async function get(id) {
    if (!id) return null;
    const row = await BT.repo.getFollow(id);
    return isAuthorRow(row) ? row : null;
  }
  async function isFollowing(id) {
    return !!(await get(id));
  }

  /* Fill a caller's partial row out to the stored shape. Returns null for
     anything that cannot be identified, because a follow with no id is a row
     that can never be unfollowed. */
  function normalizeRow(row) {
    if (!row) return null;
    /* Authors only, now and deliberately. A caller still passing
       `type: 'publisher'` is running against a build that no longer has that
       feature, and inventing an author row from a publisher name would follow
       a person who does not exist. */
    if (row.type && row.type !== 'author') return null;

    const sourceId = BT.util.olid(row.sourceId || row.id || '');
    const id = authorId(sourceId);
    if (!id || !sourceId) return null;

    const name = String(row.name == null ? '' : row.name).trim() || sourceId;
    const now = Date.now();
    return {
      id,
      type: 'author',
      source: AUTHOR_SOURCE,
      sourceId,
      name,
      /* A NEW follow starts EMPTY on purpose — see rule 3. Pre-filling this
         from a work list the caller happens to be holding would be the same
         mistake in a nicer wrapper: it would also mean the first genuinely new
         book is never reported, because it arrived already known. */
      works: [],
      worksAt: 0,
      numFound: 0,
      knownWorkIds: [],
      lastCheckedAt: 0,
      lastTriedAt: 0,
      lastError: '',
      news: [],
      /* Stamped NOW rather than left at 0. The badge counts news later than
         this mark, and a follow added this second has no history the reader has
         missed — starting at 0 would light the sidebar for a roster the reader
         has never had a chance to look at. */
      newsSeenAt: now,
      addedAt: now,
      muted: 0,
    };
  }

  /* Idempotent. Following someone you already follow is a no-op on everything
     except the display name.

     RE-FOLLOWING MUST NOT RESET THE CACHE OR THE BASELINE. The Follow button
     appears in four places (search rows, the detail pane, the roster, the
     picker), so pressing it twice is ordinary rather than exotic. If the second
     press overwrote the row, `works` and `knownWorkIds` would both go back to
     empty — the follow would look identical, and the next refresh would
     re-baseline instead of reporting the new book it was about to find. A
     silent, permanent loss of exactly the event the feature exists for. */
  async function follow(row) {
    const next = normalizeRow(row);
    if (!next) return null;

    const existing = await BT.repo.getFollow(next.id);
    if (existing) {
      /* A better name is worth taking — search rows carry the display name and
         a bare id does not. Nothing else on the stored row is touched. */
      if (next.name && next.name !== next.sourceId && next.name !== existing.name) {
        existing.name = next.name;
        await BT.repo.putFollow(existing);
      }
      return existing;
    }
    await BT.repo.putFollow(next);
    return next;
  }

  /* Unfollowing drops the cache and the baseline with the row, which is
     correct: re-following later is a first sighting again, and a first sighting
     emits nothing. Keeping the ids around would mean re-following an author you
     had dropped for a year told you about nothing that happened in it. */
  async function unfollow(id) {
    if (!id) return false;
    const had = await BT.repo.getFollow(id);
    if (!had) return false;
    await BT.repo.deleteFollow(id);
    return true;
  }

  /* -> { id, type, name, following } , or null when there is nothing to key on.

     NULL IS AN ANSWER THE CALLER MUST HANDLE. It means "this record has no
     OLID" — see rule 1 — and the right response is to say so, not to fall back
     to the name. */
  async function toggleAuthor(olid, name) {
    const id = authorId(olid);
    if (!id) return null;
    const existing = await BT.repo.getFollow(id);
    if (existing) {
      await unfollow(id);
      return { id, type: 'author', name: existing.name || String(name || ''), following: false };
    }
    const row = await follow({
      type: 'author', sourceId: BT.util.olid(olid), name: String(name || '').trim(),
    });
    if (!row) return null;
    return { id, type: 'author', name: row.name, following: true };
  }

  /* ══ ASKING OPEN LIBRARY ════════════════════════════════════════════════
     -> { works: [shapeWork], numFound }

     ONE request. This is the only function in the file that reaches the
     network, and only refreshOne() calls it.

     Errors travel. A follow that could not be checked because Open Library is
     down must NOT come back as an empty catalogue: the diff would compare an
     empty list against the stored window, find nothing, and stamp the follow as
     checked — so a four-hour outage would silently eat every book published
     during it. "We could not look" and "there is nothing new" are different
     facts and this function refuses to collapse them.

     Authors go through the adapter, which already sends the right query and
     documents why: `search.json?author={OLID}&sort=new`, NOT
     `/authors/{id}/works.json`. The dedicated endpoint carries no publication
     years at all and is ordered by record edit time, so "new from your authors"
     built on it is permanently empty while appearing to work. */
  async function worksOf(followRow, opts) {
    opts = opts || {};
    const row = followRow || {};
    if (!isAuthorRow(row)) return { works: [], numFound: 0 };

    if (!BT.openlibrary || typeof BT.openlibrary.authorWorks !== 'function') {
      /* Thrown rather than returned empty, for the reason above: a missing
         module is a failure to look, not a catalogue with nothing in it. */
      throw new Error('The Open Library client (20-openlibrary.js) is not loaded.');
    }

    const olid = BT.util.olid(row.sourceId || row.id || '');
    if (!olid) return { works: [], numFound: 0 };

    const res = await BT.openlibrary.authorWorks(olid, {
      limit: opts.limit || WORKS_CAP,
      offset: opts.offset || 0,
      signal: opts.signal,
      /* ALWAYS fresh, and that is the whole point of the rewrite. The follow
         row is the cache now, so a second cache in front of it could only ever
         answer the question "what did the last refresh see?" — which is already
         sitting in `row.works`, in a store that syncs and survives a cache
         clear. Asking BT.net to remember it as well would put two answers of
         different ages behind one screen again. */
      fresh: true,
      meta: opts.meta,
    });
    return {
      works: shapeWorks(res && res.docs),
      numFound: (res && res.numFound) || 0,
    };
  }

  function shapeWorks(docs) {
    const out = [];
    const seen = new Set();
    for (const d of (Array.isArray(docs) ? docs : [])) {
      const w = shapeWork(d);
      /* Deduped here rather than downstream: Open Library occasionally returns
         the same work twice in one page after a merge, and a duplicate would
         diff against itself and read as a date change. */
      if (!w || seen.has(w.workId)) continue;
      seen.add(w.workId);
      out.push(w);
    }
    return out.slice(0, WORKS_CAP);
  }

  /* One search doc, reduced to what a diff, a card and IndexedDB all need.

     `workId` is the identity for the whole feature — it is what goes into
     knownWorkIds and what "a work appeared that was not here last time" is
     computed over — so a doc without one is dropped rather than carried with a
     synthesised key. A work id is stable across re-cataloguing; a title is not.

     `firstYear` and `latestYear` are kept SEPARATE and neither is called a
     publication date. first_publish_year is a computed minimum over the work's
     editions and is frequently wrong — The Alloy of Law, published 2011,
     reports 2001 (verified) — while max(publish_year) is the most recent
     printing anyone has catalogued, which is the closer thing to "this turned
     up recently". Open Library has no street dates and no forthcoming titles at
     all, and its dates are YEARS. Anything upstream of here that renders one of
     these as a release date is lying on this file's behalf.

     THE RAW DOC IS DELIBERATELY NOT KEPT. It used to ride along so a caller
     could hand it to BT.normalize.stubFromSearchDoc without a second request,
     and that was free while this shape lived only in memory. It does not live
     only in memory any more: this object is written to the `follows` store,
     which travels in SYNC_STORES and through the encrypted cloud payload, so a
     roster of forty would have shipped forty pages of raw search JSON to every
     device on every publish. Five scalars is about ninety bytes; the doc is
     several hundred and holds nothing this feature reads. */
  function shapeWork(doc) {
    const workId = BT.util.olid(doc && doc.key);
    if (!workId) return null;
    const years = (Array.isArray(doc.publish_year) ? doc.publish_year : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0);
    const first = Number(doc.first_publish_year);
    const cover = Number(doc.cover_i);
    return {
      workId,
      title: String(doc.title || '').trim() || workId,
      firstYear: Number.isFinite(first) && first > 0 ? first : null,
      latestYear: years.length ? Math.max.apply(null, years) : null,
      coverId: Number.isFinite(cover) && cover > 0 ? cover : null,
    };
  }

  /* The stored list, defended. Rows arrive here from IndexedDB and from another
     device's export, so nothing about their shape is guaranteed — and this is
     read on the render path of every section on #/people, where one malformed
     row must cost one card rather than the page. */
  function cachedWorks(row) {
    const out = [];
    for (const w of ((row && row.works) || [])) {
      if (!w || !w.workId) continue;
      out.push({
        workId: w.workId,
        title: w.title || w.workId,
        firstYear: Number.isFinite(w.firstYear) ? w.firstYear : null,
        latestYear: Number.isFinite(w.latestYear) ? w.latestYear : null,
        coverId: Number.isFinite(w.coverId) ? w.coverId : null,
      });
    }
    return out;
  }

  /* The year this work's most recent printing carries, which is the only field
     in a search doc that can ever be ahead of today. See releaseOfWork. */
  const yearOf = w => (w && (w.latestYear || w.firstYear)) || null;

  /* ══ IS THIS WORK STILL AHEAD OF US? ════════════════════════════════════
     A DATE FROM OPEN LIBRARY IS A YEAR. That is the shape of the data, not a
     gap to be papered over, and it is verified: search.json returns
     `first_publish_year` and a `publish_year` array, both plain integers, and
     an edition's `publish_date` is free text that is almost always a bare year.
     So most releases occupy a WINDOW rather than a point, and the honest test
     is about the two ends of that window:

         a bare '2026'  │ Jan 1 ─────────────────────────── Dec 31
         today          │              ▲
         verdict        │ it could be behind us or ahead of us, and the record
                        │ genuinely does not say which

     · window ENDS before today   -> 'past'    certainly behind us
     · window STARTS after today  -> 'future'  certainly ahead of us
     · anything in between        -> 'maybe'   the window straddles today, which
                                               for a bare year means the CURRENT
                                               year and no other

     'maybe' IS SHOWN AND LABELLED, NEVER SILENTLY KEPT OR SILENTLY DROPPED.
     Dropping it would empty the screen outright — measured against the live
     API, a 60-work page for each of six large-catalogue authors contained ZERO
     works dated beyond the current year and between zero and six dated within
     it. Keeping it unlabelled would be worse: it would say "coming up" about a
     book that came out in March. So the view renders the year with the month
     and day HATCHED — the app's grammar for "this value cannot exist in the
     record" — and puts it in a band of its own with the reason written out.
     Where a Google Books key is configured, sharpenYear() below turns a good
     share of these into real days and the maybe resolves. */

  /* The LAST day a release could actually fall on.
     Its FIRST day is already the sort key — 01-util.js anchors vaguer
     precisions to the start of their window on purpose, so a bare 2027 sorts as
     2027-01-01 — and holding both ends is what makes the three-way verdict
     above possible instead of a coin flip. */
  function windowEnd(release) {
    const sk = release && release.sortKey;
    if (!Number.isFinite(sk) || sk >= BT.util.SK_UNKNOWN) return null;
    const p = BT.util.sortKeyToParts(sk);
    if (!p) return null;
    switch (release.precision) {
      case 'day':     return sk;
      case 'month':   return BT.util.endOfMonthSortKey(p.y, p.m);
      /* A quarter ends with its third month, read off the anchor month the
         engine already stored rather than off the raw string again. */
      case 'quarter': return BT.util.endOfMonthSortKey(p.y, BT.util.quarterOf(p.m) * 3);
      case 'year':    return BT.util.endOfMonthSortKey(p.y, 12);
      /* 'tba' and 'unknown' carry no window at all. Neither is a future date:
         "we do not know" and "it has not happened yet" are different facts, and
         a list that conflated them would be padded with undated backlist. */
      default:        return null;
    }
  }

  /* -> 'future' | 'maybe' | 'past' | 'unknown' */
  function futureness(release) {
    const end = windowEnd(release);
    if (end == null) return 'unknown';
    const today = BT.util.todaySortKey();
    /* `<=`, not `<`. A book that publishes TODAY is not published in the
       future. It is out; it is on a shelf in a shop this morning. */
    if (end <= today) return 'past';
    return release.sortKey > today ? 'future' : 'maybe';
  }

  /* The release a search doc supports, and not one grain more.

     max(publish_year), NOT first_publish_year. first_publish_year is a computed
     minimum over every edition and is frequently decades early (The Alloy of
     Law, published 2011, reports 2001; verified), so a forthcoming reissue of
     an old novel would test as 1953 and be dropped. max(publish_year) is the
     newest printing anyone has catalogued.

     A REPRINT COUNTS, and that is the user's own rule rather than an oversight:
     "i just want things listed with a publication date that is in the future
     from the current date". A 2027 reissue of a 1953 novel has a 2027
     publication date. The test is the date.

     `basis: 'work-first-published'` is the half-weight one, matching
     stubFromSearchDoc: the year is real, but a search doc names no edition, so
     the confidence should say the printing behind it is not identified. */
  function releaseOfWork(work) {
    const year = yearOf(work);
    return BT.normalize.buildRelease(year ? String(year) : '', {
      basis: 'work-first-published',
      source: 'openlibrary',
      inPrint: !!(work && work.coverId),
    });
  }

  /* ── SHARPENING A YEAR INTO A DAY ──────────────────────────────────────
     -> a finer release for this work, or null when there is nothing to gain.

     Open Library cannot answer "which day", so on its evidence alone a
     current-year work is stuck at 'maybe' for ever. Google Books can: its
     `publishedDate` is a real 'YYYY-MM-DD' on a large share of volumes. One
     request turns "2026, could be either" into "Nov 17, still ahead of you" —
     or into a row the Following page then correctly moves to its recent band.

     KEY-GATED, AND THE GATE IS NOT A PREFERENCE. Anonymous access to the Books
     API answers HTTP 429 carrying `"quota_limit_value":"0"` — a quota of zero,
     not a quota you can exhaust — so a keyless request is not a degraded
     version of this, it is an error every single time. BT.googlebooks.enabled()
     is the gate, and nothing in this file builds a Google URL.

     THE MATCH RULES ARE BORROWED, NOT REWRITTEN. confidentMatch() and
     releaseFromVolume() come straight out of 25-googlebooks.js, so the year
     gate, the folded-title test and the shared-surname test are the same three
     the library's own date upgrade uses. A second, laxer copy of those rules is
     precisely how a stranger's publication date ends up on the reader's book.

     SO IT CAN ONLY EVER SHARPEN, NEVER MOVE. The year gate refuses any volume
     whose year disagrees with the one we already hold, so the worst this can do
     is pick the wrong day inside the right year — which cannot resurrect a book
     from a past year, and cannot invent a future one. */
  async function sharpenYear(work, authorName, opts) {
    opts = opts || {};
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function' || !gb.enabled()) return null;

    const release = opts.release || releaseOfWork(work);
    /* Only a bare year is worth a request. Anything finer is already better
       than Google's own field can be trusted to improve, and pickRelease would
       refuse a coarser payload anyway — same floor, stated at both ends. */
    if (release.precision !== 'year') return null;

    const parts = BT.util.sortKeyToParts(release.sortKey);
    const year = parts && parts.y;
    const title = String((work && work.title) || '').trim();
    const author = String(authorName || '').trim();
    if (!year || !title || !author) return null;

    /* The pseudo-item confidentMatch() reads: a title, an author list, and the
       release we already believe. Assembled rather than fetched, because the
       entire point of this screen is books the reader does NOT own — there is
       no stored item to hand over and adding one to get a date would be the
       silent-add bug this view was already fixed for. */
    const probe = { title, authors: [{ name: author }], release };

    const res = await gb.search(
      `intitle:${phrase(title)} inauthor:${phrase(author)}`,
      { limit: 20, signal: opts.signal, ttl: opts.ttl });

    const rank = p => BT.normalize.precisionRank(p);
    let best = null;
    for (const vol of (res && res.items) || []) {
      if (!gb.confidentMatch(probe, vol, year)) continue;
      const hit = gb.releaseFromVolume(vol);
      if (!hit || rank(hit.release.precision) <= rank(release.precision)) continue;
      const rel = hit.release;
      /* Finest first, then EARLIEST — and for this filter earliest is the
         conservative end rather than merely the consistent one. A work with a
         March hardback and a November paperback in one year came out in March;
         taking November would leave a book already sitting in shops filed under
         a heading that says it is still to come. */
      if (!best
          || rank(rel.precision) > rank(best.precision)
          || (rank(rel.precision) === rank(best.precision) && rel.sortKey < best.sortKey)) {
        best = rel;
      }
    }
    return best;
  }

  /* A quoted phrase for Google's `intitle:` / `inauthor:`. Embedded quotes are
     REPLACED rather than escaped, because Google's query grammar has no escape
     sequence at all — a stray quote closes the phrase early and silently widens
     the search into an unrelated result set, which the year gate would then be
     the only thing standing between us and a wrong date. */
  function phrase(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  }

  /* ══ THE DIFF, AND THE WRITE ════════════════════════════════════════════
     -> { row, cold, added, changed, error }   , or null if the follow is gone.

     THE ONLY WRITER of works / worksAt / knownWorkIds / news, and the only
     caller of worksOf(). Everything about "what changed" is decided here, once,
     so the Following page and the Activity feed cannot disagree about it —
     which is precisely what they did when each fetched its own copy.

     UNCONDITIONAL: this always asks. The per-follow cooldown lives one level up
     in the queue worker, because "is this worth re-asking?" is a scheduling
     question and this function's job is to answer "what does the catalogue say
     right now". A caller who reaches for this has already decided.

     TWO KINDS OF NEWS, and they need different evidence:

       added    a work id that is not in `knownWorkIds`. The union baseline is
                the right question here rather than the previous window, because
                the window is only the top 60 by recency: a title that slid out
                last month and back in today has not appeared, it has moved.

       changed  a work we already knew whose year moved. This one MUST be
                computed against the previous WINDOW, because that is the only
                place a year was ever recorded — `knownWorkIds` is a bag of ids
                and holds no dates at all. This is the half the old two-path
                arrangement could not do in principle, not merely did not do.

     A FAILURE WRITES NOTHING BUT THE ATTEMPT. `lastCheckedAt`, `works` and the
     baseline are left exactly as they were, so the follow stays due and is
     retried — and the page goes on rendering the cache it already had rather
     than blanking. Only `lastTriedAt` and `lastError` move, which is what lets
     a section say "could not check, 3 minutes ago" over a list that is still
     the truth as of this morning. */
  async function refreshOne(idOrRow, opts) {
    opts = opts || {};
    const id = typeof idOrRow === 'string' ? idOrRow : (idOrRow && idOrRow.id);
    if (!id) return null;

    /* Read before, and again after. A refresh holds a row across a network
       round trip and unfollowing during one is ordinary; a blind put would
       resurrect a row the reader deleted. */
    let row = await get(id);
    if (!row) return null;

    let res;
    try {
      res = await worksOf(row, { signal: opts.signal });
    } catch (e) {
      /* An abort is a cancelled intention, not a fault: the reader changed
         screens. Nothing is recorded, because nothing was learned and marking
         it as a failed check would show an error on a follow that is fine. */
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
      row = await get(id);
      if (!row) return null;
      row.lastTriedAt = Date.now();
      row.lastError = (e && e.message) || String(e);
      await BT.repo.putFollow(row);
      return { row, cold: false, added: [], changed: [], error: e };
    }

    row = await get(id);
    if (!row) return null;

    const works = res.works;
    const held = cachedWorks(row);

    /* ── AN EMPTY ANSWER MUST NOT ERASE A GOOD CACHE ──────────────────────
       Open Library answers HTTP 200 with `{"numFound":0,"docs":[]}` for a great
       many things that are not "this author has published nothing": an OLID
       that has been merged away, a query issued while the search index is
       being rebuilt, and the read-only maintenance windows the service takes.
       05-net cannot classify any of those as failures, and it is right not to —
       an empty result set is a real, cacheable answer and the CALLER decides
       what it means. This is that decision.

       Without this branch one bad response replaces sixty stored works with
       zero, stamps the follow as successfully checked, and the section then
       says "Nothing is scheduled for Stephen King" in a confident sentence with
       nothing on screen to suggest it is wrong. That is the single most
       damaging thing this feature can do, because it is indistinguishable from
       a correct answer.

       So: keep the window, keep `lastCheckedAt`, record what happened. The
       section goes on rendering the catalogue it had, with the warning above
       it, which is the honest reading — we asked, and what came back was not
       usable. A follow that genuinely has nothing (a brand-new author record)
       has no cache to protect and falls through to the normal path below. */
    if (!works.length && held.length) {
      row.lastTriedAt = Date.now();
      row.lastError = 'Open Library returned an empty catalogue for this author, '
        + 'which usually means its search index is rebuilding or the record has been '
        + 'merged. The list below is what we last read successfully.';
      await BT.repo.putFollow(row);
      return { row, cold: false, added: [], changed: [], emitted: [],
               error: new Error(row.lastError) };
    }

    const prev = new Map(held.map(w => [w.workId, w]));
    const known = new Set();
    for (const k of (row.knownWorkIds || [])) {
      const n = BT.util.olid(k);
      if (n) known.add(n);
    }

    /* COLD — rule 3. Two tests joined by AND rather than one, because of the
       readers who are already running this app: a row written by the previous
       build has a full `knownWorkIds` and no `worksAt` at all. Testing only
       `worksAt` would call that follow cold and throw away a baseline that is
       already correct, so the very first refresh after the upgrade would
       silently swallow every genuinely new book. Testing only `knownWorkIds`
       would be wrong in the other direction the day an author's catalogue is
       briefly empty. Both empty means we have never looked. */
    const cold = !row.worksAt && known.size === 0;

    const added = [];
    const changed = [];
    for (const w of works) {
      if (!known.has(w.workId)) {
        if (!cold) added.push(w);
        continue;
      }
      const was = prev.get(w.workId);
      /* Known, but not in the last window — see the `added` note above. There
         is no date to compare against, so there is nothing to say. */
      if (!was) continue;
      const from = yearOf(was);
      const to = yearOf(w);
      /* Both ends must be real. `null -> 2026` is a cataloguing improvement on
         a record that never carried a year, not a book whose date moved, and
         announcing it as movement is the kind of line that teaches a reader to
         stop reading the feed. `2026 -> null` cannot be a correction worth
         printing either: it is a field that was dropped. */
      if (from == null || to == null || from === to) continue;
      changed.push({ work: w, from, to });
    }

    for (const w of works) known.add(w.workId);
    const now = Date.now();

    row.works = works;
    row.worksAt = now;
    row.numFound = res.numFound || works.length;
    row.knownWorkIds = Array.from(known).slice(-KNOWN_CAP);
    row.lastCheckedAt = now;
    row.lastTriedAt = now;
    row.lastError = '';
    row.news = mergeNews(row.news, added, changed, now);
    if (!row.newsSeenAt) row.newsSeenAt = row.addedAt || now;
    await BT.repo.putFollow(row);

    const out = { row, cold, added, changed, error: null };
    /* ANNOUNCED HERE, NOT IN THE QUEUE WORKER, and the difference is the whole
       "the diff IS the alert" claim. Announcing from the loop meant the feed
       was written only when a refresh arrived through that ONE door — so a
       direct refreshOne() from the Activity screen, a per-author Refresh
       button routed differently, or a future caller would all update the cache
       and silently produce no news. That is precisely the two-paths bug this
       rewrite exists to remove, reintroduced one level down. Observed: a diff
       of two new works and one changed year updated the page and wrote nothing
       to the feed.

       The write is ordered AFTER putFollow so the cache is durable first: a tab
       closed between the two loses a feed row, which is invisible, rather than
       leaving a stored window the feed has already reported on, which would
       swallow the change for ever. */
    out.emitted = await announce(out);
    return out;
  }

  /* The per-author news feed: what this refresh learned, newest last, capped.

     Kept ON THE FOLLOW ROW rather than derived from the Activity feed, and the
     difference matters. Activity is one shared stream with one shared read
     state; this is "what has changed for THIS author since you last looked at
     this author", which is the question the section header answers and the
     sidebar badge counts. Reading Activity for it would mean opening the
     Following page marked the whole feed read, and a book's date moving would
     clear an author's news badge. */
  function mergeNews(existing, added, changed, at) {
    const out = Array.isArray(existing) ? existing.slice() : [];
    for (const w of added) {
      out.push({ at, kind: 'new', workId: w.workId, title: w.title, from: null, to: yearOf(w) });
    }
    for (const c of changed) {
      out.push({ at, kind: 'moved', workId: c.work.workId, title: c.work.title,
                 from: c.from, to: c.to });
    }
    if (out.length > NEWS_CAP) out.splice(0, out.length - NEWS_CAP);
    return out;
  }

  /* ── The unread count ──────────────────────────────────────────────────
     One definition, read by the sidebar badge and by every section header, so
     the number in the tree and the number on the row can never disagree. */
  function unseenNews(row) {
    const seen = (row && row.newsSeenAt) || 0;
    return ((row && row.news) || []).filter(n => n && n.at > seen);
  }

  function unseenCount(rows) {
    let n = 0;
    for (const f of (rows || [])) if (isAuthorRow(f)) n += unseenNews(f).length;
    return n;
  }

  /* Clears one author's badge. Called when the reader has actually SEEN the
     section — see the note on the timer in 67-view-people.js — so it behaves
     like an unread count and not like a number that vanishes on navigation.

     Nothing is deleted: `news` stays, so the section can still show what
     changed and when. Only the mark moves. */
  async function markNewsSeen(id) {
    const row = await get(id);
    if (!row) return false;
    const unseen = unseenNews(row).length;
    if (!unseen) return false;
    row.newsSeenAt = Date.now();
    await BT.repo.putFollow(row);
    return true;
  }

  /* ══ THE ONE SERIALIZED REFRESHER ═══════════════════════════════════════
     ONE queue. ONE worker. Every caller — the Following page on entry, its
     Refresh buttons, following a new author, the Activity screen's "Check now",
     and the background sweep at startup — pushes onto this and nothing else.

     THAT IS THE RATE LIMIT, and it is why there is no per-sweep cap any more.
     Open Library sustains about one request a second and asks not to be used as
     a backend for automated traffic; the old answer was a cap of three follows
     per sweep, which rotated the roster so slowly that a reader with twelve
     authors saw each of them checked twice a day. The answer here is SHAPE
     instead of SIZE:

       · one follow at a time, a plain loop with one await, never Promise.all;
       · a per-follow cooldown (WORKS_TTL) so an automatic pass over a roster
         that was refreshed an hour ago costs ZERO requests;
       · the queue yields to interactive work — see hold() — so an author
         lookup in the search box never queues behind thirty roster refreshes;
       · progress is emitted, so a long walk is visible rather than mysterious.

     A cap would still be the wrong tool: it does not reduce the total number of
     requests a roster costs, it only spreads them over more days while making
     the screen wrong in between. */

  const queue = [];          // [{ id, force }] — in service order
  let worker = null;         // the single in-flight pump(), or null
  let cancelled = false;
  let holds = 0;             // interactive work that outranks the queue
  const stats = { running: false, total: 0, done: 0, ok: 0, failed: 0, name: '', reason: '' };

  /* Interactive priority. The author search box calls hold() before its request
     and release() after it, because both share one 1-req/sec bucket in 05-net —
     and a lookup that lands behind a roster walk takes thirty seconds to answer
     a question the reader asked three keystrokes ago. That contention was a
     direct cause of the reported "it feels unresponsive". */
  function hold() { holds++; }
  function release() { holds = Math.max(0, holds - 1); }

  async function waitForQuiet() {
    let waited = 0;
    /* Bounded. A hold that leaks — a search that threw between hold() and
       release() — must cost a few seconds, never wedge the refresher for the
       rest of the session. */
    while (holds > 0 && waited < HOLD_MAX_MS && !cancelled) {
      await BT.util.sleep(120);
      waited += 120;
    }
  }

  function emitProgress() {
    /* Through BT.repo so there is one event bus in the app. Every existing
       subscriber filters on the event name, so a name they do not know is inert
       — which is what makes adding one safe. */
    if (BT.repo && typeof BT.repo.emit === 'function') {
      BT.repo.emit('follows:progress', Object.assign({}, stats));
    }
  }

  function enqueue(id, opts) {
    const at = queue.findIndex(j => j.id === id);
    if (at >= 0) {
      if (opts.force) queue[at].force = true;
      /* Already waiting, and now wanted NOW — following an author puts their
         section on screen saying "checking", so it has to jump the roster. */
      if (opts.front && at > 0) queue.unshift(queue.splice(at, 1)[0]);
      return;
    }
    const job = { id, force: !!opts.force };
    if (opts.front) queue.unshift(job); else queue.push(job);
  }

  /* Is this follow's cache current enough to leave alone? Explicit refreshes
     never ask. */
  const isFresh = row => !!(row && row.worksAt && (Date.now() - row.worksAt) < WORKS_TTL);

  async function drain() {
    while (queue.length && !cancelled) {
      const job = queue.shift();
      const row = await get(job.id);
      stats.done++;
      if (!row || row.muted) { done(job.id, null, 'gone'); continue; }
      stats.name = row.name || '';
      emitProgress();

      if (!job.force && isFresh(row)) {
        /* Nothing asked for, nothing spent. The cache is inside its window, so
           the screen is already showing the current answer. This branch is why
           the per-sweep cap could be removed: an automatic pass over a roster
           refreshed an hour ago is pure IndexedDB and costs Open Library
           nothing at all. */
        stats.ok++;
        done(job.id, null, 'fresh');
        continue;
      }

      await waitForQuiet();
      if (cancelled) break;

      let out = null;
      try {
        out = await refreshOne(row, {});
      } catch (e) {
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) break;
        console.warn('[follows] refresh threw for', row.name, e && e.message);
      }

      /* No announce() here — refreshOne does it, so that every route to a
         refresh produces the same news. See the note at the end of that
         function. */
      if (out && !out.error) stats.ok++;
      else stats.failed++;
      done(job.id, out, 'checked');
    }
  }

  /* Per follow, so a page can repaint ONE section as its own answer lands
     rather than all of them at the end.

     Emitted for EVERY outcome including the two that did no work — a muted or
     deleted row, and a cache still inside its window. A listener that only
     heard about follows which were actually fetched would leave the other two
     showing "Checking…" until the whole queue drained, which on a roster where
     most rows are fresh is a page that looks busy while doing nothing. */
  function done(id, out, why) {
    if (BT.repo && typeof BT.repo.emit === 'function') {
      BT.repo.emit('follows:updated', {
        id,
        why,
        added: (out && out.added) || [],
        changed: (out && out.changed) || [],
        error: (out && out.error) || null,
      });
    }
    emitProgress();
  }

  /* THE ASSIGNMENT MUST HAPPEN BEFORE THE CLEAR CAN RUN, and getting that
     backwards wedges the whole feature permanently.

     This was written as `worker = (async () => { try { …loop… } finally
     { worker = null; } })();` — which is correct only if the loop body
     suspends at least once. It does not when the queue is EMPTY: the async
     function then runs start to finish synchronously, the `finally` sets
     `worker = null` while the outer assignment has not happened yet, and the
     assignment afterwards installs an already-settled promise into `worker`.
     From that moment `if (worker) return worker` is true for ever, so every
     later call returns a resolved promise having done nothing and the refresher
     never runs again.

     It reproduced on every single boot, because boot sweeps before there is
     anything to sweep: 90-boot calls BT.alerts.sweep, which calls refreshAll,
     which enqueues nothing when the roster is empty on a first run — or, in the
     app as it actually starts, before the page has been visited. Observed
     directly: `isRefreshing() === true` with `running: false` and `queued: 3`,
     three follows sitting in the queue, and zero requests made.

     `.finally()` fixes it structurally rather than by adding a guard: its
     callback is always deferred to a microtask, so `worker` is assigned first
     no matter how the body behaves. The catch is separate and swallowing,
     because a throw escaping the worker would leave `stats.running` true and
     the UI stuck on "Checking…". */
  function pump() {
    if (worker) return worker;
    cancelled = false;
    stats.running = true;
    stats.done = 0;
    stats.ok = 0;
    stats.failed = 0;
    emitProgress();

    worker = drain()
      .catch(e => { console.warn('[follows] the refresher stopped', e && e.message); })
      .finally(() => {
        worker = null;
        stats.running = false;
        stats.name = '';
        emitProgress();
      });
    return worker;
  }

  /* ── The diff IS the alert ─────────────────────────────────────────────
     The one seam between this file and 45-alerts.js, and it points this way on
     purpose. Alerts used to be a PARALLEL POLLING SYSTEM: it fetched the same
     catalogue on its own schedule and diffed it against its own baseline, which
     is how the feed and the Following page ended up disagreeing about what an
     author had out. Now there is one refresh, one diff, and the feed is a log
     of it.

     Feature-detected and caught, because a feed row is a nicety and the cache
     write above is the thing that matters: if 45-alerts.js is absent or throws,
     the Following page must still be correct. */
  async function announce(out) {
    const a = BT.alerts;
    if (!a || typeof a.recordFollowDiff !== 'function') return [];
    if (!out.added.length && !out.changed.length) return [];
    try { return (await a.recordFollowDiff(out)) || []; }
    catch (e) {
      console.warn('[follows] could not record the diff', e && e.message);
      return [];
    }
  }

  /* -> a promise that settles when the queue drains.

     opts: { ids, force, front, reason }
       ids     which follows, defaulting to the whole roster
       force   ignore the per-follow cooldown (a button was pressed)
       front   jump the queue (an author was just followed)
       reason  a word for the progress line ('startup', 'page', 'manual') */
  async function refreshAll(opts) {
    opts = opts || {};
    let rows = await all();
    rows = rows.filter(f => !f.muted);
    if (opts.ids && opts.ids.length) {
      const want = new Set(opts.ids);
      rows = rows.filter(f => want.has(f.id));
    }
    /* Least-recently-checked first, so an interrupted walk still comes round
       and the follow most likely to have changed answers first. */
    rows.sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));

    for (const f of rows) enqueue(f.id, opts);
    stats.total = queue.length + (stats.running ? 1 : 0);
    stats.reason = opts.reason || '';

    await pump();
    /* Drained, but something may have been enqueued in the window between the
       loop reading `queue.length` for the last time and the worker clearing
       itself — a second Refresh press, or a follow added while the walk was
       finishing. Without this those jobs would sit in the queue until the next
       unrelated refresh, which is the shape of bug that gets reported as "the
       refresh button did nothing that time". */
    if (queue.length) await pump();
    return { ok: stats.ok, failed: stats.failed, checked: stats.done };
  }

  const isRefreshing = () => !!worker;
  const progress = () => Object.assign({}, stats, { queued: queue.length });
  function cancelRefresh() { cancelled = true; queue.length = 0; }

  /* ══ RETIRING PUBLISHER FOLLOWS ═════════════════════════════════════════
     Runs once, from boot, and is idempotent afterwards.

     THE ROWS ARE COPIED BEFORE THEY ARE DELETED, and that is not caution for
     its own sake. This user is actively syncing real data, and a migration that
     silently drops rows from a store that replicates is a migration that drops
     them on every device at once with no way back. The copy lands in `meta`,
     which does not sync — so it is a local escape hatch on the machine that ran
     the migration, exactly where somebody would look.

     Publisher following was never load-bearing: no work was tracked through it
     and no library item points at it. What is lost by dropping a row is the
     name the reader typed, which is what the copy preserves. */
  async function retirePublisherFollows() {
    const rows = (await BT.repo.allFollows()).filter(f => f && f.type === 'publisher');
    if (!rows.length) return 0;
    try {
      await BT.repo.metaSet('follows.retiredPublishers', {
        at: Date.now(),
        rows: rows.map(r => ({ id: r.id, name: r.name, sourceId: r.sourceId, addedAt: r.addedAt })),
      });
    } catch (e) {
      /* If the copy cannot be written, the delete does not happen. A row that
         is merely stale is a smaller problem than one that is gone. */
      console.warn('[follows] could not archive publisher follows; leaving them in place', e);
      return 0;
    }
    for (const r of rows) await BT.repo.deleteFollow(r.id);
    console.info(`[follows] retired ${rows.length} publisher follow(s); a copy is in meta.follows.retiredPublishers`);
    return rows.length;
  }

  return {
    toggleAuthor,
    isFollowing, follow, unfollow, all, get,
    authorId,
    /* The catalogue: how to ask, how to read the stored answer, and the one
       function that turns the first into the second. */
    worksOf, cachedWorks, refreshOne,
    /* The refresher. `hold`/`release` are the interactive-priority pair the
       author search box uses; nothing else should touch them. */
    refreshAll, isRefreshing, cancelRefresh, progress, hold, release,
    /* News, counted in exactly one place so the sidebar and the sections agree. */
    unseenNews, unseenCount, markNewsSeen,
    /* The forthcoming test, exported as three pieces rather than one
       `isUpcoming(work)` boolean, because the caller needs all three answers:
       the release to RENDER, the verdict to BAND, and the window end to explain
       itself. A boolean would collapse 'maybe' into one of its neighbours at
       the only point where the distinction is visible. */
    releaseOfWork, futureness, windowEnd, sharpenYear,
    retirePublisherFollows,
    /* Exposed so the sweep, 16-cloud's merge and the console can assert the
       invariants that cannot be seen from a stored row. */
    KNOWN_CAP, WORKS_CAP, WORKS_TTL, NEWS_CAP,
  };
})();
