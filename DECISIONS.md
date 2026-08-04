# Decisions

Things that were settled deliberately, with the reason. Change them if the
reason stops holding — but read the reason first.

## Constraints these all follow from

1. **There is no book API worth having; Open Library is the last one
   standing.** Goodreads' keys were retired at the end of 2020 with no
   replacement, Amazon's PA-API needs an affiliate account with sales history,
   StoryGraph has never published one, Hardcover and ISBNdb answer **401**
   without an account, WorldCat's classify endpoint answers **404**, Bookshop
   has no API at all, and Google Books anonymous is switched off at the
   provider (**429**, `"quota_limit_value":"0"`). Open Library is chosen by
   elimination, not by quality.
2. **A public repo cannot hide a key.** Not with `.env`, not with an Actions
   secret injected at build. Anything the browser sends, a visitor can read.
   `BT.BAKED_KEYS` is empty on purpose.
3. **A book is a work *and* an edition, and they are different objects.**
   "Dune" is not the 1990 Ace paperback. A tracker that holds only one of them
   can either dedupe or audit a shelf, never both — so identity, the ISBN
   namespaces and the whole scan path are built around holding both at once.
4. **Open Library is a volunteer catalogue on a charity's server.** ~1 req/sec
   documented (3 if identified), explicit prohibition on use as a high-traffic
   backend, dates at year granularity, and fields that come and go record by
   record. The app is written for that data, not for the data we wish it were.
5. **A static page has no memory between visits.** "What changed" is therefore
   a *stateful* comparison, done by diffing against a snapshot in IndexedDB
   when the app opens.

## Architecture

**D1 — Item identity is `book:<source>:<id>`.** `book:openlibrary:OL27482W`
for a search-add (work-scoped, `scope:'open'`), `book:isbn:9780441172719` for a
scan (edition-scoped, `scope:'closed'`). The uid is immutable — it is the
foreign key in snapshots, alerts, follows, history and the URL — so all mutable
id mapping lives in the `idIndex` store, never in the uid.

**D2 — `isbn13:` is an ownership claim; `isbncand:` is a possibility.** This is
the load-bearing decision in the app. Open Library lists forty ISBNs for a
popular work, so if a searched book wrote those into the pinned namespace then
every edition of every book you had ever *searched* would answer "already
owned" to the scanner, and scanning a second printing could never create a
second item — the exact opposite of what the app is for, failing silently, with
no error. Hence four namespaces: `olwork:` (search-add dedup), `oledition:`,
`isbn13:` (written only by `scope:'closed'` items), `isbncand:` (written only
by `scope:'open'` items), and a resolver that returns *which one* matched —
pinned means "you own this exact edition", candidate means "which copy is
this?". **Arbitration:** a pinned row is taken from another item only by the
item whose *own* barcode it is; two genuine claims resolve first-writer-wins
(so an export/import rebuild lands on the same winner as the live store);
candidates are not arbitrated at all and are last-writer-wins, because two open
items may legitimately list the same ISBN. Before that rule existed, scan-add
stole rows: of the first 200 of The Hobbit's 481 edition records, 12 ISBN-13s
are claimed by more than one edition, so scanning B took A's row, remove-by-scan
then deleted B with its rating, notes and history, and A became invisible to the
scanner and duplicated on the next scan.

**D3 — Open Library is primary by elimination, so relevance is fixed
client-side.** Its own ranking is not usable: `q=dune` returns *Children of
Dune* first and the actual novel far down, misattributed to Brian Herbert with
year 2001. `js/61-view-search.js` re-ranks every result set locally, scoring
`author_name` as well as title — without the author half, author-name searches
returned **zero** results, because the multi-word coverage gate filtered
everything out. Do not delete the re-ranker as over-engineering; it is the
search quality.

**D4 — Never send `sort=` beside a free-text `q`, and never trust
`author=<name>`.** `?q=dune&sort=editions` answers **HTTP 200** with *Robinson
Crusoe* — the query is silently discarded, so there is no failure to catch, only
a confident wrong answer. `?author=gwendolyn+kiste` returns **Laird Barron's**
books. `sort=` is safe only on an `?author=` query (no `q` to eat), and author
scoping is OLID-only — which is why a follow is an OLID and never a name.

**D5 — Google Books is key-only and purely additive.** Anonymous access is
switched off at the provider, so there is no fallback to fall back to and
nothing to bake; `hasKey('googlebooks')` gates the entire path, and a keyless
install issues **zero** googleapis requests. What it buys when present is real
dates (`2024-03-05`, `2021-05-04`) where Open Library has only a year. It is
retried four times because `volumes` sheds load hard and recovers instantly —
12 of 20 identical requests answered `503 backendFailed` and the next attempt
succeeded — and retries cost bucket tokens but not budget units.

**D6 — Publication precision is first class, and a coarser answer never
overwrites a finer one.** `publish_date` is free text and almost always a bare
year (11 of 12 Hobbit editions; the exception read `'15 julho 2019'`), and
`first_publish_year` is a computed minimum that one mis-catalogued reprint drags
back decades — *The Alloy of Law*, published 2011, reports 2001. So the model
is `day|month|quarter|year|tba|unknown` plus a `sortKey`, never a bare
`release.date`, and the merge compares precision rank before confidence: a
Google-supplied day never gets flattened back to a year by the next Open Library
sweep.

**D7 — Genre is a curated bucket taxonomy over noisy subjects.** Open Library
subjects are decades of library-cataloguing strings from different
institutions ('Fiction', 'FICTION / Fantasy / Epic', 'Roman', 'juvenile
fiction'), and Google's are BISAC headings; one ordered, first-match-wins table
has to eat both. Twelve built-in buckets are **fixed** — they are the ids in
every library in the wild and in static CSS — and a user's own genres are
additive, `x-`-prefixed so they cannot shadow a built-in, with optional keywords.
Like MovieTrak's RAWG stoplist this table is a permanent maintenance burden and
the biggest quality lever in the app; order in it is load-bearing, and the
comments say which failure each position prevents.

**D8 — Colour names the family; the label names the genre.** Twelve genres, six
hue families, shared value-for-value with MovieTrak. Fantasy and Science Fiction
are both ice because they are one neighbourhood of the shelf. A seventh hue
would be a hue the sibling app does not have, in a palette whose whole point is
that both wear it — and twelve hues at 7px in a tree row would not be
distinguishable anyway. A custom genre picks a family, never a colour.

**D9 — `user.pile` is a separate axis from `user.status`.** A book can be
finished and kept, finished and marked to sell, or unread and already sold on.
Collapsing "have I read it" into "do I still own it" is the mistake every other
tracker makes. A sold book keeps its rating, notes, progress and history — the
record survives, `?pile=sold` still lists it, and only the default library view
hides it.

**D10 — Progress promotes, but it never finishes a book.** A recorded page
position on `want` or `have` means you started it, so both front rungs promote
to `reading`; reaching the last page must never set `finished`, because
finishing is a decision the reader makes and not something inferred from a
number. Gated on a real position, so typing in a page count is bookkeeping, not
reading.

**D11 — The barcode decoder is vendored, not CDN-linked.** Native
`BarcodeDetector` does not exist on Chrome or Edge for Windows or Linux desktop
(verified false on this machine), so the ZXing wasm ponyfill is the primary path
rather than a fallback. It ships in `js/vendor/` because a scanner that needs
the network to decode is a scanner that fails in a bookshop basement — and the
library's hardcoded `fastly.jsdelivr.net` wasm URL is overridden through
`locateFile` resolved against `document.baseURI`, since the app lives on a
subpath and an origin-root URL 404s there.

**D12 — The scanner is an overlay, not a route.** iOS standalone PWAs revoke
camera permission on a `location.hash` change (WebKit 215884, still open), so
routing to a scanner would close the scanner. The camera opens over the current
view and calls `BT.router.suspend()`; nothing inside it may touch
`location.hash`.

**D13 — Scanning never blocks on the network.** Decoding, the accept gate and
the library write are local and immediate; only the catalogue lookup goes
through a serialized queue, because Open Library documents ~1 req/sec and a
person emptying a box of books will out-scan that by an order of magnitude. The
queue depth is shown, because a screen that looks idle while it is working is a
screen people scan into twice.

**D14 — Encrypt the library; do not store a password.** A hash in a public repo
is an offline cracking target, and the check would run in JavaScript the visitor
controls. AES-GCM's authentication tag failing on a wrong-key decrypt *is* the
login, and it cannot be bypassed because there is nothing to bypass.
PBKDF2-SHA256 at 600,000 iterations (OWASP guidance; WebCrypto has no Argon2).
Sync is additive throughout: unconfigured means no gate, no errors, and no
behaviour change anywhere.

That last clause was stated before it was true. Until 2026-08-03 the sign-in
screen fetched `data/library.enc.json` for anybody who reached `#/unlock` on the
published site, because `configured()` only means *we can name a repository* and
`inferRepo()` names one for every visitor to a `github.io` URL. Nobody had
published, so it 404'd — three times, once per fallback url — and every engine
printed a console error for each before a line of our code could explain it. **A
404 there is data, not a fault:** "no library has been published yet" is the
ordinary first-run state of a repository, and the app was announcing it as a
failure. Looking is now gated on `enrolled()`, the same local synchronous test
the gate itself uses, and a device that has never synced is *asked* which it
wants before anything is fetched. The rule is the one `05-net.js` already
applies to Google Books: with nothing configured, issue **zero** requests rather
than ones guaranteed to fail.

**D15 — The service worker caches the app shell and nothing else.** API
responses are passed straight through to the network. `BT.net` already owns
caching, rate limiting, budgets and TTLs; a second HTTP cache underneath it
would be a second opinion about freshness that no code in the app can see or
invalidate. `data/library.enc.json` is explicitly never served from a cache — a
stale copy is a lost sync.

**D16 — Namespace isolation from MovieTrak is load-bearing, not tidiness.** The
two apps share the `ackley14.github.io` origin, and localStorage and IndexedDB
are scoped to the origin, not the path. Every key here is `bt.`, the database is
`booktrak`, every CSS var is `--bt-`, and every Cache Storage key starts
`bt-shell-` (so `activate` deletes our old shells and not the sibling's). A
stray `mt.` prefix does not fail loudly — it reaches into the other app's data.

### Google Books is the primary source; Open Library is retained for the graph

The app was built Open-Library-first and is not any more. The reason is
measured and is in the table below: Google wins search relevance, wins dates
outright (a real `YYYY-MM-DD` against a bare year), and is the **only** one of
the two that knows about books that have not come out yet. That last point is
the whole pivot — a reader following an author wants to know what is coming.

Open Library is not a fallback that happened to be left in. It is kept for
three things Google structurally cannot do:

- **the work/edition graph.** A Google volume id names ONE PRINTING. There is
  no editions-of-a-work endpoint, so "Specify edition" and the `isbncand:` net
  the scanner resolves against can only come from Open Library.
- **stable author OLIDs.** A Google author is a bare name string, and a
  name-scoped author query returns the wrong writer's books at HTTP 200 in
  *both* catalogues. A follow may only be keyed on an OLID.
- **running the app with no key at all.** Google has no anonymous tier — it is
  a quota of zero, not a small one. Without a key BookTrak still searches,
  adds and scans, on Open Library, with year-granular dates, and says so once
  with a link to Settings rather than as ambient explainer text.

**Nothing migrates.** A row both catalogues return keeps Open Library's
identity (`book:openlibrary:{OLID}`) and takes Google's facts, so every book
already on the reader's shelves still dedupes on `olwork:{OLID}` exactly as
before. Only a book Open Library has never heard of — which is what a
forthcoming title is — gets a `book:googlebooks:{id}` uid, in a namespace
nothing existing can collide with. `BT.normalize.mergeSearchStubs` is the one
place the two are reconciled.

**Precision is a ratchet, in both directions.** `pickRelease` refuses any
payload coarser than what is already stored, whichever source it came from, so
Google's day beats Open Library's year *and* Google's coarse backlist year
cannot take back a real day off an Open Library edition record. Neither source
is trusted by name; precision is.

**Explainer microcopy is gone app-wide.** What survives is empty states that
say what to do, real error messages, and source attribution. The reasoning
moved into code comments and into this file.

## Verified live (2026-08-03), not assumed

| Claim | Result |
|---|---|
| Google Books anonymous `volumes` request | **429**, `"quota_limit_value":"0"` — a quota of zero, not one we exceeded. Two IPs, three endpoints |
| Hardcover / ISBNdb / WorldCat / Bookshop as alternatives | 401 · 401 · 404 · no API. Elimination, not preference |
| `search.json?q=dune` | *Children of Dune* first; the novel far down, attributed to Brian Herbert, year 2001 |
| `search.json?q=dune&sort=editions` | **HTTP 200** and *Robinson Crusoe* — the query is silently discarded |
| `search.json?author=gwendolyn+kiste` | Laird Barron's books. Name-scoped author queries are unusable |
| `/isbn/{isbn}.json` | **302** (two round trips); a miss returns **HTML with HTTP 404**, so `.json()` throws `SyntaxError` — check `res.ok` first |
| Edition field presence, three real ISBNs | Always: `key`, `works`, `title`, `publishers`, `publish_date`, `covers`. `number_of_pages` 2/3, `physical_format` 1/3, `authors` 1/3, **`isbn_13` 2/3** — one lookup *by* ISBN-13 returned no `isbn_13` |
| `/works/{id}/editions.json` | Paginates at **50** via `?offset=`. The Hobbit: **481** editions → **310** distinct ISBN-13s; 30% lack `isbn_13`, **13% have no ISBN at all**. `?limit=1000` works but is **0.48 MB** |
| ISBN-13 uniqueness across editions | False. 12 codes in the first 200 Hobbit editions are claimed by more than one edition — the reason pinned rows are arbitrated |
| `publish_date` granularity | Free text, bare year in 11 of 12 Hobbit editions (`'15 julho 2019'` the exception). `first_publish_year` wrong on *The Alloy of Law* (2011 → 2001) |
| Google Books with a key | Real dates: `2024-03-05`, `2021-05-04`. Also 12 `503 backendFailed` in 20 identical requests, each succeeding on a later attempt |
| A missing cover image | **HTTP 200 and a 43-byte transparent GIF**, so `<img onerror>` never fires — `?default=false` required. `covers` arrays contain a `-1` sentinel |
| Text fields (`description`, `bio`) | Sometimes a string, sometimes `{type,value}`. Rendering raw prints `[object Object]` |
| `/search/authors.json` | Returns a **bare OLID**; every other endpoint returns a path |
| **Google Books `q=dune` with a key** | Frank Herbert's *Dune* **first**, correctly attributed. This is why Google leads search now — Open Library answers the same query with *Children of Dune* first and the real novel eighth |
| **Google `publishedDate` granularity** | Full `YYYY-MM-DD`. *Wind and Truth* → `2024-12-06` where Open Library holds a bare `2024`. Forthcoming titles exist in this index and do **not** exist in Open Library's at all |
| **`orderBy=newest`** | Does **not** sort by publication date — it sorts by when Google *added the record*. Observed publication years in returned order: 2023, 2020, 2024, 2018. Anything needing date order must sort client-side (`BT.googlebooks.sortByPublished`). Still useful as a discovery **arm**: a forthcoming title is a recently-added record, so it nets exactly the books relevance ranking buries |
| **`inauthor:` in Google** | `inauthor:"Stephen King"` → **zero**. `inauthor:Kiste` → 300 books about Queen Victoria. Plain `"Gwendolyn Kiste"` → her real books. So the query is a **net** and the credit check on `volumeInfo.authors` is the answer |
| **Google's top hit for `dune` is a reprint** | `publishedDate 1990-09-01` (and on another run `2023-09-26`, *Movie Tie-In*). Real dates about real objects, and the **wrong** date for a search row, which is a WORK. Hence the year gate in `BT.normalize.workDate`: Google may sharpen Open Library's year, never move it forward |
| **Surname-only author matching** | Merged Google's *Dune* into Open Library's **Brian** Herbert work record (`OL19618275W`), which then took the 1990 printing date — two failures from one loose compare. `personKey` is `surname\|first-initial` for this reason, and the same fold keeps Tabitha King out of Stephen King's bibliography |
| **Open Library transliterated author duplicates** | `OL893414W` is credited to both `Frank Herbert` and `Френк Герберт` — one man, two rows. A name that folds to nothing under `normalizeTitle` is dropped from a merged byline |
| **Google `imageLinks` URLs** | Arrive as `http://` (blocked as mixed content on the https site) and carry `edge=curl`, which draws a fake page curl into the pixels **server-side**. Both corrected in `BT.GB.cover`; `zoom=` sets the size |
| **`langRestrict` / `language=` server-side filtering** | Both filter on a *declared* value, so both delete records that declare nothing — which is disproportionately the thin, newly-catalogued records a forthcoming title always is. Filtering is therefore client-side in `BT.lang`: **keep the undeclared, drop only a declared foreign language** |
| **Language filtering measured on a real editions page** | Dune, first 50 fetched: 39 shown, **11 hidden**, 5 with no usable ISBN. Paging still advances by what the endpoint returned, never by what survived |
| `BarcodeDetector` on Chrome/Edge, Windows desktop | Does not exist. The vendored ZXing wasm is the primary decoder, not a fallback |
| The `barcode-detector` ponyfill | Contains a hardcoded `fastly.jsdelivr.net` wasm URL; must be overridden via `locateFile` against `document.baseURI` |
| First load on a phone (Slow 4G, 4x CPU, 390x844, cold, **live** GitHub Pages) | First paint **3.6 s**, tree **3.8 s**, 36 requests, **494 KB** on the wire. A local HTTP/2 harness reproduced this within 4%; an HTTP/1.1 one did not, and flattered first paint by two seconds |
| What blocks that first paint | The stylesheets — and `css/04-views.css` lands **last of all 36 responses** (3.56 s), because H2 shares the throttled pipe round-robin between 5 stylesheets and 448 KB of script. Serve the CSS alone and first paint is **1.47 s** |
| `defer` / `fetchpriority="low"` on the 31 script tags | **No effect whatsoever** (first paint 3472 ms vs 3476 ms). Neither Fastly nor any H2 server here honours stream priority, so a hint cannot reorder what a round-robin is already sharing. The only lever is not *issuing* the requests |
| What a first visit actually cost | **84 requests, 1458 KB** — not 494 KB. `sw.js` registers at end of parse and its install downloaded every shell file a **second** time (`cache:'reload'`, 503 KB) plus the **450 KB** decoder wasm, none of it visible in the page's own resource timing |
| `cache:'no-cache'` in place of `'reload'` | 37 of those files come back **304, zero bytes**, from GitHub Pages itself (verified with `If-None-Match` against production). Same staleness guarantee, 503 KB cheaper |
| A repeat visit, once the worker is installed | First paint **96 ms**, tree **~150 ms**, **zero** network requests. The precached shell was already doing its job and needed no change |
| A first visit to `#/unlock` on the published site | **Three HTTP 404s** for `data/library.enc.json` — relative, then `raw.githubusercontent` `main` and `master` — and a console error for each, in all three engines, for a file that correctly does not exist. Invisible locally forever: `localhost` infers no repository, so `configured()` is false and the read never ran |
| Reproducing that inference locally | Serving the working tree at `https://ackley14.github.io/Lorelaibrary/` through Playwright request interception makes `location.hostname` genuinely `ackley14.github.io`, so `repoSource()` really returns `inferred`. Reverting the gate to `configured()` under that harness reproduces the production signature exactly — **3 requests, 3 × 4xx, 3 red console 404s** — where a `127.0.0.1` harness reports 0/0/0 whether the code is fixed or broken. A `bt.gh.repo.v1` override seeded before boot covers the other half (`stored`), which inference can never produce |

## Open

- **Google serves a grey "image not available" placeholder as a real cover.**
  A volume with no art can still carry `imageLinks`, and the image loads with
  HTTP 200 — so `<img onerror>` never fires and the app's generated bookcloth
  block never replaces it. Same class of trap as Open Library's 43-byte
  transparent GIF, but visibly benign: it reads as "no cover" rather than as a
  broken tile. No field distinguishes it and no client-side signal was found,
  so it is accepted rather than worked around.
- **A book Google does not return for a broad query keeps its Open Library
  year.** *The Haunting of Velkwood* is not in the top 40 for `gwendolyn
  kiste`, so its search row shows `2024-▨▨-▨▨` even though Google holds
  `2024-03-05`. The targeted `intitle:`+`inauthor:` upgrade path finds it once
  the book is added; the broad query is a ranking limit, not a merge fault.
- **Real-device camera scanning is unverified on glossy and curved covers.**
  The decoder, the accept gate and the whole scan path were exercised with
  generated and printed codes; a laminated mass-market paperback under a ceiling
  light is the case that will actually break, and it has not been tried. Typing
  the ISBN is always available, which is why this is Open rather than blocking.
- **The genre keyword table in `00-config.js` is a permanent maintenance
  burden** and the single biggest quality lever in the app. A book in the wrong
  bucket is the most visible kind of wrong, because the reader knows what they
  read. Add rules when you see a miss; do not replace the table with something
  that guesses.
- **"Coming up" is inherently thin.** Open Library has no forthcoming-title
  concept — no announcement flag, no street date, no publisher feed — so there
  is nothing to build a real releases timeline out of. Activity therefore says
  "newly listed in this catalogue" rather than "new release", which is literally
  what was observed and also catches reprints and translations. The route is a
  placeholder until there is honest data to fill it.
- **Barcode edge cases in the wild.** An EAN-5 price add-on makes a wedge emit
  **18 digits**, UPC-A is 12, and AIM prefixes (`]E0`/`]E4`) inject a corrupting
  digit. All three are handled and none has been seen from real hardware here.

## Deferred

**A real recommender.** MovieTrak's is a hybrid of a taste profile and a
similarity graph; Open Library has subjects but no similarity graph at all, so
half the scorer has no input and the other half would be tag overlap wearing a
confident name. Better absent than dishonest.

**Hardware wedge scanning** — the input path exists and the length ceiling and
AIM-prefix handling are written for it, but there is no wedge here to test
against, so it is unproven rather than supported.

Price and retailer data (no free browser-reachable API; Amazon's needs affiliate
sales history) · full-text search inside books (Internet Archive lending, not
the catalogue API) · Goodreads/StoryGraph sync (no public write API) · push
notifications (nothing runs while the app is closed) · a "coming up" timeline
with real forthcoming dates in it.

## Following: two catalogues, one cached answer

The Following page and `70-follows.js` were rebuilt for the pivot. What follows
is the reasoning that used to be printed on the screen.

### The follow record now carries two identities

Google has **no author ids at all** — a volume id names one printing, and the
only handle the index offers for a person is the exact name string it prints in
`volumeInfo.authors`. Open Library has stable OLIDs. They are different kinds of
thing, so the row keeps both and asks each source with the identifier it
understands:

| field | example | used for |
|---|---|---|
| `olid` | `OL7481853A` | `search.json?author={OLID}` — exact, never a name |
| `gbName` | `Gwendolyn Kiste` | the Google query, and the credit check on every volume that comes back |
| `gbNameSource` | `seed` → `volume` | whether that string is a guess or something Google actually printed |

`gbName` is **seeded at follow time** from whatever the Follow button had to
hand and **confirmed on the first check** against the most frequent exact string
across the verified volumes. The source flag moves to `volume` even when the
string did not change, because a guess that turns out to be right has still been
verified and a row that could not tell those apart would re-guess for ever.

Either half may be missing. A follow with no OLID is keyed
`author:googlebooks:{slug}`; `authorId(olid)` is **unchanged**, so every follow
already in the user's synced database keeps its key. The OLID-less path is
opt-in (`toggleAuthor(olid, name, { googleOnly, gbName })`) precisely so that
`61-view-search.js` and `56-inspector.js`, which call it with two arguments and
read `null` as "no id, refuse", keep the behaviour rule 2 exists for.

### Neither author query is trusted; the credit check is

`inauthor:` is unusable (`inauthor:"Stephen King"` → **zero results**;
`inauthor:Kiste` → 300 books about Queen Victoria) and `search.json?author=`
with a *name* returns a different writer's bibliography at HTTP 200. So the
Google query is a **net** — a plain quoted name — and the filter is the volume's
own `volumeInfo.authors` array. Open Library is asked by OLID, which needs no
such check.

None of that is implemented here. `BT.googlebooks.authorWorks` owns the query
shape, the two arms, the credit check (`creditsAuthor`, keyed
`surname|first-initial` so Tabitha King stays out of Stephen King's feed), the
language filter and the printing grouping; `BT.normalize.matchKey` owns "same
book?"; `BT.lang` owns "may this be shown?". A private copy of any of them here
would be a second answer, and the symptom is a duplicate row no call site can
explain.

**What 70-follows.js does own is depth.** `authorWorks` asks each arm once, at
offset 0 — right for a lookup, measurably not enough for a follow:

| author | adapter default | + two relevance pages |
|---|---|---|
| Brandon Sanderson | 20 credited volumes | **39** — and the extra pages held his only forthcoming printing |
| Stephen King | 13 | **22** |
| Gwendolyn Kiste | 7 | **15** |

So the refresher calls the adapter and then pages it twice more through the
adapter's own `search` + `creditsAuthor` + `groupPrintings`. Four Google calls
per follow per refresh, well inside the 400/day budget for a roster of twenty
refreshed six times a day.

### The union is keyed on `BT.normalize.matchKey`

There is no shared identifier: Google has no OLIDs, Open Library's author-works
field list carries no ISBNs. So the join is "same title, same person", through
the one fold 38-normalize.js exports for exactly this purpose. **The follow's
own name is passed on both sides**, because an Open Library author-works doc
carries no author field at all — key the Open Library side on the title alone
and it folds to `wind and truth` against Google's `wind and truth|sanderson-b`,
so the two halves never merge and every book either source knows about appears
twice. Every row in the list is by definition this author's, so supplying the
name is not an assumption. **The year is deliberately not part of the key** — Open Library's year for a work is frequently a decade early,
so keying on it would refuse to merge exactly the rows where Google has the real
date. On a merge, Google's date wins when it is no coarser, and Open Library's
work id and cover are kept because Google does not have them.

Two printings of one title collapse to the row that is **still ahead of us**,
because that is the user's own rule ("i just want things listed with a
publication date that is in the future from the current date"). `firstYear`
survives the collapse so the card can say `first published 2024` rather than
implying the work is new.

### An author is only ever said to have nothing coming when both were asked

`coverageOf(row)` is the one place that is decided. A source that **failed** is
recorded and named on the row; a source that is **switched off** (no Google key)
is not a failure — the app falls back to Open Library, still gives a hard
answer, and says so **once**, at the top of the page, with a link to Settings.

### The migration that would otherwise have flooded the feed

A follow written by the previous build has a `knownWorkIds` full of Open Library
work OLIDs. The new baseline is folded titles, and Google contributes rows Open
Library never had — so the first diff would have reported **every book of every
followed author as new, at once**. `refreshOne` treats a row whose `schema < 2`
exactly like a first sighting: re-baseline, emit nothing, stamp `schema: 2`.
`knownWorkIds` and `works` are left on the row rather than deleted, because the
migrating check needs to see them to know it is not cold, and because this user
syncs real data. Measured: 41 works stored, 41 keys baselined, **0 added, 0
changed, 0 feed rows, 0 news** — and the very next check diffs normally.

A finer date inside the window a coarse one described is also **not** a change:
`2026 → 2026-10-06` is us learning something. Without that test, every row
Google sharpened would have been announced as a date change on the pass that
sharpened it.

### The release-window toggle: containment, not overlap

`next week · this month · next month · end of year · next year`, pooled across
every follow, with the per-author rows below. Windows come from
`BT.util.releaseWindow`, so this page and `#/up` agree about where a month ends.

A release is **in** the window when its own window fits inside the asked-for one,
and **could fall here** when the two merely overlap. Under a plain overlap test,
Open Library's bare `2026` for *Isles of the Emberdark* appeared under four of
the five windows at once, as though four different things were happening. Both
groups are shown, each with its own count — the row is never dropped, and it
never impersonates a confirmed date.

### Verified live, 2026-08-03, with a real key

| Claim | Result |
|---|---|
| Union is not redundant | Google alone found *In These Gilded, Ghostly Hearts* (Kiste, `2026-09-15`) — Open Library has no record of it. Open Library alone found *Other Worlds Than These* (King) and *Isles of the Emberdark* (Sanderson) — neither was in any Google slice |
| The two halves feed each other | Open Library dated *Other Worlds Than These* `2026` (a bare year, undecidable). One targeted `intitle:+inauthor:` lookup returned **`2026-10-06`** — a real future date the primary source's own author query had missed |
| The English filter changes an answer | *Isles of the Emberdark* carries a 2026 in Open Library's `publish_year`. Google shows why: `2026-03-24` is the **Spanish** edition, the English one is `2025-07-01`. Filtering the translation is what stops a 2025 book being announced as forthcoming |
| Open Library's cover is not language-aware | `cover_i` for Sanderson's *Wind and Truth* is the Spanish *Viento y Verdad*. Cards therefore prefer Google's thumbnail whenever Google supplied the date, so the cover and the date describe the same printing |
| `maxResults=40` | Returns **20** for a quoted-name query, every time, on all three test authors. Paging steps by 20, not by the requested page size |
| Google `503 backendFailed` | Still 10–12 in 20 requests, still succeeding on a later attempt. `BT.NET_POLICY.googlebooks.retries = 4` is what makes the union reliable rather than intermittent |
| Cost per follow per refresh | 1 Open Library page + 3 Google slices + at most 6 targeted date lookups — and the sharpened date is **stored**, so a settled roster costs four requests, not ten |

---

## Verification pass — 2026-08-03

Independent re-verification of the pivot, on `127.0.0.1:9511/Lorelaibrary/`,
chromium 151 / firefox 153 / webkit 26.5. Two defects were found and fixed, and
one requirement was found to be only half-delivered.

### A refresh could blunt a date it already held, and then report the blunting

**Measured**, on four identical back-to-back refreshes of one author with
nothing changed upstream: Google's author arms do **not** return a stable set
for an identical query. *Boneset & Feathers* came back on three rounds and was
simply missing from the fourth — Google `503`s under load, `authorWorks` asks
two fixed arms at offset 0, and relevance ordering shifts underneath them.

On the round the volume went missing, `unionWorks` was rebuilt from Open Library
alone — whose record is a bare `2020` — and the stored `2020-11-03` was thrown
away. The diff then announced **`date moved: 2020-11-03 → 2020`**. A book that
had not moved, reported as news, on a refresh that had learned nothing. And it
flaps: the next round sees the volume again and announces the reverse, so one
unstable upstream row becomes a permanent two-lines-per-refresh feed spammer —
the exact failure the migration guard exists to prevent, arriving by another
door.

Two fixes, deliberately independent:

1. **`keepSharpestDate(held, works)`** in `70-follows.js`, run *before*
   `sharpenPass` (so a row we can already answer never spends a Google request
   being re-asked). A **coarser** answer that **agrees** with the finer one we
   hold is not information and does not overwrite it. A date that genuinely
   **contradicts** what we hold — a different year, a different month inside a
   month — passes through untouched, because that is the event the feature
   exists to catch. Losing a date entirely is treated as the same loss.
2. **The diff tests containment both ways.** It already skipped
   `year → day inside that year` as "us learning something". It now also skips
   `day → year containing that day` as "us knowing less". Both are true
   statements about precision, not about a schedule.

Verified after the fix: five consecutive fresh refreshes produce **0** news
entries and **0** date downgrades; a planted genuine move (`2024-01-05 →
2026-09-15`, different year) is still reported as `moved`.

### The explainer purge had only covered the Following page

Requirement: *no explainer microcopy, app-wide*. Following, Activity and the
footer were clean. Library first-run, Scan, Stats and Settings were not — and
three of those paragraphs had been made **factually false** by the pivot:

- Settings/About: *"Open Library … is the primary source here rather than a
  fallback"*, and *"Open Library holds no forthcoming-title data … which is why
  most publication dates in the app are year-only"*. Section removed; attribution
  already lives in the footer.
- Library first-run: *"Open Library needs no key and no account, so this works
  now"*, plus a warnbox lecturing that *"searching adds the book, not the
  edition"* — the work-versus-printing distinction is carried by the interface
  itself, which is where a distinction belongs.
- Stats: a `statnote` asserting Open Library's year-only dates are *"a ceiling on
  what this app can know"*. Replaced with the bare percentage, plus an
  actionable Settings link when there is no key.
- The `/search` boot stub still promised *"no key and no signup"*.

This is the failure mode that justifies the rule: explainer copy describes an
**implementation**, so it rots the moment the implementation moves — and then it
goes on lying with authority, from inside the product, to the one person who
cannot check it. Removed app-wide; what remains is empty states that name the
next action, statements about the reader's own data, real errors, and the footer.

Settings' key section keeps one prompt, because requirement 11 needs somewhere
actionable to point: a state line, a link that mints a key, and a field.
