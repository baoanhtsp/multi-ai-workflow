import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import {
  appendAudit,
  badRequest,
  fileMutex,
  newId,
  notFound,
  readJson,
  writeJsonAtomic,
} from '../tasks/lib.ts';
import {
  createCard,
  getCard,
  moveCard,
  patchCard,
  type Card,
  type TaskMode,
  type TaskRole,
} from '../tasks/store.ts';
import { parsePlaybookContent, tickBoxInFile, validatePlaybookFile } from './parser.ts';

export interface PlaybookRunItem {
  line: number;
  text: string;
  card_id: string;
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
}

export interface PlaybookRun {
  id: string;
  schedule_id?: string;
  project_path: string;
  file: string;
  on_failure: 'stop' | 'continue';
  status: 'running' | 'done' | 'stopped' | 'failed';
  items: PlaybookRunItem[];
  cursor: number;
  created_at: string;
  finished_at?: string;
}

export function getRunsFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('playbooks'), 'runs.json');
}

export async function getPlaybookRuns(
  ctx: MawFeatureContext,
  projectPath?: string
): Promise<PlaybookRun[]> {
  const file = getRunsFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<{ version: 1; runs: PlaybookRun[] }>(file, {
      version: 1,
      runs: [],
    });
    let list = Array.isArray(raw.runs) ? raw.runs : [];
    if (projectPath) {
      const norm = path.resolve(projectPath).toLowerCase();
      list = list.filter((r) => {
        try {
          return path.resolve(r.project_path).toLowerCase() === norm;
        } catch {
          return false;
        }
      });
    }
    return list.slice(-50).reverse();
  });
}

export async function startPlaybookRun(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>,
  options?: { schedule_id?: string }
): Promise<{ run: PlaybookRun; tasks: Card[] }> {
  const rawProjectPath = String(raw.project_path ?? '').trim();
  if (!rawProjectPath) {
    throw badRequest('project_path is required.');
  }

  const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
  }

  const fileInput = String(raw.file ?? '').trim();
  if (!fileInput) {
    throw badRequest('file is required.');
  }

  const validatedFilePath = validatePlaybookFile(projectPath, fileInput);
  const content = fs.readFileSync(validatedFilePath, 'utf8');
  const allParsedItems = parsePlaybookContent(content);

  const includeChecked = Boolean(raw.include_checked);
  const itemsToRun = includeChecked
    ? allParsedItems
    : allParsedItems.filter((it) => !it.checked);

  if (itemsToRun.length === 0) {
    throw badRequest('Playbook has 0 unchecked items to run.');
  }

  const runId = newId('pbrun');
  const onFailure =
    String(raw.on_failure ?? 'stop').trim().toLowerCase() === 'continue' ? 'continue' : 'stop';

  const mode = (String(raw.mode ?? 'task').trim() || 'task') as TaskMode;
  const agent = String(raw.agent ?? '').trim();
  const role = (String(raw.role ?? 'backend').trim() || 'backend') as TaskRole;
  const presetId = raw.preset_id ? String(raw.preset_id).trim() : undefined;
  const prefix = raw.prefix ? String(raw.prefix).trim() : '';

  const runItems: PlaybookRunItem[] = [];
  const createdCards: Card[] = [];

  for (let idx = 0; idx < itemsToRun.length; idx++) {
    const item = itemsToRun[idx]!;
    const firstLine = item.text.split('\n')[0]!.trim();
    const title = firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;

    const promptContext = `\n\nContext: playbook ${path.basename(validatedFilePath)}, section "${item.section}".`;
    const prompt = (prefix ? `${prefix}\n\n` : '') + item.text + promptContext;

    const card = await createCard(ctx, {
      title,
      prompt,
      project_path: projectPath,
      mode,
      agent,
      role,
      preset_id: presetId,
      status: 'backlog',
      created_by: 'playbook',
      source: {
        kind: 'playbook',
        run_id: runId,
        file: validatedFilePath,
        line: item.line,
      },
    });

    createdCards.push(card);
    runItems.push({
      line: item.line,
      text: item.text,
      card_id: card.id,
      state: 'pending',
    });
  }

  const scheduleId = raw.schedule_id ? String(raw.schedule_id).trim() : options?.schedule_id;

  const run: PlaybookRun = {
    id: runId,
    ...(scheduleId ? { schedule_id: scheduleId } : {}),
    project_path: projectPath,
    file: validatedFilePath,
    on_failure: onFailure,
    status: 'running',
    items: runItems,
    cursor: 0,
    created_at: new Date().toISOString(),
  };

  const runsFile = getRunsFile(ctx);
  await fileMutex.runExclusive(runsFile, () => {
    const rawData = readJson<{ version: 1; runs: PlaybookRun[] }>(runsFile, {
      version: 1,
      runs: [],
    });
    if (!Array.isArray(rawData.runs)) rawData.runs = [];
    rawData.runs.push(run);
    if (rawData.runs.length > 50) {
      rawData.runs = rawData.runs.slice(-50);
    }
    writeJsonAtomic(runsFile, rawData);
  });

  return { run, tasks: createdCards };
}

export async function stopPlaybookRun(
  ctx: MawFeatureContext,
  runId: string
): Promise<PlaybookRun> {
  const runsFile = getRunsFile(ctx);
  return fileMutex.runExclusive(runsFile, async () => {
    const rawData = readJson<{ version: 1; runs: PlaybookRun[] }>(runsFile, {
      version: 1,
      runs: [],
    });
    const run = (rawData.runs ?? []).find((r) => r.id === runId);
    if (!run) {
      throw notFound(`Playbook run not found: ${runId}`);
    }

    run.status = 'stopped';
    run.finished_at = new Date().toISOString();

    for (let i = run.cursor; i < run.items.length; i++) {
      const item = run.items[i]!;
      if (item.state === 'pending') {
        item.state = 'skipped';
        await patchCard(ctx, item.card_id, (card) => {
          if (card.status === 'backlog') {
            card.status_reason = 'playbook stopped';
          }
        });
      }
    }

    writeJsonAtomic(runsFile, rawData);
    appendAudit(ctx.paths.auditFile, 'playbook_stop', { run_id: runId });
    return run;
  });
}

export async function playbookTicker(ctx: MawFeatureContext): Promise<void> {
  const runsFile = getRunsFile(ctx);
  await fileMutex.runExclusive(runsFile, async () => {
    const rawData = readJson<{ version: 1; runs: PlaybookRun[] }>(runsFile, {
      version: 1,
      runs: [],
    });
    if (!Array.isArray(rawData.runs)) return;

    let modified = false;

    for (const run of rawData.runs) {
      // Check retried cards that later became done (for failed items)
      for (const item of run.items) {
        if (item.state === 'failed') {
          const c = await getCard(ctx, item.card_id);
          if (c && c.status === 'done') {
            const ticked = tickBoxInFile(run.file, item.line, item.text);
            if (!ticked) {
              continue;
            }
            appendAudit(ctx.paths.auditFile, 'playbook_tick', {
              file: run.file,
              line: item.line,
              text: item.text,
            });
            item.state = 'done';
            modified = true;
          }
        }
      }

      if (run.status !== 'running') {
        continue;
      }

      // Check if an item is currently running
      let runningItem: PlaybookRunItem | null = null;
      for (const item of run.items) {
        if (item.state === 'running') {
          runningItem = item;
          break;
        }
      }

      if (runningItem) {
        const card = await getCard(ctx, runningItem.card_id);
        if (!card) {
          // Deleted card edge case
          runningItem.state = 'skipped';
          modified = true;
          if (run.on_failure === 'stop') {
            run.status = 'failed';
            run.finished_at = new Date().toISOString();
            for (let idx = run.cursor + 1; idx < run.items.length; idx++) {
              const rem = run.items[idx]!;
              await patchCard(ctx, rem.card_id, (remCard) => {
                if (remCard.status === 'backlog') {
                  remCard.status_reason = 'playbook stopped';
                }
              });
            }
          } else {
            run.cursor++;
          }
        } else if (card.status === 'backlog') {
          // Re-queue if card was moved back to backlog
          await moveCard(ctx, card.id, 'queued');
        } else if (card.status === 'done') {
          const ticked = tickBoxInFile(run.file, runningItem.line, runningItem.text);
          if (!ticked) {
            // tickBoxInFile failed (e.g. file locked/rename failure); keep item in 'running' state and retry on next tick
            continue;
          }
          appendAudit(ctx.paths.auditFile, 'playbook_tick', {
            file: run.file,
            line: runningItem.line,
            text: runningItem.text,
          });
          runningItem.state = 'done';
          run.cursor++;
          modified = true;
        } else if (card.status === 'failed') {
          runningItem.state = 'failed';
          modified = true;
          if (run.on_failure === 'stop') {
            run.status = 'failed';
            run.finished_at = new Date().toISOString();
            // Leave remaining cards in backlog with status_reason: "playbook stopped"
            for (let idx = run.cursor + 1; idx < run.items.length; idx++) {
              const rem = run.items[idx]!;
              await patchCard(ctx, rem.card_id, (remCard) => {
                if (remCard.status === 'backlog') {
                  remCard.status_reason = 'playbook stopped';
                }
              });
            }
          } else {
            run.cursor++;
          }
        }
      }

      // If no item is running, start the next one at cursor
      if (run.status === 'running') {
        const stillRunning = run.items.some((it) => it.state === 'running');
        if (!stillRunning) {
          if (run.cursor >= run.items.length) {
            run.status = 'done';
            run.finished_at = new Date().toISOString();
            modified = true;
          } else {
            const nextItem = run.items[run.cursor]!;
            const nextCard = await getCard(ctx, nextItem.card_id);
            if (!nextCard) {
              // Deleted card before starting
              nextItem.state = 'skipped';
              modified = true;
              if (run.on_failure === 'stop') {
                run.status = 'failed';
                run.finished_at = new Date().toISOString();
                for (let idx = run.cursor + 1; idx < run.items.length; idx++) {
                  const rem = run.items[idx]!;
                  await patchCard(ctx, rem.card_id, (remCard) => {
                    if (remCard.status === 'backlog') {
                      remCard.status_reason = 'playbook stopped';
                    }
                  });
                }
              } else {
                run.cursor++;
              }
            } else if (nextCard.status === 'backlog') {
              await moveCard(ctx, nextCard.id, 'queued');
              nextItem.state = 'running';
              modified = true;
            } else if (nextCard.status === 'done') {
              nextItem.state = 'done';
              run.cursor++;
              modified = true;
            }
          }
        }
      }
    }

    if (modified) {
      writeJsonAtomic(runsFile, rawData);
    }
  });
}
