// @ts-check
/**
 * @file sort-filter.js
 * @description Sheet sorting (Data ▸ Sort sheet) and per-column value filters
 * (the funnel menu + persisted hidden-value sets). Owns sheetFilters; the grid
 * renderer calls applyFilter()/updateToolbarButton() each render, and the Data
 * menu / toolbar funnel drive create/remove/sort. Published on
 * window.CoSheet.sortFilter; app.js injects core services via init(). Loaded as a
 * classic <script> before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const U = root.CoSheet.utils || {};
  const escapeHtml = U.escapeHtml || ((s) => String(s));
  const getColLetter = U.getColLetter || ((i) => String(i));
  const parseCellCoord = U.parseCellCoord || (() => null);
  const t = (root.CoSheet.i18n && root.CoSheet.i18n.t) || ((k) => k);

  /** @type {any} */
  let app = null;

  // Owned here: per-sheet value filters. sheetName -> { colIndex, hidden:Set }.
  let sheetFilters = Object.create(null);

  /**
   * Compares two sort keys: numeric when both parse as numbers, otherwise a
   * locale-aware string compare. Blanks always sink to the bottom regardless of
   * direction (matching spreadsheet "Sort sheet" behaviour).
   */
  function compareSortKeys(a, b, ascending) {
    const aEmpty = a === '' || a == null;
    const bEmpty = b === '' || b == null;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const aStr = String(a), bStr = String(b);
    const aNum = Number(aStr), bNum = Number(bStr);
    let cmp;
    if (aStr.trim() !== '' && bStr.trim() !== '' && !isNaN(aNum) && !isNaN(bNum)) {
      cmp = aNum - bNum;
    } else {
      cmp = aStr.localeCompare(bStr);
    }
    return ascending ? cmp : -cmp;
  }

  /**
   * Reorders the populated data rows from `startRow` downward by the given column,
   * packing them contiguously from `startRow` (blank rows fall to the bottom).
   * Whole rows move together; cell contents/styles are carried verbatim. Diffs
   * against the current state and uses the same apply/broadcast/undo path as the
   * Insert menu, so collaborators and the undo stack stay in sync.
   * @returns {boolean} whether anything changed.
   */
  function sortDataRows(colIndex, ascending, startRow) {
    if (!app.canEditWorkbook || app.isHistoryMode) return false;

    // Group the populated cells of each sortable row, keyed by row number.
    const rowMap = new Map(); // row -> { [colLetter]: cellCopy }
    Object.keys(app.localCells).forEach((id) => {
      const coord = parseCellCoord(id);
      if (!coord || coord.row < startRow) return;
      const cell = app.localCells[id];
      const blank = !cell || (!cell.formula && (cell.value === '' || cell.value == null) &&
        (!cell.style || Object.keys(cell.style).length === 0));
      if (blank) return;
      if (!rowMap.has(coord.row)) rowMap.set(coord.row, {});
      rowMap.get(coord.row)[coord.colLetter] = JSON.parse(JSON.stringify(cell));
    });
    if (rowMap.size === 0) return false;

    // Sort the rows by the chosen column's evaluated value.
    const sortColLetter = getColLetter(colIndex);
    const rows = [...rowMap.entries()].map(([row, cells]) => ({
      cells,
      key: app.getCellValue(`${sortColLetter}${row}`)
    }));
    rows.sort((a, b) => compareSortKeys(a.key, b.key, ascending));

    // Lay the sorted rows out contiguously starting at startRow.
    const newState = {};
    rows.forEach((r, i) => {
      const targetRow = startRow + i;
      Object.keys(r.cells).forEach((colLetter) => {
        newState[`${colLetter}${targetRow}`] = r.cells[colLetter];
      });
    });

    // Diff against the current state.
    const EMPTY = { formula: '', value: '', style: {} };
    const oldIds = Object.keys(app.localCells).filter((id) => {
      const coord = parseCellCoord(id);
      return coord && coord.row >= startRow;
    });
    const before = {};
    oldIds.forEach((id) => { before[id] = JSON.parse(JSON.stringify(app.localCells[id])); });
    const affected = new Set([...oldIds, ...Object.keys(newState)]);
    const changes = [];
    affected.forEach((id) => {
      const beforeCell = before[id] || { formula: '', value: '', style: {} };
      const afterCell = newState[id] || EMPTY;
      if (JSON.stringify(beforeCell) === JSON.stringify(afterCell)) return;
      app.localCells[id] = JSON.parse(JSON.stringify(afterCell));
      changes.push({ cellId: id, before: beforeCell, after: JSON.parse(JSON.stringify(afterCell)) });
      if (app.socket && app.socket.readyState === WebSocket.OPEN) {
        app.socket.send(JSON.stringify({
          type: 'cell-edit',
          payload: { cellId: id, formula: afterCell.formula || '', value: afterCell.value || '', style: afterCell.style || {} }
        }));
      }
    });

    if (changes.length) app.recordHistoryAction({ type: 'multi', changes });
    app.recalculateSheet();
    app.renderGrid();

    const fb = /** @type {HTMLInputElement} */ (document.getElementById('formula-bar-input'));
    if (fb && app.activeCellId) {
      const cell = app.localCells[app.activeCellId];
      fb.value = cell ? (cell.formula || cell.value || '') : '';
    }
    return changes.length > 0;
  }

  // The filter's first ("header") row is the first non-frozen row: it hosts the
  // funnel and is never hidden or sorted. Data rows are everything below it.
  function filterHeaderRow() { return (app.frozenRows || 0) + 1; }

  // The bottom of the filter's scope: the last row holding any populated cell on
  // the active sheet (the used range), clamped to at least the header row.
  function filterLastRow() {
    let max = filterHeaderRow();
    Object.keys(app.localCells).forEach((id) => {
      const coord = parseCellCoord(id);
      if (!coord) return;
      const cell = app.localCells[id];
      const blank = !cell || (!cell.formula && (cell.value === '' || cell.value == null) &&
        (!cell.style || Object.keys(cell.style).length === 0));
      if (!blank && coord.row > max) max = coord.row;
    });
    return max;
  }

  // Stable per-cell value key: '__BLANK__' for empties, the string value otherwise.
  function filterValueKey(val) {
    return (val === '' || val == null) ? '__BLANK__' : String(val);
  }

  // Swap the Create-filter menu label to "Remove filter" while a filter is active.
  function updateDataFilterLabel() {
    const label = document.getElementById('data-create-filter-label');
    if (!label) return;
    const active = !!sheetFilters[app.activeSheetName];
    label.textContent = t(active ? 'data.removeFilter' : 'data.createFilter');
  }

  // Reflect the active sheet's filter state on the toolbar funnel button: a solid
  // (filled) icon over a grey tint when a filter is active, an outline icon when
  // not. The tooltip flips between "Create a filter" / "Remove filter", keeping
  // its data-i18n-title in sync so it re-translates on a language switch. The FILL
  // axis is set inline so it wins over the global `.material-symbols-outlined` rule.
  function updateFilterToolbarButton() {
    const btn = document.getElementById('toolbar-filter');
    if (!btn) return;
    const active = !!sheetFilters[app.activeSheetName];
    const icon = /** @type {HTMLElement} */ (btn.querySelector('.material-symbols-outlined'));
    if (icon) icon.style.fontVariationSettings = active ? "'FILL' 1" : "'FILL' 0";
    // Grey tint while active. Set inline (surface-variant token) rather than via a
    // Tailwind class so it doesn't depend on the runtime JIT generating a class
    // that only appears dynamically; clearing it lets the hover state show again.
    btn.style.backgroundColor = active ? '#dfe3e8' : '';
    const key = active ? 'data.removeFilter' : 'data.createFilter';
    btn.setAttribute('data-i18n-title', key);
    btn.title = t(key);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  // Filters are local view state (never broadcast), so they survive reloads via
  // localStorage rather than the workbook. Key by file id so each spreadsheet
  // keeps its own filters; the hidden Set is stored as an array (Sets don't
  // survive JSON).
  const filtersStorageKey = () => `co-sheet-filters:${app.currentFileId || 'default'}`;

  function saveSheetFilters() {
    try {
      const out = Object.create(null);
      for (const name of Object.keys(sheetFilters)) {
        const f = sheetFilters[name];
        out[name] = { colIndex: f.colIndex, hidden: Array.from(f.hidden) };
      }
      localStorage.setItem(filtersStorageKey(), JSON.stringify(out));
    } catch (err) {}
  }

  // Restore persisted filters into sheetFilters. Called once on init before the
  // first render so applyFilter() can paint them.
  function loadSheetFilters() {
    try {
      const raw = localStorage.getItem(filtersStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      sheetFilters = Object.create(null);
      for (const name of Object.keys(parsed)) {
        const f = parsed[name];
        if (!f || typeof f.colIndex !== 'number') continue;
        sheetFilters[name] = {
          colIndex: f.colIndex,
          hidden: new Set(Array.isArray(f.hidden) ? f.hidden : [])
        };
      }
    } catch (err) {}
  }

  // Create a value filter on the given column (all values initially shown), then
  // re-render so the funnel/scope tint appear.
  function createSheetFilter(colIndex) {
    if (app.isHistoryMode) return;
    // A value filter hides whole rows; merged cells span rows/columns, so the two
    // can't coexist. Match Google Sheets: refuse and explain via an error dialog.
    if (app.getActiveSheetMerges().length) {
      closeFilterMenu();
      app.showMessageDialog(t('merge.filterError.title'), t('merge.filterError.body'));
      return;
    }
    sheetFilters[app.activeSheetName] = { colIndex, hidden: new Set() };
    saveSheetFilters();
    closeFilterMenu();
    app.renderGrid();
  }

  // Remove the active sheet's filter and re-render (rows reappear, tint/funnel go).
  function removeSheetFilter() {
    delete sheetFilters[app.activeSheetName];
    saveSheetFilters();
    closeFilterMenu();
    app.renderGrid();
  }

  // Sort only the filter's data rows (header row stays put) by the filtered column.
  function performFilterSort(colIndex, ascending) {
    sortDataRows(colIndex, ascending, filterHeaderRow() + 1);
  }

  /**
   * Paints the active sheet's value filter onto the freshly rendered grid: tints
   * the filtered column header and the row headers across the filter scope, drops
   * the funnel icon on the column's first cell, and hides rows whose value in the
   * filtered column is currently excluded. No-op in history mode or with no filter.
   */
  function applyFilter() {
    if (app.isHistoryMode) return;
    const f = sheetFilters[app.activeSheetName];
    if (!f) return;
    const gridRoot = document.getElementById('grid-root');
    if (!gridRoot) return;

    const colLetter = getColLetter(f.colIndex);
    const headerRow = filterHeaderRow();
    const lastRow = filterLastRow();

    // Scope tint: the filtered column header plus EVERY row header from the filter
    // header row down. The filter was created from a full-column selection, so it
    // covers the whole column — tint all rendered row headers (not just the
    // populated range) so the scope reads as the entire column.
    const colHeader = gridRoot.querySelector(`[data-col-id="${colLetter}"]`);
    if (colHeader) colHeader.classList.add('filter-col-header');
    gridRoot.querySelectorAll('[data-row-id]').forEach((rh) => {
      const r = parseInt(rh.getAttribute('data-row-id'), 10);
      if (r >= headerRow) rh.classList.add('filter-row-header');
    });

    // Green left/right edges on every cell of the filtered column (from the header
    // row down), so the column is easy to identify. Columns are single letters, so
    // the cell-id prefix matches exactly that column; the coord check is a guard.
    gridRoot.querySelectorAll(`[data-cell-id^="${colLetter}"]`).forEach((cellEl) => {
      const coord = parseCellCoord(cellEl.getAttribute('data-cell-id'));
      if (coord && coord.colIndex === f.colIndex && coord.row >= headerRow) {
        cellEl.classList.add('filter-col-cell');
      }
    });

    // Funnel icon on the column's first cell; click opens the filter menu.
    const headerCell = gridRoot.querySelector(`[data-cell-id="${colLetter}${headerRow}"]`);
    if (headerCell) {
      const icon = document.createElement('span');
      icon.className = 'filter-icon material-symbols-outlined';
      icon.textContent = 'filter_alt';
      icon.title = t('filter.byValue');
      icon.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFilterMenu(f.colIndex, icon);
      });
      headerCell.appendChild(icon);
    }

    // Hide data rows whose filtered-column value is excluded. A row is hidden by
    // collapsing its row header and all its cells, so the remaining rows reflow
    // cleanly within the grid (row numbers stay as gaps).
    if (f.hidden.size) {
      const cols = app.getColCount();
      for (let r = headerRow + 1; r <= lastRow; r++) {
        const key = filterValueKey(app.getCellValue(`${colLetter}${r}`));
        if (!f.hidden.has(key)) continue;
        const rh = /** @type {HTMLElement} */ (gridRoot.querySelector(`[data-row-id="${r}"]`));
        if (rh) rh.style.display = 'none';
        for (let c = 0; c < cols; c++) {
          const cellEl = /** @type {HTMLElement} */ (gridRoot.querySelector(`[data-cell-id="${getColLetter(c)}${r}"]`));
          if (cellEl) cellEl.style.display = 'none';
        }
      }
    }
  }

  // The currently-open filter menu element and its outside-click handler, so we
  // can tear them down cleanly. Only one filter menu is ever open at a time.
  let filterMenuEl = null;
  let filterMenuDismiss = null;

  function closeFilterMenu() {
    if (filterMenuDismiss) {
      document.removeEventListener('mousedown', filterMenuDismiss, true);
      document.removeEventListener('keydown', filterMenuDismiss, true);
      filterMenuDismiss = null;
    }
    if (filterMenuEl && filterMenuEl.parentNode) filterMenuEl.parentNode.removeChild(filterMenuEl);
    filterMenuEl = null;
  }

  /**
   * Builds and shows the filter dropdown (matching images/data/filter_setting.png)
   * for the given column, anchored under `anchorEl`. Wired: A→Z / Z→A sort and the
   * "Filter by values" checklist (with search, select-all/clear, OK/Cancel).
   * Sort-by-color, filter-by-color and filter-by-condition are greyed out.
   */
  function showFilterMenu(colIndex, anchorEl) {
    closeFilterMenu();
    const f = sheetFilters[app.activeSheetName];
    if (!f) return;

    const colLetter = getColLetter(colIndex);
    const headerRow = filterHeaderRow();
    const lastRow = filterLastRow();

    // Distinct values across the data rows, with occurrence counts.
    const seen = new Map(); // key -> { key, display, count }
    for (let r = headerRow + 1; r <= lastRow; r++) {
      const val = app.getCellValue(`${colLetter}${r}`);
      const key = filterValueKey(val);
      if (!seen.has(key)) {
        seen.set(key, { key, display: key === '__BLANK__' ? t('filter.blank') : String(val), count: 0 });
      }
      seen.get(key).count++;
    }
    const values = [...seen.values()].sort((a, b) => {
      if (a.key === '__BLANK__') return 1;
      if (b.key === '__BLANK__') return -1;
      return compareSortKeys(a.display, b.display, true);
    });

    const menu = document.createElement('div');
    menu.id = 'filter-menu';
    menu.className = 'fixed bg-surface-container-lowest dark:bg-inverse-surface border border-outline-variant rounded-lg shadow-xl py-1 w-72 z-[1100] text-on-surface dark:text-on-surface-variant';
    const itemCls = 'flex items-center gap-3 w-full px-4 py-2 text-left text-label-lg hover:bg-surface-variant';
    const disabledCls = 'flex items-center justify-between gap-3 w-full px-4 py-2 text-label-lg text-outline opacity-50 cursor-default select-none';
    const iconCls = 'material-symbols-outlined text-[18px]';

    menu.innerHTML = `
      <button class="${itemCls}" data-act="sort-az">
        <span class="${iconCls}">arrow_downward</span><span>${escapeHtml(t('filter.sortAsc'))}</span>
      </button>
      <button class="${itemCls}" data-act="sort-za">
        <span class="${iconCls}">arrow_upward</span><span>${escapeHtml(t('filter.sortDesc'))}</span>
      </button>
      <div class="${disabledCls}">
        <span class="flex items-center gap-3"><span class="${iconCls}">palette</span><span>${escapeHtml(t('filter.sortByColor'))}</span></span>
        <span class="${iconCls}">chevron_right</span>
      </div>
      <div class="border-t border-outline-variant my-1"></div>
      <div class="${disabledCls}">
        <span class="flex items-center gap-3"><span class="${iconCls}">format_color_fill</span><span>${escapeHtml(t('filter.filterByColor'))}</span></span>
        <span class="${iconCls}">chevron_right</span>
      </div>
      <div class="${disabledCls}">
        <span class="flex items-center gap-3"><span class="${iconCls}">arrow_right</span><span>${escapeHtml(t('filter.byCondition'))}</span></span>
      </div>
      <div class="flex items-center gap-3 w-full px-4 py-2 text-label-lg text-on-surface-variant">
        <span class="${iconCls}">arrow_drop_down</span><span>${escapeHtml(t('filter.byValue'))}</span>
      </div>
      <div class="flex items-center justify-between px-4 pb-1 text-body-sm">
        <span><a href="#" data-act="select-all" class="text-blue-600 hover:underline">${escapeHtml(t('filter.selectAll', { n: values.length }))}</a> · <a href="#" data-act="clear" class="text-blue-600 hover:underline">${escapeHtml(t('filter.clear'))}</a></span>
        <span class="text-on-surface-variant" data-role="showing"></span>
      </div>
      <div class="px-4 py-1">
        <div class="flex items-center gap-2 border border-outline-variant rounded px-2 py-1">
          <input type="text" data-role="search" placeholder="${escapeHtml(t('filter.search'))}" class="flex-grow bg-transparent outline-none text-body-md" />
          <span class="${iconCls} text-on-surface-variant">search</span>
        </div>
      </div>
      <div data-role="list" class="max-h-44 overflow-y-auto px-2 py-1"></div>
      <div class="border-t border-outline-variant my-1"></div>
      <div class="flex items-center justify-end gap-2 px-4 py-2">
        <button data-act="cancel" class="px-4 py-1.5 rounded-full text-label-lg text-blue-600 hover:bg-surface-variant">${escapeHtml(t('filter.cancel'))}</button>
        <button data-act="ok" class="px-4 py-1.5 rounded-full text-label-lg bg-green-700 text-white hover:bg-green-800">${escapeHtml(t('filter.ok'))}</button>
      </div>
    `;

    // Populate the value checklist. A value starts checked unless it is in the
    // filter's current hidden set.
    const list = menu.querySelector('[data-role="list"]');
    values.forEach((v) => {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-variant cursor-pointer text-label-lg';
      label.setAttribute('data-display', v.display.toLowerCase());
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'filter-val accent-green-700';
      cb.setAttribute('data-key', v.key);
      cb.checked = !f.hidden.has(v.key);
      const span = document.createElement('span');
      span.className = 'flex-grow truncate';
      span.textContent = v.display;
      label.appendChild(cb);
      label.appendChild(span);
      list.appendChild(label);
    });

    const showingEl = menu.querySelector('[data-role="showing"]');
    const checkboxes = () => /** @type {HTMLInputElement[]} */ ([...menu.querySelectorAll('.filter-val')]);
    const refreshShowing = () => {
      let shown = 0;
      checkboxes().forEach((cb) => {
        if (cb.checked) {
          const entry = seen.get(cb.getAttribute('data-key'));
          shown += entry ? entry.count : 0;
        }
      });
      showingEl.textContent = t('filter.showing', { n: shown });
    };
    refreshShowing();

    // Position under the funnel, clamped to the viewport.
    document.body.appendChild(menu);
    const a = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = a.left;
    let top = a.bottom + 4;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, a.top - mh - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    filterMenuEl = menu;

    // Interactions.
    menu.addEventListener('change', (e) => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      if (tgt && tgt.classList.contains('filter-val')) refreshShowing();
    });
    menu.addEventListener('input', (e) => {
      const tgt = /** @type {HTMLInputElement} */ (e.target);
      if (!tgt || tgt.getAttribute('data-role') !== 'search') return;
      const q = tgt.value.trim().toLowerCase();
      list.querySelectorAll('label').forEach((lbl) => {
        /** @type {HTMLElement} */ (lbl).style.display = lbl.getAttribute('data-display').includes(q) ? '' : 'none';
      });
    });
    menu.addEventListener('click', (e) => {
      const actEl = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
      if (!actEl) return;
      const act = actEl.getAttribute('data-act');
      if (act === 'select-all' || act === 'clear') {
        e.preventDefault();
        // Only toggle the rows currently visible under the search filter.
        list.querySelectorAll('label').forEach((lbl) => {
          if (lbl.style.display === 'none') return;
          const cb = /** @type {HTMLInputElement} */ (lbl.querySelector('.filter-val'));
          if (cb) cb.checked = (act === 'select-all');
        });
        refreshShowing();
      } else if (act === 'sort-az') {
        closeFilterMenu();
        performFilterSort(colIndex, true);
      } else if (act === 'sort-za') {
        closeFilterMenu();
        performFilterSort(colIndex, false);
      } else if (act === 'cancel') {
        closeFilterMenu();
      } else if (act === 'ok') {
        const hidden = new Set();
        checkboxes().forEach((cb) => { if (!cb.checked) hidden.add(cb.getAttribute('data-key')); });
        f.hidden = hidden;
        saveSheetFilters();
        closeFilterMenu();
        app.renderGrid();
      }
    });

    // Dismiss on outside click or Escape (treated as Cancel).
    filterMenuDismiss = (e) => {
      if (e.type === 'keydown') { if (e.key === 'Escape') closeFilterMenu(); return; }
      if (!menu.contains(e.target) && e.target !== anchorEl) closeFilterMenu();
    };
    document.addEventListener('mousedown', filterMenuDismiss, true);
    document.addEventListener('keydown', filterMenuDismiss, true);

    const search = /** @type {HTMLElement} */ (menu.querySelector('[data-role="search"]'));
    if (search) search.focus();
  }

  /**
   * Wire the module to the host app core services.
   * @param {any} services - The window.CoSheet.app service bag.
   */
  const init = (services) => { app = services; };

  root.CoSheet.sortFilter = {
    init,
    applyFilter,
    updateToolbarButton: updateFilterToolbarButton,
    updateDataLabel: updateDataFilterLabel,
    loadFilters: loadSheetFilters,
    sortDataRows,
    createFilter: createSheetFilter,
    removeFilter: removeSheetFilter,
    hasActiveFilter: () => !!sheetFilters[app.activeSheetName],
  };
})();
