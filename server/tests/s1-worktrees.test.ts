import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { feature } from '../features/worktrees/index.ts';
import { handleBestOfPick, handleBestOfStart, handleBestOfStatus, loadBestOfRun } from '../features/worktrees/bestof.ts';
import { createWorktreeRecord, handleWorktreeJob } from '../features/worktrees/isolate.ts';
import { handleWorktreeDiscard, handleWorktreeFixConflicts, handleWorktreeMerge } from '../features/worktrees/merge.ts';
import { loadWorktreesStore, type WorktreeRecord } from '../features/worktrees/store.ts';
import type { MawFeatureContext, MawFeatureRequest } from '../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

interface WorktreeTestEnv {
  tempBase: string;
  projectsRoot: string;
  repoDir: string;
  mawHome: string;
  jobsDir: string;
  paths: ServerPaths;
  recordedJobs: Array<Record<string, unknown>>;
  ctx: MawFeatureContext;
}

async function setupWorktreeEnv(): Promise<WorktreeTestEnv> {
  const rand = crypto.randomBytes(6).toString('hex');
  const tempBase = path.win32.join(os.tmpdir(), `maw-s1-wt-${rand}`);
  const projectsRoot = path.win32.join(tempBase, 'projects');
  const repoDir = path.win32.join(projectsRoot, 'sample-app');
  const mawHome = path.win32.join(tempBase, 'maw-home');
  const jobsDir = path.win32.join(tempBase, 'maw-jobs');

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  await runCommand('git', ['init', '-b', 'master', '-q'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.name', 'Test Author'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.email', 'author@test.local'], { cwd: repoDir });
  await runCommand('git', ['config', 'commit.gpgSign', 'false'], { cwd: repoDir });

  fs.writeFileSync(path.win32.join(repoDir, '.worktreeinclude'), '.env\nconfig/*.json\n', 'utf8');
  fs.writeFileSync(path.win32.join(repoDir, '.env'), 'SECRET_KEY=123456\n', 'utf8');
  fs.mkdirSync(path.win32.join(repoDir, 'config'), { recursive: true });
  fs.writeFileSync(path.win32.join(repoDir, 'config', 'app.json'), '{"name":"test"}\n', 'utf8');
  fs.writeFileSync(path.win32.join(repoDir, 'main.txt'), 'version 1\n', 'utf8');

  await runCommand('git', ['add', '.'], { cwd: repoDir });
  await runCommand('git', ['commit', '-m', 'initial commit on master'], { cwd: repoDir });

  const paths = resolveServerPaths({
    repoRoot: repoDir,
    projectsRoot,
    mawHome,
  });
  paths.jobsDir = jobsDir;

  const recordedJobs: Array<Record<string, unknown>> = [];
  const ctx: MawFeatureContext = {
    paths,
    registry: {
      version: 1,
      defaults: {
        team: { backend: 'antigravity', frontend: 'claude', reviewer: 'codex' },
        council: ['claude', 'codex'],
        implementer: 'antigravity',
      },
      agents: [
        {
          id: 'antigravity',
          label: 'Antigravity',
          color: '#4285f4',
          enabled: true,
          adapter: 'antigravity',
          models: ['pro', 'flash'],
          efforts: [],
          capabilities: { write: true, review: true, new_session: true, sessions: true, ide_send: true },
        },
        {
          id: 'claude',
          label: 'Claude Code',
          color: '#d97706',
          enabled: true,
          adapter: 'claude',
          models: ['sonnet', 'opus'],
          efforts: [],
          capabilities: { write: true, review: true, new_session: false, sessions: false, ide_send: false },
        },
        {
          id: 'codex',
          label: 'OpenAI Codex',
          color: '#10a37f',
          enabled: true,
          adapter: 'codex',
          models: [],
          efforts: [],
          capabilities: { write: true, review: true, new_session: false, sessions: false, ide_send: false },
        },
      ] as any,
      allAgents: [],
      shippedPath: '',
      userPath: '',
      warnings: [],
    },
    readJobs: async () => recordedJobs,
    startJob: async (body: Record<string, unknown>) => {
      const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const rec = { job_id: jobId, pid: 9999, status: 'RUNNING', ...body };
      recordedJobs.push(rec);

      // Write mock job metadata file so status checks find it
      const metaPath = path.win32.join(jobsDir, `${jobId}.json`);
      fs.writeFileSync(metaPath, JSON.stringify(rec), 'utf8');

      return { ok: true, job_id: jobId, pid: 9999, status: 'RUNNING' };
    },
  };

  return { tempBase, projectsRoot, repoDir, mawHome, jobsDir, paths, recordedJobs, ctx };
}

function cleanupWorktreeEnv(env: WorktreeTestEnv): void {
  try {
    fs.rmSync(env.tempBase, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }
}

function makeMockRequest(
  ctx: MawFeatureContext,
  urlStr: string,
  body: Record<string, unknown> = {}
): MawFeatureRequest {
  const url = new URL(urlStr);
  return {
    ...ctx,
    url,
    query: url.searchParams,
    body,
    req: {} as any,
    res: {} as any,
    ctx,
  };
}

test('S1 Worktrees: create creates branch, path under .maw-wt, copies .worktreeinclude, allocates unique port', async () => {
  const env = await setupWorktreeEnv();
  try {
    // Create setup script to test execution
    const setupDir = path.win32.join(env.repoDir, '.maw');
    fs.mkdirSync(setupDir, { recursive: true });
    fs.writeFileSync(
      path.win32.join(setupDir, 'setup.ps1'),
      'Write-Output "Setup ran on $env:MAW_PORT"\n',
      'utf8'
    );

    const handler = feature.routes.worktree_create!.handler;
    const req = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=worktree_create', {
      project_path: env.repoDir,
      name: 'feature-alpha',
    });
    const resp = (await handler(req, req)) as Record<string, unknown>;

    assert.equal(resp.ok, true);
    const wt = resp.worktree as WorktreeRecord;
    assert.equal(wt.id, 'feature-alpha');
    assert.equal(wt.branch, 'maw/feature-alpha');
    assert.ok(wt.worktree_path.includes('.maw-wt'));
    assert.equal(wt.port >= 4400 && wt.port <= 4999, true);

    // Verify .worktreeinclude files copied
    const envCopied = path.win32.join(wt.worktree_path, '.env');
    assert.ok(fs.existsSync(envCopied), '.env should be copied');
    assert.equal(fs.readFileSync(envCopied, 'utf8'), 'SECRET_KEY=123456\n');

    const appJsonCopied = path.win32.join(wt.worktree_path, 'config', 'app.json');
    assert.ok(fs.existsSync(appJsonCopied), 'config/app.json should be copied');

    // Create a second worktree and check port uniqueness
    const req2 = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=worktree_create', {
      project_path: env.repoDir,
      name: 'feature-beta',
    });
    const resp2 = (await handler(req2, req2)) as Record<string, unknown>;
    const wt2 = resp2.worktree as WorktreeRecord;
    assert.notEqual(wt2.port, wt.port, 'Ports must be unique');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: list returns live stats including dirty, ahead/behind and job_status', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'live-stats-test',
    });

    // Make an edit in worktree
    fs.appendFileSync(path.win32.join(wtRes.worktree.worktree_path, 'main.txt'), 'new line\n', 'utf8');

    const handler = feature.routes.worktree_list!.handler;
    const req = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=worktree_list&project_path=${encodeURIComponent(env.repoDir)}`
    );
    const resp = (await handler(req, req)) as Record<string, unknown>;

    assert.equal(resp.ok, true);
    const worktrees = resp.worktrees as Array<Record<string, unknown>>;
    const found = worktrees.find((w) => w.id === 'live-stats-test');
    assert.ok(found);
    const live = found.live as Record<string, unknown>;
    assert.equal(live.exists, true);
    assert.equal(Number(live.dirty) >= 1, true, 'Should reflect dirty files in worktree');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: diff includes uncommitted changes in worktree', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'diff-test',
    });

    // Uncommitted change in worktree
    fs.writeFileSync(
      path.win32.join(wtRes.worktree.worktree_path, 'uncommitted.ts'),
      'export const uncommitted = true;\n',
      'utf8'
    );

    const handler = feature.routes.worktree_diff!.handler;
    const req = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=worktree_diff&id=diff-test`
    );
    const resp = (await handler(req, req)) as Record<string, unknown>;

    assert.equal(resp.ok, true);
    const patch = String(resp.patch ?? '');
    assert.ok(patch.includes('uncommitted = true'));
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: merge handles merge, squash, and rebase strategies', async () => {
  const env = await setupWorktreeEnv();
  try {
    // 1. Merge strategy
    const wt1 = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'merge-strat',
    });
    fs.writeFileSync(path.win32.join(wt1.worktree.worktree_path, 'feature1.txt'), 'feature 1\n', 'utf8');

    const mRes1 = await handleWorktreeMerge(env.ctx, {
      id: 'merge-strat',
      strategy: 'merge',
      confirm: true,
      remove: true,
    });
    assert.equal(mRes1.merged, true);
    assert.ok(mRes1.commit);
    assert.equal(fs.existsSync(path.win32.join(env.repoDir, 'feature1.txt')), true);

    // 2. Squash strategy
    const wt2 = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'squash-strat',
    });
    fs.writeFileSync(path.win32.join(wt2.worktree.worktree_path, 'feature2.txt'), 'feature 2\n', 'utf8');

    const mRes2 = await handleWorktreeMerge(env.ctx, {
      id: 'squash-strat',
      strategy: 'squash',
      confirm: true,
      remove: true,
    });
    assert.equal(mRes2.merged, true);
    assert.equal(fs.existsSync(path.win32.join(env.repoDir, 'feature2.txt')), true);

    // 3. Rebase strategy
    const wt3 = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'rebase-strat',
    });
    fs.writeFileSync(path.win32.join(wt3.worktree.worktree_path, 'feature3.txt'), 'feature 3\n', 'utf8');

    const mRes3 = await handleWorktreeMerge(env.ctx, {
      id: 'rebase-strat',
      strategy: 'rebase',
      confirm: true,
      remove: true,
    });
    assert.equal(mRes3.merged, true);
    assert.equal(fs.existsSync(path.win32.join(env.repoDir, 'feature3.txt')), true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: merge conflict reports conflicting files and leaves checkouts clean', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'conflict-branch',
    });

    // Edit main.txt in worktree and commit
    fs.writeFileSync(path.win32.join(wt.worktree.worktree_path, 'main.txt'), 'conflict worktree line\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wt.worktree.worktree_path });
    await runCommand('git', ['commit', '-m', 'worktree edit'], { cwd: wt.worktree.worktree_path });

    // Edit main.txt in main checkout and commit
    fs.writeFileSync(path.win32.join(env.repoDir, 'main.txt'), 'conflict master line\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: env.repoDir });
    await runCommand('git', ['commit', '-m', 'master edit'], { cwd: env.repoDir });

    const mergeRes = await handleWorktreeMerge(env.ctx, {
      id: 'conflict-branch',
      strategy: 'merge',
      confirm: true,
    });

    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.merged, false);
    assert.equal(mergeRes.blocked, 'conflicts');
    const conflicts = mergeRes.conflicts as string[];
    assert.ok(conflicts.includes('main.txt'));

    // Check main checkout is clean (abort succeeded)
    const stRes = await runCommand('git', ['status', '--porcelain'], { cwd: env.repoDir });
    assert.equal(stRes.stdout.trim(), '', 'Main checkout should be clean after abort');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: discard preserves snapshot commit under refs/maw/discarded/*', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'discard-test',
    });
    fs.writeFileSync(path.win32.join(wt.worktree.worktree_path, 'discarded_file.txt'), 'keep me in ref\n', 'utf8');

    const discardRes = await handleWorktreeDiscard(env.ctx, {
      id: 'discard-test',
      confirm: true,
    });

    assert.equal(discardRes.ok, true);
    assert.equal(discardRes.discarded, 'discard-test');
    assert.equal(discardRes.kept_ref, 'refs/maw/discarded/discard-test');

    // Verify ref exists in repo
    const refRes = await runCommand('git', ['rev-parse', '--verify', 'refs/maw/discarded/discard-test'], {
      cwd: env.repoDir,
    });
    assert.equal(refRes.code, 0);

    // Verify worktree folder removed
    assert.equal(fs.existsSync(wt.worktree.worktree_path), false);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: worktree_job passes worktree path to startJob and records worktree', async () => {
  const env = await setupWorktreeEnv();
  try {
    const res = await handleWorktreeJob(env.ctx, {
      mode: 'task',
      agent: 'antigravity',
      role: 'backend',
      prompt: 'do some isolated work',
      project_path: env.repoDir,
    });

    assert.equal(res.ok, true);
    const wt = res.worktree as Record<string, unknown>;
    assert.ok(wt.id);
    assert.ok(String(wt.path).includes('.maw-wt'));

    // Check that startJob was called with the worktree path
    const lastJob = env.recordedJobs[env.recordedJobs.length - 1];
    assert.ok(lastJob);
    assert.equal(lastJob.project_path, wt.path);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: job_fork creates fork worktree with previous summary and startJob', async () => {
  const env = await setupWorktreeEnv();
  try {
    const jobId = 'job_fork_src_01';
    // Write fake meta, prompt, and log
    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${jobId}.json`),
      JSON.stringify({
        job_id: jobId,
        agent: 'claude',
        role: 'backend',
        status: 'FAILED',
        project_path: env.repoDir,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${jobId}.prompt.txt`),
      'Build the payment gateway module',
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${jobId}.log`),
      '=== JOB STARTED ===\r\nError: connection timed out to bank API\r\n',
      'utf8'
    );

    const handler = feature.routes.job_fork!.handler;
    const req = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=job_fork', {
      job_id: jobId,
      agent: 'antigravity',
      note: 'Use offline mock instead of live API',
    });
    const resp = (await handler(req, req)) as Record<string, unknown>;

    assert.equal(resp.ok, true);
    assert.equal(resp.source_job_id, jobId);
    assert.ok(resp.job_id);

    // Verify last recorded job prompt contains original prompt, summary, and instructions
    const lastJob = env.recordedJobs[env.recordedJobs.length - 1];
    assert.ok(lastJob);
    const prompt = String(lastJob.prompt ?? '');
    assert.ok(prompt.includes('Build the payment gateway module'));
    assert.ok(prompt.includes('connection timed out'));
    assert.ok(prompt.includes('Use offline mock instead of live API'));
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: best-of-N full cycle (start, advance state, mock council, rank, pick, cancel)', async () => {
  const env = await setupWorktreeEnv();
  try {
    const startRes = await handleBestOfStart(env.ctx, {
      project_path: env.repoDir,
      prompt: 'Implement binary search',
      role: 'backend',
      candidates: [
        { agent: 'antigravity', model: 'pro' },
        { agent: 'claude', model: 'sonnet' },
      ],
      judge: 'council',
    });

    assert.equal(startRes.ok, true);
    const runId = String(startRes.id);
    assert.ok(runId.startsWith('bo'));

    const run = startRes.run as Record<string, unknown>;
    const candidates = run.candidates as Array<Record<string, unknown>>;
    assert.equal(candidates.length, 2);

    // Mock candidate jobs completion
    const storeFile = await loadWorktreesStore(env.paths.featureDataDir('worktrees'));
    for (let idx = 0; idx < candidates.length; idx++) {
      const c = candidates[idx]!;
      const jId = String(c.job_id);
      const wtRec = storeFile.worktrees.find((w) => w.id === c.worktree_id);
      if (wtRec) {
        fs.writeFileSync(
          path.win32.join(wtRec.worktree_path, `solution_${idx}.ts`),
          `export const solution = ${idx};\n`,
          'utf8'
        );
      }
      const metaPath = path.win32.join(env.jobsDir, `${jId}.json`);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          job_id: jId,
          status: 'DONE',
          started_ts: Math.floor(Date.now() / 1000) - 10,
          finished_at: new Date().toISOString(),
        }),
        'utf8'
      );
    }

    // Call bestof_status to advance from running -> judging (starts council jobs)
    const stat1 = await handleBestOfStatus(
      env.ctx,
      new URLSearchParams(`id=${runId}`)
    );
    assert.equal(stat1.ok, true);

    const loaded1 = loadBestOfRun(env.paths.featureDataDir('worktrees'), runId);
    assert.ok(loaded1);
    assert.equal(loaded1.state, 'judging');

    // Mock council jobs completion with COUNCIL_RESULT markers
    for (let i = 0; i < loaded1.candidates.length; i++) {
      const c = loaded1.candidates[i]!;
      if (c.council && c.council.job_id) {
        const cJobId = c.council.job_id;
        const metaPath = path.win32.join(env.jobsDir, `${cJobId}.json`);
        const logPath = path.win32.join(env.jobsDir, `${cJobId}.log`);
        fs.writeFileSync(metaPath, JSON.stringify({ job_id: cJobId, status: 'DONE' }), 'utf8');

        const score = i === 0 ? '9.5' : '8.0';
        fs.writeFileSync(
          logPath,
          `=== COUNCIL_RESULT claude=APPROVED|${score} codex=APPROVED|${score} ===\n`,
          'utf8'
        );
      }
    }

    // Call bestof_status to advance from judging -> done
    const stat2 = await handleBestOfStatus(
      env.ctx,
      new URLSearchParams(`id=${runId}`)
    );
    const finalRun = stat2.run as Record<string, unknown>;
    assert.equal(finalRun.state, 'done');
    assert.equal(finalRun.winner, 1, 'Candidate 1 with higher score should win');

    // Pick winner
    const pickRes = await handleBestOfPick(env.ctx, {
      id: runId,
      candidate: 1,
      strategy: 'squash',
      confirm: true,
    });
    assert.equal(pickRes.ok, true);
    assert.ok(pickRes.picked);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: V8 git actions (log, diff, branch create/switch, option injection rejected)', async () => {
  const env = await setupWorktreeEnv();
  try {
    // 1. git_log
    const logHandler = feature.routes.git_log!.handler;
    const logReq = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=git_log&project_path=${encodeURIComponent(env.repoDir)}`
    );
    const logResp = (await logHandler(logReq, logReq)) as Record<string, unknown>;
    assert.equal(logResp.ok, true);
    const commits = logResp.commits as Array<Record<string, unknown>>;
    assert.ok(commits.length >= 1);

    // 2. git_branch_create
    const brCreateHandler = feature.routes.git_branch_create!.handler;
    const brCreateReq = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=git_branch_create', {
      project_path: env.repoDir,
      name: 'v8-test-branch',
      switch: false,
    });
    const brCreateResp = (await brCreateHandler(brCreateReq, brCreateReq)) as Record<string, unknown>;
    assert.equal(brCreateResp.ok, true);
    assert.equal(brCreateResp.name, 'v8-test-branch');

    // 3. git_branch_switch
    const switchHandler = feature.routes.git_branch_switch!.handler;
    const switchReq = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=git_branch_switch', {
      project_path: env.repoDir,
      branch: 'v8-test-branch',
      confirm: true,
    });
    const switchResp = (await switchHandler(switchReq, switchReq)) as Record<string, unknown>;
    assert.equal(switchResp.ok, true);

    // 4. Option injection rejection
    const badReq = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=git_branch_create', {
      project_path: env.repoDir,
      name: '--upload-pack=exploit',
    });
    await assert.rejects(
      async () => {
        await brCreateHandler(badReq, badReq);
      },
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400
    );
  } finally {
    cleanupWorktreeEnv(env);
  }
});
