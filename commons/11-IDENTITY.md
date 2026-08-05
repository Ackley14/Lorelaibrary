# Identity

Authentication, sessions, authorization, and the account lifecycle.

**The governing decision: do not build password authentication, and do not store
password hashes.** Owning credential storage is the largest liability a small
team can take on voluntarily, it is completely undifferentiated, and every
serious failure mode (stuffing, reuse, reset-token leakage, timing oracles,
rehashing on parameter upgrades) is somebody else's solved problem. Use OIDC.

This also happens to dissolve the "two secrets" problem invented in
[03](03-DATA-MODEL.md): with no passphrase-derived encryption, there is one
identity and one login.

---

## Authentication

### Protocol

**OpenID Connect, authorization code flow with PKCE.** The browser is a *public
client* — it cannot hold a client secret, and PKCE is what makes that safe. No
implicit flow, no password grant, both are dead for good reasons.

### Methods offered, in the order they should appear

1. **Passkey (WebAuthn)** — first-class and first-listed. It is 2026, platform
   support is universal, and it removes phishing and reuse in one move. The
   existing app already depends on WebCrypto, so the audience's browsers are
   already capable.
2. **Sign in with Google** — the default for most people.
3. **Sign in with Apple** — *mandatory* if a native iOS app ever ships alongside
   any other social login. Cheaper to add now than to retrofit.
4. **Email magic link** — the no-account-elsewhere path, and the recovery path.
5. **GitHub** — the audience skews technical and it costs nothing.

No password field anywhere. If someone insists, the answer is a magic link.

### Provider

| Option | Verdict |
|---|---|
| **Better Auth** (self-hosted library, in our own API) | **Recommended.** Passkeys, OAuth providers, magic links, sessions, MFA; data lives in our Postgres so `account` joins natively to everything else; no per-MAU bill; no vendor lock. Cost is that we own the upgrade treadmill |
| **Supabase Auth** | Strong second, and the right call *if* Supabase is also the database — auth, RLS and storage in one bill. Ties identity to a vendor |
| **WorkOS AuthKit** | Best managed option; generous free tier, excellent enterprise path if that ever matters |
| **Clerk** | Best DX, opinionated UI, gets expensive |
| **Auth0 / Okta** | Overkill and overpriced here |
| **Keycloak / Ory / Zitadel** | Self-hosted heavyweights. More operational surface than the whole rest of this system |

**Recommendation: Better Auth inside the API service.** The deciding factor is
that `account` is joined against on nearly every query in this product (feeds,
lists, visibility, follows), and an external identity provider makes that a
cross-system join or a sync problem. Keep identity in the same database as the
data it authorizes.

### Sessions

- **Opaque server-side session, delivered as a cookie.** Not a JWT in
  `localStorage` — that is XSS-exfiltratable and cannot be revoked.
- Cookie attributes: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`. `Lax` is correct because OAuth callbacks are top-level GETs.
- Session record in Postgres (`session`), Redis as a read-through cache so the
  hot path is not a DB round trip. **Postgres is authoritative** so revocation is
  immediate and durable.
- Sliding expiry: 30 days idle, 180 days absolute.
- **A device list in Settings** with per-session revoke and "sign out
  everywhere". Shows user agent, approximate location, last seen.
- Re-authentication required for sensitive actions: changing email, deleting the
  account, revoking other sessions, generating an API token.

### Non-browser clients

If a native app, CLI or the `.ics` calendar feed ([06](06-RADAR.md)) needs auth:

- **Personal access tokens**, scoped, prefixed (`btc_pat_…`), stored as a hash,
  shown once, individually revocable, with `last_used_at`.
- The calendar feed specifically gets a **capability URL** — a long random token
  in the path, scoped to exactly one read operation, revocable, and rotatable —
  rather than a session. Calendar clients cannot do OAuth.
- Service-to-service (workers → API, if ever needed): mTLS or a signed
  short-lived token from the secret manager. Never a shared static key in an env
  file.

### Bot and abuse defence at the front door

Cloudflare Turnstile on signup and magic-link request. Per-IP and per-email rate
limits on link sends. Disposable-domain denylist, applied as friction rather than
a hard block. Email verification required before any content is publishable —
this single rule kills most spam economics.

---

## Authorization

### The seam

One module, one function, called everywhere:

```ts
can(actor: Actor, action: Action, resource: Resource): Decision
```

This is the `BT.repo` lesson applied to authz: **views never touch `BT.db`**
worked because there was exactly one seam. Authorization is the same shape of
problem and fails the same way when it leaks — a single view that checks
visibility inline is the one that will still be exposing private shelves in two
years.

### Model

Relationship-based, not role-based. The questions this product asks are
"is the actor the owner / a follower / a collaborator / blocked?", which is
ReBAC, not RBAC. It does not need Zanzibar/OpenFGA at this scale — it needs a
small hand-written policy module with exhaustive tests, and the option to adopt
one later without changing call sites.

Visibility resolution rules, restated because they are easy to get wrong:

- Evaluated **at read time**, never denormalized into activity rows. A list made
  private later must not leave exposed rows behind.
- **Block is bidirectional and content-hiding**; **mute is one-directional and
  silent**. Distinct actions, distinct tables, never conflated.
- Per-object visibility: `private | link | followers | public | unlisted-public`.
- **Per-book hiding** overrides shelf visibility, and also excludes the book from
  activity, from the recommendation projection, and from aggregate counts.

### Row-level security

If Supabase Postgres: use RLS, and treat it as **defence in depth behind the
policy module**, not as the primary mechanism. RLS is excellent at making a
whole class of bug impossible and poor at expressing "followers of the owner,
unless blocked, unless the item is hidden". Write the policy in the API; let RLS
catch the mistake.

If not Supabase: skip RLS, use a single connection role, and rely on the policy
module plus tests. A `SELECT` that forgets `account_id` should fail a lint rule
and a test, not be caught in production.

---

## Account lifecycle

### Signup

**Let people use the product before they sign up.** The app works fully
locally — search Canon, build a shelf, scan books — with no account, storing
into IndexedDB. Signing up *claims* that shelf and pushes it up. This is the
single largest conversion lever available and it is nearly free here, because
local-first machinery already exists.

Handle chosen at claim time, not at first launch.

### Handles

- Unique, case-folded, `[a-z0-9_]{3,24}`, reserved denylist (`admin`, `support`,
  `api`, `about`, `settings`, `login`, every route name).
- Changeable, with a **90-day cooldown**, and the old handle is **held, not
  released** — it 301s to the new one for a year and cannot be claimed by anyone
  else in that window. Handle squatting and drive-by impersonation are the two
  things this prevents, and both are unfixable after the fact.
- The handle is the identity. Display name is free text and is therefore an
  impersonation vector: wherever a display name appears in a trust context — a
  review byline, a list author, a follow request — the handle appears with it.

### Email changes

New address verified *before* the change commits; a notification sent to the old
address with a revert link valid for 72 hours. Account-takeover via email change
is the standard path and this is the standard defence.

### Export

Already a strength of the project and now a legal obligation (GDPR Art. 20).
Machine-readable JSON, the complete account: shelf, reading log, lists, reviews,
follows, settings. Generated async, delivered as a signed R2 URL with a 7-day
expiry. **Not** including derived recommendation state — that is ours, not
theirs, and including it invites a re-identification argument.

### Deletion

Three-stage, and the middle stage is what stops support tickets:

1. **Soft delete.** Account marked deleted, sessions revoked, content removed
   from all public surfaces immediately, handle held.
2. **30-day grace.** Signing in restores everything. Stated plainly at deletion
   time.
3. **Hard purge.** Rows deleted; `shelf_signal` pseudonym rows deleted; object
   storage purged; backups age out naturally within the stated retention window
   (say so in the privacy policy — "backups are purged within 35 days" is honest
   and defensible; "instantly deleted everywhere" is a lie).

Content by a deleted account: reviews and public list contributions are deleted,
not orphaned to "[deleted]". This is a book app, not a forum; nothing depends on
the thread staying coherent. A *forked* list keeps its own copy and loses only
the attribution link, which is the correct outcome.

### Suspension and appeal

Suspended accounts are told which rule and given a reply path. An
appeal queue that nobody reads is worse than no appeal path, so this scales with
willingness to do moderation work — which is a real, ongoing, human cost and one
of the honest reasons to keep the social layer small at first.

---

## What this costs the user, compared to today

Today: one passphrase, no account, nothing recoverable if forgotten, and a
library that is genuinely unreadable by anyone including us.

After: one login they probably already have (Google/Apple/passkey), full
recovery, and **a database we can read**. That last clause is the real trade and
it should be stated plainly in the privacy policy rather than buried:

> Your library is stored on our servers in a form we can read. We need to, in
> order to search it, recommend against it, and send you release alerts. It is
> private to your account, it is never sold, and you can export or delete all of
> it at any time.

That is an ordinary, honest posture for a hosted product. The alternative — E2E
encryption — makes server-side search, recommendations, notifications, moderation
and support impossible, which is to say it makes the product in this dossier
impossible. It was the right answer for a public git repository and it is the
wrong answer here.
