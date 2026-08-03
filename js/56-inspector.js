/* ══════════════════════════════════════════════════════════════════════════
   Pane 3 — the inspector.

   Selecting a book anywhere fills this pane. It is the app's only blurred
   surface: the sheet frosts over a wash taken from the book's own cloth
   colour, which is what makes Marginalia read as depth rather than as a flat
   dark palette. Everything else in the app is opaque or plainly translucent,
   because a blur behind every row is the first thing to stutter.

   It is also the app's only EDIT surface — status, progress, ownership, the
   rating and the notes are all written from here — and those two facts fight
   each other. Every control in this file used to rebuild the blurred sheet
   under the reader's thumb, so the rules below are not micro-optimisation:
   `paint()` replaces the CONTENTS of `.sheet` and never `.sheet` itself, and
   skips a byte-identical rebuild outright. See the comment on `invalidate`.

   Below 1180px it detaches into a right-hand drawer, sharing one scrim with
   the index tree.
   ══════════════════════════════════════════════════════════════════════════ */

BT.inspector = (function () {
  const esc = BT.util.escapeHtml;
  let currentUid = null;

  /* What is currently painted, so an identical repaint can be skipped.
     `show()` paints once immediately and again when hydrate resolves; most of
     the time the second render is byte-identical, and writing it anyway tore
     down and rebuilt the one backdrop-filtered element in the app.

     Anything that edits the DOM in place — a rating tick, a status segment,
     the progress readout — MUST call invalidate() afterwards, or a later
     paint compares against a signature that predates the edit and decides,
     wrongly, that nothing needs redrawing. */
  let lastUid = null;
  let lastBody = '';
  const invalidate = () => { lastBody = ''; };

  const el = () => document.getElementById('inspector');

  /* BT.alerts owns the feed's phrasing and lands in M4; the inspector needs
     the same three words now. Three rungs, not MovieTrak's six: a book is
     announced or it is out. There is no theatrical-to-streaming window for a
     record to slip between, so there is nothing else to name. */
  const PUB_STATUS = {
    unannounced: 'Not announced',
    announced: 'Announced',
    published: 'Published',
  };
  const prettyStatus = s => PUB_STATUS[s] || (s ? String(s) : 'Unknown');

  async function show(uid, opts) {
    opts = opts || {};
    currentUid = uid;
    let item = await BT.repo.getItem(uid);

    if (!item) {
      /* Not on the shelves — a stale link, or a row from a search that was
         never added. Fetch read-only so the pane still works, and offer to
         add it. */
      blank(loadingBody());
      try { item = await fetchTransient(uid); }
      catch (e) { blank(BT.ui.errorBox('Could not load this book', e.message || String(e))); return; }
      if (!item) {
        blank(BT.ui.emptyState({
          title: 'Not found',
          body: 'Nothing on your shelves has that id, and there is no catalogue client on the page yet to look it up with.',
        }));
        return;
      }
      item._transient = true;
    }

    paint(item);
    openDrawerIfNarrow();

    if (!item._transient) {
      /* M2 SEAM. BT.ui.hydrate already hands back the record it was given
         while BT.openlibrary is absent, so today this resolves to a no-op and
         the second paint is skipped by the signature check. It stays wired
         from M1 so that the day the adapter lands the pane fills itself in
         without a line changing here. */
      BT.ui.hydrate(uid).then(fresh => {
        if (fresh && currentUid === uid) paint(fresh);
      }).catch(() => {});
    }
    if (!opts.silent) markSelected(uid);
  }

  /* ── M2 SEAM ─────────────────────────────────────────────────────────────
     A uid that is not in the library can only be resolved by asking Open
     Library, and 20-openlibrary.js is not on the page yet. Feature-detected
     rather than assumed: a bare `BT.openlibrary.lookupUid(...)` would be a
     TypeError that takes out the whole pane, for a case whose honest answer
     is only ever "that link is stale".

     The contract the adapter has to meet is one function:

       BT.openlibrary.lookupUid(uid) -> a normalized item stub, or null      */
  async function fetchTransient(uid) {
    const ol = BT.openlibrary;
    if (!ol || typeof ol.lookupUid !== 'function') return null;
    const stub = await ol.lookupUid(uid);
    if (!stub) return null;
    if (BT.normalize && typeof BT.normalize.withDefaults === 'function') {
      return BT.normalize.withDefaults(stub, 'want', 'link');
    }
    return stub;
  }

  function shell(inner, item) {
    /* The fallback pair is warm board-and-ink, matching the --a/--b defaults
       in 04-views.css. A cool default reads as "broken image" against the
       Vellum page. */
    const [a, b] = item ? BT.ui.hues(item.title) : ['#4a3f2f', '#17120c'];
    return `
      <button class="insp-close" id="inspClose" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="wash" style="--a:${a};--b:${b}"></div>
      <div class="sheet">${inner}</div>`;
  }

  /* Every write that replaces the WHOLE pane goes through here — the loading
     skeleton, an error, not-found, the empty state. Dropping the signature is
     the point: without it, painting the same uid again would compare against a
     body captured before the skeleton went up and conclude the skeleton was
     already the finished render. */
  function blank(inner, item) {
    el().innerHTML = shell(inner, item);
    lastUid = null;
    invalidate();
  }

  const loadingBody = () => `<div class="skel insp-poster"></div><div class="skel skel--line" style="width:70%;height:20px;margin-top:14px"></div><div class="skel skel--line"></div>`;

  function empty() {
    blank(`
      <div class="insp-poster" style="background:transparent;box-shadow:none"></div>
      <div style="padding-top:26px">
        ${BT.ui.emptyState({
          title: 'Nothing selected',
          body: 'Pick a book from the list and everything known about it — and everything you have said about it — appears here.',
        })}
      </div>`);
    currentUid = null;
  }

  function paint(item) {
    const host = el();
    const rel = item.release || {};
    const u = item.user || {};
    const total = BT.ui.totalPagesOf(item);

    const body = `
      ${BT.ui.poster(item, { cls: 'insp-poster', size: 'md' })}
      <div class="itype">${BT.ui.genreTag(item)}${BT.ui.precisionTag(rel)}${BT.ui.driftBadge(rel)}</div>
      <div class="ititle">${esc(item.title)}</div>

      <div class="isub">
        ${authorLine(item)}
        <span>·</span>${BT.ui.dateField(rel)}
        ${total ? `<span>· ${esc(BT.util.pagesStr(total))}</span>` : ''}
      </div>

      ${item._transient ? `
      <div class="blk"><button class="btn btn--primary" data-act="add">Add to library</button></div>` : `
      <div class="blk">
        <div class="blk-h">Status</div>
        <div class="seg" role="group" aria-label="Reading status">
          ${['want', 'reading', 'finished', 'dropped'].map(s =>
            `<button type="button" data-status="${s}" aria-pressed="${u.status === s}">${BT.ui.STATUS_WORD[s]}</button>`).join('')}
        </div>
      </div>

      ${progressBlock(item)}

      <div class="blk">
        <div class="blk-h">Ownership <span class="why">not a reading status</span></div>
        <div class="seg" role="group" aria-label="Ownership">
          ${PILES.map(([v, label]) =>
            `<button type="button" data-pile="${v}" aria-pressed="${(u.pile || 'keep') === v}">${label}</button>`).join('')}
        </div>
      </div>

      <div class="blk">
        <div class="blk-h">Yours</div>
        <div class="mine">
          <span class="ticks" id="rateTicks">${
            Array.from({ length: 10 }, (_, i) =>
              `<i class="${u.rating >= i + 1 ? 'on' : ''}" data-rate="${i + 1}" title="${i + 1}/10"></i>`).join('')
          }</span>
          <span class="myscore">${u.rating != null ? `${u.rating}<s>/10</s>` : '<s>unrated</s>'}</span>
        </div>
        <div style="margin-top:var(--bt-space-4)">
          <textarea class="notecard" id="inspNotes" placeholder="Why you want it, who lent it to you, the passage you keep going back to…">${esc(u.notes || '')}</textarea>
        </div>
      </div>`}

      <div class="blk">
        <div class="blk-h">Publication</div>
        <dl class="kv">
          <dt>Status</dt><dd>${esc(prettyStatus(rel.status))}</dd>
          <dt>Date</dt><dd>${BT.ui.dateField(rel)}</dd>
          <dt>Precision</dt><dd>${esc(rel.precision || 'unknown')}${rel.inferred ? ' <span class="faint">(inferred)</span>' : ''}</dd>
        </dl>
        ${driftHistory(rel)}
      </div>

      ${editionBlock(item)}

      ${item._transient ? '' : `
      <div class="blk">
        <button class="btn btn--ghost btn--danger" data-act="remove">Remove from library</button>
      </div>`}
    `;

    /* Replace only the sheet's contents, never the sheet itself. `.sheet`
       carries backdrop-filter and `.wash` is the colour behind it; recreating
       a backdrop-filtered element forces the compositor to rebuild the blurred
       layer, which is exactly the stutter you feel when the pane opens or when
       a rating tick repaints it. */
    const sheet = host.querySelector('.sheet');
    if (sheet && lastUid === item.uid) {
      if (body === lastBody) return;      // nothing actually changed
      sheet.innerHTML = body;
    } else {
      host.innerHTML = shell(body, item);
    }

    /* Cloth colours move as custom properties on the surviving element. */
    const wash = host.querySelector('.wash');
    if (wash) {
      const [a, b] = BT.ui.hues(item.title);
      wash.style.setProperty('--a', a);
      wash.style.setProperty('--b', b);
    }

    lastUid = item.uid;
    lastBody = body;
    wire(item);
  }

  /* Authors, not "credits". Three is the cap: an anthology can list twenty
     contributors and the fourth name has already stopped identifying the book.
     A missing author is stated rather than left blank — a large share of Open
     Library's older records genuinely have none, and an empty slot reads as a
     rendering fault. */
  function authorLine(item) {
    const names = (item.authors || [])
      .map(a => (typeof a === 'string' ? a : (a && a.name)))
      .filter(Boolean);
    if (!names.length) return '<span class="faint">Author not recorded</span>';
    const shown = names.slice(0, 3).join(', ');
    return `<span>${esc(shown)}${names.length > 3 ? ' <span class="faint">+' + (names.length - 3) + '</span>' : ''}</span>`;
  }

  /* ══ OWNERSHIP ════════════════════════════════════════════════════════════
     `user.pile` is a SEPARATE axis from `user.status` and must never be drawn
     as one. A book can be finished and kept, finished and marked to sell, or
     unread and already sold. Collapsing the two into a single control is what
     makes a clear-out unusable: "Sold" would then erase whether you read it.

     'keep' is the button's value for `null`, not a stored value. An empty
     `data-pile=""` reads back as the empty string and is easy to mistake for
     "the attribute is missing", so the round trip is named at both ends. */
  const PILES = [['keep', 'Keep'], ['sell', 'To sell'], ['sold', 'Sold']];
  const pileValue = v => (v === 'sell' || v === 'sold') ? v : null;

  /* ══ PROGRESS ═════════════════════════════════════════════════════════════
     Page-based, because a page is the one figure printed on the object in the
     reader's hand. Percent-only would be unfaithful to what they can see, and
     chapters are not comparable between editions.

     Deliberately an ACTION rather than an always-visible slider, which is
     where this parts company with MovieTrak. A film's position changes
     continuously and gets nudged while the thing is paused; a book's changes
     once per sitting, when it is put down. A slider sitting permanently open
     invites a drag, and a drag against a 600-page denominator is a way to
     record page 314 when you meant 310. Pressing "Add progress" and typing the
     number off the page is both fewer decisions and the only accurate one.

     When there is no extent to measure against — an `open` item is a work
     rather than a copy, so there is often no honest denominator — this
     degrades to a bare position. "p.184" is the whole truth in that case, and
     a bar drawn against a number we invented would be worse than no bar. */
  function progressBlock(item) {
    return `
      <div class="blk">
        <div class="blk-h">How far in <span class="why">pages, off your own copy</span></div>
        <div class="prgctl" id="prgBody">${progressBody(item)}</div>
      </div>`;
  }

  function progressBody(item) {
    const p = BT.ui.progressOf(item) || {};
    const total = BT.ui.totalPagesOf(item);
    const f = BT.ui.progressFraction(item);
    const pct = f == null ? null : Math.round(f * 100);
    const at = p.currentPage != null ? p.currentPage : null;
    const started = at != null;

    const readout = started
      ? (total
          ? `<span class="prgval mono">${pct}%</span><span class="muted">page ${at} of ${total}</span>`
          : `<span class="prgval mono">p.${at}</span><span class="muted">no page count on this record, so no percentage</span>`)
      : `<span class="muted">${(item.user || {}).status === 'finished' ? 'Finished, no position logged' : 'Nothing logged yet'}</span>`;

    /* One field. Correcting the EXTENT belongs to the editions picker (M2):
       choosing which printing you hold is what supplies an authoritative page
       count, and a second box here would be asking the reader to do by hand
       what picking their own edition does for them. */
    return `
      ${started && total ? `<div class="prgmeter"><i style="width:${pct}%"></i></div>` : ''}
      <div class="prgrow">${readout}</div>
      <div class="prgrow" id="prgBtns">
        <button class="btn btn--sm btn--primary" type="button" data-prg="open">Add progress</button>
        ${started ? '<button class="btn btn--sm" type="button" data-prg="clear">Clear</button>' : ''}
      </div>
      <div id="prgForm" hidden>
        <div class="prgrow">
          <label class="prgnum"><input type="number" inputmode="numeric" id="prgPage"
             min="0" step="1" value="${at != null ? at : ''}" aria-label="Page you are on">${
            total ? `of ${total} pages` : 'page'}</label>
          <button class="btn btn--sm btn--primary" type="button" data-prg="save">Confirm</button>
          <button class="btn btn--sm" type="button" data-prg="cancel">Cancel</button>
        </div>
      </div>`;
  }

  /* ══ EDITION ══════════════════════════════════════════════════════════════
     The scope axis, made visible. A `closed` item is one printing the reader
     actually holds — scanned, with its own ISBN, publisher and extent. An
     `open` item is the WORK: they said "Dune", not "the 1990 Ace paperback",
     and the 1965 hardback, that paperback and last year's trade edition
     disagree about every one of those fields. Saying so plainly is better
     than showing whichever edition Open Library happened to surface as though
     the reader had chosen it. */
  function editionBlock(item) {
    const ids = item.ids || {};
    const closed = item.scope === 'closed';
    const isbn = ids.isbn13 || (item.isbnsPinned || [])[0] || null;
    const editionOlid = ids.olEdition || ids.editionOlid || null;
    const publisher = (item.publishers || [])
      .map(p => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean)[0] || null;
    const pages = item.pageCount > 0 ? item.pageCount : null;
    const fmt = BT.ui.formatOf(item);

    /* TWO ways out of `open`, and both are drawn because they fail in
       different places. The picker is the only option for a copy whose barcode
       is torn, foreign, or older than retail barcodes on books; the scan is the
       only bearable option for a work with 481 catalogued editions, which is
       what The Hobbit actually has. See scanPin() for the seam.

       The scan button is omitted entirely — not disabled, not apologetic —
       when there is no camera to open: 58-scanner.js absent, or present and
       reporting no secure context (getUserMedia hands out nothing over
       file://, and a LAN address counts as insecure even on your own network).
       An affordance whose only possible outcome is an excuse is worse than no
       affordance, and #/scan already explains that case at length for the
       reader who came looking for it. */
    if (!closed) {
      return `
        <div class="blk">
          <div class="blk-h">Edition <span class="why">a work, not a copy</span></div>
          <div class="muted" style="font-size:var(--bt-fs-mini);line-height:1.5">
            Edition not specified. Printings of the same book disagree about
            page count, cover, publisher and ISBN, so none of those is claimed
            here until you say which one is on your shelf.
          </div>
          <div style="margin-top:var(--bt-space-3);display:flex;gap:var(--bt-space-2);flex-wrap:wrap">
            <button class="btn btn--sm" type="button" data-act="edition">Specify edition</button>
            ${scannerReady() ? '<button class="btn btn--sm" type="button" data-act="scanpin">Scan the copy I own</button>' : ''}
          </div>
        </div>`;
    }

    return `
      <div class="blk">
        <div class="blk-h">Edition <span class="why">the copy you hold</span></div>
        <dl class="kv">
          <dt>ISBN</dt><dd class="mono">${isbn ? esc(isbn) : '<span class="faint">·&nbsp;·</span>'}</dd>
          <dt>Publisher</dt><dd>${publisher ? esc(publisher) : '<span class="faint">Not recorded</span>'}</dd>
          <dt>Pages</dt><dd class="mono">${pages ? esc(String(pages)) : '<span class="faint">·&nbsp;·</span>'}</dd>
          <dt>Format</dt><dd>${esc(BT.ui.FORMAT_LABEL[fmt] || fmt)}</dd>
          ${editionOlid ? `<dt>Open Library</dt><dd><a href="${esc(BT.OL.base)}/books/${esc(editionOlid)}"
            target="_blank" rel="noopener" style="text-decoration:underline">${esc(editionOlid)} ↗</a></dd>` : ''}
        </dl>
      </div>`;
  }

  /* Publication dates move, and a reader waiting on a preorder is exactly who
     notices. Last three changes, newest first — the whole ledger is on the
     record but nobody reads past the last slip. */
  function driftHistory(rel) {
    const h = (rel.history || []).slice(-3).reverse();
    if (!h.length) return '';
    return `<div style="margin-top:var(--bt-space-4)">
      <div class="blk-h" style="margin-bottom:6px">Date history</div>
      ${h.map(x => `<div class="diff">
        ${BT.ui.dateField({ sortKey: x.from.sortKey, precision: x.from.precision })}
        <span class="faint">→</span>
        ${BT.ui.dateField({ sortKey: x.to.sortKey, precision: x.to.precision })}
        <span class="faint mono" style="font-size:var(--bt-fs-micro)">${esc(BT.util.timeAgo(x.observedAt))}</span>
      </div>`).join('')}
    </div>`;
  }

  /* ══ SCAN THE COPY I OWN ══════════════════════════════════════════════════
     The other half of "specify edition". It opens the camera for exactly one
     barcode and pins whatever comes back to THIS item — the same outcome as
     picking a row in 59-editions, reached from the other end.

     ── M3 SEAM ─────────────────────────────────────────────────────────────
     Almost none of the work happens here. Five functions across two modules
     are asked for, and every one of them is feature-detected, because this
     pane has to survive either file being absent or having failed to parse:

       BT.scanner.isAvailable()                  -> is there a camera to open
       BT.scanner.open({ mode, onCode })         -> the overlay; onCode per read
       BT.scanner.close()                        -> stop the tracks, tear down
       BT.scan.lookup(isbn13)                    -> a normalized edition stub
       BT.scan.pinEdition(uid, isbn13, stub)     -> narrows the item in place

     The open/onCode/close shape is 58-scanner's own, as 75-view-scan uses it:
     the overlay is CONTINUOUS by nature, so "one shot" is this pane's job, not
     a mode the scanner has to grow. The first accepted code closes it. */
  const scannerReady = () => {
    const sc = BT.scanner;
    if (!sc || typeof sc.open !== 'function' || typeof sc.isAvailable !== 'function') return false;
    try { return !!sc.isAvailable(); }
    catch (e) { console.warn('[inspector] the camera availability check threw', e); return false; }
  };

  /* Whatever the overlay hands over goes through normalizeScanCode, never a
     bare checksum test. `onCode` carries the RAW read — 75-view-scan passes it
     straight to BT.scan.handleScan, which normalizes it there — and a raw read
     is not thirteen digits: a wedge scanner prefixes ']E0', and the price
     add-on on a mass-market paperback makes it eighteen. That function already
     knows all of it, including that 979-0 is sheet music rather than a book. */
  function isbnFromScan(v) {
    if (!v) return null;
    const raw = typeof v === 'string' ? v : (v.isbn13 || v.isbn || v.code || '');
    const out = BT.util.normalizeScanCode(raw);
    return out && out.ok ? out.isbn13 : null;
  }

  /* Resolves with the first accepted barcode, or null if the reader closed the
     overlay without one. The overlay is closed from HERE the moment a code
     arrives, which is also what makes `open()`'s own promise settle. */
  function scanOnce(item) {
    const sc = BT.scanner;
    if (!scannerReady()) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = code => {
        if (settled) return;
        settled = true;
        if (typeof sc.close === 'function') {
          try { sc.close(); } catch (e) { console.warn('[inspector] the scanner would not close', e); }
        }
        resolve(isbnFromScan(code));
      };
      let opened;
      try {
        /* `mode` is the overlay's own add/remove labelling, and 'add' is the
           only honest value here — nothing is being removed. It cannot do more
           than label: `onCode` is ours, so the code never reaches
           BT.scan.handleScan and no add/remove pipeline runs at all. */
        opened = sc.open({
          mode: 'add', once: true,
          uid: item.uid, title: item.title, reason: 'pin-edition',
          onCode: finish,
        });
      } catch (e) { settled = true; reject(e); return; }
      /* The overlay's own promise settles when it CLOSES, which is how a
         cancel is heard. It is only consulted if it is a thenable, so a future
         version returning nothing costs a dangling promise rather than a
         TypeError — this pane holds no state open across the call. */
      if (opened && typeof opened.then === 'function') {
        opened.then(() => { if (!settled) { settled = true; resolve(null); } },
                    e => { if (!settled) { settled = true; reject(e); } });
      }
    });
  }

  async function scanPin(item) {
    if (!scannerReady()) return;
    if (!(BT.scan && typeof BT.scan.pinEdition === 'function')) {
      /* Never a half-pin. Narrowing rewrites this item's ISBN rows out of the
         `isbncand:` namespace and into `isbn13:` (BT.repo.idKeysFor), and doing
         part of that from here would leave the record claiming a copy nobody
         verified — silently, since a later scan of a different printing would
         then resolve to this item instead of adding the book in your hand. */
      BT.ui.toast('Pinning a scanned copy needs the scan module, which is not on this page.', { bad: true });
      return;
    }

    let isbn = null;
    try { isbn = await scanOnce(item); }
    catch (e) {
      BT.ui.toast((e && e.message) || 'The scanner could not start.', { bad: true });
      return;
    }
    /* Cancelled, or nothing readable. The scanner overlay has already said so
       in its own status line — a second message from here would be the app
       telling the reader twice that they closed something. */
    if (!isbn) return;

    /* NOT checked against this item's `isbnsCandidate`, deliberately. Candidates
       are harvested fifty editions at a time and are never complete — The
       Hobbit's work record lists 481 — so "not among the candidates" means "not
       fetched yet" far more often than it means "wrong book", and refusing on
       that basis would reject the correct copy most of the time.

       What IS checked is the PINNED namespace. `isbn13:{isbn}` is one row in
       the id index and two items cannot both hold it: the later write takes it
       without complaint, and every future scan of that barcode then resolves to
       whichever record wrote last. */
    const held = await BT.repo.resolveScan(isbn);
    if (held && held.via === 'pinned' && held.uid !== item.uid) {
      const other = await BT.repo.getItem(held.uid);
      BT.ui.toast(`That barcode is already pinned to “${
        BT.util.truncate((other && other.title) || 'another record', 32)}”.`, { bad: true });
      return;
    }

    /* pinEdition MERGES its third argument into the record, so it wants a
       normalized item and not a raw Open Library payload. BT.scan.lookup is
       the scan module's own one-request path — /api/books, with author names
       and the cover already inline — and it returns exactly that shape,
       including the "blind stub" that pinEdition knows to refuse rather than
       merge (its title is the literal string 'ISBN 978…', and merging one
       would rename the book to its own barcode).

       A failure here is not fatal and is deliberately swallowed: the barcode
       IS the ownership claim, and a record that keeps the work's date until
       the next refresh is not a failed pin. */
    let stub = null;
    try {
      if (typeof BT.scan.lookup === 'function') stub = await BT.scan.lookup(isbn);
    } catch (e) {
      console.warn('[inspector] edition lookup failed; pinning the barcode alone', e);
    }

    try { await BT.scan.pinEdition(item.uid, isbn, stub); }
    catch (e) {
      BT.ui.toast((e && e.message) || 'Could not pin that copy.', { bad: true });
      return;
    }

    /* The record has changed underneath the paint signature, so drop it before
       repainting — the Edition block is about to stop saying "a work, not a
       copy" and start naming an ISBN. */
    invalidate();
    show(item.uid);
    BT.router.resolve();
  }

  function wire(item) {
    const host = el();
    /* ASSIGNED, not addEventListener'd, and that is not a style choice. This
       pane is never torn down — it outlives every route change — while paint()
       runs many times over one book's life. Adding a listener per paint stacked
       them silently, and after a few minutes one rating tick fired eight
       writes and eight re-renders. One slot, one handler, always the newest. */
    host.onclick = async e => {
      const st = e.target.closest('[data-status]');
      const pile = e.target.closest('[data-pile]');
      const rate = e.target.closest('[data-rate]');
      const act = e.target.closest('[data-act]');

      if (st) {
        await BT.ui.setStatus(item.uid, st.dataset.status);
        /* In place: a segmented control does not need the whole pane rebuilt. */
        for (const b of host.querySelectorAll('[data-status]')) {
          b.setAttribute('aria-pressed', String(b.dataset.status === st.dataset.status));
        }
        invalidate();
        BT.router.resolve();
      }

      if (pile) {
        await BT.ui.setPile(item.uid, pileValue(pile.dataset.pile));
        for (const b of host.querySelectorAll('[data-pile]')) {
          b.setAttribute('aria-pressed', String(b.dataset.pile === pile.dataset.pile));
        }
        invalidate();
        BT.router.resolve();
      }

      if (rate) {
        const n = +rate.dataset.rate;
        const cur = await BT.repo.getItem(item.uid);
        if (!cur) return;
        if (cur.user.rating === n) delete cur.user.rating; else cur.user.rating = n;
        await BT.repo.putItem(cur);
        BT.repo.addHistory(item.uid, 'rated', cur.user.rating || null);
        /* Ten ticks, each previously triggering a full rebuild of the blurred
           sheet — dragging across the control was the worst jitter in the app. */
        const v = cur.user.rating;
        for (const i of host.querySelectorAll('[data-rate]')) {
          i.classList.toggle('on', v != null && +i.dataset.rate <= v);
        }
        const score = host.querySelector('.myscore');
        if (score) score.innerHTML = v != null ? `${v}<s>/10</s>` : '<s>unrated</s>';
        invalidate();
      }

      if (act && act.dataset.act === 'add') {
        delete item._transient;
        await BT.ui.addItem(item, { source: 'link', scope: item.scope || 'open' });
        show(item.uid);
        BT.router.resolve();
      }

      if (act && act.dataset.act === 'edition') {
        /* Feature-detected rather than assumed. A bare BT.editions.open(...)
           on a page where 59-editions.js failed to parse is a TypeError raised
           inside this one shared click handler — which would take the status
           segment, the rating and the notes down with it. */
        if (BT.editions && typeof BT.editions.open === 'function') BT.editions.open(item.uid);
        else BT.ui.toast('The editions picker is not on this page.', { bad: true });
      }

      if (act && act.dataset.act === 'scanpin') await scanPin(item);

      if (act && act.dataset.act === 'remove') {
        if (!BT.ui.confirmDialog(`Remove “${item.title}” from your library?`)) return;
        await BT.repo.deleteItem(item.uid);
        BT.ui.toast('Removed');
        empty();
        BT.router.resolve();
      }
    };

    wireProgress(item);

    const notes = document.getElementById('inspNotes');
    if (notes) {
      const save = BT.util.debounce(async () => {
        const cur = await BT.repo.getItem(item.uid);
        if (!cur) return;
        cur.user.notes = notes.value;
        await BT.repo.putItem(cur);
      }, 500);
      notes.addEventListener('input', save);
    }
  }

  function wireProgress(item) {
    const host = el();

    /* Redraw the progress block ALONE. It is one innerHTML write into a plain
       div well inside `.sheet`, so the backdrop-filtered layer is never
       touched — which is the entire reason this is not simply `show()` again.
       Re-wiring afterwards is mandatory: the buttons in the old markup went
       with it. */
    const reflect = fresh => {
      if (!fresh) return;
      const box = document.getElementById('prgBody');
      if (box) box.innerHTML = progressBody(fresh);
      /* The status segment can move as a SIDE EFFECT of recording progress —
         see the promotion rule below — so it is repainted here too. */
      for (const b of host.querySelectorAll('[data-status]')) {
        b.setAttribute('aria-pressed', String(b.dataset.status === (fresh.user || {}).status));
      }
      invalidate();
      wireProgress(fresh);
      BT.router.resolve();
    };

    const openForm = () => {
      const form = document.getElementById('prgForm');
      const btns = document.getElementById('prgBtns');
      if (form) form.hidden = false;
      if (btns) btns.hidden = true;
      const inp = document.getElementById('prgPage');
      if (inp) { inp.focus(); inp.select(); }
      /* No repaint and no stored flag. An open form is an intention in
         progress, not state worth keeping, so toggling `hidden` leaves
         lastBody honest and a later repaint simply closes it — which is the
         right answer, because by then the reader has moved on. */
    };
    const closeForm = () => {
      const form = document.getElementById('prgForm');
      const btns = document.getElementById('prgBtns');
      if (form) form.hidden = true;
      if (btns) btns.hidden = false;
    };

    const commit = async () => {
      const inp = document.getElementById('prgPage');
      const n = inp ? parseInt(inp.value, 10) : NaN;
      if (!Number.isFinite(n) || n < 0) {
        BT.ui.toast('Enter the page you are on.', { bad: true });
        return;
      }
      /* BT.ui.setProgress clamps against the extent and promotes a book still
         filed as `want` to `reading`, because recording a position is a
         statement that you have started it. Never the reverse, and never
         beyond that: reaching the last page must NOT set `finished`, because
         finishing is a decision rather than something inferred from a number.
         The most this is allowed to do is ask — see offerFinish. */
      const fresh = await BT.ui.setProgress(item.uid, { currentPage: n });
      reflect(fresh);
      offerFinish(fresh);
    };

    host.querySelectorAll('[data-prg]').forEach(b => {
      b.onclick = async e => {
        e.stopPropagation();
        const what = b.dataset.prg;
        if (what === 'open') { openForm(); return; }
        if (what === 'cancel') { closeForm(); return; }
        if (what === 'save') { await commit(); return; }
        if (what === 'clear') { reflect(await BT.ui.setProgress(item.uid, { currentPage: null })); }
      };
    });

    const page = document.getElementById('prgPage');
    if (page) {
      /* Enter commits and Escape backs out, because the form is one field and
         reaching for a button with the number keyboard up is a thumb journey
         across the whole screen. */
      page.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.stopPropagation(); closeForm(); }
      };
    }
  }

  /* The prompt, and only ever a prompt. */
  function offerFinish(fresh) {
    if (!fresh) return;
    const total = BT.ui.totalPagesOf(fresh);
    const p = BT.ui.progressOf(fresh);
    if (!total || !p || p.currentPage == null || p.currentPage < total) return;
    if ((fresh.user || {}).status === 'finished') return;
    BT.ui.toast('That is the last page.', {
      actionLabel: 'Mark finished',
      onAction: async () => {
        await BT.ui.setStatus(fresh.uid, 'finished');
        invalidate();
        show(fresh.uid);
        BT.router.resolve();
      },
    });
  }

  function markSelected(uid) {
    for (const row of document.querySelectorAll('#view [data-uid]')) {
      row.classList.toggle('is-sel', row.dataset.uid === uid);
    }
  }

  function openDrawerIfNarrow() {
    /* One source of truth for "is the inspector an overlay right now" — see
       BT.tree.isInspOverlay. Duplicating the literal is how the two drift. */
    if (!BT.tree.isInspOverlay()) return;
    /* Two overlapping drawers over one scrim is an ambiguous state — tapping
       the scrim would have to guess which one you meant. Only one at a time. */
    const tree = document.getElementById('treePane');
    if (tree) tree.classList.remove('open');
    el().classList.add('open');
    document.getElementById('scrim').classList.add('on');
  }

  function closeDrawer() {
    el().classList.remove('open');
    if (!document.getElementById('treePane').classList.contains('open')) {
      document.getElementById('scrim').classList.remove('on');
    }
  }

  function init() {
    /* Delegated, not bound in wire(): wire() only runs from paint(), so the
       loading, error, not-found and empty renders would otherwise ship a close
       button that does nothing — and on a phone that is the only way out. */
    el().addEventListener('click', e => {
      if (e.target.closest('#inspClose')) closeDrawer();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDrawer();
    });

    BT.repo.subscribe((ev, detail) => {
      /* Deliberately NOT item:put. Every control in this pane writes, so
         repainting on our own writes would rebuild the blurred sheet under the
         reader's thumb — the exact stutter the in-place updates and the paint
         diff exist to prevent. This pane repaints itself where it needs to.
         What it cannot know about is the record disappearing underneath it. */
      if (ev === 'wipe' || ev === 'import:done') { empty(); return; }
      if (ev === 'item:delete' && detail && detail.uid === currentUid) empty();
    });

    empty();
  }

  return {
    init, show, empty,
    close: closeDrawer,
    openDrawerIfNarrow,
    get current() { return currentUid; },
  };
})();
