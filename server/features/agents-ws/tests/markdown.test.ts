import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDecisionsMarkdown,
  renderDecisionsMarkdown,
  type MemoryEntry,
} from '../lib/markdown-memory.ts';
import {
  parseRoleMarkdown,
  renderRoleMarkdown,
  type RoleSections,
} from '../lib/markdown-roles.ts';

test('markdown: Role-md round trip with EN headings and custom extra sections', () => {
  const originalMd = `# Lead Developer

## Responsibility
Lead architectural planning and review.

## Delegation & reporting
Delegate implementation tasks to workers.

## Output
Signed off architecture specs.

## Permissions
Write access to specs/** and .maw/**.

## Custom Team Guidelines
Always write tests before PR.
`;

  const { name, sections } = parseRoleMarkdown(originalMd);
  assert.equal(name, 'Lead Developer');
  assert.equal(sections.responsibility, 'Lead architectural planning and review.');
  assert.equal(sections.delegation, 'Delegate implementation tasks to workers.');
  assert.equal(sections.output, 'Signed off architecture specs.');
  assert.equal(sections.permissions, 'Write access to specs/** and .maw/**.');
  assert.ok(sections.extra?.includes('Custom Team Guidelines'));

  const rendered = renderRoleMarkdown(name, sections);
  const reParsed = parseRoleMarkdown(rendered);
  assert.equal(reParsed.name, name);
  assert.equal(reParsed.sections.responsibility, sections.responsibility);
  assert.equal(reParsed.sections.delegation, sections.delegation);
  assert.equal(reParsed.sections.output, sections.output);
  assert.equal(reParsed.sections.permissions, sections.permissions);
  assert.ok(reParsed.sections.extra?.includes('Custom Team Guidelines'));
});

test('markdown: Role-md with Vietnamese headings', () => {
  const viMd = `# Kỹ sư Kiểm thử

## Trách nhiệm
Viết test tự động và kiểm thử hồi quy.

## Giao việc & báo cáo
Báo cáo kết quả kiểm thử cho Lead.

## Đầu ra
Báo cáo kiểm thử và test suite hoàn chỉnh.

## Quyền
Quyền ghi trong thư mục tests/**.
`;

  const { name, sections } = parseRoleMarkdown(viMd);
  assert.equal(name, 'Kỹ sư Kiểm thử');
  assert.equal(sections.responsibility, 'Viết test tự động và kiểm thử hồi quy.');
  assert.equal(sections.delegation, 'Báo cáo kết quả kiểm thử cho Lead.');
  assert.equal(sections.output, 'Báo cáo kiểm thử và test suite hoàn chỉnh.');
  assert.equal(sections.permissions, 'Quyền ghi trong thư mục tests/**.');
});

test('markdown: decisions.md parse and render round trip with comments and hand edits', () => {
  const doc = `# Project decisions
Preamble text documenting project context.

## ADR-0001 · Use Node 24 natively
<!-- maw-memory {"id":"ADR-0001","date":"2026-10-25","source":"tech-lead","agent":"claude","pinned":true,"tags":["runtime","ts"]} -->
We use Node 24 with native TypeScript type stripping to avoid build steps.

## ADR-0002 · Hand-edited decision without comment
Hand-written body text without metadata comment.
`;

  const { preamble, entries } = parseDecisionsMarkdown(doc);
  assert.ok(preamble.includes('Preamble text'));
  assert.equal(entries.length, 2);

  assert.equal(entries[0]!.id, 'ADR-0001');
  assert.equal(entries[0]!.title, 'Use Node 24 natively');
  assert.equal(entries[0]!.pinned, true);
  assert.deepEqual(entries[0]!.tags, ['runtime', 'ts']);
  assert.ok(entries[0]!.body.includes('native TypeScript'));

  assert.equal(entries[1]!.id, 'ADR-0002');
  assert.equal(entries[1]!.title, 'Hand-edited decision without comment');
  assert.equal(entries[1]!.pinned, false);
  assert.ok(entries[1]!.body.includes('Hand-written body text'));

  // Round trip
  const rendered = renderDecisionsMarkdown(preamble, entries);
  const reParsed = parseDecisionsMarkdown(rendered);
  assert.equal(reParsed.entries.length, 2);
  assert.equal(reParsed.entries[0]!.id, 'ADR-0001');
  assert.equal(reParsed.entries[1]!.id, 'ADR-0002');
});

test('markdown: [Item 6] decisions.md ignores ## ADR- lines inside fenced code blocks', () => {
  const doc = `# Project decisions
Preamble notes.

## ADR-0001 · Architecture decision
<!-- maw-memory {"id":"ADR-0001","date":"2026-10-25","source":"lead","pinned":true,"tags":["arch"]} -->
Here is an example markdown file in our documentation:

\`\`\`markdown
## ADR-0099 · Example fake ADR inside code block
<!-- maw-memory {"id":"ADR-0099"} -->
Code block content
\`\`\`

And regular text afterwards.

## ADR-0002 · Real second decision
<!-- maw-memory {"id":"ADR-0002","date":"2026-10-25","source":"worker"} -->
Second decision body.
`;

  const { preamble, entries } = parseDecisionsMarkdown(doc);
  assert.equal(entries.length, 2, 'Must have exactly 2 entries; code block ADR heading must be ignored');
  assert.equal(entries[0]!.id, 'ADR-0001');
  assert.ok(entries[0]!.body.includes('## ADR-0099 · Example fake ADR inside code block'));
  assert.ok(entries[0]!.body.includes('And regular text afterwards.'));

  assert.equal(entries[1]!.id, 'ADR-0002');
  assert.equal(entries[1]!.title, 'Real second decision');

  // Round trip
  const rendered = renderDecisionsMarkdown(preamble, entries);
  const reParsed = parseDecisionsMarkdown(rendered);
  assert.equal(reParsed.entries.length, 2);
  assert.equal(reParsed.entries[0]!.id, 'ADR-0001');
  assert.ok(reParsed.entries[0]!.body.includes('## ADR-0099'));
  assert.equal(reParsed.entries[1]!.id, 'ADR-0002');
});
