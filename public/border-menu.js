// @ts-check
/**
 * @file border-menu.js
 * @description Toolbar border button menu: a grid of border-application modes,
 * a border-color picker (reuses window.CoSheet.colorPalette, pen type 'border')
 * and a line-style submenu (thin/medium/thick/dashed/dotted/double). The chosen
 * color + style are applied by the core applyBordersToSelection() when a mode is
 * clicked. Published on window.CoSheet.borderMenu; app.js injects the pen state
 * + border CSS map + apply function via init(). Loaded as a classic <script>
 * before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const t = (root.CoSheet.i18n && root.CoSheet.i18n.t) || ((k) => k);

  // Injected by app.js via init(): pen state getters/setters, BORDER_STYLE_CSS,
  // and applyBordersToSelection (all kept in app.js since the core border-apply
  // reads the same pen settings).
  /** @type {any} */
  let app = null;

  const BORDER_MENU_MODES = [
    { mode: 'all',        icon: 'border_all',        key: 'border.all' },
    { mode: 'inner',      icon: 'border_inner',      key: 'border.inner' },
    { mode: 'horizontal', icon: 'border_horizontal', key: 'border.horizontal' },
    { mode: 'vertical',   icon: 'border_vertical',   key: 'border.vertical' },
    { mode: 'outer',      icon: 'border_outer',      key: 'border.outer' },
    { mode: 'left',       icon: 'border_left',       key: 'border.left' },
    { mode: 'top',        icon: 'border_top',        key: 'border.top' },
    { mode: 'right',      icon: 'border_right',      key: 'border.right' },
    { mode: 'bottom',     icon: 'border_bottom',     key: 'border.bottom' },
    { mode: 'clear',      icon: 'border_clear',      key: 'border.clear' },
  ];
  const BORDER_STYLE_OPTIONS = [
    { style: 'thin',   key: 'border.thin' },
    { style: 'medium', key: 'border.medium' },
    { style: 'thick',  key: 'border.thick' },
    { style: 'dashed', key: 'border.dashed' },
    { style: 'dotted', key: 'border.dotted' },
    { style: 'double', key: 'border.double' },
  ];

  let borderMenuEl = null;
  let borderMenuOutsideHandler = null;
  let borderMenuKeydownHandler = null;
  let borderStyleSubmenuEl = null;

  const closeBorderStyleSubmenu = () => {
    if (borderStyleSubmenuEl) { borderStyleSubmenuEl.remove(); borderStyleSubmenuEl = null; }
  };

  const closeBorderMenu = () => {
    root.CoSheet.colorPalette.close();
    closeBorderStyleSubmenu();
    if (borderMenuOutsideHandler) {
      document.removeEventListener('click', borderMenuOutsideHandler, true);
      borderMenuOutsideHandler = null;
    }
    if (borderMenuKeydownHandler) {
      document.removeEventListener('keydown', borderMenuKeydownHandler, true);
      borderMenuKeydownHandler = null;
    }
    if (borderMenuEl) { borderMenuEl.remove(); borderMenuEl = null; }
  };

  // Clamp a popup to the viewport, anchored under (or above) the given rect.
  const positionPopupUnder = (popup, anchorRect) => {
    popup.style.left = `${anchorRect.left}px`;
    popup.style.top = `${anchorRect.bottom + 4}px`;
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth) popup.style.left = `${Math.max(4, window.innerWidth - pr.width - 4)}px`;
    if (pr.bottom > window.innerHeight) popup.style.top = `${Math.max(4, anchorRect.top - pr.height - 4)}px`;
  };

  const openBorderStyleSubmenu = (anchorEl) => {
    const existing = borderStyleSubmenuEl;
    closeBorderStyleSubmenu();
    if (existing) return; // toggle closed

    const sub = document.createElement('div');
    borderStyleSubmenuEl = sub;
    sub.id = 'border-style-submenu';
    sub.className = 'fixed z-[1001] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg py-1 select-none text-on-surface dark:text-on-surface-variant';

    let html = '';
    BORDER_STYLE_OPTIONS.forEach((o) => {
      const lineCss = app.BORDER_STYLE_CSS[o.style]('currentColor');
      const checkVis = o.style === app.borderStyle ? 'visible' : 'hidden';
      html += `<button type="button" class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant text-label-md" data-style="${o.style}">
          <span class="material-symbols-outlined text-[16px]" style="visibility:${checkVis}">check</span>
          <span class="block w-12" style="border-top:${lineCss}"></span>
          <span class="flex-1 text-left whitespace-nowrap">${t(o.key)}</span>
        </button>`;
    });
    sub.innerHTML = html;
    document.body.appendChild(sub);
    positionPopupUnder(sub, anchorEl.getBoundingClientRect());

    sub.querySelectorAll('[data-style]').forEach((btn) => {
      /** @type {any} */ (btn).onclick = () => {
        app.setBorderStyle(/** @type {any} */ (btn).dataset.style);
        const preview = document.getElementById('border-style-preview');
        if (preview) preview.style.borderTop = app.BORDER_STYLE_CSS[app.borderStyle]('currentColor');
        closeBorderStyleSubmenu();
      };
    });
  };

  const openBorderMenu = (anchorEl) => {
    const existing = borderMenuEl;
    closeBorderMenu();
    if (existing) return; // toggle closed when re-clicking the toolbar button

    const menu = document.createElement('div');
    borderMenuEl = menu;
    menu.id = 'border-menu-popup';
    menu.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg p-2 select-none text-on-surface dark:text-on-surface-variant';

    const btnCls = 'flex items-center justify-center w-9 h-9 rounded hover:bg-surface-variant cursor-pointer';
    let gridHtml = '';
    BORDER_MENU_MODES.forEach((m) => {
      gridHtml += `<button type="button" class="${btnCls}" data-mode="${m.mode}" title="${t(m.key)}"><span class="material-symbols-outlined text-[20px]">${m.icon}</span></button>`;
    });
    const styleLineCss = app.BORDER_STYLE_CSS[app.borderStyle]('currentColor');

    menu.innerHTML = `
      <div class="flex items-stretch gap-2">
        <div class="grid grid-cols-5 gap-0.5">${gridHtml}</div>
        <div class="w-px bg-outline-variant self-stretch"></div>
        <div class="flex flex-col justify-center gap-1">
          <button type="button" id="border-color-btn" class="flex items-center gap-1 px-2 h-9 rounded hover:bg-surface-variant cursor-pointer" title="${t('border.color')}">
            <span class="material-symbols-outlined text-[20px]">border_color</span>
            <span id="border-color-swatch" class="block w-4 h-1 rounded-sm" style="background-color:${app.borderColor}"></span>
            <span class="material-symbols-outlined text-[18px] ml-auto">arrow_drop_down</span>
          </button>
          <button type="button" id="border-style-btn" class="flex items-center gap-1 px-2 h-9 rounded hover:bg-surface-variant cursor-pointer" title="${t('border.style')}">
            <span class="material-symbols-outlined text-[20px]">line_weight</span>
            <span id="border-style-preview" class="block w-6" style="border-top:${styleLineCss}"></span>
            <span class="material-symbols-outlined text-[18px] ml-auto">arrow_drop_down</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(menu);
    positionPopupUnder(menu, anchorEl.getBoundingClientRect());

    menu.querySelectorAll('[data-mode]').forEach((btn) => {
      /** @type {any} */ (btn).onclick = () => { app.applyBordersToSelection(/** @type {any} */ (btn).dataset.mode); closeBorderMenu(); };
    });
    /** @type {any} */ (menu.querySelector('#border-color-btn')).onclick = (e) => {
      e.stopPropagation();
      closeBorderStyleSubmenu();
      root.CoSheet.colorPalette.open('border', menu.querySelector('#border-color-btn'));
    };
    /** @type {any} */ (menu.querySelector('#border-style-btn')).onclick = (e) => {
      e.stopPropagation();
      root.CoSheet.colorPalette.close();
      openBorderStyleSubmenu(menu.querySelector('#border-style-btn'));
    };

    borderMenuKeydownHandler = (ev) => { if (ev.key === 'Escape') closeBorderMenu(); };
    document.addEventListener('keydown', borderMenuKeydownHandler, true);
    // Close when clicking outside the menu and its child popups (color palette / style submenu).
    borderMenuOutsideHandler = (ev) => {
      const palette = document.getElementById('color-palette-popup');
      if (menu.contains(ev.target)) return;
      if (anchorEl.contains(ev.target)) return;
      if (palette && palette.contains(ev.target)) return;
      if (borderStyleSubmenuEl && borderStyleSubmenuEl.contains(ev.target)) return;
      closeBorderMenu();
    };
    setTimeout(() => {
      if (borderMenuOutsideHandler) document.addEventListener('click', borderMenuOutsideHandler, true);
    }, 0);
  };

  /**
   * Wire the module to the host app's core services.
   * @param {any} services - The window.CoSheet.app service bag.
   */
  const init = (services) => {
    app = services;
  };

  root.CoSheet.borderMenu = {
    init,
    open: openBorderMenu,
    close: closeBorderMenu,
    isOpen: () => !!borderMenuEl,
  };
})();
