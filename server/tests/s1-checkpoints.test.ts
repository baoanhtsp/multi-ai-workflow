import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { feature } from '../features/checkpoints/index.ts';
import {
  createCheckpoint,
  diffTrees,
  listCheckpoints,
  restoreTree,
  snapshotTree,
} from '../features/checkpoints/snapshot.ts';
import type { MawFeatureContext, MawFeatureRequest } from '../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

interface TestEnv {
  tempBase: string;
  projectsRoot: string;
  repoDir: string;
  mawHome: string;
  jobsDir: string;
  paths: ServerPaths;
  ctx: MawFeatureContext;
}

async function setupTestEnv(): Promise<TestEnv> {
  const rand = crypto.randomBytes(6).toString('hex');
  const tempBase = path.win32.join(os.tmpdir(), `maw-s1-cp-${rand}`);
  const projectsRoot = path.win32.join(tempBase, 'projects');
  const repoDir = path.win32.join(projectsRoot, 'sample-repo');
  const mawHome = path.win32.join(tempBase, 'maw-home');
  const jobsDir = path.win32.join(tempBase, 'maw-jobs');

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  await runCommand('git', ['init', '-q'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.email', 'test@localhost'], { cwd: repoDir });
  await runCommand('git', ['config', 'commit.gpgSign', 'false'], { cwd: repoDir });

  fs.writeFileSync(path.win32.join(repoDir, '.gitignore'), 'ignored.txt\n.env\n', 'utf8');
  fs.writeFileSync(path.win32.join(repoDir, 'file1.txt'), 'hello world\n', 'utf8');

  await runCommand('git', ['add', '.'], { cwd: repoDir });
  await runCommand('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });

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
      agents: [],
      allAgents: [],
      shippedPath: '',
      userPath: '',
      warnings: [],
    },
    readJobs: async () => recordedJobs,
    startJob: async (body: Record<string, unknown>) => {
      const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      recordedJobs.push({ job_id: jobId, ...body });
      return { ok: true, job_id: jobId, pid: 1234, status: 'RUNNING' };
    },
  };

  return { tempBase, projectsRoot, repoDir, mawHome, jobsDir, paths, ctx };
}

function cleanupTestEnv(env: TestEnv): void {
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

test('S1 Checkpoints: create captures tracked and untracked files while ignoring gitignored files', async () => {
  const env = await setupTestEnv();
  try {
    // Add an untracked file and an ignored file
    fs.writeFileSync(path.win32.join(env.repoDir, 'untracked.txt'), 'untracked content\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'ignored.txt'), 'secret ignored\n', 'utf8');

    const res = await createCheckpoint(env.repoDir, {
      jobKey: 'job_test1',
      event: 'job-start',
      label: 'before job',
    });

    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.checkpoint.job_key, 'job_test1');
    assert.equal(res.checkpoint.n, 1);
    assert.equal(res.checkpoint.id, 'job_test1/0001');

    // Verify tree contains untracked.txt but NOT ignored.txt
    const lsRes = await runCommand(
      'git',
      ['ls-tree', '-r', '--name-only', res.checkpoint.tree],
      { cwd: env.repoDir }
    );
    const files = lsRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.ok(files.includes('file1.txt'));
    assert.ok(files.includes('untracked.txt'));
    assert.ok(!files.includes('ignored.txt'), 'Ignored file must not be captured');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: dedup returns existing checkpoint when working tree is unchanged', async () => {
  const env = await setupTestEnv();
  try {
    const res1 = await createCheckpoint(env.repoDir, {
      jobKey: 'job_dedup',
      event: 'job-start',
      label: 'initial',
    });
    assert.equal(res1.created, true);
    assert.equal(res1.checkpoint.id, 'job_dedup/0001');

    // Immediate second checkpoint with same tree
    const res2 = await createCheckpoint(env.repoDir, {
      jobKey: 'job_dedup',
      event: 'before-agent',
      label: 'second',
    });
    assert.equal(res2.created, false);
    assert.equal(res2.checkpoint.id, 'job_dedup/0001');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: listCheckpoints returns items filtered by workdir with stats', async () => {
  const env = await setupTestEnv();
  try {
    await createCheckpoint(env.repoDir, {
      jobKey: 'job_seq',
      event: 'job-start',
      label: 'first',
    });

    fs.writeFileSync(path.win32.join(env.repoDir, 'added.txt'), 'new file\n', 'utf8');

    await createCheckpoint(env.repoDir, {
      jobKey: 'job_seq',
      event: 'round-start',
      label: 'second',
    });

    const list = await listCheckpoints(env.repoDir, { jobId: 'job_seq' });
    assert.equal(list.checkpoints.length, 2);
    // Newest first
    assert.equal(list.checkpoints[0]?.id, 'job_seq/0002');
    assert.equal(list.checkpoints[1]?.id, 'job_seq/0001');

    // Check stats on second checkpoint vs first
    assert.ok(list.checkpoints[0]?.stats);
    assert.equal(list.checkpoints[0]?.stats?.files, 1);
    assert.equal(list.checkpoints[0]?.stats?.additions, 1);
    // Oldest checkpoint has null stats
    assert.equal(list.checkpoints[1]?.stats, null);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: diffTrees shows file status, additions/deletions and patch', async () => {
  const env = await setupTestEnv();
  try {
    const cp = await createCheckpoint(env.repoDir, {
      jobKey: 'job_diff',
      event: 'job-start',
    });

    fs.appendFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'extra line\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'brand_new.txt'), 'hello new\n', 'utf8');

    const diff = await diffTrees(env.repoDir, cp.checkpoint.id, 'WORKTREE');
    assert.equal(diff.ok, true);
    assert.equal(diff.to, 'WORKTREE');
    assert.ok(diff.files.length >= 2);
    assert.ok(diff.patch.includes('+extra line'));
    assert.ok(diff.patch.includes('+hello new'));
    assert.equal(diff.truncated, false);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: restoreTree restores modified files, removes added files, keeps ignored files, and creates safety checkpoint', async () => {
  const env = await setupTestEnv();
  try {
    const cpRes = await createCheckpoint(env.repoDir, {
      jobKey: 'job_restore',
      event: 'job-start',
      label: 'baseline',
    });

    // Make edits: modify existing, add new untracked, add new ignored
    fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'modified text\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'temp_added.txt'), 'added content\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'ignored.txt'), 'keep me safe\n', 'utf8');

    // Attempt restore without confirm
    await assert.rejects(
      async () => {
        await restoreTree(env.repoDir, cpRes.checkpoint.id, {
          confirm: false,
          auditFile: env.paths.auditFile,
          checkpointsAuditFile: path.win32.join(env.mawHome, 'audit.jsonl'),
        });
      },
      (err: unknown) => err instanceof ApiValidationError && err.statusCode === 400
    );

    // Perform valid restore
    const restoreRes = await restoreTree(env.repoDir, cpRes.checkpoint.id, {
      confirm: true,
      auditFile: env.paths.auditFile,
      checkpointsAuditFile: path.win32.join(env.mawHome, 'audit.jsonl'),
    });

    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.restored, 'job_restore/0001');
    assert.ok(restoreRes.safety_checkpoint.startsWith('safety/'));

    // Check file states
    const file1Content = fs.readFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'utf8');
    assert.equal(
      file1Content.replace(/\r\n/g, '\n'),
      'hello world\n',
      'Modified file must be restored'
    );
    assert.ok(
      !fs.existsSync(path.win32.join(env.repoDir, 'temp_added.txt')),
      'Added file must be deleted'
    );
    assert.ok(
      fs.existsSync(path.win32.join(env.repoDir, 'ignored.txt')),
      'Ignored file must be preserved'
    );
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: retention prunes checkpoints exceeding limit', async () => {
  const env = await setupTestEnv();
  try {
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), `content ${i}\n`, 'utf8');
      await createCheckpoint(env.repoDir, {
        jobKey: 'job_retention',
        label: `step ${i}`,
        retention: 5,
      });
    }

    const list = await listCheckpoints(env.repoDir, { jobId: 'job_retention' });
    assert.equal(list.checkpoints.length, 5, 'Must keep only newest 5 checkpoints');
    assert.equal(list.checkpoints[0]?.n, 7);
    assert.equal(list.checkpoints[4]?.n, 3);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: route checkpoint_rollback_target retrieves first checkpoint of job', async () => {
  const env = await setupTestEnv();
  try {
    const jobId = 'job_rollback_123';
    // Write fake job metadata file
    const metaFile = path.win32.join(env.jobsDir, `${jobId}.json`);
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        job_id: jobId,
        project_path: env.repoDir,
        status: 'DONE',
      }),
      'utf8'
    );

    await createCheckpoint(env.repoDir, {
      jobKey: jobId,
      event: 'job-start',
      label: 'before job start',
    });

    fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'edited\n', 'utf8');

    await createCheckpoint(env.repoDir, {
      jobKey: jobId,
      event: 'before-agent',
      label: 'before agent',
    });

    const handler = feature.routes.checkpoint_rollback_target!.handler;
    const req = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=checkpoint_rollback_target&job_id=${jobId}`
    );
    const resp = (await handler(req, req)) as Record<string, unknown>;

    assert.equal(resp.ok, true);
    assert.equal(resp.project_path, env.repoDir);
    const cp = resp.checkpoint as Record<string, unknown>;
    assert.equal(cp.id, `${jobId}/0001`);
    assert.equal(cp.event, 'job-start');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: option injection rejected on checkpoint_diff (from=--output=...)', async () => {
  const env = await setupTestEnv();
  try {
    const handler = feature.routes.checkpoint_diff!.handler;
    const req = makeMockRequest(
      env.ctx,
      `http://127.0.0.1/api?action=checkpoint_diff&project_path=${encodeURIComponent(env.repoDir)}&from=--output=injected.txt`
    );
    await assert.rejects(
      async () => await handler(req, req),
      (err: unknown) => err instanceof ApiValidationError && err.statusCode === 400
    );
    assert.ok(!fs.existsSync(path.win32.join(env.repoDir, 'injected.txt')));
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: delta restore preserves mtime of unchanged files', async () => {
  const env = await setupTestEnv();
  try {
    // Create baseline with two files
    fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'content 1\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'file2.txt'), 'content 2\n', 'utf8');
    const cpRes = await createCheckpoint(env.repoDir, {
      jobKey: 'job_delta',
      label: 'baseline',
    });

    const mtime1Before = fs.statSync(path.win32.join(env.repoDir, 'file1.txt')).mtimeMs;

    // Small delay to ensure timestamp difference if modified
    await new Promise((r) => setTimeout(r, 60));

    // Modify file2 and add file3
    fs.writeFileSync(path.win32.join(env.repoDir, 'file2.txt'), 'content 2 modified\n', 'utf8');
    fs.writeFileSync(path.win32.join(env.repoDir, 'file3_added.txt'), 'new file\n', 'utf8');

    const restoreRes = await restoreTree(env.repoDir, cpRes.checkpoint.id, {
      confirm: true,
      auditFile: env.paths.auditFile,
      checkpointsAuditFile: path.win32.join(env.mawHome, 'audit.jsonl'),
    });

    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.files_written, 1, 'Only file2 should be written');
    assert.equal(restoreRes.files_deleted, 1, 'Only file3_added should be deleted');

    const mtime1After = fs.statSync(path.win32.join(env.repoDir, 'file1.txt')).mtimeMs;
    assert.equal(mtime1After, mtime1Before, 'Unchanged file1 mtime must be preserved');
    assert.ok(!fs.existsSync(path.win32.join(env.repoDir, 'file3_added.txt')));
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints: 3 concurrent createCheckpoint calls allocate distinct sequential refs (0001, 0002, 0003)', async () => {
  const env = await setupTestEnv();
  try {
    // We create 3 distinct states by having different trees or running createCheckpoint sequentially or concurrently
    // Testing C3 concurrency retry loop
    const results = await Promise.all([
      createCheckpoint(env.repoDir, {
        jobKey: 'job_concurrent',
        label: 'first call',
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'mod a\n', 'utf8');
        return await createCheckpoint(env.repoDir, {
          jobKey: 'job_concurrent',
          label: 'second call',
        });
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'mod b\n', 'utf8');
        return await createCheckpoint(env.repoDir, {
          jobKey: 'job_concurrent',
          label: 'third call',
        });
      })(),
    ]);

    const ids = results.map((r) => r.checkpoint.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, 'All 3 checkpoint ids must be distinct');
    assert.ok(ids.includes('job_concurrent/0001'));
    assert.ok(ids.includes('job_concurrent/0002'));
    assert.ok(ids.includes('job_concurrent/0003'));
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints X3: restoreTree throws 500 mentioning safety checkpoint if checkout-index fails and does not delete files', async () => {
  const env = await setupTestEnv();
  const subDir = path.win32.join(env.repoDir, 'sub_protected');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.win32.join(subDir, 'sub_file.txt'), 'sub initial\n', 'utf8');
  await runCommand('git', ['add', '.'], { cwd: env.repoDir });
  await runCommand('git', ['commit', '-m', 'add sub_protected'], { cwd: env.repoDir });

  try {
    const cp1 = await createCheckpoint(env.repoDir, {
      jobKey: 'job_x3',
      label: 'initial checkpoint',
    });

    // Add a file that target commit does NOT have (filesToDelete)
    const extraFilePath = path.win32.join(env.repoDir, 'will_it_be_deleted.txt');
    fs.writeFileSync(extraFilePath, 'precious new file\n', 'utf8');

    // Modify sub_file.txt so it will be in filesToWrite
    fs.writeFileSync(path.win32.join(subDir, 'sub_file.txt'), 'modified sub\n', 'utf8');

    // Deny write on subDir so checkout-index fails
    await runCommand('icacls', [subDir, '/deny', 'Everyone:(W)']);

    let caughtErr: any = null;
    try {
      await restoreTree(env.repoDir, cp1.checkpoint.id, { confirm: true });
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'restoreTree should have thrown');
    assert.equal(caughtErr.statusCode, 500);
    assert.match(caughtErr.message, /safety checkpoint/i);

    // Verify extra file was NOT deleted
    assert.ok(fs.existsSync(extraFilePath), 'Precious file must not have been deleted');
  } finally {
    try {
      await runCommand('icacls', [subDir, '/remove:d', 'Everyone']);
    } catch {}
    cleanupTestEnv(env);
  }
});

test('S1 Checkpoints Y2: retention never prunes the newly created checkpoint even when timestamps tie and n is 1', async () => {
  const env = await setupTestEnv();
  try {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), `content ${i}\n`, 'utf8');
      await createCheckpoint(env.repoDir, {
        jobKey: 'old_job',
        label: `cp ${i}`,
        retention: 5,
      });
    }

    fs.writeFileSync(path.win32.join(env.repoDir, 'file1.txt'), 'safety content\n', 'utf8');
    const safetyRes = await createCheckpoint(env.repoDir, {
      jobKey: 'safety',
      label: 'safety checkpoint',
      retention: 5,
    });

    assert.equal(safetyRes.checkpoint.id, 'safety/0001');

    const checkRes = await runCommand('git', ['rev-parse', '--verify', 'refs/maw/checkpoints/safety/0001'], {
      cwd: env.repoDir,
    });
    assert.equal(checkRes.code, 0, 'safety/0001 must exist and not be pruned');
  } finally {
    cleanupTestEnv(env);
  }
});
