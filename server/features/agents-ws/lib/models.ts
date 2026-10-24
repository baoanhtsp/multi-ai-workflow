import type { MawFeatureContext } from '../../../lib/feature.ts';
import { getCodexModels } from '../../../lib/versions.ts';

export function allowedModels(ctx: MawFeatureContext, platform: string): string[] {
  const normPlatform = (platform ?? '').toLowerCase().trim();
  const entry = ctx.registry?.agents?.find((a) => a.id.toLowerCase() === normPlatform);
  if (!entry) {
    return [];
  }

  const models = [...entry.models];
  if (normPlatform === 'codex') {
    try {
      const detected = getCodexModels(ctx.paths.userProfile);
      for (const m of detected) {
        if (!models.includes(m)) {
          models.push(m);
        }
      }
    } catch {}
  }

  return models;
}
