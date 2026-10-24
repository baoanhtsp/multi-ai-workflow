import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import { isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  getNextAdrId,
  parseDecisionsMarkdown,
  renderDecisionsMarkdown,
  type MemoryEntry,
} from '../agents-ws/lib/markdown-memory.ts';
import { withS6State } from '../agents-ws/lib/mutex.ts';
import { assertSafeProjectMawWrite } from '../agents-ws/lib/security.ts';
import { appendAuditLog } from '../agents-ws/lib/store.ts';
import type { MemoryContextResult } from './types.ts';

function getDecisionsFilePath(projectPath: string): string {
  return path.win32.join(projectPath, '.maw', 'memory', 'decisions.md');
}

export async function addMemoryEntry(
  projectPath: string,
  entry: {
    title: string;
    body: string;
    tags?: string[];
    pinned?: boolean;
    source?: string;
    agent?: string;
  },
  projectsRoot?: string
): Promise<MemoryEntry> {
  return withS6State(async () => {
    assertSafeProjectMawWrite(
      projectPath,
      path.join('.maw', 'memory', 'decisions.md'),
      projectsRoot
    );
    const filePath = getDecisionsFilePath(projectPath);
    let preamble = '# Project decisions\n';
    let entries: MemoryEntry[] = [];

    if (isFileSafe(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = parseDecisionsMarkdown(raw);
        preamble = parsed.preamble;
        entries = parsed.entries;
      } catch {
        preamble = '# Project decisions\n';
        entries = [];
      }
    }

    const nextId = getNextAdrId(entries);
    const newEntry: MemoryEntry = {
      id: nextId,
      title: entry.title.trim().slice(0, 120),
      body: entry.body.trim().slice(0, 4000),
      date: new Date().toISOString().slice(0, 10),
      source: entry.source ? entry.source.trim() : '',
      agent: entry.agent ? entry.agent.trim() : '',
      pinned: Boolean(entry.pinned),
      tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 10) : [],
    };

    entries.push(newEntry);
    const rendered = renderDecisionsMarkdown(preamble, entries);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, rendered, 'utf8');

    return newEntry;
  });
}

export async function getMemoryContext(
  projectPath: string,
  q: string,
  maxChars = 2500
): Promise<MemoryContextResult> {
  const filePath = getDecisionsFilePath(projectPath);
  if (!isFileSafe(filePath)) {
    return { text: '', ids: [] };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { text: '', ids: [] };
  }

  const { entries } = parseDecisionsMarkdown(raw);
  if (entries.length === 0) {
    return { text: '', ids: [] };
  }

  const keywords = q
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`]+/)
    .filter((w) => w.length >= 3);

  const pinnedEntries = entries.filter((e) => e.pinned);
  const unpinnedEntries = entries.filter((e) => !e.pinned);

  const scoreEntry = (entry: MemoryEntry): number => {
    let score = 0;
    const target = `${entry.title} ${entry.body} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
    for (const kw of keywords) {
      if (target.includes(kw)) {
        score++;
      }
    }
    return score;
  };

  // Item 21: exclude unpinned entries with score 0 (pinned + keyword matches only)
  const matchingUnpinned = unpinnedEntries.filter((e) => scoreEntry(e) > 0);
  matchingUnpinned.sort((a, b) => scoreEntry(b) - scoreEntry(a));

  const ordered = [...pinnedEntries, ...matchingUnpinned];
  const selectedIds: string[] = [];
  const lines: string[] = [];
  let currentLen = 0;

  for (const entry of ordered) {
    const bodyExcerpt = entry.body.slice(0, 400).trim();
    const line = `- ${entry.id} ${entry.title}: ${bodyExcerpt}`;
    if (lines.length > 0 && currentLen + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    selectedIds.push(entry.id);
    currentLen += line.length + 1;
  }

  return {
    text: lines.join('\n'),
    ids: selectedIds,
  };
}

export const feature: MawFeature = {
  name: 'memory',
  ui: {
    script: 'feat-palette.js',
    style: 'feat-palette.css',
  },
  routes: {
    memory_list: {
      method: 'GET',
      handler: async (ctx) => {
        const rawProj = String(ctx.query?.get('project_path') ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const filePath = getDecisionsFilePath(validPath);
        if (!isFileSafe(filePath)) {
          return {
            ok: true,
            entries: [],
            path: filePath,
          };
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const { entries } = parseDecisionsMarkdown(raw);

        const q = String(ctx.query?.get('q') ?? '').trim().toLowerCase();
        let filtered = entries;
        if (q) {
          filtered = entries.filter((e) => {
            const haystack = `${e.title} ${e.body} ${(e.tags ?? []).join(' ')}`.toLowerCase();
            return haystack.includes(q);
          });
        }

        filtered.sort((a, b) => b.id.localeCompare(a.id));

        return {
          ok: true,
          entries: filtered,
          path: filePath,
        };
      },
    },

    memory_add: {
      method: 'POST',
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const rawProj = String(body.project_path ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const title = String(body.title ?? '').trim();
        if (!title || title.length > 120) {
          throw new ApiValidationError('Title is required and must be <= 120 characters.', 400);
        }

        const entryBody = String(body.body ?? '').trim();
        if (!entryBody || entryBody.length > 4000) {
          throw new ApiValidationError('Body is required and must be <= 4000 characters.', 400);
        }

        let tags: string[] = [];
        if (Array.isArray(body.tags)) {
          if (body.tags.length > 10) {
            throw new ApiValidationError('Maximum 10 tags allowed.', 400);
          }
          const tagRegex = /^[\p{L}\p{N}_-]+$/u;
          for (const t of body.tags) {
            const tagStr = String(t ?? '').trim();
            if (!tagStr || tagStr.length > 24 || !tagRegex.test(tagStr)) {
              throw new ApiValidationError(
                `Invalid tag '${tagStr}'. Must match ^[\\p{L}\\p{N}_-]+$ and be <= 24 chars.`,
                400
              );
            }
            tags.push(tagStr);
          }
        }

        const newEntry = await addMemoryEntry(
          validPath,
          {
            title,
            body: entryBody,
            tags,
            pinned: Boolean(body.pinned),
            source: typeof body.source === 'string' ? body.source.trim() : '',
            agent: typeof body.agent === 'string' ? body.agent.trim() : '',
          },
          ctx.paths.projectsRoot
        );

        return {
          ok: true,
          entry: newEntry,
        };
      },
    },

    memory_update: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawProj = String(body.project_path ?? '').trim();
          const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
          if (!validPath) {
            throw new ApiValidationError('Invalid or missing project_path.', 400);
          }

          const id = String(body.id ?? '').trim().toUpperCase();
          if (!id || !/^ADR-\d{4}$/.test(id)) {
            throw new ApiValidationError('Invalid or missing id (expected ADR-xxxx).', 400);
          }

          const filePath = getDecisionsFilePath(validPath);
          if (!isFileSafe(filePath)) {
            throw new ApiValidationError(`Memory entry '${id}' not found.`, 404);
          }

          const raw = fs.readFileSync(filePath, 'utf8');
          const { preamble, entries } = parseDecisionsMarkdown(raw);

          const target = entries.find((e) => e.id === id);
          if (!target) {
            throw new ApiValidationError(`Memory entry '${id}' not found.`, 404);
          }

          if (body.title !== undefined) {
            const title = String(body.title).trim();
            if (!title || title.length > 120) {
              throw new ApiValidationError('Title must be between 1 and 120 characters.', 400);
            }
            target.title = title;
          }

          if (body.body !== undefined) {
            const entryBody = String(body.body).trim();
            if (!entryBody || entryBody.length > 4000) {
              throw new ApiValidationError('Body must be between 1 and 4000 characters.', 400);
            }
            target.body = entryBody;
          }

          if (body.pinned !== undefined) {
            target.pinned = Boolean(body.pinned);
          }

          if (body.tags !== undefined) {
            if (!Array.isArray(body.tags)) {
              throw new ApiValidationError('Tags must be an array.', 400);
            }
            if (body.tags.length > 10) {
              throw new ApiValidationError('Maximum 10 tags allowed.', 400);
            }
            const tagRegex = /^[\p{L}\p{N}_-]+$/u;
            const tags: string[] = [];
            for (const t of body.tags) {
              const tagStr = String(t ?? '').trim();
              if (!tagStr || tagStr.length > 24 || !tagRegex.test(tagStr)) {
                throw new ApiValidationError(
                  `Invalid tag '${tagStr}'. Must match ^[\\p{L}\\p{N}_-]+$ and be <= 24 chars.`,
                  400
                );
              }
              tags.push(tagStr);
            }
            target.tags = tags;
          }

          assertSafeProjectMawWrite(
            validPath,
            path.join('.maw', 'memory', 'decisions.md'),
            ctx.paths.projectsRoot
          );
          const rendered = renderDecisionsMarkdown(preamble, entries);
          fs.writeFileSync(filePath, rendered, 'utf8');

          return {
            ok: true,
            entry: target,
          };
        });
      },
    },

    memory_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawProj = String(body.project_path ?? '').trim();
          const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
          if (!validPath) {
            throw new ApiValidationError('Invalid or missing project_path.', 400);
          }

          const id = String(body.id ?? '').trim().toUpperCase();
          if (!id || !/^ADR-\d{4}$/.test(id)) {
            throw new ApiValidationError('Invalid or missing id (expected ADR-xxxx).', 400);
          }

          const filePath = getDecisionsFilePath(validPath);
          if (!isFileSafe(filePath)) {
            throw new ApiValidationError(`Memory entry '${id}' not found.`, 404);
          }

          const raw = fs.readFileSync(filePath, 'utf8');
          const { preamble, entries } = parseDecisionsMarkdown(raw);

          const index = entries.findIndex((e) => e.id === id);
          if (index === -1) {
            throw new ApiValidationError(`Memory entry '${id}' not found.`, 404);
          }

          entries.splice(index, 1);
          assertSafeProjectMawWrite(
            validPath,
            path.join('.maw', 'memory', 'decisions.md'),
            ctx.paths.projectsRoot
          );
          const rendered = renderDecisionsMarkdown(preamble, entries);
          fs.writeFileSync(filePath, rendered, 'utf8');

          const featDir = ctx.paths.featureDataDir('memory');
          await appendAuditLog(featDir, {
            action: 'memory_delete',
            target: id,
            detail: { project_path: validPath },
          });

          return {
            ok: true,
          };
        });
      },
    },

    memory_context: {
      method: 'GET',
      handler: async (ctx) => {
        const rawProj = String(ctx.query?.get('project_path') ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const q = String(ctx.query?.get('q') ?? '');
        const maxCharsRaw = ctx.query?.get('max_chars');
        let maxChars = 2500;
        if (maxCharsRaw) {
          const parsed = Number.parseInt(maxCharsRaw, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            maxChars = parsed;
          }
        }

        const res = await getMemoryContext(validPath, q, maxChars);
        return {
          ok: true,
          text: res.text,
          ids: res.ids,
        };
      },
    },
  },
};
