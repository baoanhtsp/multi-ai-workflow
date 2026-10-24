import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { feature as steerFeature } from './index.ts';
import { launchSteerJob } from './launch.ts';
import {
  loadSteerData,
  runQueueProcessor,
  saveSteerData,
} from './queue.ts';
import {
  buildResumeCommand,
  buildSummaryPrompt,
  parseSessionRefFromLog,
} from './sessions.ts';

test('steer: session-ref parsing per platform from fixture logs', () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_steer_log_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const userDir = path.win32.join(tmpRoot, 'user');
  const mawDir = path.win32.join(tmpRoot, 'maw');
  const projDir = path.win32.join(tmpRoot, 'proj');

  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(mawDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  const paths = resolveServerPaths({
    mawHome: mawDir,
    userProfile: userDir,
    projectsRoot: projDir,
  });

  // 1. Antigravity fixture log
  const agyCid = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const agyLog =
    `=== [MISSION CONTROL JOB job_20261025_010000_111111] ===\n` +
    `Mode: TASK | Agent: antigravity | Role: backend\n` +
    `Output line 1\n` +
    `conversation: 00000000-0000-0000-0000-000000000000\n` +
    `CONVERSATION_ID: ${agyCid}\n` +
    `=== [JOB_FINISHED exit_code=0] ===\n`;

  // Without brain item created -> exists: false
  const agyRefNoExist = parseSessionRefFromLog(agyLog, 'antigravity', 'C:\\proj', paths);
  assert.ok(agyRefNoExist);
  assert.equal(agyRefNoExist.platform, 'antigravity');
  assert.equal(agyRefNoExist.id, agyCid);
  assert.equal(agyRefNoExist.exists, false);

  // With brain item created -> exists: true
  const brainDir = paths.brainDir;
  fs.mkdirSync(path.win32.join(brainDir, agyCid), { recursive: true });
  const agyRefExist = parseSessionRefFromLog(agyLog, 'antigravity', 'C:\\proj', paths);
  assert.equal(agyRefExist?.exists, true);

  // 2. Claude fixture log
  const claudeSid = 'c1c2c3c4-c5c6-7c8c-9c0c-1c2c3c4c5c6c';
  const claudeLog =
    `Claude Code output...\n` +
    `{"type":"init","session_id":"${claudeSid}"}\n` +
    `More logs...\n`;

  const projPath = 'C:\\projects\\my-app';
  const claudeRefNoExist = parseSessionRefFromLog(claudeLog, 'claude', projPath, paths);
  assert.ok(claudeRefNoExist);
  assert.equal(claudeRefNoExist.platform, 'claude');
  assert.equal(claudeRefNoExist.id, claudeSid);
  assert.equal(claudeRefNoExist.exists, false);

  // Create claude project session file
  const normCwd = projPath.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeSessionDir = path.win32.join(paths.userProfile, '.claude', 'projects', normCwd);
  fs.mkdirSync(claudeSessionDir, { recursive: true });
  fs.writeFileSync(path.win32.join(claudeSessionDir, `${claudeSid}.jsonl`), '{}\n');

  const claudeRefExist = parseSessionRefFromLog(claudeLog, 'claude', projPath, paths);
  assert.equal(claudeRefExist?.exists, true);

  // 3. Codex fixture log
  const codexTid = 'th_abcdef123456';
  const codexLog =
    `Codex CLI starting...\n` +
    `{"thread_id": "${codexTid}"}\n` +
    `Running codex...\n`;

  const codexRefNoExist = parseSessionRefFromLog(codexLog, 'codex', projPath, paths);
  assert.ok(codexRefNoExist);
  assert.equal(codexRefNoExist.platform, 'codex');
  assert.equal(codexRefNoExist.id, codexTid);
  assert.equal(codexRefNoExist.exists, false);

  // Create codex session file
  const codexSessionsDir = path.win32.join(paths.userProfile, '.codex', 'sessions', 'sub');
  fs.mkdirSync(codexSessionsDir, { recursive: true });
  fs.writeFileSync(path.win32.join(codexSessionsDir, `session_${codexTid}.json`), '{}\n');

  const codexRefExist = parseSessionRefFromLog(codexLog, 'codex', projPath, paths);
  assert.equal(codexRefExist?.exists, true);

  // 4. Other registry agent
  const otherLog = `Other AI init: "session_id": "sid_xyz789"\n`;
  const fakeAgentEntry: any = {
    id: 'gemini',
    resume_args: ['--resume', '{session_id}'],
  };
  const otherRef = parseSessionRefFromLog(otherLog, 'gemini', projPath, paths, fakeAgentEntry);
  assert.ok(otherRef);
  assert.equal(otherRef.platform, 'gemini');
  assert.equal(otherRef.id, 'sid_xyz789');
  assert.equal(otherRef.exists, true);

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('steer: resume commands construction and summary prompt format/limits', () => {
  // Claude resume command
  const claudeCmd = buildResumeCommand({
    platform: 'claude',
    sessionId: 'session-123',
    model: 'sonnet',
    effort: 'high',
  });
  assert.ok(claudeCmd);
  assert.equal(claudeCmd.exe, 'claude');
  assert.ok(claudeCmd.args.includes('--resume'));
  assert.ok(claudeCmd.args.includes('session-123'));
  assert.ok(claudeCmd.args.includes('--model'));
  assert.ok(claudeCmd.args.includes('sonnet'));
  assert.ok(claudeCmd.args.includes('--effort'));
  assert.ok(claudeCmd.args.includes('high'));

  // Codex resume command
  const codexCmd = buildResumeCommand({
    platform: 'codex',
    sessionId: 'th-456',
    model: 'gpt-6-sol',
  });
  assert.ok(codexCmd);
  assert.equal(codexCmd.exe, 'codex');
  assert.ok(codexCmd.args.includes('exec'));
  assert.ok(codexCmd.args.includes('resume'));
  assert.ok(codexCmd.args.includes('th-456'));
  assert.ok(codexCmd.args.includes('-'));

  // Antigravity resume command
  const agyCmd = buildResumeCommand({
    platform: 'antigravity',
    sessionId: 'session-agy-789',
    projectPath: 'C:\\proj',
  });
  assert.ok(agyCmd);
  assert.equal(agyCmd.exe, 'powershell.exe');
  assert.ok(agyCmd.args.includes('-Action'));
  assert.ok(agyCmd.args.includes('send'));
  assert.ok(agyCmd.args.includes('-ConversationId'));
  assert.ok(agyCmd.args.includes('session-agy-789'));
  assert.ok(agyCmd.args.includes('-PromptFile'));
  assert.ok(agyCmd.args.includes('{prompt_file}'));

  // Summary prompt format
  const rawLog =
    `=== [MISSION CONTROL JOB job_20261025_000000_123456] ===\n` +
    `Mode: TASK | Agent: claude | Role: backend | Project: C:\\proj\n` +
    `Started: 2026-10-25 00:00:00\n` +
    `------------------------------------------------------------\n` +
    `I completed task step 1.\n` +
    `All tests are passing.\n` +
    `=== [JOB_FINISHED exit_code=0] ===\n`;

  const summary = buildSummaryPrompt({
    jobId: 'job_20261025_000000_123456',
    agent: 'claude',
    role: 'backend',
    projectPath: 'C:\\proj',
    originalPrompt: 'Build the review feature',
    logTail: rawLog,
    message: 'Now add tests for review feature',
  });

  assert.ok(summary.includes('You are continuing an earlier job (job_20261025_000000_123456, agent claude, role backend) in C:\\proj.'));
  assert.ok(summary.includes('Original task (may be cut):'));
  assert.ok(summary.includes('Build the review feature'));
  assert.ok(summary.includes('End of the previous output (may be cut):'));
  assert.ok(summary.includes('I completed task step 1.'));
  // Runner header & JOB_FINISHED marker stripped
  assert.ok(!summary.includes('=== [MISSION CONTROL JOB'));
  assert.ok(!summary.includes('=== [JOB_FINISHED'));
  assert.ok(summary.includes('New instruction from the user:'));
  assert.ok(summary.includes('Now add tests for review feature'));
  assert.ok(summary.length <= 20000);
});

test('steer: strategy selection, steer jobs creation, queue merge and cancel', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_steer_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'steer-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  // Create fake running claude job
  const runningClaudeJobId = 'job_20261025_030000_111111';
  const runningClaudeMeta = {
    job_id: runningClaudeJobId,
    pid: process.pid,
    mode: 'task',
    agent: 'claude',
    role: 'backend',
    model: 'sonnet',
    project_path: projectDir,
    command: 'fake-command',
    status: 'RUNNING',
    exit_code: null,
    started_at: new Date().toISOString(),
    started_ts: Math.floor(Date.now() / 1000),
  };

  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningClaudeJobId}.json`),
    JSON.stringify(runningClaudeMeta),
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningClaudeJobId}.log`),
    'Starting claude...\n',
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningClaudeJobId}.prompt.txt`),
    'Original task for claude\n',
    'utf8'
  );

  // Create fake running antigravity job with CID
  const agyCid = 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e';
  const runningAgyJobId = 'job_20261025_030000_222222';
  const runningAgyMeta = {
    job_id: runningAgyJobId,
    pid: process.pid,
    mode: 'task',
    agent: 'antigravity',
    role: 'backend',
    project_path: projectDir,
    command: 'fake-command',
    status: 'RUNNING',
    exit_code: null,
    started_at: new Date().toISOString(),
    started_ts: Math.floor(Date.now() / 1000),
  };

  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningAgyJobId}.json`),
    JSON.stringify(runningAgyMeta),
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningAgyJobId}.log`),
    `CONVERSATION_ID: ${agyCid}\nWorking...\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${runningAgyJobId}.prompt.txt`),
    'Original task for antigravity\n',
    'utf8'
  );
  // Mark brain cid exists
  fs.mkdirSync(path.win32.join(paths.brainDir, agyCid), { recursive: true });

  const fakeRegistry: any = {
    agents: [
      { id: 'claude', label: 'Claude Code', enabled: true },
      { id: 'antigravity', label: 'Antigravity', enabled: true },
    ],
  };

  let startedJobs: any[] = [];
  const fakeCtx = {
    paths,
    registry: fakeRegistry,
    readJobs: async () => [runningClaudeMeta, runningAgyMeta],
    startJob: async (body: any) => {
      const childId = `job_20261025_040000_${Math.random().toString(16).slice(2, 8)}`;
      startedJobs.push({ job_id: childId, ...body });
      return { ok: true, job_id: childId };
    },
  };

  // 1. GET steer_info on running Claude -> recommended: queue
  const claudeInfoRes = (await steerFeature.routes.steer_info.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=steer_info&job_id=${runningClaudeJobId}`),
      query: new URLSearchParams({ job_id: runningClaudeJobId }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(claudeInfoRes.ok, true);
  assert.equal(claudeInfoRes.strategies.live, false);
  assert.equal(claudeInfoRes.strategies.queue, true);
  assert.equal(claudeInfoRes.recommended, 'queue');

  // 2. GET steer_info on running Antigravity -> recommended: live
  const agyInfoRes = (await steerFeature.routes.steer_info.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=steer_info&job_id=${runningAgyJobId}`),
      query: new URLSearchParams({ job_id: runningAgyJobId }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(agyInfoRes.ok, true);
  assert.equal(agyInfoRes.strategies.live, true);
  assert.equal(agyInfoRes.recommended, 'live');

  // 3. POST steer_send on running Claude (strategy auto -> queue)
  const sendRes1 = (await steerFeature.routes.steer_send.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=steer_send'),
      query: new URLSearchParams(),
      body: {
        job_id: runningClaudeJobId,
        message: 'First queued message',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(sendRes1.ok, true);
  assert.equal(sendRes1.entry.strategy, 'queue');
  assert.equal(sendRes1.entry.status, 'queued');

  // Send a second message
  const sendRes2 = (await steerFeature.routes.steer_send.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=steer_send'),
      query: new URLSearchParams(),
      body: {
        job_id: runningClaudeJobId,
        message: 'Second queued message',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(sendRes2.ok, true);
  assert.equal(sendRes2.entry.status, 'queued');

  // Send a third message and then cancel it
  const sendRes3 = (await steerFeature.routes.steer_send.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=steer_send'),
      query: new URLSearchParams(),
      body: {
        job_id: runningClaudeJobId,
        message: 'Third queued message to cancel',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  const cancelRes = (await steerFeature.routes.steer_cancel.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=steer_cancel'),
      query: new URLSearchParams(),
      body: {
        job_id: runningClaudeJobId,
        entry_id: sendRes3.entry.id,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(cancelRes.ok, true);
  const dataAfterCancel = loadSteerData(runningClaudeJobId, paths);
  const cancelledEntry = dataAfterCancel.entries.find((e) => e.id === sendRes3.entry.id);
  assert.equal(cancelledEntry?.status, 'cancelled');

  // 4. Mark runningClaudeJob as finished
  fs.appendFileSync(
    path.win32.join(paths.jobsDir, `${runningClaudeJobId}.log`),
    '=== [JOB_FINISHED exit_code=0] ===\n'
  );

  // Run queue processor -> merges queued entries 1 & 2 into one summary turn
  await runQueueProcessor(fakeCtx as any);

  const dataAfterProcess = loadSteerData(runningClaudeJobId, paths);
  const entry1 = dataAfterProcess.entries.find((e) => e.id === sendRes1.entry.id);
  const entry2 = dataAfterProcess.entries.find((e) => e.id === sendRes2.entry.id);
  assert.equal(entry1?.status, 'started');
  assert.equal(entry2?.status, 'started');
  assert.ok(entry1?.child_job_id);
  assert.equal(entry1?.child_job_id, entry2?.child_job_id);

  assert.equal(startedJobs.length, 1);
  assert.ok(startedJobs[0].prompt.includes('First queued message'));
  assert.ok(startedJobs[0].prompt.includes('Second queued message'));

  // 5. Steer job creation unit test via launchSteerJob
  // Dry run / fake launcher
  let launchedRunnerFile = '';
  const steerJobRes = await launchSteerJob({
    parentJobId: runningClaudeJobId,
    agent: 'claude',
    role: 'backend',
    projectPath: projectDir,
    prompt: 'Do step 2',
    commandExe: 'claude',
    commandArgs: ['-p', '--resume', 'session-123'],
    paths,
    registry: fakeRegistry,
    strategy: 'resume',
    skipAgentDetection: true,
    customLauncher: async (rf) => {
      launchedRunnerFile = rf;
      return 12345;
    },
  });

  assert.ok(steerJobRes.job_id.startsWith('job_'));
  assert.equal(steerJobRes.pid, 12345);
  assert.equal(steerJobRes.meta.mode, 'steer');
  assert.equal(steerJobRes.meta.parent_job_id, runningClaudeJobId);

  // Check generated files
  const generatedMetaFile = path.win32.join(paths.jobsDir, `${steerJobRes.job_id}.json`);
  const generatedRunnerFile = path.win32.join(paths.jobsDir, `${steerJobRes.job_id}.runner.ps1`);
  const generatedPromptFile = path.win32.join(paths.jobsDir, `${steerJobRes.job_id}.prompt.txt`);
  assert.ok(fs.existsSync(generatedMetaFile));
  assert.ok(fs.existsSync(generatedRunnerFile));
  assert.ok(fs.existsSync(generatedPromptFile));

  const runnerCode = fs.readFileSync(generatedRunnerFile, 'utf8');
  assert.ok(runnerCode.includes('=== [JOB_FINISHED exit_code=$code] ==='));
  assert.ok(runnerCode.includes('Get-Content -Raw -Encoding UTF8'));

  // 6. status() check
  const steerStatus = (await steerFeature.status!(fakeCtx as any)) as any;
  assert.ok(steerStatus.jobs[runningClaudeJobId]);
  assert.equal(steerStatus.jobs[runningClaudeJobId].queued, 0);

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('steer: steer_send failure preserves entry with status failed in steerData', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_steer_fail_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'fail-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  const parentJobId = 'job_20261025_050000_333333';
  const finishedMeta = {
    job_id: parentJobId,
    pid: 999999,
    mode: 'task',
    agent: 'claude',
    role: 'backend',
    project_path: projectDir,
    command: 'fake-command',
    status: 'DONE',
    exit_code: 0,
    started_at: new Date().toISOString(),
    started_ts: Math.floor(Date.now() / 1000),
  };

  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${parentJobId}.json`),
    JSON.stringify(finishedMeta),
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${parentJobId}.log`),
    'Log without session\n=== [JOB_FINISHED exit_code=0] ===\n',
    'utf8'
  );

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [finishedMeta],
    startJob: async () => {
      throw new Error('Disk full or spawn failed');
    },
  };

  // steer_send with summary strategy should attempt startJob, fail, save failed entry, and rethrow
  await assert.rejects(
    async () => {
      await steerFeature.routes.steer_send.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL('http://127.0.0.1/api?action=steer_send'),
          query: new URLSearchParams(),
          body: {
            job_id: parentJobId,
            strategy: 'summary',
            message: 'Retry please',
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof Error && err.message === 'Disk full or spawn failed'
  );

  const dataAfterFailure = loadSteerData(parentJobId, paths);
  assert.equal(dataAfterFailure.entries.length, 1);
  assert.equal(dataAfterFailure.entries[0]!.status, 'failed');
  assert.ok(dataAfterFailure.entries[0]!.error?.includes('Disk full or spawn failed'));

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('steer: queue processor maps legacy roles and modes to valid task roles', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_steer_legacy_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'legacy-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  const parentJobId = 'job_20261025_060000_444444';
  const legacyMeta = {
    job_id: parentJobId,
    pid: 999999,
    mode: 'council',
    agent: 'unknown-agent',
    role: 'review-diff', // legacy role
    project_path: projectDir,
    command: 'fake-command',
    status: 'DONE',
    exit_code: 0,
    started_at: new Date().toISOString(),
    started_ts: Math.floor(Date.now() / 1000),
  };

  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${parentJobId}.json`),
    JSON.stringify(legacyMeta),
    'utf8'
  );
  fs.writeFileSync(
    path.win32.join(paths.jobsDir, `${parentJobId}.log`),
    'Output\n=== [JOB_FINISHED exit_code=0] ===\n',
    'utf8'
  );

  // Enqueue a steer item
  const steerData = {
    job_id: parentJobId,
    root_job_id: parentJobId,
    entries: [
      {
        id: 'entry_test_legacy',
        ts: new Date().toISOString(),
        strategy: 'queue' as const,
        status: 'queued' as const,
        message: 'Do next',
      },
    ],
  };
  saveSteerData(steerData, paths);

  let launchedJob: any = null;
  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [legacyMeta],
    startJob: async (body: any) => {
      launchedJob = body;
      return { ok: true, job_id: 'job_child_123' };
    },
  };

  await runQueueProcessor(fakeCtx as any);

  assert.ok(launchedJob);
  // council mode mapped to claude
  assert.equal(launchedJob.agent, 'claude');
  // review-diff legacy role mapped to backend
  assert.equal(launchedJob.role, 'backend');
  assert.equal(launchedJob.mode, 'task');

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
