# js/vendor — third-party code

Everything in this directory is **someone else's**. That is the entire reason
it lives here rather than under a number: the numeric prefixes on `js/*.js`
describe BookTrak's own dependency graph, and slotting a foreign bundle into
that sequence would imply we may renumber, reformat or refactor it. We may not.
These files are byte-for-byte what the publisher shipped.

Nothing here is fetched at runtime. There is no CDN tag anywhere in
`index.html`, and there must never be one — see **The `locateFile` override**
below, which is the one place that rule takes active work to keep.

---

## barcode-detector-3.2.1.min.js

| | |
|---|---|
| Package | `barcode-detector` |
| Version | **3.2.1** (exact, pinned) |
| Licence | MIT — © Sec (`hi@sec.gd`) |
| Source | <https://www.npmjs.com/package/barcode-detector> · <https://github.com/Sec-ant/barcode-detector> |
| Fetched from | `https://cdn.jsdelivr.net/npm/barcode-detector@3.2.1/dist/iife/ponyfill.js` |
| Build | the **IIFE ponyfill** build (`dist/iife/ponyfill.js`) |
| Size | **44,128 bytes** |
| SHA-256 | `af748f0a12ee63ccd2a92276d9cf0bff0c8e5e76363605f04d103309a1be5ad9` |
| Global | `window.BarcodeDetectionAPI` |

Exports on that global:

- `BarcodeDetectionAPI.BarcodeDetector` — the ponyfill class. Same shape as the
  WICG `BarcodeDetector`: `new BarcodeDetector({ formats })`, `detect(source)`,
  `static getSupportedFormats()`.
- `BarcodeDetectionAPI.prepareZXingModule(opts)` — see below. **Load-bearing.**
- `BarcodeDetectionAPI.purgeZXingModule()`, `setZXingModuleOverrides()`
- `ZXING_WASM_VERSION` (`"3.1.1"`), `ZXING_CPP_COMMIT`, `ZXING_WASM_SHA256`

**Why the *ponyfill* build and not the polyfill build.** The polyfill build
assigns to `globalThis.BarcodeDetector`, which would make it impossible to tell
the native detector from the shim — and the three-layered detector selection in
`js/58-scanner.js` depends on being able to. The ponyfill keeps its class on its
own namespace and touches nothing global.

**Why the IIFE build and not ESM.** `index.html` loads classic scripts in
numeric order because module scripts are blocked on `file://`, and opening this
folder from disk has to keep working.

**Why it is vendored at all.** Three reasons, in order of how expensive each one
is to discover the hard way:

1. `BarcodeDetector` **does not exist** on Chrome or Edge for Windows or Linux
   desktop — the constructor is `undefined`, not merely limited. It ships on
   macOS, ChromeOS and Android-with-Play-Services and nowhere else. So this
   bundle is the **primary** decode path on the machine this app is developed
   on, not a fallback, and it is what has to be tested.
2. A CDN tag would put a third party between a reader and their own camera, on
   the one screen where a permission prompt is already asking them for trust.
3. A pinned local copy is the only version that cannot change under us between
   two page loads. The version is in the filename so that an upgrade is a
   visible diff rather than a silent one.

---

## zxing_reader-3.1.1.wasm

| | |
|---|---|
| Package | `zxing-wasm` (reader build), a dependency of `barcode-detector` |
| Version | **3.1.1** (exact — must match `ZXING_WASM_VERSION` above) |
| Licence | Apache-2.0 — the wasm is a build of **zxing-cpp** (Apache-2.0); the `zxing-wasm` wrapper is MIT © Ze-Zheng Wu |
| Source | <https://www.npmjs.com/package/zxing-wasm> · <https://github.com/Sec-ant/zxing-wasm> · upstream <https://github.com/zxing-cpp/zxing-cpp> |
| Fetched from | `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.1/dist/reader/zxing_reader.wasm` |
| Size | **1,065,634 bytes** |
| SHA-256 | `6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f` |
| Verified | first four bytes are `00 61 73 6D` (`\0asm`), the WebAssembly magic number |

Renamed from `zxing_reader.wasm` to carry its version, for the same reason the
JS bundle carries its own: an upgrade must be a visible diff. The rename is
**why the override below is required rather than merely advisable** — the
bundle asks its loader for the literal name `zxing_reader.wasm`.

---

## The `locateFile` override — REQUIRED, and not optional

The ponyfill contains a **hardcoded CDN default** for its wasm. It is in the
minified file; `grep jsdelivr js/vendor/barcode-detector-3.2.1.min.js` finds it:

```js
locateFile: (e, t) => {
  let n = e.match(/_(.+?)\.wasm$/);
  return n ? `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.1/dist/${n[1]}/${e}` : t + e;
}
```

Left alone, the **first decode of the session fetches a megabyte of executable
code from `fastly.jsdelivr.net`.** That breaks three things at once:

- **Offline.** BookTrak is local-first. A scanner that needs the internet to
  read a number printed on the book in your hand is not.
- **The no-third-party-runtime rule.** Nothing in this app may reach a host the
  reader did not choose — least of all on the scan screen, where the browser's
  own camera-permission prompt is on screen asking for trust.
- **Reproducibility.** A remote binary can change between two page loads. A
  pinned local one cannot.

So `js/58-scanner.js` calls this **before any decode**, memoised so the module
is only ever instantiated once:

```js
BarcodeDetectionAPI.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm')
        ? new URL('js/vendor/zxing_reader-3.1.1.wasm', document.baseURI).href
        : prefix + path,
  },
  fireImmediately: true,
});
```

Three details, each of which is a real failure if changed:

- **`document.baseURI`, never a leading `/`.** BookTrak is published to GitHub
  Pages under the subpath **`/Lorelaibrary/`**. An absolute `/js/vendor/…`
  resolves to the domain root there and 404s — while working perfectly in local
  testing, which is the worst possible split.
- **`path.endsWith('.wasm')`, not `path === 'zxing_reader.wasm'`.** Our copy is
  version-stamped, so the name the bundle asks for and the name on disk never
  match. The suffix test is what bridges them.
- **`fireImmediately: true`.** Without it the call only *records* the overrides;
  the module is built later, and the first `detect()` builds it with whatever
  defaults were in force — i.e. the CDN. The override would take effect on the
  module *after next*, which is a bug that looks like it works.

### How this is verified

`js/58-scanner.js` exports `prepare()` and `decode(source)` alongside its four
public methods precisely so the decode path can be driven with no camera
attached. The scan milestone's test asserts that **no request URL recorded
during a full page session contains `jsdelivr`**, and that the wasm is fetched
from `js/vendor/`. If that assertion ever fails, this override is the first
thing to look at.

---

## Upgrading

1. Both files move together. `barcode-detector` pins an exact `zxing-wasm`
   version; check `ZXING_WASM_VERSION` in the new bundle and fetch the matching
   `dist/reader/zxing_reader.wasm`.
2. Rename the wasm to `zxing_reader-<version>.wasm` and the bundle to
   `barcode-detector-<version>.min.js`.
3. Update `WASM_PATH` in `js/58-scanner.js`, the `<script src>` in
   `index.html`, and this file — sizes and hashes included.
4. Re-run the milestone verification. The `jsdelivr` assertion and the
   headless EAN-13 decode are the two that catch a bad upgrade.
