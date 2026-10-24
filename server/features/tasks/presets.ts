import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { appendAudit, badRequest, conflict, notFound, fileMutex, newId, readJson, writeJsonAtomic } from './lib.ts';

export interface TeamPreset {
  id: string;
  name: string;
  builtin: boolean;
  description: string;
  team: Record<string, string>;
  leader: string;
  implementer: string;
  reviewers: string[];
  max_fix_rounds: number;
  budget_usd: number;
  isolate: boolean;
}

function getBuiltinPresets(ctx: MawFeatureContext): TeamPreset[] {
  const defaults = ctx.registry?.defaults;
  const enabledAgents = new Set(
    (ctx.registry?.agents ?? []).filter((a) => a.enabled).map((a) => a.id)
  );

  const defaultTeam: Record<string, string> = {
    backend: defaults?.team?.backend ?? 'antigravity',
    frontend: defaults?.team?.frontend ?? 'claude',
    reviewer: defaults?.team?.reviewer ?? 'codex',
  };

  const councilReviewers = Array.isArray(defaults?.council) && defaults.council.length > 0
    ? defaults.council
    : ['claude', 'codex'];

  const strictCouncilReviewers = ['claude', 'codex', 'antigravity'].filter((id) =>
    enabledAgents.has(id)
  );
  if (strictCouncilReviewers.length === 0) {
    strictCouncilReviewers.push(...councilReviewers);
  }

  return [
    {
      id: 'default',
      name: 'Default team',
      builtin: true,
      description: 'Standard multi-agent team from registry defaults',
      team: defaultTeam,
      leader: defaultTeam.frontend || 'claude',
      implementer: defaultTeam.backend || 'antigravity',
      reviewers: councilReviewers,
      max_fix_rounds: 2,
      budget_usd: 0,
      isolate: false,
    },
    {
      id: 'solo-claude',
      name: 'Solo Claude',
      builtin: true,
      description: 'Autonomous execution solely by Claude',
      team: { backend: 'claude', frontend: 'claude', reviewer: 'claude' },
      leader: 'claude',
      implementer: 'claude',
      reviewers: ['claude'],
      max_fix_rounds: 2,
      budget_usd: 0,
      isolate: false,
    },
    {
      id: 'strict-council',
      name: 'Strict council',
      builtin: true,
      description: 'Triple-reviewer council with worktree isolation',
      team: defaultTeam,
      leader: defaultTeam.frontend || 'claude',
      implementer: defaultTeam.backend || 'antigravity',
      reviewers: strictCouncilReviewers,
      max_fix_rounds: 3,
      budget_usd: 0,
      isolate: true,
    },
  ];
}

function getPresetsFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('tasks'), 'presets.json');
}

export async function getPresets(ctx: MawFeatureContext): Promise<TeamPreset[]> {
  const file = getPresetsFile(ctx);
  const enabledAgents = new Set(
    (ctx.registry?.agents ?? []).filter((a) => a.enabled).map((a) => a.id)
  );

  return fileMutex.runExclusive(file, () => {
    const raw = readJson<{ version?: number; presets?: TeamPreset[] }>(file, {
      version: 1,
      presets: [],
    });
    const userList = Array.isArray(raw.presets) ? raw.presets : [];
    const builtins = getBuiltinPresets(ctx);

    const filterEnabled = (p: TeamPreset, isBuiltin: boolean): TeamPreset => {
      const filteredTeam: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.team || {})) {
        if (enabledAgents.size === 0 || enabledAgents.has(v)) {
          filteredTeam[k] = v;
        }
      }
      return {
        ...p,
        builtin: isBuiltin,
        team: filteredTeam,
        leader: enabledAgents.size === 0 || enabledAgents.has(p.leader) ? p.leader : '',
        implementer:
          enabledAgents.size === 0 || enabledAgents.has(p.implementer) ? p.implementer : '',
        reviewers: (p.reviewers || []).filter(
          (r) => enabledAgents.size === 0 || enabledAgents.has(r)
        ),
      };
    };

    const cleanBuiltins = builtins.map((b) => filterEnabled(b, true));
    const cleanUser = userList.map((u) => filterEnabled(u, false));

    return [...cleanBuiltins, ...cleanUser];
  });
}

export async function getPreset(
  ctx: MawFeatureContext,
  id: string
): Promise<TeamPreset | null> {
  const all = await getPresets(ctx);
  return all.find((p) => p.id === id) ?? null;
}

export async function savePreset(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>
): Promise<TeamPreset> {
  const rawId = String(raw.id ?? '').trim();
  const builtins = getBuiltinPresets(ctx);
  if (rawId && builtins.some((b) => b.id === rawId)) {
    throw conflict('Built-in presets are read-only.');
  }

  const name = String(raw.name ?? '').trim();
  if (!name) {
    throw badRequest('Preset name is required.');
  }

  const description = String(raw.description ?? '').trim();
  const leader = String(raw.leader ?? '').trim();
  const implementer = String(raw.implementer ?? '').trim();
  const isolate = Boolean(raw.isolate);

  const maxFixRounds = Math.trunc(Number(raw.max_fix_rounds ?? 2));
  if (maxFixRounds < 0 || maxFixRounds > 5) {
    throw badRequest('max_fix_rounds must be between 0 and 5.');
  }

  const budgetUsd = Math.max(0, Number(raw.budget_usd ?? 0));
  if (budgetUsd > 1000) {
    throw badRequest('budget_usd must be between 0 and 1000.');
  }

  const team: Record<string, string> = {};
  if (raw.team && typeof raw.team === 'object' && !Array.isArray(raw.team)) {
    for (const [k, v] of Object.entries(raw.team as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        team[k] = v.trim();
      }
    }
  }

  const reviewers: string[] = Array.isArray(raw.reviewers)
    ? raw.reviewers.map((r) => String(r ?? '').trim()).filter(Boolean)
    : [];

  const file = getPresetsFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; presets: TeamPreset[] }>(file, {
      version: 1,
      presets: [],
    });
    if (!Array.isArray(data.presets)) {
      data.presets = [];
    }

    const id = rawId || newId('preset');
    const existingIdx = data.presets.findIndex((p) => p.id === id);

    if (existingIdx < 0 && data.presets.length >= 100) {
      throw badRequest('Maximum user preset limit (100) reached.');
    }

    const preset: TeamPreset = {
      id,
      name,
      builtin: false,
      description,
      team,
      leader,
      implementer,
      reviewers,
      max_fix_rounds: maxFixRounds,
      budget_usd: budgetUsd,
      isolate,
    };

    if (existingIdx >= 0) {
      data.presets[existingIdx] = preset;
    } else {
      data.presets.push(preset);
    }

    writeJsonAtomic(file, data);
    return preset;
  });
}

export async function deletePreset(
  ctx: MawFeatureContext,
  id: string
): Promise<string> {
  const builtins = getBuiltinPresets(ctx);
  if (builtins.some((b) => b.id === id)) {
    throw conflict('Built-in presets are read-only.');
  }

  const file = getPresetsFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; presets: TeamPreset[] }>(file, {
      version: 1,
      presets: [],
    });
    const beforeLen = data.presets?.length ?? 0;
    data.presets = (data.presets ?? []).filter((p) => p.id !== id);
    if (data.presets.length === beforeLen) {
      throw notFound(`Preset not found: ${id}`);
    }
    writeJsonAtomic(file, data);
    appendAudit(ctx.paths.auditFile, 'preset_delete', { id });
    return id;
  });
}
