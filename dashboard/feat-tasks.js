// S2 board (specs/s2-design.md §7): kanban with dependencies + limits, retry / reassign / resume,
// templates + team presets, Auto Run playbooks, schedules. Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M || window.MAW_BOARD) return;
  const { t, esc, toast } = M;

  const STATUSES = ['backlog', 'queued', 'running', 'needs_input', 'review', 'done', 'failed'];
  const MODES = ['task', 'team', 'council', 'auto-gate', 'chat'];
  const ROLES = ['backend', 'frontend', 'architect', 'reviewer', 'tester'];
  const TEAM_SLOTS = ['backend', 'frontend', 'reviewer'];
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const TABS = ['board', 'library', 'autorun', 'schedules', 'limits'];
  const VAR_RE = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
  const POLL_MS = 3000;

  M.addI18n('vi', {
    'tk.view': 'Bảng việc', 'tk.tab.board': 'Bảng', 'tk.tab.library': 'Mẫu & đội hình', 'tk.tab.autorun': 'Auto Run',
    'tk.tab.schedules': 'Lịch chạy', 'tk.tab.limits': 'Giới hạn',
    'tk.st.backlog': 'Tồn đọng', 'tk.st.queued': 'Chờ chạy', 'tk.st.running': 'Đang chạy', 'tk.st.needs_input': 'Cần phản hồi',
    'tk.st.review': 'Chờ duyệt', 'tk.st.done': 'Hoàn thành', 'tk.st.failed': 'Thất bại',
    'tk.new': 'Thẻ mới', 'tk.allProjects': 'Mọi dự án', 'tk.curProject': 'Dự án đang chọn', 'tk.allAgents': 'Mọi agent',
    'tk.search': 'Tìm thẻ…', 'tk.empty': 'Chưa có thẻ', 'tk.dropHere': 'Thả vào đây',
    'tk.sched.active': 'Bộ lập lịch: chạy', 'tk.sched.passive': 'Bộ lập lịch: máy chủ khác giữ', 'tk.sched.paused': 'Bộ lập lịch: tạm dừng',
    'tk.sched.off': 'Bộ lập lịch: chưa chạy', 'tk.running': '{n}/{max} đang chạy',
    'tk.waits': 'chờ {n}', 'tk.blocks': 'chặn {n}', 'tk.attempts': '{n} lượt', 'tk.prio': 'Ưu tiên',
    'tk.f.title': 'Tiêu đề', 'tk.f.prompt': 'Yêu cầu (prompt)', 'tk.f.project': 'Dự án', 'tk.f.mode': 'Chế độ', 'tk.f.agent': 'Agent',
    'tk.f.leader': 'Leader', 'tk.f.implementer': 'Agent viết code', 'tk.f.role': 'Vai trò', 'tk.f.reviewers': 'Reviewer',
    'tk.f.team': 'Đội', 'tk.f.preset': 'Đội hình mẫu', 'tk.f.none': '— không —', 'tk.f.deps': 'Phụ thuộc (phải xong trước)',
    'tk.f.labels': 'Nhãn (phân cách bằng dấu phẩy)', 'tk.f.requireReview': 'Cần duyệt trước khi xong', 'tk.f.isolate': 'Chạy trong worktree riêng',
    'tk.f.autoRetry': 'Tự thử lại khi lỗi', 'tk.f.maxAttempts': 'Tối đa lượt', 'tk.f.backoff': 'Chờ ban đầu (giây)',
    'tk.f.template': 'Mẫu prompt', 'tk.f.vars': 'Biến của mẫu', 'tk.f.model': 'Model', 'tk.f.effort': 'Effort', 'tk.f.default': 'mặc định',
    'tk.f.noDeps': 'Không có thẻ nào khác trong dự án này.',
    'tk.save': 'Lưu', 'tk.saveBacklog': 'Thêm vào tồn đọng', 'tk.saveQueue': 'Thêm và xếp hàng chạy', 'tk.cancel': 'Huỷ', 'tk.close': 'Đóng',
    'tk.start': 'Chạy ngay', 'tk.queue': 'Xếp hàng', 'tk.stop': 'Dừng job', 'tk.retry': 'Thử lại', 'tk.retryOn': 'Thử lại với…', 'tk.resume': 'Tiếp tục phiên',
    'tk.approve': 'Duyệt', 'tk.reject': 'Từ chối', 'tk.delete': 'Xoá', 'tk.moveTo': 'Chuyển sang…', 'tk.edit': 'Sửa',
    'tk.attemptsTitle': 'Các lượt chạy', 'tk.noAttempts': 'Chưa chạy lần nào.', 'tk.findings': 'Nhận xét / lỗi', 'tk.logTail': 'Cuối log',
    'tk.retryTitle': 'Chạy lại thẻ', 'tk.includeFindings': 'Kèm nhận xét của lượt trước', 'tk.note': 'Ghi chú thêm cho agent',
    'tk.resumeHint': 'Tiếp tục trong phiên gần nhất (chỉ agent có phiên, ví dụ Antigravity).',
    'tk.confirmDelete': 'Xoá thẻ "{x}"? Không thể hoàn tác.', 'tk.confirmCancel': 'Dừng job đang chạy của thẻ "{x}"?',
    'tk.confirmReject': 'Từ chối thẻ "{x}"? Thẻ chuyển sang Thất bại để thử lại.',
    'tk.saved': 'Đã lưu', 'tk.created': 'Đã tạo thẻ', 'tk.deleted': 'Đã xoá', 'tk.started': 'Đã chạy thẻ', 'tk.queuedMsg': 'Đã xếp hàng',
    'tk.needTitle': 'Cần tiêu đề và prompt.', 'tk.needProject': 'Chọn dự án.', 'tk.missingVar': 'Thiếu giá trị cho biến {x}.',
    'tk.running.cannotEdit': 'Thẻ đang chạy — chỉ sửa được tiêu đề, nhãn, ưu tiên.', 'tk.src.github': 'GitHub', 'tk.src.playbook': 'Playbook',
    'tk.src.schedule': 'Lịch', 'tk.src.lead': 'Lead', 'tk.openLog': 'Mở log', 'tk.toCard': 'Thêm vào bảng việc',
    'tk.tpl.title': 'Mẫu prompt', 'tk.tpl.new': 'Mẫu mới', 'tk.tpl.use': 'Dùng', 'tk.tpl.copy': 'Nhân bản', 'tk.builtin': 'có sẵn',
    'tk.tpl.name': 'Tên', 'tk.tpl.desc': 'Mô tả', 'tk.tpl.cardTitle': 'Tiêu đề thẻ', 'tk.tpl.varsHint': 'Dùng {{tên_biến}} trong tiêu đề và prompt. {{project}} và {{date}} tự điền.',
    'tk.ps.title': 'Đội hình mẫu', 'tk.ps.new': 'Đội hình mới', 'tk.ps.rounds': 'Số vòng sửa tối đa', 'tk.ps.budget': 'Ngân sách (USD, 0 = không)',
    'tk.ps.implementer': 'Agent viết code (Auto-Gate)', 'tk.export': 'Xuất JSON', 'tk.import': 'Nhập JSON', 'tk.overwrite': 'Ghi đè mục trùng id',
    'tk.imported': 'Đã nhập {a} mẫu, {b} đội hình', 'tk.skipped': 'Bỏ qua: {x}', 'tk.confirmDeleteItem': 'Xoá "{x}"?',
    'tk.ar.files': 'Playbook trong .maw/playbooks', 'tk.ar.other': 'File khác trong dự án', 'tk.ar.preview': 'Xem', 'tk.ar.noFiles': 'Chưa có playbook. Tạo file markdown có danh sách "- [ ] việc" trong {dir}.',
    'tk.ar.items': '{done}/{total} xong', 'tk.ar.run': 'Chạy playbook', 'tk.ar.onFail': 'Khi một việc lỗi', 'tk.ar.stop': 'Dừng lại', 'tk.ar.continue': 'Làm tiếp',
    'tk.ar.prefix': 'Thêm vào đầu mỗi prompt (tuỳ chọn)', 'tk.ar.runs': 'Các lần chạy', 'tk.ar.noRuns': 'Chưa chạy playbook nào.', 'tk.ar.stopRun': 'Dừng',
    'tk.ar.confirmStop': 'Dừng lần chạy playbook này? Các thẻ chưa chạy vẫn nằm ở Tồn đọng.', 'tk.ar.started': 'Đã tạo {n} thẻ từ playbook',
    'tk.ar.busy': 'Playbook này đang chạy.', 'tk.ar.pickProject': 'Chọn một dự án ở thanh trên để xem playbook.', 'tk.ar.fresh': 'Mỗi việc chạy trong một phiên mới, lần lượt từng việc; xong việc nào thì ô [x] trong file được đánh dấu.',
    'tk.sc.new': 'Lịch mới', 'tk.sc.when': 'Khi nào', 'tk.sc.daily': 'Hằng ngày', 'tk.sc.weekly': 'Hằng tuần', 'tk.sc.every': 'Mỗi N phút',
    'tk.sc.time': 'Giờ', 'tk.sc.day': 'Thứ', 'tk.sc.minutes': 'Số phút', 'tk.sc.action': 'Việc cần làm', 'tk.sc.card': 'Tạo thẻ', 'tk.sc.playbook': 'Chạy playbook',
    'tk.sc.file': 'File playbook', 'tk.sc.skip': 'Bỏ qua nếu lần trước còn đang chạy', 'tk.sc.enabled': 'Bật', 'tk.sc.next': 'Lần tới', 'tk.sc.last': 'Lần trước',
    'tk.sc.runNow': 'Chạy ngay', 'tk.sc.empty': 'Chưa có lịch. Lịch chỉ chạy khi máy chủ đang chạy; lần bị lỡ sẽ được chạy bù một lần khi khởi động.',
    'tk.sc.qNightly': 'Council review đêm', 'tk.sc.qSecurity': 'Kiểm tra bảo mật hằng tuần',
    'tk.sc.nightlyPrompt': 'Review toàn bộ thay đổi chưa commit trong dự án. Liệt kê lỗi, rủi ro bảo mật và chỗ lệch SPEC.md.',
    'tk.sc.securityPrompt': 'Kiểm tra bảo mật và phụ thuộc của dự án: lỗ hổng đã biết, secret lộ, quyền truy cập, input chưa kiểm tra. Đề xuất cách sửa theo mức độ.',
    'tk.lim.title': 'Giới hạn chạy song song', 'tk.lim.global': 'Tối đa thẻ chạy cùng lúc', 'tk.lim.perAgent': 'Theo agent (trống = không giới hạn, 0 = không chạy)',
    'tk.lim.paused': 'Tạm dừng bộ lập lịch (không bắt đầu thẻ mới)', 'tk.lim.info': 'Chỉ áp dụng cho thẻ do bảng việc khởi chạy; nút Run thủ công không bị giới hạn.',
    'tk.lim.owner': 'PID {pid} · nhịp cuối {x}', 'tk.err': 'Lỗi: {x}', 'tk.loading': 'Đang tải…', 'tk.never': 'chưa', 'tk.rel.now': 'vừa xong',
    'tk.rel.past': '{x} trước', 'tk.rel.future': 'sau {x}', 'tk.prio.n': 'Bình thường', 'tk.prio.h': 'Cao', 'tk.prio.u': 'Gấp', 'tk.prio.l': 'Thấp',
    'tk.unsupported': 'Máy chủ chưa có tính năng bảng việc (S2).'
  });
  M.addI18n('en', {
    'tk.view': 'Board', 'tk.tab.board': 'Board', 'tk.tab.library': 'Templates & presets', 'tk.tab.autorun': 'Auto Run',
    'tk.tab.schedules': 'Schedules', 'tk.tab.limits': 'Limits',
    'tk.st.backlog': 'Backlog', 'tk.st.queued': 'Queued', 'tk.st.running': 'Running', 'tk.st.needs_input': 'Needs input',
    'tk.st.review': 'Review', 'tk.st.done': 'Done', 'tk.st.failed': 'Failed',
    'tk.new': 'New card', 'tk.allProjects': 'All projects', 'tk.curProject': 'Selected project', 'tk.allAgents': 'All agents',
    'tk.search': 'Search cards…', 'tk.empty': 'No cards', 'tk.dropHere': 'Drop here',
    'tk.sched.active': 'Scheduler: running', 'tk.sched.passive': 'Scheduler: held by another server', 'tk.sched.paused': 'Scheduler: paused',
    'tk.sched.off': 'Scheduler: not started', 'tk.running': '{n}/{max} running',
    'tk.waits': 'waits on {n}', 'tk.blocks': 'blocks {n}', 'tk.attempts': '{n} attempts', 'tk.prio': 'Priority',
    'tk.f.title': 'Title', 'tk.f.prompt': 'Prompt', 'tk.f.project': 'Project', 'tk.f.mode': 'Mode', 'tk.f.agent': 'Agent',
    'tk.f.leader': 'Leader', 'tk.f.implementer': 'Implementer', 'tk.f.role': 'Role', 'tk.f.reviewers': 'Reviewers',
    'tk.f.team': 'Team', 'tk.f.preset': 'Team preset', 'tk.f.none': '— none —', 'tk.f.deps': 'Depends on (must be done first)',
    'tk.f.labels': 'Labels (comma separated)', 'tk.f.requireReview': 'Needs review before done', 'tk.f.isolate': 'Run in its own worktree',
    'tk.f.autoRetry': 'Retry automatically on failure', 'tk.f.maxAttempts': 'Max attempts', 'tk.f.backoff': 'First delay (seconds)',
    'tk.f.template': 'Prompt template', 'tk.f.vars': 'Template variables', 'tk.f.model': 'Model', 'tk.f.effort': 'Effort', 'tk.f.default': 'default',
    'tk.f.noDeps': 'No other cards in this project.',
    'tk.save': 'Save', 'tk.saveBacklog': 'Add to backlog', 'tk.saveQueue': 'Add and queue', 'tk.cancel': 'Cancel', 'tk.close': 'Close',
    'tk.start': 'Start now', 'tk.queue': 'Queue', 'tk.stop': 'Stop job', 'tk.retry': 'Retry', 'tk.retryOn': 'Retry on…', 'tk.resume': 'Resume session',
    'tk.approve': 'Approve', 'tk.reject': 'Reject', 'tk.delete': 'Delete', 'tk.moveTo': 'Move to…', 'tk.edit': 'Edit',
    'tk.attemptsTitle': 'Attempts', 'tk.noAttempts': 'Not run yet.', 'tk.findings': 'Findings', 'tk.logTail': 'Log tail',
    'tk.retryTitle': 'Run the card again', 'tk.includeFindings': 'Include the previous attempt\'s findings', 'tk.note': 'Extra note for the agent',
    'tk.resumeHint': 'Continue in the latest session (only agents with sessions, e.g. Antigravity).',
    'tk.confirmDelete': 'Delete card "{x}"? This cannot be undone.', 'tk.confirmCancel': 'Stop the running job of card "{x}"?',
    'tk.confirmReject': 'Reject card "{x}"? It moves to Failed so it can be retried.',
    'tk.saved': 'Saved', 'tk.created': 'Card created', 'tk.deleted': 'Deleted', 'tk.started': 'Card started', 'tk.queuedMsg': 'Queued',
    'tk.needTitle': 'Title and prompt are required.', 'tk.needProject': 'Pick a project.', 'tk.missingVar': 'Missing a value for {x}.',
    'tk.running.cannotEdit': 'The card is running — only title, labels and priority can change.', 'tk.src.github': 'GitHub', 'tk.src.playbook': 'Playbook',
    'tk.src.schedule': 'Schedule', 'tk.src.lead': 'Lead', 'tk.openLog': 'Open log', 'tk.toCard': 'Add to board',
    'tk.tpl.title': 'Prompt templates', 'tk.tpl.new': 'New template', 'tk.tpl.use': 'Use', 'tk.tpl.copy': 'Duplicate', 'tk.builtin': 'built-in',
    'tk.tpl.name': 'Name', 'tk.tpl.desc': 'Description', 'tk.tpl.cardTitle': 'Card title', 'tk.tpl.varsHint': 'Use {{variable}} in the title and prompt. {{project}} and {{date}} are filled in for you.',
    'tk.ps.title': 'Team presets', 'tk.ps.new': 'New preset', 'tk.ps.rounds': 'Max fix rounds', 'tk.ps.budget': 'Budget (USD, 0 = none)',
    'tk.ps.implementer': 'Implementer (Auto-Gate)', 'tk.export': 'Export JSON', 'tk.import': 'Import JSON', 'tk.overwrite': 'Overwrite items with the same id',
    'tk.imported': 'Imported {a} templates, {b} presets', 'tk.skipped': 'Skipped: {x}', 'tk.confirmDeleteItem': 'Delete "{x}"?',
    'tk.ar.files': 'Playbooks in .maw/playbooks', 'tk.ar.other': 'Another file in the project', 'tk.ar.preview': 'Preview', 'tk.ar.noFiles': 'No playbooks yet. Create a markdown file with "- [ ] task" lines in {dir}.',
    'tk.ar.items': '{done}/{total} done', 'tk.ar.run': 'Run playbook', 'tk.ar.onFail': 'When an item fails', 'tk.ar.stop': 'Stop', 'tk.ar.continue': 'Continue',
    'tk.ar.prefix': 'Prepend to every prompt (optional)', 'tk.ar.runs': 'Runs', 'tk.ar.noRuns': 'No playbook runs yet.', 'tk.ar.stopRun': 'Stop',
    'tk.ar.confirmStop': 'Stop this playbook run? Cards that have not run stay in Backlog.', 'tk.ar.started': 'Created {n} cards from the playbook',
    'tk.ar.busy': 'This playbook is already running.', 'tk.ar.pickProject': 'Pick a project in the top bar to see its playbooks.', 'tk.ar.fresh': 'Items run one at a time, in order, each in a fresh session; the box in the file is ticked when its card is done.',
    'tk.sc.new': 'New schedule', 'tk.sc.when': 'When', 'tk.sc.daily': 'Daily', 'tk.sc.weekly': 'Weekly', 'tk.sc.every': 'Every N minutes',
    'tk.sc.time': 'Time', 'tk.sc.day': 'Day', 'tk.sc.minutes': 'Minutes', 'tk.sc.action': 'Action', 'tk.sc.card': 'Create a card', 'tk.sc.playbook': 'Run a playbook',
    'tk.sc.file': 'Playbook file', 'tk.sc.skip': 'Skip while the previous run is still going', 'tk.sc.enabled': 'Enabled', 'tk.sc.next': 'Next run', 'tk.sc.last': 'Last run',
    'tk.sc.runNow': 'Run now', 'tk.sc.empty': 'No schedules. Schedules run only while the server runs; a run missed during downtime is caught up once at start.',
    'tk.sc.qNightly': 'Nightly council review', 'tk.sc.qSecurity': 'Weekly security audit',
    'tk.sc.nightlyPrompt': 'Review all uncommitted changes in the project. List bugs, security risks and anything that contradicts SPEC.md.',
    'tk.sc.securityPrompt': 'Audit the project\'s security and dependencies: known vulnerabilities, leaked secrets, access control, unchecked input. Propose fixes by severity.',
    'tk.lim.title': 'Concurrency limits', 'tk.lim.global': 'Max cards running at once', 'tk.lim.perAgent': 'Per agent (empty = no limit, 0 = never start)',
    'tk.lim.paused': 'Pause the scheduler (start no new cards)', 'tk.lim.info': 'Applies only to cards the board starts; the manual Run button is never limited.',
    'tk.lim.owner': 'PID {pid} · last tick {x}', 'tk.err': 'Error: {x}', 'tk.loading': 'Loading…', 'tk.never': 'never', 'tk.rel.now': 'just now',
    'tk.rel.past': '{x} ago', 'tk.rel.future': 'in {x}', 'tk.prio.n': 'Normal', 'tk.prio.h': 'High', 'tk.prio.u': 'Urgent', 'tk.prio.l': 'Low',
    'tk.unsupported': 'This server has no board feature (S2) yet.'
  });

  // ---------- state ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
  };
  const S = {
    tasks: [], config: { max_parallel: 3, per_agent: {}, paused: false }, scheduler: null, counts: {},
    templates: null, presets: null, sig: '', loaded: false, error: '',
    tab: TABS.includes(store.get('tk_tab')) ? store.get('tk_tab') : 'board',
    scope: store.get('tk_scope') === 'all' ? 'all' : 'cur', agent: '', q: '',
    dragging: null, hover: null, visible: false, timer: null, inFlight: false,
    cardActions: [], toolbar: [], playbook: { file: '', items: null }, runs: [], files: null, schedules: null
  };

  // ---------- helpers ----------
  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
  const get = (action, params = {}) => M.api(action + qs(params));
  const post = (action, body) => M.api(action, body || {});
  const agents = () => M.agents();
  const agentIds = () => Object.keys(agents());
  const agentLabel = id => agents()[id]?.label || id || '—';
  const agentColor = id => agents()[id]?.color || 'var(--faint)';
  const cap = (id, k) => !!agents()[id]?.capabilities?.[k];
  const projects = () => M.state.data?.projects || [];
  const projName = p => projects().find(x => x.path === p)?.name || String(p || '').split(/[\\/]/).pop() || '—';
  const curProject = () => M.project();
  const taskById = id => S.tasks.find(x => x.id === id);
  const stLabel = s => t('tk.st.' + s);
  const errMsg = e => e?.message || String(e);
  const fail = e => toast(t('tk.err', { x: errMsg(e) }), 'err');
  const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ''), '');
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const prioLabel = p => p >= 3 ? t('tk.prio.u') : p >= 1 ? t('tk.prio.h') : p < 0 ? t('tk.prio.l') : t('tk.prio.n');

  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h' + String(Math.floor(sec % 3600 / 60)).padStart(2, '0') + 'm';
    return Math.floor(sec / 86400) + 'd' + Math.floor(sec % 86400 / 3600) + 'h';
  }
  function rel(iso) {
    if (!iso) return t('tk.never');
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const d = (ms - Date.now()) / 1000;
    if (Math.abs(d) < 30) return t('tk.rel.now');
    return d < 0 ? t('tk.rel.past', { x: dur(-d) }) : t('tk.rel.future', { x: dur(d) });
  }
  const absTime = iso => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString(M.lang === 'vi' ? 'vi-VN' : 'en-US') : ''; };
  const varsOf = (...texts) => [...new Set(Array.from(texts.join('\n').matchAll(VAR_RE), m => m[1]))].filter(v => v !== 'project' && v !== 'date');
  function renderTpl(text, vars, projectPath) {
    const auto = { project: projName(projectPath), date: new Date().toISOString().slice(0, 10) };
    return String(text || '').replace(VAR_RE, (m, k) => (vars[k] ?? auto[k] ?? m));
  }
  // Agents a card occupies (same rule as the scheduler, design §1.4).
  function cardAgents(c) {
    if (c.mode === 'council') return c.reviewers?.length ? c.reviewers : [];
    const ids = [c.agent];
    if (c.mode === 'team') ids.push(...Object.values(c.team || {}));
    if (c.mode === 'auto-gate') ids.push(...(c.reviewers || []));
    return [...new Set(ids.filter(Boolean))];
  }
  function chip(id) {
    if (!id) return '';
    return `<span class="tk-agent" title="${esc(agentLabel(id))}"><i style="background:${esc(agentColor(id))}"></i>${esc(agentLabel(id))}</span>`;
  }
  function stBadge(s) {
    const cls = { running: 'b-warn', needs_input: 'b-warn', review: 'b-info', done: 'b-ok', failed: 'b-err' }[s] || '';
    return `<span class="badge ${cls}">${s === 'running' ? '<span class="dot warn live"></span>' : ''}${esc(stLabel(s))}</span>`;
  }
  function scoreBadge(a) {
    if (!a || a.score == null) return '';
    const cls = a.verdict === 'APPROVED' ? 'b-ok' : a.score >= 8.5 ? 'b-info' : 'b-warn';
    return `<span class="badge ${cls}" title="${esc(a.verdict || '')}">${esc(a.score)}/10</span>`;
  }

  // ---------- dialogs (native <dialog>: focus trap + Esc for free) ----------
  function dialog({ title, body, wide, drawer, onClose }) {
    const d = document.createElement('dialog');
    d.className = 'tk-dlg' + (wide ? ' is-wide' : '') + (drawer ? ' is-drawer' : '');
    d.innerHTML = `<div class="tk-dlg-h"><h3>${esc(title)}</h3><button type="button" class="btn btn-sm tk-x" aria-label="${esc(t('tk.close'))}">✕</button></div><div class="tk-dlg-b"></div>`;
    const b = d.querySelector('.tk-dlg-b');
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    // Clean up on close without relying on the async 'close' event alone (some embedded browsers delay it).
    let done = false;
    const finish = () => { if (done) return; done = true; d.remove(); onClose?.(); };
    const nativeClose = d.close.bind(d);
    d.close = v => { if (d.open) nativeClose(v); finish(); };
    d.addEventListener('close', finish);
    d.addEventListener('cancel', e => { e.preventDefault(); d.close(); });
    d.querySelector('.tk-x').onclick = () => d.close();
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
    d.showModal();
    return d;
  }
  function confirmDlg(msg, { danger = true, ok } = {}) {
    return new Promise(resolve => {
      let answer = false;
      const d = dialog({
        title: ok || t('tk.delete'),
        body: `<p class="tk-confirm">${esc(msg)}</p><div class="tk-dlg-f"><button type="button" class="btn" data-a="no">${esc(t('tk.cancel'))}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(ok || t('tk.delete'))}</button></div>`,
        onClose: () => resolve(answer)
      });
      d.querySelector('[data-a="no"]').onclick = () => d.close();
      d.querySelector('[data-a="yes"]').onclick = () => { answer = true; d.close(); };
      d.querySelector('[data-a="no"]').focus();
    });
  }

  // ---------- data ----------
  async function refresh(force) {
    if (S.inFlight) return;
    S.inFlight = true;
    try {
      const r = await get('task_list');
      S.tasks = Array.isArray(r.tasks) ? r.tasks : [];
      if (r.config) S.config = r.config;
      S.scheduler = r.scheduler || null;
      S.counts = r.counts || {};
      S.loaded = true; S.error = '';
    } catch (e) {
      S.error = e.status === 400 ? t('tk.unsupported') : errMsg(e);
    } finally { S.inFlight = false; }
    const sig = JSON.stringify([S.tasks, S.config, S.scheduler?.active, S.error]);
    const changed = force || sig !== S.sig;
    S.sig = sig;
    if (changed && (S.tab === 'board' || !S.loadedOnce)) { S.loadedOnce = true; paint(); } else paintHead();
    if (S.visible) tabTick().catch(() => {});
  }
  // Light refresh for the Auto Run and Schedules tabs (their forms must survive the 3 s poll).
  async function tabTick() {
    if (S.tab === 'autorun' && S.files && curProject()) {
      const runs = (await get('playbook_runs', { project_path: curProject().path })).runs || [];
      if (JSON.stringify(runs) === JSON.stringify(S.runs)) return;
      const wasRunning = S.runs.filter(r => r.status === 'running').map(r => r.id);
      S.runs = runs;
      const finished = wasRunning.some(id => runs.find(r => r.id === id)?.status !== 'running');
      if (finished) { S.files = null; if (S.playbook.file) await previewPlaybook(S.playbook.file, false); paint(); return; }
      const box = root?.querySelector('.tk-runs');
      if (box) { box.outerHTML = runsHtml(); wireRuns(root.querySelector('.tk-body')); }
    } else if (S.tab === 'schedules' && S.schedules && !document.querySelector('dialog.tk-dlg')) {
      const list = (await get('schedule_list')).schedules || [];
      if (JSON.stringify(list) !== JSON.stringify(S.schedules)) { S.schedules = list; paint(); }
    }
  }
  async function loadLibrary() {
    try {
      const [a, b] = await Promise.all([get('template_list'), get('preset_list')]);
      S.templates = a.templates || []; S.presets = b.presets || [];
    } catch (e) { S.templates ||= []; S.presets ||= []; if (S.visible) fail(e); }
  }
  function startPoll() {
    clearInterval(S.timer);
    S.timer = setInterval(() => { if (S.visible && !document.hidden && !S.dragging) refresh(); }, POLL_MS);
  }

  // ---------- view ----------
  let root;
  M.addView({
    id: 'board',
    title: () => t('tk.view'),
    render(el) {
      root = el;
      el.innerHTML = `<div class="wrap tk-wrap">
        <div class="tk-head">
          <h2 class="tk-h">${esc(t('tk.view'))}</h2>
          <div class="seg tk-tabs" role="tablist"></div>
          <span class="spacer"></span>
          <span class="tk-sched pill"></span>
          <button type="button" class="btn btn-primary btn-sm tk-new">+ <span></span></button>
        </div>
        <div class="tk-body"></div>
      </div>`;
      el.querySelector('.tk-new').onclick = () => openCard(null);
      el.querySelector('.tk-tabs').addEventListener('click', e => {
        const b = e.target.closest('[data-tab]'); if (!b) return;
        S.tab = b.dataset.tab; store.set('tk_tab', S.tab); paint();
      });
    },
    onShow() { S.visible = true; refresh(true); if (!S.templates) loadLibrary().then(() => { if (S.tab === 'library') paint(); }); startPoll(); }
  });
  M.on('view', id => { S.visible = id === 'board'; if (!S.visible) clearInterval(S.timer); });
  M.on('job-end', () => { if (S.visible) refresh(); });
  M.on('lang', () => { if (root) { S.sig = ''; paint(); } });
  M.on('project-change', () => { if (root && S.visible) { S.files = null; S.playbook = { file: '', items: null }; S.runs = []; paint(); } });
  // Elapsed timers on running cards, without repainting the board.
  setInterval(() => {
    if (!S.visible || !root) return;
    root.querySelectorAll('[data-since]').forEach(n => { const ms = Date.parse(n.dataset.since); if (ms) n.textContent = dur((Date.now() - ms) / 1000); });
  }, 1000);

  function paintHead() {
    if (!root) return;
    root.querySelector('.tk-h').textContent = t('tk.view');
    root.querySelector('.tk-new span').textContent = t('tk.new');
    root.querySelector('.tk-tabs').innerHTML = TABS.map(id => `<button type="button" role="tab" data-tab="${id}" aria-pressed="${S.tab === id}">${esc(t('tk.tab.' + id))}</button>`).join('');
    const sc = S.scheduler, pill = root.querySelector('.tk-sched');
    const running = S.tasks.filter(c => c.status === 'running').length;
    const state = !sc ? 'off' : S.config.paused ? 'paused' : sc.active === false ? 'passive' : 'active';
    pill.className = 'tk-sched pill' + (state === 'paused' || state === 'passive' ? ' warn' : '');
    pill.innerHTML = `<span class="dot ${state === 'active' ? 'ok' + (running ? ' live' : '') : state === 'off' ? '' : 'warn'}"></span><span class="truncate">${esc(t('tk.sched.' + state))} · ${esc(t('tk.running', { n: running, max: S.config.max_parallel ?? '∞' }))}</span>`;
    pill.title = sc?.pid ? t('tk.lim.owner', { pid: sc.pid, x: rel(sc.last_tick_at) }) : '';
  }

  function paint() {
    if (!root) return;
    paintHead();
    const body = root.querySelector('.tk-body');
    if (S.error && !S.loaded) { body.innerHTML = `<div class="card"><div class="empty">${esc(S.error)}</div></div>`; return; }
    if (!S.loaded) { body.innerHTML = `<div class="empty">${esc(t('tk.loading'))}</div>`; return; }
    try {
      if (S.tab === 'board') paintBoard(body);
      else if (S.tab === 'library') paintLibrary(body);
      else if (S.tab === 'autorun') paintAutoRun(body);
      else if (S.tab === 'schedules') paintSchedules(body);
      else paintLimits(body);
    } catch (e) { console.error('[board]', e); body.innerHTML = `<div class="card"><div class="empty">${esc(errMsg(e))}</div></div>`; }
  }

  // ---------- board ----------
  function visibleTasks() {
    const p = curProject()?.path, q = S.q.trim().toLowerCase();
    return S.tasks.filter(c =>
      (S.scope === 'all' || !p || c.project_path === p) &&
      (!S.agent || cardAgents(c).includes(S.agent)) &&
      (!q || (c.title + ' ' + (c.labels || []).join(' ') + ' ' + c.id).toLowerCase().includes(q)));
  }

  function paintBoard(body) {
    const focusId = document.activeElement?.closest?.('.tk-card')?.dataset.id;
    const tasks = visibleTasks();
    const dependants = {};
    for (const c of S.tasks) for (const d of c.depends_on || []) (dependants[d] ||= []).push(c.id);
    const ids = agentIds();
    let bar = body.querySelector('.tk-toolbar');
    if (!bar) {
      body.innerHTML = `<div class="tk-toolbar">
          <select class="select-sm tk-scope" aria-label="${esc(t('tk.f.project'))}"></select>
          <select class="select-sm tk-agentf" aria-label="${esc(t('tk.f.agent'))}"></select>
          <input class="input tk-q" type="search">
          <span class="tk-ext row-wrap"></span>
        </div>
        <div class="tk-board"><div class="tk-cols"><svg class="tk-arrows" aria-hidden="true"></svg></div></div>`;
      bar = body.querySelector('.tk-toolbar');
      bar.querySelector('.tk-scope').onchange = e => { S.scope = e.target.value; store.set('tk_scope', S.scope); paint(); };
      bar.querySelector('.tk-agentf').onchange = e => { S.agent = e.target.value; paint(); };
      bar.querySelector('.tk-q').oninput = e => { S.q = e.target.value; paintBoard(body); };
      wireBoard(body.querySelector('.tk-cols'));
    }
    const cp = curProject();
    bar.querySelector('.tk-scope').innerHTML = opt('cur', cp ? `${t('tk.curProject')}: ${cp.name}` : t('tk.curProject'), S.scope === 'cur') + opt('all', t('tk.allProjects'), S.scope === 'all');
    bar.querySelector('.tk-agentf').innerHTML = opt('', t('tk.allAgents'), !S.agent) + ids.map(id => opt(id, agentLabel(id), S.agent === id)).join('');
    bar.querySelector('.tk-q').placeholder = t('tk.search');
    const ext = bar.querySelector('.tk-ext');
    ext.innerHTML = '';
    for (const b of S.toolbar) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-sm';
      btn.textContent = typeof b.label === 'function' ? b.label() : b.label;
      btn.onclick = () => { try { b.run(); } catch (e) { fail(e); } };
      ext.appendChild(btn);
    }

    const cols = body.querySelector('.tk-cols');
    cols.querySelectorAll('.tk-col').forEach(n => n.remove());
    for (const st of STATUSES) {
      const list = tasks.filter(c => c.status === st).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.created_at).localeCompare(String(b.created_at)));
      const col = document.createElement('section');
      col.className = 'tk-col'; col.dataset.status = st;
      col.setAttribute('aria-label', stLabel(st));
      col.innerHTML = `<header class="tk-col-h"><span class="tk-col-dot st-${st}"></span><b>${esc(stLabel(st))}</b><span class="tk-count">${list.length}</span></header>
        <div class="tk-list">${list.map(c => cardHtml(c, dependants)).join('') || `<div class="tk-col-empty">${esc(t('tk.empty'))}</div>`}</div>`;
      cols.appendChild(col);
    }
    if (focusId) cols.querySelector(`.tk-card[data-id="${CSS.escape(focusId)}"]`)?.focus();
    requestAnimationFrame(() => drawArrows(cols));
  }

  function cardHtml(c, dependants) {
    const deps = (c.depends_on || []).filter(Boolean);
    const unmet = deps.filter(id => taskById(id)?.status !== 'done');
    const blocks = dependants[c.id] || [];
    const last = (c.attempts || [])[c.attempts?.length - 1];
    const src = c.source?.kind || (c.created_by !== 'user' ? c.created_by : '');
    const srcLabel = !src ? '' : src.startsWith('github') ? `GH${c.source?.number ? ' #' + c.source.number : ''}` : t('tk.src.' + src.replace(/-.*/, ''));
    const roleTxt = c.mode === 'task' ? c.role : c.mode;
    return html`<article class="tk-card st-${esc(c.status)}${c.priority >= 3 ? ' is-urgent' : ''}" data-id="${esc(c.id)}" tabindex="0" draggable="${c.status !== 'running'}" aria-label="${esc(c.title)}">
      <div class="tk-card-t">${c.priority ? `<span class="tk-prio p${c.priority > 0 ? '+' : '-'}" title="${esc(t('tk.prio') + ': ' + prioLabel(c.priority))}">${c.priority > 0 ? '▲'.repeat(Math.min(c.priority, 3)) : '▽'}</span>` : ''}<span class="clamp-2">${esc(c.title)}</span></div>
      <div class="tk-card-m">${chip(c.mode === 'council' ? (c.reviewers || [])[0] : c.agent)}${c.mode === 'council' && (c.reviewers || []).length > 1 ? `<span class="faint">+${c.reviewers.length - 1}</span>` : ''}<span class="badge">${esc(roleTxt || '')}</span>${scoreBadge(last)}${srcLabel ? `<span class="badge tk-src">${esc(srcLabel)}</span>` : ''}</div>
      ${deps.length || blocks.length || (c.attempts || []).length > 1 || (c.labels || []).length ? `<div class="tk-card-m">${deps.length ? `<span class="badge ${unmet.length ? 'b-warn' : 'b-ok'}" title="${esc(deps.map(id => taskById(id)?.title || id).join('\n'))}">⛓ ${esc(t('tk.waits', { n: unmet.length || deps.length }))}</span>` : ''}${blocks.length ? `<span class="badge" title="${esc(blocks.map(id => taskById(id)?.title || id).join('\n'))}">${esc(t('tk.blocks', { n: blocks.length }))}</span>` : ''}${(c.attempts || []).length > 1 ? `<span class="badge">↻ ${esc(c.attempts.length)}</span>` : ''}${(c.labels || []).slice(0, 3).map(l => `<span class="tk-label">${esc(l)}</span>`).join('')}</div>` : ''}
      ${c.status === 'running' && c.started_at ? `<div class="tk-card-f"><span class="dot warn live"></span><span class="mono" data-since="${esc(c.started_at)}">${esc(dur((Date.now() - Date.parse(c.started_at)) / 1000))}</span>${S.scope === 'all' ? `<span class="faint truncate">${esc(projName(c.project_path))}</span>` : ''}</div>`
        : c.status_reason ? `<div class="tk-card-f faint truncate" title="${esc(c.status_reason)}">${esc(c.status_reason)}</div>`
        : S.scope === 'all' ? `<div class="tk-card-f faint truncate">${esc(projName(c.project_path))}</div>` : ''}
      ${quickHtml(c)}
    </article>`;
  }
  function quickHtml(c) {
    const q = { backlog: ['queue', 'tk.queue'], queued: ['start', 'tk.start'], running: ['cancel', 'tk.stop'], failed: ['retry', 'tk.retry'], needs_input: ['retry', 'tk.retry'], review: ['approve', 'tk.approve'] }[c.status];
    return q ? `<button type="button" class="btn btn-sm tk-quick${q[0] === 'cancel' ? ' btn-danger' : ''}" data-q="${q[0]}">${esc(t(q[1]))}</button>` : '';
  }

  function wireBoard(cols) {
    cols.addEventListener('click', e => {
      const card = e.target.closest('.tk-card'); if (!card) return;
      const q = e.target.closest('[data-q]');
      const c = taskById(card.dataset.id); if (!c) return;
      if (q) { e.stopPropagation(); quick(c, q.dataset.q); return; }
      openCard(c.id);
    });
    cols.addEventListener('keydown', e => {
      const card = e.target.closest('.tk-card');
      if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCard(card.dataset.id); }
    });
    cols.addEventListener('pointerover', e => { const card = e.target.closest('.tk-card'); setHover(cols, card?.dataset.id || null); });
    cols.addEventListener('pointerleave', () => setHover(cols, null));
    cols.addEventListener('focusin', e => { const card = e.target.closest('.tk-card'); setHover(cols, card?.dataset.id || null); });
    // Drag & drop between columns; the drop position becomes before_id.
    cols.addEventListener('dragstart', e => {
      const card = e.target.closest('.tk-card'); if (!card || card.getAttribute('draggable') !== 'true') return;
      S.dragging = card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      requestAnimationFrame(() => card.classList.add('is-drag'));
      document.body.classList.add('tk-dragging');
    });
    cols.addEventListener('dragend', () => {
      S.dragging = null;
      document.body.classList.remove('tk-dragging');
      cols.querySelectorAll('.is-drag,.drop-over').forEach(n => n.classList.remove('is-drag', 'drop-over'));
      cols.querySelector('.tk-ph')?.remove();
    });
    cols.addEventListener('dragover', e => {
      const col = e.target.closest('.tk-col'); if (!col || !S.dragging) return;
      if (col.dataset.status === 'running') return;
      e.preventDefault();
      cols.querySelectorAll('.drop-over').forEach(n => n !== col && n.classList.remove('drop-over'));
      col.classList.add('drop-over');
      const list = col.querySelector('.tk-list');
      let ph = cols.querySelector('.tk-ph');
      if (!ph) { ph = document.createElement('div'); ph.className = 'tk-ph'; }
      const before = cardAfter(list, e.clientY);
      if (before) list.insertBefore(ph, before); else list.appendChild(ph);
    });
    cols.addEventListener('drop', async e => {
      const col = e.target.closest('.tk-col'); if (!col || !S.dragging) return;
      e.preventDefault();
      const id = S.dragging, status = col.dataset.status;
      const ph = cols.querySelector('.tk-ph');
      const next = ph?.nextElementSibling?.closest?.('.tk-card');
      const beforeId = next && next.dataset.id !== id ? next.dataset.id : undefined;
      S.dragging = null;
      const c = taskById(id);
      if (!c) return;
      await move(c, status, beforeId);
    });
  }
  function cardAfter(list, y) {
    for (const n of list.querySelectorAll('.tk-card:not(.is-drag)')) {
      const r = n.getBoundingClientRect();
      if (y < r.top + r.height / 2) return n;
    }
    return null;
  }
  function setHover(cols, id) {
    if (S.hover === id) return;
    S.hover = id;
    cols.querySelectorAll('.is-rel,.is-hot').forEach(n => n.classList.remove('is-rel', 'is-hot'));
    if (id) {
      const c = taskById(id);
      const rel = new Set([...(c?.depends_on || []), ...S.tasks.filter(x => (x.depends_on || []).includes(id)).map(x => x.id)]);
      cols.querySelector(`.tk-card[data-id="${CSS.escape(id)}"]`)?.classList.add('is-hot');
      for (const r of rel) cols.querySelector(`.tk-card[data-id="${CSS.escape(r)}"]`)?.classList.add('is-rel');
    }
    drawArrows(cols);
  }
  // Dependency arrows between visible cards (desktop only; badges carry the same info on mobile).
  function drawArrows(cols) {
    const svg = cols.querySelector('.tk-arrows'); if (!svg) return;
    if (window.innerWidth < 900) { svg.innerHTML = ''; return; }
    const box = cols.getBoundingClientRect();
    svg.setAttribute('width', cols.scrollWidth); svg.setAttribute('height', cols.scrollHeight);
    const pos = {};
    cols.querySelectorAll('.tk-card').forEach(n => { pos[n.dataset.id] = n.getBoundingClientRect(); });
    let out = '<defs><marker id="tkArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="context-stroke"/></marker></defs>';
    for (const c of S.tasks) {
      const to = pos[c.id]; if (!to) continue;
      for (const d of c.depends_on || []) {
        const from = pos[d]; if (!from) continue;
        const hot = S.hover && (S.hover === c.id || S.hover === d);
        if (S.hover && !hot) continue;
        const met = taskById(d)?.status === 'done';
        let x1, y1, x2, y2, path;
        if (Math.abs(from.left - to.left) < 10) {
          // same column: loop out on the right side
          x1 = from.right - box.left; y1 = from.top + from.height / 2 - box.top;
          x2 = to.right - box.left; y2 = to.top + to.height / 2 - box.top;
          const bulge = 26;
          path = `M${x1} ${y1} C${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2 + 2} ${y2}`;
        } else {
          const ltr = from.left < to.left;
          x1 = (ltr ? from.right : from.left) - box.left; y1 = from.top + from.height / 2 - box.top;
          x2 = (ltr ? to.left : to.right) - box.left; y2 = to.top + to.height / 2 - box.top;
          const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (ltr ? 1 : -1);
          path = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        }
        out += `<path d="${path}" class="tk-arrow${met ? ' met' : ''}${hot ? ' hot' : ''}" marker-end="url(#tkArrow)"/>`;
      }
    }
    svg.innerHTML = out;
  }
  window.addEventListener('resize', () => { const cols = root?.querySelector('.tk-cols'); if (cols && S.visible) drawArrows(cols); });

  // ---------- card actions ----------
  async function move(c, status, beforeId) {
    if (c.status === 'running') { toast(t('tk.running.cannotEdit'), 'warn'); return; }
    // optimistic: place it now, the next poll confirms
    const prev = c.status; c.status = status;
    S.sig = ''; paint();
    try { await post('task_move', { id: c.id, status, before_id: beforeId }); }
    catch (e) { c.status = prev; fail(e); }
    refresh(true);
  }
  async function quick(c, what) {
    try {
      if (what === 'queue') { await post('task_move', { id: c.id, status: 'queued' }); toast(t('tk.queuedMsg'), 'ok'); }
      else if (what === 'start') { await post('task_start', { id: c.id }); toast(t('tk.started'), 'ok'); }
      else if (what === 'cancel') { if (!await confirmDlg(t('tk.confirmCancel', { x: c.title }), { ok: t('tk.stop') })) return; await post('task_cancel', { id: c.id }); }
      else if (what === 'retry') { retryDialog(c); return; }
      else if (what === 'approve') { await post('task_move', { id: c.id, status: 'done' }); toast(t('tk.saved'), 'ok'); }
      refresh(true);
    } catch (e) { fail(e); refresh(true); }
  }

  // ---------- card drawer (create / edit / attempts) ----------
  async function openCard(id, prefill) {
    if (!S.templates) await loadLibrary();
    const c = id ? taskById(id) : null;
    if (id && !c) return;
    const isNew = !c;
    const draft = c ? structuredClone(c) : {
      title: '', prompt: '', project_path: curProject()?.path || projects()[0]?.path || '', mode: 'task',
      agent: agentIds().includes('claude') ? 'claude' : agentIds()[0] || '', role: 'backend', team: {}, reviewers: [],
      preset_id: '', depends_on: [], priority: 0, labels: [], require_review: false, isolate: false,
      retry: { auto: false, max_attempts: 3, backoff_sec: 60 }, model: '', effort: '', ...prefill
    };
    const box = document.createElement('div');
    box.className = 'tk-drawer';
    const d = dialog({ title: isNew ? t('tk.new') : c.title, body: box, drawer: true });
    const st = { draft, vars: {}, tpl: null, log: '' };
    const repaint = () => paintDrawer(d, box, c, st, isNew);
    repaint();
    if (c) {
      try { const r = await get('task_get', { id: c.id }); st.log = r.log_tail || ''; if (r.task) Object.assign(c, r.task); repaint(); } catch { /* list data is enough */ }
    }
    d._repaint = repaint;
  }

  function paintDrawer(d, box, c, st, isNew) {
    const dr = st.draft;
    const running = c?.status === 'running';
    const ids = agentIds();
    const others = S.tasks.filter(x => x.id !== c?.id && x.project_path === dr.project_path);
    const tpls = S.templates || [], presets = S.presets || [];
    const agentLbl = dr.mode === 'team' ? t('tk.f.leader') : dr.mode === 'auto-gate' ? t('tk.f.implementer') : t('tk.f.agent');
    const actions = c ? cardButtons(c) : '';
    const tplVars = st.tpl ? varsOf(st.tpl.title, st.tpl.prompt) : [];
    const agentModels = agents()[dr.agent]?.models || [], agentEfforts = agents()[dr.agent]?.efforts || [];
    box.innerHTML = html`
      ${c ? `<div class="tk-dr-top">${stBadge(c.status)}<span class="faint mono tk-id">${esc(c.id)}</span>${c.source?.url ? `<a href="${esc(c.source.url)}" target="_blank" rel="noopener noreferrer" class="sub">${esc(c.source.kind)} ↗</a>` : ''}${c.pr?.url ? `<a href="${esc(c.pr.url)}" target="_blank" rel="noopener noreferrer" class="sub">PR #${esc(c.pr.number || '')} ↗</a>` : ''}<span class="spacer"></span>
        <select class="select-sm tk-moveto" aria-label="${esc(t('tk.moveTo'))}"${running ? ' disabled' : ''}>${opt('', t('tk.moveTo'), true)}${STATUSES.filter(s => s !== 'running' && s !== c.status).map(s => opt(s, stLabel(s))).join('')}</select></div>
        ${c.status_reason ? `<div class="callout">${esc(c.status_reason)}</div>` : ''}
        <div class="row-wrap tk-dr-actions">${actions}</div>` : ''}
      <form class="tk-form" novalidate>
        ${isNew && tpls.length ? `<div><label class="lbl" for="tkTpl">${esc(t('tk.f.template'))}</label><select id="tkTpl" name="tpl">${opt('', t('tk.f.none'), !st.tpl)}${tpls.map(x => opt(x.id, x.name + (x.builtin ? ` (${t('tk.builtin')})` : ''), st.tpl?.id === x.id)).join('')}</select></div>` : ''}
        ${tplVars.length ? `<div class="tk-vars"><span class="lbl">${esc(t('tk.f.vars'))}</span>${tplVars.map(v => `<label class="tk-var"><span class="mono">{{${esc(v)}}}</span><input class="input" name="var:${esc(v)}" value="${esc(st.vars[v] || '')}"></label>`).join('')}</div>` : ''}
        <div><label class="lbl" for="tkTitle">${esc(t('tk.f.title'))}</label><input id="tkTitle" class="input" name="title" maxlength="200" value="${esc(dr.title)}" required></div>
        <div><label class="lbl" for="tkPrompt">${esc(t('tk.f.prompt'))}</label><textarea id="tkPrompt" name="prompt" maxlength="20000" rows="7"${running ? ' disabled' : ''}>${esc(dr.prompt)}</textarea></div>
        <div class="tk-grid">
          <div><label class="lbl" for="tkProj">${esc(t('tk.f.project'))}</label><select id="tkProj" name="project_path"${running ? ' disabled' : ''}>${projects().map(p => opt(p.path, p.name, p.path === dr.project_path)).join('')}${dr.project_path && !projects().some(p => p.path === dr.project_path) ? opt(dr.project_path, dr.project_path, true) : ''}</select></div>
          <div><label class="lbl" for="tkMode">${esc(t('tk.f.mode'))}</label><select id="tkMode" name="mode"${running ? ' disabled' : ''}>${MODES.map(m => opt(m, m, m === dr.mode)).join('')}</select></div>
          ${dr.mode !== 'council' ? `<div><label class="lbl" for="tkAgent">${esc(agentLbl)}</label><select id="tkAgent" name="agent"${running ? ' disabled' : ''}>${ids.map(i => opt(i, agentLabel(i), i === dr.agent)).join('')}</select></div>` : ''}
          ${dr.mode === 'task' ? `<div><label class="lbl" for="tkRole">${esc(t('tk.f.role'))}</label><select id="tkRole" name="role"${running ? ' disabled' : ''}>${ROLES.map(r => opt(r, r, r === dr.role)).join('')}</select></div>` : ''}
          ${dr.mode === 'task' && agentModels.length ? `<div><label class="lbl" for="tkModel">${esc(t('tk.f.model'))}</label><select id="tkModel" name="model"${running ? ' disabled' : ''}>${opt('', t('tk.f.default'), !dr.model)}${agentModels.map(m => opt(m, m, m === dr.model)).join('')}</select></div>` : ''}
          ${dr.mode === 'task' && agentEfforts.length ? `<div><label class="lbl" for="tkEffort">${esc(t('tk.f.effort'))}</label><select id="tkEffort" name="effort"${running ? ' disabled' : ''}>${opt('', t('tk.f.default'), !dr.effort)}${agentEfforts.map(m => opt(m, m, m === dr.effort)).join('')}</select></div>` : ''}
          <div><label class="lbl" for="tkPreset">${esc(t('tk.f.preset'))}</label><select id="tkPreset" name="preset_id"${running ? ' disabled' : ''}>${opt('', t('tk.f.none'), !dr.preset_id)}${presets.map(p => opt(p.id, p.name, p.id === dr.preset_id)).join('')}</select></div>
          <div><label class="lbl" for="tkPrio">${esc(t('tk.prio'))}</label><select id="tkPrio" name="priority">${[3, 2, 1, 0, -1, -2].map(p => opt(p, `${p > 0 ? '+' : ''}${p} · ${prioLabel(p)}`, Number(dr.priority) === p)).join('')}</select></div>
        </div>
        ${dr.mode === 'team' ? `<div><span class="lbl">${esc(t('tk.f.team'))}</span><div class="tk-grid">${TEAM_SLOTS.map(s => `<label class="tk-inline"><span class="sub">${esc(s)}</span><select name="team:${s}"${running ? ' disabled' : ''}>${opt('', t('tk.f.none'), !dr.team?.[s])}${ids.map(i => opt(i, agentLabel(i), dr.team?.[s] === i)).join('')}</select></label>`).join('')}</div></div>` : ''}
        ${dr.mode === 'council' || dr.mode === 'auto-gate' ? `<div><span class="lbl">${esc(t('tk.f.reviewers'))}</span><div class="row-wrap">${ids.filter(i => cap(i, 'review')).map(i => `<label class="check tk-pick"><input type="checkbox" name="rev" value="${esc(i)}"${(dr.reviewers || []).includes(i) ? ' checked' : ''}${running ? ' disabled' : ''}>${chip(i)}</label>`).join('')}</div></div>` : ''}
        <div><span class="lbl">${esc(t('tk.f.deps'))}</span>${others.length ? `<div class="tk-deps">${others.map(o => `<label class="check"><input type="checkbox" name="dep" value="${esc(o.id)}"${(dr.depends_on || []).includes(o.id) ? ' checked' : ''}${running ? ' disabled' : ''}><span class="truncate">${esc(o.title)}</span>${stBadge(o.status)}</label>`).join('')}</div>` : `<div class="sub">${esc(t('tk.f.noDeps'))}</div>`}</div>
        <div><label class="lbl" for="tkLabels">${esc(t('tk.f.labels'))}</label><input id="tkLabels" class="input" name="labels" value="${esc((dr.labels || []).join(', '))}"></div>
        <div class="row-wrap tk-checks">
          <label class="check"><input type="checkbox" name="require_review"${dr.require_review ? ' checked' : ''}${running ? ' disabled' : ''}>${esc(t('tk.f.requireReview'))}</label>
          <label class="check"><input type="checkbox" name="isolate"${dr.isolate ? ' checked' : ''}${running ? ' disabled' : ''}>${esc(t('tk.f.isolate'))}</label>
          <label class="check"><input type="checkbox" name="retry_auto"${dr.retry?.auto ? ' checked' : ''}>${esc(t('tk.f.autoRetry'))}</label>
        </div>
        ${dr.retry?.auto ? `<div class="tk-grid"><div><label class="lbl" for="tkMax">${esc(t('tk.f.maxAttempts'))}</label><input id="tkMax" class="input" type="number" min="1" max="10" name="retry_max" value="${esc(dr.retry.max_attempts ?? 3)}"></div><div><label class="lbl" for="tkBack">${esc(t('tk.f.backoff'))}</label><input id="tkBack" class="input" type="number" min="5" max="3600" name="retry_backoff" value="${esc(dr.retry.backoff_sec ?? 60)}"></div></div>` : ''}
        ${running ? `<div class="callout">${esc(t('tk.running.cannotEdit'))}</div>` : ''}
        <div class="tk-dlg-f">
          ${isNew ? `<button type="submit" class="btn" data-save="backlog">${esc(t('tk.saveBacklog'))}</button><button type="submit" class="btn btn-primary" data-save="queued">${esc(t('tk.saveQueue'))}</button>`
            : `<button type="submit" class="btn btn-primary" data-save="">${esc(t('tk.save'))}</button>`}
        </div>
      </form>
      ${c ? attemptsHtml(c, st.log) : ''}`;

    const form = box.querySelector('form');
    // Keep the draft in sync so a repaint (mode / template change) never loses typing.
    const sync = () => {
      const f = new FormData(form);
      for (const k of ['title', 'prompt', 'project_path', 'mode', 'agent', 'role', 'preset_id', 'model', 'effort']) if (f.has(k)) dr[k] = String(f.get(k));
      if (f.has('priority')) dr.priority = Number(f.get('priority'));
      dr.labels = String(f.get('labels') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!running) {
        dr.require_review = f.has('require_review'); dr.isolate = f.has('isolate');
        dr.depends_on = f.getAll('dep').map(String);
        if (dr.mode === 'council' || dr.mode === 'auto-gate') dr.reviewers = f.getAll('rev').map(String);
        if (dr.mode === 'team') { dr.team = {}; for (const s of TEAM_SLOTS) { const v = f.get('team:' + s); if (v) dr.team[s] = String(v); } }
      }
      dr.retry = { auto: f.has('retry_auto'), max_attempts: Number(f.get('retry_max') || dr.retry?.max_attempts || 3), backoff_sec: Number(f.get('retry_backoff') || dr.retry?.backoff_sec || 60) };
      for (const [k, v] of f.entries()) if (k.startsWith('var:')) st.vars[k.slice(4)] = String(v);
    };
    form.addEventListener('change', e => {
      sync();
      const n = e.target.name;
      if (n === 'tpl') {
        st.tpl = (S.templates || []).find(x => x.id === e.target.value) || null;
        if (st.tpl) {
          Object.assign(dr, { title: st.tpl.title || st.tpl.name, prompt: st.tpl.prompt, mode: st.tpl.mode || dr.mode, role: st.tpl.role || dr.role, preset_id: st.tpl.preset_id || dr.preset_id, labels: st.tpl.labels?.length ? st.tpl.labels : dr.labels });
          if (st.tpl.agent && agentIds().includes(st.tpl.agent)) dr.agent = st.tpl.agent;
        }
        paintDrawer(d, box, c, st, isNew);
      } else if (['mode', 'agent', 'project_path', 'retry_auto'].includes(n)) {
        if (n === 'agent') { dr.model = ''; dr.effort = ''; }
        if (n === 'project_path') dr.depends_on = [];
        paintDrawer(d, box, c, st, isNew);
      }
    });
    form.addEventListener('input', sync);
    form.addEventListener('submit', async e => {
      e.preventDefault(); sync();
      const status = e.submitter?.dataset.save || '';
      const body = buildBody(dr, st, running);
      if (!body) return;
      e.submitter && (e.submitter.disabled = true);
      try {
        if (isNew) { await post('task_create', { ...body, status: status || 'backlog' }); toast(t('tk.created'), 'ok'); }
        else { await post('task_update', { id: c.id, ...body }); toast(t('tk.saved'), 'ok'); }
        d.close(); refresh(true);
      } catch (err) { fail(err); e.submitter && (e.submitter.disabled = false); }
    });
    box.querySelector('.tk-moveto')?.addEventListener('change', async e => { if (!e.target.value) return; await move(c, e.target.value); d.close(); });
    box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => cardAct(c, b.dataset.act, d));
    box.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => {
      const a = S.cardActions.find(x => x.id === b.dataset.ext);
      try { a?.run(c, { close: () => d.close() }); } catch (err) { fail(err); }
    });
  }

  function buildBody(dr, st, running) {
    if (st.tpl) {
      const missing = varsOf(st.tpl.title, st.tpl.prompt).find(v => !String(st.vars[v] || '').trim());
      if (missing) { toast(t('tk.missingVar', { x: missing }), 'warn'); return null; }
    }
    const title = renderTpl(dr.title, st.vars, dr.project_path).trim();
    const prompt = renderTpl(dr.prompt, st.vars, dr.project_path).trim();
    if (!title || (!running && !prompt)) { toast(t('tk.needTitle'), 'warn'); return null; }
    if (running) return { title, labels: dr.labels, priority: dr.priority, retry: dr.retry };
    if (!dr.project_path) { toast(t('tk.needProject'), 'warn'); return null; }
    const body = {
      title, prompt, project_path: dr.project_path, mode: dr.mode, priority: dr.priority, labels: dr.labels,
      depends_on: dr.depends_on, require_review: dr.require_review, isolate: dr.isolate, preset_id: dr.preset_id || '', retry: dr.retry
    };
    if (dr.mode !== 'council') body.agent = dr.agent;
    if (dr.mode === 'task') { body.role = dr.role; body.model = dr.model || ''; body.effort = dr.effort || ''; }
    if (dr.mode === 'team') body.team = dr.team || {};
    if (dr.mode === 'council' || dr.mode === 'auto-gate') body.reviewers = dr.reviewers || [];
    return body;
  }

  function cardButtons(c) {
    const b = (act, label, cls = '') => `<button type="button" class="btn btn-sm ${cls}" data-act="${act}">${esc(t(label))}</button>`;
    const out = [];
    if (c.status === 'backlog') out.push(b('queue', 'tk.queue'), b('start', 'tk.start', 'btn-primary'));
    if (c.status === 'queued') out.push(b('start', 'tk.start', 'btn-primary'));
    if (c.status === 'running') out.push(b('cancel', 'tk.stop', 'btn-danger'));
    if (c.status === 'review') out.push(b('approve', 'tk.approve', 'btn-primary'), b('reject', 'tk.reject', 'btn-danger'));
    if (['failed', 'review', 'needs_input', 'done'].includes(c.status)) out.push(b('retry', 'tk.retry'));
    if (c.job_id) out.push(b('log', 'tk.openLog'));
    for (const a of S.cardActions) {
      let show = false; try { show = !a.when || a.when(c); } catch { show = false; }
      if (show) out.push(`<button type="button" class="btn btn-sm" data-ext="${esc(a.id)}">${esc(typeof a.label === 'function' ? a.label(c) : a.label)}</button>`);
    }
    if (c.status !== 'running') out.push(b('delete', 'tk.delete', 'btn-danger tk-push'));
    return out.join('');
  }

  async function cardAct(c, act, d) {
    try {
      if (act === 'queue') { await post('task_move', { id: c.id, status: 'queued' }); toast(t('tk.queuedMsg'), 'ok'); }
      else if (act === 'start') { await post('task_start', { id: c.id }); toast(t('tk.started'), 'ok'); }
      else if (act === 'cancel') { if (!await confirmDlg(t('tk.confirmCancel', { x: c.title }), { ok: t('tk.stop') })) return; await post('task_cancel', { id: c.id }); }
      else if (act === 'approve') { await post('task_move', { id: c.id, status: 'done' }); }
      else if (act === 'reject') { if (!await confirmDlg(t('tk.confirmReject', { x: c.title }), { ok: t('tk.reject') })) return; await post('task_move', { id: c.id, status: 'failed', reason: 'rejected by user' }); }
      else if (act === 'retry') { d.close(); retryDialog(c); return; }
      else if (act === 'log') { showLog(c); return; }
      else if (act === 'delete') { if (!await confirmDlg(t('tk.confirmDelete', { x: c.title }))) return; await post('task_delete', { id: c.id }); toast(t('tk.deleted'), 'ok'); }
      d.close(); refresh(true);
    } catch (e) { fail(e); refresh(true); }
  }

  function attemptsHtml(c, log) {
    const list = [...(c.attempts || [])].reverse();
    return html`<section class="tk-attempts"><h4>${esc(t('tk.attemptsTitle'))}</h4>
      ${list.length ? `<ol class="tk-tl">${list.map(a => `<li class="tk-tl-i st-${esc(String(a.status || '').toLowerCase())}">
        <div class="row-wrap"><b>#${esc(a.n)}</b>${chip(a.agent)}<span class="badge">${esc(a.kind || 'start')}</span>${a.status ? `<span class="badge ${a.status === 'DONE' ? 'b-ok' : a.status === 'RUNNING' ? 'b-warn' : 'b-err'}">${esc(a.status)}${a.exit_code != null ? ' · ' + esc(a.exit_code) : ''}</span>` : ''}${scoreBadge(a)}<span class="sub" title="${esc(absTime(a.started_at))}">${esc(rel(a.started_at))}</span>${a.finished_at && a.started_at ? `<span class="sub">· ${esc(dur((Date.parse(a.finished_at) - Date.parse(a.started_at)) / 1000))}</span>` : ''}</div>
        ${a.error ? `<div class="t-err sub">${esc(a.error)}</div>` : ''}
        ${a.findings ? `<details><summary class="sub">${esc(t('tk.findings'))}</summary><pre class="code tk-pre">${esc(a.findings)}</pre></details>` : ''}
        ${a.job_id ? `<div class="faint mono tk-id">${esc(a.job_id)}</div>` : ''}
      </li>`).join('')}</ol>` : `<div class="sub">${esc(t('tk.noAttempts'))}</div>`}
      ${log ? `<details${c.status === 'running' ? ' open' : ''}><summary class="sub">${esc(t('tk.logTail'))}</summary><pre class="log tk-pre">${esc(log)}</pre></details>` : ''}
    </section>`;
  }

  async function showLog(c) {
    let log = '';
    try { log = (await get('task_get', { id: c.id })).log_tail || ''; } catch (e) { fail(e); return; }
    dialog({ title: `${t('tk.logTail')} · ${c.job_id}`, body: `<pre class="log tk-pre tk-logbig">${esc(log || '—')}</pre>`, wide: true });
  }

  function retryDialog(c) {
    const last = (c.attempts || [])[c.attempts.length - 1];
    const ids = agentIds();
    const d = dialog({
      title: `${t('tk.retryTitle')}: ${c.title}`,
      body: html`<form class="tk-form">
        <div class="tk-grid">
          ${c.mode !== 'council' ? `<div><label class="lbl" for="trAgent">${esc(c.mode === 'auto-gate' ? t('tk.f.implementer') : c.mode === 'team' ? t('tk.f.leader') : t('tk.f.agent'))}</label><select id="trAgent" name="agent">${ids.map(i => opt(i, agentLabel(i), i === c.agent)).join('')}</select></div>` : ''}
          ${c.mode === 'task' ? `<div><label class="lbl" for="trRole">${esc(t('tk.f.role'))}</label><select id="trRole" name="role">${ROLES.map(r => opt(r, r, r === c.role)).join('')}</select></div>` : ''}
        </div>
        <label class="check"><input type="checkbox" name="include_findings"${last?.findings ? ' checked' : ' disabled'}>${esc(t('tk.includeFindings'))}</label>
        ${last?.findings ? `<details><summary class="sub">${esc(t('tk.findings'))} #${esc(last.n)}</summary><pre class="code tk-pre">${esc(last.findings)}</pre></details>` : ''}
        <div><label class="lbl" for="trNote">${esc(t('tk.note'))}</label><textarea id="trNote" name="note" rows="3" maxlength="4000"></textarea></div>
        <p class="sub tk-resume-hint">${esc(t('tk.resumeHint'))}</p>
        <div class="tk-dlg-f"><button type="button" class="btn tk-resume">${esc(t('tk.resume'))}</button><button type="submit" class="btn btn-primary">${esc(t('tk.retry'))}</button></div>
      </form>`
    });
    const form = d.querySelector('form');
    const resumeBtn = d.querySelector('.tk-resume');
    const syncResume = () => { const ag = form.agent?.value || c.agent; resumeBtn.disabled = !cap(ag, 'sessions'); };
    form.agent?.addEventListener('change', syncResume); syncResume();
    const go = async mode => {
      const f = new FormData(form);
      const body = { id: c.id, mode, include_findings: f.has('include_findings'), note: String(f.get('note') || '') };
      if (f.has('agent') && f.get('agent') !== c.agent) body.agent = String(f.get('agent'));
      if (f.has('role') && f.get('role') !== c.role) body.role = String(f.get('role'));
      try { await post('task_retry', body); toast(t('tk.queuedMsg'), 'ok'); d.close(); refresh(true); } catch (e) { fail(e); }
    };
    form.addEventListener('submit', e => { e.preventDefault(); go('retry'); });
    resumeBtn.onclick = () => go('resume');
  }

  // ---------- templates & presets ----------
  function paintLibrary(body) {
    if (!S.templates) { body.innerHTML = `<div class="empty">${esc(t('tk.loading'))}</div>`; loadLibrary().then(paint); return; }
    const presetLine = p => [
      ...TEAM_SLOTS.filter(s => p.team?.[s]).map(s => `<span class="sub">${esc(s)}</span>${chip(p.team[s])}`),
      p.reviewers?.length ? `<span class="sub">${esc(t('tk.f.reviewers'))}</span>${p.reviewers.map(chip).join('')}` : '',
      `<span class="badge">${esc(t('tk.ps.rounds'))}: ${esc(p.max_fix_rounds ?? '—')}</span>`,
      p.budget_usd ? `<span class="badge">$${esc(p.budget_usd)}</span>` : '',
      p.isolate ? `<span class="badge b-info">worktree</span>` : ''
    ].join('');
    body.innerHTML = html`<div class="tk-lib-bar row-wrap"><span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-l="export">${esc(t('tk.export'))}</button>
        <label class="btn btn-sm tk-file">${esc(t('tk.import'))}<input type="file" accept="application/json,.json" hidden></label>
      </div>
      <div class="grid g-half">
        <section class="card"><div class="card-h"><h2>${esc(t('tk.tpl.title'))}</h2><span class="meta"><button type="button" class="btn btn-sm" data-l="tpl-new">+ ${esc(t('tk.tpl.new'))}</button></span></div>
          <div class="list">${S.templates.map(x => `<div class="item tk-li"><div class="row-wrap"><b>${esc(x.name)}</b>${x.builtin ? `<span class="badge">${esc(t('tk.builtin'))}</span>` : ''}<span class="badge">${esc(x.mode === 'task' ? x.role || 'task' : x.mode)}</span>${varsOf(x.title, x.prompt).map(v => `<code>{{${esc(v)}}}</code>`).join('')}</div>
            ${x.description ? `<div class="sub">${esc(x.description)}</div>` : ''}<div class="sub clamp-2 mono">${esc(x.prompt)}</div>
            <div class="row-wrap tk-li-a"><button type="button" class="btn btn-sm btn-primary" data-l="tpl-use" data-id="${esc(x.id)}">${esc(t('tk.tpl.use'))}</button>
            ${x.builtin ? `<button type="button" class="btn btn-sm" data-l="tpl-copy" data-id="${esc(x.id)}">${esc(t('tk.tpl.copy'))}</button>` : `<button type="button" class="btn btn-sm" data-l="tpl-edit" data-id="${esc(x.id)}">${esc(t('tk.edit'))}</button><button type="button" class="btn btn-sm btn-danger" data-l="tpl-del" data-id="${esc(x.id)}">${esc(t('tk.delete'))}</button>`}</div></div>`).join('') || `<div class="empty">—</div>`}</div></section>
        <section class="card"><div class="card-h"><h2>${esc(t('tk.ps.title'))}</h2><span class="meta"><button type="button" class="btn btn-sm" data-l="ps-new">+ ${esc(t('tk.ps.new'))}</button></span></div>
          <div class="list">${S.presets.map(p => `<div class="item tk-li"><div class="row-wrap"><b>${esc(p.name)}</b>${p.builtin ? `<span class="badge">${esc(t('tk.builtin'))}</span>` : ''}</div>
            ${p.description ? `<div class="sub">${esc(p.description)}</div>` : ''}<div class="row-wrap tk-preset">${presetLine(p)}</div>
            <div class="row-wrap tk-li-a">${p.builtin ? `<button type="button" class="btn btn-sm" data-l="ps-copy" data-id="${esc(p.id)}">${esc(t('tk.tpl.copy'))}</button>` : `<button type="button" class="btn btn-sm" data-l="ps-edit" data-id="${esc(p.id)}">${esc(t('tk.edit'))}</button><button type="button" class="btn btn-sm btn-danger" data-l="ps-del" data-id="${esc(p.id)}">${esc(t('tk.delete'))}</button>`}</div></div>`).join('') || `<div class="empty">—</div>`}</div></section>
      </div>`;
    body.querySelector('input[type=file]').onchange = e => importLibrary(e.target.files?.[0]);
    body.querySelectorAll('[data-l]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, kind = b.dataset.l;
      const tpl = S.templates.find(x => x.id === id), ps = S.presets.find(x => x.id === id);
      try {
        if (kind === 'export') exportLibrary();
        else if (kind === 'tpl-new') templateDialog(null);
        else if (kind === 'tpl-edit') templateDialog(tpl);
        else if (kind === 'tpl-copy') templateDialog({ ...tpl, id: undefined, builtin: false, name: tpl.name + ' (copy)' });
        else if (kind === 'tpl-use') useTemplate(tpl);
        else if (kind === 'tpl-del') { if (!await confirmDlg(t('tk.confirmDeleteItem', { x: tpl.name }))) return; await post('template_delete', { id }); await loadLibrary(); paint(); }
        else if (kind === 'ps-new') presetDialog(null);
        else if (kind === 'ps-edit') presetDialog(ps);
        else if (kind === 'ps-copy') presetDialog({ ...ps, id: undefined, builtin: false, name: ps.name + ' (copy)' });
        else if (kind === 'ps-del') { if (!await confirmDlg(t('tk.confirmDeleteItem', { x: ps.name }))) return; await post('preset_delete', { id }); await loadLibrary(); paint(); }
      } catch (e) { fail(e); }
    });
  }
  function useTemplate(tpl) {
    // Open a new card with this template preselected (the drawer renders the variable inputs).
    openCard(null).then(() => {
      const sel = document.querySelector('dialog.tk-dlg.is-drawer #tkTpl');
      if (sel) { sel.value = tpl.id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }
  function templateDialog(x) {
    const v = x || { name: '', description: '', title: '', prompt: '', mode: 'task', role: 'backend', agent: '', preset_id: '', labels: [] };
    const d = dialog({
      title: x?.id ? `${t('tk.edit')}: ${x.name}` : t('tk.tpl.new'), wide: true,
      body: html`<form class="tk-form">
        <div class="tk-grid"><div><label class="lbl" for="ttName">${esc(t('tk.tpl.name'))}</label><input id="ttName" class="input" name="name" maxlength="80" required value="${esc(v.name)}"></div>
        <div><label class="lbl" for="ttDesc">${esc(t('tk.tpl.desc'))}</label><input id="ttDesc" class="input" name="description" maxlength="300" value="${esc(v.description || '')}"></div></div>
        <div><label class="lbl" for="ttTitle">${esc(t('tk.tpl.cardTitle'))}</label><input id="ttTitle" class="input" name="title" maxlength="200" value="${esc(v.title || '')}"></div>
        <div><label class="lbl" for="ttPrompt">${esc(t('tk.f.prompt'))}</label><textarea id="ttPrompt" name="prompt" rows="8" maxlength="20000" required>${esc(v.prompt || '')}</textarea><p class="sub">${esc(t('tk.tpl.varsHint'))}</p></div>
        <div class="tk-grid">
          <div><label class="lbl" for="ttMode">${esc(t('tk.f.mode'))}</label><select id="ttMode" name="mode">${MODES.map(m => opt(m, m, m === v.mode)).join('')}</select></div>
          <div><label class="lbl" for="ttRole">${esc(t('tk.f.role'))}</label><select id="ttRole" name="role">${opt('', t('tk.f.none'), !v.role)}${ROLES.map(r => opt(r, r, r === v.role)).join('')}</select></div>
          <div><label class="lbl" for="ttAgent">${esc(t('tk.f.agent'))}</label><select id="ttAgent" name="agent">${opt('', t('tk.f.default'), !v.agent)}${agentIds().map(i => opt(i, agentLabel(i), i === v.agent)).join('')}</select></div>
          <div><label class="lbl" for="ttPreset">${esc(t('tk.f.preset'))}</label><select id="ttPreset" name="preset_id">${opt('', t('tk.f.none'), !v.preset_id)}${(S.presets || []).map(p => opt(p.id, p.name, p.id === v.preset_id)).join('')}</select></div>
        </div>
        <div><label class="lbl" for="ttLabels">${esc(t('tk.f.labels'))}</label><input id="ttLabels" class="input" name="labels" value="${esc((v.labels || []).join(', '))}"></div>
        <div class="tk-dlg-f"><button type="submit" class="btn btn-primary">${esc(t('tk.save'))}</button></div>
      </form>`
    });
    d.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = Object.fromEntries(['name', 'description', 'title', 'prompt', 'mode', 'role', 'agent', 'preset_id'].map(k => [k, String(f.get(k) || '').trim()]));
      body.labels = String(f.get('labels') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (x?.id) body.id = x.id;
      if (!body.name || !body.prompt) { toast(t('tk.needTitle'), 'warn'); return; }
      try { await post('template_save', body); toast(t('tk.saved'), 'ok'); d.close(); await loadLibrary(); paint(); } catch (err) { fail(err); }
    });
  }
  function presetDialog(x) {
    const v = x || { name: '', description: '', team: {}, leader: '', implementer: '', reviewers: [], max_fix_rounds: 2, budget_usd: 0, isolate: false };
    const ids = agentIds();
    const sel = (name, val, label) => `<div><label class="lbl" for="tp-${name}">${esc(label)}</label><select id="tp-${name}" name="${name}">${opt('', t('tk.f.none'), !val)}${ids.map(i => opt(i, agentLabel(i), i === val)).join('')}</select></div>`;
    const d = dialog({
      title: x?.id ? `${t('tk.edit')}: ${x.name}` : t('tk.ps.new'), wide: true,
      body: html`<form class="tk-form">
        <div class="tk-grid"><div><label class="lbl" for="tpName">${esc(t('tk.tpl.name'))}</label><input id="tpName" class="input" name="name" maxlength="80" required value="${esc(v.name)}"></div>
        <div><label class="lbl" for="tpDesc">${esc(t('tk.tpl.desc'))}</label><input id="tpDesc" class="input" name="description" maxlength="300" value="${esc(v.description || '')}"></div></div>
        <div class="tk-grid">${sel('leader', v.leader, t('tk.f.leader'))}${TEAM_SLOTS.map(s => sel('team:' + s, v.team?.[s], `${t('tk.f.team')} · ${s}`)).join('')}${sel('implementer', v.implementer, t('tk.ps.implementer'))}</div>
        <div><span class="lbl">${esc(t('tk.f.reviewers'))}</span><div class="row-wrap">${ids.filter(i => cap(i, 'review')).map(i => `<label class="check tk-pick"><input type="checkbox" name="rev" value="${esc(i)}"${(v.reviewers || []).includes(i) ? ' checked' : ''}>${chip(i)}</label>`).join('')}</div></div>
        <div class="tk-grid">
          <div><label class="lbl" for="tpRounds">${esc(t('tk.ps.rounds'))}</label><input id="tpRounds" class="input" type="number" min="0" max="5" name="max_fix_rounds" value="${esc(v.max_fix_rounds ?? 2)}"></div>
          <div><label class="lbl" for="tpBudget">${esc(t('tk.ps.budget'))}</label><input id="tpBudget" class="input" type="number" min="0" max="1000" step="0.5" name="budget_usd" value="${esc(v.budget_usd ?? 0)}"></div>
        </div>
        <label class="check"><input type="checkbox" name="isolate"${v.isolate ? ' checked' : ''}>${esc(t('tk.f.isolate'))}</label>
        <div class="tk-dlg-f"><button type="submit" class="btn btn-primary">${esc(t('tk.save'))}</button></div>
      </form>`
    });
    d.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const team = {};
      for (const s of TEAM_SLOTS) { const a = String(f.get('team:' + s) || ''); if (a) team[s] = a; }
      const body = {
        name: String(f.get('name') || '').trim(), description: String(f.get('description') || '').trim(), team,
        leader: String(f.get('leader') || ''), implementer: String(f.get('implementer') || ''), reviewers: f.getAll('rev').map(String),
        max_fix_rounds: Number(f.get('max_fix_rounds') || 0), budget_usd: Number(f.get('budget_usd') || 0), isolate: f.has('isolate')
      };
      if (x?.id) body.id = x.id;
      if (!body.name) { toast(t('tk.needTitle'), 'warn'); return; }
      try { await post('preset_save', body); toast(t('tk.saved'), 'ok'); d.close(); await loadLibrary(); paint(); } catch (err) { fail(err); }
    });
  }
  async function exportLibrary() {
    try {
      const r = await get('library_export');
      const blob = new Blob([JSON.stringify(r.library, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `maw-library-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { fail(e); }
  }
  async function importLibrary(file) {
    if (!file) return;
    let library;
    try { library = JSON.parse(await file.text()); } catch (e) { fail(e); return; }
    const overwrite = await confirmDlg(t('tk.overwrite') + '?', { danger: false, ok: t('tk.overwrite') });
    try {
      const r = await post('library_import', { library, overwrite });
      toast(t('tk.imported', { a: r.imported?.templates ?? 0, b: r.imported?.presets ?? 0 }), 'ok');
      if (r.skipped?.length) toast(t('tk.skipped', { x: r.skipped.slice(0, 5).join('; ') }), 'warn');
      await loadLibrary(); paint();
    } catch (e) { fail(e); }
  }

  // ---------- Auto Run ----------
  // Shared form for "how to run" (mode / agent / role / preset); also used by schedules.
  function runFields(v, prefix) {
    const ids = agentIds();
    return html`<div class="tk-grid">
      <div><label class="lbl" for="${prefix}Mode">${esc(t('tk.f.mode'))}</label><select id="${prefix}Mode" name="mode">${MODES.filter(m => m !== 'chat').map(m => opt(m, m, m === v.mode)).join('')}</select></div>
      <div><label class="lbl" for="${prefix}Agent">${esc(t('tk.f.agent'))}</label><select id="${prefix}Agent" name="agent">${ids.map(i => opt(i, agentLabel(i), i === v.agent)).join('')}</select></div>
      <div><label class="lbl" for="${prefix}Role">${esc(t('tk.f.role'))}</label><select id="${prefix}Role" name="role">${ROLES.map(r => opt(r, r, r === v.role)).join('')}</select></div>
      <div><label class="lbl" for="${prefix}Preset">${esc(t('tk.f.preset'))}</label><select id="${prefix}Preset" name="preset_id">${opt('', t('tk.f.none'), !v.preset_id)}${(S.presets || []).map(p => opt(p.id, p.name, p.id === v.preset_id)).join('')}</select></div>
    </div>`;
  }
  const defAgent = () => agentIds().includes('claude') ? 'claude' : agentIds()[0] || '';

  async function paintAutoRun(body) {
    const p = curProject();
    if (!p) { body.innerHTML = `<div class="card"><div class="empty">${esc(t('tk.ar.pickProject'))}</div></div>`; return; }
    if (!S.presets) await loadLibrary();
    if (S.files === null) {
      body.innerHTML = `<div class="empty">${esc(t('tk.loading'))}</div>`;
      try {
        const [a, b] = await Promise.all([get('playbook_list', { project_path: p.path }), get('playbook_runs', { project_path: p.path })]);
        S.files = a; S.runs = b.runs || [];
      } catch (e) { S.files = { files: [], dir: '', error: errMsg(e) }; S.runs = []; }
      if (S.tab !== 'autorun') return;
    }
    const files = S.files.files || [];
    const pb = S.playbook;
    const itemsHtml = pb.items ? pb.items.map(i => `<li class="${i.checked ? 'is-done' : ''}"><span class="tk-box" aria-hidden="true">${i.checked ? '☑' : '☐'}</span><span>${esc(i.text)}</span>${i.section ? `<span class="faint sub">· ${esc(i.section)}</span>` : ''}</li>`).join('') : '';
    const pending = pb.items ? pb.items.filter(i => !i.checked).length : 0;
    const busy = S.runs.some(r => r.status === 'running' && r.file === pb.file);
    body.innerHTML = html`<div class="grid g-split">
      <section class="card"><div class="card-h"><h2>${esc(t('tk.ar.files'))}</h2><span class="meta mono truncate" title="${esc(S.files.dir || '')}">${esc(S.files.dir || '')}</span></div>
        ${S.files.error ? `<div class="empty t-err">${esc(S.files.error)}</div>` : files.length ? `<div class="list">${files.map(f => `<button type="button" class="item tk-file-i${pb.file === f.file ? ' is-active' : ''}" data-file="${esc(f.file)}"><span class="truncate"><b>${esc(f.name)}</b></span><span class="bar"><i style="width:${f.total ? Math.round(f.done / f.total * 100) : 0}%"></i></span><span class="sub">${esc(t('tk.ar.items', { done: f.done, total: f.total }))}</span></button>`).join('')}</div>`
          : `<div class="empty">${esc(t('tk.ar.noFiles', { dir: S.files.dir || '.maw/playbooks' }))}</div>`}
        <div class="card-b tk-other"><label class="lbl" for="arOther">${esc(t('tk.ar.other'))}</label><div class="row"><input id="arOther" class="input mono" placeholder="docs\\plan.md" value="${esc(pb.file && !files.some(f => f.file === pb.file) ? pb.file : '')}"><button type="button" class="btn btn-sm" data-ar="preview">${esc(t('tk.ar.preview'))}</button></div></div>
      </section>
      <section class="card"><div class="card-h"><h2>${esc(pb.file ? pb.file.split(/[\\/]/).pop() : t('tk.ar.run'))}</h2>${pb.items ? `<span class="meta">${esc(t('tk.ar.items', { done: pb.items.length - pending, total: pb.items.length }))}</span>` : ''}</div>
        <div class="card-b stack">
          <p class="sub">${esc(t('tk.ar.fresh'))}</p>
          ${pb.items ? `<ol class="tk-pb">${itemsHtml}</ol>` : ''}
          ${pb.items && pending ? `<form class="tk-form tk-ar-form">${runFields({ mode: 'task', agent: defAgent(), role: 'backend' }, 'ar')}
            <fieldset class="tk-fs"><legend class="lbl">${esc(t('tk.ar.onFail'))}</legend><div class="row-wrap"><label class="check"><input type="radio" name="on_failure" value="stop" checked>${esc(t('tk.ar.stop'))}</label><label class="check"><input type="radio" name="on_failure" value="continue">${esc(t('tk.ar.continue'))}</label></div></fieldset>
            <div><label class="lbl" for="arPrefix">${esc(t('tk.ar.prefix'))}</label><input id="arPrefix" class="input" name="prefix" maxlength="2000"></div>
            <div class="tk-dlg-f">${busy ? `<span class="sub">${esc(t('tk.ar.busy'))}</span>` : ''}<button type="submit" class="btn btn-primary"${busy ? ' disabled' : ''}>▶ ${esc(t('tk.ar.run'))} (${pending})</button></div></form>` : ''}
        </div>
      </section>
    </div>
    ${runsHtml()}`;

    const preview = file => previewPlaybook(file, true);
    body.querySelectorAll('[data-file]').forEach(b => b.onclick = () => preview(b.dataset.file));
    body.querySelector('[data-ar="preview"]').onclick = () => { const v = body.querySelector('#arOther').value.trim(); if (v) preview(v); };
    wireRuns(body);
    body.querySelector('.tk-ar-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const req = { project_path: p.path, file: pb.file, on_failure: String(f.get('on_failure') || 'stop'), prefix: String(f.get('prefix') || '') };
      for (const k of ['mode', 'agent', 'role', 'preset_id']) req[k] = String(f.get(k) || '');
      try {
        const r = await post('playbook_run', req);
        toast(t('tk.ar.started', { n: (r.tasks || []).length }), 'ok');
        S.files = null; refresh(true); paint();
      } catch (err) { fail(err); }
    });
  }

  async function previewPlaybook(file, repaint) {
    const p = curProject(); if (!p) return;
    try { const r = await get('playbook_preview', { project_path: p.path, file }); S.playbook = { file: r.file || file, items: r.items || [] }; }
    catch (e) { fail(e); S.playbook = { file: '', items: null }; }
    if (repaint) paint();
  }
  function runsHtml() {
    return html`<section class="card tk-runs"><div class="card-h"><h2>${esc(t('tk.ar.runs'))}</h2></div>
      ${S.runs.length ? `<div class="list">${S.runs.map(r => `<div class="item"><div class="row-wrap"><b class="truncate">${esc(String(r.file || '').split(/[\\/]/).pop())}</b>${runBadge(r.status)}<span class="sub" title="${esc(absTime(r.created_at))}">${esc(rel(r.created_at))}</span><span class="badge">${esc(r.on_failure)}</span><span class="sub">${esc(t('tk.ar.items', { done: (r.items || []).filter(i => i.state === 'done').length, total: (r.items || []).length }))}</span><span class="spacer"></span>${r.status === 'running' ? `<button type="button" class="btn btn-sm btn-danger" data-stop="${esc(r.id)}">${esc(t('tk.ar.stopRun'))}</button>` : ''}</div>
        <div class="tk-run-items">${(r.items || []).map(i => `<span class="tk-ri st-${esc(i.state)}" title="${esc(i.text)} · ${esc(i.state)}"></span>`).join('')}</div></div>`).join('')}</div>` : `<div class="empty">${esc(t('tk.ar.noRuns'))}</div>`}
    </section>`;
  }
  function wireRuns(body) {
    body.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => {
      if (!await confirmDlg(t('tk.ar.confirmStop'), { ok: t('tk.ar.stopRun') })) return;
      try { await post('playbook_stop', { run_id: b.dataset.stop }); S.files = null; paint(); refresh(true); } catch (e) { fail(e); }
    });
  }

  // ---------- schedules ----------
  async function paintSchedules(body) {
    if (S.schedules === null) {
      body.innerHTML = `<div class="empty">${esc(t('tk.loading'))}</div>`;
      try { S.schedules = (await get('schedule_list')).schedules || []; } catch (e) { S.schedules = []; fail(e); }
      if (!S.presets) await loadLibrary();
      if (S.tab !== 'schedules') return;
    }
    const list = S.schedules;
    body.innerHTML = html`<section class="card"><div class="card-h"><h2>${esc(t('tk.tab.schedules'))}</h2>
        <span class="meta row-wrap"><button type="button" class="btn btn-sm" data-sq="nightly">+ ${esc(t('tk.sc.qNightly'))}</button><button type="button" class="btn btn-sm" data-sq="security">+ ${esc(t('tk.sc.qSecurity'))}</button><button type="button" class="btn btn-sm btn-primary" data-sq="new">+ ${esc(t('tk.sc.new'))}</button></span></div>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('tk.tpl.name'))}</th><th>${esc(t('tk.sc.when'))}</th><th>${esc(t('tk.sc.action'))}</th><th>${esc(t('tk.sc.next'))}</th><th>${esc(t('tk.sc.last'))}</th><th></th></tr></thead><tbody>
        ${list.map(s => `<tr><td><label class="check"><input type="checkbox" data-en="${esc(s.id)}"${s.enabled ? ' checked' : ''} aria-label="${esc(t('tk.sc.enabled'))}"><b>${esc(s.name)}</b></label></td><td class="mono">${esc(s.when)}</td>
          <td>${s.action?.type === 'playbook' ? `<span class="badge">playbook</span> <span class="sub">${esc(String(s.action.file || '').split(/[\\/]/).pop())}</span>` : `<span class="badge">${esc(s.action?.card?.mode || 'task')}</span> <span class="sub">${esc(s.action?.card?.title || '')}</span>`} <span class="faint sub">${esc(projName(s.action?.project_path || s.action?.card?.project_path))}</span></td>
          <td title="${esc(absTime(s.next_run_at))}">${s.enabled ? esc(rel(s.next_run_at)) : '—'}</td><td title="${esc(s.last_result || '')}"><span class="sub">${esc(rel(s.last_run_at))}</span>${s.last_result ? `<div class="faint sub truncate tk-lr">${esc(s.last_result)}</div>` : ''}</td>
          <td class="num"><button type="button" class="btn btn-sm" data-sr="${esc(s.id)}">${esc(t('tk.sc.runNow'))}</button> <button type="button" class="btn btn-sm" data-se="${esc(s.id)}">${esc(t('tk.edit'))}</button> <button type="button" class="btn btn-sm btn-danger" data-sd="${esc(s.id)}">${esc(t('tk.delete'))}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${esc(t('tk.sc.empty'))}</div>`}</section>`;
    const reload = async () => { S.schedules = null; paint(); };
    body.querySelectorAll('[data-sq]').forEach(b => b.onclick = () => {
      const p = curProject()?.path || projects()[0]?.path || '';
      const q = b.dataset.sq;
      if (q === 'new') return scheduleDialog(null);
      const reviewers = agentIds().filter(i => cap(i, 'review')).slice(0, 2);
      scheduleDialog(q === 'nightly'
        ? { name: t('tk.sc.qNightly'), enabled: true, when: 'daily 02:00', skip_if_running: true, action: { type: 'card', card: { title: t('tk.sc.qNightly'), prompt: t('tk.sc.nightlyPrompt'), project_path: p, mode: 'council', reviewers } } }
        : { name: t('tk.sc.qSecurity'), enabled: true, when: 'weekly mon 03:00', skip_if_running: true, action: { type: 'card', card: { title: t('tk.sc.qSecurity'), prompt: t('tk.sc.securityPrompt'), project_path: p, mode: 'task', agent: defAgent(), role: 'reviewer' } } });
    });
    body.querySelectorAll('[data-en]').forEach(b => b.onchange = async () => {
      const s = list.find(x => x.id === b.dataset.en);
      try { await post('schedule_save', { ...strip(s), enabled: b.checked }); } catch (e) { fail(e); }
      reload();
    });
    body.querySelectorAll('[data-sr]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { const r = await post('schedule_run_now', { id: b.dataset.sr }); toast(String(r.result || r.schedule?.last_result || t('tk.saved')), 'ok'); refresh(true); } catch (e) { fail(e); }
      reload();
    });
    body.querySelectorAll('[data-se]').forEach(b => b.onclick = () => scheduleDialog(list.find(x => x.id === b.dataset.se)));
    body.querySelectorAll('[data-sd]').forEach(b => b.onclick = async () => {
      const s = list.find(x => x.id === b.dataset.sd);
      if (!await confirmDlg(t('tk.confirmDeleteItem', { x: s.name }))) return;
      try { await post('schedule_delete', { id: s.id }); } catch (e) { fail(e); }
      reload();
    });
  }
  const runBadge = s => `<span class="badge ${{ running: 'b-warn', done: 'b-ok', failed: 'b-err' }[s] || ''}">${s === 'running' ? '<span class="dot warn live"></span>' : ''}${esc(s)}</span>`;
  const strip = s => { const o = { ...s }; delete o.last_run_at; delete o.next_run_at; delete o.last_result; return o; };
  function parseWhen(w) {
    let m = /^daily (\d{2}:\d{2})$/.exec(w || ''); if (m) return { kind: 'daily', time: m[1], day: 'mon', minutes: 60 };
    m = /^weekly ([a-z]{3}) (\d{2}:\d{2})$/.exec(w || ''); if (m) return { kind: 'weekly', day: m[1], time: m[2], minutes: 60 };
    m = /^every (\d+) minutes?$/.exec(w || ''); if (m) return { kind: 'every', minutes: Number(m[1]), time: '02:00', day: 'mon' };
    return { kind: 'daily', time: '02:00', day: 'mon', minutes: 60 };
  }
  function scheduleDialog(s) {
    const v = s || { name: '', enabled: true, when: 'daily 02:00', skip_if_running: true, action: { type: 'card', card: { project_path: curProject()?.path || '', mode: 'task', agent: defAgent(), role: 'backend', title: '', prompt: '' } } };
    const st = { w: parseWhen(v.when), type: v.action?.type || 'card' };
    const card = v.action?.card || {};
    const act = v.action || {};
    const box = document.createElement('div');
    const d = dialog({ title: s?.id ? `${t('tk.edit')}: ${s.name}` : t('tk.sc.new'), body: box, wide: true });
    const projSel = (val, name, id) => `<select id="${id}" name="${name}">${projects().map(p => opt(p.path, p.name, p.path === val)).join('')}</select>`;
    const draw = () => {
      const w = st.w;
      box.innerHTML = html`<form class="tk-form">
        <div class="tk-grid"><div><label class="lbl" for="scName">${esc(t('tk.tpl.name'))}</label><input id="scName" class="input" name="name" maxlength="80" required value="${esc(v.name)}"></div>
          <label class="check tk-align"><input type="checkbox" name="enabled"${v.enabled !== false ? ' checked' : ''}>${esc(t('tk.sc.enabled'))}</label></div>
        <div><span class="lbl">${esc(t('tk.sc.when'))}</span><div class="tk-grid">
          <select name="kind" aria-label="${esc(t('tk.sc.when'))}">${['daily', 'weekly', 'every'].map(k => opt(k, t('tk.sc.' + k), w.kind === k)).join('')}</select>
          ${w.kind === 'weekly' ? `<select name="day" aria-label="${esc(t('tk.sc.day'))}">${DAYS.map(x => opt(x, x, x === w.day)).join('')}</select>` : ''}
          ${w.kind !== 'every' ? `<input class="input" type="time" name="time" value="${esc(w.time)}" aria-label="${esc(t('tk.sc.time'))}" required>` : `<input class="input" type="number" min="5" max="1440" name="minutes" value="${esc(w.minutes)}" aria-label="${esc(t('tk.sc.minutes'))}">`}
        </div></div>
        <div><span class="lbl">${esc(t('tk.sc.action'))}</span><div class="seg"><button type="button" data-ty="card" aria-pressed="${st.type === 'card'}">${esc(t('tk.sc.card'))}</button><button type="button" data-ty="playbook" aria-pressed="${st.type === 'playbook'}">${esc(t('tk.sc.playbook'))}</button></div></div>
        ${st.type === 'card' ? `<div class="tk-grid"><div><label class="lbl" for="scTitle">${esc(t('tk.f.title'))}</label><input id="scTitle" class="input" name="title" maxlength="200" value="${esc(card.title || '')}"></div><div><label class="lbl" for="scProj">${esc(t('tk.f.project'))}</label>${projSel(card.project_path, 'project_path', 'scProj')}</div></div>
          <div><label class="lbl" for="scPrompt">${esc(t('tk.f.prompt'))}</label><textarea id="scPrompt" name="prompt" rows="5" maxlength="20000">${esc(card.prompt || '')}</textarea></div>
          ${runFields({ mode: card.mode || 'task', agent: card.agent || defAgent(), role: card.role || 'backend', preset_id: card.preset_id }, 'sc')}`
        : `<div class="tk-grid"><div><label class="lbl" for="scProj">${esc(t('tk.f.project'))}</label>${projSel(act.project_path || curProject()?.path, 'project_path', 'scProj')}</div><div><label class="lbl" for="scFile">${esc(t('tk.sc.file'))}</label><input id="scFile" class="input mono" name="file" value="${esc(act.file || '')}" placeholder=".maw\\playbooks\\nightly.md"></div></div>
          ${runFields({ mode: act.mode || 'task', agent: act.agent || defAgent(), role: act.role || 'backend', preset_id: act.preset_id }, 'sc')}
          <div><label class="lbl" for="scFail">${esc(t('tk.ar.onFail'))}</label><select id="scFail" name="on_failure">${opt('stop', t('tk.ar.stop'), act.on_failure !== 'continue')}${opt('continue', t('tk.ar.continue'), act.on_failure === 'continue')}</select></div>`}
        <label class="check"><input type="checkbox" name="skip_if_running"${v.skip_if_running !== false ? ' checked' : ''}>${esc(t('tk.sc.skip'))}</label>
        <div class="tk-dlg-f"><button type="submit" class="btn btn-primary">${esc(t('tk.save'))}</button></div>
      </form>`;
      const form = box.querySelector('form');
      const keep = () => { // keep typed values across redraws
        const f = new FormData(form);
        v.name = String(f.get('name') || v.name); v.enabled = f.has('enabled'); v.skip_if_running = f.has('skip_if_running');
        st.w = { kind: String(f.get('kind') || st.w.kind), day: String(f.get('day') || st.w.day), time: String(f.get('time') || st.w.time), minutes: Number(f.get('minutes') || st.w.minutes) };
        const tgt = st.type === 'card' ? card : act;
        for (const k of ['title', 'prompt', 'project_path', 'mode', 'agent', 'role', 'preset_id', 'file', 'on_failure']) if (f.has(k)) tgt[k] = String(f.get(k));
      };
      form.querySelector('[name="kind"]').onchange = () => { keep(); draw(); };
      form.querySelectorAll('[data-ty]').forEach(b => b.onclick = () => { keep(); st.type = b.dataset.ty; draw(); });
      form.addEventListener('submit', async e => {
        e.preventDefault(); keep();
        const w = st.w;
        const when = w.kind === 'every' ? `every ${Math.max(5, Math.min(1440, w.minutes || 60))} minutes` : w.kind === 'weekly' ? `weekly ${w.day} ${w.time}` : `daily ${w.time}`;
        const action = st.type === 'card'
          ? { type: 'card', card: { ...card, status: 'queued', ...(card.mode === 'council' && !card.reviewers?.length ? { reviewers: agentIds().filter(i => cap(i, 'review')).slice(0, 2) } : {}) } }
          : { type: 'playbook', project_path: act.project_path, file: act.file, mode: act.mode, agent: act.agent, role: act.role, preset_id: act.preset_id || '', on_failure: act.on_failure || 'stop' };
        if (st.type === 'card' && (!card.title || !card.prompt)) { toast(t('tk.needTitle'), 'warn'); return; }
        const body = { name: v.name.trim(), enabled: v.enabled, when, skip_if_running: v.skip_if_running, action };
        if (s?.id) body.id = s.id;
        try { await post('schedule_save', body); toast(t('tk.saved'), 'ok'); d.close(); S.schedules = null; paint(); } catch (err) { fail(err); }
      });
    };
    draw();
  }

  // ---------- limits ----------
  function paintLimits(body) {
    const c = S.config, sc = S.scheduler;
    body.innerHTML = html`<section class="card tk-limits"><div class="card-h"><h2>${esc(t('tk.lim.title'))}</h2>${sc?.pid ? `<span class="meta">${esc(t('tk.lim.owner', { pid: sc.pid, x: rel(sc.last_tick_at) }))}</span>` : ''}</div>
      <form class="card-b tk-form">
        <p class="sub">${esc(t('tk.lim.info'))}</p>
        <div class="tk-grid"><div><label class="lbl" for="lmMax">${esc(t('tk.lim.global'))}</label><input id="lmMax" class="input" type="number" min="1" max="16" name="max_parallel" value="${esc(c.max_parallel ?? 3)}"></div></div>
        <div><span class="lbl">${esc(t('tk.lim.perAgent'))}</span><div class="tk-grid">${agentIds().map(id => `<label class="tk-inline">${chip(id)}<input class="input" type="number" min="0" max="16" name="pa:${esc(id)}" value="${esc(c.per_agent?.[id] ?? '')}" placeholder="∞"></label>`).join('')}</div></div>
        <label class="check"><input type="checkbox" name="paused"${c.paused ? ' checked' : ''}>${esc(t('tk.lim.paused'))}</label>
        <div class="tk-dlg-f"><button type="submit" class="btn btn-primary">${esc(t('tk.save'))}</button></div>
      </form></section>`;
    body.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const per_agent = {};
      for (const [k, v] of f.entries()) if (k.startsWith('pa:') && String(v).trim() !== '') per_agent[k.slice(3)] = Number(v);
      try { const r = await post('task_config_save', { max_parallel: Number(f.get('max_parallel') || 3), per_agent, paused: f.has('paused') }); S.config = r.config || S.config; toast(t('tk.saved'), 'ok'); refresh(true); } catch (err) { fail(err); }
    });
  }

  // ---------- "Add to board" on the live job ----------
  M.addJobAction({
    id: 'tk-to-card',
    label: () => t('tk.toCard'),
    when: j => ['DONE', 'FAILED', 'CANCELLED'].includes(j.status),
    run: j => {
      const row = (M.state.data?.jobs || []).find(x => x.job_id === j.id) || {};
      const p = projects().find(x => x.name === row.project_name)?.path || curProject()?.path;
      const mode = MODES.includes(row.mode) ? row.mode : 'task';
      M.showView('board');
      openCard(null, { mode, agent: agentIds().includes(row.agent) ? row.agent : defAgent(), role: ROLES.includes(row.role) ? row.role : 'backend', project_path: p || '', title: `${row.agent || ''} ${row.role || ''} · ${j.id}`.trim() });
    }
  });

  // ---------- extension point for feat-github.js (and other streams) ----------
  window.MAW_BOARD = {
    addCardAction(a) { if (a?.id && !S.cardActions.some(x => x.id === a.id)) S.cardActions.push(a); },
    addToolbarButton(b) { if (b?.id && !S.toolbar.some(x => x.id === b.id)) { S.toolbar.push(b); if (S.visible && S.tab === 'board') paint(); } },
    refresh: () => refresh(true),
    openCard: id => openCard(id),
    newCard: prefill => { M.showView('board'); return openCard(null, prefill); },
    get tasks() { return structuredClone(S.tasks); },
    confirm: confirmDlg,
    dialog,
    chip
  };
  document.dispatchEvent(new CustomEvent('maw-board-ready'));
})();
