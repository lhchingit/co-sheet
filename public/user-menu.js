// @ts-check
/**
 * @file user-menu.js
 * @description Shared user-avatar component used by both the file manager (drive)
 * and the spreadsheet editor so the two stay visually and behaviourally identical.
 * Renders a circular avatar that opens an account dropdown on click and shows an
 * account-info card on hover. Publishes CoSheet.userMenu.init(). Loaded as a
 * classic <script> after i18n.js.
 *
 * Self-contained styling: uses only default Tailwind colours (white / slate /
 * red / blue) and an explicit rounded-[9999px] radius, so it renders the same on
 * both pages regardless of their per-page Tailwind theme overrides (the editor
 * page, for instance, redefines `rounded-full` to a 12px radius).
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const i18n = (root.CoSheet && root.CoSheet.i18n) || {};
  const t = (key) => (typeof i18n.t === 'function' ? i18n.t(key) : key);

  /** HTML-escape a string for safe interpolation into innerHTML. */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /**
   * Initialise the shared avatar menu inside `mount`.
   * @param {Object} opts
   * @param {HTMLElement} opts.mount - container element (made position:relative).
   * @param {Array<{labelKey:string,onClick:Function,visible?:(me:any)=>boolean}>} [opts.items]
   *   Extra menu entries inserted above "Sign out" (e.g. the admin Permissions link).
   * @param {(me:any)=>void} [opts.onLoad] - called with the /api/me payload once loaded.
   * @param {boolean} [opts.redirectOnUnauth] - redirect to /login on HTTP 401.
   * @returns {{hideMenu:Function}}
   */
  const init = (opts) => {
    const mount = opts && opts.mount;
    if (!mount) return { hideMenu: () => {} };
    const items = (opts && opts.items) || [];
    mount.classList.add('relative');

    mount.innerHTML = `
      <button type="button" data-um="avatar" class="w-10 h-10 rounded-[9999px] overflow-hidden bg-blue-600 text-white flex items-center justify-center font-medium hover:brightness-95 transition-all cursor-pointer">
        <span data-um="initial">?</span>
      </button>
      <!-- Account info card, shown on hover. -->
      <div data-um="tooltip" class="hidden absolute right-0 mt-2 bg-[#3c4043] rounded-lg p-3 shadow-lg z-50 w-max max-w-xs select-none pointer-events-none">
        <div class="flex flex-col space-y-0.5">
          <h2 data-um="tip-title" class="text-white text-sm font-medium tracking-tight"></h2>
          <p data-um="tip-name" class="text-[#bdc1c6] text-sm font-normal"></p>
          <p data-um="tip-email" class="text-[#9aa0a6] text-xs font-normal truncate"></p>
        </div>
      </div>
      <!-- Account dropdown, shown on click. -->
      <div data-um="menu" class="hidden absolute right-0 top-full mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg py-2 z-50">
        <div class="px-4 py-2.5 border-b border-slate-100">
          <p data-um="name" class="text-slate-800 font-semibold text-sm truncate">&nbsp;</p>
          <p data-um="email" class="text-slate-500 text-xs mt-0.5 truncate"></p>
        </div>
        <div data-um="items"></div>
        <a href="/logout" data-i18n="profile.signout" class="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-slate-50 transition-colors font-medium no-underline">${esc(t('profile.signout'))}</a>
      </div>
    `;

    const q = (name) => mount.querySelector(`[data-um="${name}"]`);
    const avatarBtn = q('avatar');
    const tooltip = q('tooltip');
    const menu = q('menu');
    const itemsWrap = q('items');

    const hideMenu = () => menu && menu.classList.add('hidden');
    const hideTooltip = () => tooltip && tooltip.classList.add('hidden');

    // Avatar click toggles the dropdown (and dismisses the hover card).
    if (avatarBtn) {
      avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTooltip();
        if (menu) menu.classList.toggle('hidden');
      });
      avatarBtn.addEventListener('mouseenter', () => {
        if (menu && menu.classList.contains('hidden') && tooltip) tooltip.classList.remove('hidden');
      });
      avatarBtn.addEventListener('mouseleave', hideTooltip);
    }

    // Dismiss the dropdown on any outside click.
    document.addEventListener('click', (e) => {
      if (menu && !mount.contains(/** @type {Node} */ (e.target))) hideMenu();
    });

    // Render the optional extra menu entries (e.g. admin Permissions) for this user.
    const renderItems = (me) => {
      if (!itemsWrap) return;
      itemsWrap.innerHTML = '';
      items.forEach((item) => {
        if (typeof item.visible === 'function' && !item.visible(me)) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'w-full px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left font-medium';
        btn.setAttribute('data-i18n', item.labelKey);
        btn.textContent = t(item.labelKey);
        btn.addEventListener('click', () => {
          hideMenu();
          if (typeof item.onClick === 'function') item.onClick();
        });
        itemsWrap.appendChild(btn);
      });
    };

    fetch('/api/me')
      .then((res) => {
        if (res.status === 401 && opts.redirectOnUnauth) {
          window.location.href = '/login';
          return null;
        }
        return res.json();
      })
      .then((me) => {
        if (!me) return;
        const name = me.username || me.email || 'User';

        // Avatar: real picture when available, otherwise a coloured initial.
        if (avatarBtn) {
          if (me.picture) {
            avatarBtn.innerHTML = `<img src="${esc(me.picture)}" alt="" class="w-full h-full object-cover"/>`;
          } else {
            const initEl = q('initial');
            if (initEl) initEl.textContent = (String(name).trim()[0] || '?').toUpperCase();
          }
        }

        // Dropdown header: name + email.
        const nameEl = q('name'); if (nameEl) nameEl.textContent = name;
        const emailEl = q('email'); if (emailEl) emailEl.textContent = me.email || '';

        // Hover card: provider title + name + email.
        const tipTitle = q('tip-title');
        if (tipTitle) {
          const key = me.provider === 'google' ? 'profile.googleAccount' : 'profile.session';
          // Set data-i18n so a later language switch re-translates the correct title.
          tipTitle.setAttribute('data-i18n', key);
          tipTitle.textContent = t(key);
        }
        const tipName = q('tip-name'); if (tipName) tipName.textContent = me.username || '';
        const tipEmail = q('tip-email');
        if (tipEmail) {
          tipEmail.textContent = me.email || '';
          tipEmail.classList.toggle('hidden', !me.email);
        }

        renderItems(me);
        if (typeof opts.onLoad === 'function') opts.onLoad(me);
      })
      .catch(() => { /* leave defaults on failure */ });

    return { hideMenu };
  };

  root.CoSheet.userMenu = { init };
})();
