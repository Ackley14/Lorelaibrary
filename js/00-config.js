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

   Open Library (primary) — NO key, no signup, no quota page. The whole catalogue
                            path (search, works, editions, authors, covers) runs
                            keyless. This is why BookTrak needs no setup at all.
   Google Books (optional) — user-supplied ONLY. Keyless Google Books is dead:
                            an unauthenticated volumes request now answers HTTP
                            429 with "quota_limit_value":"0" — a quota of zero,
                            not a quota we exceeded. Verified. So there is no
                            key to bake and no anonymous fallback to fall back
                            to; `BT.config.hasKey('googlebooks')` gates that
                            entire code path off when absent, and the app is
                            expected to run its whole life with it off.
                            Get one: https://console.cloud.google.com/apis

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
    /* Open Library's language filter takes MARC/ISO codes ('eng'), while its
       search takes a plain 'en'. We store the short form and let the net layer
       widen it — storing the wide form would leak a source's vocabulary into
       the settings file that we then have to migrate. */
    language: 'en',
    region: 'US',
    /* Every genre bucket visible by default. `general` is the neutral
       catch-all and is included so that switching it off actually hides the
       unclassifiable pile rather than silently pinning it on. */
    genres: {
      fiction: true,
      nonfiction: true,
      fantasysf: true,
      mystery: true,
      romance: true,
      general: true,
    },
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
      };
    },
    importSettings(obj) {
      if (!obj || typeof obj !== 'object') return;
      const allow = ['language', 'region', 'genres'];
      for (const k of allow) if (k in obj) settings[k] = obj[k];
      save();
    },
    reset() { settings = structuredCloneSafe(DEFAULTS); save(); },
  };
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
                 reason a user's own key gets throttled elsewhere.

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
  googlebooks: { rps: 2,   concurrency: 2, retries: 1, dailyBudget: 400,  monthlyBudget: null, timeout: 10000 },
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

/* ── Genre bucketing ──────────────────────────────────────────────────────
   Six buckets, matched in order — FIRST rule that hits wins, so the specific
   buckets must precede the general ones. This ordering is not cosmetic:
   "Fantasy fiction", "Detective and mystery stories" and "Love stories" all
   contain or imply `fiction`, so if `fiction` were tested first every genre in
   the app would collapse into one.

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
    bucket: 'fantasysf',
    match: [
      /\bfantasy\b/i,
      /\bscience[\s-]?fiction\b/i,
      /\bsci[\s-]?fi\b/i,
      /\bspeculative fiction\b/i,
      /\bdystopia/i,
      /\bcyberpunk\b/i,
      /\bsteampunk\b/i,
      /\bspace opera\b/i,
      /\bepic\b/i,
      /\bsword and sorcery\b/i,
      /\bmagic(al)? realism\b/i,
      /\bparanormal\b/i,
      /\bhorror\b/i,
      /\bsupernatural\b/i,
      /\bvampire|werewol|zombie/i,
      /\bwizard|dragon|elves|sorcer/i,
      /\bfairy tales?\b/i,
      /\bmythology\b/i,
      /\butopia/i,
      /\btime travel\b/i,
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
      /\bregency\b/i,
    ],
  },
  {
    bucket: 'nonfiction',
    match: [
      /\bnon[\s-]?fiction\b/i,
      /\bbiograph/i,
      /\bautobiograph/i,
      /\bmemoir/i,
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
      /\bcorrespondence\b|\bdiaries\b|\bletters\b/i,
      /\bstudy and teaching\b/i,
      /\bhandbooks?, manuals\b/i,
    ],
  },
  {
    bucket: 'fiction',
    match: [
      /\bfiction\b/i,
      /\bnovel/i,
      /\bshort stories\b/i,
      /\bliterary\b/i,
      /\bclassics?\b/i,
      /\broman\b/i,          // French/German catalogue records say 'Roman'
      /\bhistorical fiction\b/i,
      /\bwar stories\b/i,
      /\bfamily sagas?\b/i,
      /\bcoming of age\b/i,
      /\bbildungsroman\b/i,
      /\bsatire\b/i,
      /\bhumor(ous)? stories\b/i,
      /\bpoetry\b|\bpoems\b/i,
      /\bdrama\b|\bplays\b/i,
      /\bgraphic novel/i,
      /\bcomics?\b|\bmanga\b/i,
    ],
  },
  /* No `general` rule on purpose. `general` is what you get when nothing
     matched, not something you match into — a bucket that can be reached two
     ways is a bucket whose contents nobody can explain. */
];

/* Every bucket id the app knows about, in display order. `general` last
   because it is the residue, and it renders with neutral text rather than a
   hue (see the --bt-genre-* tokens: there is deliberately no --bt-genre-general). */
BT.GENRE_BUCKETS = ['fiction', 'nonfiction', 'fantasysf', 'mystery', 'romance', 'general'];

BT.GENRE_LABELS = {
  fiction: 'Fiction',
  nonfiction: 'Non-fiction',
  fantasysf: 'Fantasy & SF',
  mystery: 'Mystery & Crime',
  romance: 'Romance',
  general: 'General',
};

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
   Enrichment only — descriptions, categories and page counts where Open
   Library has a gap. Never the primary source, never load-bearing, and never
   called at all unless BT.config.hasKey('googlebooks') is true. */
BT.GB = {
  volumes: 'https://www.googleapis.com/books/v1/volumes',
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
  /* Longest raw scan string we will even try to normalize. A barcode scanner
     acting as a keyboard occasionally emits a burst of junk on a bad read, and
     there is no legitimate symbology in this app longer than an EAN-13 with an
     AIM prefix and a five-digit add-on. */
  scanInputMax: 32,
};
