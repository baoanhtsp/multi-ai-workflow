import type { MawFeatureContext } from '../../lib/feature.ts';
import { badRequest } from './lib.ts';
import { BUILTIN_TEMPLATES, getTemplates, saveTemplate, type PromptTemplate } from './templates.ts';
import { getPresets, savePreset, type TeamPreset } from './presets.ts';

export interface MawLibraryExport {
  maw_library: 1;
  exported_at: string;
  templates: PromptTemplate[];
  presets: TeamPreset[];
}

export interface LibraryImportResult {
  [key: string]: unknown;
  ok: true;
  imported: {
    templates: number;
    presets: number;
  };
  skipped: string[];
}

export async function exportLibrary(ctx: MawFeatureContext): Promise<MawLibraryExport> {
  const allTemplates = await getTemplates(ctx);
  const allPresets = await getPresets(ctx);

  const userTemplates = allTemplates.filter((t) => !t.builtin);
  const userPresets = allPresets.filter((p) => !p.builtin);

  return {
    maw_library: 1,
    exported_at: new Date().toISOString(),
    templates: userTemplates,
    presets: userPresets,
  };
}

export async function importLibrary(
  ctx: MawFeatureContext,
  rawLibrary: unknown,
  overwrite = false
): Promise<LibraryImportResult> {
  if (!rawLibrary || typeof rawLibrary !== 'object' || Array.isArray(rawLibrary)) {
    throw badRequest('Invalid library format: root must be an object.');
  }

  const lib = rawLibrary as Record<string, unknown>;
  if (lib.maw_library !== 1) {
    throw badRequest("Invalid library version: 'maw_library' must be 1.");
  }

  const skipped: string[] = [];
  let importedTemplates = 0;
  let importedPresets = 0;

  const currentTemplates = await getTemplates(ctx);
  const currentPresets = await getPresets(ctx);

  const builtinTemplateIds = new Set(BUILTIN_TEMPLATES.map((b) => b.id));
  const existingTemplateMap = new Map(currentTemplates.map((t) => [t.id, t]));

  if (Array.isArray(lib.templates)) {
    for (const tpl of lib.templates) {
      if (!tpl || typeof tpl !== 'object') continue;
      const t = tpl as Record<string, unknown>;
      const id = String(t.id ?? '').trim();
      if (!id) {
        skipped.push('<unknown template>: missing id');
        continue;
      }
      if (builtinTemplateIds.has(id)) {
        skipped.push(`${id}: built-in template cannot be overwritten`);
        continue;
      }
      if (existingTemplateMap.has(id) && !overwrite) {
        skipped.push(`${id}: template already exists (overwrite=false)`);
        continue;
      }

      try {
        await saveTemplate(ctx, t);
        importedTemplates++;
        existingTemplateMap.set(id, t as unknown as PromptTemplate);
      } catch (err: unknown) {
        skipped.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const builtinPresetIds = new Set(['default', 'solo-claude', 'strict-council']);
  const existingPresetMap = new Map(currentPresets.map((p) => [p.id, p]));

  if (Array.isArray(lib.presets)) {
    for (const pre of lib.presets) {
      if (!pre || typeof pre !== 'object') continue;
      const p = pre as Record<string, unknown>;
      const id = String(p.id ?? '').trim();
      if (!id) {
        skipped.push('<unknown preset>: missing id');
        continue;
      }
      if (builtinPresetIds.has(id)) {
        skipped.push(`${id}: built-in preset cannot be overwritten`);
        continue;
      }
      if (existingPresetMap.has(id) && !overwrite) {
        skipped.push(`${id}: preset already exists (overwrite=false)`);
        continue;
      }

      try {
        await savePreset(ctx, p);
        importedPresets++;
        existingPresetMap.set(id, p as unknown as TeamPreset);
      } catch (err: unknown) {
        skipped.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    ok: true,
    imported: {
      templates: importedTemplates,
      presets: importedPresets,
    },
    skipped,
  };
}
