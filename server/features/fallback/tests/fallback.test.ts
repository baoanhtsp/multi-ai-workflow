import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { feature, scanFinishedJobs } from '../index.ts';
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
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const paths = resolveServerPaths({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
  });
  paths.jobsDir = jobsDir;

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
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { tmp, paths, ctx, startedJobs, cleanup };
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
  const { paths, ctx, cleanup } = createTempEnv();

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
      project_path: paths.projectsRoot,
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
      project_path: paths.projectsRoot,
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
