import path from 'node:path';
import { isFileSafe, resolveProjectPath, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

export async function handleSpecGuard(
  body: Record<string, unknown>,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const rawPath = String(body.project_path ?? paths.repoRoot).trim();
  const validPath = resolveProjectPath(rawPath, paths.projectsRoot);
  if (validPath === null) {
    throw new ApiValidationError('Invalid project_path.', 400);
  }

  const owner = String(body.owner ?? '').trim().toLowerCase();
  if (!['', 'antigravity', 'claude', 'codex'].includes(owner)) {
    throw new ApiValidationError(
      'Invalid owner. Allowed: antigravity, claude, codex, or empty.',
      400
    );
  }

  const guardScript = path.win32.join(paths.scriptsDir, 'invoke-spec-guard.ps1');
  if (!isFileSafe(guardScript)) {
    throw new ApiValidationError('invoke-spec-guard.ps1 not found.', 500);
  }

  const args: string[] = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    guardScript,
    '-WorkDir',
    validPath,
  ];
  if (owner !== '') {
    args.push('-Owner', owner);
  }
  args.push('-Json');

  const res = await runCommand('powershell.exe', args, { timeoutMs: 25000 });
  const out = (res.stdout || res.stderr).trim();
  try {
    const parsed = JSON.parse(out) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to 500
  }

  const err = new ApiValidationError('Failed to parse SPEC Guard output.', 500);
  (err as unknown as Record<string, unknown>).raw = out;
  throw err;
}
