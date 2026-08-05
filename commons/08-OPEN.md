# Open

Risks, phasing, and the questions that have to be answered by someone rather than
assumed by a document.

---

## Phasing

Ordered so that **every phase ships something usable on its own** and no phase
depends on a population it does not have. Each is reversible until the one after
it starts.

### Phase 1 · Canon — no accounts, no social, no new UI

Stand up Postgres, ingest the Open Library dumps, expose `/canon` (search, work,
editions, author), repoint `BT.net` at it.

**User-visible change: search gets faster and better, and nothing else.** No
sign-up, no server-side account, no data leaves the browser that didn't before.
The app still works from `file://` if you point it back.

Why first: it is the largest quality win in the whole plan, it is entirely
reversible, it requires zero product decisions, and it is worth doing **even if
every other phase is cancelled.** If you build one thing from this dossier, build
this.

*Ships:* a catalogue we own. *Needs:* a host, a DB, an ingest pipeline, changes
to ~4 of 30 JS files.

### Phase 2 · Accounts and real sync

Retire the GitHub-token sync (which, per `README.md`'s own bold warning, hands
every synced device write access to the site's source). Replace with
authenticated blob storage holding the same ciphertext from the same
`15-crypto.js`. Add the account layer described in [03](03-DATA-MODEL.md).

*Ships:* sync that isn't a security footgun. *Needs:* the two-secret decision
made and its UX designed — this is the hardest *product* problem in the plan.

### Phase 3 · Commons — profiles, lists, follows

Profile-as-shelf, forkable lists, asymmetric follows, comparison view,
chronological activity. Moderation minimums from [04](04-SOCIAL.md) land here,
not later. This is where a build step and ES modules become worth taking.

*Ships:* the social product. *Needs:* a ToS, a privacy policy, a moderation
queue, and someone willing to read it.

### Phase 4 · Radar

PRH + NYT wired in, `release_observation` populated, windows, moves, the email
digest and the `.ics` feed. Works for a single user, so it could technically move
ahead of Phase 3 — and **should**, if the social layer stalls.

*Ships:* the feature the current app calls a placeholder.

### Phase 5 · For You

Tier 1 and Tier 3 similarity, client-side scoring by default. Tier 2 switched on
only when the population passes a threshold that gets decided in advance and
written down, not eyeballed.

*Ships:* the thing the user asked for. *Needs:* Phases 1, 3 and 4.

---

## Legal and terms exposure

Ranked by how likely each is to actually bite.

### 1 · Google Books terms — the paid-tier clause **[verified 2026-08-04]**

> *"You may not charge users any fee for the use of your application, unless you
> have entered into a separate agreement with Google or obtained Google's written
> permission."*

The app currently depends on Google Books as its **primary** source. A
subscription tier would violate this as written. Three routes: don't charge
(affiliate revenue from Bookshop.org/Libro.fm is not a user fee); ask Google;
or reduce Google to a non-essential enrichment so a paid product doesn't depend
on it. **This needs deciding before any monetization thinking, not after.**

### 2 · Google Books terms — caching and database-building **[unresolved]**

The Books-specific terms page is silent on retention; the restrictions live in
the general **Google APIs Terms of Service**, which was *not* read for this
document. The architecture here already assumes the conservative answer —
Canon is built from open corpora, Google is a live enrichment behind a short
cache — but that assumption is load-bearing and untested. **Read the general ToS
before Phase 2.**

### 3 · Cover images

Publisher art, copyrighted, served by Open Library and Google for identification.
Storing it permanently at scale is a DMCA surface; Google additionally serves it
over `http://` with a fake page curl burned into the pixels. Proposal: proxy with
bounded TTL, never re-publish, attribute, honour takedowns, keep the generated
bookcloth fallback. **Not a settled answer.**

### 4 · Open Library licensing **[verify]**

Believed CC0/open for bibliographic records, which is what makes Canon legal.
This is the foundation of the entire plan and it is currently *believed* rather
than *read*. Confirm the licence on the dumps specifically, and confirm whether
attribution obligations attach to derived works.

### 5 · The spirit of constraint 4

`README.md`: *"Open Library is a free service run by a non-profit that explicitly
asks not to be used as a backend for high-traffic applications."* Ingesting the
dumps is the technically sanctioned answer — it is the mechanism they publish for
exactly this. But a hosted product built on their corpus should behave like a
good citizen regardless: attribute prominently, contribute corrections upstream
where the app derives them, and consider donating. This is a values question, and
the project has been unusually principled so far; it would be a shame to lose
that at the moment it starts to matter.

### 6 · Multi-user obligations

Privacy policy, ToS, GDPR/UK-GDPR (data export already exists, which is a real
head start; deletion needs to actually delete), CCPA, COPPA and the UK Children's
Code for under-13s, DSA notice-and-action if EU users are in scope, and — the one
people forget — **a named data controller**, which means a real legal entity
behind the product. Personal side projects can hold user data; they just can't
pretend that's a technical question.

### 7 · Hardcover and PRH terms **[unverified]**

Both are free APIs from organisations with their own interests. Hardcover is a
direct competitor whose docs returned 403 to automated fetch; PRH's docs are
ageing and the API's maintenance status is unconfirmed. Neither should be
load-bearing, and both should be read before being wired in.

---

## Risks that aren't legal

**The rewrite trap.** The most likely way this fails is not technical: it is
starting a from-scratch React/Next rewrite because the app "needs a real
framework now", and losing 28,000 lines of hard-won, verified, documented
behaviour — the precision ratchet, the four ISBN namespaces, the credit check,
the language filter, the containment tests — in the process. Almost none of that
knowledge is recoverable from a clean-sheet rewrite; it was all *found*, by
measurement, and most of it looks like over-engineering to someone who wasn't
there. **The phasing above is designed to make each step small enough that the
rewrite temptation never gets a foothold.**

**Local-first is easy to lose by accident.** The moment one view calls the server
directly instead of going through `BT.repo`, offline breaks — quietly, on
someone else's phone, months later. Worth an actual lint rule, not just a
convention.

**Two implementations of `matchKey`.** Called out in [03](03-DATA-MODEL.md) and
worth repeating: the normalizer must be one module running in both places. The
failure mode is a duplicate row no call site can explain, which is the same class
of bug `70-follows.js` already documents.

**Cold start on the social side.** A social product with eleven users is a ghost
town, and a ghost town is worse than no social features at all. Mitigations:
lists shareable by link *without an account* (so they're useful to send to
non-users), the comparison view working with a single friend, and the Radar
being genuinely valuable solo.

**Cost of the monthly ingest going unnoticed.** 15 GB of gzip through a pipeline
that runs unattended is the classic $400 surprise. Cap it, alarm it, and run it
on an ephemeral worker rather than the API box.

**Ops burden on a one-person project.** GitHub Pages has no pager. A Postgres
with real users does. This is a genuine lifestyle change and the honest reason
many good local-first apps stay local-first.

---

## Open questions — the ones a document cannot decide

1. **Is this one product or two?** Commons could be a *separate* app that
   BookTrak syncs into, keeping BookTrak exactly as it is. That preserves
   everything and costs a second front-end. Or it is the same app with a server
   behind it. Genuinely unclear which is right, and it changes almost every
   answer above.
2. **Two secrets or one?** Encrypted shelf + account is philosophically correct
   and a real usability cost. Is the E2E property worth a second thing to
   remember, for this audience?
3. **Does MovieTrak come along?** The two apps share an origin, a palette, a
   genre taxonomy value-for-value, and half the architecture. A shared Canon
   service and a shared social layer across books *and* films is either the best
   idea in this dossier or a doubling of scope. It is not addressed anywhere
   above and it probably should be.
4. **What is the population threshold** below which Tier-2 similarity stays off?
   Pick a number now, in the open, before the temptation to ship it early.
5. **Goodreads CSV import — Phase 3 or never?** Everyone will ask. It is the
   single biggest onboarding lever and a real matching project with a visible
   failure mode (800 rows of free-text title/author against Canon). It also
   arrives edition-poor, which collides with D2 and the whole scope model.
6. **Region and market.** Every date in the app today is implicitly US-or-
   whatever-the-source-said. A social product with UK users needs
   `release_observation.market` to be real, and needs a preference for it.
7. **Who is this for?** The current app is built for one person with strong
   opinions, and it is excellent because of that. Products for one person and
   products for thousands are designed differently, and the tension shows up
   first in the moderation and defaults sections. Worth answering deliberately
   rather than discovering.

---

## The one-line recommendation

**Build Phase 1.** It is weeks of work, it touches four files, it is fully
reversible, it makes the existing app measurably better for its existing user,
and it is the prerequisite for everything else in this folder. Every other phase
can then be decided on its own merits, with a real catalogue already in hand
rather than a plan.
