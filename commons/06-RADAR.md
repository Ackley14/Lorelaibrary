# Radar — the upcoming-releases engine

`README.md` says of the current app: *"**Coming up** is a placeholder. Open
Library has no announcement flag, no street date and no publisher feed… There is
nothing honest to plot yet."*

That is a true statement about **one source**. With a server and four, there is.

**Radar works with a single user.** It requires no population, no collaborative
filtering and no cold start, which is why [01](01-PREMISE.md) puts it before the
recommender.

---

## What "upcoming" actually is

The current app already got the hard conceptual work right and it should be
carried over without dilution:

- A release has a **date and a precision** — `day | month | quarter | year | tba
  | unknown` — never a bare date (D6).
- A release is **in** a window when its own window fits *inside* the asked-for
  one, and **could fall here** when the two merely overlap. Under a plain overlap
  test, Open Library's bare `2026` for *Isles of the Emberdark* appeared under
  four of five windows at once, as though four things were happening.
- A **coarser** answer that agrees with a finer one is not information.
- `2026 → 2026-10-06` is **us learning something**, not a schedule change.
  `2026-10-06 → 2026` is **us knowing less**. Neither is news. A different year,
  or a different month inside a month, **is**.

Everything below assumes those rules; the server's job is to feed them better
data, not to replace them.

---

## The pipeline

```
  sources                    resolve                  observe               serve
┌───────────────┐        ┌──────────────┐      ┌──────────────────┐   ┌──────────┐
│ PRH  onsale   │──┐     │              │      │ release_         │   │  /radar  │
│ Google Books  │──┼────▶│  matchKey +  │─────▶│  observation     │──▶│  windows │
│ OL live/dump  │──┤     │  personKey   │      │  (append-only)   │   │  + moves │
│ NYT lists     │──┘     │  → edition   │      └──────────────────┘   └──────────┘
└───────────────┘        └──────────────┘               │
                                                        ▼
                                                ┌──────────────┐
                                                │ current view │
                                                │  = ratchet   │
                                                └──────────────┘
```

### Stage 1 · Poll, on a schedule tiered by volatility

The existing refresh scheduler (`js/48-sync.js`, badly named — it is the refresh
scheduler, not cloud sync) already tiers items by how likely they are to change:
*"a 1965 novel is not polled like a book due next week."* That policy moves to
the server essentially unchanged, and gets much more room:

| Tier | Poll | Why |
|---|---|---|
| Dated inside 60 days | daily | This is where dates move and where a move matters |
| Dated 60 days – 18 months | weekly | Announced, not imminent |
| `tba` / year-only, future | weekly | The undecidable band. Watching for a date to appear |
| Followed author, no forthcoming title | weekly | Watching for an *announcement* |
| Backlist | monthly, on the dump | It is not going to move |

Costed: a followed author currently costs "1 Open Library page + 3 Google slices
+ at most 6 targeted date lookups" per refresh, and a settled roster costs four
requests **[V 2026-08-03]**. Server-side, that cost is paid **once per author
across the whole population**, not once per author per user. Ten thousand users
following five hundred distinct authors is five hundred authors' worth of
polling. This is the single biggest efficiency gain of centralizing, and it is
worth saying out loud: **the current app's per-browser polling model does not
scale to a social product, and centralizing it makes it 100× cheaper rather than
100× more expensive.**

### Stage 2 · Resolve to an edition, with the existing folds

Four sources, no shared identifier. Google has no author ids and a volume id
names one printing; Open Library has OLIDs but its author-works docs carry no
ISBNs; PRH has its own ids and real ISBNs; NYT has a title and an author string.

The join is the one the app already uses: `BT.normalize.matchKey` for "same
book?" and `personKey` (`surname|first-initial`) for "same person?" — the latter
existing because a looser compare merged Google's *Dune* into **Brian** Herbert's
work record, which then took a 1990 printing date **[V 2026-08-03]**.

PRH's ISBNs are a gift here: they let a PRH title resolve to an Open Library
edition by primary key rather than by fold, which is strictly better than the
title-and-name join everywhere else. **Where an ISBN exists, use it; the fold is
the fallback, not the default.**

### Stage 3 · Record every observation, decide nothing

Append to `release_observation` ([03](03-DATA-MODEL.md)). Never update. The
"current" answer is a view that applies the ratchet across sources.

This is the structural fix for the bug the 2026-08-03 verification pass caught:
Google's author arms do not return a stable set for an identical query — *Boneset
& Feathers* came back on three refreshes and was missing from the fourth, the
union rebuilt from Open Library alone, and the stored `2020-11-03` was thrown
away and announced as `date moved: 2020-11-03 → 2020`. A book that had not moved,
reported as news, flapping every refresh.

Client-side that needed `keepSharpestDate` plus a containment test in both
directions. Server-side with an append-only log it cannot happen: **a source
going silent writes no row**, and a row that was never written cannot delete one
that was. The client-side guards should still be ported — belt and braces, and
they encode real knowledge — but the schema is what makes it safe.

### Stage 4 · Serve windows, not a list

`next week · this month · next month · end of year · next year`, containment and
overlap shown separately with their own counts, exactly as the Following page
does today. Plus the thing only a server can add: **a real calendar**, because we
now hold every dated forthcoming edition rather than only those belonging to the
twenty authors this one browser follows.

---

## What the reader sees

Four bands, each with a hard answer, never an ambiguous blank — the rule the
Following page already enforces:

**1 · Confirmed and dated.** A real day, from a source named on the card.
`Tue 6 Oct 2026 · Tor · from Penguin Random House`.

**2 · Announced, month known.** `October 2026 · day not recorded`. Rendered with
the day hatched, exactly as the app already draws a year-only date.

**3 · Announced, undated.** `2026, no month recorded` or `TBA`. Explicitly *not*
counted as upcoming in any window it does not contain, because that is the
`Isles of the Emberdark` failure.

**4 · Moved.** The event the whole feature exists for.
`Moved: 6 Oct 2026 → 14 Jan 2027 · was Google Books, now Penguin Random House`.
Both dates, both sources, and the observation timestamps — because a date change
on a book you are waiting for is the single most valuable notification this
product can send, and it is worth being able to prove.

And one band that only exists because we hold history:
**5 · Out now, and you were waiting.** The transition from future to past is a
notification, and today's app can only notice it if you happen to open it.

---

## Notifications — the thing hosting unlocks

`DECISIONS.md` deferred push because *"nothing runs while the app is closed"*.
Something does now.

Three channels, all opt-in, all off by default:

- **Web Push** — a service worker already exists and already handles install and
  precache. Adding push is a permissions prompt and an endpoint, not an
  architecture.
- **Email digest** — weekly, "here is what is coming in the next 30 days from
  people you follow". The highest-value, lowest-annoyance channel for a hobby
  app. This is the one to build first.
- **Calendar feed** — an authenticated `.ics` subscription URL. Your release
  radar in your own calendar app, updating itself. Cheap to build, and it is the
  kind of feature that makes people keep an account they otherwise forget about.

**Rule: notify on events, never on a schedule.** "Book X moved", "Book Y is out
today", "Author Z announced something" — all real events. "You haven't opened
BookTrak in a while" is not, and it is exactly the mechanic
[04](04-SOCIAL.md) rules out.

---

## Known limits, stated up front

- **Coverage is publisher-shaped.** PRH gives excellent forthcoming data for a
  quarter of US trade. The other three-quarters — and all of small press, which
  is disproportionately where a horror or weird-fiction reader lives — rely on
  Google Books happening to have catalogued the record. The radar will be
  visibly better for a Sanderson reader than for someone who follows a Word
  Horde author, and the interface should be honest about coverage rather than
  presenting a thin answer as a complete one.
- **Announcement lag is real.** A book announced on a publisher's blog or at a
  convention is not in any index for weeks. There is no fixing this without ONIX
  or Edelweiss, both of which are gated ([05](05-SOURCES.md)).
- **Markets differ.** A US on-sale date is not a UK one, and the current model
  has no market dimension at all. `release_observation.market` is in the schema
  for this reason; the UI needs a region preference, and until it has one every
  date is quietly assumed to be US and should say so.
- **Language.** `BT.lang` already keeps the undeclared and drops only a *declared*
  foreign language, for a verified reason — filtering server-side deletes exactly
  the thin, newly-catalogued records a forthcoming title always is
  **[V 2026-08-03]**. That policy must survive the port intact; it is subtle and
  it will look like a bug to whoever reimplements it.
- **Reprints and tie-ins masquerade as new books.** Google's top hit for `dune`
  is a 1990 printing, and on another run a 2023 *Movie Tie-In* **[V 2026-08-03]**.
  The `workDate` year gate exists for this. A radar without it announces
  *Dune* as a 2026 release.
