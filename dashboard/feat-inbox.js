// S3 — Attention inbox (N5) + two-way Telegram settings. Talks to the page only through window.MAW;
// shared helpers (log viewer, login flow) come from feat-health.js via window.MAW_S3 when it is loaded.
(() => {
  const M = window.MAW;
  if (!M) return;
  const { api, t, esc, toast } = M;
  const S3 = () => window.MAW_S3 || {};

  M.addI18n('vi', {
    s3iTab: 'Hộp thư',
    s3iBell: 'Cần bạn xử lý: {n}',
    s3iDrawer: 'Cần bạn xử lý',
    s3iEmpty: 'Không có gì cần xử lý. 🎉',
    s3iAll: 'Tất cả', s3iOpen: 'Đang mở',
    s3iKindAll: 'Mọi loại',
    s3iClear: 'Xoá mục đã bỏ qua', s3iClearAsk: 'Xoá vĩnh viễn mọi mục đã bỏ qua / đã xong?',
    s3iCleared: 'Đã xoá {n} mục.',
    s3iMore: 'Mở hộp thư',
    s3iReload: 'Tải lại',
    s3iActOpen: 'Mở', s3iActRetry: 'Thử lại', s3iActLogin: 'Đăng nhập lại', s3iActApprove: 'Duyệt', s3iActReject: 'Từ chối', s3iActReply: 'Trả lời', s3iActDismiss: 'Bỏ qua',
    s3iReplyPh: 'Câu trả lời / chỉ dẫn tiếp theo cho agent…', s3iSend: 'Gửi', s3iCancel: 'Huỷ',
    s3iRetried: 'Đã chạy lại: {job}', s3iReplied: 'Đã gửi trả lời.', s3iDone: 'Đã cập nhật.',
    s3iNew: 'Cần xử lý: {title}',
    s3iKinds: { needs_login: 'Cần đăng nhập', needs_input: 'Chờ nhập liệu', failed: 'Thất bại', blocked: 'Bị chặn', rate_limited: 'Giới hạn tốc độ', review_changes: 'Review yêu cầu sửa', budget_block: 'Vượt ngân sách', approval: 'Chờ duyệt', handoff_done: 'Handoff xong', custom: 'Khác' },
    s3iStatus: { open: 'đang mở', dismissed: 'đã bỏ qua', done: 'đã xong', approved: 'đã duyệt', rejected: 'đã từ chối' },
    s3iBy: 'qua {by}',
    s3iNoItem: 'Không tìm thấy mục hộp thư cho job này.',
    s3tTitle: 'Telegram 2 chiều',
    s3tHint: 'Điều khiển từ điện thoại: bot chỉ nghe chat_id đã cấu hình, mọi người khác bị bỏ qua. Token không bao giờ hiển thị hay ghi log.',
    s3tNotCfg: 'Chưa cấu hình bot. Nhập token và chat_id ở tab Thông báo trước.',
    s3tGoNotify: 'Mở tab Thông báo',
    s3tInbound: 'Nhận lệnh (long-poll)', s3tPush: 'Đẩy mục hộp thư kèm nút bấm', s3tDigest: 'Bản tin sáng / tối',
    s3tMorning: 'Sáng', s3tEvening: 'Tối',
    s3tSave: 'Lưu', s3tTest: 'Gửi thử', s3tSaved: 'Đã lưu cấu hình Telegram.', s3tSent: 'Đã gửi tin thử.',
    s3tPolling: 'Đang nghe', s3tStopped: 'Đã tắt', s3tOther: 'Server khác đang nghe bot này',
    s3tLast: 'Tin cuối: {time}', s3tIgnored: 'Bỏ qua {n} tin từ chat lạ', s3tErr: 'Lỗi: {err}',
    s3tCmds: 'Lệnh'
  });
  M.addI18n('en', {
    s3iTab: 'Inbox',
    s3iBell: 'Waiting for you: {n}',
    s3iDrawer: 'Waiting for you',
    s3iEmpty: 'Nothing needs you right now. 🎉',
    s3iAll: 'All', s3iOpen: 'Open',
    s3iKindAll: 'All kinds',
    s3iClear: 'Clear dismissed', s3iClearAsk: 'Permanently remove every dismissed / done item?',
    s3iCleared: 'Removed {n} items.',
    s3iMore: 'Open the inbox',
    s3iReload: 'Reload',
    s3iActOpen: 'Open', s3iActRetry: 'Retry', s3iActLogin: 'Log in again', s3iActApprove: 'Approve', s3iActReject: 'Reject', s3iActReply: 'Reply', s3iActDismiss: 'Dismiss',
    s3iReplyPh: 'Your answer / next instruction for the agent…', s3iSend: 'Send', s3iCancel: 'Cancel',
    s3iRetried: 'Re-run started: {job}', s3iReplied: 'Reply sent.', s3iDone: 'Updated.',
    s3iNew: 'Needs you: {title}',
    s3iKinds: { needs_login: 'Login needed', needs_input: 'Waiting for input', failed: 'Failed', blocked: 'Blocked', rate_limited: 'Rate-limited', review_changes: 'Review: changes requested', budget_block: 'Over budget', approval: 'Approval', handoff_done: 'Handoff done', custom: 'Other' },
    s3iStatus: { open: 'open', dismissed: 'dismissed', done: 'done', approved: 'approved', rejected: 'rejected' },
    s3iBy: 'via {by}',
    s3iNoItem: 'No inbox item found for this job.',
    s3tTitle: 'Two-way Telegram',
    s3tHint: 'Control it from your phone: the bot only listens to the configured chat_id and ignores everyone else. The token is never shown or logged.',
    s3tNotCfg: 'The bot is not configured. Enter the token and chat_id in the Notifications tab first.',
    s3tGoNotify: 'Open Notifications',
    s3tInbound: 'Receive commands (long-poll)', s3tPush: 'Push inbox items with buttons', s3tDigest: 'Morning / evening digest',
    s3tMorning: 'Morning', s3tEvening: 'Evening',
    s3tSave: 'Save', s3tTest: 'Send test', s3tSaved: 'Telegram settings saved.', s3tSent: 'Test message sent.',
    s3tPolling: 'Listening', s3tStopped: 'Off', s3tOther: 'Another server is listening to this bot',
    s3tLast: 'Last update: {time}', s3tIgnored: 'Ignored {n} messages from other chats', s3tErr: 'Error: {err}',
    s3tCmds: 'Commands'
  });

  const KIND_ICON = { needs_login: '🔑', needs_input: '⌨', failed: '✕', blocked: '⛔', rate_limited: '⏳', review_changes: '✎', budget_block: '$', approval: '✓', handoff_done: '⇄', custom: '•' };
  const kindLabel = k => (t('s3iKinds') || {})[k] || k;
  const statusLabel = s => (t('s3iStatus') || {})[s] || s;
  const ago = iso => S3().ago ? S3().ago(iso) : iso;
  const chip = id => S3().agentChip ? S3().agentChip(id) : esc(id || '');

  // ---------- data ----------
  let items = [], counts = { open: 0 }, loading = false, filter = { status: 'open', kind: '' }, lastFetch = 0;
  const seenKey = 'maw_s3_seen';
  let seen;
  try { seen = new Set(JSON.parse(sessionStorage.getItem(seenKey) || '[]')); } catch { seen = new Set(); }
  let firstData = true;

  async function fetchItems(force) {
    if (loading || (!force && Date.now() - lastFetch < 4000)) return;
    loading = true;
    try {
      const q = `inbox_list&status=${encodeURIComponent(filter.status)}&limit=100${filter.kind ? '&kind=' + encodeURIComponent(filter.kind) : ''}`;
      const r = await api(q);
      items = r.items || [];
      counts = r.counts || counts;
      lastFetch = Date.now();
    } catch (e) { if (force) toast(e.message, 'err'); }
    finally { loading = false; paintAll(); }
  }

  async function act(item, action, text) {
    try {
      const r = await api('inbox_act', { id: item.id, action, ...(text ? { text } : {}) });
      if (r.job_id) toast(t('s3iRetried', { job: r.job_id }), 'ok');
      else toast(action === 'reply' ? t('s3iReplied') : t('s3iDone'), 'ok');
      await fetchItems(true);
      return r;
    } catch (e) { toast(e.message, 'err'); return null; }
  }

  function runAction(item, action, host) {
    if (action === 'open') {
      if (item.job_id && S3().openLog) S3().openLog(item.job_id);
      else if (S3().overlay) { const o = S3().overlay(item.title); o.body.innerHTML = `<pre class="code s3-wrap">${esc(item.detail || '—')}</pre>`; }
      return;
    }
    if (action === 'login') {
      if (S3().startLogin) S3().startLogin(item.agent, { onRetry: item.actions?.includes('retry') ? () => act(item, 'retry') : null });
      return;
    }
    if (action === 'reply') { openReply(item, host); return; }
    act(item, action);
  }

  function openReply(item, host) {
    const row = host?.closest('[data-item]');
    if (!row || row.querySelector('.s3-reply')) return;
    const box = document.createElement('div');
    box.className = 's3-reply';
    box.innerHTML = `<textarea class="input" rows="3" maxlength="4000" placeholder="${esc(t('s3iReplyPh'))}"></textarea>
      <div class="row-wrap" style="gap:6px"><button type="button" class="btn btn-sm btn-primary" data-send>${esc(t('s3iSend'))}</button><button type="button" class="btn btn-sm" data-cancel>${esc(t('s3iCancel'))}</button></div>`;
    row.appendChild(box);
    const ta = box.querySelector('textarea');
    ta.focus();
    box.addEventListener('click', async e => {
      if (e.target.closest('[data-cancel]')) box.remove();
      if (e.target.closest('[data-send]')) {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        e.target.disabled = true;
        if (await act(item, 'reply', text)) box.remove(); else e.target.disabled = false;
      }
    });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) box.querySelector('[data-send]').click(); });
  }

  const ACT_KEYS = { open: 's3iActOpen', retry: 's3iActRetry', login: 's3iActLogin', approve: 's3iActApprove', reject: 's3iActReject', reply: 's3iActReply', dismiss: 's3iActDismiss' };
  function itemHtml(it, compact) {
    const open = it.status === 'open';
    const acts = open ? (it.actions || ['open', 'dismiss']) : (it.job_id ? ['open'] : []);
    const primary = { needs_login: 'login', failed: 'retry', blocked: 'retry', rate_limited: 'retry', needs_input: 'reply', approval: 'approve', budget_block: 'approve', review_changes: 'open' }[it.kind];
    const btns = acts.filter(a => ACT_KEYS[a]).map(a => `<button type="button" class="btn btn-sm ${a === primary ? 'btn-primary' : ''} ${a === 'reject' ? 'btn-danger' : ''}" data-a="${esc(a)}">${esc(t(ACT_KEYS[a]))}</button>`).join('');
    const res = it.resolution ? ` · ${esc(statusLabel(it.status))}${it.resolution.by ? ' ' + esc(t('s3iBy', { by: it.resolution.by })) : ''}` : (!open ? ` · ${esc(statusLabel(it.status))}` : '');
    return `<div class="s3-item s3-sev-${esc(it.severity || 'info')}${open ? '' : ' is-closed'}" data-item="${esc(it.id)}">
      <div class="s3-item-ic" aria-hidden="true">${esc(KIND_ICON[it.kind] || '•')}</div>
      <div class="s3-item-main">
        <div class="s3-item-t"><b class="s3-wrap">${esc(it.title)}</b></div>
        <div class="s3-item-m">
          <span class="badge">${esc(kindLabel(it.kind))}</span>
          ${it.agent ? chip(it.agent) : ''}
          ${it.role ? `<span class="t-muted">${esc(it.role)}</span>` : ''}
          <span class="t-muted" title="${esc(it.created_at)}">${esc(ago(it.updated_at || it.created_at))}${res}</span>
          <span class="mono t-faint">${esc(it.id)}</span>
        </div>
        ${it.detail && !compact ? `<p class="sub t-muted s3-item-d">${esc(it.detail)}</p>` : it.detail ? `<p class="sub t-muted s3-item-d s3-clip">${esc(it.detail)}</p>` : ''}
        ${btns ? `<div class="s3-item-a">${btns}</div>` : ''}
      </div>
    </div>`;
  }
  function onListClick(e) {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('[data-item]')?.dataset.item;
    const it = items.find(x => x.id === id);
    if (it) runAction(it, b.dataset.a, b);
  }

  // ---------- header bell + drawer ----------
  const bell = document.createElement('button');
  bell.type = 'button';
  bell.className = 'pill s3-bell';
  bell.setAttribute('aria-haspopup', 'dialog');
  bell.innerHTML = '<span aria-hidden="true">🔔</span><span class="s3-bell-n">0</span>';
  M.addHeaderItem(bell);
  let drawer = null;
  function closeDrawer() { drawer?.remove(); drawer = null; bell.setAttribute('aria-expanded', 'false'); }
  function openDrawer() {
    if (drawer) { closeDrawer(); return; }
    drawer = document.createElement('div');
    drawer.className = 's3-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', t('s3iDrawer'));
    document.body.appendChild(drawer);
    bell.setAttribute('aria-expanded', 'true');
    drawer.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) { closeDrawer(); bell.focus(); return; }
      if (e.target.closest('[data-more]')) { closeDrawer(); const b = document.querySelector('#tabsCard [data-tab="inbox"]'); b?.click(); b?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      onListClick(e);
    });
    paintDrawer();
    if (filter.status !== 'open') { filter.status = 'open'; }
    fetchItems(true);
    drawer.querySelector('[data-close]')?.focus();
  }
  bell.onclick = openDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer && !document.querySelector('.s3-ov')) { closeDrawer(); bell.focus(); } });
  document.addEventListener('click', e => { if (drawer && !drawer.contains(e.target) && !bell.contains(e.target) && !e.target.closest('.s3-ov, .s3-login')) closeDrawer(); });

  function paintDrawer() {
    if (!drawer) return;
    const open = items.filter(i => i.status === 'open');
    drawer.innerHTML = `<div class="s3-drawer-h"><h2>${esc(t('s3iDrawer'))} <span class="badge">${esc(counts.open ?? open.length)}</span></h2>
      <button type="button" class="btn btn-sm" data-more>${esc(t('s3iMore'))}</button><button type="button" class="btn btn-sm" data-close aria-label="${esc(t('s3Close') || 'Close')}">✕</button></div>
      <div class="s3-drawer-b">${open.length ? open.slice(0, 30).map(i => itemHtml(i, true)).join('') : `<div class="empty">${esc(t('s3iEmpty'))}</div>`}</div>`;
  }

  function paintBell() {
    const fd = M.state.data?.feature_data?.inbox;
    const n = fd?.open ?? counts.open ?? 0;
    const sev = fd?.by_severity || {};
    bell.querySelector('.s3-bell-n').textContent = n > 99 ? '99+' : String(n);
    bell.classList.toggle('err', !!sev.error);
    bell.classList.toggle('warn', !sev.error && n > 0);
    bell.classList.toggle('is-zero', !n);
    bell.title = t('s3iBell', { n });
    bell.setAttribute('aria-label', t('s3iBell', { n }));
  }

  // One toast per new attention item; the first status load only marks what is already there as seen.
  function toastNew() {
    const latest = M.state.data?.feature_data?.inbox?.latest || [];
    let changed = false;
    for (const it of latest) {
      if (seen.has(it.id)) continue;
      seen.add(it.id); changed = true;
      if (!firstData) toast(t('s3iNew', { title: it.title }), it.severity === 'error' ? 'err' : it.severity === 'warn' ? 'warn' : 'info');
    }
    firstData = false;
    if (changed) { try { sessionStorage.setItem(seenKey, JSON.stringify([...seen].slice(-300))); } catch { /* private mode */ } }
  }

  // ---------- tab ----------
  let panel = null, tg = null, tgBusy = false;
  let tab = null;
  function renderTab() {
    if (!panel) return;
    if (!panel.dataset.s3) {
      panel.dataset.s3 = '1';
      panel.innerHTML = `<div class="s3">
        <section class="s3-sec"><div class="s3-sec-h"><div class="row-wrap" style="gap:8px">
            <div class="seg" role="group" data-status></div>
            <select class="input s3-sel" data-kind aria-label="kind"></select></div>
          <div class="s3-tools"><button type="button" class="btn btn-sm" data-reload></button><button type="button" class="btn btn-sm btn-danger" data-clear></button></div></div>
          <div class="s3-list" data-list></div></section></div>`;
      panel.addEventListener('click', async e => {
        const s = e.target.closest('[data-st]');
        if (s) { filter.status = s.dataset.st; fetchItems(true); return; }
        if (e.target.closest('[data-reload]')) { fetchItems(true); return; }
        if (e.target.closest('[data-clear]')) {
          if (!confirm(t('s3iClearAsk'))) return;
          try {
            const r = await api('inbox_clear', { status: 'dismissed' });
            const r2 = await api('inbox_clear', { status: 'done' });
            toast(t('s3iCleared', { n: (r.removed || 0) + (r2.removed || 0) }), 'ok');
          } catch (err) { toast(err.message, 'err'); }
          fetchItems(true);
          return;
        }
        if (e.target.closest('[data-list]')) onListClick(e);
      });
      panel.querySelector('[data-kind]').addEventListener('change', e => { filter.kind = e.target.value; fetchItems(true); });
    }
    const st = panel.querySelector('[data-status]');
    st.innerHTML = ['open', 'all'].map(s => `<button type="button" data-st="${s}" aria-pressed="${filter.status === s}">${esc(t(s === 'open' ? 's3iOpen' : 's3iAll'))}</button>`).join('');
    const ks = panel.querySelector('[data-kind]');
    const kinds = Object.keys(t('s3iKinds') || {});
    ks.innerHTML = `<option value="">${esc(t('s3iKindAll'))}</option>` + kinds.map(k => `<option value="${esc(k)}"${filter.kind === k ? ' selected' : ''}>${esc(kindLabel(k))}${counts.by_kind?.[k] ? ' (' + counts.by_kind[k] + ')' : ''}</option>`).join('');
    panel.querySelector('[data-reload]').textContent = t('s3iReload');
    panel.querySelector('[data-clear]').textContent = t('s3iClear');
    panel.querySelector('[data-list]').innerHTML = items.length ? items.map(i => itemHtml(i, false)).join('') : `<div class="empty">${esc(t('s3iEmpty'))}</div>`;
    paintTg();
  }

  function paintAll() { paintBell(); paintDrawer(); renderTab(); tab?.setCount(counts.open || M.state.data?.feature_data?.inbox?.open || ''); }

  // ---------- Telegram (shown on Settings > Notifications, next to the bot token) ----------
  function tgBox() {
    let box = document.querySelector('[data-tg]');
    if (box) return box;
    const host = document.querySelector('#tabsCard > [data-panel="notify"]');
    if (!host) return null;
    box = document.createElement('section');
    box.className = 's3-sec s3-tg-settings'; box.dataset.tg = '';
    host.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target.closest('[data-tgsave]')) { saveTg(); return; }
      if (e.target.closest('[data-tgtest]')) { testTg(); return; }
      if (e.target.closest('[data-gonotify]')) { document.getElementById('cfgTgToken')?.focus(); }
    });
    return box;
  }
  async function loadTg() {
    try { tg = await api('telegram_status'); } catch (e) { tg = { ok: false, error: e.message }; }
    paintTg();
  }
  function paintTg() {
    const box = tgBox();
    if (!box) return;
    const h = `<div class="s3-sec-h"><div><h2>${esc(t('s3tTitle'))}</h2><p class="sub t-muted">${esc(t('s3tHint'))}</p></div></div>`;
    if (!tg) { box.innerHTML = h + '<div class="empty">…</div>'; return; }
    if (tg.ok === false) { box.innerHTML = h + `<p class="sub t-err">${esc(tg.error || '')}</p>`; return; }
    if (!tg.configured) { box.innerHTML = h + `<div class="callout row-wrap" style="gap:8px"><span>${esc(t('s3tNotCfg'))}</span><button type="button" class="btn btn-sm" data-gonotify>${esc(t('s3tGoNotify'))}</button></div>`; return; }
    const d = tg.digest || {};
    const state = tg.owner === 'other' ? `<span class="badge b-warn">${esc(t('s3tOther'))}</span>`
      : tg.polling ? `<span class="badge b-ok"><span class="dot ok live"></span>${esc(t('s3tPolling'))}</span>` : `<span class="badge">${esc(t('s3tStopped'))}</span>`;
    const keep = box.querySelector('[data-tgform]');
    if (keep && box.contains(document.activeElement)) { box.querySelector('[data-tgstate]').innerHTML = state; return; }
    box.innerHTML = h + `<div class="row-wrap" style="gap:8px" data-tgstate>${state}
        ${tg.last_update_at ? `<span class="sub t-muted">${esc(t('s3tLast', { time: ago(tg.last_update_at) }))}</span>` : ''}
        ${tg.ignored ? `<span class="sub t-muted">${esc(t('s3tIgnored', { n: tg.ignored }))}</span>` : ''}
        ${tg.last_error ? `<span class="sub t-err">${esc(t('s3tErr', { err: tg.last_error }))}</span>` : ''}</div>
      <div class="s3-tgform" data-tgform>
        <label class="btn btn-sm btn-toggle"><input type="checkbox" data-tgin ${tg.inbound ? 'checked' : ''}><span>${esc(t('s3tInbound'))}</span></label>
        <label class="btn btn-sm btn-toggle"><input type="checkbox" data-tgpush ${tg.push_inbox ? 'checked' : ''}><span>${esc(t('s3tPush'))}</span></label>
        <label class="btn btn-sm btn-toggle"><input type="checkbox" data-tgdig ${d.enabled ? 'checked' : ''}><span>${esc(t('s3tDigest'))}</span></label>
        <label class="s3-time"><span class="sub t-muted">${esc(t('s3tMorning'))}</span><input class="input" type="time" data-tgm value="${esc(d.morning || '08:30')}"></label>
        <label class="s3-time"><span class="sub t-muted">${esc(t('s3tEvening'))}</span><input class="input" type="time" data-tge value="${esc(d.evening || '18:00')}"></label>
        <div class="row-wrap" style="gap:6px"><button type="button" class="btn btn-sm btn-primary" data-tgsave ${tgBusy ? 'disabled' : ''}>${esc(t('s3tSave'))}</button><button type="button" class="btn btn-sm" data-tgtest ${tgBusy ? 'disabled' : ''}>${esc(t('s3tTest'))}</button></div>
      </div>
      <details class="s3-cmds"><summary class="sub">${esc(t('s3tCmds'))}</summary>
        <pre class="code">/status          ${M.lang === 'vi' ? 'job đang chạy, hộp thư, sức khỏe' : 'running jobs, inbox, health'}
/inbox           ${M.lang === 'vi' ? '10 mục mới nhất' : '10 newest items'}
/approve &lt;id&gt;    /reject &lt;id&gt;    /retry &lt;id&gt;
/stop &lt;job_id|id&gt;
/task &lt;${M.lang === 'vi' ? 'nội dung' : 'text'}&gt;    → ${M.lang === 'vi' ? 'thẻ mới trên bảng việc (S2)' : 'new card on the task board (S2)'}
${M.lang === 'vi' ? 'Trả lời (reply) một thông báo = trả lời / chỉ dẫn tiếp cho agent' : 'Reply to a notification = answer / follow-up for the agent'}</pre></details>`;
  }
  async function saveTg() {
    const box = tgBox();
    const body = {
      inbound: box.querySelector('[data-tgin]').checked,
      push_inbox: box.querySelector('[data-tgpush]').checked,
      digest: { enabled: box.querySelector('[data-tgdig]').checked, morning: box.querySelector('[data-tgm]').value || '08:30', evening: box.querySelector('[data-tge]').value || '18:00' }
    };
    tgBusy = true; paintTg();
    try { tg = await api('telegram_config', body); toast(t('s3tSaved'), 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    finally { tgBusy = false; document.activeElement?.blur?.(); paintTg(); }
  }
  async function testTg() {
    tgBusy = true;
    try { await api('telegram_test', {}); toast(t('s3tSent'), 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    finally { tgBusy = false; }
  }

  loadTg();
  tab = M.addTab({
    id: 'inbox',
    title: () => t('s3iTab'),
    render(p) {
      const first = !panel;
      panel = p;
      if (first) fetchItems(true);
      renderTab();
    }
  });

  // ---------- job header actions (V7) ----------
  const flagOf = j => M.state.data?.feature_data?.inbox?.job_flags?.[j?.id] || '';
  async function itemForJob(j) {
    const local = items.find(i => i.job_id === j.id && i.status === 'open');
    if (local) return local;
    try {
      const r = await api('inbox_list&status=open&limit=200');
      return (r.items || []).find(i => i.job_id === j.id) || null;
    } catch { return null; }
  }
  M.addJobAction({
    id: 's3-login',
    label: () => t('s3iActLogin'),
    when: j => j.status !== 'RUNNING' && flagOf(j) === 'needs_login',
    run: async j => {
      const it = await itemForJob(j);
      if (!it?.agent) { toast(t('s3iNoItem'), 'warn'); return; }
      S3().startLogin?.(it.agent, { onRetry: () => act(it, 'retry') });
    }
  });
  M.addJobAction({
    id: 's3-retry',
    label: () => t('s3iActRetry'),
    when: j => j.status !== 'RUNNING' && ['needs_login', 'rate_limited', 'blocked', 'failed'].includes(flagOf(j)),
    run: async j => {
      const it = await itemForJob(j);
      if (!it || !it.actions?.includes('retry')) { toast(t('s3iNoItem'), 'warn'); return; }
      act(it, 'retry');
    }
  });

  M.on('data', () => {
    toastNew();
    paintBell();
    tab?.setCount(M.state.data?.feature_data?.inbox?.open || '');
    // Keep the open list fresh when it is visible.
    const visible = drawer || (panel && !panel.classList.contains('hidden'));
    const fd = M.state.data?.feature_data?.inbox;
    if (visible && fd && (fd.open !== counts.open || Date.now() - lastFetch > 20000)) fetchItems(false);
  });
  M.on('lang', paintAll);
  if (M.state.data) { toastNew(); paintBell(); }
})();
