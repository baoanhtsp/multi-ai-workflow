import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';

export interface ReviewSessionVerdict {
  verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  score: number;
  note: string;
  ts: string;
}

export interface ReviewComment {
  id: string;
  path: string;
  line: number;
  side: 'new' | 'old';
  quote: string;
  body: string;
  created_at: string;
  updated_at: string;
  resolved: boolean;
  sent_at: string | null;
}

export interface ReviewSessionState {
  file: 'accepted' | 'rejected' | null;
  hunks: Record<string, 'accepted' | 'rejected'>;
}

export interface ReviewSession {
  review_key: string;
  project_path: string;
  source: string;
  ref: string;
  base: string;
  created_at: string;
  updated_at: string;
  states: Record<string, ReviewSessionState>;
  comments: ReviewComment[];
  verdict: ReviewSessionVerdict | null;
  fix_jobs: string[];
}

export interface ReviewAuditEntry {
  ts: string;
  action: string;
  project_path: string;
  source: string;
  ref: string;
  path: string;
  hunk_id: string | null;
  snapshot_ref: string | null;
  ok: boolean;
  error?: string;
}

export interface ReviewVerdictEntry {
  ts: string;
  job_id: string;
  agent?: string;
  role?: string;
  model?: string;
  project_path: string;
  verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  score: number;
  note: string;
  reviewer: string;
}

export function computeReviewKey(
  projectPath: string,
  source: string,
  ref: string,
  base: string
): string {
  const norm = `${projectPath.toLowerCase()}|${source}|${ref}|${base}`;
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export function getSessionFilePath(reviewKey: string, paths: ServerPaths): string {
  const baseDir = paths.featureDataDir('review');
  const sessionsDir = path.win32.join(baseDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  return path.win32.join(sessionsDir, `${reviewKey}.json`);
}

export function loadReviewSession(
  reviewKey: string,
  projectPath: string,
  source: string,
  ref: string,
  base: string,
  paths: ServerPaths
): ReviewSession {
  const filePath = getSessionFilePath(reviewKey, paths);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ReviewSession>;
      return {
        review_key: reviewKey,
        project_path: projectPath,
        source: parsed.source ?? source,
        ref: parsed.ref ?? ref,
        base: parsed.base ?? base,
        created_at: parsed.created_at ?? new Date().toISOString(),
        updated_at: parsed.updated_at ?? new Date().toISOString(),
        states: parsed.states ?? {},
        comments: Array.isArray(parsed.comments) ? (parsed.comments as ReviewComment[]) : [],
        verdict: parsed.verdict ?? null,
        fix_jobs: Array.isArray(parsed.fix_jobs) ? (parsed.fix_jobs as string[]) : [],
      };
    } catch {
      // Fallback on corrupt file
    }
  }

  const now = new Date().toISOString();
  return {
    review_key: reviewKey,
    project_path: projectPath,
    source,
    ref,
    base,
    created_at: now,
    updated_at: now,
    states: {},
    comments: [],
    verdict: null,
    fix_jobs: [],
  };
}

export function saveReviewSession(session: ReviewSession, paths: ServerPaths): void {
  session.updated_at = new Date().toISOString();
  const filePath = getSessionFilePath(session.review_key, paths);
  const dir = path.dirname(filePath);
  const tmpPath = path.win32.join(
    dir,
    `.tmp_${session.review_key}_${crypto.randomBytes(4).toString('hex')}.json`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function appendReviewAudit(entry: ReviewAuditEntry, paths: ServerPaths): void {
  const baseDir = paths.featureDataDir('review');
  const auditFile = path.win32.join(baseDir, 'audit.jsonl');
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(auditFile, line, 'utf8');
}

export function appendReviewVerdict(entry: ReviewVerdictEntry, paths: ServerPaths): void {
  const baseDir = paths.featureDataDir('review');
  const file = path.win32.join(baseDir, 'verdicts.jsonl');
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(file, line, 'utf8');
}

export function readReviewVerdicts(
  paths: ServerPaths,
  jobId?: string,
  limit = 100
): ReviewVerdictEntry[] {
  const baseDir = paths.featureDataDir('review');
  const file = path.win32.join(baseDir, 'verdicts.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }

  const entries: ReviewVerdictEntry[] = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed) as ReviewVerdictEntry;
        if (!jobId || item.job_id === jobId) {
          entries.push(item);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return [];
  }

  entries.reverse();
  const cappedLimit = Math.max(1, Math.min(1000, limit));
  return entries.slice(0, cappedLimit);
}

export function buildFixPrompt(options: {
  projectName: string;
  source: string;
  ref: string;
  comments: ReviewComment[];
  rejectedHunks: Array<{ path: string; header: string }>;
  note?: string;
}): string {
  const { projectName, source, ref, comments, rejectedHunks, note } = options;

  let includeQuotes = true;
  const maxLen = 20000;

  const render = (withQuotes: boolean): string => {
    const parts: string[] = [];
    const sourceLabel = [source, ref].filter(Boolean).join(' ');
    parts.push(
      `Code review feedback for ${projectName} (${sourceLabel}). Fix every item below. Do not change anything else. When done, list what you changed per item.\n`
    );

    if (comments.length > 0) {
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i]!;
        const sideLabel = c.side === 'old' ? 'old side' : 'new side';
        let block = `${i + 1}. ${c.path}:${c.line} (${sideLabel})\n`;
        if (withQuotes && c.quote && c.quote.trim()) {
          const quoteLines = c.quote
            .trim()
            .split('\n')
            .map((l) => `   > ${l}`)
            .join('\n');
          block += `${quoteLines}\n`;
        }
        block += `   Comment: ${c.body}\n`;
        parts.push(block);
      }
    }

    if (rejectedHunks.length > 0) {
      parts.push(`Rejected by the reviewer (already reverted — do not reintroduce):`);
      for (const h of rejectedHunks) {
        parts.push(`- ${h.path} ${h.header}`);
      }
      parts.push('');
    }

    if (note && note.trim()) {
      parts.push(`Reviewer note: ${note.trim()}\n`);
    }

    return parts.join('\n');
  };

  let prompt = render(includeQuotes);
  if (prompt.length > maxLen) {
    includeQuotes = false;
    prompt = render(false);
  }
  if (prompt.length > maxLen) {
    prompt = prompt.slice(0, maxLen);
  }
  return prompt;
}
