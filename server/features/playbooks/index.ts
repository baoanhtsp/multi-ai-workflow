import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { badRequest } from '../tasks/lib.ts';
import { registerTicker, triggerImmediateTick } from '../tasks/scheduler.ts';
import { parsePlaybookContent, validatePlaybookFile } from './parser.ts';
import {
  getPlaybookRuns,
  playbookTicker,
  startPlaybookRun,
  stopPlaybookRun,
} from './runs.ts';

// Register playbook ticker in tasks scheduler
registerTicker('playbooks', playbookTicker);

export const feature: MawFeature = {
  name: 'playbooks',
  routes: {
    playbook_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.url.searchParams.get('project_path') ?? '').trim();
        if (!rawProjectPath) {
          throw badRequest("Parameter 'project_path' is required.");
        }
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
        }

        const playbooksDir = path.win32.join(projectPath, '.maw', 'playbooks');
        const files: Array<{
          file: string;
          name: string;
          total: number;
          done: number;
          mtime: string;
        }> = [];

        if (fs.existsSync(playbooksDir)) {
          const entries = fs
            .readdirSync(playbooksDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
            .sort((a, b) => a.name.localeCompare(b.name));

          for (const ent of entries) {
            const fullPath = path.win32.join(playbooksDir, ent.name);
            try {
              const st = fs.statSync(fullPath);
              const content = fs.readFileSync(fullPath, 'utf8');
              const items = parsePlaybookContent(content);
              const doneCount = items.filter((it) => it.checked).length;
              files.push({
                file: fullPath,
                name: ent.name.replace(/\.md$/i, ''),
                total: items.length,
                done: doneCount,
                mtime: st.mtime.toISOString(),
              });
            } catch {
              // skip unreadable file
            }
          }
        }

        return {
          ok: true,
          dir: playbooksDir,
          files,
        };
      },
    },

    playbook_preview: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.url.searchParams.get('project_path') ?? '').trim();
        if (!rawProjectPath) {
          throw badRequest("Parameter 'project_path' is required.");
        }
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw badRequest(`project_path "${rawProjectPath}" is not valid or outside projectsRoot.`);
        }
        const fileParam = String(req.url.searchParams.get('file') ?? '').trim();
        if (!fileParam) {
          throw badRequest("Parameter 'file' is required.");
        }

        const validatedFile = validatePlaybookFile(projectPath, fileParam);
        const content = fs.readFileSync(validatedFile, 'utf8');
        const items = parsePlaybookContent(content);

        return {
          ok: true,
          file: validatedFile,
          items,
        };
      },
    },

    playbook_run: {
      method: 'POST',
      handler: async (ctx, req) => {
        const result = await startPlaybookRun(ctx, req.body);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          run: result.run,
          tasks: result.tasks,
        };
      },
    },

    playbook_runs: {
      method: 'GET',
      handler: async (ctx, req) => {
        const projectPath = req.url.searchParams.get('project_path') ?? undefined;
        const runs = await getPlaybookRuns(ctx, projectPath);
        return {
          ok: true,
          runs,
        };
      },
    },

    playbook_stop: {
      method: 'POST',
      handler: async (ctx, req) => {
        const runId = String(req.body.run_id ?? '').trim();
        if (!runId) {
          throw badRequest("Field 'run_id' is required.");
        }
        const run = await stopPlaybookRun(ctx, runId);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          run,
        };
      },
    },
  },
};

export default feature;
