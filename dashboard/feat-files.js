// S5 / V9 — Files panel: lazy project tree with git status dots, search, dotfiles toggle, read-only viewer
// with line numbers, "open in editor" and per-file history (specs/s5-design.md §2). S6 embeds it through
// MAW.ext.files.mount(el, { project_path }).
(() => {
  'use strict';
  const MAW = window.MAW;
  if (!MAW) return;
  const { api, t, toast, esc } = MAW;
  MAW.ext = MAW.ext || {};

  MAW.addI18n('vi', {
    'fl.tab': 'Tệp', 'fl.files': 'Tệp', 'fl.history': 'Lịch sử', 'fl.search': 'Tìm tệp theo tên…',
    'fl.dotfiles': 'Tệp ẩn', 'fl.refresh': 'Làm mới', 'fl.editorCfg': 'Trình soạn thảo',
    'fl.pickProject': 'Chọn một dự án trước.', 'fl.empty': 'Thư mục trống.', 'fl.noMatch': 'Không tìm thấy tệp nào.',
    'fl.pickFile': 'Chọn một tệp để xem.', 'fl.binary': 'Tệp nhị phân — không hiển thị.', 'fl.tooLarge': 'Tệp lớn hơn 1 MB — không hiển thị.',
    'fl.openEditor': 'Mở trong editor', 'fl.diff': 'Diff', 'fl.opened': 'Đã mở trong editor.', 'fl.truncated': 'Danh sách bị cắt bớt.',
    'fl.lines': '{n} dòng', 'fl.deleted': 'đã xoá', 'fl.historyOf': 'Commit gần đây chạm tới {path}', 'fl.historyRepo': 'Commit gần đây của dự án',
    'fl.noHistory': 'Chưa có commit nào.', 'fl.editorHelp': 'Mỗi dòng là một tham số. Dòng đầu là chương trình (.exe hoặc lệnh trong PATH). Dùng {file}, {line}, {dir}.',
    'fl.save': 'Lưu', 'fl.cancel': 'Huỷ', 'fl.reset': 'Mặc định', 'fl.saved': 'Đã lưu cấu hình editor.', 'fl.back': '← Cây thư mục',
    'fl.changed': '{n} thay đổi bên trong',
  });
  MAW.addI18n('en', {
    'fl.tab': 'Files', 'fl.files': 'Files', 'fl.history': 'History', 'fl.search': 'Find files by name…',
    'fl.dotfiles': 'Dotfiles', 'fl.refresh': 'Refresh', 'fl.editorCfg': 'Editor',
    'fl.pickProject': 'Pick a project first.', 'fl.empty': 'Empty folder.', 'fl.noMatch': 'No files found.',
    'fl.pickFile': 'Select a file to view it.', 'fl.binary': 'Binary file — not shown.', 'fl.tooLarge': 'File is larger than 1 MB — not shown.',
    'fl.openEditor': 'Open in editor', 'fl.diff': 'Diff', 'fl.opened': 'Opened in the editor.', 'fl.truncated': 'The list was cut short.',
    'fl.lines': '{n} lines', 'fl.deleted': 'deleted', 'fl.historyOf': 'Recent commits touching {path}', 'fl.historyRepo': 'Recent commits of the project',
    'fl.noHistory': 'No commits yet.', 'fl.editorHelp': 'One argument per line. The first line is the program (.exe or a command on PATH). Use {file}, {line}, {dir}.',
    'fl.save': 'Save', 'fl.cancel': 'Cancel', 'fl.reset': 'Default', 'fl.saved': 'Editor settings saved.', 'fl.back': '← Tree',
    'fl.changed': '{n} changes inside',
  });

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
  };
  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  const GIT_CLS = { M: 'm', A: 'a', '?': 'a', D: 'd', U: 'u', R: 'r', C: 'r' };
  const GIT_TIP = { M: 'modified', A: 'added', '?': 'untracked', D: 'deleted', U: 'conflict', R: 'renamed', C: 'copied' };
  const fmtSize = n => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  function mount(root, opts = {}) {
    const S = {
      project: opts.project_path || '', dotfiles: store.get('maw_fl_dot') === '1', tab: 'files',
      dirs: new Map(), open: new Set(['']), selected: '', file: null, q: '', results: null, history: null,
      seq: 0, destroyed: false,
    };
    root.classList.add('fl-root');
    root.innerHTML = `
      <div class="fl-bar">
        <input class="input fl-q" type="search" placeholder="${esc(t('fl.search'))}" aria-label="${esc(t('fl.search'))}">
        <label class="check sub"><input type="checkbox" class="fl-dot"> <span data-i="fl.dotfiles"></span></label>
        <button type="button" class="btn btn-sm" data-a="refresh" title="${esc(t('fl.refresh'))}" aria-label="${esc(t('fl.refresh'))}">↻</button>
        <button type="button" class="btn btn-sm" data-a="editor" title="${esc(t('fl.editorCfg'))}" aria-label="${esc(t('fl.editorCfg'))}">⚙</button>
      </div>
      <div class="fl-tabs seg" role="tablist"><button type="button" role="tab" data-tab="files"></button><button type="button" role="tab" data-tab="history"></button></div>
      <div class="fl-body">
        <div class="fl-tree" role="tree" tabindex="0"></div>
        <div class="fl-view"></div>
      </div>`;
    const $ = sel => root.querySelector(sel);
    $('.fl-dot').checked = S.dotfiles;

    const labels = () => {
      root.querySelectorAll('[data-i]').forEach(e => { e.textContent = t(e.dataset.i); });
      root.querySelector('[data-tab="files"]').textContent = t('fl.files');
      root.querySelector('[data-tab="history"]').textContent = t('fl.history');
      $('.fl-q').placeholder = t('fl.search');
    };

    async function loadDir(dir) {
      const seq = S.seq;
      try {
        const r = await api('files_tree' + qs({ project_path: S.project, dir, dotfiles: S.dotfiles ? 1 : 0 }));
        if (seq !== S.seq || S.destroyed) return;
        S.dirs.set(dir, r);
      } catch (e) {
        if (seq !== S.seq || S.destroyed) return;
        S.dirs.set(dir, { error: e.message, entries: [] });
      }
      paintTree();
    }

    function rowHtml(e, depth) {
      const isDir = e.type === 'dir';
      const open = isDir && S.open.has(e.path);
      const g = e.git ? `<span class="fl-dot-g g-${GIT_CLS[e.git] || 'm'}" title="${esc(GIT_TIP[e.git] || e.git)}">${esc(e.git)}</span>` : '';
      const inside = isDir && e.changed_inside ? `<span class="fl-dot-in" title="${esc(t('fl.changed', { n: e.changed_inside }))}"></span>` : '';
      return `<div class="fl-row${S.selected === e.path ? ' is-sel' : ''}${e.deleted ? ' is-del' : ''}" role="treeitem" tabindex="-1"
          data-path="${esc(e.path)}" data-type="${esc(e.type)}" ${isDir ? `aria-expanded="${open}"` : ''} style="--d:${depth}">
        <span class="fl-chev">${isDir ? (open ? '▾' : '▸') : ''}</span>
        <span class="fl-ico">${isDir ? '📁' : e.type === 'link' ? '🔗' : '📄'}</span>
        <span class="fl-name truncate">${esc(e.name)}</span>${inside}${g}
      </div>`;
    }

    function treeHtml(dir, depth) {
      const d = S.dirs.get(dir);
      if (!d) return `<div class="fl-row fl-load" style="--d:${depth}">…</div>`;
      if (d.error) return `<div class="fl-row t-err" style="--d:${depth}">${esc(d.error)}</div>`;
      if (!d.entries.length && depth === 0) return `<div class="empty">${esc(t('fl.empty'))}</div>`;
      let html = '';
      for (const e of d.entries) {
        html += rowHtml(e, depth);
        if (e.type === 'dir' && S.open.has(e.path)) html += treeHtml(e.path, depth + 1);
      }
      if (d.truncated) html += `<div class="fl-row sub" style="--d:${depth}">${esc(t('fl.truncated'))}</div>`;
      return html;
    }

    function paintTree() {
      const tree = $('.fl-tree');
      const focused = document.activeElement?.closest?.('.fl-row')?.dataset.path;
      if (S.q) {
        const r = S.results;
        tree.innerHTML = !r ? '<div class="fl-row">…</div>' : r.error ? `<div class="fl-row t-err">${esc(r.error)}</div>`
          : !r.results.length ? `<div class="empty">${esc(t('fl.noMatch'))}</div>`
          : r.results.map(e => `<div class="fl-row fl-hit${S.selected === e.path ? ' is-sel' : ''}" role="treeitem" tabindex="-1" data-path="${esc(e.path)}" data-type="${esc(e.type)}" style="--d:0">
              <span class="fl-ico">${e.type === 'dir' ? '📁' : '📄'}</span><span class="fl-name truncate">${esc(e.name)} <span class="faint">${esc(e.path)}</span></span>
              ${e.git ? `<span class="fl-dot-g g-${GIT_CLS[e.git] || 'm'}">${esc(e.git)}</span>` : ''}</div>`).join('')
            + (r.truncated ? `<div class="fl-row sub">${esc(t('fl.truncated'))}</div>` : '');
      } else tree.innerHTML = treeHtml('', 0);
      const rows = [...tree.querySelectorAll('.fl-row[data-path]')];
      const target = rows.find(r => r.dataset.path === focused) || rows.find(r => r.dataset.path === S.selected) || rows[0];
      if (target) target.tabIndex = 0;
      if (focused && target && tree.contains(document.activeElement)) target.focus();
    }

    function toggleDir(path, force) {
      const open = force ?? !S.open.has(path);
      if (open) { S.open.add(path); if (!S.dirs.has(path)) loadDir(path); }
      else S.open.delete(path);
      paintTree();
    }

    async function selectFile(path) {
      S.selected = path;
      S.file = { path, loading: true };
      paintTree();
      paintView();
      root.classList.add('show-view');
      try {
        const r = await api('files_read' + qs({ project_path: S.project, path }));
        if (S.selected !== path || S.destroyed) return;
        S.file = r;
      } catch (e) {
        if (S.selected !== path || S.destroyed) return;
        S.file = { path, error: e.message };
      }
      if (S.tab === 'history') loadHistory();
      paintView();
    }

    function codeHtml(f) {
      const lines = f.content.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const rv = MAW.ext.review;
      const lang = rv?.langOf ? rv.langOf(f.path) : 'text';
      const hl = rv?.highlight && lines.length <= 6000 ? s => rv.highlight(s, lang) : esc;
      const gutter = lines.map((_, i) => i + 1).join('\n');
      return `<div class="fl-code"><pre class="fl-gutter" aria-hidden="true">${gutter}</pre><pre class="fl-src">${lines.map(hl).join('\n')}</pre></div>`;
    }

    function paintView() {
      const v = $('.fl-view');
      if (S.tab === 'history') { paintHistory(v); return; }
      const f = S.file;
      if (!f) { v.innerHTML = `<div class="empty">${esc(t('fl.pickFile'))}</div>`; return; }
      const head = `<div class="fl-vh">
          <button type="button" class="btn btn-sm fl-back" data-a="back">${esc(t('fl.back'))}</button>
          <span class="mono fl-vpath truncate" title="${esc(f.path)}">${esc(f.path)}</span>
          ${f.git ? `<span class="fl-dot-g g-${GIT_CLS[f.git] || 'm'}">${esc(f.git)}</span>` : ''}
          <span class="sub">${esc(fmtSize(f.size))}${f.line_count != null ? ' · ' + esc(t('fl.lines', { n: f.line_count })) : ''}</span>
          <span class="fl-vacts">
            ${f.git && MAW.ext.review ? `<button type="button" class="btn btn-sm" data-a="diff">${esc(t('fl.diff'))}</button>` : ''}
            <button type="button" class="btn btn-sm" data-a="open-editor">${esc(t('fl.openEditor'))}</button>
          </span></div>`;
      let body;
      if (f.loading) body = '<div class="empty">…</div>';
      else if (f.error) body = `<div class="empty t-err">${esc(f.error)}</div>`;
      else if (f.binary) body = `<div class="empty">${esc(t('fl.binary'))}</div>`;
      else if (f.too_large) body = `<div class="empty">${esc(t('fl.tooLarge'))}</div>`;
      else if (f.content == null) body = `<div class="empty">${esc(t('fl.deleted'))}</div>`;
      else body = codeHtml(f);
      v.innerHTML = head + body;
    }

    async function loadHistory() {
      const path = S.selected;
      S.history = null;
      paintView();
      try {
        const r = await api('files_history' + qs({ project_path: S.project, path, limit: 30 }));
        if (S.selected !== path || S.destroyed) return;
        S.history = r;
      } catch (e) {
        if (S.selected !== path || S.destroyed) return;
        S.history = { error: e.message, commits: [] };
      }
      paintView();
    }

    function paintHistory(v) {
      const h = S.history;
      const title = S.selected ? t('fl.historyOf', { path: S.selected }) : t('fl.historyRepo');
      v.innerHTML = `<div class="fl-vh"><button type="button" class="btn btn-sm fl-back" data-a="back">${esc(t('fl.back'))}</button>
          <span class="sub truncate">${esc(title)}</span></div>` +
        (!h ? '<div class="empty">…</div>' : h.error ? `<div class="empty t-err">${esc(h.error)}</div>`
          : !h.commits.length ? `<div class="empty">${esc(t('fl.noHistory'))}</div>`
          : `<div class="fl-hist">${h.commits.map(c => `<button type="button" class="fl-commit" data-sha="${esc(c.sha)}">
              <span class="mono fl-sha">${esc(c.short)}</span><span class="fl-subj truncate">${esc(c.subject)}</span>
              <span class="rv-num"><span class="add">+${esc(c.additions ?? 0)}</span> <span class="del">−${esc(c.deletions ?? 0)}</span></span>
              <span class="sub fl-meta truncate">${esc(c.author)} · ${esc(new Date(c.date).toLocaleString(MAW.lang === 'en' ? 'en-GB' : 'vi-VN'))}</span></button>`).join('')}</div>`);
    }

    let searchTimer = 0;
    async function runSearch() {
      const q = S.q, seq = S.seq;
      if (!q) { paintTree(); return; }
      S.results = null;
      paintTree();
      try {
        const r = await api('files_search' + qs({ project_path: S.project, q, dotfiles: S.dotfiles ? 1 : 0, limit: 200 }));
        if (q !== S.q || seq !== S.seq || S.destroyed) return;
        S.results = r;
      } catch (e) {
        if (q !== S.q || seq !== S.seq || S.destroyed) return;
        S.results = { error: e.message, results: [] };
      }
      paintTree();
    }

    function refresh() {
      S.seq++;
      const open = [...S.open];
      S.dirs.clear();
      if (!S.project) { $('.fl-tree').innerHTML = `<div class="empty">${esc(t('fl.pickProject'))}</div>`; paintView(); return; }
      for (const d of open) loadDir(d);
      if (S.q) runSearch(); else paintTree();
      if (S.selected && S.file && !S.file.loading) selectFile(S.selected);
      else paintView();
      if (S.tab === 'history') loadHistory();
    }

    function setProject(path) {
      if (path === S.project) return;
      S.project = path || '';
      S.open = new Set(['']); S.selected = ''; S.file = null; S.history = null; S.results = null;
      root.classList.remove('show-view');
      refresh();
    }

    function setTab(tab) {
      S.tab = tab;
      root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
      if (tab === 'history') { root.classList.add('show-view'); loadHistory(); } else paintView();
    }

    async function openEditor() {
      const f = S.file;
      if (!f?.path) return;
      try { await api('files_open', { project_path: S.project, path: f.path, line: 1 }); toast(t('fl.opened'), 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }

    async function editorSettings() {
      let cfg;
      try { cfg = await api('files_config'); } catch (e) { toast(e.message, 'err'); return; }
      const back = document.createElement('div');
      back.className = 'rv-modal-back fl-modal-back';
      back.innerHTML = `<div class="rv-modal card" role="dialog" aria-modal="true" aria-label="${esc(t('fl.editorCfg'))}">
        <div class="card-h"><h2>${esc(t('fl.editorCfg'))}</h2></div>
        <div class="card-b stack"><p class="sub">${esc(t('fl.editorHelp'))}</p>
          <textarea class="input mono" rows="5" spellcheck="false">${esc((cfg.editor || []).join('\n'))}</textarea>
          <div class="row fl-end"><button type="button" class="btn btn-sm" data-m="reset">${esc(t('fl.reset'))}</button>
            <span style="flex:1"></span>
            <button type="button" class="btn" data-m="cancel">${esc(t('fl.cancel'))}</button>
            <button type="button" class="btn btn-primary" data-m="save">${esc(t('fl.save'))}</button></div></div></div>`;
      document.body.appendChild(back);
      const ta = back.querySelector('textarea');
      ta.focus();
      const close = () => back.remove();
      back.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      back.addEventListener('mousedown', e => { if (e.target === back) close(); });
      back.addEventListener('click', async e => {
        const m = e.target.closest('[data-m]')?.dataset.m;
        if (m === 'cancel') close();
        else if (m === 'reset') ta.value = (cfg.default_editor || []).join('\n');
        else if (m === 'save') {
          const editor = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          try { await api('files_config', { editor }); toast(t('fl.saved'), 'ok'); close(); }
          catch (err) { toast(err.message, 'err'); }
        }
      });
    }

    // Arrow-key navigation over the visible rows (WAI-ARIA tree pattern, simplified).
    function onTreeKey(e) {
      const rows = [...root.querySelectorAll('.fl-tree .fl-row[data-path]')];
      const cur = e.target.closest('.fl-row[data-path]') || rows[0];
      if (!cur) return;
      const i = rows.indexOf(cur);
      const focus = r => { if (!r) return; rows.forEach(x => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
      const isDir = cur.dataset.type === 'dir', path = cur.dataset.path;
      if (e.key === 'ArrowDown') { e.preventDefault(); focus(rows[i + 1]); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focus(rows[i - 1]); }
      else if (e.key === 'ArrowRight' && isDir && !S.q) { e.preventDefault(); if (!S.open.has(path)) toggleDir(path, true); else focus(rows[i + 1]); }
      else if (e.key === 'ArrowLeft' && !S.q) {
        e.preventDefault();
        if (isDir && S.open.has(path)) toggleDir(path, false);
        else { const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; focus(rows.find(r => r.dataset.path === parent)); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isDir && !S.q) toggleDir(path); else if (!isDir) selectFile(path);
      }
    }

    root.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      const tabBtn = e.target.closest('[data-tab]');
      const row = e.target.closest('.fl-tree .fl-row[data-path]');
      const commit = e.target.closest('[data-sha]');
      if (tabBtn) setTab(tabBtn.dataset.tab);
      else if (commit) MAW.ext.review?.open({ project_path: S.project, source: 'commit', ref: commit.dataset.sha, path: S.selected || '' });
      else if (row) {
        if (row.dataset.type === 'dir' && !S.q) toggleDir(row.dataset.path);
        else if (row.dataset.type === 'dir') { S.q = ''; $('.fl-q').value = ''; const parts = row.dataset.path.split('/'); parts.forEach((_, k) => toggleDir(parts.slice(0, k + 1).join('/'), true)); }
        else selectFile(row.dataset.path);
      }
      else if (a === 'refresh') refresh();
      else if (a === 'editor') editorSettings();
      else if (a === 'open-editor') openEditor();
      else if (a === 'diff') MAW.ext.review?.open({ project_path: S.project, source: 'worktree', path: S.file?.path || '' });
      else if (a === 'back') root.classList.remove('show-view');
    });
    $('.fl-tree').addEventListener('keydown', onTreeKey);
    $('.fl-q').addEventListener('input', e => {
      clearTimeout(searchTimer);
      S.q = e.target.value.trim().slice(0, 200);
      searchTimer = setTimeout(runSearch, 200);
      if (!S.q) paintTree();
    });
    $('.fl-dot').addEventListener('change', e => { S.dotfiles = e.target.checked; store.set('maw_fl_dot', S.dotfiles ? '1' : '0'); refresh(); });

    labels();
    setTab('files');
    refresh();
    return {
      setProject, refresh, labels,
      destroy() { S.destroyed = true; clearTimeout(searchTimer); root.innerHTML = ''; root.classList.remove('fl-root', 'show-view'); },
    };
  }

  // "Files" tab in the classic dashboard, following the selected project.
  let ctl = null;
  MAW.addTab({
    id: 'files',
    title: () => t('fl.tab'),
    render(panel) {
      const p = MAW.project();
      if (!ctl) { ctl = mount(panel, { project_path: p?.path || '' }); return; }
      ctl.labels();
      ctl.setProject(p?.path || '');
    },
  });
  MAW.on('project-change', () => { if (ctl) ctl.setProject(MAW.project()?.path || ''); });

  MAW.ext.files = { mount };
})();
