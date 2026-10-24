import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { feature } from '../index.ts';

// The real temp dir, captured before any test points TEMP at its own folder.
const ORIG_TMP = os.tmpdir();

function setupTestContext() {
  const tempBase = fs.mkdtempSync(path.join(ORIG_TMP, 'maw space memory test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'my-app');
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

  const baseCtx = createFeatureContext(paths);
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

  return { tempBase, paths, baseCtx, makeReq, testProj };
}

test('memory: Add, list, update, context search, and delete entries', async () => {
  const { makeReq, testProj, paths } = setupTestContext();

  // 1. Add first entry (pinned)
  const addReq1 = makeReq({
    project_path: testProj,
    title: 'Use SSE for Live Streaming',
    body: 'Server Sent Events provides real-time chunk streaming with automatic reconnects.',
    tags: ['api', 'streaming'],
    pinned: true,
  });
  const addRes1 = (await feature.routes['memory_add']!.handler(addReq1, addReq1)) as any;
  assert.equal(addRes1.ok, true);
  assert.equal(addRes1.entry.id, 'ADR-0001');
  assert.equal(addRes1.entry.pinned, true);

  // 2. Add second entry
  const addReq2 = makeReq({
    project_path: testProj,
    title: 'Use SQLite for persistence',
    body: 'SQLite provides file-based SQL storage for local workflows.',
    tags: ['database'],
    pinned: false,
  });
  const addRes2 = (await feature.routes['memory_add']!.handler(addReq2, addReq2)) as any;
  assert.equal(addRes2.ok, true);
  assert.equal(addRes2.entry.id, 'ADR-0002');

  // 3. List entries
  const listReq = makeReq({}, { project_path: testProj });
  const listRes = (await feature.routes['memory_list']!.handler(listReq, listReq)) as any;
  assert.equal(listRes.ok, true);
  assert.equal(listRes.entries.length, 2);

  // 4. Update entry
  const updateReq = makeReq({
    project_path: testProj,
    id: 'ADR-0002',
    title: 'Use SQLite with WAL mode',
  });
  const updateRes = (await feature.routes['memory_update']!.handler(updateReq, updateReq)) as any;
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.entry.title, 'Use SQLite with WAL mode');

  // 5. Memory context ranking
  const ctxReq = makeReq({}, { project_path: testProj, q: 'database storage', max_chars: '2000' });
  const ctxRes = (await feature.routes['memory_context']!.handler(ctxReq, ctxReq)) as any;
  assert.equal(ctxRes.ok, true);
  assert.ok(ctxRes.text.includes('ADR-0001'), 'Pinned entry appears');
  assert.ok(ctxRes.text.includes('ADR-0002'), 'Relevant entry appears');
  assert.ok(ctxRes.ids.includes('ADR-0001'));
  assert.ok(ctxRes.ids.includes('ADR-0002'));

  // 6. Delete entry
  const delReq = makeReq({ project_path: testProj, id: 'ADR-0002' });
  const delRes = (await feature.routes['memory_delete']!.handler(delReq, delReq)) as any;
  assert.equal(delRes.ok, true);

  // Verify deletion in list
  const listReqAfter = makeReq({}, { project_path: testProj });
  const listResAfter = (await feature.routes['memory_list']!.handler(listReqAfter, listReqAfter)) as any;
  assert.equal(listResAfter.entries.length, 1);
  assert.equal(listResAfter.entries[0].id, 'ADR-0001');

  // Verify audit log
  const auditFile = path.win32.join(paths.featureDataDir('memory'), 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile));
  const auditContent = fs.readFileSync(auditFile, 'utf8');
  assert.ok(auditContent.includes('memory_delete'));
  assert.ok(auditContent.includes('ADR-0002'));
});

test('memory: Validation errors for missing project_path, invalid tags or title', async () => {
  const { makeReq } = setupTestContext();

  await assert.rejects(
    async () => {
      const req = makeReq({ project_path: '', title: 'Test', body: 'Body' });
      await feature.routes['memory_add']!.handler(req, req);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  await assert.rejects(
    async () => {
      const req = makeReq({ project_path: 'C:\\fake', title: 'A'.repeat(150), body: 'Body' });
      await feature.routes['memory_add']!.handler(req, req);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );
});

test('memory: [memory] getMemoryContext excludes unpinned entries with score 0', async () => {
  const { makeReq, testProj } = setupTestContext();

  // 1. Add unpinned entry about databases
  const addUnpinned = makeReq({
    project_path: testProj,
    title: 'Database connection pooling',
    body: 'Use pg-pool with max 10 connections for PostgreSQL.',
    tags: ['database', 'postgres'],
    pinned: false,
  });
  await feature.routes['memory_add']!.handler(addUnpinned, addUnpinned);

  // 2. Add pinned entry about style
  const addPinned = makeReq({
    project_path: testProj,
    title: 'Code style guidelines',
    body: 'Always use strict TypeScript with forward slashes.',
    tags: ['guidelines'],
    pinned: true,
  });
  await feature.routes['memory_add']!.handler(addPinned, addPinned);

  // 3. Search with unrelated prompt: "quantum mechanics astronomy"
  // Unpinned database entry will score 0 and must be excluded.
  // Pinned guidelines entry must be included regardless of score.
  const searchReq = makeReq({}, { project_path: testProj, prompt: 'quantum mechanics astronomy' });
  const searchRes = (await feature.routes['memory_context']!.handler(searchReq, searchReq)) as any;
  assert.equal(searchRes.ok, true);
  assert.ok(searchRes.text.includes('Code style guidelines'));
  assert.ok(!searchRes.text.includes('Database connection pooling'));
});

test('memory: [Item 3] memory_add rejects junction escape on .maw with 400', async () => {
  const { makeReq, testProj } = setupTestContext();

  const outsideDir = path.join(os.tmpdir(), 'evil-mem-outside-' + Date.now());
  fs.mkdirSync(outsideDir, { recursive: true });
  const dotMaw = path.join(testProj, '.maw');

  let junctionCreated = false;
  try {
    fs.symlinkSync(outsideDir, dotMaw, 'junction');
    junctionCreated = true;
  } catch {}

  if (junctionCreated) {
    try {
      const addReq = makeReq({
        project_path: testProj,
        title: 'ADR with junction escape',
        body: 'This should be refused with 400',
      });
      await assert.rejects(
        async () => {
          await feature.routes['memory_add']!.handler(addReq, addReq);
        },
        (err: any) => err instanceof ApiValidationError && err.statusCode === 400
      );
    } finally {
      try { fs.unlinkSync(dotMaw); } catch {}
      try { fs.rmdirSync(outsideDir); } catch {}
    }
  }
});
