import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveServerPaths, type ServerPaths } from '../lib/paths.ts';
import { loadAgentRegistry } from '../lib/registry.ts';
import { appendAuditEntry } from '../lib/audit.ts';
import { buildCommandSpec } from '../lib/commands.ts';
import { buildValidatedCommand, ApiValidationError } from '../lib/validate.ts';
import { createMawHttpServer } from '../http.ts';
import { createFeatureContext } from '../lib/feature.ts';

import {
  deleteAccount,
  isAllowedAccountDir,
  listAllAccounts,
  resolveAccountExecutionEnv,
  saveAccount,
} from '../features/accounts/store.ts';
import { feature as accountsFeature } from '../features/accounts/index.ts';
import {
  computeQuotaLevel,
  decideQuotaRoute,
  loadQuotaSnapshots,
  recordAccountRateLimited,
  refreshAllQuotaSnapshots,
  saveQuotaSnapshots,
} from '../features/quota/store.ts';
import { feature as quotaFeature } from '../features/quota/index.ts';
import { findCodexQuotaWindows } from '../features/health/probes.ts';
import {
  createDefaultFallbackConfig,
  validateFallbackConfig,
  writeJsonAtomic,
} from '../features/policy/lib/s4-core.ts';
import { buildLimitHandoffLetter, buildPrompt } from '../features/agents-ws/lib/prompt.ts';
import { feature as agentsWsFeature } from '../features/agents-ws/index.ts';
import { feature as chatFeature } from '../features/chat/index.ts';
import { resetTickTimerForTest, tick } from '../features/chat/tick.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function makeS7TestEnv(): {
  rootDir: string;
  paths: ServerPaths;
  projectDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-s7-test-'));
  const userProfile = path.join(rootDir, 'user');
  const mawHome = path.join(userProfile, '.maw');
  const tempDir = path.join(rootDir, 'temp');
  const projectsRoot = path.join(rootDir, 'projects');
  const projectDir = path.join(projectsRoot, 'demo-app');

  fs.mkdirSync(path.join(userProfile, '.gemini', 'antigravity'), { recursive: true });
  fs.mkdirSync(path.join(userProfile, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(userProfile, '.codex'), { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const geminiSkillDir = path.join(userProfile, '.gemini', 'config', 'skills', 'claude-leader');
  fs.mkdirSync(geminiSkillDir, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'antigravity', 'skills', 'claude-leader'), geminiSkillDir, {
    recursive: true,
  });

  const paths = resolveServerPaths({
    repoRoot,
    userProfile,
    mawHome,
    tempDir,
    projectsRoot,
  });

  return {
    rootDir,
    paths,
    projectDir,
    cleanup: () => {
      resetTickTimerForTest();
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error on Windows
      }
    },
  };
}

test('S7.1 — Account validation, storage, and adapter env resolution', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  const registry = loadAgentRegistry(env.paths);

  // 1. Default implicit accounts exist for all enabled agents
  const initial = listAllAccounts(env.paths, registry);
  assert.ok(initial.accounts.some((a) => a.agent === 'claude' && a.id === 'default' && a.is_default));
  assert.ok(initial.accounts.some((a) => a.agent === 'codex' && a.id === 'default' && a.is_default));
  assert.ok(initial.accounts.some((a) => a.agent === 'gemini' && a.id === 'default' && a.is_default));
  assert.equal(initial.adapters.claude?.supported, true);
  assert.equal(initial.adapters.claude?.env_var, 'CLAUDE_CONFIG_DIR');
  assert.equal(initial.adapters.codex?.supported, true);
  assert.equal(initial.adapters.codex?.env_var, 'CODEX_HOME');
  assert.equal(initial.adapters.gemini?.supported, true);
  assert.equal(initial.adapters.gemini?.env_var, 'GEMINI_CLI_HOME');
  assert.equal(initial.adapters.antigravity?.supported, false);

  // 2. Save non-default accounts for claude, codex, gemini (creates isolated dirs automatically)
  const savedClaude = saveAccount(env.paths, registry, {
    agent: 'claude',
    id: 'work',
    label: 'Claude Work',
    enabled: true,
    priority: 1,
    limits: { tokens_5h: 100_000, tokens_7d: 500_000 },
  });
  assert.equal(savedClaude.id, 'work');
  assert.equal(savedClaude.agent, 'claude');
  assert.ok(fs.existsSync(savedClaude.dir), 'account_save must create the isolated directory');

  const savedCodex = saveAccount(env.paths, registry, {
    agent: 'codex',
    id: 'personal',
    label: 'Codex Personal',
    enabled: true,
    priority: 2,
  });
  assert.equal(savedCodex.id, 'personal');
  assert.ok(fs.existsSync(savedCodex.dir));

  const savedGemini = saveAccount(env.paths, registry, {
    agent: 'gemini',
    id: 'team',
    label: 'Gemini Team',
    enabled: true,
    priority: 1,
  });
  assert.equal(savedGemini.id, 'team');
  assert.ok(fs.existsSync(savedGemini.dir));

  // 3. Adapter env resolution
  const claudeEnv = resolveAccountExecutionEnv(env.paths, registry, 'claude', 'work');
  assert.equal(claudeEnv.env.CLAUDE_CONFIG_DIR, savedClaude.dir);

  const codexEnv = resolveAccountExecutionEnv(env.paths, registry, 'codex', 'personal');
  assert.equal(codexEnv.env.CODEX_HOME, savedCodex.dir);

  const geminiEnv = resolveAccountExecutionEnv(env.paths, registry, 'gemini', 'team');
  assert.equal(geminiEnv.env.GEMINI_CLI_HOME, savedGemini.dir);

  const defaultClaudeEnv = resolveAccountExecutionEnv(env.paths, registry, 'claude', 'default');
  assert.deepEqual(defaultClaudeEnv.env, {});

  // 4. Reject bad account id, unsupported adapter, outside dir, deleting default
  assert.throws(
    () =>
      saveAccount(env.paths, registry, {
        agent: 'claude',
        id: 'BAD ID!',
      }),
    (err: unknown) => err instanceof ApiValidationError && err.statusCode === 400
  );

  assert.throws(
    () =>
      saveAccount(env.paths, registry, {
        agent: 'antigravity',
        id: 'secondary',
      }),
    (err: unknown) =>
      err instanceof ApiValidationError &&
      err.statusCode === 400 &&
      /not support/i.test(err.message)
  );

  assert.equal(isAllowedAccountDir('C:\\Windows\\System32', env.paths), false);
  assert.throws(
    () =>
      saveAccount(env.paths, registry, {
        agent: 'claude',
        id: 'outside',
        dir: 'C:\\Windows\\System32',
      }),
    (err: unknown) => err instanceof ApiValidationError && err.statusCode === 400
  );

  assert.throws(
    () => deleteAccount(env.paths, 'claude', 'default'),
    (err: unknown) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // 5. Delete non-default account removes entry from accounts.json but keeps directory on disk
  deleteAccount(env.paths, 'codex', 'personal');
  assert.ok(fs.existsSync(savedCodex.dir), 'deleting account must not delete its directory on disk');
  const afterDel = listAllAccounts(env.paths, registry);
  assert.ok(!afterDel.accounts.some((a) => a.agent === 'codex' && a.id === 'personal'));
});

test('S7.2 — Codex rollout parsing of both primary (5h) and secondary (7d) windows', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  const codexAccDir = path.join(env.paths.mawHome, 'accounts', 'codex', 'work');
  const sessionsDir = path.join(codexAccDir, 'sessions', '2026', '10', '25');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexAccDir, 'auth.json'), '{"tokens":{}}', 'utf8');

  const nowSec = Math.floor(Date.now() / 1000);
  const reset5hSec = nowSec + 7200;
  const reset7dSec = nowSec + 86400 * 3;

  const rolloutLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: 42.5,
          window_minutes: 300,
          resets_at: reset5hSec,
        },
        secondary: {
          used_percent: 88.2,
          window_minutes: 10080,
          resets_at: reset7dSec,
        },
      },
    },
  });
  fs.writeFileSync(
    path.join(sessionsDir, 'rollout-2026-10-25T10-00-00-test.jsonl'),
    rolloutLine + '\n',
    'utf8'
  );

  const windows = findCodexQuotaWindows(codexAccDir);
  assert.equal(windows.length, 2);

  const win5h = windows.find((w) => w.id === '5h');
  const win7d = windows.find((w) => w.id === '7d');
  assert.ok(win5h, 'must parse primary 5h window');
  assert.equal(win5h.used_percent, 42.5);
  assert.equal(win5h.source, 'provider');
  assert.equal(win5h.resets_at, new Date(reset5hSec * 1000).toISOString());

  assert.ok(win7d, 'must parse secondary 7d window');
  assert.equal(win7d.used_percent, 88.2);
  assert.equal(win7d.source, 'provider');
  assert.equal(win7d.resets_at, new Date(reset7dSec * 1000).toISOString());
});

test('S7.3 — Estimate math (limits vs audit tokens in rolling 5h/7d windows) & level transitions', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  const registry = loadAgentRegistry(env.paths);

  // Configure default claude account with 5h=100k, 7d=500k limits
  saveAccount(env.paths, registry, {
    agent: 'claude',
    id: 'default',
    label: 'Claude Default',
    enabled: true,
    priority: 1,
    limits: { tokens_5h: 100_000, tokens_7d: 500_000 },
  });
  // Put dummy credentials file so login check reports 'ok'
  fs.writeFileSync(
    path.join(env.paths.userProfile, '.claude', '.credentials.json'),
    '{"claudeAiOauth":{}}',
    'utf8'
  );

  const nowMs = Date.now();
  // Append audit rows:
  // 1) 2 hours ago (inside 5h and 7d): 75,000 tokens -> 5h = 75% (warn)
  appendAuditEntry(env.paths.auditFile, {
    Timestamp: new Date(nowMs - 2 * 3600 * 1000).toISOString(),
    Tool: 'claude',
    Account: 'default',
    Role: 'backend',
    Model: 'sonnet',
    WorkDir: env.projectDir,
    PromptChars: 1000,
    InputTokens: 50_000,
    OutputTokens: 25_000,
    CostUsd: 0.5,
  });
  // 2) 2 days ago (outside 5h, inside 7d): 125,000 tokens -> 7d total = 200,000 / 500,000 = 40%
  appendAuditEntry(env.paths.auditFile, {
    Timestamp: new Date(nowMs - 48 * 3600 * 1000).toISOString(),
    Tool: 'claude',
    Account: 'default',
    Role: 'backend',
    Model: 'sonnet',
    WorkDir: env.projectDir,
    PromptChars: 1000,
    InputTokens: 100_000,
    OutputTokens: 25_000,
    CostUsd: 1.0,
  });

  const snaps1 = refreshAllQuotaSnapshots(env.paths, registry, {
    agent: 'claude',
    account: 'default',
    nowMs,
  });
  const claudeSnap1 = snaps1.find((s) => s.agent === 'claude' && s.account === 'default');
  assert.ok(claudeSnap1);
  const w5h = claudeSnap1.windows.find((w) => w.id === '5h');
  const w7d = claudeSnap1.windows.find((w) => w.id === '7d');
  assert.ok(w5h);
  assert.ok(w7d);
  assert.equal(w5h.used_percent, 75);
  assert.equal(w5h.source, 'estimate');
  assert.equal(w7d.used_percent, 40);
  assert.equal(claudeSnap1.level, 'warn');

  // Add another 15,000 tokens 1 hour ago -> 5h = 90% -> level transitions from 'warn' to 'high'
  appendAuditEntry(env.paths.auditFile, {
    Timestamp: new Date(nowMs - 1 * 3600 * 1000).toISOString(),
    Tool: 'claude',
    Account: 'default',
    Role: 'backend',
    Model: 'sonnet',
    WorkDir: env.projectDir,
    PromptChars: 500,
    InputTokens: 10_000,
    OutputTokens: 5_000,
    CostUsd: 0.1,
  });

  const snaps2 = refreshAllQuotaSnapshots(env.paths, registry, {
    agent: 'claude',
    account: 'default',
    nowMs,
  });
  const claudeSnap2 = snaps2.find((s) => s.agent === 'claude' && s.account === 'default');
  assert.ok(claudeSnap2);
  assert.equal(claudeSnap2.level, 'high');

  // Verify events.jsonl recorded the level transition warn -> high
  const eventsFile = path.join(env.paths.featureDataDir('quota'), 'events.jsonl');
  assert.ok(fs.existsSync(eventsFile), 'events.jsonl must be written on level transition');
  const events = fs
    .readFileSync(eventsFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l));
  assert.ok(
    events.some(
      (e) =>
        e.agent === 'claude' &&
        e.account === 'default' &&
        e.prev_level === 'warn' &&
        e.level === 'high'
    )
  );

  // Verify computeQuotaLevel thresholds directly
  assert.equal(
    computeQuotaLevel([{ id: '5h', used_percent: 69.9, resets_at: null, source: 'estimate' }], null, 85, nowMs),
    'ok'
  );
  assert.equal(
    computeQuotaLevel([{ id: '5h', used_percent: 70, resets_at: null, source: 'estimate' }], null, 85, nowMs),
    'warn'
  );
  assert.equal(
    computeQuotaLevel([{ id: '5h', used_percent: 85, resets_at: null, source: 'estimate' }], null, 85, nowMs),
    'high'
  );
  assert.equal(
    computeQuotaLevel([{ id: '5h', used_percent: 100, resets_at: null, source: 'estimate' }], null, 85, nowMs),
    'full'
  );
});

test('S7.4 — §3.2 Proactive routing decision table (auto, suggest, off, prefer, when_all_full)', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  const registry = loadAgentRegistry(env.paths);
  const fallbackDir = env.paths.featureDataDir('fallback');

  // Set up credentials so claude/default, claude/work, and codex/default are signed in
  fs.writeFileSync(path.join(env.paths.userProfile, '.claude', '.credentials.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(env.paths.userProfile, '.codex', 'auth.json'), '{}', 'utf8');

  const workAcc = saveAccount(env.paths, registry, {
    agent: 'claude',
    id: 'work',
    label: 'Claude Work',
    enabled: true,
    priority: 2,
  });
  fs.writeFileSync(path.join(workAcc.dir, '.credentials.json'), '{}', 'utf8');

  const nowMs = Date.now();
  const resetFuture = new Date(nowMs + 3600 * 1000).toISOString();

  // Seed snapshots:
  // claude/default = 92% (high)
  // claude/work = 35% (ok)
  // codex/default = 10% (ok)
  saveQuotaSnapshots(env.paths, [
    {
      agent: 'claude',
      account: 'default',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 92, resets_at: resetFuture, source: 'provider' }],
      level: 'high',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'claude',
      account: 'work',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 35, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'codex',
      account: 'default',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 10, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
  ]);

  const setRouting = (patch: Partial<ReturnType<typeof createDefaultFallbackConfig>['quota_routing']>) => {
    const base = createDefaultFallbackConfig();
    base.roles.backend = { fallbacks: ['codex'], auto_fallback: true };
    base.quota_routing = { ...base.quota_routing, ...patch };
    const validated = validateFallbackConfig(base, ['claude', 'codex', 'gemini', 'antigravity']);
    writeJsonAtomic(path.join(fallbackDir, 'routing.json'), validated.config);
  };

  // Case 1: mode = 'auto', prefer = 'same-agent' -> switches claude/default (92%) to claude/work (35%)
  setRouting({ enabled: true, mode: 'auto', switch_at: 85, prefer: 'same-agent', when_all_full: 'wait' });
  const d1 = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(d1.reason, 'switched');
  assert.deepEqual(d1.chosen, { agent: 'claude', account: 'work' });

  // Case 2: mode = 'auto', prefer = 'any' -> picks codex/default (10%) over claude/work (35%)
  setRouting({ enabled: true, mode: 'auto', switch_at: 85, prefer: 'any', when_all_full: 'wait' });
  const d2 = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(d2.reason, 'switched');
  assert.deepEqual(d2.chosen, { agent: 'codex', account: 'default' });

  // Case 3: mode = 'suggest' -> keeps requested claude/default, attaches suggestion
  setRouting({ enabled: true, mode: 'suggest', switch_at: 85, prefer: 'same-agent', when_all_full: 'wait' });
  const d3 = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(d3.reason, 'suggested');
  assert.deepEqual(d3.chosen, { agent: 'claude', account: 'default' });
  assert.equal(d3.suggestion?.agent, 'claude');
  assert.equal(d3.suggestion?.account, 'work');

  // Case 4: mode = 'off' -> keeps requested claude/default with reason 'ok'
  setRouting({ enabled: true, mode: 'off', switch_at: 85, prefer: 'same-agent', when_all_full: 'wait' });
  const d4 = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(d4.mode, 'off');
  assert.equal(d4.reason, 'ok');
  assert.deepEqual(d4.chosen, { agent: 'claude', account: 'default' });

  // Case 5: All candidates full -> when_all_full = 'wait' vs 'run'
  saveQuotaSnapshots(env.paths, [
    {
      agent: 'claude',
      account: 'default',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 100, resets_at: resetFuture, source: 'provider' }],
      level: 'full',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'claude',
      account: 'work',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 90, resets_at: resetFuture, source: 'provider' }],
      level: 'high',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'codex',
      account: 'default',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 95, resets_at: resetFuture, source: 'provider' }],
      level: 'high',
      cooldown_until: null,
      last_error: null,
    },
  ]);

  setRouting({ enabled: true, mode: 'auto', switch_at: 85, prefer: 'same-agent', when_all_full: 'wait' });
  const dWait = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(dWait.reason, 'waiting');
  assert.equal(dWait.resets_at, resetFuture);

  setRouting({ enabled: true, mode: 'auto', switch_at: 85, prefer: 'same-agent', when_all_full: 'run' });
  const dRun = decideQuotaRoute(env.paths, registry, {
    agent: 'claude',
    role: 'backend',
    account: 'default',
    refreshIfStale: false,
    nowMs,
  }).decision;
  assert.equal(dRun.reason, 'all-full');
  // Must never pick the 'full' account (99%), picks least-used 'claude/work' (90%)
  assert.deepEqual(dRun.chosen, { agent: 'claude', account: 'work' });
});

test('S7.5 — Handoff letter assembly and §4 Limit handoff in S6 chat (auto & suggest modes)', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  // 1. Unit test buildLimitHandoffLetter & buildPrompt with handoffLetter
  const letterFromSummary = buildLimitHandoffLetter({
    from: { agent: 'claude', account: 'default' },
    reason: '5h 96%',
    summary: 'Completed database schema and user auth routes.',
    messages: [{ role: 'user', text: 'Should be ignored when summary is present' }],
  });
  assert.ok(letterFromSummary.includes('Continuing from claude/default (stopped at 5h 96%)'));
  assert.ok(letterFromSummary.includes('Completed database schema and user auth routes.'));
  assert.ok(!letterFromSummary.includes('Should be ignored'));

  const twelveMessages = Array.from({ length: 12 }, (_, idx) => ({
    role: idx % 2 === 0 ? 'user' : 'assistant',
    text: `Msg_${idx + 1}_` + 'x'.repeat(2600),
  }));
  const letterFromMsgs = buildLimitHandoffLetter({
    from: { agent: 'claude', account: 'work' },
    reason: 'rate_limited',
    summary: '',
    messages: twelveMessages,
  });
  assert.ok(!letterFromMsgs.includes('Msg_1_'), 'must only include last 10 messages');
  assert.ok(!letterFromMsgs.includes('Msg_2_'), 'must only include last 10 messages');
  assert.ok(letterFromMsgs.includes('Msg_3_'));
  assert.ok(letterFromMsgs.includes('Msg_12_'));

  const fullPrompt = buildPrompt({
    agent: { name: 'Backend Dev', reply_language: 'vi' },
    newMessageText: 'Finish the quota router tests',
    handoffLetter: letterFromSummary,
    replyLanguage: 'vi',
  });
  assert.ok(fullPrompt.startsWith('# Handoff letter\n'), 'prompt must start with # Handoff letter');
  assert.ok(fullPrompt.includes('# Agent\nName: Backend Dev'));
  assert.ok(fullPrompt.includes('# Message\n\nFinish the quota router tests'));
  assert.ok(fullPrompt.endsWith('Keep code, commands, file paths and identifiers as they are.'), '# Language must remain at the end');

  // 2. Integration test: S6 chat limit handoff in auto and suggest modes
  const registry = loadAgentRegistry(env.paths);
  const fallbackDir = env.paths.featureDataDir('fallback');

  fs.writeFileSync(path.join(env.paths.userProfile, '.claude', '.credentials.json'), '{}', 'utf8');
  const workAcc = saveAccount(env.paths, registry, {
    agent: 'claude',
    id: 'work',
    label: 'Claude Work',
    enabled: true,
    priority: 2,
  });
  fs.writeFileSync(path.join(workAcc.dir, '.credentials.json'), '{}', 'utf8');

  const nowMs = Date.now();
  const resetFuture = new Date(nowMs + 3600 * 1000).toISOString();

  // Create an S6 agent and conversation
  const startedJobs: Array<Record<string, unknown>> = [];
  const makeCtx = () => {
    const ctx = createFeatureContext(env.paths, registry);
    ctx.startJob = async (jobBody: Record<string, unknown>) => {
      const jid = `job_20261025_120000_${Math.random().toString(16).slice(2, 8)}`;
      startedJobs.push({ job_id: jid, ...jobBody });
      fs.mkdirSync(env.paths.jobsDir, { recursive: true });
      fs.writeFileSync(
        path.join(env.paths.jobsDir, `${jid}.json`),
        JSON.stringify({
          job_id: jid,
          pid: process.pid,
          mode: jobBody.mode || 'chat',
          agent: jobBody.agent || 'claude',
          account: jobBody.account || 'default',
          role: jobBody.role || 'backend',
          project_path: env.projectDir,
          command: 'mock',
          status: 'RUNNING',
          exit_code: null,
          started_at: new Date().toISOString(),
          started_ts: Math.floor(Date.now() / 1000),
        }),
        'utf8'
      );
      return {
        ok: true,
        job_id: jid,
        agent: jobBody.agent || 'claude',
        account: jobBody.account || 'default',
      };
    };
    return ctx;
  };

  const callRoute = async (
    handler: (ctxOrReq: any, req?: any) => Promise<unknown> | unknown,
    method: 'GET' | 'POST',
    body: Record<string, unknown> = {},
    queryParams: Record<string, string> = {}
  ) => {
    const ctx = makeCtx();
    const query = new URLSearchParams(queryParams);
    const req = {
      ctx,
      method,
      url: new URL('http://localhost/api'),
      query,
      body,
    };
    return await handler(Object.assign(ctx, req), req);
  };

  const saveAgentRes = (await callRoute(agentsWsFeature.routes!.ws_agent_save!.handler, 'POST', {
    agent: {
      name: 'Claude Lead',
      platform: 'claude',
      account: 'default',
      workdir: env.projectDir,
      role: 'backend',
    },
  })) as { ok: boolean; agent: { id: string } };
  const agentId = saveAgentRes.agent.id;

  const createConvRes = (await callRoute(chatFeature.routes!.chat_create!.handler, 'POST', {
    agent_id: agentId,
    title: 'S7 Chat',
  })) as { ok: boolean; conversation: { id: string } };
  const convId = createConvRes.conversation.id;

  // Configure auto quota routing
  const fbCfg = createDefaultFallbackConfig();
  fbCfg.quota_routing = {
    enabled: true,
    mode: 'auto',
    switch_at: 85,
    prefer: 'same-agent',
    when_all_full: 'wait',
  };
  writeJsonAtomic(path.join(fallbackDir, 'routing.json'), fbCfg);

  // Initially claude/default is 20% ok, claude/work is 10% ok
  saveQuotaSnapshots(env.paths, [
    {
      agent: 'claude',
      account: 'default',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 20, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'claude',
      account: 'work',
      checked_at: new Date(nowMs).toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 10, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
  ]);

  // Send a user turn on claude/default
  await callRoute(chatFeature.routes!.chat_send!.handler, 'POST', {
    conversation_id: convId,
    text: 'Implement step 1',
  });
  assert.equal(startedJobs.length, 1);
  const firstJobId = String(startedJobs[0]!.job_id);
  assert.equal(startedJobs[0]!.account, 'default');

  // Simulate the job failing with rate limit ("You've hit your limit")
  fs.writeFileSync(
    path.join(env.paths.jobsDir, `${firstJobId}.log`),
    "Error: You've hit your limit, resets in 2h\r\n=== [JOB_FINISHED exit_code=1] ===\r\n",
    'utf8'
  );

  // Run tick: in auto mode, it should mark claude/default rate_limited, switch conversation to claude/work,
  // append a limit_handoff system message (state='done'), and automatically re-run the failed turn on claude/work with # Handoff letter!
  await tick(makeCtx());

  assert.equal(startedJobs.length, 2, 'auto limit handoff must re-send the failed user turn on the new account');
  assert.equal(startedJobs[1]!.agent, 'claude');
  assert.equal(startedJobs[1]!.account, 'work');
  assert.ok(
    String(startedJobs[1]!.prompt).includes('# Handoff letter'),
    're-sent turn must include # Handoff letter'
  );

  // Finish the second job in suggest mode to test POST chat_limit_handoff
  const secondJobId = String(startedJobs[1]!.job_id);
  fbCfg.quota_routing.mode = 'suggest';
  writeJsonAtomic(path.join(fallbackDir, 'routing.json'), fbCfg);

  // Set claude/default back to 15% ok, and make claude/work fail with rate_limit
  saveQuotaSnapshots(env.paths, [
    {
      agent: 'claude',
      account: 'default',
      checked_at: new Date().toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 15, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
    {
      agent: 'claude',
      account: 'work',
      checked_at: new Date().toISOString(),
      login: 'ok',
      windows: [{ id: '5h', used_percent: 50, resets_at: resetFuture, source: 'provider' }],
      level: 'ok',
      cooldown_until: null,
      last_error: null,
    },
  ]);

  fs.writeFileSync(
    path.join(env.paths.jobsDir, `${secondJobId}.log`),
    'Error: 429 Too Many Requests\r\n=== [JOB_FINISHED exit_code=1] ===\r\n',
    'utf8'
  );

  await tick(makeCtx());

  // In suggest mode, no third job is started automatically; conversation has pending_limit_handoff
  assert.equal(startedJobs.length, 2);
  const getRes1 = (await callRoute(chatFeature.routes!.chat_get!.handler, 'GET', {}, {
    conversation_id: convId,
  })) as {
    ok: boolean;
    conversation: { account?: string; pending_limit_handoff?: { to: { agent: string; account: string } } | null };
    messages: Array<{ kind?: string; state?: string }>;
  };
  assert.ok(getRes1.conversation.pending_limit_handoff);
  assert.deepEqual(getRes1.conversation.pending_limit_handoff?.to, {
    agent: 'claude',
    account: 'default',
  });
  const pendingMsg = getRes1.messages.find((m) => m.kind === 'limit_handoff' && m.state === 'pending');
  assert.ok(pendingMsg, 'suggest mode must append a pending limit_handoff system message');

  // Accept the suggested handoff via POST chat_limit_handoff
  const acceptRes = (await callRoute(chatFeature.routes!.chat_limit_handoff!.handler, 'POST', {
    conversation_id: convId,
  })) as { ok: boolean; conversation: { account?: string; pending_limit_handoff?: unknown } };
  assert.equal(acceptRes.ok, true);
  assert.equal(acceptRes.conversation.account, 'default');
  assert.equal(acceptRes.conversation.pending_limit_handoff, null);
  assert.equal(startedJobs.length, 3, 'accepting pending limit handoff must re-run the failed turn');
  assert.equal(startedJobs[2]!.account, 'default');
});

test('S7.6 — HTTP API integration & buildCommandSpec account flag', async (t) => {
  const env = makeS7TestEnv();
  t.after(() => env.cleanup());

  // 1. buildCommandSpec only appends -Account when non-default
  const cmdOmitted = buildValidatedCommand(
    {
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      project_path: env.projectDir,
      prompt: 'hello',
    },
    env.paths
  );
  assert.equal(cmdOmitted.account, undefined);
  assert.ok(!cmdOmitted.command.includes('-Account'));

  const cmdDefault = buildValidatedCommand(
    {
      mode: 'task',
      agent: 'claude',
      account: 'default',
      role: 'backend',
      project_path: env.projectDir,
      prompt: 'hello',
    },
    env.paths
  );
  assert.equal(cmdDefault.account, 'default');
  assert.ok(!cmdDefault.command.includes('-Account'));

  const cmdWork = buildValidatedCommand(
    {
      mode: 'task',
      agent: 'claude',
      account: 'work',
      role: 'backend',
      project_path: env.projectDir,
      prompt: 'hello',
    },
    env.paths
  );
  assert.equal(cmdWork.account, 'work');
  assert.ok(cmdWork.command.includes("-Account 'work'"));

  // 2. HTTP server integration test for account_* and quota_* endpoints
  const { server } = createMawHttpServer({
    repoRoot: env.paths.repoRoot,
    userProfile: env.paths.userProfile,
    mawHome: env.paths.mawHome,
    tempDir: env.paths.tempDir,
    projectsRoot: env.paths.projectsRoot,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());

  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const apiCall = async (
    action: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
  ): Promise<{ status: number; data: Record<string, unknown> }> => {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/api?action=${action}`);
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        url,
        {
          method,
          headers: {
            Host: `127.0.0.1:${addr.port}`,
            Origin: `http://127.0.0.1:${addr.port}`,
            'X-MAW-Request': '1',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  // POST account_save
  const saveResp = await apiCall('account_save', 'POST', {
    account: {
      agent: 'claude',
      id: 'backup',
      label: 'Claude Backup',
      enabled: true,
      priority: 3,
      limits: { tokens_5h: 200_000 },
    },
  });
  assert.equal(saveResp.status, 200);
  assert.equal(saveResp.data.ok, true);
  const savedBackupDir = (saveResp.data.account as { dir: string }).dir;
  fs.writeFileSync(path.join(savedBackupDir, '.credentials.json'), '{"claudeAiOauth":{}}', 'utf8');

  // GET account_list
  const listResp = await apiCall('account_list', 'GET');
  assert.equal(listResp.status, 200);
  assert.equal(listResp.data.ok, true);
  const accounts = listResp.data.accounts as Array<{ agent: string; id: string }>;
  assert.ok(accounts.some((a) => a.agent === 'claude' && a.id === 'backup'));

  // POST quota_refresh
  const refreshResp = await apiCall('quota_refresh', 'POST', {
    agent: 'claude',
    account: 'backup',
  });
  assert.equal(refreshResp.status, 200);
  assert.equal(refreshResp.data.ok, true);

  // GET quota_get
  const getResp = await apiCall('quota_get&agent=claude&account=backup', 'GET');
  assert.equal(getResp.status, 200);
  assert.equal(getResp.data.ok, true);
  assert.ok(Array.isArray(getResp.data.snapshots));
  assert.equal((getResp.data.snapshots as Array<unknown>).length, 1);

  // GET quota_route_preview
  const previewResp = await apiCall(
    'quota_route_preview&agent=claude&role=backend&account=backup',
    'GET'
  );
  assert.equal(previewResp.status, 200);
  assert.equal(previewResp.data.ok, true);
  const decision = previewResp.data.decision as { chosen: { agent: string; account: string } };
  assert.deepEqual(decision.chosen, { agent: 'claude', account: 'backup' });

  // POST account_delete on 'default' must return 400
  const delDefResp = await apiCall('account_delete', 'POST', {
    agent: 'claude',
    id: 'default',
  });
  assert.equal(delDefResp.status, 400);

  // GET status includes feature_data.quota summary
  const statusResp = await apiCall('status', 'GET');
  assert.equal(statusResp.status, 200);
  const featData = statusResp.data.feature_data as Record<string, Record<string, unknown>>;
  assert.ok(featData?.quota, 'status.feature_data.quota must be present');
  assert.equal(typeof featData.quota.accounts, 'number');
  assert.ok(featData.quota.by_agent && typeof featData.quota.by_agent === 'object');
});
