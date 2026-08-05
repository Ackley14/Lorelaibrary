# Re-architecture

> **This document supersedes 01–08 wherever they conflict.** Those were written
> on the premise of *porting* BookTrak's architecture to a server. That premise
> was wrong: BookTrak's architecture is a set of brilliant answers to
> **"how do I run a database with no server and a public repository as the only
> storage I can write to?"** — a question that stops existing the moment there is
> a server. Documents 04 (social), 05 (sources), 06 (radar) and 07 (For You)
> survive largely intact, because they are about books rather than about hosting.

---

## The separation that matters

Everything in the current app is one of two things, and telling them apart is the
whole job.

### Constraint artifacts — delete them

| What | Why it exists | What replaces it |
|---|---|---|
| **AES-GCM + PBKDF2 600k passphrase encryption** | The sync target is a **public repo**. Ciphertext was the only safe thing to put there | A private database behind authentication. Encryption at rest is the host's job |
| **A GitHub token stored inside the library** | The only write API available | Nothing. It disappears |
| **Whole-library blob sync + per-record merge + tombstones** | The transport was "commit a JSON file" | Row-level writes over HTTP. Tombstones survive only as an offline-sync detail, not as a storage design |
| **IndexedDB as the source of truth** | There was nowhere else | Postgres is the truth. IndexedDB is a cache + outbox |
| **`BT.BAKED_KEYS` empty; user-supplied Google key** | A public repo cannot hide a key | One server-side key in a secret manager |
| **Client-side rate limiting, budgets, TTL cache (`05-net.js`)** | Every browser was its own uncoordinated API client | One server-side scheduler, one quota, one cache |
| **Client-side search re-ranking** | Open Library's ranking is unusable and we couldn't index anything | Our own index, ranked in SQL |
| **Genre derived at add-time + a manual "Recalculate genres" button** | No server to re-run rules over the corpus | A versioned taxonomy and a background re-projection job. **The button is deleted from the product** |
| **Snapshot-diffing on app open to detect change** | "A static page has no memory between visits" | Continuous server-side polling; the client is *told* |
| **Four ISBN namespaces + first-writer-wins arbitration** | A single-user keyspace had to encode ownership in the key | Catalogue mapping and user ownership become two different tables. See below |
| **`uid = book:<source>:<id>`, immutable** | No id-allocation authority existed | Opaque UUIDv7, allocated by the database, with source ids in a side table |
| **No ES modules, no build step, numeric file ordering** | `file://` must work | Vite + TypeScript |
| **Relative URLs everywhere, `bt.` prefix on every key** | Subpath deploy on an origin shared with MovieTrak | Own the domain |
| **The `file://` double-click mode itself** | It was a feature of having no server | Gone. A PWA install replaces it |

### Domain knowledge — keep every word

None of this is about hosting. All of it was *found*, by measurement, and it is
the actual asset:

- **A work and an edition are different objects**, and scope (open/closed) is
  explicit.
- **Publication dates carry precision** (`day|month|quarter|year|tba|unknown`),
  and **precision is a ratchet in both directions** — a coarser answer never
  overwrites a finer one, and "us knowing less" is never reported as news.
- **Never a confident answer the source cannot support.** "Newly listed in this
  catalogue", not "new release". Containment, not overlap.
- **Reading status ⊥ ownership.** The sell pile is its own axis.
- **Progress promotes, never finishes.**
- **Genre is a curated, ordered, first-match-wins bucket table** over noisy
  subjects from two different vocabularies. Order is load-bearing.
- **Author identity is an ID, never a name** — `?author=gwendolyn+kiste` returns
  Laird Barron's books at HTTP 200.
- **`matchKey` and `personKey`** (`surname|first-initial`) — the exact folds, and
  the two failures that produced them.
- **Language filtering keeps the undeclared and drops only a declared foreign
  language**, because server-side filtering deletes exactly the thin,
  newly-catalogued records a forthcoming title always is.
- **A missing Open Library cover is HTTP 200 and a 43-byte transparent GIF**;
  Google serves `http://` with a fake page curl burned into the pixels.
- Every row of the `Verified live` tables in `DECISIONS.md`.

**That table of verified findings is worth more than the code.** The code is a
delivery mechanism for it. Rebuilding the delivery mechanism is fine; losing the
findings is not, and it is the single most likely way this goes wrong.

---

## The one worked example

The four ISBN namespaces are the clearest case of a constraint producing a design
that is *correct* under the constraint and *wrong* without it, so it's worth
walking through — the same reasoning applies to half the table above.

**Today.** One user, one keyspace, keys must encode meaning:

```
olwork:OL27482W       → item        search-add dedup
oledition:OL…M        → item
isbn13:9780441172719  → item        written ONLY by scope:'closed'  ("I own this printing")
isbncand:978…         → item        written ONLY by scope:'open'    ("might be this printing")
```

…plus an arbitration rule: a pinned row is taken from another item only by the
item whose *own* barcode it is; two genuine claims resolve first-writer-wins;
candidates are last-writer-wins. That rule exists because **12 of the first 200
Hobbit editions have an ISBN-13 claimed by more than one edition record**, and
without it scan-add stole rows and remove-by-scan deleted the wrong book.

**Why it had to be that way:** with one flat key→item map and no server, the key
*is* the ownership claim. "Does this user own this ISBN?" and "which edition is
this ISBN?" are the same lookup, so they had to be different namespaces.

**With a server they are simply two different tables:**

```sql
-- catalogue fact. many-to-many, because the real world is.
edition_isbn (isbn13, edition_id, source, confidence)

-- ownership. a per-user row.
user_copy (account_id, edition_id, scope, acquired_via, acquired_at)
```

The scanner's question becomes one join: *does this account have a `user_copy`
for any edition carrying this ISBN?* Ownership is expressed by a row existing,
not by which namespace a key landed in. **The arbitration rule disappears
entirely** — and the reason it disappears is illuminating: it existed to resolve
"two items claim this ISBN", which was only unresolvable because a single-user
keyspace had no way to say *two different people own the same printing*. That is
not a hard problem in a relational database. It is the default.

The 12-duplicate-ISBNs finding stays true and stays important — it is why
`edition_isbn` is many-to-many rather than a unique index, and it should be a
comment on the migration that creates the table.

---

## The target system, in one picture

```
                            ┌─────────────────────┐
                            │  Cloudflare         │  DNS · CDN · WAF · R2
                            │  (edge, cache, TLS)  │
                            └──────────┬──────────┘
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
        ┌───────────────┐      ┌───────────────┐      ┌───────────────┐
        │  web          │      │  api          │      │  media        │
        │  static SPA   │      │  Node/TS      │      │  covers via   │
        │  Vite build   │      │  REST + SSE   │      │  R2 + Images  │
        └───────────────┘      └───────┬───────┘      └───────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                  ▼           ▼            ▼                 ▼
  ┌──────────┐      ┌──────────┐  ┌────────┐  ┌──────────┐    ┌────────────┐
  │ Postgres │      │  Redis   │  │ search │  │  worker  │    │   ingest   │
  │ + pgvector│     │ cache,   │  │ Typesns│  │ pg-boss  │    │  ephemeral │
  │ primary   │     │ ratelimit│  │ (later)│  │ consumers│    │  big box   │
  │ + replica │      └──────────┘  └────────┘  └──────────┘    └────────────┘
  └──────────┘
       ▲                                                             │
       └──────────────────── monthly OL dump, API pollers ───────────┘
```

Five deployable units — `web`, `api`, `worker`, `cron`, `ingest` — over managed
Postgres, Redis and object storage. Nothing exotic, and deliberately nothing
provider-proprietary in the core path, so the whole thing is portable to a
€40/month Hetzner box the day the managed bill stops being worth it.

---

## Where the detail lives

| | |
|---|---|
| **[ARCHITECTURE](ARCHITECTURE.md)** | **The consolidated top-to-bottom summary** — languages, hosting, auth, networking, UAC, storage, jobs, ops, security, cost |
| **[11 · Identity](11-IDENTITY.md)** | OAuth/OIDC, sessions, passkeys, authorization, account lifecycle, deletion |
| **[12 · Storage](12-STORAGE.md)** | The full schema, caching tiers, search, vector, blobs |
| **[13 · Warehouse](13-WAREHOUSE.md)** | Multi-source ingestion, cleaning, conformance, provenance, outage resilience |
| **[14 · Sharing](14-SHARING.md)** | Libraries as entities, members and roles, concurrent sessions, the sync protocol |

Documents [04 · Social](04-SOCIAL.md), [05 · Sources](05-SOURCES.md),
[06 · Radar](06-RADAR.md) and [07 · For You](07-FORYOU.md) stand as written.
