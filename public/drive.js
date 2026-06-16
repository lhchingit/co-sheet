// @ts-check
/**
 * @file drive.js
 * @description Client logic for the file-management interface ("drive"). Lists the
 * available workbooks, lets the user create a new file (minting a shareable URL),
 * and open / rename / delete / copy-link for a selected file. Shares the i18n
 * runtime (window.CoSheet.i18n) and Material Design 3 styling with the editor.
 *
 * Only actions backed by real server endpoints are exposed (open, copy link,
 * rename, delete). Speculative Drive features (share-with-person, download,
 * move-to-folder, AI) are intentionally omitted rather than faked.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const { t, getLang, translatePage, loadLocales } = (root.CoSheet && root.CoSheet.i18n) || {};

  // ----- module state -----
  let files = [];        // [{ id, name, created_at, created_by }]
  let selectedId = null; // currently selected file id (single-select)
  let menuTargetId = null; // file id the overflow menu currently acts on
  let currentRole = 'user'; // the signed-in user's role ('user'|'admin'|'superadmin')
  let adminUsers = [];   // cached user list for the permissions view (re-rendered on lang change)
  let userFilter = '';   // current permissions-table search term (lowercased)
  let canCreateFile = true; // whether the user may create another file (quota / role)
  let currentView = 'home'; // left-rail filter: 'home' (files I own) | 'shared' (shared with me) | 'starred' (files I starred)

  // ----- element refs -----
  const $ = (id) => document.getElementById(id);
  const appBar = $('app-bar');
  const selectionBar = $('selection-bar');
  const grid = $('file-grid');
  const emptyState = $('empty-state');
  const errorState = $('error-state');
  const cardMenu = $('card-menu');
  const navHome = $('nav-home');
  const navShared = $('nav-shared');
  const navStarred = $('nav-starred');

  /** HTML-escape a string for safe interpolation into innerHTML. */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Enable/disable an action button, reflecting it visually. */
  const setActionEnabled = (btn, enabled) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle('opacity-30', !enabled);
    btn.classList.toggle('cursor-not-allowed', !enabled);
  };

  /** Look up a file record by id. */
  const fileById = (id) => files.find((f) => f.id === id);

  /** Build the shareable / open URL for a file id. The default file has no ?file=. */
  const fileUrl = (id) => id === 'default'
    ? `${window.location.origin}/sheet`
    : `${window.location.origin}/sheet?file=${encodeURIComponent(id)}`;

  /** Navigate to a file's editor. */
  const openFile = (id) => { window.location.href = fileUrl(id); };

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  const toast = (msg) => {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  };

  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(t('drive.linkCopied'));
    } catch (e) {
      toast(t('drive.linkCopied'));
    }
  };

  // ---------------------------------------------------------------------------
  // Generic modal helper
  // ---------------------------------------------------------------------------
  // opts: { title, desc, inputValue (string|null), linkValue (string|null),
  //         okLabel, showCancel (bool), onOk(value) }
  let modalOnOk = null;
  const openModal = (opts) => {
    $('modal-title').textContent = opts.title || '';
    const descEl = $('modal-desc');
    if (opts.desc) { descEl.textContent = opts.desc; descEl.classList.remove('hidden'); }
    else { descEl.classList.add('hidden'); }

    const input = /** @type {HTMLInputElement} */ ($('modal-input'));
    if (opts.inputValue != null) {
      input.value = opts.inputValue;
      input.classList.remove('hidden');
    } else {
      input.classList.add('hidden');
    }

    const linkRow = $('modal-link-row');
    if (opts.linkValue != null) {
      /** @type {HTMLInputElement} */ ($('modal-link')).value = opts.linkValue;
      linkRow.classList.remove('hidden');
      linkRow.classList.add('flex');
    } else {
      linkRow.classList.add('hidden');
      linkRow.classList.remove('flex');
    }

    const okBtn = $('modal-ok');
    okBtn.textContent = opts.okLabel || t('dialog.confirm');
    const cancelBtn = $('modal-cancel');
    cancelBtn.textContent = opts.cancelLabel || t('dialog.cancel');
    cancelBtn.classList.toggle('hidden', opts.showCancel === false);

    modalOnOk = opts.onOk || null;
    $('modal-overlay').classList.remove('hidden');
    if (opts.inputValue != null) { input.focus(); input.select(); }
  };

  const closeModal = () => {
    $('modal-overlay').classList.add('hidden');
    modalOnOk = null;
  };

  // ---------------------------------------------------------------------------
  // Selection / action bar
  // ---------------------------------------------------------------------------
  const updateSelectionUI = () => {
    if (selectedId) {
      appBar.classList.add('hidden');
      selectionBar.classList.remove('hidden');
      selectionBar.classList.add('flex');
      $('sel-count').textContent = t('drive.selected', { n: 1 });
      // Rename / delete are only available on files the user may modify.
      const canModify = !!(fileById(selectedId) || {}).canModify;
      setActionEnabled($('sel-delete'), canModify);
      setActionEnabled($('sel-rename'), canModify);
    } else {
      selectionBar.classList.add('hidden');
      selectionBar.classList.remove('flex');
      appBar.classList.remove('hidden');
    }
    // Reflect selection styling on cards.
    grid.querySelectorAll('.file-card').forEach((card) => {
      const on = card.getAttribute('data-id') === selectedId;
      card.classList.toggle('ring-2', on);
      card.classList.toggle('ring-primary', on);
      card.classList.toggle('border-primary', on);
      card.classList.toggle('bg-secondary-container', on);
    });
  };

  const selectFile = (id) => { selectedId = id; updateSelectionUI(); };
  const clearSelection = () => { selectedId = null; updateSelectionUI(); };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  // Reflect the create quota on the New button: regular users may own one file;
  // admins / super admins are unlimited. The server enforces this regardless.
  const updateCreateButton = () => {
    const ownedCount = files.filter((f) => f.owner).length;
    canCreateFile = isAdmin() || ownedCount < 1;
    const btn = $('new-file-btn');
    if (!btn) return;
    btn.classList.toggle('opacity-50', !canCreateFile);
    btn.classList.toggle('cursor-not-allowed', !canCreateFile);
    btn.title = canCreateFile ? '' : t('drive.fileLimit');
  };

  // Left-rail filter: "Home" lists files the user owns (created, or granted the
  // 'owner' role); "Shared with me" lists everything else visible to them —
  // files shared as editor/viewer plus the shared sample (legacy 'default');
  // "Starred" lists files the user has starred (regardless of ownership).
  const viewFilter = (f) => {
    if (currentView === 'home') return f.owner === true;
    if (currentView === 'starred') return f.starred === true;
    return f.owner !== true; // 'shared'
  };

  // i18n key for the current view's heading and its empty-state message.
  const headingKey = () => currentView === 'home' ? 'drive.title'
    : currentView === 'starred' ? 'drive.starredTitle' : 'drive.sharedTitle';
  const emptyKey = () => currentView === 'home' ? 'drive.empty'
    : currentView === 'starred' ? 'drive.starredEmpty' : 'drive.sharedEmpty';

  // Apply view-dependent strings/state (heading, active rail item, New button).
  // Kept separate so it can be re-run after a language switch re-translates the page.
  const refreshViewStrings = () => {
    const heading = $('files-heading');
    if (heading) heading.textContent = t(headingKey());
    if (navHome) navHome.classList.toggle('active', currentView === 'home');
    if (navShared) navShared.classList.toggle('active', currentView === 'shared');
    if (navStarred) navStarred.classList.toggle('active', currentView === 'starred');
    // Creating a file always makes you its owner, so "New" only belongs in Home.
    const newBtn = $('new-file-btn');
    if (newBtn) newBtn.classList.toggle('hidden', currentView !== 'home');
  };

  const renderFiles = () => {
    grid.innerHTML = '';
    errorState.classList.add('hidden');

    const visible = files.filter(viewFilter);
    if (!visible.length) {
      const msg = emptyState.querySelector('p');
      if (msg) msg.textContent = t(emptyKey());
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
      updateCreateButton();
      return;
    }
    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    visible.forEach((f) => {
      const card = document.createElement('div');
      card.className = 'file-card group relative rounded-xl border border-outline-variant bg-surface-container-lowest overflow-hidden cursor-pointer hover:shadow-md transition-all';
      card.setAttribute('data-id', f.id);
      card.innerHTML = `
        <div class="flex items-center gap-2 px-3 py-2.5">
          <span class="material-symbols-outlined text-[20px] text-primary shrink-0" style="font-variation-settings:'FILL' 1;">table_chart</span>
          <span class="card-name flex-1 text-sm font-medium text-on-surface truncate" title="${esc(f.name)}">${esc(f.name)}</span>
          <button class="card-menu-btn w-8 h-8 -mr-1 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container transition-colors" title="${esc(t('ctx.moreActions'))}">
            <span class="material-symbols-outlined text-[20px]">more_vert</span>
          </button>
        </div>
        <div class="sheet-thumb h-32 border-t border-outline-variant flex items-center justify-center">
          <span class="material-symbols-outlined text-5xl text-outline-variant" style="font-variation-settings:'FILL' 1;">table_chart</span>
        </div>`;
      grid.appendChild(card);
    });
    updateSelectionUI();
    updateCreateButton();
  };

  // Switch the left-rail filter. Returns from the permissions view if it is open,
  // clears any selection, then re-renders the (now filtered) file list.
  const setView = (view) => {
    currentView = (view === 'shared' || view === 'starred') ? view : 'home';
    showFilesView();
    clearSelection();
    refreshViewStrings();
    renderFiles();
  };

  // ---------------------------------------------------------------------------
  // Server interactions
  // ---------------------------------------------------------------------------
  const loadFiles = async () => {
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error('load failed');
      files = await res.json();
      renderFiles();
    } catch (e) {
      grid.innerHTML = '';
      emptyState.classList.add('hidden');
      errorState.classList.remove('hidden');
    }
  };

  const createFile = (name) => {
    if (!canCreateFile) { toast(t('drive.fileLimit')); return; }
    openModal({
      title: t('drive.blankSheet'),
      desc: t('drive.promptName'),
      inputValue: name != null ? name : t('drive.untitled'),
      okLabel: t('drive.newFile'),
      showCancel: true,
      onOk: async (value) => {
        const finalName = (value && value.trim()) || t('drive.untitled');
        closeModal();
        try {
          const res = await fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: finalName })
          });
          if (res.status === 403) {
            const d = await res.json().catch(() => ({}));
            toast(d.error === 'file_limit' ? t('drive.fileLimit') : t('drive.noPermission'));
            await loadFiles();
            return;
          }
          if (!res.ok) throw new Error('create failed');
          const data = await res.json();
          await loadFiles();
          // Surface the unique, shareable URL for the new file.
          openModal({
            title: t('drive.shareTitle'),
            desc: t('drive.shareDesc'),
            linkValue: data.url || fileUrl(data.id),
            okLabel: t('drive.open'),
            cancelLabel: t('drive.done'),
            showCancel: true,
            onOk: () => openFile(data.id)
          });
        } catch (e) {
          toast(t('drive.loadError'));
        }
      }
    });
  };

  const renameFile = (id) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    openModal({
      title: t('drive.rename'),
      desc: t('drive.promptRename', { name: f.name }),
      inputValue: f.name,
      okLabel: t('dialog.confirm'),
      showCancel: true,
      onOk: async (value) => {
        const newName = (value && value.trim());
        if (!newName) { closeModal(); return; }
        closeModal();
        try {
          const res = await fetch(`/api/files/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
          if (res.status === 403) { toast(t('drive.noPermission')); return; }
          if (!res.ok) throw new Error('rename failed');
          f.name = newName;
          renderFiles();
        } catch (e) {
          toast(t('drive.loadError'));
        }
      }
    });
  };

  const deleteFile = (id) => {
    const f = files.find((x) => x.id === id);
    if (!f) return;
    openModal({
      title: t('drive.delete'),
      desc: t('drive.confirmDelete', { name: f.name }),
      okLabel: t('drive.delete'),
      showCancel: true,
      onOk: async () => {
        closeModal();
        try {
          const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (res.status === 403) { toast(t('drive.noPermission')); return; }
          if (!res.ok) throw new Error('delete failed');
          if (selectedId === id) clearSelection();
          await loadFiles();
        } catch (e) {
          toast(t('drive.loadError'));
        }
      }
    });
  };

  // Dispatch an action ('open'|'link'|'rename'|'delete') for a file id.
  const runAction = (action, id) => {
    if (!id) return;
    // Guard modifying actions against permission (server also enforces).
    if ((action === 'rename' || action === 'delete') && !((fileById(id) || {}).canModify)) {
      toast(t('drive.noPermission'));
      return;
    }
    if (action === 'open') openFile(id);
    else if (action === 'link') copyToClipboard(fileUrl(id));
    else if (action === 'rename') renameFile(id);
    else if (action === 'delete') deleteFile(id);
  };

  // ---------------------------------------------------------------------------
  // Card overflow menu
  // ---------------------------------------------------------------------------
  const openCardMenu = (btn, id) => {
    menuTargetId = id;
    // Only the owner / admins can rename or delete; reflect that in the menu.
    const canModify = !!(fileById(id) || {}).canModify;
    cardMenu.querySelectorAll('[data-action="rename"],[data-action="delete"]').forEach((b) => setActionEnabled(b, canModify));
    const rect = btn.getBoundingClientRect();
    cardMenu.classList.remove('hidden');
    // Measure now that it is visible, then clamp fully inside the viewport so every
    // item (including the last, "Delete") is reachable even for cards low on the page.
    const menuW = cardMenu.offsetWidth || 192;
    const menuH = cardMenu.offsetHeight || 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right - menuW;
    if (left < 8) left = 8;
    if (left + menuW > vw - 8) left = vw - 8 - menuW;
    // Prefer opening below the trigger; flip above if it would overflow the bottom.
    let top = rect.bottom + 4;
    if (top + menuH > vh - 8) top = Math.max(8, rect.top - menuH - 4);
    cardMenu.style.left = `${left}px`;
    cardMenu.style.top = `${top}px`;
  };
  const closeCardMenu = () => { cardMenu.classList.add('hidden'); menuTargetId = null; };

  // ---------------------------------------------------------------------------
  // Permissions management view
  // ---------------------------------------------------------------------------
  const isAdmin = () => currentRole === 'admin' || currentRole === 'superadmin';

  const showAdminView = () => {
    $('files-view').classList.add('hidden');
    $('admin-view').classList.remove('hidden');
    clearSelection();
    // Reset the search each time the view is opened.
    userFilter = '';
    const search = /** @type {HTMLInputElement} */ ($('perm-search'));
    if (search) search.value = '';
    loadUsers();
  };

  const showFilesView = () => {
    $('admin-view').classList.add('hidden');
    $('files-view').classList.remove('hidden');
  };

  // Localized label for a role value.
  const roleLabel = (role) => t(`role.${role}`);

  // Best-effort timestamp formatted in the browser's local time zone; falls back
  // to the raw value. A time-zone-naive string (e.g. "2026-06-16 10:00:00" from a
  // Postgres TIMESTAMP column) is treated as UTC so it converts correctly to the
  // viewer's zone; toLocaleString then renders in that local zone.
  const formatTime = (ts) => {
    if (!ts) return '';
    try {
      let s = ts;
      if (typeof s === 'string' && !/(z|[+-]\d{2}:?\d{2})$/i.test(s.trim())) {
        s = s.trim().replace(' ', 'T') + 'Z';
      }
      const d = new Date(s);
      if (isNaN(d.getTime())) return String(ts);
      return d.toLocaleString(getLang && getLang() === 'en' ? 'en-US' : 'zh-TW');
    } catch (e) { return String(ts); }
  };

  const renderUsers = () => {
    const tbody = $('perm-tbody');
    const wrap = $('perm-table-wrap');
    const empty = $('perm-empty');
    const error = $('perm-error');
    error.classList.add('hidden');
    tbody.innerHTML = '';

    if (!adminUsers.length) {
      wrap.classList.add('hidden');
      empty.querySelector('p').textContent = t('perm.empty');
      empty.classList.remove('hidden');
      return;
    }

    // Apply the search term against username, email, and id.
    const term = userFilter;
    const rows = term
      ? adminUsers.filter((u) => `${u.username || ''} ${u.email || ''} ${u.id || ''}`.toLowerCase().includes(term))
      : adminUsers;

    if (!rows.length) {
      wrap.classList.add('hidden');
      empty.querySelector('p').textContent = t('perm.noMatches');
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    wrap.classList.remove('hidden');

    rows.forEach((u) => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-outline-variant last:border-0';
      tr.setAttribute('data-id', u.id);
      const name = u.username || u.email || u.id;
      const initial = (String(name).trim()[0] || '?').toUpperCase();
      // Locked rows: env super admins and the signed-in user themselves cannot be edited here.
      const locked = u.superAdmin || u.self;

      let roleCell;
      if (locked) {
        const badge = u.superAdmin ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant';
        const youSuffix = u.self ? ` <span class="text-on-surface-variant">(${esc(t('perm.you'))})</span>` : '';
        roleCell = `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${badge}">${esc(roleLabel(u.role))}</span>${youSuffix}`;
      } else {
        // Hide the chevron for the plain "General User" role (requirement: the
        // dropdown caret is obscured when the current value is "user").
        const caretClass = u.role === 'user' ? ' no-caret' : '';
        roleCell = `
          <select class="role-select${caretClass} h-9 px-2 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary">
            <option value="user"${u.role === 'user' ? ' selected' : ''}>${esc(t('role.user'))}</option>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>${esc(t('role.admin'))}</option>
          </select>`;
      }

      // Avatar: the colored initial always renders underneath; when the user has a
      // provider picture (e.g. Google), it overlays the initial. If the image fails
      // to load it hides itself, revealing the initial — no fragile inline escaping.
      const img = u.picture
        ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer"
              class="absolute inset-0 w-full h-full rounded-full object-cover"
              onerror="this.style.display='none'"/>`
        : '';
      const avatar = `
        <span class="relative inline-flex w-8 h-8 shrink-0">
          <span class="absolute inset-0 rounded-full bg-primary text-on-primary flex items-center justify-center text-xs font-medium">${esc(initial)}</span>
          ${img}
        </span>`;

      tr.innerHTML = `
        <td class="px-4 py-3">
          <div class="flex items-center gap-3">
            ${avatar}
            <div class="min-w-0">
              <div class="font-medium text-on-surface truncate">${esc(name)}</div>
              <div class="text-xs text-on-surface-variant truncate">${esc(u.email || '')}</div>
            </div>
          </div>
        </td>
        <td class="px-4 py-3 text-on-surface-variant hidden sm:table-cell">${esc(u.provider || '')}</td>
        <td class="px-4 py-3 text-on-surface-variant hidden md:table-cell whitespace-nowrap">${esc(formatTime(u.last_login))}</td>
        <td class="px-4 py-3">${roleCell}</td>`;
      tbody.appendChild(tr);
    });
  };

  const loadUsers = async () => {
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('load failed');
      const data = await res.json();
      adminUsers = (data && data.users) || [];
      renderUsers();
    } catch (e) {
      adminUsers = [];
      $('perm-tbody').innerHTML = '';
      $('perm-table-wrap').classList.add('hidden');
      $('perm-empty').classList.add('hidden');
      $('perm-error').classList.remove('hidden');
    }
  };

  const patchRole = async (id, role, selectEl) => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      if (!res.ok) throw new Error('patch failed');
      const u = adminUsers.find((x) => x.id === id);
      if (u) u.role = role;
      toast(t('perm.updated'));
    } catch (e) {
      toast(t('perm.updateError'));
      // Revert the dropdown to the last known value.
      const u = adminUsers.find((x) => x.id === id);
      if (u && selectEl) selectEl.value = u.role;
    }
  };

  // ---------------------------------------------------------------------------
  // Language
  // ---------------------------------------------------------------------------
  const LANG_LABELS = { zh: '中文', en: 'English' };
  const applyLang = (lang) => {
    lang = (lang === 'en') ? 'en' : 'zh';
    try { localStorage.setItem('app-language', lang); } catch (e) {}
    if (translatePage) translatePage(lang);
    // The label shows the current language (consistent with the sheet editor);
    // the dropdown marks it with a check.
    $('lang-switch-label').textContent = LANG_LABELS[lang];
    document.querySelectorAll('#lang-switch-menu .lang-option').forEach((opt) => {
      const check = opt.querySelector('.lang-check');
      if (check) check.classList.toggle('hidden', /** @type {HTMLElement} */ (opt).dataset.lang !== lang);
    });
    // Re-apply dynamic (non-data-i18n) strings.
    if (selectedId) $('sel-count').textContent = t('drive.selected', { n: 1 });
    // The permissions table is rendered dynamically (role labels, etc.); re-render
    // it on language change while it is open.
    if (!$('admin-view').classList.contains('hidden')) renderUsers();
    // Re-apply view-dependent strings that translatePage just reset to defaults
    // (the heading and the empty-state message track the active rail filter).
    refreshViewStrings();
    const emptyMsg = emptyState.querySelector('p');
    if (emptyMsg && !emptyState.classList.contains('hidden')) {
      emptyMsg.textContent = t(emptyKey());
    }
    // Language is now applied — reveal the UI (see the FOUC guard in drive.html).
    if (document.documentElement) document.documentElement.classList.add('i18n-ready');
  };

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  const wireEvents = () => {
    // Card interactions (event-delegated).
    grid.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);
      const menuBtn = target.closest('.card-menu-btn');
      const card = target.closest('.file-card');
      if (!card) return;
      const id = card.getAttribute('data-id');
      if (menuBtn) {
        e.stopPropagation();
        if (!cardMenu.classList.contains('hidden') && menuTargetId === id) { closeCardMenu(); return; }
        openCardMenu(menuBtn, id);
        return;
      }
      selectFile(id);
    });
    grid.addEventListener('dblclick', (e) => {
      const target = /** @type {Element} */ (e.target);
      const card = target.closest('.file-card');
      if (card && !target.closest('.card-menu-btn')) openFile(card.getAttribute('data-id'));
    });

    // Card menu actions.
    cardMenu.addEventListener('click', (e) => {
      const btn = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (e.target).closest('[data-action]'));
      if (!btn || btn.disabled) return;
      const id = menuTargetId;
      closeCardMenu();
      runAction(btn.getAttribute('data-action'), id);
    });

    // Dismiss menus on outside click / Escape. (The avatar menu manages its own
    // outside-click dismissal inside the shared user-menu component.)
    document.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);
      if (!cardMenu.contains(target) && !target.closest('.card-menu-btn')) closeCardMenu();
      if (!$('lang-switch-menu').contains(target) && !target.closest('#lang-switch-btn')) {
        $('lang-switch-menu').classList.add('hidden');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCardMenu();
        $('lang-switch-menu').classList.add('hidden');
        if (!$('modal-overlay').classList.contains('hidden')) closeModal();
        else if (selectedId) clearSelection();
      }
    });

    // Selection action bar.
    $('sel-clear').addEventListener('click', clearSelection);
    $('sel-open').addEventListener('click', () => runAction('open', selectedId));
    $('sel-link').addEventListener('click', () => runAction('link', selectedId));
    $('sel-rename').addEventListener('click', () => runAction('rename', selectedId));
    $('sel-delete').addEventListener('click', () => runAction('delete', selectedId));

    // Left-rail navigation (Home / Shared with me / Starred).
    if (navHome) navHome.addEventListener('click', () => setView('home'));
    if (navShared) navShared.addEventListener('click', () => setView('shared'));
    if (navStarred) navStarred.addEventListener('click', () => setView('starred'));

    // New file.
    $('new-file-btn').addEventListener('click', () => createFile());

    // Modal buttons.
    $('modal-ok').addEventListener('click', () => {
      const cb = modalOnOk;
      const val = /** @type {HTMLInputElement} */ ($('modal-input')).value;
      if (cb) cb(val);
    });
    $('modal-cancel').addEventListener('click', closeModal);
    $('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });
    $('modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && modalOnOk) modalOnOk(/** @type {HTMLInputElement} */ ($('modal-input')).value); });
    $('modal-copy').addEventListener('click', () => copyToClipboard(/** @type {HTMLInputElement} */ ($('modal-link')).value));

    // The avatar menu (including its admin Permissions entry) is rendered by the
    // shared user-menu component; see loadProfile().
    $('perm-back').addEventListener('click', showFilesView);
    $('perm-tbody').addEventListener('change', (e) => {
      const sel = /** @type {HTMLSelectElement} */ (/** @type {Element} */ (e.target).closest('.role-select'));
      if (!sel) return;
      // Keep the chevron hidden while the value is the plain "User" role.
      sel.classList.toggle('no-caret', sel.value === 'user');
      const row = sel.closest('tr');
      if (row) patchRole(row.getAttribute('data-id'), sel.value, sel);
    });
    // Live search over the permissions table (name / email / id).
    $('perm-search').addEventListener('input', (e) => {
      userFilter = String(/** @type {HTMLInputElement} */ (e.target).value || '').trim().toLowerCase();
      renderUsers();
    });

    // Language switch (dropdown).
    $('lang-switch-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('lang-switch-menu');
      const wasOpen = !menu.classList.contains('hidden');
      closeCardMenu();
      menu.classList.toggle('hidden', wasOpen);
    });
    document.querySelectorAll('#lang-switch-menu .lang-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        applyLang(/** @type {HTMLElement} */ (opt).dataset.lang);
        $('lang-switch-menu').classList.add('hidden');
      });
    });

    // Reposition the open card menu on scroll/resize to keep it anchored sensibly.
    window.addEventListener('resize', closeCardMenu);
    window.addEventListener('scroll', closeCardMenu, true);
  };

  const loadProfile = () => {
    const userMenu = root.CoSheet && root.CoSheet.userMenu;
    if (!userMenu || !$('user-menu')) return;
    userMenu.init({
      mount: $('user-menu'),
      // Admins / super admins get a Permissions entry that opens the admin view.
      items: [{
        labelKey: 'drive.permissions',
        onClick: showAdminView,
        visible: (me) => me.role === 'admin' || me.role === 'superadmin',
      }],
      onLoad: (me) => {
        // Role affects the create quota; refresh the New button now that it's known.
        currentRole = me.role || 'user';
        updateCreateButton();
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  const init = async () => {
    wireEvents();
    applyLang(getLang ? getLang() : 'zh');
    loadProfile();
    await loadFiles();
  };

  const start = () => {
    if (loadLocales) {
      loadLocales().then(init).catch(init);
    } else {
      init();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
