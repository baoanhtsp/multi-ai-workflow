import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { approvePolicyApproval, feature as policyFeature } from '../index.ts';
import {
  handleInboxResolved,
  loadInbox,
  resetInboxBridgeForTest,
  setInboxModulePathForTest,
  syncAttentionToInbox,
} from '../lib/inbox-bridge.ts';

function createTempEnv() {
  const tmp = path.win32.join(
    os.tmpdir(),
    `maw_test_inbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(tmp, { recursive: true });
  const mawHome = path.win32.join(tmp, '.maw');
  const userProfile = path.win32.join(tmp, 'user');
  const tempDir = path.win32.join(tmp, 'temp');
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const oldTemp = process.env.TEMP;
  const oldTmp = process.env.TMP;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  const paths = resolveServerPaths({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
  });
  const testJobsDir = path.win32.join(tmp, 'maw_jobs');
  paths.jobsDir = testJobsDir;
  paths.tempDir = tempDir;
  fs.mkdirSync(testJobsDir, { recursive: true });

  const registry = loadAgentRegistry(paths);
  const startedJobs: any[] = [];
  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => {
      if (!fs.existsSync(testJobsDir)) return [];
      const files = fs.readdirSync(testJobsDir).filter((f) => f.endsWith('.json'));
      return files.map((f) => JSON.parse(fs.readFileSync(path.win32.join(testJobsDir, f), 'utf8')));
    },
    startJob: async (body) => {
      const jid = `job_rerun_${Date.now()}`;
      startedJobs.push({ job_id: jid, body });
      return { job_id: jid };
    },
  };

  const cleanup = () => {
    resetInboxBridgeForTest();
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { tmp, paths, ctx, startedJobs, cleanup };
}

test('inbox bridge: feature-detects missing inbox module without throwing', async () => {
  const { ctx, cleanup } = createTempEnv();
  try {
    resetInboxBridgeForTest();

    // With no custom path and no server/features/inbox/store.ts, loadInbox should return null
    const mod = await loadInbox(ctx);
    assert.equal(mod, null);

    // Policy status reports inbox_bridge: false
    const status = await policyFeature.status!(ctx);
    assert.equal((status as any).inbox_bridge, false);

    // syncAttentionToInbox runs smoothly without throwing
    await syncAttentionToInbox(ctx, true);
  } finally {
    cleanup();
  }
});

test('inbox bridge: pushes mapped attention items, respects deduplication, and handles onInboxResolved', async () => {
  const { tmp, paths, ctx, startedJobs, cleanup } = createTempEnv();
  try {
    resetInboxBridgeForTest();

    // 1. Create a mock S3 inbox module mirroring real S3 store signatures (paths first; listener gets InboxItem)
    const mockInboxFile = path.win32.join(tmp, 'mock-inbox-store.ts');
    const mockInboxCode = `
export const pushedCalls = [];
export const updateStatusCalls = [];
let resolvedListener = null;

export function addInboxItem(paths, input, options) {
  pushedCalls.push({ paths, input, options });
  const item = {
    id: 'i' + Math.random().toString(36).slice(2, 8),
    ...input,
    status: 'open',
    resolution: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { item, created: true };
}

export function updateInboxItemStatus(paths, id, status, resolution) {
  updateStatusCalls.push({ paths, id, status, resolution });
  return { id, status, resolution };
}

export function onInboxResolved(listener) {
  resolvedListener = listener;
  return () => { resolvedListener = null; };
}

export async function triggerResolve(item) {
  if (resolvedListener) {
    return await resolvedListener(item);
  }
  return false;
}
`;
    fs.writeFileSync(mockInboxFile, mockInboxCode, 'utf8');
    setInboxModulePathForTest(mockInboxFile);

    // 2. Set up fixtures for Attention Items across sources:
    // (a) Policy approval
    const policyDir = paths.featureDataDir('policy');
    fs.mkdirSync(policyDir, { recursive: true });
    const approval = {
      id: 'apr_test_1',
      job_id: 'job_src_10',
      role: 'backend',
      agent: 'claude',
      project: paths.repoRoot,
      command: 'rm -rf /tmp/test',
      prompt_sha256: 'abc123',
      created_at: new Date().toISOString(),
      status: 'pending',
    };
    fs.writeFileSync(
      path.win32.join(policyDir, 'approvals.json'),
      JSON.stringify([approval]),
      'utf8'
    );

    // Source job for rerun
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_src_10.json'),
      JSON.stringify({
        job_id: 'job_src_10',
        command: 'run.ps1',
        agent: 'claude',
        role: 'backend',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_src_10.prompt.txt'),
      'Test rerun prompt',
      'utf8'
    );

    // (b) Fallback recovery item (suggested)
    const fallbackDir = paths.featureDataDir('fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });
    const recoveryItem = {
      id: 'rec_test_suggest',
      root_job_id: 'job_src_20',
      source_job_id: 'job_src_20',
      kind: 'fallback',
      agent: 'claude',
      role: 'backend',
      fallback_agent: 'codex',
      attempt: 1,
      status: 'suggested',
      next_at: null,
      reason: 'Agent claude failed; fallback suggested',
      created_at: new Date().toISOString(),
      new_job_id: null,
      error: null,
    };
    fs.writeFileSync(
      path.win32.join(fallbackDir, 'recovery.json'),
      JSON.stringify({ processed_jobs: [], items: [recoveryItem] }),
      'utf8'
    );

    // Source job for recovery apply
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_src_20.json'),
      JSON.stringify({
        job_id: 'job_src_20',
        command: 'run.ps1',
        agent: 'claude',
        role: 'backend',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_src_20.prompt.txt'),
      'Test recovery prompt',
      'utf8'
    );

    // (c) Budget block in blocks.jsonl
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const blockEntry = {
      ts: new Date().toISOString(),
      kind: 'day_block',
      scope: 'day',
      agent: 'claude',
      reason: 'Day cap exceeded $20.00',
    };
    fs.writeFileSync(
      path.win32.join(budgetDir, 'blocks.jsonl'),
      JSON.stringify(blockEntry) + '\n',
      'utf8'
    );

    // 3. Test loadInbox and status
    const mod = await loadInbox(ctx);
    assert.ok(mod);

    const status = await policyFeature.status!(ctx);
    assert.equal((status as any).inbox_bridge, true);

    // 4. Run syncAttentionToInbox (forced)
    await syncAttentionToInbox(ctx, true);

    const mockMod = await import(`file:///${mockInboxFile.replace(/\\/g, '/')}`);
    assert.ok(mockMod.pushedCalls.length >= 3, 'Should have pushed at least 3 items');

    // Verify first argument is paths and options has onlyIfAbsent
    assert.equal(mockMod.pushedCalls[0].paths, ctx.paths);
    assert.deepEqual(mockMod.pushedCalls[0].options, { onlyIfAbsent: true });

    // Verify mapping
    const pushedApr = mockMod.pushedCalls.find((c: any) => c.input.kind === 'approval');
    assert.ok(pushedApr, 'Approval item should be mapped to kind approval');
    assert.deepEqual(pushedApr.input.actions, ['approve', 'reject']);
    assert.equal(pushedApr.input.ref?.approval_id, approval.id);
    assert.equal(pushedApr.input.ref?.s4, true);

    const pushedFb = mockMod.pushedCalls.find((c: any) => c.input.kind === 'rate_limited');
    assert.ok(pushedFb, 'Suggested fallback should be mapped to rate_limited');
    assert.deepEqual(pushedFb.input.actions, ['retry', 'dismiss']);
    assert.equal(pushedFb.input.ref?.recovery_id, recoveryItem.id);
    assert.equal(pushedFb.input.ref?.s4, true);

    const pushedBudget = mockMod.pushedCalls.find((c: any) => c.input.kind === 'budget_block');
    assert.ok(pushedBudget, 'Budget block should be mapped to budget_block');
    assert.deepEqual(pushedBudget.input.actions, ['open', 'dismiss']);
    assert.equal(pushedBudget.input.ref?.s4, true);

    // 5. Test Deduplication
    const countBefore = mockMod.pushedCalls.length;
    await syncAttentionToInbox(ctx, true);
    assert.equal(
      mockMod.pushedCalls.length,
      countBefore,
      'Second sync must deduplicate and not re-push existing items'
    );

    // Verify inbox-pushed.json
    const pushedFile = path.win32.join(policyDir, 'inbox-pushed.json');
    assert.ok(fs.existsSync(pushedFile));

    // 6. Test onInboxResolved actions with real InboxItem shape:
    // (a) 'approve' action
    const approveItem = {
      id: 'i111111',
      kind: 'approval',
      source: 's4',
      ref: pushedApr.input.ref,
      status: 'approved',
      resolution: {
        action: 'approve',
        by: 'ui',
        at: new Date().toISOString(),
      },
    };
    const approveResult = await mockMod.triggerResolve(approveItem);
    assert.equal(approveResult, true);

    const updatedApprovals = JSON.parse(
      fs.readFileSync(path.win32.join(policyDir, 'approvals.json'), 'utf8')
    );
    assert.equal(updatedApprovals[0].status, 'approved');
    assert.ok(startedJobs.length > 0, 'Rerun job should have started');

    // (b) 'retry' action for recovery
    const retryItem = {
      id: 'i222222',
      kind: 'rate_limited',
      source: 's4',
      ref: pushedFb.input.ref,
      status: 'open',
      resolution: {
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
      },
    };
    const retryResult = await mockMod.triggerResolve(retryItem);
    assert.equal(retryResult, true);

    const updatedRecovery = JSON.parse(
      fs.readFileSync(path.win32.join(fallbackDir, 'recovery.json'), 'utf8')
    );
    const recIt = updatedRecovery.items.find((i: any) => i.id === recoveryItem.id);
    assert.equal(recIt.status, 'started');

    // (c) 'dismiss' action
    const dismissId = pushedBudget.input.ref.attention_id;
    const dismissItem = {
      id: 'i333333',
      kind: 'budget_block',
      source: 's4',
      ref: pushedBudget.input.ref,
      status: 'dismissed',
      resolution: {
        action: 'dismiss',
        by: 'ui',
        at: new Date().toISOString(),
      },
    };
    const dismissResult = await mockMod.triggerResolve(dismissItem);
    assert.equal(dismissResult, true);

    const dismissed = JSON.parse(
      fs.readFileSync(path.win32.join(policyDir, 'attention-dismissed.json'), 'utf8')
    );
    assert.ok(dismissed.includes(dismissId));
  } finally {
    cleanup();
  }
});

test('inbox bridge: integration with real S3 store.ts (if present)', async () => {
  // After the streams are merged S3's store lives in this repo; before that, in the S3 worktree.
  const candidates = [
    path.resolve(import.meta.dirname, '..', '..', 'inbox', 'store.ts'),
    'C:\\laragon\\www\\multi-ai-workflow\\.claude\\worktrees\\v5-s3-attention-3f6372\\server\\features\\inbox\\store.ts',
  ];
  const realStorePath = candidates.find((p) => fs.existsSync(p)) ?? '';
  if (!realStorePath) {
    // S3 store not available in this environment; skip gracefully
    return;
  }

  const { paths, ctx, cleanup } = createTempEnv();
  try {
    resetInboxBridgeForTest();
    setInboxModulePathForTest(realStorePath);

    // 1. Load real S3 store module
    const inbox = await loadInbox(ctx);
    assert.ok(inbox, 'Real S3 store should load successfully');

    // 2. Set up a budget block in budget/blocks.jsonl
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const blockEntry = {
      ts: new Date().toISOString(),
      kind: 'day_block',
      scope: 'day',
      agent: 'claude',
      reason: 'Daily budget cap reached $25.00',
    };
    fs.writeFileSync(
      path.win32.join(budgetDir, 'blocks.jsonl'),
      JSON.stringify(blockEntry) + '\n',
      'utf8'
    );

    // 3. Sync attention to real S3 inbox
    await syncAttentionToInbox(ctx, true);

    // 4. Verify item was created in real S3 store data
    const realStore = (await import(`file:///${realStorePath.replace(/\\/g, '/')}`)) as any;
    const inboxData = realStore.readInboxData(paths);
    assert.ok(inboxData && inboxData.items.length > 0, 'Real S3 store should have items');

    const createdItem = inboxData.items.find(
      (it: any) => it.source === 's4' && it.kind === 'budget_block'
    );
    assert.ok(createdItem, 'Created budget_block item should exist in real S3 store');
    assert.equal(createdItem.ref?.s4, true);
    const attentionId = createdItem.ref?.attention_id;
    assert.ok(attentionId, 'Item should carry attention_id in ref');

    // 5. Resolve the item using S3 store functions
    if (typeof realStore.updateInboxItemStatus === 'function' && typeof realStore.fireInboxResolved === 'function') {
      const resolved = realStore.updateInboxItemStatus(paths, createdItem.id, 'dismissed', {
        action: 'dismiss',
        by: 'ui',
        at: new Date().toISOString(),
      });
      assert.ok(resolved);

      const handled = await realStore.fireInboxResolved(resolved);
      assert.equal(handled, true, 'S4 bridge should return true for handled resolution');

      // Verify that S4 recorded the dismissal
      const policyDir = paths.featureDataDir('policy');
      const dismissedFile = path.win32.join(policyDir, 'attention-dismissed.json');
      assert.ok(fs.existsSync(dismissedFile));
      const dismissed = JSON.parse(fs.readFileSync(dismissedFile, 'utf8'));
      assert.ok(dismissed.includes(attentionId), 'Attention item should be marked dismissed in S4');
    }
  } finally {
    cleanup();
  }
});

test('regression N1: recovery item pushes retry body when rebuildable, but [open, dismiss] when un-rebuildable; listener does not re-spawn', async () => {
  const { tmp, paths, ctx, startedJobs, cleanup } = createTempEnv();
  try {
    resetInboxBridgeForTest();

    const mockInboxFile = path.win32.join(tmp, 'mock-inbox-n1.ts');
    const mockInboxCode = `
export const pushedCalls = [];
let resolvedListener = null;

export function addInboxItem(paths, input, options) {
  pushedCalls.push({ paths, input, options });
  const item = {
    id: 'i_' + Math.random().toString(36).slice(2, 8),
    ...input,
    status: 'open',
    resolution: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { item, created: true };
}

export function onInboxResolved(listener) {
  resolvedListener = listener;
  return () => { resolvedListener = null; };
}

export async function triggerResolve(item) {
  if (resolvedListener) return await resolvedListener(item);
  return false;
}
`;
    fs.writeFileSync(mockInboxFile, mockInboxCode, 'utf8');
    setInboxModulePathForTest(mockInboxFile);

    const fallbackDir = paths.featureDataDir('fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });

    // Item 1: rebuildable (meta and prompt exist)
    const rec1 = {
      id: 'rec_rebuildable',
      root_job_id: 'job_reb',
      source_job_id: 'job_reb',
      kind: 'fallback',
      agent: 'claude',
      role: 'backend',
      fallback_agent: 'codex',
      attempt: 1,
      status: 'suggested',
      next_at: null,
      reason: 'Agent failed',
      created_at: new Date().toISOString(),
      new_job_id: null,
      error: null,
    };

    // Item 2: NOT rebuildable (no meta/prompt file)
    const rec2 = {
      id: 'rec_unrebuildable',
      root_job_id: 'job_no_prompt',
      source_job_id: 'job_no_prompt',
      kind: 'fallback',
      agent: 'claude',
      role: 'backend',
      fallback_agent: 'codex',
      attempt: 1,
      status: 'suggested',
      next_at: null,
      reason: 'Agent failed',
      created_at: new Date().toISOString(),
      new_job_id: null,
      error: null,
    };

    fs.writeFileSync(
      path.win32.join(fallbackDir, 'recovery.json'),
      JSON.stringify({ processed_jobs: [], items: [rec1, rec2] }),
      'utf8'
    );

    // Write source job files for rec1 ONLY
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_reb.json'),
      JSON.stringify({ job_id: 'job_reb', command: 'run.ps1', agent: 'claude', role: 'backend' }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_reb.prompt.txt'),
      'Do something',
      'utf8'
    );

    await syncAttentionToInbox(ctx, true);

    const mockMod = await import(`file:///${mockInboxFile.replace(/\\/g, '/')}`);
    const call1 = mockMod.pushedCalls.find((c: any) => c.input.ref?.recovery_id === 'rec_rebuildable');
    assert.ok(call1);
    assert.deepEqual(call1.input.actions, ['retry', 'dismiss']);
    assert.ok(call1.input.retry, 'Must have retry body');
    assert.equal(call1.input.retry.agent, 'codex'); // replaced with fallback agent

    const call2 = mockMod.pushedCalls.find((c: any) => c.input.ref?.recovery_id === 'rec_unrebuildable');
    assert.ok(call2);
    assert.deepEqual(call2.input.actions, ['open', 'dismiss']);
    assert.equal(call2.input.retry, undefined, 'Must not have retry body when un-rebuildable');

    // Test listener: S3 itself spawned job_from_s3_123, calls listener with resolution.action='retry'
    const jobsBefore = startedJobs.length;
    const resItem = {
      id: 'inbox_item_1',
      kind: 'rate_limited',
      source: 's4',
      ref: call1.input.ref,
      status: 'open',
      resolution: {
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
        job_id: 'job_from_s3_123',
      },
    };
    const handled = await mockMod.triggerResolve(resItem);
    assert.equal(handled, true);
    assert.equal(startedJobs.length, jobsBefore, 'Listener must NOT spawn another job');

    const updatedRecovery = JSON.parse(
      fs.readFileSync(path.win32.join(fallbackDir, 'recovery.json'), 'utf8')
    );
    const updated1 = updatedRecovery.items.find((i: any) => i.id === 'rec_rebuildable');
    assert.equal(updated1.status, 'started');
    assert.equal(updated1.new_job_id, 'job_from_s3_123');
  } finally {
    cleanup();
  }
});

test('regression N2: approval fails closed and reverts to pending if startJob throws', async () => {
  const { paths, tmp, cleanup } = createTempEnv();
  try {
    const policyDir = paths.featureDataDir('policy');
    fs.mkdirSync(policyDir, { recursive: true });

    const approval = {
      id: 'apr_failing_spawn',
      job_id: 'job_fail_src',
      role: 'backend',
      agent: 'claude',
      project: paths.repoRoot,
      command: 'dangerous_cmd',
      prompt_sha256: 'sha999',
      created_at: new Date().toISOString(),
      status: 'pending',
    };
    fs.writeFileSync(
      path.win32.join(policyDir, 'approvals.json'),
      JSON.stringify([approval]),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_fail_src.json'),
      JSON.stringify({ job_id: 'job_fail_src', command: 'run.ps1', agent: 'claude', role: 'backend' }),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_fail_src.prompt.txt'),
      'Rerun prompt',
      'utf8'
    );

    const failingCtx: MawFeatureContext = {
      paths,
      registry: loadAgentRegistry(paths),
      readJobs: async () => [
        { job_id: 'job_fail_src', command: 'run.ps1', agent: 'claude', role: 'backend' },
      ],
      startJob: async () => {
        throw new Error('EACCES: permission denied when starting process');
      },
    };

    const res = await approvePolicyApproval(failingCtx, 'apr_failing_spawn');
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes('permission denied'));

    // Approval MUST be reverted to 'pending', never left 'approved'
    const approvalsAfter = JSON.parse(
      fs.readFileSync(path.win32.join(policyDir, 'approvals.json'), 'utf8')
    );
    assert.equal(approvalsAfter[0].status, 'pending');

    // A failed recovery item must be recorded in recovery.json and mapped to recovery_failed attention item
    const fallbackDir = paths.featureDataDir('fallback');
    const recoveryFile = path.win32.join(fallbackDir, 'recovery.json');
    assert.ok(fs.existsSync(recoveryFile));
    const recoveryData = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    const failedItem = recoveryData.items.find((it: any) => it.status === 'failed');
    assert.ok(failedItem, 'Must record failed recovery item');
    assert.ok(failedItem.error?.includes('permission denied'));
  } finally {
    cleanup();
  }
});

test('regression N3: inbox reconciliation marks done in S3 and removes from inbox-pushed.json', async () => {
  const { paths, tmp, ctx, cleanup } = createTempEnv();
  try {
    resetInboxBridgeForTest();

    const mockInboxFile = path.win32.join(tmp, 'mock-inbox-n3.ts');
    const mockInboxCode = `
export const pushedCalls = [];
export const updateStatusCalls = [];

export function addInboxItem(paths, input, options) {
  pushedCalls.push({ paths, input, options });
  const item = {
    id: 's3_item_' + Math.random().toString(36).slice(2, 8),
    ...input,
    status: 'open',
    resolution: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { item, created: true };
}

export function updateInboxItemStatus(paths, id, status, resolution) {
  updateStatusCalls.push({ paths, id, status, resolution });
  return { id, status, resolution };
}

export function onInboxResolved() { return () => {}; }
`;
    fs.writeFileSync(mockInboxFile, mockInboxCode, 'utf8');
    setInboxModulePathForTest(mockInboxFile);

    // 1. Create a budget block attention item
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const blockEntry = {
      ts: new Date().toISOString(),
      kind: 'day_block',
      scope: 'day',
      agent: 'claude',
      reason: 'Budget cap exceeded',
    };
    const blocksFile = path.win32.join(budgetDir, 'blocks.jsonl');
    fs.writeFileSync(blocksFile, JSON.stringify(blockEntry) + '\n', 'utf8');

    // 2. Initial sync pushes the item to S3
    await syncAttentionToInbox(ctx, true);

    const mockMod = await import(`file:///${mockInboxFile.replace(/\\/g, '/')}`);
    assert.equal(mockMod.pushedCalls.length, 1);
    const s3Id = mockMod.pushedCalls[0].input.dedupe_key;

    const policyDir = paths.featureDataDir('policy');
    const pushedFile = path.win32.join(policyDir, 'inbox-pushed.json');
    let pushedData = JSON.parse(fs.readFileSync(pushedFile, 'utf8'));
    assert.ok(pushedData[s3Id], 'pushed map must contain attention item');

    // 3. Now remove the attention item (e.g. user dismissed or block expired)
    fs.writeFileSync(blocksFile, '', 'utf8');

    // 4. Next sync reconciles: calls updateInboxItemStatus with 'done' and cleans pushed map
    await syncAttentionToInbox(ctx, true);

    assert.equal(mockMod.updateStatusCalls.length, 1);
    assert.equal(mockMod.updateStatusCalls[0].status, 'done');
    assert.equal(mockMod.updateStatusCalls[0].resolution.action, 'done');

    pushedData = JSON.parse(fs.readFileSync(pushedFile, 'utf8'));
    assert.equal(pushedData[s3Id], undefined, 'item must be removed from inbox-pushed.json');
  } finally {
    cleanup();
  }
});
