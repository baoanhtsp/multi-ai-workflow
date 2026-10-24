import type { McpServerConfig } from './types.ts';

export function maskEnvValue(val: string): string {
  const s = String(val ?? '');
  if (s.length <= 6) {
    return '••••';
  }
  return '••••' + s.slice(-2);
}

export function isMaskedValue(val: string): boolean {
  return typeof val === 'string' && val.startsWith('••••');
}

export function maskAllEnvsInToml(tomlContent: string): string {
  const lines = tomlContent.split(/\r?\n/);
  const outLines: string[] = [];
  let inEnvSubTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Header for [mcp_servers.<name>.env]
    const headerMatch = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\.env\s*\]/.exec(trimmed);
    if (headerMatch) {
      inEnvSubTable = true;
      outLines.push(line);
      continue;
    }

    // Any other table header
    if (trimmed.startsWith('[')) {
      inEnvSubTable = false;
      outLines.push(line);
      continue;
    }

    if (inEnvSubTable) {
      const kvMatch = /^(\s*[A-Za-z0-9_.-]+\s*=\s*)(.+)$/.exec(line);
      if (kvMatch) {
        const prefix = kvMatch[1]!;
        const rawVal = kvMatch[2]!.trim();
        const strVal = parseTomlString(rawVal);
        outLines.push(`${prefix}${JSON.stringify(maskEnvValue(strVal))}`);
        continue;
      }
    }

    outLines.push(line);
  }

  return outLines.join('\n');
}

export function maskAllEnvsInJson(jsonContent: string): string {
  if (!jsonContent.trim()) return jsonContent;
  let doc: unknown;
  try {
    doc = JSON.parse(jsonContent);
  } catch {
    return jsonContent;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return jsonContent;
  }
  const root = doc as Record<string, unknown>;
  if (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)) {
    const mcpServers = root.mcpServers as Record<string, unknown>;
    for (const [_sName, sDef] of Object.entries(mcpServers)) {
      if (sDef && typeof sDef === 'object' && !Array.isArray(sDef)) {
        const defObj = sDef as Record<string, unknown>;
        if (defObj.env && typeof defObj.env === 'object' && !Array.isArray(defObj.env)) {
          const envObj = defObj.env as Record<string, unknown>;
          for (const [k, v] of Object.entries(envObj)) {
            envObj[k] = maskEnvValue(String(v ?? ''));
          }
        }
      }
    }
  }
  return JSON.stringify(root, null, 2) + '\n';
}

export function parseCodexTomlMcp(tomlContent: string): McpServerConfig[] {
  const lines = tomlContent.split(/\r?\n/);
  const serversMap = new Map<string, McpServerConfig>();

  let currentServer: McpServerConfig | null = null;
  let inEnv = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Check table header: [mcp_servers.<name>] or [mcp_servers.<name>.env] or other
    const headerMatch = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\]/.exec(trimmed);
    if (headerMatch) {
      const serverName = headerMatch[1]!;
      const subTable = headerMatch[2];

      let s = serversMap.get(serverName);
      if (!s) {
        s = {
          name: serverName,
          transport: 'stdio',
          args: [],
          env: {},
          extra: {},
        };
        serversMap.set(serverName, s);
      }
      currentServer = s;
      inEnv = subTable === 'env';
      continue;
    }

    // Any other table header ends the current server
    if (trimmed.startsWith('[')) {
      currentServer = null;
      inEnv = false;
      continue;
    }

    if (!currentServer) {
      continue;
    }

    // Key-value pair: KEY = VALUE
    const kvMatch = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!kvMatch) {
      continue;
    }

    const key = kvMatch[1]!;
    const rawVal = kvMatch[2]!.trim();

    if (inEnv) {
      const parsedVal = parseTomlString(rawVal);
      currentServer.env = currentServer.env ?? {};
      currentServer.env[key] = parsedVal;
      continue;
    }

    // Server-level keys
    if (key === 'command') {
      currentServer.command = parseTomlString(rawVal);
      currentServer.transport = 'stdio';
    } else if (key === 'args') {
      currentServer.args = parseTomlStringArray(rawVal);
    } else if (key === 'url') {
      currentServer.url = parseTomlString(rawVal);
      currentServer.transport = 'http';
    } else {
      // Platform-specific extra keys (startup_timeout_sec, env_vars, etc.)
      currentServer.extra = currentServer.extra ?? {};
      currentServer.extra[key] = parseTomlLiteral(rawVal);
    }
  }

  return Array.from(serversMap.values());
}

function parseTomlString(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1)}"` : s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseTomlStringArray(raw: string): string[] {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      const inner = s.slice(1, -1);
      return inner
        .split(',')
        .map((x) => parseTomlString(x.trim()))
        .filter(Boolean);
    }
  }
  return [];
}

function parseTomlLiteral(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    return parseTomlStringArray(s);
  }
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  return parseTomlString(s);
}

function arraysEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

interface TomlSection {
  type: 'preamble' | 'other_table' | 'server_primary' | 'server_subtable';
  serverName?: string;
  subTable?: string;
  headerLine?: string;
  lines: string[];
}

export function updateCodexTomlMcp(
  originalToml: string,
  options: {
    set?: McpServerConfig[];
    remove?: string[];
    existingServers?: McpServerConfig[];
    maskEnv?: boolean;
  }
): string {
  const removeNames = new Set((options.remove ?? []).map((x) => x.toLowerCase()));
  const setMap = new Map<string, McpServerConfig>();
  for (const s of options.set ?? []) {
    setMap.set(s.name.toLowerCase(), s);
  }

  // If nothing to set and nothing to remove, return original verbatim
  if (setMap.size === 0 && removeNames.size === 0) {
    return options.maskEnv ? maskAllEnvsInToml(originalToml) : originalToml;
  }

  const existingMap = new Map<string, McpServerConfig>();
  for (const s of options.existingServers ?? []) {
    existingMap.set(s.name.toLowerCase(), s);
  }

  // Parse original TOML into sections
  const rawLines = originalToml.split(/\r?\n/);
  const sections: TomlSection[] = [];
  let currentSection: TomlSection = {
    type: 'preamble',
    lines: [],
  };
  sections.push(currentSection);

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const match = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\]/.exec(trimmed);
      if (match) {
        const sName = match[1]!.toLowerCase();
        const sub = match[2];
        currentSection = {
          type: sub ? 'server_subtable' : 'server_primary',
          serverName: sName,
          subTable: sub,
          headerLine: line,
          lines: [],
        };
        sections.push(currentSection);
      } else {
        currentSection = {
          type: 'other_table',
          headerLine: line,
          lines: [],
        };
        sections.push(currentSection);
      }
    } else {
      currentSection.lines.push(line);
    }
  }

  const outputLines: string[] = [];
  const placedSetServers = new Set<string>();

  for (const section of sections) {
    if (section.type === 'preamble' || section.type === 'other_table') {
      if (section.headerLine !== undefined) {
        outputLines.push(section.headerLine);
      }
      outputLines.push(...section.lines);
      continue;
    }

    const sName = section.serverName!;
    // If server is marked for removal, drop all its sections
    if (removeNames.has(sName)) {
      continue;
    }

    // If server is in set, update it in place where primary table appears
    if (setMap.has(sName)) {
      const newServer = setMap.get(sName)!;
      const existingServer = existingMap.get(sName);

      if (section.type === 'server_primary') {
        placedSetServers.add(sName);

        // Header: preserve original headerLine or standard header
        outputLines.push(section.headerLine ?? `[mcp_servers.${newServer.name}]`);

        // Check if an .env subtable exists in this file for this server
        const hasExistingEnvSubtable = sections.some(
          (sec) => sec.type === 'server_subtable' && sec.serverName === sName && sec.subTable === 'env'
        );

        // Track handled keys in primary section
        const handledKeys = new Set<string>();
        const renderedLines: string[] = [];

        for (const line of section.lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            // Keep empty lines and comments exactly in place (Item 1c)
            renderedLines.push(line);
            continue;
          }
          const kvMatch = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
          if (!kvMatch) {
            renderedLines.push(line);
            continue;
          }
          const key = kvMatch[1]!;
          const rawVal = kvMatch[2]!;

          if (key === 'command') {
            handledKeys.add('command');
            if (newServer.transport === 'http' || newServer.url) {
              continue; // Replaced by url
            }
            const origCmd = parseTomlString(rawVal);
            if (origCmd === (newServer.command ?? 'node')) {
              // Value unchanged: keep original line verbatim (single-quotes, etc.)
              renderedLines.push(line);
            } else {
              renderedLines.push(`command = ${JSON.stringify(newServer.command ?? 'node')}`);
            }
          } else if (key === 'args') {
            handledKeys.add('args');
            if (newServer.transport === 'http' || newServer.url) {
              continue;
            }
            const origArgs = parseTomlStringArray(rawVal);
            if (arraysEqual(origArgs, newServer.args ?? [])) {
              renderedLines.push(line);
            } else {
              const argsList = (newServer.args ?? []).map((a) => JSON.stringify(a)).join(', ');
              renderedLines.push(`args = [${argsList}]`);
            }
          } else if (key === 'url') {
            handledKeys.add('url');
            if (newServer.transport !== 'http' && !newServer.url) {
              continue;
            }
            const origUrl = parseTomlString(rawVal);
            if (origUrl === (newServer.url ?? '')) {
              renderedLines.push(line);
            } else {
              renderedLines.push(`url = ${JSON.stringify(newServer.url ?? '')}`);
            }
          } else if (newServer.extra && key in newServer.extra) {
            handledKeys.add(key);
            const origVal = parseTomlLiteral(rawVal);
            if (valuesEqual(origVal, newServer.extra[key])) {
              renderedLines.push(line);
            } else {
              renderedLines.push(`${key} = ${JSON.stringify(newServer.extra[key])}`);
            }
          } else {
            // Unmanaged key (like env_vars): keep verbatim!
            renderedLines.push(line);
          }
        }

        // Add any new managed keys that were not present in original lines
        let insertIdx = renderedLines.length;
        while (insertIdx > 0 && renderedLines[insertIdx - 1]!.trim() === '') {
          insertIdx--;
        }
        const missingLines: string[] = [];
        if (!handledKeys.has('command') && newServer.transport !== 'http' && !newServer.url && newServer.command) {
          missingLines.push(`command = ${JSON.stringify(newServer.command)}`);
        }
        if (!handledKeys.has('args') && newServer.transport !== 'http' && !newServer.url && newServer.args) {
          const argsList = newServer.args.map((a) => JSON.stringify(a)).join(', ');
          missingLines.push(`args = [${argsList}]`);
        }
        if (!handledKeys.has('url') && (newServer.transport === 'http' || newServer.url)) {
          missingLines.push(`url = ${JSON.stringify(newServer.url ?? '')}`);
        }
        if (newServer.extra) {
          for (const [k, v] of Object.entries(newServer.extra)) {
            if (!handledKeys.has(k)) {
              missingLines.push(`${k} = ${JSON.stringify(v)}`);
            }
          }
        }
        renderedLines.splice(insertIdx, 0, ...missingLines);
        outputLines.push(...renderedLines);

        // If no existing .env subtable in file, but newServer has env keys: append subtable
        if (!hasExistingEnvSubtable && newServer.env && Object.keys(newServer.env).length > 0) {
          outputLines.push(`[mcp_servers.${newServer.name}.env]`);
          for (const [ek, ev] of Object.entries(newServer.env)) {
            const finalVal = options.maskEnv ? maskEnvValue(ev) : ev;
            outputLines.push(`${ek} = ${JSON.stringify(finalVal)}`);
          }
        }
      } else if (section.type === 'server_subtable') {
        if (section.subTable === 'env') {
          // Resolve finalEnv
          const finalEnv: Record<string, string> = {};
          if (newServer.env) {
            for (const [k, v] of Object.entries(newServer.env)) {
              if (options.maskEnv) {
                finalEnv[k] = maskEnvValue(v);
              } else if (isMaskedValue(v) && existingServer?.env?.[k]) {
                finalEnv[k] = existingServer.env[k]!;
              } else {
                finalEnv[k] = v;
              }
            }
          } else if (existingServer?.env) {
            for (const [k, v] of Object.entries(existingServer.env)) {
              finalEnv[k] = options.maskEnv ? maskEnvValue(v) : v;
            }
          }

          if (Object.keys(finalEnv).length === 0) {
            // Env emptied: drop header, but preserve trailing blank lines for layout
            for (const line of section.lines) {
              if (!line.trim()) outputLines.push(line);
            }
          } else {
            if (section.headerLine !== undefined) {
              outputLines.push(section.headerLine);
            }
            const handledEnvKeys = new Set<string>();
            const envRenderedLines: string[] = [];

            for (const line of section.lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) {
                envRenderedLines.push(line);
                continue;
              }
              const kvMatch = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
              if (!kvMatch) {
                envRenderedLines.push(line);
                continue;
              }
              const k = kvMatch[1]!;
              const rawVal = kvMatch[2]!;

              if (k in finalEnv) {
                handledEnvKeys.add(k);
                const targetVal = finalEnv[k]!;
                const origVal = parseTomlString(rawVal);
                if (origVal === targetVal || (options.maskEnv && isMaskedValue(origVal) && isMaskedValue(targetVal))) {
                  // Unchanged: keep line verbatim!
                  envRenderedLines.push(line);
                } else {
                  envRenderedLines.push(`${k} = ${JSON.stringify(targetVal)}`);
                }
              }
            }

            // Append any new env keys
            let insertIdx = envRenderedLines.length;
            while (insertIdx > 0 && envRenderedLines[insertIdx - 1]!.trim() === '') {
              insertIdx--;
            }
            const missingEnvLines: string[] = [];
            for (const [k, v] of Object.entries(finalEnv)) {
              if (!handledEnvKeys.has(k)) {
                missingEnvLines.push(`${k} = ${JSON.stringify(v)}`);
              }
            }
            envRenderedLines.splice(insertIdx, 0, ...missingEnvLines);
            outputLines.push(...envRenderedLines);
          }
        } else {
          // Other custom subtable: preserve verbatim!
          if (section.headerLine !== undefined) {
            outputLines.push(section.headerLine);
          }
          outputLines.push(...section.lines);
        }
      }
      continue;
    }

    // Untouched server: preserve verbatim!
    if (section.headerLine !== undefined) {
      outputLines.push(section.headerLine);
    }
    outputLines.push(...section.lines);
  }

  // Append new servers in `set` that were not already in the file
  const brandNewServers: string[] = [];
  for (const newServer of options.set ?? []) {
    const sName = newServer.name.toLowerCase();
    if (placedSetServers.has(sName)) {
      continue;
    }

    const sLines: string[] = [];
    sLines.push(`[mcp_servers.${newServer.name}]`);
    if (newServer.transport === 'http' || newServer.url) {
      sLines.push(`url = ${JSON.stringify(newServer.url ?? '')}`);
    } else {
      sLines.push(`command = ${JSON.stringify(newServer.command ?? 'node')}`);
      const argsList = (newServer.args ?? []).map((a) => JSON.stringify(a)).join(', ');
      sLines.push(`args = [${argsList}]`);
    }

    if (newServer.extra) {
      for (const [k, v] of Object.entries(newServer.extra)) {
        sLines.push(`${k} = ${JSON.stringify(v)}`);
      }
    }

    const finalEnv: Record<string, string> = {};
    if (newServer.env) {
      for (const [k, v] of Object.entries(newServer.env)) {
        finalEnv[k] = options.maskEnv ? maskEnvValue(v) : v;
      }
    }

    if (Object.keys(finalEnv).length > 0) {
      sLines.push('');
      sLines.push(`[mcp_servers.${newServer.name}.env]`);
      for (const [k, v] of Object.entries(finalEnv)) {
        sLines.push(`${k} = ${JSON.stringify(v)}`);
      }
    }

    brandNewServers.push(sLines.join('\n'));
  }

  let result = outputLines.join('\n').trimEnd();
  if (brandNewServers.length > 0) {
    if (result) {
      result += '\n\n' + brandNewServers.join('\n\n') + '\n';
    } else {
      result = brandNewServers.join('\n\n') + '\n';
    }
  } else if (result) {
    result += '\n';
  }

  return result;
}
