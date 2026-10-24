import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { feature as agentsFeature } from '../../agents-ws/index.ts';
import { feature } from '../index.ts';
import { tick } from '../tick.ts';

function setupChatTestContext() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maw space chat test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'chat-proj');
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

  // Inject fake startJob
  let nextReply = 'I am the AI assistant response.';
  let nextJobStatus = 'DONE';

  baseCtx.startJob = async (body: Record<string, unknown>) => {
    const jobId = 'job_' + crypto.randomBytes(4).toString('hex');
    const meta = {
      job_id: jobId,
      pid: 99999,
      mode: body.mode || 'task',
      agent: body.agent || 'claude',
      role: body.role || 'backend',
      status: nextJobStatus,
      exit_code: nextJobStatus === 'DONE' ? 0 : 1,
      started_at: new Date().toISOString(),
      started_ts: Date.now(),
      project_path: body.project_path || testProj,
    };
    fs.writeFileSync(path.win32.join(paths.jobsDir, `${jobId}.json`), JSON.stringify(meta), 'utf8');

    const log = `
--------------------------------------------------
[Connected] Model: test-model
${nextReply}
[Completed | Tokens: 100 in / 50 out | Cost: $0.0050]
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
  };
}

test('chat: Full turn lifecycle, tick processing, busy queue and stop', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupChatTestContext();

  // 1. Create agent
  const agReq = makeReq({
    agent: {
      name: 'Chat Bot',
      platform: 'claude',
      workdir: testProj,
      role: 'backend',
    },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const agentId = agRes.agent.id;

  // 2. Create conversation
  const convReq = makeReq({ agent_id: agentId, title: 'Test Conversation' });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  assert.equal(convRes.ok, true);
  const convId = convRes.conversation.id;

  // 3. Send message while idle -> starts turn job immediately
  setNextReply('Hello! Turn 1 finished.');
  const sendReq = makeReq({
    conversation_id: convId,
    text: 'Hello world message 1',
  });
  const sendRes = (await feature.routes['chat_send']!.handler(sendReq, sendReq)) as any;
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.queued, false);
  assert.ok(sendRes.job_id);

  // 4. Tick processes finished job -> appends assistant message
  await tick(baseCtx);

  const getReq = makeReq({}, { conversation_id: convId });
  const getRes = (await feature.routes['chat_get']!.handler(getReq, getReq)) as any;
  assert.equal(getRes.ok, true);
  assert.equal(getRes.messages.length, 2); // user message + assistant message
  assert.equal(getRes.messages[0].role, 'user');
  assert.equal(getRes.messages[1].role, 'assistant');
  assert.ok(getRes.messages[1].text.includes('Turn 1 finished'));
  assert.equal(getRes.conversation.active_job_id, '');
  assert.equal(getRes.conversation.cost_usd, 0.005);

  // 5. Send message and immediately send another -> second message gets queued
  // Fake a running job for the first message
  const sendReq1 = makeReq({ conversation_id: convId, text: 'First active turn' });
  await feature.routes['chat_send']!.handler(sendReq1, sendReq1);

  // While busy, second message is queued
  const sendReq2 = makeReq({ conversation_id: convId, text: 'Second queued turn' });
  const sendRes2 = (await feature.routes['chat_send']!.handler(sendReq2, sendReq2)) as any;
  assert.equal(sendRes2.ok, true);
  assert.equal(sendRes2.queued, true);
  assert.equal(sendRes2.queue_len, 1);

  // Tick finalizes first job, then automatically starts queued job
  setNextReply('Second queued turn finished.');
  await tick(baseCtx); // finalizes job 1, starts job 2
  await tick(baseCtx); // finalizes job 2

  const getReq2 = makeReq({}, { conversation_id: convId });
  const getRes2 = (await feature.routes['chat_get']!.handler(getReq2, getReq2)) as any;
  assert.equal(getRes2.conversation.queue.length, 0);
  assert.ok(getRes2.messages.some((m: any) => m.text.includes('Second queued turn finished')));

  // 6. Stop active turn
  const sendReqStop = makeReq({ conversation_id: convId, text: 'Turn to stop' });
  await feature.routes['chat_send']!.handler(sendReqStop, sendReqStop);

  const stopReq = makeReq({ conversation_id: convId });
  const stopRes = (await feature.routes['chat_stop']!.handler(stopReq, stopReq)) as any;
  assert.equal(stopRes.ok, true);
  assert.ok(stopRes.cancelled);

  const getReqStop = makeReq({}, { conversation_id: convId });
  const getResStop = (await feature.routes['chat_get']!.handler(getReqStop, getReqStop)) as any;
  assert.equal(getResStop.conversation.active_job_id, '');
  assert.equal(getResStop.messages[getResStop.messages.length - 1].status, 'cancelled');
});

test('chat: Platform switch creates system message and seeds summary', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'Polyglot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const agentId = agRes.agent.id;

  const convReq = makeReq({ agent_id: agentId });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // Turn 1 on Claude
  setNextReply('Response on Claude');
  const send1 = makeReq({ conversation_id: convId, text: 'Hello Claude' });
  await feature.routes['chat_send']!.handler(send1, send1);
  await tick(baseCtx);

  // Turn 2: switch to Codex
  setNextReply('Response on Codex');
  const send2 = makeReq({ conversation_id: convId, text: 'Hello Codex', platform: 'codex' });
  await feature.routes['chat_send']!.handler(send2, send2);
  await tick(baseCtx);

  const getReq = makeReq({}, { conversation_id: convId });
  const getRes = (await feature.routes['chat_get']!.handler(getReq, getReq)) as any;
  assert.equal(getRes.conversation.session, 2);
  assert.equal(getRes.conversation.platform, 'codex');
  assert.ok(getRes.messages.some((m: any) => m.role === 'system' && m.text.includes('claude → codex')));
});

test('chat: Forced compaction through chat_compact', async () => {
  const { makeReq, testProj, baseCtx, setNextReply } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'Compressor', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const agentId = agRes.agent.id;

  const convReq = makeReq({ agent_id: agentId });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  setNextReply('Turn before compact');
  await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Tell me about project' }),
    makeReq()
  );
  await tick(baseCtx);

  // Compact
  setNextReply('This conversation discussed project architecture.');
  const compReq = makeReq({ conversation_id: convId });
  const compRes = (await feature.routes['chat_compact']!.handler(compReq, compReq)) as any;
  assert.equal(compRes.ok, true);
  assert.ok(compRes.job_id);

  await tick(baseCtx);

  const getReq = makeReq({}, { conversation_id: convId });
  const getRes = (await feature.routes['chat_get']!.handler(getReq, getReq)) as any;
  assert.equal(getRes.conversation.summary, 'This conversation discussed project architecture.');
  assert.ok(getRes.messages.some((m: any) => m.role === 'system' && m.text.includes('Đã nén ngữ cảnh')));
});
