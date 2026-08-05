/* ══════════════════════════════════════════════════════════════════════════
   BookTrak — configuration
   Loaded first. Defines the single global `BT` namespace.

   BookTrak ships from ackley14.github.io/Lorelaibrary, which is the SAME
   browser origin as its sibling MovieTrak at /entertainmentwatch. localStorage
   and IndexedDB are scoped to the origin, not the path, so every key in this
   app is prefixed `bt.` and the database is named `booktrak`. A stray `mt.`
   key here does not fail loudly — it quietly reaches into the other app's
   state. Treat the prefix as load-bearing.
   ══════════════════════════════════════════════════════════════════════════ */

window.BT = window.BT || {};

/* ── API KEYS ──────────────────────────────────────────────────────────────
   Nothing is baked here, and that is not an oversight — it is what the two
   sources actually require.

   Google Books (PRIMARY) — user-supplied key ONLY. It is the primary source for
                            search, metadata and — the reason for the whole
                            arrangement — publication dates and forthcoming
                            titles. Measured live against a real key:

                              q=dune          -> Frank Herbert's Dune at #1,
                                                 correctly attributed
                              Wind and Truth  -> publishedDate '2024-12-06'

                            Open Library answers the first query with Children
                            of Dune at #1 and the real novel eighth, credited to
                            the wrong Herbert, and it cannot answer the second
                            at all: its dates are years by construction.

                            Keyless Google Books is DEAD — an unauthenticated
                            volumes request answers HTTP 429 with
                            "quota_limit_value":"0", a quota of zero rather than
                            a quota we exceeded. So there is no key to bake and
                            no anonymous fallback to degrade to.
                            Get one: https://console.cloud.google.com/apis

   Open Library (RETAINED) — NO key, no signup, no quota page, and it stays
                            wired for the two things Google structurally cannot
                            do: the WORK/EDITION GRAPH (every ISBN a work is
                            known by, which is what the "Specify edition" picker
                            and the scanner's candidate namespace are built on)
                            and STABLE AUTHOR OLIDs (a Google volume carries an
                            author NAME and nothing else — no id space at all).
                            It is also the whole app's fallback: with no Google
                            key BookTrak still searches, still adds, still
                            scans. It just does it with year-granular dates.

   Anything set in Settings is stored in this browser only and WINS over the
   baked value — which, since nothing is baked, means "is the only value".
   ────────────────────────────────────────────────────────────────────────── */
BT.BAKED_KEYS = {
  /* Deliberately empty. Left in place so the shape matches MovieTrak's and so
     it is obvious this is a decision rather than a missing line. */
  googlebooks: '',
};

BT.config = (function () {
  const LS_SETTINGS = 'bt.settings.v1';

  const DEFAULTS = {
    /* Open Library's language filter takes MARC/ISO codes ('eng'), Google
       Books answers a two-letter 'en', and edition records spell it
       '/languages/eng'. We store the SHORT form and let each adapter widen it —
       storing a wide form would leak one source's vocabulary into the settings
       file that we then have to migrate. BT.lang below is the one reader. */
    language: 'en',
    region: 'US',
    /* Every genre bucket visible by default. `general` is the neutral
       catch-all and is included so that switching it off actually hides the
       unclassifiable pile rather than silently pinning it on.

       Spelled out rather than built from BT.GENRE_BUCKETS because this IIFE
       runs the moment the file is parsed and that array is declared further
       down — reaching for it here would read `undefined` and hand every user
       an empty genre map. Keep the two lists in step by hand.

       A settings blob saved before the Fantasy/SF split still carries
       `fantasysf: true`, and the Object.assign in load() preserves it. That is
       harmless: nothing reads this map yet (the tree builds its genre rows
       from the library itself), and a stale key costs one line of JSON. */
    genres: {
      fiction: true,
      historical: true,
      fantasy: true,
      scifi: true,
      mystery: true,
      horror: true,
      romance: true,
      youngadult: true,
      nonfiction: true,
      biography: true,
      graphic: true,
      general: true,
    },
    /* GENRES THE USER INVENTED. `[{ id, label, keywords: [], hue }]`, and the
       one part of the genre system that is data rather than code.

       Empty by default, and it stays a plain array here: everything that reads
       a genre — the tree, the list, the inspector's chips, the recalculation
       rules and the injected CSS — is derived from it by BT.genres.rebuild(),
       which is also the only thing that validates it. Nothing else in the app
       should index into this list, because a settings file can be hand-edited
       or imported from another device and the raw shape is therefore untrusted.

       `id` is stored rather than re-derived from the label on every boot, and
       that is deliberate: a stored book carries the id, so re-slugging a
       renamed label would orphan every record filed under it. Rename the label,
       keep the id. See BT.genres for the namespacing rules. */
    customGenres: [],
    keys: { googlebooks: '' },
    /* Open Library asks API consumers to identify themselves so they can
       contact you before they block you. Optional, empty by default, and never
       leaves this browser except in the request it is attached to. */
    contactEmail: '',
  };

  let settings = load();

  function load() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return structuredCloneSafe(DEFAULTS);
      const parsed = JSON.parse(raw);
      return Object.assign(structuredCloneSafe(DEFAULTS), parsed, {
        keys: Object.assign({}, DEFAULTS.keys, parsed.keys || {}),
        genres: Object.assign({}, DEFAULTS.genres, parsed.genres || {}),
        /* Shape-checked here and CONTENT-checked in BT.genres.rebuild(). The
           guard is not paranoia about our own writer: this key survives an
           import from another device and a hand-edited localStorage, and a
           non-array here would throw inside the first `for…of` that touched it
           — at boot, in the file that every other module is loaded after. */
        customGenres: Array.isArray(parsed.customGenres) ? parsed.customGenres : [],
      });
    } catch (_) {
      return structuredCloneSafe(DEFAULTS);
    }
  }

  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

  function save() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
    catch (e) { console.warn('[config] could not persist settings', e); }
  }

  return {
    /* Override (this browser) beats baked (the repo). */
    key(source) {
      const own = (settings.keys && settings.keys[source] || '').trim();
      return own || (BT.BAKED_KEYS[source] || '').trim();
    },
    /* The gate for every optional source. Open Library never calls this —
       it has no key — so `hasKey('googlebooks')` is effectively "is the
       enrichment path switched on at all". */
    hasKey(source) { return !!this.key(source); },
    /* True when the key in play came from Settings rather than the repo.
       Always true here, since nothing is baked, but kept so the Settings view
       can keep saying "stored in this browser only" from one source of truth. */
    keyIsLocal(source) { return !!(settings.keys && (settings.keys[source] || '').trim()); },
    setKey(source, value) {
      settings.keys = settings.keys || {};
      settings.keys[source] = (value || '').trim();
      save();
    },

    get(k) { return settings[k]; },
    set(k, v) { settings[k] = v; save(); },
    all() { return settings; },
    /* Export/import moves settings but NEVER keys — allow-list, not deny-list.
       `contactEmail` is also withheld: an export is meant to be committed to a
       GitHub repo, and a real email address sitting in a public JSON file next
       to someone's reading history is a leak the user did not ask for. It is
       one field, re-entered in seconds. */
    exportable() {
      return {
        language: settings.language,
        region: settings.region,
        genres: settings.genres,
        /* Custom genres TRAVEL, and they have to: a book in the same export
           carries `x-weird-fiction` in its `genres` array, so a library
           imported without this list would show that book filed under nothing
           the app can name. They are also the only setting here that is
           authored rather than configured — losing them on a device move would
           be losing work, not losing a preference. */
        customGenres: settings.customGenres,
      };
    },
    importSettings(obj) {
      if (!obj || typeof obj !== 'object') return;
      const allow = ['language', 'region', 'genres', 'customGenres'];
      for (const k of allow) if (k in obj) settings[k] = obj[k];
      save();
      /* The imported list is raw — another device's export, or a file somebody
         edited. rebuild() is what validates it, re-registers the labels and
         repaints the injected CSS; without this call the app would carry the
         new ids in its records and know nothing about them until a reload. */
      if (BT.genres) BT.genres.rebuild();
    },
    reset() {
      settings = structuredCloneSafe(DEFAULTS);
      save();
      if (BT.genres) BT.genres.rebuild();
    },
  };
})();

/* ══ THE LANGUAGE FILTER ═══════════════════════════════════════════════════
   ONE helper, used by every DISCOVERY surface: search, the author bibliographies
   behind Following, and the editions picker. Defined here rather than in an
   adapter because three different files with three different spellings of "is
   this English" is three different answers, and the disagreement is invisible —
   a book present on one screen and missing from the next reads as a bug in the
   app rather than as two filters.

   ── THE RULE, AND WHY IT IS NOT `=== 'en'` ────────────────────────────────
   KEEP anything that declares nothing. EXCLUDE only what positively declares
   another language.

   That asymmetry is load-bearing and is the difference between a filter and a
   deletion. Language is one of the most commonly ABSENT fields in both
   catalogues: Open Library edition records omit `languages` constantly, and a
   thin Google volume — which is exactly the shape a forthcoming title has,
   because nobody has catalogued it properly yet — routinely carries no
   `language` at all. A strict `=== 'en'` therefore removes the newest and
   least-catalogued records first, which is precisely the half of the catalogue
   this app was pivoted to Google Books to see.

   ── SERVER-SIDE FILTERING IS NOT THE SAME THING, AND IS NOT USED ──────────
   Google's `langRestrict=en` and Open Library's `language=eng` both filter on
   a DECLARED value, so both drop the undeclared records this helper keeps.
   They also cannot be un-applied once a result set comes back. So the filtering
   happens here, on the client, over whatever the endpoint returned.

   ── SCANNING IS EXEMPT, AND THE EXEMPTION IS STRUCTURAL ───────────────────
   A book the reader physically scanned is in their hands. Whatever language it
   is in, it is theirs, and an app that refused to record it because a barcode
   resolved to a Spanish printing would be worse than useless — it would be
   wrong about a fact the reader can see.

   So this is never called from an IDENTITY path: BT.openlibrary.byIsbn,
   editionByIsbn, lookupUid and hydrate, and BT.googlebooks.byIsbn and volume()
   all resolve a specific object the reader named, and none of them filters.
   Only DISCOVERY paths filter — the ones that answer "what else is out there",
   where a Spanish printing is noise rather than an answer. The asymmetry is
   enforced by which functions call this rather than by a flag, because a flag
   defaults to something and the wrong default here silently eats scans.
   ══════════════════════════════════════════════════════════════════════════ */
BT.lang = (function () {

  /* Codes that mean "nobody recorded one" rather than naming a language.
     `und` is ISO 639-2 for undetermined, `mul` for multiple, `zxx` for "no
     linguistic content" (a wordless picture book, a score). All three are a
     cataloguer declining to answer, so all three are treated as absent. */
  const UNDECLARED = new Set(['', 'und', 'mul', 'zxx', 'unk', 'none']);

  /* Every three-letter MARC code the app can produce, folded back to the short
     form the setting is stored in. The reverse of 20-openlibrary's marcLang,
     kept here so both directions live beside the setting they translate. */
  const FROM_MARC = {
    eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it',
    por: 'pt', dut: 'nl', nld: 'nl', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh',
    kor: 'ko', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', pol: 'pl', cze: 'cs',
    ces: 'cs', tur: 'tr', ara: 'ar', heb: 'he', lat: 'la', gre: 'el', ell: 'el',
  };

  /* Anything -> a short code, or ''. Eats every shape the two catalogues use:
       'en'                        Google Books volumeInfo.language
       'en-GB'                     Google, occasionally, on regional records
       'eng'                       Open Library search docs
       '/languages/eng'            Open Library edition records
       { key: '/languages/eng' }   Open Library edition records, wrapped */
  function short(v) {
    if (v == null) return '';
    const raw = typeof v === 'string' ? v : (v.key || v.name || '');
    /* The code is the LAST path segment and the part before any region tag.
       Matched rather than sliced because '/languages/eng' and 'en-GB' need
       opposite ends of the string. */
    const m = /([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)?\s*$/.exec(String(raw).trim());
    if (!m) return '';
    const code = m[1].toLowerCase();
    if (UNDECLARED.has(code)) return '';
    return code.length === 3 ? (FROM_MARC[code] || code) : code;
  }

  /* A value (scalar or array) -> the distinct short codes it declares. */
  function codesOf(v) {
    const list = Array.isArray(v) ? v : [v];
    const out = [];
    for (const one of list) {
      const c = short(one);
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    return out;
  }

  const home = () => short(BT.config.get('language')) || 'en';

  /* THE TEST. `true` when this record may be shown.

     ANY declared code matching is enough, not all of them. Open Library's
     search docs carry the union of every edition's language, so a novel written
     in English with a French translation catalogued against the same work
     declares ['eng','fre'] — and that work is still the English book the reader
     is looking for. Requiring all would delete every translated classic. */
  function accepts(v) {
    const codes = codesOf(v);
    if (!codes.length) return true;          // undeclared is kept — see the header
    return codes.indexOf(home()) >= 0;
  }

  /* The three record shapes, named, so no call site has to remember which field
     a given payload spells it in. Each is one line and exists so that a future
     fourth source adds a function here rather than a `.language ||
     .languages || .lang` chain at a call site. */
  const acceptsVolume  = vol => accepts(vol && vol.volumeInfo && vol.volumeInfo.language);
  const acceptsDoc     = doc => accepts(doc && doc.language);
  const acceptsEdition = raw => accepts((raw && (raw.languages || raw.language)) || null);

  /* Filter a list, reporting how many went. The COUNT is the point: a surface
     that silently shows eleven of forty rows is a surface that tells the reader
     their book does not exist, so every caller is handed the number and can say
     so. Rows are kept in the order they arrived. */
  function keep(list, read) {
    const kept = [];
    let dropped = 0;
    for (const row of (list || [])) {
      if (read(row)) kept.push(row); else dropped++;
    }
    return { kept, dropped };
  }

  return { accepts, acceptsVolume, acceptsDoc, acceptsEdition, keep, codesOf, short, home };
})();

/* ── Network policy, per source ───────────────────────────────────────────
   Each source is throttled according to what it actually enforces — verified
   against the providers' own pages, because these limits are different in kind
   and treating them alike either wastes the generous one or gets us blocked on
   the tight one.

   openlibrary — the docs state 1 request/second anonymously, raised to about
                 3/second for clients that send an identifying User-Agent, and
                 they explicitly forbid using openlibrary.org as a backend for
                 a high-traffic service. We are one person's library, opened by
                 hand, so we sit inside that. The honest caveat: a browser
                 CANNOT set User-Agent — it is a forbidden request header, and
                 fetch() silently ignores any attempt — so the `contactEmail`
                 setting is the only identification we can offer. rps:3 is
                 therefore a short-burst ceiling, not a sustained rate; the
                 bucket empties in a second or two and the app then idles.
   covers      — covers.openlibrary.org is a SEPARATE service with its own
                 documented cap: 100 requests per IP per 5 minutes (≈0.33/s
                 sustained). Higher concurrency than the API because a grid of
                 covers wants to paint at once, but a much smaller bucket.
   googlebooks — only ever used when the user supplied a key. Google's default
                 project quota is 1,000 volume requests/day; the budget below
                 is deliberately well under it so enrichment can never be the
                 reason a user's own key gets throttled elsewhere. The key gate
                 sits in 05-net's get() and again in js/25-googlebooks.js, so a
                 keyless install issues NO request here at all — an anonymous
                 volumes call answers 429 with "quota_limit_value":"0", and
                 four of those in a row would trip the circuit breaker for a
                 source that is merely switched off.

   `timeout` is per ATTEMPT, in ms. Without one, a host whose origin is down
   but whose CDN is up leaves the request hanging for as long as that CDN waits
   — and openlibrary.org under load returns 503s slowly rather than quickly,
   so two retries with no timeout is a minute of blank screen before any
   fallback can start. */
BT.NET_POLICY = {
  openlibrary: { rps: 3,   concurrency: 2, retries: 2, dailyBudget: null, monthlyBudget: null, timeout: 12000 },
  /* Images, not JSON. retries:1 because a cover that 404s is not going to
     appear on the second ask, and a library view can fire a hundred of these
     — a retry storm here is what actually trips the 100-per-5-minutes cap. */
  covers:      { rps: 2,   concurrency: 3, retries: 1, dailyBudget: null, monthlyBudget: null, timeout: 10000 },
  /* retries:4, unlike covers, and measured rather than guessed. The volumes
     endpoint sheds load HARD and recovers instantly: twenty identical requests
     against a valid key, sent back to back, answered

         with `fields`:     503 200 503 503 503 503 503 200 503 200
         without `fields`:  503 503 200 503 200 200 503 503 503 200

     — twelve 503s out of twenty, every one of them
     `{"error":{"code":503,"reason":"backendFailed"}}`, and the very next
     attempt on the identical URL succeeds. (Both rows are there because the
     partial-response `fields` parameter was the obvious suspect and is
     innocent; the rate is the same without it.)

     At three attempts that is a 0.6³ ≈ 22% chance of giving up on a book whose
     date Google is holding and would have handed over on the fourth ask —
     which is exactly what happened to Project Hail Mary in testing: three
     attempts, three 503s, no upgrade. At five it is ≈8%.

     This is affordable because retries cost bucket TOKENS but NOT budget
     units: budgetTake() is called once per get(), before the attempt loop, so
     five attempts spend one unit of the daily allowance, the same as one. The
     only real price is latency, and this path is a lazy background upgrade
     that paints when it lands rather than something a screen is waiting on.
     A lookup that still fails is not stamped as checked, so the next open of
     that pane simply asks again.

     THE BUDGET WENT UP WITH THE PIVOT, from 400 to 800, and the arithmetic is
     worth stating because it is the constraint the whole Google half lives
     inside. Google's free tier is ~1,000 requests/day against a key that
     belongs to the user, and Google is now on the SEARCH path rather than only
     the enrichment one:

         a search                     1 request per settled query (debounced)
         an author's bibliography     2 requests (relevance + newest — see
                                      BT.googlebooks.authorWorks)
         a date upgrade               1 request per book, once per month

     A forty-author roster costs 80 requests to refresh completely, a heavy
     day's searching maybe 60, and the library's date enrichment is spread over
     BT.TTL.gbDateRecheck. 800 leaves two hundred of the user's own allowance
     for whatever else that key is doing, which is the point of stopping short:
     the app must never be the reason somebody's key gets throttled somewhere
     else. Exceeding it degrades to Open Library rather than failing. */
  googlebooks: { rps: 2,   concurrency: 2, retries: 4, dailyBudget: 800,  monthlyBudget: null, timeout: 10000 },
};

/* ── Cache TTLs (ms) ──────────────────────────────────────────────────────
   These are much longer than MovieTrak's equivalents, on purpose. MovieTrak
   caches release dates, which genuinely move: a film slips a fortnight and the
   whole Releases view is wrong. A book's bibliographic record does not move.
   Once "Dune, Chilton Books, 1965, 412 pages" is true it stays true forever;
   what changes is the long tail of edition records being tidied by volunteers,
   which nobody is waiting on. So the cheapest correct answer here is a long
   cache, and re-fetching a work every few hours would be pure waste.

   HARD_TTL is a hygiene ceiling rather than a licence term — Open Library's
   data is openly licensed and imposes no caching limit, unlike TMDB's six
   months — so it exists only to guarantee nothing outlives a schema change.
   Boot purges anything older. */
const DAY = 86400000;
BT.TTL = {
  /* Short. A search is a live question and the user is watching. */
  search:       10 * 60 * 1000,
  work:         7 * DAY,
  /* Longest of the record TTLs: an edition is a frozen physical artefact.
     Page count, publisher and ISBN of a 1991 mass-market paperback are not
     going to be different next month. */
  edition:      30 * DAY,
  /* The editions LIST is shorter than an edition itself, because the list does
     grow — new printings get catalogued, and a scanned copy the user owns may
     only have been added to Open Library last week. */
  editionsList: 7 * DAY,
  author:       7 * DAY,
  /* Cover availability changes when a volunteer uploads one, which is the only
     reason this is not infinite. */
  covers:       30 * DAY,

  /* ── Google Books ──────────────────────────────────────────────────────
     A volume record is the same frozen artefact an edition record is, so it
     gets the edition's TTL rather than the shorter search one — even when the
     lookup that found it was a title search. What we cache is the ANSWER
     about a book, not the query that reached it.

     `gbDateRecheck` is a different thing entirely and is not a cache: it is
     how long we wait before asking Google AGAIN about a book whose date it
     could not improve. Without it, every open of a 1965 novel's detail pane
     spends a request re-learning that Google also only has '1965'. The free
     tier is ~1,000 requests/day against the user's own key, so the default
     behaviour for the long tail of a library has to be "ask once, remember
     that the answer was no". */
  gbVolume:     30 * DAY,
  gbDateRecheck: 30 * DAY,

  /* A SEARCH is a live question and takes the short TTL, same as Open
     Library's. Deliberately NOT gbVolume: the thing being cached is the ANSWER
     TO A QUERY, not a record about a book, and the whole reason this app now
     leads with Google is that its index gains forthcoming titles — a query
     cached for a month would be a month blind to exactly what it is for. */
  gbSearch:     10 * 60 * 1000,

  /* An author's bibliography sits between the two. It is a query, so it goes
     stale; but the follows refresher already has its own cooldown
     (BT.SWEEP.cooldownMs) and this only has to stop two screens asking the same
     question inside one session. An hour is long enough for that and short
     enough that "check now" after a book is announced actually finds it. */
  gbAuthorWorks: 60 * 60 * 1000,

  HARD_TTL:     150 * DAY,
};

/* ── Refresh tiers ────────────────────────────────────────────────────────
   Governs how often a tracked item is re-checked. Keeps a 1965 novel from
   being polled like an announced title with a street date next month. Most of
   a book library lives in T4 forever, which is exactly the point. */
BT.TIERS = {
  T0: { ttl: 12 * 3600e3, weight: 8 },   // publishes within days
  T1: { ttl: 2 * DAY,     weight: 4 },   // publishes soon, or currently reading
  T2: { ttl: 14 * DAY,    weight: 2 },   // announced, dated, far out
  T3: { ttl: 30 * DAY,    weight: 1 },   // announced, no date / speculative
  T4: { ttl: 180 * DAY,   weight: 0.2 }, // published and settled — the bulk
  T5: { ttl: Infinity,    weight: 0 },   // user stopped tracking
};

BT.SWEEP = {
  cooldownMs: 4 * 3600e3,     // auto-sweeps no more often than this
  /* Budgets are per source per sweep. Covers gets the largest share because a
     cover fetch is the cheapest possible request and the most visible miss. */
  autoBudget: { openlibrary: 40, covers: 30, googlebooks: 10 },
  manualBudget: { openlibrary: 150, covers: 120, googlebooks: 40 },
  hiddenMsBeforeRecheck: 30 * 60 * 1000,
};

/* ── The work→editions bridge ─────────────────────────────────────────────
   Google is the primary catalogue now and it has NO WORK CONCEPT: no editions
   endpoint, no work id, no `related:` — a volume carries its own ISBNs and
   nothing else. Verified. So a book added from Google arrives with nothing for
   "Specify edition" or "all known ISBNs for this book" to stand on, and the
   only way back into that graph is one Open Library lookup on an ISBN
   (`/isbn/{isbn13}.json` → `works[0].key`). Open Library's ISBN coverage is far
   better than its search, so arriving with an exact code usually works — but
   not for a brand-new release, which is precisely where Google is strongest and
   Open Library has nothing catalogued yet.

   These two numbers pace the RETRY of that lookup, and both exist because a
   miss is not cached: 05-net stores successful payloads only, so a 404 on an
   uncatalogued ISBN costs a real request every single time it is asked.

   `retryEveryMs` is the floor between two automatic attempts on one book. It is
   the work TTL rather than something shorter because the thing being waited on
   is a volunteer cataloguing a book, which happens on the scale of weeks. The
   reader is never held to it — the picker's own retry is `force`.

   `giveUpAfterMs` is when a book stops riding its own refresh tier for this and
   drops to the half-yearly poke. NOT "never again": Open Library genuinely does
   catalogue books years late, and two requests a year is not churn. What it
   ends is the weekly one. */
BT.EDITION_GRAPH = {
  retryEveryMs: 7 * DAY,
  giveUpAfterMs: 90 * DAY,
};

/* ── Genre bucketing ──────────────────────────────────────────────────────
   Twelve buckets, matched in order — FIRST rule that hits wins, so the specific
   buckets must precede the general ones. This ordering is not cosmetic:
   "Fantasy fiction", "Detective and mystery stories" and "Love stories" all
   contain or imply `fiction`, so if `fiction` were tested first every genre in
   the app would collapse into one.

   READ THIS BEFORE MOVING A RULE. 38-normalize applies the table ONE SUBJECT
   STRING AT A TIME: within a string the first hit wins and matching stops, but
   a record with six subjects gets six passes and can therefore legitimately
   land in up to three buckets (the cap, ranked by hit count, ties broken by
   position in this table). So order decides two different things —
     · which bucket a SINGLE ambiguous string goes to
       ('Juvenile Fiction / Fantasy & Magic' is one string, and only one rule
        can have it), and
     · which bucket wins a tie when two buckets got one hit each.
   Overlap across strings is not a bug and is often the correct answer: a
   middle-grade fantasy catalogued with both 'Juvenile fiction' and 'Fantasy
   fiction' reaches Young Adult AND Fantasy, which is what a reader browsing
   either shelf expects to find.

   The input is raw and hostile. Open Library `subjects` are library-cataloguing
   strings contributed over decades by different institutions — you will see
   'Fiction', 'FICTION / Fantasy / Epic', 'Science fiction, American',
   'Detective and mystery stories', 'Roman', 'Fiction, general' and
   'juvenile fiction' for what a reader would call four genres. Google Books
   `categories` are BISAC headings, which are cleaner but shaped differently
   ('Juvenile Fiction', 'Biography & Autobiography'). One table has to eat both.

   Like MovieTrak's RAWG tag stoplist, this table is a permanent maintenance
   burden and the single biggest quality lever in the app — a book landing in
   the wrong bucket is the most visible kind of wrong, because the user knows
   what they read. Add rules when you see a miss. Do not try to be clever;
   an ordered list of regexes that a human can read and correct beats anything
   that guesses. */
BT.GENRE_RULES = [
  {
    /* Horror sits FIRST — above fantasy, and above every bucket added since —
       and that placement is the whole reason it works. Horror and fantasy
       share half a vocabulary, and fantasy's entries are the looser ones: its
       bare /\bsupernatural\b/ swallows 'Supernatural fiction' whole, so under
       the first-rule-wins scan a King would surface as Fantasy and this bucket
       would never earn a book. Checked live against Open Library after the
       Fantasy/SF split: The Shining carries 'horror fiction', 'horror tales',
       'gothic & horror', 'supernatural thrillers' and 'haunted houses', and
       comes out ['horror','fiction','mystery']. If you reorder this table,
       check it again.

       DO NOT use Gwendolyn Kiste as that check, however much a horror bucket
       invites it. Open Library holds ZERO subjects for her — all eight works it
       returns for the author (The Rust Maidens, Reluctant Immortals, Boneset &
       Feathers, The Haunting of Velkwood, Pretty Marys All in a Row, And Her
       Smile Will Untether the Universe…) come back with an empty `subjects`
       array, so bucketGenres has nothing to match and correctly answers
       ['general']. That is a hole in the catalogue, not in this table, and no
       rule added here can close it — a book with no subjects cannot be
       bucketed by subject. Reaching for a title-or-author heuristic to force it
       would be guessing about every other sparsely catalogued book too. The
       user's fix is the inspector's genre chips; the shelf's fix is somebody
       editing Open Library.

       Horror is also the more specific claim of the two: a record carrying
       both 'Horror tales' and 'Fantasy fiction' is a horror novel that happens
       to be fantastical, not a fantasy novel that happens to be frightening.
       Being first also wins horror the tie-break in 38-normalize's ACROSS-
       subjects ranking, which is what decides a thinly catalogued record that
       carries exactly one subject of each.

       Every pattern below matches a GENRE claim, never a bare creature noun,
       and that line is the one thing to hold when adding to this list. The
       obvious-looking entries — 'monsters', 'ghosts', 'vampires', 'demons',
       and bare 'supernatural' or 'paranormal' — were all tried here and all
       had to come out: those words are shared property. Open Library files
       'Monsters' on Where the Wild Things Are and on Loch Ness cryptozoology,
       'Ghosts' and 'Monsters' on Harry Potter, 'Supernatural' on A Game of
       Thrones, and 'Vampires' + 'Werewolves' as headings SEPARATE from
       'Romance' on Twilight — which, because the count-first ranking then put
       horror above romance, dropped Romance off the paradigm paranormal
       romance entirely. A per-subject romance lookahead cannot save that: the
       creature heading and the romance heading are different strings, so the
       guard never sees them together.

       Requiring the genre word costs nothing, because a book that is actually
       horror says so. Dracula carries 'Horror tales', Salem's Lot carries
       'Horror fiction'; neither needs 'Vampires' to be read correctly, and the
       vampire novels that DON'T say horror are the romances we wanted to leave
       alone. The creature nouns all still live in `fantasy` below, which is
       where they landed before this bucket existed and where they stayed when
       the old combined fantasysf bucket was split in two. */
    bucket: 'horror',
    match: [
      /\bhorror\b/i,                 // also eats 'Horror tales', 'Cosmic horror'
      /\bghost stories\b/i,          // the genre; bare 'Ghosts' is Harry Potter
      /\bhaunted (houses?|places?)\b/i,
      /\bhaunting/i,
      /\bgothic (fiction|novels?|tales?|literature)\b/i,   // not 'Gothic architecture'
      /\bweird fiction\b/i,
      /\bsplatterpunk\b/i,
      /\bdemonic possession\b/i,
      /\bexorcism\b/i,
      /\boccult fiction\b/i,         // 'Occultism' on its own is a religion heading
      /\bsupernatural (fiction|stories|tales?|thrillers?)\b/i,
      /\bparanormal fiction\b/i,
      /\bmonster stories\b/i,
      /\bvampire fiction\b/i,
    ],
  },
  {
    /* Graphic novels sit high because this is a claim about the FORM of the
       book, and the form words are unambiguous where the genre words are not.
       It has to be above `fiction` in particular: that bucket's /\bnovel/
       matches 'Graphic novels' outright, which is how comics used to end up
       filed as literary fiction.

       It costs nothing to be up here. A superhero record carries 'Comic books,
       strips, etc.' AND 'Superheroes' AND 'Fantasy fiction' as separate
       subjects, so taking the form string does not stop the genre strings
       reaching their own buckets on the next pass. */
    bucket: 'graphic',
    match: [
      /\bgraphic novels?\b/i,
      /\bcomic books?\b/i,          // 'Comic books, strips, etc.' — the LC heading
      /\bcomic strips?\b/i,
      /* Plural only, deliberately. Bare /\bcomic\b/ eats 'Comic fiction',
         which is humour — a Wodehouse, not a Watchmen. */
      /\bcomics\b/i,
      /\bmanga\b/i,
      /\bwebcomics?\b/i,
      /\bcartoons\b/i,
      /\bbandes dessinées\b/i,      // French catalogue records
    ],
  },
  {
    /* Audience, not subject matter — and it runs ABOVE the genre buckets on
       purpose, which is the one placement in this table most likely to look
       wrong at a glance.

       The reason is redundancy. Fantasy below can be reached by nine different
       strings ('Magic', 'Dragons', 'Wizards', 'Quests', 'Fairy tales'…), so
       losing the single combined string 'Juvenile Fiction / Fantasy & Magic'
       to this bucket costs it nothing — the record's other subjects still put
       it in Fantasy. Young Adult has no such spare vocabulary: the audience is
       stated in two or three explicit phrases or not at all, so if a genre
       rule takes the one string that says it, the shelf never fills. Put
       another way: the bucket with fewer ways to be right goes first.

       Every pattern here demands the FICTION-side marker. 'Juvenile
       literature' and "Children's literature" are deliberately absent — those
       are the children's NONFICTION headings ('Dinosaurs -- Juvenile
       literature'), and matching them would file every kids' dinosaur book as
       a young adult novel. */
    bucket: 'youngadult',
    match: [
      /\byoung adult\b/i,           // 'Young adult fiction', 'Young adult literature'
      /\bjuvenile fiction\b/i,
      /\bchildren['’]?s (?:fiction|stories)\b/i,
      /\bmiddle[\s-]grade\b/i,
      /\bteen(?:age)? fiction\b/i,
      /\bteenagers?\b.*\bfiction\b/i,
      /\bya fiction\b/i,
      /* Moved out of `fiction`, where it could never be reached from here.
         It does pull the occasional adult literary novel in, and that is the
         accepted cost: coming-of-age is the one theme a YA shelf is actually
         about, and the count-first ranking across subjects still puts a
         literary record's four `fiction` hits ahead of this one. */
      /\bcoming of age\b/i,
    ],
  },
  {
    /* Science fiction ABOVE fantasy, for one string: 'Science fiction and
       fantasy' — and its BISAC twin 'FICTION / Science Fiction & Fantasy' — is
       a single subject carrying both words, and somebody has to win it. SF
       takes it because /\bscience[\s-]?fiction\b/ is an unambiguous two-word
       claim while fantasy's /\bfantasy\b/ is a lone word that also turns up in
       'Fantasy games' and 'Fantasy sports'. The looser pattern yields to the
       tighter one.

       This is also the bucket the brief warns about: `science fiction` must
       never be swallowed by a broad `fiction` rule, which is why it sits nine
       rules above it. */
    bucket: 'scifi',
    match: [
      /\bscience[\s-]?fiction\b/i,
      /\bsci[\s-]?fi\b/i,
      /\bspace opera\b/i,
      /\bspace flight\b/i,
      /\binterplanetary voyages\b/i,   // the LC heading on Dune, oddly enough
      /\bdystopia/i,
      /\butopia/i,
      /\bcyberpunk\b/i,
      /* Steampunk reads as fantasy to some readers, but every catalogue that
         has an opinion files it under SF, and a bucket should match where the
         data already points rather than where taste does. */
      /\bsteampunk\b/i,
      /\btime travel\b/i,
      /\bextraterrestrial/i,
      /\bfirst contact\b/i,
      /* 'Robotics' does NOT match — the \b after `robots?` fails against the
         'i', which is exactly right: robotics is an engineering subject and
         belongs in nonfiction. */
      /\brobots?\b/i,
      /\bandroids?\b/i,
      /* AI must be PAIRED with the fiction flag, and that is the one place
         this bucket is not allowed to be greedy. 'Artificial intelligence' is
         a huge nonfiction heading, this rule sits six places above nonfiction,
         and the unqualified form filed an AI textbook as science fiction — the
         count-first ranking does not save it, because such a book matches
         nonfiction exactly once ('Computers') and this exactly once too, so
         the tie went to whichever rule was higher, which is this one.
         Cataloguers write the novel form as 'Artificial intelligence --
         Fiction' (it is on Neuromancer), so demanding both words loses
         nothing. */
      /\bartificial intelligence\b.*\bfiction\b/i,
      /\bfiction\b.*\bartificial intelligence\b/i,
      /* The umbrella term, covering both halves of the old combined bucket.
         Given to SF rather than fantasy because that is who uses the phrase. */
      /\bspeculative fiction\b/i,
    ],
  },
  {
    bucket: 'fantasy',
    match: [
      /\bfantasy\b/i,               // also eats 'Epic fantasy', 'Urban fantasy'
      /\bsword and sorcery\b/i,
      /\bmagic(al)? realism\b/i,
      /* The old bare /\bepic\b/ came out with the split. It was matching 'Epic
         poetry' and 'Epic literature', which is Homer and Beowulf — shelved as
         classics by every reader who owns them, not as fantasy. 'Epic fantasy'
         is already covered by the plain /\bfantasy\b/ above. */
      /\bmagic\b(?!\s*(?:tricks?|shows?))/i,   // not 'Magic tricks' (a hobby book)
      /\bwizard|dragon|elves|sorcer/i,
      /\bquests?\b/i,               // 'Quests (Expeditions)' is the LC heading
      /\bfairy tales?\b/i,
      /\bmythology\b/i,
      /* The bare creature nouns stay HERE and only here. Horror above matches
         only the genre-shaped forms of them ('Supernatural fiction', 'Vampire
         fiction'), so these three keep catching what horror deliberately does
         not: 'Paranormal romance', a Twilight record's stray 'Vampires', and
         the supernatural furniture of ordinary fantasy. Note the order still
         matters — 'Supernatural fiction' hits horror first precisely because
         this unanchored copy would otherwise swallow it. */
      /\bparanormal\b/i,
      /\bsupernatural\b/i,
      /\bvampire|werewol|zombie/i,
    ],
  },
  {
    bucket: 'mystery',
    match: [
      /\bmystery\b/i,
      /\bmysteries\b/i,
      /\bdetective/i,
      /\bcrime\b/i,
      /\bthriller/i,
      /\bsuspense\b/i,
      /\bnoir\b/i,
      /\bwhodunit\b/i,
      /\bespionage\b/i,
      /\bspy stories\b/i,
      /\bpolice procedural/i,
      /\bhard[\s-]?boiled\b/i,
      /\bmurder\b/i,
      /\bcozy mystery\b/i,
      /\blegal stories\b/i,
    ],
  },
  {
    bucket: 'romance',
    match: [
      /\bromance\b/i,
      /\blove stories\b/i,
      /\bromantic\b/i,
      /\bchick[\s-]?lit\b/i,
      /\berotica\b/i,
      /\bcourtship\b/i,
      /\bman[\s-]woman relationships\b/i,
      /* Regency stays HERE, above the historical bucket that also wants the
         word, because in a catalogue 'Regency' is overwhelmingly a romance
         sub-genre label rather than a period marker.

         The lookahead is what makes that true. The genuine period heading is
         dated — 'Great Britain -- History -- Regency, 1811-1820' — and without
         the guard this rule filed a straight history of the period as a
         romance. Excluding the dated form drops it through to `historical`
         when the record also says Fiction, and to `nonfiction` when it does
         not, which is the right answer in both cases. */
      /\bregency\b(?!,?\s*1[0-9]{3})/i,
    ],
  },
  {
    /* Historical fiction, and note the position: BELOW mystery and romance,
       ABOVE nonfiction.

       Below mystery/romance because 'Historical romance' and 'Historical
       mystery' are single strings naming a sub-genre of those shelves — a
       reader looking for a Regency romance wants it under Romance, and the
       record's other subjects still bring it here.

       Above nonfiction because nonfiction owns /\bhistory\b/, and a novel
       catalogued 'Great Britain -- History -- 1800-1899 -- Fiction' would
       otherwise be filed as a history book. That is the failure this placement
       prevents, and it is a common one: the LC subject string for historical
       fiction is literally a history heading with '-- Fiction' bolted on.

       Which is also why almost every pattern below pairs a period marker WITH
       the fiction flag rather than trusting the period marker alone. Bare
       'Medieval', 'World War, 1939-1945' and 'Victorian' are the commonest
       nonfiction headings in the catalogue; matching them unqualified would
       drag every war history and art-history survey into a fiction bucket. */
    bucket: 'historical',
    match: [
      /\bhistorical fiction\b/i,
      /\bhistorical novels?\b/i,
      /* Period marker beside an explicit fiction flag, in either order,
         because the two turn up on both sides of the '--' separator. */
      /\bfiction\b.*\b(?:world war|civil war|victorian|edwardian|elizabethan|tudor|georgian|regency|medieval|middle ages|renaissance|antebellum|colonial|ancient (?:rome|greece|egypt))\b/i,
      /\b(?:world war|civil war|victorian|edwardian|elizabethan|tudor|georgian|regency|medieval|middle ages|renaissance|antebellum|colonial|ancient (?:rome|greece|egypt))\b.*\bfiction\b/i,
      /* A four-digit year beside the fiction flag: 'Spain -- History -- Civil
         War, 1936-1939 -- Fiction'. Restricted to 1000–1999 on purpose — a
         novel set in 2019 is not historical fiction, it is fiction. */
      /\bfiction\b.*\b1[0-9]{3}\b/i,
      /\b1[0-9]{3}\b.*\bfiction\b/i,
    ],
  },
  {
    /* Split out of nonfiction rather than added beside it, and it must stay
       ABOVE nonfiction: every pattern here also matches nonfiction's own
       /\bhistory\b/-shaped vocabulary, and the whole point of the bucket is
       that 'memoir' reaches Biography rather than stopping at the generic
       shelf. These regexes were nonfiction's until the split; they were moved,
       not copied, so there is exactly one rule per phrase. */
    bucket: 'biography',
    match: [
      /\bbiograph/i,                // 'Biography', 'Biographies'; not 'bibliography'
      /\bautobiograph/i,
      /\bmemoirs?\b/i,
      /\bpersonal narratives?\b/i,  // 'World War, 1939-1945 -- Personal narratives'
      /\bdiaries\b/i,
      /\bcorrespondence\b/i,
      /\bletters\b/i,               // published letters of a person, in practice
      /\breminiscences\b/i,
    ],
  },
  {
    bucket: 'nonfiction',
    match: [
      /\bnon[\s-]?fiction\b/i,
      /* biography / autobiography / memoir / correspondence / diaries /
         letters all MOVED UP to the `biography` bucket. Do not re-add them
         here: a duplicate below the bucket that owns them is unreachable code
         that reads like a disagreement. */
      /\bhistory\b/i,
      /\bhistorical\b(?!.*\bfiction\b)/i,
      /\bscience\b(?!\s*fiction)/i,
      /\bmathematics\b/i,
      /\bphilosophy\b/i,
      /\bpsychology\b/i,
      /\bpolitic/i,
      /\beconomic/i,
      /\bbusiness\b/i,
      /\bself[\s-]?help\b/i,
      /\btrue crime\b/i,
      /\bessays?\b/i,
      /\bcooking\b|\bcookbook/i,
      /\btravel\b/i,
      /\breligion\b|\btheolog/i,
      /\bsociolog/i,
      /\banthropolog/i,
      /\bcomputers?\b|\bprogramming\b/i,
      /\bmedic(al|ine)\b/i,
      /\bnature\b/i,
      /\bhealth\b/i,
      /\breference\b/i,
      /\bcriticism\b|\bliterary criticism\b/i,
      /\bstudy and teaching\b/i,
      /\bhandbooks?, manuals\b/i,
    ],
  },
  {
    /* Literary Fiction — the last real rule, and the widest. Everything above
       exists so that this one only ever sees what nothing more specific
       claimed: its bare /\bfiction\b/ and /\bnovel/ would otherwise take the
       entire catalogue. Four patterns were moved out of here when the buckets
       were split, and each has a note at its new home:
       'historical fiction' → historical, 'coming of age' → youngadult,
       'graphic novel' and 'comics|manga' → graphic. */
    bucket: 'fiction',
    match: [
      /\bliterary fiction\b/i,
      /\bgeneral fiction\b/i,       // and 'Fiction, general', the OL word order
      /\bfiction\b/i,
      /\bnovel/i,
      /\bshort stories\b/i,
      /\bliterary\b/i,
      /\bclassics?\b/i,
      /\broman\b/i,          // French/German catalogue records say 'Roman'
      /\bwar stories\b/i,
      /\bfamily sagas?\b/i,
      /* Stays here rather than moving to youngadult with 'coming of age'.
         A bildungsroman is a literary-criticism word: it is applied to Joyce
         and Mann far more often than to anything on a teen shelf. */
      /\bbildungsroman\b/i,
      /\bsatire\b/i,
      /\bhumor(ous)? stories\b/i,
      /\bpoetry\b|\bpoems\b/i,
      /\bdrama\b|\bplays\b/i,
    ],
  },
  /* No `general` rule on purpose. `general` is what you get when nothing
     matched, not something you match into — a bucket that can be reached two
     ways is a bucket whose contents nobody can explain. */
];

/* The twelve buckets that ship with the app, in display order — which is
   FAMILY order, so the tree's "By genre" section reads as five pairs and a
   residue rather than as twelve unrelated rows. `general` last because it is
   the residue, and it renders with neutral text rather than a hue (see the
   --bt-genre-* tokens: there is deliberately no --bt-genre-general).

   FIXED, and frozen to say so. These twelve cannot be renamed or removed from
   Settings: they are the ids stored in every library in the wild, the ids the
   rules table below emits, and the ids css/03-components.css writes static
   rules for. A user who wants a shelf the app does not have adds their own —
   see BT.genres — which is additive and cannot shadow one of these.

   READ BT.GENRE_BUCKETS, NOT THIS, unless you specifically mean "the built-in
   twelve". That property is defined below as built-ins + the user's own. */
BT.GENRE_BUILTINS = Object.freeze([
  'fiction', 'historical',
  'fantasy', 'scifi',
  'mystery', 'horror',
  'romance', 'youngadult',
  'nonfiction', 'biography',
  'graphic',
  'general',
]);

/* The word for each id. MUTATED AT RUNTIME in two places, both of them below
   in this file and neither of them optional: the legacy-alias loop gives dead
   ids their heir's word, and BT.genres.rebuild() adds one entry per custom
   genre. That is why this is a plain object rather than a frozen table —
   BT.ui.genresOf uses "is there a label for this id" as its test for whether a
   stored id is real, so a genre missing from here is a genre that does not
   render at all, which is exactly what a DELETED custom genre should do. */
BT.GENRE_LABELS = {
  fiction: 'Literary Fiction',
  historical: 'Historical',
  fantasy: 'Fantasy',
  scifi: 'Science Fiction',
  mystery: 'Mystery & Thriller',
  horror: 'Horror',
  romance: 'Romance',
  youngadult: 'Young Adult',
  nonfiction: 'Non-fiction',
  biography: 'Biography & Memoir',
  graphic: 'Graphic Novels',
  general: 'General',
};

/* ── Hue family per bucket ────────────────────────────────────────────────
   Twelve genres, six hue families, and that is not a shortage to be fixed —
   it is the scheme.

   The palette is "Tide", shared value-for-value with the sibling MovieTrak so
   the two apps read as one family. It has exactly six hue families — teal,
   coral, amber, ice, violet, moss — each with a -text/-wash/-edge set derived
   per theme in css/01-tokens.css. There is no seventh, and there must not be:
   a hue invented here would be a hue MovieTrak does not have, in a palette
   whose whole point is that both apps wear it.

   So COLOUR NAMES THE FAMILY, THE LABEL NAMES THE GENRE. Fantasy and Science
   Fiction are both ice because they are one neighbourhood of the shelf;
   Mystery and Horror are both amber; the word on the tag says which. Twelve
   hues at 7px in a tree row would not be distinguishable anyway — six already
   sits near the limit of what reads reliably at that size — so pretending to
   twelve would buy nothing and cost the shared palette.

   If you are here because two genres looking alike felt like a bug: it is not.
   Do not invent hex values. Add a label, or accept the pair.

   `general` is null, not a hue. It is the bucket a book lands in when nothing
   matched, and colouring it would dress an absence of information up as a
   classification.

   A custom genre picks ONE OF THESE SIX (or null, and wears the `general`
   treatment). BT.genres.rebuild() adds its entry to this map and emits the
   matching CSS, so the answer to "may I have a seventh hue" is still no —
   the user chooses a family, never a colour. */
BT.GENRE_FAMILY = {
  fiction: 'violet',
  historical: 'violet',
  fantasy: 'ice',
  scifi: 'ice',
  mystery: 'amber',
  horror: 'amber',
  romance: 'coral',
  youngadult: 'coral',
  nonfiction: 'moss',
  biography: 'moss',
  graphic: 'teal',
  general: null,
};

/* The whole supply, named once so a custom genre can be offered a CHOICE OF
   FAMILY rather than a colour. Every one of these has a -text/-wash/-edge set
   in css/01-tokens.css and is MovieTrak's value for value; a seventh entry
   here would be a hue one app has and the other does not, which is the one
   thing the shared palette exists to prevent. Order is the order the picker
   lists them in — the four MovieTrak hues, then the two a library added. */
BT.HUE_FAMILIES = ['teal', 'coral', 'amber', 'ice', 'violet', 'moss'];

/* ── Legacy bucket ids ────────────────────────────────────────────────────
   Books added before Fantasy and Science Fiction were split carry the id
   `fantasysf`, which is no longer a bucket. Those records are on the user's
   shelf right now and nothing here rewrites them.

   That is a deliberate refusal. A boot-time migration that walked every stored
   item and rewrote its genres would be a silent bulk edit of the user's own
   data, performed without asking, on data the user may have corrected by hand
   in the inspector. This app does not do that. The alias below keeps the old
   id READABLE — it resolves to a live bucket for labelling and filtering — and
   the user decides when to actually change anything.

   The proper fix, when they want it, is the "Recalculate genres" tool in
   Settings: it re-derives every bucket from the record's stored subjects, so a
   fantasysf book comes back as Fantasy or Science Fiction according to what it
   actually is — which is a better answer than any alias can give, because the
   alias has to guess and it guesses Fantasy for everything.

   Anything that reads a STORED genre id — rendering a tag, counting a facet,
   matching a ?genre= route — should send it through BT.genreId() first. */
BT.GENRE_ALIASES = {
  fantasysf: 'fantasy',
};

/* Resolve a possibly-legacy bucket id to a live one. Unknown ids pass through
   unchanged rather than becoming 'general', because a hand-typed route or a
   future bucket should look wrong, not look like the catch-all. */
BT.genreId = id => (BT.GENRE_ALIASES[id] || id);

/* The word for a bucket id, legacy ids included. Falls back to the raw id so a
   miss shows as 'fantasysf' in the UI — visibly wrong, therefore reported —
   rather than as an empty tag nobody notices.

   ONE EXCEPTION, and it is the deleted-custom-genre case. A book filed under a
   genre the user has since removed still carries `x-weird-fiction` in its
   record, and a breadcrumb or a hand-typed #/library?genre= route reads the id
   straight out of the URL rather than through BT.ui.genresOf (which drops
   unknown ids entirely). Echoing the raw id back at the reader would caption
   the page 'x-weird-fiction', which looks like the app broke rather than like a
   shelf they took down. The id is a slug of the label they typed, so turning it
   back into words gives them their own name for it — an honest epitaph, and no
   stored data has to be touched to produce it. */
BT.genreLabel = id => {
  const live = BT.GENRE_LABELS[BT.genreId(id)];
  if (live) return live;
  return (BT.genres && BT.genres.isCustomId(id)) ? BT.genres.labelFromId(id) : id;
};

/* The hue family, legacy ids included — null for 'general' and for anything
   unknown, both of which mean "paint this in muted text, not in a colour".
   Read through here rather than indexing BT.GENRE_FAMILY directly: the map is
   keyed by LIVE bucket ids only, so a stored `fantasysf` would come back
   undefined and a caller branching on it would take the coloured path with
   nothing to colour with. */
BT.genreFamily = id => BT.GENRE_FAMILY[BT.genreId(id)] || null;

/* Give every legacy id a label of its own, pointing at its heir's word.
   This is the line that stops old books being ORPHANED by the split.
   BT.ui.genresOf keeps only the ids it finds in this table — that check is how
   junk ids get dropped — so without an entry here a fantasysf book would lose
   its only genre, fall back to 'General', and look to its owner like the app
   had forgotten what it was. With the entry, the chip reads 'Fantasy' and the
   CSS alias in 03-components.css paints it the Fantasy hue. */
for (const legacy of Object.keys(BT.GENRE_ALIASES)) {
  BT.GENRE_LABELS[legacy] = BT.GENRE_LABELS[BT.GENRE_ALIASES[legacy]];
}

/* ══ USER-DEFINED GENRES ═══════════════════════════════════════════════════
   The twelve above are a taxonomy somebody else chose. This is the seam where
   a reader adds the shelf their library actually has — Weird Fiction, Cookbooks
   I Cook From, Danish Crime — without any of it becoming a special case
   downstream. Everything that draws a genre keeps reading BT.GENRE_BUCKETS,
   BT.GENRE_LABELS and BT.GENRE_FAMILY exactly as it did; this module is what
   puts the user's genres INTO those three tables.

   TWO KINDS, and the difference is only whether keywords were given:
     · no keywords — a label you apply by hand from a book's detail pane. It
       never matches anything on its own, which is the point: "Books Dad Lent
       Me" is not a property of the catalogue.
     · with keywords — matched against subject strings on the next Settings →
       Recalculate genres, exactly as the built-in rules are. See
       38-normalize.js's bucketGenres, which runs the built-in table first and
       this one second, in its own pass.

   ID NAMESPACING — the whole reason ids are not just slugs.
   Every custom id is `x-` + slug(label), and no built-in id contains a dash or
   an `x-` prefix. That single rule buys three guarantees at once:
     1. A custom genre called "Fiction" becomes `x-fiction` and CANNOT shadow
        the built-in `fiction`. Without the prefix it would silently take over
        every stored fiction book's tag, its tree row and its CSS rule, and the
        user would have no way to tell what happened.
     2. `x-` is a valid CSS identifier start, so `.tag.x-fiction` is a legal
        selector — a bare slug beginning with a digit ("1970s Paperbacks") is
        not, and would emit CSS that silently does not apply.
     3. Anything reading an id can ask "is this one of ours" with a regex
        rather than a lookup, which is what lets a DELETED genre's id still be
        turned back into words (see BT.genreLabel).
   Collisions between two customs are auto-suffixed (`x-crime-2`); collisions
   by LABEL are rejected at the point of entry by the Settings form, because two
   chips reading the same word is a puzzle no id scheme can solve for the reader.

   NOTHING HERE TRUSTS ITS INPUT. The list arrives from localStorage or from an
   imported export file, so rebuild() re-validates every field on every load:
   ids are shape-checked before they are written into a CSS selector, hues are
   checked against the six families, and lengths are capped. An invalid entry is
   dropped rather than repaired, because a repaired one would look like it
   worked. ═════════════════════════════════════════════════════════════════ */
BT.genres = (function () {
  const PREFIX = 'x-';
  /* The shape a custom id is allowed to have, and the ONLY gate between a
     settings file and a stylesheet. Lowercase alphanumerics in dash-separated
     runs, nothing else — no dots, no braces, no quotes, so an id cannot close
     the rule it is written into and open something else. */
  const ID_RX = /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const STYLE_ID = 'bt-genre-css';

  const MAX_LABEL = 40;      // a tag is 17px tall and uppercase; longer is unreadable
  const MAX_KEYWORD = 40;    // a subject heading longer than this is a pasted sentence
  const MAX_KEYWORDS = 24;
  const MAX_GENRES = 60;     // a ceiling, not a target — see the CSS note in paint()

  /* The validated list currently in force, and the two tables derived from it.
     Cached rather than recomputed per read: BT.GENRE_BUCKETS is read inside
     render loops (once per row in 62-view-list's sort), and the keyword regexes
     are compiled once per rebuild rather than once per subject — a full
     recalculation over a 500-book library tests them tens of thousands of
     times. */
  let applied = [];
  let bucketCache = BT.GENRE_BUILTINS.slice();
  let ruleCache = [];

  /* ── Ids and labels ───────────────────────────────────────────────────── */

  function slug(label) {
    return String(label == null ? '' : label).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '');
  }

  /* Every id that must not be handed out again: the twelve built-ins, the dead
     ids the alias table still resolves, and whatever customs already exist. */
  function reserved(list) {
    const taken = new Set(BT.GENRE_BUILTINS);
    for (const legacy of Object.keys(BT.GENRE_ALIASES)) taken.add(legacy);
    for (const g of (list || applied)) taken.add(g.id);
    return taken;
  }

  /* A label of nothing but punctuation or non-Latin script slugs to the empty
     string — '科幻' and '★★★' both do. That is not a reason to refuse the
     label: the label is what the reader sees, and the id is plumbing. So the
     slug falls back to a generic stem and the de-duplicator numbers it, which
     gives '科幻' the id `x-genre` and a second one `x-genre-2`. Both work
     everywhere; only a URL looks anonymous. */
  function mintId(label, taken) {
    const base = PREFIX + (slug(label) || 'genre');
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const tryId = `${base}-${n}`;
      if (!taken.has(tryId)) return tryId;
    }
    /* 98 genres sharing one slug is not a real library, it is a loop that got
       away. A timestamped id is ugly and unique, which beats returning a
       duplicate that would silently overwrite an existing genre. */
    return `${base}-${Date.now().toString(36)}`;
  }

  const cleanLabel = v =>
    String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL);

  /* The id turned back into the words it was made from. Used for a genre that
     no longer exists — see BT.genreLabel. */
  function labelFromId(id) {
    return String(id || '').slice(PREFIX.length).split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  const isCustomId = id => ID_RX.test(String(id || ''));

  /* ── Keywords ─────────────────────────────────────────────────────────── */

  /* Accepts the stored array OR the comma-separated string the Settings form
     collects, so the form does not have to know the storage shape. */
  function cleanKeywords(v) {
    const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
    const out = [];
    const seen = new Set();
    for (const r of raw) {
      const s = String(r == null ? '' : r).trim().replace(/\s+/g, ' ');
      if (!s || s.length > MAX_KEYWORD) continue;
      const low = s.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(s);
      if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
  }

  /* A keyword is a WORD the user typed, not a regex — 'c++' and 'sci-fi' are
     both legitimate and both are regex syntax, so every character is escaped
     before it goes anywhere near a pattern.

     Matched on a boundary rather than as a substring, because a bare
     `indexOf('art')` files every book about Cartography under Art. Written as
     explicit character classes rather than \b because a keyword may legally
     begin or end with a non-word character ('science & nature', '#booktok'),
     and \b beside one of those asserts the opposite of what it looks like.
     Consuming the boundary character is harmless here: these patterns are only
     ever asked `.test()`, never walked for successive matches.

     Note the negated class under /i does NOT match uppercase ASCII (it is
     case-folded before the negation), so 'Fiction' still boundaries correctly.
     Non-ASCII letters do count as boundaries, which makes matching very
     slightly looser for accented headings and has never yet been wrong. */
  function keywordRx(kw) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^a-z0-9])' + esc + '(?:[^a-z0-9]|$)', 'i');
  }

  /* ── Validation ───────────────────────────────────────────────────────── */

  const hueOf = h => (BT.HUE_FAMILIES.indexOf(h) >= 0 ? h : null);

  /* Structural validation only — this is the LOAD path, and a library that
     will not boot because one genre in the settings file is malformed is worse
     than a library missing that genre. Duplicate LABELS are deliberately not
     rejected here (the add form does that); an imported file that contains two
     "Crime" genres still loads, and the user can see and fix it. */
  function sanitize(raw) {
    const out = [];
    const taken = reserved([]);
    for (const entry of (Array.isArray(raw) ? raw : [])) {
      if (!entry || typeof entry !== 'object') continue;
      const label = cleanLabel(entry.label);
      if (!label) continue;
      /* A VALID STORED ID IS KEPT, always. Stored books carry it, so minting a
         fresh one here — on a rename, on an import, on any boot — would orphan
         every record filed under the old id while the genre appeared to
         survive. A new id is minted only when the stored one is missing,
         malformed or already in use by something else, which cannot happen to
         a list this module wrote. */
      const stored = String(entry.id || '');
      const id = (isCustomId(stored) && !taken.has(stored)) ? stored : mintId(label, taken);
      taken.add(id);
      out.push({ id, label, keywords: cleanKeywords(entry.keywords), hue: hueOf(entry.hue) });
      if (out.length >= MAX_GENRES) break;
    }
    return out;
  }

  /* The reason a label cannot be used, or null. Called by the form, not by the
     loader: this is a question about what a READER can tell apart, and the
     answer is that they cannot tell two identically-labelled chips apart at
     all — the label is the only thing on a tag that names the genre. */
  function labelClash(label, ignoreId) {
    const low = label.toLowerCase();
    for (const id of BT.GENRE_BUILTINS) {
      if (String(BT.GENRE_LABELS[id] || '').toLowerCase() === low) {
        return `“${BT.GENRE_LABELS[id]}” is one of the twelve built-in genres. `
          + 'Those cannot be replaced — pick another name, or use the built-in.';
      }
    }
    for (const g of applied) {
      if (g.id !== ignoreId && g.label.toLowerCase() === low) {
        return `You already have a genre called “${g.label}”.`;
      }
    }
    return null;
  }

  /* ── Derivation ───────────────────────────────────────────────────────── */

  /* Customs sit between `graphic` and `general`, never after it. `general` is
     the residue — the bucket a book lands in when nothing fit — so it reads
     last in the tree, sorts last in 62-view-list's bucketRank, and is the last
     chip in the inspector. A user's own genre is a real shelf and belongs
     above it. */
  function orderedIds() {
    if (!applied.length) return BT.GENRE_BUILTINS.slice();
    return BT.GENRE_BUILTINS.filter(id => id !== 'general')
      .concat(applied.map(g => g.id), ['general']);
  }

  /* Re-derive everything from the stored list. Called on load, after any edit,
     and after an import. Cheap enough to be called freely — a personal library
     has a handful of custom genres, not a thousand. */
  function rebuild() {
    const next = sanitize(BT.config.get('customGenres'));

    /* Remove the PREVIOUS entries by the ids we actually added, not by "every
       id that is not a built-in". BT.GENRE_LABELS also holds the legacy alias
       words (fantasysf → 'Fantasy'), and a blanket sweep would delete those —
       which would orphan every pre-split book on the shelf, silently, on the
       first genre edit. */
    for (const g of applied) {
      delete BT.GENRE_LABELS[g.id];
      delete BT.GENRE_FAMILY[g.id];
    }
    applied = next;
    for (const g of applied) {
      BT.GENRE_LABELS[g.id] = g.label;
      BT.GENRE_FAMILY[g.id] = g.hue;      // null is legitimate — the `general` treatment
    }

    bucketCache = orderedIds();
    /* Only genres that were GIVEN keywords become rules. A manual-only label
       with an empty match list would match nothing and cost a scan per subject
       per book; leaving it out of the table is the same answer, stated once. */
    ruleCache = applied.filter(g => g.keywords.length)
      .map(g => ({ bucket: g.id, match: g.keywords.map(keywordRx) }));

    paint();
    return applied;
  }

  /* ── The injected stylesheet ──────────────────────────────────────────────
     `.tag.<id>` and `.dot.c-<id>` are static rules in css/03-components.css,
     one per built-in — which is impossible for a genre that did not exist when
     the stylesheet was written. So this emits them, into ONE <style> element
     that is rebuilt whole whenever the list changes. One element rather than
     one per genre because a rebuild then has nothing to track and nothing to
     leak: replacing `textContent` cannot leave an orphaned rule behind for a
     genre that was deleted, which is the failure a per-genre element invites.

     NO NEW COLOUR IS INVENTED HERE. Each rule points at the -wash/-edge pair of
     one of the six existing families, exactly as the built-in rules do, and
     declares a `--bt-genre-<id>` alias so the tag text and the tree dot resolve
     through the same token — the property css/03-components.css relies on to
     keep one genre one colour across the app. A genre with no hue gets the
     `general` treatment: muted text on the sunk ground, which is what "no
     colour chosen" honestly looks like.

     The ID_RX test is not decoration. This is the one place a value that came
     out of a JSON file is written into a stylesheet, and an id like
     `x-a{}html{display:none}` would otherwise be a working attack on anybody
     who imported a stranger's export. sanitize() already guarantees the shape;
     this checks it again at the boundary that matters. */
  function css() {
    /* The aliases are collected into ONE :root block rather than one per
       genre, so the emitted sheet reads like the hand-written half of
       01-tokens.css instead of like machine output. */
    const vars = [];
    const rules = [];
    for (const g of applied) {
      if (!ID_RX.test(g.id)) continue;
      if (g.hue) {
        vars.push(`  --bt-genre-${g.id}: var(--bt-${g.hue});`);
        rules.push(`.tag.${g.id} { color: var(--bt-genre-${g.id}); background: var(--bt-${g.hue}-wash);`
          + ` box-shadow: inset 0 0 0 1px var(--bt-${g.hue}-edge); }`);
        rules.push(`.c-${g.id} { color: var(--bt-genre-${g.id}); }`);
      } else {
        /* No alias at all for a hueless genre, exactly as there is no
           --bt-genre-general: an alias that resolved to muted text would look
           like a colour choice in the inspector rather than the absence of
           one. */
        rules.push(`.tag.${g.id} { color: var(--bt-text-muted); background: var(--bt-surface-sunk);`
          + ' box-shadow: inset 0 0 0 1px var(--bt-line-rule); }');
        rules.push(`.c-${g.id} { color: var(--bt-text-muted); }`);
      }
    }
    if (!rules.length) return '';
    return (vars.length ? `:root {\n${vars.join('\n')}\n}\n` : '') + rules.join('\n') + '\n';
  }

  function paint() {
    if (typeof document === 'undefined') return;
    /* This file is loaded from the end of <body>, so <head> is always there by
       now — but rebuild() is also reachable from an import, and one defensive
       branch is cheaper than a genre list that renders as unstyled text
       because of a load-order change nobody remembered this depended on. */
    if (!document.head) {
      document.addEventListener('DOMContentLoaded', paint, { once: true });
      return;
    }
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css();
  }

  /* ── Reads ────────────────────────────────────────────────────────────── */

  /* Copies, because callers render from these and a view that mutated the
     list in place would edit the user's settings without saving them —
     changes that survive until the next reload and then vanish. */
  const list = () => applied.map(g => ({ id: g.id, label: g.label, keywords: g.keywords.slice(), hue: g.hue }));
  const byId = id => { const g = applied.find(x => x.id === id); return g ? { id: g.id, label: g.label, keywords: g.keywords.slice(), hue: g.hue } : null; };
  const buckets = () => bucketCache;
  const rules = () => ruleCache;
  const keywordText = g => (g && g.keywords || []).join(', ');

  /* ── Writes ───────────────────────────────────────────────────────────── */

  function commit(next) {
    BT.config.set('customGenres', next.map(g => ({
      id: g.id, label: g.label, keywords: g.keywords.slice(), hue: g.hue,
    })));
    return rebuild();
  }

  function add(input) {
    const label = cleanLabel(input && input.label);
    if (!label) return { ok: false, reason: 'Give the genre a name.' };
    const clash = labelClash(label, null);
    if (clash) return { ok: false, reason: clash };
    if (applied.length >= MAX_GENRES) {
      return { ok: false, reason: `That is already ${MAX_GENRES} genres of your own — remove one first.` };
    }
    const g = {
      id: mintId(label, reserved()),
      label,
      keywords: cleanKeywords(input && input.keywords),
      hue: hueOf(input && input.hue),
    };
    commit(applied.concat([g]));
    return { ok: true, id: g.id, genre: byId(g.id) };
  }

  /* Renaming changes the LABEL and never the id — the id is what every stored
     book holds, so re-slugging it would quietly empty the shelf it renamed. */
  function update(id, patch) {
    const cur = applied.find(x => x.id === id);
    if (!cur) return { ok: false, reason: 'That genre is not in the list any more.' };
    const label = (patch && patch.label != null) ? cleanLabel(patch.label) : cur.label;
    if (!label) return { ok: false, reason: 'Give the genre a name.' };
    const clash = labelClash(label, id);
    if (clash) return { ok: false, reason: clash };
    commit(applied.map(g => g.id !== id ? g : {
      id: g.id,
      label,
      keywords: (patch && patch.keywords != null) ? cleanKeywords(patch.keywords) : g.keywords,
      hue: (patch && 'hue' in patch) ? hueOf(patch.hue) : g.hue,
    }));
    return { ok: true, id };
  }

  /* Removes the GENRE, and deliberately not the id from anybody's books. The
     reasoning, and the confirm dialog that states it to the user, are in
     69-view-settings.js — the short version is that this app does not silently
     bulk-edit stored records, and an unknown id already degrades to nothing
     everywhere it is read (BT.ui.genresOf drops ids with no label). */
  function remove(id) {
    const g = byId(id);
    if (!g) return null;
    commit(applied.filter(x => x.id !== id));
    return g;
  }

  return {
    list, byId, buckets, rules, add, update, remove, rebuild, paint,
    isCustomId, labelFromId, labelClash, cleanKeywords, keywordText, slug,
  };
})();

/* Every bucket id the app knows about RIGHT NOW: the twelve built-ins with the
   user's own genres folded in, in display order.

   An accessor rather than a plain array, and that is what makes custom genres
   appear everywhere without a single consumer changing. 55-tree maps it into
   rows, 56-inspector maps it into chips and validates a toggle against it,
   62-view-list takes indexOf() for its sort order — all of them keep the exact
   code they had, and all of them see a genre added thirty seconds ago because
   they re-read this property on every render.

   There is no setter on purpose. The list is derived from BT.config's
   `customGenres` and rebuilt by BT.genres.rebuild(); an assignment here would
   be thrown away by the next rebuild, so it is better that it fails loudly.
   The returned array is the module's own cache — read it, never push to it. */
Object.defineProperty(BT, 'GENRE_BUCKETS', {
  get() { return BT.genres.buckets(); },
  enumerable: true,
  configurable: true,
});

/* Build the tables and inject the stylesheet once, at load, so that the first
   render already knows about the user's genres. Everything after this point is
   driven by edits in Settings and by an import. */
BT.genres.rebuild();

/* ── Subject stoplist ─────────────────────────────────────────────────────
   Open Library `subjects` arrays are not a taste vocabulary. They are whatever
   fell out of a MARC record, an Internet Archive ingest or a bestseller-list
   scrape, and a startling share of the entries describe the SCAN rather than
   the BOOK: accessibility flags, lending status, a distributor's name. These
   are high-frequency and meaningless, so they crowd out the two or three
   subjects that actually say what the book is — 'Protected DAISY' is on
   hundreds of thousands of records and tells a reader nothing.

   Matched case-insensitively against the trimmed subject. Anything here is
   dropped before genre matching AND before the subject chips are rendered.
   Like MovieTrak's RAWG tag stoplist this is never finished: add to it every
   time you see junk on an item page. */
BT.SUBJECT_STOPLIST = new Set([
  'accessible book',
  'protected daisy',
  'in library',
  'internet archive wishlist',
  'overdrive',
  'large type books',
  'large print books',
  'lending library',
  'popular print disabled books',
  'print disabled',
  'reading level',
  'open library staff picks',
  'ol staff picks',
  'texts',
  'obras juveniles',
  'inlibrary',
  'printdisabled',
  'browsing collection',
  'new york times bestseller',
  'ficción',
  'general',
  'miscellanea',
]);

/* Prefix/pattern junk that cannot be enumerated. `nyt:` is the big one:
   Open Library imports the New York Times lists as subjects, producing
   'nyt:combined_print_and_e_book_fiction=2011-11-13' — thousands of distinct
   strings, all noise. `award:` and `place:`/`time:`/`person:` faceted subjects
   are real data but belong in their own fields, not in the genre matcher. */
BT.SUBJECT_STOPLIST_RX = [
  /^nyt[:=]/i,
  /^award[:=]/i,
  /^collection[:=]/i,
  /^protected\s+daisy/i,
  /^accessible\b/i,
  /^overdrive\b/i,
  /^\d+$/,                       // bare numbers, e.g. a stray Dewey fragment
];

/* ── Open Library endpoints ───────────────────────────────────────────────
   No key, no auth header, no signup. Every one of these is plain GET JSON. */
BT.OL = {
  base: 'https://openlibrary.org',
  coversBase: 'https://covers.openlibrary.org',

  search: 'https://openlibrary.org/search.json',
  /* The ONLY endpoint that returns a bare OLID ('OL1394865A') instead of a
     '/authors/OL…A' key. BT.util.olid() exists because of this endpoint. */
  searchAuthors: 'https://openlibrary.org/search/authors.json',

  work(olid)       { return `${this.base}/works/${olid}.json`; },
  editions(olid)   { return `${this.base}/works/${olid}/editions.json`; },
  edition(olid)    { return `${this.base}/books/${olid}.json`; },
  isbn(isbn13)     { return `${this.base}/isbn/${isbn13}.json`; },
  author(olid)     { return `${this.base}/authors/${olid}.json`; },
  authorWorks(olid){ return `${this.base}/authors/${olid}/works.json`; },
  subject(slug)    { return `${this.base}/subjects/${slug}.json`; },

  /* Cover sizes, as Open Library defines them. L is roughly 500px on the long
     edge, which is plenty for the inspector; anything larger does not exist. */
  SIZES: { sm: 'S', md: 'M', lg: 'L' },

  /* ── Cover URL builder ────────────────────────────────────────────────
     TWO verified traps live in this one function, and both produce a UI that
     looks broken in a way that is very hard to trace back:

     1. `?default=false` is MANDATORY. Without it, a request for a cover that
        does not exist returns HTTP 200 with a 43-byte transparent GIF. The
        image loads successfully, so <img onerror> NEVER FIRES, so the
        placeholder never renders — the grid fills with invisible blank tiles
        that the user reads as "the app failed to load". With the parameter the
        same request returns 404 and onerror does its job.

     2. The `covers` array on a work or edition record can contain -1. It is a
        sentinel meaning "a cover record existed and was removed", not an id.
        Passing it through builds .../b/id/-1-M.jpg, which is a 404 at best and
        a confusing log line at worst. Filter it — and filter 0 and anything
        non-positive while you are there.

     `key` is one of 'id' | 'olid' | 'isbn'. Returns null when there is nothing
     to ask for, so callers can branch on the URL rather than on the id. */
  cover(key, value, size) {
    if (value == null || value === '') return null;
    if (key === 'id') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;   // catches the -1 sentinel
      value = String(n);
    }
    const s = this.SIZES[size] || 'M';
    return `${this.coversBase}/b/${key}/${value}-${s}.jpg?default=false`;
  },

  /* Convenience wrappers so call sites read as what they mean. */
  coverById(id, size)   { return this.cover('id', id, size); },
  coverByOlid(olid, size) { return this.cover('olid', olid, size); },
  coverByIsbn(isbn, size) { return this.cover('isbn', isbn, size); },

  /* Author portraits live under /a/ rather than /b/ and take the same
     default=false treatment for the same reason. */
  authorPhoto(olid, size) {
    if (!olid) return null;
    const s = this.SIZES[size] || 'M';
    return `${this.coversBase}/a/olid/${olid}-${s}.jpg?default=false`;
  },

  /* Drop the -1 sentinel (and any other rubbish) from a record's covers array.
     Every caller that touches `covers` should go through this. */
  usableCovers(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(Number).filter(n => Number.isFinite(n) && n > 0);
  },
};

/* ── Google Books ─────────────────────────────────────────────────────────
   THE PRIMARY SOURCE for search, metadata, publication dates and forthcoming
   titles — but still never called at all unless BT.config.hasKey('googlebooks')
   is true, because anonymous access is a quota of zero rather than a small one.

   WHAT IT WINS, MEASURED LIVE:

     search relevance   q=dune -> Frank Herbert's Dune at #1, correctly
                        attributed. Open Library answers Children of Dune at #1
                        with the real novel eighth, credited to Brian Herbert.
     dates              full 'YYYY-MM-DD'. Wind and Truth -> '2024-12-06',
                        The Haunting of Velkwood -> '2024-03-05', Project Hail
                        Mary -> '2021-05-04'. Open Library gives the bare year
                        for all three and has no parameter that changes it.
     forthcoming        titles with street dates ahead of today exist in this
                        index and do not exist in Open Library's at all.

   WHAT IT DOES NOT HAVE, AND WHY OPEN LIBRARY STAYS WIRED:

     no work graph      a volume id ('LLSpngEACAAJ') names ONE PRINTING. There
                        is no editions-of-a-work endpoint and no work concept,
                        so "which of these is the copy on your shelf" cannot be
                        asked here at all.
     no author ids      an author is a NAME. There is no id space, so a follow
                        cannot be keyed on anything stable.
     coarse backlist    'The Hobbit, 2012 edition' -> '2012'. Google is precise
                        about recent trade publishing and year-granular about
                        the backlist, so an old paperback gains nothing.

   ── THE `orderBy=newest` TRAP ─────────────────────────────────────────────
   It does NOT sort by publication date. It sorts by when Google ADDED the
   record — observed order of publication years on one author query: 2023, 2020,
   2024, 2018. Anything that needs date order must sort client-side; see
   BT.googlebooks.sortByPublished. The parameter is still USEFUL, and 25's
   authorWorks uses it deliberately: a forthcoming title is by definition a
   recently-added record, so "newest record" is a good net for exactly the books
   relevance ranking buries. It is a discovery arm, never a sort. */
BT.GB = {
  volumes: 'https://www.googleapis.com/books/v1/volumes',
  /* A single volume by its Google id. Only reachable once a search or an ISBN
     lookup has handed us that id, which is why it is a function rather than a
     constant — nothing in the app can guess one. */
  volume(id) {
    const clean = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
    return clean ? `${this.volumes}/${clean}` : '';
  },

  /* Hard ceiling the API enforces on one response. Asking for more is not an
     error and does not get you more — it silently returns 40 — so a pager that
     trusts its own page size walks off the end of the results and reports a
     short page as the end of the list. */
  MAX_RESULTS: 40,

  /* ── COVER URL, AND THREE THINGS THAT MUST BE DONE TO IT ───────────────
     `imageLinks` arrives as, verbatim:

         http://books.google.com/books/content?id=…&printsec=frontcover
              &img=1&zoom=1&edge=curl&source=gbs_api

     1. IT IS `http://`. BookTrak is served over https from GitHub Pages, and a
        browser BLOCKS a mixed-content image outright — no request, no onerror
        in some engines, just a gap. Rewritten to https, which the same host
        serves happily.

     2. `edge=curl` DRAWS A FAKE PAGE CURL onto the image, server-side. It is
        not a CSS effect that can be turned off later; the pixels arrive bent,
        with a shadow, against a transparent corner. Stripped.

     3. `zoom=` PICKS THE SIZE and the small end is genuinely small (~128px
        wide at zoom=1). A cover at that size on a modern phone is a blur, so
        the large request asks for zoom=2.

     BT.ui.posterUrl treats any absolute URL as a deliberate override and checks
     it BEFORE an Open Library cover id, so a record holding both renders
     Google's. That is right for a record Google supplied, and wrong for a
     search row that merged the two — where Open Library's L (~500px) is the
     better image — which is why 38-normalize's mergeSearchStubs drops this URL
     when the Open Library side brought a cover id.

     Returns null rather than a broken URL when there is nothing to ask for, so
     callers branch on the URL and never on the record — the same contract
     BT.OL.cover holds to. */
  ZOOM: { sm: '1', md: '1', lg: '2' },

  cover(imageLinks, size) {
    const links = imageLinks || {};
    /* Best available first. A search response with a lean `fields` list carries
       only the two thumbnails; a full volume record can carry all six. */
    const raw = links.extraLarge || links.large || links.medium
             || links.thumbnail || links.small || links.smallThumbnail || '';
    if (!raw) return null;
    let url = String(raw).replace(/^http:\/\//i, 'https://');
    /* Both spellings — the parameter appears mid-string and, on a few records,
       first. A blind `&edge=curl` replace leaves a stray `?&` behind. */
    url = url.replace(/([?&])edge=curl&?/gi, '$1').replace(/[?&]$/, '');
    const zoom = this.ZOOM[size] || '1';
    url = /[?&]zoom=/.test(url)
      ? url.replace(/([?&]zoom=)\d+/i, '$1' + zoom)
      : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'zoom=' + zoom;
    return url;
  },

  /* The public volume page, for the inspector's external links. Built from the
     id rather than kept from `infoLink`, because infoLink carries a `source`
     tracking parameter and a locale that the reader did not choose. */
  infoLink(id) {
    const clean = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
    return clean ? `https://books.google.com/books?id=${clean}` : null;
  },
};

BT.LIMITS = {
  driftHistory: 20,
  feedPrimary: 50,
  searchResults: 30,
  /* An editions list for a classic can run to several hundred printings.
     Beyond the first page nobody is choosing an edition, they are scrolling,
     so we ask for one page and stop. */
  editionsPerWork: 50,
  /* Subject chips shown before the "more" fold. Post-stoplist a well-catalogued
     work still carries 40+ subjects; a dozen is where the useful ones stop. */
  subjectsShown: 12,
  authorWorks: 60,
  /* How many Google volumes one author query gathers before deduplication.
     Google has no work graph, so a prolific author's first forty rows are
     routinely a dozen books in three printings each — the cap is on RAW ROWS,
     and the number of distinct books that survives is much smaller. Two pages
     of forty, which is the ceiling one request can return. */
  gbAuthorVolumes: 80,
  /* Longest raw scan string we will even try to normalize. A barcode scanner
     acting as a keyboard occasionally emits a burst of junk on a bad read, and
     there is no legitimate symbology in this app longer than an EAN-13 with an
     AIM prefix and a five-digit add-on. */
  scanInputMax: 32,
};
