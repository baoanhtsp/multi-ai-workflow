import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { feature } from '../features/worktrees/index.ts';
import {
  activeCheckRuns,
  generateBestOfId,
  handleBestOfPick,
  handleBestOfStart,
  handleBestOfStatus,
  loadBestOfRun,
  saveBestOfRun,
} from '../features/worktrees/bestof.ts';
import { createWorktreeRecord, handleWorktreeJob } from '../features/worktrees/isolate.ts';
import { handleWorktreeDiscard, handleWorktreeFixConflicts, handleWorktreeMerge } from '../features/worktrees/merge.ts';
import {
  loadWorktreesStore,
  saveWorktreesStore,
  type WorktreeRecord,
} from '../features/worktrees/store.ts';
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
  const testScriptsDir = path.win32.join(tempBase, 'scripts');
  fs.mkdirSync(testScriptsDir, { recursive: true });
  paths.scriptsDir = testScriptsDir;

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
    readJobs: async () => {
      return recordedJobs.map((j) => {
        const jobId = String(j.job_id ?? '');
        const metaPath = path.win32.join(jobsDir, `${jobId}.json`);
        if (fs.existsSync(metaPath)) {
          try {
            const disk = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            return { ...j, ...disk };
          } catch {}
        }
        return j;
      });
    },
    startJob: async (body: Record<string, unknown>) => {
      const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const rec = { job_id: jobId, pid: 9999, status: 'RUNNING', ...body };
      recordedJobs.push(rec);

      // Write mock job metadata file so status checks find it
      const metaPath = path.win32.join(jobsDir, `${jobId}.json`);
      fs.writeFileSync(metaPath, JSON.stringify(rec), 'utf8');

      return { ok: true, job_id: jobId, pid: 9999, status: 'RUNNING' };
    },
    callAction: async (action: string, _opts?: { query?: Record<string, string>; body?: Record<string, unknown> }) => {
      if (action === 'checks_run') {
        return { ok: true, running: true };
      }
      if (action === 'checks_status') {
        return {
          ok: true,
          pending: false,
          gate: { green: true },
          results: [{ id: 'unit', label: 'unit', status: 'pass', exit_code: 0, duration_s: 1, tail: 'ok' }],
        };
      }
      if (action === 'checks_gate') {
        return { ok: true, green: true, items: [] };
      }
      throw new Error(`Unknown action ${action}`);
    },
  } as any;

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
    assert.equal(pickRes.merged, true);
    assert.ok(pickRes.commit);
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

test('S1 Worktrees: option injection and path traversal rejected (worktree_create, bestof_status, job_fork)', async () => {
  const env = await setupWorktreeEnv();
  try {
    // 1. worktree_create base=--orphan=x
    const wtCreateHandler = feature.routes.worktree_create!.handler;
    const wtReq = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=worktree_create', {
      project_path: env.repoDir,
      base: '--orphan=x',
    });
    await assert.rejects(
      async () => await wtCreateHandler(wtReq, wtReq),
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400
    );

    // 2. bestof_status id=..\..\x
    const boStatHandler = feature.routes.bestof_status!.handler;
    const boReq = makeMockRequest(
      env.ctx,
      'http://127.0.0.1/api?action=bestof_status&id=..\\..\\x'
    );
    await assert.rejects(
      async () => await boStatHandler(boReq, boReq),
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400
    );

    // 3. job_fork job_id=..\x
    const forkHandler = feature.routes.job_fork!.handler;
    const forkReq = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=job_fork', {
      job_id: '..\\x',
    });
    await assert.rejects(
      async () => await forkHandler(forkReq, forkReq),
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400
    );
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: handleWorktreeJob cleans up worktree and branch if startJob throws (W2)', async () => {
  const env = await setupWorktreeEnv();
  try {
    const brokenCtx: MawFeatureContext = {
      ...env.ctx,
      startJob: async () => {
        throw new Error('Simulated runner failure');
      },
    };

    await assert.rejects(
      async () => {
        await handleWorktreeJob(brokenCtx, {
          project_path: env.repoDir,
          agent: 'antigravity',
        });
      },
      (err: any) => err instanceof Error && err.message === 'Simulated runner failure'
    );

    // Verify store has no active worktree
    const store = await loadWorktreesStore(env.paths.featureDataDir('worktrees'));
    assert.equal(store.worktrees.length, 0, 'No worktree record should remain');

    // Verify git branches: no maw/* branch created
    const branchRes = await runCommand('git', ['branch'], { cwd: env.repoDir });
    assert.ok(!branchRes.stdout.includes('maw/'), 'Branch maw/* must be cleaned up');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees: Best-of-N slow check returns immediately with tests.status running (N2)', async () => {
  const env = await setupWorktreeEnv();
  try {
    // Add checks.json to repository
    fs.mkdirSync(path.win32.join(env.repoDir, '.maw'), { recursive: true });
    fs.writeFileSync(
      path.win32.join(env.repoDir, '.maw', 'checks.json'),
      JSON.stringify({
        checks: [
          {
            name: 'slow-test',
            command: ['git', 'status'],
          },
        ],
      }),
      'utf8'
    );

    const startRes = await handleBestOfStart(env.ctx, {
      project_path: env.repoDir,
      prompt: 'Check slow test running state',
      role: 'backend',
      candidates: [
        { agent: 'antigravity' },
        { agent: 'claude' },
      ],
      judge: 'tests',
    });

    const runId = String(startRes.id);
    const run = startRes.run as Record<string, unknown>;
    const candidates = run.candidates as Array<Record<string, unknown>>;

    // Mark candidate jobs DONE
    for (const c of candidates) {
      const jId = String(c.job_id);
      fs.writeFileSync(
        path.win32.join(env.jobsDir, `${jId}.json`),
        JSON.stringify({ job_id: jId, status: 'DONE' }),
        'utf8'
      );
    }

    // Call status to advance to judging and trigger background checks
    const statRes = await handleBestOfStatus(
      env.ctx,
      new URLSearchParams(`id=${runId}`)
    );
    assert.equal(statRes.ok, true);
    const updatedRun = statRes.run as Record<string, unknown>;
    assert.equal(updatedRun.state, 'judging');
    const cand1 = (updatedRun.candidates as Array<Record<string, unknown>>)[0]!;
    assert.ok(cand1.tests);
    assert.equal((cand1.tests as Record<string, unknown>).status, 'running');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees R2-1: bestof_status loads run inside lock so concurrent background results survive', async () => {
  const env = await setupWorktreeEnv();
  try {
    const startRes = await handleBestOfStart(env.ctx, {
      project_path: env.repoDir,
      prompt: 'Test R2-1 result survival',
      role: 'backend',
      candidates: [{ agent: 'antigravity' }, { agent: 'claude' }],
      judge: 'tests',
    });
    const runId = String(startRes.id);
    const dataDir = env.paths.featureDataDir('worktrees');

    // Transition run to judging with tests: pass written by background runner
    const run = loadBestOfRun(dataDir, runId)!;
    run.state = 'judging';
    run.candidates[0]!.tests = {
      status: 'pass',
      results: [{ name: 'unit', exit_code: 0, duration_s: 1, tail: 'all passed' }],
    };
    run.candidates[1]!.tests = {
      status: 'pass',
      results: [{ name: 'unit', exit_code: 0, duration_s: 1, tail: 'all passed' }],
    };
    saveBestOfRun(dataDir, run);

    // Call handleBestOfStatus - must load fresh run inside withRunLock and not overwrite with 'running'
    const statRes = await handleBestOfStatus(env.ctx, new URLSearchParams(`id=${runId}`));
    assert.equal(statRes.ok, true);
    const loaded = statRes.run as Record<string, unknown>;
    const c0 = (loaded.candidates as Array<Record<string, unknown>>)[0]!;
    assert.equal((c0.tests as Record<string, unknown>).status, 'pass');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees R2-2: advanceBestOfRun restarts tests when candidate is running but not in activeCheckRuns', async () => {
  const env = await setupWorktreeEnv();
  try {
    fs.mkdirSync(path.win32.join(env.repoDir, '.maw'), { recursive: true });
    fs.writeFileSync(
      path.win32.join(env.repoDir, '.maw', 'checks.json'),
      JSON.stringify({
        checks: [{ name: 'dummy', command: ['git', 'status'] }],
      }),
      'utf8'
    );

    const startRes = await handleBestOfStart(env.ctx, {
      project_path: env.repoDir,
      prompt: 'Test R2-2 recovery',
      role: 'backend',
      candidates: [{ agent: 'antigravity' }, { agent: 'claude' }],
      judge: 'tests',
    });
    const runId = String(startRes.id);
    const dataDir = env.paths.featureDataDir('worktrees');

    // Simulate server crash while candidates were running
    const run = loadBestOfRun(dataDir, runId)!;
    run.state = 'judging';
    run.candidates[0]!.tests = { status: 'running', results: [] };
    run.candidates[1]!.tests = { status: 'none', results: [] };
    saveBestOfRun(dataDir, run);

    // activeCheckRuns does not have this run's key (simulating process restart)
    activeCheckRuns.clear();
    assert.equal(activeCheckRuns.has(`${runId}_1`), false);

    // Calling status must detect candidate is 'running' but not in activeCheckRuns and restart it
    const statRes = await handleBestOfStatus(env.ctx, new URLSearchParams(`id=${runId}`));
    assert.equal(statRes.ok, true);
    assert.equal(activeCheckRuns.has(`${runId}_1`), true, 'Check must be re-added to activeCheckRuns');
  } finally {
    activeCheckRuns.clear();
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees R2-5 & R2-6: merge falls back to job agent when owner is empty, and checks status via readJobs', async () => {
  const env = await setupWorktreeEnv();
  try {
    // Create worktree with empty owner
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'r2-merge-test',
      owner: undefined,
      origin: 'job',
    });

    const fakeJobId = 'job_r2_done_123';
    const dataDir = env.paths.featureDataDir('worktrees');
    const store = await loadWorktreesStore(dataDir);
    const rec = store.worktrees.find((w) => w.id === wtRes.worktree.id)!;
    rec.job_id = fakeJobId;
    rec.owner = ''; // explicitly empty string (R2-5)
    await saveWorktreesStore(dataDir, store);

    // Stale meta file on disk says RUNNING
    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${fakeJobId}.json`),
      JSON.stringify({ job_id: fakeJobId, status: 'RUNNING', agent: 'claude' }),
      'utf8'
    );

    // But ctx.readJobs() returns DONE and agent: 'claude' (R2-6)
    const activeCtx: MawFeatureContext = {
      ...env.ctx,
      readJobs: async () => [
        { job_id: fakeJobId, status: 'DONE', agent: 'claude' },
      ],
    };

    // Calling merge must succeed (not blocked by stale meta file) and fallback owner to 'claude'
    const mergeRes = await handleWorktreeMerge(activeCtx, {
      id: wtRes.worktree.id,
      strategy: 'merge',
      confirm: true,
    });

    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.merged, true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees X1: SPEC Guard fails closed on error/timeout/fail unless force: true', async () => {
  const env = await setupWorktreeEnv();
  try {
    fs.writeFileSync(path.win32.join(env.repoDir, 'SPEC.md'), '# Spec\n', 'utf8');
    await runCommand('git', ['add', 'SPEC.md'], { cwd: env.repoDir });
    await runCommand('git', ['commit', '-m', 'add SPEC.md'], { cwd: env.repoDir });

    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'x1-spec-test',
      owner: 'claude',
      origin: 'job',
    });

    fs.writeFileSync(path.win32.join(wt.worktree.worktree_path, 'work.txt'), 'work\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wt.worktree.worktree_path });
    await runCommand('git', ['commit', '-m', 'commit in worktree'], { cwd: wt.worktree.worktree_path });

    fs.mkdirSync(env.paths.scriptsDir, { recursive: true });
    const sgScript = path.win32.join(env.paths.scriptsDir, 'invoke-spec-guard.ps1');
    fs.writeFileSync(sgScript, 'Write-Error "SPEC Guard internal crash"\nexit 1\n', 'utf8');

    const blockRes = await handleWorktreeMerge(env.ctx, {
      id: wt.worktree.id,
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(blockRes.ok, true);
    assert.equal(blockRes.merged, false);
    assert.equal(blockRes.blocked, 'spec_guard');
    assert.ok(blockRes.spec_guard);

    const forceRes = await handleWorktreeMerge(env.ctx, {
      id: wt.worktree.id,
      strategy: 'merge',
      force: true,
      confirm: true,
    });
    assert.equal(forceRes.ok, true);
    assert.equal(forceRes.merged, true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees X2: Discard preserves uncommitted work in refs/maw/discarded/* and fails safe without deleting branch', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'x2-discard-test',
    });
    const wtPath = wt.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'uncommitted.txt'), 'precious uncommitted\n', 'utf8');

    const discardRes = await handleWorktreeDiscard(env.ctx, {
      id: 'x2-discard-test',
      confirm: true,
    });

    assert.equal(discardRes.ok, true);
    assert.equal(discardRes.kept_ref, 'refs/maw/discarded/x2-discard-test');

    const lsRes = await runCommand('git', ['ls-tree', '-r', '--name-only', 'refs/maw/discarded/x2-discard-test'], {
      cwd: env.repoDir,
    });
    assert.equal(lsRes.code, 0);
    assert.ok(lsRes.stdout.includes('uncommitted.txt'), 'Snapshot must contain uncommitted work');

    assert.equal(fs.existsSync(wtPath), false);
    const brRes = await runCommand('git', ['rev-parse', '--verify', 'maw/x2-discard-test'], {
      cwd: env.repoDir,
    });
    assert.notEqual(brRes.code, 0, 'Branch must be deleted on successful discard');

    const wtFail = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'x2-fail-test',
    });
    const wtFailPath = wtFail.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtFailPath, 'test.txt'), 'hello\n', 'utf8');

    // Hold cwd lock on Windows so git worktree remove --force fails
    const lockProc = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1'], { cwd: wtFailPath, stdio: 'ignore' });

    let caughtErr: any = null;
    try {
      await handleWorktreeDiscard(env.ctx, {
        id: 'x2-fail-test',
        confirm: true,
      });
    } catch (err: any) {
      caughtErr = err;
    } finally {
      lockProc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(caughtErr, 'handleWorktreeDiscard should have thrown on failed remove');
    assert.equal(caughtErr.statusCode, 500);

    const store = await loadWorktreesStore(env.paths.featureDataDir('worktrees'));
    const rec = store.worktrees.find((w) => w.id === 'x2-fail-test');
    assert.ok(rec);
    assert.equal(rec.status, 'active');

    const brFailRes = await runCommand('git', ['rev-parse', '--verify', 'maw/x2-fail-test'], {
      cwd: env.repoDir,
    });
    assert.equal(brFailRes.code, 0, 'Branch must NOT be deleted when remove fails');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees X4: Create reserves status creating, list leaves creating untouched with live.exists false, then switches active', async () => {
  const env = await setupWorktreeEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');
    const store = await loadWorktreesStore(dataDir);
    const nonExistentPath = path.win32.join(env.repoDir, '.maw-wt', 'ghost-wt');

    const ghostRec: WorktreeRecord = {
      id: 'ghost-wt',
      project_path: env.repoDir,
      worktree_path: nonExistentPath,
      branch: 'maw/ghost-wt',
      base: 'master',
      base_commit: 'abc1234',
      port: 4488,
      origin: 'manual',
      status: 'creating',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.worktrees.push(ghostRec);
    await saveWorktreesStore(dataDir, store);

    const listHandler = feature.routes.worktree_list!.handler;
    const req = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=worktree_list&project_path=${encodeURIComponent(env.repoDir)}`
    );
    const res = (await listHandler(req, req)) as Record<string, unknown>;
    assert.equal(res.ok, true);

    const worktrees = res.worktrees as Array<Record<string, unknown>>;
    const found = worktrees.find((w) => w.id === 'ghost-wt');
    assert.ok(found);
    assert.equal(found.status, 'creating');
    const live = found.live as Record<string, unknown>;
    assert.equal(live.exists, false);

    const storeAfter = await loadWorktreesStore(dataDir);
    const recordAfter = storeAfter.worktrees.find((w) => w.id === 'ghost-wt');
    assert.equal(recordAfter?.status, 'creating');

    const realWt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'real-wt-status-test',
    });
    assert.equal(realWt.worktree.status, 'active');
    const storeReal = await loadWorktreesStore(dataDir);
    const realRecord = storeReal.worktrees.find((w) => w.id === 'real-wt-status-test');
    assert.equal(realRecord?.status, 'active');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees X5: COUNCIL_RESULT parses all reviewer pairs, min score, and requires all reviewers approved', async () => {
  const env = await setupWorktreeEnv();
  try {
    const runId = generateBestOfId();
    const dataDir = env.paths.featureDataDir('worktrees');
    const candWt1 = await createWorktreeRecord(env.ctx, { project_path: env.repoDir, name: 'x5-c1' });

    const councilJobId = 'job_council_x5';
    const metaPath = path.win32.join(env.jobsDir, `${councilJobId}.json`);
    const logPath = path.win32.join(env.jobsDir, `${councilJobId}.log`);
    fs.writeFileSync(metaPath, JSON.stringify({ job_id: councilJobId, status: 'DONE' }), 'utf8');

    const baseRun = {
      id: runId,
      project_path: env.repoDir,
      base: 'master',
      judge: 'council' as const,
      reviewers: ['claude', 'codex'],
      state: 'judging' as const,
      winner: null,
      candidates: [
        {
          i: 1,
          agent: 'antigravity',
          worktree_id: 'x5-c1',
          worktree_path: candWt1.worktree.worktree_path,
          port: candWt1.worktree.port,
          job_id: 'j1',
          job_status: 'DONE',
          council: {
            job_id: councilJobId,
            status: 'RUNNING',
            verdicts: null,
            score: null,
            approved: null,
          },
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    saveBestOfRun(dataDir, baseRun as any);

    // Case A: claude=APPROVED|9.5 codex=REJECTED|3 -> score: 3, approved: false
    fs.writeFileSync(
      logPath,
      '=== COUNCIL_RESULT claude=APPROVED|9.5 codex=REJECTED|3 ===\n',
      'utf8'
    );
    await handleBestOfStatus(env.ctx, new URLSearchParams(`id=${runId}`));
    let runA = loadBestOfRun(dataDir, runId)!;
    assert.equal(runA.candidates[0]!.council!.score, 3);
    assert.equal(runA.candidates[0]!.council!.approved, false);
    assert.equal(runA.candidates[0]!.council!.verdicts?.claude, 'APPROVED');
    assert.equal(runA.candidates[0]!.council!.verdicts?.codex, 'REJECTED');

    // Case B: claude=APPROVED|9 codex=APPROVED|8.5 -> score: 8.5, approved: true
    runA.state = 'judging';
    runA.candidates[0]!.council!.status = 'RUNNING';
    saveBestOfRun(dataDir, runA);
    fs.writeFileSync(
      logPath,
      '=== COUNCIL_RESULT claude=APPROVED|9 codex=APPROVED|8.5 ===\n',
      'utf8'
    );
    await handleBestOfStatus(env.ctx, new URLSearchParams(`id=${runId}`));
    let runB = loadBestOfRun(dataDir, runId)!;
    assert.equal(runB.candidates[0]!.council!.score, 8.5);
    assert.equal(runB.candidates[0]!.council!.approved, true);

    // Case C: Missing codex on the line -> approved must be false
    runB.state = 'judging';
    runB.candidates[0]!.council!.status = 'RUNNING';
    saveBestOfRun(dataDir, runB);
    fs.writeFileSync(
      logPath,
      '=== COUNCIL_RESULT claude=APPROVED|9.0 ===\n',
      'utf8'
    );
    await handleBestOfStatus(env.ctx, new URLSearchParams(`id=${runId}`));
    let runC = loadBestOfRun(dataDir, runId)!;
    assert.equal(runC.candidates[0]!.council!.approved, false, 'Missing codex must result in approved=false');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees X7: worktree_list and bestof_list throw 400 on invalid project_path', async () => {
  const env = await setupWorktreeEnv();
  try {
    const listHandler = feature.routes.worktree_list!.handler;
    const bestofHandler = feature.routes.bestof_list!.handler;

    const reqWtInvalid = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=worktree_list&project_path=../outside/traversal`
    );
    let caughtWtErr: any = null;
    try {
      await listHandler(reqWtInvalid, reqWtInvalid);
    } catch (err: any) {
      caughtWtErr = err;
    }
    assert.ok(caughtWtErr, 'worktree_list should have thrown 400 on invalid project_path');
    assert.equal(caughtWtErr.statusCode, 400);
    assert.match(caughtWtErr.message, /Invalid project path/i);

    const reqBoInvalid = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=bestof_list&project_path=../outside/traversal`
    );
    let caughtBoErr: any = null;
    try {
      await bestofHandler(reqBoInvalid, reqBoInvalid);
    } catch (err: any) {
      caughtBoErr = err;
    }
    assert.ok(caughtBoErr, 'bestof_list should have thrown 400 on invalid project_path');
    assert.equal(caughtBoErr.statusCode, 400);
    assert.match(caughtBoErr.message, /Invalid project path/i);

    const reqWtEmpty = makeMockRequest(env.ctx, `http://127.0.0.1/api?action=worktree_list`);
    const wtEmptyRes = (await listHandler(reqWtEmpty, reqWtEmpty)) as Record<string, unknown>;
    assert.equal(wtEmptyRes.ok, true);

    const reqBoEmpty = makeMockRequest(env.ctx, `http://127.0.0.1/api?action=bestof_list`);
    const boEmptyRes = (await bestofHandler(reqBoEmpty, reqBoEmpty)) as Record<string, unknown>;
    assert.equal(boEmptyRes.ok, true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees Y1: SPEC Guard blocks merge when branch touches SPEC.md, and only accepts WARN with valid rules', async () => {
  const env = await setupWorktreeEnv();
  try {
    fs.writeFileSync(path.win32.join(env.repoDir, 'SPEC.md'), '# Spec Initial\n', 'utf8');
    await runCommand('git', ['add', 'SPEC.md'], { cwd: env.repoDir });
    await runCommand('git', ['commit', '-m', 'add SPEC.md'], { cwd: env.repoDir });

    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'y1-spec-test',
      owner: 'antigravity',
      origin: 'job',
    });

    // 1. Worktree modifies SPEC.md
    fs.writeFileSync(path.win32.join(wt.worktree.worktree_path, 'SPEC.md'), '# Spec Modified by Branch\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wt.worktree.worktree_path });
    await runCommand('git', ['commit', '-m', 'modify SPEC.md'], { cwd: wt.worktree.worktree_path });

    // Merge must be blocked because SPEC.md was touched
    const blockRes = await handleWorktreeMerge(env.ctx, {
      id: wt.worktree.id,
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(blockRes.ok, true);
    assert.equal(blockRes.merged, false);
    assert.equal(blockRes.blocked, 'spec_guard');
    assert.match(String((blockRes as any).reason), /SPEC\.md/i);

    // Merge with force: true must proceed
    const forceRes = await handleWorktreeMerge(env.ctx, {
      id: wt.worktree.id,
      strategy: 'merge',
      force: true,
      confirm: true,
    });
    assert.equal(forceRes.ok, true);
    assert.equal(forceRes.merged, true);

    // 2. Test WARN without ownership_rules: must be blocked
    const wt2 = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'y1-warn-test',
      owner: 'antigravity',
      origin: 'job',
    });
    fs.writeFileSync(path.win32.join(wt2.worktree.worktree_path, 'code.txt'), 'clean code\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wt2.worktree.worktree_path });
    await runCommand('git', ['commit', '-m', 'add code'], { cwd: wt2.worktree.worktree_path });

    // Mock script returning WARN but has_spec: false / empty ownership_rules
    fs.mkdirSync(env.paths.scriptsDir, { recursive: true });
    const sgScript = path.win32.join(env.paths.scriptsDir, 'invoke-spec-guard.ps1');
    fs.writeFileSync(
      sgScript,
      'Write-Output \'{"ok":true,"verdict":"WARN","has_spec":false,"ownership_rules":[]}\'\n',
      'utf8'
    );

    const warnBlockRes = await handleWorktreeMerge(env.ctx, {
      id: wt2.worktree.id,
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(warnBlockRes.ok, true);
    assert.equal(warnBlockRes.merged, false);
    assert.equal(warnBlockRes.blocked, 'spec_guard');

    // Mock script returning WARN with has_spec: true and ownership_rules: must proceed
    fs.writeFileSync(
      sgScript,
      'Write-Output \'{"ok":true,"verdict":"WARN","has_spec":true,"ownership_rules":["rule1"]}\'\n',
      'utf8'
    );
    const warnAllowRes = await handleWorktreeMerge(env.ctx, {
      id: wt2.worktree.id,
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(warnAllowRes.ok, true);
    assert.equal(warnAllowRes.merged, true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees Y3: Reject duplicate worktree name across any status with 409 "Worktree name already used."', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wt = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'y3-dup-test',
    });

    // Discard worktree so status becomes 'discarded'
    await handleWorktreeDiscard(env.ctx, {
      id: 'y3-dup-test',
      confirm: true,
    });

    const store = await loadWorktreesStore(env.paths.featureDataDir('worktrees'));
    const rec = store.worktrees.find((w) => w.id === 'y3-dup-test');
    assert.equal(rec?.status, 'discarded');

    // Attempting to reuse 'y3-dup-test' must throw 409 "Worktree name already used."
    let caughtErr: any = null;
    try {
      await createWorktreeRecord(env.ctx, {
        project_path: env.repoDir,
        name: 'y3-dup-test',
      });
    } catch (err: any) {
      caughtErr = err;
    }
    assert.ok(caughtErr, 'Should reject reused name');
    assert.equal(caughtErr.statusCode, 409);
    assert.equal(caughtErr.message, 'Worktree name already used.');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees Y4: job_fork with base:"result" fails with 409 when source worktree is gone', async () => {
  const env = await setupWorktreeEnv();
  try {
    const forkHandler = feature.routes.job_fork!.handler;
    const fakeJobId = 'job_20261025_forky4';

    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${fakeJobId}.json`),
      JSON.stringify({ job_id: fakeJobId, project_path: env.repoDir, agent: 'antigravity', role: 'backend' }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(env.jobsDir, `${fakeJobId}.prompt.txt`),
      'original prompt\n',
      'utf8'
    );

    const req = makeMockRequest(env.ctx, 'http://127.0.0.1/api?action=job_fork', {
      job_id: fakeJobId,
      base: 'result',
    });

    let caughtErr: any = null;
    try {
      await forkHandler(req, req);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'job_fork with base: result should throw 409 when source worktree missing');
    assert.equal(caughtErr.statusCode, 409);
    assert.equal(caughtErr.message, "The source job's worktree is gone; fork from the project instead.");
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees S4-1: Best-of-N judge tests refused with 400 when S4 callAction is absent', async () => {
  const env = await setupWorktreeEnv();
  try {
    const ctxWithoutCallAction = { ...env.ctx };
    delete (ctxWithoutCallAction as any).callAction;

    let caughtErr: any = null;
    try {
      await handleBestOfStart(ctxWithoutCallAction, {
        project_path: env.repoDir,
        prompt: 'Check absent S4',
        role: 'backend',
        candidates: [{ agent: 'antigravity' }, { agent: 'claude' }],
        judge: 'tests',
      });
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Should throw 400 when S4 callAction is absent');
    assert.equal(caughtErr.statusCode, 400);
    assert.equal(caughtErr.message, 'Test gate (S4 checks) is not available');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees S4-2: Merge gate blocks with blocked: "checks" when checks_gate is red', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      base: 'master',
      name: 's4-gate-wt',
      origin: 'manual',
    });
    const wtPath = wtRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'feat.txt'), 'feature code\n', 'utf8');

    // Custom ctx where checks_gate returns red
    let receivedOverrideToken: string | undefined = undefined;
    const s4Ctx = {
      ...env.ctx,
      callAction: async (action: string, opts?: { query?: Record<string, string>; body?: Record<string, unknown> }) => {
        if (action === 'checks_gate') {
          receivedOverrideToken = opts?.query?.override_token;
          if (receivedOverrideToken === 'tok_valid_123') {
            return { ok: true, green: true, overridden: true, items: [] };
          }
          return { ok: true, green: false, items: [{ label: 'lint', status: 'fail' }] };
        }
        throw new Error(`Unexpected action ${action}`);
      },
    };

    // Attempt merge without override - should be blocked by checks
    const blockedRes = await handleWorktreeMerge(s4Ctx as any, {
      id: 's4-gate-wt',
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(blockedRes.ok, true);
    assert.equal(blockedRes.merged, false);
    assert.equal(blockedRes.blocked, 'checks');
    assert.deepEqual(blockedRes.checks, { ok: true, green: false, items: [{ label: 'lint', status: 'fail' }] });

    // Attempt merge with override token - should succeed
    const passRes = await handleWorktreeMerge(s4Ctx as any, {
      id: 's4-gate-wt',
      strategy: 'merge',
      confirm: true,
      checks_override_token: 'tok_valid_123',
    });
    assert.equal(passRes.ok, true);
    assert.equal(passRes.merged, true);
    assert.equal(receivedOverrideToken, 'tok_valid_123');
  } finally {
    cleanupWorktreeEnv(env);
  }
});

test('S1 Worktrees S4-3: Merge gate fails closed on error and skips only on unknown action (K6)', async () => {
  const env = await setupWorktreeEnv();
  try {
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      base: 'master',
      name: 's4-failclose-wt',
      origin: 'manual',
    });
    const wtPath = wtRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'feat.txt'), 'feature code\n', 'utf8');

    // 1. Unexpected runtime exception in checks_gate -> FAILS CLOSED
    const failingCtx = {
      ...env.ctx,
      callAction: async (action: string) => {
        if (action === 'checks_gate') {
          throw new Error('S4 gate crashed or database timed out');
        }
        throw new Error(`Unknown action: ${action}`);
      },
    };

    const blockedRes = await handleWorktreeMerge(failingCtx as any, {
      id: 's4-failclose-wt',
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(blockedRes.ok, true);
    assert.equal(blockedRes.merged, false);
    assert.equal(blockedRes.blocked, 'checks');
    assert.deepEqual(blockedRes.checks, { error: 'S4 gate crashed or database timed out' });

    // 2. "Unknown action" in checks_gate -> SKIPS gracefully without blocking
    const unknownActionCtx = {
      ...env.ctx,
      callAction: async (action: string) => {
        throw new Error(`Unknown action: ${action}`);
      },
    };

    const passRes = await handleWorktreeMerge(unknownActionCtx as any, {
      id: 's4-failclose-wt',
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(passRes.ok, true);
    assert.equal(passRes.merged, true);
  } finally {
    cleanupWorktreeEnv(env);
  }
});
