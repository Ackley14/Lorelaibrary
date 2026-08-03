/* ══════════════════════════════════════════════════════════════════════════
   Normalization — the single choke point where a remote payload may become a
   stored item. Nothing outside this file is allowed to read a raw Open Library
   response into a record.

   MovieTrak had four SOURCES to reconcile. BookTrak has one source and four
   SHAPES, which is harder, because they all look plausible and none of them
   agrees with the others about anything:

     search doc     lean, work-level, no ISBNs (asking for them is a 22x
                    payload blowup — see 20-openlibrary.js), a `first_publish_year`
                    that is frequently wrong, and relevance ordering that has to
                    be thrown away and recomputed.
     work doc       subjects and description, author KEYS but never author
                    NAMES, no publisher, no page count, no ISBN.
     edition doc    the physical artefact: publisher, extent, format, ISBNs —
                    and again author keys only. Field presence is wildly
                    inconsistent; across three real ISBNs only key, works,
                    title, publishers, publish_date and covers were ALWAYS
                    present, and one lookup BY ISBN-13 came back with no
                    `isbn_13` field at all.
     /api/books     the same edition, but with author names and cover URLs
                    inline, which is why it is the scan path's first choice.
                    It carries no work key, so it cannot reach the work.

   Three things in here are load-bearing and are commented where they happen:

   1. IDENTITY. `book:<source>:<id>` — three parts, never two. `parseUid`
      rejoins everything after the second colon, which is what keeps
      alphanumeric OLIDs (`OL27482W`) and 13-digit ISBNs safe. The uid is
      immutable once assigned: it is the foreign key in snapshots, the feed,
      the URL, and every id-index row.

   2. PINNED vs CANDIDATE ISBNs. `isbnsPinned` is an OWNERSHIP CLAIM;
      `isbnsCandidate` is a list of POSSIBILITIES. They go to different id
      namespaces and conflating them silently destroys the scanner. See the
      block above `pinnedIsbns`.

   3. DATES. Open Library's publish dates are free text typed by cataloguers
      over five decades ('1991', 'c1991', '[1991]', 'Sept 2012', 'Mar 06, 2012',
      '19uu'). They go through BT.util.parseOpenLibraryDate and then the same
      precision ladder MovieTrak used, so `BT.ui.dateField` works unchanged and
      a year-precision book can never render a day. `release.type` is always
      null — a book has no theatrical/digital/limited window to choose between —
      and `release.status` has exactly three rungs: unannounced, announced,
      published.
   ══════════════════════════════════════════════════════════════════════════ */

BT.normalize = (function () {

  /* One kind, always. MovieTrak needed `kind` in the uid because TMDB's movie
     and TV id spaces overlap completely; here it is a constant, kept in the uid
     anyway so parseUid's three-part contract holds for both apps and so a
     future 'periodical' or 'comic' does not need a migration. */
  const KIND = 'book';

  const uidOf = (source, id) => `${KIND}:${source}:${id}`;

  /* Splits on ':' and rejoins the remainder. That last part is not stylistic:
     ids here are ALPHANUMERIC OLIDs and 13-digit ISBNs, and a two-part split
     would truncate anything containing a colon the day one appears. */
  function parseUid(uid) {
    const [kind, source, ...rest] = String(uid).split(':');
    return { kind, source, id: rest.join(':') };
  }

  const olid = k => BT.util.olid(k);
  const text = v => BT.util.olText(v);

  function slug(s) {
    let t = String(s == null ? '' : s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  const arr = v => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  /* Page counts and extents: 0 and null both mean "not recorded", never "zero
     pages". Emitting 0 would survive the merge prune and blank a good figure. */
  const posInt = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  /* ══ RELEASE ══════════════════════════════════════════════════════════════
     Precision is first class, and there is deliberately no `release.date`
     field anywhere in the app — a bare date invites `if (item.release.date)`,
     which erases the difference between "no date" and "sometime in 1991".

     Books lean on this harder than films did. A majority of a real library
     resolves to YEAR precision, so the hatched date field is the normal
     rendering rather than the degraded one. */

  const STATUS_RANK = { unannounced: 1, announced: 2, published: 5 };

  const CONFIDENCE = { day: 1, month: 0.8, quarter: 0.6, year: 0.4, tba: 0.1, unknown: 0.1 };

  /* How much to trust the FIELD the date came out of, independent of how
     precise that field was.

     `first_publish_year` is halved because it is verifiably unreliable: Open
     Library reports 2001 for The Alloy of Law, which was published in 2011, and
     the "Dune" search doc is attributed to Brian Herbert with the year 2001.
     It is a computed minimum over a work's edition records, so a single
     mis-catalogued reprint drags it back decades. It is worth recording — it is
     often the only date a search result carries — but it is never authoritative,
     and an edition-level `publish_date` supersedes it the moment one is pinned.
     `pickRelease` below is where that supersession actually happens. */
  const BASIS_FACTOR = {
    'edition-published': 1,
    'work-first-published': 0.5,
    'none': 1,
  };

  function emptyRelease(status) {
    return {
      status: status || 'unannounced',
      precision: 'unknown',
      raw: '', display: 'No date',
      sortKey: BT.util.SK_UNKNOWN,
      confidence: 0.1, inferred: 0,
      region: BT.config.get('region') || 'US',
      /* Always null. MovieTrak used this to tell a theatrical window from a
         digital one; a book publishes once, per edition, and the edition IS the
         record. Kept in the shape so BT.ui and the date engine stay identical
         between the two apps. */
      type: null,
      basis: 'none',
      statusRank: STATUS_RANK.unannounced,
      windows: [], history: [],
    };
  }

  /* `opts`:
       basis     'edition-published' | 'work-first-published' | 'none'
       status    force the ladder rung (rare; normally derived below)
       inPrint   the record proves a physical artefact exists, so an
                 UNPARSEABLE date still means "published" rather than
                 "unannounced". This rescues the '19uu' and 'n.d.' half of the
                 backlist, which would otherwise file under Still to come.
       tba       hand through to the precision engine */
  function buildRelease(rawDate, opts) {
    opts = opts || {};

    /* Two passes, and the second one is the whole reason this is not a
       one-liner. The Jan-1/Dec-31 placeholder demotion in derivePrecision only
       fires when `released === false`, and we cannot know that until we have
       parsed the date. So: parse once neutrally, and if the answer lands in the
       FUTURE, parse again with the demotion on.

       Which is exactly the right centre of gravity for books. A forthcoming
       title carrying "January 1, 2027" is a retailer placeholder meaning
       "sometime next year" and must not read as a street date. The same
       January 1 on a 1953 novel is simply the catalogue date we actually have,
       and demoting the entire backlist to year precision would throw away
       thousands of genuine days. */
    let der = BT.util.parseOpenLibraryDate(rawDate, { tba: opts.tba });
    let sk = BT.util.sortKeyOf(der.parts, der.precision);
    if (sk < BT.util.SK_UNKNOWN && sk > BT.util.todaySortKey()) {
      der = BT.util.parseOpenLibraryDate(rawDate, { tba: opts.tba, released: false });
      sk = BT.util.sortKeyOf(der.parts, der.precision);
    }

    const rel = emptyRelease();
    rel.precision = der.precision;
    rel.inferred = der.inferred;
    /* The ORIGINAL free text is kept. For films this was an ISO string and
       worthless; here it is the difference between "we read 1991 off the page"
       and "we recovered 1991 from 'Repr. 1991, 1st ed. 1965'", and the
       inspector shows it when the precision is coarse. */
    rel.raw = rawDate == null ? '' : String(rawDate);
    rel.sortKey = sk;
    rel.display = BT.util.displayRelease(der.parts, der.precision);
    rel.basis = opts.basis || 'none';
    rel.confidence = (CONFIDENCE[der.precision] || 0.1)
      * (BASIS_FACTOR[rel.basis] != null ? BASIS_FACTOR[rel.basis] : 1);
    rel.region = opts.region || BT.config.get('region') || 'US';
    rel.type = null;

    if (opts.status) rel.status = opts.status;
    else if (sk < BT.util.SK_UNKNOWN) {
      rel.status = sk <= BT.util.todaySortKey() ? 'published' : 'announced';
    } else {
      rel.status = opts.inPrint ? 'published' : 'unannounced';
    }
    rel.statusRank = STATUS_RANK[rel.status] != null ? STATUS_RANK[rel.status] : 1;
    return rel;
  }

  /* Which of two releases describes the book better.

     This is where "prefer the edition once one is pinned" is enforced, and it
     is a comparison of CONFIDENCE rather than of freshness on purpose. A work
     refresh that arrives after an edition has been pinned carries
     `first_publish_year` — half-weighted, usually year-precision, and
     frequently a decade wrong — and letting the newer payload win would replace
     "Aug 1, 1990" with "1965" every time the record was swept. Freshness is the
     right rule for a source that corrects itself; Open Library's work-level year
     does not correct itself, it is a different and worse question.

     `history` always comes from the incumbent: drift is a property of the
     record, not of the payload that happened to arrive last. */
  function pickRelease(existing, fresh) {
    const history = (existing && existing.history) || [];
    const keep = r => Object.assign({}, r, { history });
    if (!fresh) return existing ? keep(existing) : emptyRelease();
    if (!existing) return keep(fresh);
    const fDated = fresh.sortKey < BT.util.SK_UNKNOWN;
    const eDated = existing.sortKey < BT.util.SK_UNKNOWN;
    if (fDated && !eDated) return keep(fresh);
    if (!fDated && eDated) return keep(existing);
    /* Both dated, or neither: the more trustworthy one wins, ties to the fresh
       payload so a genuine upstream correction at equal confidence still lands. */
    return keep((fresh.confidence || 0) >= (existing.confidence || 0) ? fresh : existing);
  }

  /* ══ SUBJECTS AND GENRE BUCKETS ══════════════════════════════════════════
     Open Library `subjects` are not a taste vocabulary. They are whatever fell
     out of a MARC record, an Internet Archive ingest or a bestseller-list
     scrape, and a large share of them describe the SCAN rather than the BOOK.
     BT.SUBJECT_STOPLIST and BT.SUBJECT_STOPLIST_RX drop that layer; what
     survives is used twice, for two different jobs, and the two must not be
     confused:

       bucketGenres()  → at most three of the twelve display buckets. Coarse,
                         for chips and facets.
       cleanSubjects() → the FULL filtered list, kept on the item and fed to
                         rec.terms. Fine-grained, and the actual taste signal —
                         'Dune (Imaginary place)' and 'Ecology in literature'
                         say vastly more about a reader than 'Fantasy & SF'. */

  function cleanSubjects(subjects) {
    const out = [];
    const seen = new Set();
    for (const raw of arr(subjects)) {
      /* Three shapes in the wild: a bare string (work docs), `{ name, url }`
         (/api/books), and `{ key }` (a few older records). */
      const name = typeof raw === 'string' ? raw : (raw && (raw.name || raw.key));
      if (!name) continue;
      const s = String(name).trim().replace(/\s+/g, ' ');
      /* An 80-character "subject" is a sentence out of a summary field that
         somebody pasted into the wrong box. It is never a heading, and it
         poisons the genre matcher because a long enough string matches
         something eventually. */
      if (!s || s.length > 80) continue;
      const low = s.toLowerCase();
      if (BT.SUBJECT_STOPLIST.has(low)) continue;
      if (BT.SUBJECT_STOPLIST_RX.some(rx => rx.test(s))) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(s);
    }
    return out;
  }

  /* Map noisy subjects onto at most three buckets.

     TWO ordering rules, and both matter:

     1. WITHIN a subject, the FIRST matching rule wins and matching stops. That
        is why BT.GENRE_RULES is ordered specific-first: 'Fantasy fiction',
        'Detective and mystery stories' and 'Love stories' all contain or imply
        fiction, so testing `fiction` first would collapse every genre in the
        app into one.

     2. ACROSS subjects, buckets are ranked by how many subjects hit them, ties
        broken by rule order (i.e. by specificity). Count first, because a work
        with fourteen mystery subjects and one stray 'Fiction' is a mystery;
        specificity second, because at equal counts the reader wants the chip
        that tells them something. Three is the cap — BT.ui draws two and the
        third is a spare for the facet tree; past that every extra bucket is
        less specific than the ones before it. */
  function bucketGenres(subjects) {
    const clean = cleanSubjects(subjects);
    const hits = new Map();
    for (const s of clean) {
      for (let i = 0; i < BT.GENRE_RULES.length; i++) {
        const rule = BT.GENRE_RULES[i];
        if (!rule.match.some(rx => rx.test(s))) continue;
        const cur = hits.get(rule.bucket) || { count: 0, rank: i };
        cur.count++;
        hits.set(rule.bucket, cur);
        break;
      }
    }
    /* `general` is reached ONLY by falling through. There is no `general` rule
       in the table for the same reason: a bucket you can arrive at two ways is
       a bucket whose contents nobody can explain. */
    if (!hits.size) return [genre('general')];
    return [...hits.entries()]
      .sort((a, b) => (b[1].count - a[1].count) || (a[1].rank - b[1].rank))
      .slice(0, 3)
      .map(([id]) => genre(id));
  }

  const genre = id => ({ id, name: BT.GENRE_LABELS[id] || id, source: 'openlibrary' });

  /* Every STORED item carries at least one bucket, because 12-repo builds the
     multiEntry `by_genre` index from `idx.genreIds` and a record with an empty
     array is skipped by that index entirely — it would then be missing from
     every genre count while still showing a "General" chip on its own row, and
     a tree whose numbers do not add up to "All books" is a tree nobody trusts.

     Note the asymmetry with the normalizers, which is deliberate: THEY emit no
     `genres` key at all when the payload had no subjects to bucket, so that a
     subject-less edition refresh cannot downgrade a well-classified work to
     General. The default is applied here instead, once, at the two moments a
     record is actually about to be written. */
  function ensureGenres(item) {
    if (item && (!item.genres || !item.genres.length)) item.genres = [genre('general')];
    return item;
  }

  /* ══ TERM VECTORS ════════════════════════════════════════════════════════
     Real term-frequency floats, not flat 1s, built HERE because the ordering
     information they depend on only exists in the source payload.

     The weights are shaped differently from MovieTrak's, and deliberately.
     There, the top-billed actor and the director carried the signal. For books
     the AUTHOR is overwhelmingly the strongest predictor a reader has — people
     follow novelists far harder than viewers follow directors — so an author
     term is worth a full 1.0 and outweighs any single subject.

     Subjects decay by position because Open Library emits them in rough
     cataloguing order, so the first few are the ones a librarian thought
     described the book and the tail is drift. The decay is gentle (never below
     0.35) because that ordering is a weak signal, not a billing order.

     Publishers get 0.35: an imprint is a real taste signal — a reader with six
     NYRB Classics has told you something — but it is a much weaker one than
     either the author or the subject matter. */
  function buildTerms(parts) {
    const t = {};
    for (const g of arr(parts.genres)) if (g && g.id) t[`g:${g.id}`] = 1.0;
    arr(parts.subjects).slice(0, 24).forEach((s, i) => {
      const k = slug(s);
      if (k) t[`s:${k}`] = Math.max(0.35, 1 - i * 0.03);
    });
    for (const a of arr(parts.authors)) {
      const id = (a && (a.olid || slug(a.name))) || '';
      if (id) t[`a:${id}`] = 1.0;
    }
    for (const p of arr(parts.publishers)) {
      const k = slug(typeof p === 'string' ? p : (p && p.name));
      if (k) t[`pub:${k}`] = 0.35;
    }
    /* A series is the closest thing a book has to MovieTrak's franchise key,
       and it is by far the most actionable recommendation in the app: someone
       who finished volume two wants volume three. */
    if (parts.seriesKey) t[`ser:${parts.seriesKey}`] = 1.0;
    return t;
  }

  /* ══ AUTHORS ═════════════════════════════════════════════════════════════
     Work and edition docs give author KEYS and never author NAMES:

         "authors": [{ "author": { "key": "/authors/OL34184A" } }]      (work)
         "authors": [{ "key": "/authors/OL34184A" }]                    (edition)

     Turning one of those into "Frank Herbert" costs a further request per
     author, against a source that grants roughly one request per second and
     explicitly asks not to be used as a backend. That is the entire reason the
     scan path prefers `byIsbn` (/api/books), which returns

         "authors": [{ "name": "Frank Herbert", "url": "…/OL34184A/…" }]

     inline, in the SAME request. Search docs likewise carry `author_name`
     alongside `author_key`. So a nameless authors array here is not a bug, it
     is the honest state of a work/edition payload — and `mergeAuthors` below
     exists so that state can never overwrite names we already paid for. */
  function authorsFromKeys(list) {
    const out = [];
    for (const a of arr(list)) {
      const key = a && (a.author ? a.author.key : (a.key || a));
      const id = olid(key);
      if (!id) continue;
      out.push({ id, olid: id, name: '', role: 'author', order: out.length, source: 'openlibrary' });
    }
    return BT.util.uniqBy(out, p => p.olid);
  }

  function authorsFromNames(names, keys) {
    const out = [];
    const ks = arr(keys);
    arr(names).forEach((n, i) => {
      const name = typeof n === 'string' ? n : (n && n.name) || '';
      if (!name) return;
      /* /api/books gives a URL rather than a key; olid() eats either, and eats
         the bare form /search/authors.json returns too. */
      const id = olid((typeof n === 'object' && n && n.url) || ks[i] || '');
      out.push({
        id: id || slug(name), olid: id || '', name,
        role: 'author', order: i, source: 'openlibrary',
      });
    });
    return BT.util.uniqBy(out, p => p.id);
  }

  /* Union by identity, preferring whichever side actually knows the name.

     Without this, hydrating a search-added item from its work record — which
     is the ordinary, every-item path — replaces ["Frank Herbert"] with
     [{name:''}] and the inspector starts reporting "Author not recorded" for a
     book it displayed correctly a second earlier. The fresh payload is not
     wrong, it simply does not carry names; overwriting on that basis is. */
  function mergeAuthors(existing, fresh) {
    const byId = new Map();
    const key = a => a.olid || a.id || slug(a.name);
    for (const a of arr(existing)) if (a) byId.set(key(a), Object.assign({}, a));
    for (const f of arr(fresh)) {
      if (!f) continue;
      const k = key(f);
      const cur = byId.get(k);
      if (!cur) { byId.set(k, Object.assign({}, f)); continue; }
      byId.set(k, Object.assign({}, cur, f, {
        name: f.name || cur.name,
        olid: f.olid || cur.olid,
      }));
    }
    return [...byId.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /* ══ ISBNs — THE HEART OF THE APP ════════════════════════════════════════
     Two arrays, two id namespaces, and they MUST NEVER BE CONFLATED:

       isbnsPinned     an OWNERSHIP CLAIM. The one specific printing the reader
                       holds, established by scanning its barcode or by picking
                       an edition by hand. Only a scope:'closed' item has any.
                       12-repo writes these to `isbn13:` and the scanner resolves
                       them as `via: 'pinned'` → "you already own this exact copy".

       isbnsCandidate  MERE POSSIBILITIES. The many ISBNs a WORK is known by
                       when the reader has not said which copy is on the shelf.
                       Only a scope:'open' item has any. 12-repo writes these to
                       `isbncand:` and the scanner resolves them as
                       `via: 'candidate'` → "you have an unspecified copy of this
                       book; pin this edition, or add it as a separate copy?".

     Write candidates into the pinned namespace and the app stops working, in
     silence. Every edition of every book you ever SEARCHED would answer
     "already owned" to a scanner, and scanning a second printing could never
     create a separate item — no error, no warning, just a scanner that stops
     adding anything. That is the exact opposite of what the app is for.

     CANDIDATES ARE POPULATED LAZILY AND ARE NEVER COMPLETE.
     /works/{id}/editions.json is paginated at 50 (there is no `page` param,
     only `?offset=`). The Hobbit's work has 481 editions yielding just 310
     distinct ISBN-13s: 30% of entries have no `isbn_13` and 13% have no ISBN of
     any kind. `?limit=1000` returns the lot but is a 0.48 MB payload, which is
     background-only and never an interactive path. So `editionsTotal`,
     `editionsSeen` and `editionsFetchedAt` exist to say how far through we got,
     and NOTHING may treat `isbnsCandidate` as exhaustive: a candidate miss
     means "not seen yet", never "not this book". */

  function isbn13sOf(raw) {
    const out = [];
    for (const v of arr(raw && raw.isbn_13)) {
      const d = String(v || '').replace(/[^0-9Xx]/g, '');
      if (BT.util.isValidEan13(d)) out.push(d);
    }
    /* ISBN-10s are widened rather than dropped: pre-2007 printings often list
       only the 10, and it is the same number in a different encoding. Widening
       is lossless; isbn10to13 rejects anything whose mod-11 check fails, so a
       typo in the catalogue does not become a fake barcode. */
    for (const v of arr(raw && raw.isbn_10)) {
      const w = BT.util.isbn10to13(v);
      if (w) out.push(w);
    }
    return [...new Set(out)];
  }

  /* The pinned set for one edition record.

     `opts.isbn13` — the code the scanner actually read — WINS ABSOLUTELY, and
     that is a verified rule rather than a preference. Field presence on edition
     docs is wildly inconsistent: across three real ISBNs `isbn_13` was present
     on only two, and one of the misses was a lookup made BY ISBN-13. Round-trip
     the scanned code through the response and that book gets pinned to nothing,
     so rescanning it adds a duplicate every time. Trust what came off the
     barcode.

     Any other ISBN-13 on the SAME record joins it, because those identify the
     same physical printing (a reissue under a new prefix, most often), so a
     scan of either should find this copy. */
  function pinnedIsbns(raw, opts) {
    const scanned = opts && opts.isbn13 && BT.util.isValidEan13(opts.isbn13)
      ? String(opts.isbn13) : null;
    const fromRecord = isbn13sOf(raw);
    const out = scanned ? [scanned].concat(fromRecord) : fromRecord;
    return [...new Set(out)];
  }

  /* ══ COVERS ══════════════════════════════════════════════════════════════
     The `covers` array contains a -1 sentinel meaning "a cover record existed
     and was removed". BT.OL.usableCovers drops it (and 0, and anything
     non-numeric); reaching into the array directly builds .../b/id/-1-M.jpg,
     which 404s. */
  function imagesFrom(raw, extra) {
    const covers = BT.OL.usableCovers(raw && raw.covers);
    return Object.assign({
      coverId: covers.length ? covers[0] : null,
      covers,
      coverUrl: null,
      source: 'openlibrary',
    }, extra || {});
  }

  /* ══ FORMAT ══════════════════════════════════════════════════════════════
     `physical_format` is free text and present on roughly a third of edition
     records: 'Mass Market Paperback', 'Hardcover', 'Audio CD', 'Kindle
     Edition', 'Electronic resource', 'pbk.'. Returns undefined rather than
     'unspecified' when it cannot tell, so the merge prune drops the key and a
     thin refresh cannot downgrade a format we already knew. */
  const AUDIO_RX = /\b(audio|audiobook|cd|cassette|mp3|spoken|sound recording|playaway|vinyl)\b/i;
  const EBOOK_RX = /\b(e-?book|kindle|epub|mobi|electronic|digital|downloadable|online resource)\b/i;

  function formatFromPhysical(s) {
    const v = String(s || '').trim();
    if (!v) return undefined;
    if (AUDIO_RX.test(v)) return 'audiobook';
    if (EBOOK_RX.test(v)) return 'ebook';
    return 'physical';
  }

  function languagesOf(raw) {
    const out = [];
    for (const l of arr(raw && raw.languages)) {
      /* '/languages/eng' on editions; a bare 'eng' on search docs. */
      const k = typeof l === 'string' ? l : (l && l.key) || '';
      const m = /([a-z]{3})$/i.exec(String(k).trim());
      if (m) out.push(m[1].toLowerCase());
    }
    for (const l of arr(raw && raw.language)) {
      const s = String(l || '').trim().toLowerCase();
      if (s) out.push(s);
    }
    return [...new Set(out)];
  }

  function publishersOf(raw) {
    const out = [];
    for (const p of arr(raw && raw.publishers)) {
      const name = typeof p === 'string' ? p : (p && p.name);
      if (!name) continue;
      /* Trailing full stops are a MARC habit ('Chilton Books.') and are the
         reason one imprint splits into three facet rows. 12-repo folds case and
         punctuation when it builds the facet key; this just keeps the DISPLAY
         string tidy. */
      const s = String(name).trim().replace(/[.,;]+$/, '').trim();
      if (s) out.push(s);
    }
    return BT.util.uniqBy(out, s => s.toLowerCase());
  }

  function seriesOf(raw) {
    const s = arr(raw && raw.series).map(x => (typeof x === 'string' ? x : (x && x.name) || ''))
      .find(Boolean);
    if (!s) return { name: null, key: null };
    /* 'Dune Chronicles #1' and 'Dune Chronicles, bk. 1' are the same series;
       the volume number belongs to the volume, not to the key. */
    const base = String(s).replace(/[,;]?\s*(#|no\.?|bk\.?|book|vol\.?|volume)\s*\d+.*$/i, '').trim();
    const key = slug(base || s);
    return { name: String(s).trim(), key: key || null };
  }

  const OL_BASE = 'https://openlibrary.org';

  /* ══ SEARCH DOC → PROVISIONAL ITEM ═══════════════════════════════════════
     Adding from search must feel instant, so this stub is written immediately
     and the detail fetch fills it in afterwards; `meta.partial` marks it and
     BT.ui.hydrate clears it.

     Everything here is WORK-level, which is why scope is 'open'. The reader
     said "Dune", not "the 1990 Ace paperback", and picking an edition on their
     behalf would stamp a cover, a publisher, an extent and an ISBN onto the
     record that they never chose. */
  function stubFromSearchDoc(doc) {
    if (!doc) return null;
    const work = olid(doc.key || doc.work_key || '');
    if (!work) return null;

    const authors = authorsFromNames(doc.author_name, doc.author_key);
    const subjects = cleanSubjects(doc.subject);
    const genres = subjects.length ? bucketGenres(doc.subject) : [];

    /* first_publish_year, and nothing better. It is half-weighted through
       BASIS_FACTOR because it is a computed minimum over the work's editions
       and one mis-catalogued reprint drags it back decades — the live search
       for "dune" returns the actual novel at rank 8, attributed to Brian
       Herbert, dated 2001. Present it as "first recorded", never as the
       publication date, and let an edition supersede it. */
    const release = buildRelease(
      doc.first_publish_year != null ? String(doc.first_publish_year) : '',
      { basis: 'work-first-published', inPrint: !!(doc.edition_count || doc.cover_i) });

    return {
      uid: uidOf('openlibrary', work),
      kind: KIND,
      scope: 'open',
      facets: {},

      ids: {
        olWork: work, workOlid: work,
        olEdition: null, editionOlid: null,
        isbn13: null, isbn10: null,
        goodreads: null, librarything: null, oclc: null, lccn: null, googlebooks: null,
      },

      title: doc.title || doc.title_suggest || work,
      subtitle: doc.subtitle || '',
      originalTitle: doc.title_english || doc.title || '',
      description: '',
      firstSentence: text(arr(doc.first_sentence)[0]),

      authors,
      publishers: [],
      /* The MEDIAN extent across the work's editions, which is the only honest
         answer for an item that has not chosen one. BT.ui.totalPagesOf treats
         it as a fallback denominator and a reader's own figure always beats it. */
      pageCount: posInt(doc.number_of_pages_median),
      languages: languagesOf(doc),

      subjects,
      subjectFacets: { people: [], places: [], times: [] },
      genres,
      images: imagesFrom(null, { coverId: posInt(doc.cover_i) }),

      release,
      /* Recorded separately from `release` so the inspector can say "first
         recorded 1965" in words without anything mistaking it for a date the
         record actually states. */
      firstPublishYear: doc.first_publish_year != null ? Number(doc.first_publish_year) : null,

      isbnsPinned: [],
      isbnsCandidate: [],
      editionsTotal: posInt(doc.edition_count),
      editionsSeen: 0,
      editionsFetchedAt: 0,

      /* BT.util.rankByRelevance breaks ties WITHIN a relevance band on `.pop`,
         and edition count is Open Library's own popularity figure. It has to
         ride on the stub because the search view ranks stubs, not raw docs —
         with no `pop` every row ties at 0, the sort degenerates to Open
         Library's own ordering, and that ordering is the thing we are here to
         throw away (live `q=dune` puts Children of Dune first and Go Ask Alice
         sixth). Dropped by leanForSync; it is a search artefact, not a fact
         about the book. */
      pop: posInt(doc.edition_count) || 0,

      links: { openlibrary: `${OL_BASE}/works/${work}` },
      externalLinks: [],
      ratings: {},

      rec: { fetchedAt: 0, franchiseKey: null, terms: {}, candidates: {}, seedEligible: 0 },
      meta: {
        schema: 1, primarySource: 'openlibrary', detailsFetchedAt: 0,
        normalizerVersion: 1, partial: 1, manualOverrides: {},
      },
    };
  }

  /* ══ WORK DOC → ITEM FIELDS ══════════════════════════════════════════════
     The work is the BOOK as a text: title, description, subjects, authors. It
     knows nothing about any particular printing — no publisher, no extent, no
     ISBN, no format — and must not pretend otherwise, which is why nothing
     below writes into the edition fields.

     `opts.authors` lets a caller that has already resolved author records hand
     them in, so we do not emit a nameless array; see mergeAuthors for what
     happens when it does not. */
  function fromWork(raw, opts) {
    opts = opts || {};
    if (!raw) return null;
    const work = olid(raw.key || opts.olid || '');

    const rawSubjects = [].concat(arr(raw.subjects));
    const subjects = cleanSubjects(rawSubjects);
    /* Empty in, nothing out — see ensureGenres. A work record whose subjects
       are all stoplisted must not answer "General" over a bucket the search
       stub already worked out. */
    const genres = subjects.length ? bucketGenres(rawSubjects) : [];
    const authors = (opts.authors && opts.authors.length)
      ? authorsFromNames(opts.authors)
      : authorsFromKeys(raw.authors);

    /* Works occasionally carry `first_publish_date` as free text ('1965',
       'October 1937'), which is a better field than the search doc's computed
       year but still work-level and still not authoritative. */
    const release = buildRelease(raw.first_publish_date || opts.firstPublishDate || '', {
      basis: 'work-first-published',
      inPrint: true,          // a work with a record in the catalogue exists
    });

    const series = seriesOf(raw);
    const item = {
      kind: KIND,
      scope: 'open',
      ids: { olWork: work || null, workOlid: work || null },
      title: raw.title || undefined,
      subtitle: raw.subtitle || '',
      description: text(raw.description),
      firstSentence: text(raw.first_sentence) || text(arr(raw.excerpts).find(e => e && e.first_sentence)),
      authors,
      subjects,
      /* Faceted subjects are real data that belongs in its own field rather
         than in the genre matcher — 'Arrakis (Imaginary place)' is not a genre
         and matching on it produces nonsense buckets. */
      subjectFacets: {
        people: cleanSubjects(raw.subject_people),
        places: cleanSubjects(raw.subject_places),
        times: cleanSubjects(raw.subject_times),
      },
      genres,
      images: imagesFrom(raw),
      release,
      links: work ? { openlibrary: `${OL_BASE}/works/${work}` } : undefined,
      externalLinks: arr(raw.links)
        .filter(l => l && l.url)
        .map(l => ({ title: l.title || l.url, url: l.url })),
      rec: {
        fetchedAt: Date.now(),
        franchiseKey: series.key ? `series:${series.key}` : null,
        terms: buildTerms({ genres, subjects, authors, seriesKey: series.key }),
        candidates: {},
        seedEligible: 1,
      },
      meta: {
        schema: 1, primarySource: 'openlibrary', detailsFetchedAt: Date.now(),
        normalizerVersion: 1, partial: 0, manualOverrides: {},
      },
    };
    if (work) item.uid = uidOf('openlibrary', work);
    if (series.name) item.seriesName = series.name;
    return item;
  }

  /* ══ EDITION DOC → ITEM FIELDS ═══════════════════════════════════════════
     One printing: the object on the shelf. scope 'closed', because everything
     here — publisher, extent, format, cover, ISBN — is true of THIS copy and of
     no other.

     Reached via /books/{OLID}.json or /isbn/{isbn}.json. The latter is a 302 to
     the former (two round trips, which 05-net charges for), and a miss returns
     HTML with HTTP 404 so `.json()` throws SyntaxError — hence the res.ok check
     that lives in the net layer.

     Authors are KEYS ONLY here. Resolving one name costs another request
     against a ~1 req/s source, which is precisely why the scan path prefers
     `byIsbn` (/api/books) — same edition, names and covers inline, ONE request.
     This normalizer exists for the cases /api/books cannot serve: it is the
     only shape that carries `works[].key`, so it is how a scanned copy reaches
     its work record at all. */
  function fromEdition(raw, opts) {
    opts = opts || {};
    if (!raw) return null;

    const edition = olid(raw.key || opts.olid || '');
    const work = olid(arr(raw.works)[0] && arr(raw.works)[0].key);
    const pinned = pinnedIsbns(raw, opts);
    const primary = pinned[0] || null;

    const rawSubjects = arr(raw.subjects);
    const subjects = cleanSubjects(rawSubjects);
    const genres = subjects.length ? bucketGenres(rawSubjects) : [];
    const authors = (opts.authors && opts.authors.length)
      ? authorsFromNames(opts.authors)
      : authorsFromKeys(raw.authors);
    const publishers = publishersOf(raw);
    const series = seriesOf(raw);

    /* An edition-level date, which is the one this app actually wants: it
       describes a printing that exists, so it carries full basis weight and
       supersedes the work's `first_publish_year` in pickRelease. */
    const release = buildRelease(raw.publish_date || '', {
      basis: 'edition-published',
      inPrint: true,        // an edition record IS a physical artefact
    });

    const ident = raw.identifiers || {};
    const item = {
      kind: KIND,
      scope: 'closed',
      facets: {},

      ids: {
        /* `olWork` is DELIBERATELY NOT SET on a closed item, and this is the
           same trap as the pinned/candidate ISBN split wearing a different hat.
           12-repo's idKeysFor turns `ids.olWork` into an `olwork:{OLID}` claim
           regardless of scope, and BT.ui.addItem resolves that key FIRST. A
           scanned copy claiming the work would therefore make every LATER scan
           of a different printing of the same book resolve to it and refuse to
           add — silently, since "already on your shelves" is a success message.
           The work olid is still recorded, under a name nothing indexes, so
           hydration can reach the work for subjects and description.

           The cost of this choice, stated honestly: search-adding a book you
           have already scanned will not dedup against your copy. That is a
           visible duplicate the reader can delete, as against an invisible
           scanner that stops working — and it is one line to reverse if the
           trade ever looks wrong. Note the primary scan path never faces the
           question at all: /api/books carries no work key to claim. */
        workOlid: work || null,
        olEdition: edition || null,
        /* Both spellings on purpose: 12-repo indexes `olEdition`, BT.ui's
           posterUrl reads `editionOlid`. Writing both here is cheaper than
           editing two finished M1 files, and neither name is wrong. */
        editionOlid: edition || null,
        isbn13: primary,
        isbn10: arr(raw.isbn_10)[0] || null,
        goodreads: arr(ident.goodreads)[0] || null,
        librarything: arr(ident.librarything)[0] || null,
        oclc: arr(raw.oclc_numbers)[0] || null,
        lccn: arr(raw.lccn)[0] || null,
      },

      title: raw.title || undefined,
      subtitle: raw.subtitle || '',
      description: text(raw.description),
      firstSentence: text(raw.first_sentence)
        || text(arr(raw.excerpts).find(e => e && e.first_sentence)),

      authors,
      publishers,
      pageCount: posInt(raw.number_of_pages),
      pagination: raw.pagination || '',
      byStatement: raw.by_statement || '',
      publishPlaces: arr(raw.publish_places)
        .map(p => (typeof p === 'string' ? p : (p && p.name) || '')).filter(Boolean),
      languages: languagesOf(raw),

      subjects,
      genres,
      images: imagesFrom(raw),
      release,

      /* The ownership claim. Never `isbnsCandidate` — see the block above
         pinnedIsbns for what happens when those two swap places. */
      isbnsPinned: pinned,
      isbnsCandidate: [],

      links: Object.assign(
        edition ? { openlibrary: `${OL_BASE}/books/${edition}` } : {},
        work ? { work: `${OL_BASE}/works/${work}` } : {}),
      ratings: {},

      rec: {
        fetchedAt: Date.now(),
        franchiseKey: series.key ? `series:${series.key}` : null,
        terms: buildTerms({ genres, subjects, authors, publishers, seriesKey: series.key }),
        candidates: {},
        seedEligible: 1,
      },
      meta: {
        schema: 1, primarySource: 'openlibrary', detailsFetchedAt: Date.now(),
        normalizerVersion: 1, partial: 0, manualOverrides: {},
      },
    };

    const fmt = formatFromPhysical(raw.physical_format);
    if (fmt) item.facets.format = fmt;
    if (series.name) item.seriesName = series.name;

    /* Identity prefers the ISBN, because that is what the reader will scan
       again. An edition with no ISBN at all is not rare — 13% of The Hobbit's
       481 catalogued editions have none — so the edition OLID is a real
       fallback rather than a defensive branch. */
    if (primary) item.uid = uidOf('isbn', primary);
    else if (edition) item.uid = uidOf('openlibrary', edition);
    return item;
  }

  /* ══ /api/books RECORD → ITEM FIELDS ═════════════════════════════════════
     The scan path's preferred shape, and the reason is arithmetic: it returns
     author NAMES and cover URLs inline, so one request does what /isbn/ plus an
     author lookup plus a cover probe would take four to do — against a source
     that grants about one request per second.

     `rec` is the INNER object (the value under the 'ISBN:…' key), and `isbn13`
     is the code the scanner read. What it does NOT carry is `works`, so a
     record normalized here cannot reach its work; that is what `editionByIsbn`
     (/isbn/) is for when subjects or a description are actually wanted. */
  function fromApiBooks(rec, isbn13) {
    if (!rec) return null;

    const ident = rec.identifiers || {};
    const edition = olid(arr(ident.openlibrary)[0] || rec.key || rec.url || '');
    const pinned = pinnedIsbns({ isbn_13: ident.isbn_13, isbn_10: ident.isbn_10 }, { isbn13 });
    const primary = pinned[0] || null;

    const rawSubjects = arr(rec.subjects);
    const subjects = cleanSubjects(rawSubjects);
    const genres = subjects.length ? bucketGenres(rawSubjects) : [];
    const authors = authorsFromNames(rec.authors);
    const publishers = publishersOf(rec);
    const series = seriesOf(rec);

    const release = buildRelease(rec.publish_date || '', {
      basis: 'edition-published',
      inPrint: true,
    });

    /* THE COVER TRAP, in its most tempting form. This shape hands over ready
       made URLs — `cover: { small, medium, large }` — and every one of them is
       missing `?default=false`. Store one as `images.coverUrl` and BT.ui's
       posterUrl passes absolute URLs straight through, so a book with no art
       answers HTTP 200 with a 43-byte transparent GIF, the <img> LOADS, onerror
       never fires, and the generated cover block never replaces it. The grid
       fills with invisible tiles that read as a broken app.
       So: pull the numeric id back out of the URL and let BT.OL.coverById
       rebuild it properly. */
    const coverId = coverIdFromUrl(rec.cover && (rec.cover.large || rec.cover.medium || rec.cover.small));

    const item = {
      kind: KIND,
      scope: 'closed',
      /* A record reached BY ISBN-13 in this app was reached by scanning a
         retail barcode off a physical cover, so 'physical' is an observation
         rather than a guess — /api/books has no `physical_format` field to read
         it from. A reader who typed the ISBN of an ebook can correct it in the
         inspector, which is one tap. */
      facets: { format: 'physical' },

      ids: {
        /* No `olWork` — /api/books does not carry one, which is exactly why the
           scan path never has to make the choice fromEdition documents. */
        workOlid: null,
        olEdition: edition || null,
        editionOlid: edition || null,
        isbn13: primary,
        isbn10: arr(ident.isbn_10)[0] || null,
        goodreads: arr(ident.goodreads)[0] || null,
        librarything: arr(ident.librarything)[0] || null,
        oclc: arr(ident.oclc)[0] || null,
        lccn: arr(ident.lccn)[0] || null,
      },

      title: rec.title || undefined,
      subtitle: rec.subtitle || '',
      description: text(rec.description) || text(rec.notes),
      firstSentence: text((arr(rec.excerpts).find(e => e && e.first_sentence) || {}).text),

      authors,
      publishers,
      pageCount: posInt(rec.number_of_pages),
      pagination: rec.pagination || '',
      byStatement: rec.by_statement || '',
      publishPlaces: arr(rec.publish_places).map(p => (p && p.name) || '').filter(Boolean),
      languages: [],

      subjects,
      subjectFacets: {
        people: cleanSubjects(rec.subject_people),
        places: cleanSubjects(rec.subject_places),
        times: cleanSubjects(rec.subject_times),
      },
      genres,
      images: imagesFrom(null, { coverId }),
      release,

      isbnsPinned: pinned,
      isbnsCandidate: [],

      links: Object.assign(
        { openlibrary: rec.url || (edition ? `${OL_BASE}/books/${edition}` : null) },
        {}),
      externalLinks: arr(rec.links).filter(l => l && l.url)
        .map(l => ({ title: l.title || l.url, url: l.url })),
      ratings: {},

      rec: {
        fetchedAt: Date.now(),
        franchiseKey: series.key ? `series:${series.key}` : null,
        terms: buildTerms({ genres, subjects, authors, publishers, seriesKey: series.key }),
        candidates: {},
        seedEligible: 1,
      },
      meta: {
        schema: 1, primarySource: 'openlibrary', detailsFetchedAt: Date.now(),
        normalizerVersion: 1, partial: 0, manualOverrides: {},
      },
    };

    if (series.name) item.seriesName = series.name;
    if (primary) item.uid = uidOf('isbn', primary);
    else if (edition) item.uid = uidOf('openlibrary', edition);
    return item;
  }

  function coverIdFromUrl(url) {
    const m = /\/b\/id\/(\d+)-/.exec(String(url || ''));
    return m ? posInt(m[1]) : null;
  }

  /* ══ EDITIONS PAGE → CANDIDATES ══════════════════════════════════════════
     The ONE place an editions listing is allowed to become item state, for the
     same reason everything else in this file exists: a raw payload must never
     be read into a record anywhere else.

     `page` is what BT.openlibrary.editionsOfWork returns:
     { size, entries, offset, hasMore }. Candidates ACCUMULATE — the endpoint is
     paginated at 50 with no `page` param — so this unions rather than replaces,
     and `editionsSeen` counts entries examined rather than ISBNs found. Those
     are very different numbers: The Hobbit's 481 entries yield 310 distinct
     ISBN-13s because 13% of editions carry no ISBN at all. Completeness is
     `editionsSeen >= editionsTotal` and nothing may infer it from array length. */
  function absorbEditions(item, page) {
    if (!item || !page) return item;
    const found = [];
    for (const e of arr(page.entries)) found.push(...isbn13sOf(e));

    const merged = new Set(arr(item.isbnsCandidate));
    for (const i of found) merged.add(i);
    /* A pinned ISBN is never also a candidate. If the reader has said which
       copy they hold, the other printings are somebody else's book — and
       leaving the pinned one in both arrays would have 12-repo write it to both
       namespaces, which is the conflation this whole file guards against. */
    for (const p of arr(item.isbnsPinned)) merged.delete(p);

    item.isbnsCandidate = [...merged];
    item.editionsSeen = Math.max(item.editionsSeen || 0,
      (page.offset || 0) + arr(page.entries).length);
    if (posInt(page.size)) item.editionsTotal = posInt(page.size);
    item.editionsFetchedAt = Date.now();
    return item;
  }

  /* ══ MERGE ═══════════════════════════════════════════════════════════════
     Refreshed remote data must never clobber what the reader typed, never
     clobber a field they corrected by hand, and — the part that is specific to
     this app — never clobber a RICHER shape with a THINNER one. */

  /* MovieTrak's prune dropped null and undefined, which was enough because
     every refresh there replaced a TMDB details payload with another TMDB
     details payload: same endpoint, same fields, same shape.

     Here the shapes genuinely differ. A work refresh has no publisher, no
     extent and no ISBN; an edition refresh has no subjects and usually no
     description. Object.assign copies '' and [] as happily as it copies a real
     value, so the ordinary hydrate path would blank half the record every time
     it ran — and it would look like an intermittent data-loss bug rather than a
     merge rule. Empty is treated as absent, so a field can only ever be
     replaced by content. The trade: a field that genuinely empties upstream
     needs a manual override to clear, which is the right way round. */
  function prune(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v != null) out[k] = v;
    return out;
  }

  function pruneThin(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v == null) continue;
      if (v === '') continue;
      if (Array.isArray(v) && !v.length) continue;
      out[k] = v;
    }
    return out;
  }

  function mergeItem(existing, fresh) {
    if (!existing) return fresh;

    /* A refresh that came back thin must never erase what we already know. An
       upstream that is rate-limited, truncated, or in one of Open Library's
       read-only maintenance windows can still answer 200 with a shell of a
       record; a payload with no title is not a usable record at all, so it is
       discarded outright rather than merged. */
    if (!fresh || !fresh.title) return existing;

    const overrides = (existing.meta && existing.meta.manualOverrides) || {};
    const merged = Object.assign({}, existing, pruneThin(fresh));

    /* Identity is immutable. It is the foreign key in snapshots, the feed, the
       URL and every idIndex row, and a refresh has no business reassigning it. */
    merged.uid = existing.uid;

    /* SCOPE NARROWS, NEVER WIDENS.
       open → closed is a decision the reader made ("this is the copy I hold")
       and is allowed through. closed → open is never a refresh's business:
       hydrating a scanned copy from its WORK record — a perfectly ordinary
       thing to do, to pick up subjects and a description — would otherwise
       unpin the item, move its ISBN from the pinned namespace to the candidate
       one, and quietly convert a book the reader owns into a book they merely
       looked up. */
    merged.scope = existing.scope === 'closed' ? 'closed' : (fresh.scope || existing.scope || 'open');

    /* User-authored state always wins.

       COPIED, not aliased. `merged.user = existing.user` shares one object
       between the input and the output, and the override loop at the bottom of
       this function then writes THROUGH it: a manualOverride on 'user.notes'
       silently rewrote the notes on the record that was passed in, so a caller
       holding the old item saw it change under them and a merge that was later
       discarded had already taken effect. A shallow copy is enough — overrides
       address scalar fields — and it costs one object per refresh. */
    merged.user = Object.assign({}, existing.user);
    merged.tracking = Object.assign({}, existing.tracking, {
      /* refresh bookkeeping belongs to the sync layer, not to the payload */
      lastRefreshAt: Date.now(),
      consecutiveFetchErrors: 0,
      missSince: null,
    });

    merged.release = pickRelease(existing.release, fresh.release);
    merged.ids = Object.assign({}, existing.ids, prune(fresh.ids));
    merged.links = Object.assign({}, existing.links, pruneThin(fresh.links));
    merged.images = Object.assign({}, existing.images, pruneThin(fresh.images));
    merged.facets = Object.assign({}, existing.facets, pruneThin(fresh.facets));
    merged.ratings = Object.assign({}, existing.ratings, prune(fresh.ratings));
    merged.authors = mergeAuthors(existing.authors, fresh.authors);

    merged.subjectFacets = Object.assign({}, existing.subjectFacets, pruneThin(fresh.subjectFacets));

    /* ISBNs, and the one rule that must survive every future edit of this
       function: PINNED AND CANDIDATE NEVER MIX.

       Pinned is an ownership claim and only a closed item has one, so a work
       refresh (which carries none) leaves it alone. Candidates accumulate
       across paginated editions pages, so they union rather than replace — and
       anything pinned is subtracted from them, because a copy the reader owns
       is not a possibility. */
    merged.isbnsPinned = (fresh.isbnsPinned && fresh.isbnsPinned.length)
      ? [...new Set(fresh.isbnsPinned)]
      : (existing.isbnsPinned || []);
    const cand = new Set([].concat(existing.isbnsCandidate || [], fresh.isbnsCandidate || []));
    for (const p of merged.isbnsPinned) cand.delete(p);
    merged.isbnsCandidate = [...cand];
    merged.editionsSeen = Math.max(existing.editionsSeen || 0, fresh.editionsSeen || 0);
    merged.editionsTotal = fresh.editionsTotal || existing.editionsTotal || null;
    merged.editionsFetchedAt = Math.max(existing.editionsFetchedAt || 0, fresh.editionsFetchedAt || 0);

    /* Term vectors are derived, so the fresher one wins where it has anything
       to say — but candidates and the franchise key are accumulated state and
       are kept when the payload is silent about them. */
    const fr = fresh.rec || {};
    const er = existing.rec || {};
    merged.rec = {
      fetchedAt: fr.fetchedAt || er.fetchedAt || 0,
      franchiseKey: fr.franchiseKey || er.franchiseKey || null,
      terms: (fr.terms && Object.keys(fr.terms).length) ? fr.terms : (er.terms || {}),
      candidates: (fr.candidates && Object.keys(fr.candidates).length) ? fr.candidates : (er.candidates || {}),
      seedEligible: fr.seedEligible != null ? fr.seedEligible : (er.seedEligible || 0),
    };

    merged.meta = Object.assign({}, existing.meta, fresh.meta, {
      manualOverrides: overrides,
    });

    /* Anything the reader edited by hand is restored on top of everything
       above — a corrected title or page count survives every refresh forever. */
    for (const path of Object.keys(overrides)) setPath(merged, path, overrides[path]);
    return ensureGenres(merged);
  }

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /* ══ DEFAULTS ════════════════════════════════════════════════════════════
     A brand-new item needs reader state and refresh bookkeeping. Everything
     here is a 0|1 rather than a boolean because IndexedDB cannot use booleans
     as keys, and 12-repo coerces them anyway — writing them correctly at the
     source means the coercion never has to fire. */
  function withDefaults(item, status, source, scope) {
    if (!item) return item;
    item.kind = item.kind || KIND;
    item.scope = scope || item.scope || 'open';

    item.user = Object.assign({
      /* THE CALLER'S WORD, TAKEN AS GIVEN. The two add doors disagree on
         purpose and this is not the place to second-guess either of them:
         BT.ui.addItem passes 'want' (you looked a title up — a wishlist entry),
         39-scan passes 'have' (you were holding the object under the lens, so
         you own it). 'want' is the FALLBACK, for a caller that says nothing.

         NOTHING HERE REWRITES AN EXISTING RECORD. `item.user` is assigned OVER
         these defaults, so a status already on the item always survives — which
         is what makes the ladder gaining a rung a non-event for stored data.
         Every book saved before `have` existed still reads want|reading|
         finished|dropped and stays exactly where the reader filed it; deciding
         on their behalf which of their `want` books they secretly own would be
         inventing ownership out of nothing. A value this build does not know
         is read as `want` at DISPLAY time only (BT.ui.statusOf) and is one tap
         from being corrected by the person who actually knows. */
      status: status || 'want',
      priority: 0,
      notes: '',
      tags: [],
      /* The OWNERSHIP axis, independent of reading status: you can own a book
         you have not started and can finish one you never owned. null is a real
         value here, not "unset", which is why it is stamped rather than left
         off. `rating` deliberately is NOT stamped — the by_userRating index is
         sparse by design and a 0 would mean "rated zero". */
      pile: null,
      progress: null,
      addedAt: Date.now(), updatedAt: Date.now(),
      startedAt: null, finishedAt: null,
      source: source || 'search',
    }, item.user || {});

    /* T4 for anything already published, which is most of a library and
       exactly the point of that tier — a 1965 novel does not need polling. A
       title that has not published yet still moves, so it rests in T2 until
       48-sync re-tiers it properly on the next write. */
    const published = item.release && item.release.status === 'published';
    item.tracking = Object.assign({
      watchReleaseFlag: 1,
      /* The book analogue of MovieTrak's per-episode watch: tell me when a new
         printing or format appears (the paperback drop), which is the only
         thing about a published book that still moves. */
      watchEditionsFlag: 1,
      tier: published ? 'T4' : 'T2',
      refreshDueAt: 0, lastRefreshAt: 0,
      consecutiveFetchErrors: 0, missSince: null, mutedFlag: 0,
    }, item.tracking || {});

    return ensureGenres(item);
  }

  /* ══ SYNC ════════════════════════════════════════════════════════════════
     The synced file carries YOUR data. Everything else on a record came from
     Open Library and can be fetched again, so shipping it means paying for it
     in every commit forever — and because the file is encrypted, git cannot
     delta-compress successive versions, so each save stores a full fresh copy.

     What that means here is different from MovieTrak, where recommendation
     candidates were the fat. The fat in a book record is bibliographic:
     `subjects` runs to forty strings on a well-catalogued work, `description`
     is a paragraph, and `isbnsCandidate` reaches 310 entries for a classic — a
     single popular work can carry 722 ISBNs upstream. All of it is derivable
     from a work id.

     `isbnsPinned` STAYS, and it is the one bibliographic-looking field that
     does. Which copy you own is user-authored truth: it came off a barcode the
     reader scanned, or an edition they picked by hand, and there is no request
     that can re-derive it. Losing it would silently convert every owned copy
     back into an unspecified work on the next device.

     `rec.terms` also stays despite being derived — it is small, and it is what
     lets recommendations work on a new device before anything is re-fetched.

     `meta.partial` is set so the existing hydrate path refills the rest the
     first time the item is opened; that machinery already exists for search
     stubs and needs nothing new. */
  const SYNC_DROP = ['subjects', 'subjectFacets', 'description', 'firstSentence',
                     'externalLinks', 'publishPlaces', 'byStatement', 'pagination',
                     'editions', 'excerpts', 'notes', 'idx', 'pop'];

  function leanForSync(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      if (SYNC_DROP.includes(k)) continue;
      out[k] = v;
    }
    out.genres = (item.genres || []).map(g => ({ id: g.id, name: g.name, source: g.source }));
    out.authors = (item.authors || []).map(a => ({ id: a.id, olid: a.olid, name: a.name, role: a.role, order: a.order }));

    /* Candidates are dropped and their bookkeeping is reset with them, so the
       receiving device re-fills the list lazily instead of trusting a count it
       cannot verify. The visible cost is small and bounded: until that item is
       hydrated, scanning a DIFFERENT printing of a book you have on open scope
       offers to add it as a new item rather than offering to pin it. Pinned
       ISBNs are untouched, so nothing you actually own is ever mistaken for
       something you do not. */
    out.isbnsPinned = item.isbnsPinned || [];
    out.isbnsCandidate = [];
    out.editionsSeen = 0;
    out.editionsFetchedAt = 0;

    out.rec = {
      fetchedAt: 0,
      franchiseKey: (item.rec && item.rec.franchiseKey) || null,
      terms: (item.rec && item.rec.terms) || {},
      candidates: {},
      seedEligible: (item.rec && item.rec.seedEligible) || 0,
    };
    out.meta = Object.assign({}, item.meta, { partial: 1 });
    return out;
  }

  /* Bringing a synced record back in. If this device already holds the full
     record, keep the API-derived half and take only what the other device
     actually changed — otherwise every sync throws away local detail and forces
     a re-fetch of things we already had. */
  function absorbSynced(local, incoming) {
    if (!local || !local.meta || local.meta.partial) return incoming;
    if (!incoming) return local;

    const merged = Object.assign({}, local);
    merged.user = incoming.user;
    merged.tracking = incoming.tracking;

    /* Scope and the pinned ISBN travel TOGETHER and both come from the
       incoming record, because both are statements the reader made on the other
       device: they scanned a copy, or they pinned an edition. Taking one
       without the other produces a closed item with nothing pinned (invisible
       to the scanner) or a pinned ISBN on an open item (which 12-repo would
       then write to the candidate namespace — the exact conflation this file
       exists to prevent). */
    if (incoming.scope) merged.scope = incoming.scope;
    if (incoming.isbnsPinned) merged.isbnsPinned = incoming.isbnsPinned;
    /* Candidates are local, lazily rebuilt state; an incoming empty list means
       "stripped for transport", never "this work has no editions". */
    merged.isbnsCandidate = local.isbnsCandidate || [];

    merged.release = pickRelease(local.release, incoming.release);
    merged.ratings = Object.assign({}, local.ratings, prune(incoming.ratings));
    merged.ids = Object.assign({}, local.ids, prune(incoming.ids));
    merged.facets = Object.assign({}, local.facets, pruneThin(incoming.facets));
    merged.meta = Object.assign({}, local.meta, {
      manualOverrides: (incoming.meta && incoming.meta.manualOverrides)
        || local.meta.manualOverrides,
    });
    return merged;
  }

  return {
    uidOf, parseUid,
    stubFromSearchDoc, fromWork, fromEdition, fromApiBooks,
    withDefaults, mergeItem, bucketGenres,
    leanForSync, absorbSynced,
    /* Exported below the contract line: internals that other M2 modules have a
       legitimate reason to reuse rather than re-implement. */
    buildRelease, emptyRelease, pickRelease, buildTerms,
    cleanSubjects, ensureGenres, absorbEditions, mergeAuthors, setPath,
    STATUS_RANK, CONFIDENCE,
  };
})();
