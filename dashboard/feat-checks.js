// S4 — Test gate + Checks panel (B8). Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { esc, t } = M;

  M.addI18n('vi', {
    s4cTab: 'Kiểm tra', s4cGate: 'Cổng chất lượng', s4cGreen: 'XANH — được merge', s4cRed: 'ĐỎ — chặn merge', s4cRunning: 'Đang chạy kiểm tra…',
    s4cPick: 'Chọn một dự án để xem kiểm tra.', s4cRun: 'Chạy kiểm tra', s4cCancel: 'Dừng', s4cRefresh: 'Làm mới', s4cOverride: 'Bỏ qua cổng…',
    s4cItem_git: 'Git sạch', s4cItem_spec_guard: 'SPEC Guard', s4cItem_review: 'Điểm review gần nhất', s4cItem_todo: 'TODO còn mở',
    s4cState_pass: 'đạt', s4cState_fail: 'lỗi', s4cState_warn: 'chú ý', s4cState_skip: 'bỏ qua', s4cState_running: 'đang chạy', s4cState_untrusted: 'chưa tin cậy', s4cState_timeout: 'quá giờ',
    s4cConfig: 'Cấu hình kiểm tra (.maw/checks.json)', s4cNoConfig: 'Dự án chưa có .maw/checks.json. Bấm "Dò tự động" để đề xuất, rồi Lưu.',
    s4cDetect: 'Dò tự động', s4cAddCheck: '+ Thêm lệnh', s4cSave: 'Lưu cấu hình', s4cTrust: 'Tin cậy cấu hình này',
    s4cUntrusted: 'Cấu hình trong repo đã thay đổi (sha {sha}). Xem lại các lệnh rồi bấm "Tin cậy" trước khi chạy.',
    s4cTrustConfirm: 'Cho phép chạy các lệnh trong .maw/checks.json của dự án này?\n\n{cmds}',
    s4cId: 'Mã', s4cLabel: 'Tên', s4cCommand: 'Lệnh (mỗi đối số cách nhau bằng dấu cách; dùng "…" cho đối số có dấu cách)', s4cTimeout: 'Giới hạn (giây)', s4cRequired: 'Bắt buộc',
    s4cRequireClean: 'Bắt buộc git sạch', s4cMinScore: 'Điểm review tối thiểu (0 = bỏ qua)', s4cTodoMax: 'Số TODO tối đa (-1 = chỉ báo cáo)', s4cTodoPatterns: 'Mẫu TODO', s4cSpecGuard: 'Chạy SPEC Guard',
    s4cOutput: 'Kết quả', s4cAt: 'lúc {time}', s4cStale: 'cũ — mã đã đổi, hãy chạy lại', s4cSaved: 'Đã lưu.', s4cStarted: 'Đã bắt đầu chạy kiểm tra.',
    s4cOverrideReason: 'Lý do bỏ qua cổng (bắt buộc, được ghi vào audit):', s4cOverrideConfirm: 'Bỏ qua cổng đỏ cho lần merge kế tiếp (15 phút)?', s4cOverrideDone: 'Đã cấp quyền bỏ qua đến {time}.',
    s4cCancelConfirm: 'Dừng các lệnh kiểm tra đang chạy?', s4cDelete: 'Xoá', s4cBranch: 'Nhánh', s4cHead: 'HEAD', s4cRunProj: 'Chạy kiểm tra',
    s4cInvalid: 'Cấu hình không hợp lệ: {f}', s4cDetected: 'Đã đề xuất cấu hình — xem lại rồi bấm Lưu.', s4cNothingDetected: 'Không dò được lệnh nào.',
  });
  M.addI18n('en', {
    s4cTab: 'Checks', s4cGate: 'Quality gate', s4cGreen: 'GREEN — ok to merge', s4cRed: 'RED — merge blocked', s4cRunning: 'Running checks…',
    s4cPick: 'Pick a project to see its checks.', s4cRun: 'Run checks', s4cCancel: 'Stop', s4cRefresh: 'Refresh', s4cOverride: 'Override gate…',
    s4cItem_git: 'Git clean', s4cItem_spec_guard: 'SPEC Guard', s4cItem_review: 'Last review score', s4cItem_todo: 'Open TODOs',
    s4cState_pass: 'pass', s4cState_fail: 'fail', s4cState_warn: 'warn', s4cState_skip: 'skip', s4cState_running: 'running', s4cState_untrusted: 'untrusted', s4cState_timeout: 'timeout',
    s4cConfig: 'Check configuration (.maw/checks.json)', s4cNoConfig: 'This project has no .maw/checks.json yet. Click "Detect" for a proposal, then Save.',
    s4cDetect: 'Detect', s4cAddCheck: '+ Add command', s4cSave: 'Save config', s4cTrust: 'Trust this config',
    s4cUntrusted: 'The config in the repo changed (sha {sha}). Review the commands, then click "Trust" before running them.',
    s4cTrustConfirm: 'Allow the commands in this project\'s .maw/checks.json to run?\n\n{cmds}',
    s4cId: 'Id', s4cLabel: 'Label', s4cCommand: 'Command (arguments separated by spaces; use "…" for an argument with spaces)', s4cTimeout: 'Timeout (s)', s4cRequired: 'Required',
    s4cRequireClean: 'Require a clean git tree', s4cMinScore: 'Minimum review score (0 = ignore)', s4cTodoMax: 'Max TODOs (-1 = report only)', s4cTodoPatterns: 'TODO patterns', s4cSpecGuard: 'Run SPEC Guard',
    s4cOutput: 'Output', s4cAt: 'at {time}', s4cStale: 'stale — code changed, re-run', s4cSaved: 'Saved.', s4cStarted: 'Checks started.',
    s4cOverrideReason: 'Reason for overriding the gate (required, written to the audit):', s4cOverrideConfirm: 'Override the red gate for the next merge (15 minutes)?', s4cOverrideDone: 'Override granted until {time}.',
    s4cCancelConfirm: 'Stop the running checks?', s4cDelete: 'Delete', s4cBranch: 'Branch', s4cHead: 'HEAD', s4cRunProj: 'Run checks',
    s4cInvalid: 'Invalid config: {f}', s4cDetected: 'Config proposed — review it, then click Save.', s4cNothingDetected: 'No command could be detected.',
  });

  const STATE_CLS = { pass: 'b-ok', fail: 'b-err', timeout: 'b-err', untrusted: 'b-err', warn: 'b-warn', running: 'b-info', skip: '' };
  const DOT_CLS = { pass: 'ok', fail: 'err', timeout: 'err', untrusted: 'err', warn: 'warn', running: 'warn live', skip: '' };
  const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

  const hhmm = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(M.lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  };
  const get = (action, params) => M.api(action + Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join(''));
  // Command line <-> argument array. Quotes group an argument; nothing is ever passed to a shell.
  const toArgs = line => {
    const out = []; let cur = '', q = false, has = false;
    for (const ch of String(line)) {
      if (ch === '"') { q = !q; has = true; continue; }
      if (!q && /\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
      cur += ch; has = true;
    }
    if (has || cur) out.push(cur);
    return out;
  };
  const toLine = args => (args || []).map(a => /[\s"]/.test(a) || a === '' ? `"${String(a).replace(/"/g, '')}"` : a).join(' ');
  const itemLabel = it => t('s4cItem_' + it.id) !== 's4cItem_' + it.id ? t('s4cItem_' + it.id) : (it.label || it.id);

  const S = { panel: null, builtLang: '', project: '', status: null, cfg: null, draft: null, poll: null, open: new Set(), busy: false };

  const tab = M.addTab({ id: 'checks', title: () => t('s4cTab'), render: panel => render(panel) });

  M.addProjectAction({
    id: 's4-run-checks',
    label: () => '✓ ' + t('s4cRunProj'),
    run: p => { runChecks(p.path); const b = document.querySelector('#tabsCard [data-tab="checks"]'); if (b) b.click(); },
  });

  M.on('data', d => {
    const last = d?.feature_data?.checks?.last || {};
    const p = M.project();
    const g = p ? last[p.path] : null;
    tab?.setCount(g && g.green === false ? '!' : '');
  });
  M.on('project-change', () => { S.project = ''; if (S.panel) render(S.panel); });

  function render(panel) {
    S.panel = panel;
    const p = M.project();
    const key = p?.path || '';
    if (S.builtLang !== M.lang || S.project !== key) build(panel, p);
    else if (!panel.classList.contains('hidden') && !S.poll) loadStatus(false);
  }

  function build(panel, p) {
    S.builtLang = M.lang; S.project = p?.path || ''; S.status = null; S.cfg = null; S.draft = null;
    stopPoll();
    if (!p) { panel.innerHTML = `<div class="empty">${esc(t('s4cPick'))}</div>`; return; }
    panel.innerHTML = `
      <div class="s4-body">
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4cGate'))}</h3><span data-r="verdict"></span><span class="sub" data-r="where"></span><span class="spacer"></span>
            <button type="button" class="btn btn-sm" data-act="refresh">${esc(t('s4cRefresh'))}</button>
            <button type="button" class="btn btn-sm btn-primary" data-act="run">${esc(t('s4cRun'))}</button>
            <button type="button" class="btn btn-sm hidden" data-act="cancel">${esc(t('s4cCancel'))}</button>
            <button type="button" class="btn btn-sm btn-danger hidden" data-act="override">${esc(t('s4cOverride'))}</button></div>
          <div data-r="items"></div>
        </section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4cConfig'))}</h3><span class="spacer"></span>
            <button type="button" class="btn btn-sm" data-act="detect">${esc(t('s4cDetect'))}</button>
            <button type="button" class="btn btn-sm hidden" data-act="trust">${esc(t('s4cTrust'))}</button>
            <button type="button" class="btn btn-sm btn-primary" data-act="save">${esc(t('s4cSave'))}</button></div>
          <div data-r="cfgmsg"></div>
          <div data-r="cfg"></div>
        </section>
      </div>`;
    if (!panel.dataset.s4bound) { panel.dataset.s4bound = '1'; panel.addEventListener('click', onClick); }
    loadConfig();
    loadStatus(true);
  }
  const R = n => S.panel?.querySelector(`[data-r="${n}"]`);
  const A = n => S.panel?.querySelector(`[data-act="${n}"]`);

  // ---- status / gate -------------------------------------------------------
  async function loadStatus(refresh) {
    const path = S.project; if (!path) return;
    try {
      const st = await get('checks_status', { project_path: path, refresh: refresh ? 1 : 0 });
      if (path !== S.project) return;
      S.status = st;
      paintStatus();
      if (st.running) startPoll(); else stopPoll();
    } catch (e) {
      const box = R('items'); if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      stopPoll();
    }
  }
  function startPoll() { if (!S.poll) S.poll = setInterval(() => { if (!document.hidden) loadStatus(false); }, 2500); }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

  function paintStatus() {
    const st = S.status; if (!st) return;
    const g = st.gate || { green: false, items: [] };
    R('verdict').innerHTML = st.running ? M.badge(t('s4cRunning'), 'b-info') : M.badge(g.green ? t('s4cGreen') : t('s4cRed'), g.green ? 'b-ok' : 'b-err');
    R('where').textContent = [st.branch ? `${t('s4cBranch')}: ${st.branch}` : '', st.head ? `${t('s4cHead')} ${String(st.head).slice(0, 8)}` : ''].filter(Boolean).join(' · ');
    A('run').classList.toggle('hidden', !!st.running);
    A('cancel').classList.toggle('hidden', !st.running);
    A('override').classList.toggle('hidden', !!st.running || g.green);
    const results = Object.fromEntries((st.results || []).map(r => [r.id, r]));
    const items = g.items || [];
    R('items').innerHTML = items.length ? `<div class="s4c-list">${items.map(it => {
      const r = results[it.id];
      const out = r?.output_tail ? `<button type="button" class="btn-link s4c-more" data-act="toggle" data-id="${esc(it.id)}" aria-expanded="${S.open.has(it.id)}">${esc(t('s4cOutput'))}</button>` : '';
      const meta = [r?.exit_code != null ? 'exit ' + r.exit_code : '', r?.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '', it.at || r?.at ? t('s4cAt', { time: hhmm(it.at || r.at) }) : ''].filter(Boolean).join(' · ');
      return `<div class="s4c-item" data-state="${esc(it.state)}">
        <span class="dot ${DOT_CLS[it.state] || ''}"></span>
        <div class="s4c-main"><div class="row-wrap s4-gap-s"><b>${esc(itemLabel(it))}</b>${M.badge(t('s4cState_' + it.state), STATE_CLS[it.state] || '')}<span class="sub">${esc(meta)}</span>${out}</div>
          ${it.detail ? `<div class="sub s4c-detail">${esc(it.detail)}</div>` : ''}
          ${r?.output_tail && S.open.has(it.id) ? `<pre class="log s4c-log">${esc(r.output_tail)}</pre>` : ''}</div></div>`;
    }).join('')}</div>` : `<div class="empty">—</div>`;
  }

  async function runChecks(path) {
    path = path || S.project; if (!path) return;
    try {
      await M.api('checks_run', { project_path: path });
      M.toast(t('s4cStarted'), 'ok');
      if (path === S.project) { await loadStatus(false); startPoll(); }
    } catch (e) { M.toast(e.message, e.message?.includes('trust') ? 'warn' : 'err'); }
  }

  // ---- config editor -------------------------------------------------------
  async function loadConfig() {
    const path = S.project; if (!path) return;
    try {
      const c = await get('checks_config', { project_path: path });
      if (path !== S.project) return;
      S.cfg = c;
      S.draft = structuredClone(c.config || c.detected || defaultCfg());
      if (!c.exists && !c.config) S.draft.checks = [];
      paintConfig();
    } catch (e) { R('cfg').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  const defaultCfg = () => ({ version: 1, checks: [], todo_patterns: ['TODO', 'FIXME', 'XXX', 'HACK'], todo_max: -1, require_clean_git: false, min_review_score: 8.5, spec_guard: true });

  function paintConfig() {
    const c = S.cfg, d = S.draft; if (!d) return;
    const msg = !c?.exists ? `<div class="callout">${esc(t('s4cNoConfig'))}</div>`
      : c.trusted === false ? `<div class="callout s4c-warn">${esc(t('s4cUntrusted', { sha: String(c.sha256 || '').slice(0, 12) }))}</div>` : '';
    R('cfgmsg').innerHTML = msg;
    A('trust').classList.toggle('hidden', !(c?.exists && c.trusted === false));
    R('cfg').innerHTML = `
      <div class="table-wrap s4-mt"><table class="s4-form-table"><thead><tr><th>${esc(t('s4cId'))}</th><th>${esc(t('s4cLabel'))}</th><th>${esc(t('s4cCommand'))}</th><th>${esc(t('s4cTimeout'))}</th><th>${esc(t('s4cRequired'))}</th><th></th></tr></thead>
      <tbody>${(d.checks || []).map((ck, i) => `<tr data-i="${i}">
        <td><input class="input s4c-id" data-k="id" value="${esc(ck.id)}" spellcheck="false" aria-label="${esc(t('s4cId'))}"></td>
        <td><input class="input" data-k="label" value="${esc(ck.label || '')}" aria-label="${esc(t('s4cLabel'))}"></td>
        <td><input class="input s4-mono s4c-cmd" data-k="command" value="${esc(toLine(ck.command))}" spellcheck="false" aria-label="${esc(t('s4cCommand'))}"></td>
        <td><input class="input s4-num" type="number" min="5" max="3600" data-k="timeout_s" value="${esc(ck.timeout_s ?? 600)}" aria-label="${esc(t('s4cTimeout'))}"></td>
        <td><input type="checkbox" data-k="required" ${ck.required !== false ? 'checked' : ''} aria-label="${esc(t('s4cRequired'))}"></td>
        <td><button type="button" class="btn btn-sm btn-link danger" data-act="del" data-i="${i}">${esc(t('s4cDelete'))}</button></td></tr>`).join('')}
      </tbody></table></div>
      <button type="button" class="btn btn-sm s4-mt" data-act="add">${esc(t('s4cAddCheck'))}</button>
      <div class="s4-fields s4-mt">
        <label class="s4-lbl">${esc(t('s4cTodoPatterns'))}<input class="input" data-g="todo_patterns" value="${esc((d.todo_patterns || []).join(', '))}"></label>
        <label class="s4-lbl">${esc(t('s4cTodoMax'))}<input class="input s4-num" type="number" min="-1" data-g="todo_max" value="${esc(d.todo_max ?? -1)}"></label>
        <label class="s4-lbl">${esc(t('s4cMinScore'))}<input class="input s4-num" type="number" min="0" max="10" step="0.1" data-g="min_review_score" value="${esc(d.min_review_score ?? 8.5)}"></label>
      </div>
      <div class="row-wrap s4-gap s4-mt">
        <label class="check"><input type="checkbox" data-g="require_clean_git" ${d.require_clean_git ? 'checked' : ''}> ${esc(t('s4cRequireClean'))}</label>
        <label class="check"><input type="checkbox" data-g="spec_guard" ${d.spec_guard !== false ? 'checked' : ''}> ${esc(t('s4cSpecGuard'))}</label>
      </div>`;
  }

  // Reads the editor back into S.draft; returns a list of problems.
  function collect() {
    const d = S.draft, bad = [], seen = new Set();
    d.checks = [...S.panel.querySelectorAll('[data-r="cfg"] tbody tr')].map(tr => {
      const v = k => tr.querySelector(`[data-k="${k}"]`);
      const ck = {
        id: v('id').value.trim(), label: v('label').value.trim(), command: toArgs(v('command').value),
        timeout_s: Math.round(Number(v('timeout_s').value) || 600), required: v('required').checked,
      };
      const old = (S.draft.checks || [])[Number(tr.dataset.i)];
      if (old?.cwd) ck.cwd = old.cwd;
      if (!ID_RE.test(ck.id) || seen.has(ck.id)) bad.push(`${t('s4cId')} "${ck.id}"`);
      seen.add(ck.id);
      if (!ck.command.length) bad.push(`${ck.id || '?'}: ${t('s4cCommand').split(' (')[0]}`);
      if (ck.timeout_s < 5 || ck.timeout_s > 3600) bad.push(`${ck.id}: ${t('s4cTimeout')}`);
      if (!ck.label) ck.label = toLine(ck.command);
      return ck;
    });
    if (d.checks.length > 20) bad.push('max 20');
    const g = k => S.panel.querySelector(`[data-g="${k}"]`);
    d.todo_patterns = g('todo_patterns').value.split(',').map(s => s.trim()).filter(Boolean);
    d.todo_max = Math.round(Number(g('todo_max').value));
    if (!Number.isInteger(d.todo_max) || d.todo_max < -1) bad.push(t('s4cTodoMax'));
    d.min_review_score = Number(g('min_review_score').value);
    if (!(d.min_review_score >= 0 && d.min_review_score <= 10)) bad.push(t('s4cMinScore'));
    d.require_clean_git = g('require_clean_git').checked;
    d.spec_guard = g('spec_guard').checked;
    d.version = d.version || 1;
    return bad;
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || S.busy) return;
    const act = b.dataset.act, path = S.project;
    if (act === 'toggle') { S.open.has(b.dataset.id) ? S.open.delete(b.dataset.id) : S.open.add(b.dataset.id); paintStatus(); return; }
    if (act === 'refresh') { loadStatus(true); loadConfig(); return; }
    if (act === 'run') { runChecks(); return; }
    if (act === 'add') { collect(); S.draft.checks.push({ id: 'check' + (S.draft.checks.length + 1), label: '', command: [], timeout_s: 600, required: true }); paintConfig(); return; }
    if (act === 'del') { collect(); S.draft.checks.splice(Number(b.dataset.i), 1); paintConfig(); return; }
    S.busy = true; b.disabled = true;
    try {
      if (act === 'cancel') {
        if (confirm(t('s4cCancelConfirm'))) { await M.api('checks_cancel', { project_path: path }); await loadStatus(false); }
      } else if (act === 'detect') {
        const c = await get('checks_config', { project_path: path });
        if (c.detected?.checks?.length) { S.draft = structuredClone(c.detected); paintConfig(); M.toast(t('s4cDetected'), 'info'); }
        else M.toast(t('s4cNothingDetected'), 'warn');
      } else if (act === 'save') {
        const bad = collect();
        if (bad.length) { M.toast(t('s4cInvalid', { f: bad.join(', ') }), 'err'); return; }
        await M.api('checks_save', { project_path: path, config: S.draft });
        M.toast(t('s4cSaved'), 'ok');
        await loadConfig(); await loadStatus(true);
      } else if (act === 'trust') {
        const cmds = (S.cfg?.config?.checks || []).map(c => '• ' + toLine(c.command)).join('\n');
        if (confirm(t('s4cTrustConfirm', { cmds }))) {
          await M.api('checks_trust', { project_path: path, sha256: S.cfg.sha256 });
          M.toast(t('s4cSaved'), 'ok');
          await loadConfig(); await loadStatus(true);
        }
      } else if (act === 'override') {
        const reason = (prompt(t('s4cOverrideReason')) || '').trim();
        if (reason && confirm(t('s4cOverrideConfirm'))) {
          const r = await M.api('checks_override', { project_path: path, reason, scope: 'merge' });
          M.toast(t('s4cOverrideDone', { time: hhmm(r.expires_at) }), 'warn');
        }
      }
    } catch (err) { M.toast(err.message, 'err'); }
    finally { S.busy = false; b.disabled = false; }
  }
})();
