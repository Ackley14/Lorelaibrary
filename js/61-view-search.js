/* ══════════════════════════════════════════════════════════════════════════
   #/search — find a book by title OR AUTHOR and put it on a shelf.

   Both, and the "or author" half is not a nicety — see FAILURE 2 in rerank().
   Ranking here was title-only for a while and an author's name returned an
   empty screen while the catalogue held seventy-one of her books.

   This screen is small. One input, one list, one button per row. Almost all of
   the code below exists for a single reason, and it is worth stating plainly
   before anyone decides the file is longer than it needs to be:

   OPEN LIBRARY'S RESULT ORDER CANNOT BE SHOWN TO A USER, AND THERE IS NO
   SERVER-SIDE WAY TO FIX IT.

   Verified against the live API. `search.json?q=dune` answers, in order:
   *Children of Dune* at #1; *Go Ask Alice* — which contains neither the word
   nor anything to do with it — at #6; and the only doc actually TITLED "Dune"
   at #8, where it is misattributed to Brian Herbert and dated 2001. A reader
   typing the most famous four-letter title in science fiction does not see it
   on the first screen.

   The obvious fix is to ask the server for a better order, and that is a trap
   with no error message at the end of it. Sending `sort=` alongside a free-text
   `q` makes Open Library SILENTLY DISCARD the query: `q=dune&sort=editions`
   returns HTTP 200, a full result set, and *Robinson Crusoe* at the top. Not an
   error, not an empty list — a confident, wrong answer. (`sort=new` is safe
   only on an `?author=` query, where there is no `q` to throw away.) So the
   ordering has to be recomputed here, on the client, from the docs we were
   given. See rerank(), and read its comment before touching it.

   The other thing this file is careful about is not moving the ground under
   someone's thumb. Adding a book swaps ONE BUTTON in place rather than
   repainting: a repaint re-partitions the list into "On your shelves" and
   "Results", so the row you just added leaps into the other group and the next
   row slides up under your finger. Adding four books in a row was unusable
   before that. See the note in paint().

   FOLLOWING AN AUTHOR HAPPENS HERE TOO, and that is a deliberate answer to a
   reported bug rather than a spare button. The complaint was "I couldn't
   figure out how to follow an author", from someone who had a Following page
   the whole time — because a search result is where you are standing when the
   thought arrives, and a feature that lives only on the page named after it is
   a feature nobody finds. So the byline's author names are the affordance. See
   byline(); the OLID rule it enforces is FAILURE 2 in rerank(), which is the
   measured reason a follow may never be keyed on a name.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewSearch = (function () {
  const esc = BT.util.escapeHtml;

  /* ── Session state ─────────────────────────────────────────────────────
     `cache` is per QUERY and lives for the session. MovieTrak keyed it by
     (tab, query) because it had five tabs across two providers; there is one
     source here and one kind of thing to find, so the query alone is the key.
     Cheap and worth it: Open Library's sustained budget is one request per
     second, and re-typing a query you just ran must not spend one of those. */
  const cache = new Map();

  let inflight = null;      // AbortController for the request in flight
  let rows = [];            // [{ stub, doc, owned, score }]
  let cursor = -1;          // keyboard position within `rows`
  let query = '';           // survives a trip to the inspector and back
  let numFound = 0;         // what the catalogue claims, not what we show
  let collapsed = 0;        // duplicate work records folded away by rerank()
  let stale = null;         // set when results came from cache during an outage
  let touchStart = null;
  let moved = false;
  /* Follow ids, so a byline can be drawn with the right state without a repo
     read per author per row. Loaded once per render and mutated in place by
     toggleFollow — the same surgical-swap discipline the Add button uses. */
  let followSet = new Set();

  /* True when the click we are handling is the tail of a scroll gesture. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  /* ══ RE-RANKING ═════════════════════════════════════════════════════════
     TWO MEASURED FAILURES THIS FUNCTION EXISTS TO FIX. Both were reproduced
     live, both are silent, and each is one "simplification" away from coming
     back — the natural cleanup for either one REINTRODUCES THE OTHER. Do not
     delete this as over-engineering, and do not replace it with a `sort=`
     parameter.

     ── FAILURE 1: the wrong book first (`q=dune`) ─────────────────────────
     Live, on openlibrary.org/search.json, `q=dune` returns:

         #1   Children of Dune
         #6   Go Ask Alice               (contains neither word)
         #8   Dune                       ← Brian Herbert, first_publish_year
                                           2001, 10 editions
         #24  Dune                       ← THE NOVEL. Frank Herbert, 1965,
                                           160 editions — twenty-third place
                                           for the most famous four-letter
                                           title in science fiction

     Whatever Open Library's relevance model is optimising, it is not "the book
     the user just typed the name of". Their default ordering leans hard on
     catalogue mass — a work with four hundred recorded printings outranks an
     exact title match with three — which is why omnibuses, companion volumes
     and study guides colonise the top of every popular query.

     And the server cannot be asked to do better. `sort=` combined with a
     free-text `q` DISCARDS THE QUERY and answers 200 with an unrelated list
     (`q=dune&sort=editions` → *Robinson Crusoe*). There is no failure to catch;
     the wrong answer looks exactly like a right one. Client-side is the only
     side.

     ── FAILURE 2: no books at all (`q=gwendolyn kiste`) ───────────────────
     Searching an AUTHOR'S NAME returned an empty screen. Open Library was
     blameless: `q=gwendolyn+kiste` answers numFound 71 with all six top docs
     hers — *Reluctant Immortals* (2022), *The Haunting of Velkwood* (2024),
     *The Rust Maidens* (2018), *Pretty Marys All in a Row* (2017), *And Her
     Smile Will Untether the Universe* (2017), *Boneset & Feathers* (2020).

     This function threw every one of them away. Scoring was TITLE-ONLY, so
     "gwendolyn" and "kiste" — words that appear in none of those titles —
     scored 0 coverage on all 71 docs, and the multi-word coverage gate inside
     rankByRelevance (insist every query word appears) then dropped the entire
     result set. A domain mismatch inherited from MovieTrak, where you search
     films by title and title-only relevance was fine. BOOKS ARE SEARCHED BY
     AUTHOR AS A PRIMARY USE CASE, and this screen's own placeholder promises
     it ("Search by title or author…").

     AND `author=` IS NOT THE ALTERNATIVE. The tempting fix — detect an author
     query and send `search.json?author=gwendolyn+kiste` — was tried live and
     returns LAIRD BARRON'S books: *Occultation*, *Swift to Chase*, *The
     Beautiful Thing That Awaits Us All*. Not an error, not empty: a confident
     list of the wrong author. Name-scoped `author=` is fuzzy matching over a
     name index and cannot be trusted with a user's query. Only OLID-scoped
     author queries (`author=OL1394865A`, which is what authorWorks() sends)
     mean what they say. The author-following feature has since landed and is
     built on exactly that: BT.follows.toggleAuthor REFUSES a follow it cannot
     key on an OLID, and byline() below renders an id-less author as plain text
     rather than offering a Follow that would watch the wrong person.

     The model, in order of authority:

       1. MATCH QUALITY DECIDES THE BAND, and a match may be in the title OR
          the author. BT.util.rankByRelevance is the M1 implementation and is
          used as-is: it scores, filters on token coverage, and — the part that
          matters — lets a source's own popularity number order results only
          WITHIN a band, never across one. What changed for books is WHAT it is
          handed: three haystacks per doc rather than one.
             · the title            (weight 1.00)
             · title + authors      (weight 0.95) — the mixed query. "kiste
               rust maidens" and "sanderson mistborn" match neither field
               alone; they only cover every typed word across BOTH.
             · the authors          (weight 0.90) — the pure author query.
          Best weighted score wins, best coverage of ANY of them passes the
          gate. The weights are a tiebreak, not a hierarchy: an author name
          names thirty books where a title names one, so on an equal raw score
          the title match should lead — but 0.90 is nowhere near a band's
          worth of demotion, so an author match still outranks a weak title
          match, which is the whole point.
       2. An exact (or normalized-exact) title match gets a large boost, so the
          novel called "Dune" cannot sit below a novel called "Children of Dune"
          no matter how many editions the latter has.
       3. Query-token coverage adds a smaller boost, so a doc that contains
          every word the reader typed beats one that dropped a word.
       4. POPULARITY IS A TIEBREAK ONLY — for title queries. edition_count,
          readinglog_count and ratings_count order two docs that already match
          equally well. If any of them is ever promoted above match quality,
          this file is back to answering "dune" with *Children of Dune*.

          THE ONE EXCEPTION IS AN AUTHOR-DOMINANT QUERY, and it is not a
          loophole, it is the same rule arriving at a different answer. When
          every result matches on the author and none on the title, every
          result is in the SAME BAND — there is no title signal left to order
          them by, so the tiebreak is doing all the work by construction. What
          it should say then is different too: not "which of these records is
          the real one" (editions, see popOf) but "which of this author's books
          is the one you have heard of" (readers, see notabilityOf). Typing
          "gwendolyn kiste" should answer *Reluctant Immortals*, not whichever
          anthology she has a story in.
       5. Summaries, study guides and workbooks are DEMOTED. They match the
          title of the book they are about — by construction, since that is
          what their own titles are made of — and there are dozens per popular
          work. Not removed: someone may genuinely want one, and hiding records
          the catalogue holds is worse than ranking them last.
       6. Near-duplicate works are collapsed. Open Library holds several work
          records for the same book (separate imports that were never merged),
          and three identical rows read as a bug in this app rather than a fact
          about the data.

     Returns rows sorted best-first, each carrying `_score` (the final,
     adjusted one) and `_dupes` (how many duplicate records it absorbed). */

  /* Titles that exist only because a real book exists. Every one of these
     carries the target book's title inside it, so they score as well as the
     book does on any pure string measure; "summary of dune" is a perfect
     coverage match for "dune". Verified as a real flood on popular queries. */
  const JUNK_RX = /summary of|study guide|workbook|analysis of|companion to|quicklet/i;

  /* "Dune: Book One of the Dune Chronicles" -> "Dune". Catalogue titles carry
     series apparatus, imprint blurb and translator credits in a subtitle, and
     the reader typed the part in front of the colon. It splits the RAW title,
     because BT.util.normalizeTitle has already thrown every separator away by
     the time it hands anything back.

     Built from a string so the separators stay legible: – and — are
     the en and em dash, both of which catalogue records use to hang a subtitle
     off a title, and two dash-like glyphs sitting side by side inside a
     character class are unreadable in source — one tidy-up away from being
     mistaken for a range. */
  const SUBTITLE_RX = new RegExp('\\s*[:;(\\u2013\\u2014]\\s*');

  function mainTitle(raw) {
    const s = String(raw || '');
    return s.split(SUBTITLE_RX)[0] || s;
  }

  /* An alternate title to score against as well as the main one — a translated
     or reissued work is often catalogued under both. rankByRelevance takes the
     BETTER of the two, so an absent field costs nothing. */
  function altTitleOf(doc) {
    const alt = doc && doc.alternative_title;
    if (Array.isArray(alt)) return alt[0] || '';
    return typeof alt === 'string' ? alt : '';
  }

  /* Popularity, squashed to 0..1 so it can act as a tiebreak.

     EDITION COUNT LEADS. That is the opposite of what this function did first,
     and the reason for the reversal is worth stating, because "readers beat
     reprints" is the intuitive rule and it is wrong HERE specifically.

     Remember what this number is for: popularity never crosses a relevance
     band (Step 3 sorts on the band first and only calls popOf inside one), so
     the ONLY question it ever answers is "several records claim the same
     title — which is the real one?". Open Library answers that with editions
     and nothing else, because its reader counts are attached to whichever
     duplicate a reader happened to open, while volunteers merge printings onto
     the canonical work. Measured live on q=dune:

         OL893414W   Dune, Frank Herbert, 1965    160 editions    1 reader
         OL19618275W Dune, Brian Herbert, 2001     10 editions   31 readers
         OL893461W   Dune Messiah, Frank Herbert  101 editions    0 readers

     Weighting readers double therefore handed "Dune" to a 2001 tie-in with ten
     printings, and the reader who typed `dune` and pressed Add got the wrong
     book — the exact failure the re-ranking exists to prevent, arriving by a
     side door after the title match was already correct.

     The original worry (a century of reprints outranking a modern novel) is a
     real effect but a cross-title one, and cross-title ordering is decided by
     the band above, never here. Re-checked against dune, the hobbit, project
     hail mary, dracula, the martian and 1984: only dune changes, and it changes
     to the right answer. Readers and ratings stay in as the secondary signal,
     which is what separates two records of equal cataloguing depth. */
  function popOf(doc) {
    const d = doc || {};
    const editions = Number(d.edition_count) || 0;
    const readers = Number(d.readinglog_count != null ? d.readinglog_count : d.want_to_read_count) || 0;
    const ratings = Number(d.ratings_count) || 0;
    const e = Math.min(1, Math.log10(editions + 1) / 2.7);   // 481 editions ≈ 1.0
    const r = Math.min(1, Math.log10(readers + 1) / 5);      // readinglog runs to ~1e5
    const v = Math.min(1, Math.log10(ratings + 1) / 4);
    return 0.55 * e + 0.30 * r + 0.15 * v;
  }

  /* NOTABILITY, which is popularity asking a different question — see note 4
     in the header. popOf answers "several records claim this title, which is
     the real one?" and leads on editions because that is what volunteers
     actually merge onto the canonical work. This one answers "which of this
     author's books is the one a reader has heard of?", and for that the reader
     counts are the whole point: a book nobody has shelved is not the answer to
     someone typing an author's name, however many printings it has had.

     Measured on `gwendolyn kiste` (readinglog / editions):

         Reluctant Immortals   2022    6 readers    4 editions
         Haunting of Velkwood  2024    2 readers    3 editions
         The Rust Maidens      2018    2 readers    2 editions
         Boneset & Feathers    2020    0 readers    1 edition

     Readers lead and editions break the tie among the twos, which is exactly
     the order a reader would write down. Editions are still weighted heavily
     enough to carry a backlist title that predates Open Library's reading log
     — a 1965 novel with 160 printings and one reader is not obscure. */
  function notabilityOf(doc) {
    const d = doc || {};
    const editions = Number(d.edition_count) || 0;
    const readers = Number(d.readinglog_count != null ? d.readinglog_count : d.want_to_read_count) || 0;
    const ratings = Number(d.ratings_count) || 0;
    const r = Math.min(1, Math.log10(readers + 1) / 5);
    const e = Math.min(1, Math.log10(editions + 1) / 2.7);
    const v = Math.min(1, Math.log10(ratings + 1) / 4);
    return 0.60 * r + 0.28 * e + 0.12 * v;
  }

  function primaryAuthorOf(doc) {
    const names = (doc && doc.author_name) || [];
    return Array.isArray(names) ? String(names[0] || '') : String(names || '');
  }

  /* EVERY author on the record, joined, not just the first. Anthologies and
     collaborations list the person the reader is looking for anywhere in the
     array — Open Library credits *Behold the Undead of Dracula* to "Matthew M
     Bartlett; Gwendolyn Kiste; Jonathan Raab" — and scoring only `[0]` would
     lose them. Joined with a space because BT.util.normalizeTitle reduces
     every separator to one anyway, so this is already the shape it wants. */
  function authorsOf(doc) {
    const names = (doc && doc.author_name) || [];
    const list = Array.isArray(names) ? names : [names];
    return list.filter(Boolean).map(String).join(' ');
  }

  /* Weights for the non-title haystacks. See note 1 in the header for why
     these are deliberately shallow: they settle a tie between two equally good
     raw matches in favour of the title, and they must NOT be deep enough to
     push an author match out of the band an equally-strong title match is in.
     One band is 0.05 wide; these cost 0.05 and 0.10 of a raw 1.0 score. */
  const W_TITLE_AND_AUTHOR = 0.95;
  const W_AUTHOR = 0.90;

  /* How good an author match has to be, and how far it has to beat the title,
     before a doc counts as "matched on the author". 0.86 is relevance()'s
     "the title contains the query somewhere" tier, so this admits "Céline
     Chevet Clémence Godefroy Gwendolyn Kiste" as well as an exact name. */
  const AUTHOR_HIT = 0.86;
  const AUTHOR_GAP = 0.2;
  /* And how much of the result set has to look like that before the whole
     QUERY is treated as an author query. A clear majority rather than all of
     them: one companion volume or one biography with the author's name in its
     title must not flip a plain author search back to title ordering. */
  const AUTHOR_RUN = 0.6;

  /* True when the reader typed a name, not a title. Read off the docs rather
     than guessed from the query string, because there is no way to tell
     "gwendolyn kiste" from a title by looking at it — but there is every way
     to tell by looking at what came back. */
  function authorDominant(ranked) {
    if (!ranked.length) return false;
    let hits = 0;
    for (const r of ranked) {
      if ((r._authorScore || 0) >= AUTHOR_HIT
          && (r._authorScore || 0) > (r._titleScore || 0) + AUTHOR_GAP) hits++;
    }
    return hits >= Math.ceil(ranked.length * AUTHOR_RUN);
  }

  function rerank(q, docs) {
    const qn = BT.util.normalizeTitle(q);

    const shaped = [];
    for (const d of (docs || [])) {
      const title = String((d && d.title) || '').trim();
      if (!title) continue;                       // a doc with no title is unshowable
      const authors = authorsOf(d);
      shaped.push({
        doc: d,
        title,
        originalTitle: altTitleOf(d),
        pop: popOf(d),
        notability: notabilityOf(d),
        /* The two extra haystacks rankByRelevance scores alongside the title.
           An authorless doc contributes none, which costs it nothing. */
        haystacks: authors ? [
          { text: title + ' ' + authors, weight: W_TITLE_AND_AUTHOR },
          { text: authors, weight: W_AUTHOR },
        ] : [],
        /* Scored again here, unweighted and on their own, ONLY to answer "did
           this doc match because of its author?" — which is a different
           question from "how well did it match", and the one authorDominant()
           needs. Two extra relevance() calls over at most thirty docs. */
        _titleScore: BT.util.relevance(q, title).score,
        _authorScore: authors ? BT.util.relevance(q, authors).score : 0,
        _norm: BT.util.normalizeTitle(title),
        _main: BT.util.normalizeTitle(mainTitle(title)),
      });
    }

    /* Step 1 — M1's banded ranker. This is where the coverage filter lives
       (for a multi-word query, insist every word appears, then relax rather
       than show an empty screen) and where popularity is confined to a
       tiebreak. It is handed the author haystacks above rather than being
       bypassed, so the gate sees the author field too — the `gwendolyn kiste`
       zero-results bug WAS that gate, firing on a coverage number computed
       from titles alone. Everything below adjusts its result; nothing below
       replaces it. */
    const ranked = BT.util.rankByRelevance(q, shaped);
    const byAuthor = authorDominant(ranked);

    /* Step 2 — the book-specific corrections. */
    for (const r of ranked) {
      let s = r._score;
      /* An exact title match is the strongest statement a search result can
         make and nothing else may outrank it. 0.6 is twelve bands wide — far
         more than the whole spread between a title that STARTS with the query
         (0.94) and one that merely contains it (0.86) — which is the point: no
         pile of edition counts can climb over it, because popularity never
         crosses a band at all. */
      if (qn && r._norm === qn) s += 0.6;
      else if (qn && r._main === qn) s += 0.45;   // exact once the subtitle is off
      /* Every word the reader typed, present in the title. Smaller, because
         relevance() already rewards contiguity and order; this only separates
         two docs that matched the same words differently. */
      s += 0.15 * (r._coverage || 0);
      /* Demoted, not dropped — see note 5 above. Large enough to fall below
         any genuine match, small enough that a screen with nothing but
         summaries on it still shows them. */
      if (JUNK_RX.test(r.title)) s -= 0.75;
      r._score = BT.util.clamp(s, 0, 2);
      r._dupes = 0;
    }

    /* Step 3 — re-sort on the adjusted score, banded exactly as M1 bands it.
       0.05-wide bands: one decimal collapses "starts with the query" and
       "contains it somewhere" into the same band, and then edition count
       decides — which is the original bug wearing a different hat. Array sort
       is stable, so rankByRelevance's ordering survives inside a band.

       WHICH TIEBREAK, and it is only ever a tiebreak — the band is compared
       first on both paths, so neither number can lift a doc over a better
       match. On a title query it is popOf (editions lead: "which record is the
       real Dune?"). On an author query every doc scored on the same author and
       every doc is therefore in the same band, so the question has become
       "which of this author's books is the known one?" and notabilityOf
       (readers lead) is the one that answers it. See note 4 in the header. */
    ranked.sort((a, b) => {
      const band = Math.round(b._score * 20) - Math.round(a._score * 20);
      if (band) return band;
      return byAuthor
        ? (b.notability || 0) - (a.notability || 0)
        : (b.pop || 0) - (a.pop || 0);
    });

    /* Step 4 — collapse near-duplicate works.

       Keyed on normalized main title + primary author, and the AUTHOR HALF IS
       LOAD-BEARING: Open Library's attributions are unreliable enough that the
       real "Dune" comes back credited to Brian Herbert, so two docs that
       disagree about who wrote a book are two records we are not entitled to
       merge. Only an exact agreement collapses. The survivor is whichever
       ranked highest — it is already the best-matching of the set. */
    const seen = new Map();
    const out = [];
    for (const r of ranked) {
      const key = r._main + '|' + BT.util.normalizeTitle(primaryAuthorOf(r.doc));
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
       is a drawer over this list — coming back to an empty box and having to
       retype would make browsing results feel like starting over. */
    query = (q && q.q) || query || '';

    BT.ui.crumb(['Discover', 'Search']);
    /* The other door into the library, named where someone deciding how to add
       a book will look. Searching adds a WORK; scanning adds one printing. */
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
                 value="${esc(query)}" aria-label="Search Open Library">
        </div>
        <!-- ONE <span> PER .shint, and it is not decoration. .shint is a flex
             container, so every text node and every <kbd>/<b> inside it becomes
             a separate flex item: line breaks can then only happen at those
             boundaries, never between words, and the 6px gap opens mid-clause.
             Written bare, the sentence below broke after <b>work</b> and put
             the comma at the start of the next line. Wrapping the whole hint in
             one span makes it a single flex item whose contents wrap as
             ordinary prose. 75-view-scan.js reached the same conclusion and
             documents it at its own .shint; search and people never got the
             treatment. -->
        <div class="shint">
          <span><kbd>⏎</kbd> add the highlighted result · <kbd>↑</kbd><kbd>↓</kbd> move ·
          <b>${count}</b> already on your shelves</span>
        </div>
        <div class="shint">
          <span>Adding from search records the <b>work</b>, not a printing — the edition
          stays open until you scan a copy or pick one.</span>
        </div>
      </div>

      <div class="toolbar">
        <span class="count" id="resCount"></span>
        <div class="spacer"></div>
        <span class="count">Open Library</span>
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

    const input = document.getElementById('q');
    /* 350ms floor, and it is a rate-limit decision rather than a feel one.
       Open Library's sustained anonymous budget is ONE request per second and
       they ask not to be used as a backend for automated traffic; a 240ms
       debounce fires four times a second while someone types a title, which is
       four times the whole app's allowance spent on answers nobody will read.
       Longer again on touch, because thumb typing has bigger inter-key gaps
       and a desktop debounce fires mid-word. */
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

  /* Every write to #results that does NOT come from paint() goes through here.

     paint() skips a repaint whose signature matches what is already on screen,
     which is what stops the covers re-decoding and flashing on every keystroke.
     That check is only sound if the signature always describes the CURRENT
     contents — and an empty state, a skeleton or an error box written straight
     over the list leaves the old signature in place. The bug that produces is
     exact and reproducible: search "dune", clear the box (idle state paints),
     type "dune" again (cache hit, identical html), and paint() decides nothing
     has changed and leaves the idle state up. The results never come back and
     the search box looks broken. */
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
      title: 'Search Open Library',
      body: 'No key, no signup, nothing to configure — the whole catalogue is open. '
        + 'Type at least two characters. Results are re-ordered here before you see '
        + 'them, because the catalogue’s own ranking puts companion volumes and '
        + 'study guides above the book you asked for.',
    }));
  }

  function setCount(text) {
    const el = document.getElementById('resCount');
    if (el) el.textContent = text || '';
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
     20-openlibrary.js and 38-normalize.js are the two M2 files this screen
     stands on. Feature-detected rather than assumed, the same way 50-ui-core
     guards BT.sync and 56-inspector guards BT.openlibrary.lookupUid: a bare
     call would be a TypeError inside a debounce callback, where it produces a
     search box that does nothing at all and logs once, three keystrokes ago. */
  function missingDeps() {
    const out = [];
    if (!BT.openlibrary || typeof BT.openlibrary.search !== 'function') out.push('20-openlibrary.js');
    if (!BT.normalize || typeof BT.normalize.stubFromSearchDoc !== 'function') out.push('38-normalize.js');
    return out;
  }

  async function go(q) {
    query = q;
    const host = document.getElementById('results');
    if (!host) return;

    if (q.length < 2) {
      rows = []; cursor = -1; numFound = 0; collapsed = 0; stale = null;
      if (inflight) { inflight.abort(); inflight = null; }
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
    const key = q.toLowerCase();
    if (cache.has(key)) {
      const hit = cache.get(key);
      rows = hit.rows; numFound = hit.numFound; collapsed = hit.collapsed; stale = null;
      cursor = -1;
      host.classList.remove('is-stale');
      paint();
      return;
    }

    /* Only show skeletons when there is nothing to keep. Replacing a full
       result list with skeletons on every keystroke collapses the list height
       and springs it back, which is what made typing feel jerky on a phone.
       With results already on screen, mark them stale instead and swap in
       place when the new ones land — the list never changes height mid-type. */
    if (!rows.length) replace(host, BT.ui.skeletonGrid(4));
    else host.classList.add('is-stale');

    /* One request at a time, and the old one is cancelled rather than left to
       finish. Two reasons, and the second is the important one: a token spent
       on a superseded query is a token the NEXT query has to wait for, at one
       sustained request per second. */
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    /* 05-net fills this in when it serves a soft-expired cache row because the
       upstream could not be reached. Best-effort: if the adapter does not pass
       opts through, it simply stays false and nothing is claimed. */
    const meta = {};

    let res;
    try {
      res = await BT.openlibrary.search(q, { signal, meta, limit: BT.LIMITS.searchResults });
    } catch (e) {
      /* Both spellings of "cancelled": BT.net classifies its own aborts as
         kind 'abort', but a raw DOMException can also reach here if the adapter
         ever aborts outside that path, and reporting either as a failure would
         flash an error box on every third keystroke. */
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
      if (signal.aborted) return;
      rows = []; cursor = -1;
      setCount('');
      replace(host, failureBox(e));
      return;
    }
    if (signal.aborted) return;

    const docs = (res && res.docs) || [];
    numFound = (res && res.numFound) || docs.length;
    stale = meta.stale ? (meta.reason || 'Open Library could not be reached') : null;

    /* THE POINT OF THIS SCREEN. Everything upstream of here is transport. */
    const ranked = rerank(q, docs).slice(0, BT.LIMITS.searchResults);
    collapsed = ranked.reduce((n, r) => n + (r._dupes || 0), 0);

    /* STUB, THEN HYDRATE — and the stub half is a measured decision, not
       laziness. A search request that also asks for `isbn` and `edition_key`
       costs 19,853 bytes for five docs against 889 without them: a 22x blowup,
       because one popular work carries 722 ISBNs. So the request stays lean,
       every row here is a partial record (meta.partial = 1), and the detail —
       description, subjects, page count, editions — is fetched exactly once,
       for the one book that gets added, by BT.ui.addItem. Nothing on this
       screen fans out per row; see the rate-limit note in 00-config.js. */
    const next = [];
    for (const r of ranked) {
      const stub = BT.normalize.stubFromSearchDoc(r.doc);
      if (!stub || !stub.uid) continue;             // no work key, nothing to add
      next.push({ stub, doc: r.doc, score: r._score, owned: await ownedStatus(stub) });
    }
    if (signal.aborted) return;

    rows = next;
    /* A degraded answer must not be cached as if it were the real one: the next
       search for the same words would serve the gap back with no explanation.
       Same rule MovieTrak applied to a provider that was down. */
    if (!stale) cache.set(key, { rows, numFound, collapsed });
    cursor = -1;
    host.classList.remove('is-stale');
    paint();
    /* NOTHING here may touch the input's value or selection. An earlier
       version moved the caret to the end of the query it had STARTED with,
       which lands mid-word if you kept typing during the fetch — so the next
       keystrokes insert at the wrong offset and the title comes out scrambled
       ("the left hand" -> "the lefthand "). The caret is already where the
       user put it; leave it alone. */
  }

  /* ── Dedup against the library ─────────────────────────────────────────
     THE `olwork:` NAMESPACE, AND ONLY THAT ONE.

     Search adds a WORK — the reader means "Dune", not the 1990 Ace paperback —
     so search-add dedupes at work level: if any item on the shelves claims this
     work, searching must never produce a second one.

     Scan-add deliberately uses a DIFFERENT namespace (`isbn13:` for a pinned
     edition, `isbncand:` for the candidate ISBNs an open item is known by), and
     the two must not be crossed here. An open item lists every ISBN Open
     Library knows for the work — forty is normal — and matching this screen
     against those would be harmless, but matching the SCANNER against work-level
     keys would tell it you already own every printing of everything you ever
     searched for. See the namespace comment in 12-repo.js; that split is the
     whole scan story.

     resolveUid rather than a scan of allItems() and a uid comparison, because
     the uid is not the question. An item added by barcode has the uid
     `book:isbn:9780441172719` and still CLAIMS `olwork:OL27482W` in the id
     index — comparing uids would miss it and offer to add a duplicate. */
  async function ownedStatus(stub) {
    const olid = (stub.ids && stub.ids.olWork) || '';
    if (!olid) return null;
    const uid = await BT.repo.resolveUid([`olwork:${olid}`]);
    if (!uid) return null;
    const item = await BT.repo.getItem(uid);
    return (item && item.user && item.user.status) || 'want';
  }

  /* A source that is DOWN and a source that found nothing are different facts,
     and collapsing them is how "Nothing matching Piranesi" gets shown during an
     outage — which is simply untrue and sends the reader off to check their
     spelling. Every branch here says which one happened. */
  function failureBox(e) {
    const kind = (e && e.kind) || 'server';
    if (kind === 'offline') {
      return BT.ui.errorBox('You appear to be offline',
        'Search needs a connection. Everything already on your shelves still works — '
        + 'reading progress, ratings and notes are stored in this browser.');
    }
    if (kind === 'notfound') {
      return BT.ui.errorBox('Open Library answered with a page, not a record',
        'That usually means a captive portal — hotel or café wifi with a login screen — '
        + 'is answering for it. Nothing is wrong with the app.');
    }
    if (kind === 'budget' || kind === 'quota-soft') {
      return BT.ui.errorBox('Too many requests, too quickly',
        'Open Library allows about one request a second. Give it a moment and type again — '
        + 'nothing is broken and nothing was lost.');
    }
    return BT.ui.errorBox('Open Library is not answering',
      `${(e && e.message) || String(e)} Nothing can be searched until it is back. `
      + 'This is not a statement about whether the book exists.');
  }

  /* ── Painting ─────────────────────────────────────────────────────────── */

  function paint() {
    const host = document.getElementById('results');
    if (!host) return;

    if (!rows.length) {
      setCount('');
      /* An ISBN typed into a title box is a dead end worth naming: search
         matches words, and thirteen digits are not words. */
      const scan = BT.util.normalizeScanCode(query);
      replace(host, BT.ui.emptyState({
        title: `Nothing matching “${esc(query)}”`,
        body: scan.ok
          ? 'That is a valid ISBN, and this box searches titles rather than barcodes. '
            + 'Scan or type it on the scan screen and BookTrak will add that exact printing.'
          : 'Try fewer words, the author’s name, or the title as it appears on the '
            + 'spine — Open Library indexes catalogue titles, so subtitles and series '
            + 'numbering often differ from the cover.',
        actions: scan.ok ? '<a class="btn" href="#/scan">Go to the scanner</a>' : '',
      }));
      return;
    }

    const bits = [`${rows.length} shown`];
    if (numFound > rows.length) bits.push(`${BT.util.formatVotes(numFound)} in the catalogue`);
    if (collapsed) bits.push(BT.util.pluralize(collapsed, 'duplicate record') + ' collapsed');
    setCount(bits.join(' · '));

    /* Results served from cache during an outage are still results, but the
       reader is entitled to know they are not live — a book published this
       week genuinely will not be in them. */
    const note = stale
      ? `<div class="warnbox"><strong>Showing saved results</strong>${
          esc(stale)}. These came from this browser’s cache, so anything catalogued recently is missing.</div>`
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
         deliberate tap. */
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
     which is the normal way this screen is used — meant re-finding your place
     four times, and twice meant adding the wrong book. The regrouping is still
     correct on the next search; it simply must not happen mid-gesture. */
  async function addRow(hit, btn) {
    const added = await addStub(hit.stub);
    if (!added) return;
    hit.owned = (added.user && added.user.status) || 'want';
    if (!btn) { paint(); return; }                // no element to swap: rebuild
    btn.outerHTML = `<span class="add is-in">✓ ${esc(BT.ui.STATUS_WORD[hit.owned] || 'On the shelf')}</span>`;
    /* The signature no longer describes what is on screen, so the next REAL
       paint must not skip itself. */
    const host = document.getElementById('results');
    if (host) host.dataset.sig = '';
  }

  /* `scope: 'open'` is stated, never inferred. A search result is a WORK: the
     reader means the book, not the 1990 Ace paperback, and choosing an edition
     on their behalf would stamp a cover, a publisher and a page count onto the
     record that they never picked and would then have to notice and correct.
     The scanner passes 'closed' from the other door. */
  async function addStub(stub) {
    try {
      return await BT.ui.addItem(stub, { scope: 'open', source: 'search' });
    } catch (e) {
      /* addItem writes the item BEFORE it records an alert baseline, and the
         alerts module lands in a later milestone. If it threw after the write,
         the book IS on the shelves, and reporting a failure would send the
         reader off to add it a second time. Ask the id index what actually
         happened rather than trusting the exception. */
      console.warn('[search] addItem threw', e);
      const olid = (stub.ids && stub.ids.olWork) || '';
      const uid = olid ? await BT.repo.resolveUid([`olwork:${olid}`]) : null;
      const item = uid ? await BT.repo.getItem(uid) : null;
      if (item) return item;
      BT.ui.toast(`Could not add “${BT.util.truncate(stub.title, 40)}”`, { bad: true });
      return null;
    }
  }

  /* ── One row ───────────────────────────────────────────────────────────── */

  function row(r) {
    const s = r.stub;
    const d = r.doc || {};
    /* The cover box is sized here rather than in the shared stylesheet: 30px is
       specific to this row, and BT.ui.poster draws a block with no dimensions
       of its own so that every caller states the size it needs. The wrapper is
       a grid so the poster stretches to fill it in both axes. */
    return `<div class="miss" data-uid="${esc(s.uid)}">
      <span style="display:grid;width:30px;flex:0 0 30px;aspect-ratio:2/3">${BT.ui.poster(s, { size: 'sm' })}</span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${byline(d)}${firstRecorded(d)}${editionsNote(d)}
        </div>
      </div>
      ${r.owned
        ? `<span class="add is-in">✓ ${esc(BT.ui.STATUS_WORD[r.owned] || 'On the shelf')}</span>`
        : `<button class="add" type="button" data-add="${esc(s.uid)}" aria-label="Add ${esc(s.title)}">Add</button>`}
    </div>`;
  }

  /* ══ FOLLOWING, FROM A RESULT ROW ═══════════════════════════════════════
     ── SEAM ──────────────────────────────────────────────────────────────
     70-follows.js is optional to this screen. Feature-detected the same way
     the catalogue client is: without it the byline renders as plain text and
     nothing else changes, because a search that stops working because a
     following module failed to parse would be a bad trade. */
  function canFollow() {
    /* All three, because a byline draws with authorId(), fills its state from
       all() and acts through toggleAuthor(). Checking one and calling another
       is how a half-loaded module turns a search into a blank screen instead
       of a search with no Follow buttons. */
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
         chips simply render unpressed, and pressing one still works — the
         toggle asks the repo itself rather than trusting this set. */
      console.warn('[search] could not read follows', e);
      followSet = new Set();
    }
  }

  /* AUTHOR NAMES AND AUTHOR KEYS ARE PARALLEL ARRAYS, and keeping them aligned
     is the whole correctness story of this function.

     `author_name[i]` belongs to `author_key[i]`. The previous version of this
     byline opened with `.filter(Boolean)` on the names alone, which is
     harmless while it only prints text and is a silent mis-attribution the
     moment a name carries an id: one empty entry shifts every following name
     up by one, so pressing Follow on the second author of an anthology would
     start watching the third author's catalogue. Nothing about the row would
     look wrong. Pairs are built by INDEX first and filtered afterwards.

     An author with no key is shown as plain text with the reason on hover,
     never as a Follow that quietly falls back to the name — see FAILURE 2 in
     rerank(): `author=gwendolyn+kiste` returns Laird Barron's bibliography at
     HTTP 200, so a name-keyed follow is not a degraded follow, it is a
     confident feed of the wrong writer. */
  function byline(d) {
    const rawNames = Array.isArray(d.author_name) ? d.author_name : [];
    const rawKeys = Array.isArray(d.author_key) ? d.author_key : [];
    const people = [];
    for (let i = 0; i < rawNames.length; i++) {
      const name = String(rawNames[i] || '').trim();
      if (!name) continue;
      people.push({ name, olid: BT.util.olid(rawKeys[i] || '') });
    }
    if (!people.length) return '<span class="faint">Author not recorded</span>';

    /* Two, as before. A row is one line and an omnibus can credit nine people;
       the rest are counted rather than listed, and are reachable from the
       item's own detail pane. */
    const shown = people.slice(0, 2);
    const more = people.length > shown.length
      ? `<span class="faint">+${people.length - shown.length}</span>` : '';

    if (!canFollow()) {
      return `<span>${esc(shown.map(p => p.name).join(', '))}</span>${more}`;
    }
    return shown.map(authorChip).join('') + more;
  }

  function authorChip(p) {
    if (!p.olid) {
      return `<span title="Open Library has no author id on this record. Following by name is not offered because a name-scoped author query returns a different author’s books.">${
        esc(p.name)}</span>`;
    }
    const id = BT.follows.authorId(p.olid);
    const on = followSet.has(id);
    /* .chip already styles [aria-pressed="true"] as the teal "on" state, so the
       state is carried by the attribute a screen reader reads rather than by a
       class the stylesheet and this file would both have to agree about. */
    return `<button class="chip" type="button" data-fa="${esc(p.olid)}" data-fid="${esc(id)}"
      data-fn="${esc(p.name)}" aria-pressed="${on ? 'true' : 'false'}"
      title="${on ? 'Unfollow' : 'Follow'} ${esc(p.name)} — new works in their Open Library catalogue"
      >${esc(p.name)}<b>${on ? '✓' : '+'}</b></button>`;
  }

  async function toggleFollow(btn) {
    const olid = btn.dataset.fa;
    const name = btn.dataset.fn || '';
    btn.disabled = true;
    let res = null;
    try {
      res = await BT.follows.toggleAuthor(olid, name);
    } catch (e) {
      console.warn('[search] follow failed', e);
    } finally {
      btn.disabled = false;
    }
    if (!res) {
      BT.ui.toast('That record carries no usable author id, so it cannot be followed reliably.', { bad: true });
      return;
    }
    if (res.following) followSet.add(res.id); else followSet.delete(res.id);
    markFollowButtons(res.id, res.following, res.name);
    BT.ui.toast(res.following ? `Following ${res.name}` : `Unfollowed ${res.name}`);
  }

  /* EVERY chip for this author, not only the one that was pressed. A search
     for an author's name returns thirty of their books, so one press means
     thirty chips are now wrong — a list that shows the same person as followed
     on one row and not on the next reads as a bug in the app.

     Scanned and compared rather than matched with an attribute selector: a
     follow id is `author:openlibrary:OL1394865A`, and a colon is a combinator
     in CSS. A selector built from one needs CSS.escape and fails SILENTLY
     without it — no error, just buttons left saying the opposite of the truth. */
  function markFollowButtons(id, on, name) {
    for (const b of document.querySelectorAll('#results [data-fid]')) {
      if (b.dataset.fid !== id) continue;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = `${on ? 'Unfollow' : 'Follow'} ${name} — new works in their Open Library catalogue`;
      b.innerHTML = `${esc(b.dataset.fn || name)}<b>${on ? '✓' : '+'}</b>`;
    }
    /* The DOM no longer matches the signature paint() recorded, so the next
       real paint must not skip itself. Same rule as the Add-button swap. */
    const host = document.getElementById('results');
    if (host) host.dataset.sig = '';
  }

  /* "first recorded", never "published", and the wording is the whole point.
     first_publish_year is the earliest year anywhere in the work's catalogue
     records, and it is frequently wrong: *The Alloy of Law*, published 2011,
     reports 2001 (verified). Presenting it as a publication date would put a
     confident falsehood in front of the reader on the row they are about to
     add. Once an edition is attached, that edition's own publish_date is the
     better number and the item page prefers it. */
  function firstRecorded(d) {
    const y = Number(d.first_publish_year) || 0;
    if (!y) return '<span class="faint">no year recorded</span>';
    return `<span class="mono" title="Earliest year in Open Library’s records for this work. It is often earlier than the real first publication, and sometimes simply wrong.">first recorded ${y}</span>`;
  }

  /* Edition count is shown because it explains what an `open` item means: this
     row stands for a work that exists in N printings, and the reader has not
     said which one is on their shelf. */
  function editionsNote(d) {
    const n = Number(d.edition_count) || 0;
    if (!n) return '';
    return `<span class="faint">${esc(BT.util.pluralize(n, 'edition'))}</span>`;
  }

  /* rerank is exported alongside render on purpose: it encodes measured
     behaviour of a live third-party API, so the day results look wrong again it
     has to be callable from the console against real docs, without a build step
     and without editing this file. */
  return { render, rerank };
})();
