/* ══════════════════════════════════════════════════════════════════════════
   BT.scan — decode → look up → branch. No camera, no markup, no DOM.

   The camera, the decoder and the two-consecutive-decodes accept gate live in
   58-scanner.js; the viewfinder and the scan log live in 75-view-scan.js. THIS
   file owns the one part of scanning that can corrupt a library in silence:
   deciding what a thirteen-digit number MEANS against what is already on the
   shelves.

   ── THE RULE EVERYTHING ELSE HANGS OFF ────────────────────────────────────
   `isbn13:{isbn}` is an OWNERSHIP CLAIM, written only by closed items from
   `isbnsPinned`. `isbncand:{isbn}` is a POSSIBILITY, written only by open
   items from `isbnsCandidate`. BT.repo.resolveScan checks pinned first and
   REPORTS WHICH ONE MATCHED, because the two demand opposite behaviour:

     pinned    → you own this exact printing. Adding again is a no-op; the
                 remove door deletes it.
     candidate → you own this BOOK in an unspecified edition. Ask: pin this
                 edition to that item, or add a separate copy?
     neither   → a book you do not have. Create it, closed, pinned to exactly
                 the code that was scanned.

   Collapse those two namespaces and nothing throws. Every edition of every
   book the reader ever SEARCHED starts answering "already owned" to the
   scanner, and scanning a second printing can never create a second item —
   a scanner that silently stops adding anything. See 12-repo.js.

   ── WHY THIS FILE IS ASYNCHRONOUS IN A PARTICULAR SHAPE ───────────────────
   Open Library grants roughly one request per second and explicitly asks not
   to be used as a backend. A shelf clear-out is forty books in two minutes.
   Those two facts are irreconcilable if a scan blocks on the network, so they
   are not made to reconcile: handleScan answers the LOCAL question (is this
   already on the shelves?) out of IndexedDB, which is microseconds, and pushes
   only the catalogue lookup through `queue`, which drains one request at a
   time. The reader keeps scanning at full speed while rows resolve behind
   them. That is also why every result carries a `scanId` and why this module
   emits events — a row is written the instant a barcode decodes and has to be
   able to resolve in place, twenty rows later.

   ── WHY NOT BT.ui.addItem ─────────────────────────────────────────────────
   Three reasons, each of which cost a session to find:
     1. it toasts, and the toast layer (z 60) sits UNDER the scanner overlay
        (z 150), so the confirmation and its Undo are invisible during exactly
        the flow that produces them. Scan feedback belongs in the scan log.
     2. it deduplicates on `idKeysFor(stub)`, which is the search question.
        The scan question is pinned-vs-candidate, and it has a different
        answer for the same ISBN.
     3. it fires hydrate() per add — two more requests each, against the same
        one-per-second budget the queue exists to ration.
   So the writes are done here, through BT.repo, with the same two M4 seams
   (retier / snapshot baseline) that 50-ui-core guards.
   ══════════════════════════════════════════════════════════════════════════ */

BT.scan = (function () {

  /* ── Events ──────────────────────────────────────────────────────────────
     Same contract as BT.repo.subscribe: fn(event, detail), returns an
     unsubscribe, and a throwing listener can never take the scan with it —
     losing a row's repaint must not lose the book.

       scan:pending   { scanId, raw, isbn13, mode, at }
       scan:done      the full result object (see handleScan)
       scan:update    { scanId, uid, phase, ... }  late detail, after a pin
       queue:change   { depth, running }
       item:pinned | item:removed | item:restored                          */
  const listeners = new Set();

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function emit(event, detail) {
    for (const fn of listeners) { try { fn(event, detail); } catch (e) { console.error(e); } }
  }

  /* ── The serialized lookup queue ─────────────────────────────────────────
     BT.net already holds a token bucket (refilling at the honest sustained
     1 req/s for Open Library) and a concurrency lane, so this is NOT a second
     rate limiter and must not be tuned as one. It is a SEQUENCER, and it
     exists for a reason the bucket cannot serve: order.

     Without it, forty scans in two minutes become forty simultaneous promises
     all parked inside BT.net's lane, finishing in whatever order the network
     decides — so the scan log resolves row 9 before row 2, the item the reader
     is looking at is the one they scanned thirty seconds ago, and a burst on a
     bad connection can time out en masse. One at a time, oldest first, means
     the log fills top-down at the pace the source will actually answer.

     The gap is derived from BT.NET_POLICY.openlibrary rather than written as a
     number here, so there is one place to change the pace of the app.

     There is deliberately NO cancel(). Closing the overlay must not throw away
     books the reader already scanned — they scanned them, they want them —
     and a queue that empties on close is indistinguishable from one that lost
     your last five reads. */
  const queue = (function () {
    const jobs = [];
    const idleWaiters = new Set();
    let running = false;
    let lastStartedAt = 0;

    function gapMs() {
      const p = (BT.NET_POLICY && BT.NET_POLICY.openlibrary) || {};
      const rps = Number(p.rps) > 0 ? Number(p.rps) : 1;
      return Math.ceil(1000 / rps);
    }

    function push(job) {
      return new Promise((resolve, reject) => {
        jobs.push({ job, resolve, reject });
        emit('queue:change', { depth: jobs.length, running });
        drain();
      });
    }

    async function drain() {
      if (running) return;
      running = true;
      try {
        while (jobs.length) {
          /* Measured from the last request's START, not its finish: the
             ceiling is a rate, and charging the gap after a slow response
             would halve an already slow queue for nothing. */
          const wait = gapMs() - (Date.now() - lastStartedAt);
          if (wait > 0) await BT.util.sleep(wait);
          const t = jobs.shift();
          lastStartedAt = Date.now();
          /* One job's failure is one row's failure. The loop must survive it,
             or a single offline blip cancels every book behind it. */
          try { t.resolve(await t.job()); } catch (e) { t.reject(e); }
          emit('queue:change', { depth: jobs.length, running: true });
        }
      } finally {
        running = false;
        emit('queue:change', { depth: 0, running: false });
        for (const w of [...idleWaiters]) { idleWaiters.delete(w); w(); }
      }
    }

    return {
      push,
      depth: () => jobs.length,
      isRunning: () => running,
      gapMs,
      /* Resolves when the backlog is empty. The scan view uses it to decide
         when "12 pending" may stop being shown; tests use it to await a burst. */
      idle() {
        if (!running && !jobs.length) return Promise.resolve();
        return new Promise(res => idleWaiters.add(res));
      },
    };
  })();

  /* ── M4 seams ────────────────────────────────────────────────────────────
     48-sync and 45-alerts land in M4 and are not on the page yet. 50-ui-core
     guards both for the same reason and it is worth restating here: a bare
     `BT.sync.retier(item)` is a TypeError, and it would fire AFTER the item
     was written — so the library gains the book while the caller gets a
     rejected promise, and the scan log shows a failure for a book that is
     sitting on the shelf. */
  function retier(item) {
    if (BT.sync && typeof BT.sync.retier === 'function') BT.sync.retier(item);
    return item;
  }

  function baselineSnapshot(item) {
    const snap = (BT.alerts && typeof BT.alerts.snapshotOf === 'function')
      ? BT.alerts.snapshotOf(item)
      : { uid: item.uid };
    return Object.assign({ baseline: 1 }, snap);
  }

  /* ══ 1 · NORMALIZE ═══════════════════════════════════════════════════════
     A thin wrapper, and thin on purpose: BT.util.normalizeScanCode already
     knows about AIM prefixes (`]E0` injects a digit), the EAN-5 price add-on
     that makes a wedge emit eighteen digits, UPC-A widening, the mod-10
     checksum and the 979-0 ISMN range that is sheet music rather than a book.
     Re-implementing any of that here would be a second copy to keep in step
     with the first, and the failures are all silent.

     The one thing added is the LENGTH CEILING. A wedge scanner occasionally
     emits a burst of junk on a bad read — key repeats, a partial frame, the
     tail of the previous code glued to the front of this one — and there is no
     legitimate symbology in this app longer than an EAN-13 with an AIM prefix
     and a five-digit add-on. BT.LIMITS.scanInputMax is where that number
     lives; without the gate, a 400-character burst is left/right-truncated
     into something that can, rarely and infuriatingly, checksum clean. */
  function normalize(raw) {
    const s = raw == null ? '' : String(raw);
    const max = (BT.LIMITS && BT.LIMITS.scanInputMax) || 32;
    if (!s.trim()) return { ok: false, isbn13: null, reason: 'too-short' };
    if (s.length > max) return { ok: false, isbn13: null, reason: 'too-long' };
    return BT.util.normalizeScanCode(s);
  }

  /* What each rejection means to the caller. Kept distinct all the way to the
     scan log, because "that is a DVD" and "rescan, the read was corrupt" ask
     the reader to do completely different things and one message for both was
     the most confusing thing about the first cut. */
  const REASON_RESULT = {
    'too-short': 'invalid',
    'too-long': 'invalid',
    checksum: 'invalid',
    ismn: 'not-a-book',
    'not-a-book': 'not-a-book',
  };

  /* ══ 2 · RESOLVE — the local question, answered locally ═══════════════════
     -> { action: 'owned' | 'candidate' | 'new', uid?, item?, isbn13 }

     No network, ever. This is what makes rapid scanning possible: the branch
     is decided out of two IndexedDB gets while the reader is still moving the
     book away from the lens. */
  async function resolve(isbn13) {
    if (!isbn13) return { action: 'new', isbn13: null };
    const hit = await BT.repo.resolveScan(isbn13);
    if (!hit) return { action: 'new', isbn13 };

    const item = await BT.repo.getItem(hit.uid);
    /* An index row whose item is gone. It should not happen — deleteItem drops
       every namespace an item ever claimed — but if it does, the honest answer
       is "new". Refusing to add a book because of a row pointing at nothing is
       the worst available outcome: the reader is holding the book, the app
       says they own it, and there is nothing to open. */
    if (!item) return { action: 'new', isbn13, orphanUid: hit.uid };

    return {
      action: hit.via === 'pinned' ? 'owned' : 'candidate',
      uid: hit.uid, item, isbn13,
    };
  }

  /* ══ 3 · LOOKUP — one request, and the blind stub ═════════════════════════
     -> a normalized item stub. Never null.

     `/api/books` (BT.openlibrary.byIsbn) is the scan hot path because it is
     ONE request that already carries author names and cover URLs inline. The
     obvious alternative, `/isbn/{isbn}.json`, is a 302 — two round trips, which
     BT.net.costOf charges for — and hands back author KEYS, so every author
     costs a further request before anything can be shown. At one request per
     second that is the difference between a scan resolving while the reader is
     still holding the book and one that resolves after they have shelved it.

     THE MISS IS NOT AN ERROR. 13% of the editions Open Library holds for The
     Hobbit carry no ISBN of any kind, and the catalogue's coverage of small
     presses, book-club printings and anything pre-1970 is patchy by nature. A
     miss is the ordinary state of a barcode, not an exception — so it produces
     a usable BLIND STUB rather than a dead end, titled by its ISBN and marked
     `meta.partial` so hydrate fills it in the day the catalogue catches up.

     A network FAILURE is a different animal and is rethrown. Turning an outage
     into a blind stub would write a permanent placeholder record for a book
     Open Library knows perfectly well, which the reader then has to notice and
     repair by hand — the same trap 20-openlibrary.js documents at orNull(). */
  async function lookup(isbn13) {
    if (!BT.openlibrary || typeof BT.openlibrary.byIsbn !== 'function') {
      throw new Error('Open Library adapter is not loaded.');
    }
    const rec = await BT.openlibrary.byIsbn(isbn13);
    if (!rec) return blindStub(isbn13);
    const stub = BT.normalize.fromApiBooks(rec, isbn13);
    /* A 200 with a record we cannot turn into an item is, for our purposes,
       the same as no record — but it must still produce something to shelve. */
    return stub || blindStub(isbn13);
  }

  /* The uncatalogued book. Its uid is `book:isbn:{isbn13}` — the SAME uid
     fromApiBooks would mint for the same code — so when the catalogue does
     acquire the record, hydrate merges into this item rather than shadowing it
     with a second one.

     `release` is built with `inPrint: true` rather than left empty: an empty
     release is status 'unannounced', which would file a book the reader is
     physically holding under "Still to come". No date is known, and that is a
     different statement from "not published yet".

     No `links.openlibrary`. `/isbn/{code}` for a code the catalogue does not
     hold is a rendered 404 page, and a dead "View on Open Library" is worse
     than no link at all. */
  function blindStub(isbn13) {
    return {
      uid: BT.normalize.uidOf('isbn', isbn13),
      kind: 'book',
      scope: 'closed',
      /* A retail EAN-13 was read off a physical cover. 'physical' is an
         observation here, not a guess. */
      facets: { format: 'physical' },

      ids: {
        workOlid: null, olEdition: null, editionOlid: null,
        isbn13, isbn10: null,
        goodreads: null, librarything: null, oclc: null, lccn: null,
      },

      title: `ISBN ${isbn13}`,
      subtitle: '', description: '', firstSentence: '',
      authors: [], publishers: [], pageCount: null, pagination: '',
      byStatement: '', publishPlaces: [], languages: [],

      subjects: [],
      subjectFacets: { people: [], places: [], times: [] },
      genres: [],
      images: { coverId: null, covers: [], coverUrl: null, source: 'openlibrary' },
      release: BT.normalize.buildRelease('', { basis: 'none', inPrint: true }),

      isbnsPinned: [isbn13],
      isbnsCandidate: [],
      editionsTotal: null, editionsSeen: 0, editionsFetchedAt: 0,

      links: {}, externalLinks: [], ratings: {},

      rec: { fetchedAt: 0, franchiseKey: null, terms: {}, candidates: {}, seedEligible: 0 },
      meta: {
        schema: 1, primarySource: 'openlibrary', detailsFetchedAt: 0,
        normalizerVersion: 1, partial: 1,
        /* The flag that stops a placeholder title from ever overwriting a real
           one — see the guard in pinEdition. */
        blind: 1,
        manualOverrides: {},
      },
    };
  }

  const isBlind = stub => !!(stub && stub.meta && stub.meta.blind);

  /* ══ 4 · WRITES ══════════════════════════════════════════════════════════ */

  /* Create a NEW closed item for a scanned code.

     `scope: 'closed'` is stated, never inferred. The reader held one printing
     under the lens: this record is about that artefact, and 12-repo will
     therefore write its ISBN to the PINNED namespace. */
  async function createClosedItem(isbn13, stub, opts) {
    opts = opts || {};
    const base = stub || blindStub(isbn13);
    base.uid = await freeUid(base.uid || BT.normalize.uidOf('isbn', isbn13));

    const item = BT.normalize.withDefaults(
      base, opts.status || 'want', opts.source || 'scan', 'closed');

    /* THE SCANNED CODE IS THE CLAIM, and it is restated here rather than
       trusted to the payload. Field presence on Open Library edition records
       is wildly inconsistent — one live lookup BY ISBN-13 came back with no
       `isbn_13` field at all — so round-tripping the code through the response
       can pin the item to nothing, and rescanning that book then adds a
       duplicate every single time. */
    item.isbnsPinned = [...new Set([isbn13].concat(item.isbnsPinned || []))];
    /* A closed item has no candidates by definition: the reader has said which
       copy is on the shelf, so the other printings are somebody else's book.
       Leaving any here would have 12-repo write the same code into both
       namespaces. */
    item.isbnsCandidate = [];
    item.ids = Object.assign({}, item.ids, { isbn13 });

    retier(item);
    await BT.repo.putItem(item);
    /* First sighting is a BASELINE and announces nothing. Without it the very
       first observation of a record reads as a change against an empty
       snapshot, so adding a book reports that its title, its date and its page
       count all just changed. */
    await BT.repo.putSnapshot(baselineSnapshot(item));

    /* Fire-and-forget, and deliberately not skipped for scans. A scanned item
       is written complete (partial 0, edition TTL 30 days), so BT.ui.hydrate
       will not touch it for a month — and if the recommender only ever learned
       from hydrated items, it would never learn anything at all in a
       barcode-first library, which is most of this app's shelf. */
    BT.repo.dfObserve(item.uid, Object.keys((item.rec && item.rec.terms) || {}))
      .catch(e => console.warn('[scan] dfObserve failed', e));

    return item;
  }

  /* A uid is the foreign key in snapshots, the feed, the URL and every index
     row, so writing over an occupied one destroys a record in silence.

     This only fires in one real situation — "add as a separate copy" of a book
     already stored under `book:isbn:{code}`, or an index row lost to a partial
     write — and the suffix keeps the three-part uid grammar intact:
     `book:isbn:9780441172719c2` still parses, and the id stays alphanumeric,
     which is what BT.openlibrary.lookupUid's pattern requires. */
  async function freeUid(base) {
    if (!(await BT.repo.getItem(base))) return base;
    for (let n = 2; n <= 99; n++) {
      const cand = `${base}c${n}`;
      if (!(await BT.repo.getItem(cand))) return cand;
    }
    return `${base}c${Date.now().toString(36)}`;
  }

  /* ── Narrow an OPEN item to one edition, in place ────────────────────────
     The candidate branch's first choice, and the delicate one.

     "In place" is the whole point: the item keeps its uid, so the reader's
     status, rating, notes, tags, progress and reading history survive intact.
     They are not adding a book, they are ANSWERING A QUESTION about a book
     they already have — "which copy is it?" — and losing months of progress to
     that answer would be unforgivable.

     WHAT HAPPENS TO THE OLD INDEX ROWS IS THE WHOLE FUNCTION. An open item can
     carry hundreds of candidate ISBNs (The Hobbit's work yields 310 distinct
     ISBN-13s), each of which owns an `isbncand:` row pointing here. Every one
     of those must be retracted, because a single survivor resolves a LATER
     scan of a DIFFERENT printing straight to this item — so the separate copy
     the reader asked for can never be created, and the app answers "you
     already own this" to a book it has never seen. No error, no warning.

     12-repo's putItem does retract them, via the `idx.idKeys` breadcrumb it
     left on the previous write... except when there was no previous write ON
     THIS DEVICE. `leanForSync` strips `idx` for transport and `importAll`
     rebuilds the index with `writeIdIndex(item, [])`, so an item that arrived
     through a sync carries NO breadcrumb, and the first narrowing after a sync
     would leave every candidate row behind. So the breadcrumb is seeded by
     hand below with everything this item could possibly have claimed, and the
     retraction is verified afterwards rather than assumed. */
  async function pinEdition(uid, isbn13, edition) {
    const item = await BT.repo.getItem(uid);
    if (!item) return null;

    const prevCandidates = (item.isbnsCandidate || []).slice();
    const claimed = new Set([].concat(
      (item.idx && item.idx.idKeys) || [],
      prevCandidates.map(i => `isbncand:${i}`),
      (item.isbnsPinned || []).map(i => `isbn13:${i}`)));

    /* NEVER merge a blind stub into a real record. mergeItem takes the fresh
       payload's title whenever it has one, and a blind stub's title is the
       literal string 'ISBN 9780…' — merging one would rename "Dune" to its
       barcode, permanently, on the record carrying the reader's notes. */
    const usable = (edition && !isBlind(edition)) ? edition : null;
    const next = usable ? BT.normalize.mergeItem(item, usable) : item;

    /* The narrowing itself, stated after the merge so nothing in mergeItem's
       union rules can undo it. mergeItem accumulates candidates on purpose
       (they arrive 50 at a time from a paginated endpoint), which is exactly
       wrong here — this is the moment they stop being possibilities. */
    next.scope = 'closed';
    /* Exactly the code that was scanned, and nothing else. The normalizer's
       `pinnedIsbns` also keeps the other ISBN-13s printed on the same edition
       record, which is right when it is MINTING a record from that payload —
       they identify the same physical printing. It is not right here: the
       reader answered "which copy?" with one barcode, and claiming reissue
       codes on their behalf would send a scan of a genuinely different
       printing to this item. */
    next.isbnsPinned = [isbn13];
    next.isbnsCandidate = [];
    next.ids = Object.assign({}, next.ids, { isbn13 });

    /* `ids.olWork` is deliberately LEFT ALONE. 38-normalize refuses to set it
       on a freshly scanned item, because a stub carrying an `olwork:` claim
       would make BT.ui.addItem's search dedup swallow every later scan. That
       reasoning does not apply to an item that was ADDED by search and already
       owns the work: keeping the claim is what lets a future search for the
       same title still recognise it, and the scan path never consults the work
       namespace — resolveScan reads only the two ISBN namespaces. */

    next.idx = Object.assign({}, next.idx, { idKeys: [...claimed] });
    retier(next);
    await BT.repo.putItem(next);

    await verifyCandidatesRetracted(uid, prevCandidates);
    emit('item:pinned', { uid, isbn13, title: next.title, filled: usable ? 1 : 0 });
    return next;
  }

  /* Trust, then check. The retraction above is load-bearing enough that a
     silent failure is worth a console.error rather than a shrug: a leftover
     row does not break anything today, it breaks the NEXT scan of a different
     printing, weeks later, in a way nobody will connect to this write.

     A row that now belongs to a DIFFERENT uid is correct and expected — two
     open items may legitimately list the same candidate ISBN (a work split, an
     omnibus) and 12-repo's dropIdKeys refuses to delete another item's row. */
  async function verifyCandidatesRetracted(uid, candidates) {
    for (const i of candidates || []) {
      const owner = await BT.repo.resolveUid([`isbncand:${i}`]);
      if (owner === uid) {
        console.error('[scan] stale isbncand row survived a pin', { uid, isbn: i });
      }
    }
  }

  /* ── The candidate branch's second choice ────────────────────────────────
     A genuinely separate physical copy: the reader has the paperback AND the
     hardback, or two copies of the same printing, and both are on the shelf.

     The open item's `isbncand:` row for this code is left in place, which
     looks like a conflict and is not: the two namespaces are separate keys,
     and resolveScan reads PINNED FIRST — so the next scan of this barcode
     lands on the new copy, while the open item goes on standing for the work
     in general, which is what it is for. Stripping the candidate would be the
     actual error.

     A pure local write, like pinEdition: it shelves the edition it is handed
     and never fetches one. A view resolving a PARKED prompt (see
     'candidate-prompt' below) re-enters through handleScan with a forced
     choice instead, so the lookup goes through the queue with everything
     else. */
  async function addSeparateCopy(isbn13, edition, opts) {
    return createClosedItem(isbn13, edition || blindStub(isbn13), opts);
  }

  /* ── Remove by scan, with a way back ─────────────────────────────────────
     Deleting a book takes its rating, its notes, its tags, its progress and
     its reading history with it — months of a reader's own writing, discarded
     by a beep from across the room while they are looking at a shelf and not
     at the screen. So this hands back everything needed to put it all back,
     and the caller MUST offer it.

     PINNED ONLY. A candidate match means the reader owns this book in some
     unspecified edition — an item added by search that merely lists this
     barcode among its possibilities — and removing that on the strength of a
     scan would delete the record for a book they never said they were holding.
     You cannot remove what you do not have. */
  async function removeByScan(isbn13) {
    const hit = await BT.repo.resolveScan(isbn13);
    if (!hit) return { ok: false, reason: 'unknown', isbn13 };
    if (hit.via !== 'pinned') {
      return { ok: false, reason: 'candidate', uid: hit.uid, isbn13 };
    }

    const item = await BT.repo.getItem(hit.uid);
    if (!item) return { ok: false, reason: 'missing', uid: hit.uid, isbn13 };
    /* Captured BEFORE the delete: deleteItem drops the snapshot too, and
       restoring the item without it would make the next refresh diff a live
       record against nothing and announce every field as newly changed. */
    const snapshot = await BT.repo.getSnapshot(hit.uid);

    await BT.repo.deleteItem(hit.uid);

    const removal = {
      ok: true, uid: hit.uid, isbn13,
      title: item.title, item, snapshot,
      async restore() {
        /* putItem rewrites every id-index row from the record itself, so the
           `isbn13:` claim comes back with the book and the next scan finds it.
           It also stamps `user.updatedAt` — which is what settles the
           tombstone deleteItem wrote: the restored record is strictly newer
           than the deletion, so a future merge keeps the book. (The tombstone
           row itself outlives the undo; BT.repo has no untombstone and sync is
           deferred, so this is noted rather than worked around.) */
        const back = await BT.repo.putItem(item);
        if (snapshot) await BT.repo.putSnapshot(snapshot);
        emit('item:restored', { uid: back.uid, title: back.title });
        return back;
      },
    };
    /* Not restored: the alert-feed rows deleteItem cascades away. They are
       derived notifications about a book, not the book, and re-pushing them
       would coalesce and renumber them into something that never existed. */
    emit('item:removed', { uid: removal.uid, title: removal.title, isbn13 });
    return removal;
  }

  /* The Undo affordance, for the doors that are NOT the scanner overlay — a
     wedge scan typed into the list view, say. Inside the overlay the toast
     layer is covered (z 60 under z 150) and the scan log has to carry its own
     undo; pass the `removal` object straight to it. */
  function offerUndo(removal, opts) {
    opts = opts || {};
    if (!removal || !removal.ok) return null;
    if (!BT.ui || typeof BT.ui.toast !== 'function') return null;
    return BT.ui.toast(
      opts.message || `Removed “${BT.util.truncate(removal.title || '', 40)}”`,
      {
        actionLabel: 'Undo',
        onAction: async () => {
          try {
            await removal.restore();
            if (BT.router && typeof BT.router.resolve === 'function') BT.router.resolve();
          } catch (e) { console.error('[scan] undo failed', e); }
        },
      });
  }

  /* ══ 5 · HANDLE SCAN — the single entry point ═════════════════════════════
     -> { result, isbn13, uid?, title?, scanId, ... }

       'added'             a book is now on the shelves (new, pinned or copied)
       'removed'           a pinned item was deleted; `undo` is on the result
       'already-owned'     this exact printing is already pinned. No write.
       'candidate-prompt'  the reader owns this book in an unspecified edition
                           and has not yet answered which. NOTHING was written;
                           the caller settles it by re-entering with a forced
                           choice (see the branch itself).
       'not-found'         the CATALOGUE has no record. In add mode a blind
                           stub was still created and `uid` is set; in remove
                           mode nothing was pinned and nothing changed.
       'invalid'           not a readable barcode — rescan.
       'not-a-book'        a valid barcode for something that is not a book
                           (a DVD, groceries, or 979-0 sheet music).
       'error'             the lookup failed — offline, a 503, a timeout. NOT
                           in the milestone's list of results and deliberately
                           added: without it an outage reports 'not-found' and
                           the shelf fills with blind stubs for books Open
                           Library knows perfectly well. `retry()` is on the
                           result. This is the same distinction 20-openlibrary
                           draws at orNull — "we have no record of this" and
                           "we could not ask" must never render alike.        */

  const DEBOUNCE_MS = 2000;
  let seq = 0;
  let lastAccepted = '';
  let lastFiredAt = 0;
  let lastPromise = null;

  async function handleScan(raw, opts) {
    opts = opts || {};
    const mode = opts.mode === 'remove' ? 'remove' : 'add';
    const norm = normalize(raw);

    if (!norm.ok) {
      return finish({
        scanId: 's' + (++seq), raw: String(raw == null ? '' : raw),
        result: REASON_RESULT[norm.reason] || 'invalid',
        reason: norm.reason, isbn13: null, mode,
      }, opts, true);
    }

    const isbn13 = norm.isbn13;
    const now = Date.now();

    /* THE SECOND LINE OF THE ACCEPT RULE. The first — two consecutive
       identical checksum-valid decodes — belongs to the decoder, because it is
       a property of a camera re-reading the same barcode thirty times a
       second. This is the debounce that sits behind it, restated from the same
       rule: fire when the code differs, or when two seconds have passed.

       It is defence in depth rather than duplication. If the overlay ever
       forwards a live decode loop unthrottled, without this every frame
       becomes an Open Library request against a source that grants one per
       second, and the app throttles itself into uselessness in about a second.
       An in-flight scan is returned rather than re-run, so a burst of repeats
       collapses onto one row and one lookup.

       It cannot hide a real scan: two copies of the SAME printing cannot be
       presented to a lens two seconds apart, and if they were, the second one
       resolves 'already-owned' from the pinned row anyway.

       `opts.force` is the deliberate re-entry — a retry after an error, or the
       reader answering a parked candidate prompt. Both arrive on the same code
       and both are frequently inside two seconds (the prompt's default is one
       tap away), so without this exemption the tap would return the memoised
       'candidate-prompt' and nothing at all would happen. */
    if (!opts.force && isbn13 === lastAccepted && now - lastFiredAt <= DEBOUNCE_MS && lastPromise) {
      return lastPromise.then(prev => Object.assign({}, prev, { repeat: 1 }));
    }
    lastAccepted = isbn13;
    lastFiredAt = now;

    const scanId = 's' + (++seq);
    /* Emitted BEFORE anything is awaited, so the scan log can write its row
       while the reader is still moving the book. Every row must be able to
       exist in `pending` and resolve in place — see the geometry note in
       04-views.css, which is what stops the list jumping under a thumb. */
    emit('scan:pending', { scanId, raw: String(raw == null ? '' : raw), isbn13, mode, at: now });

    const run = (async () => {
      try {
        const out = await route(scanId, isbn13, mode, opts);
        return finish(Object.assign({ scanId, isbn13, mode }, out), opts, false);
      } catch (e) {
        console.warn('[scan] lookup failed', isbn13, e);
        return finish({
          scanId, isbn13, mode,
          result: 'error',
          reason: (e && e.kind) || 'error',
          message: (e && e.message) || String(e),
          /* One tap, not a rescan: the reader has already put the book down. */
          retry: () => handleScan(isbn13, Object.assign({}, opts, { force: true })),
        }, opts, false);
      }
    })();

    lastPromise = run;
    return run;
  }

  function finish(out, opts, alsoPending) {
    /* An unreadable code never entered the pending state, but the view keys
       its rows off scan:pending — so emit both rather than making every
       consumer carry a second code path for the one case that fails fastest. */
    if (alsoPending) {
      emit('scan:pending', { scanId: out.scanId, raw: out.raw, isbn13: null, mode: out.mode, at: Date.now() });
    }
    emit('scan:done', out);
    if (typeof opts.onUpdate === 'function') {
      try { opts.onUpdate(out); } catch (e) { console.error(e); }
    }
    return out;
  }

  async function route(scanId, isbn13, mode, opts) {
    const found = await resolve(isbn13);

    /* ── REMOVE MODE ──────────────────────────────────────────────────────
       Only a pinned match is a copy the reader holds. Everything else —
       candidate, or nothing at all — is 'not-found', and the uid is passed
       back so the log can say WHY: "you have this book, but not this copy" is
       a very different sentence from "never seen it". */
    if (mode === 'remove') {
      if (found.action !== 'owned') {
        return {
          result: 'not-found',
          via: found.action === 'candidate' ? 'candidate' : null,
          uid: found.uid || null,
          title: (found.item && found.item.title) || null,
        };
      }
      const removal = await removeByScan(isbn13);
      if (!removal.ok) return { result: 'not-found', uid: removal.uid || null };
      return {
        result: 'removed', uid: removal.uid, title: removal.title,
        removal, undo: removal.restore,
      };
    }

    /* ── ADD MODE ─────────────────────────────────────────────────────────── */

    /* Already pinned: a no-op REPORT, not a write and not an error. Scanning a
       shelf you have already scanned is the normal way to check you did. */
    if (found.action === 'owned') {
      return {
        result: 'already-owned', uid: found.uid,
        title: found.item.title,
        status: (found.item.user && found.item.user.status) || null,
      };
    }

    if (found.action === 'candidate') return candidateBranch(scanId, isbn13, found, opts);

    /* New. The lookup goes through the queue; the write happens the moment it
       lands, so the row resolves in place however far behind the reader it is. */
    const stub = await queue.push(() => lookup(isbn13));
    const item = await createClosedItem(isbn13, stub, opts);
    return {
      result: isBlind(stub) ? 'not-found' : 'added',
      uid: item.uid, title: item.title, added: 1, blind: isBlind(stub) ? 1 : 0,
    };
  }

  /* ── The candidate prompt ────────────────────────────────────────────────
     An explicit product decision, and the reason it is a prompt rather than a
     rule: both answers are common and the app cannot tell them apart. The
     reader searched "Dune" months ago, and is now holding A Dune — is it the
     copy that record stands for, or a second one on the same shelf?

     TWO one-tap choices, DEFAULTING TO PIN, because narrowing the record you
     already have is the answer nine times out of ten and it is the one that
     keeps your rating and your notes attached to the book.

     The prompt fires IMMEDIATELY, off local state, while the reader is still
     holding the book — it does not wait for the network. Pinning therefore
     happens in two steps: the identity is narrowed at once (which is the part
     that matters and the part that must survive being offline), and the
     edition's own publisher, extent, format and printing date are merged in
     when the queue gets to them. */
  async function candidateBranch(scanId, isbn13, found, opts) {
    const uid = found.uid;
    const title = found.item && found.item.title;
    const choice = await ask(opts.onPrompt, {
      isbn13, uid, item: found.item, title,
      defaultChoice: 'pin',
      choices: ['pin', 'separate'],
    });

    if (choice === 'pin') {
      const pinned = await pinEdition(uid, isbn13, null);
      /* The item went away between the resolve and the answer — deleted from
         another pane, or wiped mid-session. There is still a book in the
         reader's hand, so shelve it rather than reporting a pin onto nothing. */
      if (!pinned) {
        const stub = await queue.push(() => lookup(isbn13));
        const fresh = await createClosedItem(isbn13, stub, opts);
        return { result: 'added', action: 'separate', uid: fresh.uid, title: fresh.title };
      }
      fillPinnedEdition(scanId, uid, isbn13);
      return { result: 'added', action: 'pinned', uid, title, narrowed: 1 };
    }

    if (choice === 'separate') {
      const stub = await queue.push(() => lookup(isbn13));
      const item = await addSeparateCopy(isbn13, stub, opts);
      return {
        result: 'added', action: 'separate', uid: item.uid, title: item.title,
        fromUid: uid, blind: isBlind(stub) ? 1 : 0,
      };
    }

    /* No answer — no onPrompt supplied, or the reader dismissed it. NOTHING is
       written; a scanning session must never stop moving because a question is
       open. The decision is handed back whole so the view can park it on the
       row and settle it whenever the reader gets to it, by re-entering here
       with the choice made:

         BT.scan.handleScan(isbn13, { mode: 'add', force: true,
                                      onPrompt: () => 'pin' })

       which is one call rather than three, and keeps the lookup inside the
       queue with every other scan. `force` is required: the default choice is
       one tap away and the debounce would otherwise swallow it. */
    return {
      result: 'candidate-prompt', uid, title, item: found.item,
      defaultChoice: 'pin', choices: ['pin', 'separate'],
    };
  }

  /* `true` means "the default", so a prompt UI can answer with the primary
     button without knowing which one that is. Anything unrecognised is a
     dismissal, which is the safe reading: a stray return value must not write
     a record. */
  async function ask(onPrompt, detail) {
    if (typeof onPrompt !== 'function') return null;
    let answer;
    try { answer = await onPrompt(detail); }
    catch (e) { console.warn('[scan] prompt failed', e); return null; }
    if (answer === true) return detail.defaultChoice;
    if (answer === 'pin' || answer === 'separate') return answer;
    return null;
  }

  /* The second half of a pin. The item is already narrowed and already correct
     — this only fills in what only the edition record knows: publisher, page
     count, physical format, and the printing's own publish date, which
     supersedes the work's `first_publish_year` through pickRelease (basis
     'edition-published' carries full weight, the work-level year is halved
     because it is a computed minimum that one mis-catalogued reprint drags
     back decades).

     Failure here is swallowed to a warning on purpose: the ownership claim is
     already written and already indexed, and a book that says "1965" instead
     of "Aug 1, 1990" is not a failed scan. */
  function fillPinnedEdition(scanId, uid, isbn13) {
    queue.push(() => lookup(isbn13))
      .then(async stub => {
        if (isBlind(stub)) {
          emit('scan:update', { scanId, uid, phase: 'filled', blind: 1 });
          return;
        }
        const next = await pinEdition(uid, isbn13, stub);
        emit('scan:update', {
          scanId, uid, phase: 'filled',
          title: next && next.title,
          item: next,
        });
      })
      .catch(e => {
        console.warn('[scan] edition fill failed', isbn13, e);
        emit('scan:update', { scanId, uid, phase: 'fill-failed', message: (e && e.message) || String(e) });
      });
  }

  /* Session boundary. The debounce memo is the only state that outlives a
     scan, and a new session should not inherit "you just scanned this". */
  function resetGate() {
    lastAccepted = '';
    lastFiredAt = 0;
    lastPromise = null;
  }

  return {
    subscribe, emit,
    normalize, resolve, lookup,
    handleScan,
    pinEdition, addSeparateCopy, removeByScan, offerUndo,
    createClosedItem, blindStub,
    queue, resetGate,
    DEBOUNCE_MS,
  };
})();
