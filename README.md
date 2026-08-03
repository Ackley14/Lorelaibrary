# BookTrak

A library for the books you want to read, are reading, have finished, or gave
up on. One shelf, real publication dates, honest edition handling, and a
barcode scanner for the pile on the floor. No accounts, no server, no build
step — it is plain HTML that runs either from a web address or by
double-clicking `index.html`.

**Live:** https://ackley14.github.io/Lorelaibrary/

---

## Read this first: it does not search Goodreads

Goodreads has no usable API any more. Amazon stopped issuing developer keys at
the end of 2020 and retired the existing ones; there is no public replacement,
and Amazon's own Product Advertising API is gated behind an affiliate account
that has to make sales before it will answer. StoryGraph has never published
one. Scraping either from a browser dies on CORS regardless.

So **search is powered by [Open Library](https://openlibrary.org/)**, run by the
Internet Archive: openly licensed bibliographic data, covers included, and — the
part that decides it — **no key and no signup at all**. Clone this repo, open
the file, start typing. Nothing to register for.

The trade you are making is metadata quality. Open Library is
volunteer-contributed, so a popular novel may carry forty editions of wildly
uneven completeness while a 2019 midlist paperback has a title and nothing else.
BookTrak is built around that rather than pretending otherwise: a book added by
search is **open scope** — the work, edition unspecified — and only a book you
physically scanned is **closed scope**, pinned to the one edition in your hands.

---

## Setup

There isn't any. That is the point of the source choice.

| Source | Used for | Key | Free tier |
|---|---|---|---|
| **Open Library** | everything: search, works, editions, authors, covers | **none** | keyless, be polite |
| Google Books | fills in blurbs, page counts and ratings where Open Library is thin | **yours only** | 1,000 per day |

Google Books is optional and stays off unless you paste a key into Settings.
There is no anonymous fallback to fall back to: an unauthenticated volumes
request now answers `429` with `"quota_limit_value":"0"` — a quota of zero, not
a quota we exceeded. `BT.BAKED_KEYS` in
[`js/00-config.js`](js/00-config.js) is therefore deliberately empty, and the
app is expected to run its entire life with that source switched off.

Open Library asks API consumers to identify themselves so they can contact you
before they block you. Settings has a contact email field for that; it is
optional, and it never leaves this browser except on the requests it is
attached to. The network layer throttles itself either way.

## Running it

**Locally** — double-click `index.html`. That's it; there is nothing to install
or compile.

> **Except the scanner.** `getUserMedia` only runs in a *secure context*, and
> `file://` is not one — over a double-clicked file there is no camera to open,
> so the scanner offers typing the ISBN instead. To scan locally, serve the
> folder: `python -m http.server 8080`, then open `http://localhost:8080`.
> `localhost` counts as secure; a LAN IP does not, so a phone on the same
> Wi-Fi needs real HTTPS.

**On GitHub Pages** — push to `main`, then **Settings → Pages → Source: Deploy
from a branch → `main` / `(root)`**. It is live at
`ackley14.github.io/Lorelaibrary` a minute later, over HTTPS, camera included,
and every subsequent push redeploys.

> `file://` and your published site are separate browser origins, so they keep
> **separate libraries**. Move between them with the passphrase sync below, or
> with Export/Import.

> **BookTrak and MovieTrak share one origin.** They deploy to
> `ackley14.github.io/Lorelaibrary` and `ackley14.github.io/entertainmentwatch`,
> and localStorage and IndexedDB are scoped to the origin, not the path. Every
> key in this app is prefixed `bt.` and the database is named `booktrak`; the
> sibling uses `mt.` and `movietrak`. A stray prefix does not fail loudly, it
> reaches into the other app's data. Treat it as load-bearing.

---

## Sync across machines

Your library is encrypted **in the browser** and committed to this repository as
`data/library.enc.json`. Enter the same passphrase anywhere else and everything
comes back.

There is no password stored anywhere — not even a hash. The passphrase derives
an AES-256 key via PBKDF2 (600,000 iterations); if the file decrypts, the
passphrase was right. That is why publishing the file is safe, and also why
**there is no way to recover a forgotten passphrase.** Keep it in your password
manager.

To enable publishing you need a GitHub token, created once per machine:

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new)
2. Repository access: **Only select repositories** → this one
3. Permissions: **Contents → Read and write**
4. Set an expiry date
5. Paste it into Settings → Sync

Reading needs no token at all — the file is public, and it is ciphertext.

> The token can write to the repository that serves this page, so anyone who
> stole it could also commit code into the site. Scope it to this one
> repository, give it an expiry, and remove it from machines you don't control.

---

## What it does

- **Search** by title, author or ISBN in one box. Press `/` from anywhere,
  type, press `Enter` to add the top hit.
- **Scan the back cover.** Point the camera at an ISBN-13 barcode and the book
  lands in the library as a specific edition — that printing, that cover, that
  page count. This is the only way a book becomes *closed scope*, and it is
  what makes a shelf audit possible.
- **Four reading statuses** — *want*, *reading*, *finished*, *dropped* — kept
  strictly separate from **whether you still own the thing**. A book can be
  finished and marked *to sell*, or unread and already sold on. Collapsing
  those two axes into one list is the mistake every other tracker makes.
- **Publication dates with honest precision.** A book known only to "2027" is
  never shown as January 1st. `Jul 16, 2027` / `July 2027` / `2027` / `TBA` all
  look different and are grouped differently, and a date that moves is recorded
  as having moved rather than silently overwritten.
- **Formats** — physical, ebook, audiobook — because "read" and "listened to"
  are the same status and genuinely different objects.
- **Six genre buckets**, deliberately coarse. Open Library subjects are a
  free-for-all of thousands of overlapping strings; anything finer than
  fiction / non-fiction / fantasy & SF / mystery / romance / general would be
  precision the source data does not actually have.
- **Stats** that double as a readable view of what you actually read, as
  opposed to what you tell people you read.

## What it does not do

- **Prices, or where to buy.** No bookseller offers a free, browser-reachable
  price API, and Amazon's requires being an affiliate with sales history.
- **Full-text search inside books.** The Internet Archive can do this, but it
  is a separate service tied to lending accounts, not the catalogue API.
- **Sync with Goodreads or StoryGraph.** Neither has a public write API; see
  the top of this file.
- **Recommendations worth the name — yet.** Open Library has subjects, not a
  similarity graph, so any suggestion here is tag overlap and will be honest
  about saying so.
- **Push notifications.** Nothing here runs while the app is closed. Changes
  are detected when you open it.

---

## Your data

Everything lives in this browser's IndexedDB. That makes it fast and private,
and it also means **clearing site data erases it** — as does Safari, which
deletes local storage for sites you have not visited in seven days.

Export is one click and is the only real backup. The app nags after a week.

## Layout

```
index.html          the whole app shell
css/01-05           tokens, base, components, per-view layout, responsive
js/00-05            config, date/text utilities, the single network layer
js/10-16            IndexedDB, the repository facade, encryption, GitHub sync
js/20-38            Open Library / Google Books clients, and normalization
js/40-48            recommender, change detection, refresh scheduling
js/49-70            router, shared components, the scanner, one file per screen
```

Files load in numeric order and the number *is* the dependency: nothing may
reach forwards. `BT.net` is the only thing that calls `fetch()`, and views
never touch `BT.db` directly — they go through `BT.repo`. CSS is layered the
same way, with `05-responsive.css` last so its media queries win against
equal-specificity component rules.

Classic `<script>` tags, one `BT` global, no modules — modules are blocked on
`file://`, which would break double-click-to-open.

## Attribution

Catalogue data and covers from [Open Library](https://openlibrary.org/), a
project of the [Internet Archive](https://archive.org/); its bibliographic data
is openly licensed and its cover images are supplied by publishers and
volunteers, used here to identify editions. [Google
Books](https://books.google.com/) is optional and user-keyed.

This is a personal, non-commercial tool and needs to stay one — and Open
Library is a free service run by a non-profit, so the app rate-limits itself
rather than treating it as infrastructure it paid for.
