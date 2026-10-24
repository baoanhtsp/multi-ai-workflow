import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFeatureContext } from '../../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import {
  handleMcpApply,
  handleMcpBackups,
  handleMcpConfig,
  handleMcpPreview,
  handleMcpRestore,
} from './actions.ts';
import { generateUnifiedDiff } from './diff.ts';
import { renderPlatformFile, setMcpPathOverrides } from './manager.ts';
import {
  isMaskedValue,
  maskAllEnvsInToml,
  maskEnvValue,
  parseCodexTomlMcp,
  updateCodexTomlMcp,
} from './toml.ts';

function createTempMcpPaths(): {
  paths: ServerPaths;
  claudeFile: string;
  codexFile: string;
  geminiFile: string;
  cleanup: () => void;
} {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maw_mcp_test_'));
  const userProfile = path.join(tmpRoot, 'UserProfile');
  const mawHome = path.join(tmpRoot, 'MawHome');
  const jobsDir = path.join(tmpRoot, 'jobs');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const paths = resolveServerPaths({ repoRoot, userProfile, mawHome });
  paths.jobsDir = jobsDir;

  const claudeFile = path.join(userProfile, '.claude.json');
  const codexFile = path.join(userProfile, '.codex', 'config.toml');
  const geminiFile = path.join(userProfile, '.gemini', 'settings.json');

  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.mkdirSync(path.dirname(geminiFile), { recursive: true });

  setMcpPathOverrides({
    claudeFile,
    codexFile,
    geminiFile,
  });

  return {
    paths,
    claudeFile,
    codexFile,
    geminiFile,
    cleanup: () => {
      setMcpPathOverrides(null);
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    },
  };
}

test('TOML round-trip preserves unrelated text, comments, and extra keys', () => {
  const origToml = `# Codex Configuration
model = "gpt-5.5"
temperature = 0.7

[mcp_servers.existing]
command = "node"
args = ["server.js"]
startup_timeout_sec = 60

[mcp_servers.existing.env]
API_KEY = "secret123456"

[database]
host = "localhost"
`;

  const parsed = parseCodexTomlMcp(origToml);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, 'existing');
  assert.equal(parsed[0]!.command, 'node');
  assert.deepEqual(parsed[0]!.args, ['server.js']);
  assert.equal(parsed[0]!.env?.API_KEY, 'secret123456');
  assert.equal(parsed[0]!.extra?.startup_timeout_sec, 60);

  // Add a new server while keeping existing
  const updatedToml = updateCodexTomlMcp(origToml, {
    set: [
      {
        name: 'maw',
        transport: 'stdio',
        command: 'node',
        args: ['main.js'],
        env: { MAW_URL: 'http://127.0.0.1:4317' },
      },
    ],
  });

  // Verify unrelated lines are preserved
  assert.ok(updatedToml.includes('model = "gpt-5.5"'));
  assert.ok(updatedToml.includes('temperature = 0.7'));
  assert.ok(updatedToml.includes('[database]'));
  assert.ok(updatedToml.includes('[mcp_servers.existing]'));
  assert.ok(updatedToml.includes('[mcp_servers.maw]'));

  // Test removing 'existing'
  const removedToml = updateCodexTomlMcp(updatedToml, {
    remove: ['existing'],
  });
  assert.ok(!removedToml.includes('[mcp_servers.existing]'));
  assert.ok(!removedToml.includes('secret123456'));
  assert.ok(removedToml.includes('[mcp_servers.maw]'));
  assert.ok(removedToml.includes('model = "gpt-5.5"'));
});

test('maskEnvValue masks secrets and isMaskedValue identifies masked form', () => {
  assert.equal(maskEnvValue('short'), '••••');
  assert.equal(maskEnvValue('123456'), '••••');
  assert.equal(maskEnvValue('secretkey89'), '••••89');
  assert.equal(isMaskedValue('••••89'), true);
  assert.equal(isMaskedValue('unmasked_value'), false);
});

test('unified diff generation produces expected patch', () => {
  const diff = generateUnifiedDiff(
    'a/config.toml',
    'b/config.toml',
    'line1\nline2\n',
    'line1\nline2 modified\nline3\n'
  );
  assert.ok(diff.includes('--- a/config.toml'));
  assert.ok(diff.includes('+++ b/config.toml'));
  assert.ok(diff.includes('-line2'));
  assert.ok(diff.includes('+line2 modified'));
  assert.ok(diff.includes('+line3'));
});

test('mcp_apply requires confirm: true, creates backups, and supports mcp_restore', async () => {
  const { paths, claudeFile, codexFile, geminiFile, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // Initial files
    fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
    fs.writeFileSync(codexFile, '# Initial codex\n', 'utf8');
    fs.writeFileSync(geminiFile, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');

    // 1. mcp_apply without confirm => 400
    const reqNoConfirm = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_apply'),
      query: new URLSearchParams(''),
      body: {
        platforms: ['claude', 'codex', 'gemini'],
        set: [{ name: 'maw', transport: 'stdio', command: 'node', args: ['main.js'] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    assert.throws(() => handleMcpApply(ctx, reqNoConfirm), /confirm: true/);

    // 2. mcp_preview
    const reqPreview = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [{ name: 'maw', transport: 'stdio', command: 'node', args: ['main.js'] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const prevRes = handleMcpPreview(ctx, reqPreview) as { ok: boolean; diff: string; changed: boolean };
    assert.equal(prevRes.ok, true);
    assert.equal(prevRes.changed, true);
    assert.ok(prevRes.diff.includes('+'));

    // 3. mcp_apply with confirm: true
    const reqApply = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_apply'),
      query: new URLSearchParams(''),
      body: {
        confirm: true,
        platforms: ['claude', 'codex', 'gemini'],
        set: [{ name: 'maw', transport: 'stdio', command: 'node', args: ['main.js'] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const applyRes = handleMcpApply(ctx, reqApply) as {
      ok: boolean;
      results: Array<{ platform: string; changed: boolean; backup?: string }>;
    };
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.results.length, 3);
    assert.ok(applyRes.results.every((r) => r.changed));
    const claudeBackup = applyRes.results.find((r) => r.platform === 'claude')?.backup;
    assert.ok(claudeBackup);

    // Verify written file contains maw server
    const claudeText = fs.readFileSync(claudeFile, 'utf8');
    assert.ok(claudeText.includes('"maw"'));

    // 4. mcp_backups
    const reqBackups = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_backups'),
      query: new URLSearchParams(''),
      body: {},
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const backupsRes = handleMcpBackups(ctx, reqBackups) as { ok: boolean; backups: Array<any> };
    assert.equal(backupsRes.ok, true);
    assert.ok(backupsRes.backups.length >= 3);

    // 5. mcp_restore
    const reqRestore = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_restore'),
      query: new URLSearchParams(''),
      body: {
        confirm: true,
        platform: 'claude',
        backup: claudeBackup,
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const restoreRes = handleMcpRestore(ctx, reqRestore) as { ok: boolean; restored_from: string };
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.restored_from, claudeBackup);

    // Restored claude file should have empty mcpServers again
    const restoredText = fs.readFileSync(claudeFile, 'utf8');
    assert.ok(!restoredText.includes('"maw"'));
  } finally {
    cleanup();
  }
});

test('MCP Major 1 regression: corrupt JSON in platform file is refused, never overwritten', async () => {
  const { paths, claudeFile, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const corruptContent = '{\n  "mcpServers": { "old": {} },\n  corrupt json line';
    fs.writeFileSync(claudeFile, corruptContent, 'utf8');

    // 1. mcp_preview on corrupt file returns error
    const reqPreview = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [{ name: 'maw', transport: 'stdio', command: 'node', args: ['main.js'] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const prevRes = handleMcpPreview(ctx, reqPreview) as { ok: boolean; error?: string };
    assert.equal(prevRes.ok, false);
    assert.ok(prevRes.error?.includes('not valid JSON; not touching it'));

    // 2. mcp_apply on corrupt file reports error and NEVER writes to disk
    const reqApply = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_apply'),
      query: new URLSearchParams(''),
      body: {
        confirm: true,
        platforms: ['claude'],
        set: [{ name: 'maw', transport: 'stdio', command: 'node', args: ['main.js'] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const applyRes = handleMcpApply(ctx, reqApply) as {
      ok: boolean;
      results: Array<{ platform: string; changed: boolean; error?: string }>;
    };
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.results[0]!.changed, false);
    assert.ok(applyRes.results[0]!.error?.includes('not valid JSON; not touching it'));

    // Verify file on disk is untouched
    const afterContent = fs.readFileSync(claudeFile, 'utf8');
    assert.equal(afterContent, corruptContent);
  } finally {
    cleanup();
  }
});

test('MCP Major 2 regression: Codex TOML preserves exact node_repl block, env_vars, and untouched sections', () => {
  const exactRealToml = `[features]
js_repl = false

[mcp_servers.node_repl]
args = []
command = 'C:\\Users\\Admin\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\78fb63cda1a9e2b2\\bin\\node_repl.exe'
env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"
CODEX_HOME = 'C:\\Users\\Admin\\.codex'

[shell_environment_policy.set]
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "8e172ec9f458f2e636fc69a1b8c68c217f6bb8d10c41f70a05a0878b73863701"
`;

  // 1. Add a separate server: node_repl must stay completely untouched
  const addedToml = updateCodexTomlMcp(exactRealToml, {
    set: [{ name: 'new_bot', transport: 'stdio', command: 'node', args: ['bot.js'] }],
  });

  assert.ok(addedToml.includes('env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]'));
  assert.ok(addedToml.includes('NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"'));
  assert.ok(addedToml.includes('[shell_environment_policy.set]'));
  assert.ok(addedToml.includes('[mcp_servers.new_bot]'));

  // 2. Update node_repl itself: preserve unmanaged env_vars and startup_timeout_sec
  const parsed = parseCodexTomlMcp(exactRealToml);
  const updatedToml = updateCodexTomlMcp(exactRealToml, {
    set: [
      {
        name: 'node_repl',
        transport: 'stdio',
        command: 'C:\\custom\\node_repl.exe',
        args: ['--debug'],
        env: {
          NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '••••', // Keep existing
          EXTRA_FLAG: 'active',
        },
      },
    ],
    existingServers: parsed,
  });

  assert.ok(updatedToml.includes('command = "C:\\\\custom\\\\node_repl.exe"'));
  assert.ok(updatedToml.includes('args = ["--debug"]'));
  // env_vars must still be present!
  assert.ok(updatedToml.includes('env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]'));
  // startup_timeout_sec was an unmanaged extra key in existing block, must be preserved
  assert.ok(updatedToml.includes('startup_timeout_sec = 120'));
  // Masked env was kept
  assert.ok(updatedToml.includes('NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"'));
  assert.ok(updatedToml.includes('EXTRA_FLAG = "active"'));
  assert.ok(updatedToml.includes('[shell_environment_policy.set]'));
});

test('MCP Major 3 regression: preview diff masks all envs on both sides; no real secrets leak', async () => {
  const { paths, claudeFile, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const initialDoc = {
      mcpServers: {
        existing_srv: {
          command: 'node',
          args: ['srv.js'],
          env: {
            TOP_SECRET_TOKEN: 'super_secret_token_xyz_99',
          },
        },
      },
    };
    fs.writeFileSync(claudeFile, JSON.stringify(initialDoc, null, 2), 'utf8');

    const reqPreview = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [
          {
            name: 'existing_srv',
            transport: 'stdio',
            command: 'node',
            args: ['srv.js'],
            env: {
              TOP_SECRET_TOKEN: 'brand_new_secret_token_abc_11',
            },
          },
        ],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const res = handleMcpPreview(ctx, reqPreview) as { ok: boolean; diff: string; changed: boolean };
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);

    // Verify NEITHER raw secret appears anywhere in the diff
    assert.ok(!res.diff.includes('super_secret_token_xyz_99'), 'Old secret must not appear in diff');
    assert.ok(!res.diff.includes('brand_new_secret_token_abc_11'), 'New secret must not appear in diff');
    // Verify masked tokens appear
    assert.ok(res.diff.includes('••••99'));
    assert.ok(res.diff.includes('••••11'));
  } finally {
    cleanup();
  }
});

test('MCP Major 4 regression: input validation rejects invalid names, transport, args, env, extra', () => {
  const { paths, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // 1. Evil name with line break / injection
    const reqEvilName = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'codex',
        set: [{ name: 'x]\n[evil', command: 'node', args: [] }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    assert.throws(() => handleMcpPreview(ctx, reqEvilName), (err: any) => err.statusCode === 400);

    // 2. Forbidden key in extra
    const reqForbiddenExtra = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [{ name: 'valid_srv', command: 'node', extra: { command: 'hacked' } }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    assert.throws(() => handleMcpPreview(ctx, reqForbiddenExtra), (err: any) => err.statusCode === 400);

    // 3. Invalid env key
    const reqInvalidEnvKey = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [{ name: 'valid_srv', command: 'node', env: { '123_invalid': 'val' } }],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };
    assert.throws(() => handleMcpPreview(ctx, reqInvalidEnvKey), (err: any) => err.statusCode === 400);
  } finally {
    cleanup();
  }
});

test('MCP Major 5 regression: mcp_restore rejects cross-platform backups', () => {
  const { paths, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    const reqWrongPlatform = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_restore'),
      query: new URLSearchParams(''),
      body: {
        confirm: true,
        platform: 'claude',
        backup: 'codex-20261025-120000.toml',
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    assert.throws(() => handleMcpRestore(ctx, reqWrongPlatform), (err: any) => {
      return err.statusCode === 400 && err.message.includes("must start with 'claude-'");
    });
  } finally {
    cleanup();
  }
});

test('MCP Round 2 Item 1: codex one-line change produces hunk with <= 7 lines of context total, and claude diff contains only mcpServers lines', () => {
  const { paths, codexFile, claudeFile, cleanup } = createTempMcpPaths();
  try {
    const registry = loadAgentRegistry(paths);
    const ctx = createFeatureContext(paths, registry);

    // 1. Codex with 150 lines (many projects tables) and a node_repl block
    const tomlLines: string[] = [
      '# Top comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.node_repl]',
      "command = 'C:\\custom\\path\\node_repl.exe'",
      'args = []',
      'env_vars = ["CODEX_CORE"]',
      'startup_timeout_sec = 120',
      '',
      '[mcp_servers.node_repl.env]',
      'NODE_ENV = "production"',
      'PORT = "5000"',
      '',
    ];
    // Add 100 project sections
    for (let p = 1; p <= 100; p++) {
      tomlLines.push(`[projects.'C:\\my\\project_${p}']`);
      tomlLines.push(`trust_level = "trusted"`);
      tomlLines.push('');
    }
    fs.writeFileSync(codexFile, tomlLines.join('\n'), 'utf8');

    // Make a 1-line change: change args from [] to ["--debug"]
    const reqCodex = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'codex',
        set: [
          {
            name: 'node_repl',
            command: 'C:\\custom\\path\\node_repl.exe',
            args: ['--debug'],
            extra: { env_vars: ['CODEX_CORE'], startup_timeout_sec: 120 },
            env: { NODE_ENV: 'production', PORT: '5000' },
          },
        ],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const codexRes = handleMcpPreview(ctx, reqCodex) as { ok: boolean; diff: string; changed: boolean };
    assert.equal(codexRes.ok, true);
    assert.equal(codexRes.changed, true);

    const diffLines = codexRes.diff.split('\n');
    const hunkHeaders = diffLines.filter((l) => l.startsWith('@@'));
    assert.equal(hunkHeaders.length, 1, 'Expected exactly 1 hunk for 1-line change');

    // Count context lines in the hunk (lines starting with space ' ')
    const contextLines = diffLines.filter((l) => l.startsWith(' '));
    assert.ok(contextLines.length <= 7, `Expected <= 7 context lines total, got ${contextLines.length}`);

    // Verify projects tables were omitted
    assert.ok(!codexRes.diff.includes('project_50'), 'Unrelated project sections must be omitted from diff');
    // Verify single-quotes command was preserved verbatim in update
    const updatedToml = renderPlatformFile(codexFile, 'codex', {
      set: reqCodex.body.set as any,
      maskEnv: false,
    });
    assert.ok(updatedToml.includes("command = 'C:\\custom\\path\\node_repl.exe'"), 'Preserves original command quotes');
    assert.ok(!updatedToml.includes('[mcp_servers.node_repl]\n\ncommand'), 'Does not add blank line inside table');

    // 2. Claude diff with large file (> 2000 lines) contains only mcpServers lines
    const largeClaudeJson: Record<string, unknown> = {
      mcpServers: {
        existing_srv: {
          command: 'node',
          args: ['old.js'],
        },
      },
    };
    for (let k = 1; k <= 2500; k++) {
      largeClaudeJson[`unrelated_key_${k}`] = `value_${k}`;
    }
    fs.writeFileSync(claudeFile, JSON.stringify(largeClaudeJson, null, 2), 'utf8');

    const reqClaude = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_preview'),
      query: new URLSearchParams(''),
      body: {
        platform: 'claude',
        set: [
          {
            name: 'existing_srv',
            command: 'node',
            args: ['new.js'],
          },
        ],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const claudeRes = handleMcpPreview(ctx, reqClaude) as { ok: boolean; diff: string; changed: boolean };
    assert.equal(claudeRes.ok, true);
    assert.equal(claudeRes.changed, true);
    assert.ok(!claudeRes.diff.includes('File too large for inline diff'), 'Subtree diff avoids whole-file overflow');
    assert.ok(claudeRes.diff.includes('~/.claude.json › mcpServers'), 'Expected subtree label in header');
    assert.ok(!claudeRes.diff.includes('unrelated_key_'), 'Subtree diff must not include non-mcpServers keys');
    assert.ok(claudeRes.diff.includes('-      "old.js"'));
    assert.ok(claudeRes.diff.includes('+      "new.js"'));
  } finally {
    cleanup();
  }
});

test('MCP Round 3 Item 1: extra secret keys and inline TOML env table masking & unmasked retain', () => {
  const { paths, claudeFile, codexFile, cleanup } = createTempMcpPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  try {
    // 1. Inline TOML env table masking
    const tomlWithInlineEnv = `[mcp_servers.my_srv]\ncommand = "node"\nenv = { API_KEY = "secret123456", PORT = "8080" }\n`;
    const maskedToml = maskAllEnvsInToml(tomlWithInlineEnv);
    assert.ok(maskedToml.includes('API_KEY = "••••56"'), 'Inline TOML API_KEY must be masked');
    assert.ok(maskedToml.includes('PORT = "••••"'), 'Inline TOML PORT must be masked');
    assert.ok(!maskedToml.includes('secret123456'), 'Original secret must not appear in masked TOML');

    // 2. Extra secret keys masking in Claude JSON
    const claudeJson = {
      mcpServers: {
        secure_srv: {
          command: 'node',
          args: ['run.js'],
          auth_token: 'super_secret_auth_token_99',
          headers: {
            Authorization: 'Bearer secret_bearer_token_11',
            UserAgent: 'SafeClient/1.0',
          },
          timeout: 30,
        },
      },
    };
    fs.writeFileSync(claudeFile, JSON.stringify(claudeJson, null, 2), 'utf8');

    const cfgRes = handleMcpConfig(ctx, { ...ctx, query: new URLSearchParams('') } as any) as any;
    const claudeStatus = cfgRes.platforms.find((p: any) => p.platform === 'claude');
    const srv = claudeStatus.servers.find((s: any) => s.name === 'secure_srv');
    assert.ok(srv, 'secure_srv must be present');
    assert.ok(srv.extra.auth_token.startsWith('••••'), 'auth_token must be masked');
    assert.ok(!srv.extra.auth_token.includes('super_secret'), 'Real auth_token must not appear in config');
    assert.ok(srv.extra.headers.Authorization.startsWith('••••'), 'Authorization header must be masked');
    assert.equal(srv.extra.headers.UserAgent, 'SafeClient/1.0', 'Non-secret extra keys must be preserved');

    // 3. Retain unmasked secret when updating with masked value
    const reqUpdate = {
      ...ctx,
      url: new URL('http://127.0.0.1:4317/api?action=mcp_apply'),
      query: new URLSearchParams(''),
      body: {
        confirm: true,
        platforms: ['claude'],
        set: [
          {
            name: 'secure_srv',
            command: 'node',
            args: ['run.js'],
            extra: {
              auth_token: srv.extra.auth_token, // Masked value submitted from UI
              headers: {
                Authorization: srv.extra.headers.Authorization, // Masked value
                UserAgent: 'UpdatedClient/2.0',
              },
              timeout: 45,
            },
          },
        ],
      },
      req: {} as any,
      res: {} as any,
      ctx,
    };

    const applyRes = handleMcpApply(ctx, reqUpdate as any) as any;
    assert.equal(applyRes.ok, true);

    const updatedRaw = fs.readFileSync(claudeFile, 'utf8');
    const updatedParsed = JSON.parse(updatedRaw);
    const updatedSrv = updatedParsed.mcpServers.secure_srv;
    assert.equal(updatedSrv.auth_token, 'super_secret_auth_token_99', 'Existing unmasked auth_token must be retained');
    assert.equal(updatedSrv.headers.Authorization, 'Bearer secret_bearer_token_11', 'Existing unmasked Authorization must be retained');
    assert.equal(updatedSrv.headers.UserAgent, 'UpdatedClient/2.0', 'Updated UserAgent must be written');
    assert.equal(updatedSrv.timeout, 45, 'Updated timeout must be written');
  } finally {
    cleanup();
  }
});

test('MCP Round 3 Item 8: copy_from across platforms in preview and apply', () => {
  const { paths, codexFile, geminiFile, cleanup } = createTempMcpPaths();
  const ctx = createFeatureContext(paths, loadAgentRegistry(paths));

  try {
    // 1. Setup Codex source server with real env
    const codexToml = `[mcp_servers.tool_srv]\ncommand = "python"\nargs = ["tool.py"]\n\n[mcp_servers.tool_srv.env]\nAPI_KEY = "my_unmasked_secret_123"\n`;
    fs.writeFileSync(codexFile, codexToml, 'utf8');

    // 2. Mutual exclusivity check: copy_from with set throws 400
    assert.throws(
      () =>
        handleMcpPreview(ctx, {
          ...ctx,
          body: {
            platform: 'gemini',
            copy_from: { platform: 'codex', name: 'tool_srv' },
            set: [{ name: 'other' }],
          },
        } as any),
      (err: any) => err.statusCode === 400 && err.message.includes('mutually exclusive')
    );

    // 3. Unknown source server throws 404
    assert.throws(
      () =>
        handleMcpPreview(ctx, {
          ...ctx,
          body: {
            platform: 'gemini',
            copy_from: { platform: 'codex', name: 'nonexistent' },
          },
        } as any),
      (err: any) => err.statusCode === 404
    );

    // 4. Preview copy_from: diff has masked secret
    const previewRes = handleMcpPreview(ctx, {
      ...ctx,
      body: {
        platform: 'gemini',
        copy_from: { platform: 'codex', name: 'tool_srv' },
      },
    } as any) as any;
    assert.equal(previewRes.ok, true);
    assert.equal(previewRes.changed, true);
    assert.ok(previewRes.diff.includes('tool_srv'), 'Diff must include tool_srv');
    assert.ok(previewRes.diff.includes('••••23'), 'Diff must show masked API_KEY');
    assert.ok(!previewRes.diff.includes('my_unmasked_secret_123'), 'Diff must NOT contain unmasked secret');

    // 5. Apply copy_from to gemini: writes real unmasked env to target file
    const applyRes = handleMcpApply(ctx, {
      ...ctx,
      body: {
        confirm: true,
        platforms: ['gemini'],
        copy_from: { platform: 'codex', name: 'tool_srv' },
      },
    } as any) as any;
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.results[0].changed, true);

    const geminiRaw = fs.readFileSync(geminiFile, 'utf8');
    const geminiParsed = JSON.parse(geminiRaw);
    assert.ok(geminiParsed.mcpServers.tool_srv, 'tool_srv must be written to gemini');
    assert.equal(geminiParsed.mcpServers.tool_srv.command, 'python');
    assert.deepEqual(geminiParsed.mcpServers.tool_srv.args, ['tool.py']);
    assert.equal(geminiParsed.mcpServers.tool_srv.env.API_KEY, 'my_unmasked_secret_123', 'Real secret must be written');
  } finally {
    cleanup();
  }
});
