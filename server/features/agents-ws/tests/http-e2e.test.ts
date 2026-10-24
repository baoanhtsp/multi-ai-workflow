import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMawHttpServer } from '../../../http.ts';

// The real temp dir, captured before any test points TEMP at its own folder.
const ORIG_TMP = os.tmpdir();

function rawHttpRequest(options: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: {
          Host: `127.0.0.1:${options.port}`,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

test('HTTP e2e: S6 feature routes loading, 200 shapes, error codes and security guards', async () => {
  const tempBase = fs.mkdtempSync(path.join(ORIG_TMP, 'maw space e2e test '));
  const tempMawHome = path.join(tempBase, '.maw');
  const tempProjectsRoot = path.join(tempBase, 'my projects');
  fs.mkdirSync(tempMawHome, { recursive: true });
  fs.mkdirSync(tempProjectsRoot, { recursive: true });
  const testProj = path.join(tempProjectsRoot, 'mission-app');
  fs.mkdirSync(testProj, { recursive: true });

  // Isolate from the real machine: TEMP (maw_jobs).
  process.env.TEMP = tempBase;
  process.env.TMP = tempBase;
  const { server } = createMawHttpServer({
    repoRoot: process.cwd(),
    projectsRoot: tempProjectsRoot,
    mawHome: tempMawHome,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  try {
    // 1. GET /api?action=status loads features
    const statusRes = await rawHttpRequest({ port, path: '/api?action=status' });
    assert.equal(statusRes.statusCode, 200);
    const statusJson = JSON.parse(statusRes.body);
    assert.ok(statusJson.features.includes('agents-ws'));
    assert.ok(statusJson.features.includes('chat'));
    assert.ok(statusJson.features.includes('handoffs'));
    assert.ok(statusJson.features.includes('teams'));
    assert.ok(statusJson.features.includes('memory'));
    assert.ok(statusJson.feature_data['agents-ws'] !== undefined);
    assert.ok(statusJson.feature_data['handoffs'] !== undefined);

    // 2. GET /api?action=ws_state 200 response shape
    const wsStateRes = await rawHttpRequest({ port, path: '/api?action=ws_state' });
    assert.equal(wsStateRes.statusCode, 200);
    const wsStateJson = JSON.parse(wsStateRes.body);
    assert.equal(wsStateJson.ok, true);
    assert.ok(Array.isArray(wsStateJson.agents));
    assert.ok(Array.isArray(wsStateJson.groups));
    assert.ok(Array.isArray(wsStateJson.platforms));

    // 3. GET /api?action=team_templates 200 response shape
    const teamTplRes = await rawHttpRequest({ port, path: '/api?action=team_templates' });
    assert.equal(teamTplRes.statusCode, 200);
    const teamTplJson = JSON.parse(teamTplRes.body);
    assert.equal(teamTplJson.ok, true);
    assert.ok(teamTplJson.templates.some((t: any) => t.id === 'full'));
    assert.ok(teamTplJson.templates.some((t: any) => t.id === 'empty'));

    // 4. POST security: Reject POST without X-MAW-Request: 1
    const badSecRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=ws_agent_save',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: { name: 'Sec Test' } }),
    });
    assert.equal(badSecRes.statusCode, 403);

    // 5. POST /api?action=ws_agent_save 200 response shape
    const saveRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=ws_agent_save',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: {
          name: 'HTTP Test Agent',
          platform: 'claude',
          workdir: testProj,
          role: 'backend',
        },
      }),
    });
    assert.equal(saveRes.statusCode, 200);
    const saveJson = JSON.parse(saveRes.body);
    assert.equal(saveJson.ok, true);
    assert.ok(saveJson.agent.id.startsWith('ag_'));

    // 6. POST 400 validation error (bad workdir)
    const badReqRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=ws_agent_save',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: {
          name: 'Bad Workdir Agent',
          platform: 'claude',
          workdir: 'C:\\NonexistentDir',
        },
      }),
    });
    assert.equal(badReqRes.statusCode, 400);

    // 7. POST 404 not found (delete nonexistent agent)
    const delRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=ws_agent_delete',
      headers: {
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'ag_99999999' }),
    });
    assert.equal(delRes.statusCode, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
