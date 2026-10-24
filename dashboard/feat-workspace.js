// S6 — Agent workspace (V1 3-column view, V2 persistent agents, V3 chat, V5 handoffs, V8 context menu, B6 meter).
// Talks to the page only through window.MAW (SPEC §9.0) and to the server through the S6 actions (specs/s6-design.md).
(() => {
  'use strict';
  const M = window.MAW;
  if (!M || M.ws) return;
  const { esc } = M;

  // ---------- i18n ----------
  const L = {
    vi: {
      'ws.view': 'Không gian agent',
      'ws.agents': 'Agent', 'ws.chat': 'Trò chuyện', 'ws.panel': 'Bảng phụ',
      'ws.filter': 'Lọc agent…', 'ws.newAgent': '+ Agent', 'ws.newGroup': '+ Nhóm', 'ws.team': 'Thiết lập đội',
      'ws.ungrouped': 'Chưa có nhóm', 'ws.noAgents': 'Chưa có agent nào. Tạo một agent hoặc thiết lập đội.',
      'ws.pickAgent': 'Chọn một agent ở cột trái để bắt đầu trò chuyện.',
      'ws.noConv': 'Agent này chưa có cuộc trò chuyện.', 'ws.newConv': 'Cuộc trò chuyện mới',
      'ws.st.idle': 'Rảnh', 'ws.st.thinking': 'Đang suy nghĩ', 'ws.st.waiting': 'Đang chờ', 'ws.st.error': 'Lỗi', 'ws.st.needs-login': 'Cần đăng nhập',
      'ws.thinking': '{agent} đang suy nghĩ…', 'ws.compacting': '{agent} đang nén ngữ cảnh…', 'ws.ran': 'đã chạy {t}', 'ws.stop': 'Dừng',
      'ws.queue': '{n} mục đang chờ', 'ws.queueRm': 'Bỏ khỏi hàng đợi',
      'ws.send': 'Gửi', 'ws.enqueue': 'Thêm vào hàng đợi', 'ws.steer': 'Gửi vào phiên đang chạy',
      'ws.ph': 'Nhắn cho {agent}… (Ctrl+Enter để gửi)', 'ws.attach': 'Đính kèm ảnh', 'ws.attachNo': '{p} không nhận ảnh đính kèm.',
      'ws.attachBig': 'Ảnh {name} lớn hơn 150 KB.', 'ws.defModel': 'model mặc định', 'ws.defEffort': 'effort mặc định',
      'ws.queued': 'Đã thêm vào hàng đợi ({n}).', 'ws.steered': 'Đã gửi vào phiên Antigravity đang chạy.',
      'ws.ctx': 'Ngữ cảnh {pct}% · {used}/{win} token', 'ws.compact': 'Nén ngay', 'ws.compactStarted': 'Đang nén ngữ cảnh…',
      'ws.cost': 'Chi phí cuộc trò chuyện', 'ws.files': '{n} tệp đổi', 'ws.noGit': 'không có git',
      'ws.ready': 'Sẵn sàng?', 'ws.log': 'Xem log', 'ws.you': 'Bạn', 'ws.system': 'Hệ thống',
      'ws.tab.handoffs': 'Handoff', 'ws.tab.files': 'Tệp', 'ws.tab.history': 'Lịch sử', 'ws.tab.autorun': 'Auto Run',
      'ws.placeholder': 'Chưa có — cần luồng {s}. Khi tính năng đó được gộp, bảng này tự hiện.',
      'ws.pending': 'ĐANG CHỜ ({n})', 'ws.done': 'Đã xong', 'ws.noHandoffs': 'Chưa có handoff nào cho cuộc trò chuyện này.',
      'ws.summaryTable': 'Bảng tổng kết của Lead (từ bản ghi handoff)',
      'ws.h.role': 'Vai trò', 'ws.h.agent': 'Agent', 'ws.h.status': 'Trạng thái', 'ws.h.time': 'Thời gian', 'ws.h.files': 'Tệp', 'ws.h.cost': 'Chi phí',
      'ws.h.accept': 'Chấp nhận', 'ws.h.retry': 'Chạy lại', 'ws.h.cancel': 'Huỷ', 'ws.h.open': 'Mở chat thành viên', 'ws.h.merge': 'Gộp nhánh',
      'ws.h.evidence': 'Bằng chứng', 'ws.h.blockers': 'Vướng mắc', 'ws.h.scope': 'Ngoài phạm vi ghi', 'ws.h.parse': 'Không đọc được kết quả JSON',
      'ws.h.shared': 'chạy chung thư mục (S1 chưa có)', 'ws.h.isolated': 'worktree riêng', 'ws.h.dispatch': 'Giao việc',
      'ws.h.doneToast': 'Handoff {id} · {agent} {status} ({t}): {sum}', 'ws.h.manual': 'Giao việc thủ công',
      'ws.h.to': 'Cho vai trò', 'ws.h.task': 'Nhiệm vụ', 'ws.h.noTeam': 'Agent này không thuộc đội nào.',
      'ws.hist.empty': 'Chưa có lượt nào.',
      'ws.m.rename': 'Đổi tên', 'ws.m.edit': 'Sửa agent', 'ws.m.role': 'Thiết lập vai trò', 'ws.m.dup': 'Nhân bản',
      'ws.m.bm': 'Đánh dấu', 'ws.m.unbm': 'Bỏ đánh dấu', 'ws.m.move': 'Chuyển nhóm', 'ws.m.gitLog': 'Git log', 'ws.m.gitDiff': 'Git diff',
      'ws.m.pull': 'Git pull', 'ws.m.push': 'Git push', 'ws.m.branch': 'Đổi nhánh', 'ws.m.pr': 'Tạo PR', 'ws.m.wt': 'Cấu hình worktree',
      'ws.m.copy': 'Sao chép ID agent', 'ws.m.del': 'Xoá', 'ws.m.back': '← Quay lại', 'ws.m.collapse': 'Thu gọn', 'ws.m.expand': 'Mở rộng',
      'ws.m.delGroup': 'Xoá nhóm', 'ws.m.renameGroup': 'Đổi tên nhóm', 'ws.m.newBranch': 'Nhánh mới…',
      'ws.copied': 'Đã sao chép {id}.', 'ws.deleted': 'Đã xoá {name}.', 'ws.undo': 'Hoàn tác', 'ws.restored': 'Đã khôi phục {name}.',
      'ws.cDel': 'Xoá agent "{name}"? Bạn có thể hoàn tác trong vài giây.', 'ws.cDelGroup': 'Xoá nhóm "{name}"? Các agent sẽ chuyển sang "Chưa có nhóm".',
      'ws.cPush': 'Đẩy nhánh hiện tại của {name} lên remote?', 'ws.cPr': 'Tạo pull request cho nhánh hiện tại của {name}?',
      'ws.cStop': 'Dừng lượt đang chạy của {name}?', 'ws.cCancelH': 'Huỷ handoff {id}?', 'ws.cDelConv': 'Xoá cuộc trò chuyện "{name}"?',
      'ws.cAccept': 'Chấp nhận kết quả handoff {id} dù chưa hợp lệ?',
      'ws.ok': 'Đồng ý', 'ws.cancel': 'Huỷ', 'ws.save': 'Lưu', 'ws.close': 'Đóng',
      'ws.namePrompt': 'Tên mới', 'ws.groupPrompt': 'Tên nhóm', 'ws.branchPrompt': 'Tên nhánh',
      'ws.ed.title': 'Agent', 'ws.ed.new': 'Agent mới', 'ws.ed.name': 'Tên', 'ws.ed.group': 'Nhóm', 'ws.ed.platform': 'Nền tảng',
      'ws.ed.model': 'Model', 'ws.ed.effort': 'Effort', 'ws.ed.workdir': 'Thư mục làm việc', 'ws.ed.role': 'Vai trò khi chạy',
      'ws.ed.persona': 'Tính cách / chỉ dẫn riêng', 'ws.ed.args': 'Tham số CLI (mỗi dòng một)', 'ws.ed.env': 'Biến môi trường (KEY=VALUE mỗi dòng)',
      'ws.ed.before': 'Thêm trước mỗi tin nhắn', 'ws.ed.after': 'Thêm sau mỗi tin nhắn', 'ws.ed.retry': 'Tự thử lại khi lỗi (lần)',
      'ws.ed.backoff': 'Chờ giữa các lần (giây)', 'ws.ed.bm': 'Đánh dấu', 'ws.ed.avail': 'Sẵn có', 'ws.ed.missing': 'Không tìm thấy',
      'ws.ed.refresh': 'Kiểm tra lại', 'ws.ed.argsNote': 'Tham số CLI và biến môi trường được lưu; chúng được áp dụng khi bộ chạy hỗ trợ (yêu cầu R2).',
      'ws.ed.advanced': 'Nâng cao', 'ws.saved': 'Đã lưu.', 'ws.git.out': 'Kết quả {a}',
      'ws.convRename': 'Đổi tên cuộc trò chuyện', 'ws.convDel': 'Xoá cuộc trò chuyện',
      'ws.retryN': 'Thử lại', 'ws.autoCont': 'Tự tiếp tục (kết quả handoff)', 'ws.loginBtn': 'Đăng nhập lại',
      'ws.tab.memory': 'Bộ nhớ', 'ws.mem.search': 'Tìm quyết định…', 'ws.mem.add': '+ Quyết định', 'ws.mem.file': 'Lưu trong',
      'ws.mem.empty': 'Chưa có quyết định nào. Kết quả handoff có "decisions" được thêm tự động.', 'ws.mem.pin': 'Ghim (luôn đưa vào brief)', 'ws.mem.unpin': 'Bỏ ghim',
      'ws.mem.edit': 'Sửa', 'ws.mem.save': 'Lưu vào bộ nhớ dự án', 'ws.mem.title': 'Tiêu đề', 'ws.mem.body': 'Nội dung', 'ws.mem.tags': 'Thẻ (cách nhau bởi dấu phẩy)', 'ws.mem.cDel': 'Xoá {id} "{title}" khỏi bộ nhớ dự án?',
      'ws.noBackend': 'Máy chủ chưa có tính năng S6 ({e}).', 'ws.palette.agent': 'Agent', 'ws.palette.conv': 'Cuộc trò chuyện',
    },
    en: {
      'ws.view': 'Workspace',
      'ws.agents': 'Agents', 'ws.chat': 'Chat', 'ws.panel': 'Panel',
      'ws.filter': 'Filter agents…', 'ws.newAgent': '+ Agent', 'ws.newGroup': '+ Group', 'ws.team': 'Team setup',
      'ws.ungrouped': 'Ungrouped', 'ws.noAgents': 'No agents yet. Create one or set up a team.',
      'ws.pickAgent': 'Pick an agent on the left to start chatting.',
      'ws.noConv': 'This agent has no conversation yet.', 'ws.newConv': 'New conversation',
      'ws.st.idle': 'Idle', 'ws.st.thinking': 'Thinking', 'ws.st.waiting': 'Waiting', 'ws.st.error': 'Error', 'ws.st.needs-login': 'Needs login',
      'ws.thinking': '{agent} is thinking…', 'ws.compacting': '{agent} is compacting its context…', 'ws.ran': 'running {t}', 'ws.stop': 'Stop',
      'ws.queue': '{n} queued', 'ws.queueRm': 'Remove from queue',
      'ws.send': 'Send', 'ws.enqueue': 'Add to queue', 'ws.steer': 'Send into the running session',
      'ws.ph': 'Message {agent}… (Ctrl+Enter to send)', 'ws.attach': 'Attach image', 'ws.attachNo': '{p} does not take image attachments.',
      'ws.attachBig': 'Image {name} is larger than 150 KB.', 'ws.defModel': 'default model', 'ws.defEffort': 'default effort',
      'ws.queued': 'Queued ({n}).', 'ws.steered': 'Sent into the running Antigravity session.',
      'ws.ctx': 'Context {pct}% · {used}/{win} tokens', 'ws.compact': 'Compact now', 'ws.compactStarted': 'Compacting the context…',
      'ws.cost': 'Conversation cost', 'ws.files': '{n} files changed', 'ws.noGit': 'no git',
      'ws.ready': 'Ready?', 'ws.log': 'Show log', 'ws.you': 'You', 'ws.system': 'System',
      'ws.tab.handoffs': 'Handoffs', 'ws.tab.files': 'Files', 'ws.tab.history': 'History', 'ws.tab.autorun': 'Auto Run',
      'ws.placeholder': 'Not available yet — needs stream {s}. This panel appears once that feature is merged.',
      'ws.pending': 'PENDING ({n})', 'ws.done': 'Finished', 'ws.noHandoffs': 'No handoffs for this conversation yet.',
      'ws.summaryTable': 'Lead summary (rendered from the handoff records)',
      'ws.h.role': 'Role', 'ws.h.agent': 'Agent', 'ws.h.status': 'Status', 'ws.h.time': 'Time', 'ws.h.files': 'Files', 'ws.h.cost': 'Cost',
      'ws.h.accept': 'Accept', 'ws.h.retry': 'Retry', 'ws.h.cancel': 'Cancel', 'ws.h.open': 'Open member chat', 'ws.h.merge': 'Merge branch',
      'ws.h.evidence': 'Evidence', 'ws.h.blockers': 'Blockers', 'ws.h.scope': 'Outside the write scope', 'ws.h.parse': 'Could not read the JSON result',
      'ws.h.shared': 'shared folder (S1 not available)', 'ws.h.isolated': 'own worktree', 'ws.h.dispatch': 'Dispatch',
      'ws.h.doneToast': 'Handoff {id} · {agent} {status} ({t}): {sum}', 'ws.h.manual': 'Manual dispatch',
      'ws.h.to': 'To role', 'ws.h.task': 'Task', 'ws.h.noTeam': 'This agent is not in a team.',
      'ws.hist.empty': 'No turns yet.',
      'ws.m.rename': 'Rename', 'ws.m.edit': 'Edit agent', 'ws.m.role': 'Role setup', 'ws.m.dup': 'Duplicate',
      'ws.m.bm': 'Bookmark', 'ws.m.unbm': 'Remove bookmark', 'ws.m.move': 'Move to group', 'ws.m.gitLog': 'Git log', 'ws.m.gitDiff': 'Git diff',
      'ws.m.pull': 'Git pull', 'ws.m.push': 'Git push', 'ws.m.branch': 'Switch branch', 'ws.m.pr': 'Create PR', 'ws.m.wt': 'Configure worktree',
      'ws.m.copy': 'Copy agent id', 'ws.m.del': 'Delete', 'ws.m.back': '← Back', 'ws.m.collapse': 'Collapse', 'ws.m.expand': 'Expand',
      'ws.m.delGroup': 'Delete group', 'ws.m.renameGroup': 'Rename group', 'ws.m.newBranch': 'New branch…',
      'ws.copied': 'Copied {id}.', 'ws.deleted': 'Deleted {name}.', 'ws.undo': 'Undo', 'ws.restored': 'Restored {name}.',
      'ws.cDel': 'Delete agent "{name}"? You can undo for a few seconds.', 'ws.cDelGroup': 'Delete group "{name}"? Its agents move to "Ungrouped".',
      'ws.cPush': 'Push the current branch of {name} to the remote?', 'ws.cPr': 'Open a pull request for the current branch of {name}?',
      'ws.cStop': 'Stop the running turn of {name}?', 'ws.cCancelH': 'Cancel handoff {id}?', 'ws.cDelConv': 'Delete conversation "{name}"?',
      'ws.cAccept': 'Accept the result of handoff {id} even though it is not valid?',
      'ws.ok': 'OK', 'ws.cancel': 'Cancel', 'ws.save': 'Save', 'ws.close': 'Close',
      'ws.namePrompt': 'New name', 'ws.groupPrompt': 'Group name', 'ws.branchPrompt': 'Branch name',
      'ws.ed.title': 'Agent', 'ws.ed.new': 'New agent', 'ws.ed.name': 'Name', 'ws.ed.group': 'Group', 'ws.ed.platform': 'Platform',
      'ws.ed.model': 'Model', 'ws.ed.effort': 'Effort', 'ws.ed.workdir': 'Working directory', 'ws.ed.role': 'Run as role',
      'ws.ed.persona': 'Persona / own instructions', 'ws.ed.args': 'CLI arguments (one per line)', 'ws.ed.env': 'Environment (KEY=VALUE per line)',
      'ws.ed.before': 'Added before every message', 'ws.ed.after': 'Added after every message', 'ws.ed.retry': 'Auto-retry on failure (times)',
      'ws.ed.backoff': 'Wait between attempts (s)', 'ws.ed.bm': 'Bookmark', 'ws.ed.avail': 'Available', 'ws.ed.missing': 'Not found',
      'ws.ed.refresh': 'Check again', 'ws.ed.argsNote': 'CLI arguments and environment are stored; they apply once the runner supports them (request R2).',
      'ws.ed.advanced': 'Advanced', 'ws.saved': 'Saved.', 'ws.git.out': '{a} output',
      'ws.convRename': 'Rename conversation', 'ws.convDel': 'Delete conversation',
      'ws.retryN': 'Retry', 'ws.autoCont': 'Auto-continue (handoff results)', 'ws.loginBtn': 'Log in again',
      'ws.tab.memory': 'Memory', 'ws.mem.search': 'Search decisions…', 'ws.mem.add': '+ Decision', 'ws.mem.file': 'Stored in',
      'ws.mem.empty': 'No decisions yet. Handoff results with "decisions" are added automatically.', 'ws.mem.pin': 'Pin (always in briefs)', 'ws.mem.unpin': 'Unpin',
      'ws.mem.edit': 'Edit', 'ws.mem.save': 'Save to project memory', 'ws.mem.title': 'Title', 'ws.mem.body': 'Body', 'ws.mem.tags': 'Tags (comma separated)', 'ws.mem.cDel': 'Delete {id} "{title}" from the project memory?',
      'ws.noBackend': 'The server has no S6 features ({e}).', 'ws.palette.agent': 'Agent', 'ws.palette.conv': 'Conversation',
    },
  };
  M.addI18n('vi', L.vi);
  M.addI18n('en', L.en);
  const t = (k, v) => M.t(k, v);

  // ---------- helpers ----------
  const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const features = () => M.state.data?.features || [];
  const has = f => features().includes(f);
  const get = (action, params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return M.api(s ? `${action}&${s}` : action);
  };
  const post = (action, body) => M.api(action, body || {});
  const errMsg = e => e?.message || String(e);
  const fail = e => { console.error('[workspace]', e); M.toast(errMsg(e), 'err'); };
  const dur = sec => {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  };
  const since = iso => (Date.now() - Date.parse(iso || '')) / 1000;
  const money = v => (v === null || v === undefined || v === '' || !isFinite(+v)) ? '—' : '$' + (+v).toFixed(+v >= 1 ? 2 : 3);
  const kfmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); };
  const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const timeOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString(M.lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' }); };
  const h = (tag, attrs, html) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else el.setAttribute(k, v === true ? '' : v);
    }
    if (html !== undefined) el.innerHTML = html;
    return el;
  };
  const STATUSES = ['idle', 'thinking', 'waiting', 'error', 'needs-login'];
  const TERMINAL_H = ['completed', 'failed', 'blocked', 'needs_review', 'cancelled'];
  const ROLES = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
  const IMAGE_PLATFORMS = ['claude', 'codex', 'gemini', 'cursor'];

  // ---------- dialogs (native <dialog>: focus trap + Esc for free) ----------
  function dialog({ title, body, actions, wide, onClose }) {
    const dlg = h('dialog', { class: 'ws-dlg' + (wide ? ' ws-dlg-wide' : ''), 'aria-label': title });
    dlg.innerHTML = `<form method="dialog" class="ws-dlg-in"><div class="ws-dlg-h"><h3></h3><button type="submit" class="btn btn-sm ws-x" value="close" aria-label="${esc(t('ws.close'))}">×</button></div><div class="ws-dlg-b"></div><div class="ws-dlg-f"></div></form>`;
    qs('h3', dlg).textContent = title;
    const b = qs('.ws-dlg-b', dlg);
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const f = qs('.ws-dlg-f', dlg);
    // Resolves exactly once, whichever way the dialog ends (button, submit, Esc, close event).
    let done = false;
    const finish = () => { if (done) return; done = true; if (dlg.open) dlg.close(); onClose?.(dlg.returnValue); dlg.remove(); };
    for (const a of actions || []) {
      const btn = h('button', { type: a.submit ? 'submit' : 'button', class: 'btn ' + (a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''), value: a.value || '' }, esc(a.label));
      if (a.run) btn.onclick = async ev => { ev.preventDefault(); btn.disabled = true; try { if (await a.run(dlg) !== false) finish(); } catch (e) { fail(e); } finally { btn.disabled = false; } };
      f.appendChild(btn);
    }
    if (!f.children.length) f.remove();
    qs('form', dlg).addEventListener('submit', () => setTimeout(finish, 0));
    dlg.addEventListener('cancel', () => setTimeout(finish, 0));
    dlg.addEventListener('close', finish);
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }
  function confirmDlg(msg, { danger } = {}) {
    return new Promise(resolve => {
      let ok = false;
      dialog({
        title: t('ws.ok') === 'OK' ? 'Confirm' : 'Xác nhận', body: `<p class="ws-confirm">${esc(msg)}</p>`,
        actions: [{ label: t('ws.cancel'), value: 'no', submit: true }, { label: t('ws.ok'), primary: !danger, danger, run: () => { ok = true; } }],
        onClose: () => resolve(ok),
      });
    });
  }
  function promptDlg(title, value = '', { max = 80 } = {}) {
    return new Promise(resolve => {
      let out = null;
      const input = h('input', { class: 'input', type: 'text', maxlength: String(max), value });
      const dlg = dialog({
        title, body: input,
        actions: [{ label: t('ws.cancel'), submit: true }, { label: t('ws.ok'), primary: true, run: () => { out = input.value.trim(); if (!out) return false; } }],
        onClose: () => resolve(out),
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); qs('.btn-primary', dlg).click(); } });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }
  function outputDlg(title, data) {
    const text = typeof data === 'string' ? data : (data?.output ?? data?.log ?? data?.diff ?? JSON.stringify(data, null, 2));
    dialog({ title, wide: true, body: `<pre class="ws-pre">${esc(text)}</pre>`, actions: [{ label: t('ws.close'), submit: true }] });
  }
  // A toast with an action button (MAW.toast is text only).
  function actionToast(msg, label, run) {
    const box = document.getElementById('toasts');
    if (!box) { M.toast(msg); return; }
    const el = h('div', { class: 'toast info ws-toast', role: 'status' });
    el.append(h('span', {}, esc(msg)));
    const b = h('button', { type: 'button', class: 'btn btn-sm' }, esc(label));
    b.onclick = () => { el.remove(); run(); };
    el.append(b);
    box.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  // ---------- state ----------
  const S = {
    el: null, ready: false, loadErr: '',
    agents: [], groups: [], deleted: [], platforms: [], wsFeatures: {},
    selAgent: ls.get('ws_agent') || '', selConv: '',
    convs: [], conv: null, messages: [], lastSeq: 0, running: null,
    handoffs: [], hSeen: new Map(), hInit: false,
    panel: ls.get('ws_panel') || 'handoffs', mtab: 'chat',
    filter: '', attachments: [], panels: [], gitCache: new Map(),
    pollTimer: 0, tickTimer: 0, inflight: false, logOpen: false,
  };
  const agentById = id => S.agents.find(a => a.id === id) || null;
  const platformById = id => S.platforms.find(p => p.id === id) || null;
  const curAgent = () => agentById(S.selAgent);
  const visible = () => S.el && !S.el.classList.contains('hidden') && !document.hidden;

  // ---------- public API for other streams (specs/s6-design.md §8.4) ----------
  M.ws = {
    addPanel(p) {
      if (!p || !/^[a-z][a-z0-9-]{1,31}$/.test(p.id || '') || typeof p.render !== 'function') return;
      S.panels = S.panels.filter(x => x.id !== p.id).concat(p);
      if (S.ready) { renderRightTabs(); renderRight(); }
    },
    selectAgent: id => selectAgent(id),
    openConversation: id => openConversationById(id),
    current: () => ({ agent: curAgent(), conversation: S.conv }),
    agents: () => S.agents.slice(),
    platforms: () => S.platforms.slice(),
    groups: () => S.groups.slice(),
    refresh: () => refreshState(),
    openAgentEditor: id => openAgentEditor(id),
    openTeamBuilder: null,   // set by feat-teams.js
    readiness: null,         // set by feat-teams.js
    newConversation: () => newConversation(),
    stop: () => stopTurn(),
    dialog, confirmDlg, promptDlg, get, post,
  };
  for (const p of window.MAW_WS_PANELS || []) M.ws.addPanel(p);
  window.MAW_WS_PANELS = { push: p => M.ws.addPanel(p) };


  // The page header wraps to two or three rows on narrow screens; the view fills what is left.
  function fitHeight() { const top = document.querySelector('.topbar'); if (S.el && top) S.el.style.setProperty('--ws-top', top.offsetHeight + 'px'); }
  window.addEventListener('resize', () => { if (visible()) fitHeight(); });
  if (window.ResizeObserver) { const top = document.querySelector('.topbar'); if (top) new ResizeObserver(() => fitHeight()).observe(top); }

  function buildSkeleton(el) {
    el.classList.add('ws-root');
    el.dataset.mtab = S.mtab;
    el.innerHTML = `
      <div class="ws-mtabs seg" role="tablist">
        <button type="button" data-mtab="agents"></button><button type="button" data-mtab="chat"></button><button type="button" data-mtab="panel"></button>
      </div>
      <div class="ws-top" id="wsTop"></div>
      <div class="ws-cols">
        <aside class="ws-left" aria-label="Agents">
          <div class="ws-left-h"><input id="wsFilter" class="input" type="search" autocomplete="off"></div>
          <div id="wsTree" class="ws-tree" role="tree"></div>
          <div class="ws-left-f">
            <button type="button" class="btn btn-sm" id="wsNewAgent"></button>
            <button type="button" class="btn btn-sm" id="wsNewGroup"></button>
            <button type="button" class="btn btn-sm btn-primary" id="wsTeamBtn"></button>
          </div>
        </aside>
        <section class="ws-center" aria-label="Chat">
          <div class="ws-convtabs" id="wsConvTabs" role="tablist"></div>
          <div class="ws-msgs" id="wsMsgs" aria-live="polite"></div>
          <div class="ws-status hidden" id="wsStatus"></div>
          <div class="ws-composer" id="wsComposer">
            <div class="ws-queue hidden" id="wsQueue"></div>
            <div class="ws-att" id="wsAtt"></div>
            <textarea id="wsInput" rows="3" maxlength="20000"></textarea>
            <div class="ws-comp-row">
              <select id="wsPlat" aria-label="Platform"></select>
              <select id="wsModel" aria-label="Model"></select>
              <select id="wsEffort" aria-label="Effort"></select>
              <label class="btn btn-sm ws-attach" id="wsAttachLbl"><input type="file" id="wsFile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden><span>📎</span></label>
              <span class="ws-grow"></span>
              <button type="button" class="btn btn-primary" id="wsSend"></button>
            </div>
          </div>
        </section>
        <aside class="ws-right" aria-label="Panel">
          <div class="tabs ws-rtabs" id="wsRTabs" role="tablist"></div>
          <div class="ws-rbody" id="wsRBody"></div>
        </aside>
      </div>`;
    qsa('[data-mtab]', el).forEach(b => b.onclick = () => { S.mtab = b.dataset.mtab; el.dataset.mtab = S.mtab; paintStatic(); });
    qs('#wsFilter', el).oninput = e => { S.filter = e.target.value; renderTree(); };
    qs('#wsNewAgent', el).onclick = () => openAgentEditor(null);
    qs('#wsNewGroup', el).onclick = newGroup;
    qs('#wsTeamBtn', el).onclick = () => M.ws.openTeamBuilder ? M.ws.openTeamBuilder() : M.toast('feat-teams.js', 'warn');
    qs('#wsSend', el).onclick = send;
    const input = qs('#wsInput', el);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    qs('#wsPlat', el).onchange = () => fillModelEffort();
    qs('#wsFile', el).onchange = e => addAttachments(e.target.files);
    const tree = qs('#wsTree', el);
    tree.addEventListener('click', onTreeClick);
    tree.addEventListener('contextmenu', onTreeContext);
    tree.addEventListener('keydown', onTreeKey);
    tree.addEventListener('dragstart', onDragStart);
    tree.addEventListener('dragover', onDragOver);
    tree.addEventListener('dragleave', e => e.target.closest?.('.ws-drop')?.classList.remove('ws-over'));
    tree.addEventListener('drop', onDrop);
    S.ready = true;
    paintStatic();
    renderAll();
  }

  function paintStatic() {
    const el = S.el; if (!el) return;
    const mt = { agents: t('ws.agents'), chat: t('ws.chat'), panel: t('ws.panel') };
    qsa('[data-mtab]', el).forEach(b => { b.textContent = mt[b.dataset.mtab]; b.setAttribute('aria-pressed', String(b.dataset.mtab === S.mtab)); });
    qs('#wsFilter', el).placeholder = t('ws.filter');
    qs('#wsNewAgent', el).textContent = t('ws.newAgent');
    qs('#wsNewGroup', el).textContent = t('ws.newGroup');
    qs('#wsTeamBtn', el).textContent = t('ws.team');
    qs('#wsAttachLbl', el).title = t('ws.attach');
  }
  function renderAll() {
    if (!S.ready) return;
    paintStatic(); renderTop(); renderTree(); renderConvTabs(); renderMessages(true); renderStatus(); renderComposer(); renderRightTabs(); renderRight();
  }
  M.on('lang', renderAll);
  M.on('data', () => { if (visible()) refreshState(); });
  document.addEventListener('visibilitychange', () => { if (visible()) schedule(0); });

  // ---------- polling ----------
  function schedule(ms) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(poll, ms ?? (S.conv?.active_job_id ? 1500 : 5000));
  }
  async function poll() {
    if (!visible()) { schedule(); return; }
    if (!S.inflight) {
      S.inflight = true;
      try { await Promise.all([refreshState(true), refreshConv(), refreshHandoffs()]); } catch { /* errors shown inside */ }
      S.inflight = false;
    }
    schedule();
  }
  // Ticks the running timer once a second without hitting the API.
  setInterval(() => { if (visible() && S.conv?.active_job_id) renderStatus(); }, 1000);

  async function refreshState(quiet) {
    try {
      const d = await get('ws_state', { project_path: M.project()?.path });
      S.agents = d.agents || []; S.groups = d.groups || []; S.deleted = d.deleted || []; S.platforms = d.platforms || []; S.wsFeatures = d.features || {};
      S.loadErr = '';
      if (S.selAgent && !agentById(S.selAgent)) { S.selAgent = ''; S.conv = null; S.convs = []; }
      if (!S.selAgent && S.agents.length) { await selectAgent(S.agents[0].id, true); return; }
      // First load with an agent remembered from last time: load its conversations once.
      if (S.selAgent && S.convsFor !== S.selAgent) { await selectAgent(S.selAgent, true); return; }
    } catch (e) {
      S.loadErr = errMsg(e);
      if (!quiet) console.error('[workspace]', e);
    }
    if (S.ready) { renderTree(); renderTop(); renderComposer(); }
  }

  async function loadConvs() {
    if (!S.selAgent) { S.convs = []; return; }
    S.convsFor = S.selAgent;
    const d = await get('chat_list', { agent_id: S.selAgent });
    S.convs = d.conversations || [];
  }
  async function refreshConv() {
    if (!S.selConv) return;
    try {
      const d = await get('chat_get', { conversation_id: S.selConv, after_seq: S.lastSeq });
      if (d.conversation?.id !== S.selConv) return;
      const wasBusy = !!S.conv?.active_job_id;
      S.conv = d.conversation;
      S.running = d.running || null;
      const fresh = (d.messages || []).filter(m => m.seq > S.lastSeq);
      // Messages already shown may change status (running → done), so replace by seq.
      for (const m of d.messages || []) {
        const i = S.messages.findIndex(x => x.seq === m.seq);
        if (i >= 0) S.messages[i] = m;
      }
      if (fresh.length) { S.messages.push(...fresh); S.lastSeq = Math.max(S.lastSeq, ...fresh.map(m => m.seq)); }
      const ci = S.convs.findIndex(c => c.id === S.conv.id);
      if (ci >= 0) S.convs[ci] = S.conv;
      renderMessages(false, fresh.length > 0); renderStatus(); renderTop(); renderComposer(); renderConvTabs();
      if (wasBusy && !S.conv.active_job_id) { loadConvs().then(renderConvTabs).catch(() => {}); if (S.panel === 'history') renderRight(); }
    } catch (e) {
      if (e.status === 404) { S.selConv = ''; S.conv = null; S.messages = []; renderAll(); }
    }
  }
  async function refreshHandoffs() {
    try {
      const d = await get('handoff_list', { limit: 100 });
      const list = d.handoffs || [];
      for (const ho of list) {
        const prev = S.hSeen.get(ho.id);
        if (S.hInit && prev && prev !== ho.status && TERMINAL_H.includes(ho.status)) handoffDone(ho);
        S.hSeen.set(ho.id, ho.status);
      }
      S.hInit = true;
      S.handoffs = list;
      if (S.ready) { renderRightTabs(); if (S.panel === 'handoffs') renderRight(); }
    } catch { /* handoffs feature missing: the panel shows its own empty state */ }
  }
  function handoffDone(ho) {
    const ag = agentById(ho.to);
    M.toast(t('ws.h.doneToast', { id: ho.id, agent: ag?.name || ho.to_role, status: hStatusLabel(ho.status), t: dur(ho.duration_sec), sum: clip(ho.result?.summary || '', 80) }),
      ho.status === 'completed' ? 'ok' : ho.status === 'cancelled' ? 'info' : 'warn');
    document.dispatchEvent(new CustomEvent('maw:handoff-done', { detail: ho }));
    if (typeof M.emit === 'function') { try { M.emit('handoff-done', ho); } catch { /* optional */ } }
  }

  // ---------- selection ----------
  async function selectAgent(id, keepConv) {
    if (!agentById(id)) return;
    const changed = S.selAgent !== id;
    S.selAgent = id;
    ls.set('ws_agent', id);
    document.dispatchEvent(new CustomEvent('maw:agent-select', { detail: { agent_id: id } }));
    if (changed || !keepConv) { S.selConv = ''; S.conv = null; S.messages = []; S.lastSeq = 0; S.attachments = []; }
    try { await loadConvs(); } catch (e) { fail(e); }
    if (!S.selConv) {
      const saved = ls.get('ws_conv_' + id);
      const pick = S.convs.find(c => c.id === saved) || S.convs[0];
      if (pick) await openConversation(pick.id); else renderAll();
    } else renderAll();
    if (S.mtab === 'agents') { S.mtab = 'chat'; S.el.dataset.mtab = 'chat'; paintStatic(); }
  }
  async function openConversation(id) {
    S.selConv = id; S.conv = S.convs.find(c => c.id === id) || null; S.messages = []; S.lastSeq = 0; S.logOpen = false;
    ls.set('ws_conv_' + S.selAgent, id);
    renderAll();
    await refreshConv();
    scrollBottom();
    schedule();
  }
  async function openConversationById(id) {
    try {
      const d = await get('chat_get', { conversation_id: id, after_seq: 999999999 });
      const aid = d.conversation?.agent_id;
      if (!aid) return;
      if (!agentById(aid)) await refreshState(true);
      M.showView('workspace');
      S.selAgent = aid; ls.set('ws_agent', aid);
      await loadConvs();
      if (!S.convs.some(c => c.id === id)) S.convs.unshift(d.conversation);
      await openConversation(id);
    } catch (e) { fail(e); }
  }
  async function newConversation() {
    const a = curAgent(); if (!a) return;
    try {
      const d = await post('chat_create', { agent_id: a.id });
      S.convs.unshift(d.conversation);
      await openConversation(d.conversation.id);
      qs('#wsInput', S.el)?.focus();
    } catch (e) { fail(e); }
  }

  // ---------- top bar ----------
  async function gitOf(agent) {
    if (!agent?.workdir) return null;
    if (agent.git) return agent.git;
    const c = S.gitCache.get(agent.workdir);
    if (c && Date.now() - c.at < 30000) return c.v;
    S.gitCache.set(agent.workdir, { at: Date.now(), v: null });
    try {
      const g = await get('git_info', { project_path: agent.workdir });
      const v = g.git_info || g;
      S.gitCache.set(agent.workdir, { at: Date.now(), v: { branch: v.current_branch, modified: v.modified_count, ahead: v.ahead, behind: v.behind, has_git: v.has_git } });
      renderTop();
    } catch { /* not a git project */ }
    return null;
  }
  function renderTop() {
    const box = qs('#wsTop', S.el); if (!box) return;
    const a = curAgent();
    if (S.loadErr && !S.agents.length) { box.innerHTML = `<span class="pill err">${esc(t('ws.noBackend', { e: S.loadErr }))}</span>`; return; }
    const opts = S.agents.map(x => `<option value="${esc(x.id)}" ${x.id === S.selAgent ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    const c = S.conv;
    const g = a ? (a.git || S.gitCache.get(a.workdir)?.v) : null;
    if (a && !g) gitOf(a);
    const ctx = c?.context || {};
    const pct = Math.round((Number(ctx.pct) || 0) * 100);
    const meterCls = pct >= 70 ? 'err' : pct >= 60 ? 'warn' : 'ok';
    const plat = platformById(a?.platform);
    const html = `
      <select id="wsTopAgent" class="ws-top-agent" aria-label="${esc(t('ws.agents'))}" ${S.agents.length ? '' : 'disabled'}>${opts || `<option>${esc(t('ws.agents'))}</option>`}</select>
      ${a ? `<span class="pill ws-plat" title="${esc(plat?.label || a.platform)}"><span class="dot" style="background:${esc(plat?.color || 'var(--faint)')}"></span>${esc(plat?.label || a.platform)}${a.model ? ' · ' + esc(a.model) : ''}</span>` : ''}
      ${a ? (g?.branch ? `<span class="pill mono" title="${esc(a.workdir)}">⎇ ${esc(g.branch)}${g.ahead ? ` ↑${+g.ahead}` : ''}${g.behind ? ` ↓${+g.behind}` : ''}</span>` : `<span class="pill faint">${esc(g && g.has_git === false ? t('ws.noGit') : '⎇ …')}</span>`) : ''}
      ${a && g && g.modified !== undefined ? `<span class="pill ws-diffstat"><span class="t-ok">+</span><span class="t-err">−</span> ${esc(t('ws.files', { n: +g.modified || 0 }))}</span>` : ''}
      ${c ? `<span class="pill" title="${esc(t('ws.cost'))}">${esc(money(c.cost_usd))}</span>` : ''}
      ${c ? `<button type="button" class="pill ws-meter ${meterCls}" id="wsMeter" title="${esc(t('ws.ctx', { pct, used: kfmt(ctx.used_tokens), win: kfmt(ctx.window_tokens) }))}"><span class="ws-meter-bar"><i style="width:${Math.min(100, pct)}%"></i></span>${pct}%</button>` : ''}
      <span class="ws-grow"></span>
      <button type="button" class="btn btn-sm" id="wsReady">${esc(t('ws.ready'))}</button>`;
    if (box._html === html) return;
    box._html = html;
    box.innerHTML = html;
    qs('#wsTopAgent', box).onchange = e => selectAgent(e.target.value);
    qs('#wsReady', box).onclick = () => M.ws.readiness ? M.ws.readiness(a?.team_id ? S.agents.filter(x => x.team_id === a.team_id) : S.agents) : M.toast('feat-teams.js', 'warn');
    const meter = qs('#wsMeter', box);
    if (meter) meter.onclick = () => openMeterMenu(meter);
  }
  function openMeterMenu(anchor) {
    const c = S.conv; if (!c) return;
    const ctx = c.context || {};
    const pct = Math.round((Number(ctx.pct) || 0) * 100);
    openMenu(anchor, [
      { label: t('ws.ctx', { pct, used: kfmt(ctx.used_tokens), win: kfmt(ctx.window_tokens) }), disabled: true },
      { label: t('ws.compact'), disabled: !!c.active_job_id, run: async () => { await post('chat_compact', { conversation_id: c.id }); M.toast(t('ws.compactStarted')); refreshConv(); schedule(500); } },
    ]);
  }

  // ---------- left: groups → agents ----------
  function renderTree() {
    const box = qs('#wsTree', S.el); if (!box) return;
    if (!S.agents.length) { box._html = ''; box.innerHTML = `<div class="empty">${esc(S.loadErr ? t('ws.noBackend', { e: S.loadErr }) : t('ws.noAgents'))}</div>`; return; }
    const f = S.filter.trim().toLowerCase();
    const match = a => !f || [a.name, a.platform, a.team_role, a.model].some(x => String(x || '').toLowerCase().includes(f));
    const groups = [...S.groups].sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || x.name.localeCompare(y.name));
    const sections = [...groups.map(g => ({ g, id: g.id })), { g: { id: '', name: t('ws.ungrouped'), collapsed: ls.get('ws_ug_collapsed') === '1' }, id: '' }];
    const order = (x, y) => (y.bookmark ? 1 : 0) - (x.bookmark ? 1 : 0) || (x.order ?? 0) - (y.order ?? 0) || x.name.localeCompare(y.name);
    let html = '';
    for (const { g, id } of sections) {
      const list = S.agents.filter(a => (a.group_id || '') === id && match(a)).sort(order);
      if (!id && !list.length && S.groups.length && !f) continue;
      if (f && !list.length) continue;
      const open = f ? true : !g.collapsed;
      html += `<div class="ws-group ws-drop" data-group="${esc(id)}" role="group">
        <div class="ws-group-h" role="treeitem" tabindex="0" aria-expanded="${open}" data-group-h="${esc(id)}">
          <span class="ws-caret" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="ws-gname">${esc(g.name)}</span><span class="count">${list.length}</span>
          ${id ? `<button type="button" class="ws-more" data-gmenu="${esc(id)}" aria-label="⋯" tabindex="-1">⋯</button>` : ''}
        </div>
        <div class="ws-group-b ${open ? '' : 'hidden'}">${list.map(agentRow).join('')}</div>
      </div>`;
    }
    html = html || `<div class="empty">—</div>`;
    if (box._html === html) return;
    box._html = html;
    const focusId = document.activeElement?.closest?.('#wsTree [data-agent], #wsTree [data-group-h]');
    const key = focusId ? (focusId.dataset.agent ? `[data-agent="${focusId.dataset.agent}"]` : `[data-group-h="${focusId.dataset.groupH}"]`) : '';
    box.innerHTML = html;
    if (key) qs(key, box)?.focus();
  }
  function agentRow(a) {
    const st = STATUSES.includes(a.status) ? a.status : 'idle';
    const plat = platformById(a.platform);
    const g = a.git || S.gitCache.get(a.workdir)?.v;
    const sel = a.id === S.selAgent;
    return `<div class="ws-agent ws-drop ${sel ? 'is-sel' : ''}" role="treeitem" tabindex="${sel ? 0 : -1}" aria-selected="${sel}" draggable="true" data-agent="${esc(a.id)}">
      <span class="ws-dot ws-${st}" title="${esc(t('ws.st.' + st))}" aria-label="${esc(t('ws.st.' + st))}"></span>
      <span class="ws-agent-main">
        <span class="ws-agent-name">${esc(a.name)}${a.team_role ? ` <span class="ws-role">${esc(a.team_role)}</span>` : ''}</span>
        <span class="ws-agent-sub"><span class="dot" style="background:${esc(plat?.color || 'var(--faint)')}"></span>${esc(plat?.label || a.platform)}${plat && plat.installed === false ? ' ⚠' : ''}
          ${g?.branch ? `<span class="ws-git mono">⎇ ${esc(clip(g.branch, 18))}${g.modified ? ` ●${+g.modified}` : ''}</span>` : ''}
          ${a.queue_len ? `<span class="badge b-warn">${+a.queue_len}</span>` : ''}</span>
      </span>
      ${st === 'needs-login' ? `<button type="button" class="btn btn-sm ws-login" data-login="${esc(a.id)}" tabindex="-1">${esc(t('ws.loginBtn'))}</button>` : ''}
      <button type="button" class="ws-star ${a.bookmark ? 'on' : ''}" data-star="${esc(a.id)}" aria-pressed="${!!a.bookmark}" aria-label="${esc(t(a.bookmark ? 'ws.m.unbm' : 'ws.m.bm'))}" tabindex="-1">${a.bookmark ? '★' : '☆'}</button>
      <button type="button" class="ws-more" data-amenu="${esc(a.id)}" aria-label="⋯" tabindex="-1">⋯</button>
    </div>`;
  }
  function onTreeClick(e) {
    const star = e.target.closest('[data-star]');
    if (star) { e.stopPropagation(); toggleBookmark(star.dataset.star); return; }
    const am = e.target.closest('[data-amenu]');
    if (am) { e.stopPropagation(); agentMenu(agentById(am.dataset.amenu), am); return; }
    const gm = e.target.closest('[data-gmenu]');
    if (gm) { e.stopPropagation(); groupMenu(S.groups.find(g => g.id === gm.dataset.gmenu), gm); return; }
    const lg = e.target.closest('[data-login]');
    if (lg) { e.stopPropagation(); relogin(agentById(lg.dataset.login)); return; }
    const gh = e.target.closest('[data-group-h]');
    if (gh) { toggleGroup(gh.dataset.groupH); return; }
    const row = e.target.closest('[data-agent]');
    if (row) selectAgent(row.dataset.agent);
  }
  function onTreeContext(e) {
    const row = e.target.closest('[data-agent]');
    const gh = e.target.closest('[data-group-h]');
    if (row) { e.preventDefault(); agentMenu(agentById(row.dataset.agent), { x: e.clientX, y: e.clientY }); }
    else if (gh && gh.dataset.groupH) { e.preventDefault(); groupMenu(S.groups.find(g => g.id === gh.dataset.groupH), { x: e.clientX, y: e.clientY }); }
  }
  function onTreeKey(e) {
    const items = qsa('[data-agent], [data-group-h]', qs('#wsTree', S.el)).filter(x => x.offsetParent !== null);
    const cur = e.target.closest('[data-agent], [data-group-h]');
    if (!cur) return;
    const i = items.indexOf(cur);
    const focus = el => { if (!el) return; items.forEach(x => x.tabIndex = -1); el.tabIndex = 0; el.focus(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); focus(items[i + 1]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focus(items[i - 1]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cur.click(); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = cur.getBoundingClientRect();
      if (cur.dataset.agent) agentMenu(agentById(cur.dataset.agent), { x: r.left + 24, y: r.bottom });
      else if (cur.dataset.groupH) groupMenu(S.groups.find(g => g.id === cur.dataset.groupH), { x: r.left + 24, y: r.bottom });
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur.dataset.groupH !== undefined) {
      const open = cur.getAttribute('aria-expanded') === 'true';
      if ((e.key === 'ArrowLeft') === open) { e.preventDefault(); toggleGroup(cur.dataset.groupH); }
    }
  }
  async function toggleGroup(id) {
    if (!id) { ls.set('ws_ug_collapsed', ls.get('ws_ug_collapsed') === '1' ? '0' : '1'); renderTree(); return; }
    const g = S.groups.find(x => x.id === id); if (!g) return;
    g.collapsed = !g.collapsed; renderTree();
    try { await post('ws_group_save', { group: { id, collapsed: g.collapsed } }); } catch (e) { fail(e); }
  }
  // drag an agent onto a group (or onto another agent to place it before that one)
  let dragId = '';
  function onDragStart(e) {
    const row = e.target.closest('[data-agent]'); if (!row) return;
    dragId = row.dataset.agent;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  }
  function onDragOver(e) {
    if (!dragId) return;
    const z = e.target.closest('.ws-drop'); if (!z) return;
    e.preventDefault();
    qsa('.ws-over', S.el).forEach(x => x !== z && x.classList.remove('ws-over'));
    z.classList.add('ws-over');
  }
  async function onDrop(e) {
    const z = e.target.closest('.ws-drop'); if (!z || !dragId) return;
    e.preventDefault();
    qsa('.ws-over', S.el).forEach(x => x.classList.remove('ws-over'));
    const id = dragId; dragId = '';
    const target = z.dataset.agent ? agentById(z.dataset.agent) : null;
    if (target?.id === id) return;
    const group_id = target ? (target.group_id || '') : (z.dataset.group ?? '');
    const body = { id, group_id };
    if (target) body.order = target.order ?? 0;
    try { await post('ws_agent_move', body); await refreshState(true); } catch (err) { fail(err); }
  }

  // ---------- context menus (V8) ----------
  let menuEl = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener('mousedown', menuOutside, true); }
  function menuOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function openMenu(anchor, items, returnFocus) {
    closeMenu();
    const back = returnFocus || (anchor instanceof Element ? anchor : document.activeElement);
    menuEl = h('div', { class: 'ws-menu', role: 'menu' });
    const fill = list => {
      menuEl.innerHTML = '';
      for (const it of list) {
        if (it === '-') {
          // no leading or doubled separators when the items around them are hidden
          if (menuEl.lastElementChild && !menuEl.lastElementChild.classList.contains('ws-menu-sep')) menuEl.append(h('div', { class: 'ws-menu-sep', role: 'separator' }));
          continue;
        }
        if (!it || it.hidden) continue;
        const b = h('button', { type: 'button', role: 'menuitem', class: 'ws-menu-i' + (it.danger ? ' danger' : ''), disabled: it.disabled }, esc(it.label) + (it.sub ? ' <span aria-hidden="true">▸</span>' : ''));
        b.onclick = async () => {
          if (it.sub) { const subs = typeof it.sub === 'function' ? await it.sub() : it.sub; fill([{ label: t('ws.m.back'), run: () => fill(list), keep: true }, '-', ...subs]); qs('.ws-menu-i', menuEl)?.focus(); return; }
          if (!it.keep) { closeMenu(); back?.focus?.(); }
          try { await it.run?.(); } catch (err) { fail(err); }
        };
        menuEl.append(b);
      }
    };
    fill(items);
    document.body.appendChild(menuEl);
    let x, y;
    if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; } else { x = anchor.x; y = anchor.y; }
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + 'px';
    menuEl.style.top = Math.max(8, Math.min(y, innerHeight - mh - 8)) + 'px';
    menuEl.addEventListener('keydown', e => {
      const bs = qsa('.ws-menu-i:not([disabled])', menuEl);
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); back?.focus?.(); }
    });
    setTimeout(() => document.addEventListener('mousedown', menuOutside, true), 0);
    qs('.ws-menu-i:not([disabled])', menuEl)?.focus();
  }
  function agentMenu(a, anchor) {
    if (!a) return;
    const git = has('worktrees');
    const gitRun = (action, label, body, confirmMsg) => async () => {
      if (confirmMsg && !(await confirmDlg(confirmMsg))) return;
      const d = body ? await post(action, { project_path: a.workdir, ...body }) : await get(action, { project_path: a.workdir });
      outputDlg(t('ws.git.out', { a: label }), d);
      S.gitCache.delete(a.workdir); refreshState(true);
    };
    openMenu(anchor, [
      { label: t('ws.m.rename'), run: async () => { const n = await promptDlg(t('ws.namePrompt'), a.name, { max: 60 }); if (n && n !== a.name) { await post('ws_agent_save', { agent: { id: a.id, name: n } }); refreshState(true); } } },
      { label: t('ws.m.edit'), run: () => openAgentEditor(a.id) },
      { label: t('ws.m.role'), hidden: !M.ws.openTeamBuilder, run: () => M.ws.openTeamBuilder({ role: a.team_role, project_path: a.workdir }) },
      { label: t('ws.m.dup'), run: async () => { const d = await post('ws_agent_duplicate', { id: a.id }); await refreshState(true); selectAgent(d.agent.id); } },
      { label: t(a.bookmark ? 'ws.m.unbm' : 'ws.m.bm'), run: () => toggleBookmark(a.id) },
      { label: t('ws.m.move'), sub: () => [{ id: '', name: t('ws.ungrouped') }, ...S.groups].filter(g => g.id !== (a.group_id || '')).map(g => ({ label: g.name, run: async () => { await post('ws_agent_move', { id: a.id, group_id: g.id }); refreshState(true); } })) },
      '-',
      { label: t('ws.m.gitLog'), hidden: !git, run: gitRun('git_log', 'git log') },
      { label: t('ws.m.gitDiff'), hidden: !git, run: gitRun('git_diff', 'git diff') },
      { label: t('ws.m.pull'), hidden: !git, run: gitRun('git_pull', 'git pull', {}) },
      { label: t('ws.m.push'), hidden: !git, run: gitRun('git_push', 'git push', {}, t('ws.cPush', { name: a.name })) },
      { label: t('ws.m.branch'), hidden: !git, sub: async () => {
        let branches = [];
        try { const g = await get('git_info', { project_path: a.workdir }); branches = (g.git_info || g).branches || []; } catch { /* none */ }
        const names = branches.map(b => typeof b === 'string' ? b : b.name).filter(Boolean).slice(0, 25);
        return [...names.map(n => ({ label: n, run: gitRun('git_branch_switch', 'git switch', { branch: n }) })),
          { label: t('ws.m.newBranch'), run: async () => { const n = await promptDlg(t('ws.branchPrompt'), '', { max: 100 }); if (n) await gitRun('git_branch_create', 'git branch', { branch: n })(); } }];
      } },
      { label: t('ws.m.pr'), hidden: !has('github'), run: gitRun('github_pr_create', 'PR', {}, t('ws.cPr', { name: a.name })) },
      { label: t('ws.m.wt'), hidden: !git, run: () => worktreeDlg(a) },
      '-',
      { label: t('ws.m.copy'), run: async () => { try { await navigator.clipboard.writeText(a.id); } catch { /* clipboard blocked */ } M.toast(t('ws.copied', { id: a.id }), 'ok'); } },
      { label: t('ws.m.del'), danger: true, run: () => deleteAgent(a) },
    ]);
  }
  function groupMenu(g, anchor) {
    if (!g) return;
    openMenu(anchor, [
      { label: t('ws.m.renameGroup'), run: async () => { const n = await promptDlg(t('ws.groupPrompt'), g.name, { max: 60 }); if (n) { await post('ws_group_save', { group: { id: g.id, name: n } }); refreshState(true); } } },
      { label: t(g.collapsed ? 'ws.m.expand' : 'ws.m.collapse'), run: () => toggleGroup(g.id) },
      '-',
      { label: t('ws.m.delGroup'), danger: true, run: async () => {
        if (!(await confirmDlg(t('ws.cDelGroup', { name: g.name }), { danger: true }))) return;
        await post('ws_group_delete', { id: g.id }); refreshState(true);
      } },
    ]);
  }
  async function worktreeDlg(a) {
    let list = [];
    try { const d = await get('worktree_list', { project_path: a.workdir }); list = d.worktrees || []; } catch (e) { fail(e); return; }
    const rows = list.map(w => `<tr><td class="mono">${esc(w.branch || '')}</td><td class="mono ws-path">${esc(w.path || '')}</td></tr>`).join('');
    dialog({
      title: t('ws.m.wt') + ' · ' + a.name, wide: true,
      body: `<table class="ws-table"><tbody>${rows || `<tr><td class="empty">—</td></tr>`}</tbody></table>`,
      actions: [{ label: t('ws.close'), submit: true }, { label: '+ worktree', primary: true, run: async () => { const d = await post('worktree_create', { project_path: a.workdir, base: (a.git || S.gitCache.get(a.workdir)?.v)?.branch || '' }); outputDlg('worktree', d); } }],
    });
  }
  async function toggleBookmark(id) {
    const a = agentById(id); if (!a) return;
    a.bookmark = !a.bookmark; renderTree();
    try { await post('ws_agent_save', { agent: { id, bookmark: a.bookmark } }); } catch (e) { a.bookmark = !a.bookmark; renderTree(); fail(e); }
  }
  async function deleteAgent(a) {
    if (!(await confirmDlg(t('ws.cDel', { name: a.name }), { danger: true }))) return;
    try {
      await post('ws_agent_delete', { id: a.id });
      if (S.selAgent === a.id) { S.selAgent = ''; S.selConv = ''; S.conv = null; S.messages = []; }
      await refreshState(true);
      renderAll();
      actionToast(t('ws.deleted', { name: a.name }), t('ws.undo'), async () => {
        try { await post('ws_agent_restore', { id: a.id }); M.toast(t('ws.restored', { name: a.name }), 'ok'); await refreshState(true); } catch (e) { fail(e); }
      });
    } catch (e) { fail(e); }
  }
  async function newGroup() {
    const n = await promptDlg(t('ws.groupPrompt'), '', { max: 60 });
    if (!n) return;
    try { await post('ws_group_save', { group: { name: n } }); await refreshState(true); } catch (e) { fail(e); }
  }
  async function relogin(a) {
    if (!a) return;
    // S3 owns the re-login flow (V7); without it, explain what to run.
    if (has('health') && typeof M.relogin === 'function') return M.relogin(a.platform);
    try { const d = await post('health_login', { agent: a.platform }); M.toast(d.message || 'OK', 'ok'); }
    catch { outputDlg(t('ws.loginBtn'), `${a.platform}: ${({ claude: 'claude /login', codex: 'codex login', gemini: 'gemini', antigravity: 'Antigravity IDE → Sign in' })[a.platform] || a.platform}`); }
  }

  // ---------- agent editor (V2) ----------
  async function openAgentEditor(id) {
    const a = id ? agentById(id) : null;
    const cur = a || { name: '', group_id: '', platform: (S.platforms.find(p => p.installed) || S.platforms[0])?.id || '', model: '', effort: '', workdir: M.project()?.path || '', role: 'backend', persona: '', cli_args: [], env: {}, hooks: { before: '', after: '' }, retry_policy: { max_attempts: 0, backoff_sec: 30 }, bookmark: false };
    const projects = M.state.data?.projects || [];
    const f = h('form', { class: 'ws-form' });
    const groupOpts = [{ id: '', name: t('ws.ungrouped') }, ...S.groups].map(g => `<option value="${esc(g.id)}" ${g.id === (cur.group_id || '') ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
    const platOpts = () => S.platforms.map(p => `<option value="${esc(p.id)}" ${p.id === cur.platform ? 'selected' : ''}>${esc(p.label)} — ${esc(p.installed ? t('ws.ed.avail') : t('ws.ed.missing'))}${p.version ? ' ' + esc(p.version) : ''}</option>`).join('');
    const envText = Object.entries(cur.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    f.innerHTML = `
      <label class="ws-f"><span>${esc(t('ws.ed.name'))}</span><input class="input" name="name" maxlength="60" required value="${esc(cur.name)}"></label>
      <div class="ws-f2">
        <label class="ws-f"><span>${esc(t('ws.ed.group'))}</span><select name="group_id">${groupOpts}</select></label>
        <label class="ws-f"><span>${esc(t('ws.ed.role'))}</span><select name="role">${ROLES.map(r => `<option ${r === cur.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      </div>
      <label class="ws-f"><span>${esc(t('ws.ed.platform'))}</span><span class="row"><select name="platform" class="ws-grow">${platOpts()}</select><button type="button" class="btn btn-sm" data-refresh>${esc(t('ws.ed.refresh'))}</button></span></label>
      <div class="ws-f2">
        <label class="ws-f"><span>${esc(t('ws.ed.model'))}</span><select name="model"></select></label>
        <label class="ws-f"><span>${esc(t('ws.ed.effort'))}</span><select name="effort"></select></label>
      </div>
      <label class="ws-f"><span>${esc(t('ws.ed.workdir'))}</span><input class="input mono" name="workdir" list="wsProjList" required value="${esc(cur.workdir)}"><datalist id="wsProjList">${projects.map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('')}</datalist></label>
      <label class="ws-f"><span>${esc(t('ws.ed.persona'))}</span><textarea name="persona" rows="3" maxlength="4000">${esc(cur.persona || '')}</textarea></label>
      <label class="ws-check"><input type="checkbox" name="bookmark" ${cur.bookmark ? 'checked' : ''}> ${esc(t('ws.ed.bm'))}</label>
      <details class="ws-adv"><summary>${esc(t('ws.ed.advanced'))}</summary>
        <div class="ws-f2">
          <label class="ws-f"><span>${esc(t('ws.ed.retry'))}</span><input class="input" type="number" name="max_attempts" min="0" max="5" value="${+(cur.retry_policy?.max_attempts || 0)}"></label>
          <label class="ws-f"><span>${esc(t('ws.ed.backoff'))}</span><input class="input" type="number" name="backoff_sec" min="5" max="1800" value="${+(cur.retry_policy?.backoff_sec || 30)}"></label>
        </div>
        <label class="ws-f"><span>${esc(t('ws.ed.before'))}</span><textarea name="before" rows="2" maxlength="2000">${esc(cur.hooks?.before || '')}</textarea></label>
        <label class="ws-f"><span>${esc(t('ws.ed.after'))}</span><textarea name="after" rows="2" maxlength="2000">${esc(cur.hooks?.after || '')}</textarea></label>
        <label class="ws-f"><span>${esc(t('ws.ed.args'))}</span><textarea name="cli_args" rows="2" class="mono">${esc((cur.cli_args || []).join('\n'))}</textarea></label>
        <label class="ws-f"><span>${esc(t('ws.ed.env'))}</span><textarea name="env" rows="2" class="mono">${esc(envText)}</textarea></label>
        <p class="sub faint">${esc(t('ws.ed.argsNote'))}</p>
      </details>`;
    const fillME = () => {
      const p = platformById(f.platform.value);
      f.model.innerHTML = `<option value="">${esc(t('ws.defModel'))}</option>` + (p?.models || []).map(m => `<option ${m === cur.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
      f.effort.innerHTML = `<option value="">${esc(t('ws.defEffort'))}</option>` + (p?.efforts || []).map(m => `<option ${m === cur.effort ? 'selected' : ''}>${esc(m)}</option>`).join('');
      f.effort.disabled = !(p?.efforts || []).length;
    };
    fillME();
    f.platform.onchange = () => { cur.platform = f.platform.value; fillME(); };
    qs('[data-refresh]', f).onclick = async ev => {
      ev.target.disabled = true;
      try { const d = await get('ws_platforms', { refresh: 1 }); S.platforms = d.platforms || S.platforms; f.platform.innerHTML = platOpts(); fillME(); } catch (e) { fail(e); }
      ev.target.disabled = false;
    };
    dialog({
      title: a ? `${t('ws.ed.title')} · ${a.name}` : t('ws.ed.new'), body: f,
      actions: [{ label: t('ws.cancel'), submit: true }, {
        label: t('ws.save'), primary: true, run: async () => {
          if (!f.reportValidity()) return false;
          const env = {};
          for (const line of f.env.value.split(/\r?\n/)) { const m = /^\s*([^=\s]+)\s*=(.*)$/.exec(line); if (m) env[m[1]] = m[2]; }
          const agent = {
            name: f.name.value.trim(), group_id: f.group_id.value, platform: f.platform.value, model: f.model.value, effort: f.effort.value,
            workdir: f.workdir.value.trim(), role: f.role.value, persona: f.persona.value, bookmark: f.bookmark.checked,
            hooks: { before: f.before.value, after: f.after.value },
            retry_policy: { max_attempts: +f.max_attempts.value || 0, backoff_sec: +f.backoff_sec.value || 30 },
            cli_args: f.cli_args.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), env,
          };
          if (a) agent.id = a.id;
          const d = await post('ws_agent_save', { agent });
          M.toast(t('ws.saved'), 'ok');
          await refreshState(true);
          if (!a) selectAgent(d.agent.id);
        },
      }],
    });
    setTimeout(() => f.name.focus(), 0);
  }

  // ---------- centre: conversation tabs ----------
  function renderConvTabs() {
    const box = qs('#wsConvTabs', S.el); if (!box) return;
    const a = curAgent();
    if (!a) { box.innerHTML = ''; return; }
    box.innerHTML = S.convs.map(c => `<div class="ws-ctab ${c.id === S.selConv ? 'is-sel' : ''}" role="tab" aria-selected="${c.id === S.selConv}">
        <button type="button" class="ws-ctab-b" data-conv="${esc(c.id)}" title="${esc(c.title)}">${c.active_job_id ? '<span class="ws-dot ws-thinking"></span>' : ''}${c.kind === 'handoff' ? '<span class="ws-hk" aria-hidden="true">⇄</span>' : ''}${esc(clip(c.title || '…', 24))}</button>
        <button type="button" class="ws-ctab-x" data-convmenu="${esc(c.id)}" aria-label="⋯">⋯</button></div>`).join('')
      + `<button type="button" class="btn btn-sm ws-ctab-new" id="wsNewConv" title="${esc(t('ws.newConv'))}" aria-label="${esc(t('ws.newConv'))}">+</button>`;
    qsa('[data-conv]', box).forEach(b => b.onclick = () => openConversation(b.dataset.conv));
    qsa('[data-convmenu]', box).forEach(b => b.onclick = () => convMenu(S.convs.find(c => c.id === b.dataset.convmenu), b));
    qs('#wsNewConv', box).onclick = newConversation;
  }
  function convMenu(c, anchor) {
    if (!c) return;
    openMenu(anchor, [
      { label: t('ws.convRename'), run: async () => { const n = await promptDlg(t('ws.convRename'), c.title, { max: 80 }); if (n) { await post('chat_rename', { conversation_id: c.id, title: n }); await loadConvs(); renderConvTabs(); } } },
      { label: t('ws.compact'), disabled: !!c.active_job_id, run: async () => { await post('chat_compact', { conversation_id: c.id }); M.toast(t('ws.compactStarted')); refreshConv(); } },
      '-',
      { label: t('ws.convDel'), danger: true, disabled: !!c.active_job_id, run: async () => {
        if (!(await confirmDlg(t('ws.cDelConv', { name: c.title }), { danger: true }))) return;
        await post('chat_delete', { conversation_id: c.id });
        if (S.selConv === c.id) { S.selConv = ''; S.conv = null; S.messages = []; }
        await loadConvs(); if (!S.selConv && S.convs[0]) openConversation(S.convs[0].id); else renderAll();
      } },
    ]);
  }

  // ---------- centre: messages ----------
  // Minimal, safe Markdown: everything is escaped first; fenced blocks, `code` and **bold** only.
  function md(text) {
    const parts = String(text ?? '').split(/^```/m);
    let out = '';
    parts.forEach((p, i) => {
      if (i % 2 === 0) { out += tables(p); return; }
      const nl = p.indexOf('\n');
      const lang = (nl >= 0 ? p.slice(0, nl) : '').trim().toLowerCase();
      const code = (nl >= 0 ? p.slice(nl + 1) : p).replace(/\n$/, '');
      if (lang === 'handoff') out += handoffBlock(code);
      else if (lang === 'json' && looksLikeResult(code)) out += resultCard(JSON.parse(code));
      else out += `<pre class="ws-code"><code>${esc(code)}</code></pre>`;
    });
    return out;
  }
  // Runs of lines that start and end with "|" become a table (escaped cell by cell).
  function tables(src) {
    const isRow = l => /^\s*\|.*\|\s*$/.test(l);
    const isSep = l => /^\s*\|[\s|:-]+\|\s*$/.test(l);
    const lines = src.split('\n'), out = [];
    for (let i = 0; i < lines.length;) {
      if (isRow(lines[i])) {
        const rows = [];
        while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
        const head = rows.length > 1 && isSep(rows[1]) ? rows[0] : null;
        const body = rows.filter((r, k) => !isSep(r) && !(head && k === 0));
        out.push('<div class="ws-tablewrap ws-mdtable"><table class="ws-table">'
          + (head ? '<thead><tr>' + cells(head).map(c => '<th>' + c + '</th>').join('') + '</tr></thead>' : '')
          + '<tbody>' + body.map(r => '<tr>' + cells(r).map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      } else {
        out.push(inline(lines[i]) + (i < lines.length - 1 ? '\n' : ''));
        i++;
      }
    }
    return out.join('');
  }
  function inline(s) {
    return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/^#{1,4} (.+)$/gm, '<strong class="ws-mh">$1</strong>');
  }
  function looksLikeResult(code) {
    try { const j = JSON.parse(code); return j && typeof j === 'object' && typeof j.status === 'string' && typeof j.summary === 'string'; } catch { return false; }
  }
  function handoffBlock(code) {
    let list = [];
    try { list = JSON.parse(code).handoffs || []; } catch { return `<pre class="ws-code"><code>${esc(code)}</code></pre>`; }
    return `<div class="ws-dispatch"><div class="ws-dispatch-h">${esc(t('ws.h.dispatch'))} · ${list.length}</div>${list.map(x => `<div class="ws-dispatch-i"><span class="badge b-info">→ ${esc(x.to)}</span> ${esc(clip(x.task, 240))}</div>`).join('')}</div>`;
  }
  function resultCard(r) {
    const cls = r.status === 'completed' ? 'b-ok' : r.status === 'blocked' ? 'b-warn' : 'b-err';
    return `<div class="ws-result"><div class="row"><span class="badge ${cls}">${esc(r.status)}</span>${r.cost != null ? `<span class="faint">${esc(money(r.cost))}</span>` : ''}</div>
      <p>${esc(r.summary)}</p>
      ${(r.files_changed || []).length ? `<div class="ws-files mono">${r.files_changed.slice(0, 30).map(f => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
      ${(r.blockers || []).length ? `<ul class="ws-blockers">${r.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</div>`;
  }
  function msgHtml(m) {
    const a = curAgent();
    if (m.role === 'system') return `<div class="ws-msg ws-sys" data-seq="${m.seq}"><span>${esc(m.text)}</span><time>${esc(timeOf(m.ts))}</time></div>`;
    if (m.role === 'handoff') {
      const ho = S.handoffs.find(x => x.id === m.handoff_id);
      const st = ho?.status || '';
      return `<div class="ws-msg ws-hmsg" data-seq="${m.seq}"><button type="button" class="ws-hlink" data-hid="${esc(m.handoff_id || '')}">
        ${st ? `<span class="badge ${hStatusCls(st)}">${esc(hStatusLabel(st))}</span>` : ''}<span class="ws-htext">${inline(m.text)}</span></button><time>${esc(timeOf(m.ts))}</time></div>`;
    }
    const mine = m.role === 'user';
    const who = m.system_generated ? t('ws.autoCont') : mine ? t('ws.you') : (a?.name || 'Agent');
    const st = m.status && m.status !== 'done' ? `<span class="badge ${m.status === 'failed' ? 'b-err' : m.status === 'cancelled' ? '' : 'b-warn'}">${esc(m.status)}</span>` : '';
    const meta = [
      m.actual_model || m.model ? esc(m.actual_model || m.model) : (m.platform && !mine ? esc(m.platform) : ''),
      m.duration_sec ? dur(m.duration_sec) : '',
      m.cost_usd != null && !mine ? esc(money(m.cost_usd)) : '',
      m.steered ? '↪ steer' : '',
    ].filter(Boolean).join(' · ');
    const att = (m.attachments || []).map(x => `<span class="badge">📎 ${esc(x.name)}</span>`).join(' ');
    const retry = m.status === 'failed' && !mine ? `<button type="button" class="btn btn-sm" data-retry="${m.seq}">${esc(t('ws.retryN'))}</button>` : '';
    const toMem = !mine && m.status === 'done' && m.text ? `<button type="button" class="btn-link ws-tomem" data-tomem="${m.seq}">${esc(t('ws.mem.save'))}</button>` : '';
    return `<div class="ws-msg ${mine ? 'ws-me' : 'ws-ai'}${m.system_generated ? ' ws-auto' : ''}" data-seq="${m.seq}">
      <div class="ws-msg-h"><strong>${esc(who)}</strong>${st}<span class="faint">${meta}</span><time>${esc(timeOf(m.ts))}</time></div>
      <div class="ws-msg-b">${md(m.text)}</div>${att ? `<div class="ws-msg-att">${att}</div>` : ''}${retry}${toMem}</div>`;
  }
  function renderMessages(full, appended) {
    const box = qs('#wsMsgs', S.el); if (!box) return;
    const a = curAgent();
    if (!a) { box.innerHTML = `<div class="empty">${esc(S.agents.length ? t('ws.pickAgent') : t('ws.noAgents'))}</div>`; return; }
    if (!S.selConv) { box.innerHTML = `<div class="empty">${esc(t('ws.noConv'))}<br><br><button type="button" class="btn btn-primary" id="wsFirstConv">${esc(t('ws.newConv'))}</button></div>`; qs('#wsFirstConv', box).onclick = newConversation; return; }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = S.messages.length ? S.messages.map(msgHtml).join('') : `<div class="empty">…</div>`;
    qsa('[data-hid]', box).forEach(b => b.onclick = () => { setPanel('handoffs'); const card = qs(`[data-hcard="${CSS.escape(b.dataset.hid)}"]`, S.el); card?.scrollIntoView({ block: 'nearest' }); card?.classList.add('ws-flash'); });
    qsa('[data-retry]', box).forEach(b => b.onclick = () => retryFrom(+b.dataset.retry));
    qsa('[data-tomem]', box).forEach(b => b.onclick = () => {
      const m = S.messages.find(x => x.seq === +b.dataset.tomem); if (!m) return;
      const first = m.text.split(/\r?\n/).find(l => l.trim()) || '';
      memoryEditor(curAgent()?.workdir || '', { title: clip(first.replace(/^#+\s*/, ''), 100), body: clip(m.text, 4000), tags: [curAgent()?.team_role || 'chat'] , _new: true }, null);
    });
    if (full || nearBottom || appended) scrollBottom();
  }
  function scrollBottom() { const box = qs('#wsMsgs', S.el); if (box) box.scrollTop = box.scrollHeight; }
  async function retryFrom(seq) {
    const i = S.messages.findIndex(m => m.seq === seq);
    const lastUser = S.messages.slice(0, i).reverse().find(m => m.role === 'user' && !m.system_generated);
    if (lastUser) { qs('#wsInput', S.el).value = lastUser.text; send(); }
  }

  // ---------- centre: status line + queue ----------
  function renderStatus() {
    const box = qs('#wsStatus', S.el); if (!box) return;
    const c = S.conv, a = curAgent();
    if (!c?.active_job_id || !a) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const started = c.active_started_at || S.running?.started_at;
    const elapsed = started ? since(started) : (S.running?.elapsed_sec || 0);
    const task = [...S.messages].reverse().find(m => m.role === 'user');
    const head = c.active_kind === 'compact' ? t('ws.compacting', { agent: a.name }) : t('ws.thinking', { agent: a.name });
    const keepLog = S.logOpen;
    box.innerHTML = `<div class="row ws-status-row"><span class="ws-dot ws-thinking"></span>
      <span class="ws-status-t"><strong>${esc(head)}</strong> · ${esc(t('ws.ran', { t: dur(elapsed) }))}${task ? ` · <span class="faint">${esc(clip(task.text, 70))}</span>` : ''}</span>
      <button type="button" class="btn-link" id="wsLogT">${esc(t('ws.log'))}</button>
      <button type="button" class="btn btn-sm btn-danger" id="wsStop">${esc(t('ws.stop'))}</button></div>
      ${keepLog ? `<pre class="log ws-logtail">${esc(S.running?.log_tail || '…')}</pre>` : ''}`;
    qs('#wsStop', box).onclick = stopTurn;
    qs('#wsLogT', box).onclick = () => { S.logOpen = !S.logOpen; renderStatus(); };
    const lt = qs('.ws-logtail', box); if (lt) lt.scrollTop = lt.scrollHeight;
  }
  async function stopTurn() {
    const c = S.conv, a = curAgent();
    if (!c?.active_job_id) return;
    if (!(await confirmDlg(t('ws.cStop', { name: a?.name || '' }), { danger: true }))) return;
    try { await post('chat_stop', { conversation_id: c.id }); await refreshConv(); } catch (e) { fail(e); }
  }
  function renderQueue() {
    const box = qs('#wsQueue', S.el); if (!box) return;
    const q = S.conv?.queue || [];
    box.classList.toggle('hidden', !q.length);
    if (!q.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<details><summary><span class="badge b-warn">${esc(t('ws.queue', { n: q.length }))}</span></summary>
      <ol>${q.map(x => `<li><span>${esc(clip(x.text, 140))}</span>${x.platform ? ` <span class="faint">${esc(x.platform)}</span>` : ''} <button type="button" class="ws-x-sm" data-qrm="${esc(x.id)}" aria-label="${esc(t('ws.queueRm'))}" title="${esc(t('ws.queueRm'))}">×</button></li>`).join('')}</ol></details>`;
    const open = box.dataset.open === '1';
    const det = qs('details', box); det.open = open; det.ontoggle = () => { box.dataset.open = det.open ? '1' : '0'; };
    qsa('[data-qrm]', box).forEach(b => b.onclick = async () => {
      try { const d = await post('chat_queue_remove', { conversation_id: S.conv.id, queue_id: b.dataset.qrm }); S.conv.queue = d.queue || []; renderQueue(); renderComposer(); } catch (e) { fail(e); }
    });
  }

  // ---------- composer ----------
  function renderComposer() {
    const el = S.el; if (!el) return;
    const a = curAgent();
    const comp = qs('#wsComposer', el);
    comp.classList.toggle('hidden', !a || !S.selConv);
    if (!a) return;
    const plat = qs('#wsPlat', el);
    const want = plat.dataset.forAgent === a.id && plat.value ? plat.value : (S.conv?.platform || a.platform);
    plat.innerHTML = S.platforms.map(p => `<option value="${esc(p.id)}" ${p.id === want ? 'selected' : ''} ${p.installed === false ? 'class="faint"' : ''}>${esc(p.label)}${p.installed === false ? ' ⚠' : ''}</option>`).join('');
    if (plat.dataset.forAgent !== a.id) { plat.dataset.forAgent = a.id; fillModelEffort(true); } else fillModelEffort(false);
    qs('#wsInput', el).placeholder = t('ws.ph', { agent: a.name });
    const busy = !!S.conv?.active_job_id;
    const steer = busy && (S.conv?.platform || a.platform) === 'antigravity' && S.conv?.resume?.token;
    qs('#wsSend', el).textContent = busy ? (steer ? t('ws.steer') : t('ws.enqueue')) : t('ws.send');
    renderQueue();
    renderAttachments();
  }
  function fillModelEffort(reset) {
    const el = S.el, a = curAgent(); if (!a) return;
    const p = platformById(qs('#wsPlat', el).value);
    const model = qs('#wsModel', el), effort = qs('#wsEffort', el);
    const keepM = reset ? (p?.id === a.platform ? a.model : '') : model.value;
    const keepE = reset ? (p?.id === a.platform ? a.effort : '') : effort.value;
    model.innerHTML = `<option value="">${esc(t('ws.defModel'))}</option>` + (p?.models || []).map(m => `<option ${m === keepM ? 'selected' : ''}>${esc(m)}</option>`).join('');
    effort.innerHTML = `<option value="">${esc(t('ws.defEffort'))}</option>` + (p?.efforts || []).map(m => `<option ${m === keepE ? 'selected' : ''}>${esc(m)}</option>`).join('');
    model.classList.toggle('hidden', !(p?.models || []).length);
    effort.classList.toggle('hidden', !(p?.efforts || []).length);
    qs('#wsAttachLbl', el).classList.toggle('hidden', !IMAGE_PLATFORMS.includes(p?.id));
  }
  function addAttachments(files) {
    const p = qs('#wsPlat', S.el).value;
    if (!IMAGE_PLATFORMS.includes(p)) { M.toast(t('ws.attachNo', { p }), 'warn'); return; }
    for (const file of [...files].slice(0, 3 - S.attachments.length)) {
      if (file.size > 150 * 1024) { M.toast(t('ws.attachBig', { name: file.name }), 'warn'); continue; }
      const r = new FileReader();
      r.onload = () => { S.attachments.push({ name: file.name, data_url: r.result }); renderAttachments(); };
      r.readAsDataURL(file);
    }
    qs('#wsFile', S.el).value = '';
  }
  function renderAttachments() {
    const box = qs('#wsAtt', S.el); if (!box) return;
    box.innerHTML = S.attachments.map((x, i) => `<span class="badge">📎 ${esc(x.name)} <button type="button" class="ws-x-sm" data-arm="${i}" aria-label="×">×</button></span>`).join('');
    qsa('[data-arm]', box).forEach(b => b.onclick = () => { S.attachments.splice(+b.dataset.arm, 1); renderAttachments(); });
  }
  async function send() {
    const el = S.el, a = curAgent(), c = S.conv;
    if (!a || !c) return;
    const input = qs('#wsInput', el);
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const body = { conversation_id: c.id, text, platform: qs('#wsPlat', el).value, model: qs('#wsModel', el).value, effort: qs('#wsEffort', el).value };
    if (S.attachments.length) body.attachments = S.attachments;
    const btn = qs('#wsSend', el);
    btn.disabled = true;
    try {
      const d = await post('chat_send', body);
      input.value = ''; S.attachments = [];
      if (d.queued) M.toast(t('ws.queued', { n: d.queue_len }), 'info');
      else if (d.steered) M.toast(t('ws.steered'), 'ok');
      await refreshConv();
      refreshState(true);
      schedule(1200);
    } catch (e) { fail(e); }
    btn.disabled = false;
    renderComposer();
  }

  // ---------- right column ----------
  const BUILTIN_PANELS = [
    { id: 'handoffs', key: 'ws.tab.handoffs' },
    { id: 'files', key: 'ws.tab.files', stream: 'S5' },
    { id: 'history', key: 'ws.tab.history' },
    { id: 'autorun', key: 'ws.tab.autorun', stream: 'S2' },
    { id: 'memory', key: 'ws.tab.memory' },
  ];
  function panelList() {
    const ext = S.panels.filter(p => !BUILTIN_PANELS.some(b => b.id === p.id));
    return [...BUILTIN_PANELS.map(b => ({ ...b, ext: S.panels.find(p => p.id === b.id) })), ...ext.map(p => ({ id: p.id, ext: p }))];
  }
  function setPanel(id) {
    S.panel = id; ls.set('ws_panel', id);
    if (S.mtab !== 'panel' && matchMedia('(max-width: 899px)').matches) { S.mtab = 'panel'; S.el.dataset.mtab = 'panel'; paintStatic(); }
    renderRightTabs(); renderRight();
  }
  function renderRightTabs() {
    const box = qs('#wsRTabs', S.el); if (!box) return;
    const pend = relevantHandoffs().filter(x => !TERMINAL_H.includes(x.status)).length;
    const list = panelList();
    if (!list.some(p => p.id === S.panel)) S.panel = 'handoffs';
    box.innerHTML = list.map(p => {
      const title = p.ext?.title ? (typeof p.ext.title === 'function' ? p.ext.title() : p.ext.title) : t(p.key);
      return `<button type="button" role="tab" data-panel-id="${esc(p.id)}" aria-selected="${p.id === S.panel}">${esc(title)}${p.id === 'handoffs' && pend ? ` <span class="count">${pend}</span>` : ''}</button>`;
    }).join('');
    qsa('[data-panel-id]', box).forEach(b => b.onclick = () => setPanel(b.dataset.panelId));
  }
  function renderRight() {
    const box = qs('#wsRBody', S.el); if (!box) return;
    const p = panelList().find(x => x.id === S.panel) || panelList()[0];
    if (p.ext) {
      const a = curAgent();
      try { p.ext.render(box, { agent: a, conversation: S.conv, project_path: a?.workdir || M.project()?.path || '' }); } catch (e) { console.error(`[ws panel ${p.id}]`, e); box.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; }
      return;
    }
    if (p.id === 'handoffs') return renderHandoffs(box);
    if (p.id === 'history') return renderHistory(box);
    if (p.id === 'memory') return renderMemory(box);
    box.innerHTML = `<div class="ws-ph"><div class="ws-ph-i" aria-hidden="true">⧉</div><p>${esc(t('ws.placeholder', { s: p.stream }))}</p></div>`;
  }
  function renderHistory(box) {
    const turns = S.messages.filter(m => m.role === 'assistant');
    if (!turns.length) { box.innerHTML = `<div class="empty">${esc(t('ws.hist.empty'))}</div>`; return; }
    box.innerHTML = `<table class="ws-table"><thead><tr><th>${esc(t('ws.h.time'))}</th><th>Model</th><th>${esc(t('ws.h.status'))}</th><th>${esc(t('ws.h.cost'))}</th></tr></thead><tbody>
      ${turns.slice().reverse().map(m => `<tr><td>${esc(timeOf(m.ts))}${m.duration_sec ? ` <span class="faint">${dur(m.duration_sec)}</span>` : ''}</td><td class="mono">${esc(m.actual_model || m.model || m.platform || '')}</td><td>${esc(m.status || '')}</td><td>${esc(money(m.cost_usd))}</td></tr>`).join('')}
      </tbody></table>`;
  }

  // ---------- project memory (N7): .maw/memory/decisions.md of the agent's workdir ----------
  const MEM = { project: '', entries: [], q: '', at: 0, loading: false, err: '' };
  async function loadMemory(force) {
    const project = curAgent()?.workdir || M.project()?.path || '';
    if (!project) { MEM.entries = []; MEM.project = ''; return; }
    if (!force && project === MEM.project && Date.now() - MEM.at < 15000) return;
    MEM.loading = true;
    try {
      const d = await get('memory_list', { project_path: project });
      MEM.entries = d.entries || []; MEM.project = project; MEM.at = Date.now(); MEM.err = '';
    } catch (e) { MEM.err = errMsg(e); MEM.entries = []; MEM.project = project; }
    MEM.loading = false;
  }
  async function renderMemory(box, force) {
    const project = curAgent()?.workdir || M.project()?.path || '';
    if (!project) { box.innerHTML = `<div class="empty">${esc(t('ws.pickAgent'))}</div>`; return; }
    if (force || project !== MEM.project || Date.now() - MEM.at >= 15000) {
      box.innerHTML = '<div class="empty">…</div>';
      await loadMemory(force);
      if (S.panel !== 'memory') return;
    }
    const q = MEM.q.trim().toLowerCase();
    const list = MEM.entries.filter(e => !q || `${e.title} ${e.body} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    box.innerHTML = `<div class="ws-mem-h"><input class="input" type="search" id="wsMemQ" placeholder="${esc(t('ws.mem.search'))}" value="${esc(MEM.q)}">
        <button type="button" class="btn btn-sm btn-primary" id="wsMemAdd">${esc(t('ws.mem.add'))}</button></div>
      <p class="sub faint ws-pad ws-path">${esc(t('ws.mem.file'))} <span class="mono">.maw/memory/decisions.md</span></p>
      ${MEM.err ? `<div class="empty t-err">${esc(MEM.err)}</div>` : ''}
      ${list.length ? list.map(e => `<article class="ws-mem" data-mem="${esc(e.id)}">
        <div class="row"><button type="button" class="ws-star ${e.pinned ? 'on' : ''}" data-mpin="${esc(e.id)}" aria-pressed="${!!e.pinned}" title="${esc(t(e.pinned ? 'ws.mem.unpin' : 'ws.mem.pin'))}" aria-label="${esc(t(e.pinned ? 'ws.mem.unpin' : 'ws.mem.pin'))}">${e.pinned ? '📌' : '📍'}</button>
          <strong class="ws-grow">${esc(e.id)} · ${esc(e.title)}</strong>
          <button type="button" class="ws-more" data-medit="${esc(e.id)}" aria-label="${esc(t('ws.mem.edit'))}" title="${esc(t('ws.mem.edit'))}">✎</button>
          <button type="button" class="ws-more" data-mdel="${esc(e.id)}" aria-label="${esc(t('ws.m.del'))}" title="${esc(t('ws.m.del'))}">×</button></div>
        <div class="faint ws-hid">${esc(e.date || '')}${e.source ? ' · ' + esc(e.source) : ''}${e.agent ? ' · ' + esc(e.agent) : ''}${(e.tags || []).length ? ' · ' + e.tags.map(x => '#' + esc(x)).join(' ') : ''}</div>
        <p class="ws-hsum">${esc(clip(e.body, 600))}</p></article>`).join('') : (MEM.err ? '' : `<div class="empty">${esc(t('ws.mem.empty'))}</div>`)}`;
    const qi = qs('#wsMemQ', box);
    qi.oninput = () => { MEM.q = qi.value; const pos = qi.selectionStart; renderMemory(box).then(() => { const n = qs('#wsMemQ', box); n?.focus(); n?.setSelectionRange(pos, pos); }); };
    qs('#wsMemAdd', box).onclick = () => memoryEditor(project, null, box);
    qsa('[data-medit]', box).forEach(b => b.onclick = () => memoryEditor(project, MEM.entries.find(e => e.id === b.dataset.medit), box));
    qsa('[data-mpin]', box).forEach(b => b.onclick = async () => {
      const e = MEM.entries.find(x => x.id === b.dataset.mpin); if (!e) return;
      try { await post('memory_update', { project_path: project, id: e.id, pinned: !e.pinned }); renderMemory(box, true); } catch (err) { fail(err); }
    });
    qsa('[data-mdel]', box).forEach(b => b.onclick = async () => {
      const e = MEM.entries.find(x => x.id === b.dataset.mdel); if (!e) return;
      if (!(await confirmDlg(t('ws.mem.cDel', { id: e.id, title: e.title }), { danger: true }))) return;
      try { await post('memory_delete', { project_path: project, id: e.id }); renderMemory(box, true); } catch (err) { fail(err); }
    });
  }
  function memoryEditor(project, e, box) {
    const f = h('form', { class: 'ws-form' });
    f.innerHTML = `<label class="ws-f"><span>${esc(t('ws.mem.title'))}</span><input class="input" name="title" maxlength="120" required value="${esc(e?.title || '')}"></label>
      <label class="ws-f"><span>${esc(t('ws.mem.body'))}</span><textarea name="body" rows="8" maxlength="4000" required>${esc(e?.body || '')}</textarea></label>
      <label class="ws-f"><span>${esc(t('ws.mem.tags'))}</span><input class="input" name="tags" value="${esc((e?.tags || []).join(', '))}"></label>
      <label class="ws-check"><input type="checkbox" name="pinned" ${e?.pinned ? 'checked' : ''}> ${esc(t('ws.mem.pin'))}</label>`;
    dialog({
      title: e && !e._new ? `${e.id} · ${t('ws.mem.edit')}` : t('ws.mem.add'), body: f,
      actions: [{ label: t('ws.cancel'), submit: true }, { label: t('ws.save'), primary: true, run: async () => {
        if (!f.reportValidity()) return false;
        const body = { project_path: project, title: f.title.value.trim(), body: f.body.value.trim(), tags: f.tags.value.split(/[,\s]+/).map(s => s.replace(/^#/, '')).filter(Boolean).slice(0, 10), pinned: f.pinned.checked };
        if (e && !e._new) await post('memory_update', { ...body, id: e.id }); else await post('memory_add', { ...body, source: e?._new ? `chat:${S.selConv}` : 'user', agent: curAgent()?.platform || '' });
        MEM.at = 0;
        if (box && S.panel === 'memory') renderMemory(box, true); else M.toast(t('ws.saved'), 'ok');
      } }],
    });
    setTimeout(() => f.title.focus(), 0);
  }

  // handoffs relevant to the open conversation: as Lead, or as the member
  function relevantHandoffs() {
    const c = S.conv; if (!c) return [];
    return S.handoffs.filter(x => x.lead_conversation_id === c.id || x.member_conversation_id === c.id);
  }
  const hStatusCls = s => s === 'completed' ? 'b-ok' : s === 'running' || s === 'started' ? 'b-warn' : s === 'cancelled' ? '' : s === 'needs_review' || s === 'blocked' ? 'b-warn' : 'b-err';
  const hStatusLabel = s => ({
    vi: { started: 'đang chờ', running: 'đang chạy', completed: 'xong', failed: 'lỗi', blocked: 'bị chặn', needs_review: 'cần xem lại', cancelled: 'đã huỷ' },
    en: { started: 'waiting', running: 'running', completed: 'done', failed: 'failed', blocked: 'blocked', needs_review: 'needs review', cancelled: 'cancelled' },
  })[M.lang === 'en' ? 'en' : 'vi'][s] || s;
  function renderHandoffs(box) {
    const list = relevantHandoffs();
    const a = curAgent();
    const pend = list.filter(x => !TERMINAL_H.includes(x.status));
    const done = list.filter(x => TERMINAL_H.includes(x.status));
    const manual = a?.team_id ? `<button type="button" class="btn btn-sm" id="wsManual">${esc(t('ws.h.manual'))}</button>` : '';
    if (!list.length) { box.innerHTML = `<div class="empty">${esc(t('ws.noHandoffs'))}</div>${manual ? `<div class="ws-pad">${manual}</div>` : ''}`; qs('#wsManual', box)?.addEventListener('click', manualDispatch); return; }
    box.innerHTML = `
      <div class="ws-hsec"><div class="ws-hsec-h">${esc(t('ws.pending', { n: pend.length }))} ${manual}</div>
        ${pend.map(x => `<div class="ws-hp" data-hcard="${esc(x.id)}"><span class="ws-dot ${x.status === 'running' ? 'ws-thinking' : 'ws-waiting'}"></span>
          <span class="ws-grow"><strong>${esc(x.to_role)}</strong> · ${esc(agentById(x.to)?.name || x.to)} <span class="faint mono">${esc(x.id)}</span><br><span class="faint">${esc(clip(x.task, 110))}</span></span>
          <span class="faint">${x.started_at ? dur(since(x.started_at)) : ''}</span>
          <button type="button" class="btn btn-sm btn-danger" data-hcancel="${esc(x.id)}">${esc(t('ws.h.cancel'))}</button></div>`).join('') || '<div class="faint ws-pad">—</div>'}
      </div>
      <div class="ws-hsec"><div class="ws-hsec-h">${esc(t('ws.done'))} (${done.length})</div>${done.map(handoffCard).join('')}</div>
      ${done.length ? summaryTable(list) : ''}`;
    qs('#wsManual', box)?.addEventListener('click', manualDispatch);
    qsa('[data-hcancel]', box).forEach(b => b.onclick = async () => { if (await confirmDlg(t('ws.cCancelH', { id: b.dataset.hcancel }), { danger: true })) { await post('handoff_cancel', { id: b.dataset.hcancel }).catch(fail); refreshHandoffs(); } });
    qsa('[data-hretry]', box).forEach(b => b.onclick = async () => { await post('handoff_retry', { id: b.dataset.hretry }).catch(fail); refreshHandoffs(); });
    qsa('[data-haccept]', box).forEach(b => b.onclick = async () => { if (await confirmDlg(t('ws.cAccept', { id: b.dataset.haccept }))) { await post('handoff_accept', { id: b.dataset.haccept }).catch(fail); refreshHandoffs(); } });
    qsa('[data-hopen]', box).forEach(b => b.onclick = () => openConversationById(b.dataset.hopen));
    qsa('[data-hmerge]', box).forEach(b => b.onclick = async () => {
      const x = list.find(y => y.id === b.dataset.hmerge);
      if (!x || !(await confirmDlg(`${t('ws.h.merge')}: ${x.branch}?`))) return;
      try { outputDlg(t('ws.h.merge'), await post('worktree_merge', { project_path: agentById(x.from)?.workdir || '', branch: x.branch, worktree: x.worktree, strategy: 'merge' })); } catch (e) { fail(e); }
    });
  }
  function handoffCard(x) {
    const r = x.result || {};
    const ag = agentById(x.to);
    const files = r.files_changed || [];
    return `<article class="ws-hcard" data-hcard="${esc(x.id)}">
      <div class="row ws-hcard-h"><span class="badge ${hStatusCls(x.status)}">${esc(hStatusLabel(x.status))}</span><strong>${esc(x.to_role)}</strong><span class="faint">${esc(ag?.name || x.to)} · ${esc(x.actual_model || x.platform || '')}</span>
        <span class="ws-grow"></span><span class="faint">${dur(x.duration_sec)} · ${esc(money(r.cost))}</span></div>
      <div class="faint mono ws-hid">${esc(x.id)} · ${esc(x.isolated ? `${t('ws.h.isolated')} ${x.branch || ''}` : t('ws.h.shared'))}</div>
      ${r.summary ? `<p class="ws-hsum">${esc(r.summary)}</p>` : ''}
      ${x.parse_error ? `<p class="t-warn">${esc(t('ws.h.parse'))}: ${esc(x.parse_error)}</p>` : ''}
      ${(x.scope_violations || []).length ? `<div class="t-err"><strong>${esc(t('ws.h.scope'))}:</strong> <span class="mono">${x.scope_violations.map(esc).join(', ')}</span></div>` : ''}
      ${files.length ? `<details><summary>${esc(t('ws.h.files'))} (${files.length})</summary><div class="ws-files mono">${files.slice(0, 100).map(f => `<span>${esc(f)}</span>`).join('')}</div></details>` : ''}
      ${r.evidence ? `<details><summary>${esc(t('ws.h.evidence'))}</summary><pre class="ws-pre">${esc(r.evidence)}</pre></details>` : ''}
      ${(r.blockers || []).length ? `<div><strong>${esc(t('ws.h.blockers'))}:</strong><ul class="ws-blockers">${r.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      <div class="row-wrap ws-hact">
        ${x.status === 'needs_review' ? `<button type="button" class="btn btn-sm" data-haccept="${esc(x.id)}">${esc(t('ws.h.accept'))}</button>` : ''}
        ${['failed', 'blocked', 'needs_review', 'cancelled'].includes(x.status) ? `<button type="button" class="btn btn-sm" data-hretry="${esc(x.id)}">${esc(t('ws.h.retry'))}</button>` : ''}
        ${x.member_conversation_id ? `<button type="button" class="btn btn-sm" data-hopen="${esc(x.member_conversation_id)}">${esc(t('ws.h.open'))}</button>` : ''}
        ${x.status === 'completed' && x.isolated && x.branch && has('worktrees') ? `<button type="button" class="btn btn-sm btn-primary" data-hmerge="${esc(x.id)}">${esc(t('ws.h.merge'))}</button>` : ''}
      </div></article>`;
  }
  function summaryTable(list) {
    const total = list.reduce((s, x) => s + (Number(x.result?.cost) || 0), 0);
    return `<div class="ws-hsec"><div class="ws-hsec-h">${esc(t('ws.summaryTable'))}</div><div class="ws-tablewrap"><table class="ws-table"><thead><tr>
      <th>${esc(t('ws.h.role'))}</th><th>${esc(t('ws.h.agent'))}</th><th>${esc(t('ws.h.status'))}</th><th>${esc(t('ws.h.time'))}</th><th>${esc(t('ws.h.files'))}</th><th>${esc(t('ws.h.cost'))}</th></tr></thead><tbody>
      ${list.map(x => `<tr><td>${esc(x.to_role)}</td><td>${esc(agentById(x.to)?.name || x.to)}</td><td><span class="badge ${hStatusCls(x.status)}">${esc(hStatusLabel(x.status))}</span></td><td>${x.duration_sec != null ? dur(x.duration_sec) : '—'}</td><td>${(x.result?.files_changed || []).length}</td><td>${esc(money(x.result?.cost))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">Σ ${list.length}</td><td>${esc(money(total))}</td></tr></tfoot></table></div></div>`;
  }
  function manualDispatch() {
    const a = curAgent(), c = S.conv;
    if (!a?.team_id || !c) { M.toast(t('ws.h.noTeam'), 'warn'); return; }
    const members = S.agents.filter(x => x.team_id === a.team_id && x.id !== a.id);
    const f = h('form', { class: 'ws-form' });
    f.innerHTML = `<label class="ws-f"><span>${esc(t('ws.h.to'))}</span><select name="to">${members.map(m => `<option value="${esc(m.team_role || m.id)}">${esc(m.team_role || '')} · ${esc(m.name)}</option>`).join('')}</select></label>
      <label class="ws-f"><span>${esc(t('ws.h.task'))}</span><textarea name="task" rows="5" maxlength="8000" required></textarea></label>`;
    dialog({
      title: t('ws.h.manual'), body: f,
      actions: [{ label: t('ws.cancel'), submit: true }, { label: t('ws.h.dispatch'), primary: true, run: async () => {
        if (!f.reportValidity()) return false;
        await post('handoff_dispatch', { lead_conversation_id: c.id, to: f.to.value, task: f.task.value.trim() });
        refreshHandoffs();
      } }],
    });
  }

  // ---------- view (registered last: addView() renders synchronously) ----------
  M.addView({
    id: 'workspace',
    title: () => t('ws.view'),
    render(el) { S.el = el; buildSkeleton(el); },
    onShow() { fitHeight(); refreshState(); refreshConv(); schedule(0); },
  });

  // Lets feat-teams.js / feat-palette.js start once the workspace exists.
  const q = window.MAW_WS_READY || [];
  window.MAW_WS_READY = { push: fn => { try { fn(M.ws); } catch (e) { console.error('[workspace ready]', e); } } };
  for (const fn of q) window.MAW_WS_READY.push(fn);
})();
