/* ══════════════════════════════════════════════════════════════════════════
   Open Library — the ONLY file that knows Open Library's URL shapes.

   MovieTrak's 20-tmdb.js opens by checking for a key, because without one
   nothing works. There is no such gate here and that is the whole reason
   BookTrak needs no setup: search, works, editions, authors and covers are all
   keyless, unauthenticated GETs. What replaces the key gate is a much longer
   list of measured quirks, because Open Library is generous and old and its
   data model shows every year of it.

   FIVE things in this file are load-bearing. Each was verified against the
   live API, each fails SILENTLY when broken, and each will be "cleaned up" by
   the next person who does not know:

   1. NEVER send `sort=` alongside a free-text `q`. It does not error — it
      DISCARDS the query. `?q=dune&sort=editions` answers HTTP 200 with
      Robinson Crusoe. `sort=new` is safe only on an `?author=` query, where
      there is no `q` for it to eat. See authorWorks().

   2. NEVER request `isbn` or `edition_key` on a search. Measured: 889 bytes
      for five docs without them, 19,853 bytes with — a 22x blowup, because one
      popular work carries 722 ISBNs. The lean field list in SEARCH_FIELDS is a
      budget, not a preference.

   3. Open Library's own relevance is broken and the caller MUST re-rank.
      Live `q=dune`: Children of Dune is #1, Go Ask Alice is #6, and the only
      doc actually titled "Dune" is #8 — attributed to Brian Herbert, dated
      2001. This adapter returns the docs in the order Open Library sent them,
      on purpose: ranking is a view concern and lives in
      BT.util.rankByRelevance. Map `edition_count` onto `pop` before calling
      it, or the tiebreak inside a relevance band silently does nothing.

   4. Field presence on edition docs is wildly inconsistent. Across three real
      ISBNs only `key`, `works`, `title`, `publishers`, `publish_date` and
      `covers` were present every time; `number_of_pages` 2/3, `authors` 1/3,
      and `isbn_13` 2/3 — one lookup BY ISBN-13 came back with no `isbn_13`
      field at all. So: guard every accessor, and NEVER round-trip the scanned
      ISBN through the response. The ISBN you scanned is the ISBN you have.

   5. Text fields are `string` OR `{ type, value }`, and works and editions
      disagree about the same field. Every read goes through BT.util.olText or
      the item page renders '[object Object]'.

   ── Errors ────────────────────────────────────────────────────────────────
   Open Library stops speaking JSON the moment anything goes wrong: a missing
   ISBN is an HTML page with HTTP 404, a maintenance window is an HTML page
   with a 503. 05-net checks `res.ok` and the content-type before ever calling
   `.json()`, so what arrives here is a classified NetError. This file's job is
   to turn exactly ONE of those kinds — 'notfound' — into `null`, and to let
   every other kind through untouched. That distinction is the whole point:
   "Open Library has no record of this barcode" and "you are offline" must
   never render as the same sentence, and collapsing both to null is how they
   do.

   ── No headers. None. ─────────────────────────────────────────────────────
   Nothing here passes `headers`, and nothing here may. Open Library answers
   OPTIONS with the NON-STANDARD singular `access-control-allow-method`; the
   browser looks for the spec's plural `access-control-allow-methods`, does not
   find it, and fails the preflight. So a single custom header — a contact
   address, an Accept, anything — promotes these simple GETs into preflighted
   ones that never leave the machine. Verified. 05-net enforces this too
   (NO_CUSTOM_HEADERS), belt and braces, because the failure looks like the API
   went down rather than like a header was added.
   ══════════════════════════════════════════════════════════════════════════ */

BT.openlibrary = (function () {

  /* ── URL builder ───────────────────────────────────────────────────────
     Every path constant lives in BT.OL (00-config.js) so that the endpoints
     are readable in one place; this only assembles the query string. BT.net.qs
     drops undefined/null/'' entries, which is why the optional params below
     are written as `x || undefined` rather than guarded with an if — an
     `offset=0` that is sent rather than omitted is harmless to the server but
     mints a second cache key for an identical request. */
  function url(endpoint, params) {
    const q = BT.net.qs(params || {});
    return q ? `${endpoint}?${q}` : endpoint;
  }

  /* Shared plumbing for every call. Note what is NOT here: `headers`. See the
     preflight note in the header — this object is deliberately unable to carry
     one, so adding a header means editing this function and reading that
     comment on the way past. */
  function netOpts(opts, ttl) {
    opts = opts || {};
    return {
      ttl: opts.ttl != null ? opts.ttl : ttl,
      noCache: !!opts.fresh,
      cacheOnly: !!opts.cacheOnly,
      staleOk: opts.staleOk,
      signal: opts.signal,
      meta: opts.meta,
    };
  }

  /* "No such record" is an ANSWER, not a fault — Open Library simply has no
     row for that ISBN or OLID, which is a thing the user needs told plainly.
     Everything else (offline, 503, maintenance, a captive portal) is a
     FAILURE, and must keep travelling as an exception so the caller can say
     "we could not check" instead of "we do not have it".

     Getting this backwards is the single most damaging bug available in this
     file: a `catch (_) { return null; }` here would make every outage look
     like a library that has never heard of the book in your hand. */
  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e && e.kind === 'notfound') return null;
      throw e;
    }
  }

  /* Open Library merges duplicate records constantly — it is a volunteer
     catalogue and deduplication is most of the maintenance work. A merged
     record can come back as a `/type/redirect` DOCUMENT (HTTP 200, with a
     `location` field) rather than an HTTP redirect, so fetch() cannot follow
     it and the caller receives a perfectly valid JSON object with no title, no
     authors and no subjects. One hop, resolved here, so no caller has to know.
     One hop only: a redirect chain that loops would otherwise spin. */
  function redirectTargetOf(raw) {
    const t = raw && raw.type && (raw.type.key || raw.type);
    if (t !== '/type/redirect') return '';
    return BT.util.olid(raw.location || '');
  }

  /* Accept both spellings of a cover size. The public signature is Open
     Library's own 'S' | 'M' | 'L' (contract), while BT.OL.SIZES is keyed
     'sm' | 'md' | 'lg' for the UI. One of those was always going to reach the
     wrong function, so both are understood and neither is right. */
  const SIZE_KEYS = {
    s: 'sm', m: 'md', l: 'lg',
    sm: 'sm', md: 'md', lg: 'lg',
    small: 'sm', medium: 'md', large: 'lg',
  };
  function sizeKey(size) {
    return SIZE_KEYS[String(size == null ? 'M' : size).toLowerCase()] || 'md';
  }

  /* Normalize whatever the caller has into a 13-digit ISBN, or ''. Widens an
     ISBN-10 rather than rejecting it: the ten-digit form is what is printed on
     a copyright page, so it is what somebody types when the barcode is torn,
     and BT.util.isbn10to13 already knows about the mod-11 'X' check character
     that a naive digit-strip destroys. */
  function cleanIsbn(v) {
    const raw = String(v == null ? '' : v).toUpperCase().replace(/[^0-9X]/g, '');
    if (raw.length === 13) return /^\d{13}$/.test(raw) ? raw : '';
    if (raw.length === 10) return BT.util.isbn10to13(raw) || '';
    return '';
  }

  /* M1 reads an edition's OLID under two different names — BT.repo.idKeysFor
     writes `ids.olEdition`, BT.ui.posterUrl reads `ids.editionOlid`. Tolerate
     both here rather than declare a winner from the adapter; 38-normalize owns
     which one is written. */
  function editionOlidOf(item) {
    const ids = (item && item.ids) || {};
    return BT.util.olid(ids.olEdition || ids.editionOlid || '');
  }

  /* ══ SEARCH ═════════════════════════════════════════════════════════════
     -> { docs: [rawDoc], numFound, offset }

     THE LEAN FIELD LIST. `fields` is not tuning, it is the difference between
     a search that works on a phone and one that does not:

         5 docs, this list ......................    889 bytes
         5 docs, + isbn + edition_key ...........  19,853 bytes   (22x)

     because Open Library returns EVERY ISBN of EVERY edition of every match,
     and one popular work carried 722 of them. Whatever you are about to add
     `isbn` for, `editionsOfWork()` answers properly for the single work the
     user picked, at one request instead of on every keystroke.

     NO `sort=`. Not 'editions', not 'rating', not 'new'. With a free-text `q`
     the sort parameter silently DISCARDS the query and returns an unrelated
     result set at HTTP 200 — `?q=dune&sort=editions` answers with Robinson
     Crusoe. There is no error to catch and nothing in the response says the
     query was ignored, so this is invisible in review and obvious to the user.
     The ONLY safe use of sort= is on an `?author=` query, which has no `q` at
     all; that is authorWorks(), and it is commented there.

     Results come back in Open Library's order and are NOT re-ranked here —
     see point 3 in the file header. They are close to useless as sent. */
  const SEARCH_FIELDS = [
    'key', 'title', 'author_name', 'author_key', 'first_publish_year', 'cover_i',
    'edition_count', 'readinglog_count', 'want_to_read_count',
    'ratings_average', 'ratings_count', 'language',
  ].join(',');

  async function search(q, opts) {
    opts = opts || {};
    const query = String(q == null ? '' : q).trim();
    /* An empty `q` is not an empty result to Open Library, it is a request for
       the entire catalogue — the most expensive query the service has, on the
       endpoint they most ask us not to hammer. Answer it locally. */
    if (!query) return { docs: [], numFound: 0, offset: 0 };

    const limit = BT.util.clamp(opts.limit || BT.LIMITS.searchResults, 1, 100);
    const offset = Math.max(0, opts.offset || 0);

    const data = await BT.net.get('openlibrary', url(BT.OL.search, {
      q: query,
      fields: SEARCH_FIELDS,
      limit,
      offset: offset || undefined,
      /* Language filtering is OPT-IN and off by default, even though a
         language is always set in BT.config. Open Library matches this against
         the EDITION language codes attached to a work, and a work whose
         editions were catalogued without one matches nothing — so switching it
         on globally quietly deletes results rather than narrowing them. The
         config setting stores the short form ('en'); the widening to the
         MARC code the API wants ('eng') happens here, at the one place that
         talks to the API, so no other file has to learn a source's vocabulary. */
      language: opts.language ? marcLang(opts.language) : undefined,
    }), netOpts(opts, BT.TTL.search));

    const docs = Array.isArray(data && data.docs) ? data.docs : [];
    return {
      docs,
      numFound: Number(data && data.numFound) || docs.length,
      offset,
    };
  }

  /* 'en' -> 'eng'. Only the languages the app's settings can produce plus the
     handful that turn up in hand-edited exports; anything already three
     letters is passed through, because that is already what the API wants. */
  const MARC_LANG = {
    en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por',
    nl: 'dut', ru: 'rus', ja: 'jpn', zh: 'chi', ko: 'kor', sv: 'swe',
    da: 'dan', no: 'nor', fi: 'fin', pl: 'pol', cs: 'cze', tr: 'tur',
    ar: 'ara', he: 'heb', la: 'lat', el: 'gre',
  };
  function marcLang(code) {
    const c = String(code || '').toLowerCase().slice(0, 3);
    if (c.length === 3) return c;
    return MARC_LANG[c] || '';
  }

  /* ══ THE SCAN HOT PATH ══════════════════════════════════════════════════
     -> a /api/books record, or null.

     `/api/books?bibkeys=ISBN:…&format=json&jscmd=data` is ONE request that
     already carries author NAMES and cover URLs inline. The obvious
     alternative is worse by a wide margin:

         /api/books ..... 1 request, names and covers included
         /isbn/ ......... 2 requests (it is a 302), authors arrive as
                          [{ key: '/authors/OL…A' }] — so one MORE request per
                          author before anything can be shown

     At Open Library's ~1 request/second that is the difference between a scan
     resolving while the user is still holding the book and a scan resolving
     after they have put it down. The scan view uses this one.

     THE COST: /api/books exposes NO WORK KEY. There is no `works` array and no
     `/works/OL…W` anywhere in the payload, so it cannot bootstrap the Work
     graph — no subjects, no other editions, no "more by this author", no way
     to widen a scanned copy into the work it belongs to. `editionByIsbn()` is
     the function that does that, and it is why both exist.

     TWO response shapes, and the second one is the trap: the payload is a map
     keyed by the LITERAL string 'ISBN:9780441172719', so reaching for `.title`
     on it gets undefined; and an unknown ISBN answers HTTP 200 with `{}` —
     an empty object, NOT a 404 — so `res.ok` proves nothing here and the
     emptiness has to be checked by hand. Both are handled below.

     `/api/books` is assembled from BT.OL.base rather than read from BT.OL:
     00-config.js lists the record endpoints, and this is a query API sitting
     beside them. */
  async function byIsbn(isbn13, opts) {
    const isbn = cleanIsbn(isbn13);
    if (!isbn) return null;
    const bibkey = `ISBN:${isbn}`;

    const data = await orNull(BT.net.get('openlibrary', url(`${BT.OL.base}/api/books`, {
      bibkeys: bibkey,
      format: 'json',
      jscmd: 'data',
    }), netOpts(opts, BT.TTL.edition)));

    if (!data || typeof data !== 'object') return null;
    const rec = data[bibkey];
    /* `{}` — a real, cacheable answer meaning the catalogue has no such ISBN.
       Not an error, and not something to retry. */
    if (!rec || typeof rec !== 'object') return null;
    return rec;
  }

  /* ══ THE WORK-GRAPH BOOTSTRAP ═══════════════════════════════════════════
     -> a raw edition doc (with `works[].key`), or null.

     `/isbn/{isbn}.json` is a 302 to `/books/OL…M.json`. fetch() follows it for
     us, so from in here it looks like one round trip — but Open Library served
     TWO and its rate limiter counted two. BT.net.costOf() spots the `/isbn/`
     path and charges the bucket accordingly; undercounting by half on the most
     used endpoint in a barcode app is how you get throttled and never work out
     why.

     A MISS IS NOT JSON. An ISBN Open Library does not hold answers HTTP 404
     with `content-type: text/html` and a rendered "not found" PAGE. Hand that
     body to `.json()` and you get a bare SyntaxError — indistinguishable from
     a truncated download — and the user is told "malformed response" when the
     truth is "we don't have that book". 05-net checks `res.ok` and the
     content-type BEFORE parsing for exactly this reason; orNull() then turns
     the resulting 'notfound' into the null this function documents.

     Use this when the Work graph is needed — subjects, other editions, more by
     the author. Use byIsbn() when a scan needs to resolve NOW. */
  async function editionByIsbn(isbn13, opts) {
    const isbn = cleanIsbn(isbn13);
    if (!isbn) return null;
    const raw = await orNull(BT.net.get('openlibrary', BT.OL.isbn(isbn),
                                        netOpts(opts, BT.TTL.edition)));
    /* Guard `key`: a redirect document or a stub row is a 200 with nothing
       usable in it, and every downstream reader assumes an edition has one. */
    if (!raw || !raw.key) return null;
    return raw;
  }

  /* ══ WORK ═══════════════════════════════════════════════════════════════
     -> a raw work doc, or null.

     The work is the BOOK as a reader means it — "Dune", not the 1990 Ace
     paperback. It is where `subjects` and `description` live; editions
     overwhelmingly carry neither.

     `first_publish_year` is NOT here and must not be treated as authoritative
     wherever it is: The Alloy of Law (2011) reports 2001. Label it "first
     recorded" and prefer an attached edition's own `publish_date`. */
  async function work(olid, opts) {
    const id = BT.util.olid(olid);
    if (!id) return null;
    let raw = await orNull(BT.net.get('openlibrary', BT.OL.work(id),
                                      netOpts(opts, BT.TTL.work)));
    const to = redirectTargetOf(raw);
    if (to && to !== id) {
      raw = await orNull(BT.net.get('openlibrary', BT.OL.work(to),
                                    netOpts(opts, BT.TTL.work)));
    }
    return (raw && raw.key) ? raw : null;
  }

  /* ══ EDITIONS OF A WORK ═════════════════════════════════════════════════
     -> { size, entries, offset, hasMore }

     PAGING IS `offset`, AND ONLY `offset`. There is no `page` parameter; pass
     one and it is ignored, so you page forever over the first fifty rows and
     the loop looks like it is working. The page size is 50 whatever you ask
     for below that, hence the clamp.

     THE 0.48 MB TRAP: `?limit=1000` genuinely works and genuinely returns
     everything — for The Hobbit that is all 481 editions in a single 0.48 MB
     payload. It must never appear in an interactive path; it is a background
     job at best, which is what `opts.bulk` marks. The default ceiling stays at
     50 so nobody reaches for the big number by accident.

     WHAT THE NUMBERS ACTUALLY MEAN, measured on The Hobbit: 481 entries
     yielding 310 distinct ISBN-13s. 30% of entries carry no `isbn_13` and 13%
     carry no ISBN of any kind. So an editions list is not a list of barcodes
     and `entries.length` is not a count of copies you could scan.

     `hasMore` is derived from `offset + entries.length < size` rather than
     from `links.next`, because `links` is not always present — but `size` is
     absent often enough to need its own fallback, and the fallback deliberately
     reports "no more" rather than guessing a total. */
  async function editionsOfWork(olid, opts) {
    opts = opts || {};
    const id = BT.util.olid(olid);
    const offset = Math.max(0, opts.offset || 0);
    if (!id) return { size: 0, entries: [], offset, hasMore: false };

    const ceiling = opts.bulk ? 1000 : 50;
    const limit = BT.util.clamp(opts.limit || BT.LIMITS.editionsPerWork, 1, ceiling);

    const raw = await orNull(BT.net.get('openlibrary', url(BT.OL.editions(id), {
      limit,
      offset: offset || undefined,
    }), netOpts(opts, BT.TTL.editionsList)));

    const entries = (raw && Array.isArray(raw.entries)) ? raw.entries : [];
    let size = Number(raw && raw.size);
    if (!Number.isFinite(size) || size < 0) size = offset + entries.length;
    return { size, entries, offset, hasMore: offset + entries.length < size };
  }

  /* ══ AUTHORS ════════════════════════════════════════════════════════════ */

  /* -> a raw author doc, or null. `bio` is one of the string-OR-{type,value}
     fields (contract #8) — read it with BT.util.olText(), never directly. */
  async function author(olid, opts) {
    const id = BT.util.olid(olid);
    if (!id) return null;
    let raw = await orNull(BT.net.get('openlibrary', BT.OL.author(id),
                                      netOpts(opts, BT.TTL.author)));
    const to = redirectTargetOf(raw);          // authors get merged even more than works
    if (to && to !== id) {
      raw = await orNull(BT.net.get('openlibrary', BT.OL.author(to),
                                    netOpts(opts, BT.TTL.author)));
    }
    return (raw && raw.key) ? raw : null;
  }

  /* -> [{ olid, name, birthDate, deathDate, topWork, workCount, topSubjects,
           alternateNames, photoUrl }]

     TWO quirks, both of which produce a picker full of dead rows:

     1. THE BARE OLID. `/search/authors.json` is the ONLY endpoint in the whole
        API that returns `key: 'OL1394865A'` instead of `key:
        '/authors/OL1394865A'`. Code that slices off a leading '/type/' — which
        is correct everywhere else — turns that into '4865A' and then 404s on
        every follow-up. BT.util.olid() exists for this one endpoint; it
        matches the id wherever it sits in the string.

     2. `work_count === 0` rows are duplicate author records left behind by a
        merge: a real name, a real OLID, and nothing attached. They rank
        alongside the live record and are indistinguishable in a list, so they
        are dropped here. A row with the field MISSING is kept — absent is not
        zero, and guessing the other way hides real authors. */
  async function searchAuthors(q, opts) {
    opts = opts || {};
    const query = String(q == null ? '' : q).trim();
    if (!query) return [];

    const data = await BT.net.get('openlibrary', url(BT.OL.searchAuthors, {
      q: query,
      limit: BT.util.clamp(opts.limit || 20, 1, 100),
    }), netOpts(opts, BT.TTL.search));

    const docs = Array.isArray(data && data.docs) ? data.docs : [];
    const rows = docs.map(d => {
      const id = BT.util.olid(d && d.key);
      return {
        olid: id,
        name: (d && d.name) || '',
        birthDate: (d && d.birth_date) || '',
        deathDate: (d && d.death_date) || '',
        topWork: (d && d.top_work) || '',
        workCount: (d && d.work_count != null) ? Number(d.work_count) : null,
        topSubjects: Array.isArray(d && d.top_subjects) ? d.top_subjects : [],
        alternateNames: Array.isArray(d && d.alternate_names) ? d.alternate_names : [],
        /* Portraits live under /a/ rather than /b/ and take the same
           ?default=false treatment — without it a photo-less author renders a
           43-byte transparent GIF that <img onerror> never catches. */
        photoUrl: id ? BT.OL.authorPhoto(id, 'sm') : null,
      };
    }).filter(a => a.olid && a.name && a.workCount !== 0);

    /* The same author can appear twice under two spellings of the same OLID
       once the bare-id normalisation has run. */
    return BT.util.uniqBy(rows, a => a.olid);
  }

  /* ══ AN AUTHOR'S BIBLIOGRAPHY ═══════════════════════════════════════════
     -> { docs, numFound }

     THIS USES SEARCH, NOT `/authors/{id}/works.json`, AND THAT IS THE WHOLE
     FEATURE. The dedicated endpoint looks like the right one and is not:

       · it carries NO publication dates — no `first_publish_year`, no
         `publish_year`, nothing datable at all — so "new from your authors"
         has nothing to sort by and nothing to filter to "this year";
       · it is ordered by RECORD EDIT TIME, so the top of the list is whichever
         work a volunteer last touched. A 1962 novel re-catalogued yesterday
         outranks the book that came out last month.

     Together those are the difference between a working "new from the authors
     you follow" view and one that is permanently empty while appearing to
     work — it returns plenty of rows, they are just the wrong rows in the
     wrong order with no dates on them.

     `sort=new` IS SAFE HERE, and only here. The prohibition in the file header
     is about sort= eating a free-text `q`; this query has no `q` at all — it
     is a pure `?author=` filter — so there is nothing for the sort to discard.
     Do not add a `q` to this function. */
  const AUTHOR_WORK_FIELDS = 'key,title,first_publish_year,publish_year,cover_i';

  async function authorWorks(olid, opts) {
    opts = opts || {};
    const id = BT.util.olid(olid);
    if (!id) return { docs: [], numFound: 0 };

    const data = await BT.net.get('openlibrary', url(BT.OL.search, {
      author: id,
      sort: 'new',
      fields: AUTHOR_WORK_FIELDS,
      limit: BT.util.clamp(opts.limit || BT.LIMITS.authorWorks, 1, 100),
      offset: (opts.offset || 0) || undefined,
    }), netOpts(opts, BT.TTL.search));

    const docs = Array.isArray(data && data.docs) ? data.docs : [];
    return { docs, numFound: Number(data && data.numFound) || docs.length };
  }

  /* ══ COVERS ═════════════════════════════════════════════════════════════
     TWO verified traps, both of which produce a UI that looks broken in a way
     that is very hard to trace back to this function. Both are enforced inside
     BT.OL.cover(); they are restated here because this is the entry point
     everyone will actually call, and because the next person to "simplify"
     will find a bare covers.openlibrary.org URL shorter and reach for it.

     1. `?default=false` IS MANDATORY. Without it, asking for a cover that does
        not exist returns HTTP 200 and a 43-BYTE TRANSPARENT GIF. The image
        LOADS — successfully — so <img onerror> NEVER FIRES, so the generated
        placeholder never replaces it, and a grid fills with invisible tiles
        that the user reads as "the app failed". With the parameter the same
        request 404s and onerror does its job.

     2. `covers` arrays contain -1. It is a SENTINEL meaning "a cover record
        existed and was removed", not an id, and it appears MID-ARRAY as often
        as first. Passing it through builds .../b/id/-1-M.jpg. Filter to
        `id > 0` — BT.OL.usableCovers() does exactly that and should be used
        wherever a raw `covers` array is read.

     Returns null rather than a broken URL when there is nothing to ask for, so
     callers branch on the URL and never on the id. */
  function coverUrl(coverId, size) {
    return BT.OL.coverById(coverId, sizeKey(size));   // null for the -1 sentinel
  }

  /* Cover by ISBN. Resolves server-side to whichever edition Open Library
     holds art for, which for a scanned copy is the reader's actual book.
     Sanitised to the ISBN alphabet because this value lands in a URL PATH,
     where a stray character is not escaped for us. */
  function coverUrlForIsbn(isbn, size) {
    const clean = String(isbn == null ? '' : isbn).toUpperCase().replace(/[^0-9X]/g, '');
    if (clean.length !== 10 && clean.length !== 13) return null;
    return BT.OL.coverByIsbn(clean, sizeKey(size));
  }

  /* ══ DIAGNOSTICS ════════════════════════════════════════════════════════
     -> { ok, ms, detail?, reason?, kind? }   for the Settings panel.

     There is no key to verify — that is the point of Open Library — so the
     only question is whether the service is answering. Asked with ONE small
     record fetch rather than a search: Open Library explicitly asks not to be
     used as a backend for automated traffic and search.json is their most
     expensive endpoint, so spending one on a health check would be both rude
     and slow.

     OL27482W is Dune's work record: small, ancient, and about as unlikely to
     be merged away as anything in the catalogue. `noCache` because a
     diagnostic that can be satisfied from IndexedDB is not a diagnostic.

     The covers host is NOT probed here. covers.openlibrary.org is a separate
     service on a separate quota (100 requests per IP per 5 minutes) and serves
     images, not JSON — routing one through BT.net would fail at `.json()` and
     report a parse error for a perfectly healthy server. Covers reach the page
     as <img src>, which never passes through the net layer at all. */
  const PROBE_WORK = 'OL27482W';

  async function verifyReachable() {
    const t0 = Date.now();
    try {
      const raw = await BT.net.get('openlibrary', BT.OL.work(PROBE_WORK), {
        ttl: 0, noCache: true, staleOk: false,
      });
      const ms = Date.now() - t0;
      if (raw && raw.key) {
        return { ok: true, ms, detail: `Open Library answered in ${ms} ms. No key needed.` };
      }
      return {
        ok: false, ms,
        reason: 'Open Library answered, but not with a record we recognise.',
      };
    } catch (e) {
      const ms = Date.now() - t0;
      if (e && e.kind === 'notfound') {
        /* SOMETHING answered — but not with the record. Two very different
           causes and no way to tell them apart from here: Open Library merged
           or removed the probe record, or a captive portal (hotel, airport
           wifi) is answering every request on this machine with its own login
           page — 05-net reports a 200 carrying HTML as 'notfound' too, because
           a web page is not a record. Neither is "reachable" in any useful
           sense, and both need a human to look. */
        return {
          ok: false, ms, kind: e.kind,
          reason: 'Something answered but did not return a catalogue record. '
                + 'Either the probe record has been merged away, or a network '
                + 'sign-in page is intercepting requests from this browser.',
        };
      }
      /* 05-net has already written a human sentence for every other kind —
         offline, maintenance, timeout — so pass it straight through rather
         than paraphrasing it into something vaguer. */
      return { ok: false, ms, kind: e && e.kind, reason: (e && e.message) || String(e) };
    }
  }

  /* ══ M1 SEAMS ═══════════════════════════════════════════════════════════
     Two functions M1 wrote itself against and feature-detects until this file
     exists. Their contracts are quoted verbatim in the files that call them:

       BT.ui.hydrate()             (50-ui-core.js) -> BT.openlibrary.hydrate
       inspector fetchTransient()  (56-inspector.js) -> BT.openlibrary.lookupUid

     Both return item FIELDS and nothing more. Merging, defaulting, re-tiering
     and writing stay with the caller, so this adapter never touches BT.repo
     and the "views and sync go through BT.repo" rule holds all the way down.
     Every field shape comes from BT.normalize; this file decides only WHICH
     requests to make. */

  /* Harvest ISBN-13s out of an editions page.

     Two-thirds of the work here is the shortfall: 30% of entries carry no
     `isbn_13` and 13% carry no ISBN at all, so widening the ten-digit form is
     not tidiness — it is the difference between 310 usable barcodes and rather
     fewer. Each is checksum-verified before it is kept, because a candidate
     ISBN that does not check is a row in the scan index that can never match
     anything and will never be noticed. */
  function harvestIsbn13s(entries) {
    const out = [];
    for (const e of (entries || [])) {
      for (const raw of ((e && e.isbn_13) || [])) {
        const c = String(raw || '').replace(/\D/g, '');
        if (c.length === 13 && BT.util.isValidEan13(c)) out.push(c);
      }
      for (const raw of ((e && e.isbn_10) || [])) {
        const c = BT.util.isbn10to13(raw);
        if (c) out.push(c);
      }
    }
    return [...new Set(out)];
  }

  /* -> a partial item, or null. Never throws for "no record"; a genuine
     failure (offline, 503) still throws, because BT.ui.hydrate must be able to
     leave the existing record alone rather than overwrite it with a guess. */
  async function hydrate(item, opts) {
    opts = opts || {};
    /* 38-normalize owns every field shape produced below. If it is not on the
       page there is nothing this function could return that a caller could
       safely merge, and returning raw Open Library JSON would be worse than
       returning nothing. */
    if (!item || !BT.normalize) return null;

    const ids = item.ids || {};
    const workId = BT.util.olid(ids.olWork || '');
    const isbn = cleanIsbn(ids.isbn13);

    return item.scope === 'closed'
      ? hydrateClosed(item, workId, isbn, opts)
      : hydrateOpen(item, workId, opts);
  }

  /* CLOSED — one specific physical copy, normally arrived at by scanning it.
     The edition record is the authority for what is in the reader's hands
     (publisher, printing, page count, format) and the work record is the
     authority for what the book IS (subjects, description). Neither alone
     fills a pane, so both are fetched and the EDITION wins the overlap. */
  async function hydrateClosed(item, workId, isbn, opts) {
    let ed = isbn ? await editionByIsbn(isbn, opts) : null;

    /* No ISBN, or Open Library holds no ISBN for this printing — 13% of The
       Hobbit's editions have none — but the row that created this item may
       still have carried the edition's own OLID. */
    const edOlid = editionOlidOf(item);
    if (!ed && edOlid) {
      ed = await orNull(BT.net.get('openlibrary', BT.OL.edition(edOlid),
                                   netOpts(opts, BT.TTL.edition)));
    }

    /* An edition names its work; a work never names "the" edition. This is the
       one direction the graph travels, and it is the reason editionByIsbn()
       exists alongside the cheaper byIsbn(). */
    const wid = workId || (ed && Array.isArray(ed.works) && ed.works.length
      ? BT.util.olid(ed.works[0] && ed.works[0].key)
      : '');
    const w = wid ? await work(wid, opts) : null;

    const base = w ? BT.normalize.fromWork(w) : null;
    const top = ed ? BT.normalize.fromEdition(ed) : null;

    if (!base && !top) {
      /* Last resort, and a good one: /api/books needs no work graph and no
         edition record, carries author names and a cover URL inline, and
         answers in a single request. It is the only thing that can still fill
         a pane when the edition record itself has gone. */
      const rec = isbn ? await byIsbn(isbn, opts) : null;
      return rec ? BT.normalize.fromApiBooks(rec, isbn) : null;
    }

    const merged = (base && top) ? BT.normalize.mergeItem(base, top) : (top || base);

    /* `description` and `first_sentence` are the string-OR-{type,value} pair,
       and works and editions disagree about which shape they use for the SAME
       field. olText() or the item page prints '[object Object]' — which does
       ship, because it only appears on the records where the work had no
       description of its own. */
    if (merged && !merged.description && ed) {
      const d = BT.util.olText(ed.description) || BT.util.olText(ed.first_sentence);
      if (d) merged.description = d;
    }
    return merged;
  }

  /* OPEN — a work, with no edition chosen. The user meant "Dune", not the 1990
     Ace paperback, so nothing here may pin an edition. */
  async function hydrateOpen(item, workId, opts) {
    if (!workId) return null;
    const w = await work(workId, opts);
    if (!w) return null;

    const fresh = BT.normalize.fromWork(w);
    if (!fresh) return null;

    /* ONE page of editions — fifty rows, one request — purely to fill
       `isbnsCandidate`. Those become `isbncand:` rows in BT.repo, which is
       what lets a later scan say "you already have an unspecified copy of this
       book, is this the one?" instead of silently adding a duplicate.

       CANDIDATES, never pinned: an open item claiming forty ISBNs in the
       `isbn13:` namespace would answer "already owned" to every printing of
       every book the user ever searched for, and no scan could ever add a
       second copy. See the id-namespace note in 12-repo.js.

       One page and stop. `?limit=1000` would return all 481 of The Hobbit's
       editions in a 0.48 MB response, on the path that runs immediately after
       every single add. Failure here is swallowed on purpose: the work record
       is already in hand and is the thing the user is waiting to see, and a
       missing candidate list costs a duplicate-scan prompt, not a broken add. */
    if (opts.editions !== false) {
      try {
        const page = await editionsOfWork(workId, {
          offset: 0,
          limit: BT.LIMITS.editionsPerWork,
          signal: opts.signal,
          ttl: BT.TTL.editionsList,
        });
        const found = harvestIsbn13s(page.entries);
        if (found.length) {
          const prev = Array.isArray(item.isbnsCandidate) ? item.isbnsCandidate : [];
          fresh.isbnsCandidate = [...new Set([].concat(prev, found))];
        }
      } catch (e) {
        console.warn('[openlibrary] editions page failed; candidates unchanged', e);
      }
    }
    return fresh;
  }

  /* -> a partial item for a uid that is NOT in the library, or null.

     The inspector calls this when someone follows a link to a book they do not
     own. The uid grammar is fixed by the M2 contract —
     `book:openlibrary:{OLID}` or `book:isbn:{isbn13}` — and is read off the
     string here rather than through BT.normalize.parseUid(), because this only
     needs the two fields the grammar itself guarantees and a stale link is not
     worth coupling a second module's return shape to.

     Ids are ALPHANUMERIC. Never parseInt an OLID; 'OL27482W' is not a number
     and the digits alone name a different record. */
  const UID_RX = /^book:(openlibrary|isbn):([A-Za-z0-9]+)$/;

  async function lookupUid(uid) {
    const m = UID_RX.exec(String(uid == null ? '' : uid).trim());
    if (!m || !BT.normalize) return null;
    const kind = m[1];
    const id = m[2];
    let stub = null;

    if (kind === 'openlibrary') {
      /* An OLID's LAST LETTER is its type: W work, M edition, A author.
         /works/OL…M.json is a 404 every time, so dispatch on it rather than
         assuming a work — a uid minted from a scanned edition is a perfectly
         ordinary thing to be handed. */
      if (/M$/i.test(id)) {
        const ed = await orNull(BT.net.get('openlibrary', BT.OL.edition(BT.util.olid(id)),
                                           netOpts(null, BT.TTL.edition)));
        stub = (ed && ed.key) ? BT.normalize.fromEdition(ed) : null;
      } else {
        const w = await work(id);
        stub = w ? BT.normalize.fromWork(w) : null;
      }
    } else {
      const isbn = cleanIsbn(id);
      if (!isbn) return null;
      /* /api/books first for the same reason the scan path uses it: one
         request, author names and a cover URL already inline. Only if the
         catalogue has no such ISBN there do we spend the two-hop /isbn/
         lookup, which occasionally holds a record /api/books does not. */
      const rec = await byIsbn(isbn);
      if (rec) {
        stub = BT.normalize.fromApiBooks(rec, isbn);
      } else {
        const ed = await editionByIsbn(isbn);
        stub = ed ? BT.normalize.fromEdition(ed) : null;
      }
    }

    if (!stub) return null;
    /* The caller navigated to this uid, so it is the identity the pane and the
       URL already agree on — keep it even if the normalizer would have minted
       a different one from the record it just read. */
    if (!stub.uid) stub.uid = uid;
    return stub;
  }

  return {
    search, byIsbn, editionByIsbn, work, editionsOfWork,
    author, searchAuthors, authorWorks,
    coverUrl, coverUrlForIsbn,
    verifyReachable,
    hydrate, lookupUid,
    /* Exposed so tests and the Settings diagnostics can assert the two rules
       that cannot be seen from a response: that the field list stayed lean,
       and that no URL this module builds carries a `sort=` next to a `q=`. */
    url, SEARCH_FIELDS, AUTHOR_WORK_FIELDS, marcLang,
  };
})();
