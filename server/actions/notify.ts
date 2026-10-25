import fs from 'node:fs';
import path from 'node:path';
import { isDirectorySafe, isFileSafe, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

export interface InternalNotifyConfig {
  desktop_toast: boolean;
  webhook_url: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
}

export interface PublicNotifyConfig {
  desktop_toast: boolean;
  webhook_url: string;
  telegram_chat_id: string;
  telegram_bot_token_set: boolean;
  telegram_bot_token_masked: string | null;
}

export function loadInternalNotifyConfig(notifyCfgFile: string): InternalNotifyConfig {
  const cfg: InternalNotifyConfig = {
    desktop_toast: true,
    webhook_url: '',
    telegram_bot_token: '',
    telegram_chat_id: '',
  };
  if (isFileSafe(notifyCfgFile)) {
    try {
      const raw = fs.readFileSync(notifyCfgFile, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        cfg.desktop_toast =
          data.desktop_toast !== undefined ? Boolean(data.desktop_toast) : true;
        cfg.webhook_url = String(data.webhook_url ?? '');
        cfg.telegram_bot_token = String(data.telegram_bot_token ?? '');
        cfg.telegram_chat_id = String(data.telegram_chat_id ?? '');
      }
    } catch {
      // Keep default config if file is unreadable
    }
  }
  return cfg;
}

export function getPublicNotifyConfig(notifyCfgFile: string): PublicNotifyConfig {
  const cfg = loadInternalNotifyConfig(notifyCfgFile);
  const tok = cfg.telegram_bot_token;
  let masked: string | null = null;
  if (tok !== '') {
    masked = tok.length > 10 ? `${tok.slice(0, 6)}...${tok.slice(-4)}` : 'configured';
  }
  return {
    desktop_toast: Boolean(cfg.desktop_toast),
    webhook_url: cfg.webhook_url,
    telegram_chat_id: cfg.telegram_chat_id,
    telegram_bot_token_set: tok !== '',
    telegram_bot_token_masked: masked,
  };
}

export function handleSaveNotify(
  body: Record<string, unknown>,
  paths: ServerPaths
): Record<string, unknown> {
  const existing = loadInternalNotifyConfig(paths.notifyCfgFile);

  let tokenToSave = existing.telegram_bot_token;
  if ('telegram_bot_token' in body && body.telegram_bot_token !== null && body.telegram_bot_token !== undefined) {
    if (typeof body.telegram_bot_token !== 'string') {
      throw new ApiValidationError(
        'Invalid telegram_bot_token: must be a string or null.',
        400
      );
    }
    tokenToSave = body.telegram_bot_token.trim();
  }

  const cfg: InternalNotifyConfig = {
    desktop_toast:
      'desktop_toast' in body ? Boolean(body.desktop_toast) : existing.desktop_toast,
    webhook_url:
      'webhook_url' in body ? String(body.webhook_url ?? '').trim() : existing.webhook_url,
    telegram_bot_token: tokenToSave,
    telegram_chat_id:
      'telegram_chat_id' in body
        ? String(body.telegram_chat_id ?? '').trim()
        : existing.telegram_chat_id,
  };

  if (cfg.webhook_url !== '' && !/^https?:\/\//i.test(cfg.webhook_url)) {
    throw new ApiValidationError('Webhook URL must start with http:// or https://', 400);
  }

  const dir = path.dirname(paths.notifyCfgFile);
  if (!isDirectorySafe(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(cfg, null, 2), 'utf8');

  return {
    ok: true,
    notify_config: getPublicNotifyConfig(paths.notifyCfgFile),
  };
}

export async function handleTestNotify(paths: ServerPaths): Promise<Record<string, unknown>> {
  const notifyScript = path.win32.join(paths.scriptsDir, 'send-notification.ps1');
  if (!isFileSafe(notifyScript)) {
    throw new ApiValidationError('send-notification.ps1 not found.', 500);
  }

  const res = await runCommand(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      notifyScript,
      '-Title',
      'Multi-AI Mission Control',
      '-Message',
      'Test notification from Mission Control Dashboard succeeded!',
      '-Status',
      'success',
      '-TestOnly',
    ],
    { timeoutMs: 20000 }
  );

  const out = (res.stdout || res.stderr).trim();
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(out) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  return {
    ok: true,
    result: parsed ?? {
      desktop_sent: false,
      webhook_configured: false,
      webhook_sent: false,
      telegram_configured: false,
      telegram_sent: false,
      errors: { raw: out },
    },
  };
}

export function triggerJobFinishedNotification(
  paths: ServerPaths,
  projectName: string,
  mode: string,
  role: string,
  exitCode: number
): void {
  const notifyScript = path.win32.join(paths.scriptsDir, 'send-notification.ps1');
  if (!isFileSafe(notifyScript)) {
    return;
  }
  const cfg = loadInternalNotifyConfig(paths.notifyCfgFile);
  const anyEnabled =
    cfg.desktop_toast ||
    cfg.webhook_url.trim() !== '' ||
    (cfg.telegram_bot_token.trim() !== '' && cfg.telegram_chat_id.trim() !== '');
  if (!anyEnabled) {
    return;
  }

  const st = exitCode === 0 ? 'success' : 'warn';
  void runCommand(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      notifyScript,
      '-Title',
      `Mission Control: ${projectName}`,
      '-Message',
      `Job ${mode} (${role}) finished with exit code ${exitCode}.`,
      '-Status',
      st,
    ],
    { timeoutMs: 15000 }
  );
}
