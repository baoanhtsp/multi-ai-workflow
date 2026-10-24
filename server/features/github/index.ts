import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { badRequest, conflict, fileMutex } from '../tasks/lib.ts';
import { ensureScheduler, registerTicker, triggerImmediateTick } from '../tasks/scheduler.ts';
import { createCard, getCards } from '../tasks/store.ts';
import { checkGhStatus, ensureGhReady, executeGh, throwGhNotInstalled, throwGhNotLoggedIn } from './client.ts';
import {
  createPrRequest,
  fetchPrFeedback,
  getPrRequests,
  githubTicker,
} from './pr.ts';

// Register github ticker in tasks scheduler
registerTicker('github', githubTicker);

export const feature: MawFeature = {
  name: 'github',
  ui: {
    script: 'feat-github.js',
  },
  routes: {
    github_status: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const rawProjectPath = req.url.searchParams.get('project_path');
        let projectPath: string | undefined;
        if (rawProjectPath) {
          const resolved = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
          if (!resolved) {
            throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
          }
          projectPath = resolved;
        }
        const gh = await checkGhStatus(projectPath);

        if (!gh.installed) {
          throwGhNotInstalled(req.res);
        }
        if (!gh.logged_in) {
          throwGhNotLoggedIn(req.res);
        }

        let repo: {
          name_with_owner: string;
          url: string;
          default_branch: string;
        } | null = null;

        if (projectPath) {
          const repoRes = await executeGh(
            ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'],
            { cwd: projectPath }
          );
          if (repoRes.code === 0) {
            try {
              const parsed = JSON.parse(repoRes.stdout) as {
                nameWithOwner?: string;
                url?: string;
                defaultBranchRef?: { name?: string };
              };
              if (parsed.nameWithOwner && parsed.url) {
                repo = {
                  name_with_owner: parsed.nameWithOwner,
                  url: parsed.url,
                  default_branch: parsed.defaultBranchRef?.name ?? 'main',
                };
              }
            } catch {
              repo = null;
            }
          }
        }

        return {
          ok: true,
          gh: {
            installed: gh.installed,
            version: gh.version,
            logged_in: gh.logged_in,
            user: gh.user,
          },
          repo,
        };
      },
    },

    github_issues: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const rawProjectPath = req.url.searchParams.get('project_path');
        let projectPath: string | undefined;
        if (rawProjectPath) {
          const resolved = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
          if (!resolved) {
            throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
          }
          projectPath = resolved;
        }
        await ensureGhReady(projectPath, req.res);

        const state = req.url.searchParams.get('state') ?? 'open';
        const limit = Math.max(1, Math.min(100, Number(req.url.searchParams.get('limit') ?? 30) || 30));
        const search = req.url.searchParams.get('search') ?? '';

        const args = [
          'issue',
          'list',
          '--json',
          'number,title,labels,url,author,updatedAt',
          '--limit',
          String(limit),
          '--state',
          state,
        ];
        if (search) {
          args.push('--search', search);
        }

        const res = await executeGh(args, { cwd: projectPath });
        if (res.code !== 0) {
          throw badRequest(`gh issue list failed: ${res.stderr || res.stdout}`);
        }

        let parsedList: any[] = [];
        try {
          parsedList = JSON.parse(res.stdout);
        } catch {
          parsedList = [];
        }

        const issues = parsedList.map((item) => ({
          number: Number(item.number ?? 0),
          title: String(item.title ?? ''),
          labels: Array.isArray(item.labels)
            ? item.labels.map((l: any) => String(l.name ?? l))
            : [],
          url: String(item.url ?? ''),
          author: String(item.author?.login ?? item.author ?? ''),
          updated_at: String(item.updatedAt ?? ''),
        }));

        return {
          ok: true,
          issues,
        };
      },
    },

    github_issue_import: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const rawProjectPath = String(req.body.project_path ?? '').trim();
        if (!rawProjectPath) {
          throw badRequest("Field 'project_path' is required.");
        }
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
        }

        const issueNumber = Number(req.body.number ?? 0);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          throw badRequest("Valid issue 'number' is required.");
        }

        await ensureGhReady(projectPath, req.res);

        const procLockFile = path.win32.join(
          ctx.paths.featureDataDir('github'),
          `import-${issueNumber}.lock`
        );
        fs.mkdirSync(path.dirname(procLockFile), { recursive: true });

        const lockStart = Date.now();
        let acquiredProcLock = false;
        while (Date.now() - lockStart < 3000) {
          try {
            const fd = fs.openSync(procLockFile, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
            fs.closeSync(fd);
            acquiredProcLock = true;
            break;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === 'EEXIST') {
              try {
                const st = fs.statSync(procLockFile);
                if (Date.now() - st.mtimeMs > 60000) {
                  try {
                    fs.unlinkSync(procLockFile);
                  } catch {}
                  continue;
                }
              } catch {
                continue;
              }
            }
          }
          await new Promise((r) => setTimeout(r, 60));
        }

        if (!acquiredProcLock) {
          throw conflict(`Another import is already in progress for issue #${issueNumber}.`);
        }

        try {
          const importLock = path.win32.join(ctx.paths.featureDataDir('github'), 'import.lock');
          return await fileMutex.runExclusive(importLock, async () => {
            // Check duplicate
            const allCards = await getCards(ctx, { project_path: projectPath });
            const existing = allCards.find(
              (c) => c.source?.kind === 'github-issue' && Number(c.source?.number) === issueNumber
            );
            if (existing) {
              throw conflict(
                `Issue #${issueNumber} has already been imported as card ${existing.id}.`
              );
            }

            const viewRes = await executeGh(
              ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,url'],
              { cwd: projectPath }
            );
            if (viewRes.code !== 0) {
              throw badRequest(`gh issue view failed: ${viewRes.stderr || viewRes.stdout}`);
            }

            let issueData: any;
            try {
              issueData = JSON.parse(viewRes.stdout);
            } catch {
              throw badRequest('Failed to parse gh issue view JSON.');
            }

            const title = String(issueData.title ?? '');
            const body = String(issueData.body ?? '');
            const url = String(issueData.url ?? '');
            const labels: string[] = Array.isArray(issueData.labels)
              ? issueData.labels.map((l: any) => String(l.name ?? l))
              : [];

            const cardTitle = `#${issueNumber} ${title}`.slice(0, 200);
            let prompt = `Resolve GitHub issue #${issueNumber}: ${title}\n\n${body}`;

            const card = await createCard(ctx, {
              title: cardTitle,
              prompt,
              project_path: projectPath,
              mode: req.body.mode ? String(req.body.mode).trim() : 'task',
              agent: req.body.agent ? String(req.body.agent).trim() : undefined,
              role: req.body.role ? String(req.body.role).trim() : 'backend',
              preset_id: req.body.preset_id ? String(req.body.preset_id).trim() : undefined,
              template_id: req.body.template_id ? String(req.body.template_id).trim() : undefined,
              vars: {
                number: String(issueNumber),
                title,
                body,
              },
              status: req.body.status ? String(req.body.status).trim() : 'backlog',
              labels,
              created_by: 'github',
              source: {
                kind: 'github-issue',
                number: issueNumber,
                url,
              },
            });

            triggerImmediateTick(ctx);
            return {
              ok: true,
              task: card,
            };
          });
        } finally {
          try {
            fs.unlinkSync(procLockFile);
          } catch {}
        }
      },
    },

    github_prs: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const rawProjectPath = req.url.searchParams.get('project_path');
        let projectPath: string | undefined;
        if (rawProjectPath) {
          const resolved = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
          if (!resolved) {
            throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
          }
          projectPath = resolved;
        }
        await ensureGhReady(projectPath, req.res);

        const res = await executeGh(
          [
            'pr',
            'list',
            '--json',
            'number,title,headRefName,url,reviewDecision,statusCheckRollup',
          ],
          { cwd: projectPath }
        );

        if (res.code !== 0) {
          throw badRequest(`gh pr list failed: ${res.stderr || res.stdout}`);
        }

        let parsed: any[] = [];
        try {
          parsed = JSON.parse(res.stdout);
        } catch {
          parsed = [];
        }

        const prs = parsed.map((item) => {
          let checks: 'pass' | 'fail' | 'pending' | 'none' = 'none';
          if (Array.isArray(item.statusCheckRollup) && item.statusCheckRollup.length > 0) {
            const hasFailure = item.statusCheckRollup.some((c: any) => {
              const state = String(c.conclusion ?? c.status ?? c.state ?? '').toUpperCase();
              return state === 'FAILURE' || state === 'FAIL' || state === 'TIMED_OUT';
            });
            const hasPending = item.statusCheckRollup.some((c: any) => {
              const state = String(c.conclusion ?? c.status ?? c.state ?? '').toUpperCase();
              return state === 'PENDING' || state === 'QUEUED' || state === 'IN_PROGRESS';
            });
            if (hasFailure) {
              checks = 'fail';
            } else if (hasPending) {
              checks = 'pending';
            } else {
              checks = 'pass';
            }
          }

          return {
            number: Number(item.number ?? 0),
            title: String(item.title ?? ''),
            head: String(item.headRefName ?? ''),
            url: String(item.url ?? ''),
            review_decision: String(item.reviewDecision ?? ''),
            checks,
          };
        });

        return {
          ok: true,
          prs,
        };
      },
    },

    github_pr_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const prReq = await createPrRequest(ctx, req.body, req.res);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          pr_request: prReq,
        };
      },
    },

    github_pr_requests: {
      method: 'GET',
      handler: async (ctx) => {
        ensureScheduler(ctx);
        const requests = await getPrRequests(ctx);
        return {
          ok: true,
          requests,
        };
      },
    },

    github_pr_feedback: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const result = await fetchPrFeedback(ctx, req.body, req.res);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          task: result.task,
          counts: result.counts,
        };
      },
    },
  },
};

export default feature;
