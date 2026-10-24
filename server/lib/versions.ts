import fs from 'node:fs';
import path from 'node:path';
import { getTempDir, isDirectorySafe, isFileSafe } from './paths.ts';
import { runCommand } from './proc.ts';

export interface DetectedToolVersions {
  claude: string | null;
  codex: string | null;
  node: string;
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
  const cacheFile = path.win32.join(getTempDir(), 'maw_tool_versions_cache_v2.json');
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 3600_000) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
      if (cached && 'claude' in cached && 'codex' in cached) {
        return {
          claude: typeof cached.claude === 'string' ? cached.claude : null,
          codex: typeof cached.codex === 'string' ? cached.codex : null,
          node: nodeVer,
        };
      }
    }
  } catch {
    // Cache miss or expired
  }

  let claudeVer: string | null = null;
  const claudeTry = await runCommand('claude.exe', ['--version'], { timeoutMs: 4000 });
  claudeVer = extractSemver(claudeTry.stdout || claudeTry.stderr);
  if (!claudeVer) {
    const claudeBase = path.win32.join(userProfile, 'AppData', 'Roaming', 'Claude', 'claude-code');
    const exes = findClaudeExecutables(claudeBase);
    if (exes.length > 0) {
      const r = await runCommand(exes[0]!, ['--version'], { timeoutMs: 4000 });
      claudeVer = extractSemver(r.stdout || r.stderr);
    }
  }

  let codexVer: string | null = null;
  const codexJs = path.win32.join(
    userProfile,
    'AppData',
    'Roaming',
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
  }
  if (!codexVer) {
    const r = await runCommand('codex.exe', ['--version'], { timeoutMs: 4000 });
    codexVer = extractSemver(r.stdout || r.stderr);
  }
  if (!codexVer) {
    const ps1 = path.win32.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.ps1');
    if (isFileSafe(ps1)) {
      const r = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '--version'],
        { timeoutMs: 5000 }
      );
      codexVer = extractSemver(r.stdout || r.stderr);
    }
  }

  const payload = { claude: claudeVer, codex: codexVer };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8');
  } catch {
    // Ignore cache write errors
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
