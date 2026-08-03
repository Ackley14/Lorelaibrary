/* ══════════════════════════════════════════════════════════════════════════
   Sync — the encrypted library file living in this repository.

   Read path is unauthenticated: the file is public, and it is ciphertext, so
   nothing is protected by hiding it. On a hosted copy it is fetched relatively;
   on file:// a relative fetch is blocked by the browser, so it falls back to
   raw.githubusercontent.com, which does send `Access-Control-Allow-Origin: *`.

   Write path needs a GitHub fine-grained token with Contents: read+write,
   pasted once and kept inside the encrypted payload (see "the vault" below).
   Verified live from MovieTrak, the sibling app this is ported from: a
   preflight OPTIONS to api.github.com for a cross-origin PUT with an
   Authorization header returns 204 with a wildcard ACAO, so this genuinely
   works from a browser with no proxy.

   A caveat worth knowing, since the token can write to the repo that serves
   this page: anyone who obtained it could commit JavaScript into the site
   itself. For a personal tool that is an acceptable risk, but it is why the
   token is scoped to one repository and given an expiry.

   ── THREE THINGS THAT ARE BOOKTRAK'S AND NOT MOVIETRAK'S ─────────────────

   1. EVERY KEY IS `bt.`-PREFIXED. BookTrak ships from
      ackley14.github.io/Lorelaibrary and MovieTrak from /entertainmentwatch —
      one browser origin, because localStorage is scoped to the origin and not
      the path. `mt.gh.token.v1` here would not throw; it would hand this app
      the other app's repository and token and start committing a book library
      into a film library's repo.

   2. THE FILE IS NEVER PRECACHED. sw.js answers navigations and the precached
      shell list and nothing else, so `data/library.enc.json` reaches the
      network on every read. That is deliberate and must stay true: a shell
      cache in front of this file would serve yesterday's library and every
      save would then report a conflict with a copy of itself.

   3. THE MERGE IS SHAPED FOR THIS APP'S STORES. See mergeDocs — BookTrak
      syncs a different, shorter set of stores than MovieTrak does, and one of
      them (`follows`) has a baseline that must be unioned rather than
      replaced. Copying MovieTrak's merge verbatim would have re-announced
      whole backlists.
   ══════════════════════════════════════════════════════════════════════════ */

BT.cloud = (function () {
  const LS_TOKEN = 'bt.gh.token.v1';
  const LS_REPO = 'bt.gh.repo.v1';
  /* Whether this device has ever opted into sync. Read on every boot, and it
     is the ONLY thing that decides whether a gate appears — see BT.gate.open
     and the boot seam. Without it, inferRepo() succeeds for every visitor to
     the published site and everyone who has never wanted sync would be met by
     a passphrase screen on a local-first app. */
  const LS_ENROLLED = 'bt.sync.enrolled.v1';
  const DEFAULT_PATH = 'data/library.enc.json';

  /* Infer owner/repo from the Pages URL so a hosted copy needs no setup at
     all. `ackley14.github.io/Lorelaibrary/` → `ackley14/Lorelaibrary`, which
     is the deployment this app actually ships to.

     ON CASE. The repository segment comes out of location.pathname and keeps
     its real case (`Lorelaibrary`); the owner comes out of location.hostname,
     which the browser has already lowercased, so `Ackley14` arrives as
     `ackley14`. Both api.github.com and raw.githubusercontent.com resolve
     owner and repository case-insensitively — it is the BRANCH and the FILE
     PATH inside the repo that are case-sensitive, and those are literals
     below. If that ever stops being true, `bt.gh.repo.v1` is the override and
     Settings has a field for it; a stored value always wins and its case is
     preserved exactly as typed. */

  /* Trimmed on READ as well as on write. setRepo trims, so every value this
     app writes is already clean — but a value put there by hand, by an import,
     or by an older build is not, and an untrimmed ' ' is truthy: it would beat
     inference and name a repository that cannot exist. Whitespace is not a
     configuration. */
  function storedRepo() {
    try { return (localStorage.getItem(LS_REPO) || '').trim(); } catch (_) { return ''; }
  }

  function inferredRepo() {
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    if (!m) return '';
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg) return `${m[1]}/${seg}`;
    return `${m[1]}/${m[1]}.github.io`;
  }

  /* file://, localhost, a LAN address: nothing to infer, and no stored value.
     Sync stays off and the app is local-first, which is its normal state. */
  function inferRepo() { return storedRepo() || inferredRepo(); }

  /* ── WHERE THE NAME CAME FROM, which is not the same question as what it is
     ──────────────────────────────────────────────────────────────────────
       'stored'    a human typed owner/repository into Settings. A STATEMENT
                   OF INTENT: "my library is there."
       'inferred'  read out of the github.io URL this page was served from. A
                   statement about GEOGRAPHY: "if there were a library, it
                   would be there." It says nothing about whether one exists.
       'none'      neither. Sync is off.

     THE WHOLE 404 BUG LIVES IN THE GAP BETWEEN THE FIRST TWO. `data/library.
     enc.json` missing under an INFERRED repo is the ordinary, expected,
     permanent first-run state of every fresh deployment — the visitor never
     asked for that repository, they just followed a link to a Pages site, and
     there is nothing for them to fix. Missing under a STORED one is a fact
     about something a person typed, and a typo in owner/repository produces a
     404 that is indistinguishable from "nothing published" unless somebody
     says so out loud. So the two are treated differently, deliberately:

       inferred + 404   silent. No error, no console line, no banner. Reported
                        on screen ONLY if the reader asked us to look
                        (71-view-unlock's nothingPublished), and phrased as the
                        ordinary state it is.
       stored   + 404   the same screen, but leading with the hypothesis that
                        only applies here — check what you typed — and, on an
                        enrolled device that has published to this repository
                        before, a banner from 90-boot.js. A file that WAS there
                        and now is not, under a name a human chose, is the one
                        shape of this that is worth interrupting somebody for.

     WHY NONE OF THIS WAS VISIBLE LOCALLY, which is the reason it shipped:
     inferredRepo() reads location.hostname, so the answer depends on the
     DEPLOYMENT URL and nowhere else. On 127.0.0.1, localhost, a LAN address
     or file:// it returns '' — configured() is false, the request is never
     made, and every local test passes for a reason that has nothing to do
     with the code being tested. Only a github.io origin exercises the real
     path. Reproduce it by serving the app under a github.io URL (Playwright
     can route one to disk), or by setting `bt.gh.repo.v1` before boot so
     storedRepo() supplies the name and inference is bypassed — the second is
     the 'stored' half of the table above, and the first is the 'inferred'
     half, so BOTH are needed to cover this function. */
  function repoSource() {
    if (storedRepo()) return 'stored';
    return inferredRepo() ? 'inferred' : 'none';
  }

  const repo = () => inferRepo();
  const setRepo = v => { try { localStorage.setItem(LS_REPO, (v || '').trim()); } catch (_) {} };
  const token = () => { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; } };
  const setToken = v => { try { localStorage.setItem(LS_TOKEN, (v || '').trim()); } catch (_) {} };
  const hasToken = () => !!token();
  const path = () => DEFAULT_PATH;

  function configured() { return !!repo(); }

  /* ── Enrolment ─────────────────────────────────────────────────────────
     "Has anybody on this device ever chosen to sync?" It is a LOCAL, SYNCHRONOUS
     question on purpose: boot has to answer it before deciding whether to show
     a gate, and any answer that needed the network would put a spinner in front
     of an app that works perfectly without one.

     Three signals, any of which means yes, because a half-finished setup should
     still land on the gate rather than silently going local:
       · the explicit flag, written when a library is created or signed into;
       · a remembered device key (bt.key.v1);
       · a token pasted into Settings (bt.gh.token.v1).

     Sign-out clears all three, which is what makes "work locally" a real
     answer rather than a screen you have to dismiss every visit. */
  function enrolled() {
    try {
      if (localStorage.getItem(LS_ENROLLED) === '1') return true;
    } catch (_) { return false; }
    return (BT.crypto && BT.crypto.isRemembered && BT.crypto.isRemembered()) || hasToken();
  }
  function setEnrolled(on) {
    try {
      if (on) localStorage.setItem(LS_ENROLLED, '1');
      else localStorage.removeItem(LS_ENROLLED);
    } catch (_) {}
  }

  /* ── "Is a published library expected to be there?" ─────────────────────
     NOT the same question as configured(), and the gap between the two is a
     bug that shipped to the live site.

     configured() only says we can NAME a repository — and on the published
     site that is true for every stranger who follows a link, because
     inferRepo() reads owner/repo straight out of the github.io URL. Nobody
     has published anything, so `data/library.enc.json` is not there, so
     asking for it returns 404. THAT 404 IS DATA, NOT A FAULT: "no library has
     been published yet" is the ordinary first-run state of a repository, and
     pullEnvelope() has always reported it as an answer (`null`) rather than an
     error.

     The console cannot be told that. Chromium, Firefox and WebKit all print a
     red "Failed to load resource: 404" for any fetch that 404s, before a line
     of our code runs — and pullEnvelope() tries three urls, so ONE visit to
     the sign-in screen on the published site printed three console errors for
     an app that was working perfectly. Measured in all three engines. The only
     way to a clean console is not to issue the request, which is exactly the
     rule 05-net.js already applies to Google Books: with no key the app makes
     ZERO googleapis requests rather than firing ones it knows will fail.

     So the test is enrolled() — the same local, synchronous "has anybody on
     THIS device ever chosen to sync?" that 90-boot.js gates the gate on. If
     somebody has, a library is expected to exist, looking for it is worth a
     request, and a 404 is worth reporting. If nobody has, there is nothing to
     look for and the request is skipped entirely.

     This deliberately does NOT gate pullEnvelope() itself, and must not:
     71-view-unlock's setup() publishes the very first library BEFORE
     setEnrolled(true) runs, so publish() → checkConflict() → pullEnvelope() is
     a legitimate read from a device that is not yet enrolled. That read is a
     deliberate write action by a reader who is configuring sync, and its
     overwrite guard is the whole reason the read exists. The gate is on the
     two paths that look on the APP's initiative instead — peek() and
     syncDown().

     AND IT IS enrolled(), NOT repoSource() === 'stored'. Typing a repository
     into Settings is a statement of intent, and it is tempting to let it stand
     in for enrolment — but the two are genuinely different: naming the
     repository is step one of signing in and the passphrase is step two. A
     device between the two steps has published nothing of its own and holds no
     key to open anything it found, so looking on its behalf buys a 404 and
     nothing else. What a stored repository DOES change is how that 404 is
     described once somebody does look. See repoSource(). */
  function expectPublished() { return configured() && enrolled(); }

  /* ── Read ──────────────────────────────────────────────────────────────
     Deliberately unauthenticated and cache-busted. `cache: 'no-cache'` forces
     revalidation via ETag rather than re-downloading — appending ?v=Date.now()
     would defeat the 304 path and re-fetch the whole file every time.

     One of the two deliberate exemptions from "BT.net is the only caller of
     fetch()". BT.net exists for Open Library's rate limit, its error
     classifier and its response cache, and not one of those applies here: this
     is our own file, on our own origin, and caching it is precisely the bug
     described in the header. */
  async function pullEnvelope() {
    const r = repo();
    if (!r) throw new Error('No repository configured.');

    const urls = [];
    if (location.protocol !== 'file:') urls.push(path());          // relative, same origin
    urls.push(`https://raw.githubusercontent.com/${r}/main/${path()}`);
    urls.push(`https://raw.githubusercontent.com/${r}/master/${path()}`);

    /* THREE OUTCOMES, AND ONLY ONE OF THEM IS A FAILURE.

         an envelope     the library, decrypted by the caller.
         null            every server we asked answered 404. Nothing has been
                         published yet — an ANSWER, and the state the sign-in
                         screen needs in order to offer "create a library"
                         rather than "sign in". Never an error.
         throw           anything else: a 500, a dead socket, a captive portal,
                         or a file that came back and was not one of ours.

     `absent` counts the urls that produced a real 404 rather than trusting
     whichever error happened to be last, and null is returned only when EVERY
     url said the same thing. A definitive 404 from one server plus a dead
     socket from the next is not evidence that the file is absent, it is
     evidence that we could not find out — and the two must not be confused,
     because checkConflict() turns "absent" into "nobody else has written, so
     publish freely". Getting that wrong overwrites another device's library.
     (The old string compare on `lastErr.message === 'notfound'` accepted
     exactly that mixed case, and would also have swallowed any genuine error
     that happened to carry the same word.)

     A 404 THEREFORE COUNTS AND SAYS NOTHING. It must never become an Error
     object, because the thrown error is a DIAGNOSIS that the reader is shown
     verbatim — under "What GitHub said" on the unlock screen, and inside
     publish()'s "nothing was published (…)" banner via checkConflict(). The
     urls are tried in order of authority and the 404s are the LAST two, so a
     sentinel error written on a 404 overwrites the real diagnosis every time
     the mix goes that way. Measured, before this was split apart: a 500 on the
     same-origin url followed by two raw 404s reported "No library has been
     published to this repository yet." under a heading reading "Could not
     reach your library", and a file that came back and was not ours reported
     the same thing instead of saying so.

     That mix is not exotic — it is the shape of EVERY genuine fault on a Pages
     site that publishes from a branch other than main/master, where the two
     raw urls always 404 and the relative one is the only one that can speak.
     So the real error is captured separately and the FIRST one wins: the urls
     are ordered by authority, the relative url is the actual deployment, and
     its answer is the one worth repeating. */
    let realErr = null;
    let absent = 0;
    const note = e => { if (!realErr) realErr = e; };
    for (const u of urls) {
      try {
        const res = await fetch(u, { cache: 'no-cache', credentials: 'omit' });
        if (res.status === 404) { absent++; continue; }             // an answer, not an error
        if (!res.ok) { note(new Error(`HTTP ${res.status}`)); continue; }
        const body = await res.json();
        if (body && body.kind === 'booktrak.encrypted') return body;
        note(new Error('That file is not an encrypted BookTrak library.'));
      } catch (e) { note(e); }
    }
    if (absent === urls.length) return null;                       // nothing published yet
    throw realErr || new Error('Could not read the library file.');
  }

  /* ── Write ─────────────────────────────────────────────────────────── */

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${tokenForWrite()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /* The Contents API needs the CURRENT blob sha to replace a file. Cache it
     from the previous write rather than re-reading before every save. */
  async function currentSha() {
    const cached = await BT.repo.metaGet('cloud.sha');
    if (cached) return cached;
    const r = repo();
    const res = await fetch(`https://api.github.com/repos/${r}/contents/${path()}`, {
      headers: ghHeaders(), cache: 'no-store', credentials: 'omit',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await ghError(res));
    const body = await res.json();
    await BT.repo.metaSet('cloud.sha', body.sha);
    return body.sha;
  }

  async function ghError(res) {
    let msg = `GitHub returned HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b && b.message) msg = b.message;
      if (res.status === 401) msg = 'That GitHub token was rejected. It may have expired.';
      if (res.status === 403) msg = 'GitHub refused the write. Check the token has Contents: read and write on this repository.';
      if (res.status === 404) msg = 'Repository or path not found. Check the owner/repo value, and that the token can see it.';
    } catch (_) {}
    return msg;
  }

  async function push(envelope, opts) {
    opts = opts || {};
    if (!hasWriteToken()) throw new Error('No GitHub token available. Add one in Settings so changes can be saved back.');
    const r = repo();
    if (!r) throw new Error('No repository configured.');

    const json = JSON.stringify(envelope, null, 1);
    /* The Contents API wants base64. Everything in the envelope is already
       ASCII base64, but encoding through TextEncoder keeps this correct even
       if that ever stops being true. */
    const content = BT.crypto.bytesToB64(new TextEncoder().encode(json));

    let sha = opts.sha !== undefined ? opts.sha : await currentSha();
    let attempt = 0;

    for (;;) {
      const res = await fetch(`https://api.github.com/repos/${r}/contents/${path()}`, {
        method: 'PUT',
        headers: ghHeaders(),
        credentials: 'omit',                 // wildcard ACAO forbids credentials
        body: JSON.stringify({
          message: opts.message || `BookTrak: sync library (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
          content,
          sha: sha || undefined,             // omitted entirely when creating
        }),
      });

      if (res.ok) {
        const body = await res.json();
        await BT.repo.metaSet('cloud.sha', body.content && body.content.sha);
        await BT.repo.metaSet('cloud.lastPushAt', Date.now());
        return body;
      }

      /* 409 usually means our cached sha went stale — another device wrote.
         It can also come from ordinary API-side contention on rapid writes,
         so retries are bounded rather than infinite. */
      if (res.status === 409 && attempt < 2) {
        attempt++;
        await BT.repo.metaSet('cloud.sha', null);
        sha = await currentSha();
        await BT.util.sleep(400 * attempt);
        continue;
      }
      throw new Error(await ghError(res));
    }
  }

  /* ── The vault ─────────────────────────────────────────────────────────
     The GitHub token lives INSIDE the encrypted payload rather than only in
     each browser's localStorage. That is what makes "sign in anywhere with just
     a passphrase" true: reading the file needs nothing, decrypting it needs the
     passphrase, and decrypting it also hands you the token needed to write back.

     The trade is real and worth being clear about: the token's safety now
     rests entirely on passphrase strength against an offline attack on a file
     anyone can download. Hence the strength requirement at setup, a narrowly
     scoped token, and an expiry date. */
  let vaultToken = null;
  function tokenForWrite() { return vaultToken || token(); }
  function setVaultToken(t) { vaultToken = (t || '').trim() || null; }
  const hasWriteToken = () => !!tokenForWrite();

  /* ── High-level operations ─────────────────────────────────────────── */

  async function publish(opts) {
    opts = opts || {};
    if (!BT.crypto.isUnlocked()) throw new Error('Locked — enter your passphrase first.');

    let doc = await BT.repo.exportAll();

    /* Another device wrote since we last read. MERGE rather than asking: both
       sets of edits are real, and making someone choose between them is a poor
       experience and a good way to lose work. The merge is record-level, so
       two people editing different books both keep their work; only an edit to
       the SAME book has to pick a winner, and the newer one wins. */
    if (!opts.force) {
      const c = await checkConflict();

      /* WE COULD NOT FIND OUT WHETHER ANYBODY ELSE HAS WRITTEN. Refuse to
         publish rather than guess. This is the difference between "the save
         failed and will be retried in a moment" and "another device's evening
         of reading is gone", and only one of those is recoverable.

         It is a real state, not a defensive flourish: the read path prefers
         the same-origin relative URL and the write path goes to
         api.github.com, so the two do not fail together. A relative fetch that
         404s while the API is perfectly healthy would otherwise read as
         "nothing published yet", and the push would go out with a fresh sha
         straight over whatever is actually there. */
      if (c.unknown) {
        throw new Error('Could not check whether another device has saved since, so nothing was '
          + `published${c.reason ? ` (${c.reason})` : ''}. This will be retried.`);
      }

      if (c.conflict) {
        let theirs = null;
        let why = null;
        try { theirs = await BT.crypto.decryptJson(c.envelope); } catch (e) { why = e; }

        /* THE PASSPHRASE CHANGED SOMEWHERE ELSE. A conflicting envelope we
           cannot open is not a corrupt file, it is a file encrypted with a key
           this device does not have — changePassphrase() writes a new salt, and
           every device holding the old key lands exactly here. Publishing over
           it would re-encrypt the whole library back under the OLD passphrase
           and silently undo the change on every device at once.

           MovieTrak's version fell through to the push. It is the one place in
           this port where following the original faithfully would have been the
           wrong answer. */
        if (!theirs) {
          throw new Error('The library in the repository was re-encrypted, so this device could '
            + 'not read it — the passphrase was changed somewhere else. Sign out and sign in '
            + 'again with the new one. Nothing has been overwritten.'
            + (why && why.message ? ` (${why.message})` : ''));
        }

        const { doc: merged, stats } = mergeDocs(doc, theirs);
        await BT.repo.importAll(merged);
        doc = await BT.repo.exportAll();        // re-read: the store just changed
        BT.repo.emit('sync:merged', stats);

        /* Ours is stale by definition once they have written. */
        await BT.repo.metaSet('cloud.sha', null);
      }
    }

    doc.vault = { githubToken: tokenForWrite() || null };
    const envelope = await BT.crypto.encryptJson(doc);
    const res = await push(envelope, opts);

    /* Record what we just wrote. Without this, the next save compares the
       remote's updatedAt against a marker from sign-in, finds them different
       — because WE changed it — and reports a conflict with itself. In
       MovieTrak that was the cause of a run of repeated save conflicts; it is
       cheap to prevent and expensive to diagnose. */
    await BT.repo.metaSet('cloud.knownRemoteAt', envelope.updatedAt);
    await BT.repo.metaSet('cloud.lastSyncedCounts', doc.counts);
    await BT.repo.metaSet('cloud.lastPushAt', Date.now());
    return { counts: doc.counts, commit: res.commit && res.commit.sha };
  }

  /* ── Bringing the repository's copy down ────────────────────────────────
     MERGED WITH WHAT THIS DEVICE ALREADY HOLDS, never simply written over it.

     This used to be replace-only, on the reasoning that what is being replaced
     "has just been merged with what is local, or is being adopted onto a device
     that had nothing". The first half is true of publish(), which merges before
     it writes. It is NOT true of either caller of this function:

       90-boot.js  start() calls syncDown() on EVERY launch of a remembered
                   device, before a single pixel is drawn.
       71-view-unlock.js  the gate's Open library button.

     So the losing sequence needed nothing exotic. Edit a book; the publish
     debounce fires; the network is down, or the token has expired, or
     checkConflict cannot reach GitHub — publish() correctly refuses rather than
     guessing, the banner says so, and the edit sits in this browser only. Close
     the tab. Next launch, this function pulled the older repository copy and
     wrote it straight over the top.

     MEASURED on this build, with the local record's `user.updatedAt` 560ms
     NEWER than the remote's: a rating of 9 reverted to 1, the notes were
     erased, `finished` went back to `want`, a page position of 210 of 300
     disappeared and the reading-log row went with it. BT.normalize.absorbSynced
     is what does it — it takes `merged.user = incoming.user` wholesale, which
     is right for a field-level absorb and cannot see that the incoming record
     is the older of the two.

     Two sentences the app prints made this a broken promise rather than only a
     bug. The gate's "Not now" says changes "will be merged the next time you
     sign in", and boot's offline banner says they "will be saved and merged as
     soon as it is reachable again". Both lead here.

     mergeDocs is the right function and is already trusted for exactly this job
     in the other direction — record-level last-write-wins on `user.updatedAt`,
     which putItem stamps on every reader-driven write and putItemQuiet
     deliberately does not, so a background refresh can never outrank an edit.
     Tombstones still win over an older edit, so a book deleted on the other
     device stays deleted.

     Skipped entirely when this device holds nothing, which is the ordinary
     sign-in on a new phone: merging an empty side is a no-op that costs a full
     export of a library we are about to overwrite anyway. */
  async function restore(envelope) {
    const doc = await BT.crypto.decryptJson(envelope);
    if (doc.vault && doc.vault.githubToken) setVaultToken(doc.vault.githubToken);

    let incoming = doc;
    if (await BT.repo.countItems()) {
      const mine = await BT.repo.exportAll();
      incoming = mergeDocs(mine, doc).doc;
    }

    const counts = await BT.repo.importAll(incoming);
    await BT.repo.metaSet('cloud.lastPullAt', Date.now());
    /* The envelope's own stamp, NOT the merge's. It records which repository
       version this device has seen, and that is what the next publish compares
       against to decide whether anybody else has written since. Stamping it
       with anything derived from the merge would make the next save believe it
       had already published a document that only exists in this browser. */
    await BT.repo.metaSet('cloud.knownRemoteAt', envelope.updatedAt || null);
    return counts;
  }

  /* ── Merging two divergent libraries ───────────────────────────────────
     Record-level last-write-wins, not file-level. Whole-file LWW would throw
     away everything the other device did since you loaded; per record, the two
     sets of edits both survive unless they touched the same book, and then the
     newer edit wins.

     Deletions are the case a naive union gets wrong: a missing record and a
     deleted record look identical, so union resurrects everything either side
     removed. Tombstones are what make the difference visible, which is why the
     `deleted` store exists from v1 of the schema (10-db.js says so) and why it
     travels in BT.repo's SYNC_STORES.

     THE STORE LIST IS BOOKTRAK'S, NOT MOVIETRAK'S. It is exactly
     12-repo.js's SYNC_STORES: items, follows, dismissed, alertKeys, feedItems,
     history, deleted — plus the `meta` object. MovieTrak also shipped
     `snapshots`, `idIndex`, `df` and `dfSeen`; here those are deliberately
     local (per-device change-detection state, an index rebuilt from items, and
     the recommender's own corpus), so merging them would be merging fields
     that are not in the payload. Anything absent from both sides simply never
     appears, which is what keeps this function in step with exportAll. */
  function mergeDocs(mine, theirs) {
    const out = { app: 'booktrak', kind: 'booktrak.export', schemaVersion: 1, payload: {} };
    const A = (mine && mine.payload) || {};
    const B = (theirs && theirs.payload) || {};
    const stats = { added: 0, updated: 0, removed: 0 };
    const both = k => [].concat(A[k] || [], B[k] || []);

    /* Newest-wins reduction on a natural key. `newer(candidate, current)` says
       whether the candidate should replace what is already held. */
    const byKey = (key, rows, newer) => {
      const m = new Map();
      for (const r of rows) {
        if (!r || r[key] == null) continue;
        const cur = m.get(r[key]);
        if (!cur || newer(r, cur)) m.set(r[key], r);
      }
      return [...m.values()];
    };

    /* Tombstones from both sides, newest wins. */
    const tombs = new Map();
    for (const t of both('deleted')) {
      if (!t || !t.uid) continue;
      const prev = tombs.get(t.uid);
      if (!prev || (t.deletedAt || 0) > (prev.deletedAt || 0)) tombs.set(t.uid, t);
    }
    out.payload.deleted = [...tombs.values()];

    /* Items: newest user.updatedAt wins, unless a tombstone is newer still.
       `user.updatedAt` is stamped by BT.repo.putItem on every reader-driven
       write and deliberately NOT by putItemQuiet, so a background refresh on
       one device can never outrank an edit made on the other. */
    const items = new Map();
    for (const it of (A.items || [])) if (it && it.uid) items.set(it.uid, it);
    for (const it of (B.items || [])) {
      if (!it || !it.uid) continue;
      const cur = items.get(it.uid);
      if (!cur) { items.set(it.uid, it); stats.added++; continue; }
      const a = (cur.user && cur.user.updatedAt) || 0;
      const b = (it.user && it.user.updatedAt) || 0;
      if (b > a) { items.set(it.uid, it); stats.updated++; }
    }
    for (const [uid, t] of tombs) {
      const it = items.get(uid);
      if (it && (t.deletedAt || 0) >= ((it.user && it.user.updatedAt) || 0)) {
        items.delete(uid); stats.removed++;
      }
    }
    out.payload.items = [...items.values()];

    /* Append-only ledger: a plain union is correct, and is exactly why alert
       ids are content-addressed (45-alerts.js). Two browsers that observe the
       same date change independently derive the same fnv1a id, so the union
       collapses them into one row rather than announcing it twice. Earliest
       sighting wins, because that is what `firstSeenAt` means. */
    out.payload.alertKeys = byKey('alertId', both('alertKeys'),
      (r, c) => (r.firstSeenAt || 0) < (c.firstSeenAt || 0));

    /* The feed is mutable, so it needs more than newest-wins.

       READ ANYWHERE COUNTS AS READ EVERYWHERE, and that direction is chosen
       rather than symmetric: an item that comes back unread after you cleared
       it on another device is a notification that will not go away, which is
       the failure people actually complain about. `count` takes the max
       because coalescing is per-device — four date slips seen on one machine
       and two on the other is six observations of one event, but the honest
       floor is the larger count, not their sum.

       `archivedFlag` is taken from the base row with no reconciliation, and
       that is safe rather than lazy: nothing in this app lets a reader archive
       anything. 45-alerts.js sets it on ingest, deterministically, from the
       row's own content (a stale date, a backlist title), so both devices
       derive the same value from the same alert. */
    const allFeed = both('feedItems');
    const feedFolded = new Map();
    for (const r of allFeed) {
      if (!r || r.feedId == null) continue;
      const cur = feedFolded.get(r.feedId) || { readAt: null, count: 0, firstAt: null };
      if (r.readAt != null) cur.readAt = cur.readAt == null ? r.readAt : Math.min(cur.readAt, r.readAt);
      cur.count = Math.max(cur.count, r.count || 1);
      if (r.firstAt != null) cur.firstAt = cur.firstAt == null ? r.firstAt : Math.min(cur.firstAt, r.firstAt);
      feedFolded.set(r.feedId, cur);
    }
    out.payload.feedItems = byKey('feedId', allFeed,
      (r, c) => (r.lastAt || 0) > (c.lastAt || 0)).map(r => {
        const x = feedFolded.get(r.feedId);
        if (!x) return r;
        return Object.assign({}, r, {
          readAt: x.readAt,
          readFlag: x.readAt == null ? 0 : 1,   // 0|1 — booleans are not valid IndexedDB keys
          count: x.count,
          firstAt: x.firstAt == null ? r.firstAt : x.firstAt,
        });
      });

    out.payload.dismissed = byKey('uid', both('dismissed'),
      (r, c) => (r.dismissedAt || 0) > (c.dismissedAt || 0));

    /* ── Follows, and the one place a verbatim port would have been wrong ──
       MovieTrak merged follows with plain newest-wins on the whole row. That
       was safe there because TMDB's combined_credits is a COMPLETE list, so
       every device's `knownWorkIds` converges on the same set.

       Open Library has no such endpoint. 45-alerts.js polls
       `search.json?author={OLID}&sort=new&limit=60` — a WINDOW over a result
       set whose ordering moves whenever a volunteer edits a publication year —
       which is why checkFollow UNIONS the baseline rather than replacing it.
       Taking one device's row whole would discard whatever the other device
       had learned, and a work dropped from the baseline is announced as new
       the next time it appears. Two devices would have taken turns re-posting
       each other's backlists.

       So the base row is newest-checked, and then the three fields where
       whole-row LWW is the wrong answer are repaired:
         knownWorkIds  unioned, for the reason above
         addedAt       earliest, because that is when you started following
         muted         the UNMUTED side wins. There is no `mutedAt` to do LWW
                       with, so this picks the recoverable failure: an
                       unwanted feed row can be muted again in one click,
                       whereas a follow silently muted by a merge is a feature
                       that stopped working with nothing on screen to say so.

       A KNOWN HOLE, recorded rather than hidden: `follows` has no tombstone
       store, so unfollowing on one device is undone by a merge with a device
       that still holds the row. The fix is a `deleted` row keyed on the follow
       id, written by BT.repo.deleteFollow — the tombstone loop above only ever
       deletes from `items`, and a follow id (`author:openlibrary:OL…A`) cannot
       collide with an item uid (`openlibrary:OL…W`), so the two can share the
       store. It is not done here because it belongs in 12-repo.js, and it only
       bites when both devices wrote between syncs. */
    const allFollows = both('follows');
    const followRows = new Map();
    for (const f of allFollows) {
      if (!f || !f.id) continue;
      if (!followRows.has(f.id)) followRows.set(f.id, []);
      followRows.get(f.id).push(f);
    }
    out.payload.follows = byKey('id', allFollows,
      (r, c) => (r.lastCheckedAt || 0) > (c.lastCheckedAt || 0)).map(base => {
      const rows = followRows.get(base.id) || [base];
      const known = new Set();
      let addedAt = base.addedAt || 0;
      let muted = 1;
      let lastCheckedAt = 0;
      for (const f of rows) {
        for (const k of (f.knownWorkIds || [])) if (k) known.add(k);
        if (f.addedAt) addedAt = addedAt ? Math.min(addedAt, f.addedAt) : f.addedAt;
        if (!f.muted) muted = 0;
        lastCheckedAt = Math.max(lastCheckedAt, f.lastCheckedAt || 0);
      }
      /* Capped from 70-follows.js's own ceiling rather than a literal, because
         EVICTION IS THE FAILURE MODE this whole baseline exists to avoid: an id
         dropped from the list re-alerts as new the next time it appears, and a
         merge is precisely where the union is at its largest. One number, one
         owner. */
      const cap = (BT.follows && BT.follows.KNOWN_CAP) || 4000;
      return Object.assign({}, base, {
        knownWorkIds: [...known].slice(-cap),
        addedAt: addedAt || base.addedAt,
        muted,
        lastCheckedAt,
      });
    });

    /* History is an EVENT LOG, not a set of records — every row is something
       that happened at a moment, and two devices legitimately hold different
       halves of it. Dedupe on the event itself and never on `id`: that key is
       an IndexedDB autoIncrement, so both devices number their own log 1..n
       and merging on it would silently discard one device's history entirely.
       (BT.repo.importAll strips `id` on the way back in for the same reason.)

       `value` is part of the key because a progress event carries the page
       number: two "progress" rows on one book at the same millisecond with
       different pages are two readings, and collapsing them would quietly
       flatten the pace chart in 68-view-stats.js. */
    const hist = new Map();
    for (const h of both('history')) {
      if (!h || !h.uid) continue;
      hist.set(`${h.uid}|${h.event}|${h.value == null ? '' : h.value}|${h.at}`, h);
    }
    out.payload.history = [...hist.values()];

    /* Local settings win: they describe this device, not the library. Region,
       language and the Google Books key are all "how this browser behaves". */
    out.payload.meta = A.meta || B.meta;

    out.counts = Object.fromEntries(Object.entries(out.payload)
      .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
    out.exportedAt = new Date().toISOString();
    /* Same shape exportAll produces, checksum included, so a merged document is
       indistinguishable from an exported one. importAll does not verify it
       today; the day it does, merged docs must not be the thing it rejects. */
    out.integrity = { algo: 'fnv1a', value: BT.util.fnv1a(JSON.stringify(out.payload)) };
    return { doc: out, stats };
  }

  /* Before overwriting the shared file, check nobody else has written since we
     last read it. updatedAt sits outside the ciphertext precisely so this can
     be answered without the passphrase.

     THREE ANSWERS, NOT TWO, and the third is the one that matters:

       conflict          somebody wrote. Merge.
       no conflict       we are up to date, or nothing has ever been published.
       unknown           we could not tell. The caller must not publish.

     "Unknown" used to be folded into "no conflict" — a swallowed exception
     returning `{conflict:false}` — and that is a silent overwrite waiting for a
     bad network. The 404 case needs the same care: a missing file means "first
     save" only if we have never published from this device. If
     `cloud.knownRemoteAt` is set then we HAVE, so the file existing is a fact
     we already know, and a 404 is evidence about the read path rather than
     about the repository. */
  async function checkConflict() {
    const known = await BT.repo.metaGet('cloud.knownRemoteAt');
    let env;
    try {
      env = await pullEnvelope();
    } catch (e) {
      return { conflict: false, unknown: true, reason: (e && e.message) || 'The library file could not be read.' };
    }
    if (!env) {
      return known
        ? { conflict: false, unknown: true, reason: 'The library file did not come back, but this device has published one before.' }
        : { conflict: false };
    }
    /* A file exists and this device holds no record of ever having read or
       written it, so it has nothing to compare against and no basis for
       claiming its copy is the newer one. Publishing here is a blind
       overwrite.

       THE PATH THAT GETS HERE IS "ERASE EVERYTHING". BT.repo.wipe() clears the
       `meta` store along with the rest, which takes `cloud.knownRemoteAt` with
       it — so the next book added to a freshly wiped browser would publish a
       one-book library over a nine-hundred-book one, and the Settings copy that
       promises the erase is local would have been a lie. Signing in again is
       the reconciliation, and the save-failure banner is where the reader is
       told to. Nothing else reaches this branch: restore() and publish() both
       stamp the marker. */
    if (!known) {
      return { conflict: false, unknown: true,
               reason: 'There is a library in the repository that this device has not read. Sign in again to reconcile before saving.' };
    }
    if (!env.updatedAt || env.updatedAt === known) return { conflict: false, envelope: env };
    return { conflict: true, envelope: env, theirs: env.updatedAt, ours: known };
  }

  /* ── Change the passphrase ─────────────────────────────────────────────
     Order matters and is the whole safety story: derive the new key, encrypt
     with it, PUBLISH, and only swap the live key once GitHub has accepted the
     write. If anything fails the old passphrase still works and nothing has
     been lost. A new salt is generated too, so the old passphrase cannot open
     the new file.

     Other devices that chose "stay signed in" hold the old derived key. Their
     next load fails to decrypt, which drops them at the sign-in screen — which
     is exactly what changing a passphrase should do. */
  async function changePassphrase(newPassphrase) {
    if (!BT.crypto.isUnlocked()) throw new Error('Sign in first.');
    if (!hasWriteToken()) throw new Error('No GitHub token, so the re-encrypted library could not be saved.');

    const doc = await BT.repo.exportAll();
    doc.vault = { githubToken: tokenForWrite() || null };

    const { key, salt } = await BT.crypto.deriveStandalone(newPassphrase);
    const envelope = await BT.crypto.encryptWithKey(key, salt, doc);

    await BT.repo.metaSet('cloud.sha', null);       // force a fresh sha read
    await push(envelope, { message: 'BookTrak: change passphrase' });

    BT.crypto.adopt(key, salt);                     // only now
    await BT.repo.metaSet('cloud.knownRemoteAt', envelope.updatedAt);
    if (BT.crypto.isRemembered()) await BT.crypto.rememberOnDevice();
    return true;
  }

  /* Pull the shared library and adopt it. This is the normal path on every
     load for a device that has enrolled, because the repo — not this browser —
     is then the source of truth. */
  async function syncDown() {
    /* Nobody on this device has opted into sync, so there is no library of
       ours to bring down and a request for one is a guaranteed 404 with a
       console error attached — see expectPublished(). 90-boot.js already tests
       enrolled() before it gets here; this is the module defending its own
       rule, so that the next caller inherits it without having to know. */
    if (!expectPublished()) return { exists: false, unasked: true, source: repoSource() };
    const env = await pullEnvelope();
    /* ABSENT, AND WHO CHOSE THE NAME IT IS ABSENT FROM. 90-boot.js is the only
       caller that runs unprompted on every launch, so it is the only place that
       can nag — and the only shape worth nagging about is a file that this
       device has published before, under a repository a human typed, which is
       now gone. `everPublished` is that memory: cloud.knownRemoteAt is stamped
       by restore() and publish() and by nothing else.

       Deliberately NOT reported for an inferred repository, however enrolled
       this device is. Setting a passphrase without a token enrols without
       publishing, which is a perfectly ordinary way to use this app, and it
       would otherwise earn a banner on every single launch about a file that
       was never meant to exist yet. */
    if (!env) {
      return {
        exists: false,
        absent: true,
        source: repoSource(),
        everPublished: !!(await BT.repo.metaGet('cloud.knownRemoteAt')),
      };
    }
    const counts = await restore(env);
    return { exists: true, counts };
  }

  /* Metadata readable WITHOUT the passphrase — updatedAt and counts live
     outside the ciphertext precisely so the unlock screen can say what it is
     about to restore. */
  async function peek(opts) {
    opts = opts || {};

    /* FOUR ANSWERS, and the caller must tell them apart — 71-view-unlock.js
       draws a different screen for each, and conflating any two of them is the
       one bug on that screen that can destroy a library:

         { exists: true, … }              there it is.
         { exists: false, absent: true }  asked, and the repository definitively
                                          holds nothing. Offer to create one.
         { exists: false, error }         could NOT find out. Never offer to
                                          create one — creating publishes over
                                          whatever is really there.
         { exists: false, unasked: true } did not ask, and nothing went wrong.

       Every one of them carries `source` — 'stored', 'inferred' or 'none' —
       because "there is no library file here" means two different things
       depending on who chose "here", and the screen that says so needs to know
       which. See repoSource().

       The last one is new and is the fix for a live-site console full of 404s.
       Nobody on this device has ever chosen to sync, so there is nothing of
       ours published under the inferred repo and asking for it costs three
       guaranteed 404s — three red lines in every engine's console on an app
       that is working perfectly. See expectPublished() for the whole argument.

       `onDemand` is the reader overriding it by pressing a button: at that
       point looking IS the action they asked for, so the request is made and
       whatever comes back — including "nothing published yet" — is reported on
       screen, where it belongs, rather than only in the console. */
    const source = repoSource();
    if (!opts.onDemand && !expectPublished()) return { exists: false, unasked: true, source };

    try {
      const env = await pullEnvelope();
      /* A 404 from every url. Not an error and never logged as one — the
         browser's own red line for the request is exactly what the gate on the
         line above exists to avoid, and this branch is only reached when the
         reader asked us to look, at which point the answer belongs on screen
         rather than in a console nobody has open. */
      if (!env) return { exists: false, absent: true, source };
      return {
        exists: true,
        source,
        updatedAt: env.updatedAt,
        counts: env.counts || null,
        salt: BT.crypto.saltFromEnvelope(env),
        envelope: env,
      };
    } catch (e) {
      return { exists: false, error: e.message, source };
    }
  }

  async function status() {
    return {
      repo: repo(),
      /* On the diagnostics deck because "which repository" and "who decided
         that" are two different questions, and the second one is the whole
         difference between "nothing published yet" and "that name is wrong". */
      repoSource: repoSource(),
      path: path(),
      hasToken: hasWriteToken(),
      tokenFromVault: !!vaultToken,
      unlocked: !!(BT.crypto && BT.crypto.isUnlocked()),
      enrolled: enrolled(),
      lastPushAt: await BT.repo.metaGet('cloud.lastPushAt'),
      lastPullAt: await BT.repo.metaGet('cloud.lastPullAt'),
    };
  }

  async function verifyToken() {
    if (!hasWriteToken()) return { ok: false, reason: 'No token set.' };
    const r = repo();
    if (!r) return { ok: false, reason: 'No repository set.' };
    try {
      const res = await fetch(`https://api.github.com/repos/${r}`, {
        headers: ghHeaders(), cache: 'no-store', credentials: 'omit',
      });
      if (!res.ok) return { ok: false, reason: await ghError(res) };
      const body = await res.json();
      if (!body.permissions || !body.permissions.push) {
        return { ok: false, reason: 'That token can read this repository but not write to it. It needs Contents: read and write.' };
      }
      return { ok: true, reason: `Can write to ${body.full_name}.` };
    } catch (e) {
      return { ok: false, reason: 'Could not reach GitHub.' };
    }
  }

  function clearToken() {
    try { localStorage.removeItem(LS_TOKEN); } catch (_) {}
    BT.repo.metaSet('cloud.sha', null);
  }

  /* Return this device to being an ordinary local-first BookTrak: the derived
     key, both copies of the token and the enrolment flag all go, so the next
     load starts the app with no gate at all.

     IT OWNS THE CLEARING BECAUSE IT OWNS THE STATE. Every one of those four
     things is written by this module or by 15-crypto, and a caller that forgot
     one would leave a device that looks signed out and is not — a stale
     `bt.gh.token.v1` alone is enough to make enrolled() true again and put the
     passphrase screen back on the next load with no way to explain itself.
     Callers add the reload; the state change and the page reload are separate
     decisions and only one of them belongs here.

     What it deliberately does NOT do: touch the library. Not the copy in this
     browser, not the file in the repository. Signing out is not a delete, and
     the confirmation in Settings promises exactly that. */
  function signOut() {
    if (BT.crypto && BT.crypto.lock) BT.crypto.lock();
    setVaultToken(null);
    clearToken();
    setEnrolled(false);
  }

  return {
    repo, setRepo, repoSource, token, setToken, hasToken, clearToken, path, configured,
    enrolled, setEnrolled, expectPublished, signOut,
    tokenForWrite, setVaultToken, hasWriteToken,
    pullEnvelope, push, publish, restore, syncDown, checkConflict, changePassphrase, mergeDocs,
    peek, status, verifyToken,
  };
})();
