import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseHandoffDispatchBlock,
  parseStructuredHandoffResult,
} from '../lib/handoff-block.ts';

test('handoff-block: parseHandoffDispatchBlock parses valid handoffs', () => {
  const text = `
I have designed the architecture. Now delegating to members:

\`\`\`handoff
{
  "handoffs": [
    {
      "to": "worker",
      "task": "Implement feature S6 agent workspace",
      "acceptance": "npm run typecheck passes",
      "thread": "h_prev123"
    },
    {
      "to": "testing",
      "task": "Write end to end tests"
    }
  ]
}
\`\`\`
`;

  const res = parseHandoffDispatchBlock(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.handoffs.length, 2);
    assert.equal(res.handoffs[0]!.to, 'worker');
    assert.equal(res.handoffs[0]!.task, 'Implement feature S6 agent workspace');
    assert.equal(res.handoffs[0]!.acceptance, 'npm run typecheck passes');
    assert.equal(res.handoffs[0]!.thread, 'h_prev123');

    assert.equal(res.handoffs[1]!.to, 'testing');
    assert.equal(res.handoffs[1]!.acceptance, '');
    assert.equal(res.handoffs[1]!.thread, '');
  }
});

test('handoff-block: parseHandoffDispatchBlock rejects missing block and invalid json', () => {
  const missing = parseHandoffDispatchBlock('No handoff block here.');
  assert.equal(missing.ok, false);

  const invalidJson = parseHandoffDispatchBlock('```handoff\n{ bad json }\n```');
  assert.equal(invalidJson.ok, false);

  const emptyHandoffs = parseHandoffDispatchBlock('```handoff\n{ "handoffs": [] }\n```');
  assert.equal(emptyHandoffs.ok, false);

  const tooMany = parseHandoffDispatchBlock(
    '```handoff\n{ "handoffs": [ ' +
      new Array(7).fill('{"to":"w","task":"t"}').join(',') +
      ' ] }\n```'
  );
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) {
    assert.ok(tooMany.error.includes('Maximum 6'));
  }
});

test('handoff-block: parseStructuredHandoffResult extracts last json block with cost priority', () => {
  const reply = `
Starting work...
Some intermediate json:
\`\`\`json
{ "status": "failed" }
\`\`\`
Final result:
\`\`\`json
{
  "status": "completed",
  "summary": "Completed successfully.",
  "files_changed": ["server/feature.ts", "package.json"],
  "evidence": "10 tests passed",
  "blockers": [],
  "cost": 0.05,
  "decisions": ["Used SSE instead of polling"]
}
\`\`\`
`;

  const res = parseStructuredHandoffResult(reply, 0.042);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.result.status, 'completed');
    assert.equal(res.result.summary, 'Completed successfully.');
    assert.deepEqual(res.result.files_changed, ['server/feature.ts', 'package.json']);
    assert.equal(res.result.evidence, '10 tests passed');
    assert.deepEqual(res.result.decisions, ['Used SSE instead of polling']);
    // Parsed job cost wins over self-reported cost
    assert.equal(res.result.cost, 0.042);
  }
});

test('handoff-block: parseStructuredHandoffResult fallback on invalid or missing json', () => {
  const missing = parseStructuredHandoffResult('No json block found in output', null);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.fallbackResult.status, 'failed');
    assert.equal(missing.fallbackResult.summary, 'No json block found in output');
  }

  const badStatus = parseStructuredHandoffResult(
    '```json\n{ "status": "not-a-valid-status", "summary": "oops" }\n```',
    null
  );
  assert.equal(badStatus.ok, false);
  if (!badStatus.ok) {
    assert.equal(badStatus.fallbackResult.status, 'failed');
  }
});

test('handoff-block: [Item 2] incomplete structured result requires summary, files_changed, evidence, blockers', () => {
  // {"status":"completed"} missing summary
  const missingSummary = parseStructuredHandoffResult('```json\n{"status":"completed"}\n```', null);
  assert.equal(missingSummary.ok, false);
  if (!missingSummary.ok) {
    assert.match(missingSummary.error, /"summary"/);
  }

  // missing files_changed
  const missingFiles = parseStructuredHandoffResult(
    '```json\n{"status":"completed","summary":"done"}\n```',
    null
  );
  assert.equal(missingFiles.ok, false);
  if (!missingFiles.ok) {
    assert.match(missingFiles.error, /"files_changed"/);
  }

  // missing evidence
  const missingEvidence = parseStructuredHandoffResult(
    '```json\n{"status":"completed","summary":"done","files_changed":[]}\n```',
    null
  );
  assert.equal(missingEvidence.ok, false);
  if (!missingEvidence.ok) {
    assert.match(missingEvidence.error, /"evidence"/);
  }

  // missing blockers
  const missingBlockers = parseStructuredHandoffResult(
    '```json\n{"status":"completed","summary":"done","files_changed":[],"evidence":""}\n```',
    null
  );
  assert.equal(missingBlockers.ok, false);
  if (!missingBlockers.ok) {
    assert.match(missingBlockers.error, /"blockers"/);
  }

  // all valid
  const allValid = parseStructuredHandoffResult(
    '```json\n{"status":"completed","summary":"done","files_changed":[],"evidence":"","blockers":[]}\n```',
    null
  );
  assert.equal(allValid.ok, true);
});
