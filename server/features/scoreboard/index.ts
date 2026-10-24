import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { readJsonSafe, writeJsonAtomic } from '../policy/lib/s4-core.ts';
import {
  computeScoreboard,
  suggestTeam,
  type ScoreboardResult,
  type SuggestTeamResult,
} from './lib/scoreboard-core.ts';

function getCacheKey(ctx: MawFeatureContext, days: number, role = '', project = ''): string {
  const ledgerFile = path.win32.join(ctx.paths.featureDataDir('budget'), 'ledger.jsonl');
  const auditFile = ctx.paths.auditFile;

  let ledgerSize = 0;
  let ledgerMtime = 0;
  if (fs.existsSync(ledgerFile)) {
    try {
      const st = fs.statSync(ledgerFile);
      ledgerSize = st.size;
      ledgerMtime = Math.floor(st.mtimeMs);
    } catch {
      // Ignore
    }
  }

  let auditSize = 0;
  let auditMtime = 0;
  if (fs.existsSync(auditFile)) {
    try {
      const st = fs.statSync(auditFile);
      auditSize = st.size;
      auditMtime = Math.floor(st.mtimeMs);
    } catch {
      // Ignore
    }
  }

  return `${ledgerSize}_${auditSize}_${ledgerMtime}_${auditMtime}_${days}_${role}_${project}`;
}

interface ScoreboardCacheEntry {
  cacheKey: string;
  data: ScoreboardResult;
}

interface TopCacheEntry {
  cacheKey: string;
  top: Record<string, string>;
}

export const feature: MawFeature = {
  name: 'scoreboard',
  ui: {
    script: 'feat-scoreboard.js',
    style: 'feat-scoreboard.css',
  },
  routes: {
    scoreboard: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawDays = req.query.get('days');
        const days = rawDays ? parseInt(rawDays, 10) : 30;
        const role = (req.query.get('role') || '').trim();
        const rawProj = (req.query.get('project_path') || '').trim();
        let projectPath = '';
        if (rawProj) {
          projectPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot) || rawProj;
        }

        const cacheKey = getCacheKey(ctx, days, role, projectPath);
        const cacheFile = path.win32.join(ctx.paths.featureDataDir('scoreboard'), 'cache.json');
        const cached = readJsonSafe<Record<string, ScoreboardCacheEntry>>(cacheFile, {}).data;

        if (cached[cacheKey]) {
          return {
            ok: true,
            ...cached[cacheKey]!.data,
          };
        }

        const result = computeScoreboard(ctx.paths, ctx.registry, {
          days,
          role,
          project_path: projectPath,
        });

        cached[cacheKey] = {
          cacheKey,
          data: result,
        };
        // Keep newest 10 cache entries
        const keys = Object.keys(cached);
        if (keys.length > 10) {
          for (const k of keys.slice(0, keys.length - 10)) {
            delete cached[k];
          }
        }
        writeJsonAtomic(cacheFile, cached);

        return {
          ok: true,
          ...result,
        };
      },
    },

    suggest_team: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawDays = req.query.get('days');
        const days = rawDays ? parseInt(rawDays, 10) : 30;
        const rawRoles = req.query.get('roles');
        const roles = rawRoles ? rawRoles.split(',').map((r) => r.trim()).filter(Boolean) : undefined;
        const rawProj = (req.query.get('project_path') || '').trim();
        let projectPath = '';
        if (rawProj) {
          projectPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot) || rawProj;
        }

        const result = suggestTeam(ctx.paths, ctx.registry, {
          days,
          roles,
          project_path: projectPath,
        });

        return {
          ok: true,
          ...result,
        };
      },
    },
  },
  status: async (ctx: MawFeatureContext) => {
    const days = 30;
    const cacheKey = getCacheKey(ctx, days);
    const topFile = path.win32.join(ctx.paths.featureDataDir('scoreboard'), 'top-cache.json');
    const cached = readJsonSafe<TopCacheEntry | null>(topFile, null).data;

    if (cached && cached.cacheKey === cacheKey) {
      return {
        top: cached.top,
      };
    }

    const st = suggestTeam(ctx.paths, ctx.registry, {
      days,
      roles: ['backend', 'frontend', 'reviewer', 'architect', 'tester'],
    });

    const top = st.team;
    writeJsonAtomic(topFile, {
      cacheKey,
      top,
    });

    return {
      top,
    };
  },
};
