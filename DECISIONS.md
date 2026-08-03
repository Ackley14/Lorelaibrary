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
| `BarcodeDetector` on Chrome/Edge, Windows desktop | Does not exist. The vendored ZXing wasm is the primary decoder, not a fallback |
| The `barcode-detector` ponyfill | Contains a hardcoded `fastly.jsdelivr.net` wasm URL; must be overridden via `locateFile` against `document.baseURI` |
| First load on a phone (Slow 4G, 4x CPU, 390x844, cold, **live** GitHub Pages) | First paint **3.6 s**, tree **3.8 s**, 36 requests, **494 KB** on the wire. A local HTTP/2 harness reproduced this within 4%; an HTTP/1.1 one did not, and flattered first paint by two seconds |
| What blocks that first paint | The stylesheets — and `css/04-views.css` lands **last of all 36 responses** (3.56 s), because H2 shares the throttled pipe round-robin between 5 stylesheets and 448 KB of script. Serve the CSS alone and first paint is **1.47 s** |
| `defer` / `fetchpriority="low"` on the 31 script tags | **No effect whatsoever** (first paint 3472 ms vs 3476 ms). Neither Fastly nor any H2 server here honours stream priority, so a hint cannot reorder what a round-robin is already sharing. The only lever is not *issuing* the requests |
| What a first visit actually cost | **84 requests, 1458 KB** — not 494 KB. `sw.js` registers at end of parse and its install downloaded every shell file a **second** time (`cache:'reload'`, 503 KB) plus the **450 KB** decoder wasm, none of it visible in the page's own resource timing |
| `cache:'no-cache'` in place of `'reload'` | 37 of those files come back **304, zero bytes**, from GitHub Pages itself (verified with `If-None-Match` against production). Same staleness guarantee, 503 KB cheaper |
| A repeat visit, once the worker is installed | First paint **96 ms**, tree **~150 ms**, **zero** network requests. The precached shell was already doing its job and needed no change |

## Open

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
