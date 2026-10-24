// S4 — Agent scoreboard + suggested team (N3). Talks to the page only through window.MAW.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { esc, t } = M;

  M.addI18n('vi', {
    s4sTab: 'Bảng xếp hạng', s4sTitle: 'Hiệu quả agent theo vai trò', s4sDays: '{n} ngày', s4sAllRoles: 'Mọi vai trò', s4sThisProject: 'Chỉ dự án đang chọn',
    s4sAgent: 'Agent', s4sRole: 'Vai trò', s4sTasks: 'Việc', s4sApproval: 'Tỉ lệ duyệt', s4sScore: 'Điểm TB', s4sRounds: 'Vòng sửa TB',
    s4sCostApproved: '$ / việc được duyệt', s4sCost: 'Tổng $', s4sMedian: 'Thời gian (trung vị)', s4sFail: 'Tỉ lệ lỗi', s4sLast: 'Gần nhất',
    s4sGiven: 'cho (reviewer)', s4sEmpty: 'Chưa có dữ liệu — chạy vài job / review để có bảng xếp hạng.',
    s4sTeam: 'Đội đề xuất', s4sTeamHint: 'Agent tốt nhất cho từng vai trò theo dữ liệu {n} ngày (hoà thì chọn agent rẻ hơn).',
    s4sConf: 'độ tin cậy {n}%', s4sTotals: '{jobs} job · {approved} được duyệt · {cost}', s4sRefresh: 'Làm mới', s4sCopy: 'Sao chép -Team',
    s4sCopied: 'Đã sao chép: {v}', s4sCandidates: 'Ứng viên',
  });
  M.addI18n('en', {
    s4sTab: 'Scoreboard', s4sTitle: 'Agent performance by role', s4sDays: '{n} days', s4sAllRoles: 'All roles', s4sThisProject: 'Selected project only',
    s4sAgent: 'Agent', s4sRole: 'Role', s4sTasks: 'Tasks', s4sApproval: 'Approval', s4sScore: 'Avg score', s4sRounds: 'Avg fix rounds',
    s4sCostApproved: '$ / approved', s4sCost: 'Total $', s4sMedian: 'Median time', s4sFail: 'Failure', s4sLast: 'Last',
    s4sGiven: 'given (reviewer)', s4sEmpty: 'No data yet — run a few jobs / reviews to build the scoreboard.',
    s4sTeam: 'Suggested team', s4sTeamHint: 'Best agent per role over {n} days (ties go to the cheaper agent).',
    s4sConf: 'confidence {n}%', s4sTotals: '{jobs} jobs · {approved} approved · {cost}', s4sRefresh: 'Refresh', s4sCopy: 'Copy -Team',
    s4sCopied: 'Copied: {v}', s4sCandidates: 'Candidates',
  });

  const ROLES = ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'tester'];
  const COLS = [
    { k: 'agent', label: 's4sAgent', type: 's' },
    { k: 'role', label: 's4sRole', type: 's' },
    { k: 'tasks', label: 's4sTasks', type: 'n' },
    { k: 'approval_rate', label: 's4sApproval', type: 'n' },
    { k: 'avg_score', label: 's4sScore', type: 'n' },
    { k: 'avg_fix_rounds', label: 's4sRounds', type: 'n', low: true },
    { k: 'cost_per_approved_usd', label: 's4sCostApproved', type: 'n', low: true },
    { k: 'cost_usd', label: 's4sCost', type: 'n', low: true },
    { k: 'median_duration_s', label: 's4sMedian', type: 'n', low: true },
    { k: 'failure_rate', label: 's4sFail', type: 'n', low: true },
    { k: 'last_at', label: 's4sLast', type: 's' },
  ];

  const money = v => v == null ? '—' : '$' + (Number(v) !== 0 && Math.abs(v) < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2));
  const pctTxt = v => v == null ? '—' : Math.round(v * 100) + '%';
  const secs = v => {
    if (v == null) return '—';
    const s = Math.round(v);
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') : Math.floor(s / 3600) + 'h' + String(Math.floor(s % 3600 / 60)).padStart(2, '0');
  };
  const ago = iso => {
    const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(M.lang === 'vi' ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit' });
  };
  const get = (action, params) => M.api(action + Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join(''));
  const agents = () => { try { return M.agents() || {}; } catch { return {}; } };
  const aLabel = id => agents()[id]?.label || id;
  const aColor = id => agents()[id]?.color || 'var(--faint)';

  const S = { panel: null, builtLang: '', days: 30, role: '', onlyProject: false, sort: { k: 'approval_rate', dir: -1 }, board: null, team: null, at: 0, key: '' };

  M.addTab({ id: 'scoreboard', title: () => t('s4sTab'), render: panel => render(panel) });
  M.on('project-change', () => { if (S.onlyProject) { S.key = ''; if (S.panel && !S.panel.classList.contains('hidden')) load(); } });

  function render(panel) {
    S.panel = panel;
    if (S.builtLang !== M.lang) build(panel);
    if (!panel.classList.contains('hidden')) load();
  }

  function build(panel) {
    S.builtLang = M.lang;
    panel.innerHTML = `
      <div class="s4-body">
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4sTeam'))}</h3><span class="sub" data-r="teamhint"></span><span class="spacer"></span>
            <button type="button" class="btn btn-sm" data-act="copy">${esc(t('s4sCopy'))}</button></div>
          <div data-r="team" class="s4s-team"></div>
        </section>
        <section class="s4-sec">
          <div class="s4-sec-h"><h3>${esc(t('s4sTitle'))}</h3><span class="sub" data-r="totals"></span><span class="spacer"></span>
            <select class="s4-sel" data-f="role" aria-label="${esc(t('s4sRole'))}"><option value="">${esc(t('s4sAllRoles'))}</option>${ROLES.map(r => `<option value="${r}" ${S.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
            <select class="s4-sel" data-f="days" aria-label="days">${[7, 30, 90, 365].map(n => `<option value="${n}" ${S.days === n ? 'selected' : ''}>${esc(t('s4sDays', { n }))}</option>`).join('')}</select>
            <label class="check"><input type="checkbox" data-f="proj" ${S.onlyProject ? 'checked' : ''}> ${esc(t('s4sThisProject'))}</label>
            <button type="button" class="btn btn-sm" data-act="refresh">${esc(t('s4sRefresh'))}</button></div>
          <div data-r="table"></div>
        </section>
      </div>`;
    if (!panel.dataset.s4bound) {
      panel.dataset.s4bound = '1';
      panel.addEventListener('click', onClick);
      panel.addEventListener('change', e => {
        const f = e.target.dataset?.f; if (!f) return;
        if (f === 'role') S.role = e.target.value;
        if (f === 'days') S.days = Number(e.target.value) || 30;
        if (f === 'proj') S.onlyProject = e.target.checked;
        S.key = ''; load();
      });
    }
    S.key = '';
  }
  const R = n => S.panel?.querySelector(`[data-r="${n}"]`);

  async function load() {
    const p = S.onlyProject ? (M.project()?.path || '') : '';
    const key = [S.days, S.role, p].join('|');
    if (key === S.key && Date.now() - S.at < 30000) return;
    S.key = key; S.at = Date.now();
    const q = { days: S.days, role: S.role, project_path: p };
    const [b, tm] = await Promise.all([
      get('scoreboard', q).catch(e => ({ error: e.message })),
      get('suggest_team', { days: S.days, project_path: p }).catch(e => ({ error: e.message })),
    ]);
    if (key !== S.key) return;
    S.board = b; S.team = tm;
    paintTable(); paintTeam();
  }

  function paintTeam() {
    const box = R('team'); if (!box) return;
    const tm = S.team;
    R('teamhint').textContent = t('s4sTeamHint', { n: S.days });
    if (!tm || tm.error) { box.innerHTML = `<div class="sub">${esc(tm?.error || '—')}</div>`; return; }
    const det = tm.details || {};
    box.innerHTML = Object.entries(tm.team || {}).map(([role, agent]) => {
      const d = det[role] || {};
      const cands = (d.candidates || []).slice(0, 4).map(c => `${esc(aLabel(c.agent))} ${c.score != null ? Number(c.score).toFixed(2) : ''}`).join(' · ');
      return `<div class="s4s-member" style="--chip:${esc(aColor(agent))}">
        <div class="sub">${esc(role)}</div>
        <div class="row" style="gap:6px"><span class="dot" style="background:var(--chip)"></span><b>${esc(aLabel(agent))}</b>
          ${d.score != null ? `<span class="badge">${Number(d.score).toFixed(2)}</span>` : ''}</div>
        <div class="sub clamp-2" title="${esc(d.reason || '')}">${esc(d.reason || '')}</div>
        ${d.confidence != null ? `<div class="faint s4s-conf">${esc(t('s4sConf', { n: Math.round(d.confidence * 100) }))}</div>` : ''}
        ${cands ? `<div class="faint s4s-conf" title="${esc(t('s4sCandidates'))}">${cands}</div>` : ''}
      </div>`;
    }).join('') || `<div class="sub">—</div>`;
  }

  const cell = (r, c) => {
    const v = r[c.k];
    switch (c.k) {
      case 'agent': return `<span class="row" style="gap:6px"><span class="dot" style="background:${esc(r.color || aColor(r.agent))}"></span>${esc(r.label || aLabel(r.agent))}</span>`;
      case 'role': return esc(v) + (v === 'reviewer' ? ` <span class="faint">${esc(t('s4sGiven'))}</span>` : '');
      case 'approval_rate': return v == null ? '—' : `<span class="s4s-rate"><span class="bar"><i style="width:${Math.round(v * 100)}%;background:${v >= .8 ? 'var(--ok)' : v >= .5 ? 'var(--warn)' : 'var(--err)'}"></i></span>${pctTxt(v)}</span>`;
      case 'avg_score': return v == null ? '—' : Number(v).toFixed(1);
      case 'avg_fix_rounds': return v == null ? '—' : Number(v).toFixed(1);
      case 'cost_per_approved_usd': case 'cost_usd': return money(v);
      case 'median_duration_s': return secs(v);
      case 'failure_rate': return v == null ? '—' : `<span class="${v >= .3 ? 't-err' : ''}">${pctTxt(v)}</span>`;
      case 'last_at': return esc(ago(v));
      default: return esc(M.fmt(v));
    }
  };

  function paintTable() {
    const box = R('table'); if (!box) return;
    const b = S.board;
    if (!b || b.error) { box.innerHTML = `<div class="empty">${esc(b?.error || '…')}</div>`; return; }
    const tot = b.totals || {};
    R('totals').textContent = t('s4sTotals', { jobs: M.fmt(tot.jobs), approved: M.fmt(tot.approved), cost: money(tot.cost_usd || 0) });
    const rows = [...(b.rows || [])];
    if (!rows.length) { box.innerHTML = `<div class="empty">${esc(t('s4sEmpty'))}</div>`; return; }
    const { k, dir } = S.sort;
    const col = COLS.find(c => c.k === k) || COLS[3];
    rows.sort((a, c) => {
      const x = a[k], y = c[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;           // empty values always last
      if (y == null) return -1;
      return (col.type === 'n' ? (x - y) : String(x).localeCompare(String(y))) * dir;
    });
    box.innerHTML = `<div class="table-wrap"><table class="s4s-table"><thead><tr>${COLS.map(c => {
      const on = c.k === k;
      return `<th aria-sort="${on ? (dir > 0 ? 'ascending' : 'descending') : 'none'}" class="${c.type === 'n' ? 'num' : ''}"><button type="button" class="s4s-sort" data-sort="${c.k}">${esc(t(c.label))}${on ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    }).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${COLS.map(c => `<td class="${c.type === 'n' ? 'num' : ''}">${cell(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function onClick(e) {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort, col = COLS.find(c => c.k === k);
      S.sort = S.sort.k === k ? { k, dir: -S.sort.dir } : { k, dir: col?.type === 's' ? 1 : (col?.low ? 1 : -1) };
      paintTable();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'refresh') { S.key = ''; load(); }
    if (b.dataset.act === 'copy') {
      const v = Object.entries(S.team?.team || {}).map(([r, a]) => `${r}=${a}`).join(',');
      if (!v) return;
      Promise.resolve(navigator.clipboard?.writeText(v)).then(() => M.toast(t('s4sCopied', { v }), 'ok'), () => M.toast(v, 'info'));
    }
  }
})();
