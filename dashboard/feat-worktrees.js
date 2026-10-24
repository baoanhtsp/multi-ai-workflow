// S1 — B1 worktrees + merge, #3 fork a job, N2 best-of-N, V8 git panel (specs/s1-design.md §2–§5, §7).
// Uses window.MAWS1 (modal / diff viewer) from feat-checkpoints.js.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { api, t, toast, esc, badge } = M;
  const S = () => window.MAWS1;
  const enc = encodeURIComponent;
  const ROLES = ['backend', 'frontend', 'architect', 'leader', 'reviewer', 'tester'];

  M.addI18n('vi', {
    wtTab: 'Worktree', wtViewList: 'Worktree', wtViewBo: 'Best-of-N', wtViewGit: 'Git',
    wtViewClean: 'Dọn dẹp', wtGuardChecks: 'Cổng kiểm thử (S4) đang đỏ nên merge bị chặn. Sửa lỗi hoặc dùng override của S4 rồi merge lại.',
    clScan: 'Quét', clNotScanned: 'Bấm Quét để xem những gì có thể dọn (chưa xoá gì cả).', clEmpty: 'Không có gì cần dọn.',
    clKind_merged_branch: 'Nhánh đã merge', clKind_kept_worktree: 'Worktree đã merge, hết hạn giữ', clKind_orphan_worktree: 'Worktree mồ côi',
    clKind_stale_worktree: 'Worktree lâu không dùng', clKind_stale_branch: 'Nhánh chưa merge, lâu không dùng', clKind_checkpoint_excess: 'Checkpoint vượt giới hạn',
    clKind_checkpoint_orphan: 'Checkpoint của thư mục đã mất', clKind_trash_expired: 'Bản sao lưu đã hết hạn',
    clRisky: 'rủi ro', clDirty: 'chưa commit', clMerged: 'đã merge', clAll: 'Chọn cả nhóm',
    clSelected: '{n} mục đã chọn · thu hồi {size}', clApply: 'Dọn dẹp…', clConfirmTitle: 'Xác nhận dọn dẹp',
    clConfirmQ: 'Xoá {n} mục dưới đây? Không hoàn tác được, trừ nhánh chưa merge và worktree có thay đổi (được sao lưu vào refs/maw/trash).',
    clRiskyAck: 'Tôi hiểu {n} mục là nhánh chưa merge hoặc có thay đổi chưa commit; chúng được sao lưu {d} ngày rồi mới mất hẳn.',
    clDone: 'Đã xoá {n} mục, thu hồi {size}.', clSkipped: 'Bỏ qua {n} mục', clLastScan: 'Quét lúc {t}',
    clSettings: 'Cài đặt dọn dẹp', clKeepDays: 'Giữ worktree sau khi merge (ngày, 0 = xoá ngay)', clStaleDays: 'Coi là lâu không dùng sau (ngày)', clSave: 'Lưu', clSaved: 'Đã lưu cài đặt dọn dẹp.',
    clTrash: 'Thùng rác (bản sao lưu nhánh)', clTrashEmpty: 'Thùng rác trống.', clRestore: 'Khôi phục', clRestored: 'Đã khôi phục nhánh {b}.', clExpires: 'hết hạn {t}',
    clRestoreQ: 'Tạo lại nhánh {b} từ bản sao lưu {r}?', clProject: 'Dọn dẹp…',
    wtNew: 'Worktree mới', wtRunIso: 'Chạy cô lập', wtShowAll: 'Cả đã merge / huỷ', wtEmpty: 'Chưa có worktree nào cho dự án này.',
    wtBase: 'Nhánh gốc', wtName: 'Tên (tuỳ chọn)', wtNameHint: 'chữ thường, số, . _ -', wtCreate: 'Tạo',
    wtCreated: 'Đã tạo {branch}.', wtCopied: 'Đã chép {n} tệp từ .worktreeinclude.', wtSetupFail: 'Script .maw/setup.ps1 lỗi (exit {code}).',
    wtAhead: '↑{n}', wtBehind: '↓{n}', wtDirty: '{n} chưa commit', wtPort: 'cổng {n}', wtMissing: 'thư mục đã mất',
    wtDiff: 'Diff', wtRunHere: 'Chạy job ở đây', wtMerge: 'Merge', wtDiscard: 'Huỷ bỏ', wtDiffTitle: 'Diff {branch} so với {base}',
    wtStrategy: 'Cách merge', wtMsg: 'Commit message (tuỳ chọn)', wtOwner: 'Chủ sở hữu (SPEC Guard)', wtOwnerAuto: 'tự động (agent của job)',
    wtRemove: 'Xoá worktree và nhánh sau khi merge', wtMergeNote: 'Thay đổi chưa commit trong worktree sẽ được commit trước. SPEC Guard kiểm tra diff của nhánh trước khi merge; một checkpoint an toàn được tạo cho thư mục chính.',
    wtMerged: 'Đã merge {branch} ({commit}).', wtGuardBlock: 'SPEC Guard chặn merge: có tệp ngoài phạm vi của {owner}.', wtMergeAnyway: 'Vẫn merge', wtGuardError: 'Không chạy được SPEC Guard nên merge bị chặn.',
    wtConflicts: 'Xung đột ở {n} tệp. Hai cây thư mục đã được trả về trạng thái sạch.', wtFixWith: 'Sửa xung đột bằng', wtFix: 'Giao agent sửa',
    wtFixStarted: 'Đã giao {agent} sửa xung đột (job {id}). Merge lại khi job xong.',
    wtDiscardQ: 'Huỷ worktree <b>{branch}</b>? Thư mục bị xoá; trạng thái cuối được giữ ở ref <code>refs/maw/discarded/{id}</code>.',
    wtDelBranch: 'Xoá luôn nhánh', wtDiscarded: 'Đã huỷ {branch}. Giữ lại ở {ref}.',
    wtAgent: 'Agent', wtRole: 'Vai trò', wtModel: 'Model', wtModelDef: 'mặc định', wtPrompt: 'Yêu cầu', wtStart: 'Bắt đầu',
    wtJobStarted: 'Đã chạy job {id} trong {branch}.', wtNotInstalled: 'chưa cài', wtNeedPrompt: 'Hãy nhập yêu cầu.',
    fkTitle: 'Fork job {id}', fkAction: 'Fork job', fkBase: 'Bắt đầu từ', fkBaseProject: 'HEAD của dự án (làm lại từ đầu)', fkBaseResult: 'kết quả của job này',
    fkNote: 'Hướng dẫn thêm (tuỳ chọn)', fkNoteHint: 'Ví dụ: dùng cách khác, tránh lỗi ở lần trước…', fkStarted: 'Đã fork thành job {id}.',
    fkInfo: 'Job mới chạy trong một worktree riêng, cùng yêu cầu cũ cộng với tóm tắt kết quả lần trước.',
    boNew: 'Chạy Best-of-N mới', boPrompt: 'Yêu cầu (giao cho mọi ứng viên)', boCands: 'Ứng viên (2–4)', boAdd: '+ Thêm ứng viên', boRemove: 'Bỏ',
    boJudge: 'Giám khảo', boJudgeCouncil: 'Council', boJudgeTests: 'Test', boJudgeBoth: 'Cả hai', boReviewers: 'Reviewer của Council', boStart: 'Chạy {n} ứng viên',
    boStarted: 'Đã chạy Best-of-N {id} với {n} ứng viên.', boEmpty: 'Chưa có lượt Best-of-N nào.', boNeed: 'Cần 2–4 ứng viên và một yêu cầu.',
    boState_running: 'đang chạy', boState_judging: 'đang chấm', boState_done: 'xong', boState_picked: 'đã chọn', boState_cancelled: 'đã huỷ',
    boJob: 'Job', boTests: 'Test', boCouncil: 'Council', boCost: 'Chi phí', boTime: 'Thời gian', boSize: 'Diff', boWinner: 'Thắng', boPick: 'Merge bản này',
    boPickQ: 'Merge ứng viên #{i} ({agent}) vào {base}?', boDiscardOthers: 'Huỷ các worktree còn lại', boPicked: 'Đã merge ứng viên #{i}.', boCancel: 'Dừng lượt này',
    boCancelQ: 'Dừng các job còn chạy của lượt {id}? Worktree được giữ lại.', boCancelled: 'Đã dừng lượt {id}.',
    boT_pass: 'đạt', boT_fail: 'trượt', boT_none: 'không có', boT_running: 'đang chạy', boT_error: 'lỗi',
    gtTarget: 'Thư mục', gtMain: 'thư mục chính', gtBranch: 'Nhánh', gtPull: 'Pull', gtPush: 'Push', gtSwitch: 'Chuyển nhánh', gtCreate: 'Tạo nhánh',
    gtNewName: 'tên nhánh mới', gtSwitchAfter: 'chuyển sang', gtChanges: 'Thay đổi chưa commit', gtLog: 'Commit gần đây', gtNoLog: 'Chưa có commit.',
    gtPullQ: 'Pull (fast-forward only) cho {branch}?', gtPushQ: 'Push {branch} lên {remote}? Không bao giờ dùng --force.', gtSwitchQ: 'Chuyển {dir} sang nhánh {branch}?', gtDone: 'Xong: {what}.'
  });
  M.addI18n('en', {
    wtTab: 'Worktrees', wtViewList: 'Worktrees', wtViewBo: 'Best-of-N', wtViewGit: 'Git',
    wtViewClean: 'Cleanup', wtGuardChecks: 'The test gate (S4) is red, so the merge is blocked. Fix the checks or use S4\'s override, then merge again.',
    clScan: 'Scan', clNotScanned: 'Press Scan to see what can be cleaned up (nothing is deleted yet).', clEmpty: 'Nothing to clean up.',
    clKind_merged_branch: 'Merged branches', clKind_kept_worktree: 'Merged worktrees past their keep time', clKind_orphan_worktree: 'Orphan worktrees',
    clKind_stale_worktree: 'Stale worktrees', clKind_stale_branch: 'Stale unmerged branches', clKind_checkpoint_excess: 'Checkpoints over the limit',
    clKind_checkpoint_orphan: 'Checkpoints of removed folders', clKind_trash_expired: 'Expired backups',
    clRisky: 'risky', clDirty: 'uncommitted', clMerged: 'merged', clAll: 'Select group',
    clSelected: '{n} selected · {size} reclaimed', clApply: 'Clean up…', clConfirmTitle: 'Confirm cleanup',
    clConfirmQ: 'Delete these {n} items? This cannot be undone, except unmerged branches and worktrees with changes (backed up to refs/maw/trash).',
    clRiskyAck: 'I understand {n} items are unmerged branches or have uncommitted work; they are backed up for {d} days, then gone for good.',
    clDone: 'Deleted {n} items, {size} reclaimed.', clSkipped: 'Skipped {n} items', clLastScan: 'Scanned {t}',
    clSettings: 'Cleanup settings', clKeepDays: 'Keep worktrees after merge (days, 0 = remove at once)', clStaleDays: 'Stale after (days)', clSave: 'Save', clSaved: 'Cleanup settings saved.',
    clTrash: 'Trash (branch backups)', clTrashEmpty: 'Trash is empty.', clRestore: 'Restore', clRestored: 'Restored branch {b}.', clExpires: 'expires {t}',
    clRestoreQ: 'Recreate branch {b} from backup {r}?', clProject: 'Clean up…',
    wtNew: 'New worktree', wtRunIso: 'Run isolated', wtShowAll: 'Include merged / discarded', wtEmpty: 'No worktrees for this project yet.',
    wtBase: 'Base branch', wtName: 'Name (optional)', wtNameHint: 'lower-case letters, digits, . _ -', wtCreate: 'Create',
    wtCreated: 'Created {branch}.', wtCopied: 'Copied {n} files from .worktreeinclude.', wtSetupFail: '.maw/setup.ps1 failed (exit {code}).',
    wtAhead: '↑{n}', wtBehind: '↓{n}', wtDirty: '{n} uncommitted', wtPort: 'port {n}', wtMissing: 'folder missing',
    wtDiff: 'Diff', wtRunHere: 'Run job here', wtMerge: 'Merge', wtDiscard: 'Discard', wtDiffTitle: 'Diff {branch} vs {base}',
    wtStrategy: 'Strategy', wtMsg: 'Commit message (optional)', wtOwner: 'Owner (SPEC Guard)', wtOwnerAuto: 'auto (the job\'s agent)',
    wtRemove: 'Remove the worktree and branch after merging', wtMergeNote: 'Uncommitted work in the worktree is committed first. SPEC Guard checks the branch diff before merging; a safety checkpoint of the main checkout is taken.',
    wtMerged: 'Merged {branch} ({commit}).', wtGuardBlock: 'SPEC Guard blocked the merge: files outside {owner}\'s scope.', wtMergeAnyway: 'Merge anyway', wtGuardError: 'SPEC Guard could not run, so the merge was blocked.',
    wtConflicts: 'Conflicts in {n} files. Both trees were returned to a clean state.', wtFixWith: 'Fix conflicts with', wtFix: 'Hand to agent',
    wtFixStarted: '{agent} is fixing the conflicts (job {id}). Merge again when it is done.',
    wtDiscardQ: 'Discard worktree <b>{branch}</b>? The folder is deleted; its final state is kept at <code>refs/maw/discarded/{id}</code>.',
    wtDelBranch: 'Delete the branch too', wtDiscarded: 'Discarded {branch}. Kept at {ref}.',
    wtAgent: 'Agent', wtRole: 'Role', wtModel: 'Model', wtModelDef: 'default', wtPrompt: 'Prompt', wtStart: 'Start',
    wtJobStarted: 'Job {id} started in {branch}.', wtNotInstalled: 'not installed', wtNeedPrompt: 'Enter a prompt.',
    fkTitle: 'Fork job {id}', fkAction: 'Fork job', fkBase: 'Start from', fkBaseProject: 'project HEAD (fresh attempt)', fkBaseResult: 'this job\'s result',
    fkNote: 'Extra instructions (optional)', fkNoteHint: 'e.g. try another approach, avoid the earlier error…', fkStarted: 'Forked as job {id}.',
    fkInfo: 'The new job runs in its own worktree with the same prompt plus a summary of the previous result.',
    boNew: 'New best-of-N run', boPrompt: 'Prompt (given to every candidate)', boCands: 'Candidates (2–4)', boAdd: '+ Add candidate', boRemove: 'Remove',
    boJudge: 'Judge', boJudgeCouncil: 'Council', boJudgeTests: 'Tests', boJudgeBoth: 'Both', boReviewers: 'Council reviewers', boStart: 'Run {n} candidates',
    boStarted: 'Best-of-N {id} started with {n} candidates.', boEmpty: 'No best-of-N runs yet.', boNeed: 'Needs 2–4 candidates and a prompt.',
    boState_running: 'running', boState_judging: 'judging', boState_done: 'done', boState_picked: 'picked', boState_cancelled: 'cancelled',
    boJob: 'Job', boTests: 'Tests', boCouncil: 'Council', boCost: 'Cost', boTime: 'Time', boSize: 'Diff', boWinner: 'Winner', boPick: 'Merge this one',
    boPickQ: 'Merge candidate #{i} ({agent}) into {base}?', boDiscardOthers: 'Discard the other worktrees', boPicked: 'Merged candidate #{i}.', boCancel: 'Stop this run',
    boCancelQ: 'Stop the running jobs of run {id}? The worktrees are kept.', boCancelled: 'Stopped run {id}.',
    boT_pass: 'pass', boT_fail: 'fail', boT_none: 'none', boT_running: 'running', boT_error: 'error',
    gtTarget: 'Folder', gtMain: 'main checkout', gtBranch: 'Branch', gtPull: 'Pull', gtPush: 'Push', gtSwitch: 'Switch branch', gtCreate: 'Create branch',
    gtNewName: 'new branch name', gtSwitchAfter: 'switch to it', gtChanges: 'Uncommitted changes', gtLog: 'Recent commits', gtNoLog: 'No commits yet.',
    gtPullQ: 'Pull (fast-forward only) into {branch}?', gtPushQ: 'Push {branch} to {remote}? --force is never used.', gtSwitchQ: 'Switch {dir} to branch {branch}?', gtDone: 'Done: {what}.'
  });

  // ---------- helpers ----------
  const q = (action, params) => S().q(action, params);
  const agentMap = () => M.agents() || {};
  const agentList = filter => Object.entries(agentMap()).map(([id, a]) => ({ id, ...a })).filter(a => a.enabled !== false && (!filter || filter(a)));
  const canWrite = a => !a.capabilities || a.capabilities.write !== false;
  const canReview = a => !a.capabilities || a.capabilities.review !== false;
  const label = id => agentMap()[id]?.label || id;
  const statusBadge = s => s ? badge(s, s === 'RUNNING' ? 'b-info' : s === 'DONE' ? 'b-ok' : /FAIL|ERROR/.test(s) ? 'b-err' : s === 'CANCELLED' ? 'b-warn' : '') : '';
  const agentOptions = (sel, filter) => agentList(filter).map(a => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.label || a.id)}${a.installed === false ? ' (' + esc(t('wtNotInstalled')) + ')' : ''}</option>`).join('');
  const modelOptions = (agentId, sel) => `<option value="">${esc(t('wtModelDef'))}</option>` + (agentMap()[agentId]?.models || []).map(m => `<option value="${esc(m)}"${m === sel ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const roleOptions = sel => ROLES.map(r => `<option value="${r}"${r === sel ? ' selected' : ''}>${r}</option>`).join('');
  const defaultAgent = () => (agentList(a => canWrite(a) && a.installed !== false)[0] || agentList(canWrite)[0] || {}).id || '';
  // An agent <select data-s1-agent="k"> keeps the model <select data-s1-model="k"> next to it in sync.
  function wireAgentModel(root) {
    root.addEventListener('change', e => {
      const a = e.target.closest('[data-s1-agent]');
      if (!a) return;
      const m = root.querySelector(`[data-s1-model="${a.dataset.s1Agent}"]`);
      if (m) m.innerHTML = modelOptions(a.value, '');
    });
  }
  const branchList = () => (M.state.git?.branches || []).map(b => typeof b === 'string' ? b : b?.name).filter(Boolean);
  const branchDatalist = id => `<datalist id="${id}">${branchList().map(b => `<option value="${esc(b)}">`).join('')}</datalist>`;
  const dur = s => { s = Math.round(Number(s) || 0); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`; };
  const money = v => v == null ? '—' : '$' + Number(v).toFixed(Number(v) < 1 ? 3 : 2);
  const bytes = v => { if (v == null) return '—'; let n = Number(v) || 0, u = 0; const U = ['B', 'KB', 'MB', 'GB']; while (n >= 1024 && u < 3) { n /= 1024; u++; } return `${n.toFixed(u ? 1 : 0)} ${U[u]}`; };
  const CL_KINDS = ['merged_branch', 'kept_worktree', 'orphan_worktree', 'checkpoint_excess', 'checkpoint_orphan', 'trash_expired', 'stale_worktree', 'stale_branch'];
  // Jobs started by S1 actions run outside the main Run button; show them in the live job box when the page offers it.
  function watch(r, msg) {
    toast(msg, 'ok');
    if (typeof M.watchJob === 'function' && r?.job_id) { try { M.watchJob(r); } catch (e) { console.error('[s1 watchJob]', e); } }
  }
  function guardHtml(g) {
    if (!g) return '';
    const v = Array.isArray(g.violations) ? g.violations : [];
    const rows = v.map(x => `<li><span class="s1-mono">${esc(typeof x === 'string' ? x : (x.path || x.file || JSON.stringify(x)))}</span>${x && typeof x === 'object' && (x.reason || x.message) ? ` — ${esc(x.reason || x.message)}` : ''}</li>`).join('');
    return (g.reason ? `<div class="s1-warn">${esc(String(g.reason))}</div>` : '') + (g.error ? `<pre class="s1-out">${esc(String(g.error).slice(-4000))}</pre>` : '') + (rows ? `<ul class="s1-filelist">${rows}</ul>` : '') + (g.output ? `<pre class="s1-out">${esc(String(g.output).slice(-4000))}</pre>` : '');
  }

  // ---------- state ----------
  const W = {
    project: '', view: 'list', list: [], all: false, at: 0, loading: false, error: '',
    bo: { runs: [], at: 0, loading: false, error: '', timer: null },
    git: { target: '', info: null, log: [], at: 0, loading: false, error: '', out: '' },
    cl: { data: null, sel: new Set(), loading: false, error: '', trash: [], cfg: null, skipped: [], ver: 0 }
  };
  try { W.view = ['list', 'bo', 'git', 'clean'].includes(localStorage.getItem('maw_s1_view')) ? localStorage.getItem('maw_s1_view') : 'list'; } catch {}
  let tab = null;
  const visible = () => tab && !tab.panel.classList.contains('hidden');
  const proj = () => M.project()?.path || '';

  function syncProject() {
    const p = proj();
    if (p === W.project) return false;
    W.project = p; W.list = []; W.at = 0; W.error = '';
    W.bo.runs = []; W.bo.at = 0; W.git.target = p; W.git.info = null; W.git.log = []; W.git.at = 0; W.git.out = '';
    W.cl.data = null; W.cl.sel = new Set(); W.cl.error = ''; W.cl.trash = []; W.cl.skipped = [];
    return true;
  }

  async function loadList(force) {
    if (!W.project || W.loading || (!force && Date.now() - W.at < 10000)) return;
    W.loading = true;
    const p = W.project;
    try {
      const r = await api(q('worktree_list', { project_path: p, include: W.all ? 'all' : '' }));
      if (p !== W.project) return;
      W.list = Array.isArray(r.worktrees) ? r.worktrees : [];
      W.error = '';
    } catch (e) { W.error = e.message; W.list = []; }
    finally { W.loading = false; W.at = Date.now(); paint(); }
  }
  async function loadBo(force) {
    const B = W.bo;
    if (!W.project || B.loading || (!force && Date.now() - B.at < 10000)) return;
    B.loading = true;
    const p = W.project;
    try {
      const r = await api(q('bestof_list', { project_path: p }));
      if (p !== W.project) return;
      const runs = Array.isArray(r.runs) ? r.runs : [];
      // The list may hold summaries; fetch full runs for the active / incomplete ones.
      await Promise.all(runs.slice(0, 6).map(async (run, i) => {
        if (Array.isArray(run.candidates) && run.candidates.every(c => c.job_id) && !['running', 'judging'].includes(run.state)) return;
        try { const s = await api(q('bestof_status', { id: run.id })); runs[i] = s.run || s; } catch {}
      }));
      B.runs = runs; B.error = '';
    } catch (e) { B.error = e.message; B.runs = []; }
    finally { B.loading = false; B.at = Date.now(); paint(); }
  }
  async function loadGit(force) {
    const G = W.git;
    const dir = G.target || W.project;
    if (!dir || G.loading || (!force && Date.now() - G.at < 10000)) return;
    G.loading = true;
    try {
      const [info, log] = await Promise.all([
        api(q('git_info', { project_path: dir })).catch(e => ({ error: e.message })),
        api(q('git_log', { project_path: dir, limit: 20 }))
      ]);
      if (dir !== (G.target || W.project)) return;
      G.info = info.git_info || null; G.log = Array.isArray(log.commits) ? log.commits : []; G.error = info.error || '';
    } catch (e) { G.error = e.message; G.log = []; }
    finally { G.loading = false; G.at = Date.now(); paint(); }
  }
  // C1 cleanup: preview is a dry run; nothing is deleted before cleanup_apply.
  async function loadClean() {
    const C = W.cl, p = W.project;
    if (!p || C.loading) return;
    C.loading = true; C.ver++; paint();
    try {
      const [prev, trash, cfg] = await Promise.all([
        api(q('cleanup_preview', { project_path: p })),
        api(q('cleanup_trash', { project_path: p })).catch(() => ({ items: [] })),
        api('cleanup_config').catch(() => null)
      ]);
      if (p !== W.project) return;
      C.data = prev;
      C.sel = new Set((prev.candidates || []).filter(c => c.default_selected && !c.risky && !c.protected).map(c => c.id));
      C.trash = Array.isArray(trash.items) ? trash.items : Array.isArray(trash.trash) ? trash.trash : [];
      C.cfg = cfg?.config || cfg;
      C.error = '';
    } catch (e) { C.error = e.message; C.data = null; }
    finally { C.loading = false; C.ver++; paint(); }
  }
  async function cleanupConfig() {
    if (!W.cl.cfg) { try { const r = await api('cleanup_config'); W.cl.cfg = r.config || r; } catch {} }
    return W.cl.cfg || {};
  }
  function refresh(force) {
    syncProject();
    if (!visible() && !force) return;
    if (W.view === 'list') loadList(force);
    if (W.view === 'bo') loadBo(force);
    if (W.view === 'git') { loadGit(force); if (!W.list.length) loadList(force); }
    if (W.view === 'clean' && force && W.cl.data) loadClean();
  }
  // Active best-of-N runs are polled every 5 s while their view is open.
  function pollBo() {
    const active = W.bo.runs.filter(r => ['running', 'judging'].includes(r.state));
    if (!visible() || W.view !== 'bo' || !active.length) return;
    Promise.all(active.map(r => api(q('bestof_status', { id: r.id })).then(s => {
      const i = W.bo.runs.findIndex(x => x.id === r.id);
      if (i >= 0) W.bo.runs[i] = s.run || s;
    }).catch(() => {}))).then(paint);
  }

  // ---------- painting ----------
  function paint() {
    if (!tab) return;
    const panel = tab.panel;
    if (!panel.dataset.s1) {
      panel.dataset.s1 = '1';
      panel.innerHTML = `<div class="s1-bar"><div class="seg s1-nav" role="tablist" data-wt="nav"></div><span class="s1-sp"></span><span data-wt="tools" class="s1-row"></span></div>
        <div class="s1-sec" data-wt="body"></div>`;
      panel.addEventListener('click', onClick);
      panel.addEventListener('change', onChange);
    }
    const active = M.state.data?.feature_data?.worktrees?.active;
    tab.setCount(Number.isFinite(active) ? active : W.list.filter(w => w.status === 'active').length);
    const byProj = M.state.data?.feature_data?.worktrees?.cleanup?.by_project || {};
    const clCount = Object.entries(byProj).find(([k]) => k.toLowerCase() === W.project.toLowerCase())?.[1] || 0;
    panel.querySelector('[data-wt="nav"]').innerHTML = [['list', 'wtViewList'], ['bo', 'wtViewBo'], ['git', 'wtViewGit'], ['clean', 'wtViewClean']]
      .map(([v, k]) => `<button type="button" data-wt-view="${v}" aria-pressed="${W.view === v}">${esc(t(k))}${v === 'clean' && clCount ? ` <span class="count">${esc(clCount)}</span>` : ''}</button>`).join('');
    const tools = panel.querySelector('[data-wt="tools"]');
    const body = panel.querySelector('[data-wt="body"]');
    if (W.view !== 'clean') delete body.dataset.clKey;
    if (!W.project) { tools.innerHTML = ''; body.innerHTML = `<div class="empty">${esc(t('s1PickProject'))}</div>`; return; }
    if (W.view === 'list') {
      tools.innerHTML = `<label class="s1-check"><input type="checkbox" data-wt="all"${W.all ? ' checked' : ''}> ${esc(t('wtShowAll'))}</label>
        <button type="button" class="btn btn-sm" data-wt="new">${esc(t('wtNew'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-wt="iso">${esc(t('wtRunIso'))}</button>
        <button type="button" class="btn btn-sm" data-wt="refresh">${esc(t('s1Refresh'))}</button>`;
      body.innerHTML = paintList();
    } else if (W.view === 'bo') {
      tools.innerHTML = `<button type="button" class="btn btn-sm" data-wt="refresh">${esc(t('s1Refresh'))}</button>`;
      paintBo(body);
    } else if (W.view === 'git') {
      tools.innerHTML = `<button type="button" class="btn btn-sm" data-wt="refresh">${esc(t('s1Refresh'))}</button>`;
      paintGit(body);
    } else {
      tools.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-cl="scan"${W.cl.loading ? ' disabled' : ''}>${esc(W.cl.loading ? t('s1Loading') : t('clScan'))}</button>`;
      paintClean(body);
    }
  }

  function paintClean(body) {
    const C = W.cl, d = C.data;
    const key = `${C.ver}|${M.lang}|${C.loading}|${W.project}`;
    if (body.dataset.clKey === key) { paintCleanSum(); return; }
    body.dataset.clKey = key;
    const cands = d?.candidates || [];
    let html = '';
    if (C.error) html += `<div class="s1-errbox">${esc(C.error)}</div>`;
    else if (!d) html += `<div class="empty">${esc(C.loading ? t('s1Loading') : t('clNotScanned'))}</div>`;
    else if (!cands.length) html += `<div class="empty">${esc(t('clEmpty'))}</div>`;
    else {
      html += `<div class="sub" style="margin-bottom:8px">${esc(t('clLastScan', { t: S().absTime(d.scanned_at) }))}</div>`;
      for (const kind of CL_KINDS.concat([...new Set(cands.map(c => c.kind))].filter(k => !CL_KINDS.includes(k)))) {
        const items = cands.filter(c => c.kind === kind);
        if (!items.length) continue;
        const sel = items.filter(c => C.sel.has(c.id)).length;
        html += `<section class="s1-clg"><div class="s1-clg-h"><label class="s1-check"><input type="checkbox" data-cl-group="${esc(kind)}"${sel === items.length ? ' checked' : ''}${items.some(c => c.protected) ? ' disabled' : ''} aria-label="${esc(t('clAll'))}"></label>
            <b>${esc(t('clKind_' + kind) === 'clKind_' + kind ? kind : t('clKind_' + kind))}</b> <span class="count">${items.length}</span>
            <span class="s1-sp"></span><span class="sub">${esc(bytes(items.reduce((a, c) => a + (Number(c.size_bytes) || 0), 0)))}</span></div>
          <ul class="s1-cll">${items.map(c => `<li${c.risky ? ' class="is-risky"' : ''}>
            <label class="s1-cli"><input type="checkbox" data-cl-item="${esc(c.id)}"${C.sel.has(c.id) ? ' checked' : ''}${c.protected ? ' disabled' : ''}>
              <span class="s1-cli-main"><span class="s1-mono">${esc(c.name)}</span>
                ${c.merged ? badge(t('clMerged'), 'b-ok') : ''}${c.risky ? badge(t('clRisky'), 'b-err') : ''}${c.dirty ? badge(t('clDirty'), 'b-warn') : ''}
                <span class="s1-cli-sub">${esc(c.reason || '')}${c.last_commit_at ? ` · <span title="${esc(S().absTime(c.last_commit_at))}">${esc(S().relTime(c.last_commit_at))}</span>` : ''}${c.path ? ` · <span class="s1-mono">${esc(c.path)}</span>` : ''}</span></span>
              <span class="s1-cli-size">${esc(bytes(c.size_bytes))}${c.size_approx ? '+' : ''}</span></label></li>`).join('')}</ul></section>`;
      }
      html += `<div class="s1-clfoot"><span data-cl="sum"></span><span class="s1-sp"></span><button type="button" class="btn btn-primary btn-danger-solid" data-cl="apply">${esc(t('clApply'))}</button></div>`;
    }
    if (C.skipped.length) html += `<div class="s1-warn" style="margin-top:10px"><b>${esc(t('clSkipped', { n: C.skipped.length }))}</b><ul class="s1-filelist" style="margin-top:6px">${C.skipped.map(x => `<li><span class="s1-mono">${esc(x.id)}</span> — ${esc(x.reason || '')}</li>`).join('')}</ul></div>`;
    const cfg = C.cfg || {};
    html += `<details class="s1-launch" style="margin-top:14px"><summary>${esc(t('clSettings'))}</summary>
        <div class="s1-grid2"><div><label class="lbl" for="s1ClKeep">${esc(t('clKeepDays'))}</label><input class="input" id="s1ClKeep" type="number" min="0" max="90" value="${esc(cfg.keep_after_merge_days ?? 0)}"></div>
          <div><label class="lbl" for="s1ClStale">${esc(t('clStaleDays'))}</label><input class="input" id="s1ClStale" type="number" min="1" max="365" value="${esc(cfg.stale_branch_days ?? 14)}"></div></div>
        <div class="s1-row"><span style="flex:1"></span><button type="button" class="btn btn-sm" data-cl="save">${esc(t('clSave'))}</button></div></details>
      <div class="section-title" style="margin-top:14px">${esc(t('clTrash'))}</div>
      ${C.trash.length ? `<ul class="s1-log">${C.trash.map(x => `<li><span class="s1-mono">${esc(x.branch || x.ref)}</span><span class="s1-subj" title="${esc(x.ref)}">${esc(x.last_commit_subject || x.ref)}</span>
          <span class="s1-meta">${x.expires_at ? esc(t('clExpires', { t: S().relTime(x.expires_at) })) : ''} <button type="button" class="btn btn-sm" data-cl-restore="${esc(x.ref)}" data-b="${esc(x.branch || '')}">${esc(t('clRestore'))}</button></span></li>`).join('')}</ul>`
        : `<div class="empty">${esc(d ? t('clTrashEmpty') : '')}</div>`}`;
    body.innerHTML = html;
    paintCleanSum();
  }
  function paintCleanSum() {
    const el = tab?.panel.querySelector('[data-cl="sum"]');
    if (!el) return;
    const cands = W.cl.data?.candidates || [];
    const chosen = cands.filter(c => W.cl.sel.has(c.id));
    el.textContent = t('clSelected', { n: chosen.length, size: bytes(chosen.reduce((a, c) => a + (Number(c.size_bytes) || 0), 0)) });
    const btn = tab.panel.querySelector('[data-cl="apply"]');
    if (btn) btn.disabled = !chosen.length;
  }
  async function applyClean() {
    const C = W.cl, project = W.project;
    const chosen = (C.data?.candidates || []).filter(c => C.sel.has(c.id));
    if (!chosen.length) return;
    const risky = chosen.filter(c => c.risky || c.dirty);
    const trashDays = C.cfg?.trash_days ?? 30;
    const html = `<p style="margin:0">${esc(t('clConfirmQ', { n: chosen.length }))}</p>
      <ul class="s1-filelist">${chosen.map(c => `<li><span class="s1-mono">${esc(c.name)}</span>${c.risky ? badge(t('clRisky'), 'b-err') : ''}${c.dirty ? badge(t('clDirty'), 'b-warn') : ''}<span style="margin-left:auto">${esc(bytes(c.size_bytes))}</span></li>`).join('')}</ul>
      ${risky.length ? `<label class="s1-check s1-errbox" style="display:flex"><input type="checkbox" id="s1ClAck"> ${esc(t('clRiskyAck', { n: risky.length, d: trashDays }))}</label>` : ''}`;
    await S().openModal({ title: t('clConfirmTitle'), html, buttons: [{ id: 'ok', label: t('clApply').replace('…', ''), cls: 'btn-primary btn-danger-solid' }],
      onOpen: (body, dlg) => {
        const ack = body.querySelector('#s1ClAck'), ok = dlg.querySelector('[data-act="ok"]');
        if (ack && ok) { ok.disabled = true; ack.addEventListener('change', () => { ok.disabled = !ack.checked; }); }
      },
      onAction: async () => {
        const r = await api('cleanup_apply', { project_path: project, items: chosen.map(c => c.id), confirm: true, confirm_risky: risky.map(c => c.id) });
        const deleted = Array.isArray(r.deleted) ? r.deleted : [];
        C.skipped = Array.isArray(r.skipped) ? r.skipped : [];
        toast(t('clDone', { n: deleted.length, size: bytes(r.freed_bytes || 0) }), deleted.length ? 'ok' : 'warn');
        W.at = 0; loadClean();
      } });
  }

  function paintList() {
    if (W.error) return `<div class="s1-errbox">${esc(W.error)}</div>`;
    if (!W.list.length) return `<div class="empty">${esc(W.at ? t('wtEmpty') : t('s1Loading'))}</div>`;
    return `<div class="s1-cards">${W.list.map(w => {
      const L = w.live || {}, on = w.status === 'active';
      const facts = [
        `${esc(t('wtBase'))}: <span class="s1-mono">${esc(w.base || '')}</span>`,
        L.ahead != null ? `${esc(t('wtAhead', { n: L.ahead }))} ${esc(t('wtBehind', { n: L.behind ?? 0 }))}` : '',
        L.additions != null ? `${S().pm(L)} ${esc(t('s1Files', { n: L.files ?? 0 }))}` : '',
        L.dirty ? esc(t('wtDirty', { n: L.dirty })) : '',
        w.port ? esc(t('wtPort', { n: w.port })) : '',
        `<span title="${esc(S().absTime(w.created_at))}">${esc(S().relTime(w.created_at))}</span>`
      ].filter(Boolean).map(x => `<span>${x}</span>`).join('');
      return `<article class="s1-wt${on ? '' : ' is-off'}">
        <div class="s1-wt-h"><span class="dot ${L.job_status === 'RUNNING' ? 'live ok' : on ? 'ok' : ''}"></span><b class="s1-mono">${esc(w.branch)}</b>
          ${badge(w.origin || 'manual')}${on ? '' : badge(w.status, w.status === 'merged' ? 'b-ok' : w.status === 'creating' ? 'b-info' : 'b-warn')}${L.exists === false ? badge(t('wtMissing'), 'b-err') : ''}${statusBadge(L.job_status)}</div>
        <div class="s1-wt-s">${facts}</div>
        ${w.job_id ? `<div class="s1-wt-s"><span>${esc(t('boJob'))}: <span class="s1-mono">${esc(w.job_id)}</span></span>${w.owner ? `<span>${esc(label(w.owner))}</span>` : ''}</div>` : ''}
        <div class="s1-wt-p s1-mono">${esc(w.worktree_path || '')}</div>
        ${on ? `<div class="s1-wt-a">
          <button type="button" class="btn btn-sm" data-wt-diff="${esc(w.id)}">${esc(t('wtDiff'))}</button>
          <button type="button" class="btn btn-sm" data-wt-run="${esc(w.id)}"${L.job_status === 'RUNNING' ? ' disabled' : ''}>${esc(t('wtRunHere'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-wt-merge="${esc(w.id)}"${L.job_status === 'RUNNING' ? ' disabled' : ''}>${esc(t('wtMerge'))}</button>
          <button type="button" class="btn btn-sm btn-danger" data-wt-discard="${esc(w.id)}">${esc(t('wtDiscard'))}</button></div>` : ''}
      </article>`;
    }).join('')}</div>`;
  }

  // The launcher keeps its own DOM between repaints so typing is never lost.
  let launcher = null;
  function buildLauncher() {
    const el = document.createElement('details');
    el.className = 's1-launch';
    el.open = true;
    const revDefault = M.state.data?.defaults?.council || ['claude', 'codex'];
    const writers = agentList(a => canWrite(a) && a.installed !== false).map(a => a.id);
    const pick = i => writers[i] || writers[0] || defaultAgent();
    el.innerHTML = `<summary>${esc(t('boNew'))}</summary>
      <div><label class="lbl" for="s1BoPrompt">${esc(t('boPrompt'))}</label><textarea class="input" id="s1BoPrompt" rows="4" maxlength="20000"></textarea></div>
      <div class="s1-grid2">
        <div><label class="lbl" for="s1BoRole">${esc(t('wtRole'))}</label><select class="input" id="s1BoRole">${roleOptions('backend')}</select></div>
        <div><span class="lbl">${esc(t('boJudge'))}</span><div class="seg" data-bo="judge">
          ${[['council', 'boJudgeCouncil'], ['tests', 'boJudgeTests'], ['both', 'boJudgeBoth']].map(([v, k]) => `<button type="button" data-judge="${v}" aria-pressed="${v === 'both'}">${esc(t(k))}</button>`).join('')}</div></div>
      </div>
      <div><span class="lbl">${esc(t('boCands'))}</span><div class="s1-cands" style="display:grid;gap:6px"></div>
        <button type="button" class="btn btn-sm" data-bo="add" style="margin-top:6px">${esc(t('boAdd'))}</button></div>
      <div data-bo="revbox"><span class="lbl">${esc(t('boReviewers'))}</span><div class="s1-revs">
        ${agentList(canReview).map(a => `<label class="s1-check"><input type="checkbox" value="${esc(a.id)}"${revDefault.includes(a.id) ? ' checked' : ''}> ${esc(a.label || a.id)}</label>`).join('')}</div></div>
      <div class="s1-row"><span class="s1-dlg-err s1-errbox hidden" data-bo="err"></span><span style="flex:1"></span><button type="button" class="btn btn-primary" data-bo="start"></button></div>`;
    const cands = el.querySelector('.s1-cands');
    let seq = 0;
    const addRow = agent => {
      if (cands.children.length >= 4) return;
      const k = 'c' + (++seq);
      const row = document.createElement('div');
      row.className = 's1-cand';
      row.innerHTML = `<span class="n"></span><select class="input" data-s1-agent="${k}" aria-label="${esc(t('wtAgent'))}">${agentOptions(agent, canWrite)}</select>
        <select class="input" data-s1-model="${k}" aria-label="${esc(t('wtModel'))}">${modelOptions(agent, '')}</select>
        <button type="button" class="btn btn-sm" data-bo="rm" aria-label="${esc(t('boRemove'))}">✕</button>`;
      cands.appendChild(row);
      renumber();
    };
    const renumber = () => {
      [...cands.children].forEach((r, i) => { r.querySelector('.n').textContent = '#' + (i + 1); r.querySelector('[data-bo="rm"]').disabled = cands.children.length <= 2; });
      el.querySelector('[data-bo="add"]').disabled = cands.children.length >= 4;
      el.querySelector('[data-bo="start"]').textContent = t('boStart', { n: cands.children.length });
    };
    addRow(pick(0)); addRow(pick(1));
    wireAgentModel(el);
    const judge = () => el.querySelector('[data-judge][aria-pressed="true"]')?.dataset.judge || 'both';
    const syncJudge = () => { el.querySelector('[data-bo="revbox"]').classList.toggle('hidden', judge() === 'tests'); };
    el.addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.judge) { el.querySelectorAll('[data-judge]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); syncJudge(); return; }
      if (b.dataset.bo === 'add') { addRow(pick(cands.children.length)); return; }
      if (b.dataset.bo === 'rm') { b.closest('.s1-cand').remove(); renumber(); return; }
      if (b.dataset.bo !== 'start') return;
      const err = el.querySelector('[data-bo="err"]');
      err.classList.add('hidden');
      const prompt = el.querySelector('#s1BoPrompt').value.trim();
      const candidates = [...cands.children].map(r => {
        const c = { agent: r.querySelector('[data-s1-agent]').value };
        const m = r.querySelector('[data-s1-model]').value;
        if (m) c.model = m;
        return c;
      });
      if (!prompt || candidates.length < 2 || candidates.length > 4) { err.textContent = t('boNeed'); err.classList.remove('hidden'); return; }
      const body = { project_path: W.project, prompt, role: el.querySelector('#s1BoRole').value, candidates, judge: judge() };
      if (body.judge !== 'tests') body.reviewers = [...el.querySelectorAll('[data-bo="revbox"] input:checked')].map(x => x.value);
      b.disabled = true;
      try {
        const r = await api('bestof_start', body);
        const run = r.run || r;
        toast(t('boStarted', { id: run.id || r.id || '', n: candidates.length }), 'ok');
        el.querySelector('#s1BoPrompt').value = '';
        el.open = false;
        W.bo.at = 0; loadBo(true);
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
      finally { b.disabled = false; }
    });
    syncJudge();
    return el;
  }

  function paintBo(body) {
    if (!launcher) launcher = buildLauncher();
    if (launcher.parentElement !== body) { body.innerHTML = ''; body.appendChild(launcher); body.appendChild(document.createElement('div')); }
    const out = body.lastElementChild;
    const B = W.bo;
    if (B.error) { out.innerHTML = `<div class="s1-errbox">${esc(B.error)}</div>`; return; }
    if (!B.runs.length) { out.innerHTML = `<div class="empty">${esc(B.at ? t('boEmpty') : t('s1Loading'))}</div>`; return; }
    out.innerHTML = B.runs.map(run => {
      const cands = Array.isArray(run.candidates) ? run.candidates : [];
      const live = ['running', 'judging'].includes(run.state);
      return `<section class="s1-bo">
        <div class="s1-bo-h">${badge(t('boState_' + run.state) || run.state, live ? 'b-info' : run.state === 'picked' ? 'b-ok' : run.state === 'cancelled' ? 'b-warn' : '')}
          <span class="s1-bo-p" title="${esc(run.prompt || '')}">${esc(run.prompt || run.id)}</span>
          <span class="t-muted">${esc(run.role || '')} · ${esc(t('boJudge'))}: ${esc(run.judge || '')}</span>
          <span class="t-muted" title="${esc(S().absTime(run.created_at))}">${esc(S().relTime(run.created_at))}</span>
          ${live ? `<button type="button" class="btn btn-sm btn-danger" data-bo-cancel="${esc(run.id)}">${esc(t('boCancel'))}</button>` : ''}</div>
        <div class="s1-bo-grid">${cands.map(c => {
          const win = run.winner === c.i && run.state !== 'running';
          const picked = run.picked?.i === c.i;
          const tests = c.tests ? `${badge(t('boT_' + c.tests.status) || c.tests.status, c.tests.status === 'pass' ? 'b-ok' : c.tests.status === 'fail' || c.tests.status === 'error' ? 'b-err' : '')}` : '—';
          const council = c.council ? `${c.council.approved == null ? statusBadge(c.council.status) : badge(c.council.approved ? 'APPROVED' : 'NOT APPROVED', c.council.approved ? 'b-ok' : 'b-err')} ${c.council.score != null ? `<b>${esc(Number(c.council.score).toFixed(1))}</b>/10` : ''}` : '—';
          const verdicts = c.council?.verdicts ? Object.entries(c.council.verdicts).map(([k, v]) => `${k}=${v}`).join(' · ') : '';
          return `<div class="s1-bo-c${win ? ' is-win' : ''}${picked ? ' is-picked' : ''}">
            <div class="s1-bo-top"><span class="s1-rank" title="${esc(win ? t('boWinner') : '')}">${c.rank ? '#' + esc(c.rank) : '—'}</span>
              <b>${esc(label(c.agent))}${c.model ? ' · ' + esc(c.model) : ''}</b>${win ? badge(t('boWinner'), 'b-ok') : ''}</div>
            <dl class="s1-kv">
              <dt>${esc(t('boJob'))}</dt><dd>${statusBadge(c.job_status) || '—'}</dd>
              <dt>${esc(t('boTests'))}</dt><dd>${tests}</dd>
              <dt>${esc(t('boCouncil'))}</dt><dd title="${esc(verdicts)}">${council}</dd>
              <dt>${esc(t('boCost'))}</dt><dd>${esc(money(c.cost_usd))}</dd>
              <dt>${esc(t('boTime'))}</dt><dd>${c.duration_s != null ? esc(dur(c.duration_s)) : '—'}</dd>
              <dt>${esc(t('boSize'))}</dt><dd>${c.diff ? `${S().pm(c.diff)} · ${esc(t('s1Files', { n: c.diff.files ?? 0 }))}` : '—'}</dd>
            </dl>
            <div class="s1-wt-a">
              <button type="button" class="btn btn-sm" data-wt-diff="${esc(c.worktree_id)}"${run.state === 'picked' && !picked ? ' disabled' : ''}>${esc(t('wtDiff'))}</button>
              ${['done', 'judging', 'running'].includes(run.state) && c.job_status && c.job_status !== 'RUNNING' ? `<button type="button" class="btn btn-sm ${win ? 'btn-primary' : ''}" data-bo-pick="${esc(run.id)}" data-i="${esc(c.i)}">${esc(t('boPick'))}</button>` : ''}
            </div></div>`;
        }).join('')}</div></section>`;
    }).join('');
  }

  function paintGit(body) {
    const G = W.git, dir = G.target || W.project;
    const active = W.list.filter(w => w.status === 'active');
    const opts = [`<option value="${esc(W.project)}">${esc(t('gtMain'))} — ${esc(W.project)}</option>`]
      .concat(active.map(w => `<option value="${esc(w.worktree_path)}"${w.worktree_path === dir ? ' selected' : ''}>${esc(w.branch)} — ${esc(w.worktree_path)}</option>`)).join('');
    const info = G.info || {};
    const branches = (info.branches || []).map(b => typeof b === 'string' ? b : b?.name).filter(Boolean);
    const cur = info.current_branch || '';
    body.innerHTML = `
      <div class="s1-git-head"><label class="lbl" for="s1GitDir" style="margin:0">${esc(t('gtTarget'))}</label>
        <select class="input" id="s1GitDir" data-wt="gitdir">${opts}</select>
        ${cur ? `${esc(t('gtBranch'))}: ${badge(cur, 'b-info')}` : ''}${info.ahead ? badge('↑' + info.ahead) : ''}${info.behind ? badge('↓' + info.behind, 'b-warn') : ''}
        ${info.modified_count ? `<button type="button" class="btn btn-sm" data-git="changes">${esc(t('gtChanges'))} (${esc(info.modified_count)})</button>` : ''}</div>
      ${G.error ? `<div class="s1-errbox" style="margin-bottom:10px">${esc(G.error)}</div>` : ''}
      <div class="s1-git-ops">
        <div class="s1-git-op"><button type="button" class="btn btn-sm" data-git="pull">${esc(t('gtPull'))}</button><button type="button" class="btn btn-sm" data-git="push">${esc(t('gtPush'))}</button></div>
        <div class="s1-git-op"><select class="input" data-git="swsel" aria-label="${esc(t('gtBranch'))}">${branches.map(b => `<option${b === cur ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <button type="button" class="btn btn-sm" data-git="switch">${esc(t('gtSwitch'))}</button></div>
        <div class="s1-git-op"><input class="input" data-git="newname" placeholder="${esc(t('gtNewName'))}" maxlength="100" aria-label="${esc(t('gtNewName'))}">
          <label class="s1-check"><input type="checkbox" data-git="newsw" checked> ${esc(t('gtSwitchAfter'))}</label>
          <button type="button" class="btn btn-sm" data-git="create">${esc(t('gtCreate'))}</button></div>
      </div>
      ${G.out ? `<pre class="s1-out" style="margin-bottom:10px">${esc(G.out)}</pre>` : ''}
      <div class="section-title">${esc(t('gtLog'))}</div>
      ${G.log.length ? `<ul class="s1-log">${G.log.map(c => `<li><span class="s1-mono">${esc(c.short_sha || c.short || String(c.sha || '').slice(0, 7))}</span><span class="s1-subj" title="${esc(c.subject || '')}">${esc(c.subject || '')}</span>
        <span class="s1-meta">${esc(c.author || '')} · <span title="${esc(S().absTime(c.date))}">${esc(S().relTime(c.date))}</span></span></li>`).join('')}</ul>`
        : `<div class="empty">${esc(G.loading || !G.at ? t('s1Loading') : t('gtNoLog'))}</div>`}`;
  }

  // ---------- actions ----------
  const byId = id => W.list.find(w => w.id === id);

  async function newWorktree(project) {
    const html = `<div><label class="lbl" for="s1WtBase">${esc(t('wtBase'))}</label><input class="input" id="s1WtBase" list="s1WtBranches" value="${esc(M.state.git?.current_branch || '')}" maxlength="100">${branchDatalist('s1WtBranches')}</div>
      <div><label class="lbl" for="s1WtName">${esc(t('wtName'))}</label><input class="input" id="s1WtName" maxlength="48" pattern="[a-z0-9][a-z0-9._-]*" placeholder="${esc(t('wtNameHint'))}"></div>`;
    await S().openModal({ title: t('wtNew'), size: 'sm', html, buttons: [{ id: 'ok', label: t('wtCreate') }], onAction: async (id, body) => {
      const r = await api('worktree_create', { project_path: project, base: body.querySelector('#s1WtBase').value.trim() || undefined, name: body.querySelector('#s1WtName').value.trim() || undefined });
      const w = r.worktree || {};
      toast(t('wtCreated', { branch: w.branch || '' }), 'ok');
      if (r.copied?.length) toast(t('wtCopied', { n: r.copied.length }), 'info');
      if (r.setup?.ran && r.setup.exit_code !== 0) toast(t('wtSetupFail', { code: r.setup.exit_code }), 'warn');
      W.at = 0; refresh(true);
    } });
  }

  function jobForm({ agent, role = 'backend', withBase, project }) {
    const a = agent || defaultAgent();
    return `<div class="s1-grid2">
        <div><label class="lbl" for="s1JAgent">${esc(t('wtAgent'))}</label><select class="input" id="s1JAgent" data-s1-agent="j">${agentOptions(a, canWrite)}</select></div>
        <div><label class="lbl" for="s1JModel">${esc(t('wtModel'))}</label><select class="input" id="s1JModel" data-s1-model="j">${modelOptions(a, '')}</select></div>
        <div><label class="lbl" for="s1JRole">${esc(t('wtRole'))}</label><select class="input" id="s1JRole">${roleOptions(role)}</select></div>
        ${withBase ? `<div><label class="lbl" for="s1JBase">${esc(t('wtBase'))}</label><input class="input" id="s1JBase" list="s1JBranches" value="${esc(project === proj() ? (M.state.git?.current_branch || '') : '')}" maxlength="100">${branchDatalist('s1JBranches')}</div>` : ''}
      </div>
      <div><label class="lbl" for="s1JPrompt">${esc(t('wtPrompt'))}</label><textarea class="input" id="s1JPrompt" rows="6" maxlength="20000"></textarea></div>`;
  }
  const readJob = body => {
    const o = { mode: 'task', agent: body.querySelector('#s1JAgent').value, role: body.querySelector('#s1JRole').value, prompt: body.querySelector('#s1JPrompt').value.trim() };
    const m = body.querySelector('#s1JModel').value; if (m) o.model = m;
    return o;
  };

  async function runIsolated(project) {
    await S().openModal({ title: t('wtRunIso'), html: jobForm({ withBase: true, project }), buttons: [{ id: 'ok', label: t('wtStart') }],
      onOpen: body => wireAgentModel(body),
      onAction: async (id, body) => {
        const job = readJob(body);
        if (!job.prompt) throw new Error(t('wtNeedPrompt'));
        const base = body.querySelector('#s1JBase').value.trim();
        const r = await api('worktree_job', { ...job, project_path: project, base: base || undefined });
        watch(r, t('wtJobStarted', { id: r.job_id, branch: r.worktree?.branch || '' }));
        W.at = 0; refresh(true);
      } });
  }

  async function runHere(w) {
    await S().openModal({ title: `${t('wtRunHere')} — ${w.branch}`, html: jobForm({ agent: w.owner }), buttons: [{ id: 'ok', label: t('wtStart') }],
      onOpen: body => wireAgentModel(body),
      onAction: async (id, body) => {
        const job = readJob(body);
        if (!job.prompt) throw new Error(t('wtNeedPrompt'));
        await M.runJob({ ...job, project_path: w.worktree_path });
      } });
  }

  // Shared by worktree_merge and bestof_pick: merged → close; SPEC Guard block → offer "merge anyway"; conflicts → offer a fixer.
  function mergeOutcome(r, body, dlg, ctx) {
    const box = body.querySelector('[data-mg="res"]');
    if (r.merged || r.picked) {
      toast(ctx.okMsg(r), 'ok');
      W.at = 0; W.bo.at = 0; refresh(true);
      return true;
    }
    if (r.blocked === 'spec_guard') {
      ctx.force = true;
      box.innerHTML = `<div class="s1-errbox">${esc(r.spec_guard?.error ? t('wtGuardError') : t('wtGuardBlock', { owner: label(r.spec_guard?.owner || ctx.owner || '') || '?' }))}</div>${guardHtml(r.spec_guard)}`;
      const btn = dlg.querySelector('[data-act="ok"]'); if (btn) btn.textContent = t('wtMergeAnyway');
      return false;
    }
    if (r.blocked === 'checks') {
      const items = Array.isArray(r.checks?.items) ? r.checks.items : [];
      box.innerHTML = `<div class="s1-errbox">${esc(t('wtGuardChecks'))}</div>${items.length ? `<ul class="s1-filelist">${items.map(x => `<li>${esc(x.label || x.id || x.name || '')} ${x.status ? badge(x.status, /pass|ok|green/i.test(x.status) ? 'b-ok' : 'b-err') : ''}</li>`).join('')}</ul>` : ''}`;
      return false;
    }
    if (r.blocked === 'conflicts') {
      const files = Array.isArray(r.conflicts) ? r.conflicts : [];
      box.innerHTML = `<div class="s1-errbox">${esc(t('wtConflicts', { n: files.length }))}</div>
        <ul class="s1-filelist">${files.map(f => `<li class="s1-mono">${esc(f)}</li>`).join('')}</ul>
        <div class="s1-row"><label class="lbl" for="s1FixAgent" style="margin:0">${esc(t('wtFixWith'))}</label>
          <select class="input" id="s1FixAgent" style="width:auto;flex:1 1 160px">${agentOptions(ctx.owner || defaultAgent(), canWrite)}</select>
          <button type="button" class="btn btn-sm btn-primary" data-act="fix">${esc(t('wtFix'))}</button></div>`;
      ctx.conflictId = r.fix_hint?.id || ctx.worktreeId;
      return false;
    }
    box.innerHTML = `<div class="s1-errbox">${esc(r.error || r.message || JSON.stringify(r).slice(0, 300))}</div>`;
    return false;
  }
  async function fixConflicts(ctx, body) {
    const agent = body.querySelector('#s1FixAgent').value;
    const r = await api('worktree_fix_conflicts', { id: ctx.conflictId, agent, confirm: true });
    watch(r, t('wtFixStarted', { agent: label(agent), id: r.job_id }));
    W.at = 0; refresh(true);
  }
  function mergeFields(owner) {
    return `<div><span class="lbl">${esc(t('wtStrategy'))}</span><div class="seg" data-mg="strategy">
        ${['merge', 'squash', 'rebase'].map(s => `<button type="button" data-strategy="${s}" aria-pressed="${s === 'squash'}">${s}</button>`).join('')}</div></div>
      <div class="s1-grid2"><div><label class="lbl" for="s1MgMsg">${esc(t('wtMsg'))}</label><input class="input" id="s1MgMsg" maxlength="300"></div>
        <div><label class="lbl" for="s1MgOwner">${esc(t('wtOwner'))}</label><select class="input" id="s1MgOwner"><option value="">${esc(t('wtOwnerAuto'))}</option>${agentOptions(owner)}</select></div></div>`;
  }
  const wireStrategy = body => body.querySelector('[data-mg="strategy"]')?.addEventListener('click', e => {
    const b = e.target.closest('[data-strategy]');
    if (b) body.querySelectorAll('[data-strategy]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  const readStrategy = body => body.querySelector('[data-strategy][aria-pressed="true"]')?.dataset.strategy || 'squash';

  async function mergeWorktree(w) {
    const keepDays = Number((await cleanupConfig()).keep_after_merge_days) || 0;
    const ctx = { force: false, owner: w.owner || '', worktreeId: w.id, okMsg: r => t('wtMerged', { branch: w.branch, commit: String(r.commit || '').slice(0, 7) }) };
    const html = `${mergeFields(w.owner)}
      <label class="s1-check"><input type="checkbox" id="s1MgRemove"${keepDays > 0 ? '' : ' checked'}> ${esc(t('wtRemove'))}</label>
      <div class="sub">${esc(t('wtMergeNote'))}</div><div data-mg="res"></div>`;
    await S().openModal({ title: `${t('wtMerge')} ${w.branch} → ${w.base}`, html, buttons: [{ id: 'ok', label: t('wtMerge') }],
      onOpen: wireStrategy,
      onAction: async (id, body, dlg) => {
        if (id === 'fix') return fixConflicts(ctx, body);
        const owner = body.querySelector('#s1MgOwner').value;
        const r = await api('worktree_merge', { id: w.id, strategy: readStrategy(body), message: body.querySelector('#s1MgMsg').value.trim() || undefined,
          owner: owner || undefined, remove: body.querySelector('#s1MgRemove').checked, force: ctx.force || undefined, confirm: true });
        return mergeOutcome(r, body, dlg, ctx) ? undefined : false;
      } });
  }

  async function discardWorktree(w) {
    const html = `<p style="margin:0">${t('wtDiscardQ', { branch: esc(w.branch), id: esc(w.id) })}</p>
      <label class="s1-check"><input type="checkbox" id="s1DcBranch" checked> ${esc(t('wtDelBranch'))}</label>`;
    await S().openModal({ title: t('wtDiscard'), size: 'sm', html, buttons: [{ id: 'ok', label: t('wtDiscard'), cls: 'btn-primary btn-danger-solid' }], onAction: async (id, body) => {
      const r = await api('worktree_discard', { id: w.id, delete_branch: body.querySelector('#s1DcBranch').checked, confirm: true });
      toast(t('wtDiscarded', { branch: w.branch, ref: r.kept_ref || '' }), 'ok');
      W.at = 0; refresh(true);
    } });
  }

  async function pickCandidate(runId, i) {
    const run = W.bo.runs.find(r => r.id === runId);
    const c = run?.candidates?.find(x => String(x.i) === String(i));
    if (!run || !c) return;
    const ctx = { force: false, owner: c.agent, worktreeId: c.worktree_id, okMsg: () => t('boPicked', { i: c.i }) };
    const html = `<p style="margin:0">${esc(t('boPickQ', { i: c.i, agent: label(c.agent), base: run.base || '' }))}</p>
      ${mergeFields(c.agent)}<label class="s1-check"><input type="checkbox" id="s1BoDiscard" checked> ${esc(t('boDiscardOthers'))}</label>
      <div class="sub">${esc(t('wtMergeNote'))}</div><div data-mg="res"></div>`;
    await S().openModal({ title: t('boPick'), html, buttons: [{ id: 'ok', label: t('wtMerge') }],
      onOpen: wireStrategy,
      onAction: async (id, body, dlg) => {
        if (id === 'fix') return fixConflicts(ctx, body);
        const r = await api('bestof_pick', { id: run.id, candidate: c.i, strategy: readStrategy(body), discard_others: body.querySelector('#s1BoDiscard').checked,
          message: body.querySelector('#s1MgMsg').value.trim() || undefined, owner: body.querySelector('#s1MgOwner').value || undefined, force: ctx.force || undefined, confirm: true });
        return mergeOutcome(r, body, dlg, ctx) ? undefined : false;
      } });
  }

  async function gitOp(kind, dir) {
    const G = W.git, info = G.info || {}, panel = tab.panel;
    const branch = info.current_branch || '';
    let action, body, question;
    if (kind === 'pull') { action = 'git_pull'; body = { project_path: dir }; question = t('gtPullQ', { branch }); }
    if (kind === 'push') { action = 'git_push'; body = { project_path: dir, set_upstream: true }; question = t('gtPushQ', { branch, remote: 'origin' }); }
    if (kind === 'switch') {
      const b = panel.querySelector('[data-git="swsel"]').value;
      if (!b || b === branch) return;
      action = 'git_branch_switch'; body = { project_path: dir, branch: b }; question = t('gtSwitchQ', { dir, branch: b });
    }
    if (kind === 'create') {
      const name = panel.querySelector('[data-git="newname"]').value.trim();
      if (!name) { panel.querySelector('[data-git="newname"]').focus(); return; }
      action = 'git_branch_create'; body = { project_path: dir, name, switch: panel.querySelector('[data-git="newsw"]').checked };
    }
    if (question && !(await S().confirmBox({ title: t('s1Confirm'), html: `<p style="margin:0">${esc(question)}</p>` }))) return;
    if (question) body.confirm = true;
    try {
      const r = await api(action, body);
      G.out = String(r.output || '').trim();
      toast(t('gtDone', { what: action }), 'ok');
    } catch (e) { G.out = String(e.data?.output || e.message); toast(e.message, 'err'); }
    G.at = 0; loadGit(true);
  }

  async function onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.closest('.s1-launch')) return;
    if (b.dataset.wtView) {
      W.view = b.dataset.wtView;
      try { localStorage.setItem('maw_s1_view', W.view); } catch {}
      paint(); refresh(true); return;
    }
    const d = b.dataset;
    if (d.wt === 'refresh') return refresh(true);
    if (d.wt === 'new') return newWorktree(W.project);
    if (d.wt === 'iso') return runIsolated(W.project);
    if (d.wtDiff) {
      const w = byId(d.wtDiff) || { id: d.wtDiff, branch: d.wtDiff, base: '' };
      return S().showDiff(t('wtDiffTitle', { branch: w.branch, base: w.base }), 'worktree_diff', { id: d.wtDiff });
    }
    if (d.wtRun) { const w = byId(d.wtRun); if (w) runHere(w); return; }
    if (d.wtMerge) { const w = byId(d.wtMerge); if (w) mergeWorktree(w); return; }
    if (d.wtDiscard) { const w = byId(d.wtDiscard); if (w) discardWorktree(w); return; }
    if (d.boPick) return pickCandidate(d.boPick, d.i);
    if (d.boCancel) {
      if (!(await S().confirmBox({ title: t('boCancel'), html: `<p style="margin:0">${esc(t('boCancelQ', { id: d.boCancel }))}</p>`, danger: true }))) return;
      try { await api('bestof_cancel', { id: d.boCancel, confirm: true }); toast(t('boCancelled', { id: d.boCancel }), 'ok'); } catch (ex) { toast(ex.message, 'err'); }
      W.bo.at = 0; loadBo(true); return;
    }
    if (d.cl === 'scan') return loadClean();
    if (d.cl === 'apply') return applyClean();
    if (d.cl === 'save') {
      const panel = tab.panel;
      try {
        const r = await api('cleanup_config_save', { keep_after_merge_days: Math.round(Number(panel.querySelector('#s1ClKeep').value)), stale_branch_days: Math.round(Number(panel.querySelector('#s1ClStale').value)) });
        W.cl.cfg = r.config || r; toast(t('clSaved'), 'ok');
      } catch (ex) { toast(ex.message, 'err'); }
      return;
    }
    if (d.clRestore) {
      if (!(await S().confirmBox({ title: t('clRestore'), html: `<p style="margin:0">${esc(t('clRestoreQ', { b: d.b || d.clRestore, r: d.clRestore }))}</p>` }))) return;
      try { const r = await api('cleanup_restore', { project_path: W.project, ref: d.clRestore, confirm: true }); toast(t('clRestored', { b: r.branch || d.b }), 'ok'); loadClean(); }
      catch (ex) { toast(ex.message, 'err'); }
      return;
    }
    if (d.git === 'changes') return S().showDiff(t('gtChanges'), 'git_diff', { project_path: W.git.target || W.project });
    if (d.git) return gitOp(d.git, W.git.target || W.project);
  }
  function onChange(e) {
    const it = e.target.dataset.clItem, grp = e.target.dataset.clGroup;
    if (it) { if (e.target.checked) W.cl.sel.add(it); else W.cl.sel.delete(it); paintCleanSum(); return; }
    if (grp) {
      for (const c of (W.cl.data?.candidates || []).filter(x => x.kind === grp && !x.protected)) { if (e.target.checked) W.cl.sel.add(c.id); else W.cl.sel.delete(c.id); }
      W.cl.ver++; paint(); return;
    }
    if (e.target.dataset.wt === 'all') { W.all = e.target.checked; W.at = 0; loadList(true); }
    if (e.target.dataset.wt === 'gitdir') { W.git.target = e.target.value; W.git.info = null; W.git.log = []; W.git.out = ''; W.git.at = 0; paint(); loadGit(true); }
  }

  // ---------- registration ----------
  tab = M.addTab({ id: 'worktrees', title: () => t('wtTab'), render: () => { if (syncProject()) launcher = null; paint(); refresh(false); } });
  if (tab) tab.button.addEventListener('click', () => refresh(true));
  M.on('project-change', () => { syncProject(); launcher = null; paint(); refresh(true); });
  M.on('job-end', () => { W.at = 0; W.bo.at = 0; refresh(false); });
  M.on('lang', () => { launcher = null; paint(); });
  setInterval(pollBo, 5000);

  const openTab = view => {
    if (view) { W.view = view; try { localStorage.setItem('maw_s1_view', view); } catch {} }
    tab?.button.click();
  };
  M.addProjectAction({ id: 'wt-new', label: () => t('wtNew'), run: p => { openTab('list'); newWorktree(p.path); } });
  M.addProjectAction({ id: 'wt-iso', label: () => t('wtRunIso'), run: p => { openTab('list'); runIsolated(p.path); } });
  M.addProjectAction({ id: 'wt-clean', label: () => t('clProject'), run: () => { openTab('clean'); loadClean(); } });
  M.addProjectAction({ id: 'wt-bestof', label: () => t('wtViewBo') + '…', run: () => { openTab('bo'); setTimeout(() => { if (launcher) { launcher.open = true; launcher.querySelector('#s1BoPrompt')?.focus(); } }, 50); } });

  // #3 Fork a job: same prompt + previous result summary, in a new worktree, optionally on another agent.
  M.addJobAction({
    id: 'wt-fork',
    label: () => t('fkAction'),
    when: j => !!j?.id,
    run: async j => {
      const meta = (M.state.data?.jobs || []).find(x => x.job_id === j.id) || {};
      const html = `<div class="sub">${esc(t('fkInfo'))}</div>
        <div class="s1-grid2">
          <div><label class="lbl" for="s1JAgent">${esc(t('wtAgent'))}</label><select class="input" id="s1JAgent" data-s1-agent="j">${agentOptions(canWrite(agentMap()[meta.agent] || {}) ? meta.agent : defaultAgent(), canWrite)}</select></div>
          <div><label class="lbl" for="s1JModel">${esc(t('wtModel'))}</label><select class="input" id="s1JModel" data-s1-model="j">${modelOptions(meta.agent, '')}</select></div>
          <div><label class="lbl" for="s1JRole">${esc(t('wtRole'))}</label><select class="input" id="s1JRole">${roleOptions(ROLES.includes(meta.role) ? meta.role : 'backend')}</select></div>
          <div><span class="lbl">${esc(t('fkBase'))}</span>
            <label class="s1-check"><input type="radio" name="s1FkBase" value="project" checked> ${esc(t('fkBaseProject'))}</label><br>
            <label class="s1-check"><input type="radio" name="s1FkBase" value="result"> ${esc(t('fkBaseResult'))}</label></div>
        </div>
        <div><label class="lbl" for="s1FkNote">${esc(t('fkNote'))}</label><textarea class="input" id="s1FkNote" rows="3" maxlength="4000" placeholder="${esc(t('fkNoteHint'))}"></textarea></div>`;
      await S().openModal({ title: t('fkTitle', { id: j.id }), html, buttons: [{ id: 'ok', label: t('fkAction') }],
        onOpen: body => wireAgentModel(body),
        onAction: async (id, body) => {
          const req = { job_id: j.id, agent: body.querySelector('#s1JAgent').value, role: body.querySelector('#s1JRole').value,
            base: body.querySelector('input[name="s1FkBase"]:checked')?.value || 'project' };
          const m = body.querySelector('#s1JModel').value; if (m) req.model = m;
          const note = body.querySelector('#s1FkNote').value.trim(); if (note) req.note = note;
          const r = await api('job_fork', req);
          watch(r, t('fkStarted', { id: r.job_id }));
          W.at = 0; refresh(false);
        } });
    }
  });
})();
