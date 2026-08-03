/* ══════════════════════════════════════════════════════════════════════════
   #/stats — the library in numbers, and the reading log drawn as a shape.

   The rule this screen is written to: EVERY FIGURE NAMES ITS SOURCE, AND A
   FIGURE THAT CANNOT BE SUPPORTED IS NOT PRINTED AS A ZERO. A stats page is
   the one screen where an app is most tempted to fill a hole with a plausible
   number, and a plausible wrong number here is indistinguishable from a real
   one — nobody cross-checks their own reading total. Worse, a zero is not a
   neutral placeholder: "0 pages this week" is a claim about the reader, and
   "0 books in Horror" reads as a fact about their shelf rather than as a fact
   about what has been recorded. So where the record runs out, this screen
   says what is missing and how it would be filled in.

   That is also why the right-hand column is a plain-English account of how
   each number was arrived at, rather than a decorative sidebar. It is the
   part of the screen most likely to stop somebody trusting a wrong figure.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewStats = (function () {
  const esc = BT.util.escapeHtml;
  const MA = BT.util.MONTHS_ABBR;
  const DAY = 86400000;

  /* Weekly buckets unless the whole log is short enough that weeks would
     collapse it to two or three columns — see `timeline`. */
  const SHORT_WINDOW_DAYS = 20;
  const MAX_WEEK_COLS = 26;                       // half a year
  const MAX_DAY_COLS = 21;                        // three weeks
  const MAX_TICKS = 5;                            // axis labels before crowding

  /* ══ HISTORY ════════════════════════════════════════════════════════════
     THE ROW SHAPE, read off js/12-repo.js rather than assumed:

       { id, uid, event, value, at }

     `id` autoIncrements (js/10-db.js), `by_uid` and `by_at` index the other
     two, and `addHistory(uid, event, value)` stamps `at` with Date.now(). It
     is an append-only log — nothing rewrites a row — so the ordering within a
     uid is the reader's actual sequence and can be differenced.

     THREE EVENT NAMES ARE READ HERE. 'finished' and 'rated' are written today
     (50-ui-core's setStatus and 56-inspector's rating control). 'progress' is
     what the pace chart is built on, and `pageOf` below deliberately accepts
     more than one shape for its `value` — see the note there. */

  /* The page number a progress row is reporting, or null if the row cannot be
     read as one.

     Permissive on purpose, and this is not defensive-programming reflex. The
     `value` column of `history` is untyped — `addHistory` stores whatever it
     is handed — so a progress writer could reasonably pass the bare page
     number, or the whole `{ currentPage, totalPages }` record that
     `user.progress` holds. Both are sensible; reading only one of them would
     produce a chart that is silently and permanently empty against a log that
     is visibly filling up, which is the single worst failure available to
     this screen. A row that is neither is skipped rather than coerced: a
     percent string coerced to a number would be charted as a page count and
     read as somebody having a very slow month. */
  function pageOf(row) {
    const v = row && row.value;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v && typeof v === 'object') {
      const n = v.currentPage != null ? v.currentPage : v.page;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /* ══ PACE ═══════════════════════════════════════════════════════════════
     Pages read per bucket, differenced from consecutive progress rows for the
     SAME book. A progress row states a position, not an amount, so the amount
     is what changed between two of them.

     THREE DECISIONS, each of which is the difference between a truthful chart
     and a flattering one:

     1. A DECREASE CONTRIBUTES ZERO, AND STILL MOVES THE BASELINE.
        Going from p.300 to p.150 is a re-read or a typo corrected, never
        negative reading, so the bucket gets 0. But the NEXT reading is
        differenced against 150, not against the 300 high-water mark — carry
        the maximum forward and an entire second read of the book is swallowed
        silently, which is the exact case (re-reading a favourite) somebody
        would open this screen to look at.

     2. THE FIRST READING OF A BOOK CONTRIBUTES NOTHING. It establishes where
        the reader is, not how far they got: somebody who logs for the first
        time at p.300 may have read those 300 pages this afternoon or over the
        past year, and the log does not say which. Charting them into the
        bucket the entry lands in would invent a reading day out of a
        bookkeeping day. The count of these baselines is surfaced under the
        chart, because "I logged three books and the chart is empty" needs an
        explanation on screen and not in a comment.

     3. A BOOK FINISHED WITHOUT PAGE LOGGING CONTRIBUTES NOTHING, and the
        chart says so rather than letting its absence read as a quiet week.
        This is the common case for a reader who marks books finished but
        never records a position, and it is why the finish markers are drawn
        along the same axis: those weeks were not empty, they were unmeasured,
        and the two look identical unless something distinguishes them. */
  function buildPace(history) {
    const rows = [];
    for (const r of history) {
      if (!r || r.event !== 'progress' || !r.at) continue;
      if (pageOf(r) == null) continue;
      rows.push(r);
    }

    const byUid = new Map();
    for (const r of rows) {
      if (!byUid.has(r.uid)) byUid.set(r.uid, []);
      byUid.get(r.uid).push(r);
    }

    const deltas = [];
    let baselines = 0;
    let corrections = 0;
    for (const list of byUid.values()) {
      list.sort((a, b) => a.at - b.at);
      let prev = null;
      for (const r of list) {
        const page = pageOf(r);
        if (prev === null) { prev = page; baselines++; continue; }
        if (page < prev) corrections++;
        deltas.push({ at: r.at, pages: Math.max(0, page - prev) });
        prev = page;                                  // decision 1
      }
    }
    return { deltas, baselines, corrections, rows: rows.length, books: byUid.size };
  }

  /* ── Bucket boundaries ─────────────────────────────────────────────────
     Both of these snap with Date methods rather than by rounding the epoch
     number, and that is not fussiness: `ms - (ms % DAY)` is only a midnight in
     UTC, so for most of the world it cuts the day in the middle of an evening
     and files a late reading session under tomorrow. The clocks-change weeks
     are 23 and 25 hours long and would drift the boundary by an hour every
     time on top of that. setHours/setDate ask the calendar instead. */
  function dayStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  /* Weeks start Monday. Sunday-start weeks split a weekend — the two days a
     reader is most likely to get through a book in — across two columns. */
  function weekStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  /* The x-axis: contiguous, zero-filled buckets from the first recorded event
     to today.

     ZERO-FILLING IS THE POINT. Plotting only the buckets that have data draws
     a fortnight's gap as though it were the next week along, so a month off
     reading looks like steady progress. An empty column is a true statement
     and a missing one is not. */
  function timeline(deltas, finishAts) {
    const stamps = [];
    for (const d of deltas) stamps.push(d.at);
    for (const at of finishAts) stamps.push(at);
    if (!stamps.length) return null;

    /* reduce, not Math.min(...stamps) — the spread passes one argument per
       row, and a long reading log is exactly the input that turns that into a
       RangeError on the one screen built to reward long reading logs. */
    const first = stamps.reduce((a, b) => (b < a ? b : a), stamps[0]);
    const daily = (Date.now() - first) <= SHORT_WINDOW_DAYS * DAY;
    const startOf = daily ? dayStart : weekStart;
    const step = daily ? 1 : 7;

    const end = startOf(Date.now());
    let keys = [];
    const cur = new Date(startOf(first));
    /* The 1000 is a guard rather than a window: one corrupt `at` far in the
       past would otherwise spin here building buckets back to 1970 and hang
       the view before it ever rendered. The real window is the slice below. */
    while (cur.getTime() <= end && keys.length < 1000) {
      keys.push(cur.getTime());
      cur.setDate(cur.getDate() + step);
    }
    /* A row dated in the future (a device with a wrong clock, a restored
       export) leaves the loop empty. Today alone is still a true axis. */
    if (!keys.length) keys = [end];

    const max = daily ? MAX_DAY_COLS : MAX_WEEK_COLS;
    const shown = keys.length > max ? keys.slice(-max) : keys;
    const cutoff = shown[0];

    const pages = new Map(shown.map(k => [k, 0]));
    const fins = new Map(shown.map(k => [k, 0]));
    let hiddenPages = 0;
    for (const d of deltas) {
      const k = startOf(d.at);
      if (k < cutoff) { hiddenPages += d.pages; continue; }
      if (pages.has(k)) pages.set(k, pages.get(k) + d.pages);
    }
    let hiddenFins = 0;
    for (const at of finishAts) {
      const k = startOf(at);
      if (k < cutoff) { hiddenFins++; continue; }
      if (fins.has(k)) fins.set(k, fins.get(k) + 1);
    }

    const vals = shown.map(k => pages.get(k));
    return {
      daily, keys: shown, pages, fins,
      peak: vals.reduce((a, b) => (b > a ? b : a), 0),
      total: vals.reduce((a, b) => a + b, 0),
      hiddenPages, hiddenFins,
      truncated: keys.length > shown.length,
    };
  }

  const stampOf = ms => {
    const d = new Date(ms);
    return `${MA[d.getMonth()]} ${d.getDate()}`;
  };

  /* ══ RENDER ═════════════════════════════════════════════════════════════ */

  async function render(params, query, alive) {
    const view = document.getElementById('view');
    const [items, history] = await Promise.all([BT.repo.allItems(), BT.repo.allHistory()]);
    if (alive && !alive()) return;

    BT.ui.crumb(['Shelf', 'Stats']);
    BT.ui.paneActions('');

    if (!items.length) {
      view.innerHTML = BT.ui.emptyState({
        title: 'Nothing to count yet',
        body: 'This screen counts what is on your shelves and charts how fast you get '
          + 'through it. Both need a library first.',
        actions: '<a class="btn btn--primary" href="#/search">Find a book</a> '
          + '<a class="btn" href="#/scan">Scan a barcode</a>',
      });
      return;
    }

    const finishes = finishTimes(items, history);
    const pace = buildPace(history);
    const tl = timeline(pace.deltas, [...finishes.values()]);

    view.innerHTML = `
      <div class="two">
        <div class="col">
          <div class="hd">Reading pace</div>
          ${paceBlock(items, pace, tl)}

          <div class="hd hd--gap">The shelf</div>
          ${tilesBlock(items, finishes)}
          ${compositionBlock(items)}

          <div class="hd hd--gap">By genre</div>
          ${genreBlock(items)}

          <div class="hd hd--gap">Most-shelved authors</div>
          ${authorBlock(items)}

          <div class="hd hd--gap">By decade of publication</div>
          ${decadeBlock(items)}

          <div class="hd hd--gap">By format</div>
          ${formatBlock(items)}
        </div>

        <div class="col">
          <div class="hd">Date certainty</div>
          ${certaintyBlock(items)}

          <div class="hd hd--gap">How these numbers are counted</div>
          ${countingBlock(items, finishes)}
        </div>
      </div>`;
  }

  /* ── When each book was finished ───────────────────────────────────────
     The item's own `finishedAt` first, the log second. They normally agree —
     50-ui-core's setStatus writes both in the same breath — but only one of
     them survives every route in: a record restored from an export made
     before `finishedAt` existed, or one whose status was set by a path that
     did not stamp it, still has its 'finished' row in the log. Reading only
     the field would quietly drop those books out of "finished this year" while
     they sit on the Finished shelf in plain view.

     Keyed by the CURRENT status, so a book finished and then re-filed as
     reading stops counting as finished. The log still holds the row, and that
     is correct — it records what happened — but this screen is describing the
     shelf as it stands. */
  function finishTimes(items, history) {
    const logged = new Map();
    for (const r of history) {
      if (!r || r.event !== 'finished' || !r.at) continue;
      const prev = logged.get(r.uid);
      if (prev == null || r.at > prev) logged.set(r.uid, r.at);
    }
    const out = new Map();
    for (const it of items) {
      if (BT.ui.statusOf(it) !== 'finished') continue;
      const at = (it.user && it.user.finishedAt) || logged.get(it.uid) || null;
      if (at) out.set(it.uid, at);
    }
    return out;
  }

  /* ── The chart ─────────────────────────────────────────────────────────
     Hand-rolled: flex columns whose heights are a percentage of the peak.
     Deliberately not SVG — the columns have to reflow from a 372px inspector
     pane to a 320px phone, and a percentage height in a flex row does that
     for free where a viewBox needs a resize observer to stay legible. */
  function paceBlock(items, pace, tl) {
    /* Gated on there being a MEASUREMENT, not on the measurement being
       non-zero. A window in which nothing was read is a real answer and the
       chart is the right place to give it — an empty axis with the "older
       entries are off the left edge" note underneath says "you read, but not
       recently", where falling back to the empty state would say "you have
       never recorded anything", which is false and dispiriting. */
    if (!tl || !pace.deltas.length) return paceEmpty(items, pace, tl);

    const unit = tl.daily ? 'day' : 'week';

    const cols = tl.keys.map(k => {
      const n = tl.pages.get(k);
      const f = tl.fins.get(k);
      const h = tl.peak ? Math.max(2, Math.round((n / tl.peak) * 100)) : 0;
      const title = `${tl.daily ? '' : 'Week of '}${stampOf(k)} · `
        + `${n ? BT.util.pluralize(n, 'page') : 'nothing recorded'}`
        + (f ? ` · ${BT.util.pluralize(f, 'book')} finished` : '');
      return `<div class="pace-col${n ? '' : ' is-zero'}" title="${esc(title)}">${
        n ? `<i style="height:${h}%"></i>` : ''}</div>`;
    }).join('');

    /* One marker row under the axis rather than a second series inside it: a
       finish is an event, not a quantity, and giving it a height would put it
       on a y-axis measured in pages where it does not belong. */
    const anyFin = anyFinishMarkers(tl);
    const fins = anyFin ? `<div class="pace-fin">${tl.keys.map(k => {
      const f = tl.fins.get(k);
      if (!f) return '<span></span>';
      return `<span title="${esc(`${BT.util.pluralize(f, 'book')} finished`)}">${
        f > 1 ? esc(String(f)) : '<b></b>'}</span>`;
    }).join('')}</div>` : '';

    return `
      <div class="pace">
        <div class="pace-head">
          <span class="pk">${tl.peak
            ? `peak ${esc(String(tl.peak))} ${esc(tl.peak === 1 ? 'page' : 'pages')} / ${esc(unit)}`
            : `no pages recorded in this ${esc(unit === 'day' ? 'window' : 'half-year')}`}</span>
          ${anyFin ? '<span class="lg"><i></i>book finished</span>' : ''}
        </div>
        <div class="pace-plot">${cols}</div>
        ${fins}
        ${axisRow(tl.keys)}
      </div>
      <p class="statnote">
        <b>${esc(BT.util.pluralize(tl.total, 'page'))}</b> across the last
        ${esc(BT.util.pluralize(tl.keys.length, unit))}, differenced from
        ${esc(BT.util.pluralize(pace.rows, 'recorded position'))} in
        ${esc(BT.util.pluralize(pace.books, 'book'))}.
      </p>
      ${paceCaveats(items, pace, tl)}`;
  }

  /* The footnotes exist so that nothing on the chart above needs to be taken
     on trust. Each one is emitted only when it actually applies — a permanent
     wall of caveats is read once and then never again, which is the same as
     not printing it. */
  function paceCaveats(items, pace, tl) {
    const out = [];
    if (pace.baselines) {
      out.push(`The first recorded position in a book sets a starting point and adds nothing to the
        chart — it says where you were, not how far you got. That applies to
        ${esc(BT.util.pluralize(pace.baselines, 'book'))} here.`);
    }
    if (pace.corrections) {
      out.push(`${esc(BT.util.pluralize(pace.corrections, 'entry', 'entries'))} moved backwards
        through a book — a re-read, or a number corrected. Those count as zero pages rather than
        negative ones, and the next entry is measured from the new position.`);
    }
    const unlogged = items.filter(it =>
      BT.ui.statusOf(it) === 'finished' && !hasPosition(it)).length;
    if (unlogged) {
      out.push(`${esc(BT.util.pluralize(unlogged, 'finished book'))} never had a page recorded, so
        ${unlogged === 1 ? 'it contributes' : 'they contribute'} nothing to the bars.
        ${anyFinishMarkers(tl) ? 'The markers under the axis are where those weeks are.'
          : 'The weeks you read them are not empty here, only unmeasured.'}`);
    }
    /* Only the halves that are actually non-zero. "165 pages and 0 finished
       books before this window" invites the reader to wonder what the zero
       means, on a line whose whole job is to account for what is missing. */
    if (tl && tl.truncated && (tl.hiddenPages || tl.hiddenFins)) {
      const bits = [];
      if (tl.hiddenPages) bits.push(esc(BT.util.pluralize(tl.hiddenPages, 'page')));
      if (tl.hiddenFins) bits.push(esc(BT.util.pluralize(tl.hiddenFins, 'finished book')));
      out.push(`Older entries are off the left edge: ${bits.join(' and ')} before this window.`);
    }
    return out.map(t => `<p class="statfoot">${t}</p>`).join('');
  }

  const finCount = tl => (tl ? tl.keys.reduce((a, k) => a + tl.fins.get(k), 0) : 0);
  const anyFinishMarkers = tl => finCount(tl) > 0;
  function hasPosition(it) {
    const p = BT.ui.progressOf(it);
    return !!(p && p.currentPage > 0);
  }

  /* ── Nothing to plot ───────────────────────────────────────────────────
     Three different reasons the chart is empty, and they need three different
     sentences. Collapsing them into one "log some progress" message is how an
     empty state stops being information: two of these three cases are already
     doing that and it has not helped. */
  function paceEmpty(items, pace, tl) {
    const positions = items.filter(hasPosition).length;
    let title;
    let body;

    if (pace.rows && !pace.deltas.length) {
      title = 'One reading each, so far';
      body = `The log holds a single position for ${BT.util.pluralize(pace.books, 'book')}. `
        + 'Pace is the distance between one recorded position and the next, so the first '
        + 'entry in a book sets the starting point and the chart begins at the second.';
    } else if (positions) {
      title = 'No dated trail to measure';
      body = `BookTrak knows where you are in ${BT.util.pluralize(positions, 'book')}, but a `
        + 'position on its own is a place, not a pace — this chart needs the same book '
        + 'dated at two different pages to know how long the distance between them took. '
        + 'The reading log currently records books being finished and books being rated.';
    } else {
      title = 'No pages recorded yet';
      body = 'Open a book from your library and set the page you are on. Record it again a '
        + 'few days later and the difference between the two — pages per week — is what '
        + 'this chart draws.';
    }

    /* The finish log is worth drawing on its own. A reader who never records a
       page still finishes books, and "when did I finish things" is a real
       answer to give somebody whose pace chart cannot be built.

       Two finishes minimum, because a chart of one event is not a chart — it is
       a single column and twenty-five empty ones, which says less than the
       sentence above it already did. */
    const marks = finCount(tl) >= 2 ? finishOnly(tl) : '';
    return BT.ui.emptyState({ title, body, actions: '<a class="btn" href="#/library?status=reading">Books you are reading</a>' })
      + marks;
  }

  /* One label per column so the labels stay aligned to their own bars, but only
     the tick columns carry text — 26 dates side by side is a smear at any size.
     The last column always gets one, and a tick is suppressed when it would
     land within half a step of it, because "Jul 27  Aug 3" overlapping is worse
     than one fewer date. */
  function axisRow(keys) {
    const last = keys.length - 1;
    const step = Math.max(1, Math.ceil(keys.length / MAX_TICKS));
    return `<div class="pace-axis">${keys.map((k, i) => {
      const tick = i === last || (i % step === 0 && i <= last - Math.floor(step / 2));
      return `<span>${tick ? esc(stampOf(k)) : ''}</span>`;
    }).join('')}</div>`;
  }

  function finishOnly(tl) {
    const unit = tl.daily ? 'day' : 'week';
    const peak = tl.keys.reduce((a, k) => Math.max(a, tl.fins.get(k)), 0);
    const cols = tl.keys.map(k => {
      const f = tl.fins.get(k);
      const h = peak ? Math.max(2, Math.round((f / peak) * 100)) : 0;
      return `<div class="pace-col fin${f ? '' : ' is-zero'}" title="${
        esc(`${tl.daily ? '' : 'Week of '}${stampOf(k)} · ${f ? BT.util.pluralize(f, 'book') + ' finished' : 'none finished'}`)
      }">${f ? `<i style="height:${h}%"></i>` : ''}</div>`;
    }).join('');
    /* Shorter than the pace plot, because the y-axis here counts books rather
       than pages and typically tops out at one or two. At the full height a
       single finished book draws a 132px slab, which shouts far louder than
       the fact deserves. */
    return `<div class="hd hd--gap">Books finished, per ${esc(unit)}</div>
      <div class="pace"><div class="pace-plot pace-plot--short">${cols}</div>${axisRow(tl.keys)}</div>
      <p class="statfoot">Counted from the reading log, which records the day a book was moved
        to Finished. It says nothing about how long the book took.</p>`;
  }

  /* ── Tiles ─────────────────────────────────────────────────────────────
     Read through BT.ui.statusOf rather than off `user.status`, so a record
     written before the `have` rung existed, or restored from another device
     mid-schema-change, lands on the same shelf here that it draws on in the
     list. A stats page and a list disagreeing about how many books you own is
     the kind of bug that gets the whole screen distrusted. */
  function tilesBlock(items, finishes) {
    const byStatus = tally(items, BT.ui.statusOf);
    const rated = items.filter(it => it.user && it.user.rating != null);
    const avg = rated.length
      ? rated.reduce((s, it) => s + it.user.rating, 0) / rated.length : null;
    const year = new Date().getFullYear();
    let thisYear = 0;
    for (const at of finishes.values()) if (new Date(at).getFullYear() === year) thisYear++;
    const sell = items.filter(it => it.user && it.user.pile === 'sell').length;
    const read = pagesRead(items);

    return `<div class="tiles">
      ${tile(byStatus.want || 0, 'Want')}
      ${tile(byStatus.have || 0, 'Have')}
      ${tile(byStatus.reading || 0, 'Reading')}
      ${tile(byStatus.finished || 0, 'Finished')}
      ${tile(byStatus.dropped || 0, 'Dropped')}
      ${tile(thisYear, `Finished in ${year}`)}
      ${tile(read.total.toLocaleString(), 'Pages read')}
      ${tile(avg != null ? avg.toFixed(1) : '—', 'Your average')}
      ${tile(sell, 'To sell')}
    </div>`;
  }

  /* Pages read, counted from positions rather than from the pace chart —
     they answer different questions and would disagree by design. The chart
     can only measure the distance BETWEEN two recorded positions; this counts
     the whole distance covered, which is what somebody means by "how much have
     I read".

     A finished book counts its full extent, which needs an extent to count:
     BT.ui.totalPagesOf prefers the number the reader typed off their own copy
     over the catalogue's guess, and where there is neither the book counts
     nothing at all rather than a made-up 300. `unknownFinished` carries that
     out to the sidebar so the total is never quietly short. */
  function pagesRead(items) {
    let total = 0;
    let unknownFinished = 0;
    for (const it of items) {
      const p = BT.ui.progressOf(it);
      const pos = (p && p.currentPage > 0) ? p.currentPage : 0;
      if (BT.ui.statusOf(it) === 'finished') {
        const extent = BT.ui.totalPagesOf(it);
        if (extent) total += Math.max(extent, pos);
        else if (pos) total += pos;
        else unknownFinished++;
      } else {
        /* Dropped books included, and not as an oversight: eighty pages of a
           book somebody gave up on are eighty pages they read. */
        total += pos;
      }
    }
    return { total, unknownFinished };
  }

  /* The ladder as one bar. `finished` and `dropped` take the two neutral text
     tokens rather than a hue, exactly as their tree dots do (.c-finished and
     .c-dropped in 03-components.css) — the palette has six hue families and
     they are spent on genre, so a seventh invented for "dropped" would exist
     in this app and not in MovieTrak, which is the one thing the shared
     palette is for. Muted against faint is a visible difference in both
     themes, and every segment carries its label in the tooltip regardless. */
  const STATUS_INK = {
    want: 'var(--bt-ice)', have: 'var(--bt-moss)', reading: 'var(--bt-teal)',
    finished: 'var(--bt-text-muted)', dropped: 'var(--bt-text-faint)',
  };
  function compositionBlock(items) {
    const byStatus = tally(items, BT.ui.statusOf);
    const segs = BT.ui.STATUSES.filter(s => byStatus[s])
      .map(s => `<i style="flex:${byStatus[s]};background:${STATUS_INK[s]}"
        title="${esc(`${BT.ui.statusWord(s)}: ${byStatus[s]}`)}"></i>`).join('');
    return segs ? `<div class="stack">${segs}</div>` : '';
  }

  /* ── Genre ─────────────────────────────────────────────────────────────
     BT.GENRE_BUCKETS is an ACCESSOR — the built-in twelve plus every genre the
     user has added in Settings, re-read on each render. Iterating it rather
     than the counts is what makes a custom genre appear here with no change to
     this file, and reading it live rather than caching it means a shelf the
     user deleted while this screen was open simply stops being a legal row.

     Counted by the bucket a book is FILED under — genresOf's first id, the
     same reading 62-view-list groups by and 55-tree counts by. A book matching
     three buckets counted three times would give a genre column that sums to
     more than the library, and the reader has no way to tell that from a
     miscount. The tree is the app's other place where genre numbers appear and
     these two must agree. */
  function genreBlock(items) {
    const counts = {};
    for (const it of items) {
      const g = BT.ui.genresOf(it)[0] || 'general';
      counts[g] = (counts[g] || 0) + 1;
    }
    const buckets = BT.GENRE_BUCKETS;
    const present = buckets.filter(g => counts[g]);
    const empty = buckets.filter(g => !counts[g]);

    /* Ids stored under a genre the user has since deleted are not in the
       accessor any more, and BT.ui.genresOf drops them, so those books have
       already fallen through to 'general' by the time they reach this count.
       Nothing is lost from the total, which is what matters for a sum.

       'general' takes neutral ink rather than the fallback hue. It is the
       residue bucket, not a genre — there is deliberately no --bt-genre-general
       token (see the note in 01-tokens.css) and colouring it would dress an
       absence of classification up as a classification. */
    const rows = present.map(g => bar(BT.genreLabel(g), counts[g], items.length,
      g === 'general' ? 'var(--bt-text-faint)' : `var(--bt-genre-${g}, var(--bt-teal))`)).join('');

    return `<div class="bars">${rows}</div>`
      + (empty.length
        ? `<p class="statfoot">Nothing shelved under ${
            esc(empty.map(g => BT.genreLabel(g)).join(', '))}.</p>`
        : '');
  }

  /* ── Authors ───────────────────────────────────────────────────────────
     An author record can carry an olid and no name at all — an Open Library
     WORK gives author keys and never author names (see authorsFromKeys in
     38-normalize), so a nameless author is an ordinary state and not a fault.
     Ranking those together under one blank label would merge every unnamed
     author in the library into a single fictitious person sitting at the top
     of this list. They are counted under their olid instead, which keeps them
     distinct and is still enough to recognise. */
  function authorBlock(items) {
    const counts = new Map();
    for (const it of items) {
      const seen = new Set();
      for (const raw of (it.authors || [])) {
        const a = typeof raw === 'string' ? { name: raw } : raw;
        if (!a) continue;
        const label = a.name || (a.olid ? `Author ${a.olid}` : '');
        if (!label || seen.has(label)) continue;      // an omnibus can list one author twice
        seen.add(label);
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    }
    if (!counts.size) {
      return '<p class="statfoot">No author is recorded on any book yet.</p>';
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked.slice(0, 10);
    /* THE ONE CHART ON THIS SCREEN NOT DRAWN AS A SHARE OF THE LIBRARY, and it
       has to say so. Everything else here partitions the shelf, so a full bar
       means "all of it"; this is a ranking, and against a 500-book library the
       most-read author would be a two-pixel sliver that answers nothing. It is
       scaled to the leader instead — which is a different meaning for an
       identical-looking bar, so the difference is stated rather than left to be
       inferred from the numbers on the right. */
    return `<div class="bars">${top.map(([l, n]) => bar(l, n, top[0][1])).join('')}</div>`
      + `<p class="statfoot">Bars here are drawn against the most-shelved author rather than
           against the whole library, unlike the rest of this column.${ranked.length > top.length
             ? ` ${esc(BT.util.pluralize(ranked.length - top.length, 'other author'))} have fewer books.`
             : ''}</p>`;
  }

  /* ── Decade ────────────────────────────────────────────────────────────
     `idx.decade` is written on every save by 12-repo's normalizeIndexable, so
     it is read first and the sort key is only re-derived for a record that
     predates it. Ascending, because a decade axis running by popularity is not
     a decade axis. */
  function decadeBlock(items) {
    const counts = {};
    let undated = 0;
    for (const it of items) {
      let dec = it.idx && it.idx.decade;
      if (dec == null) {
        const sk = it.release && it.release.sortKey;
        const p = (sk != null && sk < BT.util.SK_UNKNOWN) ? BT.util.sortKeyToParts(sk) : null;
        dec = p ? Math.floor(p.y / 10) * 10 : null;
      }
      if (dec == null) { undated++; continue; }
      counts[dec] = (counts[dec] || 0) + 1;
    }
    const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);
    if (!keys.length) {
      return '<p class="statfoot">No book on the shelf has a publication date recorded.</p>';
    }
    return `<div class="bars">${keys.map(k => bar(`${k}s`, counts[k], items.length)).join('')}</div>`
      + (undated
        ? `<p class="statfoot">${esc(BT.util.pluralize(undated, 'book'))} with no publication date
             ${undated === 1 ? 'is' : 'are'} not on this axis — see Date certainty.</p>`
        : '');
  }

  function formatBlock(items) {
    const counts = tally(items, BT.ui.formatOf);
    const order = ['physical', 'ebook', 'audiobook', 'unspecified'].filter(f => counts[f]);
    return `<div class="bars">${order.map(f =>
      bar(BT.ui.FORMAT_LABEL[f] || f, counts[f], items.length)).join('')}</div>`;
  }

  /* ── Date certainty ────────────────────────────────────────────────────
     The most useful chart on this screen for anybody wondering why their
     shelf is full of hatched date fields. Open Library's `publish_date` is
     free text typed by cataloguers over fifty years — '1991', 'c1991',
     '[1991]', '19uu' — and it is year-granular by construction, so a real
     library resolves overwhelmingly to the year row. Google Books is the only
     source in the app that ever states a month or a day, and it needs a key
     the user supplies; this chart is what makes that trade concrete instead of
     a settings-screen claim.

     Colours come from the --bt-precision-* aliases, the same three the date
     field and the precision tag use, so a row here and a badge on a book are
     never a different colour for the same fact. */
  const PREC_ORDER = ['day', 'month', 'quarter', 'year', 'tba', 'unknown'];
  const PREC_LABEL = {
    day: 'Exact day', month: 'Month only', quarter: 'Quarter', year: 'Year only',
    tba: 'No date announced', unknown: 'No date at all',
  };
  /* tba and unknown are NEUTRAL, and it has to be spelled out rather than left
     to fall through. An unstyled bar takes .bar .g i's default fill, which is
     --bt-teal — the same hue --bt-precision-day resolves to — so "No date at
     all" drew in exactly the colour this chart uses for "we know the day". The
     one row meaning we know nothing was painted as the one meaning we know
     everything, and the number beside it is the only thing that gave it away. */
  const PREC_INK = {
    day: 'var(--bt-precision-day)',
    month: 'var(--bt-precision-month)',
    quarter: 'var(--bt-precision-month)',
    year: 'var(--bt-precision-year)',
    tba: 'var(--bt-text-faint)',
    unknown: 'var(--bt-text-faint)',
  };
  function certaintyBlock(items) {
    /* `release` is genuinely optional — 38-normalize's withDefaults stamps
       `user` and `tracking` but not `release`, and 12-repo guards it the same
       way. A record without one is a record with no known date, which this
       chart already has a row for. */
    const counts = tally(items, it => ((it.release && it.release.precision) || 'unknown'));
    const rows = PREC_ORDER.filter(p => counts[p]);
    const finer = (counts.day || 0) + (counts.month || 0) + (counts.quarter || 0);
    const pct = Math.round((finer / items.length) * 100);
    /* `hasKey('googlebooks')` and not a settings read: it is the same gate
       25-googlebooks itself is behind, so this paragraph can never promise a
       source the app is not actually allowed to call. */
    const hasKey = !!(BT.config && BT.config.hasKey && BT.config.hasKey('googlebooks'));

    return `<div class="bars">${rows.map(p =>
        bar(PREC_LABEL[p], counts[p], items.length, PREC_INK[p])).join('')}</div>
      <p class="statnote">
        <b>${esc(String(pct))}%</b> of the shelf is dated more precisely than a year.
        Open Library records publication years, not days, so that figure is a ceiling on
        what this app can know from it alone.
      </p>
      ${hasKey
        ? `<p class="statfoot">Google Books is switched on, and it is the only source here that
             states a month or a day. Books added before you supplied the key keep the coarser
             date until they are refreshed.</p>`
        : `<p class="statfoot">A Google Books key — added in Settings, stored only in this
             browser — is the one thing that moves books out of the year row. It is the
             difference this chart is here to show.</p>`}`;
  }

  /* ── The accounting ────────────────────────────────────────────────────
     Where the numbers come from, in the reader's language. This exists for the
     same reason MovieTrak puts its recommender's raw profile on screen: a
     derived figure nobody can check is a figure nobody should be asked to
     trust, and the cheapest way to make one checkable is to say out loud how
     it was reached. */
  function countingBlock(items, finishes) {
    const read = pagesRead(items);
    const rated = items.filter(it => it.user && it.user.rating != null).length;
    const noFinishDate = items.filter(it =>
      BT.ui.statusOf(it) === 'finished').length - finishes.size;

    return `
      <p class="statnote"><b>Pages read</b> counts a finished book's full extent, and every other
      book's recorded position. The extent is the page count you entered for your own copy where
      you gave one, and the catalogue's figure otherwise — a paperback and a hardback of the same
      novel genuinely differ by a couple of hundred pages, so the number off the book in your hand
      always wins.</p>
      ${read.unknownFinished
        ? `<p class="statfoot">${esc(BT.util.pluralize(read.unknownFinished, 'finished book'))} has
             no page count from either source and ${read.unknownFinished === 1 ? 'counts' : 'count'}
             as nothing rather than as a guess.</p>`
        : ''}

      <p class="statnote"><b>Reading pace</b> is differenced from the reading log, which records a
      position at the moment you enter it. It measures the gap between two entries, so it is a
      record of when you wrote a page number down rather than of when you turned the page — a
      fortnight of reading logged in one sitting lands in one column.</p>

      ${rated
        ? `<p class="statnote"><b>Your average</b> is the mean of
             ${esc(BT.util.pluralize(rated, 'rating'))} out of ten. Unrated books are absent from
             it, not counted as zero.</p>`
        : `<p class="statnote"><b>Your average</b> has nothing to average yet — no book has been
             rated. It will stay blank rather than showing a zero, because an unrated shelf is not
             a badly-rated one.</p>`}

      ${noFinishDate > 0
        ? `<p class="statfoot">${esc(BT.util.pluralize(noFinishDate, 'finished book'))} has no date
             attached to finishing it, so ${noFinishDate === 1 ? 'it is' : 'they are'} counted on
             the shelf but not in a year.</p>`
        : ''}

      <p class="statnote"><b>Genre</b> counts each book once, under the first bucket it is filed
      in — the same bucket the index tree counts it under, so the two always add up to the same
      library. A book matching three genres is still one book.</p>

      <p class="statfoot">Everything on this screen is computed in this browser from your own
      records. Nothing here is sent anywhere, and no figure is estimated to fill a gap.</p>`;
  }

  /* ── Primitives ────────────────────────────────────────────────────────
     The same tile and bar MovieTrak's stats screen uses, against the classes
     already in css/04-views.css.

     `max` IS THE LIBRARY SIZE FOR EVERY CHART HERE BUT ONE, so a bar means the
     same thing everywhere on the screen: this share of the shelf. MovieTrak
     scales its genre bars to the leading genre instead, which reads as a
     ranking — and mixing the two idioms in one column, drawn identically, is
     how a reader ends up believing a shelf with one fantasy novel on it is
     entirely fantasy. The single exception is the author ranking, which says
     out loud that it is scaled differently.

     `max || 1` guards the divide: a bar group whose largest value is zero is
     reachable, and NaN% is a width the browser drops — which leaves the bar at
     its CSS width, the most confident possible rendering of no data. */
  const tile = (v, l) =>
    `<div class="tile"><div class="v">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`;

  const bar = (l, n, max, ink) => `<div class="bar">
    <span class="bl" title="${esc(l)}">${esc(l)}</span>
    <span class="g"><i style="width:${Math.round((n / (max || 1)) * 100)}%${
      ink ? `;background:${ink}` : ''}"></i></span>
    <span class="n">${esc(String(n))}</span></div>`;

  /* Counts into a null-prototype object. A plain `{}` inherits `toString` and
     `constructor`, so a stored value of either name would land on a truthy
     function and be counted as one — the same prototype-chain trap
     BT.ui.statusOf tests around an array for. Nothing here is user-typed
     today, but tags and custom genre ids both are one feature away from
     reaching a tally. */
  function tally(arr, fn) {
    const o = Object.create(null);
    for (const x of arr) {
      const k = fn(x);
      if (k) o[k] = (o[k] || 0) + 1;
    }
    return o;
  }

  return { render };
})();
