/* ══════════════════════════════════════════════════════════════════════════
   Pane 3 — the inspector.

   Selecting a book anywhere fills this pane. It is the app's only blurred
   surface: the sheet frosts over a wash taken from the book's own cloth
   colour, which is what makes Marginalia read as depth rather than as a flat
   dark palette. Everything else in the app is opaque or plainly translucent,
   because a blur behind every row is the first thing to stutter.

   It is also the app's only EDIT surface — status, genre, progress, ownership,
   the rating, the notes and the follow toggles are all written from here — and
   those two facts fight each other. Every control in this file used to rebuild
   the blurred sheet under the reader's thumb, so the rules below are not
   micro-optimisation: `paint()` replaces the CONTENTS of `.sheet` and never
   `.sheet` itself, and skips a byte-identical rebuild outright. See the comment
   on `invalidate`.

   Three of those controls arrived after the pane was finished, and each one
   respects the rule in the same way: the status segment, the genre picker and
   the follow pills all redraw the ONE block they changed and leave the rest of
   the sheet — and the backdrop-filtered layer behind it — untouched.

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

  /* ══ THE READING LADDER ═══════════════════════════════════════════════════
     Five rungs, and the second one is the whole reason this list is not the
     four it started as:

       want      you do not own it and would like to read it — a wishlist
       have      it is on the shelf and you have not started it
       reading   in progress
       finished  done
       dropped   abandoned

     `want` and `have` were one rung for the first three milestones, and that
     collapse is what made the shelf unusable: a physical library is mostly
     books you own and have not opened, and filing them under the same word as
     the ones you have not bought yet means the wishlist can never be read as a
     wishlist. Scanning a barcode defaults to `have` for exactly this reason —
     if the book is in your hand, you own it — while search-adding stays `want`.
     Neither of those decisions is made here; 39-scan and 61-view-search own
     them. This file only has to draw all five and never reorder them.

     Do NOT confuse this with `user.pile` (null | 'sell' | 'sold'), which is the
     OWNERSHIP DISPOSITION axis drawn a few blocks further down. A book can be
     `finished` and `sell` at the same time. See the block above PILES.

     Kept as a literal rather than read from a shared constant because that is
     how the rest of the app spells it too; if it ever moves to 00-config, this
     is one of five places that has to follow. STATUS_WORD lives in BT.ui so the
     table, the tree and this pane cannot disagree about the noun — read through
     it, and only fall back when it has not learned the new rung yet. */
  const STATUS_LADDER = ['want', 'have', 'reading', 'finished', 'dropped'];

  /* "Have", not "Owned" and not "TBR". "Owned" invites the reading of pile as
     the same axis, and an initialism has to be learned. */
  const STATUS_FALLBACK = {
    want: 'Want', have: 'Have', reading: 'Reading',
    finished: 'Finished', dropped: 'Dropped',
  };
  const statusWord = s =>
    (BT.ui.STATUS_WORD && BT.ui.STATUS_WORD[s]) || STATUS_FALLBACK[s] || s;

  /* MIGRATION, and the rule is: read forgivingly, write nothing.

     Every record written before `have` existed carries one of the original four,
     and all four are still on the ladder — so there is no migration to run and
     none is run. What this guards is the other case: a record with no
     `user.status` at all (a hand-edited import, a sync from a future ladder).
     Those read as `want`, which leaves the segment control showing something
     rather than five unpressed buttons and no clue what is stored.

     It is display-only and is never written back. Rewriting somebody's shelf so
     the UI looks tidy is a silent data edit they never asked for, and `want` is
     the safest possible guess to put in front of them: it claims the least. */
  const statusOf = u => {
    const s = u && u.status;
    return STATUS_LADDER.indexOf(s) >= 0 ? s : 'want';
  };

  async function show(uid, opts) {
    opts = opts || {};
    currentUid = uid;
    let item = await BT.repo.getItem(uid);

    if (!item) {
      /* Not on the shelves — a stale link, a row from a search that was never
         added, or a card on the Following strip, which is the one that made
         this the ORDINARY path rather than the rare one: every tap over there
         lands here, because a tap must show the book rather than silently add
         it. Fetch read-only so the pane still works, and offer to add it. */
      blank(loadingBody());
      try { item = await fetchTransient(uid); }
      catch (e) { blank(BT.ui.errorBox('Could not load this book', e.message || String(e))); return; }
      /* The reader moved on while that request was in flight. Without this the
         older answer paints over the newer one and the pane shows a book the
         reader is no longer pointing at — which used to need a stale link and
         a fast finger, and now needs only two taps on a grid of results. */
      if (currentUid !== uid) return;
      if (!item) {
        blank(BT.ui.emptyState({
          title: 'Not found',
          /* Not "there is no catalogue client on the page yet" — there is, and
             a message that blames a missing module for a record Open Library
             merged away sends the reader to look for a bug that is not there.
             Merges are constant in a volunteer catalogue: a work id from a
             search result four minutes old can already be a redirect. */
          body: 'Nothing on your shelves has that id, and Open Library has no record under it either — catalogue records get merged and renumbered, so a link or a search result can go stale.',
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
        /* Chained rather than fired alongside, and that ordering is the whole
           reason this is not two independent calls. Open Library's hydrate may
           itself supply a better date, and the Google lookup decides whether to
           spend a request by reading the date on the record — asked in parallel
           it would read the stale one and buy a month we had just been given
           for free. Sequential also means the two writes cannot interleave and
           lose each other's fields. */
        return upgradeDate(fresh || item, uid);
      }).then(better => {
        if (better && currentUid === uid) paint(better);
      }).catch(() => {});
    }
    if (!opts.silent) markSelected(uid);
  }

  /* ── LAZY DATE ENRICHMENT ────────────────────────────────────────────────
     Open Library is year-granular and cannot be made otherwise: `search.json`
     answers `first_publish_year` and nothing finer, and an edition's
     `publish_date` is free text that is almost always a bare year. Opening a
     book is the moment somebody actually wants to know when it came out, so it
     is the moment we are willing to spend a request finding out.

     ONE BOOK, ON DEMAND, AND NEVER ON BOOT. Google's free tier is ~1,000
     requests a day against a key that belongs to the user and nobody else;
     walking a 500-book library at startup would spend half of somebody's daily
     allowance on books they did not open. 25-googlebooks.js declines the call
     outright when there is no key, when the record already states a month or a
     day, when the reader has corrected the date by hand, or when we asked
     recently and Google had nothing better — so the ordinary case for an
     already-enriched or keyless library is zero requests and no write.

     Feature-detected, like every other adapter seam in this file. A bare
     `BT.googlebooks.upgradeItemDate(...)` would be a TypeError that takes out
     the pane on any page where the script is not loaded, in service of a
     feature whose honest answer is "off". */
  async function upgradeDate(item, uid) {
    const gb = BT.googlebooks;
    if (!item || !gb || typeof gb.upgradeItemDate !== 'function') return null;
    const merged = await gb.upgradeItemDate(item);
    /* A non-null answer always deserves the write, even when no better date
       was found: the check stamp inside it is what stops the next open of this
       pane asking Google the same question again. Quiet, because this is a
       background refresh and not the reader editing anything — a loud write
       would rebuild the tree and any open list for a field nobody touched. */
    if (!merged) return null;
    await BT.repo.putItemQuiet(merged);
    return (currentUid === uid) ? merged : null;
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

      <div class="iby">${authorLine(item)}</div>

      <div class="isub">
        ${BT.ui.dateField(rel)}
        ${total ? `<span>· ${esc(BT.util.pagesStr(total))}</span>` : ''}
      </div>

      ${item._transient ? `
      <div class="blk"><button class="btn btn--primary" data-act="add">Add to library</button></div>` : `
      <div class="blk">
        <div class="blk-h">Status <span class="why">want is a wishlist · have is on the shelf</span></div>
        <div class="seg seg--wrap" role="group" aria-label="Reading status">
          ${STATUS_LADDER.map(s =>
            `<button type="button" data-status="${s}" aria-pressed="${statusOf(u) === s}">${esc(statusWord(s))}</button>`).join('')}
        </div>
      </div>

      ${genreBlock(item)}

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
          <dt>Source</dt><dd>${dateSourceLine(item, rel)}</dd>
        </dl>
        ${driftHistory(rel)}
      </div>

      ${editionBlock(item)}

      ${item._transient ? '' : `
      <div class="blk">
        <button class="btn btn--ghost btn--danger" data-act="remove">Remove from library</button>
      </div>`}
    `;

    /* THE NOTES FIELD IS CARRIED ACROSS THE REBUILD, and this is the only
       control in the pane that needs it — see keepNotes below. Read BEFORE the
       innerHTML write that is about to destroy it. */
    const held = keepNotes(host, item);

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

    const carried = restoreNotes(host, held);

    /* Cloth colours move as custom properties on the surviving element. */
    const wash = host.querySelector('.wash');
    if (wash) {
      const [a, b] = BT.ui.hues(item.title);
      wash.style.setProperty('--a', a);
      wash.style.setProperty('--b', b);
    }

    lastUid = item.uid;
    /* `body` is what was WRITTEN; if the notes were carried back over the top
       of it, that string is no longer what is on screen. Recording it would let
       the next paint compare against a render that never existed and skip
       itself — the same trap invalidate() exists for everywhere else. */
    lastBody = carried ? '' : body;
    wire(item);
  }

  /* ══ THE NOTES FIELD SURVIVES A REPAINT ═══════════════════════════════════
     Every other control here draws a value the database already holds, so
     rebuilding the sheet costs nothing. `#inspNotes` is the exception and the
     only one: it holds text the reader has TYPED and the app has not written
     yet — the save is debounced 500ms so that a paragraph is not thirty
     writes — and an innerHTML rebuild replaces it with a textarea
     re-initialised from the older stored value.

     THAT WAS DESTROYING TYPING, not merely interrupting it. paint() runs a
     second time whenever hydrate answers, and 50-ui-core fires hydrate
     unawaited on every add and every open — an Open Library round trip is one
     to three seconds, which is exactly the window in which somebody who has
     just added a book is writing about it. MEASURED on this build: type
     `ABCDEFGHIJKL` into the notes of a freshly-added book, let the hydrate land
     mid-way, and both the screen and the database end up holding `EFGHIJKL`.
     The first four characters are gone with nothing on screen to say so — the
     old textarea is detached with the caret still in it, its debounce saves the
     pre-repaint text, and the NEW textarea's debounce then writes over that
     with only what was typed after the swap.

     Restoring is safe against a legitimate change from elsewhere, because this
     pane deliberately does not repaint on `item:put` (see init()) — nothing but
     our own paint can reach here while the reader is typing, so the value in
     the box is always the newer of the two.

     The selection is carried too. Restoring the text and dropping the caret to
     the end would still lose the reader's place mid-sentence, which is the same
     failure one keystroke smaller. */
  function keepNotes(host, item) {
    const ta = host.querySelector('#inspNotes');
    if (!ta || lastUid !== item.uid) return null;
    const stored = ((item.user || {}).notes) || '';
    const focused = document.activeElement === ta;
    /* TWO reasons to carry, and the second one is not cosmetic. Unsaved text is
       the data-loss case above. A FOCUSED field is the other half of it: even
       when the debounce has already saved every character, replacing the
       element the reader is typing into drops the caret and the focus, so the
       next keystroke goes nowhere and the sentence is abandoned mid-word. */
    if (!focused && ta.value === stored) return null;
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd, focused };
  }

  /* -> true when something was actually carried across, which is what tells
     paint() the recorded signature would be a lie. */
  function restoreNotes(host, held) {
    if (!held) return false;
    const ta = host.querySelector('#inspNotes');
    if (!ta) return false;
    const rewritten = ta.value !== held.value;
    if (rewritten) ta.value = held.value;
    if (held.focused) {
      try { ta.focus(); ta.setSelectionRange(held.start, held.end); } catch (_) {}
    }
    /* Only a REWRITE makes the signature a lie; putting the caret back does
       not change a byte of the markup paint() recorded. */
    return rewritten;
  }

  /* Authors, not "credits". Three is the cap: an anthology can list twenty
     contributors and the fourth name has already stopped identifying the book.
     A missing author is stated rather than left blank — a large share of Open
     Library's older records genuinely have none, and an empty slot reads as a
     rendering fault.

     Each name now carries a Follow pill, and WHERE it sits is the actual fix.
     The complaint that produced this was "I couldn't figure out how to follow
     an author", not "following does not work": #/people existed and nobody
     found it. A follow control that lives only on a page called Following can
     only be used by someone who has already followed something. So it goes
     where the author's name is — here, in search results, and on the Following
     page — and this is the copy of it that most people will meet first.

     The separator is a middle dot rather than a comma because the units are
     name-plus-control, and a comma sitting between a button and the next name
     reads as belonging to the button. */
  function authorLine(item) {
    const list = (item.authors || [])
      .map(a => (typeof a === 'string' ? { name: a, olid: '' } : a))
      .filter(a => a && (a.name || a.olid));
    if (!list.length) return '<span class="faint">Author not recorded</span>';

    const shown = list.slice(0, 3);
    const more = list.length - shown.length;
    const units = shown.map(a => {
      /* A work record gives author KEYS and never author NAMES (see the block
         above authorsFromKeys in 38-normalize), so an olid with no name is an
         ordinary state and not a fault. The olid is shown rather than a blank,
         because it is still enough to follow by — which is the point. */
      const name = a.name || (a.olid ? `Author ${a.olid}` : '');
      return `<span class="byname">${esc(name)}${followPill(BT.util.olid(a.olid || a.id || ''), a.name || name)}</span>`;
    });

    return units.join('<span class="bysep">·</span>')
      + (more > 0 ? ` <span class="faint">+${more} more</span>` : '');
  }

  /* ══ FOLLOW ═══════════════════════════════════════════════════════════════
     ── SEAM ────────────────────────────────────────────────────────────────
     70-follows.js owns everything about a follow except where the button is
     drawn. ONE function is asked for, and it is feature-detected, because this
     pane has to survive that file being absent or having failed to parse — a
     bare BT.follows.toggleAuthor(...) inside the one shared click handler would
     take the status segment, the genre picker, the rating and the notes down
     with it:

       BT.follows.toggleAuthor(olid, name)   -> follow/unfollow by OLID

     When it is absent the pills are simply not emitted. An affordance whose
     only possible outcome is an apology is worse than no affordance.

     AUTHORS ONLY. This file used to draw a second pill on the Publisher row of
     the edition dl and call `BT.follows.togglePublisher`. Publisher following
     was removed ("lets drop publisher support as i think it's a bit too
     shoehorned in"), so that call site was left inert ONLY because the function
     it named no longer exists — the pill was suppressed by an absence rather
     than by a decision. That is a live wire: the day anything reintroduces a
     `togglePublisher` under any meaning, a Follow button reappears on every
     edition pane in the app with nobody having asked for it. The branches are
     gone instead, so the removal cannot be undone by accident. Publisher is
     still SHOWN in the dl below — it is a fact about the copy you hold, and
     that never stopped being useful. */
  const followsReady = () =>
    !!(BT.follows && typeof BT.follows.toggleAuthor === 'function');

  /* AUTHORS ARE KEYED ON OLID AND NEVER ON NAME, and that is a verified rule
     rather than a preference. Open Library's `search.json?author=gwendolyn+kiste`
     comes back full of Laird Barron's books: the name filter is fuzzy, and a
     follow built on it would report somebody else's new releases as yours. An
     author with no OLID on this record therefore gets NO pill and a one-word
     reason, which is the honest answer — following them would produce a feed
     that is confidently wrong rather than empty.

     `aria-pressed` starts at "false" for everyone and is corrected in place by
     refreshFollowState. It cannot be baked into the markup: the follow list is
     an IndexedDB read, so it is not available at the moment the string is
     built, and blocking the whole paint on it to save one attribute write would
     put a database round trip in front of every book you click. */
  function followPill(key, name) {
    if (!followsReady()) return '';
    if (!key) {
      return ' <span class="fwna" title="Open Library has no author id on this record. Following by name matches the wrong writer often enough to be useless, so it is not offered.">no id</span>';
    }
    const title = 'Follow this author. New works appearing in their Open Library catalogue turn up in Alerts.';
    return ` <button type="button" class="fwbtn" aria-pressed="false"`
      + ` data-follow="1" data-fw-type="author" data-fw-key="${esc(key)}"`
      + ` data-fw-name="${esc(name || '')}" title="${esc(title)}">Follow</button>`;
  }

  /* Read from BT.repo, not from BT.follows.

     The id format (`author:openlibrary:OL1394865A`) belongs to 70-follows.js,
     and rebuilding it here to ask isFollowing() would put a second copy of that
     rule in a file with no reason to know it — the day the two spellings drift
     every pill in the pane silently reads "Follow" for an author you follow.
     Matching on identity cannot drift: an OLID is an OLID.

     `type` is still read off the row and still has to match, even though
     'author' is the only kind this pane draws. A publisher row can arrive from
     a device on an older build at any moment (70-follows.js retires them on
     boot, and a sync can land one after that has run), and dropping the test
     would let a publisher slug that happened to fold to the same string light
     up an author's pill. */
  function isFollowed(rows, key) {
    const want = BT.util.olid(key);
    if (!want) return false;
    for (const f of rows || []) {
      if (!f || f.type !== 'author') continue;
      const got = BT.util.olid(f.sourceId || '') || BT.util.olid(f.id || '');
      if (got && got === want) return true;
    }
    return false;
  }

  /* Corrects every pill in the pane in place. Never repaints: rebuilding the
     whole sheet to flip one attribute is the exact stutter this file exists to
     avoid.

     `uid` is the book the caller was looking at. The follow list is an async
     read, so by the time it lands the reader may have clicked a different book
     and the whole sheet may have been rewritten — hence the re-query after the
     await as well as the guard. */
  async function refreshFollowState(uid) {
    const host = el();
    if (!host || !host.querySelector('[data-follow]')) return;
    let rows = [];
    try { rows = await BT.repo.allFollows(); }
    catch (e) { console.warn('[inspector] could not read the follow list', e); return; }
    if (uid && currentUid !== uid) return;

    let changed = false;
    for (const b of host.querySelectorAll('[data-follow]')) {
      const on = isFollowed(rows, b.dataset.fwKey);
      if (b.getAttribute('aria-pressed') === String(on)) continue;
      b.setAttribute('aria-pressed', String(on));
      /* The word changes, not just the colour. "Following" as a state and
         "Follow" as an invitation are different sentences, and a pill that only
         changed hue would be unreadable to anyone who cannot see the hue. */
      b.textContent = on ? 'Following' : 'Follow';
      changed = true;
    }
    /* The DOM no longer matches the string paint() recorded. Without this a
       later repaint compares against a signature captured before these writes
       and decides, wrongly, that nothing needs redrawing. */
    if (changed) invalidate();
  }

  async function toggleFollow(btn) {
    const f = BT.follows;
    if (!followsReady()) return;
    const key = btn.dataset.fwKey;
    const name = btn.dataset.fwName || '';
    try {
      await f.toggleAuthor(key, name);
    } catch (e) {
      BT.ui.toast((e && e.message) || 'Could not change that follow.', { bad: true });
      return;
    }
    /* 12-repo emits `follow:change` on every write, and init() listens for it —
       so the pills are usually corrected before this line runs. It is called
       anyway because a follows module that batches or defers its write would
       otherwise leave the button the reader just pressed saying the old word. */
    await refreshFollowState(currentUid);
  }

  /* ══ GENRE ════════════════════════════════════════════════════════════════
     The buckets are DERIVED, by mapping Open Library's subjects through
     BT.GENRE_RULES — and those subjects are whatever fell out of a MARC record,
     an Internet Archive ingest or a bestseller-list scrape. The result is wrong
     often enough that a reader must be able to say so, which is what this is.

     THE CHIP ROW IS NOT JUST THE BUILT-IN TWELVE. BT.GENRE_BUCKETS is an
     accessor that answers with the built-ins plus every genre the user added in
     Settings, so a custom genre is offered here automatically — and a
     manual-only one (a custom genre given no keywords, which therefore never
     matches a subject string) can ONLY ever be applied from this row. That is
     the whole delivery mechanism for half the feature, and it needs no code
     here beyond reading the same array this always read.

     THE ONE DETAIL THAT MATTERS is where the correction is stored. Writing
     `item.genres` alone lasts exactly until the next background refresh: 38-
     normalize's mergeItem takes the fresh payload's buckets over the stored
     ones, so the reader's fix would vanish silently, hours later, with nothing
     on screen to connect the two events. Overrides are the mechanism that
     already exists for this — mergeItem reads `meta.manualOverrides` FIRST,
     carries it across untouched, and replays every path in it over the merged
     record as the last thing it does. So the fix is written twice, to the live
     field and to the override ledger, and the ledger is what makes it permanent.

     What this deliberately does NOT touch is `rec.terms`. The `g:` terms are
     one input to the recommender among two dozen subject terms, they are
     rebuilt from the payload on every hydrate, and a bucket is a far coarser
     taste signal than 'Ecology in literature' anyway. Correcting the chip is a
     statement about how the book is FILED, not a claim about what it is like. */
  function genreBlock(item) {
    return `
      <div class="blk">
        <div class="blk-h">Genre <span class="why">guessed from catalogue subjects</span></div>
        <div class="gpick" id="genreBody">${genreBody(item)}</div>
      </div>`;
  }

  function genreBody(item) {
    const on = new Set(BT.ui.genresOf(item));
    const fixed = !!(((item.meta || {}).manualOverrides || {}).genres);
    return BT.GENRE_BUCKETS.map(g =>
      `<button type="button" class="gchip tag ${esc(g)}" data-genre="${esc(g)}"
         aria-pressed="${on.has(g)}">${esc(BT.GENRE_LABELS[g] || g)}</button>`).join('')
      + (fixed
        ? '<div class="gnote">Yours. A metadata refresh will not put it back.</div>'
        : '');
  }

  /* The membership test is what keeps a stale chip from writing a dead id: the
     Settings screen can remove a custom genre while this pane is open, and the
     chip for it is still in the DOM until something re-renders. Reading the
     accessor rather than a captured copy means the removed genre is simply no
     longer a legal answer. */
  async function toggleGenre(uid, id) {
    if (BT.GENRE_BUCKETS.indexOf(id) < 0) return;
    const cur = await BT.repo.getItem(uid);
    if (!cur) return;

    const on = new Set(BT.ui.genresOf(cur));
    if (id === 'general') {
      /* 'general' is the residue — the bucket a book lands in when nothing else
         fit — so it is EXCLUSIVE. "General and Romance" is not a classification
         anyone can explain, and 38-normalize refuses to produce it for the same
         reason (there is no `general` rule in the table; you can only fall into
         it). Picking it here means "none of the other six". */
      on.clear();
      on.add('general');
    } else {
      if (on.has(id)) on.delete(id); else on.add(id);
      on.delete('general');
      /* Never empty. 12-repo builds the multiEntry by_genre index from
         idx.genreIds, and an empty array is skipped by that index entirely — the
         book would vanish from every genre count in the tree while still showing
         a chip on its own row. Deselecting the last bucket falls back to the
         residue, which is what "I cannot classify this" already means. */
      if (!on.size) on.add('general');
    }

    /* BT.GENRE_BUCKETS order, not click order: the chips, the tree and the
       facet counts all read this array, and BT.ui.genreTag draws only the first
       two — so the order the record stores decides which two a row shows. */
    const list = BT.GENRE_BUCKETS.filter(g => on.has(g))
      .map(g => ({ id: g, name: BT.GENRE_LABELS[g] || g, source: 'user' }));

    cur.genres = list;
    const meta = cur.meta || (cur.meta = {});
    /* The path is the plain field name because mergeItem replays overrides with
       setPath, which walks dotted paths — 'genres' is one segment and lands as
       a whole-array assignment. Copied rather than mutated in place so a caller
       still holding the old record does not see its ledger change underneath it,
       the same rule mergeItem follows for `user`. */
    meta.manualOverrides = Object.assign({}, meta.manualOverrides, { genres: list });
    await BT.repo.putItem(cur);   // recomputes idx.genreIds on the way through
    return cur;
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
      /* NEITHER BUTTON IS DRAWN FOR A BOOK THAT IS NOT ON THE SHELVES, and
         `_transient` is how this block learns that — the same guard Status,
         Genre, Progress, Ownership, Yours and Remove all sit behind in paint().
         This was the one block that missed it, on the path the file elsewhere
         calls "the ORDINARY path rather than the rare one": every tap on a
         search result and every tap on a Following card lands here with a
         record that has not been added yet.

         Both buttons failed, differently and silently. "Specify edition" ran
         BT.editions.open on a uid with no stored record, which apologises with
         "That book is no longer on your shelves" — a factually false sentence
         sitting directly under an "Add to library" button. "Scan the copy I
         own" opened the CAMERA, took the barcode off the book in the reader's
         hand and spent an Open Library request on it, then hit
         BT.scan.pinEdition's `if (!item) return null` — which scanPin never
         checks, null being no exception — and repainted the identical pane. No
         message, no write, nothing said.

         This file's own rule: "An affordance whose only possible outcome is an
         excuse is worse than no affordance." Add the book first and both
         buttons appear, which is the honest order anyway — you cannot say which
         copy you own of a book you have not said you own. */
      const pinnable = !item._transient;
      return `
        <div class="blk">
          <div class="blk-h">Edition <span class="why">a work, not a copy</span></div>
          <div class="muted" style="font-size:var(--bt-fs-mini);line-height:1.5">
            Edition not specified. Printings of the same book disagree about
            page count, cover, publisher and ISBN, so none of those is claimed
            here until you say which one is on your shelf.
          </div>
          ${pinnable ? `
          <div style="margin-top:var(--bt-space-3);display:flex;gap:var(--bt-space-2);flex-wrap:wrap">
            <button class="btn btn--sm" type="button" data-act="edition">Specify edition</button>
            ${scannerReady() ? '<button class="btn btn--sm" type="button" data-act="scanpin">Scan the copy I own</button>' : ''}
          </div>` : ''}
        </div>`;
    }

    /* PUBLISHER IS A FACT, NOT A FOLLOW. This row used to carry a Follow pill;
       publisher following has been removed, and the value stays because it is
       one of the four things that distinguish the copy on your shelf from the
       work in general. */
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
  /* WHERE THIS DATE CAME FROM, said plainly, because the pane is otherwise
     claiming to know something the reader has good reason to doubt.

     Two audiences, one line. A reader with no key needs to know that "1937"
     is the finest answer available and not a loading state — Open Library is
     year-granular by construction, so the hatched day is permanent and there
     is nothing to wait for. A reader with a key needs to know which service
     supplied the day on screen, so that a date they believe is wrong can be
     argued with at the right catalogue.

     A null `dateSource` reads as Open Library rather than as "unknown", and
     that is a statement of fact rather than a guess: every record written
     before this field existed got its date from the only source the app had
     wired at the time. */
  function dateSourceLine(item, rel) {
    const src = rel.dateSource
      || (rel.sortKey < BT.util.SK_UNKNOWN ? 'openlibrary' : null);
    if (!src) return '<span class="faint">No date on record</span>';
    if (src === 'googlebooks') {
      return 'Google Books <span class="faint">· refined from Open Library’s year</span>';
    }

    const gb = BT.googlebooks;
    /* Only say "year only" when it actually IS year-or-worse. An Open Library
       edition record occasionally does carry a real day — one of The Hobbit's
       twelve editions reads '15 julho 2019' — and captioning that as coarse
       would be wrong in the one place the app is being pedantic about honesty. */
    const coarse = !rel.precision || rel.precision === 'year'
      || rel.precision === 'unknown' || rel.precision === 'tba';
    if (!coarse) return 'Open Library';
    if (gb && gb.enabled && gb.enabled()) {
      const stamp = (item.meta && item.meta.gbDate) || null;
      return stamp && stamp.checkedAt
        ? 'Open Library <span class="faint">· Google Books had nothing finer</span>'
        : 'Open Library <span class="faint">· checking Google Books for a finer date</span>';
    }
    return 'Open Library <span class="faint">· year-granular; add a Google Books key in Settings for exact dates</span>';
  }

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

    /* The RETURN VALUE is checked, not just the throw. pinEdition answers a
       missing record with a bare `return null` — not an exception, so a bare
       try/catch here read a silent no-op as success and repainted the same pane
       after the reader had opened the camera and scanned a barcode. Nothing
       must be able to consume a scan and say nothing. */
    let pinned = null;
    try { pinned = await BT.scan.pinEdition(item.uid, isbn, stub); }
    catch (e) {
      BT.ui.toast((e && e.message) || 'Could not pin that copy.', { bad: true });
      return;
    }
    if (!pinned) {
      BT.ui.toast('That book is not on your shelves any more, so there was nothing to pin it to.', { bad: true });
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
      /* Genre chips and follow pills are read HERE, off the one delegated
         handler, rather than being bound per element the way the progress form
         is. That is what lets both blocks be redrawn with innerHTML and stay
         live without a re-wire — delegation from the pane survives any number of
         replacements of its descendants, and the progress form only binds
         directly because it also owns keydown on its input. */
      const gen = e.target.closest('[data-genre]');
      const fw = e.target.closest('[data-follow]');

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

      if (gen) {
        const fresh = await toggleGenre(item.uid, gen.dataset.genre);
        if (fresh) {
          /* Two nodes, both well inside `.sheet`: the picker itself and the chip
             row under the cover, which is the same buckets read back. Neither is
             the backdrop-filtered element, so this costs two innerHTML writes
             rather than a rebuilt blur layer. */
          const box = document.getElementById('genreBody');
          if (box) box.innerHTML = genreBody(fresh);
          const itype = host.querySelector('.itype');
          if (itype) {
            const rel = fresh.release || {};
            itype.innerHTML = `${BT.ui.genreTag(fresh)}${BT.ui.precisionTag(rel)}${BT.ui.driftBadge(rel)}`;
          }
          invalidate();
          /* The list's Genre column and the tree's genre counts both moved. */
          BT.router.resolve();
        }
      }

      if (fw) await toggleFollow(fw);

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

    /* Fired, not awaited. The pills are already on screen saying "Follow"; this
       only corrects the ones that should say "Following", and holding the paint
       open for a database read to do it would put a round trip in front of every
       book the reader clicks. */
    refreshFollowState(item.uid).catch(e => console.warn('[inspector] follow state', e));

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
        b.setAttribute('aria-pressed', String(b.dataset.status === statusOf(fresh.user)));
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
         filed as `want` OR `have` to `reading`, because recording a position is
         a statement that you have started it — and which of those two shelves
         it was sitting on beforehand makes no difference to that. Never the
         reverse, and never beyond that: reaching the last page must NOT set
         `finished` and must not touch `have`, because
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
      /* The one write this pane DOES listen for, because it is the one that can
         be made somewhere else about something on screen: following the same
         author from #/people, or from a search result behind the drawer, must
         not leave this pane's pill still saying "Follow". It costs one small
         read and a handful of attribute writes — no repaint. */
      if (ev === 'follow:change') {
        refreshFollowState(currentUid).catch(e => console.warn('[inspector] follow state', e));
      }
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
