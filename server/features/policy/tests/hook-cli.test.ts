import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
  fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
  fs.mkdirSync(paths.jobsDir, { recursive: true });

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

test('regression Item 4: hook-cli before-agent blocks on global project cap when no project override exists', async () => {
  const { paths, tmp, cleanup } = createTempEnv();
  try {
    const projectDir = path.win32.join(tmp, 'my_proj');
    fs.mkdirSync(projectDir, { recursive: true });

    const budgetDir = paths.featureDataDir('budget');
    fs.mkdirSync(budgetDir, { recursive: true });

    // Global project cap = $1.00 block, no project overrides
    writeJsonAtomic(path.win32.join(budgetDir, 'budgets.json'), {
      version: 1,
      enabled: true,
      caps: {
        project: { usd: { warn: 0.5, block: 1.0 }, period: 'month' },
      },
      projects: {},
    });

    // Add audit entry for projectDir with $1.50
    const auditFile = paths.auditFile;
    const auditRow = {
      Timestamp: new Date().toISOString(),
      Tool: 'claude',
      Role: 'backend',
      Model: 'claude-3-5-sonnet',
      WorkDir: projectDir,
      PromptChars: 100,
      CostUsd: 1.5,
    };
    fs.writeFileSync(auditFile, JSON.stringify(auditRow) + '\n', 'utf8');

    const res = await runHookCli(
      'before-agent',
      JSON.stringify({ agent: 'claude', role: 'backend', workdir: projectDir }),
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );

    assert.equal(res.exitCode, 0);
    assert.equal(res.parsed.block, true);
    assert.ok(res.parsed.reason.includes('Budget project exceeded'));
    assert.ok(res.parsed.reason.includes('[S4:budget agent=claude fallback=none]'));
  } finally {
    cleanup();
  }
});

test('regression Item 8: hook-cli before-review fails closed on invalid checks.json and runtime errors', async () => {
  const { paths, tmp, cleanup } = createTempEnv();
  try {
    const projectDir = path.win32.join(tmp, 'check_proj');
    const mawDir = path.win32.join(projectDir, '.maw');
    fs.mkdirSync(mawDir, { recursive: true });

    // 1. Invalid checks config (checks is not an array)
    const invalidConfig = { version: 1, checks: 'not-array' };
    const configFile = path.win32.join(mawDir, 'checks.json');
    fs.writeFileSync(configFile, JSON.stringify(invalidConfig), 'utf8');

    // Trust it
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(invalidConfig)).digest('hex');
    const trustedFile = path.win32.join(paths.featureDataDir('checks'), 'trusted.json');
    writeJsonAtomic(trustedFile, { [projectDir.toLowerCase()]: sha256 });

    const resInvalid = await runHookCli(
      'before-review',
      JSON.stringify({ project: projectDir }),
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );

    assert.equal(resInvalid.exitCode, 0);
    assert.equal(resInvalid.parsed.block, true, 'must block when checks.json is invalid');
    assert.ok(resInvalid.parsed.reason.includes('Invalid .maw/checks.json: checks [S4:gate]'));

    // 2. Fatal error / exception in before-review fails closed
    const resFatal = await runHookCli(
      'before-review',
      'malformed json input',
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );
    assert.equal(resFatal.exitCode, 0);
    assert.equal(resFatal.parsed.block, true, 'must fail-closed on error for before-review');
    assert.ok(resFatal.parsed.reason.includes('Test gate error:'));
    assert.ok(resFatal.parsed.reason.includes('[S4:gate]'));
  } finally {
    cleanup();
  }
});

test('regression Item 10: hook-cli before-agent atomic single-use approval claim prevents double consumption', async () => {
  const { paths, tmp, cleanup } = createTempEnv();
  try {
    const policyDir = paths.featureDataDir('policy');
    fs.mkdirSync(policyDir, { recursive: true });

    const promptText = 'Please run: rm -rf /some/dir';
    const promptSha256 = crypto
      .createHash('sha256')
      .update(`${promptText}:backend`, 'utf8')
      .digest('hex');

    const aprId = 'apr_single_use_test';
    const approvals = [
      {
        id: aprId,
        job_id: 'job_1',
        role: 'backend',
        agent: 'claude',
        project: tmp,
        command: 'rm -rf',
        prompt_sha256: promptSha256,
        created_at: new Date().toISOString(),
        status: 'approved',
      },
    ];
    writeJsonAtomic(path.win32.join(policyDir, 'approvals.json'), approvals);

    // Prompt file for job_1
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_1.prompt.txt'), promptText, 'utf8');

    // 1. First execution claims the approval
    const res1 = await runHookCli(
      'before-agent',
      JSON.stringify({ agent: 'claude', role: 'backend', workdir: tmp, job_id: 'job_1' }),
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );
    assert.equal(res1.exitCode, 0);
    assert.equal(res1.parsed.block, false, 'first run should claim approval and allow');

    // Claim file should now exist
    const claimFile = path.win32.join(policyDir, 'approval-claims', aprId);
    assert.ok(fs.existsSync(claimFile), 'claim lock file must be created');

    // 2. Second execution with identical prompt/approval cannot claim again (already claimed!)
    fs.writeFileSync(path.win32.join(paths.jobsDir, 'job_2.prompt.txt'), promptText, 'utf8');
    const res2 = await runHookCli(
      'before-agent',
      JSON.stringify({ agent: 'claude', role: 'backend', workdir: tmp, job_id: 'job_2' }),
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );
    assert.equal(res2.exitCode, 0);
    assert.equal(res2.parsed.block, true, 'second run must block as approval is already claimed');
    assert.ok(res2.parsed.reason.includes('Approval needed:'));
  } finally {
    cleanup();
  }
});

test('regression Item 12: hook-cli job-start retries recovery.json lookup when job is new', async () => {
  const { paths, tmp, cleanup } = createTempEnv();
  try {
    const fallbackDir = paths.featureDataDir('fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });

    // Write recovery.json with root_job_id
    writeJsonAtomic(path.win32.join(fallbackDir, 'recovery.json'), {
      items: [{ new_job_id: 'job_retry_test', root_job_id: 'root_job_abc' }],
    });

    const res = await runHookCli(
      'job-start',
      JSON.stringify({ job_id: 'job_retry_test', started_ts: Date.now() }),
      { MAW_HOME: paths.mawHome, USERPROFILE: paths.userProfile }
    );

    assert.equal(res.exitCode, 0);
    assert.equal(res.parsed.block, false);
    assert.equal(res.parsed.env?.MAW_TEAM_RUN_ID, 'root_job_abc');
  } finally {
    cleanup();
  }
});
