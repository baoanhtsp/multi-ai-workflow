import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { createCard, getCard, saveCard } from '../../tasks/store.ts';
import {
  clearGhStatusCache,
  ensureGhReady,
  setGhRunner,
  setGitRunner,
  type GhRunner,
} from '../client.ts';
import {
  createPrRequest,
  fetchPrFeedback,
  getPrRequests,
  githubTicker,
} from '../pr.ts';
import { feature } from '../index.ts';

function createGithubTestContext(testName: string): {
  ctx: MawFeatureContext;
  tempMawHome: string;
  projectDir: string;
  cleanup: () => void;
} {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempMawHome = path.join(os.tmpdir(), `maw_gh_test_${testName}_${rand}`);
  const tempProjects = path.join(tempMawHome, 'projects');
  const projectDir = path.join(tempProjects, 'app');

  fs.mkdirSync(projectDir, { recursive: true });

  const paths = resolveServerPaths({
    mawHome: tempMawHome,
    projectsRoot: tempProjects,
  });
  paths.projectsRoot = tempProjects;

  const registry = loadAgentRegistry(paths);

  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => [],
    startJob: async (body) => {
      const jobId = `job_desc_${Date.now()}`;
      const logFile = path.join(paths.jobsDir, `${jobId}.log`);
      const metaFile = path.join(paths.jobsDir, `${jobId}.json`);
      fs.mkdirSync(paths.jobsDir, { recursive: true });
      fs.writeFileSync(
        logFile,
        '=== PR_BODY_START ===\n## Summary\nImplemented PR feature\n=== PR_BODY_END ===\n'
      );
      fs.writeFileSync(
        metaFile,
        JSON.stringify({
          job_id: jobId,
          status: 'DONE',
          exit_code: 0,
          finished_at: new Date().toISOString(),
        })
      );
      return { ok: true, job_id: jobId, status: 'DONE' };
    },
  };

  const cleanup = () => {
    setGhRunner(null);
    setGitRunner(null);
    clearGhStatusCache();
    try {
      fs.rmSync(tempMawHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { ctx, tempMawHome, projectDir, cleanup };
}

test('github: missing gh cli returns 409 with gh: { installed: false }', async () => {
  const { projectDir, cleanup } = createGithubTestContext('missing_gh');
  try {
    // Inject mock runner returning code 1 (not installed / ENOENT)
    setGhRunner(async () => ({ code: 1, stdout: '', stderr: 'gh: command not found' }));
    clearGhStatusCache();

    await assert.rejects(
      async () => {
        await ensureGhReady(projectDir);
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.gh?.installed, false);
        assert.match(err.message, /GitHub CLI \(gh\) is not installed/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('github: not logged in returns 409 with gh: { installed: true, logged_in: false }', async () => {
  const { projectDir, cleanup } = createGithubTestContext('not_logged_in');
  try {
    // Version succeeds, auth fails
    setGitRunner(async (args) => {
      return { code: 0, stdout: 'Branch feat-awesome set up to track remote.\n', stderr: '' };
    });
    setGhRunner(async (args) => {
      if (args[0] === '--version') {
        return { code: 0, stdout: 'gh version 2.45.0 (2024-03-01)', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    clearGhStatusCache();

    await assert.rejects(
      async () => {
        await ensureGhReady(projectDir);
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.gh?.installed, true);
        assert.equal(err.gh?.logged_in, false);
        assert.match(err.message, /gh is not logged in/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('github: issue import creates card and rejects duplicate import', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('issue_import');
  try {
    setGitRunner(async (args) => {
      return { code: 0, stdout: 'Branch feat-awesome set up to track remote.\n', stderr: '' };
    });
    setGhRunner(async (args) => {
      if (args[0] === '--version') {
        return { code: 0, stdout: 'gh version 2.45.0', stderr: '' };
      }
      if (args[0] === 'auth') {
        return { code: 0, stdout: 'Logged in to github.com account octocat', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view' && args[2] === '42') {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            title: 'Fix login button layout',
            body: 'Button overflows on mobile screens.',
            labels: [{ name: 'ui' }, { name: 'bug' }],
            url: 'https://github.com/octocat/repo/issues/42',
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    clearGhStatusCache();

    // Import issue 42 via route handler
    const importRoute = feature.routes.github_issue_import!;
    const res1 = (await importRoute.handler(ctx as any, {
      ...ctx,
      body: {
        project_path: projectDir,
        number: 42,
        mode: 'task',
        agent: 'claude',
        role: 'frontend',
      },
      url: new URL('http://127.0.0.1/api?action=github_issue_import'),
      query: new URLSearchParams(),
      res: { headersSent: false, writableEnded: false } as any,
      req: {} as any,
      ctx,
    })) as any;

    assert.equal(res1.ok, true);
    assert.equal(res1.task.title, '#42 Fix login button layout');
    assert.equal(res1.task.created_by, 'github');
    assert.deepEqual(res1.task.labels, ['ui', 'bug']);
    assert.equal(res1.task.source.number, 42);

    // Duplicate import throws 409
    await assert.rejects(
      async () => {
        await importRoute.handler(ctx as any, {
          ...ctx,
          body: {
            project_path: projectDir,
            number: 42,
          },
          url: new URL('http://127.0.0.1/api?action=github_issue_import'),
          query: new URLSearchParams(),
          res: { headersSent: false, writableEnded: false } as any,
          req: {} as any,
          ctx,
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /already been imported/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('github: PR feedback creates fix card with comments, changes requested, and failed checks', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('pr_feedback');
  try {
    setGitRunner(async (args) => {
      return { code: 0, stdout: 'Branch feat-awesome set up to track remote.\n', stderr: '' };
    });
    setGhRunner(async (args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.45.0', stderr: '' };
      if (args[0] === 'auth') return { code: 0, stdout: 'account octocat', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'owner/repo' }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 101,
            title: 'Add dark mode',
            url: 'https://github.com/owner/repo/pull/101',
            headRefName: 'feat-dark-mode',
            reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'alice' }, body: 'Colors need contrast review' }],
            statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://ci.org/1' }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'api' && args[1]?.includes('comments')) {
        return {
          code: 0,
          stdout: JSON.stringify([
            { path: 'theme.ts', line: 15, body: 'Missing semicolon', user: { login: 'bob' } },
          ]),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    clearGhStatusCache();

    const result = await fetchPrFeedback(ctx, {
      project_path: projectDir,
      number: 101,
      mode: 'task',
      agent: 'claude',
      role: 'frontend',
    });

    assert.equal(result.counts.reviews, 1);
    assert.equal(result.counts.comments, 1);
    assert.equal(result.counts.failed_checks, 1);

    const task = result.task;
    assert.equal(task.created_by, 'github');
    assert.equal(task.source?.kind, 'github-pr');
    assert.equal(task.source?.number, 101);

    // Verify sections in prompt
    assert.ok(task.prompt.includes('## Review comments'));
    assert.ok(task.prompt.includes('theme.ts:15 — Missing semicolon (@bob)'));
    assert.ok(task.prompt.includes('## Reviews requesting changes'));
    assert.ok(task.prompt.includes('@alice: Colors need contrast review'));
    assert.ok(task.prompt.includes('## Failed checks'));
    assert.ok(task.prompt.includes('lint: FAILURE https://ci.org/1'));
  } finally {
    cleanup();
  }
});

test('github: PR create flow (describer job, git push, gh pr create)', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('pr_create');
  try {
    const executedGhCalls: string[][] = [];

    setGitRunner(async (args) => {
      return { code: 0, stdout: 'Branch feat-awesome set up to track remote.\n', stderr: '' };
    });
    setGhRunner(async (args) => {
      executedGhCalls.push([...args]);
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.45.0', stderr: '' };
      if (args[0] === 'auth') return { code: 0, stdout: 'account octocat', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { code: 0, stdout: 'https://github.com/owner/repo/pull/77\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    clearGhStatusCache();

    // Create an approved card
    const card = await createCard(ctx, {
      title: 'Awesome feature',
      prompt: 'Build awesome feature',
      project_path: projectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'backlog',
    });
    card.status = 'review';
    await saveCard(ctx, card);

    // Request PR creation on branch 'feat-awesome'
    const prReq = await createPrRequest(ctx, {
      task_id: card.id,
      branch: 'feat-awesome',
      base: 'main',
      ai_description: true,
    });

    assert.equal(prReq.state, 'describing');
    assert.ok(prReq.job_id);

    // Run ticker to process the PR request
    await githubTicker(ctx);

    const requests = await getPrRequests(ctx);
    const completedReq = requests.find((r) => r.id === prReq.id)!;

    // Verify ticker transitioned describing -> pushing -> creating -> done
    assert.equal(completedReq.state, 'done');
    assert.equal(completedReq.pr_url, 'https://github.com/owner/repo/pull/77');

    // Verify card was updated with pr info
    const updatedCard = (await getCard(ctx, card.id))!;
    assert.equal(updatedCard.pr?.number, 77);
    assert.equal(updatedCard.pr?.url, 'https://github.com/owner/repo/pull/77');

    // Verify gh pr create arguments
    const prCreateCall = executedGhCalls.find((c) => c[0] === 'pr' && c[1] === 'create');
    assert.ok(prCreateCall);
    assert.ok(prCreateCall.includes('--head'));
    assert.ok(prCreateCall.includes('feat-awesome'));
    assert.ok(prCreateCall.includes('--base'));
    assert.ok(prCreateCall.includes('main'));
    assert.ok(prCreateCall.includes('--title'));
  } finally {
    cleanup();
  }
});

test('github: branch and base ref injection rejected with 400', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('ref_injection');
  try {
    setGhRunner(async (args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.45.0', stderr: '' };
      if (args[0] === 'auth') {
        return { code: 0, stdout: 'Logged in to github.com', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    setGitRunner(async () => ({ code: 0, stdout: 'main\n', stderr: '' }));
    clearGhStatusCache();

    const card = await createCard(ctx, {
      title: 'Valid Card',
      prompt: 'Do work',
      project_path: projectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });
    card.status = 'review';
    await saveCard(ctx, card);

    // 1. Branch starting with dash / option injection
    await assert.rejects(
      async () => {
        await createPrRequest(ctx, {
          task_id: card.id,
          branch: '--receive-pack=calc',
          base: 'main',
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid git branch name/i);
        return true;
      }
    );

    // 2. Branch with .. path traversal
    await assert.rejects(
      async () => {
        await createPrRequest(ctx, {
          task_id: card.id,
          branch: 'feat..branch',
          base: 'main',
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid git branch name/i);
        return true;
      }
    );

    // 3. Branch ending with .lock
    await assert.rejects(
      async () => {
        await createPrRequest(ctx, {
          task_id: card.id,
          branch: 'feat.lock',
          base: 'main',
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid git branch name/i);
        return true;
      }
    );

    // 4. Base ref invalid
    await assert.rejects(
      async () => {
        await createPrRequest(ctx, {
          task_id: card.id,
          branch: 'feat-valid',
          base: '-bad-base',
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid git base ref/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('github: cancelled or missing describer job falls back to prompt and finishes PR', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('cancelled_describer');
  try {
    const executedGhCalls: string[][] = [];
    setGhRunner(async (args) => {
      executedGhCalls.push([...args]);
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.45.0', stderr: '' };
      if (args[0] === 'auth') {
        return { code: 0, stdout: 'Logged in to github.com account octocat', stderr: '' };
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { code: 0, stdout: 'https://github.com/owner/repo/pull/99\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    clearGhStatusCache();

    setGitRunner(async (args) => {
      if (args[0] === 'push') {
        return { code: 0, stdout: 'Everything up-to-date', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const card = await createCard(ctx, {
      title: 'PR Fallback Test',
      prompt: 'Crucial feature prompt',
      project_path: projectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });
    card.status = 'review';
    await saveCard(ctx, card);

    // Make describer job finish with CANCELLED
    ctx.startJob = async () => {
      const jobId = `job_cancelled_${Date.now()}`;
      const metaFile = path.join(ctx.paths.jobsDir, `${jobId}.json`);
      fs.mkdirSync(ctx.paths.jobsDir, { recursive: true });
      fs.writeFileSync(
        metaFile,
        JSON.stringify({
          job_id: jobId,
          status: 'CANCELLED',
          exit_code: null,
          finished_at: new Date().toISOString(),
        })
      );
      return { ok: true, job_id: jobId, status: 'CANCELLED' };
    };

    const prReq = await createPrRequest(ctx, {
      task_id: card.id,
      branch: 'feat-fallback',
      base: 'main',
      ai_description: true,
    });
    assert.equal(prReq.state, 'describing');

    // Run ticker step 1: describing should fall back to card.prompt and transition to pushing
    await githubTicker(ctx);
    let requests = await getPrRequests(ctx);
    let current = requests.find((r) => r.id === prReq.id)!;
    assert.equal(current.body_text, 'Crucial feature prompt');

    // Run ticker steps 2 & 3: pushing -> creating -> done
    await githubTicker(ctx);
    await githubTicker(ctx);

    requests = await getPrRequests(ctx);
    current = requests.find((r) => r.id === prReq.id)!;
    assert.equal(current.state, 'done');
    assert.equal(current.pr_url, 'https://github.com/owner/repo/pull/99');
  } finally {
    cleanup();
  }
});

test('github: project path outside projectsRoot rejected with 400 across all github routes', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('gh_path_validation');
  try {
    const outsidePath = path.resolve(os.tmpdir(), 'outside_gh_boundary');
    fs.mkdirSync(outsidePath, { recursive: true });

    // 1. github_status
    await assert.rejects(
      async () => {
        await feature.routes.github_status.handler(ctx as any, {
          url: new URL(`http://localhost/github_status?project_path=${encodeURIComponent(outsidePath)}`),
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 2. github_issues
    await assert.rejects(
      async () => {
        await feature.routes.github_issues.handler(ctx as any, {
          url: new URL(`http://localhost/github_issues?project_path=${encodeURIComponent(outsidePath)}`),
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 3. github_prs
    await assert.rejects(
      async () => {
        await feature.routes.github_prs.handler(ctx as any, {
          url: new URL(`http://localhost/github_prs?project_path=${encodeURIComponent(outsidePath)}`),
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 4. github_issue_import
    await assert.rejects(
      async () => {
        await feature.routes.github_issue_import.handler(ctx as any, {
          body: {
            project_path: outsidePath,
            number: 1,
          },
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 5. github_pr_feedback
    await assert.rejects(
      async () => {
        await feature.routes.github_pr_feedback.handler(ctx as any, {
          body: {
            project_path: outsidePath,
            number: 1,
          },
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 6. github_pr_create (via createPrRequest with card pointing to outsidePath)
    // Create card in projectDir first, then mutate project_path to outsidePath
    const badCard = await createCard(ctx, {
      title: 'Valid card first',
      prompt: 'Prompt',
      project_path: projectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });
    badCard.status = 'review';
    badCard.project_path = outsidePath;
    await saveCard(ctx, badCard);

    await assert.rejects(
      async () => {
        await createPrRequest(ctx, { task_id: badCard.id });
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('github: PR replay adopts existing open PR before calling gh pr create', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('pr_replay_adopt');
  try {
    let prCreateCalled = false;
    clearGhStatusCache();

    setGhRunner(async (args) => {
      if (args[0] === '--version' || args[0] === 'version') {
        return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return { code: 0, stdout: 'Logged in to github.com as testuser', stderr: '' };
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
          stderr: '',
        };
      }
      // Replay check before pr create: gh pr list --head <branch> --base <base> --state open
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              url: 'https://github.com/owner/repo/pull/42',
            },
          ]),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        prCreateCalled = true;
        return { code: 0, stdout: 'https://github.com/owner/repo/pull/99', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    setGitRunner(async (args) => {
      if (args[0] === 'rev-parse') {
        return { code: 0, stdout: 'feat-replay-branch', stderr: '' };
      }
      if (args[0] === 'push') {
        return { code: 0, stdout: 'Everything up-to-date', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const card = await createCard(ctx, {
      title: 'PR Replay Task',
      prompt: 'Replay feature prompt',
      project_path: projectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });
    card.status = 'review';
    await saveCard(ctx, card);

    const prReq = await createPrRequest(ctx, {
      task_id: card.id,
      branch: 'feat-replay-branch',
      base: 'main',
      ai_description: false,
    });
    assert.equal(prReq.state, 'pushing');

    // Ticker runs: pushes and adopts existing open PR #42 in creating step
    await githubTicker(ctx);

    // Verify gh pr create was NEVER called
    assert.equal(prCreateCalled, false, 'gh pr create should not be called when open PR exists');

    const requests = await getPrRequests(ctx);
    const current = requests.find((r) => r.id === prReq.id)!;
    assert.equal(current.state, 'done');
    assert.equal(current.pr_url, 'https://github.com/owner/repo/pull/42');

    const updatedCard = (await getCard(ctx, card.id))!;
    assert.deepEqual(updatedCard.pr, {
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
    });

    // Check action audit file ($MAW_HOME/audit.jsonl) for github_pr_adopt
    const actionAuditFile = path.win32.join(ctx.paths.mawHome, 'audit.jsonl');
    const auditText = fs.readFileSync(actionAuditFile, 'utf8');
    assert.ok(auditText.includes('github_pr_adopt'));
  } finally {
    cleanup();
  }
});

test('github: concurrent duplicate issue imports serialize and throw 409 conflict', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('concurrent_issue_import');
  try {
    clearGhStatusCache();

    setGhRunner(async (args) => {
      if (args[0] === '--version' || args[0] === 'version') {
        return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return { code: 0, stdout: 'Logged in as testuser', stderr: '' };
      }
      if (args[0] === 'version') {
        return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        // Add a small delay to simulate real I/O and expose any race conditions
        await new Promise((r) => setTimeout(r, 20));
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 10,
            title: 'Race Condition Issue',
            body: 'Fix concurrency bug',
            labels: [{ name: 'bug' }],
            url: 'https://github.com/owner/repo/issues/10',
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    // Fire 2 simultaneous imports for issue 10
    const [res1, res2] = await Promise.allSettled([
      feature.routes.github_issue_import.handler(ctx as any, {
        body: {
          project_path: projectDir,
          number: 10,
          agent: 'antigravity',
          role: 'backend',
        },
      } as any),
      feature.routes.github_issue_import.handler(ctx as any, {
        body: {
          project_path: projectDir,
          number: 10,
          agent: 'antigravity',
          role: 'backend',
        },
      } as any),
    ]);

    // Exactly one should fulfill and one should reject with 409
    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const rejectedErr = (rejected[0] as PromiseRejectedResult).reason;
    assert.equal(rejectedErr.statusCode, 409);
    assert.match(rejectedErr.message, /already been imported/i);
  } finally {
    cleanup();
  }
});

test('github: cross-process issue-import lock handles stale lock and protects concurrent imports', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('proc_import_lock');
  try {
    clearGhStatusCache();

    setGhRunner(async (args) => {
      if (args[0] === '--version' || args[0] === 'version') {
        return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return { code: 0, stdout: 'Logged in as testuser', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        const num = args[2];
        return {
          code: 0,
          stdout: JSON.stringify({
            number: Number(num),
            title: `Issue ${num}`,
            body: `Body ${num}`,
            labels: [],
            url: `https://github.com/owner/repo/issues/${num}`,
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const lockDir = ctx.paths.featureDataDir('github');
    fs.mkdirSync(lockDir, { recursive: true });

    const projectHash = crypto
      .createHash('sha1')
      .update(projectDir.toLowerCase())
      .digest('hex')
      .slice(0, 12);

    // 1. Stale lock (> 120s old) should be automatically cleared and import succeeds
    const staleLock = path.join(lockDir, `import-${projectHash}-20.lock`);
    fs.writeFileSync(staleLock, JSON.stringify({ token: 'old-token', pid: 999999, at: 'old' }), 'utf8');
    const oldTime = new Date(Date.now() - 130000);
    fs.utimesSync(staleLock, oldTime, oldTime);

    const res = await feature.routes.github_issue_import.handler(ctx as any, {
      body: {
        project_path: projectDir,
        number: 20,
        agent: 'antigravity',
        role: 'backend',
      },
    } as any);

    assert.ok(res);
    assert.equal(fs.existsSync(staleLock), false, 'Lock must be cleaned up in finally');

    // 2. Active lock held by another process causes timeout and 409
    const activeLock = path.join(lockDir, `import-${projectHash}-21.lock`);
    fs.writeFileSync(activeLock, JSON.stringify({ token: 'fresh-token', pid: process.pid + 5, at: 'fresh' }), 'utf8');

    await assert.rejects(
      async () => {
        await feature.routes.github_issue_import.handler(ctx as any, {
          body: {
            project_path: projectDir,
            number: 21,
            agent: 'antigravity',
            role: 'backend',
          },
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /already in progress for issue #21/i);
        return true;
      }
    );

    // Clean up activeLock
    try {
      fs.unlinkSync(activeLock);
    } catch {}
  } finally {
    cleanup();
  }
});

test('github: import lock token guard preserves foreign lock in finally and keys lock per project', async () => {
  const { ctx, projectDir, cleanup } = createGithubTestContext('token_guard_lock');
  try {
    clearGhStatusCache();

    setGhRunner(async (args) => {
      if (args[0] === '--version' || args[0] === 'version') {
        return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return { code: 0, stdout: 'Logged in as testuser', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 30,
            title: 'Issue 30',
            body: 'Body 30',
            labels: [],
            url: 'https://github.com/owner/repo/issues/30',
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const lockDir = ctx.paths.featureDataDir('github');
    fs.mkdirSync(lockDir, { recursive: true });

    const projectHash = crypto
      .createHash('sha1')
      .update(projectDir.toLowerCase())
      .digest('hex')
      .slice(0, 12);
    const lockFile = path.join(lockDir, `import-${projectHash}-30.lock`);

    // Verify keying: another project directory produces a different lock file path
    const project2Dir = path.join(ctx.paths.projectsRoot, 'other_proj');
    fs.mkdirSync(project2Dir, { recursive: true });
    const project2Hash = crypto
      .createHash('sha1')
      .update(project2Dir.toLowerCase())
      .digest('hex')
      .slice(0, 12);
    assert.notEqual(projectHash, project2Hash, 'Different projects must have different lock keys');

    // Run import, but during execution overwrite the lock with a foreign token
    // We intercept setGhRunner to simulate another process replacing the lock while gh is running
    setGhRunner(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        // Another process took over or replaced the lock
        fs.writeFileSync(
          lockFile,
          JSON.stringify({ token: 'foreign-token-999', pid: 99999, at: new Date().toISOString() }),
          'utf8'
        );
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 30,
            title: 'Issue 30',
            body: 'Body 30',
            labels: [],
            url: 'https://github.com/owner/repo/issues/30',
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: 'gh version 2.50.0', stderr: '' };
    });

    const res = await feature.routes.github_issue_import.handler(ctx as any, {
      body: {
        project_path: projectDir,
        number: 30,
        agent: 'antigravity',
        role: 'backend',
      },
    } as any);

    assert.ok(res);
    // Finally must NOT have unlinked the file because it held foreign-token-999
    assert.ok(fs.existsSync(lockFile), 'Finally must not delete lock holding a foreign token');
    const remaining = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(remaining.token, 'foreign-token-999');

    // Cleanup foreign lock
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  } finally {
    cleanup();
  }
});
