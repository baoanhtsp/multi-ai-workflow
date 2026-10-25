import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

test('MCP server stdio JSON-RPC protocol end-to-end', async () => {
  // 1. Start a fake MAW HTTP API server
  const fakeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const action = url.searchParams.get('action');

    res.setHeader('Content-Type', 'application/json');

    if (action === 'status') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          agents: [
            { id: 'claude', label: 'Claude Code', installed: true, version: '2.1.308' },
            { id: 'codex', label: 'OpenAI Codex', installed: true, version: '0.163.0' },
          ],
          feature_data: {
            health: {
              summary: { ok: 2, warn: 0, error: 0 },
            },
          },
        })
      );
      return;
    }

    if (action === 'inbox_list') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          items: [{ id: 'i123456', kind: 'failed', title: 'Test failed job' }],
          counts: { open: 1, by_kind: { failed: 1 } },
        })
      );
      return;
    }

    if (action === 'run_job') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            job_id: 'job_mcp_test_001',
            status: 'RUNNING',
          })
        );
      });
      return;
    }

    if (action === 'job_status') {
      const jobId = url.searchParams.get('job_id');
      const offset = Number(url.searchParams.get('offset') ?? 0);

      if (jobId === 'job_big_log') {
        const fullSize = 20000;
        if (offset === 0) {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_big_log',
              status: 'RUNNING',
              full_log_size: fullSize,
              log_chunk: 'OLD_PREFIX_OFFSET_0_OUTPUT',
            })
          );
        } else {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_big_log',
              status: 'RUNNING',
              full_log_size: fullSize,
              log_chunk: 'REAL_END_TAIL_AT_OFFSET_' + offset,
            })
          );
        }
        return;
      }

      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          job_id: 'job_mcp_test_001',
          status: 'DONE',
          exit_code: 0,
          elapsed_sec: 5,
          full_log_size: 50,
          log_chunk: 'Build succeeded.\nTests passed 100%.\n',
        })
      );
      return;
    }

    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: `Unknown action ${action}` }));
  });

  await new Promise<void>((resolve) => {
    fakeServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = fakeServer.address() as { port: number };
  const fakeUrl = `http://127.0.0.1:${addr.port}`;

  // 2. Spawn MCP server process
  const mainTs = path.resolve(import.meta.dirname, 'main.ts');
  const child = spawn(process.execPath, [mainTs, '--url', fakeUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses: any[] = [];
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line.trim()));
        } catch {
          // Ignore
        }
      }
    }
  });

  async function waitForResponse(id: number, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for response to id ${id}`);
  }

  function sendRpc(msg: any): void {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  try {
    // 1. Initialize
    sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    const initRes = await waitForResponse(1);
    assert.equal(initRes.result.protocolVersion, '2025-06-18');
    assert.equal(initRes.result.serverInfo.name, 'maw-dashboard');

    // 2. tools/list
    sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const listRes = await waitForResponse(2);
    assert.ok(Array.isArray(listRes.result.tools));
    const toolNames = listRes.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('list_agents'));
    assert.ok(toolNames.includes('start_job'));
    assert.ok(toolNames.includes('job_status'));
    assert.ok(toolNames.includes('inbox'));

    // 3. tools/call -> list_agents
    sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'list_agents',
        arguments: {},
      },
    });
    const callRes1 = await waitForResponse(3);
    assert.equal(Boolean(callRes1.result.isError), false);
    const parsedText1 = JSON.parse(callRes1.result.content[0].text);
    assert.equal(parsedText1.agents.length, 2);

    // 4. tools/call -> start_job
    sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'start_job',
        arguments: {
          project_path: 'C:\\test\\proj',
          prompt: 'Do something',
        },
      },
    });
    const callRes2 = await waitForResponse(4);
    assert.equal(Boolean(callRes2.result.isError), false);
    const parsedText2 = JSON.parse(callRes2.result.content[0].text);
    assert.equal(parsedText2.job_id, 'job_mcp_test_001');

    // 5. tools/call -> job_status
    sendRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'job_status',
        arguments: {
          job_id: 'job_mcp_test_001',
        },
      },
    });
    const callRes3 = await waitForResponse(5);
    assert.equal(Boolean(callRes3.result.isError), false);
    const parsedText3 = JSON.parse(callRes3.result.content[0].text);
    assert.equal(parsedText3.status, 'DONE');
    assert.ok(parsedText3.log_tail.includes('Build succeeded'));

    // 6. Unknown method => -32601
    sendRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'non_existent_method',
    });
    const callRes4 = await waitForResponse(6);
    assert.equal(callRes4.error.code, -32601);

    // 7. Malformed JSON returns parse error -32700 with id null (Item 10)
    child.stdin.write('{"invalid json\n');
    const parseErrRes = await waitForResponse(null as any);
    assert.equal(parseErrRes.id, null);
    assert.equal(parseErrRes.error.code, -32700);
    assert.equal(parseErrRes.error.message, 'Parse error');

    // 8. job_status tail offset query for big log (Item 8)
    sendRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'job_status',
        arguments: {
          job_id: 'job_big_log',
          tail_bytes: 4000,
        },
      },
    });
    const bigJobRes = await waitForResponse(8);
    assert.equal(Boolean(bigJobRes.result.isError), false);
    const parsedBig = JSON.parse(bigJobRes.result.content[0].text);
    assert.ok(parsedBig.log_tail.includes('REAL_END_TAIL_AT_OFFSET_16000'));
    assert.ok(!parsedBig.log_tail.includes('OLD_PREFIX_OFFSET_0_OUTPUT'));
  } finally {
    child.kill();
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  }
});
