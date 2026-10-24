import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';

import { validateSafeRelativePath } from '../review/git.ts';

export const DEFAULT_EDITOR = ['code', '--goto', '{file}:{line}'];

const VSCODE_FAMILY_EXES = [
  'Code.exe',
  'Code - Insiders.exe',
  'Cursor.exe',
  'Windsurf.exe',
  'VSCodium.exe',
];

export function validateEditorConfig(editorRaw: unknown): string[] {
  if (!Array.isArray(editorRaw)) {
    throw new ApiValidationError('editor must be an array of strings.', 400);
  }
  if (editorRaw.length < 1 || editorRaw.length > 16) {
    throw new ApiValidationError('editor must have between 1 and 16 items.', 400);
  }

  const result: string[] = [];
  let hasFilePlaceholder = false;

  for (let i = 0; i < editorRaw.length; i++) {
    const item = editorRaw[i];
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new ApiValidationError(`editor[${i}] must be a string without NUL bytes.`, 400);
    }
    if (item.length > 500) {
      throw new ApiValidationError(`editor[${i}] exceeds 500 characters limit.`, 400);
    }
    if (i === 0 && item.trim() === '') {
      throw new ApiValidationError('First editor command item cannot be empty.', 400);
    }
    if (item.includes('{file}')) {
      hasFilePlaceholder = true;
    }
    result.push(item);
  }

  if (!hasFilePlaceholder) {
    throw new ApiValidationError("At least one editor argument must contain '{file}'.", 400);
  }

  return result;
}

export function loadEditorConfig(paths: ServerPaths): string[] {
  const configFile = path.win32.join(paths.featureDataDir('files'), 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const raw = fs.readFileSync(configFile, 'utf8');
      const parsed = JSON.parse(raw) as { editor?: unknown };
      if (parsed && Array.isArray(parsed.editor)) {
        return validateEditorConfig(parsed.editor);
      }
    } catch {
      // Fallback on corrupt file
    }
  }
  return [...DEFAULT_EDITOR];
}

export function saveEditorConfig(editor: string[], paths: ServerPaths): void {
  const validated = validateEditorConfig(editor);
  const dataDir = paths.featureDataDir('files');
  const configFile = path.win32.join(dataDir, 'config.json');
  const tmpFile = path.win32.join(
    dataDir,
    `.tmp_cfg_${crypto.randomBytes(4).toString('hex')}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify({ editor: validated }, null, 2), 'utf8');
  fs.renameSync(tmpFile, configFile);
}

export function resolveEditorExe(
  cmd: string,
  options?: {
    envPath?: string;
    envPathExt?: string;
    fileExists?: (p: string) => boolean;
  }
): string {
  const fileExists = options?.fileExists ?? fs.existsSync;
  const envPath = options?.envPath ?? process.env.PATH ?? '';
  const rawPathExt = options?.envPathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const pathExts = rawPathExt
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const trimmedCmd = cmd.trim();

  // Helper to check shim real exe
  const checkShimRealExe = (shimPath: string): string | null => {
    const shimDir = path.win32.dirname(shimPath);
    for (const exeName of VSCODE_FAMILY_EXES) {
      const candidate = path.win32.resolve(shimDir, '..', exeName);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  // 1. If absolute path
  if (path.win32.isAbsolute(trimmedCmd) || /^[a-zA-Z]:/.test(trimmedCmd)) {
    const lower = trimmedCmd.toLowerCase();
    if (lower.endsWith('.exe') && fileExists(trimmedCmd)) {
      return trimmedCmd;
    }
    if ((lower.endsWith('.cmd') || lower.endsWith('.bat')) && fileExists(trimmedCmd)) {
      const realExe = checkShimRealExe(trimmedCmd);
      if (realExe) {
        return realExe;
      }
    }
    throw new ApiValidationError(
      `Editor '${trimmedCmd}' was not found as an .exe. Set its full path in Files → Editor.`,
      400
    );
  }

  // 2. Search PATH x PATHEXT
  const pathDirs = envPath.split(path.delimiter).map((d) => d.trim()).filter(Boolean);

  const hasExt = /\.[a-zA-Z0-9]+$/.test(trimmedCmd);

  for (const dir of pathDirs) {
    if (hasExt) {
      const candidate = path.win32.join(dir, trimmedCmd);
      if (fileExists(candidate)) {
        const lower = candidate.toLowerCase();
        if (lower.endsWith('.exe')) {
          return candidate;
        }
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
          const realExe = checkShimRealExe(candidate);
          if (realExe) {
            return realExe;
          }
          throw new ApiValidationError(
            `Editor '${trimmedCmd}' was not found as an .exe. Set its full path in Files → Editor.`,
            400
          );
        }
      }
    } else {
      // Prioritize .exe first, then other extensions
      const sortedExts = ['.exe', ...pathExts.filter((e) => e !== '.exe')];
      for (const ext of sortedExts) {
        const candidate = path.win32.join(dir, `${trimmedCmd}${ext}`);
        if (fileExists(candidate)) {
          const lower = candidate.toLowerCase();
          if (lower.endsWith('.exe')) {
            return candidate;
          }
          if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
            const realExe = checkShimRealExe(candidate);
            if (realExe) {
              return realExe;
            }
            throw new ApiValidationError(
              `Editor '${trimmedCmd}' was not found as an .exe. Set its full path in Files → Editor.`,
              400
            );
          }
        }
      }
    }
  }

  throw new ApiValidationError(
    `Editor '${trimmedCmd}' was not found as an .exe. Set its full path in Files → Editor.`,
    400
  );
}

export function openFileInEditor(options: {
  projectPath: string;
  relPath: string;
  line?: number;
  paths: ServerPaths;
  spawnFn?: (exe: string, args: string[]) => void;
}): { ok: true; command: string[] } {
  const { projectPath, relPath, line, paths, spawnFn } = options;
  const validRelPath = validateSafeRelativePath(projectPath, relPath);
  const realProject = fs.realpathSync(projectPath);
  const fullFilePath = path.win32.join(realProject, validRelPath.replace(/\//g, '\\'));

  if (!fs.existsSync(fullFilePath)) {
    throw new ApiValidationError('File not found.', 404);
  }

  const config = loadEditorConfig(paths);
  const exeCmd = config[0]!;
  const exePath = resolveEditorExe(exeCmd);
  const lineNumber = typeof line === 'number' && line >= 1 ? line : 1;

  const resolvedArgs: string[] = [];
  for (let i = 1; i < config.length; i++) {
    const rawArg = config[i]!;
    const replaced = rawArg
      .replace(/\{file\}/g, fullFilePath)
      .replace(/\{line\}/g, String(lineNumber))
      .replace(/\{dir\}/g, realProject);
    resolvedArgs.push(replaced);
  }

  const finalCommand = [exePath, ...resolvedArgs];

  if (spawnFn) {
    spawnFn(exePath, resolvedArgs);
  } else {
    try {
      const child = spawn(exePath, resolvedArgs, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      });
      child.on('error', () => {
        // async spawn error must never crash the server
      });
      child.unref();
    } catch (err: unknown) {
      throw new ApiValidationError(
        `Failed to spawn editor: ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  }

  return {
    ok: true,
    command: finalCommand,
  };
}
