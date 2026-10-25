import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext } from '../../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import { handleDoctorReport, handleHealthCheck, handleLoginPoll } from './actions.ts';
import { classifyLog } from './patterns.ts';
import {
  invalidateHealthCache,
  probeAgent,
  probeAllAgents,
  readHealthCacheOnly,
  redactSecrets,
  type HealthAgentResult,
} from './probes.ts';

function createTempTestPaths(): { paths: ServerPaths; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maw_health_test_'));
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
        // Ignore cleanup failure
      }
    },
  };
}

test('classifyLog detects auth and rate limit patterns correctly', () => {
  // Claude
  assert.equal(classifyLog('claude', 'Error: OAuth session has expired. Please run /login'), 'needs_login');
  assert.equal(classifyLog('claude', 'authentication_error: invalid API key'), 'needs_login');
  assert.equal(classifyLog('claude', 'HTTP 429 Too Many Requests: rate limit exceeded'), 'rate_limited');

  // Codex
  assert.equal(classifyLog('codex', 'Not logged in. Please run `codex login`'), 'needs_login');
  assert.equal(classifyLog('codex', 'Error: token expired, refresh token invalid'), 'needs_login');
  assert.equal(classifyLog('codex', 'Model is overloaded, HTTP 529 retry later'), 'rate_limited');

  // Gemini
  assert.equal(classifyLog('gemini', 'Please set an Auth method in settings.json'), 'needs_login');
  assert.equal(classifyLog('gemini', 'Error: GEMINI_API_KEY is not set'), 'needs_login');

  // Fallback
  assert.equal(classifyLog('custom', 'HTTP 401 Unauthorized'), 'needs_login');
  assert.equal(classifyLog('custom', 'Usage limit reached for today'), 'rate_limited');

  // Normal log
  assert.equal(classifyLog('claude', 'Compiling TypeScript project... Done in 2.3s'), null);
});

test('redactSecrets removes emails, tokens, and user profile paths', () => {
  const userProfile = 'C:\\Users\\SecretUser';
  const input = `Error for test.user@example.com at C:\\Users\\SecretUser\\.maw\\key using bot123456789:ABCDefGhIjKlMnOpQrStUvWxYz with sk-ant-api03-abcdefghijklmnopqrstuvwxyz`;
  const sanitized = redactSecrets(input, userProfile);

  assert.ok(!sanitized.includes('test.user@example.com'), 'Email should be redacted');
  assert.ok(sanitized.includes('[redacted-email]'), 'Email placeholder should be present');
  assert.ok(!sanitized.includes('C:\\Users\\SecretUser'), 'User profile path should be replaced with ~');
  assert.ok(sanitized.includes('~\\.maw\\key'), 'Tilde path expected');
  assert.ok(!sanitized.includes('ABCDefGhIjKlMnOpQrStUvWxYz'), 'Telegram bot token should be redacted');
  assert.ok(!sanitized.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), 'API key should be redacted');
  assert.ok(sanitized.length <= 200, 'Sanitized text should be <= 200 chars');
});

test('health_check returns valid results, caches responses, and builds team_rows', async () => {
  const { paths, cleanup } = createTempTestPaths();
  invalidateHealthCache();

  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // Initial health_check
    const req1 = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=health_check'),
      query: new URLSearchParams('agents=codex,claude'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res1 = (await handleHealthCheck(ctx, req1)) as {
      ok: boolean;
      agents: Array<any>;
      cached: boolean;
      summary: { ok: number; warn: number; error: number };
    };

    assert.equal(res1.ok, true);
    assert.equal(res1.agents.length, 2);
    assert.equal(res1.cached, false);

    // Second call should hit the in-memory cache
    const req2 = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=health_check'),
      query: new URLSearchParams('agents=codex,claude'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res2 = (await handleHealthCheck(ctx, req2)) as {
      ok: boolean;
      agents: Array<any>;
      cached: boolean;
    };
    assert.equal(res2.ok, true);
    assert.equal(res2.cached, true);

    // Call with team JSON
    const teamJson = JSON.stringify({
      backend: { agent: 'codex', model: 'gpt-5-custom' },
      frontend: 'claude',
    });
    const req3 = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=health_check'),
      query: new URLSearchParams({ agents: 'codex,claude', team: teamJson }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res3 = (await handleHealthCheck(ctx, req3)) as {
      ok: boolean;
      team_rows: Array<{
        role: string;
        agent: string;
        model: string;
        model_source: string;
        status: string;
      }>;
    };

    assert.equal(res3.ok, true);
    assert.ok(Array.isArray(res3.team_rows));
    assert.equal(res3.team_rows.length, 2);

    const backendRow = res3.team_rows.find((r) => r.role === 'backend');
    assert.ok(backendRow);
    assert.equal(backendRow.agent, 'codex');
    assert.equal(backendRow.model, 'gpt-5-custom');
    assert.equal(backendRow.model_source, 'override');

    // readHealthCacheOnly should read from cache without probing
    const cacheOnly = readHealthCacheOnly(paths);
    assert.ok(cacheOnly.agents.codex);
    assert.ok(cacheOnly.agents.claude);
  } finally {
    cleanup();
  }
});

test('doctor_report returns environment, scripts, hooks, and notify status', async () => {
  const { paths, cleanup } = createTempTestPaths();
  invalidateHealthCache();

  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const req = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=doctor_report'),
      query: new URLSearchParams(''),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res = (await handleDoctorReport(ctx, req)) as {
      ok: boolean;
      platforms: Array<any>;
      environment: { node: string; git: string | null };
      scripts: { required: Array<{ name: string; present: boolean }> };
      hooks: Record<string, string[]>;
      notify: { desktop_toast: boolean; webhook: boolean; telegram: boolean };
    };

    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.platforms));
    assert.ok(res.environment.node.startsWith('v'));
    assert.ok(Array.isArray(res.scripts.required));
    assert.equal(typeof res.notify.desktop_toast, 'boolean');
  } finally {
    cleanup();
  }
});

test('login_poll validates pid and returns process running status', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // Current process is running
    const reqRunning = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=login_poll'),
      query: new URLSearchParams(`pid=${process.pid}`),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const resRunning = (await handleLoginPoll(ctx, reqRunning)) as { ok: boolean; running: boolean };
    assert.equal(resRunning.ok, true);
    assert.equal(resRunning.running, true);

    // Dead PID
    const reqDead = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=login_poll'),
      query: new URLSearchParams('pid=99999999'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const resDead = (await handleLoginPoll(ctx, reqDead)) as { ok: boolean; running: boolean };
    assert.equal(resDead.ok, true);
    assert.equal(resDead.running, false);
  } finally {
    cleanup();
  }
});

test('Health Minor 17 regression: patterns regex tightness for gemini 401 and quota', () => {
  // Gemini 401 without auth word must NOT match
  assert.equal(classifyLog('gemini', 'Processed 401 items in 3 seconds'), null);
  assert.equal(classifyLog('gemini', 'Line 401: console.log("debug")'), null);

  // Gemini 401 with auth word MUST match
  assert.equal(classifyLog('gemini', 'Error 401: unauthorized request to API'), 'needs_login');
  assert.equal(classifyLog('gemini', 'HTTP 401 invalid credential'), 'needs_login');

  // Bare quota must NOT match rate limit
  assert.equal(classifyLog('claude', 'Checking local disk quota... OK'), null);
  assert.equal(classifyLog('claude', 'User has high quota limit'), null);

  // Exceeded quota MUST match rate limit
  assert.equal(classifyLog('claude', 'API error: quota exceeded for model'), 'rate_limited');
  assert.equal(classifyLog('claude', 'You have exceeded your current quota'), 'rate_limited');
});

test('Health Minor 18 & 19 regression: doctor_report fallback login_cmd and team_rows fix', async () => {
  const { paths, cleanup } = createTempTestPaths();
  invalidateHealthCache();

  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // 1. Doctor report cursor fallback
    const reqDoc = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=doctor_report'),
      query: new URLSearchParams(''),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const docRes = (await handleDoctorReport(ctx, reqDoc)) as any;
    const cursorPlatform = docRes.platforms.find((p: any) => p.id === 'cursor');
    if (cursorPlatform) {
      assert.equal(cursorPlatform.login_cmd, 'cursor-agent login');
    }

    // 2. Health check team_rows includes fix
    const reqHealth = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=health_check'),
      query: new URLSearchParams({
        team: JSON.stringify({ backend: 'claude', reviewer: 'codex' }),
      }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const healthRes = (await handleHealthCheck(ctx, reqHealth)) as any;
    assert.ok(Array.isArray(healthRes.team_rows));
    for (const row of healthRes.team_rows) {
      assert.ok('fix' in row, `Row ${row.agent} must have 'fix' property`);
    }
  } finally {
    cleanup();
  }
});

test('Health Round 2 items 4 & 5: Antigravity model is null unless real model, and uninstalled agent reports login n/a with fix.kind install', async () => {
  const { paths, cleanup } = createTempTestPaths();
  invalidateHealthCache();

  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const req = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=health_check'),
      query: new URLSearchParams('agents=antigravity,cursor,aider'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res = (await handleHealthCheck(ctx, req)) as {
      ok: boolean;
      agents: Array<HealthAgentResult>;
    };
    assert.equal(res.ok, true);

    // Antigravity model must be null (not hub-2.26.0)
    const agy = res.agents.find((a) => a.id === 'antigravity');
    assert.ok(agy);
    assert.equal(agy.model, null);
    assert.equal(agy.model_source, 'unknown');

    // Uninstalled agent (e.g. cursor / aider in temp test env) must report login: 'n/a', status: 'error', fix.kind: 'install'
    const cursor = res.agents.find((a) => a.id === 'cursor');
    assert.ok(cursor);
    assert.equal(cursor.installed, false);
    assert.equal(cursor.login, 'n/a');
    assert.equal(cursor.status, 'error');
    assert.ok(cursor.fix);
    assert.equal(cursor.fix.kind, 'install');

    const aider = res.agents.find((a) => a.id === 'aider');
    assert.ok(aider);
    assert.equal(aider.installed, false);
    assert.equal(aider.login, 'n/a');
    assert.equal(aider.status, 'error');
    assert.ok(aider.fix);
    assert.equal(aider.fix.kind, 'install');
  } finally {
    cleanup();
  }
});
