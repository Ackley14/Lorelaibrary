# The split — what is product, and what is scaffolding

> *"all that i care about for this project in its present state is the front end,
> all backend componentry can be rebuilt from the ground up and should be"*

That is the right call, and it is worth making concrete, because roughly **half
of BookTrak is a database and an API client written in a browser** — not because
that was a good place for them, but because there was nowhere else to put them.
That half deletes.

---

## The accounting

27,908 lines across 30 files. Split by what happens to each.

### Deletes or moves server-side — ~13,700 lines

| File | Lines | Fate |
|---|---:|---|
| `05-net.js` | 658 | **Dies.** Rate limits, budgets, TTL cache, retry policy, error classification — all of it exists because every browser was its own uncoordinated API client. Replaced by `fetch('/v1/…')` |
| `10-db.js` | 285 | **Dies.** IndexedDB driver with the four sharp edges (booleans aren't keys, multiEntry constraints, sparse-index tricks, transaction auto-commit). Replaced by Postgres |
| `12-repo.js` | 681 | **Shrinks to ~150.** Becomes a typed API client + local cache, not a repository |
| `15-crypto.js` | 248 | **Dies entirely.** PBKDF2, AES-GCM, key wrapping — all of it existed to make a public git repo a safe sync target |
| `16-cloud.js` | 994 | **Dies entirely.** GitHub Contents API, per-record merge, tombstone reconciliation, conflict resolution over a JSON blob |
| `71-view-unlock.js` | 717 | **Dies entirely.** The passphrase gate has nothing to gate |
| `20-openlibrary.js` | 1,095 | **Moves server-side**, rebuilt as a source adapter |
| `25-googlebooks.js` | 998 | **Moves server-side**, same |
| `38-normalize.js` | 2,229 | **Moves server-side**, rebuilt properly — see below |
| `45-alerts.js` | 765 | **Moves server-side.** Change detection is a job, not a page-load diff |
| `48-sync.js` | 355 | **Moves server-side.** The refresh scheduler becomes a cron tier table |
| `70-follows.js` | 2,031 | **Moves server-side.** Two-catalogue union, credit checks, date sharpening, containment tests — all of it is warehouse work |
| `39-scan.js` | 912 | **Splits.** Barcode parsing stays client-side; the four-way scan decision becomes a server call |
| `00-config.js` | 1,770 | **Splits.** Genre rules, network policy and source config move server-side; theme tokens and UI constants stay |

### Survives — the product — ~14,200 lines

| File | Lines | What it is |
|---|---:|---|
| `50-ui-core.js` | 1,212 | Shared UI primitives |
| `56-inspector.js` | 1,398 | The detail pane |
| `69-view-settings.js` | 1,789 | Settings (minus sync, keys, unlock) |
| `67-view-people.js` | 1,435 | The Following page |
| `61-view-search.js` | 1,235 | Search UI (minus the re-ranker, which the server now owns) |
| `75-view-scan.js` | 981 | The scan screen |
| `90-boot.js` | 944 | Boot, routes, service worker |
| `58-scanner.js` | 902 | Camera overlay, the vendored decoder |
| `59-editions.js` | 817 | The editions picker |
| `68-view-stats.js` | 817 | Stats |
| `01-util.js` | 788 | Utilities |
| `62-view-list.js` | 763 | The shelf |
| `55-tree.js` | 534 | The index tree |
| `66-view-alerts.js` | 285 | Activity |
| `49-router.js` | 207 | Router |
| `02-theme.js` | 63 | Vellum / Marginalia |
| `css/01–05` | — | **All of it.** 171 KB of tokens, components, view layout and responsive rules |

**≈ 50/50.** And the surviving half is the half you actually designed — the tree,
the inspector, the two themes, the scanner overlay, the editions picker, the
stats panels, the keyboard model.

---

## What this changes about the plan

### 1 · The normalizer is rebuilt, not shared

I previously argued for extracting `38-normalize.js` as a module both sides
consume, and gave "two implementations of `matchKey` is two answers to *same
book?*" as the reason. **With the backend rebuilt from scratch, the better answer
is one implementation, server-side, and none on the client.**

The client stops needing to know how to fold a title, parse `'15 julho 2019'`,
distinguish `isbn13:` from `isbncand:`, or decide which of two catalogues is
lying. It asks the API and renders the answer. That is a strictly cleaner seam
than a shared module, and it deletes 2,229 lines from the browser rather than
porting them.

**What carries over is the test suite, not the code.** Every verified finding in
`DECISIONS.md` becomes a fixture in the server's conformance tests:

```
given  Open Library edition OL…M with publish_date '15 julho 2019'
expect release_date 2019-07-15, precision 'day'

given  Google volume for 'dune', publishedDate '1990-09-01', work-scoped query
expect the work's year is NOT moved forward to 1990

given  a work credited to both 'Frank Herbert' and 'Френк Герберт'
expect one person, one alias

given  a cover response of 43 bytes, content-type image/gif
expect rejected, no cover_id written
```

That is the asset. It transfers as specification, and specification survives a
rewrite in a way code does not.

### 2 · The language choice loosens

TypeScript on Node was recommended partly so the normalizer could be shared
verbatim. That reason is now gone, so pick the backend language on its own
merits:

| | For | Against |
|---|---|---|
| **TypeScript / Node** | Same language as the client, one toolchain, best-in-class Postgres and S3 libraries, huge hiring/AI-assistance surface | Weakest of the three at CPU-bound ingest |
| **Go** | Excellent for the ingest and the pollers (streaming, concurrency, tiny memory), single static binary, trivial deploys | Second language to maintain; more verbose data-shaping code |
| **Rust** | Fastest ingest by a wide margin | Slowest to write; the bottleneck here is data quality, not CPU |

**Still TypeScript**, but now for ordinary reasons: one language across the whole
project, the fastest path from idea to running code, and an ingest that is IO-
and Postgres-bound rather than CPU-bound. Reach for Go later *for the ingest
worker only* if a profile says so — it is an isolated component behind a queue,
so swapping it is a contained change rather than a rewrite.

### 3 · The client rebuild gets much smaller

With the server owning catalogue, normalization, follows, alerts, scheduling and
scan decisions, the front end becomes what it should have been: **views, a
router, a cache, and an outbox.**

- **Keep the vanilla DOM code and the CSS.** It works, it is yours, and it is the
  part with taste in it.
- **Add Vite + TypeScript** for bundling and types — this alone fixes the
  measured 3.6 s first paint (five stylesheets and 448 KB of scripts
  round-robining a throttled H2 pipe).
- **Replace the data layer wholesale**: `BT.repo` becomes a typed API client;
  IndexedDB becomes a cache plus the mutation outbox from
  [14-SHARING](14-SHARING.md); SSE delivers everyone else's writes.
- **Delete** `05-net`, `10-db`, `15-crypto`, `16-cloud`, `71-view-unlock`
  outright.
- No framework migration. A React rewrite would spend months reproducing
  `56-inspector.js` and `55-tree.js` and arrive somewhere no better.

### 4 · The build order changes

Phase 0 was *"extract the normalizer into a shared module"*. **That phase is now
deleted** — there is nothing to extract, because the server writes its own.
Phase 1 becomes the first phase, and it is a greenfield backend against an
unchanged front end.

---

## The one thing that must not be lost

The code is disposable. `DECISIONS.md` is not.

Every finding in it was *measured* — `?q=dune&sort=editions` answering HTTP 200
with *Robinson Crusoe*, `inauthor:"Stephen King"` returning zero, 12 of 200
Hobbit editions sharing an ISBN-13, `orderBy=newest` sorting by insertion date,
Google serving a fake page curl in the pixels, a missing cover returning a
43-byte GIF at HTTP 200. **None of it is rediscoverable from reading a rewrite.**
It is rediscoverable only by spending the same days again.

So the rule for the rebuild: **before writing a source adapter, read that
source's rows in `DECISIONS.md` and write them as failing tests first.** The
backend can be rebuilt from the ground up precisely because the hard-won
knowledge is written down somewhere that is not the code.
