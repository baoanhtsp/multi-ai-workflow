// S6 — Team builder (V4 + N10) and free readiness check (B3). Waits for feat-workspace.js (MAW.ws).
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const ready = fn => (window.MAW_WS_READY ||= []).push(fn);

  const L = {
    vi: {
      'tm.title': 'Thiết lập Agent Team', 'tm.project': 'Dự án', 'tm.template': 'Mẫu', 'tm.load': 'Dùng mẫu',
      'tm.fromFile': 'Đang dùng .maw/team.json của dự án', 'tm.noFile': 'Dự án chưa có .maw/team.json — bắt đầu từ một mẫu',
      'tm.shared': 'Thiết lập chung', 'tm.workdir': 'Thư mục', 'tm.workdirPh': '(để trống = thư mục dự án)', 'tm.platform': 'Nền tảng',
      'tm.model': 'Model', 'tm.effort': 'Effort', 'tm.scope': 'Phạm vi ghi (glob, mỗi dòng một; trống = chỉ đọc)', 'tm.dirs': 'Thư mục được ghi thêm',
      'tm.isolate': 'Mỗi thành viên chạy trong worktree riêng (S1)', 'tm.parallel': 'Số handoff song song', 'tm.autoc': 'Lead tự tiếp tục khi các handoff xong',
      'tm.roles': 'Vai trò', 'tm.addRole': '+ Vai trò', 'tm.rmRole': 'Xoá vai trò', 'tm.key': 'Mã vai trò', 'tm.name': 'Tên vai trò',
      'tm.enabled': 'Bật', 'tm.style': 'Cách làm việc', 'tm.st.persistent': 'Chat liên tục', 'tm.st.per_task': 'Theo từng nhiệm vụ', 'tm.st.new_chat_per_task': 'Chat mới cho mỗi nhiệm vụ',
      'tm.exec': 'Chạy với vai trò', 'tm.persona': 'Tính cách', 'tm.delegate': 'Được giao việc cho vai trò khác',
      'tm.resp': 'Trách nhiệm', 'tm.deleg': 'Giao việc & báo cáo', 'tm.output': 'Đầu ra', 'tm.perms': 'Quyền',
      'tm.override': 'Ghi đè riêng cho vai trò (tuỳ chọn)', 'tm.scopeMode': 'Quyền ghi của vai trò', 'tm.sm.inherit': 'Theo thiết lập chung', 'tm.sm.custom': 'Phạm vi riêng (glob)', 'tm.sm.readonly': 'Chỉ đọc (không được sửa tệp)', 'tm.inherit': '(theo thiết lập chung)',
      'tm.lib': 'Thư viện hồ sơ', 'tm.libLoad': 'Nạp từ thư viện…', 'tm.libSave': 'Lưu vai trò vào thư viện', 'tm.libSaved': 'Đã lưu hồ sơ "{n}".',
      'tm.suggest': 'Gợi ý từ bảng điểm', 'tm.suggested': 'Đã áp dụng gợi ý cho {n} vai trò.', 'tm.noSuggest': 'Chưa có bảng điểm (S4).',
      'tm.ready': 'Kiểm tra sẵn sàng', 'tm.export': 'Xuất', 'tm.import': 'Nhập', 'tm.saveTpl': 'Lưu thành mẫu', 'tm.updTpl': 'Cập nhật mẫu',
      'tm.save': 'Lưu vào dự án', 'tm.apply': 'Lưu & tạo agent', 'tm.saved': 'Đã lưu .maw/team.json.', 'tm.applied': 'Đã tạo / cập nhật {n} agent trong nhóm "{g}".',
      'tm.tplName': 'Tên mẫu', 'tm.tplSaved': 'Đã lưu mẫu "{n}".', 'tm.tplDel': 'Xoá mẫu', 'tm.cTplDel': 'Xoá mẫu "{n}"?',
      'tm.cOverwrite': 'Dự án đã có đội. Ghi đè bằng tệp nhập?', 'tm.imported': 'Đã nhập đội.', 'tm.badFile': 'Tệp không hợp lệ: {e}',
      'tm.cRmRole': 'Xoá vai trò "{n}"? Agent đã tạo cho vai trò này được giữ lại.', 'tm.keyBad': 'Mã vai trò phải khớp ^[a-z][a-z0-9-]{1,23}$ và không trùng.',
      'tm.builtin': 'có sẵn', 'tm.pickProject': 'Hãy chọn dự án.',
      'rd.title': 'Kiểm tra sẵn sàng (miễn phí, không gọi model)', 'rd.role': 'Vai trò', 'rd.agent': 'Agent', 'rd.platform': 'Nền tảng',
      'rd.model': 'Model cấu hình', 'rd.actual': 'Model thực tế', 'rd.status': 'Trạng thái', 'rd.reason': 'Lý do',
      'rd.ok': 'Sẵn sàng', 'rd.bad': 'Không sẵn sàng', 'rd.unknown': 'Chưa rõ', 'rd.noHealth': 'Đăng nhập: chưa rõ (S3 health chưa có) — chỉ kiểm tra cài đặt.',
      'rd.missing': 'chưa cài', 'rd.took': 'Xong trong {ms} ms', 'rd.none': 'Không có agent nào để kiểm tra.',
    },
    en: {
      'tm.title': 'Agent Team setup', 'tm.project': 'Project', 'tm.template': 'Template', 'tm.load': 'Use template',
      'tm.fromFile': "Using the project's .maw/team.json", 'tm.noFile': 'The project has no .maw/team.json yet — start from a template',
      'tm.shared': 'Shared settings', 'tm.workdir': 'Directory', 'tm.workdirPh': '(empty = the project folder)', 'tm.platform': 'Platform',
      'tm.model': 'Model', 'tm.effort': 'Effort', 'tm.scope': 'Write scope (globs, one per line; empty = read-only)', 'tm.dirs': 'Extra writable dirs',
      'tm.isolate': 'Each member runs in its own worktree (S1)', 'tm.parallel': 'Parallel handoffs', 'tm.autoc': 'The Lead continues when its handoffs finish',
      'tm.roles': 'Roles', 'tm.addRole': '+ Role', 'tm.rmRole': 'Remove role', 'tm.key': 'Role key', 'tm.name': 'Role name',
      'tm.enabled': 'On', 'tm.style': 'Working style', 'tm.st.persistent': 'Persistent chat', 'tm.st.per_task': 'Per task', 'tm.st.new_chat_per_task': 'New chat per task',
      'tm.exec': 'Run as role', 'tm.persona': 'Persona', 'tm.delegate': 'May delegate to other roles',
      'tm.resp': 'Responsibility', 'tm.deleg': 'Delegation & reporting', 'tm.output': 'Output', 'tm.perms': 'Permissions',
      'tm.override': 'Per-role override (optional)', 'tm.scopeMode': 'Role write access', 'tm.sm.inherit': 'Shared setting', 'tm.sm.custom': 'Own scope (globs)', 'tm.sm.readonly': 'Read-only (no file changes)', 'tm.inherit': '(shared setting)',
      'tm.lib': 'Profile library', 'tm.libLoad': 'Load from library…', 'tm.libSave': 'Save role to library', 'tm.libSaved': 'Saved profile "{n}".',
      'tm.suggest': 'Suggest from scoreboard', 'tm.suggested': 'Applied the suggestion to {n} roles.', 'tm.noSuggest': 'No scoreboard yet (S4).',
      'tm.ready': 'Readiness check', 'tm.export': 'Export', 'tm.import': 'Import', 'tm.saveTpl': 'Save as template', 'tm.updTpl': 'Update template',
      'tm.save': 'Save to project', 'tm.apply': 'Save & create agents', 'tm.saved': 'Saved .maw/team.json.', 'tm.applied': 'Created / updated {n} agents in group "{g}".',
      'tm.tplName': 'Template name', 'tm.tplSaved': 'Saved template "{n}".', 'tm.tplDel': 'Delete template', 'tm.cTplDel': 'Delete template "{n}"?',
      'tm.cOverwrite': 'The project already has a team. Overwrite it with the imported file?', 'tm.imported': 'Team imported.', 'tm.badFile': 'Invalid file: {e}',
      'tm.cRmRole': 'Remove role "{n}"? Agents already created for it are kept.', 'tm.keyBad': 'Role keys must match ^[a-z][a-z0-9-]{1,23}$ and be unique.',
      'tm.builtin': 'built-in', 'tm.pickProject': 'Pick a project.',
      'rd.title': 'Readiness check (free, no model calls)', 'rd.role': 'Role', 'rd.agent': 'Agent', 'rd.platform': 'Platform',
      'rd.model': 'Configured model', 'rd.actual': 'Actual model', 'rd.status': 'Status', 'rd.reason': 'Reason',
      'rd.ok': 'Ready', 'rd.bad': 'Not ready', 'rd.unknown': 'Unknown', 'rd.noHealth': 'Login: unknown (S3 health not available) — install check only.',
      'rd.missing': 'not installed', 'rd.took': 'Done in {ms} ms', 'rd.none': 'No agents to check.',
    },
  };
  M.addI18n('vi', L.vi);
  M.addI18n('en', L.en);
  const t = (k, v) => M.t(k, v);
  const { esc } = M;
  const has = f => (M.state.data?.features || []).includes(f);
  const qs = (s, r) => r.querySelector(s);
  const qsa = (s, r) => [...r.querySelectorAll(s)];
  const STYLES = ['persistent', 'per_task', 'new_chat_per_task'];
  const EXEC = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
  const SECTIONS = [['responsibility', 'tm.resp'], ['delegation', 'tm.deleg'], ['output', 'tm.output'], ['permissions', 'tm.perms']];
  const KEY_RE = /^[a-z][a-z0-9-]{1,23}$/;
  const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const clone = o => JSON.parse(JSON.stringify(o ?? null));

  ready(ws => {
    const fail = e => { console.error('[teams]', e); M.toast(e?.message || String(e), 'err'); };

    // ---------- team builder ----------
    async function openTeamBuilder(opts = {}) {
      const T = { project: opts.project_path || M.project()?.path || '', team: null, md: {}, fromFile: false, templates: [], profiles: [], sel: '', tplId: '' };
      const body = document.createElement('div');
      body.className = 'tm';
      const dlg = ws.dialog({
        title: t('tm.title'), wide: true, body,
        actions: [
          { label: t('tm.ready'), run: () => { collect(); readiness(teamAgentsPreview()); return false; } },
          { label: t('tm.export'), run: () => { collect(); exportTeam(); return false; } },
          { label: t('tm.import'), run: () => { importTeam(); return false; } },
          { label: t('tm.saveTpl'), run: async () => { collect(); await saveTemplate(); return false; } },
          { label: t('tm.save'), run: async () => { collect(); await saveTeam(); return false; } },
          { label: t('tm.apply'), primary: true, run: async () => { collect(); if (!(await saveTeam())) return false; await applyTeam(); } },
        ],
      });
      dlg.classList.add('tm-dlg');

      async function loadLib() {
        const [tp, pf] = await Promise.all([ws.get('team_templates').catch(() => ({ templates: [] })), ws.get('team_profiles').catch(() => ({ profiles: [] }))]);
        T.templates = tp.templates || []; T.profiles = pf.profiles || [];
      }
      async function loadProject() {
        T.team = null; T.md = {}; T.fromFile = false;
        if (T.project) {
          try {
            const d = await ws.get('team_get', { project_path: T.project });
            if (d.team) { T.team = d.team; T.md = d.roles_md || {}; T.fromFile = true; }
          } catch (e) { fail(e); }
        }
        if (!T.team) useTemplate(T.templates.find(x => x.id === 'full') || T.templates[0]);
        T.sel = opts.role && T.team?.roles.some(r => r.key === opts.role) ? opts.role : T.team?.roles[0]?.key || '';
      }
      function useTemplate(tpl) {
        if (!tpl) { T.team = { version: 1, name: 'Team', shared: { workdir: '', platform: 'claude', model: '', effort: '', write_scope: ['**'], writable_dirs: [], isolate: true, max_parallel: 3, auto_continue: true }, roles: [] }; T.md = {}; return; }
        const keepId = T.team?.id;
        T.team = clone(tpl.team); T.md = clone(tpl.roles_md) || {};
        if (keepId) T.team.id = keepId;
        T.team.template = tpl.id;
        T.tplId = tpl.builtin ? '' : tpl.id;
        T.sel = T.team.roles[0]?.key || '';
      }
      const platforms = () => ws.platforms();
      const platOpts = (sel, inherit) => (inherit ? `<option value="">${esc(t('tm.inherit'))}</option>` : '') + platforms().map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.label)}${p.installed === false ? ' ⚠' : ''}</option>`).join('');
      const listOpts = (list, sel, inherit, def) => `<option value="">${esc(inherit ? t('tm.inherit') : def)}</option>` + (list || []).map(m => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('');

      function render() {
        const team = T.team, sh = team.shared;
        const projects = M.state.data?.projects || [];
        const role = team.roles.find(r => r.key === T.sel) || team.roles[0];
        const p = platforms().find(x => x.id === sh.platform);
        body.innerHTML = `
          <div class="tm-head">
            <label class="ws-f"><span>${esc(t('tm.project'))}</span><select data-k="project">${projects.map(x => `<option value="${esc(x.path)}" ${x.path === T.project ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <label class="ws-f"><span>${esc(t('tm.template'))}</span><span class="row"><select data-k="tpl" class="ws-grow">${T.templates.map(x => `<option value="${esc(x.id)}" ${x.id === (team.template || '') ? 'selected' : ''}>${esc(x.name)}${x.builtin ? ` (${esc(t('tm.builtin'))})` : ''}</option>`).join('')}</select>
              <button type="button" class="btn btn-sm" data-act="tpl">${esc(t('tm.load'))}</button>
              ${T.tplId ? `<button type="button" class="btn btn-sm btn-danger" data-act="tpldel" title="${esc(t('tm.tplDel'))}">×</button>` : ''}</span></label>
            <label class="ws-f"><span>Team</span><input class="input" data-k="tname" maxlength="60" value="${esc(team.name || '')}"></label>
          </div>
          <p class="sub ${T.fromFile ? 't-ok' : 'faint'}">${esc(T.fromFile ? t('tm.fromFile') : t('tm.noFile'))}</p>
          <fieldset class="tm-shared"><legend>${esc(t('tm.shared'))}</legend>
            <div class="tm-grid">
              <label class="ws-f tm-span2"><span>${esc(t('tm.workdir'))}</span><input class="input mono" data-s="workdir" list="tmProj" placeholder="${esc(t('tm.workdirPh'))}" value="${esc(sh.workdir || '')}"><datalist id="tmProj">${projects.map(x => `<option value="${esc(x.path)}">`).join('')}</datalist></label>
              <label class="ws-f"><span>${esc(t('tm.platform'))}</span><select data-s="platform">${platOpts(sh.platform)}</select></label>
              <label class="ws-f"><span>${esc(t('tm.model'))}</span><select data-s="model">${listOpts(p?.models, sh.model, false, '—')}</select></label>
              <label class="ws-f"><span>${esc(t('tm.effort'))}</span><select data-s="effort" ${(p?.efforts || []).length ? '' : 'disabled'}>${listOpts(p?.efforts, sh.effort, false, '—')}</select></label>
              <label class="ws-f"><span>${esc(t('tm.parallel'))}</span><input class="input" type="number" min="1" max="6" data-s="max_parallel" value="${+sh.max_parallel || 3}"></label>
              <label class="ws-f tm-span2"><span>${esc(t('tm.scope'))}</span><textarea class="mono" rows="2" data-s="write_scope">${esc((sh.write_scope || []).join('\n'))}</textarea></label>
              <label class="ws-f tm-span2"><span>${esc(t('tm.dirs'))}</span><textarea class="mono" rows="2" data-s="writable_dirs">${esc((sh.writable_dirs || []).join('\n'))}</textarea></label>
              <label class="ws-check tm-span2"><input type="checkbox" data-s="isolate" ${sh.isolate !== false ? 'checked' : ''}> ${esc(t('tm.isolate'))}${has('worktrees') ? '' : ' <span class="faint">(S1?)</span>'}</label>
              <label class="ws-check tm-span2"><input type="checkbox" data-s="auto_continue" ${sh.auto_continue !== false ? 'checked' : ''}> ${esc(t('tm.autoc'))}</label>
            </div>
          </fieldset>
          <div class="tm-roles">
            <div class="tm-rlist" role="listbox" aria-label="${esc(t('tm.roles'))}">
              ${team.roles.map(r => `<div class="tm-ritem ${r.key === role?.key ? 'is-sel' : ''}" role="option" aria-selected="${r.key === role?.key}">
                <input type="checkbox" data-en="${esc(r.key)}" ${r.enabled !== false ? 'checked' : ''} aria-label="${esc(t('tm.enabled'))}">
                <button type="button" data-role="${esc(r.key)}"><strong>${esc(r.name)}</strong><span class="faint mono">${esc(r.key)} · ${esc(r.override?.platform || sh.platform)}</span></button></div>`).join('')}
              <div class="tm-rfoot"><button type="button" class="btn btn-sm" data-act="addrole">${esc(t('tm.addRole'))}</button>
                ${has('scoreboard') ? `<button type="button" class="btn btn-sm" data-act="suggest">${esc(t('tm.suggest'))}</button>` : ''}</div>
            </div>
            <div class="tm-redit">${role ? roleEditor(role) : ''}</div>
          </div>`;
        bind();
      }
      function roleEditor(r) {
        const sh = T.team.shared, md = T.md[r.key] || {};
        const ov = r.override || {};
        const scopeMode = !Array.isArray(ov.write_scope) ? 'inherit' : ov.write_scope.length ? 'custom' : 'readonly';
        const p = platforms().find(x => x.id === (ov.platform || sh.platform));
        return `
          <div class="tm-grid">
            <label class="ws-f"><span>${esc(t('tm.name'))}</span><input class="input" data-r="name" maxlength="40" value="${esc(r.name)}"></label>
            <label class="ws-f"><span>${esc(t('tm.key'))}</span><input class="input mono" data-r="key" maxlength="24" value="${esc(r.key)}"></label>
            <label class="ws-f"><span>${esc(t('tm.style'))}</span><select data-r="working_style">${STYLES.map(s => `<option value="${s}" ${s === r.working_style ? 'selected' : ''}>${esc(t('tm.st.' + s))}</option>`).join('')}</select></label>
            <label class="ws-f"><span>${esc(t('tm.exec'))}</span><select data-r="exec_role">${EXEC.map(s => `<option ${s === r.exec_role ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
            <label class="ws-check tm-span2"><input type="checkbox" data-r="may_delegate" ${r.may_delegate ? 'checked' : ''}> ${esc(t('tm.delegate'))}</label>
            <label class="ws-f tm-span2"><span>${esc(t('tm.persona'))}</span><textarea rows="2" maxlength="4000" data-r="persona">${esc(r.persona || '')}</textarea></label>
            ${SECTIONS.map(([k, lbl]) => `<label class="ws-f tm-span2"><span>${esc(t(lbl))}</span><textarea rows="3" maxlength="6000" data-md="${k}">${esc(md[k] || '')}</textarea></label>`).join('')}
          </div>
          <details class="tm-ov" ${Object.values(ov).some(v => Array.isArray(v) ? v.length : v) ? 'open' : ''}><summary>${esc(t('tm.override'))}</summary>
            <div class="tm-grid">
              <label class="ws-f tm-span2"><span>${esc(t('tm.workdir'))}</span><input class="input mono" data-o="workdir" list="tmProj" placeholder="${esc(t('tm.inherit'))}" value="${esc(ov.workdir || '')}"></label>
              <label class="ws-f"><span>${esc(t('tm.platform'))}</span><select data-o="platform">${platOpts(ov.platform || '', true)}</select></label>
              <label class="ws-f"><span>${esc(t('tm.model'))}</span><select data-o="model">${listOpts(p?.models, ov.model, true)}</select></label>
              <label class="ws-f"><span>${esc(t('tm.effort'))}</span><select data-o="effort" ${(p?.efforts || []).length ? '' : 'disabled'}>${listOpts(p?.efforts, ov.effort, true)}</select></label>
              <label class="ws-f"><span>${esc(t('tm.scopeMode'))}</span><select data-scope-mode>${['inherit', 'custom', 'readonly'].map(m => `<option value="${m}" ${m === scopeMode ? 'selected' : ''}>${esc(t('tm.sm.' + m))}</option>`).join('')}</select></label>
              <label class="ws-f tm-span2 ${scopeMode === 'custom' ? '' : 'hidden'}"><span>${esc(t('tm.scope'))}</span><textarea class="mono" rows="2" data-o="write_scope">${esc(scopeMode === 'custom' ? ov.write_scope.join('\n') : '')}</textarea></label>
            </div>
          </details>
          <div class="row-wrap tm-ract">
            <select data-act="libload" aria-label="${esc(t('tm.libLoad'))}"><option value="">${esc(t('tm.libLoad'))}</option>${T.profiles.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
            <button type="button" class="btn btn-sm" data-act="libsave">${esc(t('tm.libSave'))}</button>
            <span class="ws-grow"></span>
            <button type="button" class="btn btn-sm btn-danger" data-act="rmrole">${esc(t('tm.rmRole'))}</button>
          </div>`;
      }
      // Reads the form back into T (called before every re-render and every action).
      function collect() {
        const team = T.team; if (!team) return;
        const v = sel => body.querySelector(sel);
        if (v('[data-k="tname"]')) team.name = v('[data-k="tname"]').value.trim() || team.name;
        const sh = team.shared;
        for (const el of qsa('[data-s]', body)) {
          const k = el.dataset.s;
          if (el.type === 'checkbox') sh[k] = el.checked;
          else if (k === 'write_scope' || k === 'writable_dirs') sh[k] = lines(el.value);
          else if (k === 'max_parallel') sh[k] = Math.max(1, Math.min(6, +el.value || 3));
          else sh[k] = el.value.trim();
        }
        for (const el of qsa('[data-en]', body)) { const r = team.roles.find(x => x.key === el.dataset.en); if (r) r.enabled = el.checked; }
        const r = team.roles.find(x => x.key === T.sel);
        if (!r) return;
        const md = T.md[r.key] ||= {};
        for (const el of qsa('[data-r]', body)) {
          const k = el.dataset.r;
          if (k === 'key') continue;
          r[k] = el.type === 'checkbox' ? el.checked : el.value;
        }
        for (const el of qsa('[data-md]', body)) md[el.dataset.md] = el.value;
        const ov = {};
        for (const el of qsa('[data-o]', body)) {
          const k = el.dataset.o;
          if (k === 'write_scope') continue;
          if (el.value.trim()) ov[k] = el.value.trim();
        }
        const mode = qs('[data-scope-mode]', body)?.value || 'inherit';
        if (mode === 'readonly') ov.write_scope = [];
        else if (mode === 'custom') { const sc = lines(qs('[data-o="write_scope"]', body)?.value); ov.write_scope = sc.length ? sc : ['**']; }
        r.override = ov;
        const keyEl = v('[data-r="key"]');
        const nk = keyEl ? keyEl.value.trim() : r.key;
        if (nk !== r.key) {
          if (!KEY_RE.test(nk) || team.roles.some(x => x !== r && x.key === nk)) { M.toast(t('tm.keyBad'), 'warn'); keyEl.value = r.key; }
          else { T.md[nk] = T.md[r.key]; delete T.md[r.key]; r.key = nk; T.sel = nk; }
        }
      }
      function bind() {
        qs('[data-k="project"]', body).onchange = async e => { T.project = e.target.value; await loadProject(); render(); };
        qs('[data-act="tpl"]', body).onclick = () => { const id = qs('[data-k="tpl"]', body).value; useTemplate(T.templates.find(x => x.id === id)); render(); };
        qs('[data-act="tpldel"]', body)?.addEventListener('click', async () => {
          const tpl = T.templates.find(x => x.id === T.tplId);
          if (!tpl || !(await ws.confirmDlg(t('tm.cTplDel', { n: tpl.name }), { danger: true }))) return;
          try { await ws.post('team_template_delete', { id: tpl.id }); T.tplId = ''; await loadLib(); render(); } catch (e) { fail(e); }
        });
        for (const el of qsa('[data-s="platform"], [data-o="platform"], [data-scope-mode]', body)) el.onchange = () => { collect(); render(); };
        qsa('[data-role]', body).forEach(b => b.onclick = () => { collect(); T.sel = b.dataset.role; render(); });
        qs('[data-act="addrole"]', body).onclick = () => {
          collect();
          let n = 1; while (T.team.roles.some(r => r.key === 'role-' + n)) n++;
          const key = 'role-' + n;
          T.team.roles.push({ key, name: 'Role ' + n, enabled: true, working_style: 'per_task', persona: '', may_delegate: false, exec_role: 'backend', override: {}, agent_id: '' });
          T.md[key] = { responsibility: '', delegation: '', output: '', permissions: '' };
          T.sel = key; render();
        };
        qs('[data-act="suggest"]', body)?.addEventListener('click', suggest);
        qs('[data-act="rmrole"]', body)?.addEventListener('click', async () => {
          const r = T.team.roles.find(x => x.key === T.sel); if (!r) return;
          if (!(await ws.confirmDlg(t('tm.cRmRole', { n: r.name }), { danger: true }))) return;
          T.team.roles = T.team.roles.filter(x => x !== r); delete T.md[r.key];
          T.sel = T.team.roles[0]?.key || ''; render();
        });
        qs('[data-act="libsave"]', body)?.addEventListener('click', async () => {
          collect();
          const r = T.team.roles.find(x => x.key === T.sel); if (!r) return;
          const name = await ws.promptDlg(t('tm.libSave'), r.name, { max: 60 }); if (!name) return;
          const existing = T.profiles.find(x => x.name === name);
          try {
            const role = clone(r); delete role.agent_id;
            await ws.post('team_profile_save', { id: existing?.id, name, role, sections: T.md[r.key] || {} });
            M.toast(t('tm.libSaved', { n: name }), 'ok'); await loadLib(); render();
          } catch (e) { fail(e); }
        });
        qs('[data-act="libload"]', body)?.addEventListener('change', e => {
          const pf = T.profiles.find(x => x.id === e.target.value); if (!pf) return;
          collect();
          const r = T.team.roles.find(x => x.key === T.sel); if (!r) return;
          const { key, agent_id } = r;
          Object.assign(r, clone(pf.role), { key, agent_id });
          T.md[key] = clone(pf.sections) || {};
          render();
        });
      }
      async function suggest() {
        collect();
        try {
          const d = await ws.post('suggest_team', { project_path: T.project });
          const map = d.team || d.suggestion || d.roles || {};
          let n = 0;
          for (const r of T.team.roles) {
            const v = map[r.key] || map[r.exec_role];
            const id = typeof v === 'string' ? v : v?.agent;
            if (id && platforms().some(p => p.id === id)) { r.override = { ...(r.override || {}), platform: id }; n++; }
          }
          M.toast(t('tm.suggested', { n }), n ? 'ok' : 'info'); render();
        } catch (e) { M.toast(t('tm.noSuggest') + ' ' + (e?.message || ''), 'warn'); }
      }
      async function saveTeam() {
        if (!T.project) { M.toast(t('tm.pickProject'), 'warn'); return false; }
        try {
          const d = await ws.post('team_save', { project_path: T.project, team: T.team, roles_md: T.md });
          T.team = d.team || T.team; T.fromFile = true;
          M.toast(t('tm.saved'), 'ok'); render();
          return true;
        } catch (e) { fail(e); return false; }
      }
      async function applyTeam() {
        try {
          const d = await ws.post('team_apply', { project_path: T.project });
          M.toast(t('tm.applied', { n: (d.agents || []).length, g: d.group?.name || T.team.name }), 'ok');
          await ws.refresh();
          const lead = (d.agents || []).find(a => a.team_role === 'lead') || (d.agents || [])[0];
          if (lead) { M.showView('workspace'); ws.selectAgent(lead.id); }
        } catch (e) { fail(e); }
      }
      async function saveTemplate() {
        const cur = T.templates.find(x => x.id === T.tplId);
        const name = await ws.promptDlg(cur ? t('tm.updTpl') : t('tm.tplName'), cur?.name || T.team.name, { max: 60 });
        if (!name) return;
        try {
          const team = clone(T.team); delete team.id; for (const r of team.roles) delete r.agent_id;
          const d = await ws.post('team_template_save', { id: cur && cur.name === name ? cur.id : undefined, name, team, roles_md: T.md });
          T.tplId = d.template?.id || ''; await loadLib();
          M.toast(t('tm.tplSaved', { n: name }), 'ok'); render();
        } catch (e) { fail(e); }
      }
      function exportTeam() {
        const bundle = { kind: 'maw-team', version: 1, team: T.team, roles_md: T.md };
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(T.team.name || 'team').replace(/[^\w.-]+/g, '-').toLowerCase()}.maw-team.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      function importTeam() {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = async () => {
          const file = inp.files?.[0]; if (!file) return;
          let bundle;
          try { bundle = JSON.parse(await file.text()); if (bundle?.kind !== 'maw-team') throw new Error('kind != maw-team'); }
          catch (e) { M.toast(t('tm.badFile', { e: e.message }), 'err'); return; }
          if (!T.project) { M.toast(t('tm.pickProject'), 'warn'); return; }
          let overwrite = false;
          if (T.fromFile) { if (!(await ws.confirmDlg(t('tm.cOverwrite'), { danger: true }))) return; overwrite = true; }
          try {
            await ws.post('team_import', { project_path: T.project, bundle, overwrite });
            M.toast(t('tm.imported'), 'ok'); await loadProject(); render();
          } catch (e) { fail(e); }
        };
        inp.click();
      }
      // Agents the readiness check should cover: the applied ones, else a preview from the form.
      function teamAgentsPreview() {
        const all = ws.agents();
        return T.team.roles.filter(r => r.enabled !== false).map(r => {
          const a = all.find(x => x.id === r.agent_id && !x.deleted_at);
          return a || { id: '', name: r.name, team_role: r.key, platform: r.override?.platform || T.team.shared.platform, model: r.override?.model || T.team.shared.model };
        });
      }

      body.innerHTML = '<div class="empty">…</div>';
      try {
        await loadLib(); await loadProject();
        const tpl = opts.template && T.templates.find(x => x.id === opts.template);
        if (tpl) useTemplate(tpl);
        render();
      } catch (e) { fail(e); dlg.close(); }
    }

    // ---------- readiness (B3) ----------
    async function readiness(agents) {
      agents = (agents || []).filter(Boolean);
      const box = document.createElement('div');
      box.innerHTML = '<div class="empty">…</div>';
      ws.dialog({ title: t('rd.title'), wide: true, body: box, actions: [{ label: M.t('ws.close'), submit: true }] });
      if (!agents.length) { box.innerHTML = `<div class="empty">${esc(t('rd.none'))}</div>`; return; }
      const t0 = performance.now();
      const ids = [...new Set(agents.map(a => a.platform))];
      let health = null, note = '';
      if (has('health')) {
        try {
          const d = await ws.post('health_check', { agents: ids });
          const raw = d.agents || d.results || d.health || {};
          health = {};
          if (Array.isArray(raw)) for (const x of raw) health[x.id || x.agent] = x; else Object.assign(health, raw);
        } catch (e) { note = e.message; }
      }
      let plats = ws.platforms();
      if (!health) { try { plats = (await ws.get('ws_platforms', { refresh: 1 })).platforms || plats; } catch { /* keep cached */ } note = note || t('rd.noHealth'); }
      const ms = Math.round(performance.now() - t0);
      const rows = agents.map(a => {
        const p = plats.find(x => x.id === a.platform);
        const hh = health?.[a.platform];
        let ok, reason;
        if (hh) {
          ok = hh.ok ?? hh.healthy ?? (hh.status ? /^(ok|ready|healthy)$/i.test(hh.status) : undefined);
          reason = hh.reason || hh.error || hh.message || (hh.logged_in === false ? 'not logged in' : '');
          if (ok === undefined) ok = hh.installed !== false && hh.logged_in !== false;
        } else {
          ok = p ? (p.installed ? null : false) : false;
          reason = p ? (p.installed ? (p.version || '') : t('rd.missing')) : 'unknown platform';
        }
        const badge = ok === true ? `<span class="badge b-ok">${esc(t('rd.ok'))}</span>` : ok === false ? `<span class="badge b-err">${esc(t('rd.bad'))}</span>` : `<span class="badge b-warn">${esc(t('rd.unknown'))}</span>`;
        return `<tr><td>${esc(a.team_role || '—')}</td><td>${esc(a.name)}</td><td>${esc(p?.label || a.platform)}${hh?.version || p?.version ? ` <span class="faint">${esc(hh?.version || p?.version)}</span>` : ''}</td>
          <td class="mono">${esc(a.model || '—')}</td><td class="mono">${esc(a.last_actual_model || hh?.model || '—')}</td><td>${badge}</td><td class="faint">${esc(reason || '')}</td></tr>`;
      }).join('');
      box.innerHTML = `<div class="ws-tablewrap"><table class="ws-table"><thead><tr><th>${esc(t('rd.role'))}</th><th>${esc(t('rd.agent'))}</th><th>${esc(t('rd.platform'))}</th><th>${esc(t('rd.model'))}</th><th>${esc(t('rd.actual'))}</th><th>${esc(t('rd.status'))}</th><th>${esc(t('rd.reason'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="sub faint">${esc(t('rd.took', { ms }))}${note ? ' · ' + esc(note) : ''}</p>`;
    }

    ws.openTeamBuilder = openTeamBuilder;
    ws.readiness = readiness;
  });
})();
