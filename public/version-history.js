// @ts-check
/**
 * @file version-history.js
 * @description Version-history sidebar: fetches, lists, previews and restores
 * saved workbook versions, and toggles the read-only history preview mode.
 * Published on window.CoSheet.history; consumed by app.js, which injects the
 * grid re-render hooks (init) and mirrors the preview state its grid renderer
 * reads for diff highlighting (syncState). Loaded as a classic <script> before
 * app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

  const escapeHtml = (root.CoSheet.utils && root.CoSheet.utils.escapeHtml) || ((s) => String(s));

  // ---------------------------------------------------------------------------
  // App hooks. Injected by app.js via init(); no-op defaults keep the module
  // inert until wired (and harmless in non-browser test sandboxes).
  // ---------------------------------------------------------------------------
  /** @type {() => void} */
  let renderGrid = () => {};
  /** @type {() => void} */
  let renderSheetTabs = () => {};
  // Mirror the preview state app.js's grid renderer reads: history mode plus the
  // selected/previous version snapshots used to compute per-cell diffs. Called
  // after every state mutation, before a grid re-render.
  /** @type {(s: { mode: boolean, selected: any, previous: any }) => void} */
  let syncState = () => {};
  // Resolve the id of the workbook currently open in the editor, so version-history
  // API calls are scoped to it. Returns null for the legacy 'default' workbook.
  /** @type {() => (string|null)} */
  let getFileId = () => null;

  /**
   * Build a version-history API URL, scoping it to the current workbook via the
   * ?file=<id> query parameter when one is open (absent => the 'default' workbook).
   * @param {string} path - The base path, e.g. '/api/versions' or '/api/versions/3'.
   * @returns {string}
   */
  const versionsApiUrl = (path) => {
    const fileId = getFileId();
    return fileId ? `${path}?file=${encodeURIComponent(fileId)}` : path;
  };

  // ---------------------------------------------------------------------------
  // Module-private state.
  // ---------------------------------------------------------------------------
  let versionsList = [];           // versions fetched from the API (newest first)
  let selectedVersionState = null; // full snapshot of the previewed version
  let previousVersionState = null; // snapshot of the version before it (for diffs)
  let isHistoryMode = false;       // whether the read-only preview is active

  const pushState = () => syncState({
    mode: isHistoryMode,
    selected: selectedVersionState,
    previous: previousVersionState,
  });

  /**
   * Localized string lookup with a safe fallback for non-browser/test sandboxes
   * where the i18n module may not be present.
   * @param {string} key - Locale dictionary key.
   * @param {string} fallback - Value to use when i18n is unavailable.
   * @returns {string}
   */
  const translate = (key, fallback) => {
    const i18n = root.CoSheet && root.CoSheet.i18n;
    return (i18n && typeof i18n.t === 'function') ? i18n.t(key) : fallback;
  };

  /**
   * Sets the preview bar's title text (the selected version's timestamp, or an
   * empty/empty-state string when nothing is selected). No-op if the element is
   * absent.
   * @param {string} text - The text to display.
   */
  const setHistoryTitle = (text) => {
    const el = document.getElementById('history-title-date');
    if (el) el.innerText = text;
  };

  /**
   * Localized date formatter for version grouping.
   * @param {string|Date} dateStr - Timestamp.
   * @returns {string} The group header.
   */
  const formatVersionGroup = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();

    const dMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    const diffDays = Math.round((nowMidnight - dMidnight) / oneDay);

    if (diffDays === 0) {
      return '今天';
    } else if (diffDays === 1) {
      return '昨天';
    } else if (diffDays > 1 && diffDays < 7) {
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      return weekdays[date.getDay()];
    } else {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }
  };

  /**
   * Localized time formatter for individual version entries.
   * @param {string|Date} dateStr - Timestamp.
   * @returns {string} Formatted localized time string.
   */
  const formatVersionTime = (dateStr) => {
    const date = new Date(dateStr);
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');

    let period = '';
    let displayHours = hours;

    if (hours >= 0 && hours < 5) {
      period = '凌晨';
    } else if (hours >= 5 && hours < 8) {
      period = '清晨';
    } else if (hours >= 8 && hours < 11) {
      period = '早上';
    } else if (hours >= 11 && hours < 13) {
      period = '中午';
    } else if (hours >= 13 && hours < 17) {
      period = '下午';
      if (hours > 12) displayHours = hours - 12;
    } else if (hours >= 17 && hours < 19) {
      period = '傍晚';
      if (hours > 12) displayHours = hours - 12;
    } else {
      period = '晚上';
      if (hours > 12) displayHours = hours - 12;
    }

    if (displayHours === 0) displayHours = 12;

    return `${date.getMonth() + 1}月${date.getDate()}日，${period}${displayHours}:${minutes}`;
  };

  /**
   * Renders the versions list in the right sidebar panel, grouped by date.
   */
  const renderVersionsList = () => {
    const listContainer = document.getElementById('history-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const groups = {};
    versionsList.forEach((version, index) => {
      const groupName = formatVersionGroup(version.created_at);
      if (!groups[groupName]) {
        groups[groupName] = [];
      }
      groups[groupName].push({ version, index });
    });

    Object.keys(groups).forEach(groupName => {
      const headerEl = document.createElement('div');
      headerEl.className = 'px-4 py-2 bg-gray-50 dark:bg-surface-variant text-[11px] font-bold text-gray-500 dark:text-outline uppercase tracking-wider select-none';
      headerEl.innerText = groupName;
      listContainer.appendChild(headerEl);

      groups[groupName].forEach(({ version, index }) => {
        const itemEl = document.createElement('div');

        const isSelected = selectedVersionState && selectedVersionState.id === version.id;
        const isActiveVersion = index === 0;

        itemEl.className = `p-4 border-l-4 cursor-pointer relative transition-colors ${
          isSelected
            ? 'bg-blue-50/50 dark:bg-secondary/10 border-primary'
            : 'hover:bg-gray-50 dark:hover:bg-surface-variant border-transparent'
        }`;

        const timeStr = formatVersionTime(version.created_at);

        itemEl.innerHTML = `
          <div class="flex items-start justify-between">
            <div class="flex items-center space-x-2">
              <span class="material-symbols-outlined text-gray-400 text-sm">chevron_right</span>
              <div class="text-sm ${isSelected ? 'font-semibold text-gray-900 dark:text-inverse-on-surface' : 'text-gray-700 dark:text-outline'}">${timeStr}</div>
            </div>
          </div>
          ${isActiveVersion ? '<div class="ml-6 mt-1 text-xs text-gray-500 dark:text-outline">目前版本</div>' : ''}
          <div class="ml-6 mt-2 flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full bg-[#009688]"></span>
            <span class="text-xs text-gray-600 dark:text-outline">${escapeHtml(version.created_by)}</span>
          </div>
        `;

        itemEl.addEventListener('click', () => {
          selectVersion(version.id);
        });

        listContainer.appendChild(itemEl);
      });
    });
  };

  /**
   * Loads details for a selected version from the API, fetches its preceding version to compute diffs,
   * and triggers grid re-rendering.
   * @param {number} versionId - The version ID.
   */
  const selectVersion = async (versionId) => {
    try {
      const res = await fetch(versionsApiUrl(`/api/versions/${versionId}`));
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const versionData = await res.json();
      selectedVersionState = versionData;

      const index = versionsList.findIndex(v => v.id === versionId);

      if (index !== -1 && index + 1 < versionsList.length) {
        const prevVersion = versionsList[index + 1];
        const prevRes = await fetch(versionsApiUrl(`/api/versions/${prevVersion.id}`));
        previousVersionState = await prevRes.json();
      } else {
        previousVersionState = null;
      }

      const selectedVersionInfo = versionsList[index];
      if (selectedVersionInfo) {
        setHistoryTitle(formatVersionTime(selectedVersionInfo.created_at));
      }

      const restoreBtn = document.getElementById('history-restore-btn');
      if (restoreBtn) {
        if (index === 0) {
          restoreBtn.classList.add('hidden');
        } else {
          restoreBtn.classList.remove('hidden');
        }
      }

      pushState();
      renderVersionsList();
      renderGrid();
    } catch (err) {
      console.error('Failed to load version details:', err);
    }
  };

  /**
   * Restores the active workbook state to the currently previewed history version.
   */
  const restoreVersion = async () => {
    if (!selectedVersionState || !selectedVersionState.id) return;
    try {
      const res = await fetch(versionsApiUrl(`/api/versions/${selectedVersionState.id}/restore`), {
        method: 'POST'
      });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await res.json();
      if (data.success) {
        toggleHistoryMode(false);
      } else {
        alert('無法還原此版本');
      }
    } catch (err) {
      console.error('Error during version restoration:', err);
      alert('還原版本時發生錯誤');
    }
  };

  /**
   * Toggles the application between edit mode and read-only history preview mode.
   * @param {boolean} enabled - True to enable history mode, false to disable.
   */
  const toggleHistoryMode = async (enabled) => {
    isHistoryMode = enabled;

    const normalHeader = document.querySelector('header');
    const utilityShelf = document.querySelector('aside:not(#history-sidebar)');
    const bottomFooter = document.querySelector('footer');
    const mainContent = document.querySelector('main');

    const historyTopBar = document.getElementById('history-top-bar');
    const historySidebar = document.getElementById('history-sidebar');

    if (enabled) {
      if (normalHeader) normalHeader.classList.add('hidden');
      if (utilityShelf) utilityShelf.classList.add('hidden');

      if (historyTopBar) historyTopBar.classList.remove('hidden');
      if (historySidebar) historySidebar.classList.remove('hidden');

      if (mainContent) {
        mainContent.classList.remove('mr-[48px]');
        mainContent.classList.add('mr-[320px]');
      }

      // Clear any stale title from a previous session before the list loads, so
      // a hidden version is never misrepresented while the fetch is in flight.
      setHistoryTitle('');

      try {
        const res = await fetch(versionsApiUrl('/api/versions'));
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        versionsList = await res.json();

        if (versionsList.length > 0) {
          await selectVersion(versionsList[0].id);
        } else {
          selectedVersionState = null;
          previousVersionState = null;
          setHistoryTitle(translate('history.noVersions', '尚無版本紀錄'));
          pushState();
          renderGrid();
        }
      } catch (err) {
        console.error('Failed to fetch version history:', err);
        setHistoryTitle(translate('history.noVersions', '尚無版本紀錄'));
      }
    } else {
      if (normalHeader) normalHeader.classList.remove('hidden');
      if (utilityShelf) utilityShelf.classList.remove('hidden');

      if (historyTopBar) historyTopBar.classList.add('hidden');
      if (historySidebar) historySidebar.classList.add('hidden');

      if (mainContent) {
        mainContent.classList.remove('mr-[320px]');
        mainContent.classList.add('mr-[48px]');
      }

      selectedVersionState = null;
      previousVersionState = null;

      pushState();
      renderGrid();
      renderSheetTabs();
    }
  };

  /**
   * Wires the Version History UI interaction triggers. Safe to call once after
   * the DOM is available (app.js runs deferred).
   */
  const bindEvents = () => {
    const headerHistoryBtn = document.getElementById('header-history-btn');
    if (headerHistoryBtn) {
      headerHistoryBtn.addEventListener('click', () => toggleHistoryMode(true));
    }

    const historyExitBtn = document.getElementById('history-exit-btn');
    if (historyExitBtn) {
      historyExitBtn.addEventListener('click', () => toggleHistoryMode(false));
    }

    const highlightChangesCheckbox = document.getElementById('highlightChanges');
    if (highlightChangesCheckbox) {
      highlightChangesCheckbox.addEventListener('change', () => renderGrid());
    }

    const showUneditedCheckbox = document.getElementById('showUnedited');
    if (showUneditedCheckbox) {
      showUneditedCheckbox.addEventListener('change', () => renderGrid());
    }

    const historyRestoreBtn = document.getElementById('history-restore-btn');
    if (historyRestoreBtn) {
      historyRestoreBtn.onclick = restoreVersion;
    }
  };

  /**
   * Wire the module to the host app and bind its UI events.
   * @param {{ renderGrid?: () => void, renderSheetTabs?: () => void, syncState?: (s: { mode: boolean, selected: any, previous: any }) => void, getFileId?: () => (string|null) }} [ctx]
   */
  const init = (ctx = {}) => {
    if (typeof ctx.renderGrid === 'function') renderGrid = ctx.renderGrid;
    if (typeof ctx.renderSheetTabs === 'function') renderSheetTabs = ctx.renderSheetTabs;
    if (typeof ctx.syncState === 'function') syncState = ctx.syncState;
    if (typeof ctx.getFileId === 'function') getFileId = ctx.getFileId;
    bindEvents();
  };

  root.CoSheet.history = {
    init,
    toggle: toggleHistoryMode,
    select: selectVersion,
    restore: restoreVersion,
  };
})();
