/* ══════════════════════════════════════════════════════════════════════════
   BT.repo — the only storage API the rest of the app is allowed to use.

   D5: everything (views, sync, alerts, the recommender) calls BT.repo, and
   NOTHING calls BT.db directly. That rule is what makes the deferred GitHub
   sync layer a drop-in later rather than a rewrite: sync needs exactly one
   place to observe writes and one place to reconcile reads, and this is it.

   The other thing that lives here, and nowhere else, is the id-namespace
   policy — see `idKeysFor`. Getting that wrong does not throw; it quietly
   makes every scan behave as though you already own the book.
   ══════════════════════════════════════════════════════════════════════════ */

BT.repo = (function () {
  const listeners = new Set();

  function emit(event, detail) {
    for (const fn of listeners) { try { fn(event, detail); } catch (e) { console.error(e); } }
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ── Items ─────────────────────────────────────────────────────────── */

  const getItem = uid => BT.db.get('items', uid);
  const allItems = () => BT.db.getAll('items');
  const countItems = () => BT.db.count('items');

  async function putItem(item) {
    item.user = item.user || {};
    item.user.updatedAt = Date.now();
    item.sortTitle = BT.util.sortTitleOf(item.title);
    /* Read the breadcrumb BEFORE normalising, because normalizeIndexable
       overwrites it with the keys this write claims. */
    const prevKeys = (item.idx && item.idx.idKeys) || [];
    normalizeIndexable(item);
    await BT.db.put('items', item);
    await writeIdIndex(item, prevKeys);
    emit('item:put', item);
    return item;
  }

  /* Silent write — used by background refresh so a sweep doesn't spam the UI
     with a re-render per item. Does not bump updatedAt. */
  async function putItemQuiet(item) {
    item.sortTitle = BT.util.sortTitleOf(item.title);
    const prevKeys = (item.idx && item.idx.idKeys) || [];
    normalizeIndexable(item);
    await BT.db.put('items', item);
    await writeIdIndex(item, prevKeys);
    return item;
  }

  /* IndexedDB cannot index arrays of objects, and booleans are not valid keys.
     Both problems are solved here, in one place, on every write. */
  function normalizeIndexable(item) {
    item.idx = item.idx || {};
    item.idx.genreIds = (item.genres || []).map(g => g.id).filter(v => v != null);
    item.idx.authorIds = collectAuthorIds(item);
    item.idx.publisherKeys = collectPublisherKeys(item);
    const p = item.release && BT.util.sortKeyToParts(item.release.sortKey);
    item.idx.decade = p ? Math.floor(p.y / 10) * 10 : undefined;

    if (item.user) {
      item.user.tags = Array.isArray(item.user.tags) ? item.user.tags : [];
      item.user.priority = item.user.priority || 0;
      /* `rating` must be ABSENT when unrated, never 0 — the by_userRating index
         is deliberately sparse, and 0 would mean "rated zero". */
      if (item.user.rating == null || item.user.rating === '') delete item.user.rating;
      /* Ownership axis, independent of reading status: you can own a book you
         have not started, and can finish one you never owned. null is a real
         value here, not "unset". */
      if (item.user.pile !== 'sell' && item.user.pile !== 'sold') item.user.pile = null;
    }
    /* by_tag indexes `idx.tags`, not `user.tags`. The copy exists so a
       multiEntry index never points into user-editable state that a view might
       hand us as a string, a null, or a Set. */
    item.idx.tags = (item.user && item.user.tags) || [];

    if (item.tracking) {
      /* watchEditionsFlag is the book analogue of MovieTrak's per-episode
         watch: it asks to be told when a new printing or format appears (the
         paperback drop), which is the only thing about a published book that
         still moves. */
      for (const k of ['watchReleaseFlag', 'watchEditionsFlag', 'mutedFlag']) {
        if (typeof item.tracking[k] === 'boolean') item.tracking[k] = item.tracking[k] ? 1 : 0;
      }
    }
    /* facets.format is a string, so it needs no 0|1 dance — but it does need a
       value, because the list view groups on it and `undefined` would open a
       nameless bucket. It is not indexed; see the note in 10-db.js. */
    if (item.facets) {
      const f = item.facets.format;
      if (f !== 'physical' && f !== 'ebook' && f !== 'audiobook') item.facets.format = 'unspecified';
    }

    /* Not an IndexedDB index — a breadcrumb. It records which idIndex rows this
       item claimed on its last write, so the NEXT write knows what to retract.
       Without it, narrowing an open item to one edition would leave its old
       candidate rows behind for ever. */
    item.idx.idKeys = idKeysFor(item);
  }

  function collectAuthorIds(item) {
    const out = new Set();
    for (const a of (item.authors || [])) {
      const id = a && (a.id != null ? a.id : a.olid);
      if (id != null && id !== '') out.add(String(id));
    }
    return [...out];
  }

  /* Publishers arrive as free text ('Chilton Books', 'Chilton books.') and there
     is no id anywhere in Open Library to lean on, so the key IS the normalised
     name. Fold case and strip punctuation, or the same imprint splits into
     three facet rows. */
  function collectPublisherKeys(item) {
    const out = new Set();
    const raw = [].concat(item.publishers || [], (item.edition && item.edition.publishers) || []);
    for (const p of raw) {
      const name = typeof p === 'string' ? p : (p && p.name);
      if (!name) continue;
      const key = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (key) out.add(key);
    }
    return [...out];
  }

  async function deleteItem(uid) {
    const item = await getItem(uid);
    /* Recorded BEFORE the delete, so a merge can tell "I removed this" from
       "I have never seen this". */
    await BT.db.put('deleted', { uid, deletedAt: Date.now(),
                                 title: item ? item.title : null });
    await BT.db.del('items', uid);
    await BT.db.del('snapshots', uid);
    /* Cascade: leaving feed rows pointing at a deleted item produces alerts
       that navigate nowhere. */
    const rows = await BT.db.getAll('feedItems');
    for (const r of rows) if (r.uid === uid) await BT.db.del('feedItems', r.feedId);
    /* Cascade: the reading log goes with the book. 39-scan states the contract
       plainly — "Deleting a book takes its rating, its notes, its tags, its
       progress and its reading history with it" — and leaving it behind broke
       that twice over. The Reading Pace chart iterates raw history rows, so it
       went on charting pages read in a book that is not on any shelf ("300
       pages … in 1 book" for an empty shelf), the orphans travelled in
       exportAll to every other device, and a re-scan of the same barcode gets
       the same uid back from freeUid and silently inherited the dead copy's
       progress and finish. Undo is preserved by removeByScan, which now
       captures these rows before the delete and puts them back.

       `dfSeen` is deliberately NOT cascaded: it guards the recommender's
       document-frequency counters against double-counting a book, and dropping
       the row without decrementing every term in `df` would leave N smaller
       than the counts it normalises — a silently skewed IDF curve. It is
       local, unsynced state that costs one stale row. */
    const hist = await BT.db.getAll('history');
    /* `id != null` because the in-memory fallback store mints its key without
       writing it onto the row (10-db.js), and a delete with an undefined key is
       not something to find out about during a delete. */
    for (const h of hist) if (h && h.uid === uid && h.id != null) await BT.db.del('history', h.id);
    /* Every namespace, not just the ones this item's current scope writes — a
       surviving `isbncand:` row would resolve a future scan to a book that no
       longer exists. */
    if (item) {
      const keys = allIdKeysFor(item);
      await dropIdKeys(keys, uid);
      await reclaimIdKeys(keys);
    }
    emit('item:delete', { uid });
  }

  /* ── Id namespaces ─────────────────────────────────────────────────────
     FOUR namespaces, and the split between the last two is the whole scan
     story:

       olwork:{OLID}     the work. Search-add dedup only.
       oledition:{OLID}  one specific edition.
       isbn13:{isbn}     PINNED. Written only by scope:'closed' items, from
                         item.isbnsPinned. Scan-add dedup and remove-by-scan.
       isbncand:{isbn}   CANDIDATE. Written only by scope:'open' items, from
                         item.isbnsCandidate — the many ISBNs a work is known
                         by when the user has not said which copy they hold.

     A searched book is `open`: it stands for the work, not for a copy, and
     Open Library will happily list forty ISBNs for it. If those forty went
     into the PINNED namespace, then every edition of every book you ever
     searched would answer "already owned" to a scanner, and scanning a
     different printing could never create a second item. That is the exact
     opposite of what the app is for, and it fails silently — no error, just a
     scanner that never adds anything. Hence two namespaces and a resolver that
     says which one matched. */

  function idKeysFor(item) {
    const keys = [];
    const ids = item.ids || {};
    if (ids.olWork) keys.push(`olwork:${ids.olWork}`);
    if (ids.olEdition) keys.push(`oledition:${ids.olEdition}`);
    /* Scope decides the ISBN namespace, and nothing else does. A closed item
       never writes candidates: once you have told us which copy is on the
       shelf, the other thirty-nine printings are somebody else's book. */
    if (item.scope === 'closed') {
      for (const i of (item.isbnsPinned || [])) if (i) keys.push(`isbn13:${i}`);
    } else {
      for (const i of (item.isbnsCandidate || [])) if (i) keys.push(`isbncand:${i}`);
    }
    return [...new Set(keys)];
  }

  /* Everything this item could ever have claimed, in all four namespaces and
     regardless of its current scope. `idKeysFor` is scope-aware and answers
     "what does it claim now?"; this answers "what might be out there with its
     name on it?" — which is what a delete has to clean up. */
  function allIdKeysFor(item) {
    const keys = new Set(idKeysFor(item));
    for (const i of (item.isbnsPinned || [])) if (i) keys.add(`isbn13:${i}`);
    for (const i of (item.isbnsCandidate || [])) if (i) keys.add(`isbncand:${i}`);
    for (const k of ((item.idx && item.idx.idKeys) || [])) keys.add(k);
    return [...keys];
  }

  /* Delete only rows we still own. Two open items can legitimately list the
     same candidate ISBN (a work split, an omnibus), in which case the row
     belongs to whichever wrote last — and blind deletion here would strip the
     other item's index entry as a side effect of saving this one. */
  async function dropIdKeys(keys, uid) {
    for (const k of keys) {
      const row = await BT.db.get('idIndex', k);
      if (!row || row.uid === uid) await BT.db.del('idIndex', k);
    }
  }

  /* Is this ISBN the item's OWN barcode, or one it merely lists?

     A scanned record states its code twice: `ids.isbn13` (and, for a record
     this app minted, the uid itself). Everything else in `isbnsPinned` was
     harvested from the same Open Library edition record by `pinnedIsbns` —
     useful, but a claim nobody made on purpose. */
  function isPrimaryIsbn(item, isbn) {
    if (!item || !isbn) return false;
    if (item.ids && item.ids.isbn13 === isbn) return true;
    return typeof item.uid === 'string' && item.uid.indexOf(`book:isbn:${isbn}`) === 0;
  }

  /* MAY THIS ITEM TAKE THIS ROW? Only `isbn13:` is arbitrated, and that is the
     whole point of the question.

     `isbn13:{isbn}` is ONE row and two items cannot both hold it. Both
     interactive pin doors already refuse to steal it (59-editions.js and
     56-inspector.js, each with the same comment) — but the SCAN-ADD path did
     not, and it does not go through them. 38-normalize's `pinnedIsbns`
     deliberately keeps every other ISBN-13 printed on the same edition record,
     on the reasoning that they identify the same printing; live Open Library
     data disagrees often enough to matter (of the first 200 of The Hobbit's 481
     edition records, 12 ISBN-13s are claimed by more than one edition). So
     scanning book B silently took the row belonging to book A, and from then on
     A's barcode reported "already owned" under B's title, remove-by-scan
     deleted B — with B's rating, notes, progress and reading history — and A
     became invisible to the scanner and duplicated on the next scan. No error
     at any point.

     THE RULE: a row is taken from another item only by the item whose OWN
     barcode it is. A passing mention never displaces a scanned claim, and two
     scanned claims resolve to whoever got there first rather than to whoever
     wrote last — which also makes an export/import rebuild land on the same
     winner as the live store instead of a different one.

     `isbncand:` is deliberately NOT arbitrated: two open items may legitimately
     list the same candidate ISBN (a work split, an omnibus) and last-writer-wins
     is the documented behaviour there — see dropIdKeys. */
  async function mayClaim(key, item) {
    if (key.indexOf('isbn13:') !== 0) return true;
    const row = await BT.db.get('idIndex', key);
    if (!row || row.uid === item.uid) return true;
    const isbn = key.slice(7);
    if (!isPrimaryIsbn(item, isbn)) return false;
    const holder = await BT.db.get('items', row.uid);
    if (!holder) return true;                       // the row outlived its item
    return !isPrimaryIsbn(holder, isbn);
  }

  /* Rewrite an item's rows: retract the keys it no longer claims, then write
     the ones it does. `prev` is the breadcrumb from the previous write. The
     retraction is the point — "Specify Edition" turns an open item with forty
     candidate ISBNs into a closed item with one pinned ISBN, and a single
     leftover `isbncand:` row would send a later scan of a DIFFERENT printing
     straight to this item instead of creating the separate copy the user
     asked for. */
  async function writeIdIndex(item, prev) {
    const next = idKeysFor(item);
    const keep = new Set(next);
    const stale = (prev || []).filter(k => !keep.has(k));
    if (stale.length) await dropIdKeys(stale, item.uid);
    for (const key of next) {
      if (!(await mayClaim(key, item))) continue;
      await BT.db.put('idIndex', { key, uid: item.uid });
    }
  }

  /* Re-derive ownership of rows that have just become unowned.
     Called after a delete, and the mirror image of dropIdKeys.

     dropIdKeys protects the SAVE path: it refuses to delete a row another item
     holds. The DELETE path had the opposite hole — when the deleted item WAS
     the holder, the row simply vanished even though a surviving item still
     listed that ISBN. The scanner then stopped recognising a book the reader
     owns: instead of "pin this edition, or add a separate copy?" it silently
     minted a second, unlinked record, which is how a library quietly
     accumulates duplicates. (Two open items sharing a candidate ISBN is
     ordinary — Open Library carries several work records for popular titles,
     and culling one of them is a tidy-up, not a contrived state.)

     Scope-aware, because it reuses idKeysFor: a surviving open item reclaims
     `isbncand:` rows and a surviving closed one reclaims `isbn13:` rows, never
     the other way round.

     A PINNED row is handed on only to an item whose OWN barcode it is. An
     item that merely lists the code — `pinnedIsbns` keeps every ISBN-13 on the
     edition record it was minted from — must not inherit a freed barcode,
     because resolveScan would then answer "already owned" under that other
     book's title AND the barcode's real owner could never be re-added: the
     scan would resolve to the squatter instead of creating a record. Leaving
     the row unowned is the better failure — the next scan mints the right book
     and mayClaim hands it the row. */
  async function reclaimIdKeys(keys) {
    const want = new Set();
    for (const k of keys) if (!(await BT.db.get('idIndex', k))) want.add(k);
    if (!want.size) return;
    for (const it of await allItems()) {
      for (const k of idKeysFor(it)) {
        if (!want.has(k)) continue;
        if (k.indexOf('isbn13:') === 0 && !isPrimaryIsbn(it, k.slice(7))) continue;
        await BT.db.put('idIndex', { key: k, uid: it.uid });
        want.delete(k);
      }
      if (!want.size) return;
    }
  }

  /* Resolve any known external id to a stored uid. This is what stops the same
     book entering the library twice via search, a recommendation, and a
     followed author's bibliography. Caller supplies the keys in priority
     order. */
  async function resolveUid(candidateKeys) {
    for (const key of candidateKeys) {
      const hit = await BT.db.get('idIndex', key);
      if (hit) return hit.uid;
    }
    return null;
  }

  /* The scanner's resolver. PINNED first, CANDIDATE second, and the answer
     names which one matched, because the caller must behave differently:

       via 'pinned'    → you already own this exact edition. Offer the item.
       via 'candidate' → you have an unspecified copy of this book. Offer the
                         choice: pin this edition to that item, or add this as
                         a separate copy.
       null            → new book.

     Collapsing those two into a bare uid throws away the only signal that
     distinguishes "already on the shelf" from "which copy is this?". */
  async function resolveScan(isbn13) {
    if (!isbn13) return null;
    const pinned = await BT.db.get('idIndex', `isbn13:${isbn13}`);
    if (pinned) return { uid: pinned.uid, via: 'pinned', isbn13 };
    const cand = await BT.db.get('idIndex', `isbncand:${isbn13}`);
    if (cand) return { uid: cand.uid, via: 'candidate', isbn13 };
    return null;
  }

  async function itemsByStatus(status) {
    const out = [];
    await BT.db.walkIndex('items', 'by_status_priority',
      IDBKeyRange.bound([status, -Infinity], [status, Infinity]),
      v => { out.push(v); });
    return out;
  }

  async function upcomingItems(limit) {
    const out = [];
    const today = BT.util.todaySortKey();
    await BT.db.walkIndex('items', 'by_pubSort',
      IDBKeyRange.lowerBound(today),
      v => {
        if (v.user && v.user.status === 'dropped') return;
        out.push(v);
        if (limit && out.length >= limit) return false;
      });
    return out;
  }

  async function itemsDueForRefresh(limit) {
    const out = [];
    await BT.db.walkIndex('items', 'by_refreshDue',
      IDBKeyRange.upperBound(Date.now()),
      v => { out.push(v); if (limit && out.length >= limit * 4) return false; });
    return out;
  }

  /* ── Snapshots ─────────────────────────────────────────────────────── */
  const getSnapshot = uid => BT.db.get('snapshots', uid);
  const putSnapshot = s => BT.db.put('snapshots', s);

  /* ── Alerts: an append-only ledger plus a mutable feed ───────────────
     Content-addressing and coalescing cannot share one store, so they don't.
     `alertKeys` answers "have we ever seen this exact change?" and is never
     mutated. `feedItems` is what gets rendered and is merged in place. */

  async function alertSeen(alertId) {
    try {
      await BT.db.add('alertKeys', { alertId, firstSeenAt: Date.now() });
      return false;                       // newly recorded → this is news
    } catch (e) {
      if (e && e.name === 'ConstraintError') return true;   // already known
      throw e;
    }
  }

  async function pushFeedItem(row) {
    /* Coalesce into an existing UNREAD row for the same (uid, type): four
       pub-date slips become one line reading "Nov 13 → Mar 6 (changed 4×)". */
    const existing = await BT.db.getAll('feedItems');
    const match = existing.find(r =>
      r.uid === row.uid && r.type === row.type && r.readAt == null && !r.archivedFlag);
    if (match) {
      match.to = row.to;
      match.title = row.title || match.title;
      match.count = (match.count || 1) + 1;
      match.lastAt = row.lastAt || Date.now();
      match.payload = row.payload || match.payload;
      match.severity = row.severity || match.severity;
      await BT.db.put('feedItems', match);
      emit('feed:change');
      return match;
    }
    row.feedId = row.feedId || (row.alertId || BT.util.fnv1a(`${row.uid}|${row.type}|${Date.now()}`));
    row.count = row.count || 1;
    row.firstAt = row.firstAt || Date.now();
    row.lastAt = row.lastAt || Date.now();
    row.readAt = null;
    row.readFlag = 0;                     // 0|1 — booleans are not valid keys
    row.archivedFlag = row.archivedFlag ? 1 : 0;
    await BT.db.put('feedItems', row);
    emit('feed:change');
    return row;
  }

  async function feedItems(opts) {
    opts = opts || {};
    const all = await BT.db.getAll('feedItems');
    let rows = all;
    if (!opts.includeArchived) rows = rows.filter(r => !r.archivedFlag);
    if (opts.type) rows = rows.filter(r => r.type === opts.type);
    if (opts.unreadOnly) rows = rows.filter(r => r.readAt == null);
    rows.sort((a, b) => b.lastAt - a.lastAt);
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async function unreadCount() {
    const all = await BT.db.getAll('feedItems');
    return all.filter(r => r.readAt == null && !r.archivedFlag).length;
  }

  async function markFeedRead(feedIds) {
    const now = Date.now();
    for (const id of feedIds) {
      const r = await BT.db.get('feedItems', id);
      if (r && r.readAt == null) { r.readAt = now; r.readFlag = 1; await BT.db.put('feedItems', r); }
    }
    emit('feed:change');
  }

  async function markAllFeedRead() {
    const all = await BT.db.getAll('feedItems');
    const now = Date.now();
    const upd = all.filter(r => r.readAt == null).map(r => (r.readAt = now, r.readFlag = 1, r));
    await BT.db.putMany('feedItems', upd);
    emit('feed:change');
  }

  /* ── Dismissed recommendations ─────────────────────────────────────── */
  const dismiss = (uid, kind, reason, title) =>
    BT.db.put('dismissed', { uid, kind, reason: reason || 'not_interested', title, dismissedAt: Date.now() });
  const dismissedSet = async () => new Set((await BT.db.getAll('dismissed')).map(d => d.uid));
  const undismiss = uid => BT.db.del('dismissed', uid);
  const allDismissed = () => BT.db.getAll('dismissed');

  /* ── Follows (authors, and series once we can identify one) ────────── */
  const allFollows = () => BT.db.getAll('follows');
  const getFollow = id => BT.db.get('follows', id);
  async function putFollow(f) { await BT.db.put('follows', f); emit('follow:change'); return f; }
  async function deleteFollow(id) { await BT.db.del('follows', id); emit('follow:change'); }

  /* ── Cache ─────────────────────────────────────────────────────────── */

  async function cacheGet(key) {
    const row = await BT.db.get('cache', key);
    if (!row) return null;
    const now = Date.now();
    if (now > row.hardExpiresAt) { BT.db.del('cache', key); return null; }
    return { payload: row.payload, stale: now > row.expiresAt, fetchedAt: row.fetchedAt };
  }

  async function cachePut(key, source, payload, ttl, cacheClass) {
    const now = Date.now();
    try {
      await BT.db.put('cache', {
        key, source, payload,
        cacheClass: cacheClass || 'reduced',
        fetchedAt: now,
        expiresAt: now + ttl,
        /* Two expiries, doing different jobs.

           `expiresAt` is when we should go and ask again. `hardExpiresAt` is
           when the row is deleted outright. Open Library's data is openly
           licensed and imposes no retention limit, so unlike MovieTrak — whose
           hard expiry was a TMDB licence term — ours is pure hygiene: a
           guarantee that nothing outlives a schema change.

           Everything between the two is the OUTAGE BUFFER: 05-net serves a
           soft-expired row when the upstream cannot be reached, which is what
           keeps covers and publication dates on screen while Open Library is
           down. Shortening this to a multiple of `ttl` would quietly delete
           that safety net — a 10-minute search TTL would leave nothing to fall
           back on after 40 minutes. (The expression here used to be
           `min(HARD, max(ttl*4, HARD))`, which always collapses to HARD; this
           is the same behaviour, stated on purpose.) */
        hardExpiresAt: now + BT.TTL.HARD_TTL,
      });
    } catch (e) { console.warn('[repo] cache write failed', e); }
  }

  async function cachePurge() {
    const now = Date.now();
    const dead = [];
    await BT.db.walkIndex('cache', 'by_hardExpiresAt', IDBKeyRange.upperBound(now),
      v => { dead.push(v.key); });
    for (const k of dead) await BT.db.del('cache', k);
    return dead.length;
  }

  const cacheClear = () => BT.db.clear('cache');
  const cacheCount = () => BT.db.count('cache');

  /* ── Document frequency (for the recommender's IDF) ─────────────────
     Every book the app ever touches contributes exactly once, ever. Without
     the dfSeen guard, re-fetching the same work on each refresh inflates DF
     monotonically and silently flattens the whole IDF curve over months —
     which for books means 'fiction' and 'american literature' stop being the
     worthless terms they are and start carrying weight. */

  async function dfObserve(uid, terms) {
    if (!uid || !terms || !terms.length) return;
    const seen = await BT.db.get('dfSeen', uid);
    if (seen) return;
    await BT.db.put('dfSeen', { uid, at: Date.now() });
    for (const t of terms) {
      const row = await BT.db.get('df', t);
      await BT.db.put('df', { term: t, n: (row ? row.n : 0) + 1 });
    }
    const n = await BT.db.count('dfSeen');
    await metaSet('df.N', n);
  }

  async function dfTable() {
    const rows = await BT.db.getAll('df');
    const map = new Map();
    for (const r of rows) map.set(r.term, r.n);
    return { map, N: (await metaGet('df.N')) || Math.max(1, map.size) };
  }

  /* ── History ─────────────────────────────────────────────────────────
     The reading log: status changes, ratings, and progress events (page or
     percent). It is the one store here that is a user-authored record rather
     than derived state, which is why it travels in SYNC_STORES below. */
  const addHistory = (uid, event, value) => BT.db.put('history', { uid, event, value, at: Date.now() });
  const allHistory = () => BT.db.getAll('history');

  /* The two halves of an undoable delete. `historyFor` is read BEFORE
     deleteItem cascades the log away and `putHistory` puts the same rows back
     — with their original `id`, so a restore re-creates the log rather than
     duplicating it. Without this pair, cascading the log would have made
     removeByScan's Undo quietly lossy: the book would come back and the months
     of reading behind it would not. */
  async function historyFor(uid) {
    return (await BT.db.getAll('history')).filter(r => r && r.uid === uid);
  }
  async function putHistory(rows) {
    for (const r of (rows || [])) await BT.db.put('history', r);
  }

  /* ── Meta ──────────────────────────────────────────────────────────── */
  async function metaGet(key) { const r = await BT.db.get('meta', key); return r ? r.value : undefined; }
  async function metaSet(key, value) { return BT.db.put('meta', { key, value }); }

  /* ── Export / import ───────────────────────────────────────────────── */

  /* Stores that genuinely have to travel between devices. `history` is in the
     list, so reading progress syncs for free. Deliberately NOT here:
     `snapshots` (per-device change-detection state — a fresh device
     re-baselines and, by the cold-snapshot rule, emits nothing), `idIndex`
     (rebuilt from items below), `df`/`dfSeen` (the recommender's local corpus,
     which re-accumulates), and `cache`. */
  const SYNC_STORES = ['items', 'follows', 'dismissed', 'alertKeys',
                       'feedItems', 'history', 'deleted'];

  async function exportAll() {
    const payload = {};
    for (const s of SYNC_STORES) payload[s] = await BT.db.getAll(s);
    payload.items = payload.items.map(BT.normalize.leanForSync);
    payload.meta = { settings: BT.config.exportable(), dfN: await metaGet('df.N') };
    const doc = {
      app: 'booktrak', kind: 'booktrak.export', schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      counts: Object.fromEntries(Object.entries(payload)
        .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
      payload,
    };
    doc.integrity = { algo: 'fnv1a', value: BT.util.fnv1a(JSON.stringify(payload)) };
    return doc;
  }

  /* Replace-only, by design. Merge semantics are a distributed-systems problem
     and there is no distributed system yet — sync is deferred.
     alertKeys IS restored: drop it and every historical change re-fires as new
     the moment you import onto a fresh browser. */
  async function importAll(doc) {
    if (!doc || doc.app !== 'booktrak') throw new Error('Not a BookTrak export file.');
    if (doc.schemaVersion !== 1) throw new Error(`Unsupported export version ${doc.schemaVersion}.`);
    const p = doc.payload || {};

    /* Keep whatever detail this device already has, so a sync does not throw
       away records we would only have to fetch again. */
    const localItems = new Map((await BT.db.getAll('items')).map(i => [i.uid, i]));

    for (const s of SYNC_STORES) {
      await BT.db.clear(s);
      if (!Array.isArray(p[s]) || !p[s].length) continue;
      let rows = p[s];
      /* `history` has an autoIncrement key. Ship the row without its `id` and
         let this device mint its own, or two devices' logs collide on 1..n. */
      if (s === 'history') rows = rows.map(r => { const c = { ...r }; delete c.id; return c; });
      if (s === 'items') rows = rows.map(r => BT.normalize.absorbSynced(localItems.get(r.uid), r));
      await BT.db.putMany(s, rows);
    }

    /* idIndex is a pure function of items, so it is rebuilt rather than
       shipped — it was 19 KB of every commit for nothing. Rebuilt from a clean
       store, so there is no prior claim to retract. */
    await BT.db.clear('idIndex');
    for (const it of (await BT.db.getAll('items'))) await writeIdIndex(it, []);
    if (p.meta) {
      if (p.meta.settings) BT.config.importSettings(p.meta.settings);
      if (p.meta.dfN != null) await metaSet('df.N', p.meta.dfN);
    }
    await metaSet('sync.lastImportAt', Date.now());
    emit('import:done');
    return doc.counts || {};
  }

  async function wipe() {
    for (const s of BT.db.STORE_NAMES) await BT.db.clear(s);
    emit('wipe');
  }

  return {
    subscribe, emit,
    getItem, allItems, countItems, putItem, putItemQuiet, deleteItem,
    resolveUid, resolveScan, idKeysFor, itemsByStatus, upcomingItems, itemsDueForRefresh,
    getSnapshot, putSnapshot,
    tombstones: () => BT.db.getAll('deleted'),
    alertSeen, pushFeedItem, feedItems, unreadCount, markFeedRead, markAllFeedRead,
    dismiss, undismiss, dismissedSet, allDismissed,
    allFollows, getFollow, putFollow, deleteFollow,
    cacheGet, cachePut, cachePurge, cacheClear, cacheCount,
    dfObserve, dfTable,
    addHistory, allHistory, historyFor, putHistory,
    metaGet, metaSet,
    exportAll, importAll, wipe,
  };
})();
