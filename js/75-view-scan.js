/* ══════════════════════════════════════════════════════════════════════════
   #/scan — the scanning session: what the reader sees while emptying a bag of
   books onto the table.

   THREE FILES MAKE SCANNING WORK AND THIS IS THE THIRD. Keeping the line
   between them sharp is what stops any of the three from being rewritten by
   accident:

     58-scanner.js  the camera, the decoder, and the accept gate (two
                    consecutive identical checksum-valid decodes). Hardware.
     39-scan.js     what a thirteen-digit number MEANS against the shelves —
                    pinned vs candidate, the writes, the serialized lookup
                    queue, the undo. Library changes. No DOM.
     this file      the screen. Mode, manual entry, the log, the prompt, the
                    Undo affordance, the tally. It decides NOTHING about the
                    library and looks nothing up: it calls
                    BT.scan.handleScan() and renders what comes back.

   ── WHY THE LOG IS BUILT FROM EVENTS ──────────────────────────────────────
   Open Library grants roughly one request a second and asks not to be used as
   a backend. A shelf clear-out is forty books in two minutes. BT.scan resolves
   that by answering the LOCAL question out of IndexedDB immediately and
   pushing only the catalogue lookup through its queue — so it emits
   `scan:pending` before it awaits anything, then `scan:done` when the row can
   finally say what happened, then `scan:update` if a pin fills in later.

   This view therefore does not draw rows from its own call site; it SUBSCRIBES.
   Rows appear the instant a barcode decodes and resolve in place twenty rows
   later, and a scan started anywhere else — the overlay's own decode loop, a
   wedge, the console — lands in the same log. Nothing here ever blocks on a
   lookup, because nothing here does one.

   ── THE PROMPT IS PARKED, NOT MODAL ───────────────────────────────────────
   A candidate hit means the reader owns this book in an unspecified edition,
   and only they know whether the copy in their hand is that one. BT.scan asks
   through `onPrompt`, which may return a PROMISE — so the question is parked on
   its own row and the answer arrives whenever the reader gets to it, while the
   scanning carries on around it. A modal would stop the stack of books; a
   default answer would silently merge two copies or split one.

   ── NOTHING HERE TOUCHES location.hash ────────────────────────────────────
   Not a link, not router.go(), not resolve(). On iOS a standalone home-screen
   PWA REVOKES camera permission the moment the hash changes (WebKit 215884,
   still open) and it cannot be re-granted from inside the app. The overlay
   parks the router with BT.router.suspend() for the same reason; this screen's
   contribution is to stay still — its writes never navigate, and the inspector
   it opens is a pane rather than a route.

   ── THE LOG IS IN MEMORY AND DIES WITH THE ROUTE ──────────────────────────
   Deliberate. Nobody asked for a persistent scan history, and a stored one
   would be a second, subtly different record of the library sitting next to
   the real one — disagreeing with it the first time a book was edited by hand.
   The books are on the shelves; the log is a receipt for the last few minutes.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewScan = (function () {
  const esc = BT.util.escapeHtml;

  /* Prefixed `bt.`, like every key in this app: BookTrak and MovieTrak share
     one GitHub Pages origin, and localStorage is scoped to the origin rather
     than the path. */
  const LS_MODE = 'bt.scan.mode';

  /* ── Session state ─────────────────────────────────────────────────────
     `rows` is newest-first because that is the order it is drawn in — the log
     prepends, and reversing hundreds of nodes on every beep is not free (see
     the .scanlog note in 04-views.css).

     A row carries TWO ids and they do different jobs. `key` is this view's
     own, is what the DOM element is named after, and never changes. `scanId`
     is BT.scan's, is what events are matched on, and CAN change — a retry or a
     late answer to a parked prompt re-enters handleScan and mints a new one,
     which the row adopts rather than growing a second row for the same book. */
  let rows = [];
  const byScanId = new Map();
  const parked = new Map();     // key -> resolve(), a question waiting on a tap
  let keySeq = 0;
  let adopt = null;             // { isbn13, key } — the re-entry about to arrive
  let mounted = false;
  let unsubscribe = null;
  let mode = loadMode();

  function loadMode() {
    try { return localStorage.getItem(LS_MODE) === 'remove' ? 'remove' : 'add'; }
    catch (_) { return 'add'; }
  }

  /* ── SEAM ──────────────────────────────────────────────────────────────
     39-scan.js is a hard dependency of this screen — it is the half that
     changes the library — so its absence is reported rather than worked
     around. A local re-implementation would be a second copy of the
     pinned-vs-candidate rule, and two copies of that rule is precisely how the
     scanner starts silently answering "already owned" to everything.
     Feature-detected all the same, the way 61-view-search checks its adapter:
     a bare BT.scan.handleScan() on a page where that file failed to parse is a
     TypeError inside an event handler, which reads as a screen that does
     nothing at all. */
  function engineReady() {
    return !!(BT.scan && typeof BT.scan.handleScan === 'function');
  }

  /* ══ EVENTS ══════════════════════════════════════════════════════════════
     Subscribed once, on arrival, and released on departure. Not at load: a
     subscription that outlives the screen keeps building a log nobody is
     looking at, and the rows hold whole item records. */

  function listen() {
    if (unsubscribe || !engineReady()) return;
    unsubscribe = BT.scan.subscribe((ev, detail) => {
      if (!mounted) return;
      if (ev === 'scan:pending') onPending(detail);
      else if (ev === 'scan:done') onDone(detail);
      else if (ev === 'scan:update') onUpdate(detail);
      else if (ev === 'queue:change') paintQueue(detail);
      /* item:pinned / item:removed / item:restored are deliberately ignored.
         Every one of them accompanies a result this view has already rendered
         from `scan:done`, and acting on both would count the same book twice
         in the tally. They exist for listeners that did not start the scan. */
    });
  }

  function onPending(d) {
    /* A retry or a parked answer re-entering handleScan: it is the SAME book
       on the SAME row, so the row adopts the new scanId instead of appearing
       twice. Matched on the ISBN as well as the marker, so an unrelated scan
       arriving in the gap can never steal the row. */
    if (adopt && adopt.isbn13 && adopt.isbn13 === d.isbn13) {
      const row = rows.find(r => r.key === adopt.key);
      adopt = null;
      if (row) {
        byScanId.delete(row.scanId);
        row.scanId = d.scanId;
        byScanId.set(d.scanId, row);
        return;
      }
    }

    const row = {
      key: 'k' + (++keySeq),
      scanId: d.scanId,
      isbn13: d.isbn13 || '',
      raw: d.raw || '',
      /* Stamped on the row rather than read at paint time: the toggle can move
         mid-session, and a row that said "removed" must not start claiming it
         was added because the mode changed underneath it. */
      mode: d.mode === 'remove' ? 'remove' : 'add',
      status: 'pending',
      title: '',
      note: '',
      uid: null,
      item: null,
      pinned: 0,
      undo: null,
      retry: null,
      at: d.at || Date.now(),
    };
    rows.unshift(row);
    byScanId.set(row.scanId, row);

    const host = document.getElementById('scanlog');
    if (host) {
      /* The first row of a session replaces the empty state; after that a
         single prepend, because rewriting the whole list on every beep is what
         makes a long session stutter. */
      if (rows.length === 1) paintLog();
      else host.insertAdjacentHTML('afterbegin', rowHtml(row));
    }
    paintTally();
    paintCount();
  }

  /* Everything this screen knows about what a scan MEANT arrives here. The
     vocabulary is BT.scan's — see the result list at handleScan — and this is
     the only place it is translated into a pill, a sentence and an affordance. */
  function onDone(d) {
    const row = byScanId.get(d.scanId);
    if (!row) return;

    row.uid = d.uid || row.uid;
    row.title = d.title || row.title;
    row.item = d.item || row.item;
    row.retry = null;
    row.undo = null;
    row.pinned = 0;

    switch (d.result) {
      case 'added':
        row.status = 'ok';
        if (d.action === 'pinned') {
          /* Not a new book: the record they already had, narrowed to the copy
             in their hand — with its rating, notes and progress intact. That
             is a different event from an add and the pill says so. */
          row.pinned = 1;
          row.note = 'pinned to the record you already had';
        } else if (d.action === 'separate') {
          row.note = 'added as a separate copy';
        } else {
          row.note = 'added as this printing';
        }
        break;

      case 'removed':
        row.status = 'ok';
        /* The whole undo lives on the result object — the item, its snapshot
           and a restore() that puts both back. Holding it on the row is what
           makes the affordance possible at all, since the toast layer is
           covered while the camera overlay is up. */
        row.undo = d.undo || (d.removal && d.removal.restore) || null;
        row.note = 'removed from your library';
        break;

      case 'already-owned':
        row.status = 'dupe';
        row.note = d.status
          ? `already on your shelves — ${(BT.ui.STATUS_WORD[d.status] || d.status).toLowerCase()}`
          : 'this exact printing is already on your shelves';
        break;

      case 'candidate-prompt':
        row.status = 'prompt';
        row.note = '';
        break;

      case 'not-found':
        row.status = 'miss';
        row.note = noteForMiss(d);
        break;

      case 'invalid':
      case 'not-a-book':
        row.status = 'err';
        row.note = REASON[d.reason] || 'That is not a book barcode.';
        break;

      default:
        row.status = 'err';
        row.retry = typeof d.retry === 'function' ? d.retry : null;
        row.note = failureNote(d);
    }

    repaintRow(row);
    paintTally();
  }

  /* Two different absences, and telling them apart is most of what this screen
     is for. In add mode a blind stub HAS been shelved (BT.scan gives it the
     uid the catalogue record would take, so hydrate merges into it the day the
     entry appears) — the book is on the shelves, it just has no title yet. In
     remove mode nothing was written at all, and a candidate match deserves its
     own sentence: owning the book is not the same as holding this copy. */
  function noteForMiss(d) {
    if (d.mode === 'remove') {
      return d.via === 'candidate'
        ? 'you have this book, but not this copy — nothing was removed'
        : 'nothing on your shelves claims this barcode';
    }
    return d.uid
      ? 'shelved under its ISBN — Open Library has no record for it yet'
      : 'Open Library has no record for this barcode';
  }

  /* The late half of a pin. The identity was narrowed the moment the reader
     tapped — that is the part that has to survive being offline — and the
     edition's publisher, extent, format and printing date arrive whenever the
     queue reaches them. */
  function onUpdate(d) {
    const row = byScanId.get(d.scanId);
    if (!row) return;
    if (d.title) row.title = d.title;
    if (d.item) row.item = d.item;
    if (d.phase === 'filled') row.note = d.blind ? 'pinned — no catalogue record to fill it in from' : 'pinned, edition details filled in';
    else if (d.phase === 'fill-failed') row.note = 'pinned — the edition details could not be fetched';
    repaintRow(row);
  }

  /* Four reasons, four sentences. One message for all of them was the most
     confusing thing about the first cut of this screen: three are the reader's
     problem to solve and one of them is not a problem at all. */
  const REASON = {
    'too-short': 'Too short to be a book barcode. An ISBN is 13 digits on the back cover, or the 10-digit form on the copyright page.',
    'too-long': 'Longer than any book barcode — a scanner in keyboard mode sends a burst of junk on a bad read. Scan it again.',
    checksum: 'Thirteen digits, but the check digit disagrees with them, so one was misread. Scan it again, or type it off the copyright page.',
    isbn10: 'Ten characters, but the ISBN-10 check character disagrees. That last character can be an X rather than a digit — check it first.',
    ismn: 'That is an ISMN (979-0…), the barcode for printed sheet music rather than a book. There is nothing in Open Library to look up.',
    'not-a-book': 'A valid retail barcode, but not a Bookland one. Books are 978 and 979; this is something else — a boxed set, a DVD, a jar of jam.',
  };

  /* A source that is DOWN and a source that has never heard of the book are
     different facts, and BT.scan keeps them apart all the way here — 'error'
     rather than 'not-found'. Collapsing them is how a scanner tells someone
     their paperback does not exist because the café wifi wants them to sign in. */
  function failureNote(d) {
    const kind = (d && d.reason) || '';
    if (kind === 'offline') return 'You are offline. The scan is logged, but nothing could be looked up.';
    if (kind === 'budget' || kind === 'quota-soft') return 'Open Library is rate-limiting this browser. Give it a few seconds, then retry.';
    if (kind === 'notfound') return 'Something answered with a web page rather than a record — usually a wifi sign-in screen intercepting the request.';
    return (d && d.message) || 'The lookup failed.';
  }

  /* ══ SUBMITTING ══════════════════════════════════════════════════════════ */

  /* ISBN-10 IS CONVERTED HERE AND NOWHERE ELSE, and that is a statement about
     which door it came through. THERE IS NO ISBN-10 BARCODE: the retail symbol
     on a book has been a 978-prefixed EAN-13 since long before the 2007
     changeover, so no camera and no wedge can ever produce one. The ten-digit
     form is what is PRINTED ON THE COPYRIGHT PAGE — which is exactly what gets
     typed when the barcode is torn, sun-bleached, or under a charity-shop
     price sticker. It belongs to manual entry, so it is done in the view that
     owns manual entry rather than in the pipeline that serves both doors.

     The length test runs on a [0-9X] strip rather than a digit strip, because
     the mod-11 check character is written 'X' and a naive /\D/g replace turns
     the perfectly valid 043942089X into a nine-digit fragment. An AIM prefix
     cannot fake this: ']E0' plus thirteen digits is fourteen characters, and
     isbn10to13 rejects anything whose mod-11 check disagrees anyway. */
  function widenIfIsbn10(text) {
    const compact = String(text == null ? '' : text).toUpperCase().replace(/[^0-9X]/g, '');
    if (compact.length !== 10) return { text, converted: 0 };
    const wide = BT.util.isbn10to13(compact);
    return wide ? { text: wide, converted: 1 } : { text: null, reason: 'isbn10' };
  }

  /* Reading a code WITHOUT acting on it, so the field can say what is wrong
     with what was typed before the row scrolls away. BT.scan.normalize is the
     same reader the pipeline itself uses — AIM prefix first, then the digit
     strip, then length dispatch, then the checksum, then the 979-0 ISMN range
     — so the sentence under the field and the sentence on the row can never
     disagree. Falling back to the util keeps the message honest even if the
     pipeline's own wrapper is ever renamed. */
  function readCode(text) {
    if (BT.scan && typeof BT.scan.normalize === 'function') return BT.scan.normalize(text);
    return BT.util.normalizeScanCode(text);
  }

  /* Every scan this screen starts goes through here, camera or keyboard. The
     row is not created from the return value — `scan:pending` does that,
     before anything is awaited — so this deliberately does not wait. */
  function send(raw) {
    if (!engineReady()) return Promise.resolve(null);
    return BT.scan.handleScan(raw, {
      mode,
      source: 'scan',
      /* The parked prompt. Returning a promise is what makes the question
         non-blocking: BT.scan awaits it inside its own branch, AFTER the local
         resolve and BEFORE it touches the queue, so an unanswered prompt holds
         up nothing but its own row. */
      onPrompt: detail => park(detail),
    }).catch(e => {
      /* handleScan classifies its own failures into an 'error' result, so
         reaching here means something threw outside that — which the log
         cannot attribute to a row. Say it once, where it can be seen. */
      console.error('[scan] handleScan threw', e);
      BT.ui.toast((e && e.message) || 'The scan could not be processed.', { bad: true });
      return null;
    });
  }

  /* Hand the question to the row and return a promise that settles when the
     reader taps. Matched to the newest PENDING row for this ISBN: `scan:pending`
     is emitted before the branch that calls onPrompt, so the row is always
     already there. */
  function park(detail) {
    const row = rows.find(r => r.isbn13 === detail.isbn13 && r.status === 'pending');
    if (!row) return null;                       // no row to ask on: dismiss
    row.status = 'prompt';
    row.title = detail.title || row.title;
    row.item = detail.item || row.item;
    row.uid = detail.uid || row.uid;
    row.note = '';
    repaintRow(row);
    paintTally();
    return new Promise(resolve => parked.set(row.key, resolve));
  }

  /* The reader has answered. Two ways in, because a scan can also arrive from
     a caller that offered no prompt at all (the overlay's own decode loop, or
     the console): if the question is parked here, settle it; otherwise
     re-enter handleScan with the choice forced, which is the path BT.scan
     documents. `force` is required — the default choice is one tap away and
     the 2s debounce would otherwise swallow it and return the memoised
     'candidate-prompt' with nothing happening. */
  function answer(row, choice) {
    if (row.status !== 'prompt') return;
    row.status = 'pending';
    row.note = choice === 'pin' ? 'pinning this edition…' : 'adding a separate copy…';
    repaintRow(row);
    paintTally();

    const resolve = parked.get(row.key);
    if (resolve) { parked.delete(row.key); resolve(choice); return; }

    adopt = { isbn13: row.isbn13, key: row.key };
    send2(row, { mode: 'add', force: true, onPrompt: () => choice });
  }

  /* A deliberate re-entry on a code already in the log — an answer with no
     parked promise, or a retry. The row adopts whatever scanId comes back, so
     one book stays one row. */
  function send2(row, opts) {
    if (!engineReady()) return;
    BT.scan.handleScan(row.isbn13, Object.assign({ source: 'scan' }, opts)).catch(e => {
      adopt = null;
      row.status = 'err';
      row.note = (e && e.message) || 'That could not be completed.';
      repaintRow(row);
      paintTally();
    });
  }

  function retryRow(row) {
    if (!row.isbn13) return;
    row.status = 'pending';
    row.note = 'trying again…';
    repaintRow(row);
    paintTally();
    adopt = { isbn13: row.isbn13, key: row.key };
    /* The result's own retry() re-enters with the original options; falling
       back to a fresh handleScan covers a result that arrived without one. */
    if (typeof row.retry === 'function') {
      const fn = row.retry;
      row.retry = null;
      Promise.resolve().then(fn).catch(e => {
        adopt = null;
        row.status = 'err';
        row.note = (e && e.message) || 'That could not be completed.';
        repaintRow(row);
      });
      return;
    }
    send2(row, { mode: row.mode, force: true });
  }

  async function undoRow(row) {
    const restore = row.undo;
    if (typeof restore !== 'function') return;
    row.undo = null;
    row.status = 'pending';
    row.note = 'putting it back…';
    repaintRow(row);
    try {
      const back = await restore();
      row.status = 'dupe';
      row.item = back || row.item;
      row.uid = (back && back.uid) || row.uid;
      row.note = 'put back on your shelves, with its rating and notes';
    } catch (e) {
      console.error('[scan] undo failed', e);
      row.status = 'err';
      row.note = (e && e.message) || 'It could not be put back.';
    }
    repaintRow(row);
    paintTally();
  }

  /* ══ PAINTING ════════════════════════════════════════════════════════════ */

  /* 'prompt' borrows the amber `dupe` pill. Amber is the app's caution hue and
     the only one that is never a control — which is exactly what an unanswered
     question is. There is no sixth pill class in 04-views.css and there should
     not be. */
  const PILL = {
    pending: { cls: 'pending', add: 'Reading', remove: 'Reading' },
    ok: { cls: 'ok', add: 'Added', remove: 'Removed' },
    dupe: { cls: 'dupe', add: 'Owned', remove: 'Kept' },
    miss: { cls: 'miss', add: 'No record', remove: 'Not yours' },
    err: { cls: 'err', add: 'Failed', remove: 'Failed' },
    prompt: { cls: 'dupe', add: 'Which?', remove: 'Which?' },
  };

  function pillOf(row) {
    const p = PILL[row.status] || PILL.err;
    const word = (row.status === 'ok' && row.pinned) ? 'Pinned'
      : (row.mode === 'remove' ? p.remove : p.add);
    return `<span class="scanpill ${p.cls}">${esc(word)}</span>`;
  }

  /* The cover, and the reason a pending row does not ask for one: a cover
     request by ISBN is a real hit on covers.openlibrary.org, a SEPARATE
     service capped at 100 requests per address per five minutes. One per
     barcode, fired before we even know the catalogue holds the book, is how a
     long session runs that cap down to nothing. A pending row therefore draws
     the generated block — no request — and the real jacket arrives with the
     record. */
  function thumbOf(row) {
    if (row.item) return BT.ui.poster(row.item, { size: 'sm' });
    return BT.ui.poster({ title: row.title || row.isbn13 || row.raw || '?' }, { size: 'sm' });
  }

  function titleOf(row) {
    if (row.title) return esc(BT.util.truncate(row.title, 70));
    if (row.status === 'pending') return 'Looking it up…';
    if (row.status === 'err') return 'Not read';
    /* Two different absences wearing one pill: in add mode the catalogue has
       no record, in remove mode the catalogue is irrelevant and the answer is
       about the shelf. */
    return row.mode === 'remove' ? 'Not on your shelves' : 'Not in the catalogue';
  }

  /* The inline block for a choice, an Undo or a Retry. Placed by hand into a
     third grid row spanning the text and pill columns: .scanlog-row declares
     three columns and explicit placements for its four normal children, so an
     unplaced fifth child would land under the cover. Written inline because it
     is geometry belonging to this one element, the same way the search view
     sizes its own cover box. */
  const SPAN = 'grid-column:2 / -1;grid-row:3;display:flex;align-items:center;'
    + 'gap:var(--bt-space-2);flex-wrap:wrap;margin:5px 0 3px';
  const SAYS = 'font-size:var(--bt-fs-mini)';

  function actionsOf(row) {
    /* PIN IS THE DEFAULT: first, and drawn as the primary. It is what is true
       nine times out of ten — the reader searched for a book months ago and is
       now holding their copy of it — and it is the answer that keeps their
       rating, notes and progress attached, because it narrows the record they
       already have instead of starting a second one. */
    if (row.status === 'prompt') {
      return `<div style="${SPAN}">
        <span class="muted" style="${SAYS}">You have this book, edition unspecified.</span>
        <button class="btn btn--sm btn--primary" type="button" data-pin="${esc(row.key)}">Pin this edition</button>
        <button class="btn btn--sm" type="button" data-copy="${esc(row.key)}">Add as separate copy</button>
      </div>`;
    }
    if (typeof row.undo === 'function') {
      return `<div style="${SPAN}">
        <button class="btn btn--sm" type="button" data-undo="${esc(row.key)}">Undo</button>
        <span class="muted" style="${SAYS}">Puts the record back with its rating, notes and progress.</span>
      </div>`;
    }
    if (row.status === 'err' && row.isbn13) {
      return `<div style="${SPAN}">
        <button class="btn btn--sm" type="button" data-retry="${esc(row.key)}">Try again</button>
        <span class="muted" style="${SAYS}">One tap — the book does not need rescanning.</span>
      </div>`;
    }
    return '';
  }

  /* The uid a TAP may follow, which is not the same as the uid the row is
     about. A removed record is gone from the repository, so opening it would
     send the inspector off to re-fetch the very book that was just unshelved
     and present it as though it were still there. It becomes navigable again
     the moment Undo puts it back. */
  function navUid(row) {
    if (!row.uid) return '';
    if (row.mode === 'remove' && row.status === 'ok') return '';
    return row.uid;
  }

  function rowHtml(row) {
    const bits = [esc(row.isbn13 || BT.util.truncate(row.raw, 24) || '—')];
    if (row.note) bits.push(esc(row.note));
    const uid = navUid(row);
    return `<div class="scanlog-row ${esc(row.status)}" id="scanrow-${esc(row.key)}"${
      uid ? ` data-uid="${esc(uid)}"` : ''}>
      ${thumbOf(row)}
      <div class="scanlog-t">${titleOf(row)}</div>
      <div class="scanlog-isbn">${bits.join(' <span class="faint">·</span> ')}</div>
      ${pillOf(row)}
      ${actionsOf(row)}
    </div>`;
  }

  /* Re-queried by id rather than held as a node: the view can be rebuilt under
     a lookup at any time (a re-resolve of the same route, an import), and a
     captured element would then be updated inside a detached fragment nobody
     is looking at. A missing element means the log was repainted from state,
     which already has this row in it. */
  function repaintRow(row) {
    const el = document.getElementById('scanrow-' + row.key);
    if (el) el.outerHTML = rowHtml(row);
  }

  function paintLog() {
    const host = document.getElementById('scanlog');
    if (!host) return;
    if (!rows.length) {
      /* Deliberately NOT a second copy of the scope note above it. This says
         what to do and what to expect while doing it; the header says what a
         barcode means. Two panels repeating one sentence is how a screen stops
         being read at all. */
      host.innerHTML = BT.ui.emptyState({
        title: mode === 'remove' ? 'Scan the books you are removing' : 'Scan the pile',
        /* Both say what to DO. The removed halves explained the pinned/candidate
           model and the catalogue's request rate — mechanics the reader cannot
           act on, in the one place they are holding a book and waiting. */
        body: mode === 'remove'
          ? 'Scan a copy you previously scanned in. Only a printing you pinned by scanning can be removed here.'
          : 'Point the camera at the barcode on the back cover, or type the number under it.',
      });
      return;
    }
    host.innerHTML = rows.map(rowHtml).join('');
  }

  function tallyOf() {
    const t = { added: 0, removed: 0, dupe: 0, miss: 0, gone: 0, err: 0 };
    for (const r of rows) {
      if (r.status === 'ok') { if (r.mode === 'remove') t.removed++; else t.added++; }
      else if (r.status === 'dupe') t.dupe++;
      else if (r.status === 'miss') { if (r.mode === 'remove') t.gone++; else t.miss++; }
      else if (r.status === 'err') t.err++;
    }
    return t;
  }

  /* "N added · N already owned · N not found · N failed" is the line for an
     ordinary session, and it is what prints when nothing has been removed. The
     two removal counters appear only once there is something to count: a slot
     reading "0 removed" in an add session is noise, and one reading "0 added"
     in a removal session is worse — it invites the reading that nothing worked. */
  function paintTally() {
    const el = document.getElementById('scantally');
    if (!el) return;
    const t = tallyOf();
    const slots = [
      ['ok', t.added, 'added', t.added > 0 || t.removed === 0],
      ['ok', t.removed, 'removed', t.removed > 0],
      ['dupe', t.dupe, 'already owned', true],
      ['miss', t.miss, 'not found', true],
      ['miss', t.gone, 'not on your shelves', t.gone > 0],
      ['err', t.err, 'failed', true],
    ];
    el.innerHTML = slots.filter(s => s[3])
      .map(([cls, n, label]) => `<span class="tal ${cls}"><b>${n}</b> ${esc(label)}</span>`)
      .join('');
  }

  function paintCount() {
    const el = document.getElementById('scanCount');
    if (el) el.textContent = rows.length ? `${BT.util.pluralize(rows.length, 'scan')} this session` : '';
  }

  /* The queue depth, shown because the alternative is a screen that looks
     stuck. At one request a second a burst of twenty barcodes takes twenty
     seconds to resolve, all of it correct and none of it visible — the rows
     just sit there breathing. Saying how many are waiting turns "it has
     frozen" into "it is working through them". */
  function paintQueue(d) {
    const el = document.getElementById('scanQueue');
    if (!el) return;
    const depth = d ? d.depth : (BT.scan && BT.scan.queue ? BT.scan.queue.depth() : 0);
    el.textContent = depth > 0 ? `${depth} waiting on Open Library` : '';
  }

  /* ══ THE CAMERA ══════════════════════════════════════════════════════════
     Availability is asked of BT.scanner, which owns the three-layered
     detection this screen must not duplicate: 'BarcodeDetector' in window,
     then getSupportedFormats() actually containing ean_13 (it can come back
     empty), then a try/catch around the first real detect(). The native
     detector does NOT exist on Chrome or Edge for Windows or Linux desktop —
     the constructor is undefined — which is why the vendored decoder is the
     primary path rather than a fallback.

     What is decided HERE is only what to draw when there is no camera at all,
     and the sentence has to be specific or it is useless: getUserMedia needs a
     SECURE CONTEXT, so the published site and http://localhost work while a
     double-clicked file never will. That is a rule about the address, not a
     bug and not something to retry — so it gets an explanation rather than a
     dead button. */
  function cameraReady() {
    if (!BT.scanner || typeof BT.scanner.open !== 'function') return false;
    if (typeof BT.scanner.isAvailable !== 'function') return false;
    try { return !!BT.scanner.isAvailable(); }
    catch (e) { console.warn('[scan] the availability check threw', e); return false; }
  }

  /* Ordered by what is actually true, and the address is asked about FIRST
     because it is the answer that catches everybody and the only one the
     reader can act on. The last two branches matter as much: "no camera here"
     and "no scanner code here" are different faults with different fixes, and
     a single vague sentence for all four sends people to check permissions
     they have already granted. */
  function cameraExcuse() {
    if (location.protocol === 'file:') {
      return 'You opened this page as a file. Browsers only hand out a camera in a <b>secure context</b>, and <code>file://</code> is not one — that is a rule about the address, not a bug and not something to retry. '
        + 'Serve the folder — <code>python -m http.server 8080</code> — and open <code>http://localhost:8080</code>, or use the published site over HTTPS.';
    }
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
      return 'This page is not a <b>secure context</b>, so the browser will not open a camera. A LAN address like <code>192.168.1.x</code> counts as insecure even on your own network — <code>localhost</code> and real HTTPS are the only two that count.';
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'This browser exposes no camera API at all — normal on a desktop with no webcam, and on some managed or hardened profiles.';
    }
    if (!BT.scanner || typeof BT.scanner.open !== 'function') {
      return 'The scanner overlay (<code>js/58-scanner.js</code>) is not on this page, so there is nothing to open a camera with. Everything else on this screen still works.';
    }
    return 'The scanner found no usable camera on this device. The address is a secure one, so the permission itself is available — <b>this page may use a camera, there simply is not one to use.</b> Check that a webcam is attached and that camera access is not switched off for this site in the browser’s own settings.';
  }

  async function openCamera() {
    if (!cameraReady()) return;
    try {
      /* The overlay owns the stream, the decoder and the router suspension
         around both. All it is given is the mode and somewhere to send each
         accepted barcode; every code that arrives goes straight into the same
         pipeline as a typed one, so the log cannot tell them apart and does
         not need to. */
      await BT.scanner.open({ mode, onCode: code => send(code) });
    } catch (e) {
      console.warn('[scan] the camera would not open', e);
      BT.ui.toast(`The camera would not open. ${(e && e.message) || ''}`.trim(), { bad: true });
    }
  }

  /* ══ RENDER ══════════════════════════════════════════════════════════════ */

  const ICON_BARCODE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M3 5v14M7 5v14M10.5 5v14M14 5v14M17.5 5v14M21 5v14"/></svg>';

  const ICON_CAMERA = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M3 8a1 1 0 0 1 1-1h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'
    + '<circle cx="12" cy="13" r="3.4"/></svg>';

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;

    BT.ui.crumb(['Discover', 'Scan']);
    /* The other door into the library, named where somebody deciding how to
       add a book will look. Scanning adds a printing; searching adds the work. */
    BT.ui.paneActions('<a class="btn btn--sm" href="#/search">Search by title</a>');

    if (!engineReady()) {
      view.innerHTML = BT.ui.errorBox('Scanning is not wired up on this page',
        'The scan pipeline (js/39-scan.js) is missing, and it is the half that decides what a '
        + 'barcode means against your shelves. Nothing here can add or remove a book until it is '
        + 'back. Your library is untouched, and search still works.');
      return;
    }

    const count = await BT.repo.countItems();
    if (alive && !alive()) return;

    mounted = true;
    listen();
    /* A new session should not inherit "you just scanned this" from the last
       one — the debounce memo is the only state BT.scan keeps between scans. */
    if (typeof BT.scan.resetGate === 'function') BT.scan.resetGate();

    const cam = cameraReady();

    view.innerHTML = `
      <div class="searchbox">
        <div class="chips" id="modeChips" role="group" aria-label="What a scan does">
          <button class="chip" type="button" data-mode="add"
                  aria-pressed="${mode === 'add'}">Add to library</button>
          <button class="chip" type="button" data-mode="remove"
                  aria-pressed="${mode === 'remove'}">Remove from library</button>
        </div>

        <div class="warnbox" id="removeWarn" style="margin-top:var(--bt-space-4)"${mode === 'remove' ? '' : ' hidden'}>
          <strong>Scanning now REMOVES books</strong>
          Every barcode read on this screen — by camera or by hand — deletes the
          matching book, its rating, its notes and its reading history. Each
          removal keeps an Undo beside it while this screen is open, and nothing
          else asks twice.
        </div>

        ${cam
          ? `<button class="btn btn--primary" type="button" id="camBtn"
                     style="margin-top:var(--bt-space-4)">${ICON_CAMERA}<span id="camLabel">${
               mode === 'remove' ? 'Scan to remove' : 'Scan with camera'}</span></button>`
          : `<div class="field__help" style="margin-top:var(--bt-space-4)">
               <b>No camera on this page.</b> ${cameraExcuse()}
               Typing an ISBN below works everywhere, including here.
             </div>`}

        <div class="sfield" style="margin-top:var(--bt-space-4)">
          ${ICON_BARCODE}
          <input id="isbnIn" type="text" spellcheck="false" autocomplete="off"
                 autocapitalize="characters" autocorrect="off" enterkeyhint="done"
                 maxlength="${BT.LIMITS.scanInputMax}"
                 placeholder="ISBN — the 13 digits under the barcode, or the 10 on the copyright page"
                 aria-label="ISBN">
          <button class="btn btn--sm" type="button" id="isbnGo">${mode === 'remove' ? 'Remove' : 'Add'}</button>
        </div>
        <!-- .shint lays its children out as flex items with a gap, so every
             element and every text node between them becomes a separate box.
             That is right for a row of short hints and wrong for a sentence:
             prose written straight into it comes out broken across three lines
             with gaps mid-clause. Each hint is therefore one <span>. -->
        <div class="shint" id="isbnState">
          <span><kbd>⏎</kbd> submit</span>
          <span>an ISBN-10 is converted here — there is no ISBN-10 <em>barcode</em>, so it only ever arrives by hand</span>
          <span><b>${count}</b> on your shelves</span>
        </div>
        <!-- Hidden in remove mode: it describes the add door, and the warnbox
             above is already saying something the reader needs more. -->
        <div class="field__help" id="scopeNote" style="margin-top:9px"${mode === 'remove' ? ' hidden' : ''}>
          A barcode names one <b>printing</b>, so a book added this way is pinned to
          that edition — its publisher, its extent, its cover. Searching adds the
          work instead and leaves the edition open until you scan a copy.
        </div>
      </div>

      <div class="toolbar">
        <span class="count" id="scanCount"></span>
        <span class="count" id="scanQueue"></span>
        <div class="spacer"></div>
        <span class="count">Open Library</span>
      </div>

      <div class="scanlog" id="scanlog" role="log" aria-live="polite" aria-label="Scans this session"></div>
      <div class="scantally" id="scantally" aria-label="Session totals"></div>`;

    paintLog();
    paintTally();
    paintCount();
    paintQueue(null);
    wire();
  }

  function setMode(next) {
    const m = next === 'remove' ? 'remove' : 'add';
    if (m === mode) return;
    mode = m;
    try { localStorage.setItem(LS_MODE, mode); }
    catch (e) { console.warn('[scan] could not persist the mode', e); }
    reflectMode();
  }

  /* In place, not a re-render. Rebuilding the view would throw the log's DOM
     away and rebuild it from state for no reason — and on a phone it would
     scroll the reader back to the top of a session they were reading. */
  function reflectMode() {
    for (const b of document.querySelectorAll('#modeChips [data-mode]')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
    const warn = document.getElementById('removeWarn');
    if (warn) warn.hidden = mode !== 'remove';
    const scope = document.getElementById('scopeNote');
    if (scope) scope.hidden = mode === 'remove';
    const camLabel = document.getElementById('camLabel');
    if (camLabel) camLabel.textContent = mode === 'remove' ? 'Scan to remove' : 'Scan with camera';
    const go = document.getElementById('isbnGo');
    if (go) go.textContent = mode === 'remove' ? 'Remove' : 'Add';
    if (!rows.length) paintLog();          // the empty state names the mode it is in
  }

  function wire() {
    const chips = document.getElementById('modeChips');
    if (chips) {
      chips.onclick = e => {
        const b = e.target.closest('[data-mode]');
        if (b) setMode(b.dataset.mode);
      };
    }

    const cam = document.getElementById('camBtn');
    if (cam) cam.onclick = () => openCamera();

    const input = document.getElementById('isbnIn');
    const go = document.getElementById('isbnGo');
    const state = document.getElementById('isbnState');

    const say = (text, bad) => {
      if (!state) return;
      state.innerHTML = `<span class="field__state${bad ? ' field__state--bad' : ''}"
        style="margin:0">${esc(text)}</span>`;
    };

    const submit = () => {
      if (!input) return;
      const typed = input.value.trim();
      if (!typed) { say('Type or scan an ISBN first.', true); return; }

      /* An ISBN-10 whose check character disagrees is the one rejection that
         never reaches the log, and deliberately: there is no barcode here to
         record, and the pipeline would read those ten digits as 'too-short' —
         a true statement about a string and a wrong explanation of what the
         reader did. The field says the precise thing instead, and the session
         tally is not charged with a failed scan that never happened. */
      const wide = widenIfIsbn10(typed);
      if (!wide.text) { say(REASON[wide.reason] || 'That is not a book barcode.', true); input.select(); return; }

      /* Read first, for the MESSAGE only — the code is sent either way, because
         the log is the record of the whole session and a mistyped barcode is a
         failed scan like any other. What changes is where the sentence lands:
         under the field, where the typing happened, rather than only on a row
         that a fast session may already have pushed down the screen. */
      const read = readCode(wide.text);
      if (!read.ok) {
        say(REASON[read.reason] || 'That is not a book barcode.', true);
        /* The text stays, selected: a transposed digit is corrected in two
           keystrokes and retyped in thirteen. */
        input.select();
      } else {
        say(wide.converted ? `ISBN-10 read as ${wide.text}.` : `Reading ${wide.text}…`, false);
        /* Cleared BEFORE the promise settles, because the row is already on
           screen by then — `scan:pending` fires ahead of every await inside
           handleScan. */
        input.value = '';
      }
      /* Focus stays put. A scanner in keyboard-wedge mode types into whatever
         is focused and then presses Enter, so losing focus here means the next
         book in the stack is typed into nothing at all. */
      input.focus();
      send(wide.text);
    };

    if (go) go.onclick = submit;
    if (input) {
      input.onkeydown = e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submit();
      };
      /* Not on a phone: an auto-opening keyboard on arrival covers half the
         screen for somebody who came here to use the camera. On a desktop the
         field is the only way in, and it is where a wedge scanner types. */
      if (!matchMedia('(pointer: coarse)').matches) input.focus();
    }

    const log = document.getElementById('scanlog');
    if (log) {
      /* Assigned rather than added: paintLog() rewrites this element's
         contents many times over a session while the element itself survives,
         and an addEventListener per paint would stack handlers silently until
         one tap fired eight of them. */
      log.onclick = e => {
        const pin = e.target.closest('[data-pin]');
        if (pin) { withRow(pin.dataset.pin, r => answer(r, 'pin')); return; }
        const copy = e.target.closest('[data-copy]');
        if (copy) { withRow(copy.dataset.copy, r => answer(r, 'separate')); return; }
        const undo = e.target.closest('[data-undo]');
        if (undo) { withRow(undo.dataset.undo, undoRow); return; }
        const retry = e.target.closest('[data-retry]');
        if (retry) { withRow(retry.dataset.retry, retryRow); return; }

        /* Anything else on a resolved row opens the inspector — which is a
           PANE and not a route, so no hash changes and it is safe to tap even
           while a stream is live. */
        if (e.target.closest('button')) return;
        const el = e.target.closest('[data-uid]');
        if (el && BT.inspector) BT.inspector.show(el.dataset.uid);
      };
    }
  }

  function withRow(key, fn) {
    const row = rows.find(r => r.key === key);
    if (row) fn(row);
  }

  /* ══ LEAVING THE ROUTE ═══════════════════════════════════════════════════
     There is no unmount hook in the router — a view is a function that writes
     into #view — so the departure is caught here, once, at load.

     Order matters. The camera goes off FIRST: a MediaStream outliving the
     screen that owns it is a camera light nobody can explain, and on iOS a
     permission that cannot be re-granted from inside the app. Then every
     parked question is DISMISSED rather than dropped — BT.scan reads a null
     answer as "no decision" and writes nothing, which is the only safe reading
     of a reader who walked away mid-question.

     What is NOT cleared: the mode. Where the toggle was left is a preference;
     what was scanned is a session. And nothing in flight is cancelled — a scan
     that was accepted must still land in the library, it simply finds no row
     to paint into. */
  window.addEventListener('hashchange', () => {
    if (!mounted) return;
    let path = '/';
    try { path = BT.router.parse().path || '/'; } catch (_) {}
    if (path === '/scan') return;

    mounted = false;
    if (BT.scanner && typeof BT.scanner.close === 'function') {
      try { BT.scanner.close(); } catch (e) { console.warn('[scan] the scanner would not close', e); }
    }
    for (const resolve of parked.values()) { try { resolve(null); } catch (_) {} }
    parked.clear();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (BT.scan && typeof BT.scan.resetGate === 'function') BT.scan.resetGate();
    rows = [];
    byScanId.clear();
    adopt = null;
  });

  return { render };
})();
