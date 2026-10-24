import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { feature, parseReviewFromLog, syncLedger } from '../index.ts';
import {
  calculateAgentDaySpend,
  calculateDaySpend,
  calculateProjectSpend,
  calculateTeamRunSpend,
  createDefaultBudgetConfig,
  estimateNextCallCost,
  readAuditRows,
  validateBudgetConfig,
  type BudgetConfig,
  type S4AuditEntry,
} from '../../policy/lib/s4-core.ts';

function createTempEnv() {
  const tmp = path.win32.join(os.tmpdir(), `maw_test_budget_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
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

  const registry = loadAgentRegistry(paths);
  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => {
      if (!fs.existsSync(testJobsDir)) return [];
      const files = fs.readdirSync(testJobsDir).filter((f) => f.endsWith('.json'));
      return files.map((f) => JSON.parse(fs.readFileSync(path.join(testJobsDir, f), 'utf8')));
    },
    startJob: async () => ({ job_id: 'job_started_mock' }),
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

  return { tmp, paths, ctx, cleanup };
}

test('budget: spend calculations per scope and estimate_next_call', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');

  const rows: S4AuditEntry[] = [
    // Today, claude, in project A
    {
      Timestamp: '2026-10-25T08:00:00.000Z',
      Tool: 'claude',
      Agent: 'claude',
      Role: 'frontend',
      Model: 'sonnet',
      WorkDir: 'C:\\laragon\\www\\project-a',
      PromptChars: 1000,
      InputTokens: 250,
      OutputTokens: 500,
      CostUsd: 0.15,
      Score: '',
      Verdict: '',
      in_tokens: 250,
      out_tokens: 500,
      cost_usd: 0.15,
    },
    // Today, codex, in project A worktree
    {
      Timestamp: '2026-10-25T09:30:00.000Z',
      Tool: 'codex',
      Agent: 'codex',
      Role: 'backend',
      Model: 'gpt-6-sol',
      WorkDir: 'C:\\laragon\\www\\project-a\\.claude\\worktrees\\feat-1',
      PromptChars: 2000,
      InputTokens: 500,
      OutputTokens: 1000,
      CostUsd: 0.25,
      Score: '',
      Verdict: '',
      in_tokens: 500,
      out_tokens: 1000,
      cost_usd: 0.25,
    },
    // Yesterday, claude, in project A
    {
      Timestamp: '2026-10-24T15:00:00.000Z',
      Tool: 'claude',
      Agent: 'claude',
      Role: 'frontend',
      Model: 'sonnet',
      WorkDir: 'C:\\laragon\\www\\project-a',
      PromptChars: 1000,
      InputTokens: 250,
      OutputTokens: 500,
      CostUsd: 0.10,
      Score: '',
      Verdict: '',
      in_tokens: 250,
      out_tokens: 500,
      cost_usd: 0.10,
    },
  ];

  // 1. Day spend (today only)
  const daySpend = calculateDaySpend(rows, now);
  assert.equal(daySpend.calls, 2);
  assert.equal(daySpend.usd, 0.40);
  assert.equal(daySpend.tokens, 2250);

  // 2. Project spend (within month period: today + yesterday)
  const projSpend = calculateProjectSpend(rows, 'C:\\laragon\\www\\project-a', 'month', now);
  assert.equal(projSpend.calls, 3);
  assert.equal(projSpend.usd, 0.50);

  // 3. Agent day spend (today for claude)
  const claudeSpend = calculateAgentDaySpend(rows, 'claude', now);
  assert.equal(claudeSpend.calls, 1);
  assert.equal(claudeSpend.usd, 0.15);

  const codexSpend = calculateAgentDaySpend(rows, 'codex', now);
  assert.equal(codexSpend.calls, 1);
  assert.equal(codexSpend.usd, 0.25);

  // 4. Team run spend
  const ledgerMock = [
    { team_run_id: 'tr_123', cost_usd: 1.50, in_tokens: 1000, out_tokens: 2000 },
    { team_run_id: 'tr_123', cost_usd: 0.75, in_tokens: 500, out_tokens: 1000 },
    { team_run_id: 'other', cost_usd: 5.00, in_tokens: 5000, out_tokens: 10000 },
  ];
  const trSpend = calculateTeamRunSpend(ledgerMock, 'tr_123', 0.25);
  assert.equal(trSpend.usd, 2.50);
  assert.equal(trSpend.tokens, 4500);

  // 5. estimateNextCallCost
  const estClaude = estimateNextCallCost(rows, 'claude');
  // (0.15 + 0.10) / 2 = 0.125
  assert.equal(estClaude, 0.125);

  const estUnknown = estimateNextCallCost(rows, 'gemini');
  assert.equal(estUnknown, 0.02); // fallback
});

test('budget_save: validates thresholds, decimals, and rejects invalid inputs with 400', () => {
  // Valid config
  const valid = createDefaultBudgetConfig();
  const vRes = validateBudgetConfig(valid);
  assert.equal(vRes.errorField, undefined);

  // Negative threshold
  const invalidNeg = {
    ...valid,
    caps: { ...valid.caps, day: { usd: { warn: -1, block: 10 } } },
  };
  const negRes = validateBudgetConfig(invalidNeg);
  assert.equal(negRes.errorField, 'caps.day.usd.warn');

  // Warn > block
  const invalidWarn = {
    ...valid,
    caps: { ...valid.caps, day: { usd: { warn: 25, block: 20 } } },
  };
  const warnRes = validateBudgetConfig(invalidWarn);
  assert.equal(warnRes.errorField, 'caps.day.usd.warn');

  // More than 4 decimals
  const invalidDec = {
    ...valid,
    caps: { ...valid.caps, day: { usd: { warn: 1.12345, block: 20 } } },
  };
  const decRes = validateBudgetConfig(invalidDec);
  assert.equal(decRes.errorField, 'caps.day.usd.warn');

  // Invalid period in project
  const invalidPeriod = {
    ...valid,
    caps: { ...valid.caps, project: { usd: { warn: 0, block: 0 }, period: 'invalid' } },
  };
  const pRes = validateBudgetConfig(invalidPeriod);
  assert.equal(pRes.errorField, 'caps.project.period');
});

test('parseReviewFromLog: parses Council results, single reviewer scores, and rounds', () => {
  // Council result all approved with min score >= 8.5
  const councilOk = `
Some log output
=== COUNCIL_RESULT claude=APPROVED|9.0 codex=APPROVED|8.7 ===
[Round 2 / 3] Complete
`;
  const rev1 = parseReviewFromLog(councilOk);
  assert.equal(rev1.verdict, 'APPROVED');
  assert.equal(rev1.score, 8.7);
  assert.equal(rev1.rounds, 2);

  // Council result changes requested
  const councilFail = `
=== COUNCIL_RESULT claude=APPROVED|9.0 codex=CHANGES_REQUESTED|7.5 ===
[Round 1 / 3]
`;
  const rev2 = parseReviewFromLog(councilFail);
  assert.equal(rev2.verdict, 'CHANGES_REQUESTED');
  assert.equal(rev2.score, 7.5);
  assert.equal(rev2.rounds, 1);

  // Single reviewer format
  const singleLog = `
VERDICT: APPROVED
Score: 8.5/10
`;
  const rev3 = parseReviewFromLog(singleLog);
  assert.equal(rev3.verdict, 'APPROVED');
  assert.equal(rev3.score, 8.5);
});

test('syncLedger: is idempotent and computes job costs from audit rows', async () => {
  const { paths, ctx, cleanup } = createTempEnv();

  try {
    // Write fake audit file
    const auditFile = paths.auditFile;
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const auditRow = {
      Timestamp: new Date().toISOString(),
      Tool: 'claude',
      Agent: 'claude',
      Role: 'backend',
      Model: 'sonnet',
      WorkDir: paths.projectsRoot,
      PromptChars: 500,
      InputTokens: 100,
      OutputTokens: 200,
      CostUsd: 0.05,
      Score: '9/10',
      Verdict: 'APPROVED',
    };
    fs.writeFileSync(auditFile, JSON.stringify(auditRow) + '\n', 'utf8');

    // Create a finished job in jobsDir
    fs.mkdirSync(paths.jobsDir, { recursive: true });
    const jobMeta = {
      job_id: 'job_test_sync',
      status: 'DONE',
      exit_code: 0,
      started_at: new Date(Date.now() - 10000).toISOString(),
      finished_at: new Date().toISOString(),
      project_path: paths.projectsRoot,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      review: {
        verdict: 'APPROVED',
        score: 9.2,
        rounds: 1,
      },
    };
    fs.writeFileSync(
      path.win32.join(paths.jobsDir, 'job_test_sync.json'),
      JSON.stringify(jobMeta),
      'utf8'
    );

    // Sync ledger once
    await syncLedger(ctx);

    const ledgerFile = path.win32.join(paths.featureDataDir('budget'), 'ledger.jsonl');
    assert.ok(fs.existsSync(ledgerFile));
    const lines1 = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    assert.equal(lines1.length, 1);

    const row = JSON.parse(lines1[0]!);
    assert.equal(row.job_id, 'job_test_sync');
    assert.equal(row.status, 'DONE');
    assert.equal(row.review.verdict, 'APPROVED');
    assert.equal(row.review.score, 9.2);

    // Sync ledger twice (idempotency check)
    await syncLedger(ctx);
    const lines2 = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    assert.equal(lines2.length, 1, 'syncLedger must be idempotent by job_id');
  } finally {
    cleanup();
  }
});

test('regression Item 4: budget_spend falls back to global project cap when no override exists', async () => {
  const { paths, ctx, cleanup } = createTempEnv();
  try {
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });

    // Set global project cap: warn: 10, block: 25, period: 'month'
    const budgetConfig = {
      version: 1,
      enabled: true,
      caps: {
        project: { usd: { warn: 10, block: 25 }, period: 'month' },
      },
      projects: {}, // no project overrides
    };
    fs.writeFileSync(path.win32.join(budgetDir, 'budgets.json'), JSON.stringify(budgetConfig), 'utf8');

    const spendHandler = (feature as any).routes.budget_spend.handler;
    const req = {
      method: 'GET',
      url: new URL(`http://localhost/budget_spend?project_path=${encodeURIComponent(paths.projectsRoot)}`),
      headers: new Headers(),
      query: new URLSearchParams({ project_path: paths.projectsRoot }),
    };

    const res = await spendHandler(ctx, req);
    assert.ok(res);
    assert.equal(res.project.cap.warn, 10);
    assert.equal(res.project.cap.block, 25);
    assert.equal(res.project.period, 'month');
  } finally {
    cleanup();
  }
});
