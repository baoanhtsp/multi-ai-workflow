import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  parsePlaybookContent,
  tickBoxInFile,
  validatePlaybookFile,
} from '../parser.ts';
import {
  getPlaybookRuns,
  playbookTicker,
  startPlaybookRun,
  stopPlaybookRun,
} from '../runs.ts';
import { deleteCard, getCard, moveCard, saveCard } from '../../tasks/store.ts';
import { feature as playbooksFeature } from '../index.ts';

function createPlaybookTestContext(testName: string): {
  ctx: MawFeatureContext;
  tempMawHome: string;
  projectDir: string;
  playbookFile: string;
  cleanup: () => void;
} {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempMawHome = path.join(os.tmpdir(), `maw_pb_test_${testName}_${rand}`);
  const tempProjects = path.join(tempMawHome, 'projects');
  const projectDir = path.join(tempProjects, 'my-project');
  const playbooksDir = path.join(projectDir, '.maw', 'playbooks');
  const playbookFile = path.join(playbooksDir, 'release.md');

  fs.mkdirSync(playbooksDir, { recursive: true });

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
    startJob: async (body: Record<string, unknown>) => {
      const jobId = `job_pb_${Date.now()}`;
      return { ok: true, job_id: jobId, status: 'RUNNING' };
    },
  };

  const cleanup = () => {
    try {
      fs.rmSync(tempMawHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { ctx, tempMawHome, projectDir, playbookFile, cleanup };
}

test('playbooks: parse nested, checked, continuation lines, headings', () => {
  const content = `# Preparation
- [x] Initial task done
- [ ] Task with continuation
    More details on line 2
    Even more details on line 3
## Deployment
* [X] Already deployed
* [ ] Final step`;

  const items = parsePlaybookContent(content);
  assert.equal(items.length, 4);

  assert.equal(items[0]!.text, 'Initial task done');
  assert.equal(items[0]!.checked, true);
  assert.equal(items[0]!.section, 'Preparation');

  assert.equal(
    items[1]!.text,
    'Task with continuation\nMore details on line 2\nEven more details on line 3'
  );
  assert.equal(items[1]!.checked, false);
  assert.equal(items[1]!.section, 'Preparation');

  assert.equal(items[2]!.text, 'Already deployed');
  assert.equal(items[2]!.checked, true);
  assert.equal(items[2]!.section, 'Deployment');

  assert.equal(items[3]!.text, 'Final step');
  assert.equal(items[3]!.checked, false);
  assert.equal(items[3]!.section, 'Deployment');
});

test('playbooks: path outside project rejected', () => {
  const { projectDir, cleanup } = createPlaybookTestContext('sec_path');
  try {
    // Sibling directory traversal attempt
    assert.throws(() => {
      validatePlaybookFile(projectDir, '../../outside.md');
    }, /must be inside project/i);

    // Non-markdown file rejected
    const nonMd = path.join(projectDir, 'test.txt');
    fs.writeFileSync(nonMd, 'hello');
    assert.throws(() => {
      validatePlaybookFile(projectDir, 'test.txt');
    }, /\.md extension/i);
  } finally {
    cleanup();
  }
});

test('playbooks: tickBoxInFile rewrites only targeted line preserving CRLF and BOM', () => {
  const { projectDir, cleanup } = createPlaybookTestContext('crlf_bom');
  try {
    const filePath = path.join(projectDir, 'test_bom.md');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bodyText = '# Header\r\n- [ ] First item\r\n- [ ] Second item\r\n';
    fs.writeFileSync(filePath, Buffer.concat([bom, Buffer.from(bodyText, 'utf8')]));

    // Tick first item
    const ticked = tickBoxInFile(filePath, 2, 'First item');
    assert.equal(ticked, 'ticked');

    const afterBuf = fs.readFileSync(filePath);
    // Verify BOM still present
    assert.equal(afterBuf[0], 0xef);
    assert.equal(afterBuf[1], 0xbb);
    assert.equal(afterBuf[2], 0xbf);

    const afterText = afterBuf.toString('utf8');
    // Verify CRLF preserved
    assert.ok(afterText.includes('\r\n'));
    assert.ok(afterText.includes('- [x] First item\r\n- [ ] Second item'));
  } finally {
    cleanup();
  }
});

test('playbooks: run creates ordered cards and ticker advances item by item', async () => {
  const { ctx, projectDir, playbookFile, cleanup } =
    createPlaybookTestContext('run_advance');
  try {
    const content = `# Section 1
- [ ] Task 1
- [ ] Task 2`;
    fs.writeFileSync(playbookFile, content, 'utf8');

    const { run, tasks } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      on_failure: 'stop',
    });

    assert.equal(run.items.length, 2);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.status, 'backlog');
    assert.equal(tasks[1]!.status, 'backlog');

    // First ticker run: queues first item
    await playbookTicker(ctx);
    const card1 = (await getCard(ctx, tasks[0]!.id))!;
    assert.equal(card1.status, 'queued');

    // Simulate card 1 done
    card1.status = 'done';
    await saveCard(ctx, card1);

    // Second ticker run: ticks box for task 1, advances cursor, queues task 2
    await playbookTicker(ctx);
    const card2 = (await getCard(ctx, tasks[1]!.id))!;
    assert.equal(card2.status, 'queued');

    // Check that file was ticked for Task 1
    const fileContent = fs.readFileSync(playbookFile, 'utf8');
    assert.ok(fileContent.includes('- [x] Task 1'));
    assert.ok(fileContent.includes('- [ ] Task 2'));

    // Simulate card 2 done
    card2.status = 'done';
    await saveCard(ctx, card2);

    // Third ticker run: marks run done
    await playbookTicker(ctx);
    const runs = await getPlaybookRuns(ctx, projectDir);
    const currentRun = runs.find((r) => r.id === run.id)!;
    assert.equal(currentRun.status, 'done');
  } finally {
    cleanup();
  }
});

test('playbooks: stop vs continue on card failure', async () => {
  const { ctx, projectDir, playbookFile, cleanup } =
    createPlaybookTestContext('stop_vs_cont');
  try {
    // 1. on_failure = 'stop'
    fs.writeFileSync(playbookFile, '- [ ] Task 1\n- [ ] Task 2', 'utf8');
    const { run: runStop, tasks: tasksStop } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      on_failure: 'stop',
    });

    await playbookTicker(ctx);
    const cardStop1 = (await getCard(ctx, tasksStop[0]!.id))!;
    cardStop1.status = 'failed';
    await saveCard(ctx, cardStop1);

    await playbookTicker(ctx);
    const runs1 = await getPlaybookRuns(ctx, projectDir);
    const r1 = runs1.find((r) => r.id === runStop.id)!;
    assert.equal(r1.status, 'failed');

    const cardStop2 = (await getCard(ctx, tasksStop[1]!.id))!;
    assert.equal(cardStop2.status, 'backlog');
    assert.equal(cardStop2.status_reason, 'playbook stopped');

    // 2. on_failure = 'continue'
    const { run: runCont, tasks: tasksCont } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      on_failure: 'continue',
    });

    await playbookTicker(ctx);
    const cardCont1 = (await getCard(ctx, tasksCont[0]!.id))!;
    cardCont1.status = 'failed';
    await saveCard(ctx, cardCont1);

    // Ticker advances to next task despite task 1 failing
    await playbookTicker(ctx);
    const cardCont2 = (await getCard(ctx, tasksCont[1]!.id))!;
    assert.equal(cardCont2.status, 'queued');
  } finally {
    cleanup();
  }
});

test('playbooks: ticker handles deleted cards and backlog re-queuing', async () => {
  const { ctx, projectDir, playbookFile, cleanup } = createPlaybookTestContext('ticker_resiliency');
  try {
    fs.writeFileSync(
      playbookFile,
      '# Process\n- [ ] Step A\n- [ ] Step B\n- [ ] Step C\n',
      'utf8'
    );

    // 1. Test deleted card with on_failure = 'continue'
    const { tasks } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      mode: 'task',
      agent: 'antigravity',
      role: 'backend',
      on_failure: 'continue',
    });

    // Start Step A
    await playbookTicker(ctx);
    const runs1 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs1[0]!.items[0]!.state, 'running');

    // Delete Step A's card while running
    await deleteCard(ctx, tasks[0]!.id);

    // Ticker runs: should mark item 0 'skipped' and advance to Step B
    await playbookTicker(ctx);
    const runs2 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs2[0]!.items[0]!.state, 'skipped');
    assert.equal(runs2[0]!.cursor, 1);
    assert.equal(runs2[0]!.items[1]!.state, 'running');

    // Step B is running: simulate card moved back to backlog
    const cardB = (await getCard(ctx, tasks[1]!.id))!;
    await moveCard(ctx, cardB.id, 'backlog');

    // Ticker runs: re-queues card B
    await playbookTicker(ctx);
    const refreshedCardB = (await getCard(ctx, tasks[1]!.id))!;
    assert.equal(refreshedCardB.status, 'queued');
  } finally {
    cleanup();
  }
});

test('playbooks: project path outside projectsRoot rejected with 400 across list, preview, and run', async () => {
  const { ctx, cleanup } = createPlaybookTestContext('path_validation');
  try {
    const outsidePath = path.resolve(os.tmpdir(), 'outside_project_boundary');
    fs.mkdirSync(outsidePath, { recursive: true });

    // 1. playbook_list
    await assert.rejects(
      async () => {
        await playbooksFeature.routes.playbook_list.handler(ctx as any, {
          url: new URL(`http://localhost/playbook_list?project_path=${encodeURIComponent(outsidePath)}`),
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 2. playbook_preview
    await assert.rejects(
      async () => {
        await playbooksFeature.routes.playbook_preview.handler(ctx as any, {
          url: new URL(
            `http://localhost/playbook_preview?project_path=${encodeURIComponent(outsidePath)}&file=test.md`
          ),
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );

    // 3. playbook_run
    await assert.rejects(
      async () => {
        await playbooksFeature.routes.playbook_run.handler(ctx as any, {
          body: {
            project_path: outsidePath,
            file: 'test.md',
          },
        } as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not valid or outside projectsRoot/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('playbooks: tickBoxInFile failure keeps item in running state and retries on next tick', async () => {
  const { ctx, projectDir, playbookFile, cleanup } = createPlaybookTestContext('tick_failure_retry');
  try {
    fs.writeFileSync(playbookFile, '# Steps\n- [ ] Critical Task\n', 'utf8');

    const { tasks } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      mode: 'task',
      agent: 'antigravity',
      role: 'backend',
    });

    // Advance ticker: task starts running
    await playbookTicker(ctx);
    const runs1 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs1[0]!.items[0]!.state, 'running');

    // Simulate task card completed (done)
    const card = (await getCard(ctx, tasks[0]!.id))!;
    card.status = 'done';
    await saveCard(ctx, card);

    // Simulate file write/rename failure by temporarily making the directory or file inaccessible
    // On Windows, opening the file with exclusive lock causes renameSync to fail
    const lockFd = fs.openSync(playbookFile, 'r+');

    try {
      // Ticker runs: tickBoxInFile will fail to rename because file is open/locked
      await playbookTicker(ctx);
      const runsAfterLock = await getPlaybookRuns(ctx, projectDir);
      // Item must remain in 'running' state, cursor still 0!
      assert.equal(runsAfterLock[0]!.items[0]!.state, 'running');
      assert.equal(runsAfterLock[0]!.cursor, 0);
    } finally {
      fs.closeSync(lockFd);
    }

    // Now file is unlocked: next ticker call must succeed and mark item done
    await playbookTicker(ctx);
    const runsAfterUnlock = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runsAfterUnlock[0]!.items[0]!.state, 'done');
    assert.equal(runsAfterUnlock[0]!.cursor, 1);
    assert.equal(runsAfterUnlock[0]!.status, 'done');

    const updatedContent = fs.readFileSync(playbookFile, 'utf8');
    assert.ok(updatedContent.includes('- [x] Critical Task'));
  } finally {
    cleanup();
  }
});

test('playbooks: already-checked playbook item advances run without stalling or emitting audit line', async () => {
  const { ctx, projectDir, playbookFile, cleanup } = createPlaybookTestContext('already_checked_advance');
  try {
    fs.writeFileSync(
      playbookFile,
      '# Steps\n- [x] Pre-checked item\n- [ ] Fresh item\n',
      'utf8'
    );

    const { tasks } = await startPlaybookRun(ctx, {
      project_path: projectDir,
      file: playbookFile,
      include_checked: true,
      mode: 'task',
      agent: 'antigravity',
      role: 'backend',
    });

    // Start item 0
    await playbookTicker(ctx);
    const runs1 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs1[0]!.items[0]!.state, 'running');

    // Complete item 0
    const card0 = (await getCard(ctx, tasks[0]!.id))!;
    card0.status = 'done';
    await saveCard(ctx, card0);

    // Ticker runs: item 0 was already checked in file!
    // Should NOT stall: advances to done, cursor advances to 1, but NO audit line emitted!
    await playbookTicker(ctx);
    const runs2 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs2[0]!.items[0]!.state, 'done');
    assert.equal(runs2[0]!.cursor, 1);
    assert.equal(runs2[0]!.items[1]!.state, 'running');

    // Check audit file: must NOT contain audit for Pre-checked item
    if (fs.existsSync(ctx.paths.auditFile)) {
      const auditLog = fs.readFileSync(ctx.paths.auditFile, 'utf8');
      assert.equal(auditLog.includes('Pre-checked item'), false);
    }

    // Now complete item 1 (which was unchecked in file)
    const card1 = (await getCard(ctx, tasks[1]!.id))!;
    card1.status = 'done';
    await saveCard(ctx, card1);

    // Ticker runs: item 1 was unchecked, so it ticks it and emits audit line
    await playbookTicker(ctx);
    const runs3 = await getPlaybookRuns(ctx, projectDir);
    assert.equal(runs3[0]!.items[1]!.state, 'done');
    assert.equal(runs3[0]!.cursor, 2);
    assert.equal(runs3[0]!.status, 'done');

    const auditLogFinal = fs.readFileSync(ctx.paths.auditFile, 'utf8');
    assert.ok(auditLogFinal.includes('Fresh item'));
  } finally {
    cleanup();
  }
});

test('playbooks: tickBoxInFile returns already only on exact item text equality, rejecting substring match', () => {
  const { projectDir, cleanup } = createPlaybookTestContext('exact_match_tick');
  try {
    const filePath = path.join(projectDir, 'exact_test.md');
    fs.writeFileSync(
      filePath,
      '# Process\n- [x] Deploy to production environment\n- [ ] Deploy\n',
      'utf8'
    );

    // 1. Ticking "- [ ] Deploy" at line 3 must NOT return 'already' just because line 2 has "Deploy" substring
    const res1 = tickBoxInFile(filePath, 3, 'Deploy');
    assert.equal(res1, 'ticked', 'Must tick unchecked Deploy, not treat as already from substring in line 2');

    const contentAfterTick = fs.readFileSync(filePath, 'utf8');
    assert.ok(contentAfterTick.includes('- [x] Deploy\n'));

    // 2. Ticking line 3 now that it is checked returns 'already' because "- [x] Deploy" === "Deploy"
    const res2 = tickBoxInFile(filePath, 3, 'Deploy');
    assert.equal(res2, 'already');

    // 3. Substring target "Deploy to" must return 'failed', not 'already', even though line 2 starts with "Deploy to production environment"
    const res3 = tickBoxInFile(filePath, 99, 'Deploy to');
    assert.equal(res3, 'failed', 'Must not match substring "Deploy to" against "Deploy to production environment"');
  } finally {
    cleanup();
  }
});
