import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMawHttpServer } from '../../../http.ts';
import { resolveServerPaths } from '../../../lib/paths.ts';

test('tasks http: end-to-end task_create -> task_list -> task_move and §3.0 POST security guards', async () => {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempMawHome = path.join(os.tmpdir(), `maw_http_test_${rand}`);
  const tempProjects = path.join(tempMawHome, 'projects');
  const projectDir = path.join(tempProjects, 'app');

  fs.mkdirSync(projectDir, { recursive: true });

  const paths = resolveServerPaths({
    mawHome: tempMawHome,
    projectsRoot: tempProjects,
  });

  const featuresDir = path.resolve(paths.repoRoot, 'server', 'features');
  const { server } = createMawHttpServer({
    mawHome: tempMawHome,
    projectsRoot: tempProjects,
    featuresDir,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Security guard: POST without X-MAW-Request header -> 403
    const resNoHeader = await fetch(`${baseUrl}/api?action=task_create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'T1' }),
    });
    assert.equal(resNoHeader.status, 403);

    // 2. Security guard: POST with wrong Content-Type -> 415
    const resWrongCt = await fetch(`${baseUrl}/api?action=task_create`, {
      method: 'POST',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ title: 'T1' }),
    });
    assert.equal(resWrongCt.status, 415);

    // 3. Security guard: POST with foreign Origin -> 403
    const resBadOrigin = await fetch(`${baseUrl}/api?action=task_create`, {
      method: 'POST',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
        Origin: 'http://malicious.site',
      },
      body: JSON.stringify({ title: 'T1' }),
    });
    assert.equal(resBadOrigin.status, 403);

    // 4. Valid task_create -> 200
    const createRes = await fetch(`${baseUrl}/api?action=task_create`, {
      method: 'POST',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        title: 'HTTP Integration Task',
        prompt: 'Build HTTP test',
        project_path: projectDir,
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        status: 'backlog',
      }),
    });
    assert.equal(createRes.status, 200);
    const createJson = (await createRes.json()) as any;
    assert.equal(createJson.ok, true);
    assert.equal(createJson.task.title, 'HTTP Integration Task');
    assert.equal(createJson.task.status, 'backlog');
    const createdId = createJson.task.id;

    // 5. task_list -> 200
    const listRes = await fetch(
      `${baseUrl}/api?action=task_list&project_path=${encodeURIComponent(projectDir)}`
    );
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as any;
    assert.equal(listJson.ok, true);
    assert.ok(Array.isArray(listJson.tasks));
    assert.ok(listJson.tasks.some((t: any) => t.id === createdId));

    // 6. task_move -> 200
    const moveRes = await fetch(`${baseUrl}/api?action=task_move`, {
      method: 'POST',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        id: createdId,
        status: 'queued',
      }),
    });
    assert.equal(moveRes.status, 200);
    const moveJson = (await moveRes.json()) as any;
    assert.equal(moveJson.ok, true);
    assert.equal(moveJson.task.status, 'queued');
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      fs.rmSync(tempMawHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
