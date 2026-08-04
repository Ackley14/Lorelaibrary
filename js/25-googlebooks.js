/* ══════════════════════════════════════════════════════════════════════════
   Google Books — the ONLY file that knows Google's URL shapes, and the reason
   the app asks for an API key at all.

   ── WHY THIS IS NOW THE PRIMARY SOURCE ────────────────────────────────────
   It used to be an enrichment path bolted onto Open Library. It is the other
   way round now, and the reversal is measured rather than felt. Against the
   live API with a real key:

     SEARCH RELEVANCE
       q=dune  ->  Frank Herbert's *Dune* at #1, correctly attributed.
       Open Library answers the same query with *Children of Dune* at #1, *Go
       Ask Alice* at #6, and the real novel eighth — credited to Brian Herbert
       and dated 2001.

     DATES
       Wind and Truth           -> '2024-12-06'
       The Haunting of Velkwood -> '2024-03-05'
       Project Hail Mary        -> '2021-05-04'
       Open Library answers 2024, 2024 and 2021. It is year-granular by
       construction — `search.json` returns `first_publish_year`, and an
       edition's `publish_date` is free text that is almost always a bare year
       (of twelve editions of The Hobbit, eleven read '2020', '1937', '2003'…,
       one carried a day, and it was in Portuguese). No parameter changes this.

     FORTHCOMING TITLES
       They exist here. They do not exist in Open Library AT ALL — no
       announcement flag, no street date, no publisher feed. This is the whole
       reason for the pivot: a reader following an author wants to know what is
       coming, and only one of the two catalogues can answer.

   ── WHAT GOOGLE CANNOT DO, AND WHY 20-openlibrary.js STAYS ────────────────
   NO WORK GRAPH. A volume id ('LLSpngEACAAJ') names ONE PRINTING. There is no
   editions-of-a-work endpoint, no work concept, and no way to ask "what other
   printings of this book exist" — so the "Specify edition" picker and the
   scanner's candidate-ISBN net are both structurally impossible here and both
   remain Open Library's job.

   NO AUTHOR IDS. An author is a bare NAME string. A follow keyed on a name is
   a follow that can silently watch the wrong person, which is why a follow
   record stores an Open Library OLID *and* Google's exact name spelling.

   ── AUTHOR QUERIES ARE UNRELIABLE IN BOTH CATALOGUES ──────────────────────
   Verified, and this is the sharpest edge in the file:

       inauthor:"Stephen King"   -> ZERO results
       inauthor:Kiste            -> 300 books about Queen Victoria
       "Gwendolyn Kiste"         -> her actual books

   Open Library is no better: `search.json?author=gwendolyn+kiste` returns
   Laird Barron's bibliography at HTTP 200. So NEITHER name-based author query
   may be trusted blindly. authorWorks() below queries on the plain quoted name
   and then CHECKS the credit on every volume it got back, because the query is
   a net and the check is the answer.

   ── THE `orderBy=newest` TRAP ─────────────────────────────────────────────
   It does not sort by publication date. It sorts by when Google added the
   RECORD. Observed publication years, in the order returned: 2023, 2020, 2024,
   2018. Anything that needs date order sorts client-side — sortByPublished().
   The parameter is still used, deliberately, as a second discovery ARM: a
   forthcoming title is by definition a recently-added record, so "newest
   record" is a good net for exactly the books relevance ranking buries.

   ── THE KEY GATE IS NOT A THROTTLE, IT IS AN ON/OFF SWITCH ────────────────
   Anonymous Google Books is DEAD. An unauthenticated volumes request answers
   HTTP 429 carrying `"quota_limit_value":"0"` — a quota of zero, not a quota
   we exhausted. Verified from two separate addresses. There is therefore no
   anonymous fallback to degrade to, and every entry point here returns before
   building a URL when `BT.config.hasKey('googlebooks')` is false. Firing the
   request anyway would spend a lane slot, a bucket token and a retry cycle to
   be told something already known, and four in a row would trip 05-net's
   circuit breaker for a source that is merely switched off.

   WITHOUT A KEY THE APP STILL WORKS. Every function here returns an EMPTY,
   WELL-SHAPED answer with `checked: false` on it rather than throwing, so a
   caller can tell "Google says there is nothing" from "Google was never
   asked" — which is the difference between telling a reader their author has
   nothing coming and telling them we could not check.

   NOTHING IS BAKED. The key comes from BT.config, which reads it from this
   browser's localStorage and nowhere else. This repository is public: a key
   written into any file here is a key published to the world within one
   commit. There is no constant in this file to "fill in".

   ── EVERYTHING GOES THROUGH BT.net ────────────────────────────────────────
   No fetch() here. 05-net owns the token bucket, the daily request budget
   (BT.NET_POLICY.googlebooks, deliberately well under Google's own 1,000/day),
   the circuit breaker, the retry policy and the response cache. It also strips
   `key=` before building a cache key, which is what stops a rotated key from
   orphaning every payload already paid for.
   ══════════════════════════════════════════════════════════════════════════ */

BT.googlebooks = (function () {

  const SOURCE = 'googlebooks';

  /* THE GATE. Read through this rather than calling BT.config directly, so
     that "is the Google half switched on" is one question with one answer and
     a future second condition (a user toggle, a region block) has one place
     to land. */
  function enabled() {
    return !!(BT.config && BT.config.hasKey(SOURCE));
  }

  /* ── URL builder ──────────────────────────────────────────────────────────
     `key` is appended by the builder rather than by each call site, because a
     call site that forgets it does not fail loudly — it gets a 429 with a zero
     quota, which reads exactly like being rate limited and sends the next
     person to tune the token bucket. One place to forget is no places.

     BT.net.qs drops empty values, so an absent key would silently produce a
     keyless URL; that is why every caller passes through enabled() first and
     why this throws rather than returning a URL it knows is dead. */
  function url(base, params) {
    const key = BT.config.key(SOURCE);
    if (!key) throw new Error('googlebooks: refusing to build a keyless URL');
    const q = BT.net.qs(Object.assign({}, params || {}, { key }));
    return q ? `${base}?${q}` : base;
  }

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

  /* Same rule as 20-openlibrary's orNull, and the same reason: "Google has no
     such volume" is an ANSWER and becomes null, while offline / 403 / quota
     stay exceptions so a caller can say "we could not check" instead of "there
     is nothing there". Collapsing both to null is how an outage comes to look
     like a catalogue gap. */
  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e && e.kind === 'notfound') return null;
      throw e;
    }
  }

  /* ══ TWO FIELD LISTS, AND THE CHOICE IS A BUDGET ═══════════════════════════
     Google supports partial responses through `fields`, and on the query this
     file makes most often it is worth an order of magnitude:

         20 results, full payload ......  41,827 bytes
         20 results, LEAN_FIELDS .......   4,873 bytes   (8.6x smaller)

     LEAN is what the DATE MATCHER reads and nothing more — confidentMatch()
     and volumeHasIsbn() together touch exactly these fields. It is the default
     for the enrichment path, which runs in the background over a whole library
     against a quota that belongs to the user.

     RICH is what a SCREEN reads: a search result the reader is about to look
     at, or an author's bibliography that has to render covers and dates. It is
     the 8.6x payload and it is correct to pay it there, because the
     alternative is a second request per row to fill in what the first one
     deliberately left out.

     `language` is in BOTH, and that is not an oversight. It is what BT.lang
     filters on, and a filter that has to fetch the field it filters on is not
     a filter — it is a second round trip per row. */
  const LEAN_FIELDS =
    'totalItems,items(id,volumeInfo(title,subtitle,authors,publishedDate,language,industryIdentifiers))';

  const RICH_FIELDS =
    'totalItems,items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,'
    + 'description,pageCount,categories,language,averageRating,ratingsCount,'
    + 'imageLinks,industryIdentifiers,previewLink))';

  /* ══ SEARCH ═════════════════════════════════════════════════════════════
     -> { items, totalItems, dropped, checked }

     `checked` is false ONLY when the Google half is switched off. Every caller
     that reports an absence to the reader has to be able to say which kind of
     absence it is, and an empty `items` array cannot carry that distinction.

     `printType: 'books'` is not tidiness. Without it the volumes index also
     returns magazines, and a magazine's `publishedDate` is an ISSUE date — a
     real, precise, completely wrong day to stamp on a novel that shares part
     of its title with a periodical.

     An empty result is `{"kind":"books#volumes","totalItems":0}` with NO
     `items` key at all, not an empty array and not a 404, so the absence has
     to be checked by hand. `totalItems` is an ESTIMATE over a loose match and
     is not a count of anything — a query that can only have one true answer
     routinely reports 300. Never branch on it.

     ── LANGUAGE ───────────────────────────────────────────────────────────
     Filtered HERE, client-side, through BT.lang — and deliberately NOT through
     Google's own `langRestrict=en`. langRestrict filters on a DECLARED value,
     so it drops every volume that declares nothing; and the volumes that
     declare nothing are disproportionately the thin, newly-catalogued records
     that a forthcoming title always is. Filtering server-side would therefore
     delete exactly the half of the index this app was pivoted to see.

     `opts.anyLanguage` turns it off, and only the IDENTITY paths pass it: an
     ISBN lookup and the date matcher both resolve a specific object the reader
     already has, and a reader holding a Spanish printing is still holding
     their own book. See the scan-exemption note in BT.lang. */
  async function search(q, opts) {
    opts = opts || {};
    const query = String(q == null ? '' : q).trim();
    if (!enabled() || !query) return { items: [], totalItems: 0, dropped: 0, checked: false };

    const data = await orNull(BT.net.get(SOURCE, url(BT.GB.volumes, {
      q: query,
      maxResults: BT.util.clamp(opts.limit || 20, 1, BT.GB.MAX_RESULTS),
      startIndex: (opts.offset || 0) || undefined,
      printType: 'books',
      /* Only ever 'newest', only ever from authorWorks, and never as a sort —
         see the trap note in the file header. */
      orderBy: opts.orderBy || undefined,
      fields: opts.fields || (opts.rich ? RICH_FIELDS : LEAN_FIELDS),
      /* THE DEFAULT TTL IS THE LONG ONE, and the asymmetry is deliberate.
         Most callers of this function are not asking a live question — they are
         looking up a fact about a book (a date to sharpen, a volume behind an
         ISBN) whose answer is a frozen artefact, and a short TTL there spends
         the user's own daily allowance re-learning it. The ONE caller that
         genuinely needs freshness is the search screen, and it is in this
         repository and passes `ttl: BT.TTL.gbSearch` itself.
         Defaulting the other way would silently cost quota in every module
         that reaches for this without thinking about caching — which is the
         failure mode a default should never have. */
    }), netOpts(opts, BT.TTL.gbVolume)));

    const raw = Array.isArray(data && data.items) ? data.items : [];
    if (opts.anyLanguage) {
      return { items: raw, totalItems: Number(data && data.totalItems) || raw.length, dropped: 0, checked: true };
    }
    const { kept, dropped } = BT.lang.keep(raw, BT.lang.acceptsVolume);
    return {
      items: kept,
      totalItems: Number(data && data.totalItems) || raw.length,
      dropped,
      checked: true,
    };
  }

  /* ══ BY ISBN ════════════════════════════════════════════════════════════
     -> a single volume that VERIFIABLY carries that ISBN, or null.

     `q=isbn:…` rather than any dedicated endpoint, because Google has none.

     AND `isbn:` IS NOT A FILTER. It is a hint to a relevance ranker, and the
     result set is padded with whatever else the ranker liked. Measured live:

         q=isbn:9781234567897  ->  totalItems 300, three items returned
                                   [1] Risk                 ISBN_13 9781234567897  ✓
                                   [2] Risk                 ISBN_13 9781234567897  ✓
                                   [3] Reading for Thinking ISBN_13 9780395782903  ✗

     The third row is a different book with a different ISBN, sitting in the
     answer to a query that named one. So the identifier is CHECKED rather than
     assumed — this is the arm whose answers are accepted WITHOUT corroboration,
     precisely because an ISBN is supposed to be exact identity, and an
     unverified items[0] would turn that trust into a mechanism for stamping a
     stranger's publication date onto the reader's book.

     RICH fields, because this is now a metadata path and not only a date one:
     a scanned barcode that resolves here should fill a pane.

     `anyLanguage`, because this is an IDENTITY path. The reader is holding
     this object. */
  async function byIsbn(isbn13, opts) {
    const isbn = cleanIsbn(isbn13);
    if (!enabled() || !isbn) return null;
    /* Three, not one: the true match is not reliably first, and the padding
       above shows up inside the first few rows rather than after them. */
    const res = await search(`isbn:${isbn}`,
      Object.assign({}, opts, { limit: 3, rich: true, anyLanguage: true, ttl: BT.TTL.gbVolume }));
    for (const vol of res.items) {
      if (volumeHasIsbn(vol, isbn)) return vol;
    }
    return null;
  }

  /* Does this volume actually claim that ISBN? `industryIdentifiers` is
     `[{ type, identifier }]` with types ISBN_10, ISBN_13, ISSN and OTHER; both
     ISBN types are widened to 13 so a record holding the ten-digit form still
     matches a scan of the barcode. A volume with no identifiers at all — some
     older Google records have none — answers false rather than being given the
     benefit of the doubt, because "we cannot tell" and "it matches" must not
     produce the same date on the reader's shelf. */
  function volumeHasIsbn(vol, isbn13) {
    const ids = (vol && vol.volumeInfo && vol.volumeInfo.industryIdentifiers) || [];
    for (const row of ids) {
      const t = row && row.type;
      if (t !== 'ISBN_10' && t !== 'ISBN_13') continue;
      if (cleanIsbn(row.identifier) === isbn13) return true;
    }
    return false;
  }

  /* Every ISBN-13 a volume claims, widened from the ten-digit form. A Google
     volume is ONE PRINTING, so this is normally one or two codes describing the
     same object — never the forty a work carries. That is why 38-normalize
     files them as CANDIDATES on an open item and never as an ownership claim:
     search-adding a book must not tell the scanner you own a copy. */
  function isbnsOf(vol) {
    const out = [];
    for (const row of ((vol && vol.volumeInfo && vol.volumeInfo.industryIdentifiers) || [])) {
      const t = row && row.type;
      if (t !== 'ISBN_10' && t !== 'ISBN_13') continue;
      const c = cleanIsbn(row.identifier);
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    return out;
  }

  /* ══ VOLUME ═════════════════════════════════════════════════════════════
     -> a single volume by its Google id, or null.

     Only reachable once a search has handed us that id — nothing in the app
     can guess one — so this exists for the refresh case: a record that already
     stores `ids.googlebooks` can be re-read for one request instead of
     re-running the match that found it.

     No language filter: an id names one object, and the caller already has it. */
  async function volume(id, opts) {
    const endpoint = BT.GB.volume(id);
    if (!enabled() || !endpoint) return null;
    const raw = await orNull(BT.net.get(SOURCE, url(endpoint, {}),
                                        netOpts(opts, BT.TTL.gbVolume)));
    return (raw && raw.id) ? raw : null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     AN AUTHOR'S BOOKS
     ══════════════════════════════════════════════════════════════════════════
     -> { works, volumes, totalItems, checked, credited, dropped }

     This is the Google half of "what is this author releasing", and the Open
     Library half is BT.openlibrary.authorWorks. NEITHER IS ALLOWED TO ANSWER
     ALONE — 70-follows unions them, because Google holds forthcoming titles
     Open Library has never heard of and Open Library holds a stable author id
     Google does not have. `checked` is what makes that union honest: a caller
     may only say "nothing scheduled" when BOTH sources answered.

     ── THE QUERY IS A NET, THE CREDIT CHECK IS THE ANSWER ──────────────────
     `inauthor:` is not usable. Measured:

         inauthor:"Stephen King"  ->  zero results
         inauthor:Kiste           ->  300 books about Queen Victoria
         "Gwendolyn Kiste"        ->  her actual books

     So the query is the plain quoted name, which is a free-text search and
     therefore also returns books ABOUT the person, books that mention them in
     a blurb, and anthologies they are not in. Every row is then checked
     against `volumeInfo.authors` by creditsAuthor(). The query widens, the
     check narrows, and the check is the part that decides.

     ── TWO ARMS, AND THE SECOND ONE IS THE POINT ───────────────────────────
     Arm 1 is relevance order — the author's known books.
     Arm 2 is `orderBy=newest`, which sorts by when Google ADDED THE RECORD and
     not by publication date (see the trap in the header). Used as a sort it is
     a bug; used as a NET it is exactly right, because a book announced for next
     spring is a record Google created recently and a record relevance ranking
     buries under thirty years of backlist. Without this arm, forthcoming titles
     for a prolific author are simply not in the first forty rows — which is the
     one thing this whole feature exists to find.

     Two requests per author per refresh. See the budget arithmetic in
     BT.NET_POLICY.

     ── PRINTINGS ARE COLLAPSED ─────────────────────────────────────────────
     Google has no work graph, so a prolific author's forty rows are routinely
     a dozen books in three printings each. groupPrintings() folds them by title
     and author, and keeps BOTH ends of the date range: `firstRaw` (the earliest
     printing, which is when the book came out) and `latestRaw` (the most recent
     printing, which is what "is something new arriving" is asked of). Neither
     alone is right — collapsing to the earliest hides a 2027 reissue, and
     collapsing to the latest claims a 1953 novel is new. */
  async function authorWorks(name, opts) {
    opts = opts || {};
    const person = String(name == null ? '' : name).trim();
    const empty = { works: [], volumes: [], totalItems: 0, checked: false, credited: 0, dropped: 0 };
    if (!enabled() || !person) return empty;

    const perPage = BT.util.clamp(opts.limit || BT.GB.MAX_RESULTS, 1, BT.GB.MAX_RESULTS);
    const q = phrase(person);
    const shared = {
      rich: true,
      limit: perPage,
      signal: opts.signal,
      meta: opts.meta,
      fresh: !!opts.fresh,
      ttl: opts.ttl != null ? opts.ttl : BT.TTL.gbAuthorWorks,
    };

    /* Serialized rather than raced. 05-net's lane for this source allows two,
       but a burst of two identical-shaped queries against a service that sheds
       load with 503s (see the retry note in BT.NET_POLICY) gets both of them
       retried; one at a time costs a little latency on a background refresh and
       nothing at all in reliability. */
    const byRelevance = await search(q, shared);
    /* Arm 2 is skipped when arm 1 was not answered at all, so a switched-off or
       budget-exhausted source spends one refusal rather than two. */
    const byNewest = byRelevance.checked
      ? await search(q, Object.assign({}, shared, { orderBy: 'newest' }))
      : { items: [], totalItems: 0, dropped: 0, checked: false };

    if (!byRelevance.checked) return empty;

    /* Union by volume id. The two arms overlap heavily for a small catalogue
       and barely at all for a large one, which is the whole reason arm 2 is
       worth its request. */
    const seen = new Set();
    const volumes = [];
    for (const vol of [].concat(byRelevance.items, byNewest.items)) {
      const id = vol && vol.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      volumes.push(vol);
    }

    const credited = volumes.filter(v => creditsAuthor(v, person));
    return {
      works: groupPrintings(credited),
      volumes: credited,
      totalItems: Math.max(byRelevance.totalItems || 0, byNewest.totalItems || 0),
      checked: true,
      credited: credited.length,
      dropped: (byRelevance.dropped || 0) + (byNewest.dropped || 0),
    };
  }

  /* Does this volume actually CREDIT that person as an author?

     Compared on `surname|first initial` rather than on the whole string,
     because the two catalogues and Google's own records disagree about
     initials and middle names far more often than about the family name:
     'J.R.R. Tolkien', 'J. R. R. Tolkien' and 'John Ronald Reuel Tolkien' are
     one author and three strings, and all three fold to `tolkien|j`.

     THE INITIAL IS REQUIRED WHEN BOTH SIDES HAVE ONE, and that is what keeps
     Tabitha King out of Stephen King's bibliography — a surname-only test
     would union two people's catalogues into one feed, which is the same class
     of failure as `inauthor:Kiste` answering with Queen Victoria. Where one
     side has no forename at all (a follow stored as a bare surname, a volume
     credited to 'Colette') the surname alone decides, because there is nothing
     finer to compare and refusing would lose the real author. */
  function creditsAuthor(vol, name) {
    const want = personKey(name);
    if (!want) return false;
    for (const credited of ((vol && vol.volumeInfo && vol.volumeInfo.authors) || [])) {
      if (personMatches(personKey(credited), want)) return true;
    }
    return false;
  }

  /* 38-normalize's, not this file's — the same fold that decides whether a
     Google row and an Open Library row are the same book also decides whether
     a volume credits the author we asked about. Two copies would be two answers
     to one question, and the disagreement would show up as an author whose
     bibliography is right on one screen and wrong on the next. */
  const personKey = n => (BT.normalize ? BT.normalize.personKey(n) : '');
  const personMatches = (a, b) => (BT.normalize ? BT.normalize.personMatches(a, b) : false);

  /* ── COLLAPSING PRINTINGS INTO BOOKS ─────────────────────────────────────
     Google's index is printings, not works. Folded by title + primary author,
     which is the same key BT.normalize.matchKey uses to merge a Google row
     against an Open Library one — one fold in the app, so a book that merges
     across sources also merges within a source.

     NOTHING IS BLENDED ACROSS PRINTINGS except the date range. It is tempting
     to fill a thin forthcoming record's missing cover and page count from its
     older siblings, and it would be wrong: ISBN, extent, cover art and
     publisher are properties of ONE printing, and a record assembled from
     several is a printing that does not exist. The representative volume is
     the most recently dated one — for "what is arriving", that is the row being
     asked about — and it supplies every field on its own.

     Both ends of the range are kept. See the note in authorWorks. */
  function groupPrintings(volumes) {
    const groups = new Map();
    for (const vol of (volumes || [])) {
      const info = (vol && vol.volumeInfo) || {};
      const key = BT.normalize.matchKey(info.title, info.authors);
      if (!key) continue;
      const rel = releaseFromVolume(vol);
      const row = groups.get(key);
      if (!row) {
        groups.set(key, { first: rel, last: rel, pick: vol, printings: 1 });
        continue;
      }
      row.printings++;
      /* An undated printing cannot move either end of the range, and must not
         be allowed to become the representative of a book that has a dated
         printing — that is how a forthcoming title loses its date. */
      if (!rel) continue;
      if (!row.first || rel.release.sortKey < row.first.release.sortKey) row.first = rel;
      if (!row.last || rel.release.sortKey > row.last.release.sortKey) { row.last = rel; row.pick = vol; }
      if (!row.pick) row.pick = vol;
    }

    const out = [];
    for (const row of groups.values()) out.push(shapeWork(row));
    return sortByPublished(out);
  }

  function shapeWork(row) {
    const vol = row.pick;
    const info = (vol && vol.volumeInfo) || {};
    const isbns = isbnsOf(vol);
    return {
      volumeId: (vol && vol.id) || '',
      title: String(info.title || '').trim(),
      subtitle: String(info.subtitle || '').trim(),
      authors: Array.isArray(info.authors) ? info.authors.slice() : [],
      publisher: String(info.publisher || '').trim(),
      description: String(info.description || ''),
      categories: Array.isArray(info.categories) ? info.categories.slice() : [],
      pageCount: Number(info.pageCount) || null,
      language: BT.lang.short(info.language),
      coverUrl: coverUrl(vol, 'md'),
      isbn13: isbns[0] || null,
      isbns,
      printings: row.printings,
      /* The RAW strings as well as the parsed releases, because the raw string
         is what the inspector shows when a precision is coarse and is the only
         way to tell '2027' from 'Fall 2027'. */
      firstRaw: row.first ? row.first.raw : '',
      latestRaw: row.last ? row.last.raw : '',
      firstRelease: row.first ? row.first.release : null,
      /* `release` is the LATEST printing's, which is the one "is something new
         arriving from this author" is asking about. A reprint counts — that is
         the reader's own rule, and a 2027 reissue of a 1953 novel has a 2027
         publication date. */
      release: row.last ? row.last.release : null,
    };
  }

  /* ══ SORTING BY PUBLICATION DATE ════════════════════════════════════════
     Exported, because `orderBy=newest` looks like it does this and does not —
     it orders by when Google added the record. Anything that needs date order
     calls this, over rows carrying a `release` built by the app's own date
     engine, so a 'YYYY' and a 'YYYY-MM-DD' sort against each other correctly
     instead of by string.

     Newest first. Undated rows sink to the bottom rather than being dropped:
     "we do not know when" and "it is not coming" are different facts, and a
     list that silently deleted the first would report a real book as missing. */
  function sortByPublished(rows) {
    const sk = r => {
      const v = r && r.release && r.release.sortKey;
      return Number.isFinite(v) ? v : -1;
    };
    return (rows || []).slice().sort((a, b) => {
      const ka = sk(a), kb = sk(b);
      if (ka < 0 && kb < 0) return 0;
      if (ka < 0) return 1;
      if (kb < 0) return -1;
      return kb - ka;
    });
  }

  /* ══ COVERS ═════════════════════════════════════════════════════════════
     Three corrections are applied inside BT.GB.cover and they are all
     load-bearing: the URL arrives as `http://` (blocked as mixed content on an
     https page), carries `edge=curl` (which draws a fake page curl into the
     pixels, server-side), and defaults to a ~128px `zoom=1`. Returns null when
     the volume carries no art, so a caller branches on the URL and never on the
     record. */
  function coverUrl(vol, size) {
    return BT.GB.cover(vol && vol.volumeInfo && vol.volumeInfo.imageLinks, size || 'md');
  }

  /* ══ TRANSIENT LOOKUP ═══════════════════════════════════════════════════
     -> a partial item for a `book:googlebooks:{id}` uid that is NOT in the
        library, or null.

     The inspector calls this when someone taps a search result or a Following
     card for a book they do not own — which is the ORDINARY path for a
     forthcoming title, since by definition nobody owns one yet. A tap must show
     the book and never add it, so this is read-only and writes nothing.

     Ids are ALPHANUMERIC with `-` and `_` ('LLSpngEACAAJ'). Never parseInt one. */
  const UID_RX = /^book:googlebooks:([A-Za-z0-9_-]+)$/;

  async function lookupUid(uid) {
    const m = UID_RX.exec(String(uid == null ? '' : uid).trim());
    if (!m || !enabled() || !BT.normalize) return null;
    const vol = await volume(m[1]);
    if (!vol) return null;
    const stub = BT.normalize.fromVolume(vol);
    if (!stub) return null;
    /* The caller navigated to this uid, so it is the identity the pane and the
       URL already agree on — keep it even if the normalizer would have minted a
       different one from the record it just read. */
    if (!stub.uid) stub.uid = uid;
    return stub;
  }

  /* ══ DIAGNOSTICS ════════════════════════════════════════════════════════
     -> { ok, ms, reason }   for the Settings panel's "Save & test".

     `noCache` and `ttl: 0` because a diagnostic that can be answered out of
     IndexedDB is not a diagnostic — a cached 200 from the PREVIOUS key would
     cheerfully report a revoked one as working, which is the exact failure
     somebody clicks this button to rule out.

     Dune's ISBN is the probe: one volume, ancient, and about as unlikely to
     leave the index as anything Google holds. */
  const PROBE_ISBN = '9780441013593';

  async function verifyKey() {
    if (!enabled()) {
      return { ok: false, reason: 'No key set. Search and dates fall back to Open Library, which is year-only.' };
    }
    const t0 = Date.now();
    try {
      const raw = await BT.net.get(SOURCE, url(BT.GB.volumes, {
        q: `isbn:${PROBE_ISBN}`, maxResults: 1, printType: 'books',
        fields: LEAN_FIELDS,
      }), { ttl: 0, noCache: true, staleOk: false });
      const ms = Date.now() - t0;
      /* `totalItems` is the proof, not `items`: a valid key against a query
         that matched nothing still answers with the field, and that is a
         working key. Requiring `items` would report a healthy key as broken
         the day Google reshuffles its index. */
      if (raw && typeof raw.totalItems === 'number') {
        return { ok: true, ms, reason: `Key works — Google answered in ${ms} ms.` };
      }
      return { ok: false, ms, reason: 'Google answered, but not with a volumes response.' };
    } catch (e) {
      const ms = Date.now() - t0;
      /* 05-net has already written a human sentence for every kind it
         classifies — a rejected key, a quota, an offline machine — so pass it
         through rather than paraphrasing it into something vaguer. The one
         thing worth adding is the commonest cause of a 403 on a key that the
         user just copied correctly: the Books API is not enabled on the
         project, or the key is referrer-restricted to a different origin. */
      const base = (e && e.message) || String(e);
      const hint = (e && (e.kind === 'auth'))
        ? ' Check that the Books API is enabled on the key’s Google Cloud project, '
          + 'and that any HTTP-referrer restriction on the key includes this site.'
        : '';
      return { ok: false, ms, kind: e && e.kind, reason: base + hint };
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE DATE UPGRADE PATH
     ══════════════════════════════════════════════════════════════════════════
     For records that already exist in the library and were created before
     Google was primary — a shelf full of Open Library work records with bare
     years on them. One job: turn a year into a month or a day, and never do
     anything else to the record. Every rule below exists because the
     alternative is worse than the coarse date we already have — a WRONG date is
     worse than a vague one, because a vague one is visibly vague.
     ══════════════════════════════════════════════════════════════════════════ */

  /* THE PRECISION FLOOR. Read through 38-normalize rather than kept here, so
     there is exactly one ladder in the codebase: the one pickRelease enforces
     when it merges. A private copy would be free to drift, and the symptom of
     drift is silent — this file would start paying for lookups whose answers
     the merge then discards, and nothing would report it. */
  const rank = p => (BT.normalize ? BT.normalize.precisionRank(p) : 0);
  const YEAR_RANK = 1;

  /* Is there anything here worth spending a request on?

     This is the FIRST of the two never-downgrade guarantees and the cheap one:
     if the record already states a month or a day, we do not ask. The second
     is structural and lives in pickRelease, which refuses a coarser payload
     however confident it claims to be. Policy here, invariant there — both,
     because a policy can be edited by somebody who has not read the invariant.

     Also declined:

       · a release the reader corrected by hand. mergeItem restores manual
         overrides on top of everything anyway, so the request could only ever
         be paid for and then thrown away.
       · a record we already asked about recently and could not improve. This
         is the difference between a library that costs a handful of requests
         and one that re-learns "Google also only has 1965" every time a pane
         opens. See BT.TTL.gbDateRecheck. */
  function needsDateUpgrade(item, opts) {
    opts = opts || {};
    if (!enabled() || !item || !BT.normalize) return false;

    const rel = item.release;
    if (!rel) return false;
    if (rank(rel.precision) > YEAR_RANK) return false;

    /* mergeItem discards any payload with no title, so a titleless record
       could be asked about, matched and merged — and then silently keep none
       of it, including the check stamp that stops us asking again tomorrow.
       Refused here so the request is never spent. */
    if (!item.title) return false;

    const ov = (item.meta && item.meta.manualOverrides) || {};
    for (const path of Object.keys(ov)) {
      if (path === 'release' || path.indexOf('release.') === 0) return false;
    }

    if (opts.force) return true;
    const stamp = (item.meta && item.meta.gbDate) || null;
    if (stamp && stamp.checkedAt
        && Date.now() - stamp.checkedAt < BT.TTL.gbDateRecheck) return false;

    return true;
  }

  /* -> a NEW item with the better date merged in, or null when nothing was
        done (switched off, nothing to gain, or the lookup failed).

     The caller writes. This adapter never touches BT.repo — same rule
     20-openlibrary.js holds to, and for the same reason: merging, re-tiering
     and persisting are the caller's business, so the "views and sync go
     through BT.repo" rule survives all the way down.

     A non-null return ALWAYS deserves a write, even when no better date was
     found, because the check stamp is itself the thing worth keeping — it is
     what stops the next pane-open asking again. `meta.gbDate.upgraded` says
     which of the two happened. */
  async function upgradeItemDate(item, opts) {
    opts = opts || {};
    if (!needsDateUpgrade(item, opts)) return null;

    let hit = null;
    try {
      hit = await findVolumeFor(item, opts);
    } catch (e) {
      /* Enrichment is a nicety and must never be the reason a detail pane
         fails to paint. Swallowed here rather than at the call sites so that
         every caller gets the same behaviour, and logged so a broken key or a
         spent budget is still findable in the console. Deliberately NOT
         stamped as "checked": a request that failed is not evidence that
         Google has nothing, and recording it as one would blind this book to
         enrichment for a month over a transient outage. */
      console.warn('[googlebooks] date lookup failed for', item && item.uid, e && e.message);
      return null;
    }

    const stamp = {
      checkedAt: Date.now(),
      volumeId: (hit && hit.volume && hit.volume.id) || null,
      via: hit ? hit.via : null,           // 'isbn' | 'title' | null
      found: hit ? (hit.raw || '') : '',
      upgraded: 0,
    };

    const partial = {
      /* mergeItem discards any payload with no title — a shell of a record is
         not a record — so the title has to travel even though this path never
         changes it. It is the existing one, not Google's: Google's title is a
         match signal, never an edit. */
      title: item.title,
      meta: { gbDate: stamp },
    };

    if (hit && hit.release && rank(hit.release.precision) > rank(item.release.precision)) {
      stamp.upgraded = 1;
      partial.release = hit.release;
      if (stamp.volumeId) partial.ids = { googlebooks: stamp.volumeId };
    }

    return BT.normalize.mergeItem(item, partial);
  }

  /* ── Finding the right volume ────────────────────────────────────────────
     -> { volume, release, raw, via } or null.

     TWO ARMS, and they are trusted very differently.

     ISBN — exact identity. One barcode names one printing, so whatever date
     Google holds for it is a date about the object the reader is holding, and
     it is accepted as-is. Only PINNED ISBNs are used, never candidates: a
     candidate is a possibility harvested off an editions page (see the
     pinned/candidate note in 38-normalize.js), and dating a work by a randomly
     chosen printing out of that list is how a 1937 novel acquires a 2020 date
     that looks authoritative.

     TITLE + AUTHOR — a guess, and treated as one. See confidentMatch(): it has
     to agree on the folded title, share an author surname, AND land in the
     same year we already hold. That last condition is the load-bearing one:
     it means this arm can only ever refine a year into a month or a day, and
     can never move the year itself. The worst case it can produce is the right
     year with the wrong day — bad, but bounded — instead of a confidently
     stated date for a different book with a similar name.

     THE HOBBIT IS THE PROOF, and it is not hypothetical. Measured live:

         intitle:"The Hobbit" inauthor:"J. R. R. Tolkien"
           -> "The Hobbit"            J.R.R. Tolkien      1986-07-12
           -> "The Hobbit"            J. R. R. Tolkien    2026-03-26
           -> "The History of the Hobbit"                 2023-05-16

     Every one of those is a real Tolkien record, the top two match the title
     and the author exactly, and both would be a catastrophic date to stamp on
     a 1937 novel — one is a reprint, the other has not been published yet.
     Without the year gate this arm confidently "upgrades" The Hobbit to July
     1986. With it, all three are refused and the record keeps its honest 1937.

     Which is also why an item with no year at all does not get the title arm.
     There is nothing to corroborate against, and an uncorroborated title match
     is exactly the wrong date this whole function exists to avoid.

     `anyLanguage` on both arms: this is an owned record being enriched, not a
     discovery surface, and a reader's Spanish paperback still deserves its real
     publication date. */
  async function findVolumeFor(item, opts) {
    const pinned = Array.isArray(item.isbnsPinned) ? item.isbnsPinned : [];
    for (const raw of pinned) {
      const vol = await byIsbn(raw, opts);
      const rel = releaseFromVolume(vol);
      if (rel) return { volume: vol, release: rel.release, raw: rel.raw, via: 'isbn' };
      /* One pinned ISBN is the normal case. A record with several is a book
         the reader owns in two printings, and asking Google about all of them
         would spend a request per printing to answer one question — so the
         first that resolves wins and the rest are left alone. */
      if (vol) break;
    }

    const year = storedYear(item);
    if (!year) return null;

    const title = String(item.title || '').trim();
    const authors = (item.authors || []).map(a => a && a.name).filter(Boolean);
    /* No author on the record means no corroboration is possible, and a title
       alone is not enough: "Beginnings", "The Gift" and "Home" are each dozens
       of different books. Skipped rather than guessed. */
    if (!title || !authors.length) return null;

    /* TWENTY ROWS, NOT FIVE, AND IT COSTS NOTHING EXTRA. `maxResults` changes
       the size of one response, not the number of requests, so the only price
       is payload — which the lean field list above already cut by 8.6x.

       Five was not enough, measured. Google ranks a popular title by edition
       recency, so the FIRST printing — the one whose year an Open Library
       record actually holds — is buried:

           intitle:"Project Hail Mary" inauthor:"Andy Weir"
             top 5 years:  2025 2022 2024 2026 2025
             all 11 years: 2025 2022 2024 2026 2025 2026 2022 2021 2021 2021 —

       The 2021-05-04 hardcover we are trying to sharpen sits at position
       eight. At `maxResults: 5` the year gate correctly refused every row and
       the book kept its bare '2021' for ever; at twenty it finds the real one.
       The gate is what makes widening the window SAFE — more rows can only mean
       more chances to match the year we already trust, never a looser match. */
    const res = await search(
      `intitle:${phrase(title)} inauthor:${phrase(authors[0])}`,
      Object.assign({}, opts, { limit: 20, anyLanguage: true, ttl: BT.TTL.gbVolume }));

    let best = null;
    for (const vol of res.items) {
      if (!confidentMatch(item, vol, year)) continue;
      const rel = releaseFromVolume(vol);
      if (!rel) continue;
      /* Finest wins; among equally fine ones the EARLIEST date wins. An open
         item is a WORK — "Dune", not the 1990 Ace paperback — so when Google
         offers three printings from the same year, the first of them is the
         answer to "when did this book come out". */
      if (!best
          || rank(rel.release.precision) > rank(best.release.precision)
          || (rank(rel.release.precision) === rank(best.release.precision)
              && rel.release.sortKey < best.release.sortKey)) {
        best = { volume: vol, release: rel.release, raw: rel.raw, via: 'title' };
      }
    }
    return best;
  }

  /* Google's `publishedDate` -> { release, raw }, or null when the volume has
     no date at all.

     Parsed through BT.normalize.buildRelease — which runs the app's ONE date
     engine — rather than a private `new Date(...)`. That engine normalises free
     text down to 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' and then runs the same
     placeholder ladder, the same Jan-1 demotion for unpublished titles and the
     same TBA rule as every other date in the app. Google's three ISO shapes are
     the easy end of what it already handles, and routing them through it is what
     guarantees a Google date and an Open Library date sort, render and hatch
     identically.

     `new Date('2021-05-04')` would also have parsed it, and would have parsed
     it as UTC midnight — which is May 3rd for every reader west of Greenwich.
     The precision engine never constructs a Date for exactly that reason. */
  function releaseFromVolume(vol) {
    const info = (vol && vol.volumeInfo) || null;
    const raw = info && info.publishedDate;
    if (!raw) return null;
    const release = BT.normalize.buildRelease(String(raw), {
      basis: 'googlebooks-published',
      source: SOURCE,
      /* A volume in Google's index is a book that exists, so an unparseable
         date still means "published" rather than "unannounced". */
      inPrint: true,
    });
    if (release.sortKey >= BT.util.SK_UNKNOWN) return null;
    return { release, raw: String(raw) };
  }

  /* ── The match test ──────────────────────────────────────────────────────
     All three conditions, or no match. Written as three explicit tests rather
     than a score with a threshold, because a threshold is a number somebody
     lowers when a book they know about fails to match, and the failure mode of
     lowering it is a date silently attached to the wrong book. */
  function confidentMatch(item, vol, year) {
    const info = (vol && vol.volumeInfo) || null;
    if (!info) return false;

    /* 1. THE YEAR MUST AGREE with what we already hold. This is what bounds
          the damage of a bad title match to "right book, wrong printing"
          instead of "wrong book entirely", and it is why this arm can only
          ever sharpen a date rather than move it. */
    const parts = BT.util.parseNaive(naiveOf(info.publishedDate));
    if (!parts || parts.y !== year) return false;

    /* 2. THE TITLE MUST FOLD TO THE SAME STRING. Compared both against
          Google's bare title and against title + subtitle, because the two
          catalogues disagree about where a colon goes: Open Library stores
          'Leviathan Wakes' where Google stores title 'Leviathan Wakes' with
          subtitle 'Book One of the Expanse', and elsewhere stores the whole
          thing in `title`. */
    const ours = fold(item.title);
    if (!ours) return false;
    const theirs = fold(info.title);
    const theirsFull = fold([info.title, info.subtitle].filter(Boolean).join(' '));
    if (ours !== theirs && ours !== theirsFull) return false;

    /* 3. AN AUTHOR SURNAME MUST BE SHARED. Surnames rather than full names
          because the two catalogues disagree about initials and middle names
          far more often than they disagree about the family name. */
    const mine = surnames((item.authors || []).map(a => a && a.name));
    const yours = surnames(info.authors || []);
    if (!mine.size || !yours.size) return false;
    for (const s of mine) if (yours.has(s)) return true;
    return false;
  }

  /* ── Small helpers ───────────────────────────────────────────────────── */

  /* The stored year, or null. Read off the sort key rather than off
     `release.raw`, because raw is the cataloguer's original free text and the
     sort key is what the precision engine actually concluded from it. */
  function storedYear(item) {
    const sk = item && item.release && item.release.sortKey;
    const p = (sk != null) ? BT.util.sortKeyToParts(sk) : null;
    return (p && p.y) ? p.y : null;
  }

  function naiveOf(raw) {
    return raw == null ? '' : (BT.util.olDateToNaive(String(raw)) || '');
  }

  /* Title and surname folds are 38-normalize's, not this file's, so that a
     book which merges across the two sources folds the same way it does when
     two Google printings merge against each other. Two folds is two answers to
     "is this the same book", and the disagreement shows up as a duplicate row
     nobody can explain. Delegated rather than copied for the same reason
     `precisionRank` is. */
  const fold = s => (BT.normalize ? BT.normalize.foldTitle(s) : '');
  const surnames = names => (BT.normalize ? BT.normalize.surnameSet(names) : new Set());

  /* A quoted phrase for `intitle:` / `inauthor:` and for a plain name query.
     Embedded quotes are replaced rather than escaped: Google's query grammar
     has no escape sequence, so a stray quote inside the phrase closes it early
     and silently widens the search into an unrelated result set. */
  function phrase(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  }

  /* Normalize to a 13-digit ISBN, or ''. Widens the ten-digit form rather than
     rejecting it — BT.util.isbn10to13 knows about the mod-11 'X' check
     character that a naive digit-strip destroys. */
  function cleanIsbn(v) {
    const raw = String(v == null ? '' : v).toUpperCase().replace(/[^0-9X]/g, '');
    if (raw.length === 13) return /^\d{13}$/.test(raw) ? raw : '';
    if (raw.length === 10) return BT.util.isbn10to13(raw) || '';
    return '';
  }

  return {
    enabled,
    search, byIsbn, volume, authorWorks,
    coverUrl, isbnsOf, volumeHasIsbn,
    lookupUid,
    verifyKey,
    needsDateUpgrade, upgradeItemDate,
    sortByPublished,
    /* Exposed so tests and the Settings diagnostics can assert the rules that
       cannot be seen from a response: that no URL leaves here without a key,
       that the match test refuses the near-misses it is supposed to, and that
       the author credit check keeps Tabitha King out of Stephen King's feed. */
    url, confidentMatch, releaseFromVolume, fold, surnames,
    creditsAuthor, personKey, groupPrintings, phrase,
    LEAN_FIELDS, RICH_FIELDS,
  };
})();
