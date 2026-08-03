/* ══════════════════════════════════════════════════════════════════════════
   Utilities — dates, sort keys, ISBNs, text, hashing.

   The date code here is the most bug-prone part of the whole app, so it is
   isolated and every rule is stated at its call site. Two rules dominate:

     1. NEVER `new Date("2026-03-15")`. That parses as UTC midnight, so it
        renders as March 14 for everyone west of Greenwich. Source dates are
        naive calendar dates in some region — parse them to {y,m,d} and format
        from the triple.

     2. A sortKey is an INTEGER, not a date. 20260831 + 1 is not September 1.
        Any arithmetic must round-trip through real date parsing.

   The barcode section at the bottom has a rule of its own, and it has bitten
   us: NORMALIZE BEFORE YOU STRIP. A scanner does not hand you thirteen digits,
   it hands you a symbology prefix, thirteen digits and sometimes a price
   add-on, and stripping non-digits first destroys the evidence you needed to
   tell those apart. See stripAimPrefix.
   ══════════════════════════════════════════════════════════════════════════ */

BT.util = (function () {

  /* ── Sort-key sentinels ────────────────────────────────────────────────
     Ordinary dates encode as YYYYMMDD so they sort naturally as ints. The two
     sentinels sort last, keeping undated items at the bottom of every list
     without any special-casing in the comparators. */
  const SK_UNKNOWN = 99999998;
  const SK_TBA     = 99999999;

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* Parse a naive 'YYYY-MM-DD' / 'YYYY-MM' / 'YYYY' string. Returns null for
     anything unusable. Never constructs a Date. */
  function parseNaive(str) {
    if (typeof str !== 'string') return null;
    const s = str.trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) {
      return { y: +m[1], m: +m[2], d: +m[3] };
    }
    if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return { y: +m[1], m: +m[2], d: null };
    if ((m = /^(\d{4})$/.exec(s)))         return { y: +m[1], m: null, d: null };
    return null;
  }

  function sortKeyOf(parts, precision) {
    if (!parts || !parts.y) return precision === 'tba' ? SK_TBA : SK_UNKNOWN;
    const y = parts.y;
    /* Vaguer precisions anchor to the START of their window so a "July 2027"
       item sorts among early-July items rather than after all of them. */
    const mo = parts.m || 1;
    const d = parts.d || 1;
    return y * 10000 + mo * 100 + d;
  }

  function sortKeyToParts(sk) {
    if (!Number.isFinite(sk) || sk >= SK_UNKNOWN) return null;
    return { y: Math.floor(sk / 10000), m: Math.floor((sk % 10000) / 100), d: sk % 100 };
  }

  /* Local midnight today, as a sort key. Uses the *user's* calendar day, so
     "publishes tomorrow" doesn't flip over at 5pm. */
  function todaySortKey() {
    const n = new Date();
    return n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
  }

  function addDaysToSortKey(sk, days) {
    const p = sortKeyToParts(sk);
    if (!p) return sk;
    const dt = new Date(p.y, p.m - 1, p.d);          // local constructor, deliberate
    dt.setDate(dt.getDate() + days);
    return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
  }

  function daysBetweenSortKeys(a, b) {
    const pa = sortKeyToParts(a), pb = sortKeyToParts(b);
    if (!pa || !pb) return null;
    const da = Date.UTC(pa.y, pa.m - 1, pa.d);       // UTC on BOTH sides: the offset
    const db = Date.UTC(pb.y, pb.m - 1, pb.d);       // cancels, so DST can't skew it
    return Math.round((db - da) / 86400000);
  }

  /* Days from today until a sort key. Negative = in the past. */
  function daysUntil(sk) { return daysBetweenSortKeys(todaySortKey(), sk); }

  /* ── Precision derivation ──────────────────────────────────────────────
     Publishers and cataloguers store placeholder dates for books that only
     have a year committed, nearly always Jan 1 or Dec 31. Rendering those as a
     real day is a lie the user will act on, so unpublished Jan-1/Dec-31 dates
     are demoted to year precision and flagged `inferred`.

     Note the `opts.released === false` gate, and note that for books it does
     more work than it did for films. An ANNOUNCED title carrying "January 1,
     2027" is a retailer placeholder for "sometime next year" and must not read
     as a street date. An ALREADY-PUBLISHED book carrying January 1 is usually
     just the catalogue date we actually have, and demoting the whole backlist
     to year precision would throw away thousands of genuine days. So the rule
     fires forward in time only — same code as MovieTrak, different centre of
     gravity, because a book library is mostly history. */
  function derivePrecision(raw, opts) {
    opts = opts || {};
    const parts = parseNaive(raw);
    if (!parts) return { precision: opts.tba ? 'tba' : 'unknown', parts: null, inferred: 0 };
    if (parts.m == null) return { precision: 'year', parts, inferred: 0 };
    if (parts.d == null) return { precision: 'month', parts, inferred: 0 };

    /* Checked BEFORE the Jan-1/Dec-31 rule, because the commonest sentinels
       (2099-12-31, 2100-01-01) satisfy both — and "TBA" is the truthful
       reading, not "sometime in 2099". */
    if (parts.y > new Date().getFullYear() + 10) {
      return { precision: 'tba', parts: null, inferred: 1 };
    }
    const isPlaceholder = (parts.m === 1 && parts.d === 1) || (parts.m === 12 && parts.d === 31);
    if (isPlaceholder && opts.released === false) {
      return { precision: 'year', parts: { y: parts.y, m: null, d: null }, inferred: 1 };
    }
    return { precision: 'day', parts, inferred: 0 };
  }

  /* ── Open Library publish dates ────────────────────────────────────────
     TMDB gave MovieTrak ISO strings and nothing else, so parseNaive was the
     whole story. Open Library's `publish_date` is a FREE-TEXT field typed by
     whoever entered the record, and the spread is genuinely wild:

         '1991'              '1991.'          'c1991'        '[1991]'
         'January 1938'      'Sept 2012'      'Mar 06, 2012'
         'March 6, 2012'     '6 March 2012'   '2012-03-06'
         '19uu'              '?'              'n.d.'

     Rather than teach derivePrecision every one of those shapes, this
     normalizes the string down to the canonical 'YYYY-MM-DD' / 'YYYY-MM' /
     'YYYY' forms and then DELEGATES. That keeps exactly one placeholder ladder
     and one TBA rule in the codebase; a second copy would drift within a week.

     Deliberately NOT parsed: bare numeric forms like '03/06/2012'. That is
     March 6 to an American cataloguer and June 3 to a British one, and Open
     Library contains both. Guessing wrong silently is worse than falling back
     to the year, which is what the last-ditch rule below does. */
  function monthIndexOf(name) {
    const n = String(name || '').toLowerCase().replace(/\./g, '').trim();
    if (!n) return 0;
    if (n === 'sept') return 9;                       // common, and not the ISO abbr
    let i = MONTHS.findIndex(x => x.toLowerCase() === n);
    if (i >= 0) return i + 1;
    i = MONTHS_ABBR.findIndex(x => x.toLowerCase() === n);
    if (i >= 0) return i + 1;
    /* Truncated full names ('Febr', 'Augu') show up in older MARC imports. */
    if (n.length >= 3) {
      i = MONTHS.findIndex(x => x.toLowerCase().startsWith(n));
      if (i >= 0) return i + 1;
    }
    return 0;
  }

  /* Free text -> a naive date string parseNaive can read, or null. */
  function olDateToNaive(raw) {
    if (typeof raw !== 'string') return null;
    /* Strip the cataloguer's decoration: bracketed guesses, 'c'/'ca.' for
       circa, a copyright glyph, trailing punctuation. */
    let s = raw.trim()
      .replace(/^[\[\(]+/, '')
      .replace(/[\]\)]+$/, '')
      .replace(/^(?:ca?\.?|circa|©|copyright)\s*/i, '')
      .replace(/[.,;\s]+$/, '')
      .trim();
    if (!s) return null;

    const pad = n => String(n).padStart(2, '0');
    const ok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= lastDayOfMonth(y, m));
    let m;

    /* Already ISO-ish. parseNaive is stricter than this regex about the day
       having two digits, so hand it a padded copy. */
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
      const y = +m[1], mo = +m[2], d = +m[3];
      return ok(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : `${y}`;
    }
    if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) {
      const y = +m[1], mo = +m[2];
      return (mo >= 1 && mo <= 12) ? `${y}-${pad(mo)}` : `${y}`;
    }

    /* 'Mar 06, 2012' / 'March 6, 2012' / 'March 6th 2012' */
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
      const mo = monthIndexOf(m[1]), d = +m[2], y = +m[3];
      if (mo && ok(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
      if (mo) return `${y}-${pad(mo)}`;
      return `${y}`;
    }

    /* '6 March 2012' — the British/European ordering, common in UK imprints. */
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
      const d = +m[1], mo = monthIndexOf(m[2]), y = +m[3];
      if (mo && ok(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
      if (mo) return `${y}-${pad(mo)}`;
      return `${y}`;
    }

    /* 'January 1938' / 'Sept 2012' */
    if ((m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
      const mo = monthIndexOf(m[1]), y = +m[2];
      return mo ? `${y}-${pad(mo)}` : `${y}`;
    }

    /* Bare year. */
    if ((m = /^(\d{4})$/.exec(s))) return m[1];

    /* Last ditch: any plausible standalone year anywhere in the string. This
       is what rescues '1st ed., 1991' and 'Repr. 2004' — and what correctly
       gives up on '19uu' and 'n.d.', which carry no year at all. */
    if ((m = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(s))) return m[1];
    return null;
  }

  /* Returns the same shape as derivePrecision: { precision, parts, inferred }.
     Pass `opts.released === false` for announced-but-unpublished titles so the
     Jan-1 placeholder demotion applies. */
  function parseOpenLibraryDate(raw, opts) {
    const naive = olDateToNaive(raw);
    if (naive == null) {
      return { precision: (opts && opts.tba) ? 'tba' : 'unknown', parts: null, inferred: 0 };
    }
    const out = derivePrecision(naive, opts);
    /* Flag anything we recovered by inference rather than read outright, so the
       UI can render it with the pending/inferred treatment instead of stating
       a date the record never actually contained. */
    if (naive.length === 4 && String(raw).trim() !== naive) out.inferred = 1;
    return out;
  }

  function quarterOf(month) { return Math.floor((month - 1) / 3) + 1; }

  /* Render-ready string. THE HONESTY RULE: if precision is coarser than a day,
     no day number may appear anywhere in the output. */
  function displayRelease(parts, precision) {
    switch (precision) {
      case 'day':
        if (!parts) return 'TBA';
        return `${MONTHS_ABBR[parts.m - 1]} ${parts.d}, ${parts.y}`;
      case 'month':
        if (!parts) return 'TBA';
        return `${MONTHS[parts.m - 1]} ${parts.y}`;
      case 'quarter':
        if (!parts) return 'TBA';
        return `Q${quarterOf(parts.m)} ${parts.y}`;
      case 'year':
        return parts ? String(parts.y) : 'TBA';
      case 'tba':      return 'TBA';
      default:         return 'No date';
    }
  }

  function shortDate(sk) {
    const p = sortKeyToParts(sk);
    return p ? `${MONTHS_ABBR[p.m - 1]} ${p.d}` : '—';
  }

  function relativeDays(n) {
    if (n == null) return '';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n < 0) {
      const a = -n;
      if (a < 30) return `${a}d ago`;
      if (a < 365) return `${Math.round(a / 30)}mo ago`;
      return `${(a / 365).toFixed(1)}y ago`;
    }
    if (n < 30) return `in ${n}d`;
    if (n < 365) return `in ${Math.round(n / 30)}mo`;
    return `in ${(n / 365).toFixed(1)}y`;
  }

  function timeAgo(ms) {
    if (!ms) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return `${MONTHS_ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /* ── Text ──────────────────────────────────────────────────────────── */

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Sort title: drops a leading article and normalises accents so "Ægypt" and
     "The Left Hand of Darkness" land where a human would look for them.
     Generalises to books without a change — dropping the leading article is
     exactly what a library shelf-list does, and it is the reason "The Road"
     files under R. The article list stays multilingual because translated
     editions carry their own titles. */
  function sortTitleOf(title) {
    if (!title) return '';
    let t = String(title).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    t = t.replace(/^(the|a|an|le|la|les|el|los|das|der|die)\s+/, '');
    return t.replace(/[^a-z0-9 ]/g, '').trim();
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
  }

  function pluralize(n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
  }

  function formatVotes(n) {
    if (!n) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  /* The book analogue of MovieTrak's runtimeStr. Page counts are the one
     "length" figure a reader actually reasons about, and they arrive as a bare
     integer from both sources — 0 and null both mean "unknown", never "zero
     pages", so both render empty rather than "0 pages". */
  function pagesStr(n) {
    if (!n) return '';
    return `${n} ${n === 1 ? 'page' : 'pages'}`;
  }

  /* ── Relevance ─────────────────────────────────────────────────────────
     Sources rank by their own metric, and those metrics are not comparable:
     Open Library's default ordering leans hard on edition count, so a work
     with 400 catalogued printings outranks an exact title match with three.
     Search "dune messiah" and the first screen is Dune, Dune Messiah having
     been buried under a dozen Dune omnibus editions and companion volumes.
     Google Books, when a key is present, orders by something else entirely.

     So relevance is computed here, from the query and the title, and the
     source's own popularity (edition count, for Open Library) is demoted to a
     tiebreak within a band. */

  function normalizeTitle(s) {
    if (!s) return '';
    let t = String(s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* Returns { score 0..1, coverage 0..1 }. Coverage is the share of query
     words present in the title, and is what the caller filters on — score
     additionally rewards contiguity and word order. */
  function relevance(query, title) {
    const q = normalizeTitle(query);
    const t = normalizeTitle(title);
    if (!q || !t) return { score: 0, coverage: 0 };

    const qs = q.split(' ').filter(Boolean);
    const ts = t.split(' ').filter(Boolean);
    if (!qs.length) return { score: 0, coverage: 0 };

    let matched = 0;
    for (const w of qs) {
      /* A whole word, or a prefix of one — so "mess" still finds "messiah"
         while the user is still typing. */
      if (ts.some(x => x === w || x.startsWith(w))) matched++;
    }
    const coverage = matched / qs.length;

    let score;
    if (t === q) score = 1;
    else if (t.startsWith(q)) score = 0.94;
    else if (t.includes(q)) score = 0.86;
    else score = 0.7 * coverage;

    /* A short query matching a very long title is a weaker signal than the
       same query matching a title its own length. Books make this matter more
       than films did: catalogue titles carry subtitles and series apparatus
       ("Dune Messiah: Book Two of the Dune Chronicles"), so without this the
       omnibus always beats the novel. */
    if (score < 0.86 && ts.length > qs.length) {
      score *= Math.max(0.55, qs.length / ts.length) ** 0.35;
    }
    return { score, coverage };
  }

  /* Rank a mixed result set by relevance, using each source's own popularity
     only to break ties WITHIN a relevance band — never across bands.

     WHAT A ROW IS SCORED AGAINST. `title` and `originalTitle` as always, plus
     anything in an optional `haystacks` array — either bare strings or
     `{ text, weight }` pairs, where `weight` scales that haystack's score.
     That is how a caller adds a field which is genuinely as relevant as the
     title but slightly less specific (an author name matches thirty books, a
     title matches one) without promoting it above a real title match. Rows
     that offer no `haystacks` behave exactly as they did before.

     COVERAGE IS THE BEST OF ALL HAYSTACKS, not the coverage of whichever one
     happened to win on score. It answers a different question from the score —
     "do the words the reader typed appear in this record AT ALL?" — and it is
     what the filter below runs on, so tying it to the top-scoring string is
     how a search for an author's name returns an empty screen: every title
     scores 0 coverage, the multi-word gate insists on 1, and the entire result
     set is dropped while the author field matched perfectly. That was a live
     bug — `gwendolyn kiste`, 71 real hits, nothing shown. See rerank() in
     61-view-search.js.

     The filter is adaptive: for a multi-word query, insist every word appears,
     which is what stops "Dune" answering "dune messiah". If that leaves too
     little, relax rather than show an empty screen. */
  function rankByRelevance(query, rows, opts) {
    opts = opts || {};
    const scored = rows.map(r => {
      const cands = [r.title, r.originalTitle].concat(r.haystacks || []);
      let score = 0, coverage = 0;
      for (const c of cands) {
        const obj = c && typeof c === 'object';
        const text = obj ? c.text : c;
        if (!text) continue;
        const weight = (obj && c.weight != null) ? c.weight : 1;
        const rel = relevance(query, text);
        if (rel.score * weight > score) score = rel.score * weight;
        if (rel.coverage > coverage) coverage = rel.coverage;
      }
      return Object.assign({}, r, { _score: score, _coverage: coverage });
    });

    const multiWord = normalizeTitle(query).split(' ').filter(Boolean).length > 1;
    let kept = scored.filter(r => r._coverage >= (multiWord ? 1 : 0.5));
    /* Relax ONLY when nothing matched every word. Padding a good result set
       with partial matches is what produced the original complaint: two solid
       hits for "dune messiah" followed by every book with "dune" on the spine.
       If something matches all of it, that is the answer. */
    if (!kept.length) kept = scored.filter(r => r._coverage >= 0.5);
    if (!kept.length) kept = scored.filter(r => r._score > 0);

    /* Banded at 0.05 so popularity can order near-equal matches while a
       genuinely better title match still wins. One decimal was too coarse: it
       collapsed "starts with the query" (0.94) and "contains it somewhere"
       (0.86) into the same band, so edition count decided — and for the query
       "dune", the 900-edition omnibus beat the novel. */
    kept.sort((a, b) => {
      const band = Math.round(b._score * 20) - Math.round(a._score * 20);
      if (band) return band;
      return (b.pop || 0) - (a.pop || 0);
    });
    return kept;
  }

  /* ── Open Library shapes ───────────────────────────────────────────────
     Two normalizers that exist purely because Open Library is inconsistent
     with itself. Both are one line long and both prevent a class of bug that
     is otherwise very hard to see in review. */

  /* Keys arrive in at least three shapes for the same thing:

         '/works/OL27482W'         work record, and every `key` field
         '/authors/OL34184A'       author record
         'OL1394865A'              BARE — /search/authors.json returns this,
                                   alone among the endpoints, so code that
                                   assumes a leading '/type/' slice silently
                                   produces '4865A' and then 404s.

     Also handles a full URL and a trailing '.json', because both turn up in
     hand-pasted values. Ids are ALPHANUMERIC — never parseInt an OLID. */
  function olid(key) {
    if (!key) return '';
    const m = /OL\d+[A-Z]/i.exec(String(key).trim());
    return m ? m[0].toUpperCase() : '';
  }

  /* Description, bio and first_sentence come back as EITHER a bare string OR
     { type: '/type/text', value: '…' }, and which one you get depends on which
     endpoint and which era of the record you hit — works and editions disagree
     about the same field. Rendering the raw value prints '[object Object]' on
     the item page, which is exactly the kind of bug that ships. Every read of
     those fields goes through here. */
  function olText(v) {
    return typeof v === 'string' ? v : (v && v.value) || '';
  }

  /* ── ISBNs and barcodes ────────────────────────────────────────────────
     This section is short and every line of it is scar tissue. A scanner in
     keyboard-wedge mode types a string at the focused input; what is IN that
     string is not just the barcode.

     Order of operations is fixed and must not be rearranged:
         AIM prefix  ->  strip non-digits  ->  length dispatch  ->  checksum
                     ->  prefix meaning
     Doing the digit-strip first is the bug this whole section exists to
     prevent. */

  /* An AIM symbology identifier is a three-character prefix — ']' + a letter +
     a modifier digit — that many scanners are configured (sometimes from the
     factory) to emit so the host knows which symbology was read. EAN-13 sends
     ']E0'; an EAN-13 WITH a supplemental add-on sends ']E4'.

     Note what both of those contain: A DIGIT. Strip non-digits first and that
     '0' or '4' becomes the leading digit of the code, turning a perfectly good
     9780441172719 into 09780441172719 — fourteen digits, wrong checksum, and
     an error message about an invalid barcode for a barcode that was fine.
     The failure is silent and reproducible only on scanners with the prefix
     enabled, which is why it survived so long. Strip the prefix FIRST. */
  function stripAimPrefix(raw) {
    return String(raw == null ? '' : raw).trim().replace(/^\][A-Za-z]\d/, '');
  }

  /* EAN-13 check digit: weight the first 12 digits 1,3,1,3… sum, then the
     amount needed to reach the next multiple of ten. */
  function ean13Checksum(digits) {
    const s = String(digits || '').replace(/\D/g, '');
    if (s.length < 12) return -1;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (+s[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
  }

  function isValidEan13(s) {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length !== 13) return false;
    return ean13Checksum(d) === +d[12];
  }

  /* ISBN-10 -> ISBN-13. MANUAL ENTRY ONLY.

     There is no such thing as an ISBN-10 barcode: the retail symbol on a book
     has been a 978-prefixed EAN-13 since long before the 2007 changeover, and
     pre-2007 stock carries one too. So this is never on the scan path. It is
     here because the ISBN-10 is what is printed on the copyright page, and
     that is what a user types when the barcode is torn or missing.

     The check character is MOD-11, and the remainder 10 is written as 'X'.
     That single letter is why a naive `.replace(/\D/g,'')` on user input is
     destructive: it turns the valid 043942089X into a 9-digit fragment. Strip
     to [0-9X] and uppercase, never to digits. */
  function isbn10to13(s) {
    const t = String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
    if (t.length !== 10) return null;
    if (/X/.test(t.slice(0, 9))) return null;          // X is legal ONLY in the check position
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const c = t[i];
      const v = (c === 'X') ? 10 : +c;
      sum += v * (10 - i);
    }
    if (sum % 11 !== 0) return null;
    const body = '978' + t.slice(0, 9);                // drop the mod-11 check digit
    const check = ean13Checksum(body);                 // and recompute, mod-10 this time
    return check < 0 ? null : body + String(check);
  }

  /* Normalize whatever the scanner produced into an ISBN-13, or explain why it
     is not one. Returns { ok, isbn13, reason }.

     Reasons are distinct on purpose — the scan view says something different
     for each, and "invalid barcode" for all four was the single most confusing
     thing about the first version:
        'too-short'   the read was truncated or the input is not a barcode
        'checksum'    thirteen digits that do not check — a misread, rescan
        'ismn'        valid, but it is sheet music (979-0), not a book
        'not-a-book'  valid retail barcode for something else entirely
                      (groceries, DVDs — a UPC-A on a boxed set is common)

     LENGTH DISPATCH, which is where the interesting cases live:

       18 or 15 digits — an EAN-5 (price) or EAN-2 (issue number) supplemental
                         has been concatenated onto the EAN-13. Mass-market
                         paperbacks nearly always carry the EAN-5 with the US
                         price in it. Take the FIRST 13. Left-truncation is not
                         a stylistic choice: right-truncating gives you the last
                         13 of an 18-digit string, which is five digits of price
                         data with the tail of the ISBN glued to the front, and
                         it fails the checksum in a way that looks like a
                         hardware fault.
       12 digits       — UPC-A. Older US printings and book-club editions carry
                         one. An EAN-13 with a leading zero IS a UPC-A, so
                         prefixing '0' is the correct, lossless widening.
       13 digits       — validate directly.

     Then the prefix decides what it is. 978 and 979 are Bookland. The one
     exception is 9790, which is ISMN — printed sheet music — and it is a real
     barcode on a real product that we cannot look up. */
  function normalizeScanCode(raw) {
    const pre = stripAimPrefix(raw);                   // MUST run before the strip below
    let d = pre.replace(/\D/g, '');

    if (d.length === 18 || d.length === 15) d = d.slice(0, 13);
    else if (d.length === 12) d = '0' + d;

    if (d.length < 12) return { ok: false, isbn13: null, reason: 'too-short' };
    if (d.length !== 13) return { ok: false, isbn13: null, reason: 'not-a-book' };
    if (!isValidEan13(d)) return { ok: false, isbn13: null, reason: 'checksum' };

    if (d.startsWith('9790')) return { ok: false, isbn13: null, reason: 'ismn' };
    if (d.startsWith('978') || d.startsWith('979')) {
      return { ok: true, isbn13: d, reason: null };
    }
    return { ok: false, isbn13: null, reason: 'not-a-book' };
  }

  /* ── Hashing ───────────────────────────────────────────────────────────
     FNV-1a, 64-bit-ish via two 32-bit lanes. Used for content-addressed alert
     ids and cache keys — it needs to be stable and fast, not cryptographic. */
  function fnv1a(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c; h2 = Math.imul(h2 ^ (h2 >>> 7), 0x85ebca6b) >>> 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  /* ── Async plumbing ────────────────────────────────────────────────── */

  function debounce(fn, ms) {
    let t;
    const wrapped = function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function deepGet(obj, path, dflt) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return dflt;
      cur = cur[p];
    }
    return cur === undefined ? dflt : cur;
  }

  function uniqBy(arr, keyFn) {
    const seen = new Set(), out = [];
    for (const x of arr) {
      const k = keyFn(x);
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function bytesStr(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function todayStamp() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }
  function monthStamp() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  }

  /* ── Release windows ───────────────────────────────────────────────────
     Ranges for the Releases view. Every boundary is computed on sort keys and
     the numeric Date constructor, never by parsing a date string — the whole
     point of the precision model is that we never let a timezone move a day.

     "This week" runs from today for seven days rather than snapping to a
     Monday: someone asking on a Saturday what publishes "this week" means the
     next several days, not the two remaining ones. */
  function skToISO(sk) {
    const p = sortKeyToParts(sk);
    if (!p) return null;
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  function lastDayOfMonth(y, m) {
    return new Date(y, m, 0).getDate();          // day 0 of next month = last of this
  }

  function endOfMonthSortKey(y, m) {
    return y * 10000 + m * 100 + lastDayOfMonth(y, m);
  }

  function monthsAhead(y, m, n) {
    const total = (y * 12 + (m - 1)) + n;
    return { y: Math.floor(total / 12), m: (total % 12) + 1 };
  }

  const RELEASE_RANGES = [
    { id: 'week',   label: 'This week' },
    { id: 'month',  label: 'This month' },
    { id: 'next',   label: 'Next month' },
    { id: 'q',      label: 'Next 3 months' },
    { id: 'half',   label: 'Next 6 months' },
    { id: 'year',   label: 'Rest of this year' },
    { id: 'nextyr', label: 'Next year' },
    { id: 'custom', label: 'Custom…' },
  ];

  /* A custom window travels in the URL as `from` and `to`, so a particular
     stretch of calendar can be linked and reloaded. Parsed by regex rather
     than by Date, for the usual reason: new Date("2027-03-15") is UTC midnight
     and comes back a day earlier for everyone west of Greenwich. */
  function isoToSortKey(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > lastDayOfMonth(y, mo)) return null;
    return y * 10000 + mo * 100 + d;
  }

  /* Returns { from, to } as inclusive sort keys. `opts` carries the custom
     window's endpoints when `id` is 'custom'. */
  function releaseWindow(id, opts) {
    const today = todaySortKey();
    const t = sortKeyToParts(today);
    if (id === 'custom') {
      const from = isoToSortKey(opts && opts.from);
      const to = isoToSortKey(opts && opts.to);
      /* Fall back rather than render an impossible window. A backwards range
         is a typo, not a request for nothing. */
      if (!from || !to || to < from) return { from: today, to: endOfMonthSortKey(t.y, t.m) };
      return { from, to };
    }
    switch (id) {
      case 'week':
        return { from: today, to: addDaysToSortKey(today, 6) };
      case 'month':
        return { from: today, to: endOfMonthSortKey(t.y, t.m) };
      case 'next': {
        const n = monthsAhead(t.y, t.m, 1);
        return { from: n.y * 10000 + n.m * 100 + 1, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'q': {
        const n = monthsAhead(t.y, t.m, 3);
        return { from: today, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'half': {
        const n = monthsAhead(t.y, t.m, 6);
        return { from: today, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'year':
        return { from: today, to: t.y * 10000 + 1231 };
      case 'nextyr':
        return { from: (t.y + 1) * 10000 + 101, to: (t.y + 1) * 10000 + 1231 };
      default:
        return { from: today, to: addDaysToSortKey(today, 6) };
    }
  }

  return {
    SK_UNKNOWN, SK_TBA, MONTHS, MONTHS_ABBR,
    skToISO, lastDayOfMonth, endOfMonthSortKey, monthsAhead,
    RELEASE_RANGES, releaseWindow, isoToSortKey,
    parseNaive, sortKeyOf, sortKeyToParts, todaySortKey,
    addDaysToSortKey, daysBetweenSortKeys, daysUntil,
    derivePrecision, quarterOf, displayRelease, shortDate,
    relativeDays, timeAgo, dayLabel,
    monthIndexOf, olDateToNaive, parseOpenLibraryDate,
    escapeHtml, sortTitleOf, truncate, pluralize, formatVotes, pagesStr,
    normalizeTitle, relevance, rankByRelevance,
    olid, olText,
    stripAimPrefix, ean13Checksum, isValidEan13, isbn10to13, normalizeScanCode,
    fnv1a, debounce, sleep, deepGet, uniqBy, clamp, bytesStr,
    todayStamp, monthStamp,
  };
})();
