import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { feature } from '../index.ts';

function setupTestContext() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maw space test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'test-app');
  fs.mkdirSync(testProj, { recursive: true });

  const paths = resolveServerPaths({
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

