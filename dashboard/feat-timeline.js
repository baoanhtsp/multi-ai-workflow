// S3 — Team-run timeline (N8): a Gantt of jobs / handoffs per agent lane, plus Markdown / HTML report export.
(() => {
  const M = window.MAW;
  if (!M) return;
  const { api, t, esc, toast } = M;
  const S3 = () => window.MAW_S3 || {};

  M.addI18n('vi', {
    s3gTab: 'Dòng thời gian',
    s3gWin: { '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ', '7d': '7 ngày' },
    s3gThisProj: 'Dự án này', s3gAllProj: 'Mọi dự án',
    s3gReload: 'Tải lại', s3gMd: 'Xuất Markdown', s3gHtml: 'Xuất HTML',
    s3gEmpty: 'Không có job nào trong khoảng thời gian này.',
    s3gJobs: '{n} job', s3gDone: '{n} xong', s3gFailed: '{n} lỗi', s3gCost: 'Chi phí {c}', s3gBusy: 'Thời gian chạy {d}',
    s3gRole: 'Vai trò', s3gDur: 'Thời lượng', s3gCostL: 'Chi phí', s3gScore: 'Điểm', s3gRunning: 'đang chạy',
    s3gExported: 'Đã tải {file}',
    s3gClick: 'Bấm để xem nhật ký'
  });
  M.addI18n('en', {
    s3gTab: 'Timeline',
    s3gWin: { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' },
    s3gThisProj: 'This project', s3gAllProj: 'All projects',
    s3gReload: 'Reload', s3gMd: 'Export Markdown', s3gHtml: 'Export HTML',
    s3gEmpty: 'No jobs in this time window.',
    s3gJobs: '{n} jobs', s3gDone: '{n} done', s3gFailed: '{n} failed', s3gCost: 'Cost {c}', s3gBusy: 'Busy {d}',
    s3gRole: 'Role', s3gDur: 'Duration', s3gCostL: 'Cost', s3gScore: 'Score', s3gRunning: 'running',
    s3gExported: 'Downloaded {file}',
    s3gClick: 'Click to open the log'
  });

  const WIN_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
  };
  let win = WIN_MS[store.get('maw_s3_tl_win')] ? store.get('maw_s3_tl_win') : '24h';
  let scope = store.get('maw_s3_tl_scope') === 'all' ? 'all' : 'project';
  let data = null, loading = false, lastFetch = 0, panel = null, tip = null;

  const usd = n => (S3().usd ? S3().usd(n) : '$' + Number(n || 0).toFixed(4));
  const dur = ms => (S3().dur ? S3().dur(ms) : Math.round(ms / 1000) + 's');
  const chip = id => (S3().agentChip ? S3().agentChip(id) : esc(id));

  function query(extra = '') {
    const to = new Date(), from = new Date(to.getTime() - WIN_MS[win]);
    const p = M.project();
    return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}` +
      (scope === 'project' && p ? '&project=' + encodeURIComponent(p.path) : '') + extra;
  }

  async function load(force) {
    if (loading || (!force && Date.now() - lastFetch < 10000)) return;
    loading = true; paint();
    try { data = await api('timeline&' + query()); lastFetch = Date.now(); }
    catch (e) { if (force) toast(e.message, 'err'); data = data || { lanes: [], totals: {} }; }
    finally { loading = false; paint(); }
  }

  async function exportReport(format) {
    try {
      const r = await api(`timeline_report&format=${format}&` + query());
      const blob = new Blob([r.content || ''], { type: (r.mime || (format === 'html' ? 'text/html' : 'text/markdown')) + ';charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || `maw-report.${format === 'html' ? 'html' : 'md'}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(t('s3gExported', { file: a.download }), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // "Nice" tick step for the time axis.
  function tickStep(spanMs, maxTicks) {
    const steps = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 2 * 24 * 3600e3];
    return steps.find(s => spanMs / s <= maxTicks) || steps[steps.length - 1];
  }
  const tickLabel = (ms, step) => {
    const d = new Date(ms), loc = M.lang === 'vi' ? 'vi-VN' : 'en-US';
    return step >= 24 * 3600e3 ? d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  };

  function gantt() {
    const lanes = (data?.lanes || []).filter(l => (l.items || []).length);
    if (!lanes.length) return `<div class="empty">${esc(loading ? '…' : t('s3gEmpty'))}</div>`;
    const from = new Date(data.from).getTime(), to = new Date(data.to).getTime();
    const span = Math.max(60e3, to - from);
    const pct = ms => ((ms - from) / span) * 100;
    const step = tickStep(span, 8);
    const ticks = [];
    for (let x = Math.ceil(from / step) * step; x <= to; x += step) ticks.push(x);
    const now = Date.now();
    const axis = `<div class="s3-g-axis">${ticks.map(x => `<span style="left:${pct(x)}%">${esc(tickLabel(x, step))}</span>`).join('')}</div>`;
    const grid = ticks.map(x => `<i style="left:${pct(x)}%"></i>`).join('');
    let n = 0;
    const rows = lanes.map(l => {
      const bars = l.items.map(it => {
        const s = Math.max(from, new Date(it.start).getTime());
        const e = Math.min(to, it.end ? new Date(it.end).getTime() : now);
        const left = Math.max(0, pct(s)), width = Math.max(0.4, pct(Math.max(e, s)) - left);
        const st = String(it.status || '').toUpperCase();
        const idx = n++;
        return `<button type="button" class="s3-g-bar s3-g-${esc(st.toLowerCase())}${it.kind === 'handoff' ? ' is-handoff' : ''}" style="left:${left}%;width:${width}%;--c:${esc(l.color || 'var(--accent)')}" data-i="${idx}" aria-label="${esc(it.title + ' · ' + st)}"></button>`;
      }).join('');
      return `<div class="s3-g-row"><div class="s3-g-lane">${chip(l.agent)}</div><div class="s3-g-track">${grid}${bars}</div></div>`;
    }).join('');
    const nowLine = now >= from && now <= to + 60e3 ? `<div class="s3-g-now" style="left:calc(var(--lane) + (100% - var(--lane)) * ${Math.min(100, pct(now)) / 100})"></div>` : '';
    return `<div class="s3-g-scroll"><div class="s3-gantt"><div class="s3-g-row s3-g-head"><div class="s3-g-lane"></div><div class="s3-g-track">${axis}</div></div>${rows}${nowLine}</div></div>`;
  }
  const flatItems = () => (data?.lanes || []).filter(l => (l.items || []).length).flatMap(l => l.items.map(it => ({ ...it, agent: l.agent })));

  function totals() {
    const x = data?.totals;
    if (!x) return '';
    return `<div class="s3-g-tot">
      <span class="badge">${esc(t('s3gJobs', { n: x.jobs || 0 }))}</span>
      <span class="badge b-ok">${esc(t('s3gDone', { n: x.done || 0 }))}</span>
      ${x.failed ? `<span class="badge b-err">${esc(t('s3gFailed', { n: x.failed }))}</span>` : ''}
      <span class="badge b-info">${esc(t('s3gCost', { c: usd(x.cost_usd) }))}</span>
      <span class="badge">${esc(t('s3gBusy', { d: dur(x.busy_ms || 0) }))}</span></div>`;
  }

  function showTip(bar, it) {
    tip ||= Object.assign(document.createElement('div'), { className: 's3-g-tip' });
    tip.setAttribute('role', 'tooltip');
    const s = new Date(it.start).getTime(), e = it.end ? new Date(it.end).getTime() : Date.now();
    tip.innerHTML = `<b class="s3-wrap">${esc(it.title || it.id)}</b>
      <div class="row-wrap" style="gap:6px">${chip(it.agent)} ${S3().statusBadge ? S3().statusBadge(it.status) : esc(it.status)}</div>
      <dl class="s3-dl">
        ${it.role ? `<dt>${esc(t('s3gRole'))}</dt><dd>${esc(it.role)}${it.mode ? ' · ' + esc(it.mode) : ''}</dd>` : ''}
        <dt>${esc(t('s3gDur'))}</dt><dd>${esc(dur(e - s))}${it.end ? '' : ' · ' + esc(t('s3gRunning'))}</dd>
        <dt>${esc(t('s3gCostL'))}</dt><dd>${esc(usd(it.cost_usd))}${it.tokens ? ` <span class="t-muted">(${esc(M.fmt(it.tokens.in))} / ${esc(M.fmt(it.tokens.out))} tok)</span>` : ''}</dd>
        ${it.score != null && it.score !== '' ? `<dt>${esc(t('s3gScore'))}</dt><dd>${esc(it.score)}${it.verdict ? ' · ' + esc(it.verdict) : ''}</dd>` : ''}
        ${it.project_name ? `<dt>📁</dt><dd class="truncate">${esc(it.project_name)}</dd>` : ''}
      </dl>${it.kind === 'job' && String(it.id).startsWith('job_') ? `<div class="sub t-muted">${esc(t('s3gClick'))}</div>` : ''}`;
    document.body.appendChild(tip);
    const r = bar.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 16);
    tip.style.width = w + 'px';
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const top = r.bottom + 8 + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  const hideTip = () => tip?.remove();

  function paint() {
    if (!panel) return;
    if (!panel.dataset.s3) {
      panel.dataset.s3 = '1';
      panel.innerHTML = `<div class="s3"><section class="s3-sec">
        <div class="s3-sec-h"><div class="row-wrap" style="gap:8px"><div class="seg" role="group" data-win></div><div class="seg" role="group" data-scope></div></div>
          <div class="s3-tools"><button type="button" class="btn btn-sm" data-reload></button><button type="button" class="btn btn-sm" data-md></button><button type="button" class="btn btn-sm" data-html></button></div></div>
        <div data-tot></div><div data-g></div></section></div>`;
      panel.addEventListener('click', e => {
        const w = e.target.closest('[data-w]'), s = e.target.closest('[data-s]'), b = e.target.closest('.s3-g-bar');
        if (w) { win = w.dataset.w; store.set('maw_s3_tl_win', win); load(true); }
        else if (s) { scope = s.dataset.s; store.set('maw_s3_tl_scope', scope); load(true); }
        else if (e.target.closest('[data-reload]')) load(true);
        else if (e.target.closest('[data-md]')) exportReport('md');
        else if (e.target.closest('[data-html]')) exportReport('html');
        else if (b) { const it = flatItems()[+b.dataset.i]; if (it && String(it.id).startsWith('job_')) { hideTip(); S3().openLog?.(it.job_id || it.id); } }
      });
      const over = e => { const b = e.target.closest?.('.s3-g-bar'); if (b) { const it = flatItems()[+b.dataset.i]; if (it) showTip(b, it); } };
      panel.addEventListener('mouseover', over);
      panel.addEventListener('focusin', over);
      panel.addEventListener('mouseout', e => { if (e.target.closest?.('.s3-g-bar')) hideTip(); });
      panel.addEventListener('focusout', hideTip);
    }
    panel.querySelector('[data-win]').innerHTML = Object.keys(WIN_MS).map(k => `<button type="button" data-w="${k}" aria-pressed="${win === k}">${esc((t('s3gWin') || {})[k] || k)}</button>`).join('');
    panel.querySelector('[data-scope]').innerHTML = [['project', 's3gThisProj'], ['all', 's3gAllProj']].map(([k, l]) => `<button type="button" data-s="${k}" aria-pressed="${scope === k}">${esc(t(l))}</button>`).join('');
    panel.querySelector('[data-reload]').textContent = t('s3gReload');
    panel.querySelector('[data-md]').textContent = t('s3gMd');
    panel.querySelector('[data-html]').textContent = t('s3gHtml');
    panel.querySelector('[data-reload]').disabled = loading;
    panel.querySelector('[data-tot]').innerHTML = totals();
    panel.querySelector('[data-g]').innerHTML = gantt();
  }

  M.addTab({
    id: 'timeline',
    title: () => t('s3gTab'),
    render(p) {
      const first = !panel;
      panel = p;
      if (first) paint();
      const visible = !p.classList.contains('hidden');
      // Refresh while visible: every 10 s when something is running, else every 60 s.
      const running = flatItems().some(i => !i.end);
      if (visible && (!data || Date.now() - lastFetch > (running ? 10000 : 60000))) load(!data);
      else if (first) paint();
    }
  });
  document.querySelector('#tabsCard [data-tab="timeline"]')?.addEventListener('click', () => load(!data));
  M.on('project-change', () => { if (scope === 'project' && panel && !panel.classList.contains('hidden')) load(true); else data = null; });
  M.on('job-end', () => { lastFetch = 0; });
  M.on('lang', paint);
})();
