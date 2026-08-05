# Architecture — top to bottom

The consolidated systems summary. Everything in one place: languages, hosting,
auth, networking, access control, storage, jobs, ops, security, cost. Deep dives
are linked per section.

**Status:** proposal. Nothing here is built. Numbers are estimates unless marked
verified.

---

## 1 · The system in one diagram

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ CLIENT           PWA · TypeScript · Vite · vanilla-first, incremental       │
 │                  IndexedDB = cache + outbox   ·   SSE for live updates      │
 └────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTPS/2 · same-origin · cookie session
 ┌────────────────────────────────┴───────────────────────────────────────────┐
 │ EDGE             Cloudflare · DNS · TLS · CDN · WAF · Turnstile · R2        │
 │                  caches /v1/canon/* only. never an authenticated response   │
 └────────────────────────────────┬───────────────────────────────────────────┘
 ┌────────────────────────────────┴───────────────────────────────────────────┐
 │ API              Node 22 · TypeScript · Fastify · REST + SSE                │
 │                  authn (Better Auth) · authz seam · rate limit · OpenAPI    │
 └───┬─────────────────┬──────────────────┬──────────────────┬────────────────┘
     │                 │                  │                  │
 ┌───┴──────┐   ┌──────┴─────┐   ┌────────┴───────┐   ┌──────┴──────────┐
 │ POSTGRES │   │  REDIS     │   │  WORKER        │   │  INGEST         │
 │ 16 +     │   │  cache     │   │  pg-boss       │   │  ephemeral      │
 │ pgvector │   │  ratelimit │   │  enrich·derive │   │  monthly dump   │
 │ +replica │   │  presence  │   │  fanout·notify │   │  big box, hours │
 └──────────┘   └────────────┘   └────────────────┘   └─────────────────┘
       ▲                                                        │
       └──────── warehouse: land → conform → canonical ─────────┘
                 Open Library · Google · PRH · NYT · Wikidata · Hardcover
```

Five deployable units — `web`, `api`, `worker`, `cron`, `ingest`. Nothing
provider-proprietary in the core path.

---

## 2 · Languages and runtimes

| Layer | Choice | Why |
|---|---|---|
| **API, workers, ingest** | **TypeScript on Node 22 LTS** | One language across the project; the fastest path from idea to running code; an ingest that is IO- and Postgres-bound rather than CPU-bound. **Not** for code sharing with the client — the backend is rebuilt from scratch and the client stops normalizing anything ([17-SPLIT](17-SPLIT.md)). Swap the ingest worker for Go later if a profile demands it; it sits behind a queue and is contained |
| **Client** | **TypeScript**, vanilla DOM first | See §9. Types belong on the data layer, where correctness lives |
| **Schema / migrations** | **SQL**, plus a migration tool | Hand-written SQL beats an ORM's DDL for a catalogue with partitions, generated columns and vector indexes |
| **Query layer** | **Drizzle** (or Kysely) | Typed SQL builder, not an ORM. Full control of the query; no lazy-loading N+1 |
| **Ingest hot loop** | TypeScript; **Rust or Go only if measured** | 15 GB of JSONL streams fine in Node. Do not pre-optimize a monthly job |
| **Analysis** | **SQL + DuckDB** over Parquet | Zero infrastructure |

**Rejected:** Python for the API (splits the language, orphans the normalizer),
Deno/Bun (fine, but ecosystem risk for no gain), a Rust rewrite (the bottleneck
is data quality, not CPU).

---

## 3 · Hosting

### Recommendation

| Component | Provider | Cost signal |
|---|---|---|
| DNS, CDN, WAF, R2, Turnstile | **Cloudflare** | ~$0–25/mo |
| `web` static | **Cloudflare Pages** | $0 |
| `api`, `worker`, `cron` | **Render** (or Fly.io) | $7–85/mo |
| `ingest` | **Fly Machines**, ephemeral | ~$3/mo amortized |
| Postgres | **Neon** (branching, scale-to-zero) | $0–250/mo |
| Redis | **Upstash** or Render Redis | $0–30/mo |
| Email | **Resend** or Postmark | $0–20/mo |
| Errors | **Sentry** | $0–29/mo |
| Logs/metrics | **Better Stack** or Grafana Cloud | $0–30/mo |

### Why this shape

**Render over Fly** for the default: managed containers, managed Postgres if you
want it, built-in cron and background workers, and boring deploys. Fly wins if
multi-region latency ever matters; it does not yet.

**Neon over Render Postgres** for the database: database branching makes a
warehouse project qualitatively easier — a per-PR branch means you test an ingest
migration against a real copy of the catalogue, not a fixture. Scale-to-zero
matters while there are no users.

**Cloudflare in front of everything** because R2's zero egress is decisive for
cover images, and because the WAF, DDoS protection and Turnstile come free with
the DNS you need anyway.

### The escape hatch, deliberately preserved

Everything above is **containers + standard Postgres + the S3 API**. A single
Hetzner dedicated box (~€45/mo) outperforms roughly $400 of managed services, and
moving there should be a weekend rather than a rewrite. That is only true if the
core path avoids provider-proprietary primitives — **no Durable Objects, no D1,
no Vercel KV, no proprietary queue** — which is why pg-boss (queues in Postgres)
is the recommendation in §7. The constraint is worth honouring even where a
proprietary service would be marginally nicer.

### Environments

`local` (docker compose) → `preview` (per-PR, Neon branch, ephemeral) →
`staging` (production-shaped, sanitized data) → `production`.

---

## 4 · Authentication

Full detail: **[11 · Identity](11-IDENTITY.md)**.

- **OIDC, authorization code + PKCE.** No password storage, ever.
- **Better Auth**, self-hosted inside the API — identity lives in the same
  Postgres as the data it authorizes, because `account` is joined against on
  nearly every query.
- Methods, in order: **passkey**, Google, Apple, email magic link, GitHub.
- **Opaque server-side sessions in a `__Host-` cookie** (`Secure`, `HttpOnly`,
  `SameSite=Lax`). Not a JWT in `localStorage` — unrevocable and
  XSS-exfiltratable. Postgres is authoritative, Redis caches.
- Sliding 30-day idle / 180-day absolute expiry. Device list with per-session
  revoke. Re-auth for sensitive actions.
- **Unlimited concurrent sessions, no eviction, ever** — a hard requirement from
  [14 · Sharing](14-SHARING.md).
- Non-browser access: scoped, hashed, revocable PATs; the `.ics` calendar feed
  gets a capability URL instead, because calendar clients cannot do OAuth.
- **The passphrase encryption is deleted.** It existed because the sync target
  was a public git repository. See [10](10-REARCHITECTURE.md).

---

## 5 · User access control

Full detail: **[14 · Sharing](14-SHARING.md)** and [11](11-IDENTITY.md).

**Relationship-based, not role-based**, because every question this product asks
is "is the actor the owner / a member / a follower / blocked?".

- **One seam:** `can(actor, action, resource)`. Called everywhere, never inlined
  in a view. This is the `BT.repo` lesson applied to authorization — one seam is
  why encrypted sync could be added without a rewrite, and one seam is why
  authz will not leak.
- **Library roles:** `owner` · `editor` · `contributor` · `viewer`.
- **Object visibility:** `private` · `link` · `followers` · `public` ·
  `unlisted-public`, resolved **at read time**, never denormalized into feed
  rows.
- **Two distinct hide flags:** `hidden_from_public` (library-level) and
  `private_to_actor` (per-member). Conflating them exposes private reading to
  housemates.
- **Block ≠ mute.** Bidirectional and content-hiding vs one-directional and
  silent. Separate tables.
- **RLS as defence in depth** if the host provides it — never as the primary
  mechanism, because RLS cannot readably express "followers of the owner, unless
  blocked, unless hidden".
- **Audit log** on every moderation and admin action.

---

## 6 · Data and storage

Full detail: **[12 · Storage](12-STORAGE.md)**, **[13 · Warehouse](13-WAREHOUSE.md)**.

| Tier | Technology | Holds |
|---|---|---|
| OLTP | Postgres 16 | Catalogue, users, libraries, social, mutations |
| Vector | `pgvector` (HNSW), same instance | Work + author embeddings |
| Search | `tsvector` + `pg_trgm` → Typesense later | Title / author / series |
| Cache | Redis | Rate limits, session cache, presence, computed payloads |
| Blobs | Cloudflare R2 | Covers, avatars, exports, raw dumps |
| Analysis | DuckDB over Parquet in R2 | Ad-hoc, zero infrastructure |

**Five schema principles:** UUIDv7 keys (never semantic strings like
`book:openlibrary:OL27482W`) · raw source records immutable, canonical rows are a
**projection** · append-only where history is the feature
(`release_observation`, `reading_event`, `mutation`) · `library_id` on every
user-owned row · soft delete via `deleted_at`.

**The warehouse is the product.** Three zones — **landing** (byte-faithful) →
**conformed** (cleaned, still per-source) → **canonical** (entity-resolved, with
field-level provenance) — behind one rule: *no user-facing request may depend on
an external API being up, correct, or fast.* Source outages become staleness
metrics; source gaps become coverage metrics; neither becomes a broken screen.

**Backups:** PITR (35 days) + nightly logical dump to a *different provider* +
**quarterly tested restore**. Canon is rebuildable from the landing zone, so
backup priority is user data. Target RPO ≤ 5 min, RTO ≤ 2 h.

---

## 7 · API and networking

### Design

- **REST + JSON over HTTP/2, `/v1/` prefixed.** Not GraphQL for v1 — one
  consumer, and GraphQL's real costs (per-field authz, N+1, cache invalidation)
  land immediately while its benefits do not.
- **Cursor pagination**, never offset.
- **Idempotency keys on every mutation** — the offline outbox retries.
- **`ETag` / `If-None-Match`** on catalogue reads.
- **RFC 9457 Problem Details** for errors. Real error messages are already a
  project value.
- **OpenAPI generated from types**, typed client generated for the front end.
- Versioned by URL prefix, with deprecation headers and a stated support window.

### Surface

```
/v1/canon/search           GET    edge-cached, public
/v1/canon/works/:id                works, editions, people, series
/v1/canon/isbn/:isbn13     GET    the scanner's hot path
/v1/libraries/:id/items    GET/POST/PATCH
/v1/libraries/:id/mutations GET   ?since=<cursor>   ← offline catch-up
/v1/libraries/:id/stream   GET    SSE               ← live updates + presence
/v1/libraries/:id/members  GET/POST/DELETE
/v1/lists, /v1/reviews, /v1/follows, /v1/feed
/v1/radar                  GET    release calendar
/v1/foryou                 GET    ranked, per account
/v1/me, /v1/me/sessions, /v1/me/export, /v1/me/delete
/ics/:capability_token     GET    calendar subscription
```

### Realtime

**SSE, not WebSockets.** One-directional server push is all this needs; SSE
multiplexes over HTTP/2, reconnects automatically with `Last-Event-ID`, traverses
proxies, and needs no separate protocol. Writes go over ordinary `POST`.
WebSockets only if collaborative text editing ever ships.

### Networking and edge policy

- TLS 1.3, HSTS with preload, HTTP/2 (HTTP/3 free via Cloudflare).
- **Same-origin API** (`/v1/*` alongside the app) so no CORS preflight on the hot
  path and the app's relative-URL habit stays valid.
- **The CDN caches `/v1/canon/*` and nothing else.** Authenticated routes are
  served from a path the CDN is configured never to cache — the mitigation for a
  `Vary` mistake is to make it structurally impossible, not to be careful.
- **Rate limits**, token bucket in Redis: per-account, per-IP, per-route.
  Stricter on signup, magic-link send, search, and scan lookups.
- Response compression (brotli), request size caps, timeouts at every hop.

---

## 8 · Jobs and the pipeline

Full detail: **[13 · Warehouse](13-WAREHOUSE.md)**.

**pg-boss** — queues in Postgres. Transactional enqueue with the write that
triggers it, one less system to operate, and comfortably fast enough. Graduate to
Redis/BullMQ only on measured need.

| Class | Cadence | Notes |
|---|---|---|
| **Ingest** | monthly | OL dumps, ~15 GB gz, streamed, idempotent via content hash, on an ephemeral big box |
| **Enrich** | continuous, tiered | Daily/weekly/monthly by volatility. Paid **once per author across the whole population**, not per browser |
| **Derive** | on version bump | Genres (`taxonomy_version`), similarity (`model_version`), embeddings. Compute to shadow, diff, review, promote |
| **Fan-out** | event-driven | Notifications, digests, feed invalidation. Never a timer aimed at a user |
| **Maintain** | nightly | Partitions, vacuum supervision, expired sessions/exports, hard-delete past grace |

**Quality gates block promotion.** A batch that would drop >0.5% of date
precision, or lose all credits on any work, or double the conflict rate, holds in
the conformed zone and alerts. This is the control that stops a monthly dump full
of bare years from flattening every real date the enrichment layer earned.

---

## 9 · Client

- **Vite + TypeScript.** The `file://` constraint is gone, which was the only
  justification for classic script tags and numeric file ordering. Bundling also
  directly fixes the measured **3.6 s first paint on a phone** — caused by five
  stylesheets and 448 KB of script round-robining one throttled H2 pipe, with
  `04-views.css` landing last of 36 responses. `defer`/`fetchpriority` were
  measured to do nothing.
- **Incremental, not a rewrite.** Types onto the data layer first — that is where
  correctness lives. Views are the least valuable code and can migrate one at a
  time or not at all. A from-scratch framework rewrite is the single most likely
  way this project loses its 28,000 lines of verified behaviour.
- **IndexedDB becomes a cache + outbox**, not the truth. Optimistic local write →
  outbox with idempotency key → replay on reconnect → server assigns authoritative
  version → SSE delivers everyone else's changes.
- **Service worker's job changes**: precache the shell, runtime-cache canon GETs
  stale-while-revalidate, Background Sync for the outbox.
- **Still installable, still works offline**, but as a *cache* with honest
  staleness rather than as a sovereign database.
- **CSP with nonces, no inline handlers.** Likely a real migration item.

---

## 10 · Observability

- **Structured JSON logs** → Better Stack or Grafana Cloud. Request id propagated
  everywhere.
- **OpenTelemetry traces** across api → worker → Postgres.
- **RED metrics** per endpoint; queue depth; ingest lag; per-source error rate.
- **Sentry** on client and server.
- **Data-quality metrics as first-class dashboards** — this is the distinctive
  one, and it is on-brand for a project whose entire value is data honesty:
  coverage (% of shelved works with day-precision dates, covers, genres,
  credits), source agreement, freshness p50/p95, gap rate, radar coverage by
  publisher, auto-merge and unmerge rates.
- **Alerts that reach a phone**, and a public status page.

---

## 11 · Security

- No secrets in the client. Secret manager (Doppler/Infisical or the host's),
  rotated, never in git.
- CSP (nonce), HSTS preload, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy` (camera only where the scanner lives).
- Parameterized queries only; the typed query builder makes string SQL a lint
  failure.
- Uploads: size cap, server-side re-encode, EXIF/GPS strip, never trust the bytes.
- Turnstile on signup and magic-link send; email verification before publishing.
- Dependency scanning + SBOM. **The vendored ZXing wasm is already good practice
  here** — pinned, hashed, documented — and that pattern should extend.
- PII inventory and a data map, needed for GDPR anyway.
- A security review of authn/authz before public launch. A full pen test is
  overkill for this scale; skipping an authz review is not.

---

## 12 · Cost

Monthly, USD, order-of-magnitude. None of these were quoted.

| | **Prototype** (just you) | **Small** (~500 users) | **Real** (~5,000) |
|---|---|---|---|
| Postgres (Neon) | $0–19 | $30–70 | $100–250 |
| API + worker compute | $7–14 | $25–60 | $80–200 |
| Redis | $0 | $0–10 | $10–30 |
| Cloudflare (CDN/R2/WAF) | $0–5 | $5–25 | $25–70 |
| Ingest burst | $3 | $5 | $10 |
| Search (if separate) | $0 | $0–25 | $30–80 |
| Email | $0 | $0–20 | $20–50 |
| Sentry + logs | $0 | $0–30 | $30–80 |
| Embeddings | $0–20 one-off | ~$5 | ~$20 |
| Google Books | $0 | $0 | $0 |
| ISBNdb *(optional)* | $0 | $0–36 | $100–300 |
| **Total** | **≈ $15–60** | **≈ $70–280** | **≈ $325–1,090** |

**Cost drivers, in order:** whether ISBNdb is bought (optional, defer) · whether
covers are stored or proxied (a legal question before a financial one) · whether
search moves off Postgres · logging retention, which is the classic silent
overrun.

**The Hetzner alternative:** one dedicated box, Coolify, self-hosted Postgres and
Redis, Cloudflare in front — ~€45/mo covering the "Real" column, in exchange for
owning patching, backups and HA. Genuinely viable for a project at this scale,
and the reason §3 insists on portability.

**Revenue, if it ever matters:** Bookshop.org (10%) and Libro.fm affiliate links.
Note that affiliate revenue is *not* a user fee — which matters, because the
Google Books terms state verbatim that *"You may not charge users any fee for the
use of your application"* **[verified 2026-08-04]**. A subscription tier would
collide with the terms of the current primary data source.

---

## 13 · Build order

| Phase | Ships | Needs a population? |
|---|---|---|
| **1** | Warehouse + Canon API — greenfield backend behind an unchanged front end. Search gets faster and better; nothing else changes | no |
| **2** | Accounts, libraries, sync. Retire the GitHub-token sync | no |
| **3** | **Sharing**: members, roles, share links, concurrent sessions, SSE | no |
| **4** | **Radar**: PRH + NYT, release calendar, digests, `.ics` | no |
| **5** | **Commons**: profiles, lists, follows, feed, moderation | yes |
| **6** | **For You**: Tier 1 + 3 similarity; Tier 2 gated on a pre-agreed population threshold | yes |

Phases 1–4 are all valuable **for a single user**, which is the property that
makes this buildable by one person without needing an audience first.

---

## 14 · The five things most likely to go wrong

1. **Rebuilding the backend without re-reading `DECISIONS.md` first.** The code is
   disposable; the findings are not. The precision ratchet, the credit check, the
   language filter, the containment tests, the 12 duplicate Hobbit ISBNs — all
   *measured*, none rediscoverable by reading a rewrite. **Rule: before writing a
   source adapter, turn that source's rows in `DECISIONS.md` into failing tests.**
2. **A front-end framework rewrite.** The client is the half worth keeping
   ([17-SPLIT](17-SPLIT.md)); a React port would spend months reproducing
   `56-inspector.js` and `55-tree.js` and arrive nowhere better.
3. **A monthly dump flattening every earned date.** Fix: quality gates, and a
   test that fails loudly.
4. **Google Books terms** — retention and the no-user-fee clause, both unresolved,
   both load-bearing. Fix: per-source purge designed in from the start, and a
   drill that proves canon survives Google's removal.
5. **Ops burden on one person.** GitHub Pages has no pager; Postgres with real
   users does. This is a lifestyle change and the honest reason many good
   local-first apps stay local-first.
