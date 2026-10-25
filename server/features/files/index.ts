import type { MawFeature } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  DEFAULT_EDITOR,
  loadEditorConfig,
  openFileInEditor,
  saveEditorConfig,
  validateEditorConfig,
} from './editor.ts';
import { getFilesHistory } from './history.ts';
import { readProjectFile } from './read.ts';
import { searchProjectFiles } from './search.ts';
import { getFilesTree } from './tree.ts';

export const feature: MawFeature = {
  name: 'files',
  routes: {
    files_tree: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const dir = req.query.get('dir') ?? '';
        const dotfiles = req.query.get('dotfiles') === '1';

        return await getFilesTree({
          projectPath,
          dir,
          dotfiles,
        });
      },
    },

    files_search: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const q = req.query.get('q') ?? '';
        const dotfiles = req.query.get('dotfiles') === '1';
        const limitParam = req.query.has('limit')
          ? Number.parseInt(req.query.get('limit')!, 10)
          : 200;
        const limit = Number.isNaN(limitParam) ? 200 : limitParam;

        return await searchProjectFiles({
          projectPath,
          query: q,
          dotfiles,
          limit,
        });
      },
    },

    files_read: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const filePath = req.query.get('path') ?? '';
        if (!filePath) {
          throw new ApiValidationError('path is required.', 400);
        }

        return await readProjectFile(projectPath, filePath);
      },
    },

    files_open: {
      method: 'POST',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.body.project_path ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const relPath = String(req.body.path ?? '').trim();
        if (!relPath) {
          throw new ApiValidationError('path is required.', 400);
        }

        const rawLine = req.body.line;
        const line = typeof rawLine === 'number' ? rawLine : undefined;

        return openFileInEditor({
          projectPath,
          relPath,
          line,
          paths: ctx.paths,
        });
      },
    },

    files_config: {
      method: 'POST',
      methods: ['GET', 'POST'],
      handler: async (ctx, req) => {
        if (req.body?.editor !== undefined) {
          const validated = validateEditorConfig(req.body.editor);
          saveEditorConfig(validated, ctx.paths);
          return {
            ok: true,
            editor: validated,
            default_editor: [...DEFAULT_EDITOR],
          };
        }

        const editor = loadEditorConfig(ctx.paths);
        return {
          ok: true,
          editor,
          default_editor: [...DEFAULT_EDITOR],
        };
      },
    },

    files_history: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const relPath = req.query.get('path') ?? undefined;
        const limitParam = req.query.has('limit')
          ? Number.parseInt(req.query.get('limit')!, 10)
          : 30;
        const limit = Number.isNaN(limitParam) ? 30 : limitParam;

        const commits = await getFilesHistory({
          projectPath,
          relPath,
          limit,
        });

        return {
          ok: true,
          commits,
        };
      },
    },
  },

  ui: {
    script: 'feat-files.js',
    style: 'feat-files.css',
  },
};
