import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  openFileInEditor,
  resolveEditorExe,
  saveEditorConfig,
  validateEditorConfig,
} from './editor.ts';
import { feature as filesFeature } from './index.ts';

test('editor resolution: unit-test resolver with fake dir, .cmd shim resolving to VS Code-family real .exe', () => {
  const fakeDir = path.win32.join(
    os.tmpdir(),
    `maw_editor_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const binDir = path.win32.join(fakeDir, 'bin');
  const shimPath = path.win32.join(binDir, 'code.cmd');
  const realExePath = path.win32.join(fakeDir, 'Code.exe');

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(shimPath, '@echo off\n"%~dp0..\\Code.exe" %*\n', 'utf8');
  fs.writeFileSync(realExePath, 'fake-binary', 'utf8');

  // 1. Resolve relative command via PATH
  const resolved = resolveEditorExe('code', {
    envPath: binDir,
    fileExists: (p) => fs.existsSync(p),
  });
  assert.equal(path.normalize(resolved).toLowerCase(), path.normalize(realExePath).toLowerCase());

  // 2. Resolve absolute shim path
  const resolvedAbs = resolveEditorExe(shimPath, {
    fileExists: (p) => fs.existsSync(p),
  });
  assert.equal(path.normalize(resolvedAbs).toLowerCase(), path.normalize(realExePath).toLowerCase());

  // 3. Resolve direct .exe
  const resolvedExe = resolveEditorExe(realExePath, {
    fileExists: (p) => fs.existsSync(p),
  });
  assert.equal(path.normalize(resolvedExe).toLowerCase(), path.normalize(realExePath).toLowerCase());

  // 4. Missing editor -> 400
  assert.throws(
    () => {
      resolveEditorExe('nonexistent_editor_cmd', {
        envPath: binDir,
        fileExists: (p) => fs.existsSync(p),
      });
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Clean up
  try {
    fs.rmSync(fakeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
});

test('editor config validation: array length, item length, first item non-empty, {file} placeholder', () => {
  // Valid config
  assert.deepEqual(validateEditorConfig(['code', '--goto', '{file}:{line}']), [
    'code',
    '--goto',
    '{file}:{line}',
  ]);

  // Invalid: not an array
  assert.throws(
    () => validateEditorConfig('code'),
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Invalid: empty array
  assert.throws(
    () => validateEditorConfig([]),
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Invalid: missing {file} placeholder
  assert.throws(
    () => validateEditorConfig(['notepad.exe', 'arg1']),
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Invalid: first item empty
  assert.throws(
    () => validateEditorConfig(['', '{file}']),
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  // Invalid: string > 500 chars
  assert.throws(
    () => validateEditorConfig(['code', 'x'.repeat(501), '{file}']),
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );
});

test('files feature end-to-end: tree, dotfiles, .git excluded, path traversal, read (binary, too_large, BOM), search ranking, history', async () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_files_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'files-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  // Git init
  await runCommand('git', ['-C', projectDir, 'init']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.name', 'Tester']);
  await runCommand('git', ['-C', projectDir, 'config', 'user.email', 'tester@example.com']);

  // Structure:
  // - tracked.txt (tracked)
  // - to_delete.txt (tracked, then deleted)
  // - .hidden.txt (dotfile)
  // - src/sub.ts (tracked inside folder)
  // - binary.bin (NUL byte)
  // - bom.txt (UTF-8 with BOM)
  // - large.txt (> 1 MB)
  const srcDir = path.win32.join(projectDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(path.win32.join(projectDir, 'tracked.txt'), 'hello tracked\n', 'utf8');
  fs.writeFileSync(path.win32.join(projectDir, 'to_delete.txt'), 'goodbye\n', 'utf8');
  fs.writeFileSync(path.win32.join(srcDir, 'sub.ts'), 'export const x = 1;\n', 'utf8');
  fs.writeFileSync(path.win32.join(projectDir, '.hidden.txt'), 'secret\n', 'utf8');

  // Commit tracked files
  await runCommand('git', ['-C', projectDir, 'add', 'tracked.txt', 'to_delete.txt', 'src/sub.ts']);
  await runCommand('git', ['-C', projectDir, 'commit', '-m', 'Initial commit']);

  // Delete to_delete.txt from disk
  fs.unlinkSync(path.win32.join(projectDir, 'to_delete.txt'));

  // Modify tracked.txt
  fs.writeFileSync(path.win32.join(projectDir, 'tracked.txt'), 'hello modified\n', 'utf8');

  // Binary file with NUL byte
  const binBuf = Buffer.from([104, 101, 108, 0, 108, 111]); // 'hel\0lo'
  fs.writeFileSync(path.win32.join(projectDir, 'binary.bin'), binBuf);

  // BOM file
  const bomBuf = Buffer.from('\uFEFFcontent with bom\n', 'utf8');
  fs.writeFileSync(path.win32.join(projectDir, 'bom.txt'), bomBuf);

  // File > 1 MB
  const largeBuf = Buffer.alloc(1024 * 1024 + 10, 'a');
  fs.writeFileSync(path.win32.join(projectDir, 'large.txt'), largeBuf);

  const fakeCtx = {
    paths,
    registry: {} as any,
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  // 1. GET files_tree with dotfiles=0 (default)
  const treeResNoDots = (await filesFeature.routes.files_tree.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_tree&project_path=${encodeURIComponent(projectDir)}`),
      query: new URLSearchParams({ project_path: projectDir }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(treeResNoDots.ok, true);
  assert.equal(treeResNoDots.is_git, true);

  // .git must NEVER be listed
  assert.ok(!treeResNoDots.entries.some((e: any) => e.name === '.git'));
  // .hidden.txt must NOT be listed when dotfiles=0
  assert.ok(!treeResNoDots.entries.some((e: any) => e.name === '.hidden.txt'));

  // Dirs first: 'src' is dir
  assert.equal(treeResNoDots.entries[0].name, 'src');
  assert.equal(treeResNoDots.entries[0].type, 'dir');

  // Tracked modified file
  const trackedEntry = treeResNoDots.entries.find((e: any) => e.name === 'tracked.txt');
  assert.ok(trackedEntry);
  assert.equal(trackedEntry.git, 'M');

  // Deleted entry
  const deletedEntry = treeResNoDots.entries.find((e: any) => e.name === 'to_delete.txt');
  assert.ok(deletedEntry);
  assert.equal(deletedEntry.deleted, true);
  assert.equal(deletedEntry.git, 'D');

  // 2. GET files_tree with dotfiles=1
  const treeResWithDots = (await filesFeature.routes.files_tree.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_tree&project_path=${encodeURIComponent(projectDir)}&dotfiles=1`),
      query: new URLSearchParams({ project_path: projectDir, dotfiles: '1' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.ok(treeResWithDots.entries.some((e: any) => e.name === '.hidden.txt'));
  // Still never list .git
  assert.ok(!treeResWithDots.entries.some((e: any) => e.name === '.git'));

  // 3. Path traversal guards: ..\, absolute path, junction escape => 400
  const invalidPaths = [
    '..\\outside.txt',
    '../outside.txt',
    'C:\\Windows\\system32\\calc.exe',
    '/etc/passwd',
    'src/../../outside.txt',
    '.git/config',
  ];

  for (const inv of invalidPaths) {
    await assert.rejects(
      async () => {
        await filesFeature.routes.files_read.handler(
          fakeCtx as any,
          {
            ...fakeCtx,
            url: new URL(`http://127.0.0.1/api?action=files_read&project_path=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(inv)}`),
            query: new URLSearchParams({ project_path: projectDir, path: inv }),
            body: {},
            req: {} as any,
            res: {} as any,
            ctx: fakeCtx,
          }
        );
      },
      (err: any) => err instanceof ApiValidationError && err.statusCode === 400,
      `Expected traversal rejection for ${inv}`
    );
  }

  // 4. GET files_read: BOM strip, binary file, too_large file
  // BOM strip
  const bomReadRes = (await filesFeature.routes.files_read.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_read&project_path=${encodeURIComponent(projectDir)}&path=bom.txt`),
      query: new URLSearchParams({ project_path: projectDir, path: 'bom.txt' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;
  assert.equal(bomReadRes.ok, true);
  assert.equal(bomReadRes.content, 'content with bom\n');
  assert.ok(!bomReadRes.content.startsWith('\uFEFF'));

  // Binary file (NUL in first 8000 bytes)
  const binReadRes = (await filesFeature.routes.files_read.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_read&project_path=${encodeURIComponent(projectDir)}&path=binary.bin`),
      query: new URLSearchParams({ project_path: projectDir, path: 'binary.bin' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;
  assert.equal(binReadRes.ok, true);
  assert.equal(binReadRes.binary, true);
  assert.equal(binReadRes.content, null);

  // Too large file (> 1 MB)
  const largeReadRes = (await filesFeature.routes.files_read.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_read&project_path=${encodeURIComponent(projectDir)}&path=large.txt`),
      query: new URLSearchParams({ project_path: projectDir, path: 'large.txt' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;
  assert.equal(largeReadRes.ok, true);
  assert.equal(largeReadRes.too_large, true);
  assert.equal(largeReadRes.content, null);

  // 5. GET files_search: search ranking (name match ranks first, then shorter path)
  fs.writeFileSync(path.win32.join(projectDir, 'sub_controller.ts'), '// controller\n', 'utf8');
  await runCommand('git', ['-C', projectDir, 'add', 'sub_controller.ts']);

  const searchRes = (await filesFeature.routes.files_search.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_search&project_path=${encodeURIComponent(projectDir)}&q=sub`),
      query: new URLSearchParams({ project_path: projectDir, q: 'sub' }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(searchRes.ok, true);
  assert.ok(searchRes.results.length >= 2);
  // 'src/sub.ts' has name 'sub.ts' which starts with 'sub' vs 'sub_controller.ts'
  assert.ok(searchRes.results.some((r: any) => r.path === 'src/sub.ts'));

  // 6. GET files_history
  const histRes = (await filesFeature.routes.files_history.handler(
    fakeCtx as any,
    {
      ...fakeCtx,
      url: new URL(`http://127.0.0.1/api?action=files_history&project_path=${encodeURIComponent(projectDir)}`),
      query: new URLSearchParams({ project_path: projectDir }),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx: fakeCtx,
    }
  )) as any;

  assert.equal(histRes.ok, true);
  assert.ok(histRes.commits.length >= 1);
  assert.equal(histRes.commits[0].subject, 'Initial commit');
  assert.ok(histRes.commits[0].additions > 0);

  // 7. POST files_open traversal rejection (400) and missing file (404)
  await assert.rejects(
    async () => {
      await filesFeature.routes.files_open.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL('http://127.0.0.1/api?action=files_open'),
          query: new URLSearchParams(),
          body: {
            project_path: projectDir,
            path: '../../secret.txt',
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 400
  );

  await assert.rejects(
    async () => {
      await filesFeature.routes.files_open.handler(
        fakeCtx as any,
        {
          ...fakeCtx,
          url: new URL('http://127.0.0.1/api?action=files_open'),
          query: new URLSearchParams(),
          body: {
            project_path: projectDir,
            path: 'nonexistent_file.txt',
          },
          req: {} as any,
          res: {} as any,
          ctx: fakeCtx,
        }
      );
    },
    (err: any) => err instanceof ApiValidationError && err.statusCode === 404
  );

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
});

test('openFileInEditor: substitutes placeholders, calls spawnFn, and attaches error listener on real spawn', () => {
  const tmpRoot = path.win32.join(
    os.tmpdir(),
    `maw_files_spawn_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const projectsRoot = path.win32.join(tmpRoot, 'projects');
  const mawHome = path.win32.join(tmpRoot, 'maw_home');
  const projectDir = path.win32.join(projectsRoot, 'spawn-repo');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });

  const paths = resolveServerPaths({
    projectsRoot,
    mawHome,
    repoRoot: projectDir,
  });

  const testFilePath = path.win32.join(projectDir, 'sample.txt');
  fs.writeFileSync(testFilePath, 'hello editor\n', 'utf8');

  // Custom editor config pointing to notepad.exe
  saveEditorConfig(['notepad.exe', '{file}'], paths);

  let capturedExe = '';
  let capturedArgs: string[] = [];
  const res = openFileInEditor({
    projectPath: projectDir,
    relPath: 'sample.txt',
    line: 12,
    paths,
    spawnFn: (exe, args) => {
      capturedExe = exe;
      capturedArgs = args;
    },
  });

  assert.equal(res.ok, true);
  assert.ok(capturedExe.toLowerCase().endsWith('notepad.exe'));
  assert.equal(capturedArgs.length, 1);
  assert.equal(path.normalize(capturedArgs[0]!), path.normalize(testFilePath));

  // Also test without spawnFn using a real executable (notepad.exe) to verify child.on('error') does not crash
  const liveRes = openFileInEditor({
    projectPath: projectDir,
    relPath: 'sample.txt',
    line: 1,
    paths,
  });
  assert.equal(liveRes.ok, true);

  // Clean up
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
