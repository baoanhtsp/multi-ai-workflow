import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import { createCard, getCard, saveCard } from '../../tasks/store.ts';
import { computeNextRunAt, validateWhenFormat } from '../parser.ts';
import {
  deleteSchedule,
  getSchedules,
  runScheduleNow,
  saveSchedule,
  scheduleTicker,
} from '../runs.ts';

function createSchedulesTestContext(testName: string): {
  ctx: MawFeatureContext;
  tempMawHome: string;
  projectDir: string;
  cleanup: () => void;
} {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempMawHome = path.join(os.tmpdir(), `maw_sch_test_${testName}_${rand}`);
  const tempProjects = path.join(tempMawHome, 'projects');
  const projectDir = path.join(tempProjects, 'app');

  fs.mkdirSync(projectDir, { recursive: true });

  const paths = resolveServerPaths({
    mawHome: tempMawHome,
    projectsRoot: tempProjects,
  });
  paths.projectsRoot = tempProjects;

  const registry = loadAgentRegistry(paths);

  const ctx: MawFeatureContext = {
    paths,
    registry,
    readJobs: async () => [],
    startJob: async () => ({ ok: true, job_id: 'job_test', status: 'RUNNING' }),
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempMawHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { ctx, tempMawHome, projectDir, cleanup };
}

test('schedules: parse when forms and reject invalid formats', () => {
  // Valid forms
  assert.equal(validateWhenFormat('daily 02:00').type, 'daily');
  assert.equal(validateWhenFormat('daily 23:59').type, 'daily');
  assert.equal(validateWhenFormat('weekly mon 02:00').type, 'weekly');
  assert.equal(validateWhenFormat('weekly sun 14:30').type, 'weekly');
  assert.equal(validateWhenFormat('every 5 minutes').type, 'every');
  assert.equal(validateWhenFormat('every 1440 minutes').type, 'every');

  // Invalid forms
  assert.throws(() => validateWhenFormat('hourly'), /Accepted forms/i);
  assert.throws(() => validateWhenFormat('daily 25:00'), /Accepted forms/i);
  assert.throws(() => validateWhenFormat('weekly foo 02:00'), /Accepted forms/i);
  assert.throws(() => validateWhenFormat('every 4 minutes'), /between 5 and 1440/i);
  assert.throws(() => validateWhenFormat('every 1441 minutes'), /between 5 and 1440/i);
});

test('schedules: compute next_run_at for daily, weekly, and every', () => {
  // Reference date: Wednesday 2026-10-21 10:00:00 local time
  const ref = new Date(2026, 9, 21, 10, 0, 0); // Month 9 is October in 0-indexed JS Date

  // 1. daily 12:00 -> later today at 12:00
  const nextDailyToday = new Date(computeNextRunAt('daily 12:00', ref));
  assert.equal(nextDailyToday.getDate(), 21);
  assert.equal(nextDailyToday.getHours(), 12);
  assert.equal(nextDailyToday.getMinutes(), 0);

  // 2. daily 08:00 -> tomorrow at 08:00
  const nextDailyTomorrow = new Date(computeNextRunAt('daily 08:00', ref));
  assert.equal(nextDailyTomorrow.getDate(), 22);
  assert.equal(nextDailyTomorrow.getHours(), 8);
  assert.equal(nextDailyTomorrow.getMinutes(), 0);

  // 3. weekly fri 14:00 (Wed 21 -> Fri 23)
  const nextFri = new Date(computeNextRunAt('weekly fri 14:00', ref));
  assert.equal(nextFri.getDate(), 23);
  assert.equal(nextFri.getDay(), 5); // Friday
  assert.equal(nextFri.getHours(), 14);

  // 4. every 15 minutes
  const nextEvery = new Date(computeNextRunAt('every 15 minutes', ref));
  assert.equal(nextEvery.getTime(), ref.getTime() + 15 * 60 * 1000);
});

test('schedules: missed run during downtime is caught up exactly once', async () => {
  const { ctx, projectDir, cleanup } = createSchedulesTestContext('missed_run');
  try {
    // Schedule with next_run_at in the past
    const sch = await saveSchedule(ctx, {
      name: 'Nightly Review',
      when: 'daily 02:00',
      action: {
        type: 'card',
        card: {
          title: 'Nightly Card',
          prompt: 'Do review',
          project_path: projectDir,
          mode: 'task',
          agent: 'claude',
          role: 'reviewer',
        },
      },
    });

    // Artificially set next_run_at to 3 hours ago (simulating server was down)
    const file = path.join(ctx.paths.featureDataDir('schedules'), 'schedules.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.schedules[0].next_run_at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');

    // First ticker run: catches up once!
    await scheduleTicker(ctx);
    const updated = (await getSchedules(ctx))[0]!;
    assert.ok(updated.last_result.startsWith('created task_'));
    assert.ok(updated.last_run_at);

    // Verify next_run_at is now computed from now (in the future)
    assert.ok(Date.parse(updated.next_run_at) > Date.now());

    // Second ticker run: does not create another duplicate task!
    const resultBefore = updated.last_result;
    await scheduleTicker(ctx);
    const updated2 = (await getSchedules(ctx))[0]!;
    assert.equal(updated2.last_result, resultBefore);
  } finally {
    cleanup();
  }
});

test('schedules: skip_if_running prevents overlapping card creation', async () => {
  const { ctx, projectDir, cleanup } = createSchedulesTestContext('skip_running');
  try {
    const sch = await saveSchedule(ctx, {
      name: 'Audit Schedule',
      when: 'every 5 minutes',
      skip_if_running: true,
      action: {
        type: 'card',
        card: {
          title: 'Audit Task',
          prompt: 'Audit files',
          project_path: projectDir,
          mode: 'task',
          agent: 'claude',
          role: 'backend',
        },
      },
    });

    // Run 1: creates task
    await runScheduleNow(ctx, sch.id);
    const schAfter1 = (await getSchedules(ctx))[0]!;
    assert.ok(schAfter1.last_result.startsWith('created task_'));
    const createdTaskId = schAfter1.last_result.split(' ')[1]!;

    // Leave the card in 'running' state
    const card = (await getCard(ctx, createdTaskId))!;
    card.status = 'running';
    await saveCard(ctx, card);

    // Fast-forward schedule next_run_at to past
    const file = path.join(ctx.paths.featureDataDir('schedules'), 'schedules.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.schedules[0].next_run_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');

    // Ticker runs: previous is running -> skips!
    await scheduleTicker(ctx);
    const schAfter2 = (await getSchedules(ctx))[0]!;
    assert.equal(schAfter2.last_result, 'skipped (previous still running)');
  } finally {
    cleanup();
  }
});

test('schedules: delete schedule and audit logging', async () => {
  const { ctx, projectDir, cleanup } = createSchedulesTestContext('delete');
  try {
    const sch = await saveSchedule(ctx, {
      name: 'Temp Schedule',
      when: 'every 10 minutes',
      action: {
        type: 'card',
        card: {
          title: 'Temp Task',
          prompt: 'Temp Prompt',
          project_path: projectDir,
          mode: 'task',
          agent: 'claude',
          role: 'backend',
        },
      },
    });

    const deletedId = await deleteSchedule(ctx, sch.id);
    assert.equal(deletedId, sch.id);

    const list = await getSchedules(ctx);
    assert.equal(list.length, 0);

    // Check audit file
    assert.ok(fs.existsSync(ctx.paths.auditFile));
    const auditText = fs.readFileSync(ctx.paths.auditFile, 'utf8');
    assert.ok(auditText.includes('schedule_delete'));
  } finally {
    cleanup();
  }
});
