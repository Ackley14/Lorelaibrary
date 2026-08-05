# Architecture

> ⚠ **Superseded by [ARCHITECTURE.md](ARCHITECTURE.md).** This assumed the
> existing app's data pathways would be carried over, including the encrypted
> blob sync. **What survives:** the seam analysis immediately below — `BT.net` as
> the sole `fetch()` caller and `BT.repo` as the sole DB path are still the two
> injection points, and the Open Library bulk-dump argument is still the single
> highest-value move (now expanded in [13-WAREHOUSE](13-WAREHOUSE.md)).

## The port is smaller than it looks

BookTrak has two seams, and they happen to be the exact two a server needs.

**`BT.net` is the only caller of `fetch()`.** Every Open Library and Google Books
request in the app goes through one module that owns rate limiting, caching,
budgets, TTLs, retries and error classification. Repointing the app at our own
catalogue service is a change to `js/05-net.js` and the two adapters behind it
(`20-openlibrary.js`, `25-googlebooks.js`) — not to the twelve view files, the
inspector, the follows engine, the scanner, the editions picker or the
normalizer. The adapters can keep their exact public shape and become thin HTTP
clients against our own endpoints.

**Views never touch `BT.db`; they go through `BT.repo`.** The README already
notes this is "what let encrypted sync be added without a rewrite". It is also
what lets a *server-backed* repository be added without a rewrite. `BT.repo`
grows a sync peer; the views do not learn that a server exists.

There is a third, weaker seam worth naming: `BT.normalize` already owns "is this
the same book?" (`matchKey`, `personKey`, `pickRelease`, the precision ratchet).
That logic has to run on the **server** in the new world, and it is currently
2,229 lines of browser JavaScript with no build step. It should be extracted to a
module that runs in both places, because two implementations of `matchKey` is two
answers to "same book?", and the symptom — as `DECISIONS.md` says of the same
class of bug — is a duplicate row no call site can explain.

**Estimate, unverified:** the *catalogue* port (Phase 1 in [08](08-OPEN.md)) is
weeks, not months, and touches maybe 4 of 30 files. Everything after it is new
construction rather than porting.

## What hosting kills

The `file://` requirement is the sole justification for classic `<script>` tags
and one `BT` global — `type="module"` is hard-blocked by CORS on `file://`.
Hosting retires that constraint, which unlocks:

- ES modules and a real dependency graph, replacing "the number *is* the
  dependency" (which is elegant but is also why `71-view-unlock.js` is 71).
- A bundler, which directly fixes the measured **3.6 s first paint on a phone**:
  the cause was five stylesheets and 448 KB of script round-robining over one
  throttled H2 pipe, with `css/04-views.css` landing *last of 36 responses*. That
  is a bundling problem, and `defer`/`fetchpriority` were measured to do nothing.
- Code splitting, so the 450 KB decoder wasm and the scanner only load for people
  who scan.

**Recommendation: don't take it in Phase 1.** Keep the no-build stack while the
catalogue moves, so exactly one thing is changing at a time. Take modules in
Phase 3 when the social views are new code anyway.

---

## The stack

### The shape

```
            ┌──────────────────────────────────────────┐
  browser   │  app shell (static, CDN)                 │
            │  IndexedDB = your shelf, still the truth │
            └────────────┬─────────────────────────────┘
                         │ HTTPS, one origin
            ┌────────────┴─────────────────────────────┐
   edge     │  Cache: catalogue reads, covers, feeds   │
            └────────────┬─────────────────────────────┘
            ┌────────────┴─────────────────────────────┐
    api     │  /canon   read-only book graph  (cached) │
            │  /shelf   E2E ciphertext sync            │
            │  /social  profiles, lists, follows, feed │
            │  /radar   release calendar               │
            │  /foryou  ranked, per user               │
            └────────────┬─────────────────────────────┘
      ┌──────────────────┼──────────────────┬───────────────┐
   Postgres          object store        queue           cron
   canon+social      covers, dumps,      ingest,         monthly dump,
   +pgvector         ciphertext blobs    enrich, notify  daily radar poll
```

### Concrete choices, with the reason

**Database — Postgres 16+, managed.** Not negotiable at this data size. Canon is
tens of millions of editions; Open Library's compressed dumps alone are ~10.5 GB
of editions, 3.5 GB of works, 0.5 GB of authors. It also has to do four different
jobs that Postgres does in one engine and most alternatives make you federate:

| job | Postgres feature |
|---|---|
| catalogue search | `tsvector` + `pg_trgm` for fuzzy title/author |
| identity resolution | plain indexes over the `idIndex`-equivalent tables |
| author similarity | `pgvector` for embeddings, plain SQL for co-occurrence |
| social graph + RLS | row-level security if we go Supabase, else app-level |

Host: **Neon** (branching is genuinely useful when a dump ingest goes wrong;
scale-to-zero suits an app with no users yet) or **Supabase** (bundles auth,
storage and RLS, which is a real week saved on the multi-user half). Supabase is
the faster path to Phase 3; Neon is the cleaner path if auth ends up custom
because of the E2E requirement — and it probably does, see [03](03-DATA-MODEL.md).

**Explicitly rejected: Cloudflare D1.** It is SQLite and the practical ceiling
(10 GB/database at time of writing) is below the size of the *compressed* Open
Library editions dump. D1 is right for the social layer and wrong for Canon, and
splitting the two across engines to save money on the small half is the wrong
trade.

**API — one containerized service.** Fly.io or Render, or Cloudflare Workers with
Hyperdrive in front of Postgres for the read path. Start with a single service on
Fly: the read path is cache-dominated, the write path is tiny, and premature
splitting into edge/origin costs more in debugging than it saves in latency for
an app whose users are measured in hundreds. Language: whatever is closest to the
existing `38-normalize.js`, which means **Node/TypeScript**, so the normalizer is
literally shared code rather than a reimplementation.

**Search — Postgres first, Typesense/Meilisearch when it bites.** The existing
client-side re-ranker (`61-view-search.js`) exists because Open Library's ranking
is unusable; ours will exist because *no* generic ranker knows that a query
matching both title and author is worth more than one matching either. That logic
moves into a SQL scoring expression on day one and into a dedicated search engine
the day the SQL gets embarrassing. Do not start with Elasticsearch.

**Object storage — Cloudflare R2.** Egress-free, which matters enormously for
covers. Three buckets: `dumps/` (raw ingest), `covers/` (see the caveat below),
`shelf/` (encrypted blobs, if we keep blob-shaped sync).

**Covers are a legal question, not a storage question.** Publisher cover art is
copyrighted; Open Library serves it for identification, Google serves it over
`http://` with a server-side fake page curl baked into the pixels
(`edge=curl` — already handled in `BT.GB.cover`). Storing it permanently at scale
is a DMCA surface. **Proposal: proxy and cache with a bounded TTL, never
re-publish, attribute, honour takedowns, and keep the generated bookcloth block
as the fallback it already is.** Flagged as unresolved in [08](08-OPEN.md).

**Queue + cron — whatever the host gives you.** Three recurring jobs:
monthly dump ingest (heavy, hours), daily radar poll (moderate), and
per-user notification fan-out (light). Cloudflare Queues, Fly Machines with a
scheduler, or `pg_cron` + a worker loop all work. Don't build a scheduler.

**Static front-end — Cloudflare Pages or Netlify.** Same origin as the API via a
path prefix, or a subdomain with CORS. Prefer same-origin: the app currently
relies on relative URLs everywhere ("**Every URL in this app is relative, and
must stay that way**") and a same-origin API keeps that rule intact.

**Auth — see [03](03-DATA-MODEL.md).** It is not a stack choice, it is a design
problem, because ordinary email-and-password accounts and "there is no password
stored anywhere, not even a hash" are in direct tension.

---

## The single most important architectural decision

**Ingest Open Library's bulk dumps. Stop calling their API in the request path.**

Open Library publishes monthly dumps at
`openlibrary.org/data/ol_dump_{editions,works,authors}_latest.txt.gz`. Ingesting
them changes the project's relationship to its primary source from *supplicant*
to *mirror*, and it resolves, at a stroke, an entire column of `DECISIONS.md`:

| Constraint | After ingest |
|---|---|
| ~1 req/sec, "do not use as a high-traffic backend" | One HTTP GET per month, per file |
| `?q=…&sort=editions` returns *Robinson Crusoe* at HTTP 200 (D4) | We write the ORDER BY |
| `?author=<name>` returns the wrong writer's books (D4) | Join on the author key we hold |
| `/works/{id}/editions.json` paginates at 50; The Hobbit is 481 rows / 0.48 MB | One indexed query |
| Relevance re-ranked in the browser because the server's is unusable (D3) | Ranked once, server-side, over an index we control |
| `/isbn/{isbn}` is a 302 then possibly HTML-with-404 | A primary key lookup |
| Fields that come and go record by record | Still true — but now measurable across the whole corpus, once |

It is also the *ethical* answer to constraint 4. Open Library asks not to be used
as a backend for high-traffic applications; the dumps are how they ask you to do
this instead. A hosted BookTrak that kept proxying the live API would be doing
exactly the thing the current app rate-limits itself to avoid, at N× the volume.

**Caveats, honestly:**
- The dump is a **month stale** by construction. Live API lookups stay, as a
  *fill* path for a record the dump doesn't have — which is precisely the
  freshly-catalogued forthcoming title we care most about. So: dump for breadth,
  API for the long tail, and a write-through into our own tables so we only miss
  once.
- Ingest is a real pipeline, not a script: ~15 GB compressed, JSON-per-line with
  a TSV wrapper, into staging tables, then a merge that must not clobber
  enrichment we already hold. The precision ratchet (S2) has to run *in the
  ingest*, or the monthly dump will happily flatten every real date Google gave
  us back to a bare year — which is exactly the failure the 2026-08-03
  verification pass caught in the follows refresher.
- First ingest will take hours and will need a machine with real disk. Budget for
  one beefy ephemeral worker, not the API box.

---

## Cost

Rough, US pricing, monthly. Treat as an order-of-magnitude sketch — none of these
were quoted.

| | Prototype (0 users) | Small (~500 users) | Real (~5,000 users) |
|---|---|---|---|
| Postgres | $0–19 (Neon free/launch) | $30–70 | $100–250 |
| API compute | $0–5 (scale to zero) | $10–30 | $40–120 |
| Object storage + egress | ~$1 (R2, 15 GB) | $5–15 | $20–60 |
| Ingest worker (monthly burst) | ~$2 | ~$5 | ~$10 |
| Search engine (if separate) | $0 | $0–25 | $30–80 |
| Google Books quota | $0 (1k/day free) | $0 — see [05](05-SOURCES.md) | possibly $0 |
| ISBNdb (optional) | $0 | $15–36 | $100–300 |
| Email / push | $0 | $0–10 | $10–30 |
| **Total** | **~$25/mo** | **~$60–150/mo** | **~$200–500/mo** |

The dominant variable is **ISBNdb**, which is optional, and **whether covers are
stored or proxied**, which is legal before it is financial. Nothing here needs
Kubernetes and nothing here needs a $500 baseline.

## Migration of the existing sync

The current cloud sync commits `data/library.enc.json` to the repo via a
fine-grained GitHub token with `Contents: read and write` — and the README
already flags the risk in bold: that token can also commit *code* into the site.
That mechanism should be **retired**, not ported. Replace it with an ordinary
authenticated blob endpoint holding the same ciphertext, produced by the same
`15-crypto.js` with the same PBKDF2 parameters, so an existing user's passphrase
keeps working and the migration is "we moved where the file lives".

Keep the per-record merge, the tombstones and the history union exactly as they
are (`16-cloud.js`). That code already solved the hard half of multi-device, and
multi-device is multi-user's harder cousin, not its easier one.
