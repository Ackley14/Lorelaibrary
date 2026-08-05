# Sharing, and concurrent access

Two requirements that turn out to be one design:

1. **A library can be shared with someone.**
2. **Two people signed into one account at the same time must be fully
   supported** — both writing, both live, nothing lost, nobody kicked out.

---

## The model change: a library is a thing, not a property of an account

Today (and in [12](12-STORAGE.md) as first drafted) a shelf item belongs to an
*account*. That is the assumption that makes sharing hard, and it is worth
breaking now rather than after there is data in it.

```sql
library
  id            uuid pk
  name          text                     -- 'Shane's library' | 'The flat'
  kind          text                     -- personal | shared
  owner_id      uuid → account
  created_at, deleted_at

library_member
  library_id    uuid → library
  account_id    uuid → account
  role          role_t                   -- owner | editor | contributor | viewer
  joined_at, invited_by
  primary key (library_id, account_id)

shelf_item
  library_id    uuid → library           -- ← was account_id
  added_by      uuid → account           -- attribution survives sharing
  …
```

Every account gets a personal library at signup. Sharing is *adding a member*.
An account may belong to several libraries and switches between them with a
picker — the same shape as a workspace switcher, and users already understand it.

This single change gives you: household and partner libraries, a family shelf,
a book-club shelf, read-only guests, and — as a degenerate case — two people on
one account. It also means **attribution is preserved**: `added_by` on the item
and `actor` on every event, so a shared library can say *Sarah marked this
finished on Tuesday* rather than flattening two readers into one voice.

### Reading is personal even when ownership is shared

The one thing that must **not** be shared in a shared library:

```sql
reading_progress
  shelf_item_id uuid → shelf_item
  account_id    uuid → account
  position      int
  status        status_t
  rating        smallint
  primary key (shelf_item_id, account_id)
```

Two people in a household own one copy of a book and read it at different paces,
possibly years apart, and rate it differently. Collapsing that into one
`page_position` is wrong in an obvious, daily, infuriating way. **Ownership,
format, scope, edition and the sell pile are properties of the library.
Status, progress, rating, notes and the reading log are properties of
(library item × person).**

This also cleanly resolves the awkward case: the D9 pile axis stays on the
library (the household is selling the book), while D10's promote-on-progress
stays per person (you started it; your partner hasn't).

---

## Four ways to share

| Mode | Mechanism | Account needed | Can write |
|---|---|---|---|
| **Publish** | Visibility flags on the library ([04](04-SOCIAL.md)) | no | no |
| **Share link** | Capability URL — long random token in the path, role-scoped, expiring, revocable, rotatable | no | optional |
| **Membership** | Named account with a role | yes | per role |
| **Merged view** | A read-only union across two libraries you both belong to | yes | no |

**Merged view** is the underrated one. Two people who each want their own library
but also want to answer *"do we own this?"* and *"what do we both have?"* get a
union that dedupes by work, shows which library each copy is in, and highlights
the overlap. No merging, no migration, no argument about whose shelf it is. It
reuses the comparison view from [04](04-SOCIAL.md) with a different data source.

**Share links** need care: a capability URL is a bearer credential that will end
up in browser history, chat logs and screenshots. So — long token (≥128 bits of
entropy), scoped to one library and one role, optional expiry, listed in Settings
with last-used timestamps, individually revocable, and **never granting `owner`
or member management.** Rotate on demand.

---

## User access control

Four roles. Deliberately few — every additional role doubles the test matrix and
nobody has ever wanted the fifth.

| | viewer | contributor | editor | owner |
|---|:--:|:--:|:--:|:--:|
| Read the library | ● | ● | ● | ● |
| Read others' progress/ratings | ● | ● | ● | ● |
| Record own progress/rating/notes | | ● | ● | ● |
| Add books, scan | | ● | ● | ● |
| Edit items **they** added | | ● | ● | ● |
| Edit **any** item, set pile, delete | | | ● | ● |
| Create and edit shared lists | | ● | ● | ● |
| Invite / remove members, set roles | | | | ● |
| Rename, delete, transfer the library | | | | ● |

Enforced through the single `can(actor, action, resource)` seam from
[11](11-IDENTITY.md), never inline in a view.

Two rules that are not obvious:

- **`hidden` means two different things and needs two flags in a shared library.**
  `hidden_from_public` (excluded from the profile, activity and the recommender)
  is a library property. `private_to_actor` (nobody else in *this* library sees
  it) is a per-member property. Conflating them means someone's private reading
  is visible to their housemates the moment they share a shelf.
- **Removing a member does not delete what they added.** Items keep `added_by`
  pointing at an account that is no longer a member. The alternative — cascade
  delete — turns a housemate moving out into data loss.

---

## Concurrent access

> **Requirement: two sessions on one account, both writing, at the same time,
> fully supported.**

### What that rules out, explicitly

- ❌ "You've been signed out because you signed in elsewhere." Never. Sessions are
  independent and unlimited ([11](11-IDENTITY.md)).
- ❌ Any single-writer lock, device pairing, or "primary device".
- ❌ **Whole-document read-modify-write.** This is the killer, and it is what the
  current app does: two devices that both edit push a whole
  `library.enc.json`, and correctness depends entirely on a merge that runs
  minutes later. Two people editing live would routinely lose work.
- ❌ Last-write-wins at *record* granularity. If Sarah sets a rating while Shane
  sets a status on the same book, both must survive.

### The mechanism: a per-library mutation log

```sql
mutation
  id             bigint identity          -- monotonic. this IS the sync cursor
  library_id     uuid → library
  entity_type    text                     -- shelf_item | list | list_item | …
  entity_id      uuid
  field          text                     -- NULL for create/delete
  value          jsonb
  op             text                     -- set | add | remove | create | delete
  actor_id       uuid → account
  client_id      uuid                     -- which device
  idempotency_key text unique
  client_ts, server_ts
```

Everything follows from this one table:

- **Writes are field-level operations, not row replacements.** `set
  status='finished'` and `set rating=9` are independent mutations and cannot
  clobber each other.
- **`id` is the sync cursor.** A client catches up with
  `GET /libraries/:id/mutations?since=<cursor>`. Offline for a week? Same query.
- **It is the realtime feed.** `GET /libraries/:id/stream` (SSE) tails the same
  log. One mechanism for live updates, catch-up and offline replay — not three.
- **`idempotency_key` makes retries safe.** The offline outbox will retry; a
  duplicate key is a no-op returning the original result.
- **It is an audit log for free.** "Who marked this sold?" is a query.

### Conflict policy, per field kind

| Field kind | Policy | Why |
|---|---|---|
| Scalar library fields (`pile`, `format`, `edition_id`) | **LWW by `server_ts`**, actor recorded | Rare, and the last decision is the right one |
| Personal scalars (`status`, `rating`) | LWW **within `(item, account)`** | Two people cannot conflict — they have separate rows |
| `page_position` | LWW within `(item, account)`; **never max-wins** | You can legitimately go backwards; and it is per-person anyway |
| Set-valued (`genre_override`, tags) | **OR-Set** — `add`/`remove` ops, never array replacement | Array replacement silently drops a concurrent add |
| `notes` | LWW + **prior revision retained** + "edited by Sarah while you were typing" notice | Text CRDT (Y.js) is available if collaborative note editing ever becomes real; it is not worth the dependency yet |
| `reading_event` | **Append-only union.** Cannot conflict | Already how the app works |
| Deletes | Soft delete; a concurrent edit to a deleted item resurrects nothing but is recorded | Losing an edit silently is worse than a stale row |

### Optimistic concurrency and rebase

Each mutation carries the `base_version` the client believed. Server behaviour:

- `base_version` current → apply.
- Stale but the **field is untouched** since → apply anyway. This is the common
  case and it is why field-level operations matter: two people editing the same
  book almost never touch the same field.
- Stale and the **same field changed** → `409` with the current value and the
  actor. The client rebases and, for anything a human typed, *asks* rather than
  guessing.

### Presence

Cheap, ephemeral, Redis-backed with a short TTL, delivered on the same SSE
stream: *"Sarah is looking at this book."* Not required, disproportionately
reassuring in a shared library, and it prevents the two-people-editing-notes
collision by making it visible before it happens.

### Offline, with all of the above

The client keeps an **outbox** of unsent mutations with idempotency keys, applies
them locally on write (optimistic), and replays on reconnect. Because mutations
are field-level and idempotent, replay after a week offline is usually
conflict-free. The reading log — the highest-volume write, and the one most
likely to happen on a train — is append-only and can never conflict at all.

**What survives from the existing code:** the per-record merge, the deletion
tombstones and the reading-history union in `16-cloud.js` are the hard-won half
of this, and the reasoning behind them is directly reusable. What gets thrown
away is the transport — commit-a-JSON-file — which was never capable of
supporting two people at once and is the reason this requirement needs stating.

---

## The literal case: one account, two people

Fully supported, and it needs nothing beyond the above — concurrent sessions are
concurrent sessions whether or not they belong to the same human. Every session
is independent, nothing is evicted, and both devices see each other's writes
within the SSE round trip.

Two honest notes to put in front of anyone choosing it:

- **A shared account cannot attribute anything.** Every action is by the same
  identity, so `added_by` and the activity feed lose their meaning, and the
  per-person progress split above collapses. A **shared library with two
  accounts** gives everything a shared account gives *plus* attribution, separate
  reading progress, separate recommendations, and the ability to remove someone
  without changing a password. It should be the recommended path.
- **Sharing credentials is a security posture**, and passkeys make it awkward
  (they are per-device, though platform sync via iCloud or Google Keychain
  works). If a shared account is chosen anyway, the device list and per-session
  revoke in [11](11-IDENTITY.md) are what keep it manageable.

Both are supported. One is recommended. The product should say so once, at the
point of decision, and then get out of the way.
