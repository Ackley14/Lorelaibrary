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

     2. `sort=new` IS SAFE HERE, AND IT WAS MEASURED BEFORE IT WAS USED.
        20-openlibrary.js bans `sort=` beside a free-text `q` because
        `q=dune&sort=editions` answers with Robinson Crusoe. A `publisher=`
        query has no free-text `q`, so that ban does not literally apply — but
        "looks safe" is exactly what the dune query looked like too, so this
        form was checked against the live API rather than reasoned about:

            publisher=Tor              numFound 8050, page 1 relevance-ordered,
                                       years 2013 2024 2022 2018 2021 2024 …
            publisher=Tor&sort=new     numFound 8050, page 1 EVERY row a Tor
                                       imprint, years 2026 ×10

        Same result set, same size, newest first. The sort re-orders the
        publisher filter; it does not discard it.

        AND THE FORTHCOMING FILTER NEEDS IT. Relevance order buries every
        recent printing: on that unsorted page, not one of sixty works carried
        a year at or beyond the current one — for an imprint that has dozens of
        titles dated this year. A publisher follow was therefore guaranteed to
        contribute nothing to a "publishing after today" list, silently and for
        a reason no reader could have seen. See futureness() below.

        The local re-sort further down stays anyway. It is now a tiebreak
        rather than the ordering, and it costs nothing to keep the answer
        well-ordered whether or not a future Open Library honours `sort=`.

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
      sort: 'new',
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
    /* Point 2 above: `sort=new` already ordered these, so this is a tiebreak
       and a guard rather than the ordering itself. Nulls sort last rather than
       as year zero, because "no year recorded" is common and is not old. */
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

  /* ══ IS THIS WORK STILL AHEAD OF US? ════════════════════════════════════
     The Following page lists works whose publication date is after today, and
     this is the whole test. It lives here rather than in the view because it is
     a question about a catalogue record and not about a card — and because the
     alerts sweep asks the same question the day it grows a "coming up" feed.

     A DATE FROM OPEN LIBRARY IS A YEAR. That is the shape of the data, not a
     gap to be papered over, and it is verified: search.json returns
     `first_publish_year` and a `publish_year` array, both plain integers, and
     an edition's `publish_date` is free text that is almost always a bare year.
     So most releases here occupy a WINDOW rather than a point, and the honest
     test is about the two ends of that window:

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
     API, a 60-work page for each of Brandon Sanderson, Stephen King, Nora
     Roberts, James Patterson, Neil Gaiman and Ursula K. Le Guin contained ZERO
     works dated beyond the current year and between zero and six dated within
     it; the whole catalogue holds 18 works dated 2027 and 12 dated 2028, some
     of which are a Nepali Bikram Sambat year misread as Gregorian. Keeping it
     unlabelled would be worse: it would say "coming up" about a book that came
     out in March. So the view renders the year with the month and day HATCHED
     — the app's existing grammar for "this value cannot exist in the record" —
     and says so in words. Where a Google Books key is configured, sharpenYear()
     below turns a good share of these into real days and the maybe resolves.

     WHY THE LIST IS SHORT IS NOT A BUG AND MUST NOT BE FIXED BY WIDENING THIS.
     Open Library has no forthcoming-title concept at all: it catalogues books
     that exist. A filter that lets last year's reprints through to make the
     screen look busier is not a more generous version of this feature, it is
     the previous screen with a false heading on it. */

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
       future, and the request this answers was for "a publication date that is
       in the future from the current date". It is out; it is on a shelf in a
       shop this morning, and a search finds it. */
    if (end <= today) return 'past';
    return release.sortKey > today ? 'future' : 'maybe';
  }

  /* The release a search doc supports, and not one grain more.

     max(publish_year), NOT first_publish_year — and here that is not the same
     choice paintStrip makes for sorting, it is the only one that can work.
     first_publish_year is a computed minimum over every edition and is
     frequently decades early (The Alloy of Law, published 2011, reports 2001;
     verified), so a forthcoming reissue of an old novel would test as 1953 and
     be dropped. max(publish_year) is the newest printing anyone has catalogued,
     which is the one field in the response that can ever be ahead of today.

     A REPRINT COUNTS, and that is the user's own rule rather than an oversight:
     "i just want things listed with a publication date that is in the future
     from the current date". A 2027 reissue of a 1953 novel has a 2027
     publication date. The test is the date.

     `basis: 'work-first-published'` is the half-weight one, matching
     stubFromSearchDoc: the year is real, but a search doc names no edition, so
     the confidence should say the printing behind it is not identified. */
  function releaseOfWork(work) {
    const year = work && (work.latestYear || work.firstYear);
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
     or into a row this filter then correctly drops.

     KEY-GATED, AND THE GATE IS NOT A PREFERENCE. Anonymous access to the Books
     API answers HTTP 429 carrying `"quota_limit_value":"0"` — a quota of zero,
     not a quota you can exhaust — so a keyless request is not a degraded
     version of this, it is an error every single time. BT.googlebooks.enabled()
     is the gate, and nothing in this file builds a Google URL.

     THE MATCH RULES ARE BORROWED, NOT REWRITTEN. confidentMatch() and
     releaseFromVolume() come straight out of 25-googlebooks.js, so the year
     gate, the folded-title test and the shared-surname test are the same three
     the library's own date upgrade uses. A second, laxer copy of those rules is
     precisely how a stranger's publication date ends up on the reader's book —
     see the Hobbit measurement in that file, where two exact title-and-author
     matches are both catastrophically wrong dates. Only the query and the pick
     are local, because the caller here holds a search doc rather than a stored
     item and there is no item to merge into.

     SO IT CAN ONLY EVER SHARPEN, NEVER MOVE. The year gate refuses any volume
     whose year disagrees with the one we already hold, so the worst this can do
     is pick the wrong day inside the right year — which cannot resurrect a book
     from a past year, and cannot invent a future one.

     A PUBLISHER FOLLOW GETS NOTHING, deliberately. Its docs carry no author
     name (the field list is lean by design), the shared-surname test therefore
     cannot pass, and asking anyway would spend the reader's quota on a
     guaranteed refusal. */
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
         the heading "publishing soon", which is the exact lie this whole screen
         is being narrowed to stop telling. */
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
     the only thing standing between us and a wrong date. Same rule as
     25-googlebooks.js's own phrase(), which is private to that file; one line
     duplicated is a better trade than widening that module's surface. */
  function phrase(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim() + '"';
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
    /* The forthcoming test, exported as three separate pieces rather than one
       `isUpcoming(work)` boolean, because the caller needs all three answers:
       the release to RENDER, the verdict to LABEL, and the window end to
       explain itself. A boolean would collapse 'maybe' into one of its
       neighbours at the only point where the distinction is visible. */
    releaseOfWork, futureness, windowEnd, sharpenYear,
    /* Exposed so the sweep and the console can assert the invariants that
       cannot be seen from a stored row: how many follows one SWEEP may touch
       (the Following page is uncapped and deliberately so), where the baseline
       ceiling is, and how long a catalogue answer is reused for. */
    SWEEP_FOLLOWS, KNOWN_CAP, WORKS_TTL,
  };
})();
