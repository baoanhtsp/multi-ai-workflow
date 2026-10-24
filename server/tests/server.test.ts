import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

import {
  resolveServerPaths,
  resolveProjectPath,
  trimIncompleteUtf8Tail,
} from '../lib/paths.ts';
import { buildCommandSpec } from '../lib/commands.ts';
import { loadAgentRegistry, resolveAgentOwnersFromCell } from '../lib/registry.ts';
import { buildValidatedCommand, ApiValidationError } from '../lib/validate.ts';
import {
  getPublicNotifyConfig,
  handleSaveNotify,
  loadInternalNotifyConfig,
} from '../actions/notify.ts';
import { createMawHttpServer } from '../http.ts';
import { type MawFeature } from '../lib/feature.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function makeTempEnv(): {
  tempDir: string;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-v3-test-'));
  const geminiAntigravity = path.join(tempDir, '.gemini', 'antigravity');
  const geminiSkillDir = path.join(
    tempDir,
    '.gemini',
    'config',
    'skills',
    'claude-leader'
  );
  fs.mkdirSync(geminiAntigravity, { recursive: true });
  fs.mkdirSync(geminiSkillDir, { recursive: true });

  const srcSkillDir = path.join(
    repoRoot,
    'antigravity',
    'skills',
    'claude-leader'
  );
  fs.cpSync(srcSkillDir, geminiSkillDir, { recursive: true });

  return {
    tempDir,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    },
  };
}

test('trimIncompleteUtf8Tail never splits multi-byte UTF-8 sequences', () => {
  const text = 'Hello Đặng Bảo Anh 🚀 Tiếng Việt chuẩn 100%';
  const fullBuf = Buffer.from(text, 'utf8');

  for (let cut = 1; cut < fullBuf.length; cut++) {
    const slice = fullBuf.subarray(0, cut);
    const safe = trimIncompleteUtf8Tail(slice);
    const decoded = safe.toString('utf8');
    assert.equal(
      decoded.includes('\uFFFD'),
      false,
      `Cut at byte ${cut} produced replacement char U+FFFD`
    );
    assert.equal(
      text.startsWith(decoded),
      true,
      `Decoded prefix "${decoded}" is not a prefix of original text`
    );
  }
});

test('resolveProjectPath enforces projectsRoot boundary and blocks sibling traversal', () => {
  const { tempDir, cleanup } = makeTempEnv();
  try {
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });

    const resolvedSelf = resolveProjectPath(repoRoot, paths.projectsRoot);
    assert.ok(resolvedSelf !== null);
    assert.equal(resolvedSelf.toLowerCase(), repoRoot.toLowerCase());

    const siblingRoot = resolveProjectPath(
      `${paths.projectsRoot}-sibling`,
      paths.projectsRoot
    );
    assert.equal(siblingRoot, null);

    const parentTraversal = resolveProjectPath(
      path.join(paths.projectsRoot, '..', 'Windows'),
      paths.projectsRoot
    );
    assert.equal(parentTraversal, null);
  } finally {
    cleanup();
  }
});

test('commands.ts builds specs for all modes and safely round-trips special characters in PowerShell', async () => {
  const { tempDir, cleanup } = makeTempEnv();
  try {
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });

    const modes: Array<Record<string, unknown>> = [
      {
        mode: 'task',
        role: 'reviewer',
        agent: 'codex',
        model: 'gpt-6-sol',
        effort: 'medium',
        project_path: repoRoot,
        prompt: 'Check logic',
      },
      {
        mode: 'team',
        role: 'leader',
        agent: 'claude',
        team: {
          backend: 'claude',
          frontend: 'antigravity',
          reviewer: 'codex',
        },
        project_path: repoRoot,
        prompt: 'Coordinate sprint',
      },
      {
        mode: 'claude',
        role: 'architect',
        model: 'opus',
        effort: 'high',
        project_path: repoRoot,
        prompt: 'Review architecture',
      },
      {
        mode: 'codex',
        role: 'coder',
        model: 'gpt-6-sol',
        effort: 'xhigh',
        project_path: repoRoot,
        prompt: 'Write tests',
      },
      {
        mode: 'antigravity',
        role: 'send-latest',
        model: 'pro',
        new_session: true,
        project_path: repoRoot,
        prompt: 'Implement backend',
      },
      {
        mode: 'council',
        role: 'parallel-review',
        model: 'sonnet',
        effort: 'medium',
        project_path: repoRoot,
        prompt: 'Audit diff',
      },
      {
        mode: 'auto-gate',
        role: 'auto-loop',
        project_path: repoRoot,
        prompt: 'Run gate',
      },
      {
        mode: 'spec-guard',
        role: 'check',
        project_path: repoRoot,
      },
    ];

    for (const payload of modes) {
      const info = buildValidatedCommand(payload, paths);
      const spec = buildCommandSpec(info, paths.scriptsDir);
      assert.equal(spec.file, 'powershell.exe');
      assert.ok(Array.isArray(spec.args));
      assert.ok(spec.args.includes('-NoProfile'));
      assert.ok(spec.args.includes('-File'));
      assert.ok(spec.preview.startsWith('& '));
      assert.equal(spec.preview, info.command);
    }

    // Verify Windows PowerShell argument round-trip with spaces, quotes, &, %, newlines, and Vietnamese characters
    const echoScript = path.join(tempDir, 'echo-args.ps1');
    fs.writeFileSync(
      echoScript,
      'param([string]$InputText)\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::Write($InputText)\n',
      'utf8'
    );

    const trickyText =
      'Xin chào "Đặng Bảo Anh" & \'Claude\' 100% $env:USERNAME\nDòng 2 có khoảng trắng!';
    const roundTripOut = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          echoScript,
          '-InputText',
          trickyText,
        ],
        { windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        }
      );
    });
    assert.equal(roundTripOut, trickyText);
  } finally {
    cleanup();
  }
});

test('validate.ts rejects invalid team, prompt > 20000 chars, and invalid Antigravity model tier usage', () => {
  const { tempDir, cleanup } = makeTempEnv();
  try {
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });

    // Empty team in team mode
    assert.throws(
      () =>
        buildValidatedCommand(
          {
            mode: 'team',
            agent: 'claude',
            role: 'leader',
            team: {},
            project_path: repoRoot,
            prompt: 'Plan',
          },
          paths
        ),
      (err: unknown) =>
        err instanceof ApiValidationError && err.statusCode === 400
    );

    // Invalid slot in team
    assert.throws(
      () =>
        buildValidatedCommand(
          {
            mode: 'team',
            agent: 'claude',
            role: 'leader',
            team: { invalidslot: 'claude' },
            project_path: repoRoot,
            prompt: 'Plan',
          },
          paths
        ),
      (err: unknown) =>
        err instanceof ApiValidationError && err.statusCode === 400
    );

    // Invalid agent in team
    assert.throws(
      () =>
        buildValidatedCommand(
          {
            mode: 'team',
            agent: 'claude',
            role: 'leader',
            team: { backend: 'unknownai' },
            project_path: repoRoot,
            prompt: 'Plan',
          },
          paths
        ),
      (err: unknown) =>
        err instanceof ApiValidationError && err.statusCode === 400
    );

    // Antigravity model override without new_session in task mode
    assert.throws(
      () =>
        buildValidatedCommand(
          {
            mode: 'task',
            agent: 'antigravity',
            role: 'backend',
            model: 'pro',
            new_session: false,
            project_path: repoRoot,
            prompt: 'Hello',
          },
          paths
        ),
      (err: unknown) =>
        err instanceof ApiValidationError && err.statusCode === 400
    );

    // Prompt > 20000 chars
    assert.throws(
      () =>
        buildValidatedCommand(
          {
            mode: 'task',
            agent: 'claude',
            role: 'reviewer',
            project_path: repoRoot,
            prompt: 'a'.repeat(20001),
          },
          paths
        ),
      (err: unknown) =>
        err instanceof ApiValidationError && err.statusCode === 400
    );
  } finally {
    cleanup();
  }
});

test('notify.ts masks telegram_bot_token, preserves on null, and clears on empty string', () => {
  const { tempDir, cleanup } = makeTempEnv();
  try {
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });

    const save1 = handleSaveNotify(
      {
        desktop_toast: true,
        webhook_url: '',
        telegram_bot_token: '123456:SECRET_BOT_TOKEN',
        telegram_chat_id: '-100999',
      },
      paths
    );
    assert.equal(save1.ok, true);
    const pub1 = getPublicNotifyConfig(paths.notifyCfgFile);
    assert.equal(pub1.telegram_bot_token_set, true);
    assert.equal('telegram_bot_token' in pub1, false);

    // Preserve token when null is sent
    handleSaveNotify(
      {
        desktop_toast: true,
        webhook_url: '',
        telegram_bot_token: null,
        telegram_chat_id: '-100999',
      },
      paths
    );
    assert.equal(
      loadInternalNotifyConfig(paths.notifyCfgFile).telegram_bot_token,
      '123456:SECRET_BOT_TOKEN'
    );

    // Clear token when empty string is sent
    handleSaveNotify(
      {
        desktop_toast: false,
        webhook_url: '',
        telegram_bot_token: '',
        telegram_chat_id: '-100999',
      },
      paths
    );
    assert.equal(
      loadInternalNotifyConfig(paths.notifyCfgFile).telegram_bot_token,
      ''
    );
    assert.equal(
      getPublicNotifyConfig(paths.notifyCfgFile).telegram_bot_token_set,
      false
    );
  } finally {
    cleanup();
  }
});

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
        headers: options.headers,
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

test('HTTP security guards, static serving, 256 KB body limit, and SSE job_stream work end-to-end', async () => {
  const { tempDir, cleanup } = makeTempEnv();
  const { server } = createMawHttpServer({
    repoRoot,
    projectsRoot: path.dirname(repoRoot),
    userProfile: tempDir,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  try {
    // 1. Wrong Host header -> 403
    const badHost = await rawHttpRequest({
      port,
      path: '/api?action=status',
      headers: { Host: 'evil.example.com' },
    });
    assert.equal(badHost.statusCode, 403);

    // 2. GET / -> 200 with Content-Security-Policy header
    const indexRes = await rawHttpRequest({
      port,
      path: '/',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(indexRes.statusCode, 200);
    assert.ok(
      String(indexRes.headers['content-security-policy'] ?? '').includes(
        "default-src 'self'"
      )
    );
    assert.ok(indexRes.body.includes('<!DOCTYPE html>'));

    // 3. Path traversal /../SPEC.md and /server/main.ts -> 404
    const trav1 = await rawHttpRequest({
      port,
      path: '/../SPEC.md',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(trav1.statusCode, 404);

    const trav2 = await rawHttpRequest({
      port,
      path: '/server/main.ts',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(trav2.statusCode, 404);

    // 4. POST without X-MAW-Request -> 403
    const noHeader = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=dispatch',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'spec-guard' }),
    });
    assert.equal(noHeader.statusCode, 403);

    // 5. POST with Origin: null -> 403
    const nullOrigin = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=dispatch',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'null',
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'spec-guard' }),
    });
    assert.equal(nullOrigin.statusCode, 403);

    // 6. POST with wrong Content-Type -> 415
    const wrongCt = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=dispatch',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    assert.equal(wrongCt.statusCode, 415);

    // 7. POST body > 256 KB -> 413
    const hugeBody = JSON.stringify({
      mode: 'task',
      role: 'reviewer',
      prompt: 'x'.repeat(270 * 1024),
    });
    const tooLarge = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=dispatch',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: hugeBody,
    });
    assert.equal(tooLarge.statusCode, 413);

    // 8. Run a real spec-guard job and consume SSE job_stream until completion
    const runRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=run_job',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'spec-guard',
        role: 'check',
        project_path: repoRoot,
      }),
    });
    assert.equal(runRes.statusCode, 200);
    const runJson = JSON.parse(runRes.body) as {
      ok: boolean;
      job_id: string;
    };
    assert.equal(runJson.ok, true);
    const jobId = runJson.job_id;

    const sseRes = await rawHttpRequest({
      port,
      path: `/api?action=job_stream&job_id=${encodeURIComponent(jobId)}&offset=0`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(sseRes.statusCode, 200);
    assert.ok(
      String(sseRes.headers['content-type'] ?? '').includes('text/event-stream')
    );
    assert.ok(
      sseRes.body.includes('event: log'),
      `Expected SSE stream to include 'event: log', got:\n${sseRes.body}`
    );
    assert.ok(
      sseRes.body.includes('SPEC.md CONTRACT GUARD REPORT'),
      `Expected SSE stream to include real PowerShell output 'SPEC.md CONTRACT GUARD REPORT', got:\n${sseRes.body}`
    );
    assert.ok(
      sseRes.body.includes('event: status'),
      `Expected SSE stream to include 'event: status', got:\n${sseRes.body}`
    );

    const statusBlocks = sseRes.body
      .split('\n\n')
      .filter((block) => block.includes('event: status'));
    assert.ok(statusBlocks.length > 0);
    const lastBlock = statusBlocks[statusBlocks.length - 1]!;
    const dataLine = lastBlock
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(dataLine);
    const statusPayload = JSON.parse(dataLine.slice(6)) as {
      status: string;
      exit_code: number;
    };
    assert.equal(statusPayload.status, 'DONE');
    assert.equal(statusPayload.exit_code, 0);

    // Also verify job_status contains the full report
    const jobStatusRes = await rawHttpRequest({
      port,
      path: `/api?action=job_status&job_id=${encodeURIComponent(jobId)}&offset=0`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(jobStatusRes.statusCode, 200);
    const jobStatusJson = JSON.parse(jobStatusRes.body) as {
      status: string;
      exit_code: number;
      log_chunk: string;
    };
    assert.equal(jobStatusJson.status, 'DONE');
    assert.equal(jobStatusJson.exit_code, 0);
    assert.ok(
      jobStatusJson.log_chunk.includes('SPEC.md CONTRACT GUARD REPORT')
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  }
});

test('PHP-to-Node response key-set parity check (if PHP and dashboard/api.php are present)', async (t) => {
  const phpCandidates = [
    'C:\\laragon\\bin\\php\\php-8.3.30-Win32-vs16-x64\\php.exe',
  ];
  const phpApiFile = path.join(repoRoot, 'dashboard', 'api.php');
  if (!fs.existsSync(phpApiFile)) {
    t.skip('dashboard/api.php already removed after migration');
    return;
  }
  const phpExe = phpCandidates.find((c) => fs.existsSync(c));
  if (!phpExe) {
    t.skip('PHP executable not found');
    return;
  }

  const { tempDir, cleanup } = makeTempEnv();
  const { server: nodeServer } = createMawHttpServer({
    repoRoot,
    projectsRoot: path.dirname(repoRoot),
    userProfile: tempDir,
  });
  await new Promise<void>((resolve) =>
    nodeServer.listen(0, '127.0.0.1', resolve)
  );
  const nodePort = (nodeServer.address() as { port: number }).port;

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const phpPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const phpProc = spawn(
    phpExe,
    ['-S', `127.0.0.1:${phpPort}`, path.join(repoRoot, 'dashboard', 'api.php')],
    {
      cwd: repoRoot,
      env: { ...process.env, USERPROFILE: tempDir },
      windowsHide: true,
    }
  );

  try {
    let phpReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await rawHttpRequest({
          port: phpPort,
          path: '/api.php?action=status',
          headers: { Host: `127.0.0.1:${phpPort}` },
        });
        if (res.statusCode === 200) {
          phpReady = true;
          break;
        }
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!phpReady) {
      t.skip('PHP built-in server did not start in time');
      return;
    }

    // 1. Compare status keys
    const phpStatus = JSON.parse(
      (
        await rawHttpRequest({
          port: phpPort,
          path: '/api.php?action=status',
          headers: { Host: `127.0.0.1:${phpPort}` },
        })
      ).body
    ) as Record<string, unknown>;
    const nodeStatus = JSON.parse(
      (
        await rawHttpRequest({
          port: nodePort,
          path: '/api?action=status',
          headers: { Host: `127.0.0.1:${nodePort}` },
        })
      ).body
    ) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(nodeStatus).sort(),
      Object.keys(phpStatus).sort()
    );

    // 2. Compare spec_guard keys (POST)
    const phpGuard = JSON.parse(
      (
        await rawHttpRequest({
          port: phpPort,
          method: 'POST',
          path: '/api.php?action=spec_guard',
          headers: {
            Host: `127.0.0.1:${phpPort}`,
            Origin: `http://127.0.0.1:${phpPort}`,
            'X-MAW-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ project_path: repoRoot, owner: '' }),
        })
      ).body
    ) as Record<string, unknown>;
    const nodeGuard = JSON.parse(
      (
        await rawHttpRequest({
          port: nodePort,
          method: 'POST',
          path: '/api?action=spec_guard',
          headers: {
            Host: `127.0.0.1:${nodePort}`,
            Origin: `http://127.0.0.1:${nodePort}`,
            'X-MAW-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ project_path: repoRoot, owner: '' }),
        })
      ).body
    ) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(nodeGuard).sort(),
      Object.keys(phpGuard).sort()
    );

    // 3. Compare dispatch (task & team) keys
    for (const payload of [
      {
        mode: 'task',
        role: 'reviewer',
        agent: 'codex',
        project_path: repoRoot,
        prompt: 'Check diff',
      },
      {
        mode: 'team',
        role: 'leader',
        agent: 'claude',
        team: { backend: 'claude', reviewer: 'codex' },
        project_path: repoRoot,
        prompt: 'Lead team',
      },
    ]) {
      const phpDisp = JSON.parse(
        (
          await rawHttpRequest({
            port: phpPort,
            method: 'POST',
            path: '/api.php?action=dispatch',
            headers: {
              Host: `127.0.0.1:${phpPort}`,
              Origin: `http://127.0.0.1:${phpPort}`,
              'X-MAW-Request': '1',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
        ).body
      ) as Record<string, unknown>;
      const nodeDisp = JSON.parse(
        (
          await rawHttpRequest({
            port: nodePort,
            method: 'POST',
            path: '/api?action=dispatch',
            headers: {
              Host: `127.0.0.1:${nodePort}`,
              Origin: `http://127.0.0.1:${nodePort}`,
              'X-MAW-Request': '1',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
        ).body
      ) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(nodeDisp).sort(),
        Object.keys(phpDisp).sort()
      );
    }

    // 4. Compare cancel_job 404 keys
    const phpCancel = JSON.parse(
      (
        await rawHttpRequest({
          port: phpPort,
          method: 'POST',
          path: '/api.php?action=cancel_job',
          headers: {
            Host: `127.0.0.1:${phpPort}`,
            Origin: `http://127.0.0.1:${phpPort}`,
            'X-MAW-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: 'job_20990101_000000_deadbeef' }),
        })
      ).body
    ) as Record<string, unknown>;
    const nodeCancel = JSON.parse(
      (
        await rawHttpRequest({
          port: nodePort,
          method: 'POST',
          path: '/api?action=cancel_job',
          headers: {
            Host: `127.0.0.1:${nodePort}`,
            Origin: `http://127.0.0.1:${nodePort}`,
            'X-MAW-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: 'job_20990101_000000_deadbeef' }),
        })
      ).body
    ) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(nodeCancel).sort(),
      Object.keys(phpCancel).sort()
    );

    // 5. Compare job_status and cancel_job 409 keys on a finished job
    const nodeRun = JSON.parse(
      (
        await rawHttpRequest({
          port: nodePort,
          method: 'POST',
          path: '/api?action=run_job',
          headers: {
            Host: `127.0.0.1:${nodePort}`,
            Origin: `http://127.0.0.1:${nodePort}`,
            'X-MAW-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            mode: 'spec-guard',
            role: 'check',
            project_path: repoRoot,
          }),
        })
      ).body
    ) as { job_id: string };

    // Wait via SSE for job to reach DONE
    await rawHttpRequest({
      port: nodePort,
      path: `/api?action=job_stream&job_id=${encodeURIComponent(nodeRun.job_id)}&offset=0`,
      headers: { Host: `127.0.0.1:${nodePort}` },
    });

    const phpJobStatus = JSON.parse(
      (
        await rawHttpRequest({
          port: phpPort,
          path: `/api.php?action=job_status&job_id=${encodeURIComponent(nodeRun.job_id)}&offset=0`,
          headers: { Host: `127.0.0.1:${phpPort}` },
        })
      ).body
    ) as Record<string, unknown>;
    const nodeJobStatus = JSON.parse(
      (
        await rawHttpRequest({
          port: nodePort,
          path: `/api?action=job_status&job_id=${encodeURIComponent(nodeRun.job_id)}&offset=0`,
          headers: { Host: `127.0.0.1:${nodePort}` },
        })
      ).body
    ) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(nodeJobStatus).sort(),
      Object.keys(phpJobStatus).sort()
    );

    const phpCancel409Res = await rawHttpRequest({
      port: phpPort,
      method: 'POST',
      path: '/api.php?action=cancel_job',
      headers: {
        Host: `127.0.0.1:${phpPort}`,
        Origin: `http://127.0.0.1:${phpPort}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job_id: nodeRun.job_id }),
    });
    const nodeCancel409Res = await rawHttpRequest({
      port: nodePort,
      method: 'POST',
      path: '/api?action=cancel_job',
      headers: {
        Host: `127.0.0.1:${nodePort}`,
        Origin: `http://127.0.0.1:${nodePort}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job_id: nodeRun.job_id }),
    });
    assert.equal(phpCancel409Res.statusCode, 409);
    assert.equal(nodeCancel409Res.statusCode, 409);
    assert.deepEqual(
      Object.keys(JSON.parse(nodeCancel409Res.body) as Record<string, unknown>).sort(),
      Object.keys(JSON.parse(phpCancel409Res.body) as Record<string, unknown>).sort()
    );
  } finally {
    phpProc.kill();
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
    cleanup();
  }
});

test('v4.0 registry.ts: loads 6 shipped agents, merges user overrides, disables entries, skips invalid entries, and ignores corrupt user file', () => {
  const { tempDir, cleanup } = makeTempEnv();
  try {
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });

    // 1. Default shipped registry
    const baseReg = loadAgentRegistry(paths, { mawHome: path.join(tempDir, 'no-user-maw') });
    assert.equal(baseReg.warnings.length, 0);
    assert.deepEqual(
      baseReg.agents.map((a) => a.id),
      ['claude', 'codex', 'antigravity', 'gemini', 'cursor', 'aider']
    );

    // 2. Multi-owner cell resolution
    assert.deepEqual(
      resolveAgentOwnersFromCell('Claude Opus (-Role architect) + Antigravity', baseReg),
      ['claude', 'antigravity']
    );
    assert.deepEqual(
      resolveAgentOwnersFromCell('Antigravity (Gemini 4 Argon)', baseReg),
      ['antigravity']
    );

    // 3. Merge user overrides, add custom AI, disable cursor, and skip invalid entry
    const customMawHome = path.join(tempDir, 'custom-maw');
    fs.mkdirSync(customMawHome, { recursive: true });
    fs.writeFileSync(
      path.join(customMawHome, 'agents.json'),
      JSON.stringify({
        version: 1,
        defaults: {
          council: ['claude', 'gemini'],
          implementer: 'gemini',
        },
        agents: [
          {
            id: 'gemini',
            label: 'Gemini Custom Label',
            models: ['pro', 'flash'],
          },
          {
            id: 'cursor',
            enabled: false,
          },
          {
            id: 'custom-bot',
            label: 'Custom Bot CLI',
            color: '#123456',
            enabled: true,
            adapter: 'cli',
            detect: { command: 'custom-bot-exe', version_args: ['--version'] },
            models: ['v1'],
            efforts: [],
            capabilities: {
              write: true,
              review: true,
              new_session: false,
              sessions: false,
              ide_send: false,
            },
            cli: {
              command: 'custom-bot-exe',
              prompt_via: 'stdin',
              args: ['-p'],
              role_args: {},
              model_args: ['-m', '{model}'],
              effort_args: [],
              output: 'text',
            },
          },
          {
            id: 'BAD_ID_WITH_CAPS',
            label: 'Invalid Agent',
          },
        ],
      }),
      'utf8'
    );

    const mergedReg = loadAgentRegistry(paths, { mawHome: customMawHome });
    assert.deepEqual(mergedReg.defaults.council, ['claude', 'gemini']);
    assert.equal(mergedReg.defaults.implementer, 'gemini');
    assert.equal(
      mergedReg.agents.some((a) => a.id === 'cursor'),
      false,
      'Disabled agent cursor should not be in enabled agents list'
    );
    assert.equal(
      mergedReg.allAgents.find((a) => a.id === 'cursor')?.enabled,
      false
    );
    const geminiEntry = mergedReg.agents.find((a) => a.id === 'gemini');
    assert.equal(geminiEntry?.label, 'Gemini Custom Label');
    assert.deepEqual(geminiEntry?.models, ['pro', 'flash']);
    assert.ok(mergedReg.agents.some((a) => a.id === 'custom-bot'));
    assert.ok(
      mergedReg.warnings.some((w) => w.includes('BAD_ID_WITH_CAPS')),
      'Expected warning for invalid entry'
    );

    // 4. Corrupt user file is ignored with a warning
    const corruptMawHome = path.join(tempDir, 'corrupt-maw');
    fs.mkdirSync(corruptMawHome, { recursive: true });
    fs.writeFileSync(path.join(corruptMawHome, 'agents.json'), '{not valid json', 'utf8');
    const corruptReg = loadAgentRegistry(paths, { mawHome: corruptMawHome });
    assert.equal(corruptReg.agents.length, 6);
    assert.ok(corruptReg.warnings.length > 0);
  } finally {
    cleanup();
  }
});

test('v4.0 status, registry-driven dispatch, uninstalled agent 400 on run_job, and A3 executed command in job meta', async () => {
  const { tempDir, cleanup } = makeTempEnv();
  const prevMawHome = process.env.MAW_HOME;
  const testMawHome = path.join(tempDir, '.maw');
  fs.mkdirSync(testMawHome, { recursive: true });
  // Add an uninstalled custom agent and an installed fake CLI agent
  fs.writeFileSync(
    path.join(testMawHome, 'agents.json'),
    JSON.stringify({
      version: 1,
      agents: [
        {
          id: 'uninstalled-ai',
          label: 'Uninstalled Test AI',
          color: '#ff0000',
          enabled: true,
          adapter: 'cli',
          detect: { command: 'definitely-not-installed-binary-xyz987', version_args: ['--version'] },
          models: ['auto'],
          efforts: [],
          capabilities: { write: true, review: true, new_session: false, sessions: false, ide_send: false },
          cli: {
            command: 'definitely-not-installed-binary-xyz987',
            prompt_via: 'stdin',
            args: [],
            role_args: {},
            model_args: [],
            effort_args: [],
            output: 'text',
          },
        },
        {
          id: 'installed-ps-ai',
          label: 'Installed PS AI',
          color: '#00ff00',
          enabled: true,
          adapter: 'cli',
          detect: { command: 'powershell.exe', version_args: ['-NoProfile', '-Command', '"1.0.0"'] },
          models: ['auto'],
          efforts: [],
          capabilities: { write: true, review: true, new_session: false, sessions: false, ide_send: false },
          cli: {
            command: 'powershell.exe',
            prompt_via: 'stdin',
            args: ['-NoProfile', '-Command', 'Write-Output "OK"'],
            role_args: {},
            model_args: [],
            effort_args: [],
            output: 'text',
          },
        },
      ],
    }),
    'utf8'
  );
  process.env.MAW_HOME = testMawHome;

  const { server } = createMawHttpServer({
    repoRoot,
    projectsRoot: path.dirname(repoRoot),
    userProfile: tempDir,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // 1. Check status v4.0 fields
    const statusRes = await rawHttpRequest({
      port,
      path: '/api?action=status',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusJson = JSON.parse(statusRes.body) as {
      api_version: string;
      features: string[];
      agents: Array<{ id: string; installed: boolean }>;
      defaults: { council: string[]; implementer: string };
      registry_warnings: string[];
    };
    assert.equal(statusJson.api_version, '4.0');
    assert.ok(statusJson.features.includes('registry'));
    for (const id of ['claude', 'codex', 'antigravity', 'gemini', 'cursor', 'aider']) {
      assert.ok(
        statusJson.agents.some((a) => a.id === id),
        `Expected status.agents to include ${id}`
      );
    }

    // 2. Dispatch with gemini / cursor / aider and council reviewers
    for (const ag of ['gemini', 'cursor', 'aider']) {
      const disp = await rawHttpRequest({
        port,
        method: 'POST',
        path: '/api?action=dispatch',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          'X-MAW-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'task',
          agent: ag,
          role: 'backend',
          project_path: repoRoot,
          prompt: `Test ${ag}`,
        }),
      });
      assert.equal(disp.statusCode, 200);
      const dispData = JSON.parse(disp.body) as { command: string };
      assert.ok(dispData.command.includes('invoke-agent.ps1'));
      assert.ok(dispData.command.includes(`-Agent '${ag}'`));
    }

    const councilDisp = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=dispatch',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'council',
        reviewers: ['claude', 'gemini'],
        project_path: repoRoot,
        prompt: 'Review changes',
      }),
    });
    assert.equal(councilDisp.statusCode, 200);
    const councilDispData = JSON.parse(councilDisp.body) as { command: string };
    assert.ok(councilDispData.command.includes("-Reviewers 'claude,gemini'"));

    // 3. run_job for uninstalled agent -> 400 "<label> is not installed."
    const uninstRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=run_job',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'task',
        agent: 'uninstalled-ai',
        role: 'backend',
        project_path: repoRoot,
        prompt: 'Should fail 400',
      }),
    });
    assert.equal(uninstRes.statusCode, 400);
    const uninstData = JSON.parse(uninstRes.body) as { error: string };
    assert.equal(uninstData.error, 'Uninstalled Test AI is not installed.');

    // 4. A3: run_job stores the executed command with -PromptFile in job meta JSON
    const runInstalled = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=run_job',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'spec-guard',
        role: 'check',
        project_path: repoRoot,
      }),
    });
    assert.equal(runInstalled.statusCode, 200);
    const runTaskRes = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=run_job',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'task',
        agent: 'installed-ps-ai',
        role: 'reviewer',
        project_path: repoRoot,
        prompt: 'Inline prompt that must become -PromptFile in meta',
      }),
    });
    assert.equal(runTaskRes.statusCode, 200);
    const runTaskData = JSON.parse(runTaskRes.body) as { job_id: string; command: string };
    assert.ok(
      runTaskData.command.includes('-PromptFile'),
      `Expected run_job response command to use -PromptFile, got: ${runTaskData.command}`
    );
    const paths = resolveServerPaths({
      userProfile: tempDir,
      projectsRoot: path.dirname(repoRoot),
    });
    const metaOnDisk = JSON.parse(
      fs.readFileSync(path.join(paths.jobsDir, `${runTaskData.job_id}.json`), 'utf8')
    ) as { command: string };
    assert.ok(
      metaOnDisk.command.includes('-PromptFile'),
      `Expected job meta command on disk to contain -PromptFile, got: ${metaOnDisk.command}`
    );
    assert.equal(metaOnDisk.command.includes('Inline prompt that must become'), false);
  } finally {
    if (prevMawHome === undefined) {
      delete process.env.MAW_HOME;
    } else {
      process.env.MAW_HOME = prevMawHome;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  }
});

test('F0 plugin foundation: feature loader (hello fixture), route security, status isolation (feature_data / feature_errors / ui_features), ctx.paths.featureDataDir, duplicate action failure, and v4 follow-up registry fields', async () => {
  const { tempDir, cleanup } = makeTempEnv();
  const testMawHome = path.join(tempDir, '.maw-f0');
  const fixturesFeaturesDir = path.join(repoRoot, 'server', 'tests', 'fixtures', 'features');

  // 1. Duplicate action name (colliding with built-in or another feature) or invalid feature name stops startup
  assert.throws(
    () =>
      createMawHttpServer({
        repoRoot,
        projectsRoot: path.dirname(repoRoot),
        userProfile: tempDir,
        mawHome: testMawHome,
        extraFeatures: [
          {
            name: 'bad-dup-builtin',
            routes: {
              status: {
                method: 'GET',
                handler: () => ({ ok: true }),
              },
            },
          },
        ],
      }),
    /Duplicate action 'status'/
  );

  assert.throws(
    () =>
      createMawHttpServer({
        repoRoot,
        projectsRoot: path.dirname(repoRoot),
        userProfile: tempDir,
        mawHome: testMawHome,
        featuresDir: fixturesFeaturesDir,
        extraFeatures: [
          {
            name: 'dup-hello-route',
            routes: {
              hello_ping: {
                method: 'GET',
                handler: () => ({ ok: true }),
              },
            },
          },
        ],
      }),
    /Duplicate action 'hello_ping'/
  );

  assert.throws(
    () =>
      createMawHttpServer({
        repoRoot,
        projectsRoot: path.dirname(repoRoot),
        userProfile: tempDir,
        mawHome: testMawHome,
        extraFeatures: [
          {
            name: 'INVALID_UPPERCASE',
            routes: {},
          },
        ],
      }),
    /Invalid feature name/
  );

  // 2. Load hello fixture + a feature whose status(ctx) throws + a POST route that uses ctx.readJobs
  const extraFeat: MawFeature = {
    name: 'broken-status',
    routes: {
      broken_post: {
        method: 'POST',
        handler: async (ctx, req) => {
          const jobs = await ctx.readJobs();
          return {
            ok: true,
            received: req.body.value ?? null,
            jobs_count: jobs.length,
          };
        },
      },
    },
    status: () => {
      throw new Error('Simulated feature status failure');
    },
  };

  const { server } = createMawHttpServer({
    repoRoot,
    projectsRoot: path.dirname(repoRoot),
    userProfile: tempDir,
    mawHome: testMawHome,
    featuresDir: fixturesFeaturesDir,
    extraFeatures: [extraFeat],
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // 3. GET /api?action=hello_ping works and creates $MAW_HOME/data/hello
    const pingRes = await rawHttpRequest({
      port,
      path: '/api?action=hello_ping&msg=f0-works',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(pingRes.statusCode, 200);
    const pingData = JSON.parse(pingRes.body) as {
      ok: boolean;
      feature: string;
      echo: string;
      data_dir: string;
    };
    assert.equal(pingData.ok, true);
    assert.equal(pingData.feature, 'hello');
    assert.equal(pingData.echo, 'f0-works');
    assert.ok(fs.existsSync(pingData.data_dir), 'featureDataDir should create directory on disk');

    // Method mismatch on GET feature route -> 405
    const wrongMethod = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=hello_ping',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(wrongMethod.statusCode, 405);

    // POST feature route enforces X-MAW-Request header (403 without it, 200 with it)
    const postForbidden = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=broken_post',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 42 }),
    });
    assert.equal(postForbidden.statusCode, 403);

    const postOk = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/api?action=broken_post',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-MAW-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 42 }),
    });
    assert.equal(postOk.statusCode, 200);
    const postOkData = JSON.parse(postOk.body) as { ok: boolean; received: number };
    assert.equal(postOkData.ok, true);
    assert.equal(postOkData.received, 42);

    // 4. GET /api?action=status includes feature names, feature_data.hello, feature_errors['broken-status'], and registry fields
    const statusRes = await rawHttpRequest({
      port,
      path: '/api?action=status',
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusJson = JSON.parse(statusRes.body) as {
      features: string[];
      feature_data: Record<string, { greeting?: string }>;
      feature_errors: Record<string, string>;
      ui_features: Array<{ name: string; script: string }>;
      agents: Array<{
        id: string;
        version: string | null;
        login_cmd: string[] | null;
        status_cmd: string[] | null;
        resume_args: string[] | null;
      }>;
    };

    assert.ok(statusJson.features.includes('hello'));
    assert.ok(statusJson.features.includes('broken-status'));
    assert.equal(statusJson.feature_data.hello?.greeting, 'Hello from F0 plugin!');
    assert.match(
      String(statusJson.feature_errors['broken-status'] ?? ''),
      /Simulated feature status failure/
    );
    // Since dashboard/feat-hello.js does not exist on disk, ui_features must NOT include it
    assert.equal(
      statusJson.ui_features.some((u) => u.name === 'hello'),
      false
    );

    // Check v4 registry extensions (login_cmd, status_cmd, resume_args, and versions)
    const claudeAgent = statusJson.agents.find((a) => a.id === 'claude');
    const codexAgent = statusJson.agents.find((a) => a.id === 'codex');
    const geminiAgent = statusJson.agents.find((a) => a.id === 'gemini');
    const cursorAgent = statusJson.agents.find((a) => a.id === 'cursor');
    const aiderAgent = statusJson.agents.find((a) => a.id === 'aider');

    assert.deepEqual(claudeAgent?.login_cmd, ['claude', '/login']);
    assert.deepEqual(claudeAgent?.status_cmd, ['claude', 'auth', 'status']);
    assert.deepEqual(claudeAgent?.resume_args, ['--resume', '{session_id}']);
    assert.ok(claudeAgent?.version && claudeAgent.version.length > 0, 'claude version should be populated');

    assert.deepEqual(codexAgent?.login_cmd, ['codex', 'login']);
    assert.deepEqual(codexAgent?.status_cmd, ['codex', 'login', 'status']);
    assert.deepEqual(codexAgent?.resume_args, ['exec', 'resume', '{session_id}']);
    assert.ok(codexAgent?.version && codexAgent.version.length > 0, 'codex version should be populated');

    assert.deepEqual(geminiAgent?.login_cmd, ['gemini']);
    assert.deepEqual(geminiAgent?.resume_args, ['--resume', '{session_id}']);
    assert.deepEqual(cursorAgent?.login_cmd, ['cursor-agent', 'login']);
    assert.equal(aiderAgent?.login_cmd, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  }
});


