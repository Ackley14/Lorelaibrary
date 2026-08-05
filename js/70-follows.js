/* ══════════════════════════════════════════════════════════════════════════
   Following authors — dual identity, a UNIONED catalogue from two sources,
   and the one serialized refresher that maintains it.

   This file touches no DOM. 67-view-people.js draws what is stored here,
   61-view-search.js and 56-inspector.js offer the Follow button, 45-alerts.js
   turns the diff this file computes into feed rows.

   ── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING ─────────────────
   THE FOLLOW ROW IS THE CACHE. `row.works` is this author's catalogue as of
   the last successful check, MERGED FROM BOTH SOURCES, and it is the ONLY copy
   of that answer the app keeps. The Following page renders from it with zero
   requests, the diff is computed against it, and the alerts feed is a log of
   how it changed. `refreshAll()` below is the single writer, and NOTHING else
   may write `works`, `worksAt`, `knownKeys` or `news`.

   ── GOOGLE IS PRIMARY. OPEN LIBRARY IS RETAINED. ─────────────────────────
   Measured live, with a real key, against the exact authors this feature is
   for. Neither catalogue is a superset of the other, which is why BOTH are
   asked before this file will say an author has nothing coming:

     Only Google had it            Only Open Library had it
     ─────────────────────────     ────────────────────────────────────────
     Gwendolyn Kiste               Brandon Sanderson
       In These Gilded, Ghostly      Isles of the Emberdark   (OL: '2026')
       Hearts        2026-09-15    Stephen King
     Brandon Sanderson               Other Worlds Than These  (OL: '2026')
       Tailored Realities 2026-10-15

   And the two halves feed each other. Open Library found `Other Worlds Than
   These` and could only say '2026' — a bare year, which straddles today and is
   therefore undecidable. One targeted Google lookup turned it into 2026-10-06,
   a real future date. Run the other way, `Isles of the Emberdark` carries a
   2026 in Open Library's `publish_year` array; Google shows why — the 2026 is
   the SPANISH edition (2026-03-24, es) and the English one came out 2025-07-01.
   The English filter is what stops that being reported as forthcoming.

   So: Google answers first and its date wins, Open Library fills the gaps, and
   an author is only ever described as having nothing scheduled when both were
   asked and both answered.

   ── FOUR RULES, each measured, each fails quietly ─────────────────────────

   1. AN AUTHOR HAS TWO IDENTITIES AND THE ROW STORES BOTH.

      Open Library has stable author OLIDs. GOOGLE HAS NO AUTHOR IDS AT ALL —
      a volume id names one printing and there is no author record behind it,
      so the only handle Google offers is the exact author-name STRING it
      prints in `volumeInfo.authors`. Those are different kinds of thing and
      the row keeps both:

          olid    'OL7481853A'         what Open Library is asked with
          gbName  'Gwendolyn Kiste'    what Google is asked with, and what
                                       every returned volume is CHECKED against

      Either may be missing. Google will have books Open Library has never
      catalogued, so a follow may exist with only a gbName; a follow imported
      from an older build has only an OLID until its first check confirms the
      other half. Every query path below branches on which half it has.

   2. NEITHER CATALOGUE'S AUTHOR QUERY CAN BE TRUSTED BLINDLY.

      Verified live:

          openlibrary  search.json?author=gwendolyn+kiste
                       -> Occultation, Swift to Chase, The Beautiful Thing
                          That Awaits Us All          — LAIRD BARRON'S books

          google       inauthor:Kiste                 -> 300 books about
                                                         Queen Victoria

      HTTP 200 every time, a confident bibliography, for the wrong writer.

      The answer is different on each side because the failure is different.
      Open Library HAS an id, so we use it and never a name — `author=OLID` is
      exact. Google has no id, so the query is only a fishing net and the
      VERIFICATION happens on the way back: every volume is kept only if its
      own `volumeInfo.authors` array contains the followed author's name.

      WHICH NET, THOUGH, IS NOT A FREE CHOICE. Credited volumes out of the 20
      Google returns, three identical trials each:

          author              plain "Name"    inauthor:"Name"
          ──────────────────  ────────────    ───────────────
          Martha Wells              1               19
          Stephen King             13               20
          Gwendolyn Kiste           7               16
          Brandon Sanderson        20               20

      A plain quoted name is a FULL-TEXT query — it matches books that merely
      mention the person, which is why it finds one Martha Wells book in
      twenty. `inauthor:` with the QUOTES is the net that works; the bare
      surname is the Queen Victoria trap above. See askGoogle().

      AND AN EARLIER NOTE HERE WAS WRONG: `inauthor:"Stephen King"` was
      recorded as returning zero. It returns 20 of 20. The endpoint answers
      bare 503s often enough to counterfeit an empty catalogue — 13 of 37
      probe requests needed a retry — so no property of this API may be
      concluded from a single request, and a failed request may never be read
      as an empty one.

   3. `orderBy=newest` DOES NOT SORT BY PUBLICATION DATE — it sorts by when
      Google added the record (observed publication years in returned order:
      2023, 2020, 2024, 2018). Nothing in this file may treat any server
      ordering as chronological; everything is sorted client-side on the release
      we derived.

      IT IS STILL FETCHED, as 25-googlebooks.js's second ARM rather than as an
      order, because a recently-added record is where an announced title lives.
      That call belongs to the adapter and so does the decision.

      WHAT BELONGS HERE IS REACH. `authorWorks` asks its two arms once, at
      offset 0, on the plain-name net — right for a lookup, and measurably not
      enough for a follow. Merged works stored per follow:

          author              adapter alone   + the inauthor arm
          ──────────────────  ─────────────   ──────────────────
          Martha Wells         1 work          20   — including Platform Decay
          Brandon Sanderson   20 works         38
          Stephen King        13 works         22
          Gwendolyn Kiste      7 works         14

      So askGoogle() calls the adapter and then runs two more pages of its own
      through the adapter's `search` + `creditsAuthor` + `groupPrintings`. The
      adapter keeps owning what a Google request IS; this file owns which net
      a FOLLOW casts and how wide, which is a recall-and-budget question about
      a feature the adapter knows nothing about.

   4. THE FIRST SIGHTING OF A FOLLOW EMITS NOTHING, and so does the first
      sighting after this file changed shape. See `cold` and `migrating` in
      refreshOne(). Following an author with 190 works must store 190 keys and
      say nothing; switching the app's primary source must not re-announce a
      whole roster's backlist as new.

   ── Budget ───────────────────────────────────────────────────────────────
   Open Library sustains about one request a second and asks not to be used as
   a backend for automated traffic. Google's free tier is ~1,000/day and
   BT.NET_POLICY caps this app at 400. So per follow, per refresh:

       1  Open Library author page          (skipped with no OLID)
       4  Google slices                     (skipped with no key or no gbName)
                                           2 from the adapter, 2 author-field
       ≤6 targeted Google date lookups      (only for undecidable years, and
                                             the answer is STORED, so this is
                                             a one-off per work, not per pass)

   refreshAll() is a single serialized worker — no Promise.all anywhere in this
   file — and a per-follow cooldown means an automatic pass over a roster
   checked an hour ago costs ZERO requests.
   ══════════════════════════════════════════════════════════════════════════ */

BT.follows = (function () {

  /* Which catalogue minted the follow's ID — not which catalogue answers for
     it. A row keyed on an OLID is still asked of Google through its gbName,
     and vice versa. Stored so an export can never present a guess and a fact
     as equals. */
  const OL_SOURCE = 'openlibrary';
  const GB_SOURCE = 'googlebooks';

  /* The stored shape's version. Bumped when the meaning of `works` or the
     diff baseline changes, and read by refreshOne() to decide whether the next
     check is a re-baseline or a real diff. See MIGRATION below.

     3 — the author-field arm in askGoogle(). WIDENING THE NET IS A BASELINE
     CHANGE even though the record shape did not move an inch: a roster last
     checked on the plain-name query holds a baseline of what THAT query could
     see, which for Martha Wells was one work out of twenty. Diffing the
     thirty-three the new arm returns against it would announce thirty-two
     backlist titles as brand new, for every follow at once — the exact flood
     rule 4 exists to prevent. The bump makes the first check after this change
     re-baseline in silence. */
  const SCHEMA = 3;

  /* How long a stored catalogue is treated as current. BT.SWEEP.cooldownMs is
     REUSED rather than a fresh number invented — it is already this app's
     answer to "how often is it worth re-asking what is in a follow's
     catalogue?", so the background schedule and this one cannot drift apart.
     An explicit refresh passes `force` and ignores it entirely. */
  const WORKS_TTL = (BT.SWEEP && BT.SWEEP.cooldownMs) || 4 * 3600e3;

  /* One Open Library page (BT.LIMITS.authorWorks). Not a display cap — the
     size of the answer one request returns. */
  const OL_PAGE = BT.LIMITS.authorWorks;

  /* Google's `maxResults` maxes at 40 and in practice hands back 20 for one
     author query however large the parameter is (measured repeatedly, across
     all four test authors), so the offsets step by 20 rather than by the
     requested page size. */
  const GB_PER_PAGE = (BT.GB && BT.GB.MAX_RESULTS) || 40;
  /* OFFSET 0 IS INCLUDED, which looks like a duplicate of the adapter's first
     arm and is not: this arm asks a DIFFERENT QUESTION — the author field
     rather than the full text — and its first page is where the answer lives.
     See the measured table in askGoogle(). Two requests either way, so the
     per-follow Google budget is unchanged. */
  const GB_EXTRA_OFFSETS = [0, 20];

  /* The merged catalogue kept per follow. Larger than one Open Library page
     because it is now the UNION of two, and still bounded because this row
     travels in SYNC_STORES and through the encrypted cloud payload. Rows past
     the cap are dropped NEWEST-DATE-LAST — i.e. the oldest backlist goes
     first, never anything forthcoming. */
  const WORKS_CAP = 96;

  /* Ceiling on the union baseline. Prolific authors do not reach four figures
     of distinct titles, so this is unreachable in normal use — it exists so a
     decade of imported exports cannot grow a row without bound. EVICTION IS
     THE FAILURE MODE it avoids: a key dropped here re-reads as new the next
     time it appears. 16-cloud.js reads this constant when it merges two
     devices' baselines, so there is one owner of the number. */
  const KNOWN_CAP = 4000;

  /* How many news entries one follow keeps — a reading length rather than a
     storage bound. Oldest fall off. */
  const NEWS_CAP = 40;

  /* Targeted date lookups per follow per refresh. Only rows whose date is a
     bare year that straddles today or lies ahead are worth one, and the answer
     is written onto the stored work — so on a settled roster this is zero. */
  const SHARPEN_PER_REFRESH = 6;

  /* Longest the refresher will wait for an interactive lookup to finish before
     carrying on regardless. A hold that leaks — a search that threw between
     hold() and release() — must cost seconds, never the whole refresh. */
  const HOLD_MAX_MS = 20000;

  /* ══ IDS ════════════════════════════════════════════════════════════════
     `{type}:{source}:{sourceId}`, matching the uid scheme in 38-normalize.js,
     so a row is legible in a database viewer and an export needs no lookup
     table to be understood.

     TWO MINTS, because an author may exist in only one catalogue:

       author:openlibrary:OL7481853A     an OLID — preferred, always stable
       author:googlebooks:gwendolyn-kiste  a folded name — the only handle
                                           Google offers

     authorId() is UNCHANGED, deliberately. Every stored follow this user
     already has is keyed by it, and a key that changes is a follow that
     silently unfollows itself on upgrade. */
  function authorId(olid) {
    const id = BT.util.olid(olid);
    return id ? `author:${OL_SOURCE}:${id}` : '';
  }

  /* A readable slug rather than a hash, for the same reason the OLID form is
     legible: somebody reading the store should be able to tell whose row it
     is. Two different authors whose names fold identically would share a row —
     which is exactly what Google's own name-based identity already does, so
     this adds no ambiguity that the source does not already have. */
  function googleAuthorId(name) {
    /* NFKD FIRST, THEN DELETE — never substitute — everything that is not a
       letter, a digit or a space. The order and the deletion are both the
       point: decomposition splits 'É' into 'E' plus a combining accent, and if
       that accent were turned into a separator instead of dropped, 'Émile Zola'
       would slug as 'e-mile-zola' while 'Emile Zola' slugged as 'emile-zola' —
       one author, two follow rows, each with its own cache and its own news.
       Spaces survive that pass and become the only separator. */
    const slug = String(name == null ? '' : name)
      .toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/ +/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `author:${GB_SOURCE}:${slug}` : '';
  }

  /* ══ THE ENGLISH FILTER ═════════════════════════════════════════════════
     English only, everywhere the app SEARCHES or FOLLOWS.

     A RECORD THAT DECLARES NO LANGUAGE IS KEPT. Only a record that positively
     declares something else is dropped. That asymmetry is not caution for its
     own sake: Open Library's author-works field list carries no language at
     all, and thin Google records frequently omit it, so a filter that required
     a positive 'en' would empty most of this screen.

     SCANNING IS EXEMPT, and this is the one place the difference is worth
     stating because it looks like an inconsistency. A book the reader physically
     holds and scans is accepted whatever language it declares — the reader is
     looking at the object, and the app refusing to shelve a book that is in
     their hands because a catalogue field says 'de' would be the app arguing
     with reality. Discovery is the opposite case: nothing is in anyone's hands,
     a foreign-language edition of a book the reader cannot read is noise, and
     the filter is what stops `Islas de la Ascuaoscura` being announced as
     Brandon Sanderson's next release. 39-scan.js owns that path and does not
     call this.

     FEATURE-DETECTED, NOT REIMPLEMENTED. 25-googlebooks.js / 38-normalize.js
     own the shared filter; this asks for it by every name it might carry and
     falls back only so that a load-order accident degrades to a working app
     rather than an empty one. When the shared one exists it always wins, so
     there is one rule and not two. */
  /* -> true when this volume may be shown.

     BT.lang (00-config.js) is the app's ONE reader of a language field. It eats
     every shape the two catalogues use ('en', 'en-GB', 'eng', '/languages/eng',
     `{key:'/languages/eng'}`), treats `und`/`mul`/`zxx` as undeclared, and keeps
     a record that declares NOTHING. That last rule is why it is not a one-liner:
     a filter that required a positive 'en' would delete exactly the thin,
     newly-catalogued records a forthcoming title always is.

     The local fallback exists only so a load-order accident degrades to a
     working app rather than an empty one. BT.lang always wins when it is there,
     so there is one rule and not two. */
  function keepEnglish(vol) {
    if (BT.lang && typeof BT.lang.acceptsVolume === 'function') {
      return !!BT.lang.acceptsVolume(vol);
    }
    const lang = String(((vol && vol.volumeInfo) || {}).language || '').toLowerCase();
    if (!lang) return true;                       // undeclared is kept
    return lang === 'en' || lang === 'eng' || lang.indexOf('en-') === 0;
  }

  /* The same question about an Open Library search doc, whose `language` is an
     ARRAY of MARC codes carrying one entry per edition — so a novel with a
     French translation declares ['eng','fre'] and is still the English book the
     reader is looking for. BT.lang.accepts encodes that ANY-match rule. */
  function keepEnglishDoc(doc) {
    if (BT.lang && typeof BT.lang.acceptsDoc === 'function') {
      return !!BT.lang.acceptsDoc(doc);
    }
    const langs = (Array.isArray(doc && doc.language) ? doc.language
                  : ((doc && doc.language) ? [doc.language] : [])).map(x => String(x).toLowerCase());
    if (!langs.length) return true;
    return langs.some(l => l === 'eng' || l === 'en' || l.indexOf('en-') === 0);
  }

  /* ══ PERSISTENCE ════════════════════════════════════════════════════════
     Everything goes through BT.repo, which owns the store and emits
     'follow:change' — that event is what re-counts the Following row in the
     index tree, so nothing here calls BT.db and nothing here repaints.

     Publisher rows are filtered on the way OUT as well as being retired on
     disk. A device still running the old build can sync one in at any moment,
     and a row whose catalogue branch no longer exists would render as an author
     with a permanently empty catalogue — a follow that looks broken rather than
     one that was removed. */
  const isAuthorRow = f => !!(f && f.type === 'author');

  async function all() {
    return (await BT.repo.allFollows()).filter(isAuthorRow);
  }
  async function get(id) {
    if (!id) return null;
    const row = await BT.repo.getFollow(id);
    return isAuthorRow(row) ? row : null;
  }
  async function isFollowing(id) {
    return !!(await get(id));
  }

  /* Fill a caller's partial row out to the stored shape. Returns null for
     anything that cannot be identified, because a follow with no id is a row
     that can never be unfollowed. */
  function normalizeRow(row) {
    if (!row) return null;
    /* Authors only, now and deliberately. A caller still passing
       `type: 'publisher'` is running against a build that no longer has that
       feature, and inventing an author row from a publisher name would follow
       a person who does not exist. */
    if (row.type && row.type !== 'author') return null;

    const olid = BT.util.olid(row.olid || row.sourceId || row.id || '');
    const name = String(row.name == null ? '' : row.name).trim();
    /* THE GOOGLE HALF, CAPTURED AT FOLLOW TIME. When the caller knows the exact
       string Google prints — a search row built from a volume — it is passed in
       and marked 'volume'. Otherwise the display name is SEEDED and marked as
       such, and the first refresh replaces it with whatever Google's own
       `volumeInfo.authors` actually says. Seeding rather than leaving it empty
       matters: with no gbName there is nothing to query Google with at all, so
       an author followed from an Open Library row would be invisible to the
       source that is supposed to be primary. */
    const gbName = String(row.gbName == null ? '' : row.gbName).trim() || name;
    const id = olid ? authorId(olid) : googleAuthorId(gbName);
    if (!id) return null;

    const now = Date.now();
    return {
      id,
      type: 'author',
      source: olid ? OL_SOURCE : GB_SOURCE,
      /* `sourceId` is kept as the OLID for an Open Library row so that every
         existing reader of it — exports, the console, 16-cloud's merge — goes
         on seeing what it saw. `olid` is the explicit field new code reads. */
      sourceId: olid || googleAuthorId(gbName).split(':').pop(),
      olid: olid || '',
      gbName,
      gbNameSource: row.gbNameSource || (row.gbName ? 'volume' : 'seed'),
      gbNameAt: row.gbNameAt || now,
      name: name || gbName || olid,
      /* A NEW follow starts EMPTY on purpose — see rule 4. Pre-filling this
         from a work list the caller happens to be holding would be the same
         mistake in a nicer wrapper: it would also mean the first genuinely new
         book is never reported, because it arrived already known. */
      works: [],
      worksAt: 0,
      numFound: 0,
      /* The diff baseline, keyed the way the union is keyed. `knownWorkIds`
         (Open Library work OLIDs) is what the previous build stored; it is left
         untouched on any row that has one — see MIGRATION. */
      knownKeys: [],
      lastCheckedAt: 0,
      lastTriedAt: 0,
      lastError: '',
      /* Per-source outcome of the last check. This is what makes "nothing
         scheduled" an honest sentence: it may only be said when BOTH sources
         answered. */
      srcState: {},
      news: [],
      /* Stamped NOW rather than left at 0. The badge counts news later than
         this mark, and a follow added this second has no history the reader has
         missed — starting at 0 would light the sidebar for a roster the reader
         has never had a chance to look at. */
      newsSeenAt: now,
      addedAt: now,
      muted: 0,
      schema: SCHEMA,
    };
  }

  /* Idempotent. Following someone you already follow is a no-op on everything
     except the display name and a BETTER Google name.

     RE-FOLLOWING MUST NOT RESET THE CACHE OR THE BASELINE. The Follow button
     appears in four places (search rows, the detail pane, the roster, the
     picker), so pressing it twice is ordinary rather than exotic. If the second
     press overwrote the row, `works` and `knownKeys` would both go back to
     empty — the follow would look identical, and the next refresh would
     re-baseline instead of reporting the new book it was about to find. A
     silent, permanent loss of exactly the event the feature exists for. */
  async function follow(row) {
    const next = normalizeRow(row);
    if (!next) return null;

    const existing = await BT.repo.getFollow(next.id);
    if (existing) {
      let dirty = false;
      /* A better name is worth taking — search rows carry the display name and
         a bare id does not. */
      if (next.name && next.name !== next.sourceId && next.name !== existing.name) {
        existing.name = next.name;
        dirty = true;
      }
      /* A CONFIRMED Google name beats a seeded one, and never the other way
         round. `gbNameSource` is what encodes that ranking, so a second Follow
         press from an Open Library row cannot overwrite a string a Google
         volume actually printed. */
      if (next.gbNameSource === 'volume' && existing.gbNameSource !== 'volume'
          && next.gbName && next.gbName !== existing.gbName) {
        existing.gbName = next.gbName;
        existing.gbNameSource = 'volume';
        existing.gbNameAt = Date.now();
        dirty = true;
      }
      if (!existing.gbName && next.gbName) { existing.gbName = next.gbName; dirty = true; }
      if (dirty) await BT.repo.putFollow(existing);
      return existing;
    }
    await BT.repo.putFollow(next);
    return next;
  }

  /* Unfollowing drops the cache and the baseline with the row, which is
     correct: re-following later is a first sighting again, and a first sighting
     emits nothing. Keeping the keys around would mean re-following an author you
     had dropped for a year told you about nothing that happened in it. */
  async function unfollow(id) {
    if (!id) return false;
    const had = await BT.repo.getFollow(id);
    if (!had) return false;
    await BT.repo.deleteFollow(id);
    return true;
  }

  /* -> { id, type, name, following } , or null when there is nothing to key on.

     NULL IS STILL AN ANSWER THE CALLER MUST HANDLE, and it still means "this
     record has no OLID". 61-view-search.js and 56-inspector.js both call this
     with two arguments and both read null as "cannot be followed reliably", so
     the OLID-less path is OPT-IN through `opts.googleOnly` rather than a new
     default. A caller that has verified a Google author-name string can say so;
     one that merely has a name it read off an Open Library page cannot, and
     following by an unverified name is the bug rule 2 exists for.

     `opts.gbName` is the exact string Google Books prints for this author, when
     the caller has a volume in hand. */
  async function toggleAuthor(olid, name, opts) {
    opts = opts || {};
    const key = BT.util.olid(olid);
    const id = key ? authorId(key) : (opts.googleOnly ? googleAuthorId(opts.gbName || name) : '');
    if (!id) return null;

    const existing = await BT.repo.getFollow(id);
    if (existing) {
      await unfollow(id);
      return { id, type: 'author', name: existing.name || String(name || ''), following: false };
    }
    const row = await follow({
      type: 'author',
      olid: key,
      sourceId: key,
      name: String(name || '').trim(),
      gbName: String(opts.gbName || '').trim(),
      gbNameSource: opts.gbName ? 'volume' : 'seed',
    });
    if (!row) return null;
    return { id, type: 'author', name: row.name, following: true };
  }

  /* ══ ASKING OPEN LIBRARY ════════════════════════════════════════════════
     -> { works, numFound, error }

     Errors TRAVEL rather than becoming an empty catalogue. A follow that could
     not be checked because Open Library is down must not come back as "nothing
     scheduled": the diff would compare an empty list against the stored window,
     find nothing, and stamp the follow as checked — so an outage would silently
     eat every book listed during it. "We could not look" and "there is nothing"
     are different facts and nothing here collapses them.

     `search.json?author={OLID}&sort=new`, NOT `/authors/{id}/works.json`. The
     dedicated endpoint carries no publication years at all and is ordered by
     record edit time, so "new from your authors" built on it is permanently
     empty while appearing to work. */
  async function askOpenLibrary(row, opts) {
    opts = opts || {};
    const olid = BT.util.olid(row && (row.olid || row.sourceId) || '');
    if (!olid) return { works: [], numFound: 0, error: null, skipped: 'no-olid' };
    if (!BT.openlibrary || typeof BT.openlibrary.authorWorks !== 'function') {
      return { works: [], numFound: 0, error: new Error('The Open Library client is not loaded.') };
    }
    try {
      const res = await BT.openlibrary.authorWorks(olid, {
        limit: opts.limit || OL_PAGE,
        signal: opts.signal,
        /* ALWAYS fresh. The follow row IS the cache now, so a second cache in
           front of it could only answer "what did the last refresh see?" —
           which is already sitting in `row.works`, in a store that syncs and
           survives a cache clear. */
        fresh: true,
      });
      /* `checked: false` means the source was never actually asked. It is NOT
         "this author has nothing", and collapsing the two is how an outage comes
         to read as an empty catalogue. Older builds of the adapter do not send
         the field at all, so its ABSENCE has to mean "asked" — the opposite
         default would report every follow as unchecked on a mixed-version
         device and the roster would never give a hard answer again. */
      if (res && res.checked === false) {
        return { works: [], numFound: 0, error: null, skipped: 'not-checked' };
      }
      const docs = Array.isArray(res && res.docs) ? res.docs : [];
      /* The follow's own name is handed to every row, because the merge key is
         `title|person` and an author-works doc carries no author field at all.
         See workKey. */
      const who = String((row && (row.gbName || row.name)) || '');
      return {
        works: docs.map(d => olWork(d, who)).filter(Boolean),
        numFound: (res && res.numFound) || docs.length,
        /* How many the language filter removed, so a caller can say "40 of 47"
           rather than silently showing a short list. */
        dropped: (res && res.dropped) || 0,
        error: null,
      };
    } catch (e) {
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
      return { works: [], numFound: 0, error: e };
    }
  }

  /* One Open Library search doc, reduced to what a diff, a card and IndexedDB
     all need.

     `firstYear` and `latestYear` are kept SEPARATE and neither is called a
     publication date. `first_publish_year` is a computed minimum over the
     work's editions and is frequently wrong — The Alloy of Law, published 2011,
     reports 2001 (verified) — while max(publish_year) is the most recent
     printing anyone has catalogued, which is the closer thing to "this turned
     up recently". Open Library has no street dates: its dates are YEARS. */
  function olWork(doc, who) {
    const workId = BT.util.olid(doc && doc.key);
    if (!workId) return null;
    /* Through BT.lang, which knows that an Open Library `language` is an ARRAY
       of MARC codes carrying one entry per edition — so a novel with a Spanish
       translation declares ['eng','spa'] and is still the English book. ANY
       match is enough; requiring all would delete every translated classic.
       Absent from the field list today (see the seam in askOpenLibrary) and read
       anyway, so nothing here changes on the day it starts arriving. */
    if (!keepEnglishDoc(doc)) return null;
    const langs = (BT.lang && typeof BT.lang.codesOf === 'function')
      ? BT.lang.codesOf(doc.language) : [];
    const years = (Array.isArray(doc.publish_year) ? doc.publish_year : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0);
    const first = Number(doc.first_publish_year);
    const cover = Number(doc.cover_i);
    const latest = years.length ? Math.max.apply(null, years) : null;
    const date = latest || (Number.isFinite(first) && first > 0 ? first : null);
    return {
      key: workKey(doc.title, who),
      workId,
      volumeId: '',
      isbn13: '',
      title: String(doc.title || '').trim() || workId,
      date: date ? String(date) : '',
      dateSource: OL_SOURCE,
      firstYear: Number.isFinite(first) && first > 0 ? first : (latest || null),
      coverId: Number.isFinite(cover) && cover > 0 ? cover : null,
      lang: langs.length ? langs.join(',') : '',
      via: 'o',
    };
  }

  /* ══ ASKING GOOGLE ══════════════════════════════════════════════════════
     -> { works, totalItems, error, skipped }

     THE QUERY IS A NET AND THE VERIFICATION IS THE FILTER — rule 2. A plain
     quoted name is used rather than `inauthor:`, because `inauthor:"Stephen
     King"` returns ZERO (verified) while `q="Stephen King"` returns his books;
     and every returned volume is then checked against its own authors array, so
     the 300 books about Queen Victoria that `inauthor:Kiste` produces could not
     survive even if that operator were used.

     NOTHING IS SENT WITHOUT A KEY. Anonymous Books API access answers HTTP 429
     carrying `"quota_limit_value":"0"` — a quota of zero, not one we exhausted
     — so a keyless request is not a degraded version of this, it is a
     guaranteed error that spends a lane slot, a bucket token and four retries
     to be told something already known. */
  async function askGoogle(row, opts) {
    opts = opts || {};
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function') {
      return { works: [], totalItems: 0, error: null, skipped: 'no-client' };
    }
    if (!gb.enabled()) return { works: [], totalItems: 0, error: null, skipped: 'no-key' };
    const name = String((row && row.gbName) || (row && row.name) || '').trim();
    if (!name) return { works: [], totalItems: 0, error: null, skipped: 'no-name' };

    /* DELEGATED, NOT REIMPLEMENTED. 25-googlebooks.js owns every Google URL in
       this app, and `authorWorks` is its answer to this exact question: two
       arms, the credit check, the language filter and printing-grouping, all in
       the file that also owns the field lists and the quota. This used to be
       three hand-rolled `search()` slices here, which worked and was a second
       copy of a decision — the kind that drifts the day one of them learns
       something the other does not. */
    if (typeof gb.authorWorks !== 'function') {
      return { works: [], totalItems: 0, error:
        new Error('This build of the Google Books client cannot list an author.'),
        skipped: null };
    }

    let res;
    try {
      res = await gb.authorWorks(name, { signal: opts.signal, fresh: true });
    } catch (e) {
      if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
      return { works: [], totalItems: 0, error: e, skipped: null };
    }
    /* `checked: false` means the source was never actually asked — switched
       off, or the first arm refused before the second was attempted. It is NOT
       "this author has nothing", and collapsing the two is how an outage comes
       to read as an empty catalogue. */
    if (!res || !res.checked) {
      return { works: [], totalItems: 0, error: null, skipped: 'not-checked' };
    }

    /* ── DEPTH IS THIS FILE'S DECISION, NOT THE ADAPTER'S ────────────────
       `authorWorks` fetches TWO arms at offset 0 and no more, which is the
       right default for a lookup. It is not enough for a follow, and the
       shortfall is measured rather than suspected: on the two large catalogues
       here it returned 20 and 13 author-credited volumes where three pages of
       relevance returned 39 and 22, and the titles it missed included Brandon
       Sanderson's only forthcoming printing.

       So the extra pages are fetched HERE — the adapter still owns the query
       shape, the credit check, the language filter and the printing grouping;
       this file owns only "how much of one author is a follow worth", which is
       a budget question about a feature the adapter knows nothing about.
       Serialized and bounded: two extra requests, so a follow costs four Google
       calls and a roster of twenty stays inside a 400/day budget even if it is
       fully refreshed six times a day.

       Failures here are SWALLOWED rather than returned. Arm one already
       answered, so the author has a real list; a page-three timeout should
       shorten it, not turn a good answer into "could not check". */
    /* ── THE AUTHOR-FIELD ARM, AND WHY IT IS NOT THE ADAPTER'S PLAIN NAME ──
       `authorWorks` nets on a plain quoted name, which is a FULL-TEXT query —
       it matches every book that so much as MENTIONS the person. Measured
       live, three identical trials each, counting the volumes whose own
       `authors` array credits the followed writer out of the 20 Google
       returns:

           author              plain "Name"    inauthor:"Name"
           ──────────────────  ────────────    ───────────────
           Martha Wells              1               19
           Stephen King             13               20
           Gwendolyn Kiste           7               16
           Brandon Sanderson        20               20

       One credited volume out of twenty is the whole bug: *Platform Decay*,
       which Google dates 2026-05-05 and which is the FIRST hit for
       `inauthor:"Martha Wells"`, never reached this file at all, so the row
       fell back to Open Library's bare '2026' and rendered as a year.

       THE QUOTES ARE LOAD-BEARING and a bare surname is the trap:
       `inauthor:Kiste` credits 4 of 20 and pads the rest with books about
       Queen Victoria, while `inauthor:"Gwendolyn Kiste"` credits 16.

       `inauthor:"Stephen King"` is recorded in this repo as returning ZERO.
       It does not — it returns 20 of 20, three trials running. That endpoint
       sheds load with bare 503s often enough to counterfeit an empty
       catalogue: 13 of 37 probe requests needed a retry. No measurement of
       this API taken from a single request can be trusted, and nothing here
       may read a failed request as an empty one — which is what `checked` is
       for.

       This is an ARM, not a replacement. The adapter still owns the URL
       shape, the credit check, the language filter and the printing grouping;
       its own two arms still run and still contribute. */
    const extra = [];
    const extraVolumes = [];
    if (typeof gb.search === 'function' && typeof gb.creditsAuthor === 'function'
        && typeof gb.groupPrintings === 'function' && typeof gb.phrase === 'function') {
      const byAuthorField = 'inauthor:' + gb.phrase(name);
      for (const offset of GB_EXTRA_OFFSETS) {
        try {
          const page = await gb.search(byAuthorField, {
            rich: true, limit: GB_PER_PAGE, offset, signal: opts.signal, fresh: true,
          });
          if (!page || !page.checked) break;
          const credited = (page.items || []).filter(v => gb.creditsAuthor(v, name));
          if (!credited.length) continue;
          for (const w of gb.groupPrintings(credited)) extra.push(w);
          /* Kept for the byline count below. On the authors this arm exists for
             these ARE the verified volumes — the adapter's plain-name arms
             returned one for Martha Wells — so counting names without them
             would pick the follow's stored spelling off a single record. */
          for (const v of credited) extraVolumes.push(v);
        } catch (e) {
          if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
          console.warn('[follows] a Google page failed for', name, e && e.message);
          break;
        }
      }
    }

    const works = [];
    const names = new Map();
    const seen = new Set();
    for (const w of [].concat(res.works || [], extra)) {
      const hit = gbWork(w, name);
      /* Deduped on the MERGE KEY rather than the volume id, because the extra
         pages are grouped independently of the first two arms — the same book
         arrives as two different representative printings, and two rows under
         one key would diff against each other and read as a date change. */
      if (!hit || seen.has(hit.key)) continue;
      seen.add(hit.key);
      works.push(hit);
    }
    /* The exact strings Google printed for this person, counted off the VERIFIED
       volumes rather than off the grouped works, because a work carries only the
       representative printing's byline. */
    for (const vol of [].concat(res.volumes || [], extraVolumes)) {
      for (const credited of (((vol && vol.volumeInfo) || {}).authors || [])) {
        if (!creditsThisAuthor(credited, name)) continue;
        names.set(credited, (names.get(credited) || 0) + 1);
      }
    }

    return {
      works,
      totalItems: res.totalItems || works.length,
      error: null,
      skipped: null,
      /* Best exact string, by how often Google printed it. */
      gbName: bestName(names, name),
    };
  }

  /* One grouped Google work (25-googlebooks.js's shapeWork) reduced to the five
     scalars this file stores. Everything expensive that record carries — the
     description, the categories, the full ISBN list — is deliberately dropped:
     this row is written to the `follows` store, which travels in SYNC_STORES and
     through the encrypted cloud payload, so a roster of twenty would otherwise
     ship two thousand full volume records to every device on every publish. */
  function gbWork(w, wantName) {
    const title = String((w && w.title) || '').trim();
    if (!title) return null;
    const rel = w.release || w.firstRelease || null;
    /* The RAW string, not the parsed key, because releaseOfWork() re-derives the
       release on read and the raw is the only thing that can carry '2027' and
       'Fall 2027' as different facts. */
    const raw = String(w.latestRaw || w.firstRaw || '').trim();
    const firstParts = w.firstRelease ? BT.util.sortKeyToParts(w.firstRelease.sortKey) : null;
    return {
      key: workKey(title, wantName),
      workId: '',
      volumeId: String(w.volumeId || ''),
      isbn13: String(w.isbn13 || ''),
      title,
      date: raw || (rel && BT.util.skToISO(rel.sortKey)) || '',
      dateSource: GB_SOURCE,
      firstYear: (firstParts && firstParts.y) || null,
      coverId: null,
      thumb: String(w.coverUrl || ''),
      lang: String(w.language || ''),
      via: 'g',
    };
  }

  /* Does this credited name belong to the author we are following?

     BT.normalize.personMatches is the app's ONE person fold — 'J.R.R. Tolkien',
     'J. R. R. Tolkien' and 'John Ronald Reuel Tolkien' are one man and three
     strings, and a surname alone matches every King in print, so the key is
     `surname|first-initial`. Reused rather than re-derived so that this file,
     25-googlebooks and 61-view-search cannot disagree about who wrote what. */
  function creditsThisAuthor(credited, wantName) {
    const n = BT.normalize;
    if (n && typeof n.personMatches === 'function' && typeof n.personKey === 'function') {
      return n.personMatches(n.personKey(credited), n.personKey(wantName));
    }
    /* Only reachable if 38-normalize failed to parse. Surname-only, and
       therefore looser than the real rule — acceptable exactly once, as a
       degraded path, and precisely why the real rule lives somewhere else. */
    const want = [...localSurnames([wantName])][0];
    return !!want && localSurnames([credited]).has(want);
  }

  function localSurnames(names) {
    const out = new Set();
    for (const n of (names || [])) {
      const parts = BT.util.normalizeTitle(n).split(' ').filter(Boolean);
      /* Single-token names are real ('Homer', 'Colette') and are their own
         surname; for everything else the last token is the family name. */
      if (parts.length) out.add(parts[parts.length - 1]);
    }
    return out;
  }

  function bestName(names, fallback) {
    let best = '';
    let n = 0;
    for (const [k, c] of (names || [])) if (c > n) { best = k; n = c; }
    return best || fallback;
  }

  /* ══ THE UNION ════════════════════════════════════════════════════════════════════
     THE KEY IS BT.normalize.matchKey, AND NOT A COPY OF IT.

     There is no shared identifier to join on: Google has no OLIDs, and Open
     Library's author-works field list carries no ISBNs. So the join is
     "same title, same person", and 38-normalize.js owns that fold for the whole
     app precisely so that 25-googlebooks, 61-view-search and this file cannot
     answer "same book?" three slightly different ways. A private copy here is a
     second answer, and the symptom is a duplicate row that no call site can
     explain.

     THE AUTHOR PASSED IN IS ALWAYS THE FOLLOW'S OWN NAME, on both sides, and
     that is load-bearing rather than convenient. matchKey folds to
     `title|person`, and an Open Library author-works doc carries NO author field
     at all (AUTHOR_WORK_FIELDS is 'key,title,first_publish_year,publish_year,
     cover_i'). Keying the Open Library side on the title alone would produce
     `wind and truth` against Google's `wind and truth|sanderson-b`, so the two
     halves would never merge and every book either source knew about would
     appear twice. Every row in this list is by definition this author's, so
     supplying the name is not an assumption — it is the one fact the query
     already guaranteed.

     THE YEAR IS DELIBERATELY NOT PART OF THE KEY. Including it would defeat the
     entire purpose: Open Library's year for a work is frequently a decade early,
     so keying on it would refuse to merge exactly the records that most need
     merging — the ones where Google has the real date. */
  function workKey(title, author) {
    const n = BT.normalize;
    if (n && typeof n.matchKey === 'function') {
      const k = n.matchKey(title, author ? [author] : []);
      if (k) return k;
    }
    /* Only reachable if 38-normalize failed to parse, in which case the app has
       much larger problems; kept so a broken load degrades to a title-only join
       rather than to no catalogue at all. */
    return BT.util.normalizeTitle(String(title || ''))
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/^(the|an|a) /, '')
      .trim();
  }

  /* Two rows from the SAME source under one key — two printings of one book.

     THE FORWARD-LOOKING PRINTING WINS when there is one, and that is the user's
     own rule rather than an oversight: "i just want things listed with a
     publication date that is in the future from the current date". A 2026
     reissue of a 2024 novel HAS a 2026 publication date. `firstYear` keeps the
     earlier one, so the card can say the book itself is not new — which is the
     part that would otherwise be a lie by omission. */
  function mergeSameSource(a, b) {
    const ka = dayKeyOf(a);
    const kb = dayKeyOf(b);
    const today = BT.util.todaySortKey();
    const firstYear = pickFirstYear(a, b);
    const aheadA = ka != null && ka >= today;
    const aheadB = kb != null && kb >= today;

    let win = a;
    if (aheadA && aheadB) win = ka <= kb ? a : b;       // the sooner of two future printings
    else if (aheadB && !aheadA) win = b;
    else if (aheadA && !aheadB) win = a;
    else if (ka == null) win = b;
    else if (kb != null && kb > ka) win = b;             // both past: the newest printing

    const other = win === a ? b : a;
    return Object.assign({}, other, win, {
      firstYear,
      /* Never lose an identifier because the other printing carried it. */
      workId: win.workId || other.workId || '',
      volumeId: win.volumeId || other.volumeId || '',
      isbn13: win.isbn13 || other.isbn13 || '',
      coverId: win.coverId || other.coverId || null,
      thumb: win.thumb || other.thumb || '',
    });
  }

  function pickFirstYear(a, b) {
    const ys = [a && a.firstYear, b && b.firstYear].filter(y => Number.isFinite(y) && y > 0);
    return ys.length ? Math.min.apply(null, ys) : null;
  }

  /* The sort key this row's date supports, or null. */
  function dayKeyOf(w) {
    const rel = releaseOfWork(w);
    return (rel && rel.sortKey < BT.util.SK_UNKNOWN) ? rel.sortKey : null;
  }

  /* GOOGLE'S DATE WINS WHERE THEY DISAGREE — the requirement, stated as code.
     Open Library gives a bare year where Google gives 'YYYY-MM-DD' (verified:
     Wind and Truth, 2024 vs 2024-12-06), so taking the finer one is the same
     decision as taking Google's in every case that matters. Where Google's is
     no finer — an old paperback both call '1987' — the Open Library row's
     `workId` and cover are still kept, because those are things Google does not
     have. */
  function mergeAcrossSources(ol, gb) {
    if (!ol) return gb;
    if (!gb) return ol;
    const rank = p => (BT.normalize && BT.normalize.precisionRank)
      ? BT.normalize.precisionRank(p) : ({ unknown: 0, tba: 0, year: 1, quarter: 2, month: 3, day: 4 }[p] || 0);
    const rOl = releaseOfWork(ol);
    const rGb = releaseOfWork(gb);
    const useGoogle = rank(rGb.precision) >= rank(rOl.precision) && !!gb.date;
    return {
      key: gb.key || ol.key,
      /* BOTH identifiers survive the merge. The Open Library work id is what
         opens the detail pane (56-inspector resolves `book:openlibrary:` and
         `book:isbn:` and nothing else today); the Google volume id is what a
         future Google-aware pane would use, and what proves which record the
         date came from. */
      workId: ol.workId || gb.workId || '',
      volumeId: gb.volumeId || ol.volumeId || '',
      isbn13: gb.isbn13 || ol.isbn13 || '',
      /* Google's title, because it carries the leading article and the
         subtitle Open Library's MARC-derived records invert or drop. */
      title: gb.title || ol.title,
      date: useGoogle ? gb.date : ol.date,
      dateSource: useGoogle ? GB_SOURCE : OL_SOURCE,
      firstYear: pickFirstYear(ol, gb),
      coverId: ol.coverId || null,
      thumb: gb.thumb || '',
      lang: gb.lang || '',
      via: 'go',
    };
  }

  /* -> the merged catalogue, newest/furthest-ahead first, capped.

     Ordered before the cap so that what falls off the end is the oldest
     backlist and never anything forthcoming. */
  function unionWorks(olWorks, gbWorks) {
    const byKey = new Map();
    for (const w of (gbWorks || [])) {
      if (!w || !w.key) continue;
      const prev = byKey.get(w.key);
      byKey.set(w.key, prev ? mergeSameSource(prev, w) : w);
    }
    for (const w of (olWorks || [])) {
      if (!w || !w.key) continue;
      const prev = byKey.get(w.key);
      if (!prev) { byKey.set(w.key, w); continue; }
      byKey.set(w.key, prev.via === 'o' ? mergeSameSource(prev, w) : mergeAcrossSources(w, prev));
    }
    /* DECORATED, SORTED, UNDECORATED — not sorted with a comparator that
       derives the key. Deriving it inside the comparator means one full
       date-parse per COMPARISON rather than per row: a hundred works is about
       six hundred calls into BT.normalize.buildRelease, on the path that runs
       for every follow on every refresh. */
    const out = [...byKey.values()].map(w => {
      const k = dayKeyOf(w);
      return { w, k: k == null ? -1 : k };
    });
    out.sort((a, b) => (b.k - a.k) || String(a.w.title).localeCompare(String(b.w.title)));
    return out.slice(0, WORKS_CAP).map(x => x.w);
  }

  /* ── A REFRESH MUST NEVER BLUNT A DATE IT ALREADY HOLDS ─────────────────
     MEASURED, against the live API, on four identical back-to-back refreshes
     of one author: Google's author arms do NOT return a stable set for an
     identical query. `Boneset & Feathers` came back on three rounds and was
     simply missing from the fourth — Google 503s under load (observed here),
     `authorWorks` asks two fixed arms at offset 0, and relevance ordering
     shifts underneath them.

     On the round it went missing the union was rebuilt from Open Library
     alone, whose record for it is a bare '2020', and the stored '2020-11-03'
     was thrown away. The diff below then announced "date moved: 2020-11-03 →
     2020" — a book that had not moved at all, reported as news, on a refresh
     that had learned nothing. Worse, it flaps: the next round sees the volume
     again and announces the reverse, so one unstable upstream row becomes a
     permanent two-line-per-refresh feed spammer.

     So a COARSER answer that AGREES with the finer one we already hold is not
     information and does not overwrite it. A date that genuinely CONTRADICTS
     what we hold — a different year, a different month inside a month —
     passes straight through untouched, because that is the exact event this
     whole feature exists to catch. Runs BEFORE sharpenPass so a row we can
     already answer precisely never spends one of the day's Google requests
     being re-asked. */
  function keepSharpestDate(held, works) {
    const prev = new Map((held || []).map(w => [w.key, w]));
    const rank = p => (BT.normalize && BT.normalize.precisionRank)
      ? BT.normalize.precisionRank(p)
      : ({ unknown: 0, tba: 0, year: 1, quarter: 2, month: 3, day: 4 }[p] || 0);
    for (const w of works) {
      const was = prev.get(w.key);
      if (!was || !was.date) continue;
      /* Losing the date outright is the same loss in its worst form: it would
         drop the work out of every release window on #/people at once. */
      if (!w.date) {
        w.date = was.date;
        w.dateSource = was.dateSource || OL_SOURCE;
        if (was.sharpAt && !w.sharpAt) w.sharpAt = was.sharpAt;
        continue;
      }
      const rWas = releaseOfWork(was);
      const rNow = releaseOfWork(w);
      if (rank(rNow.precision) >= rank(rWas.precision)) continue;   // as sharp or sharper — take it
      /* Only when the coarse answer CONTAINS the sharp one. Anything else is a
         real disagreement and must survive to the diff. */
      const contains = BT.alerts && typeof BT.alerts.withinWindow === 'function'
        && BT.alerts.withinWindow(rNow.sortKey, rNow.precision, rWas.sortKey);
      if (!contains) continue;
      w.date = was.date;
      w.dateSource = was.dateSource || OL_SOURCE;
      if (was.sharpAt && !w.sharpAt) w.sharpAt = was.sharpAt;
    }
    return works;
  }

  /* The stored list, defended. Rows arrive here from IndexedDB and from another
     device's export, so nothing about their shape is guaranteed — and this is
     read on the render path of every row on #/people, where one malformed entry
     must cost one card rather than the page.

     ALSO THE V1 READER. A row written by the previous build carries
     `{ workId, title, firstYear, latestYear, coverId }` and no key, date or
     source. Those are converted on the way out rather than migrated on disk,
     so a device that has not refreshed yet still renders its cache correctly
     instead of showing an empty author. */
  function cachedWorks(row) {
    const out = [];
    for (const w of ((row && row.works) || [])) {
      if (!w) continue;
      if (w.key == null && w.workId) {                       // a v1 row
        out.push({
          key: workKey(w.title || w.workId),
          workId: w.workId, volumeId: '', isbn13: '',
          title: w.title || w.workId,
          date: String(w.latestYear || w.firstYear || ''),
          dateSource: OL_SOURCE,
          firstYear: Number.isFinite(w.firstYear) ? w.firstYear : null,
          coverId: Number.isFinite(w.coverId) ? w.coverId : null,
          thumb: '', lang: '', via: 'o',
        });
        continue;
      }
      if (!w.key) continue;
      out.push({
        key: w.key,
        workId: w.workId || '',
        volumeId: w.volumeId || '',
        isbn13: w.isbn13 || '',
        title: w.title || w.key,
        date: w.date || '',
        dateSource: w.dateSource || OL_SOURCE,
        firstYear: Number.isFinite(w.firstYear) ? w.firstYear : null,
        coverId: Number.isFinite(w.coverId) ? w.coverId : null,
        thumb: w.thumb || '',
        lang: w.lang || '',
        via: w.via || 'o',
      });
    }
    return out;
  }

  /* ══ IS THIS WORK STILL AHEAD OF US? ════════════════════════════════════
     A DATE MAY BE A YEAR, A MONTH OR A DAY, and the honest test is about the
     two ends of the WINDOW that date describes:

         a bare '2026'  │ Jan 1 ─────────────────────────── Dec 31
         today          │              ▲
         verdict        │ it could be behind us or ahead of us, and the record
                        │ genuinely does not say which

     · window ENDS before today   -> 'past'    certainly behind us
     · window STARTS after today  -> 'future'  certainly ahead of us
     · anything in between        -> 'maybe'   the window straddles today

     'maybe' IS SHOWN AND LABELLED, NEVER SILENTLY KEPT OR SILENTLY DROPPED.
     Google resolves most of them into real days — that is the whole reason it
     is primary — but Open Library-only rows can still land here, and dropping
     them would hide a book while keeping the confident sentence that says there
     is nothing to hide. */

  /* The LAST day a release could actually fall on. Its FIRST day is already the
     sort key — 01-util.js anchors vaguer precisions to the start of their
     window on purpose, so a bare 2027 sorts as 2027-01-01 — and holding both
     ends is what makes the three-way verdict possible instead of a coin flip. */
  function windowEnd(release) {
    const sk = release && release.sortKey;
    if (!Number.isFinite(sk) || sk >= BT.util.SK_UNKNOWN) return null;
    const p = BT.util.sortKeyToParts(sk);
    if (!p) return null;
    switch (release.precision) {
      case 'day':     return sk;
      case 'month':   return BT.util.endOfMonthSortKey(p.y, p.m);
      /* A quarter ends with its third month, read off the anchor month the
         engine already stored rather than off the raw string again. */
      case 'quarter': return BT.util.endOfMonthSortKey(p.y, BT.util.quarterOf(p.m) * 3);
      case 'year':    return BT.util.endOfMonthSortKey(p.y, 12);
      /* 'tba' and 'unknown' carry no window at all. Neither is a future date:
         "we do not know" and "it has not happened yet" are different facts, and
         a list that conflated them would be padded with undated backlist. */
      default:        return null;
    }
  }

  /* -> 'future' | 'maybe' | 'past' | 'unknown' */
  function futureness(release) {
    const end = windowEnd(release);
    if (end == null) return 'unknown';
    const today = BT.util.todaySortKey();
    /* `<=`, not `<`. A book that publishes TODAY is not published in the
       future. It is out; it is on a shelf in a shop this morning. */
    if (end <= today) return 'past';
    return release.sortKey > today ? 'future' : 'maybe';
  }

  /* The release a stored row supports, and not one grain more.

     `basis` says which QUESTION the date answers, and the two sources answer
     different ones. A Google volume is one printing with its own imprint date,
     so it is 'edition-published'; an Open Library search doc names no edition
     at all, so it stays on the half-weight 'work-first-published' rung. That
     difference is what stops a work-level year outranking a real street date
     when 38-normalize.js's pickRelease compares them. */
  function releaseOfWork(work) {
    const w = work || {};
    const google = w.dateSource === GB_SOURCE;
    return BT.normalize.buildRelease(String(w.date || ''), {
      basis: google ? 'edition-published' : 'work-first-published',
      source: google ? GB_SOURCE : OL_SOURCE,
      inPrint: !!(w.coverId || w.thumb || w.isbn13),
    });
  }

  /* ══ RELEASE WINDOWS ════════════════════════════════════════════════════
     Does this release fall in [from, to]?

     OVERLAP, not containment, and the difference is the whole reason an
     imprecise row is still useful. A bare '2027' describes the whole of 2027;
     asked for "next year" it belongs in the answer, and asked for "next month"
     it also technically overlaps — which is why the caller renders precision
     with the app's hatched date grammar rather than this function pretending
     the ambiguity away.

     Windows come from BT.util.releaseWindow so #/people and #/up agree about
     where "this month" ends. */
  function inWindow(release, from, to) {
    return windowFit(release, from, to) !== 'out';
  }

  /* -> 'in' | 'possible' | 'out'

     CONTAINMENT IS THE ANSWER, OVERLAP IS THE MAYBE, and the distinction is
     what stops the narrow windows filling with records that cannot answer them.

     Measured on the live data this feature was built against: Open Library
     dates `Isles of the Emberdark` as a bare '2026'. That describes January 1st
     to December 31st, which OVERLAPS every window on the strip — so under a
     plain overlap test that one row appeared under "Next week", "This month",
     "Next month" AND "End of year", four times, as though four different things
     were happening. It is one book, and the record does not say which week.

       in        the release's whole window fits inside the asked-for one, so
                 the record itself places the book there. '2026-09-15' asked
                 about September; a bare '2027' asked about next year.
       possible  the two overlap but the record is wider than the question. It
                 might land there and it might not, and no reading of the record
                 can settle it.
       out       no overlap at all.

     Both are SHOWN — 'possible' under its own heading with its own count, never
     silently dropped and never silently mixed in. Dropping it would hide a book
     while keeping the confident sentence that says there is nothing to hide. */
  function windowFit(release, from, to) {
    const start = release && release.sortKey;
    if (!Number.isFinite(start) || start >= BT.util.SK_UNKNOWN) return 'out';
    const end = windowEnd(release);
    if (end == null) return 'out';
    if (start > to || end < from) return 'out';
    return (start >= from && end <= to) ? 'in' : 'possible';
  }

  /* ── SHARPENING A YEAR INTO A DAY ──────────────────────────────────────
     -> a finer date string for this work, or ''.

     Open Library cannot answer "which day", so on its evidence alone a
     current-year work is stuck at 'maybe' for ever. Google can, and this is the
     targeted version of the same question the slices above ask broadly: one
     `intitle:+inauthor:` request for one title. Verified end to end —
     `Other Worlds Than These` was a bare '2026' from Open Library and came back
     2026-10-06.

     THE MATCH RULES ARE BORROWED, NOT REWRITTEN. confidentMatch() and
     releaseFromVolume() come straight out of 25-googlebooks.js, so the year
     gate, the folded-title test and the shared-surname test are the same three
     the library's own date upgrade uses. A second, laxer copy of those rules is
     precisely how a stranger's publication date ends up on the reader's book.

     SO IT CAN ONLY EVER SHARPEN, NEVER MOVE. The year gate refuses any volume
     whose year disagrees with the one we already hold, so the worst this can do
     is pick the wrong day inside the right year — which cannot resurrect a book
     from a past year, and cannot invent a future one. */
  async function sharpenWork(work, authorName, opts) {
    opts = opts || {};
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function' || !gb.enabled()) return '';
    if (typeof gb.confidentMatch !== 'function' || typeof gb.releaseFromVolume !== 'function') return '';

    const release = opts.release || releaseOfWork(work);
    /* Only a bare year is worth a request. Anything finer is already better
       than Google's own field can be trusted to improve. */
    if (release.precision !== 'year') return '';

    const parts = BT.util.sortKeyToParts(release.sortKey);
    const year = parts && parts.y;
    const title = String((work && work.title) || '').trim();
    const author = String(authorName || '').trim();
    if (!year || !title || !author) return '';

    /* The pseudo-item confidentMatch() reads: a title, an author list, and the
       release we already believe. Assembled rather than fetched, because the
       entire point of this screen is books the reader does NOT own — there is
       no stored item to hand over, and adding one to get a date would be the
       silent-add bug this view was already fixed for. */
    const probe = { title, authors: [{ name: author }], release };
    const res = await gb.search(
      `intitle:${phrase(title)} inauthor:${phrase(author)}`,
      { limit: 20, signal: opts.signal });

    const rank = p => BT.normalize.precisionRank(p);
    let best = null;
    for (const vol of (res && res.items) || []) {
      /* Language first: `Islas de la Ascuaoscura / Isles of the Emberdark`
         carries a 2026-03-24 that would otherwise sharpen an English work into
         its Spanish translation's street date — measured, on this exact book. */
      if (!keepEnglish(vol)) continue;
      if (!gb.confidentMatch(probe, vol, year)) continue;
      const hit = gb.releaseFromVolume(vol);
      if (!hit || rank(hit.release.precision) <= rank(release.precision)) continue;
      const rel = hit.release;
      /* Finest first, then EARLIEST — and for this filter earliest is the
         conservative end rather than merely the consistent one. A work with a
         March hardback and a November paperback in one year came out in March;
         taking November would leave a book already sitting in shops filed under
         a heading that says it is still to come. */
      if (!best
          || rank(rel.precision) > rank(best.precision)
          || (rank(rel.precision) === rank(best.precision) && rel.sortKey < best.sortKey)) {
        best = rel;
      }
    }
    return best ? (BT.util.skToISO(best.sortKey) || '') : '';
  }

  /* Kept under its old name for any caller that still holds it — the Following
     page used to run this pass itself. It now returns a RELEASE, as it always
     did, so nothing that reads it has to change. */
  async function sharpenYear(work, authorName, opts) {
    const iso = await sharpenWork(work, authorName, opts);
    if (!iso) return null;
    return BT.normalize.buildRelease(iso, {
      basis: 'edition-published', source: GB_SOURCE, inPrint: true,
    });
  }

  /* A quoted phrase for Google's `intitle:` / `inauthor:` and for a plain
     name query. Embedded quotes are REPLACED rather than escaped, because
     Google's query grammar has no escape sequence at all — a stray quote closes
     the phrase early and silently widens the search into an unrelated result
     set, which the author check would then be the only thing standing between
     us and a stranger's bibliography. */
  function phrase(s) {
    const gb = BT.googlebooks;
    if (gb && typeof gb.phrase === 'function') return gb.phrase(s);
    return '"' + String(s == null ? '' : s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  }

  /* ══ THE CHECK, THE DIFF, AND THE WRITE ═════════════════════════════════
     -> { row, cold, added, changed, error }   , or null if the follow is gone.

     THE ONLY WRITER of works / worksAt / knownKeys / news. Everything about
     "what changed" is decided here, once, so the Following page and the
     Activity feed cannot disagree about it.

     UNCONDITIONAL: this always asks. The per-follow cooldown lives one level up
     in the queue worker, because "is this worth re-asking?" is a scheduling
     question and this function's job is to answer "what do the catalogues say
     right now".

     BOTH SOURCES ARE ASKED BEFORE ANY VERDICT IS REACHED — requirement 1. The
     per-source outcome is recorded on `srcState`, and 67-view-people.js will
     not print "Nothing scheduled" unless both of them answered. */
  async function refreshOne(idOrRow, opts) {
    opts = opts || {};
    const id = typeof idOrRow === 'string' ? idOrRow : (idOrRow && idOrRow.id);
    if (!id) return null;

    /* Read before, and again after. A refresh holds a row across network round
       trips and unfollowing during one is ordinary; a blind put would resurrect
       a row the reader deleted. */
    let row = await get(id);
    if (!row) return null;

    const ol = await askOpenLibrary(row, { signal: opts.signal });
    const gb = await askGoogle(row, { signal: opts.signal });

    row = await get(id);
    if (!row) return null;

    const now = Date.now();
    const srcState = {
      openlibrary: {
        at: now,
        ok: !ol.error && !ol.skipped,
        skipped: ol.skipped || '',
        error: ol.error ? errText(ol.error) : '',
        found: ol.works.length,
        numFound: ol.numFound,
      },
      googlebooks: {
        at: now,
        ok: !gb.error && !gb.skipped,
        skipped: gb.skipped || '',
        error: gb.error ? errText(gb.error) : '',
        found: gb.works.length,
        numFound: gb.totalItems,
      },
    };

    /* ── NEITHER SOURCE ANSWERED: NOTHING IS LEARNED, NOTHING IS WRITTEN ──
       `lastCheckedAt`, `works` and the baseline are left exactly as they were,
       so the follow stays due and is retried — and the page goes on rendering
       the cache it already had rather than blanking. Only the attempt is
       recorded, which is what lets a row say "could not check, 3 minutes ago"
       over a list that is still the truth as of this morning. */
    const anyOk = srcState.openlibrary.ok || srcState.googlebooks.ok;
    if (!anyOk) {
      row.lastTriedAt = now;
      row.srcState = srcState;
      row.lastError = bothFailedMessage(srcState);
      await BT.repo.putFollow(row);
      return { row, cold: false, added: [], changed: [], emitted: [],
               error: new Error(row.lastError) };
    }

    const held = cachedWorks(row);
    let works = unionWorks(ol.works, gb.works);

    /* ── AN EMPTY ANSWER MUST NOT ERASE A GOOD CACHE ──────────────────────
       Open Library answers HTTP 200 with `{"numFound":0,"docs":[]}` for a great
       many things that are not "this author has published nothing": an OLID
       merged away, a query issued while the search index is rebuilding, the
       read-only maintenance windows the service takes. Google answers a
       `totalItems: 0` for a name it simply did not match this minute.

       Without this branch one bad afternoon replaces sixty stored works with
       zero, stamps the follow as successfully checked, and the row then says
       "Nothing scheduled" in a confident sentence with nothing on screen to
       suggest it is wrong. That is the single most damaging thing this feature
       can do, because it is indistinguishable from a correct answer. */
    if (!works.length && held.length) {
      row.lastTriedAt = now;
      row.srcState = srcState;
      row.lastError = 'Both catalogues answered with an empty list for this author. '
        + 'The books below are what was last read successfully.';
      await BT.repo.putFollow(row);
      return { row, cold: false, added: [], changed: [], emitted: [],
               error: new Error(row.lastError) };
    }

    /* An unstable upstream must not cost us a date we already have. See
       keepSharpestDate — this is what stops a missing Google volume silently
       downgrading a day back to a bare year and firing a false "date moved". */
    works = keepSharpestDate(held, works);

    /* ── SHARPEN WHAT IS STILL UNDECIDABLE ────────────────────────────────
       Only the rows where the answer actually turns on it: a bare year whose
       window straddles today or lies ahead. Persisted onto the stored work, so
       this costs requests once per title rather than once per page view — which
       is what the previous arrangement did, in the view, against a Map that
       died with the render. */
    works = await sharpenPass(row, works, opts);

    /* ── THE BASELINE ─────────────────────────────────────────────────────
       COLD — rule 4. Following an author with 190 works must store 190 keys and
       say nothing, or the act of following IS a flood.

       MIGRATING — the same rule, for the day the source changed. A row written
       by the previous build has a `knownWorkIds` full of Open Library work
       OLIDs; the union is keyed on folded titles, and Google contributes rows
       Open Library never had. Diffing the new keys against the old ids would
       report EVERY BOOK AS NEW for every follow on the roster at once. So the
       first check under this schema re-baselines silently, exactly like a cold
       one, and `knownWorkIds` is left on the row untouched rather than deleted
       — this user syncs real data and a migration that destroys a field
       destroys it on every device at once. */
    const known = new Set();
    for (const k of (row.knownKeys || [])) if (k) known.add(String(k));
    const migrating = (row.schema || 1) < SCHEMA;
    const cold = !row.worksAt && known.size === 0 && !(row.knownWorkIds || []).length;
    const quiet = cold || migrating;

    const prev = new Map(held.map(w => [w.key, w]));
    const added = [];
    const changed = [];
    for (const w of works) {
      if (!known.has(w.key)) {
        if (!quiet) added.push(w);
        continue;
      }
      const was = prev.get(w.key);
      /* Known, but not in the last stored list — there is no date to compare
         against, so there is nothing to say. */
      if (!was) continue;
      const from = dateOf(was);
      const to = dateOf(w);
      /* Both ends must be real. `'' -> 2026-10-06` is a cataloguing improvement
         on a record that never carried a date, not a book whose date moved, and
         announcing it as movement is the kind of line that teaches a reader to
         stop reading the feed. */
      if (!from || !to || from === to) continue;
      /* A YEAR BECOMING A DAY INSIDE THAT YEAR IS NOT MOVEMENT. Google
         sharpening '2026' into '2026-10-06' is us learning something, and
         without this test every single row Google improves would be announced
         as a date change on the refresh that improved it — which, on the pass
         that switches the app over to Google, is the whole catalogue. */
      if (BT.alerts && typeof BT.alerts.withinWindow === 'function') {
        const rWas = releaseOfWork(was);
        const rNow = releaseOfWork(w);
        if (BT.alerts.withinWindow(rWas.sortKey, rWas.precision, rNow.sortKey)) continue;
        /* AND THE SAME TEST THE OTHER WAY ROUND — losing detail is not movement
           either. '2020-11-03' becoming a bare '2020' is us knowing LESS about
           the same book, not the book being rescheduled, and announcing it
           teaches the reader to stop reading the feed. keepSharpestDate above
           should already have prevented the downgrade; this is the second line
           of the same defence, because it is also simply true — and it covers
           the case that guard cannot, where the sharp date came from a source
           that has genuinely retracted it. */
        if (BT.alerts.withinWindow(rNow.sortKey, rNow.precision, rWas.sortKey)) continue;
      }
      changed.push({ work: w, from, to });
    }

    for (const w of works) known.add(w.key);

    row.works = works.map(compact);
    row.worksAt = now;
    row.numFound = Math.max(ol.numFound || 0, works.length);
    row.knownKeys = Array.from(known).slice(-KNOWN_CAP);
    row.lastCheckedAt = now;
    row.lastTriedAt = now;
    row.srcState = srcState;
    row.lastError = partialMessage(srcState);
    row.schema = SCHEMA;
    row.news = mergeNews(row.news, added, changed, now);
    if (!row.newsSeenAt) row.newsSeenAt = row.addedAt || now;
    /* THE GOOGLE NAME, CONFIRMED. Captured at follow time as a seed from
       whatever the follow button had to hand, and settled here against what
       Google's own volumes actually print.

       `gbNameSource` moves to 'volume' EVEN WHEN THE STRING DID NOT CHANGE, and
       that is the point rather than a detail: a seed that turns out to be
       exactly right has been VERIFIED, and leaving it marked 'seed' would mean
       the row could never tell a guess that happened to work from a guess
       nobody has checked. `askGoogle` only returns a name it counted off
       verified volumes, so its presence is the confirmation. */
    if (gb.gbName && srcState.googlebooks.found) {
      if (gb.gbName !== row.gbName) { row.gbName = gb.gbName; row.gbNameAt = now; }
      row.gbNameSource = 'volume';
    }
    await BT.repo.putFollow(row);

    const out = { row, cold: quiet, added, changed, error: null };
    /* ANNOUNCED HERE, NOT IN THE QUEUE WORKER, and the difference is the whole
       "the diff IS the alert" claim. Announcing from the loop meant the feed was
       written only when a refresh arrived through that ONE door, so a direct
       refreshOne() from the Activity screen would update the cache and silently
       produce no news.

       Ordered AFTER putFollow so the cache is durable first: a tab closed
       between the two loses a feed row, which is invisible, rather than leaving
       a stored list the feed has already reported on, which would swallow the
       change for ever. */
    out.emitted = await announce(out);
    return out;
  }

  /* Drop empty fields on the way to disk. This row travels in SYNC_STORES and
     through the encrypted cloud payload, so a roster of twenty authors is
     ~1,900 stored works — and `volumeId: ''` twenty times a row is real bytes
     for no information. */
  function compact(w) {
    const out = { key: w.key, title: w.title };
    if (w.workId) out.workId = w.workId;
    if (w.volumeId) out.volumeId = w.volumeId;
    if (w.isbn13) out.isbn13 = w.isbn13;
    if (w.date) out.date = w.date;
    if (w.dateSource && w.dateSource !== OL_SOURCE) out.dateSource = w.dateSource;
    if (Number.isFinite(w.firstYear)) out.firstYear = w.firstYear;
    if (Number.isFinite(w.coverId)) out.coverId = w.coverId;
    if (w.thumb) out.thumb = w.thumb;
    if (w.lang) out.lang = w.lang;
    if (w.via && w.via !== 'o') out.via = w.via;
    if (w.sharpAt) out.sharpAt = w.sharpAt;
    return out;
  }

  const dateOf = w => String((w && w.date) || '');

  /* One targeted Google lookup per undecidable row, budgeted and remembered.

     `sharpAt` marks a row we have already spent a request on, whether or not it
     produced anything. Without it a work Google genuinely has no finer date for
     would be re-asked on every single refresh for ever — the reader's quota
     spent, repeatedly, to be told the same nothing. */
  async function sharpenPass(row, works, opts) {
    const gb = BT.googlebooks;
    if (!gb || typeof gb.enabled !== 'function' || !gb.enabled()) return works;
    const name = String(row.gbName || row.name || '').trim();
    if (!name) return works;

    const held = new Map(cachedWorks(row).map(w => [w.key, w]));
    let spent = 0;
    for (const w of works) {
      if (spent >= SHARPEN_PER_REFRESH) break;
      /* Carry forward what a previous pass learned, so the budget is spent on
         new questions rather than on re-asking answered ones. */
      const was = held.get(w.key);
      if (was && was.sharpAt) w.sharpAt = was.sharpAt;
      if (w.sharpAt) continue;
      if (w.dateSource === GB_SOURCE) continue;         // already Google's answer
      const rel = releaseOfWork(w);
      if (rel.precision !== 'year') continue;
      const verdict = futureness(rel);
      /* Only where the answer turns on it. A bare 1987 is past on every reading
         of the window, so a day would change nothing anyone can see. */
      if (verdict !== 'maybe' && verdict !== 'future') continue;

      spent++;
      try {
        const iso = await sharpenWork(w, name, { release: rel, signal: opts && opts.signal });
        w.sharpAt = Date.now();
        if (iso) { w.date = iso; w.dateSource = GB_SOURCE; }
      } catch (e) {
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
        /* Enrichment is a nicety and must never be why a check fails. The row
           keeps its honest year-only date and is retried next time — `sharpAt`
           is deliberately NOT stamped on a failure. */
        console.warn('[follows] date lookup failed for', w.title, e && e.message);
      }
    }
    return works;
  }

  function errText(e) {
    return (e && e.message) || String(e || 'unknown error');
  }

  /* The sentence a row shows when NEITHER source could be reached. Names which
     ones and why, because "could not check" with no reason is the message that
     sends somebody looking for a bug in their own library. */
  function bothFailedMessage(s) {
    const bits = [];
    if (s.openlibrary.error) bits.push(`Open Library: ${s.openlibrary.error}`);
    if (s.googlebooks.error) bits.push(`Google Books: ${s.googlebooks.error}`);
    if (!bits.length) bits.push('neither catalogue could be reached');
    return bits.join(' · ');
  }

  /* One source answered and the other did not. NOT an error — the list below it
     is real — but the row must not then say "nothing scheduled" as though both
     had been consulted. */
  function partialMessage(s) {
    if (s.openlibrary.ok && s.googlebooks.ok) return '';
    if (!s.openlibrary.ok && s.openlibrary.error) return `Open Library: ${s.openlibrary.error}`;
    if (!s.googlebooks.ok && s.googlebooks.error) return `Google Books: ${s.googlebooks.error}`;
    return '';
  }

  /* -> which sources actually answered on the last check, for the view.

     A follow may only be described as having NOTHING COMING when `complete` is
     true. Everything else is a claim about us, not about the catalogues, and
     the difference is the whole of requirement 1: "how would we ensure that
     both resources are searched before determining an author has books or not
     coming out?"

     A SOURCE THAT IS SWITCHED OFF IS NOT A SOURCE THAT FAILED, and collapsing
     the two would make the app permanently unable to answer anything. With no
     Google key there is no Google half to wait for — the app falls back to Open
     Library, says so ONCE and actionably (67-view-people puts a Settings link at
     the top of the page, not a sentence on every row), and goes on giving hard
     answers on the evidence it has. `needsKey` is what carries that, separately
     from `missing`, which is reserved for a source that was asked and did not
     answer. */
  function coverageOf(row) {
    const s = (row && row.srcState) || {};
    const ol = s.openlibrary || {};
    const gb = s.googlebooks || {};
    const hasOlid = !!(row && (row.olid || row.sourceId));
    const gbOff = gb.skipped === 'no-key' || gb.skipped === 'no-client'
                  || gb.skipped === 'no-name';
    /* At least one source has to have actually answered. Without this a follow
       with no OLID, on a build with no key, would report itself complete having
       asked nobody anything. */
    const asked = (hasOlid && !!ol.ok) || !!gb.ok;
    return {
      openlibrary: !!ol.ok,
      googlebooks: !!gb.ok,
      /* An author with no OLID cannot be asked of Open Library, and that is not
         a failure — it is a follow only one catalogue knows about. */
      olApplicable: hasOlid,
      gbOff,
      missing: [
        hasOlid && !ol.ok ? 'Open Library' : '',
        !gbOff && !gb.ok ? 'Google Books' : '',
      ].filter(Boolean),
      complete: asked && (!hasOlid || !!ol.ok) && (gbOff || !!gb.ok),
      needsKey: gbOff && (gb.skipped === 'no-key' || gb.skipped === 'no-client'),
    };
  }

  /* The per-author news feed: what this refresh learned, newest last, capped.

     Kept ON THE FOLLOW ROW rather than derived from the Activity feed. Activity
     is one shared stream with one shared read state; this is "what has changed
     for THIS author since you last looked at THIS author", which is the question
     the row's badge answers. Reading Activity for it would mean opening the
     Following page marked the whole feed read. */
  function mergeNews(existing, added, changed, at) {
    const out = Array.isArray(existing) ? existing.slice() : [];
    for (const w of added) {
      out.push({ at, kind: 'new', key: w.key, workId: w.workId || '',
                 title: w.title, from: null, to: w.date || '' });
    }
    for (const c of changed) {
      out.push({ at, kind: 'moved', key: c.work.key, workId: c.work.workId || '',
                 title: c.work.title, from: c.from, to: c.to });
    }
    if (out.length > NEWS_CAP) out.splice(0, out.length - NEWS_CAP);
    return out;
  }

  /* ── The unread count ──────────────────────────────────────────────────
     One definition, read by the sidebar badge and by every row on the page, so
     the number in the tree and the number on the row can never disagree. */
  function unseenNews(row) {
    const seen = (row && row.newsSeenAt) || 0;
    return ((row && row.news) || []).filter(n => n && n.at > seen);
  }

  function unseenCount(rows) {
    let n = 0;
    for (const f of (rows || [])) if (isAuthorRow(f)) n += unseenNews(f).length;
    return n;
  }

  /* Clears one author's badge. Called when the reader has actually EXPANDED and
     read the row — see the note in 67-view-people.js — so it behaves like an
     unread count and not like a number that vanishes on navigation.

     Nothing is deleted: `news` stays, so the row can still show what changed and
     when. Only the mark moves. */
  async function markNewsSeen(id) {
    const row = await get(id);
    if (!row) return false;
    const unseen = unseenNews(row).length;
    if (!unseen) return false;
    row.newsSeenAt = Date.now();
    await BT.repo.putFollow(row);
    return true;
  }

  /* ══ BROWSING ONE AUTHOR'S WHOLE CATALOGUE ══════════════════════════════
     -> { works, more, totalItems, errors }

     "See works", and it deliberately works for an author NOBODY FOLLOWS — the
     reader wants to look before they commit, and requiring a follow first is
     the same dead end the empty Activity screen used to be. So this takes a
     bare identity rather than a stored row, asks both sources with whatever
     halves of it exist, and never writes anything.

     PAGED THROUGH GOOGLE, because it is the side with depth: `page` walks
     `startIndex`, while Open Library's one author page is fetched on the first
     page only and merged in. Nothing is cached on a follow row — this is a
     browse, and writing it would put a second, differently-shaped answer behind
     the same screen as the cache. */
  async function browseAuthor(identity, opts) {
    opts = opts || {};
    const page = Math.max(0, opts.page || 0);
    const probe = {
      olid: BT.util.olid((identity && identity.olid) || ''),
      gbName: String((identity && identity.gbName) || (identity && identity.name) || '').trim(),
      name: String((identity && identity.name) || '').trim(),
    };
    const errors = [];
    let olWorks = [];
    let numFound = 0;

    if (page === 0 && probe.olid) {
      const ol = await askOpenLibrary(probe, { signal: opts.signal });
      if (ol.error) errors.push(`Open Library: ${errText(ol.error)}`);
      olWorks = ol.works;
      numFound = ol.numFound;
    }

    const gb = BT.googlebooks;
    let gbWorks = [];
    let totalItems = 0;
    let more = false;
    if (gb && typeof gb.enabled === 'function' && gb.enabled() && probe.gbName) {
      try {
        /* `search` + `creditsAuthor` + `groupPrintings` rather than
           `authorWorks`, and this is the ONE place that decomposition is right:
           authorWorks fuses two fixed arms into a single answer, which is what a
           refresh wants and what a PAGED browse cannot use. Every piece is still
           the adapter's own — the query builder, the credit check, the language
           filter inside search(), and the printing grouping — so the two paths
           can differ in how much they fetch without ever differing in what
           counts as this author's book. */
        const res = await gb.search(gb.phrase(probe.gbName), {
          rich: true,
          limit: GB_PER_PAGE,
          offset: page * GB_PER_PAGE,
          signal: opts.signal,
        });
        const raw = (res && res.items) || [];
        const credited = raw.filter(v => gb.creditsAuthor(v, probe.gbName));
        for (const w of gb.groupPrintings(credited)) {
          const hit = gbWork(w, probe.gbName);
          if (hit) gbWorks.push(hit);
        }
        totalItems = Number(res && res.totalItems) || 0;
        /* `totalItems` is an ESTIMATE over a loose match and routinely reports
           300 for a query with one true answer, so it is NOT what decides
           whether there is another page. A full slice is — and the count that
           matters is what the ENDPOINT returned, before the language filter and
           before the credit check, or paging stops early on an author whose
           translations happen to fill a page. */
        more = (res && res.checked) && (raw.length + (res.dropped || 0)) >= 20;
      } catch (e) {
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) throw e;
        errors.push(`Google Books: ${errText(e)}`);
      }
    } else if (!probe.gbName) {
      errors.push('No Google Books author name for this record.');
    }

    return { works: unionWorks(olWorks, gbWorks), more, totalItems, numFound, errors };
  }

  /* ══ THE ONE SERIALIZED REFRESHER ═══════════════════════════════════════
     ONE queue. ONE worker. Every caller — the Following page on entry, its
     Refresh buttons, following a new author, the Activity screen's "Check now",
     and the background sweep at startup — pushes onto this and nothing else.

     THAT IS THE RATE LIMIT, and it is why there is no per-sweep cap. Open
     Library sustains about one request a second; Google's free tier is ~1,000 a
     day and BT.NET_POLICY caps this app at 400. The answer is SHAPE instead of
     SIZE:

       · one follow at a time, a plain loop with one await, never Promise.all;
       · a per-follow cooldown (WORKS_TTL) so an automatic pass over a roster
         refreshed an hour ago costs ZERO requests on either source;
       · the queue yields to interactive work — see hold() — so an author
         lookup in the search box never queues behind thirty roster refreshes;
       · sharpened dates are STORED, so the Google half of a settled roster
         costs three slices rather than three slices plus a lookup per title;
       · progress is emitted, so a long walk is visible rather than mysterious. */

  const queue = [];          // [{ id, force }] — in service order
  let worker = null;         // the single in-flight pump(), or null
  let cancelled = false;
  let holds = 0;             // interactive work that outranks the queue
  const stats = { running: false, total: 0, done: 0, ok: 0, failed: 0, name: '', reason: '' };

  /* Interactive priority. The author search box calls hold() before its request
     and release() after it, because both share one 1-req/sec bucket in 05-net —
     and a lookup that lands behind a roster walk takes thirty seconds to answer
     a question the reader asked three keystrokes ago. */
  function hold() { holds++; }
  function release() { holds = Math.max(0, holds - 1); }

  async function waitForQuiet() {
    let waited = 0;
    /* Bounded. A hold that leaks — a search that threw between hold() and
       release() — must cost a few seconds, never wedge the refresher for the
       rest of the session. */
    while (holds > 0 && waited < HOLD_MAX_MS && !cancelled) {
      await BT.util.sleep(120);
      waited += 120;
    }
  }

  function emitProgress() {
    /* Through BT.repo so there is one event bus in the app. Every existing
       subscriber filters on the event name, so a name they do not know is inert
       — which is what makes adding one safe. */
    if (BT.repo && typeof BT.repo.emit === 'function') {
      BT.repo.emit('follows:progress', Object.assign({}, stats));
    }
  }

  function enqueue(id, opts) {
    const at = queue.findIndex(j => j.id === id);
    if (at >= 0) {
      if (opts.force) queue[at].force = true;
      /* Already waiting, and now wanted NOW — following an author puts their
         row on screen saying "checking", so it has to jump the roster. */
      if (opts.front && at > 0) queue.unshift(queue.splice(at, 1)[0]);
      return;
    }
    const job = { id, force: !!opts.force };
    if (opts.front) queue.unshift(job); else queue.push(job);
  }

  /* Is this follow's cache current enough to leave alone? Explicit refreshes
     never ask.

     A row still on the OLD SCHEMA is never fresh, whatever its timestamp says.
     Its stored works predate the union and predate Google entirely, so leaving
     it alone would mean the switch to the new source never happened for the
     follows that were checked most recently. */
  const isFresh = row => !!(row && row.worksAt && (row.schema || 1) >= SCHEMA
                            && (Date.now() - row.worksAt) < WORKS_TTL);

  async function drain() {
    while (queue.length && !cancelled) {
      const job = queue.shift();
      const row = await get(job.id);
      stats.done++;
      if (!row || row.muted) { done(job.id, null, 'gone'); continue; }
      stats.name = row.name || '';
      emitProgress();

      if (!job.force && isFresh(row)) {
        /* Nothing asked for, nothing spent. The cache is inside its window, so
           the screen is already showing the current answer. This branch is why
           the per-sweep cap could be removed: an automatic pass over a roster
           refreshed an hour ago is pure IndexedDB. */
        stats.ok++;
        done(job.id, null, 'fresh');
        continue;
      }

      await waitForQuiet();
      if (cancelled) break;

      let out = null;
      try {
        out = await refreshOne(row, {});
      } catch (e) {
        if (e && (e.kind === 'abort' || e.name === 'AbortError')) break;
        console.warn('[follows] refresh threw for', row.name, e && e.message);
      }

      if (out && !out.error) stats.ok++;
      else stats.failed++;
      done(job.id, out, 'checked');
    }
  }

  /* Per follow, so a page can repaint ONE row as its own answer lands rather
     than all of them at the end.

     Emitted for EVERY outcome including the two that did no work — a muted or
     deleted row, and a cache still inside its window. A listener that only heard
     about follows which were actually fetched would leave the other two showing
     "Checking…" until the whole queue drained. */
  function done(id, out, why) {
    if (BT.repo && typeof BT.repo.emit === 'function') {
      BT.repo.emit('follows:updated', {
        id,
        why,
        added: (out && out.added) || [],
        changed: (out && out.changed) || [],
        error: (out && out.error) || null,
      });
    }
    emitProgress();
  }

  /* THE ASSIGNMENT MUST HAPPEN BEFORE THE CLEAR CAN RUN, and getting that
     backwards wedges the whole feature permanently.

     This was written as `worker = (async () => { try { …loop… } finally
     { worker = null; } })();` — correct only if the loop body suspends at least
     once. It does not when the queue is EMPTY: the async function then runs
     start to finish synchronously, the `finally` sets `worker = null` while the
     outer assignment has not happened yet, and the assignment afterwards
     installs an already-settled promise into `worker`. From that moment
     `if (worker) return worker` is true for ever.

     It reproduced on every single boot, because boot sweeps before there is
     anything to sweep. Observed directly: `isRefreshing() === true` with
     `running: false` and `queued: 3`, three follows sitting in the queue, and
     zero requests made.

     `.finally()` fixes it structurally: its callback is always deferred to a
     microtask, so `worker` is assigned first no matter how the body behaves. */
  function pump() {
    if (worker) return worker;
    cancelled = false;
    stats.running = true;
    stats.done = 0;
    stats.ok = 0;
    stats.failed = 0;
    emitProgress();

    worker = drain()
      .catch(e => { console.warn('[follows] the refresher stopped', e && e.message); })
      .finally(() => {
        worker = null;
        stats.running = false;
        stats.name = '';
        emitProgress();
      });
    return worker;
  }

  /* ── The diff IS the alert ─────────────────────────────────────────────
     The one seam between this file and 45-alerts.js, and it points this way on
     purpose. Alerts used to be a PARALLEL POLLING SYSTEM with its own schedule
     and its own baseline, which is how the feed and the Following page ended up
     disagreeing about what an author had out. Now there is one refresh, one
     diff, and the feed is a log of it.

     Feature-detected and caught, because a feed row is a nicety and the cache
     write above is the thing that matters. */
  async function announce(out) {
    const a = BT.alerts;
    if (!a || typeof a.recordFollowDiff !== 'function') return [];
    if (!out.added.length && !out.changed.length) return [];
    try { return (await a.recordFollowDiff(out)) || []; }
    catch (e) {
      console.warn('[follows] could not record the diff', e && e.message);
      return [];
    }
  }

  /* -> a promise that settles when the queue drains.

     opts: { ids, force, front, reason }
       ids     which follows, defaulting to the whole roster
       force   ignore the per-follow cooldown (a button was pressed)
       front   jump the queue (an author was just followed)
       reason  a word for the progress line ('startup', 'page', 'manual') */
  async function refreshAll(opts) {
    opts = opts || {};
    let rows = await all();
    rows = rows.filter(f => !f.muted);
    if (opts.ids && opts.ids.length) {
      const want = new Set(opts.ids);
      rows = rows.filter(f => want.has(f.id));
    }
    /* Least-recently-checked first, so an interrupted walk still comes round
       and the follow most likely to have changed answers first. */
    rows.sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));

    for (const f of rows) enqueue(f.id, opts);
    stats.total = queue.length + (stats.running ? 1 : 0);
    stats.reason = opts.reason || '';

    await pump();
    /* Drained, but something may have been enqueued in the window between the
       loop reading `queue.length` for the last time and the worker clearing
       itself — a second Refresh press, or a follow added while the walk was
       finishing. Without this those jobs would sit in the queue until the next
       unrelated refresh, which is the shape of bug reported as "the refresh
       button did nothing that time". */
    if (queue.length) await pump();
    return { ok: stats.ok, failed: stats.failed, checked: stats.done };
  }

  const isRefreshing = () => !!worker;
  const progress = () => Object.assign({}, stats, { queued: queue.length });
  function cancelRefresh() { cancelled = true; queue.length = 0; }

  /* ══ RETIRING PUBLISHER FOLLOWS ═════════════════════════════════════════
     Runs once, from boot, and is idempotent afterwards.

     THE ROWS ARE COPIED BEFORE THEY ARE DELETED. This user is actively syncing
     real data, and a migration that silently drops rows from a store that
     replicates is a migration that drops them on every device at once with no
     way back. The copy lands in `meta`, which does not sync — so it is a local
     escape hatch on the machine that ran the migration. */
  async function retirePublisherFollows() {
    const rows = (await BT.repo.allFollows()).filter(f => f && f.type === 'publisher');
    if (!rows.length) return 0;
    try {
      await BT.repo.metaSet('follows.retiredPublishers', {
        at: Date.now(),
        rows: rows.map(r => ({ id: r.id, name: r.name, sourceId: r.sourceId, addedAt: r.addedAt })),
      });
    } catch (e) {
      /* If the copy cannot be written, the delete does not happen. A row that is
         merely stale is a smaller problem than one that is gone. */
      console.warn('[follows] could not archive publisher follows; leaving them in place', e);
      return 0;
    }
    for (const r of rows) await BT.repo.deleteFollow(r.id);
    console.info(`[follows] retired ${rows.length} publisher follow(s); a copy is in meta.follows.retiredPublishers`);
    return rows.length;
  }

  /* ══ SEEDING THE DUAL IDENTITY ══════════════════════════════════════════
     Runs once from boot, and writes ONE field on rows that predate it.

     A follow stored by the previous build has an OLID and no `gbName` at all,
     so until this runs the primary source cannot be asked about it — askGoogle
     would skip on 'no-name' and the roster would quietly stay Open Library-only.
     The display name is the seed, exactly as it is for a new follow, and the
     first check replaces it with what Google's own volumes print.

     NOTHING IS DELETED and no key changes: `knownWorkIds` and `works` are left
     exactly as they are, because the first refresh under the new schema needs
     to see them to know it is migrating rather than cold. */
  async function seedGoogleNames() {
    const rows = await all();
    let n = 0;
    for (const r of rows) {
      if (r.gbName) continue;
      const name = String(r.name || '').trim();
      if (!name) continue;
      r.gbName = name;
      r.gbNameSource = 'seed';
      r.gbNameAt = Date.now();
      if (!r.olid) r.olid = BT.util.olid(r.sourceId || '') || '';
      await BT.repo.putFollow(r);
      n++;
    }
    if (n) console.info(`[follows] seeded a Google Books author name on ${n} follow(s)`);
    return n;
  }

  return {
    toggleAuthor,
    isFollowing, follow, unfollow, all, get,
    authorId, googleAuthorId,
    /* The catalogue: how to ask each source, how to read the stored answer, and
       the one function that turns the first into the second. */
    askOpenLibrary, askGoogle, cachedWorks, refreshOne, browseAuthor,
    /* Which sources actually answered. A view may only say "nothing coming"
       when `coverageOf(row).complete` is true — requirement 1, enforced at the
       one place that knows. */
    coverageOf,
    /* The refresher. `hold`/`release` are the interactive-priority pair the
       author search box uses; nothing else should touch them. */
    refreshAll, isRefreshing, cancelRefresh, progress, hold, release,
    /* News, counted in exactly one place so the sidebar and the rows agree. */
    unseenNews, unseenCount, markNewsSeen,
    /* The forthcoming test, exported as pieces rather than one boolean, because
       the caller needs all of them: the release to RENDER, the verdict to BAND,
       the window end to explain itself, and inWindow for the release-window
       toggle. A boolean would collapse 'maybe' into one of its neighbours at the
       only point where the distinction is visible. */
    releaseOfWork, futureness, windowEnd, inWindow, windowFit, sharpenYear, workKey,
    /* The English gate, exported so the console and a test can assert the rule
       that cannot be seen from a rendered row: an undeclared language is KEPT. */
    keepEnglish,
    retirePublisherFollows, seedGoogleNames,
    /* Exposed so the sweep, 16-cloud's merge and the console can assert the
       invariants that cannot be seen from a stored row. */
    KNOWN_CAP, WORKS_CAP, WORKS_TTL, NEWS_CAP, SCHEMA,
  };
})();
