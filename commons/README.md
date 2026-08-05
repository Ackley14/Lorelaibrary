# Commons

A hypothetical. This folder is **documentation only** — no code is proposed to be
written from it yet, and nothing in it changes BookTrak.

**The premise:** take BookTrak — a local-first personal library with honest
publication dates, real edition handling and a barcode scanner — put it on a
real server, give it accounts and shared libraries, and let people see each
other's shelves. Goodreads' social surface with BookTrak's obsession about what a
book actually is, on top of a book database we own rather than rent.

`Commons` is a working codename, not a name. Replace it when a real one turns up.

---

## Start here

**[ARCHITECTURE.md](ARCHITECTURE.md)** — the consolidated top-to-bottom systems
summary. Languages, hosting, auth, API and networking, access control, storage,
jobs, observability, security, cost, build order. If you read one file, read that
one.

**[INBOX.md](INBOX.md)** — running capture of ideas as they arrive, with where
each one landed. Add to it freely.

---

## The documents

### Current design

| | | |
|---|---|---|
| **[10](10-REARCHITECTURE.md)** | **Re-architecture** | What in BookTrak is a GitHub-Pages artifact (delete it) versus domain knowledge (keep every word). The worked example: why the four ISBN namespaces stop existing |
| **[11](11-IDENTITY.md)** | **Identity** | OIDC, passkeys, sessions, authorization seam, account lifecycle, deletion |
| **[12](12-STORAGE.md)** | **Storage** | The schema, storage tiers, caching, search, vector, files, backup |
| **[13](13-WAREHOUSE.md)** | **Warehouse** | Multi-source ingestion and cleaning. Three zones, field-level provenance, quality gates, gap-filling, outage resilience |
| **[14](14-SHARING.md)** | **Sharing** | Libraries as first-class entities, members and roles, share links, and full concurrent multi-session write |
| **[16](16-CONSOLIDATION.md)** | **Consolidation** | Running on as few hosts as possible, the sizing that decides it, and the domain name |
| **[17](17-SPLIT.md)** | **The split** | Line-by-line: what of the 28,000 lines is product, what is scaffolding for having no server |

### Product design — unaffected by the re-architecture

| | | |
|---|---|---|
| **[04](04-SOCIAL.md)** | **Social** | Profile-as-shelf, forkable lists, feed, visibility, moderation, what we deliberately don't build |
| **[05](05-SOURCES.md)** | **Sources** | Fourteen data sources: what each gives, costs, and forbids |
| **[06](06-RADAR.md)** | **Radar** | The upcoming-releases engine. Works with zero users |
| **[07](07-FORYOU.md)** | **For You** | Author similarity in four tiers, and the page it feeds |
| **[08](08-OPEN.md)** | **Open** | Legal exposure, risks, unresolved questions |

### Superseded

| | | |
|---|---|---|
| ~~[01](01-PREMISE.md)~~ | Premise | Written on a *port the existing architecture* premise. **[10](10-REARCHITECTURE.md) replaces it.** The "what must survive" list is still useful; its P1/P2 decisions about encryption and local-first truth are not |
| ~~[02](02-ARCHITECTURE.md)~~ | Architecture | **[ARCHITECTURE.md](ARCHITECTURE.md) replaces it.** Its "the port is smaller than it looks" seam analysis still holds |
| ~~[03](03-DATA-MODEL.md)~~ | Data model | **[12](12-STORAGE.md) + [13](13-WAREHOUSE.md) + [14](14-SHARING.md) replace it.** Its E2E-encryption and two-secrets design is abandoned |

---

## The five-sentence version

**Own the data.** Ingest Open Library's monthly bulk dumps plus Google, Penguin
Random House, NYT and Wikidata into a three-zone warehouse — landing, conformed,
canonical — that cleans on arrival, records field-level provenance, and gates
every promotion on quality checks, so that *no user-facing request ever depends
on an external API being up, correct or fast.*

**Delete the constraint artifacts.** The passphrase encryption, the GitHub-token
sync, the whole-file blob merge, IndexedDB-as-truth, the four ISBN namespaces and
the no-build script ordering are all brilliant answers to *"how do I run a
database with no server and a public repo as my only storage"* — a question that
stops existing the moment there is a server.

**Keep the domain knowledge.** Work ≠ edition, precision as a two-way ratchet,
never a confident answer the source cannot support, status ⊥ ownership, author
identity by ID never by name, and every row of `DECISIONS.md`'s verified tables.
That knowledge is worth more than the code; the code is a delivery mechanism
for it.

**Make the library a first-class entity**, with members, roles and a per-library
append-only mutation log — which gives sharing, household libraries, offline
sync, live updates and fully concurrent multi-session writing from one mechanism.

**Then build discovery**, which is the only thing multi-user unlocks that no
vendor will sell you: other people's shelves are the similarity graph
`DECISIONS.md` correctly refuses to fake today.

---

## Two things to know before reading

**This folder deploys.** It sits in a repository GitHub Pages serves from root.
`.md` files aren't rendered, but they *are* fetchable at
`ackley14.github.io/Lorelaibrary/commons/…`. If any of this should be private, it
belongs in a different repository.

**Nothing here is verified the way `DECISIONS.md` is verified.** That file earns
its authority by naming a request and printing the response. This is a design
proposal. API facts checked live on 2026-08-04 are marked **[R]**; facts carried
over from `DECISIONS.md` are marked **[V]**. Everything else is an argument, and
where an unverified claim is load-bearing it says so in those words.
