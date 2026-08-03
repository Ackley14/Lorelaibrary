/* ══════════════════════════════════════════════════════════════════════════
   #/people — Following: authors.

   ── WHAT THIS SCREEN IS NOW, AND WHY IT CHANGED ───────────────────────────
   It used to be a search box, a roster, and ONE shared strip of everything all
   your follows had coming. It worked, and the user's report was that it
   "behaves ... strangely". Every complaint traced to the same two facts:

     1. The strip fetched its own copy of each catalogue, and the alerts sweep
        fetched another. Two schedules, two baselines, and NEITHER wrote the
        answer anywhere durable — so the roster underneath a screen that was
        displaying an author's catalogue said "not checked yet · never checked".
        The reader was reading their own roster, and it was telling them the
        truth: nothing was cached.
     2. Everything was pooled. One strip, one progress line, one blank state.
        With six follows and two upcoming books there was no way to tell
        "Stephen King has nothing scheduled" from "Stephen King was not
        checked" from "Stephen King's row is below the fold".

   Both are answered by the same change: 70-follows.js now stores ONE cached
   catalogue on the follow row, and this page draws ONE SECTION PER AUTHOR from
   it. The cache paints first, always, with zero requests. The refresher updates
   it behind the paint, and each section repaints as its own answer lands.

   ── EVERY SECTION GIVES A HARD ANSWER ─────────────────────────────────────
   There is no ambiguous blank on this page. Each section opens with a verdict
   line that is one of exactly four sentences:

     · "2 works dated after today"                  — yes, and here they are
     · "Nothing dated after today; 3 dated this year with no month recorded"
                                                     — undecidable, and it says so
     · "Nothing scheduled"                           — no, we looked
     · "Not checked yet" / "Could not check"         — we did not look

   The fourth is the one that matters most, because the other three are claims
   about the catalogue and it is a claim about us. "We could not look" and
   "there is nothing new" are different facts, and a screen that renders both as
   an empty panel is a screen that lies during an outage.

   ── THE BANDS, AND WHY 'RECENT' IS SEPARATE ───────────────────────────────
   OPEN LIBRARY HAS NO CONCEPT OF A FORTHCOMING BOOK. There are no street
   dates, no announcements, no "coming soon" — it catalogues books that EXIST,
   its dates are YEARS rather than dates, and those years are often wrong (The
   Alloy of Law, published 2011, is recorded as 2001; verified). Measured, a
   60-work page for each of six large-catalogue authors contained ZERO works
   dated beyond the current year and between zero and six dated within it.

   So a section is banded tightest-first and every band is labelled for exactly
   what it is:

     Dated after today     genuinely ahead of us. The window the record
                           describes STARTS after today, so there is no reading
                           of it under which the book is already out.
     This year, no month   the window straddles today. A bare '2026' read in
                           August could be last March or next November and the
                           record does not say. Shown with the month and day
                           HATCHED — the app's grammar for "this value cannot
                           exist in the record" — and never counted as upcoming.
     Recently published    already out, within the last couple of years. This is
                           the band the user asked for ("then recent"), and it
                           carries the word "published" in its heading precisely
                           so it can never be misread as the first band. Its year
                           range is printed rather than implied.

   WIDENING THE FIRST BAND TO MAKE THE PAGE LOOK BUSIER IS THE ONE CHANGE THAT
   MUST NOT HAPPEN. Letting last year's reprints into "dated after today" is not
   a more generous version of this feature, it is the same screen with a false
   heading on it. That is why 'recent' is a band of its own with its own words
   instead of a loosened filter.

   ── A CARD TAP OPENS THE PANE AND ADDS NOTHING ────────────────────────────
   Reported bug, not a preference. This used to call BT.ui.addItem, so looking
   at what an author had out quietly filled the library with `want` entries the
   reader never asked for — on a screen whose entire purpose is BROWSING books
   you do not own. 56-inspector's `_transient` mode shows the record with one
   explicit "Add to library" button, which is what 61-view-search settled on
   when the identical complaint came in about its result rows.

   ── PUBLISHERS ARE GONE ───────────────────────────────────────────────────
   "lets drop publisher support as i think it's a bit too shoehorned in". The
   picker, the roster group, the polling and the approximate-match apparatus
   have all been removed. Publisher survives as a FACET — the edition picker
   filters across it and the detail pane shows it on the Edition block, which is
   where it was always carrying its weight; 70-follows.js lists every surface.
   56-inspector's publisher pill is gone from that file outright rather than
   left to feature-detect a `togglePublisher` that no longer exists — a pill
   suppressed by an absence comes back the moment the absence does.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewPeople = (function () {
  const esc = BT.util.escapeHtml;

  /* How far back "recently published" reaches. The CURRENT year is never in
     this band — a bare current year is undecidable and has a band of its own —
     so this is the two complete years before it. Small on purpose: the point of
     the band is "what has this author had out lately", and a five-year window
     is a bibliography rather than news. The range is PRINTED in the heading, so
     the reader never has to infer where the edge is. */
  const RECENT_YEARS = 2;

  /* A bound on Google Books REQUESTS, not on rows. Every row stays on screen
     either way; this only decides how many undecidable years get resolved into
     real dates. Unlike a display cap, reaching it hides nothing — the
     twenty-fifth row still says "year only" out loud rather than pretending to
     be precise. */
  const SHARPEN_MAX = 24;

  /* Minimum characters before the author lookup fires. Two, matched to
     20-openlibrary.js's typeahead rule, which will not wildcard a single
     character (`b*` matches 170,000 authors — measured). */
  const MIN_Q = 2;

  let followSet = new Set();     // ids currently followed — drives every button
  let rosterRows = [];           // the follow rows this render drew
  let ownedWorks = new Set();    // olWork ids on the shelves
  let inflight = null;           // AbortController for the author lookup
  let term = '';
  let touchStart = null;
  let moved = false;             // true when the current gesture is a scroll
  let subscribed = false;        // the repo subscription is registered once, ever
  let pageAlive = () => false;   // is #/people still the live route?
  let tick = null;               // the "searching for Ns" ticker
  let seenTimer = null;

  /* Author lookups already answered, keyed on the folded query. Module-scoped
     rather than per-render, and it is not a micro-optimisation: Open Library's
     author endpoint answers in 2.5 to 9 SECONDS (measured across a dozen
     queries), so the difference between reusing an answer and asking again is
     the difference between a box that responds and one that appears broken.
     BT.net caches the payload too, but only for BT.TTL.search and only after a
     round trip through IndexedDB; this is in front of that. */
  const authorCache = new Map();
  let searchSeq = 0;

  /* Google Books' answer for a work whose year we could not place, and the set
     of works we have already asked about. Two structures rather than one
     because they answer different questions: `sharpMap` holds an improvement,
     `sharpAsked` records that a request was spent — and a card distinguishes
     "year only" from "year only, and Google has no finer date either", which a
     reader who paid for a key deserves to be able to tell apart. */
  const sharpMap = new Map();
  const sharpAsked = new Set();

  /* The unseen-news count as it stood when the page was drawn.

     Captured rather than recomputed, for the same reason 66-view-alerts.js does
     not repaint after marking rows read: the badge is what tells the reader
     WHICH sections have something new in them, and a badge that vanished the
     instant the seen-marker was written would take that information away while
     they were still reading it. It clears on the next visit, like an unread
     count should. */
  let newsAtRender = new Map();

  /* Works that became yours WHILE this page was showing them.

     Deliberately not filtered back out. Adding a book from the detail pane ends
     in BT.router.resolve(), which re-renders this screen — and the re-render
     reads the shelves again, so without this set the card the reader just acted
     on would VANISH from under the pane they acted on it in. A row that
     disappears the instant you use it reads as a mistake rather than as success.
     They stay where they are, marked "In your library", which is also the honest
     label. */
  const addedHere = new Set();

  /* ── SEAM ──────────────────────────────────────────────────────────────
     Feature-detected rather than assumed, the same way 61-view-search guards
     its two. A bare call to a module that failed to parse is a TypeError inside
     a debounce callback, where it shows up as a search box that does nothing at
     all and one console line from three keystrokes ago. */
  function missingDeps() {
    const out = [];
    const f = BT.follows;
    if (!f || typeof f.toggleAuthor !== 'function') out.push('70-follows.js');
    if (!BT.openlibrary || typeof BT.openlibrary.searchAuthors !== 'function') out.push('20-openlibrary.js');
    /* Checked separately from the module that holds them, because an OLDER
       70-follows.js parses fine and answers toggleAuthor perfectly while having
       neither a cache nor a refresher — at which point every section on this
       page would render permanently empty with nothing to say why. A missing
       capability must fail loudly; a page that silently stops answering is the
       failure this whole change was made to remove. */
    if (f && typeof f.cachedWorks !== 'function') out.push('70-follows.js (cachedWorks)');
    if (f && typeof f.refreshAll !== 'function') out.push('70-follows.js (refreshAll)');
    if (f && typeof f.futureness !== 'function') out.push('70-follows.js (futureness)');
    return out;
  }

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;
    pageAlive = alive || (() => true);

    BT.ui.crumb(['Discover', 'Following']);

    if (inflight) { inflight.abort(); inflight = null; }
    clearInterval(tick); tick = null;
    clearTimeout(seenTimer); seenTimer = null;
    subscribeOnce();

    const gap = missingDeps();
    if (gap.length) {
      BT.ui.paneActions('');
      view.innerHTML = BT.ui.errorBox('Following is not wired up on this page',
        `Missing ${gap.join(', ')}. Everything already on your shelves still works.`);
      return;
    }

    /* ONE read of the library, used to mark the sections' rows as owned.
       Reading it inside a section renderer instead was the obvious shape, and
       is a full store scan per author. */
    const items = await BT.repo.allItems();
    if (!pageAlive()) return;
    ownedWorks = new Set(items.map(it => (it.ids && it.ids.olWork) || '').filter(Boolean));

    const follows = await BT.follows.all();
    if (!pageAlive()) return;
    rosterRows = sortRoster(follows);
    followSet = new Set(follows.map(f => f.id));

    newsAtRender = new Map();
    for (const f of follows) newsAtRender.set(f.id, BT.follows.unseenNews(f).length);

    BT.ui.paneActions(`
      <button class="btn btn--sm" type="button" id="frefreshall"${
        BT.follows.isRefreshing() ? ' disabled' : ''}>${
        BT.follows.isRefreshing() ? 'Checking…' : 'Refresh all'}</button>
      <a class="btn btn--sm btn--ghost" href="#/search">Search for a book</a>`);

    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="fq" type="search" placeholder="Find an author to follow…"
                 spellcheck="false" autocomplete="off" autocapitalize="none" autocorrect="off"
                 value="${esc(term)}" aria-label="Find an author to follow">
        </div>
        <!-- One <span>, for the reason 75-view-scan.js and 61-view-search.js both
             give: .shint is a flex container, so prose written straight into it
             breaks only at element boundaries, and a <b> could end up alone on a
             line with the full stop floating after it. -->
        <div class="shint">
          <span>Authors are matched on their Open Library id, never on their name — a
          name-scoped search for one author genuinely returns another author’s books.
          Partial names are matched as you type; Open Library’s author index can take
          several seconds to answer.</span>
        </div>
      </div>

      <div id="fres"></div>

      <div id="froster">${roster(rosterRows)}</div>

      <div id="fsections">${rosterRows.map(sectionHtml).join('')}</div>`;

    const input = document.getElementById('fq');
    /* 320ms. Shorter than the 350 this box used to run at, and the reason is
       that the debounce was never the slow part: the ENDPOINT is (2.5–9s
       measured), so a longer wait only delays the start of a request the reader
       is already waiting on. What makes the shorter wait affordable is that a
       superseded lookup is now dropped by sequence number rather than by
       blanking the panel — see find(). */
    const wait = matchMedia('(pointer: coarse)').matches ? 400 : 320;
    const run = BT.util.debounce(() => find(input.value.trim()), wait);
    input.addEventListener('input', () => {
      /* TWO handlers on one event, and the un-debounced one is the fix for
         "it feels unresponsive".

         A debounce is invisible from the outside: for the third of a second
         before it fires, the panel is still describing the PREVIOUS query, so
         the box reads "sanderso" over a heading that says "Matches for brandon
         sanderson" and a list of Brandon Sandersons. Everything on screen is
         then stale and nothing says so, which is exactly the state that teaches
         someone to clear the box and type it again.

         This runs on the keystroke itself and does one cheap thing: it repaints
         the state line, and swaps in the best cached answer for a prefix of
         what is now typed. No request, no debounce, no DOM beyond one line and
         a list we already hold. */
      typedAhead(input.value.trim());
      run();
    });
    /* Enter skips the debounce. Somebody who has finished typing a name should
       not wait a third of a second to start waiting for Open Library. */
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); find(input.value.trim()); }
    });
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
    if (term) find(term);

    /* Assignment, never addEventListener. #view OUTLIVES every route change —
       only its contents are replaced — so a listener bound here would stay alive
       on other screens and stack up one more copy per re-render. Every selector
       below is unique to this page, so a stale assignment is inert until the
       next view overwrites it. */
    view.onclick = onClick;
    view.ontouchstart = e => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
      moved = false;
    };
    view.ontouchmove = e => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - touchStart.y) > 8 || Math.abs(t.clientX - touchStart.x) > 8) moved = true;
    };

    const all = document.getElementById('frefreshall');
    if (all) all.onclick = () => refresh({ force: true, reason: 'manual' });

    if (!follows.length) return;

    /* THE CACHE IS ALREADY ON SCREEN. This asks for what is stale, and the
       per-follow cooldown in 70-follows means a roster refreshed within the last
       few hours costs ZERO requests — the sections above are simply already
       right. Not awaited: the page is drawn and the reader can use it. */
    refresh({ reason: 'page' });

    /* Marked seen after a beat, not on arrival. Marking instantly would clear
       the badges before the eye reaches them; marking on the way out means the
       sidebar still claims news while the reader is looking at all of it. The
       badges themselves stay on screen for this visit — `newsAtRender` is a
       snapshot — so the information does not vanish as it is being read. */
    seenTimer = setTimeout(async () => {
      if (!pageAlive() || !location.hash.startsWith('#/people')) return;
      let any = false;
      for (const f of follows) {
        if (await BT.follows.markNewsSeen(f.id)) any = true;
      }
      if (any && BT.tree && BT.tree.refresh) BT.tree.refresh();
    }, 2500);
  }

  /* `|| ''` because these rows survive an export and an import: a row that
     arrived from another device — or from a version of this file that wrote the
     name differently — must sort rather than throw, or one malformed follow
     takes the whole roster down. */
  function sortRoster(follows) {
    return follows.slice().sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || '')));
  }

  /* ══ FINDING SOMEONE TO FOLLOW ═════════════════════════════════════════
     ── THE REPORTED BUG, AND THE FOUR THINGS THAT CAUSED IT ───────────────
     "it feels unresponsive. i often have a hard time finding authors needing to
     retype their name several times for it to come up". All four are fixed
     here or in the endpoint adapter, and each was measured rather than guessed:

     1. A HALF-TYPED NAME MATCHED NOTHING AT ALL. `q=sanderso` answers HTTP 200
        with numFound 0; `q=sanderso*` answers with 1090. Open Library's author
        index matches whole tokens, so every intermediate state of typing a name
        was a confident denial. That is the retyping, exactly: the reader is
        told there is no such author, assumes a spelling mistake, clears the box
        and types it again. Fixed in 20-openlibrary.js — see typeaheadQuery.

     2. THE PANEL WAS BLANKED ON EVERY KEYSTROKE. The old find() wrote
        "Looking up authors…" over whatever was there before asking. With an
        endpoint that takes seconds, that is a box which is empty far more of
        the time than it is full. Now the previous answer STAYS, labelled with
        the query it belongs to, and only the state line changes.

     3. THE LOOKUP QUEUED BEHIND THE ROSTER. Both share one 1-request/second
        bucket in 05-net. The old page polled every follow on entry, so typing
        into the box while that walk was going meant waiting for it to finish
        first — on a roster of eight, tens of seconds, with nothing on screen
        saying so. BT.follows.hold() now outranks the refresher for the duration
        of a lookup.

     4. NOTHING SAID IT WAS STILL WORKING. A dead-looking box after four seconds
        is indistinguishable from a broken one, and the reader's only available
        move is to type again — which cancelled the request that was about to
        answer. The state line counts the seconds out loud. */

  const fold = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  /* The best answer we already hold for something related to what is typed now.

     This is what makes the box feel immediate rather than merely honest: having
     asked about "brandon", every one of "brandon s", "brandon sa", "brandon
     san" paints a plausible list in the same frame it is typed, and the network
     answer replaces it when it lands.

     TWO RELATIONSHIPS, AND THE SECOND ONE IS A BUG FIX RATHER THAN A BONUS.

       widening   a cached key that is a PREFIX of what is typed. Its results
                  are a superset of the answer being asked for, so showing them
                  under a longer query is safe. Longest wins — the closest
                  superset is the most useful one.
       narrowing  a cached key that what is typed is a prefix OF. This is
                  BACKSPACE, and without it deleting one character blanks the
                  panel: after asking about "brandon sanderson", the moment the
                  reader takes off the last letter there is no cached key that
                  is a prefix of "brandon sanderso", so the list vanishes and
                  the box goes empty for a third of a second and then several
                  seconds more. Correcting a typo is the single most likely
                  thing somebody does after a bad result, and it was the worst
                  moment on the screen to show them nothing.

     Widening is preferred when both exist, because a superset can only be too
     broad while a subset can be missing the row they are reaching for. Either
     way the state line names the query the rows actually belong to, so nothing
     on screen claims to be an answer to a question that was not asked. */
  function bestCached(q) {
    const key = fold(q);
    let wider = null;
    let narrower = null;
    for (const [k, rows] of authorCache) {
      if (key.startsWith(k)) {
        if (!wider || k.length > wider.key.length) wider = { key: k, rows };
      } else if (k.startsWith(key)) {
        /* Shortest, i.e. the least-narrowed subset — it holds the most rows. */
        if (!narrower || k.length < narrower.key.length) narrower = { key: k, rows };
      }
    }
    return wider || narrower;
  }

  /* Zero network, zero debounce. Called on the raw keystroke so the panel is
     never describing a query the reader has already moved past. */
  function typedAhead(q) {
    const host = document.getElementById('fres');
    if (!host) return;
    if (q.length < MIN_Q) { clearInterval(tick); tick = null; host.innerHTML = ''; return; }

    const key = fold(q);
    const exact = authorCache.get(key);
    if (exact) { paintResults(host, q, exact, { forQuery: q, searching: false }); return; }

    const near = bestCached(q);
    /* `searching` is true here even though nothing has been sent yet, and that
       is the honest word rather than a white lie: from the reader's point of
       view a lookup for what they have typed is under way, and it is — the
       debounce is part of it. Saying "waiting to search" instead would be
       precise about our implementation and useless about their question. */
    paintResults(host, q, near ? near.rows : null,
      { forQuery: near ? near.key : '', searching: true, startedAt: Date.now() });
  }

  async function find(q) {
    term = q;
    const host = document.getElementById('fres');
    if (!host) return;
    clearInterval(tick); tick = null;

    if (q.length < MIN_Q) {
      if (inflight) { inflight.abort(); inflight = null; }
      searchSeq++;
      host.innerHTML = '';
      return;
    }

    const key = fold(q);
    const exact = authorCache.get(key);
    if (exact) {
      /* Answered from memory, zero requests and zero latency. Retyping the same
         name — which is what the reader learned to do — is now instant. */
      if (inflight) { inflight.abort(); inflight = null; }
      searchSeq++;
      paintResults(host, q, exact, { forQuery: q, searching: false });
      return;
    }

    const near = bestCached(q);
    const startedAt = Date.now();
    paintResults(host, q, near ? near.rows : null,
      { forQuery: near ? near.key : '', searching: true, startedAt });
    /* The seconds are counted on screen because they are long enough to be
       worth counting. Only the state line is rewritten — repainting the rows on
       a timer would re-create every avatar once a second. */
    tick = setInterval(() => {
      const el = document.getElementById('fstate');
      if (!el) { clearInterval(tick); tick = null; return; }
      el.innerHTML = stateLine({ forQuery: near ? near.key : '', searching: true, startedAt }, q);
    }, 500);

    const seq = ++searchSeq;
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    let rows;
    /* Interactive work outranks the roster walk for as long as this takes.
       Released in `finally` without exception: a hold that leaks would slow
       every later refresh by HOLD_MAX_MS.

       Feature-detected rather than called bare. This pair is the newest thing
       70-follows.js exports, so it is the likeliest to be missing from a build
       where that file is a version behind — and a TypeError here lands inside a
       debounce callback, where it presents as a search box that does nothing at
       all and one console line from three keystrokes ago. Without the hold the
       lookup merely queues behind the roster; with a throw there is no lookup. */
    const holdable = typeof BT.follows.hold === 'function'
                  && typeof BT.follows.release === 'function';
    if (holdable) BT.follows.hold();
    try {
      rows = await BT.openlibrary.searchAuthors(q, { signal });
    } catch (e) {
      if (seq !== searchSeq) return;
      clearInterval(tick); tick = null;
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
      if (signal.aborted) return;
      /* The previous answer is kept underneath the error. It is still the best
         information available, and throwing it away would leave the reader with
         a red box and nothing to click during a blip. */
      paintResults(host, q, near ? near.rows : null,
        { forQuery: near ? near.key : '', searching: false, error: authorFailure(e) });
      return;
    } finally {
      if (holdable) BT.follows.release();
    }

    /* Superseded by a later keystroke. Dropped on the SEQUENCE rather than by
       aborting alone, because an abort races: a response already in flight can
       resolve after a newer request was issued, and rendering it would put
       results for a query three keystrokes ago under the current text. */
    if (seq !== searchSeq) return;
    clearInterval(tick); tick = null;

    /* The answer is worth keeping even if the screen has moved on — the reader
       who comes back to #/people and retypes the name gets it instantly. The
       PAINT is not: `host` was captured before an await that can last nine
       seconds, and after a route change it is a detached node that render()
       has already replaced. Writing into it is invisible rather than harmful,
       which is exactly why it would never be noticed. */
    authorCache.set(key, rows);
    if (document.getElementById('fres') !== host) return;
    paintResults(host, q, rows, { forQuery: q, searching: false, took: Date.now() - startedAt });
  }

  function authorFailure(e) {
    const kind = (e && e.kind) || 'server';
    if (kind === 'offline') return 'You appear to be offline.';
    if (kind === 'budget' || kind === 'quota-soft') return 'Open Library allows about one request a second. Give it a moment.';
    return (e && e.message) || String(e);
  }

  /* ── RE-RANKING, BECAUSE OPEN LIBRARY'S ORDER IS UNUSABLE ──────────────
     Measured on the live endpoint: `q=brandon` returns Lee E. Brandon first,
     Brandon, Ruth. second, and Brandon Sanderson — 190 works — sixth. That is
     the same broken relevance the book search has (point 3 in
     20-openlibrary.js's header), and the same answer applies: the adapter
     returns Open Library's order untouched and the view ranks.

     The scoring is about NAMES rather than titles, which is why
     BT.util.rankByRelevance is not reused: that function scores a query against
     a title and drops rows below a coverage threshold, and dropping an author
     the reader can see in the list is worse than ordering them badly.

     The work count is a genuine tiebreak rather than a popularity contest. Given
     only "brandon", every Brandon in the index is an equally good match on the
     text and the only remaining evidence about which one was meant is how much
     of them Open Library holds. It is logarithmic and capped so it can never
     outweigh an actual name match — Gwendolyn Kiste (32 works) still beats a
     600-work author whose name does not contain "kiste". */
  function rankAuthors(q, rows) {
    const n = fold(q);
    const toks = n.split(' ').filter(Boolean);
    return rows.map(a => {
      const name = fold(a.name);
      const words = name.split(' ').filter(Boolean);
      let s = 0;
      if (name === n) s += 100;
      else if (name.startsWith(n)) s += 40;
      let hit = 0;
      for (const t of toks) if (words.some(w => w.startsWith(t))) hit++;
      s += (hit / Math.max(1, toks.length)) * 30;
      if (hit === toks.length) s += 20;
      /* A surname is what people type when they type one word. */
      if (words.length && toks.length
          && words[words.length - 1].startsWith(toks[toks.length - 1])) s += 10;
      s += Math.min(12, Math.log10((a.workCount || 0) + 1) * 4);
      return { a, s };
    }).sort((x, y) => y.s - x.s || String(x.a.name).localeCompare(String(y.a.name)))
      .map(r => r.a);
  }

  /* How many ranked rows reach the screen. A disclosed bound, not a silent one:
     the count in the heading is the number SHOWN and the line beneath says how
     many were read, so a reader can always see whether the answer was narrowed. */
  const SHOW_AUTHORS = 8;

  function paintResults(host, q, rows, state) {
    const line = `<div class="fstate" id="fstate">${stateLine(state, q)}</div>`;
    if (!rows) { host.innerHTML = line; return; }

    const ranked = rankAuthors(state.forQuery || q, rows);
    const shown = ranked.slice(0, SHOW_AUTHORS);
    host.innerHTML = line
      + BT.ui.groupHead('Authors', shown.length)
      + (shown.length
          ? shown.map(authorRow).join('')
            + (ranked.length > shown.length
                ? `<div class="fbandnote">Best ${shown.length} of ${ranked.length} Open Library
                   returned, ranked against what you typed. Keep typing to narrow them.</div>`
                : '')
          : `<div class="miss muted">No author in Open Library matches “${esc(q)}”.</div>`);
  }

  /* The one line that must never be silent. Four states, and the reader can act
     differently in each. */
  function stateLine(state, q) {
    if (state.error) {
      return `<span class="fbad">Could not look up authors — ${esc(state.error)}</span>${
        state.forQuery ? ` <span class="faint">Showing the last answer, for “${esc(state.forQuery)}”.</span>` : ''}`;
    }
    if (state.searching) {
      const secs = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
      return `<span class="fdot"></span>Searching Open Library for “${esc(q)}”${
        secs >= 2 ? ` · <span class="mono">${secs}s</span>` : ''}${
        state.forQuery && state.forQuery !== fold(q)
          ? ` <span class="faint">— showing matches for “${esc(state.forQuery)}” meanwhile</span>`
          : ''}`;
    }
    return `Matches for “${esc(q)}”${
      state.took != null ? ` <span class="faint">· Open Library answered in ${
        (state.took / 1000).toFixed(1)}s</span>` : ''}`;
  }

  function authorRow(a) {
    const id = BT.follows.authorId(a.olid);
    const on = followSet.has(id);
    /* Escaped as it is collected, not at the join. `top_work` is a catalogue
       title contributed by volunteers and has carried an ampersand and a stray
       angle bracket in the wild; assembling this list unescaped and trusting the
       join site to remember is how one of those ends up parsed as markup. */
    const bits = [];
    if (a.workCount != null) bits.push(esc(BT.util.pluralize(a.workCount, 'work')));
    if (a.topWork) bits.push(esc(BT.util.truncate(a.topWork, 44)));
    if (a.birthDate) bits.push(esc(a.birthDate) + (a.deathDate ? '–' + esc(a.deathDate) : ''));
    return `<div class="miss">
      <span class="chipart fav"></span>
      <div style="min-width:0;flex:1">
        <div class="fname">${esc(a.name)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini)">
          ${bits.join(' · ')} <span class="mono faint">${esc(a.olid)}</span>
        </div>
      </div>
      ${followBtn(id, on, a.name, a.olid)}
    </div>`;
  }

  /* One button, both states, because a Follow that becomes a Following marker
     in place is the only version that does not move the row under a thumb — the
     same reason 61-view-search swaps its Add button rather than repainting the
     list. aria-pressed carries the state for a screen reader. */
  function followBtn(id, on, name, key) {
    return `<button class="add${on ? ' is-in' : ''}" type="button"
      data-follow="${esc(id)}" data-fkey="${esc(key)}"
      data-fname="${esc(name)}" aria-pressed="${on ? 'true' : 'false'}"
      >${on ? '✓ Following' : 'Follow'}</button>`;
  }

  /* ══ THE ROSTER ════════════════════════════════════════════════════════
     The compact index: who you follow, whether they have news, and when each
     was last looked at. The sections below carry the books; this carries the
     answer to "is BookTrak actually watching this person", which is the
     question the OLD roster got wrong — it read "not checked yet · never
     checked" underneath a screen that was showing the author's catalogue,
     because the page and the roster were reading two different stores. */

  function roster(follows) {
    if (!follows.length) {
      return BT.ui.emptyState({
        title: 'You are not following anyone yet',
        body: 'Follow an author and BookTrak keeps a copy of their Open Library catalogue, '
          + 'shows you what is dated ahead, and tells you when something new is listed or a '
          + 'publication year changes. You can also follow from the author’s name on any '
          + 'search result or book pane, so you never have to come here first.',
      });
    }
    return BT.ui.groupHead('Following', follows.length) + follows.map(rosterRow).join('');
  }

  function rosterRow(f) {
    const news = newsAtRender.get(f.id) || 0;
    return `<div class="miss" data-rrow="${esc(f.id)}">
      <span class="chipart fav"></span>
      <div style="min-width:0;flex:1">
        <div class="fname">${esc(f.name)}${
          news ? ` <span class="fnews">${news} new</span>` : ''}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini)">${rosterSub(f)}</div>
      </div>
      <button class="btn btn--sm btn--ghost" type="button" data-unfollow="${esc(f.id)}">Unfollow</button>
    </div>`;
  }

  /* THE SENTENCE THE OLD ROSTER COULD NOT WRITE. It said "not checked yet ·
     never checked" for every follow, for ever, because nothing on the page
     wrote `lastCheckedAt` — the strip was deliberately read-only and the sweep
     touched three follows every four hours. Now there is one writer and this
     reads its output, so the row and the section under it cannot disagree. */
  function rosterSub(f) {
    const held = ((f.works || []).length);
    const bits = [];
    if (f.lastError) bits.push(`<span class="fbad">could not check</span>`);
    else if (!f.lastCheckedAt) bits.push('not checked yet');
    else bits.push(`${esc(BT.util.pluralize(held, 'work'))} cached`);
    bits.push(f.lastCheckedAt ? `checked ${esc(BT.util.timeAgo(f.lastCheckedAt))}` : 'never checked');
    bits.push(`<span class="mono faint">${esc(f.sourceId)}</span>`);
    return bits.join(' · ');
  }

  /* ══ ONE SECTION PER AUTHOR ════════════════════════════════════════════ */

  /* Sort the stored catalogue into the three bands, and count what fell out of
     all of them.

     THE COUNTS ARE NOT DECORATION. A section showing two cards looks broken; the
     same section saying it read sixty catalogued works to find them does not. It
     is the difference between "this feature is not working" and "the catalogue
     has nothing", and it is the only thing standing between an honest narrow
     filter and a reader who widens it until the screen looks busy.

     OWNERSHIP IS TESTED FIRST, so a book already on the shelves is not counted
     as something we looked at and rejected on a date — it was never a candidate.
     Books already in the library are therefore EXCLUDED from the bands and
     counted out loud in the footnote, which is the honest form of "excluded":
     nothing disappears without a number appearing in its place. */
  function bandsOf(row) {
    const works = BT.follows.cachedWorks(row);
    const thisYear = new Date().getFullYear();
    const out = { future: [], maybe: [], recent: [],
                  owned: 0, older: 0, undated: 0, scanned: works.length };

    for (const w of works) {
      const mine = ownedWorks.has(w.workId);
      const kept = addedHere.has(w.workId);
      if (mine && !kept) { out.owned++; continue; }

      const release = sharpMap.get(w.workId) || BT.follows.releaseOfWork(w);
      const verdict = BT.follows.futureness(release);
      const r = { w, release, verdict, via: row, owned: kept, sharp: sharpAsked.has(w.workId) };

      if (verdict === 'future') { out.future.push(r); continue; }
      if (verdict === 'maybe') { out.maybe.push(r); continue; }
      /* 'unknown' is a work with no year at all. It is not a forthcoming book;
         it is an unfinished catalogue record, and there are a great many of
         them. Letting undated records through "in case" is the softest possible
         way to reintroduce the backlist strip this page was narrowed away from. */
      if (verdict === 'unknown') { out.undated++; continue; }
      const y = yearOf(w);
      if (y != null && y >= thisYear - RECENT_YEARS) out.recent.push(r);
      else out.older++;
    }

    const byTitle = (a, b) => String(a.w.title).localeCompare(String(b.w.title));
    /* SOONEST FIRST — this band is a list of what is coming, so it reads
       forwards. That is the opposite of the newest-first order the old backlist
       strip used, and the reversal is the point rather than a detail. */
    out.future.sort((a, b) => (a.release.sortKey - b.release.sortKey) || byTitle(a, b));
    /* Every key in this band is identical (January 1st of this year, for all of
       them, because 01-util.js anchors a bare year to the start of its window),
       so title is the ONLY stable order available — and an unstable sort would
       let the cards shuffle on every repaint. */
    out.maybe.sort(byTitle);
    out.recent.sort((a, b) => (yearOf(b.w) || 0) - (yearOf(a.w) || 0) || byTitle(a, b));
    return out;
  }

  const yearOf = w => (w && (w.latestYear || w.firstYear)) || null;

  function sectionHtml(row) {
    return `<section class="fsec" data-fsec="${esc(row.id)}">
      ${sectionHead(row)}
      <div class="fsec-body">${sectionBody(row)}</div>
    </section>`;
  }

  function sectionHead(row) {
    const news = newsAtRender.get(row.id) || 0;
    const busy = pendingIds.has(row.id);
    return `<div class="fsec-h">
      <span class="chipart fav"></span>
      <div style="min-width:0;flex:1">
        <div class="fsec-name">${esc(row.name)}${
          news ? ` <span class="fnews">${news} new</span>` : ''}</div>
        <div class="fsec-sub">${sectionSub(row)}</div>
      </div>
      <button class="btn btn--sm btn--ghost" type="button" data-frefresh="${esc(row.id)}"${
        busy ? ' disabled' : ''}>${busy ? 'Checking…' : 'Refresh'}</button>
    </div>`;
  }

  /* WHAT WAS READ, AND WHEN. `numFound` is Open Library's count for the whole
     catalogue and `works.length` is the page we hold, so printing both is the
     disclosed bound: a reader can see that sixty of a hundred and ninety works
     were read, newest first, and never has to wonder whether the section is a
     sample presented as a complete answer. */
  function sectionSub(row) {
    const held = (row.works || []).length;
    const bits = [];
    if (held) {
      bits.push(row.numFound > held
        ? `newest ${held} of ${esc(BT.util.pluralize(row.numFound, 'catalogued work'))}`
        : esc(BT.util.pluralize(held, 'catalogued work')));
    }
    if (row.lastCheckedAt) bits.push(`checked ${esc(BT.util.timeAgo(row.lastCheckedAt))}`);
    else bits.push('never checked');
    bits.push(`<span class="mono faint">${esc(row.sourceId)}</span>`);
    return bits.join(' · ');
  }

  /* ── THE HARD ANSWER ───────────────────────────────────────────────────
     Four states, four sentences, and never a blank. See the file header. */
  function sectionBody(row) {
    const held = (row.works || []).length;
    const busy = pendingIds.has(row.id);

    /* We have never successfully looked. This is the state a newly-followed
       author is in for the few seconds before their first answer lands, and it
       must say which of the two it is — checking, or not checked and idle. */
    if (!held && !row.lastCheckedAt) {
      if (busy) {
        return `<div class="fverdict is-wait"><span class="fdot"></span>Checking ${
          esc(row.name)}’s catalogue…</div>${BT.ui.skeletonGrid(4)}`;
      }
      return `<div class="fverdict is-wait">Not checked yet.</div>
        <div class="fbandnote">${row.lastError
          ? `The last attempt failed: ${esc(row.lastError)} This is not a statement about
             whether anything new exists — only that we could not look.`
          : 'Press Refresh, and this section fills in.'}</div>`;
    }

    const b = bandsOf(row);
    const out = [];

    /* The failure notice sits ABOVE the bands rather than replacing them. The
       cache below it is still the truth as of the last successful check, and
       blanking a correct list because a later request failed would be throwing
       away the answer to keep the error. */
    if (row.lastError) {
      out.push(`<div class="fwarn">Could not check ${esc(row.name)} ${
        esc(BT.util.timeAgo(row.lastTriedAt))} — ${esc(row.lastError)}
        Everything below is what we last read, on ${
        esc(BT.util.timeAgo(row.lastCheckedAt))}.</div>`);
    } else if (busy) {
      out.push(`<div class="fverdict is-wait"><span class="fdot"></span>Checking for changes…</div>`);
    }

    out.push(verdictLine(row, b));

    if (b.future.length) {
      out.push(BT.ui.groupHead('Dated after today', b.future.length)
        + `<div class="grid">${b.future.map(card).join('')}</div>`);
    }
    if (b.maybe.length) {
      out.push(BT.ui.groupHead(`${new Date().getFullYear()} — no month recorded`, b.maybe.length)
        + `<div class="fbandnote">Open Library records a year and no month for these, so the
           record genuinely does not say whether they are behind us or ahead of us.
           <b>Not counted as upcoming.</b>${gbNote()}</div>`
        + `<div class="grid">${b.maybe.map(card).join('')}</div>`);
    }
    if (b.recent.length) {
      const thisYear = new Date().getFullYear();
      out.push(BT.ui.groupHead(
          `Recently published · ${thisYear - RECENT_YEARS}–${thisYear - 1}`, b.recent.length)
        + `<div class="fbandnote">Already out. Listed because they are recent, not because
           they are coming.</div>`
        + `<div class="grid">${b.recent.map(card).join('')}</div>`);
    }

    out.push(footnote(row, b));
    out.push(newsHtml(row));
    return out.join('');
  }

  /* One sentence, and it is the thing the user asked for: "a hard confirmation
     that there is or isn't anything scheduled for an author". */
  function verdictLine(row, b) {
    if (b.future.length) {
      return `<div class="fverdict is-yes">${
        esc(BT.util.pluralize(b.future.length, 'work'))} dated after today.</div>`;
    }
    if (b.maybe.length) {
      return `<div class="fverdict is-maybe">Nothing is dated after today for ${esc(row.name)} — but ${
        esc(BT.util.pluralize(b.maybe.length, 'work'))} carr${b.maybe.length === 1 ? 'ies' : 'y'
        } this year with no month recorded, so ${b.maybe.length === 1 ? 'it' : 'they'
        } could still be ahead.</div>`;
    }
    return `<div class="fverdict is-no">Nothing is scheduled for ${esc(row.name)}.</div>`;
  }

  /* Everything the bands did NOT show, counted. This is what makes a short
     section legible instead of suspicious, and it is also where "already in your
     library" is disclosed rather than silently filtered. */
  function footnote(row, b) {
    const bits = [];
    bits.push(`Read ${esc(BT.util.pluralize(b.scanned, 'catalogued work'))}`);
    if (b.owned) bits.push(`${b.owned} already on your shelves`);
    if (b.older) bits.push(`${b.older} published earlier`);
    if (b.undated) bits.push(`${b.undated} with no year recorded`);
    return `<div class="fbandnote fbandnote--foot">${bits.join(' · ')}. Open Library has no
      forthcoming-title concept — it catalogues books that already exist and records years
      rather than dates — so a short or empty section here is an answer rather than a
      failure.</div>`;
  }

  /* ── THE NEWS FEED, PER AUTHOR ─────────────────────────────────────────
     What changed in this catalogue, most recent first. This is the half the old
     arrangement could not have: the previous baseline was a bag of work ids with
     no dates in it, so "the year recorded for this book changed" was invisible
     by construction rather than merely unimplemented. */
  function newsHtml(row) {
    const news = (row.news || []).slice().sort((a, b) => b.at - a.at).slice(0, 8);
    if (!news.length) return '';
    const seen = row.newsSeenAt || 0;
    return BT.ui.groupHead('What changed', news.length)
      + news.map(n => `<div class="fnewsrow${n.at > seen ? ' is-new' : ''}">
          <span class="fnk">${n.kind === 'moved' ? '↔' : '▸'}</span>
          <span class="fnt">${esc(n.title || 'Untitled work')}</span>
          <span class="fnw">${n.kind === 'moved'
            ? `year changed ${esc(String(n.from))} → ${esc(String(n.to))}`
            : `newly listed${n.to ? ` · ${esc(String(n.to))}` : ''}`}</span>
          <span class="faint">${esc(BT.util.timeAgo(n.at))}</span>
        </div>`).join('');
  }

  /* Whether the year-only rows on this page can be resolved at all, said where
     the reader is standing when the question occurs to them.

     Not a nag and not a banner: a key is optional, the page works without one,
     and every row it would sharpen is already on screen and honestly labelled.
     What the note buys is that "2026, we cannot tell" stops looking like a
     defect in BookTrak and starts looking like what it is — the limit of a
     catalogue that stores years, with a named way out. */
  function gbNote() {
    const on = !!(BT.googlebooks && typeof BT.googlebooks.enabled === 'function'
                  && BT.googlebooks.enabled());
    if (on) return ' Google Books is sharpening these into real dates where it can.';
    return ' A <a href="#/settings">Google Books key</a> would sharpen most of these'
      + ' into real dates.';
  }

  /* THE DATE IS RENDERED IN THE APP'S OWN GRAMMAR, not paraphrased into a
     sentence. BT.ui.dateField draws a fixed ten-slot monospace field and HATCHES
     every segment the record cannot support, so a bare year reads

         2026-▨▨-▨▨      the year is stored; the month and day do not exist

     which is the honest picture and needs no adjective. Hand-rolling it here —
     instead of using the one component that owns it — is how a month-precision
     book eventually renders a day. */
  function card(r) {
    const w = r.w;
    const uid = 'book:openlibrary:' + w.workId;
    const maybe = r.verdict === 'maybe';

    /* A countdown ONLY for a real day. `relativeDays` against a bare year would
       count down to January 1st — a date the record never stated and which, for
       every row in the year-only band, is already months behind us. */
    const soon = (!maybe && r.verdict === 'future' && r.release.precision === 'day')
      ? BT.util.relativeDays(BT.util.daysUntil(r.release.sortKey))
      : '';

    return `<div class="card${r.owned ? ' is-mine' : ''}${maybe ? ' is-approx' : ''}" data-uid="${esc(uid)}">
      ${/* The shape BT.ui.poster reads, and no more: a cover id is all a stored
            work carries. `ids` is present-but-empty on purpose, so posterUrl's
            ISBN and edition-OLID fallbacks find nothing and fall through to the
            generated block instead of firing a request that cannot succeed. */''}
      ${BT.ui.poster({ title: w.title, images: { coverId: w.coverId }, ids: {} })}
      <div class="ct">${esc(w.title)}</div>
      <div class="cs">
        ${BT.ui.dateField(r.release)}
        ${soon ? `<span class="csoon">${esc(soon)}</span>` : ''}
        ${r.owned ? '<span class="cmine">✓ In your library</span>' : ''}
      </div>
      ${/* The hatch says the month is missing; this says what that MEANS for the
            promise the band heading just made. Two different jobs. `sharp` marks
            the ones Google looked at and could not improve, so a reader with a
            key can tell "not checked" from "checked, and the catalogue simply
            does not say". */''}
      ${maybe ? `<div class="capprox">${esc(vagueLabel(r.release))} — may already be out${
        r.sharp ? '; Google Books has no finer date either' : ''}</div>` : ''}
    </div>`;
  }

  /* WHICH grain is missing, read off the release rather than assumed to be the
     year. Almost every 'maybe' is a bare year, but not all: a Google Books date
     of '2026-08' lands in the CURRENT month, which still straddles today and is
     still undecidable — and calling that "year only" when the card beside it
     plainly shows a month would read as a bug in BookTrak rather than as a gap
     in the record. */
  function vagueLabel(release) {
    const p = (release && release.precision) || 'unknown';
    if (p === 'month' || p === 'quarter') return 'No day recorded';
    return 'Year only';
  }

  /* ══ REFRESHING ════════════════════════════════════════════════════════
     Every button on this page and the automatic pass on entry go through the ONE
     serialized refresher in 70-follows.js. There is no fetch in this file, which
     is the property that stopped the page and the alerts feed disagreeing. */

  /* Which follows this page believes are queued or in flight, so a section can
     say "Checking…" on its own header rather than everything sharing one
     progress line. Kept locally because it is a fact about what this page asked
     for; the refresher's own progress arrives on 'follows:progress'. */
  const pendingIds = new Set();

  async function refresh(opts) {
    opts = opts || {};
    const ids = opts.ids || rosterRows.map(f => f.id);
    for (const id of ids) pendingIds.add(id);
    repaintHeads(ids);
    setRefreshAllBusy(true);
    try {
      await BT.follows.refreshAll(Object.assign({}, opts, { ids }));
    } catch (e) {
      console.warn('[people] refresh failed', e && e.message);
    } finally {
      for (const id of ids) pendingIds.delete(id);
      setRefreshAllBusy(false);
      repaintHeads(ids);
    }
  }

  /* THE GLOBAL PROGRESS IS ON THE BUTTON, and it carries a fraction rather than
     a spinner. A roster walk is one request a second, so a reader with twenty
     follows is looking at twenty seconds of work — and "Checking…" for twenty
     seconds is indistinguishable from stuck. "Checking 4/20…" is the same
     information the old shared strip printed as a sentence, in the one place
     that is on screen whichever section you have scrolled to.

     The per-section headers say which ONE is being checked; this says how much
     is left. Two different questions, and the second is the one that stops
     somebody pressing the button again. */
  function setRefreshAllBusy(busy) {
    const b = document.getElementById('frefreshall');
    if (!b) return;
    b.disabled = !!busy;
    if (!busy) { b.textContent = 'Refresh all'; return; }
    const p = (typeof BT.follows.progress === 'function') ? BT.follows.progress() : null;
    b.textContent = (p && p.total > 1)
      ? `Checking ${Math.min(p.done + 1, p.total)}/${p.total}…`
      : 'Checking…';
  }

  async function repaintHeads(ids) {
    for (const id of ids) {
      const row = await BT.follows.get(id);
      if (!row) continue;
      const sec = sectionEl(id);
      if (!sec) continue;
      const head = sec.querySelector('.fsec-h');
      if (head) head.outerHTML = sectionHead(row);
    }
  }

  /* Scanned and compared rather than selected with an attribute selector: a
     follow id is `author:openlibrary:OL1394865A`, and colons are combinators in
     CSS. Building that into a selector needs CSS.escape and gets it wrong
     silently — a selector that matches nothing throws no error, it just leaves
     the section showing the wrong thing for ever. */
  function sectionEl(id) {
    for (const el of document.querySelectorAll('#fsections [data-fsec]')) {
      if (el.dataset.fsec === id) return el;
    }
    return null;
  }

  async function repaintSection(id) {
    const row = await BT.follows.get(id);
    const sec = sectionEl(id);
    if (!sec) return;
    if (!row) { sec.remove(); return; }
    sec.innerHTML = sectionHead(row) + `<div class="fsec-body">${sectionBody(row)}</div>`;
    repaintRosterRow(row);
  }

  function repaintRosterRow(row) {
    for (const el of document.querySelectorAll('#froster [data-rrow]')) {
      if (el.dataset.rrow !== row.id) continue;
      const sub = el.querySelector('.muted');
      if (sub) sub.innerHTML = rosterSub(row);
    }
  }

  /* ══ CLICKS ════════════════════════════════════════════════════════════
     One delegated handler for the whole view. Every branch updates the DOM in
     place instead of calling BT.router.resolve(): a full re-render would throw
     away what is typed in the box and the results under it, so following three
     authors from one search would mean typing the search three times. */
  async function onClick(e) {
    const fb = e.target.closest('[data-follow]');
    if (fb) { if (suppressTap()) return; await onToggle(fb); return; }

    const un = e.target.closest('[data-unfollow]');
    if (un) { if (suppressTap()) return; await onUnfollow(un.dataset.unfollow); return; }

    const rf = e.target.closest('[data-frefresh]');
    if (rf) {
      if (suppressTap()) return;
      refresh({ ids: [rf.dataset.frefresh], force: true, reason: 'manual' });
      return;
    }

    const card = e.target.closest('[data-uid]');
    if (card) { if (suppressTap()) return; onOpen(card.dataset.uid); return; }
  }

  /* A tap that followed finger movement is a scroll, not a tap. Browsers fire
     click after a short drag, so on a phone a flick down this page would
     otherwise land on whatever was under the thumb when it lifted — and the
     follow branches above WRITE. Lifted from 61-view-search, where the same
     gesture was silently adding whichever result the scroll ended on. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  /* ── FOLLOWING SOMEBODY STARTS THEIR SECTION IMMEDIATELY ───────────────
     "when you add an author their section automatically begins to populate."
     The section is inserted in the same frame the button is pressed, in the
     "Checking…" state, and the follow jumps to the FRONT of the refresher queue
     — so a reader who has just followed someone is not behind a roster walk of
     thirty other authors on a one-request-a-second budget. */
  async function onToggle(btn) {
    const key = btn.dataset.fkey;
    const name = btn.dataset.fname || key;
    btn.disabled = true;
    let res;
    try {
      res = await BT.follows.toggleAuthor(key, name);
    } finally {
      btn.disabled = false;
    }
    /* null means there was nothing to key on — no OLID. It is NOT a silent
       no-op: following by name is the one thing this feature must never do, so
       the reason is said out loud rather than leaving a button that appears
       broken. */
    if (!res) {
      BT.ui.toast('Open Library has no id for that record, so it cannot be followed reliably.', { bad: true });
      return;
    }
    if (res.following) followSet.add(res.id); else followSet.delete(res.id);
    markButtons(res.id, res.following);
    BT.ui.toast(res.following ? `Following ${res.name}` : `Unfollowed ${res.name}`);

    await rebuildRoster();
    if (res.following) refresh({ ids: [res.id], force: true, front: true, reason: 'new follow' });
  }

  async function onUnfollow(id) {
    const gone = await BT.follows.unfollow(id);
    if (!gone) return;
    followSet.delete(id);
    markButtons(id, false);
    BT.ui.toast('Unfollowed');
    await rebuildRoster();
  }

  /* EVERY button for this follow, not just the one that was pressed. The same
     author can be a search result and a roster row at the same time, and a
     screen that shows "Follow" and "✓ Following" for one person simultaneously
     reads as a bug in the app rather than as two views of one row. */
  function markButtons(id, on) {
    for (const b of document.querySelectorAll('[data-follow]')) {
      if (b.dataset.follow !== id) continue;
      b.classList.toggle('is-in', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = on ? '✓ Following' : 'Follow';
    }
  }

  /* Roster and sections together, because they are two views of one list and
     letting them drift is how the old page ended up claiming an author had
     never been checked while showing their catalogue. */
  async function rebuildRoster() {
    const host = document.getElementById('froster');
    const secs = document.getElementById('fsections');
    if (!host || !secs) return;
    const follows = await BT.follows.all();
    rosterRows = sortRoster(follows);
    followSet = new Set(follows.map(f => f.id));
    for (const f of follows) {
      if (!newsAtRender.has(f.id)) newsAtRender.set(f.id, BT.follows.unseenNews(f).length);
    }
    host.innerHTML = roster(rosterRows);
    secs.innerHTML = rosterRows.map(sectionHtml).join('');
  }

  /* ══ OPENING A CARD ════════════════════════════════════════════════════
     NOTHING IS WRITTEN HERE. That is the fix: this used to be onAdd(), and it
     called BT.ui.addItem, so browsing an author's catalogue silently filled the
     library with `want` entries.

     No stub is handed over either, and that is deliberate rather than lazy.
     56-inspector already knows how to show a book it does not hold — see
     fetchTransient() and BT.openlibrary.lookupUid() — and what it fetches is the
     WORK record, which carries the description and subjects that the lean stored
     row behind this card does not. So one deliberate tap costs one deliberate
     request and buys a better pane than the shortcut would have, with an
     explicit "Add to library" button on it instead of an add that already
     happened. */
  function onOpen(uid) {
    if (!uid) return;
    if (!BT.inspector || typeof BT.inspector.show !== 'function') return;
    BT.inspector.show(uid);
  }

  /* ══ SHARPENING ════════════════════════════════════════════════════════
     Turn 'this year, no month' rows into real dates, or leave them honestly
     labelled.

     NOTHING HAPPENS WITHOUT A KEY. Anonymous Books API access answers HTTP 429
     with a quota of ZERO, so a keyless attempt is not a slower version of this,
     it is an error every time. BT.follows.sharpenYear returns null before
     building a URL, and this loop never runs at all.

     SERIALIZED, for the same reason the refresher is: the quota belongs to the
     reader, and a fan-out spends it faster without producing an answer any
     sooner on a list this short.

     A SHARPENED ROW CAN CHANGE BANDS, and that is the point rather than a side
     effect. If Google says the 2026 book came out on March 5th it moves to
     "Recently published", where it belongs — and the section's verdict line is
     recomputed with it, so the hard answer stays true. */
  let sharpening = false;

  async function sharpen() {
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function' || !gb.enabled()) return;
    if (typeof BT.follows.sharpenYear !== 'function') return;
    /* One pass at a time. This is triggered by the refresher going idle, and
       that event can arrive twice in quick succession — a queue that drains and
       is immediately topped up by a per-author Refresh — which would otherwise
       start a second serialized walk over the same rows, spending the reader's
       Google quota twice for one answer. `sharpAsked` would stop the duplicate
       REQUESTS, but not the duplicate repaints. */
    if (sharpening) return;
    sharpening = true;
    try { await sharpenPass(); } finally { sharpening = false; }
  }

  async function sharpenPass() {
    let spent = 0;
    for (const row of rosterRows) {
      if (!pageAlive()) return;
      const b = bandsOf(row);
      let touched = false;
      for (const r of b.maybe) {
        if (spent >= SHARPEN_MAX) break;
        if (sharpAsked.has(r.w.workId)) continue;
        sharpAsked.add(r.w.workId);
        spent++;
        let better = null;
        try {
          better = await BT.follows.sharpenYear(r.w, row.name, { release: r.release });
        } catch (e) {
          /* Enrichment is a nicety and must never be the reason a section fails
             to paint. The row keeps its honest year-only date and the loop
             carries on. */
          console.warn('[people] date sharpening failed for', r.w.title, e && e.message);
          continue;
        }
        if (!better) { touched = true; continue; }
        sharpMap.set(r.w.workId, better);
        touched = true;
      }
      if (touched && pageAlive()) await repaintSection(row.id);
      if (spent >= SHARPEN_MAX) break;
    }
  }

  /* ── The writes from elsewhere this page has to hear ───────────────────
     Subscribed ONCE at module scope. This module is a singleton whose render()
     runs again on every visit, and subscribing there would stack one more copy
     of this handler per visit — the same failure the `view.onclick =`
     assignment above avoids.

     Note what is NOT listened for: `follow:change`. The refresher writes a
     follow row on every check, so repainting on it would rebuild the whole page
     once per author during a roster walk. `follows:updated` carries the same
     news with the id attached, which is what lets one section repaint alone. */
  function subscribeOnce() {
    if (subscribed || !BT.repo || typeof BT.repo.subscribe !== 'function') return;
    subscribed = true;
    BT.repo.subscribe((ev, detail) => {
      if (!location.hash.startsWith('#/people')) return;

      if (ev === 'follows:updated' && detail && detail.id) {
        pendingIds.delete(detail.id);
        repaintSection(detail.id).catch(e => console.warn('[people] repaint', e));
        return;
      }

      if (ev === 'follows:progress' && detail) {
        setRefreshAllBusy(!!detail.running);
        /* The whole queue drained. This is the moment the undecidable rows are
           worth spending Google Books requests on: until every follow has
           answered we do not know which of them will still be in the maybe band
           when the dust settles. */
        if (!detail.running) sharpen().catch(e => console.warn('[people] sharpen', e));
        return;
      }

      if (!detail) return;

      /* Undo. BT.ui.addItem's toast offers it and it lands here, so a work left
         in `addedHere` would leave the card claiming "In your library" for a
         book that is no longer in it — the same untruth in the other direction.
         The uid grammar is the M2 contract (`book:openlibrary:{OLID}`), and
         BT.util.olid reads the id out of it wherever it sits; a `book:isbn:` uid
         yields '' and deletes nothing. */
      if (ev === 'item:delete') {
        const w = BT.util.olid(detail.uid || '');
        if (w) { addedHere.delete(w); ownedWorks.delete(w); markCard(w); }
        return;
      }

      if (ev !== 'item:put') return;
      const work = (detail.ids && detail.ids.olWork) || '';
      if (!work || addedHere.has(work)) return;
      /* Only books this page is showing. Every write anywhere in the app emits
         this — a rating, a status change, a background hydrate — and marking a
         card off the back of one would be a claim this screen has no evidence
         for. Scanned rather than selected: a uid is `book:openlibrary:OL27482W`
         and a colon is a combinator, so a selector built from one by hand
         silently matches nothing rather than erroring. */
      if (!onScreen(work)) return;
      addedHere.add(work);
      ownedWorks.add(work);
      markCard(work);
    });
  }

  function onScreen(workId) {
    const uid = 'book:openlibrary:' + workId;
    for (const el of document.querySelectorAll('#fsections .card[data-uid]')) {
      if (el.dataset.uid === uid) return true;
    }
    return false;
  }

  function markCard(workId) {
    const uid = 'book:openlibrary:' + workId;
    const owned = addedHere.has(workId);
    for (const el of document.querySelectorAll('#fsections .card[data-uid]')) {
      if (el.dataset.uid !== uid) continue;
      el.classList.toggle('is-mine', owned);
      const cs = el.querySelector('.cs');
      if (!cs) continue;
      const mark = cs.querySelector('.cmine');
      if (owned && !mark) cs.insertAdjacentHTML('beforeend', '<span class="cmine">✓ In your library</span>');
      if (!owned && mark) mark.remove();
    }
  }

  return { render };
})();
