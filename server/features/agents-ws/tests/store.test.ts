import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { runCommand } from '../../../lib/proc.ts';
import { feature } from '../index.ts';
import { getDirtyFilesWithHashes } from '../lib/git.ts';
import { assertSafeProjectMawWrite } from '../lib/security.ts';
import { writeJsonStore } from '../lib/store.ts';

// The real temp dir, captured before any test points TEMP at its own folder.
const ORIG_TMP = os.tmpdir();

function setupTestContext() {
  const tempBase = fs.mkdtempSync(path.join(ORIG_TMP, 'maw space test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'test-app');
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

test('store: Create, update, soft delete, restore, duplicate and move agent', async () => {
  const { makeReq, testProj } = setupTestContext();

  // 1. Create agent
  const createReq = makeReq({
    agent: {
      name: 'Agent Alpha',
      platform: 'claude',
      workdir: testProj,
      role: 'backend',
      persona: 'Backend developer',
    },
  });
  const createRes = (await feature.routes['ws_agent_save']!.handler(createReq, createReq)) as any;
  assert.equal(createRes.ok, true);
  assert.ok(createRes.agent.id.startsWith('ag_'));
  assert.equal(createRes.agent.name, 'Agent Alpha');
  const agentId = createRes.agent.id;

  // 2. Update agent
  const updateReq = makeReq({
    agent: {
      id: agentId,
      name: 'Agent Alpha Pro',
      platform: 'claude',
      workdir: testProj,
      role: 'architect',
    },
  });
  const updateRes = (await feature.routes['ws_agent_save']!.handler(updateReq, updateReq)) as any;
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.agent.name, 'Agent Alpha Pro');
  assert.equal(updateRes.agent.role, 'architect');

  // 3. Duplicate agent
  const dupReq = makeReq({ id: agentId });
  const dupRes = (await feature.routes['ws_agent_duplicate']!.handler(dupReq, dupReq)) as any;
  assert.equal(dupRes.ok, true);
  assert.notEqual(dupRes.agent.id, agentId);
  assert.equal(dupRes.agent.name, 'Agent Alpha Pro (copy)');

  // 4. Create group and move agent
  const grpReq = makeReq({ group: { name: 'Core Team' } });
  const grpRes = (await feature.routes['ws_group_save']!.handler(grpReq, grpReq)) as any;
  assert.equal(grpRes.ok, true);
  const groupId = grpRes.group.id;

  const moveReq = makeReq({ id: agentId, group_id: groupId });
  const moveRes = (await feature.routes['ws_agent_move']!.handler(moveReq, moveReq)) as any;
  assert.equal(moveRes.ok, true);
  assert.equal(moveRes.agent.group_id, groupId);

  // 5. Soft delete agent
  const delReq = makeReq({ id: agentId });
  const delRes = (await feature.routes['ws_agent_delete']!.handler(delReq, delReq)) as any;
  assert.equal(delRes.ok, true);
  assert.ok(delRes.deleted_at);

  // 6. Restore agent
  const restoreReq = makeReq({ id: agentId });
  const restoreRes = (await feature.routes['ws_agent_restore']!.handler(restoreReq, restoreReq)) as any;
  assert.equal(restoreRes.ok, true);
  assert.equal(restoreRes.agent.deleted_at, null);

  // 7. Group delete moves agents out to ungrouped ("")
  const delGrpReq = makeReq({ id: groupId });
  const delGrpRes = (await feature.routes['ws_group_delete']!.handler(delGrpReq, delGrpReq)) as any;
  assert.equal(delGrpRes.ok, true);
  assert.ok(delGrpRes.moved >= 1);
});

test('store: Validation errors for bad platform, invalid workdir and denied env', async () => {
  const { makeReq, testProj } = setupTestContext();

  // Bad platform
  await assert.rejects(
    async () => {
      const req = makeReq({
        agent: {
          name: 'Bad Agent',
          platform: 'non-existent-ai',
          workdir: testProj,
        },
      });
      await feature.routes['ws_agent_save']!.handler(req, req);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Workdir outside projectsRoot
  await assert.rejects(
    async () => {
      const req = makeReq({
        agent: {
          name: 'Bad Agent 2',
          platform: 'claude',
          workdir: 'C:\\Windows\\System32',
        },
      });
      await feature.routes['ws_agent_save']!.handler(req, req);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Denied env key
  await assert.rejects(
    async () => {
      const req = makeReq({
        agent: {
          name: 'Bad Agent 3',
          platform: 'claude',
          workdir: testProj,
          env: {
            PATH: 'C:\\evil',
          },
        },
      });
      await feature.routes['ws_agent_save']!.handler(req, req);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );
});

test('store: [partial update] partial agent and group updates preserve existing fields', async () => {
  const { makeReq, testProj } = setupTestContext();

  // Create an initial group
  const grpReq = makeReq({
    group: {
      name: 'Designers',
      order: 10,
      collapsed: false,
    },
  });
  const grpRes = (await feature.routes['ws_group_save']!.handler(grpReq, grpReq)) as any;
  const groupId = grpRes.group.id;
  assert.equal(grpRes.group.collapsed, false);
  assert.equal(grpRes.group.name, 'Designers');

  // Partial update on group: only pass id and collapsed: true
  const partGrpReq = makeReq({
    group: {
      id: groupId,
      collapsed: true,
    },
  });
  const partGrpRes = (await feature.routes['ws_group_save']!.handler(partGrpReq, partGrpReq)) as any;
  assert.equal(partGrpRes.group.collapsed, true);
  assert.equal(partGrpRes.group.name, 'Designers'); // Preserved!
  assert.equal(partGrpRes.group.order, 10); // Preserved!

  // Create an initial agent
  const agReq = makeReq({
    agent: {
      name: 'Full Agent',
      platform: 'codex',
      model: 'gpt-6-sol',
      effort: 'medium',
      workdir: testProj,
      bookmark: false,
    },
  });
  const agRes = (await feature.routes['ws_agent_save']!.handler(agReq, agReq)) as any;
  const agentId = agRes.agent.id;
  assert.equal(agRes.agent.bookmark, false);
  assert.equal(agRes.agent.name, 'Full Agent');
  assert.equal(agRes.agent.platform, 'codex');

  // Partial update on agent: only pass id and bookmark: true
  const partAgReq = makeReq({
    agent: {
      id: agentId,
      bookmark: true,
    },
  });
  const partAgRes = (await feature.routes['ws_agent_save']!.handler(partAgReq, partAgReq)) as any;
  assert.equal(partAgRes.agent.bookmark, true);
  assert.equal(partAgRes.agent.name, 'Full Agent'); // Preserved!
  assert.equal(partAgRes.agent.platform, 'codex'); // Preserved!
  assert.equal(partAgRes.agent.workdir, testProj); // Preserved!
});

test('store: [Item 3] corrupt store file is renamed to .corrupt-<timestamp>, audited, and not overwritten', async () => {
  const { makeReq, paths } = setupTestContext();

  const agentsDir = paths.featureDataDir('agents-ws');
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentsFile = path.win32.join(agentsDir, 'agents.json');

  // Write garbage text to agents.json
  const garbageText = 'THIS IS NOT VALID JSON {[[ 12345';
  fs.writeFileSync(agentsFile, garbageText, 'utf8');

  // Request ws_state (which reads agents.json)
  const req = makeReq();
  const res = (await feature.routes['ws_state']!.handler(req, req)) as any;
  assert.equal(res.ok, true);
  assert.deepEqual(res.agents, []); // safely returned default

  // Check that agents.json is no longer the garbage file
  assert.equal(fs.existsSync(agentsFile), false);

  // Check that corrupt backup file exists and contains the exact garbage text
  const dirFiles = fs.readdirSync(agentsDir);
  const corruptFile = dirFiles.find((f) => f.startsWith('agents.json.corrupt-'));
  assert.ok(corruptFile, 'corrupt backup file must exist');
  const backupContent = fs.readFileSync(path.win32.join(agentsDir, corruptFile), 'utf8');
  assert.equal(backupContent, garbageText, 'backup file must preserve original unreadable content');

  // Check audit log
  const auditFile = path.win32.join(agentsDir, 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile), 'audit.jsonl must exist');
  const auditLines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const corruptAudit = auditLines.find((e) => e.action === 'store_corrupt' && e.target === 'agents.json');
  assert.ok(corruptAudit, 'audit log must record store_corrupt event for agents.json');
  assert.ok(corruptAudit.detail.backup.includes(corruptFile));
});

test('store: [Item 5] writeJsonStore never copies onto live file, retries with backoff and throws on lock, old file stays intact', async () => {
  const { paths } = setupTestContext();
  const testDir = paths.featureDataDir('agents-ws');
  fs.mkdirSync(testDir, { recursive: true });
  const liveFile = path.win32.join(testDir, 'locked-store.json');

  const originalContent = { version: 1, items: ['original'] };
  fs.writeFileSync(liveFile, JSON.stringify(originalContent, null, 2), 'utf8');

  const origRenameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (oldP: fs.PathLike, newP: fs.PathLike) => {
    attempts++;
    const err = new Error('EBUSY: resource locked or busy');
    (err as any).code = 'EBUSY';
    throw err;
  };

  try {
    await assert.rejects(
      async () => {
        await writeJsonStore(liveFile, { version: 2, items: ['corrupted-attempt'] });
      },
      /EBUSY/
    );
  } finally {
    fs.renameSync = origRenameSync;
  }

  assert.ok(attempts >= 10, `Expected at least 10 attempts, got ${attempts}`);
  const preservedContent = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
  assert.deepEqual(preservedContent, originalContent, 'Live file must remain intact and not overwritten');
});

test('store: [Item 3] assertSafeProjectMawWrite blocks symlink / junction escape', async () => {
  const { testProj, paths } = setupTestContext();
  const evilOutsideDir = path.join(os.tmpdir(), 'evil-maw-' + Date.now());
  fs.mkdirSync(evilOutsideDir, { recursive: true });

  const dotMaw = path.join(testProj, '.maw');
  let junctionCreated = false;
  try {
    fs.symlinkSync(evilOutsideDir, dotMaw, 'junction');
    junctionCreated = true;
  } catch {
    // If privileges don't allow creating junctions, test path component traversal
  }

  if (junctionCreated) {
    try {
      assert.throws(
        () => {
          assertSafeProjectMawWrite(testProj, path.join('.maw', 'team.json'), paths.projectsRoot);
        },
        (err: any) => err instanceof ApiValidationError && err.statusCode === 400
      );
    } finally {
      try { fs.unlinkSync(dotMaw); } catch {}
      try { fs.rmdirSync(evilOutsideDir); } catch {}
    }
  } else {
    // Non-junction boundary escape test
    assert.throws(
      () => {
        assertSafeProjectMawWrite(testProj, '..\\outside.json', paths.projectsRoot);
      },
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400
    );
  }
});

test('store: [Item 6] ws_platforms and ws_agent_save accept detected Codex models from getCodexModels', async () => {
  const { makeReq, testProj, paths } = setupTestContext();

  // Create models_cache.json in userProfile/.codex to simulate detected models
  const codexDir = path.join(paths.userProfile, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-5-codex-detected' }] }),
    'utf8'
  );

  // 1. ws_platforms returns detected model
  const platReq = makeReq();
  const platRes = (await feature.routes['ws_platforms']!.handler(platReq, platReq)) as any;
  assert.equal(platRes.ok, true);
  const codexPlat = platRes.platforms.find((p: any) => p.id === 'codex');
  assert.ok(codexPlat, 'codex platform must be present');
  assert.ok(
    codexPlat.models.includes('gpt-5-codex-detected'),
    'ws_platforms must include detected codex model'
  );

  // 2. ws_agent_save accepts this model
  const saveReq = makeReq({
    agent: {
      name: 'Codex Detected Model Agent',
      platform: 'codex',
      model: 'gpt-5-codex-detected',
      workdir: testProj,
    },
  });
  const saveRes = (await feature.routes['ws_agent_save']!.handler(saveReq, saveReq)) as any;
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.agent.model, 'gpt-5-codex-detected');
});

test('git: [Item 3] getDirtyFilesWithHashes returns verification failure error when uncommitted files exceed 500', async () => {
  const tempRepo = fs.mkdtempSync(path.join(ORIG_TMP, 'maw-dirty-cap-test-'));
  try {
    await runCommand('git.exe', ['-C', tempRepo, 'init']);
    await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.name', 'Tester']);
    await runCommand('git.exe', ['-C', tempRepo, 'config', 'user.email', 'test@example.com']);

    // Create 501 untracked files
    for (let i = 0; i < 501; i++) {
      fs.writeFileSync(path.join(tempRepo, `test_file_${i}.txt`), `content ${i}\n`, 'utf8');
    }

    const resOverCap = await getDirtyFilesWithHashes(tempRepo);
    assert.equal(resOverCap.ok, false);
    assert.ok(
      resOverCap.error?.includes('too many uncommitted files to verify (501)'),
      `Expected error to mention 501 files, got: ${resOverCap.error}`
    );

    // Remove files so count is 3 (well below 500)
    for (let i = 3; i < 501; i++) {
      fs.unlinkSync(path.join(tempRepo, `test_file_${i}.txt`));
    }

    const resUnderCap = await getDirtyFilesWithHashes(tempRepo);
    assert.equal(resUnderCap.ok, true);
    assert.equal(Object.keys(resUnderCap.files).length, 3);
  } finally {
    try {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    } catch {}
  }
});

