# For You — author similarity, and the page it feeds

## The goal, in the user's words

> a taylored 'for you page' of sorts showing users upcoming book releases from
> not only their followed authors but also suggested authors they may like based
> on similarity to authors they do follow.

So the page is `Radar × Similarity`. [06](06-RADAR.md) built the first factor.
This is the second, and it is the harder one — because `DECISIONS.md` deferred
exactly this and gave a good reason:

> **A real recommender.** MovieTrak's is a hybrid of a taste profile and a
> similarity graph; Open Library has subjects but no similarity graph at all, so
> half the scorer has no input and the other half would be tag overlap wearing a
> confident name. Better absent than dishonest.

That paragraph sets the bar. The design below is an attempt to clear it, and its
organising principle is: **every edge in the graph must carry evidence a human
would accept as a reason.** If an edge cannot be explained in one clause, it does
not go in the graph. "Tag overlap wearing a confident name" is what happens when
you throw away the *why* and keep only the score.

---

## Author similarity in four tiers

Each tier is independently computable, independently switchable, and produces
edges with a `basis` ([03](03-DATA-MODEL.md)). Tiers 1 and 3 work with **zero
users**; tier 2 needs a population; tier 0 is not similarity at all.

### Tier 0 · Certain — not similarity

Authors you follow. Books in a series you are partway through. The next book by
someone you rated 9. These need no model and they are most of the value. **Ship
this alone and the page is already good.** Do not let the interesting problem
crowd out the easy one.

### Tier 1 · The bibliographic graph — cold-start, works on day one

Six signals, in roughly descending order of how convincing the resulting sentence
is:

**a · Co-appearance in an anthology or collection.** Two authors in the same
table of contents were chosen by the same editor for the same audience. In genre
fiction this is enormously strong and almost nobody uses it. Evidence sentence:
*"Both in* Other Terrors *(2022)."* Requires editor/contributor credits, which
Open Library holds unevenly and Hardcover holds better.

**b · Shared imprint.** Not publisher — **imprint**. "Penguin Random House" tells
you nothing; *Tor Nightfire*, *Erewhon*, *Soho Crime*, *Riverhead* are curated
taste with a person behind them. This is the most under-used signal in the entire
field and PRH's API exposes it directly ([05](05-SOURCES.md)). Evidence: *"Both
published by Tor Nightfire."*

**c · Award co-nomination.** Same award, same year, same category = the same
neighbourhood, chosen by people who read both. Wikidata `P166`. Evidence: *"Both
on the 2022 Shirley Jackson Award ballot."* High precision, low recall.

**d · Series and shared universe.** Wikidata `P179`, Hardcover series. Trivially
explainable and unambiguous.

**e · Subject-vector cosine.** TF-IDF over Open Library subjects plus Google's
BISAC headings, cosine between author centroids. **This is the "tag overlap"
`DECISIONS.md` warns about** and it must be treated accordingly: never used
alone, floored at a high threshold, and always rendered with its actual overlap
rather than as a score — *"Both filed under gothic fiction, haunted houses,
Appalachia"* is a reason; *"87% similar"* is a lie with a decimal point.

**f · Wikidata relations.** `P737` influenced by, `P135` movement, `P136` genre.
Excellent when present, absent for most working genre writers. Fall through
silently.

### Tier 2 · Behavioural — needs a population, and is the real prize

Three signals over `shelf_signal` and the social graph, in ascending order of
strength:

**a · Co-shelving.** Classic item-item collaborative filtering. Readers who
shelved X also shelved Y. Noisy — a bestseller co-occurs with everything — so it
needs standard normalization (cosine over binary vectors, or a log-odds /
Jaccard measure that penalizes ubiquity). Evidence: *"142 readers who shelved
Kiste also shelved Khaw."*

**b · Co-listing.** Authors appearing together on user-made **lists**. This is
better than co-shelving and it is the underrated one: a shelf is an accident of
what you own, a list is a deliberate assertion that these books belong together.
Curated co-occurrence has a far better signal-to-noise ratio than incidental
co-occurrence. It is also the strongest argument in this document for making
lists a first-class object in [04](04-SOCIAL.md) — they are a social feature that
doubles as the highest-quality training data on the platform.

**c · Co-following.** People who follow author A also follow author B. Strongest
of all at the *author* level, because a follow is an explicit, effortful,
forward-looking statement — the user is saying "tell me what this person does
next", which is precisely the question the For You page asks. It is also the
cheapest to compute (the follow graph is tiny compared to the shelf graph) and
the least noisy (nobody follows an author by accident).

**And the one nobody else has: `dropped`.** BookTrak has recorded abandonment as
a first-class status since day one. A negative signal is worth several positive
ones in a recommender and almost no book platform collects it. Two authors whose
readers *abandon* both are similar; more usefully, an author your neighbours
consistently drop should be **suppressed** for you. Use it as a demotion, never
as a displayed reason — "readers like you gave up on this" is true and cruel.

### Tier 3 · Semantic — fills the holes the others leave

Embeddings over `title + description + subjects` per work, author centroid,
cosine in `pgvector`. Not better than tiers 1 and 2 — **complementary**, and
specifically complementary in the case that matters most here: a debut author
with a forthcoming book has no co-credits, no awards, no Wikidata entry, no
shelf co-occurrence and no followers. Everything above returns nothing. A blurb
embedding returns something.

Rendered honestly, an embedding edge is the weakest sentence on the page —
*"Similar in subject and description to Gwendolyn Kiste"* — and it should be
ranked below every other tier and labelled as the guess it is.

### Combining them

Do not average. Take a **weighted max with a corroboration bonus**: the score is
the strongest single basis, plus a bump for each independent tier that also
fires. Two weak-but-independent reasons (same imprint *and* co-listed) are worth
more than one strong reason, and averaging destroys exactly that structure by
letting five silent signals drown one loud one.

Then floor it hard. **An author with no explicable basis does not appear.** An
empty For You page is a better product than a padded one, and it is the direct
descendant of the rule that already governs the Following page: every section
gives a hard answer — books, or "nothing is scheduled", or "we could not look" —
never an ambiguous blank.

---

## From author similarity to a ranked page

A candidate is a **forthcoming edition**, and it is scored:

```
score = w1 · author_affinity      -- followed=1.0, else similarity score
      + w2 · corroboration        -- how many independent tiers fired
      + w3 · proximity            -- closer release dates rank higher
      + w4 · precision            -- a confirmed day outranks a bare year
      + w5 · series_continuation  -- you are 3 books into this series
      + w6 · network_signal       -- people you follow have shelved it
      - p1 · dropped_penalty      -- you or your neighbours abandon this author
      - p2 · already_known        -- it is already on your shelf or dismissed
      - p3 · repetition           -- you were shown this last week and ignored it
```

`p3` matters more than it looks. A For You page recomputed daily over a slow-
moving release calendar shows the same six books for a month. Track impressions,
decay what has been ignored, and let the reader dismiss a book or an author
permanently — the `dismissed` store already exists in the schema
(`js/10-db.js`), which is a nice piece of luck.

---

## The page itself

**Not an infinite scroll. A dated page with bands**, inheriting the Radar's
structure and the Following page's honesty:

```
┌────────────────────────────────────────────────────────────────┐
│  Coming up for you                              next 90 days ▾ │
├────────────────────────────────────────────────────────────────┤
│  FROM AUTHORS YOU FOLLOW                                   (4) │
│  ▸ Isles of the Emberdark — Brandon Sanderson                  │
│    Tue 6 Oct 2026 · Dragonsteel · Penguin Random House         │
│    you follow · book 2 of a series you're 1 into               │
├────────────────────────────────────────────────────────────────┤
│  YOU MIGHT WANT TO FOLLOW                                  (6) │
│  ▸ The Salt Grows Heavy — Cassandra Khaw          Nov 2026     │
│    because you follow Gwendolyn Kiste —                        │
│    both in Other Terrors (2022) · both Tor Nightfire           │
│    [ Follow Cassandra Khaw ]  [ Not for me ]                   │
├────────────────────────────────────────────────────────────────┤
│  YOUR PEOPLE ARE WAITING FOR                               (3) │
│  ▸ …  — 4 people you follow have shelved this                  │
├────────────────────────────────────────────────────────────────┤
│  ANNOUNCED, NO DATE YET                                    (5) │
│  ▸ …  — 2026, no month recorded                                │
└────────────────────────────────────────────────────────────────┘
```

Four things this layout is doing deliberately:

1. **Every suggestion prints its reason, inline, in plain language.** Not a
   tooltip, not an info icon. This is S3 from [01](01-PREMISE.md) and it is the
   difference between this and every other recommender.
2. **The action on a suggestion is *follow the author*, not *add the book*.**
   The user's stated goal is discovering authors; a follow is a durable
   relationship that improves every future page, where an add is a one-off. It
   is also honest about what the system actually knows — it is confident about
   the *author*, not about that specific book.
3. **"Not for me" is as prominent as "Follow".** Negative feedback is the fastest
   way to make a recommender good and the easiest thing to under-build.
4. **Undated books get their own band and are never smuggled into a dated one.**
   The `Isles of the Emberdark` lesson from the Following page, applied here.

### Where it computes

Both, and the choice is the user's:

- **Server-side**, if the reader turned on *Contribute my shelf to
  recommendations*. Full scoring, all tiers, cached per user, cheap.
- **Client-side**, otherwise. The server ships the **similarity graph and the
  release calendar** — both of which are Canon, identical for everyone, and
  reveal nothing — and the browser scores them against the local IndexedDB shelf.
  Fewer tiers, a bigger download, and it works. This is what makes
  [01](01-PREMISE.md)'s P2 an actual design rather than a slogan.

---

## How to know whether it works

A recommender with no evaluation is a vibe. Three cheap measurements worth
building alongside it:

- **Held-out follow prediction.** Hide 20% of a user's author follows, see
  whether the graph surfaces them. Works offline, needs no users beyond the ones
  you have, and gives a single number that moves when you change weights.
- **Follow-through rate per basis kind.** Which evidence types actually convert —
  co-anthology vs imprint vs embedding? Almost certainly they differ by an order
  of magnitude, and the weights should be learned from that rather than guessed
  once and left.
- **Coverage.** What fraction of users get ≥5 explicable suggestions? If it is
  low, the answer is more Tier-1 sources, not a lower threshold.

---

## The honest failure modes

- **Cold start is total for Tier 2** and partial for Tier 1 — an author with a
  thin catalogue record has no edges at all. The page must degrade to "nothing to
  show yet, here is what's coming from who you follow" rather than padding.
- **Popularity collapse.** Every co-occurrence method converges on the bestseller
  list unless ubiquity is penalized. This is the most likely way this ships bad.
- **Filter bubble by construction.** A similarity graph shows you more of what
  you have. Worth one deliberate counterweight — a small, clearly-labelled
  *"outside your usual"* slot — rather than pretending the problem is not there.
- **Small-sample confidence.** At 200 users, "142 readers also shelved" becomes
  "3 readers also shelved", which is noise. **Print `n`, and suppress the
  behavioural tiers entirely below a threshold.** Better to show only Tier 1 for
  the first year than to launch with a number that is technically true and
  practically meaningless.
- **Author ≠ book.** Similar authors do not write uniformly similar books.
  Recommending the author is defensible; recommending *this specific forthcoming
  book* on author similarity alone is a weaker claim than the card implies. The
  copy should stay at the author level — which the mock above does, and which is
  a constraint on future copy edits rather than a one-time decision.
