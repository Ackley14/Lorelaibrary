# Storage

The full data architecture: schema, tiers, caching, search, files, and the job
pipeline that keeps it true.

---

## Principles

**1 · Opaque, time-sortable primary keys.** `UUIDv7` everywhere. Never a
composite semantic string like `book:openlibrary:OL27482W` — that made the source
part of the identity, so a record that turned out to also exist in another
catalogue could never be reconciled without changing its primary key, which is
exactly why the current app needs a separate `idIndex`. Source identifiers go in
a side table where they belong. UUIDv7 rather than v4 because it is
index-local — random UUID primary keys fragment B-trees and cost real
write throughput at catalogue scale.

**2 · Raw source records are immutable; canonical rows are a projection.** Every
fetch from every source is stored verbatim, once, and never edited. The canonical
`work`/`edition`/`person` rows are *derived* from those raw records by a
projection step. This is the most valuable structural decision in the document
and it buys three things:

- **Re-derivation without re-fetching.** Change a genre rule, bump
  `taxonomy_version`, re-project 40 million rows overnight, diff the result
  before promoting it. The manual "Recalculate genres" button — a feature that
  exists purely because there was no server — is deleted from the product and
  becomes a job.
- **Auditability.** "Why does this book say 2001?" is answerable by pointing at a
  stored payload, not by re-querying an API that has since changed its mind.
- **Rebuildability.** Canon can be dropped and rebuilt from `source_record` and
  the dumps. That makes it safe to be aggressive with it.

**3 · Append-only where history is the feature.** `release_observation`,
`reading_event`, `activity`. Everywhere else, ordinary mutable rows with
`updated_at` and a `version` counter for optimistic concurrency.

**4 · Every user-owned row carries `account_id`.** No exceptions, including
join tables. It is the thing every access-control bug forgets.

**5 · Soft delete via `deleted_at`,** not tombstone tables. The tombstone store
in the current app exists because a *merge of two divergent JSON blobs* cannot
distinguish "never seen" from "deleted". Row-level writes against a server can.

---

## The schema

Abbreviated to the load-bearing columns. Postgres 16+.

### Catalogue — raw layer

```sql
source_record
  id            uuid pk
  source        text        -- openlibrary_dump | openlibrary_api | googlebooks
                            -- | prh | nyt | hardcover | wikidata
  source_kind   text        -- work | edition | author | volume | title | list
  source_id     text
  payload       jsonb
  content_hash  bytea       -- dedupe: an unchanged record on re-ingest is a no-op
  fetched_at    timestamptz
  unique (source, source_kind, source_id, content_hash)
```

Partitioned by `source`. This table is large and cold; it lives on cheap storage
and is never in a hot query path.

### Catalogue — canonical layer

```sql
work
  id                uuid pk
  title, subtitle, sort_title
  first_published   date
  first_pub_precision  precision_t   -- day|month|quarter|year|tba|unknown
  description
  subjects          text[]           -- raw, both vocabularies
  genre_ids         text[]           -- derived
  taxonomy_version  int              -- which rule table produced genre_ids
  series_id         uuid, series_position numeric
  match_key         text             -- BT.normalize.matchKey, indexed
  subject_vec       vector(1024)
  projected_at      timestamptz
  deleted_at        timestamptz

edition
  id                uuid pk
  work_id           uuid → work
  title                              -- may differ from the work's
  isbn13, isbn10, asin
  publisher_id      uuid → publisher
  imprint_id        uuid → imprint   -- separate from publisher. the taste signal
  format            format_t         -- physical | ebook | audiobook | unspecified
  page_count        int
  language          text             -- BCP-47, NULL means undeclared, NOT English
  cover_id          uuid → cover_asset
  release_date      date
  release_precision precision_t
  release_sort_key  bigint
  release_market    text             -- ISO country. NULL = unknown, not US

person
  id                uuid pk
  display_name
  person_key        text             -- surname|first-initial. indexed
  sort_name
  bio
  birth_date, death_date
  aliases           text[]           -- incl. transliterations (Френк Герберт)
  deleted_at

credit
  work_id, person_id, role, ordinal   -- author|editor|translator|contributor
  primary key (work_id, person_id, role)

series
  id uuid pk, name, match_key, source

publisher / imprint
  id uuid pk, name, normalized_name, parent_id
```

`language` being nullable with `NULL ≠ English` is not pedantry — it is the
verified finding that server-side language filters delete the thin,
newly-catalogued records a forthcoming title always is. The column, and every
query touching it, must preserve *keep the undeclared, drop only a declared
foreign language*.

### Catalogue — identity resolution

```sql
external_id
  source, source_kind, source_id     -- ('openlibrary','author','OL7481853A')
  entity_type   text                 -- work | edition | person | series
  entity_id     uuid
  confidence    text                 -- asserted | matched | verified
  first_seen, last_seen
  primary key (source, source_kind, source_id)
  -- one source id maps to exactly one entity; an entity may have many source ids

edition_isbn
  isbn13        char(13)
  edition_id    uuid → edition
  source, confidence
  primary key (isbn13, edition_id)
  -- DELIBERATELY not unique on isbn13. Verified: 12 of the first 200 Hobbit
  -- edition records carry an ISBN-13 also claimed by another edition. A unique
  -- index here is a data-loss bug waiting for a popular book.

merge_log
  winner_id, loser_id, entity_type, reason, merged_at, merged_by
  -- entity resolution is never perfect; merges must be auditable and reversible
```

### Releases — append-only

```sql
release_observation
  id            bigint identity
  edition_id    uuid → edition
  market        text
  date          date
  precision     precision_t
  source        text
  source_record_id uuid → source_record
  observed_at   timestamptz
  primary key (id)
  -- partitioned by month on observed_at

release_current                      -- materialized view
  edition_id, market, date, precision, source, decided_at
  -- the ratchet applied across sources. refreshed by the projection job.
```

Never `UPDATE` an observation. A source going quiet writes no row, so it cannot
erase what another source told us — which is the structural fix for the measured
flapping bug where a Google `503` caused a stored `2020-11-03` to be replaced by
Open Library's bare `2020` and announced as a date change.

### User data

> **Amended by [14 · Sharing](14-SHARING.md).** `shelf_item` belongs to a
> **`library`**, not directly to an account, and the personal fields below
> (`status`, `rating`, `page_position`, `notes`) move to a per-member
> `reading_progress` row — because two people sharing a library read the same
> copy at different paces. The shape below is otherwise unchanged; read
> `account_id` as `library_id + added_by`.

```sql
account
  id uuid pk, handle citext unique, display_name, avatar_id,
  bio, email citext unique, email_verified_at, locale, market,
  created_at, deleted_at, suspended_at, suspension_reason

shelf_item                            -- one row per book on a library's shelf
  id            uuid pk
  library_id    uuid → library        -- see 14-SHARING
  added_by      uuid → account
  work_id       uuid → work
  edition_id    uuid → edition        -- NULL = open scope; set = closed scope
  status        status_t              -- want|have|reading|finished|dropped
  pile          pile_t                -- NULL | sell | sold      (⊥ status)
  rating        smallint              -- 1..10
  notes         text
  page_position int
  format        format_t
  genre_override text[]
  manual_overrides text[]             -- fields the user set; refresh must not clobber
  hidden        boolean               -- excluded from profile, activity, signals
  added_at, updated_at, version int
  deleted_at
  unique (account_id, work_id, edition_id)

reading_event                         -- append-only, the reading log
  id bigint identity, account_id, shelf_item_id,
  kind text,                          -- position | status | rating | started | finished
  position int, status status_t, rating smallint,
  occurred_at timestamptz, recorded_at timestamptz, client_id uuid

author_follow (account_id, person_id, created_at, last_seen_feed_at)
social_follow (follower_id, followee_id, state, created_at)  -- following|blocked|muted
```

`edition_id IS NULL` carrying the open/closed scope distinction is the schema
expressing D3 directly: a book added by search is a *work*, a book scanned is a
*printing*. The unique constraint deliberately allows one account to hold both an
open-scope row and several closed-scope rows for the same work — which is the
"add a separate copy" branch of the scanner, and which the current app can only
express through namespace gymnastics.

### Social

```sql
list        id, account_id, title, description, visibility, share_token,
            is_ordered, forked_from_id, item_count, updated_at, deleted_at
list_item   list_id, position numeric, work_id, edition_id, note, added_at
            -- position is numeric so an insert between two items is one UPDATE
list_collab list_id, account_id, role                -- editor | suggester
review      id, account_id, work_id, edition_id, rating, body,
            contains_spoilers, visibility, created_at, edited_at, deleted_at
activity    id, actor_id, verb, object_type, object_id, visibility, created_at
            -- partitioned monthly; retention 400 days
report      id, reporter_id, target_type, target_id, reason, state, created_at
audit_log   id, actor_id, action, target, before jsonb, after jsonb, at
```

### Derived

```sql
author_similarity  a_id, b_id, score, basis jsonb, model_version, computed_at
shelf_signal       pseudonym_id, work_id, signal, observed_on
                   -- the recommender input. opt-in, rotatable, unlinkable.
foryou_cache       account_id, payload jsonb, computed_at, expires_at
```

---

## Storage tiers

| Tier | Technology | Holds | Why not elsewhere |
|---|---|---|---|
| **OLTP** | Postgres 16 primary | Everything above | One engine that does FTS, arrays, JSONB, vectors and transactions is worth more than four specialised ones at this scale |
| **Read scale** | Postgres replica | Catalogue reads, feed reads | Added when the primary's read load bites, not before |
| **Ephemeral** | Redis / Valkey | Rate-limit counters, session cache, job locks, hot fragment cache | Never the only copy of anything |
| **Blobs** | Cloudflare R2 | Covers, avatars, exports, raw dumps | Egress-free is decisive for image serving |
| **Search** | Postgres `tsvector` + `pg_trgm` → Typesense | Title/author/series search | Start in Postgres; graduate when ranking SQL gets embarrassing |
| **Vector** | `pgvector` (HNSW) | Work and author embeddings | A separate vector DB is unjustifiable for tens of millions of rows |
| **Events** | Postgres partitions → ClickHouse *if* | Activity, impressions, telemetry | Only move when partition maintenance becomes the problem |

**Explicitly rejected:** a separate document store for catalogue records (JSONB
does it), a graph database for similarity (a materialized edge table with a
`basis` column does it, and answers *why* which a graph DB does not), and any
serverless-proprietary datastore in the core path.

---

## Caching

Four layers, each with a clear invalidation story. Cache without an invalidation
story is a bug with a latency improvement.

1. **CDN edge** — catalogue `GET`s only. `Cache-Control: public, max-age=300,
   stale-while-revalidate=86400`, strong `ETag` from the row's `projected_at`.
   Purged by tag when a projection job promotes new rows. **Never** for anything
   account-scoped: a single `Vary` mistake serves one user's shelf to another,
   and the mitigation is to make the mistake impossible by routing
   authenticated requests through a path the CDN is configured never to cache.
2. **Redis** — computed artefacts: For You payloads (1 h), feed pages (60 s),
   counts (5 min). Keyed with the model/taxonomy version so a recompute
   invalidates by construction rather than by remembering to flush.
3. **Postgres materialized views** — `release_current`, stats aggregates,
   similarity. Refreshed by the job scheduler, concurrently.
4. **Client** — HTTP cache for catalogue, IndexedDB as cache + outbox for the
   user's own library. See [14 · Sharing](14-SHARING.md) and
   [ARCHITECTURE §9](ARCHITECTURE.md).

---

## Files

**Covers.** Ingest into R2 rather than hotlinking, but with the caveats from
[08](08-OPEN.md) intact — this is a legal question before it is an engineering
one. The pipeline: fetch → **verify it is a real image** (Open Library returns
HTTP 200 and a 43-byte transparent GIF for a miss; Google can serve a grey
placeholder at 200) → strip the `edge=curl` fake page curl by requesting without
it → normalize to 3 sizes → content-address (`sha256`) so identical covers across
editions store once → serve via CDN. Fall back to the generated bookcloth block,
which already exists and is better than a broken tile.

**Avatars.** User uploads: size cap, re-encode server-side (never trust the
uploaded bytes), strip EXIF including GPS, scan for known-bad hashes if volume
ever justifies it.

**Exports.** Written to R2, signed URL, 7-day expiry, deleted after.

**Dumps.** Raw Open Library gzip archived per month in R2, so an ingest can be
replayed against a fixed input when debugging a projection change.

---

## The pipeline

Five job classes, all on **pg-boss** (Postgres-backed queues — one less system to
run, transactional enqueue with the write that triggers it, and it comfortably
handles this volume). Graduate to Redis/BullMQ only if throughput demands it.

### 1 · Ingest — monthly

```
download dump (R2) → stream-parse JSONL → source_record (content-hash dedupe)
  → stage → resolve identities → project → diff vs canonical → promote
```

Runs on an ephemeral large machine, not the API box. ~15 GB compressed; hours,
not minutes. Streams — never loads a dump into memory. Idempotent: the content
hash makes an unchanged record a no-op, so a failed run resumes rather than
restarts.

**The projection must apply the precision ratchet.** A monthly dump full of bare
years will otherwise flatten every real date the enrichment layer earned. This is
the single most likely way the ingest silently destroys value, and it deserves a
test that fails loudly.

### 2 · Enrichment — continuous, tiered by volatility

The current app's refresh scheduler policy, moved server-side and now paid **once
per author across the whole population** rather than once per author per browser:

| Tier | Cadence |
|---|---|
| Dated within 60 days | daily |
| Dated 60 days–18 months | weekly |
| `tba` / year-only, future | weekly |
| Followed author, nothing forthcoming | weekly |
| Backlist | monthly, with the dump |

Per-source circuit breakers and backoff. Google `503 backendFailed` at 10–12 in
20 requests is a *normal operating condition*, not an incident, and the scheduler
must treat it that way.

### 3 · Derivation — on demand and on version bump

Genre projection (`taxonomy_version`), similarity (`model_version`), embeddings
(backfill + monthly delta). Every derived artefact carries the version that
produced it, so a rule change can be computed into a shadow column, diffed
against the live one, reviewed, then promoted. **The current app's
"Recalculate genres" flow already implements exactly this — show what will
change, offer undo. Keep the idea, move it to an admin console.**

### 4 · Fan-out — event-driven

Notifications, digests, feed invalidation. Triggered by observations, never by a
timer against a user. "Book moved", "out today", "author announced" are events.
"You haven't opened the app" is not.

### 5 · Maintenance

Partition creation and drop, `VACUUM`/`ANALYZE` supervision, index bloat checks,
expired session and export purge, hard-delete of accounts past their grace
window.

---

## Backup and recovery

- **PITR** from the managed host (Neon and Supabase both provide it). Retention
  35 days; state that number in the privacy policy so deletion promises are
  honest.
- **Nightly logical dump to R2**, which is a *different provider* from the
  database. A backup inside the failure domain it protects against is not a
  backup.
- **Canon is rebuildable** from `source_record` and the archived dumps, so
  backup priority is user data. Splitting the restore path this way makes the
  user-data RPO/RTO achievable rather than aspirational.
- **A restore is tested quarterly, into a scratch environment, timed.** Untested
  backups are a belief, not a control. Target: RPO ≤ 5 min, RTO ≤ 2 h.
