# Data model

> ⚠ **Superseded by [12-STORAGE](12-STORAGE.md), [13-WAREHOUSE](13-WAREHOUSE.md)
> and [14-SHARING](14-SHARING.md).** The E2E-encrypted Shelf and the two-secrets
> model are abandoned — they existed to make a *public git repository* a safe
> sync target. **What survives:** the Canon / user-data / published-data
> separation as a conceptual split, the append-only release-observation idea, and
> the requirement that similarity edges carry a `basis`.

Three layers with three different owners, three different privacy postures and
three different scaling problems. Mixing them into one schema makes all three
worse.

```
CANON     shared, server-owned, public, huge, read-mostly
          works · editions · people · series · subjects · releases · similarity

SHELF     per-user, private by default, small, write-heavy, LOCAL-FIRST
          items · reading events · follows · settings          [ciphertext]

COMMONS   per-user, explicitly published, small, read-heavy
          profile · lists · reviews · social follows · activity  [plaintext]
```

---

## Canon

Canon is a **derived** database. Nothing in it is authored by a user, everything
in it can be rebuilt from sources, and the rebuild is a supported operation
rather than a disaster-recovery story. That property is what makes it safe to be
aggressive with it — you can drop and re-ingest.

### The core tables

```sql
work            -- the thing "Dune" is
  id            text primary key      -- 'olw:OL27482W' | 'gbw:<hash>'
  title, sort_title, subtitle
  first_pub_year int, first_pub_precision
  subjects      text[]                -- raw, from OL + BISAC from Google
  genre_ids     text[]                -- derived through the D7 rule table
  series_id, series_index
  ol_key, wikidata_qid
  subject_vec   vector(1024)          -- pgvector, see 07-FORYOU

edition         -- the 1990 Ace paperback
  id            text primary key      -- 'ole:OL…M' | 'gbv:<volumeId>' | 'isbn:978…'
  work_id       references work
  isbn13, isbn10, asin
  publisher, imprint                  -- imprint is the taste signal, not publisher
  format, pages, language
  cover_ref
  release_date, release_precision     -- day|month|quarter|year|tba|unknown
  release_sort_key

person          -- an author
  id            text primary key      -- 'ola:OL7481853A' | 'gbp:<slug>'
  display_name
  person_key    text                  -- surname|first-initial  (the D-verified fold)
  gb_names      text[]                -- every exact string Google has printed
  ol_key, wikidata_qid
  aliases       text[]                -- incl. transliterations: Френк Герберт

credit          -- work ↔ person, many-to-many, with a role
  work_id, person_id, role            -- author | editor | translator | contributor
  ordinal

identity        -- the server-side idIndex. THE most important table here.
  namespace     text                  -- olwork|oledition|isbn13|isbncand|gbvolume|asin
  value         text
  target_kind   text                  -- work|edition|person
  target_id     text
  confidence    text                  -- claimed|candidate|verified
  primary key (namespace, value, target_id)
```

`identity` is the direct descendant of `js/12-repo.js`'s `idIndex` and it carries
over D2 *verbatim*, because D2 is the load-bearing decision in the app and it
does not become less true with a server: **`isbn13:` is an ownership claim and
`isbncand:` is a possibility.** Verified in `DECISIONS.md`: 12 of the first 200
Hobbit editions have an ISBN-13 claimed by more than one edition record, and 13%
of its 481 editions have no ISBN at all. Server-side, arbitration gets *easier*
(one writer, one transaction) but the rule must not change, or the scanner starts
resolving to the wrong copy for everyone at once instead of for one person.

### The release table is append-only

```sql
release_observation
  id            bigserial
  edition_id    references edition
  market        text            -- 'US' | 'GB' | 'CA' | …
  date          date
  precision     text            -- day|month|quarter|year|tba
  source        text            -- googlebooks|openlibrary|prh|isbndb|nyt|user
  observed_at   timestamptz
  supersedes    bigint null
```

Never `UPDATE`. Every observation is a row, and the *current* answer is a view
that applies the precision ratchet (S2) across sources. This is what makes
"*Wind and Truth* moved from 2024-12-06 to 2025-01-14" a real, defensible,
auditable statement instead of a diff against a value we overwrote — and it is
the fix for the exact bug the 2026-08-03 pass found, promoted from a client-side
guard to a schema property.

The ratchet as a rule over this table:
- a **coarser** observation that *contains* the finer one we hold is not
  information — recorded, not surfaced;
- a **finer** observation *inside* what we hold is us learning something —
  recorded, surfaced as a sharpening, not as a move;
- an observation that **contradicts** (different year, different month inside a
  month) is the event the whole feature exists for — recorded, surfaced as a
  move, with both dates and both sources named.

### Similarity, materialized

```sql
author_similarity
  a_id, b_id    references person
  score         real
  basis         jsonb    -- [{kind:'co_anthology', weight:.4, evidence:'Other Terrors (2022)'}, …]
  computed_at
  primary key (a_id, b_id)
```

`basis` is not decoration. S3 says never a confident answer the source cannot
support, and the For You page is required to print *why* — so the evidence has to
be carried, per edge, from the job that computed it. A similarity table without a
basis column forces the UI to say "Recommended for you", which is the one thing
[01](01-PREMISE.md) rules out. See [07](07-FORYOU.md).

---

## Shelf

**Shape unchanged.** The item model in `js/10-db.js` and `js/12-repo.js` — `uid`,
`user.{status,rating,notes,progress,pile,addedAt,updatedAt}`, `release.*`,
`facets.*`, `idx.*`, `tracking.*`, `meta.manualOverrides` — is good, is
well-reasoned, and survives intact. What changes is where a *copy* of it lives.

**IndexedDB stays the truth for the device you are on.** The server is a peer
that holds the merge target. That is exactly the relationship `16-cloud.js`
already implements against a git repository, and the merge semantics carry over
unchanged: newer edit per record wins, tombstones honoured, reading history
unioned, refuse to publish over a file we cannot read.

### The encryption problem, and its resolution

D14 says: no password stored anywhere, not even a hash; AES-GCM's auth tag
failing *is* the login. Multi-user needs a durable account identity — an email to
recover, a handle other people follow, a row to attach a profile to. Those two
cannot both be absolute.

**The split:**

| | Key material | Server can read? |
|---|---|---|
| **Account** — email, handle, display name, avatar | ordinary auth (passkey / OAuth / email+password with Argon2id) | yes |
| **Commons** — profile, lists, reviews, follows | account-scoped | yes, necessarily |
| **Shelf** — items, notes, ratings, progress, log | passphrase → PBKDF2 → AES-256, unchanged | **no** |

Two secrets, and that is a real cost to state plainly: **the user has a login
*and* a library passphrase, and losing the second still loses the library.** The
alternative — deriving the shelf key from the account password — hands the server
the plaintext on every login and quietly deletes D14.

Mitigations that keep it humane rather than hostile:
- The passphrase is only required on a *new device*, then the unwrapped key is
  held in IndexedDB per device, as now.
- Offer **key wrapping to a passkey** — the shelf key encrypted under a
  WebAuthn-derived secret — so the second factor is a biometric rather than a
  second thing to memorize. The server still stores only wrapped key material.
- Offer, explicitly and with the cost stated, an **unencrypted shelf**. Some
  people do not want two secrets to track what they read. It should be a choice
  with a printed consequence, not a default and not an impossibility.

### The recommendation projection

If — and only if — the user turns on *Contribute my shelf to recommendations*,
the client emits a minimal plaintext projection:

```sql
shelf_signal
  pseudonym_id  uuid        -- NOT account_id. Rotatable. Not joinable to profile.
  work_id
  signal        text        -- shelved | finished | rated_high | dropped
  observed_at   date        -- day precision, deliberately not timestamp
```

No notes, no exact ratings, no reading log, no title, no ordering, no link to a
handle. This is the collaborative-filtering input and nothing else. Rotating the
pseudonym breaks the history-linkage; dropping the toggle deletes the rows.

Why `dropped` is included: an abandoned book is the strongest negative signal in
the entire dataset and almost no book platform collects it. BookTrak already
does, as a first-class status. That is a genuine, unexploited asset.

---

## Commons

```sql
account       id, handle, display_name, avatar_ref, bio, created_at,
              locale, is_suspended
profile_prefs id, shelf_visibility, list_default_visibility,
              activity_visibility, discoverable, contributes_signals

social_follow  follower_id, followee_id, state         -- 'following'|'blocked'|'muted'
               created_at
               -- asymmetric. mutual follow is derived, not stored.

list           id, owner_id, title, description, visibility,
               share_token, is_ordered, forked_from, item_count, updated_at
list_item      list_id, position, work_id, edition_id null, note, added_at
list_collab    list_id, account_id, role                -- 'editor'|'suggester'

review         id, account_id, work_id, edition_id null, rating, body,
               contains_spoilers, visibility, created_at, edited_at

activity       id, actor_id, verb, object_kind, object_id,
               visibility, created_at
               -- verb: shelved|finished|rated|reviewed|listed|forked|followed
```

### Visibility is per object, and it has five values

`private` · `link` (unlisted, bearer token) · `followers` · `public` ·
`unlisted-public` (reachable, not indexed, not in discovery).

Two rules that are easy to get wrong and expensive to fix later:

1. **Visibility is evaluated at read time, never denormalized into the feed.**
   If a list's visibility is copied into activity rows at write time, then making
   a list private later leaves the old rows exposed. Fan-out-on-read is fine
   here: a library-first app has readers following tens of people, not hundreds
   of thousands, so the feed query is cheap and correctness beats a fan-out cache
   nobody needs yet.
2. **A shelf item's visibility is a property of the *shelf*, not of the item** —
   with a per-item override for exactly one case: hiding a specific book. People
   will want that (health, grief, a genre they are private about), and it must be
   possible without making the whole shelf private.

### Handles and the impersonation surface

`handle` is unique, case-folded, and reserved against a denylist. Display name is
free text and is therefore an impersonation vector; a display name is never the
identity, the handle is, and the UI must show the handle wherever the display
name appears in a trust context (a review byline, a list author, a follow
request). This is boring and it is the thing every social product regrets not
doing on day one.

---

## Where the normalizer lives

`js/38-normalize.js` — dates and precision, genre derivation, ISBN handling,
`matchKey`, `personKey`, `pickRelease`, `workDate` — must run in **both** places:

- **Server**, during ingest and enrichment, because that is where two catalogues
  get reconciled at scale.
- **Client**, because local-first means a scan writes immediately without asking
  anyone, exactly as D13 requires.

Two implementations is two answers to "same book?". The fix is to extract it as a
shared, dependency-free module consumed by both — which in practice means it is
the first thing that has to stop being a `BT.*` global and start being a real
module. That is a small, self-contained, high-value refactor that could be done
**today**, inside the current app, with no server anywhere, and it would make
Phase 1 much cheaper.
