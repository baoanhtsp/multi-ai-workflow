import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { psq } from '../../lib/commands.ts';
import {
  appendActionAudit,
  type MawFeature,
  type MawFeatureContext,
  type MawFeatureRequest,
} from '../../lib/feature.ts';
import { isFileSafe, isTestContext } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import type { AgentEntry } from '../../lib/registry.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  findClaudeExe,
  redactSecrets,
  resolveCliExecutable,
  runCliWithShimFallback,
} from '../health/probes.ts';
import { readJsonSafe, writeJsonAtomic } from '../policy/lib/s4-core.ts';
import {
  deleteAccountRecord,
  detectAccountLoginFast,
  listAllAccounts,
  resolveAccountExecutionEnv,
  saveAccountRecord,
} from './store.ts';

function readSnapshotLoginMap(ctx: MawFeatureContext): Map<string, 'ok' | 'logged_out' | 'unknown'> {
  const map = new Map<string, 'ok' | 'logged_out' | 'unknown'>();
  const snapFile = path.win32.join(ctx.paths.featureDataDir('quota'), 'snapshots.json');
  if (!isFileSafe(snapFile)) return map;
  const { data } = readJsonSafe<{ snapshots?: Array<Record<string, unknown>> }>(snapFile, {
    snapshots: [],
  });
  for (const s of data.snapshots || []) {
    const ag = String(s.agent ?? '').toLowerCase();
    const ac = String(s.account ?? '').toLowerCase();
    const lg = String(s.login ?? '');
    if (ag && ac && (lg === 'ok' || lg === 'logged_out' || lg === 'unknown')) {
      map.set(`${ag}:${ac}`, lg);
    }
  }
  return map;
}

function updateSnapshotLogin(
  ctx: MawFeatureContext,
  agent: string,
  account: string,
  login: 'ok' | 'logged_out' | 'unknown'
): void {
  const quotaDir = ctx.paths.featureDataDir('quota');
  const snapFile = path.win32.join(quotaDir, 'snapshots.json');
  if (!fs.existsSync(snapFile)) return;
  try {
    const { data } = readJsonSafe<{ version?: number; snapshots?: Array<Record<string, unknown>> }>(
      snapFile,
      { version: 1, snapshots: [] }
    );
    const list = Array.isArray(data.snapshots) ? data.snapshots : [];
    const found = list.find(
      (s) =>
        String(s.agent ?? '').toLowerCase() === agent.toLowerCase() &&
        String(s.account ?? '').toLowerCase() === account.toLowerCase()
    );
    if (found) {
      found.login = login;
      writeJsonAtomic(snapFile, { version: 1, snapshots: list });
    }
  } catch {
    // Best-effort snapshot login update
  }
}

export async function checkAccountStatusLive(
  ctx: MawFeatureContext,
  agentId: string,
  accountId: string
): Promise<{
  ok: true;
  agent: string;
  account: string;
  login: 'ok' | 'logged_out' | 'unknown';
  detail: string;
}> {
  const normAgent = String(agentId ?? '')
    .trim()
    .toLowerCase();
  const normAcc =
    String(accountId ?? 'default')
      .trim()
      .toLowerCase() || 'default';

  const agentEntry = ctx.registry.allAgents.find((a: AgentEntry) => a.id.toLowerCase() === normAgent);
  if (!agentEntry) {
    throw new ApiValidationError(`Unknown agent '${normAgent}'.`, 400);
  }

  const resolvedAcc = resolveAccountExecutionEnv(ctx.paths, ctx.registry, normAgent, normAcc);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: ctx.paths.userProfile,
    MAW_HOME: ctx.paths.mawHome,
    ...resolvedAcc.env,
  };

  let login: 'ok' | 'logged_out' | 'unknown' = 'unknown';
  let detail = '';

  if (agentEntry.adapter === 'claude') {
    let claudeBin = resolveCliExecutable(agentEntry.detect.command || 'claude', ctx.paths.userProfile);
    if (!claudeBin) {
      claudeBin = findClaudeExe(ctx.paths.userProfile);
    }
    if (!claudeBin) {
      // Fast fallback to config dir check
      login = detectAccountLoginFast(ctx.paths, agentEntry, resolvedAcc.account);
      detail = login === 'ok' ? 'Credentials present in config directory' : 'Not signed in';
    } else {
      const res = await runCliWithShimFallback(
        claudeBin,
        ['auth', 'status'],
        ctx.paths.userProfile,
        5000,
        childEnv
      );
      const rawOut = (res.stdout || res.stderr || '').trim();
      interface ClaudeAuthJson {
        loggedIn?: boolean;
        authMethod?: string;
        subscriptionType?: string;
      }
      let parsed: ClaudeAuthJson | null = null;
      try {
        parsed = JSON.parse(rawOut) as ClaudeAuthJson;
      } catch {
        const m = /\{[\s\S]*"loggedIn"[\s\S]*\}/.exec(rawOut);
        if (m) {
          try {
            parsed = JSON.parse(m[0]) as ClaudeAuthJson;
          } catch {}
        }
      }
      if (parsed && typeof parsed.loggedIn === 'boolean') {
        login = parsed.loggedIn ? 'ok' : 'logged_out';
        detail = parsed.loggedIn
          ? `Signed in (${parsed.authMethod || 'claude.ai'}${parsed.subscriptionType ? ' · ' + parsed.subscriptionType : ''})`
          : 'Signed out';
      } else if (res.code === 0 && /logged in/i.test(rawOut) && !/not logged in/i.test(rawOut)) {
        login = 'ok';
        detail = redactSecrets(rawOut, ctx.paths.userProfile);
      } else {
        login = 'logged_out';
        detail = redactSecrets(rawOut || 'Signed out', ctx.paths.userProfile);
      }
    }
  } else if (agentEntry.adapter === 'codex') {
    const res = await runCliWithShimFallback(
      agentEntry.detect.command || 'codex',
      ['login', 'status'],
      ctx.paths.userProfile,
      5000,
      childEnv
    );
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    if (/logged in/i.test(combined) && !/not logged in/i.test(combined)) {
      login = 'ok';
      detail = redactSecrets(combined, ctx.paths.userProfile);
    } else if (/not logged in/i.test(combined)) {
      login = 'logged_out';
      detail = redactSecrets(combined, ctx.paths.userProfile);
    } else {
      login = detectAccountLoginFast(ctx.paths, agentEntry, resolvedAcc.account);
      detail = login === 'ok' ? 'auth.json present' : 'Not signed in';
    }
  } else if (Array.isArray(agentEntry.status_cmd) && agentEntry.status_cmd.length > 0) {
    const cmd = agentEntry.status_cmd[0]!;
    const args = agentEntry.status_cmd.slice(1);
    const res = await runCliWithShimFallback(cmd, args, ctx.paths.userProfile, 5000, childEnv);
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code === 0 && !/not logged in|signed out|loggedIn":\s*false/i.test(combined)) {
      login = 'ok';
      detail = redactSecrets(combined || 'Signed in', ctx.paths.userProfile);
    } else {
      login = 'logged_out';
      detail = redactSecrets(combined || 'Signed out', ctx.paths.userProfile);
    }
  } else {
    login = detectAccountLoginFast(ctx.paths, agentEntry, resolvedAcc.account);
    detail =
      login === 'ok'
        ? 'Credentials found in account directory'
        : login === 'logged_out'
          ? 'No credentials in account directory'
          : 'Status check not supported for this adapter';
  }

  updateSnapshotLogin(ctx, normAgent, resolvedAcc.accountId, login);
  appendActionAudit(ctx.paths, {
    feature: 'accounts',
    action: 'account_status',
    agent: normAgent,
    account: resolvedAcc.accountId,
    login,
  });

  return {
    ok: true,
    agent: normAgent,
    account: resolvedAcc.accountId,
    login,
    detail,
  };
}

export async function handleAccountLogin(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const body = req.body ?? {};
  const rawAgent = String(body.agent ?? '')
    .trim()
    .toLowerCase();
  const rawAccount =
    String(body.account ?? body.id ?? 'default')
      .trim()
      .toLowerCase() || 'default';

  if (!rawAgent) {
    throw new ApiValidationError("Missing 'agent' in request body.", 400);
  }

  const agentEntry = ctx.registry.allAgents.find((a: AgentEntry) => a.id.toLowerCase() === rawAgent);
  if (!agentEntry) {
    throw new ApiValidationError(`Agent '${rawAgent}' is unknown.`, 400);
  }

  const resolvedAcc = resolveAccountExecutionEnv(ctx.paths, ctx.registry, rawAgent, rawAccount);

  let cmdArray: string[] = [];
  if (Array.isArray(agentEntry.login_cmd) && agentEntry.login_cmd.length > 0) {
    cmdArray = agentEntry.login_cmd.map(String);
  } else if (rawAgent === 'claude') {
    cmdArray = ['claude', 'auth', 'login'];
  } else if (rawAgent === 'codex') {
    cmdArray = ['codex', 'login'];
  } else if (rawAgent === 'gemini') {
    cmdArray = ['gemini'];
  } else if (rawAgent === 'cursor') {
    cmdArray = ['cursor-agent', 'login'];
  } else {
    throw new ApiValidationError(`${agentEntry.label} has no login command.`, 400);
  }

  const first = cmdArray[0]!;
  let resolvedBin = first;
  if (rawAgent === 'claude') {
    const claudeExe = findClaudeExe(ctx.paths.userProfile);
    if (claudeExe) {
      resolvedBin = claudeExe;
    }
  } else {
    const shim = resolveCliExecutable(first, ctx.paths.userProfile);
    if (shim) {
      resolvedBin = shim;
    }
  }

  const renderedArgs = [resolvedBin, ...cmdArray.slice(1)];
  const displayCommand = cmdArray.join(' ');
  const envPrefix = Object.entries(resolvedAcc.env)
    .map(([k, v]) => `$env:${k} = ${psq(v)}; `)
    .join('');
  const innerPs = `${envPrefix}& ${renderedArgs.map(psq).join(' ')}`;

  const loginId = `login_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let pidNum = process.pid;

  if (!isTestContext() || process.env.MAW_ALLOW_TEST_LOGIN_SPAWN === '1') {
    const launcherPs = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', ${psq(innerPs)}) -PassThru; $p.Id`;
    const b64 = Buffer.from(launcherPs, 'utf16le').toString('base64');

    const execRes = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { timeoutMs: 10000 }
    );
    pidNum = Number.parseInt(execRes.stdout.trim(), 10);
    if (!Number.isInteger(pidNum) || pidNum <= 0) {
      throw new Error(
        `Failed to open login terminal: ${execRes.stderr || execRes.stdout || 'Unknown error'}`
      );
    }
  }

  appendActionAudit(ctx.paths, {
    feature: 'accounts',
    action: 'account_login',
    agent: rawAgent,
    account: resolvedAcc.accountId,
    login_id: loginId,
    pid: pidNum,
  });

  return {
    ok: true,
    login_id: loginId,
    pid: pidNum,
    agent: rawAgent,
    account: resolvedAcc.accountId,
    command: displayCommand,
    env: resolvedAcc.env,
  };
}

export const feature: MawFeature = {
  name: 'accounts',
  routes: {
    account_list: {
      method: 'GET',
      handler: (ctx) => {
        const snapshotLogins = readSnapshotLoginMap(ctx);
        const { accounts, adapters } = listAllAccounts(ctx.paths, ctx.registry, snapshotLogins);
        return {
          ok: true,
          accounts,
          adapters,
        };
      },
    },
    account_save: {
      method: 'POST',
      handler: (ctx, req) => {
        const rawAccount = req.body?.account ?? req.body;
        const account = saveAccountRecord(ctx.paths, ctx.registry, rawAccount);
        return {
          ok: true,
          account,
        };
      },
    },
    account_delete: {
      method: 'POST',
      handler: (ctx, req) => {
        deleteAccountRecord(ctx.paths, req.body?.agent, req.body?.id ?? req.body?.account);
        return {
          ok: true,
        };
      },
    },
    account_login: {
      method: 'POST',
      handler: (ctx, req) => handleAccountLogin(ctx, req),
    },
    account_status: {
      method: 'GET',
      handler: (ctx, req) => {
        const agent = String(req.query.get('agent') ?? '').trim();
        const account = String(req.query.get('account') ?? 'default').trim() || 'default';
        if (!agent) {
          throw new ApiValidationError("Missing 'agent' query parameter.", 400);
        }
        return checkAccountStatusLive(ctx, agent, account);
      },
    },
  },
  status: (ctx) => {
    const snapshotLogins = readSnapshotLoginMap(ctx);
    const { accounts } = listAllAccounts(ctx.paths, ctx.registry, snapshotLogins);
    return {
      total: accounts.length,
      custom: accounts.filter((a) => !a.is_default).length,
    };
  },
};
