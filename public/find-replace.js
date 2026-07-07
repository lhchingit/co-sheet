// @ts-check
/**
 * @file find-replace.js
 * @description Find & Replace: searches cells across the current or all sheets
 * (text / formula / link, with case, whole-cell and regex options) and replaces
 * single or all matches. Published on window.CoSheet.findReplace; app.js injects
 * the core services it needs (live state getters + cell mutators) via init().
 * Loaded as a classic <script> before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const getColLetter = (root.CoSheet.utils && root.CoSheet.utils.getColLetter)
    || ((i) => String(i));

  // The Find dialog's fields are <input>/<select> controls. These typed readers
  // keep @ts-check on without a cast at every call site.
  /** @param {string} id @returns {string} */
  const fieldValue = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
  /** @param {string} id @returns {boolean} */
  const fieldChecked = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).checked;

  // Injected by app.js via init(). A bag of live core services: getters for the
  // mutable workbook/selection state (activeCellId, activeSheetName, sheetOrder,
  // localSheets, socket — all reassigned at runtime), the stable localCells
  // proxy, the TOTAL_ROWS constant, and the cell mutators this feature drives.
  // Typed `any` because it is a host-supplied service bag, not owned here.
  /** @type {any} */
  let app = null;

  // Last match the search landed on. Tracked across Find-Next presses; currently
  // write-only (kept to preserve intent and future "find previous" behavior).
  let _lastFoundCellId = null;
  let _lastFoundSheetName = null;

  /**
   * Helper to check if a cell matches the search string based on options.
   * @param {string} cellId - The cell coordinate.
   * @param {string} sheetName - The sheet containing the cell.
   * @param {string} findStr - The string to find.
   * @param {boolean} matchCase - Case sensitivity flag.
   * @param {boolean} matchEntire - Exact match flag.
   * @param {boolean} useRegex - Regular expression flag.
   * @param {boolean} searchFormulas - Search inside formulas flag.
   * @param {boolean} searchLinks - Search inside hyperlinks flag.
   * @returns {boolean} True if matching.
   */
  const matchesCell = (cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks) => {
    const sheetCells = app.localSheets[sheetName];
    if (!sheetCells) return false;
    const cell = sheetCells[cellId];
    if (!cell) return false;

    const textsToCheck = [];
    // Check cellular raw value
    if (cell.value !== undefined && cell.value !== null) {
      textsToCheck.push(cell.value.toString());
    }
    // Check formula if option enabled
    if (searchFormulas && cell.formula) {
      textsToCheck.push(cell.formula.toString());
    }
    // Check hyperlink style if option enabled
    if (searchLinks && cell.style && cell.style.link) {
      textsToCheck.push(cell.style.link.toString());
    }

    if (textsToCheck.length === 0) return false;

    // Verify if any of the target texts match the search criteria
    return textsToCheck.some(text => {
      if (useRegex) {
        try {
          const flags = matchCase ? '' : 'i';
          const regex = new RegExp(matchEntire ? `^${findStr}$` : findStr, flags);
          return regex.test(text);
        } catch (e) {
          // Fallback on invalid regex patterns
          return false;
        }
      } else {
        let t = text;
        let f = findStr;
        if (!matchCase) {
          t = t.toLowerCase();
          f = f.toLowerCase();
        }
        if (matchEntire) {
          return t === f;
        } else {
          return t.includes(f);
        }
      }
    });
  };

  /**
   * Generates cell sequence row-by-row, col-by-col for searching.
   * @returns {string[]} List of cell coordinate IDs.
   */
  const getSortedCellSequence = () => {
    const sequence = [];
    // Grid is TOTAL_ROWS tall; columns start at A-Z and grow rightward with data.
    const cols = app.getColCount();
    for (let r = 1; r <= app.TOTAL_ROWS; r++) {
      for (let c = 0; c < cols; c++) {
        const colLetter = getColLetter(c);
        sequence.push(`${colLetter}${r}`);
      }
    }
    return sequence;
  };

  /**
   * Finds the next matching cell based on Find inputs.
   * @returns {Object|null} Sheet name and cell ID coordinate.
   */
  const findNextMatch = () => {
    const { activeSheetName, sheetOrder, activeCellId, switchSheet, handleCellSelect, revealCell } = app;
    const findStr = fieldValue('find-input');
    if (!findStr) return null;
    const matchCase = fieldChecked('find-match-case');
    const matchEntire = fieldChecked('find-match-entire');
    const useRegex = fieldChecked('find-use-regex');
    const searchFormulas = fieldChecked('find-search-formulas');
    const searchLinks = fieldChecked('find-search-links');
    const scope = fieldValue('find-scope-select');

    // Determine search sheets scope: current sheet or all sheets
    let sheets = [];
    if (scope === '此工作表') {
      sheets = [activeSheetName];
    } else {
      // Traverse sheets starting from the active sheet in order
      const curIdx = sheetOrder.indexOf(activeSheetName);
      for (let i = 0; i < sheetOrder.length; i++) {
        sheets.push(sheetOrder[(curIdx + i) % sheetOrder.length]);
      }
    }

    // Create the combined search sequence
    const cellSeq = getSortedCellSequence();
    const searchSpace = [];
    sheets.forEach(sheetName => {
      cellSeq.forEach(cellId => {
        searchSpace.push({ sheetName, cellId });
      });
    });

    // Start matching from the cell after the currently active selection
    let startIdx = 0;
    if (activeCellId) {
      const spaceIdx = searchSpace.findIndex(item => item.sheetName === activeSheetName && item.cellId === activeCellId);
      if (spaceIdx !== -1) {
        startIdx = (spaceIdx + 1) % searchSpace.length;
      }
    }

    // Iterate search space looking for first match
    for (let i = 0; i < searchSpace.length; i++) {
      const idx = (startIdx + i) % searchSpace.length;
      const { sheetName, cellId } = searchSpace[idx];
      if (matchesCell(cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
        _lastFoundCellId = cellId;
        _lastFoundSheetName = sheetName;

        // Auto-switch sheet and select cell upon finding match
        if (sheetName !== activeSheetName) {
          switchSheet(sheetName);
        }
        const cellEl = document.querySelector(`[data-cell-id="${cellId}"]`);
        if (cellEl) {
          handleCellSelect(cellId, cellEl);
          cellEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
          // Windowed render: the match cell isn't in the DOM. Select it (works from
          // the id alone) and scroll it into view by geometry, which renders it.
          handleCellSelect(cellId, null);
          if (revealCell) revealCell(cellId);
        }
        return { sheetName, cellId };
      }
    }

    alert('找不到相符的內容');
    return null;
  };

  /**
   * Replaces the find string with replace string in the active cell.
   */
  const replaceCurrentMatch = () => {
    const { activeCellId, activeSheetName, localCells, socket, recordHistoryAction, updateGridDOMCell, getCellValue, recalculateSheet } = app;
    const findStr = fieldValue('find-input');
    const replaceStr = fieldValue('replace-input');
    if (!findStr || !activeCellId) return;

    const matchCase = fieldChecked('find-match-case');
    const matchEntire = fieldChecked('find-match-entire');
    const useRegex = fieldChecked('find-use-regex');
    const searchFormulas = fieldChecked('find-search-formulas');
    const searchLinks = fieldChecked('find-search-links');

    // Make sure the active cell matches before applying replacement
    if (matchesCell(activeCellId, activeSheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
      const before = localCells[activeCellId] ? JSON.parse(JSON.stringify(localCells[activeCellId])) : { formula: '', value: '', style: {} };
      const cell = localCells[activeCellId] || { formula: '', value: '', style: {} };

      let modified = false;
      // Replace text inside formula first, or fallback to cell value
      if (cell.formula && cell.formula.includes(findStr)) {
        cell.formula = cell.formula.replaceAll(findStr, replaceStr);
        modified = true;
      } else if (cell.value !== undefined && cell.value !== null) {
        const valStr = cell.value.toString();
        if (valStr.includes(findStr)) {
          cell.value = valStr.replaceAll(findStr, replaceStr);
          modified = true;
        }
      }

      if (modified) {
        localCells[activeCellId] = cell;
        // Record undo-redo history
        recordHistoryAction(activeCellId, before, cell);

        // Dispatch WebSocket cell update
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'cell-edit',
            payload: { cellId: activeCellId, formula: cell.formula, value: cell.value, style: cell.style }
          }));
        }
        updateGridDOMCell(activeCellId, getCellValue(activeCellId), cell.style);
        recalculateSheet();
        const formulaBar = /** @type {HTMLInputElement} */ (document.getElementById('formula-bar-input'));
        if (formulaBar) {
          formulaBar.value = cell.formula ? cell.formula : cell.value;
        }
      }
    }

    // Auto-find next match
    findNextMatch();
  };

  /**
   * Replaces all matches in the selected scope sheet(s) with replace string.
   */
  const replaceAllMatches = () => {
    const { activeSheetName, sheetOrder, localSheets, localCells, socket, activeCellId, recordHistoryAction, updateGridDOMCell, getCellValue, recalculateSheet } = app;
    const findStr = fieldValue('find-input');
    const replaceStr = fieldValue('replace-input');
    if (!findStr) return;

    const matchCase = fieldChecked('find-match-case');
    const matchEntire = fieldChecked('find-match-entire');
    const useRegex = fieldChecked('find-use-regex');
    const searchFormulas = fieldChecked('find-search-formulas');
    const searchLinks = fieldChecked('find-search-links');
    const scope = fieldValue('find-scope-select');

    let sheets = [];
    if (scope === '此工作表') {
      sheets = [activeSheetName];
    } else {
      sheets = sheetOrder;
    }

    const historyChanges = [];
    let totalReplaced = 0;

    // Scan and replace within all selected sheets
    sheets.forEach(sheetName => {
      const sheetCells = localSheets[sheetName];
      if (!sheetCells) return;

      Object.keys(sheetCells).forEach(cellId => {
        if (matchesCell(cellId, sheetName, findStr, matchCase, matchEntire, useRegex, searchFormulas, searchLinks)) {
          const cell = sheetCells[cellId];
          const before = JSON.parse(JSON.stringify(cell));
          let modified = false;

          // Perform replacement in formula or cell value
          if (cell.formula && cell.formula.includes(findStr)) {
            cell.formula = cell.formula.replaceAll(findStr, replaceStr);
            modified = true;
          } else if (cell.value !== undefined && cell.value !== null) {
            const valStr = cell.value.toString();
            if (valStr.includes(findStr)) {
              cell.value = valStr.replaceAll(findStr, replaceStr);
              modified = true;
            }
          }

          if (modified) {
            sheetCells[cellId] = cell;
            totalReplaced++;
            historyChanges.push({ cellId, before, after: JSON.parse(JSON.stringify(cell)) });

            if (sheetName === activeSheetName) {
              updateGridDOMCell(cellId, getCellValue(cellId), cell.style);
            }

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: 'cell-edit',
                payload: { cellId, formula: cell.formula, value: cell.value, style: cell.style, sheetName }
              }));
            }
          }
        }
      });
    });

    if (totalReplaced > 0) {
      // Record composite undo/redo action
      recordHistoryAction({ type: 'multi', changes: historyChanges });
      recalculateSheet();
      if (activeCellId && localCells[activeCellId]) {
        const formulaBar = /** @type {HTMLInputElement} */ (document.getElementById('formula-bar-input'));
        if (formulaBar) {
          formulaBar.value = localCells[activeCellId].formula ? localCells[activeCellId].formula : localCells[activeCellId].value;
        }
      }
      alert(`已完成取代！共取代了 ${totalReplaced} 處。`);
    } else {
      alert('找不到相符的內容，未進行任何取代。');
    }
  };

  /**
   * Wires the Find / Replace / Replace-all action buttons. Safe to call once
   * after the DOM is available (app.js runs deferred).
   */
  const bindEvents = () => {
    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.onclick = findNextMatch;

    const replaceBtn = document.getElementById('replace-btn');
    if (replaceBtn) replaceBtn.onclick = replaceCurrentMatch;

    const replaceAllBtn = document.getElementById('replace-all-btn');
    if (replaceAllBtn) replaceAllBtn.onclick = replaceAllMatches;
  };

  /**
   * Wire the module to the host app's core services and bind its UI events.
   * @param {any} services - The window.CoSheet.app service bag.
   */
  const init = (services) => {
    app = services;
    bindEvents();
  };

  root.CoSheet.findReplace = {
    init,
    findNext: findNextMatch,
    replaceCurrent: replaceCurrentMatch,
    replaceAll: replaceAllMatches,
  };
})();
