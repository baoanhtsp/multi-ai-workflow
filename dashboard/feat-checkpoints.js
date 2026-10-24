// S1 — B7 checkpoints timeline + rollback (SPEC §9.6 B7, specs/s1-design.md §1, §7).
// Also provides window.MAWS1 (modal, confirm, diff viewer) for feat-worktrees.js.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { api, t, toast, esc, badge } = M;

  M.addI18n('vi', {
    s1Close: 'Đóng', s1Cancel: 'Huỷ', s1Refresh: 'Làm mới', s1Loading: 'Đang tải…', s1Diff: 'Diff', s1NoChanges: 'Không có thay đổi.',
    s1Truncated: 'Diff quá lớn, chỉ hiện một phần.', s1PickProject: 'Chọn một dự án trước.', s1HeadMoved: 'HEAD đã đổi',
    s1Confirm: 'Xác nhận', s1Files: '{n} tệp',
    cpTab: 'Checkpoint', cpNow: 'Tạo checkpoint', cpLabel: 'Nhãn (tuỳ chọn)', cpKeep: 'Giữ', cpKeepSave: 'Lưu',
    cpEmpty: 'Chưa có checkpoint. Checkpoint được tạo tự động trước mỗi job, mỗi vòng Auto-Gate và mỗi lần gọi agent.',
    cpNotGit: 'Dự án này không phải git repo, nên không có checkpoint.',
    cpVsNow: 'So với hiện tại', cpStep: 'Thay đổi ở bước này', cpRestore: 'Khôi phục', cpRollbackJob: 'Rollback về trước job này',
    cpRestoreQ: 'Khôi phục thư mục làm việc về checkpoint <b>{label}</b> (<code>{id}</code>)?',
    cpRestoreNote: 'Trước khi khôi phục sẽ tạo một checkpoint an toàn, nên bạn có thể hoàn tác. File bị .gitignore bỏ qua không bị đụng tới. HEAD không đổi.',
    cpHeadMovedNote: 'HEAD đã thay đổi kể từ checkpoint này: các commit mới được giữ nguyên, chỉ nội dung file được khôi phục.',
    cpRestored: 'Đã khôi phục {id}: ghi {w} tệp, xoá {d} tệp.', cpUndoBanner: 'Đã khôi phục {id}. Checkpoint an toàn: {safety}.', cpUndo: 'Hoàn tác',
    cpCreated: 'Đã tạo checkpoint {id}.', cpSame: 'Không có gì thay đổi kể từ checkpoint {id}.', cpSaved: 'Đã lưu: giữ {n} checkpoint.',
    cpNoJobCp: 'Job này không có checkpoint (dự án không phải git, hoặc hook checkpoint chưa được cài).',
    cpJobGroup: 'Job', cpEv_job_start: 'trước job', 'cpEv_round_start': 'vòng Auto-Gate', 'cpEv_before_agent': 'trước agent', cpEv_safety: 'an toàn', cpEv_manual: 'thủ công', cpEv_merge: 'trước merge',
    cpDiffTitle: 'Diff {from} → {to}', cpWorktree: 'hiện tại'
  });
  M.addI18n('en', {
    s1Close: 'Close', s1Cancel: 'Cancel', s1Refresh: 'Refresh', s1Loading: 'Loading…', s1Diff: 'Diff', s1NoChanges: 'No changes.',
    s1Truncated: 'The diff is too large; only part of it is shown.', s1PickProject: 'Pick a project first.', s1HeadMoved: 'HEAD moved',
    s1Confirm: 'Confirm', s1Files: '{n} files',
    cpTab: 'Checkpoints', cpNow: 'Checkpoint now', cpLabel: 'Label (optional)', cpKeep: 'Keep', cpKeepSave: 'Save',
    cpEmpty: 'No checkpoints yet. They are taken automatically before every job, every Auto-Gate round and every agent call.',
    cpNotGit: 'This project is not a git repository, so it has no checkpoints.',
    cpVsNow: 'Compare with now', cpStep: 'Changes in this step', cpRestore: 'Restore', cpRollbackJob: 'Rollback to before this job',
    cpRestoreQ: 'Restore the working tree to checkpoint <b>{label}</b> (<code>{id}</code>)?',
    cpRestoreNote: 'A safety checkpoint is taken first, so you can undo this. Ignored files are not touched. HEAD does not move.',
    cpHeadMovedNote: 'HEAD moved since this checkpoint: newer commits are kept, only file contents are restored.',
    cpRestored: 'Restored {id}: {w} files written, {d} deleted.', cpUndoBanner: 'Restored {id}. Safety checkpoint: {safety}.', cpUndo: 'Undo',
    cpCreated: 'Checkpoint {id} created.', cpSame: 'Nothing changed since checkpoint {id}.', cpSaved: 'Saved: keep {n} checkpoints.',
    cpNoJobCp: 'This job has no checkpoint (not a git project, or the checkpoint hook is not installed).',
    cpJobGroup: 'Job', cpEv_job_start: 'before job', cpEv_round_start: 'Auto-Gate round', cpEv_before_agent: 'before agent', cpEv_safety: 'safety', cpEv_manual: 'manual', cpEv_merge: 'before merge',
    cpDiffTitle: 'Diff {from} → {to}', cpWorktree: 'now'
  });

  // ---------- shared S1 helpers ----------
  const enc = encodeURIComponent;
  const q = (action, params) => action + Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `&${k}=${enc(v)}`).join('');
  const pm = s => s ? `<span class="s1-pm"><span class="a">+${Number(s.additions || 0)}</span> <span class="d">−${Number(s.deletions || 0)}</span></span>` : '';
  function relTime(iso) {
    const ts = Date.parse(iso || '');
    if (!ts) return '';
    const sec = Math.round((ts - Date.now()) / 1000), a = Math.abs(sec);
    const rtf = new Intl.RelativeTimeFormat(M.lang === 'en' ? 'en' : 'vi', { numeric: 'auto' });
    if (a < 60) return rtf.format(sec, 'second');
    if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    return rtf.format(Math.round(sec / 86400), 'day');
  }
  const absTime = iso => { const d = new Date(iso || ''); return isNaN(d) ? '' : d.toLocaleString(M.lang === 'en' ? 'en-US' : 'vi-VN'); };

  // A <dialog> with buttons. onAction(id, body) may be async; throw to keep the dialog open with the error shown,
  // return false to keep it open silently. Resolves with the action id, or null when cancelled.
  function openModal({ title, html = '', size = '', buttons = [], onOpen, onAction }) {
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.className = 's1-dlg' + (size === 'sm' ? ' s1-sm' : '');
      d.innerHTML = `<form method="dialog" novalidate>
        <div class="s1-dlg-h"><h3></h3><button type="button" class="btn btn-sm s1-x" data-act="__close" aria-label="${esc(t('s1Close'))}">✕</button></div>
        <div class="s1-dlg-b"></div>
        <div class="s1-dlg-f"><span class="s1-dlg-err s1-errbox hidden" role="alert" style="margin-right:auto"></span>
          <button type="button" class="btn" data-act="__close">${esc(buttons.length ? t('s1Cancel') : t('s1Close'))}</button></div>
      </form>`;
      d.querySelector('h3').textContent = title;
      const body = d.querySelector('.s1-dlg-b'), foot = d.querySelector('.s1-dlg-f'), err = d.querySelector('.s1-dlg-err');
      body.innerHTML = html;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button'; el.className = 'btn ' + (b.cls || 'btn-primary'); el.dataset.act = b.id; el.textContent = b.label;
        foot.appendChild(el);
      }
      let done = false;
      const finish = v => { if (done) return; done = true; try { d.close(); } catch {} d.remove(); resolve(v); };
      const act = async id => {
        if (id === '__close') return finish(null);
        err.classList.add('hidden');
        const btns = foot.querySelectorAll('button');
        btns.forEach(b => { b.disabled = true; });
        try {
          const keep = onAction ? await onAction(id, body, d) : undefined;
          if (keep === false) { btns.forEach(b => { b.disabled = false; }); return; }
          finish(id);
        } catch (e) {
          err.textContent = e?.message || String(e);
          err.classList.remove('hidden');
          btns.forEach(b => { b.disabled = false; });
        }
      };
      d.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && d.contains(b) && !b.disabled) act(b.dataset.act); });
      d.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      d.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        if (buttons.length === 1 && e.target.querySelector('textarea:focus') == null) act(buttons[0].id);
      });
      document.body.appendChild(d);
      d.showModal();
      try { onOpen?.(body, d); } catch (e) { console.error('[s1 modal]', e); }
      const first = body.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
      if (first) first.focus();
    });
  }
  async function confirmBox({ title, html, ok, danger }) {
    return (await openModal({ title, html, size: 'sm', buttons: [{ id: 'ok', label: ok || t('s1Confirm'), cls: danger ? 'btn-primary btn-danger-solid' : 'btn-primary' }] })) === 'ok';
  }

  // Renders the {files, patch, truncated} shape returned by checkpoint_diff / worktree_diff / git_diff.
  function diffView(r) {
    const files = Array.isArray(r?.files) ? r.files : [];
    const patch = String(r?.patch || '');
    if (!files.length && !patch.trim()) return `<div class="empty">${esc(t('s1NoChanges'))}</div>`;
    let fileNo = -1;
    const lines = patch.split('\n').map(line => {
      if (line.startsWith('diff --git ')) {
        fileNo++;
        const m = / b\/(.+)$/.exec(line);
        return `<span class="l l-file" id="s1f-${fileNo}">${esc(m ? m[1] : line)}</span>`;
      }
      let c = '';
      if (line.startsWith('@@')) c = 'l-hunk';
      else if (line.startsWith('+++') || line.startsWith('---') || /^(index |new file mode|deleted file mode|similarity |rename |old mode|new mode|Binary files)/.test(line)) c = 'l-meta';
      else if (line.startsWith('+')) c = 'l-add';
      else if (line.startsWith('-')) c = 'l-del';
      return `<span class="l ${c}">${esc(line)}</span>`;
    });
    const list = files.map((f, i) => `<li><button type="button" data-s1-jump="${i}" title="${esc(f.path)}">
        <span class="s1-st s1-st-${esc((f.status || 'M')[0])}">${esc((f.status || 'M')[0])}</span>
        <span class="s1-fp">${esc(f.old_path ? f.old_path + ' → ' + f.path : f.path)}</span>
        ${f.binary ? badge('bin') : pm(f)}</button></li>`).join('');
    return `${r.truncated ? `<div class="s1-warn">${esc(t('s1Truncated'))}</div>` : ''}
      <div class="s1-diff"><ul class="s1-diff-files">${list}</ul><pre class="s1-patch">${lines.join('')}</pre></div>`;
  }
  // Click on a file in the list scrolls the patch to it (files and patch sections share the git order).
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-s1-jump]');
    if (!b) return;
    const box = b.closest('.s1-diff'), target = box?.querySelector('#s1f-' + b.dataset.s1Jump);
    box?.querySelectorAll('[data-s1-jump]').forEach(x => x.setAttribute('aria-current', String(x === b)));
    if (target) target.parentElement.scrollTop = target.offsetTop - 2;
  });
  async function showDiff(title, action, params) {
    let r;
    const id = openModal({ title, html: `<div class="empty">${esc(t('s1Loading'))}</div>`, onOpen: async body => {
      try { r = await api(q(action, params)); body.innerHTML = diffView(r); }
      catch (e) { body.innerHTML = `<div class="s1-errbox">${esc(e.message)}</div>`; }
    } });
    return id;
  }

  window.MAWS1 = { openModal, confirmBox, diffView, showDiff, relTime, absTime, pm, q };

  // ---------- Checkpoints tab ----------
  const st = { project: '', list: [], retention: 50, at: 0, loading: false, error: '', notGit: false, lastRestore: null };
  let tab = null;
  const visible = () => tab && !tab.panel.classList.contains('hidden');
  const evLabel = ev => t('cpEv_' + String(ev || 'manual').replace(/-/g, '_'));

  async function refresh(force) {
    const p = M.project();
    const path = p?.path || '';
    if (path !== st.project) { st.project = path; st.list = []; st.lastRestore = null; st.at = 0; force = true; }
    if (!path || st.loading || (!force && (!visible() || Date.now() - st.at < 15000))) return;
    st.loading = true;
    try {
      const r = await api(q('checkpoint_list', { project_path: path, limit: 200 }));
      if (st.project !== path) return;
      st.list = Array.isArray(r.checkpoints) ? r.checkpoints : [];
      st.retention = Number(r.retention) || st.retention;
      st.error = ''; st.notGit = false;
    } catch (e) {
      st.list = [];
      st.notGit = /git repo/i.test(e.message);
      st.error = st.notGit ? '' : e.message;
    } finally {
      st.loading = false; st.at = Date.now();
      paint();
    }
  }

  function groups(list) {
    const out = [];
    for (const c of list) {
      const last = out[out.length - 1];
      if (last && last.key === c.job_key) last.items.push(c);
      else out.push({ key: c.job_key, items: [c] });
    }
    return out;
  }

  function paint() {
    if (!tab) return;
    const panel = tab.panel;
    if (!panel.dataset.s1) {
      panel.dataset.s1 = '1';
      panel.innerHTML = `<div class="s1-bar">
          <button type="button" class="btn btn-sm btn-primary" data-cp="now"></button>
          <span class="s1-sp"></span>
          <label class="s1-check"><span data-cp-l="keep"></span> <input class="input s1-num" type="number" min="5" max="500" step="1" data-cp="keepv"></label>
          <button type="button" class="btn btn-sm" data-cp="keep"></button>
          <button type="button" class="btn btn-sm" data-cp="refresh"></button>
        </div><div data-cp="banner"></div><div class="s1-tl" data-cp="tl"></div>`;
      panel.addEventListener('click', onClick);
    }
    panel.querySelector('[data-cp="now"]').textContent = t('cpNow');
    panel.querySelector('[data-cp-l="keep"]').textContent = t('cpKeep');
    panel.querySelector('[data-cp="keep"]').textContent = t('cpKeepSave');
    panel.querySelector('[data-cp="refresh"]').textContent = t('s1Refresh');
    const keep = panel.querySelector('[data-cp="keepv"]');
    if (document.activeElement !== keep) keep.value = st.retention;
    const lr = st.lastRestore;
    panel.querySelector('[data-cp="banner"]').innerHTML = lr
      ? `<div class="s1-banner" role="status"><span>${esc(t('cpUndoBanner', { id: lr.restored, safety: lr.safety }))}</span><button type="button" class="btn btn-sm" data-cp-undo="${esc(lr.safety)}">${esc(t('cpUndo'))}</button></div>`
      : '';
    tab.setCount(st.list.length);
    const tl = panel.querySelector('[data-cp="tl"]');
    if (!st.project) { tl.innerHTML = `<div class="empty">${esc(t('s1PickProject'))}</div>`; return; }
    if (st.error) { tl.innerHTML = `<div class="s1-errbox" style="margin-top:10px">${esc(st.error)}</div>`; return; }
    if (st.notGit) { tl.innerHTML = `<div class="empty">${esc(t('cpNotGit'))}</div>`; return; }
    if (!st.list.length) { tl.innerHTML = `<div class="empty">${esc(st.at ? t('cpEmpty') : t('s1Loading'))}</div>`; return; }
    const idx = new Map(st.list.map((c, i) => [c.id, i]));
    tl.innerHTML = groups(st.list).map(g => {
      const first = g.items[g.items.length - 1];
      const isJob = /^job_/.test(g.key) && first.event === 'job-start';
      return `<div class="s1-grp">
        <div class="s1-grp-h">${isJob ? esc(t('cpJobGroup')) : ''} <span class="s1-mono">${esc(g.key)}</span>
          ${isJob ? `<button type="button" class="btn btn-sm" data-cp-restore="${esc(first.id)}" style="margin-left:auto">${esc(t('cpRollbackJob'))}</button>` : ''}</div>
        ${g.items.map(c => {
          const older = st.list[idx.get(c.id) + 1];
          const who = [c.agent, c.role].filter(Boolean).join(' · ');
          return `<div class="s1-cp" data-ev="${esc(c.event || '')}">
            <span class="s1-cp-dot" aria-hidden="true"></span>
            <div class="s1-cp-main">
              <div class="s1-cp-t">${badge(evLabel(c.event), c.event === 'safety' ? 'b-warn' : c.event === 'manual' ? 'b-ok' : 'b-info')}<b>${esc(c.label || c.id)}</b></div>
              <div class="s1-cp-s"><span class="s1-mono">${esc(c.id)}</span>
                <span title="${esc(absTime(c.created_at))}">${esc(relTime(c.created_at))}</span>
                ${who ? `<span>${esc(who)}</span>` : ''}${c.round ? `<span>#${esc(c.round)}</span>` : ''}
                ${c.stats ? `${pm(c.stats)} <span>${esc(t('s1Files', { n: c.stats.files ?? 0 }))}</span>` : ''}
                ${c.head_moved ? badge(t('s1HeadMoved'), 'b-warn') : ''}</div>
            </div>
            <div class="s1-cp-a">
              <button type="button" class="btn btn-sm" data-cp-diff="${esc(c.id)}">${esc(t('cpVsNow'))}</button>
              ${older ? `<button type="button" class="btn btn-sm" data-cp-step="${esc(c.id)}" data-cp-from="${esc(older.id)}">${esc(t('cpStep'))}</button>` : ''}
              <button type="button" class="btn btn-sm btn-danger" data-cp-restore="${esc(c.id)}">${esc(t('cpRestore'))}</button>
            </div></div>`;
        }).join('')}</div>`;
    }).join('');
  }

  async function restore(project, cp) {
    const html = `<p style="margin:0">${t('cpRestoreQ', { label: esc(cp.label || cp.id), id: esc(cp.id) })}</p>
      <div class="sub">${esc(t('cpRestoreNote'))}</div>${cp.head_moved ? `<div class="s1-warn">${esc(t('cpHeadMovedNote'))}</div>` : ''}`;
    if (!(await confirmBox({ title: t('cpRestore'), html, ok: t('cpRestore'), danger: true }))) return;
    try {
      const r = await api('checkpoint_restore', { project_path: project, checkpoint: cp.id, confirm: true });
      toast(t('cpRestored', { id: r.restored || cp.id, w: r.files_written ?? 0, d: r.files_deleted ?? 0 }), 'ok');
      if (project === st.project) st.lastRestore = { restored: r.restored || cp.id, safety: r.safety_checkpoint || '' };
      refresh(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function onClick(e) {
    const b = e.target.closest('button');
    if (!b || !st.project) return;
    const byId = id => st.list.find(c => c.id === id);
    if (b.dataset.cp === 'refresh') return refresh(true);
    if (b.dataset.cp === 'now') {
      const project = st.project;
      await openModal({ title: t('cpNow'), size: 'sm', html: `<label class="lbl" for="s1CpLabel">${esc(t('cpLabel'))}</label><input class="input" id="s1CpLabel" maxlength="120">`,
        buttons: [{ id: 'ok', label: t('cpNow') }],
        onAction: async (id, body) => {
          const r = await api('checkpoint_create', { project_path: project, label: body.querySelector('#s1CpLabel').value.trim() });
          toast(t(r.created === false ? 'cpSame' : 'cpCreated', { id: r.checkpoint?.id || r.checkpoint || '' }), 'ok');
          refresh(true);
        } });
      return;
    }
    if (b.dataset.cp === 'keep') {
      const n = Math.round(Number(b.parentElement.querySelector('[data-cp="keepv"]').value));
      try { const r = await api('checkpoint_config', { project_path: st.project, retention: n }); st.retention = Number(r.retention ?? r.config?.retention) || n; toast(t('cpSaved', { n: st.retention }), 'ok'); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (b.dataset.cpDiff) return showDiff(t('cpDiffTitle', { from: b.dataset.cpDiff, to: t('cpWorktree') }), 'checkpoint_diff', { project_path: st.project, from: b.dataset.cpDiff, to: 'WORKTREE' });
    if (b.dataset.cpStep) return showDiff(t('cpDiffTitle', { from: b.dataset.cpFrom, to: b.dataset.cpStep }), 'checkpoint_diff', { project_path: st.project, from: b.dataset.cpFrom, to: b.dataset.cpStep });
    if (b.dataset.cpRestore) { const cp = byId(b.dataset.cpRestore); if (cp) restore(st.project, cp); return; }
    if (b.dataset.cpUndo) restore(st.project, byId(b.dataset.cpUndo) || { id: b.dataset.cpUndo, label: evLabel('safety') });
  }

  tab = M.addTab({ id: 'checkpoints', title: () => t('cpTab'), render: () => { paint(); refresh(false); } });
  if (tab) tab.button.addEventListener('click', () => refresh(true));
  M.on('project-change', () => refresh(true));
  M.on('job-end', () => { st.at = 0; refresh(false); });

  // "Rollback to before this job" on the live job header.
  M.addJobAction({
    id: 'cp-rollback',
    label: () => t('cpRollbackJob'),
    when: j => !!j?.id && j.status !== 'RUNNING',
    run: async j => {
      let r;
      try { r = await api(q('checkpoint_rollback_target', { job_id: j.id })); }
      catch (e) { toast(e.status === 404 ? t('cpNoJobCp') : e.message, e.status === 404 ? 'warn' : 'err'); return; }
      const cp = r.checkpoint && typeof r.checkpoint === 'object' ? r.checkpoint : { id: r.checkpoint, label: t('cpEv_job_start') };
      restore(r.project_path, cp);
    }
  });
})();
