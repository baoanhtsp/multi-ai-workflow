import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFailure,
  escapeRegExp,
  isPathInsideProject,
  matchCommand,
  matchGlob,
  parseResetTime,
  redactSecrets,
} from '../lib/s4-core.ts';

test('classifyFailure: classifies all kinds with reset time parsing', () => {
  const fixedNow = new Date('2026-10-25T10:00:00.000Z');

  // 1. Blocked by S4 hook
  const s4BlockedLog = 'HOOK_BLOCKED (before-agent): Budget day exceeded [S4:budget agent=claude fallback=none]';
  const c1 = classifyFailure(s4BlockedLog, 5, fixedNow);
  assert.equal(c1.kind, 'blocked');
  if (c1.kind === 'blocked') {
    assert.equal(c1.by, 's4');
    assert.equal(c1.code, 'budget');
    assert.equal(c1.agent, 'claude');
    assert.equal(c1.fallback, undefined);
  }

  const s4CooldownLog = 'HOOK_BLOCKED: Rate limited [S4:cooldown agent=codex fallback=gemini]';
  const c2 = classifyFailure(s4CooldownLog, 5, fixedNow);
  assert.equal(c2.kind, 'blocked');
  if (c2.kind === 'blocked') {
    assert.equal(c2.by, 's4');
    assert.equal(c2.code, 'cooldown');
    assert.equal(c2.agent, 'codex');
    assert.equal(c2.fallback, 'gemini');
  }

  // Blocked by other hook
  const otherBlockedLog = 'HOOK_BLOCKED (before-agent): Health check failed: agent not responding';
  const c3 = classifyFailure(otherBlockedLog, 5, fixedNow);
  assert.equal(c3.kind, 'blocked');
  if (c3.kind === 'blocked') {
    assert.equal(c3.by, 'other');
  }

  // 2. Usage limit with various reset formats
  // ISO format
  const isoLog = 'Error: quota exceeded. Resets at 2026-10-25T14:30:00.000Z for this tier';
  const cIso = classifyFailure(isoLog, 1, fixedNow);
  assert.equal(cIso.kind, 'usage_limit');
  if (cIso.kind === 'usage_limit') {
    assert.equal(cIso.reset_at, '2026-10-25T14:30:00.000Z');
  }

  // "resets at 14:05" (local time)
  const timeLog = 'You have hit your usage limit, resets at 14:05';
  const cTime = classifyFailure(timeLog, 1, fixedNow);
  assert.equal(cTime.kind, 'usage_limit');
  if (cTime.kind === 'usage_limit') {
    assert.ok(cTime.reset_at !== null);
  }

  // "try again in 2h 13m"
  const durLog = 'RESOURCE_EXHAUSTED: quota exceeded, try again in 2h 13m';
  const cDur = classifyFailure(durLog, 1, fixedNow);
  assert.equal(cDur.kind, 'usage_limit');
  if (cDur.kind === 'usage_limit') {
    assert.ok(cDur.reset_at !== null);
    const diffMs = new Date(cDur.reset_at!).getTime() - fixedNow.getTime();
    assert.equal(diffMs, (2 * 3600 + 13 * 60) * 1000);
  }

  // "retry-after: 120"
  const retryAfterLog = 'Rate limit: out of credits. retry-after: 120';
  const cRa = classifyFailure(retryAfterLog, 1, fixedNow);
  assert.equal(cRa.kind, 'usage_limit');
  if (cRa.kind === 'usage_limit') {
    assert.ok(cRa.reset_at !== null);
    const diffMs = new Date(cRa.reset_at!).getTime() - fixedNow.getTime();
    assert.equal(diffMs, 120 * 1000);
  }

  // Usage limit without reset time
  const noResetLog = 'Error: you have reached your usage limit for today';
  const cNoReset = classifyFailure(noResetLog, 1, fixedNow);
  assert.equal(cNoReset.kind, 'usage_limit');
  if (cNoReset.kind === 'usage_limit') {
    assert.equal(cNoReset.reset_at, null);
  }

  // 3. Auth
  const authLog = 'API error: OAuth session expired. Please log in again.';
  const cAuth = classifyFailure(authLog, 1, fixedNow);
  assert.equal(cAuth.kind, 'auth');

  // 4. Transient (last 40 lines)
  const transient429 = 'Failed with HTTP 429 Too Many Requests';
  const c429 = classifyFailure(transient429, 1, fixedNow);
  assert.equal(c429.kind, 'transient');
  if (c429.kind === 'transient') {
    assert.equal(c429.code, '429');
  }

  const transientOverloaded = 'Server is overloaded, please retry';
  const cOver = classifyFailure(transientOverloaded, 1, fixedNow);
  assert.equal(cOver.kind, 'transient');
  if (cOver.kind === 'transient') {
    assert.equal(cOver.code, 'overloaded');
  }

  // Transient only in older lines (>60 lines ago) should NOT match
  const longLog = '429 Too Many Requests\n' + new Array(65).fill('All operations normal').join('\n');
  const cOldTransient = classifyFailure(longLog, 1, fixedNow);
  assert.equal(cOldTransient.kind, 'other');

  // 5. Timeout
  const cTimeout = classifyFailure('Process terminated', 124, fixedNow);
  assert.equal(cTimeout.kind, 'timeout');

  // 6. Other
  const cOther = classifyFailure('SyntaxError in source code', 1, fixedNow);
  assert.equal(cOther.kind, 'other');
});

test('redactSecrets: redacts all built-in patterns, custom .env values, and is idempotent', () => {
  const sample = [
    'Anthropic key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890',
    'OpenAI key: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    'GitHub pat: github_pat_11AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRRSSTTUUVVWWXXYYZZ0123456789',
    'GitHub token: ghp_112233445566778899001122334455667788',
    'AWS key: AKIA1234567890ABCDEF',
    'Google key: AIzaSyD1234567890abcdefghijklmnopqrstuv',
    'Slack token: xox' + 'b-1234567890-1234567890123-abcdefghijklmnop',
    'Telegram token: 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789',
    'JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozGzN_example_sig',
    'Private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----',
    'Assignment 1: api_key: "super_secret_password_123"',
    'Assignment 2: password=very_secret_token_val_456',
  ].join('\n');

  const extra = ['custom_secret_value_999'];
  const textWithExtra = `${sample}\nCustom config: custom_secret_value_999`;

  const redacted1 = redactSecrets(textWithExtra, extra);

  assert.ok(!redacted1.includes('sk-ant-api03'));
  assert.ok(redacted1.includes('[REDACTED:anthropic]'));

  assert.ok(!redacted1.includes('sk-proj-'));
  assert.ok(redacted1.includes('[REDACTED:openai]'));

  assert.ok(!redacted1.includes('github_pat_'));
  assert.ok(!redacted1.includes('ghp_'));
  assert.ok(redacted1.includes('[REDACTED:github]'));

  assert.ok(!redacted1.includes('AKIA1234567890ABCDEF'));
  assert.ok(redacted1.includes('[REDACTED:aws]'));

  assert.ok(!redacted1.includes('AIzaSyD'));
  assert.ok(redacted1.includes('[REDACTED:google]'));

  assert.ok(!redacted1.includes('xoxb-'));
  assert.ok(redacted1.includes('[REDACTED:slack]'));

  assert.ok(!redacted1.includes('123456789:ABCdef'));
  assert.ok(redacted1.includes('[REDACTED:telegram]'));

  assert.ok(!redacted1.includes('eyJhbGci'));
  assert.ok(redacted1.includes('[REDACTED:jwt]'));

  assert.ok(!redacted1.includes('MIIEowIBAAKCAQEA0'));
  assert.ok(redacted1.includes('[REDACTED:private_key]'));

  assert.ok(redacted1.includes('api_key: "[REDACTED:assignment]"'));
  assert.ok(redacted1.includes('password=[REDACTED:assignment]'));

  assert.ok(!redacted1.includes('custom_secret_value_999'));
  assert.ok(redacted1.includes('[REDACTED:custom]'));

  // Idempotency: redacting twice yields identical string
  const redacted2 = redactSecrets(redacted1, extra);
  assert.equal(redacted2, redacted1);

  // Policy block preserved
  const textWithPolicy =
    '<!-- MAW-S4-POLICY:BEGIN -->\n- Never run: git push --force\n<!-- MAW-S4-POLICY:END -->\napi_key = "1234567890abcdef"';
  const redactedPolicy = redactSecrets(textWithPolicy);
  assert.ok(redactedPolicy.includes('<!-- MAW-S4-POLICY:BEGIN -->'));
  assert.ok(redactedPolicy.includes('<!-- MAW-S4-POLICY:END -->'));
  assert.ok(redactedPolicy.includes('api_key = "[REDACTED:assignment]"'));
});

test('matchCommand: ordered tokens, re:, allow patterns', () => {
  // Ordered tokens
  assert.ok(matchCommand('git push origin main --force', 'git push --force'));
  assert.ok(matchCommand('git   push    --force', 'git push --force'));
  assert.ok(!matchCommand('git --force push origin main', 'git push --force')); // wrong order

  // Regex pattern
  assert.ok(matchCommand('rm -rf /var/data', 're:^rm\\s+-rf'));
  assert.ok(!matchCommand('git rm -rf file', 're:^rm\\s+-rf'));

  // Whole token matching (Item 10)
  assert.ok(!matchCommand('perform x -rfoo', 'rm -rf'));
  assert.ok(!matchCommand('digit pushed', 'git push'));

  // Allow pattern bypasses match
  assert.ok(!matchCommand('git push origin feature', 'git push', ['git push origin feature']));
  assert.ok(matchCommand('git push origin main', 'git push', ['git push origin feature']));
});

test('matchGlob: matches path segments, wildcards, and basenames', () => {
  // Basename matching when no /
  assert.ok(matchGlob('.env', '.env'));
  assert.ok(matchGlob('config/.env', '.env'));
  assert.ok(matchGlob('a/b/c/.env', '.env'));
  assert.ok(!matchGlob('a/b/c/.env.bak', '.env'));

  // Multi-depth **
  assert.ok(matchGlob('certs/server.pem', '**/*.pem'));
  assert.ok(matchGlob('a/b/c/key.pem', '**/*.pem'));
  assert.ok(!matchGlob('a/b/c/key.txt', '**/*.pem'));

  // Single depth *
  assert.ok(matchGlob('.git/config', '.git/**'));
  assert.ok(matchGlob('.git/hooks/pre-commit', '.git/**'));

  // Question mark ?
  assert.ok(matchGlob('ssh/id_rsa1', '**/id_rsa?'));
  assert.ok(!matchGlob('ssh/id_rsa12', '**/id_rsa?'));
});

test('isPathInsideProject: enforces project boundary and worktree subdirectories', () => {
  const root = 'C:\\laragon\\www\\my-project';

  assert.ok(isPathInsideProject('C:\\laragon\\www\\my-project', root));
  assert.ok(isPathInsideProject('C:/laragon/www/my-project/', root));
  assert.ok(isPathInsideProject('c:\\laragon\\www\\my-project\\src\\index.ts', root));
  assert.ok(isPathInsideProject('C:\\laragon\\www\\my-project\\.claude\\worktrees\\v5-s4', root));

  // Traversal or sibling
  assert.ok(!isPathInsideProject('C:\\laragon\\www\\my-project-evil', root));
  assert.ok(!isPathInsideProject('C:\\laragon\\www\\other', root));
});
