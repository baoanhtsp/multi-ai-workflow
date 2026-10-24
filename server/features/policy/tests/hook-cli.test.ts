import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { writeJsonAtomic } from '../lib/s4-core.ts';

function createTempEnv() {
  const tmp = path.win32.join(os.tmpdir(), `maw_test_hookcli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
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

function runHookCli(
  event: string,
  stdinData: string,
  envOverride: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string; parsed: any }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, '..', 'hook-cli.ts');
    const child = spawn(process.execPath, [cliPath, event], {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...envOverride,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      let parsed: any = null;
      try {
        const line = stdout.trim().split(/\r?\n/).pop() || '';
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        parsed,
      });
    });

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

test('hook-cli: stdin/stdout contract and fail-open on invalid input', async () => {
  const { paths, cleanup } = createTempEnv();

  try {
    // 1. Invalid JSON on stdin -> exit 0, fail-open
    const resBad = await runHookCli('job-start', 'NOT_VALID_JSON', {
      MAW_HOME: paths.mawHome,
      USERPROFILE: paths.userProfile,
    });
    assert.equal(resBad.exitCode, 0, 'Exit code must always be 0');
    assert.ok(resBad.parsed !== null, 'Output should be valid JSON');
    assert.equal(resBad.parsed.block, false);
    assert.ok(resBad.parsed.lines.some((l: string) => l.includes('[S4] hook error')));

    // 2. job-start with valid context -> returns env vars
    const jobStartPayload = JSON.stringify({
      job_id: 'job_cli_123',
      mode: 'task',
      role: 'backend',
      project: paths.projectsRoot,
    });
    const resStart = await runHookCli('job-start', jobStartPayload, {
      MAW_HOME: paths.mawHome,
      USERPROFILE: paths.userProfile,
    });
    assert.equal(resStart.exitCode, 0);
    assert.equal(resStart.parsed.block, false);
    assert.ok(resStart.parsed.env !== undefined);
    assert.equal(resStart.parsed.env.MAW_JOB_ID, 'job_cli_123');
    assert.equal(resStart.parsed.env.MAW_JOB_MODE, 'task');
    assert.equal(resStart.parsed.env.MAW_TEAM_RUN_ID, 'job_cli_123');
  } finally {
    cleanup();
  }
});

test('hook-cli: before-agent blocks when budget cap or cooldown is exceeded', async () => {
  const { paths, cleanup } = createTempEnv();

  try {
    const budgetDir = paths.featureDataDir('budget');
    const fallbackDir = paths.featureDataDir('fallback');

    // 1. Configure day cap = $1.00
    const budgetCfg = {
      version: 1,
      enabled: true,
      caps: {
        day: { usd: { warn: 0.50, block: 1.00 } },
      },
      estimate_next_call: false,
    };
    writeJsonAtomic(path.win32.join(budgetDir, 'budgets.json'), budgetCfg);

    // Write audit rows with $1.50 spend today
    const auditFile = paths.auditFile;
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const auditRow = {
      Timestamp: new Date().toISOString(),
      Tool: 'claude',
      Agent: 'claude',
      Role: 'backend',
      Model: 'sonnet',
      WorkDir: paths.projectsRoot,
      PromptChars: 1000,
      InputTokens: 200,
      OutputTokens: 800,
      CostUsd: 1.50,
      Score: '',
      Verdict: '',
    };
    fs.writeFileSync(auditFile, JSON.stringify(auditRow) + '\n', 'utf8');

    const beforeAgentPayload = JSON.stringify({
      agent: 'claude',
      role: 'backend',
      workdir: paths.projectsRoot,
    });

    const resBudgetBlock = await runHookCli('before-agent', beforeAgentPayload, {
      MAW_HOME: paths.mawHome,
      USERPROFILE: paths.userProfile,
    });

    assert.equal(resBudgetBlock.exitCode, 0);
    assert.equal(resBudgetBlock.parsed.block, true);
    assert.ok(resBudgetBlock.parsed.reason.includes('Budget day exceeded'));
    assert.ok(resBudgetBlock.parsed.reason.includes('[S4:budget agent=claude fallback=none]'));

    // 2. Clear budget block, test cooldown block
    writeJsonAtomic(path.win32.join(budgetDir, 'budgets.json'), { version: 1, enabled: false, caps: {} });

    // Set cooldown on claude for 1 hour in future
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    writeJsonAtomic(path.win32.join(fallbackDir, 'cooldowns.json'), {
      claude: { until, reason: 'Rate limited' },
    });

    const resCooldownBlock = await runHookCli('before-agent', beforeAgentPayload, {
      MAW_HOME: paths.mawHome,
      USERPROFILE: paths.userProfile,
    });

    assert.equal(resCooldownBlock.exitCode, 0);
    assert.equal(resCooldownBlock.parsed.block, true);
    assert.ok(resCooldownBlock.parsed.reason.includes('is rate-limited until'));
    assert.ok(resCooldownBlock.parsed.reason.includes('[S4:cooldown agent=claude'));
  } finally {
    cleanup();
  }
});
