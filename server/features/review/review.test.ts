import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  computeHunkId,
  parseUnifiedDiff,
  unquoteGitPath,
} from './diff.ts';
import { feature as reviewFeature } from './index.ts';

test('diff parser handles modify, add, delete, rename, binary, no-newline, CRLF, and quoted paths', () => {
  // 1. Quoted path unescaping
  assert.equal(unquoteGitPath('a/simple.txt'), 'simple.txt');
  assert.equal(unquoteGitPath('"a/path with spaces/file.txt"'), 'path with spaces/file.txt');
  assert.equal(unquoteGitPath('"a/quote\\"file.txt"'), 'quote"file.txt');
  assert.equal(unquoteGitPath('/dev/null'), '/dev/null');

  // 2. Synthetic raw diff with multiple file operations, CRLF and no-newline marker
  const sampleDiff =
    'diff --git a/src/index.ts b/src/index.ts\r\n' +
    'index 1234567..89abcdef 100644\r\n' +
    '--- a/src/index.ts\r\n' +
    '+++ b/src/index.ts\r\n' +
    '@@ -1,3 +1,4 @@\r\n' +
    ' export const a = 1;\r\n' +
    '-export const b = 2;\r\n' +
    '+export const b = 20;\r\n' +
    '+export const c = 30;\r\n' +
    ' export const d = 4;\r\n' +
    '\\ No newline at end of file\r\n' +
    'diff --git a/src/old.ts b/src/new.ts\r\n' +
    'similarity index 90%\r\n' +
    'rename from src/old.ts\r\n' +
    'rename to src/new.ts\r\n' +
    '--- a/src/old.ts\r\n' +
    '+++ b/src/new.ts\r\n' +
    '@@ -1,1 +1,1 @@\r\n' +
    '-old line\r\n' +
    '+new line\r\n' +
    'diff --git a/deleted.txt b/deleted.txt\r\n' +
    'deleted file mode 100644\r\n' +
    '--- a/deleted.txt\r\n' +
    '+++ /dev/null\r\n' +
    '@@ -1,1 +0,0 @@\r\n' +
    '-farewell\r\n' +
    'diff --git a/image.png b/image.png\r\n' +
    'new file mode 100644\r\n' +
    'Binary files /dev/null and b/image.png differ\r\n';

  const res = parseUnifiedDiff(sampleDiff);
  assert.equal(res.truncated, false);
  assert.equal(res.files.length, 4);

  // File 1: Modified
  const f1 = res.files[0]!;
  assert.equal(f1.path, 'src/index.ts');
  assert.equal(f1.status, 'M');
  assert.equal(f1.additions, 2);
  assert.equal(f1.deletions, 1);
  assert.equal(f1.hunks.length, 1);
  const h1 = f1.hunks[0]!;
  assert.equal(h1.old_start, 1);
  assert.equal(h1.old_lines, 3);
  assert.equal(h1.new_start, 1);
  assert.equal(h1.new_lines, 4);
  assert.ok(h1.lines.some(([p, t]) => p === '\\' && t.includes('No newline')));

  // Hunk ID stability
  const computedId = computeHunkId(f1.path, h1.header, h1.rawLines);
  assert.equal(h1.id, computedId);
  assert.equal(h1.id.length, 12);

  // File 2: Renamed
  const f2 = res.files[1]!;
  assert.equal(f2.path, 'src/new.ts');
  assert.equal(f2.old_path, 'src/old.ts');
  assert.equal(f2.status, 'R');

  // File 3: Deleted
  const f3 = res.files[2]!;
  assert.equal(f3.path, 'deleted.txt');
  assert.equal(f3.status, 'D');

  // File 4: Binary
  const f4 = res.files[3]!;
  assert.equal(f4.path, 'image.png');
  assert.equal(f4.binary, true);
  assert.equal(f4.status, 'B');
});

test('diff parser guards: too_large and truncated', () => {
  // Truncation guard: diff larger than 5 MB
  const bigLine = ' ' + 'x'.repeat(1000) + '\n';
  const repeats = Math.ceil((5.2 * 1024 * 1024) / 1000);
  const hugeDiff =
    'diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1 +1,1 @@\n' +
    bigLine.repeat(repeats);

  const truncRes = parseUnifiedDiff(hugeDiff);
  assert.equal(truncRes.truncated, true);

  // File too_large guard: > 3000 diff lines
  const linesCount = 3500;
  const longHunk =
    'diff --git a/many.txt b/many.txt\n--- a/many.txt\n+++ b/many.txt\n@@ -1,1 +1,1 @@\n' +
    '+add line\n'.repeat(linesCount);
  const largeRes = parseUnifiedDiff(longHunk);
  assert.equal(largeRes.files[0]!.too_large, true);
  assert.equal(largeRes.files[0]!.hunks.length, 0);

  // Lifted guard with full=true
  const fullRes = parseUnifiedDiff(longHunk, { full: true, targetPath: 'many.txt' });
  assert.equal(fullRes.files[0]!.too_large, false);
  assert.equal(fullRes.files[0]!.hunks.length, 1);
});

test('review end-to-end on temp git repo: worktree diff, reject hunk, audit log, comments, send_fix dry_run, verdict, commit source', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  // Initialize git repo in projectDir
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Initial file
  const fileA = path.win32.join(projectDir, 'a.txt');
  const initialContent =
    'line 1\n' +
    'line 2\n' +
    'line 3\n' +
    'line 4\n' +
    'line 5\n' +
    'line 6\n' +
    'line 7\n' +
    'line 8\n' +
    'line 9\n' +
    'line 10\n';
  fs.writeFileSync(fileA, initialContent, 'utf8');

  await runCommand('git', ['-C', projectDir, 'add', 'a.txt']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Initial commit']);

  // Get root commit sha
  const rootCommitRes = await runCommand('git', ['-C', projectDir, 'rev-parse', 'HEAD']);
  const rootCommitSha = rootCommitRes.stdout.trim();

  // Create two distinct hunks in a.txt
  const modifiedContent =
    'line 1 MODIFIED\n' +
    'line 2\n' +
    'line 3\n' +
    'line 4\n' +
    'line 5\n' +
    'line 6\n' +
    'line 7\n' +
    'line 8\n' +
    'line 9\n' +
    'line 10 MODIFIED\n';
  fs.writeFileSync(fileA, modifiedContent, 'utf8');

  // Add an untracked file
  const untrackedFile = path.win32.join(projectDir, 'untracked.txt');
  fs.writeFileSync(untrackedFile, 'brand new untracked content\n', 'utf8');

  // Fake context helper
  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [
      {
        job_id: 'job_20261025_010000_123456',
        agent: 'claude',
        role: 'backend',
        model: 'sonnet',
        status: 'DONE',
        project_path: projectDir,
        started_at: new Date().toISOString(),
      },
    ],
    startJob: async (body: any) => ({
      ok: true,
      job_id: 'job_20261025_020000_abcdef',
      ...body,
    }),
  };

  // 1. GET review_sources
  const sourcesRes = (await reviewFeature.routes.review_sources.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=review_sources&project_path=${encodeURIComponent(projectDir)}`),
      query: new URLSearchParams({ project_path: projectDir }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(sourcesRes.ok, true);
  assert.equal(sourcesRes.is_git, true);
  assert.equal(sourcesRes.commits.length, 1);
  assert.equal(sourcesRes.commits[0].sha, rootCommitSha);

  // 2. GET review_diff (source: worktree) -> includes untracked file
  const diffRes = (await reviewFeature.routes.review_diff.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=review_diff&project_path=${encodeURIComponent(projectDir)}&source=worktree`),
      query: new URLSearchParams({ project_path: projectDir, source: 'worktree' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(diffRes.ok, true);
  assert.equal(diffRes.writable, true);
  assert.equal(diffRes.files.length, 2);
  const fileADiff = diffRes.files.find((f: any) => f.path === 'a.txt');
  const untrackedDiff = diffRes.files.find((f: any) => f.path === 'untracked.txt');
  assert.ok(fileADiff);
  assert.ok(untrackedDiff);
  assert.equal(fileADiff.hunks.length, 2);

  const hunk1 = fileADiff.hunks[0]!;
  const hunk2 = fileADiff.hunks[1]!;

  // 3. POST review_hunk reject without confirm => 400
  await assert.rejects(
    async () => {
      await reviewFeature.routes.review_hunk.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL('http://127.0.0.1/api?action=review_hunk'),
          query: new URLSearchParams(),
          body: {
            project_path: projectDir,
            source: 'worktree',
            path: 'a.txt',
            hunk_id: hunk1.id,
            action: 'reject',
            confirm: false,
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // 4. POST review_hunk with stale hunk id => 409
  await assert.rejects(
    async () => {
      await reviewFeature.routes.review_hunk.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL('http://127.0.0.1/api?action=review_hunk'),
          query: new URLSearchParams(),
          body: {
            project_path: projectDir,
            source: 'worktree',
            path: 'a.txt',
            hunk_id: 'deadbeef1234',
            action: 'reject',
            confirm: true,
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409
  );

  // 5. POST review_hunk reject hunk1 with confirm: true
  // Check index state before reject:
  const indexStatusBefore = (await runCommand('git', ['-C', projectDir, 'diff', '--cached'])).stdout;
  assert.equal(indexStatusBefore, '');

  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'a.txt',
        hunk_id: hunk1.id,
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.action, 'reject');
  assert.ok(rejectRes.snapshot_ref);
  assert.match(rejectRes.snapshot_ref, /^refs\/maw\/checkpoints\/review-/);

  // Verify real index unchanged
  const indexStatusAfter = (await runCommand('git', ['-C', projectDir, 'diff', '--cached'])).stdout;
  assert.equal(indexStatusAfter, '');

  // Verify file content on disk: hunk1 reverted ('line 1'), hunk2 kept ('line 10 MODIFIED')
  const diskContentAfter = fs.readFileSync(fileA, 'utf8');
  assert.ok(diskContentAfter.includes('line 1'));
  assert.ok(!diskContentAfter.includes('line 1 MODIFIED'));
  assert.ok(diskContentAfter.includes('line 10 MODIFIED'));

  // Verify safety snapshot ref exists in git
  const snapCheck = await runCommand('git', ['-C', projectDir, 'rev-parse', '--verify', rejectRes.snapshot_ref]);
  assert.equal(snapCheck.code, 0);

  // Verify audit.jsonl has been written
  const auditFile = path.win32.join(mawHome, 'data', 'review', 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile));
  const auditContent = fs.readFileSync(auditFile, 'utf8');
  assert.ok(auditContent.includes('"action":"reject"'));
  assert.ok(auditContent.includes(rejectRes.snapshot_ref));

  // 6. Comments: add, edit, delete
  const addCommRes = (await reviewFeature.routes.review_comment.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_comment'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        op: 'add',
        path: 'a.txt',
        line: 10,
        side: 'new',
        quote: 'line 10 MODIFIED',
        body: 'Please simplify line 10',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(addCommRes.ok, true);
  assert.equal(addCommRes.comments.length, 1);
  const commId = addCommRes.comments[0].id;
  assert.equal(addCommRes.comments[0].body, 'Please simplify line 10');

  // Edit comment
  const editCommRes = (await reviewFeature.routes.review_comment.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_comment'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        op: 'edit',
        id: commId,
        body: 'Please simplify line 10 immediately',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;
  assert.equal(editCommRes.comments[0].body, 'Please simplify line 10 immediately');

  // 7. POST review_send_fix with dry_run: true
  const sendFixRes = (await reviewFeature.routes.review_send_fix.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_send_fix'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        note: 'Keep it clean.',
        dry_run: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(sendFixRes.ok, true);
  assert.ok(sendFixRes.prompt.includes('Code review feedback for my-repo (worktree)'));
  assert.ok(sendFixRes.prompt.includes('1. a.txt:10 (new side)'));
  assert.ok(sendFixRes.prompt.includes('> line 10 MODIFIED'));
  assert.ok(sendFixRes.prompt.includes('Rejected by the reviewer (already reverted — do not reintroduce):'));
  assert.ok(sendFixRes.prompt.includes('Reviewer note: Keep it clean.'));

  // 8. POST review_verdict on source=job -> appends to verdicts.jsonl
  const verdictRes = (await reviewFeature.routes.review_verdict.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_verdict'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'job',
        ref: 'job_20261025_010000_123456',
        verdict: 'APPROVED',
        score: 9.5,
        note: 'Great job!',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(verdictRes.ok, true);
  assert.equal(verdictRes.verdict.verdict, 'APPROVED');
  assert.equal(verdictRes.verdict.score, 9.5);

  const verdictsFile = path.win32.join(mawHome, 'data', 'review', 'verdicts.jsonl');
  assert.ok(fs.existsSync(verdictsFile));
  const verdictLine = fs.readFileSync(verdictsFile, 'utf8');
  assert.ok(verdictLine.includes('"job_id":"job_20261025_010000_123456"'));
  assert.ok(verdictLine.includes('"verdict":"APPROVED"'));

  // 9. GET review_diff with source=commit on root commit
  const commitDiffRes = (await reviewFeature.routes.review_diff.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=review_diff&project_path=${encodeURIComponent(projectDir)}&source=commit&ref=${rootCommitSha}`),
      query: new URLSearchParams({ project_path: projectDir, source: 'commit', ref: rootCommitSha }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(commitDiffRes.ok, true);
  assert.equal(commitDiffRes.source, 'commit');
  assert.ok(commitDiffRes.files.some((f: any) => f.path === 'a.txt'));

  // 10. status() check
  const statusRes = (await reviewFeature.status!(fakeCtx as any)) as any;
  assert.ok(statusRes.verdicts_by_job['job_20261025_010000_123456']);
  assert.equal(statusRes.open_comments, 1);

  // Clean up temp dir
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
});
