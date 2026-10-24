// S4 — Policies per role (N6) + the S4 attention list. Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { esc, t } = M;

  M.addI18n('vi', {
    s4pTab: 'Chính sách', s4pAttention: 'Cần bạn xử lý', s4pAttEmpty: 'Không có gì cần xử lý.',
    s4pApprovals: 'Chờ phê duyệt', s4pApprove: 'Duyệt & chạy lại', s4pReject: 'Từ chối', s4pNoApprovals: 'Không có lệnh nào chờ duyệt.',
    s4pApproveConfirm: 'Cho phép {role} ({agent}) chạy "{cmd}" và chạy lại job {job}?', s4pRejectConfirm: 'Từ chối yêu cầu {id}?',
    s4pViolations: 'Vi phạm', s4pResolve: 'Đã xử lý', s4pResolveConfirm: 'Đánh dấu vi phạm này là đã xử lý? Ghi chú (tuỳ chọn):', s4pNoViolations: 'Không có vi phạm nào đang mở.',
    s4pShowResolved: 'Hiện cả vi phạm đã xử lý', s4pThisProject: 'Chỉ dự án đang chọn',
    s4pRules: 'Luật', s4pScope: 'Áp dụng cho', s4pGlobal: 'Mọi vai trò', s4pAddRole: '+ Vai trò / hồ sơ', s4pAddRolePrompt: 'Tên vai trò hoặc hồ sơ S6 (chữ thường, ví dụ hacker):',
    s4pRemoveRole: 'Xoá luật của vai trò này', s4pRemoveRoleConfirm: 'Xoá toàn bộ luật riêng của "{role}"?',
    s4pProtected: 'Đường dẫn được bảo vệ (không bao giờ được sửa)', s4pDeny: 'Lệnh bị cấm', s4pApproveCmds: 'Lệnh cần phê duyệt', s4pAllow: 'Lệnh luôn được phép (ngoại lệ)',
    s4pReadOnly: 'Vai trò chỉ đọc (không được sửa file)', s4pRedact: 'Che bí mật trong prompt và log', s4pRedactEnv: 'Che cả giá trị trong các file .env', s4pEnabled: 'Bật chính sách',
    s4pPatterns: 'Mẫu bí mật thêm (regex, mỗi dòng một mẫu)', s4pAddPh: 'Thêm rồi Enter…', s4pPatternHelp: 'Lệnh: các từ phải xuất hiện theo thứ tự (git push --force khớp "git push origin --force"). Tiền tố re: = regex. Đường dẫn: * trong một thư mục, ** mọi cấp.',
    s4pSave: 'Lưu chính sách', s4pSaved: 'Đã lưu.', s4pReload: 'Tải lại',
    s4pPreview: 'Xem trước', s4pPreviewRole: 'Vai trò', s4pPreviewText: 'Thử với một prompt / đoạn log (tuỳ chọn)', s4pRunPreview: 'Xem brief & che bí mật',
    s4pBrief: 'Đoạn luật được chèn vào brief', s4pRedacted: 'Sau khi che bí mật', s4pMatches: 'Khớp: cấm {d} · cần duyệt {a}',
    s4pSandbox: 'Cờ sandbox theo nền tảng', s4pSandboxNote: 'Hiện chỉ là tài liệu — áp dụng tự động cần Tech Lead thêm vào registry (policy_args).',
    s4pPlatform: 'Nền tảng', s4pFlags: 'Cờ', s4pEffect: 'Tác dụng', s4pRuntimeBad: 'Hook S4 chưa tìm thấy runtime — chính sách chưa được thực thi trong job.',
    s4pKind_protected_path: 'sửa đường dẫn bảo vệ', s4pKind_deny_command: 'lệnh bị cấm', s4pKind_approve_command: 'lệnh cần duyệt', s4pKind_read_only_write: 'vai trò chỉ đọc đã sửa file', s4pKind_secret: 'lộ bí mật',
    s4pInvalidRole: 'Tên vai trò không hợp lệ.', s4pInvalidRe: 'Regex không hợp lệ: {p}', s4pDone: 'Xong.', s4pJob: 'Job',
  });
  M.addI18n('en', {
    s4pTab: 'Policies', s4pAttention: 'Needs you', s4pAttEmpty: 'Nothing needs your attention.',
    s4pApprovals: 'Pending approvals', s4pApprove: 'Approve & re-run', s4pReject: 'Reject', s4pNoApprovals: 'No command is waiting for approval.',
    s4pApproveConfirm: 'Allow {role} ({agent}) to run "{cmd}" and re-run job {job}?', s4pRejectConfirm: 'Reject request {id}?',
    s4pViolations: 'Violations', s4pResolve: 'Resolve', s4pResolveConfirm: 'Mark this violation as resolved? Note (optional):', s4pNoViolations: 'No open violation.',
    s4pShowResolved: 'Include resolved', s4pThisProject: 'Selected project only',
    s4pRules: 'Rules', s4pScope: 'Applies to', s4pGlobal: 'Every role', s4pAddRole: '+ Role / profile', s4pAddRolePrompt: 'Role or S6 profile name (lower case, e.g. hacker):',
    s4pRemoveRole: 'Remove this role\'s rules', s4pRemoveRoleConfirm: 'Remove all rules of "{role}"?',
    s4pProtected: 'Protected paths (never writable)', s4pDeny: 'Denied commands', s4pApproveCmds: 'Commands that need approval', s4pAllow: 'Always allowed (exceptions)',
    s4pReadOnly: 'Read-only role (may not modify files)', s4pRedact: 'Redact secrets in prompts and logs', s4pRedactEnv: 'Also redact values from .env files', s4pEnabled: 'Policies enabled',
    s4pPatterns: 'Extra secret patterns (regex, one per line)', s4pAddPh: 'Type and press Enter…', s4pPatternHelp: 'Commands: the words must appear in this order (git push --force matches "git push origin --force"). Prefix re: = regex. Paths: * within a folder, ** any depth.',
    s4pSave: 'Save policies', s4pSaved: 'Saved.', s4pReload: 'Reload',
    s4pPreview: 'Preview', s4pPreviewRole: 'Role', s4pPreviewText: 'Try a prompt / log excerpt (optional)', s4pRunPreview: 'Show brief & redaction',
    s4pBrief: 'Rules prepended to the brief', s4pRedacted: 'After redaction', s4pMatches: 'Matches: denied {d} · needs approval {a}',
    s4pSandbox: 'Platform sandbox flags', s4pSandboxNote: 'Documentation only for now — applying them automatically needs the Tech Lead to add policy_args to the registry.',
    s4pPlatform: 'Platform', s4pFlags: 'Flags', s4pEffect: 'Effect', s4pRuntimeBad: 'The S4 hooks cannot find their runtime — policies are not enforced in jobs yet.',
    s4pKind_protected_path: 'protected path modified', s4pKind_deny_command: 'denied command', s4pKind_approve_command: 'command needing approval', s4pKind_read_only_write: 'read-only role wrote files', s4pKind_secret: 'secret exposed',
    s4pInvalidRole: 'Invalid role name.', s4pInvalidRe: 'Invalid regex: {p}', s4pDone: 'Done.', s4pJob: 'Job',
  });

  const ROLES = ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'tester'];
  const ROLE_RE = /^[a-z][a-z0-9-]{1,31}$/;
  const LISTS = [['protected_paths', 's4pProtected'], ['deny_commands', 's4pDeny'], ['approve_commands', 's4pApproveCmds'], ['allow_commands', 's4pAllow']];
  const SANDBOX = [
    ['Claude Code', '--disallowedTools "Bash(git push:*)" "Edit(.env)" · --permission-mode plan', 'per-tool deny rules; plan = no edits'],
    ['Codex', '--sandbox read-only | workspace-write · --ask-for-approval on-request', 'OS sandbox + approval prompts'],
    ['Gemini CLI', '--approval-mode plan | default · --sandbox', 'approval mode, container sandbox'],
    ['Cursor Agent', '(no --force for read-only roles)', 'asks before writes / commands'],
    ['Aider', '--dry-run', 'no writes'],
    ['Antigravity', '—', 'brief rules + post-hoc scan only'],
  ];

  const when = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(M.lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  };
  const get = (action, params) => M.api(action + Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join(''));
  const agents = () => { try { return M.agents() || {}; } catch { return {}; } };
  const aLabel = id => agents()[id]?.label || id || '—';
  const SEV = { error: 'b-err', high: 'b-err', warn: 'b-warn', info: 'b-info' };

  const S = { panel: null, builtLang: '', cfg: null, scope: 'global', att: null, apr: null, vio: null, showResolved: false, onlyProject: true, feature: null, at: 0 };

  const tab = M.addTab({ id: 'policy', title: () => t('s4pTab'), render: panel => render(panel) });
  M.on('data', d => {
    S.feature = d?.feature_data?.policy || null;
    const n = Number(S.feature?.attention_count ?? 0) || (Number(S.feature?.pending_approvals || 0) + Number(S.feature?.open_high || 0));
    tab?.setCount(n || '');
  });
  M.on('project-change', () => { if (S.panel && !S.panel.classList.contains('hidden')) loadLive(true); });

  function render(panel) {
    S.panel = panel;
    if (S.builtLang !== M.lang) build(panel);
    if (!panel.classList.contains('hidden')) loadLive(false);
    const warn = R('runtime');
    if (warn) warn.classList.toggle('hidden', !(S.feature && S.feature.runtime_ok === false));
  }

  function build(panel) {
    S.builtLang = M.lang;
    panel.innerHTML = `
      <div class="s4-body">
        <div class="callout s4p-warn hidden" data-r="runtime">${esc(t('s4pRuntimeBad'))}</div>
        <section class="s4-sec"><div class="s4-sec-h"><h3>${esc(t('s4pAttention'))}</h3></div><div data-r="att"></div></section>
        <div class="s4-grid s4-g2">
          <section class="s4-sec"><div class="s4-sec-h"><h3>${esc(t('s4pApprovals'))}</h3></div><div data-r="apr"></div></section>
          <section class="s4-sec"><div class="s4-sec-h"><h3>${esc(t('s4pViolations'))}</h3><span class="spacer"></span>
            <label class="check"><input type="checkbox" data-f="proj" ${S.onlyProject ? 'checked' : ''}> ${esc(t('s4pThisProject'))}</label>
            <label class="check"><input type="checkbox" data-f="resolved" ${S.showResolved ? 'checked' : ''}> ${esc(t('s4pShowResolved'))}</label></div>
            <div data-r="vio"></div></section>
        </div>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4pRules'))}</h3><span class="spacer"></span>
            <button type="button" class="btn btn-sm" data-act="reload">${esc(t('s4pReload'))}</button>
            <button type="button" class="btn btn-sm btn-primary" data-act="save">${esc(t('s4pSave'))}</button></div>
          <div data-r="rules"></div>
        </section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4pPreview'))}</h3></div>
          <div class="s4p-prev">
            <label class="s4-lbl">${esc(t('s4pPreviewRole'))}<select class="s4-sel" data-f="prole">${ROLES.map(r => `<option value="${r}">${r}</option>`).join('')}</select></label>
            <label class="s4-lbl s4p-grow">${esc(t('s4pPreviewText'))}<textarea class="input s4-mono" rows="3" data-f="ptext" spellcheck="false"></textarea></label>
            <button type="button" class="btn btn-sm" data-act="preview">${esc(t('s4pRunPreview'))}</button>
          </div>
          <div data-r="prev"></div>
        </section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4pSandbox'))}</h3></div>
          <p class="sub">${esc(t('s4pSandboxNote'))}</p>
          <div class="table-wrap"><table><thead><tr><th>${esc(t('s4pPlatform'))}</th><th>${esc(t('s4pFlags'))}</th><th>${esc(t('s4pEffect'))}</th></tr></thead>
            <tbody>${SANDBOX.map(r => `<tr><td>${esc(r[0])}</td><td class="s4-mono">${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>
        </section>
      </div>`;
    if (!panel.dataset.s4bound) {
      panel.dataset.s4bound = '1';
      panel.addEventListener('click', onClick);
      panel.addEventListener('change', onChange);
      panel.addEventListener('keydown', onKey);
    }
    loadConfig();
    S.at = 0;
  }
  function R(n) { return S.panel?.querySelector(`[data-r="${n}"]`); }

  // ---- live lists ----------------------------------------------------------
  async function loadLive(force) {
    if (!force && Date.now() - S.at < 8000) return;
    S.at = Date.now();
    const p = S.onlyProject ? (M.project()?.path || '') : '';
    const [att, apr, vio] = await Promise.all([
      M.api('s4_attention').catch(e => ({ error: e.message })),
      get('policy_approvals', { status: 'pending' }).catch(e => ({ error: e.message })),
      get('policy_violations', { project_path: p, limit: 100, include_resolved: S.showResolved ? 1 : 0 }).catch(e => ({ error: e.message })),
    ]);
    S.att = att; S.apr = apr; S.vio = vio;
    paintAttention(); paintApprovals(); paintViolations();
  }

  function paintAttention() {
    const box = R('att'); if (!box) return;
    const items = S.att?.items || [];
    if (S.att?.error) { box.innerHTML = `<div class="sub">${esc(S.att.error)}</div>`; return; }
    box.innerHTML = items.length ? `<div class="s4p-list">${items.map((it, i) => `<div class="s4p-item">
      ${M.badge(it.source || 's4', SEV[it.severity] || '')}
      <div class="s4p-main"><b>${esc(it.title || it.kind)}</b> <span class="faint">${esc(when(it.ts))}</span>
        ${it.detail ? `<div class="sub clamp-2" title="${esc(it.detail)}">${esc(it.detail)}</div>` : ''}
        ${it.job_id ? `<div class="faint s4-mono">${esc(it.job_id)}</div>` : ''}</div>
      <div class="s4p-acts">${(it.actions || []).map((a, j) => `<button type="button" class="btn btn-sm" data-act="att" data-i="${i}" data-j="${j}">${esc(a.label || a.id)}</button>`).join('')}</div>
    </div>`).join('')}</div>` : `<div class="sub">${esc(t('s4pAttEmpty'))}</div>`;
  }

  function paintApprovals() {
    const box = R('apr'); if (!box) return;
    if (S.apr?.error) { box.innerHTML = `<div class="sub">${esc(S.apr.error)}</div>`; return; }
    const items = S.apr?.items || [];
    box.innerHTML = items.length ? `<div class="s4p-list">${items.map(a => `<div class="s4p-item">
      ${M.badge(a.role || '—', 'b-warn')}
      <div class="s4p-main"><code class="s4-mono">${esc(a.command)}</code> <span class="sub">· ${esc(aLabel(a.agent))}</span>
        <div class="faint s4-mono truncate" title="${esc(a.project || '')}">${esc(a.job_id || '')} · ${esc(when(a.created_at))}</div></div>
      <div class="s4p-acts"><button type="button" class="btn btn-sm btn-primary" data-act="approve" data-id="${esc(a.id)}">${esc(t('s4pApprove'))}</button>
        <button type="button" class="btn btn-sm btn-link danger" data-act="reject" data-id="${esc(a.id)}">${esc(t('s4pReject'))}</button></div>
    </div>`).join('')}</div>` : `<div class="sub">${esc(t('s4pNoApprovals'))}</div>`;
  }

  function paintViolations() {
    const box = R('vio'); if (!box) return;
    if (S.vio?.error) { box.innerHTML = `<div class="sub">${esc(S.vio.error)}</div>`; return; }
    const items = S.vio?.items || [];
    box.innerHTML = items.length ? `<div class="s4p-list">${items.map(v => `<div class="s4p-item ${v.resolved ? 's4p-done' : ''}">
      ${M.badge(v.severity || 'warn', SEV[v.severity] || '')}
      <div class="s4p-main"><b>${esc(t('s4pKind_' + v.kind) || v.kind)}</b> <span class="sub">${esc(v.role || '')} · ${esc(aLabel(v.agent))}</span>
        <div class="sub s4p-detail">${esc(v.detail || '')}${v.file ? ` — <code class="s4-mono">${esc(v.file)}${v.line ? ':' + esc(v.line) : ''}</code>` : ''}</div>
        <div class="faint s4-mono">${esc(v.job_id || '')} · ${esc(when(v.ts))}</div></div>
      <div class="s4p-acts">${v.resolved ? '✓' : `<button type="button" class="btn btn-sm" data-act="resolve" data-id="${esc(v.id)}">${esc(t('s4pResolve'))}</button>`}</div>
    </div>`).join('')}</div>` : `<div class="sub">${esc(t('s4pNoViolations'))}</div>`;
  }

  // ---- rules editor --------------------------------------------------------
  async function loadConfig() {
    try {
      const r = await M.api('policy_get');
      S.cfg = structuredClone(r.config || { version: 1, enabled: true, global: {}, roles: {} });
      S.cfg.global = S.cfg.global || {}; S.cfg.roles = S.cfg.roles || {};
      S.known = r.roles_known || ROLES;
      for (const w of r.warnings || []) M.toast(String(w), 'warn');
      paintRules();
      const sel = S.panel?.querySelector('[data-f="prole"]');
      if (sel) sel.innerHTML = [...new Set([...S.known, ...Object.keys(S.cfg.roles)])].map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    } catch (e) { const b = R('rules'); if (b) b.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function scopeObj() { return S.scope === 'global' ? S.cfg.global : (S.cfg.roles[S.scope] = S.cfg.roles[S.scope] || {}); }

  function paintRules() {
    const box = R('rules'); if (!box || !S.cfg) return;
    const scopes = ['global', ...new Set([...ROLES, ...(S.known || []), ...Object.keys(S.cfg.roles)])];
    if (!scopes.includes(S.scope)) S.scope = 'global';
    const o = S.scope === 'global' ? S.cfg.global : (S.cfg.roles[S.scope] || {});
    const has = r => r !== 'global' && S.cfg.roles[r] && Object.keys(S.cfg.roles[r]).length;
    box.innerHTML = `
      <label class="check"><input type="checkbox" data-f="enabled" ${S.cfg.enabled !== false ? 'checked' : ''}> ${esc(t('s4pEnabled'))}</label>
      <div class="s4p-scopes s4-mt" role="tablist" aria-label="${esc(t('s4pScope'))}">${scopes.map(r => `<button type="button" role="tab" class="s4p-scope" data-scope="${esc(r)}" aria-selected="${r === S.scope}">${esc(r === 'global' ? t('s4pGlobal') : r)}${has(r) ? ' •' : ''}</button>`).join('')}
        <button type="button" class="s4p-scope s4p-add" data-act="add-role">${esc(t('s4pAddRole'))}</button></div>
      <p class="sub s4-mt">${esc(t('s4pPatternHelp'))}</p>
      ${LISTS.map(([k, label]) => `<div class="s4-mt"><div class="s4-lbl">${esc(t(label))}</div>
        <div class="s4p-chips" data-list="${k}">${(o[k] || []).map((v, i) => `<span class="s4-chip s4-mono">${esc(v)}<button type="button" class="s4-x" data-act="chip-del" data-list="${k}" data-i="${i}" aria-label="remove">✕</button></span>`).join('')}
          <input class="input s4p-add-in s4-mono" data-add="${k}" placeholder="${esc(t('s4pAddPh'))}" spellcheck="false" aria-label="${esc(t(label))}"></div></div>`).join('')}
      <div class="row-wrap s4-gap s4-mt">
        ${S.scope === 'global' ? `
          <label class="check"><input type="checkbox" data-b="redact_secrets" ${o.redact_secrets !== false ? 'checked' : ''}> ${esc(t('s4pRedact'))}</label>
          <label class="check"><input type="checkbox" data-b="redact_env_files" ${o.redact_env_files !== false ? 'checked' : ''}> ${esc(t('s4pRedactEnv'))}</label>`
        : `<label class="check"><input type="checkbox" data-b="read_only" ${o.read_only ? 'checked' : ''}> ${esc(t('s4pReadOnly'))}</label>
           ${!ROLES.includes(S.scope) || has(S.scope) ? `<button type="button" class="btn btn-sm btn-link danger" data-act="del-role">${esc(t('s4pRemoveRole'))}</button>` : ''}`}
      </div>
      ${S.scope === 'global' ? `<label class="s4-lbl s4-mt">${esc(t('s4pPatterns'))}<textarea class="input s4-mono" rows="3" data-f="patterns" spellcheck="false">${esc((o.secret_patterns || []).join('\n'))}</textarea></label>` : ''}`;
  }

  function addChip(list, value) {
    const v = String(value || '').trim(); if (!v) return false;
    if (v.startsWith('re:')) { try { new RegExp(v.slice(3), 'i'); } catch { M.toast(t('s4pInvalidRe', { p: v }), 'err'); return false; } }
    const o = scopeObj(); o[list] = o[list] || [];
    if (!o[list].includes(v)) o[list].push(v);
    return true;
  }

  function onKey(e) {
    const inp = e.target.closest?.('[data-add]');
    if (!inp || e.key !== 'Enter') return;
    e.preventDefault();
    if (addChip(inp.dataset.add, inp.value)) { paintRules(); S.panel.querySelector(`[data-add="${inp.dataset.add}"]`)?.focus(); }
  }

  function onChange(e) {
    const el = e.target;
    if (el.dataset.f === 'proj') { S.onlyProject = el.checked; loadLive(true); return; }
    if (el.dataset.f === 'resolved') { S.showResolved = el.checked; loadLive(true); return; }
    if (!S.cfg) return;
    if (el.dataset.f === 'enabled') S.cfg.enabled = el.checked;
    if (el.dataset.b) scopeObj()[el.dataset.b] = el.checked;
    if (el.dataset.f === 'patterns') S.cfg.global.secret_patterns = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (el.dataset.add && el.value.trim()) { if (addChip(el.dataset.add, el.value)) paintRules(); }
  }

  async function onClick(e) {
    const sc = e.target.closest('[data-scope]');
    if (sc) { flushInputs(); S.scope = sc.dataset.scope; paintRules(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'chip-del') { const l = scopeObj()[b.dataset.list] || []; l.splice(Number(b.dataset.i), 1); paintRules(); return; }
    if (act === 'add-role') {
      const name = (prompt(t('s4pAddRolePrompt')) || '').trim().toLowerCase();
      if (!name) return;
      if (!ROLE_RE.test(name)) { M.toast(t('s4pInvalidRole'), 'err'); return; }
      S.cfg.roles[name] = S.cfg.roles[name] || {}; S.scope = name; paintRules(); return;
    }
    if (act === 'del-role') {
      if (!confirm(t('s4pRemoveRoleConfirm', { role: S.scope }))) return;
      delete S.cfg.roles[S.scope]; S.scope = 'global'; paintRules(); return;
    }
    if (act === 'reload') { loadConfig(); loadLive(true); return; }
    b.disabled = true;
    try {
      if (act === 'save') {
        flushInputs();
        for (const p of S.cfg.global.secret_patterns || []) { try { new RegExp(p); } catch { throw new Error(t('s4pInvalidRe', { p })); } }
        // Drop empty role entries so the file stays readable.
        for (const [k, v] of Object.entries(S.cfg.roles)) if (!v || !Object.keys(v).some(x => Array.isArray(v[x]) ? v[x].length : v[x])) delete S.cfg.roles[k];
        const r = await M.api('policy_save', { config: S.cfg });
        S.cfg = structuredClone(r.config || S.cfg); S.cfg.global = S.cfg.global || {}; S.cfg.roles = S.cfg.roles || {};
        paintRules(); M.toast(t('s4pSaved'), 'ok');
      } else if (act === 'preview') {
        const role = S.panel.querySelector('[data-f="prole"]').value;
        const text = S.panel.querySelector('[data-f="ptext"]').value;
        const r = await M.api('policy_preview', text ? { role, text } : { role });
        const m = r.matches || {};
        R('prev').innerHTML = `<div class="s4-lbl s4-mt">${esc(t('s4pBrief'))}</div><pre class="code s4p-pre">${esc(r.brief || '')}</pre>
          ${text ? `<div class="s4-lbl s4-mt">${esc(t('s4pRedacted'))} · ${esc(t('s4pMatches', { d: (m.deny || []).length, a: (m.approve || []).length }))}</div>
            <pre class="code s4p-pre">${esc(r.redacted ?? text)}</pre>
            ${[...(m.deny || []).map(x => M.badge(x, 'b-err')), ...(m.approve || []).map(x => M.badge(x, 'b-warn'))].join(' ')}` : ''}`;
      } else if (act === 'approve') {
        const a = (S.apr?.items || []).find(x => x.id === b.dataset.id); if (!a) return;
        if (!confirm(t('s4pApproveConfirm', { role: a.role, agent: aLabel(a.agent), cmd: a.command, job: a.job_id || '—' }))) return;
        const r = await M.api('policy_approve', { id: a.id, rerun: true });
        M.toast(r.job_id ? `${t('s4pDone')} ${t('s4pJob')}: ${r.job_id}` : t('s4pDone'), 'ok');
        loadLive(true);
      } else if (act === 'reject') {
        if (!confirm(t('s4pRejectConfirm', { id: b.dataset.id }))) return;
        await M.api('policy_reject', { id: b.dataset.id }); M.toast(t('s4pDone'), 'ok'); loadLive(true);
      } else if (act === 'resolve') {
        const note = prompt(t('s4pResolveConfirm'));
        if (note === null) return;
        await M.api('policy_resolve', note.trim() ? { id: b.dataset.id, note: note.trim() } : { id: b.dataset.id });
        M.toast(t('s4pDone'), 'ok'); loadLive(true);
      } else if (act === 'att') {
        const it = (S.att?.items || [])[Number(b.dataset.i)], a = it?.actions?.[Number(b.dataset.j)];
        if (!a || !/^[a-z][a-z0-9_-]{1,63}$/.test(a.action || '')) return;
        if (!confirm(`${a.label || a.id}?\n\n${it.title || ''}`)) return;
        const r = await M.api(a.action, a.body || {});
        M.toast(r.job_id ? `${t('s4pDone')} ${t('s4pJob')}: ${r.job_id}` : t('s4pDone'), 'ok');
        loadLive(true);
      }
    } catch (err) { M.toast(err.message, 'err'); }
    finally { b.disabled = false; }
  }

  // Typed-but-not-entered chip values and the patterns box are kept when switching scope or saving.
  function flushInputs() {
    if (!S.panel || !S.cfg) return;
    S.panel.querySelectorAll('[data-add]').forEach(inp => { if (inp.value.trim()) addChip(inp.dataset.add, inp.value); });
    const pt = S.panel.querySelector('[data-f="patterns"]');
    if (pt) S.cfg.global.secret_patterns = pt.value.split('\n').map(s => s.trim()).filter(Boolean);
  }
})();
