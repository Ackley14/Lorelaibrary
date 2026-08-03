/* ══════════════════════════════════════════════════════════════════════════
   #/people — Following: authors and publishers.

   THE BUG THIS SCREEN FIXES IS DISCOVERABILITY, NOT PLUMBING. The `follows`
   store, its repo CRUD and the index-tree row have all been here since M1;
   what the user actually reported was "I couldn't figure out how to follow an
   author or publisher", and they were right — the only place it could have
   happened was a route that rendered a placeholder sentence. So this page is
   half of the fix and deliberately not all of it: the same Follow affordance
   also sits on the author name in a search result and in a book's detail pane,
   because that is where someone is standing when the thought occurs. A feature
   that exists only on the page named after it is a feature nobody finds.

   ── What this screen may and may not claim ────────────────────────────────
   THE STRIP LISTS WORKS DATED AFTER TODAY, AND NOTHING ELSE. That is the
   user's request in their own words — "i just want things listed with a
   publication date that is in the future from the current date", "specifically
   for those you follow of course" — and it replaced a much broader strip that
   showed everything in a follow's catalogue that was not already on the
   shelves. That version was not wrong, it was too wide to be useful: measured,
   213 cards from four follows and 400 from eight, nearly all of it backlist.

   OPEN LIBRARY HAS NO CONCEPT OF A FORTHCOMING BOOK, and narrowing the filter
   does not change that. There are no street dates, no announcements, no "coming
   soon" — the catalogue records books that EXIST, its dates are YEARS rather
   than dates, and those years are often wrong (The Alloy of Law, published
   2011, is recorded as 2001; verified). So the honest consequence of asking for
   genuinely future dates is A SHORT LIST OR AN EMPTY ONE:

       author (60-work page, sort=new)     dated > 2026    dated == 2026
       Brandon Sanderson                        0                1
       Stephen King                             0                1
       Nora Roberts                             0                2
       James Patterson                          0                6
       Neil Gaiman                              0                0
       Ursula K. Le Guin                        0                0

       whole catalogue, publish_year:2027 -> 18 works.  2028 -> 12 works,
       several of them a Nepali Bikram Sambat year read as Gregorian.

   THAT EMPTINESS IS THE ANSWER, NOT A FAILURE, and the empty state says so in
   those words. The temptation when a screen looks bare is to widen the filter
   until it looks busy again; doing that here would put last year's reprints
   back under a heading that promises the future, which is a worse screen than
   an empty one. If this list is ever quietly widened, the user's request has
   been thrown away and the heading has become a lie.

   A CURRENT-YEAR DATE IS GENUINELY UNDECIDABLE and is kept, marked. A bare
   '2026' read in August could mean last March or next November; the record does
   not say. Those rows are shown with the month and day HATCHED — the app's
   existing grammar for "this value cannot exist in the record" — and labelled
   in words. Where a Google Books key is configured they are sharpened into real
   days, which resolves most of them one way or the other. The reasoning lives
   next to the code that implements it, in 70-follows.js futureness().

   ── And it shows EVERYTHING that passes, not a sample ─────────────────────
   The strip below polls every follow on the roster and truncates nothing the
   filter let through. It did neither once, and that was a reported bug: "the
   following section seems to only bring up like 10 results max regardless of
   how many you have following." A short list with no explanation is read as the
   complete answer, so under-reporting here is not a smaller version of the
   feature — it is a false one. Rate limiting is answered by SHAPE (serialized,
   cached, painted as it arrives, progress on screen) rather than by showing
   less. See the block above strip() before reintroducing any cap.

   Note the difference between that rule and the filter above, because they look
   contradictory and are not: the strip must never hide a row the reader was
   entitled to see, and a row dated in the past is not one of those. What makes
   the narrow filter honest is that the count it scanned is printed next to the
   count it kept — "2 works dated after today · scanned 213 catalogued works" —
   so the reader can see the size of the question as well as the answer.

   ── And a publisher follow is a guess ─────────────────────────────────────
   Open Library has no publisher records and no publisher ids. `publisher=` is
   a token match over free text, so following "Tor" collapses Tor, Tor.com and
   Tor Science Fiction and misses "Tom Doherty Associates" entirely. The roster
   says "approximate" out loud, every publisher row shows the token it matches
   on, and the strip shows which imprint string each result actually carried.
   See 70-follows.js publisherSlug() for the full list of what it gets wrong.
   ══════════════════════════════════════════════════════════════════════════ */

BT.viewPeople = (function () {
  const esc = BT.util.escapeHtml;

  /* THE ONLY BOUND LEFT ON THE STRIP, and it is a DOM-size guard rather than
     an editorial one. There used to be two, STRIP_FOLLOWS = 4 and
     STRIP_MAX = 12, and together they were the reported bug — see the long
     comment above strip().

     Four hundred cards is already more than anyone scrolls, and forty follows
     at sixty works each would lay out two and a half thousand. It sits far
     above what an ordinary roster produces, and WHEN IT DOES BITE THE PAGE
     SAYS SO out loud ("showing 400 of 812"): a number that is quietly dropped
     is exactly the failure this section was just fixed for.

     The date filter has since put it out of reach entirely — measured, a
     forty-follow roster produces single digits — so it is now a guard against
     a future Open Library that grows a forthcoming catalogue, not a limit
     anybody meets. KEPT RATHER THAN DELETED for exactly that reason: the DOM
     bound was never about editorial taste, and removing it because today's
     data cannot reach it is how the 2,400-card layout comes back the day the
     catalogue changes. */
  const STRIP_MAX = 400;

  let followSet = new Set();   // ids currently followed — drives every button
  let pubIndex = [];           // publishers already in the library: [{name, n}]
  let ownedWorks = new Set();  // olWork ids on the shelves, for the strip
  let inflight = null;         // AbortController for the author lookup
  let stripAbort = null;       // AbortController for the follow sweep
  let term = '';
  let touchStart = null;
  let moved = false;           // true when the current gesture is a scroll
  let stripWorks = new Set();  // work ids currently painted, for subscribeOnce
  let subscribed = false;      // the repo subscription is registered once, ever

  /* Works that became yours WHILE this strip was showing them.

     They are deliberately not filtered back out. Adding a book from the detail
     pane ends in BT.router.resolve(), which re-renders this screen — and the
     re-render reads the shelves again, so without this set the card the reader
     just acted on would VANISH from under the pane they acted on it in. A row
     that disappears the instant you use it reads as a mistake rather than as
     success, which is the same lesson as the surgical Add-button swap in
     61-view-search. They stay where they are, marked "In your library", which
     is also the honest label: the strip's job is books you do not have, and
     this is the one row on it that is no longer one of those. */
  const addedHere = new Set();

  /* ── SEAM ──────────────────────────────────────────────────────────────
     Feature-detected rather than assumed, the same way 61-view-search guards
     its two. A bare call to a module that failed to parse is a TypeError
     inside a debounce callback, where it shows up as a search box that does
     nothing at all and one console line from three keystrokes ago. */
  function missingDeps() {
    const out = [];
    if (!BT.follows || typeof BT.follows.toggleAuthor !== 'function') out.push('70-follows.js');
    if (!BT.openlibrary || typeof BT.openlibrary.searchAuthors !== 'function') out.push('20-openlibrary.js');
    /* futureness() is checked separately from the module that holds it, because
       an OLDER 70-follows.js parses fine and answers toggleAuthor perfectly
       while having no forthcoming test at all — at which point the strip would
       filter nothing and quietly go back to being the 400-card backlist screen
       under a heading that now promises the future. A missing filter must fail
       loudly; a strip that silently stops filtering is the failure this whole
       change was made to remove. */
    if (BT.follows && typeof BT.follows.futureness !== 'function') out.push('70-follows.js (futureness)');
    return out;
  }

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;

    BT.ui.crumb(['Discover', 'Following']);
    BT.ui.paneActions('<a class="btn btn--sm" href="#/search">Search for a book</a>');

    if (inflight) { inflight.abort(); inflight = null; }
    /* The previous visit's sweep, if one is still walking the roster. Polling
       every follow can take a while on a long roster, so a route change that
       left it running would keep spending Open Library's ~1/sec allowance on a
       screen nobody is looking at — and the reader's next search would queue
       behind it. `alive()` stops the LOOP; only this stops the request that
       loop is currently inside. */
    if (stripAbort) { stripAbort.abort(); stripAbort = null; }
    subscribeOnce();

    const gap = missingDeps();
    if (gap.length) {
      view.innerHTML = BT.ui.errorBox('Following is not wired up on this page',
        `Missing ${gap.join(', ')}. Everything already on your shelves still works.`);
      return;
    }

    /* ONE read of the library, reused twice below: to suggest publishers the
       reader already owns books from, and to mark the strip's rows as owned.
       Reading it inside the keystroke handler instead was the obvious shape,
       and is a full store scan on every letter typed. */
    const items = await BT.repo.allItems();
    if (alive && !alive()) return;
    pubIndex = publisherIndex(items);
    ownedWorks = new Set(items.map(it => (it.ids && it.ids.olWork) || '').filter(Boolean));

    const follows = await BT.follows.all();
    if (alive && !alive()) return;
    followSet = new Set(follows.map(f => f.id));

    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="fq" type="search" placeholder="Find an author, or type a publisher’s name…"
                 spellcheck="false" autocomplete="off" autocapitalize="none" autocorrect="off"
                 value="${esc(term)}" aria-label="Find an author or publisher to follow">
        </div>
        <div class="shint">
          Authors are matched on their Open Library id, never on their name — a
          name-scoped search for one author genuinely returns another author’s books.
          Publishers have no id at all, so those are matched on a word and are
          <b>approximate</b>.
        </div>
      </div>

      <div id="fres"></div>

      <div id="froster">${roster(follows)}</div>

      ${follows.length ? `
        ${BT.ui.groupHead('Publishing after today')}
        <div class="why-line" style="margin:0 var(--bt-space-6) var(--bt-space-3)">
          Only works dated <b>after today</b>, from all ${esc(String(follows.length))} of your
          follows, that are not already on your shelves. Reprints count — the test is the
          date. Open Library has no forthcoming-title concept and records years rather
          than dates, so <b>expect this to be short or empty</b>; a year with no month
          is shown as <span class="mono">${esc('▨▨')}</span> and could still be behind
          us.${gbNote()}
        </div>
        <div id="fnew">${BT.ui.skeletonGrid(8)}</div>` : ''}`;

    const input = document.getElementById('fq');
    /* 350ms, and longer on a touch screen. Same reasoning as the search view:
       Open Library's sustained budget is about one request a second, and a
       240ms debounce fires four times a second while someone types a name. */
    const wait = matchMedia('(pointer: coarse)').matches ? 420 : 350;
    const run = BT.util.debounce(() => find(input.value.trim()), wait);
    input.addEventListener('input', run);
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
    if (term) find(term);

    /* Assignment, never addEventListener. #view OUTLIVES every route change —
       only its contents are replaced — so a listener bound here would stay
       alive on other screens and stack up one more copy per re-render. See the
       same note in 62-view-list.js. Every selector below is unique to this
       page, so a stale assignment is inert until the next view overwrites it. */
    view.onclick = onClick;
    view.ontouchstart = e => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
      moved = false;
    };
    view.ontouchmove = e => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - touchStart.y) > 8 || Math.abs(t.clientX - touchStart.x) > 8) moved = true;
    };

    if (follows.length) strip(follows, alive);
  }

  /* Whether the year-only rows on this screen can be resolved at all, said
     once and where the reader is standing when the question occurs to them.

     Not a nag and not a banner: a key is optional, the screen works without
     one, and every row it would sharpen is already on screen and honestly
     labelled. What the note buys is that "2026, we cannot tell" stops looking
     like a defect in BookTrak and starts looking like what it is — the limit of
     a catalogue that stores years, with a named way out. */
  function gbNote() {
    const on = !!(BT.googlebooks && typeof BT.googlebooks.enabled === 'function'
                  && BT.googlebooks.enabled());
    if (on) return ' Google Books is sharpening those into real dates where it can.';
    return ' A <a href="#/settings">Google Books key</a> would sharpen most of those'
      + ' into real dates.';
  }

  /* ── Publishers the reader already owns ────────────────────────────────
     There is no publisher search to call — Open Library has no publisher index
     — so any "publisher results" list would be fabricated. What is real and
     free is the reader's own shelves: the imprints on the books they already
     have are exactly the publishers they are likely to want to follow, and
     counting them costs nothing because the library is already in memory.

     Folded on the SLUG rather than the display string, so "Tor Books" and
     "Tor" are one suggestion with a combined count instead of two rows that
     lead to the same follow.

     The count is BOOKS, not imprint strings, and the per-item guard is what
     makes that true: one edition record routinely lists ['Tor Books', 'Tor']
     or ['Doubleday', 'Doubleday & Company, Inc.'], which slug to one publisher.
     Counting each string would report two books on the shelves when there is
     one — and the whole value of this list is that its numbers are the
     reader's own library rather than a claim about the catalogue. */
  function publisherIndex(items) {
    const by = new Map();
    for (const it of items) {
      const counted = new Set();
      for (const p of (it.publishers || [])) {
        const name = String(p || '').trim();
        if (!name) continue;
        const slug = BT.follows.publisherSlug(name);
        if (!slug || counted.has(slug)) continue;
        counted.add(slug);
        const hit = by.get(slug);
        if (hit) { hit.n++; continue; }
        by.set(slug, { slug, name, n: 1 });
      }
    }
    return [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }

  /* ══ FINDING SOMEONE TO FOLLOW ═════════════════════════════════════════ */

  async function find(q) {
    term = q;
    const host = document.getElementById('fres');
    if (!host) return;

    if (q.length < 2) {
      if (inflight) { inflight.abort(); inflight = null; }
      host.innerHTML = '';
      return;
    }

    /* The publisher half is LOCAL and instant, so it is painted before the
       network answers rather than after it. Waiting on Open Library to show a
       list that never needed it made following a publisher feel like the
       slower of the two, which is backwards. */
    host.innerHTML = publisherRows(q) + BT.ui.groupHead('Authors')
      + '<div class="miss muted">Looking up authors…</div>';

    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    let authors;
    try {
      authors = await BT.openlibrary.searchAuthors(q, { limit: 8, signal });
    } catch (e) {
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
      if (signal.aborted) return;
      host.innerHTML = publisherRows(q)
        + BT.ui.errorBox('Could not look up authors', authorFailure(e));
      return;
    }
    if (signal.aborted) return;

    /* The adapter has ALREADY dropped `work_count === 0` rows (merge leftovers
       with a real name, a real OLID and nothing attached) and deduped on the
       normalized OLID. Doing either again here would be a second, divergent
       copy of a rule that belongs next to the endpoint that needs it. */
    host.innerHTML = publisherRows(q) + BT.ui.groupHead('Authors', authors.length)
      + (authors.length
          ? authors.map(authorRow).join('')
          : `<div class="miss muted">No author in Open Library matches “${esc(q)}”.</div>`);
  }

  function authorFailure(e) {
    const kind = (e && e.kind) || 'server';
    if (kind === 'offline') return 'You appear to be offline. Publishers can still be followed — that half is matched locally.';
    if (kind === 'budget' || kind === 'quota-soft') return 'Open Library allows about one request a second. Give it a moment.';
    return (e && e.message) || String(e);
  }

  function authorRow(a) {
    const id = BT.follows.authorId(a.olid);
    const on = followSet.has(id);
    /* Escaped as it is collected, not at the join. `top_work` is a catalogue
       title contributed by volunteers and has carried an ampersand and a stray
       angle bracket in the wild; assembling this list unescaped and trusting
       the join site to remember is how one of those ends up parsed as markup. */
    const bits = [];
    if (a.workCount != null) bits.push(esc(BT.util.pluralize(a.workCount, 'work')));
    if (a.topWork) bits.push(esc(BT.util.truncate(a.topWork, 44)));
    if (a.birthDate) bits.push(esc(a.birthDate) + (a.deathDate ? '–' + esc(a.deathDate) : ''));
    return `<div class="miss">
      <span class="chipart" style="width:22px;height:22px;border-radius:50%;--a:#5A4A7A;--b:#1C1728">${
        a.photoUrl ? `<img loading="lazy" src="${esc(a.photoUrl)}" alt="">` : ''}</span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini)">
          ${bits.join(' · ')} <span class="mono faint">${esc(a.olid)}</span>
        </div>
      </div>
      ${followBtn(id, on, a.name, 'author', a.olid)}
    </div>`;
  }

  /* Publisher candidates: the imprints already on the shelves that match what
     was typed, plus the typed words themselves — always, and last. The typed
     row is not a fallback for an empty list, it is the honest primary case:
     Open Library will happily match a publisher token that appears on no book
     the reader owns yet, which is the entire point of following one. */
  function publisherRows(q) {
    const needle = q.toLowerCase();
    const typedSlug = BT.follows.publisherSlug(q);
    /* The slug arm is guarded because ''.includes('') is TRUE: a query that
       slugs to nothing — punctuation, or a word that is pure corporate
       apparatus like "Inc" — would otherwise match every publisher on the
       shelves and fill the picker with unrelated imprints. */
    const hits = pubIndex.filter(p => p.name.toLowerCase().includes(needle)
                                   || (typedSlug && p.slug.includes(typedSlug)))
                         .slice(0, 5);
    const rows = hits.map(p => publisherRow(p.name, `${BT.util.pluralize(p.n, 'book')} on your shelves`));
    if (typedSlug && !hits.some(p => p.slug === typedSlug)) {
      rows.push(publisherRow(q, 'not on your shelves yet'));
    }
    if (!rows.length) return '';
    return BT.ui.groupHead('Publishers', rows.length) + rows.join('');
  }

  function publisherRow(name, sub) {
    const id = BT.follows.publisherId(name);
    if (!id) return '';
    const slug = BT.follows.publisherSlug(name);
    const on = followSet.has(id);
    return `<div class="miss">
      <span class="chipart" style="width:22px;height:22px;--a:#3F6B5A;--b:#14211C"></span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini)">
          ${esc(sub)} · approximate, matches on <span class="mono">${esc(slug)}</span>
        </div>
      </div>
      ${followBtn(id, on, name, 'publisher', name)}
    </div>`;
  }

  /* One button, both states, because a Follow that becomes a Following marker
     in place is the only version that does not move the row under a thumb —
     the same reason 61-view-search swaps its Add button rather than repainting
     the list. aria-pressed carries the state for a screen reader. */
  function followBtn(id, on, name, type, key) {
    return `<button class="add${on ? ' is-in' : ''}" type="button"
      data-follow="${esc(id)}" data-ftype="${esc(type)}" data-fkey="${esc(key)}"
      data-fname="${esc(name)}" aria-pressed="${on ? 'true' : 'false'}"
      >${on ? '✓ Following' : 'Follow'}</button>`;
  }

  /* ══ THE ROSTER ════════════════════════════════════════════════════════ */

  function roster(follows) {
    if (!follows.length) {
      return BT.ui.emptyState({
        title: 'You are not following anyone yet',
        body: 'Follow an author and BookTrak checks their catalogue for works it has not '
          + 'seen before. You can also follow from the author’s name on any search result, '
          + 'so you never have to come here first.',
      });
    }
    /* `|| ''` because these rows survive an export and an import: a row that
       arrived from another device — or from a version of this file that wrote
       the name differently — must sort rather than throw, or one malformed
       follow takes the whole roster down. */
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const authors = follows.filter(f => f.type === 'author').sort(byName);
    const pubs = follows.filter(f => f.type === 'publisher').sort(byName);

    return (authors.length ? BT.ui.groupHead('Authors', authors.length) + authors.map(rosterRow).join('') : '')
      + (pubs.length ? BT.ui.groupHead('Publishers', pubs.length) + pubs.map(rosterRow).join('') : '');
  }

  /* The work count is what we have SEEN, and is labelled that way. It is the
     size of the diff baseline, not Open Library's idea of how many works the
     author has — those two differ (we ask for one page), and printing the
     larger number next to a follow that will only ever be diffed against the
     smaller one would be a quiet lie about what is being watched. */
  function rosterRow(f) {
    const n = (f.knownWorkIds || []).length;
    const seen = n ? `${n} work${n === 1 ? '' : 's'} seen` : 'not checked yet';
    const when = f.lastCheckedAt ? BT.util.timeAgo(f.lastCheckedAt) : 'never checked';
    const note = f.type === 'publisher'
      ? ` · approximate, matches on <span class="mono">${esc(f.sourceId)}</span>`
      : ` · <span class="mono faint">${esc(f.sourceId)}</span>`;
    return `<div class="miss">
      <span class="chipart" style="width:22px;height:22px;${f.type === 'author' ? 'border-radius:50%;' : ''}--a:${
        f.type === 'author' ? '#5A4A7A;--b:#1C1728' : '#3F6B5A;--b:#14211C'}"></span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
        <div class="muted" style="font-size:var(--bt-fs-mini)">${esc(seen)} · ${esc(when)}${note}</div>
      </div>
      <button class="btn btn--sm btn--ghost" type="button" data-unfollow="${esc(f.id)}">Unfollow</button>
    </div>`;
  }

  /* ══ CLICKS ════════════════════════════════════════════════════════════
     One delegated handler for the whole view. Every branch updates the DOM in
     place instead of calling BT.router.resolve(): a full re-render would throw
     away what is typed in the box and the results under it, so following three
     authors from one search would mean typing the search three times.

     A CARD TAP OPENS THE DETAIL PANE AND ADDS NOTHING, and that is a reported
     bug rather than a preference. This branch used to call BT.ui.addItem, so
     looking at what an author has out quietly filled the library with `want`
     entries the reader never asked for — on a screen whose entire purpose is
     BROWSING books you do not own, where a tap is the only way to find out
     what a book even is. The pane is the safe, reversible answer: it shows the
     record and offers one explicit "Add to library" button (56-inspector's
     `_transient` mode), which is the same shape 61-view-search settled on when
     the identical complaint came in about its result rows. */
  async function onClick(e) {
    const fb = e.target.closest('[data-follow]');
    if (fb) { if (suppressTap()) return; await onToggle(fb); return; }

    const un = e.target.closest('[data-unfollow]');
    if (un) { if (suppressTap()) return; await onUnfollow(un.dataset.unfollow); return; }

    const card = e.target.closest('[data-uid]');
    if (card) { if (suppressTap()) return; onOpen(card.dataset.uid); return; }
  }

  /* A tap that followed finger movement is a scroll, not a tap. Browsers fire
     click after a short drag, so on a phone a flick down this page would
     otherwise land on whatever was under the thumb when it lifted — and the
     follow branches above WRITE. Lifted from 61-view-search, where the same
     gesture was silently adding whichever result the scroll ended on. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  async function onToggle(btn) {
    const type = btn.dataset.ftype;
    const key = btn.dataset.fkey;
    const name = btn.dataset.fname || key;
    btn.disabled = true;
    let res;
    try {
      res = type === 'publisher'
        ? await BT.follows.togglePublisher(key)
        : await BT.follows.toggleAuthor(key, name);
    } finally {
      btn.disabled = false;
    }
    /* null means there was nothing to key on — for an author, no OLID. It is
       NOT a silent no-op: following by name is the one thing this feature must
       never do, so the reason is said out loud rather than leaving a button
       that appears broken. */
    if (!res) {
      BT.ui.toast('Open Library has no id for that record, so it cannot be followed reliably.', { bad: true });
      return;
    }
    if (res.following) followSet.add(res.id); else followSet.delete(res.id);
    markButtons(res.id, res.following);
    BT.ui.toast(res.following ? `Following ${res.name}` : `Unfollowed ${res.name}`);
    await repaintRoster();
  }

  async function onUnfollow(id) {
    const gone = await BT.follows.unfollow(id);
    if (!gone) return;
    followSet.delete(id);
    markButtons(id, false);
    BT.ui.toast('Unfollowed');
    await repaintRoster();
  }

  /* EVERY button for this follow, not just the one that was pressed. The same
     author can be a search result and a roster row at the same time, and a
     screen that shows "Follow" and "✓ Following" for one person simultaneously
     reads as a bug in the app rather than as two views of one row. */
  function markButtons(id, on) {
    /* Scanned and compared rather than selected with an attribute selector: a
       follow id is `author:openlibrary:OL1394865A`, and colons are combinators
       in CSS. Building that into a selector needs CSS.escape and gets it wrong
       silently — a selector that matches nothing throws no error, it just
       leaves the button saying the opposite of the truth. */
    for (const b of document.querySelectorAll('[data-follow]')) {
      if (b.dataset.follow !== id) continue;
      b.classList.toggle('is-in', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = on ? '✓ Following' : 'Follow';
    }
  }

  async function repaintRoster() {
    const host = document.getElementById('froster');
    if (!host) return;
    const follows = await BT.follows.all();
    followSet = new Set(follows.map(f => f.id));
    host.innerHTML = roster(follows);
  }

  /* ══ THE STRIP ═════════════════════════════════════════════════════════
     What is in these catalogues that is not on the shelves — ALL of it.

     ── THE CAP THAT WAS THE BUG ──────────────────────────────────────────
     This used to poll the four least-recently-checked follows (STRIP_FOLLOWS)
     and then keep the best twelve rows of whatever came back (STRIP_MAX). Both
     numbers were inherited from the app this screen was ported from, and the
     report was exact: "the following section seems to only bring up like 10
     results max regardless of how many you have following". Twelve rows is
     what a reader with thirty follows saw, nothing on the page said so, and a
     short list with no explanation reads as "that is everything there is" —
     which is a claim about the catalogue that we had not made and could not
     support. Silent truncation is not a smaller version of the feature, it is
     a different and false one.

     Both are gone. What replaces them is NOT "no limit" — Open Library still
     sustains about one request a second and explicitly asks not to be used as
     an automated backend — it is a different SHAPE, and every piece of it is
     load-bearing:

       · EVERY follow is polled, ONE AT A TIME. A plain loop with one await,
         never Promise.all: fanning out over a roster of thirty is both rude
         and self-defeating, because it spends the budget the reader needs for
         their next search and gets them throttled for the trouble.
       · WHAT IS ALREADY CACHED IS PAINTED FIRST, before a single request goes
         out. That is the `cacheOnly` pass below, and it is what makes the
         difference between a long roster opening instantly with last visit's
         answers and opening empty for half a minute.
       · EACH ANSWER IS PAINTED AS IT LANDS, so the slowest follow delays only
         itself and never the page.
       · THE PROGRESS IS VISIBLE ("Checking 4 of 12 follows…"). This is the
         part that makes removing the cap honest rather than merely slower: a
         reader who can see that eight follows have not answered yet does not
         read the six cards on screen as the complete answer.
       · ONE FAILING FOLLOW IS CAUGHT AND THE REST CARRY ON. A failure is not
         silence, though — if NONE of them answered, that is an outage and the
         strip says so rather than claiming there is nothing new.

     READ-ONLY, AND THAT IS LOAD-BEARING. BT.follows.worksOf() does not touch
     `knownWorkIds`; only the alerts sweep's markChecked() does. If this screen
     recorded what it saw, opening it once would consume the baseline the sweep
     diffs against — so the sweep afterwards would find nothing new and emit
     nothing, for ever, with no error anywhere and a screen that looks perfect.
     Polling the whole roster instead of four makes that trap MUCH easier to
     fall into, because it now looks like a sweep. It is not one. */
  async function strip(follows, alive) {
    if (!document.getElementById('fnew')) return;

    /* Least-recently-checked first. It no longer decides WHO is polled — every
       follow is — only who is polled FIRST, which puts the follow most likely
       to have changed at the front of the queue. */
    const queue = follows.slice()
      .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));

    const state = {
      seen: new Map(),      // workId -> KEPT row, which is also the de-dup
      /* Every distinct work any follow offered, whether or not it survived the
         date filter. This is what makes a short answer legible: "2 works dated
         after today · scanned 213 catalogued works" reads as a narrow question
         honestly answered, while a bare "2 works" reads as a broken feed. It is
         a SET rather than a counter because the same work arrives twice when
         you follow both an author and their publisher, and counting it twice
         would inflate the very number that is supposed to reassure. */
      scanned: new Set(),
      of: queue.length,
      checked: 0,
      ok: 0,
      failed: 0,
      lastErr: null,
      shown: 0,
      total: 0,
      maybe: 0,             // kept rows whose year straddles today
      sharpened: 0,         // maybes Google Books resolved to a real date
      dropped: 0,           // maybes Google resolved to a date already past
      phase: 'poll',        // 'poll' | 'sharpen'
      done: false,
    };

    /* PASS ONE — what this browser already holds, on screen before anything is
       asked for. `cacheOnly` never reaches the network: 05-net answers from the
       row BT.repo.cacheGet hands back, or with null. So this costs one
       IndexedDB read per follow and no rate-limit budget at all, and it is why
       coming back to this screen inside the cache window is instant.

       A throw here is not an outage — nothing was asked — so it is logged and
       skipped rather than counted against `failed`. */
    for (const f of queue) {
      if (alive && !alive()) return;
      try {
        absorb(state, f, await BT.follows.worksOf(f, { cacheOnly: true }));
      } catch (e) {
        console.warn('[people] cached answer for', f.name, 'was unreadable', e);
      }
    }
    paintStrip(state);

    /* PASS TWO — the refresh, serialized over the whole roster.

       Signalled, and the controller is aborted by the next render(). `alive()`
       stops the LOOP but cannot stop the request the loop is currently sitting
       inside, and on a thirty-follow roster that difference is thirty queued
       requests still being spent after the reader has walked away.

       Checked BEFORE the controller is stored, not only inside the loop: a
       superseded sweep that reached this line would overwrite the LIVE sweep's
       controller, and the next render would then abort a controller nobody was
       listening to while thirty real requests carried on. */
    if (alive && !alive()) return;
    stripAbort = new AbortController();
    const signal = stripAbort.signal;

    for (const f of queue) {
      if (alive && !alive()) return;
      state.checked++;
      paintProgress(state, f);
      try {
        /* No `limit` override: BT.LIMITS.authorWorks (60) is what the sweep
           asks for, and a screen promising "everything visible" must not ask
           for a smaller page than the background job does. */
        const res = await BT.follows.worksOf(f, { signal });
        state.ok++;
        if (absorb(state, f, res)) paintStrip(state);
      } catch (e) {
        /* Both spellings of "cancelled" — BT.net classifies its own aborts as
           kind 'abort', but a raw DOMException can still reach here. Neither is
           a follow that failed, and counting one as such would tell the reader
           their roster is broken when all they did was change screens. */
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
        if (signal.aborted) return;
        state.failed++;
        state.lastErr = e;
        paintProgress(state, null);
      }
    }
    if (alive && !alive()) return;

    /* PASS THREE — sharpen the undecidable ones, if a key makes that possible.
       Runs LAST, over what survived, rather than inside the loop above. Two
       reasons, and the second is the one that matters:

         · it does not slow the Open Library walk down, so the strip still
           paints at the speed it always did and the sharpening visibly refines
           a list that is already on screen;
         · until every follow has answered we do not know which rows are
           duplicates. Sharpening inside the loop would spend a Google request
           on a work that the next follow is about to hand us again. */
    await sharpen(state, alive, signal);
    if (alive && !alive()) return;

    state.done = true;
    stripAbort = null;
    paintStrip(state);
  }

  /* ── PASS THREE ────────────────────────────────────────────────────────
     Turn 'maybe' rows into real dates, or leave them honestly labelled.

     A 'maybe' is a bare year equal to the CURRENT year: read in August, '2026'
     could be last March or next November and the record does not say which.
     Google Books does say, on a large share of volumes, and 70-follows.js
     sharpenYear() borrows 25-googlebooks.js's own match rules to read it
     safely — see the long note there for why a laxer copy of those rules is
     dangerous rather than merely sloppy.

     NOTHING HAPPENS WITHOUT A KEY. Anonymous Books API access answers HTTP 429
     with a quota of zero, so a keyless attempt is not a slower version of this,
     it is an error every time. sharpenYear() returns null before building a
     URL, and this loop never runs at all.

     SERIALIZED, for the same reason the Open Library walk is: the quota belongs
     to the reader, and a fan-out spends it faster without producing an answer
     any sooner on a list this short.

     A SHARPENED ROW CAN LEAVE THE STRIP, and that is the point rather than a
     side effect. If Google says the 2026 book came out on March 5th, it is
     behind us and it does not belong under a heading that says "after today".
     The count of those is kept and printed, because a card the reader saw a
     moment ago vanishing with no explanation is exactly the kind of silent
     change this screen has been burned by before. */
  const SHARPEN_MAX = 24;

  async function sharpen(state, alive, signal) {
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function' || !gb.enabled()) return;
    if (typeof BT.follows.sharpenYear !== 'function') return;

    /* Author follows only. A publisher search doc carries no author name, and
       the shared-surname test in confidentMatch() cannot pass without one — so
       asking would spend the reader's quota on a guaranteed refusal. */
    const todo = [...state.seen.values()]
      .filter(r => r.verdict === 'maybe' && r.via && r.via.type === 'author');
    if (!todo.length) return;

    state.phase = 'sharpen';
    /* A BOUND ON THE REQUESTS, NOT ON THE ROWS, and the difference is what
       makes it honest. Every row stays on screen either way; the cap only
       decides how many of them get a real date instead of a hatched year. So
       unlike the STRIP_MAX that was once the bug here, nothing the reader could
       have seen is hidden by reaching it — and the twenty-fifth row still says
       "year only" out loud rather than pretending to be precise. */
    const batch = todo.slice(0, SHARPEN_MAX);

    for (const r of batch) {
      if (alive && !alive()) return;
      /* `state.checked` is deliberately NOT advanced here. It counts follows
         polled, it is printed as "checking N of M follows", and pushing it past
         M to reuse it as a generic spinner counter would make that line read
         "checking 31 of 12". A different phase gets a different sentence. */
      paintProgress(state, r.via);
      let better = null;
      try {
        better = await BT.follows.sharpenYear(r.w, r.via.name, { release: r.release, signal });
      } catch (e) {
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) return;
        if (signal && signal.aborted) return;
        /* Enrichment is a nicety and must never be the reason this strip fails
           to paint. The row keeps its honest year-only date and the loop
           carries on; this is NOT counted against `failed`, which means "a
           follow could not be checked" and would otherwise report a Google
           outage as a broken roster. */
        console.warn('[people] date sharpening failed for', r.w.title, e && e.message);
        continue;
      }

      /* Marked on ASKING, not on succeeding, because the card distinguishes the
         two: "year only" and "year only, and Google has no finer date either"
         are different states, and a reader who paid for a key deserves to know
         which of them they are looking at. Set after the catch, so a request
         that threw is not recorded as an answer. */
      r.sharp = 1;
      /* No repaint on a no-op. The note it would add is picked up by the final
         paint in strip(), and repainting here would re-create every cover on
         the grid up to twenty-four times for nothing. */
      if (!better) continue;

      r.release = better;
      r.verdict = BT.follows.futureness(better);
      state.sharpened++;
      if (r.verdict !== 'future' && r.verdict !== 'maybe') {
        state.dropped++;
        state.seen.delete(r.w.workId);
      }
      state.maybe = countMaybe(state);
      paintStrip(state);
    }
    state.phase = 'poll';
  }

  function countMaybe(state) {
    let n = 0;
    for (const r of state.seen.values()) if (r.verdict === 'maybe') n++;
    return n;
  }

  /* -> true when this answer put something new on the strip.

     DE-DUPLICATED ON THE WORK ID, and that is not tidiness: following both an
     author and the publisher who prints them is the ordinary case, and it
     delivers the same book twice. First one in wins, so a row keeps the
     attribution of whichever follow answered first — which, given the
     least-recently-checked ordering, is the one we knew least about.

     Works already on the shelves are dropped rather than shown greyed out. The
     point of this section is what you do NOT have; a strip that also lists your
     own library is just the library with extra steps. The one exception is
     `addedHere` — see the note on that set.

     AND THIS IS WHERE THE DATE FILTER BITES. Everything the follows offered is
     counted into `scanned`; only what is dated after today is kept. The order
     of the two tests matters and is deliberate: OWNERSHIP IS CHECKED FIRST, so
     a book already on the shelves is not counted as something we looked at and
     rejected on a date — it was never a candidate, and inflating the scanned
     figure with the reader's own library would make the ratio meaningless.

     'unknown' AND 'past' ARE BOTH DROPPED, AND THEY ARE DROPPED SEPARATELY IN
     MEANING EVEN THOUGH THE CODE TREATS THEM ALIKE. A work with no year at all
     is not a forthcoming book; it is an unfinished catalogue record, and there
     are a great many of them. Letting undated records through "in case" is the
     softest possible way to reintroduce the backlist strip. */
  function absorb(state, f, res) {
    if (!res || !Array.isArray(res.works)) return false;
    let added = 0;
    for (const w of res.works) {
      if (!w.workId || state.seen.has(w.workId)) continue;
      const mine = addedHere.has(w.workId);
      if (ownedWorks.has(w.workId) && !mine) continue;
      state.scanned.add(w.workId);

      const release = BT.follows.releaseOfWork(w);
      const verdict = BT.follows.futureness(release);
      if (verdict !== 'future' && verdict !== 'maybe') continue;

      state.seen.set(w.workId, {
        w, via: f, release, verdict,
        approximate: !!res.approximate,
        owned: mine,
        sharp: 0,
      });
      if (verdict === 'maybe') state.maybe++;
      added++;
    }
    return added > 0;
  }

  /* The progress line and the grid are SEPARATE elements, and that is the same
     rule 61-view-search's signature check enforces arriving by another route.
     The line changes once per follow while the grid does not, and rewriting the
     grid to move a counter would re-create every cover <img> inside it — so a
     roster of thirty would flash the whole strip thirty times on one visit. */
  function scaffold() {
    const host = document.getElementById('fnew');
    if (!host) return null;
    if (!host.querySelector('#fgrid')) {
      host.innerHTML = '<div class="fprog" id="fprog"></div><div id="fgrid"></div>';
    }
    return host;
  }

  function paintProgress(state, checking) {
    if (!scaffold()) return;
    const el = document.getElementById('fprog');
    if (el) el.innerHTML = progressLine(state, checking);
  }

  /* WHAT IS BEING CLAIMED, in one line, and it is never allowed to imply the
     list is finished when it is not. "showing 400 of 812" is here for the same
     reason: the hard bound may drop rows, and a row dropped without a word is
     the bug this whole section was rewritten for. */
  function progressLine(state, checking) {
    if (!state.done) {
      if (state.phase === 'sharpen') {
        /* Named, not hidden behind a generic spinner. The reader is watching a
           list that may LOSE a row in a moment, and "sharpening dates" is the
           sentence that makes that make sense when it happens. */
        return `<span class="fdot"></span>Sharpening year-only dates with Google Books…${
          checking ? ` <span class="faint">${esc(BT.util.truncate(checking.name, 34))}</span>` : ''}`;
      }
      return `<span class="fdot"></span>Checking ${state.checked} of ${
        BT.util.pluralize(state.of, 'follow')}…${
        checking ? ` <span class="faint">${esc(BT.util.truncate(checking.name, 34))}</span>` : ''}`;
    }
    /* The grid below says "could not look" and "nothing is dated ahead" in full
       sentences of its own, so this line never repeats them. It adds only what
       the grid cannot say for itself: the counts.

       THE SCANNED FIGURE IS PRINTED WHETHER OR NOT ANYTHING SURVIVED, and that
       is the whole reason this line still exists after the filter narrowed. A
       screen showing two cards, or none, looks broken; the same screen saying
       it read 213 catalogued works to find them does not. It is the difference
       between "this feature is not working" and "the catalogue has nothing".

       The failure note is the exception, and it is the one that matters most —
       "nothing is dated ahead of today" while three follows went unchecked is a
       claim we are not entitled to make, so the shortfall is stated next to it
       whether or not there are any rows. */
    const bits = [];
    if (state.shown) {
      bits.push(BT.util.pluralize(state.shown, 'work') + ' dated after today');
      if (state.total > state.shown) bits.push(`showing ${state.shown} of ${state.total}`);
    }
    if (state.ok) {
      bits.push(`scanned ${BT.util.pluralize(state.scanned.size, 'catalogued work')} across ${
        BT.util.pluralize(state.ok, 'follow')}`);
    }
    /* Both halves of what the year-only band did, because they are different
       facts and only one of them is visible on screen. `maybe` is countable by
       looking; `dropped` is a card that WAS there and is not any more, and a
       row that vanishes without a word is the failure this section has been
       burned by before. */
    if (state.maybe) bits.push(`${state.maybe} year-only`);
    if (state.sharpened) {
      bits.push(`${state.sharpened} sharpened by Google Books${
        state.dropped ? `, ${state.dropped} of them already out` : ''}`);
    }
    if (state.failed && state.ok) {
      bits.push(`<span class="fbad">${esc(BT.util.pluralize(state.failed, 'follow'))
        } could not be checked</span>`);
    }
    return bits.join(' · ');
  }

  function paintStrip(state) {
    if (!scaffold()) return;
    const grid = document.getElementById('fgrid');
    if (!grid) return;

    /* SOONEST FIRST — this is a list of what is coming, so it reads forwards.
       That is the opposite of the newest-first order this grid used when it was
       a backlist strip, and the reversal is the point rather than a detail.

       BUT CERTAINTY OUTRANKS DATE, and the reason is arithmetic rather than
       taste. A bare year anchors to January 1st (01-util.js sorts vaguer
       precisions to the START of their window), so every undecidable
       current-year row carries a sort key months BEHIND today while every
       genuinely future row carries one ahead of it. Sorting on the key alone
       would therefore put all the "we cannot tell" cards above all the "we
       know exactly" cards — burying the best information under the worst,
       every time. So certain dates come first, ascending, and the year-only
       band follows as a group.

       Title breaks the tie because within that band every key is identical
       (January 1st of this year, for all of them) and an unstable sort would
       otherwise let the cards shuffle on every repaint. */
    const band = r => (r.verdict === 'future' ? 0 : 1);
    const all = [...state.seen.values()].sort((a, b) =>
      band(a) - band(b)
      || (a.release.sortKey - b.release.sortKey)
      || String(a.w.title).localeCompare(String(b.w.title)));
    const rows = all.slice(0, STRIP_MAX);
    state.total = all.length;
    state.shown = rows.length;
    stripWorks = new Set(rows.map(r => r.w.workId));

    let html;
    if (rows.length) {
      html = `<div class="grid">${rows.map(card).join('')}</div>`;
    } else if (!state.done) {
      html = BT.ui.skeletonGrid(8);
    } else if (!state.ok && state.failed) {
      /* Nobody answered. "We could not look" and "there is nothing new" are
         different facts and this is the one place the difference is visible.
         05-net's sentences already end in a full stop, so one is trimmed rather
         than doubled — the joined string read "…what it already has.. This is"
         on every outage. */
      const why = String((state.lastErr && state.lastErr.message) || 'Open Library is not answering')
        .replace(/\s*\.\s*$/, '');
      html = BT.ui.errorBox('Could not check your follows',
        `${why}. This is not a statement about whether anything new exists — `
        + 'only that we could not look.');
    } else {
      /* AN EMPTY LIST IS THE ANSWER, AND IT HAS TO SAY SO IN FULL SENTENCES.
         Open Library catalogues books that exist; it has no forthcoming-title
         concept, so "nothing your follows have is dated after today" is the
         ordinary result rather than the broken one. Measured: page one of
         sixty works for each of six large-catalogue authors contained ZERO
         works dated beyond the current year.

         So the scanned figure is repeated here rather than left to the line
         above. An empty panel that also says it read 213 records is visibly a
         question that was asked and answered; an empty panel that says nothing
         is indistinguishable from a feature that failed to load, and the reader
         has no way to tell which they are looking at. This is the whole reason
         the strip must not be widened to look busier. */
      html = BT.ui.emptyState({
        title: 'Nothing from your follows is dated ahead of today',
        body: `Open Library has no concept of a forthcoming book — it catalogues books
          that already exist, and it records years rather than dates. So this list is
          usually short and often empty, and empty here means we looked and found
          nothing dated after today. We read ${
            esc(BT.util.pluralize(state.scanned.size, 'catalogued work'))} across ${
            esc(BT.util.pluralize(state.ok, 'follow'))}.`,
      });
    }

    /* Skip a write that would change nothing. Without it every follow that
       answers with only duplicates would still re-create the covers. */
    const sig = rows.length + ':' + html.length;
    if (grid.dataset.sig === sig) { paintProgress(state, null); return; }
    grid.dataset.sig = sig;
    grid.innerHTML = html;
    paintProgress(state, null);
  }

  /* THE DATE IS RENDERED IN THE APP'S OWN GRAMMAR, not paraphrased into a
     sentence. BT.ui.dateField draws a fixed ten-slot monospace field and
     HATCHES every segment the record cannot support, so a bare year reads

         2026-▨▨-▨▨      the year is stored; the month and day do not exist

     which is the honest picture and needs no adjective. The old card said
     "recorded 2026" precisely because it could not make that distinction; now
     that this strip claims a FUTURE date, the distinction is the whole point
     and hand-rolling it here — instead of using the one component that owns it
     — is how a month-precision book eventually renders a day. */
  function card(r) {
    const w = r.w;
    const uid = 'book:openlibrary:' + w.workId;
    const imprint = w.publishers.length ? BT.util.truncate(w.publishers[0], 28) : '';
    const maybe = r.verdict === 'maybe';

    /* A countdown ONLY for a real day. `relativeDays` against a bare year would
       count down to January 1st — a date the record never stated and which,
       for every row in the year-only band, is already months behind us. The
       hatched field says "we do not know when" perfectly well on its own. */
    const soon = (!maybe && r.release.precision === 'day')
      ? BT.util.relativeDays(BT.util.daysUntil(r.release.sortKey))
      : '';

    return `<div class="card${r.owned ? ' is-mine' : ''}${maybe ? ' is-approx' : ''}" data-uid="${esc(uid)}">
      ${/* The shape BT.ui.poster reads, and no more: a cover id is all a
            search doc carries. `ids` is present-but-empty on purpose, so
            posterUrl's ISBN and edition-OLID fallbacks find nothing and fall
            through to the generated block instead of firing a request that
            cannot succeed. */''}
      ${BT.ui.poster({ title: w.title, images: { coverId: w.coverId }, ids: {} })}
      <div class="ct">${esc(w.title)}</div>
      <div class="cs">
        ${BT.ui.dateField(r.release)}
        ${soon ? `<span class="csoon">${esc(soon)}</span>` : ''}
        ${r.owned ? '<span class="cmine">✓ In your library</span>' : ''}
      </div>
      ${/* The hatch says the month is missing; this says what that MEANS for
            the promise the heading just made. Two different jobs, and the
            second one is the reason this row survived the filter at all —
            without it a card reading 2026-▨▨-▨▨ under "publishing after today"
            is a flat claim that the book has not come out yet, which we do not
            know. `sharp` marks the ones Google looked at and could not improve,
            so a reader with a key can tell "not checked" from "checked, and the
            catalogue simply does not say". */''}
      ${maybe ? `<div class="capprox">${esc(vagueLabel(r.release))} — may already be out${
        r.sharp ? '; Google Books has no finer date either' : ''}</div>` : ''}
      <div class="why-line">via <b>${esc(r.via.name)}</b>${
        r.approximate
          ? ` — approximate match${imprint ? ', catalogued as ' + esc(imprint) : ''}`
          : ''}</div>
    </div>`;
  }

  /* WHICH grain is missing, read off the release rather than assumed to be the
     year. Almost every 'maybe' is a bare year, but not all of them: a Google
     Books date of '2026-08' lands in the CURRENT month, which still straddles
     today and is still undecidable — and calling that "year only" when the card
     beside it plainly shows a month would read as a bug in BookTrak rather than
     as a gap in the record. */
  function vagueLabel(release) {
    const p = (release && release.precision) || 'unknown';
    if (p === 'month' || p === 'quarter') return 'No day recorded';
    return 'Year only';
  }

  /* ══ OPENING A CARD ════════════════════════════════════════════════════
     NOTHING IS WRITTEN HERE. That is the fix: this used to be onAdd(), and it
     called BT.ui.addItem, so browsing an author's catalogue silently filled the
     library with `want` entries.

     No stub is handed over either, and that is deliberate rather than lazy.
     56-inspector already knows how to show a book it does not hold — see
     fetchTransient() and BT.openlibrary.lookupUid() — and what it fetches is
     the WORK record, which carries the description and subjects that the lean
     search doc behind this card does not. So one deliberate tap costs one
     deliberate request and buys a better pane than the shortcut would have,
     with an explicit "Add to library" button on it instead of an add that
     already happened. 61-view-search's row tap makes exactly the same trade. */
  function onOpen(uid) {
    if (!uid) return;
    if (!BT.inspector || typeof BT.inspector.show !== 'function') return;
    BT.inspector.show(uid);
  }

  /* ── The one write from elsewhere this screen has to hear ──────────────
     "Add to library" lives in 56-inspector, not here, and it ends in
     BT.router.resolve() — which re-renders this page from the shelves and
     would drop the card the reader just added. So the work id is remembered
     (see `addedHere`) and the card on screen is corrected in place, which also
     means the marker appears immediately rather than after the re-render.

     Subscribed ONCE at module scope. This module is a singleton whose render()
     runs again on every visit, and subscribing there would stack one more copy
     of this handler per visit — the same failure the `view.onclick =`
     assignment above avoids. */
  function subscribeOnce() {
    if (subscribed || !BT.repo || typeof BT.repo.subscribe !== 'function') return;
    subscribed = true;
    BT.repo.subscribe((ev, detail) => {
      if (!detail) return;

      /* Undo. BT.ui.addItem's toast offers it and it lands here, so a work left
         in `addedHere` would leave the card claiming "In your library" for a
         book that is no longer in it — the same untruth in the other direction.
         The uid grammar is the M2 contract (`book:openlibrary:{OLID}`), and
         BT.util.olid reads the id out of it wherever it sits; a `book:isbn:`
         uid yields '' and deletes nothing. */
      if (ev === 'item:delete') { addedHere.delete(BT.util.olid(detail.uid || '')); return; }

      if (ev !== 'item:put') return;
      const work = (detail.ids && detail.ids.olWork) || '';
      /* Only books that are on this strip. Every write anywhere in the app
         emits this — a rating, a status change, a background hydrate — and
         marking a card off the back of one would be a claim this screen has no
         evidence for. */
      if (!work || !stripWorks.has(work)) return;
      addedHere.add(work);
      markCardOwned('book:openlibrary:' + work);
    });
  }

  function markCardOwned(uid) {
    /* Scanned and compared rather than selected with an attribute selector,
       for the same reason markButtons() does it: a uid is
       `book:openlibrary:OL27482W` and a colon is a combinator in CSS, so a
       selector built from one silently matches nothing. */
    for (const el of document.querySelectorAll('#fgrid [data-uid]')) {
      if (el.dataset.uid !== uid || el.classList.contains('is-mine')) continue;
      el.classList.add('is-mine');
      const cs = el.querySelector('.cs');
      if (cs) cs.insertAdjacentHTML('beforeend', '<span class="cmine">✓ In your library</span>');
    }
    /* The DOM no longer matches what paintStrip recorded, so the next real
       paint must not skip itself. Same rule as 61-view-search's Add swap. */
    const grid = document.getElementById('fgrid');
    if (grid) grid.dataset.sig = '';
  }

  return { render };
})();
