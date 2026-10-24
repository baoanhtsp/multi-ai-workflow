import fs from 'node:fs';
import path from 'node:path';
import { estimateEntryTelemetry, type AuditLogRow } from '../../lib/audit.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import type { LoadedRegistry } from '../../lib/registry.ts';
import { readJobMetasAsEvents, readTimelineEvents, type TimelineEvent } from './events.ts';

export interface TimelineItem {
  id: string;
  kind: 'job' | 'handoff' | 'custom';
  title: string;
  mode: string;
  role: string;
  project_name: string;
  project_path?: string;
  start: string;
  end: string | null;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | string;
  exit_code: number | null;
  cost_usd: number;
  tokens: { in: number; out: number };
  score: string | null;
  verdict: string | null;
  sub?: boolean;
}

export function normalizeProjectPath(p?: string): string {
  if (!p) return '';
  return path.win32.resolve(p).toLowerCase().replace(/[/\\]+$/, '');
}

export interface TimelineLane {
  agent: string;
  label: string;
  color: string;
  items: TimelineItem[];
}

export interface TimelineData {
  from: string;
  to: string;
  lanes: TimelineLane[];
  totals: {
    jobs: number;
    done: number;
    failed: number;
    cost_usd: number;
    busy_ms: number;
  };
}

function parseAuditRows(auditFile: string): AuditLogRow[] {
  if (!isFileSafe(auditFile)) {
    return [];
  }
  const rows: AuditLogRow[] = [];
  try {
    const content = fs.readFileSync(auditFile, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as AuditLogRow;
        rows.push(row);
      } catch {
        // Ignore
      }
    }
  } catch {
    return [];
  }
  return rows;
}

export function buildTimeline(
  paths: ServerPaths,
  registry: LoadedRegistry,
  options?: {
    from?: string;
    to?: string;
    project?: string;
    job_id?: string;
  }
): TimelineData {
  const now = new Date();
  let toDate = now;
  let fromDate = new Date(now.getTime() - 24 * 3600 * 1000); // Default last 24h

  if (options?.to) {
    const parsedTo = new Date(options.to);
    if (!Number.isNaN(parsedTo.getTime())) {
      toDate = parsedTo;
    }
  }

  if (options?.from) {
    const parsedFrom = new Date(options.from);
    if (!Number.isNaN(parsedFrom.getTime())) {
      fromDate = parsedFrom;
    }
  }

  // Max window: 31 days
  const maxWindowMs = 31 * 24 * 3600 * 1000;
  if (toDate.getTime() - fromDate.getTime() > maxWindowMs) {
    fromDate = new Date(toDate.getTime() - maxWindowMs);
  }

  // Combine event stream and jobsDir meta snapshot
  const rawEvents = readTimelineEvents(paths);
  const metaEvents = readJobMetasAsEvents(paths.jobsDir);
  const allEvents = [...rawEvents, ...metaEvents];

  // If job_id is given, narrow window to that job
  if (options?.job_id) {
    const jobEvents = allEvents.filter((ev) => ev.job_id === options.job_id);
    if (jobEvents.length > 0) {
      let minStart = Infinity;
      let maxEnd = 0;
      for (const ev of jobEvents) {
        const t = new Date(ev.ts).getTime();
        if (t < minStart) minStart = t;
        if (t > maxEnd) maxEnd = t;
      }
      if (minStart !== Infinity) {
        fromDate = new Date(minStart - 60000);
        toDate = new Date(Math.max(Date.now(), maxEnd + 60000));
      }
    }
  }

  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();

  // Load audit rows for telemetry matching
  const auditRows = parseAuditRows(paths.auditFile);
  const normFilterProject = options?.project ? normalizeProjectPath(options.project) : undefined;

  // Group events by job_id or handoff id
  const itemsMap = new Map<string, TimelineItem>();
  const multiToolSubItems: Array<{ laneAgent: string; item: TimelineItem }> = [];

  for (const ev of allEvents) {
    const evTime = new Date(ev.ts).getTime();
    if (Number.isNaN(evTime) || evTime < fromMs - 60000 || evTime > toMs + 60000) {
      continue;
    }

    if (normFilterProject) {
      if (!ev.project) {
        continue;
      }
      if (normalizeProjectPath(ev.project) !== normFilterProject) {
        continue;
      }
    }

    const key = ev.job_id || `${ev.event}_${ev.ts}_${ev.agent}`;
    let item = itemsMap.get(key);
    if (!item) {
      const projPath = ev.project ?? '';
      const projName = projPath ? path.basename(projPath) : 'unknown';
      item = {
        id: key,
        kind: ev.event === 'handoff' ? 'handoff' : 'job',
        title: ev.title || `${ev.role ?? 'task'} (${key})`,
        mode: ev.mode || 'task',
        role: ev.role || 'backend',
        project_name: projName,
        project_path: projPath,
        start: ev.start || ev.ts,
        end: ev.end ?? null,
        status: (ev.status as any) || 'RUNNING',
        exit_code: ev.exit_code ?? null,
        cost_usd: ev.cost_usd ?? 0,
        tokens: { in: 0, out: 0 },
        score: null,
        verdict: null,
      };
      itemsMap.set(key, item);
    } else {
      if (ev.end) item.end = ev.end;
      if (ev.status && ev.status !== 'RUNNING') item.status = ev.status;
      if (ev.exit_code !== undefined && ev.exit_code !== null) item.exit_code = ev.exit_code;
    }
  }

  // Join audit rows: WorkDir equals job project and Timestamp within [start, end + 5s]
  for (const [jobId, item] of itemsMap.entries()) {
    const itemStartMs = new Date(item.start).getTime();
    const itemEndMs = item.end ? new Date(item.end).getTime() + 5000 : Date.now() + 5000;
    const normItemProj = item.project_path ? normalizeProjectPath(item.project_path) : '';

    const matchedAudit = auditRows.filter((row) => {
      if (normItemProj && row.WorkDir && normalizeProjectPath(row.WorkDir) !== normItemProj) {
        return false;
      }
      const rowMs = new Date(row.Timestamp).getTime();
      return rowMs >= itemStartMs && rowMs <= itemEndMs;
    });

    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let lastScore: string | null = null;
    let lastVerdict: string | null = null;

    let prevSubEnd = item.start;
    for (const row of matchedAudit) {
      const telem = estimateEntryTelemetry(row as unknown as Record<string, unknown>);
      totalCost += telem.cost_usd;
      totalIn += telem.in_tokens;
      totalOut += telem.out_tokens;
      if (row.Score) lastScore = row.Score;
      if (row.Verdict) lastVerdict = row.Verdict;

      // If this is a team / council / auto-gate job, create a sub-item on that tool's lane
      if (item.mode === 'team' || item.mode === 'council' || item.mode === 'auto-gate') {
        const toolId = String(row.Tool ?? 'claude').toLowerCase();
        const subItem: TimelineItem = {
          id: `${jobId}_${toolId}_${row.Timestamp}`,
          kind: 'job',
          title: `${row.Role || 'reviewer'} (in ${jobId})`,
          mode: item.mode,
          role: row.Role || 'reviewer',
          project_name: item.project_name,
          start: prevSubEnd,
          end: row.Timestamp,
          status: row.Verdict === 'CHANGES_REQUESTED' ? 'FAILED' : 'DONE',
          exit_code: row.Verdict === 'CHANGES_REQUESTED' ? 1 : 0,
          cost_usd: telem.cost_usd,
          tokens: { in: telem.in_tokens, out: telem.out_tokens },
          score: row.Score || null,
          verdict: row.Verdict || null,
          sub: true, // Mark sub-item from audit row (Round 3 Item 9)
        };
        prevSubEnd = row.Timestamp;
        multiToolSubItems.push({ laneAgent: toolId, item: subItem });
      }
    }

    if (totalCost > 0) item.cost_usd = totalCost;
    item.tokens = { in: totalIn, out: totalOut };
    item.score = lastScore;
    item.verdict = lastVerdict;
  }

  // Group items into lanes
  const laneMap = new Map<string, TimelineLane>();

  // Initialize lanes from registry
  for (const agent of registry.agents) {
    laneMap.set(agent.id.toLowerCase(), {
      agent: agent.id,
      label: agent.label,
      color: agent.color || '#4285f4',
      items: [],
    });
  }

  // Helper to get or create lane
  function getLane(agentId: string): TimelineLane {
    const norm = agentId.toLowerCase();
    let lane = laneMap.get(norm);
    if (!lane) {
      lane = {
        agent: agentId,
        label: agentId,
        color: '#6c757d',
        items: [],
      };
      laneMap.set(norm, lane);
    }
    return lane;
  }

  // Distribute main items
  for (const item of itemsMap.values()) {
    // Find agent for item from allEvents
    const ev = allEvents.find((e) => e.job_id === item.id);
    const agentId = ev?.agent || 'claude';
    getLane(agentId).items.push(item);
  }

  // Distribute multi-tool sub-items
  for (const sub of multiToolSubItems) {
    getLane(sub.laneAgent).items.push(sub.item);
  }

  // Calculate totals
  let totalJobs = 0;
  let doneCount = 0;
  let failedCount = 0;
  let totalCostUsd = 0;
  let busyMs = 0;

  for (const lane of laneMap.values()) {
    // Sort items by start time
    lane.items.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    for (const it of lane.items) {
      if (it.sub) {
        // Skip sub-items in totals calculation to avoid double-counting (Round 3 Item 9)
        continue;
      }
      totalJobs++;
      if (it.status === 'DONE') doneCount++;
      else if (it.status === 'FAILED') failedCount++;
      totalCostUsd += it.cost_usd;
      const s = new Date(it.start).getTime();
      const e = it.end ? new Date(it.end).getTime() : now.getTime();
      if (e > s) {
        busyMs += e - s;
      }
    }
  }

  const lanesArray = Array.from(laneMap.values()).filter((l) => l.items.length > 0 || registry.agents.some((a) => a.id === l.agent));

  return {
    from: fromIso,
    to: toIso,
    lanes: lanesArray,
    totals: {
      jobs: totalJobs,
      done: doneCount,
      failed: failedCount,
      cost_usd: totalCostUsd,
      busy_ms: busyMs,
    },
  };
}

export async function generateTimelineReport(
  paths: ServerPaths,
  registry: LoadedRegistry,
  options: {
    format: 'md' | 'html';
    from?: string;
    to?: string;
    project?: string;
    job_id?: string;
  }
): Promise<{ filename: string; mime: string; content: string }> {
  const data = buildTimeline(paths, registry, options);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = options.format === 'html' ? 'html' : 'md';
  const filename = `maw-report-${stamp}.${ext}`;
  const mime = options.format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';

  // Changed files via git log if project given and is git repo
  const changedFiles: string[] = [];
  if (options.project && isDirectorySafe(options.project)) {
    const gitDir = path.join(options.project, '.git');
    if (isDirectorySafe(gitDir) || isFileSafe(gitDir)) {
      const gitRes = await runCommand(
        'git.exe',
        [
          'log',
          `--since=${data.from}`,
          `--until=${data.to}`,
          '--name-only',
          '--pretty=format:',
        ],
        { cwd: options.project, timeoutMs: 5000 }
      );
      if (gitRes.code === 0 && gitRes.stdout) {
        const rawFiles = gitRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const unique = Array.from(new Set(rawFiles)).slice(0, 300);
        changedFiles.push(...unique);
      }
    }
  }

  // Audit review rows: filter by project AND [from, to] window (Round 3 Item 5)
  const fromMs = new Date(data.from).getTime();
  const toMs = new Date(data.to).getTime();
  const normReportProj = options.project ? normalizeProjectPath(options.project) : undefined;

  const auditRows = parseAuditRows(paths.auditFile);
  const reviewerRows = auditRows.filter((r) => {
    if (r.Role !== 'reviewer' && !r.Score && !r.Verdict) {
      return false;
    }
    const t = new Date(r.Timestamp).getTime();
    if (Number.isNaN(t) || t < fromMs || t > toMs) {
      return false;
    }
    if (normReportProj) {
      if (!r.WorkDir) return false;
      if (normalizeProjectPath(r.WorkDir) !== normReportProj) {
        return false;
      }
    }
    return true;
  });

  if (options.format === 'md') {
    const lines: string[] = [];
    lines.push(`# Multi-AI Mission Control Report`);
    lines.push(`**Generated:** ${now.toISOString()}`);
    lines.push(`**Window:** ${data.from} → ${data.to}`);
    lines.push('');
    lines.push(`## 1. Summary`);
    lines.push(`- **Total Jobs:** ${data.totals.jobs}`);
    lines.push(`- **Successful (DONE):** ${data.totals.done}`);
    lines.push(`- **Failed:** ${data.totals.failed}`);
    lines.push(`- **Total Cost:** $${data.totals.cost_usd.toFixed(4)}`);
    lines.push(`- **Total Busy Time:** ${(data.totals.busy_ms / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push(`## 2. Per-Agent Statistics`);
    lines.push(`| Agent | Total Jobs | Done | Failed | Cost |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const lane of data.lanes) {
      const d = lane.items.filter((i) => i.status === 'DONE').length;
      const f = lane.items.filter((i) => i.status === 'FAILED').length;
      const c = lane.items.reduce((acc, i) => acc + i.cost_usd, 0);
      lines.push(`| ${lane.label} | ${lane.items.length} | ${d} | ${f} | $${c.toFixed(4)} |`);
    }
    lines.push('');
    lines.push(`## 3. Job Execution List`);
    for (const lane of data.lanes) {
      if (lane.items.length === 0) continue;
      lines.push(`### Lane: ${lane.label}`);
      for (const it of lane.items) {
        const scoreStr = it.score ? ` (Score: ${it.score}, Verdict: ${it.verdict ?? 'N/A'})` : '';
        lines.push(`- **[${it.status}]** ${it.title} — Start: ${it.start}, End: ${it.end ?? 'RUNNING'}, Cost: $${it.cost_usd.toFixed(4)}${scoreStr}`);
      }
    }
    lines.push('');
    lines.push(`## 4. Reviewer Scores`);
    if (reviewerRows.length === 0) {
      lines.push(`_No reviewer scores recorded in this window._`);
    } else {
      lines.push(`| Timestamp | Tool | Score | Verdict |`);
      lines.push(`| :--- | :--- | :--- | :--- |`);
      for (const r of reviewerRows.slice(0, 50)) {
        lines.push(`| ${r.Timestamp} | ${r.Tool} | ${r.Score || '—'} | ${r.Verdict || '—'} |`);
      }
    }
    lines.push('');
    lines.push(`## 5. Files Changed (${changedFiles.length})`);
    if (changedFiles.length === 0) {
      lines.push(`_No files changed or project not specified._`);
    } else {
      for (const f of changedFiles) {
        lines.push(`- \`${f}\``);
      }
    }

    return { filename, mime, content: lines.join('\n') };
  }

  // HTML format: self-contained, escaped, inline CSS, no scripts
  function esc(s: unknown): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(filename)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 32px; color: #1f2937; line-height: 1.5; background: #f9fafb; }
.card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
h1, h2, h3 { color: #111827; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
th { background: #f3f4f6; font-weight: 600; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.badge-done { background: #def7ec; color: #03543f; }
.badge-failed { background: #fde8e8; color: #9b1c1c; }
.badge-running { background: #e1effe; color: #1e429f; }
ul { padding-left: 20px; }
code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
</style>
</head>
<body>
<div class="card">
  <h1>Multi-AI Mission Control Report</h1>
  <p><strong>Generated:</strong> ${esc(now.toISOString())} · <strong>Window:</strong> ${esc(data.from)} → ${esc(data.to)}</p>
  <div style="display: flex; gap: 24px; margin-top: 16px;">
    <div><strong>Total Jobs:</strong> ${esc(data.totals.jobs)}</div>
    <div><strong>Done:</strong> <span class="badge badge-done">${esc(data.totals.done)}</span></div>
    <div><strong>Failed:</strong> <span class="badge badge-failed">${esc(data.totals.failed)}</span></div>
    <div><strong>Cost:</strong> $${esc(data.totals.cost_usd.toFixed(4))}</div>
    <div><strong>Busy Time:</strong> ${esc((data.totals.busy_ms / 1000).toFixed(1))}s</div>
  </div>
</div>

<div class="card">
  <h2>Per-Agent Statistics</h2>
  <table>
    <thead><tr><th>Agent</th><th>Total Jobs</th><th>Done</th><th>Failed</th><th>Cost</th></tr></thead>
    <tbody>
      ${data.lanes
        .map((l) => {
          const d = l.items.filter((i) => i.status === 'DONE').length;
          const f = l.items.filter((i) => i.status === 'FAILED').length;
          const c = l.items.reduce((acc, i) => acc + i.cost_usd, 0);
          return `<tr><td><strong>${esc(l.label)}</strong></td><td>${esc(l.items.length)}</td><td>${esc(d)}</td><td>${esc(f)}</td><td>$${esc(c.toFixed(4))}</td></tr>`;
        })
        .join('')}
    </tbody>
  </table>
</div>

<div class="card">
  <h2>Jobs List</h2>
  ${data.lanes
    .filter((l) => l.items.length > 0)
    .map(
      (l) => `
    <h3>${esc(l.label)}</h3>
    <table>
      <thead><tr><th>Status</th><th>Title</th><th>Start</th><th>End</th><th>Cost</th><th>Review</th></tr></thead>
      <tbody>
        ${l.items
          .map(
            (it) => `
          <tr>
            <td><span class="badge ${it.status === 'DONE' ? 'badge-done' : it.status === 'FAILED' ? 'badge-failed' : 'badge-running'}">${esc(it.status)}</span></td>
            <td>${esc(it.title)}</td>
            <td>${esc(it.start)}</td>
            <td>${esc(it.end ?? 'RUNNING')}</td>
            <td>$${esc(it.cost_usd.toFixed(4))}</td>
            <td>${esc(it.score ? `${it.score} (${it.verdict})` : '—')}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `
    )
    .join('')}
</div>

<div class="card">
  <h2>Files Changed (${esc(changedFiles.length)})</h2>
  ${
    changedFiles.length === 0
      ? '<p><em>No files changed or project not specified.</em></p>'
      : `<ul>${changedFiles.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
  }
</div>
</body>
</html>`;

  return { filename, mime, content: html };
}
