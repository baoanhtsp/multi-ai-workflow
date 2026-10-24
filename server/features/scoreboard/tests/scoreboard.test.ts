import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  computeScoreboard,
  suggestTeam,
  type LedgerJobRecord,
} from '../lib/scoreboard-core.ts';

function createTempScoreboardEnv() {
  const tmp = path.win32.join(
    os.tmpdir(),
    `maw_test_sb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(tmp, { recursive: true });
  const mawHome = path.join(tmp, '.maw');
  const userProfile = path.join(tmp, 'user');
  const tempDir = path.join(tmp, 'temp');
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
  paths.tempDir = tempDir;

  const cleanup = () => {
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { tmp, paths, cleanup };
}

test('scoreboard metrics: computes approval rate, avg score, fix rounds, cost per approved, median, and reviewer given rows', () => {
  const { paths, cleanup } = createTempScoreboardEnv();
  try {
    const registry = loadAgentRegistry(paths);

    // Write fixture ledger.jsonl
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const ledgerFile = path.join(budgetDir, 'ledger.jsonl');

    const now = new Date();
    const ledgerRows: LedgerJobRecord[] = [
      // Job 1: claude backend, approved score 9.0, 1 round, cost 0.50, duration 30s
      {
        job_id: 'job_1',
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 60000).toISOString(),
        finished_at: new Date(now.getTime() - 30000).toISOString(),
        duration_s: 30,
        cost_usd: 0.5,
        review: { verdict: 'APPROVED', score: 9.0, rounds: 1 },
      },
      // Job 2: claude backend, approved score 8.0, cost 0.70, duration 50s
      {
        job_id: 'job_2',
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 50000).toISOString(),
        finished_at: new Date(now.getTime() - 20000).toISOString(),
        duration_s: 50,
        cost_usd: 0.7,
        review: { verdict: 'APPROVED', score: 8.0, rounds: 1 },
      },
      // Job 3: claude backend, failed CHANGES_REQUESTED score 6.0, exit 0, cost 0.30, duration 40s
      {
        job_id: 'job_3',
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 40000).toISOString(),
        finished_at: new Date(now.getTime() - 10000).toISOString(),
        duration_s: 40,
        cost_usd: 0.3,
        review: { verdict: 'CHANGES_REQUESTED', score: 6.0, rounds: 1 },
      },
      // Job 4: codex backend auto-gate, approved score 9.5, 3 rounds (2 fix rounds), cost 1.20, duration 80s
      {
        job_id: 'job_4',
        mode: 'auto-gate',
        agent: 'codex',
        implementer: 'codex',
        role: 'backend',
        reviewers: ['gemini'],
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 30000).toISOString(),
        finished_at: now.toISOString(),
        duration_s: 80,
        cost_usd: 1.2,
        review: { verdict: 'APPROVED', score: 9.5, rounds: 3 },
      },
    ];

    fs.writeFileSync(
      ledgerFile,
      ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );

    // Write fixture audit rows for reviewer calls
    fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
    const auditRows = [
      // Gemini reviewer calls
      {
        Timestamp: now.toISOString(),
        Tool: 'gemini',
        Agent: 'gemini',
        Role: 'reviewer',
        Model: 'gemini-2.5',
        WorkDir: paths.projectsRoot,
        PromptChars: 200,
        InputTokens: 100,
        OutputTokens: 50,
        CostUsd: 0.02,
        Score: '9.5/10',
        Verdict: 'APPROVED',
      },
      {
        Timestamp: now.toISOString(),
        Tool: 'gemini',
        Agent: 'gemini',
        Role: 'reviewer',
        Model: 'gemini-2.5',
        WorkDir: paths.projectsRoot,
        PromptChars: 200,
        InputTokens: 100,
        OutputTokens: 50,
        CostUsd: 0.02,
        Score: '8.5/10',
        Verdict: 'APPROVED',
      },
    ];
    fs.writeFileSync(
      paths.auditFile,
      auditRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );

    const sb = computeScoreboard(paths, registry, { days: 30 });

    // Find claude backend row
    const claudeRow = sb.rows.find((r) => r.agent === 'claude' && r.role === 'backend');
    assert.ok(claudeRow);
    assert.equal(claudeRow.tasks, 3);
    assert.equal(claudeRow.reviewed, 3);
    // 2 approved out of 3 reviewed = 0.6667
    assert.ok(Math.abs(claudeRow.approval_rate! - 2 / 3) < 0.001);
    // avg score = (9 + 8 + 6) / 3 = 7.6667
    assert.ok(Math.abs(claudeRow.avg_score! - 23 / 3) < 0.001);
    // cost = 0.5 + 0.7 + 0.3 = 1.50
    assert.equal(claudeRow.cost_usd, 1.5);
    // cost per approved = 1.50 / 2 = 0.75
    assert.equal(claudeRow.cost_per_approved_usd, 0.75);
    // median duration of [30, 40, 50] = 40
    assert.equal(claudeRow.median_duration_s, 40);

    // Find codex backend row (auto-gate)
    const codexRow = sb.rows.find((r) => r.agent === 'codex' && r.role === 'backend');
    assert.ok(codexRow);
    assert.equal(codexRow.tasks, 1);
    assert.equal(codexRow.approval_rate, 1.0);
    assert.equal(codexRow.avg_score, 9.5);
    // 3 rounds - 1 = 2 fix rounds
    assert.equal(codexRow.avg_fix_rounds, 2);

    // Find gemini reviewer row
    const geminiRev = sb.rows.find((r) => r.agent === 'gemini' && r.role === 'reviewer');
    assert.ok(geminiRev);
    assert.equal(geminiRev.tasks, 2);
    assert.equal(geminiRev.approval_rate, 1.0); // 2 approved / 2
    assert.equal(geminiRev.avg_score, 9.0); // (9.5 + 8.5) / 2
  } finally {
    cleanup();
  }
});

test('suggest_team: computes score, confidence, handles tie-break, and falls back to registry defaults when no data', () => {
  const { paths, cleanup } = createTempScoreboardEnv();
  try {
    const registry = loadAgentRegistry(paths);

    // 1. With completely empty data -> should return registry default team
    const noDataSuggestion = suggestTeam(paths, registry, {
      days: 30,
      roles: ['backend', 'frontend', 'reviewer'],
    });

    assert.ok(noDataSuggestion.team.backend);
    assert.ok(noDataSuggestion.team.frontend);
    assert.ok(noDataSuggestion.team.reviewer);
    assert.ok(noDataSuggestion.details.backend.reason.includes('registry default'));
    assert.equal(noDataSuggestion.details.backend.confidence, 0);

    // 2. With data present: add strong history for codex backend
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const ledgerFile = path.join(budgetDir, 'ledger.jsonl');

    const now = new Date();
    const ledgerRows: LedgerJobRecord[] = [];
    // 5 successful approved jobs for codex backend
    for (let i = 0; i < 5; i++) {
      ledgerRows.push({
        job_id: `job_codex_${i}`,
        mode: 'task',
        agent: 'codex',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 10000 * i).toISOString(),
        finished_at: new Date(now.getTime() - 10000 * i + 5000).toISOString(),
        duration_s: 20,
        cost_usd: 0.1,
        review: { verdict: 'APPROVED', score: 9.8, rounds: 1 },
      });
    }
    fs.writeFileSync(
      ledgerFile,
      ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );

    const withDataSuggestion = suggestTeam(paths, registry, {
      days: 30,
      roles: ['backend'],
    });

    assert.equal(withDataSuggestion.team.backend, 'codex');
    assert.equal(withDataSuggestion.details.backend.confidence, 1);
    assert.ok(withDataSuggestion.details.backend.score > 0.8);
    assert.ok(withDataSuggestion.details.backend.reason.includes('approval 100%'));
  } finally {
    cleanup();
  }
});

test('suggest_team regression: candidates[] sorted descending by finalScore, and tie-break selects registry default or lower cost with explicit reason', () => {
  const { paths, cleanup } = createTempScoreboardEnv();
  try {
    const registry = loadAgentRegistry(paths);
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    const ledgerFile = path.join(budgetDir, 'ledger.jsonl');

    const now = new Date();
    // In registry defaults, frontend default is 'claude'.
    // We create jobs for 'aider' and 'claude' for frontend role.
    // We adjust metrics so:
    // aider: 1 task, score 8.0, cost $1.00 -> finalScore ~ 0.505
    // claude: 1 task, score 7.5, cost $1.00 -> finalScore ~ 0.495
    // |Δ| = 0.010 < 0.02 (tie)
    // Both have equal cost ($1.00). Claude is registry default for frontend.
    // Result: claude must be chosen with 'tie-break: registry default'
    // candidates[] must have aider first (0.505) and claude second (0.495)
    const ledgerRows: LedgerJobRecord[] = [
      {
        job_id: 'job_aider_front',
        mode: 'task',
        agent: 'aider',
        role: 'frontend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 20000).toISOString(),
        finished_at: new Date(now.getTime() - 10000).toISOString(),
        duration_s: 10,
        cost_usd: 1.0,
        review: { verdict: 'APPROVED', score: 8.0, rounds: 1 },
      },
      {
        job_id: 'job_claude_front',
        mode: 'task',
        agent: 'claude',
        role: 'frontend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 20000).toISOString(),
        finished_at: new Date(now.getTime() - 10000).toISOString(),
        duration_s: 10,
        cost_usd: 1.0,
        review: { verdict: 'APPROVED', score: 7.5, rounds: 1 },
      },
      // Backend test for lower cost tie-break:
      // In registry, backend default is 'antigravity'.
      // We test codex vs gemini (neither is registry default):
      // codex: 1 task, score 8.0, cost $2.00
      // gemini: 1 task, score 7.5, cost $0.10
      // |Δ| < 0.02 (tie). Gemini cost is $0.10 vs Codex $2.00 (> $0.01 lower).
      // Result: gemini chosen with 'tie-break: lower cost'
      // candidates[] must have codex first and gemini second.
      {
        job_id: 'job_codex_back',
        mode: 'task',
        agent: 'codex',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 20000).toISOString(),
        finished_at: new Date(now.getTime() - 10000).toISOString(),
        duration_s: 10,
        cost_usd: 2.0,
        review: { verdict: 'APPROVED', score: 8.0, rounds: 1 },
      },
      {
        job_id: 'job_gemini_back',
        mode: 'task',
        agent: 'gemini',
        role: 'backend',
        status: 'DONE',
        exit_code: 0,
        started_at: new Date(now.getTime() - 20000).toISOString(),
        finished_at: new Date(now.getTime() - 10000).toISOString(),
        duration_s: 10,
        cost_usd: 0.1,
        review: { verdict: 'APPROVED', score: 7.5, rounds: 1 },
      },
    ];

    fs.writeFileSync(
      ledgerFile,
      ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );

    const suggestion = suggestTeam(paths, registry, {
      days: 30,
      roles: ['frontend', 'backend'],
    });

    // 1. Verify Frontend: registry default tie-break
    const frontDetail = suggestion.details.frontend;
    assert.equal(suggestion.team.frontend, 'claude', 'claude should win frontend on registry default tie-break');
    assert.equal(frontDetail.agent, 'claude');
    assert.ok(
      frontDetail.reason.includes('tie-break: registry default'),
      `reason should contain 'tie-break: registry default', got: ${frontDetail.reason}`
    );

    // candidates[] must be strictly sorted by finalScore desc
    for (let i = 0; i < frontDetail.candidates.length - 1; i++) {
      assert.ok(
        frontDetail.candidates[i]!.score >= frontDetail.candidates[i + 1]!.score,
        'candidates must be sorted descending by score'
      );
    }
    // Aider has higher score than claude, so aider must be candidates[0]
    assert.equal(frontDetail.candidates[0]!.agent, 'aider');
    const claudeCand = frontDetail.candidates.find((c) => c.agent === 'claude');
    assert.ok(claudeCand);
    assert.ok(frontDetail.candidates[0]!.score > claudeCand.score);

    // 2. Verify Backend: lower cost tie-break
    const backDetail = suggestion.details.backend;
    assert.equal(suggestion.team.backend, 'gemini', 'gemini should win backend on lower cost tie-break');
    assert.equal(backDetail.agent, 'gemini');
    assert.ok(
      backDetail.reason.includes('tie-break: lower cost'),
      `reason should contain 'tie-break: lower cost', got: ${backDetail.reason}`
    );

    // candidates[] sorted descending by score
    for (let i = 0; i < backDetail.candidates.length - 1; i++) {
      assert.ok(
        backDetail.candidates[i]!.score >= backDetail.candidates[i + 1]!.score,
        'candidates must be sorted descending by score'
      );
    }
    // Codex has higher score than gemini, so codex must be candidates[0]
    assert.equal(backDetail.candidates[0]!.agent, 'codex');
  } finally {
    cleanup();
  }
});

test('scoreboard: incorporates S5 human review verdicts for un-ledgered jobs within window', () => {
  const { paths, cleanup } = createTempScoreboardEnv();
  try {
    const registry = loadAgentRegistry(paths);

    // Empty ledger
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });
    fs.writeFileSync(path.join(budgetDir, 'ledger.jsonl'), '', 'utf8');

    // S5 human verdicts
    const reviewDir = path.join(paths.mawHome, 'data', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const now = new Date();
    const verdict = {
      ts: new Date(now.getTime() - 60000).toISOString(),
      job_id: 'job_human_external',
      agent: 'claude',
      role: 'backend',
      verdict: 'APPROVED',
      score: 8.5,
      note: 'Verified by human reviewer',
    };
    fs.writeFileSync(path.join(reviewDir, 'verdicts.jsonl'), JSON.stringify(verdict) + '\n', 'utf8');

    const result = computeScoreboard(paths, registry, { days: 7 });
    const stat = result.rows.find((s) => s.agent === 'claude' && s.role === 'backend');

    assert.ok(stat, 'claude:backend stat should exist from human review');
    assert.equal(stat.reviewed, 1);
    assert.equal(stat.avg_score, 8.5);
    assert.equal(stat.approval_rate, 1);
  } finally {
    cleanup();
  }
});

test('regression N4 & N5: late S5 human verdict overrides ledger row review, and repeated lines count once using latest by ts', () => {
  const { paths, cleanup } = createTempScoreboardEnv();
  try {
    const registry = loadAgentRegistry(paths);
    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });

    // 1. Existing ledger row with an automatic review verdict (e.g. CHANGES_REQUESTED, score: 5.0)
    const ledgerRow = {
      job_id: 'job_ledgered_rev',
      team_run_id: 'tr_1',
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'DONE',
      started_at: new Date(Date.now() - 3600000).toISOString(),
      duration_s: 60,
      calls: 1,
      in_tokens: 100,
      out_tokens: 100,
      cost_usd: 0.05,
      review: {
        verdict: 'CHANGES_REQUESTED',
        score: 5.0,
        rounds: 2,
      },
    };
    fs.writeFileSync(path.join(budgetDir, 'ledger.jsonl'), JSON.stringify(ledgerRow) + '\n', 'utf8');

    // 2. Late S5 verdicts file contains multiple lines for the same job_id (N5 deduplication)
    // Line 1: earlier timestamp with score 7.0
    // Line 2: latest timestamp with APPROVED, score 9.5 (N4 human override)
    const reviewDir = path.join(paths.mawHome, 'data', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });

    const verdict1 = {
      ts: '2026-10-25T10:00:00.000Z',
      job_id: 'job_ledgered_rev',
      agent: 'claude',
      role: 'backend',
      verdict: 'CHANGES_REQUESTED',
      score: 7.0,
      note: 'Initial review',
    };
    const verdict2 = {
      ts: '2026-10-25T10:15:00.000Z', // later ts wins
      job_id: 'job_ledgered_rev',
      agent: 'claude',
      role: 'backend',
      verdict: 'APPROVED',
      score: 9.5,
      note: 'Approved after fixes',
    };

    fs.writeFileSync(
      path.join(reviewDir, 'verdicts.jsonl'),
      JSON.stringify(verdict1) + '\n' + JSON.stringify(verdict2) + '\n',
      'utf8'
    );

    const result = computeScoreboard(paths, registry, { days: 7 });
    const stat = result.rows.find((s) => s.agent === 'claude' && s.role === 'backend');

    assert.ok(stat, 'claude:backend stat should exist');
    // Must count exactly 1 job (not 2 or 3 times)
    assert.equal(stat.tasks, 1);
    assert.equal(stat.reviewed, 1, 'must count exactly once despite repeated verdict lines');
    // Human verdict score 9.5 must override ledger score 5.0 and verdict1 score 7.0
    assert.equal(stat.avg_score, 9.5);
    assert.equal(stat.approval_rate, 1);
    assert.equal(result.totals.jobs, 1);
  } finally {
    cleanup();
  }
});
