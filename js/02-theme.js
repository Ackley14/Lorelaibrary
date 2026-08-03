/* ══════════════════════════════════════════════════════════════════════════
   Theme.

   The initial value is resolved by an inline script in the document head, so
   the correct ground colour is painted on the first frame. This module only
   handles switching afterwards and keeping the control in sync.

   The two themes are "Vellum" (light — warm parchment) and "Marginalia"
   (dark — warm ink). Because geometry lives entirely in the theme-invariant
   token block, toggling changes colour and material and nothing else — no
   reflow, no layout shift.
   ══════════════════════════════════════════════════════════════════════════ */

BT.theme = (function () {
  const KEY = 'bt.theme';
  const listeners = new Set();

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function set(theme, opts) {
    opts = opts || {};
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    if (!opts.transient) {
      try { localStorage.setItem(KEY, theme); } catch (_) {}
    }
    paintControl();
    for (const fn of listeners) { try { fn(theme); } catch (e) { console.error(e); } }
  }

  const toggle = () => set(current() === 'dark' ? 'light' : 'dark');
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  function paintControl() {
    const t = current();
    for (const btn of document.querySelectorAll('[data-theme-set]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === t));
    }
  }

  function init() {
    paintControl();
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-theme-set]');
      if (btn) set(btn.dataset.themeSet);
    });

    /* Follow the OS only while the user has never chosen for themselves.
       Once they pick, their choice sticks across OS changes. */
    let chosen = false;
    try { chosen = !!localStorage.getItem(KEY); } catch (_) {}
    if (!chosen && window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: light)');
      const follow = e => set(e.matches ? 'light' : 'dark', { transient: true });
      if (mq.addEventListener) mq.addEventListener('change', follow);
      else if (mq.addListener) mq.addListener(follow);
    }
  }

  return { current, set, toggle, onChange, init };
})();
