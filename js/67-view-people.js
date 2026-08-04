/* ══════════════════════════════════════════════════════════════════════════
   #/people — Following.

   ── THE SHAPE, AND WHAT IT REPLACED ───────────────────────────────────────
   This screen used to print the roster TWICE: a compact list of who you follow
   at the top, and then a full expanded section per author underneath it. Two
   listings of one thing, each with its own last-checked line, each able to
   disagree with the other. It is now ONE list.

   Top to bottom:

     the author lookup          find somebody to follow, or to look at
     a release-window toggle    next week · this month · next month ·
                                end of year · next year
     the window's books         EVERY follow's books that land in it, pooled
                                and sorted, because "what is coming in the next
                                month" is a question about the calendar and not
                                about any one author
     one row per author         collapsed, carrying its own counts

   The window strip answers "what is coming"; the rows answer "what about this
   person". They read the same cache and cannot disagree.

   ── EVERY ROW GIVES A HARD ANSWER ─────────────────────────────────────────
   There is no ambiguous blank here. A collapsed row's counts are the answer,
   and when they are zero the row says so in words:

     · "2 upcoming (+1 new) · 12 recent"      yes, and here they are
     · "Nothing scheduled"                    no — and BOTH catalogues said so
     · "Google Books not checked"             one source is missing, so this is
                                              not yet an answer about the books
     · "Not checked yet" / "Could not check"  a claim about US, not about them

   The third and fourth matter most, because the first two are claims about the
   catalogues and these are claims about us. "We could not look" and "there is
   nothing new" are different facts, and a screen that renders both as an empty
   panel is a screen that lies during an outage. BT.follows.coverageOf(row) is
   the one place that distinction is computed.

   ── A CARD TAP OPENS THE PANE AND ADDS NOTHING ────────────────────────────
   Reported bug, not a preference. This used to call BT.ui.addItem, so looking
   at what an author had out quietly filled the library with `want` entries the
   reader never asked for — on a screen whose entire purpose is BROWSING books
   you do not own.

   ── NO EXPLAINER MICROCOPY ────────────────────────────────────────────────
   Nothing on this screen explains how the app works. The reasoning that used to
   sit under every band heading is in the code and in DECISIONS.md. What is left
   is: empty states that say what to DO, real error messages, and counts. Where
   a caveat is genuinely load-bearing — a date the record cannot support — it is
   carried by the app's existing date grammar (a hatched field) rather than by a
   sentence.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewPeople = (function () {
  const esc = BT.util.escapeHtml;

  /* How far back "recent" reaches. Small on purpose: the point of the count is
     "what has this author had out lately", and a five-year window is a
     bibliography rather than news. */
  const RECENT_YEARS = 2;

  /* Minimum characters before the author lookup fires. Two, matched to
     20-openlibrary.js's typeahead rule, which will not wildcard a single
     character (`b*` matches 170,000 authors — measured). */
  const MIN_Q = 2;

  /* How many ranked lookup rows reach the screen. */
  const SHOW_AUTHORS = 8;

  /* The five windows, in the order the user asked for them. The ids are
     BT.util.releaseWindow's, so #/people and #/up agree about where "this
     month" ends and there is one calendar in the app rather than two. */
  const WINDOWS = [
    { id: 'week',   label: 'Next week' },
    { id: 'month',  label: 'This month' },
    { id: 'next',   label: 'Next month' },
    { id: 'year',   label: 'End of year' },
    { id: 'nextyr', label: 'Next year' },
  ];
  const WIN_KEY = 'bt.people.window';
  const OPEN_KEY = 'bt.people.open.v1';
  const RECENT_KEY = 'bt.people.recent.v1';

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
  let windowId = loadWindow();
  let expanded = loadSet(OPEN_KEY);
  let recentOpen = loadSet(RECENT_KEY);
  const seenTimers = new Map();  // followId -> the pending mark-seen timer

  /* Author lookups already answered, keyed on the folded query. Module-scoped
     rather than per-render, and it is not a micro-optimisation: Open Library's
     author endpoint answers in 2.5 to 9 SECONDS (measured across a dozen
     queries), so the difference between reusing an answer and asking again is
     the difference between a box that responds and one that appears broken. */
  const authorCache = new Map();
  let searchSeq = 0;

  /* The unseen-news count as it stood when the page was drawn.

     Captured rather than recomputed, for the same reason 66-view-alerts.js does
     not repaint after marking rows read: the badge is what tells the reader
     WHICH rows have something new in them, and a badge that vanished the instant
     the seen-marker was written would take that information away while they
     were still reading it. */
  let newsAtRender = new Map();

  /* Works that became yours WHILE this page was showing them.

     Deliberately not filtered back out. Adding a book from the detail pane ends
     in BT.router.resolve(), which re-renders this screen — and the re-render
     reads the shelves again, so without this set the card the reader just acted
     on would VANISH from under the pane they acted on it in. */
  const addedHere = new Set();

  function loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key)) || []); }
    catch (_) { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch (_) {}
  }
  function loadWindow() {
    try {
      const v = localStorage.getItem(WIN_KEY);
      return WINDOWS.some(w => w.id === v) ? v : 'month';
    } catch (_) { return 'month'; }
  }

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
       neither the union nor the coverage rule — at which point every row on this
       page would render permanently empty with nothing to say why. */
    if (f && typeof f.cachedWorks !== 'function') out.push('70-follows.js (cachedWorks)');
    if (f && typeof f.refreshAll !== 'function') out.push('70-follows.js (refreshAll)');
    if (f && typeof f.coverageOf !== 'function') out.push('70-follows.js (coverageOf)');
    if (f && typeof f.inWindow !== 'function') out.push('70-follows.js (inWindow)');
    return out;
  }

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;
    pageAlive = alive || (() => true);

    if (inflight) { inflight.abort(); inflight = null; }
    clearInterval(tick); tick = null;
    for (const t of seenTimers.values()) clearTimeout(t);
    seenTimers.clear();
    subscribeOnce();

    const gap = missingDeps();
    if (gap.length) {
      BT.ui.crumb(['Discover', 'Following']);
      BT.ui.paneActions('');
      view.innerHTML = BT.ui.errorBox('Following is not wired up on this page',
        `Missing ${gap.join(', ')}. Everything already on your shelves still works.`);
      return;
    }

    /* "See works" is a screen of its own on the same route, so it can be linked
       and reloaded — and so it works for an author NOBODY FOLLOWS, which is the
       whole point of the control. */
    if (q && q.works) { await renderWorks(view, q); return; }

    BT.ui.crumb(['Discover', 'Following']);

    if (q && q.w && WINDOWS.some(w => w.id === q.w)) windowId = q.w;

    /* ONE read of the library, used to mark rows as owned. Reading it inside a
       row renderer instead was the obvious shape, and is a full store scan per
       author. */
    const items = await BT.repo.allItems();
    if (!pageAlive()) return;
    ownedWorks = new Set(items.map(it => (it.ids && it.ids.olWork) || '').filter(Boolean));
    dropBands();

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
          <input id="fq" type="search" placeholder="Find an author…"
                 spellcheck="false" autocomplete="off" autocapitalize="none" autocorrect="off"
                 value="${esc(term)}" aria-label="Find an author">
        </div>
      </div>

      <div id="fres"></div>
      ${keyPrompt()}
      ${follows.length ? windowStrip() : ''}
      <div id="froster">${roster(rosterRows)}</div>`;

    const input = document.getElementById('fq');
    /* 320ms. Shorter than the 350 this box used to run at, and the reason is
       that the debounce was never the slow part: the ENDPOINT is (2.5–9s
       measured), so a longer wait only delays the start of a request the reader
       is already waiting on. What makes the shorter wait affordable is that a
       superseded lookup is dropped by sequence number rather than by blanking
       the panel — see find(). */
    const wait = matchMedia('(pointer: coarse)').matches ? 400 : 320;
    const run = BT.util.debounce(() => find(input.value.trim()), wait);
    input.addEventListener('input', () => {
      /* TWO handlers on one event, and the un-debounced one is the fix for
         "it feels unresponsive". A debounce is invisible from the outside: for
         the third of a second before it fires, the panel is still describing the
         PREVIOUS query. This runs on the keystroke itself and does one cheap
         thing — it repaints the state line and swaps in the best cached answer
         for a prefix of what is now typed. */
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
       on other screens and stack up one more copy per re-render. */
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
       few hours costs ZERO requests on either source. Not awaited: the page is
       drawn and the reader can use it. */
    refresh({ reason: 'page' });

    /* Any row that is already expanded is being READ, so its badge is due to
       clear. Rows that are collapsed keep theirs — that is what the badge is
       for. See scheduleSeen(). */
    for (const f of follows) if (expanded.has(f.id)) scheduleSeen(f.id);
  }

  /* `|| ''` because these rows survive an export and an import: a row that
     arrived from another device — or from a version of this file that wrote the
     name differently — must sort rather than throw, or one malformed follow
     takes the whole roster down. */
  function sortRoster(follows) {
    return follows.slice().sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || '')));
  }

  /* ══ THE GOOGLE KEY, SAID ONCE ═════════════════════════════════════════
     Google Books is the primary source, and without a key there is no Google
     half at all — anonymous access answers HTTP 429 with a quota of ZERO. The
     app still works: Open Library answers, the rows still give hard answers, and
     the counts are honest about what they rest on.

     ONE prompt, at the top, with somewhere to go. Not a sentence repeated under
     every author, and not a nag: it disappears the moment a key exists. */
  function keyPrompt() {
    const on = !!(BT.googlebooks && typeof BT.googlebooks.enabled === 'function'
                  && BT.googlebooks.enabled());
    if (on) return '';
    /* The STATE and the ACTION, and not one word about why the state matters.
       This carried a trailing clause explaining that Open Library records years
       rather than dates — which is true, is the reason the prompt exists, and is
       still the app lecturing. The reader does not need to be taught what a
       catalogue holds; they need to know a source is off and where the switch
       is. The reason is in DECISIONS.md. */
    return `<div class="fwarn fwarn--act">
      Google Books is switched off. These lists are Open Library only.
      <a class="btn btn--sm" href="#/settings">Add a Google Books key</a>
    </div>`;
  }

  /* ══ THE RELEASE WINDOW ════════════════════════════════════════════════
     One question about the calendar, asked across every follow at once.

     THE STRIP IS ABOVE THE ROSTER because it is the more common question. The
     per-author rows answer "what about this person"; this answers "what is
     coming", which is what somebody opens this screen for. */
  function windowStrip() {
    const buttons = WINDOWS.map(w => `<button type="button" data-win="${w.id}"
      aria-pressed="${w.id === windowId ? 'true' : 'false'}">${esc(w.label)}</button>`).join('');
    return `<div class="fwin">
      <div class="seg seg--wrap" role="group" aria-label="Release window">${buttons}</div>
    </div>
    <div id="fwinbody">${windowBody()}</div>`;
  }

  /* TWO GROUPS, because a record can be too vague to answer the question and
     still be relevant to it. BT.follows.windowFit says which:

       'in'        the record's own window fits inside the asked-for one, so it
                   places the book there itself
       'possible'  the two overlap but the record is wider than the question — a
                   bare '2026' asked about next week

     Measured: with a plain overlap test, Open Library's bare-'2026' record for
     Isles of the Emberdark appeared under FOUR of the five windows, as though
     four different things were happening. Splitting them keeps every row on
     screen and stops the vague one impersonating a confirmed date. */
  function windowBody() {
    const win = WINDOWS.find(w => w.id === windowId) || WINDOWS[1];
    const range = BT.util.releaseWindow(win.id);
    const firm = [];
    const loose = [];
    for (const f of rosterRows) {
      for (const r of worksOf(f)) {
        const fit = BT.follows.windowFit(r.release, range.from, range.to);
        if (fit === 'in') firm.push(r);
        else if (fit === 'possible') loose.push(r);
      }
    }
    /* SOONEST FIRST, then by precision. A window is a list of what is coming, so
       it reads forwards; and where two land on the same key the one whose record
       actually states a day goes above the one whose bare year merely overlaps. */
    const rank = p => BT.normalize.precisionRank(p);
    const order = (a, b) => (a.release.sortKey - b.release.sortKey)
      || (rank(b.release.precision) - rank(a.release.precision))
      || String(a.w.title).localeCompare(String(b.w.title));
    firm.sort(order);
    loose.sort(order);

    const span = `${BT.util.skToISO(range.from)} → ${BT.util.skToISO(range.to)}`;
    if (!firm.length && !loose.length) {
      return `<div class="fverdict is-no">Nothing from the ${
        esc(BT.util.pluralize(rosterRows.length, 'author'))} you follow lands in ${
        esc(win.label.toLowerCase())}.</div>`;
    }
    const out = [];
    out.push(BT.ui.groupHead(win.label, firm.length)
      + `<div class="fbandnote"><span class="mono">${esc(span)}</span></div>`);
    out.push(firm.length
      ? `<div class="grid">${firm.map(r => card(r, { byline: true })).join('')}</div>`
      : `<div class="fverdict is-no">Nothing is dated inside ${esc(win.label.toLowerCase())}.</div>`);
    if (loose.length) {
      out.push(BT.ui.groupHead('Could fall here', loose.length)
        + `<div class="grid">${loose.map(r => card(r, { byline: true })).join('')}</div>`);
    }
    return out.join('');
  }

  /* ══ FINDING SOMEONE ═══════════════════════════════════════════════════
     ── THE REPORTED BUG, AND THE FOUR THINGS THAT CAUSED IT ───────────────
     "it feels unresponsive. i often have a hard time finding authors needing to
     retype their name several times for it to come up". Each was measured:

     1. A HALF-TYPED NAME MATCHED NOTHING AT ALL. `q=sanderso` answers HTTP 200
        with numFound 0; `q=sanderso*` answers with 1090. Fixed in
        20-openlibrary.js — see typeaheadQuery.
     2. THE PANEL WAS BLANKED ON EVERY KEYSTROKE. Now the previous answer STAYS,
        labelled with the query it belongs to.
     3. THE LOOKUP QUEUED BEHIND THE ROSTER. BT.follows.hold() now outranks the
        refresher for the duration of a lookup.
     4. NOTHING SAID IT WAS STILL WORKING. The state line counts the seconds. */

  const fold = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  /* The best answer we already hold for something related to what is typed now.

     TWO RELATIONSHIPS, AND THE SECOND IS A BUG FIX RATHER THAN A BONUS.
       widening   a cached key that is a PREFIX of what is typed. Its results are
                  a superset, so showing them under a longer query is safe.
       narrowing  a cached key that what is typed is a prefix OF. This is
                  BACKSPACE, and without it deleting one character blanks the
                  panel — which is exactly what somebody does after a bad result. */
  function bestCached(q) {
    const key = fold(q);
    let wider = null;
    let narrower = null;
    for (const [k, rows] of authorCache) {
      if (key.startsWith(k)) {
        if (!wider || k.length > wider.key.length) wider = { key: k, rows };
      } else if (k.startsWith(key)) {
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
      if (inflight) { inflight.abort(); inflight = null; }
      searchSeq++;
      paintResults(host, q, exact, { forQuery: q, searching: false });
      return;
    }

    const near = bestCached(q);
    const startedAt = Date.now();
    paintResults(host, q, near ? near.rows : null,
      { forQuery: near ? near.key : '', searching: true, startedAt });
    /* The seconds are counted on screen because they are long enough to be worth
       counting. Only the state line is rewritten — repainting the rows on a timer
       would re-create every avatar once a second. */
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
       Released in `finally` without exception: a hold that leaks would slow every
       later refresh by HOLD_MAX_MS. Feature-detected rather than called bare,
       because a TypeError here lands inside a debounce callback where it presents
       as a search box that does nothing at all. */
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
       resolve after a newer request was issued. */
    if (seq !== searchSeq) return;
    clearInterval(tick); tick = null;

    authorCache.set(key, rows);
    /* `host` was captured before an await that can last nine seconds, and after
       a route change it is a detached node render() has already replaced. */
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
     Brandon, Ruth. second, and Brandon Sanderson — 190 works — sixth.

     The scoring is about NAMES rather than titles, which is why
     BT.util.rankByRelevance is not reused: that function scores a query against
     a title and DROPS rows below a coverage threshold, and dropping an author
     the reader can see in the list is worse than ordering them badly. */
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
      /* Logarithmic and capped so it can never outweigh an actual name match —
         Gwendolyn Kiste (32 works) still beats a 600-work author whose name does
         not contain "kiste". */
      s += Math.min(12, Math.log10((a.workCount || 0) + 1) * 4);
      return { a, s };
    }).sort((x, y) => y.s - x.s || String(x.a.name).localeCompare(String(y.a.name)))
      .map(r => r.a);
  }

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
                ? `<div class="fbandnote">Showing ${shown.length} of ${ranked.length}.</div>`
                : '')
          : `<div class="miss muted">No author in Open Library matches “${esc(q)}”.</div>`);
  }

  /* The one line that must never be silent. Three states, and the reader can act
     differently in each. */
  function stateLine(state, q) {
    if (state.error) {
      return `<span class="fbad">Could not look up authors — ${esc(state.error)}</span>${
        state.forQuery ? ` <span class="faint">Showing the last answer, for “${esc(state.forQuery)}”.</span>` : ''}`;
    }
    if (state.searching) {
      const secs = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
      return `<span class="fdot"></span>Searching for “${esc(q)}”${
        secs >= 2 ? ` · <span class="mono">${secs}s</span>` : ''}${
        state.forQuery && state.forQuery !== fold(q)
          ? ` <span class="faint">— showing “${esc(state.forQuery)}” meanwhile</span>`
          : ''}`;
    }
    return `Matches for “${esc(q)}”${
      state.took != null ? ` <span class="faint">· ${(state.took / 1000).toFixed(1)}s</span>` : ''}`;
  }

  function authorRow(a) {
    const id = BT.follows.authorId(a.olid);
    const on = followSet.has(id);
    /* Escaped as it is collected, not at the join. `top_work` is a catalogue
       title contributed by volunteers and has carried an ampersand and a stray
       angle bracket in the wild. */
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
      <a class="btn btn--sm btn--ghost" href="${worksHref(a.olid, a.name)}">See works</a>
      ${followBtn(id, on, a.name, a.olid)}
    </div>`;
  }

  /* One button, both states, because a Follow that becomes a Following marker in
     place is the only version that does not move the row under a thumb.
     aria-pressed carries the state for a screen reader. */
  function followBtn(id, on, name, key) {
    return `<button class="add${on ? ' is-in' : ''}" type="button"
      data-follow="${esc(id)}" data-fkey="${esc(key)}"
      data-fname="${esc(name)}" aria-pressed="${on ? 'true' : 'false'}"
      >${on ? '✓ Following' : 'Follow'}</button>`;
  }

  const worksHref = (olid, name, gbName) =>
    `#/people?works=1&olid=${encodeURIComponent(olid || '')}`
    + `&name=${encodeURIComponent(name || '')}`
    + (gbName && gbName !== name ? `&gb=${encodeURIComponent(gbName)}` : '');

  /* ══ THE ROSTER — ONE ROW PER AUTHOR ═══════════════════════════════════ */

  function roster(follows) {
    if (!follows.length) {
      return BT.ui.emptyState({
        title: 'You are not following anyone yet',
        body: 'Search for an author above, or follow one from any search result or book pane.',
        actions: '<a class="btn btn--primary" href="#/search">Search for a book</a>',
      });
    }
    return BT.ui.groupHead('Following', follows.length)
      + follows.map(rowHtml).join('');
  }

  function rowHtml(row) {
    const open = expanded.has(row.id);
    return `<section class="frow${open ? ' is-open' : ''}" data-fsec="${esc(row.id)}">
      ${rowHead(row)}
      ${open ? `<div class="frow-body">${rowBody(row)}</div>` : ''}
    </section>`;
  }

  function rowHead(row) {
    const open = expanded.has(row.id);
    const busy = pendingIds.has(row.id);
    return `<div class="frow-h">
      <button class="frow-toggle" type="button" data-ftoggle="${esc(row.id)}"
              aria-expanded="${open ? 'true' : 'false'}">
        <span class="tri"><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 4l4 4 4-4z"/></svg></span>
        <span class="chipart fav"></span>
        <span class="frow-main">
          <span class="frow-name">${esc(row.name)}</span>
          <span class="frow-counts">${counts(row)}</span>
        </span>
      </button>
      <div class="frow-acts">
        <button class="btn btn--sm btn--ghost" type="button" data-frefresh="${esc(row.id)}"${
          busy ? ' disabled' : ''}>${busy ? 'Checking…' : 'Refresh'}</button>
        <a class="btn btn--sm btn--ghost" href="${
          worksHref(row.olid || row.sourceId, row.name, row.gbName)}">See works</a>
        <button class="btn btn--sm btn--ghost" type="button" data-unfollow="${esc(row.id)}">Unfollow</button>
      </div>
      <div class="frow-sub">${rowSub(row)}</div>
    </div>`;
  }

  /* ── THE HARD ANSWER, ON THE COLLAPSED ROW ─────────────────────────────
     "N upcoming (+X new) · M recent", or a sentence saying why there is no
     number. This is the line the whole screen exists to print, so every branch
     of it is a different, checkable claim. */
  function counts(row) {
    const busy = pendingIds.has(row.id);
    const held = (row.works || []).length;
    const news = newsAtRender.get(row.id) || 0;
    const cov = BT.follows.coverageOf(row);

    if (!held && !row.lastCheckedAt) {
      return busy
        ? '<span class="fdot"></span><span class="fq-wait">Checking…</span>'
        : '<span class="fq-wait">Not checked yet</span>';
    }

    const b = bandsOf(row);
    const bits = [];
    const up = b.future.length + b.maybe.length;
    if (up) {
      bits.push(`<b class="fq-yes">${esc(BT.util.pluralize(up, 'upcoming', 'upcoming'))}</b>`);
    }
    if (news) bits.push(`<span class="fnews">+${news} new</span>`);
    if (b.recent.length) bits.push(`${b.recent.length} recent`);

    if (!up) {
      /* NOTHING SCHEDULED IS ONLY SAID WHEN BOTH SOURCES ANSWERED. Otherwise
         this is a claim about us, and the row says which half is missing. */
      if (!cov.complete && cov.missing.length) {
        bits.unshift(`<span class="fq-wait">${esc(cov.missing.join(' and '))} did not answer</span>`);
      } else {
        bits.unshift('<span class="fq-no">Nothing scheduled</span>');
      }
    }
    return bits.join('<span class="fq-sep">·</span>');
  }

  /* WHAT WAS READ, AND WHEN, and which catalogues answered. `numFound` is Open
     Library's count for the whole catalogue and `works.length` is the merged
     list we hold, so printing both is the disclosed bound. */
  function rowSub(row) {
    const held = (row.works || []).length;
    const cov = BT.follows.coverageOf(row);
    const bits = [];
    if (held) bits.push(`${held} in the list`);
    bits.push(row.lastCheckedAt
      ? `checked ${esc(BT.util.timeAgo(row.lastCheckedAt))}`
      : 'never checked');
    const src = [];
    if (cov.olApplicable) src.push(`OL${cov.openlibrary ? '' : ' ✗'}`);
    if (!cov.gbOff) src.push(`Google${cov.googlebooks ? '' : ' ✗'}`);
    if (src.length) bits.push(`<span class="mono faint">${esc(src.join(' + '))}</span>`);
    if (row.olid || row.sourceId) {
      bits.push(`<span class="mono faint">${esc(row.olid || row.sourceId)}</span>`);
    }
    return bits.join(' · ');
  }

  /* ── THE EXPANDED BODY ─────────────────────────────────────────────────
     Upcoming, then recent behind its own count, then what changed. */
  function rowBody(row) {
    const held = (row.works || []).length;
    const busy = pendingIds.has(row.id);

    if (!held && !row.lastCheckedAt) {
      if (busy) return BT.ui.skeletonGrid(4);
      return `<div class="fbandnote">${row.lastError
        ? esc(row.lastError)
        : 'Press Refresh to fill this in.'}</div>`;
    }

    const b = bandsOf(row);
    const out = [];

    /* The failure notice sits ABOVE the list rather than replacing it. The cache
       below is still the truth as of the last successful check, and blanking a
       correct list because a later request failed would throw away the answer to
       keep the error. */
    if (row.lastError) {
      out.push(`<div class="fwarn">${esc(row.lastError)}</div>`);
    }

    const up = b.future.concat(b.maybe);
    if (up.length) {
      out.push(`<div class="grid">${up.map(r => card(r)).join('')}</div>`);
    } else {
      const cov = BT.follows.coverageOf(row);
      out.push(`<div class="fverdict ${cov.complete ? 'is-no' : 'is-wait'}">${
        cov.complete
          ? `Nothing scheduled for ${esc(row.name)}.`
          : `Not a complete answer — ${esc(cov.missing.join(' and ') || 'no catalogue')} did not answer.`
      }</div>`);
    }

    if (b.recent.length) {
      const open = recentOpen.has(row.id);
      out.push(`<button class="fmore" type="button" data-frecent="${esc(row.id)}"
          aria-expanded="${open ? 'true' : 'false'}">
        <span class="tri"><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 4l4 4 4-4z"/></svg></span>
        Recent <span class="fq-sep">·</span> ${b.recent.length}</button>`);
      if (open) out.push(`<div class="grid">${b.recent.map(r => card(r)).join('')}</div>`);
    }

    out.push(newsHtml(row));
    return out.join('');
  }

  /* ══ BANDS ═════════════════════════════════════════════════════════════
     Sort the stored catalogue into upcoming / undecidable / recent, and count
     what fell out of all of them.

     OWNERSHIP IS TESTED FIRST, so a book already on the shelves is not counted
     as something we looked at and rejected on a date — it was never a candidate. */
  /* MEMOIZED, and this is not a micro-optimisation — it is the difference
     between a roster walk repainting smoothly and one that stutters.

     bandsOf is read three times per row per paint (the collapsed counts, the
     expanded body, and the pooled window strip), and the window strip repaints
     on EVERY `follows:updated`. On a roster of twenty that is 20 × 20 × 3 = 1200
     passes over a hundred works each, every one of them re-parsing a date string
     through BT.normalize.buildRelease, during the exact seconds the refresher is
     also doing network work.

     Keyed on `worksAt` as well as the id, so a row whose catalogue was just
     rewritten recomputes and a row that merely repainted does not. `ownedWorks`
     and `addedHere` also feed the answer, so the whole cache is dropped whenever
     either moves — a stale band would leave a book the reader just added still
     sitting in the upcoming list. */
  const bandCache = new Map();
  function dropBands(id) {
    if (id) bandCache.delete(id); else bandCache.clear();
  }

  function bandsOf(row) {
    const ck = row.id + '@' + (row.worksAt || 0);
    const hit = bandCache.get(row.id);
    if (hit && hit.ck === ck) return hit.b;
    const b = computeBands(row);
    bandCache.set(row.id, { ck, b });
    return b;
  }

  function computeBands(row) {
    const works = BT.follows.cachedWorks(row);
    const thisYear = new Date().getFullYear();
    const out = { future: [], maybe: [], recent: [],
                  owned: 0, older: 0, undated: 0, read: works.length };

    for (const w of works) {
      const mine = w.workId && ownedWorks.has(w.workId);
      const kept = w.workId && addedHere.has(w.workId);
      if (mine && !kept) { out.owned++; continue; }

      const release = BT.follows.releaseOfWork(w);
      const verdict = BT.follows.futureness(release);
      const r = { w, release, verdict, via: row, owned: !!kept };

      if (verdict === 'future') { out.future.push(r); continue; }
      if (verdict === 'maybe') { out.maybe.push(r); continue; }
      /* 'unknown' is a work with no date at all. It is not a forthcoming book;
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
       forwards. */
    out.future.sort((a, b) => (a.release.sortKey - b.release.sortKey) || byTitle(a, b));
    /* Every key in this band is January 1st of this year (01-util.js anchors a
       bare year to the start of its window), so title is the ONLY stable order
       available — and an unstable sort would let the cards shuffle on repaint. */
    out.maybe.sort(byTitle);
    out.recent.sort((a, b) => (b.release.sortKey - a.release.sortKey) || byTitle(a, b));
    return out;
  }

  /* Every candidate row for one follow, banded and flattened — what the window
     strip pools. Owned books are excluded here for the same reason they are
     excluded from a row: they are not something to look forward to. */
  function worksOf(row) {
    const b = bandsOf(row);
    return b.future.concat(b.maybe);
  }

  const yearOf = w => {
    const p = BT.util.sortKeyToParts(BT.follows.releaseOfWork(w).sortKey);
    return (p && p.y) || (Number.isFinite(w && w.firstYear) ? w.firstYear : null);
  };

  /* ── THE NEWS FEED, PER AUTHOR ─────────────────────────────────────────
     What changed in this catalogue, most recent first. */
  function newsHtml(row) {
    const news = (row.news || []).slice().sort((a, b) => b.at - a.at).slice(0, 8);
    if (!news.length) return '';
    const seen = row.newsSeenAt || 0;
    return BT.ui.groupHead('What changed', news.length)
      + news.map(n => `<div class="fnewsrow${n.at > seen ? ' is-new' : ''}">
          <span class="fnk">${n.kind === 'moved' ? '↔' : '▸'}</span>
          <span class="fnt">${esc(n.title || 'Untitled work')}</span>
          <span class="fnw">${n.kind === 'moved'
            ? `${esc(String(n.from))} → ${esc(String(n.to))}`
            : `newly listed${n.to ? ` · ${esc(String(n.to))}` : ''}`}</span>
          <span class="faint">${esc(BT.util.timeAgo(n.at))}</span>
        </div>`).join('');
  }

  /* THE DATE IS RENDERED IN THE APP'S OWN GRAMMAR, not paraphrased into a
     sentence. BT.ui.dateField draws a fixed ten-slot monospace field and HATCHES
     every segment the record cannot support, so a bare year reads

         2026-▨▨-▨▨      the year is stored; the month and day do not exist

     which is the honest picture and needs no adjective. That is why the "may
     already be out" caption is gone: the hatch already says it, and the sentence
     was one more piece of the app explaining itself. */
  function card(r, opts) {
    opts = opts || {};
    const w = r.w;
    const uid = uidOf(w);
    const maybe = r.verdict === 'maybe';

    /* A countdown ONLY for a real day. `relativeDays` against a bare year would
       count down to January 1st — a date the record never stated. */
    const soon = (!maybe && r.verdict === 'future' && r.release.precision === 'day')
      ? BT.util.relativeDays(BT.util.daysUntil(r.release.sortKey))
      : '';

    /* A reissue: this printing is ahead of us and the work is not new. Stated as
       a fact ("first published 2024"), never as a caveat about the app. */
    const first = Number.isFinite(w.firstYear) ? w.firstYear : null;
    const here = BT.util.sortKeyToParts(r.release.sortKey);
    const reissue = first && here && here.y > first;

    return `<div class="card${r.owned ? ' is-mine' : ''}${maybe ? ' is-approx' : ''}"${
      uid ? ` data-uid="${esc(uid)}"` : ' data-noopen="1"'}>
      ${BT.ui.poster(posterFor(w))}
      <div class="ct">${esc(w.title)}</div>
      ${opts.byline ? `<div class="cby">${esc(r.via.name)}</div>` : ''}
      <div class="cs">
        ${BT.ui.dateField(r.release)}
        ${soon ? `<span class="csoon">${esc(soon)}</span>` : ''}
        ${r.owned ? '<span class="cmine">✓ In your library</span>' : ''}
      </div>
      ${reissue ? `<div class="cfirst">first published ${first}</div>` : ''}
    </div>`;
  }

  /* The shape BT.ui.poster reads. An Open Library cover id when there is one;
     otherwise Google's thumbnail, which is the only cover a forthcoming title
     Open Library has never catalogued will ever have. `ids` is present-but-empty
     when neither exists, so posterUrl's ISBN and edition-OLID fallbacks find
     nothing and fall through to the generated block instead of firing a request
     that cannot succeed. */
  /* THE COVER SHOULD BE THE PRINTING THE DATE CAME FROM, and where the two
     sources disagree that means Google's.

     Measured: Open Library's `cover_i` for Brandon Sanderson's Wind and Truth is
     the SPANISH edition, `Viento y Verdad` — its work record simply points at
     whichever edition somebody uploaded art for, with no language preference at
     all. So a card whose date came from Google's English 2026-10-27 printing was
     showing a Spanish cover, which reads as the app having found the wrong book.

     `coverUrl` is posterUrl's absolute-URL branch, which exists precisely for a
     Google Books thumbnail — it is not a URL this app can rebuild from an id,
     because it carries an opaque token. */
  function posterFor(w) {
    const preferThumb = w.thumb && w.dateSource === 'googlebooks';
    if (preferThumb) return { title: w.title, images: { coverUrl: w.thumb }, ids: {} };
    if (w.coverId) return { title: w.title, images: { coverId: w.coverId }, ids: {} };
    if (w.thumb) return { title: w.title, images: { coverUrl: w.thumb }, ids: {} };
    return { title: w.title, images: {}, ids: w.isbn13 ? { isbn13: w.isbn13 } : {} };
  }

  /* WHICH uid opens this book's pane, in the order of what actually resolves.

     OPEN LIBRARY'S WORK ID FIRST, ALWAYS, even on a row Google supplied the date
     for. That is the app's whole dedupe contract: a book already on the shelves
     is keyed `book:openlibrary:{OLID}`, so opening a Google uid for a work the
     reader already owns would show them a stranger's copy of their own book and
     offer to add it a second time. Google's id is used only where Open Library
     genuinely has no record — which is exactly what a forthcoming title is.

     56-inspector dispatches `book:googlebooks:…` to BT.googlebooks.lookupUid and
     the other two to BT.openlibrary.lookupUid, so all three resolve. The Google
     branch is FEATURE-DETECTED anyway: without a key that lookup cannot run, and
     minting a uid nothing can open would give the reader a pane that says "Not
     found" where an ISBN would have worked. */
  function uidOf(w) {
    if (w.workId) return 'book:openlibrary:' + w.workId;
    const gb = BT.googlebooks;
    const gbOpens = !!(gb && typeof gb.lookupUid === 'function'
                       && typeof gb.enabled === 'function' && gb.enabled());
    if (w.volumeId && gbOpens) return 'book:googlebooks:' + w.volumeId;
    if (w.isbn13) return 'book:isbn:' + w.isbn13;
    if (w.volumeId && gb && typeof gb.lookupUid === 'function') {
      return 'book:googlebooks:' + w.volumeId;
    }
    return '';
  }

  /* ══ SEE WORKS ═════════════════════════════════════════════════════════
     One author's whole catalogue, for somebody you follow OR somebody you do
     not. Paged, and a click opens the pane without adding anything. */
  let worksState = null;

  async function renderWorks(view, q) {
    const identity = {
      olid: String(q.olid || ''),
      name: String(q.name || ''),
      gbName: String(q.gb || q.name || ''),
    };
    BT.ui.crumb(['Discover', 'Following', identity.name || 'Works']);
    BT.ui.paneActions('<a class="btn btn--sm btn--ghost" href="#/people">Back to Following</a>');

    const followId = identity.olid
      ? BT.follows.authorId(identity.olid)
      : (BT.follows.googleAuthorId ? BT.follows.googleAuthorId(identity.gbName) : '');
    const following = followId ? await BT.follows.isFollowing(followId) : false;
    if (!pageAlive()) return;

    worksState = { identity, page: 0, rows: [], more: false, errors: [], loading: true };

    view.innerHTML = `
      <div class="fworks-h">
        <span class="chipart fav"></span>
        <div style="min-width:0;flex:1">
          <div class="fsec-name">${esc(identity.name || identity.gbName)}</div>
          <div class="fsec-sub" id="fwsub">Loading…</div>
        </div>
        ${followBtn(followId, following, identity.name, identity.olid)}
      </div>
      <div id="fwbody">${BT.ui.skeletonGrid(8)}</div>`;

    view.onclick = onWorksClick;
    await loadWorksPage();
  }

  async function loadWorksPage() {
    const st = worksState;
    if (!st) return;
    st.loading = true;
    try {
      const res = await BT.follows.browseAuthor(st.identity, { page: st.page });
      if (!pageAlive() || worksState !== st) return;
      /* Merged across pages rather than replaced, because page 1 carries the
         Open Library half and page 2 onwards is Google only. */
      const byKey = new Map(st.rows.map(w => [w.key, w]));
      for (const w of res.works) if (!byKey.has(w.key)) byKey.set(w.key, w);
      st.rows = [...byKey.values()];
      st.more = res.more;
      st.errors = res.errors || [];
    } catch (e) {
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
      st.errors = [(e && e.message) || String(e)];
    } finally {
      st.loading = false;
    }
    paintWorks();
  }

  function paintWorks() {
    const st = worksState;
    const body = document.getElementById('fwbody');
    const sub = document.getElementById('fwsub');
    if (!st || !body) return;

    const rows = st.rows.map(w => {
      const release = BT.follows.releaseOfWork(w);
      return { w, release, verdict: BT.follows.futureness(release), via: st.identity, owned: false };
    });
    /* Newest first: this is a bibliography, and the thing somebody wants from
       one is what has happened lately. */
    rows.sort((a, b) => (b.release.sortKey - a.release.sortKey)
      || String(a.w.title).localeCompare(String(b.w.title)));

    if (sub) {
      sub.innerHTML = `${rows.length} ${rows.length === 1 ? 'title' : 'titles'}`
        + (st.identity.olid ? ` · <span class="mono faint">${esc(st.identity.olid)}</span>` : '');
    }

    body.innerHTML = (st.errors.length
        ? `<div class="fwarn">${esc(st.errors.join(' · '))}</div>` : '')
      + (rows.length
          ? `<div class="grid">${rows.map(r => card(r)).join('')}</div>`
          : `<div class="fverdict is-no">No English-language titles found for ${
              esc(st.identity.name || st.identity.gbName)}.</div>`)
      + (st.more
          ? `<div class="fmorewrap"><button class="btn" type="button" id="fwmore"${
              st.loading ? ' disabled' : ''}>${st.loading ? 'Loading…' : 'Show more'}</button></div>`
          : '');
  }

  async function onWorksClick(e) {
    const more = e.target.closest('#fwmore');
    if (more) {
      if (suppressTap()) return;
      more.disabled = true;
      more.textContent = 'Loading…';
      worksState.page++;
      await loadWorksPage();
      return;
    }
    const fb = e.target.closest('[data-follow]');
    if (fb) { if (suppressTap()) return; await onToggle(fb); return; }
    const c = e.target.closest('[data-uid],[data-noopen]');
    if (c) { if (suppressTap()) return; onOpen(c.dataset.uid); }
  }

  /* ══ REFRESHING ════════════════════════════════════════════════════════
     Every button on this page and the automatic pass on entry go through the ONE
     serialized refresher in 70-follows.js. There is no fetch in this file, which
     is the property that stopped the page and the alerts feed disagreeing. */

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
     a spinner. A roster walk is several requests per author, so a reader with
     twenty follows is looking at a minute of work — and "Checking…" for a minute
     is indistinguishable from stuck. */
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
      const head = sec.querySelector('.frow-h');
      if (head) head.outerHTML = rowHead(row);
    }
  }

  /* Scanned and compared rather than selected with an attribute selector: a
     follow id is `author:openlibrary:OL1394865A`, and colons are combinators in
     CSS. Building that into a selector needs CSS.escape and gets it wrong
     silently — a selector that matches nothing throws no error, it just leaves
     the row showing the wrong thing for ever. */
  function sectionEl(id) {
    for (const el of document.querySelectorAll('#froster [data-fsec]')) {
      if (el.dataset.fsec === id) return el;
    }
    return null;
  }

  async function repaintRow(id) {
    dropBands(id);
    const row = await BT.follows.get(id);
    const sec = sectionEl(id);
    if (!sec) return;
    if (!row) { sec.remove(); return; }
    /* Keep the roster's copy of this row current, so the window strip — which
       pools across rosterRows — repaints from the same data the row does. */
    const at = rosterRows.findIndex(f => f.id === id);
    if (at >= 0) rosterRows[at] = row;
    sec.outerHTML = rowHtml(row);
    repaintWindow();
  }

  function repaintWindow() {
    const host = document.getElementById('fwinbody');
    if (host) host.innerHTML = windowBody();
  }

  /* ══ CLICKS ════════════════════════════════════════════════════════════
     One delegated handler for the whole view. Every branch updates the DOM in
     place instead of calling BT.router.resolve(): a full re-render would throw
     away what is typed in the box and the results under it, so following three
     authors from one search would mean typing the search three times. */
  async function onClick(e) {
    const win = e.target.closest('[data-win]');
    if (win) { if (suppressTap()) return; setWindow(win.dataset.win); return; }

    const tg = e.target.closest('[data-ftoggle]');
    if (tg) { if (suppressTap()) return; await toggleRow(tg.dataset.ftoggle); return; }

    const rc = e.target.closest('[data-frecent]');
    if (rc) { if (suppressTap()) return; await toggleRecent(rc.dataset.frecent); return; }

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

    const card = e.target.closest('[data-uid],[data-noopen]');
    if (card) { if (suppressTap()) return; onOpen(card.dataset.uid); }
  }

  /* A tap that followed finger movement is a scroll, not a tap. Browsers fire
     click after a short drag, so on a phone a flick down this page would
     otherwise land on whatever was under the thumb when it lifted — and the
     follow branches above WRITE. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  function setWindow(id) {
    if (!WINDOWS.some(w => w.id === id)) return;
    windowId = id;
    try { localStorage.setItem(WIN_KEY, id); } catch (_) {}
    for (const b of document.querySelectorAll('[data-win]')) {
      b.setAttribute('aria-pressed', b.dataset.win === id ? 'true' : 'false');
    }
    repaintWindow();
  }

  /* EXPANSION IS PERSISTED, and expanding is what clears the badge.

     "(+X new) clears when viewed" — and viewing means opening the row, not
     landing on the page. A reader with twelve follows who scrolls past eleven of
     them has not read eleven authors' news, and marking them seen on arrival
     would empty the sidebar badge for changes nobody has looked at. */
  async function toggleRow(id) {
    if (expanded.has(id)) {
      expanded.delete(id);
      const t = seenTimers.get(id);
      if (t) { clearTimeout(t); seenTimers.delete(id); }
    } else {
      expanded.add(id);
      scheduleSeen(id);
    }
    saveSet(OPEN_KEY, expanded);
    await repaintRow(id);
  }

  async function toggleRecent(id) {
    if (recentOpen.has(id)) recentOpen.delete(id); else recentOpen.add(id);
    saveSet(RECENT_KEY, recentOpen);
    await repaintRow(id);
  }

  /* Marked seen after a beat, not on the click. Marking instantly would clear
     the badge before the eye reaches it; the badge itself stays on screen for
     this visit because `newsAtRender` is a snapshot, so the information does not
     vanish as it is being read. The sidebar is refreshed, because that count and
     this one are the same number counted in the same place. */
  function scheduleSeen(id) {
    if (seenTimers.has(id)) return;
    const t = setTimeout(async () => {
      seenTimers.delete(id);
      if (!pageAlive() || !location.hash.startsWith('#/people')) return;
      if (await BT.follows.markNewsSeen(id) && BT.tree && BT.tree.refresh) BT.tree.refresh();
    }, 2000);
    seenTimers.set(id, t);
  }

  /* ── FOLLOWING SOMEBODY STARTS THEIR ROW IMMEDIATELY ───────────────────
     The row is inserted in the same frame the button is pressed, expanded and in
     the "Checking…" state, and the follow jumps to the FRONT of the refresher
     queue — so a reader who has just followed someone is not behind a roster
     walk of thirty other authors. */
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
       no-op: following by an unverified name is the one thing this feature must
       never do, so the reason is said out loud rather than leaving a button that
       appears broken. */
    if (!res) {
      BT.ui.toast('Open Library has no id for that record, so it cannot be followed reliably.', { bad: true });
      return;
    }
    if (res.following) { followSet.add(res.id); expanded.add(res.id); saveSet(OPEN_KEY, expanded); }
    else followSet.delete(res.id);
    markButtons(res.id, res.following);
    BT.ui.toast(res.following ? `Following ${res.name}` : `Unfollowed ${res.name}`);

    await rebuildRoster();
    if (res.following) refresh({ ids: [res.id], force: true, front: true, reason: 'new follow' });
  }

  async function onUnfollow(id) {
    const gone = await BT.follows.unfollow(id);
    if (!gone) return;
    followSet.delete(id);
    expanded.delete(id);
    saveSet(OPEN_KEY, expanded);
    markButtons(id, false);
    BT.ui.toast('Unfollowed');
    await rebuildRoster();
  }

  /* EVERY button for this follow, not just the one that was pressed. The same
     author can be a search result and a roster row at the same time, and a screen
     that shows "Follow" and "✓ Following" for one person simultaneously reads as
     a bug in the app rather than as two views of one row. */
  function markButtons(id, on) {
    for (const b of document.querySelectorAll('[data-follow]')) {
      if (b.dataset.follow !== id) continue;
      b.classList.toggle('is-in', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = on ? '✓ Following' : 'Follow';
    }
  }

  async function rebuildRoster() {
    dropBands();
    const host = document.getElementById('froster');
    if (!host) return;
    const follows = await BT.follows.all();
    rosterRows = sortRoster(follows);
    followSet = new Set(follows.map(f => f.id));
    for (const f of follows) {
      if (!newsAtRender.has(f.id)) newsAtRender.set(f.id, BT.follows.unseenNews(f).length);
    }
    host.innerHTML = roster(rosterRows);
    repaintWindow();
  }

  /* ══ OPENING A CARD ════════════════════════════════════════════════════
     NOTHING IS WRITTEN HERE. That is the fix: this used to be onAdd(), and it
     called BT.ui.addItem, so browsing an author's catalogue silently filled the
     library with `want` entries.

     No stub is handed over either, and that is deliberate rather than lazy.
     56-inspector already knows how to show a book it does not hold — see
     fetchTransient() — and what it fetches is the WORK record, which carries the
     description and subjects the lean stored row behind this card does not. So
     one deliberate tap costs one deliberate request and buys a better pane than
     the shortcut would have, with an explicit "Add to library" button on it
     instead of an add that already happened. */
  function onOpen(uid) {
    if (!uid) {
      /* A Google-only volume with no ISBN. There is no uid the pane can resolve,
         and opening an empty one would look like a failure of the app rather
         than a gap in the record. */
      BT.ui.toast('No catalogue record to open for this one yet.');
      return;
    }
    if (!BT.inspector || typeof BT.inspector.show !== 'function') return;
    BT.inspector.show(uid);
  }

  /* ── The writes from elsewhere this page has to hear ───────────────────
     Subscribed ONCE at module scope. This module is a singleton whose render()
     runs again on every visit, and subscribing there would stack one more copy of
     this handler per visit.

     Note what is NOT listened for: `follow:change`. The refresher writes a follow
     row on every check, so repainting on it would rebuild the whole page once per
     author during a roster walk. `follows:updated` carries the same news with the
     id attached, which is what lets one row repaint alone. */
  function subscribeOnce() {
    if (subscribed || !BT.repo || typeof BT.repo.subscribe !== 'function') return;
    subscribed = true;
    BT.repo.subscribe((ev, detail) => {
      if (!location.hash.startsWith('#/people')) return;

      if (ev === 'follows:updated' && detail && detail.id) {
        pendingIds.delete(detail.id);
        repaintRow(detail.id).catch(e => console.warn('[people] repaint', e));
        return;
      }

      if (ev === 'follows:progress' && detail) {
        setRefreshAllBusy(!!detail.running);
        return;
      }

      if (!detail) return;

      /* Undo. BT.ui.addItem's toast offers it and it lands here, so a work left
         in `addedHere` would leave the card claiming "In your library" for a book
         that is no longer in it. */
      if (ev === 'item:delete') {
        const w = BT.util.olid(detail.uid || '');
        if (w) { addedHere.delete(w); ownedWorks.delete(w); dropBands(); markCard(w); }
        return;
      }

      if (ev !== 'item:put') return;
      const work = (detail.ids && detail.ids.olWork) || '';
      if (!work || addedHere.has(work)) return;
      /* Only books this page is showing. Every write anywhere in the app emits
         this — a rating, a status change, a background hydrate — and marking a
         card off the back of one would be a claim this screen has no evidence
         for. */
      if (!onScreen(work)) return;
      addedHere.add(work);
      ownedWorks.add(work);
      dropBands();
      markCard(work);
    });
  }

  function onScreen(workId) {
    const uid = 'book:openlibrary:' + workId;
    for (const el of document.querySelectorAll('.card[data-uid]')) {
      if (el.dataset.uid === uid) return true;
    }
    return false;
  }

  function markCard(workId) {
    const uid = 'book:openlibrary:' + workId;
    const owned = addedHere.has(workId);
    for (const el of document.querySelectorAll('.card[data-uid]')) {
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
