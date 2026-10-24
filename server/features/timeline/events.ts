import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';

export type TimelineEventType = 'job-start' | 'job-finish' | 'handoff' | 'custom';

export interface TimelineEvent {
  ts: string;
  event: TimelineEventType;
  job_id?: string;
  mode?: string;
  agent: string;
  role?: string;
  project?: string;
  exit_code?: number | null;
  status?: 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | string;
  title?: string;
  start?: string;
  end?: string | null;
  cost_usd?: number;
  ref?: Record<string, unknown>;
}

export function appendTimelineEvent(paths: ServerPaths, event: TimelineEvent): void {
  const dataDir = paths.featureDataDir('timeline');
  const eventsFile = path.win32.join(dataDir, 'events.jsonl');

  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(eventsFile, line, 'utf8');

  // Check rotation: if file > 5 MB, keep newest 20000 lines
  try {
    const st = fs.statSync(eventsFile);
    if (st.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(eventsFile, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim() !== '');
      if (lines.length > 20000) {
        const kept = lines.slice(lines.length - 20000).join('\n') + '\n';
        const tempFile = `${eventsFile}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempFile, kept, 'utf8');
        fs.renameSync(tempFile, eventsFile);
      }
    }
  } catch {
    // Ignore rotation error
  }
}

export function readTimelineEvents(paths: ServerPaths): TimelineEvent[] {
  const dataDir = paths.featureDataDir('timeline');
  const eventsFile = path.win32.join(dataDir, 'events.jsonl');
  if (!isFileSafe(eventsFile)) {
    return [];
  }

  const events: TimelineEvent[] = [];
  try {
    const raw = fs.readFileSync(eventsFile, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      // Strip leading UTF-8 BOM if present (\uFEFF)
      if (trimmed.charCodeAt(0) === 0xFEFF) {
        trimmed = trimmed.slice(1).trim();
      }
      try {
        const ev = JSON.parse(trimmed) as TimelineEvent;
        events.push(ev);
      } catch {
        // Ignore malformed line
      }
    }
  } catch {
    return [];
  }
  return events;
}

export function readJobMetasAsEvents(jobsDir: string): TimelineEvent[] {
  if (!isDirectorySafe(jobsDir)) {
    return [];
  }
  const events: TimelineEvent[] = [];
  try {
    const files = fs.readdirSync(jobsDir).filter((f) => f.startsWith('job_') && f.endsWith('.json'));
    for (const f of files) {
      const p = path.win32.join(jobsDir, f);
      try {
        const meta = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
        const jobId = String(meta.job_id ?? f.replace(/\.json$/, ''));
        const startedAt = String(meta.started_at ?? new Date(Number(meta.started_ts ?? 0) * 1000).toISOString());
        const finishedAt = meta.finished_at ? String(meta.finished_at) : null;
        const status = String(meta.status ?? 'UNKNOWN');
        const agent = String(meta.agent ?? meta.mode ?? 'agent');

        events.push({
          ts: startedAt,
          event: 'job-start',
          job_id: jobId,
          mode: meta.mode as string,
          agent,
          role: meta.role as string,
          project: meta.project_path as string,
          status: 'RUNNING',
          start: startedAt,
        });

        if (status !== 'RUNNING') {
          events.push({
            ts: finishedAt ?? startedAt,
            event: 'job-finish',
            job_id: jobId,
            mode: meta.mode as string,
            agent,
            role: meta.role as string,
            project: meta.project_path as string,
            status,
            exit_code: typeof meta.exit_code === 'number' ? meta.exit_code : null,
            end: finishedAt,
          });
        }
      } catch {
        // Ignore single corrupt job file
      }
    }
  } catch {
    // Ignore read directory error
  }
  return events;
}
