/* ══════════════════════════════════════════════════════════════════════════
   Shared UI. One implementation of each component; views compose these and
   never hand-roll a cover, a date, a genre chip or a page count.
   ══════════════════════════════════════════════════════════════════════════ */

BT.ui = (function () {
  const esc = BT.util.escapeHtml;

  /* ══ THE DATE GRAMMAR ═══════════════════════════════════════════════════
     A date is a fixed 10-slot monospace field. A segment that is not stored is
     replaced by a hatched block exactly as wide as the digits it stands in
     for — which works because the placeholder characters are monospace too.

         1965-08-01   day known
         1991-09-▨▨   month known, day does not exist in the record
         1965-▨▨-▨▨   year only
         ▨▨▨▨-▨▨-▨▨   nothing announced

     hatch = the value cannot exist in the record
     dots  = the value exists upstream but we have not fetched it

     This is the app's core idea, and the reason it renders here and nowhere
     else: a month-precision book must never display a day, on any screen.

     Books lean on this harder than films did. Open Library's `publish_date` is
     free text typed by cataloguers over five decades — '1991', 'c1991',
     '[1991]', 'Sept 2012', '19uu' — so a majority of a real library resolves
     to year precision, and the hatched field is the NORMAL rendering rather
     than the degraded one. Anything that quietly invented a day here would be
     inventing it for most of the shelf. */
  const HATCH = c => `<span class="hatch">${'▨'.repeat(c)}</span>`;

  function dateField(release) {
    if (!release) return `<span class="date">${HATCH(4)}<span class="sep">-</span>${HATCH(2)}<span class="sep">-</span>${HATCH(2)}</span>`;
    const p = BT.util.sortKeyToParts(release.sortKey);
    const prec = release.precision || 'unknown';

    let y, m, d;
    if (!p || prec === 'tba' || prec === 'unknown') { y = HATCH(4); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'year') { y = k(p.y); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'quarter') { y = k(p.y); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'month') { y = k(p.y); m = k(pad(p.m)); d = HATCH(2); }
    else { y = k(p.y); m = k(pad(p.m)); d = k(pad(p.d)); }

    const title = prec === 'quarter'
      ? `Q${BT.util.quarterOf(p.m)} ${p.y} — no month announced`
      : release.display || 'No date';

    return `<span class="date" title="${esc(title)}">${y}<span class="sep">-</span>${m}<span class="sep">-</span>${d}</span>`;
  }
  const k = v => `<span class="k">${v}</span>`;
  const pad = n => String(n).padStart(2, '0');

  /* The waterline gauge: three segments, filled only for what is actually
     stored. Reads at a glance in a dense column where the mono field needs a
     beat of attention. */
  function waterline(release) {
    const prec = (release && release.precision) || 'unknown';
    const fills = { day: 3, month: 2, quarter: 2, year: 1, tba: 0, unknown: 0 }[prec] || 0;
    let s = '<span class="wl" aria-hidden="true">';
    for (let i = 0; i < 3; i++) s += `<i class="${i < fills ? 'f' : ''}"></i>`;
    return s + '</span>';
  }

  function precisionTag(release) {
    const prec = (release && release.precision) || 'unknown';
    const label = { day: 'Exact day', month: 'Month only', quarter: 'Quarter', year: 'Year only',
                    tba: 'TBA', unknown: 'No date' }[prec] || prec;
    return `<span class="prec ${esc(prec)}">${esc(label)}</span>`;
  }

  /* MovieTrak's date cell carried a second half — the "next episode" chip for a
     running series, because a television record answers two questions at once.
     A book answers one: it published, or it has not. There is no second date to
     reconcile, so the cell is the gauge and the field and nothing else.
     (A series' next VOLUME is a different work with its own record, not a field
     on this one — it belongs to the series view, not to this cell.) */
  function dateCell(release) {
    return `<span class="datecell">${waterline(release)}${dateField(release)}</span>`;
  }

  /* Human phrasing, which must also respect precision — "in 3 days" against a
     month-only date would be inventing information. */
  function whenText(release) {
    if (!release || release.sortKey >= BT.util.SK_UNKNOWN) return 'No date announced';
    const days = BT.util.daysUntil(release.sortKey);
    if (release.precision === 'day') {
      return `<em>${esc(release.display)}</em> · ${esc(BT.util.relativeDays(days))}`;
    }
    const months = Math.round(days / 30);
    const approx = days < 0 ? 'already published' : months <= 1 ? 'about a month away' : `about ${months} months away`;
    return `<em>${esc(release.display)}</em> · ${approx}, no day to count down to`;
  }

  /* Publication dates move — an announced title slips a season, and a preorder
     the reader is waiting on is exactly the case where the movement matters. */
  function driftBadge(release) {
    const h = release && release.history;
    if (!h || !h.length) return '';
    const last = h[h.length - 1];
    if (last.deltaDays == null) return '';
    const later = last.deltaDays > 0;
    return `<span class="drift ${later ? 'later' : 'earlier'}">${later ? '→' : '←'} ${Math.abs(last.deltaDays)}d</span>`;
  }

  /* ══ COVER ══════════════════════════════════════════════════════════════
     Real Open Library jacket art when we have it. When we do not, a generated
     block built from a hash of the title, so a missing cover is a deliberate
     composition rather than an empty hole.

     The generated case is not an edge case here. Open Library's cover coverage
     is excellent for recent English-language trade editions and patchy for
     everything else — older printings, translations, small imprints, and most
     of the mass-market backlist. A library of any age is going to render a lot
     of these, so they have to be worth looking at. */

  /* Build a cover URL for an item, or null when there is nothing to ask for.
     `size` is a key into BT.OL.SIZES: 'sm' | 'md' | 'lg'.

     TWO VERIFIED RULES, both of which produce a UI that looks broken in a way
     that is very hard to trace back. They are enforced in BT.OL.cover(), and
     restated here because this is where the ids are chosen:

     1. `?default=false` is MANDATORY on every covers.openlibrary.org URL.
        Without it, a request for a cover that does not exist answers HTTP 200
        with a 43-byte transparent GIF. The image LOADS, so <img onerror> never
        fires, so the generated block never replaces it — the grid fills with
        invisible tiles the user reads as a broken app. With the parameter the
        same request 404s and onerror does its job.

     2. The `covers` array on a work or edition record can contain -1 MID-ARRAY.
        It is a sentinel meaning "a cover record existed and was removed", not
        an id. Taking covers[0] blindly builds .../b/id/-1-M.jpg, which 404s.
        BT.OL.usableCovers() drops it (and 0, and anything non-numeric); use it
        rather than reaching into the array. */
  function posterUrl(item, size) {
    if (!item) return null;
    const im = item.images || {};
    const sz = size || 'md';

    /* An absolute URL wins outright: it is either a hand-set override or a
       Google Books thumbnail, and neither is ours to rebuild. */
    if (im.coverUrl && /^https?:/.test(im.coverUrl)) return im.coverUrl;

    /* Cover id is the best route — it names one specific uploaded image rather
       than asking the server to resolve an identifier for us. Rule 2 applies. */
    const usable = BT.OL.usableCovers(im.covers);
    const id = im.coverId != null ? im.coverId : (usable.length ? usable[0] : null);
    if (id != null) {
      const u = BT.OL.coverById(id, sz);       // returns null for the -1 sentinel
      if (u) return u;
    }

    /* ISBN next. It resolves to whichever edition Open Library has art for,
       which for a closed item is the reader's actual copy. */
    const ids = item.ids || {};
    if (ids.isbn13) return BT.OL.coverByIsbn(ids.isbn13, sz);

    /* OLID last, and only an EDITION olid. There is no cover route for a work
       olid — /b/olid/OL27482W-M.jpg is a 404 every time — so an open item with
       no cover id and no ISBN correctly falls through to the generated block
       rather than firing a request that cannot succeed. */
    if (ids.editionOlid) return BT.OL.coverByOlid(ids.editionOlid, sz);
    return null;
  }

  /* Bookcloth. Warmer and earthier than MovieTrak's palette on purpose: these
     stand in for a physical binding, not for a printed film poster. */
  const HUES = [
    ['#7A5A2E', '#241A0E'], ['#5A4A7A', '#1C1728'], ['#3F6B5A', '#14211C'],
    ['#8A5240', '#2A1712'], ['#46587F', '#161D2B'], ['#7A3F55', '#2A151D'],
    ['#6B6B34', '#201F10'], ['#2F6270', '#0F1E23'],
  ];
  function hues(title) {
    const h = parseInt(BT.util.fnv1a(title || 'x').slice(0, 4), 36) || 0;
    return HUES[h % HUES.length];
  }

  function poster(item, opts) {
    opts = opts || {};
    const url = posterUrl(item, opts.size || 'md');
    const [a, b] = hues(item.title);
    const initial = (item.title || '?').trim()[0] || '?';
    const cls = 'poster' + (url ? '' : ' gen') + (opts.cls ? ' ' + opts.cls : '');
    return `<div class="${cls}" style="--a:${a};--b:${b}" data-i="${esc(initial)}">${
      url ? `<img loading="lazy" src="${esc(url)}" alt="">` : ''
    }</div>`;
  }

  function chipart(item) {
    const url = posterUrl(item, 'sm');
    const [a, b] = hues(item.title);
    return `<span class="chipart" style="--a:${a};--b:${b}">${
      url ? `<img loading="lazy" src="${esc(url)}" alt="">` : ''
    }</span>`;
  }

  /* ══ LABELS ═════════════════════════════════════════════════════════════ */

  /* Genre buckets, as ids. Two shapes are accepted because the record has
     carried both: normalize writes `[{ id, name }]` so repo can build
     `idx.genreIds`, but a stub straight out of search may only have the ids.
     Reading either here means no view has to know which one it has. */
  function genresOf(item) {
    const raw = (item && item.genres) || [];
    const ids = [];
    for (const g of raw) {
      const id = typeof g === 'string' ? g : (g && g.id);
      if (id && BT.GENRE_LABELS[id] && ids.indexOf(id) < 0) ids.push(id);
    }
    return ids.length ? ids : ['general'];
  }

  /* ── Format icons ──────────────────────────────────────────────────────
     Physical, ebook, audiobook. Drawn rather than written because the format
     sits next to two genre words in a narrow cell, and a third word there
     turns the column into prose. 24px viewBox, stroked in currentColor so the
     icon inherits whatever hue the surrounding chip resolved to. */
  const FORMAT_ICON = {
    /* A closed book, spine to the left — the object, not an open spread. An
       open book reads as "reading" and would collide with the status dot. */
    physical: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
    /* A tablet. Deliberately not a stylised "e" or a lightning bolt: the
       reader recognises the device long before they decode a glyph. */
    ebook: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M10.5 18.5h3"/>',
    /* Headphones, not a speaker — a speaker means "sound", headphones mean
       "something you listen to on your own", which is what an audiobook is. */
    audiobook: '<path d="M3 16v-4a9 9 0 0 1 18 0v4"/>'
      + '<path d="M21 16v1a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3z"/>'
      + '<path d="M3 16v1a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z"/>',
  };
  const FORMAT_LABEL = {
    physical: 'Physical', ebook: 'Ebook', audiobook: 'Audiobook',
    unspecified: 'Format not recorded',
  };

  const formatOf = item => (item && item.facets && item.facets.format) || 'unspecified';

  /* 'unspecified' draws NOTHING. An icon meaning "we do not know" is noise in
     every row that has one, and the honest reading of a blank slot is already
     "not recorded" — which is what the vast majority of search-added items are
     until the reader says otherwise. */
  function formatIcon(item) {
    const f = formatOf(item);
    const d = FORMAT_ICON[f];
    if (!d) return '';
    return `<span class="fmt ${esc(f)}" title="${esc(FORMAT_LABEL[f])}">`
      + `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`
      + '</span>';
  }

  /* Up to two buckets, then the format. Two is the cap because a well-catalogued
     work matches three or four — "Fantasy & SF", "Fiction", "General" — and the
     third chip is always the least specific one, which is the one that tells the
     reader nothing. BT.GENRE_BUCKETS is in display order and genresOf preserves
     the record's order, so the specific bucket leads. */
  function genreTag(item) {
    const chips = genresOf(item).slice(0, 2)
      .map(g => `<span class="tag ${esc(g)}">${esc(BT.GENRE_LABELS[g] || g)}</span>`)
      .join('');
    return chips + formatIcon(item);
  }

  const STATUS_WORD = { want: 'Want', reading: 'Reading', finished: 'Finished', dropped: 'Dropped' };
  function statusCell(item) {
    const s = (item.user && item.user.status) || 'want';
    return `<span class="stat"><span class="dot c-${s} ${s === 'reading' ? 'fill' : ''}"></span>${STATUS_WORD[s]}</span>`;
  }

  /* ── The ownership axis ────────────────────────────────────────────────
     `user.pile` is NOT a reading status and must never be rendered as one. A
     book can be finished and kept, finished and marked to sell, or unread and
     marked to sell (the pile of things you admit you are not going to get to).
     Two independent facts, two separate marks — collapsing them into one
     dropdown is what makes a to-sell flow unusable, because "Sold" would then
     erase whether you read it. */
  const PILE_WORD = { sell: 'To sell', sold: 'Sold' };
  const pileLabel = p => PILE_WORD[p] || 'Keeping';

  function pileTag(item) {
    const p = item && item.user && item.user.pile;
    if (!p) return '';
    return `<span class="pile ${esc(p)}">${esc(PILE_WORD[p] || p)}</span>`;
  }

  /* ── Is it out yet ─────────────────────────────────────────────────────
     One reading for every view, so the library filter, the Releases view and
     the refresh tiers cannot disagree about it.

     Not simply `sortKey <= today`, and the reason is specific to books. Open
     Library free text like '19uu' or 'n.d.' parses to nothing, so the record
     lands on SK_UNKNOWN. That is the right SORT position — undated goes last —
     but it is the wrong answer to "is it out", and answering "no" would file
     half a classics shelf under Still to come.

     `release.status` is set from the record itself rather than from the date,
     so it rescues exactly those: a 1953 novel with an unparseable date is still
     `published`. The ladder only ever has three rungs for a book —
     unannounced | announced | published — and there is no equivalent of a film
     slipping between windows, so this stays three lines. */
  function publishedKey(item) {
    return ((item && item.release) || {}).sortKey;
  }

  function hasPublished(item) {
    const rel = (item && item.release) || {};
    if (rel.sortKey != null && rel.sortKey < BT.util.SK_UNKNOWN) {
      return rel.sortKey <= BT.util.todaySortKey();
    }
    return rel.status === 'published';
  }

  /* Kept so views have one name for "when is this next relevant". For a book
     that is always its publication date — there is no second date to prefer —
     but the views that ask are shared with the date engine, and a view reaching
     for `item.release` directly is a view that will need editing the day a
     series' next volume gets its own field. */
  const upcomingRelease = item => item && item.release;

  /* ══ TABLE + GRID ═══════════════════════════════════════════════════════ */
  /* `drop` marks a column the phone layout hides (see 05-responsive.css).
     Genre is deliberately NOT one of them: stripped of it, a narrow row is a
     bare title with no clue whether it is a thriller, a cookbook or a volume of
     poetry — which is the first thing you want when scanning a mixed shelf. It
     costs one short chip, and as its own column the buckets line up vertically
     and can be read down the page as a stripe.

     Pages replaces MovieTrak's separate Type and Progress pair. One column
     answers both questions a reader actually asks of it: how long is this,
     before you start, and how far in are you, after. */
  const COLUMNS = [
    { key: 'title', label: 'Title' },
    { key: 'genre', label: 'Genre' },
    { key: 'status', label: 'Status', drop: true },
    { key: 'release', label: 'Published' },
    { key: 'pages', label: 'Pages', num: true, drop: true },
    { key: 'rating', label: 'Yours', num: true },
    { key: 'added', label: 'Added', num: true, drop: true },
  ];

  /* `opts.groupBy` returns a heading for an item, or null for none. Rows are
     emitted in the order given — grouping does NOT re-sort, it only inserts a
     divider wherever the heading changes, so the caller stays in charge of
     ordering and a mis-sorted list produces visibly repeated headings rather
     than a silently wrong one. */
  function table(items, selectedUid, opts) {
    if (!items.length) return '';
    opts = opts || {};
    const span = COLUMNS.length;
    let last = null;
    let body = '';
    for (const it of items) {
      if (opts.groupBy) {
        const g = opts.groupBy(it);
        if (g && g !== last) {
          body += `<tr class="grouprow"><td colspan="${span}">${esc(g)}</td></tr>`;
          last = g;
        }
      }
      body += tableRow(it, it.uid === selectedUid);
    }
    return `<div class="tblwrap"><table>
      <thead><tr>${COLUMNS.map(c =>
        `<th data-col="${c.key}"${c.num ? ' class="num"' : ''}${c.drop ? ' data-drop' : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  function tableRow(item, selected) {
    const u = item.user || {};
    const added = u.addedAt ? new Date(u.addedAt) : null;
    return `<tr data-uid="${esc(item.uid)}"${selected ? ' class="is-sel"' : ''}>
      <td data-col="title"><span class="title-cell">${chipart(item)}<span class="t">${esc(item.title)}</span>${pileTag(item)}${driftBadge(item.release)}</span>${progressBar(item)}</td>
      <td data-col="genre">${genreTag(item)}</td>
      <td data-col="status" data-drop>${statusCell(item)}</td>
      <td data-col="release">${dateCell(item.release)}</td>
      <td data-col="pages" data-drop class="num mono">${pagesCell(item)}</td>
      <td data-col="rating" class="num mono">${u.rating != null ? esc(u.rating) + '<span class="faint">/10</span>' : '<span class="faint">·&nbsp;·</span>'}</td>
      <td data-col="added" data-drop class="num mono faint">${added ? esc(added.toISOString().slice(0, 10)) : ''}</td>
    </tr>`;
  }

  /* ══ PROGRESS ═══════════════════════════════════════════════════════════
     How far into a book you are. One optional shape on user.progress:

       user.progress = { currentPage, totalPages, updatedAt }

     Page-based and nothing else. Percent-only would be unfaithful to what the
     reader can see (a physical book shows a page number, never a percentage),
     and chapters are not comparable between editions. A page is the one figure
     printed on the object in the reader's hand.

     `totalPages` lives on the PROGRESS record rather than being read only from
     the catalogue, and that is the whole reason this shape has three fields
     instead of two. An `open` item is a work with no chosen edition, so there
     is no authoritative extent: the 1965 hardback, the 1990 mass-market and the
     2019 trade paperback of the same novel are 412, 535 and 658 pages. The
     number the reader typed off their own copy is the correct denominator; the
     catalogue figure is a fallback for when they have not.

     It lives under `user`, which leanForSync does not drop, so it syncs like
     the rating and the notes do — and being one field rather than a per-format
     split means a merge between two devices has one thing to reconcile. */

  function progressOf(item) {
    const p = item && item.user && item.user.progress;
    return p && typeof p === 'object' ? p : null;
  }

  /* The reader's own figure first, the record's second. `pageCount` on a closed
     item is that edition's extent and the two normally agree; on an open item
     it is whatever edition the work record happened to surface, which is a
     guess, so it never overrides a stated number. */
  function totalPagesOf(item) {
    const p = progressOf(item);
    if (p && p.totalPages > 0) return p.totalPages;
    return (item && item.pageCount > 0) ? item.pageCount : null;
  }

  /* 0..1, or null when there is no denominator to measure against. A book with
     no recorded extent is genuinely unmeasurable — it gets a position, not a
     fraction. */
  function progressFraction(item) {
    const p = progressOf(item);
    if (!p || p.currentPage == null) {
      return (item.user && item.user.status === 'finished') ? 1 : null;
    }
    const total = totalPagesOf(item);
    if (!total) return null;
    return BT.util.clamp(p.currentPage / total, 0, 1);
  }

  function progressText(item) {
    const u = item.user || {};
    const p = progressOf(item);
    if (p && p.currentPage != null) {
      const f = progressFraction(item);
      /* No extent, no percentage. "p.184" is the whole truth in that case, and
         a percentage against a denominator we invented would be worse than no
         percentage at all. */
      return f != null ? `${Math.round(f * 100)}% · p.${p.currentPage}` : `p.${p.currentPage}`;
    }
    if (u.status === 'finished') return 'Finished';
    return '—';
  }

  /* The Pages column, which changes question depending on whether you have
     started: the extent before, the position after. */
  function pagesCell(item) {
    const t = progressText(item);
    if (t !== '—') return esc(t);
    const n = totalPagesOf(item);
    return n ? `<span class="faint">${esc(String(n))}</span>` : '<span class="faint">·&nbsp;·</span>';
  }

  /* A hairline along the bottom of the row. Deliberately not another column:
     the phone layout has no width to spare, and this is legible at 320px. */
  function progressBar(item) {
    const f = progressFraction(item);
    if (f == null || f <= 0) return '';
    return `<span class="prg" aria-hidden="true"><i style="width:${(f * 100).toFixed(1)}%"></i></span>`;
  }

  /* Clamped on the way in, so nothing downstream has to defend against page 0,
     a negative extent, or a position past the last page.

     Order matters: totalPages is applied BEFORE currentPage, so a call that
     sets both at once clamps the position against the new extent rather than
     the stale one. Setting them in the other order caps "page 600 of 658" at
     whatever the previous edition's 412 was. */
  function setProgress(uid, patch) {
    return BT.repo.getItem(uid).then(async cur => {
      if (!cur) return null;
      const p = Object.assign({}, progressOf(cur));
      if (patch.totalPages !== undefined) {
        p.totalPages = patch.totalPages == null ? undefined
          : Math.max(1, Math.round(patch.totalPages));
      }
      if (patch.currentPage !== undefined) {
        const cap = p.totalPages || totalPagesOf(cur) || 100000;
        p.currentPage = patch.currentPage == null ? undefined
          : Math.round(BT.util.clamp(patch.currentPage, 0, cap));
      }
      for (const key of Object.keys(p)) if (p[key] === undefined) delete p[key];

      const empty = !Object.keys(p).filter(key => key !== 'updatedAt').length;
      cur.user.progress = empty ? null : Object.assign(p, { updatedAt: Date.now() });

      /* Recording progress on something still filed as "want" is a statement
         that you have started it. Never the reverse: finishing is a decision,
         not something inferred from reaching the last page.

         Gated on a real position rather than on the record being non-empty:
         typing in the page count of a book you have not opened is bookkeeping,
         not reading, and it must not move the book. */
      if (p.currentPage > 0 && cur.user.status === 'want') cur.user.status = 'reading';

      await BT.repo.putItem(cur);
      return cur;
    });
  }

  function grid(items, selectedUid, opts) {
    opts = opts || {};
    const card = it => `
      <div class="card${it.uid === selectedUid ? ' is-sel' : ''}" data-uid="${esc(it.uid)}">
        ${poster(it)}
        <div class="ct">${esc(it.title)}</div>
        <div class="cs">${waterline(it.release)}<span class="mono">${esc(shortWhen(it.release))}</span></div>
      </div>`;

    if (!opts.groupBy) return `<div class="grid">${items.map(card).join('')}</div>`;

    /* Covers need a grid per group; one grid with headings inside it would put
       them in a cell rather than across the row. */
    let out = '';
    let last = null;
    let open = false;
    for (const it of items) {
      const g = opts.groupBy(it);
      if (g && g !== last) {
        if (open) out += '</div>';
        out += groupHead(g);
        out += '<div class="grid">';
        open = true;
        last = g;
      } else if (!open) {
        out += '<div class="grid">';
        open = true;
      }
      out += card(it);
    }
    return out + (open ? '</div>' : '');
  }

  function shortWhen(release) {
    if (!release || release.sortKey >= BT.util.SK_UNKNOWN) return 'TBA';
    const p = BT.util.sortKeyToParts(release.sortKey);
    if (release.precision === 'day') return release.display;
    if (release.precision === 'month') return `${BT.util.MONTHS_ABBR[p.m - 1]} ${p.y}`;
    return String(p.y);
  }

  /* ══ FEEDBACK ═══════════════════════════════════════════════════════════ */
  function emptyState(o) {
    return `<div class="empty"><h3>${esc(o.title)}</h3><p>${o.body || ''}</p>${o.actions || ''}</div>`;
  }
  function errorBox(title, body) {
    return `<div class="errorbox"><strong>${esc(title)}</strong>${esc(body)}</div>`;
  }
  function skeletonGrid(n) {
    let s = '<div class="grid">';
    for (let i = 0; i < (n || 12); i++) s += '<div><div class="skel skel--poster"></div><div class="skel skel--line"></div></div>';
    return s + '</div>';
  }
  function groupHead(label, count) {
    return `<div class="group-h">${esc(label)}${count != null ? ` <span class="count">${count}</span>` : ''}</div>`;
  }

  function toast(message, opts) {
    opts = opts || {};
    const host = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.bad ? ' toast--bad' : '');
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (opts.actionLabel) {
      const b = document.createElement('button');
      b.textContent = opts.actionLabel;
      b.onclick = () => { el.remove(); opts.onAction && opts.onAction(); };
      el.appendChild(b);
    }
    host.appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (opts.actionLabel ? 7000 : 3200));
    return el;
  }

  function banner(message, opts) {
    opts = opts || {};
    const el = document.getElementById('banner');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `<span>${esc(message)}</span>`;
    const b = document.createElement('button');
    b.textContent = opts.actionLabel || 'Dismiss';
    b.onclick = () => { if (opts.onAction) opts.onAction(); el.hidden = true; };
    el.appendChild(b);
  }

  function crumb(parts) {
    const el = document.getElementById('crumb');
    if (!el) return;
    el.innerHTML = parts.map((p, i) =>
      i === parts.length - 1 ? `<b>${esc(p)}</b>` : `${esc(p)}<s>/</s>`).join(' ');
  }

  function paneActions(html) {
    const el = document.getElementById('paneActions');
    if (el) el.innerHTML = html || '';
  }

  /* ══ SELECTION ══════════════════════════════════════════════════════════
     Multi-select state for the list view's .selectbar. Lives here rather than
     in 62-view-list.js because it is about to have three customers: the sell
     pile, bulk tagging and bulk status edits all want the same "some rows are
     picked" state, and three copies of a Set would be three chances for the bar
     to disagree with the checkboxes.

     Deliberately knows NOTHING about piles, tags or statuses — it holds uids
     and tells you when they change. The action belongs to whoever drew the bar.

     `size()` is a method, not a property, for a reason worth stating: a bare
     number captured at render time goes stale the moment anything is picked,
     and the resulting bar cheerfully says "3 selected" over five highlighted
     rows. A call cannot be stale. */
  const selection = (function () {
    const set = new Set();
    const subs = new Set();

    function fire() {
      for (const fn of subs) { try { fn(api); } catch (e) { console.error(e); } }
    }

    const api = {
      add(uid) { if (uid && !set.has(uid)) { set.add(uid); fire(); } return api; },
      remove(uid) { if (set.delete(uid)) fire(); return api; },
      toggle(uid) { if (!uid) return api; set.has(uid) ? set.delete(uid) : set.add(uid); fire(); return api; },
      clear() { if (set.size) { set.clear(); fire(); } return api; },
      has(uid) { return set.has(uid); },
      size() { return set.size; },
      all() { return Array.from(set); },

      /* Replace the whole set in one go — "select all" on a filtered list, and
         the only way to do it without firing a change per row. */
      replace(uids) {
        set.clear();
        for (const u of uids || []) if (u) set.add(u);
        fire();
        return api;
      },

      /* Drop anything no longer on screen. Without this a selection survives a
         filter change invisibly: pick eight books, switch to Finished, press
         the bar's action and it moves five rows you can no longer see. Callers
         pass the uids currently rendered, after filtering. */
      retain(uids) {
        const keep = new Set(uids || []);
        let changed = false;
        for (const u of Array.from(set)) if (!keep.has(u)) { set.delete(u); changed = true; }
        if (changed) fire();
        return api;
      },

      /* Returns an unsubscribe, the same contract as BT.repo.subscribe, so a
         view that re-renders does not stack listeners. */
      onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
    return api;
  })();

  /* ══ ADD / MUTATE ═══════════════════════════════════════════════════════ */

  /* ── SEAM ──────────────────────────────────────────────────────────────
     48-sync.js decides how often a record is re-checked, and it is not on the
     page until M4. Every mutation below wants to re-tier the item it touched,
     and a bare `BT.sync.retier(...)` is a TypeError on an M1 page — which took
     out the inspector's status control, the one thing in the app that writes on
     every single interaction. Guarded the same way 90-boot.js guards the sweep:
     a missing scheduler means "nothing to reschedule", never a failed edit. */
  function retier(item) {
    if (BT.sync && typeof BT.sync.retier === 'function') BT.sync.retier(item);
    return item;
  }

  /* The same seam, for the same reason, one module along — and this one was
     missed. 45-alerts.js owns snapshotOf() and also lands in M4, so a bare
     `BT.alerts.snapshotOf(item)` threw a TypeError on every single add: the
     item was already written by then, so the library gained the book while the
     caller got a rejected promise and the user got no toast, no Undo and no
     hydrate. #/search had grown its own try/catch around addItem to survive
     it, which hid the fault; the inspector's "Add to library" had not, so that
     button simply failed.

     A missing snapshotter means there is nothing to compare against yet, so the
     honest baseline is the marker alone. When 45-alerts arrives it fills in the
     fields it wants to diff, and nothing here changes. */
  function baselineSnapshot(item) {
    const snap = (BT.alerts && typeof BT.alerts.snapshotOf === 'function')
      ? BT.alerts.snapshotOf(item)
      : { uid: item.uid };
    return Object.assign({ baseline: 1 }, snap);
  }

  /* `opts.scope` IS THE CALLER'S TO STATE, never guessed from the stub.

     A scan read one specific physical copy — one ISBN, one printing, with the
     page count on its own copyright page — so it is 'closed'. A search result
     is a WORK: the reader means "Dune", not the 1990 Ace paperback, and picking
     an edition on their behalf would stamp a cover, a publisher and an extent
     onto the record that they never chose and would then have to notice and
     correct. Default 'open' because search is the common path; the scan view
     passes 'closed' explicitly. */
  async function addItem(stub, opts) {
    opts = opts || {};
    const existingUid = await BT.repo.resolveUid(BT.repo.idKeysFor(stub));
    if (existingUid) {
      const existing = await BT.repo.getItem(existingUid);
      if (existing) { toast(`Already on your shelves as “${STATUS_WORD[existing.user.status]}”.`); return existing; }
    }
    const item = BT.normalize.withDefaults(stub, opts.status || 'want', opts.source || 'search');
    item.scope = opts.scope || stub.scope || 'open';
    retier(item);
    await BT.repo.putItem(item);
    /* First observation is a baseline and emits nothing. Without it the very
       first sighting of a record reads as a change against an empty snapshot,
       and adding a book announces that its title, its date and its page count
       all just "changed". */
    await BT.repo.putSnapshot(baselineSnapshot(item));

    toast(`Added “${BT.util.truncate(item.title, 40)}”`, {
      actionLabel: 'Undo',
      onAction: async () => { await BT.repo.deleteItem(item.uid); BT.router.resolve(); },
    });
    /* Fired, not awaited. The item is already in the database and already on
       screen; enrichment is allowed to take as long as Open Library's ~1-3
       requests per second allows, and is never the reason an add feels slow. */
    hydrate(item.uid).catch(e => console.warn('[ui] hydrate failed', e));
    return item;
  }

  /* Fill in the detail a search result does not carry — description, subjects,
     page count, the editions list.

     ── SEAM ──────────────────────────────────────────────────────────────
     The Open Library adapter (20-openlibrary.js) lands in M2. Until then, and
     on any load where that file failed to parse, this hands back the record it
     was given rather than throwing. That is not defensive padding: addItem
     calls this AFTER the write has already succeeded, so a missing enrichment
     source must never be able to turn a completed add into a rejected promise
     the user sees as a failure.

     The contract the adapter has to meet is one function:

       BT.openlibrary.hydrate(item, opts) -> a normalized partial item, or null

     Everything after that — merging, clearing `partial`, re-tiering, writing —
     is this function's job and stays here, so the adapter never touches the
     repo and the "views and sync go through BT.repo" rule holds all the way
     down. */
  async function hydrate(uid, opts) {
    opts = opts || {};
    const item = await BT.repo.getItem(uid);
    if (!item) return null;

    const ol = BT.openlibrary;
    if (!ol || typeof ol.hydrate !== 'function') return item;

    const meta = item.meta || (item.meta = {});
    /* An open item is a WORK record and a closed one is an EDITION, and the two
       go stale at very different rates — a work gains editions, an edition is a
       frozen artefact. See BT.TTL for why both numbers are days rather than
       hours. */
    const ttl = item.scope === 'closed' ? BT.TTL.edition : BT.TTL.work;
    if (!meta.partial && Date.now() - (meta.detailsFetchedAt || 0) < ttl) return item;

    const fresh = await ol.hydrate(item, opts);
    if (!fresh) return item;

    const merged = BT.normalize.mergeItem(item, fresh);
    merged.meta.partial = 0;
    merged.meta.detailsFetchedAt = Date.now();
    retier(merged);
    await BT.repo.putItem(merged);
    BT.repo.dfObserve(merged.uid, Object.keys((merged.rec && merged.rec.terms) || {}));
    return merged;
  }

  async function setStatus(uid, status) {
    const item = await BT.repo.getItem(uid);
    if (!item) return null;
    const before = item.user.status;
    item.user.status = status;
    if (status === 'reading' && !item.user.startedAt) item.user.startedAt = Date.now();
    if (status === 'finished') { item.user.finishedAt = Date.now(); BT.repo.addHistory(uid, 'finished'); }
    retier(item);
    await BT.repo.putItem(item);
    toast(`Moved to ${STATUS_WORD[status]}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        const it = await BT.repo.getItem(uid);
        if (it) { it.user.status = before; await BT.repo.putItem(it); BT.router.resolve(); }
      },
    });
    return item;
  }

  /* ── The sell pile ─────────────────────────────────────────────────────
     `pile` is null | 'sell' | 'sold'. Writing it never touches user.status:
     marking a book to sell says nothing about whether it was read, and a flow
     that quietly reset the status would lose the one fact the reader cares
     about keeping. */
  async function setPile(uid, pile) {
    const item = await BT.repo.getItem(uid);
    if (!item) return null;
    const before = item.user.pile || null;
    item.user.pile = pile || null;
    await BT.repo.putItem(item);
    toast(`${BT.util.truncate(item.title, 32)} → ${pileLabel(pile)}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        const it = await BT.repo.getItem(uid);
        if (it) { it.user.pile = before; await BT.repo.putItem(it); BT.router.resolve(); }
      },
    });
    return item;
  }

  /* ONE toast for the batch, not one per item.

     Per-item toasts were unusable at the scale this flow is actually for: a
     shelf clear-out is twenty or thirty books at a time, and twenty stacked
     toasts covered the list they were describing, expired at twenty different
     moments, and offered twenty separate Undos — pressing the top one restored
     a single book while the other nineteen stayed moved, which reads as the
     Undo being broken. A batch is one action to the person who performed it,
     so it gets one confirmation and one Undo that reverses all of it.

     Note that the undo restores each item's OWN previous pile rather than a
     single value: a mixed selection (some already 'sell', some untouched) must
     come back mixed, and restoring them all to null would silently clear marks
     the reader made earlier.

     Writes are quiet and the change is announced once at the end, so the list
     re-renders a single time instead of once per book.

     `updatedAt` is stamped BY HAND here, and that line is load-bearing.
     putItemQuiet exists for the background sweep and deliberately does not bump
     it — a refresh that rewrote the timestamp would make every swept item look
     newer than the other device's genuine edits. A bulk pile change is the
     opposite case: it is a user edit, and without the stamp the merge sees an
     older record and throws thirty sell marks away on the next sync. Quiet
     means "do not re-render", not "do not count". */
  async function bulkSetPile(uids, pile) {
    const before = new Map();
    const now = Date.now();
    for (const uid of uids || []) {
      const item = await BT.repo.getItem(uid);
      if (!item) continue;
      before.set(uid, item.user.pile || null);
      item.user.pile = pile || null;
      item.user.updatedAt = now;
      await BT.repo.putItemQuiet(item);
    }
    if (!before.size) return 0;
    BT.repo.emit('item:put', null);

    toast(`${BT.util.pluralize(before.size, 'book')} → ${pileLabel(pile)}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        const t = Date.now();
        for (const [uid, prev] of before) {
          const it = await BT.repo.getItem(uid);
          if (it) { it.user.pile = prev; it.user.updatedAt = t; await BT.repo.putItemQuiet(it); }
        }
        BT.repo.emit('item:put', null);
        BT.router.resolve();
      },
    });
    return before.size;
  }

  const confirmDialog = m => window.confirm(m);

  return {
    esc, dateField, waterline, precisionTag, dateCell, whenText, driftBadge, shortWhen,
    poster, posterUrl, chipart, hues,
    genresOf, genreTag, formatOf, formatIcon, statusCell, pileTag, pileLabel,
    upcomingRelease, publishedKey, hasPublished,
    progressOf, progressFraction, progressText, progressBar, totalPagesOf, pagesCell, setProgress,
    table, tableRow, grid, COLUMNS,
    emptyState, errorBox, skeletonGrid, groupHead, toast, banner, crumb, paneActions,
    selection,
    addItem, hydrate, setStatus, setPile, bulkSetPile, confirmDialog,
    STATUS_WORD, PILE_WORD, FORMAT_LABEL,
  };
})();
