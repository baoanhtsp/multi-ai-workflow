// S4 — Cost & routing UI: budgets (B5), fallback routing + auto-recovery (B2 / V6). Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { esc, t } = M;

  M.addI18n('vi', {
    s4bTab: 'Chi phí & định tuyến',
    s4bToday: 'Hôm nay', s4bProject: 'Dự án', s4bNoCap: 'không giới hạn', s4bOf: '/',
    s4bSpend14: 'Chi phí 14 ngày', s4bByAgent: 'Theo agent hôm nay', s4bRunning: 'Job đang chạy',
    s4bBudgets: 'Ngân sách', s4bScope: 'Phạm vi', s4bWarn: 'Cảnh báo', s4bBlock: 'Chặn',
    s4bUsd: 'USD', s4bTokens: 'Token', s4bPeriod: 'Chu kỳ',
    s4bScope_job: 'Mỗi job', s4bScope_team_run: 'Mỗi lượt team', s4bScope_day: 'Mỗi ngày', s4bScope_project: 'Mỗi dự án', s4bScope_agent_day: 'Mỗi agent / ngày',
    s4bPeriod_day: 'ngày', s4bPeriod_week: 'tuần', s4bPeriod_month: 'tháng', s4bPeriod_all: 'tất cả',
    s4bEnabled: 'Bật ngân sách', s4bEstimate: 'Cộng chi phí ước tính của lượt gọi kế tiếp trước khi so với ngưỡng chặn',
    s4bZeroHint: '0 = không giới hạn. Cảnh báo phải ≤ chặn.',
    s4bOverride: 'Ghi đè cho dự án đang chọn', s4bOverrideNone: 'Chọn một dự án để đặt ngân sách riêng.',
    s4bUseOverride: 'Dùng ngân sách riêng cho {name}',
    s4bSave: 'Lưu', s4bReload: 'Tải lại', s4bSaved: 'Đã lưu.',
    s4bRouting: 'Định tuyến dự phòng', s4bRoutingHint: 'Khi một agent lỗi đăng nhập, bị giới hạn hoặc vượt ngân sách, job chuyển sang agent kế tiếp trong danh sách.',
    s4bRole: 'Vai trò', s4bFallbacks: 'Thứ tự dự phòng', s4bAuto: 'Tự chuyển', s4bAdd: '+ Thêm', s4bNone: '— chưa có —',
    s4bRecovery: 'Tự hồi phục', s4bRecEnabled: 'Tự chạy lại khi gặp lỗi tạm thời (429 / 529 / overloaded)',
    s4bBackoff: 'Các bước chờ (giây)', s4bMaxAttempts: 'Số lần thử tối đa', s4bWaitReset: 'Hết hạn mức: chờ đến lúc reset rồi chạy tiếp',
    s4bGrace: 'Cộng thêm sau giờ reset (giây)', s4bMaxWait: 'Chờ tối đa (giây)', s4bPreferFb: 'Hết hạn mức + tự chuyển: đổi agent ngay thay vì chờ',
    s4bQueue: 'Hàng chờ hồi phục', s4bQueueEmpty: 'Không có job nào đang chờ hồi phục.',
    s4bCooldowns: 'Agent đang bị giới hạn', s4bClear: 'Bỏ giới hạn',
    s4bRunNow: 'Chạy ngay', s4bCancel: 'Huỷ', s4bWith: 'Chạy với {agent}',
    s4bWaitUntil: 'Đang chờ hồi phục (đến {time})', s4bRerun: 'Đã chạy lại: {id}',
    s4bConfirmCancel: 'Huỷ việc hồi phục cho {id}?', s4bConfirmRun: 'Chạy lại {id} ngay bây giờ?',
    s4bConfirmClear: 'Bỏ trạng thái giới hạn của {agent}? (dùng khi bạn đã đăng nhập lại hoặc nạp thêm hạn mức)',
    s4bStarted: 'Đã chạy job mới: {id}', s4bKind_transient: 'lỗi tạm thời', s4bKind_usage_limit: 'hết hạn mức', s4bKind_fallback: 'dự phòng', s4bKind_approval: 'phê duyệt',
    s4bAttempt: 'lần {n}', s4bIn: 'còn {d}', s4bLevel_ok: 'trong ngân sách', s4bLevel_warn: 'gần chạm ngưỡng', s4bLevel_block: 'đã chạm ngưỡng chặn',
    s4bSharedNote: 'Hai job chạy cùng lúc trên cùng dự án có thể bị tính lẫn chi phí của nhau.',
    s4bInvalid: 'Giá trị không hợp lệ: {f}',
  });
  M.addI18n('en', {
    s4bTab: 'Cost & routing',
    s4bToday: 'Today', s4bProject: 'Project', s4bNoCap: 'no cap', s4bOf: '/',
    s4bSpend14: 'Spend, last 14 days', s4bByAgent: 'By agent today', s4bRunning: 'Running jobs',
    s4bBudgets: 'Budgets', s4bScope: 'Scope', s4bWarn: 'Warn', s4bBlock: 'Block',
    s4bUsd: 'USD', s4bTokens: 'Tokens', s4bPeriod: 'Period',
    s4bScope_job: 'Per job', s4bScope_team_run: 'Per team run', s4bScope_day: 'Per day', s4bScope_project: 'Per project', s4bScope_agent_day: 'Per agent / day',
    s4bPeriod_day: 'day', s4bPeriod_week: 'week', s4bPeriod_month: 'month', s4bPeriod_all: 'all time',
    s4bEnabled: 'Budgets enabled', s4bEstimate: 'Add the estimated cost of the next call before comparing with the block cap',
    s4bZeroHint: '0 = no cap. Warn must be ≤ block.',
    s4bOverride: 'Override for the selected project', s4bOverrideNone: 'Pick a project to give it its own budget.',
    s4bUseOverride: 'Use a separate budget for {name}',
    s4bSave: 'Save', s4bReload: 'Reload', s4bSaved: 'Saved.',
    s4bRouting: 'Fallback routing', s4bRoutingHint: 'When an agent is logged out, rate-limited or over budget, the job moves to the next agent in the list.',
    s4bRole: 'Role', s4bFallbacks: 'Fallback order', s4bAuto: 'Auto switch', s4bAdd: '+ Add', s4bNone: '— none —',
    s4bRecovery: 'Auto-recovery', s4bRecEnabled: 'Re-run automatically on transient errors (429 / 529 / overloaded)',
    s4bBackoff: 'Backoff steps (seconds)', s4bMaxAttempts: 'Max attempts', s4bWaitReset: 'Usage limit: wait for the reset, then continue',
    s4bGrace: 'Extra wait after the reset (seconds)', s4bMaxWait: 'Max wait (seconds)', s4bPreferFb: 'Usage limit + auto switch: switch agent now instead of waiting',
    s4bQueue: 'Recovery queue', s4bQueueEmpty: 'No job is waiting to recover.',
    s4bCooldowns: 'Rate-limited agents', s4bClear: 'Clear',
    s4bRunNow: 'Run now', s4bCancel: 'Cancel', s4bWith: 'Run with {agent}',
    s4bWaitUntil: 'Waiting to recover (until {time})', s4bRerun: 'Re-run as {id}',
    s4bConfirmCancel: 'Cancel the recovery of {id}?', s4bConfirmRun: 'Re-run {id} now?',
    s4bConfirmClear: 'Clear the rate-limit state of {agent}? (use it after you logged in again or topped up)',
    s4bStarted: 'Started a new job: {id}', s4bKind_transient: 'transient error', s4bKind_usage_limit: 'usage limit', s4bKind_fallback: 'fallback', s4bKind_approval: 'approval',
    s4bAttempt: 'attempt {n}', s4bIn: 'in {d}', s4bLevel_ok: 'within budget', s4bLevel_warn: 'near the cap', s4bLevel_block: 'block cap reached',
    s4bSharedNote: 'Two jobs running on the same project at once may be charged each other\'s calls.',
    s4bInvalid: 'Invalid value: {f}',
  });

  const SCOPES = ['job', 'team_run', 'day', 'project', 'agent_day'];
  const PERIODS = ['day', 'week', 'month', 'all'];
  const ROLES = ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'tester'];

  // ---- small helpers -------------------------------------------------------
  const money = v => {
    const n = Number(v) || 0;
    return '$' + (n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2));
  };
  const hhmm = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(M.lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  };
  const dur = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
  };
  const get = (action, params) => {
    const q = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('');
    return M.api(action + q);
  };
  const agentList = () => {
    try { return Object.entries(M.agents() || {}).map(([id, a]) => ({ ...a, id })).filter(a => a.enabled !== false); } catch { return []; }
  };
  const agentLabel = id => (agentList().find(a => a.id === id) || {}).label || id;
  const agentColor = id => (agentList().find(a => a.id === id) || {}).color || 'var(--faint)';
  const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
  const pct = (v, cap) => cap > 0 ? Math.min(100, Math.round(v / cap * 100)) : 0;
  const level = (v, warn, block) => block > 0 && v >= block ? 'block' : warn > 0 && v >= warn ? 'warn' : 'ok';
  const lvlColor = l => l === 'block' ? 'var(--err)' : l === 'warn' ? 'var(--warn)' : 'var(--ok)';

  // ---- state ---------------------------------------------------------------
  const S = {
    feature: null,           // status.feature_data.budget
    fb: null,                // status.feature_data.fallback
    spend: null, spendKey: '', spendAt: 0,
    budget: null, routing: null, rec: null,
    jobItems: {},            // job_id -> recovery items (from recovery_list?job_id=)
    panel: null, builtLang: '', loading: false,
  };

  // ---- header item: today's spend vs cap ----------------------------------
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'pill s4b-head hidden';
  head.innerHTML = '<span class="s4b-head-v"></span><span class="s4b-head-bar"><i></i></span>';
  head.addEventListener('click', () => {
    const tab = document.querySelector('#tabsCard [data-tab="budget"]');
    if (tab) { tab.click(); document.getElementById('tabsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  M.addHeaderItem(head);

  function paintHeader() {
    const f = S.feature;
    if (!f || f.enabled === false) { head.classList.add('hidden'); return; }
    head.classList.remove('hidden');
    const cap = num(f.today_cap_usd), warn = num(f.today_warn_usd), v = num(f.today_usd);
    const l = f.level || level(v, warn, cap);
    head.querySelector('.s4b-head-v').textContent = cap > 0 ? `${money(v)} / ${money(cap)}` : money(v);
    const bar = head.querySelector('.s4b-head-bar');
    bar.classList.toggle('hidden', !(cap > 0 || warn > 0));
    const i = bar.firstElementChild;
    i.style.width = pct(v, cap || warn) + '%';
    i.style.background = lvlColor(l);
    head.title = `${t('s4bToday')}: ${money(v)}${cap > 0 ? ' / ' + money(cap) : ''} · ${t('s4bLevel_' + l)}`;
    head.dataset.level = l;
  }

  // ---- job header actions --------------------------------------------------
  const waitingFor = j => (S.fb?.waiting || []).find(w => w.source_job_id === j.id) ||
    (S.jobItems[j.id] || []).find(w => w.status === 'waiting' && w.source_job_id === j.id);
  const rerunOf = j => (S.jobItems[j.id] || []).find(w => w.source_job_id === j.id && w.new_job_id);

  M.addJobAction({
    id: 's4-recovery-wait',
    when: j => j.status !== 'RUNNING' && !!waitingFor(j),
    label: j => '⏳ ' + t('s4bWaitUntil', { time: hhmm(waitingFor(j)?.next_at) }),
    run: j => { const w = waitingFor(j); if (w) runNow(w); },
  });
  M.addJobAction({
    id: 's4-recovery-cancel',
    when: j => j.status !== 'RUNNING' && !!waitingFor(j),
    label: () => '✕ ' + t('s4bCancel'),
    run: j => { const w = waitingFor(j); if (w) cancelItem(w); },
  });
  M.addJobAction({
    id: 's4-recovery-rerun',
    when: j => j.status !== 'RUNNING' && !waitingFor(j) && !!rerunOf(j),
    label: j => '↪ ' + t('s4bRerun', { id: rerunOf(j).new_job_id }),
    run: j => {
      const id = rerunOf(j).new_job_id;
      try { navigator.clipboard?.writeText(id); } catch { /* clipboard unavailable */ }
      M.toast(t('s4bStarted', { id }), 'info');
    },
  });

  async function loadJobItems(jobId) {
    if (!jobId) return;
    try {
      const r = await get('recovery_list', { job_id: jobId });
      S.jobItems[jobId] = r.items || [];
      const keys = Object.keys(S.jobItems);
      if (keys.length > 30) delete S.jobItems[keys[0]];
    } catch { /* feature not ready */ }
  }
  // The recovery engine decides within ~5 s of the job end; look twice.
  M.on('job-end', e => {
    if (!e?.id) return;
    setTimeout(() => loadJobItems(e.id).then(rerenderJobHead), 6000);
    setTimeout(() => loadJobItems(e.id).then(rerenderJobHead), 15000);
  });
  // MAW has no public "repaint job header" hook yet (requested from the Tech Lead); use the page's own when present.
  const rerenderJobHead = () => { if (typeof M.refreshJobHead === 'function') M.refreshJobHead(); else if (typeof window.renderJobHead === 'function') window.renderJobHead(); };

  async function runNow(item, agent) {
    if (!confirm(t('s4bConfirmRun', { id: item.source_job_id || item.id }))) return;
    try {
      const r = await M.api('recovery_apply', agent ? { id: item.id, agent } : { id: item.id });
      M.toast(t('s4bStarted', { id: r.job_id || '' }), 'ok');
      await refreshLive(true);
    } catch (e) { M.toast(e.message, 'err'); }
  }
  async function cancelItem(item) {
    if (!confirm(t('s4bConfirmCancel', { id: item.source_job_id || item.id }))) return;
    try {
      await M.api('recovery_cancel', { id: item.id });
      M.toast(t('s4bSaved'), 'ok');
      await refreshLive(true);
    } catch (e) { M.toast(e.message, 'err'); }
  }
  async function clearCooldown(agent) {
    if (!confirm(t('s4bConfirmClear', { agent: agentLabel(agent) }))) return;
    try { await M.api('fallback_cooldown_clear', { agent }); await refreshLive(true); }
    catch (e) { M.toast(e.message, 'err'); }
  }

  // ---- tab -----------------------------------------------------------------
  const tab = M.addTab({ id: 'budget', title: () => t('s4bTab'), render: panel => render(panel) });

  M.on('data', d => {
    S.feature = d?.feature_data?.budget || null;
    S.fb = d?.feature_data?.fallback || null;
    paintHeader();
    tab?.setCount((S.fb?.waiting || []).length || '');
  });
  M.on('project-change', () => { S.spendKey = ''; if (S.panel) { buildOverride(); refreshLive(true); } });

  function render(panel) {
    S.panel = panel;
    if (S.builtLang !== M.lang) build(panel);
    if (!panel.classList.contains('hidden')) refreshLive(false);
  }

  function build(panel) {
    S.builtLang = M.lang;
    panel.innerHTML = `
      <div class="s4-body">
        <div class="s4-grid s4b-kpis" data-r="kpis"></div>
        <div class="s4-grid s4-g2">
          <section class="s4-sec"><h3>${esc(t('s4bSpend14'))}</h3><div data-r="days" class="s4b-days"></div></section>
          <section class="s4-sec"><h3>${esc(t('s4bByAgent'))}</h3><div data-r="agents"></div>
            <h3 class="s4-mt">${esc(t('s4bRunning'))}</h3><div data-r="running"></div>
            <p class="sub s4-mt">${esc(t('s4bSharedNote'))}</p></section>
        </div>
        <section class="s4-sec"><div class="s4-sec-h"><h3>${esc(t('s4bQueue'))}</h3></div><div data-r="queue"></div>
          <h3 class="s4-mt">${esc(t('s4bCooldowns'))}</h3><div data-r="cool"></div></section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4bBudgets'))}</h3><span class="spacer"></span>
            <button type="button" class="btn btn-sm" data-act="reload">${esc(t('s4bReload'))}</button>
            <button type="button" class="btn btn-sm btn-primary" data-act="save-budget">${esc(t('s4bSave'))}</button></div>
          <div data-r="budget"></div>
          <h3 class="s4-mt">${esc(t('s4bOverride'))}</h3><div data-r="override"></div>
        </section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4bRouting'))}</h3><span class="spacer"></span>
            <button type="button" class="btn btn-sm btn-primary" data-act="save-routing">${esc(t('s4bSave'))}</button></div>
          <p class="sub">${esc(t('s4bRoutingHint'))}</p>
          <div data-r="routing"></div>
          <h3 class="s4-mt">${esc(t('s4bRecovery'))}</h3><div data-r="recovery"></div>
        </section>
      </div>`;
    if (!panel.dataset.s4bound) { panel.dataset.s4bound = '1'; panel.addEventListener('click', onClick); }
    loadConfigs();
  }
  const R = name => S.panel?.querySelector(`[data-r="${name}"]`);

  async function loadConfigs() {
    try {
      const [b, f] = await Promise.all([M.api('budget_get'), M.api('fallback_get')]);
      S.budget = structuredClone(b.config || {});
      S.routing = structuredClone(f.config || {});
      S.routingInfo = f;
      buildBudgetForm(); buildOverride(); buildRouting(); buildRecovery();
      for (const w of [...(b.warnings || []), ...(f.warnings || [])]) M.toast(String(w), 'warn');
    } catch (e) {
      const box = R('budget');
      if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ---- live parts (spend, queue) ------------------------------------------
  async function refreshLive(force) {
    if (S.loading) return;
    const p = M.project();
    const key = p?.path || '';
    if (!force && S.spend && S.spendKey === key && Date.now() - S.spendAt < 8000) return;
    S.loading = true;
    try {
      const [spend, rec] = await Promise.all([
        get('budget_spend', { project_path: key, days: 14 }).catch(e => ({ error: e.message })),
        M.api('recovery_list').catch(e => ({ error: e.message, items: [] })),
      ]);
      S.spend = spend; S.spendKey = key; S.spendAt = Date.now(); S.rec = rec;
      paintKpis(); paintDays(); paintAgents(); paintQueue();
    } finally { S.loading = false; }
  }

  function capBar(v, cap, warn) {
    const l = level(v, warn, cap);
    if (!(cap > 0) && !(warn > 0)) return '';
    const w = pct(v, cap || warn);
    const mark = cap > 0 && warn > 0 ? `<b style="left:${pct(warn, cap)}%"></b>` : '';
    return `<div class="s4-cap" title="${esc(t('s4bLevel_' + l))}"><i style="width:${w}%;background:${lvlColor(l)}"></i>${mark}</div>`;
  }

  function paintKpis() {
    const box = R('kpis'); if (!box) return;
    const s = S.spend;
    if (!s || s.error) { box.innerHTML = `<div class="empty">${esc(s?.error || '…')}</div>`; return; }
    const today = s.today || {}, cap = today.cap || {}, proj = s.project || null;
    const tok = today.tokens_cap || {};
    const tiles = [
      `<div class="s4-stat"><div class="k">${esc(t('s4bToday'))}</div>
        <div class="v">${money(today.usd)} <small>${num(cap.block) > 0 ? '/ ' + money(cap.block) : esc(t('s4bNoCap'))}</small></div>
        ${capBar(num(today.usd), num(cap.block), num(cap.warn))}
        <div class="s">${M.fmt(today.calls)} calls · ${M.fmt(today.tokens)} tok${num(tok.block) > 0 ? ' / ' + M.fmt(tok.block) : ''}</div></div>`,
    ];
    if (proj) {
      const pc = proj.cap || {};
      tiles.push(`<div class="s4-stat"><div class="k">${esc(t('s4bProject'))} · ${esc(t('s4bPeriod_' + (proj.period || 'month')))}</div>
        <div class="v">${money(proj.usd)} <small>${num(pc.block) > 0 ? '/ ' + money(pc.block) : esc(t('s4bNoCap'))}</small></div>
        ${capBar(num(proj.usd), num(pc.block), num(pc.warn))}
        <div class="s truncate" title="${esc(proj.path)}">${esc(proj.path)}</div></div>`);
    }
    box.innerHTML = tiles.join('');
  }

  function paintDays() {
    const box = R('days'); if (!box) return;
    const days = S.spend?.by_day || [];
    if (!days.length) { box.innerHTML = `<div class="empty">—</div>`; return; }
    const cap = num(S.spend?.today?.cap?.block), warn = num(S.spend?.today?.cap?.warn);
    const max = Math.max(cap, ...days.map(d => num(d.usd)), 0.0001);
    const line = cap > 0 ? `<div class="s4b-capline" style="bottom:${(cap / max) * 100}%"><span>${money(cap)}</span></div>` : '';
    box.innerHTML = `<div class="s4b-chart" role="img" aria-label="${esc(t('s4bSpend14'))}"><div class="s4b-plot">${line}${days.map(d => {
      const v = num(d.usd), l = level(v, warn, cap);
      const label = String(d.date || '').slice(5);
      return `<div class="s4b-col" title="${esc(d.date)} · ${money(v)} · ${M.fmt(d.calls)} calls · ${M.fmt(d.tokens)} tok">
        <i style="height:${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%;background:${l === 'ok' ? 'var(--accent)' : lvlColor(l)}"></i><span>${esc(label)}</span></div>`;
    }).join('')}</div></div>`;
  }

  function paintAgents() {
    const box = R('agents'), run = R('running'); if (!box || !run) return;
    const rows = S.spend?.by_agent_today || [];
    box.innerHTML = rows.length ? rows.map(a => {
      const cap = num(a.cap?.block ?? a.cap), max = Math.max(...rows.map(r => num(r.usd)), 0.0001);
      return `<div class="kv"><span class="dot" style="background:${esc(agentColor(a.agent))}"></span>
        <span class="s4-w8 truncate">${esc(agentLabel(a.agent))}</span>
        <span class="bar"><i style="width:${cap > 0 ? pct(num(a.usd), cap) : Math.round(num(a.usd) / max * 100)}%"></i></span>
        <span class="num">${money(a.usd)}${cap > 0 ? ' / ' + money(cap) : ''}</span><span class="faint">${M.fmt(a.calls)}×</span></div>`;
    }).join('') : `<div class="sub">—</div>`;
    const jobs = S.spend?.running_jobs || [];
    run.innerHTML = jobs.length ? jobs.map(j => `<div class="kv"><span class="truncate s4-mono" title="${esc(j.job_id)}">${esc(j.job_id)}</span>
      <span class="bar"><i style="width:${pct(num(j.usd), num(j.cap?.block ?? j.cap))}%"></i></span>
      <span class="num">${money(j.usd)}${num(j.cap?.block ?? j.cap) > 0 ? ' / ' + money(j.cap?.block ?? j.cap) : ''}</span></div>`).join('')
      : `<div class="sub">—</div>`;
  }

  function paintQueue() {
    const box = R('queue'), cool = R('cool'); if (!box || !cool) return;
    const items = (S.rec?.items || []).filter(i => i.status === 'waiting' || i.status === 'suggested');
    box.innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr>
        <th>Job</th><th>${esc(t('s4bRole'))}</th><th>Agent</th><th></th><th></th></tr></thead><tbody>${items.map(i => {
          const when = i.next_at ? `${esc(hhmm(i.next_at))} · ${esc(t('s4bIn', { d: dur(new Date(i.next_at) - Date.now()) }))}` : '';
          const fb = i.fallback_agent ? ` → ${esc(agentLabel(i.fallback_agent))}` : '';
          return `<tr><td class="s4-mono truncate" title="${esc(i.reason || '')}">${esc(i.source_job_id)}</td>
            <td>${esc(i.role || '')}</td><td>${esc(agentLabel(i.agent))}${fb}</td>
            <td>${M.badge(t('s4bKind_' + i.kind) || i.kind, i.status === 'waiting' ? 'b-warn' : 'b-info')} <span class="sub">${esc(t('s4bAttempt', { n: i.attempt || 1 }))}</span> <span class="sub">${when}</span>
              <div class="sub clamp-2">${esc(i.reason || '')}</div></td>
            <td class="s4-nowrap"><button type="button" class="btn btn-sm" data-act="run" data-id="${esc(i.id)}">${esc(i.fallback_agent ? t('s4bWith', { agent: agentLabel(i.fallback_agent) }) : t('s4bRunNow'))}</button>
              <button type="button" class="btn btn-sm btn-link danger" data-act="cancel" data-id="${esc(i.id)}">${esc(t('s4bCancel'))}</button></td></tr>`;
        }).join('')}</tbody></table></div>`
      : `<div class="sub">${esc(S.rec?.error || t('s4bQueueEmpty'))}</div>`;
    const cds = Object.entries(S.rec?.cooldowns || {}).filter(([, c]) => c && new Date(c.until) > Date.now());
    cool.innerHTML = cds.length ? cds.map(([a, c]) => `<div class="kv"><span class="dot warn"></span>
        <span class="s4-w8">${esc(agentLabel(a))}</span><span class="sub truncate" title="${esc(c.reason || '')}">→ ${esc(hhmm(c.until))} · ${esc(c.reason || '')}</span>
        <span class="spacer"></span><button type="button" class="btn btn-sm" data-act="clear" data-agent="${esc(a)}">${esc(t('s4bClear'))}</button></div>`).join('')
      : `<div class="sub">—</div>`;
  }

  // ---- budget form -----------------------------------------------------------
  const capInput = (scope, unit, kind, val, step) =>
    `<input class="input s4-num" type="number" min="0" step="${step}" inputmode="decimal" data-cap="${scope}.${unit}.${kind}" value="${esc(num(val) || 0)}" aria-label="${esc(t('s4bScope_' + scope))} ${unit} ${kind}">`;

  function buildBudgetForm() {
    const box = R('budget'); if (!box || !S.budget) return;
    const c = S.budget, caps = c.caps || {};
    box.innerHTML = `
      <div class="row-wrap s4-gap">
        <label class="check"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? 'checked' : ''}> ${esc(t('s4bEnabled'))}</label>
        <label class="check"><input type="checkbox" data-f="estimate_next_call" ${c.estimate_next_call !== false ? 'checked' : ''}> ${esc(t('s4bEstimate'))}</label>
      </div>
      <div class="table-wrap s4-mt"><table class="s4-form-table"><thead><tr>
        <th>${esc(t('s4bScope'))}</th><th>${esc(t('s4bUsd'))} · ${esc(t('s4bWarn'))}</th><th>${esc(t('s4bUsd'))} · ${esc(t('s4bBlock'))}</th>
        <th>${esc(t('s4bTokens'))} · ${esc(t('s4bWarn'))}</th><th>${esc(t('s4bTokens'))} · ${esc(t('s4bBlock'))}</th><th>${esc(t('s4bPeriod'))}</th></tr></thead>
        <tbody>${SCOPES.map(s => {
          const sc = caps[s] || {};
          return `<tr><td>${esc(t('s4bScope_' + s))}</td>
            <td>${capInput(s, 'usd', 'warn', sc.usd?.warn, '0.01')}</td><td>${capInput(s, 'usd', 'block', sc.usd?.block, '0.01')}</td>
            <td>${capInput(s, 'tokens', 'warn', sc.tokens?.warn, '1000')}</td><td>${capInput(s, 'tokens', 'block', sc.tokens?.block, '1000')}</td>
            <td>${s === 'project' ? periodSelect('period', sc.period) : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
      <p class="sub">${esc(t('s4bZeroHint'))}</p>`;
  }
  const periodSelect = (key, val) => `<select data-period="${esc(key)}" class="s4-sel">${PERIODS.map(p =>
    `<option value="${p}" ${p === (val || 'month') ? 'selected' : ''}>${esc(t('s4bPeriod_' + p))}</option>`).join('')}</select>`;

  const projKey = p => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

  function buildOverride() {
    const box = R('override'); if (!box || !S.budget) return;
    const p = M.project();
    if (!p) { box.innerHTML = `<div class="sub">${esc(t('s4bOverrideNone'))}</div>`; return; }
    const ov = (S.budget.projects || {})[projKey(p.path)]?.project;
    box.innerHTML = `<label class="check"><input type="checkbox" data-ov="on" ${ov ? 'checked' : ''}> ${esc(t('s4bUseOverride', { name: p.name || p.path }))}</label>
      <div class="row-wrap s4-gap s4-mt ${ov ? '' : 'hidden'}" data-ov="fields">
        <label class="s4-lbl">${esc(t('s4bUsd'))} · ${esc(t('s4bWarn'))} ${capInput('ov', 'usd', 'warn', ov?.usd?.warn, '0.01')}</label>
        <label class="s4-lbl">${esc(t('s4bUsd'))} · ${esc(t('s4bBlock'))} ${capInput('ov', 'usd', 'block', ov?.usd?.block, '0.01')}</label>
        <label class="s4-lbl">${esc(t('s4bPeriod'))} ${periodSelect('ov', ov?.period)}</label>
      </div>`;
    box.querySelector('[data-ov="on"]').addEventListener('change', e => box.querySelector('[data-ov="fields"]').classList.toggle('hidden', !e.target.checked));
  }

  function collectBudget() {
    const root = S.panel, c = structuredClone(S.budget || {});
    c.version = c.version || 1;
    c.enabled = root.querySelector('[data-f="enabled"]').checked;
    c.estimate_next_call = root.querySelector('[data-f="estimate_next_call"]').checked;
    c.caps = c.caps || {};
    const bad = [];
    for (const s of SCOPES) {
      const sc = c.caps[s] = c.caps[s] || {};
      for (const unit of ['usd', 'tokens']) {
        const w = num(root.querySelector(`[data-cap="${s}.${unit}.warn"]`).value, -1);
        const b = num(root.querySelector(`[data-cap="${s}.${unit}.block"]`).value, -1);
        if (w < 0 || b < 0) bad.push(`${s}.${unit}`);
        if (w > 0 && b > 0 && w > b) bad.push(`${s}.${unit}.warn > block`);
        sc[unit] = { warn: unit === 'tokens' ? Math.round(w) : w, block: unit === 'tokens' ? Math.round(b) : b };
      }
      if (s === 'project') sc.period = root.querySelector('[data-period="period"]').value;
    }
    const p = M.project();
    if (p && root.querySelector('[data-ov="on"]')) {
      c.projects = c.projects || {};
      const k = projKey(p.path);
      if (root.querySelector('[data-ov="on"]').checked) {
        const w = num(root.querySelector('[data-cap="ov.usd.warn"]').value, -1), b = num(root.querySelector('[data-cap="ov.usd.block"]').value, -1);
        if (w < 0 || b < 0 || (w > 0 && b > 0 && w > b)) bad.push('project override');
        c.projects[k] = { ...(c.projects[k] || {}), project: { usd: { warn: w, block: b }, period: root.querySelector('[data-period="ov"]').value } };
      } else if (c.projects[k]) {
        delete c.projects[k].project;
        if (!Object.keys(c.projects[k]).length) delete c.projects[k];
      }
    }
    return { c, bad };
  }

  // ---- routing + recovery forms -------------------------------------------
  function buildRouting() {
    const box = R('routing'); if (!box || !S.routing) return;
    const roles = S.routingInfo?.roles?.length ? S.routingInfo.roles : ROLES;
    const agents = S.routingInfo?.agents?.length ? S.routingInfo.agents : agentList();
    S.routing.roles = S.routing.roles || {};
    box.innerHTML = `<div class="table-wrap"><table class="s4-form-table"><thead><tr><th>${esc(t('s4bRole'))}</th><th>${esc(t('s4bFallbacks'))}</th><th>${esc(t('s4bAuto'))}</th></tr></thead><tbody>
      ${roles.map(role => {
        const r = S.routing.roles[role] || { fallbacks: [], auto_fallback: false };
        const list = (r.fallbacks || []).map((a, i, arr) => `<span class="s4-chip" style="--chip:${esc(agentColor(a))}"><span class="dot" style="background:var(--chip)"></span>${esc(agentLabel(a))}
            <button type="button" class="s4-x" data-act="fb-up" data-role="${esc(role)}" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="up">↑</button>
            <button type="button" class="s4-x" data-act="fb-down" data-role="${esc(role)}" data-i="${i}" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="down">↓</button>
            <button type="button" class="s4-x" data-act="fb-del" data-role="${esc(role)}" data-i="${i}" aria-label="remove">✕</button></span>`).join('');
        const free = agents.filter(a => !(r.fallbacks || []).includes(a.id));
        return `<tr><td>${esc(role)}</td><td><div class="row-wrap s4-gap-s">${list || `<span class="sub">${esc(t('s4bNone'))}</span>`}
          ${free.length ? `<select class="s4-sel" data-act="fb-add" data-role="${esc(role)}" aria-label="${esc(t('s4bAdd'))}"><option value="">${esc(t('s4bAdd'))}</option>${free.map(a =>
            `<option value="${esc(a.id)}">${esc(a.label || a.id)}${a.installed === false ? ' ⚠' : ''}</option>`).join('')}</select>` : ''}</div></td>
          <td><label class="check"><input type="checkbox" data-auto="${esc(role)}" ${r.auto_fallback ? 'checked' : ''}> ${esc(t('s4bAuto'))}</label></td></tr>`;
      }).join('')}</tbody></table></div>`;
    box.querySelectorAll('select[data-act="fb-add"]').forEach(sel => sel.addEventListener('change', () => {
      if (!sel.value) return;
      const role = sel.dataset.role;
      const r = S.routing.roles[role] = S.routing.roles[role] || { fallbacks: [], auto_fallback: false };
      r.fallbacks = [...(r.fallbacks || []), sel.value];
      buildRouting();
    }));
    box.querySelectorAll('input[data-auto]').forEach(cb => cb.addEventListener('change', () => {
      const role = cb.dataset.auto;
      (S.routing.roles[role] = S.routing.roles[role] || { fallbacks: [] }).auto_fallback = cb.checked;
    }));
  }

  function buildRecovery() {
    const box = R('recovery'); if (!box || !S.routing) return;
    const r = S.routing.recovery || {};
    box.innerHTML = `
      <label class="check"><input type="checkbox" data-rec="enabled" ${r.enabled !== false ? 'checked' : ''}> ${esc(t('s4bRecEnabled'))}</label>
      <div class="s4-fields s4-mt">
        <label class="s4-lbl">${esc(t('s4bBackoff'))}<input class="input" data-rec="backoff_s" value="${esc((r.backoff_s || [30, 60, 120, 300, 900, 1800]).join(', '))}" inputmode="numeric"></label>
        <label class="s4-lbl">${esc(t('s4bMaxAttempts'))}<input class="input s4-num" type="number" min="0" max="20" data-rec="max_attempts" value="${esc(r.max_attempts ?? 6)}"></label>
        <label class="s4-lbl">${esc(t('s4bGrace'))}<input class="input s4-num" type="number" min="0" data-rec="reset_grace_s" value="${esc(r.reset_grace_s ?? 60)}"></label>
        <label class="s4-lbl">${esc(t('s4bMaxWait'))}<input class="input s4-num" type="number" min="0" data-rec="max_wait_s" value="${esc(r.max_wait_s ?? 21600)}"></label>
      </div>
      <div class="row-wrap s4-gap s4-mt">
        <label class="check"><input type="checkbox" data-rec="wait_for_reset" ${r.wait_for_reset !== false ? 'checked' : ''}> ${esc(t('s4bWaitReset'))}</label>
        <label class="check"><input type="checkbox" data-rec="prefer_fallback_on_limit" ${r.prefer_fallback_on_limit ? 'checked' : ''}> ${esc(t('s4bPreferFb'))}</label>
      </div>`;
  }

  function collectRouting() {
    const root = S.panel, c = structuredClone(S.routing || {}), bad = [];
    c.version = c.version || 1;
    const q = k => root.querySelector(`[data-rec="${k}"]`);
    const steps = q('backoff_s').value.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!steps.length || steps.some(n => !Number.isInteger(n) || n < 5 || n > 86400)) bad.push(t('s4bBackoff'));
    const maxA = num(q('max_attempts').value, -1);
    if (!Number.isInteger(maxA) || maxA < 0 || maxA > 20) bad.push(t('s4bMaxAttempts'));
    c.recovery = {
      ...(c.recovery || {}),
      enabled: q('enabled').checked,
      backoff_s: steps,
      max_attempts: maxA,
      wait_for_reset: q('wait_for_reset').checked,
      reset_grace_s: Math.max(0, Math.round(num(q('reset_grace_s').value))),
      max_wait_s: Math.max(0, Math.round(num(q('max_wait_s').value))),
      prefer_fallback_on_limit: q('prefer_fallback_on_limit').checked,
    };
    return { c, bad };
  }

  // ---- clicks --------------------------------------------------------------
  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    if (act === 'reload') { loadConfigs(); refreshLive(true); return; }
    if (act === 'run' || act === 'cancel') {
      const item = (S.rec?.items || []).find(i => i.id === b.dataset.id);
      if (!item) return;
      if (act === 'run') runNow(item, item.fallback_agent || undefined); else cancelItem(item);
      return;
    }
    if (act === 'clear') { clearCooldown(b.dataset.agent); return; }
    if (act.startsWith('fb-')) {
      const r = S.routing.roles[b.dataset.role]; const i = Number(b.dataset.i);
      if (!r) return;
      const l = r.fallbacks;
      if (act === 'fb-del') l.splice(i, 1);
      if (act === 'fb-up' && i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]];
      if (act === 'fb-down' && i < l.length - 1) [l[i + 1], l[i]] = [l[i], l[i + 1]];
      buildRouting();
      return;
    }
    if (act === 'save-budget' || act === 'save-routing') {
      const { c, bad } = act === 'save-budget' ? collectBudget() : collectRouting();
      if (bad.length) { M.toast(t('s4bInvalid', { f: bad.join(', ') }), 'err'); return; }
      b.disabled = true;
      try {
        const r = await M.api(act === 'save-budget' ? 'budget_save' : 'fallback_save', { config: c });
        if (act === 'save-budget') { S.budget = r.config || c; buildBudgetForm(); buildOverride(); }
        else { S.routing = r.config || c; buildRouting(); buildRecovery(); }
        M.toast(t('s4bSaved'), 'ok');
        refreshLive(true);
      } catch (err) { M.toast(err.message, 'err'); }
      finally { b.disabled = false; }
    }
  }

  // Keep the countdowns fresh while the tab is open.
  setInterval(() => { if (S.panel && !S.panel.classList.contains('hidden') && !document.hidden) paintQueue(); }, 15000);
})();
