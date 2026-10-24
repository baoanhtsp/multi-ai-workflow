import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { feature as agentsFeature } from '../../agents-ws/index.ts';
import { isS6StateLocked, s6StateStorage, withS6State } from '../../agents-ws/lib/mutex.ts';
import { buildPrompt } from '../../agents-ws/lib/prompt.ts';
import { feature } from '../index.ts';
import { ensureTickStarted, resetTickTimerForTest, tick } from '../tick.ts';

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

test('chat: [user status] user message status becomes done once turn starts', async () => {
  const { makeReq, testProj } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'StatusBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  const sendReq = makeReq({ conversation_id: convId, text: 'Check my status' });
  const sendRes = (await feature.routes['chat_send']!.handler(sendReq, sendReq)) as any;
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.message.role, 'user');
  assert.equal(sendRes.message.status, 'done');
});

test('chat: [retry] FAILED turn with retry_policy re-runs after backoff', async () => {
  const { makeReq, testProj, baseCtx, setNextReply, setNextJobStatus } = setupChatTestContext();

  const agReq = makeReq({
    agent: {
      name: 'RetryBot',
      platform: 'claude',
      workdir: testProj,
      retry_policy: { max_attempts: 1, backoff_sec: 0 },
    },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  let jobAttempt = 0;
  const origStartJob = baseCtx.startJob;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    jobAttempt++;
    if (jobAttempt === 1) {
      setNextJobStatus('FAILED');
      setNextReply('Transient API error');
    } else {
      setNextJobStatus('DONE');
      setNextReply('Task succeeded on retry!');
    }
    return origStartJob(body);
  };

  const sendReq = makeReq({ conversation_id: convId, text: 'Do difficult task' });
  await feature.routes['chat_send']!.handler(sendReq, sendReq);

  // Tick 1: turn 1 finishes FAILED -> retry_policy appends "Thử lại lần 1" -> starts retry turn (jobAttempt 2)
  await tick(baseCtx);
  // Tick 2: retry turn finishes DONE -> appends assistant response
  await tick(baseCtx);

  const get2 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.ok(get2.messages.some((m: any) => m.role === 'system' && m.text.includes('Thử lại lần 1')));
  assert.ok(get2.messages.some((m: any) => m.role === 'assistant' && m.text.includes('Task succeeded on retry!')));
});

test('chat: [compaction] startJob failure records error and backs off, and replay overflow triggers', async () => {
  const { makeReq, testProj, baseCtx, setNextReply, setNextJobStatus } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'Compactor', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  setNextJobStatus('DONE');
  setNextReply('Normal reply');
  await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Initial message' }),
    makeReq()
  );
  await tick(baseCtx);

  // Force compaction but make compaction job fail
  setNextJobStatus('FAILED');
  setNextReply('API rate limit exceeded during compaction');
  await feature.routes['chat_compact']!.handler(
    makeReq({ conversation_id: convId }),
    makeReq()
  );
  await tick(baseCtx);

  // Verify compact error and compact_failed_at were recorded
  const get1 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.ok(get1.conversation.compact_failed_at);
  assert.ok(get1.conversation.compact_error.includes('API rate limit'));

  // During 10 min backoff, automatic compaction does not re-trigger
  await tick(baseCtx);
  const get2 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(get2.conversation.active_job_id, '');
});

test('chat: [queue error] failing startJob for queued item appends system error message and drops item', async () => {
  const { makeReq, testProj, baseCtx } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'FailBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // Start turn 1
  await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Turn 1' }),
    makeReq()
  );

  // Queue turn 2 while busy
  await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Turn 2 (will fail to start)' }),
    makeReq()
  );

  // Make startJob throw an error when starting turn 2
  const originalStartJob = baseCtx.startJob;
  let jobCount = 0;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    jobCount++;
    if (jobCount === 1) {
      throw new Error('Process spawn failed: binary missing');
    }
    return originalStartJob(body);
  };

  // Tick 1: completes turn 1, tries to start turn 2 -> startJob throws -> appends system error message and drops item
  await tick(baseCtx);

  const getRes = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(getRes.conversation.queue.length, 0);
  assert.ok(
    getRes.messages.some(
      (m: any) => m.role === 'system' && m.text.includes('Process spawn failed')
    )
  );
});

test('chat: [concurrency] withS6State serializes concurrent operations', async () => {
  const { makeReq, testProj, baseCtx } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'ConcurrentBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // Fire tick and chat_send concurrently
  const p1 = tick(baseCtx);
  const p2 = feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Concurrent message 1' }),
    makeReq()
  );
  const p3 = agentsFeature.routes['ws_agent_save']!.handler(
    makeReq({ agent: { id: agRes.agent.id, name: 'ConcurrentBot Renamed' } }),
    makeReq()
  );

  const results = await Promise.all([p1, p2, p3]);
  assert.ok(results[1]);
  assert.ok(results[2]);

  const getRes = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.ok(getRes.ok);
});

test('chat: [Item 3] chat_stop handles cancellation success, 409 already terminated, and preserves tracking on unexpected error', async () => {
  const { makeReq, testProj, paths } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'StopTestBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // Path 1: start a turn, job meta exists in RUNNING state -> chat_stop succeeds and clears active_job_id
  const sendRes = (await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Running task' }),
    makeReq()
  )) as any;
  assert.ok(sendRes.job_id);

  const stopReq = makeReq({ conversation_id: convId });
  const stopRes = (await feature.routes['chat_stop']!.handler(stopReq, stopReq)) as any;
  assert.equal(stopRes.ok, true);
  assert.equal(stopRes.cancelled, sendRes.job_id);

  const getRes1 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(getRes1.conversation.active_job_id, '', 'active_job_id cleared on successful cancel');

  // Path 2: Job meta is already in terminal state (DONE). handleCancelJob throws 409 with status.
  // chat_stop should safely clear active_job_id because job is no longer running.
  const sendRes2 = (await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Second task' }),
    makeReq()
  )) as any;
  const jobId2 = sendRes2.job_id;

  // Manually update job meta to DONE on disk
  const metaFile2 = path.win32.join(paths.jobsDir, `${jobId2}.json`);
  fs.writeFileSync(metaFile2, JSON.stringify({ job_id: jobId2, status: 'DONE', exit_code: 0 }), 'utf8');

  const stopRes2 = (await feature.routes['chat_stop']!.handler(stopReq, stopReq)) as any;
  assert.equal(stopRes2.ok, true);
  assert.equal(stopRes2.cancelled, jobId2);

  const getRes2 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(getRes2.conversation.active_job_id, '', 'active_job_id cleared when job was already terminated');

  // Path 3: Job meta file is missing (404) or unexpected failure where job may still run.
  // chat_stop should re-throw and KEEP active_job_id tracked!
  const sendRes3 = (await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Third task' }),
    makeReq()
  )) as any;
  const jobId3 = sendRes3.job_id;

  // Delete meta file to trigger 404
  const metaFile3 = path.win32.join(paths.jobsDir, `${jobId3}.json`);
  fs.unlinkSync(metaFile3);

  await assert.rejects(
    async () => {
      await feature.routes['chat_stop']!.handler(stopReq, stopReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 404
  );

  const getRes3 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(getRes3.conversation.active_job_id, jobId3, 'active_job_id remains tracked on cancel failure');
});

test('chat: [Item 5] failed first send persists seq and subsequent send has strictly increasing seqs', async () => {
  const { makeReq, testProj, baseCtx, setNextJobStatus } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'SeqTestBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // Force startJob to throw on the first call
  const originalStartJob = baseCtx.startJob;
  let attempt = 0;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    attempt++;
    if (attempt === 1) {
      throw new Error('Fatal start error');
    }
    return originalStartJob(body);
  };

  // First send fails -> throws error
  await assert.rejects(
    async () => {
      await feature.routes['chat_send']!.handler(
        makeReq({ conversation_id: convId, text: 'First failing message' }),
        makeReq()
      );
    },
    /Fatal start error/
  );

  // Read conversation: seq was persisted to disk via finally
  const getRes1 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.equal(getRes1.conversation.seq, 1, 'conv.seq must be 1 after failed first send');
  assert.equal(getRes1.messages.length, 1);
  assert.equal(getRes1.messages[0].seq, 1);
  assert.equal(getRes1.messages[0].status, 'failed');

  // Second send succeeds -> conv.seq advances strictly
  const sendRes2 = (await feature.routes['chat_send']!.handler(
    makeReq({ conversation_id: convId, text: 'Second successful message' }),
    makeReq()
  )) as any;
  assert.ok(sendRes2.ok);
  assert.equal(sendRes2.message.seq, 2, 'Second user message must have seq 2');

  const getRes2 = (await feature.routes['chat_get']!.handler(
    makeReq({}, { conversation_id: convId }),
    makeReq()
  )) as any;
  assert.ok(getRes2.conversation.seq >= 2, 'conv.seq must be at least 2');
  assert.ok(getRes2.messages.length >= 2);
  assert.equal(getRes2.messages[0].seq, 1);
  assert.equal(getRes2.messages[1].seq, 2);
  assert.ok(getRes2.messages[1].seq > getRes2.messages[0].seq, 'Seqs are strictly increasing');
  if (getRes2.messages.length > 2) {
    assert.equal(getRes2.messages[2].seq, 3);
    assert.ok(getRes2.messages[2].seq > getRes2.messages[1].seq, 'Assistant seq is strictly increasing');
  }
});

test('chat: [Item 1] ensureTickStarted escapes AsyncLocalStorage context so background ticks serialize with withS6State', async () => {
  const { baseCtx } = setupChatTestContext();
  try {
    // 1. Call ensureTickStarted inside withS6State
    await withS6State(async () => {
      ensureTickStarted(baseCtx);
    });

    // 2. Now acquire withS6State lock and verify background/isolated tick waits for lock
    let tickFinished = false;
    let lockObserved = false;

    await withS6State(async () => {
      assert.equal(isS6StateLocked(), true);

      // Launch tick outside this ALS context (just as the setInterval timer does)
      const tickPromise = s6StateStorage.exit(async () => {
        await tick(baseCtx);
        tickFinished = true;
      });

      // Tick must NOT finish while withS6State is held
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(tickFinished, false, 'Tick must wait while withS6State is held');
      lockObserved = isS6StateLocked();
    });

    // Once withS6State exits, tick finishes
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lockObserved, true);
    assert.equal(isS6StateLocked(), false);
  } finally {
    resetTickTimerForTest();
  }
});

test('chat: [Item 5] startTurnJob loads .maw/roles/<role>.md sections and passes may_delegate into prompt', async () => {
  const { makeReq, testProj, baseCtx } = setupChatTestContext();

  // Create .maw and .maw/roles in project
  const dotMawDir = path.win32.join(testProj, '.maw');
  const rolesDir = path.win32.join(dotMawDir, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });

  // Write .maw/team.json
  const teamData = {
    id: 'team_alpha',
    name: 'Alpha Team',
    version: 1,
    shared: { platform: 'claude' },
    roles: [
      {
        key: 'lead',
        name: 'Lead Architect',
        enabled: true,
        may_delegate: true,
      },
      {
        key: 'backend',
        name: 'Backend Dev',
        enabled: true,
        may_delegate: false,
      },
    ],
  };
  fs.writeFileSync(path.win32.join(dotMawDir, 'team.json'), JSON.stringify(teamData, null, 2), 'utf8');

  // Write role files
  const leadMd = `# Role: Lead Architect

## Responsibility
Oversee system architecture and coordinate deliverables.

## Delegation
Delegate core implementation to backend and UI to frontend.

## Permissions
Read/write access to specs and architecture diagrams.

## Output
Produce clean SPEC.md and architectural decisions.
`;
  fs.writeFileSync(path.win32.join(rolesDir, 'lead.md'), leadMd, 'utf8');

  const backendMd = `# Role: Backend Dev

## Responsibility
Implement server actions and database logic.
`;
  fs.writeFileSync(path.win32.join(rolesDir, 'backend.md'), backendMd, 'utf8');

  // Create agent associated with team and role
  const agReq = makeReq({
    agent: {
      name: 'AlphaLead',
      platform: 'claude',
      workdir: testProj,
      team_id: 'team_alpha',
      team_role: 'lead',
    },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const agentId = agRes.agent.id;

  // Intercept startJob to capture the constructed prompt
  let capturedPrompt = '';
  const origStartJob = baseCtx.startJob;
  baseCtx.startJob = async (body: Record<string, unknown>) => {
    capturedPrompt = String(body.prompt ?? '');
    return origStartJob(body);
  };

  // Create conversation and send turn
  const convReq = makeReq({ agent_id: agentId });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  const sendReq = makeReq({
    conversation_id: convId,
    text: 'Please organize the sprint tasks.',
  });
  await feature.routes['chat_send']!.handler(sendReq, sendReq);

  // Verify captured prompt contents
  assert.ok(
    capturedPrompt.includes('Oversee system architecture and coordinate deliverables.'),
    'Prompt contains responsibility from role markdown'
  );
  assert.ok(
    capturedPrompt.includes('Delegate core implementation to backend and UI to frontend.'),
    'Prompt contains delegation from role markdown'
  );
  assert.ok(
    capturedPrompt.includes('Read/write access to specs and architecture diagrams.'),
    'Prompt contains permissions from role markdown'
  );
  assert.ok(
    capturedPrompt.includes('Produce clean SPEC.md and architectural decisions.'),
    'Prompt contains output from role markdown'
  );
  assert.ok(
    capturedPrompt.includes('# Dispatch Tool'),
    'Prompt includes Dispatch Tool section for role with may_delegate: true'
  );
  assert.ok(
    capturedPrompt.includes('- backend (Backend Dev'),
    'Prompt includes backend in available team members'
  );
  assert.ok(
    capturedPrompt.includes('Implement server actions and database logic.'),
    'Prompt includes backend responsibility in available team members'
  );
});

test('chat: [Item 6] text limit 15,000 chars validation and buildPrompt progressive trimming', async () => {
  const { makeReq, testProj } = setupChatTestContext();

  const agReq = makeReq({
    agent: { name: 'BudgetBot', platform: 'claude', workdir: testProj },
  });
  const agRes = (await agentsFeature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const convReq = makeReq({ agent_id: agRes.agent.id });
  const convRes = (await feature.routes['chat_create']!.handler(convReq, convReq)) as any;
  const convId = convRes.conversation.id;

  // 1. Sending text with 15,001 chars triggers 400 validation error
  const oversizedText = 'a'.repeat(15001);
  await assert.rejects(
    async () => {
      await feature.routes['chat_send']!.handler(
        makeReq({ conversation_id: convId, text: oversizedText }),
        makeReq()
      );
    },
    (err: any) =>
      err instanceof ApiValidationError &&
      err.statusCode === 400 &&
      err.message.includes('15,000 characters')
  );

  // 2. buildPrompt progressive trimming under constrained budget
  const roleSections = {
    responsibility: 'Responsible for complete backend core and reliability testing.',
    delegation: 'Delegate frontend tasks to UI engineer.',
    output: 'Deliver structured JSON API responses and test reports.',
    permissions: 'File access restricted to server/ directory.',
    extra: 'Custom notes and background guidelines.',
  };

  const fullPrompt = buildPrompt({
    agent: {
      name: 'LeadBot',
      persona: 'Experienced software architect and tech lead.',
      team_role: 'lead',
      role_sections: { ...roleSections },
      may_delegate: true,
    },
    newMessageText: 'Task overview',
    teamMembers: [
      {
        key: 'tester',
        name: 'QA Engineer',
        platform: 'claude',
        responsibility: 'Execute smoke and integration tests',
      },
    ],
    maxChars: 17000,
  });

  // At full budget, all sections are preserved
  assert.ok(fullPrompt.includes('Custom notes and background guidelines.'));
  assert.ok(fullPrompt.includes('File access restricted to server/ directory.'));
  assert.ok(fullPrompt.includes('Deliver structured JSON API responses'));
  assert.ok(fullPrompt.includes('Delegate frontend tasks to UI engineer.'));
  assert.ok(fullPrompt.includes('Responsible for complete backend core'));
  assert.ok(fullPrompt.includes('Experienced software architect and tech lead.'));
  assert.ok(fullPrompt.includes('QA Engineer'));

  // Under small budget (e.g. 500 chars), trimming occurs in strict order
  const trimmedPrompt = buildPrompt({
    agent: {
      name: 'LeadBot',
      persona: 'Experienced software architect and tech lead.',
      team_role: 'lead',
      role_sections: { ...roleSections },
      may_delegate: true,
    },
    newMessageText: 'Task overview',
    teamMembers: [
      {
        key: 'tester',
        name: 'QA Engineer',
        platform: 'claude',
        responsibility: 'Execute smoke and integration tests',
      },
    ],
    maxChars: 400,
  });

  assert.ok(trimmedPrompt.length <= 400, `Trimmed prompt length ${trimmedPrompt.length} must be <= 400`);
  // Extra, permissions, output should be trimmed away first
  assert.equal(trimmedPrompt.includes('Custom notes and background guidelines.'), false);
  assert.equal(trimmedPrompt.includes('File access restricted to server/ directory.'), false);
  assert.equal(trimmedPrompt.includes('Deliver structured JSON API responses'), false);
});


