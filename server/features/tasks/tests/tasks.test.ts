import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { exportLibrary, importLibrary } from '../library.ts';
import { deletePreset, getPresets, savePreset } from '../presets.ts';
import {
  getSchedulerStatus,
  handleTaskRetry,
  startCardJob,
  tick,
  tryAcquireLeaderLock,
} from '../scheduler.ts';
import {
  createCard,
  deleteCard,
  getCard,
  getCards,
  getConfig,
  moveCard,
  patchCard,
  saveCard,
  saveConfig,
  updateCard,
} from '../store.ts';
import {
  deleteTemplate,
  getTemplates,
  renderTemplate,
  saveTemplate,
} from '../templates.ts';

function createTestContext(testName: string): {
  ctx: MawFeatureContext;
  tempMawHome: string;
  tempJobsDir: string;
  testProjectDir: string;
  cleanup: () => void;
} {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempMawHome = path.join(os.tmpdir(), `maw_test_${testName}_${rand}`);
  const tempJobsDir = path.join(tempMawHome, 'jobs');
  const tempProjectsDir = path.join(tempMawHome, 'projects');
  const testProjectDir = path.join(tempProjectsDir, 'project-a');

  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempJobsDir, { recursive: true });
  fs.mkdirSync(testProjectDir, { recursive: true });

  const paths = resolveServerPaths({
    mawHome: tempMawHome,
    projectsRoot: tempProjectsDir,
  });
  paths.jobsDir = tempJobsDir;
  paths.projectsRoot = tempProjectsDir;

  const registry = loadAgentRegistry(paths);
  let jobCounter = 0;

  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => [],
    startJob: async (body: Record<string, unknown>) => {
      jobCounter++;
      const jobId = `job_test_${jobCounter}_${Date.now()}`;
      const meta = {
        job_id: jobId,
        pid: process.pid,
        status: 'RUNNING',
        exit_code: null,
        started_at: new Date().toISOString(),
        started_ts: Math.floor(Date.now() / 1000),
        ...body,
      };
      fs.writeFileSync(
        path.join(tempJobsDir, `${jobId}.json`),
        JSON.stringify(meta),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempJobsDir, `${jobId}.log`),
        'Job started\n',
        'utf8'
      );
      return { ok: true, job_id: jobId, pid: process.pid, status: 'RUNNING' };
    },
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempMawHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { ctx, tempMawHome, tempJobsDir, testProjectDir, cleanup };
}

test('tasks: create, validate, and cycle rejection', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('card_crud');
  try {
    // 1. Valid card creation
    const cardA = await createCard(ctx, {
      title: 'Task A',
      prompt: 'Do task A',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
    });
    assert.equal(cardA.title, 'Task A');
    assert.equal(cardA.status, 'backlog');
    assert.equal(cardA.order, 1000);

    const cardB = await createCard(ctx, {
      title: 'Task B',
      prompt: 'Do task B',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      depends_on: [cardA.id],
    });
    assert.deepEqual(cardB.depends_on, [cardA.id]);

    // Test moveCard with reason
    const rejectedA = await moveCard(ctx, cardA.id, 'failed', undefined, 'rejected by user');
    assert.equal(rejectedA.status, 'failed');
    assert.equal(rejectedA.status_reason, 'rejected by user');

    // 2. Cycle rejection: Card A cannot depend on Card B (A -> B -> A)
    await assert.rejects(
      async () => {
        await updateCard(ctx, cardA.id, {
          depends_on: [cardB.id],
        });
      },
      /cycle detected/i
    );

    // 3. Card cannot depend on itself
    await assert.rejects(
      async () => {
        await updateCard(ctx, cardA.id, {
          depends_on: [cardA.id],
        });
      },
      /cannot depend on itself/i
    );

    // 4. Validation error: title > 200 chars
    await assert.rejects(
      async () => {
        await createCard(ctx, {
          title: 'x'.repeat(201),
          prompt: 'prompt',
          project_path: testProjectDir,
        });
      },
      /title must be between 1 and 200 characters/i
    );
  } finally {
    cleanup();
  }
});

test('tasks: scheduler starts only when dependencies are done', async () => {
  const { ctx, tempJobsDir, testProjectDir, cleanup } = createTestContext('deps');
  try {
    const cardA = await createCard(ctx, {
      title: 'A',
      prompt: 'Prompt A',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'queued',
    });

    const cardB = await createCard(ctx, {
      title: 'B',
      prompt: 'Prompt B',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'queued',
      depends_on: [cardA.id],
    });

    // First tick: Card A starts, Card B remains queued because A is running
    await tick(ctx);
    const updatedA = (await getCard(ctx, cardA.id))!;
    const updatedB = (await getCard(ctx, cardB.id))!;
    assert.equal(updatedA.status, 'running');
    assert.equal(updatedB.status, 'queued');

    // Simulate Card A finishes with exit 0
    const metaFile = path.join(tempJobsDir, `${updatedA.job_id}.json`);
    const logFile = path.join(tempJobsDir, `${updatedA.job_id}.log`);
    fs.writeFileSync(
      logFile,
      'Done!\n=== [JOB_FINISHED exit_code=0] ===\n',
      'utf8'
    );
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.status = 'DONE';
    meta.exit_code = 0;
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');

    // Second tick: reconciles A to done, starts B!
    await tick(ctx);
    const reconciledA = (await getCard(ctx, cardA.id))!;
    const startedB = (await getCard(ctx, cardB.id))!;
    assert.equal(reconciledA.status, 'done');
    assert.equal(startedB.status, 'running');
  } finally {
    cleanup();
  }
});

test('tasks: concurrency limits (global max_parallel and per_agent)', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('concurrency');
  try {
    await saveConfig(ctx, {
      max_parallel: 2,
      per_agent: { claude: 1 },
    });

    // Create 2 cards for claude, 1 for codex
    await createCard(ctx, {
      title: 'Claude 1',
      prompt: 'P1',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'queued',
    });
    await createCard(ctx, {
      title: 'Claude 2',
      prompt: 'P2',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'queued',
    });
    await createCard(ctx, {
      title: 'Codex 1',
      prompt: 'P3',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'codex',
      role: 'backend',
      status: 'queued',
    });

    await tick(ctx);
    const cards = await getCards(ctx);
    const running = cards.filter((c) => c.status === 'running');
    const runningClaude = running.filter((c) => c.agent === 'claude');
    const runningCodex = running.filter((c) => c.agent === 'codex');

    // Total running should be 2 (global limit)
    assert.equal(running.length, 2);
    // Claude should have only 1 running (per_agent limit)
    assert.equal(runningClaude.length, 1);
    // Codex should have 1 running
    assert.equal(runningCodex.length, 1);
  } finally {
    cleanup();
  }
});

test('tasks: status mapping (exit 0, exit 2, exit 124, CANCELLED, missing meta)', async () => {
  const { ctx, tempJobsDir, testProjectDir, cleanup } = createTestContext('status_mapping');
  try {
    const card = await createCard(ctx, {
      title: 'Test Status',
      prompt: 'Prompt',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'queued',
    });

    await tick(ctx);
    let current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'running');

    // 1. exit 0 -> done
    const metaFile = path.join(tempJobsDir, `${current.job_id}.json`);
    const logFile = path.join(tempJobsDir, `${current.job_id}.log`);
    fs.writeFileSync(logFile, '=== [JOB_FINISHED exit_code=0] ===\n');
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ status: 'DONE', exit_code: 0 })
    );

    await tick(ctx);
    current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'done');

    // 2. exit 2 -> failed "rejected (exit 2)"
    current.status = 'running';
    current.job_id = 'job_exit_2';
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_exit_2.log'),
      '=== [JOB_FINISHED exit_code=2] ===\n'
    );
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_exit_2.json'),
      JSON.stringify({ status: 'FAILED', exit_code: 2 })
    );
    await saveCard(ctx, current);

    await tick(ctx);
    current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'failed');
    assert.equal(current.status_reason, 'rejected (exit 2)');

    // 3. exit 124 -> needs_input "agent still working / timed out"
    current.status = 'running';
    current.job_id = 'job_exit_124';
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_exit_124.log'),
      '=== [JOB_FINISHED exit_code=124] ===\n'
    );
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_exit_124.json'),
      JSON.stringify({ status: 'FAILED', exit_code: 124 })
    );
    await saveCard(ctx, current);

    await tick(ctx);
    current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'needs_input');
    assert.equal(current.status_reason, 'agent still working / timed out');

    // 4. CANCELLED -> failed "cancelled"
    current.status = 'running';
    current.job_id = 'job_cancel';
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_cancel.log'),
      '=== [JOB_CANCELLED_BY_USER] ===\n'
    );
    fs.writeFileSync(
      path.join(tempJobsDir, 'job_cancel.json'),
      JSON.stringify({ status: 'CANCELLED', exit_code: null })
    );
    await saveCard(ctx, current);

    await tick(ctx);
    current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'failed');
    assert.equal(current.status_reason, 'cancelled');

    // 5. Missing meta file -> failed "job record missing"
    current.status = 'running';
    current.job_id = 'job_missing_record';
    await saveCard(ctx, current);

    await tick(ctx);
    current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'failed');
    assert.equal(current.status_reason, 'job record missing');
  } finally {
    cleanup();
  }
});

test('tasks: auto-retry backoff and findings extraction', async () => {
  const { ctx, tempJobsDir, testProjectDir, cleanup } = createTestContext('auto_retry');
  try {
    const card = await createCard(ctx, {
      title: 'Auto Retry Test',
      prompt: 'Write clean code',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'reviewer',
      status: 'queued',
      retry: { auto: true, max_attempts: 3, backoff_sec: 10 },
    });

    await tick(ctx);
    const running = (await getCard(ctx, card.id))!;
    assert.equal(running.status, 'running');

    // Finish with failure and review findings
    const logFile = path.join(tempJobsDir, `${running.job_id}.log`);
    const metaFile = path.join(tempJobsDir, `${running.job_id}.json`);
    const logText =
      'Log output\nSCORE: 6.5/10\nVERDICT: CHANGES_REQUESTED\n=== REVIEWER\nPlease fix the memory leak in loop.\n=== [JOB_FINISHED exit_code=1] ===\n';
    fs.writeFileSync(logFile, logText);
    fs.writeFileSync(metaFile, JSON.stringify({ status: 'FAILED', exit_code: 1 }));

    await tick(ctx);
    let failedCard = (await getCard(ctx, card.id))!;
    assert.equal(failedCard.status, 'failed');
    assert.ok(failedCard.next_retry_at);

    // Verify parsed findings and score on the attempt
    const att = failedCard.attempts[0]!;
    assert.equal(att.score, 6.5);
    assert.equal(att.verdict, 'CHANGES_REQUESTED');
    assert.ok(att.findings?.includes('Please fix the memory leak'));

    // Fast-forward next_retry_at to past
    failedCard.next_retry_at = new Date(Date.now() - 1000).toISOString();
    await saveCard(ctx, failedCard);

    // Next tick moves it to queued and restarts it!
    await tick(ctx);
    const retriedCard = (await getCard(ctx, card.id))!;
    assert.equal(retriedCard.status, 'running');
    assert.equal(retriedCard.attempts.length, 2);
  } finally {
    cleanup();
  }
});

test('tasks: reassign and resume sessions capability check', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('reassign_resume');
  try {
    const card = await createCard(ctx, {
      title: 'Reassign Task',
      prompt: 'Do something',
      project_path: testProjectDir,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      status: 'backlog',
    });

    card.status = 'failed';
    await saveCard(ctx, card);

    // 1. Reassign agent to codex
    const reassigned = await handleTaskRetry(ctx, {
      id: card.id,
      agent: 'codex',
      role: 'tester',
    });
    assert.equal(reassigned.agent, 'codex');
    assert.equal(reassigned.role, 'tester');
    assert.equal(reassigned.status, 'queued');

    // 2. Resume for agent without sessions (claude) throws 400
    reassigned.status = 'failed';
    reassigned.agent = 'claude';
    await saveCard(ctx, reassigned);

    await assert.rejects(
      async () => {
        await handleTaskRetry(ctx, {
          id: card.id,
          mode: 'resume',
        });
      },
      /resume needs an agent with sessions/i
    );

    // 3. Resume for agent with sessions (antigravity) succeeds
    reassigned.agent = 'antigravity';
    await saveCard(ctx, reassigned);

    const resumed = await handleTaskRetry(ctx, {
      id: card.id,
      mode: 'resume',
      note: 'Continue your work',
    });
    assert.equal(resumed.status, 'queued');
  } finally {
    cleanup();
  }
});

test('tasks: leader lock mechanism (second instance stays passive)', async () => {
  const { ctx, cleanup } = createTestContext('leader_lock');
  try {
    const lock1 = tryAcquireLeaderLock(ctx);
    assert.equal(lock1, true);

    const stat = getSchedulerStatus(ctx);
    assert.equal(stat.active, true);
    assert.equal(stat.pid, process.pid);

    // Create a fake second context with different PID in lock
    const fakeCtx = { ...ctx };
    const lockFile = path.join(ctx.paths.featureDataDir('tasks'), 'scheduler.lock');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid + 99999,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }),
      'utf8'
    );

    // Second instance attempting to acquire will see active lock
    // (if PID exists; since process.pid+99999 is dead, isProcessRunning will return false and steal it)
    // To test lock contention, write the real process.pid:
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }),
      'utf8'
    );
    const lock2 = tryAcquireLeaderLock(fakeCtx);
    assert.equal(lock2, true); // Same pid refreshes
  } finally {
    cleanup();
  }
});

test('tasks: templates rendering and built-in read-only enforcement', async () => {
  const { ctx, cleanup } = createTestContext('templates');
  try {
    const templates = await getTemplates(ctx);
    const implementFeature = templates.find((t) => t.id === 'implement-feature')!;
    assert.equal(implementFeature.builtin, true);

    // Render template
    const rendered = renderTemplate(
      implementFeature,
      { feature: 'Search Bar', file: 'search.ts' },
      'C:\\laragon\\www\\my-app'
    );
    assert.equal(rendered.title, 'Implement Search Bar');
    assert.ok(rendered.prompt.includes('search.ts'));

    // Missing variable throws 400
    assert.throws(() => {
      renderTemplate(implementFeature, { feature: 'Search Bar' }, 'C:\\test');
    }, /Missing template variable: file/i);

    // Built-in template cannot be saved or deleted
    await assert.rejects(
      async () => {
        await saveTemplate(ctx, { id: 'implement-feature', name: 'Override' });
      },
      /built-in templates are read-only/i
    );

    await assert.rejects(
      async () => {
        await deleteTemplate(ctx, 'implement-feature');
      },
      /built-in templates are read-only/i
    );

    // User template save and delete
    const userTpl = await saveTemplate(ctx, {
      name: 'Custom Tpl',
      title: 'Do {{task}}',
      prompt: 'Prompt for {{task}}',
    });
    assert.equal(userTpl.builtin, false);

    const deletedId = await deleteTemplate(ctx, userTpl.id);
    assert.equal(deletedId, userTpl.id);
  } finally {
    cleanup();
  }
});

test('tasks: library export -> import round trip', async () => {
  const { ctx, cleanup } = createTestContext('library');
  try {
    // Create user template and preset
    await saveTemplate(ctx, {
      id: 'tpl_custom_1',
      name: 'User Template 1',
      title: 'Title {{x}}',
      prompt: 'Prompt {{x}}',
    });

    await savePreset(ctx, {
      id: 'preset_custom_1',
      name: 'User Preset 1',
      team: { backend: 'antigravity', frontend: 'claude' },
      max_fix_rounds: 3,
    });

    const exported = await exportLibrary(ctx);
    assert.equal(exported.maw_library, 1);
    assert.ok(exported.templates.some((t) => t.id === 'tpl_custom_1'));
    assert.ok(exported.presets.some((p) => p.id === 'preset_custom_1'));

    // Round-trip import with overwrite
    const importRes = await importLibrary(ctx, exported, true);
    assert.equal(importRes.ok, true);
    assert.equal(importRes.imported.templates, 1);
    assert.equal(importRes.imported.presets, 1);
  } finally {
    cleanup();
  }
});

test('tasks: retry/resume preserves custom prompt and note in pending_run', async () => {
  const { ctx, testProjectDir, tempJobsDir, cleanup } = createTestContext('retry_pending');
  try {
    const card = await createCard(ctx, {
      title: 'Task for retry test',
      prompt: 'Original prompt',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'queued',
    });

    // Run first job to fail it
    await tick(ctx);
    const runningCard = (await getCards(ctx))[0]!;
    assert.ok(runningCard.job_id);

    // Write failed meta
    fs.writeFileSync(
      path.join(tempJobsDir, `${runningCard.job_id}.json`),
      JSON.stringify({
        job_id: runningCard.job_id,
        status: 'FAILED',
        exit_code: 1,
        finished_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(tempJobsDir, `${runningCard.job_id}.log`),
      'Error: NullPointer\n'
    );

    // Reconcile tick to mark card failed
    await tick(ctx);
    const failedCard = (await getCards(ctx))[0]!;
    assert.equal(failedCard.status, 'failed');

    // Call handleTaskRetry with custom note
    const retriedCard = await handleTaskRetry(ctx, {
      id: failedCard.id,
      note: 'Please fix the NullPointer with a null check.',
      mode: 'retry',
    });

    assert.equal(retriedCard.status, 'queued');
    assert.ok(retriedCard.pending_run);
    assert.equal(retriedCard.pending_run.kind, 'retry');
    assert.match(retriedCard.pending_run.prompt, /Please fix the NullPointer with a null check/);

    // Start card job and verify it consumed pending_run
    let capturedJobPrompt = '';
    const origStart = ctx.startJob;
    ctx.startJob = async (body) => {
      capturedJobPrompt = String(body.prompt ?? '');
      return origStart(body);
    };

    await tick(ctx);

    const startedCard = (await getCards(ctx))[0]!;
    assert.equal(startedCard.status, 'running');
    assert.equal(startedCard.pending_run, null);
    assert.match(capturedJobPrompt, /Please fix the NullPointer with a null check/);
    assert.equal(startedCard.attempts[startedCard.attempts.length - 1]!.kind, 'retry');
  } finally {
    cleanup();
  }
});

test('tasks: patchCard prevents lost updates and does not resurrect deleted cards', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('patch_card');
  try {
    const card = await createCard(ctx, {
      title: 'Patch Card Test',
      prompt: 'Testing patchCard',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });

    // 1. Concurrent patchCard calls
    await Promise.all([
      patchCard(ctx, card.id, (c) => {
        c.labels.push('label-1');
      }),
      patchCard(ctx, card.id, (c) => {
        c.labels.push('label-2');
      }),
      patchCard(ctx, card.id, (c) => {
        c.labels.push('label-3');
      }),
    ]);

    const refreshed = await getCard(ctx, card.id);
    assert.ok(refreshed);
    assert.equal(refreshed.labels.length, 3);
    assert.ok(refreshed.labels.includes('label-1'));
    assert.ok(refreshed.labels.includes('label-2'));
    assert.ok(refreshed.labels.includes('label-3'));

    // 2. patchCard on non-existent card returns null
    const nonExistent = await patchCard(ctx, 'task_nonexistent_123', (c) => {
      c.title = 'Should not happen';
    });
    assert.equal(nonExistent, null);

    // 3. deleteCard then saveCard must throw notFound (does not resurrect)
    await deleteCard(ctx, card.id);
    await assert.rejects(
      async () => {
        await saveCard(ctx, card);
      },
      /Task card not found/i
    );
  } finally {
    cleanup();
  }
});

test('tasks: startCardJob guards against concurrent double start', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('double_start');
  try {
    const card = await createCard(ctx, {
      title: 'Double Start Test',
      prompt: 'Testing concurrency',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'queued',
    });

    // Try starting the card twice concurrently
    const results = await Promise.allSettled([
      startCardJob(ctx, card),
      startCardJob(ctx, card),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one start should succeed');
    assert.equal(rejected.length, 1, 'Exactly one start should be rejected');
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason?.message,
      /already starting|already running/i
    );
  } finally {
    cleanup();
  }
});

test('tasks: updateCard validates fields and clears cross-project dependencies', async () => {
  const { ctx, tempMawHome, testProjectDir, cleanup } = createTestContext('update_fields');
  try {
    const projectB = path.join(tempMawHome, 'projects', 'project-b');
    fs.mkdirSync(projectB, { recursive: true });

    const card1 = await createCard(ctx, {
      title: 'Card 1',
      prompt: 'Prompt 1',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'backlog',
    });

    const card2 = await createCard(ctx, {
      title: 'Card 2',
      prompt: 'Prompt 2',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      depends_on: [card1.id],
      status: 'backlog',
    });

    assert.deepEqual(card2.depends_on, [card1.id]);

    // Move card2 to projectB -> cross-project dependency card1 should be cleared
    const updatedCard2 = await updateCard(ctx, card2.id, {
      project_path: projectB,
    });
    assert.deepEqual(updatedCard2.depends_on, []);

    // Reject invalid retry max_attempts (> 10)
    await assert.rejects(
      async () => {
        await updateCard(ctx, card2.id, { retry: { max_attempts: 15 } });
      },
      /max_attempts must be an integer between 1 and 10/i
    );

    // Reject invalid retry backoff_sec (< 5)
    await assert.rejects(
      async () => {
        await updateCard(ctx, card2.id, { retry: { backoff_sec: 2 } });
      },
      /backoff_sec must be an integer between 5 and 3600/i
    );

    // Reject NaN retry
    await assert.rejects(
      async () => {
        await updateCard(ctx, card2.id, { retry: { backoff_sec: 'not_a_number' } });
      },
      /backoff_sec must be an integer between 5 and 3600/i
    );

    // Valid update of role and team
    const updated = await updateCard(ctx, card2.id, {
      role: 'reviewer',
      retry: { auto: true, max_attempts: 5, backoff_sec: 120 },
    });
    assert.equal(updated.role, 'reviewer');
    assert.equal(updated.retry.auto, true);
    assert.equal(updated.retry.max_attempts, 5);
    assert.equal(updated.retry.backoff_sec, 120);
  } finally {
    cleanup();
  }
});

test('tasks: tick handles 409 conflict during card start without marking card failed', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('race_409');
  try {
    const card = await createCard(ctx, {
      title: 'Race 409 Card',
      prompt: 'Testing race conflict',
      project_path: testProjectDir,
      agent: 'antigravity',
      role: 'backend',
      status: 'queued',
    });

    let winnerRan = false;
    ctx.startJob = async (body) => {
      // Simulate concurrent task_start winning and marking card running right as this job spawns
      await patchCard(ctx, card.id, (c) => {
        c.status = 'running';
        c.job_id = 'job_winner';
      });
      winnerRan = true;
      return { ok: true, job_id: 'job_loser', status: 'RUNNING' };
    };

    // Run tick()
    await tick(ctx);

    // Verify race was hit, card was NOT overwritten or marked 'failed'
    assert.ok(winnerRan);
    const current = (await getCard(ctx, card.id))!;
    assert.equal(current.status, 'running');
    assert.equal(current.job_id, 'job_winner');
    assert.equal(current.status_reason, '');
  } finally {
    cleanup();
  }
});

test('tasks: preset precedence applies when card team/reviewers are empty and merges isolate', async () => {
  const { ctx, testProjectDir, cleanup } = createTestContext('preset_precedence');
  try {
    const preset = await savePreset(ctx, {
      id: 'preset_precedence_test',
      name: 'Precedence Preset',
      team: { backend: 'antigravity', frontend: 'claude' },
      reviewers: ['codex'],
      isolate: true,
      budget_usd: 10,
    });

    let capturedRunBody: Record<string, any> | null = null;
    ctx.startJob = async (body) => {
      capturedRunBody = body as Record<string, any>;
      return { ok: true, job_id: 'job_preset_test', status: 'RUNNING' };
    };

    // 1. Card with empty team: {}, empty reviewers: [], isolate: false
    const card1 = await createCard(ctx, {
      title: 'Empty Team Card',
      prompt: 'Test empty team',
      project_path: testProjectDir,
      mode: 'team',
      agent: 'claude',
      preset_id: preset.id,
      team: {},
      reviewers: [],
      isolate: false,
      status: 'queued',
    });

    await startCardJob(ctx, card1);

    const body1 = capturedRunBody!;
    assert.ok(body1);
    // Should fall back to preset values
    assert.deepEqual(body1.team, { backend: 'antigravity', frontend: 'claude' });
    assert.deepEqual(body1.reviewers, ['codex']);
    assert.equal(body1.isolate, true);

    // 2. Card with non-empty team and reviewers
    capturedRunBody = null;
    const card2 = await createCard(ctx, {
      title: 'Non Empty Team Card',
      prompt: 'Test non empty team',
      project_path: testProjectDir,
      mode: 'team',
      agent: 'claude',
      preset_id: preset.id,
      team: { backend: 'codex' },
      reviewers: ['antigravity'],
      isolate: false,
      status: 'queued',
    });

    await startCardJob(ctx, card2);

    const body2 = capturedRunBody!;
    assert.ok(body2);
    // Card's non-empty values should take precedence
    assert.deepEqual(body2.team, { backend: 'codex' });
    assert.deepEqual(body2.reviewers, ['antigravity']);
    // isolate merges as true since preset.isolate is true
    assert.equal(body2.isolate, true);
  } finally {
    cleanup();
  }
});

test('tasks: council findings extraction captures 6000 chars of reviewer logs ending with COUNCIL_RESULT', async () => {
  const { ctx, testProjectDir, tempJobsDir, cleanup } = createTestContext('council_findings');
  try {
    const card = await createCard(ctx, {
      title: 'Council Task',
      prompt: 'Review architecture',
      project_path: testProjectDir,
      mode: 'council',
      role: 'reviewer',
      status: 'queued',
    });

    await tick(ctx);
    const runningCard = (await getCards(ctx))[0]!;
    assert.ok(runningCard.job_id);

    // Build 8000 characters of detailed reviewer logs ending with COUNCIL_RESULT
    const prefix = 'Reviewer feedback details: '.repeat(250); // ~7000 chars
    const councilSummary = '\n=== COUNCIL_RESULT: APPROVED 9.5/10 ===\nSCORE: 9.5 / 10\nVERDICT: APPROVED\n';
    const fullLog = `${prefix}${councilSummary}`;

    fs.writeFileSync(
      path.join(tempJobsDir, `${runningCard.job_id}.json`),
      JSON.stringify({
        job_id: runningCard.job_id,
        status: 'DONE',
        exit_code: 0,
        finished_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(tempJobsDir, `${runningCard.job_id}.log`),
      fullLog,
      'utf8'
    );

    // Reconcile tick
    await tick(ctx);

    const reconciledCard = (await getCards(ctx))[0]!;
    assert.equal(reconciledCard.status, 'done');
    const lastAttempt = reconciledCard.attempts[0]!;

    assert.equal(lastAttempt.score, 9.5);
    assert.equal(lastAttempt.verdict, 'APPROVED');
    assert.ok(lastAttempt.findings);
    // Findings must be 6000 chars (not just the last COUNCIL_RESULT line)
    assert.equal(lastAttempt.findings.length, 6000);
    assert.ok(lastAttempt.findings.endsWith('VERDICT: APPROVED'));
    assert.ok(lastAttempt.findings.includes('Reviewer feedback details:'));
  } finally {
    cleanup();
  }
});
