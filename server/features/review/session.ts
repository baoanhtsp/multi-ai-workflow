import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendActionAudit } from '../../lib/feature.ts';
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
  headers?: Record<string, string>;
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
  appendActionAudit(paths, {
    feature: 'review',
    ...entry,
  });
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

const reviewLocks = new Map<string, Promise<void>>();

export function withReviewLock<T>(reviewKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = reviewLocks.get(reviewKey) ?? Promise.resolve();
  let resultPromise: Promise<T>;
  const next = prev.then(() => {
    resultPromise = fn();
    return resultPromise;
  });
  reviewLocks.set(
    reviewKey,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

export interface BuildFixPromptResult {
  prompt: string;
  included: ReviewComment[];
  remaining: ReviewComment[];
}

export function buildFixPrompt(options: {
  projectName: string;
  source: string;
  ref: string;
  comments: ReviewComment[];
  rejectedHunks: Array<{ path: string; header: string }>;
  note?: string;
}): BuildFixPromptResult {
  const { projectName, source, ref, comments, rejectedHunks, note } = options;
  const maxLen = 20000;

  const sourceLabel = [source, ref].filter(Boolean).join(' ');
  const header = `Code review feedback for ${projectName} (${sourceLabel}). Fix every item below. Do not change anything else. When done, list what you changed per item.\n\n`;

  let footer = '';
  if (rejectedHunks.length > 0) {
    footer += `Rejected by the reviewer (already reverted — do not reintroduce):\n`;
    for (const h of rejectedHunks) {
      footer += `- ${h.path} ${h.header}\n`;
    }
    footer += '\n';
  }
  if (note && note.trim()) {
    footer += `Reviewer note: ${note.trim()}\n`;
  }

  const baseLen = header.length + footer.length;
  const availableBudget = Math.max(0, maxLen - baseLen);

  const included: ReviewComment[] = [];
  const remaining: ReviewComment[] = [];
  const commentBlocks: string[] = [];
  let currentCommentsLen = 0;

  const renderCommentBlock = (i: number, c: ReviewComment, withQuote: boolean): string => {
    const sideLabel = c.side === 'old' ? 'old side' : 'new side';
    let block = `${i + 1}. ${c.path}:${c.line} (${sideLabel})\n`;
    if (withQuote && c.quote && c.quote.trim()) {
      const quoteLines = c.quote
        .trim()
        .split('\n')
        .map((l) => `   > ${l}`)
        .join('\n');
      block += `${quoteLines}\n`;
    }
    block += `   Comment: ${c.body}\n`;
    return block;
  };

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i]!;
    let block = renderCommentBlock(included.length, c, true);
    let extraLen = (commentBlocks.length > 0 ? 1 : 0) + block.length;

    if (currentCommentsLen + extraLen > availableBudget) {
      // Try without quote to see if it fits within budget
      block = renderCommentBlock(included.length, c, false);
      extraLen = (commentBlocks.length > 0 ? 1 : 0) + block.length;
    }

    if (currentCommentsLen + extraLen <= availableBudget) {
      commentBlocks.push(block);
      currentCommentsLen += extraLen;
      included.push(c);
    } else {
      // Budget exhausted without cutting mid-item
      remaining.push(...comments.slice(i));
      break;
    }
  }

  const parts: string[] = [header.trimEnd()];
  if (commentBlocks.length > 0) {
    parts.push(commentBlocks.join('\n'));
  }
  if (footer.trim()) {
    parts.push(footer.trim());
  }

  let prompt = parts.join('\n\n') + '\n';
  if (prompt.length > maxLen) {
    prompt = prompt.slice(0, maxLen);
  }

  return {
    prompt,
    included,
    remaining,
  };
}
