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
import { computeReviewKey, loadReviewSession } from './session.ts';

test('diff parser handles modify, add, delete, rename, binary, no-newline, CRLF, and quoted paths', () => {
  // 1. Quoted path unescaping
  assert.equal(unquoteGitPath('a/simple.txt'), 'simple.txt');
  assert.equal(unquoteGitPath('"a/path with spaces/file.txt"'), 'path with spaces/file.txt');
  assert.equal(unquoteGitPath('"a/quote\\"file.txt"'), 'quote"file.txt');
  assert.equal(unquoteGitPath('"a/café file.txt"'), 'café file.txt');
  assert.equal(unquoteGitPath('"a/caf\\303\\251 file.txt"'), 'café file.txt');
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
  assert.equal(untrackedDiff.untracked, true);
  assert.equal(untrackedDiff.status, 'A');

  // Verify rawLines and headerLines are stripped from review_diff response
  assert.equal((fileADiff as any).headerLines, undefined);
  assert.equal((fileADiff.hunks[0] as any).rawLines, undefined);
  assert.ok(fileADiff.hunks[0]!.header);
  assert.equal((untrackedDiff as any).headerLines, undefined);
  assert.equal((untrackedDiff.hunks[0] as any).rawLines, undefined);

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
  assert.equal(rejectRes.state, 'rejected');
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

test('diff parser count-based boundary prevents SQL -- comment and ++x from being parsed as diff headers', () => {
  const diffWithSqlAndPlus =
    'diff --git a/query.sql b/query.sql\n' +
    'index 1111111..2222222 100644\n' +
    '--- a/query.sql\n' +
    '+++ b/query.sql\n' +
    '@@ -1,4 +1,4 @@\n' +
    ' SELECT 1;\n' +
    '--- old sql comment\n' +
    '+++ new sql comment\n' +
    ' SELECT 2;\n';

  const res = parseUnifiedDiff(diffWithSqlAndPlus);
  assert.equal(res.files.length, 1);
  const f = res.files[0]!;
  assert.equal(f.path, 'query.sql');
  assert.equal(f.hunks.length, 1);
  const h = f.hunks[0]!;
  assert.equal(h.old_lines, 4);
  assert.equal(h.new_lines, 4);
  assert.equal(h.lines.length, 4);
  assert.equal(h.lines[1]![0], '-');
  assert.equal(h.lines[1]![1], '-- old sql comment');
  assert.equal(h.lines[2]![0], '+');
  assert.equal(h.lines[2]![1], '++ new sql comment');
});

test('review_hunk rejects last hunk of tracked file when untracked file also exists without 409 stale hunk id', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_lasthunk_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'lasthunk-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Create file with 2 hunks
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`initial line ${i}`);
  }
  fs.writeFileSync(path.win32.join(projectDir, 'code.ts'), lines.join('\n') + '\n', 'utf8');
  await runCommand('git', ['-C', projectDir, 'add', 'code.ts']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Add code.ts']);

  // Modify first and last regions
  lines[0] = 'modified first line 1';
  lines[19] = 'modified last line 20';
  fs.writeFileSync(path.win32.join(projectDir, 'code.ts'), lines.join('\n') + '\n', 'utf8');

  // Add untracked file
  fs.writeFileSync(path.win32.join(projectDir, 'new_untracked.ts'), 'export const u = 1;\n', 'utf8');

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Get diff
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

  assert.equal(diffRes.files.length, 2);
  const codeFile = diffRes.files.find((f: any) => f.path === 'code.ts');
  assert.ok(codeFile);
  assert.equal(codeFile.hunks.length, 2);

  // Reject the LAST hunk (hunk 1)
  const lastHunk = codeFile.hunks[1]!;
  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'code.ts',
        hunk_id: lastHunk.id,
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

  // Verify code.ts has first modified kept and last reverted
  const contentAfter = fs.readFileSync(path.win32.join(projectDir, 'code.ts'), 'utf8');
  assert.ok(contentAfter.includes('modified first line 1'));
  assert.ok(contentAfter.includes('initial line 20'));
  assert.ok(!contentAfter.includes('modified last line 20'));

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review_hunk on CRLF repository with core.autocrlf=false successfully reverts hunk', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_crlf_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'crlf-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);
  await runCommand('git', ['-C', projectDir, 'config', 'core.autocrlf', 'false']);

  // Commit a CRLF file
  const crlfContent = 'row 1\r\nrow 2\r\nrow 3\r\nrow 4\r\nrow 5\r\n';
  fs.writeFileSync(path.win32.join(projectDir, 'crlf.txt'), crlfContent, 'utf8');
  await runCommand('git', ['-C', projectDir, 'add', 'crlf.txt']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Add crlf.txt']);

  // Modify row 3 with CRLF
  const modifiedCrlf = 'row 1\r\nrow 2\r\nrow 3 MODIFIED\r\nrow 4\r\nrow 5\r\n';
  fs.writeFileSync(path.win32.join(projectDir, 'crlf.txt'), modifiedCrlf, 'utf8');

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

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

  assert.equal(diffRes.files.length, 1);
  const crlfFile = diffRes.files[0]!;
  assert.equal(crlfFile.hunks.length, 1);

  const hunkToReject = crlfFile.hunks[0]!;
  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'crlf.txt',
        hunk_id: hunkToReject.id,
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectRes.ok, true);

  // Verify file restored to original CRLF
  const contentAfter = fs.readFileSync(path.win32.join(projectDir, 'crlf.txt'), 'utf8');
  assert.ok(contentAfter.includes('row 3\r\n'));
  assert.ok(!contentAfter.includes('row 3 MODIFIED'));

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review binary reject: untracked binary removed, tracked binary restored without altering real index', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_bin_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'bin-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Tracked binary file (with NUL bytes)
  const trackedBinPath = path.win32.join(projectDir, 'image.png');
  const origBinData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
  fs.writeFileSync(trackedBinPath, origBinData);
  await runCommand('git', ['-C', projectDir, 'add', 'image.png']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Add tracked image.png']);

  // 1. Modify tracked binary file
  const modBinData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x99, 0x88, 0x77]);
  fs.writeFileSync(trackedBinPath, modBinData);

  // 2. Add an untracked binary file
  const untrackedBinPath = path.win32.join(projectDir, 'untracked.bin');
  const untrackedData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  fs.writeFileSync(untrackedBinPath, untrackedData);

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Reject untracked binary file
  const rejectUntrackedRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'untracked.bin',
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectUntrackedRes.ok, true);
  assert.equal(rejectUntrackedRes.state, 'rejected');
  assert.equal(fs.existsSync(untrackedBinPath), false);

  // Index must remain untouched
  const indexAfterUntracked = (await runCommand('git', ['-C', projectDir, 'diff', '--cached'])).stdout;
  assert.equal(indexAfterUntracked, '');

  // Reject tracked binary file
  const rejectTrackedRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'image.png',
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectTrackedRes.ok, true);
  assert.equal(rejectTrackedRes.state, 'rejected');
  // Reverted to origBinData
  const diskData = fs.readFileSync(trackedBinPath);
  assert.deepEqual(diskData, origBinData);

  // Real index must still be untouched
  const indexAfterTracked = (await runCommand('git', ['-C', projectDir, 'diff', '--cached'])).stdout;
  assert.equal(indexAfterTracked, '');

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review: untracked files guards cap at 300, skip >400KB as too_large, and truncate at 5MB', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_guards_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'guards-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Commit an initial file
  fs.writeFileSync(path.win32.join(projectDir, 'init.txt'), 'hello\n');
  await runCommand('git', ['-C', projectDir, 'add', 'init.txt']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Init']);

  // 1. Large untracked file > 400 KB
  const largeUntracked = path.win32.join(projectDir, 'large_untracked.txt');
  fs.writeFileSync(largeUntracked, Buffer.alloc(450 * 1024, 'z'));

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

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

  const largeEntry = diffRes.files.find((f: any) => f.path === 'large_untracked.txt');
  assert.ok(largeEntry);
  assert.equal(largeEntry.too_large, true);
  assert.equal(largeEntry.hunks.length, 0);

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review_hunk: context option and ignore_ws rejection error', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_review_ctx_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'ctx-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Commit file with 15 lines
  const lines: string[] = [];
  for (let i = 1; i <= 15; i++) {
    lines.push(`line ${i}`);
  }
  fs.writeFileSync(path.win32.join(projectDir, 'file.txt'), lines.join('\n') + '\n', 'utf8');
  await runCommand('git', ['-C', projectDir, 'add', 'file.txt']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Init']);

  // Modify line 8
  lines[7] = 'line 8 MODIFIED';
  fs.writeFileSync(path.win32.join(projectDir, 'file.txt'), lines.join('\n') + '\n', 'utf8');

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Diff with context=5
  const diffRes = (await reviewFeature.routes.review_diff.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=review_diff&project_path=${encodeURIComponent(projectDir)}&source=worktree&context=5`),
      query: new URLSearchParams({ project_path: projectDir, source: 'worktree', context: '5' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(diffRes.files.length, 1);
  const hunkCtx5 = diffRes.files[0].hunks[0];
  assert.ok(hunkCtx5);

  // Accept with context=5
  const acceptRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'file.txt',
        hunk_id: hunkCtx5.id,
        context: 5,
        action: 'accept',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(acceptRes.ok, true);
  assert.equal(acceptRes.state, 'accepted');

  // Reset
  const resetRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'file.txt',
        hunk_id: hunkCtx5.id,
        context: 5,
        action: 'reset',
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;
  assert.equal(resetRes.state, null);

  // Reject with context=5
  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'file.txt',
        hunk_id: hunkCtx5.id,
        context: 5,
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.state, 'rejected');

  // Verify file restored
  const restored = fs.readFileSync(path.win32.join(projectDir, 'file.txt'), 'utf8');
  assert.ok(restored.includes('line 8'));
  assert.ok(!restored.includes('line 8 MODIFIED'));

  // Test ignore_ws rejection error when whitespace-only change does not appear in non-ws diff
  // Modify with whitespace only
  fs.writeFileSync(path.win32.join(projectDir, 'file.txt'), restored.replace('line 8', 'line 8   '));

  // Diff with ignore_ws=1 produces no hunks, or if requested hunk id is missing in non-ws diff
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
            path: 'file.txt',
            hunk_id: 'fake_ws_hunk_id',
            ignore_ws: true,
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

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});


test('diff parser: rename a/foo -> a/bar preserves folder named a/', () => {
  const diffText =
    'diff --git a/a/foo b/a/bar\n' +
    'similarity index 100%\n' +
    'rename from a/foo\n' +
    'rename to a/bar\n';
  const res = parseUnifiedDiff(diffText);
  assert.equal(res.files.length, 1);
  const f = res.files[0]!;
  assert.equal(f.old_path, 'a/foo');
  assert.equal(f.path, 'a/bar');
  assert.equal(f.status, 'R');
});

test('diff parser & whole-file reject: pure rename has no hunks, full=1 lifts 400KB byte guard to 4MB', async () => {
  // Test byte guard with full=1
  const line10k = '+' + 'a'.repeat(99) + '\n';
  const rawBigDiff =
    'diff --git a/big.txt b/big.txt\n' +
    'index 1111111..2222222 100644\n' +
    '--- a/big.txt\n' +
    '+++ b/big.txt\n' +
    '@@ -0,0 +1,5000 @@\n' +
    line10k.repeat(5000); // ~500 KB

  // Without full=1: too_large because > 400 KB
  const resNormal = parseUnifiedDiff(rawBigDiff, { full: false });
  assert.equal(resNormal.files[0]!.too_large, true);

  // With full=1 and targetPath matching: lifted to 4 MB
  const resFull = parseUnifiedDiff(rawBigDiff, { full: true, targetPath: 'big.txt' });
  assert.equal(resFull.files[0]!.too_large, false);

  // Test pure rename whole-file reject
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_rename_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({ projectsRoot, mawHome, repoRoot: projectDir });
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  const srcDir = path.win32.join(projectDir, 'a');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.win32.join(srcDir, 'foo.txt'), 'hello world\n', 'utf8');
  await runCommand('git', ['-C', projectDir, 'add', '-A']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'initial']);

  // Pure rename
  await runCommand('git', ['-C', projectDir, 'mv', 'a/foo.txt', 'a/bar.txt']);

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Reject whole file rename
  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        path: 'a/bar.txt',
        hunk_id: null,
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.state, 'rejected');
  assert.ok(fs.existsSync(path.win32.join(srcDir, 'foo.txt')));
  assert.ok(!fs.existsSync(path.win32.join(srcDir, 'bar.txt')));

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review: global 300-file guard across tracked and untracked files', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_300_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({ projectsRoot, mawHome, repoRoot: projectDir });
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Create 2 tracked files
  fs.writeFileSync(path.win32.join(projectDir, 't1.txt'), 'tracked 1\n');
  fs.writeFileSync(path.win32.join(projectDir, 't2.txt'), 'tracked 2\n');
  await runCommand('git', ['-C', projectDir, 'add', '-A']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'initial']);

  // Modify 2 tracked files
  fs.writeFileSync(path.win32.join(projectDir, 't1.txt'), 'tracked 1 modified\n');
  fs.writeFileSync(path.win32.join(projectDir, 't2.txt'), 'tracked 2 modified\n');

  // Create 305 untracked files
  for (let i = 0; i < 305; i++) {
    fs.writeFileSync(path.win32.join(projectDir, `u_${String(i).padStart(3, '0')}.txt`), `untracked ${i}\n`);
  }

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  const diffRun = (await reviewFeature.routes.review_diff.handler(
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

  assert.equal(diffRun.ok, true);
  // Total entries = 2 tracked + 305 untracked = 307
  assert.equal(diffRun.files.length, 307);
  // Tracked files are first 2
  assert.equal(diffRun.files[0].path, 't1.txt');
  assert.equal(diffRun.files[1].path, 't2.txt');
  assert.equal(diffRun.files[0].omitted, false);
  assert.equal(diffRun.files[1].omitted, false);

  // Exactly (300 - 2) = 298 untracked files are diffed (omitted: false)
  const nonOmitted = diffRun.files.filter((f: any) => !f.omitted);
  assert.equal(nonOmitted.length, 300);

  // The remaining 7 untracked files are marked omitted: true
  const omitted = diffRun.files.filter((f: any) => f.omitted);
  assert.equal(omitted.length, 7);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review_diff: git non-zero exit code on non-existent branch throws 400 with git diff failed', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_git_err_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({ projectsRoot, mawHome, repoRoot: projectDir });
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);
  fs.writeFileSync(path.win32.join(projectDir, 'a.txt'), 'initial\n');
  await runCommand('git', ['-C', projectDir, 'add', '-A']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'initial']);

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  await assert.rejects(
    async () => {
      await reviewFeature.routes.review_diff.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL(`http://127.0.0.1/api?action=review_diff&project_path=${encodeURIComponent(projectDir)}&source=branch&ref=non_existent_branch`),
          query: new URLSearchParams({ project_path: projectDir, source: 'branch', ref: 'non_existent_branch' }),
          body: {},
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400 && err.message.includes('git diff failed')
  );

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review_send_fix: 400 long comments budgeted without mid-item truncation, returns included & remaining', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_fix_budget_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({ projectsRoot, mawHome, repoRoot: projectDir });
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);
  fs.writeFileSync(path.win32.join(projectDir, 'a.txt'), 'initial\n');
  await runCommand('git', ['-C', projectDir, 'add', '-A']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'initial']);

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Add 400 comments (each with ~100 chars body)
  for (let i = 0; i < 400; i++) {
    await reviewFeature.routes.review_comment.handler(
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
          line: i + 1,
          side: 'new',
          body: `Detailed review comment number ${i + 1} with explanation: ` + 'y'.repeat(60),
        },
        req: {} as any,
        res: {} as any,
        ctx: fakeCtx,
      }
    );
  }

  const dryRes = (await reviewFeature.routes.review_send_fix.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_send_fix'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        dry_run: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(dryRes.ok, true);
  assert.ok(dryRes.prompt.length <= 20000);
  assert.ok(dryRes.included > 0);
  assert.ok(dryRes.remaining > 0);
  assert.equal(dryRes.included + dryRes.remaining, 400);

  // Now run for real and verify sent_at is marked ONLY on included comments
  const realCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true, job_id: 'job_fix_400' }),
  };

  const sendRes = (await reviewFeature.routes.review_send_fix.handler(
    realCtx as any,
    {
      ...realCtx,
      url: new URL('http://127.0.0.1/api?action=review_send_fix'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'worktree',
        agent: 'claude',
        dry_run: false,
      },
      req: {} as any,
      res: {} as any,
      ctx: realCtx,
    }
  )) as any;

  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.included, dryRes.included);
  assert.equal(sendRes.remaining, dryRes.remaining);
  assert.equal(sendRes.job_id, 'job_fix_400');

  // Verify in session: exactly `sendRes.included` comments have sent_at set
  const session = loadReviewSession(
    computeReviewKey(projectDir, 'worktree', '', ''),
    projectDir,
    'worktree',
    '',
    '',
    paths
  );

  const sentCount = session.comments.filter((c: any) => c.sent_at !== null).length;
  assert.equal(sentCount, sendRes.included);
  const remainingCount = session.comments.filter((c: any) => c.sent_at === null).length;
  assert.equal(remainingCount, sendRes.remaining);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('review binary reject: branch binary uses merge-base and rejects 409 if file changed after diff', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_branch_bin_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'my-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({ projectsRoot, mawHome, repoRoot: projectDir });
  await runCommand('git', ['-C', projectDir, 'init', '-b', 'main']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Initial commit on main with a binary file
  const binFile = path.win32.join(projectDir, 'image.bin');
  fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await runCommand('git', ['-C', projectDir, 'add', '-A']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'initial with binary']);

  // Create branch feature-bin
  await runCommand('git', ['-C', projectDir, 'checkout', '-b', 'feature-bin']);
  // Modify binary file on feature branch
  fs.writeFileSync(binFile, Buffer.from([0x00, 0xaa, 0xbb, 0xcc]));
  await runCommand('git', ['-C', projectDir, 'commit', '-am', 'feature bin update']);

  const fakeCtx = {
    paths,
    registry: { agents: [] } as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // Modify file in worktree after the diff to trigger 409
  fs.writeFileSync(binFile, Buffer.from([0x00, 0x99, 0x99, 0x99]));

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
            source: 'branch',
            ref: 'feature-bin',
            base: 'main',
            path: 'image.bin',
            hunk_id: null,
            action: 'reject',
            confirm: true,
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 409 && err.message.includes('File changed since the diff')
  );

  // Restore file to match the feature-bin branch blob
  fs.writeFileSync(binFile, Buffer.from([0x00, 0xaa, 0xbb, 0xcc]));

  // Now reject binary file: it should restore to merge-base (main branch bytes [0x00, 0x01, 0x02, 0x03])
  const rejectRes = (await reviewFeature.routes.review_hunk.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL('http://127.0.0.1/api?action=review_hunk'),
      query: new URLSearchParams(),
      body: {
        project_path: projectDir,
        source: 'branch',
        ref: 'feature-bin',
        base: 'main',
        path: 'image.bin',
        hunk_id: null,
        action: 'reject',
        confirm: true,
      },
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.state, 'rejected');
  const restoredBytes = fs.readFileSync(binFile);
  assert.deepEqual(restoredBytes, Buffer.from([0x00, 0x01, 0x02, 0x03]));

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
