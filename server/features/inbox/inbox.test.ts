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
} from './actions.ts';
import { buildMeaningfulDetail, runJobScanner } from './scanner.ts';
import { addInboxItem, getInboxItem, onInboxResolved, readInboxData } from './store.ts';

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

    // Create pre-existing claim lock file in data/inbox/claims/<id>.lock
    const claimsDir = path.join(paths.featureDataDir('inbox'), 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const claimFile = path.join(claimsDir, `${item.id}.lock`);
    fs.writeFileSync(claimFile, 'pid:9999\n', 'utf8');

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
