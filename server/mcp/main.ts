import readline from 'node:readline';

const VERSION = '1.0.0';

// Parse command line arguments: node server/mcp/main.ts [--url http://127.0.0.1:4317]
let mawUrl = process.env.MAW_URL || 'http://127.0.0.1:4317';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--url' && process.argv[i + 1]) {
    mawUrl = process.argv[i + 1]!;
  }
}
mawUrl = mawUrl.replace(/\/+$/, '');

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function sendJson(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResponse(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  sendJson({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function sendError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown
): void {
  // Suppress replies only for notifications (id is undefined and not a parse error)
  if (id === undefined && code !== -32700) return;
  sendJson({
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  });
}

async function callMawApi(
  action: string,
  method: 'GET' | 'POST',
  paramsOrBody?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
  try {
    let url = `${mawUrl}/api?action=${encodeURIComponent(action)}`;
    let bodyPayload: string | undefined;

    if (method === 'GET' && paramsOrBody) {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(paramsOrBody)) {
        if (v !== undefined && v !== null) {
          search.set(k, String(v));
        }
      }
      url += `&${search.toString()}`;
    } else if (method === 'POST') {
      bodyPayload = JSON.stringify(paramsOrBody ?? {});
    }

    const host = new URL(mawUrl).host;
    const resp = await fetch(url, {
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        'X-MAW-Request': '1',
      },
      body: bodyPayload,
      signal: AbortSignal.timeout(15000),
    });

    const json = (await resp.json()) as Record<string, unknown>;
    return {
      ok: resp.ok && Boolean(json?.ok),
      status: resp.status,
      data: json,
      error: (json?.error as string) || (resp.ok ? undefined : `HTTP ${resp.status}`),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err as Error)?.message ?? 'Failed to connect to MAW Dashboard API',
    };
  }
}

const TOOLS = [
  {
    name: 'list_agents',
    description: 'List all agents registered in Multi-AI Workflow with installation and health readiness',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description: 'Create a task card on the S2 task board',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        prompt: { type: 'string', description: 'Detailed prompt instructions' },
        project_path: { type: 'string', description: 'Target project directory' },
        agent: { type: 'string', description: 'Assigned agent id' },
        role: { type: 'string', description: 'Assigned role' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_job',
    description: 'Dispatch a background job with an agent in Multi-AI Workflow',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Project directory path' },
        prompt: { type: 'string', description: 'Prompt instructions' },
        agent: { type: 'string', description: 'Executing agent (e.g. claude, codex, gemini)' },
        role: { type: 'string', description: 'Executing role (e.g. backend, reviewer, tester)' },
        mode: { type: 'string', description: 'Execution mode (default: task)' },
        model: { type: 'string', description: 'Model override' },
        effort: { type: 'string', description: 'Effort level override' },
      },
      required: ['project_path', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_status',
    description: 'Query status, exit code, and log output tail of a job',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID to check (e.g. job_20261025_...)' },
        tail_bytes: { type: 'number', description: 'Bytes of log tail to return (<= 16000, default 4000)' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_review',
    description: 'Run Council Review with multiple reviewers on the project changes',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Project directory path' },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reviewer agent IDs (e.g. ["claude", "codex"])',
        },
      },
      required: ['project_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox',
    description: 'Query open attention inbox items and actionable requests',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'all'], description: 'Filter by status (default: open)' },
        limit: { type: 'number', description: 'Maximum items to return' },
      },
      additionalProperties: false,
    },
  },
];

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (name === 'list_agents') {
    const res = await callMawApi('status', 'GET');
    if (!res.ok || !res.data) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to list agents: ${res.error ?? 'Unknown error'}` }],
      };
    }
    const agents = res.data.agents ?? [];
    const health = (res.data.feature_data as any)?.health ?? null;
    return {
      content: [{ type: 'text', text: JSON.stringify({ agents, health }, null, 2) }],
    };
  }

  if (name === 'create_task') {
    const res = await callMawApi('task_create', 'POST', args);
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'task board not available' }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
    };
  }

  if (name === 'start_job') {
    const res = await callMawApi('run_job', 'POST', {
      mode: 'task',
      ...args,
    });
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to start job: ${res.error ?? 'Unknown error'}` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
    };
  }

  if (name === 'job_status') {
    const tailBytes = Math.min(16000, Math.max(1, Number(args.tail_bytes ?? 4000)));
    const initRes = await callMawApi('job_status', 'GET', {
      job_id: args.job_id,
      offset: 0,
    });
    if (!initRes.ok || !initRes.data) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Job status query failed: ${initRes.error ?? 'Unknown error'}` }],
      };
    }

    let finalData = initRes.data;
    const fullSize = Number(initRes.data.full_log_size ?? 0);
    const targetOffset = Math.max(0, fullSize - tailBytes);

    if (targetOffset > 0) {
      const tailRes = await callMawApi('job_status', 'GET', {
        job_id: args.job_id,
        offset: targetOffset,
      });
      if (tailRes.ok && tailRes.data) {
        finalData = tailRes.data;
      }
    }

    const logChunk = String(finalData.log_chunk ?? '');
    const tailText = logChunk.length > tailBytes ? logChunk.slice(-tailBytes) : logChunk;
    const summary = {
      job_id: finalData.job_id,
      status: finalData.status,
      exit_code: finalData.exit_code,
      elapsed_sec: finalData.elapsed_sec,
      log_tail: tailText,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
  }

  if (name === 'request_review') {
    const res = await callMawApi('run_job', 'POST', {
      mode: 'council',
      project_path: args.project_path,
      reviewers: args.reviewers ?? ['claude', 'codex'],
      prompt: 'Review the current changes',
    });
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to request review: ${res.error ?? 'Unknown error'}` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
    };
  }

  if (name === 'inbox') {
    const res = await callMawApi('inbox_list', 'GET', args);
    if (!res.ok || !res.data) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to query inbox: ${res.error ?? 'Unknown error'}` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool '${name}'` }],
  };
}

export async function processJsonRpcMessage(rawLine: string): Promise<void> {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    sendError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    const requestedVersion = String(params?.protocolVersion ?? '');
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : '2025-06-18';

    sendResponse(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'maw-dashboard',
        version: VERSION,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client notification, no reply
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, {
      tools: TOOLS,
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = String(params?.name ?? '');
    const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
    try {
      const toolRes = await handleToolCall(toolName, toolArgs);
      sendResponse(id, toolRes);
    } catch (err) {
      sendResponse(id, {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${(err as Error)?.message ?? 'Unknown error'}` }],
      });
    }
    return;
  }

  // Unknown method
  sendError(id, -32601, `Method not found: ${method}`);
}

// Stdio reader
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  void processJsonRpcMessage(line);
});

rl.on('close', () => {
  process.exit(0);
});
