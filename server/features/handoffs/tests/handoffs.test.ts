import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { runCommand } from '../../../lib/proc.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { feature as agentsFeature } from '../../agents-ws/index.ts';
import { getBaseCommit, getNonIsolatedChangedFiles, getWorktreeChangedFiles } from '../../agents-ws/lib/git.ts';
import { feature as chatFeature } from '../../chat/index.ts';
import { setWorktreeFeatureCheckerForTest, tick } from '../../chat/tick.ts';
import { BUILTIN_FULL_TEMPLATE } from '../../teams/defaults.ts';
import { feature as teamsFeature } from '../../teams/index.ts';
import { feature } from '../index.ts';

// The real temp dir, captured before any test points TEMP at its own folder.
const ORIG_TMP = os.tmpdir();

function setupHandoffTestContext() {
  const tempBase = fs.mkdtempSync(path.join(ORIG_TMP, 'maw space handoffs test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'handoff-app');
  fs.mkdirSync(testProj, { recursive: true });

  // Isolate from the real machine: user profile (~/.codex) and TEMP (maw_jobs).
  const tempUserProfile = path.join(tempBase, 'profile');
  fs.mkdirSync(tempUserProfile, { recursive: true });
  process.env.TEMP = tempBase;
  process.env.TMP = tempBase;
  const paths = resolveServerPaths({
    userProfile: tempUserProfile,
    repoRoot: process.cwd(),
    projectsRoot: tempProjectsRoot,
    mawHome: tempMawHome,
  });

  if (!fs.existsSync(paths.jobsDir)) {
    fs.mkdirSync(paths.jobsDir, { recursive: true });
  }

  const baseCtx = createFeatureContext(paths);

  let nextReply = 'Default reply';
  let nextJobStatus = 'DONE';
  let nextWorktree = '';
  let nextExitCode: number | null = null;

  baseCtx.startJob = async (body: Record<string, unknown>) => {
    const jobId = 'job_' + crypto.randomBytes(4).toString('hex');
    const computedExitCode = nextExitCode !== null ? nextExitCode : (nextJobStatus === 'DONE' ? 0 : 1);
    const meta: Record<string, unknown> = {
      job_id: jobId,
      pid: process.pid,
      mode: body.mode || 'task',
      agent: body.agent || 'codex',
      role: body.role || 'backend',
      status: nextJobStatus,
      exit_code: nextJobStatus === 'RUNNING' ? null : computedExitCode,
      started_at: new Date().toISOString(),
      started_ts: Date.now(),
      project_path: body.project_path || testProj,
    };
    if (nextWorktree) {
      meta.worktree = nextWorktree;
      meta.branch = 'feature/branch';
    }
    fs.writeFileSync(path.win32.join(paths.jobsDir, `${jobId}.json`), JSON.stringify(meta), 'utf8');

    const log =
      nextJobStatus === 'RUNNING'
        ? `[Connected] Model: test-model\r\nJob is still actively running...\r\n`
        : `
--------------------------------------------------
[Connected] Model: test-model
${nextReply}
[Completed | Tokens: 250 in / 100 out | Cost: $0.0080]
=== [JOB_FINISHED exit_code=${computedExitCode}] ===
`;
    fs.writeFileSync(path.win32.join(paths.jobsDir, `${jobId}.log`), log, 'utf8');

    return {
      ok: true,
      job_id: jobId,
      status: 'RUNNING',
      pid: process.pid,
    };
  };

  const makeReq = (body: Record<string, unknown> = {}, queryParams: Record<string, string> = {}): MawFeatureRequest => {
    const url = new URL('http://127.0.0.1/api');
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
    return {
      ...baseCtx,
      url,
      query: url.searchParams,
      body,
      req: {} as any,
      res: {} as any,
      ctx: baseCtx,
    };
  };

  return {
    tempBase,
    paths,
    baseCtx,
    makeReq,
    testProj,
    setNextReply: (r: string) => {
      nextReply = r;
    },
    setNextJobStatus: (s: string) => {
      nextJobStatus = s;
    },
    setNextWorktree: (w: string) => {
      nextWorktree = w;
    },
    setNextExitCode: (c: number | null) => {
      nextExitCode = c;
    },
  };
}

test('handoffs: Lead dispatch -> records -> member jobs -> results -> Lead message -> auto continue', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  // 1. Setup full team in project
  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  assert.ok(leadAgent);

  // 2. Create chat conversation for Lead
  const createConvReq = makeReq({ agent_id: leadAgent.id, title: 'Lead Coordinator' });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // 3. Lead turn dispatches a task to worker via fenced ```handoff block
  setNextReply(`
I have broken down the work. Delegating to worker:

\`\`\`handoff
{
  "handoffs": [
    {
      "to": "worker",
      "task": "Implement database migrations for S6",
      "acceptance": "Migrations run clean"
    }
  ]
}
\`\`\`
`);

  await chatFeature.routes['chat_send']!.handler(
    makeReq({ conversation_id: leadConvId, text: 'Please start sprint planning.' }),
    makeReq()
  );

  // 4. Tick finalizes Lead turn -> parses handoff block -> creates handoff record in "started" -> dispatches member job!
  // Configure member reply before tick
  setNextReply(`
Finished database migration.
\`\`\`json
{
  "status": "completed",
  "summary": "Applied migration 001_s6_tables.sql",
  "files_changed": ["migrations/001.sql"],
  "evidence": "2 tables created",
  "blockers": [],
  "cost": 0.005,
  "decisions": ["Used UUID for primary keys"]
}
\`\`\`
`);

  await tick(baseCtx); // finalizes Lead turn, parses block, dispatches worker job
  await tick(baseCtx); // finalizes worker job, appends handoff message, queues auto-continue!

  // 5. Verify handoff list and counts
  const listReq = makeReq({}, { team_id: applyRes.team.id });
  const listRes = (await feature.routes['handoff_list']!.handler(listReq, listReq)) as any;
  assert.equal(listRes.ok, true);
  assert.equal(listRes.handoffs.length, 1);
  const handoffRecord = listRes.handoffs[0];
  assert.equal(handoffRecord.status, 'completed');
  assert.equal(handoffRecord.to_role, 'worker');
  assert.equal(handoffRecord.result.summary, 'Applied migration 001_s6_tables.sql');
  assert.equal(listRes.counts.completed, 1);

  // 6. Verify Lead conversation received handoff message and auto-continue message
  const getLeadReq = makeReq({}, { conversation_id: leadConvId });
  const getLeadRes = (await chatFeature.routes['chat_get']!.handler(getLeadReq, getLeadReq)) as any;
  assert.ok(getLeadRes.messages.some((m: any) => m.role === 'handoff' && m.text.includes('completed')));
  // Auto-continue was queued and processed
  const hasAutoContinue =
    getLeadRes.messages.some(
      (m: any) => m.text.includes('Member Handoff Results') && m.text.includes('Continue the plan')
    ) ||
    getLeadRes.conversation.queue.some(
      (q: any) => q.text.includes('Member Handoff Results') && q.text.includes('Continue the plan')
    );
  assert.ok(hasAutoContinue, 'Lead received auto-continue prompt');

  // Item 4: Verify Member conversation recorded user task message and assistant reply message
  assert.ok(handoffRecord.member_conversation_id);
  const getMemberReq = makeReq({}, { conversation_id: handoffRecord.member_conversation_id });
  const getMemberRes = (await chatFeature.routes['chat_get']!.handler(getMemberReq, getMemberReq)) as any;
  assert.equal(getMemberRes.ok, true);
  assert.equal(getMemberRes.messages.length, 2);
  const memberTaskMsg = getMemberRes.messages[0];
  assert.equal(memberTaskMsg.role, 'user');
  assert.equal(memberTaskMsg.system_generated, true);
  assert.ok(memberTaskMsg.text.includes('Implement database migrations'));
  const memberReplyMsg = getMemberRes.messages[1];
  assert.equal(memberReplyMsg.role, 'assistant');
  assert.equal(memberReplyMsg.status, 'done');
  assert.ok(memberReplyMsg.text.includes('Applied migration 001_s6_tables.sql'));

  // 7. Verify decision was added to project memory (.maw/memory/decisions.md)
  const memFile = path.win32.join(testProj, '.maw', 'memory', 'decisions.md');
  assert.ok(fs.existsSync(memFile));
  const memContent = fs.readFileSync(memFile, 'utf8');
  assert.ok(memContent.includes('Used UUID for primary keys'));
});

test('handoffs: Invalid json block results in needs_review, retry and accept', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Manual dispatch
  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Complex algorithm',
  });

  // Member finishes with broken json
  setNextReply('Finished the task, but forgot JSON block.');
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  assert.equal(dispRes.ok, true);
  const handoffId = dispRes.handoff.id;

  await tick(baseCtx); // member job finishes with missing json

  const listReq = makeReq({}, { team_id: applyRes.team.id });
  const listRes = (await feature.routes['handoff_list']!.handler(listReq, listReq)) as any;
  const targetHandoff = listRes.handoffs.find((h: any) => h.id === handoffId);
  assert.equal(targetHandoff.status, 'needs_review');
  assert.ok(targetHandoff.parse_error.includes('Missing fenced ```json'));

  // Accept user override
  const acceptReq = makeReq({ id: handoffId, note: 'Approved manually by tech lead' });
  const acceptRes = (await feature.routes['handoff_accept']!.handler(acceptReq, acceptReq)) as any;
  assert.equal(acceptRes.ok, true);
  assert.equal(acceptRes.handoff.status, 'completed');

  // Retry
  const retryReq = makeReq({ id: handoffId });
  const retryRes = (await feature.routes['handoff_retry']!.handler(retryReq, retryReq)) as any;
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.handoff.attempts, 1);
  assert.equal(retryRes.handoff.status, 'started');
});

test('handoffs: [finalize] cancel and accept append Lead message', async () => {
  const { makeReq, testProj, baseCtx } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Dispatch handoff
  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Task to be cancelled',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  assert.equal(dispRes.ok, true);
  const handoffId = dispRes.handoff.id;

  // Cancel handoff
  const cancelReq = makeReq({ id: handoffId });
  const cancelRes = (await feature.routes['handoff_cancel']!.handler(cancelReq, cancelReq)) as any;
  assert.equal(cancelRes.ok, true);

  // Verify Lead conversation received [Handoff ...] cancelled message
  const getLeadReq = makeReq({}, { conversation_id: leadConvId });
  const getLeadRes = (await chatFeature.routes['chat_get']!.handler(getLeadReq, getLeadReq)) as any;
  const cancelHandoffMsg = getLeadRes.messages.find(
    (m: any) => m.role === 'handoff' && m.handoff_id === handoffId && m.text.includes('cancelled')
  );
  assert.ok(cancelHandoffMsg, 'Lead conversation contains cancelled handoff message');
});

test('handoffs: [antigravity sessions] member jobs pass new_session: true for antigravity platform', async () => {
  const { makeReq, testProj, baseCtx } = setupHandoffTestContext();

  // Create team with member whose platform is antigravity
  const teamWithAg = {
    ...BUILTIN_FULL_TEMPLATE.team,
    roles: BUILTIN_FULL_TEMPLATE.team.roles.map((r) =>
      r.key === 'worker' ? { ...r, override: { platform: 'antigravity' } } : r
    ),
  };

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: teamWithAg,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  let capturedNewSession: boolean | undefined = undefined;
  const originalStartJob = baseCtx.startJob;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    if (body.agent === 'antigravity') {
      capturedNewSession = Boolean(body.new_session);
    }
    return originalStartJob(body);
  };

  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Task on antigravity',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  assert.equal(dispRes.ok, true);

  // Dispatch happened via tick in handoff_dispatch
  assert.equal(capturedNewSession, true, 'Antigravity platform member job passed new_session: true');
});

test('handoffs: [Item 1] batch with all start failures gets distinct seq numbers and auto-continue survives tick', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Lead turn delegates to two roles that do not exist in the team (start failures)
  setNextReply(`
Dispatching batch with roles that do not exist:
\`\`\`handoff
{
  "handoffs": [
    { "to": "ghost_role_1", "task": "Ghost task 1" },
    { "to": "ghost_role_2", "task": "Ghost task 2" }
  ]
}
\`\`\`
`);

  await chatFeature.routes['chat_send']!.handler(
    makeReq({ conversation_id: leadConvId, text: 'Dispatch ghost batch' }),
    makeReq()
  );

  // Configure response for the subsequent auto-continue turn so it does not re-dispatch
  setNextReply('Acknowledged all member start failures.');

  // Tick 1: Lead turn completes, parses block -> creates 2 handoffs with status 'started'
  // and in step 3 tries to dispatch both -> neither member agent exists -> both finalize as 'failed'
  // because inMemoryConvsData and inMemoryHandoffsData are passed, both get distinct seq numbers
  // and allBatchTerminal triggers auto_continue queue item which survives the tick write!
  await tick(baseCtx);

  const getLeadReq = makeReq({}, { conversation_id: leadConvId });
  const getLeadRes = (await chatFeature.routes['chat_get']!.handler(getLeadReq, getLeadReq)) as any;

  const handoffMsgs = getLeadRes.messages.filter((m: any) => m.role === 'handoff');
  assert.equal(handoffMsgs.length, 2, 'Two [Handoff] messages recorded in Lead conversation');
  assert.equal(handoffMsgs[0].status, 'failed');
  assert.equal(handoffMsgs[1].status, 'failed');
  assert.notEqual(handoffMsgs[0].seq, handoffMsgs[1].seq, 'Seq numbers must be distinct');
  assert.equal(handoffMsgs[1].seq, handoffMsgs[0].seq + 1, 'Seq numbers must be consecutive');

  // Verify auto-continue queue item survived the tick
  const hasAutoContinue =
    getLeadRes.messages.some(
      (m: any) => m.text.includes('Member Handoff Results') && m.text.includes('Continue the plan')
    ) ||
    getLeadRes.conversation.queue.some(
      (q: any) => q.text.includes('Member Handoff Results') && q.text.includes('Continue the plan')
    );
  assert.ok(hasAutoContinue, 'Auto-continue queue item survived tick without being overwritten');
});

test('handoffs: [Item 2] member resolution falls back to live agent with same workdir and team_role when team IDs changed', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  const workerAgent = applyRes.agents.find((a: any) => a.team_role === 'worker');
  assert.ok(leadAgent);
  assert.ok(workerAgent);

  // Simulate an import that changed team.id and cleared role.agent_id on disk
  const teamFile = path.win32.join(testProj, '.maw', 'team.json');
  const teamOnDisk = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  teamOnDisk.id = 'tm_imported_different_id';
  for (const r of teamOnDisk.roles) {
    r.agent_id = '';
  }
  fs.writeFileSync(teamFile, JSON.stringify(teamOnDisk, null, 2), 'utf8');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  setNextReply(`
\`\`\`json
{
  "status": "completed",
  "summary": "Worker resolved by workdir + team_role successfully",
  "files_changed": [],
  "evidence": "OK",
  "blockers": [],
  "cost": 0.001,
  "decisions": []
}
\`\`\`
`);

  // Dispatch handoff to 'worker'
  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Do task with imported team',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  assert.equal(dispRes.ok, true);
  const handoffId = dispRes.handoff.id;

  // Tick processes member job
  await tick(baseCtx);

  const listReq = makeReq({}, { team_id: teamOnDisk.id });
  const listRes = (await feature.routes['handoff_list']!.handler(listReq, listReq)) as any;
  const targetHandoff = listRes.handoffs.find((h: any) => h.id === handoffId);
  assert.ok(targetHandoff);
  // Member resolution successfully linked to workerAgent.id via workdir + team_role fallback
  assert.equal(targetHandoff.to, workerAgent.id);
  assert.equal(targetHandoff.status, 'completed');
  assert.ok(targetHandoff.result.summary.includes('Worker resolved by workdir'));
});

test('handoffs: [Item 2] write-scope changed files reports two commits and untracked file in temp git repo', async () => {
  const tempRepo = fs.mkdtempSync(path.join(ORIG_TMP, 'maw git test repo '));
  try {
    // 1. Initialize git repo and make base commit
    await runCommand('git.exe', ['-C', tempRepo, 'init'], { timeoutMs: 5000 });
    await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.name', 'Tester'], { timeoutMs: 5000 });
    await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.email', 'test@example.com'], { timeoutMs: 5000 });

    fs.writeFileSync(path.join(tempRepo, 'init.txt'), 'initial commit\n', 'utf8');
    await runCommand('git.exe', ['-C', tempRepo, 'add', 'init.txt'], { timeoutMs: 5000 });
    await runCommand('git.exe', ['-C', tempRepo, 'commit', '-m', 'initial'], { timeoutMs: 5000 });

    const baseCommit = await getBaseCommit(tempRepo);
    assert.ok(baseCommit, 'Base commit must be resolved from git rev-parse HEAD');

    // 2. Make commit 1
    fs.writeFileSync(path.join(tempRepo, 'c1.txt'), 'commit 1\n', 'utf8');
    await runCommand('git.exe', ['-C', tempRepo, 'add', 'c1.txt'], { timeoutMs: 5000 });
    await runCommand('git.exe', ['-C', tempRepo, 'commit', '-m', 'c1'], { timeoutMs: 5000 });

    // 3. Make commit 2
    fs.writeFileSync(path.join(tempRepo, 'c2.txt'), 'commit 2\n', 'utf8');
    await runCommand('git.exe', ['-C', tempRepo, 'add', 'c2.txt'], { timeoutMs: 5000 });
    await runCommand('git.exe', ['-C', tempRepo, 'commit', '-m', 'c2'], { timeoutMs: 5000 });

    // 4. Leave an untracked file
    fs.writeFileSync(path.join(tempRepo, 'untracked.txt'), 'untracked content\n', 'utf8');

    // 5. Query changed files
    const res = await getWorktreeChangedFiles(tempRepo, baseCommit);
    assert.equal(res.ok, true, 'getWorktreeChangedFiles should succeed');
    assert.ok(res.files.includes('c1.txt'), 'c1.txt should be in changed files');
    assert.ok(res.files.includes('c2.txt'), 'c2.txt should be in changed files');
    assert.ok(res.files.includes('untracked.txt'), 'untracked.txt should be in changed files');

    // 6. Test error path for invalid folder
    const errRes = await getWorktreeChangedFiles('C:\\non_existent_maw_dir_12345');
    assert.equal(errRes.ok, false);
    assert.equal(errRes.error, 'could not list changed files');
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('handoffs: [Item 4] terminal handoffs 409 guards and idempotent Lead notification', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // 1. Dispatch handoff with invalid block -> reaches needs_review
  setNextReply('Invalid json text here');
  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Needs review task',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  await tick(baseCtx);

  const getHandoffsReq = makeReq({}, { team_id: applyRes.team.id });
  const listRes1 = (await feature.routes['handoff_list']!.handler(getHandoffsReq, getHandoffsReq)) as any;
  const h1 = listRes1.handoffs.find((h: any) => h.id === handoffId);
  assert.equal(h1.status, 'needs_review');

  // 2. Accept handoff once -> 200 OK
  const acceptReq1 = makeReq({ id: handoffId, note: 'Approved manually' });
  const acceptRes1 = (await feature.routes['handoff_accept']!.handler(acceptReq1, acceptReq1)) as any;
  assert.equal(acceptRes1.ok, true);
  assert.equal(acceptRes1.handoff.status, 'completed');

  // 3. Accept second time -> 409
  await assert.rejects(
    async () => {
      const acceptReq2 = makeReq({ id: handoffId, note: 'Approved again' });
      await feature.routes['handoff_accept']!.handler(acceptReq2, acceptReq2);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409
  );

  // 4. Cancel a completed handoff -> 409
  await assert.rejects(
    async () => {
      const cancelReq = makeReq({ id: handoffId });
      await feature.routes['handoff_cancel']!.handler(cancelReq, cancelReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409
  );

  // 5. Verify exactly ONE Lead message was appended for this terminal handoff
  const getLeadReq = makeReq({}, { conversation_id: leadConvId });
  const getLeadRes = (await chatFeature.routes['chat_get']!.handler(getLeadReq, getLeadReq)) as any;
  const matchingLeadMsgs = getLeadRes.messages.filter((m: any) => m.handoff_id === handoffId);
  assert.equal(matchingLeadMsgs.length, 1, 'Exactly one Lead message per terminal handoff');
});

test('handoffs: [Item 2] handoff_cancel preserves running tracking on cancel failure', async () => {
  const { makeReq, testProj, baseCtx, setNextJobStatus, paths } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  setNextJobStatus('RUNNING');
  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Will be cancelled with error',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  // Tick starts the member job -> reaches status running
  await tick(baseCtx);

  const listRes = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const hRunning = listRes.handoffs.find((h: any) => h.id === handoffId);
  assert.equal(hRunning.status, 'running');
  assert.ok(hRunning.job_id);

  // Delete the job meta file to make handleCancelJob throw 404
  const metaFile = path.win32.join(paths.jobsDir, `${hRunning.job_id}.json`);
  fs.unlinkSync(metaFile);

  // handoff_cancel should throw 404 and NOT finalize as cancelled!
  await assert.rejects(
    async () => {
      await feature.routes['handoff_cancel']!.handler(makeReq({ id: handoffId }), makeReq());
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 404
  );

  const listResAfter = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const hAfter = listResAfter.handoffs.find((h: any) => h.id === handoffId);
  assert.equal(hAfter.status, 'running', 'Handoff must remain in running status when cancel fails');
});

test('handoffs: [Item 3] non-isolated handoff in git repo triggers write-scope violation for read-only role', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  // 1. Initialize git repo in testProj
  await runCommand('git.exe', ['-C', testProj, 'init'], { timeoutMs: 5000 });
  await runCommand('git.exe', ['-C', testProj, 'config', 'user.name', 'Tester'], { timeoutMs: 5000 });
  await runCommand('git.exe', ['-C', testProj, 'config', 'user.email', 'test@example.com'], { timeoutMs: 5000 });

  fs.writeFileSync(path.join(testProj, 'README.md'), '# Mission\n', 'utf8');
  await runCommand('git.exe', ['-C', testProj, 'add', 'README.md'], { timeoutMs: 5000 });
  await runCommand('git.exe', ['-C', testProj, 'commit', '-m', 'Initial commit'], { timeoutMs: 5000 });

  // 2. Save team where 'worker' role has write_scope: [] (read-only role, no write allowed)
  // and shared.isolate is false (non-isolated)
  const readOnlyTeam = {
    ...BUILTIN_FULL_TEMPLATE.team,
    shared: {
      ...BUILTIN_FULL_TEMPLATE.team.shared,
      isolate: false,
    },
    roles: BUILTIN_FULL_TEMPLATE.team.roles.map((r) =>
      r.key === 'worker' ? { ...r, override: { write_scope: [] } } : r
    ),
  };

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: readOnlyTeam,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  setNextReply(`
\`\`\`json
{
  "status": "completed",
  "summary": "Created unauthorized file in non-isolated mode",
  "files_changed": ["unauthorized_new_file.txt"],
  "evidence": "echo done > unauthorized_new_file.txt",
  "blockers": [],
  "cost": 0.002,
  "decisions": []
}
\`\`\`
`);

  // Write that file into testProj so git also detects it
  fs.writeFileSync(path.join(testProj, 'unauthorized_new_file.txt'), 'illegal content\n', 'utf8');

  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Do non-isolated work',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  // Tick 1: starts job, records base_commit + dirty_baseline
  await tick(baseCtx);

  // Tick 2: completes job, evaluates write scope against non-isolated changes
  await tick(baseCtx);

  const listRes = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const h = listRes.handoffs.find((item: any) => item.id === handoffId);
  assert.ok(h);
  assert.equal(h.isolated, false, 'Must record isolated: false');
  assert.equal(h.status, 'needs_review', 'Read-only role creating a file must be marked needs_review');
  assert.ok(
    h.scope_violations.includes('unauthorized_new_file.txt'),
    'Violation list must include the created file'
  );
});

test('handoffs: [Item 1] isolation decided before starting members: absence of worktrees feature enforces effective max_parallel = 1', async () => {
  const { makeReq, testProj, baseCtx, setNextJobStatus } = setupHandoffTestContext();

  // Save and apply team with max_parallel = 3 and isolate = true
  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
        max_parallel: 3,
        isolate: true,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;

  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  setNextJobStatus('RUNNING');

  // Intercept ctx.startJob to capture whether isolate was true/false
  let capturedIsolate: boolean | undefined;
  const origStartJob = baseCtx.startJob;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    capturedIsolate = body.isolate as boolean;
    return origStartJob(body);
  };

  try {
    // Inject worktrees feature as absent (e.g. S1 worktrees feature not present)
    setWorktreeFeatureCheckerForTest(() => false);

    // Dispatch 2 handoffs to worker
    const dispReq1 = makeReq({
      lead_conversation_id: leadConvId,
      to: 'worker',
      task: 'Task 1',
    });
    const dispRes1 = (await feature.routes['handoff_dispatch']!.handler(dispReq1, dispReq1)) as any;
    const hId1 = dispRes1.handoff.id;

    const dispReq2 = makeReq({
      lead_conversation_id: leadConvId,
      to: 'worker',
      task: 'Task 2',
    });
    const dispRes2 = (await feature.routes['handoff_dispatch']!.handler(dispReq2, dispReq2)) as any;
    const hId2 = dispRes2.handoff.id;

    // Call tick: should keep 1 running and 1 started because effective max_parallel = 1!
    await tick(baseCtx);

    const listRes = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
    const h1 = listRes.handoffs.find((h: any) => h.id === hId1);
    const h2 = listRes.handoffs.find((h: any) => h.id === hId2);

    assert.equal(h1.status, 'running', 'First handoff should start running');
    assert.equal(h2.status, 'started', 'Second handoff must remain started because max_parallel = 1');
    assert.equal(capturedIsolate, false, 'startJob must receive isolate: false when worktree feature is absent');
  } finally {
    setWorktreeFeatureCheckerForTest(null);
  }
});

test('handoffs: [Item 2] FAILED job with completed json block becomes failed with parse_error', async () => {
  const { makeReq, testProj, baseCtx, setNextReply, setNextJobStatus, setNextExitCode } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;

  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Job log contains a completed json block, but the job status is FAILED with exit_code 42
  setNextReply(`
\`\`\`json
{
  "status": "completed",
  "summary": "Finished all work successfully",
  "files_changed": []
}
\`\`\`
`);
  setNextJobStatus('FAILED');
  setNextExitCode(42);

  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Execute task that crashes',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  // Tick 1: starts job
  await tick(baseCtx);

  // Tick 2: processes finished job
  await tick(baseCtx);

  const listRes2 = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const finalH = listRes2.handoffs.find((h: any) => h.id === handoffId);
  assert.equal(finalH.status, 'failed', 'FAILED job must never become completed');
  assert.equal(finalH.parse_error, 'job exited with code 42', 'parse_error must record job exit code');
  assert.equal(finalH.result?.summary, 'Finished all work successfully', 'parsed result is preserved for display');
});

test('handoffs: [Item 4] SPEC Guard error in isolated path marks handoff needs_review with parse_error', async () => {
  const { makeReq, testProj, baseCtx, setNextReply, setNextWorktree } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;

  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Create isolated temp worktree directory with valid git repo (so git status passes)
  const fakeWorktree = path.join(testProj, 'worktree-broken');
  fs.mkdirSync(fakeWorktree, { recursive: true });
  await runCommand('git.exe', ['-C', fakeWorktree, 'init']);
  await runCommand('git.exe', ['-C', fakeWorktree, 'config', 'user.name', 'Tester']);
  await runCommand('git.exe', ['-C', fakeWorktree, 'config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(fakeWorktree, 'dummy.txt'), 'hello\n');
  await runCommand('git.exe', ['-C', fakeWorktree, 'add', '.']);
  await runCommand('git.exe', ['-C', fakeWorktree, 'commit', '-m', 'Initial commit']);
  setNextWorktree(fakeWorktree);

  // Set scriptsDir to an empty directory so handleSpecGuard fails/throws invoke-spec-guard.ps1 not found
  const emptyScriptsDir = path.join(testProj, 'empty-scripts');
  fs.mkdirSync(emptyScriptsDir, { recursive: true });
  (baseCtx.paths as any).scriptsDir = emptyScriptsDir;

  setNextReply(`
\`\`\`json
{
  "status": "completed",
  "summary": "Completed isolated work",
  "files_changed": []
}
\`\`\`
`);

  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Isolated task with broken spec guard',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  // Tick 1: starts job
  await tick(baseCtx);
  // Tick 2: processes completion, calls spec guard on isolated worktree
  await tick(baseCtx);

  const listRes = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const h = listRes.handoffs.find((item: any) => item.id === handoffId);
  assert.ok(h);
  assert.equal(h.status, 'needs_review', 'Handoff must be needs_review when SPEC Guard fails');
  assert.ok(
    h.parse_error && h.parse_error.includes('SPEC Guard could not run'),
    `parse_error must indicate SPEC Guard failure, got: ${h.parse_error}`
  );
});

test('handoffs: [Item 1] parallel dispatch only with confirmed isolation; unconfirmed isolation runs one at a time', async () => {
  const { makeReq, testProj, baseCtx, setNextReply, setNextJobStatus, setNextWorktree } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
        max_parallel: 2,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Make sure worktrees feature is reported as available
  setWorktreeFeatureCheckerForTest(() => true);

  // Job 1 stays running without confirmed worktree
  setNextJobStatus('RUNNING');
  setNextWorktree('');

  // Dispatch handoff 1 (starts and becomes running)
  const dispReq1 = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Task 1',
  });
  const dispRes1 = (await feature.routes['handoff_dispatch']!.handler(dispReq1, dispReq1)) as any;

  // Dispatch handoff 2 while job 1 is running unconfirmed
  const dispReq2 = makeReq({
    lead_conversation_id: leadConvId,
    to: 'testing',
    task: 'Task 2',
  });
  const dispRes2 = (await feature.routes['handoff_dispatch']!.handler(dispReq2, dispReq2)) as any;

  const listRes1 = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const h1 = listRes1.handoffs.find((h: any) => h.id === dispRes1.handoff.id);
  const h2 = listRes1.handoffs.find((h: any) => h.id === dispRes2.handoff.id);

  assert.equal(h1.status, 'running', 'H1 must be running');
  assert.equal(h1.isolated, false, 'H1 must NOT be isolated since job meta had no worktree');
  assert.equal(h2.status, 'started', 'H2 must remain started while unconfirmed H1 is running');

  // Finish H1 by updating its job meta and log
  const jobMetaFile = path.win32.join(baseCtx.paths.jobsDir, `${h1.job_id}.json`);
  const jobLogFile = path.win32.join(baseCtx.paths.jobsDir, `${h1.job_id}.log`);
  fs.writeFileSync(jobMetaFile, JSON.stringify({ status: 'DONE', exit_code: 0 }), 'utf8');
  fs.writeFileSync(jobLogFile, `
--------------------------------------------------
[Connected] Model: test-model
\`\`\`json
{
  "status": "completed",
  "summary": "Finished H1",
  "files_changed": []
}
\`\`\`
[Completed | Tokens: 250 in / 100 out | Cost: $0.0080]
=== [JOB_FINISHED exit_code=0] ===
`, 'utf8');

  await tick(baseCtx); // H1 finishes, and H2 starts!

  const listRes2 = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const h1After = listRes2.handoffs.find((h: any) => h.id === dispRes1.handoff.id);
  const h2After = listRes2.handoffs.find((h: any) => h.id === dispRes2.handoff.id);
  assert.equal(h1After.status, 'completed');
  assert.equal(h2After.status, 'running', 'H2 now runs after H1 completes');
});

test('handoffs: [Item 2] write-scope checks fail closed: git baseline failure marks handoff needs_review with parse_error', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupHandoffTestContext();

  // Initialize git repo in testProj WITHOUT initial commit (rev-parse HEAD will fail)
  await runCommand('git.exe', ['-C', testProj, 'init']);
  await runCommand('git.exe', ['-C', testProj, 'config', 'user.name', 'Tester']);
  await runCommand('git.exe', ['-C', testProj, 'config', 'user.email', 'test@example.com']);

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  setNextReply(`
\`\`\`json
{
  "status": "completed",
  "summary": "Completed task",
  "files_changed": []
}
\`\`\`
`);

  const dispReq = makeReq({
    lead_conversation_id: leadConvId,
    to: 'worker',
    task: 'Task with baseline failure',
  });
  const dispRes = (await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq)) as any;
  const handoffId = dispRes.handoff.id;

  // Tick 1 was run inside dispatch. Run tick to process completion.
  await tick(baseCtx);

  const listRes = (await feature.routes['handoff_list']!.handler(makeReq({}, { team_id: applyRes.team.id }), makeReq())) as any;
  const h = listRes.handoffs.find((item: any) => item.id === handoffId);
  assert.ok(h);
  assert.equal(h.status, 'needs_review', 'Handoff must be needs_review when baseline error is flagged');
  assert.equal(h.parse_error, 'could not list changed files');
});

test('handoffs: [Item 2] non-isolated write-scope checks count files dirty at baseline that became clean as changed', async () => {
  const tempRepo = fs.mkdtempSync(path.join(ORIG_TMP, 'maw-dirty-clean-'));
  await runCommand('git.exe', ['-C', tempRepo, 'init']);
  await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.name', 'Tester']);
  await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(tempRepo, 'init.txt'), 'init\n');
  await runCommand('git.exe', ['-C', tempRepo, 'add', '.']);
  await runCommand('git.exe', ['-C', tempRepo, 'commit', '-m', 'init commit']);

  const baseCommit = await getBaseCommit(tempRepo);
  assert.ok(baseCommit);

  // Baseline has dirty file 'reverted.txt'
  const baseline = {
    'reverted.txt': 'hash_12345',
  };

  // Currently, reverted.txt is not dirty (clean / reverted to committed state or deleted)
  const changedRes = await getNonIsolatedChangedFiles(tempRepo, baseCommit, baseline);
  assert.equal(changedRes.ok, true);
  assert.ok(
    changedRes.files.includes('reverted.txt'),
    'Files dirty at baseline that became clean must be counted as changed'
  );
});

test('handoffs: [Item 4] handoff_dispatch rejects soft-deleted agent with 409', async () => {
  const { makeReq, testProj } = setupHandoffTestContext();

  const saveTeamReq = makeReq({
    project_path: testProj,
    team: {
      ...BUILTIN_FULL_TEMPLATE.team,
      shared: {
        ...BUILTIN_FULL_TEMPLATE.team.shared,
        workdir: testProj,
      },
    },
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  await teamsFeature.routes['team_save']!.handler(saveTeamReq, saveTeamReq);

  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await teamsFeature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  const leadAgent = applyRes.agents.find((a: any) => a.team_role === 'lead');
  const workerAgent = applyRes.agents.find((a: any) => a.team_role === 'worker');

  const createConvReq = makeReq({ agent_id: leadAgent.id });
  const createConvRes = (await chatFeature.routes['chat_create']!.handler(createConvReq, createConvReq)) as any;
  const leadConvId = createConvRes.conversation.id;

  // Soft-delete worker agent
  const delReq = makeReq({ id: workerAgent.id });
  await agentsFeature.routes['ws_agent_delete']!.handler(delReq, delReq);

  // Attempt dispatch to deleted agent
  await assert.rejects(
    async () => {
      const dispReq = makeReq({
        lead_conversation_id: leadConvId,
        to: workerAgent.id,
        task: 'Task for deleted agent',
      });
      await feature.routes['handoff_dispatch']!.handler(dispReq, dispReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409
  );
});



