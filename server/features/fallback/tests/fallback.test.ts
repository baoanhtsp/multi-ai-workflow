import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  feature,
  pruneOldClaims,
  scanFinishedJobs,
  tryClaimJob,
  withRecoveryLock,
} from '../index.ts';
import {
  pickFallback,
  replaceAgent,
  writeJsonAtomic,
  type FallbackAgentInfo,
} from '../../policy/lib/s4-core.ts';

function createTempEnv() {
  const tmp = path.win32.join(os.tmpdir(), `maw_test_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const mawHome = path.win32.join(tmp, '.maw');
  const userProfile = path.win32.join(tmp, 'user');
  const jobsDir = path.win32.join(tmp, 'maw_jobs');
  const tempDir = path.win32.join(tmp, 'temp');
  const projectDir = path.win32.join(tmp, 'project');
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const oldTemp = process.env.TEMP;
  const oldTmp = process.env.TMP;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  const paths = resolveServerPaths({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
    projectsRoot: tmp,
  });
  paths.jobsDir = jobsDir;
  paths.tempDir = tempDir;
  paths.projectsRoot = tmp;

  const registry = loadAgentRegistry(paths);
  const startedJobs: Array<Record<string, unknown>> = [];
  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => {
      if (!fs.existsSync(jobsDir)) return [];
      const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json'));
      return files.map((f) => JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')));
    },
    startJob: async (body) => {
      startedJobs.push(body);
      return { job_id: `job_rerun_${startedJobs.length}` };
    },
  };

  const cleanup = () => {
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { tmp, projectDir, paths, ctx, startedJobs, cleanup };
}

test('pickFallback: checks skip rules (self, disabled, cooldown, cap, capability)', () => {
  const agents: Record<string, FallbackAgentInfo> = {
    claude: {
      id: 'claude',
      label: 'Claude Code',
      enabled: true,
      installed: true,
      capabilities: { write: true, review: true, new_session: true },
    },
    codex: {
      id: 'codex',
      label: 'OpenAI Codex',
      enabled: true,
      installed: true,
      capabilities: { write: true, review: true },
    },
    gemini: {
      id: 'gemini',
      label: 'Gemini CLI',
      enabled: true,
      installed: false, // not installed!
      capabilities: { write: true, review: true },
    },
    cursor: {
      id: 'cursor',
      label: 'Cursor Agent',
      enabled: false, // disabled!
      installed: true,
      capabilities: { write: true },
    },
    readonly_bot: {
      id: 'readonly_bot',
      label: 'Read Only Bot',
      enabled: true,
      installed: true,
      capabilities: { write: false, review: true }, // no write capability!
    },
  };

  const now = new Date('2026-10-25T12:00:00.000Z');

  // 1. Skip self
  const res1 = pickFallback({
    role: 'backend',
    blockedAgent: 'claude',
    fallbacks: ['claude', 'codex'],
    agents,
    cooldowns: {},
    now,
  });
  assert.equal(res1?.agent, 'codex');
  assert.equal(res1?.skipped[0]?.agent, 'claude');
  assert.equal(res1?.skipped[0]?.why, 'is blocked agent');

  // 2. Skip uninstalled and disabled
  const res2 = pickFallback({
    role: 'backend',
    blockedAgent: 'antigravity',
    fallbacks: ['gemini', 'cursor', 'codex'],
    agents,
    cooldowns: {},
    now,
  });
  assert.equal(res2?.agent, 'codex');
  assert.ok(res2?.skipped.some((s) => s.agent === 'gemini' && s.why === 'not installed'));
  assert.ok(res2?.skipped.some((s) => s.agent === 'cursor' && s.why === 'disabled or unknown'));

  // 3. Skip cooldown in future
  const res3 = pickFallback({
    role: 'backend',
    blockedAgent: 'antigravity',
    fallbacks: ['codex', 'claude'],
    agents,
    cooldowns: {
      codex: { until: '2026-10-25T13:00:00.000Z' }, // 1 hr in future
    },
    now,
  });
  assert.equal(res3?.agent, 'claude');
  assert.ok(res3?.skipped.some((s) => s.agent === 'codex' && s.why.includes('in cooldown')));

  // 4. Skip agent_day cap exceeded
  const res4 = pickFallback({
    role: 'backend',
    blockedAgent: 'antigravity',
    fallbacks: ['codex', 'claude'],
    agents,
    cooldowns: {},
    now,
    agentDaySpentUsd: { codex: 5.50, claude: 1.00 },
    agentDayCapBlockUsd: 5.00,
  });
  assert.equal(res4?.agent, 'claude');
  assert.ok(res4?.skipped.some((s) => s.agent === 'codex' && s.why.includes('budget exceeded')));

  // 5. Capability check: write role requires write
  const res5 = pickFallback({
    role: 'backend',
    blockedAgent: 'antigravity',
    fallbacks: ['readonly_bot', 'codex'],
    agents,
    cooldowns: {},
    now,
  });
  assert.equal(res5?.agent, 'codex');
  assert.ok(res5?.skipped.some((s) => s.agent === 'readonly_bot' && s.why.includes('missing capability: write')));

  // Reviewer role accepts readonly_bot
  const res6 = pickFallback({
    role: 'reviewer',
    blockedAgent: 'antigravity',
    fallbacks: ['readonly_bot'],
    agents,
    cooldowns: {},
    now,
  });
  assert.equal(res6?.agent, 'readonly_bot');
});

test('replaceAgent: replaces agent across task, team, auto-gate, council modes', () => {
  const targetInfo: FallbackAgentInfo = {
    id: 'codex',
    capabilities: { write: true, review: true, new_session: false }, // no new_session
  };

  // 1. Task mode
  const taskBody = {
    mode: 'task',
    agent: 'claude',
    role: 'frontend',
    model: 'sonnet',
    effort: 'high',
    new_session: true,
  };
  const replacedTask = replaceAgent(taskBody, 'claude', 'codex', targetInfo);
  assert.equal(replacedTask.agent, 'codex');
  assert.equal(replacedTask.model, undefined, 'model should be dropped on agent change');
  assert.equal(replacedTask.effort, undefined, 'effort should be dropped on agent change');
  assert.equal(replacedTask.new_session, undefined, 'new_session dropped if target lacks it');

  // 2. Team mode
  const teamBody = {
    mode: 'team',
    role: 'backend',
    team: { backend: 'claude', frontend: 'codex', reviewer: 'claude' },
  };
  const replacedTeam = replaceAgent(teamBody, 'claude', 'gemini');
  assert.deepEqual(replacedTeam.team, {
    backend: 'gemini',
    frontend: 'codex',
    reviewer: 'gemini',
  });

  // 3. Auto-gate mode
  const autoGateBody = {
    mode: 'auto-gate',
    implementer: 'claude',
    reviewers: ['codex', 'claude'],
  };
  const replacedAutoGate = replaceAgent(autoGateBody, 'claude', 'gemini');
  assert.equal(replacedAutoGate.implementer, 'gemini');
  assert.deepEqual(replacedAutoGate.reviewers, ['codex', 'gemini']);

  // 4. Council mode (duplicates removed)
  const councilBody = {
    mode: 'council',
    reviewers: ['claude', 'gemini'],
  };
  // Replacing claude with gemini should not leave duplicate gemini
  const replacedCouncil = replaceAgent(councilBody, 'claude', 'gemini');
  assert.deepEqual(replacedCouncil.reviewers, ['gemini']);
});

test('recovery decisions table: transient backoff, usage_limit wait, max_attempts gave_up, and ignore cancelled', async () => {
  const { paths, projectDir, ctx, cleanup } = createTempEnv();

  try {
    const fallbackDir = paths.featureDataDir('fallback');

    // Configure fallback routing
    const routingCfg = {
      version: 1,
      roles: {
        backend: { fallbacks: ['codex', 'gemini'], auto_fallback: true },
        frontend: { fallbacks: ['claude'], auto_fallback: false },
      },
      recovery: {
        enabled: true,
        backoff_s: [30, 60],
        max_attempts: 2,
        wait_for_reset: true,
        reset_grace_s: 10,
        max_wait_s: 3600,
        prefer_fallback_on_limit: false,
      },
    };
    writeJsonAtomic(path.win32.join(fallbackDir, 'routing.json'), routingCfg);

    // 1. Job 1: Transient 429 error -> created recovery item with backoff 30s
    const job1Meta = {
      job_id: 'job_transient_1',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'task',
      project_path: projectDir,
    };
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_transient_1.json'), JSON.stringify(job1Meta), 'utf8');
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_transient_1.log'), 'HTTP 429 Too Many Requests\n', 'utf8');

    // 2. Job 2: CANCELLED job -> should be completely ignored
    const job2Meta = {
      job_id: 'job_cancelled_2',
      status: 'CANCELLED',
      exit_code: null,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
    };
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_cancelled_2.json'), JSON.stringify(job2Meta), 'utf8');

    // Run scanner
    await scanFinishedJobs(ctx);

    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    // Should have 1 recovery item for job_transient_1, and none for job_cancelled_2
    assert.equal(recData.items.length, 1);
    const item1 = recData.items[0];
    assert.equal(item1.source_job_id, 'job_transient_1');
    assert.equal(item1.kind, 'transient');
    assert.equal(item1.status, 'waiting');
    assert.equal(item1.attempt, 1);
    assert.ok(item1.next_at !== null);

    // 3. Second transient failure on the same chain reaches max_attempts (2) -> status 'gave_up'
    const job3Meta = {
      job_id: 'job_transient_retry',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'task',
      project_path: projectDir,
    };
    // Mark it as rerun of job1
    item1.new_job_id = 'job_transient_retry';
    writeJsonAtomic(recFile, recData);

    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_transient_retry.json'), JSON.stringify(job3Meta), 'utf8');
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_transient_retry.log'), 'HTTP 429 Too Many Requests\n', 'utf8');

    await scanFinishedJobs(ctx);

    const recData2 = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const item3 = recData2.items.find((it: any) => it.source_job_id === 'job_transient_retry');
    assert.ok(item3 !== undefined);
    assert.equal(item3.status, 'gave_up', 'should give up when attempt >= max_attempts');
  } finally {
    cleanup();
  }
});

test('regression: foreign project job is skipped silently by scanFinishedJobs', async () => {
  const { paths, ctx, cleanup } = createTempEnv();
  try {
    const fallbackDir = paths.featureDataDir('fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });

    // Job with foreign project path outside projectsRoot
    const foreignJobMeta = {
      job_id: 'job_foreign_1',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'task',
      project_path: 'C:\\some_foreign_path_outside_root',
    };
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_foreign_1.json'), JSON.stringify(foreignJobMeta), 'utf8');
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_foreign_1.log'), 'Error: crashed\n', 'utf8');

    await scanFinishedJobs(ctx);

    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    // Must be marked processed silently
    assert.ok(recData.processed_jobs.includes('job_foreign_1'), 'job should be marked processed');
    // Must NOT have created any recovery item
    assert.equal(recData.items.length, 0, 'no recovery items should be created for foreign project');
  } finally {
    cleanup();
  }
});

test('regression: cross-process exclusive claim prevents duplicate recovery items and prunes old claims', async () => {
  const { paths, projectDir, ctx, cleanup } = createTempEnv();
  try {
    const fallbackDir = paths.featureDataDir('fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });

    // Test tryClaimJob directly
    const firstClaim = tryClaimJob(paths.tempDir, 'claim_test_1');
    assert.equal(firstClaim, true, 'first claim should succeed');
    const secondClaim = tryClaimJob(paths.tempDir, 'claim_test_1');
    assert.equal(secondClaim, false, 'second claim should fail with EEXIST');

    // Simulate another process claiming job_claimed_before
    tryClaimJob(paths.tempDir, 'job_claimed_before');

    const claimedJobMeta = {
      job_id: 'job_claimed_before',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'task',
      project_path: projectDir,
    };
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_claimed_before.json'), JSON.stringify(claimedJobMeta), 'utf8');
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_claimed_before.log'), 'HTTP 429 Too Many Requests\n', 'utf8');

    await scanFinishedJobs(ctx);

    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    // Must be marked processed but no item added
    assert.ok(recData.processed_jobs.includes('job_claimed_before'));
    assert.equal(recData.items.length, 0, 'claimed job must not create recovery item');

    // Test pruneOldClaims
    const claimsDir = path.win32.join(paths.tempDir, 'maw_s4_claims');
    const oldClaimPath = path.win32.join(claimsDir, 'old_claim_file');
    fs.writeFileSync(oldClaimPath, 'old', 'utf8');
    const oldTime = (Date.now() - 25 * 3600 * 1000) / 1000;
    fs.utimesSync(oldClaimPath, oldTime, oldTime);

    // Call prune with nowMs advancing 2 hours
    pruneOldClaims(paths.tempDir, Date.now() + 7200 * 1000);
    assert.equal(fs.existsSync(oldClaimPath), false, 'claims older than 24h should be pruned');
  } finally {
    cleanup();
  }
});

test('regression Item 1: withRecoveryLock mutex serializes concurrent async calls strictly', async () => {
  const events: string[] = [];

  const task1 = withRecoveryLock(async () => {
    events.push('start1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push('end1');
    return 1;
  });

  const task2 = withRecoveryLock(async () => {
    events.push('start2');
    events.push('end2');
    return 2;
  });

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1, 1);
  assert.equal(res2, 2);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2'], 'task2 must not start before task1 finishes');
});

test('regression Item 2 & Item 13: agent_day fallback triggering and usage_limit without reset time', async () => {
  const { paths, ctx, projectDir, cleanup } = createTempEnv();
  const fallbackDir = paths.featureDataDir('fallback');
  try {
    // 1. pickFallback skips agent that reached agentDayCapBlockUsd
    const candidateAgents: Record<string, FallbackAgentInfo> = {
      codex: {
        id: 'codex',
        label: 'Codex',
        enabled: true,
        installed: true,
        capabilities: { write: true, review: true },
      },
      gemini: {
        id: 'gemini',
        label: 'Gemini',
        enabled: true,
        installed: true,
        capabilities: { write: true, review: true },
      },
    };
    const pickResAtCap = pickFallback({
      role: 'backend',
      blockedAgent: 'antigravity',
      fallbacks: ['codex', 'gemini'],
      agents: candidateAgents,
      cooldowns: {},
      agentDaySpentUsd: { codex: 5.5, gemini: 1.0 },
      agentDayCapBlockUsd: 5.0, // codex is at cap ($5.50 >= $5.00)
    });
    assert.ok(pickResAtCap);
    assert.equal(pickResAtCap.agent, 'gemini', 'must skip codex because it reached the agent_day budget cap');

    // 2. scanFinishedJobs handles [S4:budget agent=X fallback=Y] as ready fallback
    const budgetBlockedJob = {
      job_id: 'job_budget_fb',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'antigravity',
      role: 'backend',
      mode: 'task',
      project_path: projectDir,
    };
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_budget_fb.json'),
      JSON.stringify(budgetBlockedJob),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_budget_fb.log'),
      'Budget agent_day exceeded [S4:budget agent=antigravity fallback=gemini]\n',
      'utf8'
    );

    // 3. scanFinishedJobs handles usage limit without reset_at as transient with longest backoff
    const usageLimitNoResetJob = {
      job_id: 'job_usage_no_reset',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'task',
      project_path: projectDir,
    };
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_usage_no_reset.json'),
      JSON.stringify(usageLimitNoResetJob),
      'utf8'
    );
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_usage_no_reset.log'),
      'RESOURCE_EXHAUSTED: you have exceeded your current quota\n',
      'utf8'
    );

    await scanFinishedJobs(ctx);

    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    // Check budget fb item
    const fbItem = recData.items.find((it: any) => it.source_job_id === 'job_budget_fb');
    assert.ok(fbItem, 'budget blocked job with fallback must create recovery item');
    assert.equal(fbItem.status, 'suggested', 'auto_fallback is false by default so status must be suggested');
    assert.equal(fbItem.fallback_agent, 'gemini');

    // Check usage_limit without reset_at
    const usageItem = recData.items.find((it: any) => it.source_job_id === 'job_usage_no_reset');
    assert.ok(usageItem, 'usage limit without reset must create recovery item');
    assert.equal(usageItem.status, 'waiting', 'must be waiting, not suggested');
    assert.equal(usageItem.kind, 'usage_limit');
    assert.ok(usageItem.reason.includes('Usage limit without reset time'));
    assert.ok(usageItem.next_at, 'next_at must be populated with longest backoff step');
  } finally {
    cleanup();
  }
});

test('regression Item 3: multi-agent mode without tag marks failedAgent unknown and retries same body without replaceAgent', async () => {
  const { paths, ctx, projectDir, cleanup } = createTempEnv();
  const fallbackDir = paths.featureDataDir('fallback');
  try {
    const multiAgentJob = {
      job_id: 'job_team_err',
      status: 'FAILED',
      exit_code: 1,
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
      agent: 'claude',
      role: 'backend',
      mode: 'team', // multi-agent mode
      project_path: projectDir,
    };
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_team_err.json'),
      JSON.stringify(multiAgentJob),
      'utf8'
    );
    // Transient error without [S4:...] tag
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_team_err.log'),
      'HTTP 429 Too Many Requests\n',
      'utf8'
    );

    await scanFinishedJobs(ctx);

    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));

    const item = recData.items.find((it: any) => it.source_job_id === 'job_team_err');
    assert.ok(item);
    assert.equal(item.status, 'waiting');
    assert.equal(item.fallback_agent, null, 'multi-agent without tag must have fallback_agent null');

    // Cooldowns must NOT have unknown or claude set
    const cdFile = path.win32.join(fallbackDir, 'cooldowns.json');
    if (fs.existsSync(cdFile)) {
      const cds = JSON.parse(fs.readFileSync(cdFile, 'utf8'));
      assert.equal(cds.unknown, undefined);
      assert.equal(cds.claude, undefined);
    }
  } finally {
    cleanup();
  }
});
