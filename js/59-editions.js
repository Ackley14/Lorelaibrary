/* ══════════════════════════════════════════════════════════════════════════
   The editions picker — "which of these is the copy on your shelf?"

   An `open` item is a WORK. The reader said "Dune", not the 1990 Ace
   paperback, so nothing on that record claims a publisher, an extent, a cover
   or an ISBN. This overlay is one of the two ways it becomes a CLOSED item —
   choose the printing from a list — and the scanner is the other. Both end in
   the same call, BT.scan.pinEdition(), because pinning is ONE operation with
   one set of id-namespace consequences, and two implementations of it would
   disagree within a week. No `isbn13:` row is written here — that claim is
   pinEdition's alone. The `isbncand:` rows this file does cause (see absorb())
   are written by BT.repo from item state, never by hand.

   THREE MEASURED FACTS shape everything below. All three were counted across
   The Hobbit's 481 catalogued editions, and each one breaks a picker that
   assumes otherwise:

   1. THE LIST IS LONG, AND PAGED AT 50. /works/{id}/editions.json takes
      `?offset=` and nothing else — there is no `page` parameter, and passing
      one is silently ignored, so a loop over it pages forever across the same
      fifty rows. `?limit=1000` genuinely works and genuinely returns all 481
      in one 0.48 MB payload; it is a background job, never something a person
      waits on with a phone in their hand. So: fifty at a time, on request.

   2. THE FIELDS ARE MOSTLY MISSING. 40% of those editions carry no page
      count, 38% no physical format, 34% no cover. A row that assumes any of
      them renders as a blank strip, and the picker fails hardest exactly
      where it is needed — the backlist, which is where unpinned books live.
      Every field degrades into the app's hatch grammar instead, so a gap
      reads as "the record does not say" rather than as a rendering fault.

   3. 13% CARRY NO ISBN AT ALL. Those editions CANNOT be pinned: the pinned
      namespace is `isbn13:{isbn}` (see 12-repo.js) and there is nothing to
      put in it. Such a row says so where its button would be, rather than
      offering one that could only fail.

   ── ENGLISH ONLY, AND THE COUNT IS SHOWN ──────────────────────────────────
   A classic's editions list is largely translations, and scrolling past forty
   Spanish and German printings to find the paperback in your hand is not a
   picker. BT.lang is the app's ONE language rule and is applied here as it is
   on every other discovery surface: a row that positively declares another
   language is dropped, a row that declares nothing is KEPT — 38% of these
   entries carry no `languages` field at all, and a strict test would delete
   most of the list rather than narrow it.

   THE NUMBER HIDDEN IS PUT IN THE FOOTER. A picker that silently shows eleven
   of fifty rows is a picker that tells the reader their edition does not exist,
   which is the same failure as showing fifty of four hundred and eighty-one
   without saying so.

   THE FILTER NEVER TOUCHES PAGING. `nextOffset` advances by what the ENDPOINT
   returned, not by what survived — advancing by the kept count would re-request
   rows already seen, forever, against a source that grants one request per
   second. And scanning is exempt from all of this: a barcode resolves through
   BT.scan and never comes near this file.

   Scrolling 481 rows is not a picker, so there is a filter over publisher,
   year and ISBN. It filters what has been FETCHED, which is why the footer
   states how far through the list we are and why "no match" is phrased as
   "not fetched yet" rather than "not in the catalogue".

   IT IS AN OVERLAY, NOT A ROUTE, and that is not a layout preference. An iOS
   standalone PWA revokes camera permission the moment `location.hash` changes
   (WebKit 215884, still open), so the scanner runs as an overlay and anything
   that can sit alongside it must not touch the hash. A picker living at
   #/editions/{uid} would kill a live camera behind it — and would put a modal
   in the back button's history besides.
   ══════════════════════════════════════════════════════════════════════════ */

BT.editions = (function () {
  const esc = BT.util.escapeHtml;

  /* One page. Asking for more than 50 does not get more than 50 — the endpoint
     caps it — and asking for 1000 is the 0.48 MB payload described above. */
  const PAGE = 50;

  /* The overlay shell. 04-views.css owns `.editions` and everything inside it;
     what it does not own is the fixed layer that box sits on, so those six
     declarations live here rather than requiring an edit to a stylesheet this
     milestone does not own.

     z-index 50 is chosen rather than inherited: above the inspector drawer
     (--bt-z-drawer 45) and its scrim (35), and DELIBERATELY BELOW the toast
     layer (60). The scanner sits at 150 and documents that it covers the
     toasts, which is why scan feedback has to come from its own log. This
     overlay has no camera to fill the screen with, so keeping toasts on top
     means a refused pin can be reported the way the rest of the app reports
     everything else. */
  const SHELL_CSS = 'position:fixed;inset:0;z-index:50;display:flex;'
    + 'align-items:center;justify-content:center;'
    + 'padding:var(--bt-space-6);background:var(--bt-scrim)';

  /* ── Session state ─────────────────────────────────────────────────────
     All of it is cleared by close(). `rows` only ever grows — pages are
     appended, never re-ordered — which is what lets a pick button carry a
     bare index that stays correct across every re-render and every filter. */
  let uid = null;
  let item = null;
  let workOlid = '';
  let rows = [];
  let total = 0;          // what the endpoint says the work has, not what we hold
  let hidden = 0;         // fetched, then dropped for declaring another language
  let nextOffset = 0;
  let hasMore = false;
  let busy = false;
  let failure = null;
  let needle = '';
  let picking = false;    // a pin is in flight; nothing else may write the item

  let root = null;        // the overlay element, or null when closed
  let ac = null;          // AbortController for the page in flight
  /* How many rows the row box currently holds AS A PLAIN UNFILTERED LIST, or
     -1 when it holds anything else (a filtered list, an empty state, the
     loading line). It is what lets a new page be appended rather than
     rebuilt — see appendRows. */
  let domFullCount = -1;
  let io = null;
  let keyGuard = null;
  let focusGuard = null;
  let restoreFocus = null;
  let pressedBackdrop = false;

  /* ══ READING AN EDITION RECORD ══════════════════════════════════════════
     Entries on an editions page are raw Open Library edition docs, and field
     presence is the whole problem — see fact 2 in the header. Every accessor
     below answers "or nothing", and the renderer decides what nothing looks
     like. Nothing here throws on a shape it has not seen. */

  const pos = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  /* The ISBN this row can be pinned to, or null.

     Checksum-verified, and the ten-digit form widened rather than dropped —
     the same rule as BT.openlibrary.harvestIsbn13s, and for the same reason.
     Pre-2007 printings often list only the ISBN-10, so dropping it would make
     a large slice of the backlist unpinnable for no reason; and an ISBN that
     does not check is a row in the id index that no barcode can ever match,
     which nobody would ever notice was there. */
  function isbnOf(raw) {
    for (const v of ((raw && raw.isbn_13) || [])) {
      const d = String(v || '').replace(/\D/g, '');
      if (d.length === 13 && BT.util.isValidEan13(d)) return d;
    }
    for (const v of ((raw && raw.isbn_10) || [])) {
      const w = BT.util.isbn10to13(v);
      if (w) return w;
    }
    return null;
  }

  /* Publishers are free text and MARC habits leave a trailing full stop
     ('Chilton Books.'), which is the difference between one row and two in
     any list a human is scanning down. */
  function publisherOf(raw) {
    for (const p of ((raw && raw.publishers) || [])) {
      const name = typeof p === 'string' ? p : (p && p.name);
      if (!name) continue;
      const s = String(name).trim().replace(/[.,;]+$/, '').trim();
      if (s) return s;
    }
    return '';
  }

  /* '/languages/spa' on an edition, a bare 'spa' on older rows. */
  function langOf(raw) {
    for (const l of ((raw && raw.languages) || [])) {
      const key = typeof l === 'string' ? l : ((l && l.key) || '');
      const m = /([a-z]{3})$/i.exec(String(key).trim());
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  /* One raw entry → everything the row needs, resolved once.

     The date goes through BT.normalize.buildRelease rather than being read off
     `publish_date` directly, because that field is five decades of cataloguer
     free text — '1991', 'c1991', '[1991]', 'Sept 2012', 'Mar 06, 2012',
     '19uu' — and the parsing ladder for it already exists. The row then shows
     only the YEAR, which is coarser than the record and never finer: omitting
     detail is honest, inventing a day is not. The original string is kept for
     the row's tooltip, since '1st ed., 1991' says something the digits do
     not. */
  function rowOf(raw) {
    const rel = BT.normalize.buildRelease((raw && raw.publish_date) || '', {
      basis: 'edition-published',
      inPrint: true,          // an edition record IS a physical artefact
    });
    const parts = BT.util.sortKeyToParts(rel.sortKey);
    const covers = BT.OL.usableCovers(raw && raw.covers);
    const r = {
      raw,
      isbn13: isbnOf(raw),
      publisher: publisherOf(raw),
      title: String((raw && raw.title) || '').trim(),
      format: String((raw && raw.physical_format) || '').trim(),
      pages: pos(raw && raw.number_of_pages),
      lang: langOf(raw),
      year: parts ? parts.y : null,
      dateRaw: rel.raw,
      coverId: covers.length ? covers[0] : null,
      olid: BT.util.olid(raw && raw.key),
    };
    /* One flattened haystack per row, built once. Hyphens are stripped from
       both sides of the comparison so a reader typing an ISBN off a copyright
       page — where it IS hyphenated — matches the bare digits we hold. */
    r.hay = [r.publisher, r.title, r.year || '', r.isbn13 || '', r.format, r.lang, r.olid]
      .join(' ').toLowerCase().replace(/-/g, '');
    return r;
  }

  /* ══ RENDERING ══════════════════════════════════════════════════════════ */

  const hatch = n => `<span class="hatch">${'▨'.repeat(n)}</span>`;

  /* The cover thumb, and note what the pseudo-item's `ids` are: EMPTY, on
     purpose.

     BT.ui.posterUrl falls back from a cover id to a by-ISBN cover request, and
     that fallback is right on an item page and wrong here. 34% of these
     entries have no cover, covers.openlibrary.org is a separate service capped
     at 100 requests per IP per 5 MINUTES (BT.NET_POLICY.covers), and a
     coverless edition asked for by ISBN answers 404 — so a single page of 50
     rows would spend a sixth of that budget confirming what the record already
     told us. With no ids to fall back to, a coverless row draws the generated
     cloth block and costs nothing.

     What keeps the rest inside the cap is `loading="lazy"` on the <img> (which
     BT.ui.poster sets) inside a `content-visibility: auto` row (which
     04-views.css sets): a 481-row list requests roughly a screenful at a time
     rather than 481 at once. Both halves are load-bearing.

     The hue is taken from the PUBLISHER rather than the book's title, which is
     what stops a column of generated blocks for one work being forty tiles of
     the same colour — and it means two printings from the same imprint share a
     cloth, which is a grouping worth being able to see down the list. */
  function thumb(r) {
    return BT.ui.poster({
      title: r.publisher || r.title || (item && item.title) || '?',
      images: { coverId: r.coverId, covers: [] },
      ids: {},
    }, { size: 'sm' });
  }

  /* No hyphenation of the ISBN, ever. The group breaks depend on the
     registration-group and registrant ranges, which we do not carry — an
     invented grouping is a wrong ISBN printed on the screen, and the reader is
     about to compare it against the one on the book in their hand. */
  /* No language column. Every row that reaches here either declares the
     reader's language or declares none, so a code would be either constant or
     blank — and a column that is always the same is a column that hides the
     three that are not. What was dropped is counted in the footer instead. */
  function rowHtml(r, i, pinned) {
    const picked = !!(r.isbn13 && pinned.has(r.isbn13));

    const bits = [];
    bits.push(r.year ? `<span class="mono">${r.year}</span>` : hatch(4));
    bits.push(r.format ? `<span>${esc(BT.util.truncate(r.format, 26))}</span>` : hatch(3));
    bits.push(r.pages ? `<span><span class="mono">${r.pages}</span> pp</span>` : hatch(3));
    const meta = bits.join('<span class="sep">·</span>');

    const isbnCell = r.isbn13
      ? `<span class="ed-isbn">${esc(r.isbn13)}</span>`
      : `<span class="ed-isbn">${hatch(13)}</span>`;

    /* Three states for the last column, and the middle one is the one that
       matters: an edition Open Library holds no usable ISBN for cannot enter
       the pinned namespace, so it says so instead of offering a button that
       would have to fail. "Usable" rather than "present" because isbnOf also
       rejects an ISBN whose check digit does not hold — a catalogue typo — and
       pinning to one of those would write an index row that no barcode on
       earth could ever match. */
    const action = !r.isbn13
      ? '<span class="faint" style="display:inline-block;max-width:12ch;line-height:1.25;font-size:var(--bt-fs-micro)">no usable ISBN</span>'
      : picked
        ? '<span class="faint" style="font-size:var(--bt-fs-micro)">pinned</span>'
        : `<button class="btn btn--sm" type="button" data-pick="${i}">This one</button>`;

    const pub = r.publisher
      ? esc(r.publisher)
      : (r.title ? esc(r.title) : '<span class="faint">Publisher not recorded</span>');

    const tip = [r.publisher || r.title || 'Edition', r.dateRaw || 'no date recorded', r.olid]
      .filter(Boolean).join(' · ');

    return `<div class="edrow${picked ? ' picked' : ''}" title="${esc(tip)}">`
      + thumb(r)
      + `<div class="ed-pub">${pub}</div>`
      + `<div class="ed-meta">${meta}${isbnCell}</div>`
      + `<div class="ed-pick">${action}</div>`
      + '</div>';
  }

  /* AND across whitespace-separated terms: "penguin 1991" narrows, it does not
     widen. Terms are matched as substrings because the fields being searched
     are proper nouns and digits, where a prefix match is what a person means. */
  function visibleRows() {
    if (!needle) return rows.map((r, i) => [r, i]);
    const terms = needle.split(/\s+/).filter(Boolean);
    const out = [];
    rows.forEach((r, i) => {
      for (const t of terms) if (r.hay.indexOf(t) < 0) return;
      out.push([r, i]);
    });
    return out;
  }

  function pinnedSet() {
    const s = new Set(item && item.isbnsPinned ? item.isbnsPinned : []);
    const one = item && item.ids && item.ids.isbn13;
    if (one) s.add(one);
    return s;
  }

  function renderRows() {
    const box = root && root.querySelector('#edRows');
    if (!box) return;
    const shown = visibleRows();

    if (!shown.length) {
      box.innerHTML = `<div class="editions-empty">${
        busy ? 'Fetching editions…'
        : needle ? `Nothing fetched so far matches <b>${esc(needle)}</b>.`
        : 'No editions listed. Scan the barcode on your copy to pin it.'
      }</div>`;
      domFullCount = -1;
      return;
    }

    const pinned = pinnedSet();
    let html = '';
    for (const [r, i] of shown) html += rowHtml(r, i, pinned);
    box.innerHTML = html;
    domFullCount = needle ? -1 : rows.length;
  }

  /* A new page is APPENDED to an unfiltered list, never rebuilt into one, and
     that is not a micro-optimisation. A rebuild re-creates every <img> above
     the fold as well as below it, and covers.openlibrary.org is capped at 100
     requests per IP per 5 minutes — paging four times through a classic would
     spend that budget on covers already on the screen. It also throws away the
     scroll position's anchor and the `content-visibility` state of every row
     the reader has already been past. */
  function appendRows(start) {
    const box = root && root.querySelector('#edRows');
    if (!box) return;
    const pinned = pinnedSet();
    let html = '';
    for (let i = start; i < rows.length; i++) html += rowHtml(rows[i], i, pinned);
    box.insertAdjacentHTML('beforeend', html);
    domFullCount = rows.length;
  }

  function renderCount() {
    const el = root && root.querySelector('#edCount');
    if (!el) return;
    const shown = needle ? visibleRows().length : rows.length;
    el.textContent = needle
      ? `${shown} matching · ${rows.length}/${total || rows.length} fetched`
      : `${rows.length}/${total || rows.length}`;
  }

  /* The footer carries the paging control and the one caveat this list cannot
     do without: how much of it we are actually looking at. A picker that
     silently shows fifty of four hundred and eighty-one rows is a picker that
     tells the reader their edition does not exist. */
  function renderFoot() {
    const foot = root && root.querySelector('#edFoot');
    if (!foot) return;
    /* The footer is a bordered bar with padding, so an EMPTY one is a dead
       strip under the list rather than nothing at all. It is hidden outright
       whenever it has nothing to say. */
    const write = html => { foot.innerHTML = html; foot.style.display = html ? '' : 'none'; };

    if (busy) { write('<span>Fetching editions…</span>'); return; }

    if (failure) {
      write(`<span style="color:var(--bt-coral-text)">${esc(failure)}</span>`
        + '<button class="btn btn--sm" type="button" data-act="retry">Try again</button>');
      return;
    }

    const parts = [];
    if (hasMore) {
      parts.push('<button class="btn btn--sm" type="button" data-act="more">Load 50 more</button>');
      parts.push(`<span>${rows.length} of ${total} fetched</span>`);
    } else if (rows.length) {
      parts.push(`<span>${BT.util.pluralize(rows.length, 'edition')}</span>`);
    }
    const noIsbn = rows.reduce((n, r) => n + (r.isbn13 ? 0 : 1), 0);
    if (noIsbn) parts.push(`<span class="faint">${noIsbn} with no ISBN cannot be pinned</span>`);
    /* Stated, never silent. Without this the reader searching for a printing
       that IS in the list but is catalogued in another language reads an empty
       filter box as "your edition is not in the catalogue". */
    if (hidden) parts.push(`<span class="faint">${hidden} in other languages hidden</span>`);
    write(parts.join(''));
  }

  function render() { renderRows(); renderCount(); renderFoot(); }

  /* ══ PAGING ═════════════════════════════════════════════════════════════ */

  /* The button the reader just pressed does not survive the repaint, and a
     removed element does not hand its focus on — it drops to <body>, from
     which the next Tab restarts at the top of the document. So whether the
     footer HAD focus is recorded before anything is rewritten, and aimed at
     the replacement afterwards. */
  const footHasFocus = () => !!(root && document.activeElement
    && root.contains(document.activeElement) && document.activeElement.closest('#edFoot'));

  function refocusFoot(had) {
    if (!had || !root) return;
    const next = root.querySelector('#edFoot [data-act]') || root.querySelector('#edCard');
    if (next) next.focus();
  }

  async function loadPage() {
    if (busy || !root || !workOlid) return;
    if (rows.length && !hasMore) return;

    const refocus = footHasFocus();
    busy = true;
    failure = null;
    renderFoot();

    let page = null;
    try {
      page = await BT.openlibrary.editionsOfWork(workOlid, {
        offset: nextOffset,
        limit: PAGE,
        signal: ac ? ac.signal : undefined,
      });
    } catch (e) {
      busy = false;
      if (!root) return;                       // closed under us; nothing to report to
      if (e && e.kind === 'abort') return;
      /* 05-net has already written a human sentence for every kind it
         classifies — offline, maintenance, timeout — so it is shown as-is
         rather than paraphrased into something vaguer. */
      failure = (e && e.message) || 'Could not reach Open Library.';
      renderFoot();
      refocusFoot(refocus);
      return;
    }
    busy = false;
    if (!root) return;

    const start = rows.length;
    const got = (page.entries || []).length;
    /* THE FILTER RUNS OVER WHAT ARRIVED; THE PAGER DOES NOT SEE IT. `got` is
       the endpoint's own count and is what `nextOffset` advances by — using the
       kept count instead would re-request rows already seen, for ever, against
       a source that grants about one request per second. */
    const sifted = BT.lang.keep(page.entries || [], BT.lang.acceptsEdition);
    hidden += sifted.dropped;
    for (const e of sifted.kept) rows.push(rowOf(e));
    total = Math.max(Number(page.size) || 0, rows.length + hidden);
    /* Advance by what ARRIVED, not by PAGE. A short page — which happens on the
       last one, and on works whose entries are being merged upstream — would
       otherwise leave a hole in the sequence that nothing ever fetches. */
    nextOffset = (page.offset || 0) + got;
    /* An EMPTY page ends the list whatever `size` claims. Without this the
       sentinel below would ask for the same offset for ever, which is a silent
       request loop against a source that grants about one per second. */
    hasMore = !!page.hasMore && got > 0;

    if (got && !needle && domFullCount === start) { appendRows(start); renderCount(); renderFoot(); }
    else render();
    refocusFoot(refocus);
    await absorb(page);
  }

  /* Every page we fetch is also a gift to the scanner, and throwing it away
     would be waste with a visible cost: those ISBNs become `isbncand:` rows
     (12-repo.js), which is what lets a later scan of a DIFFERENT printing say
     "you already have an unspecified copy of this — is this the one?" instead
     of silently adding a duplicate. BT.normalize.absorbEditions is the one
     place an editions listing is allowed to become item state; this calls it
     and writes through BT.repo, and does not touch an id namespace itself.

     THE RE-READ IS THE POINT. This overlay has been open for as long as the
     reader has been scrolling, so the copy it started with is stale by
     definition. Writing that stale object back after a pick had narrowed the
     item would resurrect it — candidates restored, scope reopened, the chosen
     copy unpinned — in one quiet putItem that nothing would ever report. So:
     re-read, refuse if it has been closed since, and refuse while a pin is in
     flight. Quiet, because this is derived state and nobody asked for it. */
  async function absorb(page) {
    const target = uid;
    if (!target || picking) return;
    if (!page || !(page.entries || []).length) return;
    if (!BT.normalize || typeof BT.normalize.absorbEditions !== 'function') return;
    try {
      const cur = await BT.repo.getItem(target);
      if (!cur || cur.scope === 'closed' || picking) return;
      BT.normalize.absorbEditions(cur, page);
      await BT.repo.putItemQuiet(cur);
      if (uid === target) item = cur;
    } catch (e) {
      console.warn('[editions] could not record candidate ISBNs', e);
    }
  }

  /* ══ PICKING ════════════════════════════════════════════════════════════ */

  async function pick(index) {
    const r = rows[index];
    if (!r || !r.isbn13 || picking) return;

    if (!(BT.scan && typeof BT.scan.pinEdition === 'function')) {
      /* Deliberately not a half-pin. Narrowing an item rewrites its ISBN rows
         out of `isbncand:` and into `isbn13:`, and doing part of that here
         would leave the record claiming a copy nobody verified — with a silent
         failure mode, since a later scan of another printing would then
         resolve to this item instead of adding the book in the reader's
         hand. */
      BT.ui.toast('Pinning an edition needs the scan module, which is not on this page.', { bad: true });
      return;
    }

    picking = true;
    try {
      /* `isbn13:{isbn}` is ONE row in the id index and two items cannot both
         hold it — the later write takes it, in silence, and every future scan
         of that barcode then resolves to whichever record wrote last. If the
         reader really does own two copies of the same printing, the record
         that already claims it is the one to edit. */
      const held = await BT.repo.resolveScan(r.isbn13);
      if (held && held.via === 'pinned' && held.uid !== uid) {
        const other = await BT.repo.getItem(held.uid);
        BT.ui.toast(`That ISBN is already pinned to “${
          BT.util.truncate((other && other.title) || 'another record', 32)}”.`, { bad: true });
        picking = false;
        return;
      }
      /* pinEdition MERGES what it is handed into the record (through
         BT.normalize.mergeItem), so it has to be given an ITEM — not the raw
         Open Library entry this row was built from. Merging the raw payload
         would splice `publish_date`, `physical_format` and a bare `publishers`
         array onto the record, and none of the derived fields the app renders
         from — release, facets.format, rec.terms — would exist at all.

         fromEdition is the normalizer for exactly this payload, and passing
         the ISBN into it is not decoration: field presence on edition docs is
         unreliable enough that `isbn_13` can be missing from a record fetched
         BY ISBN, so `opts.isbn13` makes the code the reader actually chose win
         over whatever the record does or does not carry. */
      const stub = BT.normalize.fromEdition(r.raw, { isbn13: r.isbn13 });
      await BT.scan.pinEdition(uid, r.isbn13, stub);
    } catch (e) {
      console.warn('[editions] pin failed', e);
      BT.ui.toast((e && e.message) || 'Could not pin that edition.', { bad: true });
      picking = false;
      return;
    }

    /* Captured before close(), which clears every field on this module. */
    const pinnedUid = uid;
    close();
    /* No success toast: 57-scan owns the wording of a pin, and the inspector
       reopening with an Edition block that now names a publisher, an extent
       and an ISBN is the loudest confirmation available. */
    if (BT.inspector && typeof BT.inspector.show === 'function') BT.inspector.show(pinnedUid);
    BT.router.resolve();
  }

  /* ══ THE OVERLAY ════════════════════════════════════════════════════════ */

  function mount() {
    unmount();
    restoreFocus = document.activeElement;

    root = document.createElement('div');
    root.id = 'editionsOverlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `Editions of ${(item && item.title) || 'this book'}`);
    root.style.cssText = SHELL_CSS;

    root.innerHTML = `
      <div class="editions" id="edCard" tabindex="-1"
           style="width:min(680px,100%);max-height:min(86vh,86dvh);outline:none">
        <div class="editions-head">
          <span>Which copy is yours</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
                       text-transform:none;letter-spacing:0;font-weight:500;
                       font-family:var(--bt-font-serif);font-size:var(--bt-fs-base);
                       color:var(--bt-text-primary)">${esc(BT.util.truncate((item && item.title) || '', 46))}</span>
          <span class="editions-count" id="edCount"></span>
          <button class="icobtn" id="edClose" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <div class="filter">
          <svg class="mag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="edFilter" type="search" spellcheck="false" autocomplete="off"
                 placeholder="Publisher, year or ISBN…" aria-label="Filter editions">
        </div>

        <div class="editions-scroll" id="edScroll">
          <div id="edRows"><div class="editions-empty">Fetching editions…</div></div>
          <div id="edSentinel"></div>
        </div>

        <div class="editions-more" id="edFoot"><span>Fetching editions…</span></div>
      </div>`;

    document.body.appendChild(root);

    /* One delegated handler for the whole overlay, for the same reason the
       inspector uses one: this markup is rewritten on every filter keystroke
       and every page, and a listener per button would stack. */
    root.addEventListener('mousedown', e => { pressedBackdrop = (e.target === root); });
    root.addEventListener('click', e => {
      if (e.target.closest('#edClose')) { close(); return; }
      if (e.target.closest('[data-act="more"]') || e.target.closest('[data-act="retry"]')) {
        failure = null;
        loadPage();
        return;
      }
      const btn = e.target.closest('[data-pick]');
      if (btn) { pick(+btn.dataset.pick); return; }
      /* Backdrop dismissal, gated on where the PRESS started. Without that, a
         drag that begins on a row and ends outside the card fires a click on
         the backdrop and closes the picker mid-scroll. */
      if (e.target === root && pressedBackdrop) close();
    });

    const filter = root.querySelector('#edFilter');
    if (filter) {
      const apply = BT.util.debounce(() => {
        needle = filter.value.trim().toLowerCase().replace(/-/g, '');
        render();
      }, 120);
      filter.addEventListener('input', apply);
    }

    /* Escape, in the CAPTURE phase, and it has to be. The inspector binds its
       own Escape handler on `document` at boot — earlier than this one — so a
       bubbling listener here would run AFTER it, and dismissing the picker
       would also close the inspector drawer out from under the reader on a
       phone. A capture listener on document runs before every bubble listener
       on it, and stopping propagation there means they never see the key.

       A filter with text in it eats the first Escape: "clear what I typed" is
       what that key means in a search box, and throwing away four fetched
       pages because someone wanted their query back is not a trade anyone
       would choose. */
    keyGuard = e => {
      if (e.key !== 'Escape' || !root) return;
      e.stopPropagation();
      e.preventDefault();
      const f = root.querySelector('#edFilter');
      if (f && f.value) {
        f.value = '';
        needle = '';
        render();
        return;
      }
      close();
    };
    document.addEventListener('keydown', keyGuard, true);

    /* A modal over an app whose three panes are all still tabbable. Rather
       than enumerate focusable children — which changes on every re-render —
       pull focus back whenever it lands outside the card. Handles Tab,
       Shift+Tab and a stray click in one rule. */
    focusGuard = e => {
      if (!root || root.contains(e.target)) return;
      const card = root.querySelector('#edCard');
      if (card) card.focus();
    };
    document.addEventListener('focusin', focusGuard, true);

    /* The CARD takes focus, not the filter box. Focusing an input opens the
       on-screen keyboard, and this picker's first interaction on a phone is
       scrolling a list that the keyboard would then be covering half of. The
       card is `tabindex="-1"` so a screen reader still lands inside the dialog
       and one Tab reaches the filter. */
    const card = root.querySelector('#edCard');
    if (card) card.focus();

    /* Reaching the bottom of the list asks for the next fifty. The explicit
       "Load more" button in the footer is still the control — it is what works
       without IntersectionObserver, and it is what a reader looks for — but
       tapping it ten times to reach a 1994 printing is not a picker either.

       Two gates keep this from becoming a request loop against a source that
       grants roughly one per second: it never fires while a page is in flight,
       and it never fires while the filter box has text in it. That second one
       is not fussiness — a filter matching nothing leaves the sentinel
       permanently in view, so without it a typo would quietly page through all
       481 editions. */
    if (typeof IntersectionObserver === 'function') {
      const scroll = root.querySelector('#edScroll');
      const sentinel = root.querySelector('#edSentinel');
      if (scroll && sentinel) {
        io = new IntersectionObserver(entries => {
          for (const en of entries) {
            if (en.isIntersecting && !busy && !needle && !failure && hasMore) loadPage();
          }
        }, { root: scroll, rootMargin: '120px' });
        io.observe(sentinel);
      }
    }
  }

  function unmount() {
    if (io) { io.disconnect(); io = null; }
    if (keyGuard) { document.removeEventListener('keydown', keyGuard, true); keyGuard = null; }
    if (focusGuard) { document.removeEventListener('focusin', focusGuard, true); focusGuard = null; }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  /* No work id, no list — which is now an ORDINARY state rather than a broken
     record: a book added from a Google-only result has a volume id and no
     OLID, because Google has no work graph and Open Library has not catalogued
     next spring's books. The empty state names the way out rather than the
     cause; the cause is in this comment, where it belongs. */
  function renderNoWork() {
    const box = root && root.querySelector('#edRows');
    if (box) {
      box.innerHTML = '<div class="editions-empty">No printings listed for this book.'
        + ' Scan the barcode on your copy to pin it.</div>';
    }
    const foot = root && root.querySelector('#edFoot');
    if (foot) { foot.innerHTML = ''; foot.style.display = 'none'; }
    renderCount();
  }

  /* The third identity case, and the reason it needs its own request.
     A search-added item always carries `ids.olWork`. A scanned one deliberately
     does NOT — 38-normalize declines to claim the work key so that scanning a
     second printing can still create a second item — but it does record
     `ids.workOlid` under a name nothing indexes, which the line in open()
     reads. What is left is a record that came through /api/books, which
     carries NO work key at all: that is the documented cost of the scan hot
     path. One /isbn/ lookup recovers it, and only /isbn/ can, because it is
     the only shape with a `works[]` array on it. */
  async function workOlidFromIsbn(it) {
    const ol = BT.openlibrary;
    if (!ol || typeof ol.workOlidForIsbns !== 'function') return '';
    /* Pinned first — that is the copy the reader actually holds and the ISBN
       most likely to resolve — then the candidates a Google record supplied. */
    const isbns = [].concat(
      (it.ids && it.ids.isbn13) ? [it.ids.isbn13] : [],
      it.isbnsPinned || [],
      it.isbnsCandidate || []);
    if (!isbns.length) return '';
    return ol.workOlidForIsbns(isbns, { signal: ac ? ac.signal : undefined });
  }

  async function open(targetUid) {
    if (!targetUid) return;
    const it = await BT.repo.getItem(targetUid);
    if (!it) {
      BT.ui.toast('That book is no longer on your shelves.', { bad: true });
      return;
    }

    close();                       // never two pickers; also resets every field
    uid = targetUid;
    item = it;
    ac = new AbortController();
    mount();

    workOlid = BT.util.olid((it.ids || {}).olWork || (it.ids || {}).workOlid || '');
    if (!workOlid) workOlid = await workOlidFromIsbn(it);
    if (!root) return;             // closed while that was in the air
    if (!workOlid) { renderNoWork(); return; }

    await loadPage();
  }

  function close() {
    if (ac) { try { ac.abort(); } catch (_) {} }
    ac = null;
    unmount();

    const back = restoreFocus;
    restoreFocus = null;
    uid = null;
    item = null;
    workOlid = '';
    rows = [];
    total = 0;
    hidden = 0;
    nextOffset = 0;
    hasMore = false;
    busy = false;
    failure = null;
    needle = '';
    picking = false;
    pressedBackdrop = false;
    domFullCount = -1;

    /* Focus goes back where it came from — the button in the inspector that
       opened this — but only if that element is still on the page; the pane
       repaints often enough that it may not be. */
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      try { back.focus(); } catch (_) {}
    }
  }

  return {
    open, close,
    get isOpen() { return !!root; },
    get uid() { return uid; },
  };
})();
