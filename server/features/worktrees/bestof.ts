import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob } from '../../actions/jobs.ts';
import { appendAuditEntry } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { isDirectorySafe, isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { gitRun, snapshotTree } from '../checkpoints/snapshot.ts';
import { createWorktreeRecord } from './isolate.ts';
import { handleWorktreeDiscard, handleWorktreeMerge, isJobStillRunning } from './merge.ts';
import { loadWorktreesStore, withStoreLock } from './store.ts';

export const BESTOF_ID_REGEX = /^bo\d{14}[0-9a-f]{2}$/i;

export interface BestOfCheck {
  name: string;
  command: string[] | string;
  timeout_s?: number;
}

export interface BestOfCandidate {
  i: number;
  agent: string;
  model?: string;
  effort?: string;
  worktree_id: string;
  job_id: string;
  job_status: string;
  started_at: string;
  finished_at?: string;
  duration_s?: number;
  diff: { files: number; additions: number; deletions: number } | null;
  tests: {
    status: 'pass' | 'fail' | 'none' | 'running' | 'error';
    results: Array<{ name: string; exit_code: number | null; duration_s: number; tail: string }>;
  } | null;
  council: {
    job_id: string;
    status: string;
    verdicts: Record<string, string>;
    score: number | null;
    approved: boolean | null;
  } | null;
  cost_usd: number | null;
  rank?: number;
  total?: number;
  [key: string]: unknown;
}

export interface BestOfRun {
  id: string;
  project_path: string;
  prompt: string;
  role: string;
  judge: 'council' | 'tests' | 'both';
  reviewers: string[];
  base: string;
  created_at: string;
  state: 'running' | 'judging' | 'done' | 'picked' | 'cancelled';
  candidates: BestOfCandidate[];
  winner?: number;
  picked?: { i: number; merge_commit: string; at: string };
  [key: string]: unknown;
}

export const runLocks = new Map<string, Promise<void>>();
export const activeCheckRuns = new Set<string>();

export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const current = runLocks.get(runId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  runLocks.set(runId, next);
  await current;
  try {
    return await fn();
  } finally {
    release();
    if (runLocks.get(runId) === next) {
      runLocks.delete(runId);
    }
  }
}

export function getBestOfDir(dataDir: string): string {
  const dir = path.win32.join(dataDir, 'bestof');
  if (!isDirectorySafe(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadBestOfRun(dataDir: string, id: string): BestOfRun | null {
  const file = path.win32.join(getBestOfDir(dataDir), `${id}.json`);
  if (!isFileSafe(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BestOfRun;
  } catch {
    return null;
  }
}

export function saveBestOfRun(dataDir: string, run: BestOfRun): void {
  const dir = getBestOfDir(dataDir);
  const file = path.win32.join(dir, `${run.id}.json`);
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

export function generateBestOfId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(1).toString('hex');
  return `bo${ts}${hex}`;
}

export function computeCandidateCost(
  auditFile: string,
  agent: string,
  startedAt: string,
  finishedAt?: string
): number | null {
  if (!isFileSafe(auditFile)) return null;
  try {
    const startMs = new Date(startedAt).getTime();
    const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const raw = fs.readFileSync(auditFile, 'utf8');
    let total = 0;
    let found = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as {
          Timestamp?: string;
          Tool?: string;
          CostUsd?: number;
        };
        if (row && row.Timestamp && row.Tool) {
          const tMs = new Date(row.Timestamp).getTime();
          if (
            tMs >= startMs - 2000 &&
            tMs <= endMs + 2000 &&
            row.Tool.toLowerCase() === agent.toLowerCase()
          ) {
            const cost = Number(row.CostUsd);
            if (Number.isFinite(cost)) {
              total += cost;
              found = true;
            }
          }
        }
      } catch {}
    }
    return found ? Math.round(total * 10000) / 10000 : null;
  } catch {
    return null;
  }
}

export async function advanceBestOfRun(ctx: MawFeatureContext, run: BestOfRun): Promise<BestOfRun> {
  if (run.state === 'done' || run.state === 'picked' || run.state === 'cancelled') {
    return run;
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  // Step 1: In 'running' state, check candidate jobs
  if (run.state === 'running') {
    let allFinished = true;
    for (const c of run.candidates) {
      if (c.job_status === 'RUNNING') {
        const metaFile = path.win32.join(ctx.paths.jobsDir, `${c.job_id}.json`);
        if (isFileSafe(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
              status?: string;
              finished_at?: string;
              started_ts?: number;
            };
            if (meta.status && meta.status !== 'RUNNING') {
              c.job_status = meta.status;
              c.finished_at = meta.finished_at || new Date().toISOString();
              const startedSec =
                meta.started_ts || Math.floor(new Date(c.started_at).getTime() / 1000);
              const finishedSec = Math.floor(new Date(c.finished_at).getTime() / 1000);
              c.duration_s = Math.max(0, finishedSec - startedSec);
              c.cost_usd = computeCandidateCost(
                ctx.paths.auditFile,
                c.agent,
                c.started_at,
                c.finished_at
              );
            } else {
              allFinished = false;
            }
          } catch {
            allFinished = false;
          }
        } else {
          allFinished = false;
        }
      }
    }

    if (allFinished) {
      // Calculate diff for each candidate using snapshotTree (N3)
      const store = await loadWorktreesStore(dataDir);
      for (const c of run.candidates) {
        const wtRec = store.worktrees.find((w) => w.id === c.worktree_id);
        if (wtRec && fs.existsSync(wtRec.worktree_path)) {
          try {
            const currentTree = await snapshotTree(wtRec.worktree_path);
            const numstatRes = await gitRun(
              ['diff', '--numstat', wtRec.base_commit, currentTree],
              { cwd: wtRec.worktree_path, allowFailure: true }
            );
            if (numstatRes.code === 0) {
              let files = 0;
              let adds = 0;
              let dels = 0;
              for (const l of numstatRes.stdout.split(/\r?\n/)) {
                const trimmed = l.trim();
                if (!trimmed) continue;
                const [a, d] = trimmed.split(/\s+/);
                files++;
                if (a && a !== '-') adds += Number.parseInt(a, 10) || 0;
                if (d && d !== '-') dels += Number.parseInt(d, 10) || 0;
              }
              c.diff = { files, additions: adds, deletions: dels };
            }
          } catch {
            c.diff = null;
          }
        }
      }

      run.state = 'judging';
      saveBestOfRun(dataDir, run);
    } else {
      saveBestOfRun(dataDir, run);
      return run;
    }
  }

  // Step 2: In 'judging' state, execute tests and council
  if (run.state === 'judging') {
    const store = await loadWorktreesStore(dataDir);
    const needTests = run.judge === 'tests' || run.judge === 'both';
    const needCouncil = run.judge === 'council' || run.judge === 'both';

    // 2a. Tests in background promise (N2, R2-2, R2-3)
    if (needTests) {
      for (const c of run.candidates) {
        const runKey = `${run.id}_${c.i}`;
        // R2-2: Treat tests.status: 'running' but NOT in activeCheckRuns (server restarted) as "start again"
        const shouldRunChecks =
          !c.tests || (c.tests.status === 'running' && !activeCheckRuns.has(runKey));

        if (shouldRunChecks) {
          const wtRec = store.worktrees.find((w) => w.id === c.worktree_id);
          const repo = run.project_path;
          const checksFile = path.win32.join(repo, '.maw', 'checks.json');

          if (!wtRec || !fs.existsSync(wtRec.worktree_path) || !isFileSafe(checksFile)) {
            c.tests = { status: 'none', results: [] };
          } else {
            let checks: BestOfCheck[] = [];
            try {
              const rawChecks = JSON.parse(fs.readFileSync(checksFile, 'utf8')) as unknown;
              if (Array.isArray(rawChecks)) {
                checks = rawChecks as BestOfCheck[];
              } else if (
                rawChecks &&
                typeof rawChecks === 'object' &&
                Array.isArray((rawChecks as Record<string, unknown>).checks)
              ) {
                checks = (rawChecks as { checks: BestOfCheck[] }).checks;
              }
            } catch {
              checks = [];
            }

            if (checks.length === 0) {
              c.tests = { status: 'none', results: [] };
            } else {
              c.tests = { status: 'running', results: [] };
              if (!activeCheckRuns.has(runKey)) {
                activeCheckRuns.add(runKey);
                const wtPath = wtRec.worktree_path;
                const candidateIndex = c.i;
                const runId = run.id;

                (async () => {
                  try {
                    const testResults: Array<{
                      name: string;
                      exit_code: number | null;
                      duration_s: number;
                      tail: string;
                    }> = [];

                    let allPassed = true;
                    let hadError = false;

                    for (const chk of checks) {
                      const chkName = String(chk.name || 'check');
                      const timeoutMs = (chk.timeout_s ?? 600) * 1000;
                      let commandArgs: string[] = [];
                      let program = '';

                      if (Array.isArray(chk.command)) {
                        commandArgs = chk.command.map(String);
                      } else if (typeof chk.command === 'string') {
                        commandArgs = chk.command.split(/\s+/).filter(Boolean);
                      }

                      if (commandArgs.length === 0) continue;
                      program = commandArgs[0]!;
                      const restArgs = commandArgs.slice(1);

                      const startTime = Date.now();
                      let exitCode: number | null = 1;
                      let stdout = '';
                      let stderr = '';

                      if (/\.(cmd|bat)$/i.test(program) || program.toLowerCase() === 'npm') {
                        const safeArgRegex = /^[A-Za-z0-9_./:=@+-]+$/;
                        if (!restArgs.every((a) => safeArgRegex.test(a))) {
                          hadError = true;
                          testResults.push({
                            name: chkName,
                            exit_code: null,
                            duration_s: 0,
                            tail: 'Disallowed argument characters in cmd execution.',
                          });
                          continue;
                        }
                        const cmdRes = await runCommand(
                          'cmd.exe',
                          ['/d', '/s', '/c', program, ...restArgs],
                          { cwd: wtPath, timeoutMs }
                        );
                        exitCode = cmdRes.code;
                        stdout = cmdRes.stdout;
                        stderr = cmdRes.stderr;
                      } else {
                        const procRes = await runCommand(program, restArgs, {
                          cwd: wtPath,
                          timeoutMs,
                        });
                        exitCode = procRes.code;
                        stdout = procRes.stdout;
                        stderr = procRes.stderr;
                      }

                      const dur = Math.round((Date.now() - startTime) / 1000);
                      const tail = `${stdout}\n${stderr}`.trim().slice(-1000);
                      testResults.push({
                        name: chkName,
                        exit_code: exitCode,
                        duration_s: dur,
                        tail,
                      });

                      if (exitCode !== 0) {
                        allPassed = false;
                      }
                    }

                    const status = hadError ? 'error' : allPassed ? 'pass' : 'fail';

                    await withRunLock(runId, async () => {
                      const freshRun = loadBestOfRun(dataDir, runId);
                      if (freshRun) {
                        const targetCand = freshRun.candidates.find(
                          (cand) => cand.i === candidateIndex
                        );
                        if (targetCand) {
                          targetCand.tests = {
                            status,
                            results: testResults,
                          };
                          saveBestOfRun(dataDir, freshRun);
                        }
                      }
                    });
                  } catch (err) {
                    // R2-3: Catch unhandled rejection and record tests.status: 'error' under withRunLock
                    try {
                      const msg = err instanceof Error ? err.message : String(err);
                      await withRunLock(runId, async () => {
                        const freshRun = loadBestOfRun(dataDir, runId);
                        if (freshRun) {
                          const targetCand = freshRun.candidates.find(
                            (cand) => cand.i === candidateIndex
                          );
                          if (targetCand) {
                            targetCand.tests = {
                              status: 'error',
                              results: [
                                {
                                  name: 'runner',
                                  exit_code: null,
                                  duration_s: 0,
                                  tail: msg,
                                },
                              ],
                            };
                            saveBestOfRun(dataDir, freshRun);
                          }
                        }
                      });
                    } catch {
                      // Swallow internal logger error
                    }
                  } finally {
                    activeCheckRuns.delete(runKey);
                  }
                })();
              }
            }
          }
        }
      }

      if (run.candidates.some((c) => c.tests?.status === 'running')) {
        saveBestOfRun(dataDir, run);
        return run;
      }
    }

    // 2b. Council (N3, N4)
    if (needCouncil) {
      let councilJobsFinished = true;
      for (const c of run.candidates) {
        if (!c.council) {
          const wtRec = store.worktrees.find((w) => w.id === c.worktree_id);
          if (wtRec && fs.existsSync(wtRec.worktree_path)) {
            // N3: git reset --soft <base_commit> before council job if candidate made commits
            const countRes = await gitRun(
              ['rev-list', '--count', `${wtRec.base_commit}..HEAD`],
              { cwd: wtRec.worktree_path, allowFailure: true }
            );
            const commitCount = Number.parseInt(countRes.stdout.trim(), 10) || 0;
            if (commitCount > 0) {
              await gitRun(['reset', '--soft', wtRec.base_commit], {
                cwd: wtRec.worktree_path,
                allowFailure: true,
              });
            }

            // N4: Wrap startJob in try/catch
            const councilPrompt = `Best-of-N candidate ${c.i} for: ${run.prompt}`;
            try {
              const cJob = await ctx.startJob({
                mode: 'council',
                project_path: wtRec.worktree_path,
                reviewers: run.reviewers,
                prompt: councilPrompt,
              });
              c.council = {
                job_id: String(cJob.job_id ?? ''),
                status: 'RUNNING',
                verdicts: {},
                score: null,
                approved: null,
              };
              councilJobsFinished = false;
            } catch (err) {
              c.council = {
                job_id: '',
                status: 'ERROR',
                verdicts: {},
                score: null,
                approved: false,
              };
            }
          }
        } else if (c.council.status === 'RUNNING') {
          const metaFile = path.win32.join(ctx.paths.jobsDir, `${c.council.job_id}.json`);
          const logFile = path.win32.join(ctx.paths.jobsDir, `${c.council.job_id}.log`);
          if (isFileSafe(metaFile)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { status?: string };
              if (meta.status && meta.status !== 'RUNNING') {
                c.council.status = meta.status;

                // Parse council log for verdicts/scores
                if (isFileSafe(logFile)) {
                  const logContent = fs.readFileSync(logFile, 'utf8');
                  const lines = logContent.split(/\r?\n/);
                  let foundResultLine = '';
                  for (const line of lines) {
                    if (line.includes('COUNCIL_RESULT')) {
                      foundResultLine = line;
                    }
                  }

                  if (foundResultLine) {
                    const idx = foundResultLine.indexOf('COUNCIL_RESULT');
                    let afterResult = foundResultLine.slice(idx + 'COUNCIL_RESULT'.length);
                    const endIdx = afterResult.indexOf('===');
                    if (endIdx !== -1) {
                      afterResult = afterResult.slice(0, endIdx);
                    }

                    const pairRegex = /([a-z][a-z0-9-]{1,23})=([A-Z_]+)\|([\d.]+|\?)/g;
                    const verdicts: Record<string, string> = {};
                    const scores: number[] = [];
                    let pMatch: RegExpExecArray | null;
                    while ((pMatch = pairRegex.exec(afterResult)) !== null) {
                      const rId = pMatch[1]!;
                      const verd = pMatch[2]!;
                      const scoreStr = pMatch[3]!;
                      verdicts[rId] = verd;
                      if (scoreStr !== '?') {
                        const sc = Number.parseFloat(scoreStr);
                        if (Number.isFinite(sc)) scores.push(sc);
                      }
                    }

                    c.council.verdicts = verdicts;
                    c.council.score = scores.length > 0 ? Math.min(...scores) : null;

                    // approved = every reviewer in run.reviewers has verdict APPROVED (a reviewer missing from the line = not approved)
                    const reqReviewers = Array.isArray(run.reviewers) && run.reviewers.length > 0
                      ? run.reviewers
                      : Object.keys(verdicts);
                    const allApproved =
                      reqReviewers.length > 0 &&
                      reqReviewers.every((r) => verdicts[r] === 'APPROVED');
                    c.council.approved = allApproved;
                  }
                }
              } else {
                councilJobsFinished = false;
              }
            } catch {
              councilJobsFinished = false;
            }
          } else {
            councilJobsFinished = false;
          }
        }
      }

      if (!councilJobsFinished) {
        saveBestOfRun(dataDir, run);
        return run;
      }
    }

    // 2c. Ranking and winner selection
    const candidates = [...run.candidates];
    candidates.sort((a, b) => {
      // 1. Failed job last
      const aFailed = a.job_status !== 'DONE';
      const bFailed = b.job_status !== 'DONE';
      if (aFailed !== bFailed) return aFailed ? 1 : -1;

      // 2. Tests: pass > none > fail/error
      const testRank = (t: BestOfCandidate['tests']) => {
        if (!t || t.status === 'none') return 2;
        if (t.status === 'pass') return 1;
        return 3;
      };
      const aT = testRank(a.tests);
      const bT = testRank(b.tests);
      if (aT !== bT) return aT - bT;

      // 3. Council approved
      const aApp = a.council?.approved === true ? 1 : 0;
      const bApp = b.council?.approved === true ? 1 : 0;
      if (aApp !== bApp) return bApp - aApp;

      // 4. Council score desc
      const aScore = a.council?.score ?? -1;
      const bScore = b.council?.score ?? -1;
      if (aScore !== bScore) return bScore - aScore;

      // 5. Smaller diff (additions + deletions)
      const aDiff = (a.diff?.additions ?? 0) + (a.diff?.deletions ?? 0);
      const bDiff = (b.diff?.additions ?? 0) + (b.diff?.deletions ?? 0);
      if (aDiff !== bDiff) return aDiff - bDiff;

      // 6. Shorter duration
      const aDur = a.duration_s ?? 999999;
      const bDur = b.duration_s ?? 999999;
      return aDur - bDur;
    });

    for (let idx = 0; idx < candidates.length; idx++) {
      const cand = candidates[idx]!;
      cand.rank = idx + 1;
      cand.total = candidates.length;
    }

    run.state = 'done';
    run.winner = candidates[0]?.i;
    saveBestOfRun(dataDir, run);
  }

  return run;
}

export async function handleBestOfStart(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rawProject = String(body.project_path ?? ctx.paths.repoRoot).trim();
  const projectPath = resolveProjectPath(rawProject, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    throw new ApiValidationError('Prompt is required for best-of-N.', 400);
  }
  if ([...prompt].length > 20000) {
    throw new ApiValidationError('Prompt exceeds maximum length (20000 characters).', 400);
  }

  const role = String(body.role ?? 'backend').trim().toLowerCase();
  const judge = String(body.judge ?? 'both').trim().toLowerCase();
  if (!['council', 'tests', 'both'].includes(judge)) {
    throw new ApiValidationError("Invalid judge. Must be 'council', 'tests', or 'both'.", 400);
  }

  const rawCandidates = body.candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length < 2 || rawCandidates.length > 4) {
    throw new ApiValidationError('Best-of-N requires between 2 and 4 candidates.', 400);
  }

  const enabledAgentsMap = new Map((ctx.registry?.agents ?? []).map((a) => [a.id, a]));
  const seenCandidates = new Set<string>();
  const parsedCandidates: Array<{ agent: string; model?: string; effort?: string }> = [];

  for (const c of rawCandidates) {
    if (!c || typeof c !== 'object') {
      throw new ApiValidationError('Invalid candidate format: expected object.', 400);
    }
    const cObj = c as Record<string, unknown>;
    const ag = String(cObj.agent ?? '').trim().toLowerCase();
    const entry = enabledAgentsMap.get(ag);
    if (!entry) {
      throw new ApiValidationError(`Candidate agent '${ag}' is not an enabled registry agent.`, 400);
    }
    if (!entry.capabilities?.write) {
      throw new ApiValidationError(`Candidate agent '${ag}' does not have write capability.`, 400);
    }

    const model = cObj.model ? String(cObj.model).trim() : undefined;
    const effort = cObj.effort ? String(cObj.effort).trim() : undefined;
    const sig = `${ag}:${model || ''}`;
    if (seenCandidates.has(sig)) {
      throw new ApiValidationError(
        `Duplicate candidate '${ag}' with model '${model || 'default'}'.`,
        400
      );
    }
    seenCandidates.add(sig);

    parsedCandidates.push({ agent: ag, model, effort });
  }

  let reviewers = Array.isArray(body.reviewers)
    ? (body.reviewers as string[]).map((r) => String(r).trim().toLowerCase())
    : [...(ctx.registry?.defaults?.council ?? ['claude', 'codex'])];
  if (reviewers.length === 0) {
    reviewers = ['claude', 'codex'];
  }

  const runId = generateBestOfId();
  const base = body.base ? String(body.base).trim() : undefined;
  const candidatesRecords: BestOfCandidate[] = [];

  for (let idx = 0; idx < parsedCandidates.length; idx++) {
    const cand = parsedCandidates[idx]!;
    const candidateIdx = idx + 1;
    const wtName = `bo-${runId}-${candidateIdx}`;

    const wtRes = await createWorktreeRecord(ctx, {
      project_path: projectPath,
      base,
      name: wtName,
      owner: cand.agent,
      origin: 'bestof',
    });

    let jobId = '';
    let jobStatus = 'RUNNING';
    try {
      const jobRes = await ctx.startJob({
        mode: 'task',
        agent: cand.agent,
        role,
        model: cand.model,
        effort: cand.effort,
        project_path: wtRes.worktree.worktree_path,
        prompt,
      });
      jobId = String(jobRes.job_id ?? '');
    } catch {
      jobStatus = 'FAILED';
    }

    candidatesRecords.push({
      i: candidateIdx,
      agent: cand.agent,
      model: cand.model,
      effort: cand.effort,
      worktree_id: wtName,
      job_id: jobId,
      job_status: jobStatus,
      started_at: new Date().toISOString(),
      diff: null,
      tests: null,
      council: null,
      cost_usd: null,
    });
  }

  const run: BestOfRun = {
    id: runId,
    project_path: projectPath,
    prompt,
    role,
    judge: judge as 'council' | 'tests' | 'both',
    reviewers,
    base: base || 'HEAD',
    created_at: new Date().toISOString(),
    state: 'running',
    candidates: candidatesRecords,
  };

  const dataDir = ctx.paths.featureDataDir('worktrees');
  saveBestOfRun(dataDir, run);

  return {
    ok: true,
    id: runId,
    run,
  };
}

export async function handleBestOfStatus(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<Record<string, unknown>> {
  const id = String(query.get('id') ?? '').trim();
  if (!id || !BESTOF_ID_REGEX.test(id)) {
    throw new ApiValidationError('Invalid best-of-N run id.', 400);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  // R2-1: Load the run file INSIDE withRunLock so concurrent background writes are never overwritten
  const updatedRun = await withRunLock(id, async () => {
    const run = loadBestOfRun(dataDir, id);
    if (!run) {
      throw new ApiValidationError(`Best-of-N run '${id}' not found.`, 404);
    }
    return await advanceBestOfRun(ctx, run);
  });

  return {
    ok: true,
    run: updatedRun,
  };
}

export async function handleBestOfList(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<Record<string, unknown>> {
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const bestofDir = getBestOfDir(dataDir);
  const rawProject = query.get('project_path');
  let projectPath: string | null = null;
  if (rawProject !== null && rawProject !== '') {
    projectPath = resolveProjectPath(rawProject, ctx.paths.projectsRoot);
    if (!projectPath) {
      throw new ApiValidationError('Invalid project path.', 400);
    }
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(bestofDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }

  const runs: BestOfRun[] = [];
  for (const f of files) {
    try {
      const run = JSON.parse(fs.readFileSync(path.win32.join(bestofDir, f), 'utf8')) as BestOfRun;
      if (run) {
        if (!projectPath || run.project_path.toLowerCase() === projectPath.toLowerCase()) {
          runs.push(run);
        }
      }
    } catch {
      // Ignore unreadable run files
    }
  }

  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    ok: true,
    runs: runs.slice(0, 20),
  };
}

export async function handleBestOfPick(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const id = String(body.id ?? '').trim();
  if (!id || !BESTOF_ID_REGEX.test(id)) {
    throw new ApiValidationError('Invalid best-of-N run id.', 400);
  }

  const candIndex = Number(body.candidate);
  if (!Number.isFinite(candIndex)) {
    throw new ApiValidationError('Candidate index is required.', 400);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  return await withRunLock(id, async () => {
    const run = loadBestOfRun(dataDir, id);
    if (!run) {
      throw new ApiValidationError(`Best-of-N run '${id}' not found.`, 404);
    }

    const candidate = run.candidates.find((c) => c.i === candIndex);
    if (!candidate) {
      throw new ApiValidationError(`Candidate ${candIndex} not found in run '${id}'.`, 404);
    }

    // N5, R2-6: Refuse (409) if picked candidate is RUNNING
    if (candidate.job_status === 'RUNNING' || (await isJobStillRunning(ctx, candidate.job_id))) {
      throw new ApiValidationError('Candidate job is still running.', 409);
    }

    // N5: Pass owner, message, remove, force to handleWorktreeMerge
    const mergeRes = await handleWorktreeMerge(ctx, {
      id: candidate.worktree_id,
      strategy: String(body.strategy ?? 'squash').trim() || 'squash',
      owner: body.owner,
      message: body.message,
      remove: body.remove,
      force: body.force === true,
      confirm: true,
    });

    if (mergeRes.merged !== true) {
      return mergeRes;
    }

    // N5: Cancel running jobs of other candidates before discarding
    if (body.discard_others !== false) {
      for (const other of run.candidates) {
        if (other.i !== candIndex) {
          if (other.job_id) {
            try {
              await handleCancelJob({ job_id: other.job_id }, ctx.paths);
            } catch {}
          }
          if (other.council?.job_id) {
            try {
              await handleCancelJob({ job_id: other.council.job_id }, ctx.paths);
            } catch {}
          }
          try {
            await handleWorktreeDiscard(ctx, {
              id: other.worktree_id,
              confirm: true,
            });
          } catch {
            // Ignore failure when discarding other candidate worktrees
          }
        }
      }
    }

    run.state = 'picked';
    run.picked = {
      i: candidate.i,
      merge_commit: String(mergeRes.commit ?? ''),
      at: new Date().toISOString(),
    };
    saveBestOfRun(dataDir, run);

    return {
      ok: true,
      merged: true,
      commit: String(mergeRes.commit ?? ''),
      picked: run.picked,
      run,
    };
  });
}

export async function handleBestOfCancel(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const id = String(body.id ?? '').trim();
  if (!id || !BESTOF_ID_REGEX.test(id)) {
    throw new ApiValidationError('Invalid best-of-N run id.', 400);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  return await withRunLock(id, async () => {
    const run = loadBestOfRun(dataDir, id);
    if (!run) {
      throw new ApiValidationError(`Best-of-N run '${id}' not found.`, 404);
    }

    // N5: Cancel running jobs and council jobs via handleCancelJob
    for (const c of run.candidates) {
      if (c.job_id) {
        try {
          await handleCancelJob({ job_id: c.job_id }, ctx.paths);
        } catch {}
      }
      if (c.council?.job_id) {
        try {
          await handleCancelJob({ job_id: c.council.job_id }, ctx.paths);
        } catch {}
      }
      c.job_status = 'CANCELLED';
    }

    run.state = 'cancelled';
    saveBestOfRun(dataDir, run);

    return {
      ok: true,
      cancelled: id,
    };
  });
}
