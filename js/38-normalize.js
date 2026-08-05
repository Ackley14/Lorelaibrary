/* ══════════════════════════════════════════════════════════════════════════
   Normalization — the single choke point where a remote payload may become a
   stored item. Nothing outside this file is allowed to read a raw catalogue
   response into a record.

   TWO SOURCES AND FIVE SHAPES, and they all look plausible while agreeing with
   each other about almost nothing:

     GOOGLE BOOKS — the primary source
     volume         ONE PRINTING, and by far the richest single payload in the
                    app: title, author NAMES, a real 'YYYY-MM-DD' publication
                    date, a description, BISAC categories, a page count, a
                    publisher, a cover URL and ISBNs — all in one response. What
                    it has NO concept of is a WORK: no editions-of-a-work
                    endpoint, no work id, and no author id space at all.

     OPEN LIBRARY — retained for the graph Google does not have
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

   Four things in here are load-bearing and are commented where they happen:

   1. IDENTITY. `book:<source>:<id>` — three parts, never two. `parseUid`
      rejoins everything after the second colon, which is what keeps
      alphanumeric OLIDs (`OL27482W`), Google volume ids (`LLSpngEACAAJ`) and
      13-digit ISBNs safe. The uid is immutable once assigned: it is the foreign
      key in snapshots, the feed, the URL, and every id-index row.

      `<source>` is now one of `openlibrary`, `isbn` or `googlebooks`. THE THIRD
      IS ONLY EVER MINTED FOR A BOOK OPEN LIBRARY HAS NEVER HEARD OF — which is
      the ordinary state of a forthcoming title and the reason the pivot
      happened. Where both catalogues hold the book, mergeSearchStubs keeps the
      Open Library uid, so every record already on the reader's shelves keeps
      deduping exactly as it did before. Nothing migrates and nothing is
      renumbered.

   4. THE CROSS-SOURCE MERGE (mergeSearchStubs) is where the two catalogues are
      reconciled: Open Library supplies identity and the work graph, Google
      supplies the metadata and the date, and pickRelease arbitrates so that a
      coarser answer can never overwrite a finer one in either direction.

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

  /* ══ THE IDENTITY FOLDS ═══════════════════════════════════════════════════
     "Is this the same book?" and "is this the same person?" are asked in four
     places — collapsing duplicate work records in search, collapsing Google's
     printings into books, merging a Google row against an Open Library one, and
     the date matcher's confidence test. ONE fold answers all four, because two
     folds is two answers and the disagreement shows up as a duplicate row that
     nobody can explain from either call site.

     ── TITLES ──────────────────────────────────────────────────────────────
     Folded for COMPARISON only, never for display. A trailing parenthetical is
     dropped — Google routinely appends edition furniture ('Dune (40th
     Anniversary Edition)') that Open Library does not, and without this every
     anniversary reissue fails a match it should pass.

     AND THE LEADING ARTICLE IS NORMALISED AWAY, because the two catalogues
     genuinely disagree about it and the disagreement is not an edge case.
     Measured live, on the exact book the date feature was built for:

         Open Library work OL37620147W  title 'Haunting of Velkwood'
         Google Books                   title 'The Haunting of Velkwood'
                                              publishedDate '2024-03-05'

     One row came back, it was unmistakably the right book, and an exact fold
     refused it — so the record kept its bare '2024'. Open Library drops or
     inverts the article on a large share of its work records; the MARC-derived
     ones carry the inverted form ('Hobbit, The'), which is the same
     disagreement written backwards, so both shapes are handled.

     Safe to drop, and this is the part worth being sure about: the article is
     never the distinguishing part of a title, and every caller pairs this with
     an author test. Two different books by one author whose titles differ ONLY
     by a leading 'the' is not a case that exists. */
  const ARTICLE_INVERTED = /,\s*(the|an|a)\s*$/i;
  const ARTICLE_LEADING = /^(the|an|a) /;
  /* A trailing parenthetical: '(Movie Tie-In)', '(40th Anniversary Edition)',
     '(Star Wars)'. Edition furniture a PRINTING carries and a WORK does not. */
  const TRAILING_PAREN = /\s*\([^)]*\)\s*$/;

  /* The display-safe title. Same strip foldTitle applies for COMPARISON, so a
     title can never render one way and match another. Used by fromVolume,
     where the payload is a printing rather than a work. */
  function stripEditionFurniture(s) {
    const out = String(s == null ? '' : s).replace(TRAILING_PAREN, '').trim();
    /* Never strip a title down to nothing. A volume genuinely titled
       '(Untitled)' would otherwise become a record with no title, which
       mergeItem discards outright. */
    return out || String(s == null ? '' : s).trim();
  }

  function foldTitle(s) {
    const trimmed = String(s == null ? '' : s)
      .replace(TRAILING_PAREN, '')
      /* Before normalizeTitle, which turns the comma into a space and destroys
         the only signal that says this is an inverted title rather than a real
         one ending in the word 'a'. */
      .replace(ARTICLE_INVERTED, '');
    return BT.util.normalizeTitle(trimmed).replace(ARTICLE_LEADING, '');
  }

  /* ── PEOPLE ──────────────────────────────────────────────────────────────
     Surnames rather than full names, because every catalogue in this app
     disagrees about initials and middle names far more often than about the
     family name: 'J.R.R. Tolkien', 'J. R. R. Tolkien' and 'John Ronald Reuel
     Tolkien' are one author and three strings. */
  function surnameOf(name) {
    const parts = BT.util.normalizeTitle(name).split(' ').filter(Boolean);
    /* Single-token names are real ('Homer', 'Colette') and are their own
       surname; for everything else the last token is the family name. */
    return parts.length ? parts[parts.length - 1] : '';
  }

  function surnameSet(names) {
    const out = new Set();
    for (const n of arr(names)) {
      const s = surnameOf(typeof n === 'string' ? n : (n && n.name) || '');
      if (s) out.add(s);
    }
    return out;
  }

  /* `surname|first initial`, AND THE INITIAL IS THE WHOLE POINT.

     A surname-only test is not close enough, and the failure is not
     theoretical — it was measured on this app's own search screen. Live
     `q=dune` returns, from two catalogues:

         Google        'Dune', Frank Herbert, publishedDate 1990-09-01
         Open Library  OL893414W  'Dune', Frank Herbert, 1965
                       OL19618275W 'Dune', BRIAN Herbert, 2001

     Same folded title, same surname. On a surname test the Google row merged
     with the WRONG Open Library work — Brian's — and the merged row then took
     Google's 1990 printing date because it was earlier than Brian's 2001,
     rendering the most famous novel in the list as "Dune, Sep 1 1990" under an
     identity belonging to a different book. Two errors from one loose compare.

     The same notch keeps Tabitha King out of Stephen King's bibliography in
     25-googlebooks' credit check, which is the same fold asking the same
     question about a different payload. */
  function personKey(name) {
    const parts = BT.util.normalizeTitle(name).split(' ').filter(Boolean);
    if (!parts.length) return '';
    const last = parts[parts.length - 1];
    return parts.length > 1 ? `${last}|${parts[0][0]}` : last;
  }

  /* Do two person keys name one person? Exact, or the same surname where one
     side carries no forename at all — a follow stored as a bare surname, a
     volume credited to 'Colette'. Where BOTH sides have a forename the initials
     must agree, because that is the only thing separating Frank from Brian. */
  function personMatches(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [sa, ia] = a.split('|');
    const [sb, ib] = b.split('|');
    if (sa !== sb) return false;
    return !ia || !ib;
  }

  /* A grouping key for rows FROM ONE SOURCE, where author order is consistent:
     folded title plus the primary author's person key. Used to collapse
     Google's printings into books and to collapse near-duplicate search rows.

     personKey rather than the bare surname for the reason above: 'Dune' by
     Frank Herbert and 'Dune' by Brian Herbert are two books, and a key that
     folds them together silently deletes one of them from the results.

     Returns '' for anything untitled, and a caller must drop those rather than
     bucket them together — a shared empty key folds every untitled record into
     one. */
  function matchKey(title, authors) {
    const t = foldTitle(title);
    if (!t) return '';
    const first = arr(authors).map(a => (typeof a === 'string' ? a : (a && a.name) || ''))
      .find(Boolean) || '';
    const p = personKey(first);
    return p ? `${t}|${p}` : t;
  }

  /* "Are these two records the same book?" — the CROSS-SOURCE test, and it is
     looser than matchKey in exactly one way: it compares author SETS rather
     than primary authors, because Google and Open Library disagree about author
     order on anthologies and collaborations constantly, and insisting on the
     same person being listed first would refuse a genuine match on a
     co-authored book. It is NOT looser about who the people are.

     An author-less side is admitted on the title alone. That is a real risk and
     a bounded one — the alternative is refusing to merge a Google row against
     the Open Library work record it obviously belongs to whenever Open Library
     lost the byline, which produces two rows for one book on the search screen
     and, worse, adds the book twice. */
  function personKeys(authors) {
    const out = [];
    for (const a of arr(authors)) {
      const k = personKey(typeof a === 'string' ? a : (a && a.name) || '');
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }

  function sameBook(a, b) {
    if (!a || !b) return false;
    const ta = foldTitle(a.title), tb = foldTitle(b.title);
    if (!ta || ta !== tb) return false;
    const ka = personKeys(a.authors);
    const kb = personKeys(b.authors);
    if (!ka.length || !kb.length) return true;
    for (const x of ka) for (const y of kb) if (personMatches(x, y)) return true;
    return false;
  }

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

  /* HOW FINE A DATE IS, as an ordinal — deliberately separate from CONFIDENCE,
     which mixes precision together with how much the SOURCE FIELD is trusted.
     pickRelease needs both and needs them apart: confidence answers "which of
     these two is the better answer", and this answers "would taking the fresh
     one throw information away".

     `tba` and `unknown` share rank 0 because neither carries a date at all;
     they are told apart by `status`, not by this table. */
  const PRECISION_RANK = { unknown: 0, tba: 0, year: 1, quarter: 2, month: 3, day: 4 };
  const precisionRank = p => (PRECISION_RANK[p] != null ? PRECISION_RANK[p] : 0);

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
    /* Google Books `publishedDate` on a volume, which is an EDITION-level
       field and is trusted like one. It earns the full factor because it is
       the only source in the app that ever states a month or a day: Open
       Library is year-granular by construction, so a Google date is not a
       second opinion about the same figure, it is the finer half of a figure
       we only had the front of. Reached only through js/25-googlebooks.js,
       and only when the user supplied a key. */
    'googlebooks-published': 1,
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
      /* WHICH SERVICE SUPPLIED THIS DATE. Distinct from `basis`, which says
         which FIELD it came out of; two sources can offer the same kind of
         field and disagree, and the reader is entitled to know which one is
         on screen when the app claims to know the day a book came out.

         It also stops a refresh fighting itself. Once a Google date has landed
         on a record, the next Open Library sweep arrives carrying the coarser
         year it always had; pickRelease already declines it, and this field is
         what lets a human confirm that from the pane instead of watching the
         date flicker and guessing.

         null on every record written before the Google path existed. Those
         dates all came from Open Library — it was the only source wired — so
         the UI is free to read null as 'openlibrary' and stay truthful. */
      dateSource: null,
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
       source    which SERVICE said so — 'openlibrary' | 'googlebooks'. See the
                 note on `dateSource` in emptyRelease.
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
    rel.dateSource = opts.source || null;

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

    /* PRECISION IS A RATCHET. A payload that is COARSER than what we already
       hold can never win, whatever its confidence says.

       The confidence comparison below looks like it already covers this and
       does not quite, because confidence multiplies precision by how much the
       source FIELD is trusted — so a month-precision date read off a
       half-weighted `first_publish_year` (0.8 × 0.5 = 0.4) ties exactly with a
       year-precision date off a full-weight edition field (0.4 × 1), and the
       tie goes to the fresh payload. That single case silently replaced
       'March 2024' with '2024', and it is the ordinary case for the Google
       date path: an item enriched to day precision gets swept by Open Library
       an hour later and handed back the bare year it always had.

       Note what this does NOT do. It only fires when the fresh date is
       strictly coarser, so a genuine correction at equal or finer precision
       still lands, and a finer date always beats a coarser one on the line
       below. A coarser date cannot correct a finer one anyway — there is
       nothing in '2012' that can tell you 'Mar 5, 2012' was wrong.

       This is the structural half of the never-downgrade guarantee; the other
       half is in 25-googlebooks.js, which declines to spend a request at all
       when the record is already finer than year. Both exist because one of
       them is a policy and the other is an invariant.

       IT RUNS IN BOTH DIRECTIONS, which matters now that two catalogues are
       live. Google usually holds the finer date and usually wins — a
       full-weight day (1.0) against a half-weight year (0.2) is not close. But
       Google is coarse about the backlist ('The Hobbit, 2012 edition' ->
       '2012'), and an Open Library EDITION record occasionally carries a real
       day; in that case the ratchet refuses the Google year and Open Library
       keeps it. Neither source is trusted by name here. Precision is. */
    if (precisionRank(fresh.precision) < precisionRank(existing.precision)) {
      return keep(existing);
    }

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

  /* One table, one subject, first rule wins. Pulled out of bucketGenres so the
     custom-genre table can be scanned the same way WITHOUT the two tables
     sharing a single first-wins scan — see the note at the second call site,
     which is the whole reason this is a separate function.

     `rankBase` offsets the rule's index so that ties WITHIN a table are broken
     by specificity, the way the table is ordered. `mine` marks a hit as coming
     from the user's own table, which is what the cap below reads — see the
     RESERVED SLOT note there. */
  function scanRules(rules, subject, hits, rankBase, mine) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule.match.some(rx => rx.test(subject))) continue;
      const cur = hits.get(rule.bucket) || { count: 0, rank: rankBase + i, mine: !!mine };
      cur.count++;
      hits.set(rule.bucket, cur);
      return;
    }
  }

  /* Map noisy subjects onto at most three buckets.

     THREE ordering rules now, and all of them matter:

     1. WITHIN a subject and WITHIN one table, the FIRST matching rule wins and
        matching stops. That is why BT.GENRE_RULES is ordered specific-first:
        'Fantasy fiction', 'Detective and mystery stories' and 'Love stories'
        all contain or imply fiction, so testing `fiction` first would collapse
        every genre in the app into one.

     2. ACROSS subjects, buckets are ranked by how many subjects hit them, ties
        broken by rule order (i.e. by specificity). Count first, because a work
        with fourteen mystery subjects and one stray 'Fiction' is a mystery;
        specificity second, because at equal counts the reader wants the chip
        that tells them something. Three is the cap — BT.ui draws two and the
        third is a spare for the facet tree; past that every extra bucket is
        less specific than the ones before it.

     3. THE USER'S OWN KEYWORD RULES ARE A SEPARATE TABLE, scanned in a second
        pass over the same subject, and they can only ever ADD a bucket. The
        argument is at the call site below.

     4. A BUCKET THE USER ASKED FOR IS NOT A GUESS, and the cap must not treat
        it like one. Rules 2 and 3 alone had a bug you could not see from the
        code: John Langan's The Fisherman carries the subjects 'Horror',
        'Fiction', 'Fantasy', 'Weird Fiction', 'Thriller', 'Mystery',
        'Supernatural' and 'cosmic horror'. A custom "Weird Fiction" keyed on
        'weird fiction, cosmic horror' matched TWO of those — an exact,
        deliberate hit — but tied on count with `fantasy` and `mystery`, lost
        both ties to the built-ins, and was cut by slice(0, 3). Settings then
        reported "Re-bucketed 0 books" and the shelf the reader had just built
        stayed empty, which reads as the whole feature being broken.

        So the tie goes to the user, and one slot in the three is reserved for
        them. The built-in table still scans first and still takes first claim
        on every subject — a custom rule can never take Horror away from a
        horror novel — but where the machine is guessing at equal evidence, the
        rule somebody typed on purpose wins, and it can never be crowded out
        entirely by guesses. Count still leads: a book with six mystery
        subjects and one weird-fiction subject is still a mystery first. */
  function bucketGenres(subjects) {
    const clean = cleanSubjects(subjects);
    /* The user's own keyword rules, compiled once by BT.genres and empty for
       anybody who has not made a genre. Read defensively so this module stays
       usable by a host that loaded the normalizer without the config file. */
    const custom = (BT.genres && BT.genres.rules()) || [];
    const hits = new Map();
    for (const s of clean) {
      scanRules(BT.GENRE_RULES, s, hits, 0);
      /* A SECOND, SEPARATE PASS over the same subject rather than one scan of
         a concatenated table, and the difference is the whole behaviour of
         custom genres.

         Appended to the built-in table, a custom rule could only ever be
         reached by a subject NO built-in claimed — 'Weird fiction' is already
         taken by horror on the first rule in the table, so a custom "Weird
         Fiction" with that keyword would never once match and would look
         broken. Put ABOVE the built-ins it would be worse: a keyword typed in
         Settings could quietly take 'Fiction' away from every book on the
         shelf at the next recalculation.

         Scanning separately means a custom genre is purely ADDITIVE. It cannot
         change what the built-in rules make of a subject, and a book whose
         subject says 'Weird fiction' lands in Horror AND in the user's own
         bucket — which is correct, not a double-file: they are two different
         claims about one book, and the three-bucket cap below still applies. */
      scanRules(custom, s, hits, BT.GENRE_RULES.length, true);
    }
    /* `general` is reached ONLY by falling through. There is no `general` rule
       in the table for the same reason: a bucket you can arrive at two ways is
       a bucket whose contents nobody can explain. */
    if (!hits.size) return [genre('general')];

    /* Count, then the user's own over a built-in guess, then specificity. */
    const ranked = [...hits.entries()].sort((a, b) =>
      (b[1].count - a[1].count)
      || ((b[1].mine ? 1 : 0) - (a[1].mine ? 1 : 0))
      || (a[1].rank - b[1].rank));

    const top = ranked.slice(0, 3);
    /* THE RESERVED SLOT. If the user's rules matched at all and the cap still
       cut every one of them, the weakest guess in the three gives up its place
       to the strongest of theirs. Only ever one slot: the cap exists because
       the fourth bucket is always noise, and a reader with six custom genres
       should not get a row of six chips — but "you matched, and you were
       dropped anyway" is the one outcome that makes the feature look broken. */
    if (ranked.length > 3 && !top.some(e => e[1].mine)) {
      const best = ranked.find(e => e[1].mine);
      if (best) top[top.length - 1] = best;
    }
    return top.map(([id]) => genre(id));
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

    /* ── ONE PERSON MUST NOT ARRIVE UNDER TWO KEYS ────────────────────────
       An author who has just been GIVEN an OLID changes key, and a union keyed
       on identity reads a re-key as a new person unless it is told otherwise.

       The path, verified live on `the hobbit`: a Google-sourced record holds
       { id: 'john-ronald-reuel-tolkien', olid: '' } — Google has no author id
       space, so the key is the folded name. Hydrating from the work supplies
       Open Library's author key, and 20-openlibrary's defendGoogleFields
       correctly stitches it onto the name Google printed, handing this function
       { id: 'OL26320A', olid: 'OL26320A' } for the same man. Those two keys
       cannot collide, so the byline listed John Ronald Reuel Tolkien TWICE,
       `idx.authorIds` carried both ids, and every author facet, count and
       Follow button saw one writer as two.

       UNREACHABLE BEFORE THE EDITION-GRAPH BRIDGE, which is why it surfaces
       now: a Google-only record had no work id, so it was never hydrated from
       Open Library at all and the stitch never ran. Resolving the graph is
       precisely what makes that hydrate happen, so without this the bridge
       would have added one duplicate author per Google-added book.

       The rules are mergeAuthorIdentities' rules, one merge later, because it
       is the same question asked at search time and the two must not disagree:
       match on `personKey`, claim each row at most once, and never fold a name
       that folds to nothing — Open Library's transliterated duplicate rows
       ('Френк Герберт' beside 'Frank Herbert') have an empty key and must stay
       separate rather than silently absorb somebody.

       ONLY AN OLID-LESS ROW IS ADOPTABLE. A row that already carries a
       different OLID is a different person and is left alone; Open Library
       says so and it is the only side with an id space to say it with. */
    const adoptable = new Map();
    for (const [k, a] of byId) {
      if (a.olid) continue;
      const p = personKey(a.name);
      if (!p) continue;
      /* Two id-less rows folding alike is an ambiguity — an anthology with two
         J. Smiths — and there is nothing here to break the tie with. Marked
         unadoptable so the fresh row is appended rather than guessed at. */
      if (adoptable.has(p)) { adoptable.set(p, ''); continue; }
      adoptable.set(p, k);
    }

    for (const f of arr(fresh)) {
      if (!f) continue;
      const k = key(f);
      if (!byId.has(k) && f.olid) {
        const p = personKey(f.name);
        const from = p ? adoptable.get(p) : '';
        if (from && byId.has(from)) {
          const cur = byId.get(from);
          byId.delete(from);
          adoptable.delete(p);
          byId.set(k, Object.assign({}, cur, f, {
            /* The EXISTING name wins, which is the opposite of the ordinary
               branch below and deliberate: on a Google-primary record it is the
               spelling defendGoogleFields just protected, and it is also the
               string a follow has to query Google with, since Google matches on
               its own byline and nothing else. */
            name: cur.name || f.name,
            gbName: cur.gbName || f.gbName || '',
            /* Explicit null test, not `||`: the FIRST author's order is 0, and
               a falsy check would hand position 0 whatever the fresh payload
               said and quietly reorder the byline. Existing order wins for the
               same reason the existing name does — the two catalogues order
               bylines differently on anthologies and collaborations (see
               mergeAuthorIdentities), and the order on screen is the one the
               reader has already seen. */
            order: cur.order != null ? cur.order : (f.order || 0),
          }));
          continue;
        }
      }
      const cur = byId.get(k);
      if (!cur) { byId.set(k, Object.assign({}, f)); continue; }
      byId.set(k, Object.assign({}, cur, f, {
        name: f.name || cur.name,
        olid: f.olid || cur.olid,
      }));
    }
    return [...byId.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /* ══ DUAL AUTHOR IDENTITY ════════════════════════════════════════════════
     One person, two names, and BOTH have to be kept.

     A follow is only reliable when it is keyed on an Open Library OLID — a
     name-scoped author query answers `author=gwendolyn+kiste` with LAIRD
     BARRON'S bibliography at HTTP 200, so a name-keyed follow is not a degraded
     follow, it is a confident feed of the wrong writer.

     But Google has no author id space AT ALL, so the Google half of that
     follow can only ever be queried by name — and it has to be Google's OWN
     spelling of the name, because that is the string its index matches on.
     'J.R.R. Tolkien' and 'J. R. R. Tolkien' are one author and two query
     results. Google will have the forthcoming book; Open Library will not. So
     the OLID without the Google name is a follow that cannot see what is
     coming, and the Google name without the OLID is a follow that may be
     watching a stranger.

     This function is where the two are joined, at the one moment both are on
     the table: a search row that Google and Open Library both returned. The
     merged author carries

         name    Google's exact string — the display name AND the Google query
         gbName  the same string, kept under its own key so a caller can tell a
                 name that came FROM Google from one that merely survived a
                 merge. A follow stores this verbatim.
         olid    Open Library's id — the Open Library query, and the follow key

     Matched on `personKey` (surname + first initial) rather than on the exact
     string, because the exact strings are what disagree. Where the counts and
     the keys do not line up — an anthology Open Library credits to nine people
     and Google to two — the unmatched Google names are kept without an OLID
     rather than paired by position, and a follow simply is not offered for
     them. An unfollowable author is visible and harmless; a follow pointing at
     the wrong person is neither. */
  function mergeAuthorIdentities(gbAuthors, olAuthors) {
    const ol = arr(olAuthors).filter(Boolean);
    const taken = new Set();
    const out = [];

    arr(gbAuthors).filter(Boolean).forEach((g, i) => {
      const want = personKey(g.name);
      let match = null;
      for (let j = 0; j < ol.length; j++) {
        if (taken.has(j) || !ol[j].olid) continue;
        /* An Open Library author record reached through a WORK carries a key
           and no name (see authorsFromKeys), so there is nothing to compare —
           those are left for the positional pass in 20-openlibrary's
           defendGoogleFields, which only runs when there is exactly one of
           each and therefore no ambiguity to get wrong. */
        if (!ol[j].name || !personMatches(personKey(ol[j].name), want)) continue;
        match = ol[j]; taken.add(j); break;
      }
      out.push({
        id: (match && match.olid) || g.id || slug(g.name),
        olid: (match && match.olid) || '',
        name: g.name,
        gbName: g.gbName || g.name,
        role: g.role || 'author',
        order: i,
        source: match ? 'merged' : 'googlebooks',
      });
    });

    /* Anyone Open Library credits that Google did not. Kept because a byline
       missing a co-author is a wrong byline, and they are followable — they
       have an OLID. They have no Google name, which is the honest state: the
       Google half of that follow will have to fall back to the OLID's own
       recorded name.

       EXCEPT A NAME THAT FOLDS TO NOTHING. Open Library carries transliterated
       duplicate author records — the live `q=dune` work OL893414W is credited
       to both 'Frank Herbert' and 'Френк Герберт', which are one man and two
       rows. `personKey` folds to the empty string for a name with no Latin
       characters at all, so such a row can never be matched to a Google author
       and would sit in the byline for ever as a second, unfollowable-in-
       practice copy of somebody already listed. Dropped only when Google
       supplied a byline to compare against — with no Google side there is
       nothing better available and the row is the only credit there is. */
    ol.forEach((a, j) => {
      if (taken.has(j) || !a.name) return;
      if (out.length && !personKey(a.name)) return;
      out.push(Object.assign({}, a, { order: out.length, gbName: a.gbName || '' }));
    });

    return out;
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
      { basis: 'work-first-published', source: 'openlibrary',
        inPrint: !!(doc.edition_count || doc.cover_i) });

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

  /* ══════════════════════════════════════════════════════════════════════════
     GOOGLE VOLUME → ITEM
     ══════════════════════════════════════════════════════════════════════════
     The primary metadata shape. A Google volume is ONE PRINTING and carries, in
     a single response, everything the four Open Library shapes only manage
     between them: title, author NAMES, a real publication date, a description,
     BISAC categories, a page count, a publisher, a cover URL and ISBNs.

     SO IT IS BOTH THE SEARCH STUB AND THE DETAIL RECORD, which is why there is
     one function here rather than the stub/work/edition trio Open Library
     needs. `opts.partial` is the only difference between the two uses, and it
     means something specific: "an Open Library work record is known to exist
     for this book and will fill in the work-level half". A Google-ONLY row sets
     it to 0, because there is genuinely nothing more to fetch — leaving it at 1
     would re-run a hydrate that can only ever return null, once per pane open,
     for ever.

     SCOPE IS 'open' BY DEFAULT AND THAT IS NOT A COMPROMISE. A volume names one
     printing, but a reader who searched for "Dune" meant the book — pinning the
     printing Google's ranker happened to return would stamp a publisher, an
     extent and an ISBN onto the record that they never chose. So the ISBNs go
     to `isbnsCandidate`, never `isbnsPinned`. The scan door passes
     `opts.isbn13` and gets 'closed', which is the one case where the reader
     really did name a printing: they were holding it.

     ── WHY NO WORK OLID IS INVENTED ────────────────────────────────────────
     Google has no work concept at all. There is no id here that could become
     `ids.olWork`, and guessing one from a title match would put a wrong
     `olwork:` row in the id index — which is a silent dedup failure that makes
     two different books resolve to one item. The merge with an Open Library row
     (mergeSearchStubs, below) is the ONLY way a Google record acquires a work
     id, and it does so from an Open Library record that actually stated it. */

  function isbnsFromVolume(raw) {
    const out = [];
    for (const row of arr(raw && raw.volumeInfo && raw.volumeInfo.industryIdentifiers)) {
      const t = row && row.type;
      if (t !== 'ISBN_10' && t !== 'ISBN_13') continue;
      const v = String((row && row.identifier) || '').toUpperCase().replace(/[^0-9X]/g, '');
      const c = v.length === 13
        ? (BT.util.isValidEan13(v) ? v : '')
        : (v.length === 10 ? (BT.util.isbn10to13(v) || '') : '');
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    return out;
  }

  /* BISAC headings arrive as one slash-delimited string per category:
     'Fiction / Fantasy / Epic', 'Juvenile Fiction / Fantasy & Magic'. Both the
     whole heading AND its segments are kept as subjects.

     The whole heading matters because BT.GENRE_RULES is written to match those
     compound strings directly ('Juvenile Fiction / Fantasy & Magic' is one
     string and only one rule may claim it — see the ordering note in
     00-config.js). The segments matter because `rec.terms` is a taste vector,
     and 'Epic' on its own is a term two epic fantasies can actually share while
     the full heading is too specific to ever collide. */
  function expandCategories(categories) {
    const out = [];
    for (const c of arr(categories)) {
      const s = String(c || '').trim();
      if (!s) continue;
      out.push(s);
      if (s.indexOf('/') < 0) continue;
      for (const part of s.split('/')) {
        const p = part.trim();
        if (p && out.indexOf(p) < 0) out.push(p);
      }
    }
    return out;
  }

  const GB_BASE = 'https://books.google.com';

  function fromVolume(raw, opts) {
    opts = opts || {};
    if (!raw || !raw.id) return null;
    const info = raw.volumeInfo || {};
    const id = String(raw.id);

    const rawTitle = String(info.title || '').trim();
    /* A volume with no title is not a record. It would also be discarded by
       mergeItem a moment later, so it is refused here where the caller can
       still tell the difference between "nothing came back" and "something
       unusable came back". */
    if (!rawTitle) return null;

    /* EDITION FURNITURE IS STRIPPED FROM THE DISPLAY TITLE, and the original is
       kept in `originalTitle` so nothing is lost.

       A Google volume is ONE PRINTING and its title is that printing's title,
       marketing and all. Measured live on `q=dune`, on separate runs, the top
       result was titled 'Dune' once and 'Dune (Movie Tie-In)' the next — same
       book, same author, same catalogue, different printing promoted by the
       ranker that day. The parenthetical is not part of the novel's title, and
       carrying it through does two visible kinds of damage:

         · the row reads 'Dune (Movie Tie-In)' to somebody who typed 'dune';
         · it MISSES THE EXACT-TITLE BOOST in 61-view-search's rerank, which
           compares the normalised title against the normalised query. On the
           run where Google promoted the tie-in, the real novel fell to third
           behind two Brian Herbert sequels that did match exactly — which is
           FAILURE 1, the whole reason that re-ranking exists, arriving through
           a side door.

       Stripped with the same rule foldTitle already uses for COMPARISON, so
       display and matching cannot disagree about what a title is. Titles that
       genuinely end in a parenthetical are vanishingly rare in book
       cataloguing, and the raw string is one field away. */
    const title = stripEditionFurniture(rawTitle);

    const isbns = isbnsFromVolume(raw);
    const scanned = opts.isbn13 && BT.util.isValidEan13(opts.isbn13) ? String(opts.isbn13) : null;
    const closed = !!scanned || opts.scope === 'closed';
    /* THE SCANNED CODE WINS ABSOLUTELY, exactly as it does in pinnedIsbns for
       an Open Library edition, and for the same measured reason: field presence
       is unreliable enough that a record fetched BY ISBN can come back without
       carrying it, and round-tripping the barcode through the response pins the
       book to nothing. Trust what came off the barcode. */
    const pinned = closed ? [...new Set((scanned ? [scanned] : []).concat(isbns))] : [];

    const rawSubjects = expandCategories(info.categories);
    const subjects = cleanSubjects(rawSubjects);
    /* Empty in, nothing out — see ensureGenres. A volume with no categories
       must not answer "General" over a bucket an Open Library work record
       already worked out. */
    const genres = subjects.length ? bucketGenres(rawSubjects) : [];

    const authors = authorsFromNames(info.authors);
    /* Author records from Google carry NO id of any kind — there is no author
       id space in this API — so `olid` stays empty and `id` falls back to the
       name slug. Marked with their true source so nothing downstream mistakes a
       name-derived id for an OLID.

       `gbName` is the EXACT string Google's index matches on, kept under its own
       key rather than left to be inferred from `name` later. A follow stores it
       verbatim, because a follow that queries Google with Open Library's
       spelling of a name gets a different result set — see the dual-identity
       note above mergeAuthorIdentities. */
    for (const a of authors) { a.olid = ''; a.source = 'googlebooks'; a.gbName = a.name; }

    const release = buildRelease(info.publishedDate || '', {
      basis: 'googlebooks-published',
      source: 'googlebooks',
      /* A volume in the index is a book that exists — including one that has
         not published yet, which the date itself then says. */
      inPrint: true,
    });

    const publishers = info.publisher ? publishersOf({ publishers: [info.publisher] }) : [];
    const series = seriesOf(info);
    const language = BT.lang.short(info.language);

    const item = {
      uid: uidOf('googlebooks', id),
      kind: KIND,
      scope: closed ? 'closed' : 'open',
      facets: {},

      ids: {
        /* No work id and no edition OLID: Google has neither. `isbn13` is set
           only on a CLOSED record, because 59-editions reads it as part of the
           pinned set and an open item claiming it would render an arbitrary
           printing as already chosen. */
        olWork: null, workOlid: null,
        olEdition: null, editionOlid: null,
        isbn13: closed ? (pinned[0] || null) : null,
        isbn10: null,
        goodreads: null, librarything: null, oclc: null, lccn: null,
        googlebooks: id,
      },

      title,
      subtitle: String(info.subtitle || '').trim(),
      /* The printing's own title, verbatim. Kept because it is real data and
         because rankByRelevance scores it as a second haystack — a reader who
         genuinely types "dune movie tie in" should still find the row. */
      originalTitle: rawTitle,
      description: String(info.description || ''),
      firstSentence: '',

      authors,
      publishers,
      pageCount: posInt(info.pageCount),
      languages: language ? [language] : [],

      subjects,
      subjectFacets: { people: [], places: [], times: [] },
      genres,
      /* `coverUrl` rather than a cover id, because Google's covers are not
         Open Library's and there is no id to rebuild one from. BT.ui.posterUrl
         passes an absolute URL straight through; BT.GB.cover has already forced
         https, stripped the server-side page-curl effect and set the zoom. */
      images: {
        coverId: null,
        covers: [],
        coverUrl: BT.GB.cover(info.imageLinks, 'lg'),
        source: 'googlebooks',
      },

      release,
      firstPublishYear: null,

      /* CANDIDATES, NEVER PINNED, on an open record. A volume's one or two
         ISBNs are far short of the forty a work carries, but the namespace rule
         is about MEANING rather than count: an open item has not told us which
         copy is on the shelf, so its ISBNs are possibilities the scanner may
         offer to pin — not an ownership claim that would make a later scan of
         that printing refuse to add anything. See the block above pinnedIsbns. */
      isbnsPinned: pinned,
      isbnsCandidate: closed ? [] : isbns,
      /* Google cannot say how many printings exist — it has no work graph — so
         this stays null rather than being guessed from a result count. The
         editions picker resolves an Open Library work from a candidate ISBN when
         the reader actually opens it. */
      editionsTotal: null,
      editionsSeen: 0,
      editionsFetchedAt: 0,

      /* Google's own ranking is the popularity signal on this side, and it is
         supplied by the caller (search order) rather than read off the record —
         `ratingsCount` is present on a minority of volumes and is a Google Play
         Books figure rather than a readership one. Kept so the search view's
         tiebreak has something when it is there. */
      pop: posInt(info.ratingsCount) || 0,

      links: { googlebooks: BT.GB.infoLink(id) || `${GB_BASE}/books?id=${id}` },
      externalLinks: [],
      ratings: info.averageRating ? {
        googlebooks: { score: Number(info.averageRating), votes: posInt(info.ratingsCount) || 0 },
      } : {},

      rec: {
        fetchedAt: Date.now(),
        franchiseKey: series.key ? `series:${series.key}` : null,
        terms: buildTerms({ genres, subjects, authors, publishers, seriesKey: series.key }),
        candidates: {},
        seedEligible: 1,
      },
      meta: {
        schema: 1,
        primarySource: 'googlebooks',
        detailsFetchedAt: opts.partial ? 0 : Date.now(),
        normalizerVersion: 1,
        partial: opts.partial ? 1 : 0,
        manualOverrides: {},
      },
    };

    if (series.name) item.seriesName = series.name;
    /* Identity prefers the ISBN on a CLOSED record — that is what the reader
       will scan again — and the volume id otherwise. An open record keeps the
       volume id even when it carries ISBNs, because `book:isbn:…` is the uid of
       a specific copy and an open item is not one. */
    if (closed && pinned[0]) item.uid = uidOf('isbn', pinned[0]);
    return item;
  }

  /* The search-result flavour. `partial: 1` because a merged row is expected to
     be filled out from Open Library's work record afterwards; a Google-only row
     is created with `fromVolume(vol)` directly and is complete as it stands. */
  const stubFromVolume = (raw, opts) =>
    fromVolume(raw, Object.assign({ partial: 1 }, opts || {}));

  /* ══════════════════════════════════════════════════════════════════════════
     THE CROSS-SOURCE MERGE
     ══════════════════════════════════════════════════════════════════════════
     -> ONE item from a Google row and the Open Library row that is the same
        book. This is the single place the two catalogues are reconciled, and
        the division of spoils is not a preference — each side supplies what it
        is measurably better at.

     IDENTITY COMES FROM OPEN LIBRARY, ALWAYS, and this is the migration-safety
     rule as much as a modelling one. The uid stays `book:openlibrary:{OLID}`
     and `ids.olWork` is preserved, so:

       · a book already on the reader's shelves still dedupes — BT.ui.addItem
         resolves `olwork:{OLID}` and finds it, exactly as it did before the
         pivot. Minting a Google uid here would make every book in an existing
         library addable a second time.
       · the editions picker, the scanner's candidate net and every stored
         snapshot keep working unchanged.

     METADATA COMES FROM GOOGLE, because that is the whole point of the pivot:
     the live `q=dune` Open Library row is titled 'Dune', credited to BRIAN
     Herbert and dated 2001. Taking its title and byline over Google's would
     reinstate the exact defect being fixed.

     THE DATE GOES THROUGH pickRelease AND IS NOT SIMPLY TAKEN. Google usually
     wins — a full-weight day beats a half-weight year — but "usually" is not
     "always", and the ratchet in pickRelease is what guarantees a COARSER
     answer can never overwrite a finer one whichever side it came from. A
     Google volume for a backlist title often carries a bare year while an Open
     Library EDITION record occasionally carries a real day; in that one case
     Open Library is right and keeps it.

     SUBJECTS COME FROM OPEN LIBRARY WHERE IT HAS ANY. Its subject headings are
     a far richer taste signal than BISAC categories — 'Dune (Imaginary place)'
     and 'Ecology in literature' say more about a reader than 'Fiction /
     Science Fiction' — and `rec.terms` is what the recommender runs on. */
  /* ── WHEN DID THIS *WORK* COME OUT? ─────────────────────────────────────
     -> the Google release to merge, or null to leave Open Library's alone.

     GOOGLE'S INDEX IS PRINTINGS, AND ITS RANKER PREFERS RECENT ONES. Measured
     live: `q=dune`, first result, correctly titled *Dune* and correctly credited
     to Frank Herbert — `publishedDate: '1990-09-01'`. That is a real date about
     a real object, and it is the wrong date for the row, because a search
     result is a WORK. Taking it verbatim renders "Dune, Sep 1 1990" for the
     most famous novel in the list, and it would do it for every backlist
     classic, precisely because Google is best at recent trade publishing.

     So the same YEAR GATE the date-upgrade path uses (see findVolumeFor in
     25-googlebooks.js) is applied here, and it reads as three cases:

       same year        Google is SHARPENING a year Open Library already holds.
                        '2024' + '2024-03-05' -> Mar 5, 2024. This is the case
                        the whole pivot exists for, and it is the common one.
       Google is LATER  Google is showing a reprint of an older book. Open
                        Library's year stands. This is the Dune case.
       Google is EARLIER  Open Library's `first_publish_year` is a computed
                        minimum over its edition records, so being beaten
                        downward means it missed the first printing. The earlier
                        date is the work's.

     WHAT THIS COSTS, stated honestly: where Open Library's year is simply wrong
     and TOO EARLY — The Alloy of Law, published 2011, reports 2001 — the gate
     refuses Google's correct 2011 date and the row keeps 2001. That is exactly
     what the app displayed before the pivot, so it is not a regression, and it
     is bounded to work-level search rows: once such a book is added, the
     enrichment path and any pinned edition can still correct it.

     NONE OF THIS APPLIES TO A GOOGLE-ONLY ROW. There is no Open Library
     release to gate against — mergeSearchStubs is not even called — so a
     forthcoming title keeps its real street date untouched. That is the whole
     point of asking Google. */
  function workDate(olRel, gbRel) {
    if (!gbRel || gbRel.sortKey >= BT.util.SK_UNKNOWN) return null;
    if (!olRel || olRel.sortKey >= BT.util.SK_UNKNOWN) return gbRel;
    const g = BT.util.sortKeyToParts(gbRel.sortKey);
    const o = BT.util.sortKeyToParts(olRel.sortKey);
    if (!g || !o) return gbRel;
    return g.y > o.y ? null : gbRel;
  }

  /* Which of two printings dates the WORK. Earliest wins, and precision only
     breaks a tie on the same day — the opposite priority from pickRelease,
     and deliberately so. pickRelease arbitrates a REFRESH of one record, where
     throwing away precision loses information; this arbitrates between SIBLING
     PRINTINGS of one book, where the question is "when did this book come
     out" and the answer is the first time it did. */
  function earlierRelease(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ad = a.sortKey < BT.util.SK_UNKNOWN;
    const bd = b.sortKey < BT.util.SK_UNKNOWN;
    if (ad !== bd) return ad ? a : b;
    if (!ad) return a;
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? a : b;
    return precisionRank(b.precision) > precisionRank(a.precision) ? b : a;
  }

  function mergeSearchStubs(gb, ol) {
    if (!gb) return ol;
    if (!ol) return gb;

    const out = Object.assign({}, gb);

    out.uid = ol.uid;
    out.scope = 'open';
    out.ids = Object.assign({}, gb.ids, prune(ol.ids), { googlebooks: gb.ids.googlebooks });
    out.links = Object.assign({}, ol.links, gb.links);

    /* Google's title and byline lead; Open Library fills a gap rather than
       overriding one. The author merge is the DUAL IDENTITY join — Google's
       exact name string plus Open Library's OLID on one record — and it is the
       only moment in the app where both are on the table at once. See
       mergeAuthorIdentities. */
    out.title = gb.title || ol.title;
    out.subtitle = gb.subtitle || ol.subtitle;
    out.authors = mergeAuthorIdentities(gb.authors, ol.authors);

    out.release = pickRelease(ol.release, workDate(ol.release, gb.release));
    out.firstPublishYear = ol.firstPublishYear != null ? ol.firstPublishYear : null;

    out.description = gb.description || ol.description || '';
    out.subjects = (ol.subjects && ol.subjects.length) ? ol.subjects : (gb.subjects || []);
    out.genres = (ol.genres && ol.genres.length) ? ol.genres : (gb.genres || []);
    out.pageCount = gb.pageCount || ol.pageCount || null;
    out.languages = (gb.languages && gb.languages.length) ? gb.languages : (ol.languages || []);

    /* COVER: Open Library's id wins where it has one, and dropping Google's URL
       is what makes that happen. BT.ui.posterUrl checks `images.coverUrl`
       FIRST — an absolute URL is treated as a deliberate override — so leaving
       both on the record would silently pick Google's ~256px thumbnail over
       Open Library's ~500px L. Where Open Library has no cover at all, Google's
       is the only one there is and it stays. */
    const olCover = ol.images && ol.images.coverId;
    out.images = olCover
      ? Object.assign({}, gb.images, ol.images, { coverUrl: null })
      : Object.assign({}, ol.images, gb.images);

    out.isbnsPinned = [];
    out.isbnsCandidate = [...new Set([].concat(gb.isbnsCandidate || [], ol.isbnsCandidate || []))];
    out.editionsTotal = ol.editionsTotal || null;

    /* Both popularity figures survive, because the search view asks two
       different questions of them and 61-view-search decides which. */
    out.pop = ol.pop || gb.pop || 0;

    out.rec = gb.rec && Object.keys((gb.rec.terms) || {}).length ? gb.rec : ol.rec;
    if (out.subjects && out.subjects.length) {
      out.rec = Object.assign({}, out.rec, {
        terms: buildTerms({
          genres: out.genres, subjects: out.subjects, authors: out.authors,
          publishers: out.publishers, seriesKey: null,
        }),
      });
    }

    out.meta = Object.assign({}, ol.meta, gb.meta, {
      primarySource: 'googlebooks',
      /* An Open Library work record IS known to exist, so the work-level half
         (subjects, description, the editions list that feeds the candidate
         net) is worth one hydrate. */
      partial: 1,
      detailsFetchedAt: 0,
      manualOverrides: {},
    });
    return out;
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
      source: 'openlibrary',
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
      source: 'openlibrary',
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
      source: 'openlibrary',
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

  /* ══ THE EDITION GRAPH ═══════════════════════════════════════════════════
     -> 'resolved' | 'unresolved' | 'unavailable'

     Google has no work concept — no editions endpoint, no work id, `related:`
     returns nothing — so a book added from a Google row has no edition list and
     no ISBN set beyond the one printing it came from. Open Library can supply
     both from a single ISBN lookup (`works[0].key`), and 48-sync owns the
     asking. This is the one place that answers what state a given record is in,
     so the sweep and the picker can never disagree about it.

     THE WORK ID IS THE AUTHORITY, NOT THE STORED STRING, and that ordering is
     what makes this need no migration at all. Every book already on the
     reader's shelves has `ids.olWork` and has never heard of `meta.editionGraph`
     — it reads 'resolved' on the first call, from the field it has always had.
     The same holds for a record arriving over encrypted sync from a device
     running an older build, and for a scanned book, which reaches the graph
     through its own ISBN and never comes near the bridge at all.

     `meta.editionGraph` therefore only ever records a NEGATIVE: we asked Open
     Library and it had nothing. Stamping it is 48-sync's job.

     'unavailable' is not "never look again" — see BT.EDITION_GRAPH. It means
     this book has been asked about for long enough that it stops riding its own
     refresh tier and drops to the slowest one. */
  function editionGraphOf(item) {
    const ids = (item && item.ids) || {};
    if (ids.olWork || ids.workOlid) return 'resolved';
    const state = (item && item.meta && item.meta.editionGraph) || '';
    return state === 'unavailable' ? 'unavailable' : 'unresolved';
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
      /* PRIMARY SOURCE IS THE RECORD'S ORIGIN, NOT THE LAST PAYLOAD'S, and
         letting a refresh rewrite it made 20-openlibrary's defence of Google's
         title and byline a ONE-SHOT.

         The path: a Google-sourced record is enriched from Open Library, which
         is now an ordinary and recurring thing rather than a rarity — resolving
         the edition graph is exactly what puts `ids.olWork` on such a record,
         and every sweep afterwards hydrates it from the work. `fromWork` stamps
         `primarySource: 'openlibrary'` in its own meta, so the FIRST enrichment
         (correctly defended by defendGoogleFields) rewrote the very flag that
         defence reads. The second one saw an Open Library record, defended
         nothing, and replaced a correct title and byline with Open Library's —
         live `q=dune` returns a work titled 'Dune' credited to BRIAN Herbert,
         which is the precise defect the pivot to Google exists to fix.

         Silently, weeks after the book was added, from a background sweep
         nobody watched. Origin is immutable for the same reason `uid` is. */
      primarySource: (existing.meta && existing.meta.primarySource)
        || (fresh.meta && fresh.meta.primarySource) || null,
    });

    /* A GRAPH THAT RESOLVED IS NOT UNRESOLVED ANY MORE. `ids.olWork` arrives
       through the id merge above — from a work hydrate, from a pinned edition,
       or from the ISBN bridge — and the negative stamp 48-sync left behind
       would otherwise outlive the condition it describes and keep the picker
       apologising in front of a list it could now draw. editionGraphOf reads
       the work id first so nothing is BROKEN by a stale string; it is cleared
       so that nothing has to be. */
    if (merged.ids.olWork || merged.ids.workOlid) {
      delete merged.meta.editionGraph;
      delete merged.meta.editionGraphTries;
      delete merged.meta.editionGraphSince;
      delete merged.meta.editionGraphAt;
    }

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
    /* `gbName` TRAVELS, and it is the one field here that looks derivable and
       is not. Google's index matches on its own spelling of a name, so the
       string is what a follow queries with — and it can only be re-derived by
       spending a Google request against a key the receiving device may not
       have. Twenty bytes to keep an author findable on a phone that has never
       seen the Google half. */
    out.authors = (item.authors || []).map(a => ({
      id: a.id, olid: a.olid, name: a.name, gbName: a.gbName || '', role: a.role, order: a.order,
    }));

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
    /* The Google half of the choke point. `fromVolume` is both the search stub
       and the detail record because a Google volume carries both; the two are
       told apart by `meta.partial`, which means "an Open Library work record
       exists and will fill in the work-level fields". */
    fromVolume, stubFromVolume, mergeSearchStubs,
    /* The two release rules that are NOT pickRelease, exported because both
       encode measured third-party behaviour and have to be assertable without
       a network round trip: the year gate that stops a 1990 printing dating a
       1965 novel, and the earliest-printing rule that dates a work. */
    workDate, earlierRelease,
    withDefaults, mergeItem, bucketGenres,
    /* The one answer to "can this book show an edition list?", read by the
       sweep (which decides whether to spend a request on the bridge) and by the
       picker (which decides what to draw when there is nothing). Two copies of
       this question would drift within a week and the symptom would be a picker
       apologising about a book the sweep had already resolved. */
    editionGraphOf,
    leanForSync, absorbSynced,
    /* ONE fold in the app, exported so that 25-googlebooks, 61-view-search and
       70-follows all answer "same book?" and "same person?" identically. A
       private copy anywhere is a second answer, and the symptom is a duplicate
       row that neither call site can explain. */
    foldTitle, stripEditionFurniture, surnameOf, surnameSet,
    personKey, personMatches, matchKey, sameBook,
    /* The dual-identity join: Google's exact author-name string plus Open
       Library's OLID on one author record. Exported so a follow can be built
       from a byline without re-deriving either half. */
    mergeAuthorIdentities,
    /* Exported below the contract line: internals that other M2 modules have a
       legitimate reason to reuse rather than re-implement. */
    buildRelease, emptyRelease, pickRelease, buildTerms,
    cleanSubjects, ensureGenres, absorbEditions, mergeAuthors, setPath,
    /* EXPORTED SO THERE IS ONE RANKING, not two. 25-googlebooks.js has to
       answer "is this record already finer than a year" before it spends a
       request, and a private copy of the ladder there would be free to drift
       out of step with the one pickRelease enforces — at which point the
       adapter starts paying for lookups whose results the merge then throws
       away, and nothing anywhere reports it. */
    STATUS_RANK, CONFIDENCE, PRECISION_RANK, precisionRank,
  };
})();
