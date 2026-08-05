/* ══════════════════════════════════════════════════════════════════════════
   Pane 1 — the index tree. This is the app's navigation.

   Every destination in BookTrak is a node here, so the tree is built from live
   counts rather than a static list: statuses, genres, formats and shelves are
   recomputed on every render, and the tag section exists only while there are
   tags. Route state drives selection, never the other way round, so a hash
   typed by hand or restored from a bookmark still highlights correctly.
   ══════════════════════════════════════════════════════════════════════════ */

BT.tree = (function () {
  const esc = BT.util.escapeHtml;
  const OPEN_KEY = 'bt.tree.open.v1';
  let open = load();
  let nodes = [];          // flat, in visual order — the keyboard's world
  let focusIdx = -1;
  let leafIdx = 0;
  let filterText = '';

  function load() {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function persist() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch (_) {}
  }
  const isOpen = id => open[id] !== 0;   // default open

  const CARET = '<span class="tri"><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 4l4 4 4-4z"/></svg></span>';
  const NOCARET = '<span class="tri void"></span>';

  /* The bucket a book counts toward — its PRIMARY one. ui-core owns the single
     definition of what a record's genres are, and 62-view-list.js reads it the
     same way (`BT.ui.genresOf(it)[0]`), which is the contract the two screens
     have to share: the tree counts each book once, under the most specific
     bucket that matched, while the list matches every indexed id. So a genre
     row's count can be smaller than the list it opens, on purpose — "how much
     of my library is this" and "show me everything that is this" are different
     questions.

     THE NAME IS THE WHOLE BUG THIS LINE ONCE HAD. It read
     `BT.ui.genreOf ? BT.ui.genreOf(it) : ((it.facets && it.facets.genre) ||
     'general')`, and ui-core exports `genresOf`, plural — there has never been
     a `genreOf`. A missing function on the left of a ternary does not throw, it
     just quietly takes the other branch for ever, and that branch read
     `facets.genre`: a MovieTrak-era field BookTrak has never written. So every
     book in the library fell through to `general`, and By genre showed
     "General 214" with a zero against all six real buckets — a tree whose
     numbers do not add up to "All books", which is exactly what the comment
     here claimed to be preventing. Same failure mode as the viewList/viewLibrary
     mismatch 90-boot.js documents: a name that does not match does not fail
     loudly, it silently disables the feature.

     No fallback branch any more. genresOf already guarantees a non-empty array
     (it returns ['general'] when a record carries nothing it recognises), so a
     second layer of defence here could only ever hide the next rename. */
  const bucketOf = it => BT.ui.genresOf(it)[0] || 'general';

  /* `unspecified` is the honest default for anything added from search, where
     the work is tracked and no edition has been chosen yet (scope 'open'). */
  const formatOf = it => (it.facets && it.facets.format) || 'unspecified';

  /* One reading of each axis, ui-core's. The fallback matters for the same
     reason bucketOf's does: a record whose values this build does not
     recognise — an older export, a device mid-schema-change, a row the
     migration sweep has not reached — must still land on a shelf. It counts as
     `want` / `unread`, the two values that claim the least, rather than
     vanishing from every row while still counting toward "All books", because
     a tree whose numbers do not add up is a tree nobody trusts. Nothing is
     written: these are display readings, and the stored values are left
     alone. */
  const ownershipOf = it => (BT.ui && BT.ui.ownershipOf ? BT.ui.ownershipOf(it) : 'want');
  const readingOf = it => (BT.ui && BT.ui.readingOf ? BT.ui.readingOf(it) : 'unread');

  /* Rows for the three formats a reader actually distinguishes. `unspecified`
     deliberately has NO row: for most libraries it is the largest group by far
     and selecting it answers no question — "books I have not yet said how I
     own" is a data-entry report, not a shelf. */
  const FORMATS = [
    ['physical', 'Physical'],
    ['ebook', 'Ebook'],
    ['audiobook', 'Audiobook'],
  ];

  /* Sign-in is the M5 encryption gate. The row and its route exist from M1 so
     the destination is never a dead end, but the module behind it may not be
     on the page yet — hence the defensive ask rather than a bare call. */
  const signedIn = () => !!(BT.crypto && BT.crypto.isUnlocked && BT.crypto.isUnlocked());

  /* ── THE FOLLOWING ROW COUNTS NEWS, NOT PEOPLE ────────────────────────
     It used to show `follows.length`, which is a number that does not change
     and therefore says nothing: a reader who follows eight authors sees "8"
     for ever, and the row is decoration. The user asked for the other number —
     "show the number of different items not the number of authors to act as an
     alert of sorts that 'hey there's news here!'".

     So: the BADGE (a filled teal pill, the same one Activity uses for unread)
     carries the count of works that were newly listed or whose year changed
     since the reader last looked at that author. When there is none, the row
     falls back to the plain follow count — renderNode treats a badge of 0 as
     absent, which is exactly the behaviour wanted here. Two different marks for
     two different facts: `.badge` means "there is something to see", `.n` means
     "this is how many you follow".

     COUNTED IN 70-follows.js, not here. The seen-marker lives on the follow row
     and the sections on #/people count it the same way; a second copy of the
     rule in this file would be free to drift, and then the sidebar and the page
     would disagree about how much news there is with no way to tell which was
     right. Feature-detected because 70 may be absent or have failed to parse,
     in which case the row degrades to the count it always showed. */
  function followNews(follows) {
    const f = BT.follows;
    if (!f || typeof f.unseenCount !== 'function') return 0;
    try { return f.unseenCount(follows); } catch (_) { return 0; }
  }

  async function build() {
    const items = await BT.repo.allItems();
    /* Publisher follows are retired (see 70-follows.js retirePublisherFollows).
       Counted out here as well as deleted on disk, so a row syncing in from a
       device still on the old build cannot inflate the number next to a screen
       that will not show it. */
    const follows = (await BT.repo.allFollows()).filter(f => f && f.type === 'author');
    const unread = await BT.repo.unreadCount();

    /* Two tallies now, not one, because a book is counted on BOTH axes: it has
       an ownership and it has a reading state. That is why these two objects
       each sum to the library total on their own and why the two groups below
       do not add up to each other — which is the correct answer to two
       different questions, and is exactly what one flat ladder could not
       express. */
    const byOwnership = { want: 0, own: 0, dontown: 0 };
    const byReading = { unread: 0, reading: 0, finished: 0, dnf: 0 };
    const byGenre = {};
    const byFormat = {};
    const byPile = { sell: 0, sold: 0 };
    const tags = new Map();
    const today = BT.util.todaySortKey();
    let undated = 0;
    let upcoming = 0;

    for (const it of items) {
      const own = ownershipOf(it);
      byOwnership[own] = (byOwnership[own] || 0) + 1;
      const rd = readingOf(it);
      byReading[rd] = (byReading[rd] || 0) + 1;
      const g = bucketOf(it);
      byGenre[g] = (byGenre[g] || 0) + 1;
      const f = formatOf(it);
      byFormat[f] = (byFormat[f] || 0) + 1;
      /* Ownership is a separate axis from reading: a book can be finished and
         still on the sell pile, or unread and already sold. `pile` is null for
         almost everything, so only the two real values are counted.

         `user` is read defensively for exactly the reason `release` is, twelve
         lines down, and this pair of lines was the last place that did not:
         BT.repo.putItem heals a missing `user` block, but importAll writes
         through BT.db.putMany and bypasses the heal, and absorbSynced hands a
         new uid's record straight through. One imported or hand-edited row
         without a `user` block therefore threw here — and since this build runs
         from startApp() before BT.router.start(), the throw took the ROUTER
         with it: blank shell, every route inert, Settings (and with it Export
         and Erase) unreachable, recoverable only by clearing site data, which
         destroys the library. One unguarded property read was the whole
         difference between a bricked app and a tree row counted wrong. */
      const u = it.user || {};
      if (u.pile) byPile[u.pile] = (byPile[u.pile] || 0) + 1;
      for (const t of (u.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);

      /* Same reading of the date as #/up uses, or the number on the row
         disagrees with the length of the list it opens. Order matters here:
         SK_UNKNOWN sorts above every real key, so "no date" has to be tested
         before "in the future" or every undated book is also upcoming.

         `release` is read defensively because it is genuinely optional: 12-repo
         (`item.release && …` in normalizeIndexable) and 38-normalize
         (withDefaults stamps `user` and `tracking` but NOT `release`) both
         treat it that way, and this line was the only place in the app that
         did not. A record without one is then a record with no known date,
         which is exactly what SK_UNKNOWN means — so the missing field has an
         honest answer and does not need to be an exception. It does need to not
         throw: this loop builds the index tree, which is the app's whole
         navigation, so one malformed row taking it out leaves every shelf
         unreachable rather than mis-counted by one. */
      const sk = (it.release && it.release.sortKey) != null
        ? it.release.sortKey : BT.util.SK_UNKNOWN;
      if (sk >= BT.util.SK_UNKNOWN) undated++;
      else if (sk >= today) upcoming++;
    }

    return [
      { id: 'library', label: 'Library', children: [
        { id: 'all', label: 'All books', route: '#/library', n: items.length },
        /* TWO GROUPS, NOT ONE FLAT LADDER, and they are groups rather than a
           second run of top-level rows for the same reason By genre is: the
           heading is what tells the reader these five rows answer one question
           and those four answer a different one. Flat, "Own" and "Unread" sit
           adjacent and read as two rungs of one scale, which is the exact
           confusion the split was made to end.

           Every route name here has to match 62-view-list's filter names
           exactly. A drift does not error — it opens an empty list, which
           reads as "you own nothing" and is the most convincing wrong answer
           this app can give. Both sides take their vocabulary from
           BT.ui.OWNERSHIPS / BT.ui.READINGS for that reason.

           Ordered by the vocabulary arrays rather than typed out, so the day a
           value is added or renamed there is no second hand-written copy of the
           list here to forget — the failure `bucketOf` above documents. */
        { id: 'ownership', label: 'Ownership', children: BT.ui.OWNERSHIPS.map(o => ({
          id: 'own-' + o,
          label: BT.ui.OWNERSHIP_WORD[o],
          route: '#/library?ownership=' + o,
          n: byOwnership[o] || 0,
          dot: o,
        })) },
        { id: 'reading', label: 'Reading', children: BT.ui.READINGS.map(r => ({
          id: 'rd-' + r,
          label: BT.ui.READING_WORD[r],
          route: '#/library?reading=' + r,
          n: byReading[r] || 0,
          dot: r,
          /* The one filled dot in the tree. Reading is the state the app is
             actually about; a second filled dot would spend that distinction. */
          fill: r === 'reading' ? 1 : 0,
        })) },
        /* Ids and labels both come from config so the tree can never drift out
           of step with the bucketing rules or with any other screen.

           BT.GENRE_BUCKETS is an ACCESSOR, not a constant: it answers with the
           twelve built-ins plus whatever genres the user has added in Settings,
           re-read on every refresh. That is why adding a genre needs no change
           here — the row, its count and its dot all fall out of this map. The
           dot's class is `c-<id>`, and for a custom genre the rule behind it is
           injected at runtime by BT.genres rather than written in
           03-components.css. */
        { id: 'genres', label: 'By genre', children: BT.GENRE_BUCKETS.map(id => ({
          id: 'g-' + id,
          label: BT.GENRE_LABELS[id] || id,
          route: '#/library?genre=' + id,
          n: byGenre[id] || 0,
          /* No dot on General: it is the residue bucket rather than a genre,
             and there is deliberately no --bt-genre-general hue to paint. */
          dot: id === 'general' ? null : id,
        })) },
        { id: 'formats', label: 'By format', children: FORMATS.map(([id, label]) => ({
          id: 'f-' + id, label, route: '#/library?format=' + id, n: byFormat[id] || 0,
        })) },
      ] },
      { id: 'shelf', label: 'Shelf', children: [
        { id: 'pile-sell', label: 'To sell', route: '#/library?pile=sell', n: byPile.sell },
        { id: 'pile-sold', label: 'Sold', route: '#/library?pile=sold', n: byPile.sold },
        { id: 'up', label: 'Coming up', route: '#/up', n: upcoming },
        { id: 'undated', label: 'No date set', route: '#/up?undated=1', n: undated },
        { id: 'activity', label: 'Activity', route: '#/alerts', badge: unread || 0 },
        { id: 'stats', label: 'Stats', route: '#/stats' },
      ] },
      { id: 'discover', label: 'Discover', children: [
        { id: 'search', label: 'Search', route: '#/search' },
        /* Scan is discovery by a different door: a barcode names ONE edition,
           so what it adds is scope 'closed' where search adds scope 'open'. */
        { id: 'scan', label: 'Scan', route: '#/scan' },
        { id: 'people', label: 'Following', route: '#/people',
          n: follows.length, badge: followNews(follows) },
      ] },
      tags.size ? { id: 'tags', label: 'Tags', children:
        [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({
          id: 'tag-' + t, label: t, route: '#/library?tag=' + encodeURIComponent(t), n, hash: true,
        })) } : null,
      { id: 'system', label: 'System', children: [
        { id: 'settings', label: 'Settings', route: '#/settings' },
        { id: 'unlock', label: signedIn() ? 'Signed in' : 'Sign in', route: '#/unlock' },
      ] },
    ].filter(Boolean);
  }

  function matches(node) {
    if (!filterText) return true;
    if (node.label.toLowerCase().includes(filterText)) return true;
    return (node.children || []).some(matches);
  }

  function render(sections, activeRoute) {
    nodes = [];
    leafIdx = 0;
    /* Reset every render. Left stale, a screen with no tree entry keeps the
       previous screen's highlight, so standing on Scan lit up whatever was
       selected before it. */
    focusIdx = -1;
    let html = '';
    for (const sec of sections) {
      if (!matches(sec)) continue;
      const secOpen = isOpen(sec.id) || !!filterText;
      html += `<div class="sec" data-open="${secOpen ? 1 : 0}">
        <button class="sec-h" data-toggle="${esc(sec.id)}" type="button">
          ${CARET}<span>${esc(sec.label)}</span>
        </button>
        <div class="sec-body">${sec.children.map(c => renderNode(c, activeRoute)).join('')}</div>
      </div>`;
    }
    return html;
  }

  function renderNode(node, activeRoute) {
    if (!matches(node)) return '';
    const sel = node.route && routeMatches(node.route, activeRoute);
    nodes.push(node);

    const lead = node.dot ? `<span class="dot c-${esc(node.dot)}${node.fill ? ' fill' : ''}"></span>`
               : node.hash ? '<span class="hash">#</span>' : '';
    const trail = node.badge ? `<span class="badge">${node.badge}</span>`
                : node.n != null ? `<span class="n">${node.n}</span>` : '';

    if (node.children) {
      const o = isOpen(node.id) || !!filterText;
      return `<div class="grp" data-open="${o ? 1 : 0}">
        <button class="row" type="button" data-toggle="${esc(node.id)}">
          ${CARET}${lead}<span class="lbl">${esc(node.label)}</span>${trail}
        </button>
        <div class="kids">${node.children.map(c => renderNode(c, activeRoute)).join('')}</div>
      </div>`;
    }
    /* paintFocus indexes `#tree a.row`, which is LEAF anchors only, so the
       counter has to skip groups. Using nodes.length here counted the group
       rows too and put the highlight several places off. */
    if (sel) focusIdx = leafIdx;
    leafIdx++;
    return `<a class="row${sel ? ' is-sel' : ''}" href="${esc(node.route)}" data-node="${esc(node.id)}">
      ${NOCARET}${lead}<span class="lbl">${esc(node.label)}</span>${trail}
    </a>`;
  }

  /* A node is selected when its route's path and its own query pairs are all
     present in the current hash. That way "#/library?status=want&genre=mystery"
     still highlights Want, and plain "#/library" highlights All books. */
  /* Which query parameters make an unparameterised node NOT match. These are
     the library's own filters: "All books" (#/library) must not stay lit when
     you are looking at #/library?genre=fantasy.

     Keyed by PATH rather than applied globally, and that scoping is
     load-bearing: a parameter name means different things on different
     screens. `undated` filters the Shelf's two date lists and means nothing on
     the library, so a single flat list of filter names would light two rows at
     once on one screen and none at all on another — and a screen that matches
     no node leaves the arrow keys starting from the top of the tree every
     time you press one. */
  const FILTER_PARAMS = {
    /* `status` stays in this list even though no node emits it any more. A
       bookmarked or shared `#/library?status=finished` is redirected by
       62-view-list, but until that redirect lands the hash really is a filtered
       library — and leaving the old name out would light "All books" over a
       list that is not all books. */
    '/library': ['ownership', 'reading', 'status', 'genre', 'format', 'tag', 'pile'],
    '/up': ['undated'],
  };

  function routeMatches(route, active) {
    const [rp, rq] = route.replace('#', '').split('?');
    const [ap, aq] = (active || '').replace('#', '').split('?');
    if (rp !== ap) return false;
    const A = new URLSearchParams(aq || '');
    const R = new URLSearchParams(rq || '');
    if (![...R].length) {
      const filters = FILTER_PARAMS[rp] || [];
      return !filters.some(k => A.has(k));
    }
    for (const [k, v] of R) if (A.get(k) !== v) return false;
    return true;
  }

  async function refresh() {
    const host = document.getElementById('tree');
    if (!host) return;
    const sections = await build();
    host.innerHTML = render(sections, location.hash || '#/library');
    paintFocus();
  }

  /* Re-mark the selection without rebuilding the tree.

     The tree used to work out `is-sel` only inside render(), and render() only
     runs when the LIBRARY changes — so navigating never updated it. The
     highlight you saw was wherever you happened to be standing the last time
     you added something, which is why Search showed whichever genre you had
     browsed last as selected.

     This is a class toggle over existing anchors: no counts recomputed, no
     DOM rebuilt, safe to call on every route change. */
  function markRoute(activeRoute) {
    const active = activeRoute || location.hash || '#/library';
    const rows = [...document.querySelectorAll('#tree a.row')];
    focusIdx = -1;
    rows.forEach((a, i) => {
      const sel = routeMatches(a.getAttribute('href') || '', active);
      a.classList.toggle('is-sel', sel);
      if (sel) focusIdx = i;
    });
    paintFocus();
  }

  function paintFocus() {
    const rows = [...document.querySelectorAll('#tree a.row')];
    rows.forEach(r => r.classList.remove('is-focus'));
    if (focusIdx >= 0 && rows[focusIdx]) rows[focusIdx].classList.add('is-focus');
  }

  /* ── The ownership/reading migration, kicked ──────────────────────────
     Stamps the two axes onto every stored record that predates them. The sweep
     itself is BT.ui.migrateLibraryAxes; this is only where it is fired.

     HERE, and not in 90-boot beside retirePublisherFollows, because init() is
     the once-per-session hook this module owns and boot is not part of this
     change. Same shape and same rules as the two migrations boot already runs.

     NOT AWAITED, which is the rule 90-boot enforces everywhere: nothing at
     startup may block on work whose answer changes nothing about what happens
     next. And here it genuinely changes nothing — BT.ui.ownershipOf and
     BT.ui.readingOf DERIVE both axes from the legacy `user.status` whenever the
     stored field is missing, so every shelf, count, filter and row is already
     correct before this runs, while it is running, and if it never runs at all.
     What the sweep buys is the axes being stored, so the next device to sync
     gets them and so a reader can set the two independently.

     Feature-detected on BT.ui rather than assumed. A tree that cannot find the
     sweep is a migration deferred, not a navigation aid missing, and this file
     is the one whose failure takes the router with it — see the try/catch
     90-boot wraps refresh() in.

     The refresh at the end is gated on `n` for the reason retirePublisherFollows
     gates its own: on the second and every later boot the sweep writes nothing,
     and a tree rebuild for zero changes is a full pass over the library for
     nothing. */
  function migrateAxes() {
    if (!BT.ui || typeof BT.ui.migrateLibraryAxes !== 'function') return;
    Promise.resolve()
      .then(() => BT.ui.migrateLibraryAxes())
      .then(n => { if (n) refresh(); })
      .catch(e => console.warn('[tree] could not migrate reading/ownership', e && e.message));
  }

  function init() {
    const host = document.getElementById('tree');
    const filter = document.getElementById('treeFilter');

    migrateAxes();

    host.addEventListener('click', e => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        e.preventDefault();
        const id = toggle.dataset.toggle;
        open[id] = isOpen(id) ? 0 : 1;
        persist();
        refresh();
        return;
      }
      /* Wherever the tree IS a drawer, picking something closes it — which is
         what this line always meant and what the bare `<= 820` did not say.
         §6 of 05-responsive.css makes the tree a fixed drawer in a SECOND band
         (821-1180px with a coarse pointer: every iPad in either orientation,
         every Android tablet, the Fold inner screen), and there the drawer and
         its scrim stayed up over the screen the tap had just navigated to.
         Tapping the hamburger again calls openDrawer() unconditionally, so the
         only way out was a tap on the scrim — and that tap is swallowed by the
         scrim, making every single navigation on a tablet cost a dead tap over
         an app that looks frozen. */
      if (e.target.closest('a.row') && isTreeDrawer()) closeDrawer();
    });

    filter.addEventListener('input', BT.util.debounce(() => {
      filterText = filter.value.trim().toLowerCase();
      refresh();
    }, 120));
    filter.addEventListener('keydown', e => {
      if (e.key === 'Escape') { filter.value = ''; filterText = ''; refresh(); filter.blur(); }
      if (e.key === 'Enter') {
        const first = document.querySelector('#tree a.row');
        if (first) { location.hash = first.getAttribute('href'); filter.blur(); }
      }
    });

    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (typing) return;

      if (e.key === '/') { e.preventDefault(); filter.focus(); filter.select(); return; }
      if (e.key === 't' || e.key === 'T') { BT.theme.toggle(); return; }

      const rows = [...document.querySelectorAll('#tree a.row')];
      if (!rows.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx = e.key === 'ArrowDown'
          ? Math.min(rows.length - 1, focusIdx + 1)
          : Math.max(0, focusIdx - 1);
        paintFocus();
        rows[focusIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        location.hash = rows[focusIdx].getAttribute('href');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const grp = rows[focusIdx] && rows[focusIdx].closest('.grp, .sec');
        if (!grp) return;
        const btn = grp.querySelector('[data-toggle]');
        if (!btn) return;
        const id = btn.dataset.toggle;
        const wantOpen = e.key === 'ArrowRight';
        if (isOpen(id) !== wantOpen) { open[id] = wantOpen ? 1 : 0; persist(); refresh(); }
      }
    });

    document.getElementById('menuBtn').addEventListener('click', openDrawer);
    document.getElementById('scrim').addEventListener('click', () => {
      document.getElementById('treePane').classList.remove('open');
      BT.inspector.close();
      document.getElementById('scrim').classList.remove('on');
    });

    for (const mq of [MQ_TREE_DRAWER, MQ_TREE_TABLET, MQ_INSP_DRAWER]) {
      if (mq.addEventListener) mq.addEventListener('change', syncDrawers);
      else if (mq.addListener) mq.addListener(syncDrawers);
    }
    /* Width only. With interactive-widget=resizes-content, opening the
       on-screen keyboard resizes the viewport HEIGHT on every focus — and
       re-running the drawer sync on each of those was a visible stutter while
       typing. No breakpoint in this app is keyed on height. */
    let lastW = window.innerWidth;
    window.addEventListener('resize', BT.util.debounce(() => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      syncDrawers();
    }, 150));

    BT.repo.subscribe(ev => {
      if (ev === 'item:put' || ev === 'item:delete' || ev === 'feed:change' ||
          ev === 'follow:change' || ev === 'import:done' || ev === 'wipe') refresh();
    });
  }

  /* ── Breakpoint state ──────────────────────────────────────────────────
     The drawers are CSS below a width and docked above it, but the .open class
     that drives them is set by JS. Unfolding a phone into a tablet is a RESIZE,
     not a reload: the classes survive while the CSS giving them meaning does
     not. Left alone, unfolding with the tree open leaves a full-screen scrim
     that nothing can clear, and dragging a desktop window narrower slides the
     inspector you were reading off the edge.

     These queries mirror css/05-responsive.css exactly; changing one means
     changing the other. */
  const MQ_TREE_DRAWER = matchMedia('(max-width: 820px)');
  const MQ_INSP_DRAWER = matchMedia('(max-width: 1180px) and (pointer: coarse)');
  /* §6 of 05-responsive.css gives up the TREE on tablets and foldables to keep
     the inspector docked, so the tree is a fixed drawer here too. It is a
     separate query rather than a widened MQ_TREE_DRAWER because the two bands
     do different things to the INSPECTOR, which is docked in this one. */
  const MQ_TREE_TABLET = matchMedia('(min-width: 821px) and (max-width: 1180px) and (pointer: coarse)');

  /* The one question every drawer decision should ask: is the tree currently a
     drawer? Centralised the way isInspOverlay() already centralises the
     inspector's version of it — two literals in two files disagreeing is
     exactly how the tablet band ended up with a drawer that had no close
     path. */
  function isTreeDrawer() { return MQ_TREE_DRAWER.matches || MQ_TREE_TABLET.matches; }

  function syncDrawers() {
    const tree = document.getElementById('treePane');
    const insp = document.getElementById('inspector');
    const scrim = document.getElementById('scrim');
    if (!tree || !insp || !scrim) return;

    /* isTreeDrawer(), not MQ_TREE_DRAWER: in the tablet band the tree IS a
       drawer, so a rotation used to force-close one the reader had legitimately
       opened. */
    if (!isTreeDrawer()) tree.classList.remove('open');
    /* The inspector is docked on tablets and foldables, so "open" is only
       meaningful where it is actually an overlay. */
    if (!isInspOverlay()) insp.classList.remove('open');
    scrim.classList.toggle('on',
      (isTreeDrawer() && tree.classList.contains('open')) ||
      (isInspOverlay() && insp.classList.contains('open')));
  }

  /* Docked wherever there is room for two panes on a touch device; an overlay
     otherwise. Mirrors the CSS band in §6 of 05-responsive.css. */
  function isInspOverlay() {
    return window.innerWidth <= 1180 && !MQ_INSP_DRAWER.matches
      ? true                                  // narrow mouse window: overlay
      : window.innerWidth <= 820;             // touch: overlay only on phones
  }

  function openDrawer() {
    /* See BT.inspector.openDrawerIfNarrow — one drawer at a time. */
    BT.inspector.close();
    document.getElementById('treePane').classList.add('open');
    document.getElementById('scrim').classList.add('on');
  }
  function closeDrawer() {
    document.getElementById('treePane').classList.remove('open');
    if (!document.getElementById('inspector').classList.contains('open')) {
      document.getElementById('scrim').classList.remove('on');
    }
  }

  return { init, refresh, markRoute, openDrawer, closeDrawer, syncDrawers, isInspOverlay };
})();
