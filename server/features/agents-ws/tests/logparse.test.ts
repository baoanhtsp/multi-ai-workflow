import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobLog } from '../lib/logparse.ts';

test('logparse: Claude log with model, tokens, cost and reply', () => {
  const log = `
[01:00:00] Invoking Claude runner
--------------------------------------------------
[Connected] Model: claude-3-5-sonnet-20241022
{"type":"stream_start"}
Hello! Here is the implementation:
\`\`\`typescript
const x = 1;
\`\`\`
[Completed | Tokens: 1,234 in / 567 out | Cost: $0.0456]
=== [JOB_FINISHED exit_code=0] ===
`;

  const parsed = parseJobLog(log);
  assert.equal(parsed.actual_model, 'claude-3-5-sonnet-20241022');
  assert.equal(parsed.tokens_in, 1234);
  assert.equal(parsed.tokens_out, 567);
  assert.equal(parsed.cost_usd, 0.0456);
  assert.equal(parsed.auth_error, false);
  assert.ok(parsed.reply.includes('Hello! Here is the implementation:'));
  assert.ok(!parsed.reply.includes('[Connected]'));
  assert.ok(!parsed.reply.includes('[Completed'));
  assert.ok(!parsed.reply.includes('JOB_FINISHED'));
});

test('logparse: Codex log with thread id and model', () => {
  const log = `
--------------------------------------------------
[Connected] OpenAI Codex Thread: th_abc123 | Model: gpt-5.6-sol
I have refactored the database schema.
All tests pass.
[Completed | Tokens: 800 in / 200 out | Cost: $0.0120]
=== [JOB_FINISHED exit_code=0] ===
`;

  const parsed = parseJobLog(log);
  assert.equal(parsed.actual_model, 'gpt-5.6-sol');
  assert.equal(parsed.resume_token, 'th_abc123');
  assert.equal(parsed.tokens_in, 800);
  assert.equal(parsed.tokens_out, 200);
  assert.equal(parsed.cost_usd, 0.012);
  assert.ok(parsed.reply.includes('I have refactored the database schema.'));
});

test('logparse: Antigravity log with CONVERSATION_ID', () => {
  const log = `
--------------------------------------------------
CONVERSATION_ID: conv-uuid-98765
[Action] Editing server/http.ts
Code modified successfully.
=== [JOB_FINISHED exit_code=0] ===
`;

  const parsed = parseJobLog(log);
  assert.equal(parsed.resume_token, 'conv-uuid-98765');
  assert.ok(parsed.reply.includes('Code modified successfully.'));
  assert.ok(!parsed.reply.includes('[Action]'));
});

test('logparse: Failed job fallback to last 30 log lines', () => {
  const lines: string[] = ['--------------------------------------------------'];
  for (let i = 1; i <= 50; i++) {
    lines.push(`[Action] step ${i}`);
  }
  lines.push('=== [JOB_FINISHED exit_code=1] ===');
  const log = lines.join('\n');

  const parsed = parseJobLog(log, { isFailed: true });
  assert.ok(parsed.reply.length > 0);
  const replyLines = parsed.reply.split('\n');
  assert.ok(replyLines.length <= 30);
  assert.ok(parsed.reply.includes('[Action] step 50'));
});

test('logparse: Auth error detection', () => {
  const log1 = `
--------------------------------------------------
Error: OAuth session expired. Please sign in again.
=== [JOB_FINISHED exit_code=1] ===
`;
  assert.equal(parseJobLog(log1).auth_error, true);

  const log2 = `
--------------------------------------------------
401 Unauthorized: login required
=== [JOB_FINISHED exit_code=1] ===
`;
  assert.equal(parseJobLog(log2).auth_error, true);

  const log3 = `
--------------------------------------------------
Fatal: Please set an Auth method to continue.
=== [JOB_FINISHED exit_code=1] ===
`;
  assert.equal(parseJobLog(log3).auth_error, true);
});
