/* ══════════════════════════════════════════════════════════════════════════
   The gate.

   NUMBERED 71, NOT 70. MovieTrak's 70 slot is `70-view-unlock`; BookTrak's is
   already taken by 70-follows.js, the follow-id and bibliography module, and
   renumbering a shipped file is worse than one deliberate offset. index.html
   has said "71, not 70" since M4 — this file is that promise being kept.

   ── WHAT THE GATE IS FOR ─────────────────────────────────────────────────
   Once a device has enrolled in sync, the repository — not this browser —
   holds the library. Any device that can reach the published file and knows
   the passphrase gets the same single dataset, including the token needed to
   write changes back. Other people run their own copy by forking the repo;
   there are no user accounts here, because one repo is one library.

   Nothing is checked against a stored secret, because there isn't one. The
   passphrase derives an AES-256 key; if the file decrypts, it was right. There
   is no "wrong password" branch to bypass and no verifier in the repo to
   attack — without the key the bytes are noise.

   ── AND WHAT IT IS NOT FOR ───────────────────────────────────────────────
   BookTrak is a local-first app that happens to offer sync, and this screen
   must never make it look like an account-based one. So the gate is not shown
   because a repository could be inferred — on the published site one always
   can, `ackley14.github.io/Lorelaibrary` infers `ackley14/Lorelaibrary` for
   every visitor — it is shown because somebody on THIS device chose to sync.
   That is BT.cloud.enrolled(), it is local and synchronous, and 90-boot.js
   consults it before anything here runs. A reader who never sets a passphrase
   sees no gate, no spinner and no difference.

   Every screen below carries the same escape hatch for the same reason: a
   sync layer must never be able to stand between a reader and their own
   books.
   ══════════════════════════════════════════════════════════════════════════ */

BT.gate = (function () {
  const esc = BT.util.escapeHtml;
  let remote = null;

  const el = () => document.getElementById('gate');

  /* ── THE FOCUS TRAP ──────────────────────────────────────────────────────
     `aria-hidden` on `.app` hides the three panes from a screen reader and does
     nothing whatever to the TAB ORDER, and that combination is worse than
     neither. MEASURED before this existed: from the gate's "Not now" button,
     one Tab reached the brand link, then the two theme buttons, then the tree
     filter, then every row of the index tree — all of it announced as nothing
     at all, because we had just told the screen reader that region did not
     exist. A sighted keyboard user was typing a passphrase into a page whose
     focus had silently left the panel; a screen-reader user was moving through
     controls that report no name, no role and no value.

     Same rule and same implementation as 58-scanner.js and 59-editions.js:
     rather than enumerate focusable children — this panel has five different
     layouts and re-renders itself on every step of sign-in — pull focus back
     whenever it lands outside. Tab, Shift+Tab and a stray click behind the
     overlay are one rule. */
  let focusGuard = null;

  function show(html) {
    const g = el();
    if (!g) return;
    g.innerHTML = `<div class="gate__panel">${html}</div>`;
    g.hidden = false;
    const app = document.querySelector('.app');
    if (app) app.setAttribute('aria-hidden', 'true');

    if (!focusGuard) {
      focusGuard = e => {
        const gate = el();
        if (!gate || gate.hidden || gate.contains(e.target)) return;
        /* The first focusable control in the panel, whatever this step drew —
           the passphrase box on the sign-in screen, a link on the "no
           repository" one. The panel itself is the fallback so a step with no
           control at all still holds focus rather than handing it back to a
           page that is marked hidden. */
        const first = gate.querySelector(
          'input:not([disabled]), button:not([disabled]), a[href], select, textarea');
        if (first) { first.focus(); return; }
        const panel = gate.querySelector('.gate__panel');
        if (panel) { panel.setAttribute('tabindex', '-1'); panel.focus(); }
      };
      document.addEventListener('focusin', focusGuard, true);
    }
  }

  function hide() {
    /* Released BEFORE the panel is emptied, so the guard cannot fight whatever
       takes focus next on the screen the reader is being handed back. */
    if (focusGuard) {
      document.removeEventListener('focusin', focusGuard, true);
      focusGuard = null;
    }
    const g = el();
    if (g) { g.hidden = true; g.innerHTML = ''; }
    const app = document.querySelector('.app');
    if (app) app.removeAttribute('aria-hidden');
  }

  const isOpen = () => { const g = el(); return !!(g && !g.hidden); };

  /* THE GATE MUST NOT OUTLIVE ITS OWN ROUTE.

     hide() is reachable only from this panel's own buttons, so the back gesture
     — the primary navigation on Android and the back-swipe on iOS — changed the
     route underneath the overlay and left it standing: the app re-rendered
     behind a panel that still had `.app` marked aria-hidden and every control
     covered, and further back presses just unwound history with nothing on
     screen changing. 58-scanner.js, the app's other full-screen overlay, has
     had this listener since it was written; this file reasoned about the same
     seam in resume() (`if (/^#\/unlock\b/.test(location.hash)) …`) but only for
     the button path.

     THE TWO GUARDS ARE BOTH LOAD-BEARING:
       · `BT.router.current` — on a COLD BOOT 90-boot.js opens the gate before
         startApp(), and there the gate legitimately IS the app. Closing it on a
         hash change would drop an enrolled reader into a locked library.
       · still on #/unlock — the route's own view re-opens the gate, so closing
         it here would fight BT.viewUnlock.render. */
  window.addEventListener('hashchange', () => {
    if (!isOpen()) return;
    if (!(BT.router && BT.router.current)) return;
    if (/^#\/unlock\b/.test(location.hash || '')) return;
    hide();
  });

  /* Close the gate and hand the app back — the one exit every screen here
     uses, because getting it wrong is invisible until it is annoying.

     TWO CASES, and they need opposite things.

     COLD BOOT: 90-boot.js has not called startApp() yet, so startApp() does
     the whole job — tree, inspector, router.start() — and anything this
     function adds on top is a second render of a screen that was just drawn.

     ALREADY RUNNING: the gate was opened from #/unlock inside a live app. The
     library underneath may have just been replaced, so the tree and the view
     both have to be redrawn — but NOT with resolve(), because resolve() on
     #/unlock re-runs BT.viewUnlock.render, which re-opens the gate we are
     trying to close. It is a loop that looks like a button that does nothing.
     So that one route navigates away instead; every other route refreshes in
     place and keeps the reader where they were. */
  async function resume() {
    const running = !!(BT.router && BT.router.current);
    hide();
    await BT.boot.startApp();
    if (!running) return;
    BT.tree.refresh();
    if (/^#\/unlock\b/.test(location.hash || '')) BT.router.go('#/library');
    else BT.router.resolve();
  }

  /* Close the gate and land on a named screen. Same two cases as resume(), and
     the ORDER is what makes it safe on a cold boot: the hash is moved BEFORE
     the router exists, so router.start() resolves the destination. Moving it
     afterwards would have router.start() resolve #/unlock first, re-render this
     view, and re-open the gate the button was pressed to leave. */
  async function goto(hash) {
    const running = !!(BT.router && BT.router.current);
    hide();
    if (running) { BT.router.go(hash); await BT.boot.startApp(); return; }
    if (location.hash !== hash) location.hash = hash;
    await BT.boot.startApp();
  }

  /* Decides which screen the visitor sees. Called by 90-boot.js before the app
     starts, and by the #/unlock route once it is running. */
  async function open(opts) {
    opts = opts || {};

    /* Reachable from the #/unlock route, so it can be called on a page where
       15/16 failed to parse even though this file did not. Guarded for the same
       reason 90-boot.js guards `canGate`: a broken sync layer costs sync, never
       the library. */
    if (!BT.cloud || !BT.crypto) {
      show(`<h1>Sync is not available</h1>
        <p class="lede">The encryption modules did not load on this page, so there is nothing to
        sign in to. Your books are in this browser and everything else works normally.</p>
        <div class="actions"><button class="btn btn--primary" id="gWorkLocal">Back to the library</button></div>`);
      wireLocal();
      return;
    }

    /* NO REPOSITORY MEANS THERE IS NOTHING TO SIGN IN TO, and that is an
       ordinary state rather than a fault: it is every file:// copy, every
       localhost, and every LAN address, because owner/repo can only be inferred
       from a github.io hostname. The index tree carries a permanent "Sign in"
       entry, so this screen is reachable by one click on all of them.

       It gets its own panel because the alternative is what shipped first and
       was caught in a browser: peek() cannot read a file it has no repository
       for, so it reported an error, and the reader pressing "Sign in" on their
       laptop was met with "Could not reach your library" over a library that
       was never anywhere else. Naming the actual next step is the whole job of
       this screen. */
    if (!BT.cloud.configured()) {
      show(`
        ${brand}
        <h1>No repository set</h1>
        <p class="lede">
          Syncing publishes your library, encrypted, to a GitHub repository you own — and this copy
          of BookTrak does not know which one. It is detected automatically when the app is served
          from GitHub Pages; running it from
          <span class="mono">${esc(location.protocol === 'file:' ? 'file://' : (location.host || 'this address'))}</span>
          there is nothing to detect, so it has to be typed in.
        </p>
        <p class="lede">
          Set it under <b>Settings → Sync across machines</b>, as <span class="mono">owner/repository</span>.
          Nothing else changes in the meantime: your books are in this browser and every screen works.
        </p>
        <div class="actions">
          <a class="btn btn--primary" href="#/settings" id="gSettings">Open Settings</a>
          <button class="btn btn--ghost" id="gWorkLocal">Not now</button>
        </div>`);
      const s = document.getElementById('gSettings');
      /* The href alone would move the hash while the gate is still covering the
         app, landing the reader on a Settings screen they cannot see. */
      if (s) s.onclick = e => { e.preventDefault(); goto('#/settings'); };
      wireLocal();
      return;
    }

    if (!BT.crypto.available()) {
      show(`<h1>Encryption unavailable</h1>
        <p class="lede">This browser does not expose WebCrypto, which the shared library needs.
        That usually means the page is being served over plain http:// from something other than
        localhost.</p>
        <button class="btn" id="gWorkLocal">Work locally instead</button>`);
      wireLocal();
      return;
    }

    show(checking);
    remote = await BT.cloud.peek();

    if (opts.mode === 'token') return replaceToken();
    if (opts.mode === 'setup') return remote.unasked ? look('setup') : setup();

    /* NOTHING WAS ASKED, AND NOTHING WENT WRONG. peek() declines to fetch on a
       device where nobody has ever chosen to sync — see BT.cloud.expectPublished.
       On the published site inferRepo() names a repository for every visitor, so
       without this the sign-in screen fired three requests for a file that
       cannot exist yet and every engine printed a 404 for each of them. A 404
       here is data, not a fault, and the place to say so is this screen rather
       than the console.

       So the ambiguity peek() was being used to resolve — sign in, or set up? —
       is put to the reader instead, and the request is made once they answer.
       Guessing is not available: assuming "nothing published" would offer
       "create a library" to the owner arriving on a new laptop, and creating one
       is the single action that can publish over a library that is already
       there. */
    if (remote.unasked) return choose();

    if (remote.exists) return signIn();

    /* "NOTHING PUBLISHED YET" AND "COULD NOT REACH GITHUB" ARE NOT THE SAME
       ANSWER, and conflating them is the one bug on this screen that could
       destroy a library. peek() reports a 404 as `{exists:false}` with no
       error and a network failure as `{exists:false, error}`. Treating the
       second as the first — which is what a bare `!remote.exists` test does —
       offers "Create library" to somebody whose library is fine and simply
       unreachable, and the first thing creating one does is publish over it.
       An aeroplane, a captive-portal wifi or a GitHub outage is enough. */
    if (remote.error) return unreachable();
    return setup();
  }

  /* Write an error AND make sure it is on screen. The setup panel is taller
     than a phone, so an error placed outside the current scroll position is an
     error nobody reads — which makes the button look dead. */
  function fail(host, title, body) {
    host.innerHTML = BT.ui.errorBox(title, body);
    const box = host.firstElementChild;
    if (box) box.setAttribute('role', 'alert');
    try { host.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
  }

  const brand = '<div class="gate__brand"><b>BookTrak</b><i>Tide</i></div>';
  const checking = '<h1>Checking for your library…</h1><div class="skel skel--line" style="width:60%"></div>';

  /* ── This device has never synced, so nothing has been fetched ───────────
     The one screen here that exists because of a CONSOLE, and it is not a
     cosmetic concern: the first thing anybody opening devtools on the live
     site saw was a 404, which reads as a broken app and is the opposite of
     true. `data/library.enc.json` is absent because nobody has published one,
     which is an ordinary first-run state — but a browser prints a red line for
     a 404 before any of our code can explain it, so the only fix is not to ask.

     What is asked instead is the reader, and the two answers are the two
     things the request was being used to guess between. Both then look, which
     is the point: a 404 that arrives after somebody pressed "sign in" is
     answered on screen by nothingPublished() below, and one that arrives on a
     drive-by visit to #/unlock does not arrive at all. */
  function choose() {
    show(`
      ${brand}
      <h1>Sync this device</h1>
      <p class="lede">
        Nothing on this device has been synced yet, so BookTrak has not gone looking for a library
        in <span class="mono">${esc(BT.cloud.repo())}</span> — there is no sense asking for a file
        until somebody says they want one. Say which of these this is and it will look now.
      </p>
      <div class="actions">
        <button class="btn btn--primary" id="gHasOne">I already have a library</button>
        <button class="btn" id="gMakeOne">Set one up here</button>
        <button class="btn btn--ghost" id="gWorkLocal">Not now</button>
      </div>
      <p class="gate__note">
        Either way the books already in this browser stay exactly where they are. Signing in merges
        them with what has been published; setting up publishes them, encrypted, for the first time.
      </p>`);
    document.getElementById('gHasOne').onclick = () => look('signin');
    document.getElementById('gMakeOne').onclick = () => look('setup');
    wireLocal();
  }

  /* The reader has asked, so now we look — `onDemand` is what tells BT.cloud
     that this request was requested. `intent` decides only what an empty
     repository MEANS: somebody who came to sign in is told there is nothing
     published, and somebody who came to create one is handed the setup form.
     An error is neither, and goes to unreachable() from both. */
  async function look(intent) {
    show(checking);
    remote = await BT.cloud.peek({ onDemand: true });
    if (remote.error) return unreachable();
    if (remote.exists) return signIn();
    if (intent === 'signin') return nothingPublished();
    return setup();
  }

  /* ── The 404, said out loud ──────────────────────────────────────────────
     A repository that answered and holds no library file is not a failure and
     must not be dressed as one: it is the state every repository is in until
     the first device publishes. It gets a screen rather than a console line
     because it is the answer to something the reader just asked, and because
     the one thing it CAN mean that is worth acting on — a typo in
     owner/repository — is invisible from anywhere else. */
  function nothingPublished() {
    show(`
      ${brand}
      <h1>Nothing published yet</h1>
      <p class="lede">
        <span class="mono">${esc(BT.cloud.repo())}</span> answered, and there is no library file in
        it — so there is nothing to sign in to. That is the ordinary state of a repository nobody
        has synced to yet, not a fault: the file is created by the first device that sets sync up.
      </p>
      <div class="actions">
        <button class="btn btn--primary" id="gMakeOne">Set one up here</button>
        <button class="btn btn--ghost" id="gWorkLocal">Not now</button>
      </div>
      <p class="gate__note">
        If you were expecting a library here, check the repository under <b>Settings → Sync across
        machines</b> — a typo in <span class="mono">owner/repository</span> looks exactly like this,
        as does a private repository this browser cannot read.
      </p>`);
    document.getElementById('gMakeOne').onclick = () => setup();
    wireLocal();
  }

  /* ── Returning, or a device that has never seen this library ─────────── */
  function signIn() {
    const when = remote.updatedAt ? BT.util.timeAgo(Date.parse(remote.updatedAt)) : null;
    const n = remote.counts && remote.counts.items;
    show(`
      ${brand}
      <h1>Sign in</h1>
      <p class="lede">
        Your library lives in <span class="mono">${esc(BT.cloud.repo())}</span>${
          n != null ? ` — <b>${esc(BT.util.pluralize(n, 'book'))}</b>` : ''}${
          when ? `, last saved ${esc(when)}` : ''}.
        Enter your passphrase to open it on this device.
      </p>

      <div class="field">
        <label class="field__label" for="gpass">Passphrase</label>
        <input id="gpass" type="password" autocomplete="current-password" spellcheck="false"
               autocapitalize="none" autocorrect="off" enterkeyhint="go">
        <div class="field__state" id="gmsg" role="alert"></div>
      </div>

      <label class="gate__check">
        <input type="checkbox" id="gremember" ${BT.crypto.isRemembered() ? 'checked' : ''}>
        Stay signed in on this device
      </label>

      <div class="actions">
        <button class="btn btn--primary" id="gDo">Open library</button>
        <button class="btn btn--ghost" id="gWorkLocal">Work offline</button>
      </div>

      <p class="gate__note">
        Nothing is being checked against a stored password — there isn’t one. Your passphrase derives
        the key that decrypts the file. If it decrypts, it was right.
      </p>`);

    const pass = document.getElementById('gpass');
    const msg = document.getElementById('gmsg');
    const btn = document.getElementById('gDo');

    const attempt = async () => {
      if (!pass.value) return;
      btn.disabled = true;
      btn.textContent = 'Deriving key…';       // ~0.5–1s at 600k iterations, by design
      msg.textContent = '';
      msg.className = 'field__state';
      try {
        await BT.crypto.unlock(pass.value, remote.salt);
        btn.textContent = 'Decrypting…';
        const counts = await BT.cloud.restore(remote.envelope);
        if (document.getElementById('gremember').checked) await BT.crypto.rememberOnDevice();
        BT.cloud.setEnrolled(true);
        await resume();
        BT.ui.toast(`Signed in — ${BT.util.pluralize(counts.items || 0, 'book')}`);
      } catch (e) {
        BT.crypto.lock();
        btn.disabled = false;
        btn.textContent = 'Open library';
        msg.textContent = '✕ ' + (e.message || String(e));
        msg.className = 'field__state field__state--bad';
        pass.focus();
        pass.select();
      }
    };
    btn.onclick = attempt;
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
    pass.focus();
    wireLocal();
  }

  /* ── First run on a fresh repository ─────────────────────────────────── */
  function setup() {
    show(`
      ${brand}
      <h1>Set up your library</h1>
      <p class="lede">
        Your shelves are encrypted in this browser and saved to
        <span class="mono">${esc(BT.cloud.repo() || 'your repository')}</span>. Sign in with the same
        passphrase on any device and you get the same single library — the same books, the same
        reading progress, the same follows.
      </p>

      <div class="warnbox">
        <strong>There is no way to reset this</strong>
        The passphrase is never stored, sent, or written down anywhere — not even as a hash. That is
        what makes it safe to publish the file, and it also means that if you forget it, the library
        is gone. Put it in your password manager now.
      </div>

      <div class="field">
        <label class="field__label" for="gp1">Passphrase</label>
        <div class="field__help">Four unrelated words beat one clever word. The encrypted file is
          publicly readable and holds your GitHub token, so length is what actually protects it.</div>
        <input id="gp1" type="password" autocomplete="new-password" spellcheck="false"
               autocapitalize="none" autocorrect="off" enterkeyhint="next"
               placeholder="correct horse battery staple">
        <div class="field__state" id="gstr"></div>
      </div>

      <div class="field">
        <label class="field__label" for="gp2">Confirm</label>
        <input id="gp2" type="password" autocomplete="new-password" spellcheck="false"
               autocapitalize="none" autocorrect="off" enterkeyhint="go">
        <div class="field__state" id="gmatch"></div>
      </div>

      <div class="field">
        <label class="field__label" for="gtok">GitHub token</label>
        <div class="field__help">
          Needed so changes can be saved back. Create a
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
          scoped to <b>only this repository</b>, with <b>Contents: read and write</b>, and give it an
          expiry. It is stored inside the encrypted file, so you only enter it once — every other
          device gets it by signing in.
        </div>
        <input id="gtok" type="password" spellcheck="false" autocomplete="off" placeholder="github_pat_…">
        <div class="field__state" id="gtokmsg"></div>
      </div>

      <div id="gerr" aria-live="assertive"></div>

      <div class="actions">
        <button class="btn btn--primary" id="gCreate">Create library</button>
        <button class="btn btn--ghost" id="gWorkLocal">Skip — work offline</button>
      </div>`);

    const p1 = document.getElementById('gp1');
    const p2 = document.getElementById('gp2');
    const str = document.getElementById('gstr');
    const match = document.getElementById('gmatch');

    p1.addEventListener('input', () => {
      const s = BT.crypto.strength(p1.value);
      str.textContent = `${s.label}${s.hint ? ' — ' + s.hint : ''}`;
      str.className = 'field__state ' + (s.score >= 3 ? 'field__state--ok' : s.score >= 2 ? '' : 'field__state--bad');
    });
    p2.addEventListener('input', () => {
      if (!p2.value) { match.textContent = ''; return; }
      const ok = p1.value === p2.value;
      match.textContent = ok ? '● Matches' : '✕ Does not match';
      match.className = 'field__state ' + (ok ? 'field__state--ok' : 'field__state--bad');
    });

    for (const el2 of [p1, p2, document.getElementById('gtok')]) {
      el2.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('gCreate').click(); }
      });
    }

    document.getElementById('gCreate').onclick = async () => {
      const err = document.getElementById('gerr');
      const btn = document.getElementById('gCreate');
      const tok = document.getElementById('gtok').value.trim();
      err.innerHTML = '';

      if (p1.value !== p2.value) { fail(err, 'Not saved', 'The two passphrases do not match.'); return; }
      /* Stricter than a local-only passphrase would need to be: this one
         protects a repo-write token inside a world-readable file. */
      if (BT.crypto.strength(p1.value).score < 3) {
        fail(err, 'Too weak',
          'Because the encrypted file is public and contains your GitHub token, this needs to be a real passphrase — four unrelated words, or twenty-plus characters.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Deriving key…';
      try {
        await BT.crypto.unlock(p1.value, remote.exists ? remote.salt : null);
        if (tok) {
          btn.textContent = 'Checking token…';
          BT.cloud.setVaultToken(tok);
          const v = await BT.cloud.verifyToken();
          if (!v.ok) {
            BT.cloud.setVaultToken(null);
            btn.disabled = false; btn.textContent = 'Create library';
            fail(err, 'Token rejected', v.reason);
            return;
          }
        }
        if (BT.cloud.hasWriteToken()) {
          btn.textContent = 'Saving…';
          await BT.cloud.publish({ message: 'BookTrak: create encrypted library' });
        }
        await BT.crypto.rememberOnDevice();
        BT.cloud.setEnrolled(true);
        await resume();
        BT.ui.toast(tok ? 'Library created and saved' : 'Passphrase set — add a token in Settings to save changes');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Create library';
        fail(err, 'Could not create the library', e.message || String(e));
      }
    };
    wireLocal();
  }

  /* ── Enrolled, but the file could not be read ─────────────────────────
     Its own screen, and the reason is in open() above: the alternative is
     offering to create a library over one that already exists. The books on
     this device are the last state that was synced down, so "carry on with
     what is here" is a real and safe answer — not a degraded one. */
  function unreachable() {
    show(`
      ${brand}
      <h1>Could not reach your library</h1>
      <p class="lede">
        <span class="mono">${esc(BT.cloud.repo())}</span> did not answer, so this device cannot
        tell what the current library looks like. Nothing has been changed and nothing has been
        lost — this is almost always a network that is down or a captive-portal wifi that has not
        been signed into yet.
      </p>
      ${BT.ui.errorBox('What GitHub said', remote.error || 'No response.')}
      <div class="actions">
        <button class="btn btn--primary" id="gRetry">Try again</button>
        <button class="btn btn--ghost" id="gWorkLocal">Use the copy on this device</button>
      </div>
      <p class="gate__note">
        Deliberately not offering to create a library here. Creating one publishes over whatever is
        in the repository, and “I could not read it” is not evidence that there is nothing there.
      </p>`);
    document.getElementById('gRetry').onclick = () => open();
    wireLocal();
  }

  /* An escape hatch, not a mode. Whatever is done offline stays in this
     browser until the next successful sign-in reconciles it, and the banner
     says so rather than letting it look like everything is fine.

     Signed in already — which happens when the gate was opened from #/unlock
     inside a running app — means there is nothing to warn about: closing it is
     the whole action. */
  async function workLocal() {
    const signedIn = BT.crypto.isUnlocked();
    await resume();
    if (signedIn) return;
    BT.ui.banner(
      'Working on this device only — changes are not being saved to your repository, and will be merged the next time you sign in.',
      { actionLabel: 'Sign in', onAction: () => open() });
  }

  function wireLocal() {
    const b = document.getElementById('gWorkLocal');
    if (b) b.onclick = workLocal;
  }

  /* Tokens expire. When one does, saving stops — which is the only thing that
     can silently break the whole model, so it gets its own screen rather than
     a message the user has to decode. */
  function replaceToken() {
    show(`
      ${brand}
      <h1>Saving has stopped</h1>
      <p class="lede">GitHub rejected the stored token, so changes are no longer reaching
      <span class="mono">${esc(BT.cloud.repo())}</span>. This usually means it expired.
      Create a new one and paste it here — everything else stays as it is.</p>

      <div class="field">
        <label class="field__label" for="gtok2">New GitHub token</label>
        <div class="field__help">
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token</a>
          scoped to only this repository, with <b>Contents: read and write</b>.
        </div>
        <input id="gtok2" type="password" spellcheck="false" autocomplete="off" placeholder="github_pat_…">
        <div class="field__state" id="gtok2msg"></div>
      </div>

      <div class="actions">
        <button class="btn btn--primary" id="gSaveTok">Save token</button>
        <button class="btn btn--ghost" id="gNotNow">Not now</button>
      </div>`);

    document.getElementById('gSaveTok').onclick = async () => {
      const input = document.getElementById('gtok2');
      const msg = document.getElementById('gtok2msg');
      const btn = document.getElementById('gSaveTok');
      const t = input.value.trim();
      if (!t) return;
      btn.disabled = true; btn.textContent = 'Checking…';
      BT.cloud.setVaultToken(t);
      const v = await BT.cloud.verifyToken();
      if (!v.ok) {
        BT.cloud.setVaultToken(null);
        btn.disabled = false; btn.textContent = 'Save token';
        msg.textContent = '✕ ' + v.reason;
        msg.className = 'field__state field__state--bad';
        return;
      }
      try {
        /* `force` skips the conflict check on purpose: the token is being
           rotated INTO the payload, and a merge round trip here would need the
           very write access that is currently broken. */
        await BT.cloud.publish({ force: true, message: 'BookTrak: rotate token' });
        await resume();
        const banner = document.getElementById('banner');
        if (banner) banner.hidden = true;
        BT.ui.toast('Saving again');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Save token';
        msg.textContent = '✕ ' + (e.message || String(e));
        msg.className = 'field__state field__state--bad';
      }
    };
    document.getElementById('gNotNow').onclick = () => resume();
  }

  /* Signing out returns this device to being an ordinary local-first BookTrak.
     The state change belongs to BT.cloud, which owns every piece of it; what
     is added here is the reload, because a running app is holding a decrypted
     library in memory and half of the screen would still be describing it. */
  function signOut() {
    BT.cloud.signOut();
    location.reload();
  }

  return { open, hide, isOpen, signOut, workLocal };
})();

/* The #/unlock route re-opens the gate, so the tree entry, the Settings button
   and any bookmarked link all keep working.

   The export name is `BT.viewUnlock` because that is the name 90-boot.js
   resolves — checked against the file rather than taken from a plan, which is
   the rule that file states at the top and the reason M2 shipped a placeholder
   on the front door. `?mode=token` and `?mode=setup` reach the two screens
   that are not otherwise linked. */
BT.viewUnlock = {
  render(params, query) {
    BT.ui.crumb(['System', 'Sync']);
    BT.ui.paneActions('');
    BT.gate.open({ mode: (query && query.mode) || '' });
    return Promise.resolve();
  },
};
