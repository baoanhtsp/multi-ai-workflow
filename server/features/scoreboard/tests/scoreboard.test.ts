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
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });

  const paths = resolveServerPaths({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
  });

  const cleanup = () => {
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
