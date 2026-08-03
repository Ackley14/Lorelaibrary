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
   OPEN LIBRARY HAS NO CONCEPT OF A FORTHCOMING BOOK. There are no street
   dates, no announcements, no "coming soon" — the catalogue records books that
   exist, its dates are YEARS rather than dates, and those years are often
   wrong (The Alloy of Law, published 2011, is recorded as 2001; verified).

   MovieTrak's equivalent screen could honestly promise "projects before they
   have a release date", because TMDB tracks films that have not been made.
   Nothing here can promise that, and the temptation to phrase it as though it
   could is the reason this comment exists. What we can honestly detect is:

       a work is in this author's or publisher's catalogue now
       and it was not there the last time we looked

   which does catch new books, and also catches reprints, translations, boxed
   sets and backlist a volunteer catalogued last week. The copy below says so
   in those words. Anything that renames this strip to "Upcoming" or sorts it
   as a release calendar is making a promise the data cannot keep.

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

  /* How many follows the strip may poll on one visit. FOUR, and it is a rate
     limit rather than a layout choice: Open Library sustains about one request
     a second, so a reader with thirty follows would otherwise wait half a
     minute and spend the whole app's allowance on a strip they scrolled past.
     BT.TTL.search caches each answer for ten minutes, so coming back to this
     screen inside a session costs nothing. */
  const STRIP_FOLLOWS = 4;
  const STRIP_MAX = 12;

  let followSet = new Set();   // ids currently followed — drives every button
  let pubIndex = [];           // publishers already in the library: [{name, n}]
  let ownedWorks = new Set();  // olWork ids on the shelves, for the strip
  let stripStubs = new Map();  // uid -> stub, so a tap adds without re-fetching
  let inflight = null;         // AbortController for the author lookup
  let term = '';
  let touchStart = null;
  let moved = false;           // true when the current gesture is a scroll

  /* ── SEAM ──────────────────────────────────────────────────────────────
     Feature-detected rather than assumed, the same way 61-view-search guards
     its two. A bare call to a module that failed to parse is a TypeError
     inside a debounce callback, where it shows up as a search box that does
     nothing at all and one console line from three keystrokes ago. */
  function missingDeps() {
    const out = [];
    if (!BT.follows || typeof BT.follows.toggleAuthor !== 'function') out.push('70-follows.js');
    if (!BT.openlibrary || typeof BT.openlibrary.searchAuthors !== 'function') out.push('20-openlibrary.js');
    return out;
  }

  async function render(params, q, alive) {
    const view = document.getElementById('view');
    if (!view) return;

    BT.ui.crumb(['Discover', 'Following']);
    BT.ui.paneActions('<a class="btn btn--sm" href="#/search">Search for a book</a>');

    if (inflight) { inflight.abort(); inflight = null; }
    stripStubs = new Map();

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
        ${BT.ui.groupHead('New in your follows’ catalogues')}
        <div class="why-line" style="margin:0 var(--bt-space-6) var(--bt-space-3)">
          Not a release calendar. Open Library has <b>no forthcoming titles</b> and
          records years rather than dates, so this is what has recently appeared in
          or been dated within these catalogues — which catches new books, and also
          catches reprints, translations and backlist catalogued last week.
        </div>
        <div id="fnew">${BT.ui.skeletonGrid(4)}</div>` : ''}`;

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
     authors from one search would mean typing the search three times. */
  async function onClick(e) {
    const fb = e.target.closest('[data-follow]');
    if (fb) { if (suppressTap()) return; await onToggle(fb); return; }

    const un = e.target.closest('[data-unfollow]');
    if (un) { if (suppressTap()) return; await onUnfollow(un.dataset.unfollow); return; }

    const card = e.target.closest('[data-gadd]');
    if (card) { if (suppressTap()) return; await onAdd(card.dataset.gadd); return; }
  }

  /* A tap that followed finger movement is a scroll, not a tap. Browsers fire
     click after a short drag, so on a phone a flick down this page would
     otherwise land on whatever was under the thumb when it lifted — and every
     branch above WRITES: it follows someone, unfollows them, or adds a book.
     Lifted from 61-view-search, where the same gesture was silently adding
     whichever result the scroll ended on. */
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
     What is in these catalogues that is not on the shelves.

     READ-ONLY, AND THAT IS LOAD-BEARING. BT.follows.worksOf() does not touch
     `knownWorkIds`; only the alerts sweep's markChecked() does. If this screen
     recorded what it saw, opening it once would consume the baseline the sweep
     diffs against — so the sweep afterwards would find nothing new and emit
     nothing, for ever, with no error anywhere and a screen that looks perfect.

     SERIALIZED, and capped at STRIP_FOLLOWS. One await per follow in a plain
     loop rather than Promise.all: Open Library sustains about one request a
     second and explicitly asks not to be used as an automated backend, so
     fanning out over the roster is both rude and self-defeating — it would
     spend the budget the reader needs for their next search.

     One failing follow must not empty the screen, so each is caught on its
     own. A failure is not silence, though: if NONE of them answered, that is
     an outage and the strip says so rather than claiming there is nothing new. */
  async function strip(follows, alive) {
    const host = document.getElementById('fnew');
    if (!host) return;

    /* Least-recently-checked first, so successive visits rotate through the
       roster instead of re-asking the same four every time. */
    const picks = follows.slice()
      .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))
      .slice(0, STRIP_FOLLOWS);

    const seen = new Map();
    let ok = 0;
    let lastErr = null;

    for (const f of picks) {
      if (alive && !alive()) return;
      try {
        const res = await BT.follows.worksOf(f, { limit: 30 });
        ok++;
        for (const w of res.works) {
          if (ownedWorks.has(w.workId) || seen.has(w.workId)) continue;
          seen.set(w.workId, { w, via: f, approximate: res.approximate });
          /* Kept so a tap can add the book without spending a second request
             on a doc we are already holding. Stashed here rather than in the
             card renderer, so the map is filled by the loop that owns the data
             instead of as a side effect of building a string. */
          stripStubs.set('book:openlibrary:' + w.workId, w.doc);
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (alive && !alive()) return;

    if (!ok) {
      host.innerHTML = BT.ui.errorBox('Could not check your follows',
        `${(lastErr && lastErr.message) || 'Open Library is not answering'}. This is not a `
        + 'statement about whether anything new exists — only that we could not look.');
      return;
    }

    /* Most recently DATED first, and the field is chosen deliberately:
       max(publish_year) is the newest printing anyone has catalogued, which is
       the closest honest proxy for "this turned up recently".
       first_publish_year is a computed minimum and is often decades wrong.
       Undated works sort last rather than as year zero — Open Library records
       no year at all for plenty of real books, and that is not the same as old. */
    const rows = [...seen.values()]
      .sort((a, b) => (b.w.latestYear || b.w.firstYear || -Infinity)
                    - (a.w.latestYear || a.w.firstYear || -Infinity))
      .slice(0, STRIP_MAX);

    if (!rows.length) {
      host.innerHTML = BT.ui.emptyState({
        title: 'Nothing here you don’t already have',
        body: 'Everything Open Library lists for the follows checked this visit is '
          + 'already on your shelves.',
      });
      return;
    }

    host.innerHTML = `<div class="grid">${rows.map(card).join('')}</div>`;
  }

  function card(r) {
    const w = r.w;
    const uid = 'book:openlibrary:' + w.workId;
    const year = w.latestYear || w.firstYear;
    const imprint = w.publishers.length ? BT.util.truncate(w.publishers[0], 28) : '';
    /* "recorded", never "published". This is the newest year attached to any
       catalogued printing, and Open Library's years are years — not dates, and
       often simply wrong. Naming it as a publication date on a card the reader
       is about to add would put a confident falsehood in front of them. */
    return `<div class="card" data-gadd="${esc(uid)}">
      ${/* The shape BT.ui.poster reads, and no more: a cover id is all a
            search doc carries. `ids` is present-but-empty on purpose, so
            posterUrl's ISBN and edition-OLID fallbacks find nothing and fall
            through to the generated block instead of firing a request that
            cannot succeed. */''}
      ${BT.ui.poster({ title: w.title, images: { coverId: w.coverId }, ids: {} })}
      <div class="ct">${esc(w.title)}</div>
      <div class="cs">
        <span class="mono">${year ? 'recorded ' + esc(String(year)) : 'no year recorded'}</span>
      </div>
      <div class="why-line">via <b>${esc(r.via.name)}</b>${
        r.approximate
          ? ` — approximate match${imprint ? ', catalogued as ' + esc(imprint) : ''}`
          : ''}</div>
    </div>`;
  }

  /* Adding from here is a WANT, not a HAVE. The reader has not got the book —
     that is the whole reason it is on this strip — so it takes BT.ui.addItem's
     default status and the scan path stays the only door that assumes
     ownership. `scope: 'open'` for the same reason search states it: this is a
     work, not a printing, and choosing an edition on the reader's behalf would
     stamp a cover and a page count onto a record they never picked. */
  async function onAdd(uid) {
    const doc = stripStubs.get(uid);
    if (!doc || !BT.normalize || typeof BT.normalize.stubFromSearchDoc !== 'function') return;
    const stub = BT.normalize.stubFromSearchDoc(doc);
    if (!stub || !stub.uid) return;
    try {
      /* addItem resolves the id index first, so a book already on the shelves
         under a scanned ISBN — which our olWork set can miss, because an
         un-hydrated scan has not learnt its work id yet — comes back as the
         existing record with "Already on your shelves" rather than a duplicate. */
      await BT.ui.addItem(stub, { scope: 'open', source: 'follow' });
      BT.inspector.show(stub.uid);
    } catch (e) {
      console.warn('[people] add failed', e);
      BT.ui.toast(`Could not add “${BT.util.truncate(stub.title, 40)}”`, { bad: true });
    }
  }

  return { render };
})();
