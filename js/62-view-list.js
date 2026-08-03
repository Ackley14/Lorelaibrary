/* ══════════════════════════════════════════════════════════════════════════
   #/library — the dense default view, and the app's front door.

   Ported from MovieTrak's list, which had exactly one job: read a shelf at
   speed. This one has two, and they pull against each other. The second is
   BULK EDITING — the machinery behind the to-sell pile — and a list you can
   edit twenty rows of at once is not the same object as a list you scan down.

   The resolution is a MODE. Until you press Select nothing about this screen
   has changed: one click on a row opens the inspector, the row markup is the
   same markup, and the checkboxes do not exist. Press Select and the same rows
   answer to different clicks. Anything subtler — checkboxes on hover, a long
   press, a modifier key — makes a destructive action reachable by accident on
   a screen whose whole purpose is fast scrolling.

   The selection machinery itself is deliberately generic and lives in
   50-ui-core (`BT.ui.selection`), because the pile is only its first customer:
   bulk tagging and bulk status edits want the same "some rows are picked"
   state, and three copies of a Set would be three chances for the bar to
   disagree with the checkboxes.

   Everything drawn here comes out of 50-ui-core. This file decides WHICH books
   and IN WHAT ORDER; it never hand-rolls a cover, a date, a genre chip or a
   progress bar, and — like every view — it never touches BT.db.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewLibrary = (function () {
  const esc = BT.util.escapeHtml;
  const MODE_KEY = 'bt.library.mode';

  /* ══ SORTING ══════════════════════════════════════════════════════════════ */

  const byTitle = (a, b) => (a.sortTitle || '').localeCompare(b.sortTitle || '');

  /* Never read `release.sortKey` bare. An item written before the date engine
     existed, or one merged in from another device mid-schema-change, can arrive
     without a release block at all — and `undefined - undefined` is NaN, which
     does not throw, does not sort, and silently scrambles the whole list. */
  const pubKey = it => {
    const k = it.release && it.release.sortKey;
    return typeof k === 'number' ? k : BT.util.SK_UNKNOWN;
  };

  /* The genre a book is FILED under, as opposed to the genres it matches. A
     well-catalogued novel matches three or four buckets; the divider can only
     draw one, so it takes the first, which normalize puts in specificity order
     (see BT.GENRE_RULES — the first rule that hits wins, and the specific
     buckets are tested first). */
  const bucketOf = it => BT.ui.genresOf(it)[0] || 'general';
  const bucketRank = it => {
    const i = BT.GENRE_BUCKETS.indexOf(bucketOf(it));
    return i < 0 ? BT.GENRE_BUCKETS.length : i;   // unknown bucket sorts last
  };

  /* Progress does NOT sort straight down the percentage, and the reason is the
     question the sort is actually asked. "Sort by progress" means "what am I
     closest to finishing", and a plain descending sort answers that with a
     wall of finished books — every one of them 100%, none of them the answer.
     So: in flight first, ordered by how far in, then unstarted, then done.

     BT.ui.progressFraction returns 1 for a finished book with no page recorded,
     which is correct there and is exactly what rank 2 exists to catch. */
  const progressRank = it => {
    const f = BT.ui.progressFraction(it);
    if (f == null || f <= 0) return 1;            // not started
    if (f >= 1) return 2;                         // done
    return 0;                                     // in flight
  };
  const progressFrac = it => BT.ui.progressFraction(it) || 0;

  const SORTS = {
    added:     { label: 'Recently added', fn: (a, b) => (b.user.addedAt || 0) - (a.user.addedAt || 0) },
    title:     { label: 'Title',          fn: byTitle },
    published: { label: 'Published',      fn: (a, b) => pubKey(a) - pubKey(b) },
    rating:    { label: 'Your rating',    fn: (a, b) => (b.user.rating || -1) - (a.user.rating || -1) },
    progress:  { label: 'Progress',
                 fn: (a, b) => (progressRank(a) - progressRank(b))
                            || (progressFrac(b) - progressFrac(a))
                            || byTitle(a, b) },
    /* Sorting by genre without also DRAWING the divisions just produces a list
       that looks arbitrarily ordered, so this sort is the one that groups. */
    genre:     { label: 'Genre', group: true,
                 fn: (a, b) => (bucketRank(a) - bucketRank(b)) || byTitle(a, b) },
  };

  function groupOpts(sort) {
    if (!(SORTS[sort] || {}).group) return null;
    return { groupBy: it => BT.GENRE_LABELS[bucketOf(it)] || 'General' };
  }

  /* ══ MODE ═════════════════════════════════════════════════════════════════
     Table or covers, remembered per browser. Table is the default because it
     is the only one of the two that shows a publication date, a status and a
     page position at once — the grid is for recognising a spine, the table is
     for reading a shelf. */
  const mode = () => { try { return localStorage.getItem(MODE_KEY) || 'table'; } catch (_) { return 'table'; } };
  const setMode = m => { try { localStorage.setItem(MODE_KEY, m); } catch (_) {} };

  /* ══ SELECTION STATE ══════════════════════════════════════════════════════
     Three pieces of module state, and only three:

       selecting  is the mode on
       order      the uids currently on screen, in visual order — the shift-click
                  range is a slice of this, so it has to be the RENDERED order
                  and not the library's
       anchor     index into `order` of the last row clicked, which is what a
                  range is measured from

     The picked set itself lives in BT.ui.selection and is never mirrored here.
     A local copy would be one more thing that can disagree with the checkboxes. */
  let selecting = false;
  let order = [];
  let anchor = -1;
  let unsubSel = null;      // BT.ui.selection.onChange's unsubscribe
  let busy = false;         // a bulk write is in flight
  let wiredGlobal = false;

  /* ══ RENDER ═══════════════════════════════════════════════════════════════ */

  async function render(params, query) {
    wireGlobal();
    const view = document.getElementById('view');
    const q = query || {};
    const all = await BT.repo.allItems();

    if (!all.length) return firstRun(view);

    let rows = all.slice();

    /* ── Filters ────────────────────────────────────────────────────────────
       Every one of these mirrors a route that 55-tree.js emits. If a name here
       and a name there ever drift apart the tree does not error — it opens an
       empty list, which reads as "you own nothing in this genre" and is the
       most convincing wrong answer the app can give. The tree's own
       FILTER_PARAMS['/library'] is the checklist: status, genre, format, tag,
       pile. */
    if (q.status) rows = rows.filter(i => i.user.status === q.status);

    /* Genre matches the INDEXED ids rather than a single bucket, so a novel
       filed as both Fantasy & SF and Fiction appears under both — which is what
       a reader browsing "Fiction" expects, and what the record actually says.

       Worth knowing: the tree counts each book ONCE (its primary bucket), so a
       genre row's count can be smaller than the list it opens. That is the
       honest pair of answers to two different questions — "how much of my
       library is this" versus "show me everything that is this" — and the
       alternative, filtering on the primary bucket only, hides books from the
       shelf they genuinely belong to. */
    if (q.genre) rows = rows.filter(i => genreIdsOf(i).indexOf(q.genre) >= 0);

    /* Format and pile are filtered client-side over the whole library because
       neither is an IndexedDB index — the same call made in MovieTrak for
       facets.anime. Both are low-cardinality flags on a store the app already
       holds entirely in memory for this screen, so an index would cost a write
       on every put to save a pass over an array we have already walked. */
    if (q.format) rows = rows.filter(i => BT.ui.formatOf(i) === q.format);
    if (q.pile) rows = rows.filter(i => (i.user.pile || null) === q.pile);

    if (q.tag) rows = rows.filter(i => (i.user.tags || []).indexOf(q.tag) >= 0);

    /* The tree files "No date set" under #/up, where the timeline can say
       something useful about it. The param is honoured here too so that a
       hand-typed or bookmarked #/library?undated=1 is not a dead end. */
    if (q.undated) rows = rows.filter(i => pubKey(i) >= BT.util.SK_UNKNOWN);

    /* ── THE SOLD RULE ──────────────────────────────────────────────────────
       A sold book has left your shelf, so the default view does not list it. A
       library that keeps showing books you no longer own has stopped describing
       your shelves and started describing your purchase history.

       Excluded, never deleted, and that distinction is the whole point: the
       record survives, `?pile=sold` still lists it, the tree still counts it,
       and it still counts toward pages read and books finished. You read it.
       Selling it afterwards does not unread it.

       Gated on `q.pile` being ABSENT rather than on it being 'sold', so a
       future pile value inherits the behaviour without another line here — and
       so that `?pile=sell` is a clean "what am I about to get rid of" list
       rather than one quietly padded with what already went. */
    if (!q.pile) rows = rows.filter(i => (i.user.pile || null) !== 'sold');

    const sort = q.sort || 'added';
    rows.sort((SORTS[sort] || SORTS.added).fn);

    const [section, label] = crumbFor(q);
    BT.ui.crumb([section, label]);

    BT.ui.paneActions(`
      <button class="chip" type="button" id="selBtn" aria-pressed="${selecting}">Select</button>
      <div class="seg" id="modeSeg">
        <button type="button" data-mode="table" aria-pressed="${mode() === 'table'}">Table</button>
        <button type="button" data-mode="grid" aria-pressed="${mode() === 'grid'}">Covers</button>
      </div>`);

    const cur = BT.inspector.current;
    view.innerHTML = `
      <div class="toolbar">
        <div class="chips" id="statusChips">
          ${[['', 'All'], ['want', 'Want'], ['reading', 'Reading'],
             ['finished', 'Finished'], ['dropped', 'Dropped']].map(([k, l]) =>
            `<button class="chip" type="button" data-status="${k}" aria-pressed="${(q.status || '') === k}">${l}</button>`).join('')}
        </div>
        <div class="seg" id="pileSeg">
          ${[['', 'Any'], ['sell', 'To sell'], ['sold', 'Sold']].map(([v, l]) =>
            `<button type="button" data-pile="${v}" aria-pressed="${(q.pile || '') === v}">${l}</button>`).join('')}
        </div>
        <div class="spacer"></div>
        ${selecting ? '<button class="chip" type="button" id="selAll">Select all</button>' : ''}
        <span class="count">${rows.length} of ${all.length}</span>
        <select id="sortSel" class="chip" aria-label="Sort by">
          ${Object.entries(SORTS).map(([k, v]) =>
            `<option value="${k}"${k === sort ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
      ${rows.length
        ? (mode() === 'grid'
            ? BT.ui.grid(rows, cur, groupOpts(sort))
            : BT.ui.table(rows, cur, groupOpts(sort)))
        : BT.ui.emptyState({
            title: 'Nothing here',
            body: `No books match <b>${esc(label)}</b>. Try a different shelf in the index on the left, or clear the filter.`,
            actions: '<a class="btn" href="#/library">All books</a>',
          })}`;

    order = rows.map(r => r.uid);
    decorate(view, rows);
    wire(view, q, sort);

    /* Drop anything that has scrolled out of existence rather than out of view:
       mark eight books sold, the list re-renders without them, and a selection
       still holding their uids would let the next press of Keep resurrect eight
       rows nobody can see. `retain` is the selection helper's answer to exactly
       this, and it fires a change so the bar re-counts itself. */
    BT.ui.selection.retain(order);
    view.classList.toggle('is-selecting', selecting);
    paintChecks();
    paintBar();
  }

  /* The indexed ids are the fast path and the correct one, but `idx` is written
     by BT.repo on put — a record restored from an older export, or one built by
     a view before it has been saved, may not have been through that yet. Falling
     back to the record's own genres means such a book is filed rather than
     invisible. */
  function genreIdsOf(it) {
    const idx = (it.idx && it.idx.genreIds) || null;
    return (idx && idx.length) ? idx : BT.ui.genresOf(it);
  }

  /* The breadcrumb's first word mirrors the SECTION of the tree the route lives
     in, not the route's path — piles and dates hang off "Shelf" over there, and
     a crumb that said "Library" for them would contradict the thing the reader
     just clicked. */
  function crumbFor(q) {
    if (q.tag) return ['Tags', '#' + q.tag];
    if (q.pile) return ['Shelf', BT.ui.PILE_WORD[q.pile] || q.pile];
    if (q.undated) return ['Shelf', 'No date set'];
    if (q.status) return ['Library', BT.ui.STATUS_WORD[q.status] || q.status];
    if (q.genre) return ['Library', BT.GENRE_LABELS[q.genre] || q.genre];
    if (q.format) return ['Library', BT.ui.FORMAT_LABEL[q.format] || q.format];
    return ['Library', 'All books'];
  }

  /* ══ ROW DECORATION ═══════════════════════════════════════════════════════
     Two marks that belong to THIS screen rather than to the row: the selection
     checkbox and the open-scope cue. Both are added to the rendered DOM instead
     of being threaded through BT.ui.table/grid as options, and that is a
     deliberate seam — ui-core owns what a book looks like everywhere in the
     app, and "there is a bulk edit in progress on the library screen" is not a
     fact about a book. The inspector, the search results and the pile view all
     render the same rows and none of them wants a checkbox.

     Cheap, too: one pass over the nodes we just created, no re-parse. */

  const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4.5 12.5l5 5.5L19.5 6.5"/></svg>';

  function decorate(view, rows) {
    const byUid = new Map(rows.map(r => [r.uid, r]));
    for (const el of view.querySelectorAll('[data-uid]')) {
      const it = byUid.get(el.dataset.uid);
      if (!it) continue;
      /* In the table the marks live inside the title cell's flex row; in the
         grid the card itself is the container. `.title-cell || el` picks the
         right one without the caller having to know which mode drew this. */
      const host = el.querySelector('.title-cell') || el;

      host.insertAdjacentHTML('afterbegin',
        '<button type="button" class="rowsel" role="checkbox" aria-checked="false"'
        + ' aria-label="Select this book">' + TICK + '</button>');

      /* ── Edition not specified ──────────────────────────────────────────
         An `open` item is the WORK: the reader said "Dune", not "the 1990 Ace
         paperback". Its page count, cover and publisher are whichever edition
         Open Library happened to surface, and printings genuinely disagree —
         412, 535 and 658 pages for the same novel. Marking it costs one faint
         glyph, and NOT marking it presents a guess as a fact.

         Deliberately a hairline diamond and not a warning: most of a
         search-built library is open scope, and a library where every row
         carries an alert has no alerts. The tooltip carries the sentence. */
      if (it.scope !== 'closed') {
        host.insertAdjacentHTML('beforeend',
          '<span class="faint" style="font-size:9px;line-height:1" title="'
          + esc('Edition not specified — page count, cover and publisher belong to the work, not to a copy you chose')
          + '" aria-hidden="true">◇</span>');
      }
    }
  }

  /* ══ WIRING ═══════════════════════════════════════════════════════════════ */

  function wire(view, q, sort) {
    const go = patch => {
      const next = Object.assign({}, q, patch);
      const parts = [];
      for (const [k, v] of Object.entries(next)) if (v) parts.push(`${k}=${encodeURIComponent(v)}`);
      BT.router.go('#/library' + (parts.length ? '?' + parts.join('&') : ''));
    };

    const chips = document.getElementById('statusChips');
    if (chips) chips.onclick = e => {
      const b = e.target.closest('[data-status]');
      if (b) go({ status: b.dataset.status || '' });
    };

    const pile = document.getElementById('pileSeg');
    if (pile) pile.onclick = e => {
      const b = e.target.closest('[data-pile]');
      if (b) go({ pile: b.dataset.pile || '' });
    };

    const sel = document.getElementById('sortSel');
    /* 'added' is the default, so it travels as an ABSENT param rather than as
       `sort=added`. Otherwise the tree's routeMatches sees a query pair the
       node does not have and stops highlighting the row you are standing on. */
    if (sel) sel.onchange = () => go({ sort: sel.value === 'added' ? '' : sel.value });

    const seg = document.getElementById('modeSeg');
    if (seg) seg.onclick = e => {
      const b = e.target.closest('[data-mode]');
      if (b) { setMode(b.dataset.mode); BT.router.resolve(); }
    };

    const selBtn = document.getElementById('selBtn');
    if (selBtn) selBtn.onclick = () => {
      if (selecting) { exitSelection(); return; }
      selecting = true;
      anchor = -1;
      selBtn.setAttribute('aria-pressed', 'true');
      view.classList.add('is-selecting');
      /* Re-render rather than toggle in place: the toolbar gains Select all,
         and the row shift the checkboxes cause is the clearest possible signal
         that the list now answers to different clicks. */
      BT.router.resolve();
    };

    const all = document.getElementById('selAll');
    if (all) all.onclick = () => {
      /* One change event for the whole list — `replace` exists so selecting
         four hundred rows does not fire four hundred re-counts of the bar. */
      BT.ui.selection.replace(order);
      anchor = order.length - 1;
    };

    /* Shift-clicking through twenty rows drags a text selection across the
       whole table unless the mousedown is cancelled. Assignment, not
       addEventListener — see the note on view.onclick below. */
    view.onmousedown = e => {
      if (selecting && e.shiftKey && e.target.closest('[data-uid]')) e.preventDefault();
    };

    view.onclick = e => {
      /* Assignment, never addEventListener. #view outlives every route change,
         so a listener bound here stayed alive on OTHER routes: after one visit
         to the library, a tap on a search row ran this handler too and opened
         the inspector — including taps on the Add button, which raced its own
         await and rendered "Add to index" for a title just added. Assignment
         also cannot stack up, and this ran on every re-render. */
      const row = e.target.closest('[data-uid]');

      /* Selection mode is checked FIRST and returns, which is what keeps the
         two behaviours from ever running together. Note that this also swallows
         the click on .rowsel itself — the checkbox needs no handler of its own,
         because a click anywhere on the row means the same thing here. */
      if (selecting && row) { pick(row.dataset.uid, e.shiftKey); return; }

      if (e.target.closest('button, a, input, select, textarea, label')) return;
      if (row) BT.inspector.show(row.dataset.uid);
    };

    /* One subscription at a time. onChange hands back an unsubscribe for
       exactly this reason: render() runs on every filter change, and a
       subscription per render would repaint the bar once per visit to the
       screen — invisible until the counts started arriving out of order. */
    if (unsubSel) unsubSel();
    unsubSel = BT.ui.selection.onChange(() => { paintChecks(); paintBar(); });

    void sort;
  }

  /* Toggle one row, or extend from the anchor when Shift is held.

     The range is the point of the whole feature. Clearing a shelf means picking
     out a run of twenty books that are next to each other precisely because you
     just sorted them that way, and clicking twenty checkboxes is the tedium
     this is meant to remove. A range ADDS rather than toggles: dragging a
     selection over rows that are already picked must never un-pick them, which
     is what a naive toggle-per-row does on the second pass. */
  function pick(uid, shift) {
    const i = order.indexOf(uid);
    if (i < 0) return;
    const s = BT.ui.selection;

    if (shift && anchor >= 0 && anchor < order.length) {
      const lo = Math.min(anchor, i);
      const hi = Math.max(anchor, i);
      const next = new Set(s.all());
      for (let n = lo; n <= hi; n++) next.add(order[n]);
      s.replace([...next]);
      /* The anchor deliberately does NOT move on a shift-click, so a second
         shift-click somewhere else re-measures from the same origin instead of
         chaining off wherever the last range happened to end. */
      return;
    }
    s.toggle(uid);
    anchor = i;
  }

  /* ══ THE BAR ══════════════════════════════════════════════════════════════
     Lives on .list-pane rather than inside #view, because it is pinned to the
     bottom of the PANE (see .list-pane's position:relative in 03-components).
     Inside the scroller it would either scroll away with the rows or need a
     sticky footer inside a table, and on a wide window a viewport-pinned bar
     would float across the inspector.

     It is built and destroyed rather than hidden, so `.selectbar`'s slide-up
     animation plays on appearance; the count is rewritten in place, which is
     why the element is reused while it is up. */
  function paintBar() {
    const pane = document.querySelector('.list-pane');
    if (!pane) return;
    const n = BT.ui.selection.size();
    let bar = document.getElementById('selectbar');

    if (!n) { if (bar) bar.remove(); return; }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selectbar';
      bar.className = 'selectbar';
      bar.onclick = onBar;
      pane.appendChild(bar);
    }
    bar.innerHTML = `
      <span class="n">${n}</span>
      <span class="lbl">${n === 1 ? 'book selected' : 'books selected'}</span>
      <div class="spacer"></div>
      <div class="acts">
        <button class="btn btn--sm" type="button" data-bulk="sell">Mark to sell</button>
        <button class="btn btn--sm" type="button" data-bulk="sold">Mark sold</button>
        <button class="btn btn--sm" type="button" data-bulk="keep">Keep</button>
        <button class="btn btn--sm btn--ghost" type="button" data-bulk="clear">Clear selection</button>
      </div>`;
  }

  async function onBar(e) {
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const act = b.dataset.bulk;

    if (act === 'clear') { BT.ui.selection.clear(); anchor = -1; return; }

    const uids = BT.ui.selection.all();
    if (!uids.length) return;

    /* A double-tap on a bar button would run the batch twice, and the second
       run would record the FIRST run's values as the "before" state — so its
       Undo would restore thirty books to the pile they were briefly moved to
       rather than the one they came from. One batch at a time. */
    if (busy) return;
    busy = true;
    try {
      /* ONE call for the whole batch. BT.ui.bulkSetPile writes quietly, emits a
         single change, and raises a single toast with a single Undo that
         restores each book's OWN previous pile. Looping setPile() here instead
         would stack thirty toasts over the list they describe, each with an
         Undo that reverses one book — which reads, correctly, as Undo being
         broken. */
      await BT.ui.bulkSetPile(uids, act === 'keep' ? null : act);
    } finally {
      busy = false;
    }
    BT.ui.selection.clear();
    anchor = -1;
    /* bulkSetPile suppresses its per-item events on purpose, so the screen it
       just changed is ours to refresh — once, here, rather than once per book. */
    BT.router.resolve();
  }

  function paintChecks() {
    const s = BT.ui.selection;
    for (const el of document.querySelectorAll('#view [data-uid]')) {
      const on = s.has(el.dataset.uid);
      el.classList.toggle('is-checked', on);
      const box = el.querySelector('.rowsel');
      if (box) box.setAttribute('aria-checked', String(on));
    }
  }

  function exitSelection() {
    selecting = false;
    anchor = -1;
    BT.ui.selection.clear();
    /* clear() only fires when something was actually picked, so the bar is
       removed here as well — leaving selection mode with nothing selected must
       still tear down anything left on screen. */
    const bar = document.getElementById('selectbar');
    if (bar) bar.remove();
    const view = document.getElementById('view');
    if (view) view.classList.remove('is-selecting');
    const btn = document.getElementById('selBtn');
    if (btn) btn.setAttribute('aria-pressed', 'false');
  }

  /* Bound once, ever. Both of these have to survive #view being replaced and
     have to fire on screens this module never renders — a selection that
     outlived a navigation to Search would leave a bar pinned over somebody
     else's view with actions aimed at rows that are no longer there. */
  function wireGlobal() {
    if (wiredGlobal) return;
    wiredGlobal = true;

    window.addEventListener('hashchange', () => {
      const path = BT.router.parse().path;
      const stillHere = path === '/' || path === '/library';
      /* Staying on the library keeps the MODE and drops the PICKS: changing
         shelf mid-clear-out is normal, and re-pressing Select every time would
         be its own tedium. Leaving the library tears the whole thing down. */
      if (stillHere) { BT.ui.selection.clear(); anchor = -1; }
      else exitSelection();
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!selecting && !BT.ui.selection.size()) return;
      exitSelection();
    });
  }

  /* ══ FIRST RUN ════════════════════════════════════════════════════════════
     The empty library. MovieTrak's version of this screen was mostly an
     apology: it could not search at all until the reader had gone to another
     website, made an account and pasted a TMDB key back in, so two thirds of
     its first run was that errand.

     BookTrak has no errand. Open Library is keyless — no signup, no quota page,
     nothing to configure — so this screen can be what a first run should be:
     what the thing is, and the shortest path to having one book in it. The
     optional Google Books key is deliberately not mentioned; it enriches
     descriptions and nothing here depends on it, and offering a key on the
     first screen would re-create exactly the impression this app gets to
     avoid. */
  function firstRun(view) {
    exitSelection();
    BT.ui.crumb(['Library']);
    BT.ui.paneActions('');
    view.innerHTML = `
      <div class="firstrun">
        <h1>Everything you mean<br>to read, on one shelf.</h1>
        <p class="lede">Books you want, books you are in the middle of, and books you have finished —
        with publication dates that never pretend to know more than the catalogue does, page positions
        taken from the copy in your hand, and a pile for the ones you are ready to part with.</p>

        <ol>
          <li>Press <kbd>/</kbd> to jump to the index filter, or open <a href="#/search">Search</a>.</li>
          <li>Type a title or an author — Open Library needs no key and no account, so this works now.</li>
          <li>Press <kbd>⏎</kbd> to add the top result, or <a href="#/scan">scan a barcode</a> to add the
              exact printing on your shelf.</li>
        </ol>
        <p style="margin-top:var(--bt-space-6)" class="actions">
          <a class="btn btn--primary" href="#/search">Find a book</a>
          <a class="btn" href="#/scan">Scan one</a>
        </p>

        <div class="warnbox" style="margin-top:var(--bt-space-7)">
          <strong>Searching adds the book, not the edition</strong>
          A search result is the work — “Dune”, not the 1990 Ace paperback — because printings of the
          same book disagree about page count, cover, publisher and ISBN. Scanning a barcode names one
          printing, and you can pin an edition to any book later from its page.
        </div>

        <div class="warnbox" style="margin-top:var(--bt-space-5)">
          <strong>Your library lives in the repository, not in this browser</strong>
          It is encrypted here before it is saved, so anyone can read the file and nobody can read your
          shelves. Sign in with the same passphrase on any device and you get the same single library.
          This browser keeps a working copy for speed, which is what makes it usable offline.
        </div>
      </div>`;
  }

  return { render };
})();
