import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext, type MawFeatureRequest } from '../../../lib/feature.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import { BUILTIN_FULL_TEMPLATE } from '../defaults.ts';
import { feature } from '../index.ts';

function setupTestContext() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maw space teams test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'mission-app');
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

test('teams: Templates list, built-ins read-only guard, user template CRUD', async () => {
  const { makeReq } = setupTestContext();

  // 1. List templates (full and empty built-ins)
  const listReq = makeReq();
  const listRes = (await feature.routes['team_templates']!.handler(listReq, listReq)) as any;
  assert.equal(listRes.ok, true);
  assert.ok(listRes.templates.some((t: any) => t.id === 'full' && t.builtin));
  assert.ok(listRes.templates.some((t: any) => t.id === 'empty' && t.builtin));

  // 2. Reject modifying built-ins
  await assert.rejects(
    async () => {
      const saveReq = makeReq({ id: 'full', name: 'Hacked', team: {} });
      await feature.routes['team_template_save']!.handler(saveReq, saveReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  await assert.rejects(
    async () => {
      const delReq = makeReq({ id: 'empty' });
      await feature.routes['team_template_delete']!.handler(delReq, delReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // 3. Save user template
  const saveUserReq = makeReq({
    name: 'Custom Duo',
    team: {
      name: 'Custom Duo',
      shared: { platform: 'claude', write_scope: ['**'] },
      roles: [
        { key: 'lead', name: 'Lead', exec_role: 'architect' },
        { key: 'worker', name: 'Worker', exec_role: 'backend' },
      ],
    },
    roles_md: {
      lead: { responsibility: 'Oversee project' },
      worker: { responsibility: 'Write code' },
    },
  });
  const saveUserRes = (await feature.routes['team_template_save']!.handler(saveUserReq, saveUserReq)) as any;
  assert.equal(saveUserRes.ok, true);
  const userTplId = saveUserRes.template.id;
  assert.ok(userTplId.startsWith('tt_'));

  // 4. Delete user template
  const delUserReq = makeReq({ id: userTplId });
  const delUserRes = (await feature.routes['team_template_delete']!.handler(delUserReq, delUserReq)) as any;
  assert.equal(delUserRes.ok, true);
});

test('teams: Team save, get, apply, export and import round-trip', async () => {
  const { makeReq, testProj } = setupTestContext();

  // 1. Save team for project
  const saveReq = makeReq({
    project_path: testProj,
    team: BUILTIN_FULL_TEMPLATE.team,
    roles_md: BUILTIN_FULL_TEMPLATE.roles_md,
  });
  const saveRes = (await feature.routes['team_save']!.handler(saveReq, saveReq)) as any;
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.team.name, 'Full Team');

  // Verify .maw/team.json and roles md files
  const teamFile = path.win32.join(testProj, '.maw', 'team.json');
  assert.ok(fs.existsSync(teamFile));
  const leadMd = path.win32.join(testProj, '.maw', 'roles', 'lead.md');
  assert.ok(fs.existsSync(leadMd));

  // 2. Get team
  const getReq = makeReq({}, { project_path: testProj });
  const getRes = (await feature.routes['team_get']!.handler(getReq, getReq)) as any;
  assert.equal(getRes.ok, true);
  assert.equal(getRes.team.name, 'Full Team');
  assert.ok(getRes.roles_md.lead);

  // 3. Apply team (creates agents and group)
  const applyReq = makeReq({ project_path: testProj });
  const applyRes = (await feature.routes['team_apply']!.handler(applyReq, applyReq)) as any;
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.group.name, 'Full Team');
  assert.equal(applyRes.agents.length, 6);
  assert.ok(applyRes.team.roles.every((r: any) => r.agent_id !== ''));

  // 4. Export team
  const exportReq = makeReq({}, { project_path: testProj });
  const exportRes = (await feature.routes['team_export']!.handler(exportReq, exportReq)) as any;
  assert.equal(exportRes.ok, true);
  assert.equal(exportRes.bundle.kind, 'maw-team');
  assert.equal(exportRes.bundle.version, 1);

  // 5. Import team into same project without overwrite => 409
  await assert.rejects(
    async () => {
      const impReq = makeReq({ project_path: testProj, bundle: exportRes.bundle });
      await feature.routes['team_import']!.handler(impReq, impReq);
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409
  );

  // 6. Import with overwrite: true => 200
  const impReqOk = makeReq({ project_path: testProj, bundle: exportRes.bundle, overwrite: true });
  const impResOk = (await feature.routes['team_import']!.handler(impReqOk, impReqOk)) as any;
  assert.equal(impResOk.ok, true);
  assert.equal(impResOk.team.name, 'Full Team');
});

test('teams: Role profiles library CRUD', async () => {
  const { makeReq } = setupTestContext();

  // Save profile
  const saveReq = makeReq({
    name: 'Senior Architect',
    role: { key: 'lead', name: 'Lead Architect', exec_role: 'architect' },
    sections: { responsibility: 'High-level designs', delegation: '', output: '', permissions: '' },
  });
  const saveRes = (await feature.routes['team_profile_save']!.handler(saveReq, saveReq)) as any;
  assert.equal(saveRes.ok, true);
  const profId = saveRes.profile.id;
  assert.ok(profId.startsWith('rp_'));

  // List profiles
  const listReq = makeReq();
  const listRes = (await feature.routes['team_profiles']!.handler(listReq, listReq)) as any;
  assert.equal(listRes.ok, true);
  assert.ok(listRes.profiles.some((p: any) => p.id === profId));

  // Delete profile
  const delReq = makeReq({ id: profId });
  const delRes = (await feature.routes['team_profile_delete']!.handler(delReq, delReq)) as any;
  assert.equal(delRes.ok, true);
});
