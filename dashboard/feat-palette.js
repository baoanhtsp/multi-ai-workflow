// S6 — Global command palette (N11): Ctrl+K / Cmd+K anywhere. Actions, agents, conversations, projects,
// team templates and tasks with fuzzy search. Project switching stays one of its sources.
(() => {
  'use strict';
  const M = window.MAW;
  if (!M || M.palette) return;
  const { esc } = M;

  const L = {
    vi: {
      'pal.ph': 'Gõ lệnh, agent, dự án, cuộc trò chuyện…', 'pal.none': 'Không có kết quả', 'pal.hint': '↑↓ chọn · Enter mở · Esc đóng',
      'pal.g.actions': 'Lệnh', 'pal.g.agents': 'Agent', 'pal.g.convs': 'Cuộc trò chuyện', 'pal.g.projects': 'Dự án', 'pal.g.templates': 'Mẫu đội', 'pal.g.tasks': 'Nhiệm vụ',
      'pal.a.ws': 'Mở Không gian agent', 'pal.a.dash': 'Mở Bảng điều khiển', 'pal.a.newAgent': 'Tạo agent mới', 'pal.a.newConv': 'Cuộc trò chuyện mới với agent đang chọn',
      'pal.a.team': 'Thiết lập Agent Team', 'pal.a.ready': 'Kiểm tra sẵn sàng', 'pal.a.refresh': 'Làm mới dữ liệu', 'pal.a.stop': 'Dừng lượt đang chạy',
      'pal.a.light': 'Giao diện sáng', 'pal.a.dark': 'Giao diện tối', 'pal.a.neon': 'Giao diện neon', 'pal.a.vi': 'Tiếng Việt', 'pal.a.en': 'English',
      'pal.current': 'đang chọn', 'pal.title': 'Bảng lệnh',
    },
    en: {
      'pal.ph': 'Type a command, agent, project, conversation…', 'pal.none': 'No results', 'pal.hint': '↑↓ select · Enter open · Esc close',
      'pal.g.actions': 'Actions', 'pal.g.agents': 'Agents', 'pal.g.convs': 'Conversations', 'pal.g.projects': 'Projects', 'pal.g.templates': 'Team templates', 'pal.g.tasks': 'Tasks',
      'pal.a.ws': 'Open the Workspace', 'pal.a.dash': 'Open the Dashboard', 'pal.a.newAgent': 'Create a new agent', 'pal.a.newConv': 'New conversation with the selected agent',
      'pal.a.team': 'Agent Team setup', 'pal.a.ready': 'Readiness check', 'pal.a.refresh': 'Refresh data', 'pal.a.stop': 'Stop the running turn',
      'pal.a.light': 'Light theme', 'pal.a.dark': 'Dark theme', 'pal.a.neon': 'Neon theme', 'pal.a.vi': 'Tiếng Việt', 'pal.a.en': 'English',
      'pal.current': 'current', 'pal.title': 'Command palette',
    },
  };
  M.addI18n('vi', L.vi);
  M.addI18n('en', L.en);
  const t = (k, v) => M.t(k, v);
  const has = f => (M.state.data?.features || []).includes(f);
  const byId = id => document.getElementById(id);
  const click = sel => () => document.querySelector(sel)?.click();
  const ws = () => M.ws || null;

  // ---------- fuzzy match ----------
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  // Subsequence score: consecutive characters and word starts score higher; -1 = no match.
  function score(q, text) {
    if (!q) return 0;
    const s = norm(text);
    let si = 0, total = 0, run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === ' ') { run = 0; continue; }
      const found = s.indexOf(c, si);
      if (found < 0) return -1;
      const wordStart = found === 0 || /[\s\-_/\\.·:]/.test(s[found - 1]);
      run = found === si ? run + 1 : 0;
      total += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(3, (found - si) * 0.05);
      si = found + 1;
    }
    if (s.startsWith(q)) total += 6;
    return total - s.length * 0.01;
  }

  // ---------- sources ----------
  const cache = new Map();
  async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    try { const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; } catch { return c?.v || []; }
  }
  const sources = [
    { id: 'actions', title: () => t('pal.g.actions'), items: async () => {
      const w = ws();
      const list = [
        { label: t('pal.a.ws'), run: () => M.showView('workspace'), when: () => !!w },
        { label: t('pal.a.dash'), run: () => M.showView('dashboard') },
        { label: t('pal.a.newAgent'), run: () => { M.showView('workspace'); w.openAgentEditor(null); }, when: () => !!w },
        { label: t('pal.a.newConv'), run: () => { M.showView('workspace'); w.newConversation(); }, when: () => !!w?.current().agent },
        { label: t('pal.a.team'), run: () => w.openTeamBuilder(), when: () => !!w?.openTeamBuilder },
        { label: t('pal.a.ready'), run: () => w.readiness(w.agents()), when: () => !!w?.readiness },
        { label: t('pal.a.stop'), run: () => w.stop(), when: () => !!w?.current().conversation?.active_job_id },
        { label: t('pal.a.refresh'), run: click('#refreshBtn'), keywords: 'reload refresh lam moi' },
        { label: t('pal.a.light'), run: click('[data-theme-pref="light"]'), keywords: 'theme' },
        { label: t('pal.a.dark'), run: click('[data-theme-pref="dark"]'), keywords: 'theme' },
        { label: t('pal.a.neon'), run: click('[data-theme-pref="neon"]'), keywords: 'theme' },
        { label: t('pal.a.vi'), run: click('#langVi'), keywords: 'language ngon ngu' },
        { label: t('pal.a.en'), run: click('#langEn'), keywords: 'language ngon ngu' },
      ];
      return list.filter(x => !x.when || x.when());
    } },
    { id: 'agents', title: () => t('pal.g.agents'), items: async () => {
      const w = ws(); if (!w) return [];
      const cur = w.current().agent?.id;
      return w.agents().map(a => ({ label: a.name, hint: [a.team_role, a.platform, a.id === cur ? t('pal.current') : ''].filter(Boolean).join(' · '), keywords: `${a.platform} ${a.team_role || ''} ${a.id}`, run: () => { M.showView('workspace'); w.selectAgent(a.id); } }));
    } },
    { id: 'convs', title: () => t('pal.g.convs'), items: async () => {
      const w = ws(); if (!w) return [];
      const list = await cached('convs', 10000, async () => (await w.get('chat_list')).conversations || []);
      const names = new Map(w.agents().map(a => [a.id, a.name]));
      return list.filter(c => c.kind !== 'handoff').slice(0, 200).map(c => ({ label: c.title || c.id, hint: names.get(c.agent_id) || '', keywords: names.get(c.agent_id) || '', run: () => w.openConversation(c.id) }));
    } },
    { id: 'projects', title: () => t('pal.g.projects'), items: async () => {
      const cur = M.project()?.path;
      return (M.state.data?.projects || []).map(p => ({ label: p.name, hint: p.path === cur ? t('pal.current') : p.path, keywords: p.path, run: () => selectProject(p.path) }));
    } },
    { id: 'templates', title: () => t('pal.g.templates'), items: async () => {
      const w = ws(); if (!w?.openTeamBuilder) return [];
      const list = await cached('tpl', 30000, async () => (await w.get('team_templates')).templates || []);
      return list.map(x => ({ label: x.name, hint: (x.team?.roles || []).map(r => r.name).join(', '), run: () => w.openTeamBuilder({ template: x.id }) }));
    } },
    { id: 'tasks', title: () => t('pal.g.tasks'), items: async () => {
      if (!has('tasks')) return [];
      const list = await cached('tasks', 10000, async () => { const d = await M.api('task_list'); return d.tasks || d.cards || []; });
      return list.slice(0, 200).map(x => ({ label: x.title || x.id, hint: [x.status, x.agent].filter(Boolean).join(' · '), keywords: x.prompt?.slice(0, 120) || '', run: () => { M.showView('tasks'); document.dispatchEvent(new CustomEvent('maw:task-open', { detail: { id: x.id } })); } }));
    } },
  ];
  // Same effect as the built-in project switcher (Request R1: MAW.selectProject).
  function selectProject(path) {
    if (typeof M.selectProject === 'function') { M.selectProject(path); return; }
    const sel = byId('projectSel'); if (!sel || sel.value === path) return;
    sel.value = path;
    sel.dispatchEvent(new Event('change'));
  }

  // ---------- UI ----------
  let dlg = null, input = null, list = null, items = [], active = 0, seq = 0, lastFocus = null;
  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'pal';
    dlg.setAttribute('aria-label', t('pal.title'));
    dlg.innerHTML = `<div class="pal-in"><input class="pal-q" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="palList" autocomplete="off" spellcheck="false">
      <div class="pal-list" id="palList" role="listbox"></div><div class="pal-foot"></div></div>`;
    input = dlg.querySelector('.pal-q');
    list = dlg.querySelector('.pal-list');
    input.addEventListener('input', () => { active = 0; refresh(); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('mousedown', e => { if (e.target.closest('.pal-i')) e.preventDefault(); });
    list.addEventListener('click', e => { const o = e.target.closest('.pal-i'); if (o) choose(+o.dataset.i); });
    list.addEventListener('mousemove', e => { const o = e.target.closest('.pal-i'); if (o && +o.dataset.i !== active) { active = +o.dataset.i; sync(); } });
    dlg.addEventListener('close', () => { lastFocus?.focus?.(); });
    dlg.addEventListener('mousedown', e => { if (e.target === dlg) close(); });
    document.body.appendChild(dlg);
  }
  function open() {
    if (!dlg) build();
    if (dlg.open) return;
    lastFocus = document.activeElement;
    input.placeholder = t('pal.ph');
    dlg.querySelector('.pal-foot').textContent = t('pal.hint');
    input.value = '';
    active = 0;
    dlg.showModal();
    input.focus();
    refresh();
  }
  function close() { if (dlg?.open) dlg.close(); }
  async function refresh() {
    const my = ++seq;
    const q = norm(input.value.trim());
    const groups = await Promise.all(sources.map(async s => {
      let its = [];
      try { its = await s.items(); } catch (e) { console.error('[palette]', s.id, e); }
      return { s, its };
    }));
    if (my !== seq) return;
    const out = [];
    for (const { s, its } of groups) {
      const scored = its.map(it => ({ it, sc: q ? Math.max(score(q, it.label), score(q, `${it.label} ${it.hint || ''} ${it.keywords || ''}`) - 2) : 0 }))
        .filter(x => x.sc >= 0);
      if (q) scored.sort((a, b) => b.sc - a.sc);
      const cap = q ? 12 : (s.id === 'actions' ? 8 : 5);
      for (const x of scored.slice(0, cap)) out.push({ ...x.it, group: s.title(), sc: x.sc });
    }
    // With a query, the best groups come first (by their best item).
    if (q) {
      const best = new Map();
      for (const x of out) best.set(x.group, Math.max(best.get(x.group) ?? -Infinity, x.sc));
      out.sort((a, b) => (best.get(b.group) - best.get(a.group)) || (b.sc - a.sc));
    }
    items = out.slice(0, 60);
    if (active >= items.length) active = 0;
    paint();
  }
  function paint() {
    if (!items.length) { list.innerHTML = `<div class="pal-empty">${esc(t('pal.none'))}</div>`; input.removeAttribute('aria-activedescendant'); return; }
    let html = '', g = '';
    items.forEach((it, i) => {
      if (it.group !== g) { g = it.group; html += `<div class="pal-g" role="presentation">${esc(g)}</div>`; }
      html += `<div class="pal-i" role="option" id="pal-o-${i}" data-i="${i}" aria-selected="${i === active}"><span class="pal-l">${esc(it.label)}</span>${it.hint ? `<span class="pal-h">${esc(it.hint)}</span>` : ''}</div>`;
    });
    list.innerHTML = html;
    sync();
  }
  function sync() {
    list.querySelectorAll('.pal-i').forEach(o => o.setAttribute('aria-selected', String(+o.dataset.i === active)));
    const o = byId('pal-o-' + active);
    if (o) { input.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); }
  }
  function onKey(e) {
    const n = items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (n) { active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; sync(); } }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); if (n) { active = Math.max(0, Math.min(n - 1, active + (e.key === 'PageDown' ? 8 : -8))); sync(); } }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); active = 0; sync(); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); active = Math.max(0, n - 1); sync(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  }
  function choose(i) {
    const it = items[i]; if (!it) return;
    lastFocus = null;
    close();
    try { const r = it.run(); if (r?.catch) r.catch(err => M.toast(err.message, 'err')); } catch (err) { M.toast(err.message, 'err'); }
  }

  // Capture phase on window: runs before index.html's document-level Ctrl+K (project switcher) and stops it.
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopImmediatePropagation();
      dlg?.open ? close() : open();
    }
  }, true);
  // The "Ctrl K" hint on the project button now means the palette.
  M.on('lang', () => { if (dlg) dlg.setAttribute('aria-label', t('pal.title')); });

  M.palette = {
    open, close,
    addSource(src) {
      if (!src || !/^[a-z][a-z0-9-]{1,31}$/.test(src.id || '') || typeof src.items !== 'function' || sources.some(s => s.id === src.id)) return;
      sources.push({ id: src.id, title: typeof src.title === 'function' ? src.title : () => String(src.title || src.id), items: src.items });
    },
  };
})();
