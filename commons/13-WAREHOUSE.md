# The warehouse

A multi-source ingestion and conformance platform. This is the heart of the
system — everything else is a view over it.

---

## The premise

**No book data source is complete, correct, or reliable, and none of them ever
will be.** That is not a complaint about Open Library; it is the structural
condition of the industry. The catalogue is maintained by volunteers, three
national libraries, a search engine, and roughly forty thousand publishers who
each emit ONIX on their own schedule. Every source is a partial, lagging,
opinionated projection of a reality none of them observes directly.

Concretely, from `DECISIONS.md`'s own verified table:

- Open Library does not have *In These Gilded, Ghostly Hearts*. Google does.
- Google has no record of *Other Worlds Than These* or *Isles of the Emberdark*.
  Open Library does.
- Google's top hit for `dune` is a 1990 printing — a real date about a real
  object, and the wrong date for a work.
- `first_publish_year` reports *The Alloy of Law*, published 2011, as 2001.
- 30% of *The Hobbit*'s 481 editions lack an ISBN-13; 13% have no ISBN at all.
- One lookup **by** ISBN-13 returned a record with no `isbn_13` field.
- Google answers `503 backendFailed` on 10–12 of 20 identical requests.
- Open Library's cover for *Wind and Truth* is the Spanish edition's.
- A missing cover is HTTP 200 and a 43-byte transparent GIF, so `onerror` never
  fires.

The current app copes with all of this **at read time, in the browser, per
user**, which means every reader independently rediscovers every defect, and a
bad afternoon at Open Library is a broken application.

## The rule that follows

> **No user-facing request may depend on an external API being up, correct, or
> fast.**

External sources become *feeds into a warehouse we own*, not dependencies in a
request path. A source outage becomes a **staleness metric on a dashboard**, not
a user-visible failure. A source gap becomes a **coverage metric**, not an empty
screen. That single inversion is the largest reliability and quality win
available, and it is what "keeping a localized book database of our own"
actually means in engineering terms.

---

## Three zones

Cleaning happens at the boundary between each. The zones exist so that "what the
source said", "what we understood it to mean", and "what we believe" are three
separately inspectable things — which is the only way to debug a catalogue.

```
   ┌── LANDING ────────────┐   ┌── CONFORMED ──────────┐   ┌── CANONICAL ─────────┐
   │ exactly what the      │   │ cleaned, typed,       │   │ entity-resolved,     │
   │ source returned.      │──▶│ validated — still     │──▶│ conflict-resolved,   │
   │ immutable. byte-      │   │ ONE ROW PER SOURCE.   │   │ one row per real     │
   │ faithful. append-only │   │ no merging yet.       │   │ thing. field-level   │
   │                       │   │                       │   │ provenance.          │
   └───────────────────────┘   └───────────────────────┘   └──────────────────────┘
        source_record              conformed_edition           edition / work /
        (jsonb + hash)             conformed_work              person / release
                                   conformed_person            + field_provenance
                                   + quality_report            + field_conflict
```

### Zone 1 · Landing — what they said

Immutable, content-hashed, partitioned by source and month. Never edited, never
interpreted. If a parsing bug is found two years later, the evidence is still
here and the fix is a re-projection rather than a re-fetch.

**Two media, by how the data arrived — and neither is 150 GB of JSONB.**

| | Where | Why | Size |
|---|---|---|---|
| **Bulk dumps** | Object storage, **exactly as downloaded** (`.txt.gz`) | The dump file *is* a byte-faithful archive. Exploding 85M records into rows to re-serialize what a gzip already holds is pure cost | ~15 GB/month. Keep last 3 + one per year ≈ 60 GB ≈ **$1/mo** on R2 |
| **API-fetched records** (Google volumes, PRH titles, targeted OL lookups) | **Postgres JSONB** | Incremental, per-record, arrives one at a time, and is queried per-record during enrichment. Small enough that a row store is the right answer | a few GB, growing slowly |

An earlier draft proposed exploding the dumps into per-record JSONB rows
(~150 GB) and then proposed Parquet to fix that. Both were solving a
self-inflicted problem: **do not unpack the archive to store the archive.** When
a re-projection needs the dump, it streams the gzip — which is what the ingest
already does on arrival. **DuckDB over the extracted files** stays available for
ad-hoc archaeology without any of it living in the database.

`source_record` therefore survives in Postgres as a thin **index over both
media** — `(source, kind, source_id, content_hash, location, fetched_at)`, where
`location` is either a dump path plus offset or an inline JSONB payload — so
"have we seen this record before?" remains a primary-key lookup.

Retention: forever for dumps and catalogue records (they are small and
compressible). **Subject to one exception — see the Google Books note at the
bottom of this file, which is a legal constraint rather than a technical one.**

### Zone 2 · Conformed — what we understood

**This is the layer that does the cleaning, and it is the one most systems omit.**
Each source gets its own conformed table with a *common shape* but no merging.
One Open Library edition record becomes one `conformed_edition` row; one Google
volume becomes another. They are not yet reconciled — they are just both
speaking the same language.

Why the intermediate layer earns its keep:

- **Per-source quirks stay contained.** Google's `edge=curl`, Open Library's
  `{type, value}` text fields and `-1` cover sentinel, the `302` on `/isbn/`, the
  HTML-with-HTTP-404 that makes `.json()` throw `SyntaxError` — each is handled
  in exactly one adapter and never leaks into merge logic.
- **Cleaning becomes testable in isolation.** A fixture of 200 real Open Library
  edition payloads and their expected conformed output is a regression suite that
  runs in milliseconds and encodes every verified finding permanently.
- **Merging becomes simple.** Reconciling four sources that all speak the same
  shape is tractable. Reconciling four raw APIs at once is where correctness goes
  to die — and is what `70-follows.js` currently has to do, in a browser, for two
  of them.
- **A source can be added or removed without touching the merger.**

### Zone 3 · Canonical — what we believe

Entity-resolved, conflict-resolved, one row per real-world work / edition /
person, plus **field-level provenance**. Served to users. Rebuildable at any time
from Zones 1 and 2.

---

## Source adapters

Every source implements one interface. That uniformity is what makes adding
ISBNdb or a national bibliography a day's work instead of a project.

```ts
interface SourceAdapter {
  id: SourceId                        // 'openlibrary_dump' | 'googlebooks' | …
  discover(cursor): AsyncIterable<RawRef>       // what exists / what changed
  fetch(refs): AsyncIterable<RawRecord>         // landing-zone payloads
  conform(raw): ConformResult                   // → conformed rows + issues
  health(): SourceHealth                        // latency, error rate, breaker
  policy: { rateLimit, quota, retries, backoff, cacheTtl, storable: boolean }
}
```

`ConformResult` carries **rejections as data, not exceptions**:

```ts
{ rows: ConformedRow[],
  issues: [{ field, code, severity, rawValue, note }] }
```

A record with an unparseable date is not dropped and is not thrown — it is
conformed with `release_date = NULL`, `precision = 'unknown'`, and an issue row
saying `date_unparseable: '15 julho 2019'`. Issues aggregate into the batch's
quality report and into a dashboard that shows *which sources are getting worse*.

`policy.storable` is a first-class field because it is a legal property, not a
technical one: some sources may be retained in the canonical layer and some may
only be cached briefly. The pipeline enforces it rather than relying on anyone
remembering.

---

## Cleaning: the specific transforms

These are not generic ETL hygiene. Each one exists because of something measured.

| Transform | Rule | Because |
|---|---|---|
| **Date → (date, precision)** | Parse free text into `day\|month\|quarter\|year\|tba\|unknown`. Never a bare date | `publish_date` is a bare year in 11 of 12 Hobbit editions; the exception is `'15 julho 2019'` |
| **Work-date gate** | A source describing a *printing* may sharpen a work's year, never move it forward | Google's top `dune` hit is a 1990 (and on another run 2023) reprint |
| **Computed-minimum distrust** | `first_publish_year` is advisory, never authoritative, and never overwrites an edition-level date | *The Alloy of Law*: published 2011, reported 2001 |
| **ISBN** | Validate checksum, normalize 10↔13, reject the malformed, keep many-to-many | 12 of 200 Hobbit editions share an ISBN-13 with another edition |
| **Barcode input** | Strip AIM prefixes (`]E0`/`]E4`), EAN-5 price add-ons (18 digits), UPC-A (12) | Wedge-scanner reality |
| **Language** | Normalize to BCP-47. **`NULL` means undeclared and is preserved, never defaulted** | Server-side language filters delete exactly the thin, new records a forthcoming title always is |
| **Person name** | Fold to `surname\|first-initial`; keep transliterations as aliases; drop names folding to nothing | Google's *Dune* merged into **Brian** Herbert's record; `OL893414W` credits both `Frank Herbert` and `Френк Герберт` |
| **Text fields** | `{type, value}` → string; strip HTML; fix mojibake | Rendering raw prints `[object Object]` |
| **Covers** | Reject the 43-byte transparent GIF and the `-1` sentinel; drop `edge=curl`; upgrade `http:`→`https:` | A missing cover returns HTTP 200, so `onerror` never fires |
| **Subjects** | Map LCSH strings *and* BISAC headings through one ordered, first-match-wins table | 'Fiction', 'FICTION / Fantasy / Epic', 'Roman', 'juvenile fiction' all have to land somewhere |
| **Publisher/imprint** | Canonicalize free-text publisher strings; resolve imprint separately from parent | Imprint is the taste signal; publisher is noise |
| **Sort order** | Never trust a source's ordering claim | `orderBy=newest` sorts by *when Google added the record* — observed publication years in returned order: 2023, 2020, 2024, 2018 |

Every row of that table becomes a named cleaning rule with fixtures. **This is how
`DECISIONS.md` stops being institutional memory and becomes executable.**

---

## Merging: field-level provenance and precedence

The canonical row is assembled field by field, and **each field remembers where
it came from**.

```sql
field_provenance
  entity_type, entity_id, field
  source, source_record_id, confidence
  value_hash, decided_at, rule           -- which precedence rule chose it

field_conflict
  entity_type, entity_id, field
  candidates jsonb    -- [{source, value, confidence, observed_at}, …]
  resolution text     -- 'precedence' | 'ratchet' | 'unresolved'
  first_seen, last_seen
```

### Precedence is a table, not code

```
field              precedence (highest first)                    guard
─────────────────  ──────────────────────────────────────────    ─────────────────
release_date       prh > googlebooks > ol_edition > ol_work       precision ratchet
title              ol_edition > prh > googlebooks                 —
work_title         ol_work > googlebooks                          —
isbn13             prh > ol_edition > googlebooks                 checksum valid
page_count         googlebooks > ol_edition > isbndb              > 0
description        googlebooks > ol_work > prh                    length > 40
subjects           ol_work ∪ googlebooks ∪ prh                    union, not pick
cover              prh > googlebooks > ol_edition                 real-image check
language           ol_edition > googlebooks                       null-preserving
series             hardcover > wikidata > ol_work                 —
imprint            prh > isbndb                                   —
```

Two properties worth stating explicitly:

1. **Guards beat precedence.** The precision ratchet outranks the source order:
   Google's day beats Open Library's year *and* Google's coarse backlist year
   cannot take back a real day. **Neither source is trusted by name; precision
   is.** That sentence is already in `DECISIONS.md` and it generalizes to every
   field with a natural quality ordering.
2. **Some fields union rather than choose.** Subjects and aliases are additive.
   Forcing a winner there throws away recall for no reason.

### Disagreement is recorded, not hidden

When two sources give incompatible values that precedence resolves, the loser is
still written to `field_conflict`. Three payoffs:

- **A dashboard of where sources disagree** is the highest-signal data-quality
  metric available, and it tells you what to buy. If ISBNdb would resolve 40% of
  outstanding date conflicts, that is a $15/month decision made on evidence.
- **The UI can be honest.** "Publisher says 6 Oct; the catalogue says 2026" is a
  better answer than silently picking one, and it is exactly the register this
  project already writes in.
- **Regressions are visible.** A cleaning change that suddenly doubles the
  conflict rate on one field is a bug alarm that no test would have caught.

---

## Entity resolution

Merging *records* into *things*, at forty-million-row scale.

**Blocking** — never compare all pairs. Candidate keys, in order of strength:

1. `isbn13` (exact) — the only identifier that is nearly an identity
2. `external_id` (a source id we have already resolved)
3. `match_key` — the existing `BT.normalize.matchKey` fold, indexed
4. `person_key` + normalized title, for records with no ISBN

**Scoring** — a weighted comparison across title, author set, year proximity,
page count, publisher, format. Two thresholds, not one:

- above `auto_merge` → merge, log to `merge_log`
- between → **review queue** (a human, an admin console, a keyboard shortcut)
- below → distinct

**The review queue matters more than the threshold.** Perfect automated entity
resolution is not achievable on this data; a merge queue that clears 50 items in
ten minutes is. Budget for the console.

**Merges are reversible.** `merge_log` records winner, loser, reason and the full
pre-merge state. Unmerge is a supported operation, because a bad auto-merge that
cannot be undone is permanent data loss — and the verified case where Google's
*Dune* was merged into Brian Herbert's work record is exactly this failure with a
happy ending only because it was caught in testing.

---

## Quality gates

**Every batch produces a report, and a batch that fails a gate does not promote.**
This is the control that prevents the single most dangerous operation in the
system: a monthly Open Library dump, full of bare years, flattening every real
date the enrichment layer earned.

| Gate | Trips when |
|---|---|
| Precision regression | > 0.5% of editions lose date precision |
| Volume drop | any entity count falls > 1% versus the previous run |
| Credit loss | any work loses all author credits |
| Null spike | any field's null rate moves > 3 points |
| Conflict spike | field conflict rate doubles |
| Coverage | followed-author works drop by any amount |
| Parse failure | > 2% of records in a batch produce a `severity: error` issue |

A tripped gate holds the batch in Zone 2, alerts, and presents a diff. Promotion
is then either a manual override with a recorded reason, or a fix and re-run.
Nothing promotes silently.

---

## Coverage, gaps, and misses

The user's case: *"Open Library not having this book or that book."*

**On a lookup miss, run a cascade** — cheapest and most authoritative first,
stopping at the first good answer:

```
canonical hit?  ──yes──▶ serve
      │no
      ▼
conformed hit (not yet promoted)? ──yes──▶ promote, serve
      │no
      ▼
targeted live lookup, in cost order:
   Open Library API → Google Books → PRH → Hardcover → ISBNdb (if subscribed)
      │
      ├── found ──▶ land → conform → resolve → promote → serve  (write-through:
      │                                                          we miss ONCE)
      └── not found ──▶ negative cache (TTL 7d, shorter for future-dated ISBNs)
                        + enqueue for retry + surface in the coverage dashboard
```

Three things this buys:

- **We miss a given book at most once.** The write-through means the second
  reader gets it from our own database.
- **Negative caching with a TTL** stops a nonexistent ISBN from costing five API
  calls per scan forever — but the TTL is *short* for recently-published or
  future ISBNs, because those are exactly the records that are about to appear.
- **A coverage dashboard** turns "our data is patchy" into a ranked list of what
  to fix.

**And a last resort that no aggregator can provide: the user.** If nothing has
the book — small press, self-published, foreign, a proof copy — let them create
the record: title, author, ISBN, date, cover. Held in a `user_contributed`
provenance tier that ranks below every real source, visible only to them until
verified, and promoted to shared canon once a moderator or a corroborating source
confirms it. This is the honest answer to a gap and it also closes the loop:
**contribute corrections back to Open Library.** The project has taken from that
catalogue for its whole life; a hosted version with a real user base is in a
position to give back, and it should.

---

## Outage resilience

Per-source **circuit breakers** with three states, and a policy for each:

| State | Trigger | Behaviour |
|---|---|---|
| Closed | normal | Poll on schedule |
| Half-open | error rate > threshold | Probe at reduced rate; do not promote from probes |
| Open | sustained failure | Stop polling, alert, **serve from canon**, mark affected rows stale |

Google's `503 backendFailed` at 10–12 in 20 requests is a **normal operating
condition**, not a breaker trip. The breaker thresholds have to be set from
measured baselines per source, or the noisiest source trips constantly and the
alarm gets ignored — which is the real failure.

**Staleness is tracked, exposed, and honest.** Every canonical row carries
`last_verified_at` per contributing source. When a source has been down long
enough for a class of data to go stale, the interface says so — in exactly the
register the Following page already uses, which prints the last check time on
every row. "Publisher data last checked 6 days ago" is a true statement that
costs nothing and buys trust. Silence, followed by a wrong date, does the
opposite.

**Serving never blocks on a feed.** Worst case, the catalogue is a month old and
says so.

---

## The analytical side

Serving and analysis are different workloads and should not share a query
planner's attention. But **do not buy a warehouse product for this.** At tens of
millions of rows, the answer is:

- Postgres partitions + materialized views for operational metrics
- **DuckDB** over Parquet exports in R2 for ad-hoc analysis — no infrastructure,
  reads object storage directly, and it will handle this volume on a laptop
- ClickHouse only if event volume (impressions, telemetry) genuinely outgrows
  Postgres partitions, which for this product is years away and may never happen

Snowflake, BigQuery and Databricks are the wrong shape and the wrong bill for a
dataset that fits on one SSD.

**The metrics that matter** — these are the product, expressed as numbers:

- coverage: % of shelved works with a day-precision date, a cover, a genre, ≥1
  credit, a series
- agreement: field-level conflict rate per source pair
- freshness: p50/p95 age of `last_verified_at`, per entity class
- gap rate: lookup misses per 1,000 requests, by ISBN vintage
- radar coverage: % of followed authors with any forthcoming signal, by publisher
- resolution health: auto-merge rate, review-queue depth, unmerge rate

---

## Tooling — deliberately boring

| Need | Choice | Not |
|---|---|---|
| Orchestration | **pg-boss** + a scheduler; DAG in plain TypeScript | Airflow, Dagster, Prefect — all heavier than the pipeline |
| Transformation | **SQL + typed adapters**, versioned migrations | dbt (real value at 200 models; overhead at 20) |
| Warehouse | **The serving Postgres**, + DuckDB/Parquet for analysis | Snowflake, BigQuery |
| Streaming | **Batch.** Nothing here is real-time | Kafka, Debezium |
| Data quality | **Gates in the pipeline**, with fixtures | Great Expectations, Monte Carlo |

Revisit when a specific pain is measured, not when a blog post is read. The
architecture above is deliberately conventional so that every piece can be
replaced independently; adopting Dagster later is a refactor of one module.

---

## ⚠ The constraint this architecture collides with

**Building a durable, locally-stored catalogue out of Google Books responses is
exactly the thing the Google APIs Terms of Service may prohibit** — and Google is
currently the primary source, the only source with forthcoming titles, and the
only source with real `YYYY-MM-DD` dates.

This is now the most consequential unresolved item in the entire dossier, because
the warehouse depends on retention in a way the previous design did not.
The mitigation, which should be built in from the first line of code rather than
retrofitted:

- **`policy.storable` is enforced per source, per zone.** Google-derived values
  live in the landing and conformed zones under a TTL, and contribute to
  canonical fields through provenance — which means every Google-sourced value is
  *individually identifiable and individually purgeable*.
- **Canon must survive Google's removal.** A `DELETE FROM field_provenance WHERE
  source='googlebooks'` followed by a re-projection must leave a working
  catalogue — degraded to year-precision dates and a thinner forthcoming list,
  but working. Test this. It is a one-command drill and it converts an
  existential legal risk into a quality regression.
- Read the general Google APIs ToS before writing the adapter, not after.

The same discipline applies to Hardcover and PRH, whose terms are also unread.
Designing for per-source purge is what makes the whole warehouse robust to a
terms change that nobody controls — and given the industry's history (Goodreads
retired its keys with no replacement; Amazon gated PA-API behind sales history),
assuming every current source will eventually become unavailable is the only
prudent posture.
