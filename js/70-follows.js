/* ══════════════════════════════════════════════════════════════════════════
   Following authors and publishers.

   The logic half only — this file touches no DOM and renders nothing. It owns
   the id scheme, the persistence, and the one question the alerts sweep asks:
   "what is in this follow's catalogue right now?". 67-view-people.js draws it,
   61-view-search.js and 56-inspector.js offer it, 45-alerts.js diffs it.

   THREE things here are load-bearing. Each was measured, each fails quietly,
   and each will look like an over-complication to whoever reads it next.

   1. AN AUTHOR FOLLOW IS AN OLID. NEVER A NAME.

      This is not a preference for stable identifiers, it is a bug report.
      Verified live against the API:

          search.json?author=gwendolyn+kiste   →   Occultation
                                                   Swift to Chase
                                                   The Beautiful Thing That
                                                     Awaits Us All

      Those are LAIRD BARRON'S books. Not an error, not an empty list — HTTP
      200 and a confident bibliography for the wrong writer. `author=` with a
      name is fuzzy matching over a name index, and there is nothing in the
      response that says so. The same query with an OLID
      (`author=OL1394865A`) means exactly what it says.

      So `toggleAuthor` REFUSES a follow it has no OLID for, and returns null
      rather than inventing one from the name. A follow that silently watches
      the wrong author is worse than no follow: it is a feed of plausible
      books, attributed to someone the reader has never read, arriving under
      the heading "new from an author you follow".

      `/search/authors.json?q=` is where an OLID comes from, and it is the ONE
      endpoint in the whole API that returns a BARE id ('OL1394865A') instead
      of a path ('/authors/OL1394865A'). BT.util.olid() eats both; nothing in
      this file slices a key by hand.

   2. A PUBLISHER FOLLOW IS A GUESS, AND SAYS SO.

      Open Library has no publisher records, no publisher ids, and no publisher
      index. `publisher=` is a TOKEN MATCH over a free-text field that
      volunteers typed by hand over forty years, so `publisher=tor` collapses
      Tor, Tor.com, Tor Science Fiction, Tor Teen and "A Tom Doherty Associates
      Book" into one result set — and misses the printings catalogued as
      "Tom Doherty Associates" with no Tor in the string at all.

      There is no way to fix that from here. What there is, is a duty not to
      pretend otherwise: the id is a slug marked `source:'heuristic'`,
      worksOf() returns `approximate: true`, and the view says the word
      "approximate" out loud. See publisherSlug() for the merge failures the
      slug itself adds on top.

   3. worksOf() IS READ-ONLY. ONLY markChecked() WRITES A BASELINE.

      Both the Following page and the alerts sweep call worksOf(). If the page
      also recorded what it saw into `knownWorkIds`, it would consume the
      baseline the sweep exists to diff against — so opening the page once
      would mean the sweep afterwards found nothing new and emitted nothing,
      for ever, with no error anywhere. The screen would look perfect and the
      feature would be dead.

      One writer. It is markChecked(), it is called by the sweep, and it is the
      only function in this file that touches knownWorkIds.

   ── Rate limit ────────────────────────────────────────────────────────────
   Open Library sustains about one request a second and asks not to be used as
   a backend for automated traffic. Every path here is ONE request per follow,
   and the SERIALIZATION IS THE CALLER'S. No function in this file loops over
   every follow, and none may.

   The two callers spend that budget differently on purpose, and both are
   correct:

     · The alerts sweep is UNATTENDED. Nobody is waiting, so it takes the
       handful of follows due() hands back (SWEEP_FOLLOWS) and asks for them
       `fresh` — the whole point of a sweep is to see what changed, so a cached
       answer would be worthless to it. Its cap stays.
     · The Following page is WATCHED. Someone is looking at it and has asked to
       see everything, so it walks the whole roster one follow at a time,
       painting what is cached before it asks for anything and painting each
       answer as it lands. Its cap is gone; see 67-view-people.js.

   What makes the second affordable is WORKS_TTL below plus `cacheOnly`, both
   of which exist for it. `fresh` still bypasses the cache entirely, so the
   page can never blind the sweep.
   ══════════════════════════════════════════════════════════════════════════ */

BT.follows = (function () {

  /* Sources, spelled once. 'openlibrary' is a real catalogue identity;
     'heuristic' is the honest word for a slug we made up ourselves, and it is
     stored on the row so an export can never present the two as equals. */
  const AUTHOR_SOURCE = 'openlibrary';
  const PUBLISHER_SOURCE = 'heuristic';

  /* How many follows one sweep may touch. Three, not "all of them": at ~1
     req/sec a reader with forty follows would otherwise spend forty seconds of
     the app's entire allowance the moment they opened it, and be throttled out
     of searching for a book. due() rotates on lastCheckedAt so the whole
     roster still comes round. */
  const SWEEP_FOLLOWS = 3;

  /* How long one follow's catalogue page may be reused before it is worth
     asking again.

     NOT BT.TTL.search, which is the ten minutes netOpts would otherwise
     default these calls to. That number is short because a search is a live
     question with someone watching the box, and this is not that question: it
     is "what does this author have out", asked by a screen the reader opens
     occasionally, against a catalogue whose answer changes when a volunteer
     types something in — not by the minute.

     Ten minutes is also what made showing the WHOLE roster unaffordable. The
     Following page walks every follow, so at ten minutes a reader with thirty
     follows paid thirty requests for a second look at the same screen half an
     hour later. At the sweep cooldown they pay nothing.

     BT.SWEEP.cooldownMs is reused rather than a fresh number invented, because
     it is already this app's answer to "how often is it worth re-asking what
     is in a follow's catalogue?" — the alerts sweep will not re-check a follow
     more often than this either. One number, one meaning, and the two cannot
     drift apart. The sweep itself is unaffected regardless: it passes
     `fresh: true`, which skips the cache in both directions. */
  const WORKS_TTL = (BT.SWEEP && BT.SWEEP.cooldownMs) || 4 * 3600e3;

  /* Ceiling on a stored baseline. A prolific author is ~200 works and a
     publisher token is one page of 60, so this is not close to reachable in
     normal use — it exists so a decade of imported exports cannot grow a row
     without bound. Overflow drops the OLDEST ids, which in principle lets a
     long-forgotten work re-read as new; in practice it cannot reach the feed,
     because alert ids are content-addressed and the `alertKeys` ledger has
     already seen that one. */
  const KNOWN_CAP = 4000;

  /* ══ IDS ════════════════════════════════════════════════════════════════
     `author:openlibrary:OL1394865A` and `publisher:heuristic:tor`. The shape
     is `{type}:{source}:{sourceId}`, matching the uid scheme in
     38-normalize.js, so a row is legible in a database viewer and an export
     never needs a lookup table to be understood.

     Both builders return '' rather than a partial id when there is nothing
     usable, so every caller branches on the id and never on the input. */
  function authorId(olid) {
    const id = BT.util.olid(olid);
    return id ? `author:${AUTHOR_SOURCE}:${id}` : '';
  }

  function publisherId(name) {
    const s = publisherSlug(name);
    return s ? `publisher:${PUBLISHER_SOURCE}:${s}` : '';
  }

  /* Corporate and format apparatus. These words appear in imprint strings
     because a cataloguer copied the title page, not because they distinguish
     one publisher from another: "Tor Books", "Tor Publishing Group" and "Tor"
     are one thing to a reader. */
  const SUFFIX_TOKENS = new Set([
    'book', 'books', 'press', 'publishing', 'publishers', 'publisher',
    'publication', 'publications', 'publishinghouse', 'house', 'editions',
    'edition', 'imprint', 'imprints', 'media', 'group', 'inc', 'incorporated',
    'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'co', 'corp', 'corporation',
    'company', 'gmbh', 'ag', 'sa', 'sarl', 'bv', 'nv', 'ab', 'as', 'oy',
    'pty', 'pubs',
  ]);

  /* ── The publisher slug, and what it gets wrong ────────────────────────
     Lowercase, strip accents, expand '&' to 'and' so "Simon & Schuster" and
     "Simon and Schuster" are one follow, drop the corporate apparatus above,
     join the rest with hyphens.

     IT BOTH OVER-MERGES AND UNDER-MERGES, and that is a named limitation
     rather than a bug waiting to be fixed — the input is free text with no
     authority file behind it, so no rule can be right. Measured on real
     imprint strings:

         over-merge   'Penguin Books'  and 'Penguin Press'  → penguin
                      'MIT Press'      and 'MIT'            → mit
                      'The Free Press' and 'Free'           → free
         under-merge  'Tor Books'      → tor
                      'Tor.com'        → tor-com            (a different follow)
                      'Tom Doherty Associates' → tom-doherty-associates

     The over-merges are the acceptable half: a reader following Penguin
     probably does mean the whole house. The under-merges are the visible half,
     and they are why the roster tells the user plainly that publisher matching
     is approximate instead of showing a confident count.

     THE EMPTY-SLUG GUARD IS NOT DECORATION. "Press", "Books" and "Editions"
     are all real publisher names in the catalogue, and stripping every token
     from one of them yields '' — which would make publisherId() return '' and
     the Follow button do nothing at all, silently, on a name that is on the
     spine of a real book. When stripping empties the string, keep the words. */
  function publisherSlug(name) {
    let t = String(name == null ? '' : name).toLowerCase().trim();
    /* Accents folded so 'Éditions Gallimard' and 'Editions Gallimard' — both
       of which are in the catalogue — are the same follow. Wrapped because
       String.normalize is absent on some older embedded WebViews and an
       exception here would take the whole Follow button down. */
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    t = t.replace(/&/g, ' and ');

    const words = t.split(/[^a-z0-9]+/).filter(Boolean);
    /* A leading article only. Dropping 'the' everywhere would take it out of
       the middle of a real name; a leading one is always apparatus. */
    if (words[0] === 'the') words.shift();

    const kept = words.filter(w => !SUFFIX_TOKENS.has(w));
    return (kept.length ? kept : words).join('-');
  }

  /* ══ PERSISTENCE ════════════════════════════════════════════════════════
     Everything goes through BT.repo, which owns the store and emits
     'follow:change' — that event is what re-counts the Following row in the
     index tree, so nothing here calls BT.db and nothing here repaints. */

  const all = () => BT.repo.allFollows();
  const get = id => (id ? BT.repo.getFollow(id) : Promise.resolve(null));

  async function isFollowing(id) {
    if (!id) return false;
    return !!(await BT.repo.getFollow(id));
  }

  /* Fill a caller's partial row out to the stored shape. Returns null for
     anything that cannot be identified, because a follow with no id is a row
     that can never be unfollowed. */
  function normalizeRow(row) {
    if (!row || !row.type) return null;
    const type = row.type === 'publisher' ? 'publisher' : 'author';

    let id = row.id || '';
    let sourceId = row.sourceId || '';
    if (type === 'author') {
      sourceId = BT.util.olid(sourceId || id || '');
      id = authorId(sourceId);
    } else {
      sourceId = publisherSlug(sourceId || row.name || '');
      id = sourceId ? `publisher:${PUBLISHER_SOURCE}:${sourceId}` : '';
    }
    if (!id || !sourceId) return null;

    const name = String(row.name == null ? '' : row.name).trim() || sourceId;
    return {
      id,
      type,
      source: type === 'author' ? AUTHOR_SOURCE : PUBLISHER_SOURCE,
      sourceId,
      name,
      /* A NEW follow starts with an EMPTY baseline on purpose. Empty is what
         the sweep reads as "never looked", and never-looked is what makes the
         first sighting a silent snapshot instead of 190 alerts. Pre-filling
         this from a work list the caller happens to be holding would be the
         same mistake in a nicer wrapper — it would also mean the sweep never
         sees the first genuinely new book, because it arrived already known. */
      knownWorkIds: [],
      lastCheckedAt: 0,
      addedAt: Date.now(),
      muted: 0,
    };
  }

  /* Idempotent by design. Following someone you already follow is a no-op on
     everything except the display name.

     RE-FOLLOWING MUST NOT RESET THE BASELINE, and this is the failure worth
     naming: the Follow button appears in four places now (search rows, the
     detail pane, the roster, the picker), so pressing it twice is ordinary,
     not exotic. If the second press overwrote the row with a fresh one,
     `knownWorkIds` would go back to empty — the follow would look identical,
     and the next sweep would re-baseline instead of reporting the new book it
     was about to find. A silent, permanent loss of exactly the event the
     feature exists for. */
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

  /* Unfollowing drops the baseline with the row, which is correct: re-following
     later is a first sighting again, and a first sighting emits nothing. The
     alternative — keeping the ids around — would mean re-following an author
     you had dropped for a year told you about nothing that happened in it. */
  async function unfollow(id) {
    if (!id) return false;
    const had = await BT.repo.getFollow(id);
    if (!had) return false;
    await BT.repo.deleteFollow(id);
    return true;
  }

  /* -> { id, type, name, following } , or null when there is nothing to key on.

     NULL IS AN ANSWER THE CALLER MUST HANDLE. For an author it means "this
     record has no OLID" — see rule 1 in the header — and the right response is
     to say so, not to fall back to the name. */
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

  /* Takes either a display name ("Tor Books") or a slug ("tor"); both land on
     the same row, because the id is derived either way. The DISPLAY name is
     kept as typed, since that is what the reader recognises on a spine, and it
     is also what goes into `publisher=` — the token match wants the words, not
     our hyphenated slug. */
  async function togglePublisher(nameOrSlug) {
    const name = String(nameOrSlug == null ? '' : nameOrSlug).trim();
    const id = publisherId(name);
    if (!id) return null;
    const existing = await BT.repo.getFollow(id);
    if (existing) {
      await unfollow(id);
      return { id, type: 'publisher', name: existing.name || name, following: false };
    }
    const row = await follow({ type: 'publisher', name });
    if (!row) return null;
    return { id, type: 'publisher', name: row.name, following: true };
  }

  /* ══ WHAT IS IN THIS FOLLOW'S CATALOGUE ═════════════════════════════════
     -> { works: [shapeWork], numFound, approximate, source }

     ONE request. READ-ONLY — see rule 3 in the header.

     opts: { limit, offset, signal, meta, ttl,
             fresh:     bypass the cache in both directions (the sweep),
             cacheOnly: answer from the cache or with nothing, never the
                        network (the Following page's first pass) }

     `fresh` and `cacheOnly` are the two ends of the same axis and no caller
     passes both. Neither is a filter on the ANSWER: an empty `works` from a
     cacheOnly call means "not looked up yet", not "this author has published
     nothing", and the page treats it that way.

     Errors travel. A follow that could not be checked because Open Library is
     down must NOT come back as an empty catalogue: the sweep would diff an
     empty list against the baseline, find nothing new, and mark the follow
     checked — so a four-hour outage would silently eat every book published
     during it. "We could not look" and "there is nothing new" are different
     facts and this function refuses to collapse them. */
  async function worksOf(followRow, opts) {
    opts = opts || {};
    const row = followRow || {};
    if (row.type === 'publisher') return publisherWorks(row, opts);
    if (row.type === 'author') return authorWorks(row, opts);
    return { works: [], numFound: 0, approximate: false, source: '' };
  }

  function requireAdapter() {
    if (!BT.openlibrary || typeof BT.openlibrary.url !== 'function') {
      /* Thrown rather than returned empty, for the reason above: a missing
         module is a failure to look, not a catalogue with nothing in it. */
      throw new Error('The Open Library client (20-openlibrary.js) is not loaded.');
    }
    return BT.openlibrary;
  }

  /* Authors go through the adapter, which already sends the right query and
     documents why: `search.json?author={OLID}&sort=new`, NOT
     `/authors/{id}/works.json`. The dedicated endpoint carries no publication
     years at all and is ordered by record edit time, so "new from your
     authors" built on it is permanently empty while appearing to work. And
     `sort=new` is safe there specifically because an `?author=` query has no
     free-text `q` for the sort to discard. Read the comment on
     BT.openlibrary.authorWorks before changing any of that. */
  async function authorWorks(row, opts) {
    const ol = requireAdapter();
    const olid = BT.util.olid(row.sourceId || row.id || '');
    if (!olid) return { works: [], numFound: 0, approximate: false, source: 'openlibrary' };

    const res = await ol.authorWorks(olid, {
      limit: opts.limit || BT.LIMITS.authorWorks,
      offset: opts.offset || 0,
      signal: opts.signal,
      fresh: opts.fresh,
      meta: opts.meta,
      /* Listed one by one rather than by spreading `opts`, because this is the
         boundary between this file's vocabulary and the adapter's and a
         silently-forwarded key is how the two drift.

         `cacheOnly` is what lets the Following page put last visit's answers on
         screen before it asks Open Library for anything: 05-net answers it from
         BT.repo.cacheGet or with null, and never touches the network. */
      cacheOnly: opts.cacheOnly,
      ttl: opts.ttl != null ? opts.ttl : WORKS_TTL,
    });
    return {
      works: shapeWorks(res && res.docs),
      numFound: (res && res.numFound) || 0,
      approximate: false,
      source: 'openlibrary',
    };
  }

  /* ── The publisher query ───────────────────────────────────────────────
     `search.json?publisher={name}`, and TWO details are worth stating because
     both produce a wrong answer that looks right.

     1. `publisher` MUST BE NAMED IN `fields=`. It is not in Open Library's
        default doc field set, so a response to a publisher query comes back
        with no publisher on any of its docs — every row then reads as "not
        recorded", and any attempt to show WHICH imprint actually matched (the
        only way a reader can judge an approximate match) has nothing to show.
        The lean list from the adapter plus that one field; nothing else, for
        the same 22x reason `isbn` and `edition_key` are banned from searches.

     2. NO `sort=`. A publisher query has no free-text `q`, so the prohibition
        in 20-openlibrary.js's header does not literally apply — but "looks
        safe" is precisely what `q=dune&sort=editions` also looked like before
        it answered with Robinson Crusoe, and only the `?author=` form has been
        checked against the live API. So results arrive in Open Library's own
        order and are re-sorted by year HERE, by the caller, over the page we
        were given. Which means: newest among these sixty, not newest in the
        catalogue. Say that in the UI rather than implying a publisher feed.

     Built with the adapter's own url() and BT.OL.search so that no Open
     Library URL is spelled out in this file — 20-openlibrary.js stays the only
     place that knows the shapes. If a real publisherWorks() ever lands there,
     it is preferred automatically and this branch can go. */
  async function publisherWorks(row, opts) {
    const ol = requireAdapter();
    const term = String(row.name || row.sourceId || '').trim();
    if (!term) return { works: [], numFound: 0, approximate: true, source: 'heuristic' };

    if (typeof ol.publisherWorks === 'function') {
      const res = await ol.publisherWorks(term, opts);
      return {
        works: shapeWorks(res && res.docs),
        numFound: (res && res.numFound) || 0,
        approximate: true,
        source: 'heuristic',
      };
    }

    const fields = (ol.AUTHOR_WORK_FIELDS || 'key,title,first_publish_year,publish_year,cover_i')
      + ',publisher';
    const url = ol.url(BT.OL.search, {
      publisher: term,
      fields,
      limit: BT.util.clamp(opts.limit || BT.LIMITS.authorWorks, 1, 100),
      offset: (opts.offset || 0) || undefined,
    });
    const data = await BT.net.get('openlibrary', url, {
      ttl: opts.ttl != null ? opts.ttl : WORKS_TTL,
      noCache: !!opts.fresh,
      /* Same seam as the author branch — the Following page's first pass asks
         every follow what is already cached, and must reach the network for
         none of them. */
      cacheOnly: !!opts.cacheOnly,
      signal: opts.signal,
      meta: opts.meta,
    });

    /* `null` is what cacheOnly answers with when nothing is cached, and it is
       not an empty catalogue — it is "we have not looked yet". Nothing is
       claimed from it either way, because the caller's next pass asks properly. */
    const docs = Array.isArray(data && data.docs) ? data.docs : [];
    const works = shapeWorks(docs);
    /* Point 2 above: the order we were given is relevance, not recency, so the
       "newest" reading has to be imposed here. Nulls sort last rather than as
       year zero, because "no year recorded" is common and is not old. */
    works.sort((a, b) => (b.latestYear || b.firstYear || -Infinity)
                       - (a.latestYear || a.firstYear || -Infinity));
    return {
      works,
      numFound: Number(data && data.numFound) || works.length,
      approximate: true,
      source: 'heuristic',
    };
  }

  function shapeWorks(docs) {
    const out = [];
    for (const d of (Array.isArray(docs) ? docs : [])) {
      const w = shapeWork(d);
      if (w) out.push(w);
    }
    return out;
  }

  /* One search doc, reduced to what a diff and a card both need.

     `workId` is the identity for the whole feature — it is what is stored in
     knownWorkIds and what "a work appeared that was not here last time" is
     computed over — so a doc without one is dropped rather than carried with a
     synthesised key. A work id is stable across re-cataloguing; a title is not.

     `firstYear` and `latestYear` are kept SEPARATE and neither is called a
     publication date. first_publish_year is a computed minimum over the work's
     editions and is frequently wrong — The Alloy of Law, published 2011,
     reports 2001 (verified) — while max(publish_year) is the most recent
     printing anyone has catalogued, which is the closer thing to "this turned
     up recently". Open Library has no street dates and no forthcoming titles
     at all, and its dates are years. Anything upstream of here that renders one
     of these as a release date is lying on this file's behalf.

     The raw doc rides along so a caller can hand it to
     BT.normalize.stubFromSearchDoc without a second request. Note it carries no
     author_name: the field list is deliberately lean, so a card built from it
     shows the follow's own name as the attribution and BT.ui.hydrate fills in
     the real credits once the book is actually added. */
  function shapeWork(doc) {
    const workId = BT.util.olid(doc && doc.key);
    if (!workId) return null;
    const years = (Array.isArray(doc.publish_year) ? doc.publish_year : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0);
    const first = Number(doc.first_publish_year);
    const cover = Number(doc.cover_i);
    return {
      workId,
      key: doc.key || '',
      title: String(doc.title || '').trim() || workId,
      firstYear: Number.isFinite(first) && first > 0 ? first : null,
      latestYear: years.length ? Math.max.apply(null, years) : null,
      coverId: Number.isFinite(cover) && cover > 0 ? cover : null,
      /* Present only on publisher queries, and only because `publisher` was
         named in fields=. This is what lets the UI show WHICH imprint string
         actually matched the token — the single most useful correction to an
         approximate match a reader can be given. */
      publishers: Array.isArray(doc.publisher) ? doc.publisher.filter(Boolean).map(String) : [],
      doc,
    };
  }

  /* ══ BASELINE ═══════════════════════════════════════════════════════════
     -> { row, cold, fresh } , or null if the follow is gone.

     The ONLY writer of knownWorkIds. Call it after a SUCCESSFUL worksOf() and
     never after a failed one — see the outage note on worksOf.

     `cold` is true when this follow had no baseline before the call, and
     `fresh` IS THEN DELIBERATELY EMPTY. That is MovieTrak's cold-snapshot rule,
     expressed as data rather than left to each caller to remember: the first
     sighting of an author with 190 works must store 190 ids and emit nothing.
     Without it, the act of following someone is itself a flood of "new
     releases" — and the feature is dead on the day it ships, because the first
     thing every user does is follow five people at once. */
  async function markChecked(idOrRow, works, opts) {
    opts = opts || {};
    const id = typeof idOrRow === 'string' ? idOrRow : (idOrRow && idOrRow.id);
    if (!id) return null;

    /* Re-read rather than trusting the caller's copy: a sweep holds its row
       across a network round trip, and unfollowing during one is ordinary. A
       blind put would resurrect a row the user deleted. */
    const row = await BT.repo.getFollow(id);
    if (!row) return null;

    const known = Array.isArray(row.knownWorkIds) ? row.knownWorkIds : [];
    const cold = known.length === 0;
    const seen = new Set(known);
    const merged = known.slice();
    const fresh = [];

    for (const w of (Array.isArray(works) ? works : [])) {
      const wid = typeof w === 'string' ? w : (w && w.workId);
      if (!wid || seen.has(wid)) continue;      // also dedupes within one batch
      seen.add(wid);
      merged.push(wid);
      if (!cold) fresh.push(wid);
    }

    if (merged.length > KNOWN_CAP) merged.splice(0, merged.length - KNOWN_CAP);
    row.knownWorkIds = merged;
    row.lastCheckedAt = opts.at || Date.now();
    await BT.repo.putFollow(row);
    return { row, cold, fresh };
  }

  /* ══ WHO TO CHECK NEXT ══════════════════════════════════════════════════
     -> a few follows, oldest-checked first.

     A COOLDOWN AND A CAP, not a loop over the roster. Open Library sustains
     about one request a second and asks not to be used as an automated
     backend, so a sweep that fanned out over forty follows would spend forty
     seconds of the app's whole allowance and leave the reader unable to search
     — which is how an app gets throttled and never works out why.

     Oldest-first rotation means the roster still comes round completely,
     three at a time, without anyone tracking a cursor. Muted follows are
     skipped here rather than filtered later, so a muted row costs nothing. */
  async function due(opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const cooldown = opts.cooldownMs != null
      ? opts.cooldownMs
      : ((BT.SWEEP && BT.SWEEP.cooldownMs) || 4 * 3600e3);
    const max = BT.util.clamp(opts.limit || SWEEP_FOLLOWS, 1, 12);

    const rows = (await all()).filter(f =>
      f && !f.muted && (now - (f.lastCheckedAt || 0)) >= cooldown);
    rows.sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));
    return rows.slice(0, max);
  }

  return {
    toggleAuthor, togglePublisher,
    isFollowing, follow, unfollow, all, get,
    authorId, publisherId, publisherSlug,
    worksOf, markChecked, due,
    /* Exposed so the sweep and the console can assert the invariants that
       cannot be seen from a stored row: how many follows one SWEEP may touch
       (the Following page is uncapped and deliberately so), where the baseline
       ceiling is, and how long a catalogue answer is reused for. */
    SWEEP_FOLLOWS, KNOWN_CAP, WORKS_TTL,
  };
})();
