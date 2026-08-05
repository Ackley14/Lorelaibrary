# Consolidation — how few hosts can this run on?

**Short answer: three vendors, and realistically that is the floor.** One host
does compute + database + cache + queues + storage; Cloudflare does domain, DNS,
TLS and CDN; a transactional email service does mail. Everything else in
[ARCHITECTURE.md](ARCHITECTURE.md) §3 is optional convenience, not structure.

This is possible because the architecture was constrained for it: Docker
containers, standard Postgres, the S3 API, and **pg-boss (queues inside
Postgres rather than a proprietary queue service)**. Nothing in the core path
needs a specific vendor.

---

## What genuinely cannot live on your one box

Four things, and only four. Each is a real reason, not a preference.

| | Why not | Cost |
|---|---|---|
| **DNS + CDN + DDoS** | Self-hosting DNS works and buys nothing. Cloudflare's free tier gives you TLS, a global cache for covers, DDoS absorption and origin-IP concealment for £0 | **$0** |
| **Transactional email** | **Never self-host SMTP.** A fresh IP has no sending reputation, and magic-link auth means a mail that lands in spam is a user who cannot log in. This is the single most common self-hosting mistake | **$0–20/mo** |
| **Backups** | A backup on the machine it protects is not a backup. It must be in a different provider's failure domain | **$1–5/mo** |
| **Uptime monitoring** | A monitor running on the box cannot tell you the box is down | **$0** |

Everything else — API, workers, cron, Postgres, Redis, object storage, search,
the whole warehouse — runs on one machine comfortably at this scale.

---

## Two shapes, and which to pick when

### Shape A · One PaaS (recommended to start)

One vendor, one dashboard, one bill, **zero server administration**.

```
Render  (or Railway / Fly.io)
├── web        static site           ← the SPA
├── api        web service           ← Node/Fastify
├── worker     background worker     ← pg-boss consumers
├── cron       scheduled jobs        ← enrichment, maintenance
├── ingest     one-off job           ← monthly dump, run on demand
├── postgres   managed, PITR included
├── redis      managed key-value
└── disk       persistent volume     ← covers, before they need a CDN
      +
Cloudflare (free)  ·  Resend (free tier)  ·  Backblaze B2 or R2 (backups)
```

**Cost:** ~$25–60/mo at prototype/small scale. **Ops burden:** essentially nil —
no patching, no firewall, no TLS renewal, no backup scripting.

Render is the strongest single-vendor story for this shape: services, workers,
cron, Postgres, Key Value and persistent disks all in one place, with custom
domains and automatic TLS. **Fly.io** is the close second and has one advantage
worth noting — **Tigris**, S3-compatible object storage integrated as a
first-party service, which Render and Railway both lack.

**The gap:** no managed object storage on Render/Railway. For covers at this
scale a persistent disk is genuinely fine; put Cloudflare in front and it caches
globally anyway.

### Shape B · One box (when the bill bites)

```
Hetzner dedicated (AX-series) — approximate specs and pricing, verify current
├── Ryzen, 64 GB RAM, 2 × 1 TB NVMe (RAID1)          ~€45–70/mo
└── Coolify or Dokploy (Docker Compose with a UI)
    ├── caddy          reverse proxy, automatic TLS
    ├── api ×2         Node containers
    ├── worker         pg-boss consumers
    ├── postgres 16    + pgvector, tuned, WAL archiving on
    ├── redis          bound to the private network only
    ├── minio          S3-compatible object storage (or just a disk)
    └── grafana/loki   metrics + logs, optional
      +
Cloudflare (free)  ·  Resend  ·  Backblaze B2 (pgBackRest target)
```

**Cost:** ~€50–75/mo total, covering roughly what $325–1,090/mo of managed
services would in the "Real" column of [ARCHITECTURE §12](ARCHITECTURE.md).
The saving is real and large. **Ops burden:** yours.

---

## The sizing question that actually decides this

Worth being concrete, because an earlier draft of this file got it wrong in a way
that changed the recommendation.

**The wrong version.** Open Library's dumps are ~10.5 GB (editions), 3.5 GB
(works), 0.5 GB (authors) compressed — roughly 110 GB of JSON uncompressed.
Exploded into per-record JSONB rows with indexes, that is ~150 GB, and with the
conformed and canonical layers on top it reaches **250–400 GB** of Postgres. That
number is what pushed toward dedicated hardware.

**It was self-inflicted.** There is no reason to unpack an archive in order to
store the archive. The `.txt.gz` files *are* byte-faithful, they are what the
ingest streams anyway, and they cost about a dollar a month to keep.

### What it actually is

| | Where | Size |
|---|---|---|
| Monthly dump snapshots | Object storage, as downloaded | ~15 GB/mo; keep 3 + one per year ≈ **60 GB** (~$1/mo) |
| API-fetched records (Google, PRH, targeted lookups) | Postgres JSONB — incremental, per-record | **a few GB** |
| Conformed + canonical catalogue, with indexes | Postgres | **~60–100 GB** |
| **User data** — every account, library, item, reading event and mutation at ~5,000 users | Postgres | **~5–10 GB** |
| Covers | Object storage | 20–60 GB, content-addressed so duplicates store once |

**Postgres lands at roughly 70–120 GB.** That is comfortable on a mid-tier
managed plan *and* on a cloud VPS — so Shape A stays viable much longer than the
wrong number suggested, and Shape B no longer needs dedicated hardware purely for
disk.

### The one sizing trap left

**Do not embed the whole corpus.** 30M works × 1024 dimensions × 4 bytes is
**~120 GB of vectors**, which would dwarf everything else in the database.

Embed only works that are actually reachable — those in a tracked author's
bibliography or on somebody's shelf — which is a few million, not thirty. At 512
dimensions in `halfvec` (fp16), 3M works is about **3 GB**. Backfill more only
when a coverage metric says the cold-start tier is missing real candidates.

Note also that user data — the thing that must never be lost, and the thing whose
restore time actually matters — is **under 1% of the total**. That is worth
exploiting: back it up separately and far more often than the catalogue, which is
rebuildable from a public URL.

---

## Major issues with going single-host

Honest list. None are disqualifying at this scale; all are real.

**1 · No high availability.** One box means downtime for kernel updates, and
hours-to-days for a hardware failure. Mitigation is mostly *acceptance* — this is
a book app, not a payments system — plus a written RTO, a tested restore, and
a status page. If that is not acceptable, Shape A's managed Postgres already
gives you failover.

**2 · You are your own noisy neighbour.** A 15 GB ingest competing with the API
for IO will be felt. Mitigations: systemd slices / cgroup limits on the ingest
container, schedule it at low traffic, and — best — the Parquet change above,
which moves the heaviest write out of Postgres entirely. Or burst a €5 machine
for the monthly run and tear it down.

**3 · Backups become existential rather than automatic.** Managed Postgres gives
PITR by default; self-hosted needs **pgBackRest or WAL-G shipping WAL to object
storage**, configured deliberately. Done properly this is *better* than most
managed defaults. Done as an afterthought it is the way you lose everything.
**Quarterly tested restore is not optional in Shape B.**

**4 · Security is yours.** SSH keys only, root login disabled, `ufw` allowing
only 80/443, Postgres and Redis bound to localhost or a private network,
unattended-upgrades on, fail2ban. That is an afternoon to set up and near-zero to
maintain — but it is an afternoon that must actually happen.

**5 · Scaling is vertical.** Fine to several thousand users; Hetzner sells much
bigger boxes cheaply. Beyond that you split, which is a project.

**6 · Realistic time cost:** ~2–4 hours a month when nothing is wrong, and an
unbounded evening when something is. That is the honest trade for the ~$300/mo
saving.

---

## Recommendation

**Start on Shape A. Move to Shape B when you have measured a reason.**

The reason to start managed is not that self-hosting is hard — it is that you
have a warehouse, an ingest pipeline, entity resolution and a social product to
build, and none of that gets easier while you are also learning what your
Postgres `shared_buffers` should be. Shape A lets the whole system be built
without ever touching a firewall rule.

The reason this is safe advice is that **the migration between them is genuinely
small**: identical containers, identical Postgres, identical S3 API, queues that
live inside the database. A weekend, not a rewrite. That portability was the
point of the constraint, and this question is the payoff.

**Vendor count either way: 3.** Host · Cloudflare · email. Plus a few dollars of
object storage for backups, which can be Cloudflare too — making it arguably 2½.

---

## The domain name

Yes — this is separate from hosting, and you need one. It is also the cheapest
and simplest part of the whole plan.

**Register at Cloudflare Registrar.** They sell at wholesale cost with no markup,
no first-year-discount-then-triple pricing, no upsells, and WHOIS privacy
included. A `.com` is roughly **$10–12/year**. The only condition is using
Cloudflare's nameservers — which you want anyway for the free CDN and DDoS
protection. Porkbun and Namecheap are fine alternatives; avoid GoDaddy.

**On the TLD:**

- `.com` — still the default. Assume the good ones are taken.
- `.app` and `.dev` — Google-operated and **on the HSTS preload list**, so
  browsers refuse plain HTTP to them at all. That is a genuine, free security
  property and it fits a project that already cares about this sort of thing.
- `.co`, `.club`, `.page`, `.ink`, `.press` — plausible and usually available.
- `.io` — expensive (~$40–60/yr) and has had real registry-level uncertainty.
  Not worth it.
- `.book` — owned and operated by Amazon as a brand TLD. Not available.

**What the domain also gets you, at no extra cost:**

- **Cloudflare Email Routing (free)** — `hello@yourdomain` forwarded to your
  existing inbox. Receiving only, which is all you need.
- Sending (`noreply@`, magic links) goes through Resend or Postmark, with
  **SPF, DKIM and DMARC records** set on the domain. Get DMARC right on day one;
  retrofitting it after mail starts landing in spam is miserable.
- A stable identity independent of every host above. Changing hosts becomes a DNS
  change rather than a migration announcement.

**Total domain cost: ~$12/year**, and it is the one line item in this entire
dossier where the right answer is unambiguous.
