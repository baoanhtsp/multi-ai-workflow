import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { feature as chatFeature } from '../../chat/index.ts';
import { tick } from '../../chat/tick.ts';
import { BUILTIN_FULL_TEMPLATE } from '../../teams/defaults.ts';
import { feature as teamsFeature } from '../../teams/index.ts';
import { feature } from '../index.ts';

function setupHandoffTestContext() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maw space handoffs test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'handoff-app');
  fs.mkdirSync(testProj, { recursive: true });

  const paths = resolveServerPaths({
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

  baseCtx.startJob = async (body: Record<string, unknown>) => {
    const jobId = 'job_' + crypto.randomBytes(4).toString('hex');
    const meta: Record<string, unknown> = {
      job_id: jobId,
      pid: 99999,
      mode: body.mode || 'task',
      agent: body.agent || 'codex',
      role: body.role || 'backend',
      status: nextJobStatus,
      exit_code: nextJobStatus === 'DONE' ? 0 : 1,
      started_at: new Date().toISOString(),
      started_ts: Date.now(),
      project_path: body.project_path || testProj,
    };
    if (nextWorktree) {
      meta.worktree = nextWorktree;
      meta.branch = 'feature/branch';
    }
    fs.writeFileSync(path.win32.join(paths.jobsDir, `${jobId}.json`), JSON.stringify(meta), 'utf8');

    const log = `
--------------------------------------------------
[Connected] Model: test-model
${nextReply}
[Completed | Tokens: 250 in / 100 out | Cost: $0.0080]
=== [JOB_FINISHED exit_code=${meta.exit_code}] ===
`;
    fs.writeFileSync(path.win32.join(paths.jobsDir, `${jobId}.log`), log, 'utf8');

    return {
      ok: true,
      job_id: jobId,
      status: 'RUNNING',
      pid: 99999,
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
