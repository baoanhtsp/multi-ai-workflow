import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { isFileSafe } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { generateUnifiedDiff } from './diff.ts';
import {
  backupPlatformFile,
  getMcpFiles,
  listMcpBackups,
  maskServerConfig,
  readPlatformServers,
  renderPlatformFile,
} from './manager.ts';
import { maskAllEnvsInJson, maskAllEnvsInToml } from './toml.ts';
import type { McpServerConfig, PlatformMcpStatus } from './types.ts';

const VALID_PLATFORMS = new Set(['claude', 'codex', 'gemini']);

export function validateMcpMutation(
  platform: 'claude' | 'codex' | 'gemini',
  set?: unknown,
  remove?: unknown
): void {
  const nameRegex = platform === 'codex' ? /^[A-Za-z0-9_-]{1,64}$/ : /^[A-Za-z0-9_.-]{1,64}$/;

  if (remove !== undefined && remove !== null) {
    if (!Array.isArray(remove)) {
      throw new ApiValidationError("Property 'remove' must be an array of strings.", 400);
    }
    for (const r of remove) {
      if (typeof r !== 'string' || !nameRegex.test(r)) {
        throw new ApiValidationError(
          `Invalid server name '${String(r)}' in remove. Names must match ${nameRegex}.`,
          400
        );
      }
    }
  }

  if (set !== undefined && set !== null) {
    if (!Array.isArray(set)) {
      throw new ApiValidationError("Property 'set' must be an array of server objects.", 400);
    }
    for (const s of set) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new ApiValidationError("Server in 'set' must be an object.", 400);
      }
      const sObj = s as Record<string, unknown>;

      // Name
      if (typeof sObj.name !== 'string' || !nameRegex.test(sObj.name)) {
        throw new ApiValidationError(
          `Invalid server name '${String(sObj.name)}'. Names must match ${nameRegex}.`,
          400
        );
      }

      // Transport
      if (sObj.transport !== undefined && sObj.transport !== null) {
        if (sObj.transport !== 'stdio' && sObj.transport !== 'http') {
          throw new ApiValidationError("Transport must be 'stdio' or 'http'.", 400);
        }
      }

      // Command / URL
      if (sObj.command !== undefined && sObj.command !== null) {
        if (typeof sObj.command !== 'string' || sObj.command.length > 2000) {
          throw new ApiValidationError("'command' must be a string <= 2000 characters.", 400);
        }
      }
      if (sObj.url !== undefined && sObj.url !== null) {
        if (typeof sObj.url !== 'string' || sObj.url.length > 2000) {
          throw new ApiValidationError("'url' must be a string <= 2000 characters.", 400);
        }
      }

      // Args
      if (sObj.args !== undefined && sObj.args !== null) {
        if (!Array.isArray(sObj.args) || sObj.args.length > 100) {
          throw new ApiValidationError("'args' must be an array of <= 100 strings.", 400);
        }
        for (const a of sObj.args) {
          if (typeof a !== 'string' || a.length > 4000) {
            throw new ApiValidationError("Each argument must be a string <= 4000 characters.", 400);
          }
        }
      }

      // Env
      if (sObj.env !== undefined && sObj.env !== null) {
        if (typeof sObj.env !== 'object' || Array.isArray(sObj.env)) {
          throw new ApiValidationError("'env' must be a key-value object.", 400);
        }
        for (const [k, v] of Object.entries(sObj.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) {
            throw new ApiValidationError(`Invalid env key '${k}'. Keys must match ^[A-Za-z_][A-Za-z0-9_]{0,127}$.`, 400);
          }
          if (typeof v !== 'string') {
            throw new ApiValidationError(`Env value for '${k}' must be a string.`, 400);
          }
        }
      }

      // Extra
      if (sObj.extra !== undefined && sObj.extra !== null) {
        if (typeof sObj.extra !== 'object' || Array.isArray(sObj.extra)) {
          throw new ApiValidationError("'extra' must be a plain object.", 400);
        }
        const FORBIDDEN_EXTRA = new Set(['command', 'args', 'env', 'url', 'type', 'httpUrl']);
        for (const [k, v] of Object.entries(sObj.extra)) {
          if (FORBIDDEN_EXTRA.has(k)) {
            throw new ApiValidationError(`Forbidden key '${k}' in 'extra'.`, 400);
          }
          if (typeof v === 'function' || typeof v === 'symbol') {
            throw new ApiValidationError(`Invalid value for '${k}' in 'extra'.`, 400);
          }
        }
      }
    }
  }
}

function logMcpAudit(paths: any, action: string, details: Record<string, unknown>): void {
  try {
    const dataDir = paths.featureDataDir('mcp');
    const auditFile = path.win32.join(dataDir, 'audit.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      ...details,
    }) + '\n';
    fs.appendFileSync(auditFile, line, 'utf8');
  } catch {
    // Ignore audit log error
  }
}

export function handleMcpConfig(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const files = getMcpFiles(ctx.paths);
  const platforms: PlatformMcpStatus[] = [
    {
      platform: 'claude',
      file: files.claude,
      ...readPlatformServers(files.claude, 'claude'),
    },
    {
      platform: 'codex',
      file: files.codex,
      ...readPlatformServers(files.codex, 'codex'),
    },
    {
      platform: 'gemini',
      file: files.gemini,
      ...readPlatformServers(files.gemini, 'gemini'),
    },
  ];

  // Mask env in all returned servers
  for (const p of platforms) {
    p.servers = p.servers.map(maskServerConfig);
  }

  // Dashboard server config
  const mainTs = path.win32.join(ctx.paths.repoRoot, 'server', 'mcp', 'main.ts');
  const port = req.req?.socket?.localPort ?? 4317;

  return {
    ok: true,
    platforms,
    dashboard_server: {
      command: 'node',
      args: [mainTs],
      env: {
        MAW_URL: `http://127.0.0.1:${port}`,
      },
    },
  };
}

export function handleMcpPreview(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const body = req.body;
  const platform = String(body.platform ?? '').trim().toLowerCase() as 'claude' | 'codex' | 'gemini';
  if (!VALID_PLATFORMS.has(platform)) {
    throw new ApiValidationError("Property 'platform' must be 'claude', 'codex', or 'gemini'.", 400);
  }

  // Validate set and remove inputs (Item 4)
  validateMcpMutation(platform, body.set, body.remove);

  const files = getMcpFiles(ctx.paths);
  const targetFile = files[platform];
  const origContent = isFileSafe(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';

  try {
    // Render unmasked updated content to compute `changed` and check validity
    const unmaskedUpdated = renderPlatformFile(targetFile, platform, {
      set: body.set as McpServerConfig[] | undefined,
      remove: body.remove as string[] | undefined,
      maskEnv: false,
    });

    const changed = origContent.trim() !== unmaskedUpdated.trim();

    // For diff, both sides MUST have all env values masked (Item 3)
    const beforeMasked =
      platform === 'codex'
        ? maskAllEnvsInToml(origContent)
        : maskAllEnvsInJson(origContent);

    const afterMasked =
      platform === 'codex'
        ? maskAllEnvsInToml(unmaskedUpdated)
        : maskAllEnvsInJson(unmaskedUpdated);

    let diff: string;
    if (platform === 'codex') {
      diff = generateUnifiedDiff(targetFile, targetFile, beforeMasked, afterMasked);
    } else {
      // For JSON platforms (claude, gemini) diff only the managed subtree (mcpServers) (Round 2 Item 1b)
      let beforeSubtree = '{}';
      try {
        const parsed = JSON.parse(beforeMasked) as { mcpServers?: unknown };
        beforeSubtree = JSON.stringify(parsed?.mcpServers ?? {}, null, 2);
      } catch {
        beforeSubtree = '{}';
      }

      let afterSubtree = '{}';
      try {
        const parsed = JSON.parse(afterMasked) as { mcpServers?: unknown };
        afterSubtree = JSON.stringify(parsed?.mcpServers ?? {}, null, 2);
      } catch {
        afterSubtree = '{}';
      }

      const label =
        platform === 'claude'
          ? '~/.claude.json › mcpServers'
          : '~/.gemini/settings.json › mcpServers';

      diff = generateUnifiedDiff(label, label, beforeSubtree, afterSubtree);
    }

    return {
      ok: true,
      diff,
      changed,
    };
  } catch (err) {
    if (err instanceof ApiValidationError) throw err;
    return {
      ok: false,
      error: (err as Error)?.message ?? 'Unknown error',
    };
  }
}

export function handleMcpApply(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const body = req.body;
  if (body.confirm !== true) {
    throw new ApiValidationError("Missing confirmation: 'confirm: true' is required.", 400);
  }

  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    throw new ApiValidationError("Property 'platforms' must be a non-empty array.", 400);
  }

  // Validate mutation for every valid target platform (Item 4)
  for (const rawPlatform of body.platforms) {
    const p = String(rawPlatform).trim().toLowerCase() as 'claude' | 'codex' | 'gemini';
    if (VALID_PLATFORMS.has(p)) {
      validateMcpMutation(p, body.set, body.remove);
    }
  }

  const files = getMcpFiles(ctx.paths);
  const results: Array<{ platform: string; changed: boolean; backup?: string | null; error?: string }> = [];

  for (const rawPlatform of body.platforms) {
    const p = String(rawPlatform).trim().toLowerCase() as 'claude' | 'codex' | 'gemini';
    if (!VALID_PLATFORMS.has(p)) {
      results.push({ platform: p, changed: false, error: `Invalid platform '${p}'.` });
      continue;
    }

    const targetFile = files[p];
    try {
      const origContent = isFileSafe(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
      const newContent = renderPlatformFile(targetFile, p, {
        set: body.set as McpServerConfig[] | undefined,
        remove: body.remove as string[] | undefined,
        maskEnv: false, // Apply writes unmasked env
      });

      if (origContent.trim() === newContent.trim()) {
        results.push({ platform: p, changed: false });
        continue;
      }

      // Backup before write
      const backupName = backupPlatformFile(ctx.paths, targetFile, p);

      // Atomic write
      const parentDir = path.dirname(targetFile);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      const tempFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempFile, newContent, 'utf8');
      fs.renameSync(tempFile, targetFile);

      logMcpAudit(ctx.paths, 'mcp_apply', {
        platform: p,
        backup: backupName,
        set: body.set ? (body.set as McpServerConfig[]).map((s) => s.name) : [],
        remove: body.remove ?? [],
      });

      results.push({ platform: p, changed: true, backup: backupName });
    } catch (err) {
      results.push({
        platform: p,
        changed: false,
        error: (err as Error)?.message ?? 'Unknown error',
      });
    }
  }

  return {
    ok: true,
    results,
  };
}

export function handleMcpBackups(
  ctx: MawFeatureContext,
  _req: MawFeatureRequest
): Record<string, unknown> {
  const backups = listMcpBackups(ctx.paths);
  return {
    ok: true,
    backups,
  };
}

export function handleMcpRestore(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const body = req.body;
  if (body.confirm !== true) {
    throw new ApiValidationError("Missing confirmation: 'confirm: true' is required.", 400);
  }

  const platform = String(body.platform ?? '').trim().toLowerCase() as 'claude' | 'codex' | 'gemini';
  if (!VALID_PLATFORMS.has(platform)) {
    throw new ApiValidationError("Property 'platform' must be 'claude', 'codex', or 'gemini'.", 400);
  }

  const backupName = String(body.backup ?? '').trim();
  if (!backupName || backupName.includes('..') || backupName.includes('/') || backupName.includes('\\')) {
    throw new ApiValidationError("Invalid 'backup' filename.", 400);
  }

  // Restore must only accept a backup whose filename starts with "<platform>-" (Item 5)
  if (!backupName.startsWith(`${platform}-`)) {
    throw new ApiValidationError(`Backup filename must start with '${platform}-'.`, 400);
  }

  const dataDir = ctx.paths.featureDataDir('mcp');
  const backupFile = path.win32.join(dataDir, 'backups', backupName);
  if (!isFileSafe(backupFile)) {
    throw new ApiValidationError(`Backup '${backupName}' not found.`, 404);
  }

  const files = getMcpFiles(ctx.paths);
  const targetFile = files[platform];

  // Backup current file before restoring
  const currentBackup = backupPlatformFile(ctx.paths, targetFile, platform);

  // Restore
  const backupContent = fs.readFileSync(backupFile, 'utf8');
  const tempFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, backupContent, 'utf8');
  fs.renameSync(tempFile, targetFile);

  logMcpAudit(ctx.paths, 'mcp_restore', {
    platform,
    restoredFrom: backupName,
    safetyBackup: currentBackup,
  });

  return {
    ok: true,
    platform,
    restored_from: backupName,
    safety_backup: currentBackup,
  };
}
