import fs from 'node:fs';
import path from 'node:path';
import { getTempDir, isDirectorySafe, isFileSafe, type ServerPaths } from './paths.ts';
import { runCommand } from './proc.ts';
import { type AgentEntry } from './registry.ts';

export interface DetectedToolVersions {
  claude: string | null;
  codex: string | null;
  node: string;
}

export interface DetectedAgentStatus {
  installed: boolean;
  version: string | null;
}

const DEFAULT_CODEX_MODELS: readonly string[] = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-reserve',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'codex-auto-review',
];

function extractSemver(raw: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._]+)?)/.exec(raw);
  return m ? m[1]! : null;
}

function findClaudeExecutables(claudeBase: string): string[] {
  const found: Array<{ file: string; mtime: number }> = [];
  if (!isDirectorySafe(claudeBase)) {
    return [];
  }
  try {
    for (const d1 of fs.readdirSync(claudeBase, { withFileTypes: true })) {
      if (!d1.isDirectory()) continue;
      const p1 = path.win32.join(claudeBase, d1.name);
      const exe1 = path.win32.join(p1, 'claude.exe');
      if (isFileSafe(exe1)) {
        const mtime = fs.statSync(exe1).mtimeMs;
        found.push({ file: exe1, mtime });
      }
      for (const d2 of fs.readdirSync(p1, { withFileTypes: true })) {
        if (!d2.isDirectory()) continue;
        const exe2 = path.win32.join(p1, d2.name, 'claude.exe');
        if (isFileSafe(exe2)) {
          const mtime = fs.statSync(exe2).mtimeMs;
          found.push({ file: exe2, mtime });
        }
      }
    }
  } catch {
    // Ignore scan errors
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((x) => x.file);
}

export async function getDetectedToolVersions(userProfile: string): Promise<DetectedToolVersions> {
  const nodeVer = process.version;
  const cacheFile = path.win32.join(getTempDir(), 'maw_tool_versions_cache_v4.json');
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 3600_000) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
      if (
        cached &&
        typeof cached.claude === 'string' &&
        cached.claude.trim() !== '' &&
        typeof cached.codex === 'string' &&
        cached.codex.trim() !== ''
      ) {
        return {
          claude: cached.claude,
          codex: cached.codex,
          node: nodeVer,
        };
      }
    }
  } catch {
    // Cache miss or expired
  }

  const roamingDirs = [path.win32.join(userProfile, 'AppData', 'Roaming')];
  const envAppData = (process.env.APPDATA ?? '').trim();
  if (envAppData && !roamingDirs.some((d) => d.toLowerCase() === envAppData.toLowerCase())) {
    roamingDirs.push(envAppData);
  }
  const envUserProf = (process.env.USERPROFILE ?? '').trim();
  if (envUserProf) {
    const envRoaming = path.win32.join(envUserProf, 'AppData', 'Roaming');
    if (!roamingDirs.some((d) => d.toLowerCase() === envRoaming.toLowerCase())) {
      roamingDirs.push(envRoaming);
    }
  }

  let claudeVer: string | null = null;
  for (const roam of roamingDirs) {
    const claudeJs = path.win32.join(
      roam,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js'
    );
    if (isFileSafe(claudeJs)) {
      const r = await runCommand(process.execPath, [claudeJs, '--version'], { timeoutMs: 4000 });
      claudeVer = extractSemver(r.stdout || r.stderr);
      if (claudeVer) break;
    }
    const claudeBase = path.win32.join(roam, 'Claude', 'claude-code');
    const exes = findClaudeExecutables(claudeBase);
    if (exes.length > 0) {
      const r = await runCommand(exes[0]!, ['--version'], { timeoutMs: 4000 });
      claudeVer = extractSemver(r.stdout || r.stderr);
      if (claudeVer) break;
    }
  }
  if (!claudeVer) {
    const claudeTry = await runCommand('claude.exe', ['--version'], { timeoutMs: 4000 });
    claudeVer = extractSemver(claudeTry.stdout || claudeTry.stderr);
  }

  let codexVer: string | null = null;
  for (const roam of roamingDirs) {
    const codexJs = path.win32.join(
      roam,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    );
    if (isFileSafe(codexJs)) {
      const r = await runCommand(process.execPath, [codexJs, '--version'], { timeoutMs: 4000 });
      codexVer = extractSemver(r.stdout || r.stderr);
      if (codexVer) break;
    }
  }
  if (!codexVer) {
    const r = await runCommand('codex.exe', ['--version'], { timeoutMs: 4000 });
    codexVer = extractSemver(r.stdout || r.stderr);
  }
  if (!codexVer) {
    for (const roam of roamingDirs) {
      const ps1 = path.win32.join(roam, 'npm', 'codex.ps1');
      if (isFileSafe(ps1)) {
        const r = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '--version'],
          { timeoutMs: 5000 }
        );
        codexVer = extractSemver(r.stdout || r.stderr);
        if (codexVer) break;
      }
    }
  }

  if (claudeVer || codexVer) {
    const payload = { claude: claudeVer, codex: codexVer };
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8');
    } catch {
      // Ignore cache write errors
    }
  }

  return {
    claude: claudeVer,
    codex: codexVer,
    node: nodeVer,
  };
}

export function getCodexModels(userProfile: string): string[] {
  const cacheFile = path.win32.join(userProfile, '.codex', 'models_cache.json');
  if (!isFileSafe(cacheFile)) {
    return [...DEFAULT_CODEX_MODELS];
  }
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw) as { models?: Array<{ slug?: unknown }> };
    if (!data || !Array.isArray(data.models) || data.models.length === 0) {
      return [...DEFAULT_CODEX_MODELS];
    }
    const slugs: string[] = [];
    for (const m of data.models) {
      if (m && typeof m.slug === 'string' && m.slug.trim() !== '') {
        if (!slugs.includes(m.slug)) {
          slugs.push(m.slug);
        }
      }
    }
    return slugs.length > 0 ? slugs : [...DEFAULT_CODEX_MODELS];
  } catch {
    return [...DEFAULT_CODEX_MODELS];
  }
}

async function detectGenericCliAgent(
  cmd: string,
  versionArgs: string[],
  userProfile: string
): Promise<DetectedAgentStatus> {
  if (!cmd || cmd.trim() === '') {
    return { installed: false, version: null };
  }

  let resolvedPath = '';
  if (isFileSafe(cmd)) {
    resolvedPath = cmd;
  } else {
    const npmCmd = path.win32.join(userProfile, 'AppData', 'Roaming', 'npm', `${cmd}.cmd`);
    if (isFileSafe(npmCmd)) {
      resolvedPath = npmCmd;
    } else {
      const whereRes = await runCommand('where.exe', [cmd], { timeoutMs: 2500 });
      if (whereRes.code === 0 && whereRes.stdout.trim() !== '') {
        const firstLine = whereRes.stdout
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l !== '');
        if (firstLine) {
          resolvedPath = firstLine;
        }
      }
    }
  }

  if (!resolvedPath) {
    return { installed: false, version: null };
  }

  if (!versionArgs || versionArgs.length === 0) {
    return { installed: true, version: null };
  }

  let version: string | null = null;
  try {
    const ext = path.extname(resolvedPath).toLowerCase();
    // If it's an npm .cmd/.ps1 shim, check if there is a direct node_modules JS entrypoint next to it
    if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
      const siblingPs1 = resolvedPath.replace(/\.(cmd|bat)$/i, '.ps1');
      let nodeJsPath = '';
      if (isFileSafe(siblingPs1)) {
        try {
          const ps1Text = fs.readFileSync(siblingPs1, 'utf8');
          const m = /\$basedir[\\/]+node_modules[\\/]+([^"'\r\n]+\.m?js)/i.exec(ps1Text);
          if (m && m[1]) {
            const candidate = path.win32.join(
              path.dirname(siblingPs1),
              'node_modules',
              m[1].replace(/\//g, '\\')
            );
            if (isFileSafe(candidate)) {
              nodeJsPath = candidate;
            }
          }
        } catch {
          // Ignore shim parse error
        }
      }

      if (nodeJsPath) {
        const r = await runCommand(process.execPath, [nodeJsPath, ...versionArgs], {
          timeoutMs: 4000,
        });
        version = extractSemver(r.stdout || r.stderr);
      } else if (ext === '.ps1') {
        const r = await runCommand(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...versionArgs],
          { timeoutMs: 4000 }
        );
        version = extractSemver(r.stdout || r.stderr);
      } else {
        const r = await runCommand('cmd.exe', ['/d', '/s', '/c', resolvedPath, ...versionArgs], {
          timeoutMs: 4000,
        });
        version = extractSemver(r.stdout || r.stderr);
      }
    } else {
      const r = await runCommand(resolvedPath, versionArgs, { timeoutMs: 4000 });
      version = extractSemver(r.stdout || r.stderr);
    }
  } catch {
    version = null;
  }

  return { installed: true, version };
}

export async function detectRegistryAgents(
  paths: ServerPaths,
  agents: AgentEntry[],
  baseVersions?: DetectedToolVersions
): Promise<Map<string, DetectedAgentStatus>> {
  const versions = baseVersions ?? (await getDetectedToolVersions(paths.userProfile));
  const result = new Map<string, DetectedAgentStatus>();

  const cacheFile = path.win32.join(getTempDir(), 'maw_agents_detect_cache_v4.json');
  let cacheData: Record<string, { ts: number; installed: boolean; version: string | null }> = {};
  try {
    if (isFileSafe(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cacheData = parsed as typeof cacheData;
      }
    }
  } catch {
    cacheData = {};
  }

  const now = Date.now();
  let cacheDirty = false;

  for (const entry of agents) {
    if (entry.adapter === 'claude' && entry.id === 'claude') {
      const installed =
        Boolean(versions.claude) || isDirectorySafe(path.win32.join(paths.userProfile, '.claude'));
      result.set(entry.id, { installed, version: versions.claude });
      continue;
    }
    if (entry.adapter === 'codex' && entry.id === 'codex') {
      const installed =
        Boolean(versions.codex) || isDirectorySafe(path.win32.join(paths.userProfile, '.codex'));
      result.set(entry.id, { installed, version: versions.codex });
      continue;
    }
    if (entry.adapter === 'antigravity' && entry.id === 'antigravity') {
      const installed = isFileSafe(path.win32.join(paths.antigravityDir, 'bin', 'agentapi.bat'));
      result.set(entry.id, { installed, version: null });
      continue;
    }

    const detectCmd = entry.detect?.command || entry.cli?.command || entry.id;
    const versionArgs = entry.detect?.version_args ?? ['--version'];
    const cacheKey = `${entry.id}|${detectCmd}|${versionArgs.join(',')}|${paths.userProfile}`;
    const cached = cacheData[cacheKey];
    if (cached && now - cached.ts < 3600_000) {
      result.set(entry.id, { installed: Boolean(cached.installed), version: cached.version ?? null });
      continue;
    }

    const detected = await detectGenericCliAgent(detectCmd, versionArgs, paths.userProfile);
    result.set(entry.id, detected);
    cacheData[cacheKey] = {
      ts: now,
      installed: detected.installed,
      version: detected.version,
    };
    cacheDirty = true;
  }

  if (cacheDirty) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(cacheData), 'utf8');
    } catch {
      // Ignore cache write errors
    }
  }

  return result;
}

