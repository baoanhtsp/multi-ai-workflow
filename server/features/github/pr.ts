import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import {
  appendAudit,
  badRequest,
  conflict,
  fileMutex,
  newId,
  notFound,
  readJson,
  stripAnsi,
  writeJsonAtomic,
} from '../tasks/lib.ts';
import { getPreset } from '../tasks/presets.ts';
import {
  createCard,
  getCard,
  patchCard,
  type Card,
  type TaskMode,
  type TaskRole,
} from '../tasks/store.ts';
import { ensureGhReady, executeGh, executeGit } from './client.ts';

const GIT_REF_REGEX = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;

export function isValidGitRef(ref: string): boolean {
  if (!ref || !GIT_REF_REGEX.test(ref)) return false;
  if (ref.endsWith('.lock') || ref.endsWith('/')) return false;
  if (ref.startsWith('/')) return false;
  return true;
}

export interface PrRequest {
  id: string;
  task_id: string;
  project_path: string;
  branch: string;
  base: string;
  state: 'describing' | 'pushing' | 'creating' | 'done' | 'failed';
  job_id: string | null;
  pr_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  body_text?: string;
}

export function getPrRequestsFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('github'), 'pr_requests.json');
}

export async function getPrRequests(ctx: MawFeatureContext): Promise<PrRequest[]> {
  const file = getPrRequestsFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<{ version: 1; requests: PrRequest[] }>(file, {
      version: 1,
      requests: [],
    });
    const list = Array.isArray(raw.requests) ? raw.requests : [];
    return list.slice(-50).reverse();
  });
}

export async function createPrRequest(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>,
  res?: ServerResponse
): Promise<PrRequest> {
  const taskId = String(raw.task_id ?? '').trim();
  if (!taskId) {
    throw badRequest("Field 'task_id' is required.");
  }

  const card = await getCard(ctx, taskId);
  if (!card) {
    throw notFound(`Task card not found: ${taskId}`);
  }

  if (card.status !== 'review' && card.status !== 'done') {
    throw conflict("Cannot create PR: task card must be in 'review' or 'done' status.");
  }

  const rawProjectPath = card.project_path;
  const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
  }
  await ensureGhReady(projectPath, res);

  // 1. Determine branch
  let branch = String(raw.branch ?? '').trim();
  if (!branch) {
    const lastAttempt = card.attempts[card.attempts.length - 1];
    if (lastAttempt?.branch) {
      branch = lastAttempt.branch;
    }
  }

  if (!branch) {
    const branchRes = await executeGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
    });
    if (branchRes.code === 0 && branchRes.stdout.trim()) {
      branch = branchRes.stdout.trim();
    }
  }

  if (!branch || branch === 'HEAD') {
    throw badRequest('Could not determine git branch for PR creation.');
  }

  if (!isValidGitRef(branch)) {
    throw badRequest(`Invalid git branch name: '${branch}'`);
  }

  // 2. Determine base branch
  let base = String(raw.base ?? '').trim();
  if (!base) {
    // Try to get default branch via gh repo view
    const repoRes = await executeGh(['repo', 'view', '--json', 'defaultBranchRef'], {
      cwd: projectPath,
    });
    if (repoRes.code === 0) {
      try {
        const repoObj = JSON.parse(repoRes.stdout) as { defaultBranchRef?: { name?: string } };
        if (repoObj.defaultBranchRef?.name) {
          base = repoObj.defaultBranchRef.name;
        }
      } catch {
        // Fallback
      }
    }
  }
  if (!base) {
    base = 'main';
  }

  if (!isValidGitRef(base)) {
    throw badRequest(`Invalid git base ref: '${base}'`);
  }

  if (branch.toLowerCase() === base.toLowerCase()) {
    throw badRequest('Cannot create PR: create a branch first.');
  }

  const reqId = newId('pr');
  const draft = Boolean(raw.draft);
  const aiDescription = raw.ai_description !== false;

  let jobId: string | null = null;
  let state: PrRequest['state'] = 'pushing';

  if (aiDescription) {
    state = 'describing';
    let reviewerAgent = String(raw.reviewer_agent ?? '').trim();
    if (!reviewerAgent && card.preset_id) {
      const preset = await getPreset(ctx, card.preset_id);
      if (preset?.reviewers && preset.reviewers.length > 0) {
        reviewerAgent = preset.reviewers[0]!;
      }
    }
    if (!reviewerAgent) {
      reviewerAgent = ctx.registry?.defaults?.team?.reviewer || 'claude';
    }

    const prompt = `Write a Pull Request description for git diff ${base}...${branch} in project ${path.basename(projectPath)}.\nProvide a clear summary with sections Summary, Changes, and Testing.\n\nStart your description with === PR_BODY_START === and finish with === PR_BODY_END ===.`;
    const descJob = await ctx.startJob({
      mode: 'task',
      agent: reviewerAgent,
      role: 'reviewer',
      project_path: projectPath,
      prompt,
    });
    jobId = String(descJob.job_id ?? '');
  }

  const prReq: PrRequest = {
    id: reqId,
    task_id: taskId,
    project_path: projectPath,
    branch,
    base,
    state,
    job_id: jobId,
    pr_url: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    draft,
  };

  const file = getPrRequestsFile(ctx);
  await fileMutex.runExclusive(file, () => {
    const rawData = readJson<{ version: 1; requests: PrRequest[] }>(file, {
      version: 1,
      requests: [],
    });
    if (!Array.isArray(rawData.requests)) rawData.requests = [];
    rawData.requests.push(prReq);
    if (rawData.requests.length > 50) {
      rawData.requests = rawData.requests.slice(-50);
    }
    writeJsonAtomic(file, rawData);
  });

  return prReq;
}

export async function githubTicker(ctx: MawFeatureContext): Promise<void> {
  const file = getPrRequestsFile(ctx);
  await fileMutex.runExclusive(file, async () => {
    const rawData = readJson<{ version: 1; requests: PrRequest[] }>(file, {
      version: 1,
      requests: [],
    });
    if (!Array.isArray(rawData.requests)) return;

    let modified = false;

    for (const req of rawData.requests) {
      if (req.state === 'done' || req.state === 'failed') {
        continue;
      }

      const card = await getCard(ctx, req.task_id);
      if (!card) {
        req.state = 'failed';
        req.error = `Task ${req.task_id} not found.`;
        req.updated_at = new Date().toISOString();
        modified = true;
        continue;
      }

      // Step 1: Handle describing
      if (req.state === 'describing') {
        if (!req.job_id) {
          req.body_text = card.prompt;
          req.state = 'pushing';
          req.updated_at = new Date().toISOString();
          modified = true;
        } else {
          const metaFile = path.win32.join(ctx.paths.jobsDir, `${req.job_id}.json`);
          let meta: JobMeta | null = null;
          let metaExists = false;
          try {
            if (fs.existsSync(metaFile)) {
              metaExists = true;
              meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
              meta = await refreshJobMetaStatus(meta, ctx.paths.jobsDir);
            }
          } catch {
            meta = null;
          }

          if (
            !metaExists ||
            (meta && (meta.status === 'DONE' || meta.status === 'FAILED' || meta.status === 'CANCELLED'))
          ) {
            let bodyText = '';
            const lastAttempt = card.attempts[card.attempts.length - 1];
            const attemptSummary = lastAttempt?.findings ? `\n\n### Summary\n${lastAttempt.findings}` : '';

            if (meta && meta.status === 'DONE') {
              const logFile = path.win32.join(ctx.paths.jobsDir, `${req.job_id}.log`);
              let logTail = '';
              try {
                if (fs.existsSync(logFile)) {
                  logTail = stripAnsi(fs.readFileSync(logFile, 'utf8'));
                }
              } catch {
                logTail = '';
              }

              const startMarker = '=== PR_BODY_START ===';
              const endMarker = '=== PR_BODY_END ===';
              const sIdx = logTail.lastIndexOf(startMarker);
              if (sIdx >= 0) {
                const eIdx = logTail.indexOf(endMarker, sIdx + startMarker.length);
                if (eIdx > sIdx) {
                  bodyText = logTail.slice(sIdx + startMarker.length, eIdx).trim();
                } else {
                  bodyText = logTail.slice(sIdx + startMarker.length).trim();
                }
              } else if (logTail) {
                bodyText = logTail.slice(-4000).trim();
              }
            }

            if (!bodyText) {
              bodyText = `${card.prompt}${attemptSummary}`.trim();
            }

            req.body_text = bodyText;
            req.state = 'pushing';
            req.updated_at = new Date().toISOString();
            modified = true;
          }
        }
      }

      // Step 2: Handle pushing
      if (req.state === 'pushing') {
        const pushRes = await executeGit(['push', '-u', 'origin', req.branch], {
          cwd: req.project_path,
        });

        appendAudit(ctx.paths.auditFile, 'git_push', {
          project_path: req.project_path,
          branch: req.branch,
          exit_code: pushRes.code,
        });

        if (pushRes.code !== 0 && !pushRes.stderr.includes('Everything up-to-date')) {
          req.state = 'failed';
          req.error = `git push failed: ${pushRes.stderr || pushRes.stdout}`;
          req.updated_at = new Date().toISOString();
          modified = true;
          continue;
        }

        req.state = 'creating';
        req.updated_at = new Date().toISOString();
        modified = true;
      }

      // Step 3: Handle creating
      if (req.state === 'creating') {
        // Replay check: adopt existing open PR if found
        let adoptedPr: { number: number; url: string } | null = null;
        try {
          const listRes = await executeGh(
            ['pr', 'list', '--head', req.branch, '--base', req.base, '--state', 'open', '--json', 'number,url', '--limit', '1'],
            { cwd: req.project_path }
          );
          if (listRes.code === 0) {
            const listJson = JSON.parse(listRes.stdout);
            if (Array.isArray(listJson) && listJson.length > 0 && listJson[0]?.url) {
              adoptedPr = {
                number: Number(listJson[0].number || 0),
                url: String(listJson[0].url),
              };
            }
          }
        } catch {
          // ignore error and proceed to gh pr create
        }

        if (adoptedPr) {
          req.state = 'done';
          req.pr_url = adoptedPr.url;
          req.updated_at = new Date().toISOString();

          await patchCard(ctx, card.id, (c) => {
            c.pr = { number: adoptedPr.number, url: adoptedPr.url };
          });

          appendAudit(ctx.paths.auditFile, 'github_pr_adopt', {
            task_id: card.id,
            pr_url: adoptedPr.url,
            pr_number: adoptedPr.number,
          });

          modified = true;
          continue;
        }

        const bodyContent = req.body_text || card.prompt;
        const tmpFile = path.win32.join(ctx.paths.featureDataDir('github'), `pr_body_${req.id}.md`);
        fs.writeFileSync(tmpFile, bodyContent, 'utf8');

        try {
          const prArgs = [
            'pr',
            'create',
            '--head',
            req.branch,
            '--base',
            req.base,
            '--title',
            card.title,
            '--body-file',
            tmpFile,
          ];
          if (req.draft) {
            prArgs.push('--draft');
          }

          const createRes = await executeGh(prArgs, { cwd: req.project_path });

          if (createRes.code !== 0) {
            req.state = 'failed';
            req.error = `gh pr create failed: ${createRes.stderr || createRes.stdout}`;
            req.updated_at = new Date().toISOString();
            modified = true;
            continue;
          }

          const stdoutText = createRes.stdout.trim();
          const urlMatch = /https:\/\/github\.com\/[^\s]+/i.exec(stdoutText);
          const prUrl = urlMatch ? urlMatch[0]! : stdoutText;

          let prNumber = 0;
          const numMatch = /\/pull\/(\d+)/i.exec(prUrl);
          if (numMatch) {
            prNumber = Number.parseInt(numMatch[1]!, 10);
          }

          req.state = 'done';
          req.pr_url = prUrl;
          req.updated_at = new Date().toISOString();

          await patchCard(ctx, card.id, (c) => {
            c.pr = { number: prNumber, url: prUrl };
          });

          appendAudit(ctx.paths.auditFile, 'github_pr_create', {
            task_id: card.id,
            pr_url: prUrl,
          });

          modified = true;
        } finally {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // ignore cleanup
          }
        }
      }
    }

    if (modified) {
      writeJsonAtomic(file, rawData);
    }
  });
}

export async function fetchPrFeedback(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>,
  res?: ServerResponse
): Promise<{
  task: Card;
  counts: { reviews: number; comments: number; failed_checks: number };
}> {
  const rawProjectPath = String(raw.project_path ?? '').trim();
  if (!rawProjectPath) {
    throw badRequest("Field 'project_path' is required.");
  }
  const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
  }

  const prNumber = Number(raw.number ?? 0);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw badRequest("Valid PR 'number' is required.");
  }

  await ensureGhReady(projectPath, res);

  const viewRes = await executeGh(
    [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'number,title,url,headRefName,reviews,comments,statusCheckRollup',
    ],
    { cwd: projectPath }
  );

  if (viewRes.code !== 0) {
    throw badRequest(`gh pr view failed: ${viewRes.stderr || viewRes.stdout}`);
  }

  let prData: any;
  try {
    prData = JSON.parse(viewRes.stdout);
  } catch {
    throw badRequest('Failed to parse gh pr view JSON output.');
  }

  const title = String(prData.title ?? '');
  const url = String(prData.url ?? '');
  const headRefName = String(prData.headRefName ?? '');

  // 1. Review comments (inline)
  const reviewComments: Array<{ path: string; line: number; body: string; author: string }> = [];

  // Try gh api for review comments
  const repoRes = await executeGh(['repo', 'view', '--json', 'nameWithOwner'], {
    cwd: projectPath,
  });
  if (repoRes.code === 0) {
    try {
      const repoObj = JSON.parse(repoRes.stdout) as { nameWithOwner?: string };
      if (repoObj.nameWithOwner) {
        const apiRes = await executeGh(
          ['api', `repos/${repoObj.nameWithOwner}/pulls/${prNumber}/comments`],
          { cwd: projectPath }
        );
        if (apiRes.code === 0) {
          const apiComments = JSON.parse(apiRes.stdout);
          if (Array.isArray(apiComments)) {
            for (const c of apiComments) {
              reviewComments.push({
                path: String(c.path ?? ''),
                line: Number(c.line ?? c.original_line ?? 0),
                body: String(c.body ?? '').trim(),
                author: String(c.user?.login ?? 'reviewer'),
              });
            }
          }
        }
      }
    } catch {
      // Fallback
    }
  }

  // 2. Reviews requesting changes
  const reviewsReqChanges: Array<{ author: string; body: string }> = [];
  if (Array.isArray(prData.reviews)) {
    for (const r of prData.reviews) {
      if (String(r.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
        reviewsReqChanges.push({
          author: String(r.author?.login ?? 'reviewer'),
          body: String(r.body ?? '').trim(),
        });
      }
    }
  }

  // 3. Failed status checks
  const failedChecks: Array<{ name: string; conclusion: string; url: string }> = [];
  if (Array.isArray(prData.statusCheckRollup)) {
    for (const chk of prData.statusCheckRollup) {
      const conclusion = String(chk.conclusion ?? chk.status ?? '').toUpperCase();
      if (conclusion === 'FAILURE' || conclusion === 'FAIL' || conclusion === 'TIMED_OUT') {
        failedChecks.push({
          name: String(chk.name ?? chk.context ?? 'check'),
          conclusion,
          url: String(chk.detailsUrl ?? chk.targetUrl ?? ''),
        });
      }
    }
  }

  const reviewCount = reviewsReqChanges.length;
  const commentCount = reviewComments.length;
  const checkCount = failedChecks.length;

  if (reviewCount === 0 && commentCount === 0 && checkCount === 0) {
    throw badRequest(`PR #${prNumber} has no review comments or failed checks.`);
  }

  const promptSections: string[] = [
    `Fix the review feedback on PR #${prNumber} "${title}" (branch ${headRefName}).`,
  ];

  if (commentCount > 0) {
    promptSections.push('## Review comments');
    for (const rc of reviewComments) {
      promptSections.push(`- ${rc.path}:${rc.line} — ${rc.body} (@${rc.author})`);
    }
  }

  if (reviewCount > 0) {
    promptSections.push('## Reviews requesting changes');
    for (const rv of reviewsReqChanges) {
      promptSections.push(`- @${rv.author}: ${rv.body}`);
    }
  }

  if (checkCount > 0) {
    promptSections.push('## Failed checks');
    for (const fc of failedChecks) {
      promptSections.push(`- ${fc.name}: ${fc.conclusion} ${fc.url}`);
    }
  }

  const fullPrompt = promptSections.join('\n');
  const cardTitle = `Fix PR #${prNumber}: ${title}`.slice(0, 200);

  const mode = (String(raw.mode ?? 'task').trim() || 'task') as TaskMode;
  const agent = String(raw.agent ?? '').trim();
  const role = (String(raw.role ?? 'backend').trim() || 'backend') as TaskRole;

  const card = await createCard(ctx, {
    title: cardTitle,
    prompt: fullPrompt,
    project_path: projectPath,
    mode,
    agent,
    role,
    status: raw.status ? String(raw.status).trim() : 'backlog',
    created_by: 'github',
    source: {
      kind: 'github-pr',
      number: prNumber,
      url,
      branch: headRefName,
    },
  });

  return {
    task: card,
    counts: {
      reviews: reviewCount,
      comments: commentCount,
      failed_checks: checkCount,
    },
  };
}
