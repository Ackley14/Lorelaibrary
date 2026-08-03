/* ══════════════════════════════════════════════════════════════════════════
   Network layer — the ONLY place in the app that calls fetch().

   Everything upstream goes through `BT.net.get()`, which gives us one place to
   put the rate limiter, the response cache, retries, the request budget and —
   most importantly — the error classifier. That last one matters more than it
   sounds.

   Open Library is an unusually honest API right up until something goes wrong,
   at which point it stops speaking JSON. Ask for an ISBN it does not hold and
   `/isbn/9780000000002.json` answers HTTP 404 with `content-type: text/html`
   and a rendered "not found" PAGE. Hand that body to `.json()` and what comes
   back is a bare SyntaxError — the same exception you get from a truncated
   download — so the user is told "malformed response" when the truth is "we
   don't have that book". Untangling that is `classify()`, and it is why the
   `res.ok` check below is load-bearing rather than tidy.

   The second thing this file exists to hold is the real rate policy, because
   we are not in a position to negotiate for the good one. Open Library grants
   roughly 3 req/s to clients that identify themselves and roughly 1 to
   everyone else, and a browser is structurally incapable of identifying
   itself — see the User-Agent note by the buckets. So the limiter here refills
   slower than NET_POLICY's headline number, on purpose.
   ══════════════════════════════════════════════════════════════════════════ */

BT.net = (function () {

  /* Human-readable source names for anything that reaches a UI string.
     MovieTrak could get away with `source.toUpperCase()` because RAWG and OMDb
     are how those services spell themselves. 'OPENLIBRARY' is not a name
     anybody uses, and a budget warning is not the place to invent one. */
  const LABEL = {
    openlibrary: 'Open Library',
    covers: 'Open Library covers',
    googlebooks: 'Google Books',
  };
  const label = s => LABEL[s] || s;

  /* ── Token bucket ─────────────────────────────────────────────────────────
     `rate` is the sustained refill in tokens per second; `burst` is the
     ceiling the bucket may accumulate to. MovieTrak's version carried a single
     number because every source it spoke to published a single figure. Open
     Library publishes two, and the gap between them is the whole subject of
     the next comment, so the two roles are split here. */
  class Bucket {
    constructor(rate, burst) {
      this.rate = rate;
      this.burst = Math.max(rate, burst || rate);
      this.rps = rate;                 // alias: the leak test reads `.rps`
      this.tokens = this.burst;
      this.last = Date.now();
    }
    /* `n` is how many upstream requests this call actually costs — see
       costOf(); a redirect that fetch follows for us is still two requests as
       far as the server's limiter is concerned. Clamped to the burst ceiling
       because a demand larger than the bucket can ever hold would spin here
       forever waiting for a token that cannot arrive. */
    async take(n) {
      const need = Math.min(Math.max(1, n || 1), this.burst);
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
        this.last = now;
        if (this.tokens >= need) { this.tokens -= need; return; }
        await BT.util.sleep(Math.max(20, ((need - this.tokens) / this.rate) * 1000));
      }
    }
  }

  /* ── The User-Agent we are not allowed to send ────────────────────────────
     Open Library asks API clients to identify themselves and rewards it: their
     documentation puts identified clients at about 3 requests/second and
     anonymous ones at about 1. We would happily comply — `contactEmail` exists
     in BT.config for exactly this — and we cannot.

     `User-Agent` is a FORBIDDEN request header. fetch() does not reject it, it
     silently drops it, so the code reads as though it works while the server
     sees nothing but the browser's own UA. There is no way around that from a
     page, and any library claiming otherwise is running outside a browser.

     The obvious workaround — carry the contact in a custom header instead — is
     worse than useless here. Any non-safelisted header promotes a simple GET
     into a preflighted one, and Open Library answers OPTIONS with the
     NON-STANDARD singular `access-control-allow-method`. The browser looks for
     the spec's plural `access-control-allow-methods`, does not find it, fails
     the preflight, and a request that worked perfectly a moment ago never
     leaves the machine. Verified. So: send NOTHING extra to openlibrary.org or
     covers.openlibrary.org. Not an Accept, not a contact, nothing.

     Which makes 1 request/second the honest sustained budget, and that is what
     the bucket refills at. NET_POLICY's `rps` is kept as the BURST ceiling, so
     a screen that needs three things at once still gets them at once; it just
     cannot hold that pace. userAgent() is built anyway so that a non-browser
     host (a Node importer, an Electron shell) has one place to read it from,
     and so Settings can show the user precisely what we would send if we
     could. */
  const SUSTAINED_RPS = {
    openlibrary: 1,
    /* covers.openlibrary.org is a separate service with a separate documented
       cap: 100 requests per IP per 5 minutes, which is 0.33/s sustained. Note
       that <img src> loads do NOT pass through here — the browser issues those
       directly and this limiter never sees them — so this only governs code
       that deliberately routes a cover through BT.net, such as a prefetch or
       an existence check. That code should be rare, and this rate is the
       reason why. */
    covers: 0.33,
  };

  function userAgent() {
    const email = String((BT.config.get('contactEmail') || '')).trim();
    return email ? `Lorelaibrary (${email})` : 'Lorelaibrary';
  }

  /* Sources that must receive a completely bare request. See above. */
  const NO_CUSTOM_HEADERS = new Set(['openlibrary', 'covers']);

  /* Sources that actually emit `Retry-After`. Open Library never does — not on
     429, and not on the 503s it serves during read-only maintenance windows —
     so parsing the header there yields 0 on every attempt and quietly implies
     a contract we do not have. Backoff against Open Library is therefore
     blind: full-jitter exponential and nothing else. Google's APIs do send it,
     and when they do it is authoritative, so it is still honoured there. */
  const SENDS_RETRY_AFTER = new Set(['googlebooks']);

  /* ── Concurrency lane ─────────────────────────────────────────────────── */
  class Lane {
    constructor(max) { this.max = max; this.active = 0; this.queue = []; }
    acquire() {
      if (this.active < this.max) { this.active++; return Promise.resolve(); }
      return new Promise(res => this.queue.push(res));
    }
    release() {
      const next = this.queue.shift();
      if (next) next();            // hand the slot straight on, count unchanged
      else this.active = Math.max(0, this.active - 1);
    }
  }

  const buckets = {}, lanes = {}, circuits = {};
  for (const [src, p] of Object.entries(BT.NET_POLICY)) {
    buckets[src] = new Bucket(SUSTAINED_RPS[src] || p.rps, p.rps);
    lanes[src] = new Lane(p.concurrency);
    circuits[src] = { fails: 0, openUntil: 0 };
  }

  /* ── Request cost ─────────────────────────────────────────────────────────
     One call to get() is not always one request upstream.

     `/isbn/{isbn}.json` is a 302 to `/books/OL…M.json`. fetch() follows it
     transparently, so from in here it looks like a single round trip — one
     Response object, one entry in the network panel — but Open Library served
     TWO requests and its limiter counted two. Undercounting by half on the
     single most-used endpoint in a barcode-scanning app is how you get quietly
     throttled and never work out why, so the ISBN path declares its real cost
     and pays for it out of the bucket. */
  function costOf(source, url) {
    if (source !== 'openlibrary') return 1;
    try { return /^\/isbn\//i.test(new URL(url).pathname) ? 2 : 1; }
    catch (_) { return 1; }
  }

  /* ── Request budgets ──────────────────────────────────────────────────
     These are SELF-THROTTLES, not a view of the real quota. Google Books
     counts per key, and the key lives in one browser's settings — this counter
     can only ever see requests made from this browser. The UI must say
     "requests from this browser", never "remaining quota".

     Open Library has no budget at all (nulls in NET_POLICY) because it
     publishes a RATE, not a quota; the bucket is the whole enforcement there
     and budgetWindows() correctly returns nothing for it. */
  const budgetCache = {};

  /* A source can be capped on more than one window at once — a monthly ceiling
     with a daily sub-cap under it, so one bad afternoon cannot spend the whole
     month. Every applicable window must have room. */
  function budgetWindows(source) {
    const p = BT.NET_POLICY[source];
    const out = [];
    if (!p) return out;
    if (p.dailyBudget) out.push({ key: `req:${source}:${BT.util.todayStamp()}`, cap: p.dailyBudget, period: 'day' });
    if (p.monthlyBudget) out.push({ key: `req:${source}:${BT.util.monthStamp()}`, cap: p.monthlyBudget, period: 'month' });
    return out;
  }

  async function loadWindow(w) {
    if (budgetCache[w.key] == null) budgetCache[w.key] = (await BT.repo.metaGet(w.key)) || 0;
    return budgetCache[w.key];
  }

  /* `units` is costOf()'s answer: a redirecting lookup spends two. */
  async function budgetTake(source, units) {
    const n = Math.max(1, units || 1);
    const windows = budgetWindows(source);
    if (!windows.length) return true;
    for (const w of windows) {
      if ((await loadWindow(w)) + n > w.cap) return false;
    }
    for (const w of windows) {
      budgetCache[w.key] += n;
      BT.repo.metaSet(w.key, budgetCache[w.key]);   // fire and forget
    }
    return true;
  }

  /* Refund units consumed by a request that never reached the network — a
     circuit-open short-circuit, an abort, a cache race. Without this the
     budget drifts down every time the app has a bad day. */
  async function budgetRefund(source, units) {
    const n = Math.max(1, units || 1);
    for (const w of budgetWindows(source)) {
      if (budgetCache[w.key] == null) continue;
      budgetCache[w.key] = Math.max(0, budgetCache[w.key] - n);
      BT.repo.metaSet(w.key, budgetCache[w.key]);
    }
  }

  /* Reports the window closest to exhaustion, which is what a gauge should
     show. Null for a source with no budget — Open Library, always. */
  async function budgetState(source) {
    const windows = budgetWindows(source);
    if (!windows.length) return null;
    let worst = null;
    for (const w of windows) {
      const used = await loadWindow(w);
      const frac = used / w.cap;
      if (!worst || frac > worst.frac) worst = { used, cap: w.cap, period: w.period, frac };
    }
    return worst;
  }

  /* ── Errors ───────────────────────────────────────────────────────────── */
  class NetError extends Error {
    constructor(kind, message, opts) {
      super(message);
      this.name = 'NetError';
      this.kind = kind;            // offline | auth | quota | notfound | server | opaque | budget | abort | parse
      Object.assign(this, opts || {});
    }
    get retryable() { return this.kind === 'server' || this.kind === 'quota-soft'; }
  }

  /* Is this response a WEB PAGE rather than a record?

     Open Library serves its error states as rendered HTML — a 404 for a
     missing ISBN, a 503 during a maintenance window, and occasionally a 200
     when a URL resolves to a browsable page instead of a `.json` document.
     Reading `content-type` is safe cross-origin: it is one of the four
     CORS-safelisted RESPONSE headers, so no `access-control-expose-headers`
     cooperation is needed and this works on every response we can see at all. */
  function looksLikeHtml(res) {
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    return ct.indexOf('text/html') >= 0 || ct.indexOf('application/xhtml') >= 0;
  }

  /* Does the machine believe it has a network at all? navigator.onLine is
     famously optimistic — it reports true for a laptop attached to a router
     with no uplink — so an actual request is the only honest test.

     openlibrary.org is the target because it is the app's primary source: if
     it cannot be reached there is nothing left to be optimistic about. Two
     deliberate choices in how it is asked:

       `mode: 'no-cors'` — we do not need to READ the answer, only to learn
       that one arrived. An opaque response still resolves the promise, while a
       genuinely dead network still rejects it. That keeps the probe honest on
       exactly the error pages and redirects that carry no CORS headers, which
       is the situation the probe gets called in.

       `method: 'HEAD'` on the origin root — no body, no query, no search index
       touched. Open Library asks not to be used as a backend for automated
       traffic and search.json is their most expensive endpoint; spending one
       on a health check would be both rude and slow. */
  let lastProbe = { at: 0, ok: null };
  async function probeInternet() {
    if (Date.now() - lastProbe.at < 15000) return lastProbe.ok;
    let ok = false;
    try {
      const r = await fetch('https://openlibrary.org/', {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store',
      });
      ok = !!r;                    // even an opaque response proves we got out
    } catch (_) { ok = false; }
    lastProbe = { at: Date.now(), ok };
    return ok;
  }

  /* Turn a failure into something a human can act on. Always async —
     uniformly, for every source — because a classifier that returns a Promise
     for some sources and a value for others produces the subtlest possible
     bug: `!err.retryable` on a Promise is always false. */
  async function classify(source, err, res) {
    if (err && err.name === 'AbortError') return new NetError('abort', 'Request cancelled');

    if (res) {
      const s = res.status;
      const html = looksLikeHtml(res);
      if (s === 401 || s === 403) return new NetError('auth', `${label(source)}: key rejected`, { status: s });
      /* The commonest failure in the whole app, and the one that must never
         reach the user as a parse error: a 404 here is an HTML page, and it
         means the catalogue simply has no record for that ISBN or OLID. That
         is an answer, not a fault. */
      if (s === 404) return new NetError('notfound', `${label(source)}: no such record`, { status: s, html });
      if (s === 429) {
        /* Only read the header from a source that emits one — see
           SENDS_RETRY_AFTER. `parseInt(null, 10)` is NaN and NaN > 0 is false,
           so the fallback is already the blind-backoff path. */
        const ra = SENDS_RETRY_AFTER.has(source)
          ? parseInt(res.headers.get('retry-after') || '0', 10)
          : 0;
        return new NetError('quota-soft', `${label(source)}: rate limited`, { status: s, retryAfter: ra });
      }
      /* 5xx from Open Library is also an HTML page — their maintenance banner.
         It is still a server error and still retryable; the `html` flag just
         stops anything downstream trying to read a message out of the body. */
      if (s >= 500) return new NetError('server', `${label(source)}: upstream error ${s}`, { status: s, html });
      return new NetError('server', `${label(source)}: HTTP ${s}`, { status: s, html });
    }

    /* No response object at all — the browser refused before we could read it. */
    const online = await probeInternet();
    if (!online) return new NetError('offline', 'You appear to be offline.');

    if (source === 'openlibrary' || source === 'covers') {
      /* MovieTrak had a genuine three-way ambiguity here, because RAWG's
         errors came back through Cloudflare with no CORS headers and a dead
         key looked exactly like a dead network. Open Library does not have
         that problem: every endpoint we touch sends
         `access-control-allow-origin: *`, and there is no key to be wrong
         about. So if the probe says the network is up and the request still
         died, the remaining explanation is that openlibrary.org itself is
         unreachable — it goes read-only or 503s during database maintenance,
         which is by far the likeliest cause and is nothing the user can fix. */
      return new NetError('opaque',
        source === 'covers'
          ? 'Could not reach the Open Library cover service. Covers are capped at 100 requests per five minutes per address, so this can also mean a large library view asked for too many at once — it will recover on its own.'
          : 'Could not reach Open Library. It is most likely down or in a maintenance window; nothing is wrong with your setup, and the app will keep serving what it already has.',
        { source, actionable: false });
    }
    if (source === 'googlebooks') {
      const hasKey = BT.config.hasKey('googlebooks');
      return new NetError('opaque',
        !hasKey ? 'No Google Books key is set, so enrichment is switched off. Open Library alone runs the whole app.'
        : 'Could not reach Google Books. The key may be wrong, restricted to another referrer, or its project may have Books disabled.',
        { source, actionable: true });
    }
    return new NetError('opaque', `Could not reach ${label(source)}.`, { source });
  }

  /* ── Circuit breaker ─────────────────────────────────────────────────── */
  function circuitOpen(source) { return Date.now() < circuits[source].openUntil; }
  function circuitTrip(source) {
    const c = circuits[source];
    if (++c.fails >= 4) {
      c.openUntil = Date.now() + 60000;
      c.fails = 0;
      console.warn(`[net] circuit open for ${source} (60s)`);
    }
  }
  function circuitReset(source) { circuits[source].fails = 0; circuits[source].openUntil = 0; }

  /* ── Cache key ────────────────────────────────────────────────────────
     Credentials are stripped before the key is built, so no key is ever
     written to IndexedDB and rotating a key does not invalidate the whole
     cache. Open Library contributes nothing to strip — it is keyless — but
     Google Books puts the key in `?key=`, and without this a user pasting a
     replacement key would silently orphan every enrichment payload they had
     already paid for. */
  function cacheKeyFor(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('api_key');
      u.searchParams.delete('key');
      u.searchParams.delete('apikey');
      u.searchParams.sort();
      return u.origin + u.pathname + '?' + u.searchParams.toString();
    } catch (_) { return url; }
  }

  /* ══ The one request path ══════════════════════════════════════════════ */
  async function get(source, url, opts) {
    opts = opts || {};
    const policy = BT.NET_POLICY[source] || BT.NET_POLICY.openlibrary;
    const ck = cacheKeyFor(url);
    /* `work` is the default rather than a generic "details" TTL because a
       bibliographic record is the ordinary thing being asked for and it barely
       moves — see the note on BT.TTL. */
    const ttl = opts.ttl != null ? opts.ttl : BT.TTL.work;

    /* Callers that care whether the answer is current pass `opts.meta` and
       read it afterwards. Returning the payload alone made a week-old cached
       record indistinguishable from a live one, which is precisely the thing a
       user needs to be told during an upstream outage. */
    const meta = opts.meta || {};
    meta.stale = false;
    meta.fromCache = false;

    /* 1. Cache first. */
    if (!opts.noCache) {
      const hit = await BT.repo.cacheGet(ck);
      if (hit && !hit.stale) {
        meta.fromCache = true;
        meta.fetchedAt = hit.fetchedAt;
        return hit.payload;
      }
      if (hit && opts.staleOk !== false) opts._stale = hit;   // keep as a fallback
    }
    if (opts.cacheOnly) {
      if (!opts._stale) return null;
      meta.stale = true; meta.fromCache = true; meta.fetchedAt = opts._stale.fetchedAt;
      return opts._stale.payload;
    }

    /* 2. Key gate, deliberately placed AFTER the cache.
       Anonymous Google Books is not throttled, it is OFF: an unauthenticated
       volumes request answers HTTP 429 carrying "quota_limit_value":"0" — a
       quota of zero, not a quota we exhausted. Verified. Issuing the request
       anyway would spend a lane slot, a bucket token and a retry cycle to be
       told something already known, and four of them in a row would trip the
       circuit breaker for a source that is merely switched off. It reports
       `auth` rather than `budget` because the fix is a key, not patience.

       After the cache, though: a payload fetched while a key was present is
       still perfectly good data, and removing the key should not blind the app
       to what it already holds. */
    if (source === 'googlebooks' && !BT.config.hasKey('googlebooks')) {
      throw new NetError('auth',
        'Google Books needs your own API key — anonymous access is capped at zero requests, so there is nothing to fall back to. Add one in Settings, or leave it off: Open Library runs the app on its own.',
        { source, actionable: true });
    }

    /* 3. Circuit + budget gates, both of which must refund cleanly. */
    const cost = opts.cost != null ? opts.cost : costOf(source, url);

    if (circuitOpen(source)) {
      if (opts._stale) return serveStale(meta, opts._stale, `${label(source)} is temporarily unavailable`);
      throw new NetError('server', `${label(source)} is temporarily unavailable.`, { source });
    }
    if (!(await budgetTake(source, cost))) {
      if (opts._stale) return serveStale(meta, opts._stale, `${label(source)} request budget spent`);
      const st = await budgetState(source);
      throw new NetError('budget',
        `This browser has used its ${label(source)} request budget for the ${st ? st.period : 'day'}.`,
        { source });
    }

    /* Bare for Open Library — see the User-Agent note. Adding so much as one
       header here promotes this GET into a preflight that OL's singular
       `access-control-allow-method` cannot satisfy, and the request stops
       working entirely. */
    const headers = NO_CUSTOM_HEADERS.has(source) ? undefined : (opts.headers || undefined);

    let spent = true;                          // a budget unit is outstanding
    await lanes[source].acquire();             // acquired ONCE...
    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= policy.retries; attempt++) {
        /* Per ATTEMPT, not per call: a retry is another real round trip, and
           a redirecting ISBN lookup is two of them. */
        await buckets[source].take(cost);
        let res = null;
        /* A deadline per attempt. A CDN in front of a dead origin holds the
           connection for many seconds before answering, and fetch() has no
           timeout of its own, so without this a single sick source blocks the
           screen for a minute. */
        const ctl = new AbortController();
        let timedOut = false;
        const onOuterAbort = () => ctl.abort();
        if (opts.signal) {
          if (opts.signal.aborted) ctl.abort();
          else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        const deadline = setTimeout(() => { timedOut = true; ctl.abort(); },
                                    policy.timeout || 15000);
        try {
          res = await fetch(url, {
            method: opts.method || 'GET',
            headers: headers,
            body: opts.body || undefined,
            signal: ctl.signal,
            cache: 'no-cache',                 /* revalidate via ETag; do NOT
                                                  cache-bust with ?v=Date.now(),
                                                  which defeats 304s entirely */
            credentials: 'omit',               /* wildcard ACAO forbids credentials */
          });
        } catch (rawErr) {
          /* Our own deadline is NOT the caller cancelling. Reported as an
             abort it would skip the stale-cache fallback and surface as
             "Request cancelled", which tells the user nothing. */
          if (timedOut) {
            lastErr = new NetError('server',
              `${label(source)} did not respond within ${Math.round((policy.timeout || 15000) / 1000)}s.`,
              { source, timeout: true });
            if (attempt < policy.retries) { clearTimeout(deadline); continue; }
            break;
          }
          lastErr = await classify(source, rawErr, null);
          if (lastErr.kind === 'abort') throw lastErr;
          break;                               // opaque/offline: retrying won't help
        } finally {
          clearTimeout(deadline);
          if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
        }

        /* `res.ok` is checked BEFORE `.json()`, and the order is not stylistic.
           Open Library's failures are HTML pages with a normal Response
           object; parsing first turns every missing ISBN into a SyntaxError
           with no status, no source and nothing a user could act on. */
        if (res.ok) {
          circuitReset(source);
          /* A 200 that is still a web page. Two real causes: a URL that
             resolved to a browsable Open Library page rather than a `.json`
             document, and a captive portal — hotel or airport wifi — happily
             answering 200 with its own login form for every request on the
             machine. Both mean "no record here", neither is malformed, and
             calling it `parse` would send the user hunting for a bug in the
             app. Retrying returns the identical page, so stop. */
          if (looksLikeHtml(res)) {
            lastErr = new NetError('notfound',
              `${label(source)} answered with a web page rather than a record.`,
              { status: res.status, html: true, source });
            break;
          }
          let payload;
          try { payload = await res.json(); }
          catch (e) { throw new NetError('parse', `${label(source)}: malformed response`); }
          /* An error envelope hiding inside a success. Google's JSON API
             reports failures as `{ error: { code, message } }` and some of Open
             Library's older endpoints answer with a bare `error` string, so
             `res.ok` alone is not proof of a usable payload. Note what is NOT
             treated as failure: an empty result set. `{"numFound":0,"docs":[]}`
             is a real, cacheable answer meaning the catalogue has nothing, and
             the caller decides what to say about it. */
          if (payload && payload.error) {
            const msg = (payload.error && payload.error.message) || String(payload.error);
            lastErr = new NetError('server', `${label(source)}: ${msg}`);
            if (attempt < policy.retries) { await backoff(attempt, 0); continue; }
            break;
          }
          if (!opts.noCache && ttl > 0) {
            BT.repo.cachePut(ck, source, payload, ttl, opts.cacheClass || 'reduced');
          }
          meta.fetchedAt = Date.now();
          return payload;
        }

        lastErr = await classify(source, null, res);
        if (!lastErr.retryable || attempt === policy.retries) break;
        await backoff(attempt, lastErr.retryAfter);
      }

      if (lastErr && (lastErr.kind === 'server' || lastErr.kind === 'opaque')) circuitTrip(source);
      /* Nothing reached the network usefully — give the units back. A 404 is
         NOT in this list: that request was made, answered and paid for. */
      if (lastErr && (lastErr.kind === 'offline' || lastErr.kind === 'opaque')) {
        await budgetRefund(source, cost); spent = false;
      }
      if (opts._stale) {
        console.warn(`[net] serving stale ${source} for ${ck}:`, lastErr && lastErr.message);
        return serveStale(meta, opts._stale, lastErr && lastErr.message, lastErr);
      }
      throw lastErr || new NetError('server', `${label(source)}: request failed`);
    } finally {
      lanes[source].release();                 /* ...and released ONCE. Putting
                                                  this inside the retry loop
                                                  leaks a slot per retry until
                                                  the limiter stops existing. */
      void spent;
    }
  }

  /* Falling back to cache is not a failure, but it is not success either — the
     caller has to be able to say so. */
  function serveStale(meta, hit, reason, err) {
    meta.stale = true;
    meta.fromCache = true;
    meta.fetchedAt = hit.fetchedAt;
    meta.reason = reason || 'upstream unavailable';
    meta.errorKind = err && err.kind;
    return hit.payload;
  }

  /* Full-jitter exponential backoff; an explicit Retry-After always wins where
     one is sent at all. Against Open Library `retryAfterSec` is always 0 by
     construction (see SENDS_RETRY_AFTER), so that path is blind by design
     rather than by omission. */
  async function backoff(attempt, retryAfterSec) {
    if (retryAfterSec > 0) return BT.util.sleep(Math.min(retryAfterSec * 1000, 15000));
    const ceiling = Math.min(8000, 350 * Math.pow(2, attempt));
    return BT.util.sleep(Math.random() * ceiling);
  }

  /* Nothing in BookTrak POSTs today — Open Library's write API needs OAuth and
     Google Books is read-only for us — but the path stays here so that if
     something ever does, it goes through the same limiter, budget and
     classifier as everything else rather than reaching for fetch() directly.
     Note that a POST to a NO_CUSTOM_HEADERS source would lose its Content-Type
     and fail; that is correct, because such a request cannot work anyway. */
  async function post(source, url, body, opts) {
    return get(source, url, Object.assign({}, opts, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' },
                             (opts && opts.headers) || {}),
    }));
  }

  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.join('&');
  }

  return {
    get, post, qs, NetError, budgetState, probeInternet, cacheKeyFor,
    userAgent, costOf, label,
    _lanes: lanes,      // exposed for the concurrency-leak test
    _buckets: buckets,
  };
})();
