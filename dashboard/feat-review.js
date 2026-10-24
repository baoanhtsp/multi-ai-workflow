// S5 / N4 — Diff review: in-house renderer, per-file / per-hunk accept or reject, inline comments sent back
// to the agent as a fix prompt, and a review verdict stored with the job (specs/s5-design.md §1).
(() => {
  'use strict';
  const MAW = window.MAW;
  if (!MAW) return;
  const { api, t, toast, esc } = MAW;
  MAW.ext = MAW.ext || {};

  MAW.addI18n('vi', {
    'rv.tab': 'Review diff',
    'rv.jobAction': 'Xem diff',
    'rv.src.worktree': 'Working tree', 'rv.src.branch': 'Nhánh', 'rv.src.job': 'Job', 'rv.src.commit': 'Commit',
    'rv.base': 'So với (base)', 'rv.open': 'Mở diff', 'rv.pickProject': 'Chọn một dự án trước.',
    'rv.notGit': 'Dự án này không phải git repo.', 'rv.none': 'Không có mục nào.',
    'rv.title': 'Review diff', 'rv.close': 'Đóng', 'rv.reload': 'Tải lại',
    'rv.unified': 'Gộp', 'rv.split': 'Song song', 'rv.ignoreWs': 'Bỏ qua khoảng trắng', 'rv.context': 'Ngữ cảnh',
    'rv.files': 'Tệp', 'rv.filter': 'Lọc tệp…', 'rv.empty': 'Không có thay đổi nào.',
    'rv.accept': 'Chấp nhận', 'rv.reject': 'Từ chối', 'rv.reset': 'Bỏ đánh dấu',
    'rv.acceptFile': 'Chấp nhận tệp', 'rv.rejectFile': 'Từ chối tệp',
    'rv.accepted': 'Đã chấp nhận', 'rv.rejected': 'Đã từ chối',
    'rv.readOnly': 'Chỉ xem: phía "sau" của diff này không phải thư mục làm việc, nên không thể từ chối.',
    'rv.tooLarge': 'Tệp quá lớn để hiển thị.', 'rv.loadAnyway': 'Vẫn tải', 'rv.binary': 'Tệp nhị phân.',
    'rv.omitted': 'Bị lược bớt (quá nhiều tệp).', 'rv.truncated': 'Diff quá lớn — chỉ hiển thị phần đầu.',
    'rv.fold': '⋯ {n} dòng không đổi', 'rv.untracked': 'mới (chưa track)',
    'rv.confirmTitle': 'Từ chối thay đổi?',
    'rv.confirmHunk': 'Hoàn tác hunk {hunk} trong {file}. Một bản chụp an toàn được tạo trước (refs/maw/checkpoints/review-…), có thể khôi phục.',
    'rv.confirmFile': 'Hoàn tác TOÀN BỘ thay đổi của {file}. Một bản chụp an toàn được tạo trước, có thể khôi phục.',
    'rv.cancel': 'Huỷ', 'rv.doReject': 'Từ chối & hoàn tác',
    'rv.rejectedToast': 'Đã hoàn tác. Bản chụp: {ref}', 'rv.stale': 'Diff đã thay đổi — đã tải lại.',
    'rv.comment': 'Góp ý', 'rv.addComment': 'Thêm góp ý cho dòng {line}', 'rv.save': 'Lưu', 'rv.edit': 'Sửa',
    'rv.delete': 'Xoá', 'rv.resolve': 'Đã xử lý', 'rv.reopen': 'Mở lại', 'rv.sent': 'đã gửi',
    'rv.commentPh': 'Cần sửa gì ở dòng này? (Ctrl+Enter để lưu)',
    'rv.sendFix': 'Gửi góp ý cho agent', 'rv.sendFixN': 'Gửi góp ý cho agent ({n})',
    'rv.fixTitle': 'Gửi góp ý thành prompt sửa lỗi', 'rv.agent': 'Agent', 'rv.role': 'Vai trò', 'rv.note': 'Ghi chú thêm',
    'rv.preview': 'Xem trước prompt', 'rv.startFix': 'Chạy job sửa', 'rv.makeCard': 'Tạo thẻ S2',
    'rv.fixStarted': 'Đã chạy job sửa {id}', 'rv.fixRemaining': 'còn {n} góp ý cho lần sửa sau', 'rv.cardMade': 'Đã tạo thẻ trong bảng việc.', 'rv.noComments': 'Chưa có góp ý nào chưa gửi.',
    'rv.verdict': 'Kết luận', 'rv.score': 'Điểm', 'rv.saveVerdict': 'Lưu kết luận', 'rv.verdictSaved': 'Đã lưu kết luận.',
    'rv.noCheckpoint': 'Job này không có checkpoint (S1) — đang hiển thị working tree.',
    'rv.showFiles': 'Danh sách tệp', 'rv.stats': '{files} tệp · +{add} −{del}',
    'rv.recent': 'Kết luận gần đây', 'rv.openComments': '{n} góp ý chưa gửi',
  });
  MAW.addI18n('en', {
    'rv.tab': 'Diff review',
    'rv.jobAction': 'View diff',
    'rv.src.worktree': 'Working tree', 'rv.src.branch': 'Branch', 'rv.src.job': 'Job', 'rv.src.commit': 'Commit',
    'rv.base': 'Compared to (base)', 'rv.open': 'Open diff', 'rv.pickProject': 'Pick a project first.',
    'rv.notGit': 'This project is not a git repository.', 'rv.none': 'Nothing here.',
    'rv.title': 'Diff review', 'rv.close': 'Close', 'rv.reload': 'Reload',
    'rv.unified': 'Unified', 'rv.split': 'Split', 'rv.ignoreWs': 'Ignore whitespace', 'rv.context': 'Context',
    'rv.files': 'Files', 'rv.filter': 'Filter files…', 'rv.empty': 'No changes.',
    'rv.accept': 'Accept', 'rv.reject': 'Reject', 'rv.reset': 'Clear mark',
    'rv.acceptFile': 'Accept file', 'rv.rejectFile': 'Reject file',
    'rv.accepted': 'Accepted', 'rv.rejected': 'Rejected',
    'rv.readOnly': 'Read-only: the "after" side of this diff is not a working directory, so changes cannot be rejected.',
    'rv.tooLarge': 'File too large to show.', 'rv.loadAnyway': 'Load anyway', 'rv.binary': 'Binary file.',
    'rv.omitted': 'Omitted (too many files).', 'rv.truncated': 'The diff is too large — only the start is shown.',
    'rv.fold': '⋯ {n} unchanged lines', 'rv.untracked': 'new (untracked)',
    'rv.confirmTitle': 'Reject this change?',
    'rv.confirmHunk': 'Reverts hunk {hunk} in {file}. A safety snapshot is taken first (refs/maw/checkpoints/review-…) so it can be restored.',
    'rv.confirmFile': 'Reverts ALL changes in {file}. A safety snapshot is taken first so it can be restored.',
    'rv.cancel': 'Cancel', 'rv.doReject': 'Reject & revert',
    'rv.rejectedToast': 'Reverted. Snapshot: {ref}', 'rv.stale': 'The diff changed — reloaded.',
    'rv.comment': 'Comment', 'rv.addComment': 'Comment on line {line}', 'rv.save': 'Save', 'rv.edit': 'Edit',
    'rv.delete': 'Delete', 'rv.resolve': 'Resolve', 'rv.reopen': 'Reopen', 'rv.sent': 'sent',
    'rv.commentPh': 'What should change on this line? (Ctrl+Enter saves)',
    'rv.sendFix': 'Send feedback to agent', 'rv.sendFixN': 'Send feedback to agent ({n})',
    'rv.fixTitle': 'Turn comments into a fix prompt', 'rv.agent': 'Agent', 'rv.role': 'Role', 'rv.note': 'Extra note',
    'rv.preview': 'Preview prompt', 'rv.startFix': 'Run fix job', 'rv.makeCard': 'Create S2 card',
    'rv.fixStarted': 'Fix job {id} started', 'rv.fixRemaining': '{n} comments left for the next fix', 'rv.cardMade': 'Card created on the board.', 'rv.noComments': 'No unsent comments yet.',
    'rv.verdict': 'Verdict', 'rv.score': 'Score', 'rv.saveVerdict': 'Save verdict', 'rv.verdictSaved': 'Verdict saved.',
    'rv.noCheckpoint': 'This job has no checkpoint (S1) — showing the working tree instead.',
    'rv.showFiles': 'File list', 'rv.stats': '{files} files · +{add} −{del}',
    'rv.recent': 'Recent verdicts', 'rv.openComments': '{n} unsent comments',
  });

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
  };
  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  const ROLES = ['backend', 'frontend', 'tester', 'reviewer', 'architect', 'leader'];

  // ---------- Syntax-light colouring (line based, escaped output only) ----------
  const EXT_LANG = {
    ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', json: 'json', css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', md: 'md', ps1: 'ps', psm1: 'ps', psd1: 'ps',
    py: 'py', sh: 'sh', bash: 'sh', yml: 'sh', yaml: 'sh', toml: 'sh', ini: 'sh', php: 'c', go: 'c', rs: 'c',
    java: 'c', cs: 'c', c: 'c', h: 'c', cpp: 'c', hpp: 'c', kt: 'c', swift: 'c', sql: 'sql',
  };
  const words = s => new Set(s.split(' '));
  const KW = {
    js: words('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set null undefined true false interface type enum implements readonly as from declare keyof namespace private public protected abstract'),
    c: words('break case catch class const continue default do else enum extends final finally for foreach func function go if import in interface let match mut namespace new package private protected public return self static struct switch this throw trait try type use using var void while fn impl pub mod true false null nil None echo'),
    py: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self'),
    ps: words('begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while $true $false $null'),
    sh: words('if then else elif fi for while do done case esac function return in export local true false null'),
    sql: words('select from where insert into update delete create table alter drop index join left right inner outer on group by order having limit offset and or not null as values set primary key'),
    css: words('important media import supports keyframes'),
    json: words('true false null'),
  };
  const LINE_COMMENT = { js: '//', c: '//', py: '#', ps: '#', sh: '#', sql: '--' };
  function langOf(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    return (m && EXT_LANG[m[1].toLowerCase()]) || 'text';
  }
  function highlight(text, lang) {
    const kw = KW[lang];
    if (!kw && lang !== 'html' && lang !== 'md') return esc(text);
    if (lang === 'md') return /^\s*#/.test(text) ? `<span class="hl-k">${esc(text)}</span>` : esc(text);
    const lc = LINE_COMMENT[lang];
    const parts = [];
    if (lc) parts.push(lc.replace(/[/-]/g, '\\$&') + '.*$');
    parts.push('/\\*.*?(?:\\*/|$)', '<!--.*?(?:-->|$)');
    const re = new RegExp(
      '(' + parts.join('|') + ')' +
      '|("(?:[^"\\\\]|\\\\.)*"?|\'(?:[^\'\\\\]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?)' +
      '|(\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)' +
      '|(\\$?[A-Za-z_][\\w$-]*)', 'g');
    let out = '', last = 0, m;
    const ci = lang === 'ps' || lang === 'sql';
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index));
      const tok = esc(m[0]);
      if (m[1]) out += `<span class="hl-c">${tok}</span>`;
      else if (m[2]) out += `<span class="hl-s">${tok}</span>`;
      else if (m[3]) out += `<span class="hl-n">${tok}</span>`;
      else if (kw && kw.has(ci ? m[0].toLowerCase() : m[0])) out += `<span class="hl-k">${tok}</span>`;
      else if (lang === 'ps' && m[0][0] === '$') out += `<span class="hl-v">${tok}</span>`;
      else out += tok;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  // ---------- Small modal helpers ----------
  function modal(html, { wide } = {}) {
    const back = document.createElement('div');
    back.className = 'rv-modal-back';
    back.innerHTML = `<div class="rv-modal card${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const box = back.firstElementChild;
    const close = () => back.remove();
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    setTimeout(() => (box.querySelector('[autofocus]') || box.querySelector('button, textarea, input, select'))?.focus(), 0);
    return { box, close };
  }
  function confirmDanger(title, text, okLabel) {
    return new Promise(resolve => {
      const { box, close } = modal(`<div class="card-h"><h2>${esc(title)}</h2></div>
        <div class="card-b stack"><p class="rv-confirm-text">${esc(text)}</p>
        <div class="row rv-end"><button type="button" class="btn" data-a="no">${esc(t('rv.cancel'))}</button>
        <button type="button" class="btn btn-primary rv-danger" data-a="yes" autofocus>${esc(okLabel)}</button></div></div>`);
      let done = false;
      const finish = v => { if (!done) { done = true; close(); resolve(v); } };
      box.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) finish(b.dataset.a === 'yes'); });
      new MutationObserver((_, obs) => { if (!box.isConnected) { obs.disconnect(); finish(false); } }).observe(document.body, { childList: true });
    });
  }

  // ---------- Diff viewer overlay ----------
  let V = null; // the open viewer state

  function open(params) {
    const source = params.source || 'worktree';
    // A job diff takes its project from the job meta, so the selected project is only a fallback there.
    const p = { project_path: params.project_path || (source === 'job' ? '' : MAW.project()?.path || ''), source,
      ref: params.ref || '', base: params.base || '', path: params.path || '' };
    if (!p.project_path && source !== 'job') { toast(t('rv.pickProject'), 'warn'); return; }
    if (V) closeViewer();
    const el = document.createElement('div');
    el.className = 'rv-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="rv-top">
        <button type="button" class="btn btn-sm rv-files-btn" data-act="toggle-files" aria-label="${esc(t('rv.showFiles'))}">☰</button>
        <div class="rv-title"><b>${esc(t('rv.title'))}</b> <span class="rv-src mono truncate"></span></div>
        <span class="rv-stats sub"></span>
        <div class="rv-tools">
          <div class="seg" role="group"><button type="button" data-view="unified">${esc(t('rv.unified'))}</button><button type="button" data-view="split">${esc(t('rv.split'))}</button></div>
          <label class="check sub"><input type="checkbox" data-opt="ws"> ${esc(t('rv.ignoreWs'))}</label>
          <label class="sub row rv-ctx">${esc(t('rv.context'))} <select data-opt="ctx"><option>3</option><option>5</option><option>10</option><option>20</option></select></label>
          <button type="button" class="btn btn-sm" data-act="reload">↻ ${esc(t('rv.reload'))}</button>
          <button type="button" class="btn btn-sm" data-act="close" aria-label="${esc(t('rv.close'))}">✕</button>
        </div>
      </div>
      <div class="rv-notice hidden"></div>
      <div class="rv-body">
        <aside class="rv-side"><input class="input rv-filter" type="search" placeholder="${esc(t('rv.filter'))}"><div class="rv-flist"></div></aside>
        <main class="rv-main" tabindex="-1"><div class="empty">…</div></main>
      </div>
      <div class="rv-foot">
        <button type="button" class="btn btn-primary" data-act="send-fix"></button>
        <div class="rv-verdict row">
          <span class="sub">${esc(t('rv.verdict'))}</span>
          <select data-v="verdict"><option value="APPROVED">APPROVED</option><option value="CHANGES_REQUESTED">CHANGES_REQUESTED</option></select>
          <input class="input" data-v="score" type="number" min="0" max="10" step="0.5" value="8.5" aria-label="${esc(t('rv.score'))}">
          <span class="sub">/10</span>
          <button type="button" class="btn btn-sm" data-act="verdict">${esc(t('rv.saveVerdict'))}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('rv-locked');
    V = { el, p, data: null, view: store.get('maw_rv_view') === 'split' ? 'split' : 'unified', ws: false, ctx: 3,
      collapsed: new Set(), unfold: new Set(), draft: null, editing: null, prevFocus: document.activeElement };
    el.querySelector('[data-opt="ctx"]').value = '3';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    // On the document, so Escape still works after focus fell back to <body> (e.g. a closed dialog).
    document.addEventListener('keydown', onKey);
    el.querySelector('.rv-filter').addEventListener('input', renderFileList);
    syncTools();
    load();
    el.querySelector('.rv-main').focus();
  }

  function closeViewer() {
    if (!V) return;
    V.el.remove();
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('rv-locked');
    try { V.prevFocus?.focus?.(); } catch { /* element gone */ }
    V = null;
  }

  function syncTools() {
    V.el.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === V.view)));
  }

  async function load(keepScroll) {
    const v = V;
    const main = v.el.querySelector('.rv-main');
    const top = main.scrollTop;
    if (!keepScroll) main.innerHTML = '<div class="empty">…</div>';
    try {
      const d = await api('review_diff' + qs({ ...v.p, context: v.ctx, ignore_ws: v.ws ? 1 : '' }));
      if (V !== v) return;
      v.data = d;
      notice(d.truncated ? t('rv.truncated') : (!d.writable ? t('rv.readOnly') : ''), d.truncated ? 'warn' : 'info');
    } catch (e) {
      if (V !== v) return;
      if (e.status === 404 && v.p.source === 'job') {
        v.p = { ...v.p, source: 'worktree', ref: '', project_path: v.p.project_path || MAW.project()?.path || '' };
        if (!v.p.project_path) { main.innerHTML = `<div class="empty">${esc(t('rv.pickProject'))}</div>`; return; }
        toast(t('rv.noCheckpoint'), 'warn');
        return load();
      }
      main.innerHTML = `<div class="empty t-err">${esc(e.message)}</div>`;
      return;
    }
    render();
    if (keepScroll) main.scrollTop = top;
  }

  function notice(text, kind) {
    const n = V.el.querySelector('.rv-notice');
    n.textContent = text || '';
    n.className = 'rv-notice ' + (kind || 'info') + (text ? '' : ' hidden');
  }

  const session = () => V.data?.session || (V.data.session = { states: {}, comments: [], verdict: null, fix_jobs: [] });
  const fileState = path => session().states?.[path] || { file: null, hunks: {} };
  const commentsFor = path => (session().comments || []).filter(c => c.path === path);
  const unsent = () => (session().comments || []).filter(c => !c.resolved && !c.sent_at);

  function render() {
    const d = V.data;
    const src = d.source === 'worktree' ? t('rv.src.worktree') : `${t('rv.src.' + d.source)} ${d.ref}${d.base ? ' ← ' + d.base : ''}`;
    V.el.querySelector('.rv-src').textContent = `${src} · ${d.project_path}`;
    V.el.querySelector('.rv-src').title = `${src} · ${d.project_path}`;
    V.el.querySelector('.rv-stats').textContent = t('rv.stats', { files: d.stats?.files ?? d.files.length, add: d.stats?.additions ?? 0, del: d.stats?.deletions ?? 0 });
    const verdict = session().verdict;
    if (verdict) {
      V.el.querySelector('[data-v="verdict"]').value = verdict.verdict;
      V.el.querySelector('[data-v="score"]').value = verdict.score;
    }
    renderFileList();
    renderFiles();
    renderFoot();
  }

  function renderFoot() {
    const n = unsent().length;
    const b = V.el.querySelector('[data-act="send-fix"]');
    b.textContent = n ? t('rv.sendFixN', { n }) : t('rv.sendFix');
  }

  function stateMark(s) {
    return s === 'accepted' ? `<span class="rv-mark ok" title="${esc(t('rv.accepted'))}">✓</span>`
      : s === 'rejected' ? `<span class="rv-mark err" title="${esc(t('rv.rejected'))}">✕</span>` : '';
  }

  function renderFileList() {
    if (!V?.data) return;
    const q = V.el.querySelector('.rv-filter').value.trim().toLowerCase();
    const list = V.el.querySelector('.rv-flist');
    const files = V.data.files.filter(f => !q || f.path.toLowerCase().includes(q));
    list.innerHTML = files.length ? files.map(f => {
      const st = fileState(f.path), nc = commentsFor(f.path).length;
      const name = f.path.split('/').pop(), dir = f.path.slice(0, -name.length);
      return `<button type="button" class="rv-fitem" data-goto="${esc(f.path)}" title="${esc(f.path)}">
        <span class="rv-st st-${esc(f.status)}">${esc(f.status)}</span>
        <span class="rv-fname truncate"><span class="faint">${esc(dir)}</span>${esc(name)}</span>
        ${stateMark(st.file)}${nc ? `<span class="rv-cn">💬${nc}</span>` : ''}
        <span class="rv-num"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span></button>`;
    }).join('') : `<div class="empty">${esc(t('rv.none'))}</div>`;
  }

  function renderFiles() {
    const main = V.el.querySelector('.rv-main');
    if (!V.data.files.length) { main.innerHTML = `<div class="empty">${esc(t('rv.empty'))}</div>`; return; }
    main.innerHTML = V.data.files.map(fileHtml).join('');
  }

  function fileHtml(f) {
    const st = fileState(f.path);
    const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (!V.collapsed.has('init:' + f.path)) {
      V.collapsed.add('init:' + f.path);
      if (lines > 1500 || st.file) V.collapsed.add(f.path);
    }
    const collapsed = V.collapsed.has(f.path);
    const w = V.data.writable;
    const rename = f.old_path && f.old_path !== f.path ? `<span class="faint">${esc(f.old_path)} → </span>` : '';
    let body = '';
    if (!collapsed) {
      if (f.binary) body = `<div class="rv-msg">${esc(t('rv.binary'))}</div>`;
      else if (f.omitted) body = `<div class="rv-msg">${esc(t('rv.omitted'))} <button type="button" class="btn-link" data-act="load-file">${esc(t('rv.loadAnyway'))}</button></div>`;
      else if (f.too_large) body = `<div class="rv-msg">${esc(t('rv.tooLarge'))} <button type="button" class="btn-link" data-act="load-file">${esc(t('rv.loadAnyway'))}</button></div>`;
      else body = f.hunks.map(h => hunkHtml(f, h, st)).join('');
    }
    return `<section class="rv-file${st.file ? ' is-' + st.file : ''}" data-path="${esc(f.path)}">
      <header class="rv-fh">
        <button type="button" class="rv-chev" data-act="collapse" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
        <span class="rv-st st-${esc(f.status)}">${esc(f.status)}</span>
        <span class="rv-path mono truncate" title="${esc(f.path)}">${rename}${esc(f.path)}</span>
        ${f.untracked ? `<span class="badge b-info">${esc(t('rv.untracked'))}</span>` : ''}
        <span class="rv-num"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
        ${stateMark(st.file)}
        <span class="rv-acts">
          ${st.file ? `<button type="button" class="btn btn-sm" data-act="reset-file">${esc(t('rv.reset'))}</button>` : `
          <button type="button" class="btn btn-sm rv-ok" data-act="accept-file">✓ ${esc(t('rv.acceptFile'))}</button>
          ${w ? `<button type="button" class="btn btn-sm rv-no" data-act="reject-file">✕ ${esc(t('rv.rejectFile'))}</button>` : ''}`}
        </span>
      </header>
      ${body ? `<div class="rv-fbody">${body}</div>` : ''}
    </section>`;
  }

  function hunkHtml(f, h, st) {
    const hs = st.hunks?.[h.id] || null;
    const w = V.data.writable;
    const lang = langOf(f.path);
    const rows = V.view === 'split' ? splitRows(f, h, lang) : unifiedRows(f, h, lang);
    return `<div class="rv-hunk${hs ? ' is-' + hs : ''}" data-hunk="${esc(h.id)}">
      <div class="rv-hh"><code class="truncate">${esc(h.header)}</code>${stateMark(hs)}
        <span class="rv-acts">${hs ? `<button type="button" class="btn btn-sm" data-act="reset-hunk">${esc(t('rv.reset'))}</button>` : `
          <button type="button" class="btn btn-sm rv-ok" data-act="accept-hunk">✓ ${esc(t('rv.accept'))}</button>
          ${w ? `<button type="button" class="btn btn-sm rv-no" data-act="reject-hunk">✕ ${esc(t('rv.reject'))}</button>` : ''}`}</span></div>
      <div class="rv-scroll"><table class="rv-tbl ${V.view}"><tbody>${rows}</tbody></table></div>
    </div>`;
  }

  // Walks a hunk once and yields lines with old/new numbers, folding long unchanged runs.
  function walk(h) {
    const out = [];
    let o = h.old_start, n = h.new_start;
    for (const [type, text] of h.lines) {
      if (type === ' ') out.push({ type, text, o: o++, n: n++ });
      else if (type === '-') out.push({ type, text, o: o++, n: null });
      else if (type === '+') out.push({ type, text, o: null, n: n++ });
      else if (out.length) out[out.length - 1].nonl = true;
    }
    const res = [];
    for (let i = 0; i < out.length;) {
      if (out[i].type !== ' ') { res.push(out[i++]); continue; }
      let j = i;
      while (j < out.length && out[j].type === ' ') j++;
      const run = j - i, key = h.id + ':' + i;
      if (run > 8 && !V.unfold.has(key)) {
        const head = i === 0 ? 0 : 3, tail = j === out.length ? 0 : 3;
        res.push(...out.slice(i, i + head));
        res.push({ fold: true, key, count: run - head - tail });
        res.push(...out.slice(j - tail, j));
      } else res.push(...out.slice(i, j));
      i = j;
    }
    return res;
  }

  function lnCell(f, num, side) {
    if (num == null) return '<td class="rv-ln"></td>';
    return `<td class="rv-ln" data-line="${num}" data-side="${side}" title="${esc(t('rv.addComment', { line: num }))}">${num}</td>`;
  }
  const signOf = type => type === '+' ? '+' : type === '-' ? '−' : ' ';
  const cls = type => type === '+' ? 'add' : type === '-' ? 'del' : 'ctx';
  const codeCell = (l, lang) => `<td class="rv-code ${cls(l.type)}"><span class="rv-sign">${signOf(l.type)}</span>${highlight(l.text, lang)}${l.nonl ? '<span class="rv-nonl" title="No newline at end of file">⏎̸</span>' : ''}</td>`;

  function unifiedRows(f, h, lang) {
    let html = '';
    for (const l of walk(h)) {
      if (l.fold) { html += `<tr class="rv-fold"><td colspan="3"><button type="button" class="btn-link" data-unfold="${esc(l.key)}">${esc(t('rv.fold', { n: l.count }))}</button></td></tr>`; continue; }
      html += `<tr class="${cls(l.type)}">${lnCell(f, l.o, 'old')}${lnCell(f, l.n, 'new')}${codeCell(l, lang)}</tr>`;
      html += commentRows(f, l, 3);
    }
    return html;
  }

  function splitRows(f, h, lang) {
    const ls = walk(h);
    let html = '';
    const empty = '<td class="rv-ln"></td><td class="rv-code empty"></td>';
    for (let i = 0; i < ls.length;) {
      const l = ls[i];
      if (l.fold) { html += `<tr class="rv-fold"><td colspan="4"><button type="button" class="btn-link" data-unfold="${esc(l.key)}">${esc(t('rv.fold', { n: l.count }))}</button></td></tr>`; i++; continue; }
      if (l.type === ' ') {
        html += `<tr>${lnCell(f, l.o, 'old')}${codeCell(l, lang)}${lnCell(f, l.n, 'new')}${codeCell(l, lang)}</tr>` + commentRows(f, l, 4);
        i++; continue;
      }
      const dels = [], adds = [];
      while (i < ls.length && ls[i].type === '-') dels.push(ls[i++]);
      while (i < ls.length && ls[i].type === '+') adds.push(ls[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const a = dels[k], b = adds[k];
        html += `<tr>${a ? lnCell(f, a.o, 'old') + codeCell(a, lang) : empty}${b ? lnCell(f, b.n, 'new') + codeCell(b, lang) : empty}</tr>`;
        if (a) html += commentRows(f, a, 4);
        if (b) html += commentRows(f, b, 4);
      }
    }
    return html;
  }

  function commentRows(f, l, span) {
    const here = c => (c.side === 'old' ? l.o != null && c.line === l.o && l.type !== '+' : l.n != null && c.line === l.n && l.type !== '-');
    const list = commentsFor(f.path).filter(here);
    const draftHere = V.draft && V.draft.path === f.path &&
      (V.draft.side === 'old' ? V.draft.line === l.o && l.type !== '+' : V.draft.line === l.n && l.type !== '-');
    if (!list.length && !draftHere) return '';
    let inner = list.map(c => V.editing === c.id ? editorHtml(c.body, c.id) : `
      <div class="rv-cmt${c.resolved ? ' resolved' : ''}" data-cid="${esc(c.id)}">
        <div class="rv-cmt-body">${esc(c.body)}</div>
        <div class="rv-cmt-meta sub">${esc(c.side)}:${esc(c.line)} · ${esc(fmtTime(c.updated_at || c.created_at))}${c.sent_at ? ' · ' + esc(t('rv.sent')) : ''}
          <button type="button" class="btn-link" data-cact="edit">${esc(t('rv.edit'))}</button>
          <button type="button" class="btn-link" data-cact="resolve">${esc(c.resolved ? t('rv.reopen') : t('rv.resolve'))}</button>
          <button type="button" class="btn-link danger" data-cact="delete">${esc(t('rv.delete'))}</button></div>
      </div>`).join('');
    if (draftHere) inner += editorHtml('', '');
    return `<tr class="rv-cmt-row"><td colspan="${span}">${inner}</td></tr>`;
  }
  function editorHtml(body, id) {
    return `<div class="rv-cmt-edit" data-edit="${esc(id)}"><textarea class="input" rows="3" placeholder="${esc(t('rv.commentPh'))}">${esc(body)}</textarea>
      <div class="row rv-end"><button type="button" class="btn btn-sm" data-cact="cancel">${esc(t('rv.cancel'))}</button>
      <button type="button" class="btn btn-sm btn-primary" data-cact="save">${esc(t('rv.save'))}</button></div></div>`;
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(MAW.lang === 'en' ? 'en-GB' : 'vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  }

  // Re-renders one file section in place (keeps the scroll position of everything else).
  function rerenderFile(path) {
    const f = V.data.files.find(x => x.path === path);
    const old = V.el.querySelector(`.rv-file[data-path="${CSS.escape(path)}"]`);
    if (!f || !old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = fileHtml(f);
    old.replaceWith(tmp.firstElementChild);
    renderFileList();
    renderFoot();
  }

  const body = extra => ({ project_path: V.p.project_path, source: V.p.source, ref: V.p.ref, base: V.p.base, ...extra });
  // The diff may have been opened with a job / commit fallback; the server answers with the effective params.
  function syncParams() {
    const d = V.data;
    if (d) V.p = { ...V.p, project_path: d.project_path || V.p.project_path, source: d.source || V.p.source, ref: d.ref ?? V.p.ref, base: d.base ?? V.p.base };
  }

  async function hunkAction(path, hunkId, action) {
    const f = V.data.files.find(x => x.path === path);
    const h = hunkId ? f?.hunks.find(x => x.id === hunkId) : null;
    if (action === 'reject') {
      const ok = await confirmDanger(t('rv.confirmTitle'),
        hunkId ? t('rv.confirmHunk', { hunk: h?.header || hunkId, file: path }) : t('rv.confirmFile', { file: path }), t('rv.doReject'));
      if (!ok || !V) return;
    }
    syncParams();
    try {
      // Same diff options as the view, so the server finds the same hunk ids.
      // file_id lets the server refuse a whole-file action on a file that changed since it was shown.
      const r = await api('review_hunk', body({ path, hunk_id: hunkId || null, file_id: hunkId ? undefined : f?.id,
        action, confirm: action === 'reject' ? true : undefined, context: V.ctx, ignore_ws: V.ws }));
      const st = session().states[path] ||= { file: null, hunks: {} };
      st.hunks ||= {};
      const mark = action === 'accept' ? 'accepted' : 'rejected';
      if (hunkId) { if (action === 'reset') delete st.hunks[hunkId]; else st.hunks[hunkId] = mark; }
      else st.file = action === 'reset' ? null : mark;
      if (action === 'reject') {
        toast(t('rv.rejectedToast', { ref: r.snapshot_ref || '—' }), 'ok');
        await load(true); // the working tree changed: line numbers of the other hunks moved
      } else rerenderFile(path);
    } catch (e) {
      if (e.status === 409 && /changed|reload/i.test(e.message)) { toast(t('rv.stale'), 'warn'); await load(true); }
      else toast(e.message + (e.data?.detail ? ' — ' + e.data.detail : ''), 'err');
    }
  }

  async function commentOp(op, extra) {
    syncParams();
    try {
      const r = await api('review_comment', body({ op, ...extra }));
      session().comments = r.comments || [];
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  function findLine(path, side, line) {
    const f = V.data.files.find(x => x.path === path);
    for (const h of f?.hunks || []) {
      for (const l of walk({ ...h, id: '__all' })) if (!l.fold && (side === 'old' ? l.o === line && l.type !== '+' : l.n === line && l.type !== '-')) return l.text;
    }
    return '';
  }

  async function onClick(e) {
    const tgt = e.target;
    const act = tgt.closest('[data-act]')?.dataset.act;
    const fileEl = tgt.closest('.rv-file');
    const path = fileEl?.dataset.path;
    const hunkId = tgt.closest('[data-hunk]')?.dataset.hunk;

    const viewBtn = tgt.closest('[data-view]');
    if (viewBtn) { V.view = viewBtn.dataset.view; store.set('maw_rv_view', V.view); syncTools(); renderFiles(); return; }
    const goto = tgt.closest('[data-goto]');
    if (goto) {
      const p = goto.dataset.goto;
      if (V.collapsed.has(p)) { V.collapsed.delete(p); rerenderFile(p); }
      V.el.querySelector(`.rv-file[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'start' });
      V.el.classList.remove('show-files');
      return;
    }
    const unfold = tgt.closest('[data-unfold]');
    if (unfold) { V.unfold.add(unfold.dataset.unfold); rerenderFile(path); return; }
    const ln = tgt.closest('.rv-ln[data-line]');
    if (ln && path) {
      V.draft = { path, side: ln.dataset.side, line: Number(ln.dataset.line) };
      V.editing = null;
      rerenderFile(path);
      V.el.querySelector(`.rv-file[data-path="${CSS.escape(path)}"] [data-edit=""] textarea`)?.focus();
      return;
    }
    const cact = tgt.closest('[data-cact]')?.dataset.cact;
    if (cact && path) {
      const cid = tgt.closest('[data-cid]')?.dataset.cid || tgt.closest('[data-edit]')?.dataset.edit || '';
      const c = session().comments.find(x => x.id === cid);
      if (cact === 'cancel') { V.draft = null; V.editing = null; rerenderFile(path); }
      else if (cact === 'edit') { V.editing = cid; V.draft = null; rerenderFile(path); V.el.querySelector(`[data-edit="${CSS.escape(cid)}"] textarea`)?.focus(); }
      else if (cact === 'delete') { if (await commentOp('delete', { id: cid, path })) rerenderFile(path); }
      else if (cact === 'resolve' && c) { if (await commentOp('resolve', { id: cid, path, resolved: !c.resolved })) rerenderFile(path); }
      else if (cact === 'save') await saveComment(tgt.closest('[data-edit]'), path);
      return;
    }
    if (!act) return;
    if (act === 'close') closeViewer();
    else if (act === 'reload') load(true);
    else if (act === 'toggle-files') V.el.classList.toggle('show-files');
    else if (act === 'collapse') { V.collapsed.has(path) ? V.collapsed.delete(path) : V.collapsed.add(path); rerenderFile(path); }
    else if (act === 'accept-file') hunkAction(path, null, 'accept');
    else if (act === 'reject-file') hunkAction(path, null, 'reject');
    else if (act === 'reset-file') hunkAction(path, null, 'reset');
    else if (act === 'accept-hunk') hunkAction(path, hunkId, 'accept');
    else if (act === 'reject-hunk') hunkAction(path, hunkId, 'reject');
    else if (act === 'reset-hunk') hunkAction(path, hunkId, 'reset');
    else if (act === 'load-file') loadFullFile(path);
    else if (act === 'send-fix') openSendFix();
    else if (act === 'verdict') saveVerdict();
  }

  async function saveComment(editEl, path) {
    const text = editEl.querySelector('textarea').value.trim();
    if (!text) return;
    const id = editEl.dataset.edit;
    let ok;
    if (id) {
      const c = session().comments.find(x => x.id === id);
      ok = await commentOp('edit', { id, path, line: c.line, side: c.side, quote: c.quote, body: text });
    } else {
      const d = V.draft;
      ok = await commentOp('add', { path, line: d.line, side: d.side, quote: findLine(path, d.side, d.line).slice(0, 500), body: text });
    }
    if (ok) { V.draft = null; V.editing = null; rerenderFile(path); }
  }

  async function loadFullFile(path) {
    try {
      syncParams();
      const d = await api('review_diff' + qs({ ...V.p, path, full: 1, context: V.ctx, ignore_ws: V.ws ? 1 : '' }));
      const f = d.files.find(x => x.path === path);
      if (f) { const i = V.data.files.findIndex(x => x.path === path); V.data.files[i] = f; rerenderFile(path); }
    } catch (e) { toast(e.message, 'err'); }
  }

  function onChange(e) {
    const opt = e.target.dataset?.opt;
    if (opt === 'ws') { V.ws = e.target.checked; load(true); }
    else if (opt === 'ctx') { V.ctx = Number(e.target.value) || 3; load(true); }
  }

  function onKey(e) {
    if (!V || document.querySelector('.rv-modal-back, .st-back')) return;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (V.draft || V.editing) { const p = V.draft?.path || session().comments.find(c => c.id === V.editing)?.path; V.draft = null; V.editing = null; if (p) rerenderFile(p); }
      else closeViewer();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('.rv-cmt-edit textarea')) {
      e.preventDefault();
      saveComment(e.target.closest('[data-edit]'), e.target.closest('.rv-file').dataset.path);
    }
  }

  async function saveVerdict() {
    const verdict = V.el.querySelector('[data-v="verdict"]').value;
    const score = Math.max(0, Math.min(10, Math.round(Number(V.el.querySelector('[data-v="score"]').value) * 10) / 10));
    syncParams();
    try {
      const r = await api('review_verdict', body({ verdict, score }));
      session().verdict = r.verdict || { verdict, score };
      toast(t('rv.verdictSaved'), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function agentOptions(selected) {
    const ag = MAW.agents() || {};
    return Object.entries(ag).filter(([, a]) => a.enabled !== false && a.capabilities?.write !== false)
      .map(([id, a]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(a.label || id)}${a.installed === false ? ' ✕' : ''}</option>`).join('');
  }

  async function openSendFix() {
    if (!unsent().length && !Object.values(session().states || {}).some(s => s.file === 'rejected' || Object.values(s.hunks || {}).includes('rejected'))) {
      toast(t('rv.noComments'), 'warn');
      return;
    }
    syncParams();
    const tasks = (MAW.state.data?.features || []).includes('tasks');
    const isJob = V.p.source === 'job';
    const { box, close } = modal(`<div class="card-h"><h2>${esc(t('rv.fixTitle'))}</h2></div>
      <div class="card-b stack">
        <div class="rv-grid2">
          <label><span class="lbl">${esc(t('rv.agent'))}</span><select data-f="agent">${isJob ? `<option value="">— job —</option>` : ''}${agentOptions(isJob ? '' : 'antigravity')}</select></label>
          <label><span class="lbl">${esc(t('rv.role'))}</span><select data-f="role">${isJob ? `<option value="">— job —</option>` : ''}${ROLES.map(r => `<option>${r}</option>`).join('')}</select></label>
        </div>
        <label><span class="lbl">${esc(t('rv.note'))}</span><input class="input" data-f="note" maxlength="2000"></label>
        <pre class="rv-prompt mono">…</pre>
        <div class="row rv-end">
          <button type="button" class="btn" data-a="preview">${esc(t('rv.preview'))}</button>
          ${tasks ? `<button type="button" class="btn" data-a="card">${esc(t('rv.makeCard'))}</button>` : ''}
          <button type="button" class="btn btn-primary" data-a="run">${esc(t('rv.startFix'))}</button>
        </div>
      </div>`, { wide: true });
    const val = k => box.querySelector(`[data-f="${k}"]`).value;
    const req = extra => body({ agent: val('agent') || undefined, role: val('role') || undefined, note: val('note') || undefined, ...extra });
    const preview = async () => {
      try { const r = await api('review_send_fix', req({ dry_run: true })); box.querySelector('.rv-prompt').textContent = r.prompt; return r.prompt; }
      catch (e) { box.querySelector('.rv-prompt').textContent = e.message; return null; }
    };
    preview();
    box.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      e.target.disabled = true;
      try {
        if (a === 'preview') await preview();
        else if (a === 'run') {
          const r = await api('review_send_fix', req({}));
          toast(t('rv.fixStarted', { id: r.job_id }) + (r.remaining ? ' · ' + t('rv.fixRemaining', { n: r.remaining }) : ''), r.remaining ? 'warn' : 'ok');
          close();
          load(true); // the server marks only the comments that fitted in the prompt as sent
          if (typeof MAW.watchJob === 'function') MAW.watchJob(r.job_id);
        } else if (a === 'card') {
          const prompt = await preview();
          if (!prompt) return;
          await api('task_create', { project_path: V.p.project_path, title: `Review fixes: ${V.p.source} ${V.p.ref}`.trim(), prompt,
            agent: val('agent') || undefined, role: val('role') || 'backend' });
          toast(t('rv.cardMade'), 'ok');
          close();
        }
      } catch (err) { toast(err.message, 'err'); }
      finally { e.target.disabled = false; }
    });
  }

  // ---------- "Review" tab: source picker ----------
  const tabState = { source: store.get('maw_rv_src') || 'worktree', sources: null, project: '', loading: false };

  function renderTab(panel) {
    const proj = MAW.project();
    if (!proj) { panel.innerHTML = `<div class="empty">${esc(t('rv.pickProject'))}</div>`; return; }
    if (tabState.project !== proj.path) { tabState.project = proj.path; tabState.sources = null; }
    if (!panel.querySelector('.rv-picker')) {
      panel.innerHTML = `<div class="rv-picker stack">
        <div class="row rv-wrap"><div class="seg" role="group">${['worktree', 'branch', 'job', 'commit'].map(s => `<button type="button" data-src="${s}"></button>`).join('')}</div>
          <button type="button" class="btn btn-primary btn-sm" data-act="open"></button></div>
        <div class="rv-pick-body"></div>
        <div class="rv-recent"></div></div>`;
      panel.addEventListener('click', e => {
        const s = e.target.closest('[data-src]');
        if (s) { tabState.source = s.dataset.src; store.set('maw_rv_src', tabState.source); paintPicker(panel); return; }
        if (e.target.closest('[data-act="open"]')) openFromPicker(panel);
        const v = e.target.closest('[data-open-job]');
        if (v) open({ project_path: MAW.project()?.path, source: 'job', ref: v.dataset.openJob });
      });
    }
    paintPicker(panel);
    if (!tabState.sources && !tabState.loading) loadSources(panel);
  }

  async function loadSources(panel) {
    tabState.loading = true;
    const path = tabState.project;
    try {
      const r = await api('review_sources' + qs({ project_path: path }));
      if (tabState.project === path) tabState.sources = r;
    } catch (e) {
      if (tabState.project === path) tabState.sources = { error: e.message };
    } finally {
      tabState.loading = false;
      paintPicker(panel);
    }
  }

  function paintPicker(panel) {
    panel.querySelectorAll('[data-src]').forEach(b => {
      b.textContent = t('rv.src.' + b.dataset.src);
      b.setAttribute('aria-pressed', String(b.dataset.src === tabState.source));
    });
    panel.querySelector('[data-act="open"]').textContent = t('rv.open');
    const box = panel.querySelector('.rv-pick-body');
    const s = tabState.sources;
    const prevSel = box.querySelector('select[data-pick]')?.value;
    if (!s) { box.innerHTML = '<div class="sub">…</div>'; }
    else if (s.error) { box.innerHTML = `<div class="sub t-err">${esc(s.error)}</div>`; }
    else if (s.is_git === false) { box.innerHTML = `<div class="sub">${esc(t('rv.notGit'))}</div>`; }
    else {
      const src = tabState.source;
      let opts = '';
      if (src === 'branch') opts = (s.branches || []).map(b => `<option value="${esc(b.name)}">${esc(b.name)}${b.current ? ' •' : ''}${b.worktree_path ? ' (worktree)' : ''}</option>`).join('');
      if (src === 'job') opts = (s.jobs || []).map(j => `<option value="${esc(j.job_id)}">${esc(j.job_id)} · ${esc(j.agent)} · ${esc(j.role)} · ${esc(j.status)}${j.has_checkpoint ? '' : ' (no checkpoint)'}</option>`).join('');
      if (src === 'commit') opts = (s.commits || []).map(c => `<option value="${esc(c.sha)}">${esc(c.short)} · ${esc(c.subject)} — ${esc(c.author)}</option>`).join('');
      box.innerHTML = src === 'worktree' ? `<div class="sub">${esc(s.current_branch || '')}</div>` : `
        <div class="rv-grid2">
          <select data-pick aria-label="${esc(t('rv.src.' + src))}">${opts || `<option value="">${esc(t('rv.none'))}</option>`}</select>
          ${src === 'branch' ? `<input class="input" data-base placeholder="${esc(t('rv.base'))}: ${esc(s.default_base || 'main')}" aria-label="${esc(t('rv.base'))}">` : ''}
        </div>`;
      const sel = box.querySelector('select[data-pick]');
      if (sel && prevSel && [...sel.options].some(o => o.value === prevSel)) sel.value = prevSel;
    }
    const fd = MAW.state.data?.feature_data?.review;
    const recent = panel.querySelector('.rv-recent');
    const vs = Object.entries(fd?.verdicts_by_job || {}).slice(0, 8);
    recent.innerHTML = (vs.length || fd?.open_comments) ? `<div class="section-title">${esc(t('rv.recent'))}${fd?.open_comments ? ` · ${esc(t('rv.openComments', { n: fd.open_comments }))}` : ''}</div>
      ${vs.map(([id, v]) => `<button type="button" class="rv-recent-row" data-open-job="${esc(id)}"><span class="mono truncate">${esc(id)}</span>
        <span class="badge ${v.verdict === 'APPROVED' ? 'b-ok' : 'b-err'}">${esc(v.verdict)}</span><span class="sub">${esc(v.score)}/10</span></button>`).join('')}` : '';
  }

  function openFromPicker(panel) {
    const src = tabState.source;
    const ref = panel.querySelector('select[data-pick]')?.value || '';
    if (src !== 'worktree' && !ref) { toast(t('rv.none'), 'warn'); return; }
    open({ project_path: MAW.project()?.path, source: src, ref, base: panel.querySelector('[data-base]')?.value.trim() || '' });
  }

  const tab = MAW.addTab({ id: 'review', title: () => t('rv.tab'), render: renderTab });
  MAW.on('project-change', () => { tabState.sources = null; if (tab?.panel && !tab.panel.classList.contains('hidden')) renderTab(tab.panel); });
  MAW.on('data', d => {
    const n = (d || MAW.state.data)?.feature_data?.review?.open_comments;
    tab?.setCount?.(n || '');
  });

  MAW.addJobAction({
    id: 'review-diff',
    label: () => t('rv.jobAction'),
    when: j => j && j.status !== 'RUNNING',
    run: j => open({ source: 'job', ref: j.id }),
  });

  MAW.ext.review = { open, highlight, langOf, close: closeViewer };
})();
