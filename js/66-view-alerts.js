/* ══════════════════════════════════════════════════════════════════════════
   #/alerts — Activity. What changed since you last looked.

   Every LABEL on this screen is written to be literally true. Neither catalogue
   announces anything, so nothing here says "new release" or "coming soon"; it
   says "newly listed", because that is exactly what was observed — a title
   appeared in a merged catalogue that did not contain it last time. That does
   catch new books, and it also catches reprints and backlist titles somebody has
   only just catalogued.

   THE SCREEN NO LONGER EXPLAINS ITSELF. It used to carry a "How this works"
   panel and a paragraph of caveats repeated in two layouts, on the theory that
   the labels needed defending. If a label needs defending it is the wrong label,
   so the labels were fixed and the prose is gone. What is left is: rows, an
   empty state that says what to do, and two facts (how many authors are watched,
   when the last check ran). The reasoning lives in 45-alerts.js and DECISIONS.md.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewAlerts = (function () {
  const esc = BT.util.escapeHtml;

  const LABEL = {
    'release.dated':     'Publication date recorded',
    'release.moved':     'Publication date changed',
    'release.precision': 'Date firmed up',
    'author.newWork':    'Newly listed in this author’s catalogue',
    /* The other half of a followed catalogue changing: a title we already held
       now carries a different date. Both ends are DATES rather than years now
       that Google Books is the primary source — see 45-alerts.js
       pushDateChange — so the label says date, and a date that merely got finer
       never reaches this feed at all. */
    'author.dateChanged': 'Publication date changed in this catalogue',
    /* RETIRED, AND KEPT ANYWAY. Publisher following has been removed, but rows
       of this type are sitting in readers' databases right now and travel in
       every export. Dropping the label would render them as the bare string
       "publisher.newWork" under a title that still makes sense — a row that
       looks like a bug in the app rather than like history. Nothing GENERATES
       this any more; see 45-alerts.js. */
    'publisher.newWork': 'Newly listed under this publisher (no longer tracked)',
  };

  /* Three icon classes exist in css/04-views.css and no more, so the mapping is
     by MEANING rather than by type: `move` for something that shifted under
     you, `land` for something that arrived, `info` for something we are less
     than certain about. `author.dateChanged` is a `move` for the same reason
     `release.moved` is — a value we hold is not the value it was. Retired
     publisher rows keep `info`, which is what they always had: a publisher
     match was a name token rather than an identity, and that is still the right
     thing to say about the rows left behind. */
  const ICON = {
    'release.moved':     'move',
    'release.dated':     'land',
    'release.precision': 'land',
    'author.newWork':    'land',
    'author.dateChanged': 'move',
    'publisher.newWork': 'info',
  };
  const GLYPH = { move: '↔', land: '▸', info: 'i' };

  /* Module-level so a re-render cancels the previous screen's timer. Left
     stacking, every visit to #/alerts added another pending mark-read that
     fired against whatever was on screen two navigations later. */
  let readTimer = null;

  async function render(params, query, alive) {
    const view = document.getElementById('view');
    const showArchived = !!(query && query.archived);

    clearTimeout(readTimer);

    const rows = await BT.repo.feedItems({ includeArchived: showArchived });
    /* Authors only. Publisher following is retired (70-follows.js), and a
       publisher row syncing in from a device still on the old build must not be
       counted in a sentence that offers to manage it. */
    const follows = (await BT.repo.allFollows()).filter(f => f && f.type === 'author');
    const lastSweep = await BT.repo.metaGet('alerts.lastSweepAt');
    if (alive && !alive()) return;

    const unread = rows.filter(r => r.readAt == null).length;
    const sweeping = !!(BT.alerts && BT.alerts.isSweeping && BT.alerts.isSweeping());

    BT.ui.crumb(['Shelf', 'Activity']);
    BT.ui.paneActions(`
      <button class="btn btn--sm" id="sweepNow"${sweeping ? ' disabled' : ''}>${
        sweeping ? 'Checking…' : 'Check now'}</button>
      ${unread ? '<button class="btn btn--sm btn--ghost" id="readAll">Mark all read</button>' : ''}`);

    view.innerHTML = rows.length
      ? `<div class="two">
          <div class="col">
            <div class="hd">Changed recently${unread ? ` · ${unread} unread` : ''}</div>
            ${rows.map(evRow).join('')}
          </div>
          <div class="col">${sidebar(follows, lastSweep, showArchived)}</div>
        </div>`
      : emptyScreen(follows, lastSweep, showArchived);

    wire(view, rows, unread, alive);
  }

  /* ── The empty state ───────────────────────────────────────────────────
     Empty for two completely different reasons, and they need different
     answers. Either nothing has changed yet — fine, wait — or there is nothing
     being watched, in which case waiting will never help. When the follow list
     is empty the primary action is a link to Following, not another Check now.

     The body says what to DO and stops. The paragraph that used to sit here
     describing how change detection works has moved to 45-alerts.js. */
  function emptyScreen(follows, lastSweep, showArchived) {
    const none = !follows.length;
    return BT.ui.emptyState({
      title: none ? 'Nothing is being watched yet' : 'No activity yet',
      body: none
        ? 'Follow an author and their new and re-dated titles show up here.'
        : `Nothing has changed since the last check across the ${
            esc(BT.util.pluralize(follows.length, 'author'))} you follow.`,
      actions: (none
        ? '<a class="btn btn--primary" href="#/people">Follow an author</a> '
        : '') + '<button class="btn" id="sweepEmpty">Check now</button>'
        + `<p class="muted" style="font-size:var(--bt-fs-sm);line-height:1.6;margin-top:var(--bt-space-6);text-align:left">
             Last check: <b class="mono">${esc(BT.util.timeAgo(lastSweep))}</b>.
             ${showArchived ? '' : '<a href="#/alerts?archived=1">Show archived</a>'}
           </p>`,
    });
  }

  /* Two facts and two links. Nothing here explains the feature. */
  function sidebar(follows, lastSweep, showArchived) {
    const n = follows.length;
    return `
      <div class="hd">Watching</div>
      <p class="muted" style="font-size:var(--bt-fs-sm);line-height:1.6">
        <b class="mono">${n}</b> ${n === 1 ? 'author' : 'authors'} ·
        <a href="#/people">${n ? 'manage' : 'follow an author'}</a>
      </p>
      <p class="muted" style="font-size:var(--bt-fs-sm);line-height:1.6;margin-top:var(--bt-space-4)">
        Last check: <b class="mono">${esc(BT.util.timeAgo(lastSweep))}</b>
      </p>
      <p style="margin-top:var(--bt-space-5)">
        <a class="btn btn--sm" href="#/alerts${showArchived ? '' : '?archived=1'}">
          ${showArchived ? 'Hide archived' : 'Show archived'}</a>
      </p>`;
  }

  function evRow(a) {
    const ic = ICON[a.type] || 'info';
    const p = a.payload || {};
    return `<div class="ev ${a.readAt == null ? 'unread' : ''}" data-uid="${esc(a.uid || '')}">
      <div class="ic ${ic}">${GLYPH[ic]}</div>
      <div style="min-width:0">
        <div class="et">${esc(a.title)}</div>
        ${a.body ? `<div class="es">${esc(a.body)}</div>` : ''}
        <div class="es">${esc(LABEL[a.type] || a.type)}
          ${p.approximate ? ' · approximate match' : ''}
          ${a.count > 1 ? ` · changed ${a.count}×` : ''}
          ${a.archivedFlag ? ' · archived' : ''}
          · ${esc(BT.util.timeAgo(a.lastAt))}</div>
        ${dateDiff(a)}
      </div>
    </div>`;
  }

  /* A changed date is shown as both fields side by side, in the same 10-slot
     grammar as everywhere else, so the change in PRECISION is visible and not
     just the change in value — "1991-▨▨-▨▨ → 1991-09-▨▨" is the whole story of
     a release.precision row.

     The precisions come off the alert's payload rather than being assumed,
     which is the one thing MovieTrak's version of this could get away with and
     BookTrak cannot: it hard-coded 'day', harmless against TMDB's always-full
     dates, but here it would print "1965-01-01" for a year-only book and invent
     a day the record has never held. Where the payload cannot supply one — a
     coalesced row carries the newest transition's payload against the oldest
     `from` value — the fallback is 'year', because under-claiming hides
     information while over-claiming states something false. */
  function dateDiff(a) {
    if (a.type !== 'release.moved' && a.type !== 'release.dated' &&
        a.type !== 'release.precision') return '';
    const p = a.payload || {};
    return `<div class="diff">${mk(keyOf(a.from), p.fromPrecision)}
      <span class="faint">→</span>${mk(keyOf(a.to), p.toPrecision)}</div>`;
  }

  /* An alert endpoint is a sort key as a string, EXCEPT on release.precision,
     which stores 'precision:sortKey' so that a date firming up without moving
     still produces two distinct content-addressed ids.

     The explicit null check is the load-bearing line. A release.dated alert has
     `from: null` by definition — that is what "there was no date" means — and
     `Number(null)` is 0, which is finite, below SK_UNKNOWN, and renders through
     the date grammar as the year 0. The row would read "0000-▨▨-▨▨ →
     1965-▨▨-▨▨" on precisely the alert type that matters most. NaN falls
     through to dateField(null), which is the fully-hatched field that already
     means "nothing announced". */
  function keyOf(v) {
    if (v == null || v === '') return NaN;
    const s = String(v);
    const n = Number(s.indexOf(':') >= 0 ? s.slice(s.indexOf(':') + 1) : s);
    return Number.isFinite(n) ? n : NaN;
  }

  function mk(sk, precision) {
    if (!Number.isFinite(sk) || sk >= BT.util.SK_UNKNOWN) return BT.ui.dateField(null);
    const prec = precision || 'year';
    const parts = BT.util.sortKeyToParts(sk);
    /* `display` has to be supplied rather than left empty. BT.ui.dateField uses
       it verbatim as the field's tooltip and falls back to the literal string
       'No date' when it is blank — so an empty one hands the reader a visible
       "1991" that says "No date" on hover, which is worse than no tooltip at
       all. Rebuilt from the parts at the SAME precision the field is drawn at,
       so the words and the digits can never disagree. */
    return BT.ui.dateField({
      sortKey: sk, precision: prec,
      display: parts ? BT.util.displayRelease(parts, prec) : '',
    });
  }

  function wire(view, rows, unread, alive) {
    const doSweep = async () => {
      const btn = document.getElementById('sweepNow');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      if (!BT.alerts || !BT.alerts.sweep) { BT.ui.toast('Nothing to check with yet.'); return; }
      const rep = await BT.alerts.sweep({ manual: true });
      /* `rep.errors` is read, and that is the point. Built from `checked` and
         `alerts` alone, this toast said "Checked 3 · 0 updates" through a total
         Open Library outage in which nothing was checked at all — the app
         telling the reader their authors have published nothing when it had not
         managed to look. Nothing else in the app surfaces this report, so if
         this line does not say it, nobody does. */
      const failed = rep.errors
        ? `${rep.errors} follow${rep.errors === 1 ? '' : 's'} could not be checked`
        : '';
      BT.ui.toast(rep.skipped
        ? 'Already checking'
        : (failed
          ? `Checked ${rep.checked} · ${rep.alerts} update${rep.alerts === 1 ? '' : 's'} · ${failed}`
          : `Checked ${rep.checked} · ${rep.alerts} update${rep.alerts === 1 ? '' : 's'}`),
        failed ? { bad: true, ms: 6000 } : undefined);
      BT.router.resolve();
    };
    ['sweepNow', 'sweepEmpty'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.onclick = doSweep;
    });

    const ra = document.getElementById('readAll');
    if (ra) ra.onclick = async () => { await BT.repo.markAllFeedRead(); BT.router.resolve(); };

    /* Assignment, never addEventListener. #view outlives every route change, so
       a listener bound here would stay alive on other screens and fire this
       handler on their rows too. */
    view.onclick = e => {
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      const r = e.target.closest('[data-uid]');
      /* A newWork row names a book that is very likely NOT on the shelves yet.
         BT.inspector.show handles that: it falls back to a read-only transient
         fetch and offers an Add button, which is the whole point of following
         somebody. */
      if (r && r.dataset.uid) BT.inspector.show(r.dataset.uid);
    };

    /* Read on arrival, after a beat. Marking instantly would clear the unread
       marks before the eye reaches them, and marking only on leaving means the
       badge in the index still says 4 while you are looking at all four.

       The screen is NOT re-rendered afterwards — the dots stay visible for as
       long as you are on the page and are gone next visit, which is what makes
       "what is new" readable rather than something that vanishes as you look at
       it. Only the tree badge is refreshed. */
    if (unread) {
      readTimer = setTimeout(async () => {
        if (alive && !alive()) return;
        if (!location.hash.startsWith('#/alerts')) return;
        await BT.repo.markFeedRead(rows.filter(r => r.readAt == null).map(r => r.feedId));
        /* 55-tree.js already refreshes on the repo's `feed:change` event, so
           this is belt to that braces — kept because the badge going stale is
           the exact symptom that made the feature look broken, and it costs one
           call. */
        BT.tree.refresh();
      }, 2500);
    }
  }

  return { render };
})();
