# Inbox

Running capture. Ideas land here as they arrive, get a one-line disposition, and
either get folded into a document or stay parked with a reason.

**Status key:** `→ folded` (now written up somewhere) · `parked` (kept, not yet
placed) · `open` (needs a decision)

---

## Folded

| # | Idea | Where it landed |
|---|---|---|
| 1 | Social layer: shelf-first, sharing, lists | → [04-SOCIAL](04-SOCIAL.md) |
| 2 | Cloud host, off GitHub Pages | → [ARCHITECTURE §3](ARCHITECTURE.md), [10](10-REARCHITECTURE.md) |
| 3 | Broader API access for recommendations + upcoming releases | → [05-SOURCES](05-SOURCES.md) |
| 4 | "For You" page: upcoming from followed **and** similar authors | → [07-FORYOU](07-FORYOU.md), [06-RADAR](06-RADAR.md) |
| 5 | The current architecture is a GitHub-Pages artifact — full data re-architecture | → [10-REARCHITECTURE](10-REARCHITECTURE.md). Encryption, blob sync, IndexedDB-as-truth and the four ISBN namespaces all deleted |
| 6 | Full systems workup — auth, hosting, networking, UAC, languages, costs | → [ARCHITECTURE](ARCHITECTURE.md) |
| 7 | Data warehouse with multiple cleaned inputs; own the book database; survive source gaps and outages | → [13-WAREHOUSE](13-WAREHOUSE.md) |
| 8 | Share your library with someone | → [14-SHARING](14-SHARING.md) — `library` becomes a first-class entity with members and roles |
| 9 | Two users signed into one account simultaneously, fully supported | → [14-SHARING](14-SHARING.md) — per-library mutation log, field-level ops, SSE, no session eviction |
| 10 | Consolidate onto as few hosts as possible; and do we need a domain name? | → [16-CONSOLIDATION](16-CONSOLIDATION.md) — floor is 3 vendors; domain ~$12/yr at Cloudflare Registrar |
| 11 | "What is the 150 GB of JSONB? Is that user data?" | **It wasn't, and it shouldn't have existed.** Corrected in [13-WAREHOUSE](13-WAREHOUSE.md) and [16-CONSOLIDATION](16-CONSOLIDATION.md): keep dumps as `.txt.gz`, don't unpack an archive to store it. Postgres lands at ~70–120 GB; user data is <1% of it |
| 12 | The front end is the product; the backend can and should be rebuilt from the ground up | → [17-SPLIT](17-SPLIT.md) — a line-by-line accounting. ~13,700 lines die or move server-side, ~14,200 survive. Kills the "shared normalizer" plan and the old Phase 0 |

---

## Open questions carried forward

Answers change the design; none are blocking yet.

1. **One product or two?** Commons as a separate app BookTrak syncs into, versus
   one app with a server behind it.
2. **Does MovieTrak come along?** Shared Canon and a shared social layer across
   books and films — either the best idea here or a doubling of scope. Currently
   unaddressed anywhere.
3. **Google Books terms** — retention, and the verbatim *"You may not charge
   users any fee"* clause. Load-bearing, unresolved. ([13](13-WAREHOUSE.md),
   [08](08-OPEN.md))
4. **Open Library dump licence** — believed open, currently *believed* rather
   than read. The foundation of the whole warehouse.
5. **Covers: store or proxy?** Legal before financial.
6. **Population threshold** below which Tier-2 similarity stays switched off.
   Pick the number before the temptation to ship early.
7. **Goodreads CSV import** — Phase 5 or never. Biggest onboarding lever, real
   matching project, arrives edition-poor and collides with the scope model.
8. **Region and market.** Every date today is implicitly US-or-whatever-the-
   source-said. `release_observation.market` exists in the schema; the UI needs a
   preference.
9. **Who is this for?** A tool for one person with strong opinions and a product
   for thousands are designed differently. The tension shows up first in
   moderation and defaults.

---

## Parked

*(nothing yet)*

---

## Next up, unprompted suggestions

Things worth a decision at some point, not yet argued anywhere:

- **Series tracking as a first-class object.** "Book 4 of a series you are 3 into"
  is the single strongest release signal available, and Hardcover is the cheapest
  source of series data. Currently mentioned in passing in
  [05](05-SOURCES.md)/[07](07-FORYOU.md) but never designed.
- **Physical shelf mapping** — which bookcase, which shelf. Scanner-driven,
  trivially additive to the schema, and the kind of thing people with 800 books
  actually want.
- **Lending.** "Alex has my copy of X since March." Fits the ownership axis (D9)
  exactly, and pairs naturally with shared libraries.
- **Statement of coverage in the UI.** The warehouse produces honest coverage
  metrics; showing the reader "we have day-precision dates for 62% of your shelf"
  is squarely in this project's voice.
