# Social

## The shape: a library with a feed attached

Goodreads is a feed with a library bolted on. StoryGraph is a stats engine with a
feed bolted on. The opening in the market is the third thing: **the library
itself as the social object.**

A profile in Commons is not a wall of activity cards. It is a **shelf**, rendered
with the index tree BookTrak already has — five statuses, twelve genres, three
formats, both piles, counts down the left, sortable by added / title /
publication / rating / progress / genre. You browse someone else's library the
way you browse your own, with the same keyboard shortcuts, because it is the same
view with a different data source.

That is the whole product thesis in one sentence, and it falls out of an
architectural fact: `62-view-list.js` and `55-tree.js` already render a library
from a repo query. Point them at a *different user's* published shelf and the
feature is mostly done.

---

## The surfaces

### 1 · Profile = shelf

The default view of a person. Their tree, their counts, their sort. Plus a header
that is deliberately thin: handle, display name, one-line bio, book count, follow
button. **No follower count in the header.** It becomes the score people play
for, and this app has no reason to have a score.

Two things a Goodreads profile cannot do, which this one can, because of D2 and
the scope model:

- **Edition-level shelves.** "I own the 1990 Ace paperback" is a different
  statement from "I have read *Dune*", and BookTrak is the only tracker that
  already knows the difference (`scope: 'open'` vs `'closed'`). A shelf can be
  browsed as a *collection* — actual covers of actual printings someone owns —
  and that is a genuinely new social object. Book collectors have no good home on
  the internet.
- **The sell pile as a public surface, optionally.** D9 keeps "have I read it"
  and "do I still own it" on separate axes. Publishing the *to sell* pile turns
  a data model quirk into a feature nobody else has: a browsable list of books
  real people near you are about to get rid of. Flagged as an idea, not a
  proposal — it drags in messaging, location and commerce, which is a different
  product.

### 2 · Comparison

Land on a profile and the most useful thing is not their whole library, it is the
delta. `You and Alex · 41 books each · 12 in common · they rate Kiste 9, you rate
her 7`. Three tabs: **overlap**, **theirs not yours**, **yours not theirs**. The
middle one is the recommendation engine that needs no machine learning and no
population, and it is available on day one of the social layer.

### 3 · Lists, first-class and forkable

Lists are the main creative act on a book platform and every existing product
treats them as an afterthought. Here they are a real object:

- **Ordered or unordered**, declared at creation. "My top 20 horror novels" and
  "Books about grief" are different shapes and should not be the same widget.
- **Annotated per entry.** A one-line note against each book is the difference
  between a list and a pile.
- **Edition-aware.** A list of *specific printings* — cover art, cloth,
  translations — is a thing that cannot be made anywhere else.
- **Forkable, with lineage.** Copy a list, keep a pointer to its parent, and show
  `forked from @alex · 14 of 20 kept`. Attribution is automatic, remixing is
  encouraged, and the "who made this first" fight never happens.
- **Collaborative**, with `editor` and `suggester` roles. Suggester is the
  important one — it lets a list owner accept contributions without handing over
  the keys, which is how a genuinely good community list gets built.
- **Shareable by link without an account**, bearer-token, unlisted. A list you
  can text to someone who does not use the app is how the app gets used.

### 4 · Activity, with the existing discipline

The current Activity view is unusually honest: it says "newly listed in this
catalogue" rather than "new release", because that is exactly what was observed.
That discipline transfers directly:

- `Alex finished Wind and Truth` — an event they created. Report it.
- `Alex rated Wind and Truth 9` — same.
- `Alex added 41 books` — **collapse it.** An import is one event, not 41. The
  current app already knows this problem: the follows migration would have
  reported every book of every followed author as new, at once, and the fix was
  to re-baseline silently. Same rule, different door.
- No `Alex is reading…` for a book they have not touched in five months.

Feed generation is **fan-out-on-read** (see [03](03-DATA-MODEL.md)). You follow
tens of people, not thousands; the query is cheap and correctness beats a cache.

### 5 · Reading together

Not book clubs — a paced read. Two or more people, one book, an agreed pace, and
a shared progress bar built from the reading log BookTrak already keeps by page
number. Spoiler-gating falls out naturally: comments are attached to a page
number and hidden until you have passed it. That is a real feature that the
existing append-only progress log makes almost free, and no competitor has it
because none of them record position at page granularity by default.

### 6 · Following authors, now with a population

Author follows already exist and are already keyed on OLID rather than name — for
the verified reason that `?author=gwendolyn+kiste` returns Laird Barron's books.
Multi-user adds one thing: **`n` other readers follow this author.** That is both
a social signal and, per [07](07-FORYOU.md), the single strongest input to author
similarity.

---

## Visibility

Default **private**. Every object carries its own visibility
(`private | link | followers | public | unlisted-public`), evaluated at read
time, never denormalized.

Three states a person can be in, all first-class:

- **Quiet** — an account exists, sync works, nothing is published, nobody can
  find you. This must be fully supported and not second-class, because it is the
  state every current BookTrak user is in today and upgrading them into a social
  network without asking would be a betrayal.
- **Selective** — profile public, some lists public, shelf visible to followers,
  specific books hidden.
- **Open** — everything public, discoverable, indexed.

**Per-book hiding is required, not optional.** People read about illness, grief,
abuse, faith and sex, and a shelf that cannot hide one book without hiding all of
them will simply not be published. One toggle in the detail pane; it also
excludes the book from activity and from the recommendation projection.

**Follow requests** for followers-only shelves, and **block** and **mute** as
distinct actions — block severs both directions and hides content mutually; mute
is one-directional and silent. Getting these two confused is a standard,
serious, and avoidable harm.

---

## Moderation — the part that is easy to forget until it is a crisis

Multi-user means user-generated content: display names, bios, avatars, list
titles, list notes, review bodies. That is a content-moderation obligation from
the first public account, not from the thousandth.

**Minimum viable, before any public launch:**

| | |
|---|---|
| Report | on every account, list, review and list note. Routed to a queue a human reads |
| Block / mute | distinct, as above |
| Rate limits | account creation, follows, list creation, review posting. Per-account and per-IP |
| Deletion | account deletion that actually deletes, within a stated window, with export first |
| Retention | activity rows expire; they are a feed, not an archive |
| Age gate | a self-declared minimum age at signup. Under-13 signups are a COPPA problem in the US and a UK Children's Code problem in the UK, and "we didn't know" is not a defence |
| Appeal | a suspended account gets told why and can reply |

**Spam is the specific threat.** A book platform with public lists and public
reviews is an SEO target the day it is indexable. Two cheap structural defences:
new accounts' content is `unlisted-public` (reachable, not indexed) until some
trivial threshold, and outbound links in review bodies are `nofollow` and
rendered as text for new accounts.

**Ratings brigading** and **review-bombing** are the other known failure mode.
Mitigation is not an algorithm, it is a display choice: show the distribution
rather than a single average, show `n`, and let a reader weight their own network
above the global number. The For You page should default to
*people you follow* over *everyone*.

---

## What we deliberately do not build

Stating these now is cheaper than removing them later.

- **No engagement feed.** No algorithmic ranking of your friends' activity, no
  "you might have missed", no infinite scroll. Chronological, bounded, done.
- **No streaks, no reading challenges as a default.** A yearly goal is fine as an
  opt-in stat. A streak is a mechanic for making people feel bad about a hobby.
- **No public follower counts as a leaderboard.**
- **No AI-written reviews or blurbs presented as content.** Machine summarization
  as a *tool* the reader invokes on their own shelf is fine; synthetic review
  text in a social feed is a lie about a person's opinion.
- **No DMs in v1.** Direct messaging is a whole moderation product on its own —
  harassment, CSAM reporting obligations, retention law. Comments on lists and
  paced reads cover the real need. If DMs ever ship, they ship with a dedicated
  safety plan.
- **No "Goodreads import" without a plan.** People will ask for it immediately.
  Goodreads' CSV export is the only route (no API), it is edition-poor, and
  matching 800 rows of free-text title/author against Canon is a genuine
  engineering project with a visible failure mode. Worth doing — see
  [08](08-OPEN.md) — but it is a project, not a checkbox.

---

## Federation: raised, and deferred

**BookWyrm** is an existing federated (ActivityPub) book-tracking network. The
honest assessment:

- **For:** it is philosophically aligned, it would let Commons users follow
  people who never sign up, and it sidesteps the cold-start problem for the
  social graph.
- **Against:** ActivityPub is a large implementation surface, federated
  moderation is materially harder than local moderation, and BookWyrm's book
  identity model is its own — reconciling it with Canon's work/edition graph is
  the same two-catalogue merge problem `70-follows.js` already fights, with a
  third catalogue.

**Recommendation: design the activity model so it *could* be ActivityPub-shaped
— actor, verb, object, visibility, which is exactly the schema in
[03](03-DATA-MODEL.md) — and do not implement federation in v1.** Keeping the
door open costs nothing today. Walking through it costs a quarter.
