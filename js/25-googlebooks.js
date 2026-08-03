/* ══════════════════════════════════════════════════════════════════════════
   Google Books — the ONLY file that knows Google's URL shapes, and the only
   reason the app asks for an API key at all.

   ── WHY THIS EXISTS ───────────────────────────────────────────────────────
   Open Library cannot tell you what day a book came out. Not "usually does
   not" — cannot. Measured against the live API:

     · `search.json` answers `first_publish_year: 2024` and
       `publish_year: [2024, 2025]`. Year granularity, always, with no
       parameter that changes it.
     · An EDITION record carries `publish_date` as a free-text string, and it
       is almost always a bare year. Of twelve editions of The Hobbit, eleven
       read '2020', '1937', '2003'…, exactly one carried a day ('15 julho
       2019', in Portuguese), and some carried `None`.
     · `first_publish_year` is frequently wrong on top of being coarse: The
       Alloy of Law, published 2011, reports 2001.

   So pinning a specific edition and still getting no real date is not a bug
   to be found and fixed. It is the shape of the catalogue. The only way to a
   finer date is to ask somebody else, and Google Books answers properly:

       The Haunting of Velkwood -> '2024-03-05'   (Open Library: 2024)
       Project Hail Mary        -> '2021-05-04'   (Open Library: 2021)
       The Hobbit, 2012 edition -> '2012'         (older titles stay coarse)

   That last line is the honest limit and is not a defect either — Google is
   precise about recent trade publishing and coarse about the backlist, so a
   library of old paperbacks gains almost nothing here and should be told so
   rather than sold a key.

   ── THE KEY GATE IS NOT A THROTTLE, IT IS AN ON/OFF SWITCH ────────────────
   Anonymous Google Books is DEAD. An unauthenticated volumes request answers
   HTTP 429 carrying `"quota_limit_value":"0"` — a quota of zero, not a quota
   we exhausted. Verified from two separate addresses. There is therefore no
   anonymous fallback to degrade to, and every entry point in this file
   returns before building a URL when `BT.config.hasKey('googlebooks')` is
   false. Firing the request anyway would spend a lane slot, a bucket token
   and a retry cycle to be told something already known, and four in a row
   would trip 05-net's circuit breaker for a source that is merely switched
   off. 05-net has the same gate; this one is here so the cost is not paid at
   all, rather than paid and then refunded.

   NOTHING IS BAKED. The key comes from BT.config, which reads it from this
   browser's localStorage and nowhere else. This repository is public: a key
   written into any file here is a key published to the world within one
   commit. There is no constant in this file to "fill in".

   ── EVERYTHING GOES THROUGH BT.net ────────────────────────────────────────
   No fetch() here. 05-net owns the token bucket, the daily request budget
   (BT.NET_POLICY.googlebooks, deliberately well under Google's own 1,000/day
   so enrichment can never be why the user's key gets throttled elsewhere),
   the circuit breaker, the retry policy and the response cache. It also
   strips `key=` before building a cache key, which is what stops a rotated
   key from orphaning every payload already paid for.
   ══════════════════════════════════════════════════════════════════════════ */

BT.googlebooks = (function () {

  const SOURCE = 'googlebooks';

  /* THE GATE. Read through this rather than calling BT.config directly, so
     that "is the Google half switched on" is one question with one answer and
     a future second condition (a user toggle, a region block) has one place
     to land. */
  function enabled() {
    return !!(BT.config && BT.config.hasKey(SOURCE));
  }

  /* ── URL builder ──────────────────────────────────────────────────────────
     `key` is appended by the builder rather than by each call site, because a
     call site that forgets it does not fail loudly — it gets a 429 with a zero
     quota, which reads exactly like being rate limited and sends the next
     person to tune the token bucket. One place to forget is no places.

     BT.net.qs drops empty values, so an absent key would silently produce a
     keyless URL; that is why every caller passes through enabled() first and
     why this throws rather than returning a URL it knows is dead. */
  function url(base, params) {
    const key = BT.config.key(SOURCE);
    if (!key) throw new Error('googlebooks: refusing to build a keyless URL');
    const q = BT.net.qs(Object.assign({}, params || {}, { key }));
    return q ? `${base}?${q}` : base;
  }

  /* Shared net options. Volume records are frozen artefacts like edition
     records, so they take the long TTL — see BT.TTL.gbVolume. */
  function netOpts(opts, ttl) {
    opts = opts || {};
    return {
      ttl: opts.ttl != null ? opts.ttl : ttl,
      noCache: !!opts.fresh,
      cacheOnly: !!opts.cacheOnly,
      staleOk: opts.staleOk,
      signal: opts.signal,
      meta: opts.meta,
    };
  }

  /* Same rule as 20-openlibrary's orNull, and the same reason: "Google has no
     such volume" is an ANSWER and becomes null, while offline / 403 / quota
     stay exceptions so a caller can say "we could not check" instead of "there
     is nothing there". Collapsing both to null is how an outage comes to look
     like a catalogue gap. */
  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (e && e.kind === 'notfound') return null;
      throw e;
    }
  }

  /* THE LEAN FIELD LIST, and the same kind of budget 20-openlibrary.js keeps
     for its search. Google supports partial responses through `fields`, and on
     the query this file actually makes it is worth an order of magnitude:

         20 results, full payload ......  41,827 bytes
         20 results, this list .........   4,873 bytes   (8.6x smaller)

     because a full volume record carries a description paragraph, a category
     list, sale and access blocks, image links and a text snippet — none of
     which the date matcher looks at. Measured live.

     WHAT IS IN IT IS EXACTLY WHAT confidentMatch() AND volumeHasIsbn() READ.
     If you add a caller that wants `description`, `pageCount` or `categories`,
     pass `opts.fields` rather than widening this constant — every existing
     caller would otherwise pay 8.6x for fields it ignores, on a phone, against
     a quota that belongs to the user. */
  const LEAN_FIELDS =
    'totalItems,items(id,volumeInfo(title,subtitle,authors,publishedDate,industryIdentifiers))';

  /* ══ SEARCH ═════════════════════════════════════════════════════════════
     -> { items: [volume], totalItems }   ({ items: [], totalItems: 0 } when off)

     `printType: 'books'` is not tidiness. Without it the volumes index also
     returns magazines, and a magazine's `publishedDate` is an issue date — a
     real, precise, completely wrong day to stamp on a novel that shares part
     of its title with a periodical.

     An empty result is `{"kind":"books#volumes","totalItems":0}` with NO
     `items` key at all, not an empty array and not a 404, so the absence has
     to be checked by hand. `totalItems` is an ESTIMATE over a loose match and
     is not a count of anything — a query that can only have one true answer
     routinely reports 300. Never branch on it. */
  async function search(q, opts) {
    opts = opts || {};
    const query = String(q == null ? '' : q).trim();
    if (!enabled() || !query) return { items: [], totalItems: 0 };

    const data = await orNull(BT.net.get(SOURCE, url(BT.GB.volumes, {
      q: query,
      maxResults: BT.util.clamp(opts.limit || 20, 1, 40),
      startIndex: (opts.offset || 0) || undefined,
      printType: 'books',
      fields: opts.fields || LEAN_FIELDS,
    }), netOpts(opts, BT.TTL.gbVolume)));

    const items = Array.isArray(data && data.items) ? data.items : [];
    return { items, totalItems: Number(data && data.totalItems) || items.length };
  }

  /* ══ BY ISBN ════════════════════════════════════════════════════════════
     -> a single volume that VERIFIABLY carries that ISBN, or null.

     `q=isbn:…` rather than any dedicated endpoint, because Google has none.

     AND `isbn:` IS NOT A FILTER. It is a hint to a relevance ranker, and the
     result set is padded with whatever else the ranker liked. Measured live:

         q=isbn:9781234567897  ->  totalItems 300, three items returned
                                   [1] Risk                 ISBN_13 9781234567897  ✓
                                   [2] Risk                 ISBN_13 9781234567897  ✓
                                   [3] Reading for Thinking ISBN_13 9780395782903  ✗

     The third row is a different book with a different ISBN, sitting in the
     answer to a query that named one. `totalItems: 300` for a query that can
     only have one true answer is the same symptom: the number is an estimate
     over a loose match, not a count.

     So the identifier is CHECKED rather than assumed. Taking items[0] on faith
     works right up until Google holds no volume for the barcode, at which
     point the top row is simply the nearest thing the ranker found — and this
     arm is the one whose answers the date upgrade accepts WITHOUT corroboration,
     precisely because an ISBN is supposed to be exact identity. An unverified
     items[0] would turn that trust into a mechanism for stamping a stranger's
     publication date onto the reader's book.

     Widens an ISBN-10 to a 13 on both sides of the comparison. The ten-digit
     form is what is printed on a copyright page, so it is what a hand-typed
     record carries, and Google returns whichever forms it holds. */
  async function byIsbn(isbn13, opts) {
    const isbn = cleanIsbn(isbn13);
    if (!enabled() || !isbn) return null;
    /* Three, not one: the true match is not reliably first, and the padding
       above shows up inside the first few rows rather than after them. */
    const res = await search(`isbn:${isbn}`, Object.assign({}, opts, { limit: 3 }));
    for (const vol of res.items) {
      if (volumeHasIsbn(vol, isbn)) return vol;
    }
    return null;
  }

  /* Does this volume actually claim that ISBN? `industryIdentifiers` is
     `[{ type, identifier }]` with types ISBN_10, ISBN_13, ISSN and OTHER; both
     ISBN types are widened to 13 so a record holding the ten-digit form still
     matches a scan of the barcode. A volume with no identifiers at all — some
     older Google records have none — answers false rather than being given the
     benefit of the doubt, because "we cannot tell" and "it matches" must not
     produce the same date on the reader's shelf. */
  function volumeHasIsbn(vol, isbn13) {
    const ids = (vol && vol.volumeInfo && vol.volumeInfo.industryIdentifiers) || [];
    for (const row of ids) {
      const t = row && row.type;
      if (t !== 'ISBN_10' && t !== 'ISBN_13') continue;
      if (cleanIsbn(row.identifier) === isbn13) return true;
    }
    return false;
  }

  /* ══ VOLUME ═════════════════════════════════════════════════════════════
     -> a single volume by its Google id, or null.

     Only reachable once a search has handed us that id — nothing in the app
     can guess one — so this exists for the refresh case: a record that already
     stores `ids.googlebooks` can be re-read for one request instead of
     re-running the match that found it. */
  async function volume(id, opts) {
    const endpoint = BT.GB.volume(id);
    if (!enabled() || !endpoint) return null;
    const raw = await orNull(BT.net.get(SOURCE, url(endpoint, {}),
                                        netOpts(opts, BT.TTL.gbVolume)));
    return (raw && raw.id) ? raw : null;
  }

  /* ══ DIAGNOSTICS ════════════════════════════════════════════════════════
     -> { ok, ms, reason }   for the Settings panel's "Save & test".

     `noCache` and `ttl: 0` because a diagnostic that can be answered out of
     IndexedDB is not a diagnostic — a cached 200 from the PREVIOUS key would
     cheerfully report a revoked one as working, which is the exact failure
     somebody clicks this button to rule out.

     Dune's ISBN is the probe: one volume, ancient, and about as unlikely to
     leave the index as anything Google holds. */
  const PROBE_ISBN = '9780441013593';

  async function verifyKey() {
    if (!enabled()) {
      return { ok: false, reason: 'No key set — the Google half stays switched off, and dates stay year-only.' };
    }
    const t0 = Date.now();
    try {
      const raw = await BT.net.get(SOURCE, url(BT.GB.volumes, {
        q: `isbn:${PROBE_ISBN}`, maxResults: 1, printType: 'books',
        fields: LEAN_FIELDS,
      }), { ttl: 0, noCache: true, staleOk: false });
      const ms = Date.now() - t0;
      /* `totalItems` is the proof, not `items`: a valid key against a query
         that matched nothing still answers with the field, and that is a
         working key. Requiring `items` would report a healthy key as broken
         the day Google reshuffles its index. */
      if (raw && typeof raw.totalItems === 'number') {
        return { ok: true, ms, reason: `Key works — Google answered in ${ms} ms.` };
      }
      return { ok: false, ms, reason: 'Google answered, but not with a volumes response.' };
    } catch (e) {
      const ms = Date.now() - t0;
      /* 05-net has already written a human sentence for every kind it
         classifies — a rejected key, a quota, an offline machine — so pass it
         through rather than paraphrasing it into something vaguer. The one
         thing worth adding is the commonest cause of a 403 on a key that the
         user just copied correctly: the Books API is not enabled on the
         project, or the key is referrer-restricted to a different origin. */
      const base = (e && e.message) || String(e);
      const hint = (e && (e.kind === 'auth'))
        ? ' Check that the Books API is enabled on the key’s Google Cloud project, '
          + 'and that any HTTP-referrer restriction on the key includes this site.'
        : '';
      return { ok: false, ms, kind: e && e.kind, reason: base + hint };
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE DATE UPGRADE PATH
     ══════════════════════════════════════════════════════════════════════════
     One job: turn a year into a month or a day, and never do anything else to
     the record. Every rule below exists because the alternative is worse than
     the coarse date we already have — a WRONG date is worse than a vague one,
     because a vague one is visibly vague and a wrong one is not.
     ══════════════════════════════════════════════════════════════════════════ */

  /* THE PRECISION FLOOR. Read through 38-normalize rather than kept here, so
     there is exactly one ladder in the codebase: the one pickRelease enforces
     when it merges. A private copy would be free to drift, and the symptom of
     drift is silent — this file would start paying for lookups whose answers
     the merge then discards, and nothing would report it. */
  const rank = p => (BT.normalize ? BT.normalize.precisionRank(p) : 0);
  const YEAR_RANK = 1;

  /* Is there anything here worth spending a request on?

     This is the FIRST of the two never-downgrade guarantees and the cheap one:
     if the record already states a month or a day, we do not ask. The second
     is structural and lives in pickRelease, which refuses a coarser payload
     however confident it claims to be. Policy here, invariant there — both,
     because a policy can be edited by somebody who has not read the invariant.

     Also declined:

       · a release the reader corrected by hand. mergeItem restores manual
         overrides on top of everything anyway, so the request could only ever
         be paid for and then thrown away.
       · a record we already asked about recently and could not improve. This
         is the difference between a library that costs a handful of requests
         and one that re-learns "Google also only has 1965" every time a pane
         opens. See BT.TTL.gbDateRecheck. */
  function needsDateUpgrade(item, opts) {
    opts = opts || {};
    if (!enabled() || !item || !BT.normalize) return false;

    const rel = item.release;
    if (!rel) return false;
    if (rank(rel.precision) > YEAR_RANK) return false;

    /* mergeItem discards any payload with no title, so a titleless record
       could be asked about, matched and merged — and then silently keep none
       of it, including the check stamp that stops us asking again tomorrow.
       Refused here so the request is never spent. */
    if (!item.title) return false;

    const ov = (item.meta && item.meta.manualOverrides) || {};
    for (const path of Object.keys(ov)) {
      if (path === 'release' || path.indexOf('release.') === 0) return false;
    }

    if (opts.force) return true;
    const stamp = (item.meta && item.meta.gbDate) || null;
    if (stamp && stamp.checkedAt
        && Date.now() - stamp.checkedAt < BT.TTL.gbDateRecheck) return false;

    return true;
  }

  /* -> a NEW item with the better date merged in, or null when nothing was
        done (switched off, nothing to gain, or the lookup failed).

     The caller writes. This adapter never touches BT.repo — same rule
     20-openlibrary.js holds to, and for the same reason: merging, re-tiering
     and persisting are the caller's business, so the "views and sync go
     through BT.repo" rule survives all the way down.

     A non-null return ALWAYS deserves a write, even when no better date was
     found, because the check stamp is itself the thing worth keeping — it is
     what stops the next pane-open asking again. `meta.gbDate.upgraded` says
     which of the two happened. */
  async function upgradeItemDate(item, opts) {
    opts = opts || {};
    if (!needsDateUpgrade(item, opts)) return null;

    let hit = null;
    try {
      hit = await findVolumeFor(item, opts);
    } catch (e) {
      /* Enrichment is a nicety and must never be the reason a detail pane
         fails to paint. Swallowed here rather than at the call sites so that
         every caller gets the same behaviour, and logged so a broken key or a
         spent budget is still findable in the console. Deliberately NOT
         stamped as "checked": a request that failed is not evidence that
         Google has nothing, and recording it as one would blind this book to
         enrichment for a month over a transient outage. */
      console.warn('[googlebooks] date lookup failed for', item && item.uid, e && e.message);
      return null;
    }

    const stamp = {
      checkedAt: Date.now(),
      volumeId: (hit && hit.volume && hit.volume.id) || null,
      via: hit ? hit.via : null,           // 'isbn' | 'title' | null
      found: hit ? (hit.raw || '') : '',
      upgraded: 0,
    };

    const partial = {
      /* mergeItem discards any payload with no title — a shell of a record is
         not a record — so the title has to travel even though this path never
         changes it. It is the existing one, not Google's: Google's title is a
         match signal, never an edit. */
      title: item.title,
      meta: { gbDate: stamp },
    };

    if (hit && hit.release && rank(hit.release.precision) > rank(item.release.precision)) {
      stamp.upgraded = 1;
      partial.release = hit.release;
      if (stamp.volumeId) partial.ids = { googlebooks: stamp.volumeId };
    }

    return BT.normalize.mergeItem(item, partial);
  }

  /* ── Finding the right volume ────────────────────────────────────────────
     -> { volume, release, raw, via } or null.

     TWO ARMS, and they are trusted very differently.

     ISBN — exact identity. One barcode names one printing, so whatever date
     Google holds for it is a date about the object the reader is holding, and
     it is accepted as-is. Only PINNED ISBNs are used, never candidates: a
     candidate is a possibility harvested off an editions page (see the
     pinned/candidate note in 38-normalize.js), and dating a work by a randomly
     chosen printing out of that list is how a 1937 novel acquires a 2020 date
     that looks authoritative.

     TITLE + AUTHOR — a guess, and treated as one. See confidentMatch(): it has
     to agree on the folded title, share an author surname, AND land in the
     same year we already hold. That last condition is the load-bearing one:
     it means this arm can only ever refine a year into a month or a day, and
     can never move the year itself. The worst case it can produce is the right
     year with the wrong day — bad, but bounded — instead of a confidently
     stated date for a different book with a similar name.

     THE HOBBIT IS THE PROOF, and it is not hypothetical. Measured live:

         intitle:"The Hobbit" inauthor:"J. R. R. Tolkien"
           -> "The Hobbit"            J.R.R. Tolkien      1986-07-12
           -> "The Hobbit"            J. R. R. Tolkien    2026-03-26
           -> "The History of the Hobbit"                 2023-05-16

     Every one of those is a real Tolkien record, the top two match the title
     and the author exactly, and both would be a catastrophic date to stamp on
     a 1937 novel — one is a reprint, the other has not been published yet.
     Without the year gate this arm confidently "upgrades" The Hobbit to July
     1986. With it, all three are refused and the record keeps its honest 1937.
     (The third also fails the title fold, which is the cheap check catching
     what the expensive one would have caught anyway.)

     Which is also why an item with no year at all does not get the title arm.
     There is nothing to corroborate against, and an uncorroborated title match
     is exactly the wrong date this whole function exists to avoid. */
  async function findVolumeFor(item, opts) {
    const pinned = Array.isArray(item.isbnsPinned) ? item.isbnsPinned : [];
    for (const raw of pinned) {
      const vol = await byIsbn(raw, opts);
      const rel = releaseFromVolume(vol);
      if (rel) return { volume: vol, release: rel.release, raw: rel.raw, via: 'isbn' };
      /* One pinned ISBN is the normal case. A record with several is a book
         the reader owns in two printings, and asking Google about all of them
         would spend a request per printing to answer one question — so the
         first that resolves wins and the rest are left alone. */
      if (vol) break;
    }

    const year = storedYear(item);
    if (!year) return null;

    const title = String(item.title || '').trim();
    const authors = (item.authors || []).map(a => a && a.name).filter(Boolean);
    /* No author on the record means no corroboration is possible, and a title
       alone is not enough: "Beginnings", "The Gift" and "Home" are each dozens
       of different books. Skipped rather than guessed. */
    if (!title || !authors.length) return null;

    /* TWENTY ROWS, NOT FIVE, AND IT COSTS NOTHING EXTRA. `maxResults` changes
       the size of one response, not the number of requests, so the only price
       is payload — which the lean field list above already cut by 8.6x.

       Five was not enough, measured. Google ranks a popular title by edition
       recency, so the FIRST printing — the one whose year an Open Library
       record actually holds — is buried:

           intitle:"Project Hail Mary" inauthor:"Andy Weir"
             top 5 years:  2025 2022 2024 2026 2025
             all 11 years: 2025 2022 2024 2026 2025 2026 2022 2021 2021 2021 —

       The 2021-05-04 hardcover we are trying to sharpen sits at position
       eight. At `maxResults: 5` the year gate correctly refused every row and
       the book kept its bare '2021' for ever; at twenty it finds the real
       one. The gate is what makes widening the window SAFE — more rows can
       only mean more chances to match the year we already trust, never a
       looser match. (Position nine in that list is 'Book Club in a Box', also
       2021 — refused by the title fold, which is the other half of the test
       doing its job.) */
    const res = await search(
      `intitle:${phrase(title)} inauthor:${phrase(authors[0])}`,
      Object.assign({}, opts, { limit: 20 }));

    let best = null;
    for (const vol of res.items) {
      if (!confidentMatch(item, vol, year)) continue;
      const rel = releaseFromVolume(vol);
      if (!rel) continue;
      /* Finest wins; among equally fine ones the EARLIEST date wins. An open
         item is a WORK — "Dune", not the 1990 Ace paperback — so when Google
         offers three printings from the same year, the first of them is the
         answer to "when did this book come out". */
      if (!best
          || rank(rel.release.precision) > rank(best.release.precision)
          || (rank(rel.release.precision) === rank(best.release.precision)
              && rel.release.sortKey < best.release.sortKey)) {
        best = { volume: vol, release: rel.release, raw: rel.raw, via: 'title' };
      }
    }
    return best;
  }

  /* Google's `publishedDate` -> a release object, or null when the volume has
     no date at all.

     Parsed through BT.util.parseOpenLibraryDate — the app's ONE date engine —
     rather than a private `new Date(...)`. The name says Open Library and the
     function is general: it normalises free text down to 'YYYY' / 'YYYY-MM' /
     'YYYY-MM-DD' and then runs the same placeholder ladder, the same Jan-1
     demotion for unpublished titles and the same TBA rule as every other date
     in the app. Google's three ISO shapes are the easy end of what it already
     handles, and routing them through it is what guarantees a Google date and
     an Open Library date sort, render and hatch identically.

     `new Date('2021-05-04')` would also have parsed it, and would have parsed
     it as UTC midnight — which is May 3rd for every reader west of Greenwich.
     The precision engine never constructs a Date for exactly that reason. */
  function releaseFromVolume(vol) {
    const info = (vol && vol.volumeInfo) || null;
    const raw = info && info.publishedDate;
    if (!raw) return null;
    const release = BT.normalize.buildRelease(String(raw), {
      basis: 'googlebooks-published',
      source: SOURCE,
      /* A volume in Google's index is a book that exists, so an unparseable
         date still means "published" rather than "unannounced". */
      inPrint: true,
    });
    if (release.sortKey >= BT.util.SK_UNKNOWN) return null;
    return { release, raw: String(raw) };
  }

  /* ── The match test ──────────────────────────────────────────────────────
     All three conditions, or no match. Written as three explicit tests rather
     than a score with a threshold, because a threshold is a number somebody
     lowers when a book they know about fails to match, and the failure mode of
     lowering it is a date silently attached to the wrong book. */
  function confidentMatch(item, vol, year) {
    const info = (vol && vol.volumeInfo) || null;
    if (!info) return false;

    /* 1. THE YEAR MUST AGREE with what we already hold. This is what bounds
          the damage of a bad title match to "right book, wrong printing"
          instead of "wrong book entirely", and it is why this arm can only
          ever sharpen a date rather than move it. */
    const parts = BT.util.parseNaive(naiveOf(info.publishedDate));
    if (!parts || parts.y !== year) return false;

    /* 2. THE TITLE MUST FOLD TO THE SAME STRING. Compared both against
          Google's bare title and against title + subtitle, because the two
          catalogues disagree about where a colon goes: Open Library stores
          'Leviathan Wakes' where Google stores title 'Leviathan Wakes' with
          subtitle 'Book One of the Expanse', and elsewhere stores the whole
          thing in `title`. */
    const ours = fold(item.title);
    if (!ours) return false;
    const theirs = fold(info.title);
    const theirsFull = fold([info.title, info.subtitle].filter(Boolean).join(' '));
    if (ours !== theirs && ours !== theirsFull) return false;

    /* 3. AN AUTHOR SURNAME MUST BE SHARED. Surnames rather than full names
          because the two catalogues disagree about initials and middle names
          far more often than they disagree about the family name —
          'J.R.R. Tolkien', 'J. R. R. Tolkien' and 'John Ronald Reuel Tolkien'
          are one author and three strings. */
    const mine = surnames((item.authors || []).map(a => a && a.name));
    const yours = surnames(info.authors || []);
    if (!mine.size || !yours.size) return false;
    for (const s of mine) if (yours.has(s)) return true;
    return false;
  }

  /* ── Small helpers ───────────────────────────────────────────────────── */

  /* The stored year, or null. Read off the sort key rather than off
     `release.raw`, because raw is the cataloguer's original free text and the
     sort key is what the precision engine actually concluded from it. */
  function storedYear(item) {
    const sk = item && item.release && item.release.sortKey;
    const p = (sk != null) ? BT.util.sortKeyToParts(sk) : null;
    return (p && p.y) ? p.y : null;
  }

  function naiveOf(raw) {
    return raw == null ? '' : (BT.util.olDateToNaive(String(raw)) || '');
  }

  /* Titles folded for COMPARISON only, never for display. Uses the same
     normaliser the search ranker uses, then drops a trailing parenthetical —
     Google routinely appends edition furniture ('Dune (40th Anniversary
     Edition)') that Open Library does not, and without this every anniversary
     reissue fails a match it should pass.

     AND THE LEADING ARTICLE IS NORMALISED AWAY, because the two catalogues
     genuinely disagree about it and the disagreement is not an edge case.
     Measured live, on the exact book this feature exists for:

         Open Library work OL37620147W  title 'Haunting of Velkwood'
         Google Books                   title 'The Haunting of Velkwood'
                                                publishedDate '2024-03-05'

     One row came back, it was unmistakably the right book, and an exact fold
     refused it — so the record kept its bare '2024' and the whole upgrade path
     looked like it was doing nothing. Open Library drops or inverts the article
     on a large share of its work records; the MARC-derived ones carry the
     inverted form ('Hobbit, The'), which is the same disagreement written
     backwards, so both shapes are handled.

     Safe to drop, and this is the part worth being sure about: the article is
     never the distinguishing part of a title, and this test is already fenced
     by the year gate and the shared surname in confidentMatch(). Two different
     books by one author, published in one year, whose titles differ ONLY by a
     leading 'the', is not a case that exists. What this cannot do is move a
     year, which is the failure that actually matters. */
  const ARTICLE_INVERTED = /,\s*(the|an|a)\s*$/i;
  const ARTICLE_LEADING = /^(the|an|a) /;

  function fold(s) {
    const trimmed = String(s == null ? '' : s)
      .replace(/\s*\([^)]*\)\s*$/, '')
      /* Before normalizeTitle, which turns the comma into a space and destroys
         the only signal that says this is an inverted title rather than a real
         one ending in the word 'a'. */
      .replace(ARTICLE_INVERTED, '');
    return BT.util.normalizeTitle(trimmed).replace(ARTICLE_LEADING, '');
  }

  function surnames(names) {
    const out = new Set();
    for (const n of (names || [])) {
      const parts = BT.util.normalizeTitle(n).split(' ').filter(Boolean);
      /* Single-token names are real ('Homer', 'Colette') and are their own
         surname; for everything else the last token is the family name. */
      if (parts.length) out.add(parts[parts.length - 1]);
    }
    return out;
  }

  /* A quoted phrase for `intitle:` / `inauthor:`. Embedded quotes are replaced
     rather than escaped: Google's query grammar has no escape sequence, so a
     stray quote inside the phrase closes it early and silently widens the
     search into an unrelated result set. */
  function phrase(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  }

  /* Normalize to a 13-digit ISBN, or ''. Widens the ten-digit form rather than
     rejecting it — BT.util.isbn10to13 knows about the mod-11 'X' check
     character that a naive digit-strip destroys. */
  function cleanIsbn(v) {
    const raw = String(v == null ? '' : v).toUpperCase().replace(/[^0-9X]/g, '');
    if (raw.length === 13) return /^\d{13}$/.test(raw) ? raw : '';
    if (raw.length === 10) return BT.util.isbn10to13(raw) || '';
    return '';
  }

  return {
    enabled,
    search, byIsbn, volume,
    verifyKey,
    needsDateUpgrade, upgradeItemDate,
    /* Exposed so tests and the Settings diagnostics can assert the rules that
       cannot be seen from a response: that no URL leaves here without a key,
       and that the match test refuses the near-misses it is supposed to. */
    url, confidentMatch, releaseFromVolume, fold, surnames,
  };
})();
