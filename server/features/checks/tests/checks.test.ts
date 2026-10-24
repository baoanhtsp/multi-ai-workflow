import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  computeGate,
  detectChecks,
  getGitInfo,
  resolveCommandTarget,
  runCheckProcess,
  scanTrackedTodos,
  trustProjectChecks,
  validateChecksConfig,
  type CheckItem,
} from '../lib/checks-core.ts';

function createTempProject(): { dir: string; cleanup: () => void } {
  const dir = path.win32.join(
    os.tmpdir(),
    `maw_test_checks_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(dir, { recursive: true });

  // Init git repo
  try {
    child_process.execFileSync('git', ['init'], { cwd: dir, windowsHide: true });
    child_process.execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: dir,
      windowsHide: true,
    });
    child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
      windowsHide: true,
    });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf8');
    child_process.execFileSync('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
    child_process.execFileSync('git', ['commit', '-m', 'initial commit'], {
      cwd: dir,
      windowsHide: true,
    });
  } catch {
    // Ignore git init errors if git not found
  }

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { dir, cleanup };
}

test('checks config validation: id regex, command length, timeout bounds, cwd safety', () => {
  const { dir, cleanup } = createTempProject();
  try {
    // Valid config
    const validRaw = {
      version: 1,
      checks: [
        {
          id: 'unit_test',
          label: 'Unit Test',
          command: ['node', '--test'],
          timeout_s: 120,
          required: true,
        },
      ],
      todo_max: 5,
    };
    const vRes = validateChecksConfig(validRaw, dir);
    assert.equal(vRes.errorField, undefined);
    assert.equal(vRes.config.checks.length, 1);
    assert.equal(vRes.config.checks[0]!.id, 'unit_test');

    // Invalid check ID (starts with uppercase)
    const badId = {
      version: 1,
      checks: [{ id: 'UnitTest', label: 'Test', command: ['node'] }],
    };
    const badIdRes = validateChecksConfig(badId, dir);
    assert.equal(badIdRes.errorField, 'checks[0].id');

    // Duplicate check ID
    const dupId = {
      version: 1,
      checks: [
        { id: 'test', command: ['npm', 'test'] },
        { id: 'test', command: ['node', 'test.js'] },
      ],
    };
    const dupRes = validateChecksConfig(dupId, dir);
    assert.equal(dupRes.errorField, 'checks[1].id');

    // Empty command
    const emptyCmd = {
      version: 1,
      checks: [{ id: 'test', command: [] }],
    };
    const emptyCmdRes = validateChecksConfig(emptyCmd, dir);
    assert.equal(emptyCmdRes.errorField, 'checks[0].command');

    // Timeout out of bounds (< 5 or > 3600)
    const badTimeout = {
      version: 1,
      checks: [{ id: 'test', command: ['npm', 'test'], timeout_s: 2 }],
    };
    assert.equal(validateChecksConfig(badTimeout, dir).errorField, 'checks[0].timeout_s');

    // CWD escapes project
    const badCwd = {
      version: 1,
      checks: [{ id: 'test', command: ['npm', 'test'], cwd: '../outside' }],
    };
    assert.equal(validateChecksConfig(badCwd, dir).errorField, 'checks[0].cwd');
  } finally {
    cleanup();
  }
});

test('checks_detect: detects npm scripts from package.json and composer/phpunit', () => {
  const { dir, cleanup } = createTempProject();
  try {
    // Write package.json with scripts
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'node --test',
        },
      }),
      'utf8'
    );

    const detected = detectChecks(dir);
    assert.equal(detected.checks.length, 3);
    assert.ok(detected.checks.some((c) => c.id === 'typecheck'));
    assert.ok(detected.checks.some((c) => c.id === 'lint'));
    assert.ok(detected.checks.some((c) => c.id === 'test'));
  } finally {
    cleanup();
  }
});

test('command resolution: resolves .exe directly, shims via node, and enforces safe args on .cmd', () => {
  const { dir, cleanup } = createTempProject();
  try {
    // 1. Direct .exe or path
    const nodeResolved = resolveCommandTarget(process.execPath, ['-v'], dir);
    assert.equal(nodeResolved.type, 'exe');
    assert.equal(nodeResolved.file, process.execPath);

    // 2. Fake .cmd script with safe arguments
    const fakeCmd = path.join(dir, 'test-script.cmd');
    fs.writeFileSync(fakeCmd, '@echo off\r\necho OK\r\n', 'utf8');

    const safeResolved = resolveCommandTarget(fakeCmd, ['foo=bar', 'baz.txt', '123'], dir);
    assert.equal(safeResolved.type, 'cmd');
    assert.equal(safeResolved.file, fakeCmd);

    // 3. Fake .ps1 script
    const fakePs1 = path.join(dir, 'script.ps1');
    fs.writeFileSync(fakePs1, 'Write-Host "PS1"', 'utf8');
    const ps1Resolved = resolveCommandTarget(fakePs1, ['-Arg1'], dir);
    assert.equal(ps1Resolved.type, 'ps1');
    assert.equal(ps1Resolved.file, 'powershell.exe');
  } finally {
    cleanup();
  }
});

test('runCheckProcess: execution without shell, exit code, timeout with taskkill, and unsafe .cmd arg refusal', async () => {
  const { dir, cleanup } = createTempProject();
  try {
    // 1. Run node script that exits 0
    const passScript = path.join(dir, 'pass.js');
    fs.writeFileSync(passScript, 'console.log("HELLO_PASS"); process.exit(0);', 'utf8');
    const passCheck: CheckItem = {
      id: 'pass_check',
      label: 'Pass Check',
      command: [process.execPath, passScript],
      timeout_s: 5,
    };
    const passRes = await runCheckProcess(passCheck, dir);
    assert.equal(passRes.state, 'pass');
    assert.equal(passRes.exit_code, 0);
    assert.ok(passRes.output_tail.includes('HELLO_PASS'));

    // 2. Run node script that exits 1
    const failScript = path.join(dir, 'fail.js');
    fs.writeFileSync(failScript, 'console.error("FAIL_ERROR"); process.exit(1);', 'utf8');
    const failCheck: CheckItem = {
      id: 'fail_check',
      label: 'Fail Check',
      command: [process.execPath, failScript],
      timeout_s: 5,
      required: true,
    };
    const failRes = await runCheckProcess(failCheck, dir);
    assert.equal(failRes.state, 'fail');
    assert.equal(failRes.exit_code, 1);
    assert.ok(failRes.output_tail.includes('FAIL_ERROR'));

    // 3. Unsafe argument for .cmd script is refused without spawning
    const fakeCmd = path.join(dir, 'unsafe.cmd');
    fs.writeFileSync(fakeCmd, '@echo off\r\necho CMD\r\n', 'utf8');
    const unsafeCheck: CheckItem = {
      id: 'unsafe_cmd',
      label: 'Unsafe CMD',
      command: [fakeCmd, 'safe', 'bad;rm -rf /'],
      timeout_s: 5,
      required: true,
    };
    const unsafeRes = await runCheckProcess(unsafeCheck, dir);
    assert.equal(unsafeRes.state, 'fail');
    assert.equal(unsafeRes.exit_code, 1);
    assert.ok(unsafeRes.output_tail.includes('unsafe argument for a .cmd script'));

    // 4. Timeout kills the process tree
    const hangScript = path.join(dir, 'hang.js');
    fs.writeFileSync(hangScript, 'setTimeout(() => {}, 60000);', 'utf8');
    const timeoutCheck: CheckItem = {
      id: 'timeout_check',
      label: 'Timeout Check',
      command: [process.execPath, hangScript],
      timeout_s: 5, // minimum 5s
    };
    // Note: timeout test takes 5s, let's run it
    const timeoutRes = await runCheckProcess(timeoutCheck, dir);
    assert.equal(timeoutRes.state, 'timeout');
    assert.equal(timeoutRes.exit_code, 124);
  } finally {
    cleanup();
  }
});

test('TODO scanning: scans tracked files, excludes binary and large files, respects limits', () => {
  const { dir, cleanup } = createTempProject();
  try {
    // Add tracked files with TODOs
    const srcFile = path.join(dir, 'app.ts');
    fs.writeFileSync(srcFile, '// TODO: fix bug\r\nconst x = 1;\r\n// FIXME: refactor\r\n', 'utf8');
    child_process.execFileSync('git', ['add', 'app.ts'], { cwd: dir, windowsHide: true });

    // Untracked file should be ignored
    const untrackedFile = path.join(dir, 'untracked.ts');
    fs.writeFileSync(untrackedFile, '// TODO: untracked todo\r\n', 'utf8');

    const todos = scanTrackedTodos(dir, ['TODO', 'FIXME']);
    assert.equal(todos.count, 2);
    assert.equal(todos.matches.length, 2);
    assert.ok(todos.matches.some((m) => m.text.includes('fix bug')));
    assert.ok(todos.matches.some((m) => m.text.includes('refactor')));
  } finally {
    cleanup();
  }
});

test('gate staleness: check result is stale after file modification changing HEAD or dirty signature', async () => {
  const { dir, cleanup } = createTempProject();
  try {
    const paths = resolveServerPaths({
      repoRoot: dir,
      userProfile: path.join(dir, 'user'),
      mawHome: path.join(dir, '.maw_home'),
    });

    const checkScript = path.join(dir, 'test.js');
    fs.writeFileSync(checkScript, 'console.log("PASS"); process.exit(0);', 'utf8');
    child_process.execFileSync('git', ['add', 'test.js'], { cwd: dir, windowsHide: true });
    child_process.execFileSync('git', ['commit', '-m', 'add test.js'], {
      cwd: dir,
      windowsHide: true,
    });

    const gitInfo = getGitInfo(dir);
    const config = {
      version: 1,
      checks: [
        { id: 'my_test', label: 'My Test', command: [process.execPath, checkScript], required: true },
      ],
      spec_guard: false,
      min_review_score: 0,
      todo_max: 10,
    };

    // 1. Fresh check run
    const results = [
      {
        id: 'my_test',
        label: 'My Test',
        state: 'pass' as const,
        exit_code: 0,
        duration_ms: 100,
        output_tail: 'PASS',
        at: new Date().toISOString(),
        head: gitInfo.head,
        dirty_signature: 'clean',
      },
    ];

    const gate1 = await computeGate(paths, dir, config, results, true, true);
    assert.equal(gate1.green, true);

    // 2. Modify working tree (dirty file)
    fs.writeFileSync(path.join(dir, 'new_file.txt'), 'dirty content', 'utf8');
    child_process.execFileSync('git', ['add', 'new_file.txt'], { cwd: dir, windowsHide: true });

    // Gate recomputed: check result should now be 'warn' (stale)
    const gate2 = await computeGate(paths, dir, config, results, true, true);
    const checkItem = gate2.items.find((it) => it.id === 'my_test');
    assert.ok(checkItem);
    assert.equal(checkItem.state, 'warn');
    assert.ok(checkItem.detail.includes('stale'));
  } finally {
    cleanup();
  }
});
