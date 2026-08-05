# Sources

What a server can reach that a static page cannot, what each one gives, and what
each one forbids.

Facts marked **[V 2026-08-03]** are carried over from `DECISIONS.md`, where they
were verified against live endpoints. Facts marked **[R 2026-08-04]** were
researched for this document and are *documentation-level* claims, not live
tests. Everything else is judgement.

---

## The shape of the problem, restated

The current app's source list is short because of two constraints: no key can be
shipped, and no server exists to hold one. Hosting removes both, and the field
opens from **two** usable sources to roughly **fourteen** — but they sort into
four very different kinds of thing, and conflating them is how you end up with a
catalogue you cannot legally keep.

| Kind | Examples | Can we *store* it? |
|---|---|---|
| **Open corpora** — bulk, licensed for reuse | Open Library, Wikidata, BookBrainz, LoC | **Yes.** These are Canon. |
| **Licensed feeds** — paid, contractual | ISBNdb, Bowker, Nielsen | Yes, per contract |
| **Courtesy APIs** — free, keyed, restrictive terms | Google Books, PRH, NYT, Hardcover | **Usually no.** Query live, cache briefly |
| **Affiliate rails** — commerce, not metadata | Bookshop.org, Libro.fm | N/A |

**The architectural consequence is the most important sentence in this file:
Canon must be built out of the *open corpora*, and the courtesy APIs must be a
live enrichment layer read through a short cache — not a source we quietly copy
into our database.** Building the permanent catalogue out of Google Books
responses would be fast, would work, and would be the kind of thing that is fine
until it is a letter.

---

## Tier 1 · The corpus you own

### Open Library — bulk dumps

**The single highest-value item in this document.**

- `openlibrary.org/data/ol_dump_editions_latest.txt.gz` — ~10.5 GB compressed
  **[R 2026-08-04]**
- `ol_dump_works_latest.txt.gz` — ~3.5 GB
- `ol_dump_authors_latest.txt.gz` — ~0.5 GB (≈3 GB uncompressed)
- Refreshed **monthly**. Data is openly licensed (Internet Archive / CC0 for the
  bibliographic records — **verify before launch**, see [08](08-OPEN.md)).

**What it ends:** the ~1 req/sec ceiling, the "do not use as a high-traffic
backend" problem, the 50-per-page editions walk (481 editions of *The Hobbit* in
one query), the `sort=` bug that answers *Robinson Crusoe* at HTTP 200
**[V 2026-08-03]**, name-scoped author queries returning the wrong writer
**[V 2026-08-03]**, and the client-side re-ranker existing because the server's
ranking puts *Children of Dune* above *Dune* **[V 2026-08-03]**.

**What it does not fix:** the dump is up to a month stale, and every field-
presence problem `DECISIONS.md` documents is still there — 30% of Hobbit editions
lack `isbn_13`, 13% have no ISBN at all, `publish_date` is free text and a bare
year in 11 of 12 cases, `first_publish_year` is a computed minimum that reports
*The Alloy of Law* as 2001. **A dump of bad dates is a lot of bad dates.** The
value is scale and freedom, not quality; quality still comes from the enrichment
layer.

**Also keep the live API** as a fill path for records newer than the dump —
which is exactly the forthcoming title we care most about.

### Open Library — the live API

Retained for three things a bulk dump can't give: freshness between dumps, the
work/edition graph for records added this month, and stable **author OLIDs**,
which are the only identifier a follow may be keyed on.

### Wikidata

Free, SPARQL, CC0, and the only open source of the *relational* facts a
recommender wants: `P50` author, `P136` genre, `P135` movement, `P737` influenced
by, `P166` award received, `P179` series, plus nationality, era and language.
**[R 2026-08-04]**

**Honest limits:** coverage is excellent for canonical and literary authors and
thin-to-absent for the mid-list genre writers who make up most of a real
following list. `influenced by` is editorially uneven. Treat it as a **high-
precision, low-recall** tier: when it fires, the evidence is excellent
("both nominated for the Shirley Jackson Award, 2022"); when it doesn't, fall
through silently.

Ingest as a filtered dump or query the endpoint on a schedule. Do not query it
per request.

### BookBrainz

MusicBrainz's book sibling: open data, open licence, a real relational model with
works, editions, editions-groups, publishers and *author credits*. **Coverage is
small.** Worth ingesting because it is free and the model is clean, worth zero as
a primary source.

### Library of Congress / national bibliographies

LoC has open bulk MARC data; the British Library's BNB is available as linked
data. Both are authoritative on *published* books, slow on new ones, and encoded
in library formats that cost real effort to parse. **Deferred**, but they are the
right answer if authority ever matters more than convenience.

---

## Tier 2 · Enrichment, queried live

### Google Books — with a server-side key

Already the primary source in the current app, and the reason for the pivot: it
wins search relevance (`q=dune` → Frank Herbert's *Dune* first, correctly
attributed), wins dates outright (`2024-12-06` against a bare `2024`), and is the
**only** one of the two that knows about books that have not come out yet
**[V 2026-08-03]**.

Hosting changes three things:

1. **One key, shared.** The whole `hasKey('googlebooks')` gate and its
   "keyless install issues zero requests" behaviour becomes an *internal* concern
   rather than a user-facing setting. Every reader gets real dates.
2. **Quota.** Default is 1,000/day on a personal key; the Cloud console has a
   quota-increase form and higher tiers commonly require billing enabled
   **[R 2026-08-04]**. Reports of the standard quota being higher than 1,000
   exist and conflict; **treat the real ceiling as unknown until measured on our
   own project.** This is a Phase-1 measurement, not a Phase-4 surprise.
3. **We become the rate limiter.** `BT.NET_POLICY.googlebooks.retries = 4` exists
   because 10–12 of 20 identical requests answer `503 backendFailed`
   **[V 2026-08-03]**. Server-side that becomes a queue with backoff, and the
   flapping problem the 2026-08-03 pass found — *Boneset & Feathers* present on
   three refreshes and missing on the fourth, throwing away a stored real date —
   is solved structurally by the append-only `release_observation` table
   ([03](03-DATA-MODEL.md)) rather than by a client-side guard.

**⚠ Two terms problems, and one is serious.**

- The Books API terms state, verbatim: *"You may not charge users any fee for the
  use of your application, unless you have entered into a separate agreement with
  Google or obtained Google's written permission."* **[R 2026-08-04]** That is a
  direct constraint on **any paid tier** for a product that depends on this API.
  It does not block a free product, and it does not block asking Google, but it
  means "we'll monetize later" is not a plan you can defer thinking about.
- The Books-specific terms page is silent on caching and database-building; those
  restrictions live in the general **Google APIs Terms of Service**, which was
  not read for this document. **Unresolved, and load-bearing** — the design in
  this dossier already assumes we do *not* store Google-derived records as Canon,
  which is the conservative reading, but this needs a real answer before launch.

### Hardcover — free GraphQL API

`https://api.hardcover.app/v1/graphql`, bearer token, free. **[R 2026-08-04]**
It is the closest thing to a modern Goodreads API that exists: typed search over
**Books, Authors, Series, Characters, Lists, Publishers and Users**, and library
items by status. **[R 2026-08-04]**

Why it matters more than its size suggests: it exposes **series**, **characters**
and **user-made lists** — three relational structures that Google Books does not
have and Open Library holds only sporadically. Series in particular is a large
missing piece for a release radar (*"book 4 of a series you are 3 books into"* is
one of the strongest possible signals) and Hardcover is the cheapest source of
it.

**Caution:** it is a small company's free API for a competing product. Depending
on it for anything structural is a business risk, and bulk-pulling it to build a
rival catalogue would be both rude and probably a terms violation. **Rate limits
and terms were not verified** — the docs site returned 403 to automated fetch.
Use it as a targeted enrichment for series and character data, ask before doing
volume, and never make it load-bearing.

### Penguin Random House — free developer API

`developer.penguinrandomhouse.com`, open registration, free keys.
**[R 2026-08-04]** REST over Titles, Authors, Works, Series, Imprints. Sorts by
`onsale` and `frontlistiest_onsale`, and exposes on-sale dates directly.
**[R 2026-08-04]**

**This is the best forthcoming-title source in the document**, because it is a
publisher's own catalogue rather than an index's guess about one. PRH is roughly
a quarter of US trade publishing, and its imprints (Del Rey, Ace, Ballantine,
Riverhead, Knopf, Vintage…) map cleanly onto the taste neighbourhoods that
matter. Also gives **imprint**, which is the single most under-used similarity
signal in the whole field — see [07](07-FORYOU.md).

**Limits:** one publisher. Terms unverified; the docs are ageing (blog posts from
2016–2018) and the API's continued maintenance should be confirmed before
depending on it. Assume attribution and non-commercial constraints until read.

### New York Times Books API

Free key, **4,000 requests/day, 10/minute**. **[R 2026-08-04]** Bestseller lists
(current and historical), list names, and the history of a title on a list.

Not a metadata source — a **buzz** source. It answers a question no catalogue
can: *is anyone talking about this?* Useful as a mild popularity prior in ranking
and as a "notable this week" section that is factual rather than algorithmic.
Cheap to ingest weekly; do not query per request.

### ISBNdb — paid

$14.99 / $35.99 / $99.99 / $299.99 per month **[R 2026-08-04]**, ~110 million
titles, up to 19 fields per record, updated daily, and — uniquely here —
**retailer prices**. **[R 2026-08-04]** Academic/non-profit tier exists at 2,000
searches/day.

`DECISIONS.md` lists ISBNdb as returning 401 without an account. With a server,
that stops being a barrier and becomes an invoice. It is the answer to the
current app's "**Prices, or where to buy**" gap, and the best commercial fallback
for an ISBN the open corpora have never heard of.

**Recommendation: do not buy it in Phase 1.** It is a quality upgrade on a
problem we will not have yet, and $15/mo is easy to add later. Revisit when a
measured miss-rate justifies it.

---

## Tier 3 · Commerce rails

### Bookshop.org affiliate

10% commission, cookie-based affiliate links and embeddable widgets.
**[R 2026-08-04]** No developer API surfaced in research — the integration is
link construction, not data. Supports independent bookshops, which fits the
project's character far better than Amazon does.

### Libro.fm affiliate

Audiobooks, 30-day cookie, commissionable links generated from the product page.
**[R 2026-08-04]** Same shape: links, not data.

Together these are the plausible **revenue model** — and note that a revenue
model built on affiliate links is *not* "charging users a fee", which is exactly
the clause the Google Books terms turn on. That is a happy accident worth
noticing early.

### Amazon Product Advertising API

Still requires an affiliate account with qualifying sales history. Still
unavailable. Unchanged from `DECISIONS.md`. Do not plan around it.

---

## Tier 4 · Named and rejected

| Source | Status |
|---|---|
| **Goodreads** | Keys retired end of 2020, no replacement. CSV export is the only route in, and it is one-way and edition-poor |
| **StoryGraph** | No public API, ever |
| **WorldCat / OCLC** | classify endpoint 404s; the real API is an institutional library contract, not a developer signup |
| **Bowker Books In Print / Nielsen** | The actual industry metadata authorities. Real ONIX-grade data including forthcoming titles. Enterprise contracts, four to five figures annually, aimed at retailers and libraries. **The correct answer if this ever became a business**, and out of scope for a hypothetical |
| **ONIX feeds direct from publishers** | The pipe every retailer actually uses — but publishers send ONIX to trading partners (Amazon, Ingram, Bowker) by FTP, not to apps. Requires being someone they want to trade with |
| **Edelweiss+ / Ingram iPage** | Trade catalogues with genuine forthcoming data. Gated to booksellers, librarians and reviewers |
| **Macmillan / HarperCollins / Hachette** | No public developer APIs found **[R 2026-08-04]**. PRH is the exception among the Big Five, not the rule |
| **Internet Archive full-text search** | Real, and tied to lending accounts rather than the catalogue API. Unchanged |
| **LibraryThing** | `thingISBN` and Common Knowledge historically existed; current status unverified. Worth a look for **series** and **"other editions"**, which is exactly what we're short of |

---

## Tier 5 · The source that is not an API

### Our own users

This is the one that changes the ceiling, and it is worth stating in the same
register as the others because it *is* a data source with a schema, a cost and a
licence:

- **Input:** `shelf_signal(pseudonym, work_id, signal)` — opt-in, pseudonymous,
  minimal ([03](03-DATA-MODEL.md)).
- **Yields:** item-item co-occurrence, author co-following, list co-membership,
  and — uniquely — **abandonment**, because BookTrak has recorded `dropped` as a
  first-class status since day one and essentially nobody else collects it.
- **Cost:** zero marginal, and a real privacy obligation.
- **Cold start:** total. Worthless at 11 users, transformative at 5,000.

`DECISIONS.md` defers a recommender on the grounds that "Open Library has
subjects but no similarity graph at all, so half the scorer has no input and the
other half would be tag overlap wearing a confident name." **This is the missing
half.** It is also the only one of the fourteen sources here that no competitor
can buy, copy or deny us.

### Embeddings

Not a book source — a way to make the thin ones useful. Embed
`title + blurb + subjects + first paragraph of description` per work and store in
`pgvector`. Fills the gap where a debut author has no co-credits, no awards, no
Wikidata entry and no shelf co-occurrence — which is *precisely* the forthcoming-
title case the For You page exists to serve.

Anthropic does not ship an embeddings endpoint; the recommended route is
**Voyage AI**, or a self-hosted open model if cost or data-residency argues for
it. Roughly: a few million works at current embedding prices is tens of dollars
one-off, then pennies for the monthly delta. Cheap enough that the only real
question is quality, and quality is measurable.

---

## Summary: what to actually wire up

| Phase | Sources |
|---|---|
| **1 · Canon** | Open Library dumps + live API. Nothing else. |
| **2 · Enrichment** | Google Books (server key), Wikidata |
| **3 · Radar** | + Penguin Random House, NYT Books |
| **4 · Similarity** | + Hardcover (series/characters), embeddings, own-user signals |
| **Later / if** | ISBNdb, Bookshop.org + Libro.fm affiliate, LibraryThing, BookBrainz |

## Sources

- [Hardcover API docs](https://docs.hardcover.app/api/getting-started/) · [Hardcover GitHub](https://github.com/hardcoverapp/hardcover-docs/) · [emgoto: Hardcover as a Goodreads API alternative](https://www.emgoto.com/hardcover-book-api/)
- [Open Library Data Dumps](https://openlibrary.org/developers/dumps) · [Open Library Bulk Data](https://openlibrary.org/data) · [Searching Data Dumps](https://docs.openlibrary.org/developers/misc/searching-data-dumps.html)
- [Penguin Random House Developer Portal](https://developer.penguinrandomhouse.com/) · [PRH Title resource](https://developer.penguinrandomhouse.com/docs/read/enhanced_prh_api/resources/Title)
- [NYT Books API spec](https://github.com/nytimes/public_api_specs/blob/master/books_api/books_api.md) · [NYT Developer Portal](https://developer.nytimes.com/)
- [ISBNdb pricing](https://isbndb.com/isbn-database) · [ISBNdb: Top 9 Book APIs in 2026](https://isbndb.com/blog/book-api/)
- [Google Books API Terms](https://developers.google.com/books/terms) · [Capping API usage — Google Cloud](https://docs.cloud.google.com/apis/docs/capping-api-usage)
- [Bookshop.org affiliate links & widgets](https://support.bookshop.org/en/support/solutions/articles/65000189603-how-do-affiliate-links-widgets-work-on-bookshop-org-) · [Libro.fm Affiliate Program](https://libro.fm/affiliates)
- [Wikidata SPARQL: books by author with genres and series](https://linkedwiki.com/query/wikidata_Books_by_a_given_Author_including_genres,_series,_and_publication_year?lang=EN)
