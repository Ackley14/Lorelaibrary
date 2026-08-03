# BookTrak

A library for the books you want to read, are reading, have finished, or gave
up on. One shelf, honest publication dates, real edition handling, and a
barcode scanner for the pile on the floor. No accounts, no server, no build
step — it is plain HTML that runs either from a web address or by
double-clicking `index.html`.

**Live:** https://ackley14.github.io/Lorelaibrary/

Why things are the way they are: [`DECISIONS.md`](DECISIONS.md).

---

## Read this first: it does not search Goodreads

Goodreads has no usable API any more. Amazon stopped issuing developer keys at
the end of 2020 and retired the existing ones; Amazon's own Product Advertising
API is gated behind an affiliate account that has to make sales before it will
answer. StoryGraph has never published one. Of the alternatives, Hardcover and
ISBNdb answer `401` without an account, WorldCat's classify endpoint answers
`404`, Bookshop has no API at all, and Google Books' anonymous tier is switched
off at the provider — an unauthenticated request now returns `429` with
`"quota_limit_value":"0"`, a quota of zero rather than a quota we exceeded.

So **search is powered by [Open Library](https://openlibrary.org/)**, run by the
Internet Archive: openly licensed bibliographic data, covers included, and — the
part that decides it — **no key and no signup at all**. Clone this repo, open
the file, start typing. Nothing to register for.

The trade is metadata quality, and BookTrak is built around it rather than
pretending otherwise:

- **Relevance is fixed in this app, not on the server.** Open Library's own
  ranking puts *Children of Dune* above *Dune* for `dune` and attributes the
  novel to Brian Herbert. Every result set is re-scored locally, on title *and*
  author, before you see it.
- **Scope is explicit.** A book added by search is **open scope** — the work,
  edition unspecified. Only a book you physically scanned, or one whose printing
  you picked by hand, is **closed scope**, pinned to the copy in your hands.
- **Dates say how much they know.** Open Library's `publish_date` is free text
  and almost always a bare year, so a book known only to 1965 is drawn as 1965
  with the day hatched out, never as January 1st.

---

## Setup

There isn't any. That is the point of the source choice.

| Source | Used for | Key | Free tier |
|---|---|---|---|
| **Open Library** | everything: search, works, editions, authors, covers | **none** | keyless, be polite |
| Google Books | fills in blurbs, page counts, ratings and *real* dates where Open Library is thin | **yours only** | 1,000 per day |

`BT.BAKED_KEYS` in [`js/00-config.js`](js/00-config.js) is deliberately empty.
A public repo cannot hide a key, there is no anonymous Google Books tier left to
fall back to, and the app is expected to run its entire life with that source
switched off.

Open Library asks API consumers to identify themselves so they can contact you
before they block you. Settings has a contact email field for that; it is
optional, it is excluded from exports, and it never leaves this browser except
on the requests it is attached to. The network layer throttles itself either
way.

---

## Two things you have to do yourself

Everything else is automatic. These two are not, and both are one click.

**1 · Recalculate genres, after any upgrade that changes the rules.**
Genres are not stored by the catalogue — they are *derived*, by mapping Open
Library's subject strings through an ordered table of rules in
`js/00-config.js`. A book is bucketed once, when it is added or refreshed, so a
rule added afterwards never reaches books already on your shelf. Horror is the
standing example: that bucket was added late, and anything shelved before it is
still filed where those subjects used to land. **Settings → Genres →
Recalculate genres** re-runs the rules over every book's stored subjects. It
shows what it is about to change, it can fetch missing subjects first, and it
has an Undo.

Genres you corrected by hand are **left alone by default**. If any exist, the
tool stops and asks before touching them, because recalculating a correction
also has to clear the `meta.manualOverrides` note that keeps a metadata refresh
from overwriting it — otherwise the catalogue's value would simply come back on
the next sweep. Every other book is re-derived either way.

**2 · Paste a Google Books key, if you want blurbs and exact dates.**
Optional, and the app never nags for it. Without a key BookTrak issues **zero**
googleapis requests — the whole path is gated off, not merely unused. With one,
it fills in descriptions, page counts and the dates Open Library only has to
year precision (`2024-03-05` where Open Library says `2024`). Get one from the
[Google Cloud console](https://console.cloud.google.com/apis), paste it into
**Settings → Google Books**. It is stored in this browser only, and it is
excluded from every export.

---

## Running it

**Locally — double-click `index.html`.** That is it; there is nothing to install
and nothing to compile. IndexedDB, WebCrypto and the whole catalogue path work
from `file://`.

**Except the camera.** `getUserMedia` only runs in a *secure context*, and
`file://` is not one — over a double-clicked file there is no camera to open, so
the scanner offers typing or a wedge scanner instead. To scan locally, serve the
folder:

```sh
python -m http.server 9110 --bind 127.0.0.1
# then open http://127.0.0.1:9110
```

`127.0.0.1` and `localhost` both count as secure origins. Use the numeric form:
on Windows `localhost` resolves to IPv6 `::1` first, and Python's server bound
to `127.0.0.1` is not listening there — you get a connection refused that looks
like the app failing to start.

A **LAN IP is not a secure origin**, so a phone on the same Wi-Fi cannot use the
camera against your laptop's `192.168.x.x`. Phones need the real HTTPS
deployment below.

**On GitHub Pages** — push to `main`, then **Settings → Pages → Source: Deploy
from a branch → `main` / `(root)`**. It is live at
`ackley14.github.io/Lorelaibrary` a minute later, over HTTPS, camera included,
and every subsequent push redeploys.

> **Every URL in this app is relative, and must stay that way.** The live site
> is served from a *subpath* (`/Lorelaibrary/`), so an absolute `/js/...` or
> `/sw.js` would 404 in production while working perfectly on a local root
> server. That includes the barcode decoder's wasm binary, which is resolved
> against `document.baseURI`.

> `file://` and your published site are separate browser origins, so they keep
> **separate libraries**. Move between them with the passphrase sync below, or
> with Export/Import.

> **BookTrak and MovieTrak share one origin.** They deploy to
> `ackley14.github.io/Lorelaibrary` and `ackley14.github.io/entertainmentwatch`,
> and localStorage, IndexedDB and Cache Storage are scoped to the origin, not
> the path. Every key in this app is prefixed `bt.`, the database is named
> `booktrak`, every CSS variable is `--bt-` and every cache is `bt-shell-`; the
> sibling uses `mt.` and `movietrak`. A stray prefix does not fail loudly, it
> reaches into the other app's data. Treat it as load-bearing.

---

## What it does

### The shelf

- **Five reading statuses** — *want*, *have*, *reading*, *finished*, *dropped* —
  kept strictly separate from **whether you still own the thing**. The
  to-sell pile is its own axis: a book can be finished and kept, finished and
  marked *to sell*, or unread and already sold on. Sold books keep their rating,
  notes, progress and history; they are hidden from the default shelf, not
  deleted.
- **Progress by page number**, shown as a percentage only when the record
  actually carries a page count, with an append-only reading log behind it.
  Recording a page on a book still filed as *want* or *have* promotes it to
  *reading* —
  reaching the last page never marks it *finished*, because finishing is a
  decision you make and not something inferred from a number.
- **An index tree** down the left: every status, all twelve genres, the three
  formats, both piles, Coming up, Activity, Stats and Following — most of them
  carrying a live count. `/` focuses its filter box, arrows walk it, `t` toggles
  the theme.
- **A shelf you can bulk-edit.** Select rows and mark them *to sell*, *sold*,
  *keep*, or clear the pile in one action. Sort by recently added, title,
  publication, your rating, progress or genre.
- **A detail pane** for every book: 1–10 rating, notes, status, format, pile,
  progress, genre chips you can correct by hand, the full edition record, and a
  Follow button on each author and publisher.
- **Two themes** — Vellum (light, warm parchment) and Marginalia (dark, warm
  ink). Geometry lives in a theme-invariant token block, so switching changes
  colour and material with no reflow.

### Finding books

- **Search** by title, author or ISBN in one box, re-ranked locally as described
  above. Arrow keys move the selection, `Enter` adds it; a book already on your
  shelf says so instead of offering to add it twice.
- **Scan the back cover.** Point the camera at an ISBN-13 barcode and the book
  lands as a specific edition — that printing, that cover, that page count. The
  decoder is vendored, so it works with no network. Scanning is deliberately
  never blocked on the catalogue: the write is immediate and the lookup goes
  through a queue whose depth is shown on screen.
  - A code you already own **pinned** → the app opens that book.
  - A code that matches a book you own with **no edition specified** → it asks:
    pin this printing to that book, or add a separate copy?
  - Anything else → a new book, hydrated in the background.
  - Scan again to **remove**, with an undo. Type an ISBN if the camera is not
    available. UPC-A, EAN-5 price add-ons and AIM prefixes from wedge scanners
    are all handled.
- **The editions picker.** For a book added by search, "which of these is the
  copy on your shelf?" — pick the printing and the record becomes closed scope,
  exactly as if you had scanned it.
- **Following authors and publishers.** Authors are followed by Open Library id,
  never by name — name-scoped author search returns the wrong writer's books
  often enough to be useless, so a record with no author id says so rather than
  guessing. Publisher follows are name-matched and admit it.

### Keeping up

- **Activity** — what changed since you last looked: a publication date that
  moved, and works that appeared in the catalogue of an author or publisher you
  follow. It says "newly listed in this catalogue" rather than "new release",
  because that is exactly what was observed; Open Library has no forthcoming-
  title data at all, so anything stronger would be a promise the source cannot
  keep.
- **Stats** — reading pace drawn from the log, shelf composition, genre and
  format breakdowns, most-shelved authors, publication by decade, and a date-
  certainty panel showing how much of your library is only known to the year.
  Every figure names its source, and a figure that cannot be supported is
  explained rather than printed as a zero.
- **Refresh happens while you use it.** Items are tiered by how likely they are
  to change — a 1965 novel is not polled like a book due next week — and a
  bounded number of requests is spent per sweep.
- **Installable, and works offline.** The service worker precaches the app
  shell; it never caches an API response, because the network layer already owns
  freshness. The barcode decoder's megabyte of wasm is the one thing left out of
  that first download — it arrives in the background the second time you open
  BookTrak, or the first time you actually scan, whichever comes first, so a
  first visit on mobile data does not pay for a camera nobody has opened.

### Settings

Genres (recalculate, and add your own with optional keywords and a hue family) ·
your Google Books key · sync across machines · the Open Library contact address ·
language and region · diagnostics (storage engine, book count, cached responses,
current origin) · export, import, clear cached responses, and erase everything.
Every section explains what it does and what it will cost you before you press
anything.

### Not yet

**Coming up** is a placeholder. Open Library has no announcement flag, no street
date and no publisher feed, and `first_publish_year` is a computed minimum that
one mis-catalogued reprint drags back decades — *The Alloy of Law*, published
2011, reports 2001. There is nothing honest to plot yet.

---

## Sync across machines

**Entirely optional, and off until you turn it on.** BookTrak is a local-first
library: a browser that has never set a passphrase never sees a sign-in screen,
never fetches anything from GitHub, and behaves exactly as described above. Turn
it on under **Settings → Sync across machines**.

Once you do, your library is encrypted **in the browser** and committed to this
repository as `data/library.enc.json`. Enter the same passphrase anywhere else
and everything comes back — books, reading progress, follows and activity.

There is no password stored anywhere, not even a hash. The passphrase derives an
AES-256 key via PBKDF2-SHA256 (600,000 iterations); if the file decrypts, the
passphrase was right. That is why publishing the file is safe, and also why
**there is no way to recover a forgotten passphrase.** Keep it in your password
manager.

To enable publishing you need a GitHub token, created **once** — not once per
machine. It is stored inside the encrypted file as well as locally, so signing in
elsewhere with the passphrase hands that device write access too.

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new)
2. Repository access: **Only select repositories** → this one
3. Permissions: **Contents → Read and write**
4. Set an expiry date
5. Paste it into Settings → Sync across machines

Reading needs no token at all — the file is public, and it is ciphertext.

Two devices that both edited between syncs are **merged**, per record, rather
than one being made to win: the newer edit to any given book wins, deletions are
honoured through tombstones, and reading history is unioned. If BookTrak cannot
read the published file it refuses to publish over it rather than guessing.

> The token can write to the repository that serves this page, so anyone who
> stole it could also commit code into the site. Scope it to this one
> repository, give it an expiry, and remove it from machines you don't control.

---

## What it does not do

- **Prices, or where to buy.** No bookseller offers a free, browser-reachable
  price API, and Amazon's requires being an affiliate with sales history.
- **Full-text search inside books.** The Internet Archive can do this, but it is
  a separate service tied to lending accounts, not the catalogue API.
- **Sync with Goodreads or StoryGraph.** Neither has a public write API; see the
  top of this file.
- **Recommendations.** Open Library has subjects but no similarity graph, so
  anything offered here would be tag overlap wearing a confident name.
- **Push notifications.** Nothing runs while the app is closed. Changes are
  detected when you open it.

---

## Your data

Everything lives in this browser's IndexedDB. That makes it fast and private,
and it also means **clearing site data erases it** — as does Safari, which
deletes local storage for sites you have not visited in seven days.

Export is one click, and unless you have turned on sync it is the only real
backup. Exports carry your library, your settings and your own genres, and never
carry your API key or contact email.

**Import replaces, it does not merge** — and neither does cloud restore.
Merging two divergent libraries is a real distributed-systems problem, and
guessing silently would lose edits nobody would notice were gone. The confirm
dialog says so, in those words, with the counts. (Ongoing *sync* between devices
already enrolled is a different thing and is merged per record; see above.)

---

## Layout

```
index.html            the app shell — every screen renders into it
sw.js                 service worker: precaches the shell, never an API response
css/01-05             tokens, base, components, per-view layout, responsive
js/00-02              config (keys, genre rules, network policy), utilities, theme
js/05                 the single network layer: rate limits, cache, budgets, retries
js/10-16              IndexedDB, the repo facade, AES-GCM crypto, GitHub sync
js/20-25              Open Library and Google Books clients
js/38-39              normalization (dates, genres, ISBNs) and the scan decision logic
js/45-49              change detection, the refresh scheduler, the router
js/50-59              shared UI, index tree, detail pane, camera overlay, editions picker
js/61-75              one file per screen, plus 70-follows (logic, no DOM)
js/90                 boot: routes, the sync gate, service worker registration
js/vendor             the ZXing wasm barcode decoder — vendored, not linked
```

**Files load in numeric order and the number *is* the dependency: nothing may
reach forwards.** There is no build step, no bundler and no import graph to
consult — the order in `index.html` is the whole architecture, so a new module's
number is a design decision.

Three deliberate irregularities, each commented where it happens:

- `js/48-sync.js` is the **refresh scheduler**, not the cloud sync its name
  suggests. Cloud sync is `15-crypto.js` and `16-cloud.js`. The name is
  inherited from MovieTrak and renaming it would break the seams that call
  `BT.sync.retier` and `BT.sync.sweep` by name.
- `js/70-follows.js` is a logic module with no DOM, loaded after the views that
  use it because they only call into it at render time.
- `js/71-view-unlock.js` is 71 and not 70 — MovieTrak's 70 slot is the unlock
  view, but BookTrak's was already taken by follows, and renumbering a shipped
  file is worse than one deliberate offset.

Two seams hold the rest of it together:

- **`BT.net` is the only caller of `fetch()`.** The exception is the GitHub
  Contents API in `js/16-cloud.js`, which is exempt because none of `BT.net`'s
  rate limiting, caching or error classification applies to our own file.
- **Views never touch `BT.db`** — they go through `BT.repo`. That single seam is
  what let encrypted sync be added without a rewrite.

CSS is layered the same way, with `05-responsive.css` last so its media queries
win against equal-specificity component rules. Classic `<script>` tags, one `BT`
global, no modules — `type="module"` is hard-blocked by CORS on `file://`, which
would break double-click-to-open.

---

## Attribution

Catalogue data and covers from [Open Library](https://openlibrary.org/), a
project of the [Internet Archive](https://archive.org/); its bibliographic data
is openly licensed and its cover images are supplied by publishers and
volunteers, used here to identify editions. [Google
Books](https://books.google.com/) is optional and user-keyed. Barcode decoding
uses the [`barcode-detector`](https://github.com/Sec-ant/barcode-detector)
ponyfill (MIT, © Sec) over
[`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) (MIT) and
[zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (Apache-2.0), both vendored
byte-for-byte in [`js/vendor/`](js/vendor/README.md) with versions, hashes and
upgrade instructions.

This is a personal, non-commercial tool and needs to stay one — Open Library is
a free service run by a non-profit that explicitly asks not to be used as a
backend for high-traffic applications, so the app rate-limits itself rather than
treating it as infrastructure it paid for.
