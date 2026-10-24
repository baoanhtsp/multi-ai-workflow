export interface ParsedJobLog {
  reply: string;
  actual_model: string;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  resume_token: string;
  auth_error: boolean;
}

const AUTH_ERROR_PATTERNS = [
  /OAuth session expired/i,
  /Please set an Auth method/i,
  /not logged in/i,
  /401 Unauthorized/i,
  /login required/i,
];

export function parseJobLog(
  logText: string,
  options?: { isFailed?: boolean }
): ParsedJobLog {
  const raw = String(logText ?? '').replace(/^\uFEFF/, '');
  const hasFailureMarker = /exit_code=[1-9]\d*|\[JOB_FAILED\]/i.test(raw);
  const isFailed = options?.isFailed ?? hasFailureMarker;
  const allLines = raw.split(/\r?\n/);

  let actual_model = '';
  let resume_token = '';
  let cost_usd: number | null = null;
  let tokens_in: number | null = null;
  let tokens_out: number | null = null;
  let auth_error = false;

  // Check auth error only for failed jobs (Item 12)
  if (isFailed) {
    for (const pattern of AUTH_ERROR_PATTERNS) {
      if (pattern.test(raw)) {
        auth_error = true;
        break;
      }
    }
  }

  // Find first "-----" line to skip runner header
  let startIndex = 0;
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!.trim();
    if (/^-{5,}$/.test(line)) {
      startIndex = i + 1;
      break;
    }
  }

  const candidateLines = allLines.slice(startIndex);
  const replyLines: string[] = [];

  for (const line of candidateLines) {
    const trimmed = line.trim();

    // Check terminal markers to ignore
    if (
      trimmed.startsWith('=== [JOB_FINISHED') ||
      trimmed.startsWith('=== [MISSION CONTROL JOB') ||
      trimmed.startsWith('=== [JOB_CANCELLED')
    ) {
      continue;
    }

    // Extract actual_model from [Connected] line
    // e.g. [Connected] Model: claude-3-5-sonnet
    // or [Connected] OpenAI Codex Thread: t_123 | Model: gpt-5.6-sol
    if (trimmed.includes('[Connected]') || trimmed.startsWith('[Connected]')) {
      const modelMatch = /Model:\s*([a-zA-Z0-9._-]+)/i.exec(trimmed);
      if (modelMatch) {
        actual_model = modelMatch[1]!;
      }
    }

    // Extract resume_token:
    // 1. Codex thread id
    const threadMatch = /(?:OpenAI Codex Thread:|Thread:)\s*([a-zA-Z0-9._-]+)/i.exec(trimmed);
    if (threadMatch && !resume_token) {
      resume_token = threadMatch[1]!;
    }
    // 2. CONVERSATION_ID: <uuid>
    const cidMatch = /CONVERSATION_ID:\s*([a-zA-Z0-9._-]+)/i.exec(trimmed);
    if (cidMatch && !resume_token) {
      resume_token = cidMatch[1]!;
    }
    // 3. "session_id":"<id>" in Claude stream-json line
    const sessMatch = /"session_id"\s*:\s*"([^"]+)"/.exec(trimmed);
    if (sessMatch && !resume_token) {
      resume_token = sessMatch[1]!;
    }

    // Extract cost / tokens
    // e.g. [Completed … | Tokens: 1,234 in / 567 out | … Cost: $0.0123]
    if (trimmed.includes('Tokens:') || trimmed.includes('Cost:')) {
      const tokensMatch = /Tokens:\s*([0-9,]+)\s*in\s*\/\s*([0-9,]+)\s*out/i.exec(trimmed);
      if (tokensMatch) {
        tokens_in = Number.parseInt(tokensMatch[1]!.replace(/,/g, ''), 10);
        tokens_out = Number.parseInt(tokensMatch[2]!.replace(/,/g, ''), 10);
      }
      const costMatch = /Cost:\s*\$([0-9.]+)/i.exec(trimmed);
      if (costMatch) {
        cost_usd = Number.parseFloat(costMatch[1]!);
      }
    }

    // Filter out metadata and control lines for reply
    if (
      trimmed.startsWith('[Connected]') ||
      trimmed.startsWith('[Action]') ||
      trimmed.startsWith('[Done]') ||
      trimmed.startsWith('[Completed') ||
      trimmed.startsWith('[HOOK') ||
      trimmed.startsWith('HOOK_BLOCKED') ||
      /^\[\d{2}:\d{2}:\d{2}\]\s+Invoking/i.test(trimmed) ||
      (trimmed.startsWith('{"type":') && trimmed.endsWith('}'))
    ) {
      continue;
    }

    replyLines.push(line);
  }

  let reply = replyLines.join('\n').trim();

  // Empty reply on a FAILED job => the last 30 log lines as the error text
  if (!reply && isFailed) {
    const nonMarkerLines = allLines.filter(
      (l) =>
        !l.includes('=== [JOB_FINISHED') &&
        !l.includes('=== [MISSION CONTROL JOB') &&
        !l.includes('=== [JOB_CANCELLED')
    );
    reply = nonMarkerLines.slice(-30).join('\n').trim();
  }

  // Capped to 60 000 chars
  if (reply.length > 60000) {
    reply = reply.slice(0, 60000);
  }

  return {
    reply,
    actual_model,
    cost_usd,
    tokens_in,
    tokens_out,
    resume_token,
    auth_error,
  };
}
