import fs from 'node:fs';
import path from 'node:path';
import { isFileSafe, type ServerPaths } from './paths.ts';
import { getCodexModels } from './versions.ts';

export interface AgentCapabilities {
  write: boolean;
  review: boolean;
  new_session: boolean;
  sessions: boolean;
  ide_send: boolean;
}

export interface AgentDetectConfig {
  command: string;
  version_args: string[];
}

export interface AgentCliPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface AgentCliConfig {
  command: string;
  prompt_via: 'stdin' | 'file_arg' | 'arg';
  args: string[];
  role_args: Record<string, string[]>;
  model_args: string[];
  effort_args: string[];
  output: 'text' | 'gemini-json';
  max_arg_chars: number;
  pricing: AgentCliPricing;
}

export interface AgentEntry {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  adapter: 'claude' | 'codex' | 'antigravity' | 'cli';
  aliases: string[];
  detect: AgentDetectConfig;
  models: string[];
  efforts: string[];
  capabilities: AgentCapabilities;
  cli: AgentCliConfig | null;
}

export interface RegistryDefaults {
  team: {
    backend: string;
    frontend: string;
    reviewer: string;
  };
  council: string[];
  implementer: string;
}

export interface LoadedRegistry {
  version: number;
  defaults: RegistryDefaults;
  agents: AgentEntry[];
  allAgents: AgentEntry[];
  warnings: string[];
  shippedPath: string;
  userPath: string;
}

const ID_REGEX = /^[a-z][a-z0-9-]{1,23}$/;
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_ADAPTERS = new Set(['claude', 'codex', 'antigravity', 'cli']);
const ALLOWED_PROMPT_VIA = new Set(['stdin', 'file_arg', 'arg']);
const ALLOWED_CLI_OUTPUT = new Set(['text', 'gemini-json']);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function mergeRawAgentObjects(
  base: AgentEntry,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    id: base.id,
    label: base.label,
    color: base.color,
    enabled: base.enabled,
    adapter: base.adapter,
    aliases: [...base.aliases],
    detect: { ...base.detect, version_args: [...base.detect.version_args] },
    models: [...base.models],
    efforts: [...base.efforts],
    capabilities: { ...base.capabilities },
    cli: base.cli
      ? {
          ...base.cli,
          args: [...base.cli.args],
          role_args: { ...base.cli.role_args },
          model_args: [...base.cli.model_args],
          effort_args: [...base.cli.effort_args],
          pricing: { ...base.cli.pricing },
        }
      : null,
  };

  for (const [k, v] of Object.entries(override)) {
    if (v === undefined || v === null) continue;
    if (
      (k === 'capabilities' || k === 'detect' || k === 'cli') &&
      isPlainObject(v) &&
      isPlainObject(merged[k])
    ) {
      merged[k] = { ...(merged[k] as Record<string, unknown>), ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function validateAgentEntry(
  raw: unknown,
  sourceLabel: string,
  warnings: string[]
): AgentEntry | null {
  if (!isPlainObject(raw)) {
    warnings.push(`${sourceLabel}: skipped non-object agent entry.`);
    return null;
  }

  const id = String(raw.id ?? '').trim();
  if (!ID_REGEX.test(id)) {
    warnings.push(
      `${sourceLabel}: skipped entry with invalid id '${id}' (must match ^[a-z][a-z0-9-]{1,23}$).`
    );
    return null;
  }

  const label = String(raw.label ?? '').trim();
  if (!label) {
    warnings.push(`${sourceLabel}: skipped agent '${id}' with empty label.`);
    return null;
  }

  const color =
    typeof raw.color === 'string' && raw.color.trim() !== ''
      ? raw.color.trim()
      : '#64748b';
  if (!COLOR_REGEX.test(color)) {
    warnings.push(
      `${sourceLabel}: skipped agent '${id}' with invalid color '${color}'.`
    );
    return null;
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      warnings.push(
        `${sourceLabel}: skipped agent '${id}' because 'enabled' is not a boolean.`
      );
      return null;
    }
    enabled = raw.enabled;
  }

  const adapterRaw = String(raw.adapter ?? '')
    .trim()
    .toLowerCase();
  if (!ALLOWED_ADAPTERS.has(adapterRaw)) {
    warnings.push(
      `${sourceLabel}: skipped agent '${id}' with invalid adapter '${adapterRaw}'.`
    );
    return null;
  }
  const adapter = adapterRaw as AgentEntry['adapter'];

  const aliases: string[] = [];
  if (Array.isArray(raw.aliases)) {
    for (const item of raw.aliases) {
      const a = String(item ?? '')
        .trim()
        .toLowerCase();
      if (a && !aliases.includes(a)) {
        aliases.push(a);
      }
    }
  }

  let detectCmd = id;
  let detectArgs = ['--version'];
  if (isPlainObject(raw.detect)) {
    if (typeof raw.detect.command === 'string' && raw.detect.command.trim() !== '') {
      detectCmd = raw.detect.command.trim();
    }
    if (Array.isArray(raw.detect.version_args)) {
      detectArgs = raw.detect.version_args.map((x) => String(x ?? ''));
    }
  }

  const models: string[] = [];
  if (Array.isArray(raw.models)) {
    for (const m of raw.models) {
      const ms = String(m ?? '').trim();
      if (ms && !models.includes(ms)) {
        models.push(ms);
      }
    }
  }

  const efforts: string[] = [];
  if (Array.isArray(raw.efforts)) {
    for (const e of raw.efforts) {
      const es = String(e ?? '')
        .trim()
        .toLowerCase();
      if (es && !efforts.includes(es)) {
        efforts.push(es);
      }
    }
  }

  const capObj = isPlainObject(raw.capabilities) ? raw.capabilities : {};
  const capabilities: AgentCapabilities = {
    write: capObj.write !== undefined ? Boolean(capObj.write) : true,
    review: capObj.review !== undefined ? Boolean(capObj.review) : true,
    new_session: capObj.new_session !== undefined ? Boolean(capObj.new_session) : false,
    sessions: capObj.sessions !== undefined ? Boolean(capObj.sessions) : false,
    ide_send: capObj.ide_send !== undefined ? Boolean(capObj.ide_send) : false,
  };

  let cliConfig: AgentCliConfig | null = null;
  if (adapter === 'cli') {
    if (!isPlainObject(raw.cli)) {
      warnings.push(
        `${sourceLabel}: skipped CLI agent '${id}' because 'cli' block is missing.`
      );
      return null;
    }
    const cliCommand = String(raw.cli.command ?? '').trim();
    if (!cliCommand) {
      warnings.push(
        `${sourceLabel}: skipped CLI agent '${id}' because cli.command is empty.`
      );
      return null;
    }
    const promptViaRaw = String(raw.cli.prompt_via ?? '')
      .trim()
      .toLowerCase();
    if (!ALLOWED_PROMPT_VIA.has(promptViaRaw)) {
      warnings.push(
        `${sourceLabel}: skipped CLI agent '${id}' with invalid cli.prompt_via '${promptViaRaw}'.`
      );
      return null;
    }
    if (!Array.isArray(raw.cli.args)) {
      warnings.push(
        `${sourceLabel}: skipped CLI agent '${id}' because cli.args is not an array.`
      );
      return null;
    }
    const cliArgs = raw.cli.args.map((x) => String(x ?? ''));
    const roleArgs: Record<string, string[]> = {};
    if (isPlainObject(raw.cli.role_args)) {
      for (const [rk, rv] of Object.entries(raw.cli.role_args)) {
        if (Array.isArray(rv)) {
          roleArgs[rk] = rv.map((x) => String(x ?? ''));
        }
      }
    }
    const modelArgs = Array.isArray(raw.cli.model_args)
      ? raw.cli.model_args.map((x) => String(x ?? ''))
      : [];
    const effortArgs = Array.isArray(raw.cli.effort_args)
      ? raw.cli.effort_args.map((x) => String(x ?? ''))
      : [];

    const outputRaw = String(raw.cli.output ?? 'text')
      .trim()
      .toLowerCase();
    if (!ALLOWED_CLI_OUTPUT.has(outputRaw)) {
      warnings.push(
        `${sourceLabel}: skipped CLI agent '${id}' with invalid cli.output '${outputRaw}'.`
      );
      return null;
    }

    const maxArgChars =
      typeof raw.cli.max_arg_chars === 'number' && raw.cli.max_arg_chars > 0
        ? Math.trunc(raw.cli.max_arg_chars)
        : 30000;

    const pricingObj = isPlainObject(raw.cli.pricing) ? raw.cli.pricing : {};
    const inMtok = Number(pricingObj.input_per_mtok ?? 0);
    const outMtok = Number(pricingObj.output_per_mtok ?? 0);

    cliConfig = {
      command: cliCommand,
      prompt_via: promptViaRaw as AgentCliConfig['prompt_via'],
      args: cliArgs,
      role_args: roleArgs,
      model_args: modelArgs,
      effort_args: effortArgs,
      output: outputRaw as AgentCliConfig['output'],
      max_arg_chars: maxArgChars,
      pricing: {
        input_per_mtok: Number.isFinite(inMtok) ? inMtok : 0,
        output_per_mtok: Number.isFinite(outMtok) ? outMtok : 0,
      },
    };
  }

  return {
    id,
    label,
    color,
    enabled,
    adapter,
    aliases,
    detect: {
      command: detectCmd,
      version_args: detectArgs,
    },
    models,
    efforts,
    capabilities,
    cli: cliConfig,
  };
}

export function loadAgentRegistry(
  paths: ServerPaths,
  options?: { mawHome?: string }
): LoadedRegistry {
  const warnings: string[] = [];
  const skillDir = path.dirname(paths.scriptsDir);
  let shippedPath = path.win32.join(skillDir, 'agents.json');
  if (!isFileSafe(shippedPath)) {
    const repoFallback = path.win32.join(
      paths.repoRoot,
      'antigravity',
      'skills',
      'claude-leader',
      'agents.json'
    );
    if (isFileSafe(repoFallback)) {
      shippedPath = repoFallback;
    }
  }

  const mawHome =
    (options?.mawHome ?? process.env.MAW_HOME ?? '').trim() ||
    path.win32.join(paths.userProfile, '.maw');
  const userPath = path.win32.join(mawHome, 'agents.json');

  const defaults: RegistryDefaults = {
    team: {
      backend: 'antigravity',
      frontend: 'claude',
      reviewer: 'codex',
    },
    council: ['claude', 'codex'],
    implementer: 'antigravity',
  };

  const entriesMap = new Map<string, AgentEntry>();

  const applyDefaults = (rawDef: unknown): void => {
    if (!isPlainObject(rawDef)) return;
    if (isPlainObject(rawDef.team)) {
      for (const slot of ['backend', 'frontend', 'reviewer'] as const) {
        const val = String(rawDef.team[slot] ?? '')
          .trim()
          .toLowerCase();
        if (val) {
          defaults.team[slot] = val;
        }
      }
    }
    if (Array.isArray(rawDef.council)) {
      const cList = rawDef.council
        .map((x) =>
          String(x ?? '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean);
      if (cList.length > 0) {
        defaults.council = cList;
      }
    }
    if (typeof rawDef.implementer === 'string' && rawDef.implementer.trim() !== '') {
      defaults.implementer = rawDef.implementer.trim().toLowerCase();
    }
  };

  // 1. Load shipped agents.json
  if (isFileSafe(shippedPath)) {
    try {
      const rawText = fs.readFileSync(shippedPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(rawText) as unknown;
      if (!isPlainObject(parsed)) {
        throw new Error('Root JSON value must be an object.');
      }
      applyDefaults(parsed.defaults);
      if (Array.isArray(parsed.agents)) {
        const seenShipped = new Set<string>();
        for (const item of parsed.agents) {
          const valid = validateAgentEntry(item, 'shipped agents.json', warnings);
          if (!valid) continue;
          if (seenShipped.has(valid.id)) {
            warnings.push(`shipped agents.json: duplicate agent id '${valid.id}' skipped.`);
            continue;
          }
          seenShipped.add(valid.id);
          entriesMap.set(valid.id, valid);
        }
      }
    } catch (err: unknown) {
      warnings.push(
        `Failed to parse shipped agents.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    warnings.push(`Shipped agents.json not found at ${shippedPath}.`);
  }

  // Merge dynamic Codex models from ~/.codex/models_cache.json into codex entry if present
  const codexEntry = entriesMap.get('codex');
  if (codexEntry) {
    const dynamicCodex = getCodexModels(paths.userProfile);
    for (const cm of dynamicCodex) {
      if (!codexEntry.models.includes(cm)) {
        codexEntry.models.push(cm);
      }
    }
  }

  // 2. Load optional user file ($MAW_HOME/agents.json)
  if (isFileSafe(userPath)) {
    try {
      const rawUserText = fs.readFileSync(userPath, 'utf8').replace(/^\uFEFF/, '');
      const parsedUser = JSON.parse(rawUserText) as unknown;
      if (!isPlainObject(parsedUser)) {
        throw new Error('Root JSON value must be an object.');
      }
      applyDefaults(parsedUser.defaults);
      if (parsedUser.agents !== undefined) {
        if (!Array.isArray(parsedUser.agents)) {
          warnings.push(`user agents.json (${userPath}): 'agents' must be an array.`);
        } else {
          for (const uItem of parsedUser.agents) {
            if (!isPlainObject(uItem)) {
              warnings.push(`user agents.json (${userPath}): skipped non-object agent entry.`);
              continue;
            }
            const uid = String(uItem.id ?? '').trim();
            const existing = uid ? entriesMap.get(uid) : undefined;
            if (existing) {
              const mergedRaw = mergeRawAgentObjects(existing, uItem);
              const validMerged = validateAgentEntry(
                mergedRaw,
                `user agents.json (${userPath})`,
                warnings
              );
              if (validMerged) {
                entriesMap.set(validMerged.id, validMerged);
              }
            } else {
              const validNew = validateAgentEntry(
                uItem,
                `user agents.json (${userPath})`,
                warnings
              );
              if (validNew) {
                entriesMap.set(validNew.id, validNew);
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      warnings.push(
        `Ignored invalid user agents.json (${userPath}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const allAgents = [...entriesMap.values()];
  const agents = allAgents.filter((a) => a.enabled);

  return {
    version: 1,
    defaults,
    agents,
    allAgents,
    warnings,
    shippedPath,
    userPath,
  };
}

export function resolveAgentOwnersFromCell(
  cellText: string,
  registry: LoadedRegistry
): string[] {
  if (!cellText || !cellText.trim()) {
    return [];
  }
  const candidates: Array<{ id: string; phrase: string }> = [];
  for (const agent of registry.allAgents) {
    const phrases = new Set<string>([
      agent.id.toLowerCase(),
      agent.label.toLowerCase(),
      ...agent.aliases.map((a) => a.toLowerCase()),
    ]);
    for (const p of phrases) {
      if (p.trim()) {
        candidates.push({ id: agent.id, phrase: p.trim() });
      }
    }
  }
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);

  let working = cellText.toLowerCase();
  const matched = new Set<string>();
  for (const cand of candidates) {
    const escaped = cand.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g');
    if (rx.test(working)) {
      matched.add(cand.id);
      working = working.replace(rx, ' ');
    }
  }

  return registry.allAgents.filter((a) => matched.has(a.id)).map((a) => a.id);
}
