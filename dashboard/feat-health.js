// S3 — Health & readiness (B2/B3), re-login (V7) and Doctor (N12). Talks to the page only through window.MAW.
// Also defines window.MAW_S3: helpers shared by the other S3 UIs (log viewer, login flow, time formatting).
(() => {
  const M = window.MAW;
  if (!M) return;
  const { api, t, esc, toast } = M;

  M.addI18n('vi', {
    s3hTab: 'Sức khỏe',
    s3hPill: 'Sẵn sàng {ok}/{n}',
    s3hPillNone: 'Sức khỏe',
    s3hPillTip: 'Kiểm tra miễn phí: cài đặt, đăng nhập, quota (không tốn token)',
    s3hTeamTitle: 'Kiểm tra sẵn sàng của team',
    s3hTeamHint: 'Thăm dò bằng lệnh CLI, không gọi LLM, không tốn token. Dùng team đang chọn ở bảng điều khiển.',
    s3hTeamBtn: 'Kiểm tra sẵn sàng',
    s3hRefresh: 'Bỏ cache',
    s3hAgentsTitle: 'Tất cả agent',
    s3hThRole: 'Vai trò', s3hThAgent: 'Agent', s3hThPlatform: 'Nền tảng', s3hThModel: 'Model thực tế', s3hThStatus: 'Trạng thái', s3hThReason: 'Lý do', s3hThFix: 'Khắc phục',
    s3hChecked: 'Kiểm tra lúc {time} · {ms} ms{cached}',
    s3hCached: ' · từ cache',
    s3hNotRun: 'Chưa kiểm tra. Bấm "Kiểm tra sẵn sàng" (khoảng 1 giây).',
    s3hLogin: 'Đăng nhập lại', s3hInstall: 'Sao chép lệnh cài', s3hStartIde: 'Mở Antigravity IDE',
    s3hOk: 'Sẵn sàng', s3hWarn: 'Cảnh báo', s3hErr: 'Lỗi',
    s3hLoginOk: 'Đã đăng nhập', s3hLoginOut: 'Chưa đăng nhập', s3hLoginUnknown: 'Không rõ', s3hLoginNa: '—',
    s3hNotInstalled: 'Chưa cài', s3hVersion: 'Phiên bản', s3hAuth: 'Đăng nhập', s3hQuota: 'Quota', s3hResets: 'đặt lại {time}',
    s3hSrcOverride: 'ghi đè', s3hSrcCli: 'cấu hình CLI', s3hSrcUnknown: 'không rõ',
    s3hDocTitle: 'Doctor',
    s3hDocHint: 'Thông tin của doctor.ps1: cài đặt, đăng nhập, phiên bản, cập nhật, scripts và hooks.',
    s3hDocRun: 'Chạy Doctor', s3hDocUpdates: 'Kiểm tra cập nhật',
    s3hDocUpdate: 'Có bản {v}', s3hDocLatest: 'Mới nhất',
    s3hDocEnv: 'Môi trường', s3hDocScripts: 'Scripts', s3hDocHooks: 'Hooks', s3hDocNotify: 'Thông báo',
    s3hDocMissing: 'thiếu', s3hDocNoHooks: 'Chưa có hook nào.',
    s3hCopyInstall: 'Lệnh cài', s3hCopyUpdate: 'Lệnh cập nhật', s3hOpenLogin: 'Mở terminal đăng nhập',
    s3hCopied: 'Đã sao chép: {cmd}', s3hCopyFail: 'Không sao chép được, lệnh: {cmd}',
    s3lTitle: 'Đăng nhập {agent}',
    s3lOpened: 'Đã mở cửa sổ terminal chạy: {cmd}. Đăng nhập trong đó rồi đóng cửa sổ.',
    s3lShared: 'Thông tin đăng nhập dùng chung cho mọi agent trên nền tảng {platform}.',
    s3lWaiting: 'Đang chờ cửa sổ đăng nhập đóng…',
    s3lChecking: 'Đang kiểm tra lại…',
    s3lDone: 'Đăng nhập thành công.',
    s3lStill: 'Vẫn chưa đăng nhập: {reason}',
    s3lRetry: 'Thử lại', s3lAgain: 'Mở lại terminal', s3lClose: 'Đóng',
    s3Log: 'Nhật ký {id}', s3LogGone: 'Nhật ký của job này đã bị dọn (job cũ hơn 2 giờ).', s3Close: 'Đóng'
  });
  M.addI18n('en', {
    s3hTab: 'Health',
    s3hPill: 'Ready {ok}/{n}',
    s3hPillNone: 'Health',
    s3hPillTip: 'Free check: installed, logged in, quota (no tokens spent)',
    s3hTeamTitle: 'Team readiness',
    s3hTeamHint: 'CLI probes only: no LLM call, no tokens. Uses the team picked on the dashboard.',
    s3hTeamBtn: 'Check readiness',
    s3hRefresh: 'Skip cache',
    s3hAgentsTitle: 'All agents',
    s3hThRole: 'Role', s3hThAgent: 'Agent', s3hThPlatform: 'Platform', s3hThModel: 'Actual model', s3hThStatus: 'Status', s3hThReason: 'Reason', s3hThFix: 'Fix',
    s3hChecked: 'Checked at {time} · {ms} ms{cached}',
    s3hCached: ' · cached',
    s3hNotRun: 'Not checked yet. Press "Check readiness" (about a second).',
    s3hLogin: 'Log in again', s3hInstall: 'Copy install command', s3hStartIde: 'Open the Antigravity IDE',
    s3hOk: 'Ready', s3hWarn: 'Warning', s3hErr: 'Error',
    s3hLoginOk: 'Logged in', s3hLoginOut: 'Logged out', s3hLoginUnknown: 'Unknown', s3hLoginNa: '—',
    s3hNotInstalled: 'Not installed', s3hVersion: 'Version', s3hAuth: 'Login', s3hQuota: 'Quota', s3hResets: 'resets {time}',
    s3hSrcOverride: 'override', s3hSrcCli: 'CLI config', s3hSrcUnknown: 'unknown',
    s3hDocTitle: 'Doctor',
    s3hDocHint: 'What doctor.ps1 reports: install, login, version, updates, scripts and hooks.',
    s3hDocRun: 'Run Doctor', s3hDocUpdates: 'Check for updates',
    s3hDocUpdate: '{v} available', s3hDocLatest: 'Up to date',
    s3hDocEnv: 'Environment', s3hDocScripts: 'Scripts', s3hDocHooks: 'Hooks', s3hDocNotify: 'Notifications',
    s3hDocMissing: 'missing', s3hDocNoHooks: 'No hooks installed.',
    s3hCopyInstall: 'Install cmd', s3hCopyUpdate: 'Update cmd', s3hOpenLogin: 'Open login terminal',
    s3hCopied: 'Copied: {cmd}', s3hCopyFail: 'Could not copy. Command: {cmd}',
    s3lTitle: 'Sign in to {agent}',
    s3lOpened: 'A terminal window is running: {cmd}. Sign in there, then close the window.',
    s3lShared: 'The login is shared by every agent on {platform}.',
    s3lWaiting: 'Waiting for the login window to close…',
    s3lChecking: 'Checking again…',
    s3lDone: 'Signed in.',
    s3lStill: 'Still not signed in: {reason}',
    s3lRetry: 'Retry', s3lAgain: 'Open the terminal again', s3lClose: 'Close',
    s3Log: 'Log {id}', s3LogGone: 'This job\'s log was cleaned up (jobs older than 2 hours are removed).', s3Close: 'Close'
  });

  // ---------- shared helpers (window.MAW_S3) ----------
  const locale = () => (M.lang === 'vi' ? 'vi-VN' : 'en-US');
  const time = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); };
  const dateTime = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s % 60 ? String(s % 60).padStart(2, '0') + 's' : '');
    const h = Math.floor(m / 60);
    return h + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') + 'm' : '');
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return '—';
    if (ms < 45000) return M.lang === 'vi' ? 'vừa xong' : 'just now';
    return M.lang === 'vi' ? dur(ms) + ' trước' : dur(ms) + ' ago';
  }
  let agentsCache = null;
  M.on('data', () => { agentsCache = null; });
  const agentInfo = id => ((agentsCache ||= M.agents?.() || {})[String(id || '').toLowerCase()]) || null;
  const agentLabel = id => agentInfo(id)?.label || id || '—';
  const agentColor = id => agentInfo(id)?.color || 'var(--faint)';
  const agentChip = id => `<span class="s3-agent"><span class="dot" style="background:${esc(agentColor(id))}"></span>${esc(agentLabel(id))}</span>`;
  const usd = n => '$' + Number(n || 0).toFixed(Number(n || 0) >= 1 ? 2 : 4);

  async function copy(cmd) {
    try { await navigator.clipboard.writeText(cmd); toast(t('s3hCopied', { cmd }), 'ok'); }
    catch { toast(t('s3hCopyFail', { cmd }), 'warn'); }
  }

  // A small overlay; returns { el, body, close }. Esc and the backdrop close it.
  function overlay(title, cls = '') {
    const prev = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 's3-ov';
    wrap.innerHTML = `<div class="s3-ov-box ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="s3-ov-h"><h2 class="truncate">${esc(title)}</h2><button type="button" class="btn btn-sm" data-x>${esc(t('s3Close'))}</button></div>
      <div class="s3-ov-b"></div></div>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-x]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-x]').focus();
    return { el: wrap, body: wrap.querySelector('.s3-ov-b'), close };
  }

  // Read-only log viewer for any job id (the dashboard's live log only follows the job it started).
  async function openLog(jobId) {
    const ov = overlay(t('s3Log', { id: jobId }), 's3-ov-wide');
    ov.body.innerHTML = `<div class="s3-loghead"></div><pre class="log s3-log">…</pre>`;
    const pre = ov.body.querySelector('pre'), head = ov.body.querySelector('.s3-loghead');
    let offset = 0, alive = true, text = '';
    const stop = new MutationObserver(() => { if (!ov.el.isConnected) { alive = false; stop.disconnect(); } });
    stop.observe(document.body, { childList: true });
    const tick = async () => {
      if (!alive) return;
      try {
        const r = await api('job_status&job_id=' + encodeURIComponent(jobId) + '&offset=' + offset);
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        text = (offset ? text : '') + (r.log_chunk || '');
        if (text.length > 400000) text = text.slice(-400000);
        offset = r.next_offset ?? offset;
        pre.textContent = text || '—';
        if (stick) pre.scrollTop = pre.scrollHeight;
        head.innerHTML = `${agentChip(r.agent)} <span class="t-muted">${esc(r.role || '')}</span> ${statusBadge(r.status)} <span class="t-muted">${esc(dur((r.elapsed_sec || 0) * 1000))}</span>${r.exit_code != null ? ` <span class="${r.exit_code ? 't-err' : 't-muted'}">exit ${esc(r.exit_code)}</span>` : ''}`;
        if (String(r.status).toUpperCase() === 'RUNNING') setTimeout(tick, 2000);
      } catch (e) {
        pre.textContent = e.status === 404 ? t('s3LogGone') : e.message;
      }
    };
    tick();
  }
  function statusBadge(s) {
    const u = String(s || '').toUpperCase() || 'UNKNOWN';
    return `<span class="badge ${u === 'DONE' ? 'b-ok' : u === 'RUNNING' ? 'b-warn' : u === 'FAILED' ? 'b-err' : ''}">${esc(u)}</span>`;
  }

  // ---------- V7: re-login ----------
  // Opens a real terminal running the platform's login command, waits for it to close, re-probes,
  // then offers "Retry" (opts.onRetry) — e.g. the inbox item's retry action.
  let loginCard = null;
  async function startLogin(agent, opts = {}) {
    let r;
    try { r = await api('login_open', { agent }); }
    catch (e) { toast(e.message, 'err'); return; }
    loginCard?.remove();
    const card = loginCard = document.createElement('div');
    card.className = 's3-login card';
    card.setAttribute('role', 'status');
    const platform = agentInfo(agent)?.adapter === 'cli' ? agentLabel(agent) : (agentInfo(agent)?.adapter || agent);
    const paint = (state, extra = '') => {
      if (!card.isConnected) return;
      const msg = state === 'wait' ? t('s3lWaiting') : state === 'check' ? t('s3lChecking') : state === 'ok' ? t('s3lDone') : t('s3lStill', { reason: extra });
      const dot = state === 'ok' ? 'ok' : state === 'bad' ? 'err' : 'warn live';
      card.innerHTML = `<div class="card-h"><h2 class="truncate">${esc(t('s3lTitle', { agent: agentLabel(agent) }))}</h2><button type="button" class="btn btn-sm" data-act="close">${esc(t('s3lClose'))}</button></div>
        <div class="card-b s3-stack">
          <p class="sub">${esc(t('s3lOpened', { cmd: r.command || '' }))}</p>
          <p class="sub t-muted">${esc(t('s3lShared', { platform }))}</p>
          <p class="row" style="gap:8px"><span class="dot ${dot}"></span><span>${esc(msg)}</span></p>
          <div class="row-wrap" style="gap:6px">
            ${state === 'ok' || state === 'bad' ? `<button type="button" class="btn btn-sm ${state === 'ok' ? 'btn-primary' : ''}" data-act="retry"${opts.onRetry ? '' : ' hidden'}>${esc(t('s3lRetry'))}</button>` : ''}
            ${state === 'bad' ? `<button type="button" class="btn btn-sm" data-act="again">${esc(t('s3lAgain'))}</button>` : ''}
          </div>
        </div>`;
    };
    card.addEventListener('click', e => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'close') { card.remove(); }
      if (a === 'retry') { card.remove(); opts.onRetry?.(); }
      if (a === 'again') { startLogin(agent, opts); }
    });
    document.body.appendChild(card);
    paint('wait');
    const pid = r.pid;
    const poll = async () => {
      if (!card.isConnected) return;
      let running = false;
      try { running = !!(await api('login_poll&pid=' + encodeURIComponent(pid))).running; } catch { running = false; }
      if (running) { setTimeout(poll, 3000); return; }
      paint('check');
      try {
        const h = await api('health_check&refresh=1&agents=' + encodeURIComponent(agent));
        const a = (h.agents || [])[0];
        if (a && a.login !== 'logged_out' && a.status !== 'error') paint('ok'); else paint('bad', a?.reason || '');
        lastAgents = mergeAgents(h.agents);
        renderPanel();
      } catch (e) { paint('bad', e.message); }
    };
    setTimeout(poll, 3000);
  }

  window.MAW_S3 = Object.assign(window.MAW_S3 || {}, { openLog, startLogin, overlay, copy, ago, dur, time, dateTime, agentChip, agentLabel, agentColor, statusBadge, usd });

  // ---------- header pill ----------
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'pill s3-hpill';
  pill.title = t('s3hPillTip');
  pill.innerHTML = '<span class="dot"></span><span class="truncate"></span>';
  pill.onclick = () => { const b = document.querySelector('#tabsCard [data-tab="health"]'); b?.click(); b?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  M.addHeaderItem(pill);
  function paintPill() {
    const h = M.state.data?.feature_data?.health;
    const s = h?.summary;
    const n = s ? (s.ok || 0) + (s.warn || 0) + (s.error || 0) : 0;
    pill.firstElementChild.className = 'dot ' + (!n ? '' : s.error ? 'err' : s.warn ? 'warn' : 'ok');
    pill.lastElementChild.textContent = n ? t('s3hPill', { ok: s.ok || 0, n }) : t('s3hPillNone');
    pill.title = t('s3hPillTip');
  }

  // ---------- tab ----------
  let panel = null, lastAgents = [], lastTeam = null, lastMeta = null, doctor = null, busy = false, docBusy = false;
  const mergeAgents = list => {
    const by = new Map(lastAgents.map(a => [a.id, a]));
    for (const a of list || []) by.set(a.id, a);
    return [...by.values()];
  };

  // The team currently picked on the dashboard board (falls back to the registry default team).
  function currentTeam() {
    const b = M.state.board;
    const team = {};
    if (b && b.assign) {
      if (b.kind === 'team') {
        if (b.assign.leader) team.leader = b.assign.leader;
        for (const [slot, on] of Object.entries(b.include || {})) if (on && b.assign[slot]) team[slot] = b.assign[slot];
      } else {
        for (const [slot, agent] of Object.entries(b.assign)) if (agent) team[slot] = agent;
      }
    }
    if (!Object.keys(team).length) Object.assign(team, M.state.data?.defaults?.team || {});
    return team;
  }

  async function checkTeam(refresh) {
    if (busy) return;
    busy = true; renderPanel();
    try {
      const team = currentTeam();
      const q = 'health_check' + (refresh ? '&refresh=1' : '') + '&team=' + encodeURIComponent(JSON.stringify(team));
      const r = await api(q);
      lastAgents = mergeAgents(r.agents);
      lastTeam = r.team_rows || [];
      lastMeta = { at: new Date().toISOString(), ms: r.ms, cached: r.cached };
    } catch (e) { toast(e.message, 'err'); }
    finally { busy = false; renderPanel(); }
  }

  async function runDoctor(updates) {
    if (docBusy) return;
    docBusy = true; renderPanel();
    try { doctor = await api('doctor_report' + (updates ? '&updates=1' : '')); }
    catch (e) { toast(e.message, 'err'); }
    finally { docBusy = false; renderPanel(); }
  }

  const stBadge = s => `<span class="badge ${s === 'ok' ? 'b-ok' : s === 'warn' ? 'b-warn' : s === 'error' ? 'b-err' : ''}">${esc(s === 'ok' ? t('s3hOk') : s === 'warn' ? t('s3hWarn') : s === 'error' ? t('s3hErr') : '—')}</span>`;
  const loginText = l => t(l === 'ok' ? 's3hLoginOk' : l === 'logged_out' ? 's3hLoginOut' : l === 'unknown' ? 's3hLoginUnknown' : 's3hLoginNa');
  const srcText = s => t(s === 'override' ? 's3hSrcOverride' : s === 'cli-config' ? 's3hSrcCli' : 's3hSrcUnknown');

  function fixButton(a) {
    const f = a?.fix;
    if (!f || !f.kind || a.status === 'ok') return '';
    if (f.kind === 'login') return `<button type="button" class="btn btn-sm" data-login="${esc(a.id)}">${esc(t('s3hLogin'))}</button>`;
    if (f.kind === 'install' && f.command) return `<button type="button" class="btn btn-sm" data-copy="${esc(f.command)}">${esc(t('s3hInstall'))}</button>`;
    if (f.kind === 'start-ide') return `<span class="sub t-muted">${esc(t('s3hStartIde'))}</span>`;
    return f.command ? `<button type="button" class="btn btn-sm" data-copy="${esc(f.command)}">${esc(f.command)}</button>` : '';
  }

  function quotaBar(q) {
    if (!q || q.used_percent == null) return '';
    const p = Math.max(0, Math.min(100, Number(q.used_percent) || 0));
    const cls = p >= 100 ? 'err' : p >= 90 ? 'warn' : '';
    return `<div class="kv"><span class="t-muted">${esc(t('s3hQuota'))}${q.window ? ' ' + esc(q.window) : ''}</span><span class="bar s3-q ${cls}"><i style="width:${p}%"></i></span><span class="num">${p}%</span></div>
      ${q.resets_at ? `<div class="sub t-muted">${esc(t('s3hResets', { time: dateTime(q.resets_at) }))}</div>` : ''}`;
  }

  function teamTable() {
    if (!lastTeam) return `<div class="empty">${esc(t('s3hNotRun'))}</div>`;
    if (!lastTeam.length) return `<div class="empty">—</div>`;
    const byId = new Map(lastAgents.map(a => [a.id, a]));
    return `<div class="table-wrap"><table class="s3-table"><thead><tr>
      <th>${esc(t('s3hThRole'))}</th><th>${esc(t('s3hThAgent'))}</th><th>${esc(t('s3hThPlatform'))}</th><th>${esc(t('s3hThModel'))}</th><th>${esc(t('s3hThStatus'))}</th><th>${esc(t('s3hThReason'))}</th><th>${esc(t('s3hThFix'))}</th>
      </tr></thead><tbody>${lastTeam.map(r => `<tr>
        <td>${esc(r.role)}</td><td>${agentChip(r.agent)}</td><td class="mono">${esc(r.platform || '—')}</td>
        <td><span class="mono">${esc(r.model || '—')}</span> <span class="sub t-muted">${esc(srcText(r.model_source))}</span></td>
        <td>${stBadge(r.status)}</td><td class="s3-reason">${esc(r.reason || '')}</td><td>${fixButton(byId.get(r.agent) || { id: r.agent, status: r.status, fix: r.fix })}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function agentCards() {
    if (!lastAgents.length) return '';
    return `<div class="s3-grid">${lastAgents.map(a => `<div class="s3-acard s3-st-${esc(a.status)}">
      <div class="row" style="gap:8px">${agentChip(a.id)}<span style="margin-left:auto">${stBadge(a.status)}</span></div>
      <dl class="s3-dl">
        <dt>${esc(t('s3hVersion'))}</dt><dd class="mono">${a.installed === false ? `<span class="t-err">${esc(t('s3hNotInstalled'))}</span>` : esc(a.version || '—')}</dd>
        <dt>${esc(t('s3hAuth'))}</dt><dd>${esc(loginText(a.login))}${a.auth_method ? ` <span class="sub t-muted">${esc(a.auth_method)}</span>` : ''}</dd>
        <dt>${esc(t('s3hThModel'))}</dt><dd class="mono truncate">${esc(a.model || '—')}</dd>
      </dl>
      ${quotaBar(a.quota)}
      ${a.reason ? `<p class="sub t-muted s3-reason">${esc(a.reason)}</p>` : ''}
      <div class="row-wrap" style="gap:6px">${fixButton(a)}</div>
    </div>`).join('')}</div>`;
  }

  function doctorBody() {
    if (!doctor) return '';
    const d = doctor;
    const plat = (d.platforms || []).map(p => `<tr>
      <td>${agentChip(p.id)}</td>
      <td>${p.installed ? `<span class="mono">${esc(p.version || '—')}</span>` : `<span class="t-err">${esc(t('s3hNotInstalled'))}</span>`}
        ${p.update_available ? ` <span class="badge b-info">${esc(t('s3hDocUpdate', { v: p.latest }))}</span>` : p.latest ? ` <span class="badge b-ok">${esc(t('s3hDocLatest'))}</span>` : ''}</td>
      <td>${esc(loginText(p.login))}</td><td>${stBadge(p.status)}</td>
      <td class="s3-actions">
        ${p.login_cmd && p.installed ? `<button type="button" class="btn btn-sm" data-login="${esc(p.id)}">${esc(t('s3hOpenLogin'))}</button>` : ''}
        ${p.install_cmd ? `<button type="button" class="btn btn-sm" data-copy="${esc(p.install_cmd)}" title="${esc(p.install_cmd)}">${esc(t('s3hCopyInstall'))}</button>` : ''}
        ${p.update_cmd && p.installed ? `<button type="button" class="btn btn-sm" data-copy="${esc(p.update_cmd)}" title="${esc(p.update_cmd)}">${esc(t('s3hCopyUpdate'))}</button>` : ''}
      </td></tr>`).join('');
    const env = Object.entries(d.environment || {}).map(([k, v]) => `<div class="kv"><span class="t-muted">${esc(k)}</span><span class="mono truncate" title="${esc(v ?? '')}">${esc(v ?? '—')}</span></div>`).join('');
    const sc = d.scripts || {};
    const files = [...(sc.required || []), ...(sc.agents_json_present != null ? [{ name: 'agents.json', present: sc.agents_json_present }] : [])];
    const dir = sc.scripts_dir || '';
    const scripts = `<div class="kv"><span class="t-muted">dir</span><span class="mono truncate" title="${esc(dir)}">${esc(dir || '—')}</span></div>
      ${files.map(f => `<div class="kv"><span class="dot ${f.ok ?? f.present ? 'ok' : 'err'}"></span><span class="mono truncate">${esc(f.name)}</span>${f.ok ?? f.present ? '' : `<span class="t-err">${esc(t('s3hDocMissing'))}</span>`}</div>`).join('')}
      ${(sc.registry_warnings || []).map(w => `<div class="kv t-warn">${esc(w)}</div>`).join('')}`;
    const hk = d.hooks || {};
    const hookRows = Object.entries(hk).filter(([, v]) => (v || []).length);
    const hooks = hookRows.length ? hookRows.map(([ev, list]) => `<div class="kv"><span class="badge">${esc(ev)}</span><span class="mono s3-wrap">${esc(list.join(', '))}</span></div>`).join('') : `<p class="sub t-muted">${esc(t('s3hDocNoHooks'))}</p>`;
    const nt = d.notify || {};
    const notify = Object.entries(nt).map(([k, v]) => `<div class="kv"><span class="dot ${v ? 'ok' : ''}"></span><span>${esc(k)}</span></div>`).join('');
    return `<div class="table-wrap"><table class="s3-table"><thead><tr><th>${esc(t('s3hThAgent'))}</th><th>${esc(t('s3hVersion'))}</th><th>${esc(t('s3hAuth'))}</th><th>${esc(t('s3hThStatus'))}</th><th></th></tr></thead><tbody>${plat}</tbody></table></div>
      <div class="s3-grid s3-grid-doc">
        <div><h3 class="s3-h3">${esc(t('s3hDocEnv'))}</h3>${env}</div>
        <div><h3 class="s3-h3">${esc(t('s3hDocScripts'))}</h3>${scripts}</div>
        <div><h3 class="s3-h3">${esc(t('s3hDocHooks'))}</h3>${hooks}<h3 class="s3-h3" style="margin-top:12px">${esc(t('s3hDocNotify'))}</h3>${notify}</div>
      </div>`;
  }

  function renderPanel() {
    if (!panel) return;
    if (!panel.dataset.s3) {
      panel.dataset.s3 = '1';
      panel.innerHTML = `<div class="s3">
        <section class="s3-sec"><div class="s3-sec-h"><div><h2 data-k="s3hTeamTitle"></h2><p class="sub t-muted" data-k="s3hTeamHint"></p></div>
          <div class="row-wrap s3-tools"><label class="btn btn-sm btn-toggle"><input type="checkbox" data-refresh><span data-k="s3hRefresh"></span></label><button type="button" class="btn btn-sm btn-primary" data-team></button></div></div>
          <p class="sub t-muted" data-meta></p><div data-teamtable></div></section>
        <section class="s3-sec"><div class="s3-sec-h"><h2 data-k="s3hAgentsTitle"></h2></div><div data-agents></div></section>
        <section class="s3-sec"><div class="s3-sec-h"><div><h2 data-k="s3hDocTitle"></h2><p class="sub t-muted" data-k="s3hDocHint"></p></div>
          <div class="row-wrap s3-tools"><button type="button" class="btn btn-sm" data-docup></button><button type="button" class="btn btn-sm" data-doc></button></div></div>
          <div data-doctor></div></section>
      </div>`;
      panel.addEventListener('click', e => {
        const el = e.target.closest('button');
        if (!el) return;
        if (el.hasAttribute('data-team')) checkTeam(panel.querySelector('[data-refresh]').checked);
        else if (el.hasAttribute('data-doc')) runDoctor(false);
        else if (el.hasAttribute('data-docup')) runDoctor(true);
        else if (el.dataset.login) startLogin(el.dataset.login, { onRetry: () => checkTeam(true) });
        else if (el.dataset.copy) copy(el.dataset.copy);
      });
    }
    for (const n of panel.querySelectorAll('[data-k]')) n.textContent = t(n.dataset.k);
    const teamBtn = panel.querySelector('[data-team]');
    teamBtn.textContent = t('s3hTeamBtn'); teamBtn.disabled = busy;
    teamBtn.classList.toggle('is-busy', busy);
    const doc = panel.querySelector('[data-doc]'), up = panel.querySelector('[data-docup]');
    doc.textContent = t('s3hDocRun'); up.textContent = t('s3hDocUpdates');
    doc.disabled = up.disabled = docBusy;
    panel.querySelector('[data-meta]').textContent = lastMeta ? t('s3hChecked', { time: time(lastMeta.at), ms: lastMeta.ms ?? '—', cached: lastMeta.cached ? t('s3hCached') : '' }) : '';
    panel.querySelector('[data-teamtable]').innerHTML = teamTable();
    panel.querySelector('[data-agents]').innerHTML = agentCards() || `<div class="empty">${esc(t('s3hNotRun'))}</div>`;
    panel.querySelector('[data-doctor]').innerHTML = doctorBody();
  }

  let tab = null;
  tab = M.addTab({
    id: 'health',
    title: () => t('s3hTab'),
    render(p) {
      panel = p;
      const h = M.state.data?.feature_data?.health;
      tab?.setCount(h?.summary?.error || '');
      // Seed the cards from the cached status data until a real check runs.
      if (!lastAgents.length && h?.agents) lastAgents = Object.entries(h.agents).map(([id, a]) => ({ id, ...a }));
      renderPanel();
    }
  });
  // First open of the tab runs the (cheap, cached) check once.
  document.querySelector('#tabsCard [data-tab="health"]')?.addEventListener('click', () => { if (!lastTeam && !busy) checkTeam(false); if (!doctor && !docBusy) runDoctor(false); });
  if (!document.querySelector('[data-panel="health"]')?.classList.contains('hidden')) { checkTeam(false); runDoctor(false); }

  M.on('data', paintPill);
  M.on('lang', () => { paintPill(); renderPanel(); });
  if (M.state.data) paintPill();
})();
