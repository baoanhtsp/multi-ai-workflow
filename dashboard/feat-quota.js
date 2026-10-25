// S7 — Accounts, quota and proactive routing (specs/s7-design.md §6). Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { esc, t } = M;

  M.addI18n('vi', {
    q7Tab: 'Tài khoản & hạn mức',
    q7Intro: 'Mỗi AI có thể có nhiều tài khoản (ví dụ Claude công việc và Claude cá nhân). Dashboard theo dõi hạn mức 5 giờ / 7 ngày của từng tài khoản và chuyển việc sang tài khoản hoặc AI còn lượt trước khi chạm giới hạn.',
    q7Refresh: 'Làm mới hạn mức', q7Add: '+ Thêm tài khoản', q7AddFor: 'Thêm tài khoản {agent}',
    q7Default: 'mặc định', q7Disabled: 'đang tắt', q7OnlyOne: 'chỉ dùng tài khoản mặc định',
    q7Login: 'Đăng nhập', q7Check: 'Kiểm tra', q7Edit: 'Sửa', q7Delete: 'Xoá',
    q7LoginOk: 'Đã đăng nhập', q7LoginOut: 'Chưa đăng nhập', q7LoginUnknown: 'Chưa rõ',
    q7SrcProvider: 'nhà cung cấp', q7SrcEstimate: 'ước lượng', q7NoData: 'Chưa có số liệu',
    q7Resets: 'mở lại sau {d}', q7Cooling: 'Đang bị giới hạn tới {t}', q7Checked: 'kiểm tra {d} trước',
    q7Lvl_ok: 'Còn nhiều', q7Lvl_warn: 'Sắp đầy', q7Lvl_high: 'Gần hết', q7Lvl_full: 'Hết lượt',
    q7Pill: '{agent} · {acc} {pct}%', q7PillTip: 'Tài khoản dùng nhiều nhất. Bấm để xem mọi tài khoản.', q7PillNone: 'Hạn mức',
    q7Routing: 'Định tuyến theo hạn mức',
    q7RoutingX: 'Trước khi chạy một job, dashboard kiểm tra hạn mức tài khoản được chọn. Nếu đã vượt ngưỡng, việc được chuyển sang tài khoản khác của cùng AI, rồi tới AI dự phòng của vai đó.',
    q7Mode: 'Chế độ', q7Mode_auto: 'Tự chuyển', q7Mode_suggest: 'Hỏi trước', q7Mode_off: 'Tắt',
    q7SwitchAt: 'Chuyển khi đạt', q7Prefer: 'Ưu tiên', q7Prefer_same: 'Tài khoản khác của cùng AI trước', q7Prefer_any: 'Tài khoản còn nhiều lượt nhất, AI nào cũng được',
    q7AllFull: 'Khi mọi tài khoản đều hết', q7AllFull_wait: 'Chờ tới lúc mở lại', q7AllFull_run: 'Vẫn chạy trên tài khoản ít dùng nhất',
    q7Save: 'Lưu', q7Saved: 'Đã lưu cài đặt định tuyến.',
    q7FormId: 'Mã tài khoản', q7FormIdHint: 'Chữ thường, số, dấu gạch ngang. Ví dụ: work, personal, client-a',
    q7FormLabel: 'Tên hiển thị', q7FormDir: 'Thư mục cấu hình (tuỳ chọn)',
    q7FormDirHint: 'Mỗi tài khoản đăng nhập riêng trong một thư mục cấu hình riêng. Để trống: dashboard tạo {dir}. Không sao chép mật khẩu hay token.',
    q7FormPriority: 'Thứ tự ưu tiên', q7FormLimits: 'Giới hạn để ước lượng (token, 0 = không đặt)', q7FormEnabled: 'Đang dùng',
    q7SavedAcc: 'Đã lưu tài khoản {acc}. Bấm “Đăng nhập” để đăng nhập tài khoản này.',
    q7ConfirmDel: 'Xoá tài khoản {acc} khỏi dashboard? Thư mục cấu hình được giữ lại.',
    q7LoginStarted: 'Đã mở terminal đăng nhập cho {acc}.', q7Missing: 'Máy chủ chưa có chức năng tài khoản (S7).',
  });
  M.addI18n('en', {
    q7Tab: 'Accounts & quota',
    q7Intro: 'Each AI can have several accounts (for example a work and a personal Claude). The dashboard tracks the 5-hour / 7-day quota of every account and moves work to an account or AI that has room before a limit is hit.',
    q7Refresh: 'Refresh quota', q7Add: '+ Add account', q7AddFor: 'Add a {agent} account',
    q7Default: 'default', q7Disabled: 'disabled', q7OnlyOne: 'default account only',
    q7Login: 'Sign in', q7Check: 'Check', q7Edit: 'Edit', q7Delete: 'Delete',
    q7LoginOk: 'Signed in', q7LoginOut: 'Signed out', q7LoginUnknown: 'Unknown',
    q7SrcProvider: 'provider', q7SrcEstimate: 'estimate', q7NoData: 'No data yet',
    q7Resets: 'resets in {d}', q7Cooling: 'Rate-limited until {t}', q7Checked: 'checked {d} ago',
    q7Lvl_ok: 'Plenty left', q7Lvl_warn: 'Filling up', q7Lvl_high: 'Almost out', q7Lvl_full: 'Out',
    q7Pill: '{agent} · {acc} {pct}%', q7PillTip: 'The most used account. Click to see all accounts.', q7PillNone: 'Quota',
    q7Routing: 'Quota routing',
    q7RoutingX: 'Before a job runs, the dashboard checks the quota of the selected account. Above the threshold, the work goes to another account of the same AI, then to the fallback AIs of that role.',
    q7Mode: 'Mode', q7Mode_auto: 'Switch automatically', q7Mode_suggest: 'Ask first', q7Mode_off: 'Off',
    q7SwitchAt: 'Switch at', q7Prefer: 'Prefer', q7Prefer_same: 'Other accounts of the same AI first', q7Prefer_any: 'The account with the most room, any AI',
    q7AllFull: 'When every account is full', q7AllFull_wait: 'Wait until one resets', q7AllFull_run: 'Run on the least used account anyway',
    q7Save: 'Save', q7Saved: 'Routing settings saved.',
    q7FormId: 'Account id', q7FormIdHint: 'Lower case, digits and dashes. For example: work, personal, client-a',
    q7FormLabel: 'Display name', q7FormDir: 'Config folder (optional)',
    q7FormDirHint: 'Each account signs in separately in its own config folder. Empty: the dashboard creates {dir}. No password or token is copied.',
    q7FormPriority: 'Priority', q7FormLimits: 'Caps for estimates (tokens, 0 = none)', q7FormEnabled: 'In use',
    q7SavedAcc: 'Account {acc} saved. Press “Sign in” to sign this account in.',
    q7ConfirmDel: 'Remove account {acc} from the dashboard? Its config folder is kept.',
    q7LoginStarted: 'Opened a sign-in terminal for {acc}.', q7Missing: 'The server has no accounts feature (S7) yet.',
  });

  const S = { panel: null, accounts: [], adapters: {}, snaps: [], routing: null, fallback: null, at: 0, loading: false, error: '' };
  const WINDOWS = ['5h', '7d'];
  const get = (action, params) => M.api(action + Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join(''));
  const agents = () => { try { return M.agents() || {}; } catch { return {}; } };
  const agentLabel = id => agents()[id]?.label || id;
  const agentColor = id => agents()[id]?.color || 'var(--faint)';
  const has = () => (M.state.data?.features || []).includes('quota');
  const snapOf = (agent, acc) => S.snaps.find(s => s.agent === agent && s.account === acc) || null;
  const accLabel = a => a.id === 'default' && !a.label ? t('q7Default') : (a.label || a.id);
  const LVL_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', high: 'var(--err)', full: 'var(--err)' };
  function dur(ms) {
    if (!(ms > 0)) return '0m';
    const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
  }
  const modal = () => window.MAWS1?.openModal;
  const confirmBox = (msg) => window.MAWS1?.confirmBox ? window.MAWS1.confirmBox(msg) : Promise.resolve(window.confirm(msg));

  // ---------- header pill: the most used account ----------
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'pill q7-pill hidden';
  pill.innerHTML = '<span class="q7-pill-bar"><i></i></span><span class="truncate"></span>';
  pill.addEventListener('click', () => { if (typeof goPage === 'function') goPage('accounts'); });
  M.addHeaderItem(pill);
  function paintPill() {
    const q = M.state.data?.feature_data?.quota;
    const w = q?.worst;
    pill.classList.toggle('hidden', !has() || !w);
    if (!w) return;
    const p = Math.max(0, Math.min(100, Math.round(Number(w.used_percent) || 0)));
    pill.dataset.level = w.level || 'ok';
    pill.querySelector('i').style.width = p + '%';
    pill.querySelector('i').style.background = LVL_COLOR[w.level] || 'var(--ok)';
    pill.lastElementChild.textContent = t('q7Pill', { agent: agentLabel(w.agent), acc: w.account === 'default' ? t('q7Default') : w.account, pct: p });
    pill.title = t('q7PillTip') + (w.resets_at ? ' · ' + t('q7Resets', { d: dur(new Date(w.resets_at) - Date.now()) }) : '');
  }

  // ---------- data ----------
  async function load(force) {
    if (!has() || S.loading || (!force && Date.now() - S.at < 30000)) return;
    S.loading = true;
    try {
      const [acc, quota, fb] = await Promise.all([M.api('account_list'), M.api('quota_get'), M.api('fallback_get').catch(() => null)]);
      S.accounts = acc.accounts || []; S.adapters = acc.adapters || {};
      S.snaps = quota.snapshots || []; S.routing = quota.routing || fb?.config?.quota_routing || null;
      S.fallback = fb?.config || null; S.error = '';
    } catch (e) { S.error = e.message; }
    finally { S.loading = false; S.at = Date.now(); paint(); }
  }

  // ---------- panel ----------
  function bar(win, snap) {
    const w = (snap?.windows || []).find(x => x.id === win);
    if (!w) return `<div class="q7-win is-empty"><span class="q7-win-id">${esc(win)}</span><span class="faint">—</span></div>`;
    const p = Math.max(0, Math.min(100, Math.round(Number(w.used_percent) || 0)));
    const lvl = p >= 100 ? 'full' : p >= (S.routing?.switch_at || 85) ? 'high' : p >= 70 ? 'warn' : 'ok';
    const resets = w.resets_at ? t('q7Resets', { d: dur(new Date(w.resets_at) - Date.now()) }) : '';
    return `<div class="q7-win" title="${esc(w.source === 'estimate' ? t('q7SrcEstimate') : t('q7SrcProvider'))}">
      <span class="q7-win-id">${esc(win)}</span>
      <span class="q7-bar"><i style="width:${p}%;background:${LVL_COLOR[lvl]}"></i></span>
      <span class="q7-pct">${p}%</span>
      <span class="q7-reset faint">${esc(resets)}${w.source === 'estimate' ? ` · ${esc(t('q7SrcEstimate'))}` : ''}</span></div>`;
  }
  function row(a) {
    const snap = snapOf(a.agent, a.id);
    const login = a.login || snap?.login || 'unknown';
    const loginBadge = M.badge(t(login === 'ok' ? 'q7LoginOk' : login === 'logged_out' ? 'q7LoginOut' : 'q7LoginUnknown'), login === 'ok' ? 'b-ok' : login === 'logged_out' ? 'b-err' : '');
    const cooling = snap?.cooldown_until && new Date(snap.cooldown_until) > Date.now();
    const supported = S.adapters[a.agent]?.supported !== false;
    return `<div class="q7-row${a.enabled === false ? ' is-off' : ''}">
      <div class="q7-who"><span class="dot" style="background:${esc(agentColor(a.agent))}"></span>
        <div class="q7-who-t"><b>${esc(agentLabel(a.agent))}</b> · ${esc(accLabel(a))}${a.is_default || a.id === 'default' ? ` <span class="q7-tag">${esc(t('q7Default'))}</span>` : ''}${a.enabled === false ? ` <span class="q7-tag">${esc(t('q7Disabled'))}</span>` : ''}
          <div class="sub">${loginBadge}${snap?.level ? ` ${M.badge(t('q7Lvl_' + snap.level), snap.level === 'ok' ? 'b-ok' : snap.level === 'warn' ? 'b-warn' : 'b-err')}` : ''}${cooling ? ` <span class="t-err">${esc(t('q7Cooling', { t: new Date(snap.cooldown_until).toLocaleTimeString() }))}</span>` : ''}</div></div></div>
      <div class="q7-wins">${snap ? WINDOWS.map(w => bar(w, snap)).join('') : `<span class="sub faint">${esc(t('q7NoData'))}</span>`}</div>
      <div class="q7-acts">
        ${supported ? `<button type="button" class="btn btn-sm" data-q7="login" data-agent="${esc(a.agent)}" data-acc="${esc(a.id)}">${esc(t('q7Login'))}</button>` : ''}
        <button type="button" class="btn btn-sm" data-q7="check" data-agent="${esc(a.agent)}" data-acc="${esc(a.id)}">${esc(t('q7Check'))}</button>
        ${a.id !== 'default' ? `<button type="button" class="btn btn-sm" data-q7="edit" data-agent="${esc(a.agent)}" data-acc="${esc(a.id)}">${esc(t('q7Edit'))}</button>
        <button type="button" class="btn btn-sm btn-link danger" data-q7="del" data-agent="${esc(a.agent)}" data-acc="${esc(a.id)}">${esc(t('q7Delete'))}</button>` : ''}
      </div></div>`;
  }
  function routingForm() {
    const r = S.routing || { enabled: true, mode: 'auto', switch_at: 85, prefer: 'same-agent', when_all_full: 'wait' };
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return `<section class="q7-sec">
      <div class="q7-sec-h"><h3>${esc(t('q7Routing'))}</h3><span class="spacer"></span><button type="button" class="btn btn-sm btn-primary" data-q7="save-routing">${esc(t('q7Save'))}</button></div>
      <p class="sub">${esc(t('q7RoutingX'))}</p>
      <div class="q7-grid">
        <label class="q7-f"><span class="lbl">${esc(t('q7Mode'))}</span><select class="input" name="mode">${['auto', 'suggest', 'off'].map(v => opt(v, r.enabled === false ? 'off' : r.mode, t('q7Mode_' + v))).join('')}</select></label>
        <label class="q7-f"><span class="lbl">${esc(t('q7SwitchAt'))} <b data-q7out>${+r.switch_at || 85}%</b></span><input type="range" name="switch_at" min="50" max="99" step="1" value="${+r.switch_at || 85}"></label>
        <label class="q7-f"><span class="lbl">${esc(t('q7Prefer'))}</span><select class="input" name="prefer">${opt('same-agent', r.prefer, t('q7Prefer_same'))}${opt('any', r.prefer, t('q7Prefer_any'))}</select></label>
        <label class="q7-f"><span class="lbl">${esc(t('q7AllFull'))}</span><select class="input" name="when_all_full">${opt('wait', r.when_all_full, t('q7AllFull_wait'))}${opt('run', r.when_all_full, t('q7AllFull_run'))}</select></label>
      </div></section>`;
  }
  function paint() {
    paintPill();
    const panel = S.panel; if (!panel) return;
    if (!has()) { panel.innerHTML = `<div class="empty">${esc(t('q7Missing'))}</div>`; return; }
    if (!S.at) { panel.innerHTML = `<div class="empty">…</div>`; return; }
    // Accounts grouped by agent; the implicit default account of each installed agent comes first.
    const ids = [...new Set([...Object.keys(agents()).filter(id => agents()[id].installed), ...S.accounts.map(a => a.agent)])];
    const groups = ids.map(id => {
      const list = S.accounts.filter(a => a.agent === id);
      if (!list.some(a => a.id === 'default')) list.unshift({ agent: id, id: 'default', label: '', enabled: true, is_default: true });
      list.sort((x, y) => (x.id === 'default' ? -1 : y.id === 'default' ? 1 : (x.priority ?? 0) - (y.priority ?? 0)));
      return { id, list, supported: S.adapters[id]?.supported !== false };
    });
    const addMenu = groups.filter(g => g.supported).map(g => `<button type="button" class="btn btn-sm" data-q7="add" data-agent="${esc(g.id)}">${esc(t('q7AddFor', { agent: agentLabel(g.id) }))}</button>`).join('');
    panel.innerHTML = `<div class="q7-body">
      <section class="q7-sec">
        <div class="q7-sec-h"><p class="sub q7-intro">${esc(t('q7Intro'))}</p><span class="spacer"></span>
          <button type="button" class="btn btn-sm" data-q7="refresh"${S.loading ? ' disabled' : ''}>${esc(t('q7Refresh'))}</button></div>
        ${S.error ? `<div class="callout t-err">${esc(S.error)}</div>` : ''}
        <div class="q7-list">${groups.map(g => g.list.map(row).join('') + (g.supported ? '' : `<div class="q7-note sub faint">${esc(agentLabel(g.id))}: ${esc(t('q7OnlyOne'))}</div>`)).join('')}</div>
        ${addMenu ? `<div class="q7-add">${addMenu}</div>` : ''}
      </section>
      ${routingForm()}
    </div>`;
    const range = panel.querySelector('input[name="switch_at"]');
    if (range) range.oninput = () => { panel.querySelector('[data-q7out]').textContent = range.value + '%'; };
  }

  // ---------- actions ----------
  async function editAccount(agent, id) {
    const open = modal();
    const cur = S.accounts.find(a => a.agent === agent && a.id === id) || { agent, id: '', label: '', dir: '', priority: 0, enabled: true, limits: { '5h': { tokens: 0 }, '7d': { tokens: 0 } } };
    const defDir = `~\\.maw\\accounts\\${agent}\\<id>`;
    const html = `<div class="q7-form">
      <label class="q7-f"><span class="lbl">${esc(t('q7FormId'))}</span><input class="input" name="id" maxlength="24" pattern="[a-z0-9][a-z0-9-]{0,23}" value="${esc(cur.id)}" ${cur.id ? 'readonly' : ''}><span class="sub faint">${esc(t('q7FormIdHint'))}</span></label>
      <label class="q7-f"><span class="lbl">${esc(t('q7FormLabel'))}</span><input class="input" name="label" maxlength="40" value="${esc(cur.label || '')}"></label>
      <label class="q7-f"><span class="lbl">${esc(t('q7FormDir'))}</span><input class="input mono" name="dir" value="${esc(cur.dir || '')}" placeholder="${esc(defDir)}"><span class="sub faint">${esc(t('q7FormDirHint', { dir: defDir }))}</span></label>
      <div class="q7-grid">
        <label class="q7-f"><span class="lbl">${esc(t('q7FormPriority'))}</span><input class="input" type="number" name="priority" min="0" max="99" value="${+cur.priority || 0}"></label>
        <label class="q7-f"><span class="lbl">5h · ${esc(t('q7FormLimits'))}</span><input class="input" type="number" name="l5h" min="0" value="${+cur.limits?.['5h']?.tokens || 0}"></label>
        <label class="q7-f"><span class="lbl">7d · ${esc(t('q7FormLimits'))}</span><input class="input" type="number" name="l7d" min="0" value="${+cur.limits?.['7d']?.tokens || 0}"></label>
      </div>
      <label class="s1-check"><input type="checkbox" name="enabled" ${cur.enabled !== false ? 'checked' : ''}> ${esc(t('q7FormEnabled'))}</label></div>`;
    const submit = async body => {
      const g = n => body.querySelector(`[name="${n}"]`);
      const account = { agent, id: g('id').value.trim(), label: g('label').value.trim(), dir: g('dir').value.trim(), priority: +g('priority').value || 0, enabled: g('enabled').checked,
        limits: { '5h': { tokens: +g('l5h').value || 0 }, '7d': { tokens: +g('l7d').value || 0 } } };
      const r = await M.api('account_save', { account });
      M.toast(t('q7SavedAcc', { acc: r.account?.label || account.id }), 'ok');
      load(true);
    };
    if (open) await open({ title: cur.id ? `${agentLabel(agent)} · ${cur.label || cur.id}` : t('q7AddFor', { agent: agentLabel(agent) }), html, buttons: [{ id: 'ok', label: t('q7Save') }], onAction: async (bid, body) => { if (bid === 'ok') await submit(body); } });
  }
  async function saveRouting() {
    const f = n => S.panel.querySelector(`[name="${n}"]`).value;
    const mode = f('mode');
    const quota_routing = { enabled: mode !== 'off', mode: mode === 'off' ? (S.routing?.mode || 'auto') : mode, switch_at: +f('switch_at'), prefer: f('prefer'), when_all_full: f('when_all_full') };
    const fb = S.fallback || (await M.api('fallback_get')).config || {};
    await M.api('fallback_save', { config: { ...fb, quota_routing } });
    S.routing = quota_routing;
    M.toast(t('q7Saved'), 'ok');
    load(true);
  }
  async function onClick(e) {
    const b = e.target.closest('[data-q7]'); if (!b) return;
    const { agent, acc } = b.dataset;
    try {
      if (b.dataset.q7 === 'refresh') { b.disabled = true; await M.api('quota_refresh', {}); await load(true); }
      else if (b.dataset.q7 === 'add') await editAccount(agent, '');
      else if (b.dataset.q7 === 'edit') await editAccount(agent, acc);
      else if (b.dataset.q7 === 'del') {
        if (!(await confirmBox(t('q7ConfirmDel', { acc })))) return;
        await M.api('account_delete', { agent, id: acc }); load(true);
      }
      else if (b.dataset.q7 === 'login') { await M.api('account_login', { agent, account: acc }); M.toast(t('q7LoginStarted', { acc: `${agentLabel(agent)} · ${acc}` }), 'ok'); }
      else if (b.dataset.q7 === 'check') { const r = await get('account_status', { agent, account: acc }); M.toast(`${agentLabel(agent)} · ${acc}: ${r.login}${r.detail ? ' — ' + r.detail : ''}`, r.login === 'ok' ? 'ok' : 'warn'); load(true); }
      else if (b.dataset.q7 === 'save-routing') await saveRouting();
    } catch (err) { M.toast(err.message, 'err'); }
  }

  // ---------- registration: a companion panel of the Agents page ----------
  const tab = M.addTab({
    id: 'accounts',
    title: () => t('q7Tab'),
    render(panel) {
      if (!S.panel) { S.panel = panel; panel.addEventListener('click', onClick); }
      paintPill();
      if (!panel.classList.contains('hidden')) load(false);
    },
  });
  if (tab && !has()) tab.button.classList.add('hidden');
  M.on('data', () => { if (tab) tab.button.classList.toggle('hidden', !has()); paintPill(); });
  M.on('lang', paint);
  // Countdowns stay fresh while the panel is open.
  setInterval(() => { if (S.panel && !S.panel.classList.contains('hidden') && !document.hidden) load(false); }, 60000);
})();
