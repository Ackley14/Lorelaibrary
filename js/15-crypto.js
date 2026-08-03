/* ══════════════════════════════════════════════════════════════════════════
   Passphrase encryption for the synced library.

   Why encrypt rather than store a password hash:

   A hash would let the app say "wrong password" — but on a static site that
   check runs in JavaScript the visitor controls, so it stops nobody, and the
   hash itself sits in a public repo waiting to be cracked offline. Encrypting
   the library instead makes the question moot. There is no verifier to check
   and no hash to steal; the file is ciphertext, and a wrong passphrase simply
   fails to produce plaintext.

   The check falls out of the cryptography for free: AES-GCM is authenticated,
   so a key derived from the wrong passphrase fails the tag check and
   decryption throws. That IS the login, and it cannot be bypassed by editing
   the page, because there is nothing to bypass — without the key the bytes
   are noise.

   Nothing derived from the passphrase is ever committed, stored, or
   transmitted. Only the salt (which is public by design) and the ciphertext.

   Primitives: PBKDF2-HMAC-SHA256 at 600,000 iterations (the OWASP guidance
   for this KDF), AES-256-GCM with a fresh 96-bit IV per save. WebCrypto has
   no Argon2, and PBKDF2 is the strongest thing it does offer.

   ── THE PREFIX IS LOAD-BEARING ───────────────────────────────────────────
   `bt.key.v1`, not `mt.key.v1`. BookTrak ships from
   ackley14.github.io/Lorelaibrary and MovieTrak from /entertainmentwatch —
   the SAME browser origin, because localStorage is scoped to the origin and
   not the path. A missed rename here would not fail loudly: this app would
   pick up the sibling app's derived key, fail to decrypt its own library, and
   report a wrong passphrase for a passphrase that was right. Every key this
   file touches starts `bt.`.
   ══════════════════════════════════════════════════════════════════════════ */

BT.crypto = (function () {
  const ITERATIONS = 600000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  const LS_KEY = 'bt.key.v1';

  /* Held in memory for the session only. Never written to disk unless the
     user explicitly asks to stay unlocked on this device. */
  let sessionKey = null;
  let sessionSalt = null;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function available() {
    return !!(window.crypto && window.crypto.subtle && window.crypto.subtle.deriveKey);
  }

  /* Base64 that survives non-ASCII. btoa() on a raw JS string silently
     corrupts anything above U+00FF — and a book library is full of them.
     Titles (Les Misérables, Ficciones, Kokoro), authors (Gabriel García
     Márquez, Natsume Sōseki, Karel Čapek) and publisher imprints all carry
     accents, and the payload also holds the GitHub token that makes saving
     work. So this path is not optional: the failure it prevents is a library
     that encrypts cleanly, decrypts to mojibake, and takes the write token
     down with it. */
  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;                    // spreading a large array overflows the stack
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt) {
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      true,                                   // extractable, so "stay unlocked" can cache it
      ['encrypt', 'decrypt']);
  }

  /* Deriving at 600k iterations takes roughly a second, which is the point —
     it is the same second for an attacker, per guess. Callers should show a
     spinner rather than trying to make it faster. */
  async function unlock(passphrase, saltB64In) {
    if (!available()) throw new Error('This browser does not support WebCrypto, so encrypted sync is unavailable.');
    const salt = saltB64In ? b64ToBytes(saltB64In) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    sessionKey = await deriveKey(passphrase, salt);
    sessionSalt = salt;
    return bytesToB64(salt);
  }

  /* Derive a key WITHOUT installing it. Changing a passphrase has to re-encrypt
     and successfully publish before the old key is thrown away — otherwise a
     failed write locks the user out of their own library. */
  async function deriveStandalone(passphrase) {
    if (!available()) throw new Error('WebCrypto unavailable.');
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    return { key: await deriveKey(passphrase, salt), salt };
  }

  /* Encrypt with a key that is not the session key. Same envelope shape. */
  async function encryptWithKey(key, salt, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
      enc.encode(JSON.stringify(obj)));
    return {
      app: 'booktrak', kind: 'booktrak.encrypted', v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: bytesToB64(salt) },
      cipher: 'AES-GCM', iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)),
      updatedAt: new Date().toISOString(),
      counts: obj && obj.counts ? obj.counts : undefined,
    };
  }

  /* Install a key that has already proved itself by encrypting and publishing. */
  function adopt(key, salt) { sessionKey = key; sessionSalt = salt; }

  function lock() {
    sessionKey = null;
    sessionSalt = null;
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
  }

  const isUnlocked = () => !!sessionKey;
  const saltB64 = () => (sessionSalt ? bytesToB64(sessionSalt) : null);

  async function encryptJson(obj) {
    if (!sessionKey) throw new Error('Locked — enter your passphrase first.');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plain = enc.encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, plain);
    return {
      app: 'booktrak',
      kind: 'booktrak.encrypted',
      v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: bytesToB64(sessionSalt) },
      cipher: 'AES-GCM',
      iv: bytesToB64(iv),
      ct: bytesToB64(new Uint8Array(ct)),
      /* Deliberately outside the ciphertext so the app can show "last synced"
         and decide whether a pull is needed WITHOUT the passphrase. Nothing
         here is sensitive: a book count and a timestamp. It is also what lets
         the unlock screen say what it is about to restore, and what lets a
         save detect that another device wrote first. */
      updatedAt: new Date().toISOString(),
      counts: obj && obj.counts ? obj.counts : undefined,
    };
  }

  async function decryptJson(envelope) {
    if (!envelope || envelope.kind !== 'booktrak.encrypted') {
      /* Named specifically for the sibling app, the same way the Import screen
         does: one origin, two libraries, and 'movietrak.encrypted' is the file
         most likely to be pointed at this by mistake. */
      if (envelope && envelope.kind === 'movietrak.encrypted') {
        throw new Error('That is a MovieTrak library. The two apps share an origin but not a library.');
      }
      throw new Error('That file is not an encrypted BookTrak library.');
    }
    if (envelope.v !== 1) throw new Error(`Unsupported encryption version ${envelope.v}.`);
    if (!sessionKey) throw new Error('Locked — enter your passphrase first.');
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, sessionKey, b64ToBytes(envelope.ct));
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      /* AES-GCM authentication failed. In practice this always means the wrong
         passphrase; it would also catch a corrupted or tampered file, which is
         exactly the behaviour we want either way. */
      throw new Error('That passphrase did not unlock the library.');
    }
  }

  /* The salt must match the one the library was encrypted with, so it is read
     from the envelope before unlocking. It is public by design — a salt is not
     a secret, it exists to stop precomputed-table attacks. */
  function saltFromEnvelope(envelope) {
    return envelope && envelope.kdf && envelope.kdf.salt;
  }

  /* Optional convenience: keep the derived key on this device so the passphrase
     is not needed on every visit. This trades the "nothing at rest" property
     for not retyping — offered explicitly, never by default. */
  async function rememberOnDevice() {
    if (!sessionKey) return false;
    try {
      const raw = await crypto.subtle.exportKey('raw', sessionKey);
      localStorage.setItem(LS_KEY, JSON.stringify({
        k: bytesToB64(new Uint8Array(raw)), s: bytesToB64(sessionSalt),
      }));
      return true;
    } catch (e) { return false; }
  }

  async function restoreFromDevice() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const { k, s } = JSON.parse(raw);
      sessionKey = await crypto.subtle.importKey(
        'raw', b64ToBytes(k), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      sessionSalt = b64ToBytes(s);
      return true;
    } catch (e) { return false; }
  }

  const isRemembered = () => { try { return !!localStorage.getItem(LS_KEY); } catch (_) { return false; } };

  /* Rough, honest strength feedback. Deliberately weights length over
     character classes, which is what actually resists an offline attack on a
     downloadable file. */
  function strength(pass) {
    if (!pass) return { score: 0, label: 'Empty', hint: '' };
    const len = pass.length;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(pass)).length;
    const words = pass.trim().split(/\s+/).length;
    let score = 0;
    if (len >= 8) score++;
    if (len >= 12) score++;
    if (len >= 20 || words >= 4) score++;
    if (classes >= 3) score++;
    if (len < 8) score = 0;
    const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
    return {
      score,
      label: labels[Math.min(score, 4)],
      hint: score < 3
        ? 'Four unrelated words make a far better passphrase than one clever word. This file will be public, so length is what protects it.'
        : '',
    };
  }

  return {
    available, unlock, lock, isUnlocked, saltB64,
    deriveStandalone, encryptWithKey, adopt,
    encryptJson, decryptJson, saltFromEnvelope,
    rememberOnDevice, restoreFromDevice, isRemembered,
    strength, bytesToB64, b64ToBytes, ITERATIONS,
  };
})();
