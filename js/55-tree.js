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

  /* The bucket a book counts toward. ui-core owns the one definition; the
     fallback matters because a record written before the facet existed must
     land in `general` rather than drop out of every count — a tree whose
     numbers do not add up to "All books" is a tree nobody trusts. */
  const bucketOf = it => (BT.ui && BT.ui.genreOf ? BT.ui.genreOf(it)
    : ((it.facets && it.facets.genre) || 'general'));

  /* `unspecified` is the honest default for anything added from search, where
     the work is tracked and no edition has been chosen yet (scope 'open'). */
  const formatOf = it => (it.facets && it.facets.format) || 'unspecified';

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

  async function build() {
    const items = await BT.repo.allItems();
    const follows = await BT.repo.allFollows();
    const unread = await BT.repo.unreadCount();

    const byStatus = { want: 0, reading: 0, finished: 0, dropped: 0 };
    const byGenre = {};
    const byFormat = {};
    const byPile = { sell: 0, sold: 0 };
    const tags = new Map();
    const today = BT.util.todaySortKey();
    let undated = 0;
    let upcoming = 0;

    for (const it of items) {
      byStatus[it.user.status] = (byStatus[it.user.status] || 0) + 1;
      const g = bucketOf(it);
      byGenre[g] = (byGenre[g] || 0) + 1;
      const f = formatOf(it);
      byFormat[f] = (byFormat[f] || 0) + 1;
      /* Ownership is a separate axis from reading: a book can be finished and
         still on the sell pile, or unread and already sold. `pile` is null for
         almost everything, so only the two real values are counted. */
      if (it.user.pile) byPile[it.user.pile] = (byPile[it.user.pile] || 0) + 1;
      for (const t of (it.user.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);

      /* Same reading of the date as #/up uses, or the number on the row
         disagrees with the length of the list it opens. Order matters here:
         SK_UNKNOWN sorts above every real key, so "no date" has to be tested
         before "in the future" or every undated book is also upcoming. */
      if (it.release.sortKey >= BT.util.SK_UNKNOWN) undated++;
      else if (it.release.sortKey >= today) upcoming++;
    }

    return [
      { id: 'library', label: 'Library', children: [
        { id: 'all', label: 'All books', route: '#/library', n: items.length },
        { id: 'st-want', label: 'Want', route: '#/library?status=want', n: byStatus.want, dot: 'want' },
        { id: 'st-reading', label: 'Reading', route: '#/library?status=reading', n: byStatus.reading, dot: 'reading', fill: 1 },
        { id: 'st-finished', label: 'Finished', route: '#/library?status=finished', n: byStatus.finished, dot: 'finished' },
        { id: 'st-dropped', label: 'Dropped', route: '#/library?status=dropped', n: byStatus.dropped, dot: 'dropped' },
        /* Ids and labels both come from config so the tree can never drift out
           of step with the bucketing rules or with any other screen. */
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
        { id: 'people', label: 'Following', route: '#/people', n: follows.length },
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
     you are looking at #/library?genre=fantasysf.

     Keyed by PATH rather than applied globally, and that scoping is
     load-bearing: a parameter name means different things on different
     screens. `undated` filters the Shelf's two date lists and means nothing on
     the library, so a single flat list of filter names would light two rows at
     once on one screen and none at all on another — and a screen that matches
     no node leaves the arrow keys starting from the top of the tree every
     time you press one. */
  const FILTER_PARAMS = {
    '/library': ['status', 'genre', 'format', 'tag', 'pile'],
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

  function init() {
    const host = document.getElementById('tree');
    const filter = document.getElementById('treeFilter');

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
      /* On narrow screens the tree is a drawer; picking something closes it. */
      if (e.target.closest('a.row') && window.innerWidth <= 820) closeDrawer();
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

    for (const mq of [MQ_TREE_DRAWER, MQ_INSP_DRAWER]) {
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

  function syncDrawers() {
    const tree = document.getElementById('treePane');
    const insp = document.getElementById('inspector');
    const scrim = document.getElementById('scrim');
    if (!tree || !insp || !scrim) return;

    if (!MQ_TREE_DRAWER.matches) tree.classList.remove('open');
    /* The inspector is docked on tablets and foldables, so "open" is only
       meaningful where it is actually an overlay. */
    if (!isInspOverlay()) insp.classList.remove('open');
    scrim.classList.toggle('on',
      (MQ_TREE_DRAWER.matches && tree.classList.contains('open')) ||
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
