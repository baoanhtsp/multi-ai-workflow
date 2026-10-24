import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handleSpecGuard } from '../../../actions/specGuard.ts';
import type { ServerPaths } from '../../../lib/paths.ts';
import { ApiValidationError } from '../../../lib/validate.ts';
import {
  isPathInsideProject,
  readAuditRows,
  readJsonSafe,
  redactSecrets,
  writeJsonAtomic,
} from '../../policy/lib/s4-core.ts';

// ============================================================================
// 1. Interfaces
// ============================================================================

export interface CheckItem {
  id: string;
  label: string;
  command: string[];
  timeout_s?: number;
  required?: boolean;
  cwd?: string;
  command_sha?: string;
}

export interface ChecksConfig {
  version: number;
  checks: CheckItem[];
  todo_patterns?: string[];
  todo_max?: number;
  require_clean_git?: boolean;
  min_review_score?: number;
  spec_guard?: boolean;
}

export interface CheckRunResult {
  id: string;
  label: string;
  state: 'pass' | 'fail' | 'warn' | 'skip' | 'running' | 'untrusted' | 'timeout';
  exit_code: number;
  duration_ms: number;
  output_tail: string;
  at: string;
  head: string;
  dirty_signature?: string;
  command_sha?: string;
}

export function createCheckRunResult(
  check: CheckItem,
  res: {
    state: 'pass' | 'fail' | 'warn' | 'skip' | 'running' | 'untrusted' | 'timeout';
    exit_code?: number | null;
    duration_ms?: number;
    output_tail?: string;
  },
  gitInfo: { head: string },
  dirtySig: string,
  at?: string
): CheckRunResult {
  return {
    id: check.id,
    label: check.label || check.id,
    state: res.state,
    exit_code: res.exit_code ?? 0,
    duration_ms: res.duration_ms ?? 0,
    output_tail: res.output_tail ?? '',
    at: at || new Date().toISOString(),
    head: gitInfo.head,
    dirty_signature: dirtySig,
    command_sha: check.command_sha || computeCheckCommandSha(check),
  };
}

export interface GateItem {
  id: string;
  label: string;
  state:
    | 'pass'
    | 'fail'
    | 'warn'
    | 'skip'
    | 'running'
    | 'untrusted'
    | 'timeout'
    | 'stale'
    | 'pending';
  detail: string;
  at: string;
}

export interface GateResult {
  green: boolean;
  overridden?: boolean;
  items: GateItem[];
}

export interface ChecksOverride {
  token: string;
  project_path: string;
  reason: string;
  scope: 'merge' | 'review';
  expires_at: string;
}

// ============================================================================
// 2. Defaults & Validation
// ============================================================================

export function computeCheckCommandSha(check: { command: string[]; cwd?: string }): string {
  const payload = JSON.stringify({
    command: check.command,
    cwd: check.cwd || '',
  });
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex');
}

export function createDefaultChecksConfig(): ChecksConfig {
  return {
    version: 1,
    checks: [],
    todo_patterns: ['TODO', 'FIXME', 'XXX', 'HACK'],
    todo_max: 0,
    require_clean_git: false,
    min_review_score: 8.5,
    spec_guard: true,
  };
}

export function validateChecksConfig(
  raw: unknown,
  projectPath?: string
): {
  config: ChecksConfig;
  warnings: string[];
  errorField?: string;
  errorMessage?: string;
} {
  const defaults = createDefaultChecksConfig();
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: defaults,
      warnings: ['Invalid checks config: not an object.'],
      errorField: 'config',
      errorMessage: 'Config must be an object',
    };
  }

  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : 1;

  if (!Array.isArray(obj.checks)) {
    return {
      config: defaults,
      warnings: ['Invalid checks: must be an array.'],
      errorField: 'checks',
      errorMessage: 'checks must be an array',
    };
  }

  if (obj.checks.length > 20) {
    return {
      config: defaults,
      warnings: ['At most 20 checks allowed.'],
      errorField: 'checks',
      errorMessage: 'At most 20 checks allowed',
    };
  }

  const validatedChecks: CheckItem[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < obj.checks.length; i++) {
    const c = obj.checks[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return {
        config: defaults,
        warnings,
        errorField: `checks[${i}]`,
        errorMessage: `checks[${i}] must be an object`,
      };
    }

    const cObj = c as Record<string, unknown>;
    const id = String(cObj.id || '').trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
      return {
        config: defaults,
        warnings,
        errorField: `checks[${i}].id`,
        errorMessage: `checks[${i}].id must match ^[a-z][a-z0-9_-]{0,31}$`,
      };
    }
    if (seenIds.has(id)) {
      return {
        config: defaults,
        warnings,
        errorField: `checks[${i}].id`,
        errorMessage: `checks[${i}].id "${id}" is duplicate`,
      };
    }
    seenIds.add(id);

    const label = String(cObj.label || id).trim();

    if (!Array.isArray(cObj.command) || cObj.command.length === 0) {
      return {
        config: defaults,
        warnings,
        errorField: `checks[${i}].command`,
        errorMessage: `checks[${i}].command must be a non-empty array of strings`,
      };
    }
    if (cObj.command.length > 64) {
      return {
        config: defaults,
        warnings,
        errorField: `checks[${i}].command`,
        errorMessage: `checks[${i}].command at most 64 arguments allowed`,
      };
    }

    const cmdStrings: string[] = [];
    for (let aIdx = 0; aIdx < cObj.command.length; aIdx++) {
      const arg = cObj.command[aIdx];
      if (typeof arg !== 'string') {
        return {
          config: defaults,
          warnings,
          errorField: `checks[${i}].command[${aIdx}]`,
          errorMessage: `checks[${i}].command[${aIdx}] must be a string`,
        };
      }
      if (arg.length > 1000) {
        return {
          config: defaults,
          warnings,
          errorField: `checks[${i}].command[${aIdx}]`,
          errorMessage: `checks[${i}].command[${aIdx}] must be <= 1000 characters`,
        };
      }
      if (arg.includes('\0')) {
        return {
          config: defaults,
          warnings,
          errorField: `checks[${i}].command[${aIdx}]`,
          errorMessage: `checks[${i}].command[${aIdx}] must not contain NUL bytes`,
        };
      }
      cmdStrings.push(arg);
    }

    let timeout_s = 600;
    if (cObj.timeout_s !== undefined) {
      const t = Number(cObj.timeout_s);
      if (Number.isNaN(t) || t < 5 || t > 3600) {
        return {
          config: defaults,
          warnings,
          errorField: `checks[${i}].timeout_s`,
          errorMessage: `checks[${i}].timeout_s must be between 5 and 3600`,
        };
      }
      timeout_s = Math.round(t);
    }

    const required = cObj.required !== undefined ? Boolean(cObj.required) : true;
    let cwd: string | undefined;
    if (cObj.cwd !== undefined && typeof cObj.cwd === 'string' && cObj.cwd.trim().length > 0) {
      const normCwd = cObj.cwd.trim();
      if (projectPath) {
        const resolvedCwd = path.resolve(projectPath, normCwd);
        if (!isPathInsideProject(resolvedCwd, projectPath)) {
          return {
            config: defaults,
            warnings,
            errorField: `checks[${i}].cwd`,
            errorMessage: `checks[${i}].cwd escapes the project`,
          };
        }
        if (fs.existsSync(resolvedCwd)) {
          try {
            const realProj = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : projectPath;
            const realCwd = fs.realpathSync(resolvedCwd);
            if (!isPathInsideProject(realCwd, realProj)) {
              return {
                config: defaults,
                warnings,
                errorField: `checks[${i}].cwd`,
                errorMessage: `checks[${i}].cwd escapes the project`,
              };
            }
          } catch {
            // Ignore if realpath fails
          }
        }
      }
      cwd = normCwd;
    }

    const checkItem: CheckItem = {
      id,
      label,
      command: cmdStrings,
      timeout_s,
      required,
      ...(cwd ? { cwd } : {}),
    };
    checkItem.command_sha = computeCheckCommandSha(checkItem);
    validatedChecks.push(checkItem);
  }

  let todo_patterns = defaults.todo_patterns;
  if (obj.todo_patterns !== undefined) {
    if (!Array.isArray(obj.todo_patterns)) {
      return {
        config: defaults,
        warnings,
        errorField: 'todo_patterns',
        errorMessage: 'todo_patterns must be an array of strings',
      };
    }
    todo_patterns = obj.todo_patterns.map((p) => String(p).trim()).filter(Boolean);
  }

  let todo_max = defaults.todo_max ?? 0;
  if (obj.todo_max !== undefined) {
    const tm = Number(obj.todo_max);
    if (Number.isNaN(tm) || tm < -1) {
      return {
        config: defaults,
        warnings,
        errorField: 'todo_max',
        errorMessage: 'todo_max must be an integer >= -1',
      };
    }
    todo_max = Math.floor(tm);
  }

  const require_clean_git =
    obj.require_clean_git !== undefined ? Boolean(obj.require_clean_git) : defaults.require_clean_git;

  let min_review_score = defaults.min_review_score ?? 8.5;
  if (obj.min_review_score !== undefined) {
    const mrs = Number(obj.min_review_score);
    if (Number.isNaN(mrs) || mrs < 0) {
      return {
        config: defaults,
        warnings,
        errorField: 'min_review_score',
        errorMessage: 'min_review_score must be a number >= 0',
      };
    }
    min_review_score = mrs;
  }

  const spec_guard = obj.spec_guard !== undefined ? Boolean(obj.spec_guard) : defaults.spec_guard;

  return {
    config: {
      version,
      checks: validatedChecks,
      todo_patterns,
      todo_max,
      require_clean_git,
      min_review_score,
      spec_guard,
    },
    warnings,
  };
}

// ============================================================================
// 3. Project Config Detection (`checks_detect`)
// ============================================================================

export function detectChecks(projectPath: string): ChecksConfig {
  const detected: CheckItem[] = [];

  // 1. package.json
  const pkgFile = path.win32.join(projectPath, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const scripts = pkg.scripts || {};
      if (typeof scripts.typecheck === 'string') {
        detected.push({
          id: 'typecheck',
          label: 'npm run typecheck',
          command: ['npm', 'run', 'typecheck'],
          timeout_s: 300,
          required: true,
        });
      }
      if (typeof scripts.lint === 'string') {
        detected.push({
          id: 'lint',
          label: 'npm run lint',
          command: ['npm', 'run', 'lint'],
          timeout_s: 300,
          required: false,
        });
      }
      if (typeof scripts.test === 'string') {
        detected.push({
          id: 'test',
          label: 'npm test',
          command: ['npm', 'test'],
          timeout_s: 900,
          required: true,
        });
      }
    } catch {
      // Ignore
    }
  }

  // 2. PHP / phpunit
  const composerFile = path.win32.join(projectPath, 'composer.json');
  const phpunitBin = path.win32.join(projectPath, 'vendor', 'bin', 'phpunit');
  const phpunitBat = path.win32.join(projectPath, 'vendor', 'bin', 'phpunit.bat');
  if (fs.existsSync(composerFile) || fs.existsSync(phpunitBin) || fs.existsSync(phpunitBat)) {
    detected.push({
      id: 'phpunit',
      label: 'phpunit',
      command: ['vendor/bin/phpunit'],
      timeout_s: 900,
      required: true,
      cwd: '.',
    });
  }

  // 3. Python pytest
  const pytestIni = path.win32.join(projectPath, 'pytest.ini');
  const pyprojectToml = path.win32.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pytestIni) || fs.existsSync(pyprojectToml)) {
    detected.push({
      id: 'pytest',
      label: 'pytest',
      command: ['pytest'],
      timeout_s: 600,
      required: true,
    });
  }

  // 4. Rust Cargo.toml
  const cargoToml = path.win32.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoToml)) {
    detected.push({
      id: 'cargo_test',
      label: 'cargo test',
      command: ['cargo', 'test'],
      timeout_s: 900,
      required: true,
    });
  }

  // 5. Go go.mod
  const goMod = path.win32.join(projectPath, 'go.mod');
  if (fs.existsSync(goMod)) {
    detected.push({
      id: 'go_test',
      label: 'go test ./...',
      command: ['go', 'test', './...'],
      timeout_s: 600,
      required: true,
    });
  }

  return {
    version: 1,
    checks: detected,
    todo_patterns: ['TODO', 'FIXME', 'XXX', 'HACK'],
    todo_max: 0,
    require_clean_git: false,
    min_review_score: 8.5,
    spec_guard: true,
  };
}

// ============================================================================
// 4. Trust Store
// ============================================================================

export function getProjectChecksSha256(projectPath: string): { sha256: string; content: string } | null {
  const configFile = path.win32.join(projectPath, '.maw', 'checks.json');
  try {
    const content = fs.readFileSync(configFile, 'utf8');
    const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    return { sha256, content };
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return null;
    }
    // Re-throw so callers can distinguish ENOENT from other read errors
    throw err;
  }
}

export function isProjectChecksTrusted(
  paths: ServerPaths,
  projectPath: string,
  currentSha256: string
): boolean {
  const trustedFile = path.win32.join(paths.featureDataDir('checks'), 'trusted.json');
  const trustedMap = readJsonSafe<Record<string, string>>(trustedFile, {}).data;
  const normKey = projectPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return trustedMap[normKey] === currentSha256;
}

export function trustProjectChecks(
  paths: ServerPaths,
  projectPath: string,
  sha256: string
): void {
  const trustedFile = path.win32.join(paths.featureDataDir('checks'), 'trusted.json');
  const trustedMap = readJsonSafe<Record<string, string>>(trustedFile, {}).data;
  const normKey = projectPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  trustedMap[normKey] = sha256;
  writeJsonAtomic(trustedFile, trustedMap);
}

// ============================================================================
// 5. Command Resolution & Execution (No shell, ever)
// ============================================================================

export interface ResolvedCommand {
  type: 'exe' | 'shim' | 'cmd' | 'ps1' | 'not_found';
  file: string;
  args: string[];
}

export function resolveCommandTarget(
  cmd: string,
  args: string[],
  cwd: string
): ResolvedCommand {
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.ps1')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  let targetPath = '';
  const hasSlash = path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');

  // 1. Direct or relative file with extension
  if (hasSlash) {
    const resolved = path.resolve(cwd, cmd);
    if (fs.existsSync(resolved)) {
      targetPath = resolved;
    }
  }

  // 2. PATH resolution
  if (!targetPath && !hasSlash) {
    const envPath = (process.env.PATH || '').split(path.delimiter);
    const hasExt = pathext.some((ext) => cmd.toLowerCase().endsWith(ext));

    for (const dir of envPath) {
      if (!dir) continue;
      if (hasExt) {
        const candidate = path.join(dir, cmd);
        if (fs.existsSync(candidate)) {
          targetPath = candidate;
          break;
        }
      } else {
        for (const ext of pathext) {
          const candidate = path.join(dir, `${cmd}${ext}`);
          if (fs.existsSync(candidate)) {
            targetPath = candidate;
            break;
          }
        }
        if (targetPath) break;
      }
    }
  }

  if (!targetPath) {
    if (!hasSlash) {
      return {
        type: 'not_found',
        file: cmd,
        args,
      };
    }
    // If not found, default to direct invocation of cmd
    targetPath = cmd;
  }

  const ext = path.extname(targetPath).toLowerCase();

  if (ext === '.ps1') {
    return {
      type: 'ps1',
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', targetPath, ...args],
    };
  }

  if (ext === '.cmd' || ext === '.bat') {
    const baseName = path.basename(targetPath, ext).toLowerCase();
    // Check for npm / npx / pnpm / yarn shims
    if (baseName === 'npm' || baseName === 'npx' || baseName === 'pnpm' || baseName === 'yarn') {
      const dir = path.dirname(targetPath);
      let entryJs = '';
      if (baseName === 'npm') {
        const candidate1 = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const candidate2 = path.join(dir, 'npm-cli.js');
        if (fs.existsSync(candidate1)) entryJs = candidate1;
        else if (fs.existsSync(candidate2)) entryJs = candidate2;
      } else if (baseName === 'npx') {
        const candidate1 = path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
        const candidate2 = path.join(dir, 'npx-cli.js');
        if (fs.existsSync(candidate1)) entryJs = candidate1;
        else if (fs.existsSync(candidate2)) entryJs = candidate2;
      } else if (baseName === 'pnpm') {
        const candidate1 = path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
        const candidate2 = path.join(dir, 'pnpm.cjs');
        if (fs.existsSync(candidate1)) entryJs = candidate1;
        else if (fs.existsSync(candidate2)) entryJs = candidate2;
      } else if (baseName === 'yarn') {
        const candidate1 = path.join(dir, 'node_modules', 'yarn', 'bin', 'yarn.js');
        const candidate2 = path.join(dir, 'yarn.js');
        if (fs.existsSync(candidate1)) entryJs = candidate1;
        else if (fs.existsSync(candidate2)) entryJs = candidate2;
      }

      if (entryJs) {
        return {
          type: 'shim',
          file: process.execPath,
          args: [entryJs, ...args],
        };
      }
    }

    // Other .cmd / .bat
    return {
      type: 'cmd',
      file: targetPath,
      args,
    };
  }

  // Default .exe or .com or other binaries
  return {
    type: 'exe',
    file: targetPath,
    args,
  };
}

export async function runCheckProcess(
  check: CheckItem,
  projectPath: string,
  onSpawn?: (child: child_process.ChildProcess) => void
): Promise<{
  state: 'pass' | 'fail' | 'warn' | 'timeout';
  exit_code: number;
  duration_ms: number;
  output_tail: string;
}> {
  const startTime = Date.now();
  const cwd = check.cwd ? path.resolve(projectPath, check.cwd) : projectPath;
  if (!isPathInsideProject(cwd, projectPath)) {
    return {
      state: 'fail',
      exit_code: 1,
      duration_ms: Date.now() - startTime,
      output_tail: `[S4:gate] cwd escapes the project: ${cwd}`,
    };
  }
  if (fs.existsSync(cwd)) {
    try {
      const realProj = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : projectPath;
      const realCwd = fs.realpathSync(cwd);
      if (!isPathInsideProject(realCwd, realProj)) {
        return {
          state: 'fail',
          exit_code: 1,
          duration_ms: Date.now() - startTime,
          output_tail: `[S4:gate] cwd escapes the project: ${realCwd}`,
        };
      }
    } catch (err: any) {
      return {
        state: 'fail',
        exit_code: 1,
        duration_ms: Date.now() - startTime,
        output_tail: `[S4:gate] cwd error: ${err?.message || String(err)}`,
      };
    }
  }
  const timeoutMs = (check.timeout_s ?? 600) * 1000;

  const cmd0 = check.command[0]!;
  const rawArgs = check.command.slice(1);

  const resolved = resolveCommandTarget(cmd0, rawArgs, cwd);

  if (resolved.type === 'not_found') {
    return {
      state: check.required ? 'fail' : 'warn',
      exit_code: 1,
      duration_ms: 0,
      output_tail: `command not found on PATH: ${cmd0}`,
    };
  }

  // If it's a .cmd or .bat that couldn't be resolved as a shim:
  if (resolved.type === 'cmd') {
    if (!/^[A-Za-z0-9_\-.:\\/]+$/.test(resolved.file)) {
      return {
        state: 'fail',
        exit_code: 1,
        duration_ms: 0,
        output_tail: 'unsafe path for a .cmd script',
      };
    }

    // Check safe argument pattern: ^[A-Za-z0-9_\-.:/\\=@+,]*$
    const safeArgRegex = /^[A-Za-z0-9_\-.:/\\=@+,]*$/;
    for (const arg of resolved.args) {
      if (!safeArgRegex.test(arg)) {
        return {
          state: check.required ? 'fail' : 'warn',
          exit_code: 1,
          duration_ms: Date.now() - startTime,
          output_tail: 'unsafe argument for a .cmd script',
        };
      }
    }
  }

  let spawnFile = resolved.file;
  let spawnArgs = resolved.args;

  if (resolved.type === 'cmd') {
    spawnFile = 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', resolved.file, ...resolved.args];
  }

  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let child: child_process.ChildProcess;

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      child = child_process.spawn(spawnFile, spawnArgs, {
        cwd,
        shell: false,
        windowsHide: true,
      });

      if (onSpawn) {
        onSpawn(child);
      }
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      resolve({
        state: check.required ? 'fail' : 'warn',
        exit_code: 1,
        duration_ms: Date.now() - startTime,
        output_tail: redactSecrets(`Failed to spawn: ${msg}`),
      });
      return;
    }

    const appendChunk = (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > 128 * 1024) {
        const combined = Buffer.concat(chunks);
        chunks.length = 0;
        const tail = combined.subarray(combined.length - 64 * 1024);
        chunks.push(tail);
        totalBytes = tail.length;
      }
    };

    if (child.stdout) child.stdout.on('data', appendChunk);
    if (child.stderr) child.stderr.on('data', appendChunk);

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          child_process.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
          });
        } catch {
          // Ignore
        }
      }
    }, timeoutMs);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const duration_ms = Date.now() - startTime;
      const rawOut = Buffer.concat(chunks).toString('utf8');
      const tail = rawOut.slice(-64 * 1024);
      resolve({
        state: check.required ? 'fail' : 'warn',
        exit_code: 1,
        duration_ms,
        output_tail: redactSecrets(`${tail}\n${err.message}`),
      });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const duration_ms = Date.now() - startTime;
      const rawOut = Buffer.concat(chunks).toString('utf8');
      const tail = rawOut.slice(-64 * 1024);
      const redacted = redactSecrets(tail);

      if (timedOut) {
        resolve({
          state: 'timeout',
          exit_code: 124,
          duration_ms,
          output_tail: redacted || 'timed out after ' + (check.timeout_s ?? 600) + 's',
        });
        return;
      }

      const exitCode = code ?? 0;
      if (exitCode === 0) {
        resolve({
          state: 'pass',
          exit_code: 0,
          duration_ms,
          output_tail: redacted,
        });
      } else {
        resolve({
          state: check.required ? 'fail' : 'warn',
          exit_code: exitCode,
          duration_ms,
          output_tail: redacted,
        });
      }
    });
  });
}

// ============================================================================
// 6. Git Helpers & TODO Scanner
// ============================================================================

export function getGitInfo(projectPath: string): {
  isGit: boolean;
  branch: string;
  head: string;
  porcelainLines: string[];
} {
  try {
    const head = child_process
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectPath,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString('utf8')
      .trim();

    const branch = child_process
      .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectPath,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString('utf8')
      .trim();

    const porcelain = child_process
      .execFileSync('git', ['status', '--porcelain'], {
        cwd: projectPath,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString('utf8');

    const lines = porcelain
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      isGit: true,
      branch: branch || 'HEAD',
      head: head || '',
      porcelainLines: lines,
    };
  } catch {
    return {
      isGit: false,
      branch: '',
      head: '',
      porcelainLines: [],
    };
  }
}

export function computeDirtySignature(
  projectPathOrLines: string | string[],
  maybePorcelain?: string[]
): string {
  let projectPath = '';
  let porcelainLines: string[] = [];

  if (Array.isArray(projectPathOrLines)) {
    porcelainLines = projectPathOrLines;
  } else {
    projectPath = projectPathOrLines;
    porcelainLines = maybePorcelain || [];
  }

  if (porcelainLines.length === 0) return 'clean';

  const hasher = crypto.createHash('sha1');
  hasher.update(porcelainLines.join('\n'));

  if (projectPath) {
    let diffSucceeded = false;
    let diffOutput: Buffer | string | null = null;

    // 1. Diff of tracked changes
    try {
      diffOutput = child_process.execFileSync(
        'git',
        ['diff', 'HEAD', '--no-ext-diff', '--binary'],
        {
          cwd: projectPath,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      diffSucceeded = true;
    } catch {
      try {
        diffOutput = child_process.execFileSync(
          'git',
          ['diff', '--no-ext-diff', '--binary'],
          {
            cwd: projectPath,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );
        diffSucceeded = true;
      } catch {
        diffSucceeded = false;
      }
    }

    if (!diffSucceeded || diffOutput === null) {
      // Git call failed: fail closed with a unique nonce
      return `nonce_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    }

    hasher.update(diffOutput);

    // 2. Untracked files: hash content for files <= 2 MB; size+mtime for larger
    let untrackedFiles: string[] = [];
    try {
      const untrackedRaw = child_process
        .execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: projectPath,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .toString('utf8');
      untrackedFiles = untrackedRaw
        .split(/\r?\n/)
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      // Git call failed: fail closed with a unique nonce
      return `nonce_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    }

    for (const u of untrackedFiles) {
      const absU = path.resolve(projectPath, u);
      try {
        const stat = fs.statSync(absU);
        if (stat.isFile()) {
          if (stat.size <= 2 * 1024 * 1024) {
            const content = fs.readFileSync(absU);
            const contentHash = crypto.createHash('sha1').update(content).digest('hex');
            hasher.update(`\n${u}:content:${contentHash}`);
          } else {
            // Files > 2 MB keep size+mtime (accepted trade-off to avoid large file I/O overhead)
            hasher.update(`\n${u}:${stat.size}:${stat.mtimeMs}`);
          }
        } else {
          hasher.update(`\n${u}:${stat.size}:${stat.mtimeMs}`);
        }
      } catch {
        // Any read error of an untracked file fails closed with a unique nonce
        return `nonce_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      }
    }
  }

  return hasher.digest('hex').slice(0, 16);
}

export function scanTrackedTodos(
  projectPath: string,
  patterns: string[] = ['TODO', 'FIXME', 'XXX', 'HACK']
): { count: number; matches: Array<{ file: string; line: number; text: string }> } {
  if (patterns.length === 0) return { count: 0, matches: [] };

  let trackedFiles: string[] = [];
  try {
    const raw = child_process
      .execFileSync('git', ['ls-files'], {
        cwd: projectPath,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString('utf8');
    trackedFiles = raw.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
  } catch {
    return { count: 0, matches: [] };
  }

  const escapedPatterns = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const todoRegex = new RegExp(`\\b(${escapedPatterns})\\b`);

  let count = 0;
  const matches: Array<{ file: string; line: number; text: string }> = [];

  const maxFiles = Math.min(trackedFiles.length, 5000);
  for (let i = 0; i < maxFiles; i++) {
    const relFile = trackedFiles[i]!;
    const absFile = path.resolve(projectPath, relFile);

    try {
      const stat = fs.statSync(absFile);
      if (stat.size > 512 * 1024) continue;

      const fd = fs.openSync(absFile, 'r');
      const headBuf = Buffer.alloc(Math.min(stat.size, 8000));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.closeSync(fd);

      // Binary check: if contains NUL byte, skip
      if (headBuf.includes(0)) continue;

      const content = fs.readFileSync(absFile, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const lineText = lines[lineNum]!;
        if (todoRegex.test(lineText)) {
          count++;
          if (matches.length < 20) {
            matches.push({
              file: relFile.replace(/\\/g, '/'),
              line: lineNum + 1,
              text: lineText.trim().slice(0, 100),
            });
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return { count, matches };
}

// ============================================================================
// 7. Gate Computation (`computeGate`)
// ============================================================================

export async function computeGate(
  paths: ServerPaths,
  projectPath: string,
  config: ChecksConfig,
  results: CheckRunResult[],
  skipSpecGuard = false,
  skipReview = false
): Promise<GateResult> {
  const items: GateItem[] = [];
  const nowIso = new Date().toISOString();

  const gitInfo = getGitInfo(projectPath);
  const currentDirtySig = computeDirtySignature(projectPath, gitInfo.porcelainLines);

  // 1. Git clean item
  if (!gitInfo.isGit) {
    items.push({
      id: 'git',
      label: 'Git clean',
      state: 'skip',
      detail: 'not a git repository',
      at: nowIso,
    });
  } else if (gitInfo.porcelainLines.length === 0) {
    items.push({
      id: 'git',
      label: 'Git clean',
      state: 'pass',
      detail: 'working tree clean',
      at: nowIso,
    });
  } else {
    const count = gitInfo.porcelainLines.length;
    if (config.require_clean_git) {
      items.push({
        id: 'git',
        label: 'Git clean',
        state: 'fail',
        detail: `${count} uncommitted change(s)`,
        at: nowIso,
      });
    } else {
      items.push({
        id: 'git',
        label: 'Git clean',
        state: 'warn',
        detail: `${count} uncommitted change(s)`,
        at: nowIso,
      });
    }
  }

  // 2. Each check item
  const resultMap = new Map<string, CheckRunResult>();
  for (const r of results) {
    resultMap.set(r.id, r);
  }

  for (const c of config.checks) {
    const r = resultMap.get(c.id);
    if (!r) {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: c.required ? 'pending' : 'warn',
        detail: 'never run',
        at: nowIso,
      });
      continue;
    }

    if (r.state === 'running') {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: 'running',
        detail: 'running...',
        at: r.at || nowIso,
      });
      continue;
    }

    // Staleness check (Item 6 & Item 7)
    // A stored check result WITHOUT command_sha must be treated as stale (no legacy pass).
    const currentCommandSha = c.command_sha || computeCheckCommandSha(c);
    const isStale =
      !r.command_sha ||
      r.command_sha !== currentCommandSha ||
      (gitInfo.isGit &&
        (r.head !== gitInfo.head || r.dirty_signature !== currentDirtySig));

    if (isStale) {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: c.required ? 'stale' : 'warn',
        detail: 'stale, re-run',
        at: r.at || nowIso,
      });
    } else if (r.state === 'timeout') {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: c.required ? 'timeout' : 'warn',
        detail: `timed out after ${c.timeout_s ?? 600}s`,
        at: r.at || nowIso,
      });
    } else if (r.exit_code === 0) {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: 'pass',
        detail: `passed (${r.duration_ms}ms)`,
        at: r.at || nowIso,
      });
    } else {
      items.push({
        id: c.id,
        label: c.label || c.id,
        state: c.required ? 'fail' : 'warn',
        detail: `exit code ${r.exit_code}`,
        at: r.at || nowIso,
      });
    }
  }

  // 3. spec_guard item
  if (skipSpecGuard) {
    // Skipped by caller (e.g. before-review hook)
  } else if (!config.spec_guard) {
    items.push({
      id: 'spec_guard',
      label: 'SPEC Guard',
      state: 'skip',
      detail: 'disabled in config',
      at: nowIso,
    });
  } else {
    const specMdFile = path.win32.join(projectPath, 'SPEC.md');
    if (!fs.existsSync(specMdFile)) {
      items.push({
        id: 'spec_guard',
        label: 'SPEC Guard',
        state: 'skip',
        detail: 'no SPEC.md',
        at: nowIso,
      });
    } else {
      try {
        const specResult = (await handleSpecGuard(
          { project_path: projectPath, owner: '' },
          paths
        )) as Record<string, unknown>;

        const isOk = specResult.ok === true;
        const violations = Array.isArray(specResult.violations) ? specResult.violations : [];
        if (isOk && violations.length === 0) {
          items.push({
            id: 'spec_guard',
            label: 'SPEC Guard',
            state: 'pass',
            detail: 'SPEC ok',
            at: nowIso,
          });
        } else {
          items.push({
            id: 'spec_guard',
            label: 'SPEC Guard',
            state: 'fail',
            detail: `${violations.length} violation(s)`,
            at: nowIso,
          });
        }
      } catch (err) {
        items.push({
          id: 'spec_guard',
          label: 'SPEC Guard',
          state: 'fail',
          detail: err instanceof Error ? err.message : 'SPEC Guard failed',
          at: nowIso,
        });
      }
    }
  }

  // 4. review item
  if (skipReview) {
    // Skipped by caller (e.g. before-review hook)
  } else {
    const minScore = config.min_review_score ?? 8.5;
    if (minScore === 0) {
      items.push({
        id: 'review',
        label: 'Last review score',
        state: 'skip',
        detail: 'min score is 0 (ignored)',
        at: nowIso,
      });
    } else {
      // Find latest review from ledger or audit
      let lastReview: { verdict?: string; score?: number } | null = null;
      const ledgerFile = path.win32.join(paths.featureDataDir('budget'), 'ledger.jsonl');

      if (fs.existsSync(ledgerFile)) {
        try {
          const lines = fs
            .readFileSync(ledgerFile, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .reverse();

          for (const l of lines) {
            const row = JSON.parse(l);
            if (row.project_path && isPathInsideProject(projectPath, row.project_path)) {
              if (row.review && typeof row.review.score === 'number') {
                lastReview = { verdict: row.review.verdict, score: row.review.score };
                break;
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      if (!lastReview && fs.existsSync(paths.auditFile)) {
        const { rows } = readAuditRows(paths.auditFile, 0);
        const revRows = rows.filter(
          (r) =>
            r.Role === 'reviewer' &&
            r.WorkDir &&
            isPathInsideProject(projectPath, r.WorkDir) &&
            r.Score
        );
        if (revRows.length > 0) {
          const last = revRows[revRows.length - 1]!;
          const match = /(\d+(?:\.\d+)?)\s*\/\s*10/.exec(last.Score);
          const score = match ? parseFloat(match[1]!) : undefined;
          lastReview = {
            verdict: last.Verdict || undefined,
            score,
          };
        }
      }

      if (!lastReview || lastReview.score === undefined) {
        items.push({
          id: 'review',
          label: 'Last review score',
          state: 'warn',
          detail: 'no review recorded',
          at: nowIso,
        });
      } else {
        const isApproved = (lastReview.verdict || '').toUpperCase() === 'APPROVED';
        if (lastReview.score >= minScore && isApproved) {
          items.push({
            id: 'review',
            label: 'Last review score',
            state: 'pass',
            detail: `Score ${lastReview.score}/10 (${lastReview.verdict})`,
            at: nowIso,
          });
        } else {
          items.push({
            id: 'review',
            label: 'Last review score',
            state: 'fail',
            detail: `Score ${lastReview.score}/10 < ${minScore} or not approved (${lastReview.verdict})`,
            at: nowIso,
          });
        }
      }
    }
  }

  // 5. todo item
  const todoPatterns = config.todo_patterns || ['TODO', 'FIXME', 'XXX', 'HACK'];
  const todoMax = config.todo_max ?? 0;
  if (todoPatterns.length === 0) {
    items.push({
      id: 'todo',
      label: 'Open TODOs',
      state: 'skip',
      detail: 'no patterns configured',
      at: nowIso,
    });
  } else {
    const { count, matches } = scanTrackedTodos(projectPath, todoPatterns);
    if (todoMax === -1) {
      items.push({
        id: 'todo',
        label: 'Open TODOs',
        state: count > 0 ? 'warn' : 'pass',
        detail: `${count} open TODO(s) (report only)`,
        at: nowIso,
      });
    } else if (count <= todoMax) {
      items.push({
        id: 'todo',
        label: 'Open TODOs',
        state: 'pass',
        detail: `${count} open TODO(s) (max ${todoMax})`,
        at: nowIso,
      });
    } else {
      const topDetail = matches.slice(0, 3).map((m) => `${m.file}:${m.line}`).join(', ');
      items.push({
        id: 'todo',
        label: 'Open TODOs',
        state: 'fail',
        detail: `${count} open TODO(s) exceeds max ${todoMax} (${topDetail})`,
        at: nowIso,
      });
    }
  }

  const green = !items.some(
    (it) =>
      it.state === 'fail' ||
      it.state === 'timeout' ||
      it.state === 'untrusted' ||
      it.state === 'running' ||
      it.state === 'stale' ||
      it.state === 'pending'
  );

  return {
    green,
    items,
  };
}

// ============================================================================
// 8. Result & Summary Storage Helpers
// ============================================================================

export function normProjectKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function getStoredResults(
  paths: { featureDataDir(f: string): string },
  projectPath: string
): CheckRunResult[] {
  const hash = crypto.createHash('sha1').update(normProjectKey(projectPath)).digest('hex');
  const file = path.win32.join(paths.featureDataDir('checks'), 'results', `${hash}.json`);
  return readJsonSafe<CheckRunResult[]>(file, []).data;
}

export function saveStoredResults(
  paths: { featureDataDir(f: string): string },
  projectPath: string,
  results: CheckRunResult[]
): void {
  const hash = crypto.createHash('sha1').update(normProjectKey(projectPath)).digest('hex');
  const dir = path.win32.join(paths.featureDataDir('checks'), 'results');
  const file = path.win32.join(dir, `${hash}.json`);
  writeJsonAtomic(file, results);
}

export function getLastSummary(
  paths: { featureDataDir(f: string): string }
): Record<string, { green: boolean; at: string }> {
  const file = path.win32.join(paths.featureDataDir('checks'), 'summary.json');
  return readJsonSafe<Record<string, { green: boolean; at: string }>>(file, {}).data;
}

export function saveLastSummary(
  paths: { featureDataDir(f: string): string },
  projectPath: string,
  green: boolean,
  at: string
): void {
  const file = path.win32.join(paths.featureDataDir('checks'), 'summary.json');
  const summary = getLastSummary(paths);
  const key = normProjectKey(projectPath);
  summary[key] = { green, at };

  // Limit to 20 most recent
  const keys = Object.keys(summary);
  if (keys.length > 20) {
    const sorted = keys.sort((a, b) => (summary[b]?.at || '').localeCompare(summary[a]?.at || ''));
    const trimmed: Record<string, { green: boolean; at: string }> = {};
    for (const k of sorted.slice(0, 20)) {
      trimmed[k] = summary[k]!;
    }
    writeJsonAtomic(file, trimmed);
    return;
  }
  writeJsonAtomic(file, summary);
}
