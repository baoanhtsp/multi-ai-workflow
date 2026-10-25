import fs from 'node:fs';
import path from 'node:path';
import { isDirectorySafe, isFileSafe, resolveProjectPath, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

export async function handleInitSpec(
  body: Record<string, unknown>,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const rawProjectPath = String(body.project_path ?? '').trim();
  const realTarget = resolveProjectPath(rawProjectPath, paths.projectsRoot);
  if (realTarget === null) {
    throw new ApiValidationError(
      `Invalid project_path. Must be an existing project subdirectory strictly inside ${paths.projectsRoot}.`,
      400
    );
  }

  let projectName = String(body.project_name ?? path.basename(realTarget)).trim();
  if (projectName === '' || [...projectName].length > 120) {
    projectName = path.basename(realTarget);
  }

  let gitInitialized = false;
  const gitDir = path.win32.join(realTarget, '.git');
  if (!isDirectorySafe(gitDir)) {
    const gitRes = await runCommand('git.exe', ['-C', realTarget, 'init'], { timeoutMs: 10000 });
    if (gitRes.code === 0 && isDirectorySafe(gitDir)) {
      gitInitialized = true;
    }
  }

  const specDest = path.win32.join(realTarget, 'SPEC.md');
  if (isFileSafe(specDest)) {
    return {
      ok: true,
      created: false,
      git_initialized: gitInitialized,
      spec_path: specDest,
      message: `${gitInitialized ? 'Initialized Git repository; ' : ''}SPEC.md already exists in ${projectName}`,
    };
  }

  const templatePath = path.win32.join(paths.repoRoot, 'templates', 'SPEC.template.md');
  if (!isFileSafe(templatePath)) {
    throw new ApiValidationError('SPEC.template.md not found in templates/.', 500);
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  const content = templateContent.replaceAll('<Project / Feature Name>', projectName);

  try {
    fs.writeFileSync(specDest, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'EEXIST' || isFileSafe(specDest)) {
      return {
        ok: true,
        created: false,
        git_initialized: gitInitialized,
        spec_path: specDest,
        message: `${gitInitialized ? 'Initialized Git repository; ' : ''}SPEC.md already exists in ${projectName}`,
      };
    }
    throw new ApiValidationError(
      'Permission denied or unable to create SPEC.md in target folder.',
      500
    );
  }

  return {
    ok: true,
    created: true,
    git_initialized: gitInitialized,
    spec_path: specDest,
    message: `Successfully initialized ${gitInitialized ? 'Git & ' : ''}SPEC.md in ${projectName}`,
  };
}
