// @ts-check
/**
 * @file fn-autocomplete.js
 * @description Function-name autocomplete for the formula editor. While a formula
 * is typed (inline in a cell or in the formula bar), suggests matching spreadsheet
 * function names from window.SHEET_FUNCTIONS; Tab/Enter inserts the highlighted
 * function as "NAME(" with the caret inside the parens, ↑↓ browse, Esc dismisses.
 * A typing aid only — it does not change what the formula engine can evaluate.
 *
 * Published on window.CoSheet.fnAutocomplete. The host (app.js) drives it through
 * the editor adapter it already builds for inline cells / the formula bar
 * (getValue/getCaret/getRect/replaceToken/el), passed to update(editor). The
 * module needs no core state — only the function catalog and i18n.
 * Loaded as a classic <script> before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const i18n = root.CoSheet.i18n || {};
  const t = i18n.t || ((k) => k);
  const getLang = i18n.getLang || (() => 'en');

  // ---------------------------------------------------------------------------
  // State.
  // ---------------------------------------------------------------------------
  let fnAcEl = null;          // dropdown DOM element (null when closed)
  let fnAcMatches = [];       // current matching function entries
  let fnAcIndex = 0;          // highlighted index within fnAcMatches
  let fnAcTokenStart = -1;    // caret-relative start of the typed function token
  const FN_AC_MAX = 50;       // cap suggestions to keep the list manageable

  // The editor adapter the autocomplete is currently attached to (the formula bar
  // <input> or an inline-editing cell), provided by the host via update(). Exposes
  // getValue/getCaret/getRect/focus/replaceToken and `el`.
  /** @type {any} */
  let fnAcEditor = null;

  const isFnAutocompleteOpen = () => fnAcEl !== null;

  /**
   * Extracts the function-name token immediately to the left of the caret.
   * Only triggers in formula mode (value starts with "="). Returns null when the
   * caret is not at the end of a letter-led identifier.
   * @returns {{ word: string, start: number } | null}
   */
  const getFnToken = () => {
    if (!fnAcEditor) return null;
    const value = fnAcEditor.getValue();
    if (!value.startsWith('=')) return null;
    const caret = fnAcEditor.getCaret();
    // Caret must be a collapsed cursor (no selection) for predictable insertion.
    if (caret < 0) return null;
    const left = value.slice(0, caret);
    const m = left.match(/([A-Za-z][A-Za-z0-9_.]*)$/);
    if (!m) return null;
    return { word: m[1], start: caret - m[1].length };
  };

  /** Recomputes matches from the current token and shows/hides the dropdown. */
  const updateFnAutocomplete = () => {
    const catalog = root.SHEET_FUNCTIONS;
    if (!Array.isArray(catalog) || catalog.length === 0) { closeFnAutocomplete(); return; }
    const token = getFnToken();
    if (!token) { closeFnAutocomplete(); return; }
    const prefix = token.word.toUpperCase();
    const matches = catalog.filter(fn => fn.n.startsWith(prefix)).slice(0, FN_AC_MAX);
    if (matches.length === 0) { closeFnAutocomplete(); return; }
    fnAcMatches = matches;
    fnAcTokenStart = token.start;
    fnAcIndex = 0;
    renderFnAutocomplete();
  };

  /** Builds (or rebuilds) the dropdown DOM and positions it under the input. */
  const renderFnAutocomplete = () => {
    const lang = getLang();
    if (!fnAcEl) {
      fnAcEl = document.createElement('div');
      fnAcEl.id = 'fn-autocomplete';
      fnAcEl.className = 'fixed z-[1000] bg-surface-container-lowest dark:bg-inverse-surface ' +
        'border border-outline-variant rounded-lg shadow-lg overflow-hidden select-none ' +
        'text-on-surface dark:text-on-surface-variant text-label-md';
      document.body.appendChild(fnAcEl);
    }

    const rows = fnAcMatches.map((fn, i) => {
      const active = i === fnAcIndex;
      const desc = (fn[lang] || fn.en || '').replace(/</g, '&lt;');
      const descHtml = active && desc
        ? `<div class="text-xs text-on-surface-variant/80 mt-0.5">${desc}</div>`
        : '';
      return `
        <div class="fn-ac-item px-3 py-1.5 cursor-pointer ${active ? 'bg-surface-variant' : 'hover:bg-surface-variant/60'}" data-idx="${i}">
          <div class="font-mono-data text-on-surface dark:text-on-surface-variant">${fn.n}</div>
          ${descHtml}
        </div>`;
    }).join('');

    fnAcEl.innerHTML = `
      <div class="fn-ac-list max-h-72 overflow-y-auto py-1">${rows}</div>
      <div class="px-3 py-1.5 border-t border-outline-variant text-xs text-on-surface-variant/70">
        ${t('fn.hint')}
      </div>`;

    // Insert the highlighted suggestion on click. mousedown (not click) fires
    // before the input's blur handler, so the popup is still alive.
    fnAcEl.querySelectorAll('.fn-ac-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        fnAcIndex = parseInt(/** @type {HTMLElement} */ (item).dataset.idx, 10) || 0;
        acceptFnAutocomplete();
      });
    });

    positionFnAutocomplete();
  };

  /** Positions the dropdown beneath the active editor, clamped to viewport. */
  const positionFnAutocomplete = () => {
    if (!fnAcEl || !fnAcEditor) return;
    const rect = fnAcEditor.getRect();
    const width = Math.min(380, Math.max(220, rect.width));
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (left < 8) left = 8;
    fnAcEl.style.width = `${width}px`;
    fnAcEl.style.left = `${left}px`;
    fnAcEl.style.top = `${rect.bottom + 2}px`;
  };

  /** Moves the highlight by delta (wrapping) and re-renders. */
  const moveFnAutocomplete = (delta) => {
    if (!isFnAutocompleteOpen() || fnAcMatches.length === 0) return;
    const n = fnAcMatches.length;
    fnAcIndex = (fnAcIndex + delta + n) % n;
    renderFnAutocomplete();
    // Keep the active row visible within the scroll area.
    const activeRow = fnAcEl.querySelector(`.fn-ac-item[data-idx="${fnAcIndex}"]`);
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  };

  /** Replaces the typed token with "NAME(" and places the caret inside. */
  const acceptFnAutocomplete = () => {
    if (!isFnAutocompleteOpen() || !fnAcEditor) return;
    const fn = fnAcMatches[fnAcIndex];
    if (!fn) { closeFnAutocomplete(); return; }
    const caret = fnAcEditor.getCaret();
    if (caret < 0) { closeFnAutocomplete(); return; }
    fnAcEditor.replaceToken(fnAcTokenStart, caret, `${fn.n}(`);
    closeFnAutocomplete();
  };

  /** Tears down the dropdown and resets state. */
  const closeFnAutocomplete = () => {
    if (fnAcEl) { fnAcEl.remove(); fnAcEl = null; }
    fnAcMatches = [];
    fnAcIndex = 0;
    fnAcTokenStart = -1;
  };

  // Reposition on viewport changes; close on outside interaction.
  window.addEventListener('resize', () => { if (isFnAutocompleteOpen()) positionFnAutocomplete(); });
  document.addEventListener('mousedown', (e) => {
    if (!isFnAutocompleteOpen()) return;
    const editorEl = fnAcEditor && fnAcEditor.el;
    if (fnAcEl.contains(/** @type {Node} */ (e.target))) return;
    if (editorEl && (e.target === editorEl || editorEl.contains(e.target))) return;
    closeFnAutocomplete();
  });

  root.CoSheet.fnAutocomplete = {
    /** Point the autocomplete at `editor` and recompute suggestions. */
    update: (editor) => { fnAcEditor = editor; updateFnAutocomplete(); },
    isOpen: isFnAutocompleteOpen,
    move: moveFnAutocomplete,
    accept: acceptFnAutocomplete,
    close: closeFnAutocomplete,
  };
})();
