// S3 — MCP config manager (N14a) + one-click registration of the dashboard's own MCP server (N14b).
// Every write shows a diff first, asks for confirmation, and the server keeps a backup.
(() => {
  const M = window.MAW;
  if (!M) return;
  const { api, t, esc, toast } = M;
  const S3 = () => window.MAW_S3 || {};

  M.addI18n('vi', {
    s3mTab: 'MCP',
    s3mHint: 'Danh sách MCP server trong cấu hình của từng nền tảng. Mọi thay đổi đều xem diff trước, có xác nhận và tự sao lưu.',
    s3mReload: 'Tải lại', s3mNew: 'Thêm server', s3mRegister: 'Đăng ký MCP của dashboard',
    s3mNoFile: 'Chưa có file cấu hình', s3mNone: 'Chưa có MCP server.', s3mErr: 'Lỗi đọc: {err}', s3mReadonly: 'chỉ đọc',
    s3mEdit: 'Sửa', s3mToAll: 'Áp dụng cho mọi agent', s3mRemove: 'Xoá',
    s3mFormNew: 'MCP server mới', s3mFormEdit: 'Sửa "{name}"',
    s3mName: 'Tên', s3mTransport: 'Kiểu', s3mCommand: 'Lệnh', s3mArgs: 'Tham số (mỗi dòng một)', s3mUrl: 'URL', s3mEnv: 'Biến môi trường (KEY=value, mỗi dòng một)',
    s3mEnvHint: 'Giá trị đang có được che (••••). Giữ nguyên để không đổi.',
    s3mTargets: 'Áp dụng cho', s3mPreview: 'Xem diff', s3mApply: 'Áp dụng', s3mCancel: 'Huỷ',
    s3mDiffTitle: 'Thay đổi sẽ ghi', s3mNoChange: 'Không có thay đổi.',
    s3mConfirm: 'Ghi cấu hình MCP cho: {list}? File gốc sẽ được sao lưu.',
    s3mConfirmRm: 'Xoá MCP server "{name}" khỏi {list}? File gốc sẽ được sao lưu.',
    s3mClaudeWarn: 'Claude Code ghi ~/.claude.json liên tục: hãy đóng các phiên Claude Code trước khi áp dụng.',
    s3mApplied: '{platform}: đã ghi (backup {backup})', s3mUnchanged: '{platform}: không đổi', s3mFailed: '{platform}: {err}',
    s3mBadName: 'Tên chỉ gồm chữ, số, _ . - (tối đa 64 ký tự).', s3mNeedCmd: 'Cần lệnh (stdio) hoặc URL (http).', s3mNeedTarget: 'Chọn ít nhất một nền tảng.',
    s3mBackups: 'Bản sao lưu', s3mRestore: 'Khôi phục', s3mNoBackups: 'Chưa có bản sao lưu.',
    s3mRestoreAsk: 'Khôi phục {platform} từ {backup}? File hiện tại cũng sẽ được sao lưu trước.', s3mRestored: 'Đã khôi phục {platform}.',
    s3mHow: 'Đăng ký thủ công'
  });
  M.addI18n('en', {
    s3mTab: 'MCP',
    s3mHint: 'The MCP servers in each platform\'s config. Every change shows a diff first, asks for confirmation and keeps a backup.',
    s3mReload: 'Reload', s3mNew: 'Add server', s3mRegister: 'Register the dashboard MCP',
    s3mNoFile: 'No config file yet', s3mNone: 'No MCP servers.', s3mErr: 'Read error: {err}', s3mReadonly: 'read-only',
    s3mEdit: 'Edit', s3mToAll: 'Apply to all agents', s3mRemove: 'Remove',
    s3mFormNew: 'New MCP server', s3mFormEdit: 'Edit "{name}"',
    s3mName: 'Name', s3mTransport: 'Transport', s3mCommand: 'Command', s3mArgs: 'Arguments (one per line)', s3mUrl: 'URL', s3mEnv: 'Environment (KEY=value, one per line)',
    s3mEnvHint: 'Existing values are masked (••••). Leave them as they are to keep them.',
    s3mTargets: 'Apply to', s3mPreview: 'Preview diff', s3mApply: 'Apply', s3mCancel: 'Cancel',
    s3mDiffTitle: 'Changes to write', s3mNoChange: 'No changes.',
    s3mConfirm: 'Write the MCP config for: {list}? The original files are backed up.',
    s3mConfirmRm: 'Remove MCP server "{name}" from {list}? The original files are backed up.',
    s3mClaudeWarn: 'Claude Code rewrites ~/.claude.json all the time: close Claude Code sessions before applying.',
    s3mApplied: '{platform}: written (backup {backup})', s3mUnchanged: '{platform}: unchanged', s3mFailed: '{platform}: {err}',
    s3mBadName: 'Name: letters, digits, _ . - only (max 64).', s3mNeedCmd: 'A command (stdio) or a URL (http) is required.', s3mNeedTarget: 'Pick at least one platform.',
    s3mBackups: 'Backups', s3mRestore: 'Restore', s3mNoBackups: 'No backups yet.',
    s3mRestoreAsk: 'Restore {platform} from {backup}? The current file is backed up first.', s3mRestored: 'Restored {platform}.',
    s3mHow: 'Manual registration'
  });

  const PLAT_LABEL = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };
  const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  let cfg = null, backups = null, loading = false, panel = null, form = null; // form: { mode, server, targets }

  async function load() {
    if (loading) return;
    loading = true; paint();
    try {
      cfg = await api('mcp_config');
      try { backups = await api('mcp_backups'); } catch { backups = null; }
    } catch (e) { toast(e.message, 'err'); cfg = cfg || { platforms: [] }; }
    finally { loading = false; paint(); }
  }

  const platforms = () => cfg?.platforms || [];
  const writable = () => platforms().filter(p => p.writable !== false && !p.error).map(p => p.platform);

  function serverSummary(s) {
    return s.transport === 'http' ? s.url || '' : [s.command, ...(s.args || [])].join(' ');
  }

  function platformCard(p) {
    const head = `<div class="s3-m-ph"><b>${esc(PLAT_LABEL[p.platform] || p.platform)}</b>
      <span class="mono sub t-muted truncate" title="${esc(p.file || '')}">${esc(p.file || '')}</span>
      ${p.writable === false ? `<span class="badge">${esc(t('s3mReadonly'))}</span>` : ''}</div>`;
    if (p.error) return `<div class="s3-m-plat">${head}<p class="sub t-err">${esc(t('s3mErr', { err: p.error }))}</p></div>`;
    const list = (p.servers || []).map(s => `<div class="s3-m-srv">
        <div class="row" style="gap:6px;min-width:0"><b class="mono truncate">${esc(s.name)}</b><span class="badge">${esc(s.transport || 'stdio')}</span></div>
        <div class="mono sub t-muted s3-wrap">${esc(serverSummary(s))}</div>
        ${Object.keys(s.env || {}).length ? `<div class="sub t-muted" title="${esc(Object.keys(s.env).join('\n'))}">env: <span class="mono">${esc(Object.keys(s.env).slice(0, 3).join(', '))}${Object.keys(s.env).length > 3 ? ` +${Object.keys(s.env).length - 3}` : ''}</span></div>` : ''}
        <div class="s3-item-a"><button type="button" class="btn btn-sm" data-edit="${esc(p.platform)}|${esc(s.name)}">${esc(t('s3mEdit'))}</button>
          <button type="button" class="btn btn-sm" data-all="${esc(p.platform)}|${esc(s.name)}">${esc(t('s3mToAll'))}</button>
          <button type="button" class="btn btn-sm btn-danger" data-rm="${esc(p.platform)}|${esc(s.name)}">${esc(t('s3mRemove'))}</button></div>
      </div>`).join('');
    return `<div class="s3-m-plat">${head}${!p.exists ? `<p class="sub t-muted">${esc(t('s3mNoFile'))}</p>` : ''}${list || (p.exists ? `<p class="sub t-muted">${esc(t('s3mNone'))}</p>` : '')}</div>`;
  }

  const findServer = (platform, name) => platforms().find(p => p.platform === platform)?.servers?.find(s => s.name === name);

  function openForm(mode, server, targets) {
    form = { mode, server: structuredClone(server || { name: '', transport: 'stdio', command: '', args: [], env: {}, url: '' }), targets: targets || writable() };
    paint();
    panel.querySelector('[data-form] input[name="name"]')?.focus();
  }

  function readForm() {
    const f = panel.querySelector('[data-form]');
    const g = n => f.querySelector(`[name="${n}"]`);
    const env = {};
    for (const line of g('env').value.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    const transport = g('transport').value;
    const server = {
      ...(form.server.extra ? { extra: form.server.extra } : {}),
      name: g('name').value.trim(), transport,
      ...(transport === 'http' ? { url: g('url').value.trim() } : { command: g('command').value.trim(), args: g('args').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) }),
      env
    };
    const targets = [...f.querySelectorAll('[name="target"]:checked')].map(x => x.value);
    return { server, targets };
  }

  function validate(server, targets) {
    if (!NAME_RE.test(server.name)) return 's3mBadName';
    if (server.transport === 'http' ? !server.url : !server.command) return 's3mNeedCmd';
    if (!targets.length) return 's3mNeedTarget';
    return '';
  }

  // Diff preview per platform, then a confirm, then apply. `change` = { set?: [server], remove?: [name] }.
  async function previewAndApply(change, targets, label) {
    const diffs = [];
    for (const platform of targets) {
      try {
        const r = await api('mcp_preview', { platform, ...change });
        diffs.push({ platform, diff: r.diff || '', changed: r.changed !== false });
      } catch (e) { diffs.push({ platform, error: e.message }); }
    }
    const ov = S3().overlay ? S3().overlay(t('s3mDiffTitle'), 's3-ov-wide') : null;
    if (!ov) return;
    const changed = diffs.filter(d => d.changed && !d.error).map(d => d.platform);
    ov.body.innerHTML = `${targets.includes('claude') ? `<div class="callout t-warn">${esc(t('s3mClaudeWarn'))}</div>` : ''}
      ${diffs.map(d => `<div class="s3-stack"><b>${esc(PLAT_LABEL[d.platform] || d.platform)}</b>
        ${d.error ? `<p class="sub t-err">${esc(d.error)}</p>` : !d.changed ? `<p class="sub t-muted">${esc(t('s3mNoChange'))}</p>` : `<pre class="code s3-diff">${diffHtml(d.diff)}</pre>`}</div>`).join('')}
      <div class="row-wrap" style="gap:6px;justify-content:flex-end"><button type="button" class="btn btn-sm" data-x>${esc(t('s3mCancel'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-go ${changed.length ? '' : 'disabled'}>${esc(t('s3mApply'))}</button></div>`;
    ov.body.querySelector('[data-go]').onclick = async () => {
      const list = changed.map(p => PLAT_LABEL[p] || p).join(', ');
      if (!confirm(label ? t('s3mConfirmRm', { name: label, list }) : t('s3mConfirm', { list }))) return;
      try {
        const r = await api('mcp_apply', { platforms: changed, ...change, confirm: true });
        for (const x of r.results || []) {
          const p = PLAT_LABEL[x.platform] || x.platform;
          if (x.error) toast(t('s3mFailed', { platform: p, err: x.error }), 'err');
          else toast(x.changed ? t('s3mApplied', { platform: p, backup: x.backup || '—' }) : t('s3mUnchanged', { platform: p }), x.changed ? 'ok' : 'info');
        }
        ov.close(); form = null; load();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function diffHtml(diff) {
    return String(diff).split('\n').map(l => {
      const c = l.startsWith('+++') || l.startsWith('---') ? 's3-d-h' : l.startsWith('@@') ? 's3-d-at' : l.startsWith('+') ? 's3-d-add' : l.startsWith('-') ? 's3-d-del' : '';
      return `<span class="${c}">${esc(l)}</span>`;
    }).join('\n');
  }

  function formHtml() {
    if (!form) return '';
    const s = form.server;
    const all = platforms().map(p => p.platform);
    const env = Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    return `<form class="s3-m-form card" data-form autocomplete="off">
      <div class="card-h"><h2>${esc(form.mode === 'edit' ? t('s3mFormEdit', { name: s.name }) : t('s3mFormNew'))}</h2></div>
      <div class="card-b s3-m-grid">
        <label><span class="sub">${esc(t('s3mName'))}</span><input class="input mono" name="name" value="${esc(s.name)}" maxlength="64" ${form.mode === 'edit' ? 'readonly' : ''} required></label>
        <label><span class="sub">${esc(t('s3mTransport'))}</span><select class="input" name="transport"><option value="stdio"${s.transport !== 'http' ? ' selected' : ''}>stdio</option><option value="http"${s.transport === 'http' ? ' selected' : ''}>http</option></select></label>
        <label class="s3-m-stdio"><span class="sub">${esc(t('s3mCommand'))}</span><input class="input mono" name="command" value="${esc(s.command || '')}"></label>
        <label class="s3-m-stdio s3-m-wide"><span class="sub">${esc(t('s3mArgs'))}</span><textarea class="input mono" name="args" rows="3">${esc((s.args || []).join('\n'))}</textarea></label>
        <label class="s3-m-http s3-m-wide"><span class="sub">${esc(t('s3mUrl'))}</span><input class="input mono" name="url" value="${esc(s.url || '')}" placeholder="http://127.0.0.1:…/mcp"></label>
        <label class="s3-m-wide"><span class="sub">${esc(t('s3mEnv'))}</span><textarea class="input mono" name="env" rows="2" spellcheck="false">${esc(env)}</textarea><span class="sub t-muted">${esc(t('s3mEnvHint'))}</span></label>
        <fieldset class="s3-m-wide s3-m-targets"><legend class="sub">${esc(t('s3mTargets'))}</legend>
          ${all.map(p => `<label class="btn btn-sm btn-toggle"><input type="checkbox" name="target" value="${esc(p)}" ${form.targets.includes(p) ? 'checked' : ''} ${writable().includes(p) ? '' : 'disabled'}><span>${esc(PLAT_LABEL[p] || p)}</span></label>`).join('')}
        </fieldset>
        <div class="s3-m-wide row-wrap" style="gap:6px;justify-content:flex-end"><button type="button" class="btn btn-sm" data-cancel>${esc(t('s3mCancel'))}</button><button type="button" class="btn btn-sm btn-primary" data-preview>${esc(t('s3mPreview'))}</button></div>
      </div></form>`;
  }

  function backupsHtml() {
    const list = backups?.backups || backups?.items || [];
    if (!list.length) return `<p class="sub t-muted">${esc(t('s3mNoBackups'))}</p>`;
    return `<div class="table-wrap" style="max-height:240px"><table><tbody>${list.slice(0, 30).map(b => `<tr>
      <td>${esc(PLAT_LABEL[b.platform] || b.platform)}</td><td class="mono">${esc(b.filename || b.name || b.backup)}</td><td class="t-muted">${esc(S3().dateTime ? S3().dateTime(b.created_at || b.mtime) : '')}</td>
      <td class="num"><button type="button" class="btn btn-sm" data-restore="${esc(b.platform)}|${esc(b.filename || b.name || b.backup)}">${esc(t('s3mRestore'))}</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function howHtml() {
    const d = cfg?.dashboard_server;
    if (!d) return '';
    const cmd = [d.command, ...(d.args || [])].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
    const url = d.env?.MAW_URL || '';
    return `<details class="s3-cmds"><summary class="sub">${esc(t('s3mHow'))}</summary><pre class="code">claude mcp add maw${url ? ` -e MAW_URL=${esc(url)}` : ''} -- ${esc(cmd)}

# ~/.codex/config.toml
[mcp_servers.maw]
command = ${esc(JSON.stringify(d.command))}
args = ${esc(JSON.stringify(d.args || []))}${url ? `\nenv = { MAW_URL = ${esc(JSON.stringify(url))} }` : ''}

# ~/.gemini/settings.json → "mcpServers"
"maw": ${esc(JSON.stringify({ command: d.command, args: d.args || [], ...(url ? { env: { MAW_URL: url } } : {}) }))}</pre></details>`;
  }

  function paint() {
    if (!panel) return;
    if (!panel.dataset.s3) {
      panel.dataset.s3 = '1';
      panel.innerHTML = `<div class="s3">
        <section class="s3-sec"><div class="s3-sec-h"><p class="sub t-muted" data-k="s3mHint"></p>
          <div class="s3-tools"><button type="button" class="btn btn-sm" data-reload></button><button type="button" class="btn btn-sm" data-register></button><button type="button" class="btn btn-sm btn-primary" data-new></button></div></div>
          <div data-formbox></div><div class="s3-m-plats" data-plats></div><div data-how></div></section>
        <section class="s3-sec"><div class="s3-sec-h"><h2 data-k="s3mBackups"></h2></div><div data-backups></div></section></div>`;
      panel.addEventListener('click', async e => {
        const b = e.target.closest('button');
        if (!b) return;
        const [pl, name] = (b.dataset.edit || b.dataset.all || b.dataset.rm || b.dataset.restore || '').split('|');
        if (b.hasAttribute('data-reload')) load();
        else if (b.hasAttribute('data-new')) openForm('new');
        else if (b.hasAttribute('data-register')) { const d = cfg?.dashboard_server; if (d) openForm('new', { name: 'maw', transport: 'stdio', command: d.command, args: d.args || [], env: d.env || {} }); }
        else if (b.dataset.edit) { const s = findServer(pl, name); if (s) openForm('edit', s, [pl]); }
        // The server copies the source entry unmasked (copy_from); the UI only ever holds masked env values.
        else if (b.dataset.all) { const targets = writable().filter(p => p !== pl); if (findServer(pl, name) && targets.length) previewAndApply({ copy_from: { platform: pl, name } }, targets); }
        else if (b.dataset.rm) previewAndApply({ remove: [name] }, [pl], name);
        else if (b.dataset.restore) {
          if (!confirm(t('s3mRestoreAsk', { platform: PLAT_LABEL[pl] || pl, backup: name }))) return;
          try { await api('mcp_restore', { platform: pl, backup: name, confirm: true }); toast(t('s3mRestored', { platform: PLAT_LABEL[pl] || pl }), 'ok'); load(); }
          catch (err) { toast(err.message, 'err'); }
        }
        else if (b.hasAttribute('data-cancel')) { form = null; paint(); }
        else if (b.hasAttribute('data-preview')) {
          const { server, targets } = readForm();
          const bad = validate(server, targets);
          if (bad) { toast(t(bad), 'warn'); return; }
          form.server = server; form.targets = targets;
          previewAndApply({ set: [server] }, targets);
        }
      });
      panel.addEventListener('change', e => { if (e.target.name === 'transport') syncTransport(); });
      panel.addEventListener('submit', e => e.preventDefault());
    }
    for (const n of panel.querySelectorAll('[data-k]')) n.textContent = t(n.dataset.k);
    panel.querySelector('[data-reload]').textContent = t('s3mReload');
    panel.querySelector('[data-reload]').disabled = loading;
    panel.querySelector('[data-register]').textContent = t('s3mRegister');
    panel.querySelector('[data-register]').disabled = !cfg?.dashboard_server;
    panel.querySelector('[data-new]').textContent = t('s3mNew');
    const fb = panel.querySelector('[data-formbox]');
    if (!form) fb.innerHTML = '';
    else if (!fb.querySelector('[data-form]')) { fb.innerHTML = formHtml(); syncTransport(); }
    panel.querySelector('[data-plats]').innerHTML = cfg ? platforms().map(platformCard).join('') : `<div class="empty">…</div>`;
    panel.querySelector('[data-how]').innerHTML = howHtml();
    panel.querySelector('[data-backups]').innerHTML = backupsHtml();
  }
  function syncTransport() {
    const f = panel.querySelector('[data-form]');
    if (!f) return;
    const http = f.querySelector('[name="transport"]').value === 'http';
    for (const el of f.querySelectorAll('.s3-m-stdio')) el.classList.toggle('hidden', http);
    for (const el of f.querySelectorAll('.s3-m-http')) el.classList.toggle('hidden', !http);
  }

  M.addTab({
    id: 'mcp',
    title: () => t('s3mTab'),
    render(p) {
      const first = !panel;
      panel = p;
      if (first) paint();
    }
  });
  document.querySelector('#tabsCard [data-tab="mcp"]')?.addEventListener('click', () => { if (!cfg) load(); });
  if (document.querySelector('[data-panel="mcp"]') && !document.querySelector('[data-panel="mcp"]').classList.contains('hidden')) load();
  M.on('lang', () => { if (panel) { const keep = form; form = null; paint(); form = keep; paint(); } });
})();
