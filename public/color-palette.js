// @ts-check
/**
 * @file color-palette.js
 * @description Google Sheets–style color palette popup (text / fill / border-pen
 * / sheet-tab colors) plus the toolbar color-picker inputs. A shared UI service:
 * the border menu and sheet-tab menu (still in app.js) open it via 'border' /
 * 'sheet' pen types. Published on window.CoSheet.colorPalette; app.js injects the
 * core services (selection, cell color mutators, border pen setter) via init().
 * Loaded as a classic <script> before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const t = (root.CoSheet.i18n && root.CoSheet.i18n.t) || ((k) => k);

  // Injected by app.js via init(): live core services this popup drives.
  /** @type {any} */
  let app = null;

  // Update the colored indicator bar shown under a color toolbar button.
  const setToolbarColorSwatch = (which, hex) => {
    const swatch = document.getElementById(`toolbar-color-${which}-swatch`);
    if (swatch && swatch.style) swatch.style.backgroundColor = hex;
  };

  // Live-preview a color on the currently selected cell(s) without committing
  // (no socket/history). Lets inline color pickers show the change as it's chosen.
  const previewCellColor = (cssProp, hex) => {
    const selectedIds = app.getSelectedCellIds();
    const ids = selectedIds.length ? selectedIds : (app.activeCellId ? [app.activeCellId] : []);
    ids.forEach(id => {
      const el = /** @type {HTMLElement} */ (document.querySelector(`[data-cell-id="${id}"]`));
      if (el) el.style[cssProp] = hex;
    });
  };

  const STANDARD_COLORS = [
    ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
    ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
    ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
    ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
    ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
    ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
    ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
    ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
  ];

  let colorPaletteOutsideHandler = null;
  let colorPaletteSheetTarget = null; // sheet name when the palette is opened for a tab color
  const onColorPaletteKeydown = (e) => { if (e.key === 'Escape') closeColorPalette(); };

  const closeColorPalette = () => {
    const existing = document.getElementById('color-palette-popup');
    if (existing) existing.remove();
    document.removeEventListener('keydown', onColorPaletteKeydown, true);
    if (colorPaletteOutsideHandler) {
      document.removeEventListener('click', colorPaletteOutsideHandler, true);
      colorPaletteOutsideHandler = null;
    }
  };

  // Commit a chosen color: update the toolbar indicator and apply to the selection.
  const applyChosenColor = (type, hex) => {
    // Border pen color: store it for the next border action and update its swatch.
    if (type === 'border') {
      app.setBorderColor(hex);
      return;
    }
    // Sheet-tab color: broadcast the change (hex === null clears it).
    if (type === 'sheet') {
      if (colorPaletteSheetTarget && app.socket.readyState === WebSocket.OPEN) {
        app.socket.send(JSON.stringify({ type: 'color-sheet', payload: { sheetName: colorPaletteSheetTarget, color: hex } }));
      }
      return;
    }
    setToolbarColorSwatch(type, hex);
    if (!app.activeCellId) return;
    if (type === 'text') app.changeCellTextColor(app.activeCellId, hex);
    else app.changeCellColor(app.activeCellId, hex);
  };

  const openColorPalette = (type, anchorEl, options = {}) => {
    // Toggle closed if the same button's palette is already open.
    const existing = document.getElementById('color-palette-popup');
    const sameType = existing && existing.dataset.type === type;
    closeColorPalette();
    if (sameType) return;

    if (type === 'sheet') colorPaletteSheetTarget = options.sheetName || null;

    const popup = document.createElement('div');
    popup.id = 'color-palette-popup';
    popup.dataset.type = type;
    popup.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-lg p-3 select-none text-on-surface dark:text-on-surface-variant';

    // Reset semantics differ per target: fill -> white (no fill), sheet -> null
    // (clears the tab colour), text/border -> black.
    let resetLabel = t('color.reset');
    let resetHex = '#000000';
    if (type === 'fill') { resetLabel = t('color.noFill'); resetHex = '#ffffff'; }
    else if (type === 'sheet') { resetLabel = t('sheet.reset'); resetHex = null; }

    let gridHtml = '';
    STANDARD_COLORS.forEach((row) => {
      row.forEach((hex) => {
        gridHtml += `<button type="button" class="w-5 h-5 rounded-sm border border-black/10 hover:ring-2 hover:ring-primary hover:ring-offset-1" style="background-color:${hex}" data-hex="${hex}" title="${hex}"></button>`;
      });
    });

    popup.innerHTML = `
      <button type="button" id="color-reset" class="w-full flex items-center gap-2 px-2 py-1.5 mb-2 rounded hover:bg-surface-variant text-label-md">
        <span class="material-symbols-outlined text-[18px]">format_color_reset</span>
        <span>${resetLabel}</span>
      </button>
      <div class="text-xs font-medium text-on-surface-variant mb-1.5">${t('color.standard')}</div>
      <div class="grid grid-cols-10 gap-1">${gridHtml}</div>
      <div class="text-xs font-medium text-on-surface-variant mt-3 mb-1.5">${t('color.custom')}</div>
      <button type="button" id="color-custom" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-variant text-label-md">
        <span class="material-symbols-outlined text-[18px]">add</span>
        <span>${t('color.customColor')}</span>
      </button>
    `;

    document.body.appendChild(popup);

    // Position relative to the anchor, clamped to the viewport. 'right' placement
    // (used by the sheet-tab menu) flies out to the side like a submenu; the
    // default drops down beneath the anchor button.
    const r = anchorEl.getBoundingClientRect();
    const pr = popup.getBoundingClientRect();
    if (options.placement === 'right') {
      // Side flyout: align the palette's bottom with the menu item so it grows
      // upward — the sheet-tab menu sits at the bottom of the screen, so a
      // downward popup would fall below the fold. Then clamp within the viewport.
      popup.style.left = `${r.right + 4}px`;
      let top = r.bottom - pr.height;
      top = Math.min(top, window.innerHeight - pr.height - 8);
      top = Math.max(8, top);
      popup.style.top = `${top}px`;
      // Flip to the left of the anchor if it would overflow the right edge.
      if (r.right + 4 + pr.width > window.innerWidth) {
        popup.style.left = `${Math.max(4, r.left - pr.width - 4)}px`;
      }
    } else {
      popup.style.left = `${r.left}px`;
      popup.style.top = `${r.bottom + 4}px`;
      if (r.left + pr.width > window.innerWidth) popup.style.left = `${Math.max(4, window.innerWidth - pr.width - 4)}px`;
      if (r.bottom + 4 + pr.height > window.innerHeight) popup.style.top = `${Math.max(4, window.innerHeight - pr.height - 4)}px`;
    }

    /** @type {any} */ (popup.querySelector('#color-reset')).onclick = () => { applyChosenColor(type, resetHex); closeColorPalette(); };
    popup.querySelectorAll('[data-hex]').forEach((btn) => {
      /** @type {any} */ (btn).onclick = () => { applyChosenColor(type, /** @type {any} */ (btn).dataset.hex); closeColorPalette(); };
    });
    /** @type {any} */ (popup.querySelector('#color-custom')).onclick = () => {
      closeColorPalette();
      let input = /** @type {HTMLInputElement} */ (document.getElementById(`toolbar-color-${type}-input`));
      // text/fill have a hidden native input in the toolbar; create one on demand
      // for any other pen type (e.g. border) so custom colors still flow through.
      if (!input) {
        input = document.createElement('input');
        input.type = 'color';
        input.id = `toolbar-color-${type}-input`;
        input.style.display = 'none';
        input.addEventListener('input', (e) => applyChosenColor(type, /** @type {HTMLInputElement} */ (e.target).value));
        document.body.appendChild(input);
      }
      input.click();
    };

    // Dismiss on Escape or click outside (deferred so the opening click doesn't close it).
    document.addEventListener('keydown', onColorPaletteKeydown, true);
    colorPaletteOutsideHandler = (ev) => {
      if (!popup.contains(ev.target) && !anchorEl.contains(ev.target)) closeColorPalette();
    };
    setTimeout(() => {
      if (colorPaletteOutsideHandler) document.addEventListener('click', colorPaletteOutsideHandler, true);
    }, 0);
  };

  /**
   * Wires the toolbar color-picker inputs (live preview + commit) and the two
   * toolbar color buttons that open the palette. Safe to call once after the DOM
   * is available (app.js runs deferred).
   */
  const bindEvents = () => {
    const toolbarColorTextInput = document.getElementById('toolbar-color-text-input');
    if (toolbarColorTextInput) {
      // Live feedback while the picker is open (immediate, no commit yet).
      toolbarColorTextInput.addEventListener('input', (e) => {
        const val = /** @type {HTMLInputElement} */ (e.target).value;
        setToolbarColorSwatch('text', val);
        if (app.activeCellId) previewCellColor('color', val);
      });
      // Commit the chosen color (syncs + records history).
      toolbarColorTextInput.addEventListener('change', (e) => {
        const val = /** @type {HTMLInputElement} */ (e.target).value;
        setToolbarColorSwatch('text', val);
        if (app.activeCellId) {
          app.changeCellTextColor(app.activeCellId, val);
        }
      });
    }

    const toolbarColorFillInput = document.getElementById('toolbar-color-fill-input');
    if (toolbarColorFillInput) {
      toolbarColorFillInput.addEventListener('input', (e) => {
        const val = /** @type {HTMLInputElement} */ (e.target).value;
        setToolbarColorSwatch('fill', val);
        if (app.activeCellId) previewCellColor('backgroundColor', val);
      });
      toolbarColorFillInput.addEventListener('change', (e) => {
        const val = /** @type {HTMLInputElement} */ (e.target).value;
        setToolbarColorSwatch('fill', val);
        if (app.activeCellId) {
          app.changeCellColor(app.activeCellId, val);
        }
      });
    }

    const toolbarColorTextBtn = document.getElementById('toolbar-color-text');
    if (toolbarColorTextBtn) {
      toolbarColorTextBtn.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('input')) return; // ignore the hidden native input
        e.preventDefault();
        const existing = document.getElementById('color-palette-popup');
        const wasOpenSame = !!existing && existing.dataset.type === 'text';
        app.closeAllMenus();
        if (!wasOpenSame) openColorPalette('text', toolbarColorTextBtn);
      });
    }
    const toolbarColorFillBtn = document.getElementById('toolbar-color-fill');
    if (toolbarColorFillBtn) {
      toolbarColorFillBtn.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('input')) return;
        e.preventDefault();
        const existing = document.getElementById('color-palette-popup');
        const wasOpenSame = !!existing && existing.dataset.type === 'fill';
        app.closeAllMenus();
        if (!wasOpenSame) openColorPalette('fill', toolbarColorFillBtn);
      });
    }
  };

  /**
   * Wire the module to the host app's core services and bind its UI events.
   * @param {any} services - The window.CoSheet.app service bag.
   */
  const init = (services) => {
    app = services;
    bindEvents();
  };

  root.CoSheet.colorPalette = {
    init,
    open: openColorPalette,
    close: closeColorPalette,
    setSwatch: setToolbarColorSwatch,
  };
})();
