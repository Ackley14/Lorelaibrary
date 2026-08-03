/* ══════════════════════════════════════════════════════════════════════════
   #/settings — genre maintenance, keys, region, diagnostics, data.

   The headline action here is RECALCULATE GENRES, and it is the reason this
   screen stopped being optional. Genres in BookTrak are derived: Open
   Library's subject strings are mapped through BT.GENRE_RULES into at most
   three of seven display buckets. That table is a permanent maintenance
   burden by design — it is the single biggest quality lever in the app, and
   it gains rules whenever somebody spots a miss. Horror is the live example:
   it was added after most libraries were already stocked, so every King and
   every Shirley Jackson added before that rule existed is still filed under
   Fantasy & SF, and nothing in the app would ever revisit it. A refresh does
   not help — 38-normalize buckets the payload it was handed, and a book whose
   record has not changed is never re-fetched.

   Everything else on this screen is honest bookkeeping: the two settings that
   actually do something (a Google Books key and a contact address), the
   region, what storage we ended up with, and the export/import/erase trio.

   NOT here, deliberately: the encrypted GitHub sync UI. See the M5 seam at the
   foot of the file — half-wired sync is worse than none.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewSettings = (function () {
  const esc = BT.util.escapeHtml;

  /* One press of "Fetch subjects" costs TWO Open Library requests per book —
     the work record and its editions page, which is what BT.ui.hydrate asks for
     — at the ~1 req/sec an anonymous browser client is entitled to (05-net's
     note on the User-Agent we are not allowed to send explains why it is 1 and
     not 3). Measured: 3 books, 6 requests, never more than one in flight, a
     1000 ms median gap. So budget ~2 seconds a book, not one.
     A cap keeps the longest a single press can run to about a minute, and
     pressing again is one click — which is a far better shape than a progress
     bar somebody has to babysit for ten minutes, and it makes "never fan out"
     structural rather than a promise. */
  const REFETCH_BATCH = 25;
  const SECS_PER_BOOK = 2;   // two requests, one a second

  /* ── Module state ──────────────────────────────────────────────────────
     Module-level rather than per-render on purpose. The undo ledger has to
     survive a re-render AND navigating away: losing the only route back to
     hand-set genres because someone clicked Library to look at the result is
     precisely the data loss this whole flow exists to prevent. */
  let stats = null;      // { total, overridden, noSubjects } as of the last render
  let ask = null;        // the survey, while the "recalculate mine too?" question is up
  let lastRun = null;    // { rep, before, at, fetched } — the result and its undo ledger
  let busy = false;      // a pass is running
  let refetch = null;    // { done, total, stop } while subjects are being re-fetched

  /* ══ GENRE RECALCULATION ══════════════════════════════════════════════════
     WHY THIS LIVES HERE and not beside bucketGenres in 38-normalize.js: the
     bucketing RULE is normalization and stays there. A bulk pass is not — it
     reads every item, writes every item, keeps an undo ledger and reports to a
     screen. 38-normalize is a pure transform module today and references
     BT.repo nowhere, which is exactly what lets the scanner, the search view
     and (later) the sync layer all call it without dragging storage in behind
     them. Putting a write loop in there would hand the normalizer a storage
     dependency for the sake of one button, and the next person to reuse
     mergeItem would inherit it.

     THE ONE THING THAT MUST NOT BE GOT WRONG is the override.

     A reader who corrects a genre in the detail pane does not just get
     `item.genres` rewritten — 56-inspector also records the corrected list at
     `item.meta.manualOverrides.genres`, and mergeItem replays every path in
     that ledger over the merged record as the LAST thing it does. That is what
     stops a background metadata fetch quietly reverting their fix hours later.

     So re-deriving `genres` on an overridden item and leaving the ledger alone
     would appear to work and then silently undo itself on the next hydrate.
     The reset has to clear `manualOverrides.genres` too, which is a real loss
     of user-authored data — hence the question, hence the undo ledger, and
     hence "leave them alone" being the answer that is already selected. */

  const hasGenreOverride = item =>
    !!(item && item.meta && item.meta.manualOverrides && item.meta.manualOverrides.genres);

  const subjectsOf = item => (item && Array.isArray(item.subjects)) ? item.subjects : [];

  /* Buckets compared by id, in stored order. Order is not incidental — it is
     BT.GENRE_BUCKETS order on both sides (bucketGenres ranks, the inspector
     filters), and BT.ui.genreTag draws only the first two, so a reordering is
     a visible change and counts as one. */
  const genreKey = list => (list || []).map(g => g && g.id).filter(Boolean).join(',');

  /* COPIED, not mutated in place — the same rule 56-inspector and mergeItem
     follow, so a caller still holding the old record does not watch its ledger
     change underneath it.

     And DELETED rather than set to undefined. mergeItem replays
     `Object.keys(overrides)` through setPath, so a surviving `genres:
     undefined` key would assign undefined over the freshly merged buckets and
     ensureGenres would then file the book under General — the exact silent
     wipe this function is here to avoid. */
  function clearGenreOverride(item) {
    const meta = item.meta || (item.meta = {});
    const next = Object.assign({}, meta.manualOverrides);
    delete next.genres;
    meta.manualOverrides = next;
  }

  /* A full scan, which is what the honest answer costs. A personal library is
     hundreds of records, not millions, and this screen is not a hot path. */
  async function survey() {
    const items = await BT.repo.allItems();
    let overridden = 0, noSubjects = 0;
    for (const it of items) {
      if (hasGenreOverride(it)) overridden++;
      if (!subjectsOf(it).length) noSubjects++;
    }
    return { total: items.length, overridden, noSubjects };
  }

  /* opts.includeManual — true means "re-derive the ones I set by hand too",
     which is the only path that clears an override.

     Returns a report AND its undo ledger. The ledger holds only records this
     pass actually wrote, so an Undo restores exactly what changed and touches
     nothing else. */
  async function recalcGenres(opts) {
    opts = opts || {};
    const items = await BT.repo.allItems();
    const now = Date.now();
    const rep = {
      total: items.length,
      changed: 0,      // buckets moved
      same: 0,         // re-derived to the same buckets
      kept: 0,         // left alone because you set them by hand
      cleared: 0,      // your override removed so the re-derived value can stick
      skipped: 0,      // no stored subjects — see skippedUids
      skippedUids: [],
      before: [],
    };

    for (const item of items) {
      const overridden = hasGenreOverride(item);
      if (overridden && !opts.includeManual) { rep.kept++; continue; }

      /* THE MISSING-SUBJECTS CASE, and the reason it is a skip rather than a
         re-derive. `leanForSync` strips `subjects` from every item written to
         the sync payload — forty strings a record, heavy, and re-fetchable from
         a work id. So a book that arrived from another device has none, and
         `bucketGenres([])` is not "this book is unclassifiable", it is "we were
         given nothing". It returns [general] by design, and writing that here
         would silently overwrite a perfectly correct Mystery with General on
         every book the other device sent. Counted and reported instead. */
      const subjects = subjectsOf(item);
      if (!subjects.length) { rep.skipped++; rep.skippedUids.push(item.uid); continue; }

      /* Stored subjects are already through cleanSubjects (the normalizers run
         it before the record is written) and bucketGenres runs it again on the
         way in. That is idempotent — the stoplist, the length filter and the
         dedup have all already passed — so feeding it the stored list is safe
         and costs one pass over a short array. */
      const next = BT.normalize.bucketGenres(subjects);
      const moved = genreKey(next) !== genreKey(item.genres);

      /* Nothing to do only when the buckets agree AND there is no ledger entry
         to clear. Without the second half, choosing "recalculate mine too"
         would leave the override in place on every book whose hand-set value
         already matched the rules — and the override, not the value, is what
         decides whether a future refresh may move it. */
      if (!moved && !overridden) { rep.same++; continue; }

      rep.before.push({
        uid: item.uid,
        genres: item.genres,
        hadOverride: overridden,
        override: overridden ? item.meta.manualOverrides.genres : null,
      });

      item.genres = next;
      if (overridden) { clearGenreOverride(item); rep.cleared++; }
      if (moved) rep.changed++; else rep.same++;

      /* `updatedAt` is stamped BY HAND, and that line is load-bearing.
         putItemQuiet exists for the background sweep and deliberately does not
         bump it — a refresh that rewrote the timestamp would make every swept
         record look newer than another device's genuine edits. This is the
         opposite case: it is a user-initiated edit, and without the stamp a
         later merge sees an older record and throws the whole pass away.
         Quiet means "do not re-render", not "do not count". */
      item.user = item.user || {};
      item.user.updatedAt = now;
      await BT.repo.putItemQuiet(item);
    }
    return rep;
  }

  /* One line, and every number in it is something that actually happened. */
  function reportLine(rep) {
    const bits = [`Re-bucketed ${BT.util.pluralize(rep.changed, 'book')}`];
    if (rep.same) bits.push(`${rep.same} unchanged`);
    if (rep.kept) bits.push(`${rep.kept} left as you set them`);
    if (rep.cleared) bits.push(`${rep.cleared} of yours reset`);
    if (rep.skipped) bits.push(`${rep.skipped} skipped (no subject data)`);
    return bits.join(' · ');
  }

  async function runRecalc(opts) {
    busy = true;
    paintRecalc();
    let rep;
    try {
      rep = await recalcGenres(opts);
    } catch (e) {
      /* A pass that died halfway has still written whatever it got to before
         the failure, and those writes are real. Say so plainly rather than
         letting this surface as an unhandled rejection on a screen that looks
         like it did nothing — and refresh, so the shelf on screen matches the
         database. */
      console.error('[settings] genre recalculation failed', e);
      BT.ui.toast('Recalculation stopped: ' + ((e && e.message) || String(e))
        + ' — anything already re-bucketed was saved.', { bad: true, ms: 9000 });
      BT.repo.emit('item:put', null);
      BT.tree.refresh();
      return;
    } finally {
      busy = false;
      paintRecalc();
    }

    lastRun = { rep, before: rep.before, at: Date.now(), fetched: 0 };
    paintRecalc();
    refreshGenreStats();

    /* ONE event for the batch, exactly as BT.ui.bulkSetPile does it. The writes
       above were quiet, so the tree and any open list re-render once here
       instead of once per book — a 200-item library would otherwise rebuild the
       index tree 200 times while the pass ran. */
    if (rep.before.length) { BT.repo.emit('item:put', null); BT.tree.refresh(); }

    BT.ui.toast(reportLine(rep), rep.before.length
      /* Longer than the usual 7s: this touched the whole shelf, and the reader
         has to read a four-part sentence before deciding. The Undo in the panel
         below outlives the toast anyway — the toast is the fast route back, not
         the only one. */
      ? { actionLabel: 'Undo', onAction: () => undoRecalc(), ms: 12000 }
      : { ms: 6000 });
  }

  async function undoRecalc() {
    if (!lastRun || !lastRun.before.length) return;
    const before = lastRun.before;
    lastRun = null;
    paintRecalc();

    const t = Date.now();
    let n = 0;
    for (const row of before) {
      const it = await BT.repo.getItem(row.uid);
      if (!it) continue;                       // deleted since; nothing to put back
      it.genres = row.genres;
      /* The ledger is restored as well as the value. This pass never CREATES an
         override, so the else branch is a no-op today — it is written anyway so
         that the restore is total rather than "total for the cases we thought
         of", which is the property an undo has to have. */
      const meta = it.meta || (it.meta = {});
      const ov = Object.assign({}, meta.manualOverrides);
      if (row.hadOverride) ov.genres = row.override; else delete ov.genres;
      meta.manualOverrides = ov;
      it.user = it.user || {};
      it.user.updatedAt = t;
      await BT.repo.putItemQuiet(it);
      n++;
    }
    BT.repo.emit('item:put', null);
    BT.tree.refresh();
    BT.ui.toast(`Put ${BT.util.pluralize(n, 'book')} back the way ${n === 1 ? 'it was' : 'they were'}`);
    paintRecalc();
    refreshGenreStats();
  }

  /* The standing count above the button — "214 books · 3 with genres you set by
     hand". It is the one line on this screen that a run makes wrong, and the
     wrong version is the misleading kind: after choosing "recalculate those
     too" it would still claim three books are protected when none are. */
  function statsLine(s) {
    return `${s.total} ${s.total === 1 ? 'book' : 'books'}`
      + (s.overridden ? ` · ${s.overridden} with ${s.overridden === 1 ? 'a genre' : 'genres'} you set by hand` : '')
      + (s.noSubjects ? ` · ${s.noSubjects} with no stored subjects` : '');
  }

  async function refreshGenreStats() {
    const el = document.getElementById('genreStats');
    if (!el) return;
    stats = await survey();
    /* Re-checked: the element can have gone while the scan was running. */
    const still = document.getElementById('genreStats');
    if (still) still.textContent = statsLine(stats);
  }

  /* ── Re-fetching subjects for the skipped books ────────────────────────
     Strictly serial, one book at a time, capped at REFETCH_BATCH, with a Stop
     button and a live count. Open Library publishes ~1 request/second for
     anonymous clients and its terms explicitly forbid using it as a backend for
     a high-traffic service; a `Promise.all` over forty books would break both
     at once, so there is no concurrency here at all and BT.net's token bucket
     is the second line of defence rather than the first.

     It goes through BT.ui.hydrate rather than reaching for the Open Library
     adapter directly, because everything after the fetch — the merge policy,
     clearing `partial`, re-tiering, the write — lives in that one function and
     a second copy would be a second place for the override rules to drift.
     The cost of using it is that it writes with putItem rather than
     putItemQuiet, so the tree refreshes once per book; at one book a second
     that is a non-issue, and duplicating the merge policy to avoid it would
     not be. */
  async function runRefetch() {
    if (!lastRun || !lastRun.rep.skippedUids.length || refetch) return;
    const batch = lastRun.rep.skippedUids.slice(0, REFETCH_BATCH);
    refetch = { done: 0, total: batch.length, stop: false };
    paintRecalc();

    let filled = 0, failed = 0;
    for (const uid of batch) {
      if (refetch.stop) break;
      try {
        const item = await BT.repo.getItem(uid);
        if (item) {
          /* BT.ui.hydrate honours a TTL and hands the record straight back
             inside it. A book whose subjects were stripped for transport is
             genuinely incomplete however recently it was fetched, so it is
             marked `partial` first — the same flag leanForSync sets on the way
             out for exactly this reason — rather than teaching the hydrate path
             a force switch that every other caller would then have to reason
             about. */
          const meta = item.meta || (item.meta = {});
          if (!meta.partial) { meta.partial = 1; await BT.repo.putItemQuiet(item); }
          const fresh = await BT.ui.hydrate(uid);
          if (fresh && Array.isArray(fresh.subjects) && fresh.subjects.length) filled++;
        }
      } catch (e) {
        /* A book Open Library cannot answer for is a book left exactly as it
           was. Never fatal to the batch — a maintenance window mid-run would
           otherwise abandon the twenty books after it. */
        failed++;
        console.warn('[settings] subject re-fetch failed', uid, e && e.message);
      }
      refetch.done++;
      paintProgress();
    }

    const stopped = refetch.stop;
    refetch = null;

    /* Re-read rather than assume. Whatever came back has ALREADY been
       re-bucketed — hydrate merges through 38-normalize, which buckets the
       fresh subjects with today's rules and replays any manual override on top
       — so the honest remaining list is "still has no subjects", checked. */
    const remaining = [];
    for (const uid of lastRun.rep.skippedUids) {
      const it = await BT.repo.getItem(uid);
      if (it && !subjectsOf(it).length) remaining.push(uid);
    }
    lastRun.rep.skippedUids = remaining;
    lastRun.rep.skipped = remaining.length;
    lastRun.fetched += filled;
    paintRecalc();
    refreshGenreStats();
    BT.tree.refresh();

    BT.ui.toast(
      `${stopped ? 'Stopped · ' : ''}Subjects fetched for ${BT.util.pluralize(filled, 'book')}`
      + (failed ? ` · ${failed} could not be reached` : ''), { ms: 6000 });
  }

  /* ══ THE RECALCULATE PANEL ════════════════════════════════════════════════
     A small state machine drawn into one element, so the question, the
     progress and the result all replace each other in the place the button
     was, rather than appearing somewhere else on a long screen. */

  function recalcPanel() {
    if (refetch) return refetchBlock();
    if (ask) return askBlock();
    return `
      <p class="actions">
        <button class="btn btn--primary" id="recalcGo"${busy ? ' disabled' : ''}>${
          busy ? 'Working…' : 'Recalculate genres'}</button>
      </p>
      ${lastRun ? resultBlock() : ''}`;
  }

  /* The question. NOT a window.confirm(), and that is the whole point: OK is
     confirm()'s default action — the one Enter presses — so the safe answer
     could only ever have been the button you had to aim for. */
  function askBlock() {
    const n = ask.overridden;
    return `
      <div class="ask">
        <div class="ask__q">${BT.util.pluralize(n, 'book')} ${n === 1 ? 'has a genre' : 'have genres'} you set by hand.</div>
        <p class="field__help">
          Recalculating those replaces your corrections with whatever today’s rules make of
          the catalogue’s subjects — and it also has to clear the note that keeps a metadata
          refresh from overwriting them, or the old value would simply come back the next
          time the book was refreshed. Every other book is re-derived either way.
        </p>
        <p class="actions">
          <button class="btn btn--primary" id="askSafe">Leave mine alone</button>
          <button class="btn btn--danger" id="askAll">Recalculate those too</button>
          <button class="btn btn--ghost" id="askCancel">Cancel</button>
        </p>
      </div>`;
  }

  function refetchBlock() {
    return `
      <div class="runres">
        <div class="runres__l" id="refetchLabel">Fetching subjects — ${refetch.done} of ${refetch.total}</div>
        <div class="gauge"><i id="refetchBar" style="width:0%"></i></div>
        <div class="field__state">One request at a time, about one a second — Open Library’s
          published rate for clients it cannot identify.</div>
        <p class="actions" style="margin-top:var(--bt-space-3)">
          <button class="btn btn--sm" id="refetchStop"${refetch.stop ? ' disabled' : ''}>${
            refetch.stop ? 'Stopping…' : 'Stop'}</button>
        </p>
      </div>`;
  }

  /* Persistent on purpose. A toast expires in seconds and takes its Undo with
     it, and this is the one screen where losing the way back means losing
     genres somebody typed. */
  function resultBlock() {
    const rep = lastRun.rep;
    const canUndo = lastRun.before.length > 0;
    return `
      <div class="runres">
        <div class="runres__l">${esc(reportLine(rep))}</div>
        <div class="field__state">${esc(BT.util.timeAgo(lastRun.at))}${
          lastRun.fetched ? ` · subjects since fetched for ${lastRun.fetched} more` : ''}${
          canUndo ? '' : ' · nothing to undo'}</div>
        ${rep.skipped ? skippedNote(rep) : ''}
        ${canUndo ? `<p class="actions" style="margin-top:var(--bt-space-4)">
          <button class="btn btn--sm" id="recalcUndo">Undo — put those genres back</button>
        </p>` : ''}
      </div>`;
  }

  function skippedNote(rep) {
    const n = rep.skipped;
    const batch = Math.min(REFETCH_BATCH, n);
    return `
      <p class="field__help" style="margin-top:var(--bt-space-4)">
        <b>${BT.util.pluralize(n, 'book')} ${n === 1 ? 'has' : 'have'} no stored subjects</b>,
        so there was nothing to re-derive from and ${n === 1 ? 'it was' : 'they were'} left
        exactly as ${n === 1 ? 'it is' : 'they are'}. Subject lists are heavy and re-fetchable,
        so they are stripped from the sync payload — a book that arrived from another device
        carries none until something opens it. Filing those under
        <span class="num">General</span> would have thrown away genres that are very likely
        already right.
      </p>
      <p class="actions" style="margin-top:var(--bt-space-3)">
        <button class="btn btn--sm" id="recalcFetch">Fetch subjects for ${
          batch === n ? (n === 1 ? 'it' : 'all ' + n) : batch + ' of them'}</button>
      </p>
      <div class="field__state">Two requests per book — the work and its editions — one at a
        time, roughly ${Math.max(1, Math.ceil(batch * SECS_PER_BOOK))} seconds${
        batch < n ? ` — press again for the remaining ${n - batch}` : ''}. Each book’s genre is
        re-derived as it lands, so there is nothing to run afterwards.</div>`;
  }

  function paintRecalc() {
    const el = document.getElementById('recalcPanel');
    if (!el) return;
    el.innerHTML = recalcPanel();
    wireRecalc();
  }

  /* Targeted, not a repaint: replacing the whole block on every step would
     rebuild the Stop button under the pointer sixty times. */
  function paintProgress() {
    if (!refetch) return;
    const l = document.getElementById('refetchLabel');
    const g = document.getElementById('refetchBar');
    if (l) l.textContent = `Fetching subjects — ${refetch.done} of ${refetch.total}`;
    if (g) g.style.width = (refetch.total ? Math.round(refetch.done / refetch.total * 100) : 0) + '%';
  }

  function wireRecalc() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

    on('recalcGo', async () => {
      busy = true;
      paintRecalc();
      const s = await survey();
      busy = false;
      stats = s;
      /* Nothing hand-set: there is nothing to ask about and nothing to lose
         that the Undo does not cover, so just do it. */
      if (!s.overridden) { runRecalc({ includeManual: false }); return; }
      ask = s;
      paintRecalc();
      /* Focus the SAFE answer, so Enter and the space bar both do the thing
         that cannot lose anything. */
      const safe = document.getElementById('askSafe');
      if (safe) safe.focus();
    });

    on('askSafe',   () => { ask = null; runRecalc({ includeManual: false }); });
    on('askAll',    () => { ask = null; runRecalc({ includeManual: true }); });
    on('askCancel', () => { ask = null; paintRecalc(); });
    on('recalcUndo',  () => undoRecalc());
    on('recalcFetch', () => runRefetch());
    on('refetchStop', () => { if (refetch) { refetch.stop = true; paintRecalc(); paintProgress(); } });
  }

  /* ══ KEY VERIFICATION ═════════════════════════════════════════════════════
     There is no Google Books client module yet — 22-googlebooks.js is the gap
     noted in index.html — so this is the one place that URL is built, and it
     moves into that adapter the day it lands. It does NOT call fetch(): BT.net
     is the only caller of fetch() in this app, and the budget, the token
     bucket, the circuit breaker and the cache all live behind it.

     `ttl: 0, noCache: true` because a cached 200 from a previous key would
     cheerfully report a revoked one as working. Same shape 20-openlibrary's
     verifyReachable() uses, for the same reason. */
  async function verifyGoogleKey() {
    const key = BT.config.key('googlebooks');
    if (!key) return { ok: false, reason: 'No key set — the Google path stays switched off.' };
    try {
      const raw = await BT.net.get('googlebooks',
        `${BT.GB.volumes}?${BT.net.qs({ q: 'isbn:9780441013593', maxResults: 1, key })}`,
        { ttl: 0, noCache: true, staleOk: false });
      if (raw && typeof raw.totalItems === 'number') return { ok: true, reason: 'Key works.' };
      return { ok: false, reason: 'Google answered, but not with a volumes response.' };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  }

  /* ══ RENDER ═══════════════════════════════════════════════════════════════ */

  async function render(params, query, alive) {
    const view = document.getElementById('view');
    if (!view) return;

    BT.ui.crumb(['System', 'Settings']);
    BT.ui.paneActions('');

    const [items, cache, s] = await Promise.all([
      BT.repo.countItems(), BT.repo.cacheCount(), survey(),
    ]);
    /* Google Books is the only source with a budget at all — Open Library
       publishes a RATE, not a quota, so budgetState() correctly returns null
       for it and there is no gauge to draw. */
    const gb = BT.config.hasKey('googlebooks') ? await BT.net.budgetState('googlebooks') : null;
    if (alive && !alive()) return;
    stats = s;

    const onGithubIo = /\.github\.io$/i.test(location.hostname);

    view.innerHTML = `
      <div class="settings">
        <div class="pagehead"><h1>Settings</h1></div>

        ${BT.db.isFallback() ? `<div class="warnbox">
          <strong>Limited storage mode</strong>
          This browser is blocking IndexedDB, so BookTrak is running on a much smaller
          localStorage store. Export often — this mode is not reliable for a real library.
        </div>` : ''}

        ${genreSection(s)}
        ${keySection(gb)}
        ${contactSection()}
        ${regionSection()}
        ${diagnosticsSection(items, cache, onGithubIo)}
        ${dataSection(items)}

        <section class="section">
          ${BT.ui.groupHead('About')}
          <div class="prose" style="font-size:var(--bt-fs-sm)">
            <p>BookTrak is a personal, non-commercial tool. Everything is stored in this
            browser and there is no server.</p>
            <p>Catalogue data and covers come from <b>Open Library</b>, which is free, keyless
            and openly licensed — which is why it is the primary source here rather than a
            fallback, and why the app needs no setup at all.</p>
            <p>Open Library holds no forthcoming-title data: no announcement flag, no street
            date, no publisher feed. That is why Activity says “newly listed in this
            catalogue” and never “new release”, and why most publication dates in the app are
            year-only and drawn with the day hatched out rather than invented.</p>
          </div>
        </section>
      </div>`;

    wire();
  }

  /* ── Genres ──────────────────────────────────────────────────────────── */
  function genreSection(s) {
    return `
      <section class="section">
        ${BT.ui.groupHead('Genres')}
        <div class="field">
          <label class="field__label">Recalculate genres</label>
          <div class="field__help">
            Genres are not stored by the catalogue — they are derived, by mapping Open
            Library’s subject strings through a table of rules that gains entries whenever
            somebody spots a book in the wrong bucket. A book is bucketed once, when it is
            added or refreshed, so a rule added afterwards never reaches it.
            <b>Horror is the current example</b>: that bucket was added recently, and anything
            on your shelves from before it is still filed under Fantasy &amp; SF, where those
            subjects used to land. This re-runs the rules over every book’s stored subjects.
          </div>
          <div class="field__state" id="genreStats">${esc(statsLine(s))}</div>
          <div id="recalcPanel">${recalcPanel()}</div>
        </div>
      </section>`;
  }

  /* ── Keys ────────────────────────────────────────────────────────────── */
  function keySection(gb) {
    const stored = BT.config.keyIsLocal('googlebooks');
    const active = BT.config.hasKey('googlebooks');
    return `
      <section class="section">
        ${BT.ui.groupHead('Google Books key')}
        <div class="warnbox">
          <strong>Optional, and the app is complete without it</strong>
          Open Library needs no key and covers search, works, editions, authors and covers on
          its own. Google Books only ever fills gaps — a missing description, a missing page
          count — and is never a fallback for anything load-bearing.
        </div>
        <div class="field">
          <label class="field__label" for="key-gb">API key <span class="faint">(optional)</span></label>
          <div class="field__help">
            <b>Anonymous Google Books access is not throttled, it is off.</b> An
            unauthenticated volumes request now answers HTTP 429 carrying
            <span class="num">"quota_limit_value":"0"</span> — a quota of zero, not a quota we
            exceeded. Verified against the live API. So there is no shared key baked into this
            app and no anonymous path to fall back to: without a key of your own, the whole
            Google half stays switched off and nothing else changes.
            <a href="https://console.cloud.google.com/apis/library/books.googleapis.com"
               target="_blank" rel="noopener">Create one in Google Cloud ↗</a>
          </div>
          <input id="key-gb" type="text" spellcheck="false" autocomplete="off"
                 placeholder="Paste your key" value="${stored ? esc(BT.config.key('googlebooks')) : ''}">
          <div class="field__state ${active ? 'field__state--ok' : ''}" id="key-gb-state">
            ${active ? '● Using your key' : '○ Not configured — Google enrichment is off'}
          </div>
          <p class="actions" style="margin-top:var(--bt-space-2)">
            <button class="btn btn--sm" id="key-gb-save">Save &amp; test</button>
            ${stored ? '<button class="btn btn--sm btn--ghost" id="key-gb-clear">Clear</button>' : ''}
          </p>
          <div class="field__help" style="margin-top:var(--bt-space-3)">
            Stored in this browser only. It is never included in an export.
          </div>
          ${gb ? `<div class="field__help" style="margin-top:var(--bt-space-3)">
            Google Books requests from this browser this ${esc(gb.period)}:
            <span class="num">${gb.used} / ${gb.cap}</span>
            <div class="gauge"><i class="${gb.used / gb.cap > 0.8 ? 'hot' : ''}"
              style="width:${Math.min(100, Math.round(gb.used / gb.cap * 100))}%"></i></div>
            A self-imposed ceiling well under Google’s own daily quota, counted here so
            enrichment can never be the reason your key gets throttled somewhere else. It
            counts only what <em>this</em> browser asked for, so it is not a view of your real
            remaining quota.
          </div>` : ''}
        </div>
      </section>`;
  }

  /* ── Contact address ─────────────────────────────────────────────────── */
  function contactSection() {
    const email = String(BT.config.get('contactEmail') || '');
    return `
      <section class="section">
        ${BT.ui.groupHead('Identifying yourself to Open Library')}
        <div class="field">
          <label class="field__label" for="contact">Contact email <span class="faint">(optional)</span></label>
          <div class="field__help">
            Open Library asks API clients to identify themselves, and rewards it: their
            documentation puts identified clients at about three requests a second against one
            for anonymous ones. The identification travels in the <span class="num">User-Agent</span>
            header.
            <br><br>
            <b>The honest caveat: a browser cannot send it.</b> <span class="num">User-Agent</span>
            is a forbidden request header — <span class="num">fetch()</span> does not reject an
            attempt to set it, it silently drops it — so this setting is advisory. Carrying the
            address in a custom header instead is worse than useless: any non-safelisted header
            promotes the request into a preflight, and Open Library answers
            <span class="num">OPTIONS</span> with a non-standard singular
            <span class="num">access-control-allow-method</span> that the browser will not
            accept, so a request that worked a moment ago never leaves the machine. BookTrak
            therefore sends nothing extra at all and paces itself at one request a second.
            <br><br>
            It is kept because a non-browser host of this code would have somewhere to read it
            from, and so this screen can show you exactly what would be sent.
          </div>
          <input id="contact" type="text" spellcheck="false" autocomplete="off"
                 placeholder="you@example.com" value="${esc(email)}">
          <div class="field__state">Would send: <span class="num">${esc(BT.net.userAgent())}</span></div>
          <div class="field__help" style="margin-top:var(--bt-space-3)">
            Withheld from exports on purpose — an export is meant to be committable, and a real
            address sitting in a public JSON file next to a reading history is a leak nobody
            asked for.
          </div>
        </div>
      </section>`;
  }

  /* ── Region and language ─────────────────────────────────────────────── */
  function regionSection() {
    /* No "which genre buckets to show" control here, despite the M1 placeholder
       promising one. `BT.config.genres` exists but nothing reads it yet — the
       tree builds its genre rows from the library itself — and a switch that
       visibly does nothing is worse than no switch. It goes in with the code
       that honours it. */
    return `
      <section class="section">
        ${BT.ui.groupHead('Region & language')}
        <div class="field">
          <label class="field__label" for="region">Region</label>
          <div class="field__help">
            Two letters. Used when reasoning about a publication date’s local meaning; Open
            Library has no regional release calendar, so this decides far less here than the
            same setting does in a film tracker.
          </div>
          <input id="region" type="text" maxlength="2" style="max-width:100px;text-transform:uppercase"
                 value="${esc(String(BT.config.get('region') || 'US'))}">
        </div>
        <div class="field">
          <label class="field__label" for="language">Preferred language</label>
          <div class="field__help">
            Two letters, e.g. <span class="num">en</span>. Used to sort editions so the ones you
            can read come first. Stored short and widened to Open Library’s MARC code
            (<span class="num">eng</span>) at the point of use, so their vocabulary never leaks
            into your settings file.
          </div>
          <input id="language" type="text" maxlength="2" style="max-width:100px"
                 value="${esc(String(BT.config.get('language') || 'en'))}">
        </div>
      </section>`;
  }

  /* ── Diagnostics ─────────────────────────────────────────────────────── */
  function diagnosticsSection(items, cache, onGithubIo) {
    return `
      <section class="section">
        ${BT.ui.groupHead('Diagnostics')}
        <div class="deck">
          <dl>
            <dt>Storage engine</dt><dd>${BT.db.isFallback() ? 'localStorage (fallback)' : 'IndexedDB'}</dd>
            <dt>Database</dt><dd>booktrak</dd>
            <dt>Books</dt><dd>${items}</dd>
            <dt>Cached responses</dt><dd>${cache}</dd>
            <dt>Origin</dt><dd>${esc(location.protocol === 'file:' ? 'file:// (local copy)' : location.origin)}</dd>
          </dl>
        </div>
        <div class="field__help" style="margin-top:var(--bt-space-4)">
          <b>Why every key in this app starts <span class="num">bt.</span></b>
          BookTrak ships from <span class="num">ackley14.github.io/Lorelaibrary</span>, which is
          the <em>same browser origin</em> as its sibling MovieTrak at
          <span class="num">/entertainmentwatch</span> — localStorage and IndexedDB are scoped
          to the origin, not the path. So every key here is prefixed
          <span class="num">bt.</span> and the database is named
          <span class="num">booktrak</span>; a stray <span class="num">mt.</span> key would not
          fail loudly, it would quietly reach into the other app’s state.
          ${onGithubIo ? `<br><br>The same sharing cuts the other way: any page published on
          <span class="num">${esc(location.hostname)}</span> can read this library and anything
          saved here. A custom domain is the only real isolation.` : ''}
          ${location.protocol === 'file:' ? `<br><br>You are running the local copy. Browsers
          treat <span class="num">file://</span> as its own origin, so this library is separate
          from the one on the published site — move between them with Export and Import.` : ''}
        </div>
        <p class="actions" style="margin-top:var(--bt-space-4)">
          <button class="btn btn--sm" id="pingOl">Test Open Library</button>
        </p>
        <div class="field__state" id="pingState"></div>
      </section>`;
  }

  /* ── Data ────────────────────────────────────────────────────────────── */
  function dataSection(items) {
    return `
      <section class="section">
        ${BT.ui.groupHead('Your data')}
        <div class="field">
          <label class="field__label">Export</label>
          <div class="field__help">
            One JSON file holding your library, follows, activity and reading history. Subject
            lists, descriptions and candidate ISBNs are left out — they are heavy and can be
            fetched again from a work id — so an import re-fills them the first time each book
            is opened. Settings travel; keys and your contact address never do.
          </div>
          <p class="actions">
            <button class="btn" id="doExport"${items ? '' : ' disabled'}>Export ${items} ${items === 1 ? 'book' : 'books'}</button>
          </p>
        </div>

        <div class="field">
          <label class="field__label">Import</label>
          <div class="field__help">
            <b>Replaces</b> everything in this browser with the contents of the file. Not a
            merge — merging two libraries is a distributed-systems problem and there is no
            distributed system yet, so pretending otherwise would lose edits silently. Export
            first if this browser holds anything you want to keep.
          </div>
          <p class="actions">
            <button class="btn" id="doImport">Choose a file…</button>
          </p>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
          <div class="field__state" id="importState"></div>
        </div>

        <div class="field">
          <label class="field__label">Cached responses</label>
          <div class="field__help">
            Catalogue payloads BookTrak keeps so it does not ask Open Library the same question
            twice. Clearing them loses nothing of yours — it only means the next few screens
            re-fetch, one request a second.
          </div>
          <p class="actions">
            <button class="btn" id="clearCache">Clear cached responses</button>
          </p>
        </div>

        <div class="warnbox">
          <strong>Erase everything</strong>
          Removes the library, follows, activity, reading history and cache from this browser.
          There is no server copy and no undo. Export first.
          <p class="actions" style="margin-top:var(--bt-space-3)">
            <button class="btn btn--danger" id="doWipe">Erase everything</button>
          </p>
        </div>
      </section>`;
  }

  /* ══ WIRING ═══════════════════════════════════════════════════════════════ */

  function wire() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };

    wireRecalc();

    /* ── Google Books key ─────────────────────────────────────────────── */
    on('key-gb-save', 'onclick', async () => {
      const input = document.getElementById('key-gb');
      const state = document.getElementById('key-gb-state');
      const val = (input.value || '').trim();
      BT.config.setKey('googlebooks', val);
      if (!val) {
        state.textContent = '○ Cleared — Google enrichment is off';
        state.className = 'field__state';
        return;
      }
      state.textContent = '… testing';
      state.className = 'field__state';
      const res = await verifyGoogleKey();
      state.textContent = (res.ok ? '● ' : '✕ ') + res.reason;
      state.className = 'field__state ' + (res.ok ? 'field__state--ok' : 'field__state--bad');
      if (res.ok) BT.ui.toast('Google Books key saved and working');
    });

    on('key-gb-clear', 'onclick', () => {
      BT.config.setKey('googlebooks', '');
      BT.ui.toast('Key cleared — Google enrichment is off');
      BT.router.resolve();
    });

    /* ── Contact, region, language ────────────────────────────────────── */
    on('contact', 'onchange', e => {
      BT.config.set('contactEmail', (e.target.value || '').trim());
      BT.ui.toast('Saved — advisory only, see the note above');
      BT.router.resolve();
    });
    on('region', 'onchange', e => {
      BT.config.set('region', (e.target.value || '').toUpperCase().slice(0, 2) || 'US');
      BT.ui.toast('Region saved');
    });
    on('language', 'onchange', e => {
      BT.config.set('language', (e.target.value || '').toLowerCase().slice(0, 2) || 'en');
      BT.ui.toast('Language saved — reopen a book to re-sort its editions');
    });

    /* ── Diagnostics ──────────────────────────────────────────────────── */
    on('pingOl', 'onclick', async () => {
      const btn = document.getElementById('pingOl');
      const state = document.getElementById('pingState');
      btn.disabled = true;
      state.textContent = '… asking for one record';
      state.className = 'field__state';
      const res = (BT.openlibrary && BT.openlibrary.verifyReachable)
        ? await BT.openlibrary.verifyReachable()
        : { ok: false, reason: 'The Open Library adapter is not loaded on this page.' };
      btn.disabled = false;
      state.textContent = (res.ok ? '● ' : '✕ ') + (res.detail || res.reason || '');
      state.className = 'field__state ' + (res.ok ? 'field__state--ok' : 'field__state--bad');
    });

    /* ── Data ─────────────────────────────────────────────────────────── */
    on('doExport', 'onclick', exportToFile);

    on('doImport', 'onclick', () => {
      const f = document.getElementById('importFile');
      if (f) f.click();
    });
    on('importFile', 'onchange', async e => {
      const file = e.target.files && e.target.files[0];
      /* Reset the input straight away, or picking the SAME file twice fires no
         change event the second time and the button looks dead. */
      e.target.value = '';
      if (!file) return;
      await importFromFile(file);
    });

    on('clearCache', 'onclick', async () => {
      await BT.repo.cacheClear();
      BT.ui.toast('Cached responses cleared');
      BT.router.resolve();
    });

    on('doWipe', 'onclick', async () => {
      /* Two confirmations, worded differently. A doubled identical prompt is
         answered twice by reflex; the second one names the consequence and the
         way out instead of repeating the question. */
      if (!BT.ui.confirmDialog(
        'Erase your library, follows, activity and reading history from this browser?')) return;
      if (!BT.ui.confirmDialog(
        'There is no server copy and no undo. Export first if there is any chance you want this back. Erase everything?')) return;
      await BT.repo.wipe();
      /* The undo ledger describes records that no longer exist. */
      lastRun = null; ask = null;
      BT.ui.toast('Everything erased');
      BT.tree.refresh();
      BT.router.go('#/');
    });
  }

  async function exportToFile() {
    const btn = document.getElementById('doExport');
    /* The label is restored from what it actually said, not rebuilt from a
       count — a re-render here would throw away the recalculation result and
       its Undo, which is the one thing on this screen that must not vanish
       because somebody pressed Export. */
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      const doc = await BT.repo.exportAll();
      const text = JSON.stringify(doc, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `booktrak-${BT.util.todayStamp()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      /* Revoked late rather than in the same turn: some browsers resolve the
         download from the object URL asynchronously, and revoking immediately
         produces a silently empty file. */
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      BT.ui.toast(`Exported ${BT.util.pluralize((doc.counts && doc.counts.items) || 0, 'book')} · ${BT.util.bytesStr(blob.size)}`);
    } catch (e) {
      console.error('[settings] export failed', e);
      BT.ui.toast('Export failed: ' + ((e && e.message) || String(e)), { bad: true, ms: 8000 });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function importFromFile(file) {
    const state = document.getElementById('importState');
    const say = (t, cls) => { if (state) { state.textContent = t; state.className = 'field__state ' + (cls || ''); } };

    say('… reading');
    let doc;
    try {
      doc = JSON.parse(await file.text());
    } catch (e) {
      say('✕ That file is not valid JSON.', 'field__state--bad');
      return;
    }
    if (!doc || doc.app !== 'booktrak') {
      /* Named specifically, because the sibling app's export is the file most
         likely to be picked here by mistake and "not a BookTrak export" alone
         does not explain why. */
      say(doc && doc.app === 'movietrak'
        ? '✕ That is a MovieTrak export. The two apps share an origin but not a library.'
        : '✕ That is not a BookTrak export file.', 'field__state--bad');
      return;
    }

    const c = doc.counts || {};
    if (!BT.ui.confirmDialog(
      `Replace everything in this browser with this file?\n\n`
      + `${c.items || 0} books · ${c.follows || 0} follows · ${c.history || 0} history entries\n`
      + `Exported ${doc.exportedAt || 'at an unknown time'}\n\n`
      + `This is a replace, not a merge. Anything here that is not in the file is gone.`)) {
      say('Cancelled — nothing changed.');
      return;
    }

    say('… importing');
    try {
      const counts = await BT.repo.importAll(doc);
      /* The ledger describes the library that was just replaced. */
      lastRun = null; ask = null;
      BT.ui.toast(`Imported ${BT.util.pluralize(counts.items || 0, 'book')}`);
      BT.tree.refresh();
      BT.router.resolve();
    } catch (e) {
      console.error('[settings] import failed', e);
      say('✕ ' + ((e && e.message) || String(e)), 'field__state--bad');
    }
  }

  /* ══ M5 SEAM — encrypted GitHub sync ══════════════════════════════════════
     Deliberately absent, not forgotten. When 15-crypto.js and 16-cloud.js land,
     a "Sync across machines" section belongs between the key section and the
     region section, and it needs: repository (owner/name), a fine-grained
     GitHub token scoped to that one repository with Contents: read and write,
     status and last-published lines, a change-passphrase form, and a sign-out.

     The two things worth writing down now, because both are easy to get wrong
     the first time:

       · The passphrase is never stored anywhere, not even as a hash. There is
         nothing in the repository that could be cracked, and no reset. The
         GitHub token lives INSIDE the encrypted file so it is entered once
         rather than once per device.
       · That token can write to the repository that serves this page, so
         anyone holding it could commit code into the site. Scope it to the one
         repository, give it an expiry, and remove it from machines you do not
         control.

     Nothing here is stubbed out in the meantime. A sync panel that renders but
     does not publish is indistinguishable from one that is quietly failing,
     and the footer already says "Saved …" only when signed in. */

  return { render };
})();
