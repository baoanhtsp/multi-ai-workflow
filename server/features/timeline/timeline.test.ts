import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext } from '../../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import { handleTimeline, handleTimelineAdd, handleTimelineReport } from './actions.ts';
import { buildTimeline } from './builder.ts';
import { appendTimelineEvent } from './events.ts';

function createTempTestPaths(): { paths: ServerPaths; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maw_timeline_test_'));
  const userProfile = path.join(tmpRoot, 'UserProfile');
  const mawHome = path.join(tmpRoot, 'MawHome');
  const jobsDir = path.join(tmpRoot, 'jobs');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const paths = resolveServerPaths({
    repoRoot,
    userProfile,
    mawHome,
  });
  paths.jobsDir = jobsDir;

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    },
  };
}

test('timeline event append, read, and lane grouping with audit join', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const now = new Date();
    const tStart = new Date(now.getTime() - 3600_000).toISOString();
    const tEnd = new Date(now.getTime() - 1800_000).toISOString();

    // 1. Add timeline events
    appendTimelineEvent(paths, {
      ts: tStart,
      event: 'job-start',
      job_id: 'job_tl_1',
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      project: paths.repoRoot,
      status: 'RUNNING',
      start: tStart,
    });

    appendTimelineEvent(paths, {
      ts: tEnd,
      event: 'job-finish',
      job_id: 'job_tl_1',
      mode: 'task',
      agent: 'claude',
      role: 'backend',
      project: paths.repoRoot,
      status: 'DONE',
      exit_code: 0,
      end: tEnd,
    });

    // 2. Add fake audit row matching this job
    fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
    const auditRow = {
      Timestamp: new Date(now.getTime() - 2000_000).toISOString(),
      Tool: 'claude',
      Role: 'backend',
      Model: 'sonnet',
      WorkDir: paths.repoRoot,
      PromptChars: 1200,
      OutputChars: 800,
      InputTokens: 350,
      OutputTokens: 200,
      CostUsd: 0.005,
      Score: '9/10',
      Verdict: 'APPROVED',
    };
    fs.writeFileSync(paths.auditFile, JSON.stringify(auditRow) + '\n', 'utf8');

    // 3. Build timeline
    const data = buildTimeline(paths, registry);
    assert.ok(data.lanes.length > 0);

    const claudeLane = data.lanes.find((l) => l.agent === 'claude');
    assert.ok(claudeLane);
    assert.equal(claudeLane.items.length, 1);

    const item = claudeLane.items[0]!;
    assert.equal(item.id, 'job_tl_1');
    assert.equal(item.status, 'DONE');
    assert.equal(item.cost_usd, 0.005);
    assert.equal(item.score, '9/10');
    assert.equal(item.verdict, 'APPROVED');

    assert.equal(data.totals.jobs, 1);
    assert.equal(data.totals.done, 1);
  } finally {
    cleanup();
  }
});

test('timeline report generates markdown and escaped html', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    appendTimelineEvent(paths, {
      ts: new Date().toISOString(),
      event: 'handoff',
      agent: 'codex',
      title: 'Review <script>alert(1)</script>',
      start: new Date().toISOString(),
      status: 'DONE',
    });

    // Markdown report
    const reqMd = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=timeline_report&format=md'),
      query: new URLSearchParams('format=md'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const resMd = (await handleTimelineReport(ctx, reqMd)) as {
      ok: boolean;
      filename: string;
      content: string;
    };
    assert.equal(resMd.ok, true);
    assert.ok(resMd.filename.endsWith('.md'));
    assert.ok(resMd.content.includes('# Multi-AI Mission Control Report'));

    // HTML report with HTML escaping
    const reqHtml = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=timeline_report&format=html'),
      query: new URLSearchParams('format=html'),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const resHtml = (await handleTimelineReport(ctx, reqHtml)) as {
      ok: boolean;
      filename: string;
      content: string;
    };
    assert.equal(resHtml.ok, true);
    assert.ok(resHtml.filename.endsWith('.html'));
    assert.ok(!resHtml.content.includes('<script>alert(1)</script>'));
    assert.ok(resHtml.content.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  } finally {
    cleanup();
  }
});

test('Timeline Round 3 Item 5: project filter exact path normalization and report reviewer rows filtering', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);
    const now = new Date();
    const tStart = new Date(now.getTime() - 10_000).toISOString();
    const tEnd = now.toISOString();

    const projA = 'C:\\Projects\\AppAlpha\\';
    const projB = 'C:\\Projects\\AppAlpha\\submodule';

    // 1. Event in projA with forward slashes and trailing slash
    appendTimelineEvent(paths, {
      ts: tStart,
      event: 'job-start',
      job_id: 'job_proj_a',
      agent: 'claude',
      project: 'c:/projects/appalpha/',
      status: 'DONE',
      start: tStart,
      end: tEnd,
    });

    // 2. Event in projB (subpath)
    appendTimelineEvent(paths, {
      ts: tStart,
      event: 'job-start',
      job_id: 'job_proj_b',
      agent: 'codex',
      project: projB,
      status: 'DONE',
      start: tStart,
      end: tEnd,
    });

    // 3. Event without project
    appendTimelineEvent(paths, {
      ts: tStart,
      event: 'job-start',
      job_id: 'job_no_proj',
      agent: 'gemini',
      status: 'DONE',
      start: tStart,
      end: tEnd,
    });

    // Audit file with 3 rows
    fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
    const auditRows = [
      {
        Timestamp: tStart,
        Tool: 'claude',
        Role: 'reviewer',
        WorkDir: projA,
        Score: '9/10',
        Verdict: 'APPROVED',
      },
      {
        Timestamp: tStart,
        Tool: 'codex',
        Role: 'reviewer',
        WorkDir: projB, // Different project
        Score: '5/10',
        Verdict: 'CHANGES_REQUESTED',
      },
      {
        Timestamp: new Date(now.getTime() - 48 * 3600_000).toISOString(), // Outside 24h window
        Tool: 'claude',
        Role: 'reviewer',
        WorkDir: projA,
        Score: '8/10',
        Verdict: 'APPROVED',
      },
    ];
    fs.writeFileSync(paths.auditFile, auditRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // Query timeline with project filter
    const timelineData = buildTimeline(paths, registry, {
      project: 'C:\\Projects\\AppAlpha',
    });

    // Should only have job_proj_a
    const allItems = timelineData.lanes.flatMap((l) => l.items);
    assert.equal(allItems.length, 1, 'Only exact project match must be included');
    assert.equal(allItems[0]!.id, 'job_proj_a');

    // Report with project filter
    const report = await handleTimelineReport(ctx, {
      ...ctx,
      query: new URLSearchParams('format=md&project=C:\\Projects\\AppAlpha'),
    } as any) as any;

    assert.equal(report.ok, true);
    assert.ok(report.content.includes('9/10'), 'Matching audit row should be in report');
    assert.ok(!report.content.includes('5/10'), 'Other project audit row must be excluded');
    assert.ok(!report.content.includes('8/10'), 'Outside window audit row must be excluded');
  } finally {
    cleanup();
  }
});

test('Timeline Round 3 Item 9: totals do not double count multi-tool sub-items', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const now = new Date();
    const tStart = new Date(now.getTime() - 20_000).toISOString();
    const tEnd = now.toISOString();

    // Team job
    appendTimelineEvent(paths, {
      ts: tStart,
      event: 'job-start',
      job_id: 'job_team_1',
      mode: 'team',
      agent: 'claude',
      role: 'backend',
      project: paths.repoRoot,
      status: 'DONE',
      start: tStart,
      end: tEnd,
    });

    // Two reviewer audit rows for this team job
    fs.mkdirSync(path.dirname(paths.auditFile), { recursive: true });
    const auditRows = [
      {
        Timestamp: new Date(now.getTime() - 10_000).toISOString(),
        Tool: 'codex',
        Role: 'reviewer',
        WorkDir: paths.repoRoot,
        PromptChars: 500,
        OutputChars: 500,
        InputTokens: 200,
        OutputTokens: 100,
        Score: '8/10',
        Verdict: 'APPROVED',
      },
      {
        Timestamp: new Date(now.getTime() - 5_000).toISOString(),
        Tool: 'gemini',
        Role: 'critic',
        WorkDir: paths.repoRoot,
        PromptChars: 500,
        OutputChars: 500,
        InputTokens: 200,
        OutputTokens: 100,
        Score: '9/10',
        Verdict: 'APPROVED',
      },
    ];
    fs.writeFileSync(paths.auditFile, auditRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const data = buildTimeline(paths, registry);

    // Verify sub-items exist on their lanes
    const codexLane = data.lanes.find((l) => l.agent === 'codex');
    assert.ok(codexLane && codexLane.items.length === 1);
    assert.equal(codexLane.items[0]!.sub, true, 'Sub-item must have sub: true');

    // Totals MUST count only parent job
    assert.equal(data.totals.jobs, 1, 'Total jobs must be 1, not 3 (no double counting)');
    assert.equal(data.totals.done, 1, 'Done jobs must be 1');
    assert.equal(data.totals.failed, 0, 'Failed jobs must be 0');
  } finally {
    cleanup();
  }
});
