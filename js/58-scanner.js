/* ══════════════════════════════════════════════════════════════════════════
   BT.scanner — the camera, the decoder, and the accept gate.

   THREE FILES MAKE SCANNING WORK AND THIS IS THE FIRST. The line between them
   is what stops any of the three being rewritten by accident:

     this file      hardware. A MediaStream, a decode loop, and the rule that
                    decides a read is real. It knows nothing about a library:
                    it hands out thirteen-digit strings and that is all.
     39-scan.js     what a thirteen-digit number MEANS against the shelves —
                    pinned vs candidate, the writes, the queue, the undo.
     75-view-scan.js  the screen: mode, manual entry, the log, the prompt.

   Nothing here writes to the repository, and nothing here decides what a
   barcode means. `onCode` is the whole output.

   ── WHY THE DECODER IS VENDORED AND WHY THAT IS THE PRIMARY PATH ──────────
   `BarcodeDetector` DOES NOT EXIST on Chrome or Edge for Windows or Linux
   desktop — the constructor is undefined, not merely unsupported. The native
   API ships on macOS, ChromeOS, and Android with Play Services, and nowhere
   else. So the vendored ZXing ponyfill in js/vendor/ is the path that actually
   runs on the machine this app is developed on, and it is the path that has to
   be tested; the native detector is the optimisation, not the baseline.

   ── NOTHING HERE MAY TOUCH location.hash ──────────────────────────────────
   An iOS standalone home-screen PWA REVOKES camera permission the moment the
   hash changes (WebKit 215884, still open — no fix, no workaround from our
   side), and it cannot be re-granted from inside the app. That is why the
   scanner is an overlay rather than a route, why it calls BT.router.suspend()
   before getUserMedia and resume() after the tracks are stopped, and why every
   track is stopped before anything is allowed to navigate.

   ── THE ELEMENT IS DESTROYED, NEVER HIDDEN ────────────────────────────────
   Same rule as MovieTrak's trailer modal, for a sharper reason: a hidden
   <video> holding a live MediaStream keeps the camera light on. Clearing
   `src`/`srcObject` is not enough either — the TRACKS have to be stopped and
   the element removed. On close this overlay stops every track, drops
   srcObject, and empties its host.
   ══════════════════════════════════════════════════════════════════════════ */

BT.scanner = (function () {
  const esc = BT.util.escapeHtml;

  /* ── The wasm, and the CDN that is NOT allowed to serve it ───────────────
     The vendored ponyfill carries a hardcoded default of
     `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.1/dist/reader/…` for its
     wasm binary (it is in the minified file; grep for jsdelivr). Left alone,
     the one screen where a permission prompt is already asking the reader for
     trust would fetch a megabyte of executable code from a foreign origin —
     and the app would stop working offline, which is most of what "local
     first" is for. The project's no-third-party-runtime rule says the same
     thing more briefly.

     RELATIVE TO document.baseURI, never to the origin root. BookTrak is
     published under the SUBPATH /Lorelaibrary/ on GitHub Pages, so an absolute
     '/js/vendor/…' is a 404 there and works only in local testing — the worst
     possible split. */
  const WASM_PATH = 'js/vendor/zxing_reader-3.1.1.wasm';

  const wasmUrl = () => new URL(WASM_PATH, document.baseURI).href;

  /* UPC-A is here because 01-util.js already widens one: older US printings
     and book-club editions carry a 12-digit symbol, and an EAN-13 with a
     leading zero IS a UPC-A. EAN-5 is deliberately absent — the price add-on
     beside the ISBN is not a code we want offered as a candidate. */
  const FORMATS = ['ean_13', 'upc_a'];

  /* ~10 frames a second. The camera delivers 30–60, and decoding every one of
     them is heat, battery and a stuttering preview for no gain: a person
     holding a book still cannot present a genuinely different image faster
     than this. */
  const DECODE_MS = 100;

  /* The centre band, as a fraction of frame height. Cropping is worth about
     three times less work per decode, but the real reason is accuracy: the
     band excludes the EAN-5 price add-on printed beside the ISBN and the cover
     art above it, both of which give the decoder something else to find. */
  const ROI_H = 0.30;

  /* TWO CONSECUTIVE IDENTICAL DECODES. An EAN-13 check digit is a single
     mod-10 sum: it catches every single-digit error but only ~90% of the
     transpositions and multi-digit corruptions a blurred frame produces, and a
     live camera re-reads the same symbol thirty times a second — so a corrupt
     read that happens to check clean WILL eventually appear. Requiring the
     same normalized code twice in a row costs a tenth of a second and removes
     the whole class. */
  const STREAK = 2;

  /* …and the debounce behind it, because after acceptance the same barcode is
     still under the lens. 39-scan.js restates this rule for the same reason
     (defence in depth: it also guards the manual and wedge doors). */
  const DEBOUNCE_MS = 2000;

  /* ── State ───────────────────────────────────────────────────────────────
     All of it is torn down by close(); there is exactly one overlay. */
  let host = null;
  let video = null;
  let stream = null;
  let track = null;
  let canvas = null;
  let ctx = null;
  let opened = false;
  let session = null;          // { opts, resolve, codes, closing }
  let lastFocus = null;
  let rafId = 0;
  let vfcId = 0;
  let decoding = false;
  let lastDecodeAt = 0;
  let torchOn = false;

  /* The accept gate's memory. Reset on every open, so a new session never
     inherits "you just scanned this" from the last one. */
  let streakCode = '';
  let streakN = 0;
  let lastAccepted = '';
  let lastFiredAt = 0;
  let lastHint = '';
  let lastHintAt = 0;

  /* ══ AVAILABILITY ════════════════════════════════════════════════════════
     Asked by 75-view-scan and 56-inspector BEFORE they draw a control, and
     that is the point: when this is false the caller renders no button at all.
     A camera button that opens an overlay only to apologise is worse than no
     button, because the reader has to discover the rule by failing at it.

     Two conditions and both are about the ADDRESS rather than the device.
     getUserMedia is gated on a secure context — https, or http://localhost —
     so a double-clicked file:// copy and a LAN address like 192.168.1.x never
     get a camera however many webcams are attached. `navigator.mediaDevices`
     is itself undefined in an insecure context on Chrome, so the second test
     is not redundant on every browser but is on some; both are cheap. */
  function isAvailable() {
    if (!window.isSecureContext) return false;
    const md = navigator.mediaDevices;
    return !!(md && typeof md.getUserMedia === 'function');
  }

  const isOpen = () => opened;

  /* Hidden on iOS at the request of the platform rather than of taste: Safari
     exposes no `torch` constraint at all (getCapabilities either does not
     exist or omits it), so the control could only ever be a dead switch. */
  function isIOS() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    /* iPadOS 13+ reports itself as a Mac. The touch count is the only
       distinguishing signal that has held up. */
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  }

  /* ══ THE DECODER ═════════════════════════════════════════════════════════ */

  /* THE CDN KILL. Must run before the ponyfill instantiates its wasm, which is
     why every path into a decode goes through here first and why it is
     memoised rather than re-derived: `prepareZXingModule` compares overrides
     by value and would happily instantiate a SECOND module — another megabyte
     — if handed a fresh object after the first was already built.

     `fireImmediately: true` means "instantiate now and hand me the promise",
     rather than merely recording the overrides for later. That matters here
     because the failure we are guarding against is silent: without it the
     first detect() would build the module with whatever defaults were in
     force, and the override would apply to the module after next. */
  let modulePromise = null;

  function prepare() {
    if (modulePromise) return modulePromise;
    const API = window.BarcodeDetectionAPI;
    if (!API || typeof API.prepareZXingModule !== 'function') {
      modulePromise = Promise.reject(new Error(
        'The vendored barcode decoder (js/vendor/barcode-detector-3.2.1.min.js) is not on this page.'));
      /* Memoising a rejection means nobody is listening at the moment it is
         created; say so once here so it is not reported as unhandled. */
      modulePromise.catch(() => {});
      return modulePromise;
    }
    modulePromise = Promise.resolve(API.prepareZXingModule({
      overrides: {
        /* `path` arrives as the bare 'zxing_reader.wasm' the emscripten glue
           asks for; `prefix` is the script's own directory. The endsWith test
           rather than an equality test is deliberate — the binary in this
           repository is version-stamped (zxing_reader-3.1.1.wasm, so that an
           upgrade is a visible diff) and will never equal the name the bundle
           asks for. */
        locateFile: (path, prefix) =>
          path.endsWith('.wasm') ? wasmUrl() : prefix + path,
      },
      fireImmediately: true,
    }));
    modulePromise.catch(() => {});
    return modulePromise;
  }

  /* ── Three-layered detector selection ────────────────────────────────────
     Each layer exists because the one above it lies on some real browser:

       1 · `'BarcodeDetector' in window` — false on Chrome and Edge for Windows
           and Linux desktop, where the constructor genuinely does not exist.
       2 · `getSupportedFormats()` — the constructor can exist and the platform
           still decode nothing. On several Android builds this resolves to an
           EMPTY ARRAY, and `new BarcodeDetector({formats:['ean_13']})` then
           throws or silently never matches.
       3 · the first real `detect()` — which can still throw NotSupportedError
           after both checks passed, because the format support is decided by a
           downloadable Play Services module that may not be installed. That is
           a PERMANENT demotion: retrying it every frame would cost an
           exception per frame for the rest of the session.

     All three end in the same place: the vendored ponyfill, which is the
     primary path on desktop anyway. */
  let nativeDead = false;
  let nativeProbe = null;

  function vetNative() {
    if (nativeDead) return Promise.resolve(null);
    if (nativeProbe) return nativeProbe;
    nativeProbe = (async () => {
      if (!('BarcodeDetector' in window)) { nativeDead = true; return null; }
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const usable = Array.isArray(formats) ? FORMATS.filter(f => formats.includes(f)) : [];
        /* ean_13 specifically. A platform offering only qr_code is no use to a
           book scanner, and constructing with an empty format list means "all
           formats" on some implementations — which is slower and noisier. */
        if (!usable.includes('ean_13')) { nativeDead = true; return null; }
        return new window.BarcodeDetector({ formats: usable });
      } catch (e) {
        console.info('[scanner] the native BarcodeDetector declined; using the vendored decoder', e);
        nativeDead = true;
        return null;
      }
    })();
    return nativeProbe;
  }

  let pony = null;

  async function vetPonyfill() {
    if (pony) return pony;
    const API = window.BarcodeDetectionAPI;
    if (!API || typeof API.BarcodeDetector !== 'function') {
      throw new Error('The vendored barcode decoder is not on this page.');
    }
    /* Before construction, not merely before detect(): the module is built
       lazily and the overrides have to be in force when it is. */
    await prepare();
    pony = new API.BarcodeDetector({ formats: FORMATS });
    return pony;
  }

  /* One decode of one image source, through whichever detector survived the
     vetting. Exported (see the return block) so that the decode path can be
     exercised without a camera. */
  async function detect(source) {
    const nat = await vetNative();
    if (nat) {
      try { return await nat.detect(source); }
      catch (e) {
        if (!e || e.name !== 'NotSupportedError') throw e;
        /* Layer 3. Permanent, and the same frame is retried below rather than
           dropped — the reader is holding the book right now. */
        console.info('[scanner] native detect() reported NotSupportedError; falling back for the rest of the session');
        nativeDead = true;
        nativeProbe = Promise.resolve(null);
      }
    }
    const p = await vetPonyfill();
    return p.detect(source);
  }

  async function decode(source) {
    const found = await detect(source);
    return (found || []).map(r => (r && r.rawValue) || '').filter(Boolean);
  }

  /* ══ THE OVERLAY ═════════════════════════════════════════════════════════ */

  /* index.html ships an empty `<div class="scanner" id="scanner" hidden>` as a
     sibling of .app, so that opening the camera never rewrites the pane
     underneath. Created here if it is missing, so this module still works on a
     page that predates that markup. */
  function el() {
    if (host && host.isConnected) return host;
    host = document.getElementById('scanner');
    if (!host) {
      host = document.createElement('div');
      host.className = 'scanner';
      host.id = 'scanner';
      document.body.appendChild(host);
    }
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.hidden = true;
    return host;
  }

  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const ICON_TORCH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M13 2L4.5 13H11l-1 9 8.5-11H12z"/></svg>';

  function titleFor(o) {
    if (o.title && o.reason === 'pin-edition') return 'Scan the copy you own';
    if (o.title) return o.title;
    return o.mode === 'remove' ? 'Scan to remove' : 'Scan a barcode';
  }

  function hintFor(o) {
    if (o.reason === 'pin-edition') {
      return o.title
        ? `Pinning <b>${esc(BT.util.truncate(o.title, 48))}</b> to the printing you are holding.`
        : 'One barcode, then this closes.';
    }
    return o.mode === 'remove'
      ? 'Every barcode read here <b>removes</b> that book.'
      : 'Hold the barcode inside the band, about a hand’s width away.';
  }

  function paint(o) {
    const h = el();
    h.innerHTML = `
      <div class="scanner-card" role="document">
        <div class="scanner-bar">
          <div class="scanner-title">${esc(titleFor(o))}</div>
          <button class="btn btn--sm scanner-torch" type="button" data-scan-torch
                  aria-pressed="false" hidden>${ICON_TORCH}<span>Light</span></button>
          <button class="scanner-close" type="button" data-scan-close aria-label="Close the scanner">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="scanner-view" id="scannerView">
          <div class="scanner-roi" aria-hidden="true"></div>
          <div class="scanner-hint">${hintFor(o)}</div>
        </div>
        <div class="scanner-status" id="scannerStatus" role="status" aria-live="polite"></div>
      </div>`;

    h.hidden = false;
    document.documentElement.classList.add('has-scanner');

    h.onclick = e => {
      if (e.target.closest('[data-scan-close]')) { close(); return; }
      if (e.target.closest('[data-scan-torch]')) { toggleTorch(); return; }
      /* The card swallows its own clicks, so anything landing on the backdrop
         is a click outside it. */
      if (e.target === h) close();
    };

    const btn = h.querySelector('[data-scan-close]');
    if (btn) btn.focus();
  }

  function say(html, bad) {
    const el2 = document.getElementById('scannerStatus');
    if (!el2) return;
    el2.className = 'scanner-status' + (bad ? ' bad' : '');
    el2.innerHTML = html;
  }

  /* ── Errors, told apart ──────────────────────────────────────────────────
     One sentence for all of these was the most confusing thing about the first
     cut: "denied", "there is no camera" and "the address is wrong" ask the
     reader to do three completely different things, and only one of them is
     even about permissions. */
  function excuse(e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return '<b>Camera access was refused.</b> Nothing is broken — the browser asked and the answer '
        + 'was no, or the prompt was dismissed. Re-allow the camera for this site in the address bar '
        + '(the icon at the left of it), then open the scanner again. Typing the ISBN works meanwhile.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '<b>No camera on this device.</b> The address is a secure one, so the permission itself is '
        + 'available — there simply is no camera to hand out. Type the thirteen digits under the barcode instead.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '<b>The camera is busy.</b> Another application or another tab is holding it. Close that one '
        + 'and try again — only one program at a time gets the device.';
    }
    if (name === 'OverconstrainedError') {
      return '<b>No camera matched what was asked for.</b> That should not happen — every constraint here '
        + 'is an <code>ideal</code> rather than an <code>exact</code> — so please report it.';
    }
    if (name === 'SecurityError') {
      return '<b>This page is not a secure context.</b> Browsers hand out a camera over HTTPS and '
        + '<code>http://localhost</code> only; <code>file://</code> and a LAN address like '
        + '<code>192.168.1.x</code> never qualify, however much the network is your own.';
    }
    return `<b>The camera would not start.</b> ${esc((e && e.message) || String(e))}`;
  }

  /* ══ OPEN ════════════════════════════════════════════════════════════════ */

  /* Resolves when the overlay CLOSES, not when it opens — 56-inspector reads
     that as "the reader cancelled" and 75-view-scan simply awaits it for the
     duration of the session. It therefore does not reject for the ordinary
     failures: the toast layer (z 60) sits UNDER this overlay (z 150), so a
     rejection would be reported somewhere the reader physically cannot see.
     Every camera failure is drawn INSIDE the card instead, and the promise
     resolves normally when they close it. */
  function open(o) {
    o = o || {};
    /* Re-entry: a second open() replaces the first rather than stacking two
       overlays over one camera. */
    if (opened) close();

    const out = { codes: 0, reason: 'closed', error: null };
    return new Promise(resolve => {
      opened = true;
      session = { opts: o, resolve, out };
      lastFocus = document.activeElement;

      streakCode = ''; streakN = 0;
      lastAccepted = ''; lastFiredAt = 0;
      lastHint = ''; lastHintAt = 0;
      torchOn = false;

      /* BEFORE getUserMedia, and released only after every track is stopped.
         An item written by a scan calls BT.router.resolve(), which would
         otherwise rebuild the view underneath a live stream once per barcode;
         on iOS a stray go() would revoke the camera outright. The router
         REMEMBERS a navigation raised while suspended rather than dropping it,
         so "scan a book, tap through to it" still works after close. */
      if (BT.router && typeof BT.router.suspend === 'function') BT.router.suspend();

      paint(o);
      say('Starting the camera…');
      start(o).catch(e => {
        console.warn('[scanner] the camera would not start', e);
        out.reason = 'error';
        out.error = e;
        say(excuse(e), true);
      });
    });
  }

  async function start(o) {
    if (!isAvailable()) {
      /* Reached only when something opened the scanner without asking first —
         both callers hide their control on isAvailable() === false. Worth a
         real sentence anyway: it is the answer that catches everybody. */
      const e = new Error('no secure context');
      e.name = 'SecurityError';
      throw e;
    }

    /* `ideal`, NOT `exact`, on every one of these. `exact: 'environment'` is an
       OverconstrainedError on any desktop with only a front-facing webcam —
       which is every desktop — so the scanner would be dead on the machine it
       is developed on. With `ideal` the phone picks its rear camera and the
       laptop picks the only one it has.

       The resolution is the single biggest win available. A mass-market
       paperback's barcode is about 30mm wide under a glossy laminate; at
       640×480 its bars land under two pixels each and no decoder recovers
       that. 1920×1080 is ideal rather than required, so a 720p webcam simply
       gets 720p. */
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    /* Closed while the permission prompt was up. The stream still arrives, and
       an unclosed one is a camera light nobody can explain. */
    if (!opened) { stopTracks(); return; }

    track = stream.getVideoTracks()[0] || null;

    video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    /* Both spellings. The property is what modern Safari honours, the
       attribute is what older iOS needs, and without it the preview goes
       fullscreen the moment it plays. */
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.srcObject = stream;

    const viewEl = document.getElementById('scannerView');
    if (viewEl) viewEl.insertBefore(video, viewEl.firstChild);

    try { await video.play(); }
    catch (e) { console.warn('[scanner] the preview would not autoplay', e); }

    canvas = document.createElement('canvas');
    /* `willReadFrequently` is wrong here — the pixels go to the decoder as a
       canvas rather than through getImageData — but alpha is genuinely unused
       and dropping it lets the compositor skip a blend per frame. */
    ctx = canvas.getContext('2d', { alpha: false });

    paintTorch();

    /* The wasm is fetched HERE rather than at page load: it is a megabyte, and
       most sessions never open a camera. Kicked off in parallel with the first
       frames rather than awaited, so the preview is live while it lands. */
    prepare().catch(e => {
      console.error('[scanner] the decoder could not be prepared', e);
      say('<b>The decoder could not start.</b> The camera works, but nothing can be read from it. '
        + 'Type the ISBN instead.', true);
    });

    say(o.mode === 'remove'
      ? 'Ready — each barcode read here <b>removes</b> that book.'
      : 'Ready. Hold the barcode inside the band.');

    lastDecodeAt = 0;
    schedule();
  }

  /* ══ THE DECODE LOOP ═════════════════════════════════════════════════════
     requestVideoFrameCallback fires once per PRESENTED frame, which is the
     right clock: it does not run while the tab is hidden, it does not run
     while the stream is stalled, and it never decodes the same frame twice.

     Firefox does not implement it at all, so requestAnimationFrame is the
     fallback — same shape, one frame of extra latency, and the DECODE_MS
     throttle below makes the difference invisible. Feature-detected on the
     ELEMENT rather than on HTMLVideoElement.prototype, because that is the
     object the call is made against. */
  function schedule() {
    if (!opened || !video) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      vfcId = video.requestVideoFrameCallback(() => loop());
    } else {
      rafId = requestAnimationFrame(() => loop());
    }
  }

  function loop() {
    if (!opened) return;
    const now = (window.performance && performance.now()) ? performance.now() : Date.now();
    /* `decoding` is the second half of the throttle and the important half: a
       decode that takes longer than the interval must not have a second one
       queued behind it, or a slow device spirals into a backlog of frames it
       is already too late to care about. */
    if (!decoding && now - lastDecodeAt >= DECODE_MS) {
      lastDecodeAt = now;
      tick();
    }
    schedule();
  }

  /* The centre band, cropped to its own canvas. Full width — a barcode spans
     the back cover — and about a third of the height, which is what the white
     band in the viewfinder is drawn to match: the reader aims by what they can
     see, so the ROI and the guide have to be the same rectangle. */
  function roi() {
    if (!video || !canvas || !ctx) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;                 // metadata has not arrived yet
    const bandH = Math.max(1, Math.round(h * ROI_H));
    const top = Math.round((h - bandH) / 2);
    if (canvas.width !== w || canvas.height !== bandH) {
      canvas.width = w;
      canvas.height = bandH;
    }
    ctx.drawImage(video, 0, top, w, bandH, 0, 0, w, bandH);
    return canvas;
  }

  async function tick() {
    decoding = true;
    try {
      const band = roi();
      if (!band) return;
      const found = await detect(band);
      if (!opened || !found || !found.length) return;
      read(found);
    } catch (e) {
      /* A decode failure is the ordinary state of a frame pointed at a table.
         Logged once per session rather than per frame — at ten a second an
         honest console.warn here would bury everything else. */
      if (!tick.warned) { tick.warned = 1; console.warn('[scanner] a decode failed', e); }
    } finally {
      decoding = false;
    }
  }

  /* ══ THE ACCEPT GATE ═════════════════════════════════════════════════════ */

  /* Every raw read goes through BT.util.normalizeScanCode and nothing else
     decides. It already knows the four things a bare checksum test does not:
     an AIM prefix (']E0' — strip it BEFORE the digit strip or the '0' becomes
     a fourteenth digit), the EAN-5 price add-on that makes a read eighteen
     digits, UPC-A widening, and that 979-0 is ISMN — printed sheet music,
     a real barcode on a real product with nothing to look up. */
  function read(found) {
    let hint = null;
    for (const r of found) {
      const raw = (r && r.rawValue) || '';
      if (!raw) continue;
      const out = BT.util.normalizeScanCode(raw);
      if (out.ok) { gate(out.isbn13); return; }
      /* Remembered rather than shown immediately: a frame can carry the price
         add-on as well as the ISBN, and the add-on decodes first about half the
         time. Only if NOTHING in the frame was a book is there something to
         say. */
      if (!hint) hint = out.reason;
    }
    if (hint) nudge(hint);
  }

  /* Non-fatal, and throttled. Pointing the lens at a cereal box produces the
     same rejection ten times a second; saying it once every two seconds is
     help, saying it a hundred times is a strobe. */
  const NUDGE = {
    'not-a-book': 'That is a real barcode, but not a book one — Bookland is <code>978</code> or <code>979</code>.',
    ismn: 'That is an ISMN (<code>979-0</code>) — printed sheet music rather than a book.',
  };

  function nudge(reason) {
    const text = NUDGE[reason];
    /* checksum / too-short are deliberately silent: a partial read is what
       every frame looks like while the reader is still aiming, and reporting
       it would be a permanent error message during normal use. */
    if (!text) return;
    const now = Date.now();
    if (reason === lastHint && now - lastHintAt < 2000) return;
    lastHint = reason;
    lastHintAt = now;
    say(text);
  }

  function gate(code) {
    /* Compared AFTER normalization, not before. Two frames of the same book
       can differ in raw text — one carries the add-on, one does not — and
       comparing the raw strings would reset the streak on a perfectly good
       pair of reads. */
    if (code === streakCode) streakN++;
    else { streakCode = code; streakN = 1; }
    if (streakN < STREAK) {
      say(`Reading <code>${esc(code)}</code>…`);
      return;
    }

    const now = Date.now();
    /* Fire when the code is new, or when two seconds have passed since the
       last time this one did. Without it a book left under the lens is
       re-accepted ten times a second, and 39-scan's queue — one Open Library
       request per second — is buried in the first half-second. */
    if (code === lastAccepted && now - lastFiredAt <= DEBOUNCE_MS) return;
    lastAccepted = code;
    lastFiredAt = now;
    streakCode = '';
    streakN = 0;
    accept(code);
  }

  function accept(code) {
    const s = session;
    if (!s) return;
    s.out.codes++;
    say(`<code>${esc(code)}</code> — sent to the log.`);

    /* ONE SHOT. The overlay is continuous by nature — a scanning session is a
       bag of books — so "one and done" is the CALLER's need (56-inspector
       pinning the copy in hand) rather than a second mode the loop has to
       grow. The loop stops before onCode fires so that a frame already in
       flight cannot deliver a second code after the caller has closed us. */
    const once = !!s.opts.once;
    if (once) { s.out.reason = 'once'; stopLoop(); }

    if (typeof s.opts.onCode === 'function') {
      /* The caller's failure is not the scan's failure: a throwing onCode must
         not take the camera down mid-session. */
      try { s.opts.onCode(code); } catch (e) { console.error('[scanner] onCode threw', e); }
    }

    /* After onCode, never before: 56-inspector closes us from INSIDE its own
       onCode, and close() is what settles open()'s promise. Resolving first
       would hand that caller a null where its barcode should be. close() is
       idempotent, so its call and this one cannot double up. */
    if (once) close();
  }

  /* ══ TORCH ═══════════════════════════════════════════════════════════════
     Shown only where it can work, and NEVER switched on automatically. A book
     cover is laminated: an LED two inches from it puts a specular highlight
     straight across the barcode and turns a readable symbol into a white bar.
     It earns its place in a dim room and nowhere else, so it is the reader's
     decision. */
  function torchCapable() {
    if (!track || typeof track.getCapabilities !== 'function') return false;
    if (isIOS()) return false;
    let caps = null;
    try { caps = track.getCapabilities(); }
    catch (e) { return false; }
    return !!caps && 'torch' in caps;
  }

  function paintTorch() {
    const btn = document.querySelector('[data-scan-torch]');
    if (!btn) return;
    btn.hidden = !torchCapable();
    btn.setAttribute('aria-pressed', String(torchOn));
  }

  async function toggleTorch() {
    if (!track || !torchCapable()) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
      paintTorch();
    } catch (e) {
      console.warn('[scanner] the torch would not switch', e);
      say('This camera reports a light but will not switch it on.', true);
    }
  }

  /* ══ CLOSE ═══════════════════════════════════════════════════════════════
     Order matters and it is the same order every time:

       1 · stop the loop, so nothing schedules another frame against a dying
           element;
       2 · STOP EVERY TRACK. This is the one that cannot be skipped — a track
           left running is a camera light with no window attached to it, and
           clearing srcObject alone does not stop it;
       3 · destroy the <video> and empty the host. Hiding it would keep the
           element alive holding a stream, which is exactly the bug MovieTrak's
           player documents for audio;
       4 · release the router LAST, once there is provably no live stream for a
           hash change to kill.

     Idempotent on purpose: 56-inspector closes from inside onCode while accept()
     is still on the stack, and the hashchange guard below can fire at the same
     moment. */
  function close() {
    if (!opened) return;
    opened = false;

    stopLoop();
    stopTracks();

    if (video) {
      video.srcObject = null;
      if (video.parentNode) video.parentNode.removeChild(video);
      video = null;
    }
    stream = null;
    track = null;
    canvas = null;
    ctx = null;
    torchOn = false;
    decoding = false;

    if (host) {
      host.onclick = null;
      host.innerHTML = '';
      host.hidden = true;
    }
    document.documentElement.classList.remove('has-scanner');

    if (BT.router && typeof BT.router.resume === 'function') BT.router.resume();

    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* the element may be gone */ }
    }
    lastFocus = null;

    const s = session;
    session = null;
    if (s) s.resolve(s.out);
  }

  function stopLoop() {
    if (vfcId && video && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(vfcId); } catch (e) {}
    }
    if (rafId) cancelAnimationFrame(rafId);
    vfcId = 0;
    rafId = 0;
  }

  function stopTracks() {
    if (!stream) return;
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch (e) { console.warn('[scanner] a track would not stop', e); }
    }
  }

  /* ══ ESCAPE, AND EVERY OTHER WAY OUT ═════════════════════════════════════ */

  /* Capture phase, so the scanner closes before the inspector does — otherwise
     one Escape dismisses both and the pane vanishes behind a camera that is
     already gone. Same trick, same reason, as MovieTrak's player. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && opened) {
      e.stopPropagation();
      close();
    }
  }, true);

  /* The hash moved anyway — a back gesture, a link from outside, a bookmark.
     The camera has to be off BEFORE the next screen renders, both because a
     stream outliving its overlay is a light nobody can explain and because on
     iOS the permission is already being revoked as this fires. */
  window.addEventListener('hashchange', () => { if (opened) close(); });

  /* Closing the tab, backgrounding a PWA, a bfcache eviction. pagehide is the
     one that fires on iOS, where unload does not. */
  window.addEventListener('pagehide', () => { if (opened) close(); });

  return {
    open, close, isAvailable, isOpen,
    /* Not part of the contract the views use, and exported anyway: they are
       the whole decode path minus the hardware, which is the only way to prove
       the vendored decoder works — and that it never touches a CDN — on a
       machine with no camera. `prepare()` is idempotent. */
    prepare, decode,
  };
})();
