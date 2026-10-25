import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getAuditStats } from '../lib/audit.ts';
import {
  createFeatureContext,
  type MawFeature,
  type RegisteredFeatureRoute,
} from '../lib/feature.ts';
import { getTempDir, isDirectorySafe, isFileSafe, type ServerPaths } from '../lib/paths.ts';
import { loadAgentRegistry } from '../lib/registry.ts';
import { detectRegistryAgents, getCodexModels, getDetectedToolVersions } from '../lib/versions.ts';
import { getProjectGitInfo } from './git.ts';
import { getRecentJobs } from './jobs.ts';
import { getPublicNotifyConfig } from './notify.ts';

function formatLocalDateTime(ms: number, includeSeconds: boolean): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function probeTcpOnline(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host || '127.0.0.1');
  });
}

export async function getBridgeStatus(bridgeFile: string): Promise<Record<string, unknown>> {
  if (!isFileSafe(bridgeFile)) {
    return {
      online: false,
      ls_address: null,
      csrf_masked: null,
      ls_version: null,
      updated_at: null,
    };
  }

  let data: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(bridgeFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid JSON');
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return {
      online: false,
      ls_address: null,
      csrf_masked: null,
      ls_version: null,
      updated_at: null,
    };
  }

  const lsAddress = String(data.ANTIGRAVITY_LS_ADDRESS ?? '');
  const csrf = String(data.ANTIGRAVITY_CSRF_TOKEN ?? '');
  const csrfMasked =
    csrf.length > 12
      ? `${csrf.slice(0, 8)}...${csrf.slice(-4)}`
      : csrf !== ''
        ? 'configured'
        : null;

  let online = false;
  if (lsAddress !== '' && lsAddress.includes(':')) {
    const idx = lsAddress.lastIndexOf(':');
    const host = lsAddress.slice(0, idx);
    const portNum = Number.parseInt(lsAddress.slice(idx + 1), 10);
    if (Number.isInteger(portNum) && portNum > 0 && portNum <= 65535) {
      online = await probeTcpOnline(host || '127.0.0.1', portNum, 250);
    }
  }

  let fallbackUpdatedAt: string | null = null;
  try {
    fallbackUpdatedAt = new Date(fs.statSync(bridgeFile).mtimeMs).toISOString();
  } catch {
    fallbackUpdatedAt = null;
  }

  return {
    online,
    ls_address: lsAddress || null,
    csrf_masked: csrfMasked,
    ls_version: data.ANTIGRAVITY_LS_VERSION ?? null,
    updated_at: data.UpdatedAt ?? fallbackUpdatedAt,
  };
}

function loadLineCountCache(tempDir?: string): Record<string, number> {
  const cacheFile = path.win32.join(tempDir || getTempDir(), 'agy_dashboard_linecache.json');
  if (!isFileSafe(cacheFile)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, number>;
    }
  } catch {
    // Ignore corrupt cache
  }
  return {};
}

function saveLineCountCache(cache: Record<string, number>, tempDir?: string): void {
  const cacheFile = path.win32.join(tempDir || getTempDir(), 'agy_dashboard_linecache.json');
  const keys = Object.keys(cache);
  let trimmed = cache;
  if (keys.length > 64) {
    trimmed = {};
    for (const k of keys.slice(-64)) {
      trimmed[k] = cache[k]!;
    }
  }
  const tmpFile = `${cacheFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(trimmed), 'utf8');
    fs.renameSync(tmpFile, cacheFile);
  } catch {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
  }
}

function readTailLines(
  filePath: string,
  lineCache: Record<string, number>,
  maxBytes = 65536
): { total_lines: number; lines: string[] } {
  if (!isFileSafe(filePath)) {
    return { total_lines: 0, lines: [] };
  }
  let size = 0;
  let mtimeSec = 0;
  try {
    const st = fs.statSync(filePath);
    size = st.size;
    mtimeSec = Math.trunc(st.mtimeMs / 1000);
  } catch {
    return { total_lines: 0, lines: [] };
  }
  if (size <= 0) {
    return { total_lines: 0, lines: [] };
  }

  const cacheKey = `${filePath}|${mtimeSec}|${size}`;
  const fd = fs.openSync(filePath, 'r');
  let totalLines = 0;
  let tailRaw = '';

  try {
    if (typeof lineCache[cacheKey] === 'number') {
      totalLines = lineCache[cacheKey]!;
    } else {
      const chunkBuf = Buffer.alloc(65536);
      let pos = 0;
      while (pos < size) {
        const n = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, pos);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) {
          if (chunkBuf[i] === 0x0a) totalLines++;
        }
        pos += n;
      }
      lineCache[cacheKey] = totalLines;
    }

    const readLen = Math.min(size, maxBytes);
    const tailBuf = Buffer.alloc(readLen);
    const nRead = fs.readSync(fd, tailBuf, 0, readLen, size - readLen);
    tailRaw = tailBuf.subarray(0, nRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  if (size > maxBytes) {
    const firstNl = tailRaw.indexOf('\n');
    if (firstNl !== -1) {
      tailRaw = tailRaw.slice(firstNl + 1);
    }
  }

  const lines = tailRaw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');

  return {
    total_lines: Math.max(totalLines, lines.length),
    lines,
  };
}

export function getConversations(
  presenceDir: string,
  brainDir: string,
  lineCache: Record<string, number>
): Array<Record<string, unknown>> {
  const activeLocks: Array<{ cid: string; mtimeMs: number }> = [];
  const nowMs = Date.now();

  if (isDirectorySafe(presenceDir)) {
    try {
      for (const name of fs.readdirSync(presenceDir)) {
        if (!name.endsWith('.lock')) continue;
        const cid = name.slice(0, -5);
        const lockPath = path.win32.join(presenceDir, name);
        try {
          const mtimeMs = fs.statSync(lockPath).mtimeMs;
          if (mtimeMs > 0 && nowMs - mtimeMs < 1800_000) {
            activeLocks.push({ cid, mtimeMs });
          }
        } catch {
          // Ignore stat error
        }
      }
    } catch {
      // Ignore scan error
    }
  }
  activeLocks.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const candidates = new Map<string, { id: string; is_active: boolean; mtimeMs: number }>();
  for (const lock of activeLocks) {
    candidates.set(lock.cid, { id: lock.cid, is_active: true, mtimeMs: lock.mtimeMs });
  }

  if (isDirectorySafe(brainDir)) {
    try {
      const dirs: Array<{ cid: string; mtimeMs: number }> = [];
      for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name || entry.name.startsWith('.')) continue;
        const full = path.win32.join(brainDir, entry.name);
        try {
          dirs.push({ cid: entry.name, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // Ignore stat error
        }
      }
      dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const d of dirs.slice(0, 8)) {
        if (!candidates.has(d.cid)) {
          candidates.set(d.cid, { id: d.cid, is_active: false, mtimeMs: d.mtimeMs });
        }
      }
    } catch {
      // Ignore scan error
    }
  }

  const result: Array<Record<string, unknown>> = [];
  for (const item of [...candidates.values()].slice(0, 8)) {
    const cid = item.id;
    const transcript = path.win32.join(
      brainDir,
      cid,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    let stepCount = 0;
    let lastStatus = 'IDLE';
    let lastPreview = '';
    let mtimeMs = item.mtimeMs;
    let isActive = item.is_active;

    if (isFileSafe(transcript)) {
      try {
        const tMtimeMs = fs.statSync(transcript).mtimeMs;
        mtimeMs = Math.max(mtimeMs, tMtimeMs);
        if (nowMs - tMtimeMs < 600_000) {
          isActive = true;
        }
        const tailData = readTailLines(transcript, lineCache, 65536);
        stepCount = tailData.total_lines;
        for (const line of tailData.lines.slice(-15)) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (!obj || typeof obj !== 'object') continue;
            if (typeof obj.status === 'string' && obj.status !== '') {
              lastStatus = obj.status;
            }
            if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string' && obj.content.trim() !== '') {
              const text = obj.content.trim();
              const chars = [...text];
              lastPreview =
                chars.slice(0, 180).join('') + (chars.length > 180 ? '...' : '');
            }
          } catch {
            // Skip malformed JSONL line
          }
        }
      } catch {
        // Ignore transcript read error
      }
    }

    result.push({
      id: cid,
      is_active: Boolean(isActive),
      updated_at: formatLocalDateTime(mtimeMs || nowMs, true),
      step_count: stepCount,
      last_status: lastStatus,
      last_preview: lastPreview,
    });
  }

  return result;
}

export function getLocalProjects(projectsRoot: string): Array<Record<string, unknown>> {
  if (!isDirectorySafe(projectsRoot)) {
    return [];
  }
  const projects: Array<{
    name: string;
    path: string;
    has_git: boolean;
    has_spec: boolean;
    has_gemini_md: boolean;
    updated_at: string;
  }> = [];

  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name || entry.name.startsWith('.')) continue;
      const dir = path.win32.join(projectsRoot, entry.name);
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        // Use current time fallback
      }
      projects.push({
        name: entry.name,
        path: dir,
        has_git: isDirectorySafe(path.win32.join(dir, '.git')),
        has_spec: isFileSafe(path.win32.join(dir, 'SPEC.md')),
        has_gemini_md: isFileSafe(path.win32.join(dir, 'GEMINI.md')),
        updated_at: formatLocalDateTime(mtimeMs, false),
      });
    }
  } catch {
    return [];
  }

  projects.sort((a, b) => {
    if (a.name === 'multi-ai-workflow') return -1;
    if (b.name === 'multi-ai-workflow') return 1;
    return b.updated_at.localeCompare(a.updated_at);
  });

  return projects;
}

export async function handleStatus(
  paths: ServerPaths,
  loadedFeatures: MawFeature[] = [],
  ctxOptions?: {
    routes?: Map<string, RegisteredFeatureRoute>;
    serverUrl?: string;
  }
): Promise<Record<string, unknown>> {
  const lineCache = loadLineCountCache(paths.tempDir);
  const conversations = getConversations(paths.presenceDir, paths.brainDir, lineCache);
  saveLineCountCache(lineCache, paths.tempDir);

  const registry = loadAgentRegistry(paths);
  const codexModels = getCodexModels(paths.userProfile);
  const projects = getLocalProjects(paths.projectsRoot);
  const defaultProjectPath = String(projects[0]?.path ?? paths.repoRoot);

  const [bridge, detectedVersions, gitInfo, jobs] = await Promise.all([
    getBridgeStatus(paths.bridgeFile),
    getDetectedToolVersions(paths.userProfile),
    getProjectGitInfo(defaultProjectPath),
    getRecentJobs(paths.jobsDir),
  ]);

  const detectedAgentsMap = await detectRegistryAgents(paths, registry.allAgents, detectedVersions);

  const agentsPayload = registry.allAgents.map((entry) => {
    const det = detectedAgentsMap.get(entry.id) ?? { installed: false, version: null };
    let models = [...entry.models];
    if (entry.id === 'codex') {
      for (const cm of codexModels) {
        if (!models.includes(cm)) {
          models.push(cm);
        }
      }
    }
    return {
      id: entry.id,
      label: entry.label,
      color: entry.color,
      adapter: entry.adapter,
      enabled: entry.enabled,
      installed: det.installed,
      version: det.version,
      models,
      efforts: [...entry.efforts],
      login_cmd: entry.login_cmd ? [...entry.login_cmd] : null,
      status_cmd: entry.status_cmd ? [...entry.status_cmd] : null,
      resume_args: entry.resume_args ? [...entry.resume_args] : null,
      context_window: entry.context_window ?? null,
      policy_args: entry.policy_args ? { ...entry.policy_args } : null,
      capabilities: { ...entry.capabilities },
    };
  });

  const featureList = ['agents', 'sse', 'registry', 'chat-resume'];
  const featureData: Record<string, unknown> = {};
  const featureErrors: Record<string, string> = {};
  const uiFeatures: Array<{ name: string; script: string; style?: string }> = [];
  const featCtx = createFeatureContext(paths, registry, ctxOptions);

  for (const feat of loadedFeatures) {
    if (!featureList.includes(feat.name)) {
      featureList.push(feat.name);
    }
    if (typeof feat.status === 'function') {
      try {
        featureData[feat.name] = await feat.status(featCtx);
      } catch (err: unknown) {
        featureErrors[feat.name] = err instanceof Error ? err.message : String(err);
      }
    }
    if (feat.ui) {
      const scriptName = feat.ui.script;
      if (
        /^feat-[a-z0-9-]+\.js$/.test(scriptName) &&
        isFileSafe(path.win32.join(paths.dashboardDir, scriptName))
      ) {
        const uiEntry: { name: string; script: string; style?: string } = {
          name: feat.name,
          script: scriptName,
        };
        if (
          feat.ui.style &&
          /^feat-[a-z0-9-]+\.css$/.test(feat.ui.style) &&
          isFileSafe(path.win32.join(paths.dashboardDir, feat.ui.style))
        ) {
          uiEntry.style = feat.ui.style;
        }
        uiFeatures.push(uiEntry);
      }
    }
  }

  const claudeStatus = detectedAgentsMap.get('claude') ?? {
    installed: isDirectorySafe(path.win32.join(paths.userProfile, '.claude')),
    version: detectedVersions.claude,
  };
  const codexStatus = detectedAgentsMap.get('codex') ?? {
    installed: isDirectorySafe(path.win32.join(paths.userProfile, '.codex')),
    version: detectedVersions.codex,
  };
  const agyStatus = detectedAgentsMap.get('antigravity') ?? {
    installed: isFileSafe(path.win32.join(paths.antigravityDir, 'bin', 'agentapi.bat')),
    version: null,
  };

  return {
    ok: true,
    api_version: '4.0',
    features: featureList,
    feature_data: featureData,
    feature_errors: featureErrors,
    ui_features: uiFeatures,
    timestamp: new Date().toISOString(),
    user_profile: paths.userProfile,
    bridge,
    agents: agentsPayload,
    defaults: registry.defaults,
    registry_warnings: registry.warnings,
    tools: {
      antigravity: {
        installed: agyStatus.installed,
        model: 'Gemini 4 Argon (High)',
        models: [
          'gemini-4-argon-high',
          'gemini-4-argon-medium',
          'gemini-4-argon-low',
          'gemini-3.8-flash-high',
          'gemini-3.8-flash-medium',
          'gemini-3.7-flash-high',
          'gemini-3.5-flash-lite',
        ],
        cli_models: ['pro', 'flash', 'flash_lite'],
        command: '/multi-ai (alias: /claude-leader)',
        role_summary:
          'Backend/Core Dev, Multi-Subagent Branch Coordinator & Context Filter',
      },
      claude: {
        installed: claudeStatus.installed,
        version: claudeStatus.version,
        models: [
          'claude-opus-5-5',
          'claude-sonnet-5-5',
          'claude-haiku-5-5',
          'claude-fable-5-1',
          'claude-opus-4-6',
          'claude-sonnet-4-6',
          'claude-haiku-4-5',
        ],
        cli_models: [
          'opus',
          'sonnet',
          'haiku',
          'fable',
          'claude-opus-5-5',
          'claude-sonnet-5-5',
          'claude-haiku-5-5',
          'claude-fable-5-1',
          'claude-opus-4-8',
          'claude-opus-4-7',
          'claude-opus-4-6',
          'claude-sonnet-4-6',
          'claude-haiku-4-5',
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        command: '/multi-ai (alias: /antigravity)',
        role_summary: 'Tech Lead, 100% Frontend UI Specialist & Code Grader',
      },
      codex: {
        installed: codexStatus.installed,
        version: codexStatus.version,
        model: 'gpt-6-sol (high)',
        models: codexModels,
        cli_models: codexModels,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        command: '$multi-ai (alias: $multi-ai-leader)',
        role_summary:
          'Security/Logic Critic, Native Diff Reviewer & Algorithm Coder',
      },
      node: {
        installed: true,
        version: detectedVersions.node,
      },
    },
    conversations,
    projects,
    git_info: gitInfo,
    notify_config: getPublicNotifyConfig(paths.notifyCfgFile),
    jobs,
    audit: getAuditStats(paths.auditFile),
  };
}
