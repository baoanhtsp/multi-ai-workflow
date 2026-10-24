// S2 GitHub (specs/s2-design.md §6): issue → card, approved card → PR, PR feedback → fix card.
// Plugs into the board through window.MAW_BOARD (feat-tasks.js); everything goes through the `gh` CLI on the server.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const { t, esc, toast } = M;

  M.addI18n('vi', {
    'gh.importIssue': 'Nhập issue GitHub', 'gh.feedback': 'Phản hồi PR', 'gh.openPr': 'Mở PR', 'gh.viewPr': 'PR #{n} ↗',
    'gh.checking': 'Đang kiểm tra gh…', 'gh.missing': 'Chưa cài GitHub CLI (gh). Cài từ cli.github.com rồi tải lại.',
    'gh.loggedOut': 'gh chưa đăng nhập. Chạy: gh auth login', 'gh.noRepo': 'Dự án này chưa có remote GitHub.',
    'gh.as': 'gh {v} · @{u} · {repo}', 'gh.search': 'Tìm issue…', 'gh.open': 'Đang mở', 'gh.closed': 'Đã đóng', 'gh.all': 'Tất cả',
    'gh.import': 'Nhập', 'gh.imported': 'Đã tạo thẻ từ issue #{n}', 'gh.noIssues': 'Không có issue nào.', 'gh.queue': 'Xếp hàng chạy ngay',
    'gh.branch': 'Nhánh (trống = nhánh hiện tại / worktree của thẻ)', 'gh.base': 'Nhánh đích (trống = nhánh mặc định)', 'gh.draft': 'PR nháp',
    'gh.ai': 'Để AI viết mô tả PR (job reviewer tóm tắt diff)', 'gh.reviewer': 'Agent viết mô tả', 'gh.create': 'Đẩy nhánh và mở PR',
    'gh.confirmPr': 'Nhánh sẽ được push lên origin và một PR sẽ được mở trên GitHub cho thẻ "{x}". Tiếp tục?',
    'gh.prQueued': 'Đang chuẩn bị PR (mô tả → push → tạo PR). Theo dõi ở "Phản hồi PR".', 'gh.prs': 'PR đang mở', 'gh.noPrs': 'Không có PR đang mở.',
    'gh.fixCard': 'Tạo thẻ sửa', 'gh.fixCreated': 'Đã tạo thẻ sửa cho PR #{n} ({c} nhận xét, {f} check lỗi)', 'gh.requests': 'Yêu cầu tạo PR gần đây',
    'gh.checks': 'Check: {x}', 'gh.pickProject': 'Chọn một dự án ở thanh trên trước.', 'gh.retry': 'Kiểm tra lại'
  });
  M.addI18n('en', {
    'gh.importIssue': 'Import GitHub issue', 'gh.feedback': 'PR feedback', 'gh.openPr': 'Open PR', 'gh.viewPr': 'PR #{n} ↗',
    'gh.checking': 'Checking gh…', 'gh.missing': 'GitHub CLI (gh) is not installed. Install it from cli.github.com and reload.',
    'gh.loggedOut': 'gh is not logged in. Run: gh auth login', 'gh.noRepo': 'This project has no GitHub remote.',
    'gh.as': 'gh {v} · @{u} · {repo}', 'gh.search': 'Search issues…', 'gh.open': 'Open', 'gh.closed': 'Closed', 'gh.all': 'All',
    'gh.import': 'Import', 'gh.imported': 'Card created from issue #{n}', 'gh.noIssues': 'No issues.', 'gh.queue': 'Queue it right away',
    'gh.branch': 'Branch (empty = current branch / the card\'s worktree)', 'gh.base': 'Base branch (empty = default branch)', 'gh.draft': 'Draft PR',
    'gh.ai': 'Let an AI write the PR description (a reviewer job summarises the diff)', 'gh.reviewer': 'Description writer', 'gh.create': 'Push branch and open PR',
    'gh.confirmPr': 'The branch will be pushed to origin and a pull request opened on GitHub for card "{x}". Continue?',
    'gh.prQueued': 'Preparing the PR (description → push → create). Follow it under "PR feedback".', 'gh.prs': 'Open pull requests', 'gh.noPrs': 'No open pull requests.',
    'gh.fixCard': 'Create fix card', 'gh.fixCreated': 'Fix card created for PR #{n} ({c} comments, {f} failed checks)', 'gh.requests': 'Recent PR requests',
    'gh.checks': 'Checks: {x}', 'gh.pickProject': 'Pick a project in the top bar first.', 'gh.retry': 'Check again'
  });

  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
  const get = (action, params = {}) => M.api(action + qs(params));
  const post = (action, body) => M.api(action, body || {});
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const agentIds = () => Object.keys(M.agents());
  const agentLabel = id => M.agents()[id]?.label || id;
  const ROLES = ['backend', 'frontend', 'architect', 'reviewer', 'tester'];
  const fail = e => toast(t('tk.err', { x: e?.message || String(e) }), 'err');
  const cache = new Map(); // project path -> { at, data }

  async function ghStatus(path, force) {
    const hit = cache.get(path);
    if (!force && hit && Date.now() - hit.at < 300000) return hit.data;
    let data;
    try { data = await get('github_status', { project_path: path }); }
    catch (e) { data = { ok: false, error: e.message, gh: e.data?.gh || null }; }
    cache.set(path, { at: Date.now(), data });
    return data;
  }
  // One line telling the user whether GitHub is usable; returns null when it is.
  function blocker(st) {
    if (!st || st.ok === false) {
      if (st?.gh?.installed === false) return t('gh.missing');
      if (st?.gh && st.gh.logged_in === false) return t('gh.loggedOut');
      return st?.error || t('gh.missing');
    }
    if (!st.gh?.installed) return t('gh.missing');
    if (!st.gh.logged_in) return t('gh.loggedOut');
    if (!st.repo) return t('gh.noRepo');
    return null;
  }
  const statusLine = st => `<div class="sub gh-line"><span class="dot ok"></span>${esc(t('gh.as', { v: st.gh.version || '', u: st.gh.user || '?', repo: st.repo?.name_with_owner || '' }))}</div>`;

  function board() { return window.MAW_BOARD; }
  function needProject() {
    const p = M.project();
    if (!p) toast(t('gh.pickProject'), 'warn');
    return p;
  }
  function blockedBody(msg, retry) {
    const box = document.createElement('div');
    box.innerHTML = `<div class="callout t-warn">${esc(msg)}</div><div class="tk-dlg-f"><button type="button" class="btn btn-sm">${esc(t('gh.retry'))}</button></div>`;
    box.querySelector('button').onclick = retry;
    return box;
  }

  // ---------- issue → card ----------
  async function importIssueDialog(project) {
    project ||= needProject(); if (!project) return;
    const B = board();
    const box = document.createElement('div');
    box.innerHTML = `<div class="empty">${esc(t('gh.checking'))}</div>`;
    const d = B.dialog({ title: `${t('gh.importIssue')} · ${project.name}`, body: box, wide: true });
    const st = await ghStatus(project.path);
    const why = blocker(st);
    if (why) { box.replaceChildren(blockedBody(why, () => { d.close(); cache.delete(project.path); importIssueDialog(project); })); return; }
    const ids = agentIds();
    const def = ids.includes('claude') ? 'claude' : ids[0];
    box.innerHTML = `${statusLine(st)}
      <div class="tk-toolbar gh-bar">
        <input class="input tk-q" type="search" placeholder="${esc(t('gh.search'))}">
        <select class="select-sm gh-state">${opt('open', t('gh.open'), true)}${opt('closed', t('gh.closed'))}${opt('all', t('gh.all'))}</select>
        <select class="select-sm gh-agent" aria-label="Agent">${ids.map(i => opt(i, agentLabel(i), i === def)).join('')}</select>
        <select class="select-sm gh-role" aria-label="Role">${ROLES.map(r => opt(r, r, r === 'backend')).join('')}</select>
        <label class="check"><input type="checkbox" class="gh-queue">${esc(t('gh.queue'))}</label>
      </div>
      <div class="list gh-list"><div class="empty">${esc(t('gh.checking'))}</div></div>`;
    const list = box.querySelector('.gh-list');
    let timer = 0;
    const load = async () => {
      list.innerHTML = `<div class="empty">${esc(t('tk.loading'))}</div>`;
      try {
        const r = await get('github_issues', { project_path: project.path, state: box.querySelector('.gh-state').value, search: box.querySelector('.tk-q').value.trim(), limit: 30 });
        const imported = new Set(B.tasks.filter(c => c.source?.kind === 'github-issue' && c.project_path === project.path).map(c => c.source.number));
        list.innerHTML = (r.issues || []).map(i => `<div class="item gh-issue"><div class="row-wrap"><b>#${esc(i.number)}</b><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" class="truncate">${esc(i.title)}</a>
            ${(i.labels || []).slice(0, 4).map(l => `<span class="tk-label">${esc(l)}</span>`).join('')}<span class="spacer"></span><span class="sub">@${esc(i.author || '')}</span>
            <button type="button" class="btn btn-sm${imported.has(i.number) ? '' : ' btn-primary'}" data-n="${esc(i.number)}"${imported.has(i.number) ? ' disabled' : ''}>${esc(imported.has(i.number) ? '✓' : t('gh.import'))}</button></div></div>`).join('')
          || `<div class="empty">${esc(t('gh.noIssues'))}</div>`;
      } catch (e) { list.innerHTML = `<div class="empty t-err">${esc(e.message)}</div>`; }
    };
    box.querySelector('.tk-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 350); };
    box.querySelector('.gh-state').onchange = load;
    list.addEventListener('click', async e => {
      const b = e.target.closest('[data-n]'); if (!b) return;
      b.disabled = true;
      try {
        await post('github_issue_import', {
          project_path: project.path, number: Number(b.dataset.n), mode: 'task',
          agent: box.querySelector('.gh-agent').value, role: box.querySelector('.gh-role').value,
          status: box.querySelector('.gh-queue').checked ? 'queued' : 'backlog'
        });
        b.textContent = '✓'; b.classList.remove('btn-primary');
        toast(t('gh.imported', { n: b.dataset.n }), 'ok');
        B.refresh();
      } catch (err) { b.disabled = false; fail(err); }
    });
    load();
  }

  // ---------- approved card → PR ----------
  async function openPrDialog(card) {
    const B = board();
    const project = (M.state.data?.projects || []).find(p => p.path === card.project_path) || { name: card.project_path, path: card.project_path };
    const box = document.createElement('div');
    box.innerHTML = `<div class="empty">${esc(t('gh.checking'))}</div>`;
    const d = B.dialog({ title: `${t('gh.openPr')} · ${card.title}`, body: box, wide: true });
    const st = await ghStatus(project.path);
    const why = blocker(st);
    if (why) { box.replaceChildren(blockedBody(why, () => { d.close(); cache.delete(project.path); openPrDialog(card); })); return; }
    const ids = agentIds().filter(i => M.agents()[i]?.capabilities?.review);
    const def = M.state.data?.defaults?.team?.reviewer || (ids.includes('codex') ? 'codex' : ids[0]);
    box.innerHTML = `${statusLine(st)}<form class="tk-form">
      <div class="tk-grid">
        <div><label class="lbl" for="ghBranch">${esc(t('gh.branch'))}</label><input id="ghBranch" class="input mono" name="branch" value="${esc(card.branch || '')}"></div>
        <div><label class="lbl" for="ghBase">${esc(t('gh.base'))}</label><input id="ghBase" class="input mono" name="base" placeholder="${esc(st.repo?.default_branch || 'main')}"></div>
      </div>
      <label class="check"><input type="checkbox" name="draft">${esc(t('gh.draft'))}</label>
      <label class="check"><input type="checkbox" name="ai" checked>${esc(t('gh.ai'))}</label>
      <div class="tk-grid"><div><label class="lbl" for="ghRev">${esc(t('gh.reviewer'))}</label><select id="ghRev" name="reviewer_agent">${ids.map(i => opt(i, agentLabel(i), i === def)).join('')}</select></div></div>
      <div class="tk-dlg-f"><button type="submit" class="btn btn-primary">${esc(t('gh.create'))}</button></div>
    </form>`;
    box.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (!await B.confirm(t('gh.confirmPr', { x: card.title }), { danger: false, ok: t('gh.create') })) return;
      try {
        await post('github_pr_create', {
          task_id: card.id, branch: String(f.get('branch') || '').trim() || undefined, base: String(f.get('base') || '').trim() || undefined,
          draft: f.has('draft'), ai_description: f.has('ai'), reviewer_agent: String(f.get('reviewer_agent') || '') || undefined
        });
        toast(t('gh.prQueued'), 'ok');
        d.close(); B.refresh();
      } catch (err) { fail(err); }
    });
  }

  // ---------- PR feedback → fix card ----------
  async function feedbackDialog(project) {
    project ||= needProject(); if (!project) return;
    const B = board();
    const box = document.createElement('div');
    box.innerHTML = `<div class="empty">${esc(t('gh.checking'))}</div>`;
    const d = B.dialog({ title: `${t('gh.feedback')} · ${project.name}`, body: box, wide: true });
    const st = await ghStatus(project.path);
    const why = blocker(st);
    if (why) { box.replaceChildren(blockedBody(why, () => { d.close(); cache.delete(project.path); feedbackDialog(project); })); return; }
    box.innerHTML = `${statusLine(st)}<h4 class="gh-h">${esc(t('gh.prs'))}</h4><div class="list gh-prs"><div class="empty">${esc(t('tk.loading'))}</div></div>
      <h4 class="gh-h">${esc(t('gh.requests'))}</h4><div class="list gh-reqs"><div class="empty">${esc(t('tk.loading'))}</div></div>`;
    const checkCls = c => ({ pass: 'b-ok', fail: 'b-err', pending: 'b-warn' }[c] || '');
    try {
      const r = await get('github_prs', { project_path: project.path });
      box.querySelector('.gh-prs').innerHTML = (r.prs || []).map(p => `<div class="item"><div class="row-wrap"><b>#${esc(p.number)}</b><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="truncate">${esc(p.title)}</a>
          <span class="badge mono">${esc(p.head)}</span><span class="badge ${checkCls(p.checks)}">${esc(t('gh.checks', { x: p.checks || 'none' }))}</span>${p.review_decision ? `<span class="badge ${p.review_decision === 'APPROVED' ? 'b-ok' : 'b-warn'}">${esc(p.review_decision)}</span>` : ''}
          <span class="spacer"></span><button type="button" class="btn btn-sm btn-primary" data-pr="${esc(p.number)}">${esc(t('gh.fixCard'))}</button></div></div>`).join('')
        || `<div class="empty">${esc(t('gh.noPrs'))}</div>`;
    } catch (e) { box.querySelector('.gh-prs').innerHTML = `<div class="empty t-err">${esc(e.message)}</div>`; }
    try {
      const r = await get('github_pr_requests');
      const reqs = (r.requests || []).filter(x => x.project_path === project.path).slice(0, 10);
      box.querySelector('.gh-reqs').innerHTML = reqs.map(x => `<div class="item"><div class="row-wrap"><span class="badge ${x.state === 'done' ? 'b-ok' : x.state === 'failed' ? 'b-err' : 'b-warn'}">${esc(x.state)}</span><span class="mono sub">${esc(x.branch || '')} → ${esc(x.base || '')}</span>
          ${x.pr_url ? `<a href="${esc(x.pr_url)}" target="_blank" rel="noopener noreferrer">${esc(x.pr_url)}</a>` : ''}${x.error ? `<span class="t-err sub">${esc(x.error)}</span>` : ''}</div></div>`).join('')
        || '<div class="empty">—</div>';
    } catch (e) { box.querySelector('.gh-reqs').innerHTML = `<div class="empty t-err">${esc(e.message)}</div>`; }
    box.querySelector('.gh-prs').addEventListener('click', async e => {
      const b = e.target.closest('[data-pr]'); if (!b) return;
      b.disabled = true;
      try {
        const r = await post('github_pr_feedback', { project_path: project.path, number: Number(b.dataset.pr), status: 'backlog' });
        toast(t('gh.fixCreated', { n: b.dataset.pr, c: (r.counts?.comments ?? 0) + (r.counts?.reviews ?? 0), f: r.counts?.failed_checks ?? 0 }), 'ok');
        B.refresh();
      } catch (err) { b.disabled = false; fail(err); }
    });
  }

  // ---------- wire into the board ----------
  function wire() {
    const B = board(); if (!B || wire.done) return;
    wire.done = true;
    B.addToolbarButton({ id: 'gh-issue', label: () => t('gh.importIssue'), run: () => importIssueDialog() });
    B.addToolbarButton({ id: 'gh-feedback', label: () => t('gh.feedback'), run: () => feedbackDialog() });
    B.addCardAction({ id: 'gh-pr', label: () => t('gh.openPr'), when: c => (c.status === 'review' || c.status === 'done') && !c.pr?.url, run: c => openPrDialog(c) });
    B.addCardAction({ id: 'gh-pr-view', label: c => t('gh.viewPr', { n: c.pr?.number ?? '' }), when: c => !!c.pr?.url, run: c => window.open(c.pr.url, '_blank', 'noopener,noreferrer') });
    M.addProjectAction({ id: 'gh-issue', label: () => t('gh.importIssue'), run: p => { M.showView('board'); importIssueDialog(p); } });
  }
  if (window.MAW_BOARD) wire(); else document.addEventListener('maw-board-ready', wire, { once: true });
})();
