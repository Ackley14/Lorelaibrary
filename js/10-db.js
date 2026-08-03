/* ══════════════════════════════════════════════════════════════════════════
   IndexedDB driver. Private to 12-repo.js — nothing else may touch BT.db.

   The database is named `booktrak`, and that name is load-bearing rather than
   cosmetic. BookTrak ships from ackley14.github.io/Lorelaibrary and MovieTrak
   from /entertainmentwatch: the SAME browser origin. IndexedDB is scoped to
   the origin, not the path, so opening `movietrak` here would not be a typo —
   it would be this app reading and upgrading the other app's library.

   Four sharp edges are designed around throughout:
     (a) Booleans are NOT valid IndexedDB keys. Every indexed flag is 0|1.
     (b) multiEntry needs a flat array of scalars and cannot be combined with a
         compound keyPath — hence the denormalised `idx.*` arrays on items.
     (c) A record whose value at an index's keyPath is `undefined` is skipped by
         that index. Used deliberately for sparse indexes (unrated books,
         system alerts with no item).
     (d) A transaction auto-commits the moment the microtask queue drains with
         no pending IDB request. So you cannot `await` anything non-IDB inside
         one — compute the whole write set first, then open the transaction.
   ══════════════════════════════════════════════════════════════════════════ */

BT.db = (function () {
  const NAME = 'booktrak';
  const VERSION = 1;

  let dbp = null;
  let mode = 'idb';                 // 'idb' | 'fallback'
  const fallback = { stores: {} };  // in-memory + localStorage mirror

  const MIGRATIONS = [
    /* v0 → v1 · the whole schema, in one step.
       MovieTrak reached the same shape across two versions because deletion
       tombstones had to be retrofitted once merging two libraries turned out to
       resurrect everything either side had deleted — a missing record and a
       deleted record look identical, so union restores the dead. BookTrak
       starts after that lesson, so `deleted` is here from the first version and
       there is no v1→v2 to write. */
    function (db) {
      const items = db.createObjectStore('items', { keyPath: 'uid' });
      /* No by_kind_status: there is exactly one kind, 'book'. MovieTrak needed
         it to keep films, TV and games apart in the same store; a compound
         index whose first component is constant is pure overhead. */
      items.createIndex('by_status_priority', ['user.status', 'user.priority']);
      items.createIndex('by_sortTitle',       'sortTitle');
      items.createIndex('by_addedAt',         'user.addedAt');
      items.createIndex('by_updatedAt',       'user.updatedAt');
      items.createIndex('by_userRating',      'user.rating');              // sparse by design
      items.createIndex('by_pubSort',         'release.sortKey');
      items.createIndex('by_refreshDue',      'tracking.refreshDueAt');
      items.createIndex('by_genre',           'idx.genreIds',      { multiEntry: true });
      items.createIndex('by_author',          'idx.authorIds',     { multiEntry: true });
      items.createIndex('by_publisher',       'idx.publisherKeys', { multiEntry: true });
      items.createIndex('by_tag',             'idx.tags',          { multiEntry: true });
      /* Deliberately NOT indexed: `user.pile` (null|'sell'|'sold') and
         `facets.format` (physical|ebook|audiobook|unspecified). Both are
         low-cardinality — three or four values across the whole library — so an
         index buys nothing a client-side filter over an already-loaded list
         does not, and costs a write on every put. This follows MovieTrak's own
         precedent of never indexing `facets.anime` for exactly that reason. */

      db.createObjectStore('idIndex', { keyPath: 'key' });

      const snaps = db.createObjectStore('snapshots', { keyPath: 'uid' });
      snaps.createIndex('by_checkedAt', 'checkedAt');

      db.createObjectStore('alertKeys', { keyPath: 'alertId' });

      const feed = db.createObjectStore('feedItems', { keyPath: 'feedId' });
      feed.createIndex('by_read_lastAt', ['readFlag', 'lastAt']);
      feed.createIndex('by_uid',         'uid');                           // sparse by design
      feed.createIndex('by_lastAt',      'lastAt');
      feed.createIndex('by_type',        'type');

      const dis = db.createObjectStore('dismissed', { keyPath: 'uid' });
      dis.createIndex('by_dismissedAt', 'dismissedAt');

      const fol = db.createObjectStore('follows', { keyPath: 'id' });
      fol.createIndex('by_lastCheckedAt', 'lastCheckedAt');
      fol.createIndex('by_name',          'name');

      const cache = db.createObjectStore('cache', { keyPath: 'key' });
      cache.createIndex('by_expiresAt',     'expiresAt');
      cache.createIndex('by_hardExpiresAt', 'hardExpiresAt');
      cache.createIndex('by_source',        'source');
      cache.createIndex('by_fetchedAt',     'fetchedAt');

      db.createObjectStore('df',     { keyPath: 'term' });
      db.createObjectStore('dfSeen', { keyPath: 'uid' });

      const hist = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      hist.createIndex('by_uid', 'uid');
      hist.createIndex('by_at',  'at');

      db.createObjectStore('meta', { keyPath: 'key' });

      /* Deletion tombstones. Recorded so a later merge of two divergent
         libraries can tell "I removed this book" from "I have never seen this
         book" — without the row those two states are indistinguishable and a
         union merge silently resurrects everything you culled. */
      const t = db.createObjectStore('deleted', { keyPath: 'uid' });
      t.createIndex('by_deletedAt', 'deletedAt');
    },
  ];

  const STORE_NAMES = ['items', 'idIndex', 'snapshots', 'alertKeys', 'feedItems',
                       'dismissed', 'follows', 'cache', 'df', 'dfSeen', 'history', 'meta', 'deleted'];

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(NAME, VERSION); }
      catch (e) { return resolve(useFallback(e)); }

      /* Firefox in private mode resolves neither handler; Safari can hang on a
         blocked upgrade. Ten seconds then degrade rather than a dead app. */
      const guard = setTimeout(() => resolve(useFallback(new Error('IndexedDB timed out'))), 10000);

      req.onupgradeneeded = ev => {
        const db = req.result;
        for (let v = ev.oldVersion; v < ev.newVersion; v++) MIGRATIONS[v](db, req.transaction);
      };
      req.onsuccess = () => {
        clearTimeout(guard);
        const db = req.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        resolve(db);
      };
      req.onerror = () => { clearTimeout(guard); resolve(useFallback(req.error)); };
      req.onblocked = () => console.warn('[db] upgrade blocked by another tab');
    });
    return dbp;
  }

  /* If IndexedDB is unusable (Safari private browsing, a corrupted profile,
     some file:// configurations), fall back to localStorage with a hard item
     cap and TELL the user. Never a silent in-memory shim that loses everything
     on close — that is worse than failing. */
  function useFallback(err) {
    console.warn('[db] IndexedDB unavailable, using localStorage fallback:', err);
    mode = 'fallback';
    for (const s of STORE_NAMES) {
      try { fallback.stores[s] = JSON.parse(localStorage.getItem('bt.fb.' + s) || '{}'); }
      catch (_) { fallback.stores[s] = {}; }
    }
    if (BT.ui && BT.ui.banner) {
      BT.ui.banner('This browser is blocking its local database, so BookTrak is using a smaller, less reliable store. Export your library regularly.');
    }
    return null;
  }

  function fbPersist(store) {
    try { localStorage.setItem('bt.fb.' + store, JSON.stringify(fallback.stores[store] || {})); }
    catch (e) { console.warn('[db] fallback store full', e); }
  }
  function fbKeyOf(store, value) {
    if (store === 'history') return value.id != null ? value.id : (Date.now() + Math.random());
    const kp = { items: 'uid', idIndex: 'key', snapshots: 'uid', alertKeys: 'alertId',
                 feedItems: 'feedId', dismissed: 'uid', follows: 'id', cache: 'key',
                 df: 'term', dfSeen: 'uid', meta: 'key', deleted: 'uid' }[store];
    return value[kp];
  }

  const wrap = req => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  async function tx(stores, mode_, fn) {
    const db = await open();
    if (!db) return fn(fallbackTx(stores));
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode_);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
      try {
        out = fn(t);
        /* If fn returns a promise it must resolve only on IDB requests already
           issued inside this transaction — see edge (d) above. */
        if (out && typeof out.then === 'function') out.then(v => { out = v; }, reject);
      } catch (e) { try { t.abort(); } catch (_) {} reject(e); }
    });
  }

  function fallbackTx(stores) {
    void stores;
    return {
      objectStore(name) {
        fallback.stores[name] = fallback.stores[name] || {};
        const bucket = fallback.stores[name];
        const api = {
          get: k => wrapValue(bucket[k]),
          getAll: () => wrapValue(Object.values(bucket)),
          getAllKeys: () => wrapValue(Object.keys(bucket)),
          put(v) { bucket[fbKeyOf(name, v)] = v; fbPersist(name); return wrapValue(v); },
          add(v) {
            const k = fbKeyOf(name, v);
            if (k in bucket) { const e = new Error('ConstraintError'); e.name = 'ConstraintError'; return wrapError(e); }
            bucket[k] = v; fbPersist(name); return wrapValue(v);
          },
          delete(k) { delete bucket[k]; fbPersist(name); return wrapValue(undefined); },
          clear() { fallback.stores[name] = {}; fbPersist(name); return wrapValue(undefined); },
          count: () => wrapValue(Object.keys(bucket).length),
          index: () => api,                     // filtering happens in the repo
          openCursor: () => wrapValue(null),
        };
        return api;
      },
    };
  }
  function wrapValue(v) {
    const o = { result: v, onsuccess: null, onerror: null };
    queueMicrotask(() => { o.result = v; o.onsuccess && o.onsuccess({ target: o }); });
    return o;
  }
  function wrapError(e) {
    const o = { error: e, onsuccess: null, onerror: null };
    queueMicrotask(() => { o.onerror && o.onerror({ target: o }); });
    return o;
  }

  /* ── Small typed helpers used by the repo ──────────────────────────── */

  async function get(store, key) {
    return tx([store], 'readonly', t => wrap(t.objectStore(store).get(key)));
  }
  async function put(store, value) {
    return tx([store], 'readwrite', t => wrap(t.objectStore(store).put(value)));
  }
  async function add(store, value) {
    return tx([store], 'readwrite', t => wrap(t.objectStore(store).add(value)));
  }
  async function del(store, key) {
    return tx([store], 'readwrite', t => wrap(t.objectStore(store).delete(key)));
  }
  async function getAll(store) {
    return tx([store], 'readonly', t => wrap(t.objectStore(store).getAll()));
  }
  async function count(store) {
    return tx([store], 'readonly', t => wrap(t.objectStore(store).count()));
  }
  async function clear(store) {
    return tx([store], 'readwrite', t => wrap(t.objectStore(store).clear()));
  }
  async function putMany(store, values) {
    if (!values.length) return;
    return tx([store], 'readwrite', t => {
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
    });
  }

  /* Cursor walk over an index range. `fn` may return false to stop early. */
  async function walkIndex(store, indexName, range, fn, direction) {
    const db = await open();
    if (!db) {                                  // fallback: full scan
      const all = await getAll(store);
      for (const v of all) if (fn(v) === false) break;
      return;
    }
    return new Promise((resolve, reject) => {
      const t = db.transaction([store], 'readonly');
      const src = indexName ? t.objectStore(store).index(indexName) : t.objectStore(store);
      const req = src.openCursor(range || null, direction || 'next');
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (fn(c.value, c.key) === false) return;
        c.continue();
      };
      req.onerror = () => reject(req.error);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  return {
    open, tx, wrap, get, put, add, del, getAll, count, clear, putMany, walkIndex,
    STORE_NAMES,
    get mode() { return mode; },
    isFallback: () => mode === 'fallback',
  };
})();
