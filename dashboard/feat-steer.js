// S5 / #10 — Steer a running job or continue a finished one with the same agent (specs/s5-design.md §3).
// Replaces interactive terminals (SPEC §9.2): live send-message for Antigravity, a queued next turn for the
// other platforms, resume with the agent's own session where it still exists, else a summary-seeded job.
(() => {
  'use strict';
  const MAW = window.MAW;
  if (!MAW) return;
  const { api, t, toast, esc } = MAW;
  MAW.ext = MAW.ext || {};

  MAW.addI18n('vi', {
    'st.steer': 'Điều hướng', 'st.continue': 'Tiếp tục',
    'st.titleRun': 'Điều hướng job đang chạy', 'st.titleDone': 'Tiếp tục job với cùng agent',
    'st.session': 'Phiên', 'st.noSession': 'không tìm thấy phiên của agent', 'st.gone': 'phiên không còn',
    'st.strategy': 'Cách gửi', 'st.auto': 'Tự động', 'st.live': 'Gửi ngay vào phiên', 'st.queue': 'Xếp hàng lượt sau',
    'st.resume': 'Resume phiên', 'st.summary': 'Job mới + tóm tắt',
    'st.why.live': 'Chỉ khi job Antigravity đang chạy và biết conversation id.', 'st.why.queue': 'Chỉ khi job đang chạy.',
    'st.why.resume': 'Cần job đã xong và phiên của agent còn lưu.', 'st.why.summary': 'Chỉ khi job đã xong.',
    'st.message': 'Tin nhắn', 'st.ph': 'Hướng dẫn tiếp theo cho agent… (Ctrl+Enter để gửi)',
    'st.model': 'Model', 'st.effort': 'Effort', 'st.default': 'mặc định', 'st.send': 'Gửi', 'st.close': 'Đóng',
    'st.history': 'Lịch sử điều hướng', 'st.noHistory': 'Chưa có tin nhắn nào.', 'st.cancelQueued': 'Huỷ',
    'st.sent': 'Đã gửi ({strategy}).', 'st.started': 'Đã chạy job {id}.', 'st.queued': 'Đã xếp hàng — sẽ gửi khi job xong.',
    'st.child': 'Job tiếp nối', 'st.watch': 'Theo dõi trong ô log', 'st.chain': 'Chuỗi job',
  });
  MAW.addI18n('en', {
    'st.steer': 'Steer', 'st.continue': 'Continue',
    'st.titleRun': 'Steer the running job', 'st.titleDone': 'Continue the job with the same agent',
    'st.session': 'Session', 'st.noSession': 'no agent session found', 'st.gone': 'session no longer exists',
    'st.strategy': 'Delivery', 'st.auto': 'Auto', 'st.live': 'Send into the session now', 'st.queue': 'Queue as next turn',
    'st.resume': 'Resume session', 'st.summary': 'New job + summary',
    'st.why.live': 'Only for a running Antigravity job with a known conversation id.', 'st.why.queue': 'Only while the job is running.',
    'st.why.resume': 'Needs a finished job whose agent session is still stored.', 'st.why.summary': 'Only once the job has finished.',
    'st.message': 'Message', 'st.ph': 'Next instruction for the agent… (Ctrl+Enter sends)',
    'st.model': 'Model', 'st.effort': 'Effort', 'st.default': 'default', 'st.send': 'Send', 'st.close': 'Close',
    'st.history': 'Steer history', 'st.noHistory': 'No messages yet.', 'st.cancelQueued': 'Cancel',
    'st.sent': 'Sent ({strategy}).', 'st.started': 'Job {id} started.', 'st.queued': 'Queued — it is sent when the job finishes.',
    'st.child': 'Follow-up job', 'st.watch': 'Follow in the log box', 'st.chain': 'Job chain',
  });

  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  const STRATS = ['auto', 'live', 'queue', 'resume', 'summary'];
  const ST_CLS = { sent: 'b-ok', started: 'b-ok', queued: 'b-warn', failed: 'b-err', cancelled: '' };

  let D = null; // open dialog state

  function open(jobId) {
    if (!/^job_\d{8}_\d{6}_[0-9a-f]{6}$/.test(String(jobId || ''))) return;
    close();
    const back = document.createElement('div');
    back.className = 'st-back';
    back.innerHTML = `<div class="st-dlg card" role="dialog" aria-modal="true" aria-labelledby="stTitle">
      <div class="card-h"><h2 id="stTitle">…</h2><span class="meta mono st-jid"></span>
        <button type="button" class="btn btn-sm" data-a="close" aria-label="${esc(t('st.close'))}">✕</button></div>
      <div class="card-b st-grid">
        <div class="st-left stack">
          <div class="st-info sub"></div>
          <div><div class="section-title">${esc(t('st.strategy'))}</div><div class="st-strats"></div></div>
          <label class="st-msg"><span class="lbl">${esc(t('st.message'))}</span>
            <textarea class="input" rows="5" maxlength="20000" placeholder="${esc(t('st.ph'))}"></textarea></label>
          <div class="st-opts"></div>
          <div class="row st-end"><span class="sub st-count"></span><button type="button" class="btn btn-primary" data-a="send">${esc(t('st.send'))}</button></div>
        </div>
        <div class="st-right stack">
          <div><div class="section-title">${esc(t('st.history'))}</div><div class="st-hist"></div></div>
          <div class="st-childbox hidden"><div class="row"><div class="section-title st-childtitle"></div>
            <span style="flex:1"></span>${typeof MAW.watchJob === 'function' ? `<button type="button" class="btn btn-sm" data-a="watch">${esc(t('st.watch'))}</button>` : ''}</div>
            <pre class="st-tail mono"></pre></div>
        </div>
      </div></div>`;
    document.body.appendChild(back);
    D = { back, jobId, info: null, strategy: 'auto', child: null, timer: null, sending: false, prevFocus: document.activeElement };
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    back.addEventListener('keydown', onKey);
    back.addEventListener('click', onClick);
    const ta = back.querySelector('textarea');
    ta.addEventListener('input', () => { back.querySelector('.st-count').textContent = ta.value.length ? `${ta.value.length}/20000` : ''; });
    ta.focus();
    refresh();
    D.timer = setInterval(() => { if (!document.hidden) refresh(true); }, 3000);
  }

  function close() {
    if (!D) return;
    clearInterval(D.timer);
    D.back.remove();
    try { D.prevFocus?.focus?.(); } catch { /* gone */ }
    D = null;
  }

  async function refresh(quiet) {
    const d = D;
    try {
      const info = await api('steer_info' + qs({ job_id: d.jobId }));
      if (D !== d) return;
      d.info = info;
      paint();
      const children = (info.history || []).map(e => e.child_job_id).filter(Boolean);
      const newest = children[children.length - 1];
      if (newest) tail(d, newest);
    } catch (e) {
      if (D !== d) return;
      if (!quiet) d.back.querySelector('.st-info').innerHTML = `<span class="t-err">${esc(e.message)}</span>`;
    }
  }

  function paint() {
    const { info, back } = D;
    const j = info.job || {};
    const running = j.status === 'RUNNING';
    back.querySelector('#stTitle').textContent = running ? t('st.titleRun') : t('st.titleDone');
    back.querySelector('.st-jid').textContent = j.job_id || D.jobId;
    const sr = info.session_ref;
    const agent = MAW.agents()?.[j.agent];
    back.querySelector('.st-info').innerHTML = `
      <div class="row st-wrap"><span class="dot" style="background:${esc(agent?.color || 'var(--faint)')}"></span><b>${esc(agent?.label || j.agent || j.mode || '—')}</b>
        <span>· ${esc(j.role || '')}</span>${MAW.badge(j.status || '?', running ? 'b-warn' : j.status === 'DONE' ? 'b-ok' : j.status === 'FAILED' ? 'b-err' : '')}</div>
      <div class="truncate" title="${esc(j.project_path || '')}">${esc(j.project_path || '')}</div>
      <div>${esc(t('st.session'))}: ${sr ? `<span class="mono">${esc(sr.platform)} ${esc(String(sr.id).slice(0, 13))}…</span>${sr.exists === false ? ` <span class="t-warn">(${esc(t('st.gone'))})</span>` : ''}` : `<span class="faint">${esc(t('st.noSession'))}</span>`}</div>
      ${(info.chain || []).length > 1 ? `<div>${esc(t('st.chain'))}: ${info.chain.map(id => `<button type="button" class="btn-link mono" data-job="${esc(id)}">${esc(id.slice(-6))}</button>`).join(' → ')}</div>` : ''}`;
    const can = info.strategies || {};
    if (D.strategy !== 'auto' && !can[D.strategy]) D.strategy = 'auto';
    back.querySelector('.st-strats').innerHTML = `<div class="seg st-seg" role="radiogroup">${STRATS.map(s => {
      const ok = s === 'auto' || !!can[s];
      const rec = s !== 'auto' && info.recommended === s ? ' ★' : '';
      return `<button type="button" role="radio" data-strat="${s}" aria-checked="${D.strategy === s}" aria-pressed="${D.strategy === s}" ${ok ? '' : 'disabled'}
        title="${esc(ok ? (s === 'resume' && info.resume_reason ? info.resume_reason : '') : t('st.why.' + s))}">${esc(t('st.' + s))}${rec}</button>`;
    }).join('')}</div>`;
    const continuing = !running;
    const opts = back.querySelector('.st-opts');
    if (continuing && agent && ((agent.models || []).length || (agent.efforts || []).length)) {
      if (!opts.dataset.agent || opts.dataset.agent !== j.agent) {
        opts.dataset.agent = j.agent;
        const sel = (k, list, cur) => `<label><span class="lbl">${esc(t('st.' + k))}</span><select data-o="${k}"><option value="">${esc(t('st.default'))}${cur ? ' (' + esc(cur) + ')' : ''}</option>${list.map(v => `<option>${esc(v)}</option>`).join('')}</select></label>`;
        opts.innerHTML = `<div class="st-optgrid">${(agent.models || []).length ? sel('model', agent.models, j.model) : ''}${(agent.efforts || []).length ? sel('effort', agent.efforts, j.effort) : ''}</div>`;
      }
    } else { opts.innerHTML = ''; delete opts.dataset.agent; }
    const hist = info.history || [];
    back.querySelector('.st-hist').innerHTML = hist.length ? hist.slice().reverse().map(e => `
      <div class="st-entry">
        <div class="row st-wrap">${MAW.badge(e.status, ST_CLS[e.status] || '')}<span class="badge">${esc(e.strategy)}</span>
          <span class="sub">${esc(new Date(e.ts).toLocaleTimeString(MAW.lang === 'en' ? 'en-GB' : 'vi-VN'))}</span>
          ${e.job_id && e.job_id !== D.jobId ? `<span class="sub mono">@${esc(e.job_id.slice(-6))}</span>` : ''}
          <span style="flex:1"></span>
          ${e.child_job_id ? `<button type="button" class="btn-link mono" data-job="${esc(e.child_job_id)}">→ ${esc(e.child_job_id.slice(-6))}</button>` : ''}
          ${e.status === 'queued' ? `<button type="button" class="btn-link danger" data-cancel="${esc(e.id)}" data-cjob="${esc(e.job_id || D.jobId)}">${esc(t('st.cancelQueued'))}</button>` : ''}</div>
        <div class="st-text">${esc(e.message)}</div>${e.error ? `<div class="sub t-err">${esc(e.error)}</div>` : ''}
      </div>`).join('') : `<div class="sub faint">${esc(t('st.noHistory'))}</div>`;
  }

  async function tail(d, jobId) {
    if (d.child?.id !== jobId) d.child = { id: jobId, offset: 0, text: '', status: '' };
    const c = d.child;
    if (c.busy || (c.status && c.status !== 'RUNNING' && c.done)) return;
    c.busy = true;
    try {
      const r = await api('job_status' + qs({ job_id: jobId, offset: c.offset }));
      if (D !== d || d.child !== c) return;
      c.offset = r.next_offset ?? c.offset;
      c.text = (c.text + (r.log_chunk || '')).slice(-40000);
      c.done = c.status === String(r.status) && r.status !== 'RUNNING';
      c.status = String(r.status || '');
      const box = d.back.querySelector('.st-childbox');
      box.classList.remove('hidden');
      box.querySelector('.st-childtitle').innerHTML = `${esc(t('st.child'))} <span class="mono">${esc(jobId)}</span> ${MAW.badge(c.status, c.status === 'RUNNING' ? 'b-warn' : c.status === 'DONE' ? 'b-ok' : 'b-err')}`;
      const pre = box.querySelector('.st-tail');
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = c.text;
      if (stick) pre.scrollTop = pre.scrollHeight;
    } catch { /* the job may have been cleaned up */ }
    finally { c.busy = false; }
  }

  async function send() {
    const d = D;
    const ta = d.back.querySelector('textarea');
    const message = ta.value.trim();
    if (!message || d.sending) return;
    d.sending = true;
    const btn = d.back.querySelector('[data-a="send"]');
    btn.disabled = true;
    try {
      const r = await api('steer_send', {
        job_id: d.jobId, message, strategy: d.strategy,
        model: d.back.querySelector('[data-o="model"]')?.value || undefined,
        effort: d.back.querySelector('[data-o="effort"]')?.value || undefined,
      });
      ta.value = '';
      d.back.querySelector('.st-count').textContent = '';
      const st = r.entry?.status;
      toast(r.child_job_id ? t('st.started', { id: r.child_job_id }) : st === 'queued' ? t('st.queued') : t('st.sent', { strategy: r.entry?.strategy || '' }), 'ok');
      if (r.child_job_id) d.child = null;
      await refresh();
    } catch (e) { toast(e.message, 'err'); }
    finally { d.sending = false; btn.disabled = false; }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea')) { e.preventDefault(); send(); }
  }

  async function onClick(e) {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const strat = e.target.closest('[data-strat]');
    const cancel = e.target.closest('[data-cancel]');
    const job = e.target.closest('[data-job]');
    if (strat && !strat.disabled) { D.strategy = strat.dataset.strat; paint(); }
    else if (cancel) {
      try { await api('steer_cancel', { job_id: cancel.dataset.cjob, entry_id: cancel.dataset.cancel }); await refresh(); }
      catch (err) { toast(err.message, 'err'); }
    } else if (job) {
      const id = job.dataset.job;
      if (id !== D.jobId) open(id);
    }
    else if (a === 'close') close();
    else if (a === 'send') send();
    else if (a === 'watch' && D.child && typeof MAW.watchJob === 'function') { MAW.watchJob(D.child.id); close(); }
  }

  MAW.addJobAction({
    id: 'steer',
    label: j => (j?.status === 'RUNNING' ? t('st.steer') : t('st.continue')),
    when: j => !!j?.id,
    run: j => open(j.id),
  });

  MAW.ext.steer = { open, close };
})();
