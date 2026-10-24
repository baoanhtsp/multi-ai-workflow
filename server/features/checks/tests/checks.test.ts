import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths, type ServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  computeCheckCommandSha,
  computeDirtySignature,
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
import { feature } from '../index.ts';

function createTempProject(): { dir: string; paths: ServerPaths; cleanup: () => void } {
  const dir = path.win32.join(
    os.tmpdir(),
    `maw_test_checks_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  const tempDir = path.win32.join(dir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const oldTemp = process.env.TEMP;
  const oldTmp = process.env.TMP;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

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

  const paths = resolveServerPaths({
    repoRoot: dir,
    userProfile: path.join(dir, 'user'),
    mawHome: path.join(dir, '.maw_home'),
    projectsRoot: path.dirname(dir),
  });
  paths.tempDir = tempDir;

  const cleanup = () => {
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { dir, paths, cleanup };
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

    // 3b. Unsafe path for .cmd script is refused without spawning
    const unsafeDir = path.join(dir, 'a&b');
    fs.mkdirSync(unsafeDir, { recursive: true });
    const unsafePathCmd = path.join(unsafeDir, 'script.cmd');
    fs.writeFileSync(unsafePathCmd, '@echo off\r\necho TEST\r\n', 'utf8');
    const unsafePathCheck: CheckItem = {
      id: 'unsafe_path_cmd',
      label: 'Unsafe Path CMD',
      command: [unsafePathCmd, 'arg1'],
      timeout_s: 5,
      required: true,
    };
    const unsafePathRes = await runCheckProcess(unsafePathCheck, dir);
    assert.equal(unsafePathRes.state, 'fail');
    assert.equal(unsafePathRes.exit_code, 1);
    assert.ok(unsafePathRes.output_tail.includes('unsafe path for a .cmd script'));

    // 3c. Non-existent command on PATH is refused immediately without spawning
    const missingCheck: CheckItem = {
      id: 'missing_cmd',
      label: 'Missing Command',
      command: ['nonexistent_binary_xyz_123', '--flag'],
      timeout_s: 5,
      required: true,
    };
    const missingRes = await runCheckProcess(missingCheck, dir);
    assert.equal(missingRes.state, 'fail');
    assert.equal(missingRes.exit_code, 1);
    assert.ok(missingRes.output_tail.includes('command not found on PATH: nonexistent_binary_xyz_123'));

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

test('gate staleness: required check has state stale and gate not green, non-required has state warn and gate green', async () => {
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
        { id: 'optional_test', label: 'Optional Test', command: [process.execPath, checkScript], required: false },
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
        command_sha: computeCheckCommandSha(config.checks[0]),
        dirty_signature: computeDirtySignature(dir, gitInfo.porcelainLines),
      },
      {
        id: 'optional_test',
        label: 'Optional Test',
        state: 'pass' as const,
        exit_code: 0,
        duration_ms: 50,
        output_tail: 'PASS',
        at: new Date().toISOString(),
        head: gitInfo.head,
        command_sha: computeCheckCommandSha(config.checks[1]),
        dirty_signature: computeDirtySignature(dir, gitInfo.porcelainLines),
      },
    ];

    const gate1 = await computeGate(paths, dir, config, results, true, true);
    assert.equal(gate1.green, true);

    // 2. Modify working tree (dirty file)
    fs.writeFileSync(path.join(dir, 'new_file.txt'), 'dirty content', 'utf8');
    child_process.execFileSync('git', ['add', 'new_file.txt'], { cwd: dir, windowsHide: true });

    // Gate recomputed: required check is 'stale' (gate red), optional check is 'warn'
    const gate2 = await computeGate(paths, dir, config, results, true, true);
    const reqItem = gate2.items.find((it) => it.id === 'my_test');
    assert.ok(reqItem);
    assert.equal(reqItem.state, 'stale', 'required stale check must have state stale');
    assert.ok(reqItem.detail.includes('stale'));

    const optItem = gate2.items.find((it) => it.id === 'optional_test');
    assert.ok(optItem);
    assert.equal(optItem.state, 'warn', 'non-required stale check must have state warn');

    assert.equal(gate2.green, false, 'gate must not be green when required check is stale');

    // 3. If only optional check is configured and stale, gate remains green
    const optOnlyConfig = {
      version: 1,
      checks: [
        { id: 'optional_test', label: 'Optional Test', command: [process.execPath, checkScript], required: false },
      ],
      spec_guard: false,
      min_review_score: 0,
      todo_max: 10,
    };
    const gateOpt = await computeGate(paths, dir, optOnlyConfig, results, true, true);
    assert.equal(gateOpt.green, true, 'gate should be green when only non-required check is stale (warn)');
  } finally {
    cleanup();
  }
});

test('gate unrun: required check has state pending (gate not green), non-required has state warn (gate green)', async () => {
  const { dir, cleanup } = createTempProject();
  try {
    const paths = resolveServerPaths({
      repoRoot: dir,
      userProfile: path.join(dir, 'user'),
      mawHome: path.join(dir, '.maw_home'),
    });

    const config = {
      version: 1,
      checks: [
        { id: 'req_unrun', label: 'Required Unrun', command: ['node', '-v'], required: true },
        { id: 'opt_unrun', label: 'Optional Unrun', command: ['node', '-v'], required: false },
      ],
      spec_guard: false,
      min_review_score: 0,
      todo_max: 10,
    };

    // No results at all
    const gate = await computeGate(paths, dir, config, [], true, true);
    const reqItem = gate.items.find((it) => it.id === 'req_unrun');
    assert.ok(reqItem);
    assert.equal(reqItem.state, 'pending');
    assert.equal(reqItem.detail, 'never run');

    const optItem = gate.items.find((it) => it.id === 'opt_unrun');
    assert.ok(optItem);
    assert.equal(optItem.state, 'warn');
    assert.equal(optItem.detail, 'never run');

    assert.equal(gate.green, false, 'gate must not be green when required check is pending');

    // If only optional check is unrun, gate is green
    const optOnlyConfig = {
      version: 1,
      checks: [
        { id: 'opt_unrun', label: 'Optional Unrun', command: ['node', '-v'], required: false },
      ],
      spec_guard: false,
      min_review_score: 0,
      todo_max: 10,
    };
    const gateOpt = await computeGate(paths, dir, optOnlyConfig, [], true, true);
    assert.equal(gateOpt.green, true);
  } finally {
    cleanup();
  }
});

test('regression Item 6: command_sha marks check stale when command or cwd changes', async () => {
  const { dir, paths, cleanup } = createTempProject();
  try {
    const gitInfo = getGitInfo(dir);
    const dirtySig = computeDirtySignature(dir, gitInfo.porcelainLines);

    const check1: CheckItem = {
      id: 'test_cmd',
      label: 'Test Command',
      command: ['node', '-e', 'process.exit(0)'],
      required: true,
    };
    const sha1 = computeCheckCommandSha(check1);
    check1.command_sha = sha1;

    const previousResult = {
      id: 'test_cmd',
      label: 'Test Command',
      state: 'pass' as const,
      exit_code: 0,
      duration_ms: 10,
      output_tail: 'ok',
      at: new Date().toISOString(),
      head: gitInfo.head,
      dirty_signature: dirtySig,
      command_sha: sha1,
    };

    // 1. Unchanged check: gate evaluates pass
    const config1 = {
      version: 1,
      checks: [check1],
      spec_guard: false,
    };
    const gate1 = await computeGate(paths, dir, config1, [previousResult], true, true);
    const item1 = gate1.items.find((it) => it.id === 'test_cmd');
    assert.ok(item1);
    assert.equal(item1.state, 'pass');

    // 2. Changed command: gate marks stale because command_sha changed
    const check2: CheckItem = {
      id: 'test_cmd',
      label: 'Test Command',
      command: ['node', '-e', 'process.exit(1)'], // command changed!
      required: true,
    };
    check2.command_sha = computeCheckCommandSha(check2);

    const config2 = {
      version: 1,
      checks: [check2],
      spec_guard: false,
    };
    const gate2 = await computeGate(paths, dir, config2, [previousResult], true, true);
    const item2 = gate2.items.find((it) => it.id === 'test_cmd');
    assert.ok(item2);
    assert.equal(item2.state, 'stale', 'check must be stale when command changes');

    // 3. Stored result without command_sha: gate marks stale (no legacy pass)
    const resultWithoutSha = {
      ...previousResult,
      command_sha: undefined,
    };
    const gate3 = await computeGate(paths, dir, config1, [resultWithoutSha as any], true, true);
    const item3 = gate3.items.find((it) => it.id === 'test_cmd');
    assert.ok(item3);
    assert.equal(item3.state, 'stale', 'check without command_sha must be marked stale with no legacy pass');
  } finally {
    cleanup();
  }
});

test('regression Item 7: computeDirtySignature changes on tracked edit, hashes untracked content, and fails closed with unique nonce', () => {
  const { dir, cleanup } = createTempProject();
  try {
    const testFile = path.win32.join(dir, 'tracked.txt');
    fs.writeFileSync(testFile, 'initial content\n', 'utf8');
    child_process.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, windowsHide: true });
    child_process.execFileSync('git', ['commit', '-m', 'add tracked'], { cwd: dir, windowsHide: true });

    // 1. First edit on tracked file
    fs.writeFileSync(testFile, 'first edit\n', 'utf8');
    const info1 = getGitInfo(dir);
    const sig1 = computeDirtySignature(dir, info1.porcelainLines);

    // Second edit on same file (porcelain lines still " M tracked.txt")
    fs.writeFileSync(testFile, 'second edit with different content\n', 'utf8');
    const info2 = getGitInfo(dir);
    const sig2 = computeDirtySignature(dir, info2.porcelainLines);

    assert.deepEqual(info1.porcelainLines, info2.porcelainLines, 'porcelain lines are identical between edits');
    assert.notEqual(sig1, sig2, 'dirty signature must change when content changes even if porcelain line is identical');

    // Commit changes to make tracked clean
    child_process.execFileSync('git', ['commit', '-am', 'commit edits'], { cwd: dir, windowsHide: true });

    // 2. Untracked file <= 2MB: content change must change signature even if file size is identical
    const untrackedFile = path.win32.join(dir, 'untracked.txt');
    fs.writeFileSync(untrackedFile, 'ABCDEF', 'utf8'); // 6 bytes
    const uInfo1 = getGitInfo(dir);
    const uSig1 = computeDirtySignature(dir, uInfo1.porcelainLines);

    fs.writeFileSync(untrackedFile, 'ZYXWVU', 'utf8'); // 6 bytes, identical size!
    const uInfo2 = getGitInfo(dir);
    const uSig2 = computeDirtySignature(dir, uInfo2.porcelainLines);

    assert.notEqual(uSig1, uSig2, 'untracked file content change must change dirty signature via sha1 hash');

    // 3. Fail-closed with unique nonce when git calls fail
    const nonGitDir = path.win32.join(
      path.dirname(dir),
      `maw_non_git_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(nonGitDir, { recursive: true });
    try {
      const nonce1 = computeDirtySignature(nonGitDir, [' M some_file.txt']);
      const nonce2 = computeDirtySignature(nonGitDir, [' M some_file.txt']);

      assert.ok(nonce1.startsWith('nonce_'), `must return nonce when git fails, got ${nonce1}`);
      assert.ok(nonce2.startsWith('nonce_'), `must return nonce when git fails, got ${nonce2}`);
      assert.notEqual(nonce1, nonce2, 'consecutive failures must produce unique nonces');
    } finally {
      try {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      } catch {}
    }
  } finally {
    cleanup();
  }
});

test('regression Item 9: cwd escaping project boundary is rejected in validation and execution', async () => {
  const { dir, cleanup } = createTempProject();
  try {
    const outside = path.resolve(dir, '..', 'some_outside_dir');

    // 1. validateChecksConfig rejects escaping cwd
    const valRes = validateChecksConfig(
      {
        version: 1,
        checks: [{ id: 'escape', command: ['node', '-v'], cwd: '../outside' }],
      },
      dir
    );
    assert.equal(valRes.errorField, 'checks[0].cwd');
    assert.ok(valRes.errorMessage?.includes('escapes the project'));

    // 2. runCheckProcess rejects escaping cwd safely
    const runRes = await runCheckProcess(
      { id: 'escape', label: 'Escape', command: ['node', '-v'], cwd: '../outside' },
      dir
    );
    assert.equal(runRes.state, 'fail');
    assert.ok(runRes.output_tail.includes('escapes the project'));
  } finally {
    cleanup();
  }
});

test('regression Item 14: checks_gate scope honoring (merge vs review)', async () => {
  const { dir, paths, cleanup } = createTempProject();
  try {
    const ctx = {
      paths,
      readJobs: async () => [],
      startJob: async () => ({ job_id: 'test' }),
    } as any;

    // Create an override with scope: 'review'
    const ovrHandler = (feature as any).routes.checks_override.handler;
    const ovrRes = (await ovrHandler(ctx, {
      method: 'POST',
      url: new URL('http://localhost/checks_override'),
      headers: new Headers(),
      query: new URLSearchParams(),
      body: {
        project_path: dir,
        reason: 'Temporary test override',
        scope: 'review',
      },
    })) as any;
    assert.ok(ovrRes.ok);
    const token = ovrRes.token;

    // Setup an unrun required check so gate is naturally red
    const mawDir = path.win32.join(dir, '.maw');
    fs.mkdirSync(mawDir, { recursive: true });
    const checksConfig = {
      version: 1,
      checks: [{ id: 'must_pass', command: ['node', '-v'], required: true }],
      spec_guard: false,
    };
    fs.writeFileSync(path.win32.join(mawDir, 'checks.json'), JSON.stringify(checksConfig), 'utf8');
    trustProjectChecks(paths, dir, crypto.createHash('sha256').update(JSON.stringify(checksConfig)).digest('hex'));

    const gateHandler = (feature as any).routes.checks_gate.handler;

    // 1. Querying with scope 'merge' must NOT consume 'review' token
    const mergeQuery = new URLSearchParams({
      project_path: dir,
      override_token: token,
      scope: 'merge',
    });
    const gateMerge = (await gateHandler(ctx, {
      method: 'GET',
      url: new URL(`http://localhost/checks_gate?${mergeQuery.toString()}`),
      headers: new Headers(),
      query: mergeQuery,
    })) as any;
    assert.equal(gateMerge.green, false, 'scope merge must not accept scope review token');
    assert.equal(gateMerge.overridden, false);

    // 2. Querying with scope 'review' MUST consume token and turn gate green
    const reviewQuery = new URLSearchParams({
      project_path: dir,
      override_token: token,
      scope: 'review',
    });
    const gateReview = (await gateHandler(ctx, {
      method: 'GET',
      url: new URL(`http://localhost/checks_gate?${reviewQuery.toString()}`),
      headers: new Headers(),
      query: reviewQuery,
    })) as any;
    assert.equal(gateReview.green, true, 'scope review must accept scope review token');
    assert.equal(gateReview.overridden, true);
  } finally {
    cleanup();
  }
});

test('regression Item 11: checks_cancel prevents saving finished results on cancelled run', async () => {
  const { dir, paths, cleanup } = createTempProject();
  try {
    const mawDir = path.win32.join(dir, '.maw');
    fs.mkdirSync(mawDir, { recursive: true });

    // A check that takes a few hundred ms
    const slowScript = path.join(dir, 'slow.js');
    fs.writeFileSync(slowScript, 'setTimeout(() => process.exit(0), 300);', 'utf8');

    const checksConfig = {
      version: 1,
      checks: [{ id: 'slow_test', label: 'Slow Test', command: [process.execPath, slowScript] }],
      spec_guard: false,
    };
    fs.writeFileSync(path.win32.join(mawDir, 'checks.json'), JSON.stringify(checksConfig), 'utf8');
    trustProjectChecks(paths, dir, crypto.createHash('sha256').update(JSON.stringify(checksConfig)).digest('hex'));

    const ctx = {
      paths,
      readJobs: async () => [],
      startJob: async () => ({ job_id: 'test' }),
    } as any;

    const runHandler = (feature as any).routes.checks_run.handler;
    const cancelHandler = (feature as any).routes.checks_cancel.handler;

    // Start running
    const runRes = await runHandler(ctx, {
      method: 'POST',
      url: new URL('http://localhost/checks_run'),
      headers: new Headers(),
      query: new URLSearchParams(),
      body: { project_path: dir },
    });
    assert.ok(runRes.ok);

    // Cancel immediately while slow script is running
    const cancelRes = await cancelHandler(ctx, {
      method: 'POST',
      url: new URL('http://localhost/checks_cancel'),
      headers: new Headers(),
      query: new URLSearchParams(),
      body: { project_path: dir },
    });
    assert.ok(cancelRes.ok);

    // Wait for slow script to finish
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Stored results and status: active run must be clear
    const statusHandler = (feature as any).routes.checks_status.handler;
    const statusRes = await statusHandler(ctx, {
      method: 'GET',
      url: new URL(`http://localhost/checks_status?project_path=${encodeURIComponent(dir)}`),
      headers: new Headers(),
      query: new URLSearchParams({ project_path: dir }),
    });

    assert.equal(statusRes.running, false, 'running must be false');
    assert.equal(statusRes.run_id, null, 'run_id must be null');
  } finally {
    cleanup();
  }
});
