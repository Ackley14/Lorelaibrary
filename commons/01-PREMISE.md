# Premise

> ⚠ **Superseded by [10-REARCHITECTURE](10-REARCHITECTURE.md).** This was written
> on the premise of *porting* BookTrak's architecture to a server. That premise
> was wrong — most of what it preserves (E2E encryption, IndexedDB as the source
> of truth, the two-secrets model in P2) are artifacts of having no server, not
> principles. **What survives:** the "What must survive" list below, which is
> about books rather than hosting.

## What we have

BookTrak is a 28,000-line, no-build, single-global vanilla web app. It holds a
library in IndexedDB, treats a work and an edition as different objects, refuses
to state a publication date more precisely than its source can support, follows
authors by stable identifier, and encrypts itself into a public repository with a
passphrase nobody stores. It is deliberately a **guest** on other people's
infrastructure: Open Library is a charity's server that asks not to be used as a
backend, Google Books is user-keyed at 1,000 requests a day, and the sync target
is a git repository.

Every hard constraint in `DECISIONS.md` traces back to one of two facts: *a
static page has no server*, and *a public repo cannot hide a key*.

## What changes

A host removes both. That is the entire premise, and it cascades much further
than "now we can have accounts":

| Constraint today | After hosting |
|---|---|
| No key can be shipped | One server-side key, one quota, shared by every reader |
| Open Library at ~1 req/sec, per browser | **Their monthly bulk dump, ingested once, queried locally at any rate** |
| Relevance re-ranked client-side because the server's ranking is unusable | Our own index, our own ranking, computed once |
| `sort=` silently eats `q` (D4) | Not our problem — we own the sort |
| Editions paginate at 50 | We hold all 481 of them in a table |
| No forthcoming-title data worth plotting | A release table fed by four sources, polled on a schedule, with history |
| No similarity graph, so no recommender (Deferred) | **Every shelf on the platform is an edge list** |
| Nothing runs while the app is closed — no push | Cron, queues, digests, web push |
| `file://` must work, so no `type="module"` | The `file://` constraint is *gone*; modules and a build step become legal |
| Library visible only to you | Publishable, per object, opt-in |

## What must survive

This is the more important list. A social book app that loses BookTrak's
personality is just a worse Goodreads, and Goodreads already exists.

**S1 — Local-first is not negotiable.** The reader's shelf lives in IndexedDB and
the server is a *peer*, not the truth. Airplane mode still opens the library,
still records a page, still rates a book. This is the single biggest
differentiator against every competitor and it is also the thing a
"cloud rewrite" destroys by default, silently, on day one.

**S2 — Precision is a ratchet, in both directions** (D6, and the 2026-08-03
verification pass). A coarser answer never overwrites a finer one, and "us
knowing less" is never reported as news. Multi-user makes this *harder*, not
easier: now three users' clients and one server ingest can all propose a date for
the same edition, and the ratchet has to hold across all of them.

**S3 — Never a confident answer the source cannot support.** "Newly listed in
this catalogue", not "new release". "Could fall in this window", not a date.
A recommender that says *because you follow Gwendolyn Kiste — both in* Other
Terrors *(2022), both Nightfire* is in keeping. One that says *Recommended for
you* is not, and shipping the second would be the first real break with the
project's character.

**S4 — Work ≠ edition, and scope is explicit** (D2, D3). This is the thing
Goodreads gets wrong and it becomes a *social feature* here: "I own this
printing" is worth showing other people. See [04](04-SOCIAL.md).

**S5 — No explainer microcopy** (the 2026-08-03 purge). Empty states that name
the next action, real errors, statements about the reader's own data, source
attribution. Nothing that describes an implementation, because implementations
move and the copy stays behind lying with authority.

**S6 — Two seams, one each way.** `BT.net` is the only caller of `fetch()`; views
never touch `BT.db`, only `BT.repo`. Keep both. They are why this is possible at
all (see [02](02-ARCHITECTURE.md)).

## The four decisions everything follows from

### P1 — Three layers, not one database

Split what exists today into **Canon**, **Shelf** and **Commons**:

- **Canon** — the book graph. Works, editions, authors, series, subjects,
  releases, similarity. Shared by every user, owned by the server, contains
  nobody's personal data, cacheable at the edge, and *the same for everyone*.
- **Shelf** — your library. Status, rating, notes, progress, pile, scope, reading
  log. Private by default. Local-first. Encrypted at rest on the server.
- **Commons** — what you have chosen to publish. Profile, lists, reviews, follows,
  activity. Opt-in per object, revocable, plaintext by necessity.

The reason to draw the line here and not somewhere else: **Canon is the only
layer that needs to be big, Commons is the only layer that needs to be legible to
the server, and Shelf needs to be neither.** Three different storage strategies,
three different privacy postures, three different scaling problems. One database
schema that mixes them makes all three worse. Full detail in
[03](03-DATA-MODEL.md).

### P2 — Encryption survives, and it buys the recommender a hard question

Today there is no password stored anywhere: AES-GCM's authentication tag failing
on a wrong-key decrypt *is* the login (D14). That property is worth keeping for
Shelf. But it collides head-on with the thing this whole document is about —
**you cannot compute recommendations over data you cannot read.**

The resolution is not to abandon encryption; it is to make legibility an explicit
choice with an explicit reward:

- Shelf stays end-to-end encrypted by default. The server stores ciphertext.
- A single setting — *Contribute my shelf to recommendations* — publishes a
  **pseudonymous, minimal projection**: `(shelf_pseudonym, work_id, signal)`
  where signal is shelved / finished / rated-high. Not your notes, not your
  dates, not your name, not your reading log, and not linkable to your profile
  unless you separately publish that.
- If you leave it off, you still get recommendations — the server ships you the
  **similarity graph** (which is Canon, and identical for everyone) and your
  client scores it against your own shelf locally. Slower, smaller, and it works.

That last bullet is the interesting one and it should be built first, because it
is the version that respects the existing design *and* the version that works
before there are enough users for collaborative filtering to mean anything.

### P3 — The library is the object, not the feed

Goodreads is a feed with a library attached. Commons is a library with a feed
attached. Concretely: a profile **is** somebody's shelf, rendered with the same
index tree — statuses, twelve genres, three formats, both piles, counts down the
left. You browse it the way you browse your own. The feed is a thin "what
changed" surface over the same data, and it inherits the discipline of the
existing Activity view, which reports what was *observed* rather than what would
be exciting.

### P4 — Radar before recommendations

The upcoming-releases engine ([06](06-RADAR.md)) works with **one** user. The
collaborative half of the recommender ([07](07-FORYOU.md)) needs hundreds. So the
release calendar ships first, is honest on day one, and gets better as sources
are added — while the For You page starts as *content-based only*, says so, and
gains the behavioural tiers as the population arrives.

Shipping them in the other order produces a recommender trained on eleven shelves
that confidently tells everyone to read the same four books.

## What this is not

Not a Goodreads clone with a different logo. Not an attempt to be a social
network that happens to be about books — the engagement-feed shape is what makes
those hostile, and it is not needed to answer "what are my friends reading" or
"what is coming out". Not a commercial product in its current form: Open Library
asks not to be used as a backend for high-traffic applications, and the answer to
that is in [05](05-SOURCES.md) — ingest the dumps and stop being traffic — but
the *spirit* of that request should survive the workaround.
