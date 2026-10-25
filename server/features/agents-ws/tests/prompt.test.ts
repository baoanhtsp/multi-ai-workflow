import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt } from '../lib/prompt.ts';

test('prompt: Section ordering and Lead dispatch tool inclusion', () => {
  const prompt = buildPrompt({
    agent: {
      name: 'Architect Bob',
      team_role: 'lead',
      persona: 'Expert system designer',
      may_delegate: true,
      hooks: {
        before: '[Pre-check]',
        after: '[Post-check]',
      },
    },
    newMessageText: 'Plan the authentication migration.',
    summary: 'Previous discussions on JWT tokens.',
    session: 2,
    memoryContext: '- ADR-0001 Use OAuth 2.0',
    recentMessages: [
      { seq: 1, role: 'user', text: 'Hi' },
      { seq: 2, role: 'assistant', text: 'Hello, ready to work.' },
    ],
    teamMembers: [
      { key: 'worker', name: 'Worker Alice', platform: 'codex', responsibility: 'Implement code' },
    ],
  });

  // Verify section order:
  // 1. # Agent
  // 2. # Project memory
  // 3. # Conversation summary
  // 4. # Recent messages
  // 5. # Message
  // 6. # Dispatch Tool

  const agentIdx = prompt.indexOf('# Agent');
  const memIdx = prompt.indexOf('# Project memory');
  const sumIdx = prompt.indexOf('# Conversation summary (session 2)');
  const recIdx = prompt.indexOf('# Recent messages');
  const msgIdx = prompt.indexOf('# Message');
  const dispIdx = prompt.indexOf('# Dispatch Tool');

  assert.ok(agentIdx !== -1, '# Agent present');
  assert.ok(memIdx !== -1, '# Project memory present');
  assert.ok(sumIdx !== -1, '# Conversation summary present');
  assert.ok(recIdx !== -1, '# Recent messages present');
  assert.ok(msgIdx !== -1, '# Message present');
  assert.ok(dispIdx !== -1, '# Dispatch Tool present');

  assert.ok(agentIdx < memIdx, 'Agent before Memory');
  assert.ok(memIdx < sumIdx, 'Memory before Summary');
  assert.ok(sumIdx < recIdx, 'Summary before Recent');
  assert.ok(recIdx < msgIdx, 'Recent before Message');
  assert.ok(msgIdx < dispIdx, 'Message before Dispatch');

  assert.ok(prompt.includes('[Pre-check]'), 'Before hook included');
  assert.ok(prompt.includes('[Post-check]'), 'After hook included');
  assert.ok(prompt.includes('Worker Alice'), 'Team member included in dispatch tool');
});

test('prompt: Dispatch instructions omitted when may_delegate is false', () => {
  const prompt = buildPrompt({
    agent: {
      name: 'Worker Dave',
      team_role: 'worker',
      may_delegate: false,
    },
    newMessageText: 'Write unit tests.',
  });

  assert.ok(!prompt.includes('# Dispatch Tool'), 'Dispatch tool omitted');
  assert.ok(prompt.includes('Name: Worker Dave'));
});

test('prompt: Trimming order preserves message and respects 17 000 char budget', () => {
  const longHistory = [];
  for (let i = 1; i <= 20; i++) {
    longHistory.push({
      seq: i,
      role: (i % 2 === 1 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Historical message number ${i}: `.repeat(50),
    });
  }

  const bigMemory = 'Memory item '.repeat(300);
  const bigSummary = 'Summary info '.repeat(200);
  const vitalNewMessage = 'CRITICAL NEW TASK: MUST NOT BE DROPPED OR TRIMMED!';

  const prompt = buildPrompt({
    agent: { name: 'Lead' },
    newMessageText: vitalNewMessage,
    summary: bigSummary,
    memoryContext: bigMemory,
    recentMessages: longHistory,
    maxChars: 17000,
  });

  assert.ok(prompt.length <= 17000, `Prompt length ${prompt.length} exceeds 17 000`);
  assert.ok(prompt.includes(vitalNewMessage), 'New message must be completely preserved');
});
