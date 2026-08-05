/* ══════════════════════════════════════════════════════════════════════════
   #/search — find a book by title OR AUTHOR and put it on a shelf.

   TWO CATALOGUES ARE ASKED, EVERY TIME, AND THE ANSWERS ARE UNIONED.

   Google Books leads, because its ranking and its dates are measurably better.
   Open Library is still asked, because it is the only source of a work id and
   an author OLID — and because a book Google has never indexed is still a book.

     GOOGLE           q=dune -> Frank Herbert's *Dune* at #1, correctly
                      attributed, with a full 'YYYY-MM-DD' publication date.
                      Forthcoming titles exist in this index.
     OPEN LIBRARY     the same query answers *Children of Dune* at #1, *Go Ask
                      Alice* at #6, and the real novel eighth — credited to
                      Brian Herbert and dated 2001. What it does have is
                      `key: /works/OL893414W`, which is the identity every
                      record on the reader's shelves is already filed under,
                      and `author_key`, which is the only thing a follow can
                      safely be keyed on.

   So a row that both catalogues returned keeps OPEN LIBRARY'S IDENTITY and
   GOOGLE'S FACTS. That is not a compromise, it is the migration guarantee: a
   book already in the library still dedupes on `olwork:{OLID}` exactly as it
   did before the pivot, and nothing is renumbered. A row only Google returned —
   which is what every forthcoming title is — gets a `book:googlebooks:{id}`
   uid, a namespace nothing existing can collide with. See
   BT.normalize.mergeSearchStubs.

   ── THE RANKING STILL HAS TO HAPPEN HERE ──────────────────────────────────
   Open Library's order cannot be shown to a user and there is no server-side
   way to fix it: sending `sort=` alongside a free-text `q` makes Open Library
   SILENTLY DISCARD the query — `q=dune&sort=editions` returns HTTP 200 and
   *Robinson Crusoe*. Not an error, not an empty list: a confident, wrong
   answer. Google's order is good and is used, but it is used as a TIEBREAK
   inside a relevance band rather than as the answer, because the two sources'
   rows have to be ordered against each other and only a locally computed score
   can do that. See rerank().

   ── WITH NO GOOGLE KEY ────────────────────────────────────────────────────
   Everything below still works, on Open Library alone, with year-granular
   dates. The reader is told once, with a link to Settings, and never again.
   Nothing here ever fires a keyless Google request: anonymous access to that
   API is a quota of ZERO and would be a guaranteed 429.

   ── NOT MOVING THE GROUND UNDER SOMEONE'S THUMB ───────────────────────────
   Adding a book swaps ONE BUTTON in place rather than repainting: a repaint
   re-partitions the list into "On your shelves" and "Results", so the row you
   just added leaps into the other group and the next row slides up under your
   finger. Adding four books in a row was unusable before that. See addRow().

   FOLLOWING AN AUTHOR HAPPENS HERE TOO, and that is a deliberate answer to a
   reported bug rather than a spare button — a search result is where you are
   standing when the thought arrives. The byline carries BOTH halves of an
   author's identity: Open Library's OLID, which the follow is keyed on, and
   Google's exact name string, which is what the Google half of that follow
   queries with. See byline().
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewSearch = (function () {
  const esc = BT.util.escapeHtml;

  /* ── Session state ─────────────────────────────────────────────────────
     `cache` is per QUERY and lives for the session. Cheap and worth it twice
     over now: Open Library's sustained budget is one request per second, and
     Google's is a daily allowance out of the user's own key. */
  const cache = new Map();

  let inflight = null;      // AbortController for the requests in flight
  let rows = [];            // [{ stub, doc, vol, owned, score }]
  let cursor = -1;          // keyboard position within `rows`
  let query = '';           // survives a trip to the inspector and back
  let numFound = 0;         // what the catalogues claim, not what we show
  let collapsed = 0;        // duplicate records folded away by rerank()
  let stale = null;         // set when results came from cache during an outage
  let sources = '';         // which catalogues actually answered
  let touchStart = null;
  let moved = false;
  /* Follow ids, so a byline can be drawn with the right state without a repo
     read per author per row. Loaded once per render and mutated in place by
     toggleFollow — the same surgical-swap discipline the Add button uses. */
  let followSet = new Set();

  /* Said ONCE, and remembered across sessions. An app that repeats "you could
     add a key" on every search is an app with a nag in it; an app that never
     says it is an app whose dates are quietly worse than they could be. The
     flag is a plain localStorage row under the app's own `bt.` prefix — losing
     it costs one more prompt, so it needs no schema and no sync. */
  const LS_KEY_PROMPT = 'bt.search.gbprompt.v1';

  function keyPromptDue() {
    if (BT.googlebooks && BT.googlebooks.enabled()) return false;
    try { return localStorage.getItem(LS_KEY_PROMPT) !== '1'; } catch (_) { return false; }
  }
  function dismissKeyPrompt() {
    try { localStorage.setItem(LS_KEY_PROMPT, '1'); } catch (_) {}
  }

  /* True when the click we are handling is the tail of a scroll gesture. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  /* ══ RE-RANKING ═════════════════════════════════════════════════════════
     THREE MEASURED FAILURES THIS FUNCTION EXISTS TO FIX. All three are silent,
     and each is one "simplification" away from coming back.

     ── FAILURE 1: the wrong book first (`q=dune`, Open Library) ───────────
         #1   Children of Dune
         #6   Go Ask Alice               (contains neither word)
         #8   Dune                       ← Brian Herbert, dated 2001
         #24  Dune                       ← THE NOVEL. Frank Herbert, 1965

     Whatever Open Library's relevance model optimises, it is not "the book the
     user just typed the name of" — it leans hard on catalogue mass, so
     omnibuses and study guides colonise the top of every popular query. Google
     answers the same query correctly at #1, which is why it now leads; but its
     rows still have to be ordered against Open Library's, and only a locally
     computed score can do that.

     ── FAILURE 2: no books at all (`q=gwendolyn kiste`) ───────────────────
     Searching an AUTHOR'S NAME returned an empty screen while Open Library was
     answering numFound 71 with all six top docs hers. Scoring was TITLE-ONLY,
     so "gwendolyn" and "kiste" scored 0 coverage on all 71 docs and the
     multi-word coverage gate inside rankByRelevance dropped the entire result
     set. BOOKS ARE SEARCHED BY AUTHOR AS A PRIMARY USE CASE.

     AND `author=` IS NOT THE ALTERNATIVE. `search.json?author=gwendolyn+kiste`
     returns LAIRD BARRON'S books at HTTP 200. Google is no better —
     `inauthor:"Stephen King"` returns ZERO and `inauthor:Kiste` returns 300
     books about Queen Victoria. Name-scoped author queries cannot be trusted in
     either catalogue, which is why a follow is keyed on an OLID and why
     byline() renders an id-less author as plain text.

     ── FAILURE 3: two rows for one book ──────────────────────────────────
     Now that two catalogues are unioned, the same book arrives twice by
     construction — and Google's index is printings, so it can arrive four
     times on its own. Merging happens before ranking (buildCandidates) and
     residual near-duplicates are collapsed after it (step 4).

     The model, in order of authority:

       1. MATCH QUALITY DECIDES THE BAND, and a match may be in the title OR
          the author. BT.util.rankByRelevance scores, filters on token coverage,
          and confines popularity to a tiebreak WITHIN a band.
             · the title            (weight 1.00)
             · title + authors      (weight 0.95) — the mixed query
             · the authors          (weight 0.90) — the pure author query
       2. An exact (or normalized-exact) title match gets a large boost.
       3. Query-token coverage adds a smaller boost.
       4. POPULARITY IS A TIEBREAK ONLY — and see popOf() for what "popularity"
          now means when the two sources measure completely different things.
       5. Summaries, study guides and workbooks are DEMOTED, not removed.
       6. Near-duplicate records are collapsed. */

  /* Titles that exist only because a real book exists. Every one carries the
     target book's title inside it, so they score as well as the book does on
     any pure string measure; "summary of dune" is a perfect coverage match for
     "dune". A real flood on popular queries, in both catalogues. */
  const JUNK_RX = /summary of|study guide|workbook|analysis of|companion to|quicklet/i;

  /* "Dune: Book One of the Dune Chronicles" -> "Dune". Catalogue titles carry
     series apparatus and translator credits in a subtitle, and the reader typed
     the part in front of the colon. It splits the RAW title, because
     BT.util.normalizeTitle has already thrown every separator away by the time
     it hands anything back.

     Built from a string so the separators stay legible: – and — are the en and
     em dash, both of which catalogue records use to hang a subtitle off a
     title, and two dash-like glyphs side by side inside a character class are
     one tidy-up away from being mistaken for a range. */
  const SUBTITLE_RX = new RegExp('\\s*[:;(\\u2013\\u2014]\\s*');

  function mainTitle(raw) {
    const s = String(raw || '');
    return s.split(SUBTITLE_RX)[0] || s;
  }

  /* ── POPULARITY, WHEN THE TWO SOURCES MEASURE DIFFERENT THINGS ──────────
     This number never crosses a relevance band (step 3 sorts on the band first
     and only calls this inside one), so the only question it ever answers is
     "several rows match equally well — which is the one they meant?".

     A ROW GOOGLE RETURNED IS ORDERED BY GOOGLE. Its ranking is the measured-
     better one on exactly this question, so its own position is used directly
     rather than being re-derived from a metric it does not publish. Position 0
     scores 1.0 and the last row of forty scores ~0.

     AN OPEN-LIBRARY-ONLY ROW is a book Google did not return at all, and is
     ordered by catalogue mass — but SHADED, so it cannot displace a book the
     better ranker actually ranked unless that book was near the bottom of
     Google's own list. Edition count leads within that, and the reversal is
     worth stating because "readers beat reprints" is the intuitive rule and is
     wrong here. Measured live on q=dune:

         OL893414W   Dune, Frank Herbert, 1965    160 editions    1 reader
         OL19618275W Dune, Brian Herbert, 2001     10 editions   31 readers

     Reader counts attach to whichever duplicate somebody happened to open;
     volunteers merge printings onto the canonical work. Weighting readers
     double handed "Dune" to a 2001 tie-in. */
  const OL_ONLY_SHADE = 0.9;

  function popOfDoc(doc) {
    const d = doc || {};
    const editions = Number(d.edition_count) || 0;
    const readers = Number(d.readinglog_count != null ? d.readinglog_count : d.want_to_read_count) || 0;
    const ratings = Number(d.ratings_count) || 0;
    const e = Math.min(1, Math.log10(editions + 1) / 2.7);   // 481 editions ≈ 1.0
    const r = Math.min(1, Math.log10(readers + 1) / 5);      // readinglog runs to ~1e5
    const v = Math.min(1, Math.log10(ratings + 1) / 4);
    return 0.55 * e + 0.30 * r + 0.15 * v;
  }

  /* NOTABILITY — popularity asking a different question. popOf answers "several
     records claim this title, which is the real one?"; this answers "which of
     this author's books is the one a reader has heard of?", and for that the
     reader counts are the whole point. Measured on `gwendolyn kiste`
     (readinglog / editions):

         Reluctant Immortals   2022    6 readers    4 editions
         Haunting of Velkwood  2024    2 readers    3 editions
         Boneset & Feathers    2020    0 readers    1 edition

     Readers lead and editions break the tie, which is the order a reader would
     write down. Editions stay weighted enough to carry a backlist title that
     predates Open Library's reading log. */
  function notabilityOfDoc(doc) {
    const d = doc || {};
    const editions = Number(d.edition_count) || 0;
    const readers = Number(d.readinglog_count != null ? d.readinglog_count : d.want_to_read_count) || 0;
    const ratings = Number(d.ratings_count) || 0;
    const r = Math.min(1, Math.log10(readers + 1) / 5);
    const e = Math.min(1, Math.log10(editions + 1) / 2.7);
    const v = Math.min(1, Math.log10(ratings + 1) / 4);
    return 0.60 * r + 0.28 * e + 0.12 * v;
  }

  const gbPop = (order, n) => (order < 0 ? 0 : 1 - (order / Math.max(1, n)));

  /* EVERY author on the record, joined, not just the first. Anthologies and
     collaborations list the person the reader is looking for anywhere in the
     array, and scoring only `[0]` would lose them. Joined with a space because
     BT.util.normalizeTitle reduces every separator to one anyway. */
  function authorsTextOf(stub) {
    return (stub.authors || []).map(a => a && a.name).filter(Boolean).join(' ');
  }

  /* An alternate title to score against as well as the main one — a translated
     or reissued work is often catalogued under both. rankByRelevance takes the
     BETTER of the two, so an absent field costs nothing. */
  function altTitleOf(doc) {
    const alt = doc && doc.alternative_title;
    if (Array.isArray(alt)) return alt[0] || '';
    return typeof alt === 'string' ? alt : '';
  }

  /* Weights for the non-title haystacks. Deliberately shallow: they settle a
     tie between two equally good raw matches in favour of the title, and must
     NOT be deep enough to push an author match out of the band an equally
     strong title match is in. One band is 0.05 wide; these cost 0.05 and 0.10
     of a raw 1.0 score. */
  const W_TITLE_AND_AUTHOR = 0.95;
  const W_AUTHOR = 0.90;

  /* How good an author match has to be, and how far it has to beat the title,
     before a row counts as "matched on the author". 0.86 is relevance()'s "the
     title contains the query somewhere" tier. */
  const AUTHOR_HIT = 0.86;
  const AUTHOR_GAP = 0.2;
  /* And how much of the result set has to look like that before the whole
     QUERY is treated as an author query. A clear majority rather than all: one
     companion volume with the author's name in its title must not flip a plain
     author search back to title ordering. */
  const AUTHOR_RUN = 0.6;

  /* True when the reader typed a name, not a title. Read off the results rather
     than guessed from the query string — there is no way to tell "gwendolyn
     kiste" from a title by looking at it, and every way to tell by looking at
     what came back. */
  function authorDominant(ranked) {
    if (!ranked.length) return false;
    let hits = 0;
    for (const r of ranked) {
      if ((r._authorScore || 0) >= AUTHOR_HIT
          && (r._authorScore || 0) > (r._titleScore || 0) + AUTHOR_GAP) hits++;
    }
    return hits >= Math.ceil(ranked.length * AUTHOR_RUN);
  }

  /* ══ THE UNION ══════════════════════════════════════════════════════════
     Google volumes and Open Library docs -> one list of candidates, with the
     rows that describe the same book already merged.

     BUCKETED BY FOLDED TITLE rather than compared pairwise. Forty Google rows
     against thirty Open Library docs is 1,200 comparisons, each of which folds
     four strings; the map makes it linear and — more to the point — makes the
     fold happen once per row, so the two sides cannot disagree about what a
     title folds to because of who was asked first.

     BT.normalize.foldTitle and .sameBook are the app's ONE answer to "is this
     the same book". 25-googlebooks collapses its own printings with the same
     fold, so a book that merges across sources also merges within one. */
  function buildCandidates(vols, docs) {
    const cands = [];
    const byTitle = new Map();
    const nGb = vols.length;

    const add = c => {
      const list = byTitle.get(c._ft);
      if (list) list.push(c); else byTitle.set(c._ft, [c]);
      cands.push(c);
    };

    /* GOOGLE'S OWN PRINTINGS ARE COLLAPSED FIRST, and this has to happen
       BEFORE the Open Library merge rather than in the post-ranking dedup at
       step 4, because it changes the DATE the merged row carries rather than
       only which row survives.

       Google has no work graph, so `q=dune` returns the 1990 Ace paperback, the
       2005 reissue and the 40th-anniversary edition as three independent
       volumes — and its ranker prefers recent printings, so the one it puts
       first is rarely the first edition. Collapsing on arrival and keeping the
       EARLIEST printing's date is what makes a search row answer "when did this
       book come out" instead of "when was this reprinted". See
       BT.normalize.earlierRelease for why earliest beats finest here and
       nowhere else.

       The FIRST volume of a group keeps its identity, its metadata and its rank
       — it is the one Google thought was the best answer, and its description,
       cover and page count describe a real printing. Only the release travels.
       Blending any more than that would assemble a printing that does not
       exist. */
    vols.forEach((vol, i) => {
      const stub = BT.normalize.stubFromVolume(vol);
      if (!stub || !stub.title) return;
      const ft = BT.normalize.foldTitle(stub.title);
      const twin = (byTitle.get(ft) || []).find(c => c.vol && BT.normalize.sameBook(c.stub, stub));
      if (twin) {
        twin.stub.release = BT.normalize.earlierRelease(twin.stub.release, stub.release);
        /* Every ISBN of every printing is still a candidate the scanner may
           later match, which is the one thing worth keeping from a collapsed
           sibling: it is what lets a scan of the 1990 paperback recognise the
           record the reader added from a search. */
        twin.stub.isbnsCandidate = [...new Set(
          [].concat(twin.stub.isbnsCandidate || [], stub.isbnsCandidate || []))];
        twin.printings++;
        return;
      }
      add({
        stub, vol, doc: null, gbOrder: i, printings: 1,
        _ft: ft,
        pop: gbPop(i, nGb),
        notability: gbPop(i, nGb),
      });
    });

    for (const doc of docs) {
      const stub = BT.normalize.stubFromSearchDoc(doc);
      if (!stub || !stub.uid || !stub.title) continue;
      const ft = BT.normalize.foldTitle(stub.title);

      /* First unclaimed Google row with the same folded title AND a shared
         author surname. `!c.doc` is what stops one Open Library work record
         being merged into three different Google printings of it — the first
         claims it, the rest stay separate and are folded away by step 4. */
      const bucket = byTitle.get(ft) || [];
      const hit = bucket.find(c => c.vol && !c.doc && BT.normalize.sameBook(c.stub, stub));
      if (hit) {
        hit.stub = BT.normalize.mergeSearchStubs(hit.stub, stub);
        hit.doc = doc;
        /* An Open Library row brings the readership figures Google does not
           publish, which is what an author-dominant query orders on. */
        hit.notability = notabilityOfDoc(doc);
        continue;
      }
      add({
        stub, vol: null, doc, gbOrder: -1, printings: 1, _ft: ft,
        pop: OL_ONLY_SHADE * popOfDoc(doc),
        notability: notabilityOfDoc(doc),
      });
    }

    /* A GOOGLE ROW NOTHING MERGED INTO IS COMPLETE AS IT STANDS, and saying so
       is what stops it costing a request every time its pane is opened.

       `meta.partial` means "an Open Library work record is known to exist and
       will fill in the work-level half". stubFromVolume sets it optimistically
       because the merge above is expected to happen; for the rows it did not,
       the claim is false — and 50-ui-core's hydrate gate is
       `!partial && now - detailsFetchedAt < TTL`, so leaving it set makes every
       open re-run a lookup that can only return null. A forthcoming title is
       exactly this shape and is exactly the record a reader opens repeatedly.

       Cleared rather than pinned for ever: `detailsFetchedAt` is stamped now,
       so the bridge in BT.openlibrary.hydrateOpen still retries once per
       BT.TTL.work — which is the right cadence, because Open Library WILL
       catalogue the book eventually and a weekly check finds it. Nothing is
       lost; the cost is moved from every open to once a week. */
    for (const c of cands) {
      if (c.vol && !c.doc && c.stub.meta) {
        c.stub.meta.partial = 0;
        c.stub.meta.detailsFetchedAt = Date.now();
      }
    }
    return cands;
  }

  function rerank(q, cands) {
    const qn = BT.util.normalizeTitle(q);

    const shaped = [];
    for (const c of (cands || [])) {
      const title = String(c.stub.title || '').trim();
      if (!title) continue;
      const authors = authorsTextOf(c.stub);
      shaped.push(Object.assign({}, c, {
        title,
        originalTitle: altTitleOf(c.doc),
        /* The two extra haystacks rankByRelevance scores alongside the title.
           An authorless row contributes none, which costs it nothing. */
        haystacks: authors ? [
          { text: title + ' ' + authors, weight: W_TITLE_AND_AUTHOR },
          { text: authors, weight: W_AUTHOR },
        ] : [],
        /* Scored again here, unweighted and on their own, ONLY to answer "did
           this row match because of its author?" — a different question from
           "how well did it match", and the one authorDominant() needs. */
        _titleScore: BT.util.relevance(q, title).score,
        _authorScore: authors ? BT.util.relevance(q, authors).score : 0,
        _norm: BT.util.normalizeTitle(title),
        _main: BT.util.normalizeTitle(mainTitle(title)),
      }));
    }

    /* Step 1 — M1's banded ranker. This is where the coverage filter lives
       (for a multi-word query, insist every word appears, then relax rather
       than show an empty screen) and where popularity is confined to a
       tiebreak. It is handed the author haystacks rather than being bypassed,
       because the `gwendolyn kiste` zero-results bug WAS that gate firing on a
       coverage number computed from titles alone. */
    const ranked = BT.util.rankByRelevance(q, shaped);
    const byAuthor = authorDominant(ranked);

    /* Step 2 — the book-specific corrections. */
    for (const r of ranked) {
      let s = r._score;
      /* An exact title match is the strongest statement a search result can
         make and nothing else may outrank it. 0.6 is twelve bands wide — far
         more than the whole spread between a title that STARTS with the query
         (0.94) and one that merely contains it (0.86) — which is the point: no
         pile of edition counts can climb over it. */
      if (qn && r._norm === qn) s += 0.6;
      else if (qn && r._main === qn) s += 0.45;   // exact once the subtitle is off
      /* Every word the reader typed, present in the title. Smaller, because
         relevance() already rewards contiguity and order. */
      s += 0.15 * (r._coverage || 0);
      /* Demoted, not dropped. Large enough to fall below any genuine match,
         small enough that a screen with nothing but summaries still shows
         them. */
      if (JUNK_RX.test(r.title)) s -= 0.75;
      r._score = BT.util.clamp(s, 0, 2);
      r._dupes = 0;
    }

    /* Step 3 — re-sort on the adjusted score, banded exactly as M1 bands it.
       0.05-wide bands: one decimal collapses "starts with the query" and
       "contains it somewhere" into the same band, and then popularity decides —
       which is the original bug wearing a different hat. Array sort is stable,
       so rankByRelevance's ordering survives inside a band. */
    ranked.sort((a, b) => {
      const band = Math.round(b._score * 20) - Math.round(a._score * 20);
      if (band) return band;
      return byAuthor
        ? (b.notability || 0) - (a.notability || 0)
        : (b.pop || 0) - (a.pop || 0);
    });

    /* Step 4 — collapse near-duplicate records.

       Keyed on the folded main title plus the primary author's surname, which
       is BT.normalize.matchKey — the same key 25-googlebooks uses to collapse
       printings, so the two levels of deduplication cannot disagree.

       THE AUTHOR HALF IS LOAD-BEARING: Open Library's attributions are
       unreliable enough that the real "Dune" comes back credited to Brian
       Herbert, so two rows that disagree about who wrote a book are two records
       we are not entitled to merge. The survivor is whichever ranked highest.

       A row with no usable key — untitled, which step 1 has already filtered —
       would bucket with every other keyless row, so it is passed through
       uncollapsed instead. */
    const seen = new Map();
    const out = [];
    for (const r of ranked) {
      const key = BT.normalize.matchKey(mainTitle(r.title), (r.stub.authors || []).map(a => a && a.name));
      if (!key) { out.push(r); continue; }
      const hit = seen.get(key);
      if (hit) { hit._dupes++; continue; }
      seen.set(key, r);
      out.push(r);
    }
    return out;
  }

  /* ══ RENDER ═════════════════════════════════════════════════════════════ */

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;

    /* The route's `?q=` wins; otherwise the last thing typed this session is
       restored. Tapping a result opens the inspector, which on a narrow screen
       is a drawer over this list — coming back to an empty box would make
       browsing results feel like starting over. */
    query = (q && q.q) || query || '';

    BT.ui.crumb(['Discover', 'Search']);
    BT.ui.paneActions('<a class="btn btn--sm" href="#/scan">Scan a barcode</a>');

    const count = await BT.repo.countItems();
    await loadFollows();
    if (alive && !alive()) return;

    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="q" type="search" placeholder="Search by title or author…" spellcheck="false"
                 autocomplete="off" autocapitalize="none" autocorrect="off" enterkeyhint="search"
                 value="${esc(query)}" aria-label="Search for a book">
        </div>
        <!-- ONE <span> PER .shint, and it is not decoration. .shint is a flex
             container, so every text node and every <kbd>/<b> inside it becomes
             a separate flex item: line breaks can then only happen at those
             boundaries, never between words, and the 6px gap opens mid-clause.
             Written bare, the sentence below broke after <b>work</b> and put
             the comma at the start of the next line. -->
        <div class="shint">
          <span><kbd>⏎</kbd> add the highlighted result · <kbd>↑</kbd><kbd>↓</kbd> move ·
          <b>${count}</b> already on your shelves</span>
        </div>
      </div>

      ${keyPromptDue() ? keyPromptHtml() : ''}

      <div class="toolbar">
        <span class="count" id="resCount"></span>
        <div class="spacer"></div>
        <span class="count" id="resSrc">${esc(sourceLabel())}</span>
      </div>

      <div id="results"></div>`;

    /* The DOM this state described has just been thrown away, so the state goes
       with it — `rows` kept across a re-mount would make the next fetch take the
       "results already on screen, dim them" branch over an empty container, and
       a request still in flight would resolve into a detached node while the
       fresh view issued a second one for the same words. The session CACHE is
       deliberately not cleared: that is what makes coming back free. */
    if (inflight) { inflight.abort(); inflight = null; }
    rows = []; cursor = -1; numFound = 0; collapsed = 0; stale = null;

    const prompt = document.getElementById('gbPrompt');
    if (prompt) {
      prompt.addEventListener('click', e => {
        if (!e.target.closest('[data-dismiss]')) return;
        dismissKeyPrompt();
        prompt.remove();
      });
    }

    const input = document.getElementById('q');
    /* 350ms floor, and it is a rate-limit decision rather than a feel one. Open
       Library's sustained anonymous budget is ONE request per second and Google
       is a daily allowance out of the user's own key; a 240ms debounce fires
       four times a second while someone types a title, which is four times the
       whole app's allowance spent on answers nobody will read. Longer on touch,
       because thumb typing has bigger inter-key gaps. */
    const wait = matchMedia('(pointer: coarse)').matches ? 420 : 350;
    const run = BT.util.debounce(() => go(input.value.trim()), wait);
    input.addEventListener('input', run);
    input.addEventListener('keydown', onKey);

    /* Don't steal focus on a phone — an auto-opening keyboard on arrival is
       hostile when you came here from the index rather than to type. */
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
    if (query) go(query);
    else showIdle();
  }

  /* THE ONE PLACE THE APP MENTIONS THE KEY, and it is a prompt with a
     destination rather than a paragraph about how the app is built. Shown when
     there is no key, dismissed for good on the first tap, and it names the
     thing the reader loses rather than the API that would restore it. */
  function keyPromptHtml() {
    return `<div class="warnbox" id="gbPrompt">
      <strong>Dates are years only</strong>
      Searching Open Library alone. Add a Google Books key for exact
      publication dates and forthcoming titles.
      <a class="btn btn--sm" href="#/settings">Open Settings</a>
      <button class="btn btn--sm" type="button" data-dismiss>Not now</button>
    </div>`;
  }

  /* Attribution, in the footer sense — which catalogues answered this query.
     It is the one piece of source text the app keeps, because a reader
     comparing a date against a publisher's website is entitled to know who
     said it. */
  function sourceLabel() {
    if (sources) return sources;
    return (BT.googlebooks && BT.googlebooks.enabled())
      ? 'Google Books · Open Library'
      : 'Open Library';
  }

  /* Every write to #results that does NOT come from paint() goes through here.

     paint() skips a repaint whose signature matches what is already on screen,
     which is what stops the covers re-decoding and flashing on every keystroke.
     That check is only sound if the signature always describes the CURRENT
     contents — and an empty state, a skeleton or an error box written straight
     over the list leaves the old signature in place. The bug that produces is
     exact and reproducible: search "dune", clear the box (idle state paints),
     type "dune" again (cache hit, identical html), and paint() decides nothing
     has changed and leaves the idle state up. */
  function replace(host, html) {
    if (!host) return;
    host.classList.remove('is-stale');
    host.innerHTML = html;
    host.dataset.sig = '';
  }

  function showIdle() {
    setCount('');
    const host = document.getElementById('results');
    if (!host) return;
    replace(host, BT.ui.emptyState({
      title: 'Find a book',
      body: 'Type a title or an author’s name.',
      actions: '<a class="btn" href="#/scan">Scan a barcode instead</a>',
    }));
  }

  function setCount(text) {
    const el = document.getElementById('resCount');
    if (el) el.textContent = text || '';
  }

  function setSources(text) {
    sources = text || '';
    const el = document.getElementById('resSrc');
    if (el) el.textContent = sourceLabel();
  }

  /* ── Keyboard ────────────────────────────────────────────────────────── */

  async function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      cursor = e.key === 'ArrowDown' ? Math.min(rows.length - 1, cursor + 1) : Math.max(0, cursor - 1);
      paintCursor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const at = cursor >= 0 ? cursor : 0;
      const pick = rows[at];
      if (!pick) return;
      if (pick.owned) { BT.inspector.show(pick.stub.uid); return; }
      const el = document.querySelectorAll('#results .miss')[at];
      await addRow(pick, el ? el.querySelector('[data-add]') : null);
    }
  }

  function paintCursor() {
    const els = [...document.querySelectorAll('#results .miss')];
    els.forEach((r, i) => r.classList.toggle('is-sel', i === cursor));
    if (els[cursor]) els[cursor].scrollIntoView({ block: 'nearest' });
  }

  /* ── Fetching ─────────────────────────────────────────────────────────── */

  /* ── SEAM ──────────────────────────────────────────────────────────────
     Feature-detected rather than assumed, the same way 50-ui-core guards
     BT.sync: a bare call would be a TypeError inside a debounce callback, where
     it produces a search box that does nothing at all and logs once, three
     keystrokes ago.

     BT.googlebooks is deliberately NOT in this list. The Google half is
     optional by design — no key is a supported, ordinary state — so its absence
     degrades the results rather than breaking the screen. */
  function missingDeps() {
    const out = [];
    if (!BT.openlibrary || typeof BT.openlibrary.search !== 'function') out.push('20-openlibrary.js');
    if (!BT.normalize || typeof BT.normalize.stubFromVolume !== 'function') out.push('38-normalize.js');
    return out;
  }

  function googleOn() {
    return !!(BT.googlebooks
      && typeof BT.googlebooks.search === 'function'
      && typeof BT.googlebooks.enabled === 'function'
      && BT.googlebooks.enabled());
  }

  async function go(q) {
    query = q;
    const host = document.getElementById('results');
    if (!host) return;

    if (q.length < 2) {
      rows = []; cursor = -1; numFound = 0; collapsed = 0; stale = null;
      if (inflight) { inflight.abort(); inflight = null; }
      setSources('');
      showIdle();
      return;
    }

    const gap = missingDeps();
    if (gap.length) {
      rows = []; cursor = -1;
      setCount('');
      replace(host, BT.ui.errorBox('Search is not wired up on this page',
        `The catalogue client is missing (${gap.join(', ')}). Your library still works.`));
      return;
    }

    /* A cached row set carries the ownership marks it was built with. They are
       not re-checked here — that would be a repo read per row on a path whose
       whole purpose is to be free — and they do not need to be: the marks are
       mutated in place when this screen adds something, and a book added
       elsewhere is caught by BT.ui.addItem's own dedup, which returns the
       existing record and lets addRow correct the row on the spot. */
    /* THE KEY CARRIES WHICH CATALOGUES WERE ASKED, not only the words. Without
       it, adding a Google key in Settings and returning to a search run a
       minute earlier serves the Open Library-only rows straight back out of
       this Map — same words, same key, cache hit — so the feature the reader
       just switched on appears not to work. One character on a Map key against
       a bug with no error message anywhere. */
    const key = (googleOn() ? 'gb:' : 'ol:') + q.toLowerCase();
    if (cache.has(key)) {
      const hit = cache.get(key);
      rows = hit.rows; numFound = hit.numFound; collapsed = hit.collapsed; stale = null;
      cursor = -1;
      setSources(hit.sources);
      host.classList.remove('is-stale');
      paint();
      return;
    }

    /* Only show skeletons when there is nothing to keep. Replacing a full
       result list with skeletons on every keystroke collapses the list height
       and springs it back, which is what made typing feel jerky on a phone. */
    if (!rows.length) replace(host, BT.ui.skeletonGrid(4));
    else host.classList.add('is-stale');

    /* One query at a time, and the old one is cancelled rather than left to
       finish. Two reasons, and the second is the important one: a token spent
       on a superseded query is a token the NEXT query has to wait for, and on
       Google it is a request off a daily allowance. */
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    /* 05-net fills these in when it serves a soft-expired cache row because the
       upstream could not be reached. One per source, because either can be
       stale independently. */
    const olMeta = {};
    const gbMeta = {};

    /* BOTH CATALOGUES, IN PARALLEL, AND NEITHER CAN FAIL THE OTHER.
       allSettled rather than all: Google being over budget or Open Library
       being in a maintenance window must degrade the answer, never empty the
       screen. The two are only reported as a failure when BOTH failed. */
    const wantGoogle = googleOn();
    const [gbRes, olRes] = await Promise.allSettled([
      wantGoogle
        /* `ttl` STATED, because the adapter's default is the long one — a
           volume record is a frozen artefact and most callers are looking up a
           fact. A SEARCH is a live question, and the whole reason this app
           leads with Google is that its index gains forthcoming titles: a query
           cached for a month would be a month blind to exactly what it is for. */
        ? BT.googlebooks.search(q, {
            signal, meta: gbMeta, limit: BT.GB.MAX_RESULTS, rich: true, ttl: BT.TTL.gbSearch })
        : Promise.resolve({ items: [], totalItems: 0, checked: false }),
      BT.openlibrary.search(q, { signal, meta: olMeta, limit: BT.LIMITS.searchResults }),
    ]);
    if (signal.aborted) return;

    const gbOk = gbRes.status === 'fulfilled';
    const olOk = olRes.status === 'fulfilled';

    /* An abort is not a failure and must not paint anything — it means the
       reader kept typing. Checked on both settled reasons because 05-net
       classifies its own aborts as kind 'abort' while a raw DOMException can
       also surface here. */
    for (const r of [gbRes, olRes]) {
      if (r.status === 'rejected'
          && r.reason && (r.reason.kind === 'abort' || r.reason.name === 'AbortError')) return;
    }

    if (!gbOk && !olOk) {
      rows = []; cursor = -1;
      setCount('');
      setSources('');
      replace(host, failureBox(olRes.reason));
      return;
    }

    const vols = gbOk ? (gbRes.value.items || []) : [];
    const docs = olOk ? (olRes.value.docs || []) : [];

    numFound = Math.max(
      gbOk ? (gbRes.value.totalItems || 0) : 0,
      olOk ? (olRes.value.numFound || 0) : 0);

    /* WHICH CATALOGUES ACTUALLY ANSWERED — named plainly, because a thin result
       set during a partial outage is otherwise indistinguishable from a book
       that does not exist. This is attribution, not explanation. */
    const answered = [];
    if (gbOk && gbRes.value.checked) answered.push('Google Books');
    if (olOk) answered.push('Open Library');
    setSources(answered.join(' · ') || 'No catalogue answered');

    stale = (olMeta.stale || gbMeta.stale)
      ? (olMeta.reason || gbMeta.reason || 'A catalogue could not be reached')
      : (wantGoogle && !gbOk ? 'Google Books did not answer'
        : (!olOk ? 'Open Library did not answer' : null));

    /* THE POINT OF THIS SCREEN. Everything upstream of here is transport. */
    const ranked = rerank(q, buildCandidates(vols, docs)).slice(0, BT.LIMITS.searchResults);
    collapsed = ranked.reduce((n, r) => n + (r._dupes || 0), 0);

    const next = [];
    for (const r of ranked) {
      if (!r.stub || !r.stub.uid) continue;
      next.push({
        stub: r.stub, doc: r.doc, vol: r.vol,
        score: r._score, owned: await ownedStatus(r.stub),
      });
    }
    if (signal.aborted) return;

    rows = next;
    /* A degraded answer must not be cached as if it were the real one: the next
       search for the same words would serve the gap back with no explanation. */
    if (!stale) cache.set(key, { rows, numFound, collapsed, sources });
    cursor = -1;
    host.classList.remove('is-stale');
    paint();
    /* NOTHING here may touch the input's value or selection. An earlier version
       moved the caret to the end of the query it had STARTED with, which lands
       mid-word if you kept typing during the fetch — so the next keystrokes
       insert at the wrong offset and the title comes out scrambled ("the left
       hand" -> "the lefthand "). The caret is already where the user put it. */
  }

  /* ── Dedup against the library ─────────────────────────────────────────
     ASKED THE SAME WAY BT.ui.addItem ASKS IT, which is the whole point: this
     screen must never offer an Add that addItem will refuse, and it must never
     hide one it would accept. `BT.repo.idKeysFor` is scope-aware and answers
     "what does this record claim?" — for an open search stub that is
     `olwork:{OLID}` plus any `isbncand:` rows, and never the pinned `isbn13:`
     namespace, which belongs to a copy somebody actually holds.

     Crossing those namespaces is the whole scan story: an open item lists every
     ISBN Open Library knows for the work, so matching the SCANNER against
     work-level keys would tell it you already own every printing of everything
     you ever searched for. See the namespace comment in 12-repo.js.

     resolveUid rather than a scan of allItems() and a uid comparison, because
     the uid is not the question. An item added by barcode has the uid
     `book:isbn:9780441172719` and still CLAIMS `olwork:OL27482W` — comparing
     uids would miss it and offer to add a duplicate. */
  async function ownedStatus(stub) {
    const keys = BT.repo.idKeysFor(stub);
    if (!keys.length) return null;
    const uid = await BT.repo.resolveUid(keys);
    if (!uid) return null;
    const item = await BT.repo.getItem(uid);
    return item ? ownedMark(item) : null;
  }

  /* WHAT AN ALREADY-OWNED ROW SAYS, and it is the READING axis rather than the
     ownership one. This row is answering "should I add this?", and the useful
     half of the answer is what the reader has done with the copy they already
     filed — "Finished" tells them something, "Own" is one word for what the
     tick already said.

     Truthy for every legal value, which the caller depends on: `r.owned`
     partitions the results into "already on your shelves" and the rest, and a
     falsy mark would put a book you own back into the Add list. Every value in
     BT.ui.READINGS has a non-empty label, so the string is always truthy. */
  const ownedMark = item => BT.ui.readingWord(BT.ui.readingOf(item));

  /* A source that is DOWN and a source that found nothing are different facts,
     and collapsing them is how "Nothing matching Piranesi" gets shown during an
     outage — which is untrue and sends the reader off to check their spelling.
     Every branch here says which one happened. */
  function failureBox(e) {
    const kind = (e && e.kind) || 'server';
    if (kind === 'offline') {
      return BT.ui.errorBox('You appear to be offline',
        'Search needs a connection. Everything already on your shelves still works.');
    }
    if (kind === 'notfound') {
      return BT.ui.errorBox('A web page answered instead of a catalogue record',
        'That usually means a captive portal — hotel or café wifi with a login screen — is answering for it.');
    }
    if (kind === 'budget' || kind === 'quota-soft') {
      return BT.ui.errorBox('Too many requests, too quickly',
        'Give it a moment and type again. Nothing was lost.');
    }
    return BT.ui.errorBox('No catalogue is answering',
      `${(e && e.message) || String(e)}`);
  }

  /* ── Painting ─────────────────────────────────────────────────────────── */

  function paint() {
    const host = document.getElementById('results');
    if (!host) return;

    if (!rows.length) {
      setCount('');
      /* An ISBN typed into a title box is a dead end worth naming: search
         matches words, and thirteen digits are not words. The empty state says
         what to do about it rather than what happened. */
      const scan = BT.util.normalizeScanCode(query);
      replace(host, BT.ui.emptyState({
        title: `Nothing matching “${esc(query)}”`,
        body: scan.ok
          ? 'That is an ISBN. Scan it instead and BookTrak adds that exact printing.'
          : 'Try fewer words, or the author’s name.',
        actions: scan.ok ? '<a class="btn" href="#/scan">Go to the scanner</a>' : '',
      }));
      return;
    }

    const bits = [`${rows.length} shown`];
    if (numFound > rows.length) bits.push(`${BT.util.formatVotes(numFound)} in the catalogues`);
    if (collapsed) bits.push(BT.util.pluralize(collapsed, 'duplicate record') + ' collapsed');
    setCount(bits.join(' · '));

    /* Results served from cache during an outage are still results, but the
       reader is entitled to know they are not live — a book published this week
       genuinely will not be in them. */
    const note = stale
      ? `<div class="warnbox"><strong>Some results may be missing</strong>${esc(stale)}.</div>`
      : '';

    const mine = rows.filter(r => r.owned);
    const fresh = rows.filter(r => !r.owned);

    const html = note +
      (mine.length ? BT.ui.groupHead('Already on your shelves', mine.length) + mine.map(row).join('') : '') +
      (fresh.length ? BT.ui.groupHead('Results', fresh.length) + fresh.map(row).join('') : '');

    /* Skip the write when nothing changed — otherwise every paint re-creates
       the cover <img> elements and they flash as they re-decode. */
    if (host.dataset.sig !== html.length + ':' + rows.length) {
      host.innerHTML = html;
      host.dataset.sig = html.length + ':' + rows.length;
    }

    /* Adding is deliberate: only the Add button adds. Tapping the row opens the
       inspector, which is safe and reversible. The row used to carry the add
       handler itself, so a scroll that ended in a tap silently added whatever
       was under your thumb. */
    host.onclick = async e => {
      /* FIRST, and it has to be: a follow chip sits INSIDE the row, so the
         `[data-uid]` branch below would match it too and open the inspector
         over the list every time someone followed an author. */
      const followBtn = e.target.closest('[data-fa]');
      if (followBtn) {
        if (suppressTap()) return;
        await toggleFollow(followBtn);
        return;
      }
      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const hit = rows.find(r => r.stub.uid === addBtn.dataset.add);
        if (!hit || hit.owned) return;
        await addRow(hit, addBtn);
        return;
      }
      const el = e.target.closest('[data-uid]');
      if (!el || suppressTap()) return;
      const hit = rows.find(r => r.stub.uid === el.dataset.uid);
      /* The inspector fetches a record it does not hold, so this works for a
         result that is not on the shelves yet — one deliberate request for one
         deliberate tap, and it never adds anything. */
      if (hit) BT.inspector.show(hit.stub.uid);
    };

    /* A tap that follows finger movement is a scroll, not a tap. Browsers still
       fire click after a short drag, which on a dense list means a flick can
       land on whatever was underneath. */
    host.ontouchstart = e => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
      moved = false;
    };
    host.ontouchmove = e => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - touchStart.y) > 8 || Math.abs(t.clientX - touchStart.x) > 8) moved = true;
    };

    paintCursor();
  }

  /* ── Adding ────────────────────────────────────────────────────────────
     THE SURGICAL SWAP. `btn` is the button that was pressed (or the one under
     the keyboard cursor); it is replaced in place with the "in your library"
     marker and NOTHING ELSE IS REDRAWN.

     A full paint() would re-partition the list into "Already on your shelves"
     and "Results", so the row just added leaps out of position and up into the
     other group, dragging the scroll with it and sliding an unrelated row under
     the finger that is still on the glass. Adding four books from one search —
     the normal way this screen is used — meant re-finding your place four
     times, and twice meant adding the wrong book. */
  async function addRow(hit, btn) {
    const added = await addStub(hit.stub);
    if (!added) return;
    hit.owned = ownedMark(added);
    if (!btn) { paint(); return; }                // no element to swap: rebuild
    btn.outerHTML = `<span class="add is-in">✓ ${esc(hit.owned)}</span>`;
    /* The signature no longer describes what is on screen, so the next REAL
       paint must not skip itself. */
    const host = document.getElementById('results');
    if (host) host.dataset.sig = '';
  }

  /* `scope: 'open'` is stated, never inferred. A search result is a WORK: the
     reader means the book, not the 1990 Ace paperback, and choosing an edition
     on their behalf would stamp a cover, a publisher and a page count onto the
     record that they never picked. That holds for a Google row too, even though
     a Google volume IS one printing — its ISBNs go to the candidate namespace
     and the reader can pin one later. The scanner passes 'closed' from the
     other door, because there the reader was holding the object. */
  async function addStub(stub) {
    try {
      /* BOTH AXES STATED, rather than left to addItem's default, so the choice
         is visible where the write is made — the same discipline 39-scan's
         scanOpts keeps for the other door. want + unread, because looking a
         title up says you would like to read it and nothing more: it is not a
         claim that a copy is on your shelf, which is exactly what the scan door
         claims and this one must not. */
      return await BT.ui.addItem(stub, {
        scope: 'open', source: 'search',
        state: { ownership: 'want', reading: 'unread' },
      });
    } catch (e) {
      /* addItem writes the item BEFORE it records an alert baseline. If it
         threw after the write, the book IS on the shelves, and reporting a
         failure would send the reader off to add it a second time. Ask the id
         index what actually happened rather than trusting the exception. */
      console.warn('[search] addItem threw', e);
      const uid = await BT.repo.resolveUid(BT.repo.idKeysFor(stub));
      const item = uid ? await BT.repo.getItem(uid) : null;
      if (item) return item;
      BT.ui.toast(`Could not add “${BT.util.truncate(stub.title, 40)}”`, { bad: true });
      return null;
    }
  }

  /* ── One row ───────────────────────────────────────────────────────────── */

  function row(r) {
    const s = r.stub;
    /* The cover box is sized here rather than in the shared stylesheet: 30px is
       specific to this row, and BT.ui.poster draws a block with no dimensions
       of its own so that every caller states the size it needs. */
    return `<div class="miss" data-uid="${esc(s.uid)}">
      <span style="display:grid;width:30px;flex:0 0 30px;aspect-ratio:2/3">${BT.ui.poster(s, { size: 'sm' })}</span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${byline(s)}${releaseCell(s)}${editionsNote(r.doc)}
        </div>
      </div>
      ${r.owned
        ? `<span class="add is-in">✓ ${esc(r.owned)}</span>`
        : `<button class="add" type="button" data-add="${esc(s.uid)}" aria-label="Add ${esc(s.title)}">Add</button>`}
    </div>`;
  }

  /* THE DATE, IN THE APP'S OWN GRAMMAR — hatched where the record does not say.
     A Google row renders 2024-12-06; an Open Library-only row renders
     2024-▨▨-▨▨, which reads as "the year is all this record has" without a word
     of explanation. That grammar is why the old "first recorded 2024" caption
     and its tooltip are gone: the field already says what it knows. */
  function releaseCell(stub) {
    return `<span class="mono">${BT.ui.dateField(stub.release)}</span>`;
  }

  /* Printings Open Library has catalogued. Shown only where there are several,
     because "1 edition" is noise and a large number is the reason the "Specify
     edition" picker exists at all. Absent on a Google-only row: Google has no
     work graph and therefore cannot count printings — it does not guess. */
  function editionsNote(doc) {
    const n = Number(doc && doc.edition_count) || 0;
    if (n < 2) return '';
    return `<span class="faint">${esc(BT.util.pluralize(n, 'edition'))}</span>`;
  }

  /* ══ FOLLOWING, FROM A RESULT ROW ═══════════════════════════════════════
     ── SEAM ──────────────────────────────────────────────────────────────
     70-follows.js is optional to this screen. Feature-detected the same way the
     catalogue client is: without it the byline renders as plain text and
     nothing else changes. */
  function canFollow() {
    /* All three, because a byline draws with authorId(), fills its state from
       all() and acts through toggleAuthor(). Checking one and calling another
       is how a half-loaded module turns a search into a blank screen instead of
       a search with no Follow buttons. */
    return !!(BT.follows
      && typeof BT.follows.toggleAuthor === 'function'
      && typeof BT.follows.authorId === 'function'
      && typeof BT.follows.all === 'function');
  }

  async function loadFollows() {
    if (!canFollow()) { followSet = new Set(); return; }
    try {
      followSet = new Set((await BT.follows.all()).map(f => f.id));
    } catch (e) {
      /* A follow list we could not read is not a reason to fail a search. The
         chips render unpressed, and pressing one still works — the toggle asks
         the repo itself rather than trusting this set. */
      console.warn('[search] could not read follows', e);
      followSet = new Set();
    }
  }

  /* THE BYLINE CARRIES BOTH HALVES OF AN AUTHOR'S IDENTITY, and that is the
     whole reason it is read off the merged STUB rather than off either raw
     payload.

     `authors` on a merged row is the output of
     BT.normalize.mergeAuthorIdentities: Google's exact name string plus Open
     Library's OLID on one record. A follow needs both —

       · the OLID, because a name-scoped author query returns the WRONG
         AUTHOR'S BOOKS at HTTP 200 in both catalogues
         (`author=gwendolyn+kiste` -> Laird Barron; `inauthor:Kiste` -> Queen
         Victoria), so a follow may never be keyed on a name;
       · Google's exact spelling, because Google has no author id at all and
         its index matches on the string. 'J.R.R. Tolkien' and 'J. R. R.
         Tolkien' return different result sets, and the forthcoming book will
         be in Google's index and not in Open Library's.

     An author with no OLID is rendered as plain text. Not as a disabled button,
     not as a Follow that quietly falls back to the name — the latter is not a
     degraded follow, it is a confident feed of the wrong writer. */
  function byline(stub) {
    const people = (stub.authors || [])
      .filter(a => a && a.name)
      .map(a => ({ name: a.name, olid: a.olid || '', gbName: a.gbName || '' }));
    if (!people.length) return '<span class="faint">Author not recorded</span>';

    /* Two. A row is one line and an omnibus can credit nine people; the rest
       are counted rather than listed, and are reachable from the item's own
       detail pane. */
    const shown = people.slice(0, 2);
    const more = people.length > shown.length
      ? `<span class="faint">+${people.length - shown.length}</span>` : '';

    if (!canFollow()) {
      return `<span>${esc(shown.map(p => p.name).join(', '))}</span>${more}`;
    }
    return shown.map(authorChip).join('') + more;
  }

  function authorChip(p) {
    if (!p.olid) return `<span>${esc(p.name)}</span>`;
    const id = BT.follows.authorId(p.olid);
    const on = followSet.has(id);
    /* .chip already styles [aria-pressed="true"] as the teal "on" state, so the
       state is carried by the attribute a screen reader reads rather than by a
       class the stylesheet and this file would both have to agree about.

       `data-gbn` rides along so the toggle can hand 70-follows the Google name
       WITHOUT a second lookup. It is the only moment both identifiers are on
       screen together, and re-deriving it later costs a Google request against
       a key that may by then be gone. */
    return `<button class="chip" type="button" data-fa="${esc(p.olid)}" data-fid="${esc(id)}"
      data-fn="${esc(p.name)}" data-gbn="${esc(p.gbName)}" aria-pressed="${on ? 'true' : 'false'}"
      title="${on ? 'Unfollow' : 'Follow'} ${esc(p.name)}"
      >${esc(p.name)}<b>${on ? '✓' : '+'}</b></button>`;
  }

  async function toggleFollow(btn) {
    const olid = btn.dataset.fa;
    const name = btn.dataset.fn || '';
    /* The third argument is the Google Books spelling of the same person, and
       it is passed positionally so that a build of 70-follows which does not
       yet read it simply ignores it rather than failing. A follow that stores
       it can query both catalogues with the identifier each understands; one
       that does not falls back to the Open Library name, which is what happened
       before this existed. */
    const gbName = btn.dataset.gbn || '';
    btn.disabled = true;
    let res = null;
    try {
      res = await BT.follows.toggleAuthor(olid, name, gbName);
    } catch (e) {
      console.warn('[search] follow failed', e);
    } finally {
      btn.disabled = false;
    }
    if (!res) {
      BT.ui.toast('That record carries no author id, so it cannot be followed.', { bad: true });
      return;
    }
    if (res.following) followSet.add(res.id); else followSet.delete(res.id);
    markFollowButtons(res.id, res.following, res.name);
    BT.ui.toast(res.following ? `Following ${res.name}` : `Unfollowed ${res.name}`);
  }

  /* EVERY chip for this author, not only the one that was pressed. A search for
     an author's name returns thirty of their books, so one press means thirty
     chips are now wrong — a list that shows the same person as followed on one
     row and not on the next reads as a bug in the app.

     Scanned and compared rather than matched with an attribute selector: a
     follow id is `author:openlibrary:OL1394865A`, and a colon is a combinator
     in CSS. A selector built from one needs CSS.escape and fails SILENTLY
     without it — no error, just buttons saying the opposite of the truth. */
  function markFollowButtons(id, on, name) {
    for (const b of document.querySelectorAll('#results [data-fid]')) {
      if (b.dataset.fid !== id) continue;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = `${on ? 'Unfollow' : 'Follow'} ${name}`;
      b.innerHTML = `${esc(b.dataset.fn || name)}<b>${on ? '✓' : '+'}</b>`;
    }
    /* The DOM no longer matches the signature paint() recorded, so the next
       real paint must not skip itself. Same rule as the Add-button swap. */
    const host = document.getElementById('results');
    if (host) host.dataset.sig = '';
  }

  /* rerank and buildCandidates are exported alongside render on purpose: both
     encode measured behaviour of two live third-party APIs, so the day results
     look wrong again they have to be callable from the console against real
     payloads, without a build step and without editing this file. */
  return { render, rerank, buildCandidates };
})();
