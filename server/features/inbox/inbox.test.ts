import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext } from '../../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import {
  handleInboxAct,
  handleInboxAdd,
  handleInboxClear,
  handleInboxGet,
  handleInboxList,
  performInboxAction,
  reconcilePendingClaim,
  reconcilePendingClaims,
} from './actions.ts';
import { acquireFileLock } from './lockfile.ts';
import { buildMeaningfulDetail, runJobScanner } from './scanner.ts';
import {
  addInboxItem,
  getInboxItem,
  onInboxResolved,
  readInboxData,
  resetInboxResolvedTracker,
} from './store.ts';

function createTempTestPaths(): { paths: ServerPaths; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maw_inbox_test_'));
  const userProfile = path.join(tmpRoot, 'UserProfile');
  const mawHome = path.join(tmpRoot, 'MawHome');
  const jobsDir = path.join(tmpRoot, 'jobs');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const paths = resolveServerPaths({
    repoRoot,
    userProfile,
    mawHome,
  });
  paths.jobsDir = jobsDir;

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    },
  };
}

test('inbox store add, get, dedupe, and clear', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const res1 = addInboxItem(paths, {
      kind: 'failed',
      title: 'Job 1 failed',
      detail: 'Exit code 1',
      dedupe_key: 'job:1:failed',
    });
    assert.equal(res1.created, true);
    assert.match(res1.item.id, /^i[0-9a-z]{6}$/);

    // Duplicate add should update rather than duplicate
    const res2 = addInboxItem(paths, {
      kind: 'failed',
      title: 'Job 1 failed again',
      detail: 'Updated detail',
      dedupe_key: 'job:1:failed',
    });
    assert.equal(res2.created, false);
    assert.equal(res2.item.id, res1.item.id);
    assert.equal(res2.item.detail, 'Updated detail');

    const fetched = getInboxItem(paths, res1.item.id);
    assert.ok(fetched);
    assert.equal(fetched.id, res1.item.id);

    const data = readInboxData(paths);
    assert.equal(data.items.length, 1);
  } finally {
    cleanup();
  }
});

test('inbox scanner handles auth, blocked, council exit 2, and failed jobs', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    fs.mkdirSync(paths.jobsDir, { recursive: true });

    // 1. Auth failure job
    const jobAuthId = 'job_test_auth';
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobAuthId}.json`),
      JSON.stringify({
        job_id: jobAuthId,
        agent: 'claude',
        mode: 'task',
        role: 'backend',
        status: 'FAILED',
        exit_code: 1,
        project_path: paths.repoRoot,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobAuthId}.log`),
      'OAuth session has expired. Please run /login\r\n=== [JOB_FINISHED exit_code=1] ===\r\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobAuthId}.prompt.txt`),
      'Test auth prompt',
      'utf8'
    );

    // 2. Hook blocked job
    const jobBlockId = 'job_test_blocked';
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobBlockId}.json`),
      JSON.stringify({
        job_id: jobBlockId,
        agent: 'codex',
        mode: 'task',
        role: 'reviewer',
        status: 'FAILED',
        exit_code: 5,
        project_path: paths.repoRoot,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobBlockId}.log`),
      'HOOK_BLOCKED (before-agent): Codex CLI: Not logged in. Fix: codex login\r\n=== [JOB_FINISHED exit_code=5] ===\r\n',
      'utf8'
    );

    // 3. Council review exit 2 job
    const jobCouncilId = 'job_test_council';
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobCouncilId}.json`),
      JSON.stringify({
        job_id: jobCouncilId,
        agent: 'claude',
        mode: 'council',
        role: 'reviewer',
        status: 'FAILED',
        exit_code: 2,
        project_path: paths.repoRoot,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobCouncilId}.log`),
      '=== COUNCIL_RESULT claude=CHANGES_REQUESTED|6/10 ===\r\n=== [JOB_FINISHED exit_code=2] ===\r\n',
      'utf8'
    );

    // Run scanner
    await runJobScanner(paths);

    const data = readInboxData(paths);
    assert.equal(data.items.length, 3);

    const authItem = data.items.find((it) => it.job_id === jobAuthId);
    assert.ok(authItem);
    assert.equal(authItem.kind, 'needs_login');
    assert.equal(authItem.severity, 'error');
    assert.ok(authItem.actions.includes('login'));
    assert.ok(authItem.actions.includes('retry'));
    assert.equal(authItem.retry?.prompt, 'Test auth prompt');

    const blockedItem = data.items.find((it) => it.job_id === jobBlockId);
    assert.ok(blockedItem);
    assert.equal(blockedItem.kind, 'blocked');
    assert.equal(blockedItem.severity, 'warn');
    assert.ok(blockedItem.detail.includes('Not logged in'));

    const councilItem = data.items.find((it) => it.job_id === jobCouncilId);
    assert.ok(councilItem);
    assert.equal(councilItem.kind, 'review_changes');
    assert.equal(councilItem.severity, 'warn');
  } finally {
    cleanup();
  }
});

test('inbox_act retry and reply follow-up', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    let startedJobBody: Record<string, unknown> | null = null;

    const ctx = createFeatureContext(paths, registry);
    ctx.startJob = async (body: Record<string, unknown>) => {
      startedJobBody = body;
      return { ok: true, job_id: 'job_retried_123', status: 'RUNNING' };
    };

    // Add an item with retry info
    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Job failed',
      actions: ['open', 'retry', 'reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        project_path: paths.repoRoot,
        prompt: 'Original prompt text',
      },
    });

    let resolvedEvent: any = null;
    const unsub = onInboxResolved((resolved) => {
      resolvedEvent = resolved;
    });

    // 1. Test retry action
    const reqRetry = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=inbox_act'),
      query: new URLSearchParams(''),
      body: {
        id: item.id,
        action: 'retry',
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const resRetry = (await handleInboxAct(ctx, reqRetry)) as {
      ok: boolean;
      job_id: string;
      item: any;
    };
    assert.equal(resRetry.ok, true);
    assert.equal(resRetry.job_id, 'job_retried_123');
    assert.equal(resRetry.item.status, 'done');
    assert.ok(startedJobBody);
    assert.equal((startedJobBody as any).agent, 'claude');
    assert.ok(resolvedEvent);
    assert.equal(resolvedEvent.id, item.id);

    unsub();

    // 2. Test reply action on a new item
    const { item: item2 } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Waiting for answer',
      actions: ['open', 'reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        project_path: paths.repoRoot,
        prompt: 'Base prompt',
      },
    });

    startedJobBody = null;
    const reqReply = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=inbox_act'),
      query: new URLSearchParams(''),
      body: {
        id: item2.id,
        action: 'reply',
        text: 'Proceed with option A',
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const resReply = (await handleInboxAct(ctx, reqReply)) as {
      ok: boolean;
      job_id: string;
      item: any;
    };
    assert.equal(resReply.ok, true);
    assert.equal(resReply.job_id, 'job_retried_123');
    assert.ok(startedJobBody);
    assert.ok((startedJobBody as any).prompt.includes('Base prompt'));
    assert.ok((startedJobBody as any).prompt.includes('Proceed with option A'));
  } finally {
    cleanup();
  }
});

test('Inbox Major 10 regression: scanner refreshes stale RUNNING meta via refreshJobMetaStatus', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    fs.mkdirSync(paths.jobsDir, { recursive: true });

    const jobId = 'job_stale_running_test';
    // Meta says RUNNING
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobId}.json`),
      JSON.stringify({
        job_id: jobId,
        agent: 'claude',
        mode: 'task',
        role: 'backend',
        status: 'RUNNING',
        pid: 9999999, // Dead PID
        project_path: paths.repoRoot,
      }),
      'utf8'
    );

    // Log has exit marker + auth error
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobId}.log`),
      'Starting agent...\nError: OAuth session expired. Please run /login\n=== [JOB_FINISHED exit_code=1] ===\n',
      'utf8'
    );

    await runJobScanner(paths);

    const inbox = readInboxData(paths);
    const item = inbox.items.find((it) => it.job_id === jobId);
    assert.ok(item, 'Scanner must create an inbox item after refreshing stale RUNNING meta');
    assert.equal(item.kind, 'needs_login');
    assert.equal(item.status, 'open');
  } finally {
    cleanup();
  }
});

test('Inbox Major 11 regression: dismissed items do not reappear after scanner re-run or restart', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    fs.mkdirSync(paths.jobsDir, { recursive: true });

    const jobId = 'job_failed_dismiss_test';
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobId}.json`),
      JSON.stringify({
        job_id: jobId,
        agent: 'codex',
        mode: 'task',
        role: 'backend',
        status: 'FAILED',
        exit_code: 1,
        project_path: paths.repoRoot,
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(paths.jobsDir, `${jobId}.log`),
      'Fatal error: syntax failure\n',
      'utf8'
    );

    // Initial scan creates open failed item
    await runJobScanner(paths);
    let inbox = readInboxData(paths);
    let item = inbox.items.find((it) => it.job_id === jobId);
    assert.ok(item);
    assert.equal(item.status, 'open');

    // User dismisses item
    item.status = 'dismissed';
    fs.writeFileSync(path.join(paths.featureDataDir('inbox'), 'items.json'), JSON.stringify(inbox, null, 2), 'utf8');

    // Rescan: must NOT create another open item
    await runJobScanner(paths);
    inbox = readInboxData(paths);
    const matchingItems = inbox.items.filter((it) => it.job_id === jobId);
    assert.equal(matchingItems.length, 1);
    assert.equal(matchingItems[0]!.status, 'dismissed');
  } finally {
    cleanup();
  }
});

test('Inbox Major 12 regression: retry or reply on non-open item throws 409 already resolved', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Already resolved test',
      actions: ['retry', 'open', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        project_path: paths.repoRoot,
      },
    });

    // Mark as done
    item.status = 'done';
    const inbox = readInboxData(paths);
    inbox.items[0]!.status = 'done';
    fs.writeFileSync(path.join(paths.featureDataDir('inbox'), 'items.json'), JSON.stringify(inbox, null, 2), 'utf8');

    const reqAct = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=inbox_act'),
      query: new URLSearchParams(''),
      body: {
        id: item.id,
        action: 'retry',
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    await assert.rejects(
      async () => handleInboxAct(ctx, reqAct),
      (err: any) => err.statusCode === 409 && err.message.includes('already resolved')
    );
  } finally {
    cleanup();
  }
});

test('Inbox Round 2 Item 2: concurrent retry calls only invoke startJob once and reject the concurrent call with 409', async () => {
  const { paths, cleanup } = createTempTestPaths();

  try {
    const registry = loadAgentRegistry(paths);
    let startJobCalls = 0;
    const ctx = {
      ...createFeatureContext(paths, registry),
      startJob: async () => {
        startJobCalls++;
        // Simulate async latency so concurrent call overlaps
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, job_id: 'job_concurrent_retry_res' };
      },
    };

    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Concurrent retry test',
      actions: ['retry', 'open', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        project_path: paths.repoRoot,
      },
    });

    // Launch two retry calls concurrently
    const [res1, res2] = await Promise.allSettled([
      performInboxAction(ctx, item.id, 'retry', undefined, 'ui'),
      performInboxAction(ctx, item.id, 'retry', undefined, 'telegram'),
    ]);

    // Exactly one must succeed and one must be rejected with 409
    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent call must succeed');
    assert.equal(rejected.length, 1, 'Concurrent call must be rejected');
    assert.equal((rejected[0] as PromiseRejectedResult).reason?.statusCode, 409);
    assert.equal(startJobCalls, 1, 'startJob must be called exactly once');
  } finally {
    cleanup();
  }
});

test('Inbox Round 2 Item 3: buildMeaningfulDetail strips job header/mode/ruler/footer noise and prefers pattern-matching lines', () => {
  const noisyLog = [
    '=== [MISSION CONTROL JOB job_20261025_020001_b16685] ===',
    'Mode: TASK | Agent: claude | Role: backend | Project: C:\\Users\\TestAdmin\\project',
    'Started: 2026-10-25 02:00:01',
    '------------------------------------------------------------',
    'Compiling server sources...',
    'Found syntax error in server/http.ts:42',
    'OAuth token has expired. Please run /login to authenticate.',
    'Build aborted with exit code 1',
    '------------------------------------------------------------',
    '=== [JOB_FINISHED exit_code=1] ===',
  ].join('\n');

  // For needs_login, it should prefer the matched line and clean out header/mode/ruler noise
  const detail = buildMeaningfulDetail(noisyLog, 'needs_login', 'claude', 'C:\\Users\\TestAdmin');
  assert.ok(!detail.includes('MISSION CONTROL JOB'));
  assert.ok(!detail.includes('Mode: TASK'));
  assert.ok(!detail.includes('------------------'));
  assert.ok(!detail.includes('JOB_FINISHED'));
  assert.ok(detail.includes('OAuth token has expired. Please run /login to authenticate.'));
  assert.ok(detail.includes('~\\project') || !detail.includes('C:\\Users\\TestAdmin'));

  // For generic failure with many lines, it returns <= 8 lines
  const longTail = Array.from({ length: 20 }, (_, i) => `Step ${i + 1} processing`).join('\n');
  const failedDetail = buildMeaningfulDetail(longTail, 'failed', 'claude');
  const lines = failedDetail.split('\n');
  assert.ok(lines.length <= 8, `Expected <= 8 lines, got ${lines.length}`);
  assert.equal(lines[lines.length - 1], 'Step 20 processing');
});

test('Inbox Round 3 Item 4: approve, reject, and done on non-open item throw 409, dismiss is idempotent, and onInboxResolved fires at most once', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  try {
    let resolvedCount = 0;
    const unsub = onInboxResolved(() => {
      resolvedCount++;
    });

    // 1. Approval item: approve succeeds once, subsequent calls throw 409
    const { item: approvalItem } = addInboxItem(paths, {
      kind: 'approval',
      title: 'Deploy approval',
      actions: ['approve', 'reject', 'dismiss'],
    });

    const appRes1 = await performInboxAction(ctx, approvalItem.id, 'approve', undefined, 'ui');
    assert.equal(appRes1.ok, true);
    assert.equal((appRes1.item as any).status, 'approved');
    assert.equal(resolvedCount, 1, 'onInboxResolved should have fired once');

    // Subsequent approve => 409
    await assert.rejects(
      async () => await performInboxAction(ctx, approvalItem.id, 'approve', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already resolved')
    );

    // Reject on approved => 409
    await assert.rejects(
      async () => await performInboxAction(ctx, approvalItem.id, 'reject', undefined, 'ui'),
      (err: any) => err.statusCode === 409
    );

    // Done on approved => 409
    await assert.rejects(
      async () => await performInboxAction(ctx, approvalItem.id, 'done', undefined, 'ui'),
      (err: any) => err.statusCode === 409
    );

    // Dismiss on approved => 409
    await assert.rejects(
      async () => await performInboxAction(ctx, approvalItem.id, 'dismiss', undefined, 'ui'),
      (err: any) => err.statusCode === 409
    );

    assert.equal(resolvedCount, 1, 'onInboxResolved must not fire for rejected operations');

    // 2. Dismiss is idempotent on already-dismissed item
    const { item: dismissItem } = addInboxItem(paths, {
      kind: 'custom',
      title: 'Dismissable notice',
      actions: ['dismiss'],
    });

    const disRes1 = await performInboxAction(ctx, dismissItem.id, 'dismiss', undefined, 'ui');
    assert.equal(disRes1.ok, true);
    assert.equal((disRes1.item as any).status, 'dismissed');
    assert.equal(resolvedCount, 2, 'onInboxResolved should fire on first dismissal');

    // Idempotent second dismiss
    const disRes2 = await performInboxAction(ctx, dismissItem.id, 'dismiss', undefined, 'ui');
    assert.equal(disRes2.ok, true);
    assert.equal((disRes2.item as any).status, 'dismissed');
    assert.equal(resolvedCount, 2, 'onInboxResolved must NOT fire again on idempotent dismiss');

    unsub();
  } finally {
    cleanup();
  }
});

test('Inbox Round 3 Item 6: reply path rolls back to open on startJob failure', async () => {
  const { paths, cleanup } = createTempTestPaths();
  let failStartJob = true;

  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));
  ctx.startJob = async () => {
    if (failStartJob) {
      throw new Error('Follow-up runner failed');
    }
    return { ok: true, job_id: 'job_followup_success_123' };
  };

  try {
    const { item } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Waiting for prompt clarification',
      actions: ['reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Initial prompt',
      },
    });

    // 1. Reply when startJob fails => throws, status rolls back to 'open'
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'reply', 'User clarification here', 'ui'),
      /Follow-up runner failed/
    );

    const rolledBack = getInboxItem(paths, item.id);
    assert.ok(rolledBack, 'Item must still exist');
    assert.equal(rolledBack.status, 'open', 'Item status must be rolled back to open');
    assert.equal(rolledBack.resolution, null, 'Item resolution must be rolled back to null');

    // 2. Retry reply when startJob succeeds => succeeds, status becomes 'done'
    failStartJob = false;
    const repRes = await performInboxAction(ctx, item.id, 'reply', 'User clarification here', 'ui');
    assert.equal(repRes.ok, true);
    assert.equal((repRes.item as any).status, 'done');
    assert.equal(repRes.job_id, 'job_followup_success_123');

    const doneItem = getInboxItem(paths, item.id);
    assert.equal(doneItem?.status, 'done');
    assert.equal(doneItem?.resolution?.job_id, 'job_followup_success_123');
  } finally {
    cleanup();
  }
});

test('Item 5: pre-existing atomic claim lock rejects with 409 without calling startJob', async () => {
  const { paths, cleanup } = createTempTestPaths();
  let startJobCalls = 0;

  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));
  ctx.startJob = async () => {
    startJobCalls++;
    return { ok: true, job_id: 'job_retry_item5_success' };
  };

  try {
    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Item with atomic claim test',
      actions: ['retry', 'reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Retry prompt',
      },
    });

    // Create active claim lock file for current process in data/inbox/claims/<id>.lock
    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimFile = path.join(claimsDir, `${item.id}.lock`);
    fs.writeFileSync(claimFile, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', 'utf8');

    // 1. Retry with pre-existing claim => 409, startJob not called
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'retry', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already being processed')
    );
    assert.equal(startJobCalls, 0, 'startJob must not be called when claim file exists');
    assert.equal(getInboxItem(paths, item.id)?.status, 'open');

    // 2. Reply with pre-existing claim => 409, startJob not called
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'reply', 'Clarification while claimed', 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already being processed')
    );
    assert.equal(startJobCalls, 0, 'startJob must not be called on reply when claim file exists');
    assert.equal(getInboxItem(paths, item.id)?.status, 'open');

    // Remove pre-existing claim file
    fs.unlinkSync(claimFile);

    // 3. Now retry succeeds, calls startJob, sets status to done, and lock file is released
    const retryRes = await performInboxAction(ctx, item.id, 'retry', undefined, 'ui');
    assert.equal(retryRes.ok, true);
    assert.equal(startJobCalls, 1, 'startJob must be called once');
    assert.equal(getInboxItem(paths, item.id)?.status, 'done');
    assert.equal(fs.existsSync(claimFile), false, 'Claim file should be cleaned up after status update');
  } finally {
    cleanup();
  }
});

test('Codex Review #3 Item 2: retry in flight blocks approve with 409 processed; approve after retry finishes throws 409 resolved', async () => {
  const { paths, cleanup } = createTempTestPaths();
  let startJobCalled = false;

  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));
  ctx.startJob = async () => {
    startJobCalled = true;
    // Simulate long-running in-flight job execution
    await new Promise((r) => setTimeout(r, 60));
    return { ok: true, job_id: 'job_in_flight_123' };
  };

  try {
    const { item } = addInboxItem(paths, {
      kind: 'review_changes',
      title: 'Review item with retry and approval',
      actions: ['retry', 'approve', 'reject', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Retry code',
      },
    });

    // 1. Launch retry asynchronously (claim held during startJob)
    const retryPromise = performInboxAction(ctx, item.id, 'retry', undefined, 'ui');

    // Wait a brief tick so retry acquires the claim and enters startJob
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(startJobCalled, true, 'startJob must be running');

    // 2. Concurrently attempt approve: claim is held => 409 already being processed
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'approve', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already being processed')
    );

    // 3. Await retry completion
    const retryRes = await retryPromise;
    assert.equal(retryRes.ok, true);
    assert.equal(getInboxItem(paths, item.id)?.status, 'done');

    // 4. Now attempt approve after retry finished: item is resolved => 409 already resolved
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'approve', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already resolved')
    );
  } finally {
    cleanup();
  }
});

test('Codex Review #4 Item 1: path traversal protection on inbox id', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  try {
    const maliciousId = '..\\..\\x';

    // 1. performInboxAction with traversal id throws 400
    await assert.rejects(
      async () => await performInboxAction(ctx, maliciousId, 'dismiss', undefined, 'ui'),
      (err: any) => err.statusCode === 400 && err.message.includes('Invalid inbox item id')
    );

    // 2. handleInboxGet with traversal id throws 400
    const fakeGetReq = {
      path: '/api/features/inbox/inbox_get',
      method: 'GET',
      query: new URLSearchParams({ id: maliciousId }),
      body: {},
      headers: new Headers(),
    };
    assert.throws(
      () => handleInboxGet(ctx, fakeGetReq as any),
      (err: any) => err.statusCode === 400 && err.message.includes('Invalid inbox item id')
    );

    // 3. handleInboxAct with traversal id throws 400
    const fakeActReq = {
      path: '/api/features/inbox/inbox_act',
      method: 'POST',
      query: new URLSearchParams(),
      body: { id: maliciousId, action: 'dismiss' },
      headers: new Headers(),
    };
    await assert.rejects(
      async () => await handleInboxAct(ctx, fakeActReq as any),
      (err: any) => err.statusCode === 400 && err.message.includes('Invalid inbox item id')
    );

    // 4. Verify no file was created outside claims directory
    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    const traversalTarget = path.join(paths.featureDataDir('inbox'), '..', 'x.lock');
    assert.equal(fs.existsSync(traversalTarget), false);
    if (fs.existsSync(claimsDir)) {
      const files = fs.readdirSync(claimsDir);
      assert.equal(files.length, 0);
    }
  } finally {
    cleanup();
  }
});

test('Codex Review #4 Item 2: live claims are never stolen, dead pid or corrupt > 10m is recovered', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  try {
    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Live claim test',
      actions: ['dismiss'],
    });

    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimFile = path.join(claimsDir, `${item.id}.lock`);

    // 1. Claim held by current process (live PID) with timestamp 5 minutes old (300,000ms)
    fs.writeFileSync(
      claimFile,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 300_000 }) + '\n',
      'utf8'
    );

    // Action MUST throw 409 because the PID is alive! Live claim is NEVER stolen!
    await assert.rejects(
      async () => await performInboxAction(ctx, item.id, 'dismiss', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already being processed')
    );

    // 2. Dead PID (e.g. 999999): should be recognized as stale and recovered
    fs.writeFileSync(
      claimFile,
      JSON.stringify({ pid: 999999, ts: Date.now() }) + '\n',
      'utf8'
    );
    const resDead = await performInboxAction(ctx, item.id, 'dismiss', undefined, 'ui');
    assert.equal(resDead.ok, true);
    assert.equal(getInboxItem(paths, item.id)?.status, 'dismissed');

    // 3. Corrupt claim file older than 10 minutes: should be recovered
    const { item: item2 } = addInboxItem(paths, {
      kind: 'needs_login',
      title: 'Corrupt claim test',
      actions: ['dismiss'],
    });
    const claimFile2 = path.join(claimsDir, `${item2.id}.lock`);
    fs.writeFileSync(claimFile2, '{not-valid-json', 'utf8');
    const oldTime = (Date.now() - 700_000) / 1000;
    fs.utimesSync(claimFile2, oldTime, oldTime);

    const resCorrupt = await performInboxAction(ctx, item2.id, 'dismiss', undefined, 'ui');
    assert.equal(resCorrupt.ok, true);
    assert.equal(getInboxItem(paths, item2.id)?.status, 'dismissed');
  } finally {
    cleanup();
  }
});

test('Codex Review #4 Item 3: items.json store-level lock with withItemsLock', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const dataDir = paths.featureDataDir('inbox');
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'items.lock');

  try {
    // 1. Lock held by live PID -> addInboxItem throws 503 "Inbox is busy, try again."
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n',
      'utf8'
    );

    assert.throws(
      () => {
        addInboxItem(paths, {
          kind: 'failed',
          title: 'Should fail due to busy lock',
        });
      },
      (err: any) => err.statusCode === 503 && err.message.includes('Inbox is busy')
    );

    // Clean up live lock file before next test step
    fs.unlinkSync(lockFile);

    // 2. Lock held by dead PID -> should be recognized as stale and recovered
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, ts: Date.now() }) + '\n',
      'utf8'
    );

    const res = addInboxItem(paths, {
      kind: 'failed',
      title: 'Should succeed after recovering dead lock',
    });
    assert.equal(res.created, true);
    assert.equal(fs.existsSync(lockFile), false, 'lock file must be unlinked after completion');
  } finally {
    cleanup();
  }
});

test('Codex Review #6 Item 1: Two processes recovering dead lock => exactly one owner and release never removes someone elses lock', () => {
  const { paths, cleanup } = createTempTestPaths();
  const dataDir = paths.featureDataDir('inbox');
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'test_recovery.lock');

  try {
    // 1. Initial state: dead PID owns the lock
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, ts: 1000 }) + '\n', 'utf8');

    // 2. Process 1 acquires lock via acquireFileLock -> recovers stale lock via .recover mutex
    const handle1 = acquireFileLock(lockFile, { timeoutMs: 0 });
    assert.equal(handle1.pid, process.pid);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.existsSync(lockFile + '.recover'), false, '.recover mutex must be cleaned up in finally');

    // 3. Process 2 attempts immediate acquisition while handle1 is live -> rejected with 409
    assert.throws(
      () => {
        acquireFileLock(lockFile, { timeoutMs: 0 });
      },
      (err: any) => err.statusCode === 409 && err.message.includes('already being processed')
    );

    // 4. Safe release: simulate that someone else replaced the lock on disk with a new PID/ts
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 888888, ts: Date.now() + 5000 }) + '\n', 'utf8');

    // Process 1 calls release(): because PID/ts do not match handle1, it must NOT unlink someone else's lock!
    handle1.release();
    assert.equal(fs.existsSync(lockFile), true, 'release must never unlink someone elses lock');
    const remaining = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(remaining.pid, 888888, 'Lock must remain untouched');

    // 5. Normal release when matching pid/ts:
    const handle3 = acquireFileLock(lockFile + '.norm', { timeoutMs: 0 });
    assert.equal(fs.existsSync(lockFile + '.norm'), true);
    handle3.release();
    assert.equal(fs.existsSync(lockFile + '.norm'), false, 'Normal release unlinks file when pid/ts match');
  } finally {
    cleanup();
  }
});

test('Codex Review #6 Item 2: Journal before dispatch failure aborts 503; dead owner with starting/started resolves with note without redispatch', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  let startJobCalls = 0;
  ctx.startJob = async () => {
    startJobCalls++;
    return { ok: true, job_id: 'job_review6_new' };
  };

  try {
    // --- Part A: Journal write failure BEFORE startJob aborts with 503 and NO job is started ---
    const { item: itemA } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Journal fail test',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Do not start if journal fails',
      },
    });

    // Make fs.writeFileSync fail when writing starting journal to claim file
    const origWriteFileSync = fs.writeFileSync;
    let failStartingJournal = true;
    (fs as any).writeFileSync = (targetPath: any, data: any, enc: any) => {
      if (failStartingJournal && typeof data === 'string' && data.includes('"state":"starting"')) {
        throw new Error('Disk full during journal write');
      }
      return origWriteFileSync(targetPath, data, enc);
    };

    try {
      await assert.rejects(
        async () => await performInboxAction(ctx, itemA.id, 'retry', undefined, 'ui'),
        (err: any) => err.statusCode === 503 && err.message.includes('Failed to journal action before job start')
      );
      assert.equal(startJobCalls, 0, 'ctx.startJob must NEVER be called if journal write fails');
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }

    // --- Part B: Claim in state "starting" from dead owner resolves to done with note and NO redispatch ---
    const { item: itemB } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Dead starting claim test',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Interrupted while starting',
      },
    });

    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimBPath = path.join(claimsDir, `${itemB.id}.lock`);
    fs.writeFileSync(
      claimBPath,
      JSON.stringify({
        pid: 999999,
        ts: 1000,
        state: 'starting',
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
      }) + '\n',
      'utf8'
    );

    let resolvedNotifiedItem: any = null;
    const unsubB = onInboxResolved((it) => {
      resolvedNotifiedItem = it;
    });

    try {
      // Reconcile via reconcilePendingClaim
      const reconciled = await reconcilePendingClaim(paths, itemB.id);
      assert.equal(reconciled, true);
      assert.equal(startJobCalls, 0, 'Recovery must NEVER re-dispatch');
      assert.equal(fs.existsSync(claimBPath), false, 'Claim file must be unlinked after recovery');

      const updatedB = getInboxItem(paths, itemB.id);
      assert.equal(updatedB?.status, 'done');
      assert.equal(updatedB?.resolution?.action, 'retry');
      assert.equal(updatedB?.resolution?.note, 'interrupted \u2014 check the job list');
      assert.ok(resolvedNotifiedItem);
      assert.equal(resolvedNotifiedItem.id, itemB.id);
    } finally {
      unsubB();
    }

    // --- Part C: Claim in state "started" with job_id from dead owner resolves to done with job_id and note ---
    const { item: itemC } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Dead started claim test',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Interrupted while started',
      },
    });

    const claimCPath = path.join(claimsDir, `${itemC.id}.lock`);
    fs.writeFileSync(
      claimCPath,
      JSON.stringify({
        pid: 999999,
        ts: 1000,
        state: 'started',
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
        job_id: 'job_c_already_dispatched',
      }) + '\n',
      'utf8'
    );

    const reconciledC = await reconcilePendingClaim(paths, itemC.id);
    assert.equal(reconciledC, true);
    assert.equal(startJobCalls, 0, 'Recovery must NEVER re-dispatch');

    const updatedC = getInboxItem(paths, itemC.id);
    assert.equal(updatedC?.status, 'done');
    assert.equal(updatedC?.resolution?.job_id, 'job_c_already_dispatched');
    assert.equal(updatedC?.resolution?.note, 'interrupted \u2014 check the job list');
  } finally {
    cleanup();
  }
});

test('Codex Review #6 Item 3: Reply stores and fires onInboxResolved first; follow-up job only if no listener handled and item has retry', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  let startJobCalls = 0;
  ctx.startJob = async (body: any) => {
    startJobCalls++;
    return { ok: true, job_id: 'job_followup_r6_' + startJobCalls };
  };

  try {
    // --- Part A: Listener handles reply (returns true) => no follow-up job is spawned ---
    const { item: itemA } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Reply handled by listener',
      actions: ['reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Original prompt A',
      },
    });

    let listenerSawItemA: any = null;
    const unsubA = onInboxResolved((it) => {
      listenerSawItemA = it;
      return true; // Handled by listener (e.g. interactive agent or steer)
    });

    try {
      const resA = await performInboxAction(ctx, itemA.id, 'reply', 'User reply for A', 'ui');
      assert.equal(resA.ok, true);
      assert.equal(resA.job_id, undefined, 'No follow-up job when handled by listener');
      assert.equal(startJobCalls, 0, 'startJob must NOT be called when listener returns true');

      assert.ok(listenerSawItemA);
      assert.equal(listenerSawItemA.id, itemA.id);
      assert.equal(listenerSawItemA.status, 'done');
      assert.equal(listenerSawItemA.resolution?.action, 'reply');
      assert.equal(listenerSawItemA.resolution?.text, 'User reply for A');

      const savedA = getInboxItem(paths, itemA.id);
      assert.equal(savedA?.status, 'done');
      assert.equal(savedA?.resolution?.text, 'User reply for A');
    } finally {
      unsubA();
    }

    // --- Part B: No listener returns true, item has retry => follow-up job started ---
    resetInboxResolvedTracker();
    const { item: itemB } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Reply not handled by listener',
      actions: ['reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Original prompt B',
      },
    });

    let listenerCallOrder = 0;
    let startJobCallOrder = 0;
    let callCounter = 0;

    const unsubB = onInboxResolved((it) => {
      callCounter++;
      listenerCallOrder = callCounter;
      // return void / false => not handled
    });

    const origStartJob = ctx.startJob;
    ctx.startJob = async (body: any) => {
      callCounter++;
      startJobCallOrder = callCounter;
      return await origStartJob(body);
    };

    try {
      const resB = await performInboxAction(ctx, itemB.id, 'reply', 'User reply for B', 'ui');
      assert.equal(resB.ok, true);
      assert.ok(resB.job_id);
      assert.equal(startJobCalls, 1);

      // Verify listener fired FIRST before startJob!
      assert.equal(listenerCallOrder, 1, 'Listener must be called FIRST');
      assert.equal(startJobCallOrder, 2, 'Follow-up job must be started AFTER firing listener');

      const savedB = getInboxItem(paths, itemB.id);
      assert.equal(savedB?.status, 'done');
      assert.equal(savedB?.resolution?.text, 'User reply for B');
      assert.equal(savedB?.resolution?.job_id, resB.job_id);
    } finally {
      unsubB();
    }
  } finally {
    cleanup();
  }
});

test('Codex Review #6 Item 4: Reconciling pending claim calls fireInboxResolved exactly once', async () => {
  const { paths, cleanup } = createTempTestPaths();
  resetInboxResolvedTracker();

  try {
    const { item } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Reconcile firing test',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Fix it',
      },
    });

    // Create a pending claim from a dead process with starting state
    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimPath = path.join(claimsDir, `${item.id}.lock`);
    fs.writeFileSync(
      claimPath,
      JSON.stringify({
        pid: 999999,
        ts: 1000,
        state: 'starting',
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
      }) + '\n',
      'utf8'
    );

    let resolveEventCount = 0;
    const unsub = onInboxResolved((it) => {
      if (it.id === item.id) {
        resolveEventCount++;
      }
    });

    try {
      // 1. First reconcile call
      const rec1 = await reconcilePendingClaim(paths, item.id);
      assert.equal(rec1, true);
      assert.equal(resolveEventCount, 1, 'fireInboxResolved must be called on first reconcile');

      // 2. Second reconcile call on same item
      const rec2 = await reconcilePendingClaim(paths, item.id);
      assert.equal(rec2, false); // lock was already unlinked
      assert.equal(resolveEventCount, 1, 'fireInboxResolved must NOT be called again');
    } finally {
      unsub();
    }
  } finally {
    cleanup();
  }
});

test('Codex Review #5 Item 2: job started but store update fails keeps claim and reconciles later (retry and reply)', async () => {
  const { paths, cleanup } = createTempTestPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  let startedJobId = '';
  ctx.startJob = async () => {
    startedJobId = 'job_started_review5_' + Math.random().toString(36).slice(2);
    return { ok: true, job_id: startedJobId };
  };

  const dataDir = paths.featureDataDir('inbox');
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'items.lock');

  try {
    // --- 1. Test RETRY ---
    const { item: retryItem } = addInboxItem(paths, {
      kind: 'failed',
      title: 'Retry pending store update test',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        prompt: 'Fix server',
      },
    });

    // Hold items.lock with live process PID to force store updates to fail (503)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', 'utf8');

    // performInboxAction on retry: startJob succeeds, store update retries and fails,
    // claim file is KEPT and pending_store_update is returned!
    const resRetry = await performInboxAction(ctx, retryItem.id, 'retry', undefined, 'ui');
    assert.equal(resRetry.ok, true);
    assert.equal(resRetry.job_id, startedJobId);
    assert.equal(resRetry.pending_store_update, true);

    // Verify claim file is kept on disk and records resolution with job_id
    const claimFile = path.join(paths.featureDataDir('inbox'), 'claims', `${retryItem.id}.lock`);
    assert.equal(fs.existsSync(claimFile), true, 'Claim file must be kept');
    const claimData = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(claimData.resolution?.job_id, startedJobId);
    assert.equal(claimData.resolution?.action, 'retry');

    // Now release items.lock
    fs.unlinkSync(lockFile);

    // Reconcile via later action or get:
    // A later action should apply the pending resolution, remove claim, and throw 409
    await assert.rejects(
      async () => await performInboxAction(ctx, retryItem.id, 'dismiss', undefined, 'ui'),
      (err: any) => err.statusCode === 409 && err.message.includes('already resolved')
    );
    assert.equal(fs.existsSync(claimFile), false, 'Claim file must be unlinked after reconciliation');
    const updatedRetryItem = getInboxItem(paths, retryItem.id);
    assert.equal(updatedRetryItem?.status, 'done');
    assert.equal(updatedRetryItem?.resolution?.job_id, startedJobId);

    // --- 2. Test REPLY ---
    const { item: replyItem } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Reply pending store update test',
      actions: ['reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'architect',
        prompt: 'Provide clarification',
      },
    });

    // Hold items.lock during startJob so the store update with job_id fails after follow-up job has started
    ctx.startJob = async () => {
      startedJobId = 'job_started_reply_' + Math.random().toString(36).slice(2);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', 'utf8');
      return { ok: true, job_id: startedJobId };
    };

    const resReply = await performInboxAction(ctx, replyItem.id, 'reply', 'Here is the answer', 'ui');
    assert.equal(resReply.ok, true);
    assert.equal(resReply.pending_store_update, true);
    assert.equal(resReply.job_id, startedJobId);

    // Claim file kept
    const replyClaimFile = path.join(paths.featureDataDir('inbox'), 'claims', `${replyItem.id}.lock`);
    assert.equal(fs.existsSync(replyClaimFile), true, 'Reply claim file must be kept');
    const replyClaimData = JSON.parse(fs.readFileSync(replyClaimFile, 'utf8'));
    assert.equal(replyClaimData.resolution?.job_id, startedJobId);
    assert.equal(replyClaimData.resolution?.text, 'Here is the answer');

    // Release items.lock
    fs.unlinkSync(lockFile);

    // Reconcile via runJobScanner
    await runJobScanner(paths);
    assert.equal(fs.existsSync(replyClaimFile), false, 'Reply claim file must be removed by scanner');
    const updatedReplyItem = getInboxItem(paths, replyItem.id);
    assert.equal(updatedReplyItem?.status, 'done', 'Item must be reconciled as done, never rolled back to open');
    assert.equal(updatedReplyItem?.resolution?.job_id, startedJobId);
  } finally {
    cleanup();
  }
});

test('Codex Review #5 Item 3: scanner deletes tracker only after store write succeeds and retries on 503', async () => {
  const { paths, cleanup } = createTempTestPaths();
  fs.mkdirSync(paths.jobsDir, { recursive: true });

  const jobId = 'job_scan_tracker_5';
  const metaPath = path.join(paths.jobsDir, `${jobId}.json`);
  const logPath = path.join(paths.jobsDir, `${jobId}.log`);

  try {
    // 1. Initial RUNNING job with log waiting for input
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        job_id: jobId,
        agent: 'claude',
        mode: 'task',
        role: 'backend',
        status: 'RUNNING',
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'Waiting for your input?\n', 'utf8');

    const { item } = addInboxItem(paths, {
      kind: 'needs_input',
      title: 'Waiting for answer',
      job_id: jobId,
      actions: ['reply', 'dismiss'],
    });

    // First scan while RUNNING establishes the tracker
    await runJobScanner(paths);

    // 2. Now job transitions to DONE
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        job_id: jobId,
        agent: 'claude',
        mode: 'task',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
      }),
      'utf8'
    );

    // Hold items.lock with live PID so scanner encounters 503
    const dataDir = paths.featureDataDir('inbox');
    fs.mkdirSync(dataDir, { recursive: true });
    const lockFile = path.join(dataDir, 'items.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', 'utf8');

    // Run scanner: withItemsLock will time out (503).
    // Scanner must catch 503 and NOT delete the runningTracker!
    await runJobScanner(paths);

    // Verify item is STILL open because lock timed out
    const openData = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8'));
    const pendingItem = openData.items.find((it: any) => it.id === item.id);
    assert.equal(pendingItem?.status, 'open', 'Item must remain open after 503');

    // Release lock
    fs.unlinkSync(lockFile);

    // Run scanner again: tracker was preserved, so store write succeeds!
    await runJobScanner(paths);

    const resolvedData = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8'));
    const doneItem = resolvedData.items.find((it: any) => it.id === item.id);
    assert.equal(doneItem?.status, 'done', 'Item must be resolved to done after lock released');
  } finally {
    cleanup();
  }
});
